const express = require('express');
const router = express.Router();
const backup = require('../services/backup-gen');

/* backup/restore are admin-only (enforced in routes/index.js). */

/* GET /api/backup/Export - download a full-state bundle */
router.get('/Export', async (req, res) => {
  try {
    const bundle = await backup.exportBundle();
    const fname = 'amrc-5gtsn-backup-' +
      new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
    res.send(JSON.stringify(bundle, null, 2));
  } catch (e) { res.status(500).json({ error: 'export failed' }); }
});

/* POST /api/backup/Import - restore from an uploaded bundle
 * body: { bundle: {...}, collections?: [...] } */
router.post('/Import', async (req, res) => {
  try {
    const bundle = req.body.bundle || req.body;
    const report = await backup.importBundle(bundle,
      { collections: req.body.collections });
    res.json({ restored: report });
  } catch (e) { res.status(400).json({ error: e.message || 'import failed' }); }
});

/* GET /api/backup/List - scheduled backups on disk */
router.get('/List', (req, res) => res.json(backup.listBackups()));

/* GET /api/backup/Download?name=backup-2026-07-06.json */
router.get('/Download', (req, res) => {
  const buf = backup.readBackup(req.query.name || '');
  if (!buf) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition',
    'attachment; filename="' + req.query.name + '"');
  res.send(buf);
});

module.exports = router;
