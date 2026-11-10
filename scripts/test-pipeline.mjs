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
const LATEST = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 2); return d.toISOString().slice(0, 10); })();
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
  check('source is sales-and-trends', data.source === 'sales-and-trends', data.source);
  check('updatedAt is the latest available report date', data.updatedAt === LATEST, data.updatedAt);
}

// ------------------------------------------------- front-end contract
// The data pipeline and the page must agree. A refactor that reintroduces a
// month-over-month percentage would put a negative number back in a KPI card
// (the exact -62% / -73% regression this change removes), so guard it here.
const site = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
check('site: KPI cards are cumulative counts, not MoM percentages',
  site.includes('id="kpi-total"') && !site.includes('id="kpi-growth"') &&
  site.includes('Cumulative downloads · both apps'));
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL PIPELINE TESTS PASS' : `\n${failed} PIPELINE TEST(S) FAILED`);
process.exit(failed);
