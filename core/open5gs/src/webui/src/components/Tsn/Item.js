import { Component } from 'react';
import PropTypes from 'prop-types';

import styled from 'styled-components';
import oc from 'open-color';
import { media } from 'helpers/style-utils';

import EditIcon from 'react-icons/lib/md/edit';
import DeleteIcon from 'react-icons/lib/md/delete';

import { Tooltip, Spinner } from 'components';

const Sizer = styled.div`
  display: inline-block;
  width: 33.3%;
  padding: 0.5rem;

  ${p => p.disabled && 'opacity: 0.5; cursor: not-allowed;'};

  ${media.desktop`
    width: 50%;
  `}

  ${media.tablet`
    width: 100%;
  `}
`;

const Card = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;

  background: var(--bg-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);

  transition: all 0.3s cubic-bezier(.25,.8,.25,1);
  cursor: pointer;

  ${p => p.disabled && 'pointer-events: none;'}

  .actions {
    position: absolute;
    top: 0;
    right: 0;
    width: 6rem;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;

    opacity: 0;
  }

  &:hover {
    box-shadow: 0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23);

    .actions {
      ${p => p.disabled ? 'opacity: 0;' : 'opacity: 1;'};
    }
  }
`;

const CircleButton = styled.div`
  height: 2rem;
  width: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 1px;

  background: var(--bg-card);
  color: ${'var(--text-secondary)'};

  border-radius: 1rem;
  font-size: 1.5rem;

  &:hover {
    color: ${'var(--accent)'};
  }

  &.delete {
    &:hover {
      color: ${oc.pink[6]};
    }
  }
`

const BridgeId = styled.div`
  padding-left: 1rem;
  padding-top: 0.5rem;
  color: ${'var(--text-primary)'};
  font-size: 1.25rem;
  line-height: 2rem;
`;

const BridgeInfo = styled.div`
  padding-left: 1rem;
  padding-bottom: 0.5rem;
  color: ${'var(--text-muted)'};
  font-size: 0.85rem;
  line-height: 1.5rem;
`;

const SpinnerWrapper = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  width: 4rem;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
`

class Item extends Component {
  static propTypes = {
    bridge: PropTypes.shape({
      bridgeId: PropTypes.string
    }),
    onView: PropTypes.func,
    onEdit: PropTypes.func,
    onDelete: PropTypes.func
  }

  handleEdit = e => {
    e.stopPropagation();
    const { bridge, onEdit } = this.props;
    onEdit(bridge.bridgeId);
  }

  handleDelete = e => {
    e.stopPropagation();
    const { bridge, onDelete } = this.props;
    onDelete(bridge.bridgeId);
  }

  render() {
    const { handleEdit, handleDelete } = this;
    const { disabled, bridge, onView } = this.props;
    const { bridgeId, bridgeMac, portCount } = bridge;

    return (
      <Sizer disabled={disabled}>
        <Card disabled={disabled} onClick={() => onView(bridgeId)}>
          <BridgeId>{bridgeId}</BridgeId>
          <BridgeInfo>
            MAC: {bridgeMac || '00:00:00:00:00:00'}
            &nbsp;&nbsp;&nbsp;Ports: {portCount || 0}
          </BridgeInfo>
          <div className="actions">
            <Tooltip content='Edit' width="60px">
              <CircleButton onClick={handleEdit}><EditIcon/></CircleButton>
            </Tooltip>
            <Tooltip content='Delete' width="60px">
              <CircleButton className="delete" onClick={handleDelete}><DeleteIcon/></CircleButton>
            </Tooltip>
          </div>
          {disabled && <SpinnerWrapper><Spinner sm/></SpinnerWrapper>}
        </Card>
      </Sizer>
    )
  }
}

export default Item;
