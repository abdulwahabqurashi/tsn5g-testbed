"""
Modem power, reset, and keeping ModemManager out of the way.

The ModemManager part matters more than it looks. `systemctl stop
ModemManager` is not enough — it is D-Bus activated, so anything that asks for
a modem brings it straight back, and then it takes /dev/ttyUSB* and rewrites
radio preferences underneath us. docs/reference/connect.sh masks it for exactly
this reason, and the daemon's unit logs a warning at boot when it is not masked.
"""

import logging
import time

from .. import utils
from . import parse
from .bus import AtError, P_URGENT

logger = logging.getLogger("tsn5g-ue.modem.power")

# CFUN values, 3GPP 27.007.
CFUN_MIN = 0        # radio and SIM off
CFUN_FULL = 1
CFUN_AIRPLANE = 4   # radio off, SIM on

RADIO_TO_CFUN = {"off": CFUN_MIN, "on": CFUN_FULL, "airplane": CFUN_AIRPLANE}

# Measured on this rig: AT+CFUN=1,1 drops USB for ~35-40 s.
RESET_SETTLE_S = 5.0
RESET_DEADLINE_S = 120.0


class PowerControl:
    def __init__(self, bus, events=None):
        self.bus = bus
        self.events = events

    # -- read ---------------------------------------------------------------
    def get(self):
        try:
            lines = self.bus.command("AT+CFUN?", timeout=5, reason="power-read")
            state = parse.cfun(lines)
        except AtError as exc:
            state = {"cfun": None, "radio": None, "raw": None, "error": str(exc)}
        state["modemmanager"] = modemmanager_state()
        return state

    # -- write --------------------------------------------------------------
    def set_radio(self, mode, ctx=None):
        """mode: 'on' | 'off' | 'airplane'."""
        if mode not in RADIO_TO_CFUN:
            raise ValueError(f"radio must be on, off or airplane; got {mode!r}")
        value = RADIO_TO_CFUN[mode]
        if ctx:
            ctx.log(f"AT+CFUN={value} ({mode})")
        # P_URGENT so a queued network scan cannot delay powering the radio down.
        self.bus.command(f"AT+CFUN={value}", timeout=20, priority=P_URGENT,
                         reason=f"radio-{mode}")
        # The modem takes a moment to settle before CFUN? reflects the change.
        time.sleep(1.0)
        return self.get()

    def reset(self, ctx=None):
        """AT+CFUN=1,1 — full reset, then wait for USB to come back.

        The reply never arrives: the device node disappears mid-command. The
        AtError from that is expected and is treated as success, which is why
        this cannot simply be `bus.command(...)`.
        """
        if ctx:
            ctx.log("AT+CFUN=1,1 — full modem reset")
            ctx.progress(5, "resetting")
        try:
            self.bus.command("AT+CFUN=1,1", timeout=8, priority=P_URGENT,
                             reason="reset")
        except AtError as exc:
            # io/timeout here means the port vanished, which is the reset working.
            if exc.kind not in ("io", "timeout"):
                raise
            logger.info("reset issued; port dropped as expected (%s)", exc.kind)

        if ctx:
            ctx.log("USB re-enumerating, this takes about 40 seconds")
            ctx.progress(15, "waiting for the modem to re-appear")

        started = time.monotonic()
        deadline = started + RESET_DEADLINE_S
        self.bus._close("modem reset")          # noqa: SLF001
        time.sleep(RESET_SETTLE_S)

        while time.monotonic() < deadline:
            elapsed = time.monotonic() - started
            if ctx:
                ctx.progress(min(90, 15 + int(elapsed / RESET_DEADLINE_S * 75)),
                             f"waiting… {elapsed:.0f}s")
                if ctx.cancel.is_set():
                    ctx.log("cancel requested, but the modem is mid-reset; "
                            "still waiting so it is not left half-initialised")
            try:
                port = self.bus.invalidate_port(settle=0.0, deadline=5.0)
            except AtError:
                continue
            if port:
                if ctx:
                    ctx.log(f"modem back at {port} after {elapsed:.0f}s")
                    ctx.progress(100, "back")
                return {"reset": True, "port": port, "took_s": round(elapsed, 1)}
        raise AtError("AT+CFUN=1,1",
                      f"modem did not re-appear within {RESET_DEADLINE_S:.0f}s",
                      "noport")


# -- ModemManager ----------------------------------------------------------
def modemmanager_state():
    """masked | enabled | disabled | absent, plus whether it is running now."""
    if not utils.have("systemctl"):
        return {"state": "unknown", "active": None}
    enabled = utils.run(["systemctl", "is-enabled", "ModemManager"],
                        check=False, timeout=10).stdout.strip()
    active = utils.run(["systemctl", "is-active", "ModemManager"],
                       check=False, timeout=10).stdout.strip()
    if not enabled:
        enabled = "absent"
    return {
        "state": enabled,
        "masked": enabled == "masked",
        "active": active == "active",
        "contending": active == "active",
    }


def set_modemmanager(action, ctx=None):
    """action: 'mask' | 'unmask'.

    Masking is `mask --now`, because stopping alone leaves it D-Bus activatable
    and it returns the moment anything asks for a modem.
    """
    if action not in ("mask", "unmask"):
        raise ValueError("action must be mask or unmask")
    if not utils.have("systemctl"):
        raise RuntimeError("systemctl not available")

    if action == "mask":
        if ctx:
            ctx.log("systemctl mask --now ModemManager")
        proc = utils.run(["systemctl", "mask", "--now", "ModemManager"],
                         check=False, timeout=30)
    else:
        if ctx:
            ctx.log("systemctl unmask ModemManager")
            ctx.log("WARNING: it will contend for /dev/ttyUSB* and may rewrite "
                    "radio preferences")
        proc = utils.run(["systemctl", "unmask", "ModemManager"],
                         check=False, timeout=30)

    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "systemctl failed").strip())
    return modemmanager_state()
