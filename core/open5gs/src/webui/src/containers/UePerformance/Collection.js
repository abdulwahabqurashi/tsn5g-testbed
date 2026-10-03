import { Component } from 'react';
import { connect } from 'react-redux';

import { fetchUePerformance } from 'modules/ue-performance';
import { Layout } from 'components';
import { Dashboard } from 'components/UePerformance';

class Collection extends Component {
  state = { target: '192.168.8.195' };

  componentWillMount() {
    this.props.dispatch(fetchUePerformance(this.state.target));
  }

  componentDidMount() {
    this._t = setInterval(() => {
      this.props.dispatch(fetchUePerformance(this.state.target));
    }, 2000);
  }

  componentWillUnmount() {
    if (this._t) clearInterval(this._t);
  }

  handleTarget = (target) => { this.setState({ target: target }); };

  render() {
    const { data, isLoading, error, lastUpdated } = this.props;
    return (
      <Layout.Content>
        <Dashboard
          data={data}
          isLoading={isLoading}
          error={error}
          lastUpdated={lastUpdated}
          target={this.state.target}
          onTarget={this.handleTarget}
        />
      </Layout.Content>
    );
  }
}

export default connect((state) => ({
  data: state.uePerformance.data,
  isLoading: state.uePerformance.isLoading,
  error: state.uePerformance.error,
  lastUpdated: state.uePerformance.lastUpdated
}))(Collection);
