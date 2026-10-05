/**
 * The shape of application state, and the history rings.
 *
 * `series` is deliberately time-stamped rather than index-based. The old
 * recordHistory() pushed values into flat arrays and was skipped entirely when
 * a poll failed, so a dropped sample silently compressed the chart instead of
 * showing a gap — you could not tell a slow link from a dead backend.
 */

import { createStore } from "../core/store.js";

export const HISTORY_WINDOW_MS = 5 * 60 * 1000;   // charts show the last 5 minutes
export const LOG_CAP = 2000;                       // lines kept in the Logs view

export function initialState() {
  return {
    conn: { transport: "idle", lastEventAt: 0, error: null },
    status: null,
    health: null,
    stats: null,
    discovery: null,
    config: null,
    version: null,

    // [{t, v}] rings, trimmed by time rather than count
    series: { ul: [], dl: [], latency: [], offset: [] },

    signal: { latest: null, history: [] },
    jobs: { active: {}, recent: [] },
    logs: { lines: [], level: "info", paused: false, lastId: 0 },
    ui: { theme: "auto", density: "desktop", route: "dashboard", title: "Overview" },
  };
}

export function createAppStore() {
  return createStore(initialState());
}

/** Append a time-stamped sample and drop anything older than the window. */
export function pushSample(ring, value, now = Date.now()) {
  if (value === null || value === undefined || Number.isNaN(value)) return ring;
  const next = ring.concat([{ t: now, v: Number(value) }]);
  const cutoff = now - HISTORY_WINDOW_MS;
  let i = 0;
  while (i < next.length && next[i].t < cutoff) i += 1;
  return i ? next.slice(i) : next;
}

/** rx/tx bits-per-second of `only` if the backend reports it, else of every interface. */
export function totalRates(stats, only) {
  let rx = 0;
  let tx = 0;
  const all = stats?.interfaces || {};
  for (const iface of only && all[only] ? [all[only]] : Object.values(all)) {
    rx += Number(iface.rx_bytes_per_s || 0);
    tx += Number(iface.tx_bytes_per_s || 0);
  }
  // bytes/s -> bits/s
  return { rx: rx * 8, tx: tx * 8 };
}
