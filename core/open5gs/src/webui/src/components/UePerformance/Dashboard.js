import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';
import { isOperator } from 'helpers/role';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const UNIFI_TOOLTIP = {
  background: '#ffffff', border: 'none', borderRadius: 10,
  boxShadow: '0 4px 16px rgba(16,24,40,0.14)',
  color: 'var(--text-primary)', fontSize: 12
};
const AXIS_TICK = { fontSize: 11, fill: 'var(--text-muted)' };

const BLUE = '#478ff7';
const GREEN = '#9e7be0';   /* UniFi pairs blue with purple */
const AMBER = '#f5a524';
const MAX_POINTS = 90;

const Wrapper = styled.div`width: 100%; padding: 1rem;`;
const TitleRow = styled.div`
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
  h2 { margin: 0; font-size: 20px; font-weight: 700; color: var(--text-primary); }
  .sub { font-size: 11px; color: var(--text-muted); }
`;
const TargetBox = styled.div`
  display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary);
  input { width: 150px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border-color);
    background: var(--bg-input); color: var(--text-primary); font-family: monospace; font-size: 12px; }
`;
const KpiRow = styled.div`
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 1.25rem;
  @media (max-width: 1024px) { grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 600px) { grid-template-columns: repeat(2, 1fr); }
`;
const Kpi = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  padding: 14px 16px; position: relative; overflow: hidden;
  &::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: ${p => p.ac || 'var(--accent)'}; }
  .v { font-size: 22px; font-weight: 800; color: var(--text-primary); }
  .l { font-size: 11px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; color: var(--text-muted); }
  .s { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
`;
const Card = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  padding: 18px 20px; margin-bottom: 1.25rem;
  h3 { margin: 0 0 4px; font-size: 12px; font-weight: 700; letter-spacing: .6px;
    text-transform: uppercase; color: var(--text-muted); }
  .note { font-size: 12px; color: var(--text-muted); margin: 0 0 12px; }
`;
const Two = styled.div`
  display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem;
  @media (max-width: 768px) { grid-template-columns: 1fr; }
`;
const Chip = styled.span`
  display: inline-flex; align-items: center;
  background: #ffffff; border: 1px solid var(--border-color);
  border-radius: 8px; padding: 3px 10px;
  font-size: 12px; font-weight: 500; color: var(--text-secondary);
  &::before { content: ''; width: 10px; height: 3px; border-radius: 2px;
    margin-right: 6px; background: ${p => p.c}; }
`;
const ChipRow = styled.div`display: flex; gap: 8px; margin-bottom: 10px;`;

const SpeedGrid = styled.div`
  display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px;
  align-items: center; margin: 6px 0 12px;
  @media (max-width: 900px) { grid-template-columns: 1fr; }
`;
const SpeedBig = styled.div`
  text-align: center; padding: 10px 0;
  .num { font-size: 44px; font-weight: 800; letter-spacing: -1px;
    color: ${p => p.c || 'var(--text-primary)'};
    font-variant-numeric: tabular-nums; line-height: 1.05; }
  .unit { font-size: 13px; color: var(--text-muted); font-weight: 600; }
  .lbl { font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .07em; color: var(--text-muted); margin-bottom: 4px; }
`;
const SpeedMeta = styled.div`
  display: flex; gap: 18px; justify-content: center; flex-wrap: wrap;
  font-size: 12px; color: var(--text-secondary);
  b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
`;
const RunButton = styled.button`
  display: inline-flex; align-items: center; justify-content: center;
  padding: 10px 26px; border: none; border-radius: 10px;
  background: ${p => p.disabled ? '#b9d4fb' : 'var(--accent)'};
  color: #fff; font-size: 14px; font-weight: 700; cursor: ${p => p.disabled ? 'default' : 'pointer'};
  transition: background .15s ease;
  &:hover { background: ${p => p.disabled ? '#b9d4fb' : '#0059d6'}; }
`;
const PhaseBar = styled.div`
  height: 6px; border-radius: 3px; background: var(--divider);
  overflow: hidden; margin-top: 10px;
  .fill { height: 100%; border-radius: 3px; background: var(--accent);
    transition: width .8s linear; width: ${p => p.pct}%; }
`;
const HistTable = styled.table`
  width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px;
  th { padding: 4px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid var(--divider);
    color: var(--text-secondary); font-variant-numeric: tabular-nums; }
`;

const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 13px;
  td { padding: 7px 6px; border-bottom: 1px solid var(--divider); color: var(--text-secondary); }
  td:last-child { color: var(--text-primary); font-weight: 600; font-family: monospace; text-align: right; }
`;

function fmt(n, d) { return (n == null) ? '--' : Number(n).toFixed(d == null ? 2 : d); }

const PHASES = ['Testing download (TCP)…', 'Testing upload (TCP)…',
  'Measuring capacity & jitter (UDP)…'];

function mapSingle(s) {
  const v = {};
  if (s.proto === 'udp') {
    v.udp = { mbps: s.mbps, jitter_ms: s.jitter_ms, loss_pct: s.loss_pct };
    if (s.direction === 'dl') v.dl = { mbps: s.mbps };
    else v.ul = { mbps: s.mbps };
  } else {
    if (s.direction === 'ul') v.ul = { mbps: s.mbps, retransmits: s.retransmits };
    else v.dl = { mbps: s.mbps, retransmits: s.retransmits };
    if (s.direction === 'bidir') v.ul = { mbps: s.rev_mbps };
  }
  v.meta = s;
  return v;
}

class Dashboard extends Component {
  state = { history: [], test: null, testing: false, phase: 0, testHistory: [],
    mode: 'client', server: { running: false, results: [] },
    preset: 'full',
    opts: { proto: 'tcp', direction: 'dl', duration: 5, streams: 1,
      bitrate: '45M', len: '', mss: '', dscp: '', cc: '', window: '', omit: 0 } };
  _prev = null;
  _t0 = null;

  componentWillUnmount() {
    if (this._phaseTimer) clearInterval(this._phaseTimer);
    if (this._srvPoll) clearInterval(this._srvPoll);
  }

  authHeaders() {
    const sessionData = new Session();
    const csrf = ((sessionData || {}).session || {}).csrfToken;
    const authToken = ((sessionData || {}).session || {}).authToken;
    const headers = { 'X-CSRF-TOKEN': csrf };
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    return headers;
  }

  setMode = (mode) => {
    this.setState({ mode });
    if (this._srvPoll) { clearInterval(this._srvPoll); this._srvPoll = null; }
    if (mode === 'server') {
      this.pollServer();
      this._srvPoll = setInterval(() => this.pollServer(), 4000);
    }
  };

  pollServer(action) {
    axios({
      baseURL: '/api/ue', url: '/IperfServer', method: 'get',
      headers: this.authHeaders(), params: action ? { action } : {}
    }).then(res => {
      this.setState({ server: res.data || { running: false, results: [] } });
    }).catch(() => {});
  }

  toggleServer = () => {
    this.pollServer(this.state.server.running ? 'stop' : 'start');
  };

  setOpt = (k, v) => {
    const opts = Object.assign({}, this.state.opts);
    opts[k] = v;
    this.setState({ opts });
  };

  runTest = () => {
    if (this.state.testing) return;
    const target = (this.props.target || '').trim() || '192.168.8.195';
    const custom = this.state.preset === 'custom';
    const o = this.state.opts;
    const duration = custom ? (parseInt(o.duration, 10) || 5) : 5;
    const headers = this.authHeaders();

    const params = custom ? {
      mode: 'single', target, duration,
      proto: o.proto, direction: o.direction, streams: o.streams,
      udp_rate: o.bitrate, len: o.len, mss: o.mss, dscp: o.dscp,
      cc: o.cc, window: o.window, omit: o.omit
    } : { target, duration };

    this.setState({ testing: true, phase: 0, test: null });
    /* advance the phase label roughly in step with the server */
    let ph = 0;
    if (!custom) {
      this._phaseTimer = setInterval(() => {
        ph = Math.min(ph + 1, PHASES.length - 1);
        this.setState({ phase: ph });
      }, (duration + 2) * 1000);
    }

    axios({
      baseURL: '/api/ue', url: '/SpeedTest', method: 'get', headers,
      params, timeout: (duration * 4 + 90) * 1000
    }).then(res => {
      clearInterval(this._phaseTimer);
      let t = res.data || {};
      if (t.single) t = Object.assign({}, t, mapSingle(t.single));
      const hist = [{ when: new Date().toLocaleTimeString(), ...t }]
        .concat(this.state.testHistory).slice(0, 6);
      this.setState({ testing: false, test: t, testHistory: hist });
    }).catch(err => {
      clearInterval(this._phaseTimer);
      const msg = ((err.response || {}).data || {}).error || err.message;
      this.setState({ testing: false, test: { error: msg } });
    });
  };

  componentWillReceiveProps(next) {
    const data = next.data;
    if (!data || data === this.props.data || !data.ts) return;
    const port = ((data.nwtt || {}).ports || [])[0] || {};
    const tr = port.traffic || {};
    if (this._t0 == null) this._t0 = data.ts;
    if (this._prev) {
      const dt = (data.ts - this._prev.ts) / 1000;
      if (dt > 0) {
        const ul = Math.max(0, (tr.rx_bytes - this._prev.rx) * 8 / dt / 1e6);
        const dl = Math.max(0, (tr.tx_bytes - this._prev.tx) * 8 / dt / 1e6);
        const ulp = Math.max(0, (tr.rx_frames - this._prev.rxf) / dt);
        const dlp = Math.max(0, (tr.tx_frames - this._prev.txf) / dt);
        const lat = (data.latency && data.latency.avg != null) ? data.latency.avg : null;
        const hist = this.state.history.concat([{
          t: Math.round((data.ts - this._t0) / 1000),
          dl: +dl.toFixed(3), ul: +ul.toFixed(3),
          dlp: Math.round(dlp), ulp: Math.round(ulp), lat: lat
        }]);
        if (hist.length > MAX_POINTS) hist.shift();
        this.setState({ history: hist });
      }
    }
    this._prev = { ts: data.ts, rx: tr.rx_bytes || 0, tx: tr.tx_bytes || 0,
      rxf: tr.rx_frames || 0, txf: tr.tx_frames || 0 };
  }

  render() {
    const { data, lastUpdated, target, onTarget } = this.props;
    const h = this.state.history;
    const port = (((data || {}).nwtt || {}).ports || [])[0] || {};
    const tr = port.traffic || {};
    const psfp = port.psfp || {};
    const pdu = ((((data || {}).pdu || {}).items || [])[0] || {});
    const pduFlow = (((pdu.pdu || [])[0] || {}).qos_flows || [])[0] || {};
    const cm = (((((data || {}).ue || {}).items || [])[0]) || {}).cm_state || '--';
    const lat = (data || {}).latency || null;

    const peak = (k) => h.reduce((m, x) => Math.max(m, x[k] || 0), 0);
    const avg = (k) => { const v = h.filter(x => x[k] != null); return v.length ? v.reduce((s, x) => s + x[k], 0) / v.length : 0; };

    return (
      <Wrapper>
        <TitleRow>
          <div>
            <h2>UE Performance</h2>
            <span className="sub">{lastUpdated ? 'live · updated ' + new Date(lastUpdated).toLocaleTimeString() : 'connecting…'} · 2s poll</span>
          </div>
          <TargetBox>
            latency target
            <input value={target || ''} placeholder="device IP"
              onChange={(e) => onTarget(e.target.value.trim())} />
          </TargetBox>
        </TitleRow>

        <KpiRow>
          <Kpi ac={BLUE}><div className="l">Peak DL</div><div className="v">{fmt(peak('dl'))}</div><div className="s">Mbps · avg {fmt(avg('dl'))}</div></Kpi>
          <Kpi ac={GREEN}><div className="l">Peak UL</div><div className="v">{fmt(peak('ul'))}</div><div className="s">Mbps · avg {fmt(avg('ul'))}</div></Kpi>
          <Kpi ac={AMBER}><div className="l">Latency</div><div className="v">{lat && lat.avg != null ? fmt(lat.avg, 1) : '--'}</div><div className="s">{lat && lat.avg != null ? 'ms RTT · max ' + fmt(lat.max, 1) : (target ? 'no reply' : 'set target')}</div></Kpi>
          <Kpi ac={AMBER}><div className="l">Ping loss</div><div className="v">{lat && lat.loss != null ? fmt(lat.loss, 0) + '%' : '--'}</div><div className="s">active probe</div></Kpi>
          <Kpi ac={GREEN}><div className="l">Dropped</div><div className="v">{psfp.dropped_frames || 0}</div><div className="s">PSFP policed</div></Kpi>
          <Kpi ac={BLUE}><div className="l">State</div><div className="v" style={{fontSize:'16px'}}>{cm}</div><div className="s">5QI {pduFlow['5qi'] != null ? pduFlow['5qi'] : '--'}</div></Kpi>
        </KpiRow>

        <Card>
          <h3>Speed Test</h3>
          {!isOperator() &&
            <p className="note">Read-only access — active tests require the operator role.</p>}
          {isOperator() &&
          <div style={{display:'inline-flex', gap:2, padding:3, background:'#f0f2f5', borderRadius:10, marginBottom:10}}>
            {[['client','Client Test'],['server','Server Mode']].map(m =>
              <div key={m[0]} onClick={() => this.setMode(m[0])}
                style={{padding:'6px 16px', fontSize:13, fontWeight:600, cursor:'pointer',
                  borderRadius:8,
                  background:this.state.mode===m[0]?'#fff':'transparent',
                  boxShadow:this.state.mode===m[0]?'0 1px 3px rgba(16,24,40,0.12)':'none',
                  color:this.state.mode===m[0]?'var(--text-primary)':'var(--text-secondary)'}}>
                {m[1]}
              </div>)}
          </div>}
          {isOperator() && this.state.mode === 'server' ? (() => {
            const srv = this.state.server || {};
            return (
              <div>
                <p className="note">The core runs <code>iperf3 -s</code> — start any test <b>from the device</b>:{' '}
                  <code>iperf3 -c 192.168.8.5</code> (upload) · <code>iperf3 -c 192.168.8.5 -R</code> (download) · <code>iperf3 -c 192.168.8.5 -u -b 45M</code> (jitter/loss). Results appear below.</p>
                <div style={{display:'flex', alignItems:'center', gap:14, margin:'6px 0 4px'}}>
                  <RunButton onClick={this.toggleServer}>
                    {srv.running ? 'Stop Server' : 'Start Server'}
                  </RunButton>
                  <span style={{fontSize:13, fontWeight:600,
                    color: srv.running ? 'var(--ok)' : 'var(--text-muted)'}}>
                    {srv.running ? '● listening on :' + (srv.port || 5201) : '○ stopped'}
                  </span>
                </div>
                {(srv.results || []).length > 0 &&
                  <HistTable>
                    <thead><tr><th>Time</th><th>Client</th><th>Proto</th><th>Direction</th><th>Mbps</th><th>Jitter</th><th>Loss</th></tr></thead>
                    <tbody>
                      {srv.results.map((r, i) =>
                        <tr key={i}>
                          <td>{new Date(r.ts).toLocaleTimeString()}</td>
                          <td>{r.client || '--'}</td>
                          <td>{r.proto || '--'}</td>
                          <td>{r.reverse ? 'DL (core→dev)' : 'UL (dev→core)'}</td>
                          <td>{r.mbps != null ? r.mbps : '--'}</td>
                          <td>{r.jitter_ms != null ? r.jitter_ms + ' ms' : '--'}</td>
                          <td>{r.loss_pct != null ? r.loss_pct + '%' : '--'}</td>
                        </tr>)}
                    </tbody>
                  </HistTable>}
              </div>
            );
          })() : null}
          {isOperator() && this.state.mode === 'client' &&
            <div>
              <div style={{display:'inline-flex', gap:2, padding:3, background:'#f0f2f5', borderRadius:10, marginBottom:8, marginLeft:10}}>
                {[['full','Full 3-Phase'],['custom','Custom']].map(m =>
                  <div key={m[0]} onClick={() => this.setState({preset: m[0]})}
                    style={{padding:'5px 14px', fontSize:12, fontWeight:600, cursor:'pointer', borderRadius:8,
                      background:this.state.preset===m[0]?'#fff':'transparent',
                      boxShadow:this.state.preset===m[0]?'0 1px 3px rgba(16,24,40,0.12)':'none',
                      color:this.state.preset===m[0]?'var(--text-primary)':'var(--text-secondary)'}}>
                    {m[1]}
                  </div>)}
              </div>
              {this.state.preset === 'full' ?
                <p className="note">Three phases: TCP download, TCP upload, UDP capacity + jitter + loss. The device must run <code>iperf3 -s</code>.</p>
              : (() => {
                const o = this.state.opts;
                const L = ({children}) => <span style={{fontSize:11, fontWeight:600, color:'var(--text-muted)', display:'block', marginBottom:2}}>{children}</span>;
                const sel = {padding:'5px 8px', fontSize:12, borderRadius:8, background:'var(--bg-input)', border:'1px solid transparent', color:'var(--text-primary)', width:'100%'};
                return (
                  <div style={{display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap:10, margin:'4px 0 12px'}}>
                    <div><L>Protocol</L>
                      <select style={sel} value={o.proto} onChange={e => this.setOpt('proto', e.target.value)}>
                        <option value="tcp">TCP</option><option value="udp">UDP</option>
                      </select></div>
                    <div><L>Direction</L>
                      <select style={sel} value={o.direction} onChange={e => this.setOpt('direction', e.target.value)}>
                        <option value="dl">Download</option><option value="ul">Upload</option>
                        <option value="bidir">Bidirectional</option>
                      </select></div>
                    <div><L>Duration (s)</L>
                      <select style={sel} value={o.duration} onChange={e => this.setOpt('duration', e.target.value)}>
                        {[5,10,15,30].map(d => <option key={d} value={d}>{d}</option>)}
                      </select></div>
                    <div><L>Parallel streams</L>
                      <select style={sel} value={o.streams} onChange={e => this.setOpt('streams', e.target.value)}>
                        {[1,2,4,8,16].map(d => <option key={d} value={d}>{d}</option>)}
                      </select></div>
                    {o.proto === 'udp' ?
                      <div><L>UDP bitrate</L>
                        <select style={sel} value={o.bitrate} onChange={e => this.setOpt('bitrate', e.target.value)}>
                          {['1M','5M','10M','20M','45M','60M','100M','500M','1G'].map(b =>
                            <option key={b} value={b}>{b}</option>)}
                        </select></div>
                    :
                      <div><L>Congestion ctrl</L>
                        <select style={sel} value={o.cc} onChange={e => this.setOpt('cc', e.target.value)}>
                          <option value="">default</option>
                          <option value="cubic">cubic</option><option value="reno">reno</option>
                        </select></div>}
                    <div><L>Packet len (-l)</L>
                      <select style={sel} value={o.len} onChange={e => this.setOpt('len', e.target.value)}>
                        <option value="">default</option>
                        {[64,128,200,512,1200,1400,8192].map(d =>
                          <option key={d} value={d}>{d} B</option>)}
                      </select></div>
                    {o.proto === 'tcp' &&
                      <div><L>MSS (-M)</L>
                        <select style={sel} value={o.mss} onChange={e => this.setOpt('mss', e.target.value)}>
                          <option value="">default</option>
                          {[536,1000,1200,1400,1460].map(d =>
                            <option key={d} value={d}>{d}</option>)}
                        </select></div>}
                    <div><L>DSCP (--dscp)</L>
                      <select style={sel} value={o.dscp} onChange={e => this.setOpt('dscp', e.target.value)}>
                        <option value="">none</option>
                        <option value="0">0 (BE)</option><option value="10">10 (AF11)</option>
                        <option value="26">26 (AF31)</option><option value="34">34 (AF41)</option>
                        <option value="46">46 (EF)</option>
                      </select></div>
                    <div><L>Window (-w)</L>
                      <select style={sel} value={o.window} onChange={e => this.setOpt('window', e.target.value)}>
                        <option value="">default</option>
                        {['64K','256K','1M','4M'].map(w => <option key={w} value={w}>{w}</option>)}
                      </select></div>
                    <div><L>Omit slow-start (-O)</L>
                      <select style={sel} value={o.omit} onChange={e => this.setOpt('omit', e.target.value)}>
                        {[0,1,2,5].map(d => <option key={d} value={d}>{d} s</option>)}
                      </select></div>
                  </div>
                );
              })()}
            </div>}
          {isOperator() && this.state.mode === 'client' && (() => {
            const t = this.state.test || {};
            const testing = this.state.testing;
            return (
              <div>
                <SpeedGrid>
                  <SpeedBig c={BLUE}>
                    <div className="lbl">Download</div>
                    <div className="num">{t.dl && t.dl.mbps != null ? t.dl.mbps : '--'}</div>
                    <div className="unit">Mbps · TCP{t.dl && t.dl.retransmits != null ? ' · ' + t.dl.retransmits + ' retr' : ''}</div>
                  </SpeedBig>
                  <SpeedBig c={'#27b8dc'}>
                    <div className="lbl">Upload</div>
                    <div className="num">{t.ul && t.ul.mbps != null ? t.ul.mbps : '--'}</div>
                    <div className="unit">Mbps · TCP{t.ul && t.ul.retransmits != null ? ' · ' + t.ul.retransmits + ' retr' : ''}</div>
                  </SpeedBig>
                  <SpeedBig c={GREEN}>
                    <div className="lbl">UDP Capacity</div>
                    <div className="num">{t.udp && t.udp.mbps != null ? t.udp.mbps : '--'}</div>
                    <div className="unit">Mbps{t.udp && t.udp.jitter_ms != null ? ' · ' + t.udp.jitter_ms + ' ms jitter · ' + t.udp.loss_pct + '% loss' : ''}</div>
                  </SpeedBig>
                </SpeedGrid>
                {t.error &&
                  <p className="note" style={{color:'var(--bad)'}}>Test failed: {t.error} — is iperf3 -s running on the device?</p>}
                {t.meta &&
                  <p className="note" style={{textAlign:'center'}}>
                    <code>iperf3 -c {t.target} {t.meta.args}</code>
                    {t.meta.cpu ? ' · CPU local ' + t.meta.cpu.local + '% / remote ' + t.meta.cpu.remote + '%' : ''}
                  </p>}
                <div style={{textAlign:'center'}}>
                  <RunButton disabled={testing} onClick={this.runTest}>
                    {testing ? (this.state.preset === 'custom' ? 'Running iperf3…' : PHASES[this.state.phase]) : 'Run Speed Test'}
                  </RunButton>
                  {testing && <PhaseBar pct={((this.state.phase + 1) / PHASES.length) * 100}><div className="fill" style={{width: (((this.state.phase + 1) / PHASES.length) * 100) + '%'}}/></PhaseBar>}
                </div>
                {this.state.testHistory.length > 0 &&
                  <HistTable>
                    <thead><tr><th>Time</th><th>DL Mbps</th><th>UL Mbps</th><th>UDP Mbps</th><th>Jitter</th><th>Loss</th></tr></thead>
                    <tbody>
                      {this.state.testHistory.map((h, i) =>
                        <tr key={i}>
                          <td>{h.when}</td>
                          <td>{h.dl ? h.dl.mbps : '--'}</td>
                          <td>{h.ul ? h.ul.mbps : '--'}</td>
                          <td>{h.udp ? h.udp.mbps : '--'}</td>
                          <td>{h.udp && h.udp.jitter_ms != null ? h.udp.jitter_ms + ' ms' : '--'}</td>
                          <td>{h.udp && h.udp.loss_pct != null ? h.udp.loss_pct + '%' : '--'}</td>
                        </tr>)}
                    </tbody>
                  </HistTable>}
              </div>
            );
          })()}
        </Card>

        <Card>
          <h3>Throughput (Mbps)</h3>
          <p className="note">Live goodput from NW-TT byte counters — run the speed test above to drive the link and watch it here in real time.</p>
          <ChipRow><Chip c={BLUE}>Downlink</Chip><Chip c={GREEN}>Uplink</Chip></ChipRow>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={h}>
              <defs>
                <linearGradient id="gUeDl" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={BLUE} stopOpacity={0.18}/>
                  <stop offset="100%" stopColor={BLUE} stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="gUeUl" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={GREEN} stopOpacity={0.18}/>
                  <stop offset="100%" stopColor={GREEN} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--divider)" />
              <XAxis dataKey="t" axisLine={false} tickLine={false} tick={AXIS_TICK} unit="s" />
              <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} />
              <Tooltip contentStyle={UNIFI_TOOLTIP} />
              <Area type="monotone" dataKey="dl" name="Downlink" stroke={BLUE} fill="url(#gUeDl)" dot={false} strokeWidth={1.5} isAnimationActive={false} />
              <Area type="monotone" dataKey="ul" name="Uplink" stroke={GREEN} fill="url(#gUeUl)" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Two>
          <Card>
            <h3>Latency (ms RTT)</h3>
            <p className="note">Active ping to the device — tracks 5G radio variability.</p>
            <ChipRow><Chip c={AMBER}>RTT</Chip></ChipRow>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={h.filter(x => x.lat != null)}>
                <defs>
                  <linearGradient id="gUeLat" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={AMBER} stopOpacity={0.18}/>
                    <stop offset="100%" stopColor={AMBER} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--divider)" />
                <XAxis dataKey="t" axisLine={false} tickLine={false} tick={AXIS_TICK} unit="s" />
                <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} />
                <Tooltip contentStyle={UNIFI_TOOLTIP} />
                <Area type="monotone" dataKey="lat" name="RTT" stroke={AMBER} fill="url(#gUeLat)" dot={false} strokeWidth={1.5} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
          <Card>
            <h3>Session</h3>
            <Table>
              <tbody>
                <tr><td>Device (DS-TT) MAC</td><td>{port.ue_mac || '--'}</td></tr>
                <tr><td>Connection state</td><td>{cm}</td></tr>
                <tr><td>QFI / 5QI</td><td>{pduFlow.qfi != null ? pduFlow.qfi : '--'} / {pduFlow['5qi'] != null ? pduFlow['5qi'] : '--'}</td></tr>
                <tr><td>RX / TX frames</td><td>{tr.rx_frames || 0} / {tr.tx_frames || 0}</td></tr>
                <tr><td>RX / TX bytes</td><td>{tr.rx_bytes || 0} / {tr.tx_bytes || 0}</td></tr>
                <tr><td>Current DL / UL</td><td>{fmt(h.length ? h[h.length - 1].dl : 0)} / {fmt(h.length ? h[h.length - 1].ul : 0)} Mbps</td></tr>
              </tbody>
            </Table>
          </Card>
        </Two>
      </Wrapper>
    );
  }
}

export default Dashboard;
