/**
 * The single source of navigation truth.
 *
 * Titles, icons, section grouping and the loader all live here, so the sidebar
 * is generated rather than hand-written.
 *
 * Eight pages. The first four are what you use to run and show the testbed;
 * the rest are for setting it up and finding faults. Pages that used to answer
 * one question between them are tabs of one page now (ui/tabs.js), and the old
 * addresses redirect, so a bookmark to #/signal still lands on the right tab.
 *
 * `load()` is a dynamic import, so each view is fetched on first visit.
 */

import { tabbedView } from "../ui/tabs.js";

const tabbed = (name, tabs) => async () => ({ default: tabbedView(name, tabs) });

export const SECTIONS = [
  { id: "operate", label: "Testbed" },
  { id: "setup", label: "Set-up" },
  { id: "system", label: "System" },
];

export const ROUTES = [
  {
    name: "dashboard", path: "/", title: "Overview", icon: "grid", section: "operate",
    load: () => import("../views/dashboard.js"),
  },
  {
    name: "cameras", path: "/cameras", title: "Cameras", icon: "camera", section: "operate",
    load: () => import("../views/cameras.js"),
  },
  {
    name: "tests", path: "/tests", title: "Tests", icon: "pulse", section: "operate",
    load: tabbed("tests", [
      { id: "runs", title: "Test runs", load: () => import("../views/tests.js") },
      { id: "speed", title: "Speed test", load: () => import("../views/throughput.js") },
    ]),
  },
  {
    name: "gptp", path: "/gptp", title: "Time Sync", icon: "clock", section: "operate",
    load: () => import("../views/advanced/gptp.js"),
  },
  {
    name: "network", path: "/network", title: "5G Link", icon: "bolt", section: "setup",
    load: tabbed("network", [
      { id: "link", title: "Data call", load: () => import("../views/connection.js") },
      { id: "interfaces", title: "Interfaces", load: () => import("../views/interfaces.js") },
      { id: "routing", title: "Routing", load: () => import("../views/routing.js") },
    ]),
  },
  {
    name: "radio", path: "/radio", title: "Radio", icon: "signal", section: "setup",
    load: tabbed("radio", [
      { id: "signal", title: "Signal", load: () => import("../views/signal.js") },
      { id: "cell", title: "Cell & bands", load: () => import("../views/registration.js") },
      { id: "modem", title: "Modem", load: () => import("../views/modem.js") },
    ]),
  },
  {
    name: "system", path: "/system", title: "System", icon: "terminal", section: "system",
    load: tabbed("system", [
      { id: "logs", title: "Logs", load: () => import("../views/logs.js") },
      { id: "diagnostics", title: "Diagnostics", load: () => import("../views/diagnostics.js") },
      { id: "debug", title: "AT console", load: () => import("../views/debug.js") },
    ]),
  },
  {
    name: "lab", path: "/lab", title: "TSN Lab", icon: "swap", section: "system",
    load: tabbed("lab", [
      { id: "bridge", title: "TSN bridge", load: () => import("../views/advanced/bridge.js") },
      { id: "switch", title: "TSN switch", load: () => import("../views/advanced/switch.js") },
    ]),
  },

  // Old addresses, kept so bookmarks and links still work.
  ...[
    ["/connection", "/network"], ["/interfaces", "/network?tab=interfaces"],
    ["/routing", "/network?tab=routing"], ["/signal", "/radio"],
    ["/registration", "/radio?tab=cell"], ["/modem", "/radio?tab=modem"],
    ["/throughput", "/tests?tab=speed"], ["/logs", "/system"],
    ["/diagnostics", "/system?tab=diagnostics"], ["/debug", "/system?tab=debug"],
    ["/bridge", "/lab"], ["/transport", "/cameras"], ["/switch", "/lab?tab=switch"],
  ].map(([path, redirect]) => ({ name: `old${path.replace("/", "-")}`, path, redirect, hidden: true })),
];

export function routeByName(name) {
  return ROUTES.find((r) => r.name === name) || ROUTES[0];
}
