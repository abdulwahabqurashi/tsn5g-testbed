#!/usr/bin/env python3
"""Per-flow results for one lcp-test.sh run directory, or the Test 3 ramp.

For each flow: sent packets, received packets, loss %, and receiver-side
throughput. Throughput is the one the brief insists on: under backpressure a
UDP sender slows down instead of dropping, so a failed protection can show as
low throughput with 0% loss. Also reports what the host qdisc dropped, which
separates loss before the modem from loss in or after it.

Usage:  lcp-analyse.py RUN_DIR/testN
        lcp-analyse.py --ramp RUN_DIR
"""

import glob
import json
import os
import re
import sys

GBR_PORT = int(os.environ.get("GBR_SOURCE_PORT", os.environ.get("GBR_PORT", 5202)))


def flow(path):
    d = json.load(open(path))
    if d.get("error"):
        return {"error": d["error"]}
    end = d.get("end", {})
    sent = end.get("sum_sent") or end.get("sum") or {}
    recv = end.get("sum_received") or {}
    srv = (d.get("server_output_json") or {}).get("end", {})
    srv_sum = srv.get("sum_received") or srv.get("sum") or {}
    summ = end.get("sum") or {}
    packets = summ.get("packets") or sent.get("packets")
    lost = summ.get("lost_packets")
    rx_bps = recv.get("bits_per_second") or srv_sum.get("bits_per_second")
    tx_bps = sent.get("bits_per_second")
    streams = d.get("start", {}).get("connected", [])
    return {
        "packets": packets, "lost": lost,
        "received": packets - lost if packets is not None and lost is not None else None,
        "loss_pct": summ.get("lost_percent"),
        "tx_mbps": tx_bps / 1e6 if tx_bps else None,
        "rx_mbps": rx_bps / 1e6 if rx_bps else None,
        "jitter_ms": summ.get("jitter_ms"),
        "src_ports": sorted({c.get("local_port") for c in streams}),
    }


def qdisc_drops(run):
    def read(name):
        try:
            txt = open(os.path.join(run, name)).read()
        except OSError:
            return None
        m = re.search(r"Sent \d+ bytes (\d+) pkt \(dropped (\d+)", txt)
        return (int(m.group(1)), int(m.group(2))) if m else None
    a, b = read("qdisc-before.txt"), read("qdisc-after.txt")
    if not a or not b:
        return None
    sent, drop = b[0] - a[0], b[1] - a[1]
    return drop, 100 * drop / max(1, sent + drop)


def fmt(v, f="{:.2f}"):
    return "-" if v is None else f.format(v)


def one(run):
    print(f"\n{os.path.basename(run)}")
    print(f"  {'flow':<6}{'src port':>12}{'sent pkts':>11}{'rcvd pkts':>11}{'loss %':>8}"
          f"{'tx Mbit/s':>11}{'rx Mbit/s':>11}{'jitter ms':>10}")
    for path in sorted(glob.glob(os.path.join(run, "*.json"))):
        name = os.path.basename(path)[:-5]
        if name.startswith("qdisc"):
            continue
        f = flow(path)
        if "error" in f:
            print(f"  {name:<6} ERROR: {f['error']}")
            continue
        ports = ",".join(map(str, f["src_ports"])) or "-"
        print(f"  {name:<6}{ports:>12}{fmt(f['packets'], '{:d}'):>11}{fmt(f['received'], '{:d}'):>11}"
              f"{fmt(f['loss_pct']):>8}{fmt(f['tx_mbps']):>11}{fmt(f['rx_mbps']):>11}"
              f"{fmt(f['jitter_ms'], '{:.3f}'):>10}")
    q = qdisc_drops(run)
    if q:
        print(f"  host qdisc (wwan0 pfifo) dropped {q[0]} packets ({q[1]:.2f}%) — "
              f"{'loss before the modem' if q[0] else 'nothing lost before the modem'}")
    # With UE shaping (Test 2c) the UE drops everything above the shaped rate
    # on purpose, so iperf3's loss % is mostly deliberate. What matters is what
    # was lost AFTER the packets left the UE: class "sent" vs received.
    before = os.path.join(run, "classes-before.txt")
    after = os.path.join(run, "classes-after.txt")
    if os.path.exists(before) and os.path.exists(after):
        def sent(path):
            out, cls = {}, None
            for line in open(path):
                m = re.match(r"class htb (\S+)", line)
                if m:
                    cls = m.group(1)
                m = re.search(r"Sent \d+ bytes (\d+) pkt", line)
                if m and cls:
                    out[cls] = int(m.group(1))
            return out
        a_, b_ = sent(before), sent(after)
        for name, cls in (("gbr", "1:10"), ("flood", "1:20")):
            path = os.path.join(run, name + ".json")
            if cls in a_ and cls in b_ and os.path.exists(path):
                left = b_[cls] - a_[cls]
                f = flow(path)
                if f.get("received") is not None and left:
                    lost = left - f["received"]
                    print(f"  {name:<6} left the UE {left}, received {f['received']}: "
                          f"lost AFTER the UE {lost} ({100 * lost / left:.2f}%)")

    gbr = os.path.join(run, "gbr.json")
    if os.path.exists(gbr):
        ports = flow(gbr).get("src_ports") or []
        if ports and ports != [GBR_PORT]:
            print(f"  WARNING: the GBR flow left from source port(s) {ports}, not {GBR_PORT} — "
                  f"it did not match QFI 2")


def ramp(root):
    rows = []
    for d in glob.glob(os.path.join(root, "test3-flood*")):
        m = re.search(r"flood(\d+)$", d)
        if not m:
            continue
        g = flow(os.path.join(d, "gbr.json"))
        f = flow(os.path.join(d, "flood.json"))
        rows.append((int(m.group(1)), g, f, qdisc_drops(d)))
    rows.sort(key=lambda r: r[0])
    print("\nTEST 3 ramp — protected (GBR, 20 Mbit/s offered) against the default-flow flood")
    print(f"  {'flood offered':>14}{'GBR rx Mbit/s':>15}{'GBR loss %':>11}"
          f"{'flood rx Mbit/s':>17}{'flood loss %':>13}{'host drops %':>13}")
    for rate, g, f, q in rows:
        print(f"  {rate:>11} M{fmt(g.get('rx_mbps')):>15}{fmt(g.get('loss_pct')):>11}"
              f"{fmt(f.get('rx_mbps')):>17}{fmt(f.get('loss_pct')):>13}{fmt(q and q[1]):>13}")
    print("  LCP working: GBR holds ~20 until total offered load passes the ceiling, then "
          "degrades gracefully. Tracking the flood from the start: no prioritisation.")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--ramp":
        ramp(sys.argv[2])
    elif len(sys.argv) == 2:
        one(sys.argv[1])
    else:
        sys.exit(__doc__)
