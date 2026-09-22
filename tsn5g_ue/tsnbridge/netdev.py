"""
Thin wrappers over `ip` and `tc`.

Every function here is idempotent and every one reports what it did, because
the failure mode this whole package exists to avoid is a command that quietly
does nothing while the layer above reports success. Nothing swallows an error;
callers decide what is fatal.
"""

import logging
import re

from .. import utils

logger = logging.getLogger("tsn5g-ue.tsnbridge.netdev")

IFNAME_MAX = 15


class NetdevError(RuntimeError):
    pass


def _run(argv, check=True, timeout=15):
    proc = utils.run(argv, check=False, timeout=timeout)
    if check and proc.returncode != 0:
        raise NetdevError(
            f"{' '.join(argv)} failed ({proc.returncode}): "
            f"{(proc.stderr or proc.stdout or '').strip()}")
    return proc


def valid_ifname(name):
    return bool(name) and len(name) <= IFNAME_MAX and \
        re.fullmatch(r"[A-Za-z0-9_.-]+", name) is not None


def exists(dev):
    return utils.iface_exists(dev)


def delete(dev, quiet=True):
    """Remove a device if it is there. Returns True if something went."""
    if not exists(dev):
        return False
    _run(["ip", "link", "del", dev], check=not quiet)
    logger.info("removed %s", dev)
    return True


def up(dev):
    _run(["ip", "link", "set", dev, "up"])


def set_mtu(dev, mtu):
    _run(["ip", "link", "set", dev, "mtu", str(mtu)])


def tx_queues(dev):
    """How many TX queues a device has — the number that decides whether a
    gate schedule can be expressed on it at all."""
    import glob
    import os
    return len(glob.glob(os.path.join("/sys/class/net", dev, "queues", "tx-*")))


def link_mtu(dev):
    raw = utils.read_sysfs(f"/sys/class/net/{dev}/mtu", None)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


# -- veth -------------------------------------------------------------------
def veth_add(a, b, num_queues=8, mtu=None):
    """A veth pair with enough TX queues to carry traffic classes.

    The queue count is the entire reason this device exists. taprio needs one
    non-overlapping queue range per traffic class, and the modem interface has
    exactly one queue and a driver that refuses more, so the gate has to live
    on something we create.
    """
    for name in (a, b):
        if not valid_ifname(name):
            raise NetdevError(f"invalid interface name '{name}'")
    if exists(a) or exists(b):
        delete(a)
        delete(b)
    _run(["ip", "link", "add", a, "numtxqueues", str(num_queues),
          "numrxqueues", str(num_queues),
          "type", "veth", "peer", "name", b,
          "numtxqueues", str(num_queues), "numrxqueues", str(num_queues)])
    for name in (a, b):
        if mtu:
            set_mtu(name, mtu)
        up(name)
    got = tx_queues(a)
    if got < num_queues:
        raise NetdevError(
            f"{a} came up with {got} TX queues, asked for {num_queues}; "
            f"a gate schedule with more classes than queues will be refused")
    logger.info("veth %s <-> %s up with %d TX queues", a, b, got)
    return {"a": a, "b": b, "tx_queues": got}


# -- vlan -------------------------------------------------------------------
IDENTITY_MAP = "0:0 1:1 2:2 3:3 4:4 5:5 6:6 7:7"


def remark_map(pcp):
    """Collapse every priority onto one PCP."""
    return " ".join(f"{i}:{pcp}" for i in range(8))


def vlan_add(name, parent, vid, egress_map=None, ingress_map=IDENTITY_MAP,
             mtu=None):
    """A VLAN sub-interface — the only place the PCP bits get written.

    With the identity egress map the priority the sender set is the PCP that
    appears on the wire, which is what lets one tunnel carry several classes.
    With a remark map every priority collapses onto one value, which is what
    you want when the sender cannot be trusted to mark anything.
    """
    if not valid_ifname(name):
        raise NetdevError(f"invalid interface name '{name}'")
    delete(name)
    argv = ["ip", "link", "add", "link", parent, "name", name,
            "type", "vlan", "id", str(vid)]
    if ingress_map:
        argv += ["ingress-qos-map", *ingress_map.split()]
    if egress_map:
        argv += ["egress-qos-map", *egress_map.split()]
    _run(argv)
    if mtu:
        set_mtu(name, mtu)
    up(name)
    logger.info("vlan %s on %s vid %s (egress map: %s)",
                name, parent, vid, "identity" if egress_map == IDENTITY_MAP
                else egress_map or "none")
    return name


# -- bridge -----------------------------------------------------------------
def bridge_add(name, group_fwd_mask=None, mtu=None):
    if not exists(name):
        _run(["ip", "link", "add", "name", name, "type", "bridge"])
    if group_fwd_mask is not None:
        # LLDP (01:80:c2:00:00:0e) has to cross the bridge or centralised
        # network configuration cannot discover the topology through us.
        _run(["ip", "link", "set", "dev", name, "type", "bridge",
              "group_fwd_mask", hex(group_fwd_mask)])
    if mtu:
        set_mtu(name, mtu)
    up(name)
    return name


def enslave(dev, bridge):
    _run(["ip", "link", "set", dev, "master", bridge])
    up(dev)


def bridge_members(bridge):
    proc = _run(["bridge", "link", "show"], check=False)
    out = []
    for line in (proc.stdout or "").splitlines():
        m = re.match(r"\d+:\s+(\S+?)[@:]", line)
        if m and f"master {bridge}" in line:
            out.append(m.group(1))
    return out


# -- addresses and routes ---------------------------------------------------
def addr_add(cidr, dev):
    _run(["ip", "addr", "add", cidr, "dev", dev], check=False)


def route_add(prefix, dev):
    _run(["ip", "route", "replace", prefix, "dev", dev], check=False)


# -- qdisc ------------------------------------------------------------------
def qdisc_replace(dev, *args):
    _run(["tc", "qdisc", "replace", "dev", dev, *args])


def qdisc_del(dev, *args, quiet=True):
    _run(["tc", "qdisc", "del", "dev", dev, *args], check=not quiet)


def qdisc_show(dev):
    proc = _run(["tc", "-s", "qdisc", "show", "dev", dev], check=False)
    return (proc.stdout or "").strip()


def shallow_fifo(dev, limit=20):
    """Keep a device from buffering a whole gate cycle.

    This is not tuning. A deep queue downstream of the gate absorbs the
    schedule, smooths the pattern away and then drops whatever happens to
    arrive when it is full — with no regard for traffic class. The gate would
    be configured perfectly and measure nothing.
    """
    qdisc_replace(dev, "root", "pfifo", "limit", str(limit))
    logger.info("%s root qdisc set to pfifo limit %d", dev, limit)
