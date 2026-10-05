"""
PTP manager — ptp4l + phc2sys, in either of two profiles.

Spawns ptp4l on a timestamping-capable interface and phc2sys to discipline the
system clock, parses ptp4l output for offset and lock state, and restarts a
daemon that dies.

Two profiles, because the grandmaster decides which one is correct and they are
not interchangeable:

  gptp      IEEE 802.1AS. Peer-delay, its own multicast address, and
            transportSpecific 1. What an AVB/TSN bridge speaks.
  ieee1588  The IEEE 1588 default profile. End-to-end delay, a different
            multicast address, and transportSpecific 0.

Pointing the wrong one at a grandmaster does not produce an error — ptp4l simply
never hears an Announce it recognises and sits in a listening state forever. So
the profile is a stated choice rather than a default.

Why the UTC offset is set locally rather than taken from the network: the PTP
timescale is TAI, and a slave learns TAI-UTC from the grandmaster's
currentUtcOffset. A grandmaster that advertises utcOffsetValid = false — which a
free-running one usually does — leaves the slave to supply it. Get this wrong and
the clock is right while CLOCK_TAI, which is what a gate schedule is anchored to,
is out by the whole offset.
"""

import ctypes
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
from collections import deque

from . import utils

logger = logging.getLogger("tsn5g-ue.gptp")

#: Seconds between TAI and UTC. Not a constant of nature — it changes when a leap
#: second is inserted, and has been 37 since 2017. Configurable for that reason.
DEFAULT_UTC_OFFSET = 37

# Minimal 802.1AS-style ptp4l profile (gPTP: L2 transport, P2P delay, TS 1).
GPTP_CONF = """[global]
gmCapable               0
priority1               {priority1}
priority2               248
domainNumber            {domain}
transportSpecific       0x{ts:X}
ptp_dst_mac             01:80:C2:00:00:0E
network_transport       L2
delay_mechanism         P2P
time_stamping           hardware
tx_timestamp_timeout    50
"""

# IEEE 1588 default profile over Ethernet, slave-only.
#
# Three values differ from the gPTP block above and all three are load-bearing:
# the multicast MAC (1588 uses 01:1B:19:00:00:00 for everything but peer-delay),
# the delay mechanism, and transportSpecific. A mismatch on any one of them is
# silent.
PTP1588_CONF = """[global]
clientOnly              {client_only}
priority1               255
priority2               255
domainNumber            {domain}
transportSpecific       0x0
ptp_dst_mac             01:1B:19:00:00:00
network_transport       L2
delay_mechanism         E2E
time_stamping           hardware
dataset_comparison      ieee1588
utc_offset              {utc_offset}
socket_priority         0
tx_timestamp_timeout    50
logAnnounceInterval     1
logSyncInterval         0
logMinDelayReqInterval  0
announceReceiptTimeout  3
"""

PROFILES = ("gptp", "ieee1588")


#: adjtimex mode bit that sets the kernel's TAI-UTC offset from timex.constant.
_ADJ_TAI = 0x0080


def kernel_tai_offset():
    """The kernel's TAI-UTC offset, in seconds, via adjtimex.

    This is the number that makes CLOCK_TAI mean anything. It is 0 on a host
    that has never run PTP, and a gate anchored to CLOCK_TAI on such a host is
    really anchored to wall clock. Read back rather than assumed, because
    nothing else in the stack will complain if it stays 0.
    """
    class _Timex(ctypes.Structure):
        _fields_ = [("modes", ctypes.c_uint), ("offset", ctypes.c_long),
                    ("freq", ctypes.c_long), ("maxerror", ctypes.c_long),
                    ("esterror", ctypes.c_long), ("status", ctypes.c_int),
                    ("constant", ctypes.c_long), ("precision", ctypes.c_long),
                    ("tolerance", ctypes.c_long), ("time_sec", ctypes.c_long),
                    ("time_usec", ctypes.c_long), ("tick", ctypes.c_long),
                    ("ppsfreq", ctypes.c_long), ("jitter", ctypes.c_long),
                    ("shift", ctypes.c_int), ("stabil", ctypes.c_long),
                    ("jitcnt", ctypes.c_long), ("calcnt", ctypes.c_long),
                    ("errcnt", ctypes.c_long), ("stbcnt", ctypes.c_long),
                    ("tai", ctypes.c_int), ("pad", ctypes.c_int * 11)]
    try:
        t = _Timex()
        ctypes.CDLL("libc.so.6").adjtimex(ctypes.byref(t))
        return int(t.tai)
    except Exception:                                   # noqa: BLE001
        return None


def set_kernel_tai_offset(seconds):
    """Set the kernel's TAI-UTC offset, so CLOCK_TAI = CLOCK_REALTIME + seconds.

    phc2sys does not do this when it is handed the offset with -O, and nothing
    else on this host does either, so without it CLOCK_TAI equals wall clock.
    Returns the value read back, which is the only evidence it landed.
    """
    class _Timex(ctypes.Structure):
        _fields_ = [("modes", ctypes.c_uint), ("offset", ctypes.c_long),
                    ("freq", ctypes.c_long), ("maxerror", ctypes.c_long),
                    ("esterror", ctypes.c_long), ("status", ctypes.c_int),
                    ("constant", ctypes.c_long), ("precision", ctypes.c_long),
                    ("tolerance", ctypes.c_long), ("time_sec", ctypes.c_long),
                    ("time_usec", ctypes.c_long), ("tick", ctypes.c_long),
                    ("ppsfreq", ctypes.c_long), ("jitter", ctypes.c_long),
                    ("shift", ctypes.c_int), ("stabil", ctypes.c_long),
                    ("jitcnt", ctypes.c_long), ("calcnt", ctypes.c_long),
                    ("errcnt", ctypes.c_long), ("stbcnt", ctypes.c_long),
                    ("tai", ctypes.c_int), ("pad", ctypes.c_int * 11)]
    t = _Timex(modes=_ADJ_TAI, constant=int(seconds))
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    if libc.adjtimex(ctypes.byref(t)) < 0:
        raise OSError(ctypes.get_errno(), "adjtimex(ADJ_TAI) failed")
    return kernel_tai_offset()


class GptpManager:
    def __init__(self, gptp_cfg, hw_ts_interfaces):
        self.cfg = gptp_cfg or {}
        self.ifaces = hw_ts_interfaces or []
        self.enabled = self.cfg.get("enabled", True)
        self.profile = self.cfg.get("profile", "gptp")
        if self.profile not in PROFILES:
            raise ValueError(f"unknown PTP profile '{self.profile}'; "
                             f"expected one of {', '.join(PROFILES)}")
        #: The physical port the grandmaster is cabled to. PTP may ride a VLAN on
        #: top of it, but hardware timestamping belongs to the physical device —
        #: the PHC is the NIC's, not the VLAN's.
        self.phys_iface = self.cfg.get("interface")
        self.vlan = self.cfg.get("vlan")
        self.utc_offset = int(self.cfg.get("utc_offset", DEFAULT_UTC_OFFSET))
        self._ptp4l = None
        self._phc2sys = None
        self._conf_path = None
        self.domain = int(self.cfg.get("domain",
                                       self.cfg.get("time_domain_number", 0)))
        self.client_only = bool(self.cfg.get("client_only", True))
        self._made_vlan = None          # only tear down a VLAN we created
        self._ntp_was_active = False    # restored by stop()
        self.status = self._blank_status()
        # One sample a second for the last hour, and the lock/unlock events, so
        # the Time Sync page opens on a history instead of an empty chart.
        self.samples = deque(maxlen=3600)
        self.events = deque(maxlen=300)
        threading.Thread(target=self._sample_loop, name="ptp-history", daemon=True).start()

    def _sample_loop(self):
        prev = {}
        names = {"running": ("PTP started", "PTP stopped"),
                 "locked": ("NIC clock locked to the grandmaster", "NIC clock lost lock"),
                 "sys_locked": ("System clock locked to the NIC", "System clock lost lock")}
        while True:
            time.sleep(1.0)
            st = self.status
            now = time.time()
            for key, (up, down) in names.items():
                v = bool(st.get(key))
                if key in prev and v != prev[key]:
                    self.events.append({"t": now, "kind": "ok" if v else "warn",
                                        "text": up if v else down})
                prev[key] = v
            gm = st.get("grandmaster")
            if prev.get("gm") and gm and gm != prev["gm"]:
                self.events.append({"t": now, "kind": "warn", "text": f"grandmaster changed to {gm}"})
            prev["gm"] = gm or prev.get("gm")
            if st.get("running"):
                self.samples.append({"t": round(now, 1), "off": st.get("offset_ns"),
                                     "sys": st.get("sys_offset_ns"), "delay": st.get("path_delay_ns"),
                                     "lock": bool(st.get("locked")), "sys_lock": bool(st.get("sys_locked"))})

    def history(self, minutes=60):
        """Samples and events from the last `minutes`."""
        since = time.time() - minutes * 60
        return {"samples": [x for x in list(self.samples) if x["t"] >= since],
                "events": [e for e in list(self.events) if e["t"] >= since]}

    def _blank_status(self):
        return {"running": False, "locked": False, "servo": None,
                "offset_ns": None, "path_delay_ns": None, "grandmaster": None,
                "worst_offset_ns": None, "port_state": None,
                "profile": self.profile, "interface": None, "tai_offset": None,
                # phc2sys: the NIC clock -> system clock half. ptp4l being
                # locked says nothing about whether CLOCK_REALTIME follows it.
                "sys_running": False, "sys_locked": False, "sys_servo": None,
                "sys_offset_ns": None, "sys_worst_offset_ns": None}

    # -- settings ----------------------------------------------------------
    def settings(self):
        """What start() will use: the config, plus any override from the UI."""
        return {"profile": self.profile, "interface": self.phys_iface,
                "vlan": self.vlan, "domain": self.domain,
                "utc_offset": self.utc_offset, "client_only": self.client_only}

    def configure(self, profile=None, interface=None, vlan=None, domain=None,
                  utc_offset=None, client_only=None, clear_vlan=False):
        """Change the settings start() will use. Takes effect on the next start.

        Validated here rather than left to ptp4l, because every one of these
        fails silently there: a wrong profile, VLAN or domain does not error —
        ptp4l just never hears the grandmaster.
        """
        if profile is not None:
            if profile not in PROFILES:
                raise ValueError(f"unknown PTP profile '{profile}'; "
                                 f"expected one of {', '.join(PROFILES)}")
            self.profile = profile
        if interface is not None:
            if not utils.iface_exists(interface):
                raise ValueError(f"interface {interface} does not exist")
            if "." in interface:
                raise ValueError(f"{interface} looks like a VLAN subinterface — "
                                 f"give the physical port and set the VLAN "
                                 f"separately; the hardware clock belongs to "
                                 f"the physical NIC")
            self.phys_iface = interface
        if clear_vlan:
            self.vlan = None
        elif vlan is not None:
            vlan = int(vlan)
            if not 1 <= vlan <= 4094:
                raise ValueError(f"VLAN {vlan} is outside 1-4094")
            self.vlan = vlan
        if domain is not None:
            domain = int(domain)
            if not 0 <= domain <= 255:
                raise ValueError(f"PTP domain {domain} is outside 0-255")
            self.domain = domain
        if utc_offset is not None:
            utc_offset = int(utc_offset)
            if not 0 <= utc_offset <= 100:
                raise ValueError(f"UTC offset {utc_offset} s is implausible "
                                 f"(it has been 37 since 2017)")
            self.utc_offset = utc_offset
        if client_only is not None:
            self.client_only = bool(client_only)
        self.status["profile"] = self.profile
        return self.settings()

    # -- the interface PTP actually binds to -------------------------------
    def _ensure_vlan(self, phys):
        """Create the VLAN subinterface PTP rides on, if one is configured.

        Returns the device ptp4l should bind to. A VLAN that already exists is
        used as-is and left alone on stop: it may belong to someone else, and
        deleting another owner's interface is a worse failure than leaving one
        behind.
        """
        if not self.vlan:
            return phys
        dev = f"{phys}.{self.vlan}"
        if utils.iface_exists(dev):
            logger.info("%s already exists; using it", dev)
            return dev
        proc = utils.run(["ip", "link", "add", "link", phys, "name", dev,
                          "type", "vlan", "id", str(self.vlan)], check=False)
        if proc.returncode != 0:
            raise RuntimeError(
                f"could not create {dev}: {(proc.stderr or '').strip()} — PTP "
                f"is tagged on VLAN {self.vlan}, so without this interface "
                f"ptp4l would listen on the wrong side of the tag and hear "
                f"nothing at all")
        utils.run(["ip", "link", "set", dev, "up"], check=False)
        self._made_vlan = dev
        logger.info("created %s for PTP on VLAN %s", dev, self.vlan)
        return dev

    def _drop_vlan(self):
        if self._made_vlan:
            utils.run(["ip", "link", "del", self._made_vlan], check=False)
            logger.info("removed %s", self._made_vlan)
            self._made_vlan = None

    # -- the other thing that steers the system clock ----------------------
    def _ntp_running(self):
        proc = utils.run(["systemctl", "is-active", "systemd-timesyncd"],
                         check=False, timeout=10)
        return (proc.stdout or "").strip() == "active"

    def _suspend_ntp(self):
        """Stop NTP from steering the clock while PTP is steering it.

        Two daemons disciplining CLOCK_REALTIME from different references do
        not average out — they fight, and the clock oscillates between them.
        The symptom is a PTP offset that looks locked while the system clock
        wanders, which is the worst of both: a gate anchored to a clock that
        two services keep pulling in opposite directions.

        Recorded so stop() can put it back. Doing this silently and
        permanently would leave a host with no time source at all if PTP were
        later switched off and nobody remembered why.
        """
        if not self.cfg.get("suspend_ntp", True):
            return
        self._ntp_was_active = self._ntp_running()
        if self._ntp_was_active:
            logger.info("stopping systemd-timesyncd: PTP and NTP would "
                        "otherwise both steer the system clock")
            utils.run(["timedatectl", "set-ntp", "false"], check=False)

    def _restore_ntp(self):
        if getattr(self, "_ntp_was_active", False):
            logger.info("restoring systemd-timesyncd — PTP is no longer "
                        "disciplining the clock")
            utils.run(["timedatectl", "set-ntp", "true"], check=False)
        self._ntp_was_active = False

    def start(self, iface=None):
        if not self.enabled:
            logger.info("gPTP disabled")
            return
        if not utils.is_linux():
            raise RuntimeError("gPTP requires Linux")
        if not utils.have("ptp4l"):
            raise RuntimeError("ptp4l not installed (linuxptp)")
        # Idempotent: a second start() replaces the first rather than running
        # alongside it. Without this, two ptp4l instances end up bound to the
        # same interface, both disciplining the same PHC and fighting over it,
        # and only the most recent is tracked — so stop() kills one and leaves
        # the other running with nothing holding a handle to it.
        if (self._ptp4l and self._ptp4l.poll() is None) or \
           (self._phc2sys and self._phc2sys.poll() is None):
            logger.info("PTP is already running; restarting it")
            self.stop()

        phys = iface or self.phys_iface or (self.ifaces[0] if self.ifaces else None)
        if not phys:
            raise RuntimeError("no interface for PTP")

        target = self._ensure_vlan(phys)

        if self.profile == "ieee1588":
            conf = PTP1588_CONF.format(
                client_only=1 if self.client_only else 0,
                domain=self.domain, utc_offset=self.utc_offset)
        else:
            conf = GPTP_CONF.format(priority1=self.cfg.get("priority1", 255),
                                    domain=self.domain,
                                    ts=self.cfg.get("transport_specific", 1))
        fd, self._conf_path = tempfile.mkstemp(prefix=f"ptp-{self.profile}-",
                                               suffix=".cfg")
        os.write(fd, conf.encode()); os.close(fd)

        cmd = ["ptp4l", "-f", self._conf_path, "-i", target, "-2", "-m"]
        logger.info("starting ptp4l (%s profile): %s", self.profile, " ".join(cmd))
        self._ptp4l = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, bufsize=1)
        threading.Thread(target=self._reader, args=(self._ptp4l,), daemon=True,
                         name="ptp4l-reader").start()
        self.status = self._blank_status()
        self.status["running"] = True
        self.status["interface"] = target

        if utils.have("phc2sys"):
            self._suspend_ntp()
            # Source is the PHYSICAL interface: the hardware clock belongs to the
            # NIC, and a VLAN has none of its own.
            #
            # -w waits for ptp4l before stepping the clock. The previous
            # `-a -r` form let phc2sys pick a source by itself, which is fine on
            # a host with one timestamping NIC and ambiguous on this one, where
            # there are six.
            #
            # -O gives the UTC offset explicitly. Left to itself, -w copies
            # currentUtcOffset from the grandmaster, and this one advertises
            # utcOffsetValid = false with an offset of 0 — so phc2sys set the
            # system clock to TAI and the host ran 37 s fast (measured against
            # the core, 1 Oct). ptp4l's own utc_offset does not help: a slave
            # only uses it if it becomes the grandmaster.
            cmd2 = ["phc2sys", "-s", phys, "-c", "CLOCK_REALTIME", "-w",
                    "-O", str(-self.utc_offset), "-m"]
            logger.info("starting phc2sys: %s", " ".join(cmd2))
            self._phc2sys = subprocess.Popen(
                cmd2, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1)
            threading.Thread(target=self._sys_reader, args=(self._phc2sys,),
                             daemon=True, name="phc2sys-reader").start()
            self.status["sys_running"] = True
            self._apply_tai_offset()
        else:
            logger.warning("phc2sys not installed — the NIC clock will follow "
                           "the grandmaster but the system clock will not "
                           "follow the NIC, so CLOCK_TAI stays wrong")

    def _apply_tai_offset(self):
        """Make CLOCK_TAI = CLOCK_REALTIME + utc_offset, and say if it did not."""
        try:
            got = set_kernel_tai_offset(self.utc_offset)
        except OSError as exc:
            logger.error("could not set the kernel TAI offset to %s: %s — "
                         "CLOCK_TAI will equal wall clock", self.utc_offset, exc)
            return
        if got != self.utc_offset:
            logger.error("kernel TAI offset reads %s after setting %s",
                         got, self.utc_offset)
        else:
            logger.info("kernel TAI offset set to %s", got)

    def _sys_reader(self, proc):
        """phc2sys lines: `CLOCK_REALTIME phc offset  -87 s2 freq ... delay 2464`."""
        offs_re = re.compile(r"phc offset\s+(-?\d+)\s+(s\d)")
        for line in proc.stdout:
            m = offs_re.search(line)
            if not m:
                continue
            ns, servo = int(m.group(1)), m.group(2)
            self.status["sys_offset_ns"] = ns
            self.status["sys_servo"] = servo
            was = self.status.get("sys_locked")
            self.status["sys_locked"] = servo == "s2"
            if servo == "s2":
                if not was:
                    # Worst since lock, not since start: the first samples are
                    # the initial step, which says nothing about steady state.
                    self.status["sys_worst_offset_ns"] = ns
                worst = self.status.get("sys_worst_offset_ns")
                if worst is None or abs(ns) > abs(worst):
                    self.status["sys_worst_offset_ns"] = ns
        self.status["sys_running"] = False
        self.status["sys_locked"] = False

    def _reader(self, proc):
        rms_re = re.compile(r"rms\s+(\d+).*?delay\s+(\d+)")
        offs_re = re.compile(r"master offset\s+(-?\d+)")
        delay_re = re.compile(r"path delay\s+(-?\d+)")
        state_re = re.compile(r"port \d+.*?\bto (\w+) on\b")
        gm_re = re.compile(r"(?:selected best master clock|new foreign master)\s+(\S+)")
        for line in proc.stdout:
            line = line.strip()
            if "selected local clock" in line or "assuming the grand master" in line:
                # No grandmaster on the wire, so ptp4l fell back to its own
                # clock. Worth saying loudly: the daemon is "running" and the
                # offset reads zero, which looks exactly like success.
                logger.warning("ptp4l has no grandmaster and is free-running: %s", line)
                self.status["grandmaster"] = None
                self.status["locked"] = False
            m = gm_re.search(line)
            if m:
                self.status["grandmaster"] = m.group(1)
            m = state_re.search(line)
            if m:
                self.status["port_state"] = m.group(1)
            m = rms_re.search(line)
            if m:
                self._note_offset(int(m.group(1)))
                self.status["path_delay_ns"] = int(m.group(2))
            m = offs_re.search(line)
            if m:
                self._note_offset(int(m.group(1)))
            m = delay_re.search(line)
            if m:
                self.status["path_delay_ns"] = int(m.group(1))
            if "failed" in line.lower() or "fault" in line.lower():
                logger.warning("ptp4l: %s", line)
            # servo state s2 == locked
            m = re.search(r"master offset\s+-?\d+\s+(s\d)", line)
            if m:
                self.status["servo"] = m.group(1)
            if " s2 " in f" {line} ":
                if not self.status.get("locked"):
                    # Restart the worst-case window at lock, for the same
                    # reason as phc2sys: convergence is not steady state.
                    self.status["worst_offset_ns"] = None
                    m = offs_re.search(line)
                    if m:
                        self.status["worst_offset_ns"] = int(m.group(1))
                self.status["locked"] = True
            elif " s0 " in f" {line} " or " s1 " in f" {line} ":
                self.status["locked"] = False

    def _note_offset(self, ns):
        """Record the offset, and the worst one seen since start.

        The worst case is the number that matters for a gate: a mean offset of
        200 ns with an excursion to 400 us describes a schedule that was wrong
        for a while, and the mean alone hides it.
        """
        self.status["offset_ns"] = ns
        worst = self.status.get("worst_offset_ns")
        if worst is None or abs(ns) > abs(worst):
            self.status["worst_offset_ns"] = ns

    def stop(self):
        for p in (self._phc2sys, self._ptp4l):
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    p.kill()
        self._ptp4l = self._phc2sys = None
        if self._conf_path and os.path.exists(self._conf_path):
            os.unlink(self._conf_path)
        self._drop_vlan()
        self._restore_ntp()
        self.status = self._blank_status()
        logger.info("PTP stopped")

    def restart(self, iface=None):
        self.stop()
        self.start(iface=iface)

    def check_and_restart(self):
        dead = [name for name, p in (("ptp4l", self._ptp4l), ("phc2sys", self._phc2sys))
                if p is not None and p.poll() is not None]
        if self.status["running"] and dead:
            # Both are restarted together: phc2sys alone against a fresh
            # ptp4l, or the reverse, is a state nothing here has tested.
            logger.warning("%s exited; restarting PTP", " and ".join(dead))
            self.restart()

    def get_status(self):
        """Live status, including whether the clock is fit to anchor a gate.

        `tai_offset` is read from the kernel every time rather than cached. It
        is the one value that silently invalidates every time-aware measurement
        on the host: a gate schedule is anchored to CLOCK_TAI, and while the
        offset is 0 that clock is just wall clock wearing a different name.
        """
        import time
        tai = kernel_tai_offset()
        try:
            tai_minus_rt = round(time.clock_gettime(time.CLOCK_TAI)
                                 - time.clock_gettime(time.CLOCK_REALTIME), 3)
        except (AttributeError, OSError):
            tai_minus_rt = None
        # The configured port first, so a picker defaults to the right one —
        # it used to default to whichever timestamping NIC enumerated first.
        cands = list(self.ifaces)
        if self.phys_iface and self.phys_iface in cands:
            cands.remove(self.phys_iface)
        if self.phys_iface:
            cands.insert(0, self.phys_iface)
        # Live, not remembered: NTP may have been switched off by an earlier
        # run, and "we did not stop it" is not the same as "it is off".
        # Cached, because this is polled every second.
        now = time.monotonic()
        if now - getattr(self, "_ntp_checked", 0) > 10:
            self._ntp_active = self._ntp_running() if utils.is_linux() else None
            self._ntp_checked = now
        st = dict(self.status, enabled=self.enabled, interfaces=cands,
                  ntp_active=getattr(self, "_ntp_active", None),
                  tai_offset=tai, expected_tai_offset=self.utc_offset,
                  tai_minus_realtime_s=tai_minus_rt,
                  ntp_suspended=bool(self._ntp_was_active),
                  vlan=self.vlan, phys_interface=self.phys_iface,
                  domain=self.domain, settings=self.settings())
        problems = []
        if not self.enabled:
            # Said out loud rather than left as a bare false. A gate will still
            # apply with no PTP running; it just will not be anchored to
            # anything, and that is worth reading on the status page rather
            # than inferring from a flag.
            problems.append("PTP is disabled — CLOCK_TAI is NTP wall clock, "
                            "so any gate schedule is unanchored")
        elif not self.status.get("running"):
            problems.append("ptp4l is not running")
        else:
            if not self.status.get("grandmaster"):
                problems.append("no grandmaster selected")
            if not self.status.get("locked"):
                problems.append(f"servo not locked "
                                f"(port state {self.status.get('port_state')})")
            if tai is not None and tai != self.utc_offset:
                problems.append(f"kernel TAI offset is {tai}, expected "
                                f"{self.utc_offset} — CLOCK_TAI is wrong, so a "
                                f"gate anchored to it is not aligned to anything")
            if not self.status.get("sys_running"):
                problems.append("phc2sys is not running — the NIC clock follows "
                                "the grandmaster but the system clock does not")
            elif not self.status.get("sys_locked"):
                problems.append(f"system clock not locked to the NIC clock "
                                f"(phc2sys servo {self.status.get('sys_servo')})")
        st["gate_clock_ok"] = self.enabled and not problems
        st["problems"] = problems
        return st

    def check_health(self):
        return (not self.enabled) or self.status.get("running", False)
