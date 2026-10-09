"""
One-way latency over the 5G link, live, in the lanes the cameras use.

The camera encoders are vendor software and cannot timestamp their packets,
so this sends a light probe through the same paths instead:

  protected     from source port GBR_SOURCE_PORT: the same GBR QoS flow as
                camera 1, and classified into the same HTB class (1:10)
  best_effort   from another port: the default flow, like camera 2

20 packets a second per lane, 64 bytes each (~20 kbit/s per lane). A reflector
on the core (core/scripts/latency-reflector.py) stamps each one on arrival and
sends it back. UE and core system clocks are both PTP-disciplined to UTC, so
the stamps give real one-way delay in each direction, not half a round trip.

Packet (big-endian): b"TSNL", lane (1), pad (3), seq (8), t_ue_tx (8),
t_core_rx (8), t_core_tx (8); times are CLOCK_REALTIME in ns.
"""

import logging
import select
import socket
import statistics
import struct
import threading
import time
from collections import deque

from .. import utils

logger = logging.getLogger("tsn5g-ue.net.latency")

MAGIC = b"TSNL"
PKT = struct.Struct(">4sB3xQQQQ")
LANES = ("protected", "best_effort")
DEFAULTS = {"enabled": True, "rate_hz": 20, "port": 5310, "best_effort_sport": 5211}
CLASSIFY = ["-t", "mangle", "POSTROUTING", "-o", "{dev}", "-p", "udp", "--sport", "{sport}",
            "--dport", "{port}", "-j", "CLASSIFY", "--set-class", "1:10"]


def _pct(v, q):
    if not v:
        return None
    s = sorted(v)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


class LatencyProbe:
    def __init__(self, bearer, cfg=None, target=None, gbr_sport=5202):
        self.bearer = bearer
        self.cfg = dict(DEFAULTS, **(cfg or {}))
        self.target = target
        self.sports = {"protected": int(gbr_sport), "best_effort": int(self.cfg["best_effort_sport"])}
        self.history = {lane: deque(maxlen=3600) for lane in LANES}      # one row a second
        self.current = {lane: None for lane in LANES}
        self._started = self._last_reply = None
        self.state = {"running": False, "bound_to": None, "reason": None, "reflector": False}
        self._stop = threading.Event()
        self._thread = None
        self._pending = {}                                              # (lane, seq) -> t_tx
        self._sec = {lane: [] for lane in LANES}

    # -- control ------------------------------------------------------------------
    def start(self):
        if self._thread and self._thread.is_alive():
            return
        if not self.cfg.get("enabled"):
            self.state["reason"] = "disabled"
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="latency-probe", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        self._thread = None
        self.state.update(running=False, reason="stopped")

    def configure(self, enabled=None, rate_hz=None):
        if rate_hz is not None:
            r = int(rate_hz)
            if not 1 <= r <= 200:
                raise ValueError("rate_hz must be between 1 and 200")
            self.cfg["rate_hz"] = r
        if enabled is not None:
            self.cfg["enabled"] = bool(enabled)
        self.stop()
        self.start()
        return dict(self.cfg)

    # -- read model ---------------------------------------------------------------
    def core_silent_s(self):
        """Seconds the core has not answered while the probe is sending, else None.

        A data call can look up (address, routes, QMI handle) while nothing
        crosses the radio: on 6 Oct the gNB restarted and the modem never
        reconnected, and the UE reported "up" for five hours.
        """
        # Counted with or without an address: a failed rebuild leaves the call
        # down, and stopping the count there made the watchdog give up after a
        # single attempt (8-9 Oct: the core was stopped overnight).
        if not self.state.get("running"):
            return None
        since = self._last_reply or self._started
        return round(time.monotonic() - since, 1) if since else None

    def status(self):
        silent = self.core_silent_s()
        self.state["reflector"] = silent is not None and silent < 10
        return {**self.state, "core_silent_s": silent, "config": dict(self.cfg), "target": self.target,
                "source_ports": self.sports, "current": self.current}

    def get_history(self, minutes=15):
        since = time.time() - minutes * 60
        return {lane: [r for r in list(self.history[lane]) if r["t"] >= since] for lane in LANES}

    # -- the probe -----------------------------------------------------------------
    def _rule(self, op, sport):
        argv = [a.format(dev=self.bearer.iface, sport=sport, port=self.cfg["port"]) for a in CLASSIFY]
        if op == "add":
            if utils.run(["iptables", argv[0], argv[1], "-C", *argv[2:]], check=False).returncode != 0:
                utils.run(["iptables", argv[0], argv[1], "-I", argv[2], "1", *argv[3:]], check=False)
        else:
            utils.run(["iptables", argv[0], argv[1], "-D", *argv[2:]], check=False)

    def _open(self, addr):
        socks = {}
        for lane in LANES:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((addr, self.sports[lane]))
            s.setblocking(False)
            socks[lane] = s
        return socks

    def _run(self):
        self.state.update(running=True, reason=None)
        self._started, self._last_reply = time.monotonic(), None
        socks, addr, seq = {}, None, 0
        self._rule("add", self.sports["protected"])
        try:
            next_tx = time.monotonic()
            next_roll = time.time() // 1 + 1
            while not self._stop.is_set():
                now_addr = self.bearer._current_address()
                if now_addr != addr:
                    for s in socks.values():
                        s.close()
                    socks, addr = {}, now_addr
                    if addr:
                        try:
                            socks = self._open(addr)
                            self.state.update(bound_to=addr, reason=None)
                        except OSError as exc:
                            socks = {}
                            self.state["reason"] = f"cannot bind {addr}: {exc}"
                    else:
                        self.state.update(bound_to=None, reason="bearer down")
                if not socks or not self.target:
                    time.sleep(1.0)
                    continue
                # send one packet per lane at rate_hz
                if time.monotonic() >= next_tx:
                    seq += 1
                    for i, lane in enumerate(LANES):
                        t = time.time_ns()
                        try:
                            socks[lane].sendto(PKT.pack(MAGIC, i, seq, t, 0, 0),
                                               (self.target, self.cfg["port"]))
                            self._pending[(lane, seq)] = t
                        except OSError:
                            pass
                    next_tx += 1.0 / self.cfg["rate_hz"]
                    if next_tx < time.monotonic():
                        next_tx = time.monotonic()
                # receive replies
                r, _, _ = select.select(list(socks.values()), [], [], max(0.0, min(0.05, next_tx - time.monotonic())))
                for s in r:
                    while True:
                        try:
                            data = s.recv(256)
                        except BlockingIOError:
                            break
                        self._reply(data, time.time_ns())
                if time.time() >= next_roll:
                    self._roll(next_roll)
                    next_roll += 1
        finally:
            for s in socks.values():
                s.close()
            self._rule("del", self.sports["protected"])
            self.state["running"] = False

    def _reply(self, data, t_rx):
        if len(data) < PKT.size:
            return
        magic, li, seq, t_tx, c_rx, c_tx = PKT.unpack_from(data)
        if magic != MAGIC or li >= len(LANES) or not c_rx:
            return
        lane = LANES[li]
        if self._pending.pop((lane, seq), None) is None:
            return
        self.state["reflector"] = True
        self._last_reply = time.monotonic()
        self._sec[lane].append(((c_rx - t_tx) / 1e6, (t_rx - c_tx) / 1e6))

    def _roll(self, sec_end):
        """Close one second: per-lane stats; a probe unanswered after 2 s counts as lost."""
        cutoff = time.time_ns() - 2_000_000_000
        lost = {lane: 0 for lane in LANES}
        for key, t in list(self._pending.items()):
            if t < cutoff:
                lost[key[0]] += 1
                del self._pending[key]
        for lane in LANES:
            got = self._sec[lane]
            self._sec[lane] = []
            if not got and not lost[lane]:
                continue
            up = [u for u, _ in got]
            down = [d for _, d in got]
            row = {"t": sec_end, "n": len(got), "lost": lost[lane],
                   "up_p50": round(statistics.median(up), 2) if up else None,
                   "up_p99": round(_pct(up, 0.99), 2) if up else None,
                   "up_max": round(max(up), 2) if up else None,
                   "down_p50": round(statistics.median(down), 2) if down else None}
            self.history[lane].append(row)
            self.current[lane] = row
