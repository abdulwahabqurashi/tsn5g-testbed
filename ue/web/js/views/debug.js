/**
 * Debug — raw AT console, command audit, and the request inspector.
 *
 * The request inspector is the answer to "is this panel showing real data?".
 * It lists every call the client has made, so a view rendering numbers with no
 * corresponding request is rendering something it made up. That question used
 * to be unanswerable, which is how demo mode managed to look like a working
 * system.
 *
 * The AT console refuses a short list of commands outright and gates another
 * behind confirmation. The refusal always explains itself — the list is about
 * preventing an irreversible typo, not about deciding what the operator may know.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { confirm, toast } from "../core/dialog.js";
import { atBottom, clear, h } from "../core/dom.js";
import { ago, clockTime } from "../core/format.js";
import { badge, btnRow, button, card, table } from "../ui/widgets.js";

export default defineView({
  name: "debug",

  async mount(view) {
    const out = h("div", { class: "log logpane", style: { "max-height": "340px" } });
    const diagBar = h("div", { class: "toolbar" });
    const auditBody = h("div");
    // The link probe runs every 2s, so an unfiltered audit is almost entirely
    // ping. Default to hiding it: the interesting rows are AT and QMI.
    const auditFilter = h("select", { class: "mini-select", "aria-label": "Audit filter" },
      h("option", { value: "interesting", text: "AT + QMI" }),
      h("option", { value: "at", text: "AT only" }),
      h("option", { value: "shell", text: "Shell only" }),
      h("option", { value: "", text: "Everything" }));
    const inspectBody = h("div");

    const history = [];
    let histPos = -1;

    const input = h("input", {
      type: "text", class: "mini-input", style: { flex: "1", "min-width": "320px" },
      placeholder: 'AT+QENG="servingcell"',
      autocomplete: "off", spellcheck: "false",
    });
    const timeoutInput = h("input", {
      type: "number", class: "mini-input", value: "8", min: "1", max: "300",
      style: { "min-width": "80px" }, "aria-label": "Timeout in seconds",
    });

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "AT console" }),
          h("span", { class: "hint" },
            "commands are serialised with telemetry on one bus")),
        h("p", { class: "section-hint" },
          "Sends directly to the modem. A few commands are refused because they "
          + "are irreversible or would destroy the QMI path this daemon uses; "
          + "others ask for confirmation because they will drop the link."),
        h("div", { class: "toolbar" }, input,
          h("label", { class: "inline-fld" }, "timeout", timeoutInput),
          button("Send", { kind: "primary", onclick: () => send(input.value) }),
          button("Clear", { onclick: () => clear(out) })),
        diagBar,
        out),
      h("section", { class: "card col6" },
        h("div", { class: "card-head" },
          h("h3", { text: "Command audit" }),
          auditFilter),
        h("p", { class: "section-hint" },
          "What the daemon ran against the hardware \u2014 a different question "
          + "from what it logged."),
        auditBody),
      card("Request inspector", { span: "col6",
        hint: "proves a panel is talking to the backend" }, inspectBody)));

    // ---- AT console --------------------------------------------------------
    function echo(text, cls = "") {
      const stick = atBottom(out);
      out.appendChild(h("div", { class: `logline ${cls}`, text }));
      if (stick) out.scrollTop = out.scrollHeight;
    }

    async function send(raw, confirmed = false) {
      const cmd = (raw || "").trim();
      if (!cmd) return;
      if (!confirmed) {
        history.push(cmd);
        histPos = history.length;
        input.value = "";
      }
      echo(`> ${cmd}`, "lvl-info");

      const timeout = Math.max(1, Math.min(300, Number(timeoutInput.value) || 8));
      try {
        const res = await view.api.modem.at({ cmd, timeout, confirm: confirmed },
                                            { signal: view.signal });
        if (res.job_id) {
          echo(`  running as job ${res.job_id}…`, "lvl-debug");
          followJob(res.job_id);
          return;
        }
        if (res.ok) {
          if (!res.lines.length) echo("  OK", "lvl-debug");
          for (const line of res.lines) echo(`  ${line}`);
          echo(`  (${res.ms} ms)`, "lvl-debug");
        } else {
          echo(`  ${res.error}`, "lvl-error");
        }
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        if (err.status === 403) {
          echo(`  REFUSED: ${err.message}`, "lvl-error");
          return;
        }
        if (err.status === 428) {
          const explain = err.data?.explain || err.message;
          echo(`  needs confirmation: ${explain}`, "lvl-warning");
          const ok = await confirm({
            title: "Send this command?",
            body: explain,
            confirmLabel: "Send anyway",
            danger: true,
          });
          if (ok) await send(cmd, true);
          else echo("  cancelled", "lvl-debug");
          return;
        }
        echo(`  ${err.message}`, "lvl-error");
      }
      loadAudit();
    }

    function followJob(id) {
      let seen = 0;
      const timer = view.interval(async () => {
        try {
          const job = await view.api.jobs.get(id, { signal: view.signal });
          for (const line of (job.lines || []).slice(seen)) echo(`  ${line}`, "lvl-debug");
          seen = (job.lines || []).length;
          if (!["queued", "running"].includes(job.state)) {
            clearInterval(timer);
            echo(`  job ${job.state}`, job.state === "succeeded" ? "lvl-debug" : "lvl-error");
            if (job.error) echo(`  ${job.error}`, "lvl-error");
            loadAudit();
          }
        } catch (err) {
          if (!(err instanceof ApiError && err.isAborted)) clearInterval(timer);
        }
      }, 700);
    }

    // Shell-style history on the arrow keys.
    view.dom(input, "keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); send(input.value); }
      else if (e.key === "ArrowUp" && history.length) {
        e.preventDefault();
        histPos = Math.max(0, histPos - 1);
        input.value = history[histPos] || "";
      } else if (e.key === "ArrowDown" && history.length) {
        e.preventDefault();
        histPos = Math.min(history.length, histPos + 1);
        input.value = history[histPos] || "";
      }
    });

    // ---- diagnostic buttons -------------------------------------------------
    try {
      const rules = await view.api.modem.atRules({ signal: view.signal });
      clear(diagBar);
      diagBar.appendChild(h("span", { class: "hint", text: "quick:" }));
      for (const d of (rules.diag || []).slice(0, 12)) {
        diagBar.appendChild(button(d.cmd.replace(/^AT\+?/, ""), {
          title: d.label, onclick: () => send(d.cmd),
        }));
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.isAborted)) {
        diagBar.appendChild(h("span", { class: "muted", text: err.message }));
      }
    }

    // ---- audit ---------------------------------------------------------------
    async function loadAudit() {
      try {
        const mode = auditFilter.value;
        const query = { limit: mode === "interesting" ? 200 : 40 };
        if (mode === "at" || mode === "shell") query.kind = mode;
        const res = await view.api.debug.commands(query, { signal: view.signal });
        let entries = res.commands || [];
        if (mode === "interesting") {
          entries = entries.filter((e) => e.kind !== "shell"
            || !/^(ping|systemctl is-)/.test(e.cmd || "")).slice(-40);
        }
        const rows = entries.slice().reverse().map((e) => [
          clockTime(e.ts),
          badge(e.kind, e.denied ? "red" : e.rc === 0 ? "green" : "amber"),
          h("span", { class: "mono", text: (e.cmd || "").slice(0, 60) }),
          e.ms === null || e.ms === undefined ? "—" : `${e.ms} ms`,
          e.denied ? "denied" : String(e.rc ?? "—"),
        ]);
        clear(auditBody);
        auditBody.appendChild(rows.length
          ? table(["Time", "Kind", "Command", "Took", "rc"], rows)
          : h("p", { class: "muted" },
              mode === "interesting"
                ? "No modem commands yet \u2014 only routine polling."
                : "Nothing recorded yet."));
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(auditBody);
        auditBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
    }

    // ---- request inspector ----------------------------------------------------
    function paintInspector() {
      const calls = (window.__tsn?.recorder?.all() || []).slice(-30).reverse();
      clear(inspectBody);
      if (!calls.length) {
        inspectBody.appendChild(h("p", { class: "muted" }, "No requests yet."));
        return;
      }
      inspectBody.appendChild(table(["When", "Method", "Path", "Status", "Took"],
        calls.map((c) => [
          ago(c.at / 1000),
          c.method,
          h("span", { class: "mono", text: c.path }),
          badge(c.status || "failed",
                c.status >= 200 && c.status < 300 ? "green"
                : c.status >= 400 ? "red" : "amber"),
          `${Math.round(c.ms)} ms`,
        ])));
    }

    view.dom(auditFilter, "change", loadAudit);

    await loadAudit();
    paintInspector();

    view.interval(() => { loadAudit(); paintInspector(); }, 5000);

    input.focus();
  },
});
