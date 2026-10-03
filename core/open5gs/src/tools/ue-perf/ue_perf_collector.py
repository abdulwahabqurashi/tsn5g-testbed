#!/usr/bin/env python3
"""
UE performance collector (core-side) for the AMRC 5G-TSN testbed.

Samples the UPF NW-TT per-session counters and the SMF/AMF session state on a
fixed interval, derives UL/DL throughput + packet rate + loss + jitter, and
(optionally) actively measures round-trip latency to the device with ping.
Writes one JSON object per sample to a .jsonl file for ue_perf_dashboard.py.

Stdlib only. Run on the core host.

  ./ue_perf_collector.py --duration 120 --interval 2 --ping-target 192.168.8.50
"""
import argparse, json, re, subprocess, time, urllib.request

UPF_TSNINFO = "http://127.0.0.7:9090/tsn-info"
SMF_PDUINFO = "http://127.0.0.4:9090/pdu-info"
AMF_UEINFO  = "http://127.0.0.5:9090/ue-info"

def get_json(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None

def first_port(tsn):
    if not tsn or not tsn.get("ports"):
        return None
    return tsn["ports"][0]

def ping_stats(target, count, interval):
    """Return (min, avg, max, mdev, loss%) in ms, or None."""
    try:
        out = subprocess.run(
            ["ping", "-n", "-c", str(count), "-i", str(interval), "-W", "1", target],
            capture_output=True, text=True, timeout=count*interval + 4).stdout
    except Exception:
        return None
    loss = 100.0
    m = re.search(r"(\d+(?:\.\d+)?)% packet loss", out)
    if m: loss = float(m.group(1))
    m = re.search(r"= ([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+) ms", out)
    if not m:
        return (None, None, None, None, loss)
    return (float(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4)), loss)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration", type=float, default=120, help="seconds (0 = until Ctrl+C)")
    ap.add_argument("--interval", type=float, default=2.0, help="sample interval (s)")
    ap.add_argument("--ping-target", default=None, help="device IP for active latency")
    ap.add_argument("--ping-count", type=int, default=5)
    ap.add_argument("--out", default="/tmp/ue_perf.jsonl")
    a = ap.parse_args()

    f = open(a.out, "w")
    print("collecting -> %s  (interval %.1fs, %s)" % (
        a.out, a.interval, ("ping " + a.ping_target) if a.ping_target else "no ping"))
    print("%6s %8s %8s %8s %8s %7s %9s %6s" %
          ("t(s)", "DL Mbps", "UL Mbps", "DL pps", "UL pps", "drop", "lat avg", "cm"))

    t0 = time.monotonic()
    prev = None  # (mono, rx_bytes, tx_bytes, rx_frames, tx_frames)
    try:
        while True:
            now = time.monotonic()
            trel = now - t0
            tsn = get_json(UPF_TSNINFO)
            pdu = get_json(SMF_PDUINFO)
            ue  = get_json(AMF_UEINFO)
            port = first_port(tsn)
            tr = (port or {}).get("traffic", {}) if port else {}
            rx_b = tr.get("rx_bytes", 0); tx_b = tr.get("tx_bytes", 0)
            rx_f = tr.get("rx_frames", 0); tx_f = tr.get("tx_frames", 0)
            psfp = (port or {}).get("psfp", {}) if port else {}
            jit = (port or {}).get("jitter", {}) if port else {}

            dl_mbps = ul_mbps = dl_pps = ul_pps = 0.0
            if prev:
                dt = now - prev[0]
                if dt > 0:
                    ul_mbps = max(0.0, (rx_b - prev[1]) * 8 / dt / 1e6)
                    dl_mbps = max(0.0, (tx_b - prev[2]) * 8 / dt / 1e6)
                    ul_pps  = max(0.0, (rx_f - prev[3]) / dt)
                    dl_pps  = max(0.0, (tx_f - prev[4]) / dt)
            prev = (now, rx_b, tx_b, rx_f, tx_f)

            # session metadata
            active = False; qfi = fiveqi = None
            if pdu and pdu.get("items"):
                p0 = pdu["items"][0]["pdu"][0]
                active = (p0.get("pdu_state") == "active")
                qf = (p0.get("qos_flows") or [{}])[0]
                qfi = qf.get("qfi"); fiveqi = qf.get("5qi")
            cm = "-"
            if ue and ue.get("items"):
                cm = ue["items"][0].get("cm_state", "-")

            rec = {
                "t": round(trel, 2),
                "dl_mbps": round(dl_mbps, 4), "ul_mbps": round(ul_mbps, 4),
                "dl_pps": round(dl_pps, 1), "ul_pps": round(ul_pps, 1),
                "rx_bytes": rx_b, "tx_bytes": tx_b,
                "dropped": psfp.get("dropped_frames", 0),
                "jitter_us": round((jit.get("current_ns", 0) or 0) / 1000.0, 3),
                "ue_mac": (port or {}).get("ue_mac"),
                "cm_state": cm, "qfi": qfi, "fiveqi": fiveqi, "active": active,
            }

            if a.ping_target:
                ps = ping_stats(a.ping_target, a.ping_count,
                                max(0.2, a.interval / (a.ping_count + 1)))
                if ps:
                    rec["lat_min"], rec["lat_avg"], rec["lat_max"], rec["lat_mdev"], rec["lat_loss"] = ps

            f.write(json.dumps(rec) + "\n"); f.flush()
            print("%6.0f %8.2f %8.2f %8.0f %8.0f %7d %9s %6s" % (
                trel, dl_mbps, ul_mbps, dl_pps, ul_pps, rec["dropped"],
                ("%.1f" % rec["lat_avg"]) if rec.get("lat_avg") else "-", cm))

            if a.duration and trel >= a.duration:
                break
            # ping already consumed time; sleep the remainder
            spent = time.monotonic() - now
            if spent < a.interval:
                time.sleep(a.interval - spent)
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        f.close()
        print("wrote %s" % a.out)

if __name__ == "__main__":
    main()
