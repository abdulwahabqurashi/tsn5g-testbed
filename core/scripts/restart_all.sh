#!/bin/bash
# Ordered full restart of the TSN testbed: Open5GS core first, then the
# srsRAN gNB / USRP X410 radio, then a verified health check.
#
#   sudo /opt/tsn5g/core/scripts/restart_all.sh
#
# Why this order and not two hand-typed commands:
#   * The 5-min auto-repair watchdog runs `tsn_health.sh --fix`. If it fires
#     while the core is mid-restart it sees missing NFs and launches its own
#     repair, so two restarts fight. We disarm it first and re-arm at the end.
#   * The gNB performs NG Setup to the AMF when it starts, so the core must be
#     up and settled BEFORE the radio restarts -- otherwise the cell comes up
#     with no core attached.
#   * Restarting the radio while the X410 is unreachable is pointless and
#     hides the real fault, so that is checked first.
#   * tsn_health.sh derives the RF underflow rate over a 120 s window, so a
#     check run sooner than that reports a misleading ~0/s. We wait it out.
set -u

. "$(dirname "$(readlink -f "$0")")/site-env.sh"   # shellcheck disable=SC1091
HEALTH="$(dirname "$(readlink -f "$0")")/tsn_health.sh"
X410=$X410_ADDR
SETTLE=135                       # > the 120 s health-check window

if [ "$EUID" -ne 0 ]; then
    echo "Must run as root:  sudo $0" >&2
    exit 1
fi

step() { echo; echo "=============== $* ==============="; }
die()  { echo; echo "ABORTED: $*" >&2; rearm; exit 1; }

WAS_ARMED=no
rearm() {
    if [ "$WAS_ARMED" = yes ]; then
        echo "-- re-arming the auto-repair watchdog"
        systemctl start tsn-health.timer 2>/dev/null \
            && echo "   tsn-health.timer running again" \
            || echo "   WARNING: could not re-arm tsn-health.timer" >&2
    fi
}

# ---------------------------------------------------------------- 0. watchdog
step "0. disarming the auto-repair watchdog"
if systemctl is-active --quiet tsn-health.timer; then
    WAS_ARMED=yes
    systemctl stop tsn-health.timer
    echo "   stopped (will be re-armed at the end)"
else
    echo "   was not running -- nothing to disarm"
fi

# ------------------------------------------------------------------ 1. X410
step "1. checking the USRP X410 is reachable"
if ping -c 2 -W 2 "$X410" >/dev/null 2>&1; then
    echo "   OK  X410 answers at $X410"
else
    die "X410 is NOT reachable at $X410 -- this is a cable/power/hardware
         fault. Restarting software will not fix it and would only mask the
         real problem. Nothing has been restarted."
fi

# ------------------------------------------------------------------ 2. core
step "2. restarting the Open5GS core (12 network functions)"
systemctl restart open5gs.target || die "systemctl restart open5gs.target returned an error."

echo
echo "-- waiting for the core to come up (up to 90 s)"
ready=no
for i in $(seq 1 45); do
    nfs=$(pgrep -c '^open5gs-' 2>/dev/null || echo 0)
    nrf=$(ss -ltn 2>/dev/null | grep -c '127.0.0.10:7777')
    if [ "$nfs" -ge 12 ] && [ "$nrf" -ge 1 ]; then
        echo "   OK  all $nfs NFs up, NRF listening on 127.0.0.10:7777 (after $((i*2)) s)"
        ready=yes
        break
    fi
    sleep 2
done
[ "$ready" = yes ] || die "core did not come up: only $(pgrep -c open5gs) NFs
         running and NRF listening=$(ss -ltn | grep -c '127.0.0.10:7777').
         (systemctl list-units 'open5gs@*' shows which.)
         Check /var/local/log/open5gs/nrf.log and scp.log. The radio has NOT
         been restarted."

# Give the SBI mesh and PFCP a moment to associate before the radio attaches.
echo "-- letting the SBI mesh and PFCP N4 settle (20 s)"
sleep 20

# ------------------------------------------------------------------- 3. radio
step "3. restarting the srsRAN gNB (USRP X410 radio)"
systemctl restart srsran-gnb || die "systemctl restart srsran-gnb failed."
sleep 5
if ! systemctl is-active --quiet srsran-gnb; then
    die "srsran-gnb did not stay active. See: journalctl -u srsran-gnb -n 50"
fi
newpid=$(systemctl show -p MainPID --value srsran-gnb)
echo "   OK  srsran-gnb active, new pid $newpid"

echo
echo "-- letting the radio settle for ${SETTLE}s before judging it"
echo "   (a burst of 'RF: late' in the first ~40 s is normal and self-clears;"
echo "    the health check needs a full 120 s window to rate RF underflow)"
for r in $(seq $SETTLE -15 1); do printf "\r   %3ds remaining " "$r"; sleep 15; done
printf "\r   settled.        \n"

# ------------------------------------------------------------------ 4. verify
step "4. verifying the whole testbed"
"$HEALTH"
rc=$?

# ------------------------------------------------------------------ 5. finish
step "5. finishing up"
rearm

echo
if [ $rc -eq 0 ]; then
    echo "RESULT: all checks passed -- core and radio are up and transmitting."
else
    echo "RESULT: the health check still reports problems (exit $rc)."
    echo "        Re-read its output above. If the radio is still unhealthy"
    echo "        after this clean restart, do not just restart again --"
    echo "        that is the point to involve an engineer."
fi
exit $rc
