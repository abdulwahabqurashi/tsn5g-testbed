/*
 * gNB PM upload receiver. Mounted BEFORE the CSRF + JWT middleware so
 * the gNB can POST its performance-measurement files with plain HTTP
 * Basic auth (as configured in the gNB's Performance Management page).
 * Credentials: env GNB_PM_USER / GNB_PM_PASS (default gnb / gnb).
 */
const express = require('express');
const router = express.Router();
const GnbPm = require('../models/gnb-pm');
const parser = require('../services/gnb-pm-parser');

const USER = process.env.GNB_PM_USER || 'gnb';
const PASS = process.env.GNB_PM_PASS || 'gnb';

function checkBasic(req) {
  const h = req.headers['authorization'] || '';
  if (h.indexOf('Basic ') !== 0) return false;
  let dec = '';
  try { dec = Buffer.from(h.slice(6), 'base64').toString('utf8'); }
  catch (e) { return false; }
  const i = dec.indexOf(':');
  return dec.slice(0, i) === USER && dec.slice(i + 1) === PASS;
}

/* read the raw request body (XML / CSV / octet-stream); may include a
 * multipart wrapper which we strip to the inner document. */
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'string' && req.body.length) {
      return resolve(req.body);
    }
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function unwrapMultipart(text) {
  /* if multipart/form-data, extract the payload between the headers and
   * the closing boundary */
  const m = text.match(/\r?\n\r?\n([\s\S]*?)\r?\n--/);
  if (text.indexOf('Content-Disposition') >= 0 && m) return m[1];
  return text;
}

router.post(['/', '/upload'], async (req, res) => {
  if (!checkBasic(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="gnb-pm"');
    return res.status(401).send('unauthorized');
  }
  const raw = unwrapMultipart(await readBody(req));
  const { kpis, meta } = parser.parse(raw);
  const names = Object.keys(kpis);
  const kpiArr = names.map(function(n) { return { name: n, value: kpis[n] }; });

  try {
    await GnbPm.create({
      source_ip: (req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress || '').toString().split(',')[0].trim(),
      gnb_id: meta.gnb_id,
      filename: (req.query && req.query.filename) || meta.filename,
      period_start: meta.period_start ? new Date(meta.period_start) : undefined,
      period_end: meta.period_end ? new Date(meta.period_end) : undefined,
      granularity_s: meta.granularity_s,
      object_ldn: meta.object_ldn,
      kpis: kpiArr, kpi_count: names.length
    });
  } catch (e) { /* store best-effort */ }

  /* the gNB just needs a 200/204 to consider the upload successful */
  res.status(200).json({ ok: true, parsed_kpis: names.length });
});

module.exports = router;
