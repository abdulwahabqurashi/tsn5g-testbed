import { takeEvery, put, select } from 'redux-saga/effects';
import { extractMetric } from 'helpers/metric-extractors';
import * as Notification from 'modules/notification/actions';

// Action types
var ADD_RULE = 'alerts/ADD_RULE';
var REMOVE_RULE = 'alerts/REMOVE_RULE';
var TOGGLE_RULE = 'alerts/TOGGLE_RULE';
var UPDATE_RULE = 'alerts/UPDATE_RULE';
var ADD_HISTORY = 'alerts/ADD_HISTORY';
var CLEAR_HISTORY = 'alerts/CLEAR_HISTORY';
var LOAD_RULES = 'alerts/LOAD_RULES';

// Action creators
export var addRule = function(rule) { return { type: ADD_RULE, payload: rule }; };
export var removeRule = function(id) { return { type: REMOVE_RULE, payload: id }; };
export var toggleRule = function(id) { return { type: TOGGLE_RULE, payload: id }; };
export var updateRule = function(rule) { return { type: UPDATE_RULE, payload: rule }; };
export var clearHistory = function() { return { type: CLEAR_HISTORY }; };

// Default rules
var defaultRules = [
  { id: 'jitter-high', name: 'High Jitter', metric: 'nwtt.jitter_current_us', operator: '>', threshold: 1000, enabled: true, severity: 'warning' },
  { id: 'psfp-drop', name: 'PSFP Drop Rate', metric: 'nwtt.psfp_drop_pct', operator: '>', threshold: 5, enabled: true, severity: 'error' },
  { id: 'ue-drop', name: 'No Connected UEs', metric: 'ue.connected_count', operator: '<', threshold: 1, enabled: false, severity: 'warning' },
  { id: 'residence-high', name: 'High Residence Time', metric: 'nwtt.residence_avg_us', operator: '>', threshold: 5000, enabled: false, severity: 'warning' }
];

// Load from localStorage
function loadRules() {
  if (typeof window === 'undefined') return defaultRules;
  try {
    var saved = localStorage.getItem('open5gs_alert_rules');
    if (saved) return JSON.parse(saved);
  } catch (e) { /* ignore */ }
  return defaultRules;
}

function saveRules(rules) {
  if (typeof window !== 'undefined') {
    try { localStorage.setItem('open5gs_alert_rules', JSON.stringify(rules)); } catch (e) { /* ignore */ }
  }
}

var initialState = {
  rules: loadRules(),
  history: [],
  lastChecked: null
};

// Reducer
export default function reducer(state, action) {
  if (state === undefined) state = initialState;
  if (!action) return state;

  var newRules;
  switch (action.type) {
    case ADD_RULE:
      newRules = state.rules.concat([action.payload]);
      saveRules(newRules);
      return { ...state, rules: newRules };

    case REMOVE_RULE:
      newRules = state.rules.filter(function(r) { return r.id !== action.payload; });
      saveRules(newRules);
      return { ...state, rules: newRules };

    case TOGGLE_RULE:
      newRules = state.rules.map(function(r) {
        if (r.id === action.payload) return { ...r, enabled: !r.enabled };
        return r;
      });
      saveRules(newRules);
      return { ...state, rules: newRules };

    case UPDATE_RULE:
      newRules = state.rules.map(function(r) {
        if (r.id === action.payload.id) return { ...r, ...action.payload };
        return r;
      });
      saveRules(newRules);
      return { ...state, rules: newRules };

    case ADD_HISTORY:
      var newHistory = [action.payload].concat(state.history).slice(0, 50);
      return { ...state, history: newHistory, lastChecked: Date.now() };

    case CLEAR_HISTORY:
      return { ...state, history: [] };

    case LOAD_RULES:
      return { ...state, rules: action.payload };

    default:
      return state;
  }
}

// Cooldown tracking (prevent re-alerting same rule within 30s)
var lastAlerted = {};

function evaluateRule(rule, value) {
  if (value === null || value === undefined) return false;
  switch (rule.operator) {
    case '>': return value > rule.threshold;
    case '<': return value < rule.threshold;
    case '>=': return value >= rule.threshold;
    case '<=': return value <= rule.threshold;
    case '==': return value === rule.threshold;
    default: return false;
  }
}

function* checkAlerts(action) {
  var data = action.payload;
  if (!data) return;

  var state = yield select(function(s) { return s.alerts; });
  var rules = state.rules || [];
  var now = Date.now();

  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (!rule.enabled) continue;

    var value = extractMetric(rule.metric, data);
    if (value === null) continue;

    var violated = evaluateRule(rule, value);
    if (!violated) continue;

    // Cooldown check (30 seconds)
    if (lastAlerted[rule.id] && (now - lastAlerted[rule.id]) < 30000) continue;
    lastAlerted[rule.id] = now;

    // Add to history
    yield put({
      type: ADD_HISTORY,
      payload: {
        id: now + '-' + rule.id,
        ruleId: rule.id,
        ruleName: rule.name,
        metric: rule.metric,
        value: value,
        threshold: rule.threshold,
        operator: rule.operator,
        severity: rule.severity,
        timestamp: now
      }
    });

    // Fire notification
    var notifFn = rule.severity === 'error' ? Notification.error : Notification.warning;
    yield put(notifFn({
      title: 'Alert: ' + rule.name,
      message: rule.metric + ' = ' + (typeof value === 'number' ? value.toFixed(2) : value) + ' (threshold: ' + rule.operator + ' ' + rule.threshold + ')',
      autoDismiss: 5
    }));
  }
}

export function* saga() {
  // Watch for dashboard data refreshes to check alerts
  yield takeEvery('dashboard/FETCH_SUCCESS', checkAlerts);
}
