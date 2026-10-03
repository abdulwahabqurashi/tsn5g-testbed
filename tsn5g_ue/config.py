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

    def __init__(self, path, overlay_path=None):
        self.path = path
        if not os.path.exists(path):
            raise ConfigError(f"config file not found: {path}")
        with open(path, "r", encoding="utf-8") as fh:
            self._raw = yaml.safe_load(fh) or {}

        # UI changes live here, not in the operator's YAML.
        if overlay_path is None:
            state_file = self._raw.get("state_file") or "/var/lib/tsn5g-ue/state.json"
            overlay_path = os.path.join(os.path.dirname(state_file) or ".",
                                        "settings.json")
        self._overlay = SettingsOverlay(overlay_path)
        self._raw = self._overlay.apply_to(self._raw)
        if self._overlay.data:
            logger.info("settings overlay applied from %s (%d key(s))",
                        overlay_path, len(self._overlay.data))
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
    def tsnbridge(self):
        return self._raw.get("tsnbridge", {})

    @property
    def bridge(self):
        return self._raw.get("bridge", {"name": C.DEFAULT_BRIDGE_NAME})

    @property
    def tsn_nics(self):
        return self._raw.get("tsn_nics", [])

    @property
    def gptp(self):
        """The PTP manager's config.

        `ptp:` wins over the older `gptp:` block when present. They configure
        the same daemon in different profiles — 802.1AS versus the IEEE 1588
        default profile — and which one is correct is decided by the
        grandmaster, not by us. Keeping both means switching profile is a config
        change rather than a code change, and the older block keeps working for
        anyone still pointed at an 802.1AS bridge.
        """
        ptp = self._raw.get("ptp")
        if ptp:
            return {"profile": "ieee1588", **ptp}
        return self._raw.get("gptp", {"enabled": True})

    @property
    def cameras(self):
        """The camera-facing NICs and which camera should be behind each."""
        return self._raw.get("cameras", [])

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
        """Wired NICs flagged for hardware timestamping (for gPTP).

        Config is an override, not the only source. `tsn_nics` ships empty, so
        reading it alone left the gPTP view with nothing to offer and Start
        permanently disabled on a box whose NICs all support timestamping.
        The caller falls back to probing when this is empty.
        """
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
        """The effective config: the YAML with the overlay merged over it."""
        return self._raw

    def sources(self):
        """Which top-level keys came from the overlay rather than the file.

        Surfaced at GET /api/config so the UI can show what has been changed
        from the operator's file without reading both.
        """
        return {k: ("overlay" if k in self._overlay.data else "file")
                for k in self._raw}

    def update(self, patch):
        """Merge a patch and persist it — to the overlay, never the YAML.

        The YAML is the operator's file: hand-maintained, commented, and the
        thing they read to understand the deployment. yaml.safe_dump destroys
        every comment and reflows the key order, so a single UI toggle used to
        silently rewrite it. config/tsn5g-ue.di1200.yaml is visibly a
        machine-rewritten copy of the example for exactly this reason.

        Changes go to a JSON overlay in the state directory instead, layered
        over the file at load. The file stays exactly as written.
        """
        for key, value in patch.items():
            if isinstance(value, dict) and isinstance(self._raw.get(key), dict):
                self._raw[key].update(value)
            else:
                self._raw[key] = value
        self._validate()
        self._overlay.merge(patch)
        logger.info("config overlay updated (%s); %s is untouched",
                    ", ".join(patch), self.path)


class SettingsOverlay:
    """UI-mutable settings, layered over the operator's YAML.

    Kept separate so the YAML can stay hand-maintained and commented. Only
    keys actually changed appear here, which also makes it obvious at a glance
    what has been altered from the shipped configuration.
    """

    def __init__(self, path):
        self.path = path
        self.data = self._load()

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
        except OSError as exc:
            logger.warning("could not read the settings overlay: %s", exc)
            return {}

    def merge(self, patch):
        for key, value in patch.items():
            if isinstance(value, dict) and isinstance(self.data.get(key), dict):
                self.data[key].update(value)
            else:
                self.data[key] = value
        self._save()

    def clear(self):
        self.data = {}
        try:
            os.unlink(self.path)
        except OSError:
            pass

    def apply_to(self, raw):
        """Merge the overlay over a freshly loaded config."""
        for key, value in self.data.items():
            if isinstance(value, dict) and isinstance(raw.get(key), dict):
                raw[key].update(value)
            else:
                raw[key] = value
        return raw

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            tmp = f"{self.path}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, indent=2, sort_keys=True)
            os.replace(tmp, self.path)
        except OSError as exc:
            logger.warning("could not persist the settings overlay: %s", exc)


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
