const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/* A 5G-TSN site in the shared-control-plane / per-site-UPF model.
 * gNBs auto-group into a site by TAC (with per-gNB manual override);
 * each site points at its own UPF metrics endpoint + NW-TT bridge, and
 * metrics/alerts/reports are tagged with the site. */
const SiteSchema = new Schema({
  site_id: { type: String, required: true, unique: true }, /* slug */
  name: { type: String, required: true },
  location: String,
  color: { type: String, default: '#478ff7' },

  /* auto-assignment: gNBs whose supported TAC is in this list belong here */
  tacs: [String],                 /* e.g. ["000001", "000002"] (hex) */

  /* manual override: gnb_id -> forced into this site (wins over TAC) */
  gnb_ids: [Number],

  /* per-site data plane */
  upf_metrics_url: { type: String, default: 'http://127.0.0.7:9090' },
  bridge_id: { type: Number, default: 1 },
  hosts_core: { type: Boolean, default: false }, /* control plane lives here */

  /* per-site alert threshold overrides (optional): metric -> threshold */
  alert_overrides: { type: Map, of: Number },

  order: { type: Number, default: 0 }
});

module.exports = mongoose.model('Site', SiteSchema);
