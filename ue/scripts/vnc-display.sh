#!/bin/bash
# A virtual screen (:99) shared over VNC, for driving the GUI apps remotely.
#
# Why this exists
# ---------------
# Neither box can be used from its own screen during a test. The core has no
# desktop at all, and the viewer forwarded over SSH X11 was throttled so hard
# the kernel dropped 905,696 UDP packets to receive-buffer overflow. The UE's
# desktop is a Wayland session, which x11vnc cannot share, and it locks.
#
# So both boxes get the same thing: Xvfb as the screen, a window manager so
# windows have a close button (closing the window is the ONLY safe way to stop
# an encoder — a signal leaves the camera reserved), and x11vnc to share it.
#
# x11vnc listens on localhost only. Reach it through an SSH tunnel:
#
#   ssh -L 5901:localhost:5900 <UE_USER>@<UE_LAN_IP>        # the UE
#   ssh -L 5902:localhost:5900 <CORE_USER>@<CORE_LAN_IP>    # the core
#
# then point a VNC viewer at localhost:5901 / localhost:5902.
#
# Usage:  ./vnc-display.sh up | down | status       (as your normal user)

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/site-env.sh" 2>/dev/null || true   # site.env if present
DISP=${VNC_DISPLAY:-:${DISPLAY_NUM:-99}}
GEOM=${VNC_GEOMETRY:-${SCREEN_GEOMETRY:-1920x1080x24}}
PORT=${VNC_PORT:-5900}
LOGDIR=/tmp/vnc-display-$(id -un)
N=${DISP#:}

die() { echo "error: $*" >&2; exit 1; }

pick_wm() {
    local wm
    for wm in openbox fluxbox icewm twm; do
        command -v "$wm" >/dev/null 2>&1 && { echo "$wm"; return; }
    done
}

up() {
    [ "$(id -u)" -ne 0 ] || die "run as your normal user, not root"
    command -v Xvfb >/dev/null || die "Xvfb not installed (apt install xvfb)"
    command -v x11vnc >/dev/null || die "x11vnc not installed (apt install x11vnc)"
    mkdir -p "$LOGDIR"

    if [ -S "/tmp/.X11-unix/X$N" ]; then
        echo "screen $DISP already running"
    else
        echo "starting screen $DISP ($GEOM)"
        setsid Xvfb "$DISP" -screen 0 "$GEOM" -nolisten tcp \
            > "$LOGDIR/xvfb.log" 2>&1 < /dev/null &
        for _ in $(seq 20); do [ -S "/tmp/.X11-unix/X$N" ] && break; sleep 0.25; done
        [ -S "/tmp/.X11-unix/X$N" ] || die "Xvfb did not start — see $LOGDIR/xvfb.log"
    fi

    local wm; wm=$(pick_wm)
    if [ -z "$wm" ]; then
        echo "WARNING: no window manager installed (apt install openbox)."
        echo "         Windows will have no close button, and closing the window"
        echo "         is the only safe way to stop an encoder."
    elif pgrep -u "$(id -u)" -x "$wm" >/dev/null; then
        echo "window manager $wm already running"
    else
        echo "starting window manager $wm"
        DISPLAY="$DISP" setsid "$wm" > "$LOGDIR/wm.log" 2>&1 < /dev/null &
    fi

    if pgrep -u "$(id -u)" -f "x11vnc .*-display $DISP" >/dev/null; then
        echo "x11vnc already sharing $DISP"
    else
        local auth=(-nopw)
        if [ -f "$HOME/.vnc/passwd" ]; then
            auth=(-rfbauth "$HOME/.vnc/passwd")
        else
            echo "note: no VNC password set (x11vnc -storepasswd); relying on"
            echo "      localhost-only + SSH tunnel"
        fi
        echo "sharing $DISP on localhost:$PORT"
        setsid x11vnc -display "$DISP" -localhost -rfbport "$PORT" -forever \
            -shared "${auth[@]}" -o "$LOGDIR/x11vnc.log" \
            > /dev/null 2>&1 < /dev/null &
        sleep 1
    fi
    status
}

down() {
    echo "stopping x11vnc, window manager and screen $DISP"
    echo "  (close any encoder windows FIRST — this kills whatever is on the screen)"
    pkill -u "$(id -u)" -f "x11vnc .*-display $DISP" 2>/dev/null
    local wm; wm=$(pick_wm)
    [ -n "$wm" ] && pkill -u "$(id -u)" -x "$wm" 2>/dev/null
    pkill -u "$(id -u)" -f "Xvfb $DISP" 2>/dev/null
    true
}

status() {
    printf "  %-10s %s\n" screen "$([ -S "/tmp/.X11-unix/X$N" ] && echo "$DISP up" || echo down)"
    local wm; wm=$(pick_wm)
    printf "  %-10s %s\n" wm "${wm:-none installed}$( [ -n "$wm" ] && pgrep -x "$wm" >/dev/null && echo ' (running)')"
    printf "  %-10s %s\n" x11vnc "$(pgrep -f "x11vnc .*-display $DISP" >/dev/null && echo "localhost:$PORT" || echo down)"
    echo "  windows on $DISP:"
    DISPLAY="$DISP" xwininfo -root -children 2>/dev/null | grep -E '^ +0x' \
        | grep -v 'has no name' | sed 's/^ */    /' || echo "    (none, or xwininfo missing)"
}

case "${1:-}" in
    up) up ;;
    down) down ;;
    status) status ;;
    *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
