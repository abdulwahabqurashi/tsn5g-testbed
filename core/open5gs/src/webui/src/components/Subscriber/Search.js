import PropTypes from 'prop-types';

import styled from 'styled-components';
import oc from 'open-color';
import { media } from 'helpers/style-utils';

import SearchIcon from 'react-icons/lib/md/search';
import ClearIcon from 'react-icons/lib/md/clear';

const Wrapper = styled.div`
  display: flex;
  align-items: center;

  width: 700px;
  margin: 2rem auto 1rem auto;

  background: var(--bg-card, white);
  color: var(--text-secondary, ${'var(--text-secondary)'});
  box-shadow: var(--card-shadow);
  transition: all 0.3s cubic-bezier(.25,.8,.25,1);
      
  &:hover {
    box-shadow: 0 10px 20px rgba(0,0,0,0.19), 0 6px 6px rgba(0,0,0,0.23);
  }

  ${media.tablet`
    width: 400px;
  `}

  ${media.mobile`
    margin: 0rem auto;
    width: 100%;
  `}
`;

const SearchIconWrapper = styled.div`
  display: inline-flex;
  margin-left: 1rem;
  font-size: 1.5rem;
`

const Input = styled.input`
  padding : 1rem;
  margin: 0 auto;
  width: 100%;

  font-size: 1.5rem;

  cursor: text;

  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary, inherit);
`
const ClearIconWrapper = styled.div`
  display: inline-flex;
  margin-right: 1rem;
  font-size: 1.5rem;

  cursor: pointer;
`

const FilterBadge = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  color: white;
  background: ${'var(--accent)'};
  margin-right: 0.5rem;
`

const Search = ({ value, onChange, onClear, filterCount }) => (
  <Wrapper>
    <SearchIconWrapper><SearchIcon/></SearchIconWrapper>
    <Input
      value={value}
      onChange={onChange}
      placeholder="Search by IMSI or MSISDN..."/>
    {filterCount > 0 && <FilterBadge>{filterCount}</FilterBadge>}
    {value !== '' &&
      <ClearIconWrapper onClick={onClear}>
        <ClearIcon/>
      </ClearIconWrapper>
    }
  </Wrapper>

)

Search.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func,
  onClear: PropTypes.func,
  filterCount: PropTypes.number
};

export default Search;