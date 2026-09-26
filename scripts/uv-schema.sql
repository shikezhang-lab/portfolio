-- scripts/uv-schema.sql —— Cloudflare D1 (SQLite) 表结构
-- 执行：wrangler d1 execute portfolio_uv --file=scripts/uv-schema.sql

CREATE TABLE IF NOT EXISTS visits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key    TEXT    NOT NULL UNIQUE,   -- hash(visitor_id | ip) 全局去重键
  vid_hash     TEXT,                      -- 客户端 UUID 哈希
  ip_hash      TEXT,                      -- 服务端 IP 哈希（不存明文）
  ua_hash      TEXT,                      -- User-Agent 哈希
  accept_lang  TEXT,                      -- Accept-Language（原始）
  referrer     TEXT,                      -- 来源原始值（可能为空）
  source_bucket TEXT,                     -- 派生：linkedin/github/search/direct/other
  route        TEXT,                      -- location.hash 板块（如 #/freestyle）
  duration_ms  INTEGER,                   -- 会话时长（best-effort，可空）
  ts           INTEGER                    -- 服务端写入时间戳(ms)
);
CREATE INDEX IF NOT EXISTS idx_visits_ts    ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_src   ON visits(source_bucket);
CREATE INDEX IF NOT EXISTS idx_visits_route ON visits(route);

-- 累计独立访客总数（去重后）
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO meta (k, v) VALUES ('total_uv', 0);

-- 每日聚合（uv=当日新增独立访客，visits=当日总访问次数）
CREATE TABLE IF NOT EXISTS daily (
  day    TEXT PRIMARY KEY,
  uv     INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0
);
