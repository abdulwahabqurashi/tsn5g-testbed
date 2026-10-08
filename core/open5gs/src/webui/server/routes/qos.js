const express = require('express');
const router = express.Router();
const Subscriber = require('../models/subscriber');
const SessionState = require('../models/session-state');
const AuditEvent = require('../models/audit-event');
const readback = require('../services/gnb-readback');
const watcher = require('../services/session-watcher');

/* ============================================================
 * /api/qos — one view of every QoS flow on the network, and the
 * ability to change one.
 *
 * Joins four sources, because no single one has the answer:
 *   MongoDB          what is configured
 *   session-watcher  whether the running session is carrying it (smf.log)
 *   gnb-readback     what the radio actually received (gnb.log)
 *   gnb BSRs         whether the bearer is carrying data at all
 *
 * The last of those is the point. A bearer can be configured perfectly,
 * accepted by the radio, and still never carry a byte because the traffic
 * filter never matches — which is exactly what happened here for three weeks.
 * ============================================================ */

/* Open5GS bit-rate units are ZERO-indexed: 0 bps, 1 Kbps, 2 Mbps, 3 Gbps,
 * 4 Tbps. This is the WebUI's own enum (Subscriber/Edit.js:98) and it is what
 * the existing records hold — the live GBR is {value: 25, unit: 2}, which the
 * gNB read-back independently confirms as 25 Mbps (25000000 bps over NGAP).
 * Getting this off by one writes Gbps where Mbps was meant. */
const UNIT_MBPS = 2;
function toMbps(v) {
  if (!v || v.value === undefined || v.value === null) return null;
  const u = v.unit === undefined ? UNIT_MBPS : v.unit;
  const scale = { 0: 1e-6, 1: 1e-3, 2: 1, 3: 1e3, 4: 1e6 }[u];
  return scale === undefined ? null : v.value * scale;
}

/* The stored rule is in DOWNLINK form ("to assigned <port>"); Open5GS swaps
 * source and destination to build the uplink filter. So the UE must SEND FROM
 * that port for uplink to match. Parsed here so the UI never has to guess. */
function parseFlow(desc) {
  if (!desc) return null;
  const m = String(desc).trim().match(
    /^permit\s+(in|out)\s+(\S+)\s+from\s+(\S+)(?:\s+([0-9,\-\s]+?))?\s+to\s+(\S+)(?:\s+([0-9,\-\s]+?))?$/i);
  if (!m) return { raw: desc, parsed: false };
  const dir = m[1].toLowerCase();
  return {
    raw: desc, parsed: true,
    proto: m[2].toLowerCase(),
    ue_port: (dir === 'out' ? (m[6] || '') : (m[4] || '')).trim(),
    remote: dir === 'out' ? m[3] : m[5]
  };
}

function buildRule(proto, port) {
  return 'permit out ' + proto + ' from any 1-65535 to assigned ' + port;
}

/* GET /api/qos/Flows — every flow, every subscriber, with live state. */
router.get('/Flows', function(req, res) {
  Promise.all([
    Subscriber.find({}).lean().exec(),
    SessionState.find({}).lean().exec(),
    AuditEvent.find({ method: { $in: ['POST','PUT','PATCH'] }, status: { $lt: 400 } })
      .sort({ ts: -1 }).limit(200).lean().exec()
  ]).then(function(r) {
    const subs = r[0], sessions = r[1], audit = r[2];
    const rb = readback.get();
    const byImsi = {};
    sessions.forEach(function(s) { byImsi[s.imsi] = s; });
    const lastEdit = {};
    audit.forEach(function(a) { if (a.target && !lastEdit[a.target]) lastEdit[a.target] = a; });

    const flows = [];
    subs.forEach(function(sub) {
      const slice = (sub.slice || [])[0] || {};
      const sess = (slice.session || [])[0] || {};
      const live = byImsi[sub.imsi];
      const active = !!(live && live.active);
      const edit = lastEdit[sub.imsi];
      const drift = active && edit && live.established_at &&
                    new Date(edit.ts) > new Date(live.established_at);

      /* default flow — always QFI 1 */
      const defDrb = rb.drbs[1] || {};
      flows.push({
        imsi: sub.imsi, qfi: 1, kind: 'default',
        five_qi: (sess.qos || {}).index,
        arp: ((sess.qos || {}).arp || {}).priority_level,
        gbr_ul: null, mbr_ul: null,
        ambr_ul: toMbps((sess.ambr || {}).uplink),
        filter: null,
        drb: defDrb.drb || null, lcg: defDrb.lcg, priority: defDrb.priority,
        pbr: defDrb.pbr, rlc_mode: defDrb.rlc_mode,
        queue_bytes: defDrb.lcg !== undefined && defDrb.lcg !== null ? (rb.queue[defDrb.lcg] || 0) : null,
        session_active: active, drift: !!drift,
        established_at: live ? live.established_at : null,
        ipv4: live ? live.ipv4 : null, dnn: sess.name
      });

      /* one flow per PCC rule */
      (sess.pcc_rule || []).forEach(function(rule, i) {
        const qfi = i + 2;
        const d = rb.drbs[qfi] || {};
        const f = parseFlow(((rule.flow || [])[0] || {}).description);
        flows.push({
          imsi: sub.imsi, qfi: qfi, kind: 'pcc', rule_index: i,
          five_qi: (rule.qos || {}).index,
          arp: ((rule.qos || {}).arp || {}).priority_level,
          gbr_ul: toMbps((rule.qos || {}).gbr && rule.qos.gbr.uplink),
          mbr_ul: toMbps((rule.qos || {}).mbr && rule.qos.mbr.uplink),
          ambr_ul: null,
          filter: f,
          all_filters: (rule.flow || []).map(function(x) { return x.description; }),
          drb: d.drb || null, lcg: d.lcg, priority: d.priority,
          pbr: d.pbr, rlc_mode: d.rlc_mode,
          queue_bytes: d.lcg !== undefined && d.lcg !== null ? (rb.queue[d.lcg] || 0) : null,
          session_active: active, drift: !!drift,
          established_at: live ? live.established_at : null,
          ipv4: live ? live.ipv4 : null, dnn: sess.name
        });
      });
    });

    res.json({
      flows: flows,
      readback: {
        captured_at: rb.captured_at,
        mac_debug: rb.mac_debug,     /* false => queue depth unavailable */
        flows: rb.flows
      }
    });
  }).catch(function(e) {
    console.error('[qos] Flows failed:', e);
    res.status(500).json({ message: 'qos flows unavailable' });
  });
});

/* PUT /api/qos/Flow — change one PCC rule.
 * Body: { imsi, rule_index, five_qi, gbr_ul, mbr_ul, proto, port } */
router.put('/Flow', function(req, res) {
  const b = req.body || {};
  const imsi = String(b.imsi || '').trim();
  const idx = parseInt(b.rule_index, 10);
  if (!imsi || isNaN(idx)) {
    return res.status(400).json({ message: 'imsi and rule_index are required' });
  }

  const port = String(b.port === undefined ? '' : b.port).trim();
  const proto = (b.proto === 'tcp' ? 'tcp' : 'udp');
  const fiveQi = parseInt(b.five_qi, 10);
  const gbr = parseFloat(b.gbr_ul);
  const mbr = parseFloat(b.mbr_ul);

  if (port && !/^\d{1,5}(-\d{1,5})?$/.test(port)) {
    return res.status(400).json({ message: 'port must be a number or range' });
  }
  if (!isNaN(gbr) && !isNaN(mbr) && mbr < gbr) {
    return res.status(400).json({ message: 'maximum rate cannot be below the guaranteed rate' });
  }

  Subscriber.findOne({ imsi: imsi }).exec().then(function(sub) {
    if (!sub) return res.status(404).json({ message: 'subscriber not found' });
    const slice = (sub.slice || [])[0];
    const sess = slice && (slice.session || [])[0];
    const rule = sess && (sess.pcc_rule || [])[idx];
    if (!rule) return res.status(404).json({ message: 'pcc rule not found' });

    rule.qos = rule.qos || {};
    if (!isNaN(fiveQi)) rule.qos.index = fiveQi;
    if (!isNaN(gbr)) {
      rule.qos.gbr = { uplink: { value: gbr, unit: UNIT_MBPS },
                       downlink: { value: gbr, unit: UNIT_MBPS } };
    }
    if (!isNaN(mbr)) {
      rule.qos.mbr = { uplink: { value: mbr, unit: UNIT_MBPS },
                       downlink: { value: mbr, unit: UNIT_MBPS } };
    }
    /* Keep both protocol variants in step, as the rig has always had them. */
    if (port) {
      rule.flow = [
        { direction: 3, description: buildRule('tcp', port) },
        { direction: 3, description: buildRule('udp', port) }
      ];
      if (proto === 'udp') rule.flow.reverse();
    }

    sub.markModified('slice');
    return sub.save().then(function() {
      return SessionState.findOne({ imsi: imsi }).lean().exec();
    }).then(function(live) {
      res.json({
        ok: true,
        /* The caller needs to know this is NOT yet in force. */
        applied_to_session: false,
        session_active: !!(live && live.active),
        message: (live && live.active)
          ? 'Saved. The running session is still carrying the previous values — rebuild on the UE with AT+CFUN=0 then AT+CFUN=1.'
          : 'Saved. It will take effect when the UE next attaches.'
      });
    });
  }).catch(function(e) {
    console.error('[qos] Flow update failed:', e);
    res.status(500).json({ message: 'update failed' });
  });
});

module.exports = router;
