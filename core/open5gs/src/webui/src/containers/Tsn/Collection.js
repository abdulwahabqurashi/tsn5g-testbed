import { Component } from 'react';
import PropTypes from 'prop-types';
import { connect } from 'react-redux';

import { MODEL, fetchBridges, deleteBridge } from 'modules/crud/tsn';
import { clearActionStatus } from 'modules/crud/actions';
import { select, selectActionStatus } from 'modules/crud/selectors';
import * as Notification from 'modules/notification/actions';

import {
  Layout,
  Tsn,
  Spinner,
  FloatingButton,
  Blank,
  Dimmed,
  Confirm,
  GroupTabs
} from 'components';

import Document from './Document';

class Collection extends Component {
  state = {
    search: '',
    document: {
      action: '',
      visible: false,
      dimmed: false
    },
    confirm: {
      visible: false,
      bridgeId: ''
    },
    view: {
      visible: false,
      disableOnClickOutside: false,
      bridgeId: ''
    }
  };

  componentWillMount() {
    const { bridges, dispatch } = this.props

    if (bridges.needsFetch) {
      dispatch(bridges.fetch)
    }
  }

  componentWillReceiveProps(nextProps) {
    const { bridges, status } = nextProps
    const { dispatch } = this.props

    if (bridges.needsFetch) {
      dispatch(bridges.fetch)
    }

    if (status.response) {
      dispatch(Notification.success({
        title: 'TSN Bridge',
        message: `${status.id} has been deleted`
      }));
      dispatch(clearActionStatus(MODEL, 'delete'));
    }

    if (status.error) {
      const response = ((status || {}).error || {}).response || {};

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
      update: (bridgeId) => {
        this.documentHandler.show('update', { bridgeId });
      }
    }
  }

  confirmHandler = {
    show: (bridgeId) => {
      this.setState({
        confirm: {
          visible: true,
          bridgeId,
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
    actions: {
      delete: () => {
        const { dispatch } = this.props

        if (this.state.confirm.visible === true) {
          this.confirmHandler.hide();
          this.documentHandler.hide();
          this.viewHandler.hide();

          dispatch(deleteBridge(this.state.confirm.bridgeId));
        }
      }
    }
  }

  viewHandler = {
    show: (bridgeId) => {
      this.setState({
        view: {
          bridgeId,
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
    },
    refresh: () => {
      const { dispatch } = this.props;
      dispatch(fetchBridges().fetch);
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
      bridges,
      status
    } = this.props

    const {
      isLoading,
      data
    } = bridges;

    return (
      <Layout.Content>
        <GroupTabs group="bridge" active="tsn" />
        {Object.keys(data).length > 0 && <Tsn.Search
          onChange={handleSearchChange}
          value={search}
          onClear={handleSearchClear} />}
        <Tsn.List
          bridges={data}
          deletedId={status.id}
          onView={viewHandler.show}
          onEdit={documentHandler.actions.update}
          onDelete={confirmHandler.show}
          search={search}
        />
        {isLoading && <Spinner md />}
        <Blank
          visible={!isLoading && !(Object.keys(data).length > 0)}
          title="ADD A BRIDGE"
          body="You have no TSN bridges... yet!"
          onTitle={documentHandler.actions.create}
          />
        <FloatingButton onClick={documentHandler.actions.create}/>
        <Tsn.View
          visible={this.state.view.visible}
          bridge={data.filter(b =>
            b.bridgeId === this.state.view.bridgeId)[0]}
          disableOnClickOutside={this.state.view.disableOnClickOutside}
          onEdit={documentHandler.actions.update}
          onDelete={confirmHandler.show}
          onHide={viewHandler.hide}
          onRefresh={viewHandler.refresh}/>
        <Document
          { ...document }
          bridgeId={document.bridgeId}
          onEdit={documentHandler.actions.update}
          onDelete={confirmHandler.show}
          onHide={documentHandler.hide} />
        <Dimmed visible={document.dimmed} />
        <Confirm
          visible={this.state.confirm.visible}
          message="Delete this bridge?"
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
    bridges: select(fetchBridges(), state.crud),
    status: selectActionStatus(MODEL, state.crud, 'delete')
  })
)(Collection);

export default Collection;
