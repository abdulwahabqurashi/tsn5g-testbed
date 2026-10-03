const express = require('express');
const router = express.Router();
const engine = require('../services/alert-engine');
const AlertConfig = require('../models/alert-config');
const AlertEvent = AlertConfig.AlertEvent;

/* GET /api/alerts/Config - channels + rules */
router.get('/Config', async (req, res) => {
  try {
    const cfg = await engine.getConfig();
    res.json({ channels: cfg.channels, rules: cfg.rules });
  } catch (e) { res.status(500).json({ error: 'config load failed' }); }
});

/* PUT /api/alerts/Config - replace channels and/or rules (operator+) */
router.put('/Config', async (req, res) => {
  try {
    const cfg = await engine.getConfig();
    if (Array.isArray(req.body.channels)) cfg.channels = req.body.channels;
    if (Array.isArray(req.body.rules)) cfg.rules = req.body.rules;
    await cfg.save();
    res.json({ channels: cfg.channels, rules: cfg.rules });
  } catch (e) { res.status(500).json({ error: 'save failed' }); }
});

/* POST /api/alerts/Test - deliver a synthetic alert to all channels */
router.post('/Test', async (req, res) => {
  try {
    const cfg = await engine.getConfig();
    const delivered = await engine.deliver(cfg, {
      rule_id: 'test', name: 'Test Alert', severity: 'info',
      metric: 'test', value: 1, threshold: 0, state: 'firing'
    });
    res.json({ delivered });
  } catch (e) { res.status(500).json({ error: 'test failed' }); }
});

/* GET /api/alerts/History?limit=50 - fired-alert audit trail */
router.get('/History', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const events = await AlertEvent.find({}).sort({ ts: -1 })
      .limit(limit).lean().exec();
    res.json(events);
  } catch (e) { res.status(500).json({ error: 'history failed' }); }
});

module.exports = router;
