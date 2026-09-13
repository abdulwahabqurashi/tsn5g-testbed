"""Registration: preferences, operator selection, cell lock, survey, repair."""

from .router import ApiError


def _radio(req):
    r = getattr(req.ctx.controller, "radio", None)
    if r is None:
        raise ApiError(503, "radio control not available")
    return r


def register(router):

    @router.get("/api/radio")
    def state(req):
        """Registration, serving cell and lock, in one read."""
        return _radio(req).state()

    # -- preferences --------------------------------------------------------
    @router.get("/api/radio/prefs")
    def get_prefs(req):
        """What the UE is allowed to camp on."""
        return _radio(req).prefs()

    @router.put("/api/radio/prefs")
    def set_prefs(req):
        """Set mode preference and band mask.

        nr5g_disable_mode is validated to 0. Verified on this firmware
        2026-09-08: 1 and 2 prevent SA camping, and 1 also makes nr5g_band
        writes fail silently. Several reference scripts set 1; they are wrong.
        """
        dm = req.body.get("nr5g_disable_mode")
        if dm is not None and str(dm) != "0":
            raise ApiError(
                400,
                "nr5g_disable_mode must be 0 on this firmware "
                "(RM520NGLAAR03A01M4G). Values 1 and 2 prevent the modem from "
                "camping on SA, and 1 additionally causes nr5g_band writes to "
                "be silently rejected.")
        return req.ctx.submit_job("radio.prefs", {
            "mode_pref": req.opt("mode_pref"),
            "nr5g_band": req.opt("nr5g_band"),
            "nr5g_disable_mode": dm,
        })

    # -- operator -----------------------------------------------------------
    @router.post("/api/radio/plmn/select")
    def select_plmn(req):
        """Manual or automatic operator selection."""
        mode = req.choice("mode", ("manual", "automatic"), default="manual")
        if mode == "manual" and not req.opt("plmn"):
            raise ApiError(400, "missing field: 'plmn'")
        return req.ctx.submit_job("radio.plmn", {
            "mode": mode, "plmn": req.opt("plmn"),
            "act": req.integer("act", default=11, lo=0, hi=15),
            "confirm": req.confirmed,
        })

    @router.get("/api/radio/plmn/forbidden")
    def forbidden(req):
        """The SIM's forbidden-PLMN list. It survives reboots, which is why a
        PLMN that failed once keeps being refused."""
        return _radio(req).forbidden_plmns()

    @router.delete("/api/radio/plmn/forbidden/{plmn}")
    def clear_forbidden(req):
        """Remove one PLMN from the forbidden list."""
        return req.ctx.submit_job("radio.clear_forbidden",
                                  {"plmn": req.params["plmn"]})

    # -- cell lock ----------------------------------------------------------
    @router.get("/api/radio/lock")
    def get_lock(req):
        return _radio(req).cell_lock()

    @router.put("/api/radio/lock")
    def set_lock(req):
        """Pin the UE to one cell. Tries the four known argument orders."""
        return req.ctx.submit_job("radio.lock", {
            "arfcn": req.integer("arfcn", required=True, lo=1, hi=3279165),
            "scs": req.integer("scs", default=1, lo=0, hi=4),
            "band": req.integer("band", default=78, lo=1, hi=110),
            "pci": req.integer("pci", default=1, lo=0, hi=1007),
            "confirm": req.confirmed,
        })

    @router.delete("/api/radio/lock")
    def clear_lock(req):
        return req.ctx.submit_job("radio.unlock", {})

    # -- survey and recovery -------------------------------------------------
    @router.post("/api/radio/scan")
    def scan(req):
        """Network survey. Two to four minutes; cancellable."""
        return req.ctx.submit_job("radio.scan", {
            "kind": req.choice("kind", ("nr", "operators", "both"),
                               default="both")})

    @router.post("/api/radio/camp/wait")
    def camp(req):
        """Wait for the UE to camp on SA."""
        return req.ctx.submit_job("radio.camp", {
            "timeout_s": req.integer("timeout_s", default=120, lo=10, hi=600)})

    @router.post("/api/radio/diagnose")
    def diagnose(req):
        """Is any RF reaching the modem, and is anything obviously misconfigured?"""
        return req.ctx.submit_job("radio.diagnose", {})

    @router.post("/api/radio/band/repair")
    def repair(req):
        """Put the band mask back when it is stuck at zero."""
        return req.ctx.submit_job("radio.repair_bands", {
            "band": req.opt("band", "78"), "confirm": req.confirmed})
