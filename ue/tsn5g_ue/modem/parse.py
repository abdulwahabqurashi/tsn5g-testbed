"""
Parsers for Quectel AT responses.

Pure functions over strings, so every format quirk below is covered by tests
rather than discovered on hardware at an awkward moment. Each parser takes the
raw response lines and returns a dict; unknown or absent fields are None rather
than missing, so callers never have to guess whether a key exists.

Formats verified against an RM520N-GL running RM520NGLAAR03A01M4G.
"""

import re

# +QENG: "servingcell","NOCONN","NR5G-SA","TDD",001,02,2E9B00,1,624000,78,12,-102,-10,18,...
#          state         ^rat            dup  mcc mnc cellid pci arfcn band bw rsrp rsrq sinr
_QENG_NR_FIELDS = ("state", "rat", "duplex", "mcc", "mnc", "cellid", "pci",
                   "arfcn", "band", "bandwidth", "rsrp", "rsrq", "sinr")


def _int(text):
    try:
        return int(str(text).strip().strip('"'))
    except (TypeError, ValueError):
        return None


def _plausible(value, lo, hi):
    return value if value is not None and lo <= value <= hi else None


def qeng(lines):
    """Serving-cell report.

    Positional parsing with a sanity check rather than blind indexing. The
    field count varies with firmware and RAT, and the cell id is hex — which is
    what defeated the previous digit-scanning approach. We locate RSRP by
    plausibility (-140..-40 dBm) and read the neighbours relative to it, then
    cross-check against the fixed layout when the field count matches.
    """
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {k: None for k in _QENG_NR_FIELDS}
    out["raw"] = text.strip() or None

    if "+QENG:" not in text:
        return out

    body = text.split("+QENG:", 1)[1]
    fields = [f.strip().strip('"') for f in body.split(",")]
    # fields[0] is "servingcell"; drop it.
    if fields and fields[0].lower() == "servingcell":
        fields = fields[1:]

    rat = next((f for f in fields[:3] if f.upper().startswith(("NR5G", "LTE", "WCDMA", "GSM"))), None)
    out["rat"] = rat
    out["state"] = fields[0] if fields else None

    if rat and rat.upper().startswith("NR5G"):
        # Everything after the RAT token.
        try:
            tail = fields[fields.index(rat) + 1:]
        except ValueError:
            tail = fields
        vals = [_int(f) for f in tail]

        for i, v in enumerate(vals):
            if _plausible(v, -140, -40) is None:
                continue
            # RSRQ (-30..0) and SINR (-20..40) must follow for this to be RSRP
            # rather than, say, a negative offset field.
            rsrq = _plausible(vals[i + 1], -30, 0) if i + 1 < len(vals) else None
            sinr = _plausible(vals[i + 2], -25, 40) if i + 2 < len(vals) else None
            if rsrq is None:
                continue
            out["rsrp"], out["rsrq"], out["sinr"] = v, rsrq, sinr
            # Layout going backwards from RSRP: bandwidth, band, arfcn.
            if i >= 2 and vals[i - 2] is not None:
                out["band"] = f"n{vals[i - 2]}"
            if i >= 3 and vals[i - 3] is not None:
                out["arfcn"] = vals[i - 3]
            if i >= 4 and vals[i - 4] is not None:
                out["pci"] = vals[i - 4]
            break

        # Cell id is hex and sits before PCI; find the first hex-looking field.
        for f in tail:
            if re.fullmatch(r"[0-9A-Fa-f]{4,10}", f) and not f.isdigit():
                out["cellid"] = f.upper()
                break

    return out


def qrsrp(lines):
    """+QRSRP: -85,-120,-140,-140,NR5G — per-antenna-branch RSRP.

    All four branches at -140 (or -32768) means no RF is reaching the modem,
    which is the check rfcheck.sh exists to make. Reported per branch so a
    single dead antenna is visible rather than averaged away.
    """
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {"branches": [], "serving": None, "rat": None, "raw": text.strip() or None}
    m = re.search(r"\+QRSRP:\s*(.+)", text)
    if not m:
        return out
    parts = [p.strip() for p in m.group(1).split(",")]
    for p in parts:
        v = _int(p)
        if v is None:
            if p and not p.isdigit():
                out["rat"] = p.strip('"')
            continue
        # -32768 is the firmware's "no measurement" sentinel.
        out["branches"].append(None if v <= -32000 else v)
    live = [b for b in out["branches"] if b is not None]
    out["serving"] = max(live) if live else None
    out["no_rf"] = bool(out["branches"]) and not any(
        b is not None and b > -140 for b in out["branches"])
    return out


def qrsrq(lines):
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {"branches": [], "raw": text.strip() or None}
    m = re.search(r"\+QRSRQ:\s*(.+)", text)
    if not m:
        return out
    for p in m.group(1).split(","):
        v = _int(p)
        if v is not None:
            out["branches"].append(None if v <= -32000 else v)
    return out


def qsinr(lines):
    """+QSINR: <b0>,<b1>,... — the reference scripts read field 2."""
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {"branches": [], "value": None, "raw": text.strip() or None}
    m = re.search(r"\+QSINR:\s*(.+)", text)
    if not m:
        return out
    for p in m.group(1).split(","):
        v = _int(p)
        if v is not None:
            out["branches"].append(None if v <= -32000 else v)
    live = [b for b in out["branches"] if b is not None]
    out["value"] = live[0] if live else None
    return out


def csq(lines):
    """+CSQ: <rssi>,<ber>. 99 means "not known or not detectable"."""
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {"rssi": None, "ber": None, "raw": text.strip() or None}
    m = re.search(r"\+CSQ:\s*(\d+),(\d+)", text)
    if not m:
        return out
    raw = int(m.group(1))
    if raw != 99:
        out["rssi"] = -113 + 2 * raw       # 3GPP 27.007 mapping
    ber = int(m.group(2))
    out["ber"] = None if ber == 99 else ber
    return out


def cops(lines):
    """+COPS: <mode>,<format>,"<oper>",<act> — current operator selection."""
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {"mode": None, "operator": None, "act": None, "manual": None,
           "raw": text.strip() or None}
    m = re.search(r'\+COPS:\s*(\d+)(?:,\s*(\d+)\s*,\s*"([^"]*)"(?:\s*,\s*(\d+))?)?', text)
    if not m:
        return out
    out["mode"] = int(m.group(1))
    out["manual"] = out["mode"] == 1
    out["operator"] = m.group(3)
    out["act"] = _int(m.group(4))
    return out


def cops_scan(lines):
    """+COPS: (2,"long","short","numeric",act),(...) — available operators."""
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    found = []
    for chunk in re.findall(r"\((\d+),([^)]*)\)", text):
        status, body = chunk
        parts = [p.strip().strip('"') for p in body.split(",")]
        if not parts:
            continue
        entry = {
            "status": {"0": "unknown", "1": "available", "2": "current",
                       "3": "forbidden"}.get(status, status),
            "long": parts[0] if len(parts) > 0 else None,
            "short": parts[1] if len(parts) > 1 else None,
            "plmn": parts[2] if len(parts) > 2 else None,
            "act": _int(parts[3]) if len(parts) > 3 else None,
        }
        # The trailing (0-4),(0,1,2) capability tuples are not operators.
        if entry["plmn"] and entry["plmn"].isdigit():
            found.append(entry)
    return {"operators": found, "raw": text.strip() or None}


def registration(lines):
    """+C5GREG / +CEREG / +CREG: <n>,<stat>[,...]. stat 1 = home, 5 = roaming."""
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {"stat": None, "registered": False, "roaming": False,
           "denied": False, "searching": False, "raw": text.strip() or None}
    m = re.search(r"\+C\w*REG:\s*\d+,\s*(\d+)", text)
    if not m:
        return out
    stat = int(m.group(1))
    out["stat"] = stat
    out["registered"] = stat in (1, 5)
    out["roaming"] = stat == 5
    out["searching"] = stat == 2
    out["denied"] = stat == 3
    return out


def cpin(lines):
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {"ready": False, "state": None, "raw": text.strip() or None}
    m = re.search(r"\+CPIN:\s*(\S+)", text)
    if m:
        out["state"] = m.group(1)
        out["ready"] = m.group(1).upper() == "READY"
    return out


def cfun(lines):
    """+CFUN: <fun>. 0 = minimum, 1 = full, 4 = airplane/radio off."""
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    m = re.search(r"\+CFUN:\s*(\d+)", text)
    value = int(m.group(1)) if m else None
    return {
        "cfun": value,
        "radio": {0: "off", 1: "on", 4: "airplane"}.get(value),
        "raw": text.strip() or None,
    }


def qnwlock(lines):
    """+QNWLOCK: "common/5g",<enabled>,<arfcn>,<scs>,<band>[,<pci>]

    Argument order varies by firmware, which is why lock5g.sh tries four
    permutations. Read back by plausibility: ARFCN is large, band and SCS are
    small, PCI is 0..1007.
    """
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {"locked": False, "arfcn": None, "scs": None, "band": None,
           "pci": None, "raw": text.strip() or None}
    m = re.search(r'\+QNWLOCK:\s*"common/5g"\s*,\s*(.+)', text)
    if not m:
        return out
    vals = [_int(v) for v in m.group(1).split(",")]
    vals = [v for v in vals if v is not None]
    if not vals:
        return out
    # A leading 0 means the lock is cleared.
    if vals[0] == 0 and len(vals) == 1:
        return out
    for v in vals:
        if v > 10000 and out["arfcn"] is None:
            out["arfcn"] = v
        elif 1 <= v <= 110 and out["band"] is None and v not in (0, 1):
            out["band"] = v
        elif 0 <= v <= 4 and out["scs"] is None:
            out["scs"] = v
        elif 0 <= v <= 1007 and out["pci"] is None:
            out["pci"] = v
    out["locked"] = out["arfcn"] is not None
    return out


def qnwprefcfg(lines, key=None):
    """+QNWPREFCFG: "<key>",<value> — one preference read-back."""
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    out = {"key": key, "value": None, "raw": text.strip() or None}
    m = re.search(r'\+QNWPREFCFG:\s*"([^"]+)"\s*,\s*(.+?)(?:\s*\||$)', text)
    if m:
        out["key"] = m.group(1)
        out["value"] = m.group(2).strip().strip('"')
    return out


def qfplmn(lines):
    """+QFPLMNCFG: "get",<plmn>,... — the SIM's forbidden-PLMN list.

    This survives reboots, which is why camp.sh exists: a PLMN that landed in
    here once will be refused forever until it is deleted.
    """
    text = " ".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    plmns = []
    for m in re.finditer(r'\+QFPLMNCFG:\s*"[^"]*"\s*,\s*(.+)', text):
        for part in m.group(1).split(","):
            p = part.strip().strip('"')
            if p.isdigit() and len(p) in (5, 6):
                plmns.append(p)
    return {"forbidden": plmns, "raw": text.strip() or None}


def identity(lines_by_cmd):
    """Merge CGMM/CGMR/CGSN/CIMI/QCCID responses into one identity block.

    IMEI and ICCID are masked: they identify the device and the subscription,
    and this is rendered in a web UI that has no authentication.
    """
    def first(cmd):
        raw = lines_by_cmd.get(cmd) or []
        for ln in raw:
            ln = ln.strip()
            if ln and ln.upper() not in ("OK",) and not ln.upper().startswith("AT"):
                return ln
        return None

    def mask(value, keep=4):
        if not value:
            return None
        digits = re.sub(r"\D", "", value)
        if len(digits) <= keep:
            return digits
        return "•" * (len(digits) - keep) + digits[-keep:]

    iccid = first("AT+QCCID")
    if iccid:
        iccid = iccid.replace("+QCCID:", "").strip()

    return {
        "model": first("AT+CGMM"),
        "firmware": first("AT+CGMR"),
        "imei_masked": mask(first("AT+CGSN")),
        "iccid_masked": mask(iccid, keep=6),
    }


def qscan(lines):
    """+QSCAN: <rat>,<mcc>,<mnc>,<freq>,<pci>,<rsrp>,<rsrq>,... — cell survey."""
    text = "\n".join(lines) if isinstance(lines, (list, tuple)) else str(lines)
    cells = []
    for m in re.finditer(r"\+QSCAN:\s*(.+)", text):
        parts = [p.strip().strip('"') for p in m.group(1).split(",")]
        if len(parts) < 5:
            continue
        cells.append({
            "rat": parts[0],
            "mcc": parts[1] if len(parts) > 1 else None,
            "mnc": parts[2] if len(parts) > 2 else None,
            "arfcn": _int(parts[3]) if len(parts) > 3 else None,
            "pci": _int(parts[4]) if len(parts) > 4 else None,
            "rsrp": _plausible(_int(parts[5]), -140, -40) if len(parts) > 5 else None,
            "rsrq": _plausible(_int(parts[6]), -40, 0) if len(parts) > 6 else None,
        })
    return {"cells": cells, "raw": text.strip() or None}
