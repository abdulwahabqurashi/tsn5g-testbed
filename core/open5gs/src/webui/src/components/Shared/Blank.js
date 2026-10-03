import PropTypes from 'prop-types';

import styled from 'styled-components';
import oc from 'open-color';

import { CircleIcon } from 'components';
import SchoolIcon from 'react-icons/lib/md/import-contacts'

const Wrapper = styled.div`
  position: relative;
  display: block;

  margin-top : 6rem;
`  

const StyledTitle = styled.div`
  display: block;
  margin-top: 2rem;
  text-align: center;
  font-size: 1rem;
  font-weight: bold;

  color: ${'var(--accent)'};
  cursor: pointer;
`;

const StyledBody = styled.div`
  display: block;
  margin-top: 2rem;
  text-align: center;
  font-size: 1rem;
  font-weight: 300;

  color: ${'var(--text-secondary)'};
  cursor: default;
`;

const Blank = ({visible, title, body, onTitle}) => visible ? (
  <Wrapper>
    <CircleIcon size="12rem" background={'var(--bg-hover)'} color={'var(--text-primary)'}>
      <SchoolIcon/>
    </CircleIcon>
    <StyledBody>{body}</StyledBody>
    <StyledTitle onClick={onTitle}>{title}</StyledTitle>
  </Wrapper>
) : null;

Blank.propTypes = {
  visible: PropTypes.bool,
  title: PropTypes.string,
  body: PropTypes.string,
  onTitle: PropTypes.func
};

Blank.defaultProps = {
  visible: false,
  title: "ADD A DATA",
  body: "You have no data... yet!"
};

export default Blank;