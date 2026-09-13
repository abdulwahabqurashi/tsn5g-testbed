"""
qmicli wrapper.

Two corrections over the previous implementation, both taken from
docs/reference/ue_qmi_up.sh, which is the procedure that actually works on this
rig:

**`--device-open-proxy` on every call.** Without the proxy, concurrent qmicli
invocations fight over /dev/cdc-wdm0. The reference script uses it everywhere.

**The packet-data handle and CID are persisted.** A session started with
`--client-no-release-cid` — which is mandatory, or the data call collapses the
moment qmicli exits — can only be stopped by quoting the handle and CID it was
started with. The old teardown called `--wds-stop-network=disable-autoconnect`,
which does not do that, so `disconnect()` left the data call alive inside the
modem and the next connect could collide with it.

State lives in /run (RuntimeDirectory=tsn5g-ue), not /var/lib: it describes a
data call that does not survive a reboot, so neither should it.
"""

import json
import logging
import os
import re

from .. import utils

logger = logging.getLogger("tsn5g-ue.modem.qmi")

DEFAULT_STATE = "/run/tsn5g-ue/bearer.json"

# ue_qmi_up.sh records the packet data handle here. The console adopts it when
# it has no handle of its own, so a bearer either tool started can be stopped
# by either tool.
SCRIPT_STATE = "/run/ue_qmi_up.state"


class QmiError(RuntimeError):
    pass


def _field(text, label):
    """Pull `Label: 'value'` out of qmicli's human-readable output."""
    m = re.search(rf"{re.escape(label)}\s*:\s*'?([^'\n]+)'?", text)
    return m.group(1).strip() if m else None


class QmiClient:
    def __init__(self, device=None, state_path=DEFAULT_STATE, audit=None):
        self.device = device
        self.state_path = state_path

    # -- plumbing -----------------------------------------------------------
    def _run(self, *args, timeout=45, check=True):
        if not self.device:
            raise QmiError("no QMI control device (looked for /dev/cdc-wdm*)")
        cmd = ["qmicli", "-d", self.device, "--device-open-proxy", *args]
        proc = utils.run(cmd, check=False, timeout=timeout)
        if check and proc.returncode != 0:
            raise QmiError((proc.stderr or proc.stdout or "qmicli failed").strip())
        return proc.stdout

    # -- state --------------------------------------------------------------
    def load_state(self):
        try:
            with open(self.state_path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return self._adopt_script_state()

    def _adopt_script_state(self):
        """Fall back to the handle ue_qmi_up.sh recorded.

        The two tools share this rig, and a bearer the script brought up is a
        perfectly real bearer — but without its handle the console could only
        flush the interface, leaving the session alive inside the modem with
        no way to stop it. The file is `PDH=...` / `CID=...` shell assignments.
        """
        try:
            with open(SCRIPT_STATE, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except OSError:
            return {}
        out = {}
        for line in raw.splitlines():
            key, _, value = line.partition("=")
            key, value = key.strip().lower(), value.strip()
            if key in ("pdh", "cid") and value:
                out[key] = value
        if out:
            out["adopted_from"] = SCRIPT_STATE
            logger.info("adopted data handle %s (cid %s) from %s",
                        out.get("pdh"), out.get("cid"), SCRIPT_STATE)
        return out

    def save_state(self, data):
        try:
            os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
            tmp = f"{self.state_path}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp, self.state_path)
        except OSError as exc:
            logger.warning("could not persist bearer state: %s", exc)

    def clear_state(self):
        for path in (self.state_path, SCRIPT_STATE):
            try:
                os.unlink(path)
            except OSError:
                pass

    # -- device -------------------------------------------------------------
    def operating_mode(self):
        out = self._run("--dms-get-operating-mode")
        return (_field(out, "Mode") or "").lower() or None

    def set_operating_mode(self, mode):
        """mode: 'online' | 'low-power' | 'offline'"""
        self._run(f"--dms-set-operating-mode={mode}")
        return {"mode": mode}

    def serving_system(self):
        out = self._run("--nas-get-serving-system", check=False)
        state = _field(out, "Registration state")
        return {
            "registration_state": state,
            "registered": (state or "").lower() == "registered",
            "operator": _field(out, "Description"),
            "plmn": _field(out, "MCC"),
            "raw": out.strip() or None,
        }

    def signal_info(self):
        out = self._run("--nas-get-signal-info", check=False)
        def num(label):
            v = _field(out, label)
            if v is None:
                return None
            m = re.search(r"-?\d+", v)
            return int(m.group(0)) if m else None
        return {"rsrp": num("RSRP"), "rsrq": num("RSRQ"),
                "snr": num("SNR"), "rssi": num("RSSI"), "raw": out.strip() or None}

    def packet_service_status(self):
        out = self._run("--wds-get-packet-service-status", check=False)
        return {"status": _field(out, "Connection status"), "raw": out.strip() or None}

    # -- the data call ------------------------------------------------------
    def start_network(self, apn, ip_type=4):
        """Start the session and persist the handle needed to stop it.

        `--client-no-release-cid` is required: without it qmicli releases the
        client as it exits and the data call collapses immediately.
        """
        out = self._run(
            f"--wds-start-network=apn={apn},ip-type={ip_type}",
            "--client-no-release-cid", timeout=90)
        pdh = _field(out, "Packet data handle")
        cid = _field(out, "CID")
        if not pdh:
            m = re.search(r"handle\s*'?(\w+)'?", out, re.I)
            pdh = m.group(1) if m else None
        if not pdh:
            raise QmiError(f"could not read the packet data handle from: {out.strip()[:200]}")
        state = {"pdh": pdh, "cid": cid, "apn": apn, "ip_type": ip_type}
        self.save_state(state)
        logger.info("data call up: pdh=%s cid=%s apn=%s", pdh, cid, apn)
        return state

    def current_settings(self):
        out = self._run("--wds-get-current-settings", timeout=30)
        mtu = _field(out, "MTU")
        return {
            "ipv4": _field(out, "IPv4 address"),
            "gateway": _field(out, "IPv4 gateway address"),
            "netmask": _field(out, "IPv4 subnet mask"),
            "dns1": _field(out, "IPv4 primary DNS"),
            "dns2": _field(out, "IPv4 secondary DNS"),
            "mtu": int(mtu) if mtu and mtu.isdigit() else None,
            "raw": out.strip() or None,
        }

    def stop_network(self, pdh=None, cid=None):
        """Stop the session using the saved handle, as ue_qmi_up.sh does."""
        state = self.load_state()
        pdh = pdh or state.get("pdh")
        cid = cid or state.get("cid")
        if not pdh:
            # Nothing recorded. Ask the modem to drop any autoconnect session
            # rather than silently claiming success.
            self._run("--wds-stop-network=disable-autoconnect", check=False)
            self.clear_state()
            return {"stopped": False, "reason": "no saved packet data handle"}
        args = [f"--wds-stop-network={pdh}"]
        if cid:
            args.append(f"--client-cid={cid}")
        self._run(*args, check=False, timeout=45)
        self.clear_state()
        logger.info("data call stopped (pdh=%s cid=%s)", pdh, cid)
        return {"stopped": True, "pdh": pdh, "cid": cid}

    # -- read model ---------------------------------------------------------
    def status(self):
        state = self.load_state()
        return {
            "device": self.device,
            "pdh": state.get("pdh"),
            "cid": state.get("cid"),
            "apn": state.get("apn"),
            "state_file": self.state_path,
            "available": bool(self.device) and utils.have("qmicli"),
        }
