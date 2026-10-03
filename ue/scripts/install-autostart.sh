#!/bin/bash
# Make the two-camera rig come back by itself after a reboot.
#
# Renders (from templates/systemd/*.in and site.env) and enables:
#
#   tsn5g-cam2-netns    camera 2's NIC into its own namespace   (before the daemon)
#   tsn5g-vnc-display   virtual screen + VNC (localhost only)   (as UE_USER)
#   tsn5g-cameras       both encoders on that screen, Start pressed
#
# install.sh ue does this as one of its steps; this script exists so the web
# UI's "install boot units" button can redo just this part.
#
# Enabling is not starting. The namespace and screen units are started now
# (no-ops on a rig that already has them). The encoder unit is NOT started
# unless --start-cameras is given: that relaunches the encoders, and
# interrupting a live stream should be a decision.
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

# shellcheck disable=SC1091
. "$HERE/../lib/render.sh"
SITE=${SITE_ENV:-/etc/tsn5g/site.env}
[ -f "$SITE" ] || SITE="$HERE/../site.env"
load_site "$SITE"
for u in "${UNITS[@]}"; do
    render "$HERE/templates/systemd/$u.in" "/etc/systemd/system/$u"
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
