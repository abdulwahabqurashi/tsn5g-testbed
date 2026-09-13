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
import { badge, btnRow, button, card, field, row, table } from "../ui/widgets.js";

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
        logPane)));

    let activeJob = null;

    // ---- painters ---------------------------------------------------------
    function paintState(b) {
      clear(stateBody);
      const up = b.state === "up";
      stateBody.appendChild(row("State", badge(b.state || "unknown",
                                               up ? "green" : "gray")));
      stateBody.appendChild(row("UE address", b.ipv4, { mono: true }));
      stateBody.appendChild(row("Gateway", b.gateway, { mono: true }));
      stateBody.appendChild(row("MTU", b.mtu));
      stateBody.appendChild(row("APN", b.apn, { mono: true }));
      stateBody.appendChild(row("QMI handle",
        b.pdh ? `${b.pdh} / cid ${b.cid ?? "—"}` : null, { mono: true }));
      if (b.routes?.length) {
        stateBody.appendChild(h("div", { class: "kpi-label",
          style: { "margin-top": "10px" }, text: "Routes" }));
        stateBody.appendChild(h("pre", { class: "log",
          style: { "max-height": "90px" }, text: b.routes.join("\n") }));
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

    function paintSteps(job) {
      clear(stepsBody);
      const steps = job?.steps || [];
      if (!steps.length) {
        stepsBody.appendChild(h("p", { class: "muted" },
          "No run yet. Progress appears here as each step completes."));
        return;
      }
      const marks = { succeeded: "✓", running: "…", failed: "✕", pending: "" };
      stepsBody.appendChild(h("div", { class: "stepper" },
        ...steps.map((s, i) => h("div", { class: `step ${s.state}` },
          h("span", { class: "bullet", text: marks[s.state] ?? String(i + 1) }),
          h("span", null,
            h("div", { text: STEP_LABELS[s.name] || s.name }),
            h("div", { class: "hint", text: s.detail || STEP_HINTS[s.name] || "" }))))));
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
        clear(stateBody);
        stateBody.appendChild(h("p", { class: "muted", text: err.message }));
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

    await refresh();
    view.interval(refresh, 6000);
  },
});
