#!/usr/bin/env bash
#
# TSN-5G UE Console — installer.
#
#   sudo ./install.sh
#
# Installs to /opt/tsn5g-ue, writes a config to /etc/tsn5g-ue, installs the
# systemd unit and a scoped sudoers rule, starts the service, and waits until
# the UI actually answers before claiming success.
#
# Safe to re-run: an existing config is never overwritten, and the bearer is
# not touched. Nothing here brings the modem up — that is the operator's call,
# from the UI.
#
set -euo pipefail

APP_DIR=/opt/tsn5g-ue
CFG_DIR=/etc/tsn5g-ue
CFG_FILE="$CFG_DIR/tsn5g-ue.yaml"
STATE_DIR=/var/lib/tsn5g-ue
PORT=8080
INSTALL_KIOSK=0
MASK_MM=1

usage() {
    cat <<EOF
Usage: sudo ./install.sh [options]

  --kiosk           also install the full-screen browser unit (needs a display)
  --no-mask-mm      do not mask ModemManager (see the warning below)
  --port N          serve the UI on port N instead of $PORT
  -h, --help        this

ModemManager and this daemon both want /dev/ttyUSB*. If both run, they fight:
ModemManager rewrites radio preferences underneath you and holds the AT port.
The installer masks it. Stopping it is not enough — D-Bus reactivates it.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --kiosk) INSTALL_KIOSK=1 ;;
        --no-mask-mm) MASK_MM=0 ;;
        --port) PORT="${2:?--port needs a number}"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: run with sudo." >&2
    exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Works both from a release tarball (files beside this script) and from a
# checkout (files one level up).
[[ -d "$HERE/tsn5g_ue" ]] || HERE="$(cd "$HERE/.." && pwd)"
[[ -d "$HERE/tsn5g_ue" ]] || { echo "ERROR: cannot find tsn5g_ue/ next to $0" >&2; exit 1; }

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33mWARNING: %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 1. packages
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Every Python dependency is packaged by Debian. Deliberately not pip: Ubuntu
# 24.04 marks the system interpreter externally-managed (PEP 668), so a pip
# install aborts, and the daemon runs against the system interpreter anyway.
apt-get install -y --no-install-recommends \
    python3 python3-yaml python3-serial python3-paramiko \
    iproute2 iptables bridge-utils ethtool \
    libqmi-utils iperf3 linuxptp >/dev/null
note "python3, qmicli, iperf3, iproute2, ethtool, linuxptp"

missing=$(python3 - <<'PY'
import importlib.util
print(" ".join(m for m in ("yaml", "serial", "paramiko")
                if not importlib.util.find_spec(m)))
PY
)
[[ -z "$missing" ]] || { echo "ERROR: python modules still missing:$missing" >&2; exit 1; }

# ---------------------------------------------------------------- 2. hardware
say "Checking hardware"
if [[ -e /dev/cdc-wdm0 ]]; then
    note "QMI control device: /dev/cdc-wdm0"
else
    warn "no /dev/cdc-wdm0 — the 5G modem is not present or not in QMI mode."
    warn "The console will install and run; the modem views will say so."
fi
ports=$(ls /dev/ttyUSB* 2>/dev/null | tr '\n' ' ' || true)
[[ -n "$ports" ]] && note "AT serial candidates: $ports" \
                  || warn "no /dev/ttyUSB* — no AT port to talk to the modem on."

# ---------------------------------------------------- 3. ModemManager contention
if [[ $MASK_MM -eq 1 ]]; then
    say "Masking ModemManager"
    if systemctl is-enabled ModemManager >/dev/null 2>&1; then
        systemctl mask --now ModemManager >/dev/null 2>&1 || true
        note "masked (it competes for the AT port and rewrites radio prefs)"
    else
        note "not installed or already masked"
    fi
else
    warn "--no-mask-mm given; expect contention for /dev/ttyUSB*"
fi

# ------------------------------------------------------------------ 4. install
say "Installing to $APP_DIR"
mkdir -p "$APP_DIR" "$STATE_DIR" "$CFG_DIR"
rm -rf "$APP_DIR/tsn5g_ue" "$APP_DIR/web"
cp -r "$HERE/tsn5g_ue" "$HERE/web" "$APP_DIR/"
[[ -d "$HERE/desktop" ]] && cp -r "$HERE/desktop" "$APP_DIR/" || true
[[ -d "$HERE/docs" ]] && cp -r "$HERE/docs" "$APP_DIR/" || true
note "$(find "$APP_DIR/tsn5g_ue" -name '*.py' | wc -l) python files, $(find "$APP_DIR/web" -type f | wc -l) web files"

say "Configuration"
if [[ -f "$CFG_FILE" ]]; then
    note "keeping the existing $CFG_FILE"
else
    cp "$HERE/config/tsn5g-ue.example.yaml" "$CFG_FILE"
    note "wrote $CFG_FILE from the template"
    warn "EDIT IT before connecting: modem.dnn (your APN) and vxlan.core_ip"
fi
if [[ "$PORT" != "8080" ]]; then
    sed -i -E "s/^(\s*port:\s*)[0-9]+/\1$PORT/" "$CFG_FILE"
    note "UI port set to $PORT"
fi

# ------------------------------------------------------------------ 5. sudoers
if [[ -f "$HERE/docs/tsn5g-ue.sudoers" ]]; then
    say "Installing the scoped sudoers rule"
    install -m0440 "$HERE/docs/tsn5g-ue.sudoers" /etc/sudoers.d/tsn5g-ue
    if visudo -c -f /etc/sudoers.d/tsn5g-ue >/dev/null 2>&1; then
        note "/etc/sudoers.d/tsn5g-ue installed and valid"
    else
        rm -f /etc/sudoers.d/tsn5g-ue
        warn "sudoers file failed validation and was removed (not fatal)"
    fi
fi

# ------------------------------------------------------------------ 6. service
say "Installing the systemd service"
install -m0644 "$HERE/systemd/tsn5g-ue.service" /etc/systemd/system/tsn5g-ue.service
systemctl daemon-reload
systemctl enable tsn5g-ue.service >/dev/null 2>&1
systemctl restart tsn5g-ue.service
note "enabled at boot and started"

if [[ $INSTALL_KIOSK -eq 1 ]]; then
    if [[ -x "$APP_DIR/desktop/kiosk.sh" ]]; then
        install -m0644 "$HERE/systemd/tsn5g-ue-kiosk.service" /etc/systemd/system/
        systemctl daemon-reload
        systemctl enable tsn5g-ue-kiosk.service >/dev/null 2>&1 || true
        note "kiosk unit installed (set User= and DISPLAY= to match your session)"
    else
        warn "--kiosk given but desktop/kiosk.sh is missing; skipped"
    fi
fi

# ------------------------------------------------------------------- 7. verify
say "Waiting for the UI"
# python3 rather than curl: python3 is already a hard dependency of the daemon
# and curl is not. Installing a package purely to poll a local port would give
# the installer a dependency the product itself does not have.
probe() {
    python3 - "$1" <<'PYPROBE' >/dev/null 2>&1
import sys, urllib.request
urllib.request.urlopen(sys.argv[1], timeout=3).read()
PYPROBE
}

deadline=$((SECONDS + 45))
ok=0
while (( SECONDS < deadline )); do
    if probe "http://127.0.0.1:$PORT/api/health"; then ok=1; break; fi
    sleep 1
done

if [[ $ok -ne 1 ]]; then
    echo
    echo "ERROR: the service did not answer on port $PORT within 45s." >&2
    echo "       journalctl -u tsn5g-ue -n 40 --no-pager" >&2
    systemctl --no-pager --lines=15 status tsn5g-ue.service >&2 || true
    exit 1
fi

routes=$(python3 - "http://127.0.0.1:$PORT/api/spec" <<'PYSPEC' 2>/dev/null || echo "?"
import json, sys, urllib.request
print(len(json.load(urllib.request.urlopen(sys.argv[1], timeout=5))["routes"]))
PYSPEC
)
ip=$(hostname -I 2>/dev/null | awk '{print $1}')

cat <<EOF

  TSN-5G UE Console is running.

    UI          http://${ip:-<this-host>}:$PORT/
    API         $routes routes
    Config      $CFG_FILE
    Logs        journalctl -u tsn5g-ue -f
    Guide       $APP_DIR/docs/USER_GUIDE.md

  Next: open the UI, check Modem, then Connection -> Bring up.
  Read the guide first if this is a new 5G setup — the APN and core address
  in the config have to match your network before a data call will work.

EOF
