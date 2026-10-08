"""The two-camera rig: camera 2's namespace, the encoders, the VNC screen, NAT.

Every action here replaces a command that used to be typed with sudo. Anything
that interrupts a stream is a job with confirm=True, so the UI has to ask.
"""

from .. import rig
from .router import ApiError


def register(router):
    _register_campath(router)

    @router.get("/api/rig")
    def rig_status(req):
        """Namespace, encoders, VNC screen and boot units, with problems named."""
        return rig.status()

    @router.get("/api/rig/checklist")
    def rig_checklist(req):
        """The demo setup as ordered steps: state, what is wrong, the fix,
        and any job still running (so the UI can say so instead of failing)."""
        return rig.checklist(req.ctx.controller, req.ctx.jobs)

    @router.post("/api/rig/fix/{step}")
    def rig_fix(req):
        """Do what one checklist step needs. Long work comes back as a job."""
        try:
            return rig.fix_step(req.params["step"], req.ctx.controller, req.ctx.submit_job)
        except rig.RigError as exc:
            raise ApiError(400, str(exc)) from None

    @router.post("/api/rig/netns/ensure")
    def netns_ensure(req):
        """Create camera 2's namespace if missing; re-assert its rules either way.

        Safe on a working rig: an existing namespace is left alone and only its
        forwarding, NAT and leak-guard rules are checked.
        """
        return req.ctx.submit_job("rig.netns_ensure", {})

    @router.post("/api/rig/netns/down")
    def netns_down(req):
        """Remove the namespace. Stops camera 2's stream."""
        return req.ctx.submit_job("rig.netns_down", {"confirm": req.confirmed})

    @router.post("/api/rig/encoders/{action}")
    def encoders(req):
        """start | restart | stop both encoders, via tsn5g-cameras.service."""
        action = req.params["action"]
        if action not in ("start", "restart", "stop"):
            raise ApiError(404, f"unknown encoder action '{action}'")
        return req.ctx.submit_job("rig.encoders", {"action": action,
                                                   "confirm": req.confirmed,
                                                   "force": bool(req.body.get("force"))})

    @router.get("/api/rig/binding")
    def binding_get(req):
        """Which physical camera (by serial) feeds which lane."""
        c = req.ctx.controller
        return rig.binding(c.config.cameras, c.bearer.egress_classes)

    @router.put("/api/rig/binding")
    def binding_set(req):
        """Make one camera the protected one; the others become best effort.

        Applied live to the lane rules and saved. The encoders are untouched:
        the lane follows the stream's port, so no stream is interrupted.
        """
        c = req.ctx.controller
        name = req.require("protected")
        try:
            rig.set_protected(name, c.config.cameras, c.bearer, c.config)
        except (rig.RigError, ValueError) as exc:
            raise ApiError(400, str(exc)) from None
        except Exception as exc:                       # noqa: BLE001
            raise ApiError(409, f"{exc} — the previous lanes are unchanged") from None
        return rig.binding(c.config.cameras, c.bearer.egress_classes)

    @router.put("/api/rig/gbr")
    def gbr_set(req):
        """Put a camera's stream on the GBR bearer (source port 5202), or off.

        Body: {"camera": "camera1", "enabled": true}. Live and saved. Only one
        camera can hold the GBR source port at a time.
        """
        c = req.ctx.controller
        name = req.require("camera")
        try:
            return rig.set_gbr(name, bool(req.body.get("enabled", True)),
                               c.config.cameras, c.bearer, c.config)
        except (rig.RigError, ValueError) as exc:
            raise ApiError(400, str(exc)) from None
        except Exception as exc:                       # noqa: BLE001
            raise ApiError(409, f"{exc} — the previous rules are unchanged") from None

    @router.post("/api/rig/display/up")
    def display_up(req):
        """(Re)start the virtual screen and VNC. Closes anything on the screen."""
        return req.ctx.submit_job("rig.display_up", {"confirm": req.confirmed})

    @router.post("/api/rig/nat/flush")
    def nat_flush(req):
        """Forget the camera streams' NAT state, so they re-translate.

        The cure for a stream that leaves with its private source address
        after the bearer dropped and came back. Harmless otherwise.
        """
        return req.ctx.submit_job("rig.nat_flush", {})

    @router.post("/api/rig/units/install")
    def units_install(req):
        """Install and enable the boot units. start_cameras hands the running
        encoders to the unit, which restarts them."""
        return req.ctx.submit_job("rig.units_install", {
            "start_cameras": bool(req.body.get("start_cameras")),
            "confirm": req.confirmed or not req.body.get("start_cameras")})


def _register_campath(router):

    @router.get("/api/campath")
    def campath_status(req):
        """The cameras' video path (direct or VXLAN) and each tunnel's state."""
        return req.ctx.controller.campath.status()

    @router.post("/api/campath")
    def campath_set(req):
        """Switch the video path: {"mode": "direct" | "vxlan", "confirm": true}."""
        mode = req.require("mode")
        if mode not in ("direct", "vxlan"):
            raise ApiError(400, f"mode must be direct or vxlan, not {mode!r}")
        return req.ctx.submit_job("campath.set", {"mode": mode, "confirm": req.confirmed})
