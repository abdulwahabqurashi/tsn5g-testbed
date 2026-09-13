"""
Configuration loading, validation, and persistence.

Wraps the YAML file (see config/tsn5g-ue.example.yaml). Provides typed accessors
for each section and a small helper to persist the "last-good" runtime state so the
service can auto-resume on reboot.
"""

import json
import logging
import os

import yaml

from . import constants as C

logger = logging.getLogger("tsn5g-ue.config")


class ConfigError(ValueError):
    """Invalid or missing configuration."""


class Config:
    """Parsed configuration, with defaults applied and light validation."""

    def __init__(self, path):
        self.path = path
        if not os.path.exists(path):
            raise ConfigError(f"config file not found: {path}")
        with open(path, "r", encoding="utf-8") as fh:
            self._raw = yaml.safe_load(fh) or {}
        self._validate()

    # -- sections -----------------------------------------------------------
    @property
    def modem(self):
        return self._raw.get("modem", {})

    @property
    def transport_mode(self):
        return self._raw.get("transport", {}).get("mode", C.TRANSPORT_VXLAN)

    @property
    def vxlan(self):
        return self._raw.get("vxlan", {})

    @property
    def bridge(self):
        return self._raw.get("bridge", {"name": C.DEFAULT_BRIDGE_NAME})

    @property
    def tsn_nics(self):
        return self._raw.get("tsn_nics", [])

    @property
    def gptp(self):
        return self._raw.get("gptp", {"enabled": True})

    @property
    def switch(self):
        return self._raw.get("switch", {})

    @property
    def api(self):
        return self._raw.get("api", {"enabled": True, "host": "0.0.0.0",
                                     "port": C.DEFAULT_API_PORT})

    @property
    def platform_name(self):
        """Base-OS provider override: 'auto' | 'linux' | 'openwrt'. Default auto-detect."""
        return self._raw.get("platform", "auto")

    @property
    def log_level(self):
        return self._raw.get("log_level", "info")

    @property
    def state_file(self):
        return self._raw.get("state_file", "/var/lib/tsn5g-ue/state.json")

    # -- derived helpers ----------------------------------------------------
    def tsn_interfaces(self):
        """List of wired TSN NIC names."""
        return [n["interface"] for n in self.tsn_nics if n.get("interface")]

    def hw_timestamp_interfaces(self):
        """Wired NICs flagged for hardware timestamping (for gPTP)."""
        return [n["interface"] for n in self.tsn_nics
                if n.get("interface") and n.get("hw_timestamping")]

    # -- validation ---------------------------------------------------------
    def _validate(self):
        mode = self.transport_mode
        if mode not in C.TRANSPORT_MODES:
            raise ConfigError(
                f"transport.mode must be one of {C.TRANSPORT_MODES}, got {mode!r}")
        # TODO: validate vlan_map entries (unique vlan/vni/dstport), switch.ports spec.

    def as_dict(self):
        """The raw config dict (for GET /api/config)."""
        return self._raw

    def update(self, patch):
        """
        Shallow-merge a patch into the config and persist to disk.
        Used by PUT /api/config and by connect() to remember the chosen transport.
        """
        for key, value in patch.items():
            if isinstance(value, dict) and isinstance(self._raw.get(key), dict):
                self._raw[key].update(value)
            else:
                self._raw[key] = value
        self._validate()
        self._save()

    def _save(self):
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            yaml.safe_dump(self._raw, fh, sort_keys=False)
        os.replace(tmp, self.path)
        logger.info("config saved to %s", self.path)


class StateStore:
    """
    Tiny JSON store for last-good runtime state (transport mode, chosen NICs,
    role) used to auto-resume after a reboot — key to the plug-and-play feel.
    """

    def __init__(self, path):
        self.path = path

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def save(self, state):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
        os.replace(tmp, self.path)
