/**
 * Diagnostics — one page to attach to a bug report.
 *
 * Replaces a view whose entire debug surface was JSON.stringify(status) in a
 * <pre>. The snapshot endpoint gathers what a question about this rig actually
 * needs — controller state, modem, bearer, routing tables, recent log — so the
 * first reply is an answer rather than "can you also send...".
 *
 * It is the successor to diag.sh, which had to be run over SSH.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { toast } from "../core/dialog.js";
import { clear, h } from "../core/dom.js";
import { clockTime, ms } from "../core/format.js";
import * as charts from "../ui/charts.js";
import { palette } from "../ui/tokens.js";
import { badge, btnRow, button, card, row, table } from "../ui/widgets.js";

export default defineView({
  name: "diagnostics",

  async mount(view) {
    const summaryBody = h("div");
    const shellBody = h("div");
    const ifaceBody = h("div");

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "Snapshot" }),
          h("span", { class: "hint", text: "everything a bug report needs" })),
        h("p", { class: "section-hint" },
          "Gathers controller state, the modem and bearer, the routing tables "
          + "and the recent log in one call — the successor to diag.sh."),
        btnRow(
          button("Refresh", { kind: "primary", onclick: load }),
          button("Copy all", { onclick: copyAll })),
        summaryBody),
      card("Interface counters", { span: "col6" }, ifaceBody),
      h("section", { class: "card col6" },
        h("div", { class: "card-head" },
          h("h3", { text: "Kernel state" }),
          h("span", { class: "hint", text: "addresses, routes, firewall" })),
        shellBody)));

    let snapshot = null;

    async function copyAll() {
      if (!snapshot) { toast("nothing captured yet"); return; }
      try {
        await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
        toast("snapshot copied to the clipboard", "ok");
      } catch {
        toast("clipboard unavailable — use GET /api/debug/snapshot", "err");
      }
    }

    function paintSummary(s) {
      clear(summaryBody);
      const st = s.status || {};
      const b = s.bearer || {};
      const r = s.radio || {};
      summaryBody.appendChild(h("div", { class: "kpis" },
        h("div", { class: "kpi" },
          h("div", { class: "kpi-label", text: "STATE" }),
          h("div", { class: "kpi-val", text: st.state || "—" })),
        h("div", { class: "kpi" },
          h("div", { class: "kpi-label", text: "BEARER" }),
          h("div", { class: "kpi-val", text: b.ipv4 || "down" })),
        h("div", { class: "kpi" },
          h("div", { class: "kpi-label", text: "RAT" }),
          h("div", { class: "kpi-val", text: r.rat || "—" })),
        h("div", { class: "kpi" },
          h("div", { class: "kpi-label", text: "ROUTING" }),
          h("div", { class: "kpi-val",
                     text: s.routing?.applied ? "applied" : "none" }))));

      const errs = [];
      for (const [k, v] of Object.entries(s)) {
        if (v && typeof v === "object" && v.error) errs.push(`${k}: ${v.error}`);
      }
      if (errs.length) {
        summaryBody.appendChild(h("div", { class: "kpi-label",
                                           style: { "margin-top": "12px" },
                                           text: "Collection errors" }));
        summaryBody.appendChild(h("pre", { class: "log", text: errs.join("\n") }));
      }
    }

    function paintShell(shell) {
      clear(shellBody);
      for (const [name, lines] of Object.entries(shell || {})) {
        shellBody.appendChild(h("div", { class: "kpi-label",
                                         text: name.replace(/_/g, " ") }));
        shellBody.appendChild(h("pre", { class: "log",
          style: { "max-height": "130px" },
          text: (lines || []).join("\n") || "(empty)" }));
      }
    }

    function paintInterfaces(state) {
      const stats = state.stats?.interfaces || {};
      clear(ifaceBody);
      const names = Object.keys(stats).sort();
      if (!names.length) {
        ifaceBody.appendChild(h("p", { class: "muted" }, "No counters yet."));
        return;
      }
      ifaceBody.appendChild(table(["Interface", "RX/s", "TX/s", "RX drop", "TX drop"],
        names.map((n) => {
          const s = stats[n];
          return [
            h("span", { class: "mono", text: n }),
            `${((s.rx_bytes_per_s || 0) * 8 / 1e6).toFixed(2)} Mbit/s`,
            `${((s.tx_bytes_per_s || 0) * 8 / 1e6).toFixed(2)} Mbit/s`,
            s.rx_dropped ?? "—", s.tx_dropped ?? "—",
          ];
        })));
    }

    async function load() {
      clear(summaryBody);
      summaryBody.appendChild(h("div", { class: "skeleton-wrap" },
        h("div", { class: "skeleton-row" }), h("div", { class: "skeleton-row" })));
      try {
        snapshot = await view.api.debug.snapshot({ signal: view.signal });
        paintSummary(snapshot);
        paintShell(snapshot.shell);
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(summaryBody);
        summaryBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
    }

    view.sub((s) => s.stats, () => paintInterfaces(view.store.get()));
    paintInterfaces(view.store.get());
    await load();
  },
});
