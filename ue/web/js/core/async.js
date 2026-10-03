/**
 * One convention for every asynchronous surface: skeleton, ready, empty, error.
 *
 * The old code had eight `catch (_) {}` sites. Each one produced an empty
 * panel with no indication that anything had failed, which is worse than a
 * visible error — you cannot tell "no interfaces" from "the request died".
 * scripts/lint-js.sh now fails on an empty catch block; this is what replaces
 * them.
 *
 * The error state always shows the backend's own message, plus method, path
 * and status in a collapsed disclosure, plus a Retry that re-runs the load.
 */

import { ApiError } from "./api.js";
import { clear, h } from "./dom.js";

function skeleton(rows) {
  return h("div", { class: "skeleton-wrap", "aria-busy": "true", "aria-live": "polite" },
    ...Array.from({ length: rows }, (_, i) => h("div", {
      class: "skeleton-row",
      style: { width: `${100 - (i % 3) * 14}%` },
    })));
}

function errorPane(err, onRetry) {
  const isApi = err instanceof ApiError;
  const kids = [
    h("div", { class: "state-icon err", text: "!" }),
    h("div", { class: "state-msg" }, err?.message || "Something went wrong"),
  ];

  if (isApi) {
    const bits = [`${err.method} ${err.path}`, err.status ? `HTTP ${err.status}` : "no response"];
    kids.push(h("details", { class: "state-detail" },
      h("summary", { text: "Details" }),
      h("pre", { class: "log", text: [bits.join("  ·  "), err.detail || ""].join("\n").trim() })));
  }

  if (onRetry) {
    kids.push(h("button", { class: "btn", onclick: onRetry, text: "Retry" }));
  }
  return h("div", { class: "state-pane" }, ...kids);
}

function emptyPane(text, action) {
  return h("div", { class: "state-pane" },
    h("div", { class: "state-icon", text: "∅" }),
    h("div", { class: "state-msg muted" }, text),
    action || null);
}

/**
 * asyncSection(host, {
 *   load:   (signal) => api.iface.list({ signal }),
 *   render: (data, host) => { ... },
 *   empty:  (data) => !data.interfaces.length,
 *   emptyText: "No interfaces detected.",
 *   signal: view.signal,
 * })
 *
 * Returns a reload() so callers can refresh without rebuilding the view.
 */
export function asyncSection(host, opts) {
  const {
    load, render, empty, emptyText = "Nothing to show.",
    emptyAction = null, skeletonRows = 4, signal,
  } = opts;

  let generation = 0;

  async function run() {
    const mine = ++generation;
    clear(host);
    host.appendChild(skeleton(skeletonRows));

    let data;
    try {
      data = await load(signal);
    } catch (err) {
      if (mine !== generation) return;
      if (err instanceof ApiError && err.isAborted) return;  // navigated away
      clear(host);
      host.appendChild(errorPane(err, run));
      return;
    }
    if (mine !== generation) return;

    clear(host);
    if (empty && empty(data)) {
      host.appendChild(emptyPane(emptyText, emptyAction));
      return;
    }
    try {
      render(data, host);
    } catch (err) {
      console.error("render threw", err);
      clear(host);
      host.appendChild(errorPane(err, run));
    }
  }

  run();
  return { reload: run };
}

export { errorPane, emptyPane, skeleton };
