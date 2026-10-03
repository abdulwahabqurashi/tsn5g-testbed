#!/usr/bin/env bash
#
# Install Open5GS-TSN as systemd services.
# Replaces run5gs.sh for production: ordered startup, auto-restart,
# journald logging. Idempotent — safe to re-run after a rebuild.
#
# Usage:  sudo ./deploy/systemd/install.sh [WEBUI_ADDR]
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Must run as root (sudo)." >&2
    exit 1
fi

# Repo root = two levels up from this script.
BASEDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRCDIR="$BASEDIR/deploy/systemd"
UNIT_DIR="/etc/systemd/system"

# Owner of the checkout runs the WebUI (not root).
RUN_USER="${SUDO_USER:-$(stat -c '%U' "$BASEDIR")}"
WEBUI_ADDR="${1:-10.5.0.84}"
NODE="$(command -v node || echo /usr/bin/node)"

NFS="nrf scp ausf udm udr pcf nssf bsf amf smf upf tsn-af"

echo "Repo:        $BASEDIR"
echo "WebUI user:  $RUN_USER"
echo "WebUI addr:  $WEBUI_ADDR:9999"
echo "node:        $NODE"

# sanity: binaries built?
if [ ! -x "$BASEDIR/build/src/nrf/open5gs-nrfd" ]; then
    echo "Build not found — run 'ninja -C build' first." >&2
    exit 1
fi

subst() {
    sed -e "s#@BASEDIR@#$BASEDIR#g" \
        -e "s#@USER@#$RUN_USER#g" \
        -e "s#@WEBUI_ADDR@#$WEBUI_ADDR#g" \
        -e "s#@NODE@#$NODE#g" \
        "$1" > "$2"
}

echo "Installing units into $UNIT_DIR ..."
subst "$SRCDIR/open5gs-tsn-netconf.service" "$UNIT_DIR/open5gs-tsn-netconf.service"
subst "$SRCDIR/open5gs-tsn@.service"        "$UNIT_DIR/open5gs-tsn@.service"
subst "$SRCDIR/open5gs-tsn-webui.service"   "$UNIT_DIR/open5gs-tsn-webui.service"
subst "$SRCDIR/open5gs-tsn.target"          "$UNIT_DIR/open5gs-tsn.target"

systemctl daemon-reload

echo "Enabling services ..."
systemctl enable open5gs-tsn-netconf.service open5gs-tsn-webui.service open5gs-tsn.target >/dev/null
for nf in $NFS; do
    systemctl enable "open5gs-tsn@${nf}.service" >/dev/null
done

cat <<EOF

Installed. Manage the whole stack with:
  sudo systemctl start  open5gs-tsn.target     # start everything
  sudo systemctl stop   open5gs-tsn.target     # stop everything
  sudo systemctl status 'open5gs-tsn@*'        # per-NF status
  journalctl -u open5gs-tsn@smf -f             # follow one NF's log
  journalctl -u open5gs-tsn-webui -f           # follow the WebUI

Single NF (e.g. after editing its config):
  sudo systemctl restart open5gs-tsn@smf

Note: MongoDB (mongod.service) is a prerequisite and is not managed here.
Enable it separately:  sudo systemctl enable --now mongod

Start now?  sudo systemctl start open5gs-tsn.target
EOF
