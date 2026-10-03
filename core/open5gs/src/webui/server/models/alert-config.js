const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/* Notification channel: generic webhook, Slack, or Microsoft Teams.
 * (Email needs an SMTP transport / nodemailer — not bundled.) */
const ChannelSchema = new Schema({
  name: String,
  type: { type: String, enum: ['webhook', 'slack', 'teams'], default: 'webhook' },
  url: String,
  enabled: { type: Boolean, default: true },
  min_severity: { type: String, enum: ['info', 'warning', 'error'], default: 'warning' }
});

/* Server-side alert rule (evaluated on every collected snapshot). */
const RuleSchema = new Schema({
  rule_id: String,
  name: String,
  metric: String,          /* e.g. nwtt.jitter_current_us */
  operator: { type: String, enum: ['>', '<', '>=', '<=', '=='], default: '>' },
  threshold: Number,
  severity: { type: String, enum: ['info', 'warning', 'error'], default: 'warning' },
  enabled: { type: Boolean, default: true },
  for_seconds: { type: Number, default: 0 }  /* must hold this long before firing */
});

/* Single config document (singleton). */
const AlertConfigSchema = new Schema({
  singleton: { type: String, default: 'config', unique: true },
  channels: [ChannelSchema],
  rules: [RuleSchema]
});

module.exports = mongoose.model('AlertConfig', AlertConfigSchema);

/* Fired-alert history (audit trail of notifications). */
const AlertEventSchema = new Schema({
  ts: { type: Date, default: Date.now, index: true },
  rule_id: String,
  name: String,
  severity: String,
  metric: String,
  value: Number,
  threshold: Number,
  state: { type: String, enum: ['firing', 'resolved'] },
  delivered: [String]   /* channel names notified */
});
/* keep 90 days of alert history */
AlertEventSchema.index({ ts: 1 }, { expireAfterSeconds: 7776000 });

module.exports.AlertEvent = mongoose.model('AlertEvent', AlertEventSchema);
