"""
The egress queue on the bearer interface.

This is the last thing a packet passes through before the modem, and it can
quietly overrule every scheduling decision made upstream. Two independent ways
it does that, both true of the Linux default:

  Depth. `fq_codel` defaults to 10240 packets — around 14 MB, several seconds
  at bearer rates. A gate schedule works on a 1-2 ms cycle. A queue thousands
  of cycles deep absorbs the schedule entirely: the pattern goes in and a
  smoothed average comes out, and whatever is dropped is dropped for being
  late rather than for being low priority.

  Fairness. `fq_codel` hashes each flow into its own bucket and serves them in
  rotation. That is the right behaviour for a shared uplink and exactly wrong
  here — two camera streams get an equal share no matter what priority was
  assigned. It does not dilute prioritisation, it cancels it.

So the queue is a stated policy, not a default nobody chose:

  shallow   pfifo with a small limit. The gate decides order and rate; this
            keeps the queue too short to reorder or re-pool the result.
            Backpressure reaches the gate quickly, which is what makes the
            gate's decisions survive to the air.
  prio      strict priority on skb->priority, which iptables CLASSIFY has
            already set. Priority at the real bottleneck rather than upstream
            of it — the control that answers "is the gate in the wrong place?"
  default   leave whatever the system default is. For a baseline run that
            deliberately has no policy, so the others have something to be
            measured against.

Whoever owns the interface applies this. For the bearer that is BearerManager,
on every data call — because the address, MTU and queue are all lost when the
call is re-established, and a queue that silently reverted is the failure this
module exists to make impossible.
"""

import logging
import re

from .. import utils

logger = logging.getLogger("tsn5g-ue.net.qdisc")

SHALLOW = "shallow"
PRIO = "prio"
DEFAULT = "default"
POLICIES = (SHALLOW, PRIO, DEFAULT)

#: pfifo deep enough not to underrun the radio, shallow enough that the gate
#: still governs what reaches it. At 1400 B and ~50 Mbit/s, 20 packets is
#: about 4.5 ms — a couple of gate cycles.
DEFAULT_LIMIT = 20

#: skb->priority -> prio band, indexed by priority 0-15. Band 0 is served
#: first. Priorities 4 (802.1Q Video) and 7 (Network Control) get band 0;
#: everything else, best effort included, gets band 1. This mirrors the gate's
#: priority map, so a stream keeps the same standing at the bottleneck that it
#: had at the gate — the two agreeing is the point, and a stream that is
#: protected upstream and best effort downstream is protected nowhere.
DEFAULT_PRIOMAP = [1, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]


class QdiscError(RuntimeError):
    pass


def read(dev):
    """What the kernel actually has on `dev`, as {kind, limit, raw}.

    Read back rather than assumed: applying a qdisc is the easy half, and the
    bug being fixed here was a queue that reverted with nothing noticing.
    """
    proc = utils.tc("qdisc", "show", "dev", dev, check=False)
    raw = (proc.stdout or "").strip()
    first = raw.splitlines()[0] if raw else ""
    m = re.search(r"qdisc\s+(\S+)", first)
    kind = m.group(1) if m else None
    lm = re.search(r"limit\s+(\d+)p", first)
    return {"kind": kind, "limit": int(lm.group(1)) if lm else None, "raw": first}


def apply(dev, policy=SHALLOW, limit=DEFAULT_LIMIT, priomap=None):
    """Put `policy` on `dev`'s root and prove it landed.

    Returns the live queue as `read` reports it. Raises if what the kernel
    ended up with is not what was asked for.
    """
    if policy not in POLICIES:
        raise QdiscError(f"unknown egress queue policy '{policy}'; "
                         f"expected one of {', '.join(POLICIES)}")

    if policy == DEFAULT:
        # Hand it back to the system default rather than pretending to set
        # one. Deleting the root qdisc is what makes the kernel re-apply
        # net.core.default_qdisc.
        utils.tc("qdisc", "del", "dev", dev, "root", check=False)
    elif policy == SHALLOW:
        proc = utils.tc("qdisc", "replace", "dev", dev, "root",
                        "pfifo", "limit", str(int(limit)), check=False)
        if proc.returncode != 0:
            raise QdiscError(f"{dev}: could not set pfifo limit {limit}: "
                             f"{(proc.stderr or '').strip()}")
    elif policy == PRIO:
        # Bands by skb->priority, which the CLASSIFY rules already set, so no
        # filters are needed. The priomap is NOT left at the kernel default:
        # that default maps priority 0 and priority 4 to the same band, so a
        # best-effort stream and a video stream would be queued together and
        # the qdisc would separate nothing. Measured default, for the record:
        #   priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1
        pm = list(priomap or DEFAULT_PRIOMAP)
        if len(pm) != 16:
            raise QdiscError("a prio priomap needs exactly 16 entries, one "
                             "per skb->priority value 0-15")
        proc = utils.tc("qdisc", "replace", "dev", dev, "root", "prio",
                        "bands", "3", "priomap", *[str(x) for x in pm],
                        check=False)
        if proc.returncode != 0:
            raise QdiscError(f"{dev}: could not set prio: "
                             f"{(proc.stderr or '').strip()}")

    live = read(dev)
    if policy == SHALLOW and (live["kind"] != "pfifo" or live["limit"] != int(limit)):
        raise QdiscError(
            f"{dev}: asked for pfifo limit {limit}, kernel reports "
            f"{live['kind']} limit {live['limit']} — the gate would be "
            f"scheduling into a queue that ignores it")
    if policy == PRIO and live["kind"] != "prio":
        raise QdiscError(f"{dev}: asked for prio, kernel reports {live['kind']}")

    logger.info("%s egress queue: policy=%s -> %s", dev, policy, live["raw"])
    return live


def describe(dev, policy=SHALLOW, limit=DEFAULT_LIMIT):
    """The live queue plus whether it still matches the policy.

    `matches` false means something re-applied the default underneath us —
    most often a data call that was re-established. That is worth surfacing
    rather than silently repairing, because it tells you the queue was wrong
    for however long the call has been up.
    """
    live = read(dev)
    if policy == SHALLOW:
        ok = live["kind"] == "pfifo" and live["limit"] == int(limit)
    elif policy == PRIO:
        ok = live["kind"] == "prio"
    else:
        ok = True
    # `wanted_*` is the policy, `kind`/`limit` is the kernel. Reporting both
    # under one name is how a mismatch gets read as agreement.
    return {"policy": policy, "wanted_kind": _kind_for(policy),
            "wanted_limit": int(limit) if policy == SHALLOW else None,
            "matches": bool(ok), **live}


def _kind_for(policy):
    return {SHALLOW: "pfifo", PRIO: "prio"}.get(policy)
