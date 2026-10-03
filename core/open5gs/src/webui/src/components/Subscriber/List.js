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

  .subscriber-enter {
    animation: ${transitions.stretchOut} .3s ease-in;
    animation-fill-mode: forwards;
  }   
    
  .subscriber-leave { 
    animation: ${transitions.shrinkIn} .15s ease-in;
    animation-fill-mode: forwards;
  }   
`

const propTypes = {
  subscribers: PropTypes.arrayOf(PropTypes.object),
  onView: PropTypes.func,
  onEdit: PropTypes.func,
  onDelete: PropTypes.func,
  search: PropTypes.string,
  filters: PropTypes.object
}

const List = ({ subscribers, deletedImsi, onView, onEdit, onDelete, search, filters }) => {
  function pred(s) {
    // Text search on IMSI/MSISDN
    if (search && search.length > 0) {
      var textMatch = (s.msisdn && s.msisdn[0] && s.msisdn[0].indexOf(search) !== -1) ||
        (s.msisdn && s.msisdn[1] && s.msisdn[1].indexOf(search) !== -1) ||
        (s.imsi.indexOf(search) !== -1);
      if (!textMatch) return false;
    }

    // PDU Type filter
    if (filters && filters.pduTypes && filters.pduTypes.length > 0) {
      var hasPduType = false;
      (s.slice || []).forEach(function(sl) {
        (sl.session || []).forEach(function(sess) {
          if (filters.pduTypes.indexOf(sess.type) !== -1) hasPduType = true;
        });
      });
      if (!hasPduType) return false;
    }

    // SST filter
    if (filters && filters.sst != null) {
      var hasSst = false;
      (s.slice || []).forEach(function(sl) {
        if (sl.sst === filters.sst) hasSst = true;
      });
      if (!hasSst) return false;
    }

    return true;
  }

  // Sorting
  var sortFn;
  if (filters && filters.sortBy === 'sessions') {
    sortFn = function(a, b) {
      var aCount = 0, bCount = 0;
      (a.slice || []).forEach(function(sl) { aCount += (sl.session || []).length; });
      (b.slice || []).forEach(function(sl) { bCount += (sl.session || []).length; });
      return bCount - aCount;
    };
  } else {
    sortFn = function(a, b) {
      if (a.imsi > b.imsi) return 1;
      if (a.imsi < b.imsi) return -1;
      return 0;
    };
  }

  const subscriberList = subscribers
    .filter(pred)
    .sort(sortFn)
    .map(subscriber =>
      <Item
        key={subscriber.imsi}
        subscriber={subscriber}
        disabled={deletedImsi === subscriber.imsi}
        onView={onView}
        onEdit={onEdit}
        onDelete={onDelete} />
    );

  return (
    <Wrapper>
      <CSSTransitionGroup
        transitionName="subscriber"
        transitionEnterTimeout={300}
        transitionLeaveTimeout={150}>
        {subscriberList}
      </CSSTransitionGroup>
    </Wrapper>
  )
}

List.propTypes = propTypes;

export default List;