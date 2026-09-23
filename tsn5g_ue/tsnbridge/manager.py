"""
The facade the controller and the API talk to.

Holds no state the kernel already holds. Every status call reads the devices
back rather than reporting what was asked for, because the whole point of this
package is that a request and a result are different things.
"""

import logging

from ..net import qdisc
from . import datapath, gate, mark, netdev, profiles

logger = logging.getLogger("tsn5g-ue.tsnbridge")

BridgeError = datapath.DatapathError


class BridgeManager:
    """Software TSN bridge: classification, gating, tagging, encapsulation."""

    def __init__(self, config=None, bearer=None):
        cfg = (config.as_dict().get("tsnbridge") if config else None) or {}
        self.cfg = cfg
        self.enabled = bool(cfg.get("enabled", False))
        self.underlay = cfg.get("underlay", "wwan0")
        self.remote_ip = cfg.get("remote_ip") or (
            (config.vxlan or {}).get("core_ip") if config else None)
        self.classes = cfg.get("classes") or []
        self.veth_queues = int(cfg.get("veth_queues", 8))
        self.shallow_limit = int(cfg.get("modem_qdisc_limit", 20))
        # What a gate window is measured against. Default is the measured
        # median uplink on this rig, not a link-layer nominal — a window
        # is feasible at the rate the radio actually gives you.
        self.uplink_mbps = float(cfg.get("uplink_mbps", 53))
        # The join between the PCP a stream is marked with and the gate
        # window it lands in. Configurable because it has to agree with
        # the classes, and a mismatch produces a schedule that applies
        # perfectly and separates nothing.
        self.prio_map = cfg.get("prio_map")
        # Mirrors modem.egress_queue so the check compares against what
        # the bearer was actually asked to apply.
        _mq = ((config.modem if config and hasattr(config, "modem") else {}) or {})
        self.queue_policy = (_mq.get("egress_queue") or {}).get(
            "policy", qdisc.SHALLOW)
        # Three classes became two, so profiles written for the switch have a
        # window belonging to a class this bridge does not have. Who inherits
        # it is a stated decision, not a default hidden in the code.
        self.fold = cfg.get("fold", profiles.FOLD_SHARED)
        self.bearer = bearer          # set by the controller
        self._paths = {}
        self._gate = {}               # name -> last applied profile

    # -- helpers ------------------------------------------------------------
    def _local_ip(self):
        """The VTEP address, read now. It changes on every data call."""
        if self.bearer is not None:
            try:
                return (self.bearer.status() or {}).get("ipv4")
            except Exception:                      # noqa: BLE001
                pass
        proc = netdev._run(["ip", "-4", "-o", "addr", "show", self.underlay],
                           check=False)
        import re
        m = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", proc.stdout or "")
        return m.group(1) if m else None

    def _bearer_mtu(self):
        return netdev.link_mtu(self.underlay) or 1400

    def _spec(self, name):
        for c in self.classes:
            if c.get("name") == name:
                return c
        raise BridgeError(
            f"no class named '{name}'. Configured: "
            f"{', '.join(c.get('name', '?') for c in self.classes) or 'none'}")

    # -- lifecycle ----------------------------------------------------------
    def build(self, name=None, dry_run=False):
        """Create one class's data path, or every configured one."""
        local = self._local_ip()
        mtu = self._bearer_mtu()
        wanted = [self._spec(name)] if name else list(self.classes)
        if not wanted:
            raise BridgeError("no classes are configured")

        out = []
        for spec in wanted:
            dp = datapath.Datapath(spec, self.underlay, local, self.remote_ip,
                                   bearer_mtu=mtu)
            if dry_run:
                out.append({"name": dp.name, "dry_run": True,
                            "devices": dp.devices(), "mtu": dp.mtu})
                continue
            out.append(dp.build(veth_queues=self.veth_queues))
            self._paths[dp.name] = dp

        if not dry_run:
            # The bearer owns this interface's queue and re-applies it on every
            # data call — see net/qdisc.py. The bridge only checks, because two
            # owners writing the same qdisc is how they come to disagree
            # without either noticing. A queue that does not match is reported,
            # not silently repaired: it means the gate has been scheduling into
            # something that ignores it, and for how long is worth knowing.
            live = qdisc.describe(self.underlay, self.queue_policy,
                                  self.shallow_limit)
            if not live["matches"]:
                logger.warning(
                    "%s egress queue is %s, not the configured %s — the gate "
                    "schedule will not survive it",
                    self.underlay, live["raw"], live["policy"])
        return {"built": out, "local_ip": local, "bearer_mtu": mtu}

    def teardown(self, name=None):
        wanted = [name] if name else list(self._paths) or \
            [c.get("name") for c in self.classes]
        gone = []
        for n in wanted:
            dp = self._paths.get(n)
            if dp is None:
                dp = datapath.Datapath(self._spec(n), self.underlay, None,
                                       self.remote_ip,
                                       bearer_mtu=self._bearer_mtu())
            gone += dp.teardown()
            self._paths.pop(n, None)
            self._gate.pop(n, None)
        return {"removed": gone}

    # -- gate ---------------------------------------------------------------
    def apply_gate(self, name, profile, fold=None, dry_run=False, force=False):
        dp = self._paths.get(name)
        if dp is None:
            raise BridgeError(
                f"'{name}' is not built, so there is no device to gate. "
                f"Build the data path first.")

        # A window shorter than one packet fails silently: the gate opens and
        # shuts on schedule, the class starves, and the run reads as "the gate
        # did not help" rather than "the gate was never given time to". Refuse
        # it with the arithmetic rather than let it be measured.
        feas = profiles.feasibility(profile, self.uplink_mbps,
                                    mtu=dp.bearer_mtu or 1400,
                                    queue_for_tc=gate.DEFAULT_CLASS_QUEUES,
                                    fold=fold or self.fold)
        if feas["verdict"] == "infeasible" and not force:
            raise BridgeError(
                feas["reason"] + f". Every window has to hold at least one "
                f"{feas['packet_us']:.0f} us packet. Use 'bearer-2ms', which "
                f"is sized for this link, or pass force to apply it anyway.")
        if feas["verdict"] == "marginal":
            logger.warning("gate profile '%s' on %s: %s",
                           profile, name, feas["reason"])

        res = gate.apply(dp.dev_veth_a, profile=profile,
                         prio_map=self.prio_map,
                         fold=fold or self.fold, dry_run=dry_run)
        if not dry_run:
            self._gate[name] = profile
        res["feasibility"] = feas
        return res

    def clear_gate(self, name):
        dp = self._paths.get(name)
        if dp is None:
            raise BridgeError(f"'{name}' is not built")
        self._gate.pop(name, None)
        return gate.clear(dp.dev_veth_a)

    # -- classification -----------------------------------------------------
    def add_rule(self, spec, dry_run=False):
        return mark.add(spec, dry_run=dry_run)

    def remove_rule(self, spec):
        return mark.remove(spec)

    # -- read model ---------------------------------------------------------
    def profiles(self, fold=None):
        qmap = gate.DEFAULT_CLASS_QUEUES
        f = fold or self.fold
        out = []
        for n in profiles.names():
            d = profiles.describe(n, qmap, fold=f)
            # Every profile carries its own verdict, so the UI can grey out the
            # ones this link cannot run instead of offering them and failing.
            d["feasibility"] = profiles.feasibility(
                n, self.uplink_mbps, mtu=self.bearer_mtu(), queue_for_tc=qmap,
                fold=f)
            out.append(d)
        return out

    def bearer_mtu(self):
        """What a packet actually is on the air, for the feasibility maths.

        The bearer MTU (1400), not the inner MTU (1346): serialisation happens
        on wwan0, after encapsulation, so judging a window against the inner
        size would understate every packet by the 54 bytes of overhead.
        """
        for dp in self._paths.values():
            if dp.bearer_mtu:
                return dp.bearer_mtu
        return 1400

    def status(self):
        paths = []
        for spec in self.classes:
            n = spec.get("name")
            dp = self._paths.get(n)
            if dp is None:
                dp = datapath.Datapath(spec, self.underlay, None,
                                       self.remote_ip,
                                       bearer_mtu=self._bearer_mtu())
            st = dp.status()
            st["gate"] = gate.status(dp.dev_veth_a)
            st["gate_profile"] = self._gate.get(n)
            paths.append(st)

        return {
            "enabled": self.enabled,
            "underlay": self.underlay,
            "local_ip": self._local_ip(),
            "remote_ip": self.remote_ip,
            "bearer_mtu": self._bearer_mtu(),
            "inner_mtu": datapath.inner_mtu(self._bearer_mtu()),
            "modem_tx_queues": netdev.tx_queues(self.underlay),
            "fold": self.fold,
            "uplink_mbps": self.uplink_mbps,
            # Which PCP reaches which gate window. Shown rather than assumed:
            # this is the join between marking and scheduling, and a wrong map
            # is invisible in every other field.
            "prio_map": gate.prio_map_table(self.prio_map,
                                            len(gate.DEFAULT_CLASS_QUEUES)),
            "egress_queue": qdisc.describe(self.underlay, self.queue_policy,
                                           self.shallow_limit),
            "classes": paths,
            "rules": mark.live(),
        }
