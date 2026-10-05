#!/usr/bin/env python3
"""
Time-stamped UDP talker and listener for the Qbv tests.

  qbv-talker.py send --dst IP --port N [--mode scheduled|uniform] [--cycle-us 4000]
                     [--offset-us 200] [--burst 4] [--size 1200] [--duration 20]
  qbv-talker.py recv --port N --duration S --out result.json

Every packet carries a sequence number and its send time on CLOCK_TAI, the
clock taprio schedules on and PTP disciplines.

  scheduled  sends BURST packets at OFFSET into every CYCLE, cycles aligned to
             TAI multiples of CYCLE: the same grid as a taprio schedule with
             base-time 0. Offset 200 us lands inside video-4ms's protected
             window (0-1560 us). This is what a time-aware talker does.
  uniform    the same rate, evenly spaced and ignorant of the schedule: what a
             camera does.
  sweep      one packet per CYCLE, its offset stepping by STEP through the
             cycle (0, STEP, 2*STEP, ...): finds the phase at which the radio
             carries a packet fastest. The listener reports delay per offset.

The listener reports loss (from sequence gaps) and one-way delay. Sender and
listener on one host (the sandbox) share a clock, so the delay is absolute.
Across the 5G link the two clocks differ by a near-constant offset, so only the
delay *variation* (each value minus the minimum) is meaningful there; the
report gives both.
"""

import argparse
import json
import socket
import struct
import sys
import time

HDR = struct.Struct("!QQI")         # sequence, send time (ns, CLOCK_TAI), offset (us)


def tai_ns():
    return time.clock_gettime_ns(time.CLOCK_TAI)


def _tight_timers():
    """1 ns timer slack: time.sleep() then wakes within ~50 us instead of ~50 us + slack."""
    try:
        import ctypes
        ctypes.CDLL(None, use_errno=True).prctl(29, 1, 0, 0, 0)   # PR_SET_TIMERSLACK
    except Exception:
        pass


def sleep_until(t_ns):
    """Sleep, never spin. A busy-wait here starved the kernel's receive backlog on
    this CPU (a veth delivers packets on the sending CPU), which silently dropped
    ~70 % of this talker's packets while a flood ran: the first live run measured
    the tool, not the radio. Sleeping costs ~50 us of accuracy, against a 4 ms cycle."""
    left = t_ns - tai_ns()
    if left > 0:
        time.sleep(left / 1e9)


def send(a):
    _tight_timers()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if a.sport or a.bind:
        # --bind: leave from this address (the UE's bearer address), so policy
        # routing sends it over the modem without a test namespace
        s.bind((a.bind or "0.0.0.0", a.sport or 0))
    pad = b"\0" * max(0, a.size - HDR.size)
    cyc = a.cycle_us * 1000
    end = tai_ns() + int(a.duration * 1e9)
    seq = 0
    if a.mode == "scheduled":
        t = (tai_ns() // cyc + 1) * cyc + a.offset_us * 1000
        while t < end:
            sleep_until(t)
            for _ in range(a.burst):
                s.sendto(HDR.pack(seq, tai_ns(), a.offset_us) + pad, (a.dst, a.port))
                seq += 1
            t += cyc
    elif a.mode == "sweep":
        n = max(1, a.cycle_us // a.step_us)
        base = (tai_ns() // cyc + 1) * cyc
        k = 0
        while True:
            off = (k % n) * a.step_us
            t = base + k * cyc + off * 1000
            if t >= end:
                break
            sleep_until(t)
            s.sendto(HDR.pack(seq, tai_ns(), off) + pad, (a.dst, a.port))
            seq += 1
            k += 1
    else:
        gap = cyc // a.burst
        t = tai_ns() + gap
        while t < end:
            sleep_until(t)
            s.sendto(HDR.pack(seq, tai_ns(), 0) + pad, (a.dst, a.port))
            seq += 1
            t += gap
    print(json.dumps({"sent": seq, "mode": a.mode}))


def pct(v, p):
    if not v:
        return None
    return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]


def recv(a):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    s.bind(("0.0.0.0", a.port))
    s.settimeout(0.5)
    end = time.monotonic() + a.duration
    delays, seqs, offs = [], [], []
    while time.monotonic() < end:
        try:
            data, _ = s.recvfrom(65535)
        except socket.timeout:
            continue
        now = tai_ns()
        if len(data) < HDR.size:
            continue
        seq, sent, off = HDR.unpack_from(data)
        seqs.append(seq)
        delays.append(now - sent)
        offs.append(off)
    res = {"received": len(seqs)}
    if seqs:
        expected = max(seqs) + 1
        d = sorted(delays)
        lo = d[0]
        us = lambda x: round(x / 1000, 1)
        res.update({
            "expected": expected,
            "loss_pct": round(100 * (1 - len(set(seqs)) / expected), 3),
            "delay_us": {"min": us(lo), "p50": us(pct(d, 50)), "p99": us(pct(d, 99)), "max": us(d[-1])},
            # delay above the best packet: valid even when the clocks differ
            "variation_us": {"p50": us(pct(d, 50) - lo), "p99": us(pct(d, 99) - lo),
                             "max": us(d[-1] - lo)},
        })
        if len(set(offs)) > 1:          # sweep: delay per send offset, above the overall best
            by = {}
            for o, dl in zip(offs, delays):
                by.setdefault(o, []).append(dl)
            res["per_offset_us"] = {
                str(o): {"n": len(v), "min": us(min(v) - lo), "p10": us(pct(sorted(v), 10) - lo),
                         "p50": us(pct(sorted(v), 50) - lo), "p99": us(pct(sorted(v), 99) - lo)}
                for o, v in sorted(by.items())}
    with open(a.out, "w") as f:
        json.dump(res, f, indent=1)
    print(json.dumps(res))


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    ps = sub.add_parser("send")
    ps.add_argument("--dst", required=True)
    ps.add_argument("--port", type=int, required=True)
    ps.add_argument("--sport", type=int, default=0, help="source port (5202 = the GBR flow)")
    ps.add_argument("--bind", default="", help="source address (e.g. the UE's bearer address)")
    ps.add_argument("--mode", choices=["scheduled", "uniform", "sweep"], default="scheduled")
    ps.add_argument("--step-us", type=int, default=250, help="sweep: offset step")
    ps.add_argument("--cycle-us", type=int, default=4000)
    ps.add_argument("--offset-us", type=int, default=200)
    ps.add_argument("--burst", type=int, default=4)
    ps.add_argument("--size", type=int, default=1200)
    ps.add_argument("--duration", type=float, default=20)
    pr = sub.add_parser("recv")
    pr.add_argument("--port", type=int, required=True)
    pr.add_argument("--duration", type=float, required=True)
    pr.add_argument("--out", required=True)
    a = p.parse_args()
    (send if a.cmd == "send" else recv)(a)


if __name__ == "__main__":
    sys.exit(main())
