#!/usr/bin/env bash
#
# Full-screen browser pointed at the local UE console.
#
# Launched by systemd/tsn5g-ue-kiosk.service, which has already waited for
# http://localhost:8080/ to answer. Runs in the console user's graphical
# session, so DISPLAY/XAUTHORITY must be set by the unit (or by the session).
#
set -euo pipefail

URL="${TSN5G_UI_URL:-http://localhost:8080/}"
PROFILE="${TSN5G_KIOSK_PROFILE:-$HOME/.cache/tsn5g-ue-kiosk}"

# Pick whatever Chromium-family browser this image actually has.
BROWSER=""
for cand in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$cand" >/dev/null 2>&1; then BROWSER="$cand"; break; fi
done
if [[ -z "$BROWSER" ]]; then
    echo "ERROR: no chromium/chrome binary found on PATH" >&2
    exit 1
fi

mkdir -p "$PROFILE"

# Chromium writes an "exited uncleanly" nag into Preferences after a hard power
# cut, which on a kiosk shows as a restore-pages bubble over the UI on every
# boot. Clearing the two flags is the documented way to suppress it.
PREFS="$PROFILE/Default/Preferences"
if [[ -f "$PREFS" ]]; then
    sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$PREFS" || true
fi

exec "$BROWSER" \
    --user-data-dir="$PROFILE" \
    --kiosk \
    --app="$URL" \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=TranslateUI,Translate \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000
