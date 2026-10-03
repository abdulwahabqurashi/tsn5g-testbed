/**
 * Extract a numeric metric value from dashboard data.
 * @param {string} metricPath - dot-notation metric identifier
 * @param {object} data - dashboard data { nwtt, tsn, ues, gnbs, pdus }
 * @returns {number|null}
 */
export function extractMetric(metricPath, data) {
  if (!data) return null;

  var ports = (data.nwtt && data.nwtt.ports) || [];

  switch (metricPath) {
    case 'nwtt.jitter_current_us': {
      var maxJitter = null;
      ports.forEach(function(p) {
        var j = (p.jitter || {}).current_us;
        if (j != null && (maxJitter === null || j > maxJitter)) maxJitter = j;
      });
      return maxJitter;
    }

    case 'nwtt.residence_avg_us': {
      var maxRes = null;
      ports.forEach(function(p) {
        var r = (p.residence_time || {}).avg_us;
        if (r != null && (maxRes === null || r > maxRes)) maxRes = r;
      });
      return maxRes;
    }

    case 'nwtt.psfp_drop_pct': {
      var totalPassed = 0, totalDropped = 0;
      ports.forEach(function(p) {
        var pf = p.psfp || {};
        totalPassed += pf.passed_frames || 0;
        totalDropped += pf.dropped_frames || 0;
      });
      var total = totalPassed + totalDropped;
      if (total === 0) return 0;
      return (totalDropped / total) * 100;
    }

    case 'nwtt.total_rx_frames': {
      var rx = 0;
      ports.forEach(function(p) { rx += (p.traffic || {}).rx_frames || 0; });
      return rx;
    }

    case 'ue.connected_count': {
      var ues = data.ues || {};
      var ueList = Array.isArray(ues) ? ues : (ues.ue_list || ues.items || []);
      var count = 0;
      ueList.forEach(function(u) { if (u.cm_state === 'connected' || u.cm_state === 'CM-CONNECTED') count++; });
      return count;
    }

    case 'ue.total_count': {
      var ues2 = data.ues || {};
      var list = Array.isArray(ues2) ? ues2 : (ues2.ue_list || ues2.items || []);
      return list.length;
    }

    case 'gnb.count': {
      var gnbs = data.gnbs || {};
      var gl = Array.isArray(gnbs) ? gnbs : (gnbs.gnb_list || gnbs.items || []);
      return gl.length;
    }

    case 'pdu.count': {
      var pdus = data.pdus || {};
      var pl = Array.isArray(pdus) ? pdus : (pdus.pdu_list || pdus.items || []);
      return pl.length;
    }

    default:
      return null;
  }
}

/**
 * Available metrics for alert configuration.
 */
export var AVAILABLE_METRICS = [
  { path: 'nwtt.jitter_current_us', label: 'Max Jitter (us)', unit: 'us' },
  { path: 'nwtt.residence_avg_us', label: 'Max Residence Time (us)', unit: 'us' },
  { path: 'nwtt.psfp_drop_pct', label: 'PSFP Drop Rate (%)', unit: '%' },
  { path: 'ue.connected_count', label: 'Connected UEs', unit: '' },
  { path: 'ue.total_count', label: 'Total UEs', unit: '' },
  { path: 'gnb.count', label: 'gNB Count', unit: '' },
  { path: 'pdu.count', label: 'PDU Sessions', unit: '' }
];
