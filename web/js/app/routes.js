/**
 * The single source of navigation truth.
 *
 * Titles, icons, section grouping and the loader all live here, so the sidebar
 * is generated rather than hand-written. Previously the nav markup was in
 * index.html and a parallel `titles` map was in app.js — two places to edit,
 * which had already drifted.
 *
 * `load()` is a dynamic import, so each view is fetched on first visit.
 */

import { legacyView } from "../compat/legacy-view.js";

export const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "radio", label: "Radio" },
  { id: "network", label: "Network" },
  { id: "testing", label: "Testing" },
  { id: "system", label: "System" },
  { id: "advanced", label: "Advanced" },
];

export const ROUTES = [
  {
    name: "dashboard",
    path: "/",
    title: "Dashboard",
    icon: "grid",
    section: "overview",
    load: () => legacyView("dashboard"),
  },
  {
    name: "connection",
    path: "/connection",
    title: "Connection",
    icon: "bolt",
    section: "overview",
    load: () => import("../views/connection.js"),
  },
  {
    name: "modem",
    path: "/modem",
    title: "Modem",
    icon: "chip",
    section: "radio",
    load: () => import("../views/modem.js"),
  },
  {
    name: "signal",
    path: "/signal",
    title: "Signal",
    icon: "signal",
    section: "radio",
    load: () => import("../views/signal.js"),
  },
  {
    name: "interfaces",
    path: "/interfaces",
    title: "Interfaces",
    icon: "eth",
    section: "network",
    load: () => import("../views/interfaces.js"),
  },
  {
    name: "routing",
    path: "/routing",
    title: "Routing",
    icon: "route",
    section: "network",
    load: () => import("../views/routing.js"),
  },
  {
    name: "throughput",
    path: "/throughput",
    title: "Throughput",
    icon: "speed",
    section: "testing",
    load: () => legacyView("speedtest"),
  },
  {
    name: "logs",
    path: "/logs",
    title: "Logs",
    icon: "terminal",
    section: "system",
    load: () => import("../views/logs.js"),
  },
  {
    name: "debug",
    path: "/debug",
    title: "Debug",
    icon: "bug",
    section: "system",
    load: () => import("../views/debug.js"),
  },
  {
    name: "diagnostics",
    path: "/diagnostics",
    title: "Diagnostics",
    icon: "pulse",
    section: "system",
    load: () => legacyView("diagnostics"),
  },
  {
    name: "transport",
    path: "/transport",
    title: "Transport",
    icon: "swap",
    section: "advanced",
    load: () => legacyView("transport"),
  },
  {
    name: "switch",
    path: "/switch",
    title: "TSN Switch",
    icon: "sw",
    section: "advanced",
    load: () => legacyView("switch"),
  },
  {
    name: "gptp",
    path: "/gptp",
    title: "Time Sync",
    icon: "clock",
    section: "advanced",
    load: () => legacyView("gptp"),
  },
];

export function routeByName(name) {
  return ROUTES.find((r) => r.name === name) || ROUTES[0];
}
