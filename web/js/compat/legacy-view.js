/**
 * TEMPORARY bridge for the eight pre-module views.
 *
 * DELETE THIS DIRECTORY IN PHASE 7. It exists so the shell could be rebuilt
 * without rewriting every view in the same commit — the UI stays usable at
 * each step — and it is a release gate, not a permanent layer.
 *
 * Why scripts are injected rather than imported: the legacy views are IIFEs
 * that capture `const C = T.charts` at execution time, so the window.TSN shim
 * has to be fully populated *before* they run. Relying on <script> tag order
 * in index.html would work but puts the dependency somewhere invisible;
 * loading them from here makes it explicit and keeps index.html to one entry
 * point.
 *
 * The adapter maps the old contract onto the new lifecycle:
 *     render(container, app)  ->  mount(view)
 *     onData(last)            ->  update(state, view)
 * and, crucially, the new lifecycle tears down anything the view registered,
 * which is what stops the speed-test poll leaking on navigation.
 */

import { installShim } from "./shim.js";

const loaded = new Map();      // name -> Promise<void>

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

/**
 * Returns a module-shaped object ({default: spec}) for a legacy view, so the
 * router treats it exactly like a real module.
 */
export function legacyView(name) {
  if (!loaded.has(name)) {
    loaded.set(name, (async () => {
      await installShim();
      await loadScript(`js/views/${name}.js`);
      if (!window.TSN?.views?.[name]) {
        throw new Error(`legacy view "${name}" did not register itself`);
      }
    })());
  }

  return loaded.get(name).then(() => {
    const legacy = window.TSN.views[name];

    return {
      default: {
        name,
        async mount(view) {
          // The old views read a mutable `app` object for polled data and
          // called app.api / T.api directly. Hand them a shim backed by the
          // new store so both see the same snapshot.
          const app = window.TSN.app;
          app.current = name;
          applySnapshot(app, view.store.get());

          const maybePromise = legacy.render(view.root, app);
          if (maybePromise && typeof maybePromise.then === "function") {
            await maybePromise;      // AWAITED — update() can no longer race it
          }

          // Legacy views registered their own intervals in a few places; the
          // new lifecycle cannot see those, so anything still running after
          // teardown is a bug in that view and will be fixed when it is
          // rewritten. The known offender (speedtest) is handled below.
          view.onCleanup(() => {
            if (typeof legacy.destroy === "function") {
              try { legacy.destroy(); } catch { /* view already gone */ }
            }
            // speedtest.js parks its poll handle on the view object.
            if (legacy._poll) { clearInterval(legacy._poll); legacy._poll = null; }
          });
        },

        update(state) {
          if (!legacy.onData) return;
          const app = window.TSN.app;
          applySnapshot(app, state);
          legacy.onData(app.last);
        },
      },
    };
  });
}

/**
 * Populate the two places the legacy views read from.
 *
 * They take polled data from `app.last`, but chart history from `T.app.history`
 * — a different object. Setting only the first left `T.app.history` as the `{}`
 * the shim created, which is truthy, so their `|| {ul: [], dl: []}` fallback
 * never fired and `hist.ul.length` threw on every update. The cards rendered
 * their headings and then stayed empty.
 */
function applySnapshot(app, state) {
  app.last = {
    status: state.status,
    health: state.health,
    stats: state.stats,
    discovery: state.discovery,
    config: state.config,
    history: legacyHistory(state.series),
  };
  app.history = app.last.history;
}

/**
 * The old views read `app.history.{ul,dl,...}` as flat arrays of numbers.
 * The store keeps {t, v} pairs so gaps can be drawn as gaps; project them
 * back for the duration of the bridge.
 */
function legacyHistory(series) {
  const out = {};
  for (const [key, ring] of Object.entries(series || {})) {
    out[key] = ring.map((d) => d.v);
  }
  return out;
}
