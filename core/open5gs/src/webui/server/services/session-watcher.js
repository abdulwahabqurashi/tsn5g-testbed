/*
 * Session Watcher
 *
 * Follows the SMF log and records when each UE's PDU session is established
 * and released, snapshotting the subscriber's QoS at the moment of
 * establishment.
 *
 * Why: PCC rules are read ONLY at session establishment. A QoS edit made in
 * the console after a session came up is not live, and until now nothing
 * detected that. The snapshot taken here is what /api/session/State compares
 * the current subscriber document against.
 *
 * Reads the tail only — smf.log is appended to continuously and must never be
 * re-read whole on a tick.
 */
const fs = require('fs');
const path = require('path');
const SessionState = require('../models/session-state');
const Subscriber = require('../models/subscriber');

const SMF_LOG = process.env.SMF_LOG ||
    '/var/local/log/open5gs/smf.log';
const POLL_MS = parseInt(process.env.SESSION_WATCH_INTERVAL || '3000', 10);

/* Lines we care about. The ledger counts are authoritative; the SUPI line
 * carries the identity and address and arrives alongside establishment. */
const RE_SUPI    = /UE SUPI\[imsi-(\d+)\]\s+DNN\[([^\]]*)\]\s+IPv4\[([^\]]*)\]/;
const RE_ADDED   = /\[Added\]\s+Number of SMF-Sessions is now (\d+)/;
const RE_REMOVED = /\[Removed\]\s+Number of SMF-Sessions is now (\d+)/;

var timer = null;
var offset = null;      /* byte offset we have consumed up to */
var awaiting = false;   /* saw [Added], now waiting for the SUPI line */
var carry = '';         /* partial trailing line between reads */

/* Pull the QoS block out of a subscriber document, in the shape the session
 * is actually using. Defensive throughout: the document is operator-editable
 * and any level may be absent. */
function qosOf(sub) {
  if (!sub) return null;
  var slice = (sub.slice && sub.slice[0]) || null;
  var sess = (slice && slice.session && slice.session[0]) || null;
  if (!sess) return null;
  return {
    default_5qi: sess.qos && sess.qos.index,
    arp: sess.qos && sess.qos.arp,
    ambr: sess.ambr,
    pcc_rule: (sess.pcc_rule || []).map(function(r) {
      return {
        five_qi: r.qos && r.qos.index,
        arp: r.qos && r.qos.arp,
        gbr: r.qos && r.qos.gbr,
        mbr: r.qos && r.qos.mbr,
        flow: (r.flow || []).map(function(f) {
          return { direction: f.direction, description: f.description };
        })
      };
    })
  };
}

function onEstablished(info) {
  return Subscriber.findOne({ imsi: info.imsi }).lean().exec()
    .then(function(sub) {
      return SessionState.findOneAndUpdate(
        { imsi: info.imsi },
        {
          imsi: info.imsi,
          supi: 'imsi-' + info.imsi,
          dnn: info.dnn,
          ipv4: info.ipv4,
          established_at: new Date(),
          released_at: null,
          active: true,
          qos_snapshot: qosOf(sub),
          source: 'smf.log'
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).exec();
    })
    .catch(function(e) {
      console.error('[session-watcher] establish failed:', e.message);
    });
}

function onReleased() {
  /* The ledger line carries no IMSI, so release the active session(s). With a
   * single UE on this testbed that is exact; with several it is approximate,
   * and the next establishment corrects it. */
  return SessionState.updateMany(
    { active: true },
    { $set: { active: false, released_at: new Date() } }
  ).exec().catch(function(e) {
    console.error('[session-watcher] release failed:', e.message);
  });
}

/* Order on the wire, verified against the live log:
 *     [Added] Number of SMF-Sessions is now 1     <- ledger first
 *     UE SUPI[imsi-...] DNN[...] IPv4[...]        <- identity ~14 ms later
 * So [Added] arms, and the SUPI line that follows commits the establishment.
 * Doing it the other way round never fires. */
function handleLine(line) {
  var m = RE_ADDED.exec(line);
  if (m) {
    awaiting = true;
    return Promise.resolve();
  }
  m = RE_SUPI.exec(line);
  if (m && awaiting) {
    awaiting = false;
    return onEstablished({ imsi: m[1], dnn: m[2], ipv4: m[3] });
  }
  m = RE_REMOVED.exec(line);
  if (m && parseInt(m[1], 10) === 0) {
    awaiting = false;
    return onReleased();
  }
  return Promise.resolve();
}

function tick() {
  fs.stat(SMF_LOG, function(err, st) {
    if (err) return;                      /* log not present yet */
    if (offset === null) {                /* first run: start at the end */
      offset = st.size;
      return;
    }
    if (st.size < offset) {               /* truncated or rotated */
      offset = 0;
      carry = '';
    }
    if (st.size === offset) return;

    var stream = fs.createReadStream(SMF_LOG, {
      start: offset, end: st.size - 1, encoding: 'utf8'
    });
    var buf = '';
    stream.on('data', function(c) { buf += c; });
    stream.on('error', function() { /* ignore; retry next tick */ });
    stream.on('end', function() {
      offset = st.size;
      var text = carry + buf;
      var lines = text.split('\n');
      carry = lines.pop();                /* keep the partial last line */
      /* Sequential: establishment order matters. */
      lines.reduce(function(p, l) {
        return p.then(function() { return handleLine(l); });
      }, Promise.resolve());
    });
  });
}

function start() {
  if (timer) return;
  if (!fs.existsSync(SMF_LOG)) {
    console.warn('[session-watcher] ' + SMF_LOG + ' not found — drift ' +
                 'detection will stay idle until the core writes it');
  }
  timer = setInterval(tick, POLL_MS);
  tick();
  console.log('[session-watcher] following ' + SMF_LOG +
              ' every ' + POLL_MS + ' ms');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start: start, stop: stop, qosOf: qosOf };
