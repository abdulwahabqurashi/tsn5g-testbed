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
from .core.jobs import (LANE_BEARER, LANE_MODEM, LANE_NET, JobCancelled)

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

    logger.debug("registered %d job kinds", len(jobs.kinds()))
    return jobs
