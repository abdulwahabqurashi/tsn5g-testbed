"""
ModemBus — the sole owner of the modem's AT serial port.

Every AT command in this process goes through here, and exactly one worker
thread ever touches the serial handle. That is not tidiness: `at.py`, the
sixteen reference scripts and `iperf5g.sh`'s radio sampling all open
/dev/ttyUSB* exclusively with no locking, and two owners produce
"device reports readiness to read but returned no data" — which is precisely
the error this rig produced when a connect job and a modem check overlapped.

Three things this fixes beyond serialisation:

**The reader.** The previous implementation stopped when the string "OK"
appeared anywhere in the buffer, with a 3-second default. `AT+COPS=?` returns
operator names that can contain "OK", and `AT+QSCAN` runs for minutes — both
were silently truncated. This reads until the last non-blank line is a real
terminator, which is what at.py does and the only version that has ever been
correct here.

**Priorities.** A 4-minute `AT+QSCAN` must not make the UI's signal poller
queue up 120 stale requests. Telemetry uses `try_command`, which returns None
immediately if the bus is busy, and the caller reports the reading as stale.

**Port churn.** The AT port moves between boots (it was ttyUSB2 in the docs and
is ttyUSB3 today) and disappears entirely for ~40 s after `AT+CFUN=1,1`
re-enumerates USB. `invalidate_port()` re-probes with backoff instead of
failing.
"""

import glob
import logging
import os
import queue
import threading
import time

from .. import utils

logger = logging.getLogger("tsn5g-ue.modem.bus")

# Lower runs first.
P_URGENT = 0        # CFUN, abort — must not wait behind a scan
P_HIGH = 10         # interactive UI actions
P_NORMAL = 20       # telemetry
P_BULK = 30         # QSCAN, COPS=? — minutes long

# A response is complete when the last non-blank line is one of these.
_TERMINATORS = ("OK", "ERROR", "NO CARRIER", "ABORTED", "CONNECT")
_ERROR_PREFIXES = ("+CME ERROR", "+CMS ERROR", "ERROR")

DEFAULT_BAUD = 115200
DEFAULT_TIMEOUT = 5.0
# Close the port when idle so at.py and the reference scripts still work for
# manual debugging without stopping the service.
DEFAULT_HOLD_OPEN = 10.0


class AtError(RuntimeError):
    """An AT command failed, timed out, or there was no port to send it on."""

    def __init__(self, cmd, reply, kind="error"):
        self.cmd = cmd
        self.reply = reply
        self.kind = kind            # error | cme | cms | timeout | noport | io
        super().__init__(f"{cmd!r}: {reply}" if reply else f"{cmd!r}: {kind}")


class BusBusy(RuntimeError):
    """try_command() found the bus occupied."""


class _Request:
    __slots__ = ("cmds", "timeout", "priority", "seq", "cancel", "done",
                 "results", "error", "stop_on_error", "reason")

    def __init__(self, cmds, timeout, priority, seq, cancel, stop_on_error, reason):
        self.cmds = cmds
        self.timeout = timeout
        self.priority = priority
        self.seq = seq
        self.cancel = cancel
        self.stop_on_error = stop_on_error
        self.reason = reason
        self.done = threading.Event()
        self.results = []
        self.error = None

    # PriorityQueue orders on this; seq breaks ties so equal priorities stay FIFO.
    def __lt__(self, other):
        return (self.priority, self.seq) < (other.priority, other.seq)


def probe_at_port(dev, baud=DEFAULT_BAUD, timeout=1.0):
    """Is `dev` the AT port? Returns (bool, model|None). Never raises.

    A real AT port answers `AT` with OK; the diagnostic, NMEA and GNSS ports on
    the same modem do not, which is how the right one of four ttyUSB devices is
    identified.
    """
    try:
        import serial
    except ImportError:
        return (False, None)
    try:
        with serial.Serial(dev, baud, timeout=timeout) as s:
            s.reset_input_buffer()
            s.write(b"ATE0\r\n")
            time.sleep(0.15)
            s.reset_input_buffer()
            s.write(b"AT\r\n")
            time.sleep(0.2)
            if "OK" not in s.read(256).decode(errors="ignore"):
                return (False, None)
            s.reset_input_buffer()
            s.write(b"AT+CGMM\r\n")
            time.sleep(0.2)
            model = None
            for ln in s.read(256).decode(errors="ignore").splitlines():
                ln = ln.strip()
                if ln and ln != "OK" and not ln.upper().startswith("AT"):
                    model = ln
                    break
            return (True, model)
    except Exception:       # noqa: BLE001 — serial fails many ways; all mean "not it"
        return (False, None)


def find_ports(configured_at=None, configured_qmi=None, baud=DEFAULT_BAUD):
    """Locate the AT and QMI devices by probing. Never raises."""
    if not utils.is_linux():
        return {"at": configured_at, "qmi": configured_qmi, "model": None,
                "candidates": []}

    if configured_qmi and os.path.exists(configured_qmi):
        qmi = configured_qmi
    else:
        wdms = sorted(glob.glob("/dev/cdc-wdm*"))
        qmi = wdms[0] if wdms else None

    candidates = []
    if configured_at and os.path.exists(configured_at):
        candidates.append(configured_at)
    for dev in sorted(glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*")):
        if dev not in candidates:
            candidates.append(dev)

    at = model = None
    for dev in candidates:
        found, found_model = probe_at_port(dev, baud)
        if found:
            at, model = dev, found_model
            if found_model:
                break

    return {"at": at, "qmi": qmi, "model": model, "candidates": candidates}


class ModemBus:
    """Serialises all AT access behind one worker thread."""

    def __init__(self, config=None, audit=None, events=None,
                 hold_open=DEFAULT_HOLD_OPEN):
        cfg = config or {}
        self._configured_at = cfg.get("device")
        self._configured_qmi = cfg.get("qmi_device")
        self._baud = cfg.get("baud_rate", DEFAULT_BAUD)
        self._hold_open = cfg.get("hold_open_s", hold_open)
        self._audit = audit
        self._events = events

        self._queue = queue.PriorityQueue()
        self._seq = 0
        self._seq_lock = threading.Lock()
        self._serial = None
        self._port = None
        self._model = None
        self._qmi = None
        self._candidates = []
        self._last_error = None
        self._last_use = 0.0
        self._busy_with = None
        self._busy_since = None
        self._reserved_by = None
        self._reserve_lock = threading.RLock()
        self._stop = threading.Event()
        self._worker = threading.Thread(target=self._run, name="modem-bus",
                                        daemon=True)
        self._worker.start()

    # -- submission ---------------------------------------------------------
    def command(self, cmd, timeout=DEFAULT_TIMEOUT, priority=P_NORMAL,
                cancel=None, reason=None):
        """Run one AT command; return its response lines. Raises AtError."""
        results = self.script([cmd], timeout=timeout, priority=priority,
                              cancel=cancel, reason=reason)
        _, outcome = results[0]
        if isinstance(outcome, AtError):
            raise outcome
        return outcome

    def script(self, cmds, timeout=DEFAULT_TIMEOUT, priority=P_NORMAL,
               cancel=None, stop_on_error=True, reason=None):
        """Run several commands as one indivisible turn on the port.

        Nothing else can interleave between them, which matters for sequences
        like CFUN=0 / write / CFUN=1 where a telemetry poll landing in the
        middle would read a half-configured modem.

        Returns [(cmd, lines|AtError), ...].
        """
        with self._seq_lock:
            self._seq += 1
            seq = self._seq
        req = _Request(list(cmds), timeout, priority, seq, cancel,
                       stop_on_error, reason)
        self._queue.put(req)
        # Wait generously: the worker enforces the real per-command deadline.
        req.done.wait(timeout * len(cmds) + 30)
        if not req.done.is_set():
            raise AtError(cmds[0] if cmds else "?", "bus did not answer", "timeout")
        if req.error:
            raise req.error
        return req.results

    def try_command(self, cmd, timeout=DEFAULT_TIMEOUT, reason=None):
        """Run `cmd` only if the bus is free right now; otherwise return None.

        Telemetry uses this. A 4-minute network scan must not leave 120 stale
        signal polls queued behind it, each one reporting a reading from before
        the scan started.
        """
        if self.busy:
            return None
        try:
            return self.command(cmd, timeout=timeout, priority=P_NORMAL,
                                reason=reason)
        except AtError:
            return None

    # -- exclusive access ---------------------------------------------------
    class _Reservation:
        def __init__(self, bus, reason):
            self._bus = bus
            self._reason = reason

        def __enter__(self):
            self._bus._reserve_lock.acquire()       # noqa: SLF001
            self._bus._reserved_by = self._reason   # noqa: SLF001
            return self._bus

        def __exit__(self, *exc):
            self._bus._reserved_by = None           # noqa: SLF001
            self._bus._reserve_lock.release()       # noqa: SLF001
            return False

    def reserve(self, reason):
        """Hold the bus across several script() calls (context manager)."""
        return self._Reservation(self, reason)

    # -- lifecycle ----------------------------------------------------------
    def release(self):
        """Close the serial port so at.py or a reference script can use it.

        The port reopens on the next command, so this is safe to call at any
        time — it costs one reconnect, not a broken session.
        """
        self._close("released on request")
        return {"released": True, "port": self._port}

    def invalidate_port(self, settle=5.0, deadline=120.0):
        """Forget the current port and re-probe. Used after AT+CFUN=1,1.

        A full modem reset re-enumerates USB: the device node disappears for
        roughly 40 seconds and may come back with a different number.
        """
        self._close("port invalidated")
        self._port = None
        self._model = None
        time.sleep(settle)
        end = time.monotonic() + deadline
        attempt = 0
        while time.monotonic() < end:
            attempt += 1
            ports = find_ports(self._configured_at, self._configured_qmi, self._baud)
            if ports["at"]:
                self._port = ports["at"]
                self._model = ports["model"]
                self._qmi = ports["qmi"]
                self._candidates = ports["candidates"]
                logger.info("modem port re-appeared at %s after %.0fs",
                            self._port, deadline - (end - time.monotonic()))
                self._emit({"event": "port", "port": self._port, "model": self._model})
                return self._port
            self._emit({"event": "port-wait", "attempt": attempt})
            time.sleep(2.0)
        raise AtError("<rescan>", "modem did not re-appear", "noport")

    def rescan(self):
        """Re-probe for the AT and QMI devices now."""
        self._close("rescan")
        ports = find_ports(self._configured_at, self._configured_qmi, self._baud)
        self._port = ports["at"]
        self._model = ports["model"]
        self._qmi = ports["qmi"]
        self._candidates = ports["candidates"]
        logger.info("modem ports: at=%s qmi=%s model=%s",
                    self._port, self._qmi, self._model)
        return self.ports()

    def ports(self):
        if self._port is None and not self._candidates:
            self.rescan()
        return {
            "at": self._port, "qmi": self._qmi, "model": self._model,
            "candidates": self._candidates,
        }

    def stop(self):
        self._stop.set()
        self._queue.put(_Request([], 0, -1, 0, None, True, "stop"))
        self._worker.join(5)
        self._close("shutting down")

    # -- introspection ------------------------------------------------------
    @property
    def busy(self):
        return self._busy_with is not None

    def status(self):
        return {
            "port": self._port,
            "model": self._model,
            "qmi_device": self._qmi,
            "open": self._serial is not None,
            "queue_depth": self._queue.qsize(),
            "busy": self.busy,
            "busy_with": self._busy_with,
            "busy_for_s": round(time.monotonic() - self._busy_since, 1)
                          if self._busy_since else None,
            "reserved_by": self._reserved_by,
            "last_error": self._last_error,
            "candidates": self._candidates,
            "hold_open_s": self._hold_open,
        }

    # -- worker -------------------------------------------------------------
    def _run(self):
        while not self._stop.is_set():
            try:
                req = self._queue.get(timeout=0.5)
            except queue.Empty:
                # Drop the port when idle so external tools can have it.
                if (self._serial is not None and self._hold_open
                        and time.monotonic() - self._last_use > self._hold_open):
                    self._close("idle")
                continue

            if self._stop.is_set() or not req.cmds:
                req.done.set()
                continue

            self._busy_with = req.reason or req.cmds[0]
            self._busy_since = time.monotonic()
            try:
                self._serve(req)
            except Exception as exc:        # noqa: BLE001 — never kill the worker
                req.error = exc if isinstance(exc, AtError) else AtError(
                    req.cmds[0], str(exc), "io")
                logger.debug("bus request failed", exc_info=True)
            finally:
                self._busy_with = None
                self._busy_since = None
                self._last_use = time.monotonic()
                req.done.set()

    def _serve(self, req):
        self._open()
        for cmd in req.cmds:
            if req.cancel is not None and req.cancel.is_set():
                req.results.append((cmd, AtError(cmd, "cancelled", "cancelled")))
                break
            t0 = time.monotonic()
            try:
                lines = self._transact(cmd, req.timeout, req.cancel)
                req.results.append((cmd, lines))
                self._record(cmd, lines, None, (time.monotonic() - t0) * 1000)
            except AtError as exc:
                req.results.append((cmd, exc))
                self._last_error = str(exc)
                self._record(cmd, None, exc, (time.monotonic() - t0) * 1000)
                if req.stop_on_error:
                    break

    def _transact(self, cmd, timeout, cancel=None):
        """Write one command and read until a real terminator or the deadline."""
        try:
            self._serial.reset_input_buffer()
            self._serial.write((cmd + "\r\n").encode())
            self._serial.flush()
        except Exception as exc:            # noqa: BLE001
            self._close(f"write failed: {exc}")
            raise AtError(cmd, str(exc), "io") from exc

        deadline = time.monotonic() + timeout
        buf = ""
        while time.monotonic() < deadline:
            if cancel is not None and cancel.is_set():
                # QSCAN and COPS=? abort on any received character. Best-effort:
                # a command already committed in firmware cannot be recalled.
                try:
                    self._serial.write(b"\r")
                    time.sleep(0.3)
                    self._serial.reset_input_buffer()
                except Exception:           # noqa: BLE001
                    pass
                raise AtError(cmd, "cancelled", "cancelled")
            try:
                chunk = self._serial.read(512).decode(errors="ignore")
            except Exception as exc:        # noqa: BLE001
                self._close(f"read failed: {exc}")
                raise AtError(cmd, str(exc), "io") from exc
            if chunk:
                buf += chunk
            if _is_complete(buf):
                break
        else:
            raise AtError(cmd, f"no terminator within {timeout}s", "timeout")

        lines = [ln.strip() for ln in buf.splitlines() if ln.strip()]
        # Drop the echoed command if ATE0 did not take.
        if lines and lines[0].upper().startswith(cmd.split("=")[0].upper()[:6]) \
                and lines[0].upper() == cmd.upper():
            lines = lines[1:]

        last = lines[-1] if lines else ""
        upper = last.upper()
        if upper.startswith("+CME ERROR"):
            raise AtError(cmd, last, "cme")
        if upper.startswith("+CMS ERROR"):
            raise AtError(cmd, last, "cms")
        if upper == "ERROR":
            raise AtError(cmd, " | ".join(lines) or "ERROR", "error")

        return [ln for ln in lines if ln.upper() not in ("OK",)]

    # -- port ---------------------------------------------------------------
    def _open(self):
        if self._serial is not None:
            return
        try:
            import serial
        except ImportError as exc:
            raise AtError("<open>", "pyserial not installed", "noport") from exc

        if not self._port or not os.path.exists(self._port):
            ports = find_ports(self._configured_at, self._configured_qmi, self._baud)
            self._port = ports["at"]
            self._qmi = ports["qmi"]
            self._model = ports["model"] or self._model
            self._candidates = ports["candidates"]
        if not self._port:
            raise AtError("<open>",
                          "no responsive AT port among /dev/ttyUSB*, /dev/ttyACM* "
                          "(is ModemManager masked?)", "noport")
        try:
            self._serial = serial.Serial(self._port, self._baud, timeout=0.4)
        except Exception as exc:            # noqa: BLE001
            self._serial = None
            raise AtError("<open>", f"{self._port}: {exc}", "io") from exc

        try:
            self._transact("ATE0", 2.0)     # echo off, so replies are just replies
        except AtError:
            pass                            # some firmwares answer oddly here

    def _close(self, why=""):
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:               # noqa: BLE001
                pass
            logger.debug("AT port closed (%s)", why)
        self._serial = None

    # -- audit / events -----------------------------------------------------
    def _record(self, cmd, lines, error, ms):
        if self._audit is not None:
            try:
                self._audit.record(
                    "at", self._port or "?", cmd,
                    rc=0 if error is None else 1,
                    out=" | ".join(lines) if lines else "",
                    err=str(error) if error else "",
                    ms=ms)
            except Exception:               # noqa: BLE001
                pass

    def _emit(self, data):
        if self._events is None:
            return
        try:
            from ..core.events import TOPIC_MODEM
            self._events.publish(TOPIC_MODEM, data)
        except Exception:                   # noqa: BLE001
            pass


def _is_complete(buf):
    """True when the buffer ends in a real terminator line.

    The old check was `"OK" in buf`, which matched "OK" anywhere — including
    inside an operator name from AT+COPS=? — and truncated the response.
    """
    lines = [ln.strip() for ln in buf.splitlines() if ln.strip()]
    if not lines:
        return False
    last = lines[-1].upper()
    if last in _TERMINATORS:
        return True
    return any(last.startswith(p) for p in _ERROR_PREFIXES)
