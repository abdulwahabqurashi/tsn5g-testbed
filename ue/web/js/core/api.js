/**
 * The one API client.
 *
 * Previously three views re-implemented their own get/post helpers and threw
 * bare `Error("HTTP " + status)`, discarding the backend's `{"error": "..."}`
 * message. A failed static-IP apply read as "HTTP 500" instead of saying what
 * went wrong. Every call goes through here now, and every endpoint path
 * literal in the codebase lives in this file — which is what makes
 * scripts/check-endpoints.py able to verify the UI against a running box.
 *
 * Policies worth stating:
 *   - Retries are GET-only and 5xx-only. POST /api/modem/reset is never retried.
 *   - Every request carries a timeout; slow work is a job, not a slow request.
 *   - onCall feeds the Debug view's request inspector, which is how you tell a
 *     panel showing real data from a panel showing nothing.
 */

export class ApiError extends Error {
  constructor(message, { status, path, method, data, cause } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status ?? 0;
    this.path = path;
    this.method = method;
    this.data = data || null;
    this.cause = cause;
    this.isAborted = cause?.name === "AbortError";
    this.isOffline = this.status === 0 && !this.isAborted;
  }

  /** stderr / traceback / raw body, for a collapsed disclosure. */
  get detail() {
    return this.data?.detail || this.data?.raw || null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.random() * (ms * 0.3);

function cleanQuery(q) {
  const out = {};
  for (const [k, v] of Object.entries(q || {})) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

export function createApi({ base = "", timeout = 8000, fetchImpl, onCall } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function request(method, path, opts = {}) {
    const { body, query, signal, timeout: t = timeout } = opts;
    const retry = opts.retry ?? (method === "GET" ? 2 : 0);
    const qs = query ? new URLSearchParams(cleanQuery(query)).toString() : "";
    const url = base + path + (qs ? `?${qs}` : "");

    let attempt = 0;
    let backoff = 250;

    for (;;) {
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => ctl.abort(), t);
      const t0 = performance.now();

      try {
        const res = await doFetch(url, {
          method,
          signal: ctl.signal,
          headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        const text = await res.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = { raw: text };
          }
        }

        onCall?.({ method, path, status: res.status, ms: performance.now() - t0 });

        if (!res.ok) {
          // Surface what the backend said. api/router.py guarantees an
          // `error` key on every non-2xx.
          const msg = data?.error || res.statusText || `HTTP ${res.status}`;
          throw new ApiError(msg, { status: res.status, path, method, data });
        }
        return data;
      } catch (err) {
        if (err instanceof ApiError) {
          if (attempt++ < retry && [502, 503, 504].includes(err.status)) {
            await sleep(jitter(backoff));
            backoff *= 3;
            continue;
          }
          throw err;
        }
        // Caller-initiated cancellation (navigation) is not a failure.
        if (err.name === "AbortError" && signal?.aborted) {
          throw new ApiError("cancelled", { status: 0, path, method, cause: err });
        }
        onCall?.({ method, path, status: 0, ms: performance.now() - t0 });
        if (attempt++ < retry) {
          await sleep(jitter(backoff));
          backoff *= 3;
          continue;
        }
        throw new ApiError(
          err.name === "AbortError" ? `timed out after ${t} ms` : "service unreachable",
          { status: 0, path, method, cause: err },
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  const GET = (p, o) => request("GET", p, o);
  const POST = (p, body, o) => request("POST", p, { ...o, body: body ?? {} });
  const PUT = (p, body, o) => request("PUT", p, { ...o, body: body ?? {} });
  const DEL = (p, o) => request("DELETE", p, o);

  return {
    request,

    // -- system --------------------------------------------------------
    status: (o) => GET("/api/status", o),
    health: (o) => GET("/api/health", o),
    stats: (o) => GET("/api/stats", o),
    discovery: (o) => GET("/api/discovery", o),
    version: (o) => GET("/api/version", o),
    spec: (o) => GET("/api/spec", o),

    config: {
      get: (o) => GET("/api/config", o),
      update: (patch, o) => PUT("/api/config", patch, o),
    },

    // -- connect sequence ----------------------------------------------
    connect: (body, o) => POST("/api/connect", body, o),
    disconnect: (o) => POST("/api/disconnect", {}, o),
    setupState: (o) => GET("/api/setup/state", o),

    modem: {
      check: (o) => POST("/api/modem/check", {}, o),
      info: (o) => GET("/api/modem", o),
      ports: (o) => GET("/api/modem/ports", o),
      rescan: (o) => POST("/api/modem/ports/rescan", {}, o),
      getPower: (o) => GET("/api/modem/power", o),
      setPower: (body, o) => PUT("/api/modem/power", body, o),
      reset: (body, o) => POST("/api/modem/reset", body, o),
      getManager: (o) => GET("/api/modem/manager", o),
      setManager: (body, o) => PUT("/api/modem/manager", body, o),
      atRules: (o) => GET("/api/modem/at/rules", o),
      // Timeout follows the command's own: a network scan legitimately takes
      // minutes, and cutting it off at the client would look like a failure.
      at: (body, o) => POST("/api/modem/at", body,
                            { ...o, timeout: ((body.timeout || 8) + 5) * 1000 }),
      atHistory: (query, o) => GET("/api/modem/at/history", { ...o, query }),
      releaseBus: (o) => POST("/api/modem/bus/release", {}, o),
    },

    radio: {
      state: (o) => GET("/api/radio", o),
      prefs: (o) => GET("/api/radio/prefs", o),
      setPrefs: (body, o) => PUT("/api/radio/prefs", body, o),
      selectPlmn: (body, o) => POST("/api/radio/plmn/select", body, o),
      forbidden: (o) => GET("/api/radio/plmn/forbidden", o),
      clearForbidden: (plmn, o) =>
        request("DELETE", `/api/radio/plmn/forbidden/${encodeURIComponent(plmn)}`, o),
      lock: (o) => GET("/api/radio/lock", o),
      setLock: (body, o) => PUT("/api/radio/lock", body, o),
      clearLock: (o) => request("DELETE", "/api/radio/lock", o),
      // Scans take minutes; the job returns immediately and progress streams.
      scan: (body, o) => POST("/api/radio/scan", body, o),
      camp: (body, o) => POST("/api/radio/camp/wait", body, o),
      diagnose: (o) => POST("/api/radio/diagnose", {}, o),
      repairBands: (body, o) => POST("/api/radio/band/repair", body, o),
    },

    signal: {
      now: (o) => GET("/api/signal", o),
      sample: (o) => POST("/api/signal/sample", {}, { ...o, timeout: 15000 }),
      history: (query, o) => GET("/api/signal/history", { ...o, query }),
      getPoll: (o) => GET("/api/signal/poll", o),
      setPoll: (body, o) => PUT("/api/signal/poll", body, o),
    },

    transport: {
      start: (body, o) => POST("/api/transport/start", body, o),
      stop: (o) => POST("/api/transport/stop", {}, o),
    },

    gptp: {
      start: (body, o) => POST("/api/gptp/start", body, o),
      stop: (o) => POST("/api/gptp/stop", {}, o),
      restart: (o) => POST("/api/gptp/restart", {}, o),
      status: (o) => GET("/api/ptp/status", o),
      history: (minutes, o) => GET("/api/ptp/history", { ...o, query: { minutes } }),
      settings: (o) => GET("/api/ptp/settings", o),
      saveSettings: (body, o) => PUT("/api/ptp/settings", body, o),
      nics: (o) => GET("/api/ptp/nics", o),
      install: (o) => POST("/api/ptp/dependencies/install", {}, o),
      setup: (body, o) => POST("/api/ptp/setup", body, { ...o, timeout: 15000 }),
    },

    latency: {
      status: (o) => GET("/api/latency", o),
      history: (minutes, o) => GET("/api/latency/history", { ...o, query: { minutes } }),
      set: (body, o) => PUT("/api/latency", body, o),
    },

    tests: {
      catalog: (o) => GET("/api/tests", o),
      run: (id, params, o) => POST(`/api/tests/${encodeURIComponent(id)}/run`, { params }, o),
    },

    results: {
      list: (o) => GET("/api/results", o),
      get: (kind, id, o) => GET(`/api/results/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, o),
    },

    tas: {
      profiles: (o) => GET("/api/tas/profiles", o),
      apply: (body, o) => POST("/api/tas/apply", body, o),
      clear: (body, o) => POST("/api/tas/clear", body, o),
    },

    // -- jobs -----------------------------------------------------------
    jobs: {
      list: (query, o) => GET("/api/jobs", { ...o, query }),
      get: (id, o) => GET(`/api/jobs/${encodeURIComponent(id)}`, o),
      log: (id, since, o) => GET(`/api/jobs/${encodeURIComponent(id)}/log`,
                                 { ...o, query: { since } }),
      cancel: (id, o) => DEL(`/api/jobs/${encodeURIComponent(id)}`, o),
    },

    // -- logs and debug --------------------------------------------------
    logs: {
      tail: (query, o) => GET("/api/logs", { ...o, query }),
      journal: (query, o) => GET("/api/logs/journal", { ...o, query, timeout: 25000 }),
      getLevel: (o) => GET("/api/logs/level", o),
      setLevel: (body, o) => PUT("/api/logs/level", body, o),
    },

    debug: {
      commands: (query, o) => GET("/api/debug/commands", { ...o, query }),
      // Gathers a lot; give it room.
      snapshot: (o) => GET("/api/debug/snapshot", { ...o, timeout: 30000 }),
    },

    events: {
      stats: (o) => GET("/api/events/stats", o),
    },

    // -- network ---------------------------------------------------------
    rig: {
      status: (o) => GET("/api/rig", o),
      netnsEnsure: (o) => POST("/api/rig/netns/ensure", {}, o),
      netnsDown: (body, o) => POST("/api/rig/netns/down", body ?? {}, o),
      encoders: (action, body, o) => POST(`/api/rig/encoders/${encodeURIComponent(action)}`, body ?? {}, o),
      displayUp: (body, o) => POST("/api/rig/display/up", body ?? {}, o),
      natFlush: (o) => POST("/api/rig/nat/flush", {}, o),
      binding: (o) => GET("/api/rig/binding", o),
      setBinding: (body, o) => PUT("/api/rig/binding", body, o),
      setGbr: (body, o) => PUT("/api/rig/gbr", body, o),
      checklist: (o) => GET("/api/rig/checklist", o),
      fix: (step, o) => POST(`/api/rig/fix/${encodeURIComponent(step)}`, {}, o),
      installUnits: (body, o) => POST("/api/rig/units/install", body ?? {}, o),
    },

    bearer: {
      get: (o) => GET("/api/bearer", o),
      queue: (o) => GET("/api/bearer/queue", o),
      setQueue: (body, o) => PUT("/api/bearer/queue", body, o),
      counters: (o) => GET("/api/bearer/counters", o),
      autorate: (o) => GET("/api/bearer/autorate", o),
      setAutorate: (body, o) => PUT("/api/bearer/autorate", body, o),
      cameras: (o) => GET("/api/cameras", o),
      up: (body, o) => POST("/api/bearer/up", body, o),
      down: (body, o) => POST("/api/bearer/down", body, o),
      cycle: (body, o) => POST("/api/bearer/cycle", body, o),
      // Counts each DSCP as it leaves the bearer, after encapsulation. The
      // outer DSCP is what uplink QoS flow binding matches on, so this is the
      // evidence that the marking reaches the wire at all.
      dscpAudit: (o) => GET("/api/bearer/dscp-audit", o),
      dscpAuditStart: (body, o) => POST("/api/bearer/dscp-audit", body ?? {}, o),
      dscpAuditStop: (o) => request("DELETE", "/api/bearer/dscp-audit",
                                    { ...o, body: {} }),
    },

    routing: {
      get: (o) => GET("/api/net/routing-profile", o),
      apply: (body, o) => PUT("/api/net/routing-profile", body, o),
      clear: (body, o) => request("DELETE", "/api/net/routing-profile",
                                  { ...o, body: body ?? {} }),
      verify: (body, o) => POST("/api/net/routing-profile/verify", body,
                                { ...o, timeout: 20000 }),
      routes: (o) => GET("/api/net/routes", o),
    },

    iface: {
      list: (o) => GET("/api/interfaces", o),
      config: (body, o) => POST("/api/interfaces/config", body, o),
    },

    wifi: {
      scan: (o) => GET("/api/wifi/scan", { ...o, timeout: 25000 }),
      connect: (body, o) => POST("/api/wifi/connect", body, o),
    },

    // -- performance -----------------------------------------------------
    iperf: {
      defaults: (o) => GET("/api/iperf/defaults", o),
      path: (body, o) => POST("/api/iperf/path", body, o),
      run: (body, o) => POST("/api/iperf/run", body, o),
      loop: (body, o) => POST("/api/iperf/loop", body, o),
      runs: (query, o) => GET("/api/iperf/runs", { ...o, query }),
      run_: (id, o) => GET(`/api/iperf/runs/${encodeURIComponent(id)}`, o),
      csv: (id, o) => GET(`/api/iperf/runs/${encodeURIComponent(id)}/summary.csv`, o),
    },

    // -- software TSN bridge ---------------------------------------------
    bridge: {
      get: (o) => GET("/api/bridge", o),
      profiles: (query, o) => GET("/api/bridge/profiles", { ...o, query }),
      build: (body, o) => POST("/api/bridge/build", body, o),
      teardown: (body, o) => POST("/api/bridge/teardown", body, o),
      gate: (body, o) => POST("/api/bridge/gate", body, o),
      clearGate: (body, o) => request("DELETE", "/api/bridge/gate", { ...o, body }),
      layouts: (o) => GET("/api/bridge/layouts", o),
      setLayout: (body, o) => POST("/api/bridge/layout", body, o),
      addRule: (body, o) => POST("/api/bridge/rules", body, o),
      delRule: (body, o) => request("DELETE", "/api/bridge/rules", { ...o, body }),
    },

    perf: {
      dummy: (o) => GET("/api/perf/dummy", o),
      startDummy: (body, o) => POST("/api/perf/dummy", body, o),
      stopDummy: (o) => request("DELETE", "/api/perf/dummy", { ...o, body: {} }),
    },

    speedtest: {
      run: (body, o) => POST("/api/speedtest/run", body, o),
      result: (o) => GET("/api/speedtest/result", o),
    },

    // -- TSN switch ------------------------------------------------------
    switch: {
      profiles: (o) => GET("/api/switch/profiles", o),
      status: (query, o) => GET("/api/switch/status", { ...o, query, timeout: 30000 }),
      apply: (body, o) => POST("/api/switch/apply", body, { ...o, timeout: 45000 }),
      disable: (body, o) => POST("/api/switch/disable", body, { ...o, timeout: 45000 }),
    },
  };
}
