# install.sh viewer — the video viewer on a virtual screen (normally on the core).
# Sourced by install.sh (render.sh and site.env already loaded).
#
#   1 packages   2 bundle + config   3 sysctl   4 units   5 enable + start

VIEWER_UNITS=(tsn5g-viewer-display.service tsn5g-viewer.service)

install_viewer() {
    require VIEWER_USER DISPLAY_NUM VNC_PORT VIEWER_PORT_FIRST PREFIX VENDOR_DIR
    if [ "$REMOVE" = 1 ]; then
        local u
        for u in tsn5g-viewer.service tsn5g-viewer-display.service; do
            run systemctl disable --now "$u" 2>/dev/null || true
            run rm -f "/etc/systemd/system/$u"
        done
        run systemctl daemon-reload; return
    fi
    id "$VIEWER_USER" >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ] || die "VIEWER_USER=$VIEWER_USER does not exist on this machine"

    say "1/5 packages (virtual screen, VNC, Qt runtime)"
    apt_install xvfb x11vnc openbox x11-utils rsync gettext-base $QT_RUNTIME_PKGS

    say "2/5 viewer bundle + config"
    run mkdir -p "$PREFIX/video/bin" "$PREFIX/video/viewer"
    run install -m0755 "$REPO_ROOT/ue/scripts/vnc-display.sh" "$REPO_ROOT/ue/scripts/site-env.sh" "$PREFIX/video/bin/"
    run install -m0644 "$REPO_ROOT/video/README.md" "$REPO_ROOT/video/MANIFEST" "$PREFIX/video/"
    run install -D -m0644 "$SITE_FILE" "$ETC_DIR/site.env"
    if install_bundle pathView2 "$PREFIX/video/viewer"; then
        viewer_config > "${TMPDIR:-/tmp}/tsn5g-viewer-config.json"
        if [ "$DRY_RUN" = 1 ]; then
            install -D -m0644 "${TMPDIR:-/tmp}/tsn5g-viewer-config.json" "$REPO_ROOT/rendered${PREFIX}/video/viewer/pathView2/config.json"
            echo "   rendered  $PREFIX/video/viewer/pathView2/config.json  (dry run: rendered/...)"
        else
            install -m0644 "${TMPDIR:-/tmp}/tsn5g-viewer-config.json" "$PREFIX/video/viewer/pathView2/config.json"
            echo "   installed $PREFIX/video/viewer/pathView2/config.json"
        fi
        rm -f "${TMPDIR:-/tmp}/tsn5g-viewer-config.json"
        run chown -R "$VIEWER_USER:" "$PREFIX/video/viewer/pathView2"
    fi

    say "3/5 sysctl (UDP receive buffers)"
    run install -m0644 "$REPO_ROOT/video/viewer/90-tsn5g-viewer.conf" /etc/sysctl.d/90-tsn5g-viewer.conf
    run sysctl -q --system

    say "4/5 units"
    local u
    for u in "${VIEWER_UNITS[@]}"; do
        render "$REPO_ROOT/video/viewer/$u.in" "/etc/systemd/system/$u"
    done
    run systemctl daemon-reload

    say "5/5 enable + start"
    run systemctl enable "${VIEWER_UNITS[@]}"
    if [ "$NO_START" = 1 ]; then echo "   --no-start: enabled for next boot"; return; fi
    run systemctl start tsn5g-viewer-display.service || warn "virtual screen did not start (journalctl -u tsn5g-viewer-display)"
    if pgrep -f 'bin/pathView2' >/dev/null && ! systemctl is-active -q tsn5g-viewer.service; then
        echo "   a viewer started by hand is running — left alone. Close it, then: sudo systemctl start tsn5g-viewer"
    else
        run systemctl restart tsn5g-viewer.service || warn "viewer did not start (journalctl -u tsn5g-viewer)"
    fi
    cat <<EOT

  Viewer installed. Watch it from your PC:
    ssh -L 5902:localhost:$VNC_PORT $VIEWER_USER@<this host>     then VNC to localhost:5902
  It listens on UDP $VIEWER_PORT_FIRST..$((VIEWER_PORT_FIRST + 6)) (camera 1 = $CAM1_PORT, camera 2 = $CAM2_PORT).
EOT
}

# viewer_config — pathView2's config.json: seven streams from VIEWER_PORT_FIRST
viewer_config() {
    local i sep=""
    printf '{\n    "streams": [\n'
    for i in 0 1 2 3 4 5 6; do
        printf '%s                { "id": %d, "nicid": 0, "ipaddress": "127.0.0.1", "port": %d, "imageStreamFifoLength" : 8192 }' \
            "$sep" $((1001 + i)) $((VIEWER_PORT_FIRST + i))
        sep=$',\n'
    done
    printf '\n            ],\n\n    "frameRefreshRate":  30, \n    "fifoMonitoringRate": 500 \n}\n'
}
