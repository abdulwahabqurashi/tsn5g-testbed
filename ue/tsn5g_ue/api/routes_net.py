"""Interfaces and Wi-Fi. Contracts unchanged from the pre-split API."""


def register(router):

    @router.get("/api/interfaces")
    def interfaces(req):
        """Physical and virtual NICs, and which one carries the default route.

        The UI uses `management` to refuse to reconfigure the interface the
        operator is connected over without a typed confirmation.
        """
        c = req.ctx.controller
        mgmt = None
        try:
            mgmt = c.netiface.default_route_iface()
        except Exception:           # noqa: BLE001 — never fail the listing
            pass
        ifaces = c.interfaces()
        for i in ifaces:
            i["management"] = (i.get("name") == mgmt)
        return {"interfaces": ifaces, "management": mgmt}

    @router.post("/api/interfaces/config")
    def iface_config(req):
        """Set an interface to dhcp / static / down."""
        iface = req.require("iface")
        method = req.choice("method", ("dhcp", "static", "down"), default="dhcp")
        return req.ctx.controller.set_interface_ip(
            iface, method,
            address=req.opt("address"), gateway=req.opt("gateway"))

    @router.get("/api/wifi/scan")
    def wifi_scan(req):
        """Nearby networks."""
        return {"networks": req.ctx.controller.wifi_scan()}

    @router.post("/api/wifi/connect")
    def wifi_connect(req):
        """Join a network. Runs as a job — nmcli can take tens of seconds."""
        ssid = req.require("ssid")
        psk = req.opt("psk")
        return req.ctx.submit_job("net.wifi_connect", {"ssid": ssid, "psk": psk})
