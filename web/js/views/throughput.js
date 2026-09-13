/**
 * Throughput — iperf3 against the core, plus background traffic.
 *
 * Replaces the Speed Test view, which ran a fixed TCP test with no options and
 * kept results in memory only. This exposes what iperf5g.sh actually does:
 * both protocols, both directions, duration, parallel streams, the continuous
 * cycle, and the CSV history on disk.
 *
 * The bind address is shown prominently because it is the thing that decides
 * whether a number means anything. Until Phase 4, `ip route get 10.45.0.1`
 * went out the wired interface here — an unbound test would have reported
 * roughly 900 Mbit/s of LAN as a 5G result.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { confirm, toast } from "../core/dialog.js";
import { clear, h } from "../core/dom.js";
import { ago, clockTime, mbps, ms, nn } from "../core/format.js";
import * as charts from "../ui/charts.js";
import { palette } from "../ui/tokens.js";
import { badge, btnRow, button, card, field, row, select, table } from "../ui/widgets.js";

export default defineView({
  name: "throughput",

  async mount(view) {
    const heroBody = h("div");
    const formBody = h("div");
    const dummyBody = h("div");
    const historyBody = h("div");
    const logPane = h("div", { class: "log logpane", style: { "max-height": "220px" } });

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col7" },
        h("div", { class: "card-head" },
          h("h3", { text: "Test" }),
          h("span", { class: "hint", id: "bind-hint" })),
        formBody, heroBody, logPane),
      h("section", { class: "card col5" },
        h("div", { class: "card-head" },
          h("h3", { text: "Background traffic" }),
          h("span", { class: "hint", text: "stop before measuring" })),
        dummyBody),
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "History" }),
          h("span", { class: "hint", text: "on disk, in iperf5g.sh's format" })),
        historyBody)));

    let running = null;
    let defaults = {};

    function echo(line, cls = "") {
      logPane.appendChild(h("div", { class: `logline ${cls}`, text: line }));
      logPane.scrollTop = logPane.scrollHeight;
    }

    // ---- form --------------------------------------------------------------
    const inputs = {};

    function buildForm() {
      clear(formBody);
      inputs.server = h("input", { type: "text", class: "mini-input",
                                   value: defaults.server || "10.45.0.1" });
      inputs.duration = h("input", { type: "number", class: "mini-input",
                                     value: String(defaults.duration || 10),
                                     min: "1", max: "600" });
      inputs.parallel = h("input", { type: "number", class: "mini-input",
                                     value: "1", min: "1", max: "32" });
      inputs.proto = select(["tcp", "udp"], "tcp", () => {}, { class: "mini-select" });
      inputs.dir = select([{ value: "up", label: "up (UE → core)" },
                           { value: "down", label: "down (core → UE)" }],
                          "up", () => {}, { class: "mini-select" });
      inputs.udpRate = h("input", { type: "text", class: "mini-input",
                                    value: "25M", placeholder: "25M" });

      formBody.appendChild(h("div", { class: "kpis" },
        field("Server", inputs.server),
        field("Protocol", inputs.proto),
        field("Direction", inputs.dir),
        field("Duration (s)", inputs.duration)));
      formBody.appendChild(h("div", { class: "kpis" },
        field("Parallel streams", inputs.parallel),
        field("UDP rate", inputs.udpRate, "ignored for TCP")));
      formBody.appendChild(btnRow(
        button("Run once", { kind: "primary", onclick: runOnce }),
        button("Run all four legs", { onclick: runAll }),
        button("Continuous loop", { onclick: runLoop }),
        button("Stop", { onclick: stop })));
    }

    function spec() {
      return {
        server: inputs.server.value.trim(),
        duration: Number(inputs.duration.value),
        parallel: Number(inputs.parallel.value),
        proto: inputs.proto.value,
        dir: inputs.dir.value,
        udp_rate: inputs.udpRate.value.trim() || undefined,
      };
    }

    async function runOnce() { await start(() => view.api.iperf.run(spec(), { signal: view.signal }), "run"); }

    async function runAll() {
      await start(() => view.api.iperf.run(
        { ...spec(), legs: ["tcp-up", "tcp-down", "udp-up", "udp-down"] },
        { signal: view.signal }), "all four legs");
    }

    async function runLoop() {
      const ok = await confirm({
        title: "Start the continuous loop?",
        body: "Cycles all four legs until you stop it, writing a CSV row per "
            + "leg — the same thing iperf5g.sh does. It saturates the bearer, "
            + "so anything else using the link will be affected.",
        confirmLabel: "Start",
      });
      if (!ok) return;
      await start(() => view.api.iperf.loop(
        { ...spec(), legs: ["tcp-up", "tcp-down", "udp-up", "udp-down"] },
        { signal: view.signal }), "continuous loop");
    }

    async function start(starter, label) {
      if (running) { toast("a test is already running", "err"); return; }
      clear(logPane);
      echo(`> ${label}`, "lvl-info");
      try {
        const res = await starter();
        running = res.job_id;
        await follow(res.job_id);
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        if (err.status === 409) toast("a performance job is already running", "err");
        else { echo(`  ${err.message}`, "lvl-error"); toast(err.message, "err"); }
      } finally {
        running = null;
        loadHistory();
      }
    }

    async function stop() {
      if (!running) { toast("nothing running"); return; }
      try {
        await view.api.jobs.cancel(running, { signal: view.signal });
        toast("stopping after the current leg");
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
    }

    async function follow(jobId) {
      let seen = 0;
      for (let i = 0; i < 3000; i += 1) {
        await new Promise((r) => view.timeout(r, 700));
        let job;
        try {
          job = await view.api.jobs.get(jobId, { signal: view.signal });
        } catch (err) {
          if (err instanceof ApiError && err.isAborted) return;
          continue;
        }
        for (const line of (job.lines || []).slice(seen)) {
          echo(`  ${line}`, /FAILED|failed|no response/.test(line) ? "lvl-error" : "");
        }
        seen = (job.lines || []).length;
        if (!["queued", "running"].includes(job.state)) {
          echo(`  ${job.state}`, job.state === "succeeded" ? "lvl-debug" : "lvl-error");
          if (job.result?.legs) paintHero(job.result.legs);
          return;
        }
      }
    }

    // ---- results -----------------------------------------------------------
    function paintHero(legs) {
      clear(heroBody);
      if (!legs?.length) return;
      const p = palette();
      const good = legs.filter((l) => l.status === "ok");
      if (good.length) {
        const best = good.reduce((a, b) => (b.mbps > a.mbps ? b : a));
        heroBody.appendChild(h("div", { class: "stat-hero" },
          h("span", { class: "num", text: mbps(best.mbps) }),
          h("span", { class: "unit", text: "Mbit/s" })));
        heroBody.appendChild(h("div", { class: "stat-sub",
          text: `best of ${good.length} leg(s) — ${best.leg}` }));
      }
      heroBody.appendChild(table(
        ["Leg", "Mbit/s", "Retr", "RTT", "Jitter", "Loss", "RSRP", "SINR", ""],
        legs.map((l) => [
          l.leg, l.status === "ok" ? mbps(l.mbps) : "—",
          nn(l.retransmits), l.rtt_ms ? ms(l.rtt_ms) : "—",
          l.jitter_ms ? `${l.jitter_ms} ms` : "—",
          l.loss_pct !== null && l.loss_pct !== undefined ? `${l.loss_pct}%` : "—",
          nn(l.rsrp_dbm), nn(l.sinr_db),
          badge(l.status, l.status === "ok" ? "green" : "red"),
        ])));
      const withIntervals = good.find((l) => l.intervals?.length);
      if (withIntervals) {
        heroBody.appendChild(charts.timeSeries(
          withIntervals.intervals.map((d) => ({ t: d.t * 1000, v: d.mbps })),
          { h: 120, colors: [p.series[0]], gapMs: 5000 }));
      }
    }

    // ---- background traffic --------------------------------------------------
    function paintDummy(state) {
      clear(dummyBody);
      const on = Boolean(state?.running);
      dummyBody.appendChild(row("Status", badge(on ? `${state.kind} running` : "stopped",
                                                on ? "amber" : "gray")));
      if (on) {
        dummyBody.appendChild(row("Bound to", state.bind, { mono: true }));
        dummyBody.appendChild(row("Since", state.since ? ago(state.since) : null));
        dummyBody.appendChild(h("p", { class: "section-hint",
          style: { color: "var(--amber)", "font-weight": "600" } },
          "Traffic is being generated. Any measurement taken now includes it."));
        dummyBody.appendChild(btnRow(button("Stop", {
          kind: "danger",
          onclick: async () => {
            try {
              await view.api.perf.stopDummy({ signal: view.signal });
              toast("stopping", "ok");
              view.timeout(refreshDummy, 800);
            } catch (err) { toast(err.message, "err"); }
          },
        })));
        return;
      }

      const kind = select([{ value: "load", label: "Link load (iperf3)" },
                           { value: "flow", label: "Camera-like UDP flow" }],
                          "load", () => paintDummyForm(kind.value),
                          { class: "mini-select" });
      dummyBody.appendChild(field("Kind", kind));
      const formHost = h("div");
      dummyBody.appendChild(formHost);
      paintDummyForm("load");

      function paintDummyForm(which) {
        clear(formHost);
        if (which === "load") {
          const dir = select(["up", "down"], "up", () => {}, { class: "mini-select" });
          const par = h("input", { type: "number", class: "mini-input",
                                   value: "1", min: "1", max: "32" });
          formHost.appendChild(h("div", { class: "kpis" },
            field("Direction", dir), field("Streams", par)));
          formHost.appendChild(h("p", { class: "hint" },
            "Fills the bearer with TCP. Use it to see what happens to "
            + "something else while the link is busy."));
          formHost.appendChild(btnRow(button("Start load", {
            onclick: () => startDummy({ kind: "load", dir: dir.value,
                                        parallel: Number(par.value) }),
          })));
        } else {
          const port = h("input", { type: "number", class: "mini-input",
                                    value: "50451" });
          const rate = h("input", { type: "number", class: "mini-input",
                                    value: "15", step: "0.5" });
          const len = h("input", { type: "number", class: "mini-input",
                                   value: "1200" });
          formHost.appendChild(h("div", { class: "kpis" },
            field("Port", port), field("Rate (Mbit/s)", rate),
            field("Datagram bytes", len)));
          formHost.appendChild(h("p", { class: "hint" },
            "A steady UDP stream shaped like the camera — same port, same "
            + "rate, same datagram size. Exercises policy routing, marking and "
            + "NAT without needing the camera or an X display."));
          formHost.appendChild(btnRow(button("Start flow", {
            onclick: () => startDummy({ kind: "flow", port: Number(port.value),
                                        rate_mbps: Number(rate.value),
                                        length: Number(len.value) }),
          })));
        }
      }
    }

    async function startDummy(body) {
      try {
        await view.api.perf.startDummy(body, { signal: view.signal });
        toast(`${body.kind} started`, "ok");
        view.timeout(refreshDummy, 800);
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        toast(err.message, "err");
      }
    }

    async function refreshDummy() {
      try {
        paintDummy(await view.api.perf.dummy({ signal: view.signal }));
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(dummyBody);
          dummyBody.appendChild(h("p", { class: "muted", text: err.message }));
        }
      }
    }

    // ---- history -------------------------------------------------------------
    async function loadHistory() {
      try {
        const res = await view.api.iperf.runs({ limit: 30 }, { signal: view.signal });
        const runs = res.runs || [];
        clear(historyBody);
        if (!runs.length) {
          historyBody.appendChild(h("p", { class: "muted" },
            "No runs recorded yet."));
          return;
        }
        historyBody.appendChild(table(["Run", "When", "State", "Source", ""],
          runs.map((r) => [
            h("span", { class: "mono", text: r.id }),
            r.started ? clockTime(r.started) : "—",
            r.state || "—",
            badge(r.source === "disk" ? "archived" : "recorded",
                  r.source === "disk" ? "gray" : "blue"),
            button("Open", { onclick: () => openRun(r.id) }),
          ])));
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(historyBody);
        historyBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
    }

    async function openRun(id) {
      try {
        const res = await view.api.iperf.run_(id, { signal: view.signal });
        const legs = res.legs || [];
        clear(historyBody);
        historyBody.appendChild(btnRow(
          button("← back", { onclick: loadHistory }),
          button("Copy CSV", {
            onclick: async () => {
              try {
                const csv = await view.api.iperf.csv(id, { signal: view.signal });
                await navigator.clipboard.writeText(
                  typeof csv === "string" ? csv : JSON.stringify(csv));
                toast("CSV copied", "ok");
              } catch (err) { toast(err.message, "err"); }
            },
          })));
        historyBody.appendChild(h("div", { class: "kpi-label", text: id }));
        historyBody.appendChild(table(
          ["seq", "leg", "Mbit/s", "Retr", "RTT", "Jitter", "Loss", "RSRP", "SINR", "Status"],
          legs.map((l) => [
            l.seq, l.leg, l.mbps || "—", nn(l.retransmits),
            l.rtt_ms || "—", l.jitter_ms || "—", l.loss_pct ?? "—",
            nn(l.rsrp_dbm ?? l.rsrp), nn(l.sinr_db ?? l.sinr),
            badge(l.status || "?", l.status === "ok" ? "green" : "red"),
          ])));
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
    }

    // ---- boot -----------------------------------------------------------------
    try {
      defaults = await view.api.iperf.defaults({ signal: view.signal });
      const hint = document.getElementById("bind-hint");
      if (hint) {
        hint.textContent = defaults.bind_address
          ? `bound to ${defaults.bind_address} on ${defaults.bind_iface}`
          : `${defaults.bind_iface} has no address — bring the bearer up first`;
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
    }

    buildForm();
    await refreshDummy();
    await loadHistory();

    // Live per-leg results while a loop is running.
    view.listen("iperf", (evt) => {
      if (evt.dummy) paintDummy(evt.dummy);
    });
  },
});
