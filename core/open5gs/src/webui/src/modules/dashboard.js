import axios from 'axios';
import { takeLatest, put, call } from 'redux-saga/effects';
import Session from 'modules/auth/session';

const DASHBOARD_FETCH_REQUEST = 'dashboard/FETCH_REQUEST';
const DASHBOARD_FETCH_SUCCESS = 'dashboard/FETCH_SUCCESS';
const DASHBOARD_FETCH_FAILURE = 'dashboard/FETCH_FAILURE';

export const fetchDashboard = () => ({
  type: DASHBOARD_FETCH_REQUEST
});

const initialState = {
  data: null,
  isLoading: false,
  error: null,
  lastUpdated: null
};

export default function reducer(state = initialState, action = {}) {
  switch (action.type) {
    case DASHBOARD_FETCH_REQUEST:
      return { ...state, isLoading: true, error: null };
    case DASHBOARD_FETCH_SUCCESS:
      return {
        ...state,
        isLoading: false,
        data: action.payload,
        error: null,
        lastUpdated: Date.now()
      };
    case DASHBOARD_FETCH_FAILURE:
      return { ...state, isLoading: false, error: action.payload };
    default:
      return state;
  }
}

function fetchApi() {
  const sessionData = new Session();
  const csrf = ((sessionData || {}).session || {}).csrfToken;
  const authToken = ((sessionData || {}).session || {}).authToken;

  let headers = { 'X-CSRF-TOKEN': csrf };
  if (authToken) {
    headers['Authorization'] = 'Bearer ' + authToken;
  }

  // Fetch all 4 sources in parallel; tolerate individual failures
  return Promise.all([
    axios({ baseURL: '/api/upf', headers: headers, method: 'get', url: '/TsnInfo' }).catch(function() { return { data: null }; }),
    axios({ baseURL: '/api/tsn', headers: headers, method: 'get', url: '/Analytics' }).catch(function() { return { data: null }; }),
    axios({ baseURL: '/api/amf', headers: headers, method: 'get', url: '/UeInfo' }).catch(function() { return { data: null }; }),
    axios({ baseURL: '/api/amf', headers: headers, method: 'get', url: '/GnbInfo' }).catch(function() { return { data: null }; }),
    axios({ baseURL: '/api/amf', headers: headers, method: 'get', url: '/PduInfo' }).catch(function() { return { data: null }; })
  ]).then(function(results) {
    return {
      data: {
        nwtt: results[0].data,
        tsn: results[1].data,
        ues: results[2].data,
        gnbs: results[3].data,
        pdus: results[4].data
      }
    };
  });
}

function* handleFetch() {
  try {
    const response = yield call(fetchApi);
    yield put({ type: DASHBOARD_FETCH_SUCCESS, payload: response.data });
  } catch (error) {
    yield put({ type: DASHBOARD_FETCH_FAILURE, payload: error.message });
  }
}

export function* saga() {
  yield takeLatest(DASHBOARD_FETCH_REQUEST, handleFetch);
}
