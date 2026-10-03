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
        """Configure an interface, and report what actually happened.

        This used to return {"ok": True} unconditionally with every command
        run under check=False, so a request that failed outright was reported
        to the operator as a success and left no trace anywhere. It now
        re-reads the interface afterwards and returns the address the kernel
        actually holds.
        """
        if utils.have("nmcli"):
            result = self._nmcli_ip(iface, method, address, gateway)
        else:
            result = self._iproute_ip(iface, method, address, gateway)

        result["ipv4"] = self.current_ipv4(iface)
        if method == "static" and address:
            want = address.split("/")[0]
            if result["ipv4"] != want:
                raise RuntimeError(
                    f"{iface} did not take the address: asked for {address}, "
                    f"it now has {result['ipv4'] or 'none'}. "
                    f"{result.get('detail') or ''}".strip())
        return result

    def _iproute_ip(self, iface, method, address, gateway):
        """Fallback when NetworkManager is absent. Errors are not swallowed."""
        if method == "down":
            utils.ip("link", "set", iface, "down")
        elif method == "static":
            utils.ip("addr", "flush", "dev", iface, check=False)
            utils.ip("addr", "add", address, "dev", iface)
            utils.ip("link", "set", iface, "up")
            if gateway:
                utils.ip("route", "replace", "default", "via", gateway,
                         "dev", iface, check=False)
        else:
            utils.ip("link", "set", iface, "up")
            self.dhcp(iface)
        return {"ok": True, "iface": iface, "method": method, "via": "iproute2"}

    @staticmethod
    def nm_connection_for(iface):
        """The NetworkManager profile bound to this device, or None.

        `nmcli con mod <name>` takes a CONNECTION name, not an interface name,
        and the two rarely match — on this rig enp3s0 is served by a profile
        called "Wired connection 2". Passing the interface name failed with
        "unknown connection" for every interface that had no same-named
        profile, which was all of them but one.
        """
        proc = utils.run(["nmcli", "-t", "-f", "NAME,DEVICE", "con", "show"],
                         check=False, timeout=10)
        for line in (proc.stdout or "").splitlines():
            # NAME may contain ':' so split from the right.
            name, _, dev = line.rpartition(":")
            if dev == iface and name:
                return name
        return None

    def _nmcli_ip(self, iface, method, address, gateway):
        if method == "down":
            proc = utils.run(["nmcli", "device", "disconnect", iface],
                             check=False, timeout=20)
            return {"ok": proc.returncode == 0, "iface": iface, "method": method,
                    "via": "nmcli", "detail": _nm_msg(proc)}

        con = self.nm_connection_for(iface)
        if con is None:
            # No profile for this device. Create one rather than failing —
            # an interface that has never been configured is the normal case
            # for a port someone has just patched in.
            cmd = ["nmcli", "con", "add", "type", "ethernet",
                   "ifname", iface, "con-name", iface]
            if method == "static":
                cmd += ["ipv4.method", "manual", "ipv4.addresses", address]
                if gateway:
                    cmd += ["ipv4.gateway", gateway]
            else:
                cmd += ["ipv4.method", "auto"]
            proc = utils.run(cmd, check=False, timeout=25)
            if proc.returncode != 0:
                raise RuntimeError(
                    f"could not create a NetworkManager profile for {iface}: "
                    f"{_nm_msg(proc)}")
            con = iface
            logger.info("created NetworkManager profile '%s' for %s", con, iface)
        else:
            if method == "static":
                args = ["ipv4.method", "manual", "ipv4.addresses", address]
                # Clear a stale gateway rather than leaving one behind: a
                # second default route would compete with the management one.
                args += ["ipv4.gateway", gateway or ""]
            else:
                args = ["ipv4.method", "auto", "ipv4.addresses", "",
                        "ipv4.gateway", ""]
            proc = utils.run(["nmcli", "con", "mod", con] + args,
                             check=False, timeout=25)
            if proc.returncode != 0:
                raise RuntimeError(
                    f"could not modify connection '{con}' for {iface}: "
                    f"{_nm_msg(proc)}")

        up = utils.run(["nmcli", "con", "up", con], check=False, timeout=45)
        if up.returncode != 0:
            raise RuntimeError(
                f"connection '{con}' would not come up on {iface}: {_nm_msg(up)}")

        return {"ok": True, "iface": iface, "method": method,
                "via": "nmcli", "connection": con, "detail": _nm_msg(up)}

    @staticmethod
    def current_ipv4(iface):
        """The address the kernel holds right now, without the prefix."""
        proc = utils.run(["ip", "-4", "-o", "addr", "show", iface],
                         check=False, timeout=10)
        m = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", proc.stdout or "")
        return m.group(1) if m else None

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


def _nm_msg(proc):
    """nmcli puts its reason on stderr on failure and stdout on success."""
    return ((proc.stderr or "") + (proc.stdout or "")).strip() or None


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
