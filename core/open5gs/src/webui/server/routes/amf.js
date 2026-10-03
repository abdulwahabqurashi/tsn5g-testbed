const express = require('express');
const http = require('http');
const router = express.Router();

const AMF_METRICS_BASE = process.env.AMF_METRICS_URL || 'http://127.0.0.5:9090';
const SMF_METRICS_BASE = process.env.SMF_METRICS_URL || 'http://127.0.0.4:9090';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, function(res) {
      var chunks = [];
      res.on('data', function(chunk) {
        chunks.push(chunk);
      });
      res.on('end', function() {
        var raw = Buffer.concat(chunks).toString();
        var data = null;
        if (raw.length > 0) {
          try {
            data = JSON.parse(raw);
          } catch (e) {
            data = { message: raw };
          }
        }
        resolve({ status: res.statusCode, data: data });
      });
    }).on('error', function(err) {
      reject(err);
    });
  });
}

// GET /api/amf/UeInfo - fetch connected UE info from AMF
router.get('/UeInfo', async (req, res) => {
  try {
    var response = await httpGet(AMF_METRICS_BASE + '/ue-info');
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'AMF metrics unreachable' });
  }
});

// GET /api/amf/GnbInfo - fetch connected gNB info from AMF
router.get('/GnbInfo', async (req, res) => {
  try {
    var response = await httpGet(AMF_METRICS_BASE + '/gnb-info');
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'AMF metrics unreachable' });
  }
});

// GET /api/amf/PduInfo - fetch PDU session info from SMF
router.get('/PduInfo', async (req, res) => {
  try {
    var response = await httpGet(SMF_METRICS_BASE + '/pdu-info');
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'SMF metrics unreachable' });
  }
});

module.exports = router;
