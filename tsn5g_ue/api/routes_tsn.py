"""
Transport, gPTP, TAS and the wired TSN switch.

Parked behind the UI's Advanced section, but the backend contracts are
unchanged — the long-running verbs simply become jobs.
"""


def register(router):

    # -- transport ----------------------------------------------------------
    @router.post("/api/transport/start")
    def transport_start(req):
        """Attach the modem and build the VXLAN/Ethernet data path."""
        return req.ctx.submit_job("net.transport_start", {
            "mode": req.opt("mode"), "dnn": req.opt("dnn"),
            "wired_nics": req.opt("wired_nics"), "role": req.opt("role"),
            "vlan_map": req.opt("vlan_map"),
        })

    @router.post("/api/transport/stop")
    def transport_stop(req):
        """Tear the data path down."""
        return req.ctx.controller.transport_stop()

    # -- gPTP ---------------------------------------------------------------
    @router.post("/api/gptp/start")
    def gptp_start(req):
        """Start ptp4l (and phc2sys if present) on the timestamping NIC."""
        return req.ctx.submit_job("net.gptp_start", {"iface": req.opt("iface")})

    @router.post("/api/gptp/stop")
    def gptp_stop(req):
        """Stop ptp4l."""
        return req.ctx.controller.gptp_stop()

    # -- TAS (DS-TT side, tc taprio) ----------------------------------------
    @router.get("/api/tas/profiles")
    def tas_profiles(req):
        """Named Qbv schedules, shared with the switch."""
        return {"profiles": req.ctx.controller.tas.list_profiles()}

    @router.post("/api/tas/apply")
    def tas_apply(req):
        """Apply a gate schedule. dry_run returns the tc command only."""
        return req.ctx.controller.tas_apply(
            iface=req.opt("iface"), profile=req.opt("profile"),
            slots=req.opt("slots"), cycle_ns=req.opt("cycle_ns"),
            dry_run=bool(req.opt("dry_run")))

    @router.post("/api/tas/clear")
    def tas_clear(req):
        """Remove the taprio qdisc."""
        return req.ctx.controller.tas_clear(iface=req.opt("iface"))

    # -- wired switch (FS TSN3220, Comware) ---------------------------------
    @router.get("/api/switch/profiles")
    def switch_profiles(req):
        """Named Qbv presets."""
        return {"profiles": req.ctx.controller.switch_profiles()}

    @router.get("/api/switch/status")
    def switch_status(req):
        """Reachability and current Qbv state.

        NOTE: credentials arrive as query parameters here, which puts a
        password in the request line. Kept for contract compatibility; Phase 7
        moves this to POST.
        """
        return req.ctx.controller.switch_status(
            host=req.q("host"), user=req.q("user", "admin"),
            password=req.q("password", ""), ports=req.q("ports"))

    @router.post("/api/switch/apply")
    def switch_apply(req):
        """Apply a preset, or a custom gate list when `slots` is present."""
        c = req.ctx.controller
        if req.body.get("slots"):
            host, user, slots = req.require("host", "user", "slots")
            return c.apply_switch_custom(
                host=host, user=user, password=req.opt("password", ""),
                slots=slots, cycle_ns=req.opt("cycle_ns"),
                ports=req.opt("ports"), guard=bool(req.opt("guard", True)),
                dry_run=bool(req.opt("dry_run")))
        host, user, profile = req.require("host", "user", "profile")
        return c.apply_switch_profile(
            host=host, user=user, password=req.opt("password", ""),
            profile=profile, ports=req.opt("ports"),
            dry_run=bool(req.opt("dry_run")))

    @router.post("/api/switch/disable")
    def switch_disable(req):
        """Turn Qbv off on the given ports."""
        host, user = req.require("host", "user")
        return req.ctx.controller.disable_switch(
            host=host, user=user, password=req.opt("password", ""),
            ports=req.opt("ports"))
