"""Results of the measurement tools (tools/*.sh), read-only, for the Tests page."""

from .. import results
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
