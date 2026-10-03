#!/bin/bash
# Qbv gate design check, entirely in throwaway network namespaces: no wwan0,
# no cameras, no daemon, nothing outside the three namespaces it creates.
#
#   sudo tools/qbv-sandbox.sh            (about 2.5 minutes)
#
# It models the real uplink:
#
#   qbv-ue ──veth (the gate goes here)──► qbv-radio ──veth, tbf RADIO_MBPS──► qbv-core
#   protected stream + flood                FIFO the size of a modem buffer   iperf3 servers
#
# and runs the same protected stream (PROT_MBPS, 1200-byte UDP) against a
# flood (FLOOD_MBPS) under five UE-side policies:
#
#   A  none            plain FIFO on the UE
#   B  priority        HTB at SHAPE_MBPS, protected class strict priority (today's policy)
#   C  gate            taprio video-4ms only (the naive gate)
#   D  gate + rate     taprio video-4ms, each class's queue limited to SHAPE_MBPS
#                      (the gate behaving like a real Qbv port at the radio's speed)
#   E  baseline        protected stream alone, no flood, no policy
#
# Reported per policy: protected loss, jitter (RFC 3550, from iperf3: needs no
# clock sync), protected and flood goodput. The question it answers: does a
# software gate on the UE protect the stream once the bottleneck is downstream
# of it, and what does it take.
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
command -v iperf3 >/dev/null || { echo "iperf3 missing" >&2; exit 1; }

RADIO_MBPS=${RADIO_MBPS:-50}      # the bottleneck ("radio") rate
SHAPE_MBPS=${SHAPE_MBPS:-45}      # UE-side rate: just under the radio, as auto-rate does
PROT_MBPS=${PROT_MBPS:-15}        # protected stream (camera 1 runs ~15-20)
FLOOD_MBPS=${FLOOD_MBPS:-80}
DUR=${DUR:-20}
BUF_PKTS=${BUF_PKTS:-300}         # "modem buffer" in packets
OUT=${OUT:-/tmp/qbv-sandbox-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"

UE=qbv-ue; RAD=qbv-radio; CORE=qbv-core
cleanup() {
    for n in $UE $RAD $CORE; do ip netns pids $n 2>/dev/null | xargs -r kill 2>/dev/null; done
    sleep 0.5
    for n in $UE $RAD $CORE; do ip netns del $n 2>/dev/null; done
}
trap cleanup EXIT
cleanup

# ---------------------------------------------------------------- topology
for n in $UE $RAD $CORE; do ip netns add $n; ip -n $n link set lo up; done
ip link add ue0 numtxqueues 4 netns $UE type veth peer name rad0 netns $RAD
ip link add rad1 netns $RAD type veth peer name core0 netns $CORE
ip -n $UE   addr add 10.250.1.1/24 dev ue0
ip -n $RAD  addr add 10.250.1.2/24 dev rad0
ip -n $RAD  addr add 10.250.2.1/24 dev rad1
ip -n $CORE addr add 10.250.2.2/24 dev core0
for p in "$UE ue0" "$RAD rad0" "$RAD rad1" "$CORE core0"; do set -- $p; ip -n $1 link set $2 up; done
ip -n $UE   route add default via 10.250.1.2
ip -n $CORE route add default via 10.250.2.1
ip netns exec $RAD sysctl -qw net.ipv4.ip_forward=1
# no offloads: every packet is a real 1200-byte packet, as on the bearer
for p in "$UE ue0" "$RAD rad0" "$RAD rad1" "$CORE core0"; do set -- $p
    ip netns exec $1 ethtool -K $2 tso off gso off gro off >/dev/null 2>&1; done

# protected stream -> skb priority 4 -> traffic class 1 (the protected window)
ip netns exec $UE iptables -t mangle -A OUTPUT -p udp --dport 5301 -j CLASSIFY --set-class 0:4

start_servers() {
    # only processes inside qbv-core (pkill would reach every iperf3 on the host)
    ip netns pids $CORE | xargs -r kill 2>/dev/null; sleep 0.3
    ip netns exec $CORE iperf3 -s -p 5301 -D
    ip netns exec $CORE iperf3 -s -p 5302 -D
    sleep 0.5
}
radio_reset() {   # the radio: rate-limited, with a modem-sized FIFO; fresh counters per phase
    ip netns exec $RAD tc qdisc replace dev rad1 root tbf rate ${RADIO_MBPS}mbit burst 6000 limit $((BUF_PKTS * 1250))
}

# ------------------------------------------------------------------ policies
TAPRIO_4MS=(num_tc 2 map 0 0 0 0 1 0 0 1 0 0 0 0 0 0 0 0 queues 1@0 1@1
            base-time 0
            sched-entry S 02 1560000      # protected window (tc1)  39 %
            sched-entry S 00 400000       # guard band
            sched-entry S 01 2040000      # best-effort window (tc0)
            clockid CLOCK_TAI)

policy() {
    ip netns exec $UE tc qdisc del dev ue0 root 2>/dev/null
    case $1 in
        none|baseline) ip netns exec $UE tc qdisc add dev ue0 root pfifo limit 1000 ;;
        priority)
            ip netns exec $UE tc qdisc add dev ue0 root handle 1: htb default 20
            ip netns exec $UE tc class add dev ue0 parent 1: classid 1:1 htb rate ${SHAPE_MBPS}mbit
            ip netns exec $UE tc class add dev ue0 parent 1:1 classid 1:10 htb rate ${PROT_MBPS}mbit ceil ${SHAPE_MBPS}mbit prio 0
            ip netns exec $UE tc class add dev ue0 parent 1:1 classid 1:20 htb rate 1mbit ceil ${SHAPE_MBPS}mbit prio 1
            ip netns exec $UE tc filter add dev ue0 parent 1: protocol ip prio 1 u32 match ip dport 5301 0xffff flowid 1:10 ;;
        gate)
            ip netns exec $UE tc qdisc add dev ue0 root handle 100: taprio "${TAPRIO_4MS[@]}" ;;
        gate-rate)
            ip netns exec $UE tc qdisc add dev ue0 root handle 100: taprio "${TAPRIO_4MS[@]}"
            ip netns exec $UE tc qdisc replace dev ue0 parent 100:1 tbf rate ${SHAPE_MBPS}mbit burst 3000 limit 300000
            ip netns exec $UE tc qdisc replace dev ue0 parent 100:2 tbf rate ${SHAPE_MBPS}mbit burst 3000 limit 300000 ;;
    esac
}

run_phase() {   # name policy flood(yes/no)
    local name=$1 pol=$2 flood=$3
    echo "== $name: policy=$pol flood=$flood (${DUR}s)"
    start_servers
    radio_reset
    policy "$pol"
    ip netns exec $UE tc qdisc show dev ue0 > "$OUT/$name.qdisc"
    if [ "$flood" = yes ]; then
        ip netns exec $UE iperf3 -c 10.250.2.2 -p 5302 -u -b ${FLOOD_MBPS}M -l 1200 -t $((DUR + 2)) -J > "$OUT/$name.flood.json" 2>"$OUT/$name.flood.err" &
        sleep 1
    fi
    ip netns exec $UE iperf3 -c 10.250.2.2 -p 5301 -u -b ${PROT_MBPS}M -l 1200 -t $DUR -J > "$OUT/$name.prot.json" 2>"$OUT/$name.prot.err"
    wait
    ip netns exec $UE tc -s qdisc show dev ue0 > "$OUT/$name.qdisc-stats"
    ip netns exec $RAD tc -s qdisc show dev rad1 > "$OUT/$name.radio-stats"
}

run_phase E-baseline baseline  no
run_phase A-none     none      yes
run_phase B-priority priority  yes
run_phase C-gate     gate      yes
run_phase D-gate-rate gate-rate yes

# -------------------------------------------------------------------- report
python3 - "$OUT" "$RADIO_MBPS" "$SHAPE_MBPS" "$PROT_MBPS" "$FLOOD_MBPS" <<'PY'
import json, os, re, sys
out, radio, shape, prot, flood = sys.argv[1:]
def load(p):
    try:
        t = open(p).read(); return json.loads(t[t.index("{"):])
    except Exception:
        return None
def radio_drops(p):
    m = re.search(r"dropped (\d+)", open(p).read()) if os.path.exists(p) else None
    return int(m.group(1)) if m else 0
print(f"\nradio {radio} Mbit/s, UE shaping {shape}, protected {prot} offered, flood {flood} offered\n")
print(f"{'phase':<14}{'prot loss %':>12}{'jitter ms':>11}{'prot Mbit/s':>13}{'flood Mbit/s':>14}{'radio drops':>13}")
for name in ["E-baseline", "A-none", "B-priority", "C-gate", "D-gate-rate"]:
    p = load(f"{out}/{name}.prot.json"); f = load(f"{out}/{name}.flood.json")
    if not p or "end" not in p:
        print(f"{name:<14}  (no result: see {out}/{name}.prot.err)"); continue
    s = p["end"]["sum"]
    fm = f["end"]["sum"]["bits_per_second"] * (1 - f["end"]["sum"]["lost_percent"] / 100) / 1e6 if f and "end" in f else 0
    pm = s["bits_per_second"] * (1 - s["lost_percent"] / 100) / 1e6
    print(f"{name:<14}{s['lost_percent']:>12.2f}{s['jitter_ms']:>11.3f}{pm:>13.1f}{fm:>14.1f}{radio_drops(f'{out}/{name}.radio-stats'):>13}")
print(f"\nraw files: {out}")
PY
