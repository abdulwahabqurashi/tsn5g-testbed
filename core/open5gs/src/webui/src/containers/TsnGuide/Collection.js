import { Component } from 'react';

import { Layout } from 'components';
import { Guide } from 'components/TsnGuide';

class Collection extends Component {
  render() {
    return (
      <Layout.Content>
        <Guide />
      </Layout.Content>
    );
  }
}

export default Collection;
