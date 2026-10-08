#!/bin/bash
# Wired PTP setup for amrctsnserver (Option A).
#
#   sudo ./setup-ptp.sh                                   auto-detect everything
#   sudo ./setup-ptp.sh --iface enp37s0f1np1 --vlan 4011  pin the port
#   sudo ./setup-ptp.sh --iface X --profile 1588 --transport L2 --domain 0
#   sudo ./setup-ptp.sh --detect-only                     probe, change nothing
#
# Idempotent. Re-running is how you reconfigure.
#
# Why it probes: profile and transport must match the grandmaster EXACTLY and a
# mismatch fails silently - ptp4l sits in s0 forever with nothing useful in the
# log. Rather than ask a human to know whether the GM speaks 1588-over-L2,
# 1588-over-UDPv4 or 802.1AS, this listens to the wire and reads it off the
# first PTP frame that arrives.

set -euo pipefail

WEBUI_USER=tsn_server
PROBE_SECS=12

IFACE=""; VLAN=""; PROFILE=""; TRANSPORT=""; DOMAIN=""; DETECT_ONLY=0
ANN_INT=""; ANN_TIMEOUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --iface)      IFACE="$2"; shift 2 ;;
    --vlan)       VLAN="$2"; shift 2 ;;
    --profile)    PROFILE="$2"; shift 2 ;;     # 1588 | 802.1AS
    --transport)  TRANSPORT="$2"; shift 2 ;;   # L2 | UDPv4
    --domain)     DOMAIN="$2"; shift 2 ;;
    --announce-interval) ANN_INT="$2"; shift 2 ;;   # log2 seconds: 0=1s, 1=2s, 3=8s
    --announce-timeout)  ANN_TIMEOUT="$2"; shift 2 ;;  # in announce intervals
    --detect-only) DETECT_ONLY=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run with sudo: $0 $*" >&2; exit 1; }

say() { printf '%s\n' "$*"; }

# `set -o pipefail` plus `grep -q` is a trap: grep exits on the first match,
# the producer gets SIGPIPE and exits non-zero, and the pipeline reports
# FAILURE precisely when it succeeded. It bites only once the log is long
# enough for grep to finish first, so it looks intermittent. grep -c consumes
# all input and never triggers it.
jgrep() {   # jgrep <pattern> <journalctl-args...>  -> 0 if present
  local pat="$1"; shift
  local n
  n=$(journalctl "$@" --no-pager -o cat 2>/dev/null | grep -c -- "$pat" || true)
  [ "${n:-0}" -gt 0 ]
}
hr()  { printf -- '--------------------------------------------------\n'; }

# ---------------------------------------------------------------- 1. the port
hr; say "1. network port"

phc_of() { ethtool -T "$1" 2>/dev/null | awk '/PTP Hardware Clock:/{print $NF}'; }
carrier_of() { cat "/sys/class/net/$1/carrier" 2>/dev/null || echo 0; }

if [ -z "$IFACE" ]; then
  for i in $(ls /sys/class/net | grep -v '^lo$'); do
    idx=$(phc_of "$i"); [ -z "${idx:-}" ] && continue; [ "$idx" = "none" ] && continue
    say "   candidate $i: PHC $idx, carrier $(carrier_of "$i")"
    if [ "$(carrier_of "$i")" = "1" ] && [ -z "$IFACE" ]; then IFACE="$i"; fi
  done
  [ -n "$IFACE" ] || { say "FAIL: no port has both a PTP hardware clock and a link."; \
    say "      Only the Intel 'ice' ports have a PHC here; the Broadcom bnxt_en"; \
    say "      ports report none and need a niccli NVM change first."; exit 1; }
fi

PHC=$(phc_of "$IFACE")
[ -n "$PHC" ] && [ "$PHC" != "none" ] || {
  say "FAIL: $IFACE has no PTP hardware clock (reports '${PHC:-nothing}')."
  say "      Software timestamping is tens of microseconds of jitter - not usable for TSN."
  exit 1; }
[ "$(carrier_of "$IFACE")" = "1" ] || { say "FAIL: $IFACE has no carrier. Plug it into the TSN switch."; exit 1; }
say "   using $IFACE  (/dev/ptp$PHC)"

# -------------------------------------------------------------- 2. the VLAN
hr; say "2. VLAN"
PTP_IF="$IFACE"
if [ -n "$VLAN" ]; then
  PTP_IF="${IFACE}.${VLAN}"
  # Linux caps interface names at 15 characters (IFNAMSIZ-1). The obvious
  # "<parent>.<vlan>" overflows for these long predictable NIC names
  # (enp37s0f0np0.4011 is 20), so fall back to a short deterministic name.
  if [ ${#PTP_IF} -gt 15 ]; then
    PTP_IF="ptp${VLAN}"
    say "   '${IFACE}.${VLAN}' exceeds the 15-char limit; using $PTP_IF instead"
  fi
  WE_MADE_VLAN=0
  if ! ip link show "$PTP_IF" >/dev/null 2>&1; then
    ip link add link "$IFACE" name "$PTP_IF" type vlan id "$VLAN"
    WE_MADE_VLAN=1
    say "   created $PTP_IF"
  else
    say "   $PTP_IF already exists"
  fi
  # --detect-only promises to change nothing, so undo our own VLAN on exit.
  # A VLAN that was already there is left alone.
  if [ "$DETECT_ONLY" = "1" ] && [ "$WE_MADE_VLAN" = "1" ]; then
    trap 'ip link del "$PTP_IF" 2>/dev/null || true; echo "   removed temporary $PTP_IF"' EXIT
  fi
  ip link set "$PTP_IF" up
else
  say "   untagged (no --vlan given)"
fi
say "   PTP will bind to: $PTP_IF"

# ------------------------------------------------------------- 3. the probe
hr; say "3. listening for a grandmaster on $PTP_IF (${PROBE_SECS}s)"

command -v tcpdump >/dev/null || { apt-get update -qq && apt-get install -y -qq tcpdump; }

CAP=$(mktemp)
timeout "$PROBE_SECS" tcpdump -i "$PTP_IF" -c 20 -nn -e -x \
   '(ether proto 0x88f7) or (udp port 319 or udp port 320)' \
   > "$CAP" 2>/dev/null || true

DET_TRANSPORT=""; DET_PROFILE=""; DET_DOMAIN=""
if grep -q '88f7' "$CAP" 2>/dev/null; then
  DET_TRANSPORT="L2"
elif grep -qE '\.319|\.320' "$CAP" 2>/dev/null; then
  DET_TRANSPORT="UDPv4"
fi

# The first PTP header byte is transportSpecific(4b)|messageType(4b); the second
# is reserved(4b)|versionPTP(4b); the fifth is domainNumber.
# 802.1AS sets transportSpecific = 1, plain IEEE 1588 leaves it 0.
# Profile is decided by the DESTINATION MAC, not by parsing header offsets.
# The two L2 profiles use different, reserved multicast addresses:
#   01:80:C2:00:00:0E  IEEE 802.1AS (gPTP)
#   01:1B:19:00:00:00  IEEE 1588 Annex F (1588 over L2)
# That is unambiguous and survives VLAN tags, which shift every byte offset.
if [ "$DET_TRANSPORT" = "L2" ]; then
  if   grep -qi '01:80:c2:00:00:0e' "$CAP"; then DET_PROFILE="802.1AS"
  elif grep -qi '01:1b:19:00:00:00' "$CAP"; then DET_PROFILE="1588"
  fi
  DET_DST=$(grep -oiE '01:80:c2:00:00:0e|01:1b:19:00:00:00' "$CAP" | head -1 || true)
  [ -n "${DET_DST:-}" ] && say "   PTP destination MAC: $DET_DST"
elif [ "$DET_TRANSPORT" = "UDPv4" ]; then
  # 1588 over UDP is Annex D; 802.1AS is never carried over UDP.
  DET_PROFILE="1588"
fi

if [ -n "$DET_TRANSPORT" ]; then
  say "   frames seen: $(grep -c '88f7\|\.319\|\.320' "$CAP" 2>/dev/null || echo 0)"
  say "   DETECTED: transport=$DET_TRANSPORT profile=${DET_PROFILE:-unknown}"
else
  say "   nothing heard. Either the cable is not on the PTP network,"
  say "   the VLAN is wrong, or the grandmaster is silent."
fi
rm -f "$CAP"

# explicit flags always win over detection
ANN_INT="${ANN_INT:-1}"
ANN_TIMEOUT="${ANN_TIMEOUT:-10}"
PROFILE="${PROFILE:-${DET_PROFILE:-1588}}"
TRANSPORT="${TRANSPORT:-${DET_TRANSPORT:-UDPv4}}"
DOMAIN="${DOMAIN:-0}"
say "   using: profile=$PROFILE transport=$TRANSPORT domain=$DOMAIN"
   say "   announce: interval 2^${ANN_INT}s, timeout ${ANN_TIMEOUT} intervals"

if [ "$DETECT_ONLY" = "1" ]; then hr; say "--detect-only: stopping here, nothing changed."; exit 0; fi

# ---------------------------------------------------------- 4. install + config
hr; say "4. linuxptp"
if ! command -v ptp4l >/dev/null; then
  # A half-finished dpkg transaction from some unrelated package blocks every
  # install, and apt's own message is easy to miss in the scroll. Check first
  # and say exactly what to run.
  if ! dpkg --audit >/dev/null 2>&1 || [ -n "$(dpkg -l 2>/dev/null | awk '$1 !~ /^ii|^rc/ && NR>5 {print $2}')" ]; then
    BROKEN=$(dpkg -l 2>/dev/null | awk '$1 !~ /^ii|^rc/ && NR>5 {printf "%s (%s) ", $2, $1}')
    if [ -n "$BROKEN" ]; then
      hr
      say "CANNOT INSTALL: dpkg has an unfinished transaction."
      say "  packages in a bad state: $BROKEN"
      say ""
      say "  Fix it, then re-run this script (it is idempotent):"
      say "      sudo dpkg --configure -a"
      say "      # if a package shows 'R' (reinstall-required):"
      say "      sudo apt-get install --reinstall <that package>"
      exit 1
    fi
  fi
  apt-get update && apt-get install -y linuxptp
else
  say "   already installed: $(ptp4l -v 2>&1 | head -1)"
fi

hr; say "5. config"
if [ "$PROFILE" = "802.1AS" ]; then
  TS_SPEC="0x1"; DELAY="P2P"; NET="L2"
else
  TS_SPEC="0x0"; DELAY="E2E"; NET="$TRANSPORT"
fi

mkdir -p /etc/linuxptp
CONF_PREV=$(mktemp)
[ -f /etc/linuxptp/ptp4l-tsn.conf ] && cp /etc/linuxptp/ptp4l-tsn.conf "$CONF_PREV"
cat > /etc/linuxptp/ptp4l-tsn.conf <<CONF
# Generated by setup-ptp.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Profile $PROFILE over $NET, domain $DOMAIN, bound to $PTP_IF
#
# These four values must match the grandmaster EXACTLY. A mismatch does not
# produce an error - ptp4l simply never leaves s0.
[global]
domainNumber             $DOMAIN
transportSpecific        $TS_SPEC
network_transport        $NET
delay_mechanism          $DELAY
time_stamping            hardware
# This host follows the TSN grandmaster; it never becomes one.
slaveOnly                1
priority1                248
priority2                248
# How long to wait for the next Announce before deciding the grandmaster is
# gone. ptp4l computes that as announceReceiptTimeout x 2^logAnnounceInterval.
#
# These are NOT free choices. A slaveOnly client never transmits Announce, but
# it uses logAnnounceInterval to size its own timeout - so setting it faster
# than the grandmaster actually announces makes ptp4l lock on, time out, drop
# back to LISTENING and repeat forever. That is what happened on 2026-10-05
# with logAnnounceInterval 0 (expect 1/s) against a slower grandmaster:
#
#   LISTENING to UNCALIBRATED on RS_SLAVE
#   UNCALIBRATED to LISTENING on ANNOUNCE_RECEIPT_TIMEOUT_EXPIRES
#
# 2^1 x 10 = 20 s of tolerance. Generous on purpose: slow failover matters far
# less here than never locking at all.
logAnnounceInterval      ${ANN_INT}
announceReceiptTimeout   ${ANN_TIMEOUT}
logSyncInterval          -3
syncReceiptTimeout       10
tx_timestamp_timeout     10
# ptp4l's own socket, readable without root for status queries.
uds_address              /var/run/ptp4l

[$PTP_IF]
CONF
chmod 644 /etc/linuxptp/ptp4l-tsn.conf
say "   /etc/linuxptp/ptp4l-tsn.conf  ($PROFILE / $NET / domain $DOMAIN / $PTP_IF)"

hr; say "6. systemd"
# ExecStartPre recreates the VLAN after a reboot - `ip link add` is not
# persistent, and tying it to this unit keeps it with the thing that needs it.
VLAN_PRE=""
if [ -n "$VLAN" ]; then
  VLAN_PRE="ExecStartPre=/bin/sh -c 'ip link show $PTP_IF >/dev/null 2>&1 || ip link add link $IFACE name $PTP_IF type vlan id $VLAN; ip link set $PTP_IF up'"
fi

cat > /etc/systemd/system/ptp4l-tsn.service <<UNIT
[Unit]
Description=ptp4l - $PROFILE over $NET on $PTP_IF
Documentation=file:/home/tsn_server/tsntestbed/ptp/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$VLAN_PRE
ExecStart=/usr/sbin/ptp4l -f /etc/linuxptp/ptp4l-tsn.conf -i $PTP_IF -m
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

# phc2sys: installed, NOT enabled by default. See the note at the end.
#
# -O is the offset applied between the PHC and CLOCK_REALTIME, and getting it
# wrong is silent. Measured on this rig 2026-10-05:
#     phc_ctl /dev/ptp0 cmp -> offset from CLOCK_REALTIME is -37000174971 ns
# i.e. the grandmaster runs TAI, exactly UTC+37. So -O -37 converts it back to
# UTC. With the default -O 0 this host would sit 37 seconds in the future,
# which nothing would report as an error.
#
# The UE side independently arrived at the same value: its phc2sys runs
#     phc2sys -s enp3s0 -c CLOCK_REALTIME -w -O -37 -m
PHC_OFFSET="${PHC_OFFSET:--37}"
cat > /etc/systemd/system/phc2sys-tsn.service <<UNIT
[Unit]
Description=phc2sys - steer CLOCK_REALTIME from the $IFACE PHC (TAI offset $PHC_OFFSET)
After=ptp4l-tsn.service
Requires=ptp4l-tsn.service

[Service]
Type=simple
# NO -w HERE, DELIBERATELY. It looks like a safety feature ("wait for ptp4l to
# synchronise") but it also makes phc2sys READ THE UTC OFFSET FROM ptp4l over
# the management interface, which SILENTLY OVERRIDES -O.
#
# This grandmaster advertises the ARB timescale (ptp4l logs "foreign master not
# using PTP timescale"), so ptp4l has no valid UTC offset to hand over and
# phc2sys applies 0 - steering CLOCK_REALTIME to the PHC itself, i.e. to TAI.
# Observed 2026-10-05: with '-w -O -37' the system clock marched 6 seconds into
# the future in under a minute, slewing at the 10% maximum rate, and would have
# settled 37 s fast. Dropping -w makes the static -O authoritative.
#
# Requires=ptp4l-tsn.service already gives us the ordering -w was wanted for.
ExecStart=/usr/sbin/phc2sys -s $IFACE -c CLOCK_REALTIME -m -O $PHC_OFFSET
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

hr; say "7. letting the WebUI control it"
# The WebUI runs as $WEBUI_USER. ptp4l needs CAP_NET_RAW, CAP_NET_ADMIN and
# write access to /dev/ptpN, so it cannot be spawned by an unprivileged
# process. Grant exactly these commands rather than running the UI as root.
cat > /etc/sudoers.d/open5gs-webui-ptp <<SUDO
$WEBUI_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start ptp4l-tsn.service
$WEBUI_USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop ptp4l-tsn.service
$WEBUI_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart ptp4l-tsn.service
$WEBUI_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start phc2sys-tsn.service
$WEBUI_USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop phc2sys-tsn.service
# Read-only probe. The WebUI needs a way to prove it holds this permission
# WITHOUT starting or stopping anything; without it the readiness panel cannot
# distinguish "not permitted" from "permitted but idle".
$WEBUI_USER ALL=(root) NOPASSWD: /usr/bin/systemctl show ptp4l-tsn.service --property=Id
SUDO
chmod 440 /etc/sudoers.d/open5gs-webui-ptp
visudo -cf /etc/sudoers.d/open5gs-webui-ptp

cat > /etc/udev/rules.d/99-ptp-clock.rules <<'UDEV'
KERNEL=="ptp[0-9]*", MODE="0660", GROUP="dialout"
UDEV
udevadm control --reload-rules && udevadm trigger --subsystem-match=ptp || true
usermod -aG dialout "$WEBUI_USER" || true

systemctl daemon-reload
systemctl enable ptp4l-tsn.service >/dev/null

# Re-running this script is how you reconfigure, but it is also how you repair
# a half-finished run - and in that second case the daemon may already be
# locked. Restarting costs ~10 s of re-convergence for nothing, so only restart
# when the config actually changed or it is not running.
if [ "$(systemctl is-active ptp4l-tsn.service 2>/dev/null)" = "active" ] \
   && diff -q <(grep -v '^# Generated by' /etc/linuxptp/ptp4l-tsn.conf) \
              <(grep -v '^# Generated by' "$CONF_PREV" 2>/dev/null) >/dev/null 2>&1; then
  say "   config unchanged and ptp4l already running - leaving it alone"
else
  systemctl restart ptp4l-tsn.service
fi
rm -f "$CONF_PREV"

hr; say "8. waiting for lock (up to 45s)"
LOCKED=0
for n in $(seq 1 15); do
  sleep 3
  if jgrep ' s2 ' -u ptp4l-tsn.service --since '60 seconds ago'; then
    LOCKED=1; break
  fi
done

journalctl -u ptp4l-tsn.service -n 12 --no-pager -o cat 2>/dev/null || true
hr
if [ "$LOCKED" = "1" ]; then
  say "LOCKED. ptp4l reached servo state s2 on $PTP_IF."
else
  say "NOT LOCKED YET."
  if jgrep 'ANNOUNCE_RECEIPT_TIMEOUT_EXPIRES' -u ptp4l-tsn.service --since '90 seconds ago'; then
    say "  It FOUND the grandmaster but keeps timing out waiting for Announce."
    say "  That is a timing problem, not a profile mismatch - the grandmaster"
    say "  announces more slowly than this config expects. Try:"
    say "      sudo $0 --iface $IFACE --announce-interval 3 --announce-timeout 10"
  elif jgrep 'best master' -u ptp4l-tsn.service --since '90 seconds ago'; then
    say "  It sees a grandmaster but has not synchronised yet. Give it a minute:"
    say "      journalctl -u ptp4l-tsn.service -f"
  else
    say "  No grandmaster seen at all - profile/transport/domain mismatch."
    say "      sudo $0 --iface $IFACE --detect-only"
  fi
fi

cat <<'NOTE'

phc2sys is installed but deliberately NOT enabled.

  It steers this server's SYSTEM clock from the grandmaster. The UE side
  reports its grandmaster is FREE-RUNNING, so its time is not UTC. Steering
  this host to it would move the 5G core's clock off UTC, breaking log
  correlation with every NTP-disciplined machine, TLS validity windows and
  MongoDB TTL indexes.

  TSN does not need it: ptp4l already disciplines the NIC's PHC, which is what
  the NW-TT timestamps against.

  MEASURED on this rig: the grandmaster runs TAI (UTC+37), so the unit is
  written with -O -37 and phc2sys would put this host on correct UTC, accurate
  to microseconds instead of NTP's milliseconds.

  If you enable it you MUST disable NTP first, or the two fight over the clock:
      sudo timedatectl set-ntp false
      sudo systemctl enable --now phc2sys-tsn.service

  The trade: you gain microsecond UTC shared with the UE; you lose NTP as a
  fallback, so if PTP dies the clock free-runs with nothing to catch it.
NOTE
