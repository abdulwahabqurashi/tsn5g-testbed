#!/usr/bin/env python3
"""Turn a demo-run.sh output directory into the results table.

Separate from the runner so a run can be re-analysed — the first two runs on
1 Oct had to be re-sliced by hand after the UE/core clock offset was found.

Per phase:
  cam1 / cam2  datagrams that reached the core, as % of the baseline phase
  carried      everything the core received from the UE, Mbit/s — the radio's
               delivered capacity in that phase
  UE drop      what the host queue discarded, per lane (limited only)
  RSRP / SINR  mean over the phase, and the SINR minimum

A limited phase whose protected camera lost datagrams that the UE queue did not
drop is flagged "radio": that loss happened after the queue, where no host
policy can reach. Flagged phases are left out of the policy summary rather than
averaged in, and the count of them is printed.

Usage:  demo-analyse.py RUN_DIR
"""

import csv
import json
import os
import re
import statistics
import sys

PORTS = (os.environ.get("CAM1_PORT", "50451"), os.environ.get("CAM2_PORT", "50452"))


def load(run):
    phases = list(csv.DictReader(open(os.path.join(run, "phases.tsv")), delimiter="\t"))
    offset = float(open(os.path.join(run, "clock-offset.txt")).read())
    rx = []
    for line in open(os.path.join(run, "core.txt")):
        parts = line.split()
        try:
            t, dst = float(parts[0]), parts[1].rstrip(":").rsplit(".", 1)[1]
            length = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
        except (ValueError, IndexError):
            continue
        # core clock -> UE clock, so it lines up with the phase boundaries
        rx.append((t + offset, dst, length))
    tc = {}
    for r in csv.DictReader(open(os.path.join(run, "tc.tsv")), delimiter="\t"):
        tc[(r["phase"], r["class"])] = (int(r["pkts"]), int(r["dropped"]))
    sig = []
    path = os.path.join(run, "signal.tsv")
    if os.path.exists(path):
        for r in csv.DictReader(open(path), delimiter="\t"):
            try:
                sig.append((float(r["t"]), float(r["rsrp"]), float(r["sinr"])))
            except (TypeError, ValueError):
                pass
    return phases, rx, tc, sig


def main(run):
    phases, rx, tc, sig = load(run)

    def window(p):
        return float(p["start"]), float(p["end"])

    def cam(p, port):
        t0, t1 = window(p)
        hits = [n for t, d, n in rx if t0 <= t < t1 and d == port]
        return len(hits) / (t1 - t0), sum(hits) * 8 / (t1 - t0) / 1e6

    def lane_drop(p, cls):
        a = tc.get((p["phase"] + "-start", cls))
        b = tc.get((p["phase"] + "-end", cls))
        if not a or not b:
            return None
        sent, drop = b[0] - a[0], b[1] - a[1]
        return 100 * drop / max(1, sent + drop)

    def flood_rx(p):
        if p["flood"] == "no":
            return 0.0
        try:
            txt = open(os.path.join(run, f"iperf-{p['phase']}.txt")).read()
        except OSError:
            return None
        m = re.search(r"([\d.]+) Mbits/sec\s+[\d.]+ ms\s+\d+/\d+ \(([\d.]+)%\)\s+receiver", txt)
        return float(m.group(1)) if m else None

    def radio(p):
        t0, t1 = window(p)
        s = [(r, q) for t, r, q in sig if t0 <= t < t1]
        if not s:
            return None
        return (statistics.mean(r for r, _ in s), statistics.mean(q for _, q in s),
                min(q for _, q in s))

    base = {port: cam(phases[0], port)[0] for port in PORTS}

    def pct(v, port):
        return v / base[port] * 100 if base[port] else 0.0

    def fmt(v, f):
        return "   n/a" if v is None else f.format(v)

    print()
    print(f"{'phase':<12}{'policy':<9}{'cam1':>8}{'cam2':>8}{'carried':>9}{'flood':>8}"
          f"{'UE drop':>9}{'UE drop':>9}{'RSRP':>7}{'SINR':>6}{'min':>5}  note")
    print(f"{'':<12}{'':<9}{'core%':>8}{'core%':>8}{'Mbit/s':>9}{'Mbit/s':>8}"
          f"{'1:10':>9}{'1:20':>9}{'dBm':>7}{'dB':>6}{'dB':>5}")
    groups = {"on": [], "off": []}
    for p in phases:
        c1, m1 = cam(p, PORTS[0])
        c2, m2 = cam(p, PORTS[1])
        f = flood_rx(p)
        carried = m1 + m2 + (f or 0)
        d10, d20 = lane_drop(p, "1:10"), lane_drop(p, "1:20")
        rad = radio(p)
        note = ""
        if p["flood"] == "yes" and f is None:
            note = "flood failed"
        elif (p["policy"] == "limited" and d10 is not None and d10 < 0.1
              and pct(c1, PORTS[0]) < 95):
            note = "radio: protected loss after the queue"
        if p["name"] in groups:
            groups[p["name"]].append((pct(c1, PORTS[0]), pct(c2, PORTS[1]), note))
        print(f"{p['phase'] + ' ' + p['name']:<12}{p['policy']:<9}"
              f"{pct(c1, PORTS[0]):7.1f}%{pct(c2, PORTS[1]):7.1f}%{carried:9.1f}"
              f"{fmt(f, '{:8.1f}')}{fmt(d10, '{:8.1f}%')}{fmt(d20, '{:8.1f}%')}"
              f"{fmt(rad and rad[0], '{:7.0f}')}{fmt(rad and rad[1], '{:6.0f}')}"
              f"{fmt(rad and rad[2], '{:5.0f}')}  {note}")

    # Delivery against what the UE actually sent (per-camera counters).
    print()
    print("delivered to the core / sent by the UE (whole datagrams):")
    for p in phases:
        try:
            a = json.load(open(os.path.join(run, f"counters-{p['phase']}-start.json")))
            z = json.load(open(os.path.join(run, f"counters-{p['phase']}-end.json")))
        except (OSError, ValueError):
            continue
        sent = {}
        for s0 in a.get("streams", []):
            s1 = next((x for x in z.get("streams", []) if x["name"] == s0["name"]), None)
            if s1 and s0.get("pkts") is not None and s1.get("pkts") is not None:
                sent[s0["dport"]] = s1["pkts"] - s0["pkts"]
        t0, t1 = window(p)
        parts = []
        for port, name in ((int(PORTS[0]), "camera1"), (int(PORTS[1]), "camera2")):
            got = sum(1 for t, d, n in rx if t0 <= t < t1 and d == str(port))
            # counters span the snapshot instants, the capture the phase window:
            # scale the sent count to the window length
            span = float(z.get("t", 0)) - float(a.get("t", 0))
            s_ = sent.get(port)
            if s_ and span > 0:
                s_ = s_ * (t1 - t0) / span
                parts.append(f"{name} {100 * got / s_:5.1f}%")
        print(f"  phase {p['phase']} {p['name']:<9} " + "   ".join(parts))

    print()
    for name, label in (("off", "policy off"), ("on", "policy on ")):
        rows = groups[name]
        clean = [r for r in rows if not r[2]]
        if not clean:
            print(f"{label}: no clean phase")
            continue
        print(f"{label}: camera 1 {statistics.mean(r[0] for r in clean):5.1f}%   "
              f"camera 2 {statistics.mean(r[1] for r in clean):5.1f}%   "
              f"({len(clean)} clean phase(s), {len(rows) - len(clean)} flagged)")
    for p in phases:
        try:
            ar = json.load(open(os.path.join(run, f"autorate-{p['phase']}.json")))
            bd = json.load(open(os.path.join(run, f"binding-{p['phase']}.json")))
        except (OSError, ValueError):
            continue
        g = [c["name"] for c in bd.get("cameras", []) if c.get("gbr_bearer")]
        print(f"phase {p['phase']}: auto-rate {'on at ' + str(ar.get('rate_mbps')) + ' Mbit/s' if ar.get('active') else 'off'}; "
              f"GBR bearer: {', '.join(g) or 'none'}")
    print(f"\nbaseline at the core: camera 1 {base[PORTS[0]]:.0f} datagrams/s, "
          f"camera 2 {base[PORTS[1]]:.0f} datagrams/s")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
