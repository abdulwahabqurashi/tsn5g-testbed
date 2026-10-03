import { Component } from 'react';
import PropTypes from 'prop-types';

import { Form } from 'components';
import { tsnApi } from 'helpers/tsn-api';

const schema = {
  "title": "Stream Reservation (802.1Qat)",
  "type": "object",
  "properties": {
    "streamId": {
      "type": "number",
      "title": "Stream ID"
    },
    "maxFrameSize": {
      "type": "number",
      "title": "Max Frame Size (bytes)"
    },
    "intervalUs": {
      "type": "number",
      "title": "Interval (us)"
    },
    "maxLatencyUs": {
      "type": "number",
      "title": "Max Latency (us)"
    }
  },
  "required": ["streamId", "maxFrameSize", "intervalUs", "maxLatencyUs"]
};

const uiSchema = {
  "streamId": {
    classNames: "col-xs-12"
  },
  "maxFrameSize": {
    classNames: "col-xs-12"
  },
  "intervalUs": {
    classNames: "col-xs-12"
  },
  "maxLatencyUs": {
    classNames: "col-xs-12"
  }
};

class StreamForm extends Component {
  static propTypes = {
    visible: PropTypes.bool,
    bridgeId: PropTypes.string,
    onHide: PropTypes.func,
    onSuccess: PropTypes.func
  }

  state = {
    isLoading: false
  }

  handleSubmit = (formData) => {
    var bridgeId = this.props.bridgeId;
    this.setState({ isLoading: true });

    tsnApi('post', '/api/tsn/Bridge/' + bridgeId + '/stream-reservations', formData)
      .then(() => {
        this.setState({ isLoading: false });
        if (this.props.onSuccess) this.props.onSuccess();
        if (this.props.onHide) this.props.onHide();
      })
      .catch(() => {
        this.setState({ isLoading: false });
      });
  }

  render() {
    return (
      <Form
        visible={this.props.visible}
        title="Stream Reservation (802.1Qat)"
        schema={schema}
        uiSchema={uiSchema}
        formData={{}}
        isLoading={this.state.isLoading}
        onHide={this.props.onHide}
        onSubmit={this.handleSubmit}
        onError={() => {}}
        width="600px"
        height="350px"/>
    );
  }
}

export default StreamForm;
