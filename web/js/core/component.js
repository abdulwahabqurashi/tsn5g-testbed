/**
 * View lifecycle.
 *
 * The old shell did `content.innerHTML = ""` then called an `async render()`
 * without awaiting it, so `onData()` could fire before the DOM existed —
 * every view carried a defensive `if (!this._b) return` to survive it. There
 * was also no teardown, which is why the speed-test view's 500 ms poll kept
 * running forever once you navigated away, against DOM nodes that no longer
 * existed.
 *
 * Both are structural here rather than the view's problem:
 *
 *   - mount() is AWAITED, so update() cannot race it.
 *   - the view gets an AbortSignal and registration helpers; everything it
 *     registers is torn down on navigation, in reverse order.
 *
 * The rule that makes it hold: a view never calls setInterval, fetch,
 * store.subscribe or bus.on directly — only view.interval / view.api /
 * view.sub / view.listen. scripts/lint-js.sh enforces it.
 */

import { clear } from "./dom.js";

export function defineView(spec) {
  return spec;   // identity today; a seam for adding dev-time validation
}

export async function runView(spec, { root, ctx }) {
  const cleanups = [];
  const abort = new AbortController();

  const view = {
    root,
    params: ctx.params || {},
    query: ctx.query || {},
    store: ctx.store,
    api: ctx.api,
    bus: ctx.bus,
    jobs: ctx.jobs,
    /** Pass to every fetch the view makes; aborted on teardown. */
    signal: abort.signal,

    onCleanup(fn) {
      cleanups.push(fn);
      return fn;
    },
    interval(fn, ms) {
      const id = setInterval(fn, ms);
      cleanups.push(() => clearInterval(id));
      return id;
    },
    timeout(fn, ms) {
      const id = setTimeout(fn, ms);
      cleanups.push(() => clearTimeout(id));
      return id;
    },
    sub(selectorOrFn, maybeFn) {
      cleanups.push(ctx.store.subscribe(selectorOrFn, maybeFn));
    },
    listen(type, fn) {
      cleanups.push(ctx.bus.on(type, fn));
    },
    dom(node, type, fn, opts) {
      node.addEventListener(type, fn, opts);
      cleanups.push(() => node.removeEventListener(type, fn, opts));
    },
  };

  await spec.mount(view);

  return {
    name: spec.name,
    update(state) {
      if (!spec.update) return;
      try {
        spec.update(state, view);
      } catch (err) {
        console.error(`view "${spec.name}" update threw`, err);
      }
    },
    async destroy() {
      // Abort first: in-flight requests resolve as cancelled rather than
      // landing on a DOM that is about to disappear.
      abort.abort();
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch (err) {
          console.error(`view "${spec.name}" cleanup threw`, err);
        }
      }
      if (spec.destroy) {
        try {
          await spec.destroy(view);
        } catch (err) {
          console.error(`view "${spec.name}" destroy threw`, err);
        }
      }
      clear(root);
    },
  };
}
