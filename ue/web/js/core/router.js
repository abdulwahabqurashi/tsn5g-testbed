/**
 * Hash router.
 *
 * Hash rather than path because the backend's static handler 404s unknown
 * paths — `/modem` would need a server-side rewrite, and the point of this
 * UI is that it ships as files.
 *
 * What it buys over the old setView(): a refresh keeps you where you were,
 * links are shareable ("look at #/logs"), and back works.
 *
 * The generation counter matters. Teardown is async (a view may await its own
 * destroy), so a fast double-navigation could otherwise mount view B, then
 * have view A's teardown finish and clear B's DOM out from under it.
 */

import { runView } from "./component.js";
import { clear } from "./dom.js";

function parseHash(raw) {
  const hash = (raw || "").replace(/^#/, "") || "/";
  const [path, qs] = hash.split("?");
  const query = {};
  if (qs) {
    for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  }
  return { path: path.startsWith("/") ? path : `/${path}`, query };
}

function matchRoute(routes, path) {
  const want = path.replace(/\/+$/, "") || "/";
  for (const route of routes) {
    const pattern = route.path.replace(/\/+$/, "") || "/";
    if (pattern === want) return { route, params: {} };
  }
  // Parameterised segments: "/iperf/:id"
  const wantParts = want.split("/").filter(Boolean);
  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    if (parts.length !== wantParts.length || !parts.some((p) => p.startsWith(":"))) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(":")) params[parts[i].slice(1)] = decodeURIComponent(wantParts[i]);
      else if (parts[i] !== wantParts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

export function createRouter({ routes, outlet, ctx, onChange, onError }) {
  let generation = 0;
  let active = null;
  let current = null;

  async function go() {
    const mine = ++generation;
    const { path, query } = parseHash(location.hash);
    const hit = matchRoute(routes, path) || matchRoute(routes, "/");
    if (!hit) return;

    const { route, params } = hit;
    if (route.redirect) {       // an old address: replace it, so back does not bounce
      location.replace(`#${route.redirect}`);
      return;
    }

    if (active) {
      const previous = active;
      active = null;
      await previous.destroy();
    }
    if (mine !== generation) return;    // navigated again during teardown

    // Clear here rather than relying on the outgoing view to do it: a view
    // that never finished mounting was never `active`, so nothing else would.
    clear(outlet);

    onChange?.(route, params);
    current = route;

    let spec;
    try {
      const mod = await route.load();
      spec = mod.default || mod;
    } catch (err) {
      console.error(`failed to load view "${route.name}"`, err);
      onError?.(err, route);
      return;
    }
    if (mine !== generation) return;

    let instance;
    try {
      instance = await runView(spec, {
        root: outlet,
        ctx: { ...ctx, params, query },
      });
    } catch (err) {
      console.error(`failed to mount view "${route.name}"`, err);
      onError?.(err, route);
      return;
    }

    if (mine !== generation) {
      // Lost the race. Tear down this view's own registrations, but leave the
      // outlet alone — the view that won is already rendering into it.
      await instance.destroy({ clearRoot: false });
      return;
    }

    active = instance;
    instance.update(ctx.store.get());   // seed with whatever state we already have
  }

  function navigate(path) {
    if (location.hash === `#${path}`) go();
    else location.hash = path;
  }

  function start() {
    window.addEventListener("hashchange", go);
    if (!location.hash) location.hash = routes[0].path;
    else go();
  }

  return {
    start,
    navigate,
    go,
    get current() { return current; },
    update(state) { active?.update(state); },
  };
}
