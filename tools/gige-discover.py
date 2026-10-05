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
it at the next power cycle or link-down.

--set-persistent writes the address into the camera's own bootstrap registers
(GigE Vision: persistent IP 0x064C, mask 0x065C, gateway 0x066C) and turns
persistent IP on (0x0014 bit "PR"), then forces it so it is live at once. The
camera then comes back on this address after every power cycle and link-down.
Use a /24 mask that matches the host NIC: a camera whose mask differs from its
NIC's is what makes the vendor SDK force a new address when it opens it.
The camera must not be streaming (stop the encoders first).

  sudo ip netns exec cam2 python3 tools/gige-discover.py --iface enp7s0 \
       --set-persistent 169.254.143.19 --serial 25170574
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


# ---- register access (unicast to the camera's current address) -------------
REG_IFCONFIG = 0x0014       # network interface configuration: bit0 (LSB) persistent, bit1 DHCP, bit2 LLA
REG_CCP = 0x0A00            # control channel privilege
REG_PERSIST_IP, REG_PERSIST_MASK, REG_PERSIST_GW = 0x064C, 0x065C, 0x066C
_req = [100]


def _cmd(s, ip, code, payload):
    _req[0] = (_req[0] % 65000) + 1
    s.sendto(struct.pack(">BBHHH", 0x42, 0x01, code, len(payload), _req[0]) + payload, (ip, GVCP_PORT))
    data, _ = s.recvfrom(1024)
    status = struct.unpack(">H", data[0:2])[0]
    if status != 0:
        raise RuntimeError(f"camera refused command 0x{code:04x}: status 0x{status:04x}")
    return data[8:]


def readreg(s, ip, addr):
    return struct.unpack(">I", _cmd(s, ip, 0x0080, struct.pack(">I", addr))[:4])[0]


def writereg(s, ip, addr, value):
    _cmd(s, ip, 0x0082, struct.pack(">II", addr, value))


def set_persistent(iface, cam, ip, mask):
    s = _sock(iface)
    s.settimeout(1.5)
    cur = cam["ip"]
    writereg(s, cur, REG_CCP, 0x2)                       # exclusive control
    try:
        before = readreg(s, cur, REG_IFCONFIG)
        writereg(s, cur, REG_PERSIST_IP, int(ipaddress.IPv4Address(ip)))
        writereg(s, cur, REG_PERSIST_MASK, int(ipaddress.IPv4Address(mask)))
        writereg(s, cur, REG_PERSIST_GW, 0)
        writereg(s, cur, REG_IFCONFIG, before | 0x1 | 0x4)  # persistent on, keep LLA as the fallback
        got = (readreg(s, cur, REG_PERSIST_IP), readreg(s, cur, REG_PERSIST_MASK), readreg(s, cur, REG_IFCONFIG))
    finally:
        try:
            writereg(s, cur, REG_CCP, 0x0)                 # release control
        except Exception:
            pass
    return before, got


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--iface", required=True)
    ap.add_argument("--force-ip", help="move the camera to this address (until power cycle)")
    ap.add_argument("--mask", default="255.255.255.0")
    ap.add_argument("--serial", help="with --force-ip / --set-persistent: only the camera with this serial")
    ap.add_argument("--set-persistent", metavar="IP", help="store IP (and --mask) in the camera, persistent across power cycles")
    a = ap.parse_args()

    cams = discover(a.iface)
    if not cams:
        print(f"no GigE Vision camera answered on {a.iface} "
              "(check the cable / camera power; discovery works on any address)")
        return 1
    for c in cams:
        print(f"{c['serial'] or '?':>10}  {c['ip']:<16} mask {c['mask']:<15} "
              f"({c['address_from']})  {c['maker']} {c['model']}  mac {c['mac']}")
    if a.set_persistent:
        targets = [c for c in cams if not a.serial or c["serial"] == a.serial]
        if len(targets) != 1:
            print(f"--set-persistent needs exactly one camera; matched {len(targets)} (use --serial)")
            return 1
        cam = targets[0]
        try:
            before, (pip, pmask, cfg) = set_persistent(a.iface, cam, a.set_persistent, a.mask)
        except Exception as exc:
            print(f"could not write the camera's registers: {exc}  (is an encoder still holding it?)")
            return 1
        print(f"serial {cam['serial']}: persistent IP {ipaddress.IPv4Address(pip)} mask {ipaddress.IPv4Address(pmask)}; "
              f"IP config 0x{before:x} -> 0x{cfg:x} ({'persistent ON' if cfg & 1 else 'persistent OFF'})")
        if cam["ip"] != a.set_persistent or cam["mask"] != a.mask:
            force_ip(a.iface, cam, a.set_persistent, a.mask)
            time.sleep(1.0)
        for c in discover(a.iface):
            print(f"  now: {c['serial']:>10}  {c['ip']}  mask {c['mask']}")
        print("It keeps this address across power cycles. Check after the next one with plain --iface.")
        return 0 if cfg & 1 else 1
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
