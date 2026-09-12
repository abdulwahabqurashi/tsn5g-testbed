"""
Common transport interface. A transport is responsible for getting L2 frames
from the local wired TSN NIC(s) across the 5G user plane to the NW-TT at the core.
"""

import abc
import logging

logger = logging.getLogger("tsn5g-ue.transport")


class Transport(abc.ABC):
    """Base class for EthernetTransport and VxlanTransport."""

    #: human-readable mode name, set by subclasses
    mode = None

    def __init__(self, config, modem):
        self.config = config
        self.modem = modem
        self.wired_nics = []
        self.role = None

    @abc.abstractmethod
    def start(self, wired_nics, role=None):
        """Build the data path (bridge / overlay) and attach the wired NIC(s)."""

    @abc.abstractmethod
    def stop(self):
        """Tear the data path down cleanly."""

    @abc.abstractmethod
    def enable_lldp_forwarding(self):
        """Ensure LLDP frames traverse the bridge for TSN topology discovery."""

    @abc.abstractmethod
    def get_status(self):
        """Return a JSON-serialisable status dict for the UI."""

    def check_health(self):
        """Default health: overridden by subclasses that know their own liveness."""
        return True
