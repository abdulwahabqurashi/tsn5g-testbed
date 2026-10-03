const express = require('express');
const router = express.Router();
const bulk = require('../services/bulk-subscribers');

/* GET /api/bulk/Export - all subscribers as CSV */
router.get('/Export', async (req, res) => {
  try {
    const csv = await bulk.exportCSV();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition',
      'attachment; filename="subscribers-' +
      new Date().toISOString().slice(0, 10) + '.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: 'export failed' }); }
});

/* GET /api/bulk/Template - a blank CSV template */
router.get('/Template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="subscribers-template.csv"');
  res.send(bulk.TEMPLATE);
});

/* POST /api/bulk/Import - body: { csv: "..." } (operator+) */
router.post('/Import', async (req, res) => {
  try {
    const text = (req.body && req.body.csv) || '';
    if (!text.trim()) return res.status(400).json({ error: 'empty CSV' });
    const report = await bulk.importCSV(text);
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message || 'import failed' }); }
});

module.exports = router;
