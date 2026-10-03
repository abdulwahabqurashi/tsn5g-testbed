import axios from 'axios';
import { takeLatest, put, call } from 'redux-saga/effects';
import Session from 'modules/auth/session';

const UE_ANALYTICS_FETCH_REQUEST = 'ue-analytics/FETCH_REQUEST';
const UE_ANALYTICS_FETCH_SUCCESS = 'ue-analytics/FETCH_SUCCESS';
const UE_ANALYTICS_FETCH_FAILURE = 'ue-analytics/FETCH_FAILURE';

export const fetchUeAnalytics = () => ({
  type: UE_ANALYTICS_FETCH_REQUEST
});

const initialState = {
  data: null,
  isLoading: false,
  error: null,
  lastUpdated: null
};

export default function reducer(state = initialState, action = {}) {
  switch (action.type) {
    case UE_ANALYTICS_FETCH_REQUEST:
      return { ...state, isLoading: true, error: null };
    case UE_ANALYTICS_FETCH_SUCCESS:
      return {
        ...state,
        isLoading: false,
        data: action.payload,
        error: null,
        lastUpdated: Date.now()
      };
    case UE_ANALYTICS_FETCH_FAILURE:
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

  return Promise.all([
    axios({ baseURL: '/api/amf', headers: headers, method: 'get', url: '/UeInfo' }),
    axios({ baseURL: '/api/amf', headers: headers, method: 'get', url: '/GnbInfo' }),
    axios({ baseURL: '/api/amf', headers: headers, method: 'get', url: '/PduInfo' })
  ]).then(function(results) {
    return {
      data: {
        ues: results[0].data,
        gnbs: results[1].data,
        pdus: results[2].data
      }
    };
  });
}

function* handleFetch() {
  try {
    const response = yield call(fetchApi);
    yield put({ type: UE_ANALYTICS_FETCH_SUCCESS, payload: response.data });
  } catch (error) {
    yield put({ type: UE_ANALYTICS_FETCH_FAILURE, payload: error.message });
  }
}

export function* saga() {
  yield takeLatest(UE_ANALYTICS_FETCH_REQUEST, handleFetch);
}
