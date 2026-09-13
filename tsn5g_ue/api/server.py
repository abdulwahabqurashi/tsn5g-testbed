"""
http.server glue: the handler, the threading server, and the shared context.

Concurrency notes that matter here:

* `ThreadingHTTPServer` has no thread pool — one thread per connection, for the
  life of that connection. HTTP/1.1 keep-alive means those now persist across
  requests, which is why the handler carries a socket timeout and why a global
  semaphore caps how many can exist.
* `ThreadingMixIn.block_on_close` is True *even here*, and `daemon_threads`
  does not clear it, so `server_close()` joins every handler thread. With
  `/api/events` holding streams open that would make every restart a hang.
* Handlers must not block. Anything over ~200 ms is a job; read models are
  served from snapshots the daemon loop refreshes.
"""

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import static
from .router import (RAW, ApiError, Request, Response, Router, error_response,
                     json_bytes)
from .sse import SseRegistry

logger = logging.getLogger("tsn5g-ue.api")

# Backstop against a runaway client: ThreadingMixIn will happily spawn threads
# until the process dies.
MAX_HANDLER_THREADS = 64


class AppContext:
    """Everything the route modules are allowed to touch.

    Passed to handlers as `req.ctx`. Keeping it explicit means a route module
    cannot quietly reach into daemon internals, and tests can build one by hand.
    """

    def __init__(self, controller=None, stats=None, jobs=None, bus=None,
                 store=None, logbuf=None, audit=None, config=None,
                 version=None, router=None):
        self.controller = controller
        self.stats = stats
        self.jobs = jobs
        self.bus = bus
        self.store = store
        self.logbuf = logbuf
        self.audit = audit
        self.config = config
        self.version = version
        self.router = router
        self.sse = SseRegistry()
        self.started = None

    def submit_job(self, kind, params=None):
        """Enqueue a job and return the 202 body.

        Carries the legacy `accepted`/`step` keys alongside `job_id` so the
        existing UI, which ignores the body and polls /api/status, keeps
        working while it is migrated onto job progress.
        """
        if self.jobs is None:
            raise ApiError(503, "job manager not available")
        job = self.jobs.submit(kind, params or {})
        return Response(202, {
            "job_id": job.id,
            "kind": job.kind,
            "lane": job.lane,
            "state": job.state,
            "accepted": True,
            "step": job.kind,
        })


class _Handler(BaseHTTPRequestHandler):
    ctx = None          # AppContext, injected by ApiServer

    protocol_version = "HTTP/1.1"
    timeout = 30

    server_version = "tsn5g-ue"
    sys_version = ""

    _slots = threading.Semaphore(MAX_HANDLER_THREADS)

    # -- dispatch -----------------------------------------------------------
    def handle_one_request(self):
        if not self._slots.acquire(blocking=False):
            try:
                self.close_connection = True
                self.send_response(503)
                self.send_header("Retry-After", "2")
                self.send_header("Content-Length", "0")
                self.end_headers()
            except Exception:       # noqa: BLE001
                pass
            return
        try:
            super().handle_one_request()
        finally:
            self._slots.release()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        """Preflight. Without it, a UI on another origin fails every JSON POST."""
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)

        if not path.startswith("/api/"):
            if method != "GET":
                self._json(405, {"error": f"{method} not allowed on {path}"})
                return
            try:
                if not static.serve(self, path):
                    self._json(404, {"error": "not found"})
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            return

        try:
            fn, params = self.ctx.router.match(method, path)
        except ApiError as exc:
            hdrs = {}
            if exc.extra.get("allowed"):
                hdrs["Allow"] = ", ".join(exc.extra["allowed"])
            self._json(exc.status, exc.body(), headers=hdrs)
            return

        if fn is None:
            self._json(404, {"error": "not found"})
            return

        body = self._read_json(path)
        if body is _BAD_JSON:
            self._json(400, {"error": "request body is not valid JSON"})
            return

        req = Request(method, path, params, query, body, self.ctx, self)
        try:
            result = fn(req)
        except Exception as exc:                    # noqa: BLE001
            status, payload = error_response(exc)
            if status >= 500:
                logger.exception("%s %s failed", method, path)
            else:
                logger.info("%s %s -> %d: %s", method, path, status,
                            payload.get("error"))
            try:
                self._json(status, payload)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            return

        if result is RAW:
            # The handler owns the socket from here (SSE). Never keep-alive a
            # connection whose framing we no longer control.
            self.close_connection = True
            return
        if isinstance(result, Response):
            if result.raw_body is not None:
                self._raw(result.status, result.raw_body,
                          result.content_type or "application/octet-stream",
                          result.headers)
            else:
                self._json(result.status, result.data, headers=result.headers)
            return
        if isinstance(result, tuple) and len(result) == 2:
            self._json(result[0], result[1])
            return
        self._json(200, result if result is not None else {})

    # -- writers ------------------------------------------------------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Authorization, Last-Event-ID")

    def _json(self, code, data, headers=None):
        body = json_bytes(data)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _raw(self, code, body, content_type, headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self, path):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            # The old code swallowed this and returned {}, which then surfaced
            # as a confusing "missing field" 400. Say what actually went wrong.
            return _BAD_JSON
        return parsed if isinstance(parsed, dict) else {"_": parsed}

    def log_message(self, fmt, *args):
        logger.debug("HTTP %s", fmt % args)


class _BadJson:
    __slots__ = ()


_BAD_JSON = _BadJson()


class _Server(ThreadingHTTPServer):
    """ThreadingHTTPServer that can actually be closed.

    block_on_close defaults to True even here (daemon_threads does not clear
    it), so server_close() would join every handler thread — including an SSE
    stream that by design never ends.
    """

    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True


class ApiServer:
    def __init__(self, host, port, ctx):
        self.host = host
        self.port = port
        self.ctx = ctx
        _Handler.ctx = ctx
        self._server = None
        self._thread = None

    def start(self):
        self._server = _Server((self.host, self.port), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        name="api", daemon=True)
        self._thread.start()
        logger.info("UI + API on http://%s:%d/ (%d routes)",
                    self.host, self.port, len(self.ctx.router))

    def stop(self):
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
            logger.info("API server stopped")


def build_router():
    """Assemble the route table from every routes_* module."""
    from . import (routes_bearer, routes_connect, routes_jobs, routes_logs,
                   routes_modem,
                   routes_net, routes_perf, routes_routing, routes_signal,
                   routes_system, routes_tsn)
    router = Router()
    for mod in (routes_system, routes_jobs, routes_logs, routes_connect,
                routes_bearer, routes_modem, routes_signal, routes_net,
                routes_routing, routes_perf, routes_tsn):
        mod.register(router)
    return router
