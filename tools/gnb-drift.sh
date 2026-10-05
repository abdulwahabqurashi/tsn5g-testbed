#!/bin/bash
# Does the gNB's radio timing drift against PTP time? Decides whether the USRP
# X410 needs 10 MHz + PPS from the grandmaster.
#
#   tools/gnb-drift.sh                 (on the UE, as your normal user; ~30 min)
#   SCANS=8 GAP_MIN=5 tools/gnb-drift.sh
#
# Needs: the bearer up, the cameras STOPPED (their traffic keeps the modem
# holding grants, which hides the effect), an SSH key to the core. No sudo, no
# configuration change anywhere; the only traffic is one 100-byte packet per
# 5 ms frame.
#
# How: in an idle uplink a packet waits for the modem's next scheduling-request
# chance (sr_period_ms 5 = once per 5 ms TDD frame), then a grant. The fastest
# delay therefore depends on WHERE in the frame the packet is sent: a sawtooth
# over the 5 ms, whose jump marks where the radio's uplink timing sits on the
# PTP (TAI) clock the UE sends by. Each scan sweeps the send phase in 100 us
# steps; repeating the scan shows whether that jump stays put (X410 clock
# stable against PTP) or walks (it drifts: the rate is the X410's error in ppm).
#
# Only relative delays are used, so the 37 s TAI/UTC difference between the
# two machines' kernels does not matter. Do not restart the gNB during the
# test: that resets the radio's timing and shows as a jump.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCANS=${SCANS:-6}          # number of scans
GAP_MIN=${GAP_MIN:-5}      # minutes from the start of one scan to the next
SCAN_S=${SCAN_S:-60}       # seconds per scan
STEP_US=${STEP_US:-100}    # phase step
PORT=${PORT:-5321}
OUT=${OUT:-$HOME/gnb-drift/$(date +%Y%m%d-%H%M%S)}
die() { echo "error: $*" >&2; exit 1; }
mkdir -p "$OUT"

BIND=$(ip -4 -o addr show "$WWAN" | awk '{print $4}' | cut -d/ -f1)
[ -n "$BIND" ] || die "$WWAN has no address — bring the bearer up first"
ping -c2 -W2 -I "$WWAN" "$CORE_IP" >/dev/null 2>&1 || die "the core ($CORE_IP) does not answer over $WWAN"
pgrep -f bin/pathStream1 >/dev/null && die "the cameras are running — stop them first: sudo systemctl stop tsn5g-cameras"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$CORE_SSH" true || die "no passwordless SSH to $CORE_SSH (ssh-copy-id $CORE_SSH)"
scp -q "$TOOLS/qbv-talker.py" "$CORE_SSH:/tmp/qbv-talker.py" || die "could not copy the talker to the core"

echo "UE $BIND -> core $CORE_IP; $SCANS scans of ${SCAN_S}s, one every ${GAP_MIN} min, phase step ${STEP_US} us"
echo "about $(( (SCANS - 1) * GAP_MIN + SCAN_S / 60 + 1 )) minutes. Keep the cameras stopped and the gNB running."
for i in $(seq 1 "$SCANS"); do
    t0=$(date +%s)
    printf "  scan %d/%d at %s ... " "$i" "$SCANS" "$(date +%H:%M:%S)"
    ssh -o BatchMode=yes "$CORE_SSH" "timeout $((SCAN_S + 20)) python3 /tmp/qbv-talker.py recv --port $PORT --duration $((SCAN_S + 5)) --out /tmp/gnb-drift-$i.json" >/dev/null &
    sleep 2
    python3 "$TOOLS/qbv-talker.py" send --dst "$CORE_IP" --port "$PORT" --bind "$BIND" \
        --mode sweep --cycle-us 5000 --step-us "$STEP_US" --size 100 --duration "$SCAN_S" >/dev/null
    wait
    # cat over ssh, not scp: see qbv-live.sh (a root-made $OUT from the console)
    if ssh -o BatchMode=yes "$CORE_SSH" "cat /tmp/gnb-drift-$i.json" > "$OUT/scan-$i.json" 2>/dev/null \
            && [ -s "$OUT/scan-$i.json" ]; then
        echo "{\"t\": $t0}" > "$OUT/scan-$i.time"
        echo "done"
    else
        echo "no result"
    fi
    [ "$i" -lt "$SCANS" ] && sleep $(( t0 + GAP_MIN * 60 - $(date +%s) > 0 ? t0 + GAP_MIN * 60 - $(date +%s) : 0 ))
done

python3 - "$OUT" "$STEP_US" <<'PY' | tee "$OUT/result.txt"
import glob, json, os, sys
out, step = sys.argv[1], int(sys.argv[2])
CYCLE = 5000
scans = []
for f in sorted(glob.glob(f"{out}/scan-*.json"), key=lambda p: int(p.split("-")[-1].split(".")[0])):
    i = f.split("-")[-1].split(".")[0]
    try:
        d = json.load(open(f)); t = json.load(open(f"{out}/scan-{i}.time"))["t"]
    except Exception:
        continue
    po = d.get("per_offset_us") or {}
    offs = sorted(int(o) for o in po)
    if len(offs) < 10:
        continue
    curve = [po[str(o)]["p10"] for o in offs]          # robust "fastest" delay per phase
    # the sawtooth's jump: the largest rise from one phase to the next (wrapping round)
    n = len(offs)
    rises = [(curve[(k + 1) % n] - curve[k], k) for k in range(n)]
    rise, k = max(rises)
    edge = offs[(k + 1) % n]
    scans.append({"t": t, "edge": edge, "rise": rise, "curve": curve, "offs": offs,
                  "loss": d.get("loss_pct"), "n": d.get("received")})
if not scans:
    print("no usable scans"); sys.exit(1)

print("\nfastest delay (10th percentile) by send phase in the 5 ms frame, per scan:")
blocks = " .:-=+*#%@"
for s in scans:
    lo, hi = min(s["curve"]), max(s["curve"])
    line = "".join(blocks[min(9, int(9 * (c - lo) / max(1, hi - lo)))] for c in s["curve"])
    print(f"  {s['t'] - scans[0]['t']:>5.0f}s  |{line}|  jump at {s['edge'] / 1000:.1f} ms (+{s['rise'] / 1000:.1f} ms)")
print(f"         |{'0 ms'.ljust(len(scans[0]['curve']) // 2)}{'2.5'.ljust(len(scans[0]['curve']) - len(scans[0]['curve']) // 2 - 3)}5 ms|")

# unwrap the jump's phase over time and fit a line: the slope is the drift
ph = [scans[0]["edge"]]
for s in scans[1:]:
    d = s["edge"] - ph[-1] % CYCLE
    d = (d + CYCLE / 2) % CYCLE - CYCLE / 2
    ph.append(ph[-1] + d)
ts = [(s["t"] - scans[0]["t"]) / 60 for s in scans]
if len(scans) >= 3 and ts[-1] > 0:
    mt, mp = sum(ts) / len(ts), sum(ph) / len(ph)
    slope = sum((a - mt) * (b - mp) for a, b in zip(ts, ph)) / max(1e-9, sum((a - mt) ** 2 for a in ts))
    spread = max(ph) - min(ph)
    ppm = slope / 60                                   # us per minute -> us per second = ppm
    print(f"\njump position over {ts[-1]:.0f} min: moved {spread:.0f} us in total, "
          f"trend {slope:+.1f} us/min = {ppm:+.2f} ppm")
    if spread <= 2 * step:
        print("VERDICT: stable. The radio timing did not move beyond the measurement step: the X410's\n"
              "         clock holds against PTP over this window. A one-time alignment (set the gate's\n"
              "         phase from this scan) would work for now; 10 MHz + PPS is not urgent.")
    else:
        hrs = CYCLE / max(1e-9, abs(slope)) / 60
        print(f"VERDICT: drifting. The radio's frame walks against PTP time; it passes through the whole\n"
              f"         5 ms frame every ~{hrs:.1f} h, so any aligned gate falls out of step. The X410 needs\n"
              f"         10 MHz + PPS from the grandmaster (clock/sync: external).")
else:
    print("\nnot enough scans to measure a trend (need 3 or more)")
print(f"\nraw files: {out}")
PY
