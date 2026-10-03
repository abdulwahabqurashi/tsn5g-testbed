import { all, fork } from 'redux-saga/effects';
import crud from './crud/sagas';
import { saga as tsnAnalyticsSaga } from './tsn-analytics';
import { saga as nwttPerformanceSaga } from './nwtt-performance';
import { saga as tsnTopologySaga } from './tsn-topology';
import { saga as tsnSessionsSaga } from './tsn-sessions';
import { saga as ueAnalyticsSaga } from './ue-analytics';
import { saga as uePerformanceSaga } from './ue-performance';
import { saga as dashboardSaga } from './dashboard';
import { saga as logViewerSaga } from './log-viewer';
import { saga as alertsSaga } from './alerts';

export default function* rootSaga() {
  yield all([
    fork(crud),
    fork(tsnAnalyticsSaga),
    fork(nwttPerformanceSaga),
    fork(tsnTopologySaga),
    fork(tsnSessionsSaga),
    fork(ueAnalyticsSaga),
    fork(uePerformanceSaga),
    fork(dashboardSaga),
    fork(logViewerSaga),
    fork(alertsSaga)
  ])
}
