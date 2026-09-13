"""
Controller — owns the lifecycle state and the individual setup steps that the
guided UI drives one at a time:

  1. modem_check()      — verify SIM / registration / signal (non-destructive)
  2. transport_start()  — activate PDU session + build VXLAN/Ethernet data path
  3. gptp_start()       — start ptp4l/phc2sys and wait for lock
  4. tas_apply()        — apply the DS-TT 802.1Qbv schedule (taprio)
  5. switch apply       — push the schedule to the wired FS TSN3220

connect() runs 1-3 in sequence for the one-click path; the guided page calls each
step on its own. Thread-safe.
"""

import logging
import threading

from . import constants as C
from .config import Config, StateStore
from .discovery import Discovery
from .gptp import GptpManager
from .modem import ModemManager
from .modem.bus import ModemBus
from .modem.power import PowerControl
from .modem.qmi import QmiClient
from .modem.radio import RadioControl
from .modem.signal import SignalPoller
from .net.bearer import BearerManager
from .net.routing import RoutingManager
from .net.iface import NetIfaceManager
from .platform import get_platform
from .speedtest import SpeedTest
from .switch import SwitchManager
from .tas import TasManager
from .transport import make_transport

logger = logging.getLogger("tsn5g-ue.controller")


class Controller:
    def __init__(self, config: Config, events=None, store=None, audit=None):
        self.config = config
        self.state_store = StateStore(config.state_file)
        self.state = C.STATE_INITIALIZING
        self.step = None
        self.last_error = None
        self.active_mode = None

        # One OS provider (OpenWRT | Linux), auto-detected or forced by config,
        # shared by every manager that touches OS-specific network/modem state.
        self.platform = get_platform(config)
        self.discovery = Discovery(config, platform=self.platform)
        # One AT broker shared by the manager, the signal poller, the jobs and
        # the Debug console. Anything that opens /dev/ttyUSB* for itself
        # reintroduces the contention this exists to remove.
        self.bus = ModemBus(config=config.modem, audit=audit, events=events)
        self.modem = ModemManager(config.modem, platform=self.platform,
                                  bus=self.bus)
        self.qmi = QmiClient(device=self.bus.ports().get("qmi")
                             or config.modem.get("qmi_device"))
        self.power = PowerControl(self.bus, events=events)
        self.radio = RadioControl(self.bus, events=events)
        self.signal_poller = SignalPoller(self.modem, self.bus, events=events,
                                          store=store)
        self.bearer = BearerManager(config, self.qmi, modem=self.modem,
                                    events=events)
        # One owner for the data call. Without this the legacy connect path
        # would re-apply the /30 form over the bearer's /32.
        self.modem.bearer = self.bearer
        self.routing = RoutingManager()
        # The UE address changes on every data call, so policy routing has to
        # be put back afterwards or it silently stops matching.
        self.bearer.on_change = self._on_bearer_change
        self.identity = None
        self.transport = None
        self.gptp = GptpManager(config.gptp, config.hw_timestamp_interfaces())
        self.switch = SwitchManager(config.switch)
        self.tas = TasManager(config.as_dict().get("tas", {}))
        self.speedtest = SpeedTest(config.as_dict().get("speedtest", {}))
        self.netiface = NetIfaceManager(
            {"wwan_interface": config.modem.get("wwan_interface", "wwan0")},
            platform=self.platform)
        self._lock = threading.RLock()

    # ------------------------------------------------------------- lifecycle
    def start(self):
        self.state = C.STATE_IDLE
        logger.info("controller ready — state=%s", self.state)
        self.resume()

    def _on_bearer_change(self, state):
        """Called after every successful bring-up."""
        try:
            if self.routing.status().get("applied"):
                logger.info("bearer address is now %s — re-applying routing",
                            state.get("ipv4"))
                self.routing.reapply_after_bearer_change()
        except Exception as exc:            # noqa: BLE001
            logger.warning("could not re-apply routing after the bearer "
                           "changed: %s", exc)

    def resume(self):
        last = self.state_store.load()
        if last.get("connected"):
            logger.info("auto-resume: %s", last)
            try:
                self.connect(mode=last.get("mode"), dnn=last.get("dnn"),
                             wired_nics=last.get("wired_nics"), role=last.get("role"),
                             persist=False)
            except Exception as exc:  # noqa: BLE001
                logger.error("auto-resume failed: %s", exc)

    # ------------------------------------------------------------- step 1
    def modem_check(self):
        return self.modem.check()

    # ------------------------------------------------------------- step 2
    def transport_start(self, mode=None, dnn=None, wired_nics=None, role=None,
                        vlan_map=None, persist=True):
        # A user-edited VLAN→PCP→DSCP map drives both the VXLAN overlay and the
        # switch flow classifiers, so PCP is configured as part of this step.
        if vlan_map:
            self.config.update({"vxlan": {"vlan_map": vlan_map}})
            self.switch.flows = self.switch.flows_from_vlan_map(vlan_map)
        with self._lock:
            mode = mode or self.config.transport_mode
            self.state = C.STATE_CONNECTING
            self.last_error = None
        try:
            self.step = C.STEP_MODEM
            self.modem.attach(mode=mode, dnn=dnn or self.config.modem.get("dnn"))
            self.step = C.STEP_TRANSPORT
            self.transport = make_transport(mode, self.config, self.modem)
            self.active_mode = mode
            wired = wired_nics or self.config.tsn_interfaces()
            self.transport.start(wired_nics=wired, role=role)
            self.step = C.STEP_LLDP
            self.transport.enable_lldp_forwarding()
            self.step = C.STEP_DONE
            with self._lock:
                self.state = C.STATE_RUNNING
            if persist:
                self.state_store.save({"connected": True, "mode": mode, "dnn": dnn,
                                       "wired_nics": wired_nics, "role": role})
            return self.transport.get_status()
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            self.state = C.STATE_ERROR
            logger.error("transport_start failed at %s: %s", self.step, exc)
            raise

    def transport_stop(self):
        if self.transport:
            self.transport.stop()
            self.transport = None
        self.active_mode = None
        self.state_store.save({"connected": False})
        return {"ok": True}

    # ------------------------------------------------------------- step 3
    def gptp_start(self, iface=None):
        self.gptp.start(iface=iface)
        return self.gptp.get_status()

    def gptp_stop(self):
        self.gptp.stop()
        return {"ok": True}

    # ------------------------------------------------------------- step 4
    def tas_apply(self, iface=None, profile=None, slots=None, cycle_ns=None, dry_run=False):
        iface = iface or self._egress_iface()
        return self.tas.apply(iface, profile=profile, slots=slots,
                              cycle_ns=cycle_ns, dry_run=dry_run)

    def tas_clear(self, iface=None):
        return self.tas.clear(iface or self._egress_iface())

    def _egress_iface(self):
        hw = self.config.hw_timestamp_interfaces()
        if hw:
            return hw[0]
        nics = self.config.tsn_interfaces()
        return nics[0] if nics else None

    # ------------------------------------------------------------- run-all
    def connect(self, mode=None, dnn=None, wired_nics=None, role=None, persist=True):
        self.transport_start(mode=mode, dnn=dnn, wired_nics=wired_nics, role=role, persist=persist)
        self.step = C.STEP_GPTP
        if self.config.gptp.get("enabled", True):
            self.gptp_start()
        self.step = C.STEP_DONE
        self.state = C.STATE_RUNNING

    def disconnect(self):
        self.state = C.STATE_STOPPING
        try:
            self.gptp.stop()
            for nic in self.config.hw_timestamp_interfaces():
                self.tas.clear(nic)
            if self.transport:
                self.transport.stop()
            self.modem.detach()
        finally:
            self.transport = None
            self.active_mode = None
            self.state = C.STATE_IDLE
            self.state_store.save({"connected": False})
        return {"ok": True}

    # ------------------------------------------------------------- switch
    def switch_profiles(self):
        return self.switch.list_profiles()

    def apply_switch_profile(self, host, user, password, profile, ports, dry_run=False):
        return self.switch.apply_profile(host=host, user=user, password=password,
                                         profile=profile, ports=ports, dry_run=dry_run)

    def apply_switch_custom(self, host, user, password, slots, cycle_ns, ports,
                            guard=True, dry_run=False):
        return self.switch.apply_custom(host=host, user=user, password=password,
                                        slots=slots, cycle_ns=cycle_ns, ports=ports,
                                        guard=guard, dry_run=dry_run)

    def disable_switch(self, host, user, password, ports):
        return self.switch.disable(host=host, user=user, password=password, ports=ports)

    # ------------------------------------------------------------- speed test
    def speedtest_start(self, server=None):
        # Pin the test to the 5G link so it measures the modem path, never the
        # wired management interface.
        return self.speedtest.start(
            server=server,
            bind_ip=self.modem.ipv4 if self.modem else None,
            bind_iface=self.modem.wwan if self.modem else None)

    def speedtest_status(self):
        return self.speedtest.status()

    # ------------------------------------------------------------- interfaces
    def interfaces(self):
        return self.netiface.list_interfaces()

    def set_interface_ip(self, iface, method, address=None, gateway=None):
        return self.netiface.set_ip(iface, method, address=address, gateway=gateway)

    def wifi_scan(self):
        return self.netiface.wifi_scan()

    def wifi_connect(self, ssid, psk=None):
        return self.netiface.wifi_connect(ssid, psk=psk)

    def switch_status(self, host, user, password, ports):
        return self.switch.status(host=host, user=user, password=password, ports=ports)

    # ------------------------------------------------------------- read models
    def snapshot(self):
        return {"state": self.state, "step": self.step, "active_mode": self.active_mode,
                "last_error": self.last_error,
                "modem": self.modem.get_status() if self.modem else None,
                "transport": self.transport.get_status() if self.transport else None,
                "gptp": self.gptp.get_status() if self.gptp else None,
                "tas": self.tas.get_status() if self.tas else None}

    def health(self):
        checks = {"modem": self.modem.check_health() if self.modem else False,
                  "transport": self.transport.check_health() if self.transport else False,
                  "gptp": self.gptp.check_health() if self.gptp else True}
        return {"healthy": all(checks.values()), "checks": checks, "state": self.state}

    def setup_state(self):
        """Per-step status for the guided-setup timeline."""
        m = self.modem.get_status()
        g = self.gptp.get_status()
        tas = self.tas.get_status()
        return {
            "modem": {"ok": bool(m.get("registered")), "registered": m.get("registered"),
                      "sim_ready": m.get("sim_ready"), "pdu_active": m.get("pdu_active"),
                      "signal": m.get("signal"), "operator": m.get("operator")},
            "transport": {"ok": bool(self.transport), "mode": self.active_mode},
            "gptp": {"ok": bool(g.get("locked")), "running": g.get("running"),
                     "locked": g.get("locked"), "offset_ns": g.get("offset_ns")},
            "tas": {"ok": bool(tas.get("applied")), "applied": tas.get("applied")},
            "switch": {"ok": None, "host": self.config.switch.get("host")},
        }
