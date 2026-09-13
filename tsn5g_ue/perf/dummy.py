"""
Background traffic generators.

Two kinds, because they answer different questions:

**load** — a continuous iperf3 TCP stream that fills the link. Use it to see
what happens to something else while the bearer is busy: does the camera
stream survive, does latency collapse, does the gNB start dropping.

**flow** — a synthetic UDP stream shaped like the camera: fixed datagram size,
fixed rate, a chosen destination port, optionally marked with a DSCP value. Use
it to exercise the whole path — policy routing, marking, NAT, the core's
forwarding — without needing the camera, the Qt application or an X display.
The handover document notes pathStream1 is GUI-only and cannot be automated,
which makes testing the path without it genuinely useful.

Both run as long-lived jobs and stop on cancel. Both bind to the bearer
address, read at start: an unbound generator would load the wired network
instead and prove nothing.
"""

import logging
import re
import socket
import subprocess
import time

from .. import utils
from .iperf import bind_address

logger = logging.getLogger("tsn5g-ue.perf.dummy")

DEFAULT_FLOW_PORT = 50451        # the camera's port, from CAMERA_5G_PLAN.md
DEFAULT_FLOW_LENGTH = 1200       # under wwan0's 1400 MTU
DEFAULT_FLOW_RATE_MBPS = 15.0    # pathStream1 compresses to roughly 13-21


class DummyError(RuntimeError):
    pass


class LoadGenerator:
    """Owns whichever generator is running. One at a time, by design."""

    def __init__(self, config, events=None):
        cfg = config.as_dict() if hasattr(config, "as_dict") else (config or {})
        vx = cfg.get("vxlan") or {}
        speed = cfg.get("speedtest") or {}
        modem = cfg.get("modem") or {}
        self.server = speed.get("server") or vx.get("core_ip") or "10.45.0.1"
        self.iface = modem.get("wwan_interface", "wwan0")
        self.events = events
        self._state = None

    def status(self):
        return self._state or {"running": False}

    def _set(self, state):
        self._state = state
        if self.events is not None:
            try:
                from ..core.events import TOPIC_IPERF
                self.events.publish(TOPIC_IPERF, {"dummy": state})
            except Exception:           # noqa: BLE001
                pass

    # -- continuous iperf3 load ---------------------------------------------
    def run_load(self, spec, ctx):
        """iperf3 with no time limit, bound to the bearer."""
        bind = bind_address(self.iface)
        if not bind:
            raise DummyError(
                f"{self.iface} has no address. Bring the bearer up first — an "
                f"unbound generator would load the wired network instead.")

        server = spec.get("server") or self.server
        cmd = ["iperf3", "-c", server, "-B", bind, "-t", "0", "-i", "10"]
        if spec.get("dir") == "down":
            cmd.append("-R")
        if spec.get("parallel", 1) > 1:
            cmd += ["-P", str(spec["parallel"])]
        if spec.get("bitrate"):
            cmd += ["-b", str(spec["bitrate"])]
        if spec.get("proto") == "udp":
            cmd += ["-u", "-l", str(spec.get("length", 1200))]

        ctx.plan(["running"])
        ctx.step("running", " ".join(cmd))
        ctx.log("this loads the bearer continuously — stop it before "
                "measuring anything else, or the numbers include this traffic")

        self._set({"running": True, "kind": "load", "spec": spec,
                   "bind": bind, "job_id": ctx.job_id, "since": time.time()})
        try:
            return self._supervise(cmd, ctx, label="load")
        finally:
            self._set({"running": False})

    # -- synthetic application flow ------------------------------------------
    def run_flow(self, spec, ctx):
        """A rate-limited UDP stream shaped like the camera.

        Written here rather than shelled out because the shaping is the point:
        iperf3's UDP mode sends as fast as its token bucket allows in bursts,
        while a camera emits roughly one datagram per frame interval. A burst
        and a steady stream at the same mean rate do very different things to a
        5G scheduler.
        """
        bind = bind_address(self.iface)
        if not bind:
            raise DummyError(f"{self.iface} has no address. Bring the bearer up "
                             f"first.")

        dest = spec.get("dest") or self.server
        port = int(spec.get("port", DEFAULT_FLOW_PORT))
        length = int(spec.get("length", DEFAULT_FLOW_LENGTH))
        rate_mbps = float(spec.get("rate_mbps", DEFAULT_FLOW_RATE_MBPS))
        dscp = spec.get("dscp")

        if rate_mbps <= 0:
            raise DummyError("rate_mbps must be greater than zero")

        pps = max(1.0, (rate_mbps * 1e6) / 8.0 / length)
        interval = 1.0 / pps

        ctx.plan(["running"])
        ctx.step("running",
                 f"{rate_mbps:.1f} Mbit/s to {dest}:{port}, {length}-byte "
                 f"datagrams, {pps:.0f} pkt/s")
        ctx.log(f"bound to {bind} on {self.iface}")
        if dscp is not None:
            ctx.log(f"DSCP {dscp} (TOS 0x{int(dscp) << 2:02x})")
        ctx.log("shaped as a steady stream rather than iperf3's bursts: a "
                "burst and a steady flow at the same mean rate behave very "
                "differently through a 5G scheduler")

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.bind((bind, 0))
            if dscp is not None:
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_TOS, int(dscp) << 2)
            payload = b"\x00" * length

            self._set({"running": True, "kind": "flow", "spec": spec,
                       "bind": bind, "job_id": ctx.job_id, "since": time.time()})

            sent = 0
            errors = 0
            started = time.monotonic()
            next_send = started
            last_report = started

            while True:
                ctx.check_cancel()
                now = time.monotonic()
                if now < next_send:
                    time.sleep(min(next_send - now, 0.005))
                    continue
                try:
                    sock.sendto(payload, (dest, port))
                    sent += 1
                except OSError as exc:
                    errors += 1
                    if errors in (1, 10, 100):
                        ctx.log(f"send failed ({errors}): {exc}")
                next_send += interval
                # Do not try to catch up after a stall: bursting to make up
                # lost time is the opposite of what this is simulating.
                if next_send < now - 1.0:
                    next_send = now

                if now - last_report >= 10.0:
                    elapsed = now - started
                    actual = (sent * length * 8) / elapsed / 1e6
                    ctx.log(f"{sent} datagrams in {elapsed:.0f}s "
                            f"({actual:.1f} Mbit/s actual)"
                            + (f", {errors} send errors" if errors else ""))
                    last_report = now
        finally:
            sock.close()
            self._set({"running": False})
            elapsed = time.monotonic() - started if "started" in dir() else 0
            ctx.log(f"stopped after {sent} datagrams")
        return {"sent": sent, "errors": errors}

    # -- shared supervision ---------------------------------------------------
    def _supervise(self, cmd, ctx, label):
        """Run a long-lived subprocess, streaming its output, until cancelled."""
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        started = time.monotonic()
        lines = 0
        try:
            while True:
                if ctx.cancel.is_set():
                    ctx.log("stopping")
                    proc.terminate()
                    try:
                        proc.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    from ..core.jobs import JobCancelled
                    raise JobCancelled(f"{label} stopped")
                line = proc.stdout.readline()
                if not line:
                    if proc.poll() is not None:
                        code = proc.returncode
                        ctx.log(f"iperf3 exited with {code}")
                        if code != 0:
                            raise DummyError(
                                f"the generator exited unexpectedly (code {code}). "
                                f"Is iperf3 -s running on the far side?")
                        break
                    time.sleep(0.2)
                    continue
                text = line.strip()
                # Only the periodic summary lines are worth showing.
                if re.search(r"\d+\.\d+-\s*\d+\.\d+\s+sec", text):
                    ctx.log(text)
                    lines += 1
        finally:
            if proc.poll() is None:
                proc.kill()
        return {"ran_s": round(time.monotonic() - started, 1), "reports": lines}
