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

    @router.get("/api/cameras")
    def cameras_status(req):
        """Each camera-facing NIC, and whether the expected camera is there.

        `serial_ok` is the one worth reading. The streaming application selects
        its camera by an index into enumeration order, so two cameras swapping
        places puts the wrong one in the protected lane — and every other
        indicator still reads healthy.
        """
        from ..net import cameras as cams
        return cams.describe(req.ctx.controller.config.cameras)

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
        """Effective configuration, and where each top-level key came from.

        `_source` marks keys that have been changed through the UI. Those live
        in a JSON overlay; the operator's YAML is never rewritten, because
        yaml.safe_dump destroys comments and reflows key order.
        """
        cfg = req.ctx.controller.config
        out = dict(cfg.as_dict())
        try:
            out["_source"] = cfg.sources()
        except AttributeError:
            pass
        return out

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

    @router.get("/api/debug/snapshot")
    def snapshot(req):
        """One blob to attach to a bug report. Replaces diag.sh.

        Everything a question about this rig usually needs: controller state,
        the modem and bearer, the routing tables, and the recent log — so the
        first reply is an answer rather than "can you also send...".
        """
        from .. import utils
        c = req.ctx.controller
        out = {"generated": time.time(), "version": __version__}

        def safe(name, fn):
            try:
                out[name] = fn()
            except Exception as exc:        # noqa: BLE001 — a snapshot must
                out[name] = {"error": str(exc)}   # never fail as a whole

        safe("status", c.snapshot)
        safe("health", c.health)
        safe("discovery", c.discovery.summary)
        safe("modem", lambda: c.modem.get_status() if c.modem else None)
        safe("bus", lambda: c.bus.status() if getattr(c, "bus", None) else None)
        safe("bearer", lambda: c.bearer.status() if getattr(c, "bearer", None) else None)
        safe("radio", lambda: c.radio.state() if getattr(c, "radio", None) else None)
        safe("radio_prefs", lambda: c.radio.prefs() if getattr(c, "radio", None) else None)
        safe("routing", lambda: c.routing.status() if getattr(c, "routing", None) else None)
        safe("interfaces", c.interfaces)
        safe("jobs", lambda: [j.as_dict(include_log=False)
                              for j in req.ctx.jobs.list(limit=20)])
        safe("stats", lambda: req.ctx.stats.get_stats() if req.ctx.stats else None)

        cmds = {
            "ip_addr": ["ip", "-br", "addr"],
            "ip_route": ["ip", "route", "show"],
            "ip_rule": ["ip", "rule", "show"],
            "iptables_mangle": ["iptables", "-t", "mangle", "-S"],
            "iptables_nat": ["iptables", "-t", "nat", "-S"],
        }
        shell = {}
        for name, cmd in cmds.items():
            try:
                proc = utils.run(cmd, check=False, timeout=10)
                shell[name] = (proc.stdout or proc.stderr or "").strip().splitlines()
            except Exception as exc:        # noqa: BLE001
                shell[name] = [f"error: {exc}"]
        out["shell"] = shell

        if req.ctx.logbuf is not None:
            out["log"] = req.ctx.logbuf.tail(limit=200)
        if req.ctx.audit is not None:
            out["commands"] = req.ctx.audit.tail(limit=60)
        return out

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
