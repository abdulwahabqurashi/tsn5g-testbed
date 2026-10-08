"""
The cameras' video path: straight over the bearer, or as tagged Ethernet in
VXLAN tunnels (the DS-TT side of the 5G system acting as one TSN bridge).

  direct   the encoders send UDP to the core's bearer address; the lane rules
           in net/lanes.py classify by destination port. What the demo has
           always used.

  vxlan    one tunnel per camera. The encoder sends to the video server's
           address on that camera's VLAN; the frame leaves through the
           tunnel's veth (where a Qbv gate can sit), gets its 802.1Q tag and
           PCP, and is wrapped in VXLAN to the core's endpoint (NW-TT):

             encoder ─► tb-<n>a ─veth─ tb-<n>b ┐
                                               tb-<n>br ─► tb-<n>tv (VLAN, PCP) ─► tb-<n>vx (VXLAN) ─► wwan0
             (10.70.0.2)                       ┘

           What protects camera 1 is kept, moved to the outer header:
             - its tunnel's outer UDP source port is fixed at the GBR port
               (5202), so the core's GBR rule still puts it on QFI 2;
             - the outer packets are classified into the same HTB lanes by
               that source port, so auto-rate and priority work unchanged;
             - each tunnel's outer packets are counted under the camera's
               name, so the Cameras page and the tests read the same numbers.

The tunnel devices are the TSN bridge's Datapath (tsnbridge/datapath.py).
Switching rewrites the two encoder configs and restarts the encoders; the
chosen path is saved and comes back after a reboot or a new data call.
"""

import json
import logging
import os

from .. import rig, utils
from ..tsnbridge.datapath import Datapath, DatapathError
from ..tsnbridge.netdev import NetdevError
from . import lanes

logger = logging.getLogger("tsn5g-ue.net.campath")

DIRECT, VXLAN = "direct", "vxlan"
DEFAULTS = {
    "mode": DIRECT,
    "remote": None,            # the core's VTEP; defaults to the bearer core address
    "dstport": 4789,
    "tunnels": [
        {"camera": "camera1", "name": "cam1", "vlan": 70, "vni": 70, "pcp": 4, "dscp": 34,
         "srcport": 5202, "lane": "protected",
         "ue_ip": "10.70.0.2/24", "server_ip": "10.70.0.1"},
        {"camera": "camera2", "name": "cam2", "vlan": 80, "vni": 80, "pcp": 0, "dscp": 0,
         "srcport": 5212, "lane": "best_effort",
         "ue_ip": "10.80.0.2/24", "server_ip": "10.80.0.1"},
    ],
}


class CamPathError(RuntimeError):
    pass


def _ipt(table, op, chain, *spec):
    return utils.run(["iptables", "-t", table, op, chain, *spec], check=False, timeout=10)


def _ensure(table, chain, spec, insert=False):
    if _ipt(table, "-C", chain, *spec).returncode != 0:
        proc = _ipt(table, "-I" if insert else "-A", chain, *spec)
        if proc.returncode != 0:
            raise CamPathError(f"iptables -t {table} {chain} {' '.join(spec)}: {(proc.stderr or '').strip()}")


def _drop(table, chain, spec):
    while _ipt(table, "-D", chain, *spec).returncode == 0:
        pass


class CameraPath:
    def __init__(self, cfg, bearer, cameras, config=None, before_build=None):
        self.cfg = {**DEFAULTS, **(cfg or {})}
        self.bearer = bearer
        self.cameras = {c["name"]: c for c in (cameras or [])}
        self.config = config            # to save the chosen mode
        # Stops the legacy VXLAN overlay (transport/), which holds VNI 70/80 on
        # the same port with nothing at the far end.
        self.before_build = before_build
        self.state = {"built": False, "error": None, "encoders_pointed": None}

    # -- the pieces -------------------------------------------------------------
    def _remote(self):
        return self.cfg.get("remote") or rig.CORE_IP

    def _datapath(self, t):
        st = self.bearer.status()
        spec = {"name": t["name"], "vlan": t["vlan"], "vni": t.get("vni", t["vlan"]),
                # A fixed PCP per VLAN, not the identity map: skb->priority does
                # not survive the veth hop to the bridge (measured 8 Oct: camera 1
                # tagged PCP 0 on the core), and each tunnel carries one camera.
                "dstport": self.cfg["dstport"], "identity_map": False,
                "pcp": int(t.get("pcp", 0)), "dscp": t.get("dscp"),
                "srcport": t.get("srcport"), "gate_ip": t["ue_ip"]}
        return Datapath(spec, self.bearer.iface, st.get("ipv4"), self._remote(),
                        bearer_mtu=int(st.get("mtu") or 1400))

    def _outer(self, t):
        """Match a tunnel's outer packets on the bearer."""
        return ["-o", self.bearer.iface, "-p", "udp", "--sport", str(t["srcport"]),
                "--dport", str(self.cfg["dstport"])]

    def _rules(self, t, dp):
        """(table, chain, spec, insert) for everything one tunnel needs."""
        cam = self.cameras.get(t["camera"], {})
        rules = [
            # the encoder's socket is bound to its camera-side address: give
            # the frame the tunnel subnet's source so the far end can answer
            ("nat", "POSTROUTING", ["-o", dp.dev_veth_a, "-j", "MASQUERADE"], False),
            # inner priority -> the VLAN's PCP (identity egress map) and the gate
            #   (everything on the tunnel is this camera's, so no port match)
            ("mangle", "POSTROUTING", ["-o", dp.dev_veth_a,
                                       "-j", "CLASSIFY", "--set-class", f"0:{int(t.get('pcp', 0))}"], False),
            # outer packets into the camera's lane; counted under its name
            ("mangle", "POSTROUTING", self._outer(t) + ["-m", "comment", "--comment",
                                                         f"{lanes.COUNT_TAG}{t['camera']}"], False),
        ]
        if t.get("lane") == "protected":
            rules.append(("mangle", "POSTROUTING", self._outer(t) + [
                "-j", "CLASSIFY", "--set-class", lanes.LANES["protected"]], False))
        if cam.get("netns"):
            # camera 2's encoder lives in a namespace whose leak guard drops
            # anything not leaving on the bearer; let its tunnel through
            rules.append(("filter", "FORWARD", ["-i", rig.VETH_ROOT, "-o", dp.dev_veth_a, "-j", "ACCEPT"], True))
            rules.append(("filter", "FORWARD", ["-i", dp.dev_veth_a, "-o", rig.VETH_ROOT, "-j", "ACCEPT"], True))
        return rules

    # -- encoders ---------------------------------------------------------------
    def _encoder_files(self):
        d = rig.ENCODER_DIR
        return {"camera1": os.path.join(d, f"{rig.ENCODER_CONFIGS[0]}.json"),
                "camera2": os.path.join(d, f"{rig.ENCODER_CONFIGS[1]}.json")}

    def _point_encoders(self, mode):
        """Rewrite each encoder's destination for `mode`. True if anything changed."""
        changed = False
        targets = {t["camera"]: t["server_ip"] for t in self.cfg["tunnels"]}
        for cam, path in self._encoder_files().items():
            try:
                with open(path) as f:
                    j = json.load(f)
            except (OSError, ValueError) as exc:
                raise CamPathError(f"cannot read the encoder config {path}: {exc}") from None
            want = targets.get(cam) if mode == VXLAN else rig.CORE_IP
            if want and j.get("ipaddress") != want:
                j["ipaddress"] = want
                tmp = path + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(j, f, indent=4)
                os.replace(tmp, path)
                changed = True
                logger.info("encoder %s now sends to %s", cam, want)
        self.state["encoders_pointed"] = mode
        return changed

    # -- lifecycle --------------------------------------------------------------
    def build(self, log=logger.info):
        if not self.bearer.status().get("ipv4"):
            raise CamPathError("the 5G link has no address: connect it first")
        if self.before_build:
            self.before_build(log)
        for t in self.cfg["tunnels"]:
            dp = self._datapath(t)
            try:
                dp.build()
            except (DatapathError, NetdevError) as exc:
                raise CamPathError(f"{t['camera']} tunnel: {exc}") from None
            for table, chain, spec, insert in self._rules(t, dp):
                _ensure(table, chain, spec, insert)
            log(f"{t['camera']}: VLAN {t['vlan']} PCP {t.get('pcp', 0)} in VXLAN {t.get('vni', t['vlan'])} "
                f"to {self._remote()}:{self.cfg['dstport']}, outer source port {t['srcport']}, "
                f"{t.get('lane')} lane, inner MTU {dp.mtu}")
        self.state.update(built=True, error=None)

    def teardown(self, log=logger.info):
        for t in self.cfg["tunnels"]:
            dp = self._datapath(t)
            for table, chain, spec, _ in self._rules(t, dp):
                _drop(table, chain, spec)
            gone = dp.teardown(quiet=True)
            if gone:
                log(f"{t['camera']}: removed {', '.join(gone)}")
        self.state["built"] = False

    def set_mode(self, mode, log=logger.info):
        """Switch the video path. Returns True if the encoders must restart."""
        if mode not in (DIRECT, VXLAN):
            raise CamPathError(f"unknown video path {mode!r}")
        if mode == VXLAN:
            self.build(log)
        else:
            self.teardown(log)
        changed = self._point_encoders(mode)
        self.cfg["mode"] = mode
        if self.config is not None:
            self.config.update({"camera_path": {"mode": mode}})
        return changed

    def reapply(self):
        """After a new data call (new address) or at start: rebuild if VXLAN is chosen."""
        if self.cfg["mode"] != VXLAN:
            return
        try:
            self.build()
            if self._point_encoders(VXLAN):
                self.state["error"] = "encoders were re-pointed: restart them to use the tunnels"
        except CamPathError as exc:
            self.state.update(built=False, error=str(exc))
            logger.warning("camera tunnels not rebuilt: %s", exc)

    # -- read model -------------------------------------------------------------
    def status(self):
        out = []
        for t in self.cfg["tunnels"]:
            dp = self._datapath(t)
            st = dp.status() if self.bearer.status().get("ipv4") else {"up": False, "devices": {}}
            neigh = utils.run(["ip", "neigh", "show", t["server_ip"], "dev", dp.dev_veth_a],
                              check=False, timeout=5).stdout.strip()
            out.append({"camera": t["camera"], "vlan": t["vlan"], "vni": t.get("vni", t["vlan"]),
                        "pcp": t.get("pcp", 0), "dscp": t.get("dscp"), "srcport": t["srcport"],
                        "lane": t.get("lane"), "ue_ip": t["ue_ip"], "server_ip": t["server_ip"],
                        "up": st.get("up", False), "mtu": st.get("mtu"),
                        # the far end answering ARP across the tunnel is the proof
                        # that the core's endpoint (NW-TT) exists and is bridged
                        "server_reachable": any(s in neigh for s in ("REACHABLE", "STALE", "DELAY"))})
        return {"mode": self.cfg["mode"], "remote": self._remote(), "dstport": self.cfg["dstport"],
                "tunnels": out, **self.state}
