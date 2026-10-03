/**
 * Bridge from CSS custom properties to JavaScript.
 *
 * charts.js used to carry its own hex palette that duplicated the CSS
 * variables. Two parallel palettes kept in sync by hand is a bug waiting for
 * dark mode: the page would switch and the charts would not.
 *
 * Reading them is cheap but not free (getComputedStyle forces style
 * resolution), so the result is cached and invalidated when the theme changes.
 */

let cache = null;

function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = (name) => cs.getPropertyValue(name).trim();

  return {
    series: [g("--chart-1"), g("--chart-2"), g("--chart-3"),
             g("--chart-4"), g("--chart-5"), g("--chart-6")],
    grid: g("--chart-grid"),
    track: g("--chart-track"),
    ink: g("--chart-ink"),
    soft: g("--chart-soft"),
    faint: g("--faint"),
    ok: g("--green"),
    warn: g("--amber"),
    err: g("--red"),
    accent: g("--blue"),
    panel: g("--panel"),
    line: g("--line"),
    classes: {
      control: g("--class-control"),
      hp_video: g("--class-hpvideo"),
      be_video: g("--class-be"),
    },
  };
}

export function palette() {
  if (!cache) cache = readTokens();
  return cache;
}

export function invalidate() {
  cache = null;
}

/** Colour for a signal-quality band, from format.signalBand(). */
export function bandColor(band) {
  const p = palette();
  return { excellent: p.ok, good: p.ok, fair: p.warn, poor: p.err }[band] || p.faint;
}

/**
 * Apply theme and density, and persist them.
 * Called once before first paint (inline in index.html) and again on change.
 */
export function applyAppearance({ theme, density } = {}) {
  const root = document.documentElement;
  if (theme) {
    root.dataset.theme = theme;
    try { localStorage.setItem("tsn5g.theme", theme); } catch { /* private mode */ }
  }
  if (density) {
    root.dataset.density = density;
    try { localStorage.setItem("tsn5g.density", density); } catch { /* private mode */ }
  }
  invalidate();
}

export function storedAppearance() {
  let theme = "auto";
  let density = "desktop";
  try {
    theme = localStorage.getItem("tsn5g.theme") || "auto";
    density = localStorage.getItem("tsn5g.density") || "desktop";
  } catch { /* private mode */ }
  return { theme, density };
}
