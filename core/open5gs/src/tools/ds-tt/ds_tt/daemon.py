"""
Main DS-TT daemon — orchestrates modem, bridge, gPTP, stats, and API.

Startup sequence:
  1. Load config
  2. Open modem → initialize → wait for 5G registration → activate Ethernet PDU
  3. Create bridge → attach wwan0 + TSN NICs
  4. Configure LLDP forwarding
  5. Start ptp4l (transparent clock) + phc2sys
  6. Start REST API + stats collection
  7. Main loop: periodic health checks
"""

import logging
import signal
import sys
import time

from .api import ApiServer
from .bridge import BridgeManager
from .config import DsTtConfig
from .constants import HEALTH_CHECK_INTERVAL, STATS_INTERVAL
from .gptp import GptpManager
from .lldp import configure_lldp_forwarding
from .modem import ModemManager
from .stats import StatsCollector

logger = logging.getLogger("ds-tt")


class DsTtDaemon:
    """Main DS-TT daemon process."""

    def __init__(self, config_path, log_level_override=None):
        self.config = DsTtConfig(config_path)
        self.state = "initializing"

        # Set up logging
        level = log_level_override or self.config.log_level
        logging.basicConfig(
            level=getattr(logging, level.upper(), logging.INFO),
            format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

        self.modem = None
        self.bridge = None
        self.gptp = None
        self.stats = None
        self.api_server = None
        self._running = False

        # Signal handling
        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)

    def _signal_handler(self, signum, frame):
        """Handle SIGTERM/SIGINT for graceful shutdown."""
        logger.info("Received signal %d — shutting down", signum)
        self._running = False

    def run(self):
        """Main entry point — initialize all components and run main loop."""
        logger.info("=" * 60)
        logger.info("DS-TT: Device-Side TSN Translator v0.1.0")
        logger.info("=" * 60)
        logger.info("Config: %s", self.config)

        try:
            self._init_modem()
            self._init_bridge()
            self._init_lldp()
            self._init_gptp()
            self._init_stats()
            self._init_api()

            self.state = "running"
            logger.info("DS-TT fully initialized — entering main loop")
            self._main_loop()

        except Exception as e:
            logger.error("Fatal error during initialization: %s", e)
            self.state = "error"
            self.shutdown()
            sys.exit(1)

    def _init_modem(self):
        """Step 1: Initialize modem."""
        self.state = "modem_init"
        logger.info("--- Step 1: Modem initialization ---")
        self.modem = ModemManager(self.config.modem)
        self.modem.initialize()

    def _init_bridge(self):
        """Step 2: Create bridge and attach interfaces."""
        self.state = "bridge_init"
        logger.info("--- Step 2: Bridge creation ---")
        self.bridge = BridgeManager(
            self.config.bridge,
            self.config.modem["wwan_interface"],
        )
        self.bridge.create(self.config.get_tsn_interfaces())

    def _init_lldp(self):
        """Step 3: Configure LLDP forwarding."""
        self.state = "lldp_init"
        logger.info("--- Step 3: LLDP forwarding ---")
        configure_lldp_forwarding(self.config.bridge["name"])

    def _init_gptp(self):
        """Step 4: Start gPTP (ptp4l + phc2sys)."""
        self.state = "gptp_init"
        logger.info("--- Step 4: gPTP initialization ---")
        self.gptp = GptpManager(
            self.config.gptp,
            self.config.get_hw_timestamp_interfaces(),
        )
        self.gptp.start()

    def _init_stats(self):
        """Step 5: Initialize stats collection."""
        self.state = "stats_init"
        logger.info("--- Step 5: Stats collection ---")
        all_ifaces = (
            [self.config.modem["wwan_interface"]]
            + self.config.get_tsn_interfaces()
            + [self.config.bridge["name"]]
        )
        self.stats = StatsCollector(all_ifaces)
        self.stats.collect()  # Initial read

    def _init_api(self):
        """Step 6: Start REST API and web dashboard."""
        self.state = "api_init"
        if not self.config.api.get("enabled", True):
            logger.info("API server disabled in config")
            return

        logger.info("--- Step 6: REST API & Web Dashboard ---")
        self.api_server = ApiServer(
            self.config.api["host"],
            self.config.api["port"],
            self,
        )
        self.api_server.start()

    def _main_loop(self):
        """Main loop: periodic health checks and stats collection."""
        self._running = True
        last_health = 0
        last_stats = 0

        while self._running:
            now = time.monotonic()

            # Stats collection
            if now - last_stats >= STATS_INTERVAL:
                self.stats.collect()
                last_stats = now

            # Health checks
            if now - last_health >= HEALTH_CHECK_INTERVAL:
                self._health_check()
                last_health = now

            # gPTP process watchdog
            if self.gptp:
                self.gptp.check_and_restart()

            time.sleep(0.5)

    def _health_check(self):
        """Periodic health check of all components."""
        issues = []

        if self.modem and not self.modem.check_health():
            issues.append("modem unresponsive")

        if self.bridge and not self.bridge.check_health():
            issues.append("bridge down")

        if self.gptp and not self.gptp.check_health():
            issues.append("gPTP not running")

        if issues:
            logger.warning("Health check issues: %s", ", ".join(issues))
        else:
            logger.debug("Health check: all OK")

    def shutdown(self):
        """Graceful shutdown of all components."""
        logger.info("Shutting down DS-TT daemon...")
        self._running = False
        self.state = "shutting_down"

        # Stop API server
        if self.api_server:
            self.api_server.stop()

        # Stop gPTP
        if self.gptp:
            self.gptp.stop()

        # Destroy bridge
        if self.bridge:
            self.bridge.destroy()

        # Close modem
        if self.modem:
            self.modem.close()

        self.state = "stopped"
        logger.info("DS-TT daemon stopped")
