import axios from 'axios';
import { takeLatest, put, call } from 'redux-saga/effects';
import Session from 'modules/auth/session';

const TSN_SESSIONS_FETCH_REQUEST = 'tsn-sessions/FETCH_REQUEST';
const TSN_SESSIONS_FETCH_SUCCESS = 'tsn-sessions/FETCH_SUCCESS';
const TSN_SESSIONS_FETCH_FAILURE = 'tsn-sessions/FETCH_FAILURE';

export const fetchTsnSessions = () => ({
  type: TSN_SESSIONS_FETCH_REQUEST
});

const initialState = {
  data: null,
  isLoading: false,
  error: null,
  lastUpdated: null
};

export default function reducer(state = initialState, action = {}) {
  switch (action.type) {
    case TSN_SESSIONS_FETCH_REQUEST:
      return { ...state, isLoading: true, error: null };
    case TSN_SESSIONS_FETCH_SUCCESS:
      return {
        ...state,
        isLoading: false,
        data: action.payload,
        error: null,
        lastUpdated: Date.now()
      };
    case TSN_SESSIONS_FETCH_FAILURE:
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

  return axios({
    baseURL: '/api/upf',
    headers: headers,
    method: 'get',
    url: '/TsnInfo'
  });
}

function* handleFetch() {
  try {
    const response = yield call(fetchApi);
    yield put({ type: TSN_SESSIONS_FETCH_SUCCESS, payload: response.data });
  } catch (error) {
    yield put({ type: TSN_SESSIONS_FETCH_FAILURE, payload: error.message });
  }
}

export function* saga() {
  yield takeLatest(TSN_SESSIONS_FETCH_REQUEST, handleFetch);
}
