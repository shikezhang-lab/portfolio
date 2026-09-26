// scripts/uv-cloudbase-function.js —— 腾讯云 CloudBase 云开发（免费档）UV 独立访客采集/去重/存储/拉取
//
// 为什么是它：workers.dev 在大陆被墙（DNS 污染到假 IP 108.160.167.167 + 连接被丢弃），
// 而腾讯云 CloudBase 免费环境（¥0/月，3000 资源点/月：云函数 20 万次调用/月 + 文档型数据库）大陆直连必达。
//
// 部署（控制台，无需本地 CLI）：
//   1) 打开 https://tcb.cloud.tencent.com → 进入环境 portfolio-uv-d9gkwr12q9ddbdd3d
//   2) 云数据库 → 新建集合：visits（只需这一个；daily 由聚合实时算，总数用 count()，都无需建表）
//   3) 云函数 → 新建「普通云函数」（事件函数，非 Web 云函数）→ 函数名 uv，运行时 Node.js 16/18
//      → 粘贴本文件 → package.json 里加依赖 "@cloudbase/node-sdk":"latest" → 保存并安装依赖
//   4) 该函数的「HTTP 访问服务 / 云接入」→ 新建路由，触发路径填 / （根）→ 得到默认域名
//      （形如 https://<serviceId>.service.tcloudbase.com 或 https://<envId>.ap-shanghai.service.tcloudbase.com）
//   5) 把域名填进 index.html 的 UV_ENDPOINT
//
// 采集字段：visitor_id（客户端 UUID，仅哈希）、ip（服务端，仅哈希）、user_agent（仅哈希）、
//           accept_language、referrer（派生来源桶）、route（location.hash）、timestamp、duration_ms（best-effort）。
// 去重：_id = sha256(vid|ip) 也是存储主键，天然唯一 → doc(id).get() 判存在 → 不存在才 set。
// 总数 = visits 文档数（count()），不用计数器：计数器是「读 → +1 → 写」，并发会丢自增，
// 线上实测 6 条去重文档而计数器只有 2。count() 是事实来源，且能自愈历史差值。
// 契约：/stats 返回的 daily 恒为「按 day 升序（最旧 → 今天）」，两个后端必须一致，
//       客户端会再按 day 排一次做防御，但不要让它依赖顺序差异。
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

// 写入口是匿名且完全公开的：任何人都能构造 visitorId。不限形状与体积，就能用脚本
// 无限抬高「独立访客」并撑爆免费档存储 —— 而这个板块的全部价值恰恰是「数字是真的」。
// 客户端只会发 crypto.randomUUID()（36 字符）或 v_<random> 兜底串，故按此收敛。
const MAX_BODY = 2048; // 正常载荷约 120 字节
const VID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function validVisitorId(v) {
  return (typeof v === 'string' && VID_RE.test(v)) ? v : '';
}

// 入参归一化：事件函数的 event.body 形状**随 Content-Type 而变**，不统一处理就会
// 把合法请求判成非法 —— 2026-09-26 线上实测（P0）：
//   Content-Type: text/plain            → 400 {"error":"bad"}   ← 浏览器 sendBeacon 就是这种！
//   Content-Type: application/json      → 200
//   Content-Type: x-www-form-urlencoded → 200
// 前端用 `navigator.sendBeacon(url, <string>)` 发，字符串体会被标成 text/plain；
// 此时 event.body 拿不到可直接 parse 的 JSON（部分环境下还是 base64），
// JSON.parse 抛错 → body 退化成 {} → visitorId 为空 → 整个写入被拒。
// 后果不是报错而是**静默零记录**：真实访客一条都写不进去，看板却看起来在正常工作。
// ⇒ 任何形状都必须能读出来：已解析对象 / Buffer / 原始字符串 / base64。
function tryParseJson(s) {
  const t = String(s).trim();
  if (!t.startsWith('{')) return null;
  try { const o = JSON.parse(t); return (o && typeof o === 'object') ? o : null; } catch { return null; }
}
function tryDecodeBase64Json(s) {
  // 标准与 URL-safe 两种字母表都收（- _ 归一成 + /），容忍换行与缺失的 padding
  const t = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!t || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  try {
    const dec = Buffer.from(t, 'base64').toString('utf8');
    return tryParseJson(dec);
  } catch { return null; }
}
function tryDecodeUriJson(s) {
  const t = String(s);
  if (!/%[0-9A-Fa-f]{2}/.test(t)) return null; // 不含百分号转义就不必解
  try { return tryParseJson(decodeURIComponent(t)); } catch { return null; }
}
function tryParseForm(s) {
  // 兜底：网关把 body 交成 x-www-form-urlencoded 原始串的情况。
  //
  // ⚠️ 必须先排除「整串就是 base64」。URLSearchParams 对任何含 `=` 的串都不会抛错，
  // 纯 base64 串（尤其末尾带 `=` padding 的）会被解析成一个键名超长的伪对象 ——
  // 于是本应「读不出 → null」的输入变成「读到了但 visitorId 非法」，
  // readBody 的 null 契约被击穿，错误码从 unreadable-body 退化成 bad，线上又不可分辨。
  // 2026-09-26 部署后实测：`text/plain` 发 base64 体正是踩到这个分支。
  const t = String(s).trim();
  if (!t || /^\{/.test(t)) return null;                       // JSON 体不走这条路
  const compact = t.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;    // 纯 base64，交给 base64 分支
  if (t.indexOf('=') < 0) return null;
  try {
    const o = {};
    for (const [k, v] of new URLSearchParams(t)) o[k] = v;
    return Object.keys(o).length ? o : null;
  } catch { return null; }
}
/**
 * 无论网关把 body 交成什么形状，都尽量还原成对象。
 *
 * 读不出时返回 `null`（而不是 `{}`）—— 这个区分是刻意的：空对象会让「网关没把
 * body 传过来」和「传过来了但 visitorId 非法」在响应里长得一模一样，线上排查
 * 时无法分辨，只能靠猜。调用方据此返回不同的错误码。
 */
function readBody(event) {
  const raw = event && event.body;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw; // 网关已替我们解析好
  const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (event.isBase64Encoded) { const d = tryDecodeBase64Json(s); if (d) return d; }
  // 判据不依赖 isBase64Encoded：实测存在「内容其实是 base64 但没带 flag」的情况
  return tryParseJson(s)
    || tryDecodeUriJson(s)          // 网关做过 URL 转义的情况
    || tryDecodeBase64Json(s)       // 内容其实是 base64（含未声明 flag 的）
    || tryParseForm(s)
    || null;
}

/**
 * 独立访客总数 = visits 去重文档数。
 *
 * 不做计数器：计数器必须「读 → +1 → 写」，两次请求重叠就丢一次自增，而丢了多少
 * 无人知晓 —— 线上实测 visits 有 6 条文档、计数器却只有 2。count() 直接读事实，
 * 顺带把历史差值自愈回来。作品集量级下这是一次廉价读取。
 */
async function totalVisitors() {
  const r = await db.collection('visits').count();
  return (r && r.total) || 0;
}

// 去重：_id = sha256(vid|ip)。存在则老访客；不存在才写入。
async function recordVisit(vid, ip, ua, acceptLang, referrer, route) {
  const dedupKey = sha256(vid + '|' + ip);
  const chk = await db.collection('visits').doc(dedupKey).get();
  const isNew = !(chk.data && chk.data.length); // 同一浏览器+IP 自并发概率极低；真并发也只会少计一次，不会重复计
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
      const total = await totalVisitors();

      const srcAgg = await db.collection('visits').aggregate()
        .group({ _id: '$sourceBucket', c: agg.sum(1) }).end();
      // routes 目前没有任何消费者（前端只画 total / daily / sources / 时长），
      // 保留是为后续看板准备的，不要误以为有人依赖它。
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
        // 不返回 visits：本后端每个访客只写一条去重文档，没有「访问事件」计数，
        // 填任何数字都只是把 uv 换个名字再发一遍。需要访问次数请走 D1 后端。
        daily.push({ day: key, uv: dayMap[key] || 0 });
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
      return json({ total: await totalVisitors() });
    }

    // 采集：写入访问（核心去重）
    if (path === '/count' && method === 'POST') {
      if (typeof event.body === 'string' && event.body.length > MAX_BODY) return json({ error: 'payload too large' }, 413);
      const body = readBody(event); // 不能直接 JSON.parse(event.body)：见 readBody 注释
      if (!body) return json({ error: 'unreadable-body' }, 400); // 自描述错误码，便于线上定位
      const vid = validVisitorId(body.visitorId);
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
      const total = await totalVisitors();
      if (visitErr) return json({ error: visitErr, isNew, total }, 500);
      return json({ total, isNew });
    }

    // 采集：会话时长（best-effort，移动端不可靠）
    if (path === '/duration' && method === 'POST') {
      if (typeof event.body === 'string' && event.body.length > MAX_BODY) return json({ error: 'payload too large' }, 413);
      const body = readBody(event); // 同上：sendBeacon 的 text/plain 体也要能读
      if (!body) return json({ error: 'unreadable-body' }, 400); // 自描述错误码，便于线上定位
      const vid = validVisitorId(body.visitorId);
      const ms = Number(body.durationMs);
      if (!vid || !Number.isFinite(ms) || ms <= 0 || ms > 3600000) return json({ error: 'bad' }, 400);
      const dedupKey = sha256(vid + '|' + clientIp(headers));
      // 服务端 SDK 的 update 直接吃字段对象（同文件里 set 就是这么用的）。
      // 之前写成 update({ data: {...} }) —— 那是小程序客户端 SDK 的形状，
      // 在云函数里会写成一个名叫 "data" 的嵌套字段，durationMs 永远落不到顶层，
      // 于是 /stats 的 durationSample 恒为 0、停留时长 KPI 永远是「—」。
      await db.collection('visits').doc(dedupKey).update({ durationMs: ms });
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
};
