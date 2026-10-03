import { Component } from 'react';
import PropTypes from 'prop-types';
import styled from 'styled-components';
import oc from 'open-color';

import FileDownloadIcon from 'react-icons/lib/md/file-download';

const Wrapper = styled.div`
  position: relative;
  display: inline-block;
`;

const Btn = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  color: ${'#4f46e5'};
  background: var(--bg-card, white);
  border: 1px solid ${'var(--accent-2)'};
  transition: all 0.2s;
  &:hover {
    background: ${'var(--bg-panel-header)'};
    border-color: ${'var(--accent)'};
  }
  svg { font-size: 16px; }
`;

const Menu = styled.div`
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: var(--bg-card, white);
  border: 1px solid var(--border-color, ${'var(--border-color)'});
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  z-index: 100;
  min-width: 140px;
  overflow: hidden;
`;

const MenuItem = styled.div`
  padding: 8px 14px;
  font-size: 13px;
  color: ${'var(--text-secondary)'};
  cursor: pointer;
  &:hover {
    background: ${'var(--divider)'};
    color: ${'var(--text-primary)'};
  }
  &:not(:last-child) {
    border-bottom: 1px solid ${'var(--divider)'};
  }
`;

class ExportButton extends Component {
  state = { menuOpen: false };

  componentDidMount() {
    this._handleOutsideClick = (e) => {
      if (this._wrapper && !this._wrapper.contains(e.target)) {
        this.setState({ menuOpen: false });
      }
    };
    document.addEventListener('click', this._handleOutsideClick);
  }

  componentWillUnmount() {
    document.removeEventListener('click', this._handleOutsideClick);
  }

  render() {
    const { onExportCSV, onExportJSON } = this.props;
    const { menuOpen } = this.state;
    var self = this;

    return (
      <Wrapper ref={function(el) { self._wrapper = el; }}>
        <Btn onClick={function() { self.setState({ menuOpen: !menuOpen }); }}>
          <FileDownloadIcon /> Export
        </Btn>
        {menuOpen && (
          <Menu>
            <MenuItem onClick={function() { self.setState({ menuOpen: false }); if (onExportCSV) onExportCSV(); }}>
              Export as CSV
            </MenuItem>
            <MenuItem onClick={function() { self.setState({ menuOpen: false }); if (onExportJSON) onExportJSON(); }}>
              Export as JSON
            </MenuItem>
          </Menu>
        )}
      </Wrapper>
    );
  }
}

ExportButton.propTypes = {
  onExportCSV: PropTypes.func,
  onExportJSON: PropTypes.func
};

export default ExportButton;
