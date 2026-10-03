"""
The 5G data call, transcribed from docs/reference/ue_qmi_up.sh.

That script is the procedure that actually works on this rig, and this is a
faithful port of it — same six steps, same commands, same order. The previous
implementation in platform/linux.py differed in three ways that mattered:

**Addressing.** It derived a prefix from the QMI netmask, producing
`10.45.0.6/30`. The script uses `/32` plus two explicit routes, because wwan0
is a point-to-point raw-IP interface with no on-link subnet: the gateway is
reachable only via an explicit host route, and the UE pool only via an explicit
network route. The `/30` form happens to work for neighbours inside it and
silently fails for everything else — including 10.45.0.1, the core.

**Teardown.** It called `--wds-stop-network=disable-autoconnect`, which cannot
stop a session started with `--client-no-release-cid`. The handle and CID have
to be quoted back, so disconnect() left the call alive inside the modem and the
next connect could collide with it.

**Pre-flight.** It had none. The script refuses to start unless the radio is
online and the UE is registered, because otherwise the failure surfaces later
as an empty settings read, which is much harder to interpret.

Why this lives in the daemon rather than shelling out to the script: the script
runs `systemctl stop tsn5g-ue` on the way in, so calling it from the daemon
would kill the daemon. It also calls at.py, which takes the serial port
exclusively — the contention ModemBus exists to remove.
"""

import logging
import re
import time

from .. import utils
from . import lanes, qdisc
from ..modem.qmi import QmiError

logger = logging.getLogger("tsn5g-ue.bearer")

# The step names the UI renders. Identical to the script's "N/5" headings, plus
# an explicit pre-flight, so the two can be read side by side.
STEPS = ["preflight", "prepare-iface", "start-network", "read-settings",
         "configure-iface", "verify"]

DEFAULT_APN = "usrptsn"
DEFAULT_UE_POOL = "10.45.0.0/16"
SETTINGS_ATTEMPTS = 6
SETTINGS_INTERVAL = 2.0


class BearerError(RuntimeError):
    pass


class BearerManager:
    def __init__(self, config, qmi, modem=None, events=None):
        cfg = config.modem if hasattr(config, "modem") else (config or {})
        self.iface = cfg.get("wwan_interface", "wwan0")
        self.apn = cfg.get("dnn") or DEFAULT_APN
        self.ue_pool = cfg.get("ue_subnet", DEFAULT_UE_POOL)
        # Something on the far side that does answer ICMP. The QMI gateway is a
        # point-to-point peer and often does not.
        vx = config.vxlan if hasattr(config, "vxlan") else {}
        self.probe_target = (vx or {}).get("core_ip") or cfg.get("probe_target")
        # The egress queue on the bearer. Stated policy rather than the
        # system default — see net/qdisc.py for why the default actively
        # cancels prioritisation rather than merely diluting it.
        q = cfg.get("egress_queue") or {}
        self.queue_policy = q.get("policy", qdisc.SHALLOW)
        self.queue_limit = int(q.get("limit", qdisc.DEFAULT_LIMIT))
        self.queue_priomap = q.get("priomap")
        # Only read by the `limited` policy. Kept beside the others rather than
        # inside it because a rate cap that silently fell back to a default is
        # the failure this whole module is written against.
        self.queue_be_mbps = int(q.get("be_mbps", qdisc.DEFAULT_BE_MBPS))
        self.queue_link_mbps = int(q.get("link_mbps", qdisc.DEFAULT_LINK_MBPS))
        # Auto-rate keeps the lanes' total just under the radio's capacity, so
        # the queue (and with it the priority decision) stays on the UE. Its
        # settings live at modem.autorate, not inside egress_queue, because the
        # queue API rewrites egress_queue wholesale.
        from .autorate import AutoRate
        self.autorate = AutoRate(self, cfg.get("autorate"))
        # Which stream goes in which lane. Applied beside the queue itself so
        # the two halves cannot drift apart — lanes with nothing steered into
        # them are a single FIFO with extra steps, and that failure is silent.
        self.egress_classes = cfg.get("egress_classes") or []
        self.qmi = qmi
        self.modem = modem
        self.events = events
        # Set by the controller. `stats` gets its probe retargeted on every
        # bring-up; `on_change` is where routing re-applies itself.
        self.stats = None
        self.on_change = None
        self._settings = {}

    # -- read model ---------------------------------------------------------
    def status(self):
        addr = self._current_address()
        state = self.qmi.load_state()
        # _settings is in-memory, so a daemon restart loses it and a healthy
        # bearer reports no gateway or MTU. Re-read from QMI when the link is
        # up but we have nothing recorded.
        # Gated on a recorded pdh before, which meant a session the daemon did
        # not start (ue_qmi_up.sh, or a bearer that outlived a reinstall) never
        # reported a gateway, MTU or DNS at all. The link being up is the right
        # condition; QMI can answer without our saved handle.
        if addr and not self._settings:
            try:
                self._settings = self.qmi.current_settings() or {}
            except Exception:               # noqa: BLE001 — status must not fail
                pass
        return {
            "interface": self.iface,
            "state": "up" if addr else "down",
            "egress_queue": qdisc.describe(self.iface, self.queue_policy,
                                           self.queue_limit,
                                           be_mbps=self.autorate.effective_be_mbps()),
            # Reported beside the queue, because a mismatch here means the
            # lanes are carrying nothing they were built for.
            "egress_classes": lanes.describe(self.iface, self.egress_classes),
            "ipv4": addr,
            "apn": state.get("apn") or self.apn,
            "pdh": state.get("pdh"),
            "cid": state.get("cid"),
            "gateway": self._settings.get("gateway"),
            # The kernel is authoritative for what is actually configured on
            # the link; QMI only says what was negotiated. Reporting null while
            # `ip link` said 1400 made the UI show a dash for a live value.
            "mtu": self._link_mtu() or self._settings.get("mtu"),
            "dns": [d for d in (self._settings.get("dns1"),
                                self._settings.get("dns2")) if d],
            "routes": self._routes(),
            # Raw-IP wwan interfaces report operstate "unknown" even when the
            # link is carrying traffic, so operstate alone was never a useful
            # answer here. carrier is the flag that actually moves.
            "carrier": self._carrier(),
            "operstate": self._operstate(),
        }

    def _current_address(self):
        proc = utils.run(["ip", "-4", "-o", "addr", "show", self.iface],
                         check=False, timeout=10)
        m = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", proc.stdout or "")
        return m.group(1) if m else None

    def _operstate(self):
        return utils.read_sysfs(f"/sys/class/net/{self.iface}/operstate", "unknown")

    def _carrier(self):
        raw = utils.read_sysfs(f"/sys/class/net/{self.iface}/carrier", None)
        if raw is None or raw == "":
            return "unknown"
        return "up" if raw.strip() == "1" else "down"

    def _link_mtu(self):
        raw = utils.read_sysfs(f"/sys/class/net/{self.iface}/mtu", None)
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None

    def _routes(self):
        proc = utils.run(["ip", "route", "show", "dev", self.iface],
                         check=False, timeout=10)
        return [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]

    # -- bring-up -----------------------------------------------------------
    def up(self, ctx=None, apn=None, ip_type=4, extra_routes=None,
           default_route=False, write_dns=False):
        """Run the six steps. `ctx` is a JobContext when called as a job."""
        apn = apn or self.apn

        def step(name, detail=None):
            if ctx:
                ctx.step(name, detail)
            else:
                logger.info("bearer %s: %s", name, detail or "")

        def say(line):
            if ctx:
                ctx.log(line)
            else:
                logger.info("  %s", line)

        if ctx:
            ctx.plan(STEPS)

        # 1/6 -----------------------------------------------------------------
        step("preflight", "checking the radio is online and the UE is registered")
        self._preflight(say)

        # 2/6 -----------------------------------------------------------------
        step("prepare-iface", f"putting {self.iface} into raw-IP mode")
        self._prepare_interface(say)

        # 3/6 -----------------------------------------------------------------
        step("start-network", f"starting the data call on APN {apn}")
        try:
            session = self.qmi.start_network(apn, ip_type=ip_type)
        except QmiError as exc:
            raise BearerError(f"the data call did not start: {exc}") from exc
        say(f"packet data handle {session['pdh']} (cid {session.get('cid')})")

        # 4/6 -----------------------------------------------------------------
        step("read-settings", "asking the network what it assigned")
        settings = self._read_settings(say)
        self._settings = settings

        # 5/6 -----------------------------------------------------------------
        step("configure-iface", f"applying {settings['ipv4']} to {self.iface}")
        self._configure(settings, say, extra_routes=extra_routes,
                        default_route=default_route, write_dns=write_dns)

        # 6/6 -----------------------------------------------------------------
        step("verify", "checking the data plane")
        reachable = self._verify(settings, say)

        result = self.status()
        result["gateway_reachable"] = reachable

        # Point the dashboard's latency probe at the link we just brought up.
        # StatsCollector.set_link_target() has existed since the beginning and
        # was never called (bug B5), so the probe used whatever vxlan.core_ip
        # said at boot even after the bearer moved.
        self._notify_bearer_change(settings)
        return result

    def _preflight(self, say):
        """Refuse to start when the radio is off or the UE has no cell.

        Without this the failure surfaces two steps later as an empty settings
        read, which says nothing about the cause.
        """
        try:
            mode = self.qmi.operating_mode()
        except QmiError as exc:
            raise BearerError(f"cannot reach the modem over QMI: {exc}") from exc

        if mode and mode != "online":
            raise BearerError(
                f"the radio is '{mode}', not 'online'. Turn it on from the Modem "
                f"view, or: qmicli -d {self.qmi.device} --device-open-proxy "
                f"--dms-set-operating-mode=online")
        say(f"operating mode: {mode or 'unknown'}")

        serving = self.qmi.serving_system()
        if serving.get("registration_state") and not serving.get("registered"):
            raise BearerError(
                f"the UE is not registered (state: {serving['registration_state']}). "
                "The data call cannot start until it camps on the gNB — check the "
                "gNB is transmitting on the configured band and PLMN, and that the "
                "antennas are seated.")
        say(f"registered{' on ' + serving['operator'] if serving.get('operator') else ''}")

        # ModemManager contends for the same devices. Not fatal for QMI, but it
        # is the usual cause of intermittent failures, so say so.
        from ..modem.power import modemmanager_state
        mm = modemmanager_state()
        if mm.get("active"):
            say("WARNING: ModemManager is running and will contend for the modem. "
                "Mask it from the Modem view.")

    def _prepare_interface(self, say):
        """raw_ip must be written while the interface is DOWN."""
        utils.run(["ip", "link", "set", self.iface, "down"], check=False, timeout=15)
        path = f"/sys/class/net/{self.iface}/qmi/raw_ip"
        try:
            with open(path, "w", encoding="ascii") as fh:
                fh.write("Y\n")
            say("raw_ip = Y")
        except OSError as exc:
            # Some driver versions fix this themselves; only a later failure
            # would prove it mattered.
            say(f"could not set raw_ip ({exc}); continuing")
        proc = utils.run(["ip", "link", "set", self.iface, "up"],
                         check=False, timeout=15)
        if proc.returncode != 0:
            raise BearerError(f"could not bring {self.iface} up: "
                              f"{(proc.stderr or '').strip()}")

    def _read_settings(self, say):
        """Poll --wds-get-current-settings until the address appears.

        DHCP does not work on a QMI raw-IP link — there is no server behind it.
        This is the only way the host learns the address, and it is not ready
        the instant the call starts.
        """
        last = {}
        for attempt in range(1, SETTINGS_ATTEMPTS + 1):
            try:
                last = self.qmi.current_settings()
            except QmiError as exc:
                say(f"settings read {attempt}/{SETTINGS_ATTEMPTS} failed: {exc}")
                last = {}
            if last.get("ipv4"):
                say(f"ipv4={last['ipv4']} gw={last.get('gateway')} "
                    f"mtu={last.get('mtu')} dns={last.get('dns1')}")
                return last
            say(f"no address yet ({attempt}/{SETTINGS_ATTEMPTS})")
            time.sleep(SETTINGS_INTERVAL)
        raise BearerError(
            "the call started but the network assigned no IPv4 address. "
            "That usually means the APN was accepted but the session was not "
            "fully established; check the core's SMF logs.")

    def _configure(self, settings, say, extra_routes=None, default_route=False,
                   write_dns=False):
        """Apply the address and routes in the form ue_qmi_up.sh uses.

        /32, not a derived prefix: wwan0 is point-to-point raw-IP with no
        on-link subnet, so the gateway needs an explicit host route and the UE
        pool an explicit network route. Anything else is reachable only by
        accident.
        """
        ip = settings["ipv4"]
        gw = settings.get("gateway")
        mtu = settings.get("mtu")

        utils.run(["ip", "addr", "flush", "dev", self.iface], check=False, timeout=15)
        proc = utils.run(["ip", "addr", "add", f"{ip}/32", "dev", self.iface],
                         check=False, timeout=15)
        if proc.returncode != 0:
            raise BearerError(f"could not add {ip}/32 to {self.iface}: "
                              f"{(proc.stderr or '').strip()}")
        say(f"addr add {ip}/32 dev {self.iface}")

        if mtu:
            utils.run(["ip", "link", "set", self.iface, "mtu", str(mtu)],
                      check=False, timeout=15)
            say(f"mtu {mtu}")

        # The queue goes on here, with the address and the MTU, because it is
        # lost with them. Re-establishing the data call resets the interface to
        # the system default, and a queue that reverted silently is how a
        # correctly configured gate comes to measure nothing.
        try:
            live = qdisc.apply(self.iface, self.queue_policy, self.queue_limit,
                               priomap=self.queue_priomap,
                               be_mbps=self.queue_be_mbps,
                               link_mbps=self.queue_link_mbps)
            say(f"egress queue {self.queue_policy} -> {live['raw']}")
            # A fresh tree carries the static rates; auto-rate re-takes it.
            if self.autorate.cfg.get("enabled"):
                self.autorate.restart()
                say(f"auto-rate: {self.autorate.status().get('reason') or 'running'}")
            # The other half. iptables rules survive a data call but not a
            # reboot, so this is re-asserted here rather than left to a
            # one-shot at startup; it is idempotent and costs a few -C checks.
            if self.egress_classes:
                placed = lanes.apply(self.iface, self.egress_classes)
                for p in placed:
                    say(f"lane {p['name']} udp/{p['dport']} -> {p['classid']}")
                n = lanes.flush_conntrack(self.egress_classes)
                say(f"cleared {n} stale NAT record(s) for the camera streams")
        except (qdisc.QdiscError, lanes.LaneError) as exc:
            # Not fatal: the bearer still carries traffic. But it is loud,
            # because every scheduling result measured from here is suspect.
            say(f"WARNING: egress queue not applied: {exc}")
            logger.warning("egress queue not applied on %s: %s", self.iface, exc)

        if gw:
            utils.run(["ip", "route", "replace", f"{gw}/32", "dev", self.iface],
                      check=False, timeout=15)
            say(f"route replace {gw}/32 dev {self.iface}   (gateway on-link)")

        for net in [self.ue_pool] + list(extra_routes or []):
            if not net:
                continue
            utils.run(["ip", "route", "replace", net, "dev", self.iface],
                      check=False, timeout=15)
            say(f"route replace {net} dev {self.iface}")

        if default_route:
            # Deliberately opt-in: this sends everything, including the SSH
            # session you are reading this over, across the 5G link.
            utils.run(["ip", "route", "replace", "default", "dev", self.iface,
                       "metric", "100"], check=False, timeout=15)
            say("WARNING: default route now points at the modem")

        if write_dns and settings.get("dns1"):
            try:
                with open("/etc/resolv.conf", "w", encoding="utf-8") as fh:
                    fh.write(f"nameserver {settings['dns1']}\n")
                    if settings.get("dns2"):
                        fh.write(f"nameserver {settings['dns2']}\n")
                say("WARNING: /etc/resolv.conf overwritten")
            except OSError as exc:
                say(f"could not write resolv.conf: {exc}")

    def _verify(self, settings, say):
        """Prove the data plane, not just the interface.

        The QMI gateway is a point-to-point peer that does not have to answer
        ICMP — on this rig 10.45.0.5 never does, while the core at 10.45.0.1
        answers in 24 ms. Testing only the gateway reported a perfectly healthy
        bearer as unreachable, which is worse than not testing at all.

        So: try the gateway, then the configured probe target, and report which
        one answered.
        """
        addr = self._current_address()
        say(f"{self.iface} is {self._operstate()} with {addr}")

        targets = []
        gw = settings.get("gateway")
        if gw:
            targets.append((gw, "gateway"))
        if self.probe_target and self.probe_target != gw:
            targets.append((self.probe_target, "core"))

        for target, label in targets:
            proc = utils.run(["ping", "-I", self.iface, "-c", "3", "-W", "3", target],
                             check=False, timeout=20)
            if proc.returncode == 0:
                rtt = ""
                m = re.search(r"= [\d.]+/([\d.]+)/", proc.stdout or "")
                if m:
                    rtt = f" ({float(m.group(1)):.1f} ms)"
                say(f"ping {target} [{label}] via {self.iface} — DATA PLANE UP{rtt}")
                return True
            say(f"no ICMP reply from {target} [{label}]")

        say("no target answered. The UE may be in RRC idle — retry — or the "
            "core may be unreachable. A point-to-point gateway that ignores "
            "ICMP is normal; the core not answering is not.")
        return False

    def _notify_bearer_change(self, settings):
        """Tell anything that cares that the address changed.

        Every data call gets a new address, which the handover document calls
        this rig's most frequent failure: anything pinned to the old one stops
        working silently.
        """
        target = self.probe_target or settings.get("gateway")
        if self.stats is not None and target:
            try:
                self.stats.set_link_target(target, iface=self.iface)
                logger.info("latency probe now targets %s via %s", target, self.iface)
            except Exception:               # noqa: BLE001
                logger.debug("could not retarget the latency probe", exc_info=True)

        if self.on_change is not None:
            try:
                self.on_change(self.status())
            except Exception:               # noqa: BLE001
                logger.debug("bearer change hook failed", exc_info=True)

    # -- teardown -----------------------------------------------------------
    def rebuild(self, ctx=None, apn=None, settle=5, register_wait=45):
        """Tear the PDU SESSION down, not just the data call, then bring it back.

        This exists because `down` does not do it. `down` calls
        `--wds-stop-network`, which stops the host-side data call while the
        modem keeps its PDN context; `up` then resumes the same session. The UE
        pings perfectly throughout, which is exactly what makes it dangerous.

        The core reads QoS configuration — subscriber 5QI, PCC rules, packet
        filters — ONLY at PDU session establishment. So after any QoS change on
        the core, a down/up leaves the UE carrying the previous configuration
        while looking entirely healthy. Two rounds of core-side testing were
        lost to this before it was understood.

        A genuine rebuild needs full deregistration, which is what AT+CFUN=0
        does: the modem drops its PDN context, and re-registering establishes a
        new session that reads the current configuration.

        The only reliable confirmation is on the core, not here: the SMF ledger
        showing "Removed -> 0" then "Added -> 1". The UE being reachable proves
        nothing, because it is reachable either way.
        """
        def step(name, detail=None):
            if ctx:
                ctx.step(name, detail)

        def say(line):
            logger.info("  %s", line)
            if ctx:
                ctx.log(line)

        step("stop-call", "stopping the data call")
        self.down(ctx=None)

        step("deregister", "AT+CFUN=0 — dropping the PDN context")
        say("the data call alone does not release the session; deregistering")
        self._cfun(0, say)
        time.sleep(settle)

        step("register", "AT+CFUN=1 — re-attaching")
        self._cfun(1, say)

        # Registration is not instant and starting the call too early fails in
        # a way that looks like a bearer fault rather than a timing one.
        started = time.time()
        deadline = started + register_wait
        registered = False
        while time.time() < deadline:
            try:
                serving = self.qmi.serving_system() or {}
                # `registered` is the boolean this QMI wrapper exposes;
                # `registration_state` is the raw string beside it. An earlier
                # version of this loop read a key that does not exist, so it
                # never matched and always burned the full timeout before
                # continuing anyway — slow, and silent about why.
                if serving.get("registered"):
                    registered = True
                    say(f"registered after {int(time.time() - started)}s "
                        f"({serving.get('operator') or 'unknown operator'})")
                    break
            except QmiError:
                pass
            time.sleep(2)
        if not registered:
            say(f"still not registered after {register_wait}s; starting the "
                f"call anyway, which will fail loudly if the radio is not back")

        step("start-call", "establishing a new PDU session")
        result = self.up(ctx=ctx, apn=apn)
        say("session rebuilt — confirm on the core that the SMF ledger shows "
            "Removed -> 0 then Added -> 1 before treating any QoS change as live")
        return result

    def _cfun(self, value, say):
        """AT+CFUN, through the bus that owns the port.

        Not a raw write to a tty: the AT port number moves between boots and
        ModemBus is the single owner, so going around it races whatever else is
        talking to the modem.
        """
        if self.modem is None:
            raise BearerError(
                "no modem bus, so the radio cannot be cycled — a session "
                "rebuild needs AT+CFUN and there is nothing to send it on")
        say(f"AT+CFUN={value}")
        # High priority through the bus, because a rebuild must not queue
        # behind a routine signal poll while the radio is half down.
        self.modem.bus.command(f"AT+CFUN={value}", timeout=20,
                               reason="pdu session rebuild")

    def down(self, ctx=None):
        """Stop the call using the saved handle, then clear the interface."""
        self.autorate.stop()
        def say(line):
            if ctx:
                ctx.log(line)
            else:
                logger.info("  %s", line)

        if ctx:
            ctx.plan(["stop-network", "clear-iface"])
            ctx.step("stop-network", "stopping the data call")

        try:
            stopped = self.qmi.stop_network()
            say(f"stop-network: {stopped}")
        except QmiError as exc:
            say(f"stop-network failed: {exc}")

        if ctx:
            ctx.step("clear-iface", f"flushing {self.iface}")
        utils.run(["ip", "addr", "flush", "dev", self.iface], check=False, timeout=15)
        utils.run(["ip", "link", "set", self.iface, "down"], check=False, timeout=15)
        self._settings = {}
        say(f"{self.iface} down")
        return self.status()
