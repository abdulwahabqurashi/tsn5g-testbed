import { Component } from 'react';
import PropTypes from 'prop-types';
import { connect } from 'react-redux';
import { bindActionCreators, compose } from 'redux';

import * as sidebarActions from 'modules/sidebar';
import withWidth, { SMALL } from 'helpers/with-width';

import { Layout } from 'components';
import Notification from 'containers/Notification';
import * as Subscriber from 'containers/Subscriber';
import * as Profile from 'containers/Profile';
import * as Account from 'containers/Account';
import * as Dashboard from 'containers/Dashboard';
import * as Tsn from 'containers/Tsn';
import * as TsnAnalytics from 'containers/TsnAnalytics';
import * as NwttPerformance from 'containers/NwttPerformance';
import * as TsnTopology from 'containers/TsnTopology';
import * as TsnSessions from 'containers/TsnSessions';
import * as UeAnalytics from 'containers/UeAnalytics';
import * as UePerformance from 'containers/UePerformance';
import * as Health from 'containers/Health';
import * as Audit from 'containers/Audit';
import * as RanInventory from 'containers/RanInventory';
import * as GnbPm from 'containers/GnbPm';
import * as GnbQos from 'containers/GnbQos';
import * as QosFlows from 'containers/QosFlows';
import * as Onboard from 'containers/Onboard';
import * as LogViewer from 'containers/LogViewer';
import * as TsnGuide from 'containers/TsnGuide';
import * as TimeSync from 'containers/TimeSync';

class App extends Component {
  static propTypes = {
    session: PropTypes.object.isRequired,
    view: PropTypes.string.isRequired,
    width: PropTypes.number.isRequired
  }
  
  componentWillMount() {
    const { 
      width,
      SidebarActions
    } = this.props;

    if (width !== SMALL) {
      SidebarActions.setVisibility(true);
    }
  }

  render() {
    const {
      view,
      session
    } = this.props;

    var isDark = this.props.isDarkMode;

    // Apply dark mode class
    if (typeof document !== 'undefined') {
      if (isDark) {
        document.body.classList.add('dark-mode');
      } else {
        document.body.classList.remove('dark-mode');
      }
    }

    if (isDark) {
      document.body.style.backgroundColor = "#1a1b1e";
    } else if (view === "dashboard" || view === "subscriber" || view === "tsn" || view === "onboard" || view === "ran-inventory" || view === "gnb-pm" || view === "gnb-qos" || view === "qos-flows" || view === "tsn-analytics" ||
        view === "nwtt-performance" || view === "tsn-topology" || view === "tsn-sessions" ||
        view === "ue-analytics" || view === "ue-performance" || view === "health" || view === "audit" || view === "logs" || view === "tsn-guide" ||
        view === "time-sync") {
      document.body.style.backgroundColor = "#e9ecef";
    } else {
      document.body.style.backgroundColor = "white";
    }

    return (
      <Layout>
        <Layout.Container visible={view === "dashboard"}>
          <Dashboard.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "onboard"}>
          <Onboard.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "subscriber"}>
          <Subscriber.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "profile"}>
          <Profile.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "account"}>
          <Account.Collection session={session}/>
        </Layout.Container>
        <Layout.Container visible={view === "ran-inventory"}>
          <RanInventory.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "qos-flows"}>
          <QosFlows.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "gnb-pm"}>
          <GnbPm.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "tsn"}>
          <Tsn.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "time-sync"}>
          <TimeSync.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "tsn-analytics"}>
          <TsnAnalytics.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "nwtt-performance"}>
          <NwttPerformance.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "tsn-topology"}>
          <TsnTopology.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "tsn-sessions"}>
          <TsnSessions.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "ue-analytics"}>
          <UeAnalytics.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "ue-performance"}>
          <UePerformance.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "health"}>
          <Health.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "audit"}>
          <Audit.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "logs"}>
          <LogViewer.Collection/>
        </Layout.Container>
        <Layout.Container visible={view === "tsn-guide"}>
          <TsnGuide.Collection/>
        </Layout.Container>
        <Notification/>
      </Layout>
    )
  }
}

const enhance = compose(
  withWidth(),
  connect(
    (state) => ({
      view: state.sidebar.view,
      isDarkMode: state.theme.isDarkMode
    }),
    (dispatch) => ({
      SidebarActions: bindActionCreators(sidebarActions, dispatch)
    })
  )
);

export default enhance(App);
