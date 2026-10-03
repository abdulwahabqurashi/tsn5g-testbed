import { Component } from 'react';
import PropTypes from 'prop-types';
import styled from 'styled-components';
import oc from 'open-color';
import AlertPanel from './AlertPanel';
import NotificationChannels from './NotificationChannels';
import ReportsCard from './ReportsCard';
import BackupCard from './BackupCard';
import SitesManager from './SitesManager';
import TopologyFlow from 'components/Shared/TopologyFlow';
import SiteTopology from 'components/Shared/SiteTopology';
import { AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer } from 'recharts';

const BLUE = '#478ff7';
const GREEN = '#43c478';
const GRAY = '#e8eaed';
const UNIFI_TOOLTIP = {
  background: '#ffffff', border: 'none', borderRadius: 10,
  boxShadow: '0 4px 16px rgba(16,24,40,0.14)',
  color: 'var(--text-primary)', fontSize: 12
};
const AXIS_TICK = { fontSize: 11, fill: 'var(--text-muted)' };

const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 1rem;
`;

const RefreshIndicator = styled.div`
  text-align: right;
  font-size: 11px;
  color: ${'var(--text-muted)'};
  margin-bottom: 0.5rem;
`;

const Hero = styled.div`
  display: flex;
  align-items: center;
  background: var(--bg-card);
  border-radius: var(--radius);
  box-shadow: var(--card-shadow);
  padding: 1.1rem 1.4rem;
  margin-bottom: 1.25rem;

  .hero-dot {
    width: 10px; height: 10px; border-radius: 50%;
    margin-right: .8rem;
    background: ${p => p.ok ? 'var(--ok)' : 'var(--warn)'};
    box-shadow: 0 0 0 4px ${p => p.ok ? 'rgba(122,193,66,0.18)' : 'rgba(245,165,36,0.18)'};
  }
  .hero-text { font-size: 16px; font-weight: 700; color: ${'var(--text-primary)'};
    & span { color: ${p => p.ok ? 'var(--ok)' : 'var(--warn)'}; } }
  .hero-sub { margin-left: auto; font-size: 12px; font-weight: 500; color: ${'var(--text-muted)'}; }
`;

const SummaryRow = styled.div`
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 1rem;
  margin-bottom: 1.25rem;
  @media (max-width: 1024px) { grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 600px) { grid-template-columns: repeat(2, 1fr); }
`;

const SummaryCard = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  padding: 1.1rem 1.25rem;
  .card-value { font-size: 30px; font-weight: 800; letter-spacing: -0.5px; color: ${'var(--text-primary)'}; }
  .card-label {
    display: flex; align-items: center;
    font-size: 12px; font-weight: 500; color: ${'var(--text-muted)'}; margin-top: 6px;
    &::before {
      content: ''; display: inline-block;
      width: 8px; height: 8px; border-radius: 3px; margin-right: 7px;
      background: ${p => p.color || 'var(--accent)'};
    }
  }
`;

const ThreeCol = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1.25rem;
  margin-bottom: 1.25rem;
  @media (max-width: 1024px) { grid-template-columns: 1fr; }
`;

const Chip = styled.span`
  display: inline-flex; align-items: center;
  background: #ffffff; border: 1px solid var(--border-color);
  border-radius: 8px; padding: 3px 10px;
  font-size: 12px; font-weight: 500; color: ${'var(--text-secondary)'};
  &::before { content: ''; width: 10px; height: 3px; border-radius: 2px;
    margin-right: 6px; background: ${p => p.c}; }
`;
const ChipRow = styled.div`display: flex; gap: 8px; margin-bottom: 10px;`;

const DonutLegend = styled.div`
  display: flex; justify-content: center; gap: 14px; margin-top: 2px;
  .dl-item { display: inline-flex; align-items: center; font-size: 11px;
    font-weight: 600; color: ${'var(--text-secondary)'}; }
  .dl-dot { width: 8px; height: 8px; border-radius: 3px; margin-right: 5px; }
  .dl-val { margin-left: 4px; color: ${'var(--text-primary)'}; }
`;

const PortGrid = styled.div`
  display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 0 4px;
`;

const PortSquare = styled.div`
  width: 30px; height: 30px; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700;
  background: ${p => p.state === 'active' ? 'var(--port-green)' :
    p.state === 'up' ? 'var(--port-blue)' : 'var(--port-gray)'};
  color: ${p => p.state === 'idle' ? 'var(--text-muted)' : '#ffffff'};
`;

const TwoCol = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  margin-bottom: 1.25rem;
  @media (max-width: 768px) { grid-template-columns: 1fr; }
`;

const Panel = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  overflow: hidden;
`;

const PanelHeader = styled.div`
  padding: 1rem 1.25rem .6rem;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .6px;
  text-transform: uppercase;
  color: ${'var(--text-muted)'};
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const PanelBody = styled.div`
  padding: 0.5rem 1.25rem 1rem;
`;

const StatusRow = styled.div`
  display: flex;
  align-items: center;
  padding: 5px 0;
  border-bottom: 1px solid ${'var(--divider)'};
  &:last-child { border-bottom: none; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; margin-right: 10px;
    background: ${p => p.ok ? 'var(--ok)' : '#d1d5db'};
    box-shadow: 0 0 0 3px ${p => p.ok ? 'rgba(122,193,66,0.16)' : 'rgba(209,213,219,0.25)'}; }
  .status-name { font-size: 13px; font-weight: 600; color: ${'var(--text-secondary)'}; min-width: 60px; }
  .status-detail { font-size: 12px; color: ${'var(--text-muted)'}; margin-left: auto; }
`;

const UeRow = styled.div`
  display: flex;
  align-items: center;
  padding: 4px 0;
  border-bottom: 1px solid ${'var(--divider)'};
  &:last-child { border-bottom: none; }
  font-size: 12px;
  .ue-supi { font-family: monospace; color: ${'var(--text-secondary)'}; min-width: 160px; }
  .ue-state { color: ${'var(--text-muted)'}; min-width: 80px; }
  .ue-pdus { color: ${'var(--text-muted)'}; margin-left: auto; }
`;

const UeRowHeader = styled(UeRow)`
  font-weight: 600;
  color: ${'var(--text-muted)'};
  border-bottom: 2px solid ${'var(--border-color)'};
  .ue-supi { font-family: inherit; }
`;

const MetricLine = styled.div`
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  border-bottom: 1px solid ${'var(--divider)'};
  &:last-child { border-bottom: none; }
  .ml-label { font-size: 12px; color: ${'var(--text-secondary)'}; }
  .ml-value { font-size: 12px; font-family: monospace; color: ${'var(--text-primary)'}; font-weight: 600; }
`;

const ViewAllLink = styled.div`
  text-align: right;
  padding: 6px 0 2px 0;
  font-size: 12px;
  color: ${'var(--accent)'};
  cursor: pointer;
  &:hover { color: ${'var(--accent-2)'}; text-decoration: underline; }
`;

const ErrorBanner = styled.div`
  background: ${oc.red[1]};
  border: 1px solid ${oc.red[4]};
  border-radius: var(--radius);
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  color: ${oc.red[8]};
  font-size: 14px;
`;

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  var seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  return Math.floor(seconds / 60) + 'm ago';
}

function fmtBytes(b) {
  if (b == null) return '0 B';
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

function fmtNum(n) {
  if (n == null) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

class Overview extends Component {
  state = { tick: 0, history: [] };
  _prev = null;
  _t0 = null;
  _lastTs = null;

  componentWillReceiveProps(next) {
    var d = next.data;
    var ts = next.lastUpdated;
    if (!d || !ts || ts === this._lastTs) return;
    this._lastTs = ts;
    var ports = (d.nwtt && d.nwtt.ports) || [];
    var rx = 0, tx = 0;
    ports.forEach(function(p) {
      var t = p.traffic || {};
      rx += t.rx_bytes || 0; tx += t.tx_bytes || 0;
    });
    if (this._prev && ts > this._prev.ts) {
      var dt = (ts - this._prev.ts) / 1000;
      var rxk = Math.max(0, (rx - this._prev.rx) * 8 / dt / 1000);
      var txk = Math.max(0, (tx - this._prev.tx) * 8 / dt / 1000);
      if (this._t0 == null) this._t0 = ts;
      var hist = this.state.history.concat([{
        t: Math.round((ts - this._t0) / 1000),
        tx: +txk.toFixed(1), rx: +rxk.toFixed(1)
      }]);
      if (hist.length > 120) hist.shift();
      this.setState({ history: hist });
    }
    this._prev = { ts: ts, rx: rx, tx: tx };
  }

  componentWillMount() {
    this._ticker = setInterval(() => {
      this.setState({ tick: this.state.tick + 1 });
    }, 1000);
  }

  componentWillUnmount() {
    if (this._ticker) clearInterval(this._ticker);
  }

  render() {
    const { data, isLoading, error, lastUpdated, onNavigate,
      alertRules, alertHistory, onToggleRule, onAddRule, onRemoveRule, onClearAlertHistory } = this.props;

    var ues = (data && data.ues) || [];
    var gnbs = (data && data.gnbs) || [];
    var pdus = (data && data.pdus) || [];
    var nwtt = data && data.nwtt;
    var tsn = (data && data.tsn) || {};
    var bridges = (tsn && tsn.bridges) || [];

    // Count UEs
    var ueList = [];
    if (Array.isArray(ues)) {
      ueList = ues;
    } else if (ues && Array.isArray(ues.items)) {
      ueList = ues.items;
    } else if (ues && Array.isArray(ues.ue_list)) {
      ueList = ues.ue_list;
    }
    var connectedUes = 0;
    ueList.forEach(function(u) {
      if (u.cm_state === 'connected' || u.cm_state === 'CM-CONNECTED') connectedUes++;
    });

    // Count gNBs
    var gnbList = [];
    if (Array.isArray(gnbs)) {
      gnbList = gnbs;
    } else if (gnbs && Array.isArray(gnbs.items)) {
      gnbList = gnbs.items;
    } else if (gnbs && Array.isArray(gnbs.gnb_list)) {
      gnbList = gnbs.gnb_list;
    }

    // Count PDU sessions
    var pduList = [];
    if (Array.isArray(pdus)) {
      pduList = pdus;
    } else if (pdus && Array.isArray(pdus.items)) {
      pduList = pdus.items;
    } else if (pdus && Array.isArray(pdus.pdu_list)) {
      pduList = pdus.pdu_list;
    }

    // NW-TT data
    var nwttPorts = (nwtt && nwtt.ports) || [];
    var nwttBridge = (nwtt && nwtt.bridge) || {};

    // Compute total frames
    var totalFrames = 0;
    nwttPorts.forEach(function(p) {
      var t = p.traffic || {};
      totalFrames += (t.rx_frames || 0) + (t.tx_frames || 0);
    });

    // NW-TT performance summary
    var avgResidence = '--';
    var currentJitter = '--';
    var psfpRate = '--';
    var totalRx = 0;
    var totalTx = 0;
    var totalRxB = 0;
    var totalTxB = 0;
    nwttPorts.forEach(function(p) {
      var rt = p.residence_time || {};
      if (rt.avg_us != null) avgResidence = rt.avg_us + ' \u00B5s';
      var jt = p.jitter || {};
      if (jt.current_us != null) currentJitter = jt.current_us + ' \u00B5s';
      var pf = p.psfp || {};
      var pTotal = (pf.passed_frames || 0) + (pf.dropped_frames || 0);
      if (pTotal > 0) psfpRate = ((pf.passed_frames || 0) / pTotal * 100).toFixed(2) + '%';
      totalRx += (p.traffic || {}).rx_frames || 0;
      totalTx += (p.traffic || {}).tx_frames || 0;
      totalRxB += (p.traffic || {}).rx_bytes || 0;
      totalTxB += (p.traffic || {}).tx_bytes || 0;
    });

    var idleUes = Math.max(0, ueList.length - connectedUes);
    var clientDonut = ueList.length > 0 ?
      [{ name: 'Connected', value: connectedUes }, { name: 'Idle', value: idleUes }] :
      [{ name: 'No UEs', value: 1 }];
    var clientColors = ueList.length > 0 ? [GREEN, GRAY] : [GRAY];
    var trafficTotal = totalRxB + totalTxB;
    var trafficDonut = trafficTotal > 0 ?
      [{ name: 'Downlink', value: totalTxB }, { name: 'Uplink', value: totalRxB }] :
      [{ name: 'No traffic', value: 1 }];
    var trafficColors = trafficTotal > 0 ? [BLUE, GREEN] : [GRAY];
    var history = this.state.history;

    return (
      <Wrapper>
        <RefreshIndicator>
          {isLoading ? 'Refreshing...' : (lastUpdated ? 'Updated ' + formatTimeAgo(lastUpdated) : '')}
          {' | Auto-refresh: 5s'}
        </RefreshIndicator>

        {(function() {
          var healthy = !error && gnbList.length > 0 && nwtt != null;
          return (
            <Hero ok={healthy}>
              <div className="hero-dot" />
              <div className="hero-text">
                {healthy ? <span>Everything is great!</span> : 'Attention needed'}
              </div>
              <div className="hero-sub">
                {gnbList.length} gNB · {connectedUes} UE connected · {pduList.length} PDU session{pduList.length !== 1 ? 's' : ''}
              </div>
            </Hero>
          );
        })()}

        {error && <ErrorBanner>{typeof error === 'string' ? error : 'Failed to load dashboard data'}</ErrorBanner>}

        <SummaryRow>
          <SummaryCard color={oc.blue[5]}>
            <div className="card-value">{ueList.length}</div>
            <div className="card-label">Connected UEs</div>
          </SummaryCard>
          <SummaryCard color={'var(--accent)'}>
            <div className="card-value">{gnbList.length}</div>
            <div className="card-label">Active gNBs</div>
          </SummaryCard>
          <SummaryCard color={oc.violet[5]}>
            <div className="card-value">{pduList.length}</div>
            <div className="card-label">PDU Sessions</div>
          </SummaryCard>
          <SummaryCard color={oc.orange[5]}>
            <div className="card-value">{bridges.length}</div>
            <div className="card-label">TSN Bridges</div>
          </SummaryCard>
          <SummaryCard color={'var(--accent)'}>
            <div className="card-value">{nwttPorts.length}</div>
            <div className="card-label">NW-TT Ports</div>
          </SummaryCard>
          <SummaryCard color={oc.cyan[5]}>
            <div className="card-value">{fmtNum(totalFrames)}</div>
            <div className="card-label">Total Frames</div>
          </SummaryCard>
        </SummaryRow>

        <Panel style={{marginBottom: '1.25rem'}}>
          <PanelHeader>
            <span>Sites</span>
            <span style={{fontSize:'11px',color:'var(--text-muted)',fontWeight:500,textTransform:'none',letterSpacing:0}}>
              gNBs grouped by site · use the header switcher to filter
            </span>
          </PanelHeader>
          <PanelBody>
            <SiteTopology/>
          </PanelBody>
        </Panel>

        <Panel style={{marginBottom: '1.25rem'}}>
          <PanelHeader>
            <span>Topology</span>
            <span style={{fontSize:'11px',color:'var(--text-muted)',fontWeight:500,textTransform:'none',letterSpacing:0}}>
              live &middot; click nodes in 5GS Bridge view for details
            </span>
          </PanelHeader>
          <PanelBody>
            <TopologyFlow
              bridge={nwttBridge}
              ports={nwttPorts}
              gnbCount={gnbList.length}
              dlRate={history.length ? (history[history.length-1].tx / 1000).toFixed(1) + ' Mbps' : null}
              ulRate={history.length ? (history[history.length-1].rx / 1000).toFixed(1) + ' Mbps' : null}
            />
          </PanelBody>
        </Panel>

        <Panel style={{marginBottom: '1.25rem'}}>
          <PanelHeader>
            <span>Network Activity</span>
            <span style={{fontSize:'11px',color:'var(--text-muted)',fontWeight:500}}>
              NW-TT throughput (Kbps) &middot; 5s samples
            </span>
          </PanelHeader>
          <PanelBody>
            <ChipRow>
              <Chip c={BLUE}>Downlink</Chip>
              <Chip c="#27b8dc">Uplink</Chip>
            </ChipRow>
            {history.length > 1 ? (
              <ResponsiveContainer width="100%" height={210}>
                <AreaChart data={history}>
                  <defs>
                    <linearGradient id="gDbTx" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={BLUE} stopOpacity={0.18}/>
                      <stop offset="100%" stopColor={BLUE} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="gDbRx" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#27b8dc" stopOpacity={0.18}/>
                      <stop offset="100%" stopColor="#27b8dc" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--divider)" />
                  <XAxis dataKey="t" axisLine={false} tickLine={false} tick={AXIS_TICK} unit="s" />
                  <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} />
                  <Tooltip contentStyle={UNIFI_TOOLTIP} />
                  <Area type="monotone" dataKey="tx" name="Downlink (Kbps)" stroke={BLUE}
                    strokeWidth={1.5} fill="url(#gDbTx)" dot={false} isAnimationActive={false} />
                  <Area type="monotone" dataKey="rx" name="Uplink (Kbps)" stroke="#27b8dc"
                    strokeWidth={1.5} fill="url(#gDbRx)" dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div style={{textAlign:'center',padding:'3rem',color:'var(--text-muted)',fontSize:'13px'}}>
                Collecting samples&hellip;
              </div>
            )}
          </PanelBody>
        </Panel>

        <ThreeCol>
          <Panel>
            <PanelHeader>Clients</PanelHeader>
            <PanelBody>
              <ResponsiveContainer width="100%" height={170}>
                <PieChart>
                  <Pie data={clientDonut} dataKey="value" innerRadius={52} outerRadius={70}
                    startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                    {clientDonut.map(function(e, i) {
                      return <Cell key={i} fill={clientColors[i % clientColors.length]}/>;
                    })}
                  </Pie>
                  <text x="50%" y="47%" textAnchor="middle"
                    style={{fontSize:'24px',fontWeight:800,fill:'var(--text-primary)'}}>
                    {ueList.length}
                  </text>
                  <text x="50%" y="61%" textAnchor="middle"
                    style={{fontSize:'11px',fill:'var(--text-muted)'}}>
                    UEs
                  </text>
                  {trafficTotal >= 0 && <Tooltip contentStyle={UNIFI_TOOLTIP} />}
                </PieChart>
              </ResponsiveContainer>
              <DonutLegend>
                <span className="dl-item"><span className="dl-dot" style={{background:GREEN}}/>Connected<span className="dl-val">{connectedUes}</span></span>
                <span className="dl-item"><span className="dl-dot" style={{background:GRAY}}/>Idle<span className="dl-val">{idleUes}</span></span>
              </DonutLegend>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>Traffic Distribution</PanelHeader>
            <PanelBody>
              <ResponsiveContainer width="100%" height={170}>
                <PieChart>
                  <Pie data={trafficDonut} dataKey="value" innerRadius={52} outerRadius={70}
                    startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                    {trafficDonut.map(function(e, i) {
                      return <Cell key={i} fill={trafficColors[i % trafficColors.length]}/>;
                    })}
                  </Pie>
                  <text x="50%" y="47%" textAnchor="middle"
                    style={{fontSize:'17px',fontWeight:800,fill:'var(--text-primary)'}}>
                    {fmtBytes(trafficTotal)}
                  </text>
                  <text x="50%" y="61%" textAnchor="middle"
                    style={{fontSize:'11px',fill:'var(--text-muted)'}}>
                    total
                  </text>
                  {trafficTotal > 0 && <Tooltip contentStyle={UNIFI_TOOLTIP} />}
                </PieChart>
              </ResponsiveContainer>
              <DonutLegend>
                <span className="dl-item"><span className="dl-dot" style={{background:BLUE}}/>Downlink<span className="dl-val">{fmtBytes(totalTxB)}</span></span>
                <span className="dl-item"><span className="dl-dot" style={{background:GREEN}}/>Uplink<span className="dl-val">{fmtBytes(totalRxB)}</span></span>
              </DonutLegend>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>NW-TT Ports</PanelHeader>
            <PanelBody>
              {nwttPorts.length > 0 ? (
                <div>
                  <PortGrid>
                    {nwttPorts.map(function(p) {
                      var t = p.traffic || {};
                      var busy = ((t.rx_frames || 0) + (t.tx_frames || 0)) > 0;
                      return (
                        <PortSquare key={p.port_number}
                          state={busy ? 'active' : 'up'}
                          title={'Port ' + p.port_number + (p.mac ? ' · ' + p.mac : '')}>
                          {p.port_number}
                        </PortSquare>
                      );
                    })}
                  </PortGrid>
                  <DonutLegend style={{justifyContent:'flex-start',marginTop:'10px'}}>
                    <span className="dl-item"><span className="dl-dot" style={{background:GREEN}}/>Traffic</span>
                    <span className="dl-item"><span className="dl-dot" style={{background:BLUE}}/>Up, idle</span>
                    <span className="dl-item"><span className="dl-dot" style={{background:GRAY}}/>Free</span>
                  </DonutLegend>
                </div>
              ) : (
                <div style={{textAlign:'center',padding:'2rem',color:'var(--text-muted)',fontSize:'13px'}}>
                  No NW-TT ports &mdash; ports appear when a UE opens an Ethernet PDU session
                </div>
              )}
            </PanelBody>
          </Panel>
        </ThreeCol>

        <TwoCol>
          <Panel>
            <PanelHeader>System Status</PanelHeader>
            <PanelBody>
              <StatusRow ok={true}>
                <div className="status-dot" />
                <span className="status-name">NRF</span>
                <span className="status-detail">Service registry</span>
              </StatusRow>
              <StatusRow ok={ueList.length > 0 || gnbList.length > 0}>
                <div className="status-dot" />
                <span className="status-name">AMF</span>
                <span className="status-detail">{ueList.length} UE{ueList.length !== 1 ? 's' : ''} registered</span>
              </StatusRow>
              <StatusRow ok={pduList.length > 0}>
                <div className="status-dot" />
                <span className="status-name">SMF</span>
                <span className="status-detail">{pduList.length} PDU session{pduList.length !== 1 ? 's' : ''}</span>
              </StatusRow>
              <StatusRow ok={nwtt != null}>
                <div className="status-dot" />
                <span className="status-name">UPF</span>
                <span className="status-detail">{nwtt ? 'NW-TT enabled' : 'Waiting for data'}</span>
              </StatusRow>
              <StatusRow ok={bridges.length > 0}>
                <div className="status-dot" />
                <span className="status-name">TSN-AF</span>
                <span className="status-detail">{bridges.length} bridge{bridges.length !== 1 ? 's' : ''} active</span>
              </StatusRow>
              <StatusRow ok={gnbList.length > 0}>
                <div className="status-dot" />
                <span className="status-name">gNBs</span>
                <span className="status-detail">{gnbList.length} connected</span>
              </StatusRow>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>TSN Bridge Status</PanelHeader>
            <PanelBody>
              {bridges.length > 0 ? bridges.map(function(b, idx) {
                return (
                  <div key={idx}>
                    <MetricLine>
                      <span className="ml-label">Bridge</span>
                      <span className="ml-value">{b.bridge_id || b.name || 'bridge-' + (idx+1)}</span>
                    </MetricLine>
                    <MetricLine>
                      <span className="ml-label">Status</span>
                      <span className="ml-value" style={{color: oc.green[6]}}>Active</span>
                    </MetricLine>
                    <MetricLine>
                      <span className="ml-label">Linux Bridge</span>
                      <span className="ml-value">{b.linux_bridge || '--'}</span>
                    </MetricLine>
                    <MetricLine>
                      <span className="ml-label">Ports</span>
                      <span className="ml-value">{(b.ports || []).length}</span>
                    </MetricLine>
                    <MetricLine>
                      <span className="ml-label">gPTP</span>
                      <span className="ml-value">{nwttBridge.gptp_enabled ? 'Enabled' : 'Disabled'}</span>
                    </MetricLine>
                    {nwttBridge.gptp_monitoring &&
                      <div>
                        <MetricLine>
                          <span className="ml-label">gPTP Sync</span>
                          <span className="ml-value" style={{color: nwttBridge.gptp_monitoring.synced ? oc.green[6] : oc.red[6]}}>
                            {nwttBridge.gptp_monitoring.synced ? 'Synced' : 'Not Synced'}
                          </span>
                        </MetricLine>
                        <MetricLine>
                          <span className="ml-label">Offset</span>
                          <span className="ml-value">{nwttBridge.gptp_monitoring.offset_from_master_ns} ns</span>
                        </MetricLine>
                        <MetricLine>
                          <span className="ml-label">Path Delay</span>
                          <span className="ml-value">{nwttBridge.gptp_monitoring.mean_path_delay_ns} ns</span>
                        </MetricLine>
                        {nwttBridge.gptp_monitoring.gm_identity &&
                          <MetricLine>
                            <span className="ml-label">GM Identity</span>
                            <span className="ml-value">{nwttBridge.gptp_monitoring.gm_identity}</span>
                          </MetricLine>
                        }
                      </div>
                    }
                  </div>
                );
              }) : (
                <div style={{textAlign:'center',padding:'1rem',color:'var(--text-muted)',fontSize:'13px'}}>
                  No TSN bridges configured
                </div>
              )}
              {bridges.length > 0 && onNavigate &&
                <ViewAllLink onClick={function() { onNavigate('tsn'); }}>View All &rarr;</ViewAllLink>
              }
            </PanelBody>
          </Panel>
        </TwoCol>

        <TwoCol>
          <Panel>
            <PanelHeader>
              <span>Active UEs</span>
              <span style={{fontSize:'11px',color:'var(--text-muted)'}}>{connectedUes} connected</span>
            </PanelHeader>
            <PanelBody>
              {ueList.length > 0 ? (
                <div>
                  <UeRowHeader>
                    <span className="ue-supi">SUPI</span>
                    <span className="ue-state">State</span>
                    <span className="ue-pdus">PDUs</span>
                  </UeRowHeader>
                  {ueList.slice(0, 5).map(function(ue, idx) {
                    var supi = ue.supi || ue.imsi || '--';
                    var state = ue.cm_state || ue.state || '--';
                    var shortState = state.replace('CM-', '');
                    // Count PDUs for this UE
                    var uePdus = 0;
                    pduList.forEach(function(p) {
                      if (p.supi === supi) uePdus++;
                    });
                    return (
                      <UeRow key={idx}>
                        <span className="ue-supi">{supi.length > 20 ? supi.slice(0,20) + '...' : supi}</span>
                        <span className="ue-state">{shortState}</span>
                        <span className="ue-pdus">{uePdus}</span>
                      </UeRow>
                    );
                  })}
                  {ueList.length > 5 && <div style={{fontSize:'11px',color:'var(--text-muted)',textAlign:'center',padding:'4px'}}>+{ueList.length - 5} more</div>}
                </div>
              ) : (
                <div style={{textAlign:'center',padding:'1rem',color:'var(--text-muted)',fontSize:'13px'}}>
                  No UEs connected
                </div>
              )}
              {ueList.length > 0 && onNavigate &&
                <ViewAllLink onClick={function() { onNavigate('ue-analytics'); }}>View All &rarr;</ViewAllLink>
              }
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>
              <span>NW-TT Performance</span>
              <span style={{fontSize:'11px',color:'var(--text-muted)'}}>{nwttPorts.length} port{nwttPorts.length !== 1 ? 's' : ''}</span>
            </PanelHeader>
            <PanelBody>
              {nwtt ? (
                <div>
                  <MetricLine>
                    <span className="ml-label">Current Jitter</span>
                    <span className="ml-value">{currentJitter}</span>
                  </MetricLine>
                  <MetricLine>
                    <span className="ml-label">PSFP Pass Rate</span>
                    <span className="ml-value">{psfpRate}</span>
                  </MetricLine>
                  <MetricLine>
                    <span className="ml-label">Total RX</span>
                    <span className="ml-value">{fmtNum(totalRx)} frames</span>
                  </MetricLine>
                  <MetricLine>
                    <span className="ml-label">Total TX</span>
                    <span className="ml-value">{fmtNum(totalTx)} frames</span>
                  </MetricLine>
                </div>
              ) : (
                <div style={{textAlign:'center',padding:'1rem',color:'var(--text-muted)',fontSize:'13px'}}>
                  UPF NW-TT data unavailable
                </div>
              )}
              {nwtt && onNavigate &&
                <ViewAllLink onClick={function() { onNavigate('nwtt-performance'); }}>View All &rarr;</ViewAllLink>
              }
            </PanelBody>
          </Panel>
        </TwoCol>

        <AlertPanel
          rules={alertRules}
          history={alertHistory}
          onToggleRule={onToggleRule}
          onAddRule={onAddRule}
          onRemoveRule={onRemoveRule}
          onClearHistory={onClearAlertHistory}
        />
        <NotificationChannels/>
        <ReportsCard/>
        <SitesManager/>
        <BackupCard/>
      </Wrapper>
    );
  }
}

Overview.propTypes = {
  data: PropTypes.object,
  isLoading: PropTypes.bool,
  error: PropTypes.string,
  lastUpdated: PropTypes.number,
  onNavigate: PropTypes.func,
  alertRules: PropTypes.array,
  alertHistory: PropTypes.array,
  onToggleRule: PropTypes.func,
  onAddRule: PropTypes.func,
  onRemoveRule: PropTypes.func,
  onClearAlertHistory: PropTypes.func
};

export default Overview;
