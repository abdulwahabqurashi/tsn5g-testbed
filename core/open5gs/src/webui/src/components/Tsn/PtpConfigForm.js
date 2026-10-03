import { Component } from 'react';
import PropTypes from 'prop-types';

import { Form } from 'components';
import { tsnApi } from 'helpers/tsn-api';

var baseSchema = {
  "title": "PTP Clock Sync Configuration",
  "type": "object",
  "properties": {
    "profile": {
      "type": "string",
      "title": "PTP Profile*",
      "enum": ["802.1AS", "1588v2-L2", "1588v2"],
      "enumNames": ["802.1AS (gPTP)", "IEEE 1588v2 (L2)", "IEEE 1588v2 (UDP)"],
      "default": "802.1AS"
    },
    "interface": {
      "type": "string",
      "title": "Network Interface*"
    },
    "domainNumber": {
      "type": "number",
      "title": "Domain Number",
      "default": 0,
      "minimum": 0,
      "maximum": 127
    },
    "priority1": {
      "type": "number",
      "title": "Priority1 (255 = never become GM)",
      "default": 255,
      "minimum": 0,
      "maximum": 255
    },
    "timeStamping": {
      "type": "string",
      "title": "Timestamping Mode",
      "enum": ["hardware", "software"],
      "enumNames": ["Hardware", "Software"],
      "default": "hardware"
    }
  },
  "required": ["profile", "interface"]
};

var uiSchema = {
  "profile": {
    classNames: "col-xs-12"
  },
  "interface": {
    classNames: "col-xs-12"
  },
  "domainNumber": {
    classNames: "col-xs-6"
  },
  "priority1": {
    classNames: "col-xs-6"
  },
  "timeStamping": {
    classNames: "col-xs-12"
  }
};

class PtpConfigForm extends Component {
  static propTypes = {
    visible: PropTypes.bool,
    formData: PropTypes.object,
    onHide: PropTypes.func,
    onSuccess: PropTypes.func
  }

  state = {
    isLoading: false,
    schema: JSON.parse(JSON.stringify(baseSchema))
  }

  componentDidMount() {
    this.fetchInterfaces();
  }

  fetchInterfaces() {
    tsnApi('get', '/api/ptp/interfaces')
      .then(function(response) {
        var ifaces = response.data;
        if (Array.isArray(ifaces) && ifaces.length > 0) {
          var enumValues = [];
          var enumNames = [];

          ifaces.forEach(function(iface) {
            enumValues.push(iface.name);
            var label = iface.name;
            var details = [];
            if (iface.mac) details.push(iface.mac);
            if (iface.hwTimestamp) details.push('HW');
            else details.push('SW only');
            label += ' (' + details.join(', ') + ')';
            enumNames.push(label);
          });

          this.setState(function(prevState) {
            var newSchema = JSON.parse(JSON.stringify(prevState.schema));
            newSchema.properties.interface['enum'] = enumValues;
            newSchema.properties.interface['enumNames'] = enumNames;
            return { schema: newSchema };
          });
        }
      }.bind(this))
      .catch(function() {
        /* Keep text input fallback if API unreachable */
      });
  }

  handleSubmit = (formData) => {
    this.setState({ isLoading: true });

    tsnApi('post', '/api/ptp/config', formData)
      .then(() => {
        this.setState({ isLoading: false });
        if (this.props.onSuccess) this.props.onSuccess(formData);
        if (this.props.onHide) this.props.onHide();
      })
      .catch(() => {
        this.setState({ isLoading: false });
      });
  }

  render() {
    var defaultData = {
      profile: '802.1AS',
      domainNumber: 0,
      priority1: 255,
      timeStamping: 'hardware'
    };

    var formData = this.props.formData
      ? Object.assign({}, defaultData, this.props.formData)
      : defaultData;

    return (
      <Form
        visible={this.props.visible}
        title="PTP Clock Sync Configuration"
        schema={this.state.schema}
        uiSchema={uiSchema}
        formData={formData}
        isLoading={this.state.isLoading}
        onHide={this.props.onHide}
        onSubmit={this.handleSubmit}
        onError={function() {}}
        width="600px"
        height="450px"/>
    );
  }
}

export default PtpConfigForm;
