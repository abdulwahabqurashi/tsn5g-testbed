const express = require('express');
const router = express.Router();
const GnbPm = require('../models/gnb-pm');

/* GET /api/gnb-pm/Latest - most recent PM sample (KPIs) */
router.get('/Latest', async (req, res) => {
  try {
    const doc = await GnbPm.findOne({}).sort({ ts: -1 }).lean().exec();
    if (!doc) return res.json(null);
    res.json(doc);
  } catch (e) { res.status(500).json({ error: 'query failed' }); }
});

/* GET /api/gnb-pm/History?kpi=NAME&limit=200 - time series for one KPI */
router.get('/History', async (req, res) => {
  try {
    const kpi = req.query.kpi;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const docs = await GnbPm.find({}).sort({ ts: -1 }).limit(limit).lean().exec();
    const series = docs.reverse().map(d => ({
      ts: d.ts,
      value: kpi ? (function() { var f = (d.kpis || []).filter(function(k){return k.name===kpi;})[0]; return f ? f.value : null; })() : null
    }));
    res.json(series);
  } catch (e) { res.status(500).json({ error: 'query failed' }); }
});

/* GET /api/gnb-pm/Kpis - distinct KPI names seen recently */
router.get('/Kpis', async (req, res) => {
  try {
    const doc = await GnbPm.findOne({}).sort({ ts: -1 }).lean().exec();
    res.json(doc && doc.kpis ? doc.kpis.map(function(k){return k.name;}) : []);
  } catch (e) { res.status(500).json({ error: 'query failed' }); }
});

module.exports = router;
