#!/usr/bin/env bash
#
# Remove the TSN-5G UE Console.
#
#   sudo ./uninstall.sh [--purge]
#
# Stops and removes the service and the application. Your config, your iperf
# history and the signal database are KEPT unless you pass --purge.
#
# The 5G data call is deliberately NOT torn down: it lives in the modem and the
# kernel, not in this process, and removing a console is not a reason to drop a
# link something else may be using. Take it down from the UI first if you want
# it down.
#
set -euo pipefail

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

[[ $EUID -eq 0 ]] || { echo "ERROR: run with sudo." >&2; exit 1; }

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Stopping the service"
systemctl disable --now tsn5g-ue.service >/dev/null 2>&1 || true
systemctl disable --now tsn5g-ue-kiosk.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/tsn5g-ue.service /etc/systemd/system/tsn5g-ue-kiosk.service
systemctl daemon-reload
echo "    stopped and removed"

say "Removing the application"
rm -rf /opt/tsn5g-ue
rm -f /etc/sudoers.d/tsn5g-ue
rm -rf /run/tsn5g-ue
echo "    /opt/tsn5g-ue, the sudoers rule and the runtime state are gone"

if [[ $PURGE -eq 1 ]]; then
    say "Purging configuration and data"
    rm -rf /etc/tsn5g-ue /var/lib/tsn5g-ue
    echo "    config, iperf history and the signal database are gone"
else
    cat <<EOF

  Kept (pass --purge to remove):
    /etc/tsn5g-ue       your configuration
    /var/lib/tsn5g-ue   iperf run history and the signal database

  ModemManager was masked by the installer. If you want it back:
    sudo systemctl unmask --now ModemManager

  Any 5G data call is still up. Check with: ip -br addr show wwan0
EOF
fi
