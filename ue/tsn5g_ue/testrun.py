"""
One-click runs of the measurement tools (tools/*.sh) from the console.

The tools stay the source of truth and still run from a terminal. This module
starts one as a job, streams its output into the job log, and takes care of
what the operator used to do by hand around it:

  - the cameras: stopped for the tests that need a quiet uplink and started
    again afterwards; started (and Start pressed) for the demo, which needs them;
  - the user: the daemon is root, the SSH key to the core is the desktop
    user's. The tools run as root with TSN5G_AS_USER set, which makes
    tools/common.sh run ssh/scp as that user; results land in that user's home
    (HOME is set to it) and are handed back to them afterwards.

Stopping a run sends SIGINT to the tool's process group; every tool restores
the queue policy and removes what it built in its EXIT trap.
"""

import logging
import os
import pwd
import re
import signal
import subprocess
import time

from . import results, rig

logger = logging.getLogger("tsn5g-ue.testrun")

TOOLS = os.path.join(os.path.dirname(rig.REPO), "tools")
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# cameras: "stopped" (paused for the run), "running" (started if needed), None
CATALOG = {
    "demo": {
        "title": "Camera demo",
        "summary": "Both cameras under a flood, policy off vs on. Shows camera 1 kept whole.",
        "script": "demo-run.sh", "kind": "demo", "cameras": "running", "capture": True,
        "params": [
            {"key": "FLOOD", "label": "Flood", "default": "50M",
             "options": [["50M", "50 Mbit/s"], ["80M", "80 Mbit/s (clearer 'off')"]]},
            {"key": "BE_MBPS", "label": "Camera 2 allowance", "default": "12",
             "options": [["12", "12 Mbit/s"], ["25", "25 Mbit/s (camera 2 stays alive)"]]},
            {"key": "PHASE", "label": "Phase length", "default": "60",
             "options": [["30", "30 s (~5 min)"], ["60", "60 s (~9 min)"]]},
        ],
        "minutes": lambda p: (int(p.get("PHASE", 60)) + 6) * 7 / 60 + 1,
    },
    "camloss": {
        "title": "Camera loss check",
        "summary": "Both cameras as they run now: datagrams sent at the UE vs reached the core, same 30 s.",
        "script": "camera-loss-check.sh", "kind": "camloss", "cameras": "running", "capture": True,
        "params": [],
        "minutes": lambda p: 1,
    },
    "loss": {
        "title": "Uplink loss",
        "summary": "One camera's rate four ways: packet size, bursts, GBR flow. Finds where loss comes from.",
        "script": "radio-loss-test.sh", "kind": "loss", "cameras": "stopped", "capture": False,
        "params": [],
        "minutes": lambda p: 2.5,
    },
    "qbv": {
        "title": "Uplink priority",
        "summary": "Talker vs flood with no policy, priority, Qbv gates and the live auto-rate.",
        "script": "qbv-live.sh", "kind": "qbv", "cameras": "stopped", "capture": False,
        "params": [
            {"key": "PHASES", "label": "Phases", "default": "P-baseline A-none B-uni R-auto",
             "options": [["P-baseline A-none B-uni R-auto", "Quick: none, priority, auto-rate (~3 min)"],
                         ["P-baseline A-none B-uni B-sch F-uni F-sch G-sch R-auto S-sweep",
                          "Full: with gates and TDD scan (~7 min)"]]},
        ],
        "minutes": lambda p: 0.75 * len(p.get("PHASES", "").split()) + 0.7,
    },
    "drift": {
        "title": "Radio clock drift",
        "summary": "Does the gNB's frame timing walk against PTP time? Repeated 5 ms scans.",
        "script": "gnb-drift.sh", "kind": "drift", "cameras": "stopped", "capture": False,
        "params": [
            {"key": "SCANS", "label": "Scans", "default": "6",
             "options": [["3", "3 scans, 2 min apart (~6 min)"], ["6", "6 scans, 5 min apart (~30 min)"]]},
        ],
        "minutes": lambda p: 6 if str(p.get("SCANS")) == "3" else 30,
    },
}
_EXTRA_ENV = {"drift": lambda p: {"GAP_MIN": "2"} if str(p.get("SCANS")) == "3" else {}}


def catalog():
    out = []
    for tid, t in CATALOG.items():
        defaults = {p["key"]: p["default"] for p in t["params"]}
        out.append({"id": tid, "title": t["title"], "summary": t["summary"], "kind": t["kind"],
                    "cameras": t["cameras"], "capture": t["capture"], "params": t["params"],
                    "minutes": round(t["minutes"](defaults), 1)})
    return out


def _clean_params(test, params):
    out = {}
    for p in test["params"]:
        v = str((params or {}).get(p["key"], p["default"]))
        if v not in [o[0] for o in p["options"]]:
            raise ValueError(f"{p['label']}: {v!r} is not one of the offered values")
        out[p["key"]] = v
    return out


def run(test_id, params, ctx, controller):
    test = CATALOG.get(test_id)
    if test is None:
        raise ValueError(f"unknown test {test_id!r}")
    params = _clean_params(test, params)
    user = rig.DESKTOP_USER
    home = pwd.getpwnam(user).pw_dir
    minutes = test["minutes"](params)
    cams_were = any(e["running"] for e in rig.encoders_status()["encoders"])

    ctx.plan(["check", "cameras", "run", "restore"])
    ctx.step("check", "bearer and core")
    bearer = controller.bearer
    if not _has_addr(rig.BEARER):
        raise RuntimeError(f"{rig.BEARER} has no address: connect the 5G link first")

    ctx.step("cameras", {"stopped": "pausing the cameras for a quiet uplink",
                         "running": "making sure both cameras are streaming"}.get(test["cameras"], "unchanged"))
    if test["cameras"] == "stopped" and cams_were:
        rig.encoders("stop", ctx.log)
    elif test["cameras"] == "running" and not cams_were:
        rig.encoders("start", ctx.log, camera_entries=controller.config.cameras, bearer=bearer)
        _press_start(ctx, bearer)

    ctx.step("run", f"{test['title']}: about {minutes:.0f} min")
    started = time.strftime("%Y%m%d-%H%M%S")
    env = {**os.environ, "HOME": home, "TSN5G_AS_USER": user, "PYTHONUNBUFFERED": "1",
           **params, **_EXTRA_ENV.get(test_id, lambda p: {})(params)}
    cmd = ["bash", os.path.join(TOOLS, test["script"])]
    rc, tail = _stream(cmd, env, ctx, minutes)

    ctx.step("restore", "results to the user, cameras back as they were")
    _chown(os.path.join(home, results.KINDS[test["kind"]]), user)
    if test["cameras"] == "stopped" and cams_were:
        try:
            rig.encoders("start", ctx.log, camera_entries=controller.config.cameras, bearer=bearer)
            _press_start(ctx, bearer)
        except Exception as exc:                        # noqa: BLE001 — report, the run itself is done
            ctx.log(f"cameras did not come back by themselves: {exc} — use Cameras → Press Start")

    run_id = _newest(test["kind"], started)
    ctx.check_cancel()
    if rc != 0:
        raise RuntimeError(next((l for l in reversed(tail) if l.startswith("error")), None)
                           or (tail[-1] if tail else f"exit {rc}"))
    return {"test": test_id, "kind": test["kind"], "run_id": run_id, "tail": tail[-12:]}


def _press_start(ctx, bearer, tries=3):
    """Press Start until both cameras send video. An encoder window that has
    only just opened can miss the first click, and a camera that moved
    address takes a few seconds longer to answer."""
    for n in range(1, tries + 1):
        flow = rig._streams_flowing(bearer)            # noqa: SLF001
        if flow and all(flow.values()):
            ctx.log("video flowing: " + ", ".join(f"{k} {v} datagrams/s" for k, v in flow.items()))
            return flow
        try:
            return rig.press_start(ctx.log, bearer=bearer)
        except rig.RigError as exc:
            if n == tries:
                raise
            ctx.log(f"{exc}; pressing Start again in 5 s ({n}/{tries - 1})")
            time.sleep(5)


def _stream(cmd, env, ctx, minutes):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            text=True, bufsize=1, env=env, start_new_session=True)
    tail, t0, last, budget = [], time.time(), 0.0, max(60, minutes * 60)
    stopper = _Stopper(proc, ctx)
    try:
        for line in proc.stdout:
            line = _ANSI.sub("", line.rstrip())
            if not line:
                continue
            tail = (tail + [line])[-40:]
            ctx.log(line)
            if time.time() - last >= 1:
                last = time.time()
                ctx.progress(25 + int(50 * min(1.0, (last - t0) / budget)), line[:120])
    finally:
        stopper.done()
    return proc.wait(), tail


class _Stopper:
    """Turns the job's cancel into SIGINT for the whole tool, then SIGKILL."""

    def __init__(self, proc, ctx):
        import threading
        self._proc, self._ctx = proc, ctx
        self._end = threading.Event()
        threading.Thread(target=self._watch, daemon=True, name="testrun-stop").start()

    def _watch(self):
        while not self._end.wait(0.5):
            if self._ctx.cancel.is_set():
                self._ctx.log("stopping: the tool cleans up after itself")
                _signal(self._proc, signal.SIGINT)
                if self._end.wait(30):
                    return
                _signal(self._proc, signal.SIGKILL)
                return

    def done(self):
        self._end.set()


def _signal(proc, sig):
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass


def _has_addr(dev):
    out = subprocess.run(["ip", "-4", "-o", "addr", "show", dev], capture_output=True, text=True).stdout
    return " inet " in out


def _chown(path, user):
    if os.path.isdir(path):
        subprocess.run(["chown", "-R", f"{user}:", path], check=False)


def _newest(kind, since):
    runs = [r for r in results.list_runs(limit=200) if r["kind"] == kind and r["id"] >= since]
    return runs[0]["id"] if runs else None
