#!/bin/bash
# Camera loss between the UE and the core, counted over the SAME 30 seconds
# at both ends. CLI, or one click in the console (Tests → Camera loss).
#
# UE side:   the per-camera iptables counters (whole datagrams leaving on wwan0)
# core side: a GTP-U capture on the core's loopback (N3), counted per camera
#
# Both ends count the same wall-clock window: the UE's clock is ~37 s ahead
# of the core's (PTP/TAI), so the window is shifted by the measured offset
# before the core capture is sliced.
#
# Needs: cameras running; a capture allowed on the core (core_capture).
# Usage:  ./camera-loss-check.sh  [seconds]
set -uo pipefail
DUR=${1:-${DUR:-30}}
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
CORE=$CORE_SSH
PCAP=/tmp/n3-camcheck-$(date +%s).pcap
OUT=$HOME/camera-loss/$(date +%Y%m%d-%H%M%S); mkdir -p "$OUT"
die() { echo "error: $*" >&2; exit 1; }

counts() {   # prints "camera1 <pkts> camera2 <pkts>"
    sudo iptables -t mangle -L POSTROUTING -v -n -x | awk '
        /tsn5g-count:camera1/ {c1=$1} /tsn5g-count:camera2/ {c2=$1}
        END {print "camera1", c1+0, "camera2", c2+0}'
}

UE_IP=$(ip -4 -o addr show "$WWAN" | awk '{print $4}' | cut -d/ -f1)
[ -n "$UE_IP" ] || die "$WWAN has no address — connect the 5G link first"
pgrep -f bin/pathStream1 >/dev/null || die "the cameras are not running"
counts | grep -q "camera1 0 camera2 0" && die "no camera counting rules on $WWAN (restart the daemon)"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$CORE" true || die "no passwordless SSH to $CORE (ssh-copy-id $CORE)"
OFFSET=$(core_clock_offset) || die "could not measure the UE/core clock offset"
echo "UE clock is ${OFFSET}s ahead of the core"

echo "starting a ${DUR}s capture on the core"
core_capture $((DUR + 8)) "$PCAP" "-i lo -n -s 128 'udp port 2152'" || die "could not start the capture on the core"
read -r _ a1 _ a2 < <(counts); t0=$(date +%s.%N)
echo "counting for ${DUR}s..."
sleep "$DUR"
read -r _ b1 _ b2 < <(counts); t1=$(date +%s.%N)
sleep 3
echo "UE sent:   camera1 $((b1 - a1))   camera2 $((b2 - a2))   (datagrams, $(python3 -c "print(round($t1-$t0,1))") s)" | tee "$OUT/result.txt"

# the same window on the core's clock
c0=$(python3 -c "print($t0 - $OFFSET)"); c1=$(python3 -c "print($t1 - $OFFSET)")
ssh -o BatchMode=yes "$CORE" "cat > /tmp/n3count.py" < "$(dirname "${BASH_SOURCE[0]}")/n3count.py"
ssh -o BatchMode=yes "$CORE" "UE_IP=$UE_IP CAM1_PORT=$CAM1_PORT CAM2_PORT=$CAM2_PORT python3 /tmp/n3count.py $PCAP $c0 $c1" \
    | tee -a "$OUT/result.txt"
python3 - "$OUT/result.txt" <<'PY' | tee -a "$OUT/result.txt"
import re, sys
t = open(sys.argv[1]).read()
sent = dict(re.findall(r"(camera\d) (\d+)", t.splitlines()[0]))
got = dict(re.findall(r"core received (camera\d) (\d+)", t))
for c in ("camera1", "camera2"):
    s, g = int(sent.get(c, 0)), int(got.get(c, 0))
    if s:
        print(f"{c}: sent {s}, reached the core {g}, lost {s - g} ({100 * (s - g) / s:.2f}%)")
PY
echo "files: $OUT   capture on the core: $PCAP"
