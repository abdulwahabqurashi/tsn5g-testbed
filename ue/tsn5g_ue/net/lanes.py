"""
Which stream goes in which egress lane.

`net/qdisc.py` builds the lanes on the bearer; this decides what goes in them.
They are two halves of one policy and neither is useful alone: lanes with
nothing steered into them carry every stream in the default class, which is
exactly a single FIFO wearing a classful costume.

That failure is worth naming because it has already happened here. After a
reboot the queue came back correctly — it is config-driven and re-applied on
every data call — while the classification rules did not, because they were
typed by hand. The lanes were perfect and the protected camera's traffic went
entirely into best effort, with nothing anywhere reporting a problem.

Two rules per protected stream:

  CLASSIFY    writes the HTB classid into skb->priority, which HTB reads
              directly as a class handle. No tc filter is needed.
  MASQUERADE  rewrites the source address. pathStream1 binds its socket to the
              camera-side interface and the kernel fixes the source at
              connect(), before any routing decision — so without this the UPF
              drops the frames as spoofed. MASQUERADE rather than SNAT because
              the UE's address changes on every data call and a hardcoded
              source silently breaks after each one.

Streams with no rule fall to the queue's default class, which is the capped
one. That is the safe direction to be wrong in: an unconfigured stream is
throttled rather than promoted.
"""

import logging
import re

from .. import utils
from ..tsnbridge import mark

logger = logging.getLogger("tsn5g-ue.net.lanes")

#: Lane names in config -> the HTB classid `net/qdisc.py` builds.
LANES = {"protected": "1:10", "best_effort": "1:20"}

NAT_TABLE = "nat"
NAT_CHAIN = "POSTROUTING"


class LaneError(RuntimeError):
    pass


def _nat_rule(dev, spec):
    """The source rewrite for one stream.

    `source_port` pins the stream's translated source port. That is how a
    stream rides the GBR bearer on this testbed: the PCC rule is written in
    downlink form ("to assigned 5202"), Open5GS swaps it for uplink, so uplink
    matches QFI 2 only when the UE's SOURCE port is 5202 (LCP test, 3 Oct).
    """
    rule = ["-t", NAT_TABLE, NAT_CHAIN, "-o", dev,
            "-p", spec.get("proto", "udp"),
            "--dport", str(spec["dport"]), "-j", "MASQUERADE"]
    if spec.get("source_port"):
        rule += ["--to-ports", str(int(spec["source_port"]))]
    return rule


def _nat_apply(dev, spec):
    """Install the source rewrite, once. Idempotent by exact match."""
    argv = _nat_rule(dev, spec)
    check = utils.run(["iptables", argv[0], argv[1], "-C", *argv[2:]],
                      check=False, timeout=10)
    if check.returncode == 0:
        return False
    proc = utils.run(["iptables", argv[0], argv[1], "-A", *argv[2:]],
                     check=False, timeout=10)
    if proc.returncode != 0:
        raise LaneError(f"could not add the source rewrite for port "
                        f"{spec['dport']}: {(proc.stderr or '').strip()}")
    return True


def _nat_remove(dev, spec):
    argv = _nat_rule(dev, spec)
    utils.run(["iptables", argv[0], argv[1], "-D", *argv[2:]],
              check=False, timeout=10)


#: Pure accounting: a rule with no target, matched only to be counted.
COUNT_TABLE = "mangle"
COUNT_CHAIN = "POSTROUTING"
COUNT_TAG = "tsn5g-count:"


def _count_rule(dev, entry):
    """Count one stream's datagrams as they leave on the bearer.

    Per camera, in every policy. The HTB classes only separate traffic under
    `limited`, and the NAT rule counts connections rather than packets, so
    without this there is no per-camera number under `shallow` — which is
    exactly the policy the demo compares against. POSTROUTING is before IP
    fragmentation, so this counts whole datagrams: the same unit the core
    counts on arrival, which makes delivery a straight ratio.
    """
    name = entry.get("name") or f"port {entry.get('dport')}"
    return ["-t", COUNT_TABLE, COUNT_CHAIN, "-o", dev,
            "-p", entry.get("proto", "udp"), "--dport", str(entry["dport"]),
            "-m", "comment", "--comment", f"{COUNT_TAG}{name}"]


def ensure_counters(dev, entries):
    """Install any missing counting rule. Idempotent by exact match."""
    added = 0
    for entry in entries or []:
        if not entry.get("dport"):
            continue
        argv = _count_rule(dev, entry)
        chk = utils.run(["iptables", argv[0], argv[1], "-C", *argv[2:]],
                        check=False, timeout=10)
        if chk.returncode == 0:
            continue
        proc = utils.run(["iptables", argv[0], argv[1], "-A", *argv[2:]],
                         check=False, timeout=10)
        if proc.returncode == 0:
            added += 1
        else:
            logger.warning("could not add the counter for %s: %s",
                           entry.get("name"), (proc.stderr or "").strip())
    return added


def counters(dev, entries):
    """Datagrams and bytes per configured stream, cumulative since the rule."""
    ensure_counters(dev, entries)
    proc = utils.run(["iptables", "-t", COUNT_TABLE, "-L", COUNT_CHAIN,
                      "-v", "-n", "-x"], check=False, timeout=10)
    seen = {}
    for line in (proc.stdout or "").splitlines():
        if COUNT_TAG not in line:
            continue
        parts = line.split()
        try:
            pkts, nbytes = int(parts[0]), int(parts[1])
        except (IndexError, ValueError):
            continue
        name = line.split(COUNT_TAG, 1)[1].split("*/")[0].strip()
        seen[name] = {"pkts": pkts, "bytes": nbytes}
    out = []
    for e in entries or []:
        name = e.get("name") or f"port {e.get('dport')}"
        c = seen.get(name)
        out.append({"name": name, "dport": e.get("dport"),
                    "lane": e.get("lane", "best_effort"),
                    "pkts": c["pkts"] if c else None,
                    "bytes": c["bytes"] if c else None})
    return out


def flush_conntrack(entries):
    """Forget the NAT decision for every configured stream.

    conntrack fixes a flow's source translation on its first packet and keeps
    it. A stream whose first packet went out while the bearer was down — or
    before the MASQUERADE rule existed — is recorded as "no NAT", and keeps
    leaving with its private source after the bearer is back; the core drops
    all of it and nothing on the UE reports a fault. Called on every bring-up,
    so each stream's next packet re-decides against the live rules. A camera
    stream loses nothing by this: UDP has no state for the entry to hold.
    """
    if not utils.have("conntrack"):
        logger.warning("conntrack not installed (apt install conntrack): cannot "
                       "clear stale NAT state, so a stream that started while "
                       "the bearer was down may keep leaving untranslated")
        return 0
    cleared = 0
    for e in entries or []:
        if not e.get("dport"):
            continue
        proc = utils.run(["conntrack", "-D", "-p", e.get("proto", "udp"),
                          "--dport", str(e["dport"])], check=False, timeout=10)
        m = re.search(r"(\d+) flow entries have been deleted", proc.stderr or "")
        cleared += int(m.group(1)) if m else 0
    return cleared


def _spec_for(dev, entry):
    """Turn a config entry into a mark.py rule spec."""
    lane = entry.get("lane", "best_effort")
    if lane not in LANES:
        raise LaneError(f"unknown lane '{lane}' for '{entry.get('name')}'; "
                        f"expected one of {', '.join(LANES)}")
    if not entry.get("dport"):
        raise LaneError(f"'{entry.get('name')}' needs a dport to match on")
    return {"classid": LANES[lane], "proto": entry.get("proto", "udp"),
            "dport": entry["dport"], "oif": dev}


def apply(dev, entries):
    """Install every configured stream's rules on `dev`, and prove they landed.

    Only streams in a non-default lane get a CLASSIFY rule — writing one for
    the best-effort lane would be redundant with the qdisc's own default and
    just one more rule to go stale.
    """
    results = []
    for entry in entries or []:
        name = entry.get("name") or f"port {entry.get('dport')}"
        spec = _spec_for(dev, entry)
        added_cls = False
        if entry.get("lane") == "protected":
            r = mark.add(spec)
            added_cls = not r.get("already_present")
        added_nat = _nat_apply(dev, entry) if entry.get("masquerade", True) else False
        ensure_counters(dev, [entry])
        results.append({"name": name, "dport": entry["dport"],
                        "lane": entry.get("lane", "best_effort"),
                        "classid": LANES[entry.get("lane", "best_effort")],
                        "classify_added": added_cls, "nat_added": added_nat})
        logger.info("lane: %s udp/%s -> %s", name, entry["dport"],
                    LANES[entry.get("lane", "best_effort")])

    live = verify(dev, entries)
    if not live["matches"]:
        raise LaneError(
            f"{dev}: classification did not land — {live['missing']} — the "
            f"lanes exist but nothing is being steered into them, so every "
            f"stream would share the default class")
    return results


def remove(dev, entries):
    """Delete exactly these rules. Never flushes a chain."""
    for entry in entries or []:
        if entry.get("lane") == "protected":
            mark.remove(_spec_for(dev, entry))
        if entry.get("masquerade", True):
            _nat_remove(dev, entry)
        if entry.get("dport"):
            argv = _count_rule(dev, entry)
            utils.run(["iptables", argv[0], argv[1], "-D", *argv[2:]],
                      check=False, timeout=10)


def verify(dev, entries):
    """Read the kernel back and say which configured streams are missing.

    Checked by exact rule match rather than by counting: a chain with the right
    number of wrong rules looks identical to a correct one from a distance.
    """
    missing = []
    for entry in entries or []:
        name = entry.get("name") or f"port {entry.get('dport')}"
        if entry.get("lane") == "protected" and not mark.exists(_spec_for(dev, entry)):
            missing.append(f"{name}: no CLASSIFY rule")
        if entry.get("masquerade", True):
            argv = _nat_rule(dev, entry)
            chk = utils.run(["iptables", argv[0], argv[1], "-C", *argv[2:]],
                            check=False, timeout=10)
            if chk.returncode != 0:
                missing.append(f"{name}: no source rewrite")
    return {"matches": not missing, "missing": missing,
            "configured": len(entries or [])}


def describe(dev, entries):
    """Config against kernel, for status and for the UI."""
    live = verify(dev, entries)
    return {"interface": dev, "matches": live["matches"],
            "missing": live["missing"],
            "streams": [{"name": e.get("name"), "dport": e.get("dport"),
                         "proto": e.get("proto", "udp"),
                         "lane": e.get("lane", "best_effort"),
                         "source_port": e.get("source_port"),
                         "classid": LANES.get(e.get("lane", "best_effort"))}
                        for e in (entries or [])]}
