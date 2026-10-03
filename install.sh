#!/bin/bash
# One installer for every machine in the testbed.
#
#   sudo ./install.sh ue        the UE (modem, cameras, encoders, daemon + web UI)
#   sudo ./install.sh core      the 5G core and gNB (build + configure + start)
#   sudo ./install.sh viewer    the video viewer on a virtual screen (normally on the core)
#
# Options (after the role):
#   --dry-run          render everything into ./rendered/ and print what would
#                      run; changes nothing on this machine, needs no sudo
#   --site FILE        use FILE instead of ./site.env
#   --no-start         install and enable, but do not (re)start services
#   --start-cameras    ue: (re)start the encoders even if they are running now
#   --remove           ue/viewer: stop and remove the units (code and data kept)
#
# Safe to re-run: it converges the machine to what site.env says. Read
# docs/DEPLOY.md first on a new site.
set -euo pipefail

ROLE=${1:-}; shift || true
SITE=""; NO_START=0; START_CAMERAS=0; REMOVE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)       export DRY_RUN=1 ;;
        --site)          SITE=${2:?--site needs a file}; shift ;;
        --no-start)      NO_START=1 ;;
        --start-cameras) START_CAMERAS=1 ;;
        --remove)        REMOVE=1 ;;
        -h|--help)       sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
done

# shellcheck source=lib/render.sh
. "$(dirname "$(readlink -f "$0")")/lib/render.sh"

case "$ROLE" in
    ue|core|viewer) ;;
    ""|-h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown role '$ROLE' — use ue, core or viewer" ;;
esac

need_root
load_site ${SITE:+"$SITE"}
[ "$DRY_RUN" = 1 ] && say "DRY RUN — nothing on this machine will change; output in $REPO_ROOT/rendered/"

# shellcheck disable=SC1090
[ -f "$REPO_ROOT/lib/install-$ROLE.sh" ] || die "role $ROLE is not available in this version"
. "$REPO_ROOT/lib/install-$ROLE.sh"
install_"$ROLE"
