"""
Daemon — process wrapper. Sets up logging and the core services, builds the
Controller, starts the API server, and runs the periodic loop until signalled.

Boot order is deliberate: the API comes up first so the UI is reachable even if
hardware detection goes wrong. The Controller then decides whether to
auto-resume a previous session; the connect sequence is never driven from here.
"""

import logging
import os
import signal
import time

from . import __app_name__, __version__
from . import constants as C
from .api import ApiServer, AppContext
from .api.server import build_router
from .config import Config
from .controller import Controller
from .core.events import EventBus, TOPIC_ALERT, TOPIC_STATE, TOPIC_STATS
from .core.jobs import JobManager
from .core.logbuf import AuditLog, RingLogHandler, audited_run
from .core.store import Store
from .jobdefs import register_all
from .stats import StatsCollector

logger = logging.getLogger("tsn5g-ue")

# How often the state snapshot is pushed to SSE subscribers. Slower than the
# stats tick because it only changes when something happens.
STATE_PUSH_INTERVAL = 2.0
PRUNE_INTERVAL = 6 * 3600


class Daemon:
    def __init__(self, config_path, log_level_override=None):
        self.config = Config(config_path)
        level = (log_level_override or self.config.log_level).upper()
        logging.basicConfig(
            level=getattr(logging, level, logging.INFO),
            format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

        # --- core services, before anything that might want to use them ---
        self.bus = EventBus()
        self.logbuf = RingLogHandler(bus=self.bus)
        self.logbuf.setFormatter(logging.Formatter("%(message)s"))
        logging.getLogger().addHandler(self.logbuf)

        self.store = Store(self._db_path()).start()
        self.audit = AuditLog(bus=self.bus, store=self.store)
        audited_run.install(self.audit)          # wraps utils.run() in place

        self.jobs = JobManager(bus=self.bus, store=self.store)

        self.controller = Controller(self.config, events=self.bus,
                                     store=self.store, audit=self.audit)
        register_all(self.jobs, self.controller)

        core_ip = (self.config.vxlan or {}).get("core_ip")
        self.stats = StatsCollector(
            self._monitored_interfaces(),
            link_target=core_ip,
            link_iface=self.config.modem.get("wwan_interface", "wwan0"))

        # B5: the latency probe was frozen at boot because nothing ever
        # called set_link_target(). The bearer retargets it on every bring-up.
        self.controller.bearer.stats = self.stats

        self.api_server = None
        self._running = False
        self._last_state = None

        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)

    def _db_path(self):
        """History lives beside the state file, i.e. under StateDirectory."""
        state_file = self.config.state_file
        return os.path.join(os.path.dirname(state_file) or ".", "tsn5g.db")

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

        # 1) API first, so the UI is reachable even if the modem is absent.
        if self.config.api.get("enabled", True):
            ctx = AppContext(
                controller=self.controller, stats=self.stats, jobs=self.jobs,
                bus=self.bus, store=self.store, logbuf=self.logbuf,
                audit=self.audit, config=self.config,
                version={"version": __version__, "app": __app_name__},
                router=build_router())
            ctx.started = time.time()
            self.api_server = ApiServer(
                host=self.config.api.get("host", "0.0.0.0"),
                port=self.config.api.get("port", C.DEFAULT_API_PORT),
                ctx=ctx)
            self.api_server.start()

        # 2) Detect hardware and optionally auto-resume the last-good session.
        self.controller.start()

        # 2b) Rebuild the 5G session by itself when nothing reaches the core
        #     (a gNB restart leaves the modem "up" and silent).
        from .watchdog import LinkWatchdog
        lat = self.config.as_dict().get("latency") or {}
        self.watchdog = LinkWatchdog(self.controller, self.jobs,
                                     after_s=int(lat.get("auto_rebuild_s", 90)))
        self.controller.watchdog = self.watchdog
        self.watchdog.start()

        # 3) Radio telemetry on its own thread, so a slow AT read cannot
        #    delay stats collection or health checks.
        self.controller.signal_poller.start()

        # 4) Periodic work.
        self._main_loop()
        return 0

    def _main_loop(self):
        self._running = True
        last_stats = last_health = last_state = 0.0
        last_prune = time.monotonic()
        while self._running:
            now = time.monotonic()

            if now - last_stats >= C.STATS_INTERVAL:
                self.stats.collect()
                last_stats = now
                self._publish(TOPIC_STATS, self.stats.get_stats())

            if now - last_health >= C.HEALTH_CHECK_INTERVAL:
                h = self.controller.health()
                if not h["healthy"] and self.controller.state == C.STATE_RUNNING:
                    logger.warning("health issues: %s", h["checks"])
                    self._publish(TOPIC_ALERT,
                                  {"kind": "health", "checks": h["checks"]})
                last_health = now

            if now - last_state >= STATE_PUSH_INTERVAL:
                self._push_state()
                last_state = now

            if now - last_prune >= PRUNE_INTERVAL:
                self.store.prune()
                last_prune = now

            time.sleep(C.MAIN_LOOP_TICK)
        self.shutdown()

    def _push_state(self):
        """Publish the snapshot, but only when it has actually changed.

        The UI polls today and streams after Phase 2; either way, pushing an
        identical blob every two seconds is noise that would evict genuinely
        interesting events from the replay ring.
        """
        try:
            snap = self.controller.snapshot()
        except Exception as exc:            # noqa: BLE001
            logger.debug("snapshot failed: %s", exc)
            return
        fingerprint = (snap.get("state"), snap.get("step"),
                       snap.get("active_mode"), snap.get("last_error"))
        if fingerprint == self._last_state:
            return
        self._last_state = fingerprint
        self._publish(TOPIC_STATE, snap)

    def _publish(self, topic, data):
        try:
            self.bus.publish(topic, data)
        except Exception:                   # noqa: BLE001
            logger.debug("publish on %s failed", topic, exc_info=True)

    def _on_signal(self, signum, _frame):
        logger.info("signal %d — shutting down", signum)
        self._running = False

    def shutdown(self):
        logger.info("shutting down...")
        # Stop accepting work before tearing the hardware down, or a job could
        # be reconfiguring the modem while disconnect() detaches it.
        self.controller.signal_poller.stop()
        if getattr(self, "watchdog", None):
            self.watchdog.stop()
        cancelled = self.jobs.cancel_all(timeout=5.0)
        if cancelled:
            logger.info("cancelled %d running job(s)", cancelled)
        if self.api_server:
            self.api_server.stop()

        # Deliberately NOT disconnecting.
        #
        # This used to call controller.disconnect(), so every `systemctl
        # restart` dropped the 5G data call and every overlay interface with
        # it. Restarts happen for upgrades, crashes and config changes — none
        # of which are reasons to take a production bearer down, and the
        # operator has no way to know that is what happened.
        #
        # The bearer lives in the modem and the kernel, not in this process.
        # It survives us, which is also why the QMI packet-data handle is
        # persisted to /run: a new instance can stop a call this one started.
        # Tearing down is an explicit action (POST /api/bearer/down), never a
        # side effect of restarting.
        try:
            self.controller.gptp.stop()
        except Exception as exc:            # noqa: BLE001
            logger.debug("gptp stop: %s", exc)
        self.controller.bus.stop()
        self.store.stop()
        logger.info("stopped")
