"""
Control + telemetry HTTP API, and static server for the web UI.

Uses only the standard library (http.server) so the UI ships dependency-free.

GET  /                     -> web UI (static files from web/)
GET  /api/status           -> controller.snapshot()
GET  /api/health           -> controller.health()
GET  /api/stats            -> stats.get_stats()
GET  /api/discovery        -> detected modem + NICs + inferred role
GET  /api/config           -> current config
GET  /api/switch/profiles  -> Qbv preset list
POST /api/connect          {mode,dnn,wired_nics,role}     -> start (async) connect
POST /api/disconnect                                       -> teardown
PUT  /api/config           {..patch..}                     -> update + persist config
POST /api/switch/apply     {host,user,pass,profile,ports,dry_run}
POST /api/switch/disable   {host,user,pass,ports}
GET  /api/switch/status?host=..&ports=..
"""

import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

logger = logging.getLogger("tsn5g-ue.api")

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web")
_MIME = {".html": "text/html", ".css": "text/css", ".js": "application/javascript",
         ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
         ".ico": "image/x-icon"}


class _Handler(BaseHTTPRequestHandler):
    controller = None
    stats = None

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
        with open(full, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", _MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        # Never let the browser cache the UI assets — after an update the old JS
        # must not linger (a stale cached file once showed a blank dashboard).
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
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


class ApiServer:
    def __init__(self, host, port, controller, stats=None):
        self.host = host
        self.port = port
        _Handler.controller = controller
        _Handler.stats = stats
        self._server = None
        self._thread = None

    def start(self):
        self._server = ThreadingHTTPServer((self.host, self.port), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        name="api", daemon=True)
        self._thread.start()
        logger.info("UI + API on http://%s:%d/", self.host, self.port)

    def stop(self):
        if self._server:
            self._server.shutdown()
            logger.info("API server stopped")
