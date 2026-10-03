"""
Traffic statistics collector for DS-TT.

Reads per-interface counters from /sys/class/net/<iface>/statistics/
and computes rates (packets/sec, bytes/sec). Mirrors the counter
structure from src/upf/nwtt.h.
"""

import logging
import os
import time

from .constants import STATS_INTERVAL

logger = logging.getLogger("ds-tt.stats")

# sysfs counter names
SYSFS_COUNTERS = [
    "rx_packets",
    "tx_packets",
    "rx_bytes",
    "tx_bytes",
    "rx_errors",
    "tx_errors",
    "rx_dropped",
    "tx_dropped",
    "multicast",
]


class InterfaceStats:
    """Per-interface traffic statistics."""

    def __init__(self, interface):
        self.interface = interface
        self.counters = {}
        self.prev_counters = {}
        self.rates = {}
        self.last_read_time = 0

    def read(self):
        """Read current counters from sysfs."""
        stats_dir = f"/sys/class/net/{self.interface}/statistics"
        if not os.path.isdir(stats_dir):
            return False

        now = time.monotonic()
        self.prev_counters = dict(self.counters)
        prev_time = self.last_read_time

        for name in SYSFS_COUNTERS:
            path = os.path.join(stats_dir, name)
            try:
                with open(path, "r") as f:
                    self.counters[name] = int(f.read().strip())
            except (OSError, ValueError):
                self.counters[name] = 0

        self.last_read_time = now

        # Compute rates if we have a previous sample
        if prev_time > 0 and self.prev_counters:
            dt = now - prev_time
            if dt > 0:
                for name in SYSFS_COUNTERS:
                    curr = self.counters.get(name, 0)
                    prev = self.prev_counters.get(name, 0)
                    self.rates[f"{name}_per_sec"] = round((curr - prev) / dt, 1)

        return True

    def to_dict(self):
        """Return stats as a dict for API."""
        return {
            "interface": self.interface,
            "counters": dict(self.counters),
            "rates": dict(self.rates),
        }


class StatsCollector:
    """Collects traffic statistics across all DS-TT interfaces."""

    def __init__(self, interfaces):
        self.interfaces = interfaces
        self._stats = {iface: InterfaceStats(iface) for iface in interfaces}
        self._start_time = time.monotonic()

    def collect(self):
        """Read counters from all interfaces."""
        for iface_stats in self._stats.values():
            iface_stats.read()

    def get_stats(self, interface=None):
        """Return stats for one or all interfaces."""
        if interface:
            s = self._stats.get(interface)
            return s.to_dict() if s else None

        return {
            "uptime_seconds": round(time.monotonic() - self._start_time, 1),
            "interfaces": {
                iface: stats.to_dict()
                for iface, stats in self._stats.items()
            },
        }

    def add_interface(self, interface):
        """Add a new interface to track."""
        if interface not in self._stats:
            self._stats[interface] = InterfaceStats(interface)

    def remove_interface(self, interface):
        """Remove an interface from tracking."""
        self._stats.pop(interface, None)
