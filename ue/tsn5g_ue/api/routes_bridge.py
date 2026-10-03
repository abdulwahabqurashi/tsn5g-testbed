"""
Software TSN bridge: build the data path, gate it, classify into it.

Building and tearing down create and destroy interfaces, so both are jobs on
the `net` lane — they take seconds and the operator should see the steps.
Reads and dry runs are synchronous.
"""

from ..net import capture
from ..tsnbridge import profiles as bridge_profiles
from ..tsnbridge.manager import BridgeError
from .router import ApiError


def register(router):

    def _bridge(req):
        b = getattr(req.ctx.controller, "tsnbridge", None)
        if b is None:
            raise ApiError(503, "the TSN bridge is not available")
        return b

    # -- read model ---------------------------------------------------------
    @router.get("/api/bridge")
    def bridge_status(req):
        """Every class, its devices, and whether a gate is actually installed."""
        return _bridge(req).status()

    @router.get("/api/bridge/profiles")
    def bridge_profiles_list(req):
        """Gate profiles, resolved for this bridge's class count.

        The `fold` query decides who inherits a window belonging to a class this
        bridge does not have — the entries change with it, which is the point.
        """
        fold = req.q("fold") or None
        if fold and fold not in bridge_profiles.FOLD_CHOICES:
            raise ApiError(400, f"unknown fold '{fold}'. Choose one of: "
                                f"{', '.join(bridge_profiles.FOLD_CHOICES)}")
        return {"profiles": _bridge(req).profiles(fold=fold),
                "folds": list(bridge_profiles.FOLD_CHOICES)}

    # -- data path ----------------------------------------------------------
    @router.post("/api/bridge/build")
    def bridge_build(req):
        """Create the veth, tunnel, tag and bridge for one class or all."""
        if req.body.get("dry_run"):
            return _bridge(req).build(name=req.opt("name"), dry_run=True)
        return req.ctx.submit_job("bridge.build", {"name": req.opt("name")})

    @router.post("/api/bridge/teardown")
    def bridge_teardown(req):
        """Remove the devices. The bearer is untouched."""
        return req.ctx.submit_job("bridge.teardown", {"name": req.opt("name")})

    # -- gate ---------------------------------------------------------------
    @router.post("/api/bridge/capture")
    def bridge_capture(req):
        """Look at the wire once, to see the markings nothing else reports.

        The 802.1p PCP is inside the VXLAN payload, so no counter on this box
        can read it. This is the only way to confirm the inner tag and the
        outer DSCP are both right in the same frame — which is what an intact
        marking chain actually means.

        Bounded by packet count and by a timeout, and never run unbounded: a
        capture left going on a shared machine fills disks and reads traffic
        that is not ours.
        """
        dev = req.require("device")
        return capture.run(dev,
                           count=req.integer("count", default=50, lo=1, hi=200),
                           seconds=req.integer("seconds", default=10, lo=1, hi=20),
                           expression=req.opt("filter"))

    @router.get("/api/bridge/layouts")
    def bridge_layouts(req):
        """The configured class layouts and which one is active."""
        b = _bridge(req)
        return {"layout": b.layout, "layouts": b.layout_options()}

    @router.post("/api/bridge/layout")
    def bridge_layout_set(req):
        """Switch class layout, tear down the old one, persist the choice.

        Does not rebuild: the caller decides when interfaces appear, and a
        switch that half-built would be worse than one that built nothing.
        """
        name = req.require("name")
        b = _bridge(req)
        try:
            res = b.set_layout(name)
        except BridgeError as exc:
            raise ApiError(400, str(exc)) from None
        req.ctx.controller.config.update({"tsnbridge": {"layout": name}})
        return res

    @router.post("/api/bridge/gate")
    def bridge_gate(req):
        """Install a gate schedule on a class's veth."""
        name, profile = req.require("name", "profile")
        fold = req.opt("fold")
        if fold and fold not in bridge_profiles.FOLD_CHOICES:
            raise ApiError(400, f"unknown fold '{fold}'")
        # force lets an operator apply a profile the arithmetic says cannot
        # work — for a deliberate negative control, not for routine use.
        try:
            return _bridge(req).apply_gate(name, profile, fold=fold,
                                           dry_run=bool(req.opt("dry_run")),
                                           force=bool(req.opt("force")))
        except BridgeError as exc:
            # Choosing a profile this link cannot run is a request problem, not
            # a server fault. A 500 here would send an operator looking for a
            # bug instead of reading the sentence that tells them what to pick.
            raise ApiError(400, str(exc)) from None

    @router.delete("/api/bridge/gate")
    def bridge_gate_clear(req):
        name = req.require("name")
        return _bridge(req).clear_gate(name)

    # -- classification -----------------------------------------------------
    @router.post("/api/bridge/rules")
    def bridge_rule_add(req):
        """Mark a stream with a priority, on the output path.

        Output rather than ingress because the camera application terminates
        GigE Vision and emits new packets — an ingress rule on the camera port
        would mark frames that are then thrown away.
        """
        priority = req.integer("priority", lo=0, hi=7)
        spec = {
            "priority": priority,
            "proto": req.choice("proto", ("udp", "tcp"), default="udp"),
            "dport": req.opt("dport"), "sport": req.opt("sport"),
            "src": req.opt("src"), "dst": req.opt("dst"),
            "oif": req.opt("oif"),
        }
        if not any(spec.get(k) for k in ("dport", "sport", "src", "dst")):
            raise ApiError(400, "a rule needs something to match on — a port, "
                                "a source or a destination")
        return _bridge(req).add_rule(spec, dry_run=bool(req.opt("dry_run")))

    @router.delete("/api/bridge/rules")
    def bridge_rule_del(req):
        spec = {
            "priority": req.integer("priority", lo=0, hi=7),
            "proto": req.choice("proto", ("udp", "tcp"), default="udp"),
            "dport": req.opt("dport"), "sport": req.opt("sport"),
            "src": req.opt("src"), "dst": req.opt("dst"),
            "oif": req.opt("oif"),
        }
        return _bridge(req).remove_rule(spec)
