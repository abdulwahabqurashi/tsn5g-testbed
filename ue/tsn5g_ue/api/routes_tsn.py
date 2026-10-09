"""
Transport, gPTP, TAS and the wired TSN switch.

Parked behind the UI's Advanced section, but the backend contracts are
unchanged — the long-running verbs simply become jobs.
"""


from .. import gptp as gptp_mod
from .router import ApiError


def register(router):

    # -- transport ----------------------------------------------------------
    @router.post("/api/transport/start")
    def transport_start(req):
        """Attach the modem and build the VXLAN/Ethernet data path."""
        if not req.ctx.controller.overlay_allowed():
            raise ApiError(409, "the old VXLAN overlay is off on this rig (transport.overlay: false); "
                                "the cameras use their own tunnels: Cameras -> Video path")
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

    @router.post("/api/gptp/restart")
    def gptp_restart(req):
        """Stop and start ptp4l + phc2sys with the current settings."""
        return req.ctx.submit_job("net.gptp_restart", {})

    @router.get("/api/ptp/nics")
    def ptp_nics(req):
        """Physical NICs that can do hardware PTP, best candidate first."""
        from .. import ptp_setup
        g = req.ctx.controller.gptp
        cams = tuple(c.get("interface") for c in req.ctx.controller.config.cameras or [])
        return {**ptp_setup.list_nics(configured=g.phys_iface, camera_ifaces=cams,
                                      vlan=g.vlan),
                "dependencies": ptp_setup.dependencies(),
                "running_on": g.status.get("interface") if g.status.get("running") else None}

    @router.post("/api/ptp/dependencies/install")
    def ptp_install(req):
        """apt-get install linuxptp / ethtool if missing."""
        return req.ctx.submit_job("ptp.install", {})

    @router.post("/api/ptp/setup")
    def ptp_setup_run(req):
        """The guided start: install if needed, check the NIC, apply settings,
        start, wait for lock, verify CLOCK_TAI. Each step reports as it goes.

        Body: interface (required), profile, vlan (null = untagged), domain,
        utc_offset, install (default true), persist (default true).
        """
        iface = req.require("interface")
        vlan = req.body.get("vlan", "__keep__")
        settings = {
            "profile": req.choice("profile", gptp_mod.PROFILES),
            "vlan": None if vlan in ("__keep__", None, "") else int(vlan),
            "clear_vlan": vlan in (None, ""),
            "domain": req.integer("domain", lo=0, hi=255),
            "utc_offset": req.integer("utc_offset", lo=0, hi=100),
        }
        return req.ctx.submit_job("ptp.setup", {
            "interface": iface, "settings": settings,
            "install": req.body.get("install", True) is not False,
            "persist": req.body.get("persist", True) is not False})

    @router.get("/api/ptp/settings")
    def ptp_settings_get(req):
        """What the next start will use."""
        g = req.ctx.controller.gptp
        return {"settings": g.settings(), "running": g.status.get("running"),
                "profiles": list(gptp_mod.PROFILES), "interfaces":
                g.get_status().get("interfaces", [])}

    @router.put("/api/ptp/settings")
    def ptp_settings_set(req):
        """Change profile, port, VLAN, domain or UTC offset.

        Takes effect at the next start, not immediately: ptp4l reads its
        configuration once. The response says whether a restart is needed, and
        the UI offers it, rather than restarting behind the operator's back —
        a restart drops lock for tens of seconds, and a gate anchored to the
        clock in that window is anchored to nothing.

        `persist` writes the block to the settings overlay so it survives a
        daemon restart; without it the change lasts until the daemon stops.
        """
        g = req.ctx.controller.gptp
        body = req.body
        vlan = body.get("vlan", "__keep__")
        try:
            settings = g.configure(
                profile=req.choice("profile", gptp_mod.PROFILES),
                interface=req.opt("interface"),
                vlan=None if vlan in ("__keep__", None, "") else vlan,
                clear_vlan=vlan in (None, ""),
                domain=req.integer("domain", lo=0, hi=255),
                utc_offset=req.integer("utc_offset", lo=0, hi=100),
                client_only=body.get("client_only"))
        except ValueError as exc:
            raise ApiError(400, str(exc)) from None
        persisted = False
        if body.get("persist"):
            cfg = req.ctx.controller.config
            # The whole block: the overlay replaces a sub-dict rather than
            # merging into it, so a partial write would drop `enabled`.
            block = dict(cfg.as_dict().get("ptp") or {})
            block.update({k: v for k, v in settings.items()})
            block.setdefault("enabled", g.enabled)
            cfg.update({"ptp": block})
            persisted = True
        running = bool(g.status.get("running"))
        return {"settings": settings, "persisted": persisted,
                "restart_needed": running,
                "note": ("saved; restart PTP to apply" if running
                         else "saved; applies when PTP starts")}

    @router.get("/api/ptp/history")
    def ptp_history(req):
        """Offsets once a second and lock/unlock events, for the charts."""
        try:
            minutes = max(1, min(60, int((req.query.get("minutes") or ["60"])[0])))
        except ValueError:
            minutes = 60
        return req.ctx.controller.gptp.history(minutes)

    @router.get("/api/ptp/status")
    def ptp_status(req):
        """Clock state, and whether it is fit to anchor a gate schedule.

        `gate_clock_ok` is the field worth reading before trusting any
        time-aware measurement: it is false while the servo is unlocked or the
        kernel TAI offset disagrees with the configured one, either of which
        leaves a Qbv schedule anchored to something other than real TAI without
        anything else complaining.
        """
        return req.ctx.controller.gptp.get_status()

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
