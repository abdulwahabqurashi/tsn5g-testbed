"""
Network interfaces manager — Ethernet + WiFi on the Linux UE (e.g. Cincoze DI-1200).

Lists physical interfaces (link/speed/IP/MAC) directly from sysfs (OS-agnostic), and
delegates the *mutating* actions — IP config (DHCP/static) and WiFi (scan/connect) —
to the active platform provider so the same UI works on both OpenWRT (UCI/netifd/
iwinfo) and generic Linux (NetworkManager/iproute2). Mutating actions need root.
"""

import glob
import logging
import os
import re

from .. import utils

logger = logging.getLogger("tsn5g-ue.netiface")

_SKIP = ("lo", "docker", "veth", "br-", "virbr", "ogstun", "ogstap")


class NetIfaceError(RuntimeError):
    pass


class NetIfaceManager:
    def __init__(self, cfg=None, platform=None):
        self.cfg = cfg or {}
        if platform is None:
            from .platform import get_platform
            platform = get_platform()
        self.platform = platform

    # ------------------------------------------------------------- discovery
    def list_interfaces(self):
        if not utils.is_linux():
            return []
        wwan = self.cfg.get("wwan_interface", "wwan0")
        out = []
        for path in sorted(glob.glob("/sys/class/net/*")):
            name = os.path.basename(path)
            if name.startswith(_SKIP):
                continue
            is_phys = os.path.exists(os.path.join(path, "device"))
            kind = self._kind(name, path, wwan, is_phys)
            if kind == "other" and not is_phys:
                continue
            out.append({
                "name": name, "kind": kind,
                "state": utils.read_sysfs(f"{path}/operstate", "unknown"),
                "carrier": utils.read_sysfs(f"{path}/carrier") == "1",
                "mac": utils.read_sysfs(f"{path}/address"),
                "speed": self._speed(name, path),
                "mtu": utils.read_sysfs(f"{path}/mtu"),
                "ipv4": self._ipv4(name),
            })
        return out

    def _kind(self, name, path, wwan, is_phys):
        if name == wwan or name.startswith(("wwan", "mhi")):
            return "modem"
        if os.path.exists(os.path.join(path, "wireless")) or name.startswith(("wl", "wlan", "wlp")):
            return "wifi"
        if name.startswith(("en", "eth", "eno", "enp", "ens")):
            return "ethernet"
        return "other"

    def _speed(self, name, path):
        sp = utils.read_sysfs(f"{path}/speed")
        if sp and sp.lstrip("-").isdigit() and int(sp) > 0:
            return f"{int(sp)} Mb/s"
        return None

    def _ipv4(self, name):
        try:
            out = utils.ip("-4", "addr", "show", name, check=False).stdout
            m = re.search(r"inet (\d+\.\d+\.\d+\.\d+/\d+)", out)
            return m.group(1) if m else None
        except utils.CommandError:
            return None

    # ------------------------------------------------------------- config IP
    def set_ip(self, iface, method, address=None, gateway=None):
        """method: 'dhcp' | 'static' | 'down'. address like '192.168.1.50/24'."""
        if not utils.is_linux():
            raise NetIfaceError("requires Linux")
        return self.platform.set_ip(iface, method, address=address, gateway=gateway)

    # ------------------------------------------------------------- WiFi
    def wifi_scan(self):
        if not utils.is_linux():
            return []
        return self.platform.wifi_scan()

    def wifi_connect(self, ssid, psk=None):
        if not utils.is_linux():
            raise NetIfaceError("requires Linux")
        return self.platform.wifi_connect(ssid, psk=psk)

    def wifi_disconnect(self, iface):
        return self.platform.wifi_disconnect(iface)
