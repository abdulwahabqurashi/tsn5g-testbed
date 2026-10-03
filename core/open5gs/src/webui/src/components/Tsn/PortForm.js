import { Component } from 'react';
import PropTypes from 'prop-types';

import { Form } from 'components';
import { tsnApi } from 'helpers/tsn-api';

const schema = {
  "title": "Add Port",
  "type": "object",
  "properties": {
    "portNumber": {
      "type": "number",
      "title": "Port Number*"
    },
    "isNwtt": {
      "type": "boolean",
      "title": "Network-side TT (NW-TT)",
      "default": true
    },
    "macAddr": {
      "type": "string",
      "title": "MAC Address",
      "pattern": "^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$",
      "messages": {
        "pattern": "MAC address format: aa:bb:cc:dd:ee:ff"
      }
    }
  },
  "required": ["portNumber"]
};

const uiSchema = {
  "portNumber": {
    classNames: "col-xs-12"
  },
  "isNwtt": {
    classNames: "col-xs-12"
  },
  "macAddr": {
    classNames: "col-xs-12"
  }
};

class PortForm extends Component {
  static propTypes = {
    visible: PropTypes.bool,
    bridgeId: PropTypes.string,
    existingPorts: PropTypes.array,
    onHide: PropTypes.func,
    onSuccess: PropTypes.func
  }

  state = {
    isLoading: false
  }

  getNextPortNumber() {
    var existing = this.props.existingPorts || [];
    if (existing.length === 0) return 0;
    var maxPort = 0;
    existing.forEach(function(p) {
      var num = p.portNumber != null ? p.portNumber : 0;
      if (num > maxPort) maxPort = num;
    });
    return maxPort + 1;
  }

  handleSubmit = (formData) => {
    var bridgeId = this.props.bridgeId;
    var self = this;
    this.setState({ isLoading: true });

    tsnApi('post', '/api/tsn/Bridge/' + bridgeId + '/Port', formData)
      .then(() => {
        self.setState({ isLoading: false });
        if (self.props.onSuccess) self.props.onSuccess();
        if (self.props.onHide) self.props.onHide();
      })
      .catch((err) => {
        self.setState({ isLoading: false });
        var msg = 'Failed to add port';
        if (err.response && err.response.status === 409) {
          msg = 'Port ' + formData.portNumber + ' already exists on this bridge. Please use a different port number.';
        } else if (err.response && err.response.data && err.response.data.message) {
          msg = err.response.data.message;
        }
        alert(msg);
      });
  }

  validate = (formData, errors) => {
    var existing = this.props.existingPorts || [];
    var portNum = formData.portNumber;
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].portNumber === portNum) {
        errors.portNumber.addError('Port ' + portNum + ' already exists on this bridge');
        break;
      }
    }
    return errors;
  }

  render() {
    var nextPort = this.getNextPortNumber();

    return (
      <Form
        visible={this.props.visible}
        title="Add Port"
        schema={schema}
        uiSchema={uiSchema}
        formData={{isNwtt: true, portNumber: nextPort}}
        isLoading={this.state.isLoading}
        validate={this.validate}
        onHide={this.props.onHide}
        onSubmit={this.handleSubmit}
        onError={() => {}}
        width="600px"
        height="300px"/>
    );
  }
}

export default PortForm;
