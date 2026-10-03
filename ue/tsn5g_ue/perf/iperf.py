"""
Throughput testing, ported from docs/reference/iperf5g.sh.

The single most important line in that script is its header comment about
`-B`:

    an unbound run to anything outside 10.45.0.0/16 would quietly travel over
    gigabit ethernet and report numbers that have nothing to do with 5G

That is not hypothetical on this rig. Before Phase 4 fixed the addressing,
`ip route get 10.45.0.1` went out enp3s0 — so an unbound iperf3 measured the
LAN and would have reported roughly 900 Mbit/s as a 5G result. `-B` is
mandatory here, and the address is read from the interface at the moment the
run starts, never cached: the SMF hands out a new one on every data call.

The old speedtest.py deliberately omitted `-B`, on the reasoning that "egress
over 5G is guaranteed by routing". That reasoning was wrong in exactly the way
the script warns about.

On-disk layout is unchanged from the script, so the existing iperf_logs/
directories stay readable and anything that parses the CSV keeps working:

    iperf_logs/<YYYYmmdd-HHMMSS>/summary.csv
    iperf_logs/<YYYYmmdd-HHMMSS>/%04d_<leg>.json
"""

import csv
import json
import logging
import os
import re
import subprocess
import time

from .. import utils

logger = logging.getLogger("tsn5g-ue.perf")

CSV_HEADER = ["ts", "seq", "leg", "proto", "dir", "mbps", "retransmits",
              "rtt_ms", "jitter_ms", "loss_pct", "rsrp_dbm", "sinr_db", "status"]

# The four legs iperf5g.sh cycles through, with its rates.
DEFAULT_LEGS = ["tcp-up", "tcp-down", "udp-up", "udp-down"]
DEFAULT_UDP_RATE = {"up": "25M", "down": "70M"}
DEFAULT_LENGTH = 1200        # below wwan0's 1400 MTU, so no fragmentation



def _run_started(run_id, path):
    """When the run began, from its id rather than the directory's mtime.

    Run ids are `YYYYmmdd-HHMMSS` — the start time, exactly, and immutable.
    Directory mtime moves every time a leg is written, so a run that was still
    being appended to sorted above genuinely newer runs. Falls back to mtime
    for any directory whose name is not an id.
    """
    try:
        return time.mktime(time.strptime(run_id[:15], "%Y%m%d-%H%M%S"))
    except (ValueError, TypeError):
        try:
            return os.path.getmtime(path)
        except OSError:
            return 0


class IperfError(RuntimeError):
    pass


def bind_address(iface):
    """The interface's current IPv4. Read now, never cached.

    Caching this is the bug the handover document calls the rig's most
    frequent: every data call gets a new address, so a bind address from a
    previous run either fails outright or, worse, still belongs to the host and
    silently sends the test somewhere else.
    """
    proc = utils.run(["ip", "-4", "-o", "addr", "show", iface],
                     check=False, timeout=10)
    m = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", proc.stdout or "")
    return m.group(1) if m else None


def local_addresses():
    """Every usable local IPv4, newest-interface-agnostic, for the client picker."""
    proc = utils.run(["ip", "-4", "-o", "addr", "show"], check=False, timeout=10)
    out = []
    for line in (proc.stdout or "").splitlines():
        m = re.match(r"\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)", line)
        if not m or m.group(1) == "lo":
            continue
        out.append({"iface": m.group(1), "address": m.group(2)})
    return out


def resolve_bind(spec, iface):
    """Which local address the test should leave from.

    Defaults to the bearer, which is the whole point of making -B mandatory:
    an unbound run quietly travels over gigabit ethernet and reports a number
    that has nothing to do with 5G. But the operator may legitimately want to
    measure the wired path, or bind to a second UE address, so an explicit
    choice wins over the default.
    """
    explicit = (spec.get("bind") or "").strip()
    if explicit:
        return explicit, "explicit"
    addr = bind_address(iface)
    return addr, iface


def check_path(bind, server):
    """Does a socket bound to `bind` have a route to `server`?

    Worth doing before the run because the failure mode is otherwise a wait:
    iperf3 bound to the modem address and aimed at a wired host does not
    refuse, it hangs until the timeout and reports "did not finish in time",
    which says nothing about the cause.

    Returns {ok, dev, src, reason}. ok=None means the question could not be
    answered, which is not the same as a failure and never blocks a run.
    """
    if not bind or not server:
        return {"ok": None, "reason": "no address to check"}
    proc = utils.run(["ip", "route", "get", server, "from", bind],
                     check=False, timeout=10)
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        reason = out.strip().splitlines()[0] if out.strip() else "no route"
        return {"ok": False, "dev": None, "src": bind, "reason": reason}
    m = re.search(r"\bdev\s+(\S+)", out)
    dev = m.group(1) if m else None

    # `ip route get ... from <addr>` answers happily even when <addr> belongs
    # to a different interface than the one the route egresses — it reports the
    # route, not whether the pairing works. It does not: the SYNs leave via the
    # egress interface carrying a source address routed elsewhere, and the
    # replies never come back. iperf3 does not refuse, it waits, and the run
    # ends as "did not finish in time". That is the case worth catching.
    owner = _address_owner(bind)
    if dev and owner and owner != dev:
        return {
            "ok": False, "dev": dev, "src": bind, "owner": owner,
            "reason": (f"{bind} belongs to {owner}, but traffic to {server} "
                       f"leaves via {dev}. The far side would have no route "
                       f"back, so the test would hang rather than fail."),
        }
    return {"ok": True, "dev": dev, "src": bind, "owner": owner,
            "raw": out.strip()}


def _address_owner(addr):
    """Which interface holds this address, or None if no local interface does."""
    proc = utils.run(["ip", "-4", "-o", "addr", "show"], check=False, timeout=10)
    for line in (proc.stdout or "").splitlines():
        m = re.match(r"\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)", line)
        if m and m.group(2) == addr:
            return m.group(1)
    return None


def build_command(spec, bind):
    """Exactly the invocation iperf5g.sh uses."""
    cmd = ["iperf3", "-c", spec["server"], "-B", bind,
           "-p", str(spec.get("port", 5201)),
           "-t", str(spec.get("duration", 30)), "-i", "1", "-J"]
    if spec.get("parallel", 1) > 1:
        cmd += ["-P", str(spec["parallel"])]

    # The DS field on the test traffic. This is the instrument for the one
    # question the UE side cannot answer on its own: does the outer DSCP select
    # a QoS flow, and does that flow get scheduled differently?
    #
    # Two runs at once, one marked and one not, measures that directly — and it
    # needs no VXLAN, no cameras and no NW-TT, because plain IP to the core
    # exercises exactly the same uplink QoS rules. Simultaneous rather than
    # sequential on purpose: this uplink swings 29-96 Mbit/s, a spread that
    # would swamp the effect being looked for if the two runs were compared
    # across time instead of against each other.
    dscp = spec.get("dscp")
    if dscp is not None:
        d = int(dscp)
        if not 0 <= d <= 63:
            raise IperfError(f"dscp {d} out of range 0-63")
        # iperf3 takes --dscp as the DSCP itself, not the shifted ToS byte.
        cmd += ["--dscp", str(d)]
    if spec["proto"] == "udp":
        rate = spec.get("udp_rate") or DEFAULT_UDP_RATE.get(spec["dir"], "25M")
        cmd += ["-u", "-b", str(rate), "-l", str(spec.get("length", DEFAULT_LENGTH))]
    else:
        # Omit the first seconds so TCP slow-start does not drag the average
        # down. The script does this on TCP only.
        cmd += ["-O", str(spec.get("omit", 2))]
    if spec["dir"] == "down":
        cmd.append("-R")
    return cmd


def parse_result(stdout):
    """Extract the summary from iperf3 -J output.

    iperf3 can append a plain-text error line after the JSON object, so the
    first object is decoded and the remainder ignored — same approach the old
    speedtest.py used and the one thing it got right.
    """
    if not stdout.strip():
        raise IperfError("iperf3 produced no output")
    try:
        data, _ = json.JSONDecoder().raw_decode(stdout.lstrip())
    except ValueError as exc:
        raise IperfError(f"could not parse iperf3 output: {exc}") from exc

    if data.get("error"):
        raise IperfError(data["error"])

    end = data.get("end") or {}
    sent = end.get("sum_sent") or end.get("sum") or {}
    received = end.get("sum_received") or end.get("sum") or {}

    bps = received.get("bits_per_second") or sent.get("bits_per_second") or 0
    out = {
        "mbps": round(bps / 1e6, 2),
        "retransmits": sent.get("retransmits"),
        "jitter_ms": round(received["jitter_ms"], 3)
                     if received.get("jitter_ms") is not None else None,
        "loss_pct": round(received["lost_percent"], 2)
                    if received.get("lost_percent") is not None else None,
        "rtt_ms": None,
        "bytes": received.get("bytes") or sent.get("bytes"),
        "raw": data,
    }

    # RTT is only populated on the "up" legs: with -R the sender is on the far
    # side, so there is nothing local to measure.
    streams = end.get("streams") or []
    if streams:
        mean_rtt = (streams[0].get("sender") or {}).get("mean_rtt")
        if mean_rtt:
            out["rtt_ms"] = round(mean_rtt / 1000.0, 3)

    intervals = []
    for iv in data.get("intervals") or []:
        s = iv.get("sum") or {}
        if s.get("bits_per_second") is not None:
            intervals.append({
                "t": round(s.get("end", 0), 1),
                "mbps": round(s["bits_per_second"] / 1e6, 2),
            })
    out["intervals"] = intervals
    return out


class IperfRunner:
    def __init__(self, config, store=None, events=None, signal_poller=None,
                 log_root=None):
        cfg = config.as_dict() if hasattr(config, "as_dict") else (config or {})
        speed = cfg.get("speedtest") or {}
        vx = cfg.get("vxlan") or {}
        modem = cfg.get("modem") or {}

        self.server = speed.get("server") or vx.get("core_ip") or "10.45.0.1"
        self.port = speed.get("port", 5201)
        self.duration = speed.get("duration", 10)
        self.iface = modem.get("wwan_interface", "wwan0")
        self.store = store
        self.events = events
        self.signal_poller = signal_poller
        # Not expanduser("~"): the daemon runs as root, so that resolved to
        # /root and the runs landed somewhere the operator would never look.
        # Configured path first, then beside the state file.
        self.log_root = (log_root or speed.get("log_dir")
                         or os.path.join(
                             os.path.dirname(cfg.get("state_file")
                                             or "/var/lib/tsn5g-ue/state.json"),
                             "iperf_logs"))
        self._current = None

    # -- read model ---------------------------------------------------------
    def defaults(self):
        return {
            "server": self.server, "port": self.port, "duration": self.duration,
            "bind_iface": self.iface, "bind_address": bind_address(self.iface),
            "legs": DEFAULT_LEGS, "udp_rate": DEFAULT_UDP_RATE,
            "length": DEFAULT_LENGTH, "log_root": self.log_root,
            # Every local address, so the client can be chosen from a list
            # instead of typed. The bearer is the default, not the only option.
            "client_addresses": local_addresses(),
        }

    def current(self):
        return self._current

    # -- one leg ------------------------------------------------------------
    def run_leg(self, spec, run_dir=None, seq=1, ctx=None, cancel=None):
        bind, source = resolve_bind(spec, self.iface)
        if not bind:
            raise IperfError(
                f"{self.iface} has no IPv4 address. Bring the bearer up first, "
                f"or set a client address explicitly — without -B the test "
                f"would measure the wired interface and report it as 5G.")

        # Fail in a second with the cause rather than in thirty with a timeout.
        path = check_path(bind, spec["server"])
        if path.get("ok") is False:
            raise IperfError(path.get("reason")
                             or f"no route from {bind} to {spec['server']}")
        if ctx and path.get("dev"):
            ctx.log(f"client {bind} ({source}) -> {spec['server']} "
                    f"via {path['dev']}")

        cmd = build_command(spec, bind)
        leg = f"{spec['proto']}-{spec['dir']}"
        if ctx:
            ctx.log(f"$ {' '.join(cmd)}")

        started = time.time()
        radio = self._radio_sample()
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=spec.get("duration", 30) + 30)
        except subprocess.TimeoutExpired as exc:
            raise IperfError(f"{leg}: iperf3 did not finish in time") from exc

        row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(started)),
               "seq": seq, "leg": leg, "proto": spec["proto"], "dir": spec["dir"],
               "rsrp_dbm": radio.get("rsrp"), "sinr_db": radio.get("sinr"),
               "status": "ok"}

        json_path = None
        if run_dir:
            json_path = os.path.join(run_dir, f"{seq:04d}_{leg}.json")
            try:
                with open(json_path, "w", encoding="utf-8") as fh:
                    fh.write(proc.stdout or "")
            except OSError as exc:
                logger.debug("could not write %s: %s", json_path, exc)

        if proc.returncode != 0 and not (proc.stdout or "").strip():
            row["status"] = "failed"
            detail = (proc.stderr or "").strip()[:200]
            if ctx:
                ctx.log(f"{leg}: FAILED — {detail or 'iperf3 exited ' + str(proc.returncode)}")
            self._diagnose_failure(ctx, error=detail)
            return {**row, "error": detail, "bind": bind, "json_path": json_path}

        try:
            result = parse_result(proc.stdout)
        except IperfError as exc:
            row["status"] = "failed"
            if ctx:
                ctx.log(f"{leg}: {exc}")
            self._diagnose_failure(ctx, error=str(exc))
            return {**row, "error": str(exc), "bind": bind, "json_path": json_path}

        row.update({k: result[k] for k in
                    ("mbps", "retransmits", "rtt_ms", "jitter_ms", "loss_pct")})
        row["bind"] = bind
        row["json_path"] = json_path
        row["intervals"] = result["intervals"]

        if ctx:
            bits = [f"{row['mbps']} Mbit/s"]
            if row.get("retransmits") is not None:
                bits.append(f"retr {row['retransmits']}")
            if row.get("rtt_ms"):
                bits.append(f"rtt {row['rtt_ms']} ms")
            if row.get("loss_pct") is not None:
                bits.append(f"loss {row['loss_pct']}%")
            ctx.log(f"{leg}: " + "  ".join(bits))
        return row

    def _radio_sample(self):
        """RSRP/SINR alongside the throughput number.

        This is the correlation iperf5g.sh's CSV exists for: a slow run at
        RSRP -110 means something different from a slow run at -85.
        """
        if self.signal_poller is None:
            return {}
        try:
            s = self.signal_poller.current()
            return {"rsrp": s.get("rsrp"), "sinr": s.get("sinr")}
        except Exception:               # noqa: BLE001
            return {}

    def _diagnose_failure(self, ctx, error=None):
        """Say what actually went wrong, rather than a generic hint.

        This used to add "the far side is likely down" to every reachable-server
        failure, including ones where iperf3 had already said the server was
        busy — so the log contradicted itself and pointed at the wrong thing.
        A failure that names its own cause does not need a guess appended.
        """
        if not ctx:
            return
        text = (error or "").lower()
        if "busy" in text:
            ctx.log(f"{self.server} is running someone else's test — iperf3 "
                    f"serves one at a time. Nothing here is wrong; wait, or "
                    f"start a second server on another port.")
            return
        if "refused" in text:
            ctx.log(f"{self.server} refused the connection — it is reachable "
                    f"but nothing is listening on that port.")
            return

        proc = utils.run(["ping", "-I", self.iface, "-c", "2", "-W", "2",
                          self.server], check=False, timeout=15)
        if proc.returncode == 0:
            ctx.log("the server answers ICMP, so the bearer is up and the "
                    "problem is on the far side (is iperf3 -s running?)")
        else:
            ctx.log(f"no response from {self.server} over {self.iface} — the "
                    f"bearer is down, not the server")

    # -- a full run ----------------------------------------------------------
    def run(self, spec, ctx=None):
        """One pass over the requested legs, written to disk as the script does."""
        legs = spec.get("legs") or [f"{spec.get('proto','tcp')}-{spec.get('dir','up')}"]
        run_id = time.strftime("%Y%m%d-%H%M%S")
        run_dir = os.path.join(self.log_root, run_id)
        try:
            os.makedirs(run_dir, exist_ok=True)
        except OSError as exc:
            raise IperfError(f"could not create {run_dir}: {exc}") from exc

        csv_path = os.path.join(run_dir, "summary.csv")
        new_file = not os.path.exists(csv_path)
        if ctx:
            ctx.plan([l for l in legs])
            ctx.log(f"writing to {run_dir}")

        self._record_run(run_id, run_dir, spec, "running")
        rows = []
        try:
            with open(csv_path, "a", encoding="utf-8", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=CSV_HEADER,
                                        extrasaction="ignore",
                                        lineterminator="\n")
                if new_file:
                    writer.writeheader()
                for leg in legs:
                    if ctx:
                        ctx.check_cancel()
                        ctx.step(leg, f"{spec.get('duration', self.duration)}s")
                    proto, direction = leg.split("-", 1)
                    leg_spec = {
                        **spec, "proto": proto, "dir": direction,
                        "server": spec.get("server") or self.server,
                        "port": spec.get("port") or self.port,
                        "duration": spec.get("duration") or self.duration,
                    }
                    row = self.run_leg(leg_spec, run_dir=run_dir,
                                       seq=spec.get("seq", 1), ctx=ctx)
                    rows.append(row)
                    writer.writerow(row)
                    fh.flush()
                    self._store_leg(run_id, row)
                    self._publish({"run": run_id, "leg": row})
        finally:
            self._record_run(run_id, run_dir, spec, "finished")

        return {"run_id": run_id, "dir": run_dir, "legs": rows}

    def loop(self, spec, ctx):
        """iperf5g.sh's continuous cycle. Runs until cancelled."""
        run_id = time.strftime("%Y%m%d-%H%M%S")
        run_dir = os.path.join(self.log_root, run_id)
        os.makedirs(run_dir, exist_ok=True)
        csv_path = os.path.join(run_dir, "summary.csv")
        legs = spec.get("legs") or DEFAULT_LEGS

        ctx.plan(["cycling"])
        ctx.step("cycling", f"{', '.join(legs)} — runs until cancelled")
        ctx.log(f"writing to {run_dir}")
        self._record_run(run_id, run_dir, spec, "running")

        seq = 0
        try:
            with open(csv_path, "a", encoding="utf-8", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=CSV_HEADER,
                                        extrasaction="ignore",
                                        lineterminator="\n")
                writer.writeheader()
                fh.flush()
                while True:
                    ctx.check_cancel()
                    seq += 1
                    ctx.log(f"--- cycle {seq} ---")
                    for leg in legs:
                        # Cancel between legs, never mid-leg: the script traps
                        # INT the same way, and a half-finished leg is a row of
                        # nonsense rather than a shorter measurement.
                        ctx.check_cancel()
                        proto, direction = leg.split("-", 1)
                        leg_spec = {
                            **spec, "proto": proto, "dir": direction,
                            "server": spec.get("server") or self.server,
                            "port": spec.get("port") or self.port,
                            "duration": spec.get("duration") or self.duration,
                        }
                        row = self.run_leg(leg_spec, run_dir=run_dir, seq=seq,
                                           ctx=ctx)
                        writer.writerow(row)
                        fh.flush()
                        self._store_leg(run_id, row)
                        self._publish({"run": run_id, "leg": row})
                    if row.get("status") == "failed":
                        ctx.log("waiting 10s after a failure before retrying")
                        time.sleep(10)
        finally:
            self._record_run(run_id, run_dir, spec, "stopped")
            ctx.log(f"stopped after {seq} cycle(s); CSV at {csv_path}")
        return {"run_id": run_id, "dir": run_dir, "cycles": seq}

    # -- persistence ---------------------------------------------------------
    def _record_run(self, run_id, run_dir, spec, state):
        self._current = {"run_id": run_id, "dir": run_dir, "state": state,
                         "spec": spec, "ts": time.time()}
        if self.store is None:
            return
        try:
            self.store.write_iperf_run({
                "id": run_id, "started": time.time(), "finished": None,
                "mode": spec.get("mode", "run"), "params": spec,
                "outdir": run_dir, "state": state, "job_id": spec.get("job_id"),
            })
        except Exception:               # noqa: BLE001
            logger.debug("could not record the run", exc_info=True)

    def _store_leg(self, run_id, row):
        if self.store is None:
            return
        try:
            self.store.write_iperf_leg(run_id, {**row, "ts": time.time()})
        except Exception:               # noqa: BLE001
            logger.debug("could not record the leg", exc_info=True)

    def _publish(self, data):
        if self.events is None:
            return
        try:
            from ..core.events import TOPIC_IPERF
            self.events.publish(TOPIC_IPERF, data)
        except Exception:               # noqa: BLE001
            pass

    # -- history --------------------------------------------------------------
    def runs(self, limit=50):
        """Recorded runs, plus any directory on disk we have no row for.

        The existing iperf_logs/ directories predate this daemon, so they are
        listed too rather than being invisible.
        """
        seen = {}
        if self.store is not None:
            for r in self.store.iperf_runs(limit=limit):
                seen[r["id"]] = {**r, "source": "db"}
        try:
            for name in sorted(os.listdir(self.log_root), reverse=True):
                path = os.path.join(self.log_root, name)
                if name in seen or not os.path.isdir(path):
                    continue
                csv_path = os.path.join(path, "summary.csv")
                if not os.path.exists(csv_path):
                    continue
                seen[name] = {"id": name, "outdir": path, "state": "archived",
                              "source": "disk",
                              "started": _run_started(name, path)}
        except OSError:
            pass
        out = sorted(seen.values(), key=lambda r: r.get("started") or 0,
                     reverse=True)
        return out[:limit]

    def legs(self, run_id, limit=500):
        """Rows for one run, read from its CSV so archived runs work too."""
        if self.store is not None:
            rows = self.store.iperf_legs(run_id)
            if rows:
                return rows[:limit]
        path = os.path.join(self.log_root, run_id, "summary.csv")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return list(csv.DictReader(fh))[:limit]
        except OSError as exc:
            raise IperfError(f"no rows for {run_id}: {exc}") from exc

    def summary_csv(self, run_id):
        path = os.path.join(self.log_root, run_id, "summary.csv")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read()
        except OSError as exc:
            raise IperfError(f"no summary.csv for {run_id}: {exc}") from exc
