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
const INDEX = path.join(ROOT, 'index.html');

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
async function fetchSeries(token, appId, reportMatchers) {
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
        if (requests && requests.data && requests.data.length) { list = requests.data; break; }
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
        if (isGzip) console.log('  decoded gzip segment, header: ' + text.split('\n')[0].slice(0, 70));
        rows.push(...parseCsv(text));
      }
      console.log(`  report "${report.attributes.name}": ${segments.data ? segments.data.length : 0} segment(s), ${rows.length} CSV row(s)`);
      if (rows.length === 0) continue;
      const header = rows[0].map(h => h.trim().toLowerCase());
      const dateIdx = header.findIndex(h => h.includes('date'));
      const valIdx = header.findIndex(h => h.includes('count') || h.includes('downloads') || h.includes('units') || h.includes('impressions') || h.includes('views'));
      if (dateIdx === -1 || valIdx === -1) { console.log(`  unexpected CSV header: ${rows[0].join(',')}`); continue; }
      const byDay = new Map();
      for (const r of rows.slice(1)) {
        const day = (r[dateIdx] || '').slice(0, 10);
        const v = parseFloat(r[valIdx]);
        if (!day || Number.isNaN(v)) continue;
        byDay.set(day, (byDay.get(day) || 0) + v);
      }
      return { reportName: report.attributes.name, byDay };
    }
  }
  return null;
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
        downloads = await fetchSeries(token, appId, [/download/i, /units/i, /^app downloads/i]);
      }
      // Impressions live inside "App Store Discovery and Engagement Standard" — the
      // report NAME does not contain "impression", so we match by report name, not by metric.
      const impressions = await fetchSeries(token, appId, [/app store discovery and engagement standard/i, /app store discovery and engagement/i]);
      appResults.push({ appId, downloads, impressions });
    } catch (err) {
      console.log('  ERROR: ' + err.message);
    }
  }

  const fallbackFor = { '6796975099': 'freestyle', '6795164130': 'dancelog' };
  // Prefer the real App Name reported inside the CSV over any hardcoded guess.
  const keyFor = (appId, csvNames) => {
    const n = (csvNames || []).join(' ').toLowerCase();
    if (/dance/.test(n)) return 'dancelog';
    if (/free|challenge/.test(n)) return 'freestyle';
    return fallbackFor[appId] || ('app-' + appId);
  };
  const apps = appResults.map(({ appId, downloads, impressions }) => {
    const csvNames = (downloads && downloads.appNames) || (impressions && impressions.appNames) || [];
    const curD = downloads ? sumWindow(downloads.byDay, current) : null;
    const prevD = downloads ? sumWindow(downloads.byDay, previous) : null;
    const curI = impressions ? sumWindow(impressions.byDay, current) : null;
    return {
      key: keyFor(appId, csvNames),
      appleId: appId,
      downloadsMoMPct: downloads ? moM(curD, prevD) : null,
      sharePct: null,
      downloads30d: curD,
      impressions30d: curI,
      daily: downloads ? current.map(d => downloads.byDay.get(d) || 0) : null
    };
  });

  const withD = apps.filter(a => typeof a.downloads30d === 'number');
  const totalCur = withD.reduce((s, a) => s + a.downloads30d, 0);
  const totalPrev = withD.reduce((s, a) => s + (sumWindow(appResults[apps.indexOf(a)].downloads?.byDay || new Map(), previous)), 0);
  for (const a of apps) {
    if (totalCur > 0 && typeof a.downloads30d === 'number') a.sharePct = Math.round((a.downloads30d / totalCur) * 100);
  }

  // Absolute totals (retained for honest on-site disclosure — not just MoM %).
  const withI = apps.filter(a => typeof a.impressions30d === 'number');
  const totalImpCur = withI.reduce((s, a) => s + a.impressions30d, 0);

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
    daily: withD.length ? { dates: current, dancelog: (apps.find(a => a.key === 'dancelog') || {}).daily || null, freestyle: (apps.find(a => a.key === 'freestyle') || {}).daily || null } : null,
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
export { parseCsv, sumWindow, buildWindow, moM, windowEndingAt, unitsFromSalesRows };
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error('FATAL: ' + err.message); process.exit(1); });
}
