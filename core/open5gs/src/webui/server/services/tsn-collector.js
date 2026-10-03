/*
 * TSN Metrics Collector
 *
 * Periodically polls the UPF /tsn-info endpoint and stores
 * metric snapshots in MongoDB for historical analytics.
 */
const http = require('http');
const TsnMetric = require('../models/tsn-metric');
const TsnMetricRollup = require('../models/tsn-metric-rollup');
const alertEngine = require('./alert-engine');
const reportGen = require('./report-gen');
const backupGen = require('./backup-gen');

const UPF_METRICS_BASE = process.env.UPF_METRICS_URL || 'http://127.0.0.7:9090';
const POLL_INTERVAL_MS = parseInt(process.env.TSN_POLL_INTERVAL || '15000', 10);
const ROLLUP_INTERVAL_MS = 300000; /* aggregate every 5 min */

var collectorTimer = null;
var rollupTimer = null;

function fetchTsnInfo() {
  return new Promise(function(resolve, reject) {
    var req = http.get(UPF_METRICS_BASE + '/tsn-info', function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        try {
          var raw = Buffer.concat(chunks).toString();
          if (!raw || raw.length === 0) {
            resolve(null);
            return;
          }
          resolve(JSON.parse(raw));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(5000, function() { req.abort(); resolve(null); });
  });
}

function collectSnapshot() {
  fetchTsnInfo()
    .then(function(data) {
      if (!data || !data.ports) return;

      var bridge = data.bridge || {};
      var gptpMon = bridge.gptp_monitoring || {};

      var metric = new TsnMetric({
        bridge_id: bridge.id || 0,
        gptp_synced: gptpMon.synced || false,
        gptp_offset_ns: gptpMon.offset_from_master_ns || 0,
        ports: data.ports.map(function(p) {
          var traffic = p.traffic || {};
          var rt = p.residence_time || {};
          var jitter = p.jitter || {};
          var psfp = p.psfp || {};

          return {
            port_number: p.port_number,
            mac: p.mac || '',
            residence_time_min_us: rt.min_us,
            residence_time_avg_us: rt.avg_us,
            residence_time_max_us: rt.max_us,
            jitter_current_us: jitter.current_us,
            jitter_peak_us: jitter.peak_us,
            rx_frames: traffic.rx_frames,
            tx_frames: traffic.tx_frames,
            rx_bytes: traffic.rx_bytes,
            tx_bytes: traffic.tx_bytes,
            psfp_passed_frames: psfp.passed_frames,
            psfp_dropped_frames: psfp.dropped_frames,
            psfp_passed_bytes: psfp.passed_bytes,
            psfp_dropped_bytes: psfp.dropped_bytes
          };
        })
      });

      /* feed the server-side alert engine with a normalized snapshot */
      try {
        alertEngine.evaluate({ nwtt: data, ue_connected: undefined });
      } catch (e) { /* never let alerting break collection */ }

      return metric.save();
    })
    .catch(function() {
      /* Silently skip - UPF may not be running */
    });
}

/* Roll raw 15s samples up into hourly per-port buckets for long-term
 * (30-day) history. Idempotent upsert per (bucket, port). Only touches
 * complete-enough recent hours to keep it cheap. */
function rollupHourly() {
  var since = new Date(Date.now() - 3 * 3600000); /* last 3 hours */
  TsnMetric.find({ timestamp: { $gte: since } }).sort({ timestamp: 1 })
    .lean().exec()
    .then(function(rows) {
      if (!rows || !rows.length) return;
      var buckets = {}; /* key: hourMs|port */
      rows.forEach(function(m) {
        var hour = Math.floor(new Date(m.timestamp).getTime() / 3600000) * 3600000;
        (m.ports || []).forEach(function(p) {
          var key = hour + '|' + p.port_number;
          var b = buckets[key] || (buckets[key] = {
            hour: hour, port: p.port_number, n: 0,
            jitSum: 0, jitPeak: 0, resSum: 0, resMax: 0,
            offSum: 0, syncN: 0, first: null, last: null });
          b.n++;
          b.jitSum += p.jitter_current_us || 0;
          b.jitPeak = Math.max(b.jitPeak, p.jitter_peak_us || 0);
          b.resSum += p.residence_time_avg_us || 0;
          b.resMax = Math.max(b.resMax, p.residence_time_max_us || 0);
          b.offSum += Math.abs(m.gptp_offset_ns || 0);
          if (m.gptp_synced) b.syncN++;
          if (!b.first) b.first = { t: m.timestamp, rxb: p.rx_bytes || 0, txb: p.tx_bytes || 0 };
          b.last = { t: m.timestamp, p: p };
        });
      });
      var ops = Object.keys(buckets).map(function(k) {
        var b = buckets[k];
        var lp = b.last.p;
        var dtSec = (new Date(b.last.t) - new Date(b.first.t)) / 1000 || 1;
        var dlMbps = Math.max(0, ((lp.tx_bytes || 0) - b.first.txb) * 8 / dtSec / 1e6);
        var ulMbps = Math.max(0, ((lp.rx_bytes || 0) - b.first.rxb) * 8 / dtSec / 1e6);
        return TsnMetricRollup.updateOne(
          { bucket: new Date(b.hour), port_number: b.port },
          { $set: {
            samples: b.n,
            jitter_avg_us: b.jitSum / b.n,
            jitter_peak_us: b.jitPeak,
            residence_avg_us: b.resSum / b.n,
            residence_max_us: b.resMax,
            gptp_offset_avg_ns: b.offSum / b.n,
            gptp_synced_pct: (b.syncN / b.n) * 100,
            rx_frames: lp.rx_frames, tx_frames: lp.tx_frames,
            rx_bytes: lp.rx_bytes, tx_bytes: lp.tx_bytes,
            psfp_passed_frames: lp.psfp_passed_frames,
            psfp_dropped_frames: lp.psfp_dropped_frames,
            dl_mbps_avg: +dlMbps.toFixed(3), ul_mbps_avg: +ulMbps.toFixed(3)
          } },
          { upsert: true });
      });
      return Promise.all(ops);
    })
    .catch(function() { /* skip on error */ });
}

var reportTimer = null;
var lastReportDay = null;

/* generate a daily report once per calendar day (checked hourly) */
function maybeDailyReport() {
  var day = new Date().toISOString().slice(0, 10);
  if (day === lastReportDay) return;
  lastReportDay = day;
  reportGen.generateScheduled();
  backupGen.generateScheduled();
}

function start() {
  if (collectorTimer) return;
  collectSnapshot();
  collectorTimer = setInterval(collectSnapshot, POLL_INTERVAL_MS);
  rollupTimer = setInterval(rollupHourly, ROLLUP_INTERVAL_MS);
  reportTimer = setInterval(maybeDailyReport, 3600000);
  console.log('TSN metric collector started (interval: ' + POLL_INTERVAL_MS +
    'ms, rollup: ' + ROLLUP_INTERVAL_MS + 'ms)');
}

function stop() {
  if (collectorTimer) { clearInterval(collectorTimer); collectorTimer = null; }
  if (rollupTimer) { clearInterval(rollupTimer); rollupTimer = null; }
  if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
}

module.exports = { start: start, stop: stop };
