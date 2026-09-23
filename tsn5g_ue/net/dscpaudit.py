"""
What DSCP is actually on the wire, counted per value.

The outer DSCP is the input to uplink QoS flow binding: the UE's SDAP matches
outgoing packets against QoS rules from the core, those rules carry packet
filters that can match the Type of Service byte, and a match binds the packet
to a QoS flow and therefore to a 5QI. Everything the core and the RAN do with
priority starts from this byte being right.

Which makes it the worst possible thing to assume. `ip link` reporting
`tos 0xb8` says what the device was configured with, not what left it. Before
this existed, the codebase had already shipped one DSCP implementation that
configured cleanly, logged success, and wrote nothing to the header — it set
skb->priority instead. Nobody noticed for weeks because nothing could see the
wire.

So: count it. A `clsact` qdisc carries egress filters without touching the
root qdisc, so the shallow FIFO the gate depends on is undisturbed, and one
u32 filter per DSCP value of interest matches the ToS byte as the packet
leaves. The counters are the answer, and they are counted after encapsulation,
which is the only place the question means anything.

Cheap enough to leave installed: a handful of u32 comparisons per packet on an
interface doing tens of megabits.
"""

import logging
import re

from .. import utils

logger = logging.getLogger("tsn5g-ue.net.dscpaudit")

#: The DS field is the top six bits of the ToS byte; the low two are ECN and
#: are not ours to match on.
DSCP_MASK = 0xFC

#: Filter preference per DSCP, so counters can be told apart when read back.
#: Offset by this so we never collide with a filter someone else installed.
PREF_BASE = 4000


class AuditError(RuntimeError):
    pass


def _has_clsact(dev):
    proc = utils.tc("qdisc", "show", "dev", dev, "clsact", check=False)
    return "clsact" in (proc.stdout or "")


def install(dev, dscps):
    """Count each DSCP in `dscps` as it leaves `dev`. Idempotent."""
    if not dscps:
        raise AuditError("give at least one DSCP value to count")
    for d in dscps:
        if not 0 <= int(d) <= 63:
            raise AuditError(f"dscp {d} out of range 0-63")

    if not _has_clsact(dev):
        proc = utils.tc("qdisc", "add", "dev", dev, "clsact", check=False)
        if proc.returncode != 0 and "exists" not in (proc.stderr or ""):
            raise AuditError(f"could not add clsact to {dev}: "
                             f"{(proc.stderr or '').strip()}")

    remove(dev, quiet=True)
    for d in sorted(set(int(x) for x in dscps)):
        tos = d << 2
        proc = utils.tc("filter", "add", "dev", dev, "egress",
                        "protocol", "ip", "pref", str(PREF_BASE + d),
                        "u32", "match", "ip", "tos", hex(tos), hex(DSCP_MASK),
                        "action", "pass", check=False)
        if proc.returncode != 0:
            raise AuditError(f"could not add a counter for dscp {d} on {dev}: "
                             f"{(proc.stderr or '').strip()}")
    logger.info("dscp audit on %s counting %s", dev, sorted(set(dscps)))
    return read(dev)


def read(dev):
    """Packets seen per DSCP since the counters were installed."""
    proc = utils.tc("-s", "filter", "show", "dev", dev, "egress", check=False)
    out = (proc.stdout or "")
    counts, pref = {}, None
    for line in out.splitlines():
        m = re.search(r"pref (\d+) u32", line)
        if m:
            p = int(m.group(1))
            pref = p - PREF_BASE if p >= PREF_BASE else None
        m2 = re.search(r"Sent (\d+) bytes (\d+) pkt", line)
        if m2 and pref is not None:
            # A u32 filter prints one stats line per matching element; take the
            # largest rather than the first, because the terminal node is the
            # one that actually matched.
            counts[pref] = max(counts.get(pref, 0), int(m2.group(2)))
    return {"device": dev, "installed": bool(counts), "by_dscp": counts}


def remove(dev, quiet=False):
    """Drop our counters, leaving any other filters and the qdisc alone."""
    gone = []
    for d in range(64):
        proc = utils.tc("filter", "del", "dev", dev, "egress",
                        "pref", str(PREF_BASE + d), check=False)
        if proc.returncode == 0:
            gone.append(d)
    if gone and not quiet:
        logger.info("dscp audit counters removed from %s: %s", dev, gone)
    return gone
