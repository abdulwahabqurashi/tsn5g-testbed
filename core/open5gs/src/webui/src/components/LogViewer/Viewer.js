import { Component } from 'react';
import PropTypes from 'prop-types';
import styled from 'styled-components';
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

const PageTitle = styled.h2`
  margin: 0 0 1rem 0;
  font-size: 20px;
  font-weight: 600;
  color: ${'var(--text-primary)'};
`;

const ServiceTabs = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 1rem;
`;

const ServiceTab = styled.div`
  padding: 5px 14px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  background: ${p => p.active ? 'var(--accent)' : 'white'};
  color: ${p => p.active ? 'white' : 'var(--text-secondary)'};
  box-shadow: 0 1px 2px rgba(0,0,0,0.1);
  &:hover {
    background: ${p => p.active ? '#4f46e5' : 'var(--divider)'};
  }
`;

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
`;

const ControlLabel = styled.span`
  font-size: 12px;
  color: ${'var(--text-muted)'};
`;

const FilterInput = styled.input`
  padding: 5px 10px;
  border: 1px solid ${'var(--border-color)'};
  border-radius: 4px;
  font-size: 12px;
  width: 200px;
  outline: none;
  &:focus { border-color: ${'var(--accent)'}; }
`;

const ToggleBtn = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  background: ${p => p.active ? oc.green[1] : 'var(--divider)'};
  color: ${p => p.active ? oc.green[7] : 'var(--text-secondary)'};
  border: 1px solid ${p => p.active ? oc.green[3] : 'var(--border-color)'};
  .toggle-dot { width: 6px; height: 6px; border-radius: 50%;
    background: ${p => p.active ? oc.green[5] : 'var(--text-muted)'}; }
`;

const LogContainer = styled.div`
  background: ${'#f4f6fb'};
  border-radius: 4px;
  padding: 12px;
  min-height: 400px;
  max-height: 600px;
  overflow-y: auto;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.3);
`;

const LogLine = styled.div`
  color: ${p => p.level === 'error' ? oc.red[4] :
    p.level === 'warn' ? oc.yellow[4] :
    p.level === 'info' ? oc.green[3] :
    p.level === 'debug' ? 'var(--text-muted)' : 'var(--border-color)'};
  white-space: pre-wrap;
  word-break: break-all;
  &:hover { background: rgba(255,255,255,0.05); }
`;

const EmptyLog = styled.div`
  color: ${'var(--text-muted)'};
  text-align: center;
  padding: 3rem;
  font-size: 13px;
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

var DEFAULT_SERVICES = ['amf', 'smf', 'upf', 'nrf', 'scp', 'pcf', 'udm', 'udr', 'ausf', 'nssf', 'bsf', 'tsn-af', 'webui'];

function detectLevel(line) {
  var lower = line.toLowerCase();
  if (lower.indexOf('error') !== -1 || lower.indexOf('fatal') !== -1) return 'error';
  if (lower.indexOf('warn') !== -1) return 'warn';
  if (lower.indexOf('info') !== -1) return 'info';
  if (lower.indexOf('debug') !== -1 || lower.indexOf('trace') !== -1) return 'debug';
  return 'default';
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  var seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  return Math.floor(seconds / 60) + 'm ago';
}

class Viewer extends Component {
  state = {
    filter: '',
    autoScroll: true,
    autoRefresh: true
  };

  componentDidMount() {
    this.scrollToBottom();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.logs !== this.props.logs && this.state.autoScroll) {
      this.scrollToBottom();
    }
  }

  scrollToBottom() {
    if (this._logContainer) {
      this._logContainer.scrollTop = this._logContainer.scrollHeight;
    }
  }

  render() {
    const { logs, services, selectedService, isLoading, error, lastUpdated,
            onSelectService, onToggleRefresh } = this.props;
    const { filter, autoScroll, autoRefresh } = this.state;
    var self = this;

    // Build service list from available services or defaults
    var serviceList = (services && services.length > 0)
      ? services.map(function(s) { return s.name; })
      : DEFAULT_SERVICES;

    // Filter log lines
    var displayLogs = logs || [];
    if (filter) {
      var lowerFilter = filter.toLowerCase();
      displayLogs = displayLogs.filter(function(line) {
        return line.toLowerCase().indexOf(lowerFilter) !== -1;
      });
    }

    return (
      <Wrapper>
        <RefreshIndicator>
          {isLoading ? 'Refreshing...' : (lastUpdated ? 'Updated ' + formatTimeAgo(lastUpdated) : '')}
          {' | Auto-refresh: 3s'}
        </RefreshIndicator>

        <PageTitle>Log Viewer</PageTitle>

        {error && <ErrorBanner>{typeof error === 'string' ? error : 'Failed to load logs'}</ErrorBanner>}

        <ServiceTabs>
          {serviceList.map(function(svc) {
            return (
              <ServiceTab
                key={svc}
                active={svc === selectedService}
                onClick={function() { onSelectService(svc); }}>
                {svc.toUpperCase()}
              </ServiceTab>
            );
          })}
        </ServiceTabs>

        <Controls>
          <ToggleBtn
            active={autoRefresh}
            onClick={function() {
              self.setState({ autoRefresh: !autoRefresh });
              if (onToggleRefresh) onToggleRefresh(!autoRefresh);
            }}>
            <div className="toggle-dot" />
            Auto-refresh: {autoRefresh ? 'ON' : 'OFF'}
          </ToggleBtn>
          <ToggleBtn
            active={autoScroll}
            onClick={function() { self.setState({ autoScroll: !autoScroll }); }}>
            <div className="toggle-dot" />
            Auto-scroll: {autoScroll ? 'ON' : 'OFF'}
          </ToggleBtn>
          <ControlLabel>Filter:</ControlLabel>
          <FilterInput
            type="text"
            placeholder="Search logs..."
            value={filter}
            onChange={function(e) { self.setState({ filter: e.target.value }); }}
          />
          {filter && (
            <ControlLabel
              style={{cursor:'pointer',color:'var(--accent)'}}
              onClick={function() { self.setState({ filter: '' }); }}>
              Clear
            </ControlLabel>
          )}
          <ControlLabel style={{marginLeft:'auto'}}>
            {displayLogs.length} line{displayLogs.length !== 1 ? 's' : ''}
          </ControlLabel>
        </Controls>

        <LogContainer ref={function(el) { self._logContainer = el; }}>
          {displayLogs.length > 0 ? displayLogs.map(function(line, idx) {
            return (
              <LogLine key={idx} level={detectLevel(line)}>
                {line}
              </LogLine>
            );
          }) : (
            <EmptyLog>
              {isLoading ? 'Loading logs...' :
                'No log data available for ' + (selectedService || 'this service') + '. Make sure the service is running.'}
            </EmptyLog>
          )}
        </LogContainer>
      </Wrapper>
    );
  }
}

Viewer.propTypes = {
  logs: PropTypes.array,
  services: PropTypes.array,
  selectedService: PropTypes.string,
  isLoading: PropTypes.bool,
  error: PropTypes.string,
  lastUpdated: PropTypes.number,
  onSelectService: PropTypes.func,
  onToggleRefresh: PropTypes.func
};

export default Viewer;
