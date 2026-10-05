#!/usr/bin/env python3
"""
Latency reflector for the UE's one-way latency probe (ue/tsn5g_ue/net/latency.py).

Each probe that arrives is stamped with this host's receive and send times
(CLOCK_REALTIME, ns) and sent straight back. The core's system clock must be
PTP-disciplined to UTC, as the UE's is; then the UE can compute one-way delay
in each direction.

  python3 core/scripts/latency-reflector.py                  # 0.0.0.0:5310
  python3 core/scripts/latency-reflector.py --port 5310 --bind 10.45.0.1

No root needed. Systemd unit: core/systemd/tsn5g-latency-reflector.service.in
"""

import argparse
import socket
import struct
import time

PKT = struct.Struct(">4sB3xQQQQ")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=5310)
    a = ap.parse_args()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
    s.bind((a.bind, a.port))
    print(f"latency reflector on {a.bind}:{a.port}", flush=True)
    while True:
        data, peer = s.recvfrom(256)
        t_rx = time.time_ns()
        if len(data) < PKT.size or data[:4] != b"TSNL":
            continue
        magic, lane, seq, t_tx, _, _ = PKT.unpack_from(data)
        s.sendto(PKT.pack(magic, lane, seq, t_tx, t_rx, time.time_ns()), peer)


if __name__ == "__main__":
    main()
