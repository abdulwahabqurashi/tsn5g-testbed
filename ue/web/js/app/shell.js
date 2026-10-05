/**
 * Sidebar, topbar and the connection indicator.
 *
 * The nav is generated from routes.js, so adding a view is one entry in one
 * file. The old markup listed nav items in index.html and titles in app.js,
 * which is two places to forget.
 *
 * The connection badge reports the *transport* as well as health, because
 * "the UI is live-streaming" and "the UI is polling because the stream died"
 * look identical otherwise, and the difference matters when you are watching a
 * connect sequence.
 */

import { clear, h } from "../core/dom.js";
import { icon } from "../ui/icons.js";
import { applyAppearance, storedAppearance } from "../ui/tokens.js";
import { ROUTES, SECTIONS } from "./routes.js";

const TRANSPORT_LABEL = {
  sse: { text: "Live", cls: "ok" },
  poll: { text: "Polling", cls: "warn" },
  down: { text: "Offline", cls: "err" },
  idle: { text: "Connecting…", cls: "idle" },
};

export function mountShell({ store, navigate }) {
  buildNav(navigate);
  buildTopbarControls(store);

  store.subscribe((s) => s.conn?.transport, () => paintConn(store));
  store.subscribe((s) => s.health?.healthy, () => paintConn(store));
  store.subscribe((s) => s.status?.state, () => paintConn(store));
  store.subscribe((s) => s.version?.version, (v) => {
    const el = document.getElementById("app-version");
    if (el) el.textContent = v ? `v${v}` : "";
  });

  paintConn(store);
}

function buildNav(navigate) {
  const nav = document.getElementById("nav");
  clear(nav);

  for (const section of SECTIONS) {
    const items = ROUTES.filter((r) => r.section === section.id && !r.hidden);
    if (!items.length) continue;

    nav.appendChild(h("div", { class: "nav-cap", text: section.label }));
    for (const route of items) {
      const button = h("button", {
        class: "nav-item",
        type: "button",
        dataset: { route: route.name },
        onclick: () => navigate(route.path),
      },
        h("span", { class: "ic" }, icon(route.icon)),
        h("span", { text: route.title }));
      nav.appendChild(button);
    }
  }
}

function buildTopbarControls(store) {
  const host = document.getElementById("topbar-controls");
  clear(host);

  const { theme, density } = storedAppearance();

  const themeSelect = h("select", {
    class: "mini-select",
    "aria-label": "Theme",
    onchange: (e) => {
      applyAppearance({ theme: e.target.value });
      store.patch({ ui: { theme: e.target.value } });
      // Charts cache their palette; tell them to redraw with the new one.
      window.dispatchEvent(new CustomEvent("tsn:theme"));
    },
  },
    h("option", { value: "auto", text: "Auto" }),
    h("option", { value: "light", text: "Light" }),
    h("option", { value: "dark", text: "Dark" }));
  themeSelect.value = theme;

  const densitySelect = h("select", {
    class: "mini-select",
    "aria-label": "Density",
    onchange: (e) => {
      applyAppearance({ density: e.target.value });
      store.patch({ ui: { density: e.target.value } });
    },
  },
    h("option", { value: "desktop", text: "Desktop" }),
    h("option", { value: "kiosk", text: "Kiosk" }));
  densitySelect.value = density;

  host.appendChild(themeSelect);
  host.appendChild(densitySelect);
}

function paintConn(store) {
  const s = store.get();
  const badge = document.getElementById("conn-badge");
  if (!badge) return;

  const transport = s.conn?.transport || "idle";
  const info = TRANSPORT_LABEL[transport] || TRANSPORT_LABEL.idle;

  let cls = info.cls;
  let text = info.text;

  // Once data is flowing, the badge reports the system rather than the pipe.
  if (transport === "sse" || transport === "poll") {
    // The data call is what "online" means on this rig; the controller's own
    // state stays "idle" when the call was brought up as a bearer job.
    const state = s.status?.state;
    const checks = s.health?.checks || {};
    if (state === "error") { cls = "err"; text = "Error"; }
    else if (state === "connecting") { cls = "warn"; text = "Connecting"; }
    else if (checks.link ?? state === "running") {   // older daemons report no link check
      const off = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => (k === "gptp" ? "PTP" : k));
      cls = off.length ? "warn" : "ok";
      text = off.length ? `Online · ${off.join(", ")} down` : "Online";
    } else if (s.health) { cls = "err"; text = "5G link down"; }
    if (transport === "poll") text += " · polling";
  }

  clear(badge);
  badge.appendChild(h("span", { class: `dot ${cls}` }));
  badge.appendChild(h("span", { text }));
  badge.title = s.conn?.error || `transport: ${transport}`;
}

export function setActiveNav(route) {
  for (const button of document.querySelectorAll(".nav-item")) {
    button.classList.toggle("active", button.dataset.route === route.name);
  }
  const title = document.getElementById("view-title");
  if (title) title.textContent = route.title;
  document.title = `${route.title} · TSN-5G UE`;
}
