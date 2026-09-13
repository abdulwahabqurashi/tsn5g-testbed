/** Shared building blocks, so a card looks the same in every view. */

import { h } from "../core/dom.js";
import { DASH } from "../core/format.js";

export function card(title, opts = {}, ...body) {
  const head = h("div", { class: "card-head" },
    h("h3", { text: title }),
    opts.hint ? h("span", { class: "hint" }, opts.hint) : null);
  return h("section", { class: `card ${opts.span || "col4"}` }, head, ...body);
}

export function row(key, value, opts = {}) {
  return h("div", { class: "row" },
    h("span", { class: "k", text: key }),
    h("span", { class: `v${opts.mono ? " mono" : ""}${opts.cls ? ` ${opts.cls}` : ""}` },
      value === null || value === undefined || value === "" ? DASH : String(value)));
}

export function kpi(label, value, sub) {
  return h("div", { class: "kpi" },
    h("div", { class: "kpi-label", text: label }),
    h("div", { class: "kpi-val" },
      value === null || value === undefined ? DASH : String(value),
      sub ? h("small", { text: ` ${sub}` }) : null));
}

export function badge(text, kind = "gray") {
  return h("span", { class: `badge ${kind}`, text: String(text) });
}

export function dot(kind = "idle") {
  return h("span", { class: `dot ${kind}` });
}

export function button(label, opts = {}) {
  return h("button", {
    class: `btn${opts.kind ? ` ${opts.kind}` : ""}`,
    type: "button",
    disabled: opts.disabled || false,
    onclick: opts.onclick,
    title: opts.title || null,
  }, label);
}

export function field(label, control, hint) {
  return h("label", { class: "fld" }, label, control,
    hint ? h("span", { class: "hint", text: hint }) : null);
}

export function select(options, value, onchange, attrs = {}) {
  const node = h("select", { ...attrs, onchange: (e) => onchange(e.target.value) },
    ...options.map((o) => h("option", {
      value: typeof o === "string" ? o : o.value,
      text: typeof o === "string" ? o : o.label,
    })));
  if (value !== undefined && value !== null) node.value = value;
  return node;
}

export function table(headers, rows) {
  return h("table", { class: "tbl" },
    h("thead", null, h("tr", null, ...headers.map((x) => h("th", { text: x })))),
    h("tbody", null, ...rows.map((cells) => h("tr", null,
      ...cells.map((c) => h("td", null, c instanceof Node ? c
        : (c === null || c === undefined ? DASH : String(c))))))));
}

export function btnRow(...buttons) {
  return h("div", { class: "btn-row" }, ...buttons.filter(Boolean));
}

/** A labelled bar for one antenna branch. */
export function barRow(label, value, pct, colour, unit = "dBm") {
  return h("div", { class: "bar-row" },
    h("span", { class: "lab", text: label }),
    h("div", { class: "meter" },
      h("div", {
        class: "meter-fill",
        style: { width: `${Math.max(0, Math.min(100, pct))}%`, background: colour },
      })),
    h("span", { class: "val" },
      value === null || value === undefined ? DASH : `${value} ${unit}`));
}
