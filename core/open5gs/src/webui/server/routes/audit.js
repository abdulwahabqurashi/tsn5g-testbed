const express = require('express');
const router = express.Router();
const AuditEvent = require('../models/audit-event');

/* GET /api/audit/List?limit=100&user=&resource= - admin only */
router.get('/List', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const q = {};
    if (req.query.user) q.user = req.query.user;
    if (req.query.resource) q.resource = req.query.resource;
    const events = await AuditEvent.find(q).sort({ ts: -1 }).limit(limit).lean().exec();
    res.json(events);
  } catch (e) { res.status(500).json({ error: 'audit query failed' }); }
});

module.exports = router;
