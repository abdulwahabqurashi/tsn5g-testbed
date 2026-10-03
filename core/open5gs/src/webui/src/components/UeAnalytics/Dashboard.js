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

const SummaryRow = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
`;

const SummaryCard = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  border-top: 3px solid ${p => p.color || 'var(--accent)'};
  padding: 1rem;
  text-align: center;
`;

const SummaryValue = styled.div`
  font-size: 28px;
  font-weight: 700;
  color: ${'var(--text-primary)'};
`;

const SummaryLabel = styled.div`
  font-size: 12px;
  color: ${'var(--text-muted)'};
  text-transform: uppercase;
  margin-top: 4px;
`;

const Card = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  margin-bottom: 1rem;
  overflow: hidden;
`;

const CardHeader = styled.div`
  background: ${p => p.bg || 'var(--bg-hover)'};
  padding: 0.75rem 1rem;
  border-bottom: 1px solid ${'var(--border-color)'};
  font-size: 14px;
  font-weight: 600;
  color: ${'var(--text-secondary)'};
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th {
    text-align: left;
    padding: 8px 12px;
    background: ${'var(--bg-hover)'};
    border-bottom: 2px solid ${'var(--border-color)'};
    color: ${'var(--text-secondary)'};
    font-size: 11px;
    text-transform: uppercase;
    font-weight: 600;
  }

  td {
    padding: 8px 12px;
    border-bottom: 1px solid ${'var(--divider)'};
    color: ${'var(--text-primary)'};
  }

  tr:last-child td {
    border-bottom: none;
  }
`;

const UeRow = styled.tr`
  cursor: pointer;
  transition: background 0.15s;

  &:hover {
    background: ${'var(--bg-hover)'};
  }

  ${p => p.selected && `
    background: ${'var(--bg-panel-header)'};
    &:hover { background: ${'var(--bg-panel-header)'}; }
  `}
`;

const StatusDot = styled.span`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  background: ${p =>
    p.status === 'connected' ? oc.green[5] :
    p.status === 'idle' ? oc.yellow[5] :
    'var(--text-muted)'};
`;

const DetailPanel = styled.div`
  background: ${'var(--bg-hover)'};
  border-top: 1px solid ${'var(--border-color)'};
  padding: 1rem 1.5rem;
`;

const DetailSection = styled.div`
  margin-bottom: 1rem;
  &:last-child { margin-bottom: 0; }
`;

const DetailSectionTitle = styled.div`
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: ${'var(--text-muted)'};
  margin-bottom: 6px;
  letter-spacing: 0.5px;
`;

const DetailGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 4px 24px;
`;

const DetailItem = styled.div`
  font-size: 12px;
  padding: 2px 0;
  .dl { color: ${'var(--text-muted)'}; }
  .dv { color: ${'var(--text-primary)'}; font-family: monospace; }
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 3rem;
  color: ${'var(--text-muted)'};
  font-size: 14px;
`;

const Mono = styled.span`
  font-family: monospace;
`;

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  var seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  return Math.floor(seconds / 60) + 'm ago';
}

function formatBitRate(bps) {
  if (bps == null) return '--';
  if (bps >= 1000000000) return (bps / 1000000000).toFixed(1) + ' Gbps';
  if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' Mbps';
  if (bps >= 1000) return (bps / 1000).toFixed(1) + ' Kbps';
  return bps + ' bps';
}

function formatSnssai(snssai) {
  if (!snssai) return '--';
  var s = 'SST:' + snssai.sst;
  if (snssai.sd) s += '/SD:' + snssai.sd;
  return s;
}

class Dashboard extends Component {
  state = { tick: 0, expandedUe: null };

  componentWillMount() {
    this._ticker = setInterval(() => {
      this.setState({ tick: this.state.tick + 1 });
    }, 1000);
  }

  componentWillUnmount() {
    if (this._ticker) clearInterval(this._ticker);
  }

  toggleUe(supi) {
    this.setState({
      expandedUe: this.state.expandedUe === supi ? null : supi
    });
  }

  render() {
    var self = this;
    var { data, isLoading, error, lastUpdated } = this.props;
    var expandedUe = this.state.expandedUe;

    var ueData = (data && data.ues) || {};
    var ueItems = ueData.items || [];
    var gnbItems = (data && data.gnbs) || [];
    var pduData = (data && data.pdus) || {};
    var pduItems = pduData.items || [];

    // Build PDU lookup by SUPI
    var pduBySufi = {};
    pduItems.forEach(function(p) {
      if (p.supi) pduBySufi[p.supi] = p;
    });

    // Count stats
    var connectedCount = 0;
    var idleCount = 0;
    var totalPduSessions = 0;

    ueItems.forEach(function(ue) {
      if (ue.cm_state === 'connected') connectedCount++;
      else idleCount++;
      totalPduSessions += (ue.pdu_sessions || []).length;
    });

    return (
      <Wrapper>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.5rem'}}>
          <div />
          <div style={{display:'flex',alignItems:'center',gap:'1rem'}}>
            {ueItems.length > 0 && <ExportButton
              onExportCSV={function() {
                var cols = [
                  { key: 'supi', label: 'SUPI', accessor: function(u) { return u.supi || u.imsi || ''; } },
                  { key: 'state', label: 'CM State', accessor: function(u) { return u.cm_state || ''; } },
                  { key: 'gnb', label: 'gNB', accessor: function(u) { return u.gnb_id || ''; } },
                  { key: 'pdu', label: 'PDU Sessions', accessor: function(u) { var p = pduBySufi[u.supi || u.imsi]; return p ? (p.sessions || []).length : 0; } }
                ];
                exportCSV(ueItems, cols, 'ue-analytics.csv');
              }}
              onExportJSON={function() { exportJSON(data, 'ue-analytics.json'); }}
            />}
            <RefreshIndicator style={{marginBottom:0}}>
              {isLoading ? 'Refreshing...' : (lastUpdated ? 'Updated ' + formatTimeAgo(lastUpdated) : '')}
              {' | Auto-refresh: 3s'}
            </RefreshIndicator>
          </div>
        </div>

        {error &&
          <ErrorBanner>
            Connection error: {typeof error === 'string' ? error : 'Failed to fetch UE data'}
          </ErrorBanner>
        }

        <SummaryRow>
          <SummaryCard color={oc.green[5]}>
            <SummaryValue>{connectedCount}</SummaryValue>
            <SummaryLabel>Connected UEs</SummaryLabel>
          </SummaryCard>
          <SummaryCard color={oc.yellow[5]}>
            <SummaryValue>{idleCount}</SummaryValue>
            <SummaryLabel>Idle UEs</SummaryLabel>
          </SummaryCard>
          <SummaryCard color={oc.blue[5]}>
            <SummaryValue>{gnbItems.length}</SummaryValue>
            <SummaryLabel>Active gNBs</SummaryLabel>
          </SummaryCard>
          <SummaryCard color={'var(--accent)'}>
            <SummaryValue>{totalPduSessions}</SummaryValue>
            <SummaryLabel>PDU Sessions</SummaryLabel>
          </SummaryCard>
        </SummaryRow>

        {gnbItems.length > 0 &&
          <Card>
            <CardHeader bg={oc.blue[0]}>Connected gNBs</CardHeader>
            <Table>
              <thead>
                <tr>
                  <th>gNB ID</th>
                  <th>PLMN</th>
                  <th>SCTP Peer</th>
                  <th>Connected UEs</th>
                </tr>
              </thead>
              <tbody>
                {gnbItems.map(function(gnb, idx) {
                  return (
                    <tr key={idx}>
                      <td><Mono>{gnb.gnb_id || '--'}</Mono></td>
                      <td><Mono>{gnb.plmn_id || '--'}</Mono></td>
                      <td><Mono>{gnb.sctp_peer || '--'}</Mono></td>
                      <td>{gnb.num_connected_ues != null ? gnb.num_connected_ues : '--'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        }

        <Card>
          <CardHeader>Connected UEs ({ueItems.length})</CardHeader>
          {ueItems.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <th>SUPI</th>
                  <th>State</th>
                  <th>gNB</th>
                  <th>PDU Sessions</th>
                  <th>Slice</th>
                  <th>AMBR DL</th>
                </tr>
              </thead>
              <tbody>
                {ueItems.map(function(ue) {
                  var supi = ue.supi || '--';
                  var gnb = ue.gnb || {};
                  var slices = ue.allowed_slices || ue.requested_slices || [];
                  var sliceStr = slices.length > 0 ? formatSnssai(slices[0]) : '--';
                  var ambr = ue.ambr || {};
                  var pduCount = (ue.pdu_sessions || []).length;
                  var isExpanded = expandedUe === supi;
                  var smfData = pduBySufi[supi];

                  var rows = [];
                  rows.push(
                    <UeRow key={supi} selected={isExpanded}
                      onClick={function() { self.toggleUe(supi); }}>
                      <td><Mono>{supi}</Mono></td>
                      <td>
                        <StatusDot status={ue.cm_state} />
                        {ue.cm_state === 'connected' ? 'CM-CONNECTED' : 'CM-IDLE'}
                      </td>
                      <td><Mono>{gnb.gnb_id || '--'}</Mono></td>
                      <td>{pduCount} active</td>
                      <td>{sliceStr}</td>
                      <td>{formatBitRate(ambr.downlink)}</td>
                    </UeRow>
                  );

                  if (isExpanded) {
                    rows.push(
                      <tr key={supi + '-detail'}>
                        <td colSpan="6" style={{padding: 0}}>
                          <DetailPanel>
                            <DetailSection>
                              <DetailSectionTitle>Identity</DetailSectionTitle>
                              <DetailGrid>
                                <DetailItem><span className="dl">SUPI: </span><span className="dv">{ue.supi || '--'}</span></DetailItem>
                                <DetailItem><span className="dl">SUCI: </span><span className="dv">{ue.suci || '--'}</span></DetailItem>
                                <DetailItem><span className="dl">PEI: </span><span className="dv">{ue.pei || '--'}</span></DetailItem>
                                <DetailItem><span className="dl">MSISDN: </span><span className="dv">{ue.msisdn || '--'}</span></DetailItem>
                                <DetailItem><span className="dl">GUTI: </span><span className="dv">{ue.guti || '--'}</span></DetailItem>
                                <DetailItem><span className="dl">M-TMSI: </span><span className="dv">{ue.m_tmsi || '--'}</span></DetailItem>
                              </DetailGrid>
                            </DetailSection>

                            <DetailSection>
                              <DetailSectionTitle>Radio</DetailSectionTitle>
                              <DetailGrid>
                                <DetailItem><span className="dl">gNB ID: </span><span className="dv">{gnb.gnb_id || '--'}</span></DetailItem>
                                <DetailItem><span className="dl">Cell ID: </span><span className="dv">{gnb.cell_id || '--'}</span></DetailItem>
                                {ue.location && ue.location.nr_tai &&
                                  <DetailItem><span className="dl">TAC: </span><span className="dv">{ue.location.nr_tai.tac || '--'}</span></DetailItem>
                                }
                                <DetailItem><span className="dl">AMF UE NGAP ID: </span><span className="dv">{gnb.amf_ue_ngap_id != null ? gnb.amf_ue_ngap_id : '--'}</span></DetailItem>
                                <DetailItem><span className="dl">RAN UE NGAP ID: </span><span className="dv">{gnb.ran_ue_ngap_id != null ? gnb.ran_ue_ngap_id : '--'}</span></DetailItem>
                              </DetailGrid>
                            </DetailSection>

                            <DetailSection>
                              <DetailSectionTitle>Security</DetailSectionTitle>
                              <DetailGrid>
                                <DetailItem><span className="dl">Status: </span><span className="dv">{ue.security ? (ue.security.valid ? 'Valid' : 'Invalid') : '--'}</span></DetailItem>
                                <DetailItem><span className="dl">Encryption: </span><span className="dv">{(ue.security || {}).enc_algorithm || '--'}</span></DetailItem>
                                <DetailItem><span className="dl">Integrity: </span><span className="dv">{(ue.security || {}).int_algorithm || '--'}</span></DetailItem>
                              </DetailGrid>
                            </DetailSection>

                            <DetailSection>
                              <DetailSectionTitle>AMBR</DetailSectionTitle>
                              <DetailGrid>
                                <DetailItem><span className="dl">Downlink: </span><span className="dv">{formatBitRate(ambr.downlink)}</span></DetailItem>
                                <DetailItem><span className="dl">Uplink: </span><span className="dv">{formatBitRate(ambr.uplink)}</span></DetailItem>
                              </DetailGrid>
                            </DetailSection>

                            {smfData && smfData.pdu && smfData.pdu.length > 0 ? (
                              <DetailSection>
                                <DetailSectionTitle>PDU Sessions</DetailSectionTitle>
                                <Table>
                                  <thead>
                                    <tr>
                                      <th>PSI</th>
                                      <th>DNN</th>
                                      <th>IP Address</th>
                                      <th>S-NSSAI</th>
                                      <th>QoS Flows</th>
                                      <th>State</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {smfData.pdu.map(function(pdu, pidx) {
                                      var ip = pdu.ipv4 || pdu.ipv6 || '--';
                                      var qos = (pdu.qos_flows || []).map(function(q) {
                                        return 'QFI:' + q.qfi + '/5QI:' + q['5qi'];
                                      }).join(', ') || '--';

                                      return (
                                        <tr key={pidx}>
                                          <td>{pdu.psi}</td>
                                          <td>{pdu.dnn || '--'}</td>
                                          <td><Mono>{ip}</Mono></td>
                                          <td>{formatSnssai(pdu.snssai)}</td>
                                          <td><Mono>{qos}</Mono></td>
                                          <td>{pdu.pdu_state || '--'}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </Table>

                                {smfData.pdu.map(function(pdu, pidx) {
                                  if (!pdu.n3) return null;
                                  return (
                                    <div key={'n3-' + pidx} style={{marginTop: 8}}>
                                      <DetailSectionTitle>N3 Tunnel (Session {pdu.psi})</DetailSectionTitle>
                                      <DetailGrid>
                                        <DetailItem>
                                          <span className="dl">gNB: </span>
                                          <span className="dv">{(pdu.n3.gnb || {}).addr || '--'} TEID:{(pdu.n3.gnb || {}).teid || '--'}</span>
                                        </DetailItem>
                                        <DetailItem>
                                          <span className="dl">UPF: </span>
                                          <span className="dv">{(pdu.n3.upf || {}).addr || '--'} TEID:{(pdu.n3.upf || {}).teid || '--'}</span>
                                        </DetailItem>
                                      </DetailGrid>
                                    </div>
                                  );
                                })}
                              </DetailSection>
                            ) : (
                              <DetailSection>
                                <DetailSectionTitle>PDU Sessions</DetailSectionTitle>
                                {(ue.pdu_sessions || []).length > 0 ? (
                                  <DetailGrid>
                                    {(ue.pdu_sessions || []).map(function(ps, psIdx) {
                                      return (
                                        <DetailItem key={psIdx}>
                                          <span className="dl">PSI {ps.psi}: </span>
                                          <span className="dv">{ps.dnn || '--'} ({formatSnssai(ps.snssai)})</span>
                                        </DetailItem>
                                      );
                                    })}
                                  </DetailGrid>
                                ) : (
                                  <div style={{fontSize: 12, color: 'var(--text-muted)'}}>No active PDU sessions</div>
                                )}
                              </DetailSection>
                            )}
                          </DetailPanel>
                        </td>
                      </tr>
                    );
                  }

                  return rows;
                })}
              </tbody>
            </Table>
          ) : (
            <EmptyState>
              {data ? 'No UEs connected. Waiting for UE registration...' : 'Loading...'}
            </EmptyState>
          )}
        </Card>
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
