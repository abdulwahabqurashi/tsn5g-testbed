/**
 * Signal — radio telemetry and history.
 *
 * RSRP and SINR are shown separately and never averaged into one "signal"
 * number, because they say different things. This rig sits at RSRP -102
 * ("poor" received power) with SINR 18 ("good" quality) and gets 88-133 Mbps —
 * a single bar would hide exactly the thing that explains that.
 *
 * The per-antenna panel exists for one check: all four branches at -140 (or
 * the -32768 sentinel) means no RF is reaching the modem at all, which is an
 * antenna or cabling fault rather than coverage. The serving-cell RSRP is the
 * best branch, so it hides a single dead antenna.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { toast } from "../core/dialog.js";
import { clear, h } from "../core/dom.js";
import { ago, db, dbm, nn, signalBand } from "../core/format.js";
import * as charts from "../ui/charts.js";
import { bandColor, palette } from "../ui/tokens.js";
import { badge, barRow, btnRow, button, card, row, select } from "../ui/widgets.js";

const WINDOWS = [
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "6h", label: "6 hours" },
  { value: "24h", label: "24 hours" },
];

// Map a metric to 0..100 for the gauge. Ranges are the useful span, not the
// theoretical one — a gauge that never leaves its first eighth is useless.
const SPAN = { rsrp: [-120, -70], rsrq: [-20, -5], sinr: [-5, 30] };

function pct(metric, value) {
  if (value === null || value === undefined) return 0;
  const [lo, hi] = SPAN[metric];
  return Math.max(0, Math.min(100, ((Number(value) - lo) / (hi - lo)) * 100));
}

export default defineView({
  name: "signal",

  async mount(view) {
    const state = { window: "15m" };

    const liveBody = h("div");
    const branchBody = h("div");
    const cellBody = h("div");
    const chartBody = h("div");
    const staleNote = h("span", { class: "hint" });

    const windowSel = select(WINDOWS, state.window, (v) => {
      state.window = v;
      loadHistory();
    }, { class: "mini-select", "aria-label": "History window" });

    view.root.appendChild(h("div", { class: "grid" },
      card("Live", { span: "col4" }, liveBody),
      card("Per antenna branch", { span: "col4" }, branchBody),
      card("Serving cell", { span: "col4" }, cellBody),
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "History" }),
          h("div", { class: "toolbar", style: { margin: "0" } },
            staleNote, windowSel,
            button("Sample now", {
              onclick: async () => {
                try {
                  paintLive(await view.api.signal.sample({ signal: view.signal }));
                  toast("sampled", "ok");
                } catch (err) {
                  if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
                }
              },
            }),
            button("Export CSV", { onclick: exportCsv }))),
        chartBody)));

    // ---- live -------------------------------------------------------------
    function gaugeFor(metric, value, unit) {
      const band = signalBand(metric, value);
      return h("div", { class: "gauge-wrap" },
        charts.gauge(pct(metric, value), {
          size: 92, stroke: 9, color: bandColor(band),
          label: value === null || value === undefined ? "—" : String(value),
          sub: unit,
        }),
        h("div", null,
          h("div", { class: "kpi-label", text: metric.toUpperCase() }),
          h("div", { style: { color: bandColor(band), "font-weight": "700" },
                     text: band })));
    }

    function paintLive(s) {
      clear(liveBody);
      if (!s || (s.rsrp === null && s.rsrq === null && s.sinr === null)) {
        liveBody.appendChild(h("p", { class: "muted" },
          s?.stale ? "Bus busy — telemetry skipped this cycle."
                   : "No reading yet. Is the modem present and the radio on?"));
        return;
      }
      liveBody.appendChild(gaugeFor("rsrp", s.rsrp, "dBm"));
      liveBody.appendChild(gaugeFor("sinr", s.sinr, "dB"));
      liveBody.appendChild(row("RSRQ", db(s.rsrq)));
      liveBody.appendChild(row("RSSI", dbm(s.rssi)));
      liveBody.appendChild(row("Updated", s.ts ? ago(s.ts) : "—"));
      staleNote.textContent = s.stale ? "reading is stale (bus busy)" : "";

      paintBranches(s.branches);
    }

    function paintBranches(b) {
      clear(branchBody);
      const rsrp = b?.rsrp;
      if (!rsrp || !rsrp.branches?.length) {
        branchBody.appendChild(h("p", { class: "muted" },
          "Per-branch readings are taken every few cycles; none yet."));
        return;
      }
      if (rsrp.no_rf) {
        branchBody.appendChild(h("p", { class: "section-hint",
          style: { color: palette().err, "font-weight": "600" } },
          "No RF reaching the modem on any branch. That is an antenna or "
          + "cabling fault, not coverage."));
      }
      const p = palette();
      branchBody.appendChild(h("div", { class: "bars" },
        ...rsrp.branches.map((v, i) => barRow(
          `ANT ${i}`, v, pct("rsrp", v),
          v === null ? p.faint : bandColor(signalBand("rsrp", v))))));
      if (b?.sinr?.value !== null && b?.sinr?.value !== undefined) {
        branchBody.appendChild(row("SINR (branch 0)", db(b.sinr.value)));
      }
    }

    function paintCell(s) {
      clear(cellBody);
      cellBody.appendChild(row("RAT", s?.rat
        ? badge(s.rat, s.rat.includes("NR5G") ? "green" : "amber") : null));
      cellBody.appendChild(row("Band", s?.band, { mono: true }));
      cellBody.appendChild(row("ARFCN", s?.arfcn, { mono: true }));
      cellBody.appendChild(row("PCI", s?.pci, { mono: true }));
      cellBody.appendChild(row("Cell ID", s?.cellid, { mono: true }));
    }

    // ---- history ----------------------------------------------------------
    let lastRows = [];

    async function loadHistory() {
      clear(chartBody);
      chartBody.appendChild(h("div", { class: "skeleton-wrap" },
        h("div", { class: "skeleton-row", style: { height: "150px" } })));
      try {
        const res = await view.api.signal.history({ window: state.window },
                                                  { signal: view.signal });
        lastRows = res.samples || [];
        paintHistory(lastRows);
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(chartBody);
        chartBody.appendChild(h("p", { class: "muted" },
          err.status === 503
            ? "History is unavailable — the daemon could not open its database."
            : err.message));
      }
    }

    function paintHistory(rows) {
      clear(chartBody);
      if (!rows.length) {
        chartBody.appendChild(h("p", { class: "muted" },
          "No samples in this window yet. History accumulates while the "
          + "daemon runs."));
        return;
      }
      const p = palette();
      const toSeries = (key) => rows
        .filter((r) => r[key] !== null && r[key] !== undefined)
        .map((r) => ({ t: r.ts * 1000, v: Number(r[key]) }));

      const rsrp = toSeries("rsrp");
      const sinr = toSeries("sinr");

      chartBody.appendChild(h("div", { class: "kpi-label", text: "RSRP (dBm)" }));
      // A fixed, realistic scale: auto-scaling a 1 dB wobble to full height
      // drew a steady signal as a seismograph.
      const span = (pts, lo, hi) => ({
        min: Math.min(lo, ...pts.map((x) => x.v - 2)), max: Math.max(hi, ...pts.map((x) => x.v + 2)) });
      chartBody.appendChild(charts.timeSeries(rsrp, {
        h: 130, colors: [p.series[0]], gapMs: 30000, ...span(rsrp, -120, -80),
      }));
      chartBody.appendChild(h("div", { class: "kpi-label",
                                       style: { "margin-top": "14px" },
                                       text: "SINR (dB)" }));
      chartBody.appendChild(charts.timeSeries(sinr, {
        h: 110, colors: [p.series[1]], gapMs: 30000, ...span(sinr, -5, 30),
      }));
      chartBody.appendChild(charts.legend([
        { color: p.series[0], label: "RSRP" },
        { color: p.series[1], label: "SINR" },
      ]));
      chartBody.appendChild(h("p", { class: "hint" },
        `${rows.length} points over ${state.window}`
        + (rows[0]?.n ? `, averaged from ${rows.reduce((a, r) => a + (r.n || 1), 0)} samples` : "")));
    }

    function exportCsv() {
      if (!lastRows.length) { toast("nothing to export yet"); return; }
      const cols = ["ts", "rsrp", "rsrq", "sinr", "rssi"];
      const lines = [cols.join(",")].concat(lastRows.map(
        (r) => cols.map((c) => (r[c] === null || r[c] === undefined ? "" : r[c])).join(",")));
      // The artifact sandbox blocks downloads, and so may a kiosk browser, so
      // put it on the clipboard rather than offering a link that does nothing.
      navigator.clipboard.writeText(lines.join("\n")).then(
        () => toast(`${lastRows.length} rows copied as CSV`, "ok"),
        () => toast("clipboard unavailable", "err"));
    }

    // ---- wiring -----------------------------------------------------------
    view.listen("signal", (sample) => {
      paintLive(sample);
      paintCell(sample);
    });

    try {
      const now = await view.api.signal.now({ signal: view.signal });
      paintLive(now);
      paintCell(now);
    } catch (err) {
      if (!(err instanceof ApiError && err.isAborted)) {
        liveBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
    }

    await loadHistory();
    // History is server-side downsampled, so refreshing it is cheap and keeps
    // the window honest as time passes.
    view.interval(loadHistory, 30000);
  },
});
