import axios from 'axios';
import { takeLatest, put, call, all } from 'redux-saga/effects';
import Session from 'modules/auth/session';

const TSN_TOPOLOGY_FETCH_REQUEST = 'tsn-topology/FETCH_REQUEST';
const TSN_TOPOLOGY_FETCH_SUCCESS = 'tsn-topology/FETCH_SUCCESS';
const TSN_TOPOLOGY_FETCH_FAILURE = 'tsn-topology/FETCH_FAILURE';

export const fetchTsnTopology = () => ({
  type: TSN_TOPOLOGY_FETCH_REQUEST
});

const initialState = {
  data: null,
  isLoading: false,
  error: null,
  lastUpdated: null
};

export default function reducer(state = initialState, action = {}) {
  switch (action.type) {
    case TSN_TOPOLOGY_FETCH_REQUEST:
      return { ...state, isLoading: true, error: null };
    case TSN_TOPOLOGY_FETCH_SUCCESS:
      return {
        ...state,
        isLoading: false,
        data: action.payload,
        error: null,
        lastUpdated: Date.now()
      };
    case TSN_TOPOLOGY_FETCH_FAILURE:
      return { ...state, isLoading: false, error: action.payload };
    default:
      return state;
  }
}

function getHeaders() {
  const sessionData = new Session();
  const csrf = ((sessionData || {}).session || {}).csrfToken;
  const authToken = ((sessionData || {}).session || {}).authToken;

  let headers = { 'X-CSRF-TOKEN': csrf };
  if (authToken) {
    headers['Authorization'] = 'Bearer ' + authToken;
  }
  return headers;
}

function fetchUpfTsnInfo() {
  return axios({
    baseURL: '/api/upf',
    headers: getHeaders(),
    method: 'get',
    url: '/TsnInfo'
  });
}

function fetchTsnAfAnalytics() {
  return axios({
    baseURL: '/api/tsn',
    headers: getHeaders(),
    method: 'get',
    url: '/Analytics'
  });
}

function* handleFetch() {
  try {
    // Fetch both data sources in parallel
    const [upfResponse, tsnAfResponse] = yield all([
      call(fetchUpfTsnInfo),
      call(fetchTsnAfAnalytics)
    ]);

    yield put({
      type: TSN_TOPOLOGY_FETCH_SUCCESS,
      payload: {
        upf: upfResponse.data,
        tsnAf: tsnAfResponse.data
      }
    });
  } catch (error) {
    // If one fails, try to return partial data
    try {
      const upfResponse = yield call(fetchUpfTsnInfo);
      yield put({
        type: TSN_TOPOLOGY_FETCH_SUCCESS,
        payload: { upf: upfResponse.data, tsnAf: null }
      });
    } catch (e) {
      yield put({ type: TSN_TOPOLOGY_FETCH_FAILURE, payload: error.message });
    }
  }
}

export function* saga() {
  yield takeLatest(TSN_TOPOLOGY_FETCH_REQUEST, handleFetch);
}
