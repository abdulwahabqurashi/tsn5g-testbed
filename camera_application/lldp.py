"""
LLDP forwarding helper.

TSN topology discovery requires the bridge to forward LLDP frames
(01:80:c2:00:00:0e), which are normally consumed by the bridge. This is done by
setting group_fwd_mask bit 14 (0x4000) on the bridge — see the bridge config.

Ported from Open5GS-TSN-master/tools/ds-tt/ds_tt/lldp.py.
"""

import logging

from . import constants as C

logger = logging.getLogger("tsn5g-ue.lldp")


def configure_lldp_forwarding(bridge_name, group_fwd_mask=C.DEFAULT_LLDP_GROUP_FWD_MASK):
    """
    Enable LLDP frame forwarding on the given bridge.
    Writes /sys/class/net/<bridge>/bridge/group_fwd_mask (or via ip link).
    """
    # TODO(port lldp.py): echo <mask> > /sys/class/net/<bridge>/bridge/group_fwd_mask
    logger.info("LLDP forwarding on %s -> group_fwd_mask=0x%04x (stub)",
                bridge_name, group_fwd_mask)
