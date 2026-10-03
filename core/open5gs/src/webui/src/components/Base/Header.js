import PropTypes from 'prop-types';

import styled from 'styled-components';

import { Tooltip } from 'components';
import SiteSwitcher from './SiteSwitcher';
import PersonIcon from 'react-icons/lib/io/ios-contact';
import BrightnessHighIcon from 'react-icons/lib/io/ios-sunny-outline';
import BrightnessLowIcon from 'react-icons/lib/io/contrast';
import AppIcon from 'react-icons/lib/io/record';

/* UniFi Network top bar: light gray strip, site chip at left,
 * active app tab in white with blue label, faint center wordmark. */
const Wrapper = styled.div`
  display: flex;
  align-items: stretch;
  height: 48px;
  position: relative;

  color: var(--text-primary);
  background: var(--bg-topbar);
  border-bottom: 1px solid var(--divider);
`;

const SiteChip = styled.div`
  display: flex;
  align-items: center;
  padding: 0 14px 0 10px;
  border-right: 1px solid var(--divider);
  cursor: default;

  .chip-square {
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    background: #0a2540;
    border-radius: 7px;
    color: #ffffff;
    font-size: 13px;
    font-weight: 800;
  }
  .chip-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--ok); margin-left: 8px;
  }
  .chip-label {
    margin-left: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .chip-chevron {
    margin-left: 8px;
    font-size: 10px;
    color: var(--text-muted);
  }
`;

/* active application tab, like UniFi's "Network" */
const AppTab = styled.div`
  display: flex;
  align-items: center;
  padding: 0 16px;
  background: #ffffff;
  border-right: 1px solid var(--divider);

  font-size: 13px;
  font-weight: 600;
  color: var(--accent);

  .app-ic {
    display: inline-flex;
    font-size: 15px;
    margin-right: 7px;
    color: var(--accent);
  }
`;

const Wordmark = styled.div`
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);

  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #c9ccd1;
  pointer-events: none;
`;

const Right = styled.div`
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 12px;
`;

const IconButton = styled.div`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;

  cursor: pointer;
  font-size: 17px;
  color: var(--text-secondary);
  &:hover { color: var(--text-primary); background: rgba(16,24,40,0.06); }
`;

const Avatar = styled.div`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;

  cursor: pointer;
  font-size: 19px;
  color: #ffffff;
  background: linear-gradient(135deg, #478ff7, #9e7be0);
`;

const propTypes = {
  onSidebarToggle: PropTypes.func.isRequired,
  onLogoutRequest: PropTypes.func.isRequired,
  isDarkMode: PropTypes.bool,
  onThemeToggle: PropTypes.func
}

const Header = ({ onSidebarToggle, onLogoutRequest, isDarkMode, onThemeToggle }) => (
  <Wrapper>
    <SiteSwitcher/>
    <AppTab>
      <span className="app-ic"><AppIcon/></span>
      5G-TSN
    </AppTab>
    <Wordmark>AMRC</Wordmark>
    <Right>
      {onThemeToggle &&
        <IconButton onClick={onThemeToggle}>
          <Tooltip bottom content={isDarkMode ? 'Light' : 'Dark'} width="50px">
            {isDarkMode ? <BrightnessHighIcon/> : <BrightnessLowIcon/>}
          </Tooltip>
        </IconButton>
      }
      <Avatar onClick={onLogoutRequest}>
        <Tooltip bottom content='Logout' width="60px">
          <PersonIcon/>
        </Tooltip>
      </Avatar>
    </Right>
  </Wrapper>
)

Header.propTypes = propTypes;

export default Header;
