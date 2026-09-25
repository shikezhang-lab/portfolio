// Regression tests for scripts/update-metrics.mjs parsing helpers.
// Run: node scripts/test-parse.mjs
// Bug being guarded against: Apple analytics CSVs are TAB-delimited; parsing
// them as comma-separated collapsed every row into one column and made
// parseFloat read the year "2026" out of the date field (site showed 8,104
// downloads = 2026 x 4 rows, 160,054 impressions = 2026 x 79 rows).

import {
  parseCsv, sumWindow, buildWindow, unitsFromSalesRows, windowEndingAt,
  appKeyFor, uniqueAppKeys, buildDailySeries
} from './update-metrics.mjs';

let failed = 0;
function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : ' :: ' + extra));
  if (!cond) failed = 1;
}

// 1) Tab-delimited downloads CSV (real Apple shape)
const tab = [
  'Date\tApp Name\tApp Apple Identifier\tDownload Type\tApp Version\tDevice\tPlatform\tCount',
  '2026-09-22\tDanceLog\t6795164130\tDownloads\t1.2\tiPhone 15\tiOS\t13',
  '2026-09-21\tDanceLog\t6795164130\tDownloads\t1.2\tiPhone 15\tiOS\t9',
  '2026-08-01\tDanceLog\t6795164130\tDownloads\t1.1\tiPhone 15\tiOS\t4'
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
const dates = buildWindow();
const current = dates.slice(30);      // most recent 30 (fixed direction)
const previous = dates.slice(0, 30);
const cur = sumWindow(byDay, current);
const prev = sumWindow(byDay, previous);
check('tab CSV sums real counts in recent window (22)', cur === 22, 'got ' + cur);
check('older row lands in previous window (4)', prev === 4, 'got ' + prev);

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

// 5) windowEndingAt: 60 days ending at `latest`, oldest -> newest
const w = windowEndingAt('2026-09-22');
check('windowEndingAt length 60', w.length === 60, 'got ' + w.length);
check('windowEndingAt ends at latest, oldest-first', w[59] === '2026-09-22' && w[0] === '2026-07-25',
  w[0] + ' .. ' + w[59]);

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

process.exit(failed);
