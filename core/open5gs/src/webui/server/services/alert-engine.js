/*
 * Server-side alert engine.
 * Evaluates configured rules against each collected TSN/UE snapshot and
 * delivers notifications to webhook/Slack/Teams channels on state
 * transitions (fire once when a rule goes firing, once when it resolves).
 * Runs regardless of whether any browser is open.
 */
const http = require('http');
const https = require('https');
const url = require('url');
const AlertConfig = require('../models/alert-config');
const AlertEvent = AlertConfig.AlertEvent;

/* transient per-rule state: { firing, since } keyed by rule_id */
const ruleState = {};

const DEFAULT_RULES = [
  { rule_id: 'jitter-high', name: 'High Jitter', metric: 'nwtt.jitter_current_us', operator: '>', threshold: 1000, severity: 'warning', enabled: true, for_seconds: 30 },
  { rule_id: 'psfp-drop', name: 'PSFP Drop Rate', metric: 'nwtt.psfp_drop_pct', operator: '>', threshold: 5, severity: 'error', enabled: true, for_seconds: 0 },
  { rule_id: 'ue-drop', name: 'No Connected UEs', metric: 'ue.connected_count', operator: '<', threshold: 1, severity: 'warning', enabled: false, for_seconds: 60 },
  { rule_id: 'mbr-policed', name: 'AMBR Policing Active', metric: 'nwtt.mbr_dropped_frames', operator: '>', threshold: 0, severity: 'info', enabled: false, for_seconds: 0 }
];

const SEV_RANK = { info: 1, warning: 2, error: 3 };

async function getConfig() {
  let cfg = await AlertConfig.findOne({ singleton: 'config' });
  if (!cfg) {
    cfg = await AlertConfig.create({ singleton: 'config',
      channels: [], rules: DEFAULT_RULES });
  }
  return cfg;
}

function post(target, payload) {
  return new Promise((resolve) => {
    let u;
    try { u = url.parse(target); } catch (e) { return resolve(false); }
    const body = Buffer.from(JSON.stringify(payload));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
    }, (res) => { res.resume(); resolve(res.statusCode < 400); });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.write(body); req.end();
  });
}

/* format the alert for each channel flavour */
function render(type, ev) {
  const emoji = ev.severity === 'error' ? '🔴' :
                ev.severity === 'warning' ? '🟠' : '🔵';
  const verb = ev.state === 'firing' ? 'FIRING' : 'RESOLVED';
  const text = `${emoji} [${verb}] ${ev.name} — ${ev.metric} = ${ev.value} ` +
    `(threshold ${ev.threshold}) · AMRC 5G-TSN`;
  if (type === 'slack') return { text };
  if (type === 'teams') return {
    '@type': 'MessageCard', '@context': 'http://schema.org/extensions',
    summary: ev.name, themeColor: ev.severity === 'error' ? 'f0383b' :
      ev.severity === 'warning' ? 'f5a524' : '478ff7',
    title: `${verb}: ${ev.name}`, text };
  return { alert: ev, text };            /* generic webhook */
}

async function deliver(cfg, ev) {
  const delivered = [];
  for (const ch of (cfg.channels || [])) {
    if (!ch.enabled || !ch.url) continue;
    if (SEV_RANK[ev.severity] < SEV_RANK[ch.min_severity || 'warning']) continue;
    const ok = await post(ch.url, render(ch.type, ev));
    if (ok) delivered.push(ch.name || ch.type);
  }
  return delivered;
}

function cmp(op, a, b) {
  switch (op) {
    case '>': return a > b;   case '<': return a < b;
    case '>=': return a >= b; case '<=': return a <= b;
    case '==': return a === b;
    default: return false;
  }
}

/* pull the metric value from a normalized snapshot */
function metricValue(metric, snap) {
  const p = (snap.nwtt && snap.nwtt.ports && snap.nwtt.ports[0]) || {};
  const t = p.traffic || {};
  const psfp = p.psfp || {};
  const jit = p.jitter || {};
  const rt = p.residence_time || {};
  switch (metric) {
    case 'nwtt.jitter_current_us': return jit.current_us;
    case 'nwtt.residence_avg_us': return rt.avg_us;
    case 'nwtt.mbr_dropped_frames': return t.mbr_dropped_frames;
    case 'nwtt.psfp_drop_pct': {
      const tot = (psfp.passed_frames || 0) + (psfp.dropped_frames || 0);
      return tot ? (psfp.dropped_frames || 0) / tot * 100 : 0;
    }
    case 'ue.connected_count': return snap.ue_connected;
    default: return undefined;
  }
}

/* called by the collector on each snapshot */
async function evaluate(snap) {
  let cfg;
  try { cfg = await getConfig(); } catch (e) { return; }
  const now = Date.now();

  for (const rule of (cfg.rules || [])) {
    if (!rule.enabled) continue;
    const v = metricValue(rule.metric, snap);
    if (v == null || isNaN(v)) continue;

    const breach = cmp(rule.operator, v, rule.threshold);
    const st = ruleState[rule.rule_id] || (ruleState[rule.rule_id] = { firing: false, since: null });

    if (breach) {
      if (!st.since) st.since = now;
      const heldFor = (now - st.since) / 1000;
      if (!st.firing && heldFor >= (rule.for_seconds || 0)) {
        st.firing = true;
        await fire(cfg, rule, v, 'firing');
      }
    } else {
      st.since = null;
      if (st.firing) {
        st.firing = false;
        await fire(cfg, rule, v, 'resolved');
      }
    }
  }
}

async function fire(cfg, rule, value, state) {
  const ev = {
    rule_id: rule.rule_id, name: rule.name, severity: rule.severity,
    metric: rule.metric, value: +(+value).toFixed(2), threshold: rule.threshold,
    state
  };
  const delivered = await deliver(cfg, ev);
  try { await AlertEvent.create(Object.assign({}, ev, { delivered })); }
  catch (e) { /* ignore */ }
}

module.exports = { evaluate, getConfig, deliver, DEFAULT_RULES };
