import { Component } from 'react';
import { connect } from 'react-redux';

import { fetchUeAnalytics } from 'modules/ue-analytics';
import { Layout } from 'components';
import { Dashboard } from 'components/UeAnalytics';

class Collection extends Component {
  state = {
    refreshInterval: null
  };

  componentWillMount() {
    const { dispatch } = this.props;
    dispatch(fetchUeAnalytics());

    const interval = setInterval(() => {
      dispatch(fetchUeAnalytics());
    }, 3000);
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
  (state) => ({ ...state.ueAnalytics })
)(Collection);
