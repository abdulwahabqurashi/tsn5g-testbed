"""
Hardware auto-detection — the plug-and-play front door.

Detects the 5G modem (serial + wwan interface), candidate wired TSN NICs, and
(for VXLAN) infers the traffic-class role from the IP the modem was assigned on
the TSN subnet. Feeds the Connect wizard so the operator confirms rather than types.

On non-Linux dev machines these return empty/graceful results.
"""

import glob
import logging
import os

from . import constants as C
from .utils import is_linux

logger = logging.getLogger("tsn5g-ue.discovery")

_SKIP_IFACE_PREFIXES = ("lo", "docker", "veth", "br-", "virbr", "ogstun", "ogstap")


class Discovery:
    def __init__(self, config, platform=None):
        self.config = config
        if platform is None:
            from .platform import get_platform
            platform = get_platform(config)
        self.platform = platform

    # -- modem --------------------------------------------------------------
    def find_modem(self):
        """
        Return {'serial', 'qmi', 'model', 'wwan', 'candidates', 'present'}. Probes
        for the real AT port (see modem.detect_modem_ports) rather than guessing an
        enumeration index, and globs the QMI control device.
        """
        from .modem import detect_modem_ports
        ports = detect_modem_ports(self.config.modem.get("device"),
                                   self.config.modem.get("qmi_device"),
                                   self.config.modem.get("baud_rate", 115200))
        wwan = self.config.modem.get("wwan_interface", "wwan0")
        wwan_present = self._iface_exists(wwan)
        return {"serial": ports.get("at"), "qmi": ports.get("qmi"),
                "model": ports.get("model"), "candidates": ports.get("candidates", []),
                "wwan": wwan if wwan_present else None,
                "present": bool(ports.get("at") or wwan_present)}

    # -- wired NICs ---------------------------------------------------------
    def find_tsn_nics(self):
        """
        Candidate wired NICs to bridge (physical, not the modem/bridge/loopback).
        Returns list of {'interface', 'hw_timestamping', 'carrier'}.
        """
        if not is_linux():
            return [{"interface": n["interface"], "hw_timestamping":
                     n.get("hw_timestamping", False), "carrier": None}
                    for n in self.config.tsn_nics]

        wwan = self.config.modem.get("wwan_interface", "wwan0")
        bridge = self.config.bridge.get("name", C.DEFAULT_BRIDGE_NAME)
        out = []
        for path in sorted(glob.glob("/sys/class/net/*")):
            name = os.path.basename(path)
            if name in (wwan, bridge) or name.startswith(_SKIP_IFACE_PREFIXES):
                continue
            if not os.path.exists(os.path.join(path, "device")):
                continue  # skip virtual interfaces
            out.append({
                "interface": name,
                "hw_timestamping": self._supports_hw_timestamp(name),
                "carrier": self._read_int(os.path.join(path, "carrier")),
            })
        return out

    # -- VXLAN role inference ----------------------------------------------
    def infer_role(self):
        """
        For VXLAN mode, map the modem's assigned 10.45.0.x IP to a VLAN/role using
        the configured vlan_map (mirrors tsn-scripts/ds_tt.sh auto-detect).
        Returns {'ip', 'vlan', 'role'} or empty dict. TODO: read live wwan IP.
        """
        # TODO(port ds_tt.sh): read the wwan interface IPv4 and look up vlan_map.
        return {}

    def summary(self):
        """Everything the wizard needs in one call (GET /api/discovery)."""
        return {
            "modem": self.find_modem(),
            "tsn_nics": self.find_tsn_nics(),
            "inferred_role": self.infer_role(),
            "linux": is_linux(),
            "platform": self.platform.summary(),
        }

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _iface_exists(name):
        return bool(name) and os.path.exists(f"/sys/class/net/{name}")

    @staticmethod
    def _read_int(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return int(fh.read().strip())
        except (OSError, ValueError):
            return None

    @staticmethod
    def _supports_hw_timestamp(name):
        # TODO: query via ethtool -T; assume True for physical NICs for now.
        return True
