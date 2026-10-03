import axios from 'axios';
import Session from 'modules/auth/session';

export function tsnApi(method, url, data) {
  var session = (new Session()).session || {};
  var headers = {};
  if (session.csrfToken) headers['X-CSRF-TOKEN'] = session.csrfToken;
  if (session.authToken) headers['Authorization'] = 'Bearer ' + session.authToken;
  return axios({ method, url, data, headers });
}
