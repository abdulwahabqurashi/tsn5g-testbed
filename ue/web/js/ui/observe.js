/**
 * Observability building blocks, shared by Time Sync and Tests.
 *
 * The visual language is UniFi's: metric chips above a chart, a thin health
 * strip under it, a path of nodes across the top, an event list beside it,
 * inline bars in tables, and a waterfall heatmap. Every colour comes from the
 * tokens (palette()), so dark mode and the lint rule both hold.
 */

import { h, svg } from "../core/dom.js";
import { palette } from "./tokens.js";

/** A metric chip: coloured key, label, value. */
export function chip(color, label, value) {
  return h("span", { class: "chip" },
    color ? h("i", { style: { background: color } }) : null,
    label, value != null ? h("b", { text: String(value) }) : null);
}

export function chips(...items) {
  return h("div", { class: "chips" }, ...items.filter(Boolean));
}

/** Segmented control. options: [{value, label}] */
export function seg(options, value, onchange) {
  return h("div", { class: "seg" }, ...options.map((o) => h("button", {
    class: o.value === value ? "on" : "", text: o.label,
    onclick: () => onchange(o.value),
  })));
}

/**
 * Health strip: `buckets` evenly spaced cells over [from, to], each coloured
 * by the worst state among the samples that fall in it (no samples = off).
 * stateOf(sample) -> "ok" | "warn" | "err".
 */
export function healthStrip(samples, from, to, stateOf, buckets = 120) {
  const rank = { off: 0, ok: 1, warn: 2, err: 3 };
  const cells = new Array(buckets).fill("off");
  const span = Math.max(1, to - from);
  for (const s of samples) {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor(((s.t - from) / span) * buckets)));
    const st = stateOf(s);
    if (rank[st] > rank[cells[i]]) cells[i] = st;
  }
  return h("div", { class: "health-strip" }, ...cells.map((c) => h("span", { class: `hs-${c}` })));
}

export function axisRow(...labels) {
  return h("div", { class: "axis-row" }, ...labels.map((l) => h("span", { text: l })));
}

/** Event list: [{t (s), kind, text}] newest first. */
export function eventList(events, fmtTime) {
  if (!events.length) return h("p", { class: "muted", text: "No events in this window." });
  return h("div", { class: "ev-list" }, ...[...events].reverse().map((e) => h("div", { class: "ev" },
    h("span", { class: `ev-dot ${e.kind || ""}` }),
    h("span", { text: e.text }),
    h("span", { class: "ev-t", text: fmtTime(e.t) }))));
}

/** Inline bar for a table cell. */
export function barCell(value, max, color, text) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return h("div", { class: "bar-cell" },
    h("div", { class: "bc-track" }, h("div", { class: "bc-fill", style: { width: `${pct}%`, background: color } })),
    h("span", { class: "bc-val", text }));
}

/** Path node and link for the .topo strip. state: ok | warn | err | "" */
export function topoNode(iconEl, name, sub, state = "") {
  return h("div", { class: `topo-node ${state}` },
    h("div", { class: "tn-ic" }, iconEl),
    h("div", { class: "tn-name", text: name }),
    sub ? h("div", { class: "tn-sub", text: sub }) : null);
}

export function topoLink(top, bottom, state = "") {
  return h("div", { class: `topo-link ${state}` },
    h("div", { class: "tl-q", text: top || "" }),
    h("div", { class: "tl-line" }),
    h("div", { class: "tl-lbl", text: bottom || "" }));
}

// ---- colour scale --------------------------------------------------------------
function rgb(color) {
  const c = color.trim();
  if (c.startsWith("#")) {
    const n = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1);
    return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  }
  const m = c.match(/\d+(\.\d+)?/g);
  return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
}

/** 0 -> good (green), 0.5 -> amber, 1 -> bad (red), mixed from the tokens. */
export function heatColor(t) {
  const p = palette();
  const [a, b, u] = t < 0.5 ? [p.ok, p.warn, t / 0.5] : [p.warn, p.err, (t - 0.5) / 0.5];
  const A = rgb(a); const B = rgb(b);
  const c = A.map((x, i) => Math.round(x + (B[i] - x) * Math.max(0, Math.min(1, u))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function heatScale(lowLabel, highLabel) {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => `${heatColor(t)} ${t * 100}%`).join(",");
  return h("div", { class: "heat-scale" }, lowLabel,
    h("span", { class: "hsc", style: { background: `linear-gradient(90deg,${stops})` } }), highLabel);
}

/**
 * Waterfall heatmap. rows: [{label, values: [..], mark: index|null}], same
 * length each; values coloured on [lo, hi]. xLabels: [[index, text]].
 */
export function heatmap(rows, { lo, hi, xLabels = [], rowH = 22, labelW = 64, w = 760 } = {}) {
  const p = palette();
  const n = rows[0]?.values.length || 1;
  const cw = (w - labelW) / n;
  const height = rows.length * rowH + 20;
  const s = svg("svg", { class: "heat", viewBox: `0 0 ${w} ${height}`, preserveAspectRatio: "none",
                         role: "img" });
  rows.forEach((r, ri) => {
    const y = ri * rowH;
    s.appendChild(svg("text", { x: 0, y: y + rowH * 0.68, "font-size": 11, fill: p.soft, text: r.label }));
    r.values.forEach((v, ci) => {
      const t = v == null ? null : (v - lo) / Math.max(1e-9, hi - lo);
      s.appendChild(svg("rect", { x: labelW + ci * cw, y: y + 1, width: cw + 0.5, height: rowH - 2,
                                  fill: t == null ? p.track : heatColor(t) }));
    });
    if (r.mark != null) {
      const x = labelW + (r.mark + 0.5) * cw;
      s.appendChild(svg("circle", { cx: x, cy: y + rowH / 2, r: 4.5, fill: p.panel, stroke: p.ink, "stroke-width": 2 }));
    }
  });
  for (const [i, text] of xLabels) {
    s.appendChild(svg("text", { x: labelW + i * cw, y: height - 4, "font-size": 10, fill: p.faint,
                                "text-anchor": i === 0 ? "start" : (i >= n ? "end" : "middle"), text }));
  }
  return s;
}
