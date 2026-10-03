/*
 * Report generation from the TSN metric history.
 * Produces CSV (raw rows) and a self-contained printable HTML report
 * (print-to-PDF ready). No external PDF dependency.
 */
const fs = require('fs');
const path = require('path');
const TsnMetricRollup = require('../models/tsn-metric-rollup');
const TsnMetric = require('../models/tsn-metric');
const AlertEvent = require('../models/alert-config').AlertEvent;

const REPORT_DIR = process.env.REPORT_DIR ||
    path.join(__dirname, '../../../build/reports');

function ensureDir() {
  try { fs.mkdirSync(REPORT_DIR, { recursive: true }); } catch (e) {}
}

const RANGE_MS = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };

/* returns { rows, alerts, meta } for a range */
async function gather(range) {
  const ms = RANGE_MS[range] || RANGE_MS['24h'];
  const since = new Date(Date.now() - ms);
  let rows;
  if (range === '24h') {
    const raw = await TsnMetric.find({ timestamp: { $gte: since } })
      .sort({ timestamp: 1 }).lean().exec();
    rows = raw.map(m => {
      const p = (m.ports || [])[0] || {};
      return { t: m.timestamp, port: p.port_number,
        jitter_us: (p.jitter_current_us != null ? p.jitter_current_us :
          (p.jitter_current_us)),
        rx_frames: p.rx_frames, tx_frames: p.tx_frames,
        rx_bytes: p.rx_bytes, tx_bytes: p.tx_bytes,
        psfp_dropped: p.psfp_dropped_frames, gptp_synced: m.gptp_synced };
    });
  } else {
    const b = await TsnMetricRollup.find({ bucket: { $gte: since } })
      .sort({ bucket: 1 }).lean().exec();
    rows = b.map(x => ({ t: x.bucket, port: x.port_number,
      jitter_us: x.jitter_avg_us, jitter_peak_us: x.jitter_peak_us,
      dl_mbps: x.dl_mbps_avg, ul_mbps: x.ul_mbps_avg,
      rx_frames: x.rx_frames, tx_frames: x.tx_frames,
      psfp_dropped: x.psfp_dropped_frames, gptp_synced_pct: x.gptp_synced_pct }));
  }
  const alerts = await AlertEvent.find({ ts: { $gte: since } })
    .sort({ ts: -1 }).limit(200).lean().exec();
  return { rows, alerts, meta: { range, since, generated: new Date() } };
}

function toCSV(data) {
  if (!data.rows.length) return 'timestamp,note\n,no data in range\n';
  const cols = Object.keys(data.rows[0]);
  const head = cols.join(',');
  const body = data.rows.map(r => cols.map(c => {
    const v = r[c];
    return v instanceof Date ? v.toISOString() : (v == null ? '' : v);
  }).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

function stat(rows, key) {
  const v = rows.map(r => r[key]).filter(x => x != null && !isNaN(x));
  if (!v.length) return { avg: '--', max: '--', min: '--' };
  const sum = v.reduce((a, b) => a + b, 0);
  return { avg: (sum / v.length).toFixed(1), max: Math.max.apply(null, v).toFixed(1),
    min: Math.min.apply(null, v).toFixed(1) };
}

function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g,
  c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function toHTML(data) {
  const jit = stat(data.rows, 'jitter_us');
  const dl = stat(data.rows, 'dl_mbps');
  const ul = stat(data.rows, 'ul_mbps');
  const totalRx = data.rows.length ? (data.rows[data.rows.length - 1].rx_frames || 0) : 0;
  const totalTx = data.rows.length ? (data.rows[data.rows.length - 1].tx_frames || 0) : 0;
  const alertRows = data.alerts.slice(0, 40).map(a =>
    `<tr><td>${new Date(a.ts).toLocaleString()}</td><td>${esc(a.name)}</td>` +
    `<td class="sev-${esc(a.severity)}">${esc(a.severity)}</td><td>${esc(a.state)}</td>` +
    `<td>${a.value} vs ${a.threshold}</td></tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>AMRC 5G-TSN Report — ${esc(data.meta.range)}</title>
<style>
 body{font-family:Inter,system-ui,Arial,sans-serif;color:#1d2126;margin:0;padding:32px;background:#fff}
 h1{font-size:22px;margin:0 0 4px} .sub{color:#85898f;font-size:13px;margin-bottom:24px}
 .brand{display:inline-block;width:34px;height:34px;border-radius:8px;background:#0a2540;color:#fff;
   text-align:center;line-height:34px;font-weight:800;margin-right:10px;vertical-align:middle}
 .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0}
 .kpi{border:1px solid #e8eaed;border-radius:12px;padding:14px 16px}
 .kpi .v{font-size:24px;font-weight:800} .kpi .l{font-size:11px;text-transform:uppercase;
   letter-spacing:.06em;color:#85898f;margin-top:2px}
 h2{font-size:15px;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.05em;color:#50565e}
 table{width:100%;border-collapse:collapse;font-size:12.5px}
 th{text-align:left;color:#85898f;font-weight:600;border-bottom:2px solid #e8eaed;padding:6px 8px}
 td{padding:6px 8px;border-bottom:1px solid #f0f1f3}
 .sev-error{color:#f0383b;font-weight:700}.sev-warning{color:#f5a524;font-weight:700}
 .sev-info{color:#478ff7}
 @media print{body{padding:0}}
</style></head><body>
<h1><span class="brand">A</span>AMRC 5G-TSN Report</h1>
<div class="sub">Range: last ${esc(data.meta.range)} · generated ${data.meta.generated.toLocaleString()} · ${data.rows.length} samples</div>
<div class="kpis">
 <div class="kpi"><div class="v">${jit.avg} µs</div><div class="l">Avg jitter (peak ${jit.max})</div></div>
 <div class="kpi"><div class="v">${dl.avg}</div><div class="l">Avg DL Mbps (peak ${dl.max})</div></div>
 <div class="kpi"><div class="v">${ul.avg}</div><div class="l">Avg UL Mbps (peak ${ul.max})</div></div>
 <div class="kpi"><div class="v">${data.alerts.length}</div><div class="l">Alerts in period</div></div>
</div>
<h2>Traffic totals</h2>
<table><tr><th>RX frames (latest)</th><th>TX frames (latest)</th></tr>
<tr><td>${totalRx}</td><td>${totalTx}</td></tr></table>
<h2>Alert history (${data.alerts.length})</h2>
<table><thead><tr><th>Time</th><th>Rule</th><th>Severity</th><th>State</th><th>Value</th></tr></thead>
<tbody>${alertRows || '<tr><td colspan="5">No alerts in period.</td></tr>'}</tbody></table>
<p style="margin-top:32px;color:#85898f;font-size:11px">AMRC 5G-TSN core · TS 23.501 §5.27/5.28 logical bridge · print to PDF to archive.</p>
</body></html>`;
}

async function generate(range, format) {
  const data = await gather(range);
  return format === 'csv' ?
    { body: toCSV(data), mime: 'text/csv', ext: 'csv' } :
    { body: toHTML(data), mime: 'text/html', ext: 'html' };
}

/* daily scheduled report saved to disk */
async function generateScheduled() {
  ensureDir();
  try {
    const r = await generate('24h', 'html');
    const stamp = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(REPORT_DIR, 'daily-' + stamp + '.html'), r.body);
    const c = await generate('24h', 'csv');
    fs.writeFileSync(path.join(REPORT_DIR, 'daily-' + stamp + '.csv'), c.body);
  } catch (e) { /* skip */ }
}

function listReports() {
  ensureDir();
  try {
    return fs.readdirSync(REPORT_DIR)
      .filter(f => f.endsWith('.html') || f.endsWith('.csv'))
      .map(f => {
        const st = fs.statSync(path.join(REPORT_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}

function readReport(name) {
  if (!/^[\w.\-]+\.(html|csv)$/.test(name)) return null;
  try { return fs.readFileSync(path.join(REPORT_DIR, name)); }
  catch (e) { return null; }
}

module.exports = { generate, generateScheduled, listReports, readReport, REPORT_DIR };
