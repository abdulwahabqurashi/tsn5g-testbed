"""
Quectel RM520N-GL modem manager for Ethernet PDU sessions.

AT command sequence:
  ATE0 → AT+CPIN? → AT+C5GREG? → AT+CGDCONT → AT+CGACT

QMI data format set via qmicli for raw Ethernet frames on wwan0.
"""

import logging
import subprocess
import time

import serial

from .constants import (
    MODEM_BAUD_RATE,
    MODEM_TIMEOUT,
    MODEM_INIT_RETRY_INTERVAL,
    MODEM_MAX_INIT_RETRIES,
    REG_CHECK_INTERVAL,
)

logger = logging.getLogger("ds-tt.modem")


class ModemManager:
    """Manages the Quectel RM520N-GL 5G modem for Ethernet PDU sessions."""

    def __init__(self, config):
        self.device = config["device"]
        self.wwan_iface = config["wwan_interface"]
        self.dnn = config["dnn"]
        self.cid = config["cid"]
        self.ethernet_mode = config.get("ethernet_mode", True)
        self.baud_rate = config.get("baud_rate", MODEM_BAUD_RATE)

        self._serial = None
        self._registered = False
        self._pdu_active = False
        self._mac_address = None
        self._signal_info = {}

    @property
    def is_registered(self):
        return self._registered

    @property
    def is_pdu_active(self):
        return self._pdu_active

    @property
    def mac_address(self):
        return self._mac_address

    @property
    def signal_info(self):
        return self._signal_info

    def open(self):
        """Open serial port to modem."""
        logger.info("Opening modem at %s (baud=%d)", self.device, self.baud_rate)
        self._serial = serial.Serial(
            self.device,
            baudrate=self.baud_rate,
            timeout=MODEM_TIMEOUT,
        )
        # Disable echo
        self._at_command("ATE0")
        logger.info("Modem serial port opened")

    def close(self):
        """Close serial port."""
        if self._serial and self._serial.is_open:
            self._serial.close()
            logger.info("Modem serial port closed")

    def initialize(self):
        """Full modem initialization sequence."""
        self.open()
        self._check_sim()
        self._wait_for_registration()
        self._read_mac_address()
        if self.ethernet_mode:
            self._configure_ethernet_pdu()
            self._set_qmi_data_format()
            self._activate_pdu()
        self._read_signal_info()

    def _at_command(self, cmd, timeout=None):
        """Send AT command and return response lines."""
        if not self._serial or not self._serial.is_open:
            raise RuntimeError("Modem serial port not open")

        old_timeout = self._serial.timeout
        if timeout is not None:
            self._serial.timeout = timeout

        # Flush input buffer
        self._serial.reset_input_buffer()

        # Send command
        self._serial.write((cmd + "\r\n").encode())
        logger.debug("AT> %s", cmd)

        # Read response until OK, ERROR, or timeout
        lines = []
        while True:
            line = self._serial.readline().decode(errors="replace").strip()
            if not line:
                continue
            logger.debug("AT< %s", line)
            lines.append(line)
            if line in ("OK", "ERROR") or line.startswith("+CME ERROR"):
                break

        if timeout is not None:
            self._serial.timeout = old_timeout

        return lines

    def _check_response_ok(self, lines):
        """Check if AT response ends with OK."""
        return lines and lines[-1] == "OK"

    def _check_sim(self):
        """Check SIM card is ready."""
        for attempt in range(MODEM_MAX_INIT_RETRIES):
            resp = self._at_command("AT+CPIN?")
            for line in resp:
                if "+CPIN: READY" in line:
                    logger.info("SIM card ready")
                    return
            logger.warning("SIM not ready (attempt %d/%d)",
                           attempt + 1, MODEM_MAX_INIT_RETRIES)
            time.sleep(MODEM_INIT_RETRY_INTERVAL)
        raise RuntimeError("SIM card not ready after max retries")

    def _wait_for_registration(self):
        """Wait for 5G NR registration."""
        logger.info("Waiting for 5G registration...")
        for attempt in range(MODEM_MAX_INIT_RETRIES):
            resp = self._at_command("AT+C5GREG?")
            for line in resp:
                if "+C5GREG:" in line:
                    parts = line.split(",")
                    if len(parts) >= 2:
                        stat = parts[0].split(":")[-1].strip().rstrip(",")
                        # stat=1 (home) or stat=5 (roaming)
                        if stat in ("1", "5"):
                            self._registered = True
                            logger.info("5G NR registered (stat=%s)", stat)
                            return
            logger.info("Not yet registered (attempt %d/%d)",
                        attempt + 1, MODEM_MAX_INIT_RETRIES)
            time.sleep(REG_CHECK_INTERVAL)
        raise RuntimeError("5G registration failed after max retries")

    def _read_mac_address(self):
        """Read DS-TT MAC address from wwan interface."""
        try:
            with open(f"/sys/class/net/{self.wwan_iface}/address", "r") as f:
                self._mac_address = f.read().strip()
            logger.info("DS-TT MAC address: %s", self._mac_address)
        except FileNotFoundError:
            logger.warning("Cannot read MAC from %s — interface may not exist yet",
                           self.wwan_iface)

    def _configure_ethernet_pdu(self):
        """Configure Ethernet PDU session via AT+CGDCONT."""
        cmd = f'AT+CGDCONT={self.cid},"Ethernet","{self.dnn}"'
        resp = self._at_command(cmd)
        if not self._check_response_ok(resp):
            raise RuntimeError(f"Failed to configure Ethernet PDU: {resp}")
        logger.info("Configured Ethernet PDU: CID=%d, DNN=%s", self.cid, self.dnn)

    def _set_qmi_data_format(self):
        """Set QMI data format for raw Ethernet frames on wwan interface."""
        try:
            # Set link-layer-protocol to 802-3 for Ethernet frames
            result = subprocess.run(
                [
                    "qmicli",
                    f"--device=/dev/cdc-wdm0",
                    "--device-open-proxy",
                    "--wda-set-data-format="
                    "link-layer-protocol=802-3,"
                    "ul-protocol=qmap-v5,"
                    "dl-protocol=qmap-v5"
                ],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                logger.info("QMI data format set to 802-3 (Ethernet)")
            else:
                logger.warning("qmicli set data format failed: %s", result.stderr)
        except FileNotFoundError:
            logger.warning("qmicli not found — skipping QMI data format setup")
        except subprocess.TimeoutExpired:
            logger.warning("qmicli timed out")

    def _activate_pdu(self):
        """Activate the PDU session."""
        resp = self._at_command(f"AT+CGACT=1,{self.cid}", timeout=30)
        if self._check_response_ok(resp):
            self._pdu_active = True
            logger.info("PDU session activated (CID=%d)", self.cid)
        else:
            # Check if already active
            resp = self._at_command(f"AT+CGACT?")
            for line in resp:
                if f"+CGACT: {self.cid},1" in line:
                    self._pdu_active = True
                    logger.info("PDU session already active (CID=%d)", self.cid)
                    return
            raise RuntimeError(f"Failed to activate PDU session: {resp}")

    def _read_signal_info(self):
        """Read signal quality information."""
        self._signal_info = {}

        # RSRP, RSRQ, SINR via AT+QENG="servingcell"
        resp = self._at_command('AT+QENG="servingcell"')
        for line in resp:
            if "+QENG:" in line:
                self._signal_info["raw"] = line
                parts = line.split(",")
                # Parse NR5G-SA serving cell info
                if "NR5G-SA" in line and len(parts) >= 15:
                    try:
                        self._signal_info["rsrp"] = int(parts[12])
                        self._signal_info["rsrq"] = int(parts[13])
                        self._signal_info["sinr"] = int(parts[14])
                    except (ValueError, IndexError):
                        pass

        # Basic signal quality
        resp = self._at_command("AT+CSQ")
        for line in resp:
            if "+CSQ:" in line:
                parts = line.split(":")[1].strip().split(",")
                if len(parts) >= 2:
                    try:
                        rssi_raw = int(parts[0])
                        if rssi_raw < 99:
                            self._signal_info["rssi_dbm"] = -113 + 2 * rssi_raw
                    except ValueError:
                        pass

        logger.info("Signal info: %s", self._signal_info)

    def refresh_signal(self):
        """Refresh signal quality info."""
        self._read_signal_info()

    def get_status(self):
        """Return modem status dict for API."""
        return {
            "device": self.device,
            "wwan_interface": self.wwan_iface,
            "dnn": self.dnn,
            "cid": self.cid,
            "registered": self._registered,
            "pdu_active": self._pdu_active,
            "mac_address": self._mac_address,
            "signal": self._signal_info,
        }

    def check_health(self):
        """Quick health check — verify modem is responsive."""
        try:
            resp = self._at_command("AT")
            return self._check_response_ok(resp)
        except Exception as e:
            logger.error("Modem health check failed: %s", e)
            return False
