import { Component } from 'react';
import { connect } from 'react-redux';

import { fetchTsnSessions } from 'modules/tsn-sessions';
import { Layout, GroupTabs } from 'components';
import { Dashboard } from 'components/TsnSessions';

class Collection extends Component {
  state = {
    refreshInterval: null
  };

  componentWillMount() {
    const { dispatch } = this.props;
    dispatch(fetchTsnSessions());

    const interval = setInterval(() => {
      dispatch(fetchTsnSessions());
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
        <GroupTabs group="monitoring" active="tsn-sessions" />
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
  (state) => ({ ...state.tsnSessions })
)(Collection);
