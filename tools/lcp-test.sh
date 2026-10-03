#!/bin/bash
# UE side of the LCP test brief (core/RAN side, 2026-10-03).
#
# What it is testing
# ------------------
# Whether the RM520N's logical channel prioritisation favours the GBR bearer
# (QFI 2 -> DRB 2 -> LCG 1, PBR kBps4096) over the default one (QFI 1 -> DRB 1
# -> LCG 2, PBR kBps8) when both are backlogged. It has never been tested: in
# 10 million BSRs LCG 1 never reported a byte, because uplink only matches QFI 2
# when the UE's SOURCE port is 5202 (the PCC rule is written in downlink form
# and Open5GS swaps it for uplink). Everything before this sent to 5202, from
# an ephemeral port, and landed on the default flow.
#
# What this script enforces, from the brief's "conditions for every run"
#   1. cameras stopped               — refuses to run while an encoder is up
#   2. bearer idle                   — measures wwan0 for 5 s; refuses if busy
#   3. wwan0 qdisc is pfifo          — sets it, reads it back, refuses if not
#   4. commands + qdisc recorded     — every command and read-back goes to the
#                                      run directory beside its result
#   5. no PDU session rebuild        — this script never touches the bearer
# plus: the data session must actually carry traffic (ping the core over
# wwan0), and it pauses before each test so the core can start its capture.
#
# Usage:  ./lcp-test.sh 0            Test 0, the plumbing gate. Run this first.
#         ./lcp-test.sh 1|2|3        the rest, only after Test 0 has passed
#         ./lcp-test.sh 1 2 3        several in one go (pauses before each)
#         ./lcp-test.sh 2b           Test 2 with host priority for the GBR stream
#         ./lcp-test.sh 2c           Test 2 with the UE shaped below the radio (SHAPE_MBPS)
#
# Env: CORE_IP (site.env CORE_BEARER_IP), API (http://localhost:API_PORT), LIMIT (pfifo limit, 1000),
#      FLOOD_RATES (Test 3 flood steps in Mbit/s, default "20 40 60 90 120"),
#      NOPAUSE=1 to skip the "tell the core" pause (not recommended).

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
CORE=$CORE_IP
LIMIT=${LIMIT:-1000}
OUT=${OUT:-$HOME/lcp-runs/$(date +%Y%m%d-%H%M%S)}
IDLE_KBPS=500          # "idle" means below this in each direction

die() { echo "error: $*" >&2; exit 1; }
say() { echo "$*" | tee -a "$OUT/run.log"; }

[ $# -ge 1 ] || die "usage: $0 0|1|2|3 [...]  (start with 0)"
mkdir -p "$OUT"
BIND=$(ip -4 -o addr show $WWAN | awk '{print $4}' | cut -d/ -f1)
[ -n "$BIND" ] || die "$WWAN has no address"

# -- preconditions -------------------------------------------------------------
check_session() {
    if ! ping -c3 -W2 -I $WWAN "$CORE" >/dev/null 2>&1; then
        die "the core ($CORE) does not answer over $WWAN — the data session is down.
       Re-establish it first (UI: Connection -> Cycle bearer), then re-run."
    fi
    say "session: $CORE answers over $WWAN from $BIND"
}

check_cameras() {
    if pgrep -f "bin/pathStream1" >/dev/null; then
        die "camera encoders are running and would contaminate the run.
       Stop them first (UI: Cameras -> Encoders -> Stop, or sudo scripts/cameras-start.sh stop)."
    fi
    say "cameras: no encoder running"
}

check_idle() {
    local t0 r0 t1 r1
    t0=$(cat /sys/class/net/$WWAN/statistics/tx_bytes); r0=$(cat /sys/class/net/$WWAN/statistics/rx_bytes)
    sleep 5
    t1=$(cat /sys/class/net/$WWAN/statistics/tx_bytes); r1=$(cat /sys/class/net/$WWAN/statistics/rx_bytes)
    local tx=$(( (t1 - t0) * 8 / 5 / 1000 )) rx=$(( (r1 - r0) * 8 / 5 / 1000 ))
    say "idle check (5 s): tx ${tx} kbit/s, rx ${rx} kbit/s"
    [ "$tx" -lt "$IDLE_KBPS" ] && [ "$rx" -lt "$IDLE_KBPS" ] || \
        die "the bearer is not idle (limit ${IDLE_KBPS} kbit/s each way) — find what is sending"
}

set_pfifo() {
    curl -sf -X PUT "$API/api/bearer/queue" -H 'Content-Type: application/json' \
        -d "{\"policy\":\"shallow\",\"limit\":$LIMIT}" > "$OUT/qdisc-set.json" \
        || die "could not set the $WWAN qdisc to pfifo through the daemon"
    local first; first=$(tc qdisc show dev $WWAN | head -1)
    echo "$first" | grep -q "^qdisc pfifo " || die "$WWAN qdisc reads back as: $first (want pfifo)"
    say "qdisc: $first"
}

restore_qdisc() {
    curl -sf -X PUT "$API/api/bearer/queue" -H 'Content-Type: application/json' \
        -d '{"policy":"limited","limit":256,"be_mbps":30,"link_mbps":60}' >/dev/null \
        && echo "$WWAN qdisc restored to limited 30/60 (the camera lanes)"
}

# -- one test ------------------------------------------------------------------
pause_for_core() {   # name
    say ""
    say ">>> Tell the core side: starting $1 at $(date '+%H:%M:%S %Z'), UE $BIND, GBR source port $GBR_PORT."
    if [ "${NOPAUSE:-0}" != 1 ]; then
        read -r -p ">>> Press Enter once they confirm the N3 capture and mac_level debug are running... " _
    fi
}

sampler() {   # dir — $WWAN counters + qdisc stats every second
    local dir=$1
    printf "t\ttx_bytes\trx_bytes\tqdisc_sent_pkts\tqdisc_dropped\tbacklog_pkts\n" > "$dir/samples.tsv"
    while :; do
        local q; q=$(tc -s qdisc show dev $WWAN | head -3 | tr '\n' ' ')
        printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$(date +%s.%N)" \
            "$(cat /sys/class/net/$WWAN/statistics/tx_bytes)" \
            "$(cat /sys/class/net/$WWAN/statistics/rx_bytes)" \
            "$(echo "$q" | sed -n 's/.*Sent [0-9]* bytes \([0-9]*\) pkt.*/\1/p')" \
            "$(echo "$q" | sed -n 's/.*dropped \([0-9]*\),.*/\1/p')" \
            "$(echo "$q" | sed -n 's/.*backlog [^ ]* \([0-9]*\)p.*/\1/p')" >> "$dir/samples.tsv"
        sleep 1
    done
}

# run_flows DIR NAME:"iperf args" [NAME:"iperf args" ...] — all at once
run_flows() {
    local dir=$1; shift
    mkdir -p "$dir"
    tc -s qdisc show dev $WWAN > "$dir/qdisc-before.txt"
    : > "$dir/commands.txt"
    sampler "$dir" & local sp=$!
    local pids=() spec name args
    for spec in "$@"; do
        name=${spec%%:*}; args=${spec#*:}
        echo "$name: iperf3 $args" | tee -a "$dir/commands.txt" | sed 's/^/    /'
        # shellcheck disable=SC2086
        iperf3 $args -J > "$dir/$name.json" 2> "$dir/$name.err" &
        pids+=($!)
    done
    for p in "${pids[@]}"; do wait "$p"; done
    kill "$sp" 2>/dev/null
    tc -s qdisc show dev $WWAN > "$dir/qdisc-after.txt"
    python3 "$(dirname "${BASH_SOURCE[0]}")/lcp-analyse.py" "$dir" | tee "$dir/result.txt" | tee -a "$OUT/run.log"
}

# -w 8M: socket buffers on both ends (iperf3 passes it to the server). The
# core's default 212 KB receive buffer overflowed whenever packets arrived in
# a burst after a radio dip — RcvbufErrors rose by ~30 million over these runs —
# so part of every "loss" figure was the receiving socket, not the 5G system.
C="-c $CORE -B $BIND -u -w 8M"
test0() {
    pause_for_core "TEST 0 (plumbing gate)"
    run_flows "$OUT/test0" \
        "gbr:$C -b 5M -t 60 -p 5201 --cport $GBR_PORT --get-server-output"
    say "TEST 0 passes only if the core sees QFI 2 on N3 and a BSR with LCG 1 non-zero."
    say "If the core still sees only LCG 2: stop here — the filter is not matching."
}
test1() {
    pause_for_core "TEST 1 (LCP: GBR 20M vs default 4x30M)"
    run_flows "$OUT/test1" \
        "gbr:$C -b 20M -t 120 -p 5201 --cport $GBR_PORT --get-server-output" \
        "flood:$C -b 30M -P 4 -t 120 -p $GBR_PORT --get-server-output"
    say "Valid only if the core saw a BSR with LCG 1 AND LCG 2 non-zero in the same report."
}
test2() {
    # Roles swapped: the GBR-flow stream carries the heavy load, the default
    # flow the light one. One stream on the GBR flow: with -P 4 only the first
    # stream would get source port 5202, the others would land on QFI 1.
    pause_for_core "TEST 2 (control: GBR 120M single stream vs default 20M)"
    run_flows "$OUT/test2" \
        "gbr:$C -b 120M -t 120 -p 5201 --cport $GBR_PORT --get-server-output" \
        "flood:$C -b 20M -t 120 -p $GBR_PORT --get-server-output"
}
# Test 2b — Test 2 again, but with the UE itself giving the GBR stream priority
# before the modem. Tests 1-3 showed the light flow winning whichever flow had
# priority, with the shortfall pushed back to the senders through the single
# host->modem pipe. If that pipe is the arbiter, prioritising in the host queue
# should hand the GBR stream its full share and squeeze the default flow.
#
# How: wwan0 gets the strict-priority qdisc (`prio`, 3 bands), and one rule
# gives packets from source port 5202 skb priority 6, which the priomap sends
# to band 0. Everything else stays at priority 0 -> band 1. The rule is
# removed again when the test ends, and the queue goes back to the camera lanes.
PRIO_RULE=(-t mangle -I POSTROUTING 1 -o $WWAN -p udp --sport "$GBR_PORT" -j CLASSIFY --set-class 0:6)
PRIO_CHECK=(-t mangle -C POSTROUTING -o $WWAN -p udp --sport "$GBR_PORT" -j CLASSIFY --set-class 0:6)
PRIO_DEL=(-t mangle -D POSTROUTING -o $WWAN -p udp --sport "$GBR_PORT" -j CLASSIFY --set-class 0:6)

test2b() {
    say "TEST 2b needs sudo once, to add and later remove the priority rule."
    sudo iptables "${PRIO_CHECK[@]}" 2>/dev/null || sudo iptables "${PRIO_RULE[@]}" \
        || die "could not add the host priority rule"
    trap 'sudo iptables "${PRIO_DEL[@]}" 2>/dev/null && echo "host priority rule removed"; restore_qdisc' EXIT
    curl -sf -X PUT "$API/api/bearer/queue" -H 'Content-Type: application/json' \
        -d "{\"policy\":\"prio\",\"limit\":$LIMIT}" > "$OUT/qdisc-set-prio.json" \
        || die "could not set the $WWAN qdisc to prio"
    local first; first=$(tc qdisc show dev $WWAN | head -1)
    echo "$first" | grep -q "^qdisc prio " || die "$WWAN qdisc reads back as: $first (want prio)"
    say "qdisc: $first"
    sudo iptables "${PRIO_CHECK[@]}" || die "priority rule did not land"
    say "rule: udp source port $GBR_PORT -> skb priority 6 -> band 0 (strict priority over everything else)"
    mkdir -p "$OUT/test2b"
    sudo iptables -t mangle -L POSTROUTING -v -n -x > "$OUT/test2b/rules-before.txt"
    tc -s class show dev $WWAN > "$OUT/test2b/bands-before.txt"
    pause_for_core "TEST 2b (Test 2 with host priority for GBR: GBR 120M single stream vs default 20M)"
    run_flows "$OUT/test2b" \
        "gbr:$C -b 120M -t 120 -p 5201 --cport $GBR_PORT --get-server-output" \
        "flood:$C -b 20M -t 120 -p $GBR_PORT --get-server-output"
    tc -s class show dev $WWAN > "$OUT/test2b/bands-after.txt"
    sudo iptables -t mangle -L POSTROUTING -v -n -x > "$OUT/test2b/rules-after.txt"
    say "host bands (packets sent / dropped during the test):"
    paste <(awk '/^class prio/{c=$3} /Sent/{print c, $4, $7}' "$OUT/test2b/bands-before.txt") \
          <(awk '/Sent/{print $4, $7}' "$OUT/test2b/bands-after.txt") \
      | awk '{gsub(/,/,"",$3); gsub(/,/,"",$5); printf "    band %s  sent %d  dropped %d\n", $1, $4-$2, $5-$3}' | tee -a "$OUT/run.log"
    say "Compare with Test 2: there the default flow kept 19.9 and GBR got 102.6 of 120."
    say "If GBR now gets more and the default flow is squeezed, the host->modem pipe is the arbiter."
}

# Test 2c — Test 2 again, but with the UE shaped BELOW the radio's capacity so
# the queue forms on the UE, where Linux priority can act. Test 2b showed the
# host queue never filled (the modem accepts everything, first come first
# served), so host priority alone did nothing. Shaping moves the bottleneck
# onto the UE: HTB root at SHAPE_MBPS, GBR (source port 5202) in a class with a
# near-full guarantee and priority 0, everything else guaranteed 1 Mbit/s and
# allowed only to borrow what GBR leaves. If GBR then takes ~the shaped rate
# and the default flow is squeezed to almost nothing, host shaping is a working
# fix for "the modem ignores LC priority".
#
# SHAPE_MBPS: set it, or leave it unset and the script measures the uplink for
# 10 s first and uses 85% of what it carried.
SHAPE_RULE=(-t mangle -I POSTROUTING 1 -o $WWAN -p udp --sport "$GBR_PORT" -j CLASSIFY --set-class 1:10)
SHAPE_CHECK=(-t mangle -C POSTROUTING -o $WWAN -p udp --sport "$GBR_PORT" -j CLASSIFY --set-class 1:10)
SHAPE_DEL=(-t mangle -D POSTROUTING -o $WWAN -p udp --sport "$GBR_PORT" -j CLASSIFY --set-class 1:10)

measure_ceiling() {   # prints only the number; say nothing on stdout here
    local mbps
    mbps=$(iperf3 -c "$CORE" -B "$BIND" -u -b 150M -t 10 -p 5203 -J 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin); e = d.get("end", {})
r = (e.get("sum_received") or {}).get("bits_per_second") or (e.get("sum") or {}).get("bits_per_second") or 0
print(int(r / 1e6))')
    [ -n "$mbps" ] && [ "$mbps" -gt 5 ] && echo "$mbps"
}

test2c() {
    say "TEST 2c needs sudo, to build the shaping queue and the priority rule."
    local ceil="${SHAPE_MBPS:-}"
    if [ -z "$ceil" ]; then
        say "measuring the uplink ceiling: one 150 Mbit/s stream for 10 s (not part of the result)"
        local measured; measured=$(measure_ceiling) || die "could not measure the uplink ceiling"
        ceil=$(( measured * 85 / 100 ))
        say "ceiling measured: ${measured} Mbit/s -> shaping the UE at ${ceil} Mbit/s (85%)"
        sleep 3
    else
        say "shaping the UE at ${ceil} Mbit/s (SHAPE_MBPS)"
    fi
    trap 'sudo iptables "${SHAPE_DEL[@]}" 2>/dev/null && echo "shaping rule removed"; restore_qdisc' EXIT
    sudo tc qdisc del dev $WWAN root 2>/dev/null
    sudo tc qdisc add dev $WWAN root handle 1: htb default 20 r2q 10 || die "could not add the HTB root"
    sudo tc class add dev $WWAN parent 1: classid 1:1 htb rate "${ceil}mbit" ceil "${ceil}mbit"
    sudo tc class add dev $WWAN parent 1:1 classid 1:10 htb rate "$(( ceil - 1 ))mbit" ceil "${ceil}mbit" prio 0 quantum 1400
    sudo tc class add dev $WWAN parent 1:1 classid 1:20 htb rate 1mbit ceil "${ceil}mbit" prio 1 quantum 1400
    sudo tc qdisc add dev $WWAN parent 1:10 pfifo limit "$LIMIT"
    sudo tc qdisc add dev $WWAN parent 1:20 pfifo limit "$LIMIT"
    sudo iptables "${SHAPE_CHECK[@]}" 2>/dev/null || sudo iptables "${SHAPE_RULE[@]}" \
        || die "could not add the shaping rule"
    sudo iptables "${SHAPE_CHECK[@]}" || die "shaping rule did not land"
    mkdir -p "$OUT/test2c"
    tc class show dev $WWAN | tee "$OUT/test2c/classes.txt" | sed 's/^/    /'
    say "rule: udp source port $GBR_PORT -> class 1:10 (priority 0, ${ceil} Mbit/s); everything else -> 1:20 (1 Mbit/s + leftovers)"
    tc -s class show dev $WWAN > "$OUT/test2c/classes-before.txt"
    pause_for_core "TEST 2c (Test 2 with the UE shaped at ${ceil} Mbit/s and GBR prioritised: GBR 120M vs default 20M)"
    run_flows "$OUT/test2c" \
        "gbr:$C -b 120M -t 120 -p 5201 --cport $GBR_PORT --get-server-output" \
        "flood:$C -b 20M -t 120 -p $GBR_PORT --get-server-output"
    tc -s class show dev $WWAN > "$OUT/test2c/classes-after.txt"
    say "host classes during the test (packets sent / dropped):"
    paste <(awk '/^class htb/{c=$3} /Sent/{print c, $4, $7}' "$OUT/test2c/classes-before.txt") \
          <(awk '/Sent/{print $4, $7}' "$OUT/test2c/classes-after.txt") \
      | awk '{gsub(/,/,"",$3); gsub(/,/,"",$5); printf "    class %-5s sent %9d  dropped %9d\n", $1, $4-$2, $5-$3}' | tee -a "$OUT/run.log"
    say "Compare with Test 2 (GBR 102.6, default 19.9) and 2b (GBR 105.0, default 19.9)."
    say "Host shaping works if GBR is now close to ${ceil} Mbit/s and the default flow is squeezed toward 1 Mbit/s."
}

test3() {
    local rate
    # The brief's steps are 20-120. On 3 Oct the uplink carried ~119 Mbit/s,
    # so set FLOOD_RATES to go past the ceiling, e.g. "60 90 120 160 200".
    for rate in ${FLOOD_RATES:-20 40 60 90 120}; do
        pause_for_core "TEST 3 step: GBR 20M vs default ${rate}M (4 streams)"
        run_flows "$OUT/test3-flood${rate}" \
            "gbr:$C -b 20M -t 60 -p 5201 --cport $GBR_PORT --get-server-output" \
            "flood:$C -b $(( rate / 4 ))M -P 4 -t 60 -p $GBR_PORT --get-server-output"
    done
    python3 "$(dirname "${BASH_SOURCE[0]}")/lcp-analyse.py" --ramp "$OUT" | tee "$OUT/test3-ramp.txt"
}

check_sockbuf() {
    # -w 8M needs the UE's kernel to allow it (the default max is 212 KB).
    local w r; w=$(cat /proc/sys/net/core/wmem_max); r=$(cat /proc/sys/net/core/rmem_max)
    if [ "$w" -lt 8388608 ] || [ "$r" -lt 8388608 ]; then
        say "raising the UE's socket-buffer limit to 16 MB for -w 8M (sudo, until reboot)"
        sudo sysctl -q -w net.core.wmem_max=16777216 net.core.rmem_max=16777216 \
            || die "could not raise net.core.wmem_max/rmem_max"
    fi
    say "socket buffers: -w 8M on every flow (core rmem_max must allow it too)"
}

# -- go ------------------------------------------------------------------------
say "LCP test, UE side — $(date '+%F %T %Z') — results in $OUT"
check_session
check_cameras
check_sockbuf
trap restore_qdisc EXIT
set_pfifo
for t in "$@"; do
    case "$t" in
        0|1|2|2b|2c|3) check_idle; "test$t" ;;
        *) die "unknown test '$t' (0, 1, 2, 2b, 2c or 3)" ;;
    esac
done
say ""
say "done. Send the core side: $OUT (run.log, per-test commands.txt, qdisc-*.txt, *.json)"
