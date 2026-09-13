"""
Throughput testing and background traffic.

The /api/speedtest/* routes are kept as thin aliases so the old UI keeps
working through the transition; they are deleted with the legacy views.
"""

from ..perf.iperf import DEFAULT_LEGS, IperfError
from .router import ApiError, Response


def _iperf(req):
    r = getattr(req.ctx.controller, "iperf", None)
    if r is None:
        raise ApiError(503, "iperf runner not available")
    return r


def register(router):

    # -- defaults and history -----------------------------------------------
    @router.get("/api/iperf/defaults")
    def defaults(req):
        """Server, bind interface and the live bind address.

        `bind_address` is read now, not cached: the SMF hands out a new one on
        every data call, and a stale bind is how a test ends up measuring the
        wrong interface.
        """
        return _iperf(req).defaults()

    @router.get("/api/iperf/runs")
    def runs(req):
        """Recorded runs, including directories that predate this daemon."""
        return {"runs": _iperf(req).runs(limit=req.q_int("limit", 50))}

    @router.get("/api/iperf/runs/{id}")
    def run_detail(req):
        r = _iperf(req)
        try:
            return {"id": req.params["id"], "legs": r.legs(req.params["id"])}
        except IperfError as exc:
            raise ApiError(404, str(exc)) from exc

    @router.get("/api/iperf/runs/{id}/summary.csv")
    def run_csv(req):
        """The file verbatim, so anything that parses CSV keeps working."""
        try:
            body = _iperf(req).summary_csv(req.params["id"])
        except IperfError as exc:
            raise ApiError(404, str(exc)) from exc
        return Response(200, raw_body=body, content_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition":
                                 f'attachment; filename="{req.params["id"]}.csv"'})

    # -- running -------------------------------------------------------------
    @router.post("/api/iperf/run")
    def run(req):
        """One pass over the requested legs."""
        spec = _spec(req)
        spec["legs"] = req.opt("legs") or [
            f"{req.choice('proto', ('tcp', 'udp'), default='tcp')}-"
            f"{req.choice('dir', ('up', 'down'), default='up')}"]
        return req.ctx.submit_job("iperf.run", spec)

    @router.post("/api/iperf/loop")
    def loop(req):
        """Cycle the legs until stopped. Matches iperf5g.sh."""
        spec = _spec(req)
        spec["legs"] = req.opt("legs") or DEFAULT_LEGS
        return req.ctx.submit_job("iperf.loop", spec)

    # -- background traffic ---------------------------------------------------
    @router.get("/api/perf/dummy")
    def dummy_state(req):
        gen = getattr(req.ctx.controller, "load", None)
        if gen is None:
            raise ApiError(503, "load generator not available")
        return gen.status()

    @router.post("/api/perf/dummy")
    def dummy_start(req):
        """Start a background generator.

        kind=load — continuous iperf3, fills the link.
        kind=flow — a UDP stream shaped like the camera, for exercising the
                    policy-routing path without the camera or an X display.
        """
        kind = req.choice("kind", ("load", "flow"), default="load")
        if kind == "load":
            return req.ctx.submit_job("perf.load", {
                "server": req.opt("server"),
                "dir": req.choice("dir", ("up", "down"), default="up"),
                "proto": req.choice("proto", ("tcp", "udp"), default="tcp"),
                "parallel": req.integer("parallel", default=1, lo=1, hi=32),
                "bitrate": req.opt("bitrate"),
                "length": req.integer("length", default=1200, lo=64, hi=9000),
            })
        return req.ctx.submit_job("perf.flow", {
            "dest": req.opt("dest"),
            "port": req.integer("port", default=50451, lo=1, hi=65535),
            "length": req.integer("length", default=1200, lo=64, hi=9000),
            "rate_mbps": float(req.opt("rate_mbps", 15)),
            "dscp": req.body.get("dscp"),
        })

    @router.delete("/api/perf/dummy")
    def dummy_stop(req):
        gen = getattr(req.ctx.controller, "load", None)
        state = gen.status() if gen else {}
        job_id = state.get("job_id")
        if not job_id:
            return {"ok": False, "error": "nothing running"}
        req.ctx.jobs.cancel(job_id)
        return {"ok": True, "job_id": job_id}

    # -- legacy aliases -------------------------------------------------------
    @router.post("/api/speedtest/run")
    def speedtest_run(req):
        """Alias onto iperf.run, kept while the old views are migrated."""
        return req.ctx.controller.speedtest_start(server=req.opt("server"))

    @router.get("/api/speedtest/result")
    def speedtest_result(req):
        return req.ctx.controller.speedtest_status()


def _spec(req):
    return {
        "server": req.opt("server"),
        "port": req.integer("port", default=5201, lo=1, hi=65535),
        "duration": req.integer("duration", default=10, lo=1, hi=600),
        "parallel": req.integer("parallel", default=1, lo=1, hi=32),
        "udp_rate": req.opt("udp_rate"),
        "length": req.integer("length", default=1200, lo=64, hi=9000),
        "omit": req.integer("omit", default=2, lo=0, hi=30),
    }
