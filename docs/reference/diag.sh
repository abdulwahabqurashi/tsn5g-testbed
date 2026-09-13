#!/bin/bash
# One-shot UE radio diagnosis. No option flags to mangle: just `sudo ./diag.sh`.
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"

D=/dev/cdc-wdm0
Q=(qmicli -d "$D" --device-open-proxy)

echo "===== 1. services that compete for the modem ====="
for s in ModemManager tsn5g-ue; do printf '  %-14s %s\n' "$s" "$(systemctl is-active $s)"; done

echo
echo "===== 2. QMI radio state ====="
"${Q[@]}" --dms-get-operating-mode 2>&1 | sed 's/^/  /'
"${Q[@]}" --nas-get-serving-system  2>&1 | sed 's/^/  /'
"${Q[@]}" --nas-get-signal-info     2>&1 | sed 's/^/  /'

echo
echo "===== 3. AT diagnostics ====="
./at.py

echo
echo "===== 4. interface ====="
ip -br addr show wwan0 2>&1 | sed 's/^/  /'
