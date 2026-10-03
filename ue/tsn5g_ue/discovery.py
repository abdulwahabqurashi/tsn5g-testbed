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
import re

from . import utils
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
        """Work out which traffic class this UE is carrying.

        The UE's address inside the SMF pool identifies it, and the config's
        vlan_map says which class each UE handles. Matching the two is how the
        wizard pre-selects the right role instead of asking the operator to
        remember it.

        Returns {} when there is nothing to go on — no address yet, or no
        vlan_map — which is a real answer, not a failure.
        """
        vlan_map = (self.config.vxlan or {}).get("vlan_map") or []
        if not vlan_map:
            return {}

        wwan = self.config.modem.get("wwan_interface", "wwan0")
        addr = None
        try:
            proc = utils.run(["ip", "-4", "-o", "addr", "show", wwan],
                             check=False, timeout=10)
            m = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", proc.stdout or "")
            addr = m.group(1) if m else None
        except Exception:                   # noqa: BLE001
            addr = None
        if not addr:
            return {"reason": f"{wwan} has no address yet"}

        # The last octet of the UE address selects the entry, which is the
        # convention the vlan_map is written against.
        try:
            last = int(addr.rsplit(".", 1)[1])
        except (IndexError, ValueError):
            return {"reason": f"could not read the host part of {addr}"}

        entry = None
        for i, item in enumerate(vlan_map):
            if item.get("ue") == last or item.get("ue_host") == last:
                entry = item
                break
        if entry is None and len(vlan_map) == 1:
            entry = vlan_map[0]              # only one class: no ambiguity
        if entry is None:
            idx = (last - 2) % len(vlan_map)  # pool starts at .2
            entry = vlan_map[idx]
            return {"role": entry.get("role"), "vlan": entry.get("vlan"),
                    "ipv4": addr, "confidence": "guessed",
                    "reason": "no explicit ue mapping; derived from the host "
                              "part of the address"}
        return {"role": entry.get("role"), "vlan": entry.get("vlan"),
                "ipv4": addr, "confidence": "matched"}

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

    # ethtool prints one capability per line under "Capabilities:". Hardware
    # transmit/receive are the two ptp4l needs; software timestamping is not
    # accurate enough for 802.1AS, so treating every physical NIC as capable
    # (which this did) offered ptp4l interfaces that would fail at start.
    _HW_TS_CAPS = ("hardware-transmit", "hardware-receive")

    @classmethod
    def _supports_hw_timestamp(cls, name):
        if not is_linux() or not utils.have("ethtool"):
            return None            # unknown, which is not the same as False
        try:
            out = utils.run(["ethtool", "-T", name], check=False, timeout=10).stdout
        except Exception:          # noqa: BLE001 — discovery must not fail
            return None
        caps = out.lower()
        return all(c in caps for c in cls._HW_TS_CAPS)
