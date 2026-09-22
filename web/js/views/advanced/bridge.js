/**
 * TSN Bridge — the UE doing what a managed switch would.
 *
 * Three things this view exists to make visible, because each is a place the
 * configuration can look right and do nothing:
 *
 *   The gate needs one TX queue per traffic class. wwan0 has one and the driver
 *   refuses more, so the gate lives on a veth. The queue count is shown next to
 *   the device rather than left to be discovered when `tc` refuses.
 *
 *   Converting a three-class switch profile to two classes orphans a window.
 *   The fold picker shows the resolved gate list changing as you choose, so the
 *   decision is made with the consequence in front of you.
 *
 *   A deep queue on the modem absorbs the schedule and makes a perfect gate
 *   measure nothing. The modem's queue depth is part of the status, not a
 *   footnote.
 */

import { ApiError } from "../../core/api.js";
import { defineView } from "../../core/component.js";
import { confirm, drawer, toast } from "../../core/dialog.js";
import { clear, h } from "../../core/dom.js";
import { nn, ns } from "../../core/format.js";
import { palette } from "../../ui/tokens.js";
import { badge, btnRow, button, card, field, kpi, row, select, table } from "../../ui/widgets.js";

const FOLD_HELP = {
  shared: "the orphaned window opens for every class",
  priority: "the top class inherits it",
  closed: "it stays shut, and that much of the cycle is idle",
};

export default defineView({
  name: "bridge",

  async mount(view) {
    const overviewBody = h("div");
    const classBody = h("div");
    const gateBody = h("div");
    const ruleBody = h("div");
    const logPane = h("div", { class: "log logpane", style: { "max-height": "180px" } });
    const logWrap = h("details", { class: "raw-output" },
      h("summary", { class: "hint", text: "Job output" }), logPane);

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col5" },
        h("div", { class: "card-head" },
          h("h3", { text: "Bridge" }),
          h("span", { class: "hint", text: "classify, gate, tag" })),
        overviewBody, logWrap),
      h("section", { class: "card col7" },
        h("div", { class: "card-head" },
          h("h3", { text: "Gate schedule" }),
          h("span", { class: "hint", text: "802.1Qbv, in software" })),
        gateBody),
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "Traffic classes" }),
          h("span", { class: "hint", text: "one data path each" })),
        classBody),
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "Classification" }),
          h("span", { class: "hint", text: "which stream becomes which priority" })),
        ruleBody)));

    let state = null;
    let profiles = [];
    let fold = "shared";

    function echo(line, cls = "") {
      logPane.appendChild(h("div", { class: `logline ${cls}`, text: line }));
      logPane.scrollTop = logPane.scrollHeight;
    }

    // ---- overview -----------------------------------------------------------
    function paintOverview(s) {
      clear(overviewBody);
      const built = (s.classes || []).filter((c) => c.up).length;
      const total = (s.classes || []).length;

      overviewBody.appendChild(h("div", { class: "state-hero" },
        h("span", { class: `state-dot ${built ? "ok" : "idle"}` }),
        h("div", null,
          h("div", { class: "big-state",
                     text: built ? `${built} of ${total} built` : "Not built" }),
          h("div", { class: "mono state-addr",
                     text: s.local_ip || "no bearer address" }))));

      overviewBody.appendChild(h("div", { class: "kpis" },
        kpi("Underlay", s.underlay),
        kpi("Inner MTU", s.inner_mtu),
        kpi("Fold", s.fold)));

      const details = h("div", { class: "detail-list" });
      details.appendChild(row("Bearer MTU", s.bearer_mtu));
      details.appendChild(row("Core", s.remote_ip, { mono: true }));
      // The number that decides whether a gate can exist on the modem at all.
      details.appendChild(row("Modem TX queues",
        badge(String(s.modem_tx_queues ?? "?"),
              (s.modem_tx_queues || 0) > 1 ? "green" : "amber")));
      overviewBody.appendChild(details);

      if ((s.modem_tx_queues || 0) < 2) {
        overviewBody.appendChild(h("p", { class: "hint" },
          `${s.underlay} has a single TX queue, so a gate schedule cannot be `
          + "expressed on it — taprio needs one queue per traffic class. The "
          + "gate goes on a veth instead, which is why each class has one."));
      }
      if (!s.enabled) {
        overviewBody.appendChild(h("p", { class: "section-hint" },
          "Disabled in the configuration. Building still works from here; the "
          + "flag only governs whether it comes up on its own."));
      }

      overviewBody.appendChild(btnRow(
        button(built ? "Rebuild" : "Build", {
          kind: "primary",
          onclick: () => runJob(() => view.api.bridge.build({}, { signal: view.signal }),
                                "build the data path"),
        }),
        button("Preview", {
          onclick: async () => {
            try {
              const r = await view.api.bridge.build({ dry_run: true },
                                                    { signal: view.signal });
              drawer("Devices that would be created",
                     h("pre", { class: "log", text: JSON.stringify(r, null, 2) }));
            } catch (err) { toast(err.message, "err"); }
          },
        }),
        button("Tear down", {
          kind: "danger", disabled: !built,
          onclick: async () => {
            const ok = await confirm({
              title: "Remove the bridge data path?",
              body: "Deletes the veth, tunnel, tag and bridge for every class. "
                  + "The bearer is untouched and the modem stays attached.",
              confirmLabel: "Remove", danger: true,
            });
            if (!ok) return;
            runJob(() => view.api.bridge.teardown({}, { signal: view.signal }),
                   "tear down");
          },
        })));
    }

    // ---- classes ------------------------------------------------------------
    function paintClasses(s) {
      clear(classBody);
      const list = s.classes || [];
      if (!list.length) {
        classBody.appendChild(h("p", { class: "muted" },
          "No classes configured. Add them under `tsnbridge.classes` in the "
          + "config — each one becomes its own data path."));
        return;
      }
      classBody.appendChild(table(
        ["Class", "VLAN", "VNI", "UDP port", "Map", "Gate device", "Queues",
         "Gate", "State"],
        list.map((c) => {
          const g = c.gate || {};
          return [
            h("span", { class: "cell-name", text: c.name }),
            c.vlan, c.vni, c.dstport,
            c.egress_map,
            h("span", { class: "mono", text: c.gate_device }),
            // Fewer queues than classes and the schedule is unexpressible.
            badge(String(g.tx_queues ?? "—"),
                  (g.tx_queues || 0) > 1 ? "green" : "gray"),
            g.gate_active
              ? badge(c.gate_profile || "active", "blue")
              : badge("none", "gray"),
            badge(c.up ? "up" : "down", c.up ? "green" : "gray"),
          ];
        })));

      const down = list.filter((c) => !c.up);
      if (down.length) {
        classBody.appendChild(h("p", { class: "hint",
          text: `${down.map((c) => c.name).join(", ")} not built yet — the `
              + "devices are named above so you can see which are missing." }));
      }
    }

    // ---- gate ---------------------------------------------------------------
    function paintGate(s) {
      clear(gateBody);
      const built = (s.classes || []).filter((c) => c.up);
      if (!built.length) {
        gateBody.appendChild(h("p", { class: "muted" },
          "Build a data path first — the gate goes on its veth, which does not "
          + "exist yet."));
        return;
      }

      const clsSel = select(built.map((c) => ({ value: c.name, label: c.name })),
                            built[0].name, () => {}, { class: "mini-select" });
      const profSel = select(profiles.map((p) => ({ value: p.name, label: p.name })),
                             profiles[0]?.name, () => paintWindows(),
                             { class: "mini-select" });
      const foldSel = select(["shared", "priority", "closed"], fold,
                             (v) => { fold = v; reloadProfiles(); },
                             { class: "mini-select" });

      gateBody.appendChild(h("div", { class: "kpis" },
        field("Class", clsSel),
        field("Profile", profSel),
        field("Orphaned window", foldSel, FOLD_HELP[fold])));

      const windows = h("div");
      gateBody.appendChild(windows);

      function paintWindows() {
        clear(windows);
        const p = profiles.find((x) => x.name === profSel.value);
        if (!p) return;
        windows.appendChild(h("p", { class: "hint", text: p.description }));

        // The resolved schedule, so the fold's effect is visible before applying.
        const pal = palette();
        const total = p.cycle_ns || 1;
        const strip = h("div", { class: "gate-strip" });
        for (const e of p.taprio_entries) {
          const pct = (e.interval_ns / total) * 100;
          const open = e.gate_mask;
          strip.appendChild(h("i", {
            class: "gate-slot",
            style: {
              width: `${pct}%`,
              background: open === 0 ? "var(--line-strong)"
                : open === 1 ? pal.classes.be_video
                : open === 2 ? pal.classes.control
                : pal.classes.hp_video,
            },
            title: `mask 0x${open.toString(16).padStart(2, "0")} — ${e.interval_ns} ns`,
          }));
        }
        windows.appendChild(strip);
        windows.appendChild(table(["Window", "Gate", "Opens for", "Duration"],
          p.taprio_entries.map((e, i) => [
            i + 1,
            h("span", { class: "mono",
                        text: `0x${e.gate_mask.toString(16).padStart(2, "0")}` }),
            e.gate_mask === 0 ? "nothing — guard"
              : e.gate_mask === 3 ? "both classes"
              : e.gate_mask === 2 ? "priority only" : "best effort only",
            ns(e.interval_ns),
          ])));
        windows.appendChild(h("p", { class: "hint",
          text: `cycle ${ns(p.cycle_ns)}, anchored at TAI ${p.base_sec}s`
              + (p.orphaned_ns
                 ? ` — ${ns(p.orphaned_ns)} belonged to a class this bridge does `
                   + `not have, and is ${FOLD_HELP[p.fold] || p.fold}`
                 : "") }));
      }
      paintWindows();

      gateBody.appendChild(btnRow(
        button("Apply gate", {
          kind: "primary",
          onclick: async () => {
            try {
              await view.api.bridge.gate(
                { name: clsSel.value, profile: profSel.value, fold },
                { signal: view.signal });
              toast(`${profSel.value} applied to ${clsSel.value}`, "ok");
              refresh();
            } catch (err) {
              if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
            }
          },
        }),
        button("Preview tc", {
          onclick: async () => {
            try {
              const r = await view.api.bridge.gate(
                { name: clsSel.value, profile: profSel.value, fold, dry_run: true },
                { signal: view.signal });
              drawer("Generated command",
                     h("pre", { class: "log", text: r.command || JSON.stringify(r, null, 2) }));
            } catch (err) { toast(err.message, "err"); }
          },
        }),
        button("Clear", {
          kind: "danger",
          onclick: async () => {
            try {
              await view.api.bridge.clearGate({ name: clsSel.value },
                                              { signal: view.signal });
              toast("gate cleared", "ok");
              refresh();
            } catch (err) { toast(err.message, "err"); }
          },
        })));

      gateBody.appendChild(h("p", { class: "hint" },
        "The gate decides which class leaves the veth and when. It does not "
        + "decide when the radio transmits — that is the scheduler's, and no "
        + "shaping here reaches it."));
    }

    // ---- classification -----------------------------------------------------
    function paintRules(s) {
      clear(ruleBody);
      const inputs = {
        dport: h("input", { type: "number", class: "mini-input",
                            placeholder: "50451" }),
        prio: h("input", { type: "number", class: "mini-input", value: "7",
                           min: "0", max: "7" }),
      };
      const proto = select(["udp", "tcp"], "udp", () => {}, { class: "mini-select" });

      ruleBody.appendChild(h("p", { class: "section-hint" },
        "Marking happens on the way out, not on the camera port. The camera "
        + "application consumes the inbound frames and emits new packets, so an "
        + "ingress rule would mark traffic that is then thrown away."));

      ruleBody.appendChild(h("div", { class: "kpis" },
        field("Protocol", proto),
        field("Destination port", inputs.dport, "the stream's port"),
        field("Priority", inputs.prio, "0-7; becomes the PCP")));

      ruleBody.appendChild(btnRow(
        button("Add rule", {
          kind: "primary",
          onclick: async () => {
            const dport = Number(inputs.dport.value);
            if (!dport) { toast("a destination port is required", "err"); return; }
            try {
              await view.api.bridge.addRule(
                { proto: proto.value, dport, priority: Number(inputs.prio.value) },
                { signal: view.signal });
              toast(`udp/${dport} → priority ${inputs.prio.value}`, "ok");
              refresh();
            } catch (err) {
              if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
            }
          },
        })));

      const live = s.rules || [];
      ruleBody.appendChild(h("div", { class: "kpi-label",
                                      style: { "margin-top": "14px" },
                                      text: "Live rules" }));
      if (!live.length) {
        ruleBody.appendChild(h("p", { class: "muted" },
          "None. Without a rule every stream leaves at priority 0 and the gate "
          + "puts them all in the same class."));
      } else {
        ruleBody.appendChild(h("pre", { class: "log",
          style: { "max-height": "140px" }, text: live.join("\n") }));
      }
    }

    // ---- jobs ---------------------------------------------------------------
    async function runJob(starter, label) {
      clear(logPane);
      logWrap.open = true;
      echo(`> ${label}`, "lvl-info");
      try {
        const res = await starter();
        if (!res.job_id) { refresh(); return; }
        let seen = 0;
        for (let i = 0; i < 120; i += 1) {
          await new Promise((r) => view.timeout(r, 600));
          const job = await view.api.jobs.get(res.job_id, { signal: view.signal });
          for (const line of (job.lines || []).slice(seen)) echo(`  ${line}`);
          seen = (job.lines || []).length;
          if (!["queued", "running"].includes(job.state)) {
            if (job.error) { echo(`  ${job.error}`, "lvl-error"); toast(job.error, "err"); }
            else toast(`${label} done`, "ok");
            refresh();
            return;
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        echo(`  ${err.message}`, "lvl-error");
        toast(err.message, "err");
      }
    }

    // ---- data ---------------------------------------------------------------
    async function reloadProfiles() {
      try {
        const r = await view.api.bridge.profiles({ fold }, { signal: view.signal });
        profiles = r.profiles || [];
        if (state) paintGate(state);
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
    }

    async function refresh() {
      try {
        state = await view.api.bridge.get({ signal: view.signal });
        fold = state.fold || fold;
        paintOverview(state);
        paintClasses(state);
        paintGate(state);
        paintRules(state);
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(overviewBody);
        overviewBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
    }

    await reloadProfiles();
    await refresh();
    view.interval(refresh, 10000);
  },
});
