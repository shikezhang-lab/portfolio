// scripts/uv-worker.js —— Cloudflare Worker + D1（UV 独立访客采集/去重/存储/拉取）
//
// ⚠️ 已弃用的备用后端，当前未部署：workers.dev 域名在大陆不可达，线上跑的是
//    scripts/uv-cloudbase-function.js。保留它是因为它是唯一可离线自建的替代方案，
//    但任何改动都必须与 CloudBase 版本保持同一套接口契约（见下方「契约」）。
//
// 契约：/stats 的 daily 恒为「按 day 升序（最旧 → 今天）」。历史上这里用 ORDER BY
//       day DESC，与 CloudBase 的升序相反，导致客户端「近 7 日」取到最旧一周、
//       走势图时间轴反向。改回升序，并在客户端按 day 再排一次做防御。
//
// 部署步骤（需你自己的 Cloudflare 账号，免费）：
//   1) wrangler login
//   2) wrangler d1 create portfolio_uv          # 记下 database_id
//   3) 把 id 填入 scripts/wrangler.uv.toml 的 database_id
//   4) wrangler d1 execute portfolio_uv --file=scripts/uv-schema.sql
//   5) wrangler deploy -c scripts/wrangler.uv.toml
//   6) 把生成的 https://<subdomain>.workers.dev 填入 index.html 的 UV_ENDPOINT
//
// 采集字段：visitor_id（客户端 UUID）、ip（服务端，仅哈希）、user_agent（仅哈希）、
//           accept_language、referrer（原始，含派生来源桶）、route（location.hash）、
//           timestamp（服务端）、owner 排除标记、duration_ms（best-effort）。
// 去重：服务端全局唯一键 hash(visitor_id | ip) + D1 唯一约束 + INSERT OR IGNORE（原子，无读改写竞态）。

const OWNER_IPS = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

// 写入口匿名且公开，visitorId 必须收敛到客户端真正会发的形状（UUID / v_<random>），
// 否则任何人都能循环构造 id 抬高「独立访客」—— 而本板块卖点就是这个数字可信。
const MAX_BODY = 2048;
const VID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const validVisitorId = (v) => ((typeof v === 'string' && VID_RE.test(v)) ? v : '');

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sourceBucket(referrer) {
  if (!referrer) return 'direct';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (host.endsWith('linkedin.com')) return 'linkedin';
    if (host.endsWith('github.com')) return 'github';
    if (host.endsWith('google.com') || host.endsWith('bing.com') || host.endsWith('baidu.com') || host.endsWith('duckduckgo.com')) return 'search';
    return 'other';
  } catch {
    return 'other';
  }
}

async function getMeta(env, k) {
  const r = await env.DB.prepare('SELECT v FROM meta WHERE k=?').bind(k).first();
  return (r && r.v) || 0;
}

function json(body, headers) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...(headers || {}) },
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    // 拉取：聚合数据（供「访客洞察」看板）
    if (url.pathname === '/stats' && req.method === 'GET') {
      const total = await getMeta(env, 'total_uv');
      // 升序：与 CloudBase 后端一致（见文件头的契约说明）。
      const daily = await env.DB.prepare('SELECT day,uv,visits FROM daily ORDER BY day ASC LIMIT 30').all();
      const sources = await env.DB.prepare('SELECT source_bucket AS bucket, COUNT(*) AS c FROM visits GROUP BY source_bucket').all();
      const routes = await env.DB.prepare('SELECT route, COUNT(*) AS c FROM visits GROUP BY route ORDER BY c DESC LIMIT 10').all();
      // 平均停留时长（best-effort：仅统计已回传 duration_ms 的会话；移动端 pagehide 不可靠，偏低，仅供参考）
      const dur = await env.DB.prepare('SELECT AVG(duration_ms) AS avg_ms, COUNT(*) AS n FROM visits WHERE duration_ms IS NOT NULL').first();
      return json({
        total,
        daily: daily.results,
        sources: sources.results,
        routes: routes.results,
        avgDurationMs: (dur && dur.avg_ms) ? Math.round(dur.avg_ms) : 0,
        durationSample: (dur && dur.n) || 0,
      }, CORS);
    }

    // 拉取：仅累计计数（页脚徽标）
    if (url.pathname === '/count' && req.method === 'GET') {
      return json({ total: await getMeta(env, 'total_uv') }, CORS);
    }

    // 采集：写入一条访问（核心去重 + 存储）
    if (url.pathname === '/count' && req.method === 'POST') {
      const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('x-forwarded-for') || '0.0.0.0';
      // 本人排除（服务端兜底；主用在客户端 localStorage uv_owner_optout）
      if (OWNER_IPS(env.OWNER_IPS).includes(ip)) {
        return json({ total: await getMeta(env, 'total_uv'), owner: true }, CORS);
      }
      const declared = Number(req.headers.get('content-length') || 0);
      if (declared > MAX_BODY) return new Response('payload too large', { status: 413 });
      let body = {};
      try { body = await req.json(); } catch {}
      const vid = validVisitorId(body.visitorId);
      if (!vid) return new Response('bad', { status: 400 });

      const vidHash = await sha256(vid);
      const ipHash = await sha256(ip);
      const ua = req.headers.get('User-Agent') || '';
      const uaHash = await sha256(ua);
      const acceptLang = req.headers.get('Accept-Language') || '';
      // 只用于来源分桶，不落全量：完整 URL 的 query 可能带搜索词/会话标识。
      // 截断到 200 字符（CloudBase 端更严格，只存哈希；这里保留一点排障能力）。
      const referrer = (body.referrer || req.headers.get('Referer') || '').slice(0, 200);
      const source = sourceBucket(referrer);
      const route = (body.route || '#/home').slice(0, 64);
      const ts = Date.now();
      const dedupKey = await sha256(vid + '|' + ip);

      // 原子去重：唯一约束 + INSERT OR IGNORE（避免 KV 读改写竞态）
      const ins = await env.DB.prepare(
        `INSERT OR IGNORE INTO visits
           (dedup_key,vid_hash,ip_hash,ua_hash,accept_lang,referrer,source_bucket,route,ts)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(dedupKey, vidHash, ipHash, uaHash, acceptLang, referrer, source, route, ts).run();

      const isNew = ins.meta.changes === 1;
      const day = new Date(ts).toISOString().slice(0, 10);
      if (isNew) {
        await env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k='total_uv'").run();
        await env.DB.prepare(
          `INSERT INTO daily (day,uv,visits) VALUES (?,1,1)
           ON CONFLICT(day) DO UPDATE SET uv = uv + 1, visits = visits + 1`
        ).bind(day).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO daily (day,uv,visits) VALUES (?,0,1)
           ON CONFLICT(day) DO UPDATE SET visits = visits + 1`
        ).bind(day).run();
      }
      return json({ total: await getMeta(env, 'total_uv'), isNew }, CORS);
    }

    // 采集：会话时长（best-effort，移动端 pagehide 不可靠，仅供参考）
    if (url.pathname === '/duration' && req.method === 'POST') {
      const declared = Number(req.headers.get('content-length') || 0);
      if (declared > MAX_BODY) return new Response('payload too large', { status: 413 });
      let body = {};
      try { body = await req.json(); } catch {}
      const vid = validVisitorId(body.visitorId);
      const ms = Number(body.durationMs);
      // 与 CloudBase 端同样的边界：0 < ms <= 1 小时，越界的一律丢弃而不是写进均值。
      if (!vid || !Number.isFinite(ms) || ms <= 0 || ms > 3600000) return new Response('bad', { status: 400 });
      const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('x-forwarded-for') || '0.0.0.0';
      const dedupKey = await sha256(vid + '|' + ip);
      await env.DB.prepare('UPDATE visits SET duration_ms=? WHERE dedup_key=?').bind(ms, dedupKey).run();
      return json({ ok: true }, CORS);
    }

    return new Response('not found', { status: 404 });
  },
};
