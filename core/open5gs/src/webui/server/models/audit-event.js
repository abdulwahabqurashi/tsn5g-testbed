const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/* Immutable audit trail of write actions on the console. */
const AuditEventSchema = new Schema({
  ts: { type: Date, default: Date.now, index: true },
  user: String,
  role: String,
  method: String,          /* POST/PUT/PATCH/DELETE */
  action: String,          /* human label, e.g. "update subscriber" */
  resource: String,        /* collection/route, e.g. "subscriber" */
  target: String,          /* id acted on, e.g. an IMSI */
  path: String,
  status: Number,          /* HTTP status of the response */
  ip: String
});
AuditEventSchema.index({ ts: -1 });
/* retain audit for 1 year */
AuditEventSchema.index({ ts: 1 }, { expireAfterSeconds: 31536000 });

module.exports = mongoose.model('AuditEvent', AuditEventSchema);
