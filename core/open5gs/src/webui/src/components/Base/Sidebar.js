import { Component } from 'react';
import PropTypes from 'prop-types';

import styled from 'styled-components';
import { media } from 'helpers/style-utils';
import { isAdmin } from 'helpers/role';

import DashboardIcon from 'react-icons/lib/io/ios-home-outline';
import SubscriberIcon from 'react-icons/lib/io/ios-personadd-outline';
import OnboardIcon from 'react-icons/lib/io/ios-color-wand-outline';
import ProfileIcon from 'react-icons/lib/io/ios-albums-outline';
import AccountIcon from 'react-icons/lib/io/ios-locked-outline';
import TsnIcon from 'react-icons/lib/io/network';
import RanIcon from 'react-icons/lib/io/wifi';
import GnbPmIcon from 'react-icons/lib/io/stats-bars';
import GnbQosIcon from 'react-icons/lib/io/ios-settings-strong';
import QosFlowsIcon from 'react-icons/lib/io/ios-pulse-strong';
import TimeSyncIcon from 'react-icons/lib/io/ios-clock-outline';
import NwttPerfIcon from 'react-icons/lib/io/ios-pulse';
import UeAnalyticsIcon from 'react-icons/lib/io/ios-people-outline';
import UePerfIcon from 'react-icons/lib/io/ios-speedometer';
import LogsIcon from 'react-icons/lib/io/ios-list-outline';
import HealthIcon from 'react-icons/lib/io/ios-medkit-outline';
import AuditIcon from 'react-icons/lib/io/clipboard';
import TsnGuideIcon from 'react-icons/lib/io/ios-book';

/* UniFi Network icon rail: 48px, white, icons only, blue when active. */
const Rail = styled.div`
  flex: 0 0 auto;
  width: 48px;
  display: ${p => p.hidden ? 'none' : 'flex'};
  flex-direction: column;
  align-items: center;
  padding: 8px 0;

  background: #ffffff;
  border-right: 1px solid var(--divider);
  overflow-y: auto;
  overflow-x: hidden;

  ${media.mobile`
    position: absolute;
    top: 0;
    left: 0;
    z-index: 50;
    height: 100%;
    box-shadow: 6px 0 20px rgba(16,24,40,0.10);
  `}
`;

const RailItem = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  margin: 2px 0;
  border-radius: 9px;

  cursor: pointer;
  font-size: 19px;
  transition: background .12s ease, color .12s ease;

  color: ${p => p.active ? 'var(--accent)' : '#7c8187'};
  background: ${p => p.active ? 'var(--accent-soft)' : 'transparent'};

  &:hover {
    background: ${p => p.active ? 'var(--accent-soft)' : 'var(--bg-hover)'};
    color: ${p => p.active ? 'var(--accent)' : 'var(--text-primary)'};
  }
`;

const RailGap = styled.div`
  height: 14px;
  flex: 0 0 auto;
`;

const RailSpacer = styled.div`
  flex: 1 1 auto;
`;

const propTypes = {
  isOpen: PropTypes.bool,
  selectedView: PropTypes.string,
  onSelectView: PropTypes.func
}

/* Map tab sub-views to their rail entry so the group icon stays
 * highlighted while any of its tabs is active. */
const NAV_GROUP = {
  'tsn-analytics': 'tsn',
  'tsn-topology': 'tsn',
  'tsn-sessions': 'nwtt-performance'
};

const TOP_GROUPS = [
  [
    { name: 'dashboard',        title: 'Dashboard',      icon: DashboardIcon },
    { name: 'subscriber',       title: 'Subscriber',     icon: SubscriberIcon },
    { name: 'onboard',          title: 'UE Onboarding',  icon: OnboardIcon },
    { name: 'profile',          title: 'Profile',        icon: ProfileIcon },
    { name: 'account',          title: 'Account',        icon: AccountIcon },
  ],
  [
    { name: 'ran-inventory',    title: 'RAN Inventory',  icon: RanIcon },
    { name: 'qos-flows',        title: 'QoS Flows',      icon: QosFlowsIcon },
    { name: 'gnb-pm',           title: 'gNB Performance',icon: GnbPmIcon },
    { name: 'tsn',              title: '5GS Bridge',     icon: TsnIcon },
    { name: 'time-sync',        title: 'Time Sync',      icon: TimeSyncIcon },
    { name: 'nwtt-performance', title: 'TSN Monitoring', icon: NwttPerfIcon },
    { name: 'ue-analytics',     title: 'UE Analytics',   icon: UeAnalyticsIcon },
    { name: 'ue-performance',   title: 'UE Performance', icon: UePerfIcon },
  ],
];

const BOTTOM_ITEMS = [
  { name: 'health',    title: 'Health Check', icon: HealthIcon },
  { name: 'audit',     title: 'Audit Log', icon: AuditIcon, admin: true },
  { name: 'logs',      title: 'Logs',      icon: LogsIcon },
  { name: 'tsn-guide', title: 'TSN Guide', icon: TsnGuideIcon },
];

class Sidebar extends Component {
  renderItem(item, navView, onSelectView) {
    const ItemIcon = item.icon;
    return (
      <RailItem
        key={item.name}
        title={item.title}
        active={item.name === navView}
        onClick={() => onSelectView(item.name)}>
        <ItemIcon/>
      </RailItem>
    );
  }

  render() {
    const { isOpen, selectedView, onSelectView } = this.props;
    const navView = NAV_GROUP[selectedView] || selectedView;
    const admin = isAdmin();

    return (
      <Rail hidden={isOpen === false}>
        {TOP_GROUPS.map((group, gi) => (
          <div key={gi} style={{display:'flex', flexDirection:'column', alignItems:'center'}}>
            {gi > 0 && <RailGap/>}
            {group
              .filter(item => item.name !== 'account' || admin)
              .map(item => this.renderItem(item, navView, onSelectView))}
          </div>
        ))}
        <RailSpacer/>
        {BOTTOM_ITEMS.filter(item => !item.admin || admin).map(item => this.renderItem(item, navView, onSelectView))}
      </Rail>
    );
  }
}

Sidebar.propTypes = propTypes;

export default Sidebar;
