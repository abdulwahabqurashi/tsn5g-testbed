#!/bin/bash
# Constant iperf3 load from this UE to the 5G core over wwan0, alternating TCP and
# UDP in both directions, with the radio sampled between legs so throughput can be
# read against RSRP/SINR.   ./iperf5g.sh   (Ctrl-C to stop)
#
# The default route on this box is ethernet, so every run is bound to the wwan0
# address - an unbound run to anything outside 10.45.0.0/16 would quietly travel
# over gigabit ethernet and report numbers that have nothing to do with 5G.
#
# Radio sampling needs root for /dev/ttyUSB*; without it the CSV still fills in,
# just with empty rsrp/sinr columns.
cd "$(dirname "$0")"

SRV="${SRV:-10.45.0.1}"          # core-side ogstun endpoint
# The SMF hands out a fresh address on every data call (seen as .2 then .3), so read
# it off the interface rather than hardcoding - a stale -B fails the run outright.
BIND="${BIND:-$(ip -4 -o addr show wwan0 | awk '{print $4}' | cut -d/ -f1)}"
[ -n "$BIND" ] || { echo "wwan0 has no IPv4 address - is the data call up?"; exit 1; }
PORT="${PORT:-5201}"
DUR="${DUR:-30}"                 # seconds per leg
# The bearer is markedly asymmetric (measured 2026-09-11: ~78 Mbps down, ~27 up), so
# each direction gets its own offered rate, set just under its TCP ceiling. A single
# shared rate would flood the uplink while leaving the downlink idle.
UDP_RATE_UP="${UDP_RATE_UP:-25M}"
UDP_RATE_DOWN="${UDP_RATE_DOWN:-70M}"
UDP_LEN="${UDP_LEN:-1200}"       # < wwan0 MTU 1400, so loss is loss and not fragmentation
MODE="${MODE:-tcp}"              # tcp | udp | both - TCP alone is what a stability watch wants
OUTDIR="${OUTDIR:-$PWD/iperf_logs/$(date +%Y%m%d-%H%M%S)}"

mkdir -p "$OUTDIR"
CSV="$OUTDIR/summary.csv"
echo "ts,seq,leg,proto,dir,mbps,retransmits,rtt_ms,jitter_ms,loss_pct,rsrp_dbm,sinr_db,status" > "$CSV"

echo "server   $SRV:$PORT"
echo "bind     $BIND  (wwan0)"
echo "mode     $MODE  (${DUR}s per leg)"
echo "logs     $OUTDIR"
echo

RSRP="" ; SINR=""

# Ask the modem where it stands. at.py holds /dev/ttyUSB* exclusively, so this only
# ever runs between iperf legs, never alongside one.
sample_radio() {
    local out
    out=$(WAIT=8 ./at.py 'AT+QRSRP' 'AT+QSINR' 2>/dev/null) || { RSRP=""; SINR=""; return; }
    # +QRSRP: -85,-120,-140,-140,NR5G   -> first value is the serving beam
    RSRP=$(grep -o '+QRSRP:[^|]*' <<<"$out" | head -1 | cut -d: -f2 | cut -d, -f1 | tr -d ' ')
    SINR=$(grep -o '+QSINR:[^|]*' <<<"$out" | head -1 | cut -d: -f2 | cut -d, -f2 | tr -d ' ')
    case "$RSRP" in ''|*[!-0-9]*) RSRP="" ;; esac
    case "$SINR" in ''|*[!-0-9]*) SINR="" ;; esac
}

# $1 seq  $2 leg label  $3 proto  $4 dir  $5... extra iperf args
run_leg() {
    local seq="$1" leg="$2" proto="$3" dir="$4"; shift 4
    local json="$OUTDIR/$(printf '%04d' "$seq")_$leg.json"
    local ts; ts=$(date -Is)

    if iperf3 -c "$SRV" -B "$BIND" -p "$PORT" -t "$DUR" -i 1 -J "$@" > "$json" 2>/dev/null \
       && ! jq -e 'has("error")' "$json" >/dev/null 2>&1; then
        # TCP reports retransmits and RTT on the sender; UDP reports jitter and loss
        # on the receiver, and for a -R run the receiver summary is the one to read.
        # One value per line, not TSV: `read` collapses consecutive tabs, which would
        # shift every field left whenever a metric is absent (UDP has no retransmits,
        # TCP has no jitter).
        local vals=()
        mapfile -t vals < <(jq -r '
            (.end.sum_sent      // .end.sum // {}) as $s |
            (.end.sum_received  // .end.sum // {}) as $r |
            [ (($r.bits_per_second // $s.bits_per_second // 0) / 1000000 | .*100|round/100),
              ($s.retransmits),
              (.end.streams[0].sender.mean_rtt | if . == null or . == 0 then null else ./1000|.*1000|round/1000 end),
              ($r.jitter_ms | if . == null then null else .*1000|round/1000 end),
              ($r.lost_percent | if . == null then null else .*100|round/100 end)
            ] | .[] | if . == null then "" else tostring end' "$json")
        local mbps="${vals[0]}" retr="${vals[1]}" rtt="${vals[2]}" jit="${vals[3]}" loss="${vals[4]}"
        printf '%s,%d,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,ok\n' \
            "$ts" "$seq" "$leg" "$proto" "$dir" "$mbps" "$retr" "$rtt" "$jit" "$loss" "$RSRP" "$SINR" >> "$CSV"
        printf '  %-9s %8s Mbps  retr=%-5s rtt=%-6s jit=%-6s loss=%-5s rsrp=%-5s sinr=%s\n' \
            "$leg" "$mbps" "${retr:--}" "${rtt:--}" "${jit:--}" "${loss:--}" "${RSRP:--}" "${SINR:--}"
    else
        printf '%s,%d,%s,%s,%s,,,,,,%s,%s,failed\n' \
            "$ts" "$seq" "$leg" "$proto" "$dir" "$RSRP" "$SINR" >> "$CSV"
        echo "  $leg FAILED - probing the bearer"
        ping -I wwan0 -c2 -W2 "$SRV" >/dev/null 2>&1 \
            && echo "    gateway still answers; server side may be down" \
            || echo "    no response from $SRV - bearer is down"
        sleep 10
    fi

    # An iperf3 server serves one test at a time and needs a moment to release the
    # slot. Reconnecting immediately gets the control connection RST during the
    # handshake - measured 2026-09-12 at 5 failures in 6 with no gap, versus 0 in 35
    # with two seconds. Without this the reverse legs fail ~43% of the time and it
    # reads convincingly like a network fault.
    sleep "${LEG_GAP:-3}"
}

trap 'echo; echo "stopped - $CSV"; exit 0' INT TERM

seq=0
while :; do
    seq=$((seq+1))
    sample_radio
    echo "[$(date +%H:%M:%S)] cycle $seq  rsrp=${RSRP:--} sinr=${SINR:--}"

    if [ "$MODE" = tcp ] || [ "$MODE" = both ]; then
        run_leg "$seq" tcp-up   tcp up   -O 2
        run_leg "$seq" tcp-down tcp down -R -O 2
    fi
    if [ "$MODE" = udp ] || [ "$MODE" = both ]; then
        run_leg "$seq" udp-up   udp up   -u -b "$UDP_RATE_UP"   -l "$UDP_LEN"
        run_leg "$seq" udp-down udp down -u -b "$UDP_RATE_DOWN" -l "$UDP_LEN" -R
    fi
done
