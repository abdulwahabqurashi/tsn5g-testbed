/*
 * Site resolution: map connected gNBs and UEs to their site.
 * Precedence: explicit gnb_id override > TAC membership > Unassigned.
 */
const Site = require('../models/site');

const UNASSIGNED = { site_id: '_unassigned', name: 'Unassigned',
  color: '#9096a2', location: '', tacs: [], gnb_ids: [] };

async function getSites() {
  const sites = await Site.find({}).sort({ order: 1, name: 1 }).lean().exec();
  return sites;
}

/* which site does a gNB belong to? */
function siteForGnb(gnb, sites) {
  const gid = gnb.gnb_id;
  const tacs = (gnb.supported_ta_list || [])
    .map(t => (t.tac || '').toLowerCase());
  /* override wins */
  for (const s of sites) {
    if ((s.gnb_ids || []).indexOf(gid) >= 0) return s;
  }
  /* then TAC */
  for (const s of sites) {
    if ((s.tacs || []).some(t => tacs.indexOf(String(t).toLowerCase()) >= 0))
      return s;
  }
  return null;
}

/* which site does a UE belong to (via its serving TAC / gNB)? */
function siteForUe(ue, sites) {
  const loc = ue.location || {};
  const tac = ((loc.nr_tai || {}).tac_hex || '').toLowerCase();
  const gid = (ue.gnb || {}).gnb_id;
  for (const s of sites) {
    if (gid != null && (s.gnb_ids || []).indexOf(gid) >= 0) return s;
  }
  for (const s of sites) {
    if (tac && (s.tacs || []).some(t => String(t).toLowerCase() === tac)) return s;
  }
  return null;
}

/* group gNBs + UEs by site for the topology / dashboards */
async function grouped(gnbList, ueList) {
  const sites = await getSites();
  const byId = {};
  const ensure = (s) => {
    if (!byId[s.site_id]) byId[s.site_id] = {
      site_id: s.site_id, name: s.name, color: s.color, location: s.location,
      bridge_id: s.bridge_id, hosts_core: !!s.hosts_core, gnbs: [], ues: 0, connected_ues: 0 };
    return byId[s.site_id];
  };
  sites.forEach(ensure);

  (gnbList || []).forEach(g => {
    const s = siteForGnb(g, sites) || UNASSIGNED;
    ensure(s).gnbs.push({ gnb_id: g.gnb_id,
      tac: ((g.supported_ta_list || [])[0] || {}).tac,
      connected_ues: g.num_connected_ues || 0,
      up: (g.ng || {}).setup_success !== false });
  });
  (ueList || []).forEach(u => {
    const s = siteForUe(u, sites) || UNASSIGNED;
    const e = ensure(s);
    e.ues++;
    if (u.cm_state === 'connected' || u.cm_state === 'CM-CONNECTED')
      e.connected_ues++;
  });

  return { sites, groups: Object.keys(byId).map(k => byId[k]) };
}

module.exports = { getSites, siteForGnb, siteForUe, grouped, UNASSIGNED };
