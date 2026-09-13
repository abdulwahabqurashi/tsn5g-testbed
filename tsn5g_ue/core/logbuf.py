"""
In-memory log ring and command audit trail.

Two separate concerns that happen to share a shape:

* :class:`RingLogHandler` is a ``logging.Handler``. It keeps the last N records
  so ``GET /api/logs`` can answer without shelling out to journalctl, and
  mirrors INFO-and-above onto the event bus so the Logs view can tail live.
* :class:`AuditLog` records *what the daemon did to the hardware* — every
  shelled command and every AT transaction, with argv, exit code, timing and
  output heads. This is the record that makes a UE debuggable without SSH, and
  it is deliberately not the same thing as the Python log.

Both are bounded. Neither ever raises into its caller: a logging subsystem that
can fail a modem command is worse than no logging.
"""

import collections
import itertools
import logging
import threading
import time

from .events import TOPIC_AUDIT, TOPIC_LOG

DEFAULT_LOG_CAPACITY = 2000
DEFAULT_AUDIT_CAPACITY = 500

# How much of a command's output to keep. Enough to see the error, not enough
# for a 4-minute network scan to sit in RAM forever.
OUTPUT_HEAD_CHARS = 2000


class RingLogHandler(logging.Handler):
    """Keeps recent log records and mirrors them to the event bus.

    DEBUG records are kept in the ring but NOT published: with ``-l debug``
    every shelled command is logged, which would flood the stream and starve
    the events that matter.
    """

    def __init__(self, capacity=DEFAULT_LOG_CAPACITY, bus=None,
                 publish_level=logging.INFO):
        super().__init__()
        self._ring = collections.deque(maxlen=capacity)
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._bus = bus
        self._publish_level = publish_level
        # Publishing can itself log (the bus warns when it drops a subscriber),
        # which would re-enter this handler. Guard per-thread rather than with a
        # lock, so the re-entrant call is skipped instead of deadlocking.
        self._local = threading.local()

    def attach_bus(self, bus):
        self._bus = bus

    def emit(self, record):
        if getattr(self._local, "busy", False):
            return
        try:
            entry = {
                "id": None,
                "ts": record.created,
                "level": record.levelname,
                "levelno": record.levelno,
                "logger": record.name,
                "message": self.format(record),
            }
            with self._lock:
                entry["id"] = next(self._ids)
                self._ring.append(entry)

            if self._bus is not None and record.levelno >= self._publish_level:
                self._local.busy = True
                try:
                    self._bus.publish(TOPIC_LOG, entry)
                finally:
                    self._local.busy = False
        except Exception:      # noqa: BLE001 - never break the caller
            self.handleError(record)

    # -- read model ---------------------------------------------------------
    def tail(self, since_id=None, level=None, logger_name=None, limit=200):
        """Records newer than `since_id`, filtered, oldest first."""
        minlevel = logging.getLevelName(level.upper()) if isinstance(level, str) else level
        if not isinstance(minlevel, int):
            minlevel = 0
        with self._lock:
            items = list(self._ring)
        out = []
        for e in items:
            if since_id is not None and e["id"] <= since_id:
                continue
            if e["levelno"] < minlevel:
                continue
            if logger_name and not e["logger"].startswith(logger_name):
                continue
            out.append(e)
        return out[-limit:] if limit else out

    @property
    def last_id(self):
        with self._lock:
            return self._ring[-1]["id"] if self._ring else 0


def _head(text, limit=OUTPUT_HEAD_CHARS):
    if not text:
        return ""
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [{len(text) - limit} more chars]"


class AuditLog:
    """Ring of hardware-facing actions: shell commands and AT transactions."""

    def __init__(self, capacity=DEFAULT_AUDIT_CAPACITY, bus=None, store=None):
        self._ring = collections.deque(maxlen=capacity)
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._bus = bus
        self._store = store

    def attach(self, bus=None, store=None):
        if bus is not None:
            self._bus = bus
        if store is not None:
            self._store = store

    def record(self, kind, target, cmd, rc=None, out=None, err=None,
               ms=None, actor="daemon", denied=False, reason=None):
        """Append one action.

        kind:   "shell" | "at" | "qmi"
        target: the device or host it acted on (/dev/ttyUSB2, 192.168.1.1, ...)
        cmd:    the argv or AT string, as a single displayable string
        """
        entry = {
            "id": None,
            "ts": time.time(),
            "actor": actor,
            "kind": kind,
            "target": target,
            "cmd": cmd,
            "rc": rc,
            "out_head": _head(out),
            "err_head": _head(err),
            "ms": round(ms, 1) if isinstance(ms, (int, float)) else None,
            "denied": denied,
            "reason": reason,
        }
        with self._lock:
            entry["id"] = next(self._ids)
            self._ring.append(entry)

        # Persistence and fan-out are best-effort: an audit failure must never
        # propagate into the operation being audited.
        if self._store is not None:
            try:
                self._store.write_audit(entry)
            except Exception:   # noqa: BLE001
                pass
        if self._bus is not None:
            try:
                self._bus.publish(TOPIC_AUDIT, entry)
            except Exception:   # noqa: BLE001
                pass
        return entry

    def tail(self, limit=100, kind=None):
        with self._lock:
            items = list(self._ring)
        if kind:
            items = [e for e in items if e["kind"] == kind]
        return items[-limit:] if limit else items


class _AuditedRun:
    """Wraps utils.run() so every shelled command lands in the audit log.

    Installed by the daemon at startup. Kept as a module-level indirection
    rather than threading an audit object through fifteen call sites.
    """

    def __init__(self):
        self.audit = None

    def install(self, audit):
        from .. import utils
        if getattr(utils, "_audit_installed", False):
            self.audit = audit
            utils._audit_sink = audit          # noqa: SLF001
            return
        self.audit = audit
        original = utils.run

        def audited_run(cmd, check=True, timeout=30, input_text=None):
            sink = getattr(utils, "_audit_sink", None)
            t0 = time.monotonic()
            try:
                proc = original(cmd, check=check, timeout=timeout,
                                input_text=input_text)
            except Exception as exc:            # noqa: BLE001
                if sink is not None:
                    rc = getattr(exc, "returncode", None)
                    sink.record("shell", cmd[0] if cmd else "?",
                                " ".join(cmd), rc=rc,
                                out=getattr(exc, "stdout", ""),
                                err=getattr(exc, "stderr", str(exc)),
                                ms=(time.monotonic() - t0) * 1000)
                raise
            if sink is not None:
                sink.record("shell", cmd[0] if cmd else "?", " ".join(cmd),
                            rc=proc.returncode, out=proc.stdout, err=proc.stderr,
                            ms=(time.monotonic() - t0) * 1000)
            return proc

        utils.run = audited_run
        utils._audit_sink = audit               # noqa: SLF001
        utils._audit_installed = True           # noqa: SLF001


audited_run = _AuditedRun()
