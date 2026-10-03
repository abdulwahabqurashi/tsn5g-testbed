const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PortMetricSchema = new Schema({
  port_number: Number,
  mac: String,

  residence_time_min_us: Number,
  residence_time_avg_us: Number,
  residence_time_max_us: Number,

  jitter_current_us: Number,
  jitter_peak_us: Number,

  rx_frames: Number,
  tx_frames: Number,
  rx_bytes: Number,
  tx_bytes: Number,

  psfp_passed_frames: Number,
  psfp_dropped_frames: Number,
  psfp_passed_bytes: Number,
  psfp_dropped_bytes: Number
}, { _id: false });

const TsnMetricSchema = new Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  bridge_id: Number,
  gptp_synced: Boolean,
  gptp_offset_ns: Number,
  ports: [PortMetricSchema]
});

/* Keep raw 15s samples for 7 days; hourly rollups (TsnMetricRollup)
 * carry the 30-day history. */
TsnMetricSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.model('TsnMetric', TsnMetricSchema);
