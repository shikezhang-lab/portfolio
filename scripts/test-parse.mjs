// Regression tests for scripts/update-metrics.mjs parsing helpers.
// Run: node scripts/test-parse.mjs
// Bug being guarded against: Apple analytics CSVs are TAB-delimited; parsing
// them as comma-separated collapsed every row into one column and made
// parseFloat read the year "2026" out of the date field (site showed 8,104
// downloads = 2026 x 4 rows, 160,054 impressions = 2026 x 79 rows).

import {
  parseCsv, sumWindow, buildWindow, unitsFromSalesRows, windowEndingAt,
  appKeyFor, uniqueAppKeys, buildDailySeries, seriesFromAnalyticsRows,
  mergeStoreApps
} from './update-metrics.mjs';

let failed = 0;
function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : ' :: ' + extra));
  if (!cond) failed = 1;
}

// 1) Tab-delimited downloads CSV (real Apple shape)
// ⚠️ 窗口是按「今天」滚动的（buildWindow 默认 now = new Date()）。fixture 若写死日期，
// 日期一旦滑出窗口，测试就会在某天突然假失败 —— 2026-10-01 真的发生过一次：
// 写死的 2026-08-01 滑出 previous 窗口，prev 由 4 变成 0，而代码其实一直是好的。
// ⇒ fixture 日期一律相对 NOW 生成，并与 buildWindow 共用同一个 now。
// 2026-11-10 起窗口改为「单一 90 天累计窗口」（不再有 previous / MoM），
// 所以窗口外的 fixture 必须落在 NOW-90 天之前，否则会污染合计。
const NOW = new Date();
const dayAgo = (n) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
// 累计窗口 = 往前 0~89 天；窗口外 = 往前 120 天
const D_CUR_A = dayAgo(3);    // 13
const D_CUR_B = dayAgo(2);    // 9
const D_OUT = dayAgo(120);    // 4（窗口外，必须被排除）
const tab = [
  'Date\tApp Name\tApp Apple Identifier\tDownload Type\tApp Version\tDevice\tPlatform\tCount',
  `${D_CUR_A}\tDanceLog\t6795164130\tDownloads\t1.2\tiPhone 15\tiOS\t13`,
  `${D_CUR_B}\tDanceLog\t6795164130\tDownloads\t1.2\tiPhone 15\tiOS\t9`,
  `${D_OUT}\tDanceLog\t6795164130\tDownloads\t1.1\tiPhone 15\tiOS\t4`
].join('\n');
const rows = parseCsv(tab);
const header = rows[0].map(h => h.trim().toLowerCase());
const dateIdx = header.findIndex(h => h.includes('date'));
const valIdx = header.findIndex((h, i) => i !== dateIdx &&
  (h.includes('count') || h.includes('downloads') || h.includes('units') || h.includes('impressions') || h.includes('views')));
check('tab CSV splits into 8 columns', rows[0].length === 8, 'got ' + rows[0].length);
check('value column is Count', header[valIdx] === 'count', 'got "' + header[valIdx] + '"');
check('value does not parse as year 2026', rows[1][valIdx] === '13', 'got "' + rows[1][valIdx] + '"');

const byDay = new Map();
for (const r of rows.slice(1)) {
  const day = (r[dateIdx] || '').slice(0, 10);
  const v = parseFloat(r[valIdx]);
  if (!day || Number.isNaN(v)) continue;
  byDay.set(day, (byDay.get(day) || 0) + v);
}
const dates = buildWindow(NOW);
check('window is exactly 90 days', dates.length === 90, 'got ' + dates.length);
check('fixture 日期确实落在预期窗口内 / 外（否则下面两条会假失败）',
  dates.includes(D_CUR_A) && dates.includes(D_CUR_B) && !dates.includes(D_OUT),
  `window=${dates[0]}..${dates[dates.length - 1]} fixture=${D_CUR_A},${D_CUR_B},${D_OUT}`);
const cur = sumWindow(byDay, dates);
check('tab CSV sums real counts inside the 90-day window (22)', cur === 22, 'got ' + cur);
check('row older than 90 days is excluded, but still sums on its own (4)',
  !dates.includes(D_OUT) && sumWindow(byDay, [D_OUT]) === 4, 'got ' + sumWindow(byDay, [D_OUT]));

// 2) Comma-delimited CSV still works
const comma = 'Date,App Name,Impressions\n2026-09-22,DanceLog,510\n';
const r2 = parseCsv(comma);
const h2 = r2[0].map(h => h.trim().toLowerCase());
const d2 = h2.findIndex(h => h.includes('date'));
const v2 = h2.findIndex((h, i) => i !== d2 && h.includes('impressions'));
check('comma CSV still parses', h2.length === 3 && r2[1][v2] === '510', 'got ' + JSON.stringify(r2));

// 3) Window direction: buildWindow oldest -> newest
check('buildWindow is oldest -> newest', dates[0] < dates[dates.length - 1],
  dates[0] + ' vs ' + dates[dates.length - 1]);

// 4) Sales & Trends TSV: sum Units per Apple Identifier, app purchases only
//    (Product Type Identifier starting with "1"); updates (7*) excluded.
const sales = [
  'Provider\tProvider Country\tSKU\tDeveloper\tTitle\tVersion\tProduct Type Identifier\tUnits\tDeveloper Proceed\tApple Identifier',
  ' COMPANY\tUS\tDL001\tcoco\tDance Log\t1.2\t1F\t11\t0.00\t6795164130',
  ' COMPANY\tCN\tDL001\tcoco\tDance Log\t1.2\t1F\t12\t0.00\t6795164130',
  ' COMPANY\tUS\tFDC1\tcoco\tFreestyle Dance Challenge\t1.0\t1T\t3\t0.00\t6796975099',
  ' COMPANY\tUS\tFDC1\tcoco\tFreestyle Dance Challenge\t1.0\t7\t99\t0.00\t6796975099'
].join('\n');
const units = unitsFromSalesRows(parseCsv(sales));
check('sales: Dance Log units = 23', units.get('6795164130')?.units === 23, JSON.stringify([...units]));
check('sales: Freestyle units = 3 (update rows excluded)', units.get('6796975099')?.units === 3, JSON.stringify([...units]));
check('sales: title captured for key mapping', /dance/i.test(units.get('6795164130')?.title || ''), units.get('6795164130')?.title);

// 5) windowEndingAt: 90 days ending at `latest`, oldest -> newest
const w = windowEndingAt('2026-09-22');
const expectedStart = (() => { const d = new Date('2026-09-22T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 89); return d.toISOString().slice(0, 10); })();
check('windowEndingAt length 90', w.length === 90, 'got ' + w.length);
check('windowEndingAt ends at latest, oldest-first', w[89] === '2026-09-22' && w[0] === expectedStart,
  w[0] + ' .. ' + w[89] + ' (expected ' + expectedStart + ')');

// 6) App key mapping. Regression: /dance/ was tested FIRST, and the Freestyle
//    app's store title is "Freestyle Dance Challenge" — so both apps resolved to
//    "dancelog" (raw table showed two DanceLog rows, chart collapsed to 1 line).
check('key: "Freestyle Dance Challenge" -> freestyle (contains "dance" too)',
  appKeyFor('6796975099', ['Freestyle Dance Challenge']) === 'freestyle',
  appKeyFor('6796975099', ['Freestyle Dance Challenge']));
check('key: "Dance Log" -> dancelog',
  appKeyFor('6795164130', ['Dance Log']) === 'dancelog',
  appKeyFor('6795164130', ['Dance Log']));
check('key: "DanceLog" (no space) -> dancelog',
  appKeyFor('6795164130', ['DanceLog']) === 'dancelog',
  appKeyFor('6795164130', ['DanceLog']));
check('key: no title falls back to the Apple-ID map',
  appKeyFor('6796975099', []) === 'freestyle' && appKeyFor('6795164130', []) === 'dancelog',
  appKeyFor('6796975099', []) + '/' + appKeyFor('6795164130', []));
check('key: unknown app is namespaced, never guessed',
  appKeyFor('1234567890', ['Some Other App']) === 'app-1234567890',
  appKeyFor('1234567890', ['Some Other App']));
check('key: Apple ID wins over a renamed store title',
  appKeyFor('6796975099', ['Totally Different Name']) === 'freestyle',
  appKeyFor('6796975099', ['Totally Different Name']));
check('key: title still resolves an unknown Apple ID',
  appKeyFor('1234567890', ['Dance Log']) === 'dancelog',
  appKeyFor('1234567890', ['Dance Log']));

// 7) Keys must be unique across apps, even when titles collide.
const keys = uniqueAppKeys([
  { appleId: '6796975099', titles: ['Mystery App'] },
  { appleId: '6795164130', titles: ['Mystery App'] }
]);
check('keys are unique when titles collide',
  keys[0] !== keys[1], JSON.stringify(keys));
check('colliding titles still resolve to known apps via Apple ID',
  keys.includes('freestyle') && keys.includes('dancelog'), JSON.stringify(keys));

// 8) Chart payload: one series per app (was hardcoded to 2 named keys).
const built = buildDailySeries(['2026-09-22'], [
  { key: 'freestyle', name: 'Freestyle Challenge', daily: [3] },
  { key: 'dancelog', name: 'DanceLog', daily: [23] }
]);
check('daily series: one entry per app', built && built.series.length === 2, JSON.stringify(built && built.series.map(s => s.key)));
check('daily series: keys preserved',
  built && built.series.map(s => s.key).join(',') === 'freestyle,dancelog',
  built && built.series.map(s => s.key).join(','));
check('daily series: no series when nothing to plot',
  buildDailySeries(['2026-09-22'], [{ key: 'x', name: 'X', daily: null }]) === null,
  JSON.stringify(buildDailySeries(['2026-09-22'], [{ key: 'x', name: 'X', daily: null }])));
check('daily series: empty array is not a series',
  buildDailySeries(['2026-09-22'], [{ key: 'x', name: 'X', daily: [] }]) === null,
  JSON.stringify(buildDailySeries(['2026-09-22'], [{ key: 'x', name: 'X', daily: [] }])));
check('daily series: partially-empty values still render',
  (buildDailySeries(['2026-09-22'], [{ key: 'x', name: 'X', daily: [0, 0] }]) || {}).series?.length === 1,
  JSON.stringify(buildDailySeries(['2026-09-22'], [{ key: 'x', name: 'X', daily: [0, 0] }])));

// 9) Analytics rows -> daily series. The value column must never be the date
// column, and impressions must not be inflated by other event kinds sharing
// the same numeric column.
const disc = (rows) => parseCsv([
  'Date\tApp Name\tApp Apple Identifier\tEvent\tPage Type\tSource Type\tCounts',
  ...rows
].join('\n'));

const mixed = seriesFromAnalyticsRows(disc([
  '2026-09-22\tDance Log\t6795164130\tImpression\tApp Store\tSearch\t60',
  '2026-09-22\tDance Log\t6795164130\tImpression\tApp Store\tBrowse\t40',
  '2026-09-22\tDance Log\t6795164130\tPage view\tApp Store\tSearch\t299'
]), 'impressions');
check('analytics: impressions keep impression rows only (100, not 399)',
  mixed && mixed.byDay.get('2026-09-22') === 100, JSON.stringify(mixed && [...mixed.byDay]));
check('analytics: reports which column was summed',
  mixed && /counts/i.test(mixed.valueCol) && /date/i.test(mixed.dateCol),
  JSON.stringify([mixed && mixed.dateCol, mixed && mixed.valueCol]));
check('analytics: value column is not the date column',
  mixed && mixed.byDay.get('2026-09-22') !== 2026, String(mixed && mixed.byDay.get('2026-09-22')));

// Unknown event labels must fall back to all rows rather than fabricate a zero.
const oddEvents = seriesFromAnalyticsRows(disc([
  '2026-09-22\tDance Log\t6795164130\tProduct page view\tApp Store\tSearch\t17'
]), 'impressions');
check('analytics: unknown event label falls back instead of zeroing',
  oddEvents && oddEvents.byDay.get('2026-09-22') === 17 && oddEvents.filteredByEvent === false,
  JSON.stringify([oddEvents && [...oddEvents.byDay], oddEvents && oddEvents.filteredByEvent]));

// Download reports must never be event-filtered.
const dl = parseCsv([
  'Date\tApp Name\tApp Apple Identifier\tDownload Type\tCounts',
  '2026-09-22\tDance Log\t6795164130\tFirst-time download\t7'
].join('\n'));
const dlSeries = seriesFromAnalyticsRows(dl, 'downloads');
check('analytics: download rows are not event-filtered',
  dlSeries && dlSeries.byDay.get('2026-09-22') === 7 && dlSeries.filteredByEvent === false,
  JSON.stringify(dlSeries && [...dlSeries.byDay]));

check('analytics: no date column -> no series, never a guess',
  seriesFromAnalyticsRows(parseCsv('Foo\tBar\n1\t2')) === null);

// N) Public App Store discovery: the "live apps" count comes from the store,
// not from a hand-maintained ID list. The first lookup result is the DEVELOPER
// header (wrapperType: artist) — counting it would report one app too many.
const software = (id, name, date) => ({
  wrapperType: 'software', kind: 'software', trackId: id, trackName: name,
  bundleId: 'com.test.' + id, releaseDate: date + 'T07:00:00Z', version: '1.0',
  trackViewUrl: 'https://apps.apple.com/us/app/x/id' + id + '?uo=4'
});
const ARTIST = { wrapperType: 'artist', artistId: 6795014821, artistName: 'Shike Zhang' };
const US = { resultCount: 4, results: [
  ARTIST,
  software(6795164130, 'Dance Log', '2026-08-06'),
  software(6796975099, 'Freestyle Dance Challenge', '2026-08-24'),
  software(6811473992, 'SitePilot - Restaurant Lease', '2026-11-05')
]};
// CN storefront has no SitePilot: a CN-only lookup would undercount by one.
const CN = { resultCount: 3, results: [
  ARTIST,
  software(6795164130, 'Dance Log', '2026-08-06'),
  software(6796975099, 'Freestyle Dance Challenge', '2026-08-24')
]};
const merged = mergeStoreApps([US, CN]);
check('store discovery: 3 live apps (artist header excluded)', merged.length === 3,
  JSON.stringify(merged.map(a => a.appleId)));
check('store discovery: US-only third app survives the merge',
  merged.some(a => a.appleId === '6811473992'),
  JSON.stringify(merged.map(a => a.appleId)));
check('store discovery: developer header never becomes an app',
  !merged.some(a => a.appleId === '6795014821'));
check('store discovery: cross-storefront duplicates are de-duplicated',
  merged.filter(a => a.appleId === '6795164130').length === 1);
check('store discovery: sorted oldest-first by release date',
  merged[0].released === '2026-08-06' && merged[2].released === '2026-11-05',
  JSON.stringify(merged.map(a => a.released)));
check('store discovery: tracking query is stripped from links',
  merged.every(a => !a.url.includes('uo=4')), JSON.stringify(merged.map(a => a.url)));
check('store discovery: empty / missing payloads are harmless',
  mergeStoreApps([null, { results: [] }, undefined]).length === 0);
check('store discovery: malformed rows without trackId are skipped',
  mergeStoreApps([{ results: [ARTIST, { wrapperType: 'software', trackName: 'Ghost' }] }]).length === 0);

process.exit(failed);
