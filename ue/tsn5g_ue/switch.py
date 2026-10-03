"""
FS TSN3220 switch manager — one-click IEEE 802.1Qbv (time-aware shaping) presets.

Ported from Open5GS-TSN-master/tools/tsn-switch-config/configure_qbv.sh. The
profile registry and the CLI generation (including node-splitting to the hardware
limits and dry-run) are fully implemented here; the SSH transport uses paramiko
(the H3C Comware CLI needs a pty and legacy KEX/ciphers) and includes the
interrupt-safe rescue path that disables Qbv if an apply is aborted.

Gate-state bits: 8-bit mask, left=queue7 .. right=queue0, 1=OPEN 0=CLOSED.
Queues 7/4/0 are bound to the CONTROL / HP-VIDEO / BE VLANs.
"""

import logging

from . import constants as C

logger = logging.getLogger("tsn5g-ue.switch")

# VLAN/PCP flow classifiers (match the reference RQ2 subscribers)
FLOWS = [
    {"id": 1, "vlan": 60, "pcp": 7, "cos": 7},   # CONTROL
    {"id": 2, "vlan": 70, "pcp": 4, "cos": 4},   # HP_VIDEO
    {"id": 3, "vlan": 80, "pcp": 0, "cos": 0},   # BE_VIDEO
]


class Profile:
    """A named Qbv gate-control-list profile.

    slots: list of (gate_state:int, interval_ns:int) logical windows.
    """

    def __init__(self, name, desc, slots, cycle_ns, gate_default=255,
                 guard_band=True, base_sec=C.QBV_COMMON_BASE_SEC,
                 base_ns=C.QBV_COMMON_BASE_NS):
        self.name = name
        self.desc = desc
        self.slots = slots
        self.cycle_ns = cycle_ns
        self.gate_default = gate_default
        self.guard_band = guard_band
        self.base_sec = base_sec
        self.base_ns = base_ns

    def to_dict(self):
        return {"name": self.name, "description": self.desc,
                "cycle_ns": self.cycle_ns, "guard_band": self.guard_band,
                "slots": self.slots}


# --- Profile registry (ported 1:1 from configure_qbv.sh) --------------------
# gate masks used below: 255=all open, 128=Q7 only, 127=all but Q7,
# 16=Q4 only, 0=all closed (guard), 144=Q7+Q4, 129=Q7+Q0.
_PROFILES = [
    Profile("default-3slot",
            "3-slot TAS: 200us CONTROL(Q7) | 300us HP(Q4) | 500us BE(all)",
            [(128, 200000), (16, 300000), (255, 500000)], 1000000, guard_band=False),
    Profile("p7p4-p7p0",
            "5-slot: 524us (P7+P4) | 100us all | 376us (P7+P0), guard-band on",
            [(144, 262000), (144, 262000), (255, 100000), (129, 262000), (129, 114000)],
            1000000),
    Profile("all-open",
            "Single slot 1ms, all queues open (baseline / no Qbv effect)",
            [(255, 1000000)], 1000000, guard_band=False),
    Profile("ctrl-priority",
            "50/50 split: 500us CONTROL(Q7) | 500us others(all except Q7)",
            [(128, 500000), (127, 500000)], 1000000),
    Profile("ctrl-starvation",
            "Stress: 900us CONTROL(Q7) | 100us rest. Demonstrates isolation",
            [(128, 900000), (127, 100000)], 1000000),
    Profile("urllc-5qi82",
            "5QI-82 aligned: 150us CTRL | 30us guard | 320us HP | 500us all",
            [(128, 150000), (0, 30000), (16, 320000), (255, 500000)], 1000000),
    Profile("guard-banded-3slot",
            "3-slot with 30us guards: 170us CTRL | g | 270us HP | g | 500us all",
            [(128, 170000), (0, 30000), (16, 270000), (0, 30000), (255, 500000)],
            1000000),
    Profile("short-500us",
            "500us cycle: 100us CTRL | 30us guard | 150us HP | 220us all",
            [(128, 100000), (0, 30000), (16, 150000), (255, 220000)], 500000),
    Profile("iso-motion-250us",
            "250us cycle: 50us CTRL | 20us guard | 80us HP | 100us all",
            [(128, 50000), (0, 20000), (16, 80000), (255, 100000)], 250000),
    Profile("cycle-2ms",
            "2ms cycle: 300us CTRL | 30us guard | 600us HP | 1070us all",
            [(128, 300000), (0, 30000), (16, 600000), (255, 1070000)], 2000000),
    Profile("cycle-3ms",
            "3ms cycle: 450us CTRL | 30us guard | 900us HP | 1620us all",
            [(128, 450000), (0, 30000), (16, 900000), (255, 1620000)], 3000000),
    Profile("long-4ms",
            "4ms cycle (video-heavy, HW-max): 500us CTRL | 1500us HP | 2000us all",
            [(128, 500000), (16, 1500000), (255, 2000000)], 4000000),
]
PROFILES = {p.name: p for p in _PROFILES}


class SwitchError(RuntimeError):
    pass


class SwitchManager:
    def __init__(self, switch_cfg):
        self.cfg = switch_cfg or {}
        self.flows = self.cfg.get("flows") or FLOWS

    # -- read model ---------------------------------------------------------
    def list_profiles(self):
        return [p.to_dict() for p in _PROFILES]

    @staticmethod
    def flows_from_vlan_map(vlan_map):
        """Turn a UI VLAN→PCP map into switch flow classifiers (dynamic PCP)."""
        flows = []
        for i, e in enumerate(vlan_map or [], start=1):
            pcp = int(e.get("pcp", 0))
            flows.append({"id": i, "vlan": int(e["vlan"]), "pcp": pcp, "cos": pcp})
        return flows or FLOWS

    # -- port-spec expansion ("1-8", "1,3,5", "all") -> ["GE1/0/1", ...] ----
    @staticmethod
    def expand_ports(spec):
        if not spec or spec == "all":
            spec = "1-8"
        out = []
        for part in str(spec).split(","):
            part = part.strip()
            if not part:
                continue
            if "-" in part:
                a, b = part.split("-", 1)
                a, b = int(a), int(b)
                if a > b:
                    raise SwitchError(f"invalid port range: {part}")
                out.extend(f"GE1/0/{n}" for n in range(a, b + 1))
            elif part.isdigit():
                out.append(f"GE1/0/{part}")
            else:
                raise SwitchError(f"cannot parse port spec: {part!r}")
        return out

    # -- node splitting to hardware limits ----------------------------------
    @staticmethod
    def _expand_nodes(slots):
        """Split any interval > QBV_INTERVAL_MAX_NS into consecutive nodes."""
        nodes = []
        for gate, interval in slots:
            remaining = interval
            while remaining > C.QBV_INTERVAL_MAX_NS:
                nodes.append((gate, C.QBV_INTERVAL_MAX_NS))
                remaining -= C.QBV_INTERVAL_MAX_NS
            if remaining > 0:
                nodes.append((gate, remaining))
        if len(nodes) > C.QBV_MAX_NODES:
            raise SwitchError(
                f"profile expands to {len(nodes)} nodes, exceeds {C.QBV_MAX_NODES}")
        return nodes

    # -- CLI generation (H3C Comware) ---------------------------------------
    def generate_cli(self, profile_name, interfaces, base_sec=None, base_ns=None):
        p = PROFILES.get(profile_name)
        if not p:
            raise SwitchError(f"unknown profile: {profile_name!r}")
        return self._gen(p.slots, p.cycle_ns, p.gate_default, p.guard_band,
                         base_sec if base_sec is not None else p.base_sec,
                         base_ns if base_ns is not None else p.base_ns,
                         interfaces, flows=self.flows)

    def generate_cli_custom(self, slots, cycle_ns, interfaces, guard=True,
                            gate_default=255, base_sec=None, base_ns=None, flows=None):
        """Build CLI for a dynamic, user-defined gate schedule."""
        slots = [(int(g), int(iv)) for g, iv in slots]
        return self._gen(slots, int(cycle_ns), gate_default, guard,
                         C.QBV_COMMON_BASE_SEC if base_sec is None else base_sec,
                         0 if base_ns is None else base_ns, interfaces,
                         flows=flows or self.flows)

    def _gen(self, slots, cycle_ns, gate_default, guard, base_sec, base_ns, interfaces, flows):
        nodes = self._expand_nodes(slots)
        bsec, bns = base_sec, base_ns

        lines = ["screen-length disable", "system-view"]
        for f in flows:
            lines.append(f"tsn flow {f['id']} vlan {f['vlan']} vlan-priority {f['pcp']}")

        for iface in interfaces:
            lines.append(f"interface {iface}")
            for f in flows:
                lines.append(f"tsn qbv bind flow {f['id']} cos {f['cos']}")
            lines.append(f"tsn qbv gate-state {gate_default}")
            lines.append(f"tsn qbv cycle-time numerator {cycle_ns} denominator 1000000000")
            lines.append(f"tsn qbv base-time seconds {bsec} nanoseconds {bns}")
            idx = 1
            for gate, interval in nodes:
                lines.append(
                    f"tsn qbv control-list index {idx} gate-state {gate} interval {interval}")
                idx += 1
            while idx <= C.QBV_MAX_NODES:  # clear leftover nodes
                lines.append(f"tsn qbv control-list index {idx} gate-state 0 interval 0")
                idx += 1
            lines.append("tsn qbv guard-band enable" if guard
                         else "undo tsn qbv guard-band enable")
            lines.append("tsn qbv enable")
            lines.append("tsn qbv config-change")
            lines.append("quit")

        lines += ["save force", "quit", "quit"]
        return "\n".join(lines)

    def generate_disable_cli(self, interfaces):
        lines = ["screen-length disable", "system-view"]
        for iface in interfaces:
            lines += [f"interface {iface}", "undo tsn qbv enable",
                      "undo tsn qbv config-change", "quit"]
        lines += ["save force", "quit", "quit"]
        return "\n".join(lines)

    # -- apply / disable / status -------------------------------------------
    def apply_profile(self, host, user, password, profile, ports, dry_run=False, flows=None):
        interfaces = self.expand_ports(ports or self.cfg.get("ports", "1-8"))
        if flows:
            self.flows = flows
        cli = self.generate_cli(profile, interfaces)
        if dry_run:
            return {"dry_run": True, "profile": profile, "interfaces": interfaces, "cli": cli}
        output = self._send(host, user, password, cli, interfaces)
        return {"dry_run": False, "profile": profile, "interfaces": interfaces, "output": output}

    def apply_custom(self, host, user, password, slots, cycle_ns, ports,
                     guard=True, dry_run=False, flows=None):
        """Push a dynamic, user-defined gate schedule (not a named preset)."""
        interfaces = self.expand_ports(ports or self.cfg.get("ports", "1-8"))
        cli = self.generate_cli_custom(slots, cycle_ns, interfaces, guard=guard,
                                       flows=flows or self.flows)
        if dry_run:
            return {"dry_run": True, "custom": True, "interfaces": interfaces, "cli": cli}
        output = self._send(host, user, password, cli, interfaces)
        return {"dry_run": False, "custom": True, "interfaces": interfaces, "output": output}

    def disable(self, host, user, password, ports):
        interfaces = self.expand_ports(ports or self.cfg.get("ports", "1-8"))
        cli = self.generate_disable_cli(interfaces)
        output = self._send(host, user, password, cli, interfaces)
        return {"disabled": True, "interfaces": interfaces, "output": output}

    def status(self, host, user, password, ports):
        interfaces = self.expand_ports(ports or self.cfg.get("ports", "1-8"))
        first = interfaces[0] if interfaces else "GE1/0/1"
        cli = f"screen-length disable\ndisplay tsn qbv interface {first}\nquit\n"
        try:
            out = self._send(host, user, password, cli, interfaces, rescue=False)
        except SwitchError as exc:
            return {"interfaces": interfaces, "reachable": False, "error": str(exc)}
        qbv_enabled = "Qbv status" in out and "enable" in out.lower()
        return {"interfaces": interfaces, "reachable": True, "qbv_enabled": qbv_enabled,
                "raw": out}

    # -- SSH transport (paramiko; pty + legacy algos) -----------------------
    def _send(self, host, user, password, cli, interfaces, rescue=True):
        """
        Push a CLI stream to the switch over an interactive shell (the Comware CLI
        needs a pty), pacing one command per line. On any error mid-apply, send the
        rescue disable so a half-applied gate schedule never strands a mgmt port.
        """
        import time as _time
        try:
            import paramiko
        except ImportError as exc:
            raise SwitchError("paramiko not installed; cannot reach switch") from exc

        # Widen algorithms for the switch's older SSH stack.
        legacy = {
            "kex": ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1",
                    "diffie-hellman-group-exchange-sha1"],
            "keys": ["ssh-rsa", "ssh-dss"],
            "ciphers": ["aes128-cbc", "aes256-cbc", "3des-cbc", "aes128-ctr", "aes256-ctr"],
        }
        # paramiko raises "str, bytes or bytearray expected, not NoneType" deep
        # inside auth when any of these is missing, which surfaced in the UI as
        # that TypeError rather than as "no password".
        missing = [n for n, v in (("host", host), ("user", user),
                                  ("password", password)) if not v]
        if missing:
            raise SwitchError(
                f"cannot reach the switch: no {', '.join(missing)}. "
                "Host and user come from the config's switch section; the "
                "password is entered per session and never stored.")

        transport = None
        try:
            transport = paramiko.Transport((host, 22))
            so = transport.get_security_options()
            for attr, extra in (("kex", legacy["kex"]), ("ciphers", legacy["ciphers"]),
                                ("key_types", legacy["keys"])):
                try:
                    cur = list(getattr(so, attr))
                    setattr(so, attr, tuple(cur + [a for a in extra if a not in cur]))
                except Exception:  # noqa: BLE001 - algo not known to this paramiko
                    pass
            transport.connect(username=user, password=password)
            chan = transport.open_session()
            chan.get_pty()
            chan.invoke_shell()
            _time.sleep(0.4)
            out = []
            for line in cli.splitlines():
                chan.send(line + "\n")
                _time.sleep(0.06)
                if chan.recv_ready():
                    out.append(chan.recv(65535).decode(errors="ignore"))
            _time.sleep(0.6)
            while chan.recv_ready():
                out.append(chan.recv(65535).decode(errors="ignore"))
            return _clean("".join(out))
        except Exception as exc:  # noqa: BLE001
            if rescue:
                self._rescue(host, user, password, interfaces)
            raise SwitchError(f"switch SSH failed: {exc}") from exc
        finally:
            if transport:
                transport.close()

    def _rescue(self, host, user, password, interfaces):
        """Best-effort: force Qbv off on the target ports after a failed apply."""
        try:
            self._send(host, user, password, self.generate_disable_cli(interfaces),
                       interfaces, rescue=False)
            logger.info("switch rescue-disable sent")
        except SwitchError as exc:
            logger.error("switch rescue failed: %s", exc)


def _clean(s):
    import re as _re
    return _re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", s.replace("\r", ""))
