#!/bin/bash
# Optional: gPTP on the core (ptp4l + phc2sys), on CORE_PTP_IF from site.env —
# a port with a hardware clock (ethtool -T), cabled to the TSN switch /
# grandmaster. Not part of install.sh core: the first rig never cabled it (README.md).
#
#   sudo core/ptp/install-ptp.sh
set -e
HERE=$(dirname "$(readlink -f "$0")")
# shellcheck disable=SC1091
. "$HERE/../scripts/site-env.sh"
IFACE=${CORE_PTP_IF:?set CORE_PTP_IF in site.env to the core NIC with a hardware clock}
echo "== 1. checking link =="
if [ "$(cat /sys/class/net/$IFACE/carrier 2>/dev/null)" != "1" ]; then
  echo "FAIL: $IFACE has no carrier. Plug it into the TSN switch first." >&2
  exit 1
fi
echo "== 2. installing linuxptp =="
apt-get update && apt-get install -y linuxptp
echo "== 3. installing config =="
install -D -m644 "$HERE/ptp4l-gptp.conf" /etc/linuxptp/ptp4l-gptp.conf
echo "== 4. systemd units =="
cat > /etc/systemd/system/ptp4l-gptp.service <<UNIT
[Unit]
Description=ptp4l gPTP on $IFACE
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/sbin/ptp4l -f /etc/linuxptp/ptp4l-gptp.conf -i $IFACE --step_threshold=1
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/phc2sys-gptp.service <<UNIT
[Unit]
Description=phc2sys - discipline CLOCK_REALTIME from $IFACE PHC
After=ptp4l-gptp.service
Requires=ptp4l-gptp.service
[Service]
ExecStart=/usr/sbin/phc2sys -s $IFACE -c CLOCK_REALTIME -w -m -O 0
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ptp4l-gptp.service phc2sys-gptp.service
echo "== 5. status =="
sleep 5
systemctl --no-pager -n 10 status ptp4l-gptp phc2sys-gptp || true
