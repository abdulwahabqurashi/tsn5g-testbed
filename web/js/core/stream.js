/**
 * Live data: one SSE stream, with a polling driver as a permanent fallback.
 *
 * Exactly one EventSource per tab. HTTP/1.1 caps a browser at ~6 connections
 * per origin, so a stream per view would starve the tab's own requests — and
 * the server caps concurrent streams at 8 anyway.
 *
 * The watchdog is not paranoia. An EventSource can sit in readyState OPEN on a
 * TCP connection that is already dead, with no error event ever firing. The
 * server sends `: ping` every 15 s, so 25 s of silence means dead regardless of
 * what readyState claims.
 *
 * The polling driver stays even once SSE works. A broken stream should degrade
 * to slower updates, not to a blank UI.
 */

const TOPICS = ["state", "job", "modem", "signal", "bearer", "stats", "iperf",
                "log", "audit", "alert"];

const SILENCE_LIMIT = 25000;   // server pings every 15s
const POLL_INTERVAL = 2000;
const POLL_BACKOFF = 10000;
const MAX_SSE_FAILURES = 3;

export function createStream({ api, bus, store, url = "/api/events" }) {
  let es = null;
  let watchdog = null;
  let backoff = 1000;
  let failures = 0;
  let mode = "idle";
  let pollTimer = null;
  let inFlight = false;
  let misses = 0;
  let stopped = false;

  function setConn(transport, error) {
    store.patch({
      conn: {
        transport,
        error: error || null,
        lastEventAt: transport === "sse" || transport === "poll" ? Date.now()
          : store.get().conn?.lastEventAt || 0,
      },
    });
  }

  // -- SSE ----------------------------------------------------------------
  function arm() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      console.warn("SSE silent for 25s — treating as dead");
      es?.close();
      es = null;
      retry();
    }, SILENCE_LIMIT);
  }

  function openSSE() {
    if (stopped) return;
    try {
      es = new EventSource(`${url}?topics=${TOPICS.join(",")}`);
    } catch (err) {
      retry();
      return;
    }

    es.onopen = () => {
      backoff = 1000;
      failures = 0;
      mode = "sse";
      stopPolling();
      setConn("sse");
      arm();
    };

    for (const topic of TOPICS) {
      es.addEventListener(topic, (ev) => {
        arm();
        let data = null;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        bus.emit(topic, data);
      });
    }

    // The server sends this when it had to discard our backlog. Replaying is
    // not possible at that point, so resync from scratch.
    es.addEventListener("overflow", () => {
      console.warn("SSE overflow — resyncing");
      pollOnce();
    });

    es.onerror = () => {
      if (es && es.readyState === EventSource.CLOSED) retry();
    };
  }

  function retry() {
    clearTimeout(watchdog);
    es?.close();
    es = null;
    if (stopped) return;

    setConn("down", "event stream lost");
    failures += 1;
    if (failures >= MAX_SSE_FAILURES) {
      // /api/events is absent or broken. Stop fighting it.
      console.warn("SSE unavailable after 3 attempts — falling back to polling");
      startPolling();
      return;
    }
    setTimeout(openSSE, backoff + Math.random() * 500);
    backoff = Math.min(backoff * 2, 30000);
  }

  // -- polling ------------------------------------------------------------
  async function pollOnce() {
    // Four things the old 2s setInterval got wrong, fixed here:
    //  1. no in-flight guard, so slow responses stacked up
    //  2. no hidden-tab guard, so a background tab kept hammering
    //  3. one failure of three collapsed the whole UI to "Service offline"
    //     and discarded the real message
    //  4. a failed poll skipped recordHistory(), silently compressing the
    //     charts instead of showing a gap
    if (inFlight || document.hidden) return;
    inFlight = true;

    const results = await Promise.allSettled([
      api.status(), api.health(), api.stats(),
    ]);
    inFlight = false;

    const [status, health, stats] = results;
    if (status.status === "fulfilled") bus.emit("state", status.value);
    if (health.status === "fulfilled") bus.emit("health", health.value);
    if (stats.status === "fulfilled") bus.emit("stats", stats.value);

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === results.length) {
      misses += 1;
      setConn("down", failed[0].reason?.message || "service unreachable");
      schedulePoll(misses > 3 ? POLL_BACKOFF : POLL_INTERVAL);
    } else {
      misses = 0;
      if (mode === "poll") setConn("poll");
      schedulePoll(POLL_INTERVAL);
    }
  }

  function schedulePoll(ms) {
    if (stopped || mode !== "poll") return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, ms);
  }

  function startPolling() {
    if (mode === "poll") return;
    mode = "poll";
    setConn("poll");
    pollOnce();
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // -- lifecycle ----------------------------------------------------------
  function start() {
    stopped = false;
    // Seed immediately so the first paint has data, whichever transport wins.
    pollOnce();
    if (typeof EventSource === "undefined") {
      startPolling();
      return;
    }
    openSSE();
    // Stats and state also arrive over SSE, but a slow-changing snapshot is
    // cheap insurance against a topic we forgot to publish.
    setInterval(() => {
      if (mode === "sse" && !document.hidden) api.status().then(
        (s) => bus.emit("state", s),
        () => {},
      );
    }, 30000);
  }

  function stop() {
    stopped = true;
    clearTimeout(watchdog);
    stopPolling();
    es?.close();
    es = null;
  }

  return { start, stop, get mode() { return mode; }, refresh: pollOnce };
}
