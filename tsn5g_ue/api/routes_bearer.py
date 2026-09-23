"""The 5G data call."""

from ..net import dscpaudit
from .router import ApiError


def register(router):

    @router.get("/api/bearer")
    def state(req):
        """Address, routes, MTU and the QMI handle that can stop the call."""
        b = getattr(req.ctx.controller, "bearer", None)
        if b is None:
            raise ApiError(503, "bearer manager not available")
        return b.status()

    @router.post("/api/bearer/up")
    def up(req):
        """Start the data call. Six steps, mirroring ue_qmi_up.sh."""
        params = {
            "apn": req.opt("apn"),
            "ip_type": req.integer("ip_type", default=4, lo=4, hi=6),
            "routes": req.opt("routes"),
            "dns": bool(req.opt("dns")),
        }
        if req.opt("default_route"):
            # Routing every packet over the modem includes the SSH session this
            # request arrived on, so it is opt-in in config as well as here.
            allowed = (req.ctx.config.api or {}).get("allow_default_via_modem")
            if not allowed:
                raise ApiError(
                    403,
                    "a default route via the modem is disabled. It would send "
                    "all traffic — including this session — over 5G. Set "
                    "api.allow_default_via_modem: true to permit it.")
            if not req.confirmed:
                raise ApiError(428, "confirmation required",
                               explain="This routes ALL traffic over the 5G "
                                       "link, including the connection you are "
                                       "using right now.")
            params["default_route"] = True
        return req.ctx.submit_job("bearer.up", params)

    @router.post("/api/bearer/down")
    def down(req):
        """Stop the data call."""
        return req.ctx.submit_job("bearer.down", {"confirm": req.confirmed})

    @router.post("/api/bearer/cycle")
    def cycle(req):
        """Stop and restart. The UE address will change."""
        return req.ctx.submit_job("bearer.cycle",
                                  {"confirm": req.confirmed, "apn": req.opt("apn")})

    @router.post("/api/bearer/dscp-audit")
    def dscp_audit_install(req):
        """Count each DSCP as it leaves the bearer, after encapsulation.

        The outer DSCP is what uplink QoS flow binding matches on, so it is
        the one field the core's packet filters depend on. Configuration
        reporting a value is not evidence it reaches the wire.
        """
        b = req.ctx.controller.bearer
        dscps = req.opt("dscp") or req.ctx.controller.configured_dscps()
        return dscpaudit.install(b.iface, dscps)

    @router.get("/api/bearer/dscp-audit")
    def dscp_audit_read(req):
        return dscpaudit.read(req.ctx.controller.bearer.iface)

    @router.delete("/api/bearer/dscp-audit")
    def dscp_audit_remove(req):
        return {"removed": dscpaudit.remove(req.ctx.controller.bearer.iface)}
