import { Component } from 'react';
import PropTypes from 'prop-types';
import styled from 'styled-components';
import oc from 'open-color';
import ExportButton from 'components/Shared/ExportButton';
import { exportCSV, exportJSON } from 'helpers/export-utils';

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

const SummaryBar = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1.5rem;
`;

const SummaryCard = styled.div`
  min-width: 140px;
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  padding: 1rem;
  border-left: 4px solid ${p => p.color || 'var(--text-muted)'};
  .number { font-size: 28px; font-weight: 600; color: ${'var(--text-primary)'}; font-family: monospace; }
  .label { font-size: 12px; color: ${'var(--text-secondary)'}; margin-top: 4px; }
`;

const TableCard = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  overflow: hidden;
`;

const TableHeader = styled.div`
  display: flex;
  padding: 10px 16px;
  background: ${'var(--divider)'};
  border-bottom: 2px solid ${'var(--border-color)'};
  font-size: 11px;
  font-weight: 600;
  color: ${'var(--text-secondary)'};
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

const TableRow = styled.div`
  display: flex;
  padding: 10px 16px;
  border-bottom: 1px solid ${'var(--divider)'};
  font-size: 13px;
  color: ${'var(--text-secondary)'};
  cursor: pointer;
  transition: background 0.15s;

  &:hover { background: ${oc.blue[0]}; }
  &:last-child { border-bottom: none; }
`;

const Col = styled.div`
  flex: ${p => p.flex || 1};
  min-width: ${p => p.minW || '80px'};
  font-family: ${p => p.mono ? 'monospace' : 'inherit'};
  text-align: ${p => p.right ? 'right' : 'left'};
`;

const ExpandedDetail = styled.div`
  background: ${'var(--bg-hover)'};
  border-bottom: 2px solid ${'var(--accent-2)'};
  padding: 1rem 1.5rem;
`;

const DetailGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
`;

const DetailSection = styled.div`
  .dt-title { font-size: 11px; font-weight: 600; color: ${'var(--text-muted)'}; text-transform: uppercase; margin-bottom: 4px; }
  .dt-row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
  .dt-label { color: ${'var(--text-muted)'}; }
  .dt-value { color: ${'var(--text-primary)'}; font-family: monospace; }
`;

const PcpChips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
`;

const PcpChip = styled.span`
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-family: monospace;
  background: ${oc.violet[1]};
  color: ${oc.violet[8]};
`;

const StatusDot = styled.span`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  background: ${p => p.active ? oc.green[5] : 'var(--text-muted)'};
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 3rem;
  color: ${'var(--text-muted)'};
  font-size: 14px;
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

class Dashboard extends Component {
  state = { tick: 0, expandedPort: null };

  componentWillMount() {
    this._ticker = setInterval(() => {
      this.setState({ tick: this.state.tick + 1 });
    }, 1000);
  }

  componentWillUnmount() {
    if (this._ticker) clearInterval(this._ticker);
  }

  toggleExpand(portNumber) {
    this.setState({
      expandedPort: this.state.expandedPort === portNumber ? null : portNumber
    });
  }

  renderExpandedDetail(port) {
    var traffic = port.traffic || {};
    var rt = port.residence_time || {};
    var jitter = port.jitter || {};
    var dejitter = port.dejitter || {};
    var sf = port.stream_filters || {};
    var pcpStats = port.pcp_stats || [];

    return (
      <ExpandedDetail>
        <DetailGrid>
          <DetailSection>
            <div className="dt-title">Traffic</div>
            <div className="dt-row"><span className="dt-label">RX Frames</span><span className="dt-value">{fmtNum(traffic.rx_frames)}</span></div>
            <div className="dt-row"><span className="dt-label">RX Bytes</span><span className="dt-value">{fmtBytes(traffic.rx_bytes)}</span></div>
            <div className="dt-row"><span className="dt-label">TX Frames</span><span className="dt-value">{fmtNum(traffic.tx_frames)}</span></div>
            <div className="dt-row"><span className="dt-label">TX Bytes</span><span className="dt-value">{fmtBytes(traffic.tx_bytes)}</span></div>
            <div className="dt-row"><span className="dt-label">gPTP Frames</span><span className="dt-value">{fmtNum(traffic.gptp_frames)}</span></div>
            <div className="dt-row"><span className="dt-label">LLDP Frames</span><span className="dt-value">{fmtNum(traffic.lldp_frames)}</span></div>
          </DetailSection>
          <DetailSection>
            <div className="dt-title">De-jitter Queue</div>
            <div className="dt-row"><span className="dt-label">Enabled</span><span className="dt-value">{dejitter.enabled ? 'Yes' : 'No'}</span></div>
            <div className="dt-row"><span className="dt-label">Target Delay</span><span className="dt-value">{dejitter.target_delay_us} us</span></div>
            <div className="dt-row"><span className="dt-label">Enqueued</span><span className="dt-value">{fmtNum(dejitter.enqueued)}</span></div>
            <div className="dt-row"><span className="dt-label">Dequeued</span><span className="dt-value">{fmtNum(dejitter.dequeued)}</span></div>
            <div className="dt-row"><span className="dt-label">Overflow</span><span className="dt-value">{fmtNum(dejitter.dropped_overflow)}</span></div>
          </DetailSection>
          <DetailSection>
            <div className="dt-title">Stream Filters</div>
            <div className="dt-row"><span className="dt-label">Active</span><span className="dt-value">{sf.count || 0}</span></div>
            <div className="dt-row"><span className="dt-label">Misses</span><span className="dt-value">{fmtNum(sf.miss_count)}</span></div>
          </DetailSection>
        </DetailGrid>
        {pcpStats.length > 0 &&
          <div style={{marginTop: '0.75rem'}}>
            <div style={{fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px'}}>PCP Distribution</div>
            <PcpChips>
              {pcpStats.map(function(p) {
                return <PcpChip key={p.pcp}>PCP {p.pcp}: {fmtNum(p.frames)}</PcpChip>;
              })}
            </PcpChips>
          </div>
        }
      </ExpandedDetail>
    );
  }

  render() {
    const { data, isLoading, error, lastUpdated } = this.props;
    var ports = (data && data.ports) || [];
    var self = this;

    // Summary calculations
    var totalFrames = 0;
    var totalBytes = 0;
    var totalJitter = 0;
    var jitterCount = 0;
    ports.forEach(function(p) {
      var t = p.traffic || {};
      totalFrames += (t.rx_frames || 0) + (t.tx_frames || 0);
      totalBytes += (t.rx_bytes || 0) + (t.tx_bytes || 0);
      if (p.jitter && p.jitter.current_us != null) {
        totalJitter += p.jitter.current_us;
        jitterCount++;
      }
    });
    var avgJitter = jitterCount > 0 ? Math.round(totalJitter / jitterCount) : 0;

    return (
      <Wrapper>
        <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:'1rem',marginBottom:'0.5rem'}}>
          {ports.length > 0 && <ExportButton
            onExportCSV={function() {
              var cols = [
                { key: 'port', label: 'Port', accessor: function(p) { return p.port_number; } },
                { key: 'device', label: 'Device', accessor: function(p) { return (p.lldp_neighbor || {}).system_name || p.ue_mac || ''; } },
                { key: 'mac', label: 'Port MAC', accessor: function(p) { return p.mac || ''; } },
                { key: 'rx', label: 'RX Frames', accessor: function(p) { return (p.traffic || {}).rx_frames || 0; } },
                { key: 'tx', label: 'TX Frames', accessor: function(p) { return (p.traffic || {}).tx_frames || 0; } },
                { key: 'jitter', label: 'Jitter (us)', accessor: function(p) { return (p.jitter || {}).current_us || ''; } }
              ];
              exportCSV(ports, cols, 'tsn-sessions.csv');
            }}
            onExportJSON={function() { exportJSON(data, 'tsn-sessions.json'); }}
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

        <SummaryBar>
          <SummaryCard color={'var(--accent)'}>
            <div className="number">{ports.length}</div>
            <div className="label">Active Sessions</div>
          </SummaryCard>
          <SummaryCard color={oc.blue[5]}>
            <div className="number">{fmtNum(totalFrames)}</div>
            <div className="label">Total Frames</div>
          </SummaryCard>
          <SummaryCard color={'var(--accent)'}>
            <div className="number">{fmtBytes(totalBytes)}</div>
            <div className="label">Total Bytes</div>
          </SummaryCard>
          <SummaryCard color={oc.violet[5]}>
            <div className="number">{avgJitter} us</div>
            <div className="label">Avg Jitter</div>
          </SummaryCard>
        </SummaryBar>

        {ports.length > 0 &&
          <TableCard>
            <TableHeader>
              <Col flex={0.5}>Status</Col>
              <Col flex={0.5}>Port</Col>
              <Col flex={1.5} minW="150px">Device (DS-TT)</Col>
              <Col flex={1.2} minW="130px">Port MAC</Col>
              <Col flex={1} right>RX Frames</Col>
              <Col flex={1} right>TX Frames</Col>
              <Col flex={1} right>Jitter</Col>
              <Col flex={0.8} right>PSFP</Col>
            </TableHeader>
            {ports.map(function(port) {
              var traffic = port.traffic || {};
              var rt = port.residence_time || {};
              var jitter = port.jitter || {};
              var psfp = port.psfp || {};
              var psfpTotal = (psfp.passed_frames || 0) + (psfp.dropped_frames || 0);
              var psfpPct = psfpTotal > 0 ? ((psfp.passed_frames || 0) / psfpTotal * 100) : 100;
              var hasTraffic = (traffic.rx_frames || 0) + (traffic.tx_frames || 0) > 0;

              return [
                <TableRow key={'row-' + port.port_number}
                  onClick={function() { self.toggleExpand(port.port_number); }}>
                  <Col flex={0.5}><StatusDot active={hasTraffic} />{hasTraffic ? 'Active' : 'Idle'}</Col>
                  <Col flex={0.5} mono>{port.port_number}</Col>
                  <Col flex={1.5} minW="150px" mono>
                    {(port.lldp_neighbor || {}).system_name ||
                      port.ue_mac || 'unknown'}
                  </Col>
                  <Col flex={1.2} minW="130px" mono>{port.mac}</Col>
                  <Col flex={1} right mono>{fmtNum(traffic.rx_frames)}</Col>
                  <Col flex={1} right mono>{fmtNum(traffic.tx_frames)}</Col>
                  <Col flex={1} right mono>{jitter.current_us != null ? jitter.current_us + ' us' : '--'}</Col>
                  <Col flex={0.8} right mono>{psfpPct.toFixed(1)}%</Col>
                </TableRow>,
                self.state.expandedPort === port.port_number &&
                  <div key={'detail-' + port.port_number}>
                    {self.renderExpandedDetail(port)}
                  </div>
              ];
            })}
          </TableCard>
        }

        {!data && !isLoading && !error &&
          <EmptyState>No active TSN sessions. Ensure the UPF is running and an Ethernet PDU session is established.</EmptyState>
        }

        {data && ports.length === 0 &&
          <EmptyState>No active Ethernet PDU sessions detected.</EmptyState>
        }
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
