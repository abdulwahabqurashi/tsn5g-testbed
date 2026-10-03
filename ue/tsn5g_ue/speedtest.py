"""
Throughput / speed test over the 5G link.

Runs an iperf3 test against a configured server (downlink + uplink) plus a ping
for latency/jitter, and exposes a live-updating result the UI polls. If iperf3
or a server is unavailable it reports that cleanly rather than faking numbers.
"""

import json
import logging
import re
import subprocess
import threading
import time

from . import utils

logger = logging.getLogger("tsn5g-ue.speedtest")


class SpeedTest:
    def __init__(self, cfg=None):
        self.cfg = cfg or {}
        self.server = self.cfg.get("server")           # iperf3 server host
        self.duration = int(self.cfg.get("duration", 8))
        # Bind the test to the 5G interface/source so it can only traverse the
        # modem link, never the wired management path. Set at start() time.
        self.bind_ip = None
        self.bind_iface = None
        self._lock = threading.Lock()
        self.result = {"state": "idle", "phase": None, "download_mbps": None,
                       "upload_mbps": None, "ping_ms": None, "jitter_ms": None,
                       "progress": 0.0, "samples": [], "server": self.server,
                       "error": None}

    def status(self):
        with self._lock:
            return dict(self.result)

    def start(self, server=None, bind_ip=None, bind_iface=None):
        with self._lock:
            if self.result["state"] == "running":
                return {"already_running": True}
            self.server = server or self.server
            self.bind_ip = bind_ip
            self.bind_iface = bind_iface
            self.result = {"state": "running", "phase": "ping", "download_mbps": None,
                           "upload_mbps": None, "ping_ms": None, "jitter_ms": None,
                           "progress": 0.0, "samples": [], "server": self.server,
                           "via": bind_iface, "error": None}
        threading.Thread(target=self._run, name="speedtest", daemon=True).start()
        return {"started": True, "server": self.server, "via": bind_iface}

    # ------------------------------------------------------------------ run
    def _run(self):
        try:
            if not self.server:
                raise RuntimeError("no iperf3 server configured (set speedtest.server)")
            if not utils.have("iperf3"):
                raise RuntimeError("iperf3 not installed on the UE")
            # Report the interface the kernel will actually use to reach the server,
            # so the UI shows the real path (wwan0 = over 5G).
            self._set(via=self._egress_iface() or self.bind_iface)
            self._ping()
            self._set(phase="download")
            dl = self._iperf(reverse=True)
            self._set(download_mbps=dl, phase="upload", progress=0.5)  # store now
            time.sleep(0.6)  # let the server release the previous session
            try:
                ul = self._iperf(reverse=False)
                self._set(upload_mbps=ul)
            except Exception as exc:  # noqa: BLE001 — keep the download result
                logger.warning("speedtest upload leg failed: %s", exc)
                self._set(error="upload: %s" % exc)
            self._set(state="done", phase="done", progress=1.0)
        except Exception as exc:  # noqa: BLE001
            logger.error("speedtest failed: %s", exc)
            self._set(state="error", error=str(exc))

    def _egress_iface(self):
        try:
            out = utils.run(["ip", "route", "get", self.server], check=False).stdout or ""
            m = re.search(r"\bdev\s+(\S+)", out)
            return m.group(1) if m else None
        except Exception:  # noqa: BLE001
            return None

    def _ping(self):
        try:
            cmd = ["ping", "-c", "5", "-i", "0.2"]
            if self.bind_iface:      # force ICMP out the 5G interface
                cmd += ["-I", self.bind_iface]
            cmd.append(self.server)
            out = utils.run(cmd, check=False, timeout=10).stdout
            m = re.search(r"=\s*[\d.]+/([\d.]+)/[\d.]+/([\d.]+)", out)
            if m:
                self._set(ping_ms=round(float(m.group(1)), 2),
                          jitter_ms=round(float(m.group(2)), 2))
        except Exception as exc:  # noqa: BLE001
            logger.debug("ping failed: %s", exc)

    def _iperf(self, reverse):
        # No -B: source-binding makes back-to-back iperf3 runs flaky ("broken
        # pipe"). Egress over 5G is guaranteed by routing (the core is only
        # reachable via wwan0) and reported via _egress_iface().
        cmd = ["iperf3", "-c", self.server, "-t", str(self.duration), "-J"]
        if reverse:
            cmd.append("-R")
        proc = utils.run(cmd, check=False, timeout=self.duration + 15)
        out = proc.stdout or ""
        data = _first_json(out)  # iperf3 may append an error line after the JSON
        if data is None:
            raise RuntimeError((proc.stderr or out or "iperf3 produced no output").strip()[:200])
        # iperf3 reports failures either as an "error" field or an appended
        # "iperf3: error - ..." line with an empty "end" block.
        if data.get("error"):
            raise RuntimeError("iperf3: " + str(data["error"]))
        end = data.get("end") or {}
        summ = end.get("sum_received") or end.get("sum_sent")
        if not summ:
            errline = next((l.strip() for l in out.splitlines()
                            if "error" in l.lower() and "iperf3" in l.lower()), None)
            raise RuntimeError(errline or ("no iperf3 server reachable at %s:5201" % self.server))
        # feed per-second samples to the live graph
        for iv in data.get("intervals", []):
            try:
                self._push(iv["sum"]["bits_per_second"] / 1e6)
            except (KeyError, TypeError):
                pass
        return round(summ["bits_per_second"] / 1e6, 1)

    # ------------------------------------------------------------------ state
    def _set(self, **kw):
        with self._lock:
            self.result.update(kw)

    def _push(self, mbps):
        with self._lock:
            self.result["samples"].append(round(mbps, 1))
            self.result["samples"] = self.result["samples"][-60:]


def _first_json(text):
    """Parse the first JSON object in `text`, ignoring any trailing non-JSON
    (iperf3 -J appends an 'iperf3: error ...' line after the JSON on failure)."""
    if not text:
        return None
    dec = json.JSONDecoder()
    s = text.lstrip()
    try:
        obj, _ = dec.raw_decode(s)
        return obj
    except json.JSONDecodeError:
        return None
