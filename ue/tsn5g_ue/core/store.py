"""
Durable history: signal samples, iperf runs, jobs, audit trail.

SQLite because the signal series forces it. A 2 s poll is ~43k rows/day and the
UI asks for "RSRP over the last 6 hours, downsampled" — that is a GROUP BY, or
it is a hand-rolled ring-file format plus a hand-rolled downsampler. It also
gives the correlated "throughput against radio conditions" query that is the
entire point of collecting both.

Writes go through a **single background thread** draining a queue. Callers never
block on the disk and never see "database is locked": producers are the modem
poller and job workers, and neither can afford to wait on fsync. Reads open
their own short-lived connection, which WAL makes safe against the writer.

iperf artefacts stay on disk in the layout iperf5g.sh already uses
(``iperf_logs/<stamp>/summary.csv`` plus per-leg JSON). This holds the index;
the files hold the evidence, and stay readable by anything that reads CSV.
"""

import json
import logging
import os
import queue
import sqlite3
import threading
import time

logger = logging.getLogger("tsn5g-ue.store")

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS signal (
    ts     REAL NOT NULL,
    rsrp   INTEGER, rsrq INTEGER, sinr INTEGER, rssi INTEGER,
    rat    TEXT, band TEXT, arfcn INTEGER, pci INTEGER, cellid TEXT
);
CREATE INDEX IF NOT EXISTS signal_ts ON signal(ts);

CREATE TABLE IF NOT EXISTS iperf_run (
    id          TEXT PRIMARY KEY,
    started     REAL, finished REAL,
    mode        TEXT,
    params_json TEXT,
    outdir      TEXT,
    state       TEXT,
    job_id      TEXT
);
CREATE INDEX IF NOT EXISTS iperf_run_started ON iperf_run(started);

CREATE TABLE IF NOT EXISTS iperf_leg (
    run_id      TEXT NOT NULL,
    seq         INTEGER, leg TEXT, proto TEXT, dir TEXT, ts REAL,
    mbps        REAL, retransmits INTEGER, rtt_ms REAL,
    jitter_ms   REAL, loss_pct REAL,
    rsrp        INTEGER, sinr INTEGER,
    status      TEXT, json_path TEXT
);
CREATE INDEX IF NOT EXISTS iperf_leg_run ON iperf_leg(run_id, seq);

CREATE TABLE IF NOT EXISTS job (
    id          TEXT PRIMARY KEY,
    kind        TEXT, lane TEXT,
    params_json TEXT, state TEXT, result_json TEXT, error TEXT,
    created     REAL, started REAL, finished REAL,
    log_text    TEXT
);
CREATE INDEX IF NOT EXISTS job_created ON job(created);

CREATE TABLE IF NOT EXISTS audit (
    ts       REAL NOT NULL,
    actor    TEXT, kind TEXT, target TEXT, cmd TEXT,
    rc       INTEGER, out_head TEXT, err_head TEXT, ms REAL,
    denied   INTEGER DEFAULT 0, reason TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
"""

# Retention, applied on a nightly tick.
RETAIN_SIGNAL_DAYS = 14
RETAIN_AUDIT_DAYS = 7
RETAIN_JOBS = 1000


class Store:
    """SQLite history with a single writer thread."""

    def __init__(self, path, queue_size=4096):
        self.path = path
        self._q = queue.Queue(maxsize=queue_size)
        self._thread = None
        self._stop = threading.Event()
        self._dropped = 0
        self._writes = 0
        self._available = False

    # -- lifecycle ----------------------------------------------------------
    def start(self):
        parent = os.path.dirname(self.path)
        if parent:
            try:
                os.makedirs(parent, exist_ok=True)
            except OSError as exc:
                # A UE that cannot write history must still route packets.
                logger.warning("history disabled: cannot create %s: %s", parent, exc)
                return self
        try:
            conn = self._connect()
            conn.executescript(_SCHEMA)
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema', ?)",
                         (str(SCHEMA_VERSION),))
            conn.commit()
            conn.close()
        except sqlite3.Error as exc:
            logger.warning("history disabled: %s", exc)
            return self

        self._available = True
        self._thread = threading.Thread(target=self._writer, name="store-writer",
                                        daemon=True)
        self._thread.start()
        logger.info("history at %s", self.path)
        return self

    def stop(self, timeout=5.0):
        if self._thread is None:
            return
        self._stop.set()
        self._q.put(None)                       # wake the writer
        self._thread.join(timeout)
        self._thread = None

    @property
    def available(self):
        return self._available

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        # WAL lets readers run while the writer thread holds a transaction.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    # -- write path ---------------------------------------------------------
    def _submit(self, sql, params):
        if not self._available:
            return
        try:
            self._q.put_nowait((sql, params))
        except queue.Full:
            # Telemetry is not worth backpressuring the modem poller over.
            self._dropped += 1
            if self._dropped % 100 == 1:
                logger.warning("history queue full; dropped %d rows", self._dropped)

    def _writer(self):
        conn = self._connect()
        pending = 0
        last_commit = time.monotonic()
        try:
            while True:
                try:
                    item = self._q.get(timeout=0.5)
                except queue.Empty:
                    item = None
                if item is not None:
                    sql, params = item
                    try:
                        conn.execute(sql, params)
                        pending += 1
                        self._writes += 1
                    except sqlite3.Error as exc:
                        logger.debug("history write failed: %s", exc)
                # Batch commits: a 2 s signal poll does not need an fsync each.
                now = time.monotonic()
                if pending and (pending >= 64 or now - last_commit >= 1.0):
                    try:
                        conn.commit()
                    except sqlite3.Error:
                        pass
                    pending = 0
                    last_commit = now
                if self._stop.is_set() and self._q.empty():
                    break
        finally:
            try:
                conn.commit()
                conn.close()
            except sqlite3.Error:
                pass

    # -- writers ------------------------------------------------------------
    def write_signal(self, s):
        self._submit(
            "INSERT INTO signal(ts,rsrp,rsrq,sinr,rssi,rat,band,arfcn,pci,cellid)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (s.get("ts") or time.time(), s.get("rsrp"), s.get("rsrq"),
             s.get("sinr"), s.get("rssi"), s.get("rat"), s.get("band"),
             s.get("arfcn"), s.get("pci"), s.get("cellid")))

    def write_audit(self, e):
        self._submit(
            "INSERT INTO audit(ts,actor,kind,target,cmd,rc,out_head,err_head,ms,denied,reason)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (e.get("ts") or time.time(), e.get("actor"), e.get("kind"),
             e.get("target"), e.get("cmd"), e.get("rc"), e.get("out_head"),
             e.get("err_head"), e.get("ms"), 1 if e.get("denied") else 0,
             e.get("reason")))

    def write_job(self, j):
        self._submit(
            "INSERT OR REPLACE INTO job(id,kind,lane,params_json,state,result_json,"
            "error,created,started,finished,log_text) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (j["id"], j["kind"], j["lane"], json.dumps(j.get("params") or {}),
             j["state"], json.dumps(j.get("result")), j.get("error"),
             j.get("created"), j.get("started"), j.get("finished"),
             "\n".join(j.get("lines") or [])))

    def write_iperf_run(self, r):
        self._submit(
            "INSERT OR REPLACE INTO iperf_run(id,started,finished,mode,params_json,"
            "outdir,state,job_id) VALUES(?,?,?,?,?,?,?,?)",
            (r["id"], r.get("started"), r.get("finished"), r.get("mode"),
             json.dumps(r.get("params") or {}), r.get("outdir"),
             r.get("state"), r.get("job_id")))

    def write_iperf_leg(self, run_id, lg):
        self._submit(
            "INSERT INTO iperf_leg(run_id,seq,leg,proto,dir,ts,mbps,retransmits,"
            "rtt_ms,jitter_ms,loss_pct,rsrp,sinr,status,json_path)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, lg.get("seq"), lg.get("leg"), lg.get("proto"), lg.get("dir"),
             lg.get("ts"), lg.get("mbps"), lg.get("retransmits"), lg.get("rtt_ms"),
             lg.get("jitter_ms"), lg.get("loss_pct"), lg.get("rsrp"), lg.get("sinr"),
             lg.get("status"), lg.get("json_path")))

    # -- read path ----------------------------------------------------------
    def _query(self, sql, params=()):
        if not self._available:
            return []
        try:
            conn = self._connect()
            try:
                return [dict(r) for r in conn.execute(sql, params).fetchall()]
            finally:
                conn.close()
        except sqlite3.Error as exc:
            logger.debug("history query failed: %s", exc)
            return []

    def signal_history(self, since=None, until=None, step=None, limit=2000):
        """Signal samples, optionally bucketed into `step`-second averages.

        Downsampling happens in SQL: a 24-hour window at 2 s is 43k rows, and
        the UI wants a few hundred points.
        """
        since = since if since is not None else time.time() - 3600
        until = until if until is not None else time.time() + 1
        if step and step > 0:
            rows = self._query(
                "SELECT CAST(ts/? AS INTEGER)*? AS ts,"
                "  ROUND(AVG(rsrp),1) AS rsrp, ROUND(AVG(rsrq),1) AS rsrq,"
                "  ROUND(AVG(sinr),1) AS sinr, ROUND(AVG(rssi),1) AS rssi,"
                "  MIN(rsrp) AS rsrp_min, MAX(rsrp) AS rsrp_max,"
                "  COUNT(*) AS n"
                " FROM signal WHERE ts>=? AND ts<=?"
                " GROUP BY CAST(ts/? AS INTEGER) ORDER BY ts LIMIT ?",
                (step, step, since, until, step, limit))
        else:
            rows = self._query(
                "SELECT * FROM signal WHERE ts>=? AND ts<=? ORDER BY ts LIMIT ?",
                (since, until, limit))
        return rows

    def jobs(self, limit=50, kind=None, state=None):
        sql = "SELECT * FROM job WHERE 1=1"
        params = []
        if kind:
            sql += " AND kind=?"; params.append(kind)
        if state:
            sql += " AND state=?"; params.append(state)
        sql += " ORDER BY created DESC LIMIT ?"; params.append(limit)
        return self._query(sql, tuple(params))

    def audit(self, limit=100, kind=None):
        sql = "SELECT * FROM audit WHERE 1=1"
        params = []
        if kind:
            sql += " AND kind=?"; params.append(kind)
        sql += " ORDER BY ts DESC LIMIT ?"; params.append(limit)
        return self._query(sql, tuple(params))

    def iperf_runs(self, limit=50):
        return self._query("SELECT * FROM iperf_run ORDER BY started DESC LIMIT ?",
                           (limit,))

    def iperf_legs(self, run_id, since_seq=None, leg=None):
        sql = "SELECT * FROM iperf_leg WHERE run_id=?"
        params = [run_id]
        if since_seq is not None:
            sql += " AND seq>?"; params.append(since_seq)
        if leg:
            sql += " AND leg=?"; params.append(leg)
        sql += " ORDER BY seq, leg"
        return self._query(sql, tuple(params))

    # -- housekeeping -------------------------------------------------------
    def prune(self):
        now = time.time()
        self._submit("DELETE FROM signal WHERE ts < ?",
                     (now - RETAIN_SIGNAL_DAYS * 86400,))
        self._submit("DELETE FROM audit WHERE ts < ?",
                     (now - RETAIN_AUDIT_DAYS * 86400,))
        self._submit(
            "DELETE FROM job WHERE id NOT IN "
            "(SELECT id FROM job ORDER BY created DESC LIMIT ?)", (RETAIN_JOBS,))

    def stats(self):
        if not self._available:
            return {"available": False}
        counts = {}
        for t in ("signal", "iperf_run", "iperf_leg", "job", "audit"):
            rows = self._query(f"SELECT COUNT(*) AS n FROM {t}")
            counts[t] = rows[0]["n"] if rows else 0
        try:
            size = os.path.getsize(self.path)
        except OSError:
            size = 0
        return {"available": True, "path": self.path, "bytes": size,
                "rows": counts, "queued": self._q.qsize(),
                "written": self._writes, "dropped": self._dropped}
