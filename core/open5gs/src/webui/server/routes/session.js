const express = require('express');
const router = express.Router();
const SessionState = require('../models/session-state');
const Subscriber = require('../models/subscriber');
const AuditEvent = require('../models/audit-event');
const watcher = require('../services/session-watcher');

/* ============================================================
 * /api/session — is the console's QoS actually live?
 *
 * PCC rules and subscriber QoS reach the network ONLY at PDU session
 * establishment. An edit made afterwards sits in MongoDB doing nothing until
 * the session is rebuilt, and the console gave no sign of it. This route
 * compares three things:
 *
 *   - when the running session was established   (session-watcher, smf.log)
 *   - when the subscriber was last edited        (audit-event)
 *   - what the session is carrying vs. what the document now says
 *
 * It is read-only. It deliberately offers no "rebuild" action: a rebuild is a
 * UE-side operation (AT+CFUN=0 / AT+CFUN=1), and --wds-stop-network does NOT
 * do it. A button that appeared to work but did not would be worse than none.
 * ============================================================ */

/* Walk two QoS snapshots and list the dotted paths that differ. */
function diffPaths(before, after, prefix, out) {
  prefix = prefix || '';
  out = out || [];
  if (before === after) return out;

  var bNull = before === null || before === undefined;
  var aNull = after === null || after === undefined;
  if (bNull || aNull) {
    if (bNull !== aNull) out.push(prefix || '(qos)');
    return out;
  }
  if (typeof before !== 'object' || typeof after !== 'object') {
    if (String(before) !== String(after)) out.push(prefix);
    return out;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    var bArr = Array.isArray(before) ? before : [];
    var aArr = Array.isArray(after) ? after : [];
    if (bArr.length !== aArr.length) {
      out.push(prefix + ' (' + bArr.length + ' → ' + aArr.length + ')');
      return out;
    }
    for (var i = 0; i < bArr.length; i++) {
      diffPaths(bArr[i], aArr[i], prefix + '[' + i + ']', out);
    }
    return out;
  }
  var keys = {};
  Object.keys(before).forEach(function(k) { keys[k] = 1; });
  Object.keys(after).forEach(function(k) { keys[k] = 1; });
  Object.keys(keys).forEach(function(k) {
    if (k === '_id' || k === '__v') return;
    diffPaths(before[k], after[k], prefix ? prefix + '.' + k : k, out);
  });
  return out;
}

/* GET /api/session/State?imsi=001020000000001 */
router.get('/State', function(req, res) {
  var imsi = (req.query.imsi || '').trim();
  if (!imsi) {
    return res.status(400).json({ message: 'imsi query parameter required' });
  }

  Promise.all([
    SessionState.findOne({ imsi: imsi }).sort({ established_at: -1 }).lean().exec(),
    Subscriber.findOne({ imsi: imsi }).lean().exec(),
    AuditEvent.findOne({
      target: imsi,
      method: { $in: ['POST', 'PUT', 'PATCH', 'DELETE'] },
      status: { $lt: 400 }
    }).sort({ ts: -1 }).lean().exec()
  ]).then(function(r) {
    var sess = r[0], sub = r[1], lastEdit = r[2];

    if (!sub) return res.status(404).json({ message: 'subscriber not found' });

    var currentQos = watcher.qosOf(sub);
    var out = {
      imsi: imsi,
      active: !!(sess && sess.active),
      established_at: sess ? sess.established_at : null,
      released_at: sess ? sess.released_at : null,
      ipv4: sess ? sess.ipv4 : null,
      dnn: sess ? sess.dnn : null,
      config_changed_at: lastEdit ? lastEdit.ts : null,
      changed_by: lastEdit ? lastEdit.user : null,
      drift: false,
      drift_fields: [],
      /* no_session: nothing to be stale against — the next attach picks up
       * whatever the document says at that moment */
      reason: 'live'
    };

    if (!sess || !sess.active) {
      out.reason = 'no_session';
      return res.json(out);
    }

    /* Content drift is the strong signal: the session's snapshot genuinely
     * differs from the document. Timestamp drift is the fallback for edits
     * the snapshot cannot represent. */
    var fields = diffPaths(sess.qos_snapshot, currentQos);
    if (fields.length > 0) {
      out.drift = true;
      out.drift_fields = fields;
      out.reason = 'qos_changed_since_establishment';
    } else if (lastEdit && sess.established_at &&
               new Date(lastEdit.ts) > new Date(sess.established_at)) {
      out.drift = true;
      out.reason = 'edited_after_establishment';
    }

    return res.json(out);
  }).catch(function(e) {
    console.error('[session] State failed:', e);
    res.status(500).json({ message: 'session state unavailable' });
  });
});

/* GET /api/session/List — every tracked session, newest first. */
router.get('/List', function(req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  SessionState.find({}).sort({ established_at: -1 }).limit(limit).lean().exec()
    .then(function(rows) { res.json(rows); })
    .catch(function(e) {
      console.error('[session] List failed:', e);
      res.status(500).json({ message: 'session list unavailable' });
    });
});

module.exports = router;
