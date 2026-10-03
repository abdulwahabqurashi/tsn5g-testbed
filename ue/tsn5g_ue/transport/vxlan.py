"""
VXLAN transport — COTS-modem path (works over an IP PDU session).

Per TSN VLAN a dedicated VXLAN tunnel carries the Ethernet frames to the core
NW-TT. Data path per class (ported from tsn-scripts/ds_tt.sh + setup_qos.sh):

  wired NIC.<vlan> ─┐
                    ├─ br<vlan> ─ vxlan<vlan> (VNI, dstport, remote=core_ip) ─ wwan0 ─ 5G ─ core_ip
  (PCP preserved) ──┘

PCP is preserved in the inner tag, and each class's configured DSCP is stamped
on the outer header at device creation — that outer value is the only priority
the 5G system can act on, since the inner tag is payload to it. All VXLAN-facing
interfaces use MTU 1450 for header headroom.
"""

import logging

from .. import constants as C
from .. import utils
from .base import Transport

logger = logging.getLogger("tsn5g-ue.transport.vxlan")


class VxlanTransport(Transport):
    mode = C.TRANSPORT_VXLAN

    def __init__(self, config, modem):
        super().__init__(config, modem)
        self.vcfg = config.vxlan or {}
        self.core_ip = self.vcfg.get("core_ip", "10.45.0.1")
        self.mtu = str(self.vcfg.get("mtu", C.VXLAN_MTU))
        self.vlan_map = self.vcfg.get("vlan_map", [])
        self.gfm = self._mask(config.bridge.get("group_fwd_mask", C.DEFAULT_LLDP_GROUP_FWD_MASK))
        self._built = []

    @staticmethod
    def _mask(v):
        return v if isinstance(v, int) else int(str(v), 0)

    def start(self, wired_nics, role=None):
        if not utils.is_linux():
            raise RuntimeError("transport requires Linux")
        self.wired_nics = wired_nics or []
        self.role = role
        wired = self.wired_nics[0] if self.wired_nics else None
        entries = self._select(role)
        local_ip = self.modem.ipv4 or self.modem._read_ipv4()
        if not local_ip:
            raise RuntimeError("no UE IP on the PDU session; is the modem attached?")
        # Remove any stale interfaces from a previous (possibly crashed/killed)
        # run so a reconnect is idempotent — otherwise `ip link add vxlanNN` fails
        # with "File exists".
        self._cleanup_stale(entries, wired)
        for e in entries:
            self._build_class(e, wired, local_ip)
        self._build_ptp(local_ip)

    def _cleanup_stale(self, entries, wired):
        names = []
        for e in entries:
            vlan = e["vlan"]
            names += [f"vxlan{vlan}", f"br{vlan}"]
            if wired:
                names.append(f"{wired}.{vlan}")
        names.append("vxlan_ptp")
        for dev in names:
            if utils.iface_exists(dev):
                utils.ip("link", "del", dev, check=False)
                logger.info("removed stale interface %s before rebuild", dev)

    def _build_class(self, e, wired, local_ip):
        vlan = e["vlan"]; vni = e.get("vni", vlan)
        dstport = str(e.get("dstport", 4789)); pcp = e.get("pcp", 0); dscp = e.get("dscp", 0)
        vx = f"vxlan{vlan}"; br = f"br{vlan}"
        # VXLAN tunnel over the modem IP session
        argv = ["link", "add", vx, "type", "vxlan", "id", str(vni), "dev", self.modem.wwan,
                "local", local_ip, "remote", self.core_ip, "dstport", dstport]
        # The outer DSCP has to be set when the device is created. This used to
        # be attempted afterwards with a tc filter that set skb->priority — a
        # kernel-internal field, not the IP header — so the configured value
        # never reached the wire. DSCP is the top six bits of the TOS byte,
        # and `ip` reads that byte as hex: the decimal string is rejected
        # outright rather than misread.
        if dscp:
            argv += ["tos", hex(int(dscp) << 2)]
        utils.ip(*argv)
        utils.ip("link", "set", vx, "mtu", self.mtu)
        # per-class bridge
        if not utils.iface_exists(br):
            utils.ip("link", "add", "name", br, "type", "bridge")
        utils.ip("link", "set", "dev", br, "type", "bridge", "group_fwd_mask", hex(self.gfm))
        utils.ip("link", "set", br, "mtu", self.mtu)
        # wired NIC VLAN sub-interface carrying this class, with PCP egress map
        if wired:
            sub = f"{wired}.{vlan}"
            utils.ip("link", "add", "link", wired, "name", sub, "type", "vlan", "id", str(vlan),
                     "egress-qos-map", f"0:{pcp}")
            utils.ip("link", "set", sub, "mtu", self.mtu)
            utils.ip("link", "set", sub, "master", br)
            utils.ip("link", "set", sub, "up")
        utils.ip("link", "set", vx, "master", br)
        for dev in (vx, br):
            utils.ip("link", "set", dev, "up")
        self._built += [vx, br] + ([f"{wired}.{vlan}"] if wired else [])
        logger.info("vxlan class vlan=%d vni=%d dstport=%s pcp=%d dscp=%d", vlan, vni, dstport, pcp, dscp)
    def _build_ptp(self, local_ip):
        ptp = self.vcfg.get("ptp") or {}
        if not ptp:
            return
        vx = "vxlan_ptp"
        utils.ip("link", "add", vx, "type", "vxlan", "id", str(ptp.get("vni", 88)),
                 "dev", self.modem.wwan, "local", local_ip, "remote", self.core_ip,
                 "dstport", str(ptp.get("dstport", 4792)), check=False)
        utils.ip("link", "set", vx, "mtu", self.mtu, check=False)
        utils.ip("link", "set", vx, "up", check=False)
        self._built.append(vx)

    def _select(self, role):
        if role:
            hit = [e for e in self.vlan_map if e.get("role") == role or str(e.get("vlan")) == str(role)]
            if hit:
                return hit
        return self.vlan_map

    def stop(self):
        if utils.is_linux():
            for dev in reversed(self._built):
                if utils.iface_exists(dev):
                    utils.ip("link", "del", dev, check=False)
        self._built = []
        logger.info("vxlan transport torn down")

    def enable_lldp_forwarding(self):
        pass  # group_fwd_mask set per-bridge in _build_class

    def get_status(self):
        return {"mode": self.mode, "core_ip": self.core_ip, "mtu": int(self.mtu),
                "role": self.role, "wired_nics": self.wired_nics,
                "classes": [{"vlan": e["vlan"], "vni": e.get("vni", e["vlan"]),
                             "pcp": e.get("pcp"), "dscp": e.get("dscp"), "role": e.get("role")}
                            for e in self.vlan_map],
                "built_interfaces": self._built}

    def check_health(self):
        if not utils.is_linux():
            return True
        return all(utils.iface_exists(d) for d in self._built) if self._built else False
