import { Component } from 'react';
import PropTypes from 'prop-types';
import styled from 'styled-components';
import oc from 'open-color';
import { media } from 'helpers/style-utils';

import FilterListIcon from 'react-icons/lib/md/filter-list';
import SortIcon from 'react-icons/lib/md/sort';
import ClearAllIcon from 'react-icons/lib/md/clear-all';

const Wrapper = styled.div`
  width: 700px;
  margin: 0 auto 1rem auto;
  ${media.tablet`width: 400px;`}
  ${media.mobile`width: 100%;`}
`;

const ToggleBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--bg-card, white);
  border-radius: 4px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);
  cursor: pointer;
  font-size: 13px;
  color: ${'var(--text-secondary)'};
  transition: all 0.2s;
  &:hover { box-shadow: 0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23); }
  svg { font-size: 18px; }
`;

const Badge = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  color: white;
  background: ${'var(--accent)'};
`;

const Panel = styled.div`
  background: var(--bg-card);
  border-radius: 0 0 4px 4px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12);
  padding: 12px 14px;
  margin-top: -2px;
`;

const FilterSection = styled.div`
  margin-bottom: 10px;
  &:last-child { margin-bottom: 0; }
`;

const FilterLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${'var(--text-muted)'};
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
`;

const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`;

const Chip = styled.div`
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  cursor: pointer;
  background: ${p => p.active ? 'var(--accent)' : 'var(--divider)'};
  color: ${p => p.active ? 'white' : 'var(--text-secondary)'};
  transition: all 0.2s;
  &:hover { background: ${p => p.active ? 'var(--accent)' : 'var(--border-color)'}; }
`;

const BottomRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid ${'var(--divider)'};
`;

const SortSelect = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${'var(--text-secondary)'};
  svg { font-size: 16px; }
`;

const SortOption = styled.span`
  cursor: pointer;
  padding: 3px 10px;
  border-radius: 3px;
  font-size: 12px;
  background: ${p => p.active ? 'var(--accent-soft)' : 'transparent'};
  color: ${p => p.active ? '#4f46e5' : 'var(--text-secondary)'};
  &:hover { background: ${p => p.active ? 'var(--accent-soft)' : 'var(--divider)'}; }
`;

const ClearBtn = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: ${oc.red[5]};
  cursor: pointer;
  &:hover { color: ${oc.red[7]}; }
  svg { font-size: 16px; }
`;

var PDU_TYPES = [
  { value: 1, label: 'IPv4' },
  { value: 2, label: 'IPv6' },
  { value: 3, label: 'IPv4v6' },
  { value: 4, label: 'Unstructured' },
  { value: 5, label: 'Ethernet' }
];

var SST_VALUES = [1, 2, 3, 4];

class FilterPanel extends Component {
  state = { isOpen: false };

  toggleOpen = () => {
    this.setState({ isOpen: !this.state.isOpen });
  }

  handlePduTypeToggle = (type) => {
    var current = (this.props.filters && this.props.filters.pduTypes) || [];
    var next;
    if (current.indexOf(type) !== -1) {
      next = current.filter(function(t) { return t !== type; });
    } else {
      next = current.concat([type]);
    }
    this.props.onFilterChange({ pduTypes: next });
  }

  handleSstSelect = (sst) => {
    var current = this.props.filters && this.props.filters.sst;
    this.props.onFilterChange({ sst: current === sst ? null : sst });
  }

  handleSortChange = (sortBy) => {
    this.props.onFilterChange({ sortBy: sortBy });
  }

  render() {
    var filters = this.props.filters || {};
    var pduTypes = filters.pduTypes || [];
    var sst = filters.sst;
    var sortBy = filters.sortBy || 'imsi';
    var activeCount = this.props.activeCount || 0;
    var self = this;

    return (
      <Wrapper>
        <ToggleBar onClick={this.toggleOpen}>
          <FilterListIcon />
          <span>Filters</span>
          {activeCount > 0 && <Badge>{activeCount}</Badge>}
          <span style={{marginLeft: 'auto', fontSize: '11px'}}>
            {this.state.isOpen ? '\u25B2' : '\u25BC'}
          </span>
        </ToggleBar>

        {this.state.isOpen && (
          <Panel>
            <FilterSection>
              <FilterLabel>PDU Session Type</FilterLabel>
              <ChipRow>
                {PDU_TYPES.map(function(pt) {
                  return (
                    <Chip
                      key={pt.value}
                      active={pduTypes.indexOf(pt.value) !== -1}
                      onClick={function() { self.handlePduTypeToggle(pt.value); }}>
                      {pt.label}
                    </Chip>
                  );
                })}
              </ChipRow>
            </FilterSection>

            <FilterSection>
              <FilterLabel>Slice SST</FilterLabel>
              <ChipRow>
                {SST_VALUES.map(function(s) {
                  return (
                    <Chip
                      key={s}
                      active={sst === s}
                      onClick={function() { self.handleSstSelect(s); }}>
                      SST {s}
                    </Chip>
                  );
                })}
              </ChipRow>
            </FilterSection>

            <BottomRow>
              <SortSelect>
                <SortIcon />
                <span>Sort:</span>
                <SortOption
                  active={sortBy === 'imsi'}
                  onClick={function() { self.handleSortChange('imsi'); }}>
                  IMSI
                </SortOption>
                <SortOption
                  active={sortBy === 'sessions'}
                  onClick={function() { self.handleSortChange('sessions'); }}>
                  Session Count
                </SortOption>
              </SortSelect>

              {activeCount > 0 && (
                <ClearBtn onClick={this.props.onClear}>
                  <ClearAllIcon /> Clear All
                </ClearBtn>
              )}
            </BottomRow>
          </Panel>
        )}
      </Wrapper>
    );
  }
}

FilterPanel.propTypes = {
  filters: PropTypes.object,
  activeCount: PropTypes.number,
  onFilterChange: PropTypes.func,
  onClear: PropTypes.func
};

export default FilterPanel;
