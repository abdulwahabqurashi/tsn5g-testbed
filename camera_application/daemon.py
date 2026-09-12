"""
Daemon — process wrapper. Sets up logging, builds the Controller, starts the API
server, and runs the periodic health/stats loop until signalled.

Unlike the original DS-TT daemon, this one does NOT drive the connect sequence at
boot; the Controller decides whether to auto-resume, and the UI/API drives new
connections. Boot always reaches a serving state so the UI is reachable.
"""

import logging
import signal
import time

from . import __app_name__, __version__
from . import constants as C
from .api import ApiServer
from .config import Config
from .controller import Controller
from .stats import StatsCollector

logger = logging.getLogger("tsn5g-ue")


class Daemon:
    def __init__(self, config_path, log_level_override=None):
        self.config = Config(config_path)
        level = (log_level_override or self.config.log_level).upper()
        logging.basicConfig(
            level=getattr(logging, level, logging.INFO),
            format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        self.controller = Controller(self.config)
        # Latency/jitter probe points at the core VXLAN endpoint over the modem.
        core_ip = (self.config.vxlan or {}).get("core_ip")
        self.stats = StatsCollector(self._monitored_interfaces(),
                                    link_target=core_ip,
                                    link_iface=self.config.modem.get("wwan_interface", "wwan0"))
        self.api_server = None
        self._running = False

        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)

    def _monitored_interfaces(self):
        ifaces = list(self.config.tsn_interfaces())
        wwan = self.config.modem.get("wwan_interface")
        if wwan:
            ifaces.append(wwan)
        bridge = self.config.bridge.get("name")
        if bridge:
            ifaces.append(bridge)
        return ifaces

    def run(self):
        logger.info("=" * 60)
        logger.info("%s v%s", __app_name__, __version__)
        logger.info("=" * 60)

        # 1) Start API immediately so the UI is always reachable.
        if self.config.api.get("enabled", True):
            self.api_server = ApiServer(
                host=self.config.api.get("host", "0.0.0.0"),
                port=self.config.api.get("port", C.DEFAULT_API_PORT),
                controller=self.controller,
                stats=self.stats,
            )
            self.api_server.start()

        # 2) Detect hardware and optionally auto-resume last-good session.
        self.controller.start()

        # 3) Main loop: stats + health.
        self._main_loop()
        return 0

    def _main_loop(self):
        self._running = True
        last_stats = last_health = 0.0
        while self._running:
            now = time.monotonic()
            if now - last_stats >= C.STATS_INTERVAL:
                self.stats.collect()
                last_stats = now
            if now - last_health >= C.HEALTH_CHECK_INTERVAL:
                h = self.controller.health()
                if not h["healthy"] and self.controller.state == C.STATE_RUNNING:
                    logger.warning("health issues: %s", h["checks"])
                last_health = now
            time.sleep(C.MAIN_LOOP_TICK)
        self.shutdown()

    def _on_signal(self, signum, _frame):
        logger.info("signal %d — shutting down", signum)
        self._running = False

    def shutdown(self):
        logger.info("shutting down...")
        if self.api_server:
            self.api_server.stop()
        try:
            self.controller.disconnect()
        except Exception as exc:  # noqa: BLE001
            logger.error("error during disconnect: %s", exc)
        logger.info("stopped")
