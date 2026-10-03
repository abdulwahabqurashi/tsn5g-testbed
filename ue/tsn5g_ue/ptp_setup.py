"""
Guided PTP setup: which NICs can do it, what software it needs, and a start
that checks each precondition in turn and says which one failed.

The Time Sync page used to assume all of this had been done on the command
line: linuxptp installed, the right NIC picked, the VLAN known. Its interface
list offered any NIC that reported timestamping, defaulted to whichever
enumerated first, and a Start that failed said little more than "not locked".

What "can do PTP" means here: a physical NIC with its own PTP hardware clock
(PHC) and hardware transmit *and* receive timestamps. Software timestamping
works, but is microseconds out where this rig needs nanoseconds, so those NICs
are listed separately rather than offered.
"""

import glob
import logging
import os
import re
import subprocess
import time

from . import utils

logger = logging.getLogger("tsn5g-ue.ptp_setup")

#: binary -> Debian package that provides it
DEPENDENCIES = {"ptp4l": "linuxptp", "phc2sys": "linuxptp", "pmc": "linuxptp",
                "ethtool": "ethtool"}

_SKIP_PREFIXES = ("lo", "veth", "docker", "br-", "virbr", "wwan", "tun", "tap",
                  "vxlan", "ds-tt")


class SetupError(RuntimeError):
    """A setup step failed; the message says which and what to try."""


# -- dependencies --------------------------------------------------------------
def dependencies():
    have = {b: bool(utils.have(b) or os.path.exists(f"/usr/sbin/{b}"))
            for b in DEPENDENCIES}
    missing_pkgs = sorted({DEPENDENCIES[b] for b, ok in have.items() if not ok})
    return {"binaries": have, "missing_packages": missing_pkgs,
            "ok": not missing_pkgs}


def install_dependencies(log):
    """apt-get install whatever is missing. Needs a route to the archive."""
    missing = dependencies()["missing_packages"]
    if not missing:
        log("all PTP software already installed")
        return []
    log(f"installing: {' '.join(missing)}")
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    for cmd in (["apt-get", "update", "-q"],
                ["apt-get", "install", "-y", "-q", *missing]):
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1, env=env)
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                log(f"  {line}")
        if proc.wait(timeout=600) != 0:
            raise SetupError(f"{' '.join(cmd[:2])} failed — is there a route to the "
                             f"package archive? (the UE's internet goes via enp3s0)")
    still = dependencies()["missing_packages"]
    if still:
        raise SetupError(f"still missing after install: {', '.join(still)}")
    return missing


# -- NICs ----------------------------------------------------------------------
def _read(path, default=None):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return default


def _timestamping(iface):
    out = utils.run(["ethtool", "-T", iface], check=False, timeout=10).stdout or ""
    m = re.search(r"(?:PTP Hardware Clock|Hardware timestamp provider index):\s*(\S+)", out)
    phc = m.group(1) if m else None
    phc = int(phc) if phc and phc.isdigit() else None
    return {"phc": phc, "hw_tx": "hardware-transmit" in out,
            "hw_rx": "hardware-receive" in out,
            "hw_raw_clock": "hardware-raw-clock" in out,
            "sw_only": phc is None and "software-transmit" in out}


def _driver(iface):
    out = utils.run(["ethtool", "-i", iface], check=False, timeout=10).stdout or ""
    info = dict(l.split(":", 1) for l in out.splitlines() if ":" in l)
    return {"driver": (info.get("driver") or "").strip() or None,
            "firmware": (info.get("firmware-version") or "").strip() or None,
            "bus": (info.get("bus-info") or "").strip() or None}


def _addrs(iface):
    out = utils.run(["ip", "-4", "-o", "addr", "show", iface], check=False,
                    timeout=10).stdout or ""
    return re.findall(r"inet (\S+)", out)


def _default_route_iface():
    out = utils.run(["ip", "-4", "route", "show", "default"], check=False,
                    timeout=10).stdout or ""
    m = re.search(r"\bdev (\S+)", out)
    return m.group(1) if m else None


def list_nics(configured=None, camera_ifaces=(), vlan=None):
    """Every physical NIC, with whether it can do hardware PTP and why not."""
    if not utils.have("ethtool") and not os.path.exists("/usr/sbin/ethtool"):
        return {"nics": [], "hidden": 0,
                "error": "ethtool is not installed — install the dependencies first"}
    default_if = _default_route_iface()
    nics, hidden = [], []
    for path in sorted(glob.glob("/sys/class/net/*")):
        name = os.path.basename(path)
        if name.startswith(_SKIP_PREFIXES) or "." in name:
            continue
        if not os.path.exists(os.path.join(path, "device")):
            continue                       # virtual: no hardware clock to have
        ts = _timestamping(name)
        carrier = _read(os.path.join(path, "carrier")) == "1"
        speed = _read(os.path.join(path, "speed"))
        speed = int(speed) if speed and speed.lstrip("-").isdigit() and int(speed) > 0 else None
        row = {
            "interface": name, **ts, **_driver(name),
            "mac": _read(os.path.join(path, "address")),
            "carrier": carrier, "speed_mbps": speed, "addresses": _addrs(name),
            "configured": name == configured,
            "vlan_present": bool(vlan) and os.path.exists(f"/sys/class/net/{name}.{vlan}"),
            "role": ("camera port" if name in camera_ifaces
                     else "site LAN (default route)" if name == default_if else None),
        }
        reasons = []
        if ts["phc"] is None:
            reasons.append("no PTP hardware clock")
        if not (ts["hw_tx"] and ts["hw_rx"]):
            reasons.append("no hardware transmit/receive timestamps")
        if name in camera_ifaces:
            reasons.append("camera port — a grandmaster is not on this cable")
        row["supported"] = ts["phc"] is not None and ts["hw_tx"] and ts["hw_rx"]
        row["usable"] = row["supported"] and name not in camera_ifaces
        row["why_not"] = reasons
        if not carrier:
            row.setdefault("warnings", []).append("no link — is the cable in?")
        if name == default_if:
            row.setdefault("warnings", []).append(
                "also carries the site LAN; PTP on a VLAN subinterface coexists with it")
        (nics if row["supported"] else hidden).append(row)
    # The configured port first, then usable ones with link, then the rest.
    nics.sort(key=lambda r: (not r["configured"], not r["usable"], not r["carrier"],
                             r["interface"]))
    return {"nics": nics, "hidden": len(hidden),
            "hidden_names": [h["interface"] for h in hidden]}


# -- the guided start ------------------------------------------------------------
STEPS = ["dependencies", "nic", "settings", "start", "lock", "clock"]


def setup(gptp, iface, settings, ctx, install=True, lock_timeout=90,
          camera_ifaces=()):
    """Install, check, configure, start, wait for lock, verify CLOCK_TAI.

    `ctx` is a job context (plan/step/log). Each step either passes or raises
    SetupError naming the step and the likely cause.
    """
    log = ctx.log
    ctx.plan(STEPS)

    ctx.step("dependencies", "checking linuxptp and ethtool")
    deps = dependencies()
    if not deps["ok"]:
        if not install:
            raise SetupError(f"missing: {', '.join(deps['missing_packages'])} — "
                             f"tick 'install missing software' or run apt")
        install_dependencies(log)
    else:
        log("ptp4l, phc2sys, pmc and ethtool present")

    ctx.step("nic", f"checking {iface}")
    if not iface:
        raise SetupError("no NIC chosen")
    if not os.path.exists(f"/sys/class/net/{iface}"):
        raise SetupError(f"{iface} does not exist")
    if iface in camera_ifaces:
        raise SetupError(f"{iface} is a camera port; the grandmaster is not on that cable")
    ts = _timestamping(iface)
    if ts["phc"] is None or not (ts["hw_tx"] and ts["hw_rx"]):
        raise SetupError(f"{iface} has no hardware timestamping (PHC {ts['phc']}); "
                         f"pick a NIC from the supported list")
    if _read(f"/sys/class/net/{iface}/carrier") != "1":
        raise SetupError(f"{iface} has no link — check the cable to the grandmaster switch")
    log(f"{iface}: PHC /dev/ptp{ts['phc']}, hardware tx+rx timestamps, link up")

    ctx.step("settings", "profile, VLAN, domain, UTC offset")
    applied = gptp.configure(interface=iface, **settings)
    log("profile {profile}, VLAN {vlan}, domain {domain}, TAI-UTC {utc_offset} s"
        .format(**{k: applied.get(k) if applied.get(k) is not None else "none"
                   for k in ("profile", "vlan", "domain", "utc_offset")}))

    ctx.step("start", "starting ptp4l and phc2sys")
    gptp.enabled = True
    if gptp.status.get("running"):
        gptp.restart()
    else:
        gptp.start()
    log(f"ptp4l on {gptp.status.get('interface')}, phc2sys -> CLOCK_REALTIME")

    ctx.step("lock", f"waiting up to {lock_timeout}s for the grandmaster and lock")
    deadline = time.monotonic() + lock_timeout
    seen_gm = said_sys = False
    while time.monotonic() < deadline:
        st = gptp.status
        if st.get("grandmaster") and not seen_gm:
            log(f"grandmaster {st['grandmaster']} heard; port {st.get('port_state')}")
            seen_gm = True
        if st.get("locked") and st.get("sys_locked"):
            break
        if st.get("locked") and not said_sys:
            log(f"NIC clock locked (offset {st.get('offset_ns')} ns); "
                f"waiting for the system clock")
            said_sys = True
        if not st.get("running"):
            raise SetupError("ptp4l exited — see the daemon log for its last line")
        time.sleep(1)
    else:
        st = gptp.status
        if not st.get("grandmaster"):
            raise SetupError(
                "no grandmaster heard. ptp4l does not error on a mismatch, it just "
                "listens: check the profile (IEEE 1588 vs 802.1AS), the VLAN "
                "(blank if the switch port is untagged) and the domain")
        if not st.get("locked"):
            raise SetupError(f"grandmaster heard but the servo did not lock "
                             f"(servo {st.get('servo')}, offset {st.get('offset_ns')} ns)")
        raise SetupError(f"NIC clock locked but the system clock did not "
                         f"(phc2sys servo {st.get('sys_servo')})")
    log(f"locked: NIC {gptp.status.get('offset_ns')} ns, "
        f"system {gptp.status.get('sys_offset_ns')} ns from the grandmaster")

    ctx.step("clock", "verifying CLOCK_TAI")
    full = gptp.get_status()
    if full.get("tai_offset") != full.get("expected_tai_offset"):
        raise SetupError(f"kernel TAI offset is {full.get('tai_offset')}, expected "
                         f"{full.get('expected_tai_offset')}")
    log(f"CLOCK_TAI = wall clock + {full.get('tai_minus_realtime_s')} s; "
        f"{'ready for a gate schedule' if full.get('gate_clock_ok') else 'NOT ready: ' + '; '.join(full.get('problems') or [])}")
    return full
