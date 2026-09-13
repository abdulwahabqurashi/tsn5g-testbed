/**
 * TEMPORARY window.TSN shim for the pre-module views. DELETE IN PHASE 7.
 *
 * Backs the old global surface with the new implementations, so the legacy
 * views keep working while getting the new behaviour for free: real backend
 * error messages, token-driven chart colours, and no innerHTML.
 *
 * `T.demo` and `T.mock` are deliberately absent. Demo mode is gone from the
 * product — a user-reachable toggle that fakes data is how a screenshot gets
 * mistaken for a working system, and mock.stats() returned a different shape
 * from the live endpoint anyway, so the demo path never exercised real code.
 * Any legacy branch that still reads T.demo now sees `undefined`, which is
 * falsy, so it takes the live path.
 */

import * as charts from "../ui/charts.js";
import { palette } from "../ui/tokens.js";
import { icon } from "../ui/icons.js";
import { closeDrawer, drawer, toast } from "../core/dialog.js";
import { h } from "../core/dom.js";

let installed = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = src;
    tag.async = false;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(tag);
  });
}

/** Old signature: el(tag, attrs, childrenArray) with `html` and `on*` keys. */
function legacyEl(tag, attrs, children) {
  const props = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    if (k === "html") {
      // The one place the old API allowed raw HTML. Only icon markup and
      // legend swatches ever used it; both are literals from our own code.
      props.__html = v;
    } else {
      props[k] = v;
    }
  }
  const html = props.__html;
  delete props.__html;

  const node = h(tag, props, ...(children || []));
  if (html !== undefined) node.innerHTML = html;   // eslint-disable-line no-unsanitized/property
  return node;
}

export async function installShim({ api, store, navigate } = {}) {
  if (installed) return installed;

  const T = window.TSN || (window.TSN = {});
  T.views = T.views || {};

  T.charts = {
    area: charts.area,
    spark: charts.spark,
    gauge: charts.gauge,
    meter: charts.meter,
    gateTimeline: charts.gateTimeline,
    legend: charts.legend,
  };

  // The old views assign icon output to innerHTML, so they need the string
  // form. It lives here rather than in ui/icons.js because it is a legacy
  // requirement, and it leaves with this directory in Phase 7.
  T.icon = (name, cls) => icon(name, cls).outerHTML;

  // The legacy views read T.theme.* in 38 places; the old charts.js defined it
  // as a hex table. Back it with the live token palette instead, via getters,
  // so switching theme updates the colours the old views draw with rather than
  // leaving them on a snapshot taken at load.
  const THEME_KEYS = {
    blue: () => palette().accent,
    blueSoft: () => palette().track,
    teal: () => palette().series[5],
    purple: () => palette().series[3],
    green: () => palette().ok,
    amber: () => palette().warn,
    red: () => palette().err,
    ink: () => palette().ink,
    soft: () => palette().soft,
    faint: () => palette().faint,
    grid: () => palette().grid,
    track: () => palette().track,
    control: () => palette().classes.control,
    hpvideo: () => palette().classes.hp_video,
    bevideo: () => palette().classes.be_video,
  };
  T.theme = {};
  for (const [key, read] of Object.entries(THEME_KEYS)) {
    Object.defineProperty(T.theme, key, { get: read, enumerable: true });
  }

  T.util = {
    el: legacyEl,
    row(k, v, mono) {
      return legacyEl("div", { class: "row" }, [
        legacyEl("span", { class: "k" }, [k]),
        legacyEl("span", { class: `v${mono ? " mono" : ""}` }, [v == null ? "—" : String(v)]),
      ]);
    },
    toast,
    drawer,
    closeDrawer,
  };

  // Demo mode is gone, but the eight un-rewritten views still contain
  // `if (T.demo)` branches. Pin it false so those are deterministically dead
  // rather than relying on `undefined` being falsy, and make T.mock a trap: if
  // a branch turns out to be reachable after all, it says so by name instead of
  // failing as "cannot read properties of undefined".
  T.demo = false;
  T.mock = new Proxy({}, {
    get(_t, prop) {
      throw new Error(
        `T.mock.${String(prop)} was called, but demo mode was removed in Phase 2. `
        + "A legacy view still has a reachable demo branch — rewrite that view.",
      );
    },
  });

  // The Qbv editor is still a classic script shared by switch.js and setup.js.
  // It is loaded here so it exists before either view runs.
  await loadScript("js/qbveditor.js");

  installed = Promise.resolve();
  return installed;
}

/**
 * Called once from main.js after the real api/store/router exist, to finish
 * wiring the parts of the shim that need them.
 */
export function bindShim({ api, store, navigate, qbvEditor }) {
  const T = window.TSN || (window.TSN = {});

  // history starts with the arrays the legacy charts index into. An empty
  // object here is truthy, which defeats their `|| {ul: [], dl: []}` fallback.
  T.app = T.app || {
    current: "dashboard",
    last: {},
    history: { ul: [], dl: [], latency: [], offset: [] },
  };
  T.setView = (name) => navigate(name);
  T.qbvEditor = qbvEditor;

  // The legacy T.api surface, backed by the single client. Same method names
  // the old views call, so their bodies are untouched.
  T.api = {
    status: () => api.status(),
    health: () => api.health(),
    stats: () => api.stats(),
    discovery: () => api.discovery(),
    config: () => api.config.get(),
    updateConfig: (patch) => api.config.update(patch),
    connect: (body) => api.connect(body),
    disconnect: () => api.disconnect(),
    switchProfiles: () => api.switch.profiles(),
    switchApply: (body) => api.switch.apply(body),
    switchDisable: (body) => api.switch.disable(body),
    switchStatus: (q) => api.switch.status(q),
    // Endpoints the old views reached through ad-hoc fetch helpers, which is
    // how they lost the backend's error message. Routed through the client now.
    get: (path) => api.request("GET", path),
    post: (path, body) => api.request("POST", path, { body: body ?? {} }),
  };

  T.store = store;
}
