"""
Modem manager — Quectel RM520N-GL over AT commands (+ qmicli for data format).

Two responsibilities, matching the guided-setup steps:
  * check()  — verify SIM, 5G registration and signal WITHOUT activating a session
  * attach() — activate the PDU session for the chosen transport:
        ethernet -> AT+CGDCONT=<cid>,"Ethernet","<dnn>" + qmicli 802-3 link layer
        vxlan/ip -> AT+CGDCONT=<cid>,"IPV4V6","<dnn>"   + qmicli raw-ip + start-network

AT reference (RM520N): ATE0, AT+CPIN?, AT+CxREG?, AT+QENG="servingcell", AT+CSQ,
AT+COPS?, AT+CGDCONT, AT+CGACT. Serial via pyserial (imported lazily).
"""

import glob
import logging
import os
import re
import time

from . import utils

logger = logging.getLogger("tsn5g-ue.modem")

# Cache the detection result so repeated GET /api/discovery calls don't re-open
# and probe serial ports every time. Invalidated automatically if the port vanishes.
_DETECT_CACHE = {}


def _probe_at(dev, baud=115200, timeout=1.0):
    """Open `dev` and check whether it is a modem AT command port.

    Returns ``(is_at_port, model_or_None)``. A real AT port answers ``AT`` with
    ``OK``; diagnostic/NMEA/GNSS ports on the same modem do not, which is how we
    avoid picking the wrong ttyUSB. Best-effort and never raises.
    """
    try:
        import serial  # pyserial, lazy
    except ImportError:
        return (False, None)
    try:
        with serial.Serial(dev, baud, timeout=timeout) as s:
            s.reset_input_buffer()
            s.write(b"AT\r\n")
            time.sleep(0.15)
            if "OK" not in s.read(128).decode(errors="ignore"):
                return (False, None)
            # A port that also returns a model id is definitively the AT port.
            s.reset_input_buffer()
            s.write(b"AT+CGMM\r\n")
            time.sleep(0.15)
            model = None
            for ln in s.read(256).decode(errors="ignore").splitlines():
                ln = ln.strip()
                if ln and ln != "OK" and not ln.upper().startswith("AT"):
                    model = ln
                    break
            return (True, model)
    except Exception:  # noqa: BLE001 — serial can fail many ways; treat as "not the port"
        return (False, None)


def detect_modem_ports(configured_at=None, configured_qmi=None, baud=115200):
    """Locate the modem's AT and QMI control devices.

    Prefers configured hints, then probes ``/dev/ttyUSB*`` and ``/dev/ttyACM*``
    for the AT port and globs ``/dev/cdc-wdm*`` for the QMI device. Cached once a
    working AT port is found. Returns
    ``{"at": dev|None, "qmi": dev|None, "model": str|None, "candidates": [...]}``.
    """
    if not utils.is_linux():
        return {"at": configured_at, "qmi": configured_qmi, "model": None, "candidates": []}

    cached = _DETECT_CACHE.get("ports")
    if cached and cached.get("at") and os.path.exists(cached["at"]):
        return cached

    # QMI control device
    if configured_qmi and os.path.exists(configured_qmi):
        qmi = configured_qmi
    else:
        wdms = sorted(glob.glob("/dev/cdc-wdm*"))
        qmi = wdms[0] if wdms else None

    # AT port — try the configured hint first, then every serial candidate.
    candidates = []
    if configured_at and os.path.exists(configured_at):
        candidates.append(configured_at)
    for dev in sorted(glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*")):
        if dev not in candidates:
            candidates.append(dev)

    at, model = None, None
    for dev in candidates:
        ok, found_model = _probe_at(dev, baud)
        if ok:
            at, model = dev, found_model
            if found_model:  # confident match — stop probing further ports
                break

    result = {"at": at or configured_at, "qmi": qmi, "model": model,
              "candidates": candidates}
    if at:
        _DETECT_CACHE["ports"] = result
    logger.info("modem port detection: at=%s qmi=%s model=%s", result["at"], qmi, model)
    return result


class ModemError(RuntimeError):
    pass


class ModemManager:
    def __init__(self, modem_cfg, platform=None):
        self.cfg = modem_cfg or {}
        # OS provider (OpenWRT/Linux) for the IP-PDU data session + DHCP/route.
        # Imported lazily so tests can construct a ModemManager without one.
        if platform is None:
            from .platform import get_platform
            platform = get_platform()
        self.platform = platform
        self.device = self.cfg.get("device")
        self.wwan = self.cfg.get("wwan_interface", "wwan0")
        self.cid = self.cfg.get("cid", 1)
        self.baud = self.cfg.get("baud_rate", 115200)
        self.qmi_device = self.cfg.get("qmi_device", "/dev/cdc-wdm0")

        self._serial = None
        self.registered = False
        self.pdu_active = False
        self.mode = None
        self.sim_ready = False
        self.operator = None
        self.model = None
        self.band = None
        self.arfcn = None
        self.rat = None
        self.cell = None
        self.mac_address = None
        self.ipv4 = None
        self.signal = {"rsrp": None, "rsrq": None, "sinr": None, "rssi": None}

    # ----------------------------------------------------------------- serial
    def _resolve_device(self):
        if self.device and os.path.exists(self.device):
            return self.device
        # Probe for the real AT port instead of guessing an enumeration index.
        ports = detect_modem_ports(self.device, self.qmi_device, self.baud)
        self.device = ports.get("at")
        if ports.get("qmi"):
            self.qmi_device = ports["qmi"]
        if ports.get("model"):
            self.model = ports["model"]
        if not self.device:
            raise ModemError(
                "no modem AT port found (probed /dev/ttyUSB*, /dev/ttyACM*)")
        return self.device

    def _open(self):
        if self._serial:
            return
        try:
            import serial  # pyserial, lazy
        except ImportError as exc:
            raise ModemError("pyserial not installed") from exc
        dev = self._resolve_device()
        self._serial = serial.Serial(dev, self.baud, timeout=1)
        self._at("ATE0")  # echo off

    def _close(self):
        if self._serial:
            try:
                self._serial.close()
            except Exception:  # noqa: BLE001
                pass
            self._serial = None

    def _at(self, cmd, timeout=3):
        """Send an AT command, return the response lines (list of str)."""
        if not self._serial:
            raise ModemError("serial not open")
        self._serial.reset_input_buffer()
        self._serial.write((cmd + "\r\n").encode())
        deadline = time.time() + timeout
        buf = ""
        while time.time() < deadline:
            chunk = self._serial.read(256).decode(errors="ignore")
            buf += chunk
            if "OK" in buf or "ERROR" in buf:
                break
        if "ERROR" in buf:
            raise ModemError(f"AT command failed: {cmd!r} -> {buf.strip()}")
        return [ln.strip() for ln in buf.splitlines() if ln.strip() and ln.strip() != "OK"]

    # ----------------------------------------------------------------- check
    def check(self):
        """Step 1 — verify SIM, registration and signal. Non-destructive."""
        if not utils.is_linux():
            raise ModemError("modem control requires Linux")
        # Release ModemManager et al. so the AT port is ours (idempotent).
        self.platform.prepare_modem()
        self._open()
        # SIM
        cpin = self._at("AT+CPIN?")
        self.sim_ready = any("READY" in l for l in cpin)
        # Operator
        cops = self._at("AT+COPS?")
        m = re.search(r'\+COPS:\s*\d+,\d+,"([^"]+)"', " ".join(cops))
        self.operator = m.group(1) if m else None
        # 5G / LTE registration (stat 1=registered home, 5=roaming)
        reg = self._at("AT+C5GREG?") or self._at("AT+CEREG?")
        m = re.search(r'REG:\s*\d+,\s*(\d+)', " ".join(reg))
        self.registered = bool(m and m.group(1) in ("1", "5"))
        # Signal via QENG servingcell
        self.refresh_signal()
        logger.info("modem check: sim=%s reg=%s op=%s rsrp=%s",
                    self.sim_ready, self.registered, self.operator, self.signal.get("rsrp"))
        return self.get_status()

    def refresh_signal(self):
        try:
            if not self._serial:
                self._open()
            eng = " ".join(self._at('AT+QENG="servingcell"'))
            # RM520N-GL NR5G-SA line (verified on hardware):
            #   +QENG: "servingcell",<state>,"NR5G-SA",<dup>,<mcc>,<mnc>,<cellid>,
            #          <pci>,<?>,<arfcn>,<band>,<dl_bw>,<RSRP>,<RSRQ>,<SINR>,...
            # RSRP/RSRQ/SINR sit at fixed offsets but the cell-id field is hex and
            # trips a naive digit scan, so parse positionally: RSRP is the first
            # field in the valid dBm range, with RSRQ/SINR immediately after.
            if "NR5G-SA" in eng:
                tail = eng.split('"NR5G-SA"', 1)[1]
                vals = []
                for f in tail.split(","):
                    f = f.strip().strip('"')
                    try:
                        vals.append(int(f))
                    except ValueError:
                        vals.append(None)
                for i, v in enumerate(vals):
                    if v is not None and -140 <= v <= -40:  # plausible RSRP (dBm)
                        self.signal["rsrp"] = v
                        if i + 1 < len(vals) and vals[i + 1] is not None:
                            self.signal["rsrq"] = vals[i + 1]
                        if i + 2 < len(vals) and vals[i + 2] is not None:
                            self.signal["sinr"] = vals[i + 2]
                        # band sits two fields before RSRP, ARFCN three before.
                        self.rat = "NR5G-SA"
                        if i >= 2 and vals[i - 2] is not None:
                            self.band = "n%d" % vals[i - 2]
                        if i >= 3 and vals[i - 3] is not None:
                            self.arfcn = vals[i - 3]
                        break
            csq = " ".join(self._at("AT+CSQ"))
            m = re.search(r'\+CSQ:\s*(\d+)', csq)
            if m and m.group(1) != "99":
                self.signal["rssi"] = -113 + 2 * int(m.group(1))
        except ModemError as exc:
            logger.debug("signal refresh failed: %s", exc)
        return self.signal

    # ----------------------------------------------------------------- attach
    def attach(self, mode, dnn):
        """Step 2 (part) — activate the PDU session for the chosen transport."""
        if not utils.is_linux():
            raise ModemError("modem control requires Linux")
        self.mode = mode
        self.platform.prepare_modem()
        self._open()
        self._ensure_registered()
        if mode == "ethernet":
            self._attach_ethernet(dnn)
        else:
            self._attach_ip(dnn)
        self.pdu_active = True
        logger.info("PDU session active (mode=%s dnn=%s ip=%s mac=%s)",
                    mode, dnn, self.ipv4, self.mac_address)

    def _ensure_registered(self, timeout=40):
        """Make sure the modem is registered on the network; if not, trigger
        registration (full functionality + automatic operator) and poll. Needed
        because after ModemManager is stopped the modem may be searching."""
        self.check()
        if self.registered:
            return
        logger.info("modem not registered — triggering (AT+CFUN=1, AT+COPS=0)")
        for cmd in ("AT+CFUN=1", "AT+COPS=0"):
            try:
                self._at(cmd, timeout=8)
            except ModemError as exc:
                logger.debug("%s: %s", cmd, exc)
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(5)
            self.check()
            if self.registered:
                logger.info("modem registered (op=%s)", self.operator)
                return
        raise ModemError("modem failed to register on 5G within %ds" % timeout)

    def _attach_ethernet(self, dnn):
        self.mac_address = utils.read_sysfs(f"/sys/class/net/{self.wwan}/address")
        self._at(f'AT+CGDCONT={self.cid},"Ethernet","{dnn}"')
        # Put the QMI WWAN link into 802.3 (Ethernet) framing.
        if utils.have("qmicli"):
            utils.run(["qmicli", "-d", self.qmi_device,
                       "--wda-set-data-format=link-layer-protocol=802-3"], check=False)
        self._at(f"AT+CGACT=1,{self.cid}")
        utils.ip("link", "set", self.wwan, "up")

    def _attach_ip(self, dnn):
        # The context definition is identical on every OS (serial AT); the data
        # session bring-up (QMI framing, session start, DHCP, default route) is
        # OS-specific and delegated to the platform provider — uqmi/netifd on
        # OpenWRT, qmicli+dhclient on generic Linux.
        self._at(f'AT+CGDCONT={self.cid},"IPV4V6","{dnn}"')
        result = self.platform.bring_up_ip_pdu(self.wwan, dnn, self.qmi_device, cid=self.cid)
        self.ipv4 = result.get("ipv4") or self._read_ipv4()
        logger.info("IP PDU up via %s (ip=%s)", result.get("method"), self.ipv4)

    def _read_ipv4(self):
        try:
            out = utils.ip("-4", "addr", "show", self.wwan).stdout
            m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", out)
            return m.group(1) if m else None
        except utils.CommandError:
            return None

    def detach(self):
        # Tear the OS-managed data session down first (best-effort), then the context.
        if self.mode != "ethernet":
            try:
                self.platform.teardown_ip_pdu(self.wwan, self.qmi_device)
            except Exception as exc:  # noqa: BLE001
                logger.debug("teardown_ip_pdu failed: %s", exc)
        try:
            if self._serial:
                self._at(f"AT+CGACT=0,{self.cid}")
        except ModemError as exc:
            logger.debug("detach CGACT failed: %s", exc)
        self.pdu_active = False
        self._close()
        logger.info("modem detached")

    # ----------------------------------------------------------------- status
    def get_status(self):
        return {
            "device": self.device, "wwan_interface": self.wwan, "cid": self.cid,
            "model": self.model, "qmi_device": self.qmi_device,
            "rat": self.rat, "arfcn": self.arfcn,
            "mode": self.mode, "sim_ready": self.sim_ready, "registered": self.registered,
            "pdu_active": self.pdu_active, "operator": self.operator, "band": self.band,
            "mac_address": self.mac_address, "ipv4": self.ipv4, "signal": self.signal,
        }

    def check_health(self):
        return self.registered and self.pdu_active
