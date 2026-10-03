const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/* Hourly-downsampled TSN metrics for long-term history (30 days).
 * One document per bucket (hour) per port. Gauges are averaged/peaked
 * over the bucket; counters keep the last value seen in the bucket. */
const RollupSchema = new Schema({
  bucket: { type: Date, index: true },        /* start of the hour (UTC) */
  port_number: Number,
  samples: Number,

  jitter_avg_us: Number,
  jitter_peak_us: Number,
  residence_avg_us: Number,
  residence_max_us: Number,
  gptp_offset_avg_ns: Number,
  gptp_synced_pct: Number,

  rx_frames: Number,      /* last cumulative counter in the bucket */
  tx_frames: Number,
  rx_bytes: Number,
  tx_bytes: Number,
  psfp_passed_frames: Number,
  psfp_dropped_frames: Number,

  dl_mbps_avg: Number,    /* derived rate over the bucket */
  ul_mbps_avg: Number
});

RollupSchema.index({ bucket: 1, port_number: 1 }, { unique: true });
/* keep hourly rollups for 30 days */
RollupSchema.index({ bucket: 1 }, { expireAfterSeconds: 2592000 });

module.exports = mongoose.model('TsnMetricRollup', RollupSchema);
