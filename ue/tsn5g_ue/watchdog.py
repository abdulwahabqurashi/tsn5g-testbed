"""
Rebuild the 5G session by itself when nothing gets through.

When the gNB restarts (a crash, or the core's health check), the modem keeps
its address and its data call looks up, but it never reconnects: on 6 and 8
Oct the gNB showed no UE and no attach attempt for hours. Only a session
rebuild (AT+CFUN=0/1, then a new PDU session) brings it back.

The latency probe already knows when the core stopped answering. After
`after_s` of silence the watchdog pings the core over the bearer once more,
so a stopped reflector alone does not cost a rebuild, and then submits the
same `bearer.rebuild` job the 5G Link page's button runs. At most one attempt
per `gap_s`, so a gNB that is down for good is not hammered.
"""

import logging
import threading
import time

from . import utils
from .core.jobs import LaneBusy

logger = logging.getLogger("tsn5g-ue.watchdog")


class LinkWatchdog:
    def __init__(self, controller, jobs, after_s=90, gap_s=600, interval_s=10):
        self.controller, self.jobs = controller, jobs
        self.after_s, self.gap_s, self.interval_s = after_s, gap_s, interval_s
        self._last = 0.0
        self._stop = threading.Event()
        self._thread = None
        self.state = {"enabled": after_s > 0, "last_attempt": None, "last_job": None, "reason": None}

    def start(self):
        if self.after_s <= 0:
            self.state["reason"] = "disabled (latency.auto_rebuild_s: 0)"
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name="link-watchdog")
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(self.interval_s):
            try:
                self._check()
            except Exception:                       # noqa: BLE001 — a watchdog must not die
                logger.exception("link watchdog check failed")

    def _check(self):
        silent = self.controller.latency.core_silent_s()
        if silent is None or silent < self.after_s:
            return
        if time.monotonic() - self._last < self.gap_s:
            return
        bearer = self.controller.bearer
        target = self.controller.latency.target
        ping = utils.run(["ping", "-c", "2", "-W", "2", "-I", bearer.iface, target], check=False, timeout=10)
        if ping.returncode == 0:
            self.state["reason"] = f"core silent on the probe for {silent:.0f} s but answers ping: reflector down?"
            return
        self._last = time.monotonic()
        self.state["last_attempt"] = time.time()
        logger.warning("nothing has reached the core for %.0f s; rebuilding the 5G session", silent)
        try:
            job = self.jobs.submit("bearer.rebuild", {"confirm": True}, actor="watchdog")
            self.state.update(last_job=job.id, reason=f"rebuilt after {silent:.0f} s of silence")
        except LaneBusy as exc:
            self.state["reason"] = f"wanted to rebuild, but {exc}"
            self._last = 0.0                        # try again at the next check
