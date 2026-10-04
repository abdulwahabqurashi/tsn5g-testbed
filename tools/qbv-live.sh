#!/bin/bash
# Stage 6 on the real uplink: the Qbv gate, today's priority policy, and the
# radio's TDD frame, measured with a time-stamped talker.
#
#   tools/qbv-live.sh                 (as the desktop user on the UE; ~6 minutes; asks for sudo)
#
# Needs: the bearer up, the cameras STOPPED (they would share the link), an SSH
# key to the core (ssh-copy-id $CORE_SSH), iperf3 and python3 on the core.
#
# Test traffic comes from a throwaway namespace, qbvt, behind a 4-queue veth
# where the gate goes. It is NATed out of the modem as camera traffic is; the
# protected talker leaves from source port GBR_PORT, so it rides the GBR flow
# like camera 1.
#
#   qbvt (talker + flood) ──veth qbvt1: GATE──► root ns ──wwan0: SHAPER──► modem ──► radio ──► core
#
# The daemon's queue policy is saved, replaced for the test and restored at
# the end (auto-rate resumes by itself), even on Ctrl-C.
#
# Phases (DUR seconds each, flood FLOOD_MBPS unless noted):
#   P-baseline  talker alone, no policy, no flood
#   A-none      no policy
#   B-uni/sch   shaper + strict priority (today's policy), uniform / scheduled talker
#   F-uni/sch   gate video-4ms + shaper
#   G-sch       gate on the radio's 5 ms TDD frame + shaper, talker on the same 5 ms grid
#   S-sweep     no flood, no policy: one packet per 5 ms frame, send phase stepped
#               through the frame -> where the uplink slots are
#
# Delay across the 5G link: UE and core clocks are not the same timescale, so
# the report gives delay VARIATION (each packet's delay above the best one),
# which needs no clock sync.
set -uo pipefail
if [ "$(id -u)" -eq 0 ]; then
    echo "error: run as your normal user, without sudo (it needs your SSH key to the core; it asks for sudo itself)" >&2
    exit 1
fi
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TALKER=$TOOLS/qbv-talker.py

DUR=${DUR:-30}
SHAPE_MBPS=${SHAPE_MBPS:-40}
FLOOD_MBPS=${FLOOD_MBPS:-80}
SWEEP_DUR=${SWEEP_DUR:-40}
PHASES=${PHASES:-"P-baseline A-none B-uni B-sch F-uni F-sch G-sch S-sweep"}   # e.g. PHASES="P-baseline A-none B-uni"
OUT=${OUT:-$HOME/qbv-runs/$(date +%Y%m%d-%H%M%S)}
NS=qbvt; VR=qbvt0; VN=qbvt1; NET=10.201.0
TPORT=5301; FPORT=5311

die() { echo "error: $*" >&2; exit 1; }
say() { echo "$*" | tee -a "$OUT/run.log"; }
mkdir -p "$OUT"

# ------------------------------------------------------------- preconditions
BIND=$(ip -4 -o addr show "$WWAN" | awk '{print $4}' | cut -d/ -f1)
[ -n "$BIND" ] || die "$WWAN has no address — bring the bearer up first"
ping -c3 -W2 -I "$WWAN" "$CORE_IP" >/dev/null 2>&1 || die "the core ($CORE_IP) does not answer over $WWAN"
pgrep -f bin/pathStream1 >/dev/null && die "camera encoders are running — stop them first: UI -> Cameras -> Stop, or: sudo $ENCODER_SCRIPT stop"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$CORE_SSH" 'command -v iperf3 >/dev/null && python3 -c "import time; time.CLOCK_TAI"' \
    || die "need passwordless SSH to $CORE_SSH with iperf3 and python3 there (ssh-copy-id $CORE_SSH)"
scp -q "$TALKER" "$CORE_SSH:/tmp/qbv-talker.py" || die "could not copy the talker to the core"
QUEUE_BEFORE=$(curl -sf "$API/api/bearer/queue") || die "the UE daemon API ($API) does not answer"
sudo true || exit 1
say "UE $BIND -> core $CORE_IP; shaper ${SHAPE_MBPS} Mbit/s; flood ${FLOOD_MBPS} Mbit/s; ${DUR}s per phase"
echo "$QUEUE_BEFORE" > "$OUT/queue-before.json"

# ------------------------------------------------------------- setup/cleanup
# Each rule as "table chain spec"; added with -I at the top, removed with -D.
RULES=(
  "nat POSTROUTING -s $NET.0/30 -o $WWAN -p udp --dport $TPORT -j MASQUERADE --to-ports $GBR_PORT"
  "nat POSTROUTING -s $NET.0/30 -o $WWAN -j MASQUERADE"
  "filter FORWARD -i $VR -o $WWAN -j ACCEPT"
  "filter FORWARD -i $WWAN -o $VR -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
)
CLS_RULE="mangle POSTROUTING -o $WWAN -p udp --dport $TPORT -j CLASSIFY --set-class 1:10"
rule() {   # add|del "table chain spec..."
    local op=$1; set -- $2; local t=$1 c=$2; shift 2
    if [ "$op" = add ]; then
        sudo iptables -t "$t" -C "$c" "$@" 2>/dev/null || sudo iptables -t "$t" -I "$c" 1 "$@"
    else
        while sudo iptables -t "$t" -D "$c" "$@" 2>/dev/null; do :; done
    fi
}

cleanup() {
    set +e
    echo; echo "cleaning up"
    sudo ip netns pids $NS 2>/dev/null | xargs -r sudo kill 2>/dev/null
    sudo ip netns del $NS 2>/dev/null
    local r
    for r in "${RULES[@]}" "$CLS_RULE"; do rule del "$r"; done
    ssh -o BatchMode=yes "$CORE_SSH" 'pkill -f "^python3 /tmp/qbv-talker.py recv"; pkill -f "^iperf3 -s -p '$FPORT'"' 2>/dev/null
    # put the daemon's queue policy back exactly as it was; auto-rate restarts with it
    python3 -c '
import json, sys, urllib.request
q = json.loads(open(sys.argv[1]).read())
body = json.dumps({k: q[k] for k in ("policy", "limit", "be_mbps", "link_mbps")}).encode()
r = urllib.request.Request(sys.argv[2] + "/api/bearer/queue", data=body, method="PUT",
                           headers={"Content-Type": "application/json"})
print("queue policy restored:", json.loads(urllib.request.urlopen(r, timeout=15).read())["policy"])
' "$OUT/queue-before.json" "$API" || echo "WARNING: restore the queue policy in the UI (Cameras -> queue policy)"
}
trap cleanup EXIT INT TERM

sudo ip netns add $NS
sudo ip link add $VN numtxqueues 4 netns $NS type veth peer name $VR
sudo ip addr add $NET.1/30 dev $VR; sudo ip link set $VR up
sudo ip -n $NS addr add $NET.2/30 dev $VN
sudo ip -n $NS link set $VN up; sudo ip -n $NS link set lo up
sudo ip -n $NS route add default via $NET.1
sudo ip netns exec $NS ethtool -K $VN tso off gso off >/dev/null 2>&1
sudo ethtool -K $VR gro off >/dev/null 2>&1
sudo ip netns exec $NS iptables -t mangle -A OUTPUT -p udp --dport $TPORT -j CLASSIFY --set-class 0:4
# the general MASQUERADE must sit BELOW the protected one, so add it first
for ((i = ${#RULES[@]} - 1; i >= 0; i--)); do rule add "${RULES[$i]}" || die "iptables: ${RULES[$i]}"; done
sudo sysctl -qw net.ipv4.ip_forward=1

# hand wwan0's queue to this script: 'shallow' makes auto-rate stand down
curl -sf -X PUT "$API/api/bearer/queue" -H 'Content-Type: application/json' \
    -d '{"policy":"shallow","limit":1000}' >/dev/null || die "could not take over the $WWAN queue"

# ------------------------------------------------------------------ policies
taprio_args() {   # cycle_us protected_us guard_us
    local c=$1 p=$2 g=$3
    echo "num_tc 2 map 0 0 0 0 1 0 0 1 0 0 0 0 0 0 0 0 queues 1@0 1@1 base-time 0" \
         "sched-entry S 02 $((p * 1000)) sched-entry S 00 $((g * 1000))" \
         "sched-entry S 01 $(((c - p - g) * 1000)) clockid CLOCK_TAI"
}
set_gate() {      # off | 4ms | 5ms
    sudo ip netns exec $NS tc qdisc del dev $VN root 2>/dev/null
    case $1 in
        4ms) sudo ip netns exec $NS tc qdisc add dev $VN root handle 100: taprio $(taprio_args 4000 1560 400) ;;
        5ms) sudo ip netns exec $NS tc qdisc add dev $VN root handle 100: taprio $(taprio_args 5000 1950 400) ;;
    esac 2>&1 | grep -v "Size table" || true
}
set_shaper() {    # on | off   (on = today's policy: HTB below the radio, protected strict priority)
    rule del "$CLS_RULE"
    sudo tc qdisc del dev "$WWAN" root 2>/dev/null
    if [ "$1" = on ]; then
        sudo tc qdisc add dev "$WWAN" root handle 1: htb default 20 r2q 10
        sudo tc class add dev "$WWAN" parent 1: classid 1:1 htb rate ${SHAPE_MBPS}mbit ceil ${SHAPE_MBPS}mbit
        sudo tc class add dev "$WWAN" parent 1:1 classid 1:10 htb rate 20mbit ceil ${SHAPE_MBPS}mbit prio 0 quantum 1400
        sudo tc class add dev "$WWAN" parent 1:1 classid 1:20 htb rate 1mbit ceil ${SHAPE_MBPS}mbit prio 1 quantum 1400
        sudo tc qdisc add dev "$WWAN" parent 1:10 pfifo limit 256
        sudo tc qdisc add dev "$WWAN" parent 1:20 pfifo limit 256
        rule add "$CLS_RULE"
    else
        sudo tc qdisc add dev "$WWAN" root pfifo limit 1000
    fi
}

# ---------------------------------------------------------------- diagnostics
# Every counter a talker packet passes on its way from the namespace to wwan0,
# so a loss can be pinned to one hop instead of guessed at.
snap() {   # file
    {
        echo "### ns nstat";      sudo ip netns exec $NS nstat -az 2>/dev/null | grep -E "UdpOutDatagrams|UdpSndbufErrors|UdpNoPorts|IpOutRequests|IpOutDiscards|IpOutNoRoutes"
        echo "### ns link";       sudo ip netns exec $NS ip -s -s link show $VN
        echo "### root link";     ip -s -s link show $VR; ip -s -s link show "$WWAN"
        echo "### root nstat";    nstat -az 2>/dev/null | grep -E "IpForwDatagrams|IpOutDiscards|IpOutNoRoutes|IpInDiscards|IpInAddrErrors|IpExtInNoRoutes|IpInHdrErrors"
        echo "### nat";           sudo iptables -t nat -L POSTROUTING -v -n -x | grep -E "$NET|pkts"
        echo "### forward";       sudo iptables -L FORWARD -v -n -x | head -12
        echo "### mangle";        sudo iptables -t mangle -L POSTROUTING -v -n -x | head -12
        echo "### conntrack";     sudo conntrack -S 2>/dev/null | awk '{for(i=2;i<=NF;i++){split($i,a,"=");s[a[1]]+=a[2]}} END{for(k in s) printf "%s=%d ", k, s[k]; print ""}'
        echo "### softnet";       python3 -c "print(sum(int(l.split()[1],16) for l in open('/proc/net/softnet_stat')))"
    } > "$1" 2>&1
}

# --------------------------------------------------------------------- phases
run_phase() {   # name gate shaper mode flood [talker args...]
    local name=$1 gate=$2 shaper=$3 mode=$4 flood=$5; shift 5
    case " $PHASES " in *" $name "*) ;; *) return 0 ;; esac
    local dur=$DUR; [ "$mode" = sweep ] && dur=$SWEEP_DUR
    say "== $name: gate=$gate shaper=$shaper talker=$mode flood=$flood (${dur}s)"
    set_gate "$gate"; set_shaper "$shaper"
    ssh -o BatchMode=yes "$CORE_SSH" "timeout $((dur + 15)) python3 /tmp/qbv-talker.py recv --port $TPORT --duration $((dur + 6)) --out /tmp/qbv-$name.json" >/dev/null &
    local rx=$!
    sleep 2
    snap "$OUT/$name.diag-before"
    if [ "$flood" = yes ]; then
        ssh -o BatchMode=yes "$CORE_SSH" "iperf3 -s -p $FPORT -1 -D"; sleep 1
        sudo ip netns exec $NS iperf3 -c "$CORE_IP" -p $FPORT -u -b ${FLOOD_MBPS}M -l 1200 -t $((dur + 2)) -J > "$OUT/$name.flood.json" 2>/dev/null &
        sleep 1
    fi
    sudo ip netns exec $NS python3 "$TALKER" send --dst "$CORE_IP" --port $TPORT --mode "$mode" --duration "$dur" "$@" > "$OUT/$name.sent.json"
    wait
    snap "$OUT/$name.diag-after"
    scp -q "$CORE_SSH:/tmp/qbv-$name.json" "$OUT/$name.talker.json" 2>/dev/null || say "   (no talker result for $name)"
    tc -s qdisc show dev "$WWAN" > "$OUT/$name.wwan0-stats"
    sudo ip netns exec $NS tc -s qdisc show dev $VN > "$OUT/$name.gate-stats"
}

run_phase P-baseline off off uniform   no
run_phase A-none     off off uniform   yes
run_phase B-uni      off on  uniform   yes
run_phase B-sch      off on  scheduled yes
run_phase F-uni      4ms on  uniform   yes
run_phase F-sch      4ms on  scheduled yes
run_phase G-sch      5ms on  scheduled yes --cycle-us 5000 --burst 5
run_phase S-sweep    off off sweep     no  --cycle-us 5000 --step-us 250 --size 200

# --------------------------------------------------------------------- report
python3 - "$OUT" "$SHAPE_MBPS" "$FLOOD_MBPS" <<'PY' | tee -a "$OUT/run.log"
import json, sys
out, shape, flood = sys.argv[1:]
def load(p):
    try:
        t = open(p).read(); return json.loads(t[t.index("{"):])
    except Exception:
        return {}
print(f"\nshaper {shape} Mbit/s, flood {flood} offered; protected = 9.6 Mbit/s talker on the GBR flow")
print("delay variation = each packet's one-way delay above the best packet's (ms)\n")
print(f"{'phase':<12}{'loss %':>8}{'var p50':>9}{'p99':>8}{'max':>8}{'flood Mbit/s':>14}")
for n in ["P-baseline", "A-none", "B-uni", "B-sch", "F-uni", "F-sch", "G-sch"]:
    t = load(f"{out}/{n}.talker.json"); f = load(f"{out}/{n}.flood.json")
    s = (f.get("end") or {}).get("sum")
    fm = f"{s['bits_per_second'] * (1 - s['lost_percent'] / 100) / 1e6:.1f}" if s else "-"
    v = t.get("variation_us")
    if not v:
        print(f"{n:<12}  no result"); continue
    ms = lambda x: f"{x / 1000:.2f}"
    print(f"{n:<12}{t['loss_pct']:>8.2f}{ms(v['p50']):>9}{ms(v['p99']):>8}{ms(v['max']):>8}{fm:>14}")
sw = load(f"{out}/S-sweep.talker.json").get("per_offset_us")
if sw:
    print("\nTDD scan: delay above the best packet, by send phase in the 5 ms radio frame")
    print(f"{'offset ms':>10}{'p50 ms':>8}  ")
    best = min(v["p50"] for v in sw.values())
    for o, v in sw.items():
        bar = "#" * int(round(v["p50"] / 250))
        mark = "  <- fastest" if v["p50"] == best else ""
        print(f"{int(o) / 1000:>10.2f}{v['p50'] / 1000:>8.2f}  {bar}{mark}")
import re
def num(txt, pat):
    m = re.search(pat, txt, re.M)
    return int(m.group(1)) if m else None
def linkstats(txt, dev):
    """(tx_packets, tx_dropped, rx_packets, rx_dropped) of one device in `ip -s -s link` output."""
    m = re.search(r"\d+: " + re.escape(dev) + r"[@:].*?RX:.*?\n\s*(\d+)\s+(\d+)\s+\d+\s+(\d+).*?TX:.*?\n\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)", txt, re.S)
    return None if not m else dict(rx_pkts=int(m.group(2)), rx_drop=int(m.group(3)), tx_pkts=int(m.group(5)), tx_drop=int(m.group(6)))
print("\nwhere the protected talker's packets went (counter deltas over each phase; flood included where it shares the counter)")
rows = [("talker sent", None), ("ns UdpSndbufErrors", r"UdpSndbufErrors\s+(\d+)"), ("ns IpOutDiscards", r"IpOutDiscards\s+(\d+)"),
        ("root IpForwDatagrams", r"IpForwDatagrams\s+(\d+)"), ("root IpOutDiscards", r"IpOutDiscards\s+(\d+)"),
        ("root IpInDiscards", r"IpInDiscards\s+(\d+)"), ("softnet drops", r"### softnet\n(\d+)")]
import glob
for n in [x.split("/")[-1][:-len(".diag-after")] for x in sorted(glob.glob(f"{out}/*.diag-after"))]:
    b = open(f"{out}/{n}.diag-before").read(); a = open(f"{out}/{n}.diag-after").read()
    sent = load(f"{out}/{n}.sent.json").get("sent")
    t = load(f"{out}/{n}.talker.json")
    print(f"\n  {n}: talker sent {sent}, core received {t.get('received')}")
    for label, pat in rows[1:]:
        vb, va = num(b, pat), num(a, pat)
        if vb is not None and va is not None:
            print(f"    {label:<24}{va - vb:>10}")
    for dev in ("qbvt1", "qbvt0"):
        lb, la = linkstats(b, dev), linkstats(a, dev)
        if lb and la:
            print(f"    {dev:<8} tx {la['tx_pkts']-lb['tx_pkts']:>8} tx_drop {la['tx_drop']-lb['tx_drop']:>7}   rx {la['rx_pkts']-lb['rx_pkts']:>8} rx_drop {la['rx_drop']-lb['rx_drop']:>7}")
    for line in a.split("### nat")[1].split("###")[0].strip().splitlines()[1:]:
        print("    nat  " + " ".join(line.split()[:2]) + "  " + " ".join(line.split()[2:])[:90])
    ca = a.split("### conntrack")[1].split("###")[0].strip(); cb = b.split("### conntrack")[1].split("###")[0].strip()
    if ca:
        da = dict(x.split("=") for x in ca.split()); db = dict(x.split("=") for x in cb.split())
        print("    conntrack " + " ".join(f"{k}+{int(da[k])-int(db.get(k,0))}" for k in sorted(da) if int(da[k]) != int(db.get(k, 0))))
print(f"\nraw files: {out}")
PY
