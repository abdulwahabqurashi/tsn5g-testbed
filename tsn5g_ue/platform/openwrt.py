"""
OpenWRT provider.

Speaks the OpenWRT stack natively: **UCI** (`/etc/config/*`) + **netifd** for
network/interface state, **uqmi** for the 5G session (with netifd's ``proto qmi``
owning DHCP + the default route), **iwinfo/ubus** for WiFi, and **procd** for the
service (see ``openwrt/files/tsn5g-ue.init``).

Design intent (per the "few-clicks connect" goal): for the VXLAN/IP path we let
netifd bring the modem up as a managed ``proto qmi`` interface, so lease renewal,
the default route and reconnect are handled by the OS instead of a one-shot DHCP
call. The Ethernet-PDU (802-3) path stays raw AT + qmicli in ModemManager because
netdev/proto support for L2 sessions is not standardised.

On-hardware tuning is expected where marked TODO (interface/section names, the
exact uqmi/iwinfo option set for the installed firmware) — same philosophy as the
rest of the device-plane code.
"""

import json
import logging
import os
import re
import time

from .. import utils
from .base import Platform

logger = logging.getLogger("tsn5g-ue.platform.openwrt")

#: UCI interface section that netifd uses for the 5G modem.
WAN_5G_SECTION = "wan5g"


class OpenWrtPlatform(Platform):
    name = "openwrt"
    service_manager = "procd"
    package_manager = "opkg"

    @classmethod
    def is_current(cls):
        return os.path.exists("/etc/openwrt_release") or (
            utils.have("uci") and os.path.isdir("/etc/config"))

    # -- 5G IP PDU session --------------------------------------------------
    def bring_up_ip_pdu(self, wwan, dnn, qmi_device, cid=1):
        """Bring the modem up as a netifd-managed ``proto qmi`` interface."""
        if utils.have("uci"):
            self._uci_set({
                f"network.{WAN_5G_SECTION}": "interface",
                f"network.{WAN_5G_SECTION}.proto": "qmi",
                f"network.{WAN_5G_SECTION}.device": qmi_device,
                f"network.{WAN_5G_SECTION}.apn": dnn,
                f"network.{WAN_5G_SECTION}.pdptype": "ipv4",
                f"network.{WAN_5G_SECTION}.auth": "none",
            })
            utils.run(["uci", "commit", "network"], check=False)
            utils.run(["ifup", WAN_5G_SECTION], check=False, timeout=40)
            ipv4 = self._wait_for_ip(WAN_5G_SECTION, wwan, timeout=35)
            if ipv4:
                return {"ipv4": ipv4, "method": "netifd:proto-qmi"}
            logger.warning("proto-qmi ifup did not yield an IP; falling back to uqmi")
        return self._uqmi_bring_up(wwan, dnn, qmi_device)

    def _uqmi_bring_up(self, wwan, dnn, qmi_device):
        """Fallback: drive uqmi directly then take a DHCP lease with udhcpc."""
        if not utils.have("uqmi"):
            raise RuntimeError("neither netifd proto-qmi nor uqmi is available")
        utils.run(["uqmi", "-d", qmi_device, "--set-device-operating-mode", "online"], check=False)
        rawip = f"/sys/class/net/{wwan}/qmi/raw_ip"
        if os.path.exists(rawip):
            try:
                with open(rawip, "w", encoding="utf-8") as fh:
                    fh.write("Y")
            except OSError as exc:
                logger.warning("could not set raw_ip: %s", exc)
        utils.run(["uqmi", "-d", qmi_device, "--start-network", "--apn", dnn,
                   "--keep-client-id", "wds"], check=False, timeout=40)
        utils.ip("link", "set", wwan, "up")
        self.dhcp(wwan)
        return {"ipv4": _read_ipv4(wwan), "method": "uqmi+udhcpc"}

    def teardown_ip_pdu(self, wwan, qmi_device):
        if utils.have("uci") and self._uci_has(f"network.{WAN_5G_SECTION}"):
            utils.run(["ifdown", WAN_5G_SECTION], check=False)
        elif utils.have("uqmi"):
            utils.run(["uqmi", "-d", qmi_device, "--stop-network", "0xffffffff",
                       "--autoconnect"], check=False)
        return {"ok": True}

    # -- interface IP -------------------------------------------------------
    def set_ip(self, iface, method, address=None, gateway=None):
        """Configure a wired/generic interface via UCI + netifd.

        Interfaces are keyed in UCI by a logical name; for a plug-and-play NIC we
        use the device name as the section name.
        """
        if not utils.have("uci"):
            # Minimal iproute2 fallback if UCI is somehow absent.
            return self._iproute_set_ip(iface, method, address, gateway)
        section = _uci_name(iface)
        if method == "down":
            utils.run(["ifdown", section], check=False)
            return {"ok": True, "iface": iface, "method": method}
        base = {f"network.{section}": "interface",
                f"network.{section}.device": iface}
        if method == "static":
            addr, _, mask = (address or "").partition("/")
            base[f"network.{section}.proto"] = "static"
            base[f"network.{section}.ipaddr"] = addr
            base[f"network.{section}.netmask"] = _cidr_to_mask(mask or "24")
            if gateway:
                base[f"network.{section}.gateway"] = gateway
        else:  # dhcp
            base[f"network.{section}.proto"] = "dhcp"
        self._uci_set(base)
        utils.run(["uci", "commit", "network"], check=False)
        utils.run(["ifup", section], check=False, timeout=30)
        return {"ok": True, "iface": iface, "method": method}

    def _iproute_set_ip(self, iface, method, address, gateway):
        if method == "down":
            utils.ip("link", "set", iface, "down")
        elif method == "static":
            utils.ip("addr", "flush", "dev", iface, check=False)
            utils.ip("addr", "add", address, "dev", iface)
            utils.ip("link", "set", iface, "up")
            if gateway:
                utils.ip("route", "replace", "default", "via", gateway, "dev", iface, check=False)
        else:
            utils.ip("link", "set", iface, "up")
            self.dhcp(iface)
        return {"ok": True, "iface": iface, "method": method}

    def dhcp(self, iface, timeout=20):
        # busybox udhcpc ships on every OpenWRT image.
        if utils.have("udhcpc"):
            utils.run(["udhcpc", "-q", "-f", "-n", "-i", iface], check=False, timeout=timeout)
        else:
            logger.warning("udhcpc not found for %s", iface)

    # -- WiFi ---------------------------------------------------------------
    def wifi_scan(self):
        dev = self._wifi_device()
        if not (dev and utils.have("iwinfo")):
            return []
        out = utils.run(["iwinfo", dev, "scan"], check=False, timeout=20).stdout
        nets, cur = [], {}
        for line in out.splitlines():
            s = line.strip()
            m = re.search(r'ESSID:\s*"([^"]*)"', s)
            if s.startswith("Cell") or m:
                if cur.get("ssid"):
                    nets.append(cur)
                cur = {"ssid": m.group(1) if m else "", "signal": 0,
                       "security": "Open", "active": False}
            m = re.search(r"Signal:\s*(-?\d+)", s)
            if m:
                cur["signal"] = _dbm_to_pct(int(m.group(1)))
            m = re.search(r"Encryption:\s*(.+)", s)
            if m:
                cur["security"] = m.group(1).strip()
        if cur.get("ssid"):
            nets.append(cur)
        best = {}
        for n in nets:
            if n["ssid"] and (n["ssid"] not in best or n["signal"] > best[n["ssid"]]["signal"]):
                best[n["ssid"]] = n
        return sorted(best.values(), key=lambda x: -x["signal"])

    def wifi_connect(self, ssid, psk=None):
        """Join a network by writing a wifi-iface into UCI and reloading.

        TODO(on-hardware): pick the correct radio/section for multi-radio boards and
        confirm the encryption keyword ('psk2'/'sae') matches the target AP.
        """
        if not utils.have("uci"):
            return {"ok": False, "ssid": ssid, "message": "uci required for WiFi connect"}
        radio = self._wifi_radio() or "radio0"
        section = "wwan"  # client (STA) iface section
        cfg = {f"wireless.{section}": "wifi-iface",
               f"wireless.{section}.device": radio,
               f"wireless.{section}.mode": "sta",
               f"wireless.{section}.network": "wwan",
               f"wireless.{section}.ssid": ssid,
               f"wireless.{section}.encryption": "psk2" if psk else "none"}
        if psk:
            cfg[f"wireless.{section}.key"] = psk
        self._uci_set(cfg)
        utils.run(["uci", "commit", "wireless"], check=False)
        proc = utils.run(["wifi", "reload"], check=False, timeout=30)
        return {"ok": proc.returncode == 0, "ssid": ssid,
                "message": (proc.stdout or proc.stderr).strip() or "reloaded"}

    def wifi_disconnect(self, iface):
        if utils.have("uci"):
            utils.run(["uci", "-q", "delete", "wireless.wwan"], check=False)
            utils.run(["uci", "commit", "wireless"], check=False)
            utils.run(["wifi", "reload"], check=False)
        return {"ok": True, "iface": iface}

    # -- UCI / ubus helpers -------------------------------------------------
    @staticmethod
    def _uci_set(pairs):
        for key, value in pairs.items():
            utils.run(["uci", "set", f"{key}={value}"], check=False)

    @staticmethod
    def _uci_has(key):
        return utils.run(["uci", "-q", "get", key], check=False).returncode == 0

    def _wait_for_ip(self, section, wwan, timeout=35):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ip = self._ubus_iface_ip(section) or _read_ipv4(wwan)
            if ip:
                return ip
            time.sleep(2)
        return None

    @staticmethod
    def _ubus_iface_ip(section):
        if not utils.have("ubus"):
            return None
        proc = utils.run(["ubus", "call", f"network.interface.{section}", "status"],
                         check=False)
        if proc.returncode != 0:
            return None
        try:
            data = json.loads(proc.stdout or "{}")
            addrs = data.get("ipv4-address") or []
            return addrs[0]["address"] if addrs else None
        except (ValueError, KeyError, IndexError):
            return None

    def _wifi_device(self):
        if utils.have("iwinfo"):
            out = utils.run(["iwinfo"], check=False).stdout
            m = re.search(r"^(\w+)\s+ESSID", out, re.MULTILINE)
            if m:
                return m.group(1)
        for cand in ("wlan0", "phy0-sta0"):
            if utils.iface_exists(cand):
                return cand
        return None

    @staticmethod
    def _wifi_radio():
        if utils.have("uci"):
            out = utils.run(["uci", "-q", "show", "wireless"], check=False).stdout
            m = re.search(r"wireless\.(\w+)=wifi-device", out)
            if m:
                return m.group(1)
        return None


# -- module helpers ---------------------------------------------------------
def _read_ipv4(iface):
    try:
        out = utils.ip("-4", "addr", "show", iface, check=False).stdout
        m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", out)
        return m.group(1) if m else None
    except utils.CommandError:
        return None


def _uci_name(iface):
    """A UCI section name is limited to [a-zA-Z0-9_]; NIC names like enp2s0 are fine,
    but strip anything unusual (e.g. dots on VLAN sub-ifaces)."""
    return re.sub(r"[^0-9a-zA-Z_]", "_", iface)


def _cidr_to_mask(bits):
    try:
        n = int(bits)
    except (TypeError, ValueError):
        n = 24
    mask = (0xffffffff << (32 - n)) & 0xffffffff
    return ".".join(str((mask >> s) & 0xff) for s in (24, 16, 8, 0))


def _dbm_to_pct(dbm):
    # Rough dBm→% used only for UI signal bars (-110..-40 → 0..100).
    return max(0, min(100, int((dbm + 110) * 100 / 70)))
