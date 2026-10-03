const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const router = express.Router();

/* ============================================================
 * /api/gnb-qos — gNB 5QI radio-bearer profile management
 *
 * The gNB (srsRAN) carries a `qos:` block in gnb_x410.yaml that tunes RLC and
 * PDCP PER 5QI. What it does NOT set is the 5QI's characteristics - priority,
 * Packet Delay Budget and Packet Error Rate are FIXED by 3GPP TS 23.501
 * Table 5.7.4-1 and compiled into srsRAN (lib/ran/qos/five_qi_qos_mapping.cpp).
 * This route therefore does two distinct things:
 *   - serves the standardised catalogue (read-only, authoritative, 3GPP)
 *   - reads/writes the per-5QI bearer tuning (editable, ours)
 *
 * Safety: the qos block is REGENERATED wholesale from structured input rather
 * than edited in place, then validated with `gnb --dryrun` on a temp copy
 * BEFORE the real file is touched. A bad profile can therefore never leave the
 * gNB unable to start. Every write keeps a timestamped backup.
 * ============================================================ */

const GNB_CFG = process.env.GNB_CONFIG ||
    '/home/tsn_server/tsntestbed/gnb_x410.yaml';
const GNB_BIN = process.env.GNB_BIN ||
    '/home/tsn_server/srsRAN_Project/build/apps/gnb/gnb';

const BEGIN = '# >>> BEGIN managed QoS profiles (webui) >>>';
const END   = '# <<< END managed QoS profiles (webui) <<<';

/* 3GPP TS 23.501 Table 5.7.4-1, cross-checked against srsRAN's compiled table
 * in lib/ran/qos/five_qi_qos_mapping.cpp. pdb = ms, prio = 5QI priority level.
 * `mdbv` = Maximum Data Burst Volume (bytes), delay-critical GBR only. */
const CATALOG = [
  { five_qi: 1,  type: 'GBR',                prio: 20, pdb: 100,  per: '1e-2',  example: 'Conversational voice' },
  { five_qi: 2,  type: 'GBR',                prio: 40, pdb: 150,  per: '1e-3',  example: 'Conversational video' },
  { five_qi: 3,  type: 'GBR',                prio: 30, pdb: 50,   per: '1e-3',  example: 'Real-time gaming, V2X' },
  { five_qi: 4,  type: 'GBR',                prio: 50, pdb: 300,  per: '1e-6',  example: 'Non-conversational video' },
  { five_qi: 65, type: 'GBR',                prio: 7,  pdb: 75,   per: '1e-2',  example: 'Mission-critical push-to-talk' },
  { five_qi: 66, type: 'GBR',                prio: 20, pdb: 100,  per: '1e-2',  example: 'Non-mission-critical PTT' },
  { five_qi: 67, type: 'GBR',                prio: 15, pdb: 100,  per: '1e-3',  example: 'Mission-critical video' },
  { five_qi: 5,  type: 'Non-GBR',            prio: 10, pdb: 100,  per: '1e-6',  example: 'IMS signalling' },
  { five_qi: 6,  type: 'Non-GBR',            prio: 60, pdb: 300,  per: '1e-6',  example: 'Buffered video, TCP bulk' },
  { five_qi: 7,  type: 'Non-GBR',            prio: 70, pdb: 100,  per: '1e-3',  example: 'Voice, live video' },
  { five_qi: 8,  type: 'Non-GBR',            prio: 80, pdb: 300,  per: '1e-6',  example: 'Buffered video' },
  { five_qi: 9,  type: 'Non-GBR',            prio: 90, pdb: 300,  per: '1e-6',  example: 'Default bearer, best effort' },
  { five_qi: 69, type: 'Non-GBR',            prio: 5,  pdb: 60,   per: '1e-6',  example: 'Mission-critical delay-sensitive signalling' },
  { five_qi: 70, type: 'Non-GBR',            prio: 55, pdb: 200,  per: '1e-6',  example: 'Mission-critical data' },
  { five_qi: 79, type: 'Non-GBR',            prio: 65, pdb: 50,   per: '1e-2',  example: 'V2X messages' },
  { five_qi: 80, type: 'Non-GBR',            prio: 68, pdb: 10,   per: '1e-6',  example: 'Low-latency eMBB, AR' },
  { five_qi: 82, type: 'Delay-critical GBR', prio: 19, pdb: 10,   per: '1e-4',  mdbv: 255,  example: 'Discrete automation' },
  { five_qi: 83, type: 'Delay-critical GBR', prio: 22, pdb: 10,   per: '1e-4',  mdbv: 1354, example: 'Discrete automation, V2X' },
  { five_qi: 84, type: 'Delay-critical GBR', prio: 24, pdb: 30,   per: '1e-5',  mdbv: 1354, example: 'Intelligent transport systems' },
  { five_qi: 85, type: 'Delay-critical GBR', prio: 21, pdb: 5,    per: '1e-5',  mdbv: 255,  example: 'Electricity distribution, high voltage' },
];

const byQi = {};
CATALOG.forEach((c) => { byQi[c.five_qi] = c; });

/* 3GPP-legal discrete timer sets. TS 38.322 (RLC) / TS 38.323 (PDCP).
 * Arbitrary integers are rejected by srsRAN, so the UI must only offer these. */
const T_REASSEMBLY = [0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100,110,120,130,140,150,160,170,180,190,200];
const T_POLL_RETX  = [5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100,105,110,115,120,125,130,135,140,145,150,155,160,165,170,175,180,185,190,195,200];
const T_STATUS_PROHIBIT = [0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100,105,110,115,120,125,130,135,140,145,150,155,160,165,170,175,180,185,190,195,200];
const PDCP_DISCARD = [-1,10,20,30,40,50,60,75,100,150,200,250,300,500,750,1500];
const PDCP_REORDER = [0,1,2,4,5,8,10,15,20,30,40,50,60,80,100,120,140,160,180,200,220,240,260,280,300,500,750,1000,1250,1500,1750,2000,2250,2500,2750,3000];
const MAX_RETX = [1,2,3,4,6,8,16,32];

/* Derive a 3GPP-consistent default bearer profile for a 5QI. The rule set:
 *   - discard_timer tracks the PDB (a PDU that cannot meet the budget is
 *     dropped rather than delivered late, TS 38.323 5.2.1)
 *   - PER <= 1e-4 needs ARQ, so RLC AM; looser PER can use UM for lower latency
 *   - reordering/reassembly bounded by the PDB
 *   - retransmission limit scales with the delay budget: no value in 32 retries
 *     inside a 10 ms budget */
function snap(v, set) {
  let best = set[0];
  set.forEach((s) => { if (s >= 0 && Math.abs(s - v) < Math.abs(best - v)) best = s; });
  return best;
}
function defaultsFor(fiveQi) {
  const c = byQi[fiveQi];
  if (!c) return null;
  const pdb = c.pdb;
  const strictPer = (c.per === '1e-5' || c.per === '1e-6');
  const mode = strictPer ? 'am' : (pdb <= 100 ? 'um-bidir' : 'am');
  const discard = pdb >= 1500 ? 1500 : snap(pdb, PDCP_DISCARD.filter((x) => x > 0));
  const reorder = snap(Math.min(pdb, 220), PDCP_REORDER);
  const reasm   = snap(Math.max(5, Math.min(pdb, 200)), T_REASSEMBLY);
  const poll    = snap(Math.max(5, Math.min(pdb, 200)), T_POLL_RETX);
  const prohib  = snap(Math.max(5, Math.min(Math.round(pdb / 2), 200)), T_STATUS_PROHIBIT);
  const retx    = pdb <= 20 ? 8 : (pdb <= 100 ? 16 : 32);
  return {
    five_qi: fiveQi, mode,
    pdcp: { discard_timer: discard, t_reordering: reorder },
    rlc: { t_poll_retransmit: poll, max_retx_threshold: retx,
           t_reassembly: reasm, t_status_prohibit: prohib }
  };
}

/* ---------- read current profiles out of gnb_x410.yaml ---------- */
function parseProfiles(text) {
  const out = [];
  if (!text) return out;
  const qi = /(?:^|\n)\s*five_qi:\s*(\d+)/g;
  let m;
  const idx = [];
  while ((m = qi.exec(text)) !== null) idx.push({ qi: parseInt(m[1], 10), at: m.index });
  idx.forEach((e, i) => {
    const block = text.slice(e.at, i + 1 < idx.length ? idx[i + 1].at : text.length);
    const g = (k) => { const mm = block.match(new RegExp('\\n\\s*' + k + ':\\s*(-?\\d+)')); return mm ? parseInt(mm[1], 10) : null; };
    const mode = (block.match(/\n\s*mode:\s*([a-z-]+)/) || [])[1] || null;
    out.push({
      five_qi: e.qi, mode,
      pdcp: { discard_timer: g('discard_timer'), t_reordering: g('t_reordering') },
      rlc: { t_poll_retransmit: g('t-poll-retransmit'), max_retx_threshold: g('max-retx-threshold'),
             t_reassembly: g('t-reassembly'), t_status_prohibit: g('t-status-prohibit') }
    });
  });
  return out;
}

/* ---------- render a qos block (hand-rolled; schema is fixed and ours) ---------- */
function renderProfiles(profiles) {
  const L = [];
  L.push(BEGIN);
  L.push('# Generated by the WebUI (gNB QoS Profiles). Edits between these markers');
  L.push('# are overwritten on save. 5QI characteristics (priority/PDB/PER) come from');
  L.push('# 3GPP TS 23.501 Table 5.7.4-1 and are NOT configurable here - only the RLC');
  L.push('# and PDCP bearer tuning used to meet them. Timer values are restricted to');
  L.push('# the discrete sets in TS 38.322 / TS 38.323.');
  L.push('qos:');
  profiles.forEach((p) => {
    const c = byQi[p.five_qi] || {};
    L.push('  -');
    L.push('    # 5QI ' + p.five_qi + ' - ' + (c.type || '?') + ', priority ' + (c.prio != null ? c.prio : '?') +
           ', PDB ' + (c.pdb != null ? c.pdb + ' ms' : '?') + ', PER ' + (c.per || '?') +
           (c.example ? ('  (' + c.example + ')') : ''));
    L.push('    five_qi: ' + p.five_qi);
    L.push('    pdcp:');
    L.push('      tx:');
    L.push('        sn: 18');
    L.push('        discard_timer: ' + p.pdcp.discard_timer);
    L.push('        status_report_required: false');
    L.push('      rx:');
    L.push('        sn: 18');
    L.push('        t_reordering: ' + p.pdcp.t_reordering);
    L.push('        out_of_order_delivery: false');
    L.push('    f1u_cu_up:');
    L.push('      backoff_timer: 10');
    L.push('    f1u_du:');
    L.push('      backoff_timer: 10');
    L.push('    rlc:');
    L.push('      mode: ' + p.mode);
    if (p.mode === 'am') {
      L.push('      am:');
      L.push('        tx:');
      L.push('          sn: 18');
      L.push('          t-poll-retransmit: ' + p.rlc.t_poll_retransmit);
      L.push('          max-retx-threshold: ' + p.rlc.max_retx_threshold);
      L.push('          poll-pdu: 16');
      L.push('          poll-byte: -1');
      L.push('          queue-size: 16384');
      L.push('          queue-bytes: 6172672');
      L.push('        rx:');
      L.push('          sn: 18');
      L.push('          t-reassembly: ' + p.rlc.t_reassembly);
      L.push('          t-status-prohibit: ' + p.rlc.t_status_prohibit);
    } else {
      L.push('      um-bidir:');
      L.push('        tx:');
      L.push('          sn: 12');
      L.push('          queue-size: 16384');
      L.push('          queue-bytes: 6172672');
      L.push('        rx:');
      L.push('          sn: 12');
      L.push('          t-reassembly: ' + p.rlc.t_reassembly);
    }
  });
  L.push(END);
  return L.join('\n') + '\n';
}

function stripManaged(text) {
  const b = text.indexOf(BEGIN);
  if (b === -1) return { head: text.replace(/\n*$/, '\n'), had: false };
  const e = text.indexOf(END);
  const tail = e === -1 ? '' : text.slice(e + END.length);
  return { head: text.slice(0, b).replace(/\n*$/, '\n'), tail: tail.replace(/^\n*/, ''), had: true };
}

/* ---------- validation ---------- */
function validate(candidate, cb) {
  const tmp = path.join(os.tmpdir(), 'gnb-qos-validate-' + process.pid + '-' + Date.now() + '.yaml');
  try { fs.writeFileSync(tmp, candidate, 'utf8'); }
  catch (e) { return cb(new Error('cannot write temp file: ' + e.message)); }
  execFile(GNB_BIN, ['-c', tmp, '--dryrun'], { timeout: 60000 }, (err, stdout, stderr) => {
    const out = String(stdout || '') + String(stderr || '');
    try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
    if (err) return cb(new Error('srsRAN rejected the config: ' + out.trim().slice(-600)));
    cb(null, out);
  });
}

function checkProfile(p) {
  if (!p || typeof p !== 'object') return 'profile is not an object';
  if (!byQi[p.five_qi]) return '5QI ' + p.five_qi + ' is not a standardised value in TS 23.501 Table 5.7.4-1';
  if (['am', 'um-bidir'].indexOf(p.mode) === -1) return 'mode must be am or um-bidir';
  const inSet = (v, set, name) => set.indexOf(v) === -1 ? (name + ' ' + v + ' is not a 3GPP-legal value') : null;
  return inSet(p.pdcp.discard_timer, PDCP_DISCARD, 'discard_timer')
      || inSet(p.pdcp.t_reordering, PDCP_REORDER, 't_reordering')
      || inSet(p.rlc.t_reassembly, T_REASSEMBLY, 't-reassembly')
      || (p.mode === 'am' ? (inSet(p.rlc.t_poll_retransmit, T_POLL_RETX, 't-poll-retransmit')
            || inSet(p.rlc.max_retx_threshold, MAX_RETX, 'max-retx-threshold')
            || inSet(p.rlc.t_status_prohibit, T_STATUS_PROHIBIT, 't-status-prohibit')) : null);
}

/* ---------- routes ---------- */

/* the standardised catalogue + the legal timer sets the UI may offer */
router.get('/Catalog', (req, res) => {
  res.json({
    source: '3GPP TS 23.501 Table 5.7.4-1 (cross-checked against srsRAN lib/ran/qos/five_qi_qos_mapping.cpp)',
    catalog: CATALOG,
    timers: { t_reassembly: T_REASSEMBLY, t_poll_retransmit: T_POLL_RETX,
              t_status_prohibit: T_STATUS_PROHIBIT, pdcp_discard_timer: PDCP_DISCARD,
              pdcp_t_reordering: PDCP_REORDER, max_retx_threshold: MAX_RETX }
  });
});

/* current gNB profiles, plus which 5QIs subscribers actually use */
router.get('/Profiles', (req, res) => {
  let text = null;
  try { text = fs.readFileSync(GNB_CFG, 'utf8'); }
  catch (e) { return res.status(500).json({ error: 'cannot read ' + GNB_CFG + ': ' + e.message }); }
  const profiles = parseProfiles(text);
  const managed = text.indexOf(BEGIN) !== -1;

  const Subscriber = require('../models/subscriber.js');
  Subscriber.find({}, { imsi: 1, 'slice.session.name': 1, 'slice.session.qos.index': 1 }, (err, subs) => {
    const inUse = {};
    (subs || []).forEach((s) => {
      ((s.slice) || []).forEach((sl) => {
        ((sl.session) || []).forEach((se) => {
          const qi = se && se.qos && se.qos.index;
          if (qi != null) {
            if (!inUse[qi]) inUse[qi] = [];
            inUse[qi].push({ imsi: s.imsi, dnn: se.name });
          }
        });
      });
    });
    const configured = {};
    profiles.forEach((p) => { configured[p.five_qi] = true; });
    const gaps = Object.keys(inUse).map(Number).filter((q) => !configured[q]);
    res.json({
      config_path: GNB_CFG, managed, profiles,
      subscribers_by_5qi: inUse,
      gaps,
      catalog: CATALOG
    });
  });
});

/* suggested 3GPP-consistent defaults for a 5QI (used by the "add" flow) */
router.get('/Defaults/:fiveQi', (req, res) => {
  const d = defaultsFor(parseInt(req.params.fiveQi, 10));
  if (!d) return res.status(404).json({ error: 'unknown 5QI' });
  res.json({ profile: d, characteristics: byQi[d.five_qi] });
});

/* replace the managed qos block. validates with gnb --dryrun BEFORE writing. */
router.post('/Profiles', (req, res) => {
  const profiles = (req.body && req.body.profiles) || [];
  if (!Array.isArray(profiles) || profiles.length === 0)
    return res.status(400).json({ error: 'profiles[] required' });
  const seen = {};
  for (let i = 0; i < profiles.length; i++) {
    const bad = checkProfile(profiles[i]);
    if (bad) return res.status(400).json({ error: bad });
    if (seen[profiles[i].five_qi]) return res.status(400).json({ error: 'duplicate 5QI ' + profiles[i].five_qi });
    seen[profiles[i].five_qi] = true;
  }

  let text;
  try { text = fs.readFileSync(GNB_CFG, 'utf8'); }
  catch (e) { return res.status(500).json({ error: 'cannot read config: ' + e.message }); }

  const parts = stripManaged(text);
  const candidate = parts.head + '\n' + renderProfiles(profiles) + (parts.tail || '');

  validate(candidate, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
    const bak = GNB_CFG + '.bak-webui-' + stamp;
    try {
      fs.copyFileSync(GNB_CFG, bak);
      fs.writeFileSync(GNB_CFG, candidate, 'utf8');
    } catch (e) {
      return res.status(500).json({ error: 'write failed: ' + e.message });
    }
    res.json({ ok: true, backup: bak, profiles: profiles.length,
               restart_required: true,
               note: 'Validated with gnb --dryrun before writing. The gNB must be restarted for this to take effect.' });
  });
});

/* is the running gNB older than the config? then a restart is pending */
router.get('/Status', (req, res) => {
  let mtime = null;
  try { mtime = fs.statSync(GNB_CFG).mtime; } catch (e) { /* ignore */ }
  execFile('systemctl', ['show', 'srsran-gnb', '-p', 'ActiveEnterTimestampMonotonic', '-p', 'MainPID', '--value'],
    { timeout: 8000 }, (err, stdout) => {
      const lines = String(stdout || '').trim().split('\n');
      let started = null;
      execFile('ps', ['-o', 'lstart=', '-C', 'gnb'], { timeout: 8000 }, (e2, out2) => {
        const s = String(out2 || '').trim().split('\n')[0];
        if (s) { const d = new Date(s); if (!isNaN(d.getTime())) started = d; }
        const pending = (mtime && started) ? (mtime.getTime() > started.getTime()) : null;
        res.json({
          config_mtime: mtime, gnb_started: started, main_pid: lines[1] || lines[0] || null,
          restart_pending: pending
        });
      });
    });
});

module.exports = router;
