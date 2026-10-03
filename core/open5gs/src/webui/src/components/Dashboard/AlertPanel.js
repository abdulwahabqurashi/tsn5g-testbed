import { Component } from 'react';
import PropTypes from 'prop-types';
import styled from 'styled-components';
import oc from 'open-color';
import { AVAILABLE_METRICS } from 'helpers/metric-extractors';

const Panel = styled.div`
  background: var(--bg-card, white);
  box-shadow: var(--card-shadow);
  border-radius: var(--radius);
  overflow: hidden;
  margin-bottom: 1.5rem;
`;

const PanelHeader = styled.div`
  background: ${'var(--bg-hover)'};
  padding: 0.6rem 1rem;
  border-bottom: 1px solid ${'var(--border-color)'};
  font-size: 13px;
  font-weight: 600;
  color: ${'var(--text-secondary)'};
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  &:hover { background: ${'var(--divider)'}; }
`;

const PanelBody = styled.div`
  padding: 0.75rem 1rem;
`;

const RuleRow = styled.div`
  display: flex;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid ${'var(--divider)'};
  &:last-child { border-bottom: none; }
  font-size: 12px;
`;

const RuleName = styled.span`
  font-weight: 600;
  color: var(--text-primary, ${'var(--text-secondary)'});
  min-width: 160px;
`;

const RuleDetail = styled.span`
  color: var(--text-muted, ${'var(--text-muted)'});
  font-family: monospace;
  font-size: 11px;
  min-width: 200px;
`;

const SeverityBadge = styled.span`
  display: inline-block;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  color: white;
  background: ${p => p.severity === 'error' ? oc.red[5] : oc.yellow[6]};
  min-width: 50px;
  text-align: center;
`;

const ToggleSwitch = styled.div`
  width: 36px;
  height: 18px;
  border-radius: 9px;
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  background: ${p => p.on ? 'var(--ok)' : '#d1d5db'};
  margin-left: auto;
  margin-right: 8px;
  &:after {
    content: '';
    position: absolute;
    top: 2px;
    left: ${p => p.on ? '18px' : '2px'};
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--bg-card);
    transition: left 0.2s;
  }
`;

const RemoveBtn = styled.span`
  color: ${oc.red[4]};
  cursor: pointer;
  font-size: 14px;
  &:hover { color: ${oc.red[6]}; }
`;

const HistoryItem = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid ${'var(--divider)'};
  &:last-child { border-bottom: none; }
  font-size: 11px;
`;

const HistoryTime = styled.span`
  color: var(--text-muted, ${'var(--text-muted)'});
  min-width: 70px;
  font-family: monospace;
`;

const HistoryMsg = styled.span`
  color: var(--text-secondary, ${'var(--text-secondary)'});
`;

const AddRuleForm = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid ${'var(--border-color)'};
  margin-top: 8px;
  align-items: center;
`;

const SmallInput = styled.input`
  padding: 4px 8px;
  border: 1px solid var(--border-color, ${'var(--border-color)'});
  border-radius: 3px;
  font-size: 12px;
  width: 120px;
  background: var(--bg-input, white);
  color: var(--text-primary, inherit);
  outline: none;
  &:focus { border-color: ${'var(--accent)'}; }
`;

const SmallSelect = styled.select`
  padding: 4px 8px;
  border: 1px solid var(--border-color, ${'var(--border-color)'});
  border-radius: 3px;
  font-size: 12px;
  background: var(--bg-input, white);
  color: var(--text-primary, inherit);
  outline: none;
`;

const SmallBtn = styled.div`
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  background: ${p => p.danger ? oc.red[1] : 'var(--accent-soft)'};
  color: ${p => p.danger ? oc.red[7] : '#4f46e5'};
  &:hover { background: ${p => p.danger ? oc.red[2] : 'var(--accent-2)'}; }
`;

const EmptyMsg = styled.div`
  text-align: center;
  padding: 0.5rem;
  color: var(--text-muted, ${'var(--text-muted)'});
  font-size: 12px;
`;

function formatTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  var h = d.getHours().toString();
  var m = d.getMinutes().toString().padStart(2, '0');
  var s = d.getSeconds().toString().padStart(2, '0');
  return h + ':' + m + ':' + s;
}

class AlertPanel extends Component {
  state = {
    isOpen: true,
    showAddForm: false,
    newRule: {
      name: '',
      metric: 'nwtt.jitter_current_us',
      operator: '>',
      threshold: '',
      severity: 'warning'
    }
  };

  handleAddRule = () => {
    var nr = this.state.newRule;
    if (!nr.name || !nr.threshold) return;
    var rule = {
      id: 'custom-' + Date.now(),
      name: nr.name,
      metric: nr.metric,
      operator: nr.operator,
      threshold: parseFloat(nr.threshold),
      severity: nr.severity,
      enabled: true
    };
    if (this.props.onAddRule) this.props.onAddRule(rule);
    this.setState({
      showAddForm: false,
      newRule: { name: '', metric: 'nwtt.jitter_current_us', operator: '>', threshold: '', severity: 'warning' }
    });
  }

  render() {
    var { rules, history, onToggleRule, onRemoveRule, onClearHistory } = this.props;
    var { isOpen, showAddForm, newRule } = this.state;
    var self = this;
    rules = rules || [];
    history = history || [];

    return (
      <Panel>
        <PanelHeader onClick={function() { self.setState({ isOpen: !isOpen }); }}>
          <span>Alerts {history.length > 0 ? '(' + history.length + ' recent)' : ''}</span>
          <span style={{fontSize:'11px'}}>{isOpen ? '\u25B2' : '\u25BC'}</span>
        </PanelHeader>

        {isOpen && (
          <PanelBody>
            <div style={{fontSize:'11px',fontWeight:600,color:'var(--text-muted)',textTransform:'uppercase',marginBottom:'6px'}}>
              Rules
            </div>
            {rules.length > 0 ? rules.map(function(rule) {
              return (
                <RuleRow key={rule.id}>
                  <RuleName>{rule.name}</RuleName>
                  <RuleDetail>{rule.metric} {rule.operator} {rule.threshold}</RuleDetail>
                  <SeverityBadge severity={rule.severity}>{rule.severity}</SeverityBadge>
                  <ToggleSwitch
                    on={rule.enabled}
                    onClick={function() { if (onToggleRule) onToggleRule(rule.id); }}
                  />
                  <RemoveBtn onClick={function() { if (onRemoveRule) onRemoveRule(rule.id); }}>
                    &times;
                  </RemoveBtn>
                </RuleRow>
              );
            }) : (
              <EmptyMsg>No alert rules configured</EmptyMsg>
            )}

            {showAddForm ? (
              <AddRuleForm>
                <SmallInput
                  placeholder="Rule name"
                  value={newRule.name}
                  onChange={function(e) { self.setState({ newRule: { ...newRule, name: e.target.value } }); }}
                />
                <SmallSelect
                  value={newRule.metric}
                  onChange={function(e) { self.setState({ newRule: { ...newRule, metric: e.target.value } }); }}>
                  {AVAILABLE_METRICS.map(function(m) {
                    return <option key={m.path} value={m.path}>{m.label}</option>;
                  })}
                </SmallSelect>
                <SmallSelect
                  value={newRule.operator}
                  onChange={function(e) { self.setState({ newRule: { ...newRule, operator: e.target.value } }); }}>
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                  <option value=">=">&gt;=</option>
                  <option value="<=">&lt;=</option>
                </SmallSelect>
                <SmallInput
                  type="number"
                  placeholder="Threshold"
                  style={{width:'80px'}}
                  value={newRule.threshold}
                  onChange={function(e) { self.setState({ newRule: { ...newRule, threshold: e.target.value } }); }}
                />
                <SmallSelect
                  value={newRule.severity}
                  onChange={function(e) { self.setState({ newRule: { ...newRule, severity: e.target.value } }); }}>
                  <option value="warning">Warning</option>
                  <option value="error">Error</option>
                </SmallSelect>
                <SmallBtn onClick={self.handleAddRule}>Add</SmallBtn>
                <SmallBtn danger onClick={function() { self.setState({ showAddForm: false }); }}>Cancel</SmallBtn>
              </AddRuleForm>
            ) : (
              <div style={{marginTop:'8px'}}>
                <SmallBtn onClick={function() { self.setState({ showAddForm: true }); }}>+ Add Rule</SmallBtn>
              </div>
            )}

            {history.length > 0 && (
              <div style={{marginTop:'12px'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'6px'}}>
                  <span style={{fontSize:'11px',fontWeight:600,color:'var(--text-muted)',textTransform:'uppercase'}}>Recent Alerts</span>
                  <SmallBtn danger onClick={onClearHistory}>Clear</SmallBtn>
                </div>
                {history.slice(0, 10).map(function(h) {
                  return (
                    <HistoryItem key={h.id}>
                      <HistoryTime>{formatTime(h.timestamp)}</HistoryTime>
                      <SeverityBadge severity={h.severity}>{h.severity}</SeverityBadge>
                      <HistoryMsg>
                        {h.ruleName}: {h.metric} = {typeof h.value === 'number' ? h.value.toFixed(2) : h.value} ({h.operator} {h.threshold})
                      </HistoryMsg>
                    </HistoryItem>
                  );
                })}
              </div>
            )}
          </PanelBody>
        )}
      </Panel>
    );
  }
}

AlertPanel.propTypes = {
  rules: PropTypes.array,
  history: PropTypes.array,
  onToggleRule: PropTypes.func,
  onAddRule: PropTypes.func,
  onRemoveRule: PropTypes.func,
  onClearHistory: PropTypes.func
};

export default AlertPanel;
