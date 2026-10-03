import { Component } from 'react';
import PropTypes from 'prop-types';
import { connect } from 'react-redux';

import NProgress from 'nprogress';

import { MODEL, fetchBridges, fetchBridge, createBridge, updateBridge } from 'modules/crud/tsn';
import { clearActionStatus } from 'modules/crud/actions';
import { select, selectActionStatus } from 'modules/crud/selectors';
import * as Notification from 'modules/notification/actions';

import { Tsn } from 'components';

const formData = {
  "bridgeMac": "00:00:00:00:00:00"
}

class Document extends Component {
  static propTypes = {
    action: PropTypes.string,
    visible: PropTypes.bool,
    onHide: PropTypes.func
  }

  state = {
    formData
  }

  componentWillMount() {
    const { bridge, dispatch } = this.props

    if (bridge.needsFetch) {
      dispatch(bridge.fetch)
    }
  }

  componentWillReceiveProps(nextProps) {
    const { bridge, status } = nextProps
    const { dispatch, action, onHide } = this.props

    if (bridge.needsFetch) {
      dispatch(bridge.fetch)
    }

    if (bridge.data) {
      this.setState({ formData: bridge.data })
    } else {
      this.setState({ formData });
    }

    if (status.response) {
      NProgress.configure({
        parent: 'body',
        trickleSpeed: 5
      });
      NProgress.done(true);

      const message = action === 'create' ? "New bridge created" : `${status.id} bridge updated`;

      dispatch(Notification.success({
        title: 'TSN Bridge',
        message
      }));

      dispatch(clearActionStatus(MODEL, action));
      onHide();
    }

    if (status.error) {
      NProgress.configure({
        parent: 'body',
        trickleSpeed: 5
      });
      NProgress.done(true);

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
          label: 'Dismiss',
          callback: () => onHide()
        }
      }));
      dispatch(clearActionStatus(MODEL, action));
    }
  }

  validate = (formData, errors) => {
    const { bridges, action } = this.props;
    const { bridgeId } = formData;

    if (action === 'create' && bridges && bridges.data &&
      bridges.data.filter(b => b.bridgeId === bridgeId).length > 0) {
      errors.bridgeId.addError(`'${bridgeId}' already exists`);
    }

    return errors;
  }

  handleSubmit = (formData) => {
    const { dispatch, action } = this.props;

    NProgress.configure({
      parent: '#nprogress-base-form',
      trickleSpeed: 5
    });
    NProgress.start();

    if (action === 'create') {
      dispatch(createBridge({}, formData));
    } else if (action === 'update') {
      dispatch(updateBridge(formData.bridgeId, {}, formData));
    } else {
      throw new Error(`Action type '${action}' is invalid.`);
    }
  }

  handleError = errors => {
    const { dispatch } = this.props;
    errors.map(error =>
      dispatch(Notification.error({
        title: 'Validation Error',
        message: error.stack
      }))
    )
  }

  render() {
    const {
      validate,
      handleSubmit,
      handleError
    } = this;

    const {
      visible,
      action,
      status,
      bridge,
      onHide
    } = this.props

    return (
      <Tsn.Edit
        visible={visible}
        action={action}
        formData={this.state.formData}
        isLoading={bridge.isLoading && !status.pending}
        validate={validate}
        onHide={onHide}
        onSubmit={handleSubmit}
        onError={handleError} />
    )
  }
}

Document = connect(
  (state, props) => ({
    bridges: select(fetchBridges(), state.crud),
    bridge: select(fetchBridge(props.bridgeId), state.crud),
    status: selectActionStatus(MODEL, state.crud, props.action)
  })
)(Document);

export default Document;
