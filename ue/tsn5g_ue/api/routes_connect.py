"""
Connect / disconnect and the guided-setup steps.

These were the five `_async` call sites: fire a thread, return
`{"accepted": true}`, and fold every failure into a single `last_error` string.
They are jobs now, so the UI gets a job id, a step timeline, live progress lines
and cancellation. Phase 4 splits the bearer out of `controller.connect()` into
`net/bearer.py` with the six steps from ue_qmi_up.sh; the endpoint shape here
does not change when that happens.
"""


def register(router):

    @router.post("/api/connect")
    def connect(req):
        """Run the full attach sequence: modem -> transport -> gptp."""
        return req.ctx.submit_job("bearer.connect", {
            "mode": req.opt("mode"), "dnn": req.opt("dnn"),
            "wired_nics": req.opt("wired_nics"), "role": req.opt("role"),
        })

    @router.post("/api/disconnect")
    def disconnect(req):
        """Tear down gptp, TAS, transport and the modem attach."""
        return req.ctx.submit_job("bearer.disconnect", {})

    @router.post("/api/modem/check")
    def modem_check(req):
        """Non-destructive probe: SIM, operator, registration, signal."""
        return req.ctx.submit_job("modem.check", {})

    @router.get("/api/setup/state")
    def setup_state(req):
        """Per-step completion, so the wizard survives a page refresh.

        The old UI tracked this in client-side booleans, which meant progress
        was lost on reload and a session established from another browser was
        invisible.
        """
        return req.ctx.controller.setup_state()
