/**
 * Entry point. Builds the services, mounts the shell, starts the stream.
 *
 * Load order used to be an invisible, nine-deep dependency between <script>
 * tags in index.html — a duplicate `const` in one file once blanked the whole
 * page, which is why scripts/lint-js.sh exists. With modules the order is
 * expressed by the imports themselves, and a syntax error names its file
 * instead of producing a white screen.
 */

import { createApi } from "./core/api.js";
import { createBus } from "./core/bus.js";
import { createRouter } from "./core/router.js";
import { createStream } from "./core/stream.js";
import { toast } from "./core/dialog.js";
import { h } from "./core/dom.js";
import { invalidate as invalidatePalette, applyAppearance, storedAppearance } from "./ui/tokens.js";
import { bindShim, installShim } from "./compat/shim.js";
import { createAppStore } from "./app/state.js";
import { ROUTES, routeByName } from "./app/routes.js";
import { mountShell, setActiveNav } from "./app/shell.js";
import { loadStatics, wireTelemetry } from "./app/telemetry.js";

/** Ring buffer of API calls, rendered by the Debug view in a later phase. */
function createRecorder(limit = 200) {
  const calls = [];
  return {
    push(entry) {
      calls.push({ ...entry, at: Date.now() });
      if (calls.length > limit) calls.shift();
    },
    all: () => calls.slice(),
  };
}

async function boot() {
  // Appearance before anything paints, so the kiosk never flashes white.
  applyAppearance(storedAppearance());

  const store = createAppStore();
  const bus = createBus();
  const recorder = createRecorder();

  // The dev fake transport is reachable only via ?transport=mock and is never
  // imported by a view, so shipped code cannot accidentally show fake data.
  let fetchImpl;
  if (new URLSearchParams(location.search).get("transport") === "mock") {
    const mod = await import("../dev/mock-transport.js").catch(() => null);
    if (mod) {
      fetchImpl = mod.fetchImpl;
      document.body.prepend(h("div", {
        class: "mock-banner",
        text: "MOCK TRANSPORT — this page is showing captured fixtures, not this device",
      }));
    }
  }

  const api = createApi({ fetchImpl, onCall: (e) => recorder.push(e) });
  const stream = createStream({ api, bus, store });

  wireTelemetry({ bus, store });

  const router = createRouter({
    routes: ROUTES,
    outlet: document.getElementById("content"),
    ctx: { store, api, bus },
    onChange(route) {
      store.patch({ ui: { route: route.name, title: route.title } });
      setActiveNav(route);
    },
    onError(err, route) {
      document.getElementById("content").appendChild(
        h("div", { class: "state-pane" },
          h("div", { class: "state-icon err", text: "!" }),
          h("div", { class: "state-msg", text: `Could not load "${route.title}"` }),
          h("pre", { class: "log", text: String(err?.stack || err) })));
    },
  });

  const navigate = (target) => {
    const path = target.startsWith("/") ? target : routeByName(target).path;
    router.navigate(path);
  };

  // Legacy bridge. Deleted in Phase 7 along with web/compat/.
  await installShim();
  bindShim({ api, store, navigate, qbvEditor: window.TSN?.qbvEditor });

  mountShell({ store, navigate });

  // Any store change reaches the active view; the view decides what to redraw.
  store.subscribe((state) => router.update(state));

  // Charts cache their palette, so a theme change has to invalidate and redraw.
  window.addEventListener("tsn:theme", () => {
    invalidatePalette();
    router.update(store.get());
  });

  router.start();
  stream.start();
  loadStatics({ api, store });

  // Surface unexpected failures rather than letting them sit in the console,
  // and keep them where scripts/ui-check.py can assert there were none.
  window.__tsn_errors = [];
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason?.message || String(e.reason);
    if (msg === "cancelled") return;        // navigation aborting its own fetches
    window.__tsn_errors.push({ kind: "rejection", message: msg });
    console.error("unhandled rejection", e.reason);
  });
  window.addEventListener("error", (e) => {
    window.__tsn_errors.push({ kind: "error", message: e.message, at: `${e.filename}:${e.lineno}` });
  });

  // Small conveniences for debugging from the console.
  window.__tsn = { store, api, bus, router, stream, recorder };
}

boot().catch((err) => {
  console.error("boot failed", err);
  document.body.appendChild(h("pre", {
    class: "log",
    style: { margin: "40px", padding: "20px" },
    text: `UI failed to start:\n\n${err?.stack || err}`,
  }));
});
