#!/usr/bin/env node
/**
 * End-to-end smoke test for scripts/update-metrics.mjs.
 *
 * Why this exists: the pure-helper tests in test-parse.mjs cannot catch a stale
 * identifier left inside main() by a refactor. That happened twice — the second
 * time the workflow died with `FATAL: withD is not defined` AFTER the API calls
 * had already succeeded, so a whole month of syncs silently produced no data.
 *
 * This test actually EXECUTES main() with a stubbed fetch() and a throwaway
 * index.html, then asserts that the written file is still valid JavaScript and
 * contains the expected numbers. No network, no secrets.
 *
 * Fixtures mirror the real world:
 *  - Sales & Trends DAILY report: TAB separated, gzip compressed
 *  - "App Store Discovery and Engagement Standard": one numeric column shared
 *    by several event kinds, so impressions must be event-filtered
 *  - App Store title of 6796975099 is "Freestyle Dance Challenge", which also
 *    contains "dance" — the title rule that used to collapse both apps into one
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// ---------------------------------------------------------------- fixtures
const DANCELOG = '6795164130';
const FREESTYLE = '6796975099';
// Deliberately 12 days old, NOT 2: Apple sometimes has no DAILY sales report
// for over a week, and the sync used to scan only 10 days back. With a 2-day
// fixture that bug is invisible — the report is always found. This fixture is
// the regression guard for the 2026-11-10 fallback-to-Analytics incident.
const LATEST = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 12); return d.toISOString().slice(0, 10); })();
const dayBefore = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

// Sales TSV: same date, both apps, plus an UPDATE row (7F) that must be ignored.
const SALES_TSV = [
  'Provider\tProvider Country\tSKU\tDeveloper\tTitle\tVersion\tProduct Type Identifier\tUnits\tDeveloper Proceeds\tBegin Date\tEnd Date\tCustomer Currency\tCountry Code\tCurrency of Proceeds\tApple Identifier\tCustomer Price\tPromo Code\tParent Identifier\tSubscription\tPeriod\tCategory\tCMB\tDevice\tSupported Platforms\tProceeds Reason\tPreserved Pricing\tClient\tOrder Type',
  `APPLE\tUS\tSKU1\tShike\tDance Log\t1.2\t1F\t20\t0.00\t${LATEST}\t${LATEST}\tUSD\tUS\tUSD\t${DANCELOG}\t0.00\t\t\t\t\tHealth & Fitness\t\tiPhone\tiOS\t\t\t\t\t`,
  `APPLE\tUS\tSKU1\tShike\tDance Log\t1.2\t1F\t3\t0.00\t${LATEST}\t${LATEST}\tUSD\tUS\tUSD\t${DANCELOG}\t0.00\t\t\t\t\tHealth & Fitness\t\tiPad\tiOS\t\t\t\t\t`,
  `APPLE\tUS\tSKU1\tShike\tDance Log\t1.2\t7F\t9\t0.00\t${LATEST}\t${LATEST}\tUSD\tUS\tUSD\t${DANCELOG}\t0.00\t\t\t\t\tHealth & Fitness\t\tiPhone\tiOS\t\t\t\t\t`,
  `APPLE\tUS\tSKU2\tShike\tFreestyle Dance Challenge\t1.0\t1F\t3\t0.00\t${LATEST}\t${LATEST}\tUSD\tUS\tUSD\t${FREESTYLE}\t0.00\t\t\t\t\tHealth & Fitness\t\tiPhone\tiOS\t\t\t\t\t`
].join('\n');

// Discovery & Engagement CSV: one numeric column, several event kinds.
const impressionsCsv = (appId, name, rows) => [
  'Date\tApp Name\tApp Apple Identifier\tEvent\tPage Type\tSource Type\tCounts',
  ...rows.map(([ev, n]) => `${LATEST}\t${name}\t${appId}\t${ev}\tApp Store\tSearch\t${n}`)
].join('\n');
// Same shape on a different date — used by the third run to prove that ALL
// DAILY Analytics instances are merged into a full-window impression series.
const impressionsCsvOn = (appId, name, date, rows) => [
  'Date\tApp Name\tApp Apple Identifier\tEvent\tPage Type\tSource Type\tCounts',
  ...rows.map(([ev, n]) => `${date}\t${name}\t${appId}\t${ev}\tApp Store\tSearch\t${n}`)
].join('\n');
// 100 impressions + 299 page views must total 100, not 399.
const IMP_DANCELOG = impressionsCsv(DANCELOG, 'Dance Log', [['Impression', 60], ['Impression', 40], ['Page view', 299]]);
const IMP_FREESTYLE = impressionsCsv(FREESTYLE, 'Freestyle Dance Challenge', [['Impression', 25], ['Page view', 77]]);

const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8'));
const json = (obj, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  arrayBuffer: async () => Buffer.from(JSON.stringify(obj), 'utf8'),
  text: async () => JSON.stringify(obj)
});
const raw = (buf, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  arrayBuffer: async () => buf, text: async () => buf.toString('utf8')
});

// ------------------------------------------------------------------- setup
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-pipeline-'));
const indexFile = path.join(tmp, 'index.html');
// A miniature page that still carries the markers and two inline scripts, so we
// can prove the rewrite did not break the surrounding JavaScript.
fs.writeFileSync(indexFile, [
  '<!doctype html><html><body>',
  '<script>const I18N = {};</script>',
  '<script>',
  '      /* ASC-METRICS:START (hand-written placeholder) */',
  '      const ASC_METRICS = { totals: {} };',
  '      /* ASC-METRICS:END */',
  '      renderTraction();',
  '      function renderTraction() { return ASC_METRICS; }',
  '</script>',
  '</body></html>'
].join('\n'), 'utf8');

// The standalone SitePilot case page gets its own baked snapshot. Use a
// throwaway copy so the real subpage is never touched by a test run.
const subpageFile = path.join(tmp, 'sitepilot.html');
fs.writeFileSync(subpageFile, [
  '<!doctype html><html><body>',
  '<script>',
  '/* SITEPILOT-METRICS:START (hand-written placeholder) */',
  'const SITEPILOT_METRICS = {};',
  '/* SITEPILOT-METRICS:END */',
  '</script>',
  '</body></html>'
].join('\n'), 'utf8');
process.env.ASC_SUBPAGE_FILE = subpageFile;

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.ASC_ISSUER_ID = 'test-issuer';
process.env.ASC_KEY_ID = 'test-key';
process.env.ASC_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.ASC_VENDOR_NUMBER = '94629256';
process.env.ASC_APP_IDS = `${FREESTYLE},${DANCELOG}`;
process.env.ASC_INDEX_FILE = indexFile;

const requests = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  requests.push(u);
  const appIn = (s) => (s.includes(DANCELOG) ? DANCELOG : FREESTYLE);
  if (u.includes('/v1/salesReports')) {
    // Only the newest date has a file; Apple's daily reports lag 1-2 days and a
    // day with no sales has no file at all.
    if (u.includes(LATEST)) return raw(gz(SALES_TSV));
    return raw(Buffer.from('not found'), 404);
  }
  // Every id is app-scoped on purpose: identical ids would let one app's
  // payload be served for the other and hide a per-app mix-up.
  if (u.includes('/segments')) {
    const appId = appIn(u);
    return json({ data: [{ type: 'analyticsReportSegments', id: 'seg-' + appId, attributes: { url: 'https://s3.test/' + appId + '.csv.gz' } }] });
  }
  if (u.startsWith('https://s3.test/')) {
    return raw(gz(u.includes(DANCELOG) ? IMP_DANCELOG : IMP_FREESTYLE));
  }
  if (u.includes('/instances')) {
    const appId = appIn(u);
    return json({ data: [{ type: 'analyticsReportInstances', id: 'inst-' + appId, attributes: { granularity: 'DAILY' } }] });
  }
  if (/analyticsReportRequests\/[^/]+\/reports$/.test(u)) {
    const appId = appIn(u);
    return json({ data: [{ type: 'analyticsReports', id: 'rep-' + appId, attributes: { name: 'App Store Discovery and Engagement Standard' } }] });
  }
  if (u.includes('/analyticsReportRequests')) {
    const appId = appIn(u);
    return json({ data: [{ type: 'analyticsReportRequests', id: 'req-' + appId, attributes: { accessType: 'ONGOING' } }] });
  }
  throw new Error('unexpected request in test: ' + u);
};

// -------------------------------------------------------------------- run
const mod = await import('./update-metrics.mjs');
let threw = null;
try { await mod.main(); } catch (err) { threw = err; }

check('main() completes without throwing', threw === null, threw && threw.message);

const html = fs.readFileSync(indexFile, 'utf8');
const start = '/* ASC-METRICS:START';
const end = 'ASC-METRICS:END */';
const a = html.indexOf(start), b = html.indexOf(end);
check('markers still present after rewrite', a !== -1 && b !== -1);

// Extract the object literal by brace matching — the trailing "; /* ASC-METRICS:END */"
// cannot be stripped with a regex, and slicing to the marker would leave it in.
const assignAt = html.indexOf('const ASC_METRICS = ');
const objStart = html.indexOf('{', assignAt);
let depth = 0, objEnd = -1;
for (let i = objStart; i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
}
let data = null;
try { data = JSON.parse(html.slice(objStart, objEnd + 1)); }
catch (err) { console.log('  JSON.parse failed: ' + err.message); }
check('written block is valid JSON (no leftover identifiers)', data !== null);

// Every inline script must still compile — the closing marker has to stay inside
// a comment, otherwise JS parses "ASC-METRICS:END */" as code and dies on the colon.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let compileErr = null;
scripts.forEach((s, i) => { try { new Function(s); } catch (e) { compileErr = `script[${i}]: ${e.message}`; } });
check('inline scripts still compile', compileErr === null, compileErr || '');
check('closing marker is wrapped in a comment', html.includes('/* ' + end), html.slice(b - 20, b + 20));

if (data) {
  check('sales units: DanceLog = 23 (20 + 3, the 7F update row excluded)',
    data.apps.find(x => x.key === 'dancelog')?.downloadsWindow === 23,
    JSON.stringify(data.apps.map(x => [x.key, x.downloadsWindow])));
  check('sales units: Freestyle = 3', data.apps.find(x => x.key === 'freestyle')?.downloadsWindow === 3);
  check('totals.downloadsWindow = 26', data.totals.downloadsWindow === 26, String(data.totals.downloadsWindow));
  check('windowDays is 90', data.windowDays === 90, String(data.windowDays));
  check('chart payload spans the full 90-day window',
    data.daily?.dates?.length === 90 && (data.daily?.series || []).every(s => s.values.length === 90),
    'dates=' + data.daily?.dates?.length + ' series=' + JSON.stringify((data.daily?.series || []).map(s => s.values.length)));
  check('no MoM / negative growth field is published any more',
    !JSON.stringify(data).includes('MoM'), JSON.stringify(data.totals));
  check('both apps survive with distinct keys',
    data.apps.length === 2 && new Set(data.apps.map(x => x.key)).size === 2,
    JSON.stringify(data.apps.map(x => x.key)));
  check('keys resolved by Apple ID, not the "dance" keyword',
    data.apps.find(x => x.appleId === FREESTYLE)?.key === 'freestyle',
    JSON.stringify(data.apps.map(x => [x.appleId, x.key])));
  check('chart payload has two series (not one shared key)',
    data.daily && Array.isArray(data.daily.series) && data.daily.series.length === 2,
    JSON.stringify(data.daily && data.daily.series && data.daily.series.map(s => s.key)));
  check('chart series carry their own names',
    (data.daily?.series || []).every(s => typeof s.name === 'string' && s.name.length));
  check('impressions exclude page views: DanceLog = 100 (not 399)',
    data.apps.find(x => x.key === 'dancelog')?.impressionsWindow === 100,
    String(data.apps.find(x => x.key === 'dancelog')?.impressionsWindow));
  check('impressions exclude page views: Freestyle = 25 (not 102)',
    data.apps.find(x => x.key === 'freestyle')?.impressionsWindow === 25,
    String(data.apps.find(x => x.key === 'freestyle')?.impressionsWindow));
  check('same-window conversion: totals = 26 downloads / 125 impressions = 20.8%',
    data.totals.conversionPct === 20.8 && data.totals.conversionDays === 1,
    JSON.stringify(data.totals));
  check('same-window conversion is published PER APP for the case pages',
    data.apps.find(x => x.key === 'dancelog')?.conversionPct === 23 &&
    data.apps.find(x => x.key === 'freestyle')?.conversionPct === 12,
    JSON.stringify(data.apps.map(a => [a.key, a.conversionPct])));
  check('impression coverage is published (days with data)',
    data.totals.impressionDays === 1 &&
    data.apps.find(x => x.key === 'dancelog')?.impressionDays === 1,
    JSON.stringify(data.totals));
  const sub1 = JSON.parse(fs.readFileSync(subpageFile, 'utf8').match(/const SITEPILOT_METRICS = ([\s\S]*?);\n\/\* SITEPILOT-METRICS:END/)[1]);
  check('subpage: no SitePilot in a 2-app snapshot writes app = null (no invented numbers)',
    sub1.app === null && sub1.windowDays === 90, JSON.stringify(sub1));
  check('source is sales-and-trends', data.source === 'sales-and-trends', data.source);
  check('sales scan still finds a report 12 days old (no Analytics fallback)',
    data.source === 'sales-and-trends' && data.updatedAt === LATEST,
    'source=' + data.source + ' updatedAt=' + data.updatedAt);
  check('updatedAt is the latest available report date', data.updatedAt === LATEST, data.updatedAt);
}

// ------------------------------------------------- front-end contract
// The data pipeline and the page must agree. A refactor that reintroduces a
// month-over-month percentage would put a negative number back in a KPI card
// (the exact -62% / -73% regression this change removes), so guard it here.
const site = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
check('site: KPI cards are cumulative counts, not MoM percentages',
  site.includes('id="kpi-total"') && !site.includes('id="kpi-growth"') &&
  site.includes('Cumulative downloads · all apps'));
check('site: no hardcoded 30-day caption remains in the Traction section',
  !site.includes('Downloads (30d)') && !site.includes('Cumulative (30d)') &&
  !site.includes('month over month') && !site.includes('+733%'));
check('site: window captions are data-driven (snapshot decides 30 vs 90 days)',
  site.includes('data-window=') && site.includes('WINDOW_COPY') &&
  site.includes('Number(m.windowDays)'));
check('site: KPI values are clamped to non-negative / 0-100%',
  site.includes('Math.max(0, o[k])') && site.includes('Math.min(100, Math.max(0, Math.round(share)))'));
check('site: legacy 30d snapshot fields are still read (no blank cards between syncs)',
  site.includes("'downloads30d'") && site.includes("'impressions30d'"));
check('site: conversion is read from a same-window sync field, never recomputed here',
  site.includes("'conversionPct'") && !site.includes('const conv =') &&
  site.includes('same dates') && site.includes('id="traction-conv-note"'));
check('site: homepage shows cumulative impressions and conversion KPIs',
  site.includes('id="kpi-impressions"') && site.includes('id="kpi-conversion"') &&
  site.includes('imp(m.totals)') && site.includes('cv(m.totals)'));
check('site: cumulative chart is always visible (no collapsed <details>)',
  !site.includes('<details class="traction-details">') &&
  site.includes('<div class="traction-details">') &&
  site.includes('<p class="traction-details-title">'));
check('site: workflow commits both the homepage and the standalone case page',
  fs.readFileSync(new URL('../.github/workflows/update-metrics.yml', import.meta.url), 'utf8')
    .includes('git add index.html sitepilot/index.html'));
check('site: all three case pages show their OWN app data',
  ['freestyle', 'dancelog', 'sitepilot'].every(k =>
    site.includes(`data-app-metric="${k}:downloads"`) &&
    site.includes(`data-app-metric="${k}:impressions"`) &&
    site.includes(`data-app-metric="${k}:conversion"`)));
check('site: live-app count is data-driven, never a hardcoded 2',
  site.includes('id="kpi-appcount"') && site.includes('Number(m.liveAppCount)') &&
  !site.includes('<strong class="kpi-num">2</strong>'));
check('site: no "two apps / both apps" copy is left in the Traction section',
  !site.includes('two live apps') && !site.includes('both apps'));
check('site: third app has a display name and every series is a solid measured line',
  site.includes("sitepilot: 'SitePilot'") && !site.includes("dash: '2 3'"));

// ------------------------------------- second run: auto-discovery (3 apps)
// Pure-helper tests cannot catch a stale identifier inside main(), so really
// EXECUTE the discovery path: drop the ID override, stub the public store
// lookup, run main() again and read the snapshot it writes.
const SITEPILOT = '6811473992';
const storeApp = (id, name, released) => ({
  wrapperType: 'software', kind: 'software', trackId: Number(id), trackName: name,
  bundleId: 'com.test.' + id, releaseDate: released + 'T07:00:00Z', version: '1.0',
  trackViewUrl: 'https://apps.apple.com/us/app/x/id' + id + '?uo=4'
});
const ARTIST = { wrapperType: 'artist', artistId: 6795014821, artistName: 'Shike Zhang' };
const STORE_US = { resultCount: 4, results: [
  ARTIST,
  storeApp(DANCELOG, 'Dance Log', '2026-08-06'),
  storeApp(FREESTYLE, 'Freestyle Dance Challenge', '2026-08-24'),
  storeApp(SITEPILOT, 'SitePilot - Restaurant Lease', '2026-11-05')
]};
// SitePilot is US-only. Merging storefronts must not lose it.
const STORE_CN = { resultCount: 3, results: [
  ARTIST,
  storeApp(DANCELOG, 'Dance Log', '2026-08-06'),
  storeApp(FREESTYLE, 'Freestyle Dance Challenge', '2026-08-24')
]};
delete process.env.ASC_APP_IDS;
const baseFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('itunes.apple.com/lookup')) {
    const payload = u.includes('country=us') ? STORE_US : STORE_CN;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  }
  // A brand-new app has no analytics report request yet. A 404 must NOT drop
  // its Sales & Trends row (that used to lose the whole app).
  if (u.includes(SITEPILOT)) return { ok: false, status: 404, text: async () => 'no report' };
  return baseFetch(url, opts);
};
let threw2 = null;
try { await mod.main(); } catch (err) { threw2 = err; }
check('auto-discovery: main() completes without throwing', threw2 === null, threw2 && threw2.message);

const html2 = fs.readFileSync(indexFile, 'utf8');
const assign2 = html2.indexOf('const ASC_METRICS = ');
const obj2 = html2.indexOf('{', assign2);
let depth2 = 0, end2 = -1;
for (let i = obj2; i < html2.length; i++) {
  if (html2[i] === '{') depth2++;
  else if (html2[i] === '}') { depth2--; if (depth2 === 0) { end2 = i; break; } }
}
let data2 = null;
try { data2 = JSON.parse(html2.slice(obj2, end2 + 1)); }
catch (err) { console.log('  JSON.parse #2 failed: ' + err.message); }
check('auto-discovery: written block is valid JSON', data2 !== null);
if (data2) {
  check('auto-discovery: liveAppCount = 3 (from the App Store, not the sales report)',
    data2.liveAppCount === 3, String(data2.liveAppCount));
  check('auto-discovery: storeApps keeps the US-only third app',
    (data2.storeApps || []).length === 3 && data2.storeApps.some(a => a.appleId === SITEPILOT),
    JSON.stringify((data2.storeApps || []).map(a => a.appleId)));
  check('auto-discovery: artist header is not published as an app',
    !(data2.storeApps || []).some(a => a.appleId === '6795014821'));
  check('auto-discovery: 3 apps AND 3 chart series',
    data2.apps.length === 3 && (data2.daily?.series || []).length === 3,
    'apps=' + data2.apps.length + ' series=' + (data2.daily?.series || []).length);
  check('auto-discovery: third app resolves to the sitepilot key',
    data2.apps.find(a => a.appleId === SITEPILOT)?.key === 'sitepilot',
    JSON.stringify(data2.apps.map(a => [a.appleId, a.key])));
  check('auto-discovery: third app shows 0 downloads (launched after the report window)',
    data2.apps.find(a => a.appleId === SITEPILOT)?.downloadsWindow === 0,
    String(data2.apps.find(a => a.appleId === SITEPILOT)?.downloadsWindow));
  check('auto-discovery: missing analytics report does NOT drop the third app',
    data2.apps.some(a => a.appleId === SITEPILOT) &&
    data2.apps.find(a => a.appleId === SITEPILOT).impressionsWindow === null,
    JSON.stringify(data2.apps.find(a => a.appleId === SITEPILOT)));
  check('auto-discovery: original two apps keep their numbers',
    data2.totals.downloadsWindow === 26, String(data2.totals.downloadsWindow));
  check('auto-discovery: store links have no tracking query',
    (data2.storeApps || []).every(a => !a.url.includes('uo=4')));
  check('auto-discovery: an app with no impressions has NO fabricated conversion rate',
    data2.apps.find(a => a.appleId === SITEPILOT).conversionPct === null,
    JSON.stringify(data2.apps.find(a => a.appleId === SITEPILOT)));
  check('auto-discovery: totals conversion is still published for the other two apps',
    typeof data2.totals.conversionPct === 'number' && data2.totals.conversionPct > 0,
    JSON.stringify(data2.totals));
  const sub2 = JSON.parse(fs.readFileSync(subpageFile, 'utf8').match(/const SITEPILOT_METRICS = ([\s\S]*?);\n\/\* SITEPILOT-METRICS:END/)[1]);
  check('subpage: SitePilot case page receives ITS OWN numbers, not the homepage totals',
    sub2.app && sub2.app.appleId === SITEPILOT && sub2.app.downloadsWindow === 0 &&
    sub2.app.impressionsWindow === null && sub2.app.conversionPct === null,
    JSON.stringify(sub2));
  check('subpage: rewritten inline script still compiles',
    (() => { try { new Function(fs.readFileSync(subpageFile, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]); return true; } catch (e) { return false; } })());
}
// ------------------------------- third run: full-window impressions (F35)
// Two DAILY instances per app (one on LATEST, one on the day before) plus a
// WEEKLY instance that must be skipped. If the sync still read only the first
// instance, impressionsWindow would stay at 100 / 25 and this guard goes red.
const PREV = dayBefore(LATEST);
const appIn3 = (s) => (String(s).includes(DANCELOG) ? DANCELOG : FREESTYLE);
process.env.ASC_APP_IDS = `${FREESTYLE},${DANCELOG}`;
const req3 = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  req3.push(u);
  if (u.includes('/instances')) {
    const appId = appIn3(u);
    return json({ data: [
      { id: 'iA-' + appId, attributes: { granularity: 'DAILY' } },
      { id: 'iB-' + appId, attributes: { granularity: 'DAILY' } },
      { id: 'iW-' + appId, attributes: { granularity: 'WEEKLY' } }
    ]});
  }
  if (u.includes('/segments')) {
    const appId = appIn3(u);
    const tag = u.includes('iB-') ? 'b' : 'a';
    return json({ data: [{ type: 'analyticsReportSegments', id: 'seg-' + appId + '-' + tag,
      attributes: { url: 'https://s3.test/' + appId + '-' + tag + '.csv.gz' } }] });
  }
  if (u.startsWith('https://s3.test/')) {
    const appId = appIn3(u);
    if (u.includes('-b.csv.gz')) return raw(gz(impressionsCsvOn(appId, 'App ' + appId, PREV, [['Impression', 50]])));
    return raw(gz(u.includes(DANCELOG) ? IMP_DANCELOG : IMP_FREESTYLE));
  }
  return baseFetch(url, opts);
};
let threw3 = null;
try { await mod.main(); } catch (err) { threw3 = err; }
check('full-window impressions: main() completes without throwing', threw3 === null, threw3 && threw3.message);

const html3 = fs.readFileSync(indexFile, 'utf8');
const assign3 = html3.indexOf('const ASC_METRICS = ');
const obj3 = html3.indexOf('{', assign3);
let depth3 = 0, end3 = -1;
for (let i = obj3; i < html3.length; i++) {
  if (html3[i] === '{') depth3++;
  else if (html3[i] === '}') { depth3--; if (depth3 === 0) { end3 = i; break; } }
}
let data3 = null;
try { data3 = JSON.parse(html3.slice(obj3, end3 + 1)); }
catch (err) { console.log('  JSON.parse #3 failed: ' + err.message); }
check('full-window impressions: written block is valid JSON', data3 !== null);
if (data3) {
  check('full-window impressions: BOTH DAILY instances are summed (100+50 / 25+50)',
    data3.apps.find(a => a.key === 'dancelog')?.impressionsWindow === 150 &&
    data3.apps.find(a => a.key === 'freestyle')?.impressionsWindow === 75,
    JSON.stringify(data3.apps.map(a => [a.key, a.impressionsWindow])));
  check('full-window impressions: homepage total is the sum across all apps',
    data3.totals.impressionsWindow === 225, String(data3.totals.impressionsWindow));
  check('full-window impressions: WEEKLY instance is not double-counted',
    req3.filter(u => u.includes('iW-')).length === 0 &&
    req3.filter(u => u.includes('/segments')).length === 4,
    'segment requests=' + req3.filter(u => u.includes('/segments')).length);
  check('full-window impressions: conversion uses both shared days, not just one',
    data3.totals.conversionDays === 2 && data3.totals.conversionPct === 11.56,
    JSON.stringify(data3.totals));
}
globalThis.fetch = baseFetch;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL PIPELINE TESTS PASS' : `\n${failed} PIPELINE TEST(S) FAILED`);
process.exit(failed);
