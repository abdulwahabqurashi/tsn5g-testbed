#!/bin/bash
# uplink_test.sh - measure uplink slot discards across an iperf3 run.
#
#   ./uplink_test.sh            # wait for a client, measure, report
#   ./uplink_test.sh --no-serve # a server is already running; just measure
#
# Why this and not qos_measure.sh: that script measures a ping bearer and tracks
# "Downlink data late" / underflow / overflow. The uplink wedge signature is
# "Discarded uplink slot", which it does not count at all. This one brackets an
# actual uplink iperf3 run and counts discards over exactly that window.
#
# Run this on amrctsnserver FIRST, then start the client on the DI-1200:
#     iperf3 -c 10.45.0.1 -t <seconds>          # UE -> core = uplink
# The script detects the connection, samples for its whole duration, and stops
# when the client disconnects. It borrows the session-validity guards from
# qos_measure.sh: a discard count is meaningless if the bearer or the gNB
# changed mid-run.
set -u

GNB_LOG=${GNB_LOG:-/home/tsn_server/tsntestbed/gnb.log}
SMF_LOG=${SMF_LOG:-/var/local/log/open5gs/smf.log}
BIND=10.45.0.1                  # ogstun; the UE's default gateway
PORT=5201
WAIT_FOR_CLIENT=300             # give up if no client connects within this
SERVE=yes
[ "${1:-}" = "--no-serve" ] && SERVE=no

if [ -t 1 ]; then G=$'\033[0;32m'; R=$'\033[0;31m'; Y=$'\033[1;33m'; B=$'\033[1m'; N=$'\033[0m'
else G=; R=; Y=; B=; N=; fi

cnt()        { grep -c "$1" "$GNB_LOG" 2>/dev/null || echo 0; }
sess_count() { grep -E "SMF-Sessions is now" "$SMF_LOG" 2>/dev/null | tail -1 | sed -E 's/.*is now ([0-9]+).*/\1/'; }
ue_ip()      { grep "UE SUPI" "$SMF_LOG" 2>/dev/null | tail -1 | sed -E 's/.*IPv4\[([0-9.]+)\].*/\1/'; }
gnb_pid()    { systemctl show srsran-gnb -p MainPID --value 2>/dev/null; }
connected()  { ss -tn state established "( sport = :$PORT )" 2>/dev/null | tail -n +2 | grep -q .; }

cleanup() { [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null; }
trap cleanup EXIT

# ------------------------------------------------------------------ preflight
echo "${B}Pre-flight${N}"
S0=$(sess_count); IP0=$(ue_ip); P0=$(gnb_pid)
if [ "${S0:-0}" -lt 1 ]; then
    echo "  ${R}ABORT${N} no active PDU session (SMF-Sessions = ${S0:-0})."
    echo "         Bring the UE data call up on the DI-1200 first:"
    echo "             sudo ./ue_qmi_up.sh up"
    exit 2
fi
echo "  ${G}ok${N}   PDU session active, UE $IP0, gNB pid $P0"

if ! ip -br addr show ogstun 2>/dev/null | grep -q UP; then
    echo "  ${R}ABORT${N} ogstun is not up - the core is not forwarding."
    exit 2
fi
echo "  ${G}ok${N}   ogstun up"

# -------------------------------------------------------------------- server
if [ "$SERVE" = yes ]; then
    if ss -ltn "( sport = :$PORT )" 2>/dev/null | tail -n +2 | grep -q .; then
        echo "  ${Y}warn${N} something already listens on :$PORT - not starting another"
    else
        iperf3 -s -B "$BIND" >/tmp/iperf3-server.log 2>&1 &
        SRV_PID=$!
        sleep 1
        if kill -0 "$SRV_PID" 2>/dev/null; then
            echo "  ${G}ok${N}   iperf3 server started on $BIND:$PORT (pid $SRV_PID)"
        else
            echo "  ${R}ABORT${N} iperf3 server failed to start; see /tmp/iperf3-server.log"
            exit 2
        fi
    fi
fi

# ------------------------------------------------------------- wait + sample
echo
echo "${B}Waiting for the client${N} (up to ${WAIT_FOR_CLIENT}s)"
echo "  On the DI-1200 run:  ${B}iperf3 -c $BIND -t 120${N}"
echo "  (plain -c is UE->core, which is the uplink direction we care about)"

for i in $(seq "$WAIT_FOR_CLIENT"); do
    connected && break
    sleep 1
done
if ! connected; then
    echo "  ${R}ABORT${N} no client connected within ${WAIT_FOR_CLIENT}s."
    exit 2
fi

D0=$(cnt "Discarded uplink slot"); O0=$(cnt "RF: overflow")
U0=$(cnt "RF: underflow");         L0=$(cnt "RF: late")
T0=$(date +%s); TS0=$(date -u '+%H:%M:%S')
echo "  ${G}ok${N}   client connected at $TS0 UTC - sampling"

while connected; do sleep 1; done

D1=$(cnt "Discarded uplink slot"); O1=$(cnt "RF: overflow")
U1=$(cnt "RF: underflow");         L1=$(cnt "RF: late")
T1=$(date +%s); TS1=$(date -u '+%H:%M:%S')
DUR=$((T1-T0)); [ "$DUR" -lt 1 ] && DUR=1

# ------------------------------------------------------------------ validity
echo
echo "${B}Validity${N}"
BAD=0
S1=$(sess_count); IP1=$(ue_ip); P1=$(gnb_pid)
[ "${S1:-0}" -ge 1 ] && echo "  ${G}ok${N}   session still active" \
                     || { echo "  ${R}FAIL${N} session torn down mid-run - RESULT VOID"; BAD=1; }
[ "$IP0" = "$IP1" ]  && echo "  ${G}ok${N}   UE address unchanged ($IP0)" \
                     || { echo "  ${R}FAIL${N} UE address changed $IP0 -> $IP1 - RESULT VOID"; BAD=1; }
[ "$P0" = "$P1" ]    && echo "  ${G}ok${N}   gNB pid unchanged ($P0)" \
                     || { echo "  ${R}FAIL${N} gNB restarted mid-run ($P0 -> $P1) - RESULT VOID"; BAD=1; }
[ "$DUR" -ge 30 ]    && echo "  ${G}ok${N}   ${DUR}s sample" \
                     || echo "  ${Y}warn${N} only ${DUR}s sampled - short runs are noisy"

# -------------------------------------------------------------------- result
dd=$((D1-D0)); oo=$((O1-O0)); uu=$((U1-U0)); ll=$((L1-L0))

echo
echo "${B}Radio over the iperf window${N} ($TS0 -> $TS1 UTC, ${DUR}s)"
printf "  Discarded uplink slot : %6d  (%.1f/min)   <- the signature\n" \
       "$dd" "$(echo "$dd*60/$DUR" | bc -l)"
printf "  RF: overflow          : %6d               <- wedge signature, must be 0\n" "$oo"
printf "  RF: late              : %6d\n" "$ll"
printf "  RF: underflow         : %6d  (%.2f/s)     <- ~1/s is normal, ignore\n" \
       "$uu" "$(echo "$uu/$DUR" | bc -l)"

echo
echo "${B}Against the pre-tuning baseline${N}"
echo "  gnb-archive/gnb-20260922T211304Z.log: 2137 discards over 16:45:53-20:49:40"
echo "  = 14447s -> ${B}8.9 discards/min${N} under intermittent uplink load."
echo "  See rt-tuning-baseline-20260922.md for the full set."

echo
if [ "$BAD" -eq 1 ]; then
    echo "  ${R}This result is VOID - do not quote it.${N}"
    exit 1
fi
if [ "$dd" -eq 0 ] && [ "$oo" -eq 0 ]; then
    echo "  ${G}No discards and no overflow.${N} Consistent with the fix holding."
elif [ "$oo" -gt 0 ]; then
    echo "  ${R}RF: overflow present.${N} That is the wedge signature - the fault is NOT fixed."
else
    echo "  ${Y}Discards still present.${N} Compare the per-minute rate above with 8.9/min;"
    echo "  if it is not far below that, scheduling jitter was not the limit and the"
    echo "  next lever is load reduction (bandwidth or MCS), not more isolation."
fi
