#!/bin/bash
# irq_move_test.sh - test whether X410 fronthaul NIC IRQs contending with srsRAN's
# main processing pool cause the 'RF: late' deadline misses (and thus the UHD wedge).
#
# All four high-rate IRQs on enp109s0f1np1 (the X410 fronthaul, 192.168.10.3, MTU 9000)
# are TxR queues. Three of them sit on cores that gnb_x410.yaml also lists in
# main_pool_cpus, so fronthaul interrupt servicing preempts the threads that must meet
# slot deadlines:
#
#     irq 476 -> CPU49      634 int/s   in main_pool_cpus
#     irq 477 -> CPU53   61,579 int/s   in main_pool_cpus   <-- the big one
#     irq 479 -> CPU61   15,661 int/s   in main_pool_cpus
#     irq 491 -> CPU109  29,716 int/s   free, left alone
#
# Targets are node1 cores outside both ru_cpus (1,5,9,13) and main_pool_cpus
# (17,21,...,61). Staying on node1 matters: the NIC is on NUMA node 1 and the gNB runs
# under numactl --cpunodebind=1, so moving an IRQ off-node would add cross-node traffic
# and confound the result.
#
# Reversible, no downtime, does not touch the running deployment.
#
# Usage:
#   ./irq_move_test.sh status            # affinities + current rates   (no root)
#   ./irq_move_test.sh sample [MIN]      # measure RF:late rate         (no root)
#   sudo ./irq_move_test.sh apply        # move IRQs off the pool cores
#   sudo ./irq_move_test.sh revert       # restore saved affinities

set -u
GNB_LOG="${GNB_LOG:-/home/tsn_server/tsntestbed/gnb.log}"
STATE="/run/irq_move_test.state"
LOG="/home/tsn_server/tsntestbed/irq_move_test.log"

# irq:target_cpu
MOVES="476:73 477:65 479:69"

if [ -t 1 ]; then G=$'\033[0;32m'; R=$'\033[0;31m'; Y=$'\033[1;33m'; B=$'\033[1m'; N=$'\033[0m'
else G=; R=; Y=; B=; N=; fi
ok(){ echo "  ${G}ok${N}   $*"; }
warn(){ echo "  ${Y}warn${N} $*"; }
die(){ echo "  ${R}fail${N} $*" >&2; exit 1; }

irq_dev(){ grep "^ *$1:" /proc/interrupts 2>/dev/null | awk '{print $NF}'; }
irq_aff(){ cat "/proc/irq/$1/smp_affinity_list" 2>/dev/null; }
irq_count(){ grep "^ *$1:" /proc/interrupts 2>/dev/null | awk '{s=0;for(j=2;j<=NF-3;j++)s+=$j; print s+0}'; }

rate(){ # $1 = seconds; prints "rf_late underflow" counted from gnb.log by ITS OWN timestamps
    local secs="$1" cutoff
    cutoff=$(date -u -d "-$secs seconds" '+%Y-%m-%dT%H:%M:%S')
    local l u
    l=$(awk -v c="$cutoff" '$0>=c' "$GNB_LOG" 2>/dev/null | grep -c "RF: late")
    u=$(awk -v c="$cutoff" '$0>=c' "$GNB_LOG" 2>/dev/null | grep -c "underflow")
    echo "$l $u"
}

show_status(){
    echo "${B}IRQ affinity - enp109s0f1np1 (X410 fronthaul)${N}"
    printf "  %-6s %-24s %-8s %s\n" IRQ DEVICE CPU "int/s"
    local a b
    for spec in $MOVES 491:109; do
        local i=${spec%%:*}
        a=$(irq_count "$i"); sleep 0.0
        printf "  %-6s %-24s %-8s\n" "$i" "$(irq_dev "$i")" "$(irq_aff "$i")"
    done
    echo
    echo "${B}srsRAN affinities from gnb_x410.yaml${N}"
    grep -E "main_pool_cpus|ru_cpus" /home/tsn_server/tsntestbed/gnb_x410.yaml 2>/dev/null | sed 's/^/  /'
    echo
    [ -f "$STATE" ] && { echo "${B}Test is APPLIED${N}"; sed 's/^/  saved: /' "$STATE"; } \
                    || echo "${B}Test is NOT applied (original affinities)${N}"
    echo
    echo "${B}Last 10 min from gnb.log${N}"
    set -- $(rate 600)
    printf "  RF: late   %5d  (%.2f/s)\n" "$1" "$(echo "$1/600"|bc -l)"
    printf "  underflow  %5d  (%.2f/s)\n" "$2" "$(echo "$2/600"|bc -l)"
}

do_sample(){
    local min="${1:-30}" secs=$((${1:-30}*60))
    echo "Sampling ${min} min from $GNB_LOG (srsRAN's own timestamps, NOT journald)..."
    echo "NOTE: if the gNB restarts mid-sample, gnb.log is TRUNCATED and the sample is void."
    local p0 p1
    p0=$(systemctl show srsran-gnb -p MainPID --value)
    sleep "$secs"
    p1=$(systemctl show srsran-gnb -p MainPID --value)
    [ "$p0" = "$p1" ] || { warn "gNB restarted mid-sample ($p0 -> $p1) - RESULT VOID"; exit 2; }
    set -- $(rate "$secs")
    printf "  RF: late   %5d over %ss = %.3f/s\n" "$1" "$secs" "$(echo "$1/$secs"|bc -l)"
    printf "  underflow  %5d over %ss = %.3f/s\n" "$2" "$secs" "$(echo "$2/$secs"|bc -l)"
    echo "$(date -u '+%FT%TZ') sample ${min}min rf_late=$1 underflow=$2 applied=$([ -f "$STATE" ] && echo yes || echo no)" >> "$LOG"
}

do_apply(){
    [ "$(id -u)" -eq 0 ] || die "must run as root"
    [ -f "$STATE" ] && die "already applied - revert first (state: $STATE)"
    : > "$STATE"
    local failed=0
    for spec in $MOVES; do
        local i=${spec%%:*} t=${spec##*:} cur
        cur=$(irq_aff "$i") || { warn "irq $i not present"; continue; }
        echo "$i $cur" >> "$STATE"
        if echo "$t" > "/proc/irq/$i/smp_affinity_list" 2>/dev/null; then
            ok "irq $i ($(irq_dev "$i")): CPU $cur -> $(irq_aff "$i")"
        else
            warn "irq $i: kernel REFUSED the write (likely a driver-managed IRQ)"
            failed=$((failed+1))
        fi
    done
    if [ "$failed" -gt 0 ]; then
        echo
        warn "$failed IRQ(s) could not be moved. bnxt_en may use managed interrupts,"
        warn "in which case affinity is driver-controlled and this test cannot run"
        warn "without changing queue count (ethtool -L) instead."
    fi
    echo "$(date -u '+%FT%TZ') APPLIED ($failed refused)" >> "$LOG"
    echo
    echo "Now leave it for several hours, then: ./irq_move_test.sh sample 60"
    echo "Compare against irq_test_baseline.txt (~750 RF:late/hour before the change)."
}

do_revert(){
    [ "$(id -u)" -eq 0 ] || die "must run as root"
    [ -f "$STATE" ] || die "no saved state - nothing to revert"
    while read -r i cur; do
        [ -n "${i:-}" ] || continue
        if echo "$cur" > "/proc/irq/$i/smp_affinity_list" 2>/dev/null; then
            ok "irq $i restored to CPU $cur"
        else
            warn "irq $i: could not restore to $cur"
        fi
    done < "$STATE"
    rm -f "$STATE"
    echo "$(date -u '+%FT%TZ') REVERTED" >> "$LOG"
}

case "${1:-status}" in
    status) show_status ;;
    sample) do_sample "${2:-30}" ;;
    apply)  do_apply ;;
    revert) do_revert ;;
    *) sed -n '2,30p' "$0"; exit 2 ;;
esac
