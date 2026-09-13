"""
Traffic / interface statistics collector + link latency probe.

Reads per-interface counters from /sys/class/net/<if>/statistics and computes
deltas so the UI can show live rates. Interfaces are discovered dynamically each
cycle so tunnels/bridges created at connect time (vxlanNN, brNN, ds-tt-br0) show
up automatically. Optionally pings the core to produce a real latency/jitter
series for the diagnostics view.
"""

import glob
import logging
import os
import re
import statistics
import time

from . import utils

logger = logging.getLogger("tsn5g-ue.stats")

_COUNTERS = ("rx_bytes", "rx_packets", "tx_bytes", "tx_packets",
             "rx_dropped", "tx_dropped", "rx_errors", "tx_errors")
_SKIP_PREFIX = ("lo", "docker", "veth", "br-", "virbr", "sit", "tun", "ogstun", "ogstap")


class StatsCollector:
    def __init__(self, interfaces=None, link_target=None, link_iface=None, window=48):
        # `interfaces` are always-included hints; discovery adds whatever else is up.
        self.interfaces = list(interfaces or [])
        self.link_target = link_target
        self.link_iface = link_iface
        self.window = window
        self._last = {}
        self._last_ts = None
        self._current = {}
        self._start = time.monotonic()
        self._lat_samples = []
        self._lat_last = None
        self._lat_jitter = None

    def set_link_target(self, target, iface=None):
        """Point the latency probe at the core once we know it (set on connect)."""
        self.link_target = target
        self.link_iface = iface

    # ------------------------------------------------------------- interfaces
    def _discover(self):
        names = set(self.interfaces)
        for path in glob.glob("/sys/class/net/*"):
            name = os.path.basename(path)
            if not name.startswith(_SKIP_PREFIX):
                names.add(name)
        return sorted(names)

    def collect(self):
        now = time.monotonic()
        dt = (now - self._last_ts) if self._last_ts else None
        current = {}
        for iface in self._discover():
            raw = self._read_iface(iface)
            if raw is None:
                continue
            prev = self._last.get(iface)
            rates = {}
            if prev and dt:
                for k in _COUNTERS:
                    rates[f"{k}_per_s"] = max(0, (raw[k] - prev[k])) / dt
            current[iface] = {**raw, **rates}
            self._last[iface] = raw
        self._current = current
        self._last_ts = now
        self._probe_link()

    # ------------------------------------------------------------- link probe
    def _probe_link(self):
        if not (self.link_target and utils.is_linux()):
            self._lat_last = None
            return
        cmd = ["ping", "-c", "1", "-W", "1"]
        if self.link_iface:
            cmd += ["-I", self.link_iface]
        cmd.append(self.link_target)
        try:
            out = utils.run(cmd, check=False, timeout=3).stdout or ""
        except Exception:  # noqa: BLE001
            out = ""
        m = re.search(r"time=([\d.]+)", out)
        if m:
            rtt = round(float(m.group(1)), 2)
            self._lat_last = rtt
            self._lat_samples.append(rtt)
            self._lat_samples = self._lat_samples[-self.window:]
            self._lat_jitter = (round(statistics.pstdev(self._lat_samples), 2)
                                if len(self._lat_samples) > 1 else 0.0)
        else:
            self._lat_last = None  # timeout / packet loss

    # ------------------------------------------------------------- read model
    def get_stats(self):
        return {"uptime_s": round(time.monotonic() - self._start, 1),
                "interfaces": self._current,
                "link": {"target": self.link_target,
                         "latency_ms": self._lat_last,
                         "jitter_ms": self._lat_jitter,
                         "samples": list(self._lat_samples)}}

    @staticmethod
    def _read_iface(iface):
        base = f"/sys/class/net/{iface}/statistics"
        if not os.path.isdir(base):
            return None
        out = {}
        for k in _COUNTERS:
            try:
                with open(os.path.join(base, k), "r", encoding="utf-8") as fh:
                    out[k] = int(fh.read().strip())
            except (OSError, ValueError):
                out[k] = 0
        return out
