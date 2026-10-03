import { Component } from 'react';
import PropTypes from 'prop-types';

import styled from 'styled-components';
import oc from 'open-color';
import { media } from 'helpers/style-utils';
import { tsnApi } from 'helpers/tsn-api';

import EditIcon from 'react-icons/lib/md/edit';
import DeleteIcon from 'react-icons/lib/md/delete';
import CloseIcon from 'react-icons/lib/md/close';
import AddIcon from 'react-icons/lib/md/add';
import DeviceHubIcon from 'react-icons/lib/md/device-hub';
import KeyboardControlIcon from 'react-icons/lib/md/keyboard-control';
import SettingsIcon from 'react-icons/lib/md/settings';

import { Modal, Tooltip, Dimmed, Confirm } from 'components';
import PortForm from './PortForm';
import QosForm from './QosForm';
import TscForm from './TscForm';
import GclForm from './GclForm';
import PsfpForm from './PsfpForm';
import StreamForm from './StreamForm';

const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  postion: relative;
  width: 700px;

  ${media.mobile`
    width: calc(100vw - 4rem);
  `}

  background: var(--bg-card);
  box-shadow: 0 10px 20px rgba(0,0,0,0.19), 0 6px 6px rgba(0,0,0,0.23);
`

const Header = styled.div`
  position: relative;
  display: flex;

  background: ${'var(--divider)'};

  .title {
    padding: 1.5rem;
    color: ${'var(--text-primary)'};
    font-size: 1.5rem;
  }

  .actions {
    position: absolute;
    top: 0;
    right: 0;
    width: 8rem;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
`;

const CircleButton = styled.div`
  height: 2rem;
  width: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 1px;

  color: ${'var(--text-secondary)'};

  border-radius: 1rem;
  font-size: 1.5rem;

  &:hover {
    color: ${'var(--accent)'};
  }

  &.delete {
    &:hover {
      color: ${oc.pink[6]};
    }
  }
`

const Body = styled.div`
  display: block;
  margin: 0.5rem;

  height: 500px;
  ${media.mobile`
    height: calc(100vh - 16rem);
  `}

  overflow: scroll;
`

const BridgeDetail = styled.div`
  display: flex;
  flex-direction: column;
  margin: 0 auto;
  color: ${'var(--text-primary)'};

  .header {
    margin: 12px;
    font-size: 16px;
  }
  .body {
    display: flex;
    flex-direction: row;
    flex: 1;
    margin: 6px;

    .left {
      width: 80px;
      text-align: center;
      font-size: 18px;
      color: ${'var(--text-secondary)'};
    }

    .right {
      display: flex;
      flex-direction: column;
      flex: 1;

      .data {
        flex: 1;
        font-size: 12px;
        margin: 4px;
      }
    }
  }
`

const PortsTable = styled.div`
  display: flex;
  flex-direction: column;
  margin: 0 auto;
  color: ${'var(--text-primary)'};

  .header {
    margin: 12px;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .row {
    display: flex;
    flex-direction: row;
    flex: 1;
    margin: 0px 16px;
    align-items: center;

    .cell {
      font-size: 12px;
      margin: 4px;
      min-width: 60px;
    }
    .cell-wide {
      font-size: 12px;
      margin: 4px;
      min-width: 120px;
    }
    .cell-actions {
      font-size: 12px;
      margin: 4px;
      min-width: 40px;
      display: flex;
      gap: 2px;
    }
  }
`

const Section = styled.div`
  display: flex;
  flex-direction: column;
  margin: 0 auto;
  color: ${'var(--text-primary)'};
  width: 100%;

  .section-header {
    margin: 12px;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .section-body {
    margin: 0px 16px 8px 16px;
    font-size: 12px;
    color: ${'var(--text-secondary)'};
  }
`

const SmallButton = styled.button`
  border: 1px solid ${'var(--text-muted)'};
  background: var(--bg-card);
  color: ${'var(--text-secondary)'};
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;

  &:hover {
    background: ${'var(--divider)'};
    color: ${'var(--accent)'};
    border-color: ${'var(--accent-2)'};
  }
`

const AddButton = styled.button`
  border: 1px solid ${'var(--accent-2)'};
  background: var(--bg-card);
  color: ${'var(--accent)'};
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 3px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;

  &:hover {
    background: ${'var(--bg-panel-header)'};
  }
`

const DeletePortButton = styled.button`
  border: none;
  background: transparent;
  color: ${'var(--text-muted)'};
  cursor: pointer;
  font-size: 14px;
  padding: 2px;
  display: flex;
  align-items: center;

  &:hover {
    color: ${oc.pink[6]};
  }
`

const ConfigureButton = styled.button`
  border: 1px solid ${'var(--text-muted)'};
  background: var(--bg-card);
  color: ${'var(--text-secondary)'};
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 3px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;

  &:hover {
    background: ${'var(--divider)'};
    color: ${'var(--accent)'};
    border-color: ${'var(--accent-2)'};
  }
`

class View extends Component {
  state = {
    portForm: false,
    qosForm: false,
    tscForm: false,
    gclForm: null,   // port number or null
    psfpForm: null,   // port number or null
    streamForm: false,
    confirmDeletePort: null,  // port number or null
    analytics: null,
    nwttPorts: []   // live NW-TT (data-plane) ports from the UPF
  }

  componentWillReceiveProps(nextProps) {
    if (nextProps.visible && !this.props.visible) {
      this.fetchAnalytics();
      this.fetchNwttPorts();
    }
  }

  fetchAnalytics = () => {
    tsnApi('get', '/api/tsn/Analytics')
      .then((response) => {
        this.setState({ analytics: response.data });
      })
      .catch(() => {});
  }

  /* Data-plane ports created by the UPF per Ethernet PDU session — these
   * are not the same as the CNC-configured ports above (control plane). */
  fetchNwttPorts = () => {
    tsnApi('get', '/api/upf/TsnInfo')
      .then((response) => {
        var d = response.data || {};
        this.setState({ nwttPorts: d.ports || [] });
      })
      .catch(() => {});
  }

  getAnalyticsForBridge = () => {
    var analytics = this.state.analytics;
    var bridge = this.props.bridge;
    if (!analytics || !bridge) return null;

    var bridges = analytics.bridges || [];
    for (var i = 0; i < bridges.length; i++) {
      if (bridges[i].bridgeId === bridge.bridgeId) {
        return bridges[i];
      }
    }
    return null;
  }

  handleRefresh = () => {
    if (this.props.onRefresh) this.props.onRefresh();
    this.fetchAnalytics();
    this.fetchNwttPorts();
  }

  handleDeletePort = (portNumber) => {
    var bridge = this.props.bridge;
    if (!bridge) return;

    tsnApi('delete', '/api/tsn/Bridge/' + bridge.bridgeId + '/Port/' + portNumber)
      .then(() => {
        this.setState({ confirmDeletePort: null });
        this.handleRefresh();
      })
      .catch(() => {
        this.setState({ confirmDeletePort: null });
      });
  }

  render() {
    var props = this.props;
    var visible = props.visible;
    var disableOnClickOutside = props.disableOnClickOutside;
    var bridge = props.bridge;
    var onEdit = props.onEdit;
    var onDelete = props.onDelete;
    var onHide = props.onHide;

    var bridgeId = (bridge || {}).bridgeId;
    var bridgeMac = (bridge || {}).bridgeMac;
    var dnn = (bridge || {}).dnn;
    var ports = ((bridge || {}).ports || []);

    var analyticsData = this.getAnalyticsForBridge();
    var qosMappings = (analyticsData || {}).qosMappings || [];
    var tscAssistance = (analyticsData || {}).tscAssistance || null;

    var anySubModal = this.state.portForm || this.state.qosForm ||
      this.state.tscForm || this.state.gclForm !== null ||
      this.state.psfpForm !== null || this.state.streamForm ||
      this.state.confirmDeletePort !== null;

    return (
      <div>
        <Modal
          visible={visible}
          onOutside={onHide}
          disableOnClickOutside={disableOnClickOutside || anySubModal}>
          <Wrapper>
            <Header>
              <div className="title">{bridgeId}</div>
              <div className="actions">
                <Tooltip content='Edit' width="60px">
                  <CircleButton onClick={() => onEdit(bridgeId)}><EditIcon/></CircleButton>
                </Tooltip>
                <Tooltip content='Delete' width="60px">
                  <CircleButton className="delete" onClick={() => onDelete(bridgeId)}><DeleteIcon/></CircleButton>
                </Tooltip>
                <Tooltip content='Close' width="60px">
                  <CircleButton className="delete" onClick={onHide}><CloseIcon/></CircleButton>
                </Tooltip>
              </div>
            </Header>
            <Body>
              <BridgeDetail>
                <div className="header">
                  Bridge Configuration
                </div>
                <div className="body">
                  <div className="left">
                    <DeviceHubIcon/>
                  </div>
                  <div className="right">
                    <div className="data">
                      {bridgeId}
                      <span style={{color:'var(--text-muted)'}}><KeyboardControlIcon/>Bridge ID</span>
                    </div>
                    <div className="data">
                      {bridgeMac || '00:00:00:00:00:00'}
                      <span style={{color:'var(--text-muted)'}}><KeyboardControlIcon/>Bridge MAC</span>
                    </div>
                    {dnn &&
                      <div className="data">
                        {dnn}
                        <span style={{color:'var(--text-muted)'}}><KeyboardControlIcon/>DNN</span>
                      </div>
                    }
                  </div>
                </div>
              </BridgeDetail>

              <PortsTable>
                <div className="header">
                  <span>Ports ({ports.length})</span>
                  <AddButton onClick={() => this.setState({portForm: true})}>
                    <AddIcon style={{fontSize: '14px'}}/> Add Port
                  </AddButton>
                </div>
                {ports.length > 0 &&
                  <div className="row" style={{color:'var(--text-muted)'}}>
                    <div className="cell">Port #</div>
                    <div className="cell">Type</div>
                    <div className="cell-wide">MAC Address</div>
                    <div className="cell-wide">LLDP Chassis ID</div>
                    <div className="cell-actions"></div>
                  </div>
                }
                {ports.map((port, index) =>
                  <div key={index} className="row">
                    <div className="cell">{port.portNumber}</div>
                    <div className="cell">{port.isNwtt ? 'NW-TT' : 'DS-TT'}</div>
                    <div className="cell-wide">{port.macAddr}</div>
                    <div className="cell-wide">{port.lldpChassisId || '-'}</div>
                    <div className="cell-actions">
                      <Tooltip content='Delete' width="60px">
                        <DeletePortButton
                          onClick={() => this.setState({confirmDeletePort: port.portNumber})}>
                          <CloseIcon/>
                        </DeletePortButton>
                      </Tooltip>
                    </div>
                  </div>
                )}
                {ports.length === 0 &&
                  <div className="row" style={{color:'var(--text-muted)'}}>
                    <div className="cell-wide">No ports configured</div>
                  </div>
                }
              </PortsTable>

              <PortsTable>
                <div className="header">
                  <span>Active NW-TT Ports ({this.state.nwttPorts.length})
                    <span style={{fontWeight:400,fontSize:'11px',color:'var(--text-muted)',marginLeft:'8px'}}>
                      data plane &middot; auto-created per Ethernet PDU session
                    </span>
                  </span>
                </div>
                {this.state.nwttPorts.length > 0 &&
                  <div className="row" style={{color:'var(--text-muted)'}}>
                    <div className="cell">Port #</div>
                    <div className="cell-wide">Device (DS-TT)</div>
                    <div className="cell-wide">Port MAC</div>
                    <div className="cell">RX / TX</div>
                  </div>
                }
                {this.state.nwttPorts.map((p, index) =>
                  <div key={index} className="row">
                    <div className="cell">{p.port_number}</div>
                    <div className="cell-wide">{(p.lldp_neighbor || {}).system_name || p.ue_mac || 'unknown'}</div>
                    <div className="cell-wide">{p.mac}</div>
                    <div className="cell">{((p.traffic||{}).rx_frames)||0} / {((p.traffic||{}).tx_frames)||0}</div>
                  </div>
                )}
                {this.state.nwttPorts.length === 0 &&
                  <div className="row" style={{color:'var(--text-muted)'}}>
                    <div className="cell-wide">No active PDU-session ports</div>
                  </div>
                }
              </PortsTable>

              <Section>
                <div className="section-header">
                  <span>QoS Mapping</span>
                  <ConfigureButton onClick={() => this.setState({qosForm: true})}>
                    <SettingsIcon style={{fontSize: '14px'}}/> Configure
                  </ConfigureButton>
                </div>
                <div className="section-body">
                  {qosMappings.length > 0 ? qosMappings.map((m, i) =>
                    <div key={i}>PCP {m.pcp} &rarr; 5QI {m.fiveQi || m['5qi']}</div>
                  ) : <span style={{color:'var(--text-muted)'}}>(not configured)</span>}
                </div>
              </Section>

              <Section>
                <div className="section-header">
                  <span>TSC Assistance</span>
                  <ConfigureButton onClick={() => this.setState({tscForm: true})}>
                    <SettingsIcon style={{fontSize: '14px'}}/> Configure
                  </ConfigureButton>
                </div>
                <div className="section-body">
                  {tscAssistance ? (
                    <div>
                      {tscAssistance.burstArrivalTimeNs != null &&
                        <div>Burst Arrival: {tscAssistance.burstArrivalTimeNs} ns</div>}
                      {tscAssistance.periodicityUs != null &&
                        <div>Periodicity: {tscAssistance.periodicityUs} us</div>}
                      {tscAssistance.survivalTimeUs != null &&
                        <div>Survival Time: {tscAssistance.survivalTimeUs} us</div>}
                    </div>
                  ) : <span style={{color:'var(--text-muted)'}}>(not configured)</span>}
                </div>
              </Section>

              {ports.length > 0 &&
                <Section>
                  <div className="section-header">
                    <span>Advanced Per-Port</span>
                  </div>
                  <div className="section-body">
                    {ports.map((port, index) =>
                      <div key={index} style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        marginBottom: '4px'
                      }}>
                        <span>Port {port.portNumber}:</span>
                        <SmallButton onClick={() => this.setState({gclForm: port.portNumber})}>
                          GCL
                        </SmallButton>
                        <SmallButton onClick={() => this.setState({psfpForm: port.portNumber})}>
                          PSFP
                        </SmallButton>
                      </div>
                    )}
                  </div>
                </Section>
              }

              <Section>
                <div className="section-header">
                  <span>Stream Reservations</span>
                  <ConfigureButton onClick={() => this.setState({streamForm: true})}>
                    <SettingsIcon style={{fontSize: '14px'}}/> Configure
                  </ConfigureButton>
                </div>
                <div className="section-body">
                  <span style={{color:'var(--text-muted)'}}>(configure via button above)</span>
                </div>
              </Section>
            </Body>
          </Wrapper>
        </Modal>
        <Dimmed visible={visible}/>

        <PortForm
          visible={this.state.portForm}
          bridgeId={bridgeId}
          existingPorts={ports}
          onHide={() => this.setState({portForm: false})}
          onSuccess={this.handleRefresh}/>

        <QosForm
          visible={this.state.qosForm}
          bridgeId={bridgeId}
          formData={qosMappings.length > 0 ? {mappings: qosMappings} : {mappings: []}}
          onHide={() => this.setState({qosForm: false})}
          onSuccess={this.handleRefresh}/>

        <TscForm
          visible={this.state.tscForm}
          bridgeId={bridgeId}
          formData={tscAssistance || {}}
          onHide={() => this.setState({tscForm: false})}
          onSuccess={this.handleRefresh}/>

        {this.state.gclForm !== null &&
          <GclForm
            visible={true}
            bridgeId={bridgeId}
            portNumber={this.state.gclForm}
            onHide={() => this.setState({gclForm: null})}
            onSuccess={this.handleRefresh}/>
        }

        {this.state.psfpForm !== null &&
          <PsfpForm
            visible={true}
            bridgeId={bridgeId}
            portNumber={this.state.psfpForm}
            onHide={() => this.setState({psfpForm: null})}
            onSuccess={this.handleRefresh}/>
        }

        <StreamForm
          visible={this.state.streamForm}
          bridgeId={bridgeId}
          onHide={() => this.setState({streamForm: false})}
          onSuccess={this.handleRefresh}/>

        <Confirm
          visible={this.state.confirmDeletePort !== null}
          message={'Delete port ' + this.state.confirmDeletePort + '?'}
          onOutside={() => this.setState({confirmDeletePort: null})}
          buttons={[
            { text: "CANCEL", action: () => this.setState({confirmDeletePort: null}), info:true },
            { text: "DELETE", action: () => this.handleDeletePort(this.state.confirmDeletePort), danger:true }
          ]}/>
      </div>
    );
  }
}

export default View;
