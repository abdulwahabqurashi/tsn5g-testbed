import {
  fetchCollection,
  fetchDocument,
  createDocument,
  updateDocument,
  deleteDocument
} from './actions'

export const MODEL = 'bridges';
export const URL = '/Bridge';
const OPTS = { idProperty: 'bridgeId', baseUrl: '/api/tsn' };

export const fetchBridges = (params = {}) => {
  return fetchCollection(MODEL, URL, params, OPTS);
}

export const fetchBridge = (bridgeId, params = {}) => {
  return fetchDocument(MODEL, bridgeId, `${URL}/${bridgeId}`, params, OPTS);
}

export const createBridge = (params = {}, data = {}) => {
  return createDocument(MODEL, URL, params, data, OPTS);
}

export const updateBridge = (bridgeId, params = {}, data = {}) => {
  return updateDocument(MODEL, bridgeId, `${URL}/${bridgeId}`, params, data, OPTS);
}

export const deleteBridge = (bridgeId, params = {}) => {
  return deleteDocument(MODEL, bridgeId, `${URL}/${bridgeId}`, params, OPTS);
}
