"""
Platform selection.

``get_platform(config)`` returns the one provider that matches the OS we are
running on. Selection order:

  1. explicit override — the ``platform:`` config key (``linux`` | ``openwrt``)
  2. auto-detect      — OpenWRT first (it is also Linux), then generic Linux
  3. fallback         — the base no-op provider (non-Linux dev boxes)

The chosen provider is created once and shared by the managers that need OS-specific
behaviour (ModemManager, NetIfaceManager).
"""

import logging

from .base import Platform
from .linux import LinuxPlatform
from .openwrt import OpenWrtPlatform

logger = logging.getLogger("tsn5g-ue.platform")

# OpenWRT is checked before generic Linux because it is a Linux too.
_PROVIDERS = {
    "openwrt": OpenWrtPlatform,
    "linux": LinuxPlatform,
}
_DETECT_ORDER = (OpenWrtPlatform, LinuxPlatform)

_cached = None


def get_platform(config=None, force=None):
    """Return the active platform provider (cached after first call).

    Args:
        config: the app Config (read for a ``platform:`` override) or None.
        force: provider name to force ('linux'|'openwrt'), bypassing detection.
    """
    global _cached
    if _cached is not None and force is None:
        return _cached

    name = force
    if name is None and config is not None:
        try:
            name = config.platform_name
        except AttributeError:
            name = "auto"

    provider = None
    if name and name != "auto":
        cls = _PROVIDERS.get(name)
        if cls is None:
            logger.warning("unknown platform override %r; auto-detecting", name)
        else:
            provider = cls(config)
    if provider is None:
        for cls in _DETECT_ORDER:
            if cls.is_current():
                provider = cls(config)
                break
    if provider is None:
        provider = Platform(config)  # dev fallback (non-Linux)

    logger.info("platform: %s (service=%s pkg=%s)",
                provider.name, provider.service_manager, provider.package_manager)
    _cached = provider
    return provider


def reset_cache():
    """Testing hook — forget the cached provider."""
    global _cached
    _cached = None


__all__ = ["Platform", "LinuxPlatform", "OpenWrtPlatform", "get_platform", "reset_cache"]
