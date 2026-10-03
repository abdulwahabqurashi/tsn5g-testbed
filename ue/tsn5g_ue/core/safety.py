"""
What the raw AT console is allowed to send.

A console that can reach the modem can also brick it, and this UI has no
authentication. Two lists:

  DENY — refused outright. Each entry is something that either destroys the
         device's configuration or the path this daemon talks to it over.
  WARN — allowed with explicit confirmation, and routed through the job system
         rather than the synchronous handler, because they take longer than a
         request should and the UI needs to show progress.

Anything not matched runs normally. The point is not to second-guess the
operator — it is to make the two or three genuinely irreversible commands
require a deliberate act rather than a typo.
"""

import re

# (pattern, reason) — matched case-insensitively against the whole command.
DENY = [
    (r"\+QPRTPARA",
     "AT+QPRTPARA restores NV to factory defaults. recover.sh documents it as a "
     "last resort and deliberately does not automate it; run it by hand, having "
     "read that note first."),
    (r'\+QCFG\s*=\s*"usbnet"\s*,',
     "Changing usbnet composition destroys /dev/cdc-wdm0, which is the QMI path "
     "this daemon uses for the data call. Reading it (AT+QCFG=\"usbnet\") is fine."),
    (r"\+QNWPREFCFG\s*=\s*\"nr5g_disable_mode\"\s*,\s*[12]",
     "Verified 2026-09-08 on this firmware (RM520NGLAAR03A01M4G): only "
     "nr5g_disable_mode=0 camps on SA. Value 1 also makes nr5g_band writes fail "
     "silently, which is what stranded this rig before."),
    (r"\+EGMR", "AT+EGMR rewrites the IMEI."),
    (r"\+QFCT", "AT+QFCT enters factory test mode."),
    (r"\+CRSM|\+CSIM", "Raw SIM APDUs can permanently lock the card."),
    (r"^\s*AT&F", "AT&F resets every setting to factory defaults."),
    (r"^\s*ATZ\s*$", "ATZ resets to the stored profile, dropping current configuration."),
]

# (pattern, what will happen) — allowed, but only with confirm=true.
WARN = [
    (r"\+CFUN\s*=\s*1\s*,\s*1",
     "Full modem reset. USB re-enumerates: the AT and QMI devices disappear for "
     "roughly 40 seconds and the data call drops."),
    (r"\+CFUN\s*=\s*0",
     "Powers the radio down. The data call drops and the UE deregisters."),
    (r"\+CFUN\s*=\s*4",
     "Airplane mode. The radio stops transmitting and the bearer drops."),
    (r"\+COPS\s*=\s*2",
     "Deregisters from the network. The bearer drops until you re-register."),
    (r"\+QNWLOCK",
     "Changes cell locking. A wrong ARFCN/PCI leaves the UE unable to camp until "
     "the lock is cleared with AT+QNWLOCK=\"common/5g\",0."),
    (r'"restore_band"',
     "Restores the firmware's band configuration and requires a reset afterwards."),
    (r"\+CGACT\s*=\s*0",
     "Deactivates the PDU session. The data path drops."),
]

_DENY = [(re.compile(p, re.I), reason) for p, reason in DENY]
_WARN = [(re.compile(p, re.I), reason) for p, reason in WARN]


class CommandDenied(Exception):
    """The command matched the deny list."""

    def __init__(self, cmd, reason, rule):
        self.cmd = cmd
        self.reason = reason
        self.rule = rule
        super().__init__(reason)


class ConfirmNeeded(Exception):
    """The command matched the warn list and no confirmation was given."""

    def __init__(self, cmd, explain, rule):
        self.cmd = cmd
        self.explain = explain
        self.rule = rule
        super().__init__(explain)


def classify(cmd):
    """Return ('allow'|'warn'|'deny', reason|None, rule|None)."""
    text = (cmd or "").strip()
    for rx, reason in _DENY:
        if rx.search(text):
            return "deny", reason, rx.pattern
    for rx, reason in _WARN:
        if rx.search(text):
            return "warn", reason, rx.pattern
    return "allow", None, None


def check(cmd, confirmed=False):
    """Raise unless `cmd` may be sent. Returns the classification."""
    verdict, reason, rule = classify(cmd)
    if verdict == "deny":
        raise CommandDenied(cmd, reason, rule)
    if verdict == "warn" and not confirmed:
        raise ConfirmNeeded(cmd, reason, rule)
    return verdict


def describe():
    """The rule set, so the UI can explain itself rather than just refusing."""
    return {
        "deny": [{"pattern": p, "reason": r} for p, r in DENY],
        "warn": [{"pattern": p, "explain": r} for p, r in WARN],
    }


# The diagnostic set from docs/reference/at.py, offered as one-click buttons in
# the Debug console. All read-only.
DIAG_COMMANDS = [
    ("AT+CPIN?", "SIM state"),
    ("AT+CFUN?", "radio power"),
    ("AT+COPS?", "current operator"),
    ("AT+C5GREG?", "5G registration"),
    ("AT+CEREG?", "LTE registration"),
    ('AT+QENG="servingcell"', "serving cell"),
    ("AT+CSQ", "signal quality"),
    ("AT+QRSRP", "RSRP per antenna branch"),
    ("AT+QRSRQ", "RSRQ per antenna branch"),
    ("AT+QSINR", "SINR per antenna branch"),
    ('AT+QNWPREFCFG="mode_pref"', "RAT preference"),
    ('AT+QNWPREFCFG="nr5g_band"', "NR band mask"),
    ('AT+QNWPREFCFG="nr5g_disable_mode"', "SA/NSA mode"),
    ('AT+QNWLOCK="common/5g"', "cell lock"),
    ('AT+QFPLMNCFG="get"', "forbidden PLMN list"),
    ("AT+CGDCONT?", "PDP contexts"),
    ("AT+CGACT?", "PDP activation state"),
    ("AT+CEER", "last call failure reason"),
    ("AT+CGMM", "model"),
    ("AT+CGMR", "firmware revision"),
]
