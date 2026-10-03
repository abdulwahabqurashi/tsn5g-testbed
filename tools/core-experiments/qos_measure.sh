#!/bin/bash
# qos_measure.sh - measure bearer performance with session-validity guards.
#
# Written 2026-09-22 after a measurement run produced "55-100% packet loss" that
# turned out to be pinging an address whose PDU session had been torn down
# minutes earlier. Loss figures are meaningless without proof the bearer existed
# for the whole sample, so this script refuses to report a number it cannot
# stand behind: it checks the session before AND after, and aborts if the
# session, the UE address or the gNB process changed mid-run.
#
# Usage: ./qos_measure.sh [seconds]     (default 300)

set -u
SMF_LOG=${SMF_LOG:-/var/local/log/open5gs/smf.log}
GNB_LOG=${GNB_LOG:-/home/tsn_server/tsntestbed/gnb.log}
DUR=${1:-300}

if [ -t 1 ]; then G=$'\033[0;32m'; R=$'\033[0;31m'; Y=$'\033[1;33m'; B=$'\033[1m'; N=$'\033[0m'
else G=; R=; Y=; B=; N=; fi

sess_count() { grep -E "SMF-Sessions is now" "$SMF_LOG" | tail -1 | sed -E 's/.*is now ([0-9]+).*/\1/'; }
ue_ip()      { grep "UE SUPI" "$SMF_LOG" | tail -1 | sed -E 's/.*IPv4\[([0-9.]+)\].*/\1/'; }
gnb_pid()    { systemctl show srsran-gnb -p MainPID --value 2>/dev/null; }
cnt()        { grep -c "$1" "$GNB_LOG" 2>/dev/null || echo 0; }

echo "${B}Pre-flight${N}"
S0=$(sess_count); IP0=$(ue_ip); P0=$(gnb_pid)
if [ "${S0:-0}" -lt 1 ]; then
  echo "  ${R}ABORT${N} no active PDU session (SMF-Sessions = ${S0:-0})."
  echo "         Bring the UE's data call up first - a loss figure measured"
  echo "         without a bearer is meaningless, which is exactly the trap"
  echo "         this script exists to prevent."
  exit 2
fi
echo "  ${G}ok${N}   PDU session active, UE $IP0, gNB pid $P0"
if ! ping -c2 -W2 "$IP0" >/dev/null 2>&1; then
  echo "  ${Y}warn${N} UE not answering pre-flight ping - it may be in RRC idle."
  echo "         Continuing, but treat a high loss figure with suspicion."
else
  echo "  ${G}ok${N}   UE answers"
fi

L0=$(cnt "Downlink data late"); U0=$(cnt "underflow"); M0=$(cnt "modulator is busy"); O0=$(cnt "RF: overflow")
T0=$(date -u '+%H:%M:%S')

echo
echo "${B}Measuring ${DUR}s${N} (started $T0 UTC)"
OUT=$(ping -c"$DUR" -i1 -W2 "$IP0" 2>&1)

S1=$(sess_count); IP1=$(ue_ip); P1=$(gnb_pid)
L1=$(cnt "Downlink data late"); U1=$(cnt "underflow"); M1=$(cnt "modulator is busy"); O1=$(cnt "RF: overflow")
T1=$(date -u '+%H:%M:%S')

echo
echo "${B}Validity${N}"
BAD=0
[ "${S1:-0}" -lt 1 ] && { echo "  ${R}FAIL${N} session was torn down during the run - RESULT VOID"; BAD=1; } || echo "  ${G}ok${N}   session still active"
[ "$IP0" = "$IP1" ] || { echo "  ${R}FAIL${N} UE address changed $IP0 -> $IP1 - RESULT VOID"; BAD=1; }
[ "$P0" = "$P1" ]   || { echo "  ${R}FAIL${N} gNB restarted mid-run ($P0 -> $P1) - RESULT VOID"; BAD=1; }

echo
echo "${B}Result${N} ($T0 -> $T1 UTC)"
echo "$OUT" | tail -3 | sed 's/^/  /'
echo
echo "${B}Radio over the same window${N}"
printf "  Downlink data late : %5d  (%.2f/s)\n" $((L1-L0)) "$(echo "($L1-$L0)/$DUR" | bc -l)"
printf "  underflow          : %5d  (%.2f/s)\n" $((U1-U0)) "$(echo "($U1-$U0)/$DUR" | bc -l)"
printf "  modulator is busy  : %5d\n" $((M1-M0))
printf "  RF: overflow       : %5d   <- wedge signature, must be 0\n" $((O1-O0))

echo
[ "$BAD" -eq 1 ] && { echo "  ${R}This result is VOID - do not quote it.${N}"; exit 1; }
echo "  ${G}Result is valid${N} - bearer held for the whole sample."
