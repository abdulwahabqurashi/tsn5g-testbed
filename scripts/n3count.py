#!/usr/bin/env python3
"""Count camera datagrams from the UE in an N3 (GTP-U) capture, inside a time
window. Usage: n3count.py PCAP T0 T1   (epoch seconds, UE clock ~ core clock).
A datagram is counted once: its unfragmented packet or its first fragment.
Python 3.6-compatible (runs on the core)."""
import struct
import sys

UE = bytes([10, 45, 0, 12])
PORTS = {50451: "camera1", 50452: "camera2"}
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
        name = PORTS.get(struct.unpack(">H", i[ihl + 2:ihl + 4])[0])
        if name:
            n[name] += 1
for name, c in n.items():
    print("core received %s %d" % (name, c))
