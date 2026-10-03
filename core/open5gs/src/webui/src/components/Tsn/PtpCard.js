import { Component } from 'react';
import styled from 'styled-components';
import oc from 'open-color';

import PtpConfigForm from './PtpConfigForm';
import { tsnApi } from 'helpers/tsn-api';

var POLL_INTERVAL = 3000;

var CardWrapper = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  margin: 0 0.5rem 1.5rem 0.5rem;
  overflow: hidden;
  border-top: 3px solid ${oc.cyan[5]};
`;

var CardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: ${'var(--bg-hover)'};
  border-bottom: 1px solid ${'var(--border-color)'};
`;

var CardTitle = styled.div`
  font-size: 15px;
  font-weight: 600;
  color: ${'var(--text-primary)'};
  display: flex;
  align-items: center;
  gap: 10px;
`;

var StatusBadge = styled.span`
  display: inline-block;
  padding: 2px 10px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: white;
  background: ${function(p) { return p.active ? oc.green[6] : 'var(--text-muted)'; }};
`;

var CardBody = styled.div`
  padding: 0.75rem 1rem;
`;

var MetricGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 1rem;
  margin-bottom: 0.75rem;
`;

var Metric = styled.div`
  .metric-value {
    font-size: 16px;
    font-weight: 600;
    color: ${'var(--text-primary)'};
    font-family: monospace;
  }
  .metric-label {
    font-size: 11px;
    color: ${'var(--text-muted)'};
    margin-top: 2px;
  }
`;

var ProcessRow = styled.div`
  display: flex;
  align-items: center;
  padding: 4px 0;
  font-size: 13px;
  color: ${'var(--text-secondary)'};
  gap: 8px;
`;

var StatusDot = styled.span`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${function(p) { return p.ok ? oc.green[5] : oc.red[4]; }};
`;

var ActionBar = styled.div`
  display: flex;
  gap: 8px;
  padding: 0.75rem 1rem;
  border-top: 1px solid ${'var(--divider)'};
`;

var ActionBtn = styled.button`
  padding: 6px 16px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  color: white;
  background: ${function(p) {
    if (p.danger) return oc.red[6];
    if (p.primary) return oc.cyan[6];
    return 'var(--text-muted)';
  }};
  &:hover {
    opacity: 0.9;
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

var SectionTitle = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${'var(--text-muted)'};
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
  margin-top: 8px;
`;

var LogBox = styled.div`
  background: ${'#f4f5f7'};
  color: ${'var(--text-secondary)'};
  font-family: monospace;
  font-size: 11px;
  line-height: 1.5;
  padding: 8px 10px;
  border-radius: 3px;
  max-height: 180px;
  overflow-y: auto;
  margin-top: 6px;
  white-space: pre-wrap;
  word-break: break-all;
`;

var ToggleLink = styled.span`
  font-size: 11px;
  color: ${'var(--accent)'};
  cursor: pointer;
  &:hover { text-decoration: underline; }
`;

var ConfigSummary = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: 12px;
  color: ${'var(--text-secondary)'};
  .cfg-item {
    .cfg-label { font-weight: 600; color: ${'var(--text-muted)'}; margin-right: 4px; }
    .cfg-value { color: ${'var(--text-primary)'}; font-family: monospace; }
  }
`;

var NoConfig = styled.div`
  text-align: center;
  padding: 1.5rem;
  color: ${'var(--text-muted)'};
  font-size: 13px;
`;

class PtpCard extends Component {
  state = {
    status: null,
    error: null,
    configFormVisible: false,
    logsVisible: false,
    actionLoading: false
  }

  componentWillMount() {
    this.fetchStatus();
    this._poll = setInterval(this.fetchStatus.bind(this), POLL_INTERVAL);
  }

  componentWillUnmount() {
    if (this._poll) clearInterval(this._poll);
  }

  fetchStatus() {
    tsnApi('get', '/api/ptp/status')
      .then(function(response) {
        this.setState({ status: response.data, error: null });
      }.bind(this))
      .catch(function(err) {
        this.setState({ error: 'PTP service unreachable' });
      }.bind(this));
  }

  handleStart = () => {
    this.setState({ actionLoading: true });
    tsnApi('post', '/api/ptp/start')
      .then(() => {
        this.setState({ actionLoading: false });
        this.fetchStatus();
      })
      .catch((err) => {
        var msg = (err.response && err.response.data && err.response.data.message) || 'Start failed';
        this.setState({ actionLoading: false, error: msg });
        this.fetchStatus();
      });
  }

  handleStop = () => {
    if (!confirm('Stop ptp4l and phc2sys processes?')) return;
    this.setState({ actionLoading: true });
    tsnApi('post', '/api/ptp/stop')
      .then(() => {
        this.setState({ actionLoading: false });
        this.fetchStatus();
      })
      .catch(() => {
        this.setState({ actionLoading: false });
        this.fetchStatus();
      });
  }

  handleConfigSuccess = (formData) => {
    this.fetchStatus();
  }

  render() {
    var status = this.state.status || {};
    var config = status.config;
    var running = status.running;
    var logs = status.lastLogs || [];

    return (
      <CardWrapper>
        <CardHeader>
          <CardTitle>
            Clock Sync (PTP)
            <StatusBadge active={running}>
              {running ? 'Running' : 'Stopped'}
            </StatusBadge>
          </CardTitle>
        </CardHeader>

        <CardBody>
          {this.state.error &&
            <div style={{
              background: oc.red[1], border: '1px solid ' + oc.red[4],
              borderRadius: '3px', padding: '6px 10px', marginBottom: '8px',
              fontSize: '12px', color: oc.red[8]
            }}>
              {this.state.error}
            </div>
          }

          {!config &&
            <NoConfig>
              No PTP configuration set. Click <strong>Configure</strong> to set up clock synchronization.
            </NoConfig>
          }

          {config &&
            <div>
              <SectionTitle>Configuration</SectionTitle>
              <ConfigSummary>
                <div className="cfg-item">
                  <span className="cfg-label">Profile:</span>
                  <span className="cfg-value">
                    {config.profile === '802.1AS' ? '802.1AS (gPTP)' : 'IEEE 1588v2'}
                  </span>
                </div>
                <div className="cfg-item">
                  <span className="cfg-label">Interface:</span>
                  <span className="cfg-value">{config.interface}</span>
                </div>
                <div className="cfg-item">
                  <span className="cfg-label">Domain:</span>
                  <span className="cfg-value">{config.domainNumber}</span>
                </div>
                <div className="cfg-item">
                  <span className="cfg-label">Timestamping:</span>
                  <span className="cfg-value">{config.timeStamping}</span>
                </div>
                <div className="cfg-item">
                  <span className="cfg-label">Priority1:</span>
                  <span className="cfg-value">{config.priority1}</span>
                </div>
              </ConfigSummary>
            </div>
          }

          {running &&
            <div>
              <SectionTitle>Process Status</SectionTitle>
              {status.ptp4l &&
                <ProcessRow>
                  <StatusDot ok={status.ptp4l.alive} />
                  <span style={{fontWeight: 600, minWidth: 60}}>ptp4l</span>
                  <span style={{fontFamily: 'monospace', fontSize: 11}}>
                    PID {status.ptp4l.pid}
                  </span>
                  <span style={{color: status.ptp4l.alive ? oc.green[6] : oc.red[5], fontSize: 11}}>
                    {status.ptp4l.alive ? 'alive' : 'exited'}
                  </span>
                </ProcessRow>
              }
              {status.phc2sys &&
                <ProcessRow>
                  <StatusDot ok={status.phc2sys.alive} />
                  <span style={{fontWeight: 600, minWidth: 60}}>phc2sys</span>
                  <span style={{fontFamily: 'monospace', fontSize: 11}}>
                    PID {status.phc2sys.pid}
                  </span>
                  <span style={{color: status.phc2sys.alive ? oc.green[6] : oc.red[5], fontSize: 11}}>
                    {status.phc2sys.alive ? 'alive' : 'exited'}
                  </span>
                </ProcessRow>
              }

              {status.clockInfo &&
                <div>
                  <SectionTitle>Clock Metrics</SectionTitle>
                  <MetricGrid>
                    <Metric>
                      <div className="metric-value">
                        {status.clockInfo.offsetFromMasterNs || '--'}
                      </div>
                      <div className="metric-label">Offset from Master (ns)</div>
                    </Metric>
                    <Metric>
                      <div className="metric-value">
                        {status.clockInfo.meanPathDelayNs || '--'}
                      </div>
                      <div className="metric-label">Mean Path Delay (ns)</div>
                    </Metric>
                  </MetricGrid>
                </div>
              }

              {logs.length > 0 &&
                <div>
                  <SectionTitle style={{display: 'flex', alignItems: 'center', gap: 8}}>
                    Logs
                    <ToggleLink onClick={() => this.setState({
                      logsVisible: !this.state.logsVisible
                    })}>
                      {this.state.logsVisible ? 'Hide' : 'Show'}
                    </ToggleLink>
                  </SectionTitle>
                  {this.state.logsVisible &&
                    <LogBox>
                      {logs.join('\n')}
                    </LogBox>
                  }
                </div>
              }
            </div>
          }
        </CardBody>

        <ActionBar>
          <ActionBtn
            onClick={() => this.setState({ configFormVisible: true })}
            disabled={running || this.state.actionLoading}>
            Configure
          </ActionBtn>
          {config && !running &&
            <ActionBtn primary
              onClick={this.handleStart}
              disabled={this.state.actionLoading}>
              {this.state.actionLoading ? 'Starting...' : 'Start'}
            </ActionBtn>
          }
          {running &&
            <ActionBtn danger
              onClick={this.handleStop}
              disabled={this.state.actionLoading}>
              {this.state.actionLoading ? 'Stopping...' : 'Stop'}
            </ActionBtn>
          }
        </ActionBar>

        <PtpConfigForm
          visible={this.state.configFormVisible}
          formData={config}
          onHide={() => this.setState({ configFormVisible: false })}
          onSuccess={this.handleConfigSuccess}
        />
      </CardWrapper>
    );
  }
}

export default PtpCard;
