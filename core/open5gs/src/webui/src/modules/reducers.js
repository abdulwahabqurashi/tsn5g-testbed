import { combineReducers } from 'redux';

import crud from './crud/reducers';
import sidebar from './sidebar';
import notifications from './notification/reducers';
import tsnAnalytics from './tsn-analytics';
import nwttPerformance from './nwtt-performance';
import tsnTopology from './tsn-topology';
import tsnSessions from './tsn-sessions';
import ueAnalytics from './ue-analytics';
import uePerformance from './ue-performance';
import dashboard from './dashboard';
import logViewer from './log-viewer';
import theme from './theme';
import alerts from './alerts';

export default combineReducers({
  crud,
  sidebar,
  notifications,
  tsnAnalytics,
  nwttPerformance,
  tsnTopology,
  tsnSessions,
  ueAnalytics,
  uePerformance,
  dashboard,
  logViewer,
  theme,
  alerts
});
