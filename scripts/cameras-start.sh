#!/bin/bash
# Start both camera encoders: camera 1 in the root namespace, camera 2 inside
# the cam2 namespace.
#
# Why both from one script
# ------------------------
# They have to be started as a pair and in the right places, and three details
# have each cost a round trip when done by hand:
#
#   * The config filename is resolved against the CURRENT directory, not the
#     application directory. A bare name launched from elsewhere silently falls
#     back to defaults — which puts BOTH cameras on port 50451 and collides
#     them in the protected lane. Absolute paths here.
#
#   * `nicid` is an index into whatever Spinnaker enumerates, and hiding
#     camera 2 in a namespace changed what camera 1 sees. Each side now has
#     exactly one camera, so both are index 0, but the script checks rather
#     than trusts that.
#
#   * Launched in the foreground they block the terminal and die with it.
#     Both are detached.
#
#   * A killed encoder never releases the camera's control channel. The camera
#     holds it until the heartbeat times out, and a start before then fails
#     with DeviceAccessStatus [-1005]. Stop therefore waits until both cameras
#     report their control channel free before anything is started again.
#
# Display: the encoders go on the virtual screen from vnc-display.sh (:99)
# when it is running, so they can be driven over VNC and survive the desktop
# session locking or logging out. Without it they fall back to the local
# desktop (:0, XWayland). Override with ENC_DISPLAY=:N.
#
# Each encoder still needs its Start button pressed. There is no auto-start:
# cameraStart is a Qt widget method, not a config key.
#
# Usage:  sudo ./cameras-start.sh [stop|status]

set -uo pipefail

APP=/home/amrc/camera_application/U5G/x11/pathStream1
RUN_USER=${SUDO_USER:-amrc}
NS=cam2
LOGDIR=/tmp/camera-encoders
CAM1_CFG="$APP/camera1-protected.json"
CAM2_CFG="$APP/camera2-besteffort.json"
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DAEMON_CFG="$REPO/config/tsn5g-ue.di1200.yaml"
# Side by side on the 1920x1080 virtual screen; Qt's xcb plugin honours
# -geometry for the first window shown.
CAM1_GEOM="-geometry 950x1040+0+0"
CAM2_GEOM="-geometry 950x1040+965+0"

die() { echo "error: $*" >&2; exit 1; }

pick_display() {
    # Sets DISP and XA. The virtual screen needs no auth: it listens only on
    # local sockets.
    DISP=${ENC_DISPLAY:-}
    if [ -z "$DISP" ]; then
        if [ -S /tmp/.X11-unix/X99 ]; then DISP=:99; else DISP=:0; fi
    fi
    if [ "$DISP" = ":0" ]; then XA=$(find_xauth); else XA=; fi
}

find_xauth() {
    local f
    f=$(ls -t /run/user/1000/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
    [ -n "$f" ] || die "no XWayland auth file — is a desktop session running?"
    echo "$f"
}

stop() {
    echo "stopping any running encoders"
    pkill -f "bin/pathStream1" 2>/dev/null
    sleep 3
    pgrep -f "bin/pathStream1" >/dev/null 2>&1 \
        && { echo "  forcing"; pkill -9 -f "bin/pathStream1"; sleep 2; }
    echo "  stopped"
    wait_cameras_free
}

wait_cameras_free() {
    # Needs root for camera 2 (its NIC is in the namespace).
    [ "$(id -u)" -eq 0 ] || { echo "  (not root: skipping the control-channel check)"; return 0; }
    echo "waiting for both cameras to release their control channel"
    (cd "$REPO" && python3 -m tsn5g_ue.net.cameras wait-free \
        "$DAEMON_CFG" camera1 camera2 --timeout 45) | sed 's/^/  /'
    [ "${PIPESTATUS[0]}" -eq 0 ] || \
        die "a camera is not ready (see above). If it is held, bounce its link (camera 2: inside netns $NS) and retry"
}

status() {
    echo "encoders:"
    for n in camera1-protected camera2-besteffort; do
        p=$(pgrep -f "bin/pathStream1 .*$n" | head -1)
        printf "  %-22s %s\n" "$n" "${p:-not running}"
    done
    echo "namespace:"
    ip netns list 2>/dev/null | grep -w "$NS" | sed 's/^/  /' || echo "  $NS absent"
    echo "configs:"
    for f in "$CAM1_CFG" "$CAM2_CFG"; do
        printf "  %-28s %s\n" "$(basename "$f")" "$(tr -d ' \n' < "$f" 2>/dev/null | cut -c1-70)"
    done
}

start() {
    [ "$(id -u)" -eq 0 ] || die "must run as root (camera 2 needs 'ip netns exec')"
    [ -f "$CAM1_CFG" ] || die "missing $CAM1_CFG"
    [ -f "$CAM2_CFG" ] || die "missing $CAM2_CFG"
    ip netns list | grep -qw "$NS" || die "namespace $NS does not exist — run camera2-netns.sh up first"

    local DISP XA; pick_display
    echo "display: $DISP"
    install -d -o "$RUN_USER" -g "$RUN_USER" "$LOGDIR"
    stop

    echo "starting camera 1 (root namespace, protected lane :50451)"
    setsid sudo -u "$RUN_USER" env DISPLAY="$DISP" ${XA:+XAUTHORITY="$XA"} \
        "$APP/run.sh" "$CAM1_CFG" $CAM1_GEOM \
        > "$LOGDIR/cam1.log" 2>&1 < /dev/null &
    sleep 6

    echo "starting camera 2 (namespace $NS, best-effort lane :50452)"
    setsid ip netns exec "$NS" sudo -u "$RUN_USER" env DISPLAY="$DISP" ${XA:+XAUTHORITY="$XA"} \
        "$APP/run.sh" "$CAM2_CFG" $CAM2_GEOM \
        > "$LOGDIR/cam2.log" 2>&1 < /dev/null &
    sleep 8

    echo
    local ok=0
    for n in camera1-protected camera2-besteffort; do
        if pgrep -f "bin/pathStream1 .*$n" >/dev/null; then
            echo "  $n: running"; ok=$((ok+1))
        else
            echo "  $n: FAILED — see $LOGDIR/${n%%-*}.log"
            tail -3 "$LOGDIR/$([ "$n" = camera1-protected ] && echo cam1 || echo cam2).log" 2>/dev/null | sed 's/^/      /'
        fi
    done
    echo
    if [ "$ok" -eq 2 ]; then
        echo "Both encoders are up. Two windows should be on screen $DISP."
        echo "Press Start in each — there is no auto-start."
    fi
    echo "logs: $LOGDIR/cam1.log  $LOGDIR/cam2.log"
}

case "${1:-start}" in
    start) start ;;
    stop) stop ;;
    status) status ;;
    *) echo "usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac
