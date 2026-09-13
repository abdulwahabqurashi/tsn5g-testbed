"""
Throughput testing and background traffic.

    iperf.py   ported from docs/reference/iperf5g.sh, keeping its CSV schema
               and on-disk layout so existing runs stay readable
    dummy.py   two generators: continuous iperf3 load, and a synthetic UDP
               flow shaped like the camera

The rule both obey: -B is mandatory and the address is read at start, never
cached. An unbound run measures whatever the routing table happens to prefer,
which on this rig was gigabit ethernet until Phase 4.
"""

from .dummy import DummyError, LoadGenerator
from .iperf import IperfError, IperfRunner

__all__ = ["DummyError", "LoadGenerator", "IperfError", "IperfRunner"]
