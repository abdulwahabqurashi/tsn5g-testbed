/**
 * Tiny event bus.
 *
 * Carries high-rate things that must not trigger a store update per item —
 * log lines chiefly, where a re-render per line would make the Logs view
 * unusable under `-l debug`.
 */

export function createBus() {
  const subs = new Map();   // type -> Set<fn>

  function on(type, fn) {
    if (!subs.has(type)) subs.set(type, new Set());
    subs.get(type).add(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    subs.get(type)?.delete(fn);
  }

  function once(type, fn) {
    const dispose = on(type, (payload) => { dispose(); fn(payload); });
    return dispose;
  }

  function emit(type, payload) {
    const set = subs.get(type);
    if (!set) return;
    // Copy first: a handler may unsubscribe itself mid-dispatch.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        // One bad listener must not stop the others, and must not be silent.
        console.error(`bus handler for "${type}" threw`, err);
      }
    }
  }

  return { on, off, once, emit };
}
