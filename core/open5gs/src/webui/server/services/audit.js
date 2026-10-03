/*
 * Audit middleware: record every write action (who/what/when/result).
 * Attach after JWT auth so req.user is populated. Logs on response
 * finish so the real status code is captured. Reads are never logged.
 */
const AuditEvent = require('../models/audit-event');

const WRITE = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };

/* map a route path to a friendly resource + action */
function classify(method, mount, p) {
  const verb = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' }[method] || method;
  const seg = (p || '/').split('/').filter(Boolean);
  let resource = mount, target = seg[seg.length - 1] || '';
  if (mount === 'db') {
    resource = (seg[0] || 'record').toLowerCase();      /* Subscriber/Profile/Account */
    target = seg[1] ? decodeURIComponent(seg[1]) : '';
  } else if (mount === 'sites') { resource = 'site'; target = seg[1] || seg[0] || ''; }
  else if (mount === 'alerts') { resource = 'alert-config'; target = seg[0] || ''; }
  else if (mount === 'backup') { resource = 'backup'; target = seg[0] || ''; }
  else if (mount === 'tsn') { resource = 'tsn'; target = seg[0] || ''; }
  else if (mount === 'ue') { resource = 'ue-test'; target = seg[0] || ''; }
  return { resource, action: verb + ' ' + resource, target };
}

function middleware(mount) {
  return function(req, res, next) {
    if (!WRITE[req.method]) return next();
    res.on('finish', function() {
      try {
        const c = classify(req.method, mount, req.path);
        AuditEvent.create({
          user: (req.user || {}).username || 'unknown',
          role: ((req.user || {}).roles || [])[0] || '',
          method: req.method, action: c.action, resource: c.resource,
          target: c.target, path: (mount ? '/' + mount : '') + req.path,
          status: res.statusCode,
          ip: (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '')
            .toString().split(',')[0].trim()
        });
      } catch (e) { /* never break the request */ }
    });
    next();
  };
}

module.exports = { middleware };
