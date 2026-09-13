"""
Policy routing: send one application's traffic over 5G, and nothing else.

This automates HANDOVER_5G_CAMERA.md steps A4/A5 — mark the camera's UDP
stream, look it up in a separate table, send that table's default out wwan0,
and masquerade so the source address is the UE's:

    iptables -t mangle -A OUTPUT -p udp --dport 50451 -j MARK --set-mark 0x5
    ip rule add fwmark 0x5 table 5
    ip route replace default dev wwan0 table 5
    iptables -t nat -A POSTROUTING -o wwan0 -p udp --dport 50451 -j MASQUERADE

Three things the handover document learned the hard way, all encoded here:

**MASQUERADE, never SNAT --to-source.** The SMF hands out a new UE address on
every data call (.2 -> .3 -> .4 -> .5 -> .6 observed). A pinned source address
is stale the moment the bearer cycles; masquerade re-reads it per packet.

**The table-5 default route carries no `src`.** Same reason.

**Rules accumulate.** `iptables -A` appends whether or not an identical rule is
already there, so re-applying silently builds duplicates. Every rule added is
recorded verbatim in /run and deleted individually before re-adding. There is
no `iptables -F` anywhere here: flushing a chain on a shared box destroys rules
this daemon did not create and is not ours to do.

And the guard that matters most: `ip route get` is run before and after, and if
the route to the management peer changed, everything just added is rolled back.
The document's own warning is "if this says wwan0, STOP" — the difference here
is that stopping is automatic, because by the time a human reads it the SSH
session is already gone.
"""

import json
import logging
import os
import re

from .. import utils

logger = logging.getLogger("tsn5g-ue.routing")

STATE_PATH = "/run/tsn5g-ue/routing.applied"

# The camera stream from CAMERA_5G_PLAN.md, offered as the built-in profile.
BUILTIN_PROFILES = [
    {
        "name": "camera-stream",
        "label": "App traffic over 5G",
        "description": "Send one UDP port over the 5G bearer and leave "
                       "everything else on the wired network.",
        "proto": "udp",
        "dport": 50451,
        "mark": "0x5",
        "table": 5,
        "dev": "wwan0",
        "masquerade": True,
    },
]


class RoutingError(RuntimeError):
    pass


def _ip(*args, check=False):
    return utils.run(["ip", *args], check=check, timeout=15)


def _iptables(*args, check=False):
    return utils.run(["iptables", *args], check=check, timeout=15)


class RoutingManager:
    def __init__(self, state_path=STATE_PATH):
        self.state_path = state_path

    # -- state --------------------------------------------------------------
    def _load(self):
        try:
            with open(self.state_path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}

    def _save(self, data):
        try:
            os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
            tmp = f"{self.state_path}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp, self.state_path)
        except OSError as exc:
            logger.warning("could not record applied routing rules: %s", exc)

    def _clear_state(self):
        try:
            os.unlink(self.state_path)
        except OSError:
            pass

    # -- read model ---------------------------------------------------------
    def profiles(self):
        return BUILTIN_PROFILES

    def status(self):
        applied = self._load()
        return {
            "applied": bool(applied.get("rules")),
            "profile": applied.get("profile"),
            "spec": applied.get("spec"),
            "rules": applied.get("rules", []),
            "live": self.live_rules(),
        }

    def live_rules(self):
        """What the kernel actually has, independent of what we recorded."""
        rules = _ip("rule", "show").stdout or ""
        mangle = _iptables("-t", "mangle", "-S", "OUTPUT").stdout or ""
        nat = _iptables("-t", "nat", "-S", "POSTROUTING").stdout or ""
        tables = {}
        for m in re.finditer(r"lookup (\d+)", rules):
            t = m.group(1)
            if t not in tables:
                tables[t] = [ln.strip() for ln in
                             (_ip("route", "show", "table", t).stdout or "").splitlines()
                             if ln.strip()]
        return {
            "ip_rule": [ln.strip() for ln in rules.splitlines() if ln.strip()],
            "mangle_output": [ln.strip() for ln in mangle.splitlines()
                              if "MARK" in ln],
            "nat_postrouting": [ln.strip() for ln in nat.splitlines()
                                if "MASQUERADE" in ln or "SNAT" in ln],
            "tables": tables,
        }

    # -- the guard ----------------------------------------------------------
    def route_for(self, dst, mark=None):
        """`ip route get`, parsed. The question the handover doc says to ask."""
        args = ["route", "get", dst]
        if mark:
            args += ["mark", str(mark)]
        out = (_ip(*args).stdout or "").strip()
        dev = re.search(r"\bdev\s+(\S+)", out)
        src = re.search(r"\bsrc\s+(\S+)", out)
        return {"dst": dst, "mark": mark, "dev": dev.group(1) if dev else None,
                "src": src.group(1) if src else None, "raw": out or None}

    def management_peer(self):
        """Whoever we are most likely to be reached over.

        SSH_CLIENT when this daemon was started from a session; otherwise the
        current default gateway. Getting this wrong only weakens the check, it
        cannot cause harm by itself.
        """
        ssh = os.environ.get("SSH_CLIENT") or os.environ.get("SSH_CONNECTION")
        if ssh:
            peer = ssh.split()[0]
            if re.fullmatch(r"[\d.]+", peer):
                return peer
        out = _ip("route", "show", "default").stdout or ""
        m = re.search(r"default via (\S+)", out)
        return m.group(1) if m else None

    def verify(self, spec=None, baseline=None):
        """Run the three probes the handover document specifies."""
        spec = spec or self._load().get("spec") or {}
        mark = spec.get("mark")
        stream_dst = spec.get("verify_dst") or spec.get("dst")
        mgmt = self.management_peer()

        checks = {}
        if mgmt:
            checks["management"] = self.route_for(mgmt)
        if stream_dst:
            checks["stream_unmarked"] = self.route_for(stream_dst)
            if mark:
                checks["stream_marked"] = self.route_for(stream_dst, mark=mark)

        warnings = []
        ok = True

        mgmt_dev = (checks.get("management") or {}).get("dev")
        if mgmt_dev and spec.get("dev") and mgmt_dev == spec["dev"]:
            ok = False
            warnings.append(
                f"the route to the management peer {mgmt} now goes out "
                f"{mgmt_dev}. That is the modem. This session would be lost.")
        if baseline and mgmt_dev and baseline.get("dev") and mgmt_dev != baseline["dev"]:
            ok = False
            warnings.append(
                f"the management route changed from {baseline['dev']} to {mgmt_dev}.")

        unmarked = (checks.get("stream_unmarked") or {}).get("dev")
        if unmarked and spec.get("dev") and unmarked == spec["dev"]:
            ok = False
            warnings.append(
                f"UNMARKED traffic to {stream_dst} is going out {unmarked}. "
                "Only marked traffic should. This looks like a default route "
                "via the modem rather than a policy rule.")

        marked = (checks.get("stream_marked") or {}).get("dev")
        if mark and spec.get("dev"):
            if marked != spec["dev"]:
                warnings.append(
                    f"marked traffic to {stream_dst} goes out {marked}, not "
                    f"{spec['dev']}. The policy rule is not taking effect.")

        return {"ok": ok, "checks": checks, "warnings": warnings,
                "management_peer": mgmt}

    # -- apply / clear ------------------------------------------------------
    def apply(self, spec, ctx=None):
        """Install a profile, verifying before and after, rolling back on harm."""
        def say(line):
            if ctx:
                ctx.log(line)
            else:
                logger.info("  %s", line)

        spec = dict(spec or {})
        for key in ("proto", "dport", "mark", "table", "dev"):
            if spec.get(key) in (None, ""):
                raise RoutingError(f"routing profile needs '{key}'")
        dev, mark, table = spec["dev"], str(spec["mark"]), str(spec["table"])
        proto, dport = spec["proto"], str(spec["dport"])

        if not utils.iface_exists(dev):
            raise RoutingError(
                f"{dev} does not exist. Bring the bearer up before routing "
                f"traffic over it.")

        if ctx:
            ctx.plan(["baseline", "clear-previous", "apply", "verify"])

        # --- baseline ------------------------------------------------------
        if ctx:
            ctx.step("baseline", "recording where traffic goes now")
        mgmt = self.management_peer()
        baseline = self.route_for(mgmt) if mgmt else None
        if baseline:
            say(f"management peer {mgmt} currently via {baseline['dev']} "
                f"(src {baseline['src']})")
        else:
            say("could not determine the management peer; the rollback guard "
                "will be weaker than usual")

        # --- remove what we added last time --------------------------------
        if ctx:
            ctx.step("clear-previous", "removing rules from a previous apply")
        removed = self._remove_recorded(say)
        say(f"removed {removed} previously applied rule(s)")

        # --- apply ---------------------------------------------------------
        if ctx:
            ctx.step("apply", f"{proto}/{dport} -> mark {mark} -> table {table} -> {dev}")
        rules = []

        mangle = ["-t", "mangle", "-A", "OUTPUT", "-p", proto,
                  "--dport", dport, "-j", "MARK", "--set-mark", mark]
        # -C first: append is unconditional, so re-applying otherwise stacks
        # duplicates that are invisible until someone reads the chain.
        if _iptables("-t", "mangle", "-C", "OUTPUT", *mangle[4:]).returncode != 0:
            proc = _iptables(*mangle)
            if proc.returncode != 0:
                raise RoutingError(f"could not add the mangle rule: "
                                   f"{(proc.stderr or '').strip()}")
            rules.append({"kind": "iptables", "table": "mangle",
                          "args": mangle, "delete": ["-t", "mangle", "-D",
                                                     "OUTPUT", *mangle[4:]]})
            say(f"iptables -t mangle -A OUTPUT -p {proto} --dport {dport} "
                f"-j MARK --set-mark {mark}")
        else:
            say("mangle rule already present")

        if f"lookup {table}" not in (_ip("rule", "show").stdout or ""):
            proc = _ip("rule", "add", "fwmark", mark, "table", table)
            if proc.returncode != 0:
                raise RoutingError(f"could not add the ip rule: "
                                   f"{(proc.stderr or '').strip()}")
            rules.append({"kind": "iprule", "args": ["rule", "add", "fwmark",
                                                     mark, "table", table],
                          "delete": ["rule", "del", "fwmark", mark, "table", table]})
            say(f"ip rule add fwmark {mark} table {table}")
        else:
            say(f"ip rule for table {table} already present")

        # No `src`: the UE address changes on every data call, and a pinned
        # source makes this rule silently wrong after a cycle.
        proc = _ip("route", "replace", "default", "dev", dev, "table", table)
        if proc.returncode != 0:
            raise RoutingError(f"could not add the table-{table} default route: "
                               f"{(proc.stderr or '').strip()}")
        rules.append({"kind": "iproute",
                      "args": ["route", "replace", "default", "dev", dev,
                               "table", table],
                      "delete": ["route", "del", "default", "dev", dev,
                                 "table", table]})
        say(f"ip route replace default dev {dev} table {table}   (no src, "
            f"so it survives an address change)")

        if spec.get("masquerade", True):
            nat = ["-t", "nat", "-A", "POSTROUTING", "-o", dev, "-p", proto,
                   "--dport", dport, "-j", "MASQUERADE"]
            if _iptables("-t", "nat", "-C", "POSTROUTING", *nat[4:]).returncode != 0:
                proc = _iptables(*nat)
                if proc.returncode != 0:
                    raise RoutingError(f"could not add the NAT rule: "
                                       f"{(proc.stderr or '').strip()}")
                rules.append({"kind": "iptables", "table": "nat", "args": nat,
                              "delete": ["-t", "nat", "-D", "POSTROUTING",
                                         *nat[4:]]})
                say(f"iptables -t nat -A POSTROUTING -o {dev} -p {proto} "
                    f"--dport {dport} -j MASQUERADE   (not SNAT: the UE "
                    f"address changes)")
            else:
                say("NAT rule already present")

        self._save({"profile": spec.get("name"), "spec": spec, "rules": rules})

        # --- verify, and undo if we broke the management path ----------------
        if ctx:
            ctx.step("verify", "checking nothing else moved")
        result = self.verify(spec, baseline=baseline)
        for w in result["warnings"]:
            say(f"WARNING: {w}")

        if not result["ok"]:
            say("rolling back — the management path changed, which is the one "
                "outcome that is never acceptable")
            self._remove_recorded(say)
            self._clear_state()
            raise RoutingError(
                "routing was rolled back: " + "; ".join(result["warnings"]))

        say("management path unchanged")
        return self.status()

    def clear(self, ctx=None):
        def say(line):
            if ctx:
                ctx.log(line)
            else:
                logger.info("  %s", line)
        if ctx:
            ctx.plan(["remove"])
            ctx.step("remove", "deleting exactly the rules we added")
        removed = self._remove_recorded(say)
        self._clear_state()
        say(f"removed {removed} rule(s)")
        return self.status()

    def _remove_recorded(self, say):
        """Delete exactly what we recorded — never flush a chain."""
        state = self._load()
        removed = 0
        for rule in reversed(state.get("rules", [])):
            args = rule.get("delete")
            if not args:
                continue
            proc = _iptables(*args) if rule["kind"] == "iptables" else _ip(*args)
            if proc.returncode == 0:
                removed += 1
            else:
                say(f"could not remove {' '.join(args)}: "
                    f"{(proc.stderr or '').strip()[:80]}")
        return removed

    # -- bearer integration -------------------------------------------------
    def reapply_after_bearer_change(self, ctx=None):
        """Re-install the recorded profile after the UE address changes.

        This is the failure the handover document calls the rig's most frequent:
        every data call gets a new address, and anything pinned to the old one
        stops working silently. Masquerade and the src-less default route mean
        the rules survive as written — but the interface may have been flushed,
        so the table-5 route needs putting back.
        """
        state = self._load()
        spec = state.get("spec")
        if not spec:
            return None
        logger.info("re-applying routing profile after a bearer change")
        return self.apply(spec, ctx=ctx)
