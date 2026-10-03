import { Component } from 'react';
import PropTypes from 'prop-types';
import styled from 'styled-components';
import oc from 'open-color';

import { tsnApi } from 'helpers/tsn-api';

var Overlay = styled.div`
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

var Panel = styled.div`
  background: var(--bg-card);
  border-radius: 4px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.25);
  width: 700px;
  max-height: 80vh;
  overflow-y: auto;
`;

var PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid ${'var(--border-color)'};
  background: ${'var(--bg-hover)'};
  border-radius: 4px 4px 0 0;
`;

var PanelTitle = styled.div`
  font-size: 15px;
  font-weight: 600;
  color: ${'var(--text-primary)'};
`;

var CloseBtn = styled.button`
  border: none;
  background: none;
  font-size: 18px;
  color: ${'var(--text-muted)'};
  cursor: pointer;
  padding: 0 4px;
  &:hover { color: ${'var(--text-primary)'}; }
`;

var PanelBody = styled.div`
  padding: 1rem 1.25rem;
`;

var Table = styled.div`
  width: 100%;
  font-size: 12px;
  .row {
    display: flex;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid ${'var(--divider)'};
    gap: 8px;
  }
  .row.header {
    font-weight: 600;
    color: ${'var(--text-muted)'};
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.5px;
  }
  .col-idx { width: 30px; text-align: center; }
  .col-mac { flex: 1; font-family: monospace; }
  .col-vlan { width: 60px; text-align: right; }
  .col-match { width: 80px; text-align: right; font-family: monospace; }
  .col-actions { width: 90px; text-align: right; }
`;

var ActionBtn = styled.button`
  padding: 3px 8px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid ${function(p) {
    if (p.danger) return oc.red[4];
    if (p.primary) return oc.cyan[5];
    return 'var(--border-color)';
  }};
  color: ${function(p) {
    if (p.danger) return oc.red[7];
    if (p.primary) return oc.cyan[7];
    return 'var(--text-secondary)';
  }};
  background: var(--bg-card);
  margin-left: 4px;
  &:hover { opacity: 0.8; }
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`;

var AddRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid ${'var(--divider)'};
  input {
    padding: 4px 8px;
    border: 1px solid ${'var(--border-color)'};
    border-radius: 3px;
    font-size: 12px;
    font-family: monospace;
  }
  input.mac { width: 140px; }
  input.vlan { width: 60px; }
`;

var SaveBar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1.25rem;
  border-top: 1px solid ${'var(--border-color)'};
  background: ${'var(--bg-hover)'};
  border-radius: 0 0 4px 4px;
`;

var SaveBtn = styled.button`
  padding: 6px 16px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  color: white;
  background: ${oc.cyan[6]};
  &:hover { opacity: 0.9; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

var AddBtn = styled.button`
  padding: 4px 12px;
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  border: 1px dashed ${'var(--border-color)'};
  color: ${'var(--text-secondary)'};
  background: var(--bg-card);
  &:hover { border-color: ${oc.cyan[4]}; color: ${oc.cyan[6]}; }
`;

var StatusMsg = styled.div`
  font-size: 12px;
  color: ${function(p) { return p.error ? oc.red[6] : oc.green[6]; }};
`;

class StreamFilterManager extends Component {
  static propTypes = {
    visible: PropTypes.bool,
    bridgeId: PropTypes.string,
    portNumber: PropTypes.number,
    currentFilters: PropTypes.array,
    onHide: PropTypes.func,
    onRefresh: PropTypes.func
  }

  state = {
    filters: [],
    editingIndex: -1,
    editMac: '',
    editVlan: '',
    isAdding: false,
    newMac: '',
    newVlan: '',
    isSaving: false,
    dirty: false,
    statusMsg: '',
    statusError: false
  }

  componentWillMount() {
    this.loadFilters(this.props);
  }

  componentWillReceiveProps(nextProps) {
    if (nextProps.visible && !this.props.visible) {
      this.loadFilters(nextProps);
    }
  }

  loadFilters(props) {
    var filters = (props.currentFilters || []).map(function(f) {
      return {
        dest_mac: f.dest_mac || '',
        vlan_id: f.vlan_id || 0,
        match_count: f.match_count || 0,
        match_bytes: f.match_bytes || 0
      };
    });
    this.setState({
      filters: filters,
      editingIndex: -1,
      isAdding: false,
      dirty: false,
      statusMsg: '',
      statusError: false
    });
  }

  handleEdit(index) {
    var f = this.state.filters[index];
    this.setState({
      editingIndex: index,
      editMac: f.dest_mac,
      editVlan: f.vlan_id ? String(f.vlan_id) : '',
      isAdding: false
    });
  }

  handleEditSave() {
    var filters = this.state.filters.slice();
    filters[this.state.editingIndex] = Object.assign(
      {}, filters[this.state.editingIndex], {
        dest_mac: this.state.editMac,
        vlan_id: this.state.editVlan ? parseInt(this.state.editVlan, 10) : 0
      });
    this.setState({
      filters: filters,
      editingIndex: -1,
      dirty: true
    });
  }

  handleDelete(index) {
    var filters = this.state.filters.slice();
    filters.splice(index, 1);
    this.setState({ filters: filters, dirty: true });
  }

  handleAddStart() {
    this.setState({
      isAdding: true,
      newMac: '',
      newVlan: '',
      editingIndex: -1
    });
  }

  handleAddConfirm() {
    if (!this.state.newMac) return;
    var filters = this.state.filters.slice();
    filters.push({
      dest_mac: this.state.newMac,
      vlan_id: this.state.newVlan ? parseInt(this.state.newVlan, 10) : 0,
      match_count: 0,
      match_bytes: 0
    });
    this.setState({
      filters: filters,
      isAdding: false,
      newMac: '',
      newVlan: '',
      dirty: true
    });
  }

  handleSave() {
    var self = this;
    var bridgeId = this.props.bridgeId;
    var portNumber = this.props.portNumber;

    if (!bridgeId || portNumber == null) return;

    var payload = {
      streamFilters: this.state.filters.map(function(f, idx) {
        return {
          instanceId: idx,
          destMac: f.dest_mac,
          vlanId: f.vlan_id || 0,
          priority: -1
        };
      })
    };

    this.setState({ isSaving: true, statusMsg: '', statusError: false });
    tsnApi('post', '/api/tsn/Bridge/' + bridgeId + '/Port/' + portNumber + '/psfp', payload)
      .then(function() {
        self.setState({
          isSaving: false,
          dirty: false,
          statusMsg: 'Filters saved successfully',
          statusError: false
        });
        if (self.props.onRefresh) self.props.onRefresh();
      })
      .catch(function(err) {
        var msg = (err.response && err.response.data && err.response.data.message)
          || 'Failed to save filters';
        self.setState({
          isSaving: false,
          statusMsg: msg,
          statusError: true
        });
      });
  }

  render() {
    if (!this.props.visible) return null;

    var self = this;
    var filters = this.state.filters;

    return (
      <Overlay onClick={function(e) {
        if (e.target === e.currentTarget && self.props.onHide) self.props.onHide();
      }}>
        <Panel>
          <PanelHeader>
            <PanelTitle>
              Stream Filters — Port {this.props.portNumber}
            </PanelTitle>
            <CloseBtn onClick={this.props.onHide}>&times;</CloseBtn>
          </PanelHeader>

          <PanelBody>
            <Table>
              <div className="row header">
                <span className="col-idx">#</span>
                <span className="col-mac">Dest MAC</span>
                <span className="col-vlan">VLAN</span>
                <span className="col-match">Matches</span>
                <span className="col-match">Bytes</span>
                <span className="col-actions">Actions</span>
              </div>

              {filters.map(function(f, idx) {
                if (self.state.editingIndex === idx) {
                  return (
                    <AddRow key={idx}>
                      <span className="col-idx" style={{width:30,textAlign:'center'}}>{idx}</span>
                      <input className="mac"
                        value={self.state.editMac}
                        onChange={function(e) { self.setState({editMac: e.target.value}); }}
                        placeholder="aa:bb:cc:dd:ee:ff" />
                      <input className="vlan"
                        value={self.state.editVlan}
                        onChange={function(e) { self.setState({editVlan: e.target.value}); }}
                        placeholder="VLAN" />
                      <ActionBtn primary onClick={function() { self.handleEditSave(); }}>OK</ActionBtn>
                      <ActionBtn onClick={function() { self.setState({editingIndex: -1}); }}>Cancel</ActionBtn>
                    </AddRow>
                  );
                }
                return (
                  <div className="row" key={idx}>
                    <span className="col-idx">{idx}</span>
                    <span className="col-mac">{f.dest_mac}</span>
                    <span className="col-vlan">{f.vlan_id || '-'}</span>
                    <span className="col-match">{f.match_count}</span>
                    <span className="col-match">{f.match_bytes}</span>
                    <span className="col-actions">
                      <ActionBtn onClick={function() { self.handleEdit(idx); }}>Edit</ActionBtn>
                      <ActionBtn danger onClick={function() { self.handleDelete(idx); }}>Del</ActionBtn>
                    </span>
                  </div>
                );
              })}

              {self.state.isAdding &&
                <AddRow>
                  <span style={{width:30,textAlign:'center',fontSize:'11px',color:'var(--text-muted)'}}>new</span>
                  <input className="mac"
                    value={self.state.newMac}
                    onChange={function(e) { self.setState({newMac: e.target.value}); }}
                    placeholder="aa:bb:cc:dd:ee:ff"
                    autoFocus />
                  <input className="vlan"
                    value={self.state.newVlan}
                    onChange={function(e) { self.setState({newVlan: e.target.value}); }}
                    placeholder="VLAN" />
                  <ActionBtn primary onClick={function() { self.handleAddConfirm(); }}>Add</ActionBtn>
                  <ActionBtn onClick={function() { self.setState({isAdding: false}); }}>Cancel</ActionBtn>
                </AddRow>
              }
            </Table>

            {!self.state.isAdding && filters.length < 16 &&
              <div style={{marginTop: '8px'}}>
                <AddBtn onClick={function() { self.handleAddStart(); }}>
                  + Add Filter
                </AddBtn>
              </div>
            }
            {filters.length >= 16 &&
              <div style={{marginTop:'8px',fontSize:'11px',color:oc.yellow[8]}}>
                Maximum 16 filters per port reached.
              </div>
            }
          </PanelBody>

          <SaveBar>
            <div>
              {this.state.statusMsg &&
                <StatusMsg error={this.state.statusError}>{this.state.statusMsg}</StatusMsg>
              }
            </div>
            <div style={{display:'flex',gap:'8px',alignItems:'center'}}>
              {this.state.dirty &&
                <span style={{fontSize:'11px',color:oc.yellow[7]}}>Unsaved changes</span>
              }
              <SaveBtn
                onClick={function() { self.handleSave(); }}
                disabled={!self.state.dirty || self.state.isSaving}>
                {self.state.isSaving ? 'Saving...' : 'Save Filters'}
              </SaveBtn>
            </div>
          </SaveBar>
        </Panel>
      </Overlay>
    );
  }
}

export default StreamFilterManager;
