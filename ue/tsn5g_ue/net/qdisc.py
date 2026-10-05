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
  limited   HTB with the best-effort class hard-capped and the protected class
            free to borrow the rest. The control that answers "can the host
            protect a stream whatever the modem does?" — and the one policy
            here that reduces *offered* load rather than reordering it, which
            is what `prio` cannot do once the queue is permanently full.
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
LIMITED = "limited"
DEFAULT = "default"
POLICIES = (SHALLOW, PRIO, LIMITED, DEFAULT)

#: pfifo deep enough not to underrun the radio, shallow enough that the gate
#: still governs what reaches it. At 1400 B and ~50 Mbit/s, 20 packets is
#: about 4.5 ms — a couple of gate cycles.
DEFAULT_LIMIT = 20

#: HTB class ids for `limited`. CLASSIFY --set-class writes skb->priority with
#: the classid directly, and HTB reads that without needing a single tc filter
#: — which is why the marking rules in tsnbridge/mark.py already have the shape
#: this policy needs.
CLS_ROOT = "1:1"
CLS_PROTECTED = "1:10"
CLS_BEST_EFFORT = "1:20"
#: Auto-rate's delay probe, above both lanes. Its ping must never wait behind
#: camera traffic on the UE: if it rides the protected lane and camera 1 alone
#: exceeds the shaped rate, the ping measures the UE's own queue, auto-rate
#: reads that as the modem filling, cuts, and spirals to its floor (5 Oct).
CLS_PROBE = "1:5"

#: Default cap on the best-effort class, Mbit/s, and the link rate HTB sizes
#: the tree against. The link figure is the *loaded* median measured on this
#: rig, not a nominal rate: HTB shapes against the number it is given, so a
#: nominal ceiling would hand best effort a share the radio cannot deliver and
#: the cap would stop capping under exactly the load it exists for.
DEFAULT_BE_MBPS = 10
DEFAULT_LINK_MBPS = 53

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


def stats(dev):
    """Cumulative counters for the root qdisc and every HTB class on `dev`.

    Packets here are what tc sees, i.e. after IP fragmentation — two per
    camera datagram on this bearer. Compare them with each other, not with a
    datagram count taken anywhere else.
    """
    sent_re = re.compile(r"Sent (\d+) bytes (\d+) pkt \(dropped (\d+), "
                         r"overlimits (\d+)")
    backlog_re = re.compile(r"backlog \S+ (\d+)p")

    def parse(text, head_re):
        out, key = {}, None
        for line in text.splitlines():
            m = re.match(head_re, line)
            if m:
                key = m.group(1)
                out[key] = {"kind": m.group(2) if m.lastindex >= 2 else None}
                continue
            if key is None:
                continue
            m = sent_re.search(line)
            if m:
                out[key].update(bytes=int(m.group(1)), pkts=int(m.group(2)),
                                dropped=int(m.group(3)), overlimits=int(m.group(4)))
            m = backlog_re.search(line)
            if m:
                out[key]["backlog_pkts"] = int(m.group(1))
        return out

    q = utils.tc("-s", "qdisc", "show", "dev", dev, check=False)
    c = utils.tc("-s", "class", "show", "dev", dev, check=False)
    # Keyed by handle; the root is the one whose line says "root".
    qd = parse(q.stdout or "", r"qdisc \S+ (\S+)")
    root = None
    for line in (q.stdout or "").splitlines():
        m = re.match(r"qdisc (\S+) (\S+) root", line)
        if m:
            root = dict(qd.get(m.group(2), {}), kind=m.group(1), handle=m.group(2))
            break
    return {"root": root,
            "classes": parse(c.stdout or "", r"class htb (\S+)")}


def classes(dev):
    """The HTB leaf classes on `dev`, as {classid: {rate, ceil}}.

    `limited` is the one policy whose correctness is not visible in the root
    qdisc line: `htb` appearing there says a tree exists, not that the cap is
    the one asked for. A tree whose best-effort ceiling silently came back as
    the link rate looks identical from `qdisc show` and protects nothing.
    """
    proc = utils.tc("class", "show", "dev", dev, check=False)
    out = {}
    for line in (proc.stdout or "").splitlines():
        m = re.search(r"class htb (\S+)", line)
        if not m:
            continue
        rate = re.search(r"\brate (\S+)", line)
        ceil = re.search(r"\bceil (\S+)", line)
        out[m.group(1)] = {"rate": rate.group(1) if rate else None,
                           "ceil": ceil.group(1) if ceil else None}
    return out


def _mbit(value):
    """tc's own spelling of a rate, so a read-back can be compared to it."""
    return f"{int(value)}Mbit"


def _apply_limited(dev, limit, be_mbps, link_mbps):
    """HTB: best effort hard-capped, protected free to take the rest.

    This is the control for "can the host protect a stream whatever the modem
    does". `prio` answers a narrower question — it reorders, so it only helps
    while there is something to reorder. Once the best-effort stream is deep
    enough to keep the queue permanently full, strict priority still hands the
    radio a backlog; it just hands it in a different order. A rate cap is the
    one thing that stops best effort *offering* the load in the first place.

    Shape of the tree:
      1:1   root, the whole link
      1:10  protected  — rate = link minus the cap, ceil = the whole link, so
                         it takes everything back the moment best effort is idle
      1:20  best effort — rate = ceil = the cap, so it can never borrow. This
                         is the point of the policy; a borrowable ceiling would
                         make the cap advisory.
    `default 20` sends anything unclassified to best effort, which is the safe
    direction to be wrong in: an unmarked stream is capped, not privileged.
    """
    be = int(be_mbps)
    link = int(link_mbps)
    if be <= 0 or link <= 0:
        raise QdiscError("best-effort cap and link rate must both be positive")
    if be >= link:
        raise QdiscError(
            f"{dev}: a best-effort cap of {be} Mbit/s on a {link} Mbit/s link "
            f"caps nothing — the whole point is that it is smaller")
    protected = link - be

    # Tear the root down before building it, rather than `replace`.
    #
    # `replace` on a root that is already `htb 1:` is a *change*, and HTB's root
    # does not support one — tc returns "Change operation not supported by
    # specified qdisc". The first apply on a fresh interface therefore worked
    # and every apply after it failed, which is the wrong way round: it made a
    # rate change silently keep the old tree, and a re-dial log an error over a
    # queue that was in fact fine.
    #
    # Safe here because apply() runs during data-call bring-up, when nothing is
    # flowing yet. The `del` fails harmlessly on an interface that has no root
    # qdisc, which is why its return code is ignored.
    utils.tc("qdisc", "del", "dev", dev, "root", check=False)
    steps = [
        ("qdisc", "add", "dev", dev, "root", "handle", "1:",
         "htb", "default", "20"),
        # `quantum` is explicit on every class, including this one. It is DRR
        # weight between siblings and the root class has none, so here it is
        # cosmetic — but left implicit HTB derives rate/r2q, gets 662 kB at
        # these rates and warns "quantum of class 10001 is big" on every data
        # call. A warning that is always there is a warning nobody reads.
        ("class", "replace", "dev", dev, "parent", "1:", "classid", CLS_ROOT,
         "htb", "rate", _mbit(link), "ceil", _mbit(link), "quantum", "1400"),
        # A tiny guaranteed class for the delay probe, served first. Pings are
        # far below 1 Mbit/s, so they always send under their own rate.
        ("class", "replace", "dev", dev, "parent", CLS_ROOT,
         "classid", CLS_PROBE, "htb", "rate", "1mbit",
         "ceil", _mbit(link), "prio", "0", "quantum", "1400"),
        ("class", "replace", "dev", dev, "parent", CLS_ROOT,
         "classid", CLS_PROTECTED, "htb", "rate", _mbit(protected),
         "ceil", _mbit(link), "prio", "1", "quantum", "1400"),
        ("class", "replace", "dev", dev, "parent", CLS_ROOT,
         "classid", CLS_BEST_EFFORT, "htb", "rate", _mbit(be),
         "ceil", _mbit(be), "prio", "2", "quantum", "1400"),
        # The same shallow FIFO under each leaf, for the same reason it is the
        # whole policy in `shallow`: a deep leaf would re-pool what HTB just
        # separated.
        ("qdisc", "replace", "dev", dev, "parent", CLS_PROBE,
         "pfifo", "limit", "32"),
        ("qdisc", "replace", "dev", dev, "parent", CLS_PROTECTED,
         "pfifo", "limit", str(int(limit))),
        ("qdisc", "replace", "dev", dev, "parent", CLS_BEST_EFFORT,
         "pfifo", "limit", str(int(limit))),
    ]
    for step in steps:
        proc = utils.tc(*step, check=False)
        if proc.returncode != 0:
            raise QdiscError(
                f"{dev}: could not build the limited queue at step "
                f"'{' '.join(step[:4])}': {(proc.stderr or '').strip()}")
    return protected


def apply(dev, policy=SHALLOW, limit=DEFAULT_LIMIT, priomap=None,
          be_mbps=DEFAULT_BE_MBPS, link_mbps=DEFAULT_LINK_MBPS):
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
    elif policy == LIMITED:
        _apply_limited(dev, limit, be_mbps, link_mbps)

    live = read(dev)
    if policy == SHALLOW and (live["kind"] != "pfifo" or live["limit"] != int(limit)):
        raise QdiscError(
            f"{dev}: asked for pfifo limit {limit}, kernel reports "
            f"{live['kind']} limit {live['limit']} — the gate would be "
            f"scheduling into a queue that ignores it")
    if policy == PRIO and live["kind"] != "prio":
        raise QdiscError(f"{dev}: asked for prio, kernel reports {live['kind']}")
    if policy == LIMITED:
        if live["kind"] != "htb":
            raise QdiscError(
                f"{dev}: asked for a limited queue, kernel reports "
                f"{live['kind']}")
        # Read the cap back off the class, not off the root qdisc. The failure
        # this catches is a tree that built but whose best-effort ceiling is
        # not the one asked for — indistinguishable from success in
        # `qdisc show`, and it would let the flood through unshaped.
        cls = classes(dev)
        want = _mbit(be_mbps)
        got = (cls.get(CLS_BEST_EFFORT) or {}).get("ceil")
        if got != want:
            raise QdiscError(
                f"{dev}: asked for a best-effort ceiling of {want}, kernel "
                f"reports {got or 'no such class'} — best effort is not capped "
                f"and the protected stream has no host-side protection")
        live["classes"] = cls

    logger.info("%s egress queue: policy=%s -> %s", dev, policy, live["raw"])
    return live


def describe(dev, policy=SHALLOW, limit=DEFAULT_LIMIT,
             be_mbps=DEFAULT_BE_MBPS):
    """The live queue plus whether it still matches the policy.

    `matches` false means something re-applied the default underneath us —
    most often a data call that was re-established. That is worth surfacing
    rather than silently repairing, because it tells you the queue was wrong
    for however long the call has been up.
    """
    live = read(dev)
    extra = {}
    if policy == SHALLOW:
        ok = live["kind"] == "pfifo" and live["limit"] == int(limit)
    elif policy == PRIO:
        ok = live["kind"] == "prio"
    elif policy == LIMITED:
        cls = classes(dev)
        extra = {"classes": cls, "wanted_be_ceil": _mbit(be_mbps)}
        ok = (live["kind"] == "htb"
              and (cls.get(CLS_BEST_EFFORT) or {}).get("ceil") == _mbit(be_mbps))
    else:
        ok = True
    # `wanted_*` is the policy, `kind`/`limit` is the kernel. Reporting both
    # under one name is how a mismatch gets read as agreement.
    return {"policy": policy, "wanted_kind": _kind_for(policy),
            "wanted_limit": int(limit) if policy == SHALLOW else None,
            "matches": bool(ok), **extra, **live}


def _kind_for(policy):
    return {SHALLOW: "pfifo", PRIO: "prio", LIMITED: "htb"}.get(policy)
