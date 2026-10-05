"""The measurement tools (tools/*.sh): start one, and read their saved results."""

from .. import results, testrun
from .router import ApiError


def register(router):

    @router.get("/api/results")
    def results_list(req):
        """Every saved run, newest first, with a one-line headline."""
        return {"runs": results.list_runs()}

    @router.get("/api/results/{kind}/{id}")
    def results_get(req):
        """One run, parsed into chart-ready data."""
        try:
            return results.get(req.params["kind"], req.params["id"])
        except KeyError as exc:
            raise ApiError(404, str(exc).strip("'")) from None

    @router.get("/api/tests")
    def tests_catalog(req):
        """The tests the console can start, with their options and duration."""
        return {"tests": testrun.catalog()}

    @router.post("/api/tests/{id}/run")
    def tests_run(req):
        """Start one as a job (the perf lane). Stop it with DELETE /api/jobs/{job}."""
        tid = req.params["id"]
        if tid not in testrun.CATALOG:
            raise ApiError(404, f"unknown test {tid}")
        try:
            testrun._clean_params(testrun.CATALOG[tid], req.body.get("params"))
        except ValueError as exc:
            raise ApiError(400, str(exc)) from None
        return req.ctx.submit_job("test.run", {"test": tid, "params": req.body.get("params") or {}})
