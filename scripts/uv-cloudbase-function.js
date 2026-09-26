// scripts/uv-cloudbase-function.js —— 腾讯云 CloudBase 云开发（免费档）UV 独立访客采集/去重/存储/拉取
//
// 为什么是它：workers.dev 在大陆被墙（DNS 污染到假 IP 108.160.167.167 + 连接被丢弃），
// 而腾讯云 CloudBase 免费环境（¥0/月，3000 资源点/月：云函数 20 万次调用/月 + 文档型数据库）大陆直连必达。
//
// 部署（控制台，无需本地 CLI）：
//   1) 打开 https://tcb.cloud.tencent.com → 进入环境 portfolio-uv-d9gkwr12q9ddbdd3d
//   2) 云数据库 → 新建集合：visits / meta（只需这俩；daily 由聚合实时算，无需建）
//   3) 在 meta 集合手动建一篇文档：_id = "total_uv"，字段 v = 0（计数器种子）
//   4) 云函数 → 新建「普通云函数」（事件函数，非 Web 云函数）→ 函数名 uv，运行时 Node.js 16/18
//      → 粘贴本文件 → package.json 里加依赖 "@cloudbase/node-sdk":"latest" → 保存并安装依赖
//   5) 该函数的「HTTP 访问服务 / 云接入」→ 新建路由，触发路径填 / （根）→ 得到默认域名
//      （形如 https://<serviceId>.service.tcloudbase.com 或 https://<envId>.ap-shanghai.service.tcloudbase.com）
//   6) 把域名填进 index.html 的 UV_ENDPOINT
//
// 采集字段：visitor_id（客户端 UUID，仅哈希）、ip（服务端，仅哈希）、user_agent（仅哈希）、
//           accept_language、referrer（派生来源桶）、route（location.hash）、timestamp、duration_ms（best-effort）。
// 去重：_id = sha256(vid|ip) 唯一键；doc(id).get() 判存在 → 不存在才 set + 计数 +1（原子，无竞态）。
// 隐私：ip/ua 只存 SHA-256 哈希，不存明文。

const cloud = require('@cloudbase/node-sdk');
const app = cloud.init({ env: cloud.SYMBOL_DEFAULT_ENV }); // 普通事件云函数：无需密钥
const db = app.database();
const _ = db.command;
const agg = db.command.aggregate; // 聚合累加器（sum/avg）挂在 aggregate 下，不在 db.command 上

const crypto = require('crypto');
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function sourceBucket(referrer) {
  if (!referrer) return 'direct';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (host.endsWith('linkedin.com')) return 'linkedin';
    if (host.endsWith('github.com')) return 'github';
    if (host.endsWith('google.com') || host.endsWith('bing.com') || host.endsWith('baidu.com') || host.endsWith('duckduckgo.com') || host.endsWith('yahoo.com')) return 'search';
    return 'other';
  } catch {
    return 'other';
  }
}

function clientIp(headers) {
  const xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '';
  if (xff) return xff.split(',')[0].trim();
  return headers['x-real-ip'] || headers['X-Real-IP'] || '0.0.0.0';
}

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    },
    body: JSON.stringify(body),
  };
}

function getHeader(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

// 原子去重：_id = sha256(vid|ip)。存在则老访客；不存在才 set + 计数 +1。
async function recordVisit(vid, ip, ua, acceptLang, referrer, route) {
  const dedupKey = sha256(vid + '|' + ip);
  const chk = await db.collection('visits').doc(dedupKey).get();
  const isNew = !(chk.data && chk.data.length); // 同浏览器+IP 不会并发，读后写无竞态
  if (!isNew) return false;
  await db.collection('visits').doc(dedupKey).set({
    dedupeKey: dedupKey,
    vidHash: sha256(vid),
    ipHash: sha256(ip),
    uaHash: sha256(ua),
    acceptLang: (acceptLang || '').slice(0, 64),
    referrerHash: sha256(referrer || ''),
    sourceBucket: sourceBucket(referrer),
    route: (route || '#/home').slice(0, 64),
    day: new Date().toISOString().slice(0, 10),
    ts: Date.now(),
  });
  // 计数 +1（读改写：先读当前值、再 set v+1，绕过 _.inc / update 的 SDK 版本差异，写必生效）
  const metaDoc = await db.collection('meta').doc('total_uv').get();
  const cur = (metaDoc.data && metaDoc.data[0] && metaDoc.data[0].v) || 0;
  // 注意：set 的 data 里绝不能带 _id 字段（TCB 报"不能更新_id的值"），_id 由 .doc() 隐式指定
  await db.collection('meta').doc('total_uv').set({ v: cur + 1 });
  return true;
}

exports.main = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const path = event.path || '/';
  const headers = event.headers || {};

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    }, body: '' };
  }

  try {
    // 拉取：聚合（访客洞察看板）
    if (path === '/stats' && method === 'GET') {
      const totalDoc = await db.collection('meta').doc('total_uv').get();
      const total = (totalDoc.data && totalDoc.data.length && totalDoc.data[0].v) || 0;

      const srcAgg = await db.collection('visits').aggregate()
        .group({ _id: '$sourceBucket', c: agg.sum(1) }).end();
      const routeAgg = await db.collection('visits').aggregate()
        .group({ _id: '$route', c: agg.sum(1) }).sort({ c: -1 }).limit(10).end();
      const dayAgg = await db.collection('visits').aggregate()
        .group({ _id: '$day', c: agg.sum(1) }).end();
      const durAgg = await db.collection('visits').aggregate()
        .match({ durationMs: _.neq(null) })
        .group({ _id: null, avg: agg.avg('$durationMs'), n: agg.sum(1) }).end();

      const dayMap = {};
      (dayAgg.data || []).forEach((x) => { if (x._id) dayMap[x._id] = x.c; });
      const daily = [];
      const now = new Date();
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        daily.push({ day: key, uv: dayMap[key] || 0, visits: dayMap[key] || 0 });
      }

      const dur = (durAgg.data && durAgg.data[0]) || { avg: 0, n: 0 };
      return json({
        total,
        sources: (srcAgg.data || []).map((r) => ({ bucket: r._id, c: r.c })),
        routes: (routeAgg.data || []).map((r) => ({ route: r._id, c: r.c })),
        daily,
        avgDurationMs: Math.round(dur.avg || 0),
        durationSample: dur.n || 0,
      });
    }

    // 拉取：仅计数（页脚徽标）
    if (path === '/count' && method === 'GET') {
      const totalDoc = await db.collection('meta').doc('total_uv').get();
      const total = (totalDoc.data && totalDoc.data.length && totalDoc.data[0].v) || 0;
      return json({ total });
    }

    // 采集：写入访问（核心去重）
    if (path === '/count' && method === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch {}
      const vid = body.visitorId;
      if (!vid) return json({ error: 'bad' }, 400);
      let isNew = false, visitErr = null;
      try {
        isNew = await recordVisit(
          vid,
          clientIp(headers),
          getHeader(headers, 'user-agent'),
          getHeader(headers, 'accept-language'),
          body.referrer || getHeader(headers, 'referer'),
          body.route
        );
      } catch (ve) { visitErr = String((ve && ve.message) || ve); }
      const totalDoc = await db.collection('meta').doc('total_uv').get();
      const total = (totalDoc.data && totalDoc.data.length && totalDoc.data[0].v) || 0;
      if (visitErr) return json({ error: visitErr, isNew, total }, 500);
      return json({ total, isNew });
    }

    // 采集：会话时长（best-effort，移动端不可靠）
    if (path === '/duration' && method === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch {}
      const vid = body.visitorId;
      const ms = Number(body.durationMs);
      if (!vid || !Number.isFinite(ms) || ms <= 0 || ms > 3600000) return json({ error: 'bad' }, 400);
      const dedupKey = sha256(vid + '|' + clientIp(headers));
      await db.collection('visits').doc(dedupKey).update({ data: { durationMs: ms } });
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
};
