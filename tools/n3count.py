#!/usr/bin/env python3
"""Count camera datagrams from the UE in an N3 (GTP-U) capture, inside a time
window. Usage: UE_IP=a.b.c.d n3count.py PCAP T0 T1   (epoch seconds on the CORE's clock).
A datagram is counted once: its unfragmented packet or its first fragment.
Python 3.6-compatible (runs on the core)."""
import os
import struct
import sys

UE = bytes(int(x) for x in os.environ.get("UE_IP", "10.45.0.12").split("."))
PORTS = {int(os.environ.get("CAM1_PORT", 50451)): "camera1",
         int(os.environ.get("CAM2_PORT", 50452)): "camera2"}
# In VXLAN mode the video is inside the tunnel: count each tunnel by its outer
# source port instead (camera 1's tunnel uses the GBR port).
VXLAN_PORT = int(os.environ.get("VXLAN_PORT", 4789))
TUNNELS = {int(os.environ.get("CAM1_SPORT", 5202)): "camera1",
           int(os.environ.get("CAM2_SPORT", 5212)): "camera2"}
path, t0, t1 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
n = {name: 0 for name in PORTS.values()}
with open(path, "rb") as fh:
    gh = fh.read(24)
    magic = struct.unpack("<I", gh[:4])[0]
    en = "<" if magic in (0xa1b2c3d4, 0xa1b23c4d) else ">"
    nano = magic in (0xa1b23c4d, 0x4d3cb2a1)
    while True:
        ph = fh.read(16)
        if len(ph) < 16:
            break
        sec, frac, incl, _ = struct.unpack(en + "IIII", ph)
        p = fh.read(incl)[14:]
        ts = sec + frac / (1e9 if nano else 1e6)
        if not (t0 <= ts < t1) or len(p) < 28 or p[9] != 17:
            continue
        g = p[(p[0] & 15) * 4 + 8:]
        hdr = 8
        if g and g[0] & 7 and len(g) >= 12:
            nxt, hdr = g[11], 12
            while nxt and len(g) > hdr:
                ln = g[hdr] * 4
                nxt = g[hdr + ln - 1] if len(g) >= hdr + ln else 0
                hdr += ln
        i = g[hdr:]
        if len(i) < 28 or i[12:16] != UE or i[9] != 17:
            continue
        if struct.unpack(">H", i[6:8])[0] & 0x1FFF:
            continue
        ihl = (i[0] & 15) * 4
        sport, dport = struct.unpack(">HH", i[ihl:ihl + 4])
        name = TUNNELS.get(sport) if dport == VXLAN_PORT else PORTS.get(dport)
        if name:
            n[name] += 1
for name, c in n.items():
    print("core received %s %d" % (name, c))
