"""Status, health, stats, discovery, config, version, spec, and the event stream."""

import time

from .. import __version__
from . import sse
from .router import RAW, ApiError


def register(router):

    @router.get("/api/status")
    def status(req):
        """Controller snapshot: state, step, modem, transport, gptp, tas."""
        snap = req.ctx.controller.snapshot()
        # Surface what is running, so the UI can render a job banner without a
        # second request on every poll.
        if req.ctx.jobs is not None:
            snap["jobs"] = {"active": req.ctx.jobs.active()}
        return snap

    @router.get("/api/health")
    def health(req):
        """Per-subsystem health checks."""
        return req.ctx.controller.health()

    @router.get("/api/stats")
    def stats(req):
        """Interface counters and rates, plus the link latency probe."""
        return req.ctx.stats.get_stats() if req.ctx.stats else {}

    @router.get("/api/discovery")
    def discovery(req):
        """Detected modem ports, NICs and platform."""
        return req.ctx.controller.discovery.summary()

    @router.get("/api/config")
    def config_get(req):
        """Effective configuration."""
        return req.ctx.controller.config.as_dict()

    @router.put("/api/config")
    def config_put(req):
        """Patch and persist configuration."""
        req.ctx.controller.config.update(req.body)
        return {"ok": True, "config": req.ctx.controller.config.as_dict()}

    @router.get("/api/version")
    def version(req):
        """Build identity — the UI showed a hard-coded version before this."""
        v = dict(req.ctx.version or {})
        v.setdefault("version", __version__)
        v["uptime_s"] = round(time.time() - (req.ctx.started or time.time()), 1)
        return v

    @router.get("/api/spec")
    def spec(req):
        """The route table this process actually serves."""
        return {
            "routes": req.ctx.router.spec(),
            "job_kinds": req.ctx.jobs.kinds() if req.ctx.jobs else {},
            "topics": list(sse_topics()),
        }

    @router.get("/api/events")
    def events(req):
        """SSE stream. ?topics=job,signal,log&last_id=N"""
        if req.ctx.bus is None:
            raise ApiError(503, "event bus not available")
        topics = req.q_list("topics") or None
        last_id = req.q_int("last_id")
        if last_id is None:
            # EventSource resends its own position on reconnect.
            hdr = req.headers.get("Last-Event-ID")
            if hdr and hdr.isdigit():
                last_id = int(hdr)
        sse.stream(req.http, req.ctx.bus, req.ctx.sse,
                   topics=topics, last_id=last_id)
        return RAW

    @router.get("/api/events/stats")
    def events_stats(req):
        """Bus depth and subscriber count — for debugging the stream itself."""
        out = req.ctx.bus.stats() if req.ctx.bus else {}
        out["sse_clients"] = req.ctx.sse.count
        out["sse_max"] = req.ctx.sse.max_clients
        if req.ctx.store is not None:
            out["store"] = req.ctx.store.stats()
        return out


def sse_topics():
    from ..core.events import ALL_TOPICS
    return ALL_TOPICS
