"""
Signal telemetry: poll, publish, persist.

Runs on its own thread rather than in the daemon's main loop so a slow AT read
cannot delay stats collection or health checks.

Two behaviours worth stating:

**It skips rather than queues.** Reads go through `bus.try_command`, so a
four-minute `AT+QSCAN` does not leave two hundred stale polls stacked behind
it. A skipped read is published with `stale: true` — the UI says "stale"
instead of quietly showing a reading from before the scan began.

**It backs off when there is no modem.** On a box with the port missing there
is no point retrying at 2 Hz; the interval grows to a minute so the log does
not fill with the same failure.
"""

import logging
import threading
import time

logger = logging.getLogger("tsn5g-ue.modem.signal")

DEFAULT_INTERVAL = 2.0
IDLE_INTERVAL = 60.0        # when there is no modem to talk to
BRANCH_EVERY = 15           # per-antenna reads are slower; do them occasionally


class SignalPoller:
    def __init__(self, modem, bus, events=None, store=None,
                 interval=DEFAULT_INTERVAL):
        self.modem = modem
        self.bus = bus
        self.events = events
        self.store = store
        self.interval = interval
        self.enabled = True
        self.latest = None
        self._ticks = 0
        self._misses = 0
        self._stop = threading.Event()
        self._thread = None

    # -- lifecycle ----------------------------------------------------------
    def start(self):
        if self._thread:
            return self
        self._thread = threading.Thread(target=self._run, name="signal-poll",
                                        daemon=True)
        self._thread.start()
        logger.info("signal poller started (%.1fs)", self.interval)
        return self

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(3)
            self._thread = None

    def configure(self, interval=None, enabled=None):
        if interval is not None:
            self.interval = max(0.5, float(interval))
        if enabled is not None:
            self.enabled = bool(enabled)
        return self.settings()

    def settings(self):
        return {"interval_s": self.interval, "enabled": self.enabled}

    # -- read model ---------------------------------------------------------
    def current(self):
        if self.latest:
            return self.latest
        return {"ts": None, "stale": True, "rsrp": None, "rsrq": None,
                "sinr": None, "rssi": None, "rat": None, "band": None,
                "arfcn": None, "pci": None, "cellid": None}

    def sample_now(self):
        """Force one read, ignoring the schedule. Used by the UI's Sample button."""
        return self._sample(force=True)

    # -- worker -------------------------------------------------------------
    def _run(self):
        while not self._stop.wait(self._next_delay()):
            if not self.enabled:
                continue
            try:
                self._sample()
            except Exception:           # noqa: BLE001 — never kill the poller
                logger.debug("signal sample failed", exc_info=True)

    def _next_delay(self):
        # Back off hard when there is nothing to talk to.
        if self._misses > 5:
            return IDLE_INTERVAL
        return self.interval

    def _sample(self, force=False):
        self._ticks += 1
        sig = self.modem.refresh_signal()

        stale = bool(sig.get("stale"))
        if stale and not force:
            # Busy bus, not a missing modem — do not count it against backoff.
            self._publish({**self.current(), "stale": True})
            return self.current()

        if sig.get("rsrp") is None:
            self._misses += 1
        else:
            self._misses = 0

        sample = {
            "ts": time.time(),
            "stale": False,
            "rsrp": sig.get("rsrp"),
            "rsrq": sig.get("rsrq"),
            "sinr": sig.get("sinr"),
            "rssi": sig.get("rssi"),
            "rat": getattr(self.modem, "rat", None),
            "band": getattr(self.modem, "band", None),
            "arfcn": getattr(self.modem, "arfcn", None),
            "pci": getattr(self.modem, "pci", None),
            "cellid": getattr(self.modem, "cellid", None),
        }

        # Per-branch reads cost three more AT round trips, so they run at a
        # fraction of the rate. A single dead antenna shows here and nowhere
        # else — the serving-cell RSRP is the best branch, which hides it.
        if force or self._ticks % BRANCH_EVERY == 0:
            try:
                sample["branches"] = self.modem.branches()
            except Exception:           # noqa: BLE001
                sample["branches"] = None

        self.latest = sample
        self._publish(sample)
        if self.store is not None and sample["rsrp"] is not None:
            self.store.write_signal(sample)
        return sample

    def _publish(self, sample):
        if self.events is None:
            return
        try:
            from ..core.events import TOPIC_SIGNAL
            self.events.publish(TOPIC_SIGNAL, sample)
        except Exception:               # noqa: BLE001
            logger.debug("signal publish failed", exc_info=True)
