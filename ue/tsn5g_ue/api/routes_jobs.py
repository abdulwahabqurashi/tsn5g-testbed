"""Job listing, inspection and cancellation."""

from .router import ApiError


def register(router):

    @router.get("/api/jobs")
    def list_jobs(req):
        """Recent jobs, newest first."""
        mgr = _mgr(req)
        limit = req.q_int("limit", 50)
        jobs = [j.as_dict(include_log=False)
                for j in mgr.list(state=req.q("state"), kind=req.q("kind"),
                                  lane=req.q("lane"), limit=limit)]
        # Jobs evicted from memory still exist in sqlite.
        if req.ctx.store is not None and len(jobs) < limit:
            live = {j["id"] for j in jobs}
            for row in req.ctx.store.jobs(limit=limit, kind=req.q("kind"),
                                          state=req.q("state")):
                if row["id"] not in live:
                    jobs.append(_from_row(row))
        return {"jobs": jobs[:limit], "active": mgr.active()}

    @router.get("/api/jobs/{id}")
    def get_job(req):
        """One job, including its step timeline and progress lines."""
        job = _mgr(req).get(req.params["id"])
        if job is not None:
            return job.as_dict()
        if req.ctx.store is not None:
            for row in req.ctx.store.jobs(limit=1000):
                if row["id"] == req.params["id"]:
                    return _from_row(row, include_log=True)
        raise ApiError(404, f"no such job: {req.params['id']}")

    @router.get("/api/jobs/{id}/log")
    def job_log(req):
        """Progress lines, for a client that wants to poll rather than stream."""
        job = _mgr(req).get(req.params["id"])
        if job is None:
            raise ApiError(404, f"no such job: {req.params['id']}")
        since = req.q_int("since", 0) or 0
        lines = list(job.log)
        return {"lines": lines[since:], "next": len(lines), "state": job.state}

    @router.delete("/api/jobs/{id}")
    def cancel_job(req):
        """Cancel a running job, or stop a long-lived one. Same operation."""
        mgr = _mgr(req)
        job_id = req.params["id"]
        job = mgr.get(job_id)
        if job is None:
            raise ApiError(404, f"no such job: {job_id}")
        cancelled = mgr.cancel(job_id)
        if not cancelled:
            return {"ok": False, "state": job.state,
                    "error": f"job already {job.state}"}
        return {"ok": True, "state": job.state, "cancel_requested": True}


def _mgr(req):
    if req.ctx.jobs is None:
        raise ApiError(503, "job manager not available")
    return req.ctx.jobs


def _from_row(row, include_log=False):
    import json
    out = {
        "id": row["id"], "kind": row["kind"], "lane": row["lane"],
        "state": row["state"], "error": row["error"],
        "created": row["created"], "started": row["started"],
        "finished": row["finished"], "persisted": True,
        "progress": {"pct": 100 if row["state"] == "succeeded" else 0,
                     "step": None, "message": None},
        "steps": [],
    }
    for key, col in (("params", "params_json"), ("result", "result_json")):
        try:
            out[key] = json.loads(row[col]) if row[col] else None
        except (ValueError, TypeError):
            out[key] = None
    if include_log:
        out["lines"] = (row["log_text"] or "").splitlines()
    return out
