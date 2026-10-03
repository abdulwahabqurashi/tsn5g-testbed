"""
Linux bridge manager for DS-TT.

Creates a kernel bridge to forward L2 Ethernet frames between
the 5G modem (wwan0) and TSN-capable NICs. Mirrors the bridge
management patterns from src/tsn-af/bridge-mgmt.c using pyroute2
with subprocess fallback.
"""

import logging
import os
import subprocess

logger = logging.getLogger("ds-tt.bridge")


def _sysfs_write(path, value):
    """Write a value to a sysfs file."""
    try:
        with open(path, "w") as f:
            f.write(str(value))
        return True
    except (OSError, PermissionError) as e:
        logger.warning("sysfs write %s=%s failed: %s", path, value, e)
        return False


def _sysfs_read(path):
    """Read a value from a sysfs file."""
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except (OSError, FileNotFoundError):
        return None


def _run(cmd, check=True):
    """Run a shell command."""
    logger.debug("$ %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if check and result.returncode != 0:
        logger.error("Command failed: %s\nstderr: %s", " ".join(cmd), result.stderr)
        raise RuntimeError(f"Command failed: {' '.join(cmd)}: {result.stderr}")
    return result


class BridgeManager:
    """Manages a Linux kernel bridge for DS-TT L2 forwarding."""

    def __init__(self, config, wwan_iface):
        self.name = config["name"]
        self.stp = config.get("stp", False)
        self.vlan_filtering = config.get("vlan_filtering", True)
        self.group_fwd_mask = config.get("group_fwd_mask", 0x4000)
        self.ageing_time = config.get("ageing_time", 0)
        self.wwan_iface = wwan_iface
        self._interfaces = []
        self._created = False
        self._pyroute2 = None

    def _try_pyroute2(self):
        """Try to import and use pyroute2 for netlink-based bridge management."""
        try:
            from pyroute2 import IPRoute
            self._pyroute2 = IPRoute()
            return True
        except ImportError:
            logger.info("pyroute2 not available, using ip/bridge commands")
            return False

    def create(self, tsn_interfaces):
        """Create the bridge and attach all interfaces."""
        logger.info("Creating bridge '%s'", self.name)

        use_netlink = self._try_pyroute2()

        # Create bridge
        if use_netlink:
            self._create_bridge_netlink()
        else:
            self._create_bridge_iproute2()

        self._created = True

        # Configure bridge parameters via sysfs
        self._configure_sysfs()

        # Bring bridge up
        if use_netlink:
            idx = self._pyroute2.link_lookup(ifname=self.name)[0]
            self._pyroute2.link("set", index=idx, state="up")
        else:
            _run(["ip", "link", "set", self.name, "up"])

        # Attach modem interface
        self._attach_interface(self.wwan_iface, use_netlink)

        # Attach TSN NICs
        for iface in tsn_interfaces:
            self._attach_interface(iface, use_netlink)

        logger.info("Bridge '%s' created with interfaces: %s",
                     self.name, self._interfaces)

    def _create_bridge_netlink(self):
        """Create bridge using pyroute2 netlink."""
        try:
            self._pyroute2.link("add", ifname=self.name, kind="bridge")
            logger.info("Bridge '%s' created via netlink", self.name)
        except Exception as e:
            if "File exists" in str(e):
                logger.info("Bridge '%s' already exists", self.name)
            else:
                raise

    def _create_bridge_iproute2(self):
        """Create bridge using ip command."""
        result = subprocess.run(
            ["ip", "link", "add", self.name, "type", "bridge"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            if "File exists" in result.stderr:
                logger.info("Bridge '%s' already exists", self.name)
            else:
                raise RuntimeError(f"Failed to create bridge: {result.stderr}")

    def _configure_sysfs(self):
        """Configure bridge parameters via sysfs."""
        bridge_sysfs = f"/sys/class/net/{self.name}/bridge"

        # STP
        _sysfs_write(f"{bridge_sysfs}/stp_state", 1 if self.stp else 0)

        # VLAN filtering
        _sysfs_write(f"{bridge_sysfs}/vlan_filtering", 1 if self.vlan_filtering else 0)

        # MAC ageing time (in centiseconds for sysfs)
        _sysfs_write(f"{bridge_sysfs}/ageing_time", self.ageing_time * 100)

        # group_fwd_mask — enables forwarding of LLDP and gPTP multicast
        _sysfs_write(f"{bridge_sysfs}/group_fwd_mask", self.group_fwd_mask)

        logger.info("Bridge sysfs configured: stp=%s vlan_filtering=%s "
                     "ageing_time=%d group_fwd_mask=0x%04x",
                     self.stp, self.vlan_filtering,
                     self.ageing_time, self.group_fwd_mask)

    def _attach_interface(self, iface, use_netlink=False):
        """Attach an interface to the bridge."""
        if not os.path.exists(f"/sys/class/net/{iface}"):
            logger.warning("Interface '%s' does not exist — skipping", iface)
            return False

        try:
            if use_netlink:
                br_idx = self._pyroute2.link_lookup(ifname=self.name)[0]
                if_idx = self._pyroute2.link_lookup(ifname=iface)[0]
                self._pyroute2.link("set", index=if_idx, master=br_idx)
            else:
                _run(["ip", "link", "set", iface, "master", self.name])

            # Bring interface up
            if use_netlink:
                if_idx = self._pyroute2.link_lookup(ifname=iface)[0]
                self._pyroute2.link("set", index=if_idx, state="up")
            else:
                _run(["ip", "link", "set", iface, "up"])

            self._interfaces.append(iface)
            logger.info("Attached '%s' to bridge '%s'", iface, self.name)
            return True

        except Exception as e:
            logger.error("Failed to attach '%s' to bridge: %s", iface, e)
            return False

    def destroy(self):
        """Remove the bridge and release interfaces."""
        if not self._created:
            return

        logger.info("Destroying bridge '%s'", self.name)

        # Detach all interfaces
        for iface in self._interfaces:
            try:
                _run(["ip", "link", "set", iface, "nomaster"], check=False)
            except Exception:
                pass

        # Bring bridge down and delete
        try:
            _run(["ip", "link", "set", self.name, "down"], check=False)
            _run(["ip", "link", "delete", self.name], check=False)
        except Exception:
            pass

        if self._pyroute2:
            try:
                self._pyroute2.close()
            except Exception:
                pass

        self._interfaces.clear()
        self._created = False
        logger.info("Bridge '%s' destroyed", self.name)

    def get_status(self):
        """Return bridge status dict for API."""
        status = {
            "name": self.name,
            "created": self._created,
            "interfaces": list(self._interfaces),
            "stp": self.stp,
            "vlan_filtering": self.vlan_filtering,
            "group_fwd_mask": hex(self.group_fwd_mask),
        }

        # Read bridge state from sysfs
        bridge_sysfs = f"/sys/class/net/{self.name}/bridge"
        if os.path.isdir(bridge_sysfs):
            status["bridge_id"] = _sysfs_read(f"{bridge_sysfs}/bridge_id")
            status["root_id"] = _sysfs_read(f"{bridge_sysfs}/root_id")

        # Read MAC addresses
        status["mac_table"] = self._read_mac_table()

        return status

    def _read_mac_table(self):
        """Read the bridge FDB (forwarding database) entries."""
        entries = []
        try:
            result = subprocess.run(
                ["bridge", "fdb", "show", "br", self.name],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                for line in result.stdout.strip().split("\n"):
                    if line:
                        entries.append(line.strip())
        except Exception:
            pass
        return entries

    def get_interface_macs(self):
        """Return dict of interface → MAC address."""
        macs = {}
        for iface in self._interfaces:
            mac = _sysfs_read(f"/sys/class/net/{iface}/address")
            if mac:
                macs[iface] = mac
        return macs

    def check_health(self):
        """Check if bridge exists and is up."""
        if not self._created:
            return False
        operstate = _sysfs_read(f"/sys/class/net/{self.name}/operstate")
        return operstate in ("up", "unknown")
