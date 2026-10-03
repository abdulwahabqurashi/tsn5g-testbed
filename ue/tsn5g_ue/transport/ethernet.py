"""
Ethernet-PDU transport — native L2 path.

Modem is in 802-3 mode; this builds a Linux kernel bridge (ds-tt-br0) and puts the
modem's wwan interface and the wired TSN NIC(s) into it, so raw 802.1Q frames cross
the 5G user plane transparently. Ported from the reference DS-TT bridge.py.
"""

import logging

from .. import constants as C
from .. import utils
from ..lldp import configure_lldp_forwarding
from .base import Transport

logger = logging.getLogger("tsn5g-ue.transport.ethernet")


class EthernetTransport(Transport):
    mode = C.TRANSPORT_ETHERNET

    def __init__(self, config, modem):
        super().__init__(config, modem)
        self.bcfg = config.bridge
        self.br = self.bcfg.get("name", C.DEFAULT_BRIDGE_NAME)

    def start(self, wired_nics, role=None):
        self.wired_nics = wired_nics or []
        self.role = role
        if not utils.is_linux():
            raise RuntimeError("transport requires Linux")
        gfm = self.bcfg.get("group_fwd_mask", C.DEFAULT_LLDP_GROUP_FWD_MASK)
        gfm = int(gfm) if isinstance(gfm, int) else int(str(gfm), 0)

        if not utils.iface_exists(self.br):
            utils.ip("link", "add", "name", self.br, "type", "bridge")
        utils.ip("link", "set", "dev", self.br, "type", "bridge",
                 "stp_state", "0" if not self.bcfg.get("stp") else "1",
                 "vlan_filtering", "1" if self.bcfg.get("vlan_filtering", True) else "0",
                 "ageing_time", str(self.bcfg.get("ageing_time", 0)),
                 "group_fwd_mask", hex(gfm))

        for member in [self.modem.wwan] + self.wired_nics:
            if member and utils.iface_exists(member):
                utils.ip("link", "set", member, "master", self.br)
                utils.ip("link", "set", member, "up")
        utils.ip("link", "set", self.br, "up")
        logger.info("ethernet bridge %s up with %s", self.br,
                    [self.modem.wwan] + self.wired_nics)

    def stop(self):
        if utils.is_linux() and utils.iface_exists(self.br):
            utils.ip("link", "del", self.br, check=False)
        logger.info("ethernet bridge %s removed", self.br)

    def enable_lldp_forwarding(self):
        configure_lldp_forwarding(self.br,
                                  self.bcfg.get("group_fwd_mask", C.DEFAULT_LLDP_GROUP_FWD_MASK))

    def get_status(self):
        members = []
        if utils.is_linux() and utils.iface_exists(self.br):
            import glob, os
            members = [os.path.basename(p) for p in
                       glob.glob(f"/sys/class/net/{self.br}/brif/*")]
        return {"mode": self.mode, "bridge": self.br, "wwan": self.modem.wwan,
                "wired_nics": self.wired_nics, "members": members,
                "vlan_filtering": self.bcfg.get("vlan_filtering", True)}

    def check_health(self):
        return utils.iface_exists(self.br) if utils.is_linux() else True
