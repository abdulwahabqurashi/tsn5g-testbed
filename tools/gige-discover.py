#!/usr/bin/env python3
"""
Find GigE Vision cameras on one NIC, whatever address they currently have,
and optionally move one to the address the rig expects.

  sudo python3 tools/gige-discover.py --iface enp8s0
  sudo ip netns exec cam2 python3 tools/gige-discover.py --iface enp7s0
  sudo ip netns exec cam2 python3 tools/gige-discover.py --iface enp7s0 \
       --force-ip 169.254.143.18 --serial 25170574

Why: the cameras still use self-assigned link-local addresses (169.254.x.y).
After a link bounce a camera can come back with a different one, outside the
host's /24, and then nothing reaches it, not even ping. GVCP discovery is a
broadcast that the camera answers on any address, so this finds it anyway.

--force-ip uses GVCP FORCEIP: the camera takes the address at once but forgets
it at the next power cycle. A persistent address needs the camera's persistent
IP registers (SpinView, or the planned static-IP step).
"""

import argparse
import ipaddress
import socket
import struct
import sys
import time

GVCP_PORT = 3956
# key 0x42, flags: ack required (0x01) + broadcast ack allowed (0x10)
DISCOVERY = struct.pack(">BBHHH", 0x42, 0x11, 0x0002, 0, 0x0001)


def _sock(iface):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode())
    s.bind(("0.0.0.0", 0))
    return s


def _str(b):
    return b.split(b"\0", 1)[0].decode("ascii", "replace").strip()


def parse_ack(data):
    """DISCOVERY_ACK payload (GigE Vision 2.x, table 'DISCOVERY_ACK')."""
    if len(data) < 8 + 248:
        return None
    p = data[8:]
    mac = p[10:12] + p[12:16]
    cfg_current = struct.unpack(">I", p[20:24])[0]
    how = ("persistent" if cfg_current & 0x1 else
           "DHCP" if cfg_current & 0x2 else
           "link-local" if cfg_current & 0x4 else f"0x{cfg_current:x}")
    return {
        "mac": ":".join(f"{x:02x}" for x in mac),
        "ip": str(ipaddress.IPv4Address(p[36:40])),
        "mask": str(ipaddress.IPv4Address(p[52:56])),
        "gateway": str(ipaddress.IPv4Address(p[68:72])),
        "address_from": how,
        "maker": _str(p[72:104]),
        "model": _str(p[104:136]),
        "serial": _str(p[216:232]),
        "name": _str(p[232:248]),
        "_mac_raw": mac,
    }


def discover(iface, wait=2.0):
    s = _sock(iface)
    s.settimeout(0.3)
    s.sendto(DISCOVERY, ("255.255.255.255", GVCP_PORT))
    found, end = {}, time.monotonic() + wait
    while time.monotonic() < end:
        try:
            data, src = s.recvfrom(1024)
        except socket.timeout:
            continue
        cam = parse_ack(data)
        if cam:
            cam["answered_from"] = src[0]
            found[cam["mac"]] = cam
    return list(found.values())


def force_ip(iface, cam, ip, mask="255.255.255.0", gw="0.0.0.0"):
    """FORCEIP_CMD (0x0004): reserved 2, MAC 6, then IP / mask / gateway, each
    preceded by 12 reserved bytes. Sent as broadcast so a camera on a foreign
    subnet still hears it."""
    payload = (b"\0\0" + cam["_mac_raw"] +
               b"\0" * 12 + ipaddress.IPv4Address(ip).packed +
               b"\0" * 12 + ipaddress.IPv4Address(mask).packed +
               b"\0" * 12 + ipaddress.IPv4Address(gw).packed)
    hdr = struct.pack(">BBHHH", 0x42, 0x11, 0x0004, len(payload), 0x0002)
    s = _sock(iface)
    s.settimeout(1.5)
    s.sendto(hdr + payload, ("255.255.255.255", GVCP_PORT))
    try:
        data, _ = s.recvfrom(64)
        status = struct.unpack(">H", data[0:2])[0]
        return status == 0
    except socket.timeout:
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--iface", required=True)
    ap.add_argument("--force-ip", help="move the camera to this address (until power cycle)")
    ap.add_argument("--mask", default="255.255.255.0")
    ap.add_argument("--serial", help="with --force-ip: only the camera with this serial")
    a = ap.parse_args()

    cams = discover(a.iface)
    if not cams:
        print(f"no GigE Vision camera answered on {a.iface} "
              "(check the cable / camera power; discovery works on any address)")
        return 1
    for c in cams:
        print(f"{c['serial'] or '?':>10}  {c['ip']:<16} mask {c['mask']:<15} "
              f"({c['address_from']})  {c['maker']} {c['model']}  mac {c['mac']}")
    if not a.force_ip:
        return 0
    targets = [c for c in cams if not a.serial or c["serial"] == a.serial]
    if len(targets) != 1:
        print(f"--force-ip needs exactly one camera; matched {len(targets)} (use --serial)")
        return 1
    ok = force_ip(a.iface, targets[0], a.force_ip, a.mask)
    print(f"FORCEIP {a.force_ip} -> serial {targets[0]['serial']}: "
          f"{'acknowledged' if ok else 'no acknowledgement'}")
    time.sleep(1.0)
    for c in discover(a.iface):
        print(f"  now: {c['serial']:>10}  {c['ip']}  ({c['address_from']})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
