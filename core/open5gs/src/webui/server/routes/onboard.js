const express = require('express');
const http = require('http');
const router = express.Router();
const Subscriber = require('../models/subscriber');
const bulk = require('../services/bulk-subscribers');

/* POST /api/onboard/Provision - create/update one subscriber from
 * friendly fields (operator+, audited via /db mount). */
router.post('/Provision', async (req, res) => {
  try {
    const b = req.body || {};
    const doc = bulk.toDoc({
      imsi: b.imsi, k: b.k, opc: b.opc, amf: b.amf,
      dnn: b.dnn, session_type: b.session_type,
      qos_index: b.qos_index, dl_mbps: b.dl_mbps, ul_mbps: b.ul_mbps, sst: b.sst
    });
    if (!doc) return res.status(400).json({ error: 'invalid IMSI' });
    const existing = await Subscriber.findOne({ imsi: doc.imsi }).lean().exec();
    await Subscriber.updateOne({ imsi: doc.imsi }, doc, { upsert: true });
    res.json({ imsi: doc.imsi, created: !existing, updated: !!existing });
  } catch (e) { res.status(500).json({ error: e.message || 'provision failed' }); }
});

function amfGet(pathname) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.5:9090' + pathname, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

/* GET /api/onboard/Verify?imsi=... - attach status for one IMSI */
router.get('/Verify', async (req, res) => {
  const imsi = (req.query.imsi || '').replace(/[^0-9]/g, '');
  if (!imsi) return res.status(400).json({ error: 'imsi required' });
  const info = await amfGet('/ue-info');
  const items = (info && info.items) || [];
  const ue = items.filter(u => (u.supi || '').indexOf(imsi) >= 0)[0];
  if (!ue) return res.json({ attached: false, registered: false });
  const pdus = (ue.pdu_sessions || []).map(p => ({ dnn: p.dnn, psi: p.psi }));
  res.json({
    attached: ue.cm_state === 'connected' || ue.cm_state === 'CM-CONNECTED',
    registered: true, cm_state: ue.cm_state,
    guti: ue.guti, pdu_sessions: pdus,
    cell: ((ue.location || {}).nr_cgi || {}).cell_id
  });
});

module.exports = router;
