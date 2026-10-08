#!/bin/bash
# NW-TT on the core: the far end of the UE's camera tunnels.
#
#   nw-tt.sh up       build the endpoints (idempotent)
#   nw-tt.sh down     remove them
#   nw-tt.sh status   devices, learned UE tunnel ends, and per-VLAN traffic
#
# The UE (ue/tsn5g_ue/net/campath.py, Cameras -> Video path -> VLAN + VXLAN)
# sends each camera as VLAN-tagged Ethernet in its own VXLAN tunnel to
# CORE_BEARER_IP:4789:
#
#   camera 1   VNI 70, VLAN 70, PCP 4   UE 10.70.0.2  ->  video server 10.70.0.1
#   camera 2   VNI 80, VLAN 80, PCP 0   UE 10.80.0.2  ->  video server 10.80.0.1
#
# Here each tunnel ends in a VXLAN device on the UE pool's gateway (ogstun),
# with a VLAN device on top that carries the video server's address for that
# VLAN. The UE's address changes with every data call, so the tunnels have no
# fixed remote: they learn the UE's end from the first packet it sends.
#
#   ogstun ─ nwtt-vx70 (VXLAN 70) ─ nwtt70 (VLAN 70, 10.70.0.1/24) ─ video server
#          └ nwtt-vx80 (VXLAN 80) ─ nwtt80 (VLAN 80, 10.80.0.1/24) ─┘
#
# To hand a VLAN to a separate video server or a TSN switch instead, bridge
# the VXLAN device with a physical port rather than terminating it here
# (see core/vxlan/README.md).
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$(readlink -f "$0")")/site-env.sh" 2>/dev/null || true
LOCAL=${CORE_BEARER_IP:-10.45.0.1}
PORT=${NWTT_VXLAN_PORT:-4789}
UNDERLAY=${NWTT_UNDERLAY:-ogstun}
BEARER_MTU=${NWTT_BEARER_MTU:-1400}
# vni vlan server-address/prefix
TUNNELS=${NWTT_TUNNELS:-"70 70 10.70.0.1/24
80 80 10.80.0.1/24"}
VX_MTU=$((BEARER_MTU - 36))          # outer IP 20 + UDP 8 + VXLAN 8
IN_MTU=$((VX_MTU - 18))              # inner Ethernet 14 + 802.1Q 4

up() {
    while read -r vni vlan addr; do
        [ -n "$vni" ] || continue
        vx=nwtt-vx$vni; vl=nwtt$vlan
        if ! ip link show "$vx" >/dev/null 2>&1; then
            ip link add "$vx" type vxlan id "$vni" local "$LOCAL" dstport "$PORT" dev "$UNDERLAY" learning
        fi
        ip link set "$vx" mtu "$VX_MTU" up
        ip link show "$vl" >/dev/null 2>&1 || ip link add link "$vx" name "$vl" type vlan id "$vlan"
        ip link set "$vl" mtu "$IN_MTU" up
        ip -br addr show "$vl" | grep -qw "${addr%/*}" || ip addr add "$addr" dev "$vl"
        echo "$vx: VXLAN $vni on $UNDERLAY $LOCAL:$PORT -> $vl VLAN $vlan $addr (mtu $IN_MTU)"
    done <<< "$TUNNELS"
    # the UE's tunnels arrive on the UE pool's gateway
    iptables -C INPUT -i "$UNDERLAY" -p udp --dport "$PORT" -j ACCEPT 2>/dev/null \
        || iptables -I INPUT -i "$UNDERLAY" -p udp --dport "$PORT" -j ACCEPT
}

down() {
    while read -r vni vlan addr; do
        [ -n "$vni" ] || continue
        ip link del "nwtt$vlan" 2>/dev/null || true
        ip link del "nwtt-vx$vni" 2>/dev/null || true
    done <<< "$TUNNELS"
    while iptables -D INPUT -i "$UNDERLAY" -p udp --dport "$PORT" -j ACCEPT 2>/dev/null; do :; done
    echo "NW-TT endpoints removed"
}

status() {
    while read -r vni vlan addr; do
        [ -n "$vni" ] || continue
        vx=nwtt-vx$vni; vl=nwtt$vlan
        if ! ip link show "$vx" >/dev/null 2>&1; then echo "$vx: missing"; continue; fi
        ue=$(bridge fdb show dev "$vx" 2>/dev/null | awk '/dst/{for(i=1;i<=NF;i++) if($i=="dst") print $(i+1)}' | sort -u | tr '\n' ' ')
        rx=$(cat "/sys/class/net/$vl/statistics/rx_packets" 2>/dev/null || echo 0)
        echo "$vx VLAN $vlan $(ip -br addr show "$vl" | awk '{print $3}')  UE end: ${ue:-not learned yet}  rx packets: $rx"
    done <<< "$TUNNELS"
}

case "${1:-status}" in
    up) up ;;
    down) down ;;
    status) status ;;
    *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
