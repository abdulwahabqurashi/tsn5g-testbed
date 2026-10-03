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
import { badge, btnRow, button, card, field, kpi, row, select, table } from "../ui/widgets.js";

export default defineView({
  name: "throughput",

  async mount(view) {
    const heroBody = h("div");
    const formBody = h("div");
    const pathBody = h("div", { class: "path-verdict" });
    const liveBody = h("div");
    const dummyBody = h("div");
    const historyBody = h("div");
    const dummyLive = h("div");
    const logPane = h("div", { class: "log logpane", style: { "max-height": "200px" } });
    // The command output is kept, but it is evidence rather than the display:
    // leading with a terminal pane made reading a result an act of parsing.
    const logWrap = h("details", { class: "raw-output" },
      h("summary", { class: "hint", text: "Command output" }), logPane);

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col7" },
        h("div", { class: "card-head" },
          h("h3", { text: "Test" }),
          h("span", { class: "hint", id: "bind-hint" })),
        formBody, pathBody, liveBody, heroBody, logWrap),
      h("section", { class: "card col5" },
        h("div", { class: "card-head" },
          h("h3", { text: "Background traffic" }),
          h("span", { class: "hint", text: "stop before measuring" })),
        dummyBody, dummyLive),
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
      // Client as well as server. The client address decides which interface
      // the test actually leaves by, and binding it to the bearer while
      // aiming at a wired host does not fail — it hangs until the timeout.
      const clients = defaults.client_addresses || [];
      inputs.client = h("input", {
        type: "text", class: "mini-input", list: "client-addrs",
        value: defaults.bind_address || "",
        placeholder: defaults.bind_iface || "auto",
        oninput: () => checkPath(),
      });
      const datalist = h("datalist", { id: "client-addrs" });
      for (const c of clients) {
        datalist.appendChild(h("option", { value: c.address,
                                           label: `${c.address} (${c.iface})` }));
      }
      formBody.appendChild(datalist);
      inputs.server = h("input", { type: "text", class: "mini-input",
                                   value: defaults.server || "10.45.0.1",
                                   oninput: () => checkPath() });
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
        field("Client (this UE)", inputs.client, "which address to send from"),
        field("Server (far side)", inputs.server, "where iperf3 -s is running")));
      formBody.appendChild(h("div", { class: "kpis" },
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
        bind: inputs.client.value.trim() || undefined,
        duration: Number(inputs.duration.value),
        parallel: Number(inputs.parallel.value),
        proto: inputs.proto.value,
        dir: inputs.dir.value,
        udp_rate: inputs.udpRate.value.trim() || undefined,
      };
    }

    // ---- path verdict ------------------------------------------------------
    // Answers "will this even work" before the run rather than after the
    // timeout, and names the interface the traffic will actually use.
    // A generation counter rather than clearTimeout: the view context hands
    // out timeouts but not a way to cancel one, and discarding a stale answer
    // is what actually matters while the operator is still typing.
    let pathGen = 0;
    function checkPath() {
      const mine = ++pathGen;
      view.timeout(() => { if (mine === pathGen) runPathCheck(mine); }, 400);
    }

    async function runPathCheck(gen) {
      const server = inputs.server.value.trim();
      if (!server) { clear(pathBody); return; }
      try {
        const r = await view.api.iperf.path(
          { server, bind: inputs.client.value.trim() || undefined },
          { signal: view.signal });
        if (gen !== undefined && gen !== pathGen) return;
        clear(pathBody);
        if (r.ok === true) {
          const viaBearer = r.dev === defaults.bind_iface;
          pathBody.appendChild(h("p", { class: "hint" },
            h("span", { class: "dot ok" }),
            ` ${r.bind} → ${r.server} via ${r.dev}`,
            viaBearer ? " — over 5G" : " — not over the modem"));
        } else if (r.ok === false) {
          pathBody.appendChild(h("p", { class: "section-hint",
            style: { color: "var(--red)", "font-weight": "600" } },
            r.reason || "this client and server cannot reach each other"));
        }
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) clear(pathBody);
      }
    }

    // ---- live metrics --------------------------------------------------------
    // Driven by the bearer's own byte counters, which are already polled and
    // are the honest measure of what the link is carrying — including anything
    // else using it at the same time.
    let liveOn = false;
    let liveLeg = "";
    let liveUntil = 0;
    const liveSeries = [];

    function startLive(label, seconds) {
      liveOn = true;
      liveLeg = label;
      liveUntil = Date.now() + (seconds || 0) * 1000;
      liveSeries.length = 0;
      paintLive();
    }

    function stopLive() {
      liveOn = false;
      clear(liveBody);
    }

    function ifaceRate() {
      const st = view.store.get().stats;
      const dev = st?.interfaces?.[defaults.bind_iface];
      if (!dev) return null;
      const up = (dev.tx_bytes_per_s || 0) * 8 / 1e6;
      const down = (dev.rx_bytes_per_s || 0) * 8 / 1e6;
      return { up, down };
    }

    function paintLive() {
      if (!liveOn) return;
      const p = palette();
      const r = ifaceRate();
      clear(liveBody);

      const down = inputs.dir.value === "down";
      const now = r ? (down ? r.down : r.up) : 0;

      liveBody.appendChild(h("div", { class: "live-head" },
        h("span", { class: "badge amber", text: liveLeg || "running" }),
        h("span", { class: "hint",
                    text: `${defaults.bind_iface} — ${down ? "receiving" : "sending"}` })));

      liveBody.appendChild(h("div", { class: "stat-hero" },
        h("span", { class: "num", text: now.toFixed(1) }),
        h("span", { class: "unit", text: "Mbit/s now" })));

      if (liveUntil > Date.now()) {
        const total = Math.max(1, (liveUntil - (liveUntil - Date.now())) || 1);
        const left = Math.max(0, liveUntil - Date.now());
        const pct = Math.max(0, Math.min(100, 100 - (left / total) * 100));
        liveBody.appendChild(charts.meter(pct, { color: p.series[0] }));
        liveBody.appendChild(h("div", { class: "stat-sub",
          text: `${Math.ceil(left / 1000)}s remaining` }));
      }

      if (liveSeries.length > 1) {
        liveBody.appendChild(charts.timeSeries([liveSeries], {
          h: 120, colors: [p.series[0]], gapMs: 4000,
        }));
        const peak = liveSeries.reduce((a, b) => (b.v > a ? b.v : a), 0);
        const mean = liveSeries.reduce((a, b) => a + b.v, 0) / liveSeries.length;
        liveBody.appendChild(h("div", { class: "kpis" },
          kpi("Peak", `${peak.toFixed(1)} Mbit/s`),
          kpi("Mean", `${mean.toFixed(1)} Mbit/s`),
          kpi("Samples", String(liveSeries.length))));
      }
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
      clear(heroBody);
      echo(`> ${label}`, "lvl-info");
      startLive(label, Number(inputs.duration.value) || 0);
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
        stopLive();
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
        const step = job.progress?.step;
        if (liveOn && step && step !== liveLeg) {
          liveLeg = step;
          liveUntil = Date.now() + (Number(inputs.duration.value) || 0) * 1000;
          liveSeries.length = 0;
        }
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
          const srv = h("input", { type: "text", class: "mini-input",
                                   value: defaults.server || "",
                                   placeholder: defaults.server || "core" });
          const cli = h("input", { type: "text", class: "mini-input",
                                   list: "client-addrs",
                                   value: defaults.bind_address || "",
                                   placeholder: defaults.bind_iface || "auto" });
          formHost.appendChild(h("div", { class: "kpis" },
            field("Client", cli), field("Server", srv)));
          formHost.appendChild(h("div", { class: "kpis" },
            field("Direction", dir), field("Streams", par)));
          formHost.appendChild(h("p", { class: "hint" },
            "Fills the bearer with TCP. Use it to see what happens to "
            + "something else while the link is busy."));
          formHost.appendChild(btnRow(button("Start load", {
            onclick: () => startDummy({ kind: "load", dir: dir.value,
                                        parallel: Number(par.value),
                                        server: srv.value.trim() || undefined,
                                        bind: cli.value.trim() || undefined }),
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

    // The generator reports every 2 seconds now that it is not block-buffered
    // into the pipe; before that a running load showed nothing for minutes and
    // read as broken.
    const dummySeries = [];
    function paintDummySample(evt) {
      dummySeries.push({ t: (evt.t || Date.now() / 1000) * 1000, v: evt.mbps });
      if (dummySeries.length > 180) dummySeries.shift();
      const p = palette();
      clear(dummyLive);
      dummyLive.appendChild(h("div", { class: "stat-hero" },
        h("span", { class: "num", text: Number(evt.mbps).toFixed(1) }),
        h("span", { class: "unit", text: "Mbit/s generated" })));
      if (evt.retransmits !== null && evt.retransmits !== undefined) {
        dummyLive.appendChild(h("div", { class: "stat-sub",
          text: `${evt.retransmits} retransmit(s) this interval` }));
      }
      if (dummySeries.length > 1) {
        dummyLive.appendChild(charts.timeSeries([dummySeries], {
          h: 100, colors: [p.series[1]], gapMs: 8000,
        }));
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
        const st = await view.api.perf.dummy({ signal: view.signal });
        if (!st?.running) { dummySeries.length = 0; clear(dummyLive); }
        paintDummy(st);
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

    // Live per-leg results while a loop is running, and the generator's own
    // interval reports once it starts flushing them.
    view.listen("iperf", (evt) => {
      if (evt.dummy) paintDummy(evt.dummy);
      if (evt.sample) paintDummySample(evt);
    });

    // The bearer's counters drive the live chart. Subscribing beats polling:
    // this is the same data the Dashboard draws, arriving on the same tick.
    view.sub((st) => st.stats, () => {
      if (!liveOn) return;
      const r = ifaceRate();
      if (r) {
        const down = inputs.dir.value === "down";
        liveSeries.push({ t: Date.now(), v: down ? r.down : r.up });
        if (liveSeries.length > 300) liveSeries.shift();
      }
      paintLive();
    });
  },
});
