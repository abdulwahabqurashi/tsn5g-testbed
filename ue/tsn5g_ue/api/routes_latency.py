"""Live one-way latency in the camera lanes (net/latency.py)."""

from .router import ApiError


def register(router):

    def _probe(req):
        p = getattr(req.ctx.controller, "latency", None)
        if p is None:
            raise ApiError(503, "latency probe not available")
        return p

    @router.get("/api/latency")
    def latency_status(req):
        """Probe state and the latest second per lane (up/down one-way delay in ms),
        plus the link watchdog (auto-rebuild of a silent 5G session)."""
        wd = getattr(req.ctx.controller, "watchdog", None)
        return {**_probe(req).status(), "watchdog": dict(wd.state) if wd else None}

    @router.get("/api/latency/history")
    def latency_history(req):
        """Per-second rows per lane, for the chart."""
        try:
            minutes = max(1, min(60, int((req.query.get("minutes") or ["15"])[0])))
        except ValueError:
            minutes = 15
        return _probe(req).get_history(minutes)

    @router.put("/api/latency")
    def latency_set(req):
        """Turn the probe on or off, or change its rate (1-200 packets/s per lane)."""
        try:
            return _probe(req).configure(enabled=req.opt("enabled"), rate_hz=req.opt("rate_hz"))
        except ValueError as exc:
            raise ApiError(400, str(exc)) from None
