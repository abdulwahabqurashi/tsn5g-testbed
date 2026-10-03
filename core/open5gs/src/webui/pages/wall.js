import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';
import TopologyFlow from 'components/Shared/TopologyFlow';
import { AreaChart, Area, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

/* ============================================================
 * /wall — command & control centre display (kiosk, no chrome)
 * Dense one-page overview, auto-scaling typography (rem = f(vmin))
 * so it reads correctly from 1080p up to 8000x8000 video walls.
 * ============================================================ */

const BLUE = '#478ff7';
const CYAN = '#27b8dc';
const PURPLE = '#9e7be0';
const GREEN = '#43c478';
const AMBER = '#f5a524';
const RED = '#f0383b';
const GRAY = '#e4e6ea';
const MAX_POINTS = 180;

const TOOLTIP = {
  background: '#ffffff', border: 'none', borderRadius: 10,
  boxShadow: '0 4px 16px rgba(16,24,40,0.14)', fontSize: '0.8rem'
};
const TICK = { fontSize: '0.7rem', fill: '#85898f' };

const Root = styled.div`
  min-height: 100vh;
  background: #f4f6f8;
  color: #1d2126;
  padding: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
`;

const TopStrip = styled.div`
  display: flex;
  align-items: center;
  background: #ffffff;
  border-radius: 0.8rem;
  box-shadow: 0 1px 3px rgba(16,24,40,0.07);
  padding: 0.5rem 1rem;

  .brand {
    width: 2rem; height: 2rem; border-radius: 0.5rem;
    background: #0a2540; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 1rem;
  }
  .title { margin-left: 0.7rem; font-size: 1.15rem; font-weight: 800; letter-spacing: .02em; }
  .subtitle { margin-left: 0.6rem; font-size: 0.85rem; color: #85898f; font-weight: 600;
    text-transform: uppercase; letter-spacing: .08em; }
  .health { margin-left: 2rem; display: flex; align-items: center; font-size: 1rem; font-weight: 700;
    color: ${p => p.ok ? GREEN : AMBER}; }
  .health::before { content: ''; width: 0.7rem; height: 0.7rem; border-radius: 50%;
    background: ${p => p.ok ? GREEN : AMBER}; margin-right: 0.5rem;
    box-shadow: 0 0 0 0.25rem ${p => p.ok ? 'rgba(67,196,120,.2)' : 'rgba(245,165,36,.2)'}; }
  .clock { margin-left: auto; font-size: 1.3rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .date { margin-left: 0.8rem; font-size: 0.85rem; color: #85898f; }
`;

const KpiStrip = styled.div`
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 0.6rem;
`;

const Kpi = styled.div`
  background: #ffffff;
  border-radius: 0.8rem;
  box-shadow: 0 1px 3px rgba(16,24,40,0.07);
  padding: 0.6rem 0.9rem;
  border-top: 0.25rem solid ${p => p.c || BLUE};

  .v { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.02em; line-height: 1.15;
    font-variant-numeric: tabular-nums; }
  .l { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
    color: #85898f; margin-top: 0.15rem; }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 0.6rem;
  flex: 1;
  min-height: 0;
`;

const Card = styled.div`
  grid-column: span ${p => p.span || 4};
  background: #ffffff;
  border-radius: 0.8rem;
  box-shadow: 0 1px 3px rgba(16,24,40,0.07);
  padding: 0.7rem 0.9rem;
  display: flex;
  flex-direction: column;
  min-height: 0;

  .card-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: .07em; color: #85898f; margin-bottom: 0.4rem;
    display: flex; justify-content: space-between; align-items: center; }
  .card-title .extra { text-transform: none; letter-spacing: 0; font-weight: 500; }
`;

const StatusRow = styled.div`
  display: flex; align-items: center; padding: 0.28rem 0;
  border-bottom: 1px solid #f0f1f3; font-size: 0.9rem;
  &:last-child { border-bottom: none; }
  .dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; margin-right: 0.6rem;
    background: ${p => p.ok ? GREEN : '#d1d5db'}; }
  .name { font-weight: 700; min-width: 4.5rem; color: #50565e; }
  .detail { margin-left: auto; color: #85898f; font-size: 0.8rem; }
`;

const PortSquare = styled.div`
  width: 2rem; height: 2rem; border-radius: 0.45rem;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 0.8rem; font-weight: 700; margin: 0 0.3rem 0.3rem 0;
  background: ${p => p.busy ? '#3dbd7d' : BLUE};
  color: #ffffff;
`;

const Mono = styled.span`
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 0.82rem;
`;

const MetricLine = styled.div`
  display: flex; justify-content: space-between; padding: 0.26rem 0;
  border-bottom: 1px solid #f0f1f3; font-size: 0.9rem;
  &:last-child { border-bottom: none; }
  .k { color: #50565e; }
  .v { font-weight: 700; font-variant-numeric: tabular-nums; }
`;

const Overlay = styled.div`
  position: fixed; inset: 0; background: rgba(255,255,255,0.94);
  display: flex; align-items: center; justify-content: center;
  flex-direction: column; z-index: 10; font-size: 1.2rem; color: #50565e;
  a { color: #006fff; font-weight: 700; }
`;

function fmtBytes(b) {
  if (b == null) return '0 B';
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}
function fmtMbps(kbps) {
  if (kbps >= 1000) return (kbps / 1000).toFixed(1) + ' Mbps';
  return kbps.toFixed(0) + ' Kbps';
}

class Wall extends Component {
  state = {
    data: null, history: [], now: new Date(), denied: false
  };
  _prev = null;
  _t0 = null;

  componentDidMount() {
    this.fetch();
    this._poll = setInterval(() => this.fetch(), 5000);
    this._clock = setInterval(() => this.setState({ now: new Date() }), 1000);
  }
  componentWillUnmount() {
    clearInterval(this._poll);
    clearInterval(this._clock);
  }

  fetch() {
    const sessionData = new Session();
    const csrf = ((sessionData || {}).session || {}).csrfToken;
    const authToken = ((sessionData || {}).session || {}).authToken;
    const headers = { 'X-CSRF-TOKEN': csrf };
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    const get = (base, url) =>
      axios({ baseURL: base, headers, method: 'get', url })
        .catch(err => {
          if (err.response && err.response.status === 401)
            this.setState({ denied: true });
          return { data: null };
        });

    Promise.all([
      get('/api/upf', '/TsnInfo'),
      get('/api/tsn', '/Analytics'),
      get('/api/amf', '/UeInfo'),
      get('/api/amf', '/GnbInfo'),
      get('/api/amf', '/PduInfo'),
    ]).then(r => {
      const data = {
        nwtt: r[0].data, tsn: r[1].data, ues: r[2].data,
        gnbs: r[3].data, pdus: r[4].data, ts: Date.now()
      };
      if (r[0].data || r[2].data) this.setState({ denied: false });
      this.sample(data);
      this.setState({ data });
    });
  }

  sample(data) {
    const ports = (data.nwtt && data.nwtt.ports) || [];
    let rx = 0, tx = 0, rxf = 0, txf = 0, drops = 0, gptp = 0;
    let jit = null;
    ports.forEach(p => {
      const t = p.traffic || {};
      rx += t.rx_bytes || 0; tx += t.tx_bytes || 0;
      rxf += t.rx_frames || 0; txf += t.tx_frames || 0;
      drops += t.mbr_dropped_frames || 0;
      gptp += t.gptp_frames || t.rx_gptp_frames || 0;
      if (p.jitter && p.jitter.current_us != null) jit = p.jitter.current_us;
    });
    if (this._prev && data.ts > this._prev.ts) {
      const dt = (data.ts - this._prev.ts) / 1000;
      const rxk = Math.max(0, (rx - this._prev.rx) * 8 / dt / 1000);
      const txk = Math.max(0, (tx - this._prev.tx) * 8 / dt / 1000);
      if (this._t0 == null) this._t0 = data.ts;
      const hist = this.state.history.concat([{
        t: Math.round((data.ts - this._t0) / 1000),
        dl: +txk.toFixed(1), ul: +rxk.toFixed(1),
        dlf: Math.round(Math.max(0, (txf - this._prev.txf) / dt)),
        ulf: Math.round(Math.max(0, (rxf - this._prev.rxf) / dt)),
        drops: Math.round(Math.max(0, (drops - this._prev.drops) / dt)),
        gptps: Math.round(Math.max(0, (gptp - this._prev.gptp) / dt)),
        jit: jit
      }]);
      if (hist.length > MAX_POINTS) hist.shift();
      this.setState({ history: hist });
    }
    this._prev = { ts: data.ts, rx, tx, rxf, txf, drops, gptp };
  }

  render() {
    const { data, history, now, denied } = this.state;
    const d = data || {};
    const ues = ((d.ues || {}).items) || [];
    const gnbs = ((d.gnbs || {}).items) || (Array.isArray(d.gnbs) ? d.gnbs : []);
    const pdus = ((d.pdus || {}).items) || [];
    const ports = ((d.nwtt || {}).ports) || [];
    const bridges = ((d.tsn || {}).bridges) || [];

    const connected = ues.filter(u =>
      u.cm_state === 'connected' || u.cm_state === 'CM-CONNECTED').length;
    let totRxB = 0, totTxB = 0, mbrDrop = 0, psfpPass = 0, psfpDrop = 0,
        gptp = 0, jitterUs = null;
    ports.forEach(p => {
      const t = p.traffic || {};
      totRxB += t.rx_bytes || 0; totTxB += t.tx_bytes || 0;
      mbrDrop += t.mbr_dropped_frames || 0;
      gptp += t.gptp_frames || t.rx_gptp_frames || 0;
      const ps = p.psfp || {};
      psfpPass += ps.passed_frames || 0; psfpDrop += ps.dropped_frames || 0;
      if (p.jitter && p.jitter.current_us != null) jitterUs = p.jitter.current_us;
    });
    const last = history.length ? history[history.length - 1] : { dl: 0, ul: 0 };
    const healthy = gnbs.length > 0 && d.nwtt != null;

    const clientDonut = ues.length ?
      [{ name: 'Connected', value: connected },
       { name: 'Idle', value: Math.max(0, ues.length - connected) }] :
      [{ name: 'None', value: 1 }];
    const clientColors = ues.length ? [GREEN, GRAY] : [GRAY];
    const trafTotal = totRxB + totTxB;
    const trafDonut = trafTotal ?
      [{ name: 'Downlink', value: totTxB }, { name: 'Uplink', value: totRxB }] :
      [{ name: 'None', value: 1 }];
    const trafColors = trafTotal ? [BLUE, CYAN] : [GRAY];

    return (
      <Root>
        <style jsx global>{`
          html { font-size: clamp(9px, calc(4px + 0.3vmin), 42px); }
          body { margin: 0; background: #f4f6f8;
            font-family: 'Inter', system-ui, sans-serif; }
        `}</style>

        {denied &&
          <Overlay>
            <div>Wall display needs a signed-in session.</div>
            <div style={{marginTop:'0.6rem'}}>
              <a href="/">Sign in once here</a>, then return to <b>/wall</b>.
            </div>
          </Overlay>}

        <TopStrip ok={healthy}>
          <div className="brand">A</div>
          <div className="title">AMRC 5G-TSN</div>
          <div className="subtitle">Command View</div>
          <div className="health">{healthy ? 'All systems operational' : 'Attention needed'}</div>
          <div className="clock">{now.toLocaleTimeString()}</div>
          <div className="date">{now.toDateString()}</div>
        </TopStrip>

        <KpiStrip>
          <Kpi c={GREEN}><div className="v">{connected}</div><div className="l">UEs connected</div></Kpi>
          <Kpi c={BLUE}><div className="v">{gnbs.length}</div><div className="l">gNodeBs</div></Kpi>
          <Kpi c={PURPLE}><div className="v">{pdus.length}</div><div className="l">PDU sessions</div></Kpi>
          <Kpi c={CYAN}><div className="v">{ports.length}</div><div className="l">NW-TT ports</div></Kpi>
          <Kpi c={BLUE}><div className="v">{fmtMbps(last.dl)}</div><div className="l">Downlink</div></Kpi>
          <Kpi c={CYAN}><div className="v">{fmtMbps(last.ul)}</div><div className="l">Uplink</div></Kpi>
          <Kpi c={PURPLE}><div className="v">{fmtBytes(trafTotal)}</div><div className="l">Total traffic</div></Kpi>
          <Kpi c={mbrDrop ? AMBER : GREEN}><div className="v">{mbrDrop}</div><div className="l">Policed frames</div></Kpi>
        </KpiStrip>

        <Grid>
          <Card span={12}>
            <div className="card-title">Live topology
              <span className="extra">{healthy ? 'end-to-end path active' : 'path degraded'}</span>
            </div>
            <TopologyFlow
              bridge={(d.nwtt || {}).bridge || {}}
              ports={ports}
              gnbCount={gnbs.length}
              dlRate={fmtMbps(last.dl)}
              ulRate={fmtMbps(last.ul)}
            />
          </Card>

          <Card span={6}>
            <div className="card-title">Network activity
              <span className="extra">5s samples · last {Math.round(history.length * 5 / 60)} min</span>
            </div>
            <div style={{flex:1, minHeight:'12rem'}}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history} margin={{top: 4, right: 6, left: -10, bottom: 0}}>
                  <defs>
                    <linearGradient id="wDl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={BLUE} stopOpacity={0.25}/>
                      <stop offset="100%" stopColor={BLUE} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="wUl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CYAN} stopOpacity={0.25}/>
                      <stop offset="100%" stopColor={CYAN} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#f0f1f3" vertical={false}/>
                  <XAxis dataKey="t" axisLine={false} tickLine={false} tick={TICK} unit="s"/>
                  <YAxis axisLine={false} tickLine={false} tick={TICK}/>
                  <Tooltip contentStyle={TOOLTIP}/>
                  <Area type="monotone" dataKey="dl" name="Downlink (Kbps)" stroke={BLUE}
                    strokeWidth={2} fill="url(#wDl)" dot={false} isAnimationActive={false}/>
                  <Area type="monotone" dataKey="ul" name="Uplink (Kbps)" stroke={CYAN}
                    strokeWidth={2} fill="url(#wUl)" dot={false} isAnimationActive={false}/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card span={3}>
            <div className="card-title">Frame rate
              <span className="extra">frames/s</span>
            </div>
            <div style={{flex:1, minHeight:'10rem'}}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history} margin={{top: 4, right: 6, left: -14, bottom: 0}}>
                  <defs>
                    <linearGradient id="wDlf" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={PURPLE} stopOpacity={0.25}/>
                      <stop offset="100%" stopColor={PURPLE} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#f0f1f3" vertical={false}/>
                  <XAxis dataKey="t" axisLine={false} tickLine={false} tick={TICK} unit="s"/>
                  <YAxis axisLine={false} tickLine={false} tick={TICK}/>
                  <Tooltip contentStyle={TOOLTIP}/>
                  <Area type="monotone" dataKey="dlf" name="DL frames/s" stroke={PURPLE}
                    strokeWidth={2} fill="url(#wDlf)" dot={false} isAnimationActive={false}/>
                  <Area type="monotone" dataKey="ulf" name="UL frames/s" stroke={CYAN}
                    strokeWidth={2} fill="none" dot={false} isAnimationActive={false}/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card span={3}>
            <div className="card-title">Radio jitter &amp; policing
              <span className="extra">PDV µs · drops/s</span>
            </div>
            <div style={{flex:1, minHeight:'10rem'}}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history} margin={{top: 4, right: 6, left: -14, bottom: 0}}>
                  <CartesianGrid stroke="#f0f1f3" vertical={false}/>
                  <XAxis dataKey="t" axisLine={false} tickLine={false} tick={TICK} unit="s"/>
                  <YAxis axisLine={false} tickLine={false} tick={TICK}/>
                  <Tooltip contentStyle={TOOLTIP}/>
                  <Line type="monotone" dataKey="jit" name="Jitter (µs)" stroke={AMBER}
                    strokeWidth={2} dot={false} isAnimationActive={false} connectNulls/>
                  <Line type="monotone" dataKey="drops" name="Policed/s" stroke={RED}
                    strokeWidth={2} dot={false} isAnimationActive={false}/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card span={2}>
            <div className="card-title">Clients</div>
            <div style={{flex:1, minHeight:'9rem'}}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={clientDonut} dataKey="value" innerRadius="68%" outerRadius="92%"
                    startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                    {clientDonut.map((e, i) =>
                      <Cell key={i} fill={clientColors[i % clientColors.length]}/>)}
                  </Pie>
                  <text x="50%" y="47%" textAnchor="middle"
                    style={{fontSize:'2rem', fontWeight:800, fill:'#1d2126'}}>{ues.length}</text>
                  <text x="50%" y="62%" textAnchor="middle"
                    style={{fontSize:'0.75rem', fill:'#85898f'}}>UEs</text>
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card span={2}>
            <div className="card-title">Traffic split</div>
            <div style={{flex:1, minHeight:'9rem'}}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={trafDonut} dataKey="value" innerRadius="68%" outerRadius="92%"
                    startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                    {trafDonut.map((e, i) =>
                      <Cell key={i} fill={trafColors[i % trafColors.length]}/>)}
                  </Pie>
                  <text x="50%" y="47%" textAnchor="middle"
                    style={{fontSize:'1.05rem', fontWeight:800, fill:'#1d2126'}}>{fmtBytes(trafTotal)}</text>
                  <text x="50%" y="62%" textAnchor="middle"
                    style={{fontSize:'0.75rem', fill:'#85898f'}}>total</text>
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card span={3}>
            <div className="card-title">System status</div>
            <StatusRow ok={true}><div className="dot"/><span className="name">NRF</span>
              <span className="detail">service registry</span></StatusRow>
            <StatusRow ok={ues.length > 0 || gnbs.length > 0}><div className="dot"/><span className="name">AMF</span>
              <span className="detail">{ues.length} UE registered</span></StatusRow>
            <StatusRow ok={pdus.length > 0}><div className="dot"/><span className="name">SMF</span>
              <span className="detail">{pdus.length} PDU session</span></StatusRow>
            <StatusRow ok={d.nwtt != null}><div className="dot"/><span className="name">UPF</span>
              <span className="detail">{d.nwtt ? 'NW-TT enabled' : 'no data'}</span></StatusRow>
            <StatusRow ok={bridges.length > 0}><div className="dot"/><span className="name">TSN-AF</span>
              <span className="detail">{bridges.length} bridge</span></StatusRow>
            <StatusRow ok={gnbs.length > 0}><div className="dot"/><span className="name">gNB</span>
              <span className="detail">{gnbs.length} connected</span></StatusRow>
          </Card>

          <Card span={3}>
            <div className="card-title">TSN metrics</div>
            <MetricLine><span className="k">Jitter (PDV)</span>
              <span className="v">{jitterUs != null ? jitterUs + ' µs' : '--'}</span></MetricLine>
            <MetricLine><span className="k">gPTP frames</span>
              <span className="v">{gptp}</span></MetricLine>
            <MetricLine><span className="k">PSFP passed</span>
              <span className="v">{psfpPass}</span></MetricLine>
            <MetricLine><span className="k">PSFP dropped</span>
              <span className="v">{psfpDrop}</span></MetricLine>
            <MetricLine><span className="k">AMBR policed</span>
              <span className="v">{mbrDrop}</span></MetricLine>
          </Card>

          <Card span={2}>
            <div className="card-title">Active UEs</div>
            {ues.length ? ues.slice(0, 8).map((u, i) =>
              <StatusRow key={i} ok={u.cm_state === 'connected'}>
                <div className="dot"/>
                <Mono>{(u.supi || '').replace('imsi-', '')}</Mono>
                <span className="detail">{u.cm_state}</span>
              </StatusRow>) :
              <span style={{color:'#85898f', fontSize:'0.85rem'}}>no UEs registered</span>}
          </Card>
        </Grid>
      </Root>
    );
  }
}

export default Wall;
