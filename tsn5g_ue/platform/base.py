"""
Platform abstraction — the seam that lets this one app run unchanged on both an
**OpenWRT** UE and a **generic Linux** (Debian/Ubuntu) UE.

Everything that differs between the two operating systems lives behind this
interface: how a 5G IP PDU session is activated, how an interface gets an IP,
how WiFi is scanned/joined, and how the app is packaged/serviced. The device-plane
logic (AT commands, iproute2 bridges/VXLAN, ptp4l, tc taprio) is identical on both
and stays in the managers.

A concrete provider is chosen once at start-up by :func:`tsn5g_ue.platform.get_platform`
(auto-detected, or forced via the ``platform:`` config key). Adding a new feature
means adding one method here and implementing it in each provider — so the feature
lands on every supported OS at once.
"""

import logging

logger = logging.getLogger("tsn5g-ue.platform")


class Platform:
    """Base OS provider. Providers override the pieces that are OS-specific and
    inherit sensible no-ops/raises for the rest."""

    name = "base"
    #: How the app is run as a service on this OS (informational, used by installers/UI).
    service_manager = None
    #: How packages are installed on this OS (informational).
    package_manager = None

    def __init__(self, config=None):
        self.config = config or {}

    # -- identity -----------------------------------------------------------
    @classmethod
    def is_current(cls):
        """True if this provider matches the OS we are running on."""
        return False

    def summary(self):
        """Small dict surfaced at GET /api/discovery so the UI can show the base OS."""
        return {"platform": self.name, "service_manager": self.service_manager,
                "package_manager": self.package_manager}

    # -- modem preparation --------------------------------------------------
    def prepare_modem(self):
        """Release any OS modem daemon that holds the AT/QMI ports so our raw
        control works. No-op by default; overridden where relevant (Linux stops
        ModemManager)."""
        return

    # -- 5G IP PDU session (the VXLAN transport path) -----------------------
    def bring_up_ip_pdu(self, wwan, dnn, qmi_device, cid=1):
        """
        Activate an IPv4 data session on `wwan` for data network `dnn` and return
        ``{"ipv4": "<addr>|None", "method": "<how>"}``.

        The modem's ``AT+CGDCONT`` context definition is done by the caller
        (ModemManager, over serial) because it is identical on every OS. What
        differs — QMI link-layer framing, session start, DHCP and the default
        route — is what each provider implements here.
        """
        raise NotImplementedError

    def teardown_ip_pdu(self, wwan, qmi_device):
        """Tear the IP PDU session down (best-effort)."""
        raise NotImplementedError

    # -- generic interface IP config (Network view) -------------------------
    def set_ip(self, iface, method, address=None, gateway=None):
        """Configure an interface. ``method`` is ``dhcp`` | ``static`` | ``down``."""
        raise NotImplementedError

    def dhcp(self, iface, timeout=20):
        """Acquire an IPv4 lease on `iface` (blocking, best-effort)."""
        raise NotImplementedError

    # -- WiFi (Network view) ------------------------------------------------
    def wifi_scan(self):
        """Return a list of ``{ssid, signal, security, active}`` dicts."""
        return []

    def wifi_connect(self, ssid, psk=None):
        """Join a WiFi network. Return ``{ok, ssid, message}``."""
        raise NotImplementedError

    def wifi_disconnect(self, iface):
        return {"ok": True, "iface": iface}
