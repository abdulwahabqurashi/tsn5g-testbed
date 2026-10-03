import { Component } from 'react';
import PropTypes from 'prop-types';

import { Form } from 'components';
import { tsnApi } from 'helpers/tsn-api';

const schema = {
  "title": "QoS Mapping (PCP to 5QI)",
  "type": "object",
  "properties": {
    "mappings": {
      "type": "array",
      "title": "Mappings",
      "items": {
        "type": "object",
        "properties": {
          "pcp": {
            "type": "number",
            "title": "PCP (0-7)",
            "minimum": 0,
            "maximum": 7
          },
          "fiveQi": {
            "type": "number",
            "title": "5QI",
            "minimum": 1,
            "maximum": 255
          }
        },
        "required": ["pcp", "fiveQi"]
      }
    }
  }
};

const uiSchema = {
  "mappings": {
    classNames: "col-xs-12"
  }
};

class QosForm extends Component {
  static propTypes = {
    visible: PropTypes.bool,
    bridgeId: PropTypes.string,
    formData: PropTypes.object,
    onHide: PropTypes.func,
    onSuccess: PropTypes.func
  }

  state = {
    isLoading: false
  }

  handleSubmit = (formData) => {
    var bridgeId = this.props.bridgeId;
    this.setState({ isLoading: true });

    tsnApi('post', '/api/tsn/Bridge/' + bridgeId + '/qos-mapping', formData)
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
        title="QoS Mapping (PCP to 5QI)"
        schema={schema}
        uiSchema={uiSchema}
        formData={this.props.formData || {mappings: []}}
        isLoading={this.state.isLoading}
        onHide={this.props.onHide}
        onSubmit={this.handleSubmit}
        onError={() => {}}
        width="700px"
        height="400px"/>
    );
  }
}

export default QosForm;
