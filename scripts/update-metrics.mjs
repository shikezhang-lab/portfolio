#!/usr/bin/env node
/**
 * App Store Connect metrics -> index.html ASC-METRICS marker block.
 *
 * Zero dependencies: JWT (ES256) is signed with Node's built-in crypto.
 * Required env:
 *   ASC_ISSUER_ID    – App Store Connect API Issuer ID (uuid)
 *   ASC_KEY_ID       – App Store Connect API Key ID
 *   ASC_PRIVATE_KEY  – Contents of the .p8 file (\n escapes are fine)
 * Optional env:
 *   ASC_APP_IDS       – comma-separated Apple IDs (default: 6796975099,6795164130)
 *   ASC_VENDOR_NUMBER – vendor number (8 digits, shown in Agreements, Tax and
 *                       Banking). When set, downloads come from Sales &
 *                       Trends DAILY reports — the SAME source as the
 *                       "App 销量" card in the ASC backend. Without it the
 *                       script falls back to Analytics "App Downloads",
 *                       which uses a different metric definition and does
 *                       NOT match the backend (observed 4 vs 26).
 *
 * Run `node scripts/update-metrics.mjs --selftest` to verify JWT signing
 * with a locally generated key (no network, no secrets needed).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com';
const APP_IDS = (process.env.ASC_APP_IDS || '6796975099,6795164130').split(',').map(s => s.trim()).filter(Boolean);
const WINDOW = 30; // days
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so the end-to-end smoke test (scripts/test-pipeline.mjs) can run
// main() against a throwaway copy instead of the real index.html.
const INDEX = process.env.ASC_INDEX_FILE
  ? path.resolve(process.env.ASC_INDEX_FILE)
  : path.join(ROOT, 'index.html');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadPrivateKey() {
  let raw = process.env.ASC_PRIVATE_KEY || '';
  if (!raw) throw new Error('ASC_PRIVATE_KEY is not set.');
  if (!raw.includes('BEGIN')) raw = '-----BEGIN PRIVATE KEY-----\n' + raw + '\n-----END PRIVATE KEY-----';
  return raw.replace(/\\n/g, '\n');
}

function signJwt(privatePem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' };
  const payload = { iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' };
  const input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const signer = crypto.createSign('SHA256');
  signer.update(input);
  const sig = signer.sign({ key: privatePem, dsaEncoding: 'ieee-p1363' }); // raw r||s for ES256
  return input + '.' + b64url(sig);
}

function netCause(err) {
  const parts = [];
  let c = err;
  while (c) {
    parts.push(c.code || c.message || String(c));
    c = c.cause;
  }
  return parts.join(' <- ');
}

async function api(token, pathName, options = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API + pathName, {
        method: options.method || 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error('ASC ' + res.status + ' ' + pathName + ' :: ' + text.slice(0, 400));
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      lastErr = err;
      if (err.message && err.message.startsWith('ASC ')) throw err; // HTTP-level error: no retry
      if (attempt < 3) {
        console.log(`  fetch failed (attempt ${attempt}), retrying in ${attempt}s...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
  }
  throw new Error('fetch failed after 3 attempts: ' + netCause(lastErr));
}

function parseCsv(text) {
  // Apple analytics CSVs are TAB-delimited; sniff the delimiter from the header
  // line (parsing a tab file as comma-separated collapses each row into ONE
  // column, which made parseFloat read the year "2026" out of the date field).
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = firstLine.includes('\t') ? '\t' : ',';
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const out = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === delim && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  });
}

function dayKey(d) { return d.toISOString().slice(0, 10); }

function buildWindow(now = new Date()) {
  const dates = [];
  for (let i = WINDOW * 2 - 1; i >= 0; i--) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
    dates.push(dayKey(d));
  }
  return dates;
}

/** Fetch one metric series (daily values) for one app via Analytics Reports (STANDALONE). */
async function fetchSeries(token, appId, reportMatchers, metric = 'downloads') {
  let requests = await api(token, `/v1/apps/${appId}/analyticsReportRequests`);
  let list = (requests && requests.data) || [];
  if (list.length === 0) {
    // Apple moved creation to the top-level endpoint: POST /v1/analyticsReportRequests
    // with the app passed via relationships (per-app POST now returns 405).
    for (const accessType of ['ONGOING', 'ONE_TIME_SNAPSHOT']) {
      try {
        console.log(`  creating analyticsReportRequest (${accessType}) for app ${appId} (top-level endpoint)...`);
        requests = await api(token, `/v1/analyticsReportRequests`, {
          method: 'POST',
          body: {
            data: {
              type: 'analyticsReportRequests',
              attributes: { accessType },
              relationships: { app: { data: { type: 'apps', id: appId } } }
            }
          }
        });
        // A create call answers with a SINGLE resource object, not a collection,
        // so `data.length` is undefined there. Testing it as an array made this
        // branch never fire: the request was created and then discarded, and the
        // loop went on to try the next accessType (duplicate requests).
        const created = requests && requests.data;
        const createdList = Array.isArray(created) ? created : (created ? [created] : []);
        if (createdList.length) { list = createdList; break; }
      } catch (e) {
        console.log('  create failed: ' + e.message.slice(0, 200));
      }
    }
  }
  if (!list.length) return null;
  console.log(`  app ${appId}: ${list.length} analyticsReportRequest(s) [${list.map(r => r.attributes.accessType + ':' + r.id.slice(0, 8)).join(', ')}]`);
  for (const request of list) {
    const reports = await api(token, `/v1/analyticsReportRequests/${request.id}/reports`);
    const names = (reports.data || []).map(r => r.attributes.name);
    console.log(`  app ${appId} reports (${request.attributes.accessType}): [${names.join(' | ')}]`);
    for (const matcher of reportMatchers) {
      const report = (reports.data || []).find(r => matcher.test(r.attributes.name));
      if (!report) continue;
      const instances = await api(token, `/v1/analyticsReports/${report.id}/instances`);
      const instList = (instances.data || []);
      if (instList.length === 0) {
        console.log(`  report "${report.attributes.name}" matched, but has no instances yet (Apple generates the first instances within 24-48h of request creation)`);
        continue;
      }
      console.log(`  report "${report.attributes.name}": ${instList.length} instance(s), granularity [${instList.map(i => i.attributes.granularity).join(', ')}]`);
      const instance = instList.find(i => i.attributes.granularity === 'DAILY') || instList[0];
      const segments = await api(token, `/v1/analyticsReportInstances/${instance.id}/segments`);
      const rows = [];
      for (const seg of (segments.data || [])) {
        const url = seg.attributes && (seg.attributes.url || seg.attributes.downloadUrl);
        if (!url) continue;
        const res = await fetch(url);
        if (!res.ok) { console.log(`  segment download failed (${res.status}), skipping`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
        const text = isGzip ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        if (isGzip) console.log('  decoded gzip segment, header: ' + text.split(/\r?\n/)[0]);
        rows.push(...parseCsv(text));
      }
      console.log(`  report "${report.attributes.name}": ${segments.data ? segments.data.length : 0} segment(s), ${rows.length} CSV row(s)`);
      if (rows.length === 0) continue;
      // Full header, untruncated — the column names are the only way to tell
      // from a workflow log which metric was actually summed.
      console.log('  header: ' + rows[0].map(h => h.trim()).join(' | '));
      const parsed = seriesFromAnalyticsRows(rows, metric);
      if (!parsed) { console.log('  unexpected CSV header — no usable date/value column pair'); continue; }
      console.log(`  parsed ${metric}: date col "${parsed.dateCol}", value col "${parsed.valueCol}"`
        + (parsed.filteredByEvent ? `, impression rows kept out of [${parsed.events.join(', ').slice(0, 120)}]` : '')
        + ` -> ${parsed.byDay.size} day(s)`);
      return { reportName: report.attributes.name, byDay: parsed.byDay };
    }
  }
  return null;
}

/**
 * Turn an Analytics report CSV into a daily series.
 *
 * Two correctness rules live here, both learned the hard way:
 *  1. The value column must NEVER be allowed to be the date column. A
 *     separator mismatch once collapsed every row into a single field, so the
 *     date index and the value index both resolved to 0 and
 *     parseFloat("2026-08-23…") returned the YEAR: the site showed
 *     8,104 downloads, which was literally 2026 × 4 CSV rows.
 *  2. For impressions the report carries an Event column and uses one numeric
 *     column for every event kind (imprints / page views / taps). Summing all
 *     rows would inflate the figure, so when an Event column is present we keep
 *     impression rows only. Download reports are never event-filtered.
 */
function seriesFromAnalyticsRows(rows, metric = 'downloads') {
  if (!rows || rows.length === 0) return null;
  const header = rows[0].map(h => h.trim().toLowerCase());
  const dateIdx = header.findIndex(h => h.includes('date'));
  if (dateIdx === -1) return null;

  const preference = metric === 'impressions'
    ? ['impressions', 'impression', 'counts', 'count', 'views']
    : ['downloads', 'units', 'counts', 'count'];
  let valIdx = -1;
  for (const p of preference) {
    const i = header.findIndex((h, idx) => idx !== dateIdx && h.includes(p));
    if (i !== -1) { valIdx = i; break; }
  }
  if (valIdx === -1) return null;

  const eventIdx = header.findIndex(h => h.includes('event'));
  const useEventFilter = metric === 'impressions' && eventIdx !== -1;
  const events = new Set();
  const sum = (filterByEvent) => {
    const byDay = new Map();
    for (const r of rows.slice(1)) {
      const ev = eventIdx === -1 ? '' : (r[eventIdx] || '').trim();
      if (ev) events.add(ev);
      if (filterByEvent && !/impression/i.test(ev)) continue;
      const day = (r[dateIdx] || '').trim().slice(0, 10);
      const v = parseFloat(r[valIdx]);
      if (!day || Number.isNaN(v)) continue;
      byDay.set(day, (byDay.get(day) || 0) + v);
    }
    return byDay;
  };
  let byDay = sum(useEventFilter);
  // Safety net: if the event label is not what we expect, the filtered series is
  // empty while the unfiltered one is not. Always prefer a real (if slightly
  // over-counted) number over a fabricated zero, and say so in the log.
  let filteredByEvent = useEventFilter;
  if (useEventFilter && byDay.size === 0) {
    const unfiltered = sum(false);
    if (unfiltered.size > 0) {
      byDay = unfiltered;
      filteredByEvent = false;
      console.log('  note: no event matched /impression/i — using all rows; check the Event column values above');
    }
  }
  return {
    byDay,
    dateCol: rows[0][dateIdx].trim(),
    valueCol: rows[0][valIdx].trim(),
    events: [...events],
    filteredByEvent
  };
}

function sumWindow(byDay, dates) {
  return dates.reduce((acc, d) => acc + (byDay.get(d) || 0), 0);
}

function moM(current, previous) {
  if (!previous || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** 60-day window (oldest -> newest) ending at `latest` (inclusive). */
function windowEndingAt(latest) {
  const end = new Date(latest + 'T00:00:00Z');
  const dates = [];
  for (let i = 59; i >= 0; i--) {
    const d = new Date(end); d.setUTCDate(d.getUTCDate() - i);
    dates.push(dayKey(d));
  }
  return dates;
}

/**
 * Sum Units per Apple Identifier from a parsed Sales & Trends TSV.
 * Only app purchases count ("App 销量"): Product Type Identifiers starting
 * with "1" (1T paid / 1F free). Updates (7*) and other line items are
 * excluded — exactly what the ASC backend card shows.
 */
function unitsFromSalesRows(rows) {
  const out = new Map(); // appleId -> { units, title }
  if (!rows || rows.length === 0) return out;
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idIdx = header.findIndex(h => h.includes('apple identifier'));
  const unitsIdx = header.findIndex(h => h.includes('units'));
  const typeIdx = header.findIndex(h => h.includes('product type'));
  const titleIdx = header.findIndex(h => h.includes('title'));
  if (idIdx === -1 || unitsIdx === -1) {
    throw new Error('unexpected sales report header: ' + rows[0].join('|').slice(0, 200));
  }
  for (const r of rows.slice(1)) {
    const type = typeIdx !== -1 ? (r[typeIdx] || '').trim() : '1';
    if (!/^1/.test(type)) continue; // app units only; skip updates (7*) etc.
    const id = (r[idIdx] || '').trim();
    const u = parseFloat(r[unitsIdx]);
    if (!id || Number.isNaN(u)) continue;
    const rec = out.get(id) || { units: 0, title: titleIdx !== -1 ? r[titleIdx] : '' };
    rec.units += u;
    if (titleIdx !== -1 && r[titleIdx]) rec.title = r[titleIdx];
    out.set(id, rec);
  }
  return out;
}

/**
 * Which app a report row belongs to. TWO pitfalls live here:
 *  1. Rule order matters. The Freestyle app's App Store title is
 *     "Freestyle Dance Challenge", which ALSO contains "dance" — testing
 *     /dance/ first made BOTH apps resolve to "dancelog" (the raw table then
 *     showed two DanceLog rows and the trend chart collapsed to one series).
 *     The more specific rule must therefore come first.
 *  2. The title is a human string and may be renamed at any time, so the
 *     Apple-ID map is the fallback, never a guess from a partial keyword.
 */
const APP_KEY_BY_TITLE = [
  { key: 'freestyle', re: /freestyle|challenge/i }, // must precede dancelog
  { key: 'dancelog', re: /dance\s*log|dancelog/i }
];
const APP_KEY_BY_APPLE_ID = { '6796975099': 'freestyle', '6795164130': 'dancelog' };
/** Display names — kept in sync with the site so the table/legend branding is stable. */
const APP_LABEL = { freestyle: 'Freestyle Challenge', dancelog: 'DanceLog' };

function appKeyFor(appleId, titles = []) {
  // Apple ID first: for apps we track it is authoritative and cannot be renamed
  // by an App Store title edit. The title is only a clue for apps we have no ID
  // for, and it is checked against ALL rules (not just the first match) so a
  // title matching two rules is never silently filed under the wrong app.
  if (APP_KEY_BY_APPLE_ID[appleId]) return APP_KEY_BY_APPLE_ID[appleId];
  const name = titles.filter(Boolean).join(' ');
  const hits = APP_KEY_BY_TITLE.filter(rule => rule.re.test(name));
  if (hits.length > 1) console.log(`  WARNING: title "${name}" matches multiple apps (${hits.map(h => h.key).join(', ')}) — add ${appleId} to APP_KEY_BY_APPLE_ID`);
  return hits.length ? hits[0].key : ('app-' + appleId);
}

/**
 * Cross-check the App Store title against the label the site renders. A mismatch
 * means the two drifted (a renamed app, or an Apple ID mapped to the wrong key)
 * and familiar-looking numbers would be published under the wrong name.
 *
 * Compared word-by-word against the normalised title, because the store title is
 * allowed to be a superset: "Freestyle Dance Challenge" is a legitimate title for
 * the app we label "Freestyle Challenge", and that extra "Dance" is exactly what
 * made a naive keyword match file both apps under DanceLog.
 */
function titleAgreesWithKey(key, title) {
  const label = APP_LABEL[key];
  if (!label || !title) return true;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(title);
  return String(label).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).every((w) => t.includes(w));
}

/**
 * Resolve keys for all apps, guaranteeing uniqueness. Two apps sharing one key
 * is a silent data-loss bug downstream: the site keys the KPI cards, the raw
 * table AND the chart series off `key`, so a collision drops a series without
 * any error (that is exactly how the chart ended up with a single line).
 */
function uniqueAppKeys(entries) {
  const used = new Set();
  return entries.map(({ appleId, titles }) => {
    let key = appKeyFor(appleId, titles);
    if (used.has(key)) {
      const fallback = APP_KEY_BY_APPLE_ID[appleId] || ('app-' + appleId);
      console.log(`  WARNING: duplicate app key "${key}" for ${appleId} (titles: ${JSON.stringify(titles)})`);
      if (!used.has(fallback)) {
        key = fallback;
      } else {
        let n = 2;
        while (used.has(key + '-' + n)) n++;
        key = key + '-' + n;
      }
      console.log(`  WARNING: remapped ${appleId} to "${key}"`);
    }
    used.add(key);
    return key;
  });
}

/**
 * Chart payload, built from the app list instead of hardcoded key lookups.
 * (The old shape was { dates, dancelog: [...], freestyle: [...] }, so a key
 * remap or a third app silently produced null series.)
 */
function buildDailySeries(dates, apps) {
  const series = (apps || [])
    // An empty array is not a series — it would draw nothing and still take a
    // legend slot and a palette colour.
    .filter(a => Array.isArray(a.daily) && a.daily.length)
    .map(a => ({ key: a.key, name: a.name || APP_LABEL[a.key] || a.key, values: a.daily }));
  return series.length ? { dates, series } : null;
}

/**
 * Download one Sales & Trends DAILY report (returns parsed CSV rows),
 * or null when the report is not available for that date yet (Apple
 * generates daily sales reports with a ~1-2 day lag; days without any
 * sale may have no file at all).
 */
async function fetchSalesDaily(token, vendorNumber, date) {
  const qs = '/v1/salesReports?filter[reportType]=SALES&filter[reportSubType]=SUMMARY'
    + '&filter[frequency]=DAILY&filter[reportDate]=' + date
    + '&filter[vendorNumber]=' + encodeURIComponent(vendorNumber);
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(API + qs, { headers: { Authorization: 'Bearer ' + token } });
      break;
    } catch (err) {
      if (attempt < 3) { console.log(`  sales fetch failed (attempt ${attempt}), retrying...`); await sleep(attempt * 1000); }
      else throw new Error('salesReports fetch failed: ' + netCause(err));
    }
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error('salesReports 403 (check: Paid Applications agreement accepted; API key has Finance/Admin role) :: ' + text.slice(0, 200));
    }
    throw new Error('ASC ' + res.status + ' salesReports ' + date + ' :: ' + text.slice(0, 200));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  const text = isGzip ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return parseCsv(text);
}

/**
 * Sales & Trends downloads: returns { latest, byApp } where byApp maps
 * appleId -> { byDay: Map(day -> units), title } over the 60-day window
 * ending at the latest available report date (same ending date as the
 * "App 销量" card in the ASC backend).
 */
async function fetchSalesUnits(token, vendorNumber) {
  let latest = null;
  for (let i = 1; i <= 10 && !latest; i++) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    const date = dayKey(d);
    try {
      if (await fetchSalesDaily(token, vendorNumber, date)) latest = date;
    } catch (err) {
      if (String(err.message).includes('403')) throw err;
      console.log('  sales scan ' + date + ': ' + err.message.slice(0, 120));
    }
  }
  if (!latest) return null;
  console.log('  sales: latest available DAILY report = ' + latest);
  const dates = windowEndingAt(latest);
  const byApp = new Map();
  for (const date of dates) {
    let csv;
    try { csv = await fetchSalesDaily(token, vendorNumber, date); }
    catch (err) { console.log('  sales ' + date + ': ' + err.message.slice(0, 160)); continue; }
    if (!csv) continue; // no file that day == no units that day
    let units;
    try { units = unitsFromSalesRows(csv); }
    catch (err) { console.log('  sales ' + date + ': ' + err.message); continue; }
    for (const [appId, rec] of units) {
      if (!APP_IDS.includes(appId)) continue;
      const entry = byApp.get(appId) || { byDay: new Map(), title: rec.title };
      entry.byDay.set(date, (entry.byDay.get(date) || 0) + rec.units);
      if (rec.title) entry.title = rec.title;
      byApp.set(appId, entry);
    }
  }
  for (const [appId, entry] of byApp) {
    const cur = sumWindow(entry.byDay, dates.slice(30));
    console.log('  sales app ' + appId + ' (' + entry.title + '): last-30d units = ' + cur);
  }
  return { latest, dates, byApp };
}

async function main() {
  if (process.argv.includes('--selftest')) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const token = signJwt(pem);
    const [, , sigB64] = token.split('.');
    const ok = crypto.verify('SHA256', Buffer.from(token.split('.').slice(0, 2).join('.')),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64url'));
    console.log(ok ? 'SELFTEST PASS: ES256 JWT signing/verification works.' : 'SELFTEST FAIL');
    process.exit(ok ? 0 : 1);
  }

  for (const v of ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY']) {
    if (!process.env[v]) { console.error('Missing env: ' + v); process.exit(1); }
  }

  const token = signJwt(loadPrivateKey());
  const vendorNumber = (process.env.ASC_VENDOR_NUMBER || '').trim();

  // Downloads from Sales & Trends (the SAME source as the ASC "App 销量"
  // card) whenever a vendor number is configured; the window ends at the
  // latest available daily report so the dates match the backend card.
  // Analytics "App Downloads" uses a different metric definition and does
  // NOT match the backend (observed 4 vs 26 for the same period).
  const sales = vendorNumber ? await fetchSalesUnits(token, vendorNumber) : null;
  if (vendorNumber && !sales) {
    console.log('  ASC_VENDOR_NUMBER set but no sales reports found — falling back to Analytics "App Downloads".');
  }
  if (!vendorNumber) {
    console.log('  ASC_VENDOR_NUMBER not set — using Analytics "App Downloads" (does NOT match the ASC backend "App 销量" card).');
  }

  const dates = sales ? sales.dates : buildWindow();
  // dates is built oldest -> newest, so the CURRENT window is the LAST 30
  // entries (most recent 30 days); the first 30 are the previous window.
  const current = dates.slice(WINDOW);
  const previous = dates.slice(0, WINDOW);

  const appResults = [];
  for (const appId of APP_IDS) {
    console.log('App ' + appId + ':');
    try {
      let downloads;
      if (sales) {
        const entry = sales.byApp.get(appId);
        downloads = {
          reportName: 'Sales & Trends DAILY (App units)',
          byDay: entry ? entry.byDay : new Map(),
          appNames: entry && entry.title ? [entry.title] : []
        };
      } else {
        downloads = await fetchSeries(token, appId, [/download/i, /units/i, /^app downloads/i], 'downloads');
      }
      // Impressions live inside "App Store Discovery and Engagement Standard" — the
      // report NAME does not contain "impression", so we match by report name, not by metric.
      const impressions = await fetchSeries(token, appId, [/app store discovery and engagement standard/i, /app store discovery and engagement/i], 'impressions');
      appResults.push({ appId, downloads, impressions });
    } catch (err) {
      console.log('  ERROR: ' + err.message);
    }
  }

  // Key resolution is collision-checked: a shared key silently drops a chart
  // series and mislabels a raw-table row (see uniqueAppKeys).
  const entries = appResults.map(({ appId, downloads, impressions }) => ({
    appleId: appId,
    titles: (downloads && downloads.appNames) || (impressions && impressions.appNames) || [],
    downloads,
    impressions
  }));
  const keys = uniqueAppKeys(entries);

  // Absolute totals are accumulated here (single pass) instead of being
  // re-derived from a filtered array — the previous `apps.indexOf(a)` lookup
  // was both O(n²) and easy to get wrong.
  let totalCur = 0, totalPrev = 0, totalImpCur = 0;
  const apps = entries.map((e, i) => {
    const key = keys[i];
    const curD = e.downloads ? sumWindow(e.downloads.byDay, current) : null;
    const prevD = e.downloads ? sumWindow(e.downloads.byDay, previous) : null;
    const curI = e.impressions ? sumWindow(e.impressions.byDay, current) : null;
    if (typeof curD === 'number') { totalCur += curD; totalPrev += prevD || 0; }
    if (typeof curI === 'number') { totalImpCur += curI; }
    return {
      key,
      // Branding stays consistent with the rest of the site; the report title
      // is only used for apps we have no label for.
      name: APP_LABEL[key] || e.titles[0] || key,
      appleId: e.appleId,
      downloadsMoMPct: typeof curD === 'number' ? moM(curD, prevD) : null,
      sharePct: null,
      downloads30d: curD,
      impressions30d: curI,
      daily: e.downloads ? current.map(d => e.downloads.byDay.get(d) || 0) : null
    };
  });
  for (const a of apps) {
    if (totalCur > 0 && typeof a.downloads30d === 'number') a.sharePct = Math.round((a.downloads30d / totalCur) * 100);
  }

  // Coverage diagnostics. "0 downloads" and "the report file is missing for
  // those days" look identical on the site, so print the distinction: a 30-day
  // window backed by only a handful of rows is a data-collection problem, not a
  // product signal, and should be visible in the workflow log.
  apps.forEach((a, i) => {
    const daysWithData = Array.isArray(a.daily) ? a.daily.filter(v => v > 0).length : 0;
    // Drift guard: if the store title no longer matches the label we render, the
    // numbers would be published under a name the reader associates with another
    // app. Warn instead of failing silently (entries/apps share their order).
    const storeTitle = (entries[i] && entries[i].titles && entries[i].titles[0]) || '';
    if (storeTitle && !titleAgreesWithKey(a.key, storeTitle)) {
      console.log(`  WARNING: store title "${storeTitle}" does not look like "${APP_LABEL[a.key] || a.key}" (appleId ${a.appleId}) — verify APP_KEY_BY_APPLE_ID`);
    }
    console.log(`  ${a.key} (${a.appleId}): downloads30d=${a.downloads30d} impressions30d=${a.impressions30d}`
      + ` — downloads seen on ${daysWithData}/${WINDOW} days`);
  });

  const metrics = {
    // With Sales & Trends the numbers are only complete up to the latest
    // available daily report — stamp that date so it matches the ASC card.
    updatedAt: sales ? sales.latest : dayKey(new Date()),
    source: sales ? 'sales-and-trends' : 'analytics-reports',
    windowDays: WINDOW,
    totals: {
      downloadsMoMPct: moM(totalCur, totalPrev),
      downloads30d: totalCur > 0 ? totalCur : null,
      impressions30d: totalImpCur > 0 ? totalImpCur : null
    },
    apps,
    // Built from the app list (never hardcoded keys) so a key remap or a third
    // app can no longer produce a null series / a silently missing line.
    daily: buildDailySeries(current, apps),
    impressions: totalImpCur > 0 ? { source: 'analytics-reports', total30d: totalImpCur } : null
  };

  const start = '/* ASC-METRICS:START';
  const end = 'ASC-METRICS:END */';
  const html = fs.readFileSync(INDEX, 'utf8');
  const s = html.indexOf(start);
  const e = html.indexOf(end);
  if (s === -1 || e === -1) { console.error('ASC-METRICS markers not found in index.html'); process.exit(1); }
  const block = start + ' (auto-updated by GitHub Action — do not edit by hand) */\n'
    + '      const ASC_METRICS = ' + JSON.stringify(metrics, null, 8).replace(/\n/g, '\n      ') + ';\n'
    // The closing marker MUST be wrapped in its own comment — a bare "ASC-METRICS:END */"
    // is parsed as JS (ASC - METRICS : END) and throws SyntaxError, killing the whole script.
    + '      /* ' + end;
  fs.writeFileSync(INDEX, html.slice(0, s) + block + html.slice(e + end.length));
  console.log('index.html ASC-METRICS block updated: ' + JSON.stringify(metrics.totals) + ' apps=' + apps.length);
}

// Only run when executed directly (node scripts/update-metrics.mjs); when
// imported (e.g. by tests) just expose the pure helpers.
export {
  parseCsv, sumWindow, buildWindow, moM, windowEndingAt, unitsFromSalesRows,
  appKeyFor, uniqueAppKeys, buildDailySeries, seriesFromAnalyticsRows, main
};
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error('FATAL: ' + err.message); process.exit(1); });
}
