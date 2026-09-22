"""
Software TSN bridge — the UE doing what a managed TSN switch would.

Kept apart from ``transport/`` deliberately. That package builds the VXLAN
overlay the console has always built; this one is the newer data path in which
the UE itself classifies, gates and tags, so no switch hardware appears between
a camera and the modem. The two can coexist while the new path is proven, and
the old one is not disturbed by work here.

What lives where:

    profiles.py   gate schedules, and the conversion from the switch's 8-bit
                  queue masks to taprio's per-traffic-class masks
    netdev.py     thin ip/tc wrappers, every one of them idempotent
    gate.py       taprio apply / clear / status on a named device
    mark.py       classification — which stream becomes which priority
    datapath.py   assembles veth → vlan → vxlan → modem and takes it apart
    manager.py    the facade the controller and API talk to

The ordering that matters, and the reason the pieces are separate: priority is
set first, the gate schedules on that priority, and only then does a VLAN
interface turn the integer into PCP bits on the wire. Get that order wrong and
the gate sorts traffic that has not been classified yet.
"""

__version__ = "0.1.0"

from .manager import BridgeManager, BridgeError   # noqa: F401
