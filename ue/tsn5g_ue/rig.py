"""
The two-camera rig's moving parts, as operations the UI can call.

Everything here used to be a shell command run by hand with sudo: put camera 2
in its namespace, start the encoders, bring up the VNC screen, clear stale NAT
state, install the boot units. The daemon already runs as root, so the UI can
ask it instead.

Long-lived processes are never started from the daemon itself. A child of the
daemon lives in tsn5g-ue.service's cgroup and is killed on every daemon
restart, so the encoders and the VNC screen are driven through their own
systemd units (systemd/tsn5g-*.service) and survive the daemon coming and
going. Short, stateless steps — the namespace check, the NAT flush — run
directly.
"""

import logging
import os
import re
import subprocess

from . import utils
from .net import cameras as cams
from .net import lanes

logger = logging.getLogger("tsn5g-ue.rig")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(REPO, "scripts")

# Site values. These defaults are the first rig's; configure() replaces them
# from the daemon config's `rig:` section, which install.sh renders from
# site.env — so nothing here needs editing for a new site.
NS = "cam2"
NS_NIC = "enp7s0"
VETH_ROOT = "veth-cam2"
VETH_NET = "10.200.2.0/30"
BEARER = "wwan0"
CORE_IP = "10.45.0.1"
DISPLAY = ":99"
VNC_PORT = 5900
DESKTOP_USER = "amrc"
UE_LAN_IP = ""
GBR_SOURCE_PORT = 5202
ENCODER_CONFIGS = ("camera1-protected", "camera2-besteffort")

UNIT_NETNS = "tsn5g-cam2-netns.service"
UNIT_DISPLAY = "tsn5g-vnc-display.service"
UNIT_CAMERAS = "tsn5g-cameras.service"
UNITS = (UNIT_NETNS, UNIT_DISPLAY, UNIT_CAMERAS)


class RigError(RuntimeError):
    pass


def configure(cfg):
    """Take site values from the daemon config's `rig:` section."""
    global NS, NS_NIC, VETH_ROOT, VETH_NET, BEARER, CORE_IP, DISPLAY, VNC_PORT
    global DESKTOP_USER, UE_LAN_IP, GBR_SOURCE_PORT
    cfg = cfg or {}
    NS = cfg.get("netns", NS)
    NS_NIC = cfg.get("netns_nic", NS_NIC)
    VETH_ROOT = cfg.get("veth_root", VETH_ROOT)
    VETH_NET = cfg.get("veth_net", VETH_NET)
    BEARER = cfg.get("bearer", BEARER)
    CORE_IP = cfg.get("core_ip", CORE_IP)
    DISPLAY = str(cfg.get("display", DISPLAY))
    VNC_PORT = int(cfg.get("vnc_port", VNC_PORT))
    DESKTOP_USER = cfg.get("desktop_user", DESKTOP_USER)
    UE_LAN_IP = cfg.get("ue_lan_ip", UE_LAN_IP)
    GBR_SOURCE_PORT = int(cfg.get("gbr_source_port", GBR_SOURCE_PORT))


def vnc_hint():
    host = UE_LAN_IP or "<ue-address>"
    return (f"ssh -L 5901:localhost:{VNC_PORT} {DESKTOP_USER}@{host}, "
            f"then VNC to localhost::5901")


def _ok(cmd, timeout=10):
    return utils.run(cmd, check=False, timeout=timeout).returncode == 0


def _out(cmd, timeout=10):
    return (utils.run(cmd, check=False, timeout=timeout).stdout or "").strip()


def stream(cmd, log, timeout=180, env=None):
    """Run a command, passing each output line to `log`. Raises on failure."""
    logger.info("rig: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1,
                            env={**os.environ, **(env or {})})
    lines = []
    try:
        for line in proc.stdout:
            line = line.rstrip()
            lines.append(line)
            log(line)
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise RigError(f"{os.path.basename(cmd[0])} timed out after {timeout}s") from None
    if rc != 0:
        tail = next((l for l in reversed(lines) if l.strip()), "")
        raise RigError(f"{' '.join(cmd[-2:])} failed (exit {rc}): {tail}")
    return lines


# -- units ---------------------------------------------------------------------
def _site_values():
    """site.env as a dict: the installed copy, else the checkout's."""
    vals = {}
    for path in (os.environ.get("SITE_ENV", ""), "/etc/tsn5g/site.env",
                 os.path.join(os.path.dirname(REPO), "site.env")):
        if path and os.path.isfile(path):
            with open(path) as f:
                for line in f:
                    m = re.match(r'\s*([A-Z][A-Z0-9_]*)=("([^"]*)"|\'([^\']*)\'|(\S*))', line)
                    if m:
                        vals[m.group(1)] = next(g for g in m.group(3, 4, 5) if g is not None)
            break
    return vals


def _rendered_unit(unit):
    """The unit as install-autostart.sh would write it now (template + site.env)."""
    try:
        with open(os.path.join(REPO, "templates", "systemd", unit + ".in")) as f:
            text = f.read()
    except OSError:
        return None
    vals = _site_values()
    return re.sub(r"\$\{([A-Z][A-Z0-9_]*)\}", lambda m: vals.get(m.group(1), m.group(0)), text)


def _up_to_date(path, unit):
    want = _rendered_unit(unit)
    try:
        with open(path) as f:
            return want is not None and f.read() == want
    except OSError:
        return False


def units():
    """Installed / enabled / active / up to date for each boot unit.

    up_to_date compares the installed file with the repo's: a fixed unit in
    the repo does nothing until it is reinstalled, and on 3 Oct a stale
    tsn5g-cam2-netns.service (the BindsTo bug) silently failed every encoder
    start through its dependency.
    """
    out = {}
    for u in UNITS:
        path = f"/etc/systemd/system/{u}"
        installed = os.path.exists(path)
        out[u] = {
            "installed": installed,
            "enabled": installed and _out(["systemctl", "is-enabled", u]) == "enabled",
            "active": _out(["systemctl", "is-active", u]) == "active",
            "up_to_date": installed and _up_to_date(path, u),
        }
    return out


def install_units(log, start_cameras=False):
    cmd = [os.path.join(SCRIPTS, "install-autostart.sh")]
    if start_cameras:
        cmd.append("--start-cameras")
    return stream(cmd, log, timeout=180)


def _need_unit(unit):
    if not os.path.exists(f"/etc/systemd/system/{unit}"):
        raise RigError(f"{unit} is not installed — install the boot units first")


# -- camera 2's namespace ------------------------------------------------------
def netns_status():
    exists = os.path.exists(f"/run/netns/{NS}")
    nic_inside = exists and _ok(["ip", "-n", NS, "link", "show", NS_NIC])
    leak_guard = _ok(["iptables", "-C", "FORWARD", "-i", VETH_ROOT, "!", "-o",
                      BEARER, "-j", "DROP"])
    masq = _ok(["iptables", "-t", "nat", "-C", "POSTROUTING", "-s", VETH_NET,
                "-o", BEARER, "-j", "MASQUERADE"])
    reach = nic_inside and _ok(["ip", "netns", "exec", NS, "ping", "-c1", "-W2",
                                CORE_IP], timeout=5)
    problems = []
    if not exists:
        problems.append(f"namespace {NS} does not exist — camera 2 is in the root "
                        f"namespace, where encoder 1 will claim it too")
    elif not nic_inside:
        problems.append(f"{NS} exists but {NS_NIC} is not in it")
    if exists and not masq:
        problems.append("no source translation for the namespace — camera 2 "
                        "would leave with its private address and be dropped")
    if exists and not leak_guard:
        problems.append("no leak guard — if the bearer drops, camera 2 leaks out "
                        "of the site LAN and can stay broken after it returns")
    if nic_inside and not reach:
        problems.append(f"the namespace cannot reach the core ({CORE_IP}) — is "
                        f"the bearer up?")
    return {"namespace": NS, "exists": exists, "nic": NS_NIC, "nic_inside": nic_inside,
            "masquerade": masq, "leak_guard": leak_guard, "core_reachable": reach,
            "ok": not problems, "problems": problems}


def netns_ensure(log):
    return stream([os.path.join(SCRIPTS, "camera2-netns.sh"), "ensure"], log, timeout=30)


def netns_down(log):
    return stream([os.path.join(SCRIPTS, "camera2-netns.sh"), "down"], log, timeout=30)


# -- encoders ------------------------------------------------------------------
def encoders_status():
    rows = []
    for name in ENCODER_CONFIGS:
        pid = _out(["pgrep", "-f", f"bin/pathStream1 .*{name}"]).split("\n")[0]
        up = None
        if pid:
            try:
                up = int(_out(["ps", "-o", "etimes=", "-p", pid]) or 0)
            except ValueError:
                up = None
        rows.append({"name": name, "running": bool(pid), "pid": int(pid) if pid else None,
                     "uptime_s": up,
                     "namespace": NS if name.startswith("camera2") else None})
    return {"encoders": rows, "display": DISPLAY,
            "managed_by_unit": _out(["systemctl", "is-active", UNIT_CAMERAS]) == "active"}


def press_start(log, expect=2, bearer=None):
    """Click Start in the encoder windows, then confirm video flows.

    Runs as the screen's owner (the desktop user's Xvfb), not as root.
    """
    stream(["runuser", "-u", DESKTOP_USER, "--", "env", f"PYTHONPATH={REPO}",
            f"TSN5G_DISPLAY={DISPLAY}",
            "python3", "-m", "tsn5g_ue.encoder_gui", str(expect)], log, timeout=90)
    if bearer is not None:
        import time as _t
        for _ in range(8):
            flow = _streams_flowing(bearer)
            idle = [n for n, r in flow.items() if not r]
            if flow and not idle:
                log("video flowing: " + ", ".join(f"{k} {v} datagrams/s" for k, v in flow.items()))
                return flow
            _t.sleep(1)
        raise RigError(f"pressed Start but no video from {', '.join(idle) or 'the cameras'} — "
                       f"check the encoder windows over VNC")
    return None


def check_cameras(camera_entries):
    """Refuse to (re)start the encoders in front of the wrong cameras.

    Each encoder takes "the camera in its namespace", so cabling the cameras
    the other way round puts the wrong one in the protected lane with every
    indicator still green. The serial behind each port is read back first.
    """
    bad = [c for c in cams.describe(camera_entries)["cameras"]
           if c.get("serial_ok") is False]
    if bad:
        names = ", ".join(
            f"{c['name']} on {c['interface']}: "
            + (f"found serial {c['serial']}, expected {c['expected_serial']}"
               if c.get("serial") else f"no answer ({c.get('reason') or 'serial not read'})")
            for c in bad)
        raise RigError(f"not starting the encoders — {names}")


def encoders(action, log, camera_entries=None, force=False, bearer=None):
    """start / restart / stop, through the unit so they outlive the daemon.

    start on an already-active oneshot unit does nothing, so start means
    restart: the launcher stops anything running, waits for both cameras to
    release their control channel, and launches both.
    """
    verb = {"start": "restart", "restart": "restart", "stop": "stop"}[action]
    if verb == "stop" and _out(["systemctl", "is-active", UNIT_CAMERAS]) != "active":
        # Encoders started by hand are not in the unit, so stopping the unit
        # would report success and leave them running. Stop them directly.
        stream([os.path.join(SCRIPTS, "cameras-start.sh"), "stop"], log, timeout=90)
        return encoders_status()
    _need_unit(UNIT_CAMERAS)
    if verb == "restart" and camera_entries and not force:
        check_cameras(camera_entries)
        log("both cameras answer with the expected serial")
    stream(["systemctl", verb, UNIT_CAMERAS], log, timeout=150)
    for line in _out(["journalctl", "-u", UNIT_CAMERAS, "-n", "25", "--no-pager",
                      "-o", "cat"]).splitlines():
        log(f"  {line}")
    if verb == "restart":
        # The app does not start streaming by itself; press Start for the user.
        try:
            press_start(log, bearer=bearer)
        except RigError as exc:
            log(f"WARNING: {exc}")
    return encoders_status()


# -- the VNC screen ------------------------------------------------------------
def display_status():
    sock = os.path.exists(f"/tmp/.X11-unix/X{DISPLAY.lstrip(':')}")
    vnc = _ok(["pgrep", "-f", f"x11vnc .*-display {DISPLAY}"])
    wm = _ok(["pgrep", "-x", "openbox"])
    return {"display": DISPLAY, "screen": sock, "vnc": vnc, "window_manager": wm,
            "vnc_port": VNC_PORT, "ok": sock and vnc,
            "connect": vnc_hint()}


def display_up(log):
    _need_unit(UNIT_DISPLAY)
    stream(["systemctl", "restart", UNIT_DISPLAY], log, timeout=30)
    return display_status()


# -- NAT -----------------------------------------------------------------------
def nat_flush(entries, log):
    n = lanes.flush_conntrack(entries)
    log(f"cleared {n} NAT record(s) for the camera streams")
    return {"cleared": n, "conntrack_installed": utils.have("conntrack")}


# -- which camera is protected -------------------------------------------------
def binding(camera_entries, egress_classes):
    """Physical camera -> encoder port -> lane, verified against the hardware."""
    lane_by_port = {int(e["dport"]): e.get("lane", "best_effort")
                    for e in egress_classes or [] if e.get("dport")}
    sport_by_port = {int(e["dport"]): e.get("source_port")
                     for e in egress_classes or [] if e.get("dport")}
    seen = {c["name"]: c for c in cams.describe(camera_entries)["cameras"]}
    rows = []
    for c in camera_entries or []:
        s = seen.get(c.get("name"), {})
        port = int(c.get("stream_port") or 0)
        rows.append({
            "name": c.get("name"), "interface": c.get("interface"),
            "netns": c.get("netns"), "expected_serial": str(c.get("serial") or "") or None,
            "serial": s.get("serial"), "serial_ok": s.get("serial_ok"),
            "reachable": s.get("reachable"), "stream_port": port,
            "lane": lane_by_port.get(port, "best_effort"),
            "source_port": sport_by_port.get(port),
            "gbr_bearer": sport_by_port.get(port) == GBR_SOURCE_PORT,
        })
    protected = [r["name"] for r in rows if r["lane"] == "protected"]
    return {"cameras": rows, "protected": protected,
            "ok": all(r["serial_ok"] is not False for r in rows) and len(protected) == 1}


def set_protected(name, camera_entries, bearer, config):
    """Make `name` the protected camera and every other camera best effort.

    Live: the old CLASSIFY rules are removed and the new ones installed and
    read back, so the switch takes effect on the next packet. Persisted to the
    settings overlay, so it survives a restart.
    """
    by_name = {c.get("name"): c for c in camera_entries or []}
    if name not in by_name:
        raise RigError(f"no camera called {name!r}")
    port_of = {int(c["stream_port"]): c["name"] for c in camera_entries if c.get("stream_port")}
    old = [dict(e) for e in bearer.egress_classes or []]
    new = []
    for e in old:
        cam = port_of.get(int(e.get("dport") or 0))
        if cam is not None:
            e = dict(e, lane="protected" if cam == name else "best_effort")
        new.append(e)
    lanes.remove(bearer.iface, old)
    try:
        placed = lanes.apply(bearer.iface, new)
    except lanes.LaneError:
        lanes.apply(bearer.iface, old)      # put back what worked
        raise
    bearer.egress_classes = new
    config.update({"modem": {"egress_classes": new}})
    lanes.flush_conntrack(new)
    return placed


def set_gbr(name, enabled, camera_entries, bearer, config):
    """Put one camera's stream on the GBR bearer (QFI 2), or take it off.

    Done by pinning the stream's translated source port to 5202, which is what
    the core's uplink packet filter matches. Only one stream can hold that
    port per destination, so turning it on for one camera turns it off for the
    others. Applied live (rules replaced and read back, NAT state cleared so
    the next packet re-translates) and saved to the settings overlay.
    """
    ports = {c.get("name"): int(c.get("stream_port") or 0) for c in camera_entries or []}
    if name not in ports:
        raise RigError(f"no camera called {name!r}")
    old = [dict(e) for e in bearer.egress_classes or []]
    new = []
    for e in old:
        e = dict(e)
        dport = int(e.get("dport") or 0)
        if dport in ports.values():
            if enabled and dport == ports[name]:
                e["source_port"] = GBR_SOURCE_PORT
            else:
                e.pop("source_port", None)
        new.append(e)
    lanes.remove(bearer.iface, old)
    try:
        lanes.apply(bearer.iface, new)
    except lanes.LaneError:
        lanes.apply(bearer.iface, old)
        raise
    bearer.egress_classes = new
    config.update({"modem": {"egress_classes": new}})
    lanes.flush_conntrack(new)
    return binding(camera_entries, new)


# -- everything at once --------------------------------------------------------
def status(entries=None):
    return {"netns": netns_status(), "encoders": encoders_status(),
            "display": display_status(), "units": units(),
            "conntrack_installed": utils.have("conntrack")}


# -- the guided demo setup ------------------------------------------------------
PROTECTED_CAMERA = "camera1"

STEP_TITLES = {
    "session": "5G data session works",
    "units": "Boot services installed and up to date",
    "netns": "Camera 2's network namespace is ready",
    "roles": "Camera 1 is protected and on the GBR bearer",
    "queue": "Camera lanes and auto-rate are on",
    "encoders": "Both camera encoders are running",
    "video": "Video is flowing from both cameras",
}


def _session_ok(iface="wwan0", bearer=None):
    """Does the core answer over the 5G link?

    Three pings, any reply counts: a single ping is lost often enough on this
    radio to paint a working session red (seen 3 Oct). Auto-rate's own probe,
    which pings every 200 ms, counts too.
    """
    if bearer is not None:
        ar = bearer.autorate.status()
        hist = ar.get("history") or []
        import time as _t
        if ar.get("active") and hist and hist[-1].get("rtt") is not None \
                and _t.time() - hist[-1].get("t", 0) < 3:
            return True
    return _ok(["ping", "-c3", "-i", "0.3", "-W2", "-I", iface, CORE_IP], timeout=8)


def _streams_flowing(bearer):
    """Datagrams per second for each camera stream, over half a second."""
    import time as _t
    a = {s["name"]: s.get("pkts") for s in lanes.counters(bearer.iface, bearer.egress_classes)}
    _t.sleep(0.5)
    b = {s["name"]: s.get("pkts") for s in lanes.counters(bearer.iface, bearer.egress_classes)}
    return {n: (None if a.get(n) is None or b.get(n) is None else max(0, b[n] - a[n]) * 2) for n in b}


def checklist(controller, jobs=None):
    """Each setup step: ok / todo / waiting, what is wrong, and the fix."""
    b = controller.bearer
    cams = controller.config.cameras
    steps = []

    def add(key, ok, detail, action=None, manual=None):
        steps.append({"key": key, "title": STEP_TITLES[key], "ok": bool(ok),
                      "detail": detail, "action": action, "manual": manual})

    sess = _session_ok(b.iface, bearer=b)
    add("session", sess,
        f"the core ({CORE_IP}) answers over {b.iface}" if sess else
        "the core does not answer over the 5G link — the data call is stale or down",
        None if sess else {"label": "Restart the data call",
                           "confirm": "Restarts the 5G data call. Anything streaming stops for ~20 s."})

    u = units()
    bad = [n.replace("tsn5g-", "").replace(".service", "") for n, st in u.items()
           if not (st["installed"] and st["enabled"] and st["up_to_date"])]
    add("units", not bad,
        "all three installed, enabled and current" if not bad else
        f"not installed or out of date: {', '.join(bad)}",
        None if not bad else {"label": "Install / update them", "confirm": None})

    n = netns_status()
    add("netns", n["ok"], "ready" if n["ok"] else "; ".join(n["problems"]) or "not ready",
        None if n["ok"] else {"label": "Repair", "confirm": None})

    bd = binding(cams, b.egress_classes)
    rows = {r["name"]: r for r in bd["cameras"]}
    p = rows.get(PROTECTED_CAMERA, {})
    others_ok = all(r["lane"] != "protected" and not r["gbr_bearer"]
                    for name, r in rows.items() if name != PROTECTED_CAMERA)
    roles_ok = p.get("lane") == "protected" and p.get("gbr_bearer") and others_ok
    wrong_serial = [r["name"] for r in bd["cameras"] if r.get("serial_ok") is False]
    detail = ("camera 1: protected lane, GBR bearer; camera 2: best effort" if roles_ok else
              "roles are mixed up: " + ", ".join(
                  f"{name} {r['lane'].replace('_', ' ')}{' + GBR' if r['gbr_bearer'] else ''}"
                  for name, r in rows.items()))
    if wrong_serial:
        detail += f" — serial check failed for {', '.join(wrong_serial)} (cabling?)"
    add("roles", roles_ok and not wrong_serial, detail,
        None if roles_ok else {"label": "Set the roles", "confirm": None})

    ar = b.autorate.status()
    q_ok = b.queue_policy == "limited" and ar.get("active")
    add("queue", q_ok,
        f"limited lanes, auto-rate shaping at {ar.get('rate_mbps')} Mbit/s" if q_ok else
        f"queue policy is '{b.queue_policy}', auto-rate {'on' if ar.get('active') else 'off'}"
        + (f" ({ar['reason']})" if ar.get("reason") and ar.get("reason") != "disabled" else ""),
        None if q_ok else {"label": "Turn them on", "confirm": None})

    enc = encoders_status()
    running = [e for e in enc["encoders"] if e["running"]]
    e_ok = len(running) == len(enc["encoders"]) and enc["managed_by_unit"]
    add("encoders", e_ok,
        "both running under tsn5g-cameras.service" if e_ok else
        ("running but started by hand — restart them under the boot service so they "
         "survive daemon restarts" if len(running) == len(enc["encoders"]) else
         f"{len(running)} of {len(enc['encoders'])} running"),
        None if e_ok else {"label": "Start the encoders" if not running else "Restart the encoders",
                           "confirm": "Both camera streams stop and restart (about 30 s). "
                                      "Start is pressed in each encoder window for you."})

    flow = _streams_flowing(b) if sess else {}
    idle = [name for name, r in flow.items() if not r]
    v_ok = bool(flow) and not idle
    add("video", v_ok,
        "both cameras are sending: " + ", ".join(f"{k} {v} datagrams/s" for k, v in flow.items())
        if v_ok else (f"no video from {', '.join(idle)} yet — the encoder windows are waiting "
                      f"for Start" if flow else "no data session"),
        None if v_ok else {"label": "Press Start for me", "confirm": None},
        None if v_ok else
        ["If it still shows no video after pressing, open the UE screen in VNC "
         f"({vnc_hint()}) "
         "and look at the encoder windows for an error."])

    # first failing step is the one to do now; later ones wait for it
    current = next((s["key"] for s in steps if not s["ok"]), None)
    for s in steps:
        s["state"] = "ok" if s["ok"] else ("now" if s["key"] == current else "later")

    busy = []
    if jobs is not None:
        import time as _t
        for lane, jid in jobs.active().items():
            if jid:
                j = jobs.get(jid)
                if j is not None:
                    d = j.as_dict(include_log=False)
                    busy.append({"lane": lane, "job_id": jid, "kind": d.get("kind"),
                                 "for_s": int(_t.time() - (d.get("started") or d.get("created") or _t.time()))})
    return {"steps": steps, "current": current, "busy": busy,
            "all_done": current is None}


def fix_step(key, controller, submit):
    """Do what one checklist step needs. Long work is queued as a job."""
    b = controller.bearer
    cfg = controller.config
    if key == "session":
        return submit("bearer.cycle", {"confirm": True})
    if key == "units":
        return submit("rig.units_install", {"start_cameras": False, "confirm": True})
    if key == "netns":
        return submit("rig.netns_ensure", {})
    if key == "roles":
        set_protected(PROTECTED_CAMERA, cfg.cameras, b, cfg)
        set_gbr(PROTECTED_CAMERA, True, cfg.cameras, b, cfg)
        return {"ok": True, "done": "camera 1 protected on the GBR bearer"}
    if key == "queue":
        from .net import qdisc as _q
        if b.queue_policy != _q.LIMITED:
            _q.apply(b.iface, _q.LIMITED, b.queue_limit, be_mbps=b.queue_be_mbps,
                     link_mbps=b.queue_link_mbps)
            b.queue_policy = _q.LIMITED
            cfg.update({"modem": {"egress_queue": {
                "policy": _q.LIMITED, "limit": b.queue_limit,
                "be_mbps": b.queue_be_mbps, "link_mbps": b.queue_link_mbps}}})
        ar = b.autorate.configure(enabled=True)
        cfg.update({"modem": {"autorate": {k: ar[k] for k in (
            "enabled", "min_mbps", "max_mbps", "reserve_mbps", "delay_hi_ms", "delay_lo_ms")}}})
        return {"ok": True, "done": "limited lanes with auto-rate"}
    if key == "encoders":
        return submit("rig.encoders", {"action": "restart", "confirm": True})
    if key == "video":
        return submit("rig.press_start", {})
    raise RigError(f"step {key!r} has no automatic fix")
