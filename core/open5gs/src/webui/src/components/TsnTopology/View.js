import { Component } from 'react';
import PropTypes from 'prop-types';
import styled from 'styled-components';
import TopologyFlow from 'components/Shared/TopologyFlow';
import oc from 'open-color';

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

const GraphCard = styled.div`
  background: var(--bg-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);
  border-radius: 4px;
  margin-bottom: 1.5rem;
  overflow: hidden;
`;

const GraphTitle = styled.div`
  padding: 1rem;
  font-size: 16px;
  font-weight: 600;
  color: ${'var(--text-secondary)'};
  border-bottom: 1px solid ${'var(--divider)'};
`;

const GraphCanvas = styled.div`
  height: 420px;
  width: 100%;
`;

const Legend = styled.div`
  display: flex;
  justify-content: center;
  gap: 1.5rem;
  padding: 0.75rem;
  border-top: 1px solid ${'var(--divider)'};
`;

const LegendItem = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: ${'#aab4c5'};
`;

const LegendDot = styled.span`
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${function(p) { return p.color; }};
`;

const DetailCards = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
`;

const DetailCard = styled.div`
  background: var(--bg-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);
  border-radius: 4px;
  border-top: 3px solid ${function(p) { return p.color || 'var(--accent)'; }};
  overflow: hidden;
`;

const DetailTitle = styled.div`
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
  color: ${'var(--text-secondary)'};
  background: ${'var(--bg-panel-header)'};
  border-bottom: 1px solid ${'var(--divider)'};
`;

const DetailBody = styled.div`
  padding: 10px 14px;
`;

const DetailRow = styled.div`
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 12px;
  .dl { color: ${'var(--text-muted)'}; }
  .dv { color: ${'var(--text-primary)'}; font-family: monospace; }
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

class View extends Component {
  state = { tick: 0, selectedNode: null, selectedNodeData: null };

  componentWillMount() {
    this._ticker = setInterval(function() {
      this.setState({ tick: this.state.tick + 1 });
    }.bind(this), 1000);
  }

  handleSelect = (node) => {
    var data = this.props.data || {};
    var upf = data.upf || {};
    var bridge = upf.bridge || {};
    var ports = upf.ports || [];
    var afBridges = ((data.tsnAf || {}).bridges) || [];
    var detail = null;

    if (node.kind === 'upf') {
      detail = { type: 'bridge', label: '5GS TSN Bridge', bridgeId: bridge.id,
        mac: bridge.mac, gptp: bridge.gptp_enabled, ports: ports.length,
        afBridges: afBridges };
    } else if (node.kind === 'gnb') {
      detail = { type: 'gnb', label: 'gNodeB' };
    } else if (node.kind === 'ue') {
      var port = ports[0];
      if (port) {
        detail = { type: 'port', label: 'Port ' + port.port_number,
          portNumber: port.port_number, mac: port.mac,
          traffic: port.traffic, jitter: port.jitter };
      }
    } else if (node.kind === 'device') {
      detail = { type: 'device', label: 'LAN Device', mac: node.mac, vendor: node.vendor };
    }

    this.setState({ selectedNode: node.id, selectedNodeData: detail });
  }

  renderSelectedDetail() {
    var nd = this.state.selectedNodeData;
    if (!nd) return null;

    if (nd.type === 'device') {
      return (
        <DetailCard color={'#43c478'}>
          <DetailTitle>{nd.label}</DetailTitle>
          <DetailBody>
            <DetailRow><span className="dl">MAC</span><span className="dv">{nd.mac || '--'}</span></DetailRow>
            <DetailRow><span className="dl">Manufacturer</span><span className="dv">{nd.vendor || 'unknown / randomized'}</span></DetailRow>
            <DetailRow><span className="dl">Learned via</span><span className="dv">Ethernet PDU session</span></DetailRow>
          </DetailBody>
        </DetailCard>
      );
    }

    if (nd.type === 'bridge') {
      return (
        <DetailCard color={oc.green[5]}>
          <DetailTitle>{nd.label}</DetailTitle>
          <DetailBody>
            <DetailRow><span className="dl">Bridge ID</span><span className="dv">{nd.bridgeId || '--'}</span></DetailRow>
            <DetailRow><span className="dl">MAC</span><span className="dv">{nd.mac || '--'}</span></DetailRow>
            <DetailRow><span className="dl">gPTP</span><span className="dv">{nd.gptp ? 'Enabled' : 'Disabled'}</span></DetailRow>
            <DetailRow><span className="dl">Active Ports</span><span className="dv">{nd.ports}</span></DetailRow>
            {nd.afBridges && nd.afBridges.map(function(b, idx) {
              return (
                <div key={idx} style={{borderTop: '1px solid ' + 'var(--divider)', marginTop: 6, paddingTop: 6}}>
                  <DetailRow><span className="dl">Linux Bridge</span><span className="dv">{b.linuxBridge || '--'}</span></DetailRow>
                  <DetailRow><span className="dl">DNN</span><span className="dv">{b.dnn || '--'}</span></DetailRow>
                  <DetailRow><span className="dl">Physical NIC</span><span className="dv">{b.physicalInterface || '--'}</span></DetailRow>
                </div>
              );
            })}
          </DetailBody>
        </DetailCard>
      );
    }

    if (nd.type === 'port') {
      var t = nd.traffic || {};
      var rt = nd.residenceTime || {};
      var j = nd.jitter || {};
      return (
        <DetailCard color={'var(--accent)'}>
          <DetailTitle>{nd.label}</DetailTitle>
          <DetailBody>
            <DetailRow><span className="dl">MAC</span><span className="dv">{nd.mac || '--'}</span></DetailRow>
            <DetailRow><span className="dl">RX Frames</span><span className="dv">{fmtNum(t.rx_frames)}</span></DetailRow>
            <DetailRow><span className="dl">TX Frames</span><span className="dv">{fmtNum(t.tx_frames)}</span></DetailRow>
            <DetailRow><span className="dl">gPTP Frames</span><span className="dv">{fmtNum(t.gptp_frames)}</span></DetailRow>
            <DetailRow><span className="dl">Jitter</span><span className="dv">{j.current_us != null ? j.current_us + ' us' : '--'}</span></DetailRow>
          </DetailBody>
        </DetailCard>
      );
    }

    if (nd.type === 'lldp') {
      return (
        <DetailCard color={'var(--accent)'}>
          <DetailTitle>LLDP Neighbor: {nd.label}</DetailTitle>
          <DetailBody>
            <DetailRow><span className="dl">System Name</span><span className="dv">{nd.systemName || '--'}</span></DetailRow>
            <DetailRow><span className="dl">Chassis ID</span><span className="dv">{nd.chassisId || '--'}</span></DetailRow>
            <DetailRow><span className="dl">Port ID</span><span className="dv">{nd.portId || '--'}</span></DetailRow>
            <DetailRow><span className="dl">TTL</span><span className="dv">{nd.ttl || '--'}</span></DetailRow>
            {nd.systemDesc &&
              <DetailRow><span className="dl">System Desc</span><span className="dv">{nd.systemDesc}</span></DetailRow>
            }
            {nd.portDesc &&
              <DetailRow><span className="dl">Port Desc</span><span className="dv">{nd.portDesc}</span></DetailRow>
            }
          </DetailBody>
        </DetailCard>
      );
    }

    if (nd.type === 'ue') {
      return (
        <DetailCard color={oc.yellow[5]}>
          <DetailTitle>{nd.label}</DetailTitle>
          <DetailBody>
            <DetailRow><span className="dl">Type</span><span className="dv">DS-TT (Device-side TT)</span></DetailRow>
            <DetailRow><span className="dl">Port</span><span className="dv">{nd.portNumber}</span></DetailRow>
          </DetailBody>
        </DetailCard>
      );
    }

    if (nd.type === 'gnb') {
      return (
        <DetailCard color={'var(--text-muted)'}>
          <DetailTitle>{nd.label}</DetailTitle>
          <DetailBody>
            <DetailRow><span className="dl">Type</span><span className="dv">5G Base Station</span></DetailRow>
            <DetailRow><span className="dl">Connection</span><span className="dv">N3 GTP-U to UPF</span></DetailRow>
          </DetailBody>
        </DetailCard>
      );
    }

    return null;
  }

  render() {
    var self = this;
    var data = this.props.data;
    var isLoading = this.props.isLoading;
    var error = this.props.error;
    var lastUpdated = this.props.lastUpdated;

    var upf = (data && data.upf) || {};
    var tsnAf = (data && data.tsnAf) || {};
    var bridge = upf.bridge || {};
    var ports = upf.ports || [];
    var afBridges = (tsnAf && tsnAf.bridges) || [];

    var totalRx = 0, totalTx = 0;
    ports.forEach(function(p) {
      totalRx += (p.traffic || {}).rx_frames || 0;
      totalTx += (p.traffic || {}).tx_frames || 0;
    });

    return (
      <Wrapper>
        <RefreshIndicator>
          {isLoading ? 'Refreshing...' : (lastUpdated ? 'Updated ' + formatTimeAgo(lastUpdated) : '')}
          {' | Auto-refresh: 5s'}
        </RefreshIndicator>

        {error &&
          <ErrorBanner>
            Connection error: {typeof error === 'string' ? error : 'Failed to fetch topology data'}
          </ErrorBanner>
        }

        <GraphCard>
          <GraphTitle>5G-TSN Network Topology</GraphTitle>
          <div style={{padding: '10px 4px 4px'}}>
            <TopologyFlow
              bridge={bridge}
              ports={ports}
              gnbCount={ports.length > 0 ? 1 : 0}
              onSelect={this.handleSelect}
              selectedId={this.state.selectedNode}
            />
          </div>
          <Legend>
            <LegendItem><LegendDot color={'#43c478'} /> Active &middot; animated flow</LegendItem>
            <LegendItem><LegendDot color={'#d1d5db'} /> Inactive</LegendItem>
            <LegendItem><LegendDot color={'#006fff'} /> Selected &middot; click a node for details</LegendItem>
          </Legend>
        </GraphCard>

        <DetailCards>
          {self.state.selectedNodeData ?
            self.renderSelectedDetail()
          :
            <div>
              <DetailCard color={'var(--accent)'}>
                <DetailTitle>5GS TSN Bridge</DetailTitle>
                <DetailBody>
                  <DetailRow><span className="dl">Bridge ID</span><span className="dv">{bridge.id || '--'}</span></DetailRow>
                  <DetailRow><span className="dl">MAC</span><span className="dv">{bridge.mac || '--'}</span></DetailRow>
                  <DetailRow><span className="dl">gPTP</span><span className="dv">{bridge.gptp_enabled ? 'Enabled' : 'Disabled'}</span></DetailRow>
                  <DetailRow><span className="dl">Active Ports</span><span className="dv">{ports.length}</span></DetailRow>
                  <DetailRow><span className="dl">Total RX</span><span className="dv">{fmtNum(totalRx)}</span></DetailRow>
                  <DetailRow><span className="dl">Total TX</span><span className="dv">{fmtNum(totalTx)}</span></DetailRow>
                </DetailBody>
              </DetailCard>

              <DetailCard color={oc.blue[5]}>
                <DetailTitle>gPTP / 802.1AS</DetailTitle>
                <DetailBody>
                  <DetailRow><span className="dl">Status</span><span className="dv">{bridge.gptp_enabled ? 'Active' : 'Inactive'}</span></DetailRow>
                  <DetailRow><span className="dl">Mode</span><span className="dv">Transparent Clock</span></DetailRow>
                  {bridge.gptp_monitoring &&
                    <DetailRow><span className="dl">Synced</span><span className="dv">{bridge.gptp_monitoring.synced ? 'Yes' : 'No'}</span></DetailRow>
                  }
                  {bridge.gptp_monitoring && bridge.gptp_monitoring.offset_from_master_ns != null &&
                    <DetailRow><span className="dl">Offset</span><span className="dv">{bridge.gptp_monitoring.offset_from_master_ns} ns</span></DetailRow>
                  }
                </DetailBody>
              </DetailCard>

              {afBridges.length > 0 &&
                <DetailCard color={'var(--accent)'}>
                  <DetailTitle>TSN-AF Bridges</DetailTitle>
                  <DetailBody>
                    {afBridges.map(function(b, idx) {
                      return (
                        <div key={idx} style={idx > 0 ? {borderTop: '1px solid ' + 'var(--divider)', marginTop: 6, paddingTop: 6} : {}}>
                          <DetailRow><span className="dl">Bridge ID</span><span className="dv">{b.bridgeId || '--'}</span></DetailRow>
                          <DetailRow><span className="dl">Linux Bridge</span><span className="dv">{b.linuxBridge || '--'}</span></DetailRow>
                          <DetailRow><span className="dl">DNN</span><span className="dv">{b.dnn || '--'}</span></DetailRow>
                          <DetailRow><span className="dl">Physical NIC</span><span className="dv">{b.physicalInterface || '--'}</span></DetailRow>
                        </div>
                      );
                    })}
                  </DetailBody>
                </DetailCard>
              }
            </div>
          }
        </DetailCards>

        {!data && !isLoading && !error &&
          <EmptyState>No topology data available. Ensure UPF and TSN-AF are running.</EmptyState>
        }
      </Wrapper>
    );
  }
}

View.propTypes = {
  data: PropTypes.object,
  isLoading: PropTypes.bool,
  error: PropTypes.string,
  lastUpdated: PropTypes.number
};

export default View;
