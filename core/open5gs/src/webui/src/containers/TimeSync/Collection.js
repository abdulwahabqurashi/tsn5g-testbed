import { Component } from 'react';
import styled from 'styled-components';
import oc from 'open-color';

import { Layout, Tsn } from 'components';

const PageTitle = styled.div`
  font-size: 20px;
  font-weight: 700;
  color: ${'var(--text-primary)'};
`;

const PageSubtitle = styled.div`
  font-size: 12px;
  color: ${'var(--text-muted)'};
  margin: 2px 0 14px 0;
`;

/*
 * Time Synchronization (3GPP TS 23.501 §5.27.1): the 5G system relays
 * (g)PTP between the TSN grandmaster and the device side, acting as a
 * time-aware system. This page controls ptp4l/phc2sys on the NW-TT side.
 */
class Collection extends Component {
  render() {
    return (
      <Layout.Content>
        <PageTitle>Time Synchronization</PageTitle>
        <PageSubtitle>
          3GPP TS 23.501 §5.27.1 — IEEE 802.1AS / 1588 clock distribution
          through the 5G system (NW-TT side)
        </PageSubtitle>
        <Tsn.PtpCard />
      </Layout.Content>
    );
  }
}

export default Collection;
