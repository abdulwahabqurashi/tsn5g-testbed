import { Component } from 'react';
import PropTypes from 'prop-types';
import styled from 'styled-components';
import oc from 'open-color';
import ExportButton from 'components/Shared/ExportButton';
import { exportCSV, exportJSON } from 'helpers/export-utils';
import { StreamFilterManager } from 'components/Tsn';
import { tsnApi } from 'helpers/tsn-api';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const UNIFI_TOOLTIP = {
  background: '#ffffff', border: 'none', borderRadius: 10,
  boxShadow: '0 4px 16px rgba(16,24,40,0.14)',
  color: 'var(--text-primary)', fontSize: 12
};

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

const ErrorBanner = styled.div`
  background: ${oc.red[1]};
  border: 1px solid ${oc.red[4]};
  border-radius: 4px;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  color: ${oc.red[8]};
  font-size: 14px;
`;

const BridgeInfo = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  padding: 1rem;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 2rem;

  .info-item {
    .info-label { font-size: 11px; color: ${'var(--text-muted)'}; text-transform: uppercase; }
    .info-value { font-size: 16px; font-weight: 600; color: ${'var(--text-primary)'}; font-family: monospace; }
  }
`;

const StatusBadge = styled.span`
  display: inline-block;
  padding: 2px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: white;
  background: ${p => p.active ? oc.green[6] : 'var(--text-muted)'};
`;

const PortCard = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  margin-bottom: 1.5rem;
  overflow: hidden;
`;

const PortHeader = styled.div`
  background: ${'var(--accent-soft)'};
  padding: 0.75rem 1rem;
  border-bottom: 1px solid ${'var(--accent-2)'};
  display: flex;
  align-items: center;
  gap: 1rem;
  .port-title { font-size: 15px; font-weight: 600; color: ${'var(--accent)'}; }
  .port-mac { font-size: 12px; color: ${'var(--text-secondary)'}; font-family: monospace; }
`;

const Section = styled.div`
  padding: 0.75rem 1rem;
  border-bottom: 1px solid ${'var(--divider)'};
  &:last-child { border-bottom: none; }
`;

const SectionTitle = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${'var(--text-muted)'};
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 0.5rem;
`;

const MetricGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
`;

const Metric = styled.div`
  min-width: 120px;
  .metric-value { font-size: 18px; font-weight: 600; color: ${'var(--text-primary)'}; font-family: monospace; }
  .metric-label { font-size: 11px; color: ${'var(--text-muted)'}; }
  .metric-sub { font-size: 11px; color: ${'var(--text-muted)'}; font-family: monospace; }
`;

const TwoCol = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  @media (max-width: 768px) { grid-template-columns: 1fr; }
`;

const HistogramBar = styled.div`
  display: flex;
  align-items: center;
  margin-bottom: 4px;
  .hist-label { min-width: 70px; font-size: 11px; color: ${'var(--text-secondary)'}; }
  .hist-track { flex: 1; height: 16px; background: ${'var(--divider)'}; border-radius: 8px; overflow: hidden; margin: 0 8px; }
  .hist-fill { height: 100%; border-radius: 8px; background: ${oc.blue[5]}; transition: width 0.3s; }
  .hist-count { min-width: 60px; text-align: right; font-size: 11px; color: ${'var(--text-secondary)'}; font-family: monospace; }
`;

const PcpGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 6px;
`;

const PcpCell = styled.div`
  text-align: center;
  padding: 6px 4px;
  border-radius: 4px;
  background: ${p => p.intensity > 0.7 ? oc.blue[5] :
    p.intensity > 0.3 ? oc.blue[3] :
    p.intensity > 0 ? oc.blue[1] : 'var(--divider)'};
  color: ${p => p.intensity > 0.3 ? 'white' : 'var(--text-secondary)'};
  .pcp-num { font-size: 10px; font-weight: 600; }
  .pcp-frames { font-size: 11px; font-family: monospace; }
`;

const GaugeTrack = styled.div`
  height: 8px;
  background: ${'var(--border-color)'};
  border-radius: 4px;
  overflow: hidden;
  margin: 6px 0;
`;

const GaugeFill = styled.div`
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
  background: ${p => p.pct > 95 ? oc.green[5] : p.pct > 80 ? oc.yellow[5] : oc.red[5]};
`;

const FilterTable = styled.div`
  .filter-row { display: flex; font-size: 12px; padding: 3px 0; color: ${'var(--text-secondary)'};
    border-bottom: 1px solid ${'var(--divider)'}; }
  .filter-row:last-child { border-bottom: none; }
  .filter-row.header { color: ${'var(--text-muted)'}; font-weight: 600; }
  .fc { min-width: 140px; margin-right: 8px; font-family: monospace; }
  .fc-num { min-width: 90px; margin-right: 8px; font-family: monospace; text-align: right; }
`;

const SparklineWrap = styled.div`
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  margin-left: 8px;
  vertical-align: middle;
  .spark-label { font-size: 9px; color: ${'var(--text-muted)'}; margin-top: 1px; }
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 3rem;
  color: ${'var(--text-muted)'};
  font-size: 14px;
`;

const ChartCard = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  padding: 1rem;
  margin-bottom: 1rem;
`;

const TimeRangeBar = styled.div`
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  align-items: center;
`;

const TimeRangeButton = styled.button`
  padding: 4px 12px;
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid ${function(p) { return p.active ? 'var(--accent)' : 'var(--border-color)'; }};
  background: ${function(p) { return p.active ? 'var(--accent)' : 'white'; }};
  color: ${function(p) { return p.active ? 'white' : 'var(--text-secondary)'; }};
  &:hover { opacity: 0.9; }
`;

const ChartLabel = styled.div`
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .6px;
  text-transform: uppercase;
  color: ${'var(--text-muted)'};
  margin-bottom: 4px;
  margin-top: 12px;
`;

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  var seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  return Math.floor(seconds / 60) + 'm ago';
}

function fmtNum(n) {
  if (n == null) return '--';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function fmtBytes(b) {
  if (b == null) return '--';
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

var MAX_HISTORY = 30;

function renderSparkline(values, color) {
  if (!values || values.length < 2) return null;
  var len = values.length;
  var max = values[0], min = values[0];
  for (var i = 1; i < len; i++) {
    if (values[i] > max) max = values[i];
    if (values[i] < min) min = values[i];
  }
  var range = max - min || 1;
  var w = 120, h = 28, pad = 2;
  var points = [];
  for (var j = 0; j < len; j++) {
    var x = pad + (j / (MAX_HISTORY - 1)) * (w - pad * 2);
    var y = pad + (1 - (values[j] - min) / range) * (h - pad * 2);
    points.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  return (
    <SparklineWrap>
      <svg viewBox={'0 0 ' + w + ' ' + h} width={w} height={h}>
        <polyline points={points.join(' ')} stroke={color} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span className="spark-label">60s trend</span>
    </SparklineWrap>
  );
}

class Dashboard extends Component {
  state = {
    tick: 0,
    history: {},
    managingFilterPort: null,
    timeRange: '1h',
    historyData: [],
    historyLoading: false,
    showCharts: false
  };

  componentWillMount() {
    this._ticker = setInterval(() => {
      this.setState({ tick: this.state.tick + 1 });
    }, 1000);
  }

  componentWillUnmount() {
    if (this._ticker) clearInterval(this._ticker);
  }

  fetchHistory(range, portNumber) {
    var self = this;
    self.setState({ historyLoading: true });
    tsnApi('get', '/api/upf/TsnHistory?range=' + range + '&port=' + (portNumber || 0))
      .then(function(response) {
        self.setState({
          historyData: response.data || [],
          historyLoading: false,
          showCharts: true
        });
      })
      .catch(function() {
        self.setState({ historyData: [], historyLoading: false });
      });
  }

  componentWillReceiveProps(nextProps) {
    var nextPorts = (nextProps.data && nextProps.data.ports) || [];
    var prevPorts = (this.props.data && this.props.data.ports) || [];
    if (nextPorts === prevPorts || nextPorts.length === 0) return;

    var h = {};
    var keys = Object.keys(this.state.history);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      h[key] = {
        residence: (this.state.history[key].residence || []).slice(),
        jitter: (this.state.history[key].jitter || []).slice(),
        rxRate: (this.state.history[key].rxRate || []).slice(),
        psfpRate: (this.state.history[key].psfpRate || []).slice()
      };
    }

    for (var i = 0; i < nextPorts.length; i++) {
      var port = nextPorts[i];
      var pn = port.port_number;
      if (!h[pn]) h[pn] = { residence: [], jitter: [], rxRate: [], psfpRate: [] };
      var ph = h[pn];

      // Residence time avg
      var rt = (port.residence_time || {}).avg_us;
      if (rt != null) {
        ph.residence.push(rt);
        if (ph.residence.length > MAX_HISTORY) ph.residence.shift();
      }

      // Jitter current
      var jt = (port.jitter || {}).current_us;
      if (jt != null) {
        ph.jitter.push(jt);
        if (ph.jitter.length > MAX_HISTORY) ph.jitter.shift();
      }

      // RX frame rate (delta from previous)
      var rxNow = (port.traffic || {}).rx_frames || 0;
      var prevPort = null;
      for (var pi = 0; pi < prevPorts.length; pi++) {
        if (prevPorts[pi].port_number === pn) { prevPort = prevPorts[pi]; break; }
      }
      var rxPrev = prevPort ? ((prevPort.traffic || {}).rx_frames || 0) : rxNow;
      var rxDelta = rxNow - rxPrev;
      if (rxDelta < 0) rxDelta = 0;
      ph.rxRate.push(rxDelta);
      if (ph.rxRate.length > MAX_HISTORY) ph.rxRate.shift();

      // PSFP pass rate
      var psfp = port.psfp || {};
      var total = (psfp.passed_frames || 0) + (psfp.dropped_frames || 0);
      var rate = total > 0 ? ((psfp.passed_frames || 0) / total * 100) : 100;
      ph.psfpRate.push(rate);
      if (ph.psfpRate.length > MAX_HISTORY) ph.psfpRate.shift();
    }

    this.setState({ history: h });
  }

  renderPort(port) {
    var traffic = port.traffic || {};
    var rt = port.residence_time || {};
    var hist = rt.histogram || {};
    var jitter = port.jitter || {};
    var psfp = port.psfp || {};
    var dejitter = port.dejitter || {};
    var pcpStats = port.pcp_stats || [];
    var sf = port.stream_filters || {};
    var ph = this.state.history[port.port_number] || {};

    // Histogram max for scaling bars
    var histValues = [
      hist.under_100us || 0, hist.under_500us || 0,
      hist.under_1ms || 0, hist.under_5ms || 0, hist.over_5ms || 0
    ];
    var histMax = Math.max.apply(null, histValues) || 1;

    // PCP max for intensity
    var pcpMax = 1;
    pcpStats.forEach(function(p) { if (p.frames > pcpMax) pcpMax = p.frames; });

    // Build full PCP array (0-7)
    var pcpFull = [];
    for (var i = 0; i < 8; i++) {
      var found = null;
      pcpStats.forEach(function(p) { if (p.pcp === i) found = p; });
      pcpFull.push(found || { pcp: i, frames: 0, bytes: 0 });
    }

    // PSFP pass percentage
    var psfpTotal = (psfp.passed_frames || 0) + (psfp.dropped_frames || 0);
    var psfpPct = psfpTotal > 0 ? ((psfp.passed_frames || 0) / psfpTotal * 100) : 100;

    var histLabels = ['< 100 us', '< 500 us', '< 1 ms', '< 5 ms', '> 5 ms'];

    return (
      <PortCard key={port.port_number}>
        <PortHeader>
          <span className="port-title">Port {port.port_number}</span>
          <span className="port-mac">{port.mac}</span>
        </PortHeader>

        <Section>
          <SectionTitle>Throughput</SectionTitle>
          <MetricGrid>
            <Metric>
              <div className="metric-value" style={{display:'flex',alignItems:'center'}}>
                {fmtNum(traffic.rx_frames)}
                {renderSparkline(ph.rxRate, oc.blue[5])}
              </div>
              <div className="metric-label">RX Frames</div>
              <div className="metric-sub">{fmtBytes(traffic.rx_bytes)}</div>
            </Metric>
            <Metric>
              <div className="metric-value">{fmtNum(traffic.tx_frames)}</div>
              <div className="metric-label">TX Frames</div>
              <div className="metric-sub">{fmtBytes(traffic.tx_bytes)}</div>
            </Metric>
            <Metric>
              <div className="metric-value">{fmtNum(traffic.gptp_frames)}</div>
              <div className="metric-label">gPTP Frames</div>
            </Metric>
            <Metric>
              <div className="metric-value">{fmtNum(traffic.lldp_frames)}</div>
              <div className="metric-label">LLDP Frames</div>
            </Metric>
          </MetricGrid>
        </Section>

        <Section>
          <TwoCol>
            <div>
              <SectionTitle>Jitter {jitter.current_ns != null ? '(ns precision)' : ''}</SectionTitle>
              <MetricGrid>
                <Metric>
                  <div className="metric-value" style={{display:'flex',alignItems:'center'}}>
                    {jitter.current_ns != null ? (jitter.current_ns / 1000).toFixed(3) + ' us' : (jitter.current_us != null ? jitter.current_us + ' us' : '--')}
                    {renderSparkline(ph.jitter, oc.orange[5])}
                  </div>
                  <div className="metric-label">Current {jitter.current_ns != null ? '(' + jitter.current_ns + ' ns)' : ''}</div>
                </Metric>
                <Metric>
                  <div className="metric-value">{jitter.peak_ns != null ? (jitter.peak_ns / 1000).toFixed(3) + ' us' : (jitter.peak_us != null ? jitter.peak_us + ' us' : '--')}</div>
                  <div className="metric-label">Peak</div>
                </Metric>
                <Metric>
                  <div className="metric-value">{fmtNum(jitter.samples)}</div>
                  <div className="metric-label">Samples</div>
                </Metric>
              </MetricGrid>
            </div>
          </TwoCol>
        </Section>

        <Section>
          <SectionTitle>PCP Traffic Classes</SectionTitle>
          <PcpGrid>
            {pcpFull.map(function(p) {
              return (
                <PcpCell key={p.pcp} intensity={p.frames / pcpMax}>
                  <div className="pcp-num">PCP {p.pcp}</div>
                  <div className="pcp-frames">{fmtNum(p.frames)}</div>
                </PcpCell>
              );
            })}
          </PcpGrid>
        </Section>

        <Section>
          <TwoCol>
            <div>
              <SectionTitle>PSFP (Per-Stream Filtering)</SectionTitle>
              <MetricGrid>
                <Metric>
                  <div className="metric-value">{fmtNum(psfp.passed_frames)}</div>
                  <div className="metric-label">Passed</div>
                  <div className="metric-sub">{fmtBytes(psfp.passed_bytes)}</div>
                </Metric>
                <Metric>
                  <div className="metric-value" style={{color: psfp.dropped_frames > 0 ? oc.red[6] : 'var(--text-primary)'}}>{fmtNum(psfp.dropped_frames)}</div>
                  <div className="metric-label">Dropped</div>
                  <div className="metric-sub">{fmtBytes(psfp.dropped_bytes)}</div>
                </Metric>
              </MetricGrid>
              <GaugeTrack>
                <GaugeFill pct={psfpPct} style={{width: psfpPct + '%'}} />
              </GaugeTrack>
              <div style={{fontSize: '11px', color: 'var(--text-muted)', textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end'}}>
                {psfpPct.toFixed(2)}% pass rate
                {renderSparkline(ph.psfpRate, oc.green[5])}
              </div>
            </div>
            <div>
              <SectionTitle>De-jitter Queue</SectionTitle>
              <MetricGrid>
                <Metric>
                  <div className="metric-value">{dejitter.enabled ? 'ON' : 'OFF'}</div>
                  <div className="metric-label">Status</div>
                </Metric>
                <Metric>
                  <div className="metric-value">{dejitter.target_delay_us || '--'} us</div>
                  <div className="metric-label">Target Delay</div>
                </Metric>
                <Metric>
                  <div className="metric-value">{dejitter.current_depth || 0}/{dejitter.peak_depth || 0}</div>
                  <div className="metric-label">Depth / Peak</div>
                </Metric>
              </MetricGrid>
              <MetricGrid style={{marginTop: '4px'}}>
                <Metric>
                  <div className="metric-sub">Enqueued: {fmtNum(dejitter.enqueued)}</div>
                </Metric>
                <Metric>
                  <div className="metric-sub">Dequeued: {fmtNum(dejitter.dequeued)}</div>
                </Metric>
                <Metric>
                  <div className="metric-sub" style={{color: dejitter.dropped_overflow > 0 ? oc.red[5] : undefined}}>
                    Overflow: {fmtNum(dejitter.dropped_overflow)}
                  </div>
                </Metric>
              </MetricGrid>
            </div>
          </TwoCol>
        </Section>

        {port.lldp_neighbor &&
          <Section>
            <SectionTitle>LLDP Neighbor</SectionTitle>
            <MetricGrid>
              {port.lldp_neighbor.system_name &&
                <Metric>
                  <div className="metric-value" style={{fontSize:'14px'}}>{port.lldp_neighbor.system_name}</div>
                  <div className="metric-label">System Name</div>
                </Metric>
              }
              <Metric>
                <div className="metric-value" style={{fontSize:'12px'}}>{port.lldp_neighbor.chassis_id || '--'}</div>
                <div className="metric-label">Chassis ID</div>
              </Metric>
              <Metric>
                <div className="metric-value" style={{fontSize:'12px'}}>{port.lldp_neighbor.port_id || '--'}</div>
                <div className="metric-label">Port ID</div>
              </Metric>
              <Metric>
                <div className="metric-value">{port.lldp_neighbor.ttl || '--'}s</div>
                <div className="metric-label">TTL</div>
              </Metric>
              {port.lldp_neighbor.port_desc &&
                <Metric>
                  <div className="metric-value" style={{fontSize:'12px'}}>{port.lldp_neighbor.port_desc}</div>
                  <div className="metric-label">Port Description</div>
                </Metric>
              }
            </MetricGrid>
          </Section>
        }

        {sf.count > 0 &&
          <Section>
            <SectionTitle style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <span>Stream Filters ({sf.count} active, {fmtNum(sf.miss_count)} misses)</span>
              <button style={{
                padding:'3px 10px',borderRadius:'3px',fontSize:'10px',fontWeight:600,
                cursor:'pointer',border:'1px solid '+oc.cyan[4],color:oc.cyan[7],background:'white'
              }} onClick={function() { self.setState({managingFilterPort: port.port_number}); }}>
                Manage
              </button>
            </SectionTitle>
            <FilterTable>
              <div className="filter-row header">
                <span className="fc">Dest MAC</span>
                <span className="fc-num">VLAN</span>
                <span className="fc-num">Matches</span>
                <span className="fc-num">Bytes</span>
              </div>
              {(sf.entries || []).map(function(f, idx) {
                return (
                  <div className="filter-row" key={idx}>
                    <span className="fc">{f.dest_mac}</span>
                    <span className="fc-num">{f.vlan_id || '-'}</span>
                    <span className="fc-num">{fmtNum(f.match_count)}</span>
                    <span className="fc-num">{fmtBytes(f.match_bytes)}</span>
                  </div>
                );
              })}
            </FilterTable>
          </Section>
        }
      </PortCard>
    );
  }

  render() {
    const { data, isLoading, error, lastUpdated } = this.props;
    var bridge = (data && data.bridge) || {};
    var ports = (data && data.ports) || [];
    var self = this;

    return (
      <Wrapper>
        <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:'1rem',marginBottom:'0.5rem'}}>
          {ports.length > 0 && <ExportButton
            onExportCSV={function() {
              var cols = [
                { key: 'port', label: 'Port', accessor: function(p) { return p.port_number; } },
                { key: 'mac', label: 'MAC', accessor: function(p) { return p.mac || ''; } },
                { key: 'rx', label: 'RX Frames', accessor: function(p) { return (p.traffic || {}).rx_frames || 0; } },
                { key: 'tx', label: 'TX Frames', accessor: function(p) { return (p.traffic || {}).tx_frames || 0; } },
                { key: 'rt_ns', label: 'Avg Residence (ns)', accessor: function(p) { return (p.residence_time || {}).avg_ns || ''; } },
                { key: 'rt_us', label: 'Avg Residence (us)', accessor: function(p) { var ns = (p.residence_time || {}).avg_ns; return ns != null ? (ns / 1000).toFixed(3) : ((p.residence_time || {}).avg_us || ''); } },
                { key: 'jitter_ns', label: 'Jitter (ns)', accessor: function(p) { return (p.jitter || {}).current_ns || ''; } },
                { key: 'jitter_us', label: 'Jitter (us)', accessor: function(p) { var ns = (p.jitter || {}).current_ns; return ns != null ? (ns / 1000).toFixed(3) : ((p.jitter || {}).current_us || ''); } },
                { key: 'psfp', label: 'PSFP Pass %', accessor: function(p) { var pf = p.psfp || {}; var t = (pf.passed_frames||0)+(pf.dropped_frames||0); return t > 0 ? ((pf.passed_frames||0)/t*100).toFixed(2) : '100'; } }
              ];
              exportCSV(ports, cols, 'nwtt-performance.csv');
            }}
            onExportJSON={function() { exportJSON(data, 'nwtt-performance.json'); }}
          />}
          <RefreshIndicator style={{marginBottom:0}}>
            {isLoading ? 'Refreshing...' : (lastUpdated ? 'Updated ' + formatTimeAgo(lastUpdated) : '')}
            {' | Auto-refresh: 2s'}
          </RefreshIndicator>
        </div>

        {error &&
          <ErrorBanner>
            UPF unreachable: {typeof error === 'string' ? error : 'Connection failed'}
          </ErrorBanner>
        }

        {data &&
          <BridgeInfo>
            <div className="info-item">
              <div className="info-label">Bridge ID</div>
              <div className="info-value">{bridge.id || '--'}</div>
            </div>
            <div className="info-item">
              <div className="info-label">Bridge MAC</div>
              <div className="info-value">{bridge.mac || '--'}</div>
            </div>
            <div className="info-item">
              <div className="info-label">gPTP</div>
              <div className="info-value">
                <StatusBadge active={bridge.gptp_enabled}>
                  {bridge.gptp_enabled ? 'Enabled' : 'Disabled'}
                </StatusBadge>
              </div>
            </div>
            <div className="info-item">
              <div className="info-label">Active Ports</div>
              <div className="info-value">{ports.length}</div>
            </div>
            {bridge.gptp_monitoring &&
              <div className="info-item">
                <div className="info-label">gPTP Sync</div>
                <div className="info-value">
                  <StatusBadge active={bridge.gptp_monitoring.synced}>
                    {bridge.gptp_monitoring.synced ? 'Synced' : 'Not Synced'}
                  </StatusBadge>
                </div>
              </div>
            }
            {bridge.timestamp_source &&
              <div className="info-item">
                <div className="info-label">Timestamp</div>
                <div className="info-value" style={{fontSize:'12px'}}>
                  {bridge.timestamp_source}
                  {bridge.phc2sys_detected &&
                    <span style={{color: oc.green[6], fontSize:'10px', marginLeft:'4px'}}> (PHC synced)</span>
                  }
                </div>
              </div>
            }
          </BridgeInfo>
        }

        {data && bridge.gptp_monitoring && !bridge.gptp_monitoring.synced &&
          <div style={{
            background: oc.yellow[1], border: '1px solid ' + oc.yellow[4],
            borderRadius: '4px', padding: '0.75rem 1rem', marginBottom: '1rem',
            fontSize: '13px', color: oc.yellow[9]
          }}>
            <strong>gPTP Clock NOT Synchronized.</strong>{' '}
            {bridge.gptp_monitoring.degrade_on_unsync
              ? 'Residence time correction is being skipped.'
              : 'WARNING: Inaccurate correction values may be propagated.'}
            {bridge.gptp_monitoring.corrections_skipped > 0 &&
              ' (' + bridge.gptp_monitoring.corrections_skipped + ' corrections skipped)'
            }
          </div>
        }

        {data && bridge.gptp_monitoring &&
          <PortCard>
            <PortHeader>
              <span className="port-title">gPTP Clock Synchronization</span>
              <span className="port-mac">via linuxptp / pmc</span>
            </PortHeader>
            <Section>
              <MetricGrid>
                <Metric>
                  <div className="metric-value" style={{color: bridge.gptp_monitoring.synced ? oc.green[6] : oc.red[6]}}>
                    {bridge.gptp_monitoring.synced ? 'SYNCED' : 'NOT SYNCED'}
                  </div>
                  <div className="metric-label">Status</div>
                </Metric>
                <Metric>
                  <div className="metric-value">{bridge.gptp_monitoring.offset_from_master_ns != null ? bridge.gptp_monitoring.offset_from_master_ns + ' ns' : '--'}</div>
                  <div className="metric-label">Offset from Master</div>
                </Metric>
                <Metric>
                  <div className="metric-value">{bridge.gptp_monitoring.mean_path_delay_ns != null ? bridge.gptp_monitoring.mean_path_delay_ns + ' ns' : '--'}</div>
                  <div className="metric-label">Mean Path Delay</div>
                </Metric>
                {bridge.gptp_monitoring.gm_identity &&
                  <Metric>
                    <div className="metric-value" style={{fontSize:'14px'}}>{bridge.gptp_monitoring.gm_identity}</div>
                    <div className="metric-label">Grandmaster Identity</div>
                  </Metric>
                }
              </MetricGrid>
            </Section>
          </PortCard>
        }

        {data && ports.length > 0 &&
          <ChartCard>
            <SectionTitle style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <span>Historical Trends</span>
              {!self.state.showCharts &&
                <button style={{
                  padding:'4px 12px',borderRadius:'3px',fontSize:'11px',cursor:'pointer',
                  border:'1px solid '+'var(--accent)',color:'var(--accent)',background:'white'
                }} onClick={function() { self.fetchHistory(self.state.timeRange); }}>
                  Load Charts
                </button>
              }
            </SectionTitle>
            {self.state.showCharts &&
              <div>
                <TimeRangeBar>
                  {['15m', '30m', '1h', '6h', '24h', '7d', '30d'].map(function(r) {
                    return (
                      <TimeRangeButton key={r}
                        active={self.state.timeRange === r}
                        onClick={function() {
                          self.setState({timeRange: r});
                          self.fetchHistory(r);
                        }}>
                        {r}
                      </TimeRangeButton>
                    );
                  })}
                  {self.state.historyLoading &&
                    <span style={{fontSize:'11px',color:'var(--text-muted)'}}>Loading...</span>
                  }
                </TimeRangeBar>

                {self.state.historyData.length > 0 &&
                  <div>
                    <ChartLabel>Jitter (us)</ChartLabel>
                    <ResponsiveContainer width="100%" height={180}>
                      <AreaChart data={self.state.historyData}>
                        <defs>
                          <linearGradient id="gJit" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#f5a524" stopOpacity={0.18}/>
                            <stop offset="100%" stopColor="#f5a524" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--divider)" />
                        <XAxis dataKey="timestamp"
                          tickFormatter={function(t) {
                            var d = new Date(t);
                            return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
                          }}
                          axisLine={false} tickLine={false}
                          tick={{fontSize: 10, fill: 'var(--text-muted)'}} />
                        <YAxis axisLine={false} tickLine={false}
                          tick={{fontSize: 10, fill: 'var(--text-muted)'}} />
                        <Tooltip labelFormatter={function(t) { return new Date(t).toLocaleTimeString(); }}
                          contentStyle={UNIFI_TOOLTIP} />
                        <Area type="monotone" dataKey="port.jitter_current_us"
                          stroke="#f5a524" strokeWidth={1.5} fill="url(#gJit)" dot={false}
                          name="Current Jitter (us)" />
                      </AreaChart>
                    </ResponsiveContainer>

                    <ChartLabel>Throughput (frames)</ChartLabel>
                    <ResponsiveContainer width="100%" height={180}>
                      <AreaChart data={self.state.historyData}>
                        <defs>
                          <linearGradient id="gRx" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#478ff7" stopOpacity={0.18}/>
                            <stop offset="100%" stopColor="#478ff7" stopOpacity={0}/>
                          </linearGradient>
                          <linearGradient id="gTx" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#9e7be0" stopOpacity={0.18}/>
                            <stop offset="100%" stopColor="#9e7be0" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--divider)" />
                        <XAxis dataKey="timestamp"
                          tickFormatter={function(t) {
                            var d = new Date(t);
                            return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
                          }}
                          axisLine={false} tickLine={false}
                          tick={{fontSize: 10, fill: 'var(--text-muted)'}} />
                        <YAxis axisLine={false} tickLine={false}
                          tick={{fontSize: 10, fill: 'var(--text-muted)'}} />
                        <Tooltip labelFormatter={function(t) { return new Date(t).toLocaleTimeString(); }}
                          contentStyle={UNIFI_TOOLTIP} />
                        <Area type="monotone" dataKey="port.rx_frames"
                          stroke="#478ff7" strokeWidth={1.5} fill="url(#gRx)" dot={false}
                          name="RX Frames" />
                        <Area type="monotone" dataKey="port.tx_frames"
                          stroke="#9e7be0" strokeWidth={1.5} fill="url(#gTx)" dot={false}
                          name="TX Frames" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                }

                {self.state.historyData.length === 0 && !self.state.historyLoading &&
                  <div style={{textAlign:'center',padding:'1rem',color:'var(--text-muted)',fontSize:'12px'}}>
                    No historical data yet. Metrics are collected every 15 seconds.
                  </div>
                }
              </div>
            }
          </ChartCard>
        }

        {ports.map(function(port) { return self.renderPort(port); })}

        {!data && !isLoading && !error &&
          <EmptyState>No NW-TT performance data available. Ensure the UPF is running with NW-TT bridge enabled.</EmptyState>
        }

        {data && ports.length === 0 &&
          <EmptyState>NW-TT bridge active but no ports configured. Create an Ethernet PDU session to see port metrics.</EmptyState>
        }

        <StreamFilterManager
          visible={self.state.managingFilterPort !== null}
          bridgeId={bridge.id ? String(bridge.id) : ''}
          portNumber={self.state.managingFilterPort}
          currentFilters={
            self.state.managingFilterPort !== null
              ? (function() {
                  var p = ports.filter(function(pt) {
                    return pt.port_number === self.state.managingFilterPort;
                  })[0];
                  return p && p.stream_filters ? p.stream_filters.entries || [] : [];
                })()
              : []
          }
          onHide={function() { self.setState({managingFilterPort: null}); }}
          onRefresh={function() { /* data refreshes automatically via polling */ }}
        />
      </Wrapper>
    );
  }
}

Dashboard.propTypes = {
  data: PropTypes.object,
  isLoading: PropTypes.bool,
  error: PropTypes.string,
  lastUpdated: PropTypes.number
};

export default Dashboard;
