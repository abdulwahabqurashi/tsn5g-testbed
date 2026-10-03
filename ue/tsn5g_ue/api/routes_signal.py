"""Radio telemetry: current reading, history, and poller control."""

import time

from .router import ApiError


def register(router):

    @router.get("/api/signal")
    def current(req):
        """The latest sample. `stale` means the bus was busy, not that the
        radio is gone — a four-minute scan legitimately blocks telemetry."""
        poller = getattr(req.ctx.controller, "signal_poller", None)
        if poller is None:
            raise ApiError(503, "signal poller not available")
        return poller.current()

    @router.post("/api/signal/sample")
    def sample(req):
        """Force one read now, bypassing the schedule."""
        poller = getattr(req.ctx.controller, "signal_poller", None)
        if poller is None:
            raise ApiError(503, "signal poller not available")
        return poller.sample_now()

    @router.get("/api/signal/history")
    def history(req):
        """Downsampled series. `step` buckets in SQL rather than sending
        43k rows/day to a browser that wants a few hundred points."""
        if req.ctx.store is None or not req.ctx.store.available:
            raise ApiError(503, "history is not available on this system")
        now = time.time()
        window = req.q("window")
        spans = {"5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "24h": 86400}
        if window in spans:
            since = now - spans[window]
            step = max(1, spans[window] // 300)     # ~300 points per window
        else:
            since = req.q_float("from", now - 3600)
            step = req.q_int("step")
        rows = req.ctx.store.signal_history(
            since=since, until=req.q_float("to", now + 1),
            step=step, limit=req.q_int("limit", 2000))
        return {"window": window, "step_s": step, "from": since,
                "samples": rows, "count": len(rows)}

    @router.get("/api/signal/poll")
    def get_poll(req):
        poller = getattr(req.ctx.controller, "signal_poller", None)
        if poller is None:
            raise ApiError(503, "signal poller not available")
        return poller.settings()

    @router.put("/api/signal/poll")
    def set_poll(req):
        """Change or pause polling — used to keep telemetry off the bus
        during a long scan."""
        poller = getattr(req.ctx.controller, "signal_poller", None)
        if poller is None:
            raise ApiError(503, "signal poller not available")
        return poller.configure(
            interval=req.body.get("interval_s"),
            enabled=req.body.get("enabled"))
