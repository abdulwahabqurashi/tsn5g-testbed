"""
DS-TT Time-Aware Shaper (IEEE 802.1Qbv "slotting") via Linux `tc ... taprio`.

Applies a gate schedule on a device-side egress interface, reusing the SAME named
profiles as the wired switch so the two stay phase-aligned (shared base-time).
Must be applied AFTER gPTP has locked (the schedule aligns to CLOCK_TAI).

Queue/TC mapping (matches the switch): tc0=CONTROL(PCP7), tc1=HP-VIDEO(PCP4),
tc2=BEST-EFFORT(others). taprio gate mask bit i == tc i.
"""

import logging

from . import constants as C
from . import utils
from .switch import PROFILES

logger = logging.getLogger("tsn5g-ue.tas")

# skb priority (0..7) -> traffic class. PCP7->tc0, PCP4->tc1, else tc2.
PRIO_TO_TC = [2, 2, 2, 2, 1, 2, 2, 0]


class TasError(RuntimeError):
    pass


class TasManager:
    def __init__(self, tas_cfg=None):
        self.cfg = tas_cfg or {}
        self.applied = {}  # iface -> profile name

    def list_profiles(self):
        return [p.to_dict() for p in PROFILES.values()]

    @staticmethod
    def _gatemask(queue_gate):
        """Switch 8-bit queue gate (Q7/Q4/Q0) -> taprio 3-bit tc gate mask."""
        gm = 0
        if queue_gate & 128:   # Q7 open  -> tc0
            gm |= 0x1
        if queue_gate & 16:    # Q4 open  -> tc1
            gm |= 0x2
        if queue_gate & 1:     # Q0 open  -> tc2
            gm |= 0x4
        return gm

    def build_cmd(self, iface, slots, base_sec, base_ns):
        base = base_sec * 1_000_000_000 + base_ns
        cmd = ["tc", "qdisc", "replace", "dev", iface, "root", "taprio",
               "num_tc", "3", "map", *[str(x) for x in PRIO_TO_TC],
               "queues", "1@0", "1@1", "1@2", "base-time", str(base)]
        for gate, interval in slots:
            cmd += ["sched-entry", "S", hex(self._gatemask(int(gate))), str(int(interval))]
        cmd += ["clockid", "CLOCK_TAI"]
        return cmd

    def _resolve(self, profile_name, slots, cycle_ns):
        """Return (slots, base_sec, base_ns, label) from either a preset or custom slots."""
        if slots:
            return ([(int(g), int(iv)) for g, iv in slots],
                    C.QBV_COMMON_BASE_SEC, C.QBV_COMMON_BASE_NS, "custom")
        p = PROFILES.get(profile_name)
        if not p:
            raise TasError(f"unknown profile: {profile_name!r}")
        return (p.slots, p.base_sec, p.base_ns, profile_name)

    def apply(self, iface, profile=None, slots=None, cycle_ns=None, dry_run=False):
        if not iface:
            raise TasError("no egress interface for TAS")
        s, bsec, bns, label = self._resolve(profile, slots, cycle_ns)
        cmd = self.build_cmd(iface, s, bsec, bns)
        if dry_run:
            return {"dry_run": True, "iface": iface, "profile": label, "cmd": " ".join(cmd)}
        if not utils.is_linux():
            raise TasError("TAS requires Linux")
        if not utils.have("tc"):
            raise TasError("tc (iproute2) not available")
        utils.run(cmd)
        self.applied[iface] = label
        logger.info("TAS applied on %s: %s", iface, label)
        return {"dry_run": False, "iface": iface, "profile": label}

    def clear(self, iface):
        if utils.is_linux():
            utils.tc("qdisc", "del", "dev", iface, "root", check=False)
        self.applied.pop(iface, None)
        return {"cleared": True, "iface": iface}

    def get_status(self):
        return {"applied": self.applied}
