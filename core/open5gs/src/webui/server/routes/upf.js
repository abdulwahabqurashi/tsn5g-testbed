const express = require('express');
const http = require('http');
const TsnMetric = require('../models/tsn-metric');
const router = express.Router();

const UPF_METRICS_BASE = process.env.UPF_METRICS_URL || 'http://127.0.0.7:9090';

/*
 * HTTP/1.1 proxy to UPF Prometheus metrics endpoint.
 * The UPF exposes /tsn-info as a custom metrics endpoint
 * that returns NW-TT port analytics as JSON.
 */
function upfRequest(path) {
  return new Promise((resolve, reject) => {
    var url = UPF_METRICS_BASE + path;

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

// GET /api/upf/TsnInfo - fetch NW-TT port analytics from UPF
router.get('/TsnInfo', async (req, res) => {
  try {
    var response = await upfRequest('/tsn-info');
    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(502).json({ message: 'UPF metrics unreachable' });
  }
});

// GET /api/upf/TsnHistory?range=15m|30m|1h|6h|24h|7d|30d&port=N
// Short ranges (<=24h) serve raw 15s samples, downsampled to ~360
// points. Long ranges (7d/30d) serve the hourly rollup collection.
const TsnMetricRollup = require('../models/tsn-metric-rollup');
const RANGE_MS = {
  '15m': 900000, '30m': 1800000, '1h': 3600000, '6h': 21600000,
  '24h': 86400000, '7d': 604800000, '30d': 2592000000
};
const TARGET_POINTS = 360;

function downsample(rows, target) {
  if (rows.length <= target) return rows;
  var step = rows.length / target;
  var out = [];
  for (var i = 0; i < rows.length; i += step) out.push(rows[Math.floor(i)]);
  return out;
}

router.get('/TsnHistory', async (req, res) => {
  try {
    var portNumber = parseInt(req.query.port, 10) || 0;
    var range = req.query.range || '1h';
    var rangeMs = RANGE_MS[range] || RANGE_MS['1h'];
    var since = new Date(Date.now() - rangeMs);

    /* long ranges: use the hourly rollup collection */
    if (range === '7d' || range === '30d') {
      var q = { bucket: { $gte: since } };
      if (portNumber > 0) q.port_number = portNumber;
      var buckets = await TsnMetricRollup.find(q)
        .sort({ bucket: 1 }).lean().exec();
      /* if multiple ports and none requested, keep the first port */
      var firstPort = portNumber || (buckets[0] && buckets[0].port_number);
      var result = buckets
        .filter(function(b) { return b.port_number === firstPort; })
        .map(function(b) {
          return {
            timestamp: b.bucket,
            gptp_synced: (b.gptp_synced_pct || 0) >= 50,
            downsampled: true,
            port: {
              port_number: b.port_number,
              residence_time_avg_us: b.residence_avg_us,
              residence_time_max_us: b.residence_max_us,
              jitter_current_us: b.jitter_avg_us,
              jitter_peak_us: b.jitter_peak_us,
              rx_frames: b.rx_frames, tx_frames: b.tx_frames,
              rx_bytes: b.rx_bytes, tx_bytes: b.tx_bytes,
              psfp_passed_frames: b.psfp_passed_frames,
              psfp_dropped_frames: b.psfp_dropped_frames,
              dl_mbps_avg: b.dl_mbps_avg, ul_mbps_avg: b.ul_mbps_avg
            }
          };
        });
      return res.json(result);
    }

    /* short ranges: raw samples, downsampled */
    var metrics = await TsnMetric.find({ timestamp: { $gte: since } })
      .sort({ timestamp: 1 }).lean().exec();

    var mapped = metrics.map(function(m) {
      var portData = portNumber > 0 ?
        (m.ports || []).filter(function(p) { return p.port_number === portNumber; })[0] :
        (m.ports || [])[0];
      return {
        timestamp: m.timestamp,
        gptp_synced: m.gptp_synced,
        port: portData || null
      };
    }).filter(function(r) { return r.port !== null; });

    res.json(downsample(mapped, TARGET_POINTS));
  } catch (error) {
    res.status(500).json({ message: 'Failed to query history' });
  }
});

module.exports = router;
