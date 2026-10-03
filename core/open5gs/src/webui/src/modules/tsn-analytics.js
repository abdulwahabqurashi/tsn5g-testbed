import axios from 'axios';
import { takeLatest, put, call, fork } from 'redux-saga/effects';
import Session from 'modules/auth/session';

// Action types
const TSN_ANALYTICS_FETCH_REQUEST = 'tsn-analytics/FETCH_REQUEST';
const TSN_ANALYTICS_FETCH_SUCCESS = 'tsn-analytics/FETCH_SUCCESS';
const TSN_ANALYTICS_FETCH_FAILURE = 'tsn-analytics/FETCH_FAILURE';

// Action creators
export const fetchAnalytics = () => ({
  type: TSN_ANALYTICS_FETCH_REQUEST
});

// Initial state
const initialState = {
  data: null,
  isLoading: false,
  error: null,
  lastUpdated: null
};

// Reducer
export default function reducer(state = initialState, action = {}) {
  switch (action.type) {
    case TSN_ANALYTICS_FETCH_REQUEST:
      return {
        ...state,
        isLoading: true,
        error: null
      };
    case TSN_ANALYTICS_FETCH_SUCCESS:
      return {
        ...state,
        isLoading: false,
        data: action.payload,
        error: null,
        lastUpdated: Date.now()
      };
    case TSN_ANALYTICS_FETCH_FAILURE:
      return {
        ...state,
        isLoading: false,
        error: action.payload
      };
    default:
      return state;
  }
}

// API call
function fetchAnalyticsApi() {
  const sessionData = new Session();
  const csrf = ((sessionData || {}).session || {}).csrfToken;
  const authToken = ((sessionData || {}).session || {}).authToken;

  let headers = { 'X-CSRF-TOKEN': csrf };
  if (authToken) {
    headers['Authorization'] = 'Bearer ' + authToken;
  }

  return axios({
    baseURL: '/api/tsn',
    headers: headers,
    method: 'get',
    url: '/Analytics'
  });
}

// Saga
function* handleFetchAnalytics() {
  try {
    const response = yield call(fetchAnalyticsApi);
    yield put({ type: TSN_ANALYTICS_FETCH_SUCCESS, payload: response.data });
  } catch (error) {
    yield put({ type: TSN_ANALYTICS_FETCH_FAILURE, payload: error.message });
  }
}

export function* saga() {
  yield takeLatest(TSN_ANALYTICS_FETCH_REQUEST, handleFetchAnalytics);
}
