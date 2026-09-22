"""
The facade the controller and the API talk to.

Holds no state the kernel already holds. Every status call reads the devices
back rather than reporting what was asked for, because the whole point of this
package is that a request and a result are different things.
"""

import logging

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
            # A deep queue on the modem absorbs the gate schedule; see
            # netdev.shallow_fifo for why this is correctness, not tuning.
            try:
                netdev.shallow_fifo(self.underlay, self.shallow_limit)
            except netdev.NetdevError as exc:
                logger.warning("could not set a shallow qdisc on %s: %s",
                               self.underlay, exc)
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
    def apply_gate(self, name, profile, fold=None, dry_run=False):
        dp = self._paths.get(name)
        if dp is None:
            raise BridgeError(
                f"'{name}' is not built, so there is no device to gate. "
                f"Build the data path first.")
        res = gate.apply(dp.dev_veth_a, profile=profile,
                         fold=fold or self.fold, dry_run=dry_run)
        if not dry_run:
            self._gate[name] = profile
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
        return [profiles.describe(n, qmap, fold=f) for n in profiles.names()]

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
            "classes": paths,
            "rules": mark.live(),
        }
