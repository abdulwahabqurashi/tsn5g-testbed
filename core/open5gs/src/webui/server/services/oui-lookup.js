/*
 * MAC OUI (vendor) lookup for downstream devices behind the UE.
 * Parses the IEEE OUI registry once into a prefix->vendor map. Falls
 * back to a small built-in table if the system registry is absent, and
 * flags locally-administered / randomized MACs (which have no vendor).
 */
const fs = require('fs');

const OUI_FILES = [
  '/usr/share/ieee-data/oui.txt',
  '/var/lib/ieee-data/oui.txt',
  '/usr/share/nmap/nmap-mac-prefixes',
  '/usr/share/wireshark/manuf'
];

/* common + industrial-automation fallbacks (keyed by 6-hex prefix) */
const FALLBACK = {
  '2ccf67': 'Raspberry Pi (Trading) Ltd',
  'b827eb': 'Raspberry Pi Foundation',
  'dca632': 'Raspberry Pi (Trading) Ltd',
  'e45f01': 'Raspberry Pi (Trading) Ltd',
  '2c7c31': 'Quectel Wireless',
  '000ecd': 'Beckhoff Automation',
  '0001cb': 'Siemens',
  '001b1b': 'Siemens',
  '0003bf': 'Siemens',
  '30057c': 'B&R Industrial Automation',
  '0060a7': 'Microscan / Omron',
  '001560': 'Phoenix Contact',
  'a0369f': 'Intel',
  '00155d': 'Microsoft (Hyper-V)'
};

let map = null;

function normPrefix(mac) {
  return String(mac || '').replace(/[^0-9a-fA-F]/g, '').slice(0, 6).toLowerCase();
}

function loadFrom(file) {
  const m = {};
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const line of lines) {
    /* IEEE oui.txt: "AABBCC   (base 16)   Vendor Name" */
    let mm = line.match(/^\s*([0-9A-Fa-f]{6})\s+\(base 16\)\s+(.+?)\s*$/);
    if (mm) { m[mm[1].toLowerCase()] = mm[2]; continue; }
    /* nmap-mac-prefixes: "AABBCC Vendor Name" */
    mm = line.match(/^([0-9A-Fa-f]{6})\s+(.+?)\s*$/);
    if (mm) { m[mm[1].toLowerCase()] = mm[2]; continue; }
    /* wireshark manuf: "AA:BB:CC\tShort\tVendor" */
    mm = line.match(/^([0-9A-Fa-f]{2}):([0-9A-Fa-f]{2}):([0-9A-Fa-f]{2})\s+\S+\s+(.+?)\s*$/);
    if (mm) { m[(mm[1] + mm[2] + mm[3]).toLowerCase()] = mm[4]; }
  }
  return m;
}

function ensure() {
  if (map) return map;
  for (const f of OUI_FILES) {
    try {
      if (fs.existsSync(f)) {
        const m = loadFrom(f);
        if (Object.keys(m).length > 100) {
          map = Object.assign({}, FALLBACK, m);
          return map;
        }
      }
    } catch (e) { /* try next */ }
  }
  map = Object.assign({}, FALLBACK);
  return map;
}

/* is the MAC locally-administered (bit 1 of first octet) -> randomized */
function isLocal(mac) {
  const b = parseInt(String(mac || '').replace(/[^0-9a-fA-F]/g, '').slice(0, 2), 16);
  return !isNaN(b) && (b & 0x02) !== 0;
}

function lookup(mac) {
  const p = normPrefix(mac);
  if (p.length < 6) return { mac, vendor: null, local: false };
  const local = isLocal(mac);
  const vendor = ensure()[p] || null;
  return {
    mac,
    vendor: vendor || (local ? 'Randomized / locally-administered' : 'Unknown vendor'),
    known: !!vendor,
    local
  };
}

function lookupMany(macs) {
  return (macs || []).map(lookup);
}

module.exports = { lookup, lookupMany };
