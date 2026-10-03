import { Component } from 'react';
import PropTypes from 'prop-types';

import withWidth, { SMALL } from 'helpers/with-width';
import { Form } from 'components';
import { tsnApi } from 'helpers/tsn-api';

const schema = {
  "title": "TSN Bridge Configuration",
  "type": "object",
  "properties": {
    "bridgeId": {
      "type": "string",
      "title": "Bridge ID*",
      "required": true
    },
    "bridgeMac": {
      "type": "string",
      "title": "Bridge MAC*",
      "required": true,
      "pattern": "^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$",
      "messages": {
        "pattern": "MAC address format: aa:bb:cc:dd:ee:ff"
      }
    },
    "dnn": {
      "type": "string",
      "title": "DNN"
    },
    "physicalInterface": {
      "type": "string",
      "title": "Physical Interface"
    },
    "upfTapDevice": {
      "type": "string",
      "title": "UPF TAP Device",
      "description": "UPF's TAP interface to attach to bridge (e.g., ogstap)"
    }
  },
  "required": ["bridgeId", "bridgeMac"]
};

const uiSchema = {
  "bridgeId": {
    classNames: "col-xs-12",
  },
  "bridgeMac": {
    classNames: "col-xs-12",
  },
  "dnn": {
    classNames: "col-xs-12",
  },
  "physicalInterface": {
    classNames: "col-xs-12",
  },
  "upfTapDevice": {
    classNames: "col-xs-12",
  }
}

class Edit extends Component {
  static propTypes = {
    visible: PropTypes.bool,
    action: PropTypes.string,
    formData: PropTypes.object,
    isLoading: PropTypes.bool,
    validate: PropTypes.func,
    onHide: PropTypes.func,
    onSubmit: PropTypes.func,
    onError: PropTypes.func
  }

  constructor(props) {
    super(props);
    this.state = this.getStateFromProps(props, null);
  }

  componentDidMount() {
    this.fetchInterfaces();
  }

  fetchInterfaces() {
    tsnApi('get', '/api/tsn/Interface')
      .then((response) => {
        var ifaces = response.data;
        if (Array.isArray(ifaces) && ifaces.length > 0) {
          var enumValues = [""];
          var enumNames = ["(none)"];

          ifaces.forEach(function(iface) {
            enumValues.push(iface.name);
            var label = iface.name;
            var details = [];
            if (iface.mac) details.push(iface.mac);
            if (iface.status) details.push(iface.status);
            if (iface.speed) details.push(iface.speed + "Mbps");
            if (details.length > 0) {
              label += " (" + details.join(", ") + ")";
            }
            enumNames.push(label);
          });

          this.setState(function(prevState) {
            var newSchema = JSON.parse(JSON.stringify(prevState.schema));
            newSchema.properties.physicalInterface["enum"] = enumValues;
            newSchema.properties.physicalInterface["enumNames"] = enumNames;
            return { schema: newSchema };
          });
        }
      })
      .catch(function() {
        /* TSN AF unreachable - keep text input fallback */
      });
  }

  componentWillReceiveProps(nextProps) {
    this.setState(this.getStateFromProps(nextProps, this.state));
  }

  getStateFromProps(props, prevState) {
    const { action, width, formData } = props;

    /* Preserve enum values fetched by fetchInterfaces() */
    let currentSchema = (prevState && prevState.schema) ? prevState.schema : schema;

    let state = {
      schema: currentSchema,
      uiSchema,
      formData,
    };

    if (action === 'update') {
      state.uiSchema = Object.assign({}, state.uiSchema, {
        "bridgeId": {
          ...state.uiSchema.bridgeId,
          "ui:disabled": true
        }
      });
    } else if (width !== SMALL) {
      state.uiSchema = Object.assign({}, state.uiSchema, {
        "bridgeId": {
          ...state.uiSchema.bridgeId,
          "ui:autofocus": true
        }
      });
    }

    return state;
  }

  render() {
    const {
      visible,
      action,
      isLoading,
      validate,
      onHide,
      onSubmit,
      onError
    } = this.props;

    const { formData } = this.state;

    return (
      <Form
        visible={isLoading ? false : visible}
        title={(action === 'update') ? 'Edit Bridge' : 'Create Bridge'}
        schema={this.state.schema}
        uiSchema={this.state.uiSchema}
        formData={formData}
        isLoading={isLoading}
        validate={validate}
        onHide={onHide}
        onSubmit={onSubmit}
        onError={onError}/>
    )
  }
}

export default withWidth()(Edit);
