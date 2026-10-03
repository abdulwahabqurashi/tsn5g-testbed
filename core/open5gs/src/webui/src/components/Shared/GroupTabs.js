import PropTypes from 'prop-types';
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import styled from 'styled-components';
import oc from 'open-color';

import * as sidebarActions from 'modules/sidebar';

/*
 * Sub-navigation tabs for page groups aligned with the 3GPP 5G-TSN
 * architecture (TS 23.501 §5.27/5.28). Each tab switches the sidebar
 * view, so the underlying containers and their data flows stay intact.
 */
const GROUPS = {
  bridge: {
    title: '5GS Logical Bridge',
    subtitle: '3GPP TS 23.501 §5.28 — the 5G system exposed to the CNC as an IEEE 802.1 bridge',
    tabs: [
      { view: 'tsn', label: 'Bridge & Ports' },
      { view: 'tsn-analytics', label: 'CNC / Control Plane' }
    ]
  },
  monitoring: {
    title: 'TSN Monitoring',
    subtitle: 'Live translator-port counters, residence time, jitter and PSFP statistics',
    tabs: [
      { view: 'nwtt-performance', label: 'NW-TT Ports' },
      { view: 'tsn-sessions', label: 'DS-TT Sessions' }
    ]
  }
};

const Wrapper = styled.div`
  margin-bottom: 1rem;
`;

const GroupTitle = styled.div`
  font-size: 20px;
  font-weight: 700;
  color: ${'var(--text-primary)'};
`;

const GroupSubtitle = styled.div`
  font-size: 12px;
  color: ${'var(--text-muted)'};
  margin: 2px 0 10px 0;
`;

const TabRow = styled.div`
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: #f0f2f5;
  border-radius: 10px;
`;

const Tab = styled.div`
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 8px;
  transition: all .12s ease;
  background: ${p => p.active ? '#ffffff' : 'transparent'};
  box-shadow: ${p => p.active ?
    '0 1px 3px rgba(16,24,40,0.12)' : 'none'};
  color: ${p => p.active ? 'var(--text-primary)' : 'var(--text-secondary)'};
  &:hover { color: ${'var(--text-primary)'}; }
`;

const GroupTabs = ({ group, active, SidebarActions }) => {
  const def = GROUPS[group];
  if (!def) return null;
  return (
    <Wrapper>
      <GroupTitle>{def.title}</GroupTitle>
      <GroupSubtitle>{def.subtitle}</GroupSubtitle>
      <TabRow>
        {def.tabs.map(function(t) {
          return (
            <Tab
              key={t.view}
              active={t.view === active}
              onClick={function() { SidebarActions.selectView(t.view); }}>
              {t.label}
            </Tab>
          );
        })}
      </TabRow>
    </Wrapper>
  );
};

GroupTabs.propTypes = {
  group: PropTypes.oneOf(Object.keys(GROUPS)).isRequired,
  active: PropTypes.string.isRequired
};

export default connect(
  null,
  (dispatch) => ({
    SidebarActions: bindActionCreators(sidebarActions, dispatch)
  })
)(GroupTabs);
