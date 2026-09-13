/**
 * Connection — bring the 5G data call up and down, with live per-step progress.
 *
 * Replaces the Guided Setup view, which tracked its own progress in
 * client-side booleans: reloading the page lost it, and a session established
 * from another browser was invisible. Progress comes from the job now, so it
 * is the same for everyone looking.
 *
 * This drives `bearer.up` — six steps transcribed from ue_qmi_up.sh — rather
 * than the legacy `bearer.connect`, which also rebuilds the VXLAN overlay and
 * used the /30 addressing form that left the core reachable only over
 * ethernet.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { confirm, toast } from "../core/dialog.js";
import { clear, h } from "../core/dom.js";
import { ago, ms, nn } from "../core/format.js";
import { badge, btnRow, button, card, field, kpi, row, table } from "../ui/widgets.js";

const STEP_LABELS = {
  preflight: "Pre-flight",
  "prepare-iface": "Prepare interface",
  "start-network": "Start data call",
  "read-settings": "Read assigned settings",
  "configure-iface": "Apply address and routes",
  verify: "Verify data plane",
  "stop-network": "Stop data call",
  "clear-iface": "Clear interface",
};

const STEP_HINTS = {
  preflight: "radio online, UE registered",
  "prepare-iface": "raw-IP mode, which must be set while the link is down",
  "start-network": "qmicli --wds-start-network, keeping the client id",
  "read-settings": "DHCP does not work on a raw-IP link; QMI is asked instead",
  "configure-iface": "/32 plus explicit gateway and UE-pool routes",
  verify: "ping the core, not just the point-to-point gateway",
};

export default defineView({
  name: "connection",

  async mount(view) {
    const stateBody = h("div");
    const stepsBody = h("div");
    const logPane = h("div", { class: "log logpane", style: { "max-height": "260px" } });
    // The stepper above is the status; this is the transcript behind it.
    const logWrap = h("details", { class: "raw-output" },
      h("summary", { class: "hint", text: "Step output" }), logPane);
    const actions = h("div", { class: "btn-row" });

    const apnInput = h("input", { type: "text", class: "mini-input",
                                  placeholder: "usrptsn" });

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col5" },
        h("div", { class: "card-head" }, h("h3", { text: "Bearer" })),
        stateBody,
        h("div", { class: "kpis", style: { "margin-top": "12px" } },
          field("APN / DNN", apnInput, "blank uses the configured value")),
        actions),
      h("section", { class: "card col7" },
        h("div", { class: "card-head" },
          h("h3", { text: "Progress" }),
          h("span", { class: "hint", text: "six steps, from ue_qmi_up.sh" })),
        stepsBody,
        logWrap)));

    let activeJob = null;

    // ---- painters ---------------------------------------------------------
    function paintState(b) {
      clear(stateBody);
      const up = b.state === "up";

      // Lead with the two things being asked: is it up, and on what address.
      // This was a flat list of eight label/value rows in which the state and
      // the UE address carried no more weight than the MTU.
      stateBody.appendChild(h("div", { class: "state-hero" },
        h("span", { class: `state-dot ${up ? "ok" : "idle"}` }),
        h("div", null,
          h("div", { class: "big-state",
                     text: up ? "Connected" : (b.state || "unknown") }),
          h("div", { class: "mono state-addr", text: b.ipv4 || "no address" }))));

      stateBody.appendChild(h("div", { class: "kpis" },
        kpi("APN", b.apn),
        kpi("MTU", b.mtu),
        kpi("Carrier", b.carrier)));

      const details = h("div", { class: "detail-list" });
      details.appendChild(row("Gateway", b.gateway, { mono: true }));
      details.appendChild(row("DNS", (b.dns || []).join(", ") || null,
                              { mono: true }));
      details.appendChild(row("QMI handle",
        b.pdh ? `${b.pdh} / cid ${b.cid ?? "—"}` : null, { mono: true }));
      stateBody.appendChild(details);

      // Without a handle the call can only be abandoned, not stopped: the
      // interface gets flushed while the session stays alive in the modem.
      if (up && !b.pdh) {
        stateBody.appendChild(h("p", { class: "section-hint",
          style: { color: "var(--amber)" } },
          "No QMI handle is recorded for this call, so it cannot be stopped "
          + "cleanly — only abandoned. Restart the call to take ownership of "
          + "it."));
      }
      if (b.routes?.length) {
        stateBody.appendChild(h("details", { class: "raw-output" },
          h("summary", { class: "hint",
                         text: `Routes on ${b.interface || "the bearer"}` }),
          h("pre", { class: "log", style: { "max-height": "90px" },
                     text: b.routes.join("\n") })));
      }
      if (!up) {
        stateBody.appendChild(h("p", { class: "hint" },
          "The modem stays camped on the cell without a data call — bringing "
          + "the bearer up starts the PDU session and configures the interface."));
      }
      paintActions(up);
    }

    function paintActions(up) {
      clear(actions);
      actions.appendChild(button(up ? "Restart call" : "Bring up", {
        kind: "primary", onclick: up ? cycle : bringUp,
        disabled: Boolean(activeJob),
      }));
      actions.appendChild(button("Take down", {
        kind: "danger", onclick: takeDown, disabled: !up || Boolean(activeJob),
      }));
      if (activeJob) {
        actions.appendChild(button("Cancel", { onclick: cancel }));
      }
    }

    // The step states the job reports, mapped to the classes the stylesheet
    // knows. These disagreed — the job says "succeeded" and the CSS styled
    // ".done" — so every step rendered grey however it had actually gone, and
    // there was no way to tell finished from pending from failed.
    const STEP_CLASS = {
      succeeded: "done", running: "active", failed: "err",
      cancelled: "err", pending: "pending",
    };

    function stepDuration(s) {
      if (!s.started) return null;
      const end = s.finished || (s.state === "running" ? Date.now() / 1000 : null);
      if (!end) return null;
      const d = end - s.started;
      if (d < 1) return `${Math.round(d * 1000)} ms`;
      return `${d.toFixed(1)} s`;
    }

    function paintSteps(job) {
      if (job?.state === "failed") logWrap.open = true;
      clear(stepsBody);
      const steps = job?.steps || [];
      if (!steps.length) {
        stepsBody.appendChild(h("p", { class: "muted" },
          "No run yet. Progress appears here as each step completes."));
        return;
      }

      const done = steps.filter((s) => s.state === "succeeded").length;
      const failed = steps.some((s) => s.state === "failed");
      const current = steps.find((s) => s.state === "running");
      const pct = job?.progress?.pct ?? Math.round((done / steps.length) * 100);

      // A heading that answers "where is it now" without reading six rows.
      stepsBody.appendChild(h("div", { class: "run-head" },
        h("span", { class: `run-state ${failed ? "err" : current ? "active" : "done"}` },
          failed ? "Failed" : current
            ? (STEP_LABELS[current.name] || current.name)
            : "Complete"),
        h("span", { class: "run-count", text: `${done} of ${steps.length}` })));

      const bar = h("div", { class: `run-bar ${failed ? "err" : current ? "active" : "done"}` },
        h("i", { style: { width: `${Math.max(0, Math.min(100, pct))}%` } }));
      stepsBody.appendChild(bar);

      stepsBody.appendChild(h("ol", { class: "stepper" },
        ...steps.map((s, i) => {
          const cls = STEP_CLASS[s.state] || "pending";
          const dur = stepDuration(s);
          return h("li", { class: `step ${cls}` },
            h("span", { class: "bullet", "aria-hidden": "true" },
              cls === "done" ? "✓" : cls === "err" ? "✕"
                : cls === "active" ? "" : String(i + 1)),
            h("span", { class: "step-body" },
              h("div", { class: "step-name",
                         text: STEP_LABELS[s.name] || s.name }),
              h("div", { class: "hint",
                         text: s.detail || STEP_HINTS[s.name] || "" })),
            h("span", { class: "step-time", text: dur || "" }));
        })));
    }

    function appendLines(lines, from) {
      for (const line of lines.slice(from)) {
        logPane.appendChild(h("div", { class: "logline", text: line }));
      }
      logPane.scrollTop = logPane.scrollHeight;
    }

    // ---- actions ----------------------------------------------------------
    async function bringUp() {
      clear(logPane);
      const body = {};
      if (apnInput.value.trim()) body.apn = apnInput.value.trim();
      await run(() => view.api.bearer.up(body, { signal: view.signal }), "bringing up");
    }

    async function takeDown() {
      const ok = await confirm({
        title: "Take the bearer down?",
        body: "The 5G data call stops and the interface is cleared. Anything "
            + "using the link loses it, and the next call will get a different "
            + "address — so policy routing pinned to this one goes stale.",
        confirmLabel: "Take down",
        danger: true,
      });
      if (!ok) return;
      clear(logPane);
      await run(() => view.api.bearer.down({ confirm: true }, { signal: view.signal }),
                "taking down");
    }

    async function cycle() {
      const ok = await confirm({
        title: "Restart the data call?",
        body: "Stops and restarts it. The UE address will almost certainly "
            + "change — the network hands out a new one each time — and any "
            + "routing profile is re-applied automatically afterwards.",
        confirmLabel: "Restart",
        danger: true,
      });
      if (!ok) return;
      clear(logPane);
      const body = { confirm: true };
      if (apnInput.value.trim()) body.apn = apnInput.value.trim();
      await run(() => view.api.bearer.cycle(body, { signal: view.signal }), "restarting");
    }

    async function cancel() {
      if (!activeJob) return;
      try {
        await view.api.jobs.cancel(activeJob, { signal: view.signal });
        toast("cancel requested");
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
    }

    async function run(starter, label) {
      try {
        const res = await starter();
        activeJob = res.job_id;
        paintActions(false);
        toast(`${label}…`);
        await follow(res.job_id);
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        if (err.status === 409) {
          toast(`another ${err.data?.lane || ""} operation is already running`, "err");
        } else if (err.status === 428) {
          toast(err.data?.explain || err.message, "err");
        } else {
          toast(err.message, "err");
        }
      } finally {
        activeJob = null;
        refresh();
      }
    }

    async function follow(jobId) {
      let seen = 0;
      for (let i = 0; i < 180; i += 1) {
        await new Promise((r) => view.timeout(r, 500));
        let job;
        try {
          job = await view.api.jobs.get(jobId, { signal: view.signal });
        } catch (err) {
          if (err instanceof ApiError && err.isAborted) return;
          continue;
        }
        paintSteps(job);
        const lines = job.lines || [];
        if (lines.length > seen) { appendLines(lines, seen); seen = lines.length; }
        if (!["queued", "running"].includes(job.state)) {
          if (job.state === "succeeded") {
            const r = job.result || {};
            toast(r.ipv4 ? `bearer up on ${r.ipv4}` : "done", "ok");
          } else {
            toast(job.error || `job ${job.state}`, "err");
          }
          return;
        }
      }
    }

    // ---- data --------------------------------------------------------------
    async function refresh() {
      try {
        paintState(await view.api.bearer.get({ signal: view.signal }));
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        // A bare "service unreachable" reads as a verdict about the bearer,
        // which it is not — it is this page failing to reach the daemon, and
        // it retries on its own. Say both, and offer the retry now.
        clear(stateBody);
        stateBody.appendChild(h("div", { class: "empty-state" },
          h("div", { class: "big-state", text: "Console offline" }),
          h("p", { class: "hint",
            text: `Cannot reach the daemon: ${err.message}. This says nothing `
                + "about the bearer — the data call lives in the modem and the "
                + "kernel, not in this page." }),
          btnRow(button("Retry now", { onclick: refresh }))));
      }
    }

    // A bearer job started from another browser should show here too.
    view.listen("job", (evt) => {
      if (evt.lane !== "bearer") return;
      if (!activeJob && ["queued", "running"].includes(evt.state)) {
        activeJob = evt.job_id;
        follow(evt.job_id);
      }
    });

    // Show the last bearer run when nothing is in flight. Without this the
    // panel reset to "No run yet" on every reload, so the result of the
    // connect you just watched was gone the moment you navigated away — and
    // a failed attempt left nothing to look at.
    async function showLastRun() {
      if (activeJob) return;
      try {
        const res = await view.api.jobs.list(
          { lane: "bearer", limit: 1 }, { signal: view.signal });
        const last = (res.jobs || [])[0];
        if (!last) return;
        if (["queued", "running"].includes(last.state)) {
          activeJob = last.id;
          follow(last.id);
          return;
        }
        const full = await view.api.jobs.get(last.id, { signal: view.signal });
        paintSteps(full);
        for (const line of full.lines || []) echo(`  ${line}`);
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          // Nothing to show is not an error worth a panel.
        }
      }
    }

    await refresh();
    await showLastRun();
    view.interval(refresh, 6000);
  },
});
