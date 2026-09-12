"""
gPTP / IEEE 802.1AS manager — ptp4l (transparent/boundary clock) + phc2sys.

Spawns ptp4l on the DS-TT interface(s) with the 802.1AS profile and phc2sys to
discipline the system clock, then parses ptp4l output for offset and lock state.
A watchdog restarts a daemon if it dies. Ported from the reference gptp.py.
"""

import logging
import os
import re
import subprocess
import tempfile
import threading

from . import utils

logger = logging.getLogger("tsn5g-ue.gptp")

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


class GptpManager:
    def __init__(self, gptp_cfg, hw_ts_interfaces):
        self.cfg = gptp_cfg or {}
        self.ifaces = hw_ts_interfaces or []
        self.enabled = self.cfg.get("enabled", True)
        self._ptp4l = None
        self._phc2sys = None
        self._conf_path = None
        self.status = {"running": False, "locked": False, "offset_ns": None,
                       "path_delay_ns": None, "grandmaster": None}

    def start(self, iface=None):
        if not self.enabled:
            logger.info("gPTP disabled")
            return
        if not utils.is_linux():
            raise RuntimeError("gPTP requires Linux")
        if not utils.have("ptp4l"):
            raise RuntimeError("ptp4l not installed (linuxptp)")
        target = iface or (self.ifaces[0] if self.ifaces else None)
        if not target:
            raise RuntimeError("no interface for gPTP")

        conf = GPTP_CONF.format(priority1=self.cfg.get("priority1", 255),
                                domain=self.cfg.get("time_domain_number", 0),
                                ts=self.cfg.get("transport_specific", 1))
        fd, self._conf_path = tempfile.mkstemp(prefix="gptp-", suffix=".cfg")
        os.write(fd, conf.encode()); os.close(fd)

        cmd = ["ptp4l", "-f", self._conf_path, "-i", target, "-2", "-m"]
        logger.info("starting ptp4l: %s", " ".join(cmd))
        self._ptp4l = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, bufsize=1)
        threading.Thread(target=self._reader, args=(self._ptp4l,), daemon=True,
                         name="ptp4l-reader").start()
        self.status["running"] = True

        if utils.have("phc2sys"):
            self._phc2sys = subprocess.Popen(
                ["phc2sys", "-a", "-r", "-m"], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL)

    def _reader(self, proc):
        rms_re = re.compile(r"rms\s+(\d+).*?delay\s+(\d+)")
        offs_re = re.compile(r"master offset\s+(-?\d+)")
        for line in proc.stdout:
            line = line.strip()
            if "selected local clock" in line or "assuming the grand master" in line:
                self.status["grandmaster"] = line.split()[-1]
            m = rms_re.search(line)
            if m:
                self.status["offset_ns"] = int(m.group(1))
                self.status["path_delay_ns"] = int(m.group(2))
            m = offs_re.search(line)
            if m:
                self.status["offset_ns"] = int(m.group(1))
            # servo state s2 == locked
            if " s2 " in f" {line} ":
                self.status["locked"] = True
            elif " s0 " in f" {line} " or " s1 " in f" {line} ":
                self.status["locked"] = False

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
        self.status = {"running": False, "locked": False, "offset_ns": None,
                       "path_delay_ns": None, "grandmaster": None}
        logger.info("gPTP stopped")

    def check_and_restart(self):
        if self.status["running"] and self._ptp4l and self._ptp4l.poll() is not None:
            logger.warning("ptp4l exited; restarting")
            self.status["running"] = False
            self.start()

    def get_status(self):
        return dict(self.status, enabled=self.enabled, interfaces=self.ifaces)

    def check_health(self):
        return (not self.enabled) or self.status.get("running", False)
