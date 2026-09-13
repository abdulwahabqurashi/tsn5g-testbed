"""
Registration control: where the UE camps, and on what.

Ports docs/reference/{camp,lock5g,fixband,scan,rfcheck,force5g,recover}.sh.
Those scripts were written under pressure while this rig was refusing to camp,
and they disagree with each other. Where they do, connect.sh wins: it carries
a dated, explicit verification, and it is the one that ends with a working link.

The disagreement that matters:

    nr5g_disable_mode must be 0.

connect.sh, 2026-09-08: "this modem (RM520NGLAAR03A01M4G) only operates on SA
with nr5g_disable_mode=0. Values 1 and 2 both prevent camping, and 1
additionally causes writes to nr5g_band to be silently rejected. Do NOT
'restore' it to 1."

force5g.sh, fix5g.sh, restore.sh and rftest.sh's exit trap all set it to 1.
Every one of those lines is omitted here, and the API refuses the value — see
core/safety.py. This is the single setting most likely to strand the rig, and
it looks harmless.

The other thing carried across faithfully is QNWLOCK's argument order, which
varies by firmware. lock5g.sh tries four permutations and keeps whichever
returns OK; so does set_cell_lock().
"""

import logging
import re
import time

from . import parse
from .bus import AtError, P_BULK, P_HIGH, P_URGENT

logger = logging.getLogger("tsn5g-ue.modem.radio")

# Access technology for AT+COPS. 11 = NR connected to a 5G core, i.e. SA.
ACT_NR_SA = 11

# QNWLOCK argument orders seen across firmware revisions (lock5g.sh).
LOCK_VARIANTS = [
    '{arfcn},{scs},{band}',
    '1,{arfcn},{scs},{band}',
    '{arfcn},{scs},{band},{pci}',
    '1,{arfcn},{scs},{band},{pci}',
]

# Band-write syntaxes, in the order fixband.sh tries them.
BAND_SYNTAXES = ["{bands}", '"{bands}"']

# A full list for when a single band has been rejected and the mask is stuck.
FULL_NR_BANDS = "1:3:7:8:20:28:38:40:41:77:78:79"

PREF_KEYS = ("mode_pref", "nr5g_disable_mode", "nr5g_band", "nsa_nr5g_band",
             "rat_acq_order", "lte_band")


class RadioError(RuntimeError):
    pass


class RadioControl:
    def __init__(self, bus, events=None):
        self.bus = bus
        self.events = events

    # -- read ---------------------------------------------------------------
    def prefs(self):
        """Every preference that decides what the UE will camp on."""
        out = {}
        for key in PREF_KEYS:
            try:
                lines = self.bus.command(f'AT+QNWPREFCFG="{key}"', timeout=6,
                                         priority=P_HIGH, reason="prefs")
                out[key] = parse.qnwprefcfg(lines, key)["value"]
            except AtError as exc:
                out[key] = None
                logger.debug("could not read %s: %s", key, exc)

        # A derived, honest summary: "SA only" is the combination, not a switch.
        out["sa_only"] = (str(out.get("mode_pref") or "").upper() == "NR5G"
                          and str(out.get("nr5g_disable_mode") or "") == "0")
        return out

    def state(self):
        """Registration, serving cell and lock, in one read."""
        out = {"registered": False}
        try:
            script = self.bus.script(
                ['AT+COPS?', 'AT+C5GREG?', 'AT+CEREG?',
                 'AT+QENG="servingcell"', 'AT+QNWLOCK="common/5g"'],
                timeout=8, priority=P_HIGH, stop_on_error=False, reason="radio-state")
        except AtError as exc:
            return {"registered": False, "error": str(exc)}

        by_cmd = {cmd: (res if not isinstance(res, AtError) else [])
                  for cmd, res in script}

        cops = parse.cops(by_cmd.get("AT+COPS?", []))
        reg5 = parse.registration(by_cmd.get("AT+C5GREG?", []))
        reg4 = parse.registration(by_cmd.get("AT+CEREG?", []))
        cell = parse.qeng(by_cmd.get('AT+QENG="servingcell"', []))
        lock = parse.qnwlock(by_cmd.get('AT+QNWLOCK="common/5g"', []))

        out.update({
            "operator": cops["operator"],
            "selection": "manual" if cops["manual"] else "automatic",
            "act": cops["act"],
            "registered": reg5["registered"] or reg4["registered"],
            "reg_5g": reg5,
            "reg_lte": reg4,
            "rat": cell["rat"],
            "cell": {k: cell[k] for k in ("band", "arfcn", "pci", "cellid",
                                          "rsrp", "rsrq", "sinr")},
            "lock": lock,
        })
        return out

    # -- preferences --------------------------------------------------------
    def set_prefs(self, mode_pref=None, nr5g_band=None, nr5g_disable_mode=None,
                  ctx=None):
        """Write radio preferences. Refuses the value that strands this rig."""
        if nr5g_disable_mode is not None and str(nr5g_disable_mode) != "0":
            raise RadioError(
                "nr5g_disable_mode must be 0. Verified on this firmware "
                "(RM520NGLAAR03A01M4G) 2026-09-08: values 1 and 2 prevent the "
                "modem from camping on SA, and 1 additionally makes nr5g_band "
                "writes fail silently. Several of the reference scripts set 1; "
                "connect.sh is the one that works.")

        cmds = []
        if mode_pref:
            cmds.append(f'AT+QNWPREFCFG="mode_pref",{mode_pref}')
        if nr5g_disable_mode is not None:
            cmds.append('AT+QNWPREFCFG="nr5g_disable_mode",0')
        if nr5g_band:
            cmds.append(f'AT+QNWPREFCFG="nr5g_band",{nr5g_band}')
        if not cmds:
            raise RadioError("nothing to set")

        if ctx:
            ctx.plan(["write", "verify"])
            ctx.step("write", ", ".join(cmds))

        # One turn: a telemetry poll landing between these would read a
        # half-configured modem.
        results = self.bus.script(cmds, timeout=10, priority=P_HIGH,
                                  stop_on_error=False, reason="set-prefs")
        for cmd, res in results:
            if isinstance(res, AtError):
                if ctx:
                    ctx.log(f"{cmd} -> {res}")
            elif ctx:
                ctx.log(f"{cmd} -> OK")

        if ctx:
            ctx.step("verify", "reading the values back")
        after = self.prefs()
        if ctx:
            for k in ("mode_pref", "nr5g_disable_mode", "nr5g_band"):
                ctx.log(f"{k} = {after.get(k)}")

        # A write that reports OK and reads back unchanged is the documented
        # failure mode, so check rather than trust.
        if nr5g_band and str(after.get("nr5g_band") or "") in ("", "0"):
            raise RadioError(
                "nr5g_band read back empty after the write. That is the stuck-mask "
                "condition fixband.sh and recover.sh exist for — run Repair bands.")
        return after

    # -- operator selection -------------------------------------------------
    def forbidden_plmns(self):
        """The SIM's forbidden-PLMN list. It survives reboots."""
        try:
            lines = self.bus.command('AT+QFPLMNCFG="get"', timeout=8,
                                     priority=P_HIGH, reason="fplmn")
        except AtError as exc:
            return {"forbidden": [], "error": str(exc)}
        return parse.qfplmn(lines)

    def clear_forbidden(self, plmn, ctx=None):
        """Delete one PLMN from the forbidden list (camp.sh).

        A PLMN lands here after enough failed attempts and then stays,
        across reboots, refusing every future attempt until it is removed.
        """
        if ctx:
            ctx.plan(["delete", "verify"])
            ctx.step("delete", f"removing {plmn} from the forbidden list")
        self.bus.command(f'AT+QFPLMNCFG="delete","{plmn}"', timeout=10,
                         priority=P_HIGH, reason="fplmn-delete")
        if ctx:
            ctx.step("verify", "reading the list back")
        after = self.forbidden_plmns()
        if ctx:
            ctx.log(f"forbidden now: {after.get('forbidden') or 'none'}")
        return after

    def select_plmn(self, plmn=None, mode="manual", act=ACT_NR_SA, ctx=None,
                    wait=150):
        """AT+COPS. Manual selection pins the AcT as well as the operator.

        force5g.sh explains why the AcT matters: `AT+COPS=1,2,"00102"` with no
        <AcT> let the modem widen to LTE and drift into limited service on a
        commercial network. `,11` keeps it on NR connected to a 5G core.
        """
        if ctx:
            ctx.plan(["deregister", "select", "wait"])

        if mode == "automatic":
            if ctx:
                ctx.step("select", "AT+COPS=0 (automatic)")
            self.bus.command("AT+COPS=0", timeout=wait, priority=P_HIGH,
                             reason="cops-auto")
            return self.state()

        if not plmn:
            raise RadioError("manual selection needs a PLMN")

        if ctx:
            ctx.step("deregister", "AT+COPS=2")
        try:
            self.bus.command("AT+COPS=2", timeout=20, priority=P_HIGH,
                             reason="cops-dereg")
        except AtError as exc:
            if ctx:
                ctx.log(f"deregister returned {exc}; continuing")

        if ctx:
            ctx.step("select", f'AT+COPS=1,2,"{plmn}",{act}  (this can take '
                               f'up to {wait}s)')
        try:
            self.bus.command(f'AT+COPS=1,2,"{plmn}",{act}', timeout=wait,
                             priority=P_BULK, cancel=ctx.cancel if ctx else None,
                             reason="cops-select")
        except AtError as exc:
            if exc.kind == "cancelled":
                raise
            if ctx:
                ctx.log(f"selection returned {exc}")
            # A failed selection is worth reporting with the cause attached.
            reason = self._last_error_reason()
            raise RadioError(f"could not select {plmn}: {exc}"
                             + (f" (CEER: {reason})" if reason else "")) from exc

        if ctx:
            ctx.step("wait", "waiting for the UE to camp")
        return self.wait_for_camp(timeout=60, ctx=ctx)

    def _last_error_reason(self):
        try:
            lines = self.bus.try_command("AT+CEER", timeout=5, reason="ceer")
            return " ".join(lines) if lines else None
        except AtError:
            return None

    # -- camping ------------------------------------------------------------
    def wait_for_camp(self, timeout=120, ctx=None, want="NR5G-SA"):
        """Poll until the serving cell reports the RAT we asked for."""
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            if ctx:
                ctx.check_cancel()
                elapsed = timeout - (deadline - time.monotonic())
                ctx.progress(min(95, int(elapsed / timeout * 100)),
                             f"waiting… {elapsed:.0f}s")
            lines = self.bus.try_command('AT+QENG="servingcell"', timeout=6,
                                         reason="camp-wait")
            if lines is not None:
                cell = parse.qeng(lines)
                last = cell
                if cell["rat"] and want in cell["rat"]:
                    if ctx:
                        ctx.log(f"camped: {cell['rat']} band {cell['band']} "
                                f"arfcn {cell['arfcn']} rsrp {cell['rsrp']}")
                    return {"camped": True, **self.state()}
                if ctx and cell["rat"]:
                    ctx.log(f"currently {cell['rat']}")
            time.sleep(5)

        if ctx:
            ctx.log(f"did not reach {want} within {timeout}s")
        return {"camped": False, "last_cell": last, **self.state()}

    # -- cell lock ----------------------------------------------------------
    def cell_lock(self):
        try:
            lines = self.bus.command('AT+QNWLOCK="common/5g"', timeout=6,
                                     priority=P_HIGH, reason="lock-read")
        except AtError as exc:
            return {"locked": False, "error": str(exc)}
        return parse.qnwlock(lines)

    def set_cell_lock(self, arfcn, scs=1, band=78, pci=1, ctx=None):
        """Pin the UE to one cell.

        QNWLOCK's argument order varies by firmware, so lock5g.sh tries four
        permutations and keeps whichever returns OK. Same here — guessing one
        and reporting failure would be wrong on half the firmware revisions.
        """
        if ctx:
            ctx.plan(["lock", "cycle", "verify"])
            ctx.step("lock", f"arfcn {arfcn} scs {scs} band n{band} pci {pci}")

        accepted = None
        for variant in LOCK_VARIANTS:
            args = variant.format(arfcn=arfcn, scs=scs, band=band, pci=pci)
            cmd = f'AT+QNWLOCK="common/5g",{args}'
            try:
                self.bus.command(cmd, timeout=10, priority=P_HIGH,
                                 reason="lock-set")
                accepted = cmd
                if ctx:
                    ctx.log(f"accepted: {cmd}")
                break
            except AtError as exc:
                if ctx:
                    ctx.log(f"rejected: {args}  ({exc.kind})")

        if not accepted:
            raise RadioError(
                "no QNWLOCK argument order was accepted. The four orders "
                "lock5g.sh knows about all failed; this firmware may use a "
                "different one.")

        if ctx:
            ctx.step("cycle", "AT+CFUN=0 / AT+CFUN=1 so the lock takes effect")
        self.bus.script(["AT+CFUN=0", "AT+CFUN=1"], timeout=20,
                        priority=P_URGENT, stop_on_error=False, reason="lock-cycle")
        time.sleep(3)

        if ctx:
            ctx.step("verify", "waiting for the UE to camp on the locked cell")
        result = self.wait_for_camp(timeout=90, ctx=ctx)
        result["lock"] = self.cell_lock()
        return result

    def clear_cell_lock(self, ctx=None):
        if ctx:
            ctx.plan(["clear", "verify"])
            ctx.step("clear", 'AT+QNWLOCK="common/5g",0')
        self.bus.command('AT+QNWLOCK="common/5g",0', timeout=10,
                         priority=P_HIGH, reason="lock-clear")
        if ctx:
            ctx.step("verify", "waiting for the UE to re-select")
        return self.wait_for_camp(timeout=90, ctx=ctx)

    # -- survey -------------------------------------------------------------
    def scan(self, kind="both", ctx=None):
        """Network survey. Minutes, not seconds — cancellable.

        Telemetry is suspended for the duration: it would otherwise skip every
        poll (the bus is busy) and report stale readings for four minutes.
        """
        out = {}
        steps = []
        if kind in ("nr", "both"):
            steps.append("cells")
        if kind in ("operators", "both"):
            steps.append("operators")
        if ctx:
            ctx.plan(steps)

        if "cells" in steps:
            if ctx:
                ctx.step("cells", "AT+QSCAN=3,1 — this takes 2 to 4 minutes")
            try:
                lines = self.bus.command("AT+QSCAN=3,1", timeout=300,
                                         priority=P_BULK,
                                         cancel=ctx.cancel if ctx else None,
                                         reason="scan-cells")
                out["cells"] = parse.qscan(lines)["cells"]
                if ctx:
                    ctx.log(f"found {len(out['cells'])} cell(s)")
                    for c in out["cells"][:12]:
                        ctx.log(f"  {c['rat']} {c['mcc']}-{c['mnc']} "
                                f"arfcn {c['arfcn']} pci {c['pci']} rsrp {c['rsrp']}")
            except AtError as exc:
                if exc.kind == "cancelled":
                    raise
                out["cells_error"] = str(exc)
                if ctx:
                    ctx.log(f"cell scan failed: {exc}")

        if "operators" in steps:
            if ctx:
                ctx.step("operators", "AT+COPS=? — another 2 to 3 minutes")
            try:
                lines = self.bus.command("AT+COPS=?", timeout=240,
                                         priority=P_BULK,
                                         cancel=ctx.cancel if ctx else None,
                                         reason="scan-operators")
                out["operators"] = parse.cops_scan(lines)["operators"]
                if ctx:
                    ctx.log(f"found {len(out['operators'])} operator(s)")
                    for o in out["operators"]:
                        ctx.log(f"  {o['plmn']} {o['long'] or ''} ({o['status']})")
            except AtError as exc:
                if exc.kind == "cancelled":
                    raise
                out["operators_error"] = str(exc)
                if ctx:
                    ctx.log(f"operator scan failed: {exc}")

        out["ts"] = time.time()
        return out

    def diagnose(self, ctx=None):
        """rfcheck.sh: is any RF reaching the modem at all?"""
        if ctx:
            ctx.plan(["read", "assess"])
            ctx.step("read", "lock state, per-branch RSRP/RSRQ, preferences")

        script = self.bus.script(
            ['AT+QNWLOCK="common/5g"', "AT+QRSRP", "AT+QRSRQ", "AT+QSINR",
             'AT+QNWPREFCFG="mode_pref"', 'AT+QNWPREFCFG="nr5g_band"',
             'AT+QNWPREFCFG="nr5g_disable_mode"', 'AT+QENG="servingcell"',
             "AT+CEER"],
            timeout=12, priority=P_HIGH, stop_on_error=False, reason="diagnose")
        by_cmd = {cmd: (res if not isinstance(res, AtError) else [])
                  for cmd, res in script}

        rsrp = parse.qrsrp(by_cmd.get("AT+QRSRP", []))
        cell = parse.qeng(by_cmd.get('AT+QENG="servingcell"', []))
        lock = parse.qnwlock(by_cmd.get('AT+QNWLOCK="common/5g"', []))

        findings = []
        if rsrp.get("no_rf"):
            findings.append(
                "No RF on any antenna branch. That is a cabling or antenna "
                "fault, not coverage — check the MAIN and DIV connectors.")
        live = [b for b in (rsrp.get("branches") or []) if b is not None]
        if live and len(live) < len(rsrp.get("branches") or []):
            findings.append(
                f"Only {len(live)} of {len(rsrp['branches'])} antenna branches "
                "report a measurement. If all four are cabled, MIMO is degraded.")
        if lock.get("locked"):
            findings.append(
                f"A cell lock is active (arfcn {lock.get('arfcn')}). The UE "
                "cannot camp anywhere else until it is cleared.")
        prefs = {k: parse.qnwprefcfg(by_cmd.get(f'AT+QNWPREFCFG="{k}"', []), k)["value"]
                 for k in ("mode_pref", "nr5g_band", "nr5g_disable_mode")}
        if str(prefs.get("nr5g_disable_mode") or "") not in ("0", ""):
            findings.append(
                f"nr5g_disable_mode is {prefs['nr5g_disable_mode']}. This "
                "firmware only camps on SA with 0.")
        if str(prefs.get("nr5g_band") or "") in ("0", ""):
            findings.append(
                "nr5g_band is empty or zero — the band mask is stuck. Run "
                "Repair bands.")
        if not cell["rat"]:
            findings.append("No serving cell. The UE is not camped.")

        if ctx:
            ctx.step("assess", f"{len(findings)} finding(s)")
            for f in findings:
                ctx.log(f)
            if not findings:
                ctx.log("nothing obviously wrong")

        return {"findings": findings, "branches": rsrp, "cell": cell,
                "lock": lock, "prefs": prefs,
                "last_error": " ".join(by_cmd.get("AT+CEER", [])) or None}

    # -- recovery -----------------------------------------------------------
    def repair_bands(self, band="78", ctx=None):
        """fixband.sh + recover.sh: put the band mask back when it is stuck.

        force5g.sh zeroed nr5g_band on this rig and ordinary writes then stopped
        committing. Several QNWPREFCFG parameters only commit while the radio is
        off, which is what recover.sh discovered, so the ladder ends with a
        CFUN=0 attempt.

        AT+QPRTPARA=3 is NOT tried. recover.sh documents it as a last resort and
        deliberately does not automate it, and it is on the console deny-list.
        """
        if ctx:
            ctx.plan(["direct", "radio-off", "verify"])
            ctx.step("direct", "trying band writes with the radio on")

        for syntax in BAND_SYNTAXES:
            for value in (band, FULL_NR_BANDS):
                cmd = f'AT+QNWPREFCFG="nr5g_band",{syntax.format(bands=value)}'
                try:
                    self.bus.command(cmd, timeout=10, priority=P_HIGH,
                                     reason="band-repair")
                    read = self.prefs().get("nr5g_band")
                    if ctx:
                        ctx.log(f"{cmd} -> reads back {read!r}")
                    if read and str(read) not in ("0", ""):
                        if ctx:
                            ctx.step("verify", f"band mask is {read}")
                        return {"repaired": True, "nr5g_band": read,
                                "method": "direct"}
                except AtError as exc:
                    if ctx:
                        ctx.log(f"{cmd} -> {exc.kind}")

        if ctx:
            ctx.step("radio-off",
                     "retrying with the radio off — several QNWPREFCFG "
                     "parameters only commit at CFUN=0")
        try:
            self.bus.script(["AT+CFUN=0"], timeout=20, priority=P_URGENT,
                            reason="band-repair-off")
            time.sleep(2)
            for value in (band, FULL_NR_BANDS):
                cmd = f'AT+QNWPREFCFG="nr5g_band",{value}'
                try:
                    self.bus.command(cmd, timeout=10, priority=P_HIGH,
                                     reason="band-repair")
                    if ctx:
                        ctx.log(f"{cmd} (radio off)")
                except AtError as exc:
                    if ctx:
                        ctx.log(f"{cmd} -> {exc.kind}")
        finally:
            self.bus.script(["AT+CFUN=1"], timeout=20, priority=P_URGENT,
                            reason="band-repair-on")
            time.sleep(3)

        read = self.prefs().get("nr5g_band")
        if ctx:
            ctx.step("verify", f"band mask reads {read!r}")
        if read and str(read) not in ("0", ""):
            return {"repaired": True, "nr5g_band": read, "method": "radio-off"}

        raise RadioError(
            "the band mask is still empty after both the direct and radio-off "
            "ladders. recover.sh's last resort is AT+QPRTPARA=3, which restores "
            "NV to defaults — that is deliberately not automated here. Read the "
            "note in docs/reference/recover.sh before running it by hand.")
