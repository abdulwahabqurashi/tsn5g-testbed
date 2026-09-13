"""
Control + telemetry HTTP API, and static server for the web UI.

Uses only the standard library (http.server) so the UI ships dependency-free.
Everything here is blocking by design: pyserial reads, subprocess calls to
qmicli/iperf3/ip, and paramiko SSH. Thread-per-request is the correct model for
that workload; an event loop would buy a rewrite and still need a thread pool.

The authoritative route list lives in docs/api-contract.md — it is generated
from, and checked against, the running server. The docstring that used to sit
here listed 13 of the 27 implemented routes and had been wrong for months.

Response conventions:
  * every response sets Content-Length (required: protocol_version is HTTP/1.1)
  * every non-2xx JSON body is {"error": "<human readable>"}
  * slow work returns 202 and is polled; see _async()
"""

import json
import logging
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

logger = logging.getLogger("tsn5g-ue.api")

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web")
_MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".js": "text/javascript; charset=utf-8",
         ".mjs": "text/javascript; charset=utf-8",
         ".json": "application/json", ".map": "application/json",
         ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
         ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
         ".csv": "text/csv; charset=utf-8"}


class _Handler(BaseHTTPRequestHandler):
    controller = None
    stats = None

    # HTTP/1.1 enables keep-alive, so the dashboard's several-endpoints-per-tick
    # polling stops opening a fresh TCP connection (and a fresh thread) per
    # request. Every response below sets Content-Length, which is what makes
    # keep-alive safe; that invariant is now mandatory.
    protocol_version = "HTTP/1.1"
    # ...and the socket timeout is what stops an idle keep-alive connection
    # pinning its handler thread forever. ThreadingHTTPServer has no thread
    # pool, so a leaked thread is leaked until process exit.
    timeout = 30

    # -- CORS ---------------------------------------------------------------
    def do_OPTIONS(self):
        """Preflight. Without this, any UI served from a different origin (a dev
        server on :5173) fails every JSON POST before it is sent."""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Authorization, Last-Event-ID")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- request routing ----------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        if path.startswith("/api/"):
            self._route_get(path, query)
        else:
            self._serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        body = self._read_json()
        c = self.controller
        try:
            if parsed.path == "/api/connect":
                self._connect(body)
            elif parsed.path == "/api/disconnect":
                self.controller.disconnect()
                self._json(200, {"ok": True})
            # ---- guided setup, step by step ----
            elif parsed.path == "/api/modem/check":
                self._async("modem-check", lambda: c.modem_check())
            elif parsed.path == "/api/transport/start":
                self._async("transport-start", lambda: c.transport_start(
                    mode=body.get("mode"), dnn=body.get("dnn"),
                    wired_nics=body.get("wired_nics"), role=body.get("role"),
                    vlan_map=body.get("vlan_map")))
            elif parsed.path == "/api/transport/stop":
                self._json(200, c.transport_stop())
            elif parsed.path == "/api/gptp/start":
                self._async("gptp-start", lambda: c.gptp_start(iface=body.get("iface")))
            elif parsed.path == "/api/gptp/stop":
                self._json(200, c.gptp_stop())
            elif parsed.path == "/api/tas/apply":
                self._json(200, c.tas_apply(iface=body.get("iface"),
                    profile=body.get("profile"), slots=body.get("slots"),
                    cycle_ns=body.get("cycle_ns"), dry_run=bool(body.get("dry_run"))))
            elif parsed.path == "/api/tas/clear":
                self._json(200, c.tas_clear(iface=body.get("iface")))
            # ---- speed test ----
            elif parsed.path == "/api/speedtest/run":
                self._json(200, c.speedtest_start(server=body.get("server")))
            # ---- network interfaces (Ethernet + WiFi) ----
            elif parsed.path == "/api/interfaces/config":
                self._json(200, c.set_interface_ip(body["iface"], body.get("method", "dhcp"),
                    address=body.get("address"), gateway=body.get("gateway")))
            elif parsed.path == "/api/wifi/connect":
                self._async("wifi-connect", lambda: c.wifi_connect(
                    body["ssid"], psk=body.get("psk")))
            elif parsed.path == "/api/switch/apply":
                if body.get("slots"):  # dynamic, user-defined gate schedule
                    self._json(200, self.controller.apply_switch_custom(
                        host=body["host"], user=body["user"], password=body.get("password", ""),
                        slots=body["slots"], cycle_ns=body.get("cycle_ns"),
                        ports=body.get("ports"), guard=bool(body.get("guard", True)),
                        dry_run=bool(body.get("dry_run"))))
                else:
                    self._json(200, self.controller.apply_switch_profile(
                        host=body["host"], user=body["user"], password=body.get("password", ""),
                        profile=body["profile"], ports=body.get("ports"),
                        dry_run=bool(body.get("dry_run"))))
            elif parsed.path == "/api/switch/disable":
                self._json(200, self.controller.disable_switch(
                    host=body["host"], user=body["user"],
                    password=body.get("password", ""), ports=body.get("ports")))
            else:
                self._json(404, {"error": "not found"})
        except KeyError as exc:
            self._json(400, {"error": f"missing field: {exc}"})
        except Exception as exc:  # noqa: BLE001
            logger.error("POST %s failed: %s", parsed.path, exc)
            self._json(500, {"error": str(exc)})

    def do_PUT(self):
        parsed = urlparse(self.path)
        body = self._read_json()
        if parsed.path == "/api/config":
            try:
                self.controller.config.update(body)
                self._json(200, {"ok": True, "config": self.controller.config.as_dict()})
            except Exception as exc:  # noqa: BLE001
                self._json(400, {"error": str(exc)})
        else:
            self._json(404, {"error": "not found"})

    # -- GET handlers -------------------------------------------------------
    def _route_get(self, path, query):
        c = self.controller
        try:
            if path == "/api/status":
                self._json(200, c.snapshot())
            elif path == "/api/health":
                self._json(200, c.health())
            elif path == "/api/stats":
                self._json(200, self.stats.get_stats() if self.stats else {})
            elif path == "/api/discovery":
                self._json(200, c.discovery.summary())
            elif path == "/api/config":
                self._json(200, c.config.as_dict())
            elif path == "/api/switch/profiles":
                self._json(200, {"profiles": c.switch_profiles()})
            elif path == "/api/tas/profiles":
                self._json(200, {"profiles": c.tas.list_profiles()})
            elif path == "/api/setup/state":
                self._json(200, c.setup_state())
            elif path == "/api/speedtest/result":
                self._json(200, c.speedtest_status())
            elif path == "/api/interfaces":
                self._json(200, {"interfaces": c.interfaces()})
            elif path == "/api/wifi/scan":
                self._json(200, {"networks": c.wifi_scan()})
            elif path == "/api/switch/status":
                self._json(200, c.switch_status(
                    host=self._q(query, "host"), user=self._q(query, "user", "admin"),
                    password=self._q(query, "password", ""),
                    ports=self._q(query, "ports")))
            else:
                self._json(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            logger.error("GET %s failed: %s", path, exc)
            self._json(500, {"error": str(exc)})

    def _connect(self, body):
        """Run connect() in a worker thread; UI polls /api/status for progress."""
        self._async("connect", lambda: self.controller.connect(
            mode=body.get("mode"), dnn=body.get("dnn"),
            wired_nics=body.get("wired_nics"), role=body.get("role")))

    def _async(self, name, fn):
        """Run a potentially-slow step in a worker thread; UI polls for the result.
        Errors are recorded on the controller so /api/status surfaces them."""
        ctrl = self.controller

        def worker():
            try:
                fn()
            except Exception as exc:  # noqa: BLE001
                ctrl.last_error = str(exc)
                logger.error("%s failed: %s", name, exc)

        threading.Thread(target=worker, name=name, daemon=True).start()
        self._json(202, {"accepted": True, "step": name})

    # -- static -------------------------------------------------------------
    def _serve_static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(os.path.normpath(WEB_DIR)) or not os.path.isfile(full):
            self._json(404, {"error": "not found"})
            return
        ext = os.path.splitext(full)[1]
        st = os.stat(full)
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)

        # `no-cache` means "revalidate before use", NOT "do not store" — so the
        # original requirement still holds: after an update the browser can never
        # serve stale JS without asking us first. What it buys is the 304 below.
        # The UI is ~35 ES modules; `no-store` re-sent every byte of every one of
        # them on every page load, which is the whole reason a bundler looked
        # necessary. With revalidation the repeat cost is an empty-bodied 304.
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        with open(full, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", _MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # -- helpers ------------------------------------------------------------
    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    def _json(self, code, data):
        body = json.dumps(data, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _q(query, key, default=None):
        vals = query.get(key)
        return vals[0] if vals else default

    def log_message(self, fmt, *args):
        logger.debug("HTTP %s", fmt % args)


class _Server(ThreadingHTTPServer):
    """ThreadingHTTPServer that can actually be closed.

    ThreadingMixIn.block_on_close defaults to True *even here* — setting
    daemon_threads does not clear it — so server_close() joins every live
    handler thread. Once /api/events holds a stream open indefinitely that
    turns a restart into a hang. allow_reuse_address avoids TIME_WAIT
    blocking the rebind on a fast restart.
    """

    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True


class ApiServer:
    def __init__(self, host, port, controller, stats=None):
        self.host = host
        self.port = port
        _Handler.controller = controller
        _Handler.stats = stats
        self._server = None
        self._thread = None

    def start(self):
        self._server = _Server((self.host, self.port), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        name="api", daemon=True)
        self._thread.start()
        logger.info("UI + API on http://%s:%d/", self.host, self.port)

    def stop(self):
        if self._server:
            self._server.shutdown()        # stop accepting / break serve_forever
            self._server.server_close()    # release the listening socket
            self._server = None
            logger.info("API server stopped")
