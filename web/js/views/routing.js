/**
 * Routing — send one application's traffic over 5G, and nothing else.
 *
 * Automates HANDOVER_5G_CAMERA.md A4/A5. The Verify panel is the important
 * part: it runs the same three `ip route get` probes the document tells you to
 * run by hand, and shows them side by side. The document's advice is "if this
 * says wwan0, STOP" — here the daemon stops for you and rolls back, because by
 * the time a human reads that warning the session is already gone.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { confirm, toast } from "../core/dialog.js";
import { clear, h } from "../core/dom.js";
import { badge, btnRow, button, card, field, row, select, table } from "../ui/widgets.js";

export default defineView({
  name: "routing",

  async mount(view) {
    const stateBody = h("div");
    const formBody = h("div");
    const verifyBody = h("div");
    const liveBody = h("div");

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col6" },
        h("div", { class: "card-head" }, h("h3", { text: "Applied profile" })),
        stateBody),
      h("section", { class: "card col6" },
        h("div", { class: "card-head" },
          h("h3", { text: "Verify" }),
          h("span", { class: "hint", text: "ip route get, before you trust it" })),
        verifyBody),
      h("section", { class: "card col6" },
        h("div", { class: "card-head" }, h("h3", { text: "Configure" })),
        h("p", { class: "section-hint" },
          "Marks one destination port, looks it up in a separate table, and "
          + "sends that table over the modem. Everything else keeps using the "
          + "wired path."),
        formBody),
      h("section", { class: "card col6" },
        h("div", { class: "card-head" },
          h("h3", { text: "Live kernel state" }),
          h("span", { class: "hint", text: "read from the kernel, not our record" })),
        liveBody)));

    // ---- form -------------------------------------------------------------
    const inputs = {};
    function buildForm(profiles, applied) {
      clear(formBody);
      const spec = applied || profiles[0] || {};

      inputs.proto = select(["udp", "tcp"], spec.proto || "udp", () => {},
                            { class: "mini-select" });
      inputs.dport = h("input", { type: "number", class: "mini-input",
                                  value: String(spec.dport ?? 50451),
                                  min: "1", max: "65535" });
      inputs.dev = h("input", { type: "text", class: "mini-input",
                                value: spec.dev || "wwan0" });
      inputs.mark = h("input", { type: "text", class: "mini-input",
                                 value: spec.mark || "0x5" });
      inputs.table = h("input", { type: "number", class: "mini-input",
                                  value: String(spec.table ?? 5), min: "1", max: "252" });
      // Prefill from config so the Verify panel is useful on arrival rather
      // than only after the operator has typed something.
      const coreIp = view.store.get().config?.vxlan?.core_ip;
      inputs.verifyDst = h("input", { type: "text", class: "mini-input",
                                      value: spec.verify_dst || coreIp || "",
                                      placeholder: "10.5.0.219" });
      inputs.masq = h("input", { type: "checkbox" });
      inputs.masq.checked = spec.masquerade !== false;

      formBody.appendChild(h("div", { class: "kpis" },
        field("Protocol", inputs.proto),
        field("Destination port", inputs.dport),
        field("Egress interface", inputs.dev),
        field("Firewall mark", inputs.mark)));
      formBody.appendChild(h("div", { class: "kpis" },
        field("Routing table", inputs.table),
        field("Verify against", inputs.verifyDst, "an address the app talks to")));
      formBody.appendChild(h("label", { class: "inline-fld" },
        inputs.masq, "Masquerade (recommended)"));
      formBody.appendChild(h("p", { class: "hint" },
        "Masquerade rather than SNAT: the UE address changes on every data "
        + "call, so a pinned source address goes stale the moment the bearer "
        + "cycles."));
      formBody.appendChild(btnRow(
        button("Apply", { kind: "primary", onclick: apply }),
        button("Verify only", { onclick: () => runVerify(true) }),
        button("Clear", { kind: "danger", onclick: clearProfile })));
    }

    function readSpec() {
      return {
        name: "custom",
        proto: inputs.proto.value,
        dport: Number(inputs.dport.value),
        dev: inputs.dev.value.trim(),
        mark: inputs.mark.value.trim(),
        table: Number(inputs.table.value),
        masquerade: inputs.masq.checked,
        verify_dst: inputs.verifyDst.value.trim() || undefined,
      };
    }

    // ---- actions ----------------------------------------------------------
    async function apply() {
      const spec = readSpec();
      const ok = await confirm({
        title: "Apply this routing profile?",
        body: `${spec.proto.toUpperCase()}/${spec.dport} will be marked `
            + `${spec.mark}, looked up in table ${spec.table}, and sent out `
            + `${spec.dev}. Everything else is unaffected.\n\n`
            + "The daemon checks the route to your management peer before and "
            + "after, and rolls the whole change back if it moved.",
        confirmLabel: "Apply",
      });
      if (!ok) return;
      try {
        const res = await view.api.routing.apply(spec, { signal: view.signal });
        toast("applying…", "ok");
        await follow(res.job_id);
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
      refresh();
    }

    async function clearProfile() {
      const ok = await confirm({
        title: "Remove the routing rules?",
        body: "Traffic that was going over 5G returns to the wired path. Only "
            + "the rules this daemon added are removed — nothing else in the "
            + "firewall is touched.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await view.api.routing.clear({ confirm: true },
                                                 { signal: view.signal });
        await follow(res.job_id);
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
      refresh();
    }

    async function follow(jobId) {
      if (!jobId) return;
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => view.timeout(r, 500));
        let job;
        try {
          job = await view.api.jobs.get(jobId, { signal: view.signal });
        } catch (err) {
          if (err instanceof ApiError && err.isAborted) return;
          continue;
        }
        if (!["queued", "running"].includes(job.state)) {
          if (job.state === "succeeded") toast("routing applied", "ok");
          else toast(job.error || `job ${job.state}`, "err");
          return;
        }
      }
    }

    // ---- verify ------------------------------------------------------------
    async function runVerify(explicit = false) {
      clear(verifyBody);
      verifyBody.appendChild(h("div", { class: "skeleton-wrap" },
        h("div", { class: "skeleton-row" }), h("div", { class: "skeleton-row" })));
      try {
        const body = {};
        const dst = inputs.verifyDst?.value?.trim();
        if (dst) body.verify_dst = dst;
        const res = await view.api.routing.verify(body, { signal: view.signal });
        paintVerify(res);
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(verifyBody);
        verifyBody.appendChild(h("p", { class: "muted" },
          err.status === 400
            ? "Nothing applied yet, and no address given to check against."
            : err.message));
      }
    }

    function paintVerify(res) {
      clear(verifyBody);
      const labels = {
        management: "Management peer",
        stream_unmarked: "App traffic, unmarked",
        stream_marked: "App traffic, marked",
      };
      const expect = {
        management: "must stay on the wired interface",
        stream_unmarked: "must NOT be the modem",
        stream_marked: "should be the modem",
      };
      const rows = Object.entries(res.checks || {}).map(([k, c]) => [
        labels[k] || k,
        h("span", { class: "mono", text: c.dst + (c.mark ? ` mark ${c.mark}` : "") }),
        c.dev ? badge(c.dev, c.dev.startsWith("wwan") ? "blue" : "gray") : "—",
        h("span", { class: "mono", text: c.src || "—" }),
        h("span", { class: "hint", text: expect[k] || "" }),
      ]);
      verifyBody.appendChild(table(["Check", "Destination", "Goes out", "Source", ""], rows));

      if (res.warnings?.length) {
        for (const w of res.warnings) {
          verifyBody.appendChild(h("p", { class: "section-hint",
            style: { color: "var(--red)", "font-weight": "600" }, text: w }));
        }
      } else {
        verifyBody.appendChild(h("p", { class: "hint" },
          `Management peer ${res.management_peer || "unknown"} is unaffected.`));
      }
    }

    // ---- state -------------------------------------------------------------
    function paintState(st) {
      clear(stateBody);
      stateBody.appendChild(row("Status", st.applied
        ? badge("applied", "green") : badge("not applied", "gray")));
      if (st.spec) {
        const s = st.spec;
        stateBody.appendChild(row("Match",
          `${s.proto?.toUpperCase()}/${s.dport}`, { mono: true }));
        stateBody.appendChild(row("Mark → table", `${s.mark} → ${s.table}`,
                                  { mono: true }));
        stateBody.appendChild(row("Egress", s.dev, { mono: true }));
        stateBody.appendChild(row("Masquerade", s.masquerade === false ? "no" : "yes"));
      }
      if (st.rules?.length) {
        stateBody.appendChild(h("p", { class: "hint",
          text: `${st.rules.length} rule(s) recorded, and only these are removed `
              + "on clear — the firewall is never flushed." }));
      }
    }

    function paintLive(live) {
      clear(liveBody);
      const pre = (title, lines) => {
        liveBody.appendChild(h("div", { class: "kpi-label", text: title }));
        liveBody.appendChild(h("pre", { class: "log",
          style: { "max-height": "130px" },
          text: (lines && lines.length) ? lines.join("\n") : "(none)" }));
      };
      pre("ip rule", live.ip_rule);
      pre("mangle OUTPUT (marking)", live.mangle_output);
      pre("nat POSTROUTING", live.nat_postrouting);
      for (const [t, routes] of Object.entries(live.tables || {})) {
        pre(`table ${t}`, routes);
      }

      // A rule pointing at an empty table is the failure that looks like
      // success: `ip rule` and the mangle marks are all present, so the setup
      // reads as applied, but the lookup finds nothing and the packet falls
      // through to main and leaves over ethernet. Nothing errors.
      const referenced = (live.ip_rule || [])
        .map((r) => /lookup\s+(\S+)/.exec(r)?.[1])
        .filter((t) => t && !["local", "main", "default"].includes(t));
      const hollow = referenced.filter(
        (t) => !((live.tables || {})[t] || []).length);
      if (hollow.length) {
        liveBody.appendChild(h("p", { class: "section-hint",
          style: { color: "var(--amber)", "font-weight": "600" } },
          `Rules send marked traffic to table ${hollow.join(", ")}, which is `
          + "empty. The lookup finds no route, so the packet falls through to "
          + "the main table and leaves over ethernet — silently, with the "
          + "marks and rules all still looking correct. Apply a profile to "
          + "populate it."));
      }
    }

    // ---- data ---------------------------------------------------------------
    async function refresh() {
      try {
        const st = await view.api.routing.get({ signal: view.signal });
        paintState(st);
        if (!inputs.proto) buildForm(st.profiles || [], st.spec);
        paintLive(st.live || {});
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(stateBody);
        stateBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
    }

    await refresh();
    // refresh() builds the form, which is where verifyDst comes from.
    await runVerify();
    view.interval(refresh, 8000);
  },
});
