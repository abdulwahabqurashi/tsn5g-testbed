"""
The data path: veth -> vlan -> vxlan -> modem, assembled and taken apart.

The order is the design. Priority is set on the output path, the gate
schedules on that priority, and only then does a VLAN interface turn the
integer into PCP bits. A gate placed after the tag would be sorting traffic by
a field it cannot read; a tag written before the gate would be correct but
pointless, since taprio reads skb->priority and not the wire format.

MTU is computed, never assumed. VXLAN adds 36 bytes of outer headers and the
inner Ethernet frame carries 14 plus a 4-byte 802.1Q tag, so a bearer of 1400
leaves 1346 for the inner IP packet. The tag is the part usually forgotten,
and forgetting it tears exactly the largest frames.
"""

import logging

from . import netdev

logger = logging.getLogger("tsn5g-ue.tsnbridge.datapath")

# VXLAN outer: IP 20 + UDP 8 + VXLAN 8.
VXLAN_OVERHEAD = 36
# Inner Ethernet header plus the 802.1Q tag that carries the PCP.
INNER_ETH_TAGGED = 18


class DatapathError(RuntimeError):
    pass


def inner_mtu(bearer_mtu):
    """The largest inner IP packet that survives encapsulation."""
    mtu = bearer_mtu - VXLAN_OVERHEAD - INNER_ETH_TAGGED
    if mtu < 576:
        raise DatapathError(
            f"a bearer MTU of {bearer_mtu} leaves only {mtu} bytes after VXLAN "
            f"and the VLAN tag, which is below the IPv4 minimum")
    return mtu


class Datapath:
    """One class's worth of devices, from the gate to the modem."""

    def __init__(self, spec, underlay, local_ip, remote_ip, bearer_mtu=1400,
                 group_fwd_mask=0x4000):
        self.name = spec["name"]
        self.vlan = int(spec["vlan"])
        self.vni = int(spec.get("vni", self.vlan))
        self.dstport = int(spec.get("dstport", 4789))
        self.identity_map = bool(spec.get("identity_map", True))
        self.pcp = spec.get("pcp")
        self.bridge_ip = spec.get("bridge_ip")
        self.underlay = underlay
        self.local_ip = local_ip
        self.remote_ip = remote_ip
        self.mtu = inner_mtu(bearer_mtu)
        self.group_fwd_mask = group_fwd_mask
        self._built = []

    # device names, derived so a teardown can find them again
    @property
    def dev_veth_a(self):
        return f"tb-{self.name}a"

    @property
    def dev_veth_b(self):
        return f"tb-{self.name}b"

    @property
    def dev_bridge(self):
        return f"tb-{self.name}br"

    @property
    def dev_vxlan(self):
        return f"tb-{self.name}vx"

    @property
    def dev_vlan(self):
        return f"tb-{self.name}tv"

    def devices(self):
        return [self.dev_vlan, self.dev_vxlan, self.dev_bridge,
                self.dev_veth_a, self.dev_veth_b]

    def build(self, veth_queues=8):
        """Create the chain. Idempotent — tears down first."""
        if not self.local_ip:
            raise DatapathError(
                f"{self.underlay} has no address, so there is no VTEP to build "
                f"from. Bring the bearer up first.")
        self.teardown(quiet=True)

        # 1. the gate's home: a device with enough queues to hold the classes
        netdev.veth_add(self.dev_veth_a, self.dev_veth_b,
                        num_queues=veth_queues, mtu=self.mtu)

        # 2. the tunnel
        netdev._run(["ip", "link", "add", self.dev_vxlan, "type", "vxlan",
                     "id", str(self.vni), "dev", self.underlay,
                     "local", self.local_ip, "remote", self.remote_ip,
                     "dstport", str(self.dstport)])
        netdev.set_mtu(self.dev_vxlan, self.mtu)
        netdev.up(self.dev_vxlan)

        # 3. the tag. This is the device the old transport never created, which
        #    is why its tunnels carried untagged frames and nothing downstream
        #    could classify them.
        egress = (netdev.IDENTITY_MAP if self.identity_map
                  else netdev.remark_map(self.pcp if self.pcp is not None else 0))
        netdev.vlan_add(self.dev_vlan, self.dev_vxlan, self.vlan,
                        egress_map=egress, mtu=self.mtu)

        # 4. join the far end of the veth to the tunnel side
        netdev.bridge_add(self.dev_bridge, group_fwd_mask=self.group_fwd_mask,
                          mtu=self.mtu)
        netdev.enslave(self.dev_veth_b, self.dev_bridge)
        netdev.enslave(self.dev_vlan, self.dev_bridge)

        if self.bridge_ip:
            netdev.addr_add(self.bridge_ip, self.dev_bridge)

        self._built = [d for d in self.devices() if netdev.exists(d)]
        logger.info("datapath '%s' up: vlan %d vni %d port %d mtu %d, %s map",
                    self.name, self.vlan, self.vni, self.dstport, self.mtu,
                    "identity" if self.identity_map else "remark")
        return self.status()

    def teardown(self, quiet=False):
        gone = []
        # veth first: deleting one end removes the other, and the bridge goes
        # after its members so nothing is orphaned mid-teardown.
        for dev in (self.dev_vlan, self.dev_vxlan, self.dev_veth_a,
                    self.dev_veth_b, self.dev_bridge):
            if netdev.delete(dev, quiet=True):
                gone.append(dev)
        self._built = []
        if gone and not quiet:
            logger.info("datapath '%s' removed: %s", self.name, ", ".join(gone))
        return gone

    def status(self):
        present = {d: netdev.exists(d) for d in self.devices()}
        return {
            "name": self.name,
            "vlan": self.vlan, "vni": self.vni, "dstport": self.dstport,
            "mtu": self.mtu,
            "egress_map": "identity" if self.identity_map else "remark",
            "gate_device": self.dev_veth_a,
            "devices": present,
            "up": all(present.values()),
            "bridge_members": netdev.bridge_members(self.dev_bridge)
            if present.get(self.dev_bridge) else [],
        }
