"""
LLDP forwarding configuration for DS-TT.

Enables LLDP frame forwarding through the Linux bridge by setting
the group_fwd_mask bit. This mirrors the LLDP relay behavior in
src/upf/nwtt.c.

The kernel bridge normally drops LLDP frames (IEEE 802.1D reserved
multicast 01:80:c2:00:00:0e). Setting bit 14 of group_fwd_mask
(0x4000) allows them through.
"""

import logging
import os

from .constants import LLDP_GROUP_FWD_MASK

logger = logging.getLogger("ds-tt.lldp")


def configure_lldp_forwarding(bridge_name):
    """
    Enable LLDP forwarding on the bridge by setting group_fwd_mask.

    The bridge should already be created before calling this.
    """
    sysfs_path = f"/sys/class/net/{bridge_name}/bridge/group_fwd_mask"

    if not os.path.exists(sysfs_path):
        logger.error("Bridge '%s' group_fwd_mask sysfs not found", bridge_name)
        return False

    try:
        # Read current value
        with open(sysfs_path, "r") as f:
            current = int(f.read().strip(), 0)

        # Set LLDP bit
        new_value = current | LLDP_GROUP_FWD_MASK

        with open(sysfs_path, "w") as f:
            f.write(str(new_value))

        logger.info("LLDP forwarding enabled on '%s' (group_fwd_mask=0x%04x)",
                     bridge_name, new_value)
        return True

    except (OSError, PermissionError, ValueError) as e:
        logger.error("Failed to configure LLDP forwarding: %s", e)
        return False


def check_lldp_forwarding(bridge_name):
    """Check if LLDP forwarding is enabled on the bridge."""
    sysfs_path = f"/sys/class/net/{bridge_name}/bridge/group_fwd_mask"
    try:
        with open(sysfs_path, "r") as f:
            current = int(f.read().strip(), 0)
        return bool(current & LLDP_GROUP_FWD_MASK)
    except (OSError, FileNotFoundError, ValueError):
        return False
