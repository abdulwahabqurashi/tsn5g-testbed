import PropTypes from 'prop-types';

import styled from 'styled-components';
import oc from 'open-color';
import { media, transitions } from 'helpers/style-utils';
import CSSTransitionGroup from 'react-transition-group/CSSTransitionGroup';

import { Layout, Blank } from 'components';
import Item from './Item';

const Wrapper = styled.div`
  display: block;
  margin: 1rem 0.5rem;

  ${media.mobile`
    margin: 0.5rem 0.25rem;
  `}

  .bridge-enter {
    animation: ${transitions.stretchOut} .3s ease-in;
    animation-fill-mode: forwards;
  }

  .bridge-leave {
    animation: ${transitions.shrinkIn} .15s ease-in;
    animation-fill-mode: forwards;
  }
`

const propTypes = {
  bridges: PropTypes.arrayOf(PropTypes.object),
  onView: PropTypes.func,
  onEdit: PropTypes.func,
  onDelete: PropTypes.func,
  search: PropTypes.string
}

const List = ({ bridges, deletedId, onView, onEdit, onDelete, search }) => {
  function pred(b) {
    if (!search) return true;
    if (b.bridgeId && b.bridgeId.indexOf(search) !== -1) return true;
    if (b.bridgeMac && b.bridgeMac.indexOf(search) !== -1) return true;
    return false;
  }

  const bridgeList = bridges
    .filter(pred)
    .sort((a, b) => {
      if (a.bridgeId > b.bridgeId) return 1;
      if (a.bridgeId < b.bridgeId) return -1;
      return 0;
    })
    .map(bridge =>
      <Item
        key={bridge.bridgeId}
        bridge={bridge}
        disabled={deletedId === bridge.bridgeId}
        onView={onView}
        onEdit={onEdit}
        onDelete={onDelete} />
    );

  return (
    <Wrapper>
      <CSSTransitionGroup
        transitionName="bridge"
        transitionEnterTimeout={300}
        transitionLeaveTimeout={150}>
        {bridgeList}
      </CSSTransitionGroup>
    </Wrapper>
  )
}

List.propTypes = propTypes;

export default List;
