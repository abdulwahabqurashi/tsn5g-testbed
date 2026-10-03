import { Component } from 'react';
import { connect } from 'react-redux';

import { fetchAnalytics } from 'modules/tsn-analytics';
import { Layout, GroupTabs } from 'components';
import { Dashboard } from 'components/TsnAnalytics';

class Collection extends Component {
  state = {
    refreshInterval: null
  };

  componentWillMount() {
    const { dispatch } = this.props;
    dispatch(fetchAnalytics());

    const interval = setInterval(() => {
      dispatch(fetchAnalytics());
    }, 5000);
    this.setState({ refreshInterval: interval });
  }

  componentWillUnmount() {
    if (this.state.refreshInterval) {
      clearInterval(this.state.refreshInterval);
    }
  }

  render() {
    const { data, isLoading, error, lastUpdated } = this.props;

    return (
      <Layout.Content>
        <GroupTabs group="bridge" active="tsn-analytics" />
        <Dashboard
          data={data}
          isLoading={isLoading}
          error={error}
          lastUpdated={lastUpdated}
        />
      </Layout.Content>
    );
  }
}

export default connect(
  (state) => ({ ...state.tsnAnalytics })
)(Collection);
