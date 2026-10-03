import { Component } from 'react';
import { connect } from 'react-redux';

import { fetchNwttPerformance } from 'modules/nwtt-performance';
import { Layout, GroupTabs } from 'components';
import { Dashboard } from 'components/NwttPerformance';

class Collection extends Component {
  state = {
    refreshInterval: null
  };

  componentWillMount() {
    const { dispatch } = this.props;
    dispatch(fetchNwttPerformance());

    const interval = setInterval(() => {
      dispatch(fetchNwttPerformance());
    }, 2000);
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
        <GroupTabs group="monitoring" active="nwtt-performance" />
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
  (state) => ({ ...state.nwttPerformance })
)(Collection);
