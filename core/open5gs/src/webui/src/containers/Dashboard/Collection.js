import { Component } from 'react';
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';

import { Layout } from 'components';
import { Overview } from 'components/Dashboard';
import { fetchDashboard } from 'modules/dashboard';
import * as sidebarActions from 'modules/sidebar';
import { addRule, removeRule, toggleRule, clearHistory } from 'modules/alerts';

class Collection extends Component {
  componentWillMount() {
    this.props.fetchDashboard();
    this._interval = setInterval(() => {
      this.props.fetchDashboard();
    }, 5000);
  }

  componentWillUnmount() {
    if (this._interval) clearInterval(this._interval);
  }

  render() {
    const { dashboard, alerts, SidebarActions, AlertActions } = this.props;

    return (
      <Layout.Content>
        <Overview
          data={dashboard.data}
          isLoading={dashboard.isLoading}
          error={dashboard.error}
          lastUpdated={dashboard.lastUpdated}
          onNavigate={function(view) { SidebarActions.selectView(view); }}
          alertRules={alerts.rules}
          alertHistory={alerts.history}
          onToggleRule={AlertActions.toggleRule}
          onAddRule={AlertActions.addRule}
          onRemoveRule={AlertActions.removeRule}
          onClearAlertHistory={AlertActions.clearHistory}
        />
      </Layout.Content>
    );
  }
}

export default connect(
  function(state) {
    return {
      dashboard: state.dashboard,
      alerts: state.alerts
    };
  },
  function(dispatch) {
    return {
      fetchDashboard: bindActionCreators(fetchDashboard, dispatch),
      SidebarActions: bindActionCreators(sidebarActions, dispatch),
      AlertActions: bindActionCreators({ addRule, removeRule, toggleRule, clearHistory }, dispatch)
    };
  }
)(Collection);
