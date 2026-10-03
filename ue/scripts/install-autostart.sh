#!/bin/bash
# Make the two-camera rig come back by itself after a reboot.
#
# Installs and enables three units beside tsn5g-ue.service:
#
#   tsn5g-cam2-netns    camera 2's NIC into netns cam2       (before the daemon)
#   tsn5g-vnc-display   virtual screen :99 + VNC on :5900    (as amrc)
#   tsn5g-cameras       both encoders on :99                 (after all of the above)
#
# Enabling is not starting. The namespace and screen units are started now,
# because both are no-ops on a rig that already has them. The encoder unit is
# NOT started unless --start-cameras is given: that would stop and relaunch the
# encoders, and interrupting a live stream should be a decision.
#
# Each encoder still needs its Start button pressed after boot (over VNC):
# cameraStart is a Qt widget method, not a config key.
#
# Usage:  sudo ./install-autostart.sh [--start-cameras] | --remove

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UNITS=(tsn5g-cam2-netns.service tsn5g-vnc-display.service tsn5g-cameras.service)

[ "$(id -u)" -eq 0 ] || { echo "error: run with sudo" >&2; exit 1; }

if [ "${1:-}" = "--remove" ]; then
    for u in "${UNITS[@]}"; do
        systemctl disable "$u" 2>/dev/null || true
        rm -f "/etc/systemd/system/$u"
    done
    systemctl daemon-reload
    echo "autostart units removed (running processes left as they are)"
    exit 0
fi

for u in "${UNITS[@]}"; do
    install -m0644 "$HERE/systemd/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl enable "${UNITS[@]}" >/dev/null 2>&1
echo "enabled: ${UNITS[*]}"

systemctl start tsn5g-cam2-netns.service tsn5g-vnc-display.service
if [ "${1:-}" = "--start-cameras" ]; then
    echo "relaunching the encoders under systemd (cameras will blip)"
    systemctl start tsn5g-cameras.service
else
    echo "tsn5g-cameras.service enabled for next boot, not started now"
    echo "  (run with --start-cameras to hand the running encoders over to it)"
fi
echo
systemctl --no-pager --lines=0 status "${UNITS[@]}" | grep -E "●|Active:"
