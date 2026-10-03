# install.sh ue — the UE: modem, cameras, encoders, daemon + web UI.
# Sourced by install.sh (render.sh and site.env already loaded).
#
# Steps, each safe to repeat:
#   1 packages        5 config + units     9 start + health check
#   2 ModemManager    6 sudoers + polkit
#   3 system config   7 encoder bundle
#   4 code            8 enable units

UE_UNITS=(tsn5g-cam2-netns.service tsn5g-ue.service tsn5g-vnc-display.service tsn5g-cameras.service)

install_ue() {
    require UE_USER CAM1_IF CAM2_IF CAM2_NETNS MODEM_WWAN CORE_BEARER_IP DNN \
            API_PORT DISPLAY_NUM PREFIX ETC_DIR VENDOR_DIR
    if [ "$REMOVE" = 1 ]; then ue_remove; return; fi
    id "$UE_USER" >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ] || die "UE_USER=$UE_USER does not exist on this machine"

    say "1/9 packages"
    # All from Ubuntu's archive. Deliberately not pip: 24.04 marks the system
    # interpreter externally-managed and the daemon runs on it.
    apt_install python3 python3-yaml python3-serial python3-paramiko \
        iproute2 iptables ethtool conntrack tcpdump libqmi-utils iperf3 linuxptp \
        xvfb x11vnc openbox x11-utils curl gettext-base rsync $QT_RUNTIME_PKGS

    say "2/9 ModemManager"
    # It and the daemon both want the modem's AT port; it rewrites radio
    # settings underneath you. Stopping is not enough (D-Bus restarts it).
    if systemctl list-unit-files ModemManager.service >/dev/null 2>&1; then
        run systemctl mask --now ModemManager.service
    else
        echo "   not installed"
    fi

    say "3/9 system config (camera NICs unmanaged, sysctl)"
    render "$REPO_ROOT/ue/templates/etc/99-tsn-cameras.conf.in" /etc/NetworkManager/conf.d/99-tsn-cameras.conf
    render "$REPO_ROOT/ue/templates/etc/90-tsn5g-ue.conf.in" /etc/sysctl.d/90-tsn5g-ue.conf
    run sysctl -q --system
    systemctl is-active -q NetworkManager 2>/dev/null && run systemctl reload NetworkManager || true

    say "4/9 code -> $PREFIX"
    # Root-owned on purpose: sudoers grants NOPASSWD on tools under $PREFIX,
    # which is only safe if the user cannot rewrite them.
    run mkdir -p "$PREFIX" "$ETC_DIR"
    local d
    for d in ue lib tools docs; do
        run rsync -a --delete --exclude __pycache__ "$REPO_ROOT/$d/" "$PREFIX/$d/"
    done
    run install -m0644 "$REPO_ROOT/README.md" "$REPO_ROOT/site.env.example" "$PREFIX/"
    run install -m0644 "$SITE_FILE" "$ETC_DIR/site.env"
    run chown -R root:root "$PREFIX/ue" "$PREFIX/lib" "$PREFIX/tools" "$PREFIX/docs"

    say "5/9 daemon config + systemd units"
    backup_if_changed "$ETC_DIR/tsn5g-ue.yaml"
    render "$REPO_ROOT/ue/templates/tsn5g-ue.yaml.in" "$ETC_DIR/tsn5g-ue.yaml"
    local u
    for u in "${UE_UNITS[@]}" tsn5g-ue-kiosk.service; do
        render "$REPO_ROOT/ue/templates/systemd/$u.in" "/etc/systemd/system/$u"
    done
    run systemctl daemon-reload

    say "6/9 sudoers + polkit (passwordless control for $UE_USER)"
    install_sudoers "$REPO_ROOT/ue/templates/etc/tsn5g-ue.sudoers.in" /etc/sudoers.d/tsn5g-ue
    render "$REPO_ROOT/ue/templates/etc/10-tsn5g-ue.rules.in" /etc/polkit-1/rules.d/10-tsn5g-ue.rules

    say "7/9 camera encoder bundle"
    install_bundle pathStream1 "$PREFIX/video/encoder" && {
        local enc=$PREFIX/video/encoder/pathStream1
        run install -m0755 "$REPO_ROOT/video/encoder/run.sh" "$enc/run.sh"
        render "$REPO_ROOT/video/encoder/camera1.json.in" "$enc/camera1-protected.json"
        render "$REPO_ROOT/video/encoder/camera2.json.in" "$enc/camera2-besteffort.json"
        # The encoder runs as the desktop user and keeps its settings beside itself.
        run chown -R "$UE_USER:" "$enc"
    }

    say "8/9 enable at boot: ${UE_UNITS[*]}"
    run systemctl enable "${UE_UNITS[@]}"

    if [ "$NO_START" = 1 ]; then
        say "9/9 --no-start: enabled, not started. Reboot or: sudo systemctl start ${UE_UNITS[*]}"
        return
    fi
    say "9/9 start + health check"
    run systemctl restart tsn5g-cam2-netns.service || warn "camera 2 namespace did not come up — is $CAM2_IF present? (journalctl -u tsn5g-cam2-netns)"
    run systemctl restart tsn5g-ue.service
    run systemctl start tsn5g-vnc-display.service || warn "virtual screen did not start (journalctl -u tsn5g-vnc-display)"
    if [ ! -x "$PREFIX/video/encoder/pathStream1/run.sh" ] && [ "$DRY_RUN" != 1 ]; then
        warn "no encoder bundle: cameras not started (see step 7)"
    elif pgrep -f bin/pathStream1 >/dev/null && [ "$START_CAMERAS" != 1 ]; then
        echo "   encoders already running — left alone (--start-cameras hands them to systemd)"
    else
        run systemctl restart tsn5g-cameras.service || warn "encoders did not start (journalctl -u tsn5g-cameras)"
    fi
    wait_health "http://127.0.0.1:$API_PORT/api/health" tsn5g-ue
    ue_summary
}

ue_remove() {
    say "removing UE units (code in $PREFIX, config in $ETC_DIR and data in /var/lib/tsn5g-ue are kept)"
    local u
    for u in tsn5g-cameras.service tsn5g-vnc-display.service tsn5g-ue.service \
             tsn5g-cam2-netns.service tsn5g-ue-kiosk.service; do
        run systemctl disable --now "$u" 2>/dev/null || true
        run rm -f "/etc/systemd/system/$u"
    done
    run rm -f /etc/sudoers.d/tsn5g-ue /etc/polkit-1/rules.d/10-tsn5g-ue.rules
    run systemctl daemon-reload
    echo "   ModemManager stays masked; 'sudo systemctl unmask ModemManager' to undo"
}

ue_summary() {
    local ip; ip=${UE_LAN_IP:-$(hostname -I | awk '{print $1}')}
    cat <<EOF

  UE installed.
    Web UI      http://$ip:$API_PORT/
    Config      $ETC_DIR/tsn5g-ue.yaml   (from site.env — edit site.env and re-run, not this file)
    Encoders    screen :$DISPLAY_NUM — see it with:  ssh -L 5901:localhost:${VNC_PORT:-5900} $UE_USER@$ip  then VNC to localhost:5901
    Logs        journalctl -u tsn5g-ue -f
    Tools       $PREFIX/tools/  (demo-run.sh, camera-loss-check.sh, ...)

  Next: in the UI, Connection -> Bring up; then $PREFIX/tools/camera-loss-check.sh
EOF
}
