# install.sh core — the 5G core (Open5GS) and gNB (srsRAN + USRP X410).
# Sourced by install.sh (render.sh and site.env already loaded).
#
#   1 preflight        4 configs + keys      7 enable
#   2 code             5 system config       8 start + subscriber
#   3 build            6 units               9 checks
#
# Set SKIP_BUILD=1 to skip step 3 (e.g. re-rendering configs after editing site.env).

CORE_UNITS=(tsn5g-core-net.service open5gs.target open5gs-webui.service srsran-gnb.service tsn-health.timer)
O5GS_NFS="nrf scp ausf udm udr pcf nssf bsf amf smf upf tsn-af"

install_core() {
    require CORE_USER CORE_LAN_IP CORE_LAN_IF X410_ADDR X410_HOST_IF X410_HOST_IP X410_MTU \
            PLMN_MCC PLMN_MNC TAC DNN UE_POOL CORE_BEARER_IP GNB_DL_ARFCN GNB_SRATE \
            GNB_NUMA_NODE GNB_MAIN_CPUS GNB_RU_CPUS GNB_ISOLATED_CPUS SRSRAN_REPO SRSRAN_COMMIT \
            MONGODB_SERIES PREFIX ETC_DIR
    if [ "$REMOVE" = 1 ]; then die "--remove is not supported for core (stop it with: systemctl disable --now ${CORE_UNITS[*]})"; fi

    say "1/9 preflight"
    id "$CORE_USER" >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ] || die "CORE_USER=$CORE_USER does not exist on this machine"
    [ -e "/sys/class/net/$X410_HOST_IF" ] || warn "no NIC $X410_HOST_IF (X410_HOST_IF) — run core/scripts/x410-find-nic.sh"
    [ -e "/sys/class/net/$CORE_LAN_IF" ] || warn "no NIC $CORE_LAN_IF (CORE_LAN_IF)"
    if [ "$(cat /sys/devices/system/cpu/isolated 2>/dev/null)" != "$GNB_ISOLATED_CPUS" ]; then
        warn "real-time CPU isolation is not active (want $GNB_ISOLATED_CPUS) — the gNB will underflow."
        warn "  fix once:  sudo core/scripts/rt-grub.sh && sudo reboot     (docs/DEPLOY.md, real-time tuning)"
    fi
    local unmanaged
    unmanaged=$(pgrep -a '^open5gs-' 2>/dev/null | grep -v "$PREFIX/build/open5gs" || true)
    if [ -n "$unmanaged" ]; then
        warn "Open5GS processes started outside systemd are running (the old run5gs.sh):"
        echo "$unmanaged" | sed 's/^/      /' | cut -c1-120
        warn "  they will be stopped in step 8 so the systemd units can take over"
    fi

    say "2/9 code -> $PREFIX"
    run mkdir -p "$PREFIX" "$ETC_DIR" /var/log/tsn5g
    local d
    for d in core lib tools docs; do
        # The WebUI keeps its node_modules, .next and generated .env in the tree.
        run rsync -a --delete --exclude __pycache__ --exclude node_modules --exclude .next \
            --exclude /open5gs/src/webui/.env "$REPO_ROOT/$d/" "$PREFIX/$d/"
    done
    run install -m0644 "$REPO_ROOT/README.md" "$REPO_ROOT/site.env.example" "$PREFIX/"
    run install -m0644 "$SITE_FILE" "$ETC_DIR/site.env"
    if [ -f "$REPO_ROOT/secrets.env" ]; then
        run install -m0600 "$REPO_ROOT/secrets.env" "$ETC_DIR/secrets.env"
    else
        warn "no secrets.env — the subscriber will not be provisioned (secrets.env.example)"
    fi

    say "3/9 build (srsRAN, Open5GS, WebUI)"
    if [ "${SKIP_BUILD:-0}" = 1 ]; then
        echo "   SKIP_BUILD=1"
    else
        O5GS_SRC=$PREFIX/core/open5gs/src "$REPO_ROOT/core/build.sh" all
    fi

    say "4/9 configs -> $ETC_DIR"
    backup_if_changed "$ETC_DIR/gnb.yaml"
    render "$REPO_ROOT/core/gnb/gnb.yaml.in" "$ETC_DIR/gnb.yaml"
    local nf
    for nf in $O5GS_NFS; do
        render "$REPO_ROOT/core/open5gs/configs/$nf.yaml.in" "$ETC_DIR/open5gs/$nf.yaml"
    done
    hnet_keys "$ETC_DIR/open5gs/hnet"

    say "5/9 system config (sysctl, logrotate, no fwupd auto-refresh)"
    run install -m0644 "$REPO_ROOT/core/etc/90-tsn-udp.conf" /etc/sysctl.d/90-tsn-udp.conf
    run install -m0644 "$REPO_ROOT/core/etc/logrotate-tsn5g" /etc/logrotate.d/tsn5g
    run sysctl -q --system
    # fwupd's daily refresh stalled the PCIe bus and wedged the X410 stream on
    # the first rig (gnb.yaml, ru_sdr comments). Firmware updates stay manual.
    run systemctl disable --now fwupd-refresh.timer 2>/dev/null || true

    say "6/9 systemd units"
    local t
    for t in "$REPO_ROOT"/core/systemd/*.in; do
        render "$t" "/etc/systemd/system/$(basename "$t" .in)"
    done
    run install -m0644 "$REPO_ROOT/core/systemd/open5gs.target" "$REPO_ROOT/core/systemd/tsn-health.timer" /etc/systemd/system/
    run systemctl daemon-reload

    say "7/9 enable at boot: mongod ${CORE_UNITS[*]}"
    run systemctl enable mongod "${CORE_UNITS[@]}"

    if [ "$NO_START" = 1 ]; then
        say "8/9 --no-start: enabled, not started. Reboot, or: sudo systemctl start open5gs.target srsran-gnb"
        return
    fi
    say "8/9 start"
    # The health timer must not "repair" a core that is mid-start.
    run systemctl stop tsn-health.timer 2>/dev/null || true
    if [ -n "$unmanaged" ]; then
        local pid
        for pid in $(echo "$unmanaged" | awk '{print $1}'); do run kill "$pid" || true; done
        run sleep 3
    fi
    run systemctl start mongod
    run systemctl restart tsn5g-core-net.service
    run systemctl restart open5gs.target
    run systemctl restart open5gs-webui.service || warn "WebUI did not start (journalctl -u open5gs-webui)"
    if [ -f "$REPO_ROOT/secrets.env" ]; then
        local pargs=(); [ "$DRY_RUN" = 1 ] && pargs=(--dry-run)
        SITE_ENV=$SITE_FILE SECRETS_ENV=$REPO_ROOT/secrets.env \
            "$REPO_ROOT/core/open5gs/provision.sh" "${pargs[@]}" | tail -3 \
            || warn "subscriber not provisioned"
    fi
    run sleep 10    # SBI mesh + PFCP association before the gNB's NG Setup
    run systemctl restart srsran-gnb.service
    run systemctl start tsn-health.timer

    say "9/9 checks"
    core_checks
    core_summary
}

# hnet_keys DIR — the UDM's home-network keys for SUCI de-concealment. Per site,
# generated once, never committed. (The first rig's UDM pointed at keys that did
# not exist; harmless only while SIMs send SUCI with the null scheme.)
hnet_keys() {
    local dir=$1 i
    if [ "$DRY_RUN" = 1 ]; then echo "   would generate missing keys in $dir"; return; fi
    install -d -m0700 "$dir"
    for i in 1 3 5; do
        [ -f "$dir/curve25519-$i.key" ] || openssl genpkey -algorithm X25519 -out "$dir/curve25519-$i.key"
    done
    for i in 2 4 6; do
        [ -f "$dir/secp256r1-$i.key" ] || openssl ecparam -name prime256v1 -genkey -conv_form compressed -out "$dir/secp256r1-$i.key" 2>/dev/null
    done
    chmod 0600 "$dir"/*.key
    echo "   hnet keys present in $dir"
}

core_checks() {
    [ "$DRY_RUN" = 1 ] && { echo "   would check NFs, NRF, NGAP"; return; }
    local i nfs
    for i in $(seq 30); do
        nfs=$(systemctl list-units --no-legend --state=active 'open5gs@*' | wc -l)
        [ "$nfs" -ge 12 ] && ss -ltn | grep -q '127.0.0.10:7777' && break
        sleep 2
    done
    echo "   Open5GS NFs active: $nfs/12"
    for i in $(seq 30); do
        ss --sctp -an 2>/dev/null | grep -q 'ESTAB.*:38412' && break
        sleep 2
    done
    ss --sctp -an 2>/dev/null | grep -q 'ESTAB.*:38412' \
        && echo "   gNB attached to the AMF (NGAP up)" \
        || warn "gNB not attached yet — journalctl -u srsran-gnb -n 40; X410 reachable? ping $X410_ADDR"
}

core_summary() {
    cat <<EOF

  Core installed.
    Status      $PREFIX/core/scripts/open5gs-ctl.sh status
    Health      $PREFIX/core/scripts/tsn_health.sh      (judge the radio after ~2 minutes)
    WebUI       http://$CORE_LAN_IP:9999   (change the default admin password at first login)
    gNB config  $ETC_DIR/gnb.yaml          (from site.env — edit site.env and re-run, not this file)
    gNB log     /var/log/tsn5g/gnb.log
    Restart all $PREFIX/core/scripts/restart_all.sh

  Next: install the viewer (sudo ./install.sh viewer), then bring the UE up.
EOF
}
