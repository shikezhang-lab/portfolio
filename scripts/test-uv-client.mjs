// scripts/test-uv-client.mjs —— UV 前端采集 IIFE 的回归测试（零依赖）
//
// 为什么需要它：这段代码里「早退」和「该不该发请求」是两件事，很容易写错。
// 回归点（2026-09-26 实际发生）：`if (localStorage.getItem('uv_owner_optout')) return;`
//   是整段 IIFE 早退 —— 连下面的「读取」也一起跳过，于是站长给自己开了排除之后，
//   他自己的页脚徽标与「访客洞察」看板全部停在「—」。
//
// 断言：本人排除只应关闭「写入」，读取必须照常。
//   A) 未排除 → POST /count（写入）+ GET /count + GET /stats + pagehide 发 /duration
//   B) 已排除 → 不得有任何写入；GET /count 与 GET /stats 照常；也不发 /duration
//
// 用法：node scripts/test-uv-client.mjs

import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// ---- 取出第二段内联脚本（第一段是主应用，第二段是 UV 采集 IIFE）----
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length < 2) {
  console.error(`FAIL 期望 index.html 至少有 2 段内联 script，实际 ${scripts.length} 段`);
  process.exit(1);
}
const src = scripts[1];
if (!src.includes('UV_ENDPOINT')) {
  console.error('FAIL 第二段内联 script 里找不到 UV_ENDPOINT —— 抽取偏移了？');
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('PASS ' + label); }
  else { fail++; console.log('FAIL ' + label + (extra ? '  → ' + extra : '')); }
};

function fakeEl() {
  return {
    textContent: '', innerHTML: '', className: '', firstChild: null,
    style: {}, appendChild() {}, insertBefore() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; },
  };
}

/** 在 stub 环境里跑一遍采集 IIFE，返回它实际发出的请求。 */
function run(label, { optOut }) {
  const calls = [];
  const beacon = [];
  const store = optOut ? { uv_owner_optout: '1' } : {};
  const els = {};
  const winHandlers = {};
  const stats = {
    total: 6,
    sources: [{ bucket: 'direct', c: 6 }],
    routes: [{ route: '#/home', c: 6 }],
    daily: [{ day: '2026-09-25', uv: 4 }, { day: '2026-09-26', uv: 2 }],
    durationSample: 0,
  };
  const sandbox = {
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    location: { hash: '#/home' },
    navigator: { sendBeacon: (url, body) => { beacon.push([url, body]); return true; } },
    fetch: (url, opt) => {
      calls.push(((opt && opt.method) || 'GET') + ' ' + url);
      const payload = String(url).endsWith('/stats') ? stats : { total: 6 };
      return Promise.resolve({ json: () => Promise.resolve(payload) });
    },
    document: {
      referrer: '',
      visibilityState: 'visible',
      documentElement: {},
      getElementById: (id) => (els[id] || (els[id] = fakeEl())),
      createElement: () => fakeEl(),
      createElementNS: () => fakeEl(),
      addEventListener: () => {},
    },
    window: { addEventListener: (t, fn) => { winHandlers[t] = fn; } },
    getComputedStyle: () => ({ getPropertyValue: () => '#1670b7' }),
    crypto: { randomUUID: () => 'vid-fixed-0001' },
    console,
  };

  new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
  return { label, calls, beacon, els, winHandlers, store };
}

const endsWith = (s, suf) => String(s).endsWith(suf);
const count = (arr, pred) => arr.filter(pred).length;

const results = [run('A 未排除', { optOut: false }), run('B 已排除', { optOut: true })];

// 让 fetch(...).then(...) 里的渲染代码跑完（看板渲染失败的断言在下面单独查）
await new Promise((r) => setTimeout(r, 0));

console.log('--- 请求轨迹 ---');
for (const r of results) console.log('  ' + r.label + ': ' + (r.calls.join(', ') || '(无 fetch)')
  + ' | beacon: ' + (r.beacon.map((b) => b[0].split('/').pop()).join(',') || '(无)'));

const [a, b] = results;

console.log('\n--- 用例 A：未排除本人（应有写入 + 应有读取）---');
// 写入路径：优先 navigator.sendBeacon，仅在其不可用时才降级为 fetch(POST)
ok(count(a.beacon, (x) => endsWith(x[0], '/count')) === 1, 'A1 通过 sendBeacon 写入了 1 次 /count',
  a.beacon.map((x) => x[0].split('/').pop()).join(','));
ok(count(a.calls, (c) => c.startsWith('POST')) === 0, 'A2 sendBeacon 可用时不额外发 fetch(POST)（不重复计数）',
  a.calls.filter((c) => c.startsWith('POST')).join(','));
ok(count(a.calls, (c) => c.startsWith('GET') && endsWith(c, '/count')) === 1, 'A3 读取了 /count（页脚徽标）');
ok(count(a.calls, (c) => c.startsWith('GET') && endsWith(c, '/stats')) === 1, 'A4 读取了 /stats（访客洞察看板）');
a.winHandlers.pagehide && a.winHandlers.pagehide();
ok(count(a.beacon, (x) => endsWith(x[0], '/duration')) === 1, 'A5 pagehide 时上报了 /duration');
ok(a.els['uv-count'] && a.els['uv-count'].textContent === '6', 'A6 页脚徽标被填成 6', a.els['uv-count'] && a.els['uv-count'].textContent);
ok(a.els['uv-kpi-total'] && a.els['uv-kpi-total'].textContent !== '' && a.els['uv-kpi-total'].textContent !== '—',
  'A7 独立访客 KPI 拿到了数字（未停在占位符「—」）', a.els['uv-kpi-total'] && a.els['uv-kpi-total'].textContent);

console.log('\n--- 用例 B：本人已排除（不得写入，但读取必须照常）← 本轮回归点 ---');
ok(count(b.calls, (c) => c.startsWith('POST')) === 0 && b.beacon.length === 0, 'B1 没有任何写入请求（fetch POST 与 sendBeacon 都为零）',
  JSON.stringify(b.beacon.map((x) => x[0].split('/').pop())) + ' / ' + b.calls.filter((c) => c.startsWith('POST')).join(','));
ok(count(b.calls, (c) => c.startsWith('GET') && endsWith(c, '/count')) === 1, 'B2 仍读取 /count（页脚徽标不能被一起吞掉）');
ok(count(b.calls, (c) => c.startsWith('GET') && endsWith(c, '/stats')) === 1, 'B3 仍读取 /stats（看板不能被一起吞掉）');
b.winHandlers.pagehide && b.winHandlers.pagehide();
ok(count(b.beacon, (x) => endsWith(x[0], '/duration')) === 0, 'B4 不上报 /duration');
ok(b.els['uv-count'] && b.els['uv-count'].textContent === '6', 'B5 页脚徽标照常填成 6', b.els['uv-count'] && b.els['uv-count'].textContent);
ok(b.els['uv-kpi-total'] && b.els['uv-kpi-total'].textContent !== '' && b.els['uv-kpi-total'].textContent !== '—',
  'B6 看板 KPI 照常渲染出数字（站长也能看自己的看板）', b.els['uv-kpi-total'] && b.els['uv-kpi-total'].textContent);

// ---- 服务端入参归一化（云函数的 readBody）----
// 回归点（2026-09-26 线上 P0）：`navigator.sendBeacon(url, <string>)` 会把请求标成
// text/plain，而云函数里直接 `JSON.parse(event.body)` 会抛错 → body 退化成 {} →
// visitorId 为空 → 整个写入被 400 拒掉。**真实访客一条都记不上，且完全不报错。**
const cfSrc = fs.readFileSync(new URL('../scripts/uv-cloudbase-function.js', import.meta.url), 'utf8');
const from = cfSrc.indexOf('function tryParseJson');
// 结束边界要从 readBody **定义之后**再找块注释，否则会切到 readBody 自己的文档注释上
const readBodyAt = cfSrc.indexOf('function readBody');
const to = readBodyAt < 0 ? -1 : cfSrc.indexOf('/**', readBodyAt);
if (from < 0 || to < 0) {
  console.error('FAIL 无法从云函数里定位 readBody 实现（被重命名或移动了？）');
  process.exit(1);
}
const { readBody } = new Function(cfSrc.slice(from, to) + '; return { readBody };')();

const payload = { visitorId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', referrer: '', route: '#/home' };
const payloadJson = JSON.stringify(payload);
const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64');
const shapes = [
  ['网关已解析成对象', { body: payload }, payload.visitorId],
  ['application/json 原始串', { body: payloadJson }, payload.visitorId],
  ['text/plain 原始串（sendBeacon 的真实形状）', { body: payloadJson }, payload.visitorId],
  ['Buffer 形态', { body: Buffer.from(payloadJson, 'utf8') }, payload.visitorId],
  ['base64 + isBase64Encoded', { body: payloadB64, isBase64Encoded: true }, payload.visitorId],
  ['base64 但未声明 flag', { body: payloadB64 }, payload.visitorId],
  ['base64url（- _ 字母表）', { body: payloadB64.replace(/\+/g, '-').replace(/\//g, '_') }, payload.visitorId],
  ['URL 转义过的 JSON', { body: encodeURIComponent(payloadJson) }, payload.visitorId],
  ['表单编码兜底形状', { body: 'visitorId=' + encodeURIComponent(payload.visitorId) + '&route=%23%2Fhome' }, payload.visitorId],
  // 读得出的必须含 visitorId；读不出的必须返回 null（**不是 {}**）——
  // 否则线上分不清「网关没把 body 传过来」和「传过来了但 ID 非法」，只能靠猜。
  ['读不出 → null：空体', { body: '' }, null],
  ['读不出 → null：垃圾内容', { body: 'not json at all' }, null],
  ['读不出 → null：body 缺失', {}, null],
  ['读不出 → null：body 为 null', { body: null }, null],
  // 部署后线上实测踩到的：base64 体若被再编码一层（或解出的不是 JSON），
  // 旧版 tryParseForm 会把它当成表单解析成一个键名超长的伪对象 → 错误码从
  // unreadable-body 退化成 bad，线上又不可分辨。必须返回 null。
  ['读不出 → null：双重 base64', { body: Buffer.from(payloadB64, 'utf8').toString('base64') }, null],
];

console.log('\n--- 用例 S：云函数入参归一化（任何 Content-Type 都必须能读出 JSON）---');
for (const [label, ev, want] of shapes) {
  const b = readBody(ev);
  const got = b === null ? null : b.visitorId;
  ok(got === want, 'S ' + label, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

// ---------------------------------------------------------------------------
// 用例 C：来源占比条的 CSS 契约（静态断言）
//
// 为什么需要它：`.uv-bar .fill` 是运行时用 document.createElement('span') 造的，
// 若 CSS 只给 width/height 而不给 display，浏览器会把它当 inline 盒 ——
// **inline 盒的 width/height 一律被忽略**，填充段恒为 0 宽。
// 症状极具欺骗性：JS 侧 `style.width='100%'` 读出来完全正确，DOM 也齐全，
// 页面上却是两条等长的空白轨道（看起来像"设计如此"）。
// 这个 bug 上线存活了很久，直到有了真实数据、两条条该不一样长才暴露；
// 上面所有断言连同三套测试全绿都抓不到它，所以在这里补一条静态契约。
const css = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const fillRule = (css.match(/\.uv-bar \.fill\s*\{[^}]*\}/) || [''])[0];
console.log('\n--- 用例 C：来源占比条 CSS 契约 ---');
ok(!!fillRule, 'C1 能定位到 .uv-bar .fill 规则');
ok(/display\s*:\s*block/.test(fillRule),
  'C2 .uv-bar .fill 必须声明 display:block（inline 盒会忽略 width/height，填充段恒为 0 宽）',
  fillRule.replace(/\s+/g, ' ').trim());
ok(/background\s*:/.test(fillRule), 'C3 .uv-bar .fill 必须声明 background（否则填充不可见）');
ok(/height\s*:\s*100%/.test(fillRule), 'C4 .uv-bar .fill 高度应撑满轨道');

console.log('\n' + (fail ? `FAIL ${fail} 项失败 / ${pass} 项通过` : `全部通过：${pass} 断言`));
process.exit(fail ? 1 : 0);
