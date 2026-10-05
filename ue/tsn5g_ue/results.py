"""
Results of the measurement tools, for the Tests page.

The tools (tools/gnb-drift.sh, tools/qbv-live.sh, tools/demo-run.sh) run as
the desktop user and leave one directory per run in that user's home:

  ~/gnb-drift/<YYYYmmdd-HHMMSS>/   scan-N.json + scan-N.time
  ~/qbv-runs/<…>/                  <phase>.talker.json, <phase>.flood.json, run.log
  ~/demo-runs/<…>/                 results.txt (the table demo-analyse prints)
  ~/radio-loss/<…>/                A..D-*.json, one iperf3 report per variant

This module only reads them; testrun.py starts them.
"""

import glob
import json
import os
import pwd
import re
import time

from . import rig

KINDS = {"drift": "gnb-drift", "qbv": "qbv-runs", "demo": "demo-runs", "loss": "radio-loss"}
LABEL = {"drift": "Radio clock drift", "qbv": "Qbv / priority uplink test", "demo": "Camera demo", "loss": "Uplink loss"}
CYCLE_US = 5000
QBV_PHASES = ["P-baseline", "A-none", "B-uni", "B-sch", "F-uni", "F-sch", "G-sch", "R-auto"]
QBV_NAMES = {"P-baseline": "Idle radio", "A-none": "Flood, no policy", "B-uni": "Priority",
             "B-sch": "Priority, timed talker", "F-uni": "4 ms gate", "F-sch": "4 ms gate, timed",
             "G-sch": "5 ms gate, timed", "R-auto": "Auto-rate (live policy)"}
_ID = re.compile(r"^\d{8}-\d{6}$")


def _home():
    try:
        return pwd.getpwnam(rig.DESKTOP_USER).pw_dir
    except KeyError:
        return os.path.expanduser("~")


def _load(path):
    try:
        with open(path) as f:
            t = f.read()
        return json.loads(t[t.index("{"):])
    except (OSError, ValueError):
        return None


def _dir(kind, run_id):
    if kind not in KINDS or not _ID.match(run_id or ""):
        raise KeyError(f"unknown run {kind}/{run_id}")
    d = os.path.join(_home(), KINDS[kind], run_id)
    if not os.path.isdir(d):
        raise KeyError(f"no such run {kind}/{run_id}")
    return d


def _started(run_id):
    return time.mktime(time.strptime(run_id, "%Y%m%d-%H%M%S"))


# ------------------------------------------------------------------ drift
def drift(d):
    scans = []
    files = sorted(glob.glob(f"{d}/scan-*.json"),
                   key=lambda p: int(re.search(r"scan-(\d+)", p).group(1)))
    for f in files:
        n = re.search(r"scan-(\d+)", f).group(1)
        data, tm = _load(f), _load(f"{d}/scan-{n}.time")
        if not data or not tm:
            continue
        po = data.get("per_offset_us") or {}
        offs = sorted(int(o) for o in po)
        if len(offs) < 10:
            continue
        curve = [po[str(o)].get("p10", po[str(o)].get("p50")) for o in offs]
        k = max(range(len(offs)), key=lambda i: curve[(i + 1) % len(offs)] - curve[i])
        scans.append({"t": tm["t"], "offsets_us": offs, "p10_us": curve,
                      "edge_us": offs[(k + 1) % len(offs)],
                      "received": data.get("received"), "loss_pct": data.get("loss_pct")})
    out = {"scans": scans, "cycle_us": CYCLE_US, "verdict": "running", "drift_us_per_min": None,
           "ppm": None, "spread_us": None}
    if len(scans) >= 3:
        ph = [scans[0]["edge_us"]]
        for s in scans[1:]:
            step = (s["edge_us"] - ph[-1] % CYCLE_US + CYCLE_US / 2) % CYCLE_US - CYCLE_US / 2
            ph.append(ph[-1] + step)
        ts = [(s["t"] - scans[0]["t"]) / 60 for s in scans]
        mt, mp = sum(ts) / len(ts), sum(ph) / len(ph)
        den = sum((a - mt) ** 2 for a in ts) or 1e-9
        slope = sum((a - mt) * (b - mp) for a, b in zip(ts, ph)) / den
        spread = max(ph) - min(ph)
        step_us = scans[0]["offsets_us"][1] - scans[0]["offsets_us"][0]
        for s, p in zip(scans, ph):
            s["edge_unwrapped_us"] = p
        out.update({"drift_us_per_min": round(slope, 1), "ppm": round(slope / 60, 3),
                    "spread_us": round(spread),
                    "verdict": "stable" if spread <= 2 * step_us else "drifting"})
        if out["verdict"] == "drifting" and slope:
            out["full_cycle_hours"] = round(CYCLE_US / abs(slope) / 60, 1)
    if os.path.exists(f"{d}/result.txt"):
        out["finished"] = True
    return out


# ------------------------------------------------------------------ qbv
def qbv(d):
    head = ""
    try:
        with open(f"{d}/run.log") as f:
            head = f.readline().strip()
    except OSError:
        pass
    m = re.search(r"shaper (\d+) Mbit/s; flood (\d+)", head)
    phases = []
    for name in QBV_PHASES:
        t = _load(f"{d}/{name}.talker.json")
        if not t or "variation_us" not in t:
            continue
        fl = _load(f"{d}/{name}.flood.json") or {}
        s = (fl.get("end") or {}).get("sum")
        v = t["variation_us"]
        phases.append({"phase": name, "label": QBV_NAMES.get(name, name),
                       "loss_pct": t.get("loss_pct"), "received": t.get("received"),
                       "expected": t.get("expected"),
                       "p50_ms": round(v["p50"] / 1000, 2), "p99_ms": round(v["p99"] / 1000, 2),
                       "max_ms": round(v["max"] / 1000, 2),
                       "flood_mbps": round(s["bits_per_second"] * (1 - s["lost_percent"] / 100) / 1e6, 1)
                       if s else None})
    sweep = (_load(f"{d}/S-sweep.talker.json") or {}).get("per_offset_us")
    return {"shaper_mbps": int(m.group(1)) if m else None, "flood_mbps": int(m.group(2)) if m else None,
            "phases": phases,
            "sweep": [{"offset_us": int(o), "p50_us": v["p50"]} for o, v in sorted(
                (sweep or {}).items(), key=lambda kv: int(kv[0]))]}


# ------------------------------------------------------------------ demo
_ROW = re.compile(r"^\s*(\d+)\s+(\w+)\s+(\w+)\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)\s+([\d.]+)")
_SUM = re.compile(r"policy (off|on)\s*:\s*camera 1\s+([\d.]+)%\s+camera 2\s+([\d.]+)%")


def demo(d):
    rows, summary = [], {}
    try:
        text = open(f"{d}/results.txt").read()
    except OSError:
        # still running: phases.tsv gains a line as each phase finishes
        done = []
        try:
            with open(f"{d}/phases.tsv") as f:
                for line in f.read().splitlines()[1:]:
                    c = line.split("\t")
                    if len(c) >= 4:
                        done.append({"phase": int(c[0]), "name": c[1], "policy": c[2], "flood": c[3]})
        except (OSError, ValueError):
            pass
        return {"phases": [], "summary": {}, "running": True, "done": done, "total": 7}
    for line in text.splitlines():
        m = _ROW.match(line)
        if m:
            rows.append({"phase": int(m.group(1)), "name": m.group(2), "policy": m.group(3),
                         "cam1_pct": float(m.group(4)), "cam2_pct": float(m.group(5)),
                         "carried_mbps": float(m.group(6)), "flood_mbps": float(m.group(7))})
            # then two UE-drop columns, RSRP, SINR, min SINR: the first two plain integers
            ints = [int(t) for t in line.split()[7:] if re.fullmatch(r"-?\d+", t)]
            rows[-1].update({"rsrp_dbm": ints[0] if ints else None,
                             "sinr_db": ints[1] if len(ints) > 1 else None})
        m = _SUM.search(line)
        if m:
            summary[m.group(1)] = {"cam1_pct": float(m.group(2)), "cam2_pct": float(m.group(3))}
    return {"phases": rows, "summary": summary}


LOSS_NAMES = {"A": "1300-byte, smooth", "B": "1472-byte, smooth",
              "C": "1472-byte, bursts", "D": "Bursts on the GBR flow"}


def loss(d):
    rows = []
    for name in sorted(LOSS_NAMES):
        f = next(iter(glob.glob(f"{d}/{name}-*.json")), None)
        if not f:
            continue
        r = _load(f) or {}
        if r.get("error") or "end" not in r:
            rows.append({"variant": name, "name": LOSS_NAMES[name], "error": r.get("error") or "no result"})
            continue
        s = r["end"]["sum"]
        rows.append({"variant": name, "name": LOSS_NAMES[name], "sent": s.get("packets"),
                     "lost": s.get("lost_packets"), "loss_pct": round(s.get("lost_percent", 0), 2),
                     "jitter_ms": round(s.get("jitter_ms", 0), 2)})
    return {"variants": rows, "running": len(rows) < len(LOSS_NAMES)}


# ------------------------------------------------------------------ index
def _headline(kind, data):
    if kind == "drift":
        if data["verdict"] == "running":
            return f"{len(data['scans'])} scan(s) so far"
        return (f"{data['verdict']}: {data['drift_us_per_min']:+} µs/min "
                f"({data['ppm']:+} ppm) over {len(data['scans'])} scans")
    if kind == "qbv":
        r = {p["phase"]: p for p in data["phases"]}
        best = r.get("R-auto") or r.get("B-uni")
        return (f"{len(data['phases'])} phase(s); protected p99 {best['p99_ms']} ms"
                if best else f"{len(data['phases'])} phase(s)")
    if kind == "loss":
        ok = [v for v in data["variants"] if "loss_pct" in v]
        if data["running"]:
            return f"in progress: {len(data['variants'])} of {len(LOSS_NAMES)} variants"
        return ("loss " + " · ".join(f"{v['variant']} {v['loss_pct']}%" for v in ok)) if ok else "no result"
    if kind == "demo":
        if data.get("running"):
            return f"in progress: {len(data['done'])} of {data['total']} phases done"
        on, off = data["summary"].get("on"), data["summary"].get("off")
        return (f"camera 1: {on['cam1_pct']}% with policy, {off['cam1_pct']}% without"
                if on and off else f"{len(data['phases'])} phase(s)")
    return ""


PARSE = {"drift": drift, "qbv": qbv, "demo": demo, "loss": loss}


def list_runs(limit=40):
    runs = []
    for kind, sub in KINDS.items():
        for d in glob.glob(os.path.join(_home(), sub, "*")):
            rid = os.path.basename(d)
            if not _ID.match(rid):
                continue
            try:
                data = PARSE[kind](d)
            except Exception:                  # noqa: BLE001 — one bad run must not hide the rest
                continue
            runs.append({"kind": kind, "id": rid, "label": LABEL[kind], "started": _started(rid),
                         "headline": _headline(kind, data)})
    runs.sort(key=lambda r: -r["started"])
    return runs[:limit]


def get(kind, run_id):
    d = _dir(kind, run_id)
    data = PARSE[kind](d)
    return {"kind": kind, "id": run_id, "label": LABEL[kind], "started": _started(run_id), **data}
