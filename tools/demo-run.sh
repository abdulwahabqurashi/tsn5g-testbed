#!/bin/bash
# The Track A demo: two cameras, one bearer, policy off vs on, with numbers.
#
# Why a flood
# -----------
# The two cameras together are ~21 Mbit/s and the radio carries ~42, so with
# nothing else on the link no queue policy makes a visible difference. The
# demo is about what happens under contention, so a UDP flood (iperf3, port
# 5201) is added. It lands in the best-effort lane — HTB's default class —
# exactly like any unclassified traffic would.
#
# Phases (PHASE seconds each)
#   0           baseline  limited 30/60, no flood — nothing binds; defines 100%
#   then PAIRS times, alternating:
#               off       shallow + flood — one queue, both cameras suffer
#               on        limited + flood — camera 1 protected, camera 2 squeezed
#
# Alternating pairs rather than one block of each, so that a change in the
# radio part-way through hits both policies instead of one. The second run on
# 1 Oct lost two minutes of uplink capacity mid-run and, with one pair per
# policy, that read as the policy failing.
#
# Radio is sampled throughout, and each phase reports what the core actually
# received in total ("carried"). A phase in which the protected camera lost
# datagrams that the UE did not drop is flagged — that loss happened after the
# queue, where no host-side policy can reach. Analysis is in demo-analyse.py.
#
# What is measured
# ----------------
# Delivery is counted where it matters: datagrams arriving at the core per
# camera port (tcpdump on ogstun), relative to the baseline phase. Counting at
# the core rather than from tc on the UE matters because in `shallow` the loss
# happens in the modem and the radio, where tc cannot see it. tc per-lane
# counters on the UE are recorded too, as the host-side half of the story.
#
# Clocks: the UE's wall clock is not the core's. PTP on the UE runs its clock
# on the grandmaster's TAI timescale with no UTC offset applied, so it is ~37 s
# ahead of the core (NTP). Phase boundaries are therefore converted to the
# core's clock using an offset measured over SSH at the start, or the capture
# is sliced 37 s out of step with the phases.
#
# Fragments: the encoder sends 1500-byte datagrams on a 1400 MTU bearer, so
# tc counts two packets per datagram while tcpdump's port filter matches the
# first fragment only — one per datagram. Both sides are therefore compared
# against their own baseline, never against each other.
#
# Needs: passwordless SSH from this UE to the core (ssh-copy-id), sudo on the
# core (asked once, at the start), iperf3 on both ends.
#
# Usage:  ./demo-run.sh            (as your normal user, on the UE)

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
CORE=$CORE_SSH
CORE_BEARER_IP=$CORE_IP
PHASE=${PHASE:-60}
SETTLE=${SETTLE:-5}          # seconds ignored after each switch
PAIRS=${PAIRS:-3}            # off/on pairs after the baseline
# UE socket buffers must allow -w 8M (default max is 212 KB).
if [ "$(cat /proc/sys/net/core/wmem_max)" -lt 8388608 ]; then
    echo "raising the UE's socket-buffer limit for -w 8M (sudo, until reboot)"
    sudo sysctl -q -w net.core.wmem_max=16777216 net.core.rmem_max=16777216 || exit 1
fi
FLOOD=${FLOOD:-50M}         # must exceed what the radio has left, or "off" shows nothing
BE_MBPS=${BE_MBPS:-12}
LINK_MBPS=${LINK_MBPS:-55}
LIMIT=${LIMIT:-256}
OUT=${OUT:-$HOME/demo-runs/$(date +%Y%m%d-%H%M%S)}
PCAP=/tmp/demo-$(date +%s).pcap

die() { echo "error: $*" >&2; exit 1; }

mkdir -p "$OUT"
BIND=$(ip -4 -o addr show $WWAN | awk '{print $4}' | cut -d/ -f1)
[ -n "$BIND" ] || die "$WWAN has no address — is the bearer up?"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$CORE" true 2>/dev/null || \
    die "no passwordless SSH to $CORE — run: ssh-copy-id $CORE"

set_policy() {   # policy [be_mbps link_mbps]
    local be=${2:-$BE_MBPS} link=${3:-$LINK_MBPS}
    local body="{\"policy\":\"$1\",\"limit\":$LIMIT,\"be_mbps\":$be,\"link_mbps\":$link}"
    curl -sf -X PUT "$API/api/bearer/queue" -H 'Content-Type: application/json' \
        -d "$body" > "$OUT/policy-$1-$(date +%s).json" || die "could not set policy $1"
}

restore() {
    pkill -u "$(id -u)" -f "iperf3 -c $CORE_BEARER_IP" 2>/dev/null
    # Leave the rig in the state the handover documents.
    curl -sf -X PUT "$API/api/bearer/queue" -H 'Content-Type: application/json' \
        -d '{"policy":"limited","limit":256,"be_mbps":30,"link_mbps":60}' >/dev/null \
        && echo "queue restored to limited 30/60"
}
trap restore EXIT

# UE clock minus core clock, midpoint of an SSH round trip.
OFFSET=$(python3 - "$CORE" <<'PY'
import subprocess, sys, time
best = None
for _ in range(5):
    a = time.time()
    c = float(subprocess.check_output(["ssh", "-o", "BatchMode=yes", sys.argv[1],
                                       "date +%s.%N"]).decode())
    b = time.time()
    if best is None or b - a < best[0]:
        best = (b - a, (a + b) / 2 - c)
print(f"{best[1]:.3f}")
PY
) || die "could not measure the UE/core clock offset"
echo "UE clock is ${OFFSET}s ahead of the core"
echo "$OFFSET" > "$OUT/clock-offset.txt"

NPHASES=$(( 1 + 2 * PAIRS ))
TOTAL=$(( (PHASE + 10) * NPHASES + 60 ))
echo "== $NPHASES phases of ${PHASE}s — about $(( (PHASE + 6) * NPHASES / 60 + 1 )) minutes"
echo "== core: capture and iperf3 server (sudo password for the core, once)"
ssh -t "$CORE" "sudo -b timeout $TOTAL tcpdump -i ogstun -n -s 96 -w $PCAP \
    'udp and (dst port $CAM1_PORT or dst port $CAM2_PORT)' >/dev/null 2>&1; \
    for p in \$(seq 5211 5219); do pkill -f \"^iperf3 -s -p \$p\" 2>/dev/null; \
        iperf3 -s -p \$p -D; done" \
    || die "could not start the core side"
# Fresh servers on their own ports every run: on 3 Oct two floods failed with
# "Resource temporarily unavailable" because 5202/5205 were still held by
# servers left over from earlier tests.
sleep 2

# Radio sampler for the whole run. The daemon polls the modem every 2 s;
# reading its latest sample adds no load on the modem.
SIGNAL="$OUT/signal.tsv"
python3 -c '
import json, sys, time, urllib.request
api, out = sys.argv[1], sys.argv[2]
with open(out, "w", buffering=1) as fh:
    fh.write("t\trsrp\trsrq\tsinr\n")
    while True:
        try:
            s = json.load(urllib.request.urlopen(f"{api}/api/signal", timeout=3))
            vals = [s.get(k) for k in ("rsrp", "rsrq", "sinr")]
            fh.write("\t".join([f"{time.time():.3f}"] + [str(v) for v in vals]) + "\n")
        except Exception:
            pass
        time.sleep(2)
' "$API" "$SIGNAL" &
SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null; restore' EXIT

PHASES="$OUT/phases.tsv"
printf "phase\tname\tpolicy\tflood\tstart\tend\n" > "$PHASES"
TC="$OUT/tc.tsv"
printf "phase\tclass\tbytes\tpkts\tdropped\n" > "$TC"

tc_snap() {   # phase tag
    tc -s class show dev $WWAN 2>/dev/null | awk -v p="$1" '
        /^class htb/ {c=$3}
        /Sent/ && c {gsub(/[(,]/," "); print p"\t"c"\t"$2"\t"$4"\t"$7; c=""}' >> "$TC"
}

run_phase() {   # n name policy flood(yes|no) [be_mbps link_mbps]
    echo "== phase $1/$(( NPHASES - 1 )): $2 ($3, flood $4) — ${PHASE}s"
    set_policy "$3" "${5:-}" "${6:-}"
    local fpid=
    if [ "$4" = yes ]; then
        # -w 8M: with the 212 KB default the sender is throttled by its own
        # socket and never really loads the link (LCP tests, 3 Oct).
        iperf3 -c "$CORE_BEARER_IP" -p $(( 5211 + $1 % 9 )) -B "$BIND" -u -w 8M -b "$FLOOD" -l 1200 \
            -t $(( PHASE + 2 )) > "$OUT/iperf-$1.txt" 2>&1 &
        fpid=$!
    fi
    sleep "$SETTLE"
    # What was in force: auto-rate and which bearer each camera rides.
    curl -sf "$API/api/bearer/autorate" > "$OUT/autorate-$1.json" 2>/dev/null
    curl -sf "$API/api/rig/binding" > "$OUT/binding-$1.json" 2>/dev/null
    # Per-camera datagrams leaving the UE, so delivery is measured against what
    # was actually sent — not against a baseline phase that may itself be lossy.
    curl -sf "$API/api/bearer/counters" > "$OUT/counters-$1-start.json" 2>/dev/null
    local t0; t0=$(date +%s.%N)
    tc_snap "$1-start"
    sleep $(( PHASE - SETTLE ))
    tc_snap "$1-end"
    curl -sf "$API/api/bearer/counters" > "$OUT/counters-$1-end.json" 2>/dev/null
    local t1; t1=$(date +%s.%N)
    printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$1" "$2" "$3" "$4" "$t0" "$t1" >> "$PHASES"
    if [ -n "$fpid" ]; then
        wait "$fpid" 2>/dev/null
        grep -q "receiver" "$OUT/iperf-$1.txt" || echo "   WARNING: the flood did not run — see $OUT/iperf-$1.txt"
    fi
    sleep 2
}

run_phase 0 baseline limited no 30 60
n=1
for _ in $(seq "$PAIRS"); do
    run_phase "$n" off shallow yes
    run_phase $(( n + 1 )) on limited yes
    n=$(( n + 2 ))
done

echo "== collecting the core capture"
sleep 3
# time, destination, UDP length (the first fragment carries the datagram's length)
ssh "$CORE" "tcpdump -tt -n -r $PCAP 2>/dev/null" \
    | awk '{print $1, $5, $NF}' > "$OUT/core.txt"

python3 "$(dirname "${BASH_SOURCE[0]}")/demo-analyse.py" "$OUT" | tee "$OUT/results.txt"
echo
echo "raw data: $OUT"
echo "re-analyse later with: python3 $(dirname "${BASH_SOURCE[0]}")/demo-analyse.py $OUT"
