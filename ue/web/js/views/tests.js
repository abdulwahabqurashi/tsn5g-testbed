/**
 * Tests: start a measurement with one click, watch it, read the result.
 *
 * Each tile is one of the CLI tools (tools/demo-run.sh, radio-loss-test.sh,
 * qbv-live.sh, gnb-drift.sh). The daemon runs it as a job (testrun.py): it
 * pauses or starts the cameras as the test needs, streams the tool's output
 * here, and puts the cameras back afterwards. The tools still run from a
 * shell exactly as before, and a shell run shows up under Results too.
 *
 * Only one test runs at a time (they share the uplink); Stop sends Ctrl-C to
 * the tool, which restores the queue policy and removes what it built.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { confirm, toast } from "../core/dialog.js";
import { clear, fill, h } from "../core/dom.js";
import { clockTime, duration } from "../core/format.js";
import * as charts from "../ui/charts.js";
import { icon } from "../ui/icons.js";
import { barCell, chip, chips, heatmap, heatScale } from "../ui/observe.js";
import { palette } from "../ui/tokens.js";
import { badge, button } from "../ui/widgets.js";

const KIND_BADGE = { drift: ["clock drift", "blue"], qbv: ["uplink priority", "green"],
                     demo: ["camera demo", "amber"], loss: ["uplink loss", "gray"],
                     camloss: ["camera loss", "gray"] };
const TEST_ICON = { demo: "camera", camloss: "check", loss: "signal", qbv: "sliders", drift: "clock" };
const CAMERA_NOTE = { running: "Uses the cameras", stopped: "Pauses the cameras" };

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
    const tilesBody = h("div", { class: "test-tiles" });
    const runCard = h("section", { class: "card col12 run-card", hidden: true });
    const listBody = h("div", { class: "run-list" });
    const detailHead = h("div", { class: "card-head" });
    const detailBody = h("div");
    let catalog = [];
    const choice = {};          // test id -> {KEY: value}
    const openOpts = new Set(); // tiles whose options are unfolded
    let job = null;             // the test job being shown (running or just finished)
    let runs = [];
    let current = null;         // {kind, id}
    let refresh = null;
    const want = view.query.run?.split("/");
    if (want?.length === 2) current = { kind: want[0], id: want[1] };

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col12" },
        h("div", { class: "card-head" }, h("h3", { text: "Run a test" }),
          h("span", { class: "hint", text: "one at a time; the cameras are handled for you" })),
        tilesBody),
      runCard,
      h("section", { class: "card col4" },
        h("div", { class: "card-head" }, h("h3", { text: "Results" }),
          h("span", { class: "hint", text: "newest first" })),
        listBody),
      h("section", { class: "card col8" }, detailHead, detailBody)));

    // ---- tiles ------------------------------------------------------------------
    const running = () => job && ["queued", "running"].includes(job.state);

    function paintTiles() {
      clear(tilesBody);
      for (const t of catalog) {
        const mine = running() && job.params?.test === t.id;
        const opts = (choice[t.id] ||= Object.fromEntries(t.params.map((p) => [p.key, p.default])));
        tilesBody.appendChild(h("div", { class: `test-tile${mine ? " active" : ""}` },
          h("div", { class: "tt-top" },
            h("span", { class: "tt-ic" }, icon(TEST_ICON[t.id] || "pulse")),
            h("div", null, h("div", { class: "tt-title", text: t.title }),
              h("div", { class: "tt-meta", text: `~${Math.round(t.minutes)} min · ${CAMERA_NOTE[t.cameras] || ""}` }))),
          h("p", { class: "tt-sum", text: t.summary }),
          t.params.length ? h("details", { class: "tt-more", open: openOpts.has(t.id),
            ontoggle: (e) => { if (e.target.open) openOpts.add(t.id); else openOpts.delete(t.id); } },
            h("summary", { text: "Options" }),
            ...t.params.map((p) => h("label", { class: "tt-opt" },
              h("span", { text: p.label }),
              h("select", { class: "mini-select", disabled: running(),
                onchange: (e) => { opts[p.key] = e.target.value; } },
                ...p.options.map(([v, label]) => h("option", { value: v, text: label, selected: v === opts[p.key] })))))) : null,
          h("div", { class: "tt-foot" },
            mine ? button("Stop", { kind: "danger", onclick: stop })
              : button("Run", { kind: "primary", disabled: running(), onclick: () => start(t) }),
            t.capture ? h("span", { class: "hint", text: "captures on the core" }) : null)));
      }
    }

    async function start(t) {
      const body = choice[t.id] || {};
      if (t.cameras === "stopped") {
        const ok = await confirm({ title: `Run ${t.title}?`, confirmLabel: "Run",
          body: `About ${Math.round(t.minutes)} minutes. The camera streams pause during the test and restart by themselves afterwards.` });
        if (!ok) return;
      }
      try {
        const res = await view.api.tests.run(t.id, body, { signal: view.signal });
        job = { id: res.job_id, state: "queued", params: { test: t.id }, lines: [], steps: [] };
        paintTiles(); paintRun(); follow();
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
    }

    async function stop() {
      if (!job) return;
      try {
        await view.api.jobs.cancel(job.id, { signal: view.signal });
        toast("stopping: the test cleans up first", "ok");
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
    }

    // ---- the run in progress --------------------------------------------------------
    let following = false;
    async function follow() {
      if (following) return;
      following = true;
      try {
        while (job && running()) {
          await new Promise((r) => view.timeout(r, 1500));
          job = await view.api.jobs.get(job.id, { signal: view.signal });
          paintRun();
        }
        paintTiles();
        if (job?.state === "succeeded" && job.result?.run_id) {
          current = { kind: job.result.kind, id: job.result.run_id };
          toast("test finished", "ok");
        } else if (job?.state === "failed") {
          toast(job.error || "the test failed", "err");
        }
        await loadList(); await loadRun();
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      } finally {
        following = false;
      }
    }

    function paintRun() {
      if (!job) { runCard.hidden = true; return; }
      runCard.hidden = false;
      const t = catalog.find((c) => c.id === job.params?.test) || { title: "Test" };
      const live = running();
      const st = { queued: ["starting", "blue"], running: ["running", "blue"], succeeded: ["finished", "green"],
                   failed: ["failed", "red"], cancelled: ["stopped", "gray"] }[job.state] || [job.state, "gray"];
      const elapsed = job.started ? ((job.finished || Date.now() / 1000) - job.started) : 0;
      const pct = live ? (job.progress?.pct || 0) : 100;
      const lines = job.lines || [];
      const pre = h("pre", { class: "log run-log", text: lines.slice(-200).join("\n") || "…" });
      fill(runCard,
        h("div", { class: "card-head" },
          h("div", { class: "head-l" }, h("h3", { text: t.title }), badge(st[0], st[1]),
            h("span", { class: "hint", text: elapsed ? duration(Math.round(elapsed)) : "" })),
          h("div", { class: "head-r" },
            live ? button("Stop", { kind: "danger", onclick: stop })
              : button("Close", { onclick: () => { job = null; paintRun(); } }))),
        h("div", { class: "steps-inline" }, ...(job.steps || []).map((s) => h("span", {
          class: `si ${s.state}`, text: { check: "Check", cameras: "Cameras", run: "Measure", restore: "Restore" }[s.name] || s.name }))),
        h("div", { class: `run-bar${job.state === "failed" ? " err" : live ? "" : " done"}` },
          h("i", { style: { width: `${pct}%` } })),
        h("div", { class: "run-msg", text: job.error || job.progress?.message || "" }),
        h("details", { class: "raw-output", open: job.state === "failed" },
          h("summary", { class: "hint", text: `Output (${lines.length} lines)` }), pre));
      pre.scrollTop = pre.scrollHeight;
    }

    // ---- results list ------------------------------------------------------------------
    function paintList() {
      clear(listBody);
      if (!runs.length) {
        listBody.appendChild(h("p", { class: "muted", text: "No results yet. Run a test above." }));
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
          "Results appear here when the run finishes. Green = policy on, amber = policy off. "
          + "The Overview shows the live delay meanwhile." }));
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

    // ---- uplink loss -------------------------------------------------------------
    function paintLoss(d) {
      const p = palette();
      const v = d.variants || [];
      fill(detailHead, h("h3", { text: "Uplink loss" }),
        d.running ? badge(`running · ${v.length} of 4`, "blue")
          : h("span", { class: "hint", text: "one camera's rate, four ways" }));
      clear(detailBody);
      if (!v.length) {
        detailBody.appendChild(h("p", { class: "muted", text: "No results yet." }));
        return;
      }
      const maxLoss = Math.max(1, ...v.map((x) => x.loss_pct || 0));
      detailBody.appendChild(h("table", { class: "tbl" },
        h("thead", null, h("tr", null, ...["Variant", "Loss", "Jitter", "Sent"].map((t) => h("th", { text: t })))),
        h("tbody", null, ...v.map((x) => h("tr", null,
          h("td", { text: `${x.variant} · ${x.name}` }),
          h("td", null, x.error ? badge(x.error, "red") : barCell(x.loss_pct, maxLoss, x.loss_pct > 1 ? p.err : p.ok, `${x.loss_pct} %`)),
          h("td", { text: x.jitter_ms == null ? "—" : `${x.jitter_ms} ms` }),
          h("td", { text: x.sent == null ? "—" : String(x.sent) }))))));
      detailBody.appendChild(h("p", { class: "hint", style: { "margin-top": "10px" }, text:
        "Read across: A vs B is packet size (fragmentation), B vs C is burstiness, C vs D is the GBR flow." }));
    }

    // ---- camera loss check --------------------------------------------------------
    function paintCamLoss(d) {
      const p = palette();
      const c = d.cameras || [];
      fill(detailHead, h("h3", { text: "Camera loss check" }),
        d.running ? badge("running", "blue") : h("span", { class: "hint", text: "sent at the UE vs reached the core, same window" }));
      clear(detailBody);
      if (!c.length) {
        detailBody.appendChild(h("p", { class: "muted", text: d.running ? "Counting…" : "No result in this run." }));
        return;
      }
      detailBody.appendChild(h("div", { class: "kpis", style: { "grid-template-columns": `repeat(${c.length}, minmax(0,1fr))` } },
        ...c.map((x, i) => kpi(x.camera, `${x.loss_pct} %`, `lost ${x.lost} of ${x.sent} datagrams`,
          Math.abs(x.loss_pct) < 0.5 ? "var(--green-ink)" : x.loss_pct < 2 ? "var(--amber-ink)" : "var(--red-ink)"))));
      detailBody.appendChild(h("table", { class: "tbl", style: { "margin-top": "14px" } },
        h("thead", null, h("tr", null, ...["Camera", "Sent (UE)", "Reached the core", "Delivered"].map((t) => h("th", { text: t })))),
        h("tbody", null, ...c.map((x, i) => h("tr", null,
          h("td", { text: x.camera }), h("td", { text: String(x.sent) }), h("td", { text: String(x.received) }),
          h("td", null, barCell(Math.min(100, (100 * x.received) / Math.max(1, x.sent)), 100, p.series[i],
            `${(100 - x.loss_pct).toFixed(2)} %`)))))));
    }

    async function loadRun() {
      if (!current) return;
      try {
        const d = await view.api.results.get(current.kind, current.id, { signal: view.signal });
        ({ drift: paintDrift, qbv: paintQbv, demo: paintDemo, loss: paintLoss, camloss: paintCamLoss }[d.kind] || (() => {}))(d);
        if (refresh) { clearInterval(refresh); refresh = null; }
        if ((d.kind === "drift" && d.verdict === "running") || d.running) {
          refresh = view.interval(async () => { await loadList(); await loadRun(); }, 15000);
        }
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          fill(detailHead, h("h3", { text: "Result" }));
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

    // A test started earlier, from another browser, or before a reload.
    async function findActive() {
      try {
        const res = await view.api.jobs.list({ kind: "test.run", limit: 1 }, { signal: view.signal });
        const last = (res.jobs || [])[0];
        if (last && (["queued", "running"].includes(last.state) || Date.now() / 1000 - (last.finished || 0) < 600)) {
          job = await view.api.jobs.get(last.id, { signal: view.signal });
        }
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) { /* no job history is not worth a panel */ }
      }
    }

    try {
      catalog = (await view.api.tests.catalog({ signal: view.signal })).tests || [];
    } catch (err) {
      if (!(err instanceof ApiError && err.isAborted)) {
        tilesBody.appendChild(h("p", { class: "muted", text: `Tests unavailable: ${err.message}` }));
      }
    }
    await findActive();
    paintTiles();
    paintRun();
    if (running()) follow();
    await loadList();
    await loadRun();
  },
});
