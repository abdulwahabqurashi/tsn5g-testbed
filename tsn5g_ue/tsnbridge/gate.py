"""
The gate: `taprio` applied to a named device.

Two things here are easy to get wrong and expensive to discover later.

The first is *where* the gate goes. taprio needs one non-overlapping,
contiguous queue range per traffic class, so it cannot be expressed on a
device with a single TX queue — and on this hardware every device on the
uplink path has exactly one. Hence the veth. apply() checks the queue count
before it tries, so the failure names the cause.

The second is what the gate actually controls. It decides which class may
leave *this* device and when. It does not decide when the radio transmits.
On a bearer that is the scheduler's business, and no amount of shaping here
reaches it.
"""

import logging
import time

from . import netdev, profiles

logger = logging.getLogger("tsn5g-ue.tsnbridge.gate")

#: Traffic class -> the switch queue it stands in for. Index is the tc number,
#: so the default two-class bridge is tc0 best effort, tc1 priority.
DEFAULT_CLASS_QUEUES = [profiles.Q_BE_VIDEO, profiles.Q_CONTROL]

#: skb->priority -> traffic class. Priority 7 is the only one that reaches tc1,
#: everything else is best effort, which is the two-class split stated plainly.
DEFAULT_PRIO_MAP = [0, 0, 0, 0, 0, 0, 0, 1]


class GateError(RuntimeError):
    pass


def _base_time(base_sec=None, base_ns=None):
    """A TAI instant in the past that every node shares.

    Anchoring to a common absolute instant rather than "now" is what keeps two
    independently started nodes in phase. taprio accepts a base time in the
    past and projects the cycle forward from it.
    """
    sec = profiles.BASE_SEC if base_sec is None else base_sec
    ns = profiles.BASE_NS if base_ns is None else base_ns
    return sec * 1_000_000_000 + ns


def build_command(dev, entries, cycle_ns, prio_map=None, class_queues=None,
                  base_sec=None, base_ns=None, handle="100"):
    prio_map = prio_map or DEFAULT_PRIO_MAP
    class_queues = class_queues or DEFAULT_CLASS_QUEUES
    num_tc = len(class_queues)

    if len(prio_map) != 8:
        raise GateError("the priority map needs exactly 8 entries, one per "
                        "802.1p priority")
    if max(prio_map) >= num_tc:
        raise GateError(
            f"the priority map refers to traffic class {max(prio_map)} but only "
            f"{num_tc} are defined")

    argv = ["root", "handle", handle, "taprio",
            "num_tc", str(num_tc),
            "map", *[str(x) for x in prio_map],
            "queues", *[f"1@{i}" for i in range(num_tc)],
            "base-time", str(_base_time(base_sec, base_ns))]
    for mask, interval in entries:
        argv += ["sched-entry", "S", f"{mask:02x}", str(interval)]
    # CLOCK_TAI so the schedule is anchored to the same timescale PTP
    # distributes. CLOCK_REALTIME would step when ntp adjusts and drag the
    # gate phase with it.
    argv += ["clockid", "CLOCK_TAI"]
    return argv


def apply(dev, profile=None, entries=None, cycle_ns=None, prio_map=None,
          class_queues=None, fold=profiles.FOLD_SHARED, dry_run=False):
    """Install a gate schedule, or report exactly why it cannot be."""
    class_queues = class_queues or DEFAULT_CLASS_QUEUES

    if not netdev.exists(dev):
        raise GateError(f"{dev} does not exist")

    queues = netdev.tx_queues(dev)
    if queues < len(class_queues):
        raise GateError(
            f"{dev} has {queues} TX queue(s) but the schedule needs "
            f"{len(class_queues)}, one per traffic class. taprio requires a "
            f"separate non-overlapping queue range for each class, so this "
            f"cannot be expressed here. Put the gate on a veth created with "
            f"numtxqueues instead — wwan0 and the tunnel devices all have one "
            f"queue and the modem driver refuses to add more.")

    if profile:
        cycle_ns, entries, _orphaned = profiles.to_taprio(profile, class_queues, fold=fold)
    if not entries:
        raise GateError("no gate entries — give a profile or an explicit list")

    argv = build_command(dev, entries, cycle_ns, prio_map, class_queues)
    if dry_run:
        return {"dry_run": True, "dev": dev, "profile": profile,
                "cycle_ns": cycle_ns, "tx_queues": queues, "fold": fold,
                "command": "tc qdisc replace dev " + dev + " " + " ".join(argv)}

    netdev.qdisc_replace(dev, *argv)
    logger.info("gate on %s: profile=%s cycle=%sns entries=%d",
                dev, profile, cycle_ns, len(entries))
    return {"ok": True, "dev": dev, "profile": profile, "cycle_ns": cycle_ns,
            "entries": len(entries), "tx_queues": queues,
            "applied_at": time.time()}


def clear(dev):
    """Remove the schedule. Leaves the device in place."""
    if not netdev.exists(dev):
        return {"ok": False, "reason": f"{dev} does not exist"}
    netdev.qdisc_del(dev, "root", quiet=True)
    logger.info("gate cleared on %s", dev)
    return {"ok": True, "dev": dev}


def status(dev):
    """What is actually installed, read back from the kernel."""
    if not netdev.exists(dev):
        return {"dev": dev, "present": False}
    raw = netdev.qdisc_show(dev)
    active = "taprio" in raw
    return {
        "dev": dev,
        "present": True,
        "tx_queues": netdev.tx_queues(dev),
        "gate_active": active,
        "raw": raw,
    }
