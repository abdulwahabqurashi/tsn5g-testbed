import { Component } from 'react';
import { connect } from 'react-redux';

import { fetchTsnTopology } from 'modules/tsn-topology';
import { Layout, GroupTabs } from 'components';
import { View } from 'components/TsnTopology';

class Collection extends Component {
  state = {
    refreshInterval: null
  };

  componentWillMount() {
    const { dispatch } = this.props;
    dispatch(fetchTsnTopology());

    const interval = setInterval(() => {
      dispatch(fetchTsnTopology());
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
        <GroupTabs group="bridge" active="tsn-topology" />
        <View
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
  (state) => ({ ...state.tsnTopology })
)(Collection);
