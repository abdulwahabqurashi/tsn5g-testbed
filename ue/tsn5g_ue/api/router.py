"""
Path router, request wrapper and error mapping.

About 200 lines standing in for a web framework. That is the trade the project
makes deliberately: everything this daemon does is blocking (pyserial reads,
subprocess calls to qmicli and iperf3, paramiko SSH), so an async framework
would buy a rewrite and still need a thread pool behind it — while adding
compiled dependencies to an appliance that must come up from a fresh image with
no network. What a framework would have given us is routing, body validation,
CORS and a spec dump; those are below.
"""

import json
import logging
import re

logger = logging.getLogger("tsn5g-ue.api")

# Sentinel: the handler wrote the response itself (SSE, file streaming) and the
# dispatcher must not touch the socket.
RAW = object()

_PARAM = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


class ApiError(Exception):
    """An error with a deliberate HTTP status and a UI-safe message."""

    def __init__(self, status, message, detail=None, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.detail = detail
        self.extra = extra

    def body(self):
        d = {"error": self.message}
        if self.detail:
            d["detail"] = self.detail
        d.update(self.extra)
        return d


class Response:
    """Explicit status/headers when returning a bare dict is not enough."""

    __slots__ = ("status", "data", "headers", "raw_body", "content_type")

    def __init__(self, status=200, data=None, headers=None, raw_body=None,
                 content_type=None):
        self.status = status
        self.data = data
        self.headers = headers or {}
        self.raw_body = raw_body
        self.content_type = content_type


class Request:
    """What a route handler receives."""

    __slots__ = ("method", "path", "params", "query", "body", "ctx", "http",
                 "headers")

    def __init__(self, method, path, params, query, body, ctx, http):
        self.method = method
        self.path = path
        self.params = params          # from the path pattern: {id} -> "j-abc"
        self.query = query            # parse_qs output, flattened by q()
        self.body = body if isinstance(body, dict) else {}
        self.ctx = ctx                # AppContext: controller, jobs, bus, ...
        self.http = http              # the BaseHTTPRequestHandler, for SSE
        self.headers = http.headers if http is not None else {}

    # -- query helpers ------------------------------------------------------
    def q(self, key, default=None):
        vals = self.query.get(key)
        return vals[0] if vals else default

    def q_int(self, key, default=None):
        v = self.q(key)
        if v is None or v == "":
            return default
        try:
            return int(v)
        except ValueError:
            raise ApiError(400, f"{key} must be an integer, got {v!r}") from None

    def q_float(self, key, default=None):
        v = self.q(key)
        if v is None or v == "":
            return default
        try:
            return float(v)
        except ValueError:
            raise ApiError(400, f"{key} must be a number, got {v!r}") from None

    def q_bool(self, key, default=False):
        v = self.q(key)
        if v is None:
            return default
        return v.lower() in ("1", "true", "yes", "on")

    def q_list(self, key):
        """Comma-separated or repeated query parameter."""
        out = []
        for v in self.query.get(key, []):
            out.extend(p for p in v.split(",") if p)
        return out

    # -- body helpers -------------------------------------------------------
    def require(self, *fields):
        """Fetch required body fields, 400 naming the first one missing."""
        out = []
        for f in fields:
            if f not in self.body or self.body[f] in (None, ""):
                raise ApiError(400, f"missing field: '{f}'")
            out.append(self.body[f])
        return out[0] if len(out) == 1 else tuple(out)

    def opt(self, field, default=None):
        v = self.body.get(field, default)
        return default if v is None else v

    def choice(self, field, allowed, default=None, required=False):
        v = self.body.get(field, default)
        if v is None:
            if required:
                raise ApiError(400, f"missing field: '{field}'")
            return default
        if v not in allowed:
            raise ApiError(400,
                           f"{field} must be one of {', '.join(map(str, allowed))}; got {v!r}")
        return v

    def integer(self, field, default=None, lo=None, hi=None, required=False):
        v = self.body.get(field, default)
        if v is None:
            if required:
                raise ApiError(400, f"missing field: '{field}'")
            return default
        try:
            v = int(v)
        except (TypeError, ValueError):
            raise ApiError(400, f"{field} must be an integer; got {v!r}") from None
        if lo is not None and v < lo:
            raise ApiError(400, f"{field} must be >= {lo}; got {v}")
        if hi is not None and v > hi:
            raise ApiError(400, f"{field} must be <= {hi}; got {v}")
        return v

    @property
    def confirmed(self):
        return bool(self.body.get("confirm"))


class Route:
    __slots__ = ("method", "pattern", "regex", "fn", "doc", "params")

    def __init__(self, method, pattern, fn):
        self.method = method.upper()
        self.pattern = pattern
        self.fn = fn
        self.params = _PARAM.findall(pattern)
        # {name} matches one path segment; nothing else is special.
        rx = _PARAM.sub(lambda m: f"(?P<{m.group(1)}>[^/]+)", re.escape(pattern)
                        .replace(r"\{", "{").replace(r"\}", "}"))
        self.regex = re.compile("^" + rx + "$")
        self.doc = (fn.__doc__ or "").strip().splitlines()[0] if fn.__doc__ else ""


class Router:
    def __init__(self):
        self._routes = []
        self._by_path = {}          # pattern -> set of methods, for 405s

    def add(self, method, pattern, fn):
        self._routes.append(Route(method, pattern, fn))
        self._by_path.setdefault(pattern, set()).add(method.upper())
        return fn

    # Sugar so route modules read as a table.
    def get(self, pattern):
        return lambda fn: self.add("GET", pattern, fn)

    def post(self, pattern):
        return lambda fn: self.add("POST", pattern, fn)

    def put(self, pattern):
        return lambda fn: self.add("PUT", pattern, fn)

    def delete(self, pattern):
        return lambda fn: self.add("DELETE", pattern, fn)

    def match(self, method, path):
        """Return (fn, params). Raises ApiError(405) if the path exists for
        another method, so a wrong verb is not reported as a missing route."""
        method = method.upper()
        other = set()
        for r in self._routes:
            m = r.regex.match(path)
            if not m:
                continue
            if r.method == method:
                return r.fn, m.groupdict()
            other.add(r.method)
        if other:
            raise ApiError(405, f"{method} not allowed on {path}",
                           allowed=sorted(other | {"OPTIONS"}))
        return None, None

    def spec(self):
        """The route table, for GET /api/spec and the endpoint checker."""
        out = []
        for r in sorted(self._routes, key=lambda r: (r.pattern, r.method)):
            out.append({"method": r.method, "path": r.pattern,
                        "params": r.params, "summary": r.doc})
        return out

    def __len__(self):
        return len(self._routes)


def error_response(exc):
    """Map an exception to (status, body). One place, so every route agrees."""
    # Imported here to keep core/ importable without api/.
    from ..core.jobs import ConfirmationRequired, LaneBusy

    if isinstance(exc, ApiError):
        return exc.status, exc.body()
    if isinstance(exc, LaneBusy):
        return 409, {"error": f"lane busy: {exc.lane}", "lane": exc.lane,
                     "job_id": exc.job_id}
    if isinstance(exc, ConfirmationRequired):
        return 428, {"error": "confirmation required", "explain": exc.explain,
                     "kind": exc.kind}
    if isinstance(exc, KeyError):
        # Controller and handlers raise bare KeyError for absent fields.
        return 400, {"error": f"missing field: {exc}"}
    if isinstance(exc, (ValueError, TypeError)):
        return 400, {"error": str(exc)}
    if isinstance(exc, NotImplementedError):
        return 501, {"error": str(exc) or "not implemented on this platform"}
    if isinstance(exc, PermissionError):
        return 403, {"error": str(exc)}
    if isinstance(exc, FileNotFoundError):
        return 404, {"error": str(exc)}
    if isinstance(exc, TimeoutError):
        return 504, {"error": str(exc) or "operation timed out"}
    return 500, {"error": str(exc) or exc.__class__.__name__}


def json_bytes(data):
    return json.dumps(data, indent=2, default=str).encode("utf-8")
