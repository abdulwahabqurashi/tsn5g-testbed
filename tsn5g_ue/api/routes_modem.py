"""Modem hardware: ports, power, reset, ModemManager, and the raw AT console."""

from ..core.safety import (DIAG_COMMANDS, CommandDenied, ConfirmNeeded,
                           classify, describe)
from ..modem import power as power_mod
from .router import ApiError


def register(router):

    # -- identity and ports -------------------------------------------------
    @router.get("/api/modem")
    def modem(req):
        """Bus state, QMI state and modem identity."""
        c = req.ctx.controller
        out = {
            "bus": c.bus.status() if getattr(c, "bus", None) else None,
            "modem": c.modem.get_status() if c.modem else None,
            "qmi": c.qmi.status() if getattr(c, "qmi", None) else None,
            "power": c.power.get() if getattr(c, "power", None) else None,
        }
        if getattr(c, "identity", None):
            out["identity"] = c.identity
        return out

    @router.get("/api/modem/ports")
    def ports(req):
        """The AT and QMI devices, and everything that was probed."""
        if not getattr(req.ctx.controller, "bus", None):
            raise ApiError(503, "modem bus not available")
        return req.ctx.controller.bus.ports()

    @router.post("/api/modem/ports/rescan")
    def rescan(req):
        """Re-probe for the modem. The AT port moves between boots."""
        return req.ctx.submit_job("modem.rescan", {})

    # -- power --------------------------------------------------------------
    @router.get("/api/modem/power")
    def get_power(req):
        """CFUN state plus whether ModemManager is contending for the port."""
        if not getattr(req.ctx.controller, "power", None):
            raise ApiError(503, "modem power control not available")
        return req.ctx.controller.power.get()

    @router.put("/api/modem/power")
    def set_power(req):
        """Radio on / off / airplane."""
        radio = req.choice("radio", ("on", "off", "airplane"), required=True)
        params = {"radio": radio, "confirm": req.confirmed}
        return req.ctx.submit_job("modem.power", params)

    @router.post("/api/modem/reset")
    def reset(req):
        """AT+CFUN=1,1. USB re-enumerates; takes about 40 seconds."""
        return req.ctx.submit_job("modem.reset", {"confirm": req.confirmed})

    # -- ModemManager -------------------------------------------------------
    @router.get("/api/modem/manager")
    def get_mm(req):
        """Is ModemManager masked, and is it running right now?"""
        return power_mod.modemmanager_state()

    @router.put("/api/modem/manager")
    def set_mm(req):
        """Mask or unmask ModemManager.

        `stop` alone is not enough — it is D-Bus activated and returns the
        moment anything asks for a modem. Masking is what holds it down.
        """
        action = req.choice("action", ("mask", "unmask"), required=True)
        return req.ctx.submit_job("modem.manager",
                                  {"action": action, "confirm": req.confirmed})

    # -- raw AT console -----------------------------------------------------
    @router.get("/api/modem/at/rules")
    def at_rules(req):
        """The safety rules, so the console can explain a refusal."""
        return {**describe(), "diag": [{"cmd": c, "label": l} for c, l in DIAG_COMMANDS]}

    @router.post("/api/modem/at")
    def at_command(req):
        """Send one AT command.

        Refused outright if it destroys the device's configuration or the path
        this daemon uses to reach it; gated behind confirm if it will drop the
        link. See core/safety.py for the list and the reasoning.
        """
        cmd = req.require("cmd")
        timeout = req.integer("timeout", default=8, lo=1, hi=300)
        if not getattr(req.ctx.controller, "bus", None):
            raise ApiError(503, "modem bus not available")

        try:
            verdict = _check(cmd, req.confirmed)
        except CommandDenied as exc:
            _audit_denied(req, cmd, exc.reason)
            raise ApiError(403, exc.reason, denied=True, rule=exc.rule) from exc
        except ConfirmNeeded as exc:
            raise ApiError(428, "confirmation required", explain=exc.explain,
                           rule=exc.rule) from exc

        # Warned commands take long enough to need progress, and can drop the
        # link — so they run as a job rather than blocking a request thread.
        if verdict == "warn":
            return req.ctx.submit_job("modem.at", {"cmd": cmd, "timeout": timeout,
                                                   "confirm": True})

        from ..modem.bus import AtError, P_HIGH
        import time
        t0 = time.monotonic()
        try:
            lines = req.ctx.controller.bus.command(
                cmd, timeout=timeout, priority=P_HIGH, reason="console")
        except AtError as exc:
            return {"cmd": cmd, "ok": False, "kind": exc.kind,
                    "error": str(exc), "lines": [],
                    "ms": round((time.monotonic() - t0) * 1000, 1)}
        return {"cmd": cmd, "ok": True, "lines": lines,
                "ms": round((time.monotonic() - t0) * 1000, 1)}

    @router.get("/api/modem/at/history")
    def at_history(req):
        """Recent AT transactions from the audit trail."""
        if req.ctx.audit is None:
            raise ApiError(503, "audit log not available")
        return {"commands": req.ctx.audit.tail(limit=req.q_int("limit", 100),
                                               kind="at")}

    @router.post("/api/modem/bus/release")
    def release(req):
        """Close the serial port so at.py and the reference scripts can use it.

        The bus reopens on the next command, so this costs one reconnect rather
        than breaking the session.
        """
        if not getattr(req.ctx.controller, "bus", None):
            raise ApiError(503, "modem bus not available")
        return req.ctx.controller.bus.release()


def _check(cmd, confirmed):
    verdict, reason, rule = classify(cmd)
    if verdict == "deny":
        raise CommandDenied(cmd, reason, rule)
    if verdict == "warn" and not confirmed:
        raise ConfirmNeeded(cmd, reason, rule)
    return verdict


def _audit_denied(req, cmd, reason):
    if req.ctx.audit is None:
        return
    try:
        req.ctx.audit.record("at", "console", cmd, rc=None, denied=True,
                             reason=reason, actor="ui")
    except Exception:       # noqa: BLE001
        pass
