/**
 * Time Sync — PTP via ptp4l (NIC clock) and phc2sys (system clock).
 *
 * Two clocks, and both have to be right before a gate schedule means anything:
 * ptp4l locks the NIC's hardware clock to the grandmaster, phc2sys locks the
 * system clock to the NIC, and the kernel TAI offset turns that into CLOCK_TAI.
 * The old view showed only the first, labelled every profile "802.1AS", and
 * offered a Start button whose interface picker defaulted to the wrong port.
 *
 * This view polls /api/ptp/status itself. The controller snapshot is only
 * pushed when the controller's state changes, so an offset chart fed from it
 * collected one sample per session.
 */

import { ApiError } from "../../core/api.js";
import { defineView } from "../../core/component.js";
import { toast } from "../../core/dialog.js";
import { clear, h } from "../../core/dom.js";
import { ns } from "../../core/format.js";
import * as charts from "../../ui/charts.js";
import { palette } from "../../ui/tokens.js";
import { badge, btnRow, button, card, field, row, select } from "../../ui/widgets.js";

const POLL_MS = 1000;
const WINDOW_MS = 5 * 60 * 1000;
const PROFILE_LABEL = { ieee1588: "IEEE 1588", gptp: "802.1AS" };

export default defineView({
  name: "gptp",

  async mount(view) {
    const statusBody = h("div");
    const clockBody = h("div");
    const chartBody = h("div");
    const settingsBody = h("div");
    // A card of its own, hidden when there is nothing to say: an empty grid
    // child still takes a cell and pushed every card one column to the right.
    const problemsBody = h("section", { class: "card col12",
      style: { display: "none", "border-left": "4px solid var(--red)" } });
    const series = { master: [], sys: [] };
    let last = null;
    let busy = false;

    view.root.appendChild(h("div", { class: "grid" },
      problemsBody,
      card("Set up PTP", { span: "col12", hint: "pick the NIC cabled to the grandmaster" }, settingsBody),
      card("PTP — NIC clock", { span: "col6" }, statusBody),
      card("System clock", { span: "col6" }, clockBody),
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "Offset from master" }),
          h("span", { class: "hint", text: "last 5 minutes — lower and flatter is better" })),
        chartBody)));

    // ---- status --------------------------------------------------------------
    function verdict(g) {
      if (!g.running) return { label: "off", pct: 0, color: "faint" };
      if (!g.grandmaster) return { label: "no GM", pct: 25, color: "err" };
      if (!g.locked) return { label: "syncing", pct: 50, color: "warn" };
      if (!g.sys_locked) return { label: "NIC only", pct: 75, color: "warn" };
      return { label: "locked", pct: 100, color: "ok" };
    }

    function boundIface(g) {
      if (!g.interface) return null;
      const phys = g.phys_interface || g.interface;
      return g.vlan ? `${g.interface}  (${phys}, VLAN ${g.vlan})` : g.interface;
    }

    function paintStatus(g) {
      const p = palette();
      const v = verdict(g);
      clear(statusBody);
      statusBody.appendChild(h("div", { class: "gauge-wrap" },
        charts.gauge(v.pct, {
          size: 96, stroke: 9, color: p[v.color] || p.faint, label: v.label,
          sub: PROFILE_LABEL[g.profile] || g.profile || "",
        }),
        h("div", null,
          h("div", { class: "kpi-label", text: "Qbv clock" }),
          badge(g.gate_clock_ok ? "ready" : "not ready",
                g.gate_clock_ok ? "green" : "red"))));
      statusBody.appendChild(row("Port state", g.port_state));
      statusBody.appendChild(row("Servo", g.servo
        ? `${g.servo}${g.servo === "s2" ? " (locked)" : ""}` : null));
      statusBody.appendChild(row("Grandmaster", g.grandmaster, { mono: true }));
      statusBody.appendChild(row("Offset", ns(g.offset_ns)));
      statusBody.appendChild(row("Worst since lock", ns(g.worst_offset_ns)));
      statusBody.appendChild(row("Path delay", ns(g.path_delay_ns)));
      statusBody.appendChild(row("Bound to", boundIface(g), { mono: true }));
      statusBody.appendChild(row("Domain", g.domain));
      statusBody.appendChild(btnRow(
        button("Start", { kind: "primary", disabled: busy || g.running,
                          onclick: () => runJob(() => view.api.gptp.start({}, { signal: view.signal }), "start PTP") }),
        button("Restart", { disabled: busy || !g.running,
                            title: "Drops lock for tens of seconds",
                            onclick: () => runJob(() => view.api.gptp.restart({ signal: view.signal }), "restart PTP") }),
        button("Stop", { kind: "danger", disabled: busy || !g.running,
                         onclick: () => runJob(() => view.api.gptp.stop({ signal: view.signal }), "stop PTP") })));
    }

    function paintClock(g) {
      clear(clockBody);
      clockBody.appendChild(row("phc2sys", badge(
        !g.sys_running ? "not running" : g.sys_locked ? "locked" : (g.sys_servo || "starting"),
        !g.sys_running ? "gray" : g.sys_locked ? "green" : "amber")));
      clockBody.appendChild(row("System vs NIC", ns(g.sys_offset_ns)));
      clockBody.appendChild(row("Worst since lock", ns(g.sys_worst_offset_ns)));
      const taiOk = g.tai_offset === g.expected_tai_offset;
      clockBody.appendChild(row("Kernel TAI offset", badge(
        g.tai_offset == null ? "unknown" : `${g.tai_offset} s (want ${g.expected_tai_offset})`,
        taiOk ? "green" : "red")));
      clockBody.appendChild(row("CLOCK_TAI − wall clock",
        g.tai_minus_realtime_s == null ? null : `${g.tai_minus_realtime_s.toFixed(3)} s`));
      clockBody.appendChild(row("NTP", g.ntp_active == null ? null
        : g.ntp_active
          ? badge(g.running ? "on — fighting PTP" : "on", g.running ? "red" : "green")
          : badge(g.running ? "off — PTP owns the clock" : "off — no time source",
                  g.running ? "green" : "amber")));
      clockBody.appendChild(h("p", { class: "hint" },
        "The grandmaster is free-running, so this host follows the grandmaster's "
        + "time, not UTC. Hosts on NTP will differ from it by a fraction of a second."));
    }

    function paintProblems(g) {
      clear(problemsBody);
      const probs = g.problems || [];
      problemsBody.style.display = probs.length ? "" : "none";
      if (!probs.length) return;
      problemsBody.appendChild(h("div", { class: "card-head" },
        h("h3", { text: "Clock not ready for a gate schedule" })));
      problemsBody.appendChild(h("ul", null, ...probs.map((t) => h("li", { text: t }))));
    }

    function paintChart() {
      clear(chartBody);
      const p = palette();
      if (!series.master.length && !series.sys.length) {
        chartBody.appendChild(h("p", { class: "muted" },
          "No offset samples yet. They appear once ptp4l is running."));
        return;
      }
      chartBody.appendChild(charts.timeSeries([series.master, series.sys], {
        h: 180, colors: [p.series[3], p.series[1]], gapMs: 5000, fill: false,
        min: Math.min(0, ...series.master.map((d) => d.v), ...series.sys.map((d) => d.v)),
      }));
      const stat = (pts) => {
        if (!pts.length) return "—";
        const vs = pts.map((d) => d.v);
        return `latest ${ns(vs[vs.length - 1])}, range ${ns(Math.min(...vs))} … ${ns(Math.max(...vs))}`;
      };
      chartBody.appendChild(h("p", { class: "hint" },
        h("span", { style: { color: p.series[3], "font-weight": "700" }, text: "■ NIC vs grandmaster " }),
        stat(series.master), "   ",
        h("span", { style: { color: p.series[1], "font-weight": "700" }, text: "■ system vs NIC " }),
        stat(series.sys)));
    }

    function push(ring, v, now) {
      if (v === null || v === undefined) return;
      ring.push({ t: now, v: Number(v) });
      while (ring.length && ring[0].t < now - WINDOW_MS) ring.shift();
    }

    async function poll() {
      try {
        const g = await view.api.gptp.status({ signal: view.signal });
        const now = Date.now();
        if (g.running) {
          push(series.master, g.offset_ns, now);
          push(series.sys, g.sys_offset_ns, now);
        }
        last = g;
        paintStatus(g);
        paintClock(g);
        paintProblems(g);
        paintChart();
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
      if (last) paintStatus(last);
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
    view.interval(poll, POLL_MS);
  },
});
