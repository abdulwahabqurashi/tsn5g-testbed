/**
 * Dependency-free SVG charts.
 *
 * Ported from the original charts.js with three changes:
 *
 *  1. Colours come from palette() rather than a module-level hex table. The
 *     old T.theme duplicated the CSS variables, so dark mode would have drawn
 *     light-theme charts.
 *  2. legend() builds DOM instead of assigning innerHTML.
 *  3. timeSeries() plots {t, v} pairs against real time, so a gap in the data
 *     is drawn as a gap. The index-based area() silently compressed the x-axis
 *     when a poll failed, which made a dropped sample look like a fast one.
 */

import { h, svg as svgEl } from "../core/dom.js";
import { palette } from "./tokens.js";

let uidCounter = 0;
const uid = (prefix) => `${prefix}-${++uidCounter}`;

function canvas(w, height, { scale = true } = {}) {
  const attrs = {
    viewBox: `0 0 ${w} ${height}`,
    width: "100%",
    height,
    class: "chart",
  };
  if (scale) attrs.preserveAspectRatio = "none";
  return svgEl("svg", attrs);
}

function gradient(id, color, topOpacity = 0.28) {
  return svgEl("defs", null,
    svgEl("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 },
      svgEl("stop", { offset: "0%", "stop-color": color, "stop-opacity": String(topOpacity) }),
      svgEl("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0" })));
}

/** Area chart over evenly spaced values. */
export function area(values, opts = {}) {
  const p = palette();
  const w = opts.w || 640;
  const height = opts.h || 150;
  const padT = 10;
  const padB = 12;
  const color = opts.color || p.series[0];
  const vals = values.length ? values : [0, 0];
  const lo = opts.min != null ? opts.min : Math.min(...vals);
  const hi = opts.max != null ? opts.max : Math.max(...vals);
  const span = (hi - lo) || 1;
  const ih = height - padT - padB;
  const x = (i) => (vals.length === 1 ? 0 : (i / (vals.length - 1)) * w);
  const y = (v) => padT + ih - ((v - lo) / span) * ih;

  const s = canvas(w, height);
  const gid = uid("grad");
  s.appendChild(gradient(gid, color));

  if (opts.grid !== false) {
    for (let g = 0; g <= 3; g += 1) {
      const gy = padT + (g / 3) * ih;
      s.appendChild(svgEl("line", {
        x1: 0, y1: gy, x2: w, y2: gy,
        stroke: p.grid, "stroke-width": 1, "stroke-dasharray": "3 4",
      }));
    }
  }

  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  s.appendChild(svgEl("path", {
    d: `M${x(0)},${y(vals[0])} L${pts.split(" ").join(" L")} `
      + `L${x(vals.length - 1)},${padT + ih} L${x(0)},${padT + ih} Z`,
    fill: `url(#${gid})`,
  }));
  s.appendChild(svgEl("polyline", {
    points: pts, fill: "none", stroke: color, "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round",
  }));
  s.appendChild(svgEl("circle", {
    cx: x(vals.length - 1), cy: y(vals[vals.length - 1]),
    r: 3, fill: p.panel, stroke: color, "stroke-width": 2,
  }));
  return s;
}

/**
 * Time-aware series. Takes [{t, v}] with t in ms, and breaks the line wherever
 * two samples are further apart than `gapMs` — so a stalled backend reads as a
 * gap rather than as continuous data.
 */
export function timeSeries(series, opts = {}) {
  const p = palette();
  const w = opts.w || 640;
  const height = opts.h || 150;
  const padT = 10;
  const padB = 12;
  const ih = height - padT - padB;
  const gapMs = opts.gapMs || 6000;

  const lines = Array.isArray(series[0]) ? series : [series];
  const all = lines.flat().filter((d) => d && d.v !== null && d.v !== undefined);
  const s = canvas(w, height);
  if (!all.length) return s;

  const from = opts.from ?? Math.min(...all.map((d) => d.t));
  const to = opts.to ?? Math.max(...all.map((d) => d.t));
  const tSpan = (to - from) || 1;
  const lo = opts.min != null ? opts.min : Math.min(0, ...all.map((d) => d.v));
  const hi = opts.max != null ? opts.max : Math.max(...all.map((d) => d.v));
  const vSpan = (hi - lo) || 1;

  const x = (t) => ((t - from) / tSpan) * w;
  const y = (v) => padT + ih - ((v - lo) / vSpan) * ih;

  if (opts.grid !== false) {
    for (let g = 0; g <= 3; g += 1) {
      const gy = padT + (g / 3) * ih;
      s.appendChild(svgEl("line", {
        x1: 0, y1: gy, x2: w, y2: gy,
        stroke: p.grid, "stroke-width": 1, "stroke-dasharray": "3 4",
      }));
    }
  }

  lines.forEach((points, idx) => {
    const color = (opts.colors && opts.colors[idx]) || p.series[idx % p.series.length];
    const gid = uid("tsgrad");
    s.appendChild(gradient(gid, color, opts.fill === false ? 0 : 0.22));

    // Split into contiguous runs.
    const runs = [];
    let run = [];
    let prevT = null;
    for (const d of points) {
      if (!d || d.v === null || d.v === undefined) continue;
      if (prevT !== null && d.t - prevT > gapMs) {
        if (run.length) runs.push(run);
        run = [];
      }
      run.push(d);
      prevT = d.t;
    }
    if (run.length) runs.push(run);

    for (const segment of runs) {
      if (segment.length === 1) {
        s.appendChild(svgEl("circle", {
          cx: x(segment[0].t), cy: y(segment[0].v), r: 2, fill: color,
        }));
        continue;
      }
      const pts = segment.map((d) => `${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");
      if (opts.fill !== false) {
        s.appendChild(svgEl("path", {
          d: `M${x(segment[0].t)},${padT + ih} L${pts.split(" ").join(" L")} `
            + `L${x(segment[segment.length - 1].t)},${padT + ih} Z`,
          fill: `url(#${gid})`,
        }));
      }
      s.appendChild(svgEl("polyline", {
        points: pts, fill: "none", stroke: color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
    }
  });

  return s;
}

/** Sparkline: line only, no axes. */
export function spark(values, opts = {}) {
  const p = palette();
  const w = opts.w || 120;
  const height = opts.h || 34;
  const color = opts.color || p.ok;
  const vals = values.length ? values : [0, 0];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = (hi - lo) || 1;
  const x = (i) => (i / Math.max(1, vals.length - 1)) * w;
  const y = (v) => height - 3 - ((v - lo) / span) * (height - 6);

  const s = canvas(w, height);
  const gid = uid("sg");
  s.appendChild(gradient(gid, color, 0.25));
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  s.appendChild(svgEl("path", {
    d: `M0,${height} L${pts.split(" ").join(" L")} L${w},${height} Z`,
    fill: `url(#${gid})`,
  }));
  s.appendChild(svgEl("polyline", {
    points: pts, fill: "none", stroke: color, "stroke-width": 1.8,
    "stroke-linecap": "round", "stroke-linejoin": "round",
  }));
  return s;
}

/** Circular gauge, 0..100, with a centre label. */
export function gauge(pct, opts = {}) {
  const p = palette();
  const size = opts.size || 120;
  const sw = opts.stroke || 10;
  const r = (size - sw) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const color = opts.color || p.ok;
  const value = Math.max(0, Math.min(100, Number(pct) || 0));

  const s = canvas(size, size, { scale: false });
  s.appendChild(svgEl("circle", {
    cx: c, cy: c, r, fill: "none", stroke: p.track, "stroke-width": sw,
  }));
  s.appendChild(svgEl("circle", {
    cx: c, cy: c, r, fill: "none", stroke: color, "stroke-width": sw,
    "stroke-linecap": "round",
    "stroke-dasharray": `${(value / 100) * circ} ${circ}`,
    transform: `rotate(-90 ${c} ${c})`,
  }));
  s.appendChild(svgEl("text", {
    x: c, y: c - 2, "text-anchor": "middle",
    "font-size": opts.big || 22, "font-weight": 700, fill: p.ink,
  }, opts.label != null ? String(opts.label) : `${Math.round(value)}%`));
  if (opts.sub) {
    s.appendChild(svgEl("text", {
      x: c, y: c + 16, "text-anchor": "middle", "font-size": 10, fill: p.soft,
    }, String(opts.sub)));
  }
  return s;
}

/** Thin horizontal meter bar. */
export function meter(pct, opts = {}) {
  const color = opts.color || palette().accent;
  return h("div", { class: "meter" },
    h("div", {
      class: "meter-fill",
      style: { width: `${Math.max(0, Math.min(100, Number(pct) || 0))}%`, background: color },
    }));
}

/** 802.1Qbv gate timeline: three lanes of open/closed blocks over one cycle. */
export function gateTimeline(slots, cycleNs, opts = {}) {
  const p = palette();
  const w = opts.w || 640;
  const laneH = 26;
  const gap = 8;
  const top = 18;
  const lanes = [
    { name: "Q7 · CONTROL", bit: 128, color: p.classes.control },
    { name: "Q4 · HP VIDEO", bit: 16, color: p.classes.hp_video },
    { name: "Q0 · BEST-EFFORT", bit: 1, color: p.classes.be_video },
  ];
  const height = top + lanes.length * (laneH + gap);
  const s = canvas(w, height, { scale: false });
  s.setAttribute("viewBox", `0 0 ${w} ${height}`);

  const total = cycleNs || slots.reduce((a, sl) => a + sl[1], 0) || 1;
  const labelW = 118;
  const trackX = labelW;
  const trackW = w - labelW - 4;

  s.appendChild(svgEl("text", {
    x: w, y: 12, "text-anchor": "end", "font-size": 11, fill: p.soft,
  }, `cycle ${(total / 1000).toLocaleString()} µs`));

  lanes.forEach((lane, li) => {
    const ly = top + li * (laneH + gap);
    s.appendChild(svgEl("text", {
      x: 0, y: ly + laneH / 2 + 4, "font-size": 11, "font-weight": 600, fill: p.soft,
    }, lane.name));
    s.appendChild(svgEl("rect", {
      x: trackX, y: ly, width: trackW, height: laneH, rx: 5, fill: p.track,
    }));
    let cursor = 0;
    for (const [gateMask, interval] of slots) {
      const open = (gateMask & lane.bit) !== 0;
      const bx = trackX + (cursor / total) * trackW;
      const bw = (interval / total) * trackW;
      if (open && bw > 0.5) {
        s.appendChild(svgEl("rect", {
          x: bx, y: ly, width: Math.max(1.5, bw - 0.5), height: laneH,
          rx: 4, fill: lane.color, opacity: 0.92,
        }));
      }
      cursor += interval;
    }
  });
  return s;
}

/** Legend row of coloured dots. Built as DOM, not an HTML string. */
export function legend(items) {
  return h("div", { class: "legend" },
    ...items.map((it) => h("span", { class: "legend-item" },
      h("i", { style: { background: it.color } }),
      String(it.label))));
}

export default { area, timeSeries, spark, gauge, meter, gateTimeline, legend };
