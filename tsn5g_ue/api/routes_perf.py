"""Throughput testing. The /api/speedtest/* contract is unchanged for now;
Phase 6 replaces it with /api/iperf/* and keeps these as aliases."""


def register(router):

    @router.post("/api/speedtest/run")
    def run(req):
        """Start a speed test against the configured server."""
        return req.ctx.controller.speedtest_start(server=req.opt("server"))

    @router.get("/api/speedtest/result")
    def result(req):
        """Current or last result, including live per-second samples."""
        return req.ctx.controller.speedtest_status()
