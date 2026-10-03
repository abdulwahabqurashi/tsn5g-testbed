#!/bin/bash
# Post-reboot verification + networking restore for the RT-tuned kernel.
#
#   sudo /opt/tsn5g/core/scripts/post_reboot_check.sh
#
# Runs in two halves:
#   A. VERIFY the five RT parameters are actually live. Aborts if any is missing
#      -- there is no point measuring uplink discards on a half-tuned kernel,
#      and a silent partial apply is exactly what happened on the first reboot.
#   B. CHECK ip_forward and the MASQUERADE rule (tsn5g-core-net.service sets
#      them at boot; on the first rig they were runtime-only and lost on every
#      reboot) and restore them if missing.
#
# Does NOT start the core or the radio -- they start at boot; restart_all.sh
# restarts them in order.
set -uo pipefail

. "$(dirname "$(readlink -f "$0")")/site-env.sh"   # shellcheck disable=SC1091
CPUS=$GNB_ISOLATED_CPUS
WAN=$CORE_LAN_IF           # default-route interface
UESUBNET=$UE_POOL

if [ "$EUID" -ne 0 ]; then
    echo "Must run as root:  sudo $0" >&2
    exit 1
fi

step() { echo; echo "=============== $* ==============="; }
fail=0
ok()   { echo "   OK      $*"; }
bad()  { echo "   FAIL    $*"; fail=$((fail+1)); }

# ================================================================ A. VERIFY
step "A. verifying the five RT parameters are live"

echo "-- /proc/cmdline:"
sed 's/^/     /' /proc/cmdline
echo

# isolcpus
got=$(cat /sys/devices/system/cpu/isolated 2>/dev/null)
[ "$got" = "$CPUS" ] && ok "isolcpus   -> $got" \
                     || bad "isolcpus   -> '${got:-empty}' (expected $CPUS)"

# nohz_full -- this is the one that was silently dropped last time
got=$(cat /sys/devices/system/cpu/nohz_full 2>/dev/null)
if [ "$got" = "$CPUS" ]; then
    ok "nohz_full  -> $got"
elif [ -z "$got" ] || [ "$got" = "(null)" ]; then
    bad "nohz_full  -> (null)  <-- NOT APPLIED, same failure as the first reboot"
else
    bad "nohz_full  -> '$got' (expected $CPUS)"
fi

# rcu_nocbs has no stable sysfs file; read it back off the command line.
grep -qF "rcu_nocbs=$CPUS" /proc/cmdline \
    && ok "rcu_nocbs  -> present on the kernel command line" \
    || bad "rcu_nocbs  -> absent from /proc/cmdline"
# Corroborate: rcu_nocbs makes the kernel spawn rcuo* offload kthreads.
n=$(pgrep -c '^rcuo' 2>/dev/null || echo 0)
[ "$n" -gt 0 ] && echo "           ($n rcuo* offload kthreads running)" \
               || echo "           (no rcuo* kthreads -- offload may not be active)"

# C-states. The kernel params cap them; check what cpu1 actually offers now.
mc=$(cat /sys/module/intel_idle/parameters/max_cstate 2>/dev/null)
[ "$mc" = "1" ] && ok "intel_idle.max_cstate -> 1" \
                || bad "intel_idle.max_cstate -> ${mc:-unreadable} (expected 1)"

echo "   cpu1 idle states now:"
deep=0
for s in /sys/devices/system/cpu/cpu1/cpuidle/state*/; do
    nm=$(cat "$s/name"); lat=$(cat "$s/latency"); dis=$(cat "$s/disable")
    printf "     %-6s latency=%-5s disable=%s\n" "$nm" "$lat" "$dis"
    # C6 was 133 us before -- more than a slot, and the single biggest
    # contributor to a missed deadline on an otherwise idle isolated core.
    if [ "$lat" -gt 50 ] && [ "$dis" = "0" ]; then deep=$((deep+1)); fi
done
[ "$deep" -eq 0 ] && ok "no deep (>50 us) idle state left enabled on cpu1" \
                  || bad "$deep deep idle state(s) still enabled on cpu1"

if [ "$fail" -ne 0 ]; then
    echo
    echo "ABORTED: $fail check(s) failed -- the kernel is not fully tuned." >&2
    echo "         Networking was NOT restored and nothing was started." >&2
    echo "         Re-check: grep -m1 '^[[:space:]]*linux.*isolcpus' /boot/grub/grub.cfg" >&2
    exit 1
fi

# =============================================================== B. RESTORE
step "B. networking (tsn5g-core-net.service; restored here if missing)"

sysctl -w net.ipv4.ip_forward=1

if iptables -t nat -C POSTROUTING -s "$UESUBNET" -o "$WAN" -j MASQUERADE 2>/dev/null; then
    echo "-- MASQUERADE rule already present, not adding a duplicate"
else
    iptables -t nat -A POSTROUTING -s "$UESUBNET" -o "$WAN" -j MASQUERADE
    echo "-- MASQUERADE rule added"
fi

echo
iptables -t nat -L POSTROUTING -n -v

# ================================================================ C. NEXT
step "C. next"
cat <<EOF
Kernel is fully tuned and networking is restored. Now bring the testbed up:

    sudo /opt/tsn5g/core/scripts/restart_all.sh   # only if something is unhealthy

That disarms the auto-repair watchdog, checks the X410, starts the core before
the radio (so NG Setup succeeds), waits 135 s, runs the health check, re-arms.
Then bring the UE up and run the uplink iperf for the before/after comparison.
EOF
