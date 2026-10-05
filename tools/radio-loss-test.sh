#!/bin/bash
# Camera-like uplink traffic, one variable at a time, to find where the
# cameras' 5-15% loss comes from. CLI only — no UI, no camera software.
#
# Each test: 4.3 Mbit/s for 30 s (one camera's rate), loss reported by the
# iperf3 server on the core. The UPF socket was fixed on 3 Oct (d0), so this is
# loss between the UE and the core.
#
#   A  default bearer, 1300-byte datagrams (no fragmentation), smooth
#   B  default bearer, 1472-byte datagrams (2 fragments each),  smooth
#   C  default bearer, 1472-byte, in bursts of 15 (like a camera frame)
#   D  GBR bearer (source port 5202), 1472-byte, bursts of 15
#
# Compare A-B for fragmentation, B-C for burstiness, C-D for the bearer.
# Stop the cameras first so they don't share the link.
#
# Usage:  ./radio-loss-test.sh            (as the desktop user on the UE)
#         RATE=4.3M DUR=30 ./radio-loss-test.sh

set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
CORE=$CORE_IP
RATE=${RATE:-4.3M}
DUR=${DUR:-30}
OUT=$HOME/radio-loss/$(date +%Y%m%d-%H%M%S); mkdir -p "$OUT"
BIND=$(ip -4 -o addr show $WWAN | awk '{print $4}' | cut -d/ -f1)

die() { echo "error: $*" >&2; exit 1; }
[ -n "$BIND" ] || die "$WWAN has no address"
ping -c3 -i 0.3 -W2 -I $WWAN "$CORE" >/dev/null 2>&1 || die "the core does not answer over $WWAN — restart the data call first"
if pgrep -f bin/pathStream1 >/dev/null; then
    die "camera encoders are running — stop them first:  sudo $ENCODER_SCRIPT stop"
fi
if [ "$(cat /proc/sys/net/core/wmem_max)" -lt 8388608 ]; then
    sudo sysctl -q -w net.core.wmem_max=16777216 net.core.rmem_max=16777216 || die "need sudo for socket buffers"
fi

echo "fresh iperf3 servers on the core (ports 5221-5224)"
ssh -o BatchMode=yes "$CORE_SSH" \
  'for p in 5221 5222 5223 5224; do pkill -f "^iperf3 -s -p $p" 2>/dev/null; iperf3 -s -p $p -D; done' \
  || die "cannot reach the core over SSH"
sleep 1

run() {   # name port extra-args...
    local name=$1 port=$2; shift 2
    local cmd=(iperf3 -c "$CORE" -B "$BIND" -u -w 8M -t "$DUR" -p "$port" -J "$@")
    echo "== $name: ${cmd[*]}" | tee -a "$OUT/commands.txt"
    "${cmd[@]}" > "$OUT/$name.json" 2> "$OUT/$name.err"
    python3 - "$OUT/$name.json" "$name" <<'PY'
import json, sys
t = open(sys.argv[1]).read()
d = json.loads(t[t.index("{"):]) if "{" in t else {"error": t.strip() or "no output"}
if d.get("error"):
    print(f"   {sys.argv[2]}: ERROR {d['error']}"); sys.exit()
s = d["end"]["sum"]; port = d["start"]["connected"][0]["local_port"]
print(f"   {sys.argv[2]}: src port {port}  sent {s['packets']}  lost {s['lost_packets']}  "
      f"loss {s['lost_percent']:.2f}%  jitter {s['jitter_ms']:.2f} ms")
PY
    sleep 3
}

echo "results in $OUT"
run A-default-1300-smooth   5221 -b "$RATE"     -l 1300
run B-default-1472-smooth   5222 -b "$RATE"     -l 1472
run C-default-1472-burst15  5223 -b "$RATE/15"  -l 1472
run D-gbr-1472-burst15      5224 -b "$RATE/15"  -l 1472 --cport $GBR_PORT

echo
echo "read it as:   A vs B = fragmentation    B vs C = bursts    C vs D = GBR bearer"
echo "radio right now: $(curl -sf $API/api/signal | python3 -c 'import json,sys; s=json.load(sys.stdin); print(f"RSRP {s.get(\"rsrp\")} dBm, SINR {s.get(\"sinr\")} dB")' 2>/dev/null)"
