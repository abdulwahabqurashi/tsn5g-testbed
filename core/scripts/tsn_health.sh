#!/bin/bash
#
# tsn_health.sh - health check + auto-remediation for the 5G SA testbed
#                 Open5GS core (12 NFs) + srsRAN gNB + USRP X410
#
# Written after the 2026-09-08 double outage, in which BOTH halves were dead for
# days while every surface indicator said "running":
#   * open5gs-nrfd had aborted on subscription-pool exhaustion (Aug 31), so every
#     other NF sat in an NRF retry loop and UE registration was rejected - but
#     run5gs.sh status still printed all NFs "running".
#   * the srsRAN gNB's UHD stream had wedged (Sep 5): the process stayed alive, so
#     systemd's Restart=always never fired, while RSS ballooned to 41 GB and the
#     radio transmitted nothing.
# Both are detected here by their real signatures, not by process liveness.
#
# Usage:
#   ./tsn_health.sh                    # check only; read-only, no root needed
#   sudo ./tsn_health.sh --fix         # check, then repair what it safely can
#   sudo ./tsn_health.sh --fix --dry-run
#
# Pause the auto-repair during an experiment (checks still run and log):
#   sudo touch /etc/tsn5g/health.pause     # optional reason inside the file
#   sudo rm /etc/tsn5g/health.pause
#
# Exit: 0 = healthy   1 = issues found (or found-and-fixed)   2 = unresolved

# ---------------------------------------------------------------- configuration
# shellcheck disable=SC1091
. "$(dirname "$(readlink -f "$0")")/site-env.sh"
CORE_NET="$(dirname "$(readlink -f "$0")")/core-net.sh"
CORE_TARGET=open5gs.target
NF_LOGDIR="${TSN_NF_LOGDIR:-/var/local/log/open5gs}"
GNB_LOG="${TSN_GNB_LOG:-/var/log/tsn5g/gnb.log}"
GNB_ARCHIVE="$(dirname "$GNB_LOG")/gnb-archive"
GNB_UNIT="${TSN_GNB_UNIT:-srsran-gnb.service}"
PAUSE_FILE="${ETC_DIR:-/etc/tsn5g}/health.pause"

NFS="nrf scp ausf udm udr pcf nssf bsf amf smf upf tsn-af"
NRF_ENDPOINT="127.0.0.10:7777"
AMF_NGAP_PORT=38412

X410_ADDR="${TSN_X410_ADDR:-${X410_ADDR:?site.env not found}}"
DATA_NIC="${TSN_DATA_NIC:-$X410_HOST_IF}"
DATA_IP=$X410_HOST_IP
DATA_MTU=$X410_MTU

# Thresholds. Healthy baselines observed 2026-09-08: gNB RSS ~2.7 GB, 0 UHD
# timeouts, 0 PRACH depletions, ~1 underflow/sec (benign, NOT an error here).
GNB_RSS_MAX_KB=$((6 * 1024 * 1024))   # wedged run hit 41 GB
UHD_TIMEOUT_MAX=20                    # healthy = 0 on the current PID
LATE_WARN=100                         # 'RF: late' storm = wedge precursor
GNB_LOG_MAX_MB=512                    # srsRAN truncates it at each gNB start,
                                      # but a wedge grew it to 1.1 GB in 3 days
DISK_MIN_PCT=10
UHD_STATE="${TSN_UHD_STATE:-/run/tsn-health-uhd.state}"
GNB_WINDOW=120                        # seconds of gnb.log to inspect
NF_TAIL_LINES=2000                    # tail depth for SBI storm detection
NF_DENSITY_MAX=200                    # error lines within that tail = storm
NF_FRESH_SECS=300                     # ignore a log nothing has written lately

# Anti-flap: never repair the same component twice inside COOLDOWN, and give up
# (escalate to the operator) after MAX_FIX_PER_HOUR attempts.
COOLDOWN=600
MAX_FIX_PER_HOUR=3

STATE_DIR=/var/lib/tsn-health
[ -w /var/lib ] 2>/dev/null || STATE_DIR="$HOME/.tsn-health"
HEALTH_LOG=/var/log/tsn-health.log
[ -w /var/log ] 2>/dev/null || HEALTH_LOG="$HOME/tsn-health.log"

# ---------------------------------------------------------------------- options
DO_FIX=0; DRY_RUN=0; QUIET=0
while [ $# -gt 0 ]; do
    case "$1" in
        --fix)            DO_FIX=1 ;;
        --dry-run)        DRY_RUN=1 ;;
        --quiet|-q)       QUIET=1 ;;
        --check|--status) DO_FIX=0 ;;
        -h|--help)        sed -n '2,32p' "$0"; exit 0 ;;
        *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done

if [ -t 1 ] && [ "$QUIET" = 0 ]; then
    RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'
    BLU=$'\033[0;34m'; BLD=$'\033[1m';    NC=$'\033[0m'
else
    RED=; GRN=; YEL=; BLU=; BLD=; NC=
fi

ISSUES=(); FIXED=(); UNRESOLVED=()
say()  { [ "$QUIET" = 1 ] || echo -e "$*"; }
pass() { say "  ${GRN}PASS${NC}  $1"; }
warn() { say "  ${YEL}WARN${NC}  $1"; ISSUES+=("WARN: $1"); }
fail() { say "  ${RED}FAIL${NC}  $1"; ISSUES+=("FAIL: $1"); }
info() { say "  ${BLU}info${NC}  $1"; }
head_() { say "\n${BLD}$1${NC}"; }
audit() { printf '%s %s\n' "$(date '+%F %T')" "$1" >> "$HEALTH_LOG" 2>/dev/null; }

# ------------------------------------------------------------- state / cooldown
mkdir -p "$STATE_DIR" 2>/dev/null
# Returns 0 if we are allowed to repair $1 right now.
may_fix() {
    local comp="$1" f="$STATE_DIR/$1.last" c="$STATE_DIR/$1.count" now last cnt
    now=$(date +%s)
    last=$(cat "$f" 2>/dev/null || echo 0)
    cnt=$(cat "$c" 2>/dev/null || echo 0)
    if [ $((now - last)) -lt "$COOLDOWN" ]; then
        warn "$comp: repaired $((now - last))s ago, inside ${COOLDOWN}s cooldown - not retrying"
        return 1
    fi
    if [ $((now - last)) -gt 3600 ]; then cnt=0; fi
    if [ "$cnt" -ge "$MAX_FIX_PER_HOUR" ]; then
        UNRESOLVED+=("$comp: $cnt repairs in the last hour - FLAPPING, needs a human")
        fail "$comp: $cnt repairs within the hour - refusing to loop, escalating"
        return 1
    fi
    return 0
}
mark_fix() {
    # A dry-run must not consume the cooldown budget for a repair it never made.
    [ "$DRY_RUN" = 1 ] && return 0
    date +%s > "$STATE_DIR/$1.last" 2>/dev/null
    echo $(( $(cat "$STATE_DIR/$1.count" 2>/dev/null || echo 0) + 1 )) > "$STATE_DIR/$1.count" 2>/dev/null
}
claim_fixed() { [ "$DRY_RUN" = 1 ] || FIXED+=("$1"); }
run() {
    if [ "$DRY_RUN" = 1 ]; then say "  ${YEL}dry-run${NC} would run: $*"; return 0; fi
    say "  ${YEL}-->${NC} $*"; audit "RUN: $*"
    "$@" >>"$HEALTH_LOG" 2>&1
}

# --------------------------------------------------------------------- helpers
# Lines of a timestamped log written within the last N seconds.
recent_gnb_lines() {
    local cutoff; cutoff=$(date -d "-$GNB_WINDOW seconds" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null) || return 1
    tail -n 40000 "$GNB_LOG" 2>/dev/null | awk -v c="$cutoff" '$0 >= c'
}
# An SBI error storm is a *rate* phenomenon: during the Aug-31 outage scp.log
# took thousands of connect-refused lines per minute. Measuring density over the
# tail, gated on the file being freshly written, avoids parsing open5gs'
# year-less "MM/DD" stamps - those sort wrong across a Dec->Jan boundary.
NF_ERR_RE="Retry registration with NRF|Couldn't connect to server|Status Code \\[500\\]"
nf_error_density() {   # $1 = nf name -> error count in tail, 0 if log is stale
    local f="$NF_LOGDIR/$1.log" age
    [ -f "$f" ] || { echo 0; return; }
    age=$(( $(date +%s) - $(stat -c%Y "$f" 2>/dev/null || echo 0) ))
    [ "$age" -gt "$NF_FRESH_SECS" ] && { echo 0; return; }
    tail -n "$NF_TAIL_LINES" "$f" 2>/dev/null | grep -cE "$NF_ERR_RE"
}
worst_nf_density() {   # -> "<count> <nf>" for the noisiest control-plane log
    local n best=0 worst=none
    for nf in scp amf smf; do
        n=$(nf_error_density "$nf")
        [ "$n" -gt "$best" ] && { best=$n; worst=$nf; }
    done
    echo "$best $worst"
}
gnb_mainpid() { systemctl show "$GNB_UNIT" -p MainPID --value 2>/dev/null; }

# ============================================================== CHECKS: the core
CORE_BAD=0; CORE_NF_MISSING=""
check_core() {
    head_ "Open5GS core"

    if systemctl is-active --quiet mongod; then pass "mongod running"
    else fail "mongod NOT running"; CORE_BAD=1; MONGO_BAD=1; fi

    if ip link show ogstun >/dev/null 2>&1; then pass "ogstun present"
    else fail "ogstun missing (no user-plane tunnel)"; CORE_BAD=1; fi

    local dead=""
    for nf in $NFS; do
        pgrep -x "open5gs-${nf}d" >/dev/null 2>&1 || dead="$dead $nf"
    done
    if [ -z "$dead" ]; then
        pass "all 12 NFs running"
    else
        fail "NF(s) NOT running:$dead"
        CORE_NF_MISSING="$dead"; CORE_BAD=1
        for nf in $dead; do
            local last; last=$(grep -aE "FATAL|Assertion" "$NF_LOGDIR/$nf.log" 2>/dev/null | tail -1)
            [ -n "$last" ] && info "$nf died with: ${last:0:150}"
        done
    fi

    # The NRF is the single point of failure: without it no NF can be discovered
    # and the AMF rejects every registration, even though NGAP stays ESTAB.
    if ss -ltn 2>/dev/null | grep -q "$NRF_ENDPOINT"; then
        pass "NRF listening on $NRF_ENDPOINT"
    else
        fail "NRF NOT listening on $NRF_ENDPOINT - UE registration will be rejected"
        CORE_BAD=1
    fi

    # SBI error storm: the loudest symptom of a dead/unreachable NRF.
    local flood worst
    read -r flood worst <<< "$(worst_nf_density)"
    if [ "$flood" -le "$NF_DENSITY_MAX" ]; then
        pass "SBI healthy (peak $flood errors per ${NF_TAIL_LINES}-line tail)"
    else
        fail "SBI error storm: $flood of the last $NF_TAIL_LINES $worst.log lines are NRF errors"
        CORE_BAD=1
    fi

    # PFCP N4: without it the SMF cannot create PDU sessions.
    if grep -a "PFCP associated" "$NF_LOGDIR/smf.log" >/dev/null 2>&1; then
        pass "PFCP N4 associated (SMF <-> UPF)"
    else
        warn "no 'PFCP associated' in smf.log - PDU sessions will fail"
        CORE_BAD=1
    fi
}

# ============================================================= CHECKS: the radio
GNB_BAD=0; X410_DOWN=0; NIC_BAD=0
check_radio() {
    head_ "USRP X410 / data plane"

    if ping -c2 -W2 "$X410_ADDR" >/dev/null 2>&1; then
        pass "X410 reachable at $X410_ADDR"
    else
        fail "X410 UNREACHABLE at $X410_ADDR - hardware/link problem, NOT auto-fixable"
        X410_DOWN=1
        UNRESOLVED+=("X410 unreachable at $X410_ADDR: check the DAC in $DATA_NIC, X410 power, and 'ethtool $DATA_NIC'")
    fi

    local st mtu
    st=$(cat "/sys/class/net/$DATA_NIC/operstate" 2>/dev/null)
    mtu=$(cat "/sys/class/net/$DATA_NIC/mtu" 2>/dev/null)
    if [ "$st" != "up" ]; then
        fail "$DATA_NIC is '$st' (expected up)"; NIC_BAD=1
    elif [ "$mtu" != "$DATA_MTU" ]; then
        # UHD uses 8000-byte frames; MTU 1500 causes RPC timeouts and a segfault.
        fail "$DATA_NIC MTU is $mtu (expected $DATA_MTU - UHD needs jumbo frames)"; NIC_BAD=1
    elif ! ip -br addr show "$DATA_NIC" 2>/dev/null | grep -q "${DATA_IP%%/*}"; then
        fail "$DATA_NIC missing ${DATA_IP}"; NIC_BAD=1
    else
        pass "$DATA_NIC up, MTU $mtu, ${DATA_IP}"
    fi

    head_ "srsRAN gNB"

    if ! systemctl is-active --quiet "$GNB_UNIT"; then
        fail "$GNB_UNIT not active"; GNB_BAD=1; return
    fi
    pass "$GNB_UNIT active"

    local pid rss
    pid=$(gnb_mainpid)
    rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -z "$rss" ]; then
        fail "gNB MainPID $pid has no process"; GNB_BAD=1; return
    fi
    # A wedged UHD stream leaks memory without ever crashing - this is THE tell.
    if [ "$rss" -gt "$GNB_RSS_MAX_KB" ]; then
        fail "gNB RSS $((rss/1024/1024)) GB exceeds $((GNB_RSS_MAX_KB/1024/1024)) GB - wedged UHD stream"
        GNB_BAD=1
    else
        pass "gNB RSS $((rss/1024)) MB (pid $pid)"
    fi

    local touts total last_pid last_n
    total=$(journalctl -u "$GNB_UNIT" --since "-24h" --no-pager 2>/dev/null \
            | grep -c "\[$pid\].*timed out transmissions")
    last_pid=""; last_n=0
    [ -r "$UHD_STATE" ] && read -r last_pid last_n < "$UHD_STATE" 2>/dev/null
    if [ "$last_pid" = "$pid" ]; then
        touts=$(( total - last_n )); [ "$touts" -lt 0 ] && touts=$total
    else
        touts=$total
    fi
    printf '%s %s\n' "$pid" "$total" > "$UHD_STATE" 2>/dev/null
    if [ "$touts" -le "$UHD_TIMEOUT_MAX" ]; then
        pass "UHD transmit path OK ($touts new timeouts on pid $pid since last check)"
    else
        fail "UHD send path lost the X410: $touts new timeouts on pid $pid since last check"
        GNB_BAD=1
    fi

    local recent prach late under
    recent=$(recent_gnb_lines)
    prach=$(printf '%s' "$recent" | grep -c "PRACH buffer pool depleted")
    late=$(printf  '%s' "$recent" | grep -c "Real-time failure in RF: late")
    under=$(printf '%s' "$recent" | grep -c "Real-time failure in RF: underflow")
    if [ "$prach" -eq 0 ]; then
        pass "no PRACH pool depletion in ${GNB_WINDOW}s"
    else
        fail "$prach PRACH pool depletions in ${GNB_WINDOW}s - gNB is not serving PRACH"
        GNB_BAD=1
    fi
    if [ "$late" -gt "$LATE_WARN" ]; then
        warn "$late 'RF: late' in ${GNB_WINDOW}s - real-time deadline misses, a wedge may follow"
    fi
    # ~1/sec is the documented benign baseline on this host, not a fault.
    # Print one decimal: the real rate sits at ~1.1/s, so integer division put
    # the count right on the GNB_WINDOW boundary and the display flapped between
    # "0/s" and "1/s" on an unchanged, healthy radio. "0/s" is also the wedge
    # signature, so that flapping was actively misleading.
    info "RF underflow ~$(awk -v u="$under" -v w="$GNB_WINDOW" \
        'BEGIN{printf "%.1f", (w>0 ? u/w : 0)}')/s (~1/s is the known-good baseline)"

    if ss --sctp -an 2>/dev/null | grep -q "ESTAB.*:$AMF_NGAP_PORT"; then
        pass "NGAP SCTP ESTAB to AMF"
    else
        fail "NGAP SCTP not established - gNB is not attached to the AMF"
        GNB_BAD=1
    fi
}

# ======================================================== CHECKS: housekeeping
LOG_BIG=0
check_housekeeping() {
    head_ "Housekeeping"
    local mb pct
    mb=$(du -m "$GNB_LOG" 2>/dev/null | cut -f1); mb=${mb:-0}
    #mb=$(( $(stat -c%s "$GNB_LOG" 2>/dev/null || echo 0) / 1024 / 1024 ))
    if [ "$mb" -lt "$GNB_LOG_MAX_MB" ]; then
        pass "gnb.log ${mb} MB"
    else
        warn "gnb.log ${mb} MB exceeds ${GNB_LOG_MAX_MB} MB - no logrotate configured"
        LOG_BIG=1
    fi
    pct=$(df --output=pcent / | tail -1 | tr -dc '0-9')
    if [ $((100 - pct)) -ge "$DISK_MIN_PCT" ]; then
        pass "root fs $((100 - pct))% free"
    else
        fail "root fs only $((100 - pct))% free"
        UNRESOLVED+=("root filesystem nearly full - free space manually")
    fi
}

# ==================================================================== REPAIRS
fix_core() {
    [ "$CORE_BAD" = 1 ] || return 0
    head_ "Repairing core"
    may_fix core || return 1

    [ "${MONGO_BAD:-0}" = 1 ] && run systemctl start mongod
    ip link show ogstun >/dev/null 2>&1 || run "$CORE_NET" up

    # Least-disruptive first: starting the target starts only the NF units that
    # are not running, so a lone dead NRF is revived without bouncing the whole
    # core (and without dropping a live UE).
    say "  ${BLU}step 1${NC}: gap-fill missing NFs (systemctl start $CORE_TARGET)"
    run systemctl start "$CORE_TARGET"
    [ "$DRY_RUN" = 1 ] || sleep 8

    local still=""
    for nf in $NFS; do pgrep -x "open5gs-${nf}d" >/dev/null 2>&1 || still="$still $nf"; done
    local flood worst
    read -r flood worst <<< "$(worst_nf_density)"

    # Escalate only if the gap-fill did not settle it: surviving NFs can hold
    # stale registration state that only a full restart clears.
    if [ -n "$still" ] || [ "$flood" -gt "$NF_DENSITY_MAX" ]; then
        say "  ${BLU}step 2${NC}: still degraded (missing:${still:-none} errors:$flood) - full restart"
        run systemctl restart "$CORE_TARGET"
        [ "$DRY_RUN" = 1 ] || sleep 12
    fi

    mark_fix core
    if ss -ltn 2>/dev/null | grep -q "$NRF_ENDPOINT"; then
        claim_fixed "core: NRF back up, NFs re-registered"
        # A core restart bounces the AMF; srsRAN normally re-establishes NGAP by
        # itself, so only touch the gNB if it has not come back.
        [ "$DRY_RUN" = 1 ] || sleep 5
        if ! ss --sctp -an 2>/dev/null | grep -q "ESTAB.*:$AMF_NGAP_PORT"; then
            say "  NGAP did not return on its own - restarting gNB"
            GNB_BAD=1
        fi
    else
        UNRESOLVED+=("core: NRF still not listening after restart - check $NF_LOGDIR/nrf.log")
    fi
}

fix_nic() {
    [ "$NIC_BAD" = 1 ] || return 0
    head_ "Repairing $DATA_NIC"
    run ip link set "$DATA_NIC" up
    run ip link set "$DATA_NIC" mtu "$DATA_MTU"
    ip -br addr show "$DATA_NIC" 2>/dev/null | grep -q "${DATA_IP%%/*}" \
        || run ip addr add "$DATA_IP" dev "$DATA_NIC"
    run sysctl -w net.core.wmem_max=25000000
    run sysctl -w net.core.rmem_max=50000000
    if [ "$(cat "/sys/class/net/$DATA_NIC/mtu" 2>/dev/null)" = "$DATA_MTU" ] \
       && ip -br addr show "$DATA_NIC" 2>/dev/null | grep -q "${DATA_IP%%/*}"; then
        claim_fixed "$DATA_NIC: link/MTU/IP re-applied"
    else
        UNRESOLVED+=("$DATA_NIC: still misconfigured after repair - check 'ip addr show $DATA_NIC'")
    fi
}

fix_gnb() {
    [ "$GNB_BAD" = 1 ] || return 0
    head_ "Repairing gNB"
    # Pointless and confusing to cycle the gNB when the radio is unreachable.
    if [ "$X410_DOWN" = 1 ]; then
        fail "skipping gNB restart: X410 is unreachable, fix the link first"
        UNRESOLVED+=("gNB left down because the X410 is unreachable")
        return 1
    fi
    may_fix gnb || return 1
    run systemctl restart "$GNB_UNIT"
    [ "$DRY_RUN" = 1 ] || sleep 25   # radio init + NGAP setup
    mark_fix gnb

    local pid; pid=$(gnb_mainpid)
    local recent prach under age
    recent=$(recent_gnb_lines)
    prach=$(printf '%s' "$recent" | grep -c "PRACH buffer pool depleted")
    under=$(printf '%s' "$recent" | grep -c "Real-time failure in RF: underflow")
    age=$(( $(date +%s) - $(stat -c%Y "$GNB_LOG" 2>/dev/null || echo 0) ))
    if ! systemctl is-active --quiet "$GNB_UNIT" || [ -z "$pid" ] || [ "$pid" = "0" ]; then
        UNRESOLVED+=("gNB: service not active after restart - check 'systemctl status $GNB_UNIT'")
    elif [ "$age" -gt 60 ]; then
        UNRESOLVED+=("gNB: restarted on pid $pid but gnb.log is ${age}s stale - radio may not be streaming")
    elif [ "$prach" -gt 0 ]; then
        UNRESOLVED+=("gNB: restarted on pid $pid but STILL depleting PRACH ($prach in ${GNB_WINDOW}s) - restart did not recover the radio")
    elif [ "$under" -eq 0 ]; then
        UNRESOLVED+=("gNB: restarted on pid $pid but zero underflows in ${GNB_WINDOW}s - radio is not streaming (expected ~1/s)")
    else
        claim_fixed "gNB: restarted clean on pid $pid (streaming, no PRACH depletion)"
    fi
}

fix_log() {
    [ "$LOG_BIG" = 1 ] || return 0
    head_ "Rotating gnb.log"
    # copytruncate-style: the gNB holds the fd open, so truncate in place rather
    # than renaming (a rename would leave it writing to the old inode). The old
    # content is archived compressed first: a big log is usually the evidence
    # of the problem, and the first rig lost two such logs to plain truncation.
    local arc
    arc="$GNB_ARCHIVE/gnb-rotated-$(date -u +%Y%m%dT%H%M%SZ).log.gz"
    if [ "$DRY_RUN" = 1 ]; then
        say "  ${YEL}dry-run${NC} would archive gnb.log to $arc and truncate"
    else
        mkdir -p "$GNB_ARCHIVE"
        gzip -c "$GNB_LOG" > "$arc" 2>/dev/null && : > "$GNB_LOG"
        ls -1t "$GNB_ARCHIVE"/gnb-rotated-*.log.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
        claim_fixed "gnb.log archived to $arc and truncated (last 5 archives kept)"
    fi
}

# ========================================================================= main
exec 9>"$STATE_DIR/lock" 2>/dev/null
flock -n 9 2>/dev/null || { echo "another tsn_health.sh is running"; exit 2; }

say "${BLD}TSN testbed health check${NC} - $(date '+%F %T')"
[ "$DO_FIX" = 1 ] && say "mode: ${YEL}repair${NC}$([ "$DRY_RUN" = 1 ] && echo ' (dry-run)')" \
                  || say "mode: read-only (use --fix to repair)"

check_core
check_radio
check_housekeeping

if [ "$DO_FIX" = 1 ] && [ -e "$PAUSE_FILE" ]; then
    say "\n${YEL}auto-repair paused${NC} by $PAUSE_FILE ($(head -c 200 "$PAUSE_FILE" 2>/dev/null)) - checks only"
    audit "PAUSED: ${ISSUES[*]:-healthy}"
    DO_FIX=0
fi

if [ "$DO_FIX" = 1 ] && [ "${#ISSUES[@]}" -gt 0 ]; then
    if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" = 0 ]; then
        say "\n${RED}--fix needs root${NC}: re-run with sudo (or add --dry-run to preview)"
        exit 2
    fi
    audit "ISSUES: ${ISSUES[*]}"
    fix_log
    fix_core
    fix_nic
    fix_gnb

    head_ "Re-checking"
    ISSUES=(); CORE_BAD=0; GNB_BAD=0; NIC_BAD=0; X410_DOWN=0; LOG_BIG=0
    check_core
    check_radio
    check_housekeeping
fi

head_ "Summary"
if [ "${#FIXED[@]}" -gt 0 ]; then
    for f in "${FIXED[@]}"; do say "  ${GRN}repaired${NC} $f"; done
fi
if [ "${#UNRESOLVED[@]}" -gt 0 ]; then
    # the same fault is seen by both the initial pass and the re-check pass
    while IFS= read -r u; do say "  ${RED}needs a human${NC} $u"; done \
        < <(printf '%s\n' "${UNRESOLVED[@]}" | awk '!seen[$0]++')
fi
if [ "${#ISSUES[@]}" -eq 0 ]; then
    say "  ${GRN}All checks passed - core and radio are transmitting.${NC}"
    audit "OK"
    exit 0
fi
say "  ${YEL}${#ISSUES[@]} issue(s) outstanding${NC}"
for i in "${ISSUES[@]}"; do say "    - $i"; done
audit "REMAINING: ${ISSUES[*]}"
[ "${#UNRESOLVED[@]}" -gt 0 ] && exit 2
exit 1
