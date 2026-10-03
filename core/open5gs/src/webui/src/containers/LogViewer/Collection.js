import { Component } from 'react';
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';

import { Layout } from 'components';
import { Viewer } from 'components/LogViewer';
import { fetchLogs, fetchLogList, setService } from 'modules/log-viewer';

class Collection extends Component {
  componentWillMount() {
    this.props.fetchLogList();
    this.fetchCurrent();
    this._interval = setInterval(() => {
      if (this._autoRefresh !== false) {
        this.fetchCurrent();
      }
    }, 3000);
  }

  componentWillUnmount() {
    if (this._interval) clearInterval(this._interval);
  }

  fetchCurrent() {
    var service = this.props.logViewer.selectedService || 'amf';
    this.props.dispatch({ type: 'log-viewer/FETCH_REQUEST', payload: service });
  }

  handleSelectService(svc) {
    this.props.setService(svc);
    // Immediately fetch logs for new service
    this.props.dispatch({ type: 'log-viewer/FETCH_REQUEST', payload: svc });
  }

  render() {
    const { logViewer } = this.props;
    var self = this;

    return (
      <Layout.Content>
        <Viewer
          logs={logViewer.logs}
          services={logViewer.services}
          selectedService={logViewer.selectedService}
          isLoading={logViewer.isLoading}
          error={logViewer.error}
          lastUpdated={logViewer.lastUpdated}
          onSelectService={function(svc) { self.handleSelectService(svc); }}
          onToggleRefresh={function(on) { self._autoRefresh = on; }}
        />
      </Layout.Content>
    );
  }
}

export default connect(
  function(state) {
    return { logViewer: state.logViewer };
  },
  function(dispatch) {
    return {
      fetchLogs: bindActionCreators(fetchLogs, dispatch),
      fetchLogList: bindActionCreators(fetchLogList, dispatch),
      setService: bindActionCreators(setService, dispatch),
      dispatch: dispatch
    };
  }
)(Collection);
