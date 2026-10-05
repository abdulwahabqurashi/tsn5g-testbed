"""
Auto-rate: keep the UE's shaping rate just under what the radio can carry.

Why this exists
---------------
The LCP tests on 3 Oct showed the modem does not apply logical-channel
priority: once packets are inside it, the uplink is shared in proportion to
arrivals. Priority only holds if the queue forms on the UE, where HTB decides
the order. That needs the UE's total rate to stay below the radio's capacity,
and on this rig that capacity swings between ~40 and ~100 Mbit/s within
minutes (gNB host real-time misses). A fixed rate is either wasteful or, during
a dip, above the radio, which moves the queue back into the modem.

How
---
Delay-based, the approach CAKE-autorate uses on LTE. A ping to the core every
200 ms measures how much is queued *below* the UE: when the modem's buffer
fills, the round trip grows. The pings have their own top-priority class
(qdisc.CLS_PROBE, prio 0, above both lanes), so no queue on the UE adds to
them. They used to ride the protected lane; once camera 1 alone exceeded the
shaped rate the ping measured the UE's own queue and auto-rate spiralled to
its floor (5 Oct).

Every tick:
  * delay well above the baseline   -> the modem is queueing: cut the rate
  * delay near baseline, link busy  -> there is room: raise the rate
  * idle                            -> drift up slowly, so a dip is not
                                       remembered forever
The baseline is the minimum round trip, tracked fast downwards and slowly
upwards so a long congested period cannot teach it a bloated value.

The rate is applied with `tc class change` on the existing `limited` tree — no
rebuild, so nothing in flight is dropped. Best effort keeps its configured cap
but never more than (rate - reserve), so the protected lane always has at least
`reserve_mbps` of the current capacity.
"""

import logging
import re
import statistics
import subprocess
import threading
import time
from collections import deque

from .. import utils
from . import qdisc

logger = logging.getLogger("tsn5g-ue.net.autorate")

DEFAULTS = {
    "enabled": False,
    "min_mbps": 30,          # never shape below this (lowest capacity seen: ~29-42)
    "max_mbps": 120,         # never above this (today's measured ceiling ~122)
    "reserve_mbps": 15,      # protected lane's guaranteed share of the current rate
    # This radio's idle round trip wanders 9-26 ms and spikes to 40-67 ms at LOW
    # load (grant requests per burst), so the thresholds are wide and a cut also
    # needs the link to be busy — see _run.
    "delay_hi_ms": 30,       # queueing delay that means "the modem is filling"
    "delay_lo_ms": 12,       # below this the queue below the UE is empty
    # How fast it probes for spare capacity. Every raise that overshoots the
    # radio queues in the modem, where there is no priority, until the next
    # tick sees the delay: at +6 %/0.5 s that was ~50 ms of queue in front of
    # the protected lane (p99 ~100-145 ms under flood, 4 Oct). +2 %/0.25 s
    # overshoots by a fraction of that and still finds the radio's rate in
    # seconds.
    "interval_s": 0.25,
    "raise_pct": 2.0,
    "target": "10.45.0.1",
}

_PING_RULE = ["-t", "mangle", "POSTROUTING", "-o", "{dev}", "-p", "icmp",
              "--icmp-type", "echo-request", "-j", "CLASSIFY",
              "--set-class", qdisc.CLS_PROBE]


class AutoRate:
    def __init__(self, bearer, cfg=None):
        self.bearer = bearer
        cfg = dict(cfg or {})
        # Settings saved before 3 Oct 15:20 carry the first defaults (min 10,
        # cut at +15 ms), which on this radio drove the rate to the floor and
        # starved best effort. Treat that exact pair as "unset".
        if cfg.get("min_mbps") == 10 and cfg.get("delay_hi_ms") == 15:
            for k in ("min_mbps", "delay_hi_ms", "delay_lo_ms"):
                cfg.pop(k, None)
        self.cfg = dict(DEFAULTS, **cfg)
        self._stop = threading.Event()
        self._thread = None
        self._ping = None
        self._rtts = deque(maxlen=50)
        self._lock = threading.Lock()
        self.history = deque(maxlen=480)        # ~2 min at 0.25 s
        self._reset_state()

    def _reset_state(self):
        self.state = {"active": False, "rate_mbps": None, "be_ceil_mbps": None,
                      "base_rtt_ms": None, "rtt_ms": None, "load_mbps": None,
                      "last_action": None, "reason": None}

    # -- config ----------------------------------------------------------------
    def configure(self, **kw):
        new = dict(self.cfg)     # validate a copy: a rejected request changes nothing
        for k, v in kw.items():
            if k not in DEFAULTS or v is None:
                continue
            new[k] = type(DEFAULTS[k])(v) if not isinstance(DEFAULTS[k], bool) else bool(v)
        if new["min_mbps"] >= new["max_mbps"]:
            raise ValueError("min_mbps must be below max_mbps")
        if new["reserve_mbps"] >= new["max_mbps"]:
            raise ValueError("reserve_mbps must be below max_mbps")
        if not 0.1 <= new["interval_s"] <= 5:
            raise ValueError("interval_s must be between 0.1 and 5")
        if not 0.5 <= new["raise_pct"] <= 20:
            raise ValueError("raise_pct must be between 0.5 and 20")
        self.cfg = new
        self.restart()
        return dict(self.cfg)

    def status(self):
        with self._lock:
            return {**self.state, "config": dict(self.cfg),
                    "history": list(self.history)}

    def effective_be_mbps(self):
        """What best effort is actually capped at right now."""
        if self.state.get("active") and self.state.get("be_ceil_mbps"):
            return self.state["be_ceil_mbps"]
        return self.bearer.queue_be_mbps

    # -- lifecycle ---------------------------------------------------------------
    def restart(self):
        self.stop()
        if not self.cfg["enabled"]:
            self.state["reason"] = "disabled"
            return
        if self.bearer.queue_policy != qdisc.LIMITED:
            self.state["reason"] = "queue policy is not 'limited' — auto-rate shapes the camera lanes"
            return
        if not utils.iface_exists(self.bearer.iface):
            self.state["reason"] = f"{self.bearer.iface} does not exist"
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="autorate")
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None
        self._stop_ping()
        self._ping_rule(add=False)
        was_active = self.state.get("active")
        self._reset_state()
        if was_active:
            # Put the static rates back so the lanes are what the config says.
            self._apply(self.bearer.queue_link_mbps, static=True)

    # -- probe -------------------------------------------------------------------
    def _ping_rule(self, add):
        rule = [x.replace("{dev}", self.bearer.iface) for x in _PING_RULE]
        exists = utils.run(["iptables", rule[0], rule[1], "-C", *rule[2:]],
                           check=False, timeout=10).returncode == 0
        if add and not exists:
            utils.run(["iptables", rule[0], rule[1], "-A", *rule[2:]], check=False, timeout=10)
        elif not add and exists:
            utils.run(["iptables", rule[0], rule[1], "-D", *rule[2:]], check=False, timeout=10)

    def _start_ping(self):
        self._ping = subprocess.Popen(
            # two pings per tick, so each decision sees fresh delay (root may go below 0.2 s)
            ["ping", "-n", "-i", f"{max(0.05, min(0.2, self.cfg['interval_s'] / 2)):.2f}",
             "-W", "1", "-I", self.bearer.iface, self.cfg["target"]],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        threading.Thread(target=self._read_ping, args=(self._ping,), daemon=True,
                         name="autorate-ping").start()

    def _read_ping(self, proc):
        rx = re.compile(r"time=([\d.]+) ms")
        for line in proc.stdout:
            m = rx.search(line)
            if m:
                self._rtts.append((time.monotonic(), float(m.group(1))))

    def _stop_ping(self):
        if self._ping and self._ping.poll() is None:
            self._ping.terminate()
            try:
                self._ping.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._ping.kill()
        self._ping = None

    # -- shaping -----------------------------------------------------------------
    def _apply(self, rate, static=False):
        dev = self.bearer.iface
        rate = int(round(rate))
        cap = int(self.bearer.queue_be_mbps)
        be = cap if static else max(1, min(cap, rate - int(self.cfg["reserve_mbps"])))
        if be >= rate:
            be = max(1, rate - 1)
        prot = rate - be
        mb = qdisc._mbit
        steps = [
            ("class", "change", "dev", dev, "parent", "1:", "classid", qdisc.CLS_ROOT,
             "htb", "rate", mb(rate), "ceil", mb(rate), "quantum", "1400"),
            ("class", "change", "dev", dev, "parent", qdisc.CLS_ROOT, "classid",
             qdisc.CLS_PROTECTED, "htb", "rate", mb(prot), "ceil", mb(rate),
             "prio", "1", "quantum", "1400"),
            ("class", "change", "dev", dev, "parent", qdisc.CLS_ROOT, "classid",
             qdisc.CLS_BEST_EFFORT, "htb", "rate", mb(be), "ceil", mb(be),
             "prio", "2", "quantum", "1400"),
        ]
        for st in steps:
            proc = utils.tc(*st, check=False)
            if proc.returncode != 0:
                logger.warning("autorate: tc %s failed: %s", " ".join(st[:6]),
                               (proc.stderr or "").strip())
                return False
        if not static:
            self.state["rate_mbps"] = rate
            self.state["be_ceil_mbps"] = be
        return True

    def _tx_bytes(self):
        return int(utils.read_sysfs(f"/sys/class/net/{self.bearer.iface}/statistics/tx_bytes", "0") or 0)

    def _run(self):
        c = self.cfg
        self._ping_rule(add=True)
        self._rtts.clear()
        self._start_ping()
        rate = float(min(c["max_mbps"], max(c["min_mbps"], self.bearer.queue_link_mbps)))
        if not self._apply(rate):
            self.state["reason"] = "could not change the HTB classes — is the 'limited' tree in place?"
            self._stop_ping()
            self._ping_rule(add=False)
            return
        self.state.update(active=True, reason=None, last_action="start")
        logger.info("autorate started at %d Mbit/s (min %d, max %d, reserve %d)",
                    rate, c["min_mbps"], c["max_mbps"], c["reserve_mbps"])
        base = None
        window = deque()                                  # (t, rtt) over the last 30 s
        seen = 0.0
        last_t, last_b = time.monotonic(), self._tx_bytes()
        while not self._stop.wait(c["interval_s"]):
            now, b = time.monotonic(), self._tx_bytes()
            load = max(0.0, (b - last_b) * 8 / max(1e-3, now - last_t) / 1e6)
            last_t, last_b = now, b
            recent = [r for t, r in self._rtts if now - t <= c["interval_s"] * 2]
            for t, r in self._rtts:
                if t > seen:
                    window.append((t, r))
            seen = max([seen] + [t for t, _ in self._rtts])
            while window and now - window[0][0] > 30:
                window.popleft()
            if recent and window:
                rtt = statistics.median(recent)
                # Baseline: 10th percentile over 30 s, not the single lowest
                # sample, which on this radio is a lucky outlier (9 ms vs a
                # typical 12-20).
                vals = sorted(r for _, r in window)
                base = vals[max(0, int(len(vals) * 0.1) - 1)]
                delta = rtt - base
            else:
                rtt, delta = None, None
            busy = load >= 0.6 * rate
            action = "hold"
            new = rate
            # Delay only counts as OUR queue when the link is busy. At low load
            # 5G uplink latency rises by itself (a grant request per burst),
            # and cutting then starved the best-effort lane to 1 Mbit/s.
            if busy and (delta is None or delta > c["delay_hi_ms"]):
                # Cut towards what actually got through, but a cut never
                # raises the rate (a load reading above the rate is a burst
                # draining, not capacity).
                basis = load if 0.3 * rate < load < rate else rate
                new = max(c["min_mbps"], min(rate * 0.9, basis * 0.85))
                action = "cut"
            elif delta is not None and delta < c["delay_lo_ms"] and load > 0.75 * rate:
                new = min(c["max_mbps"], rate * (1 + c["raise_pct"] / 100))
                action = "raise"
            elif load < 0.3 * rate:
                new = min(c["max_mbps"], rate * 1.01)
                action = "idle"
            new = min(c["max_mbps"], max(c["min_mbps"], new))
            if abs(new - rate) >= max(0.5, rate * 0.02):
                if self._apply(new):
                    rate = new
            with self._lock:
                self.state.update(rtt_ms=None if rtt is None else round(rtt, 1),
                                  base_rtt_ms=None if base is None else round(base, 1),
                                  load_mbps=round(load, 1), last_action=action)
                self.history.append({"t": time.time(), "rate": round(rate, 1),
                                     "load": round(load, 1),
                                     "rtt": None if rtt is None else round(rtt, 1),
                                     "base": None if base is None else round(base, 1)})
        logger.info("autorate stopped")
