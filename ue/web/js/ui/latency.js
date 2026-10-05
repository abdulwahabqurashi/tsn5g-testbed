/**
 * Live one-way uplink latency, camera 1's lane against camera 2's.
 *
 * Shared by the Overview. The probe runs on the daemon (net/latency.py) and the
 * reflector on the core; with PTP on both ends the delay is one-way, not half
 * a round trip.
 */

import { ApiError } from "../core/api.js";
import { clear, fill, h } from "../core/dom.js";
import { clockTime } from "../core/format.js";
import * as charts from "./charts.js";
import { axisRow, chip, chips, healthStrip, seg } from "./observe.js";
import { palette } from "./tokens.js";
import { badge, button } from "./widgets.js";

const RANGES = [{ value: 5, label: "5m" }, { value: 15, label: "15m" }, { value: 60, label: "1h" }];

/** Mounts the card into `host`; polls every 3 s for the life of `view`. */
export function latencyCard(view, host, { span = "col12" } = {}) {
  const head = h("div", { class: "card-head" });
  const body = h("div");
  host.appendChild(h("section", { class: `card ${span}` }, head, body));
  let range = 15;
  let zoom = "all";

  async function load() {
    let st; let hist;
    try {
      [st, hist] = await Promise.all([view.api.latency.status({ signal: view.signal }),
                                      view.api.latency.history(range, { signal: view.signal })]);
    } catch (err) {
      if (!(err instanceof ApiError && err.isAborted)) {
        fill(head, h("h3", { text: "Camera lanes, one-way delay" }));
        fill(body, h("p", { class: "muted", text: err.message }));
      }
      return;
    }
    paint(st, hist);
  }

  function paint(st, hist) {
    const p = palette();
    const on = st.config?.enabled;
    const state = !on ? ["off", "gray"] : !st.bound_to ? ["5G link down", "amber"]
      : !st.reflector ? ["no reply from the core", "red"] : ["live", "green"];
    fill(head,
      h("div", { class: "head-l" }, h("h3", { text: "Camera lanes, one-way delay" }), badge(state[0], state[1])),
      h("div", { class: "head-r" },
        seg([{ value: "all", label: "Both" }, { value: "protected", label: "Camera 1" }],
            zoom, (v) => { zoom = v; load(); }),
        seg(RANGES, range, (v) => { range = v; load(); }),
        on ? null : button("Start probe", { kind: "primary",
          onclick: async () => { await view.api.latency.set({ enabled: true }, { signal: view.signal }); load(); } })));
    clear(body);
    if (on && st.bound_to && !st.reflector) {
      body.appendChild(h("p", { class: "hint", text:
        "No replies. On the core: sudo systemctl start tsn5g-latency-reflector" }));
    }
    const pr = hist.protected || [];
    const be = hist.best_effort || [];
    const cur = st.current || {};
    const f = (v) => (v == null ? "—" : `${v} ms`);
    const lostP = pr.reduce((a, r) => a + r.lost, 0);
    const sentP = pr.reduce((a, r) => a + r.n + r.lost, 0);
    body.appendChild(chips(
      chip(p.series[0], "Camera 1"),
      chip(p.series[3], "Camera 1 p99"),
      chip(p.series[2], "Camera 2", f(cur.best_effort?.up_p50)),
      chip(null, "Camera 1 loss", sentP ? `${((100 * lostP) / sentP).toFixed(2)} %` : "—")));
    if (!pr.length && !be.length) {
      body.appendChild(h("div", { class: "empty-chart", text: on ? "Waiting for samples…" : "The probe is off." }));
      return;
    }
    const to = Date.now();
    const from = to - range * 60 * 1000;
    const scaleRows = zoom === "protected" ? pr : [...pr, ...be];
    const all = scaleRows.flatMap((r) => [r.up_p50, r.up_p99]).filter((v) => v != null).sort((a, b) => a - b);
    const hi = Math.max(10, (all[Math.floor(0.98 * (all.length - 1))] || 10) * (zoom === "protected" ? 1.15 : 1));
    // values above the scale are drawn at its top edge rather than off the chart
    const ser = (rows, k) => rows.map((r) => ({ t: r.t * 1000, v: r[k] == null ? null : Math.min(r[k], hi) }));
    body.appendChild(h("div", { class: "chart-wrap" },
      charts.timeSeries([ser(pr, "up_p50"), ser(pr, "up_p99"), ser(be, "up_p50")], {
        h: 190, colors: [p.series[0], p.series[3], p.series[2]], fill: false, gapMs: 5000,
        min: 0, max: hi, from, to })));
    body.appendChild(healthStrip(pr.map((r) => ({ ...r, t: r.t * 1000 })), from, to,
      (r) => (r.lost ? "err" : r.up_p99 > 100 ? "warn" : "ok")));
    body.appendChild(axisRow(clockTime(from / 1000), `0–${Math.round(hi)} ms`, clockTime(to / 1000)));
  }

  load();
  view.interval(load, 3000);
}
