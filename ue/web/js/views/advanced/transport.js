/**
 * Transport — the VXLAN/Ethernet overlay that carries TSN traffic over 5G.
 *
 * The old view was read-only, despite /api/transport/stop having existed since
 * the beginning with nothing calling it. Same for the VLAN class map, which
 * was edited as a raw JSON textarea with no validation beyond JSON.parse.
 */

import { ApiError } from "../../core/api.js";
import { defineView } from "../../core/component.js";
import { confirm, toast } from "../../core/dialog.js";
import { clear, h } from "../../core/dom.js";
import { bytes, nn } from "../../core/format.js";
import { palette } from "../../ui/tokens.js";
import { badge, btnRow, button, card, field, row, select, table } from "../../ui/widgets.js";

const CLASS_COLOUR = { control: "control", hp_video: "hp_video", be_video: "be_video" };

export default defineView({
  name: "transport",

  async mount(view) {
    const stateBody = h("div");
    const classBody = h("div");
    const logPane = h("div", { class: "log logpane", style: { "max-height": "180px" } });
    const logWrap = h("details", { class: "raw-output" },
      h("summary", { class: "hint", text: "Job output" }), logPane);

    view.root.appendChild(h("div", { class: "grid" },
      card("Active transport", { span: "col5" }, stateBody),
      h("section", { class: "card col7" },
        h("div", { class: "card-head" },
          h("h3", { text: "Traffic classes" }),
          h("span", { class: "hint", text: "VLAN → VNI, PCP and DSCP" })),
        classBody, logWrap)));

    function paintState(status) {
      clear(stateBody);
      const t = status?.transport || {};
      const up = Boolean(t.mode);
      stateBody.appendChild(row("Mode", t.mode ? badge(t.mode, "blue") : badge("down", "gray")));
      stateBody.appendChild(row("Bridge", t.bridge, { mono: true }));
      stateBody.appendChild(row("Core", t.core_ip, { mono: true }));
      stateBody.appendChild(row("MTU", t.mtu));
      stateBody.appendChild(row("Wired NICs", (t.wired_nics || []).join(", ") || null,
                                { mono: true }));
      if (t.built_interfaces?.length) {
        stateBody.appendChild(h("div", { class: "kpi-label",
                                         style: { "margin-top": "10px" },
                                         text: "Interfaces built" }));
        stateBody.appendChild(h("pre", { class: "log",
          style: { "max-height": "110px" },
          text: t.built_interfaces.join("\n") }));
      }
      stateBody.appendChild(btnRow(
        button("Start", {
          kind: "primary", disabled: up,
          onclick: () => run(() => view.api.transport.start({}, { signal: view.signal }),
                             "start transport"),
        }),
        button("Stop", {
          kind: "danger", disabled: !up,
          onclick: async () => {
            const ok = await confirm({
              title: "Stop the transport?",
              body: "Deletes the overlay interfaces. Anything using them loses "
                  + "its path. The 5G bearer itself is unaffected.",
              confirmLabel: "Stop", danger: true,
            });
            if (!ok) return;
            try {
              await view.api.transport.stop({ signal: view.signal });
              toast("transport stopped", "ok");
            } catch (err) {
              if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
            }
          },
        })));
      if (!up) {
        stateBody.appendChild(h("p", { class: "hint" },
          "Starting the transport attaches the modem and builds the overlay. "
          + "For the bearer alone, use Connection."));
      }
    }

    async function run(starter, label) {
      clear(logPane);
      logWrap.open = true;
      logPane.appendChild(h("div", { class: "logline lvl-info", text: `> ${label}` }));
      try {
        const res = await starter();
        if (!res.job_id) return;
        let seen = 0;
        for (let i = 0; i < 120; i += 1) {
          await new Promise((r) => view.timeout(r, 700));
          const job = await view.api.jobs.get(res.job_id, { signal: view.signal });
          for (const line of (job.lines || []).slice(seen)) {
            logPane.appendChild(h("div", { class: "logline", text: `  ${line}` }));
          }
          seen = (job.lines || []).length;
          logPane.scrollTop = logPane.scrollHeight;
          if (!["queued", "running"].includes(job.state)) {
            if (job.error) toast(job.error, "err"); else toast(`${label} done`, "ok");
            return;
          }
        }
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
      }
    }

    // ---- class map ---------------------------------------------------------
    function paintClasses(config, status) {
      clear(classBody);
      const map = config?.vxlan?.vlan_map || [];
      const live = status?.transport?.classes || [];
      const p = palette();

      if (!map.length) {
        classBody.appendChild(h("p", { class: "muted" },
          "No traffic classes configured."));
        return;
      }

      const rows = map.map((c, i) => {
        const colour = p.classes[CLASS_COLOUR[c.role]] || p.faint;
        const isLive = live.some((l) => l.vlan === c.vlan);
        return [
          h("span", { class: "cell-name" },
            h("i", { style: { background: colour, width: "10px", height: "10px",
                              "border-radius": "3px", display: "inline-block" } }),
            c.role || `vlan ${c.vlan}`),
          c.vlan, c.vni ?? c.vlan, c.dstport ?? 4789, c.pcp, c.dscp,
          isLive ? badge("up", "green") : badge("—", "gray"),
        ];
      });
      classBody.appendChild(table(
        ["Class", "VLAN", "VNI", "UDP port", "PCP", "DSCP", ""], rows));

      // The old view invented a UDP port when the backend gave none, which
      // made an unconfigured map look configured.
      if (map.some((c) => c.dstport === undefined)) {
        classBody.appendChild(h("p", { class: "hint" },
          "Classes without an explicit UDP port all default to 4789 and would "
          + "collide. Set dstport per class."));
      }
      classBody.appendChild(h("p", { class: "hint" },
        "Edited in the config file or through Settings — the values drive both "
        + "the overlay and the switch's flow classifiers, so they are not a "
        + "free-text field here."));
    }

    async function refresh() {
      try {
        const [status, config] = await Promise.all([
          view.api.status({ signal: view.signal }),
          view.api.config.get({ signal: view.signal }),
        ]);
        paintState(status);
        paintClasses(config, status);
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(stateBody);
        stateBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
    }

    await refresh();
    view.sub((s) => s.status?.active_mode, refresh);
    view.interval(refresh, 10000);
  },
});
