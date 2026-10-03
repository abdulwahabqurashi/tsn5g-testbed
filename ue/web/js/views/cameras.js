/**
 * Cameras — the two-camera demo, run from one page.
 *
 * Three things the demo needs on screen at once: are both cameras the right
 * ones and reachable, which queue policy is live, and what each lane and each
 * camera is actually doing. The last is what turns "camera 1 looks smoother"
 * into a measurement.
 *
 * Counters are cumulative on the server; rates are taken between two polls
 * here, so nothing on the server has to keep a window.
 *
 * Two units, deliberately not mixed: per-camera numbers are datagrams leaving
 * on the bearer (before fragmentation — the unit the core counts on arrival);
 * lane numbers are tc packets (after it, two per datagram on this bearer).
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { confirm, toast } from "../core/dialog.js";
import { clear, h } from "../core/dom.js";
import * as charts from "../ui/charts.js";
import { palette } from "../ui/tokens.js";
import { badge, btnRow, button, card, field, row, select, table } from "../ui/widgets.js";

const POLL_MS = 1000;
const WINDOW_MS = 5 * 60 * 1000;
const LANE_NAME = { "1:10": "protected", "1:20": "best effort", "1:1": "link (root class)" };
const POLICY_HINT = {
  shallow: "one queue, no separation — policy off",
  limited: "two lanes, best effort capped — policy on",
  prio: "strict priority, no cap",
  default: "whatever the modem driver installs",
};

export default defineView({
  name: "cameras",

  async mount(view) {
    const arBody = h("div");
    const arChart = h("div");
    let arMid = null;
    const rigBody = h("div");
    const rigLog = h("pre", { class: "log", style: { "max-height": "160px", display: "none" } });
    const camBody = h("div");
    const queueBody = h("div");
    const liveBody = h("div");
    const chartBody = h("div");
    const laneBody = h("div");
    let prev = null;
    const series = {};           // camera name -> [{t, v Mbit/s}]

    // Top: the guided setup. Middle: what you watch during a demo. Bottom,
    // collapsed: every individual control, for when a step needs a closer look.
    const setupBody = h("div");
    view.root.appendChild(h("div", { class: "grid" },
      card("Set up the camera demo", { span: "col12",
        hint: "work down the list — each step checks itself and has one button" }, setupBody),
      card("Live", { span: "col5", hint: "per camera, leaving on the 5G link" }, liveBody),
      h("section", { class: "card col7" },
        h("div", { class: "card-head" },
          h("h3", { text: "Per-camera rate" }),
          h("span", { class: "hint", text: "last 5 minutes, Mbit/s" })),
        chartBody),
      card("Auto-rate", { span: "col12", hint: "keeps the UE just under the radio, so priority is decided here" }, arBody),
      h("details", { class: "card col12" },
        h("summary", { style: { cursor: "pointer", "font-weight": "600" },
                       text: "Advanced controls — rig, camera roles, queue policy, lanes" }),
        h("div", { class: "grid", style: { "margin-top": "12px" } },
          card("Rig", { span: "col12", hint: "individual services" }, rigBody, rigLog),
          card("Cameras", { span: "col6" }, camBody),
          card("Queue policy", { span: "col6", hint: "applied live" }, queueBody),
          card("Lanes", { span: "col12", hint: "tc counters on the bearer, after fragmentation" }, laneBody)))));

    // ---- guided setup ------------------------------------------------------------
    const STATE_ICON = { ok: "✓", now: "→", later: "·" };
    const STATE_KIND = { ok: "green", now: "blue", later: "gray" };
    const KIND_LABEL = {
      "rig.encoders": "Starting the camera encoders", "rig.units_install": "Installing the boot services",
      "rig.netns_ensure": "Repairing camera 2's namespace", "bearer.cycle": "Restarting the 5G data call",
      "rig.nat_flush": "Clearing NAT state", "rig.display_up": "Restarting the VNC screen",
      "rig.press_start": "Pressing Start in the encoder windows",
    };
    let fixing = null;

    async function runFix(step) {
      const action = step.action || {};
      if (action.confirm) {
        const ok = await confirm({ title: action.label, body: action.confirm,
                                   confirmLabel: action.label, danger: true });
        if (!ok) return;
      }
      fixing = step.key;
      paintSetup();
      try {
        const res = await view.api.rig.fix(step.key, { signal: view.signal });
        if (res?.job_id) {
          for (let i = 0; i < 300; i += 1) {
            await new Promise((r) => view.timeout(r, 1000));
            const job = await view.api.jobs.get(res.job_id, { signal: view.signal });
            if (!["queued", "running"].includes(job.state)) {
              if (job.error) toast(`${step.title}: ${job.error}`, "err");
              break;
            }
          }
        } else if (res?.done) {
          toast(res.done, "ok");
        }
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      } finally {
        fixing = null;
        paintSetup();
        paintCameras();
        paintQueue();
        paintRig();
      }
    }

    let setupInFlight = false;
    async function paintSetup() {
      if (setupInFlight) return;      // a check can take a few seconds
      setupInFlight = true;
      let c;
      try {
        c = await view.api.rig.checklist({ signal: view.signal });
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(setupBody);
          setupBody.appendChild(h("p", { class: "muted", text: `could not read the setup state: ${err.message}` }));
        }
        setupInFlight = false;
        return;
      }
      setupInFlight = false;
      clear(setupBody);
      const busy = (c.busy || []).filter((b) => b.lane === "net" || b.lane === "bearer");
      if (busy.length || fixing) {
        setupBody.appendChild(h("div", { class: "row", style: { background: "var(--blue-soft)", padding: "10px 12px", "border-radius": "8px" } },
          h("span", { class: "k", text: "Working…" }),
          h("span", { class: "v", text: busy.length
            ? busy.map((b) => `${KIND_LABEL[b.kind] || b.kind} (${b.for_s} s)`).join(", ")
            : "applying" })));
      }
      if (c.all_done) {
        setupBody.appendChild(h("p", { style: { "font-weight": "600", color: "var(--green)" },
          text: "Everything is set. Run the demo from the UE:  ~/camera_application/tsn5g-ue-app/scripts/demo-run.sh" }));
      }
      c.steps.forEach((st, i) => {
        const node = h("div", { style: {
          display: "grid", "grid-template-columns": "34px 1fr auto", gap: "12px", "align-items": "start",
          padding: "12px 0", "border-bottom": "1px solid var(--line-2)", opacity: st.state === "later" ? 0.55 : 1 } },
          h("div", { style: { "text-align": "center" } }, badge(`${STATE_ICON[st.state]} ${i + 1}`, STATE_KIND[st.state])),
          h("div", null,
            h("div", { style: { "font-weight": "600" }, text: st.title }),
            h("div", { class: "hint", text: st.detail }),
            st.manual && st.state === "now" && !st.action
              ? h("ol", { style: { margin: "8px 0 0", "padding-left": "18px" } },
                  ...st.manual.map((m) => h("li", { class: "hint", text: m })))
              : null),
          h("div", null,
            st.action && st.state !== "ok"
              ? button(fixing === st.key ? "Working…" : st.action.label, {
                  kind: st.state === "now" ? "primary" : "",
                  disabled: Boolean(fixing) || busy.length > 0,
                  title: st.state === "later" ? "Do the earlier steps first" : "",
                  onclick: () => runFix(st) })
              : null));
        setupBody.appendChild(node);
      });
    }

    // ---- rig -------------------------------------------------------------------
    // A job that interrupts a stream answers 428 first; ask, then resend with
    // confirm. Its output goes to the log pane so a failure says why.
    async function rigJob(label, start, opts = {}) {
      rigLog.style.display = "";
      rigLog.textContent = `> ${label}\n`;
      let res;
      try {
        res = await start({});
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        if (err.status === 409 && /lane busy/.test(err.message)) {
          const msg = "Another action is still running. Wait for it to finish (see 'Working…' at the top), then try again.";
          rigLog.textContent += `  ${msg}\n`; toast(msg, "err"); return;
        }
        if (err.status !== 428) { rigLog.textContent += `  ${err.message}\n`; toast(err.message, "err"); return; }
        const ok = await confirm({ title: label, body: err.data?.explain || opts.explain || err.message,
                                   confirmLabel: "Continue", danger: true });
        if (!ok) { rigLog.textContent += "  cancelled\n"; return; }
        try { res = await start({ confirm: true }); } catch (err2) {
          rigLog.textContent += `  ${err2.message}\n`; toast(err2.message, "err"); return;
        }
      }
      let seen = 0;
      for (let i = 0; i < 300 && res?.job_id; i += 1) {
        await new Promise((r) => view.timeout(r, 700));
        const job = await view.api.jobs.get(res.job_id, { signal: view.signal });
        for (const line of (job.lines || []).slice(seen)) rigLog.textContent += `  ${line}\n`;
        seen = (job.lines || []).length;
        rigLog.scrollTop = rigLog.scrollHeight;
        if (!["queued", "running"].includes(job.state)) {
          if (job.error) { rigLog.textContent += `  FAILED: ${job.error}\n`; toast(job.error, "err"); }
          else toast(`${label}: done`, "ok");
          break;
        }
      }
      paintRig();
      paintCameras();
    }

    function okBadge(ok, yes, no, warn = false) {
      return badge(ok ? yes : no, ok ? "green" : warn ? "amber" : "red");
    }

    async function paintRig() {
      let r;
      try {
        r = await view.api.rig.status({ signal: view.signal });
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(rigBody);
          rigBody.appendChild(h("p", { class: "muted", text: err.message }));
        }
        return;
      }
      const api = view.api.rig;
      const o = { signal: view.signal };
      const units = r.units || {};
      const unitsOk = Object.values(units).every((u) => u.installed && u.enabled);
      const n = r.netns || {};
      const enc = r.encoders?.encoders || [];
      const d = r.display || {};
      clear(rigBody);

      const cols = h("div", { class: "grid" });
      const col = (title, ...body) => h("div", { class: "col4", style: { "grid-column": "span 4" } },
        h("div", { class: "kpi-label", text: title }), ...body);

      cols.appendChild(col("Camera 2 namespace",
        row("State", okBadge(n.ok, "ready", n.exists ? "needs attention" : "missing")),
        ...(n.problems || []).map((t) => h("p", { class: "hint", text: `• ${t}` })),
        btnRow(
          button(n.exists ? "Check & repair" : "Create", { kind: n.ok ? "" : "primary",
            title: "Leaves a working namespace alone; re-asserts its NAT and leak-guard rules",
            onclick: () => rigJob("camera 2 namespace", () => api.netnsEnsure(o)) }),
          button("Clear NAT state", { title: "Fixes a stream leaving with its private source after the bearer dropped",
            disabled: !r.conntrack_installed,
            onclick: () => rigJob("clear NAT state", () => api.natFlush(o)) })),
        r.conntrack_installed ? null : h("p", { class: "hint", text: "conntrack is not installed: sudo apt install conntrack" })));

      cols.appendChild(col("Encoders",
        ...enc.map((e) => row(e.name, okBadge(e.running,
          `running${e.uptime_s != null ? ` ${Math.round(e.uptime_s / 60)} min` : ""}`, "stopped"))),
        row("Managed by", r.encoders?.managed_by_unit ? "tsn5g-cameras.service" : "nothing (started by hand)"),
        btnRow(
          button(enc.some((e) => e.running) ? "Restart" : "Start", { kind: "primary", disabled: !units["tsn5g-cameras.service"]?.installed,
            onclick: () => rigJob("restart encoders", (b) => api.encoders("restart", b, o)) }),
          button("Stop", { kind: "danger", disabled: !units["tsn5g-cameras.service"]?.installed,
            onclick: () => rigJob("stop encoders", (b) => api.encoders("stop", b, o)) })),
        h("p", { class: "hint", text: "Start is pressed in each encoder window automatically after a (re)start." })));

      cols.appendChild(col("VNC screen",
        row("Screen :99", okBadge(d.screen, "up", "down")),
        row("VNC", okBadge(d.vnc, "localhost:5900", "down")),
        row("Window manager", okBadge(d.window_manager, "openbox", "none", true)),
        h("p", { class: "hint", text: d.connect || "" }),
        btnRow(button(d.ok ? "Restart screen" : "Start screen", { kind: d.ok ? "" : "primary",
          disabled: !units["tsn5g-vnc-display.service"]?.installed,
          onclick: () => rigJob("VNC screen", (b) => api.displayUp(b, o)) }))));
      rigBody.appendChild(cols);

      rigBody.appendChild(h("div", { class: "row" },
        h("span", { class: "k", text: "Boot units" }),
        h("span", { class: "v" },
          ...Object.entries(units).map(([u, st]) => badge(
            `${u.replace("tsn5g-", "").replace(".service", "")}: ${!st.installed ? "not installed"
              : st.active ? "active" : st.enabled ? "enabled" : "disabled"}`,
            !st.installed ? "red" : st.active || st.enabled ? "green" : "amber")),
          " ",
          button(unitsOk ? "Reinstall" : "Install", { kind: unitsOk ? "" : "primary",
            title: "Installs and enables the units so the rig comes back after a reboot",
            onclick: () => rigJob("install boot units", (b) => api.installUnits({ ...b }, o)) }))));
    }

    // ---- auto-rate -------------------------------------------------------------
    // The modem does not prioritise between bearers (LCP tests, 3 Oct), so the
    // UE must stay the bottleneck. Auto-rate moves the shaping rate with the
    // radio: a ping in the protected lane shows when the modem starts queueing.
    async function paintAutorate() {
      let a;
      try {
        a = await view.api.bearer.autorate({ signal: view.signal });
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(arBody); arBody.appendChild(h("p", { class: "muted", text: err.message }));
        }
        return;
      }
      const cfg = a.config || {};
      const set = async (body) => {
        try {
          await view.api.bearer.setAutorate(body, { signal: view.signal });
          paintAutorate();
        } catch (err) {
          if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
        }
      };
      clear(arBody);
      const left = h("div", { style: { "grid-column": "span 4" } },
        row("State", badge(a.active ? `on — ${a.last_action || "running"}` : (cfg.enabled ? "waiting" : "off"),
                           a.active ? "green" : cfg.enabled ? "amber" : "gray")),
        a.reason ? h("p", { class: "hint", text: a.reason }) : null,
        row("Shaping rate", a.rate_mbps == null ? null : `${a.rate_mbps} Mbit/s`),
        row("Best-effort cap now", a.be_ceil_mbps == null ? null : `${a.be_ceil_mbps} Mbit/s`),
        row("Sent on the bearer", a.load_mbps == null ? null : `${a.load_mbps} Mbit/s`),
        row("Round trip / baseline", a.rtt_ms == null ? null : `${a.rtt_ms} / ${a.base_rtt_ms} ms`),
        btnRow(button(cfg.enabled ? "Turn off" : "Turn on", {
          kind: cfg.enabled ? "danger" : "primary",
          onclick: () => set({ enabled: !cfg.enabled }),
        })));
      // Built once and kept: the panel repaints every 2 s, and rebuilding the
      // settings would wipe whatever the operator is typing.
      if (!arMid) {
        const inputs = {
          min: h("input", { type: "number", class: "mini-input", value: cfg.min_mbps }),
          max: h("input", { type: "number", class: "mini-input", value: cfg.max_mbps }),
          reserve: h("input", { type: "number", class: "mini-input", value: cfg.reserve_mbps }),
          hi: h("input", { type: "number", class: "mini-input", value: cfg.delay_hi_ms }),
        };
        arMid = h("div", { style: { "grid-column": "span 3" } },
          field("Min (Mbit/s)", inputs.min), field("Max (Mbit/s)", inputs.max),
          field("Protected reserve (Mbit/s)", inputs.reserve, "always kept for the protected lane"),
          field("Cut when delay rises by (ms)", inputs.hi),
          btnRow(button("Save", { onclick: () => set({
            min_mbps: Number(inputs.min.value), max_mbps: Number(inputs.max.value),
            reserve_mbps: Number(inputs.reserve.value), delay_hi_ms: Number(inputs.hi.value) }) })));
      }
      const mid = arMid;
      const right = h("div", { style: { "grid-column": "span 5" } }, arChart);
      clear(arChart);
      const hist = a.history || [];
      if (hist.length > 2) {
        const p = palette();
        const now = Date.now();
        const toPts = (k) => hist.map((x) => ({ t: x.t * 1000, v: x[k] })).filter((x) => x.v != null);
        arChart.appendChild(charts.timeSeries([toPts("rate"), toPts("load")], {
          h: 150, colors: [p.series[0], p.series[2]], gapMs: 3000, fill: false, to: now }));
        arChart.appendChild(h("p", { class: "hint" },
          h("span", { style: { color: p.series[0], "font-weight": "700" }, text: "■ shaping rate  " }),
          h("span", { style: { color: p.series[2], "font-weight": "700" }, text: "■ sent on the bearer" })));
      } else {
        arChart.appendChild(h("p", { class: "muted", text: a.active ? "Collecting…" : "The chart appears once auto-rate is running." }));
      }
      arBody.appendChild(h("div", { class: "grid" }, left, mid, right));
    }

    // ---- cameras ---------------------------------------------------------------
    async function paintCameras() {
      try {
        const res = await view.api.rig.binding({ signal: view.signal });
        clear(camBody);
        for (const c of res.cameras || []) {
          const verdict = c.serial_ok === false
            ? (c.serial ? badge("WRONG CAMERA", "red") : badge("no answer", "red"))
            : badge("ready", "green");
          const protectedLane = c.lane === "protected";
          camBody.appendChild(h("div", { class: "row" },
            h("span", { class: "k" }, `${c.name} `, badge(protectedLane ? "protected" : "best effort",
                                                          protectedLane ? "green" : "gray")),
            h("span", { class: "v" }, verdict)));
          camBody.appendChild(h("p", { class: "hint", text:
            `serial ${c.serial || "?"}${c.expected_serial && c.serial !== c.expected_serial
              ? ` (want ${c.expected_serial})` : ""} · ${c.interface}${c.netns ? ` in ${c.netns}` : ""}`
            + ` · stream :${c.stream_port}` }));
          camBody.appendChild(h("div", { class: "row" },
            h("span", { class: "k", text: "5G bearer" }),
            h("span", { class: "v" },
              badge(c.gbr_bearer ? "GBR (QFI 2)" : "default (QFI 1)", c.gbr_bearer ? "green" : "gray"), " ",
              button(c.gbr_bearer ? "Use default bearer" : "Use GBR bearer", {
                title: "Rewrites this camera's source port to 5202, which the core's GBR filter matches. Live; no stream interruption.",
                onclick: async () => {
                  try {
                    await view.api.rig.setGbr({ camera: c.name, enabled: !c.gbr_bearer }, { signal: view.signal });
                    toast(`${c.name}: ${c.gbr_bearer ? "default" : "GBR"} bearer`, "ok");
                    paintCameras();
                  } catch (err) {
                    if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
                  }
                },
              }))));
          if (!protectedLane) {
            camBody.appendChild(btnRow(button(`Protect ${c.name}`, {
              title: "Moves the protected lane to this camera, live. Streams are not interrupted.",
              onclick: async () => {
                try {
                  await view.api.rig.setBinding({ protected: c.name }, { signal: view.signal });
                  toast(`${c.name} is now the protected camera`, "ok");
                  prev = null;
                  paintCameras();
                } catch (err) {
                  if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
                }
              },
            })));
          }
        }
        if (res.protected?.length !== 1) {
          camBody.appendChild(h("p", { class: "hint", text:
            `${res.protected?.length || 0} cameras are in the protected lane — exactly one should be.` }));
        }
        camBody.appendChild(btnRow(button("Re-check", { onclick: paintCameras })));
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(camBody);
          camBody.appendChild(h("p", { class: "muted", text: err.message }));
        }
      }
    }

    // ---- queue -----------------------------------------------------------------
    async function paintQueue() {
      let q;
      try {
        q = await view.api.bearer.queue({ signal: view.signal });
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(queueBody);
          queueBody.appendChild(h("p", { class: "muted", text: err.message }));
        }
        return;
      }
      const inputs = {
        policy: select((q.policies || []).map((p) => ({ value: p, label: p })),
                       q.policy, (v) => { hint.textContent = POLICY_HINT[v] || ""; },
                       { class: "mini-select" }),
        be: h("input", { type: "number", class: "mini-input", min: 1, value: q.be_mbps }),
        link: h("input", { type: "number", class: "mini-input", min: 1, value: q.link_mbps }),
        limit: h("input", { type: "number", class: "mini-input", min: 1, value: q.limit }),
      };
      const hint = h("span", { class: "hint", text: POLICY_HINT[q.policy] || "" });
      const apply = async (body) => {
        try {
          const res = await view.api.bearer.setQueue(body, { signal: view.signal });
          toast(`queue: ${res.policy}${res.policy === "limited"
            ? ` (best effort ${res.be_mbps} of ${res.link_mbps} Mbit/s)` : ""}`, "ok");
          prev = null;           // counters were reset with the qdisc
          paintQueue();
        } catch (err) {
          if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
        }
      };
      const current = () => ({
        policy: inputs.policy.value, be_mbps: Number(inputs.be.value),
        link_mbps: Number(inputs.link.value), limit: Number(inputs.limit.value),
      });

      clear(queueBody);
      queueBody.appendChild(row("Live", badge(
        `${q.live?.kind || "?"}${q.live?.matches ? "" : " — does not match config"}`,
        q.live?.matches ? "green" : "red")));
      queueBody.appendChild(row("Policy", q.policy));
      if (q.policy === "limited") {
        queueBody.appendChild(row("Best-effort cap", `${q.be_mbps} Mbit/s`));
        queueBody.appendChild(row("Link", `${q.link_mbps} Mbit/s`));
      }
      queueBody.appendChild(btnRow(
        button("Policy off", { title: "shallow: one queue for everything",
                               onclick: () => apply({ ...current(), policy: "shallow" }) }),
        button("Policy on", { kind: "primary", title: "limited: protected lane + capped best effort",
                              onclick: () => apply({ ...current(), policy: "limited" }) })));
      queueBody.appendChild(h("details", { class: "state-detail" },
        h("summary", { text: "Settings" }),
        field("Policy", inputs.policy), hint,
        field("Best-effort cap (Mbit/s)", inputs.be, "camera 2 and anything unclassified"),
        field("Link (Mbit/s)", inputs.link, "root rate; keep above what the radio carries"),
        field("Queue limit (packets)", inputs.limit, "per leaf; 20 discarded 38% of every frame"),
        btnRow(button("Apply", { kind: "primary", onclick: () => apply(current()) }))));
      queueBody.appendChild(h("p", { class: "hint",
        text: "Switching rebuilds the queue: expect a sub-second blip on both streams." }));
    }

    // ---- live counters ---------------------------------------------------------
    function push(ring, v, now) {
      ring.push({ t: now, v });
      while (ring.length && ring[0].t < now - WINDOW_MS) ring.shift();
    }

    function rate(cur, old, key, dt) {
      if (!old || cur?.[key] == null || old?.[key] == null) return null;
      const d = cur[key] - old[key];
      return d >= 0 ? d / dt : null;   // a reset counter is not a negative rate
    }

    function paintLive(c) {
      const dt = prev ? c.t - prev.t : 0;
      const now = Date.now();
      clear(liveBody);
      const rows = [];
      for (const s of c.streams || []) {
        const old = prev?.streams?.find((x) => x.name === s.name);
        const mbit = dt > 0 ? rate(s, old, "bytes", dt) : null;
        const dps = dt > 0 ? rate(s, old, "pkts", dt) : null;
        if (mbit != null) push(series[s.name] ||= [], (mbit * 8) / 1e6, now);
        rows.push([s.name, s.lane === "protected" ? badge("protected", "green") : badge("best effort", "gray"),
                   mbit == null ? null : `${((mbit * 8) / 1e6).toFixed(2)} Mbit/s`,
                   dps == null ? null : `${Math.round(dps)} /s`]);
      }
      liveBody.appendChild(table(["camera", "lane", "rate", "datagrams"], rows));
      liveBody.appendChild(row("Policy", c.policy === "limited"
        ? `limited — best effort ${c.be_mbps} of ${c.link_mbps} Mbit/s` : c.policy));

      // lanes
      clear(laneBody);
      const lrows = [];
      const entries = Object.entries(c.qdisc?.classes || {});
      const lanes = entries.length ? entries : (c.qdisc?.root ? [["root", c.qdisc.root]] : []);
      for (const [id, cur] of lanes) {
        const old = id === "root" ? prev?.qdisc?.root : prev?.qdisc?.classes?.[id];
        const bps = dt > 0 ? rate(cur, old, "bytes", dt) : null;
        const pps = dt > 0 ? rate(cur, old, "pkts", dt) : null;
        const dps = dt > 0 ? rate(cur, old, "dropped", dt) : null;
        const loss = pps != null && dps != null && pps + dps > 0 ? (100 * dps) / (pps + dps) : null;
        lrows.push([id === "root" ? `root (${cur.kind})` : `${id} ${LANE_NAME[id] || ""}`,
                    bps == null ? null : `${((bps * 8) / 1e6).toFixed(2)} Mbit/s`,
                    pps == null ? null : `${Math.round(pps)}`,
                    dps == null ? null : `${Math.round(dps)}`,
                    loss == null ? null : badge(`${loss.toFixed(1)}%`, loss > 1 ? "red" : loss > 0 ? "amber" : "green"),
                    cur.backlog_pkts ?? null]);
      }
      laneBody.appendChild(table(["lane", "rate", "packets/s", "drops/s", "drop %", "queued"], lrows));
      if (c.policy !== "limited") {
        laneBody.appendChild(h("p", { class: "hint", text:
          "One queue in this policy, so tc cannot tell the cameras apart — use the "
          + "per-camera numbers above. Loss in the modem or radio is not visible here at all." }));
      }
    }

    function paintChart() {
      clear(chartBody);
      const names = Object.keys(series);
      if (!names.length) {
        chartBody.appendChild(h("p", { class: "muted", text: "Collecting — two samples needed." }));
        return;
      }
      const p = palette();
      chartBody.appendChild(charts.timeSeries(names.map((n) => series[n]), {
        h: 180, colors: names.map((_, i) => p.series[i % p.series.length]), gapMs: 5000, fill: false,
      }));
      chartBody.appendChild(h("p", { class: "hint" }, ...names.map((n, i) => {
        const last = series[n][series[n].length - 1];
        return h("span", { style: { color: p.series[i % p.series.length], "font-weight": "700",
                                    "margin-right": "16px" },
                           text: `■ ${n} ${last ? last.v.toFixed(2) : "–"} Mbit/s` });
      })));
    }

    async function poll() {
      try {
        const c = await view.api.bearer.counters({ signal: view.signal });
        paintLive(c);
        paintChart();
        prev = c;
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(liveBody);
          liveBody.appendChild(h("p", { class: "muted", text: `counters unavailable: ${err.message}` }));
        }
      }
    }

    await Promise.all([paintSetup(), paintRig(), paintCameras(), paintQueue(), paintAutorate()]);
    view.interval(() => { if (!fixing) paintSetup(); }, 4000);
    view.interval(paintAutorate, 2000);
    view.interval(paintRig, 10000);
    await poll();
    view.interval(poll, POLL_MS);
  },
});
