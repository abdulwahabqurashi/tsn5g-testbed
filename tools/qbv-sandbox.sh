#!/bin/bash
# Qbv gate design check, entirely in throwaway network namespaces: no wwan0,
# no cameras, no daemon, nothing outside the four namespaces it creates.
#
#   sudo tools/qbv-sandbox.sh            (about 3 minutes)
#
# Models the real uplink, hop for hop:
#
#   qbv-ue ──veth: GATE──► qbv-gw ──veth: SHAPER──► qbv-radio ──tbf RADIO, modem FIFO──► qbv-core
#   talkers + flood       (= the UE root ns,         (= the 5G link)                     listeners
#   (= test namespace)     wwan0's qdisc)
#
# The protected stream is tools/qbv-talker.py (time-stamped, so loss AND
# one-way delay), 4 x 1200 B per 4 ms = 9.6 Mbit/s, either scheduled into the
# gate's protected window on CLOCK_TAI, or uniform (ignores the gate, like a
# camera). The flood is iperf3 UDP at FLOOD_MBPS.
#
#   E      baseline         talker alone, no policy
#   A      none             FIFO everywhere
#   B-uni  priority         shaper: HTB at SHAPE_MBPS, protected strict priority (today's policy)
#   B-sch  priority         same, scheduled talker
#   C      gate             taprio video-4ms only (shown to fail: bytes not limited)
#   F-uni  gate + priority  taprio, then the HTB shaper
#   F-sch  gate + priority  same, scheduled talker  <- the Qbv case
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
command -v iperf3 >/dev/null || { echo "iperf3 missing" >&2; exit 1; }
TALKER=$(dirname "$(readlink -f "$0")")/qbv-talker.py

RADIO_MBPS=${RADIO_MBPS:-50}
SHAPE_MBPS=${SHAPE_MBPS:-45}
FLOOD_MBPS=${FLOOD_MBPS:-80}
DUR=${DUR:-20}
BUF_PKTS=${BUF_PKTS:-300}
OUT=${OUT:-/tmp/qbv-sandbox-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"

UE=qbv-ue; GW=qbv-gw; RAD=qbv-radio; CORE=qbv-core; ALL="$UE $GW $RAD $CORE"
cleanup() {
    for n in $ALL; do ip netns pids $n 2>/dev/null | xargs -r kill 2>/dev/null; done
    sleep 0.5
    for n in $ALL; do ip netns del $n 2>/dev/null; done
}
trap cleanup EXIT
cleanup

# ---------------------------------------------------------------- topology
for n in $ALL; do ip netns add $n; ip -n $n link set lo up; done
ip link add ue0  numtxqueues 4 netns $UE  type veth peer name gw0  netns $GW
ip link add gw1  netns $GW  type veth peer name rad0  netns $RAD
ip link add rad1 netns $RAD type veth peer name core0 netns $CORE
ip -n $UE   addr add 10.250.1.1/24 dev ue0
ip -n $GW   addr add 10.250.1.2/24 dev gw0
ip -n $GW   addr add 10.250.2.1/24 dev gw1
ip -n $RAD  addr add 10.250.2.2/24 dev rad0
ip -n $RAD  addr add 10.250.3.1/24 dev rad1
ip -n $CORE addr add 10.250.3.2/24 dev core0
for p in "$UE ue0" "$GW gw0" "$GW gw1" "$RAD rad0" "$RAD rad1" "$CORE core0"; do set -- $p
    ip -n $1 link set $2 up
    ip netns exec $1 ethtool -K $2 tso off gso off gro off >/dev/null 2>&1
done
ip -n $UE   route add default via 10.250.1.2
ip -n $GW   route add default via 10.250.2.2
ip -n $RAD  route add 10.250.1.0/24 via 10.250.2.1
ip -n $CORE route add default via 10.250.3.1
ip netns exec $GW  sysctl -qw net.ipv4.ip_forward=1
ip netns exec $RAD sysctl -qw net.ipv4.ip_forward=1
# protected stream -> skb priority 4 -> traffic class 1 (the protected window)
ip netns exec $UE iptables -t mangle -A OUTPUT -p udp --dport 5301 -j CLASSIFY --set-class 0:4

TAPRIO_4MS=(num_tc 2 map 0 0 0 0 1 0 0 1 0 0 0 0 0 0 0 0 queues 1@0 1@1
            base-time 0
            sched-entry S 02 1560000
            sched-entry S 00 400000
            sched-entry S 01 2040000
            clockid CLOCK_TAI)

set_gate() {   # on|off
    ip netns exec $UE tc qdisc del dev ue0 root 2>/dev/null
    if [ "$1" = on ]; then ip netns exec $UE tc qdisc add dev ue0 root handle 100: taprio "${TAPRIO_4MS[@]}"
    else ip netns exec $UE tc qdisc add dev ue0 root pfifo limit 1000; fi
}
set_shaper() { # on|off  (the qdisc wwan0 has in the real UE)
    ip netns exec $GW tc qdisc del dev gw1 root 2>/dev/null
    if [ "$1" = on ]; then
        ip netns exec $GW tc qdisc add dev gw1 root handle 1: htb default 20 r2q 100
        ip netns exec $GW tc class add dev gw1 parent 1: classid 1:1 htb rate ${SHAPE_MBPS}mbit
        ip netns exec $GW tc class add dev gw1 parent 1:1 classid 1:10 htb rate 20mbit ceil ${SHAPE_MBPS}mbit prio 0
        ip netns exec $GW tc class add dev gw1 parent 1:1 classid 1:20 htb rate 1mbit ceil ${SHAPE_MBPS}mbit prio 1
        ip netns exec $GW tc qdisc add dev gw1 parent 1:10 pfifo limit 256
        ip netns exec $GW tc qdisc add dev gw1 parent 1:20 pfifo limit 256
        ip netns exec $GW tc filter add dev gw1 parent 1: protocol ip prio 1 u32 match ip dport 5301 0xffff flowid 1:10
    else ip netns exec $GW tc qdisc add dev gw1 root pfifo limit 1000; fi
}
radio_reset() {   # fresh counters every phase
    ip netns exec $RAD tc qdisc del dev rad1 root 2>/dev/null
    ip netns exec $RAD tc qdisc add dev rad1 root tbf rate ${RADIO_MBPS}mbit burst 6000 limit $((BUF_PKTS * 1250))
}

run_phase() {   # name gate shaper talker-mode flood
    local name=$1 gate=$2 shaper=$3 mode=$4 flood=$5
    echo "== $name: gate=$gate shaper=$shaper talker=$mode flood=$flood (${DUR}s)"
    ip netns pids $CORE | xargs -r kill 2>/dev/null; sleep 0.3
    radio_reset; set_gate "$gate"; set_shaper "$shaper"
    ip netns exec $CORE iperf3 -s -p 5302 -D
    ip netns exec $CORE python3 "$TALKER" recv --port 5301 --duration $((DUR + 4)) --out "$OUT/$name.talker.json" >/dev/null &
    sleep 0.5
    if [ "$flood" = yes ]; then
        ip netns exec $UE iperf3 -c 10.250.3.2 -p 5302 -u -b ${FLOOD_MBPS}M -l 1200 -t $((DUR + 2)) -J > "$OUT/$name.flood.json" 2>/dev/null &
        sleep 1
    fi
    ip netns exec $UE python3 "$TALKER" send --dst 10.250.3.2 --port 5301 --mode "$mode" --duration $DUR >/dev/null
    wait
    ip netns exec $UE tc -s qdisc show dev ue0  > "$OUT/$name.gate-stats"
    ip netns exec $GW tc -s qdisc show dev gw1  > "$OUT/$name.shaper-stats"
    ip netns exec $RAD tc -s qdisc show dev rad1 > "$OUT/$name.radio-stats"
}

run_phase E-baseline off off uniform   no
run_phase A-none     off off uniform   yes
run_phase B-uni      off on  uniform   yes
run_phase B-sch      off on  scheduled yes
run_phase C-gate     on  off uniform   yes
run_phase F-uni      on  on  uniform   yes
run_phase F-sch      on  on  scheduled yes

python3 - "$OUT" "$RADIO_MBPS" "$SHAPE_MBPS" "$FLOOD_MBPS" <<'PY'
import json, os, re, sys
out, radio, shape, flood = sys.argv[1:]
def load(p):
    try:
        t = open(p).read(); return json.loads(t[t.index("{"):])
    except Exception:
        return {}
def drops(p):
    m = re.search(r"dropped (\d+)", open(p).read()) if os.path.exists(p) else None
    return int(m.group(1)) if m else 0
print(f"\nradio {radio} Mbit/s, shaper {shape}, flood {flood} offered; protected = 9.6 Mbit/s talker")
print("delay = one-way, sender and listener share the clock here\n")
print(f"{'phase':<12}{'loss %':>8}{'delay p50':>11}{'p99':>8}{'max':>8}{'flood Mbit/s':>14}{'radio drops':>13}")
for n in ["E-baseline", "A-none", "B-uni", "B-sch", "C-gate", "F-uni", "F-sch"]:
    t = load(f"{out}/{n}.talker.json"); f = load(f"{out}/{n}.flood.json")
    s = f.get("end", {}).get("sum")
    fm = f"{s['bits_per_second'] * (1 - s['lost_percent'] / 100) / 1e6:.1f}" if s else "-"
    if "delay_us" not in t:
        print(f"{n:<12}  no talker result ({out}/{n}.talker.json)"); continue
    d = t["delay_us"]
    ms = lambda x: f"{x / 1000:.2f}"
    print(f"{n:<12}{t['loss_pct']:>8.2f}{ms(d['p50']):>11}{ms(d['p99']):>8}{ms(d['max']):>8}{fm:>14}{drops(f'{out}/{n}.radio-stats'):>13}")
print("\n(delays in ms.)  raw files:", out)
PY
