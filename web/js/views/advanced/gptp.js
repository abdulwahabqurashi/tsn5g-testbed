/**
 * Time Sync — gPTP (802.1AS) via ptp4l.
 *
 * The old view was read-only with zero controls, even though
 * /api/gptp/start and /api/gptp/stop had existed from the beginning. Starting
 * gPTP was only possible from the Guided Setup wizard, which is an odd place
 * to have to go to restart a daemon.
 */

import { ApiError } from "../../core/api.js";
import { defineView } from "../../core/component.js";
import { toast } from "../../core/dialog.js";
import { clear, h } from "../../core/dom.js";
import { ns } from "../../core/format.js";
import * as charts from "../../ui/charts.js";
import { bandColor, palette } from "../../ui/tokens.js";
import { badge, btnRow, button, card, field, row, select } from "../../ui/widgets.js";

// ptp4l reports the servo state; s2 is locked.
const LOCK_PCT = { s0: 0, s1: 50, s2: 100 };

export default defineView({
  name: "gptp",

  async mount(view) {
    const stateBody = h("div");
    const chartBody = h("div");
    let ifaceSelect = null;

    view.root.appendChild(h("div", { class: "grid" },
      card("Status", { span: "col5" }, stateBody),
      h("section", { class: "card col7" },
        h("div", { class: "card-head" },
          h("h3", { text: "Offset from master" }),
          h("span", { class: "hint", text: "lower and flatter is better" })),
        chartBody)));

    function paint(state) {
      const g = state?.gptp || {};
      const p = palette();
      clear(stateBody);

      const locked = Boolean(g.locked);
      const pct = LOCK_PCT[g.servo] ?? (locked ? 100 : g.running ? 50 : 0);
      stateBody.appendChild(h("div", { class: "gauge-wrap" },
        charts.gauge(pct, {
          size: 96, stroke: 9,
          color: locked ? p.ok : g.running ? p.warn : p.faint,
          label: locked ? "locked" : g.running ? "sync" : "off",
          sub: "802.1AS",
        }),
        h("div", null,
          h("div", { class: "kpi-label", text: "Servo" }),
          h("div", { style: { "font-weight": "700" }, text: g.servo || "—" }))));

      stateBody.appendChild(row("Enabled",
        badge(g.enabled ? "yes" : "no", g.enabled ? "green" : "gray")));
      stateBody.appendChild(row("Running",
        badge(g.running ? "yes" : "no", g.running ? "green" : "gray")));
      stateBody.appendChild(row("Offset", ns(g.offset_ns)));
      stateBody.appendChild(row("Path delay", ns(g.path_delay_ns)));
      stateBody.appendChild(row("Grandmaster", g.grandmaster, { mono: true }));

      const ifaces = g.interfaces || [];
      ifaceSelect = select(ifaces.length ? ifaces : ["(none available)"],
                           ifaces[0], () => {}, { class: "mini-select" });
      stateBody.appendChild(field("Interface", ifaceSelect,
                                  "needs hardware timestamping"));

      stateBody.appendChild(btnRow(
        button("Start", {
          kind: "primary", disabled: Boolean(g.running) || !ifaces.length,
          onclick: async () => {
            try {
              await view.api.gptp.start({ iface: ifaceSelect.value },
                                        { signal: view.signal });
              toast("starting ptp4l", "ok");
            } catch (err) {
              if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
            }
          },
        }),
        button("Stop", {
          kind: "danger", disabled: !g.running,
          onclick: async () => {
            try {
              await view.api.gptp.stop({ signal: view.signal });
              toast("ptp4l stopped", "ok");
            } catch (err) {
              if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
            }
          },
        })));

      if (!g.enabled) {
        stateBody.appendChild(h("p", { class: "hint" },
          "gPTP is disabled in the configuration, so it will not start "
          + "automatically on connect."));
      }
      if (!ifaces.length) {
        stateBody.appendChild(h("p", { class: "hint" },
          "No interface reports hardware timestamping. ptp4l needs one; "
          + "software timestamping is not accurate enough for 802.1AS."));
      }
    }

    function paintChart(series) {
      clear(chartBody);
      const p = palette();
      if (!series?.length) {
        chartBody.appendChild(h("p", { class: "muted" },
          "No offset samples yet. They appear once ptp4l is running."));
        return;
      }
      chartBody.appendChild(charts.timeSeries(series, {
        h: 180, colors: [p.series[3]], gapMs: 10000, fill: false,
      }));
      const last = series[series.length - 1];
      chartBody.appendChild(h("p", { class: "hint",
        text: `latest ${ns(last.v)} — ${series.length} samples over the window` }));
    }

    view.sub((s) => s.status, () => {
      paint(view.store.get().status);
      paintChart(view.store.get().series.offset);
    });

    paint(view.store.get().status);
    paintChart(view.store.get().series.offset);
  },
});
