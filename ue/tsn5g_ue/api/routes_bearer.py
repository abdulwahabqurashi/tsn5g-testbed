"""The 5G data call."""

from ..net import dscpaudit, lanes, qdisc
from .router import ApiError


def register(router):

    @router.get("/api/bearer/queue")
    def queue_get(req):
        """The egress queue policy, what the kernel actually has, and the lanes.

        Config and kernel are reported side by side deliberately. They can
        disagree — a policy that failed to apply leaves the previous queue in
        place and the configured value still reads correctly — and reporting
        only one of them is how that goes unnoticed.
        """
        b = getattr(req.ctx.controller, "bearer", None)
        if b is None:
            raise ApiError(503, "bearer manager not available")
        return {
            "policy": b.queue_policy, "limit": b.queue_limit,
            "be_mbps": b.queue_be_mbps, "link_mbps": b.queue_link_mbps,
            "policies": list(qdisc.POLICIES),
            "live": qdisc.describe(b.iface, b.queue_policy, b.queue_limit,
                                   be_mbps=b.autorate.effective_be_mbps()),
            "classes": lanes.describe(b.iface, b.egress_classes),
            "autorate": {k: v for k, v in b.autorate.status().items() if k != "history"},
        }

    @router.put("/api/bearer/queue")
    def queue_set(req):
        """Change the egress queue policy and apply it to the live bearer.

        Applied immediately rather than at the next data call: this is the
        control that demonstrates the whole point of the queue, and a switch
        that needed a re-dial would drop the very streams it is meant to be
        protecting.

        Rebuilding the root qdisc discards whatever is queued at that instant,
        so expect a sub-second blip on traffic in flight. That is the cost of
        switching policy live and is the reason this is a deliberate action
        rather than something applied on a timer.
        """
        b = getattr(req.ctx.controller, "bearer", None)
        if b is None:
            raise ApiError(503, "bearer manager not available")

        policy = req.choice("policy", qdisc.POLICIES, default=b.queue_policy)
        limit = req.integer("limit", default=b.queue_limit, lo=1, hi=10000)
        be_mbps = req.integer("be_mbps", default=b.queue_be_mbps, lo=1, hi=10000)
        link_mbps = req.integer("link_mbps", default=b.queue_link_mbps,
                                lo=1, hi=10000)
        if policy == qdisc.LIMITED and be_mbps >= link_mbps:
            raise ApiError(400, f"a best-effort cap of {be_mbps} Mbit/s on a "
                                f"{link_mbps} Mbit/s link caps nothing — the "
                                f"whole point is that it is smaller")

        try:
            live = qdisc.apply(b.iface, policy, limit, priomap=b.queue_priomap,
                               be_mbps=be_mbps, link_mbps=link_mbps)
        except qdisc.QdiscError as exc:
            # The previous queue is still in place; say so rather than leaving
            # the caller to assume the change took.
            raise ApiError(409, f"{exc} — the previous queue is unchanged") from None

        b.queue_policy, b.queue_limit = policy, limit
        b.queue_be_mbps, b.queue_link_mbps = be_mbps, link_mbps
        # The tree was rebuilt with static rates; let auto-rate re-take it (or
        # stand down, if the new policy is not 'limited').
        b.autorate.restart()
        # Persist the complete block: the overlay replaces this sub-dict rather
        # than merging into it, so a partial write would drop the other keys.
        req.ctx.controller.config.update({"modem": {"egress_queue": {
            "policy": policy, "limit": limit,
            "be_mbps": be_mbps, "link_mbps": link_mbps}}})

        return {"policy": policy, "limit": limit, "be_mbps": be_mbps,
                "link_mbps": link_mbps, "live": live,
                "classes": lanes.describe(b.iface, b.egress_classes)}

    @router.get("/api/bearer/autorate")
    def autorate_get(req):
        """Auto-rate state: current shaping rate, round trip, load, history."""
        b = getattr(req.ctx.controller, "bearer", None)
        if b is None:
            raise ApiError(503, "bearer manager not available")
        return b.autorate.status()

    @router.put("/api/bearer/autorate")
    def autorate_set(req):
        """Turn auto-rate on or off and tune it. Saved to modem.autorate.

        Body (all optional): enabled, min_mbps, max_mbps, reserve_mbps,
        delay_hi_ms, delay_lo_ms. Needs the 'limited' queue policy to act.
        """
        b = getattr(req.ctx.controller, "bearer", None)
        if b is None:
            raise ApiError(503, "bearer manager not available")
        body = req.body
        kw = {k: body.get(k) for k in ("enabled", "min_mbps", "max_mbps",
                                        "reserve_mbps", "delay_hi_ms", "delay_lo_ms")}
        try:
            cfg = b.autorate.configure(**kw)
        except (ValueError, TypeError) as exc:
            raise ApiError(400, str(exc)) from None
        req.ctx.controller.config.update({"modem": {"autorate": {
            k: cfg[k] for k in ("enabled", "min_mbps", "max_mbps", "reserve_mbps",
                                "delay_hi_ms", "delay_lo_ms")}}})
        import time as _t
        _t.sleep(1.0)       # let it take the tree, so the reply shows it running
        return b.autorate.status()

    @router.get("/api/bearer/counters")
    def counters(req):
        """Cumulative counters, per lane and per camera, for live rates.

        Cumulative rather than rates: the caller takes two readings and
        divides by `t`, so two clients polling at different speeds cannot
        disturb each other's numbers. `t` is monotonic seconds.

        Per-camera counts are whole datagrams leaving on the bearer (before
        fragmentation); the qdisc and class counts are packets after it.
        Installs a camera's counting rule the first time if it is missing.
        """
        import time
        b = getattr(req.ctx.controller, "bearer", None)
        if b is None:
            raise ApiError(503, "bearer manager not available")
        return {"t": time.monotonic(), "interface": b.iface,
                "policy": b.queue_policy, "be_mbps": b.autorate.effective_be_mbps(),
                "link_mbps": b.queue_link_mbps,
                "qdisc": qdisc.stats(b.iface),
                "streams": lanes.counters(b.iface, b.egress_classes)}

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

    @router.post("/api/bearer/rebuild")
    def rebuild(req):
        """Build a NEW PDU session, not just a new data call.

        The core reads QoS configuration only at session establishment, and
        /api/bearer/cycle does not establish one — it stops the data call and
        resumes the same session. After any QoS change on the core this is the
        endpoint that makes it live.
        """
        return req.ctx.submit_job("bearer.rebuild",
                                  {"confirm": req.confirmed,
                                   "apn": req.opt("apn")})

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
