"""
Modem manager — the facade the controller talks to.

All AT traffic now goes through ModemBus rather than a serial handle owned
here. That is the whole point of the bus: this class, the signal poller, the
Debug console and every job would otherwise each open /dev/ttyUSB* for
themselves, and two owners produce "device reports readiness to read but
returned no data" — the error this rig hit when a connect and a modem check
overlapped.

Response parsing moved to parse.py, where it is covered by tests instead of
being discovered on hardware.

Original description follows.

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

from .. import utils
from . import parse
from .bus import AtError as _AtError, P_HIGH as _P_HIGH

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
    def __init__(self, modem_cfg, platform=None, bus=None):
        self.cfg = modem_cfg or {}
        # OS provider (OpenWRT/Linux) for the IP-PDU data session + DHCP/route.
        # Imported lazily so tests can construct a ModemManager without one.
        if platform is None:
            from ..platform import get_platform
            platform = get_platform()
        self.platform = platform
        self.device = self.cfg.get("device")
        self.wwan = self.cfg.get("wwan_interface", "wwan0")
        self.cid = self.cfg.get("cid", 1)
        self.baud = self.cfg.get("baud_rate", 115200)
        self.qmi_device = self.cfg.get("qmi_device", "/dev/cdc-wdm0")

        # The shared AT broker. Created here if the caller did not supply one,
        # so a bare ModemManager still works in tests.
        if bus is None:
            from .bus import ModemBus
            bus = ModemBus(config=self.cfg)
        self.bus = bus
        # Set by the controller once the BearerManager exists. When present it
        # owns the data call; see _attach_ip.
        self.bearer = None

        self.registered = False
        self.pdu_active = False
        self.mode = None
        self.pci = None
        self.cellid = None
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

    # -- AT access ----------------------------------------------------------
    # These delegate to the shared bus. They keep the old names and shapes so
    # the connect path below is unchanged, but there is no serial handle here
    # any more.

    def _open(self):
        """No-op: the bus opens the port on demand and closes it when idle."""
        if self.bus is None:
            raise ModemError("modem bus not available")

    def _close(self):
        """No-op: port lifetime belongs to the bus."""

    def _at(self, cmd, timeout=5):
        """Send one AT command through the bus. Raises ModemError."""
        if self.bus is None:
            raise ModemError("modem bus not available")
        try:
            return self.bus.command(cmd, timeout=timeout, priority=_P_HIGH,
                                    reason="manager")
        except _AtError as exc:
            raise ModemError(str(exc)) from exc

    def _at_script(self, cmds, timeout=5):
        """Several commands as one indivisible turn, so nothing interleaves."""
        if self.bus is None:
            raise ModemError("modem bus not available")
        try:
            return self.bus.script(cmds, timeout=timeout, priority=_P_HIGH,
                                   stop_on_error=False, reason="manager")
        except _AtError as exc:
            raise ModemError(str(exc)) from exc

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
        """Read serving-cell and signal metrics. Never raises.

        Uses try_command so a signal poll cannot queue behind a four-minute
        network scan; a skipped read is reported as stale rather than being
        served from a stale cache without saying so.
        """
        if self.bus is None:
            return self.signal
        lines = self.bus.try_command('AT+QENG="servingcell"', timeout=6,
                                     reason="signal")
        if lines is None:
            self.signal["stale"] = True
            return self.signal

        cell = parse.qeng(lines)
        if cell["rsrp"] is not None:
            self.signal.update({"rsrp": cell["rsrp"], "rsrq": cell["rsrq"],
                                "sinr": cell["sinr"]})
            self.rat = cell["rat"]
            self.band = cell["band"]
            self.arfcn = cell["arfcn"]
            self.pci = cell["pci"]
            self.cellid = cell["cellid"]

        csq_lines = self.bus.try_command("AT+CSQ", timeout=4, reason="signal")
        if csq_lines is not None:
            rssi = parse.csq(csq_lines)["rssi"]
            if rssi is not None:
                self.signal["rssi"] = rssi

        self.signal["stale"] = False
        self.signal["ts"] = time.time()
        return self.signal

    def branches(self, wait=False):
        """Per-antenna RSRP/RSRQ/SINR. All branches at -140 means no RF.

        `wait` decides what happens when the bus is busy. The background poller
        passes False and skips, so it cannot queue behind a four-minute scan.
        A user pressing "Sample now" passes True and waits, because returning
        nothing to someone who asked a direct question is worse than being slow.
        """
        if self.bus is None:
            return {}
        out = {}
        for cmd, key, fn in (("AT+QRSRP", "rsrp", parse.qrsrp),
                             ("AT+QRSRQ", "rsrq", parse.qrsrq),
                             ("AT+QSINR", "sinr", parse.qsinr)):
            if wait:
                try:
                    lines = self.bus.command(cmd, timeout=6, priority=_P_HIGH,
                                             reason="branches")
                except _AtError:
                    lines = None
            else:
                lines = self.bus.try_command(cmd, timeout=5, reason="branches")
            out[key] = fn(lines) if lines is not None else None
        return out

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
        """Define the PDP context, then hand the data call to the bearer.

        The context definition is plain AT and identical everywhere. The data
        call is NOT delegated to the platform provider any more on Linux:
        platform.bring_up_ip_pdu derives the prefix from the QMI netmask and
        produces 10.45.0.6/30 with no gateway or UE-pool route, which is bug
        B3. wwan0 is point-to-point raw-IP with no on-link subnet, so that form
        reaches the core only by accident.

        Worse, both paths were live at once: a bearer.up job would apply the
        correct /32 form and a bearer.connect job eight seconds later would
        overwrite it with the /30 one. One owner now — BearerManager, which is
        a transcription of docs/reference/ue_qmi_up.sh.

        The platform provider is still used on OpenWRT, where netifd owns
        addressing and this code should not.
        """
        self._at(f'AT+CGDCONT={self.cid},"IPV4V6","{dnn}"')

        if self.bearer is not None:
            result = self.bearer.up(apn=dnn)
            self.ipv4 = result.get("ipv4") or self._read_ipv4()
            logger.info("IP PDU up via bearer (ip=%s gw=%s mtu=%s)",
                        self.ipv4, result.get("gateway"), result.get("mtu"))
            return

        result = self.platform.bring_up_ip_pdu(self.wwan, dnn, self.qmi_device,
                                               cid=self.cid)
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
            self._at(f"AT+CGACT=0,{self.cid}", timeout=10)
        except ModemError as exc:
            # The port may already be gone (reset, unplug). Detaching is
            # best-effort by design; the QMI teardown above is what matters.
            logger.debug("detach CGACT failed: %s", exc)
        self.pdu_active = False
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
