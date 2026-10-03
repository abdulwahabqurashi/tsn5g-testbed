import { Component } from 'react';
import PropTypes from 'prop-types';
import { connect } from 'react-redux';

import { MODEL, fetchSubscribers, deleteSubscriber } from 'modules/crud/subscriber';
import { clearActionStatus } from 'modules/crud/actions';
import { select, selectActionStatus } from 'modules/crud/selectors';
import * as Notification from 'modules/notification/actions';

import {
  Layout,
  Subscriber,
  Spinner,
  FloatingButton,
  Blank,
  Dimmed,
  Confirm,
  ExportButton
} from 'components';
import { exportCSV, exportJSON } from 'helpers/export-utils';

import Document from './Document';

class Collection extends Component {
  state = {
    search: '',
    filters: {
      pduTypes: [],
      sst: null,
      sortBy: 'imsi'
    },
    document: {
      action: '',
      visible: false,
      dimmed: false
    },
    confirm: {
      visible: false,
      imsi: ''
    },
    view: {
      visible: false,
      disableOnClickOutside: false,
      imsi: ''
    }
  };

  componentWillMount() {
    const { subscribers, dispatch } = this.props

    if (subscribers.needsFetch) {
      dispatch(subscribers.fetch)
    }
  }

  componentWillReceiveProps(nextProps) {
    const { subscribers, status } = nextProps
    const { dispatch } = this.props

    if (subscribers.needsFetch) {
      dispatch(subscribers.fetch)
    }

    if (status.response) {
      dispatch(Notification.success({
        title: 'Subscriber',
        message: `${status.id} has been deleted`
      }));
      dispatch(clearActionStatus(MODEL, 'delete'));
    } 

    if (status.error) {
      let title = 'Unknown Code';
      let message = 'Unknown Error';
      if (response.data && response.data.name && response.data.message) {
        title = response.data.name;
        message = response.data.message;
      } else {
        title = response.status;
        message = response.statusText;
      }

      dispatch(Notification.error({
        title,
        message,
        autoDismiss: 0,
        action: {
          label: 'Dismiss'
        }
      }));
      dispatch(clearActionStatus(MODEL, 'delete'));
    }
  }

  handleSearchChange = (e) => {
    this.setState({
      search: e.target.value
    });
  }

  handleSearchClear = (e) => {
    this.setState({
      search: ''
    });
  }

  handleFilterChange = (newFilters) => {
    this.setState({ filters: { ...this.state.filters, ...newFilters } });
  }

  handleClearFilters = () => {
    this.setState({ filters: { pduTypes: [], sst: null, sortBy: 'imsi' } });
  }

  countActiveFilters = () => {
    var f = this.state.filters;
    var count = 0;
    if (f.pduTypes && f.pduTypes.length > 0) count++;
    if (f.sst != null) count++;
    if (f.sortBy !== 'imsi') count++;
    return count;
  }

  handleExportCSV = () => {
    var columns = [
      { key: 'imsi', label: 'IMSI' },
      { key: 'msisdn', label: 'MSISDN', accessor: function(s) { return (s.msisdn || []).join('; '); } },
      { key: 'slice', label: 'Slice SST', accessor: function(s) { return (s.slice || []).map(function(sl) { return sl.sst; }).join('; '); } },
      { key: 'dnn', label: 'DNN/APN', accessor: function(s) { var d = []; (s.slice || []).forEach(function(sl) { (sl.session || []).forEach(function(se) { d.push(se.name); }); }); return d.join('; '); } },
      { key: 'pduType', label: 'PDU Type', accessor: function(s) { var types = { 1:'IPv4', 2:'IPv6', 3:'IPv4v6', 4:'Unstructured', 5:'Ethernet' }; var t = []; (s.slice || []).forEach(function(sl) { (sl.session || []).forEach(function(se) { t.push(types[se.type] || 'Unknown'); }); }); return t.join('; '); } },
      { key: 'qci', label: '5QI/QCI', accessor: function(s) { var q = []; (s.slice || []).forEach(function(sl) { (sl.session || []).forEach(function(se) { q.push(se.qos ? se.qos.index : ''); }); }); return q.join('; '); } }
    ];
    exportCSV(this.props.subscribers.data, columns, 'subscribers.csv');
  }

  handleExportJSON = () => {
    exportJSON(this.props.subscribers.data, 'subscribers.json');
  }

  documentHandler = {
    show: (action, payload) => {
      this.setState({
        document: {
          action,
          visible: true,
          dimmed: true,
          ...payload
        },
        view: {
          ...this.state.view,
          disableOnClickOutside: true
        }
      })
    },
    hide: () => {
      this.setState({
        document: {
          action: '',
          visible: false,
          dimmed: false
        },
        view: {
          ...this.state.view,
          disableOnClickOutside: false
        }
      })
    },
    actions: {
      create: () => {
        this.documentHandler.show('create');
      },
      update: (imsi) => {
        this.documentHandler.show('update', { imsi });
      }
    }
  }

  confirmHandler = {
    show: (imsi) => {
      this.setState({
        confirm: {
          visible: true,
          imsi,
        },
        view: {
          ...this.state.view,
          disableOnClickOutside: true
        }
      })
    },
    hide: () => {
      this.setState({
        confirm: {
          ...this.state.confirm,
          visible: false
        },
        view: {
          ...this.state.view,
          disableOnClickOutside: false
        }
      })
    },
    actions : {
      delete: () => {
        const { dispatch } = this.props

        if (this.state.confirm.visible === true) {
          this.confirmHandler.hide();
          this.documentHandler.hide();
          this.viewHandler.hide();

          dispatch(deleteSubscriber(this.state.confirm.imsi));
        }
      }
    }
  }

  viewHandler = {
    show: (imsi) => {
      this.setState({
        view: {
          imsi,
          visible: true,
          disableOnClickOutside: false
        }
      });
    },
    hide: () => {
      this.setState({
        view: {
          ...this.state.view,
          visible: false
        }
      })
    }
  }


  render() {
    const {
      handleSearchChange,
      handleSearchClear,
      documentHandler,
      viewHandler,
      confirmHandler
    } = this;

    const { 
      search,
      document
    } = this.state;

    const { 
      subscribers,
      status
    } = this.props

    const {
      isLoading,
      data
    } = subscribers;

    return (
      <Layout.Content>
        {Object.keys(data).length > 0 && <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:'1rem',flexWrap:'wrap'}}>
          <Subscriber.Search
            onChange={handleSearchChange}
            value={search}
            onClear={handleSearchClear}
            filterCount={this.countActiveFilters()} />
          <ExportButton
            onExportCSV={this.handleExportCSV}
            onExportJSON={this.handleExportJSON} />
        </div>}
        {Object.keys(data).length > 0 &&
          <Subscriber.FilterPanel
            filters={this.state.filters}
            activeCount={this.countActiveFilters()}
            onFilterChange={this.handleFilterChange}
            onClear={this.handleClearFilters} />
        }
        <Subscriber.List
          subscribers={data}
          deletedImsi={status.id}
          onView={viewHandler.show}
          onEdit={documentHandler.actions.update}
          onDelete={confirmHandler.show}
          search={search}
          filters={this.state.filters}
        />
        {isLoading && <Spinner md />}
        <Blank
          visible={!isLoading && !(Object.keys(data).length > 0)}
          title="ADD A SUBSCRIBER"
          body="You have no subscribers... yet!"
          onTitle={documentHandler.actions.create}
          />
        <FloatingButton onClick={documentHandler.actions.create}/>
        <Subscriber.View
          visible={this.state.view.visible}
          subscriber={data.filter(subscriber => 
            subscriber.imsi === this.state.view.imsi)[0]}
          disableOnClickOutside={this.state.view.disableOnClickOutside}
          onEdit={documentHandler.actions.update}
          onDelete={confirmHandler.show}
          onHide={viewHandler.hide}/>
        <Document 
          { ...document }
          onEdit={documentHandler.actions.update}
          onDelete={confirmHandler.show}
          onHide={documentHandler.hide} />
        <Dimmed visible={document.dimmed} />
        <Confirm
          visible={this.state.confirm.visible}
          message="Delete this subscriber?"
          onOutside={confirmHandler.hide}
          buttons={[
            { text: "CANCEL", action: confirmHandler.hide, info:true },
            { text: "DELETE", action: confirmHandler.actions.delete, danger:true }
          ]}/>
      </Layout.Content>
    )
  }
}

Collection = connect(
  (state) => ({ 
    subscribers: select(fetchSubscribers(), state.crud),
    status: selectActionStatus(MODEL, state.crud, 'delete')
  })
)(Collection);

export default Collection;