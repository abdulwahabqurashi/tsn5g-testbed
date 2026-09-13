/**
 * Observable state, one level of shallow merge per top-level key.
 *
 * Subscribers may pass a selector, in which case they are only called when
 * their slice actually changes. That matters here because telemetry patches
 * the store every second or two and most views care about one field of it.
 */

export function createStore(initial) {
  let state = initial;
  const subs = new Set();

  function get() {
    return state;
  }

  function patch(partial) {
    const next = { ...state };
    for (const [k, v] of Object.entries(partial)) {
      const isPlainObject = v && typeof v === "object" && !Array.isArray(v);
      const prevIsPlain = state[k] && typeof state[k] === "object" && !Array.isArray(state[k]);
      next[k] = isPlainObject && prevIsPlain ? { ...state[k], ...v } : v;
    }
    state = next;
    for (const s of [...subs]) {
      try {
        s(next);
      } catch (err) {
        console.error("store subscriber threw", err);
      }
    }
    return state;
  }

  /** Replace a top-level key outright, skipping the shallow merge. */
  function set(key, value) {
    state = { ...state, [key]: value };
    for (const s of [...subs]) {
      try {
        s(state);
      } catch (err) {
        console.error("store subscriber threw", err);
      }
    }
    return state;
  }

  /**
   * subscribe(fn)            — every change
   * subscribe(selector, fn)  — only when selector(state) changes
   */
  function subscribe(selectorOrFn, maybeFn) {
    const selector = maybeFn ? selectorOrFn : null;
    const fn = maybeFn || selectorOrFn;

    let prev = selector ? selector(state) : undefined;
    const wrapped = (next) => {
      if (!selector) return fn(next);
      const value = selector(next);
      if (!Object.is(value, prev)) {
        prev = value;
        fn(value, next);
      }
      return undefined;
    };

    subs.add(wrapped);
    return () => subs.delete(wrapped);
  }

  return { get, patch, set, subscribe };
}
