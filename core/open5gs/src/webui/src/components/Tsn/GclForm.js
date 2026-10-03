import { Component } from 'react';
import PropTypes from 'prop-types';

import { Form } from 'components';
import { tsnApi } from 'helpers/tsn-api';

const schema = {
  "title": "Gate Control List (802.1Qbv)",
  "type": "object",
  "properties": {
    "entries": {
      "type": "array",
      "title": "GCL Entries",
      "items": {
        "type": "object",
        "properties": {
          "gateStates": {
            "type": "number",
            "title": "Gate States (bitmask 0-255)",
            "minimum": 0,
            "maximum": 255
          },
          "timeIntervalNs": {
            "type": "number",
            "title": "Time Interval (ns)",
            "minimum": 1
          }
        },
        "required": ["gateStates", "timeIntervalNs"]
      }
    }
  }
};

const uiSchema = {
  "entries": {
    classNames: "col-xs-12"
  }
};

class GclForm extends Component {
  static propTypes = {
    visible: PropTypes.bool,
    bridgeId: PropTypes.string,
    portNumber: PropTypes.number,
    onHide: PropTypes.func,
    onSuccess: PropTypes.func
  }

  state = {
    isLoading: false
  }

  handleSubmit = (formData) => {
    var bridgeId = this.props.bridgeId;
    var portNumber = this.props.portNumber;
    this.setState({ isLoading: true });

    tsnApi('post', '/api/tsn/Bridge/' + bridgeId + '/Port/' + portNumber + '/gcl', formData)
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
        title={'GCL - Port ' + this.props.portNumber}
        schema={schema}
        uiSchema={uiSchema}
        formData={{entries: []}}
        isLoading={this.state.isLoading}
        onHide={this.props.onHide}
        onSubmit={this.handleSubmit}
        onError={() => {}}
        width="700px"
        height="400px"/>
    );
  }
}

export default GclForm;
