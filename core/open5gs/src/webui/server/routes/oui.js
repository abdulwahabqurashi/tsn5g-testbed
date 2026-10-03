const express = require('express');
const http = require('http');
const router = express.Router();
const oui = require('../services/oui-lookup');

/* GET /api/oui/Lookup?macs=aa:bb:cc..,dd:ee:ff.. - vendor for each MAC */
router.get('/Lookup', (req, res) => {
  const macs = (req.query.macs || '').split(',').map(s => s.trim()).filter(Boolean);
  res.json(oui.lookupMany(macs));
});

/* GET /api/oui/Devices - downstream devices learned on NW-TT ports,
 * each annotated with its vendor (from the learned MAC's OUI). */
router.get('/Devices', (req, res) => {
  const r = http.get('http://127.0.0.7:9090/tsn-info', (r2) => {
    let d = ''; r2.on('data', c => d += c);
    r2.on('end', () => {
      let info; try { info = JSON.parse(d); } catch (e) { info = null; }
      const ports = (info && info.ports) || [];
      const devices = [];
      ports.forEach(p => {
        const gw = p.gw_mac;
        (p.ue_macs || []).forEach(mac => {
          const v = oui.lookup(mac);
          devices.push({
            port: p.port_number, mac, vendor: v.vendor,
            known: v.known, local: v.local,
            role: (mac === gw) ? 'gateway' : 'endpoint'
          });
        });
      });
      res.json({ devices });
    });
  });
  r.on('error', () => res.json({ devices: [] }));
  r.setTimeout(4000, () => { r.destroy(); res.json({ devices: [] }); });
});

module.exports = router;
