// Regression tests for scripts/update-metrics.mjs parsing helpers.
// Run: node scripts/test-parse.mjs
// Bug being guarded against: Apple analytics CSVs are TAB-delimited; parsing
// them as comma-separated collapsed every row into one column and made
// parseFloat read the year "2026" out of the date field (site showed 8,104
// downloads = 2026 x 4 rows, 160,054 impressions = 2026 x 79 rows).

import { parseCsv, sumWindow, buildWindow } from './update-metrics.mjs';

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

process.exit(failed);
