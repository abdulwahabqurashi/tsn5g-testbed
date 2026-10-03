/**
 * Development-only fake transport. Reachable ONLY via ?transport=mock.
 *
 * This replaces the old demo mode, and the difference matters. Demo mode was a
 * toggle in the shipped header with `if (T.demo)` branches threaded through
 * every action handler — about 25 of them — so a screenshot of fake data was
 * indistinguishable from a working system, and `mock.stats()` returned a
 * different shape from the live endpoint, meaning the demo path never
 * exercised the real code anyway.
 *
 * This is a fetch implementation injected in exactly one place (main.js), so:
 *   - no view can branch on it, or even see it
 *   - the shapes come from `dev/capture.sh` against a real box, so they cannot
 *     drift from the API by hand
 *   - the page wears a permanent red banner while it is active
 *
 * scripts/lint-js.sh fails if anything under js/ imports from here.
 */

const FIXTURES = "dev/fixtures";

/** Endpoints with a captured fixture. Anything else returns a clear 501. */
const MAP = {
  "/api/status": "status.json",
  "/api/health": "health.json",
  "/api/stats": "stats.json",
  "/api/discovery": "discovery.json",
  "/api/config": "config.json",
  "/api/version": "version.json",
  "/api/spec": "spec.json",
  "/api/interfaces": "interfaces.json",
  "/api/logs": "logs.json",
  "/api/logs/level": "logs-level.json",
  "/api/jobs": "jobs.json",
  "/api/switch/profiles": "switch-profiles.json",
  "/api/tas/profiles": "tas-profiles.json",
  "/api/setup/state": "setup-state.json",
  "/api/speedtest/result": "speedtest-result.json",
  "/api/debug/commands": "debug-commands.json",
};

const cache = new Map();
const realFetch = globalThis.fetch.bind(globalThis);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function fetchImpl(url, opts = {}) {
  const path = new URL(url, location.origin).pathname;
  const method = (opts.method || "GET").toUpperCase();

  // Mutating calls are acknowledged, never performed. A fixture run must not
  // be able to imply that something happened.
  if (method !== "GET") {
    console.info(`[mock] ${method} ${path} acknowledged, not performed`);
    return json({ ok: true, mock: true, accepted: true }, 202);
  }

  const file = MAP[path];
  if (!file) {
    return json({ error: `no fixture for ${path}`, detail: "add one with dev/capture.sh" }, 501);
  }

  if (!cache.has(file)) {
    const res = await realFetch(`${FIXTURES}/${file}`);
    if (!res.ok) {
      return json({ error: `fixture ${file} is missing`, detail: "run dev/capture.sh" }, 501);
    }
    cache.set(file, await res.json());
  }
  return json(cache.get(file));
}

export const isMock = true;
