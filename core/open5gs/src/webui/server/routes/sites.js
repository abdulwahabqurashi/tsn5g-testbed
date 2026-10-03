const express = require('express');
const http = require('http');
const router = express.Router();
const Site = require('../models/site');
const resolver = require('../services/site-resolver');

/* GET /api/sites/List - all sites (reads open to any authenticated role) */
router.get('/List', async (req, res) => {
  try { res.json(await Site.find({}).sort({ order: 1, name: 1 }).lean().exec()); }
  catch (e) { res.status(500).json({ error: 'list failed' }); }
});

/* PUT /api/sites/Save - upsert a site (operator+) */
router.put('/Save', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.site_id || !b.name) return res.status(400).json({ error: 'site_id and name required' });
    const doc = await Site.findOneAndUpdate({ site_id: b.site_id }, {
      $set: {
        name: b.name, location: b.location, color: b.color,
        tacs: b.tacs || [], gnb_ids: (b.gnb_ids || []).map(Number),
        upf_metrics_url: b.upf_metrics_url, bridge_id: b.bridge_id,
        hosts_core: !!b.hosts_core,
        order: b.order || 0
      }
    }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec();
    res.json(doc);
  } catch (e) { res.status(500).json({ error: 'save failed' }); }
});

/* DELETE /api/sites/:site_id (operator+) */
router.delete('/:site_id', async (req, res) => {
  try { await Site.deleteOne({ site_id: req.params.site_id }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'delete failed' }); }
});

function amfGet(pathname) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.5:9090' + pathname, (r) => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

/* GET /api/sites/Grouped - gNBs + UEs grouped by site (for topology) */
router.get('/Grouped', async (req, res) => {
  try {
    const [gnbs, ues] = await Promise.all([
      amfGet('/gnb-info'), amfGet('/ue-info')
    ]);
    const gnbList = (gnbs && gnbs.items) || [];
    const ueList = (ues && ues.items) || [];
    res.json(await resolver.grouped(gnbList, ueList));
  } catch (e) { res.status(500).json({ error: 'group failed' }); }
});

module.exports = router;
