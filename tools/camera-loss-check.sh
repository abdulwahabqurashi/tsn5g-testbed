#!/bin/bash
# Camera loss between the UE and the core, counted over the SAME 30 seconds
# at both ends. CLI only.
#
# UE side:   the per-camera iptables counters (whole datagrams leaving on wwan0)
# core side: a GTP-U capture on the core's loopback (N3), counted per camera
#
# The earlier estimate read the UE's rate after the capture had finished, so a
# dip in the cameras' own sending rate could have been counted as loss. This
# script starts the capture and reads the UE counters in the same instant.
#
# Needs: cameras running; sudo on the UE (iptables counters); the core's sudo
# password once (tcpdump).   Usage:  ./camera-loss-check.sh  [seconds]

set -uo pipefail
DUR=${1:-30}
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
CORE=$CORE_SSH
PCAP=/tmp/n3-camcheck-$(date +%s).pcap
OUT=$HOME/radio-loss/camcheck-$(date +%Y%m%d-%H%M%S); mkdir -p "$OUT"

counts() {   # prints "camera1 <pkts> camera2 <pkts>"
    sudo iptables -t mangle -L POSTROUTING -v -n -x | awk '
        /tsn5g-count:camera1/ {c1=$1} /tsn5g-count:camera2/ {c2=$1}
        END {print "camera1", c1+0, "camera2", c2+0}'
}

sudo true || exit 1                       # ask for the UE password up front
pgrep -f bin/pathStream1 >/dev/null || { echo "error: cameras are not running"; exit 1; }
counts | grep -q "camera1 0 camera2 0" && { echo "error: no camera counting rules on $WWAN (restart the daemon)"; exit 1; }

echo "starting a ${DUR}s capture on the core (core sudo password next)..."
ssh -t "$CORE" "sudo -b timeout $((DUR + 2)) tcpdump -i lo -n -s 128 -w $PCAP 'udp port 2152' >/dev/null 2>&1" || exit 1
sleep 1
read -r _ a1 _ a2 < <(counts); t0=$(date +%s.%N)
echo "counting for ${DUR}s..."
sleep "$DUR"
read -r _ b1 _ b2 < <(counts); t1=$(date +%s.%N)
sleep 3
echo "UE sent:   camera1 $((b1 - a1))   camera2 $((b2 - a2))   (datagrams, $(python3 -c "print(round($t1-$t0,1))") s)" | tee "$OUT/result.txt"

# core side: count datagrams per camera inside the same wall-clock window
scp -q "$(dirname "${BASH_SOURCE[0]}")/n3count.py" "$CORE:/tmp/n3count.py" 2>/dev/null
ssh -o BatchMode=yes "$CORE" "CAM1_PORT=$CAM1_PORT CAM2_PORT=$CAM2_PORT python3 /tmp/n3count.py $PCAP $t0 $t1" | tee -a "$OUT/result.txt"
python3 - "$OUT/result.txt" <<'PY'
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
