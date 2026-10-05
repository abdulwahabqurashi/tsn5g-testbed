/**
 * The only place that turns incoming events into state.
 *
 * Views subscribe to the store (or, for high-rate things, to the bus); nothing
 * else writes. Keeping the write path in one file is what makes it possible to
 * say where any value on screen came from.
 */

import { LOG_CAP, pushSample, totalRates } from "./state.js";

export function wireTelemetry({ bus, store }) {
  // -- controller snapshot ------------------------------------------------
  bus.on("state", (status) => {
    store.patch({ status });
    if (status?.jobs?.active) {
      store.patch({ jobs: { active: status.jobs.active } });
    }
    const offset = status?.gptp?.offset_ns;
    if (offset !== null && offset !== undefined) {
      store.patch({ series: { offset: pushSample(store.get().series.offset, offset) } });
    }
  });

  bus.on("health", (health) => store.patch({ health }));

  // -- interface counters and the link probe ------------------------------
  bus.on("stats", (stats) => {
    const now = Date.now();
    // The 5G link's own counters when it is up; every NIC summed otherwise.
    const wwan = store.get().status?.modem?.wwan_interface || "wwan0";
    const { rx, tx } = totalRates(stats, wwan);
    const series = store.get().series;
    const next = {
      // "down" is what arrives at the UE, i.e. rx.
      dl: pushSample(series.dl, rx / 1e6, now),
      ul: pushSample(series.ul, tx / 1e6, now),
      latency: series.latency,
      offset: series.offset,
    };
    const latency = stats?.link?.latency_ms;
    if (latency !== null && latency !== undefined) {
      next.latency = pushSample(series.latency, latency, now);
    }
    store.patch({ stats, series: next });
  });

  // -- radio --------------------------------------------------------------
  bus.on("signal", (sample) => {
    const { history } = store.get().signal;
    const capped = history.concat([sample]).slice(-600);
    store.patch({ signal: { latest: sample, history: capped } });
  });

  // -- jobs ---------------------------------------------------------------
  bus.on("job", (evt) => {
    const { recent } = store.get().jobs;
    const without = recent.filter((j) => j.job_id !== evt.job_id);
    store.patch({ jobs: { recent: [evt, ...without].slice(0, 25) } });
  });

  // -- logs ---------------------------------------------------------------
  // Appended to the store because the Logs view needs backfill on mount, but
  // the view listens to the bus directly for live lines so it can append one
  // node rather than re-render the pane per line.
  bus.on("log", (entry) => {
    const { lines, paused } = store.get().logs;
    if (paused) return;
    const next = lines.concat([entry]);
    store.patch({
      logs: {
        lines: next.length > LOG_CAP ? next.slice(-LOG_CAP) : next,
        lastId: entry.id || store.get().logs.lastId,
      },
    });
  });

  bus.on("alert", (alert) => {
    console.warn("alert", alert);
  });
}

/** One-shot fetches that do not stream: config, discovery, version. */
export async function loadStatics({ api, store }) {
  const results = await Promise.allSettled([
    api.config.get(), api.discovery(), api.version(),
  ]);
  const [config, discovery, version] = results;
  const patch = {};
  if (config.status === "fulfilled") patch.config = config.value;
  if (discovery.status === "fulfilled") patch.discovery = discovery.value;
  if (version.status === "fulfilled") patch.version = version.value;
  if (Object.keys(patch).length) store.patch(patch);

  for (const r of results) {
    if (r.status === "rejected") console.warn("static load failed:", r.reason?.message);
  }
}
