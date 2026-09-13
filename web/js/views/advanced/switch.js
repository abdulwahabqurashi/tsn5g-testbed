/**
 * TSN Switch — 802.1Qbv gate schedules on the FS TSN3220.
 *
 * Two things the old view got wrong:
 *
 * The status panel only ever populated in demo mode — `T.demo ? mock() : null`
 * — so on a real box it silently rendered an empty div. /api/switch/status
 * existed and was never called.
 *
 * The preset list was a hard-coded FALLBACK array duplicated byte-for-byte
 * between this view and the setup wizard. It comes from the backend now, which
 * is also where the switch and the DS-TT read it from, so all three agree.
 *
 * Credentials are held in memory for the session only and never stored.
 */

import { ApiError } from "../../core/api.js";
import { defineView } from "../../core/component.js";
import { confirm, drawer, toast } from "../../core/dialog.js";
import { clear, h } from "../../core/dom.js";
import { ns } from "../../core/format.js";
import * as charts from "../../ui/charts.js";
import { palette } from "../../ui/tokens.js";
import { badge, btnRow, button, card, field, row, select, table } from "../../ui/widgets.js";

export default defineView({
  name: "switch",

  async mount(view) {
    const formBody = h("div");
    const previewBody = h("div");
    const statusBody = h("div");

    // Host, user and ports come from the operator's config; only the password
    // is session-only. These were hard-coded to 192.168.1.1/admin/1-8, which
    // happened to match the config on this rig and would silently stop
    // matching the moment anyone edited it.
    const creds = { host: "", user: "", password: "", ports: "" };
    let profiles = [];
    let selected = null;

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col5" },
        h("div", { class: "card-head" }, h("h3", { text: "Switch" })),
        formBody),
      h("section", { class: "card col7" },
        h("div", { class: "card-head" },
          h("h3", { text: "Gate schedule" }),
          h("span", { class: "hint", text: "preview before applying" })),
        previewBody),
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "Live status" }),
          button("Read from switch", { onclick: readStatus })),
        statusBody)));

    // ---- form --------------------------------------------------------------
    const inputs = {};
    function buildForm() {
      clear(formBody);
      inputs.host = h("input", { type: "text", class: "mini-input",
                                 value: creds.host, placeholder: "switch.host in config" });
      inputs.user = h("input", { type: "text", class: "mini-input",
                                 value: creds.user, placeholder: "switch.user in config" });
      // Deliberately type=text: this console is often driven from a
      // touchscreen with no keyboard, where a masked field is unusable.
      inputs.password = h("input", { type: "text", class: "mini-input",
                                     autocomplete: "off", placeholder: "not stored" });
      inputs.ports = h("input", { type: "text", class: "mini-input", value: creds.ports });
      if (!creds.host) {
        formBody.appendChild(h("p", { class: "hint" },
          "No switch is configured. Set switch.host and switch.user in the "
          + "config, or type them here for this session."));
      }

      formBody.appendChild(h("div", { class: "kpis" },
        field("Host", inputs.host), field("User", inputs.user)));
      formBody.appendChild(h("div", { class: "kpis" },
        field("Password", inputs.password, "session only"),
        field("Ports", inputs.ports, "1-8, 1,3,5 or all")));

      inputs.profile = select(
        profiles.map((p) => ({ value: p.name, label: p.name })),
        selected?.name, (v) => { selected = profiles.find((p) => p.name === v);
                                 paintPreview(); },
        { class: "mini-select" });
      formBody.appendChild(field("Profile", inputs.profile));
      if (selected?.description) {
        formBody.appendChild(h("p", { class: "hint", text: selected.description }));
      }

      formBody.appendChild(btnRow(
        button("Preview CLI", { onclick: () => apply(true) }),
        button("Apply", { kind: "primary", onclick: () => apply(false) }),
        button("Disable Qbv", { kind: "danger", onclick: disable })));
    }

    function readCreds() {
      return {
        host: inputs.host.value.trim(),
        user: inputs.user.value.trim(),
        password: inputs.password.value,
        ports: inputs.ports.value.trim(),
      };
    }

    // ---- preview -----------------------------------------------------------
    function paintPreview() {
      clear(previewBody);
      if (!selected?.slots?.length) {
        previewBody.appendChild(h("p", { class: "muted" },
          "Select a profile to see its gate timeline."));
        return;
      }
      const p = palette();
      previewBody.appendChild(charts.gateTimeline(selected.slots, selected.cycle_ns));
      previewBody.appendChild(charts.legend([
        { color: p.classes.control, label: "Q7 control" },
        { color: p.classes.hp_video, label: "Q4 high-priority video" },
        { color: p.classes.be_video, label: "Q0 best effort" },
      ]));
      previewBody.appendChild(table(["Slot", "Gate mask", "Interval"],
        selected.slots.map((s, i) => [
          i + 1,
          h("span", { class: "mono", text: `0x${Number(s[0]).toString(16)} (${s[0]})` }),
          ns(s[1]),
        ])));
      previewBody.appendChild(h("p", { class: "hint",
        text: `cycle ${ns(selected.cycle_ns)}`
            + (selected.guard ? ", guard band enabled" : "") }));
    }

    // ---- actions -----------------------------------------------------------
    async function apply(dryRun) {
      const c = readCreds();
      if (!c.host || !c.user) { toast("host and user are required", "err"); return; }
      if (!selected) { toast("select a profile", "err"); return; }

      if (!dryRun) {
        const ok = await confirm({
          title: `Apply ${selected.name} to ${c.host}?`,
          body: `Writes a Qbv gate schedule to ports ${c.ports} and saves the `
              + "configuration. If it fails part-way the daemon force-disables "
              + "Qbv, so a half-applied schedule cannot strand a management port.",
          confirmLabel: "Apply",
        });
        if (!ok) return;
      }

      try {
        const res = await view.api.switch.apply(
          { ...c, profile: selected.name, dry_run: dryRun },
          { signal: view.signal });
        drawer(dryRun ? "Generated CLI" : "Switch output",
               h("pre", { class: "log", text: res.cli || res.output || "(no output)" }));
        if (!dryRun) { toast("applied", "ok"); readStatus(); }
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        toast(err.message, "err");
      }
    }

    async function disable() {
      const c = readCreds();
      const ok = await confirm({
        title: `Disable Qbv on ${c.host}?`,
        body: `Turns gate control off for ports ${c.ports}. All queues become `
            + "open, so scheduled traffic loses its guarantees.",
        confirmLabel: "Disable", danger: true,
      });
      if (!ok) return;
      try {
        const res = await view.api.switch.disable(c, { signal: view.signal });
        drawer("Switch output",
               h("pre", { class: "log", text: res.output || "(no output)" }));
        toast("Qbv disabled", "ok");
        readStatus();
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
    }

    // ---- live status --------------------------------------------------------
    async function readStatus() {
      const c = readCreds ? readCreds() : creds;
      clear(statusBody);
      statusBody.appendChild(h("div", { class: "skeleton-wrap" },
        h("div", { class: "skeleton-row" }), h("div", { class: "skeleton-row" })));
      try {
        const st = await view.api.switch.status(
          { host: c.host, user: c.user, password: c.password, ports: c.ports },
          { signal: view.signal });
        clear(statusBody);
        statusBody.appendChild(row("Host", st.host, { mono: true }));
        statusBody.appendChild(row("Reachable",
          badge(st.reachable ? "yes" : "no", st.reachable ? "green" : "red")));
        statusBody.appendChild(row("Qbv enabled",
          st.qbv_enabled === undefined ? null
            : badge(st.qbv_enabled ? "yes" : "no", st.qbv_enabled ? "green" : "gray")));
        if (st.raw) {
          statusBody.appendChild(h("details", null,
            h("summary", { class: "hint", text: "raw CLI output" }),
            h("pre", { class: "log", text: st.raw })));
        }
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(statusBody);
        statusBody.appendChild(h("p", { class: "muted" },
          `Could not read the switch: ${err.message}`));
        statusBody.appendChild(h("p", { class: "hint" },
          "The credentials above are used for this. The old UI only ever "
          + "populated this panel in demo mode, so on a real box it stayed "
          + "empty with no explanation."));
      }
    }

    // ---- boot ----------------------------------------------------------------
    try {
      const [res, config] = await Promise.all([
        view.api.switch.profiles({ signal: view.signal }),
        view.api.config.get({ signal: view.signal }),
      ]);
      profiles = res.profiles || [];
      selected = profiles[0] || null;
      const sw = config.switch || {};
      creds.host = sw.host || "";
      creds.user = sw.user || "";
      creds.ports = sw.ports || "1-8";
    } catch (err) {
      if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
    }
    buildForm();
    paintPreview();
    statusBody.appendChild(h("p", { class: "muted" },
      "Press “Read from switch” to query it with the credentials above."));
  },
});
