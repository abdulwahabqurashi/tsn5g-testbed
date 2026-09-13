"""
Generic-Linux provider (Debian / Ubuntu, e.g. the Cincoze DI-1200 running a
standard distro).

Uses the desktop/server Linux stack: NetworkManager (nmcli) when present with an
iproute2 + dhclient/udhcpc fallback, and libqmi (qmicli) for the 5G data session.
This is the behaviour the app had before the OpenWRT port, now isolated behind the
platform seam.
"""

import logging
import os
import re
import time

from .. import utils
from .base import Platform

logger = logging.getLogger("tsn5g-ue.platform.linux")


class LinuxPlatform(Platform):
    name = "linux"
    service_manager = "systemd"
    package_manager = "apt"

    @classmethod
    def is_current(cls):
        # Match a Linux box that is NOT OpenWRT (OpenWRT is detected first).
        return utils.is_linux() and not os.path.exists("/etc/openwrt_release")

    # -- modem preparation --------------------------------------------------
    def prepare_modem(self):
        # ModemManager grabs the AT/QMI ports and fights raw AT + qmicli, so stop
        # it (idempotent — only if active). Needs root; the daemon runs as root.
        if utils.have("systemctl"):
            r = utils.run(["systemctl", "is-active", "ModemManager"], check=False)
            if (r.stdout or "").strip() == "active":
                logger.info("stopping ModemManager for raw modem control")
                utils.run(["systemctl", "stop", "ModemManager"], check=False)

    # -- 5G IP PDU session --------------------------------------------------
    def bring_up_ip_pdu(self, wwan, dnn, qmi_device, cid=1):
        # raw-ip framing for the qmi_wwan interface
        utils.run(["ip", "link", "set", wwan, "down"], check=False)
        rawip = f"/sys/class/net/{wwan}/qmi/raw_ip"
        if os.path.exists(rawip):
            try:
                with open(rawip, "w", encoding="utf-8") as fh:
                    fh.write("Y")
            except OSError as exc:
                logger.warning("could not set raw_ip: %s", exc)
        utils.ip("link", "set", wwan, "up")
        if utils.have("qmicli"):
            utils.run(["qmicli", "-d", qmi_device,
                       "--device-open-net=net-raw-ip|net-no-qos-header",
                       f"--wds-start-network=apn={dnn},ip-type=4",
                       "--client-no-release-cid"], check=False, timeout=45)
        # QMI raw-ip does not run DHCP on the netdev — the core assigns the address
        # to the *bearer*, so read it from qmicli and apply it to wwan0 statically.
        # (Verified on RM520N-GL: dhclient gets no lease; get-current-settings does.)
        # The session can take a few seconds to report settings, especially right
        # after (re)registration, so poll rather than reading once.
        s = {}
        for _ in range(6):
            s = self._qmi_settings(qmi_device)
            if s.get("ipv4"):
                break
            time.sleep(2)
        if s.get("ipv4"):
            self._apply_ipv4(wwan, s)
            return {"ipv4": s["ipv4"], "method": "qmicli+static", "gateway": s.get("gw"),
                    "mtu": s.get("mtu")}
        # Fallback for modems that do serve DHCP on the wwan netdev.
        self.dhcp(wwan)
        return {"ipv4": self._read_ipv4(wwan), "method": "qmicli+dhcp"}

    def _qmi_settings(self, qmi_device):
        out = utils.run(["qmicli", "-d", qmi_device, "--wds-get-current-settings"],
                        check=False).stdout or ""
        def grab(pat):
            m = re.search(pat, out)
            return m.group(1) if m else None
        return {"ipv4": grab(r"IPv4 address:\s*([\d.]+)"),
                "mask": grab(r"IPv4 subnet mask:\s*([\d.]+)"),
                "gw": grab(r"IPv4 gateway address:\s*([\d.]+)"),
                "mtu": grab(r"MTU:\s*(\d+)")}

    def _apply_ipv4(self, wwan, s):
        prefix = _mask_to_prefix(s.get("mask") or "255.255.255.255")
        utils.run(["ip", "addr", "flush", "dev", wwan], check=False)
        utils.ip("addr", "add", f"{s['ipv4']}/{prefix}", "dev", wwan)
        if s.get("mtu"):
            utils.run(["ip", "link", "set", wwan, "mtu", s["mtu"]], check=False)
        utils.ip("link", "set", wwan, "up")
        # NOTE: deliberately do NOT install a default route via the modem — that
        # would hijack the box's management/default route. The connected route for
        # the assigned subnet (added automatically by `ip addr add`) is enough to
        # reach the core VXLAN/NW-TT endpoint on the same subnet.
        logger.info("wwan %s configured: %s/%s (gw %s, mtu %s)",
                    wwan, s["ipv4"], prefix, s.get("gw"), s.get("mtu"))

    def teardown_ip_pdu(self, wwan, qmi_device):
        if utils.have("qmicli"):
            utils.run(["qmicli", "-d", qmi_device, "--wds-stop-network=disable-autoconnect"],
                      check=False)
        utils.run(["ip", "link", "set", wwan, "down"], check=False)
        return {"ok": True}

    # -- interface IP -------------------------------------------------------
    def set_ip(self, iface, method, address=None, gateway=None):
        if utils.have("nmcli"):
            return self._nmcli_ip(iface, method, address, gateway)
        if method == "down":
            utils.ip("link", "set", iface, "down")
        elif method == "static":
            utils.ip("addr", "flush", "dev", iface, check=False)
            utils.ip("addr", "add", address, "dev", iface)
            utils.ip("link", "set", iface, "up")
            if gateway:
                utils.ip("route", "replace", "default", "via", gateway, "dev", iface, check=False)
        else:  # dhcp
            utils.ip("link", "set", iface, "up")
            self.dhcp(iface)
        return {"ok": True, "iface": iface, "method": method}

    def _nmcli_ip(self, iface, method, address, gateway):
        if method == "down":
            utils.run(["nmcli", "device", "disconnect", iface], check=False)
        elif method == "static":
            utils.run(["nmcli", "con", "mod", iface, "ipv4.method", "manual",
                       "ipv4.addresses", address]
                      + (["ipv4.gateway", gateway] if gateway else []), check=False)
            utils.run(["nmcli", "con", "up", iface], check=False)
        else:
            utils.run(["nmcli", "con", "mod", iface, "ipv4.method", "auto"], check=False)
            utils.run(["nmcli", "con", "up", iface], check=False)
        return {"ok": True, "iface": iface, "method": method}

    def dhcp(self, iface, timeout=20):
        if utils.have("dhclient"):
            utils.run(["dhclient", iface], check=False, timeout=timeout)
        elif utils.have("udhcpc"):
            utils.run(["udhcpc", "-q", "-f", "-i", iface], check=False, timeout=timeout)
        else:
            logger.warning("no DHCP client (dhclient/udhcpc) found for %s", iface)

    # -- WiFi ---------------------------------------------------------------
    def wifi_scan(self):
        if not utils.have("nmcli"):
            return []
        out = utils.run(["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY,IN-USE",
                         "device", "wifi", "list", "--rescan", "yes"],
                        check=False, timeout=20).stdout
        best = {}
        for line in out.splitlines():
            parts = line.split(":")
            if len(parts) >= 3 and parts[0]:
                sig = _int(parts[1])
                n = {"ssid": parts[0], "signal": sig, "security": parts[2] or "Open",
                     "active": "*" in (parts[3] if len(parts) > 3 else "")}
                if n["ssid"] not in best or sig > best[n["ssid"]]["signal"]:
                    best[n["ssid"]] = n
        return sorted(best.values(), key=lambda x: -x["signal"])

    def wifi_connect(self, ssid, psk=None):
        if not utils.have("nmcli"):
            return {"ok": False, "ssid": ssid, "message": "nmcli required for WiFi connect"}
        cmd = ["nmcli", "device", "wifi", "connect", ssid]
        if psk:
            cmd += ["password", psk]
        proc = utils.run(cmd, check=False, timeout=30)
        return {"ok": proc.returncode == 0, "ssid": ssid,
                "message": (proc.stdout or proc.stderr).strip()}

    def wifi_disconnect(self, iface):
        if utils.have("nmcli"):
            utils.run(["nmcli", "device", "disconnect", iface], check=False)
        return {"ok": True, "iface": iface}

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _read_ipv4(iface):
        try:
            out = utils.ip("-4", "addr", "show", iface, check=False).stdout
            m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", out)
            return m.group(1) if m else None
        except utils.CommandError:
            return None


def _int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return 0


def _mask_to_prefix(mask):
    """Dotted-quad netmask -> CIDR prefix length (e.g. 255.255.255.248 -> 29)."""
    try:
        return sum(bin(int(o)).count("1") for o in mask.split("."))
    except (TypeError, ValueError, AttributeError):
        return 32
