#!/usr/bin/env bash
#
# TSN-5G UE Console — one-time installer (run during UE imaging, not by the end user).
#
# Installs the app to /opt/tsn5g-ue, config to /etc/tsn5g-ue, Python deps, and the
# two systemd units (backend service + optional kiosk wrapper).
#
#   sudo ./scripts/install.sh [--no-kiosk]
#
set -euo pipefail

APP_DIR=/opt/tsn5g-ue
CFG_DIR=/etc/tsn5g-ue
STATE_DIR=/var/lib/tsn5g-ue
INSTALL_KIOSK=1

for arg in "$@"; do
    case "$arg" in
        --no-kiosk) INSTALL_KIOSK=0 ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: must run as root (sudo)." >&2
    exit 1
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "[*] System packages (python, iproute2, linuxptp, qmi tools, ssh helpers)..."
apt-get update -qq
# Every Python runtime dep is packaged by Debian. Do NOT use pip here: Ubuntu
# 24.04 marks the system interpreter externally-managed (PEP 668), so
# `pip3 install` aborts, and the daemon runs as root against the system
# interpreter anyway.
apt-get install -y --no-install-recommends \
    python3 python3-yaml python3-serial python3-paramiko \
    iproute2 bridge-utils linuxptp libqmi-utils iperf3 curl

echo "[*] Verifying Python dependencies are importable ..."
python3 - <<'PYCHECK'
import importlib, sys
missing = [m for m in ("yaml", "serial", "paramiko") if not importlib.util.find_spec(m)]
if missing:
    sys.exit("ERROR: missing Python modules: " + ", ".join(missing))
print("    yaml, serial, paramiko OK")
PYCHECK

echo "[*] Copying application to $APP_DIR ..."
mkdir -p "$APP_DIR"
cp -r "$HERE/tsn5g_ue" "$HERE/web" "$APP_DIR/"
if [[ -d "$HERE/desktop" ]]; then
    cp -r "$HERE/desktop" "$APP_DIR/"
fi

echo "[*] Installing config to $CFG_DIR ..."
mkdir -p "$CFG_DIR" "$STATE_DIR"
if [[ ! -f "$CFG_DIR/tsn5g-ue.yaml" ]]; then
    cp "$HERE/config/tsn5g-ue.example.yaml" "$CFG_DIR/tsn5g-ue.yaml"
    echo "    wrote $CFG_DIR/tsn5g-ue.yaml (edit to taste; most fields auto-detect)"
else
    echo "    keeping existing $CFG_DIR/tsn5g-ue.yaml"
fi

echo "[*] Installing systemd units ..."
install -m0644 "$HERE/systemd/tsn5g-ue.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tsn5g-ue.service

if [[ $INSTALL_KIOSK -eq 1 ]]; then
    install -m0644 "$HERE/systemd/tsn5g-ue-kiosk.service" /etc/systemd/system/
    if [[ ! -x "$APP_DIR/desktop/kiosk.sh" ]]; then
        echo "ERROR: $APP_DIR/desktop/kiosk.sh missing; re-run without --no-kiosk sources" >&2
        exit 1
    fi
    systemctl daemon-reload
    systemctl enable tsn5g-ue-kiosk.service || true
    echo "    kiosk unit installed (starts on graphical.target; set User=/DISPLAY as needed)"
fi

echo
echo "[+] Done. UI: http://<this-ue>:8080/"
systemctl --no-pager status tsn5g-ue.service || true
