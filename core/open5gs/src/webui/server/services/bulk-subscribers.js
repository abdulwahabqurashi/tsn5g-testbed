/*
 * Bulk subscriber (SIM) provisioning via CSV.
 * Flat CSV <-> the Open5GS subscriber schema (imsi, security keys,
 * one slice/session with DNN, session type, AMBR and 5QI/ARP).
 * Covers the common single-DNN case used for TSN device fleets.
 */
const Subscriber = require('../models/subscriber');

const COLUMNS = ['imsi', 'k', 'opc', 'amf', 'dnn', 'session_type',
  'qos_index', 'dl_mbps', 'ul_mbps', 'sst'];

/* session type: accept number or name */
function sessionType(v) {
  if (v == null || v === '') return 1;
  const s = String(v).trim().toLowerCase();
  const map = { ipv4: 1, ipv6: 2, ipv4v6: 3, unstructured: 4, ethernet: 5 };
  if (map[s] != null) return map[s];
  const n = parseInt(s, 10);
  return isNaN(n) ? 1 : n;
}

function mbr(v, def) {
  const n = parseInt(v, 10);
  return { value: isNaN(n) ? def : n, unit: 2 };   /* unit 2 = Mbps */
}

function toDoc(row) {
  const imsi = (row.imsi || '').trim();
  if (!/^\d{6,15}$/.test(imsi)) return null;
  const dl = mbr(row.dl_mbps, 1000), ul = mbr(row.ul_mbps, 1000);
  return {
    imsi,
    security: {
      k: (row.k || '').trim() || '00112233445566778899AABBCCDDEEFF',
      amf: (row.amf || '').trim() || '8000',
      op: null,
      opc: (row.opc || '').trim() || '279EB54971771559879284FDDDE3EE0C'
    },
    ambr: { downlink: dl, uplink: ul },
    slice: [{
      sst: parseInt(row.sst, 10) || 1,
      default_indicator: true,
      session: [{
        name: (row.dnn || 'internet').trim(),
        type: sessionType(row.session_type),
        qos: {
          index: parseInt(row.qos_index, 10) || 9,
          arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 }
        },
        ambr: { downlink: dl, uplink: ul },
        pcc_rule: []
      }]
    }]
  };
}

/* parse CSV text -> array of row objects (header row required) */
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

async function importCSV(text) {
  const rows = parseCSV(text);
  let created = 0, updated = 0, skipped = 0;
  const errors = [];
  for (const row of rows) {
    const doc = toDoc(row);
    if (!doc) { skipped++; errors.push('bad IMSI: ' + (row.imsi || '(blank)')); continue; }
    try {
      const existing = await Subscriber.findOne({ imsi: doc.imsi }).lean().exec();
      await Subscriber.updateOne({ imsi: doc.imsi }, doc, { upsert: true });
      if (existing) updated++; else created++;
    } catch (e) { skipped++; errors.push(doc.imsi + ': ' + e.message); }
  }
  return { total: rows.length, created, updated, skipped, errors: errors.slice(0, 20) };
}

async function exportCSV() {
  const subs = await Subscriber.find({}).lean().exec();
  const head = COLUMNS.join(',');
  const body = subs.map(s => {
    const sess = (((s.slice || [])[0] || {}).session || [])[0] || {};
    const dl = ((s.ambr || {}).downlink || {}).value;
    const ul = ((s.ambr || {}).uplink || {}).value;
    return [
      s.imsi, (s.security || {}).k, (s.security || {}).opc, (s.security || {}).amf,
      sess.name || '', sess.type != null ? sess.type : '',
      ((sess.qos || {}).index) != null ? sess.qos.index : '',
      dl != null ? dl : '', ul != null ? ul : '',
      ((s.slice || [])[0] || {}).sst || 1
    ].join(',');
  }).join('\n');
  return head + '\n' + body + '\n';
}

const TEMPLATE = COLUMNS.join(',') + '\n' +
  '999700000000001,00112233445566778899AABBCCDDEEFF,279EB54971771559879284FDDDE3EE0C,8000,TSN,ethernet,9,40,100,1\n';

module.exports = { importCSV, exportCSV, TEMPLATE, COLUMNS, toDoc, sessionType };
