#!/bin/bash
# profile_compare.sh - measure one 5QI profile over a fixed uplink run.
#
#   ./profile_compare.sh <label> [seconds]        # drive the run from here
#   ./profile_compare.sh <label> [seconds] --wait # a client elsewhere drives it
#
# Run it once per profile, then:
#   ./profile_compare.sh --report
#
# Why a script rather than two hand-run iperfs: the two legs must be measured
# identically or the comparison is decoration. This brackets each run with the
# same counters, records the 5QI and RLC mode ACTUALLY in force (read back from
# the F1AP UE Context Setup, not assumed), and refuses a run whose bearer
# changed underneath it.
#
# What the two profiles differ by, and so what to look for:
#   5QI 7 - prio 70, PDB 100 ms, PER 1e-3, RLC UM (NO ARQ), discard_timer -1
#   5QI 9 - prio 90, PDB 300 ms, PER 1e-6, RLC AM (ARQ),    discard_timer -1
# With ONE UE there is no contention, so priority cannot show. The observable
# difference is the reliability mode: UM drops what AM would retransmit, which
# TCP sees as retransmits and reduced goodput.
set -uo pipefail

TB=/home/tsn_server/tsntestbed
GNB_LOG=$TB/gnb.log
SMF_LOG=/var/local/log/open5gs/smf.log
OUT=$TB/profile-runs
UE_IP_DEFAULT=10.45.0.12
DUR=${2:-300}
mkdir -p "$OUT"

if [ -t 1 ]; then G=$'\033[0;32m'; R=$'\033[0;31m'; Y=$'\033[1;33m'; B=$'\033[1m'; N=$'\033[0m'
else G=; R=; Y=; B=; N=; fi

# NOTE: grep -c prints "0" AND exits 1 when there are no matches, so a
# `|| echo 0` fallback emits BOTH and the caller gets "0\n0", which breaks every
# arithmetic expression downstream. Capture instead and default only if empty.
cnt() { local c; c=$(grep -c "$1" "$GNB_LOG" 2>/dev/null); echo "${c:-0}"; }
rx()  { cat /sys/class/net/ogstun/statistics/rx_bytes; }
tx()  { cat /sys/class/net/ogstun/statistics/tx_bytes; }

# ------------------------------------------------------------------- report
if [ "${1:-}" = "--report" ]; then
    shopt -s nullglob
    files=("$OUT"/*.env)
    [ ${#files[@]} -eq 0 ] && { echo "No runs in $OUT yet."; exit 1; }
    printf "\n${B}%-10s %8s %8s %9s %8s %8s %7s %7s %7s${N}\n" \
           LABEL 5QI RLC UL_Mbps RETR LATE/min UNDER/s DISC OVF
    for f in "${files[@]}"; do
        # shellcheck disable=SC1090
        ( source "$f"
          printf "%-10s %8s %8s %9.1f %8s %8.0f %7.2f %7s %7s\n" \
            "$LABEL" "$FIVEQI" "$RLC" "$UL_MBPS" "$RETR" \
            "$(echo "$LATE*60/$SECS" | bc -l)" \
            "$(echo "$UNDER/$SECS" | bc -l)" "$DISC" "$OVF" )
    done
    echo
    echo "UL_Mbps  = IP goodput measured on ogstun (not radio-layer rate)"
    echo "RETR     = TCP retransmits reported by iperf3 (n/a if the run was --wait)"
    echo "LATE/min = RF: late. Keep metrics logging OFF for these runs - at"
    echo "           1 Hz it drove this from 15/min to 1665/min on 2026-09-23."
    echo "DISC/OVF = Discarded uplink slot / RF: overflow. Both must be 0."
    exit 0
fi

LABEL=${1:-}
[ -z "$LABEL" ] && { echo "usage: $0 <label> [seconds] [--wait]   |   $0 --report" >&2; exit 2; }
WAIT=no; [ "${3:-}" = "--wait" ] && WAIT=yes

# ----------------------------------------------------------------- preflight
echo "${B}Pre-flight${N}"
sess=$(grep -cE 'SMF-Sessions is now 1' "$SMF_LOG" 2>/dev/null)
UE_IP=$(grep 'UE SUPI' "$SMF_LOG" 2>/dev/null | tail -1 | sed -E 's/.*IPv4\[([0-9.]+)\].*/\1/')
UE_IP=${UE_IP:-$UE_IP_DEFAULT}
if ! ping -c2 -W2 "$UE_IP" >/dev/null 2>&1; then
    echo "  ${R}ABORT${N} UE $UE_IP not answering - bring the data call up first."
    exit 2
fi
echo "  ${G}ok${N}   UE $UE_IP answers"

# The bearer must be OURS for the duration. On 2026-09-23 a 300 s leg was
# voided by the DI-1200 session running its own tests concurrently: 44.5 Mbit/s
# of downlink we did not generate, which shares the TDD frame with uplink
# (600 UL vs 1400 DL slots per 2000) and produced a 2.1-83.9 Mbit/s swing that
# looked like profile behaviour and was not.
foreign=$(ss -tn 2>/dev/null | grep -cE '10\.45\.0\.[0-9]+:' || true)
r0=$(rx); t0=$(tx); sleep 3; r1=$(rx); t1=$(tx)
ulq=$(echo "($r1-$r0)*8/3/1000000" | bc -l); dlq=$(echo "($t1-$t0)*8/3/1000000" | bc -l)
busy=$(echo "$ulq > 1 || $dlq > 1" | bc -l)
if [ "${busy:-0}" = "1" ] || [ "${foreign:-0}" -gt 0 ]; then
    printf "  ${R}ABORT${N} bearer is not idle: UL %.1f / DL %.1f Mbit/s, %s foreign connection(s).\n" \
           "$ulq" "$dlq" "$foreign"
    echo "         Another session is using the link. A leg measured now is void."
    echo "         Stop the other traffic, then re-run."
    exit 2
fi
printf "  ${G}ok${N}   bearer idle (UL %.2f / DL %.2f Mbit/s), no foreign connections\n" "$ulq" "$dlq"

# Read back the 5QI and RLC mode ACTUALLY in force, from the last F1AP
# UE Context Setup. This is the difference between "we set it" and "it applied".
FIVEQI=$(grep -A40 'DRBs-ToBeSetupMod-Item' "$GNB_LOG" 2>/dev/null | grep -oE '"fiveQI": [0-9]+' | tail -1 | grep -oE '[0-9]+$')
RLC=$(grep -oE '"rLCMode": "[a-z-]+"' "$GNB_LOG" 2>/dev/null | tail -1 | sed -E 's/.*"rlc-([a-z]+)-.*/\1/')
if [ -z "$FIVEQI" ]; then
    echo "  ${Y}warn${N} could not read the 5QI from F1AP (needs f1ap_level: debug)"
    FIVEQI="?"; RLC="?"
else
    echo "  ${G}ok${N}   bearer in force: 5QI $FIVEQI, RLC ${RLC:-?}"
fi

if grep -q '\[METRICS' "$GNB_LOG" 2>/dev/null; then
    echo "  ${Y}warn${N} metrics logging is ON - it inflates RF: late ~100x and will"
    echo "         swamp any difference between the profiles. Turn it off."
fi

# ------------------------------------------------------------------ measure
D0=$(cnt 'Discarded uplink slot'); O0=$(cnt 'RF: overflow')
U0=$(cnt 'RF: underflow');         L0=$(cnt 'RF: late')
R0=$(rx); T0=$(tx); S0=$(date +%s)

echo
echo "${B}Running ${DUR}s${N} on 5QI $FIVEQI ($(date -u +%H:%M:%S) UTC)"
RETR="n/a"
if [ "$WAIT" = no ]; then
    # -R: the far end sends, so this measures UPLINK (UE -> core).
    # -B 10.45.0.1 pins the source to ogstun so the test CANNOT leave via the
    # management NIC (10.5.1.19) or the X410 link (192.168.10.3). The deck's
    # "BLOCKS EVERYTHING" correction was exactly this failure: pathStream1 sent
    # to an address that resolved out enp3s0, so months of figures were measured
    # over ethernet, not the radio. Verified here with `ip route get`, and
    # pinned as well so it cannot drift.
    J=$(iperf3 -c "$UE_IP" -B 10.45.0.1 -R -t "$DUR" -J 2>/dev/null)
    if [ -n "$J" ]; then
        RETR=$(echo "$J" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["end"]["sum_sent"].get("retransmits","n/a"))' 2>/dev/null || echo "n/a")
        echo "$J" > "$OUT/$LABEL.json"
    else
        echo "  ${R}no iperf3 result${N} - is a server running on the UE? (iperf3 -s -D)"
    fi
else
    echo "  waiting - start the client on the UE now"
    sleep "$DUR"
fi

D1=$(cnt 'Discarded uplink slot'); O1=$(cnt 'RF: overflow')
U1=$(cnt 'RF: underflow');         L1=$(cnt 'RF: late')
R1=$(rx); T1=$(tx); S1=$(date +%s)
SECS=$((S1-S0)); [ "$SECS" -lt 1 ] && SECS=1

UL_MBPS=$(echo "($R1-$R0)*8/$SECS/1000000" | bc -l)
DL_MBPS=$(echo "($T1-$T0)*8/$SECS/1000000" | bc -l)

# Guard: a bearer change mid-run voids the comparison.
FQ2=$(grep -A40 'DRBs-ToBeSetupMod-Item' "$GNB_LOG" 2>/dev/null | grep -oE '"fiveQI": [0-9]+' | tail -1 | grep -oE '[0-9]+$')
if [ -n "$FQ2" ] && [ "$FQ2" != "$FIVEQI" ]; then
    echo "  ${R}FAIL${N} bearer changed mid-run ($FIVEQI -> $FQ2) - RESULT VOID"
    exit 1
fi

cat > "$OUT/$LABEL.env" <<EOF
LABEL=$LABEL
FIVEQI=$FIVEQI
RLC=${RLC:-?}
SECS=$SECS
UL_MBPS=$UL_MBPS
DL_MBPS=$DL_MBPS
RETR=$RETR
LATE=$((L1-L0))
UNDER=$((U1-U0))
DISC=$((D1-D0))
OVF=$((O1-O0))
EOF

echo
echo "${B}Result: $LABEL${N} (5QI $FIVEQI, RLC ${RLC:-?}, ${SECS}s)"
printf "  uplink goodput   : %.1f Mbit/s\n" "$UL_MBPS"
printf "  downlink         : %.1f Mbit/s\n" "$DL_MBPS"
printf "  TCP retransmits  : %s\n" "$RETR"
printf "  RF: late         : %d  (%.0f/min)\n" $((L1-L0)) "$(echo "($L1-$L0)*60/$SECS" | bc -l)"
printf "  RF: underflow    : %d  (%.2f/s)\n" $((U1-U0)) "$(echo "($U1-$U0)/$SECS" | bc -l)"
printf "  Discarded UL slot: %d   <- must be 0\n" $((D1-D0))
printf "  RF: overflow     : %d   <- wedge signature, must be 0\n" $((O1-O0))
echo
echo "saved to $OUT/$LABEL.env   -   compare with: $0 --report"
