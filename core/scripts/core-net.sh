#!/bin/bash
# Host networking the core and gNB need, none of which survives a reboot by
# itself. Run by tsn5g-core-net.service at boot (and by srsran-gnb before each
# start for the X410 link).
#
#   core-net.sh up       everything below
#   core-net.sh x410     only the X410 link (MTU, address, UHD socket buffers)
#   core-net.sh status
#
#   ogstun   the UE pool's gateway (CORE_BEARER_IP) — the UPF's tun device
#   ogstap   tap device for Ethernet PDU sessions
#   NAT      UE pool -> CORE_LAN_IF, so the UE reaches the LAN/internet
#   X410     X410_HOST_IF: MTU X410_MTU (UHD needs jumbo frames), X410_HOST_IP
#
# On the first rig ip_forward and the MASQUERADE rule were runtime-only and
# were lost on every reboot (LESSONS.md); this makes them part of boot.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$(readlink -f "$0")")/site-env.sh"
: "${UE_POOL:?site.env not found}"

x410() {
    ip link set "$X410_HOST_IF" mtu "$X410_MTU"
    ip -br addr show "$X410_HOST_IF" | grep -qw "${X410_HOST_IP%%/*}" \
        || ip addr add "$X410_HOST_IP" dev "$X410_HOST_IF"
    ip link set "$X410_HOST_IF" up
    # UHD: large send buffer required, large receive buffer for 100 MHz
    sysctl -q -w net.core.wmem_max=25000000 net.core.rmem_max=50000000
}

up() {
    local plen=${UE_POOL#*/}
    if ! ip link show ogstun >/dev/null 2>&1; then
        ip tuntap add name ogstun mode tun
    fi
    ip -br addr show ogstun | grep -qw "$CORE_BEARER_IP" || ip addr add "$CORE_BEARER_IP/$plen" dev ogstun
    ip -6 addr show ogstun | grep -q "2001:db8:cafe::1" || ip addr add 2001:db8:cafe::1/48 dev ogstun
    ip link set ogstun up
    ip link show ogstap >/dev/null 2>&1 || ip tuntap add name ogstap mode tap
    ip link set ogstap up

    sysctl -q -w net.ipv4.ip_forward=1
    iptables -t nat -C POSTROUTING -s "$UE_POOL" -o "$CORE_LAN_IF" -j MASQUERADE 2>/dev/null \
        || iptables -t nat -A POSTROUTING -s "$UE_POOL" -o "$CORE_LAN_IF" -j MASQUERADE
    x410
}

status() {
    ip -br addr show ogstun ogstap "$X410_HOST_IF" 2>&1
    echo "ip_forward=$(cat /proc/sys/net/ipv4/ip_forward)  $X410_HOST_IF mtu=$(cat /sys/class/net/"$X410_HOST_IF"/mtu 2>/dev/null)"
    iptables -t nat -S POSTROUTING | grep -- "-s $UE_POOL" || echo "no MASQUERADE for $UE_POOL"
}

case "${1:-up}" in
    up) up ;;
    x410) x410 ;;
    status) status ;;
    *) echo "usage: $0 up|x410|status" >&2; exit 2 ;;
esac
