const express = require('express');
const auth = require('./auth');
const db = require('./db')
const tsn = require('./tsn');
const upf = require('./upf');
const amf = require('./amf');
const logs = require('./logs');
const ptp = require('./ptp');
const ue = require('./ue');
const health = require('./health');
const alerts = require('./alerts');
const reports = require('./reports');
const backup = require('./backup');
const sites = require('./sites');
const audit = require('./audit');
const bulk = require('./bulk');
const onboard = require('./onboard');
const oui = require('./oui');
const gnbPm = require('./gnb-pm');
const gnbQos = require('./gnb-qos');
const auditSvc = require('../services/audit');

const router = express.Router();

const secret = process.env.JWT_SECRET_KEY;

const passport = require('passport');
const JWTstrategy = require('passport-jwt').Strategy;
const ExtractJWT = require('passport-jwt').ExtractJwt;

passport.use(
  new JWTstrategy(
    {
      secretOrKey: secret,
      jwtFromRequest: ExtractJWT.fromExtractors([
        ExtractJWT.fromAuthHeaderWithScheme('bearer'),
        function(req) { return (req.query && req.query.access_token) || null; }
      ])
    },
    async (token, done) => {
      try {
        return done(null, token.user);
      } catch (error) {
        done(error);
      }
    }
  )
);

/* ===== 3-tier RBAC: viewer < operator < admin =====
 * viewer   - read-only dashboards (wall displays, guests)
 * operator - run tests, manage subscribers/bridges/QoS/PTP
 * admin    - everything incl. account management
 * Legacy role 'user' is treated as operator so existing accounts keep
 * their current capabilities. Enforcement is server-side; the UI only
 * hides affordances. */
const ROLE_RANK = { viewer: 1, user: 2, operator: 2, admin: 3 };

function rankOf(req) {
  const roles = ((req.user || {}).roles) || [];
  let r = 0;
  roles.forEach((x) => { if ((ROLE_RANK[x] || 0) > r) r = ROLE_RANK[x] || 0; });
  return r;
}

function needAdmin(req, res, next) {
  if (rankOf(req) >= 3) return next();
  return forbid(res, 'admin');
}

function forbid(res, need) {
  return res.status(403).json({ error: 'forbidden: requires ' + need + ' role' });
}

/* writes require operator; reads allowed for every authenticated role */
function writesNeedOperator(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (rankOf(req) >= 2) return next();
  return forbid(res, 'operator');
}

/* /db policy: account management is admin-only (except reading/updating
 * your own account for password change); subscriber/profile writes need
 * operator. */
function dbPolicy(req, res, next) {
  const p = req.path.toLowerCase();
  const m = p.match(/^\/accounts?(\/(.*))?$/);
  if (m) {
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    const own = req.user && req.user.username &&
        id === String(req.user.username).toLowerCase();
    if (rankOf(req) >= 3) return next();
    if (own && (req.method === 'GET' || req.method === 'PUT' ||
        req.method === 'PATCH')) return next();
    return forbid(res, 'admin');
  }
  return writesNeedOperator(req, res, next);
}

/* /ue policy: active tests mutate network state - operator.
 * Passive latency probe stays available to viewers (wall display). */
function uePolicy(req, res, next) {
  const p = req.path.toLowerCase();
  if (p.indexOf('/speedtest') === 0 || p.indexOf('/iperfserver') === 0) {
    if (rankOf(req) >= 2) return next();
    return forbid(res, 'operator');
  }
  return next();
}

router.use('/auth', auth);
router.use('/db', passport.authenticate('jwt', { session: false }), dbPolicy, auditSvc.middleware('db'), db);
router.use('/tsn', passport.authenticate('jwt', { session: false }), writesNeedOperator, auditSvc.middleware('tsn'), tsn);
router.use('/upf', passport.authenticate('jwt', { session: false }), upf);
router.use('/amf', passport.authenticate('jwt', { session: false }), amf);
router.use('/logs', passport.authenticate('jwt', { session: false }), logs);
router.use('/ue', passport.authenticate('jwt', { session: false }), uePolicy, auditSvc.middleware('ue'), ue);
router.use('/ptp', passport.authenticate('jwt', { session: false }), writesNeedOperator, ptp);
router.use('/health', passport.authenticate('jwt', { session: false }), health);
router.use('/alerts', passport.authenticate('jwt', { session: false }), writesNeedOperator, auditSvc.middleware('alerts'), alerts);
router.use('/reports', passport.authenticate('jwt', { session: false }), reports);
router.use('/backup', passport.authenticate('jwt', { session: false }), needAdmin, auditSvc.middleware('backup'), backup);
router.use('/sites', passport.authenticate('jwt', { session: false }), writesNeedOperator, auditSvc.middleware('sites'), sites);
router.use('/audit', passport.authenticate('jwt', { session: false }), needAdmin, audit);
router.use('/bulk', passport.authenticate('jwt', { session: false }), writesNeedOperator, auditSvc.middleware('db'), bulk);
router.use('/onboard', passport.authenticate('jwt', { session: false }), writesNeedOperator, auditSvc.middleware('db'), onboard);
router.use('/oui', passport.authenticate('jwt', { session: false }), oui);
router.use('/gnb-pm', passport.authenticate('jwt', { session: false }), gnbPm);
router.use('/gnb-qos', passport.authenticate('jwt', { session: false }), writesNeedOperator, auditSvc.middleware('gnb-qos'), gnbQos);

module.exports = router;
