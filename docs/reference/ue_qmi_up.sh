#!/bin/bash
#
# ue_qmi_up.sh - bring up the QMI data call on a Quectel RM520 and put the
#                network-assigned IP onto wwan0.
#
# RUN THIS ON THE UE HOST (the DI-1200), NOT on amrctsnserver.
#
# Why this is needed: with AT+CGACT the PDU session exists inside the *modem's*
# IP stack - AT+CGPADDR shows the address and the core can ping it - but wwan0
# is a raw-IP qmi_wwan interface with no DHCP server behind it, so the host
# never learns the address. Only a QMI data call over /dev/cdc-wdm0 populates
# wwan0. (Confirmed on this module: AT+QCFG="usbnet" -> 0 = QMI.)
#
# Usage:
#   sudo ./ue_qmi_up.sh up                 # start the call, configure wwan0
#   sudo ./ue_qmi_up.sh up --default-route # ...and route ALL traffic via wwan0
#   sudo ./ue_qmi_up.sh up --dns           # ...and write DNS to /etc/resolv.conf
#   sudo ./ue_qmi_up.sh status
#   sudo ./ue_qmi_up.sh down
#
# Defaults match this testbed: APN usrptsn, IPv4-only (the subscriber profile
# is PDU type 1), core-side gateway 10.45.0.1 on ogstun.

APN="${APN:-usrptsn}"
IFACE="${IFACE:-wwan0}"
QMI_DEV="${QMI_DEV:-}"
UE_SUBNET="${UE_SUBNET:-10.45.0.0/16}"   # the SMF pool, reachable via wwan0
STATE=/run/ue_qmi_up.state

ACTION="${1:-up}"; shift 2>/dev/null
WANT_DEFAULT=0; WANT_DNS=0
for a in "$@"; do
    case "$a" in
        --default-route) WANT_DEFAULT=1 ;;
        --dns)           WANT_DNS=1 ;;
        *) echo "unknown option: $a" >&2; exit 2 ;;
    esac
done

if [ -t 1 ]; then R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; B=$'\033[1m'; N=$'\033[0m'
else R=; G=; Y=; B=; N=; fi
ok()   { echo "  ${G}ok${N}   $*"; }
warn() { echo "  ${Y}warn${N} $*"; }
die()  { echo "  ${R}fail${N} $*" >&2; exit 1; }
step() { echo "${B}$*${N}"; }

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"
command -v qmicli >/dev/null || die "qmicli not found - install it: sudo apt install -y libqmi-utils"

# Locate the QMI control device if not pinned by the environment.
if [ -z "$QMI_DEV" ]; then
    QMI_DEV=$(ls /dev/cdc-wdm* 2>/dev/null | head -1)
    [ -n "$QMI_DEV" ] || die "no /dev/cdc-wdm* found - is the module in QMI mode and the qmi_wwan driver loaded?"
fi
Q="qmicli -d $QMI_DEV --device-open-proxy"

# ------------------------------------------------------------------- status
show_status() {
    step "QMI / $IFACE status"
    echo "  control device : $QMI_DEV"
    local drv; drv=$(basename "$(readlink -f "/sys/class/net/$IFACE/device/driver" 2>/dev/null)" 2>/dev/null)
    echo "  driver         : ${drv:-unknown}"
    echo "  raw_ip         : $(cat "/sys/class/net/$IFACE/qmi/raw_ip" 2>/dev/null || echo n/a)"
    echo "  operstate      : $(cat "/sys/class/net/$IFACE/operstate" 2>/dev/null || echo n/a)"
    echo "  address        : $(ip -br -4 addr show "$IFACE" 2>/dev/null | awk '{print $3}')"
    [ -f "$STATE" ] && { . "$STATE"; echo "  data handle    : ${PDH:-none} (cid ${CID:-none})"; }
    echo
    $Q --wds-get-packet-service-status 2>/dev/null | sed 's/^/  /'
}

# --------------------------------------------------------------------- down
bring_down() {
    step "Stopping the QMI data call"
    if [ -f "$STATE" ]; then
        . "$STATE"
        if [ -n "$PDH" ] && [ -n "$CID" ]; then
            $Q --wds-stop-network="$PDH" --client-cid="$CID" >/dev/null 2>&1 \
                && ok "data call stopped (handle $PDH)" || warn "stop-network reported an error"
        fi
        rm -f "$STATE"
    else
        warn "no saved handle - nothing to stop cleanly"
    fi
    ip addr flush dev "$IFACE" 2>/dev/null
    ip link set "$IFACE" down 2>/dev/null
    ok "$IFACE down and flushed"
}

# ---------------------------------------------------------------- pre-flight
# The data call can only start if the modem is ALREADY camped on a cell. Without
# this check, --wds-start-network fails two steps later with a generic
# "no packet data handle returned", which hides the real cause.
preflight() {
    step "pre-flight checks"

    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ModemManager; then
        warn "ModemManager is running - it competes for this modem"
        warn "  stop it first:  sudo systemctl stop ModemManager"
    fi

    local om
    om=$($Q --dms-get-operating-mode 2>/dev/null | sed -n "s/.*Mode: *'\([^']*\)'.*/\1/p" | head -1)
    case "$om" in
        online) ok "operating mode: online" ;;
        "")     warn "could not read the operating mode from $QMI_DEV" ;;
        *)      die "operating mode is '$om', not 'online' - the radio is off.
       turn it on with:
         qmicli -d $QMI_DEV --device-open-proxy --dms-set-operating-mode=online" ;;
    esac

    local ss reg plmn
    ss=$($Q --nas-get-serving-system 2>/dev/null)
    reg=$(printf '%s\n' "$ss" | sed -n "s/.*Registration state: *'\([^']*\)'.*/\1/p" | head -1)
    case "$reg" in
        registered)
            plmn=$(printf '%s\n' "$ss" | sed -n "s/.*Description: *'\([^']*\)'.*/\1/p" | head -1)
            ok "registered${plmn:+ on $plmn}"
            ;;
        "") warn "could not read the registration state - continuing anyway" ;;
        *)  die "modem is NOT registered (state: '$reg') - there is no cell to attach to.
       The data call cannot start until the UE camps on the gNB. Check:
         - the gNB is transmitting on n78 with PLMN 00102
         - the antennas are seated on the MAIN/DIV connectors
         - AT+QENG=\"servingcell\" on the AT port (ttyUSB2 on this boot, NOT ttyUSB4)
         - qmicli -d $QMI_DEV --device-open-proxy --nas-get-signal-info" ;;
    esac
}

# ----------------------------------------------------------------------- up
bring_up() {
    preflight

    step "1/5  preparing $IFACE (raw-IP mode)"
    ip link set "$IFACE" down 2>/dev/null
    if [ -e "/sys/class/net/$IFACE/qmi/raw_ip" ]; then
        # must be written while the interface is down
        echo Y > "/sys/class/net/$IFACE/qmi/raw_ip" 2>/dev/null \
            && ok "raw_ip = Y" || warn "could not set raw_ip (may already be fixed by the driver)"
    else
        warn "no raw_ip attribute - older qmi_wwan; continuing"
    fi
    ip link set "$IFACE" up || die "could not bring $IFACE up"
    ok "$IFACE up"

    step "2/5  starting the data call (apn=$APN, ipv4)"
    # --client-no-release-cid is REQUIRED: without it qmicli releases the client
    # on exit and the data call collapses the instant this script returns.
    local out
    out=$($Q --wds-start-network="apn=$APN,ip-type=4" --client-no-release-cid 2>&1)
    echo "$out" | sed 's/^/    /'
    local pdh cid
    pdh=$(printf '%s\n' "$out" | sed -n "s/.*[Pp]acket data handle: *'\{0,1\}\([0-9]*\)'\{0,1\}.*/\1/p" | head -1)
    cid=$(printf '%s\n' "$out" | sed -n "s/.*CID: *'\{0,1\}\([0-9]*\)'\{0,1\}.*/\1/p" | head -1)
    [ -n "$pdh" ] || die "no packet data handle returned - the call did not start (see output above)"
    printf 'PDH=%s\nCID=%s\n' "$pdh" "$cid" > "$STATE"
    ok "data call up (handle $pdh, cid ${cid:-?})"

    step "3/5  reading the network-assigned settings"
    local s; s=$($Q --wds-get-current-settings 2>&1)
    echo "$s" | sed 's/^/    /'
    get() { printf '%s\n' "$s" | sed -n "s/^[[:space:]]*$1:[[:space:]]*//p" | head -1; }
    local ip gw dns1 dns2 mtu
    ip=$(get "IPv4 address"); gw=$(get "IPv4 gateway address")
    dns1=$(get "IPv4 primary DNS"); dns2=$(get "IPv4 secondary DNS"); mtu=$(get "MTU")
    [ -n "$ip" ] || die "no IPv4 address in the settings - the call started but the bearer has no address"

    step "4/5  configuring $IFACE"
    ip addr flush dev "$IFACE" 2>/dev/null
    # raw-IP needs a /32 plus explicit routes; there is no on-link subnet here.
    ip addr add "$ip/32" dev "$IFACE" || die "could not add $ip to $IFACE"
    ok "address $ip/32"
    [ -n "$mtu" ] && [ "$mtu" -gt 0 ] 2>/dev/null && { ip link set "$IFACE" mtu "$mtu"; ok "mtu $mtu"; }
    if [ -n "$gw" ]; then
        ip route replace "$gw/32" dev "$IFACE" 2>/dev/null
        ok "gateway $gw on-link"
    fi
    # Reach the core's UE pool without touching the host's existing default route.
    ip route replace "$UE_SUBNET" dev "$IFACE" 2>/dev/null && ok "route $UE_SUBNET via $IFACE"

    if [ "$WANT_DEFAULT" = 1 ]; then
        ip route replace default dev "$IFACE" metric 100 && warn "DEFAULT ROUTE now via $IFACE - all traffic goes over the 5G link"
    else
        echo "    (default route left alone; pass --default-route to send all traffic via $IFACE)"
    fi
    if [ "$WANT_DNS" = 1 ] && [ -n "$dns1" ]; then
        printf 'nameserver %s\n' "$dns1" > /etc/resolv.conf
        [ -n "$dns2" ] && printf 'nameserver %s\n' "$dns2" >> /etc/resolv.conf
        warn "/etc/resolv.conf overwritten with $dns1 ${dns2}"
    fi

    step "5/5  verifying"
    ip -br addr show "$IFACE"
    if [ -n "$gw" ]; then
        if ping -I "$IFACE" -c3 -W3 "$gw" >/dev/null 2>&1; then
            ok "ping $gw via $IFACE - DATA PLANE UP"
        else
            warn "cannot ping $gw yet - the UE may be in RRC idle; retry, or check the core"
        fi
    fi
}

case "$ACTION" in
    up)     bring_up; echo; show_status ;;
    down)   bring_down ;;
    status) show_status ;;
    *) sed -n '2,26p' "$0"; exit 2 ;;
esac
