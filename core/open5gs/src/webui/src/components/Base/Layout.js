import PropTypes from 'prop-types';
import Head from 'next/head';

import styled from 'styled-components';

import Header from 'containers/Header';
import Sidebar from 'containers/Sidebar';

import Package from '../../../package';

const Body = styled.div`
  display: flex;
  height: calc(100vh - 48px);
  position: relative;
  background: #ffffff;
`

const propTypes = {
  title: PropTypes.string
}

const defaultProps = {
  title: `AMRC ${Package.version}`
}

const Layout = ({ title, children }) => (
  <div>
    <Head>
      <title>{title}</title>
    </Head>
    <Header/>
    <Body>
      <Sidebar/>
      {children}
    </Body>
  </div>
)

Layout.propTypes = propTypes;
Layout.defaultProps = defaultProps;

const ContainerWrapper = styled.div`
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background: #ffffff;
`;

Layout.Container = ({visible, children}) => visible ? (
  <ContainerWrapper>
    {children}
  </ContainerWrapper>
) : null;

Layout.Content = styled.div`
  max-width: 1560px;
  margin: 0 auto;
  padding: 1.2rem 1.6rem 2.5rem;
`;

export default Layout;
