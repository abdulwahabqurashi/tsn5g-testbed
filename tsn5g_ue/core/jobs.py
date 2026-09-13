"""
Background jobs with lanes, progress and cancellation.

Anything that can exceed ~200 ms runs here rather than inside an HTTP handler.
That is not a style preference: ``ThreadingHTTPServer`` has no thread pool, so a
handler that blocks for four minutes on ``AT+QSCAN`` holds a thread and a socket
for four minutes, and a browser that retries produces another.

**Lanes** are the contention model. Each lane has exactly one worker, so at most
one job per lane runs at a time, and submitting to a busy lane is *rejected*
rather than queued:

    POST /api/bearer/up   while a bearer job runs   ->  409 lane busy

A queue would be worse. "Connect" silently firing four minutes after you pressed
it, once a network scan finished, is a surprise; a 409 naming the job that holds
the lane is information.

Long-lived jobs (``iperf.loop``, ``perf.dummy``) simply never return until
cancelled, so stop and cancel are the same operation.
"""

import collections
import logging
import threading
import time
import uuid

from .events import TOPIC_JOB

logger = logging.getLogger("tsn5g-ue.jobs")

# Lanes. A job's lane decides what it can run concurrently with.
LANE_MODEM = "modem"        # AT/QMI control: registration, scan, power, reset
LANE_BEARER = "bearer"      # the data call and its routing
LANE_PERF = "perf"          # iperf and load generators
LANE_SWITCH = "switch"      # SSH to the TSN switch
LANE_NET = "net"            # interface / transport / gptp configuration
LANES = (LANE_MODEM, LANE_BEARER, LANE_PERF, LANE_SWITCH, LANE_NET)

STATE_QUEUED = "queued"
STATE_RUNNING = "running"
STATE_SUCCEEDED = "succeeded"
STATE_FAILED = "failed"
STATE_CANCELLED = "cancelled"
TERMINAL = (STATE_SUCCEEDED, STATE_FAILED, STATE_CANCELLED)

JOB_LOG_LINES = 500         # per-job ring of progress lines
JOB_HISTORY = 50            # finished jobs kept in memory; the rest go to sqlite


class JobCancelled(Exception):
    """Raised inside a handler when the job has been asked to stop."""


class LaneBusy(RuntimeError):
    """Raised by submit() when the lane already has a running job."""

    def __init__(self, lane, job_id):
        self.lane = lane
        self.job_id = job_id
        super().__init__(f"lane busy: {lane} (held by {job_id})")


class ConfirmationRequired(RuntimeError):
    """Raised by submit() when a gated job was sent without confirm=true."""

    def __init__(self, kind, explain):
        self.kind = kind
        self.explain = explain
        super().__init__(explain)


class Job:
    """One unit of background work. Mutated only by its own worker thread."""

    __slots__ = ("id", "kind", "lane", "params", "actor", "state", "steps",
                 "progress", "result", "error", "created", "started",
                 "finished", "log", "cancellable", "_cancel", "_lock")

    def __init__(self, kind, lane, params, actor="ui", cancellable=True):
        self.id = "j-" + uuid.uuid4().hex[:6]
        self.kind = kind
        self.lane = lane
        self.params = params or {}
        self.actor = actor
        self.state = STATE_QUEUED
        self.steps = []
        self.progress = {"pct": 0, "step": None, "message": None}
        self.result = None
        self.error = None
        self.created = time.time()
        self.started = None
        self.finished = None
        self.log = collections.deque(maxlen=JOB_LOG_LINES)
        self.cancellable = cancellable
        self._cancel = threading.Event()
        self._lock = threading.Lock()

    @property
    def cancel_requested(self):
        return self._cancel.is_set()

    def as_dict(self, include_log=True):
        with self._lock:
            d = {
                "id": self.id,
                "kind": self.kind,
                "lane": self.lane,
                "params": self.params,
                "actor": self.actor,
                "state": self.state,
                "steps": list(self.steps),
                "progress": dict(self.progress),
                "result": self.result,
                "error": self.error,
                "created": self.created,
                "started": self.started,
                "finished": self.finished,
                "cancellable": self.cancellable,
                "cancel_requested": self._cancel.is_set(),
            }
            if include_log:
                d["lines"] = list(self.log)
            return d


class JobContext:
    """The handle a handler uses to report progress and honour cancellation."""

    def __init__(self, job, manager):
        self._job = job
        self._mgr = manager
        self._total = None
        self._index = 0

    # -- inputs -------------------------------------------------------------
    @property
    def params(self):
        return self._job.params

    @property
    def job_id(self):
        return self._job.id

    @property
    def cancel(self):
        """The Event to hand to ModemBus / subprocess waits."""
        return self._job._cancel     # noqa: SLF001

    def check_cancel(self):
        if self._job._cancel.is_set():      # noqa: SLF001
            raise JobCancelled(f"{self._job.kind} cancelled")

    # -- outputs ------------------------------------------------------------
    def plan(self, step_names):
        """Declare the steps up front so the UI can render the whole timeline."""
        with self._job._lock:               # noqa: SLF001
            self._job.steps = [{"name": n, "state": "pending", "started": None,
                                "finished": None, "detail": None}
                               for n in step_names]
            self._total = len(step_names)
        self._mgr._emit(self._job)          # noqa: SLF001

    def step(self, name, detail=None):
        """Open a step, closing the previous one as succeeded."""
        self.check_cancel()
        now = time.time()
        with self._job._lock:               # noqa: SLF001
            for s in self._job.steps:
                if s["state"] == "running":
                    s["state"] = "succeeded"
                    s["finished"] = now
            found = next((s for s in self._job.steps if s["name"] == name), None)
            if found is None:
                found = {"name": name, "state": "pending", "started": None,
                         "finished": None, "detail": None}
                self._job.steps.append(found)
            found["state"] = "running"
            found["started"] = now
            found["detail"] = detail
            self._index = self._job.steps.index(found)
            total = self._total or len(self._job.steps)
            self._job.progress = {
                "pct": int(100 * self._index / total) if total else 0,
                "step": name,
                "message": detail,
            }
        self.log(f"[{name}] {detail}" if detail else f"[{name}]")
        self._mgr._emit(self._job)          # noqa: SLF001

    def fail_step(self, detail=None):
        now = time.time()
        with self._job._lock:               # noqa: SLF001
            for s in self._job.steps:
                if s["state"] == "running":
                    s["state"] = "failed"
                    s["finished"] = now
                    if detail:
                        s["detail"] = detail

    def progress(self, pct, message=None):
        with self._job._lock:               # noqa: SLF001
            self._job.progress["pct"] = max(0, min(100, int(pct)))
            if message is not None:
                self._job.progress["message"] = message
        self._mgr._emit(self._job)          # noqa: SLF001

    def log(self, line):
        """Append one progress line. These are what the UI tails live."""
        stamped = time.strftime("%H:%M:%S") + "  " + str(line).rstrip()
        with self._job._lock:               # noqa: SLF001
            self._job.log.append(stamped)
        self._mgr._emit(self._job, line=stamped)    # noqa: SLF001


class JobManager:
    """Registry plus one worker thread per lane."""

    def __init__(self, bus=None, store=None):
        self._bus = bus
        self._store = store
        self._handlers = {}                      # kind -> spec
        self._jobs = {}                          # id -> Job (live + recent)
        self._order = collections.deque()        # ids, oldest first
        self._active = {lane: None for lane in LANES}
        self._lock = threading.RLock()
        self._threads = {}

    def attach(self, bus=None, store=None):
        if bus is not None:
            self._bus = bus
        if store is not None:
            self._store = store

    # -- registration -------------------------------------------------------
    def register(self, kind, handler, lane, cancellable=True, confirm=False,
                 explain=None):
        """Bind a job kind to a handler.

        handler is called as handler(ctx) and may return a JSON-able result.
        confirm=True makes submit() reject the job unless params["confirm"] is
        true — used for anything that can drop the link or strand the operator.
        """
        if lane not in LANES:
            raise ValueError(f"unknown lane: {lane}")
        self._handlers[kind] = {
            "handler": handler, "lane": lane, "cancellable": cancellable,
            "confirm": confirm,
            "explain": explain or f"{kind} requires confirmation",
        }

    def kinds(self):
        return {k: {"lane": v["lane"], "cancellable": v["cancellable"],
                    "confirm": v["confirm"], "explain": v["explain"]}
                for k, v in self._handlers.items()}

    # -- submission ---------------------------------------------------------
    def submit(self, kind, params=None, actor="ui"):
        spec = self._handlers.get(kind)
        if spec is None:
            raise KeyError(f"unknown job kind: {kind}")
        params = dict(params or {})

        if spec["confirm"] and not params.get("confirm"):
            raise ConfirmationRequired(kind, spec["explain"])

        lane = spec["lane"]
        with self._lock:
            holder = self._active.get(lane)
            if holder is not None:
                held = self._jobs.get(holder)
                if held is not None and held.state in (STATE_QUEUED, STATE_RUNNING):
                    raise LaneBusy(lane, holder)
                self._active[lane] = None

            job = Job(kind, lane, params, actor=actor,
                      cancellable=spec["cancellable"])
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._active[lane] = job.id
            self._trim_locked()

        self._emit(job)
        t = threading.Thread(target=self._run, args=(job, spec["handler"]),
                             name=f"job-{lane}-{job.id}", daemon=True)
        self._threads[job.id] = t
        t.start()
        logger.info("job %s submitted: %s (lane=%s)", job.id, kind, lane)
        return job

    def _run(self, job, handler):
        ctx = JobContext(job, self)
        with job._lock:                          # noqa: SLF001
            job.state = STATE_RUNNING
            job.started = time.time()
        self._emit(job)

        try:
            result = handler(ctx)
            with job._lock:                      # noqa: SLF001
                now = time.time()
                for s in job.steps:
                    if s["state"] == "running":
                        s["state"] = "succeeded"
                        s["finished"] = now
                job.result = result
                job.state = STATE_SUCCEEDED
                job.progress["pct"] = 100
                job.finished = now
            logger.info("job %s succeeded: %s", job.id, job.kind)
        except JobCancelled as exc:
            ctx.fail_step("cancelled")
            with job._lock:                      # noqa: SLF001
                job.state = STATE_CANCELLED
                job.error = str(exc)
                job.finished = time.time()
            logger.info("job %s cancelled: %s", job.id, job.kind)
        except Exception as exc:                 # noqa: BLE001
            ctx.fail_step(str(exc))
            with job._lock:                      # noqa: SLF001
                job.state = STATE_FAILED
                job.error = str(exc)
                job.finished = time.time()
            logger.error("job %s failed: %s: %s", job.id, job.kind, exc)
        finally:
            with self._lock:
                if self._active.get(job.lane) == job.id:
                    self._active[job.lane] = None
                self._threads.pop(job.id, None)
            if self._store is not None:
                try:
                    self._store.write_job(job.as_dict())
                except Exception:                # noqa: BLE001
                    logger.debug("job %s not persisted", job.id, exc_info=True)
            self._emit(job)

    # -- control ------------------------------------------------------------
    def cancel(self, job_id):
        """Ask a job to stop. Returns False if it is unknown or already done."""
        job = self._jobs.get(job_id)
        if job is None or job.state in TERMINAL:
            return False
        if not job.cancellable:
            raise RuntimeError(f"{job.kind} is not cancellable")
        job._cancel.set()                        # noqa: SLF001
        logger.info("job %s cancel requested", job_id)
        self._emit(job)
        return True

    def cancel_all(self, timeout=5.0):
        """Best-effort stop of everything running. Used on shutdown."""
        with self._lock:
            live = [j for j in self._jobs.values() if j.state in (STATE_QUEUED, STATE_RUNNING)]
        for job in live:
            job._cancel.set()                    # noqa: SLF001
        deadline = time.monotonic() + timeout
        for job in live:
            t = self._threads.get(job.id)
            if t is not None:
                t.join(max(0.0, deadline - time.monotonic()))
        return len(live)

    # -- read model ---------------------------------------------------------
    def get(self, job_id):
        return self._jobs.get(job_id)

    def list(self, state=None, kind=None, lane=None, limit=50):
        with self._lock:
            jobs = [self._jobs[i] for i in self._order if i in self._jobs]
        if state:
            jobs = [j for j in jobs if j.state == state]
        if kind:
            jobs = [j for j in jobs if j.kind == kind]
        if lane:
            jobs = [j for j in jobs if j.lane == lane]
        jobs.reverse()                           # newest first
        return jobs[:limit] if limit else jobs

    def active(self):
        """The job currently holding each lane, or None."""
        with self._lock:
            out = {}
            for lane, jid in self._active.items():
                job = self._jobs.get(jid) if jid else None
                out[lane] = job.id if job and job.state in (STATE_QUEUED, STATE_RUNNING) else None
            return out

    # -- internals ----------------------------------------------------------
    def _trim_locked(self):
        """Drop the oldest finished jobs from memory; sqlite keeps the history."""
        while len(self._order) > JOB_HISTORY:
            oldest = self._order[0]
            job = self._jobs.get(oldest)
            if job is not None and job.state not in TERMINAL:
                break                            # never evict something running
            self._order.popleft()
            self._jobs.pop(oldest, None)

    def _emit(self, job, line=None):
        if self._bus is None:
            return
        payload = {
            "job_id": job.id,
            "kind": job.kind,
            "lane": job.lane,
            "state": job.state,
            "progress": dict(job.progress),
            "error": job.error,
        }
        if line is not None:
            payload["line"] = line
        if job.state in TERMINAL:
            payload["result"] = job.result
            payload["steps"] = list(job.steps)
        try:
            self._bus.publish(TOPIC_JOB, payload)
        except Exception:                        # noqa: BLE001
            logger.debug("job event not published", exc_info=True)
