#!/usr/bin/env python3
"""
5G-TSN Bridge Traffic Test
==========================
Creates TWO veth pairs on opposite sides of the TSN bridge
and verifies Ethernet frame forwarding between them.

  [veth-src] ---- [veth-src-br] ==== BRIDGE ==== [veth-dst-br] ---- [veth-dst]
   (sender)        (in bridge)                    (in bridge)        (receiver)

This avoids the TAP fd ownership issue (TSN-AF owns tsn-tap-1).

Usage: sudo /home/mahim/open5gs-main/.venv/bin/python3 tools/test-bridge.py

Requires: scapy, root privileges
"""

import sys
import os
import time
import subprocess
import signal

# Add venv site-packages so sudo can find scapy
sys.path.insert(0, '/home/mahim/open5gs-main/.venv/lib/python3.12/site-packages')

from scapy.all import (
    Ether, IP, UDP, TCP, ICMP, ARP, Dot1Q, Raw,
    sendp, sniff, conf, get_if_hwaddr
)

BRIDGE = "tsn-br-1"

# Sender side (simulates TSN end station A)
VETH_SRC = "veth-src"         # outside bridge - we send from here
VETH_SRC_BR = "veth-src-br"   # inside bridge

# Receiver side (simulates TSN end station B)
VETH_DST = "veth-dst"         # outside bridge - we sniff here
VETH_DST_BR = "veth-dst-br"   # inside bridge

# Colors
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


def run(cmd):
    """Run a shell command, return (rc, stdout)."""
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


def setup():
    """Create two veth pairs, attach to bridge, enable gPTP/LLDP forwarding."""
    print(f"{CYAN}[SETUP] Creating veth pairs...{RESET}")

    # Clean up any existing
    run(f"ip link del {VETH_SRC} 2>/dev/null")
    run(f"ip link del {VETH_DST} 2>/dev/null")
    time.sleep(0.3)

    # Create sender veth pair
    rc, _ = run(f"ip link add {VETH_SRC} type veth peer name {VETH_SRC_BR}")
    if rc != 0:
        print(f"{RED}Failed to create veth pair. Are you running as root?{RESET}")
        sys.exit(1)

    # Create receiver veth pair
    rc, _ = run(f"ip link add {VETH_DST} type veth peer name {VETH_DST_BR}")
    if rc != 0:
        print(f"{RED}Failed to create receiver veth pair.{RESET}")
        sys.exit(1)

    # Attach bridge-side ends to the bridge
    run(f"ip link set {VETH_SRC_BR} master {BRIDGE}")
    run(f"ip link set {VETH_DST_BR} master {BRIDGE}")

    # Bring everything up
    for iface in [VETH_SRC, VETH_SRC_BR, VETH_DST, VETH_DST_BR]:
        run(f"ip link set {iface} up")

    # Assign IPs for L3 tests
    run(f"ip addr add 10.100.0.1/24 dev {VETH_SRC}")
    run(f"ip addr add 10.100.0.2/24 dev {VETH_DST}")

    # Enable forwarding of IEEE reserved multicast (gPTP, LLDP)
    # group_fwd_mask bit 14 = LLDP (01:80:c2:00:00:0e)
    # We set 0x4000 to allow LLDP, and the bridge will also forward gPTP
    # since gPTP uses the same multicast group
    run(f"echo 16384 > /sys/class/net/{BRIDGE}/bridge/group_fwd_mask")

    time.sleep(0.5)

    # Verify
    rc, out = run(f"brctl show {BRIDGE}")
    print(f"{CYAN}[SETUP] Bridge state:{RESET}")
    for line in out.split('\n'):
        print(f"  {line}")

    # Show MACs
    src_mac = get_mac(VETH_SRC)
    dst_mac = get_mac(VETH_DST)
    print(f"\n  Sender  ({VETH_SRC}): {src_mac} / 10.100.0.1")
    print(f"  Receiver({VETH_DST}): {dst_mac} / 10.100.0.2")
    print()


def cleanup():
    """Remove veth pairs."""
    print(f"\n{CYAN}[CLEANUP] Removing test interfaces...{RESET}")
    run(f"ip link del {VETH_SRC} 2>/dev/null")
    run(f"ip link del {VETH_DST} 2>/dev/null")
    print(f"{CYAN}[CLEANUP] Done.{RESET}")


def get_mac(iface):
    """Get MAC address of interface."""
    try:
        return get_if_hwaddr(iface)
    except Exception:
        rc, out = run(f"cat /sys/class/net/{iface}/address")
        return out if rc == 0 else "00:00:00:00:00:00"


def test_result(name, passed, detail=""):
    """Print test result."""
    status = f"{GREEN}PASS{RESET}" if passed else f"{RED}FAIL{RESET}"
    d = f" - {detail}" if detail else ""
    print(f"  [{status}] {name}{d}")
    return passed


# ──────────────────────────────────────────
# Test 1: Basic Ethernet frame forwarding
# ──────────────────────────────────────────
def test_basic_ethernet():
    """Send a raw Ethernet frame from sender and receive on receiver."""
    print(f"\n{BOLD}Test 1: Basic Ethernet Frame Forwarding{RESET}")

    src_mac = get_mac(VETH_SRC)
    dst_mac = get_mac(VETH_DST)

    pkt = Ether(src=src_mac, dst=dst_mac, type=0x8899) / Raw(b"HELLO_TSN_BRIDGE")

    captured = []

    def capture_cb(p):
        if Raw in p and b"HELLO_TSN_BRIDGE" in bytes(p[Raw]):
            captured.append(p)

    sniff(
        iface=VETH_DST, prn=capture_cb, timeout=2,
        started_callback=lambda: sendp(pkt, iface=VETH_SRC, count=3, inter=0.1, verbose=False),
        store=False
    )

    return test_result(
        "Raw Ethernet frame crosses bridge",
        len(captured) > 0,
        f"{len(captured)} frames received on {VETH_DST}"
    )


# ──────────────────────────────────────────
# Test 2: Broadcast frame flooding
# ──────────────────────────────────────────
def test_broadcast():
    """Send a broadcast frame and verify it's flooded."""
    print(f"\n{BOLD}Test 2: Broadcast Frame Flooding{RESET}")

    src_mac = get_mac(VETH_SRC)
    pkt = Ether(src=src_mac, dst="ff:ff:ff:ff:ff:ff", type=0x8899) / Raw(b"BCAST_TEST")

    captured = []

    def capture_cb(p):
        if Raw in p and b"BCAST_TEST" in bytes(p[Raw]):
            captured.append(p)

    sniff(
        iface=VETH_DST, prn=capture_cb, timeout=2,
        started_callback=lambda: sendp(pkt, iface=VETH_SRC, count=3, inter=0.1, verbose=False),
        store=False
    )

    return test_result(
        "Broadcast flooded to receiver",
        len(captured) > 0,
        f"{len(captured)} broadcast frames"
    )


# ──────────────────────────────────────────
# Test 3: VLAN-tagged frames (802.1Q)
# ──────────────────────────────────────────
def test_vlan():
    """Send 802.1Q tagged frames with different PCP values."""
    print(f"\n{BOLD}Test 3: VLAN-Tagged Frames (802.1Q){RESET}")

    src_mac = get_mac(VETH_SRC)
    dst_mac = get_mac(VETH_DST)

    results = []
    for pcp in [0, 3, 5, 7]:
        tag = f"PCP{pcp}_TEST"
        pkt = (
            Ether(src=src_mac, dst=dst_mac) /
            Dot1Q(vlan=100, prio=pcp) /
            Raw(tag.encode())
        )

        captured = []

        def capture_cb(p, t=tag):
            if Raw in p and t.encode() in bytes(p[Raw]):
                captured.append(p)

        sniff(
            iface=VETH_DST, prn=capture_cb, timeout=1,
            started_callback=lambda pkt=pkt: sendp(pkt, iface=VETH_SRC, count=2, inter=0.1, verbose=False),
            store=False
        )

        ok = len(captured) > 0
        results.append(ok)
        test_result(f"VLAN 100, PCP {pcp}", ok, f"{len(captured)} frames")

    return all(results)


# ──────────────────────────────────────────
# Test 4: ARP (L3 reachability across bridge)
# ──────────────────────────────────────────
def test_arp():
    """Send ARP request from sender, expect reply from receiver's IP."""
    print(f"\n{BOLD}Test 4: ARP Resolution Across Bridge{RESET}")

    src_mac = get_mac(VETH_SRC)
    pkt = (
        Ether(src=src_mac, dst="ff:ff:ff:ff:ff:ff") /
        ARP(op="who-has", psrc="10.100.0.1", pdst="10.100.0.2",
            hwsrc=src_mac)
    )

    captured = []

    def capture_cb(p):
        if ARP in p and p[ARP].op == 2:  # ARP reply
            captured.append(p)

    sniff(
        iface=VETH_SRC, prn=capture_cb, timeout=3,
        started_callback=lambda: sendp(pkt, iface=VETH_SRC, count=3, inter=0.3, verbose=False),
        store=False
    )

    return test_result(
        "ARP reply received from 10.100.0.2",
        len(captured) > 0,
        f"{len(captured)} ARP replies"
    )


# ──────────────────────────────────────────
# Test 5: UDP traffic (simulated TSN data)
# ──────────────────────────────────────────
def test_udp_traffic():
    """Send UDP burst simulating TSN application traffic."""
    print(f"\n{BOLD}Test 5: UDP Traffic (Simulated TSN Data Stream){RESET}")

    src_mac = get_mac(VETH_SRC)
    dst_mac = get_mac(VETH_DST)

    frames_to_send = 50
    captured = []

    pkts = []
    for i in range(frames_to_send):
        pkt = (
            Ether(src=src_mac, dst=dst_mac) /
            IP(src="10.100.0.1", dst="10.100.0.2") /
            UDP(sport=5000, dport=5001) /
            Raw(f"TSN_SEQ_{i:04d}".encode())
        )
        pkts.append(pkt)

    def capture_cb(p):
        if UDP in p and p[UDP].dport == 5001:
            captured.append(p)

    sniff(
        iface=VETH_DST, prn=capture_cb, timeout=4,
        started_callback=lambda: sendp(pkts, iface=VETH_SRC, inter=0.01, verbose=False),
        store=False
    )

    loss = frames_to_send - len(captured)
    loss_pct = (loss / frames_to_send) * 100 if frames_to_send > 0 else 0

    return test_result(
        "UDP stream delivery",
        len(captured) >= frames_to_send * 0.9,
        f"Sent {frames_to_send}, Received {len(captured)}, Loss {loss_pct:.1f}%"
    )


# ──────────────────────────────────────────
# Test 6: gPTP frame (EtherType 0x88F7)
# ──────────────────────────────────────────
def test_gptp_frame():
    """Send a gPTP Sync frame and verify it crosses the bridge."""
    print(f"\n{BOLD}Test 6: gPTP Frame (EtherType 0x88F7){RESET}")

    src_mac = get_mac(VETH_SRC)
    # gPTP multicast destination
    dst_mac = "01:80:c2:00:00:0e"

    # Minimal PTP Sync message header
    ptp_payload = bytes([
        0x10,  # transport_specific=1, msg_type=0 (Sync)
        0x02,  # version=2
        0x00, 0x2C,  # messageLength=44
        0x00,  # domainNumber=0
        0x00,  # reserved
        0x02, 0x00,  # flags (twoStep)
    ]) + b'\x00' * 36  # rest of PTP header

    pkt = Ether(src=src_mac, dst=dst_mac, type=0x88F7) / Raw(ptp_payload)

    captured = []

    def capture_cb(p):
        if p.type == 0x88F7:
            captured.append(p)

    sniff(
        iface=VETH_DST, prn=capture_cb, timeout=2,
        started_callback=lambda: sendp(pkt, iface=VETH_SRC, count=3, inter=0.1, verbose=False),
        store=False
    )

    return test_result(
        "gPTP Sync forwarded across bridge",
        len(captured) > 0,
        f"{len(captured)} gPTP frames on {VETH_DST}"
    )


# ──────────────────────────────────────────
# Test 7: LLDP frame (EtherType 0x88CC)
# ──────────────────────────────────────────
def test_lldp_frame():
    """Send an LLDP frame and verify forwarding."""
    print(f"\n{BOLD}Test 7: LLDP Frame (EtherType 0x88CC){RESET}")

    src_mac = get_mac(VETH_SRC)
    dst_mac = "01:80:c2:00:00:0e"  # LLDP multicast

    # Minimal LLDP: Chassis ID TLV + Port ID TLV + TTL TLV + End TLV
    lldp_payload = bytes([
        0x02, 0x07, 0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        0x04, 0x04, 0x07, 0x70, 0x31, 0x00,
        0x06, 0x02, 0x00, 0x78,
        0x00, 0x00,
    ])

    pkt = Ether(src=src_mac, dst=dst_mac, type=0x88CC) / Raw(lldp_payload)

    captured = []

    def capture_cb(p):
        if p.type == 0x88CC:
            captured.append(p)

    sniff(
        iface=VETH_DST, prn=capture_cb, timeout=2,
        started_callback=lambda: sendp(pkt, iface=VETH_SRC, count=3, inter=0.1, verbose=False),
        store=False
    )

    return test_result(
        "LLDP frame forwarded across bridge",
        len(captured) > 0,
        f"{len(captured)} LLDP frames on {VETH_DST}"
    )


# ──────────────────────────────────────────
# Test 8: Bidirectional traffic
# ──────────────────────────────────────────
def test_bidirectional():
    """Send traffic in both directions through the bridge."""
    print(f"\n{BOLD}Test 8: Bidirectional Traffic{RESET}")

    src_mac = get_mac(VETH_SRC)
    dst_mac = get_mac(VETH_DST)

    # Direction 1: sender → receiver
    pkt_fwd = Ether(src=src_mac, dst=dst_mac, type=0x8899) / Raw(b"FWD_TEST")
    captured_fwd = []

    def cap_fwd(p):
        if Raw in p and b"FWD_TEST" in bytes(p[Raw]):
            captured_fwd.append(p)

    sniff(
        iface=VETH_DST, prn=cap_fwd, timeout=2,
        started_callback=lambda: sendp(pkt_fwd, iface=VETH_SRC, count=3, inter=0.1, verbose=False),
        store=False
    )

    fwd_ok = test_result(
        "Forward  (src → bridge → dst)",
        len(captured_fwd) > 0,
        f"{len(captured_fwd)} frames"
    )

    # Direction 2: receiver → sender
    pkt_rev = Ether(src=dst_mac, dst=src_mac, type=0x8899) / Raw(b"REV_TEST")
    captured_rev = []

    def cap_rev(p):
        if Raw in p and b"REV_TEST" in bytes(p[Raw]):
            captured_rev.append(p)

    sniff(
        iface=VETH_SRC, prn=cap_rev, timeout=2,
        started_callback=lambda: sendp(pkt_rev, iface=VETH_DST, count=3, inter=0.1, verbose=False),
        store=False
    )

    rev_ok = test_result(
        "Reverse  (dst → bridge → src)",
        len(captured_rev) > 0,
        f"{len(captured_rev)} frames"
    )

    return fwd_ok and rev_ok


# ──────────────────────────────────────────
# Test 9: High-rate burst (stress test)
# ──────────────────────────────────────────
def test_burst():
    """Send a high-rate burst of 500 small frames."""
    print(f"\n{BOLD}Test 9: High-Rate Burst (500 frames){RESET}")

    src_mac = get_mac(VETH_SRC)
    dst_mac = get_mac(VETH_DST)

    count = 500
    captured = []

    pkts = []
    for i in range(count):
        pkt = (
            Ether(src=src_mac, dst=dst_mac, type=0x8899) /
            Raw(f"BURST_{i:05d}".encode())
        )
        pkts.append(pkt)

    def capture_cb(p):
        if Raw in p and b"BURST_" in bytes(p[Raw]):
            captured.append(p)

    sniff(
        iface=VETH_DST, prn=capture_cb, timeout=5,
        started_callback=lambda: sendp(pkts, iface=VETH_SRC, inter=0.001, verbose=False),
        store=False
    )

    loss = count - len(captured)
    loss_pct = (loss / count) * 100

    return test_result(
        "Burst delivery",
        len(captured) >= count * 0.95,
        f"Sent {count}, Received {len(captured)}, Loss {loss_pct:.1f}%"
    )


# ──────────────────────────────────────────
# Main
# ──────────────────────────────────────────
def main():
    if os.geteuid() != 0:
        print(f"{RED}This script must be run as root (sudo).{RESET}")
        sys.exit(1)

    # Verify bridge exists
    rc, _ = run(f"ip link show {BRIDGE}")
    if rc != 0:
        print(f"{RED}Bridge {BRIDGE} not found. Create it in the WebUI first.{RESET}")
        sys.exit(1)

    print(f"{BOLD}{CYAN}{'='*60}")
    print(f"  5G-TSN Bridge Traffic Test")
    print(f"  Bridge: {BRIDGE}")
    print(f"{'='*60}{RESET}")

    # Disable scapy verbosity
    conf.verb = 0

    setup()

    # Register cleanup
    signal.signal(signal.SIGINT, lambda s, f: (cleanup(), sys.exit(0)))

    results = []
    try:
        results.append(("Basic Ethernet", test_basic_ethernet()))
        results.append(("Broadcast", test_broadcast()))
        results.append(("VLAN/PCP", test_vlan()))
        results.append(("ARP", test_arp()))
        results.append(("UDP Stream", test_udp_traffic()))
        results.append(("gPTP", test_gptp_frame()))
        results.append(("LLDP", test_lldp_frame()))
        results.append(("Bidirectional", test_bidirectional()))
        results.append(("Burst", test_burst()))
    finally:
        cleanup()

    # Summary
    passed = sum(1 for _, r in results if r)
    total = len(results)

    print(f"\n{BOLD}{'='*60}")
    print(f"  Results: {passed}/{total} tests passed")
    if passed == total:
        print(f"  {GREEN}ALL TESTS PASSED{RESET}")
    else:
        failed = [name for name, r in results if not r]
        print(f"  {RED}FAILED: {', '.join(failed)}{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")

    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
