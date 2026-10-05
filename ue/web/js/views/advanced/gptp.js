/**
 * Time Sync: PTP via ptp4l (NIC clock) and phc2sys (system clock).
 *
 * Laid out to be read at a glance, UniFi-style: the clock path across the top
 * (grandmaster -> NIC -> system clock -> time-aware apps, each link coloured by
 * its offset), four numbers, a health chart over the last hour with a lock
 * strip under it, and the lock/unlock events beside it. Set-up and the raw
 * details are folded away at the bottom.
 *
 * History comes from /api/ptp/history (the daemon samples once a second), so
 * the chart opens full instead of filling from the moment the page loads.
 */

import { ApiError } from "../../core/api.js";
import { defineView } from "../../core/component.js";
import { toast } from "../../core/dialog.js";
import { clear, fill, h } from "../../core/dom.js";
import { clockTime, ns } from "../../core/format.js";
import * as charts from "../../ui/charts.js";
import { icon } from "../../ui/icons.js";
import { axisRow, chip, chips, eventList, healthStrip, seg, topoLink, topoNode } from "../../ui/observe.js";
import { palette } from "../../ui/tokens.js";
import { badge, btnRow, button, field, row, select } from "../../ui/widgets.js";

const POLL_MS = 1000;
const HISTORY_MS = 5000;
const PROFILE_LABEL = { ieee1588: "IEEE 1588", gptp: "802.1AS" };
const RANGES = [{ value: 5, label: "5 min" }, { value: 15, label: "15 min" }, { value: 60, label: "1 h" }];

/** ok under 100 ns, warn under 1 us, err above (or missing). */
function offsetState(v) {
  if (v == null) return "err";
  const a = Math.abs(v);
  return a < 100 ? "ok" : a < 1000 ? "warn" : "err";
}

function pctl(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

export default defineView({
  name: "gptp",

  async mount(view) {
    const problemsBody = h("section", { class: "card col12",
      style: { display: "none", "border-left": "4px solid var(--red)" } });
    const pathBody = h("div", { class: "topo topo-wide" });
    const kpiBody = h("div", { class: "tiles tiles-4" });
    const chartHead = h("div");
    const chartBody = h("div");
    const eventsBody = h("div");
    const detailBody = h("div");
    const settingsBody = h("div");
    const series = { master: [], sys: [] };   // reset by the set-up helpers below
    let last = null;
    let busy = false;
    let range = 15;
    let hist = { samples: [], events: [] };

    view.root.appendChild(h("div", { class: "grid" },
      problemsBody,
      h("section", { class: "card col12 card-path" }, pathBody, kpiBody),
      h("section", { class: "card col8" },
        h("div", { class: "card-head" }, h("h3", { text: "Clock health" }), chartHead), chartBody),
      h("section", { class: "card col4" },
        h("div", { class: "card-head" }, h("h3", { text: "Events" })), eventsBody),
      h("section", { class: "card col12" },
        h("details", { class: "setup" },
          h("summary", null, h("span", { text: "Set-up and details" }),
            h("span", { class: "hint", text: "NIC, profile, VLAN, start / stop" })),
          detailBody, settingsBody))));

    // ---- live: path, numbers, details ----------------------------------------
    function paintPath(g) {
      const gm = g.grandmaster;
      const taiOk = g.tai_offset === g.expected_tai_offset;
      const nicSt = g.running ? (g.locked ? offsetState(g.offset_ns) : "warn") : "err";
      const sysSt = g.sys_running ? (g.sys_locked ? offsetState(g.sys_offset_ns) : "warn") : "err";
      const phys = g.phys_interface || g.interface;
      fill(pathBody,
        topoNode(icon("server"), "Grandmaster", gm ? `…${gm.slice(-9)}` : "not found", gm ? "ok" : "err"),
        topoLink(g.running ? ns(g.offset_ns) : "off",
          `${PROFILE_LABEL[g.profile] || g.profile || "PTP"}${g.vlan ? ` · VLAN ${g.vlan}` : ""}`, nicSt),
        topoNode(icon("eth"), phys || "NIC", "NIC clock", nicSt),
        topoLink(g.sys_running ? ns(g.sys_offset_ns) : "off", "phc2sys", sysSt),
        topoNode(icon("clock"), "System clock", `TAI = UTC + ${g.tai_offset ?? "?"} s`,
          g.sys_locked && taiOk ? "ok" : sysSt === "ok" ? "warn" : sysSt),
        topoLink(g.gate_clock_ok ? "ready" : "not ready", "CLOCK_TAI", g.gate_clock_ok ? "ok" : "err"),
        topoNode(icon("apps"), "Time-aware", "gates · latency tools", g.gate_clock_ok ? "ok" : ""));
    }

    function kpi(label, value, sub, state = "") {
      return h("div", { class: `tile ${state}` },
        h("div", { class: "tile-label", text: label }),
        h("div", { class: "tile-val", text: value }),
        h("div", { class: "tile-sub", text: sub || "" }));
    }

    function paintKpis(g) {
      const s = hist.samples;
      const locked = s.length ? (100 * s.filter((x) => x.lock && x.sys_lock).length) / s.length : null;
      fill(kpiBody,
        kpi("NIC vs grandmaster", g.running ? ns(g.offset_ns) : "off",
          `worst since lock ${ns(g.worst_offset_ns)}`, g.running ? offsetState(g.offset_ns) : "err"),
        kpi("System vs NIC", g.sys_running ? ns(g.sys_offset_ns) : "off",
          `worst since lock ${ns(g.sys_worst_offset_ns)}`, g.sys_running ? offsetState(g.sys_offset_ns) : "err"),
        kpi("Path delay", ns(g.path_delay_ns), "to the grandmaster"),
        kpi("Locked", locked == null ? "—" : `${locked.toFixed(locked >= 99.95 ? 0 : 1)} %`,
          `of the last ${RANGES.find((r) => r.value === range).label}`,
          locked == null ? "" : locked >= 99.9 ? "ok" : locked >= 95 ? "warn" : "err"));
    }

    function paintDetails(g) {
      clear(detailBody);
      const taiOk = g.tai_offset === g.expected_tai_offset;
      detailBody.appendChild(h("div", { class: "grid" },
        h("div", { style: { "grid-column": "span 6" } },
          row("Port state", g.port_state),
          row("Servo", g.servo ? `${g.servo}${g.servo === "s2" ? " (locked)" : ""}` : null),
          row("Grandmaster", g.grandmaster, { mono: true }),
          row("Domain", g.domain),
          row("Bound to", g.interface ? (g.vlan ? `${g.interface} (VLAN ${g.vlan})` : g.interface) : null, { mono: true })),
        h("div", { style: { "grid-column": "span 6" } },
          row("phc2sys", badge(!g.sys_running ? "not running" : g.sys_locked ? "locked" : (g.sys_servo || "starting"),
                               !g.sys_running ? "gray" : g.sys_locked ? "green" : "amber")),
          row("Kernel TAI offset", badge(g.tai_offset == null ? "unknown" : `${g.tai_offset} s`, taiOk ? "green" : "red")),
          row("NTP", g.ntp_active == null ? null : g.ntp_active
            ? badge(g.running ? "on: conflicts with PTP" : "on", g.running ? "red" : "green")
            : badge(g.running ? "off (PTP owns the clock)" : "off", g.running ? "green" : "amber")),
          row("Gate clock", badge(g.gate_clock_ok ? "ready" : "not ready", g.gate_clock_ok ? "green" : "red")))));
      detailBody.appendChild(btnRow(
        button("Start", { kind: "primary", disabled: busy || g.running,
          onclick: () => runJob(() => view.api.gptp.start({}, { signal: view.signal }), "start PTP") }),
        button("Restart", { disabled: busy || !g.running, title: "Drops lock for tens of seconds",
          onclick: () => runJob(() => view.api.gptp.restart({ signal: view.signal }), "restart PTP") }),
        button("Stop", { kind: "danger", disabled: busy || !g.running,
          onclick: () => runJob(() => view.api.gptp.stop({ signal: view.signal }), "stop PTP") })));
    }

    function paintProblems(g) {
      clear(problemsBody);
      const probs = g.problems || [];
      problemsBody.style.display = probs.length ? "" : "none";
      if (!probs.length) return;
      problemsBody.appendChild(h("div", { class: "card-head" }, h("h3", { text: "Clock not ready" })));
      problemsBody.appendChild(h("ul", null, ...probs.map((t) => h("li", { text: t }))));
    }

    function paintNow(g) {
      paintPath(g);
      paintKpis(g);
      paintDetails(g);
      paintProblems(g);
    }

    // ---- history: chart, strip, events ---------------------------------------
    function paintChart() {
      const p = palette();
      fill(chartHead, seg(RANGES, range, (v) => { range = v; loadHistory(); }));
      clear(chartBody);
      const s = hist.samples;
      if (!s.length) {
        chartBody.appendChild(h("p", { class: "muted", text: "No samples yet. They appear once PTP is running." }));
        return;
      }
      const nic = s.map((x) => ({ t: x.t * 1000, v: x.off }));
      const sys = s.map((x) => ({ t: x.t * 1000, v: x.sys }));
      const vals = s.flatMap((x) => [x.off, x.sys]).filter((v) => v != null);
      // Scale to the 1st..99th percentile so one start-up step does not flatten the hour.
      const lo = Math.min(-50, pctl(vals, 0.01));
      const hi = Math.max(50, pctl(vals, 0.99));
      const to = Date.now();
      const from = to - range * 60 * 1000;
      const offs = s.map((x) => x.off).filter((v) => v != null);
      chartBody.appendChild(chips(
        chip(p.series[3], "NIC vs grandmaster", ns(offs[offs.length - 1])),
        chip(p.series[1], "System vs NIC", ns(s[s.length - 1].sys)),
        chip(null, "Spread (1–99 %)", `${ns(pctl(offs, 0.01))} … ${ns(pctl(offs, 0.99))}`)));
      chartBody.appendChild(h("div", { style: { "margin-top": "10px" } },
        charts.timeSeries([nic, sys], { h: 190, colors: [p.series[3], p.series[1]], gapMs: 5000,
                                         fill: false, min: lo, max: hi, from, to })));
      chartBody.appendChild(healthStrip(s.map((x) => ({ ...x, t: x.t * 1000 })), from, to,
        (x) => (!x.lock || !x.sys_lock ? "err" : offsetState(x.off) === "ok" ? "ok" : "warn")));
      chartBody.appendChild(axisRow(clockTime(from / 1000), "lock: green = locked under 100 ns", clockTime(to / 1000)));
    }

    function paintEvents() {
      fill(eventsBody, eventList(hist.events.slice(-40), clockTime));
    }

    async function loadHistory() {
      try {
        hist = await view.api.gptp.history(range, { signal: view.signal });
        paintChart();
        paintEvents();
        if (last) paintKpis(last);
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          fill(chartBody, h("p", { class: "muted", text: `history unavailable: ${err.message}` }));
        }
      }
    }

    async function poll() {
      try {
        const g = await view.api.gptp.status({ signal: view.signal });
        last = g;
        paintNow(g);
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(problemsBody);
          problemsBody.style.display = "";
          problemsBody.appendChild(h("p", { class: "muted", text: `status unavailable: ${err.message}` }));
        }
      }
    }

    // ---- settings ------------------------------------------------------------
    // ---- guided setup ---------------------------------------------------------
    // The NIC list holds only physical NICs with a PTP hardware clock and
    // hardware tx/rx timestamps. Pick one, check the settings, press Set up:
    // a job installs anything missing, checks the NIC and its link, starts,
    // waits for lock and verifies CLOCK_TAI, reporting each step.
    let chosen = null;
    const STEP_LABEL = {
      dependencies: "Software", nic: "NIC", settings: "Settings",
      start: "Start", lock: "Lock", clock: "CLOCK_TAI",
    };

    async function paintSettings() {
      let cfg; let nics;
      try {
        [cfg, nics] = await Promise.all([
          view.api.gptp.settings({ signal: view.signal }),
          view.api.gptp.nics({ signal: view.signal })]);
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(settingsBody);
          settingsBody.appendChild(h("p", { class: "muted", text: err.message }));
        }
        return;
      }
      const s = cfg.settings || {};
      const list = nics.nics || [];
      if (!chosen || !list.some((n) => n.interface === chosen)) {
        chosen = (list.find((n) => n.configured && n.usable)
                  || list.find((n) => n.usable && n.carrier)
                  || list.find((n) => n.usable) || {}).interface || null;
      }
      clear(settingsBody);

      // 1. software
      const deps = nics.dependencies || {};
      settingsBody.appendChild(h("div", { class: "row" },
        h("span", { class: "k", text: "1  Software" }),
        h("span", { class: "v" },
          deps.ok ? badge("linuxptp + ethtool installed", "green")
            : badge(`missing: ${(deps.missing_packages || []).join(", ")}`, "amber"),
          deps.ok ? null : " ",
          deps.ok ? null : button("Install now", { kind: "primary",
            onclick: () => runSetup(() => view.api.gptp.install({ signal: view.signal }), "install PTP software") }))));

      // 2. NIC
      settingsBody.appendChild(h("div", { class: "kpi-label", style: { margin: "14px 0 8px" },
        text: "2  NIC with a hardware clock" }));
      if (nics.error) settingsBody.appendChild(h("p", { class: "hint", text: nics.error }));
      const grid = h("div", { class: "choice-grid",
        style: { "grid-template-columns": "repeat(auto-fill, minmax(230px, 1fr))" } });
      for (const n of list) {
        const sel = n.interface === chosen;
        const running = nics.running_on && nics.running_on.split(".")[0] === n.interface;
        const node = h("div", {
          class: `choice${sel ? " sel" : ""}`,
          style: n.usable ? {} : { opacity: 0.55, cursor: "not-allowed" },
          title: n.usable ? `Use ${n.interface}` : n.why_not.join("; "),
          onclick: () => { if (n.usable) { chosen = n.interface; paintSettings(); } },
        },
          h("h4", null, n.interface, " ",
            running ? badge("PTP running", "green") : null,
            n.configured && !running ? badge("saved default", "blue") : null),
          h("p", { text: `PHC /dev/ptp${n.phc} · ${n.driver || "?"} · `
                         + `${n.carrier ? `link ${n.speed_mbps ? `${n.speed_mbps} Mb/s` : "up"}` : "no link"}` }),
          n.role ? h("p", { text: n.role }) : null,
          n.vlan_present ? h("p", { text: `VLAN ${s.vlan} subinterface present` }) : null,
          ...(n.usable ? (n.warnings || []) : n.why_not).map((w) =>
            h("p", { style: { color: n.usable && n.carrier ? "var(--soft)" : "var(--red-ink)" }, text: `• ${w}` })));
        grid.appendChild(node);
      }
      settingsBody.appendChild(grid);
      if (nics.hidden) {
        settingsBody.appendChild(h("p", { class: "hint",
          text: `${nics.hidden} NIC(s) hidden — no hardware timestamping: ${(nics.hidden_names || []).join(", ")}` }));
      }

      // 3. settings
      const inputs = {
        profile: select((cfg.profiles || []).map((x) => ({ value: x, label: PROFILE_LABEL[x] || x })),
                        s.profile, () => {}, { class: "mini-select" }),
        vlan: h("input", { type: "number", class: "mini-input", min: 1, max: 4094,
                           placeholder: "untagged", value: s.vlan ?? "" }),
        domain: h("input", { type: "number", class: "mini-input", min: 0, max: 255, value: s.domain ?? 0 }),
        utc: h("input", { type: "number", class: "mini-input", min: 0, max: 100, value: s.utc_offset ?? 37 }),
      };
      settingsBody.appendChild(h("div", { class: "kpi-label", style: { margin: "14px 0 8px" },
        text: "3  Must match the grandmaster" }));
      settingsBody.appendChild(h("div", { class: "grid" },
        h("div", { style: { "grid-column": "span 3" } }, field("Profile", inputs.profile, "a mismatch fails silently")),
        h("div", { style: { "grid-column": "span 3" } }, field("VLAN", inputs.vlan, "blank if untagged")),
        h("div", { style: { "grid-column": "span 3" } }, field("Domain", inputs.domain)),
        h("div", { style: { "grid-column": "span 3" } }, field("TAI − UTC (s)", inputs.utc, "37 since 2017"))));

      // 4. go
      const chosenNic = list.find((n) => n.interface === chosen);
      settingsBody.appendChild(btnRow(
        button(chosen ? `Set up PTP on ${chosen}` : "Pick a NIC", {
          kind: "primary", disabled: busy || !chosen || !chosenNic?.usable,
          title: "Installs anything missing, checks the NIC, starts, waits for lock, verifies CLOCK_TAI",
          onclick: () => runSetup(() => view.api.gptp.setup({
            interface: chosen, profile: inputs.profile.value,
            vlan: inputs.vlan.value === "" ? null : Number(inputs.vlan.value),
            domain: Number(inputs.domain.value), utc_offset: Number(inputs.utc.value),
            install: true, persist: true,
          }, { signal: view.signal }), `PTP setup on ${chosen}`),
        }),
        button("Refresh NICs", { onclick: paintSettings })));
      if (chosenNic && !chosenNic.carrier) {
        settingsBody.appendChild(h("p", { class: "hint", text:
          `${chosen} has no link — setup will stop at the NIC step until the cable to the grandmaster switch is in.` }));
      }
      settingsBody.appendChild(setupPane);
    }

    // Step checklist + log for the setup job; kept across repaints.
    const setupSteps = h("div");
    const setupLog = h("pre", { class: "log", style: { "max-height": "180px" } });
    const setupPane = h("div", { style: { display: "none", "margin-top": "12px" } }, setupSteps, setupLog);

    function paintSteps(job) {
      clear(setupSteps);
      const icon = { succeeded: "✓", running: "…", failed: "✗", pending: "·" };
      const kind = { succeeded: "green", running: "blue", failed: "red", pending: "gray" };
      setupSteps.appendChild(h("div", { class: "btn-row" },
        ...(job.steps || []).map((st) => {
          const state = job.state === "failed" && st.state === "running" ? "failed" : st.state;
          return badge(`${icon[state] || "·"} ${STEP_LABEL[st.name] || st.name}`, kind[state] || "gray");
        })));
    }

    async function runSetup(starter, label) {
      busy = true;
      setupPane.style.display = "";
      setupLog.textContent = `> ${label}\n`;
      clear(setupSteps);
      try {
        const res = await starter();
        let seen = 0;
        for (let i = 0; i < 1200 && res?.job_id; i += 1) {
          await new Promise((r) => view.timeout(r, 700));
          const job = await view.api.jobs.get(res.job_id, { signal: view.signal });
          paintSteps(job);
          for (const line of (job.lines || []).slice(seen)) setupLog.textContent += `  ${line}\n`;
          seen = (job.lines || []).length;
          setupLog.scrollTop = setupLog.scrollHeight;
          if (!["queued", "running"].includes(job.state)) {
            if (job.error) toast(job.error, "err");
            else toast(`${label}: done`, "ok");
            break;
          }
        }
        series.master.length = 0;
        series.sys.length = 0;
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          setupLog.textContent += `  ${err.message}\n`;
          toast(err.message, "err");
        }
      } finally {
        busy = false;
        paintSettings();
        poll();
      }
    }

    // ---- jobs ----------------------------------------------------------------
    async function runJob(starter, label) {
      busy = true;
      if (last) paintNow(last);
      try {
        const res = await starter();
        if (res?.job_id) {
          for (let i = 0; i < 60; i += 1) {
            await new Promise((r) => view.timeout(r, 500));
            const job = await view.api.jobs.get(res.job_id, { signal: view.signal });
            if (!["queued", "running"].includes(job.state)) {
              if (job.error) toast(job.error, "err");
              else toast(`${label}: done`, "ok");
              break;
            }
          }
        } else {
          toast(`${label}: done`, "ok");
        }
        series.master.length = 0;
        series.sys.length = 0;
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      } finally {
        busy = false;
        poll();
      }
    }

    await paintSettings();
    await poll();
    await loadHistory();
    view.interval(poll, POLL_MS);
    view.interval(loadHistory, HISTORY_MS);
  },
});
