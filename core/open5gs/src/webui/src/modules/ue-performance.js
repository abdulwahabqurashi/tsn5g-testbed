import axios from 'axios';
import { takeLatest, put, call } from 'redux-saga/effects';
import Session from 'modules/auth/session';

const FETCH_REQUEST = 'ue-performance/FETCH_REQUEST';
const FETCH_SUCCESS = 'ue-performance/FETCH_SUCCESS';
const FETCH_FAILURE = 'ue-performance/FETCH_FAILURE';

export const fetchUePerformance = (target) => ({ type: FETCH_REQUEST, target: target });

const initialState = { data: null, isLoading: false, error: null, lastUpdated: null };

export default function reducer(state = initialState, action = {}) {
  switch (action.type) {
    case FETCH_REQUEST:
      return { ...state, isLoading: true, error: null };
    case FETCH_SUCCESS:
      return { ...state, isLoading: false, data: action.payload, error: null, lastUpdated: Date.now() };
    case FETCH_FAILURE:
      return { ...state, isLoading: false, error: action.payload };
    default:
      return state;
  }
}

function authHeaders() {
  const sessionData = new Session();
  const csrf = ((sessionData || {}).session || {}).csrfToken;
  const authToken = ((sessionData || {}).session || {}).authToken;
  let headers = { 'X-CSRF-TOKEN': csrf };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  return headers;
}

function fetchApi(target) {
  const headers = authHeaders();
  const reqs = [
    axios({ baseURL: '/api/upf', headers, method: 'get', url: '/TsnInfo' }).catch(function() { return { data: null }; }),
    axios({ baseURL: '/api/amf', headers, method: 'get', url: '/PduInfo' }).catch(function() { return { data: null }; }),
    axios({ baseURL: '/api/amf', headers, method: 'get', url: '/UeInfo' }).catch(function() { return { data: null }; })
  ];
  if (target) {
    reqs.push(axios({ baseURL: '/api/ue', headers, method: 'get',
      url: '/Latency?target=' + encodeURIComponent(target) }).catch(function() { return { data: null }; }));
  }
  return Promise.all(reqs).then(function(rs) {
    return { data: {
      nwtt: rs[0].data,
      pdu: rs[1].data,
      ue: rs[2].data,
      latency: rs[3] ? rs[3].data : null,
      ts: Date.now()
    } };
  });
}

function* handleFetch(action) {
  try {
    const response = yield call(fetchApi, action.target);
    yield put({ type: FETCH_SUCCESS, payload: response.data });
  } catch (error) {
    yield put({ type: FETCH_FAILURE, payload: error.message });
  }
}

export function* saga() {
  yield takeLatest(FETCH_REQUEST, handleFetch);
}
