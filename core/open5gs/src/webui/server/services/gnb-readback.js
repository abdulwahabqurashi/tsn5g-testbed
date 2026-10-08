/*
 * gNB read-back
 *
 * Answers "what did the radio ACTUALLY receive?" — as opposed to what is in
 * MongoDB. Configured and in-force are different things, and until now the
 * console could not tell them apart.
 *
 * Everything is parsed from the gNB log. There is no per-UE API: the AMF and
 * SMF expose Prometheus counters only, and all of them are aggregate.
 * (/UeInfo, /GnbInfo and /PduInfo do not exist — they return HTTP 400.)
 *
 * Two constraints shape this:
 *   - gnb.log is TRUNCATED at every gNB start, and the interesting lines are
 *     emitted only at session establishment. So the last-seen values are
 *     cached in memory with a timestamp rather than re-read on demand.
 *   - The file can reach tens of GB with mac_level: debug, so only the tail
 *     is ever read.
 */
const fs = require('fs');

const GNB_CFG = process.env.GNB_CONFIG ||
    '/home/tsn_server/tsntestbed/gnb_x410.yaml';
const TAIL_BYTES = parseInt(process.env.GNB_TAIL_BYTES || '4000000', 10);
const POLL_MS = parseInt(process.env.GNB_READBACK_INTERVAL || '5000', 10);

var timer = null;
var snapshot = {
  captured_at: null,
  log_path: null,
  mac_debug: false,      /* per-LCG queue depth needs mac_level: debug */
  flows: {},             /* qfi -> { five_qi, gbr_ul, gbr_dl, mbr_ul, mbr_dl } */
  drbs: {},              /* drb -> { rlc_mode, priority, pbr, lcg } */
  queue: {}              /* lcg -> bytes (latest BSR) */
};

/* The log path is configured, never hardcoded — gnb-qos.js reads GNB_CFG the
 * same way. */
function logPath() {
  try {
    const yaml = fs.readFileSync(GNB_CFG, 'utf8');
    const m = yaml.match(/^\s*filename:\s*(\S+)\s*$/m);
    if (m) return m[1];
  } catch (e) { /* fall through */ }
  return '/home/tsn_server/tsntestbed/gnb.log';
}

function macDebug() {
  try {
    const yaml = fs.readFileSync(GNB_CFG, 'utf8');
    const m = yaml.match(/^\s*mac_level:\s*(\w+)/m);
    return !!(m && m[1] === 'debug');
  } catch (e) { return false; }
}

function readTail(p) {
  try {
    const st = fs.statSync(p);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const fd = fs.openSync(p, 'r');
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (e) { return ''; }
}

/* Stream the whole file once at startup.
 *
 * The config signals (QFI, 5QI, GBR, DRB, LC config) are emitted ONCE, at
 * session establishment — which may be hours before now and far outside the
 * tail. Reading only the tail finds nothing, which is exactly what happened
 * the first time. So seed from the whole file, then keep up via the tail.
 * Streamed line by line and size-capped so a multi-GB log cannot blow memory.
 */
const SEED_MAX = parseInt(process.env.GNB_SEED_MAX || '400000000', 10);
var seeded = false;

function seed() {
  const p = logPath();
  var st;
  try { st = fs.statSync(p); } catch (e) { return; }
  if (st.size > SEED_MAX) { seeded = true; return; }   /* too big: tail only */

  const rl = require('readline').createInterface({
    input: fs.createReadStream(p, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  var buf = '';
  var ctx = 0;
  /* A whole-file read of a multi-GB log cannot be held in memory, but neither
   * can lines be filtered individually: the DRB block is only parseable with
   * its intervening lines intact (the closing brace is what terminates the
   * mac-LogicalChannelConfig match). So a trigger line opens a window and the
   * next WINDOW lines are kept verbatim. */
  const TRIGGER = /qoSFlowIdentifier|fiveQI|FlowBitRate|drb-Identity|mac-LogicalChannelConfig|report=\{/;
  const WINDOW = 60;
  rl.on('line', function(l) {
    if (TRIGGER.test(l)) ctx = WINDOW;
    if (ctx > 0) {
      ctx--;
      buf += l + '\n';
      if (buf.length > 8000000) buf = buf.slice(-4000000);
    }
  });
  rl.on('close', function() {
    seeded = true;
    try { parseInto(buf); } catch (e) { /* ignore */ }
  });
  rl.on('error', function() { seeded = true; });
}

/* gnb.log is TRUNCATED every time the gNB restarts. The cached snapshot then
 * describes a session that no longer exists, and because parseInto() merges
 * rather than clobbers, those stale values would survive indefinitely. So
 * watch the file size: a shrink means a restart, and everything learned from
 * the previous log must be dropped and re-seeded from the new one. */
var lastSize = -1;

function scan() {
  const p = logPath();
  var size = -1;
  try { size = fs.statSync(p).size; } catch (e) { return; }

  if (lastSize >= 0 && size < lastSize) {
    snapshot = { captured_at: null, log_path: p, mac_debug: macDebug(),
                 flows: {}, drbs: {}, queue: {} };
    seeded = false;
    lastSize = size;
    seed();                     /* re-seed from the fresh log */
    return;
  }
  lastSize = size;

  const text = readTail(p);
  if (!text) return;
  parseInto(text);
}

function parseInto(text) {
  const out = { flows: {}, drbs: {}, queue: {} };

  /* QoS flows. The ASN.1 dump nests fiveQI inside the flow's QoS profile, and
   * it is emitted BOTH before and after the qoSFlowIdentifier line, so a
   * positional pairing is wrong (it gave QFI 2 the 5QI of QFI 1). Pair each
   * QFI with the NEAREST fiveQI by byte offset instead, which is correct for
   * any ordering of the two within a block. */
  var re = /"qoSFlowIdentifier":\s*(\d+)/g, m;
  const qfis = [], qfiAt = [];
  while ((m = re.exec(text)) !== null) {
    qfis.push(parseInt(m[1], 10));
    qfiAt.push(m.index);
  }
  qfis.forEach(function(q) { out.flows[q] = out.flows[q] || { qfi: q }; });

  re = /"fiveQI":\s*(\d+)/g;
  const fq = [];
  while ((m = re.exec(text)) !== null) fq.push({ v: parseInt(m[1], 10), at: m.index });

  qfis.forEach(function(q, i) {
    var best = null, bestD = Infinity;
    fq.forEach(function(f) {
      const d = Math.abs(f.at - qfiAt[i]);
      if (d < bestD) { bestD = d; best = f.v; }
    });
    if (best !== null) out.flows[q].five_qi = best;
  });

  ['guaranteedFlowBitRateUplink', 'guaranteedFlowBitRateDownlink',
   'maxFlowBitRateUplink', 'maxFlowBitRateDownlink'].forEach(function(key) {
    const r = new RegExp('"?' + key + '"?:\\s*(\\d+)', 'g');
    var last = null, mm;
    while ((mm = r.exec(text)) !== null) last = parseInt(mm[1], 10);
    if (last !== null) {
      /* GBR belongs to the GBR flow; with one on this rig that is unambiguous.
       * Attach to the highest QFI, which is the non-default one. */
      const target = qfis.length ? Math.max.apply(null, qfis) : 2;
      out.flows[target] = out.flows[target] || { qfi: target };
      out.flows[target][key] = last;
    }
  });

  /* Per-DRB MAC logical channel config, decoded by the CU at cu_level: debug */
  re = /"drb-Identity":\s*(\d+)([\s\S]{0,1400}?)"mac-LogicalChannelConfig":\s*\{([\s\S]{0,400}?)\}/g;
  while ((m = re.exec(text)) !== null) {
    const drb = parseInt(m[1], 10);
    const mid = m[2], lc = m[3];
    const prio = /"priority":\s*(\d+)/.exec(lc);
    const pbr = /"prioritisedBitRate":\s*"([^"]+)"/.exec(lc);
    const lcg = /"logicalChannelGroup":\s*(\d+)/.exec(lc);
    const rlc = /"(am|um-Bi-Directional|um-Uni-Directional-UL|um-Uni-Directional-DL)"/.exec(mid);
    out.drbs[drb] = {
      drb: drb,
      priority: prio ? parseInt(prio[1], 10) : null,
      pbr: pbr ? pbr[1] : null,
      lcg: lcg ? parseInt(lcg[1], 10) : null,
      rlc_mode: rlc ? rlc[1] : null
    };
  }

  /* Latest buffer-status report per logical channel group. This is the live
   * queue depth, and the single most diagnostic number on the page: a bearer
   * configured but never carrying data shows up here and nowhere else. */
  re = /report=\{(\d+):\s*(\d+)\}/g;
  while ((m = re.exec(text)) !== null) {
    out.queue[parseInt(m[1], 10)] = parseInt(m[2], 10);
  }
  re = /report=\{([^}]*)\}/g;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    if (body.indexOf(':') !== -1) continue;        /* short form, done above */
    const parts = body.split(',').map(function(s) { return s.trim(); });
    if (parts.length !== 8) continue;
    parts.forEach(function(v, i) {
      if (v !== '-' && v !== '0') out.queue[i] = parseInt(v, 10);
      else if (v === '0' && out.queue[i] === undefined) out.queue[i] = 0;
    });
  }

  /* Merge, never clobber. A tail scan that happens to contain no establishment
   * lines must not wipe config we already found — those lines appear once per
   * session and are not repeated. */
  const keep = function(prev, next) {
    const m = {};
    Object.keys(prev || {}).forEach(function(k) { m[k] = prev[k]; });
    Object.keys(next || {}).forEach(function(k) {
      m[k] = Object.assign({}, m[k] || {}, next[k]);
    });
    return m;
  };

  snapshot = {
    captured_at: new Date(),
    log_path: logPath(),
    mac_debug: macDebug(),
    flows: keep(snapshot.flows, out.flows),
    drbs: keep(snapshot.drbs, out.drbs),
    queue: Object.keys(out.queue).length ? out.queue : snapshot.queue
  };
}

function start() {
  if (timer) return;
  try { seed(); } catch (e) { seeded = true; }
  timer = setInterval(function() {
    if (!seeded) return;                 /* let the seed finish first */
    try { scan(); } catch (e) { /* never let a parse error kill the timer */ }
  }, POLL_MS);
  console.log('[gnb-readback] reading ' + logPath() + ' every ' + POLL_MS + ' ms');
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }
function get() { return snapshot; }

module.exports = { start: start, stop: stop, get: get };
