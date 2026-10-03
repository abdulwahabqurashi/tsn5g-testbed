"""
REST API server for DS-TT.

Serves both the JSON API endpoints (/api/*) and the standalone
web dashboard (static files from web/ directory).

Uses Python's built-in http.server — no external dependencies.
"""

import json
import logging
import os
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

logger = logging.getLogger("ds-tt.api")

# Resolve web/ directory relative to this package
WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web")


class ApiHandler(SimpleHTTPRequestHandler):
    """HTTP request handler for DS-TT REST API and web dashboard."""

    # Reference to the daemon (set by ApiServer)
    daemon = None

    def __init__(self, *args, **kwargs):
        # Serve static files from web/ directory
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def log_message(self, format, *args):
        """Route HTTP log messages to our logger."""
        logger.debug("HTTP %s", format % args)

    def do_GET(self):
        """Handle GET requests — API endpoints or static files."""
        parsed = urlparse(self.path)
        path = parsed.path

        # API endpoints
        if path.startswith("/api/"):
            self._handle_api(path)
            return

        # Static file serving for web dashboard
        super().do_GET()

    def _handle_api(self, path):
        """Route API requests."""
        routes = {
            "/api/status": self._api_status,
            "/api/stats": self._api_stats,
            "/api/modem": self._api_modem,
            "/api/gptp": self._api_gptp,
            "/api/bridge": self._api_bridge,
            "/api/health": self._api_health,
        }

        handler = routes.get(path)
        if handler:
            try:
                data = handler()
                self._send_json(200, data)
            except Exception as e:
                logger.error("API error on %s: %s", path, e)
                self._send_json(500, {"error": str(e)})
        else:
            self._send_json(404, {"error": "Not found"})

    def _send_json(self, status_code, data):
        """Send a JSON response."""
        body = json.dumps(data, indent=2).encode()
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _api_status(self):
        """GET /api/status — Overall DS-TT status."""
        d = self.daemon
        if not d:
            return {"error": "Daemon not initialized"}

        return {
            "version": "0.1.0",
            "state": d.state,
            "modem": d.modem.get_status() if d.modem else None,
            "bridge": d.bridge.get_status() if d.bridge else None,
            "gptp": d.gptp.get_status() if d.gptp else None,
        }

    def _api_stats(self):
        """GET /api/stats — Traffic statistics."""
        d = self.daemon
        if not d or not d.stats:
            return {"error": "Stats not available"}
        return d.stats.get_stats()

    def _api_modem(self):
        """GET /api/modem — Modem details."""
        d = self.daemon
        if not d or not d.modem:
            return {"error": "Modem not initialized"}
        d.modem.refresh_signal()
        return d.modem.get_status()

    def _api_gptp(self):
        """GET /api/gptp — gPTP details."""
        d = self.daemon
        if not d or not d.gptp:
            return {"error": "gPTP not initialized"}
        return d.gptp.get_status()

    def _api_bridge(self):
        """GET /api/bridge — Bridge details."""
        d = self.daemon
        if not d or not d.bridge:
            return {"error": "Bridge not initialized"}
        status = d.bridge.get_status()
        status["interface_macs"] = d.bridge.get_interface_macs()
        return status

    def _api_health(self):
        """GET /api/health — Health check."""
        d = self.daemon
        if not d:
            return {"healthy": False, "reason": "daemon not initialized"}

        checks = {
            "modem": d.modem.check_health() if d.modem else False,
            "bridge": d.bridge.check_health() if d.bridge else False,
            "gptp": d.gptp.check_health() if d.gptp else True,
        }

        healthy = all(checks.values())
        return {
            "healthy": healthy,
            "checks": checks,
            "state": d.state,
        }


class ApiServer:
    """Threaded HTTP server for the DS-TT REST API and web dashboard."""

    def __init__(self, host, port, daemon_ref):
        self.host = host
        self.port = port
        self._server = None
        self._thread = None

        # Set daemon reference on the handler class
        ApiHandler.daemon = daemon_ref

    def start(self):
        """Start the API server in a background thread."""
        self._server = HTTPServer((self.host, self.port), ApiHandler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            daemon=True,
            name="ds-tt-api",
        )
        self._thread.start()
        logger.info("API server started on http://%s:%d", self.host, self.port)
        logger.info("Web dashboard: http://%s:%d/", self.host, self.port)

    def stop(self):
        """Stop the API server."""
        if self._server:
            self._server.shutdown()
            logger.info("API server stopped")
