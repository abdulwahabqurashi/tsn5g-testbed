import { Component } from 'react';
import PropTypes from 'prop-types';

import { Form } from 'components';
import { tsnApi } from 'helpers/tsn-api';

const schema = {
  "title": "TSC Assistance Configuration",
  "type": "object",
  "properties": {
    "burstArrivalTimeNs": {
      "type": "number",
      "title": "Burst Arrival Time (ns)"
    },
    "periodicityUs": {
      "type": "number",
      "title": "Periodicity (us)"
    },
    "survivalTimeUs": {
      "type": "number",
      "title": "Survival Time (us)"
    }
  }
};

const uiSchema = {
  "burstArrivalTimeNs": {
    classNames: "col-xs-12"
  },
  "periodicityUs": {
    classNames: "col-xs-12"
  },
  "survivalTimeUs": {
    classNames: "col-xs-12"
  }
};

class TscForm extends Component {
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

    tsnApi('post', '/api/tsn/Bridge/' + bridgeId + '/tsc-assistance', formData)
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
        title="TSC Assistance Configuration"
        schema={schema}
        uiSchema={uiSchema}
        formData={this.props.formData || {}}
        isLoading={this.state.isLoading}
        onHide={this.props.onHide}
        onSubmit={this.handleSubmit}
        onError={() => {}}
        width="600px"
        height="300px"/>
    );
  }
}

export default TscForm;
