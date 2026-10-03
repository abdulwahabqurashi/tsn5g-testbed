"""
Classification — deciding which stream becomes which priority.

The camera application terminates GigE Vision and emits a new UDP stream from
a socket, so the packets that cross 5G are ones the UE created. `tc ingress` on
the camera port would mark frames that are then consumed and thrown away, which
is a mistake worth naming because the rule looks right and does nothing.

Marking therefore happens on the output path. Rules are recorded verbatim and
removed by exact match, never by flushing a chain — this is a shared machine
and the chain is not ours to empty.
"""

import logging

from .. import utils

logger = logging.getLogger("tsn5g-ue.tsnbridge.mark")

CHAIN = "POSTROUTING"
TABLE = "mangle"


class MarkError(RuntimeError):
    pass


def _set_class(spec):
    """The `--set-class major:minor` value for a spec.

    Two callers want different halves of the same field. The gate wants a bare
    802.1p priority, which is `0:<prio>` — major 0, because no classful qdisc is
    meant to claim it. HTB wants a real classid like `1:10`, because
    CLASSIFY writes skb->priority and HTB reads exactly that as a class
    handle, which is what lets the lanes work without a single tc filter.

    So `classid` wins when given, and `priority` is the shorthand for the
    gate's case.
    """
    cid = spec.get("classid")
    if cid:
        return str(cid)
    return f"0:{int(spec['priority'])}"


def _rule(spec):
    """The iptables argument vector for one classification rule.

    CLASSIFY --set-class major:minor writes skb->priority directly, which is
    the integer taprio's `map` reads and the VLAN egress map later turns into
    PCP bits. Using MARK instead would set fwmark, which is a different field
    that nothing downstream here looks at.
    """
    proto = spec.get("proto", "udp")
    argv = ["-t", TABLE, CHAIN, "-p", proto]
    if spec.get("dport"):
        argv += ["--dport", str(spec["dport"])]
    if spec.get("sport"):
        argv += ["--sport", str(spec["sport"])]
    if spec.get("dst"):
        argv += ["-d", spec["dst"]]
    if spec.get("src"):
        argv += ["-s", spec["src"]]
    if spec.get("oif"):
        argv += ["-o", spec["oif"]]
    argv += ["-j", "CLASSIFY", "--set-class", _set_class(spec)]
    return argv


def exists(spec):
    """True if exactly this rule is already in the table.

    The argv splice matters and was wrong here: `_rule()` returns
    `-t mangle POSTROUTING ...`, so inserting `-C` after the first element
    produced `iptables -t -C mangle POSTROUTING ...` — `-t` swallowed `-C` as
    its table name and the command failed every time, whether or not the rule
    was present. `add()` has always spliced correctly, which is why it stayed
    idempotent and this went unnoticed until something checked a rule it had
    just successfully installed.
    """
    argv = _rule(spec)
    proc = utils.run(["iptables", argv[0], argv[1], "-C", *argv[2:]],
                     check=False, timeout=10)
    return proc.returncode == 0


def add(spec, dry_run=False):
    """Install one rule. Idempotent: an identical rule is not duplicated."""
    if "classid" not in spec:
        if "priority" not in spec:
            raise MarkError("a rule needs either a priority (0-7) or a classid")
        prio = int(spec["priority"])
        if not 0 <= prio <= 7:
            raise MarkError(f"priority {prio} is out of range; 802.1p is 0-7")

    argv = _rule(spec)
    if dry_run:
        return {"dry_run": True, "command": "iptables -A " + " ".join(argv)}

    check = utils.run(["iptables", argv[0], argv[1], "-C", *argv[2:]],
                      check=False, timeout=10)
    if check.returncode == 0:
        return {"ok": True, "already_present": True, "rule": " ".join(argv)}

    proc = utils.run(["iptables", argv[0], argv[1], "-A", *argv[2:]],
                     check=False, timeout=10)
    if proc.returncode != 0:
        raise MarkError(
            f"could not install the rule: {(proc.stderr or '').strip()}")
    logger.info("classify: %s -> %s",
                spec.get("dport") or spec.get("dst") or "any", _set_class(spec))
    return {"ok": True, "rule": " ".join(argv)}


def remove(spec):
    """Delete exactly this rule, if it is there. Never flushes."""
    argv = _rule(spec)
    proc = utils.run(["iptables", argv[0], argv[1], "-D", *argv[2:]],
                     check=False, timeout=10)
    return {"ok": proc.returncode == 0,
            "rule": " ".join(argv),
            "detail": (proc.stderr or "").strip() or None}


def live():
    """Every CLASSIFY rule currently in the mangle table."""
    proc = utils.run(["iptables", "-t", TABLE, "-S", CHAIN],
                     check=False, timeout=10)
    return [ln.strip() for ln in (proc.stdout or "").splitlines()
            if "CLASSIFY" in ln]
