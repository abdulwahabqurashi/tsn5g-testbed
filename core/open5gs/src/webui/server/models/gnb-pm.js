const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/* A gNB performance-measurement (PM) sample, parsed from a file the
 * gNB uploads periodically (3GPP TS 28.552/32.435 measData XML, or a
 * vendor CSV). KPIs are stored as a flat name->number map so whatever
 * counters the gNB reports are captured without a fixed schema. */
const GnbPmSchema = new Schema({
  ts: { type: Date, default: Date.now, index: true },
  received: { type: Date, default: Date.now },
  source_ip: String,
  gnb_id: String,
  filename: String,
  period_start: Date,
  period_end: Date,
  granularity_s: Number,
  object_ldn: String,          /* managed-object the counters belong to */
  /* {name, value} pairs — array (not a Map) because 3GPP KPI names
   * contain dots, which MongoDB field names disallow. */
  kpis: [{ _id: false, name: String, value: Number }],
  kpi_count: Number
});
GnbPmSchema.index({ ts: -1 });
/* retain gNB PM for 30 days */
GnbPmSchema.index({ ts: 1 }, { expireAfterSeconds: 2592000 });

module.exports = mongoose.model('GnbPm', GnbPmSchema);
