import { Component } from 'react';
import PropTypes from 'prop-types';

import { Form } from 'components';
import { tsnApi } from 'helpers/tsn-api';

const schema = {
  "title": "Stream Filters (802.1Qci PSFP)",
  "type": "object",
  "properties": {
    "streamFilters": {
      "type": "array",
      "title": "Stream Filters",
      "items": {
        "type": "object",
        "properties": {
          "instanceId": {
            "type": "number",
            "title": "Instance ID"
          },
          "destMac": {
            "type": "string",
            "title": "Destination MAC",
            "pattern": "^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$",
            "messages": {
              "pattern": "MAC address format: aa:bb:cc:dd:ee:ff"
            }
          },
          "vlanId": {
            "type": "number",
            "title": "VLAN ID",
            "minimum": 0,
            "maximum": 4095
          },
          "priority": {
            "type": "number",
            "title": "Priority (-1 = any)",
            "minimum": -1,
            "maximum": 7
          },
          "streamGateInstanceId": {
            "type": "number",
            "title": "Stream Gate Instance ID"
          }
        },
        "required": ["instanceId", "destMac"]
      }
    }
  }
};

const uiSchema = {
  "streamFilters": {
    classNames: "col-xs-12"
  }
};

class PsfpForm extends Component {
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

    tsnApi('post', '/api/tsn/Bridge/' + bridgeId + '/Port/' + portNumber + '/psfp', formData)
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
        title={'PSFP - Port ' + this.props.portNumber}
        schema={schema}
        uiSchema={uiSchema}
        formData={{streamFilters: []}}
        isLoading={this.state.isLoading}
        onHide={this.props.onHide}
        onSubmit={this.handleSubmit}
        onError={() => {}}
        width="700px"
        height="400px"/>
    );
  }
}

export default PsfpForm;
