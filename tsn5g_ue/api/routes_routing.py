"""Policy routing: send one application's traffic over 5G and nothing else."""

from .router import ApiError


def _mgr(req):
    m = getattr(req.ctx.controller, "routing", None)
    if m is None:
        raise ApiError(503, "routing manager not available")
    return m


def register(router):

    @router.get("/api/net/routes")
    def routes(req):
        """What the kernel actually has: ip rule, the tables, and the
        mangle/nat rules. Read from the kernel, not from our own record."""
        return _mgr(req).live_rules()

    @router.get("/api/net/routing-profile")
    def get_profile(req):
        """The applied profile, and the built-in ones on offer."""
        m = _mgr(req)
        out = m.status()
        out["profiles"] = m.profiles()
        return out

    @router.put("/api/net/routing-profile")
    def apply_profile(req):
        """Install a profile.

        Verified before and after: if the route to the management peer moved,
        everything just added is rolled back automatically. By the time a human
        reads a warning about that, the session is already gone.
        """
        spec = {
            "name": req.opt("name", "custom"),
            "proto": req.choice("proto", ("udp", "tcp"), default="udp"),
            "dport": req.integer("dport", lo=1, hi=65535, required=True),
            "mark": req.opt("mark", "0x5"),
            "table": req.integer("table", default=5, lo=1, hi=252),
            "dev": req.opt("dev", "wwan0"),
            "masquerade": bool(req.opt("masquerade", True)),
            "verify_dst": req.opt("verify_dst"),
        }
        return req.ctx.submit_job("net.routing_apply", {"spec": spec})

    @router.delete("/api/net/routing-profile")
    def clear_profile(req):
        """Remove exactly the rules we added. Never flushes a chain."""
        return req.ctx.submit_job("net.routing_clear", {"confirm": req.confirmed})

    @router.post("/api/net/routing-profile/verify")
    def verify(req):
        """The three `ip route get` probes, without changing anything."""
        m = _mgr(req)
        spec = dict(m.status().get("spec") or {})
        if req.opt("verify_dst"):
            spec["verify_dst"] = req.opt("verify_dst")
        # With nothing applied there is still a useful answer: where does the
        # management path go right now? That is the baseline every later
        # comparison is made against, so refusing here was unhelpful.
        return m.verify(spec)
