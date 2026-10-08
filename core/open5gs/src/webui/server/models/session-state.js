const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/*
 * SessionState — what the RUNNING PDU session is actually carrying.
 *
 * Why this exists: PCC rules and subscriber QoS are read by the SMF ONLY at
 * PDU session establishment. Editing them in MongoDB changes nothing on a
 * session that is already up, and nothing in the console said so. Two rounds
 * of testing were invalidated by exactly that.
 *
 * So on every establishment we snapshot the QoS as it stood at that moment.
 * Comparing that snapshot against the subscriber document as it is now tells
 * us whether the console's view is live or stale.
 *
 * Source of truth is the SMF ledger in smf.log:
 *   [Added]   Number of SMF-Sessions is now N
 *   [Removed] Number of SMF-Sessions is now N
 *   UE SUPI[imsi-...] DNN[...] IPv4[...]
 * The ledger is used rather than a ping or a route check because a UE can
 * remain reachable on a stale context.
 */
const SessionStateSchema = new Schema({
  imsi:           { type: String, index: true },
  supi:           String,
  dnn:            String,
  ipv4:           String,

  established_at: Date,
  released_at:    Date,
  active:         { type: Boolean, default: false },

  /* QoS as it stood when this session came up — i.e. what it is carrying.
   * Shape mirrors subscriber.slice[].session[]: { qos, ambr, pcc_rule[] }. */
  qos_snapshot:   Schema.Types.Mixed,

  source:         { type: String, default: 'smf.log' }
}, { timestamps: true });

SessionStateSchema.index({ imsi: 1, established_at: -1 });

module.exports = mongoose.models.SessionState ||
  mongoose.model('SessionState', SessionStateSchema);
