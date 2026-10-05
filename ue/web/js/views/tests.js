/**
 * Tests: the saved results of the measurement tools, drawn to be read at a
 * glance (radio clock drift, the Qbv / priority uplink test, the camera demo).
 *
 * The tools run from a shell (tools/gnb-drift.sh, tools/qbv-live.sh,
 * tools/demo-run.sh) and leave one directory per run; /api/results reads them.
 * A run still in progress refreshes itself every 30 s.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { clear, fill, h } from "../core/dom.js";
import { clockTime } from "../core/format.js";
import * as charts from "../ui/charts.js";
import { axisRow, barCell, chip, chips, healthStrip, heatmap, heatScale, seg } from "../ui/observe.js";
import { palette } from "../ui/tokens.js";
import { badge, button } from "../ui/widgets.js";

const LIVE_RANGES = [{ value: 5, label: "5 min" }, { value: 15, label: "15 min" }, { value: 60, label: "1 h" }];

const KIND_BADGE = { drift: ["clock drift", "blue"], qbv: ["uplink QoS", "green"], demo: ["camera demo", "amber"] };

function when(ts) {
  const d = new Date(ts * 1000);
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${clockTime(ts)}`;
}

function kpi(label, value, sub, color) {
  return h("div", { class: "kpi" },
    h("div", { class: "kpi-label", text: label }),
    h("div", { class: "big-num", style: color ? { color } : {}, text: value }),
    sub ? h("div", { class: "kpi-sub", text: sub }) : null);
}

export default defineView({
  name: "tests",

  async mount(view) {
    const listBody = h("div", { class: "run-list" });
    const detailHead = h("div", { class: "card-head" });
    const detailBody = h("div");
    let runs = [];
    let current = null;     // {kind, id}
    let refresh = null;
    const liveHead = h("div", { class: "card-head" });
    const liveBody = h("div");
    let liveRange = 15;
    let liveZoom = "all";      // "all" | "protected": scale to camera 1's lane

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col12" }, liveHead, liveBody),
      h("section", { class: "card col4" },
        h("div", { class: "card-head" }, h("h3", { text: "Runs" }),
          h("span", { class: "hint", text: "newest first" })),
        listBody),
      h("section", { class: "card col8" }, detailHead, detailBody)));

    function paintList() {
      clear(listBody);
      if (!runs.length) {
        listBody.appendChild(h("p", { class: "muted",
          text: "No saved runs yet. Results appear here when tools/gnb-drift.sh, qbv-live.sh or demo-run.sh finish." }));
        return;
      }
      for (const r of runs) {
        const on = current && current.kind === r.kind && current.id === r.id;
        const [text, kind] = KIND_BADGE[r.kind] || [r.kind, "gray"];
        listBody.appendChild(h("button", {
          class: `run-item${on ? " on" : ""}`,
          onclick: () => { current = { kind: r.kind, id: r.id }; paintList(); loadRun(); },
        },
          h("div", { class: "ri-top" }, h("span", null, badge(text, kind)),
            h("span", { class: "ri-when", text: when(r.started) })),
          h("div", { class: "ri-head", text: r.headline })));
      }
    }

    // ---- drift ----------------------------------------------------------------
    function paintDrift(d) {
      const p = palette();
      const scans = d.scans || [];
      const verdictColor = { stable: "var(--green-ink)", drifting: "var(--red-ink)", running: "var(--blue)" }[d.verdict];
      fill(detailHead, h("h3", { text: "Radio clock drift" }),
        badge(d.verdict === "running" ? `running · ${scans.length} scan(s)` : d.verdict,
              { stable: "green", drifting: "red", running: "blue" }[d.verdict] || "gray"));
      clear(detailBody);
      detailBody.appendChild(h("div", { class: "kpis", style: { "grid-template-columns": "repeat(4, minmax(0,1fr))" } },
        kpi("Verdict", d.verdict === "running" ? "…" : d.verdict, d.verdict === "drifting"
          ? `whole frame every ~${d.full_cycle_hours} h` : d.verdict === "stable" ? "gNB holds PTP time" : "needs 3+ scans",
          verdictColor),
        kpi("Drift", d.drift_us_per_min == null ? "—" : `${d.drift_us_per_min > 0 ? "+" : ""}${d.drift_us_per_min}`,
            "µs per minute"),
        kpi("Clock error", d.ppm == null ? "—" : `${d.ppm > 0 ? "+" : ""}${d.ppm}`, "ppm (X410 vs PTP)"),
        kpi("Scans", String(scans.length), scans.length ? `over ${Math.round((scans[scans.length - 1].t - scans[0].t) / 60)} min` : "")));
      if (!scans.length) {
        detailBody.appendChild(h("p", { class: "muted", text: "No scans yet." }));
        return;
      }
      // waterfall: one row per scan across the 5 ms frame, the jump marked
      const all = scans.flatMap((s) => s.p10_us);
      const sorted = [...all].sort((a, b) => a - b);
      const lo = sorted[0];
      const hi = sorted[Math.floor(0.95 * (sorted.length - 1))];
      const n = scans[0].offsets_us.length;
      const step = scans[0].offsets_us[1] - scans[0].offsets_us[0];
      const rows = scans.map((s) => ({
        label: `+${Math.round((s.t - scans[0].t) / 60)} min`,
        values: s.p10_us,
        mark: s.offsets_us.indexOf(s.edge_us),
      }));
      detailBody.appendChild(h("div", { class: "card-head", style: { margin: "18px 0 6px" } },
        h("h3", { text: "Where the uplink chance falls in the 5 ms radio frame" }),
        heatScale("fast", "slow")));
      detailBody.appendChild(heatmap(rows, {
        lo, hi, rowH: 24,
        xLabels: [0, 1, 2, 3, 4, 5].map((ms) => [Math.round((ms * 1000) / step), `${ms} ms`]).filter(([i]) => i <= n),
      }));
      detailBody.appendChild(h("p", { class: "hint", text:
        "Each row is one scan: the fastest delay for a packet sent at that point of the frame. "
        + "The ring marks the jump. A straight vertical line of rings means the radio holds PTP time; "
        + "a diagonal means it drifts." }));
      if (scans.length >= 2) {
        const pts = scans.map((s) => ({ t: s.t * 1000, v: (s.edge_unwrapped_us ?? s.edge_us) / 1000 }));
        detailBody.appendChild(h("div", { class: "card-head", style: { margin: "18px 0 6px" } },
          h("h3", { text: "Jump position over time" }),
          chips(chip(p.series[0], "position", `${pts[pts.length - 1].v.toFixed(1)} ms`))));
        detailBody.appendChild(charts.timeSeries([pts], { h: 140, colors: [p.series[0]], fill: false,
                                                           gapMs: 3600 * 1000 }));
      }
    }

    // ---- qbv ------------------------------------------------------------------
    function paintQbv(d) {
      const p = palette();
      const ph = d.phases || [];
      fill(detailHead, h("h3", { text: "Uplink QoS test" }),
        h("span", { class: "hint", text: `flood ${d.flood_mbps ?? "?"} Mbit/s · shaper ${d.shaper_mbps ?? "?"} Mbit/s` }));
      clear(detailBody);
      if (!ph.length) {
        detailBody.appendChild(h("p", { class: "muted", text: "No phases in this run." }));
        return;
      }
      const best = ph.find((x) => x.phase === "R-auto") || ph.find((x) => x.phase === "B-uni") || ph[0];
      const none = ph.find((x) => x.phase === "A-none");
      detailBody.appendChild(h("div", { class: "kpis", style: { "grid-template-columns": "repeat(3, minmax(0,1fr))" } },
        kpi("Protected loss", `${best.loss_pct} %`, best.label, best.loss_pct === 0 ? "var(--green-ink)" : "var(--red-ink)"),
        kpi("Median delay", `${best.p50_ms} ms`, "above the best packet"),
        kpi("p99 delay", `${best.p99_ms} ms`, none ? `${none.p99_ms} ms with no policy` : best.label)));
      const maxP99 = Math.max(...ph.map((x) => x.p99_ms));
      const maxLoss = Math.max(1, ...ph.map((x) => x.loss_pct));
      detailBody.appendChild(h("div", { class: "card-head", style: { margin: "18px 0 6px" } },
        h("h3", { text: "Phases" }),
        chips(chip(p.err, "loss"), chip(p.series[0], "median"), chip(p.series[3], "p99"))));
      detailBody.appendChild(h("table", { class: "tbl" },
        h("thead", null, h("tr", null, ...["Phase", "Loss", "Median", "p99", "Flood"].map((t) => h("th", { text: t })))),
        h("tbody", null, ...ph.map((x) => h("tr", null,
          h("td", { text: x.label }),
          h("td", null, barCell(x.loss_pct, maxLoss, p.err, `${x.loss_pct} %`)),
          h("td", null, barCell(x.p50_ms, maxP99, p.series[0], `${x.p50_ms} ms`)),
          h("td", null, barCell(x.p99_ms, maxP99, p.series[3], `${x.p99_ms} ms`)),
          h("td", { text: x.flood_mbps == null ? "—" : `${x.flood_mbps} Mbit/s` }))))));
    }

    // ---- demo -----------------------------------------------------------------
    function paintDemo(d) {
      const p = palette();
      if (d.running) {
        const done = d.done || [];
        fill(detailHead, h("h3", { text: "Camera demo" }), badge(`running · ${done.length} of ${d.total} phases`, "blue"));
        clear(detailBody);
        detailBody.appendChild(h("div", { class: "health-strip", style: { height: "10px" } },
          ...Array.from({ length: d.total }, (_, i) => h("span", {
            class: i < done.length ? (done[i].policy === "limited" ? "hs-ok" : "hs-warn") : "hs-off" }))));
        detailBody.appendChild(h("p", { class: "hint", style: { "margin-top": "10px" }, text:
          "Results appear here when the run finishes (about 8 minutes in all). Green = policy on, amber = policy off. "
          + "Watch the live latency card above meanwhile." }));
        if (done.length) {
          detailBody.appendChild(h("table", { class: "tbl" },
            h("thead", null, h("tr", null, ...["Phase", "Policy", "Flood"].map((t) => h("th", { text: t })))),
            h("tbody", null, ...done.map((x) => h("tr", null,
              h("td", { text: `${x.phase} ${x.name}` }),
              h("td", null, badge(x.policy === "limited" ? "on" : "off", x.policy === "limited" ? "green" : "gray")),
              h("td", { text: x.flood }))))));
        }
        return;
      }
      const on = d.summary?.on;
      const off = d.summary?.off;
      fill(detailHead, h("h3", { text: "Camera demo" }),
        h("span", { class: "hint", text: "share of each camera's frames that reached the core" }));
      clear(detailBody);
      detailBody.appendChild(h("div", { class: "kpis", style: { "grid-template-columns": "repeat(3, minmax(0,1fr))" } },
        kpi("Camera 1, policy on", on ? `${on.cam1_pct} %` : "—", "protected", "var(--green-ink)"),
        kpi("Camera 1, policy off", off ? `${off.cam1_pct} %` : "—", "same flood", "var(--red-ink)"),
        kpi("Camera 2, policy on", on ? `${on.cam2_pct} %` : "—", "gives way (best effort)")));
      detailBody.appendChild(h("div", { class: "card-head", style: { margin: "18px 0 6px" } },
        h("h3", { text: "Phases" }), chips(chip(p.series[0], "camera 1"), chip(p.series[2], "camera 2"))));
      detailBody.appendChild(h("table", { class: "tbl" },
        h("thead", null, h("tr", null, ...["Phase", "Policy", "Camera 1", "Camera 2", "SINR"].map((t) => h("th", { text: t })))),
        h("tbody", null, ...(d.phases || []).map((x) => h("tr", null,
          h("td", { text: `${x.phase} ${x.name}` }),
          h("td", null, badge(x.policy === "limited" ? "on" : "off", x.policy === "limited" ? "green" : "gray")),
          h("td", null, barCell(x.cam1_pct, 100, p.series[0], `${x.cam1_pct} %`)),
          h("td", null, barCell(x.cam2_pct, 100, p.series[2], `${x.cam2_pct} %`)),
          h("td", { text: x.sinr_db == null ? "—" : `${x.sinr_db} dB` }))))));
    }

    async function loadRun() {
      if (!current) return;
      try {
        const d = await view.api.results.get(current.kind, current.id, { signal: view.signal });
        ({ drift: paintDrift, qbv: paintQbv, demo: paintDemo }[d.kind] || (() => {}))(d);
        if (refresh) { clearInterval(refresh); refresh = null; }
        if ((d.kind === "drift" && d.verdict === "running") || (d.kind === "demo" && d.running)) {
          refresh = view.interval(async () => { await loadList(); await loadRun(); }, 30000);
        }
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          fill(detailBody, h("p", { class: "muted", text: err.message }));
        }
      }
    }

    async function loadList() {
      try {
        runs = (await view.api.results.list({ signal: view.signal })).runs || [];
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          fill(listBody, h("p", { class: "muted", text: err.message }));
        }
        return;
      }
      if (!current && runs.length) current = { kind: runs[0].kind, id: runs[0].id };
      paintList();
    }

    // ---- live one-way latency ---------------------------------------------------
    async function loadLive() {
      let st; let hist;
      try {
        [st, hist] = await Promise.all([view.api.latency.status({ signal: view.signal }),
                                        view.api.latency.history(liveRange, { signal: view.signal })]);
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          fill(liveHead, h("h3", { text: "Live one-way latency" }));
          fill(liveBody, h("p", { class: "muted", text: err.message }));
        }
        return;
      }
      paintLive(st, hist);
    }

    function paintLive(st, hist) {
      const p = palette();
      const on = st.config?.enabled;
      const state = !on ? ["off", "gray"] : !st.bound_to ? ["bearer down", "amber"]
        : !st.reflector ? ["no reply from the core", "red"] : ["live", "green"];
      fill(liveHead,
        h("div", { style: { display: "flex", gap: "10px", "align-items": "center" } },
          h("h3", { text: "Live one-way latency, uplink" }), badge(state[0], state[1])),
        h("div", { style: { display: "flex", gap: "10px", "align-items": "center" } },
          seg([{ value: "all", label: "Both lanes" }, { value: "protected", label: "Zoom: protected" }],
              liveZoom, (v) => { liveZoom = v; loadLive(); }),
          seg(LIVE_RANGES, liveRange, (v) => { liveRange = v; loadLive(); }),
          button(on ? "Stop" : "Start", { kind: on ? "" : "primary",
            onclick: async () => { await view.api.latency.set({ enabled: !on }, { signal: view.signal }); loadLive(); } })));
      clear(liveBody);
      if (on && st.bound_to && !st.reflector) {
        liveBody.appendChild(h("p", { class: "hint", text:
          "No replies yet. The core must run the reflector: sudo systemctl start tsn5g-latency-reflector "
          + "(or python3 ~/tsn5g-testbed/core/scripts/latency-reflector.py)." }));
      }
      const pr = hist.protected || [];
      const be = hist.best_effort || [];
      const cur = st.current || {};
      const f = (v) => (v == null ? "—" : `${v} ms`);
      const lostP = pr.reduce((a, r) => a + r.lost, 0);
      const sentP = pr.reduce((a, r) => a + r.n + r.lost, 0);
      liveBody.appendChild(chips(
        chip(p.series[0], "Protected, median", f(cur.protected?.up_p50)),
        chip(p.series[3], "Protected, p99", f(cur.protected?.up_p99)),
        chip(p.series[2], "Best effort, median", f(cur.best_effort?.up_p50)),
        chip(null, "Downlink, median", f(cur.protected?.down_p50)),
        chip(null, "Protected loss", sentP ? `${((100 * lostP) / sentP).toFixed(2)} %` : "—")));
      if (!pr.length && !be.length) {
        liveBody.appendChild(h("p", { class: "muted", style: { "margin-top": "10px" },
          text: "No samples in this window yet." }));
        return;
      }
      const to = Date.now();
      const from = to - liveRange * 60 * 1000;
      // values above the scale are drawn at its top edge rather than off the chart
      const ser = (rows, k) => rows.map((r) => ({ t: r.t * 1000, v: r[k] == null ? null : Math.min(r[k], hi) }));
      const scaleRows = liveZoom === "protected" ? pr : [...pr, ...be];
      const all = scaleRows.flatMap((r) => [r.up_p50, r.up_p99]).filter((v) => v != null).sort((a, b) => a - b);
      const hi = Math.max(10, (all[Math.floor(0.98 * (all.length - 1))] || 10) * (liveZoom === "protected" ? 1.15 : 1));
      const clipped = liveZoom === "protected" && be.some((r) => r.up_p50 > hi);
      liveBody.appendChild(h("div", { style: { "margin-top": "10px" } },
        charts.timeSeries([ser(pr, "up_p50"), ser(pr, "up_p99"), ser(be, "up_p50")], {
          h: 180, colors: [p.series[0], p.series[3], p.series[2]], fill: false, gapMs: 5000,
          min: 0, max: hi, from, to })));
      liveBody.appendChild(healthStrip(pr.map((r) => ({ ...r, t: r.t * 1000 })), from, to,
        (r) => (r.lost ? "err" : r.up_p99 > 100 ? "warn" : "ok")));
      liveBody.appendChild(axisRow(clockTime(from / 1000),
        `one-way, camera 1's lane vs camera 2's; scale 0 to ${Math.round(hi)} ms${clipped ? " (best effort runs off the top)" : ""}; strip: red = loss, amber = p99 over 100 ms`,
        clockTime(to / 1000)));
    }

    await loadLive();
    view.interval(loadLive, 3000);
    await loadList();
    await loadRun();
  },
});
