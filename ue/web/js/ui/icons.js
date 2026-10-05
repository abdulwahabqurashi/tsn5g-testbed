/**
 * Inline SVG icons.
 *
 * The path data is unchanged from the original set. What changed is the return
 * type: this used to hand back an HTML string that callers assigned to
 * innerHTML, which is the XSS vector the new DOM helper closes. icon() now
 * returns a real SVGElement.
 */

import { svg } from "../core/dom.js";

const PATHS = {
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  camera: "M4 8h3l2-2h6l2 2h3v10H4zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  bolt: "M13 3 4 14h6l-1 7 9-11h-6z",
  swap: "M7 7h13l-3-3M17 17H4l3 3",
  chip: "M8 8h8v8H8zM4 10V8M4 14v2M20 10V8M20 14v2M9 4h2M13 4h2M9 20h2M13 20h2"
      + "M4 9h2M4 13h2M18 9h2M18 13h2",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  pulse: "M3 12h4l2 6 4-14 2 8h6",
  device: "M4 5h16v11H4zM9 20h6M12 16v4",
  cloud: "M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A3.5 3.5 0 0 1 17 18z",
  server: "M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01",
  sw: "M4 7h16v4H4zM4 13h16v4H4zM8 9h.01M8 15h.01M16 9l-2 0M16 15l-2 0",
  signal: "M4 20v-3M9 20v-7M14 20v-11M19 20V6",
  check: "M5 12l4 4 10-10",
  radio: "M12 11v10M9 21h6M9.2 8.2a4 4 0 0 0 0 5.6M14.8 8.2a4 4 0 0 1 0 5.6"
       + "M6.3 5.3a8 8 0 0 0 0 11.4M17.7 5.3a8 8 0 0 1 0 11.4",
  wifi: "M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M11 18.5a1.5 1.5 0 0 1 2 0",
  eth: "M7 4h10v4H7zM12 8v4M6 12h12v3H6zM8 15v3M12 15v3M16 15v3",
  gauge2: "M12 13l4-3M20 13a8 8 0 1 0-16 0M4 13h2M18 13h2M12 5v2",
  speed: "M12 14a2 2 0 1 0 0-4M13.5 10.5 17 8M4.5 18a9 9 0 1 1 15 0",
  plug: "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5",
  // added for the new navigation
  terminal: "M4 5h16v14H4zM8 10l2.5 2L8 14M13 15h4",
  bug: "M9 6a3 3 0 0 1 6 0M7 10h10v5a5 5 0 0 1-10 0zM4 11h3M17 11h3M5 7l2 2M19 7l-2 2M5 17l2-1.5M19 17l-2-1.5",
  route: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8",
  sliders: "M4 8h10M18 8h2M4 16h4M12 16h8M15 5v6M9 13v6",
  apps: "M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z",
};

/** Returns an <svg> element. `name` falls back to a neutral grid glyph. */
export function icon(name, cls) {
  const attrs = { viewBox: "0 0 24 24", "aria-hidden": "true" };
  if (cls) attrs.class = cls;
  return svg("svg", attrs,
    svg("path", {
      d: PATHS[name] || PATHS.grid,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.7",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }));
}

export const iconNames = Object.keys(PATHS);
