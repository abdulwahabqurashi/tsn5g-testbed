#!/bin/sh
#
# TSN-5G UE Console — quick installer for an OpenWRT UE (POSIX ash, no bash).
#
# For development / one-off installs straight from this checkout, without building
# an .ipk feed. Copy the repo to the device (scp -r) and run this as root:
#
#   sh ./scripts/install-openwrt.sh
#
# For a reproducible image, prefer the feed package (see openwrt/Makefile).

set -eu

APP_DIR=/usr/lib/tsn5g-ue
WEB_DIR=/www/tsn5g-ue
CFG_DIR=/etc/tsn5g-ue

HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "[*] opkg update + runtime packages..."
opkg update
# python3 runtime + modem/TSN userspace + kernel modules.
opkg install \
    python3-light python3-yaml python3-urllib python3-logging \
    kmod-usb-net-qmi-wwan kmod-usb-serial-option uqmi libqmi \
    kmod-sched tc linuxptp iwinfo ip-full || {
        echo "!! some packages failed — check 'opkg install' output above" >&2
    }

echo "[*] Installing app to $APP_DIR ..."
mkdir -p "$APP_DIR"
cp -r "$HERE/tsn5g_ue" "$APP_DIR/"

echo "[*] Installing web UI to $WEB_DIR ..."
mkdir -p "$WEB_DIR"
cp -r "$HERE/web/." "$WEB_DIR/"

echo "[*] Installing config to $CFG_DIR ..."
mkdir -p "$CFG_DIR"
if [ ! -f "$CFG_DIR/tsn5g-ue.yaml" ]; then
    cp "$HERE/openwrt/files/tsn5g-ue.config.yaml" "$CFG_DIR/tsn5g-ue.yaml"
    echo "    wrote $CFG_DIR/tsn5g-ue.yaml"
else
    echo "    keeping existing $CFG_DIR/tsn5g-ue.yaml"
fi

echo "[*] Installing procd init script ..."
cp "$HERE/openwrt/files/tsn5g-ue.init" /etc/init.d/tsn5g-ue
chmod +x /etc/init.d/tsn5g-ue

# Make the package importable from the procd command (PYTHONPATH is set there too).
/etc/init.d/tsn5g-ue enable
/etc/init.d/tsn5g-ue start

echo
echo "[+] Done. UI: http://<this-ue>:8080/"
echo "    logs:   logread -e tsn5g-ue"
echo "    stop:   /etc/init.d/tsn5g-ue stop"
