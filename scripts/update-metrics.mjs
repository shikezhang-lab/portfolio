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
 *   ASC_APP_IDS      – comma-separated Apple IDs (default: 6796975099,6795164130)
 *
 * Run `node scripts/update-metrics.mjs --selftest` to verify JWT signing
 * with a locally generated key (no network, no secrets needed).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const out = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
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
  const request = list[0];
  const reports = await api(token, `/v1/analyticsReportRequests/${request.id}/reports?pageSize=200`);
  const names = (reports.data || []).map(r => r.attributes.name);
  console.log(`  app ${appId} reports: [${names.join(' | ')}]`);
  for (const matcher of reportMatchers) {
    const report = (reports.data || []).find(r => matcher.test(r.attributes.name));
    if (!report) continue;
    const instances = await api(token, `/v1/analyticsReports/${report.id}/instances?pageSize=25`);
    const instance = (instances.data || []).find(i => i.attributes.granularity === 'DAILY') || (instances.data || [])[0];
    if (!instance) continue;
    const segments = await api(token, `/v1/analyticsReportInstances/${instance.id}/segments?pageSize=100`);
    const rows = [];
    for (const seg of (segments.data || [])) {
      const url = seg.attributes && (seg.attributes.url || seg.attributes.downloadUrl);
      if (!url) continue;
      const res = await fetch(url);
      if (!res.ok) { console.log(`  segment download failed (${res.status}), skipping`); continue; }
      rows.push(...parseCsv(await res.text()));
    }
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
  return null;
}

function sumWindow(byDay, dates) {
  return dates.reduce((acc, d) => acc + (byDay.get(d) || 0), 0);
}

function moM(current, previous) {
  if (!previous || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
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
  const dates = buildWindow();
  const current = dates.slice(0, WINDOW);
  const previous = dates.slice(WINDOW);

  const appResults = [];
  for (const appId of APP_IDS) {
    console.log('App ' + appId + ':');
    try {
      const downloads = await fetchSeries(token, appId, [/download/i, /units/i, /^app downloads/i]);
      const impressions = await fetchSeries(token, appId, [/impression/i]);
      appResults.push({ appId, downloads, impressions });
    } catch (err) {
      console.log('  ERROR: ' + err.message);
    }
  }

  const nameFor = { '6796975099': 'freestyle', '6795164130': 'dancelog' };
  const apps = appResults.map(({ appId, downloads, impressions }) => {
    const curD = downloads ? sumWindow(downloads.byDay, current) : null;
    const prevD = downloads ? sumWindow(downloads.byDay, previous) : null;
    const curI = impressions ? sumWindow(impressions.byDay, current) : null;
    return {
      key: nameFor[appId] || ('app-' + appId),
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
    updatedAt: dayKey(new Date()),
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
    + '      ' + end;
  fs.writeFileSync(INDEX, html.slice(0, s) + block + html.slice(e + end.length));
  console.log('index.html ASC-METRICS block updated: ' + JSON.stringify(metrics.totals) + ' apps=' + apps.length);
}

main().catch((err) => { console.error('FATAL: ' + err.message); process.exit(1); });
