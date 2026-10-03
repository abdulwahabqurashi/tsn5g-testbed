"""YAML configuration loader and validator for DS-TT."""

import logging
import yaml

logger = logging.getLogger("ds-tt.config")

# Default configuration values
DEFAULTS = {
    "modem": {
        "device": "/dev/ttyUSB2",
        "wwan_interface": "wwan0",
        "dnn": "tsn",
        "cid": 1,
        "ethernet_mode": True,
        "baud_rate": 115200,
    },
    "tsn_nics": [],
    "bridge": {
        "name": "ds-tt-br0",
        "stp": False,
        "vlan_filtering": True,
        "group_fwd_mask": 0x4000,
        "ageing_time": 0,
    },
    "gptp": {
        "enabled": True,
        "time_domain_number": 0,
        "transport_specific": 1,
        "priority1": 255,
    },
    "api": {
        "enabled": True,
        "host": "0.0.0.0",
        "port": 8080,
    },
    "log_level": "info",
}


class DsTtConfig:
    """Loads and validates DS-TT configuration from a YAML file."""

    def __init__(self, path):
        self.path = path
        self._raw = {}
        self.modem = {}
        self.tsn_nics = []
        self.bridge = {}
        self.gptp = {}
        self.api = {}
        self.log_level = "info"
        self._load()

    def _load(self):
        with open(self.path, "r") as f:
            self._raw = yaml.safe_load(f) or {}

        self.modem = {**DEFAULTS["modem"], **self._raw.get("modem", {})}
        self.tsn_nics = self._raw.get("tsn_nics", DEFAULTS["tsn_nics"])
        self.bridge = {**DEFAULTS["bridge"], **self._raw.get("bridge", {})}
        self.gptp = {**DEFAULTS["gptp"], **self._raw.get("gptp", {})}
        self.api = {**DEFAULTS["api"], **self._raw.get("api", {})}
        self.log_level = self._raw.get("log_level", DEFAULTS["log_level"])

        self._validate()

    def _validate(self):
        if not self.modem.get("device"):
            raise ValueError("modem.device is required")
        if not self.modem.get("wwan_interface"):
            raise ValueError("modem.wwan_interface is required")
        if not self.tsn_nics:
            logger.warning("No TSN NICs configured — bridge will only have modem interface")
        for i, nic in enumerate(self.tsn_nics):
            if not nic.get("interface"):
                raise ValueError(f"tsn_nics[{i}].interface is required")
        if not self.bridge.get("name"):
            raise ValueError("bridge.name is required")

    def get_tsn_interfaces(self):
        """Return list of TSN NIC interface names."""
        return [nic["interface"] for nic in self.tsn_nics]

    def get_hw_timestamp_interfaces(self):
        """Return list of TSN NIC interfaces with hw_timestamping enabled."""
        return [
            nic["interface"] for nic in self.tsn_nics
            if nic.get("hw_timestamping", False)
        ]

    def __repr__(self):
        return (
            f"DsTtConfig(modem={self.modem['device']}, "
            f"bridge={self.bridge['name']}, "
            f"nics={self.get_tsn_interfaces()})"
        )
