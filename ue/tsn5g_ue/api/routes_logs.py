"""Live logs, journal tail, runtime log level, and the command audit trail."""

import logging

from .. import utils
from .router import ApiError

_LEVELS = ("debug", "info", "warning", "error", "critical")


def register(router):

    @router.get("/api/logs")
    def logs(req):
        """Recent log records from the in-process ring."""
        if req.ctx.logbuf is None:
            raise ApiError(503, "log buffer not available")
        entries = req.ctx.logbuf.tail(
            since_id=req.q_int("since_id"),
            level=req.q("level"),
            logger_name=req.q("logger"),
            limit=req.q_int("limit", 200))
        return {"lines": entries, "last_id": req.ctx.logbuf.last_id}

    @router.get("/api/logs/journal")
    def journal(req):
        """journalctl tail, for what happened before this process started."""
        if not utils.have("journalctl"):
            raise ApiError(501, "journalctl not available on this system")
        unit = req.q("unit", "tsn5g-ue")
        lines = max(1, min(req.q_int("lines", 500) or 500, 5000))
        cmd = ["journalctl", "-u", unit, "-n", str(lines),
               "-o", "short-iso", "--no-pager"]
        since = req.q("since")
        if since:
            cmd += ["--since", since]
        proc = utils.run(cmd, check=False, timeout=20)
        if proc.returncode != 0:
            raise ApiError(500, "journalctl failed",
                           detail=proc.stderr.strip() or None)
        return {"unit": unit, "lines": proc.stdout.splitlines()}

    @router.get("/api/logs/level")
    def get_level(req):
        """Effective log levels."""
        root = logging.getLogger("tsn5g-ue")
        loggers = {}
        for name in sorted(logging.root.manager.loggerDict):
            if not name.startswith("tsn5g-ue"):
                continue
            lg = logging.getLogger(name)
            if lg.level:
                loggers[name] = logging.getLevelName(lg.level).lower()
        return {
            "root": logging.getLevelName(root.getEffectiveLevel()).lower(),
            "loggers": loggers,
            "available": list(_LEVELS),
        }

    @router.put("/api/logs/level")
    def set_level(req):
        """Change a log level at runtime — no restart, no config edit."""
        level = req.choice("level", _LEVELS, required=True)
        name = req.opt("logger", "tsn5g-ue")
        if not str(name).startswith("tsn5g-ue"):
            raise ApiError(400, "logger must be tsn5g-ue or one of its children")
        num = getattr(logging, level.upper())
        logging.getLogger(name).setLevel(num)
        # basicConfig set the level on the root handler, which would filter
        # DEBUG out again before it reached the ring.
        for h in logging.root.handlers:
            if h.level > num:
                h.setLevel(num)
        if logging.root.level > num:
            logging.root.setLevel(num)
        logging.getLogger("tsn5g-ue").info("log level for %s set to %s", name, level)
        return {"ok": True, "logger": name, "level": level}

    @router.get("/api/debug/commands")
    def commands(req):
        """Every command the daemon ran: argv, exit code, timing, output heads.

        This is a different question from the Python log — it is what the
        daemon did to the hardware, and it is what makes a UE debuggable
        without an SSH session.
        """
        if req.ctx.audit is None:
            raise ApiError(503, "audit log not available")
        limit = req.q_int("limit", 100)
        kind = req.q("kind")
        entries = req.ctx.audit.tail(limit=limit, kind=kind)
        if req.ctx.store is not None and len(entries) < limit:
            have = {(e["ts"], e["cmd"]) for e in entries}
            for row in req.ctx.store.audit(limit=limit, kind=kind):
                if (row["ts"], row["cmd"]) not in have:
                    row["persisted"] = True
                    entries.append(row)
            entries.sort(key=lambda e: e["ts"])
        return {"commands": entries[-limit:]}
