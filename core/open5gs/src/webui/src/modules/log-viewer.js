import axios from 'axios';
import { takeLatest, put, call } from 'redux-saga/effects';
import Session from 'modules/auth/session';

const LOG_FETCH_LIST_REQUEST = 'log-viewer/FETCH_LIST_REQUEST';
const LOG_FETCH_LIST_SUCCESS = 'log-viewer/FETCH_LIST_SUCCESS';
const LOG_FETCH_REQUEST = 'log-viewer/FETCH_REQUEST';
const LOG_FETCH_SUCCESS = 'log-viewer/FETCH_SUCCESS';
const LOG_FETCH_FAILURE = 'log-viewer/FETCH_FAILURE';
const LOG_SET_SERVICE = 'log-viewer/SET_SERVICE';

export const fetchLogList = () => ({ type: LOG_FETCH_LIST_REQUEST });
export const fetchLogs = () => ({ type: LOG_FETCH_REQUEST });
export const setService = (service) => ({ type: LOG_SET_SERVICE, payload: service });

const initialState = {
  logs: [],
  services: [],
  selectedService: 'amf',
  isLoading: false,
  error: null,
  lastUpdated: null
};

export default function reducer(state = initialState, action = {}) {
  switch (action.type) {
    case LOG_FETCH_LIST_SUCCESS:
      return { ...state, services: action.payload };
    case LOG_FETCH_REQUEST:
      return { ...state, isLoading: true, error: null };
    case LOG_FETCH_SUCCESS:
      return {
        ...state,
        isLoading: false,
        logs: action.payload,
        error: null,
        lastUpdated: Date.now()
      };
    case LOG_FETCH_FAILURE:
      return { ...state, isLoading: false, error: action.payload };
    case LOG_SET_SERVICE:
      return { ...state, selectedService: action.payload, logs: [] };
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

function fetchListApi() {
  return axios({
    baseURL: '/api/logs',
    headers: getHeaders(),
    method: 'get',
    url: '/list'
  });
}

function fetchLogApi(service) {
  return axios({
    baseURL: '/api/logs',
    headers: getHeaders(),
    method: 'get',
    url: '/' + service,
    params: { lines: 300 }
  });
}

function* handleFetchList() {
  try {
    const response = yield call(fetchListApi);
    yield put({ type: LOG_FETCH_LIST_SUCCESS, payload: response.data });
  } catch (error) {
    // Silently handle - services list is optional
  }
}

function* handleFetchLogs(action) {
  try {
    // Get current service from action or default
    const service = (action && action.payload) || 'amf';
    const response = yield call(fetchLogApi, service);
    yield put({ type: LOG_FETCH_SUCCESS, payload: response.data });
  } catch (error) {
    yield put({ type: LOG_FETCH_FAILURE, payload: error.message });
  }
}

export function* saga() {
  yield takeLatest(LOG_FETCH_LIST_REQUEST, handleFetchList);
  yield takeLatest(LOG_FETCH_REQUEST, handleFetchLogs);
}
