const express = require('express');
const { execFile, spawn } = require('child_process');
const router = express.Router();

/* GET /api/ue/Latency?target=<ip>
 * Active RTT to the device over the 5G data path (the core host can reach the
 * device-side IP through the NW-TT bridge). Returns min/avg/max/mdev + loss. */
router.get('/Latency', (req, res) => {
  const target = req.query.target;
  if (!target || !/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(target)) {
    return res.json({ available: false, reason: 'no/invalid target' });
  }
  execFile('ping', ['-n', '-c', '3', '-i', '0.2', '-W', '1', target],
    { timeout: 5000 }, (err, stdout) => {
      const out = stdout || '';
      let loss = 100;
      const lm = out.match(/(\d+(?:\.\d+)?)% packet loss/);
      if (lm) loss = parseFloat(lm[1]);
      const rm = out.match(/= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/);
      if (rm) {
        res.json({ available: true, min: +rm[1], avg: +rm[2], max: +rm[3], mdev: +rm[4], loss });
      } else {
        res.json({ available: true, min: null, avg: null, max: null, mdev: null, loss });
      }
    });
});

/* GET /api/ue/SpeedTest?target=<ip>&duration=<s>
 * Active three-phase UE speed test over the 5G data path using iperf3
 * (the device must run `iperf3 -s`):
 *   1. TCP download (core -> device)
 *   2. TCP upload   (device -> core, iperf3 -R)
 *   3. UDP download at 45M: true capacity + jitter + loss
 * Returns everything as one JSON document. One test at a time. */
let speedTestBusy = false;

function iperf(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('iperf3', args.concat(['-J']),
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (!stdout) {
          return resolve({ error: (err && err.message) || 'no output' });
        }
        try { resolve(JSON.parse(stdout)); }
        catch (e) { resolve({ error: 'parse failed' }); }
      });
  });
}

function mbps(bps) { return bps == null ? null : +(bps / 1e6).toFixed(2); }

router.get('/SpeedTest', async (req, res) => {
  const target = req.query.target;
  if (!target || !/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(target)) {
    return res.status(400).json({ error: 'invalid target' });
  }
  if (speedTestBusy) {
    return res.status(409).json({ error: 'test already running' });
  }
  const dur = String(Math.min(Math.max(
      parseInt(req.query.duration || '5', 10) || 5, 3), 30));
  const udpRate = /^[0-9]{1,4}[KMG]$/.test(req.query.udp_rate || '') ?
      req.query.udp_rate : '45M';
  speedTestBusy = true;
  const out = { target, duration: +dur, ts: Date.now() };

  /* --- single configurable test (mode=single): expose the full iperf3
   * option surface, every parameter validated before reaching execFile --- */
  if (req.query.mode === 'single') {
    const q = req.query;
    const proto = q.proto === 'udp' ? 'udp' : 'tcp';
    const direction = ['ul', 'bidir'].indexOf(q.direction) >= 0 ?
        q.direction : 'dl';
    const args = ['-c', target, '-t', dur];

    const streams = Math.min(Math.max(parseInt(q.streams || '1', 10) || 1, 1), 16);
    if (streams > 1) args.push('-P', String(streams));
    const omit = Math.min(Math.max(parseInt(q.omit || '0', 10) || 0, 0), 10);
    if (omit) args.push('-O', String(omit));
    const len = parseInt(q.len || '0', 10) || 0;
    if (len >= 36 && len <= 65507) args.push('-l', String(len));
    const dscp = q.dscp === undefined || q.dscp === '' ?
        null : parseInt(q.dscp, 10);
    if (dscp != null && dscp >= 0 && dscp <= 63)
      args.push('--dscp', String(dscp));
    const win = /^[0-9]{1,5}[KM]$/.test(q.window || '') ? q.window : null;
    if (win) args.push('-w', win);

    if (proto === 'udp') {
      args.push('-u', '-b', udpRate);
    } else {
      const mss = parseInt(q.mss || '0', 10) || 0;
      if (mss >= 88 && mss <= 9216) args.push('-M', String(mss));
      if (q.cc === 'cubic' || q.cc === 'reno') args.push('-C', q.cc);
    }
    if (direction === 'ul') args.push('-R');
    if (direction === 'bidir') args.push('--bidir');

    try {
      const r = await iperf(args, (parseInt(dur, 10) + 20) * 1000);
      if (r.error) {
        out.error = r.error.indexOf('unable to connect') >= 0 ?
            'unable to connect - is iperf3 -s running on the device?' : r.error;
      } else {
        const end = r.end || {};
        const single = { proto, direction, streams,
          args: args.slice(2).join(' ') };
        if (proto === 'udp') {
          const sum = end.sum || {};
          single.mbps = mbps(sum.bits_per_second);
          single.jitter_ms = sum.jitter_ms != null ?
              +sum.jitter_ms.toFixed(3) : null;
          single.loss_pct = sum.lost_percent != null ?
              +sum.lost_percent.toFixed(2) : null;
        } else {
          single.mbps = mbps((end.sum_received || {}).bits_per_second);
          single.retransmits = (end.sum_sent || {}).retransmits;
          if (direction === 'bidir') {
            const rev = end.sum_received_bidir_reverse ||
                end.sum_sent_bidir_reverse || {};
            single.rev_mbps = mbps(rev.bits_per_second);
          }
        }
        const cpu = r.end && r.end.cpu_utilization_percent;
        if (cpu) single.cpu = {
          local: +cpu.host_total.toFixed(1),
          remote: +cpu.remote_total.toFixed(1)
        };
        out.single = single;
      }
    } finally {
      speedTestBusy = false;
    }
    return res.json(out);
  }

  try {
    /* phase 1: TCP download (core sends) */
    let r = await iperf(['-c', target, '-t', dur], 40000);
    if (r.error) { out.error = 'download: ' + r.error; }
    else {
      out.dl = {
        mbps: mbps(((r.end || {}).sum_received || {}).bits_per_second),
        retransmits: ((r.end || {}).sum_sent || {}).retransmits
      };
    }

    /* phase 2: TCP upload (device sends) */
    r = await iperf(['-c', target, '-t', dur, '-R'], 40000);
    if (!r.error) {
      out.ul = {
        mbps: mbps(((r.end || {}).sum_received || {}).bits_per_second),
        retransmits: ((r.end || {}).sum_sent || {}).retransmits
      };
    }

    /* phase 3: UDP downlink capacity + jitter + loss */
    r = await iperf(['-c', target, '-t', dur, '-u', '-b', udpRate], 40000);
    if (!r.error) {
      const sum = (r.end || {}).sum || {};
      out.udp = {
        mbps: mbps(sum.bits_per_second),
        jitter_ms: sum.jitter_ms != null ? +sum.jitter_ms.toFixed(3) : null,
        loss_pct: sum.lost_percent != null ? +sum.lost_percent.toFixed(2) : null
      };
    }
  } finally {
    speedTestBusy = false;
  }
  res.json(out);
});

/* GET /api/ue/IperfServer?action=start|stop|status
 * Server mode: run `iperf3 -s` on the core so devices behind the UE can
 * initiate tests themselves (iperf3 -c <core-ip> [-R] [-u -b 45M]).
 * Each completed test's summary is captured from the JSON stream and
 * kept (last 8) for the UI to display. */
let iperfServer = null;
let serverResults = [];
let serverBuf = '';

function harvestServerJson() {
  /* extract complete top-level JSON objects from the accumulated stream */
  let depth = 0, start = -1;
  for (let i = 0; i < serverBuf.length; i++) {
    const c = serverBuf[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(serverBuf.slice(start, i + 1));
          const end = obj.end || {};
          const sum = end.sum_received || end.sum || {};
          const ts = ((obj.start || {}).test_start) || {};
          const conn = ((obj.start || {}).connected || [])[0] || {};
          serverResults.unshift({
            ts: Date.now(),
            client: conn.remote_host,
            proto: ts.protocol,
            reverse: !!ts.reverse,
            mbps: sum.bits_per_second != null ?
                +(sum.bits_per_second / 1e6).toFixed(2) : null,
            jitter_ms: sum.jitter_ms != null ?
                +sum.jitter_ms.toFixed(3) : undefined,
            loss_pct: sum.lost_percent != null ?
                +sum.lost_percent.toFixed(2) : undefined
          });
          serverResults = serverResults.slice(0, 8);
        } catch (e) { /* incomplete/garbled — ignore */ }
        serverBuf = serverBuf.slice(i + 1);
        i = -1; depth = 0; start = -1;
      }
    }
  }
  if (serverBuf.length > 1048576) serverBuf = '';
}

router.get('/IperfServer', (req, res) => {
  const action = req.query.action || 'status';
  if (action === 'start' && !iperfServer) {
    iperfServer = spawn('iperf3', ['-s', '-J', '--forceflush']);
    serverBuf = '';
    iperfServer.stdout.on('data', (d) => {
      serverBuf += d.toString();
      harvestServerJson();
    });
    iperfServer.on('exit', () => { iperfServer = null; });
    iperfServer.on('error', () => { iperfServer = null; });
  }
  if (action === 'stop' && iperfServer) {
    iperfServer.kill();
    iperfServer = null;
  }
  res.json({ running: !!iperfServer, port: 5201, results: serverResults });
});

module.exports = router;
