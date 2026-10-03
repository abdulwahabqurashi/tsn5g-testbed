#!/bin/bash
# Run camera 2's encoder in its own network namespace.
#
# Why this exists
# ---------------
# pathStream1 opens EVERY camera Spinnaker enumerates, not just the one its
# `nicid` selects. Two instances therefore cannot coexist: the first claims both
# cameras' control channels and the second dies with
#
#   Spinnaker: Unable to set "DeviceAccessStatus" to Read/Write;
#   The camera may be open by another application. [-1005]
#
# There is no configuration route around it. The binary knows only `nicid`,
# `ipaddress` and `port`; it selects with CameraList::GetByIndex and has no
# serial-based or interface-filtering option.
#
# So the fix is to change what "every camera" means. A namespace containing only
# camera 2's NIC makes Spinnaker enumerate exactly one device, and the two
# encoders can no longer see — or claim — each other's camera.
#
# The encoder still has to reach the core, so a veth pair carries its UDP back
# into the root namespace and out over the bearer. The stream leaves wwan0 with
# the same destination port as before, so the existing lane classification
# applies unchanged.
#
# Usage:  sudo ./camera2-netns.sh up | ensure | down | status
#
#   ensure  is `up` made safe to repeat: a namespace that already holds the NIC
#           is left alone and reported ready. This is what the boot unit runs.

set -euo pipefail

NS=cam2
NIC=enp7s0                  # camera 2's interface
CAM_ADDR=169.254.143.1/24   # must match cameras: in the config
VETH_ROOT=veth-cam2
VETH_NS=veth-cam2p
ROOT_IP=10.200.2.1/30
NS_IP=10.200.2.2/30
NS_NET=10.200.2.0/30
BEARER=wwan0

die() { echo "error: $*" >&2; exit 1; }

up() {
    [ "$(id -u)" -eq 0 ] || die "must run as root"

    if ip netns list | grep -qw "$NS"; then
        echo "namespace $NS already exists — run '$0 down' first"; exit 1
    fi
    ip link show "$NIC" >/dev/null 2>&1 || \
        die "$NIC is not in the root namespace; it may already be moved"

    echo "creating namespace $NS"
    ip netns add "$NS"
    ip netns exec "$NS" ip link set lo up

    # Move the camera NIC in. It vanishes from the root namespace, which is the
    # whole point — the other encoder can no longer see this camera at all.
    echo "moving $NIC into $NS"
    ip link set "$NIC" netns "$NS"
    ip netns exec "$NS" ip addr add "$CAM_ADDR" dev "$NIC"
    ip netns exec "$NS" ip link set "$NIC" up

    # A path back out for the encoded stream.
    echo "linking $NS to the root namespace"
    ip link add "$VETH_ROOT" type veth peer name "$VETH_NS"
    ip link set "$VETH_NS" netns "$NS"
    ip addr add "$ROOT_IP" dev "$VETH_ROOT"
    ip link set "$VETH_ROOT" up
    ip netns exec "$NS" ip addr add "$NS_IP" dev "$VETH_NS"
    ip netns exec "$NS" ip link set "$VETH_NS" up
    ip netns exec "$NS" ip route add default via "${ROOT_IP%/*}"

    forwarding_rules

    echo
    echo "ready. camera 2's encoder now runs with:"
    echo "  sudo ip netns exec $NS sudo -u $SUDO_USER \\"
    echo "      env DISPLAY=\$DISPLAY XAUTHORITY=\$XAUTHORITY \\"
    echo "      /home/amrc/camera_application/U5G/x11/pathStream1/run.sh \\"
    echo "      camera2-besteffort.json"
    echo
    echo "note: $NIC has left the root namespace, so the tsn5g-ue daemon will"
    echo "      report camera2 unreachable. That is expected, not a fault."
}

forwarding_rules() {
    # Forward and translate, so the stream leaves on the bearer's address.
    # Checked before adding: iptables -A appends without noticing duplicates,
    # and these would otherwise stack up on every invocation.
    sysctl -q -w net.ipv4.ip_forward=1
    iptables -t nat -C POSTROUTING -s "$NS_NET" -o "$BEARER" -j MASQUERADE 2>/dev/null || \
        iptables -t nat -A POSTROUTING -s "$NS_NET" -o "$BEARER" -j MASQUERADE
    iptables -C FORWARD -i "$VETH_ROOT" -o "$BEARER" -j ACCEPT 2>/dev/null || \
        iptables -A FORWARD -i "$VETH_ROOT" -o "$BEARER" -j ACCEPT
    iptables -C FORWARD -i "$BEARER" -o "$VETH_ROOT" -m state \
        --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
        iptables -A FORWARD -i "$BEARER" -o "$VETH_ROOT" -m state \
        --state RELATED,ESTABLISHED -j ACCEPT
    # The bearer or nothing. While wwan0 is down its route to the core goes
    # with it, and camera 2's stream falls through to the default route — out
    # of the site LAN, with its private 10.200.2.2 source untranslated. Worse,
    # that first packet records the flow in conntrack as "no NAT", and the
    # record outlives the outage: when the bearer returns the stream keeps
    # leaving as 10.200.2.2 and the core drops every packet (seen 1 Oct, after
    # a daemon restart re-dialled the call). A packet dropped here is never
    # confirmed into conntrack, so no stale record can form. Inserted first so
    # no ACCEPT further down can pre-empt it.
    iptables -C FORWARD -i "$VETH_ROOT" ! -o "$BEARER" -j DROP 2>/dev/null || \
        iptables -I FORWARD 1 -i "$VETH_ROOT" ! -o "$BEARER" -j DROP
}

ensure() {
    [ "$(id -u)" -eq 0 ] || die "must run as root"
    # At boot the NIC may not have appeared yet. Wait for it in either place.
    local i
    for i in $(seq 30); do
        ip link show "$NIC" >/dev/null 2>&1 && break
        ip netns exec "$NS" ip link show "$NIC" >/dev/null 2>&1 && break
        [ "$i" -eq 1 ] && echo "waiting for $NIC to appear"
        sleep 1
    done
    if ip netns list | grep -qw "$NS"; then
        if ip netns exec "$NS" ip link show "$NIC" >/dev/null 2>&1; then
            forwarding_rules
            echo "namespace $NS already holds $NIC — forwarding rules checked"
            return 0
        fi
        die "namespace $NS exists but $NIC is not in it — run '$0 down' and retry"
    fi
    up
}

down() {
    [ "$(id -u)" -eq 0 ] || die "must run as root"
    echo "removing namespace $NS (this returns $NIC to the root namespace)"
    ip netns del "$NS" 2>/dev/null || true
    ip link del "$VETH_ROOT" 2>/dev/null || true
    iptables -t nat -D POSTROUTING -s "$NS_NET" -o "$BEARER" -j MASQUERADE 2>/dev/null || true
    iptables -D FORWARD -i "$VETH_ROOT" -o "$BEARER" -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -i "$BEARER" -o "$VETH_ROOT" -m state \
        --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -i "$VETH_ROOT" ! -o "$BEARER" -j DROP 2>/dev/null || true
    sleep 1
    # The NIC comes back without its address; the daemon re-applies it on its
    # next start, or do it by hand.
    ip link show "$NIC" >/dev/null 2>&1 && echo "$NIC is back in the root namespace" \
        || echo "warning: $NIC has not reappeared — check 'ip netns list'"
}

status() {
    echo "namespace:"
    ip netns list | grep -w "$NS" || echo "  $NS does not exist"
    echo "interfaces inside it:"
    ip netns exec "$NS" ip -br addr 2>/dev/null | sed 's/^/  /' || echo "  n/a"
    echo "root side:"
    ip -br addr show "$VETH_ROOT" 2>/dev/null | sed 's/^/  /' || echo "  $VETH_ROOT absent"
    echo "can the namespace reach the core?"
    ip netns exec "$NS" ping -c1 -W2 10.45.0.1 >/dev/null 2>&1 \
        && echo "  yes" || echo "  NO — check forwarding and the NAT rule"
}

case "${1:-}" in
    up) up ;;
    ensure) ensure ;;
    down) down ;;
    status) status ;;
    *) echo "usage: $0 up|ensure|down|status" >&2; exit 2 ;;
esac
