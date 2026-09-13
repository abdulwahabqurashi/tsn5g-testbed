"""
Job handlers: the bridge between the JobManager and the Controller.

These used to be `_async` calls in api.py — fire a thread, return
`{"accepted": true}`, and record any failure in a single `last_error` string
that the UI could only poll for. As jobs they gain an id, a step timeline,
progress lines and cancellation.

The connect sequence still lives in `controller.connect()`. Rather than
restructure it here, a watcher mirrors `controller.step` into the job's step
timeline, which gives the UI real progress today. Phase 4 moves the bearer into
`net/bearer.py` with the six steps transcribed from ue_qmi_up.sh, at which
point the watcher goes away and the handler reports its own steps. The endpoint
contract does not change when that happens.
"""

import logging
import threading

from . import constants as C
from .core.jobs import LANE_BEARER, LANE_MODEM, LANE_NET, JobCancelled

logger = logging.getLogger("tsn5g-ue.jobs")

# STEP_BRIDGE is declared in CONNECT_STEPS but never assigned by
# transport_start(), so showing it would leave the UI with a step that can
# never complete. Advertise only the steps that actually happen.
_CONNECT_STEPS = [C.STEP_MODEM, C.STEP_TRANSPORT, C.STEP_LLDP, C.STEP_GPTP,
                  C.STEP_DONE]

_STEP_DETAIL = {
    C.STEP_MODEM: "attaching the modem and starting the PDU session",
    C.STEP_TRANSPORT: "building the data path",
    C.STEP_LLDP: "enabling LLDP forwarding",
    C.STEP_GPTP: "starting gPTP",
    C.STEP_DONE: "up",
}


class _StepWatcher:
    """Mirrors controller.step into a job's step timeline.

    Polling rather than a callback because the controller has no hook to
    register against, and adding one would mean touching the connect path
    that Phase 4 is going to rewrite anyway.
    """

    def __init__(self, controller, ctx, steps, interval=0.1):
        self._controller = controller
        self._ctx = ctx
        self._steps = steps
        self._interval = interval
        self._stop = threading.Event()
        self._thread = None
        self._seen = None

    def __enter__(self):
        self._ctx.plan(self._steps)
        # Open the first step up front rather than waiting for the poll to
        # notice it. transport_start can fail on a missing AT port in under a
        # millisecond, and attributing that to "modem" is the whole point.
        if self._steps:
            self._seen = self._steps[0]
            self._ctx.step(self._steps[0], _STEP_DETAIL.get(self._steps[0]))
        self._thread = threading.Thread(target=self._run, name="step-watch",
                                        daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(1.0)
        return False

    def _run(self):
        while not self._stop.wait(self._interval):
            step = getattr(self._controller, "step", None)
            if step and step != self._seen and step in self._steps:
                self._seen = step
                try:
                    self._ctx.step(step, _STEP_DETAIL.get(step))
                except JobCancelled:
                    return
                except Exception:       # noqa: BLE001
                    return


def register_all(jobs, controller):
    """Bind every job kind this phase provides."""

    # -- connect / disconnect ----------------------------------------------
    def connect(ctx):
        p = ctx.params
        with _StepWatcher(controller, ctx, _CONNECT_STEPS):
            controller.connect(mode=p.get("mode"), dnn=p.get("dnn"),
                               wired_nics=p.get("wired_nics"),
                               role=p.get("role"))
        ctx.log("connected")
        return controller.snapshot()

    def disconnect(ctx):
        ctx.plan(["teardown"])
        ctx.step("teardown", "stopping gPTP, TAS, transport and the modem")
        controller.disconnect()
        ctx.log("disconnected")
        return {"ok": True}

    jobs.register("bearer.connect", connect, LANE_BEARER)
    jobs.register("bearer.disconnect", disconnect, LANE_BEARER,
                  confirm=False)

    # -- guided-setup steps -------------------------------------------------
    def modem_check(ctx):
        ctx.plan(["check"])
        ctx.step("check", "SIM, operator, registration, signal")
        result = controller.modem_check()
        ctx.log(f"registered={result.get('registered')} "
                f"operator={result.get('operator')}")
        return result

    def transport_start(ctx):
        p = ctx.params
        with _StepWatcher(controller, ctx,
                          [C.STEP_MODEM, C.STEP_TRANSPORT, C.STEP_LLDP,
                           C.STEP_DONE]):
            result = controller.transport_start(
                mode=p.get("mode"), dnn=p.get("dnn"),
                wired_nics=p.get("wired_nics"), role=p.get("role"),
                vlan_map=p.get("vlan_map"))
        return result

    def gptp_start(ctx):
        ctx.plan(["ptp4l"])
        ctx.step("ptp4l", "starting the time-sync daemon")
        return controller.gptp_start(iface=ctx.params.get("iface"))

    jobs.register("modem.check", modem_check, LANE_MODEM)
    jobs.register("net.transport_start", transport_start, LANE_NET)
    jobs.register("net.gptp_start", gptp_start, LANE_NET)

    # -- wifi ---------------------------------------------------------------
    def wifi_connect(ctx):
        ssid = ctx.params.get("ssid")
        ctx.plan(["associate"])
        ctx.step("associate", f"joining {ssid}")
        result = controller.wifi_connect(ssid, psk=ctx.params.get("psk"))
        ctx.log(f"joined {ssid}")
        return result

    jobs.register("net.wifi_connect", wifi_connect, LANE_NET)

    # -- modem hardware -----------------------------------------------------
    def modem_rescan(ctx):
        ctx.plan(["probe"])
        ctx.step("probe", "looking for the AT and QMI devices")
        ports = controller.bus.rescan()
        ctx.log(f"at={ports['at']} qmi={ports['qmi']} model={ports['model']}")
        if not ports["at"]:
            ctx.log("no AT port answered. Is ModemManager masked?")
        return ports

    def modem_power(ctx):
        mode = ctx.params.get("radio")
        ctx.plan(["set", "verify"])
        ctx.step("set", f"radio {mode}")
        state = controller.power.set_radio(mode, ctx=ctx)
        ctx.step("verify", "reading CFUN back")
        ctx.log(f"CFUN={state.get('cfun')} radio={state.get('radio')}")
        return state

    def modem_reset(ctx):
        ctx.plan(["reset", "re-enumerate"])
        ctx.step("reset", "AT+CFUN=1,1")
        result = controller.power.reset(ctx=ctx)
        ctx.step("re-enumerate", f"back at {result.get('port')}")
        return result

    def modem_manager(ctx):
        action = ctx.params.get("action")
        ctx.plan([action])
        ctx.step(action, f"systemctl {action} ModemManager")
        from .modem import power as power_mod
        state = power_mod.set_modemmanager(action, ctx=ctx)
        ctx.log(f"ModemManager is now {state.get('state')}")
        return state

    def modem_at(ctx):
        """A confirmed WARN-list AT command. Long enough to need progress."""
        from .modem.bus import AtError, P_HIGH
        cmd = ctx.params.get("cmd")
        timeout = ctx.params.get("timeout", 30)
        ctx.plan(["send"])
        ctx.step("send", cmd)
        try:
            lines = controller.bus.command(cmd, timeout=timeout,
                                           priority=P_HIGH, reason="console")
        except AtError as exc:
            # A command that re-enumerates USB never gets to answer. Say so
            # rather than reporting a failure the operator did not cause.
            if exc.kind in ("io", "timeout") and "CFUN=1,1" in cmd.upper():
                ctx.log("port dropped, as expected for a reset")
                controller.bus.invalidate_port()
                return {"cmd": cmd, "ok": True, "lines": [],
                        "note": "modem re-enumerated"}
            raise
        for line in lines:
            ctx.log(line)
        return {"cmd": cmd, "ok": True, "lines": lines}

    jobs.register("modem.rescan", modem_rescan, LANE_MODEM)
    jobs.register("modem.power", modem_power, LANE_MODEM, confirm=True,
                  explain="Powering the radio down drops the 5G bearer and "
                          "deregisters the UE.")
    jobs.register("modem.reset", modem_reset, LANE_MODEM, confirm=True,
                  cancellable=False,
                  explain="AT+CFUN=1,1 power-cycles the RM520N. USB "
                          "re-enumerates, so the AT and QMI devices disappear "
                          "for about 40 seconds and the bearer drops.")
    jobs.register("modem.manager", modem_manager, LANE_MODEM, confirm=True,
                  explain="Unmasking ModemManager lets it contend for "
                          "/dev/ttyUSB* and rewrite radio preferences.")
    jobs.register("modem.at", modem_at, LANE_MODEM, confirm=True,
                  explain="This AT command can drop the link.")

    # -- the data call ------------------------------------------------------
    def bearer_up(ctx):
        p = ctx.params
        return controller.bearer.up(
            ctx=ctx, apn=p.get("apn"), ip_type=p.get("ip_type", 4),
            extra_routes=p.get("routes"),
            default_route=bool(p.get("default_route")),
            write_dns=bool(p.get("dns")))

    def bearer_down(ctx):
        return controller.bearer.down(ctx=ctx)

    def bearer_cycle(ctx):
        ctx.log("stopping the current call")
        controller.bearer.down(ctx=None)
        ctx.log("starting a new one")
        # The SMF hands out a fresh address every call, so anything pinned to
        # the old one is now stale. Phase 4's routing profile re-applies here.
        return controller.bearer.up(ctx=ctx, apn=ctx.params.get("apn"))

    jobs.register("bearer.up", bearer_up, LANE_BEARER)
    jobs.register("bearer.down", bearer_down, LANE_BEARER, confirm=True,
                  explain="Stops the 5G data call. Anything using the link "
                          "loses it, and the next call gets a different "
                          "address.")
    jobs.register("bearer.cycle", bearer_cycle, LANE_BEARER, confirm=True,
                  explain="Stops and restarts the data call. The UE address "
                          "will change, so policy routing pinned to the old "
                          "one becomes stale.")

    # -- policy routing -----------------------------------------------------
    def routing_apply(ctx):
        return controller.routing.apply(ctx.params.get("spec") or ctx.params,
                                        ctx=ctx)

    def routing_clear(ctx):
        return controller.routing.clear(ctx=ctx)

    jobs.register("net.routing_apply", routing_apply, LANE_NET)
    jobs.register("net.routing_clear", routing_clear, LANE_NET, confirm=True,
                  explain="Removes the policy-routing rules. Traffic that was "
                          "going over 5G returns to the wired path.")

    # -- registration -------------------------------------------------------
    def radio_prefs(ctx):
        p = ctx.params
        return controller.radio.set_prefs(
            mode_pref=p.get("mode_pref"), nr5g_band=p.get("nr5g_band"),
            nr5g_disable_mode=p.get("nr5g_disable_mode"), ctx=ctx)

    def radio_plmn(ctx):
        p = ctx.params
        return controller.radio.select_plmn(
            plmn=p.get("plmn"), mode=p.get("mode", "manual"),
            act=p.get("act", 11), ctx=ctx)

    def radio_clear_forbidden(ctx):
        return controller.radio.clear_forbidden(ctx.params["plmn"], ctx=ctx)

    def radio_lock(ctx):
        p = ctx.params
        return controller.radio.set_cell_lock(
            arfcn=p["arfcn"], scs=p.get("scs", 1), band=p.get("band", 78),
            pci=p.get("pci", 1), ctx=ctx)

    def radio_unlock(ctx):
        return controller.radio.clear_cell_lock(ctx=ctx)

    def radio_scan(ctx):
        """Suspend telemetry: a 4-minute scan would otherwise make every poll
        skip and report stale readings for the duration."""
        poller = getattr(controller, "signal_poller", None)
        was = poller.enabled if poller else None
        if poller:
            poller.configure(enabled=False)
            ctx.log("signal polling paused for the scan")
        try:
            return controller.radio.scan(kind=ctx.params.get("kind", "both"),
                                         ctx=ctx)
        finally:
            if poller and was is not None:
                poller.configure(enabled=was)
                ctx.log("signal polling resumed")

    def radio_camp(ctx):
        return controller.radio.wait_for_camp(
            timeout=ctx.params.get("timeout_s", 120), ctx=ctx)

    def radio_diagnose(ctx):
        return controller.radio.diagnose(ctx=ctx)

    def radio_repair_bands(ctx):
        return controller.radio.repair_bands(
            band=ctx.params.get("band", "78"), ctx=ctx)

    jobs.register("radio.prefs", radio_prefs, LANE_MODEM)
    jobs.register("radio.plmn", radio_plmn, LANE_MODEM, confirm=True,
                  explain="Re-selecting the operator deregisters first, so the "
                          "bearer drops until the UE camps again.")
    jobs.register("radio.clear_forbidden", radio_clear_forbidden, LANE_MODEM)
    jobs.register("radio.lock", radio_lock, LANE_MODEM, confirm=True,
                  explain="Locking to a cell power-cycles the radio. A wrong "
                          "ARFCN or PCI leaves the UE unable to camp at all "
                          "until the lock is cleared.")
    jobs.register("radio.unlock", radio_unlock, LANE_MODEM)
    jobs.register("radio.scan", radio_scan, LANE_MODEM)
    jobs.register("radio.camp", radio_camp, LANE_MODEM)
    jobs.register("radio.diagnose", radio_diagnose, LANE_MODEM)
    jobs.register("radio.repair_bands", radio_repair_bands, LANE_MODEM,
                  confirm=True,
                  explain="Rewrites the band mask, briefly powering the radio "
                          "down. Used when the mask is stuck at zero.")

    logger.debug("registered %d job kinds", len(jobs.kinds()))
    return jobs
