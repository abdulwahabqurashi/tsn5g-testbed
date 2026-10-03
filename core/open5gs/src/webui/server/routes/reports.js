const express = require('express');
const router = express.Router();
const reportGen = require('../services/report-gen');

/* GET /api/reports/Generate?range=24h|7d|30d&format=html|csv
 * On-demand report download. */
router.get('/Generate', async (req, res) => {
  const range = ['24h', '7d', '30d'].indexOf(req.query.range) >= 0 ? req.query.range : '24h';
  const format = req.query.format === 'csv' ? 'csv' : 'html';
  try {
    const r = await reportGen.generate(range, format);
    const fname = 'amrc-5gtsn-' + range + '-' +
      new Date().toISOString().slice(0, 10) + '.' + r.ext;
    res.setHeader('Content-Type', r.mime);
    res.setHeader('Content-Disposition',
      (format === 'csv' ? 'attachment' : 'inline') + '; filename="' + fname + '"');
    res.send(r.body);
  } catch (e) { res.status(500).json({ error: 'report generation failed' }); }
});

/* GET /api/reports/List - scheduled reports on disk */
router.get('/List', (req, res) => {
  res.json(reportGen.listReports());
});

/* GET /api/reports/Download?name=daily-2026-07-06.html */
router.get('/Download', (req, res) => {
  const buf = reportGen.readReport(req.query.name || '');
  if (!buf) return res.status(404).json({ error: 'not found' });
  const csv = /\.csv$/.test(req.query.name);
  res.setHeader('Content-Type', csv ? 'text/csv' : 'text/html');
  res.setHeader('Content-Disposition',
    (csv ? 'attachment' : 'inline') + '; filename="' + req.query.name + '"');
  res.send(buf);
});

module.exports = router;
