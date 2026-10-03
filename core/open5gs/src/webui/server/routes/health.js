const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const router = express.Router();

/* ============================================================
 * /api/health/Config — startup configuration validation & drift
 * Flags the deployment-guide pitfalls before they bite: PLMN
 * consistency, security-order, Ethernet DNN/TAP mapping, freeDiameter
 * path, NW-TT config, TAP device presence, and template drift.
 * Dependency-free (no YAML lib): the fields we check are extracted
 * with anchored scanning of the known config structure.
 * ============================================================ */

const CFG_DIR = process.env.OGS_CONFIG_DIR ||
    path.join(__dirname, '../../../build/configs/open5gs');
const CFG_TMPL_DIR = process.env.OGS_CONFIG_TMPL_DIR ||
    path.join(__dirname, '../../../configs/open5gs');

function read(nf) {
  try { return fs.readFileSync(path.join(CFG_DIR, nf + '.yaml'), 'utf8'); }
  catch (e) { return null; }
}

/* first scalar value for `key:` anywhere in the text */
function val(text, key) {
  if (!text) return null;
  const m = text.match(new RegExp('(?:^|\\n)\\s*' + key + ':\\s*([^\\n#]+)'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/* all values for a repeated key (e.g. every `dnn:`) */
function vals(text, key) {
  if (!text) return [];
  const re = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*([^\\n#]+)', 'g');
  const out = []; let m;
  while ((m = re.exec(text))) out.push(m[1].trim().replace(/^["']|["']$/g, ''));
  return out;
}

/* PLMN as mcc/mnc from an amf/nrf-style block */
function plmnOf(text) {
  const mcc = val(text, 'mcc');
  const mnc = val(text, 'mnc');
  return (mcc && mnc) ? mcc + '/' + mnc : null;
}

function finding(id, ok, severity, title, detail, fix) {
  return { id, ok, severity: ok ? 'ok' : severity, title, detail, fix };
}

router.get('/Config', (req, res) => {
  const out = [];
  const amf = read('amf'), nrf = read('nrf'), smf = read('smf'),
        upf = read('upf'), udm = read('udm');

  /* --- files present at all --- */
  ['amf', 'smf', 'upf', 'nrf', 'pcf', 'tsn-af'].forEach((nf) => {
    out.push(finding('file-' + nf, read(nf) != null, 'critical',
      nf.toUpperCase() + ' config present',
      read(nf) != null ? 'found ' + nf + '.yaml' : 'missing ' + nf + '.yaml',
      'run `meson setup build` to regenerate configs'));
  });

  /* --- PLMN consistency (AMF vs NRF) --- */
  const amfPlmn = plmnOf(amf), nrfPlmn = plmnOf(nrf);
  out.push(finding('plmn-consistency',
    amfPlmn && nrfPlmn && amfPlmn === nrfPlmn, 'critical',
    'PLMN consistent across AMF and NRF',
    'AMF=' + (amfPlmn || '?') + '  NRF=' + (nrfPlmn || '?'),
    'align mcc/mnc in amf.yaml.in and nrf.yaml.in (a mismatch causes ' +
    'Registration reject [95])'));

  /* --- security: NIA0 must not lead integrity_order --- */
  if (amf) {
    const im = amf.match(/integrity_order\s*:\s*\[([^\]]*)\]/);
    const order = im ? im[1].split(',').map(s => s.trim()) : [];
    out.push(finding('integrity-order',
      order.length > 0 && order[0] !== 'NIA0', 'warning',
      'Integrity order does not lead with NIA0',
      order.length ? 'integrity_order = [' + order.join(', ') + ']' :
        'integrity_order not set',
      'set integrity_order: [ NIA2, NIA1 ] (NIA0 first causes ' +
      'Registration reject [23])'));
  }

  /* --- SMF: Ethernet DNN bound to a TAP device --- */
  if (smf) {
    const hasTsn = /dnn:\s*TSN/i.test(smf);
    const tsnBlock = smf.match(/dnn:\s*TSN[\s\S]{0,120}/i);
    const usesTap = tsnBlock && /dev:\s*ogstap/i.test(tsnBlock[0]);
    out.push(finding('smf-eth-tap', !hasTsn || usesTap, 'critical',
      'Ethernet DNN (TSN) bound to a TAP device',
      hasTsn ? (usesTap ? 'DNN TSN → dev ogstap' :
        'DNN TSN found but not on a TAP device') : 'no TSN DNN configured',
      'Ethernet PDU sessions need dev: ogstap (a TUN device silently ' +
      'breaks L2 sessions)'));

    /* --- freeDiameter path exists --- */
    const fdPath = val(smf, 'freeDiameter');
    let fdOk = false;
    if (fdPath) { try { fdOk = fs.existsSync(fdPath); } catch (e) {} }
    out.push(finding('smf-freediameter', !fdPath || fdOk, 'critical',
      'SMF freeDiameter config path exists',
      fdPath ? (fdOk ? fdPath : fdPath + ' — NOT FOUND') : 'not configured',
      'point freeDiameter: at an existing file (a missing path exits ' +
      'the SMF at startup)'));
  }

  /* --- UPF: NW-TT enabled + ogstap + dl_mac_adaptation --- */
  if (upf) {
    const nwttOn = /nwtt:\s*[\s\S]{0,40}enabled:\s*true/i.test(upf);
    out.push(finding('upf-nwtt', nwttOn, 'warning',
      'UPF NW-TT enabled',
      nwttOn ? 'nwtt.enabled = true' : 'NW-TT disabled',
      'enable nwtt for TSN bridging'));
    const dlAdapt = /dl_mac_adaptation:\s*true/i.test(upf);
    out.push(finding('upf-dl-adapt', dlAdapt, 'info',
      'Downlink MAC adaptation (routed-mode UE)',
      dlAdapt ? 'enabled' : 'disabled',
      'enable nwtt.dl_mac_adaptation for 5G routers that do not bridge ' +
      'downlink unicast'));
  }

  /* --- runtime: TAP device present --- */
  const tapUp = (() => {
    try { return fs.existsSync('/sys/class/net/ogstap'); }
    catch (e) { return false; }
  })();
  out.push(finding('tap-present', tapUp, 'critical',
    'ogstap TAP interface present',
    tapUp ? 'ogstap exists' : 'ogstap missing',
    'create it: sudo ip tuntap add name ogstap mode tap (run5gs.sh does this)'));

  /* --- drift: generated .yaml older than its .yaml.in template --- */
  ['amf', 'smf', 'upf', 'nrf', 'pcf', 'udm'].forEach((nf) => {
    let stale = false, have = false;
    try {
      const g = fs.statSync(path.join(CFG_DIR, nf + '.yaml')).mtimeMs;
      const t = fs.statSync(path.join(CFG_TMPL_DIR, nf + '.yaml.in')).mtimeMs;
      have = true; stale = t > g;
    } catch (e) {}
    if (have)
      out.push(finding('drift-' + nf, !stale, 'warning',
        nf.toUpperCase() + ' config up to date with template',
        stale ? 'template is newer than the generated config' : 'current',
        'regenerate: `meson setup build --reconfigure` (edits to .yaml ' +
        'are lost; always edit .yaml.in)'));
  });

  /* --- cross-check PLMN against a provisioned subscriber (best effort) --- */
  finishWithSubscriber(out, amfPlmn, res);
});

/* async subscriber PLMN check via mongosh, then respond */
function finishWithSubscriber(out, amfPlmn, res) {
  const respond = () => {
    const summary = {
      total: out.length,
      ok: out.filter(f => f.ok).length,
      critical: out.filter(f => !f.ok && f.severity === 'critical').length,
      warning: out.filter(f => !f.ok && f.severity === 'warning').length,
      info: out.filter(f => !f.ok && f.severity === 'info').length
    };
    res.json({ ts: Date.now(), summary, findings: out });
  };

  if (!amfPlmn) return respond();
  execFile('mongosh', ['--quiet', 'open5gs', '--eval',
    'var s=db.subscribers.findOne({},{imsi:1}); print(s?"IMSI="+s.imsi:"")'],
    { timeout: 4000, env: Object.assign({}, process.env, { HOME: '/tmp' }) },
    (err, stdout) => {
      /* mongosh may emit warning lines; pull the tagged 15-digit IMSI */
      const m = (stdout || '').match(/IMSI=(\d{5,15})/);
      const imsi = m ? m[1] : null;
      if (imsi) {
        const parts = amfPlmn.split('/');
        const mcc = parts[0], mnc = parts[1];
        /* IMSI = MCC(3) + MNC(2|3) + MSIN */
        const match = imsi.indexOf(mcc) === 0 &&
            (imsi.slice(3, 3 + mnc.length) === mnc.padStart(mnc.length, '0'));
        out.push(finding('plmn-subscriber', match, 'warning',
          'Subscriber IMSI matches core PLMN',
          'IMSI ' + imsi.slice(0, 5) + '…  core PLMN ' + mcc + '/' + mnc,
          'provision subscribers under the core PLMN (MCC+MNC prefix)'));
      }
      respond();
    });
}

module.exports = router;
