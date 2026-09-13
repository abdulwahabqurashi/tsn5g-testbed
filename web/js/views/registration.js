/**
 * Registration — make the UE camp where you want it.
 *
 * Replaces camp.sh, lock5g.sh, fixband.sh, force5g.sh, scan.sh and rfcheck.sh.
 *
 * The one thing this view refuses to let you do is set nr5g_disable_mode to
 * anything but 0. Verified on this firmware 2026-09-08: 1 and 2 both prevent
 * SA camping, and 1 additionally makes nr5g_band writes fail silently — so the
 * symptom is "the band setting won't stick" and the cause is somewhere else
 * entirely. Four of the reference scripts set it to 1. They are wrong, and
 * that is why the UI shows a derived "SA only" state rather than a numeric
 * field someone can typo.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { confirm, toast } from "../core/dialog.js";
import { clear, h } from "../core/dom.js";
import { dbm, nn } from "../core/format.js";
import { badge, btnRow, button, card, field, row, select, table } from "../ui/widgets.js";

export default defineView({
  name: "registration",

  async mount(view) {
    const stateBody = h("div");
    const prefsBody = h("div");
    const plmnBody = h("div");
    const lockBody = h("div");
    const scanBody = h("div");
    const jobLog = h("div", { class: "log logpane", style: { "max-height": "200px" } });
    const jobLogWrap = h("details", { class: "raw-output" },
      h("summary", { class: "hint", text: "Job output" }), jobLog);

    view.root.appendChild(h("div", { class: "grid" },
      card("Serving cell", { span: "col4" }, stateBody),
      card("Preferences", { span: "col4" }, prefsBody),
      card("Cell lock", { span: "col4" }, lockBody),
      card("Operator", { span: "col6" }, plmnBody),
      h("section", { class: "card col6" },
        h("div", { class: "card-head" },
          h("h3", { text: "Survey & recovery" }),
          h("span", { class: "hint", text: "minutes, not seconds" })),
        scanBody, jobLogWrap)));

    let running = null;

    function echo(line, cls = "") {
      jobLog.appendChild(h("div", { class: `logline ${cls}`, text: line }));
      jobLog.scrollTop = jobLog.scrollHeight;
    }

    async function runJob(starter, label) {
      if (running) { toast("another modem operation is running", "err"); return null; }
      clear(jobLog);
      jobLogWrap.open = true;
      echo(`> ${label}`, "lvl-info");
      let res;
      try {
        res = await starter();
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return null;
        if (err.status === 428) {
          const ok = await confirm({
            title: "Confirm",
            body: err.data?.explain || err.message,
            confirmLabel: "Continue", danger: true,
          });
          if (!ok) { echo("  cancelled", "lvl-debug"); return null; }
          return null;   // caller re-issues with confirm
        }
        echo(`  ${err.message}`, "lvl-error");
        toast(err.message, "err");
        return null;
      }
      running = res.job_id;
      const result = await follow(res.job_id);
      running = null;
      refresh();
      return result;
    }

    async function follow(jobId) {
      let seen = 0;
      for (let i = 0; i < 400; i += 1) {
        await new Promise((r) => view.timeout(r, 800));
        let job;
        try {
          job = await view.api.jobs.get(jobId, { signal: view.signal });
        } catch (err) {
          if (err instanceof ApiError && err.isAborted) return null;
          continue;
        }
        for (const line of (job.lines || []).slice(seen)) echo(`  ${line}`);
        seen = (job.lines || []).length;
        if (!["queued", "running"].includes(job.state)) {
          echo(`  ${job.state}`, job.state === "succeeded" ? "lvl-debug" : "lvl-error");
          if (job.error) echo(`  ${job.error}`, "lvl-error");
          return job.result;
        }
      }
      return null;
    }

    // ---- serving cell -----------------------------------------------------
    function paintState(s) {
      clear(stateBody);
      stateBody.appendChild(row("Registered",
        badge(s.registered ? "yes" : "no", s.registered ? "green" : "red")));
      stateBody.appendChild(row("RAT", s.rat
        ? badge(s.rat, String(s.rat).includes("NR5G") ? "green" : "amber") : null));
      stateBody.appendChild(row("Operator", s.operator, { mono: true }));
      stateBody.appendChild(row("Selection", s.selection));
      const c = s.cell || {};
      stateBody.appendChild(row("Band", c.band, { mono: true }));
      stateBody.appendChild(row("ARFCN", c.arfcn, { mono: true }));
      stateBody.appendChild(row("PCI", c.pci, { mono: true }));
      stateBody.appendChild(row("RSRP", dbm(c.rsrp)));
      if (s.reg_5g && !s.reg_5g.registered && s.reg_5g.searching) {
        stateBody.appendChild(h("p", { class: "hint" }, "5G registration is searching."));
      }
    }

    // ---- preferences ------------------------------------------------------
    function paintPrefs(p, cell) {
      clear(prefsBody);
      prefsBody.appendChild(row("SA only",
        badge(p.sa_only ? "yes" : "no", p.sa_only ? "green" : "amber")));
      prefsBody.appendChild(row("Mode", p.mode_pref, { mono: true }));
      prefsBody.appendChild(row("NR bands", p.nr5g_band, { mono: true }));
      prefsBody.appendChild(row("disable_mode", p.nr5g_disable_mode, { mono: true }));

      if (String(p.nr5g_disable_mode ?? "") !== "0") {
        prefsBody.appendChild(h("p", { class: "section-hint",
          style: { color: "var(--red)", "font-weight": "600" } },
          `nr5g_disable_mode is ${p.nr5g_disable_mode}. This firmware only `
          + "camps on SA with 0, and with 1 the band mask silently refuses "
          + "writes. Setting SA only will put it back."));
      }
      if (!p.nr5g_band || String(p.nr5g_band) === "0") {
        prefsBody.appendChild(h("p", { class: "section-hint",
          style: { color: "var(--amber)", "font-weight": "600" } },
          "The band mask is empty. Nothing will camp until it is repaired."));
      }

      // The mask the modem reports, verbatim. When it is empty the fallback is
      // the band the UE is camped on — not a constant, which on another site
      // would repair towards a band that is not deployed there.
      const servingBand = cell.band === null || cell.band === undefined
        ? "" : String(cell.band).replace(/^n/i, "");
      const bandInput = h("input", { type: "text", class: "mini-input",
                                     value: p.nr5g_band || servingBand,
                                     placeholder: "e.g. 78 or 1:3:78" });
      prefsBody.appendChild(field("NR band mask", bandInput,
                                  "colon-separated, e.g. 78 or 1:3:7:78"));
      if (!p.nr5g_band && servingBand) {
        prefsBody.appendChild(h("p", { class: "hint",
          text: `Prefilled with n${servingBand}, the band the UE is camped on.` }));
      }
      prefsBody.appendChild(btnRow(
        button("Set SA only", {
          kind: "primary",
          title: "mode_pref=NR5G with nr5g_disable_mode=0",
          onclick: () => runJob(
            () => view.api.radio.setPrefs(
              { mode_pref: "NR5G", nr5g_disable_mode: "0",
                nr5g_band: bandInput.value.trim() || undefined },
              { signal: view.signal }),
            "set SA only"),
        }),
        button("Repair bands", {
          title: "when the mask is stuck at zero",
          onclick: async () => {
            const ok = await confirm({
              title: "Repair the band mask?",
              body: "Rewrites nr5g_band, trying several syntaxes and then "
                  + "retrying with the radio briefly powered down — several "
                  + "QNWPREFCFG parameters only commit at CFUN=0. The bearer "
                  + "will drop.\n\nAT+QPRTPARA=3 is deliberately not "
                  + "attempted: it restores NV to factory defaults.",
              confirmLabel: "Repair", danger: true,
            });
            if (!ok) return;
            const band = bandInput.value.trim();
            if (!band) {
              toast("enter a band mask to repair towards", "err");
              return;
            }
            runJob(() => view.api.radio.repairBands(
              { band, confirm: true },
              { signal: view.signal }), "repair bands");
          },
        })));
    }

    // ---- operator ---------------------------------------------------------
    function paintPlmn(state, forbidden) {
      clear(plmnBody);
      const plmnInput = h("input", { type: "text", class: "mini-input",
                                     value: state.operator || "",
                                     placeholder: "00102" });
      plmnBody.appendChild(field("PLMN", plmnInput, "MCC+MNC, e.g. 00102"));
      plmnBody.appendChild(btnRow(
        button("Select manually", {
          kind: "primary",
          title: 'AT+COPS=1,2,"<plmn>",11 — pins NR-SA as well as the operator',
          onclick: async () => {
            const plmn = plmnInput.value.trim();
            if (!plmn) { toast("a PLMN is required", "err"); return; }
            const ok = await confirm({
              title: `Select ${plmn}?`,
              body: "The UE deregisters first, so the bearer drops until it "
                  + "camps again. The access technology is pinned to NR-SA — "
                  + "without that the modem can widen to LTE and drift into "
                  + "limited service on a commercial network.",
              confirmLabel: "Select", danger: true,
            });
            if (!ok) return;
            runJob(() => view.api.radio.selectPlmn(
              { mode: "manual", plmn, act: 11, confirm: true },
              { signal: view.signal }), `select ${plmn}`);
          },
        }),
        button("Automatic", {
          onclick: () => runJob(() => view.api.radio.selectPlmn(
            { mode: "automatic", confirm: true }, { signal: view.signal }),
            "automatic selection"),
        }),
        button("Wait for camp", {
          onclick: () => runJob(() => view.api.radio.camp(
            { timeout_s: 120 }, { signal: view.signal }), "wait for camp"),
        })));

      const list = forbidden?.forbidden || [];
      plmnBody.appendChild(h("div", { class: "kpi-label",
                                      style: { "margin-top": "14px" },
                                      text: "Forbidden PLMNs" }));
      // An empty list and a failed read are not the same claim. This firmware
      // rejects AT+QFPLMNCFG="get", and reporting that as "None" asserted the
      // list was clear when it had never been read.
      if (forbidden?.error) {
        plmnBody.appendChild(h("p", { class: "section-hint",
          style: { color: "var(--amber)" } },
          `Could not read the list: ${forbidden.error}. It may still contain `
          + "entries — this is not a confirmation that it is empty."));
      } else if (!list.length) {
        plmnBody.appendChild(h("p", { class: "hint" },
          "None. A PLMN lands here after repeated failures and then stays — "
          + "across reboots — refusing every future attempt."));
      } else {
        plmnBody.appendChild(table(["PLMN", ""], list.map((p) => [
          h("span", { class: "mono", text: p }),
          button("Remove", {
            onclick: () => runJob(
              () => view.api.radio.clearForbidden(p, { signal: view.signal }),
              `remove ${p} from the forbidden list`),
          }),
        ])));
      }
    }

    // ---- cell lock --------------------------------------------------------
    function paintLock(lock, cell) {
      clear(lockBody);
      lockBody.appendChild(row("Locked",
        badge(lock.locked ? "yes" : "no", lock.locked ? "amber" : "gray")));
      if (lock.locked) {
        lockBody.appendChild(row("ARFCN", lock.arfcn, { mono: true }));
        lockBody.appendChild(row("Band", lock.band ? `n${lock.band}` : null,
                                 { mono: true }));
        lockBody.appendChild(row("PCI", lock.pci, { mono: true }));
        lockBody.appendChild(h("p", { class: "hint" },
          "The UE cannot camp anywhere else while this is set."));
        lockBody.appendChild(btnRow(button("Clear lock", {
          kind: "danger",
          onclick: () => runJob(() => view.api.radio.clearLock({ signal: view.signal }),
                                "clear cell lock"),
        })));
        return;
      }
      // Prefilled from the cell the UE is camped on right now, not from
      // constants. Hard-coding this rig's 624000/n78/PCI 1 made the form look
      // populated while ignoring the modem, so locking from a different site
      // would have locked to the wrong cell.
      const bandNow = cell.band === null || cell.band === undefined
        ? "" : String(cell.band).replace(/^n/i, "");
      const inputs = {
        arfcn: h("input", { type: "number", class: "mini-input",
                            value: cell.arfcn ?? "", placeholder: "from scan" }),
        band: h("input", { type: "number", class: "mini-input",
                           value: bandNow, placeholder: "e.g. 78" }),
        pci: h("input", { type: "number", class: "mini-input",
                          value: cell.pci ?? "", placeholder: "from scan" }),
        scs: h("input", { type: "number", class: "mini-input", value: "1" }),
      };
      lockBody.appendChild(h("div", { class: "kpis" },
        field("ARFCN", inputs.arfcn), field("Band", inputs.band),
        field("PCI", inputs.pci), field("SCS index", inputs.scs)));
      const haveCell = cell.arfcn !== null && cell.arfcn !== undefined;
      lockBody.appendChild(h("p", { class: "hint" },
        haveCell
          ? "Prefilled from the serving cell. Scan and use a row's Lock button "
            + "to target a different one."
          : "Not camped, so there is nothing to prefill. Run a scan and lock "
            + "from a result row, or enter the values by hand."));
      lockBody.appendChild(h("p", { class: "hint" },
        "The argument order varies by firmware, so four known orders are "
        + "tried and whichever is accepted is kept."));
      lockBody.appendChild(btnRow(button("Lock to cell", {
        onclick: async () => {
          const ok = await confirm({
            title: "Lock to this cell?",
            body: "The radio is power-cycled so the lock takes effect. A wrong "
                + "ARFCN or PCI leaves the UE unable to camp at all until the "
                + "lock is cleared.",
            confirmLabel: "Lock", danger: true,
          });
          if (!ok) return;
          runJob(() => view.api.radio.setLock({
            arfcn: Number(inputs.arfcn.value), band: Number(inputs.band.value),
            pci: Number(inputs.pci.value), scs: Number(inputs.scs.value),
            confirm: true,
          }, { signal: view.signal }), "lock to cell");
        },
      })));
    }

    // ---- survey ------------------------------------------------------------
    function paintScan() {
      clear(scanBody);
      scanBody.appendChild(h("p", { class: "section-hint" },
        "A scan takes the modem off telemetry for its duration — signal "
        + "polling is paused automatically and resumed afterwards."));
      scanBody.appendChild(btnRow(
        button("Scan cells", {
          title: "AT+QSCAN=3,1 — 2 to 4 minutes",
          onclick: () => runScan("nr"),
        }),
        button("Scan operators", {
          title: "AT+COPS=? — 2 to 3 minutes",
          onclick: () => runScan("operators"),
        }),
        button("Diagnose RF", {
          kind: "primary",
          title: "is any RF reaching the modem at all?",
          onclick: () => runJob(
            () => view.api.radio.diagnose({ signal: view.signal }), "diagnose"),
        }),
        button("Cancel", {
          onclick: async () => {
            if (!running) { toast("nothing running"); return; }
            try { await view.api.jobs.cancel(running, { signal: view.signal }); }
            catch (err) { toast(err.message, "err"); }
          },
        })));
    }

    async function runScan(kind) {
      const result = await runJob(
        () => view.api.radio.scan({ kind }, { signal: view.signal }),
        `scan (${kind})`);
      if (!result) return;
      if (result.cells?.length) {
        scanBody.appendChild(h("div", { class: "kpi-label", text: "Cells found" }));
        scanBody.appendChild(table(["RAT", "PLMN", "ARFCN", "PCI", "RSRP", ""],
          result.cells.slice(0, 20).map((c) => [
            c.rat, `${c.mcc ?? "?"}-${c.mnc ?? "?"}`, c.arfcn, c.pci, dbm(c.rsrp),
            button("Lock to this", {
              onclick: () => runJob(() => view.api.radio.setLock({
                arfcn: c.arfcn, pci: c.pci, band: 78, scs: 1, confirm: true,
              }, { signal: view.signal }), `lock to arfcn ${c.arfcn}`),
            }),
          ])));
      }
      if (result.operators?.length) {
        scanBody.appendChild(h("div", { class: "kpi-label", text: "Operators" }));
        scanBody.appendChild(table(["PLMN", "Name", "Status", ""],
          result.operators.map((o) => [
            h("span", { class: "mono", text: o.plmn }), o.long || o.short,
            badge(o.status, o.status === "current" ? "green"
              : o.status === "forbidden" ? "red" : "gray"),
            button("Select", {
              onclick: () => runJob(() => view.api.radio.selectPlmn(
                { mode: "manual", plmn: o.plmn, act: 11, confirm: true },
                { signal: view.signal }), `select ${o.plmn}`),
            }),
          ])));
      }
    }

    // ---- data ---------------------------------------------------------------
    async function refresh() {
      try {
        const [state, prefs, forbidden, lock] = await Promise.all([
          view.api.radio.state({ signal: view.signal }),
          view.api.radio.prefs({ signal: view.signal }),
          view.api.radio.forbidden({ signal: view.signal }),
          view.api.radio.lock({ signal: view.signal }),
        ]);
        paintState(state);
        paintPrefs(prefs, state.cell || {});
        paintPlmn(state, forbidden);
        paintLock(lock, state.cell || {});
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(stateBody);
        stateBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
    }

    paintScan();
    await refresh();
    // Slow: every read is several AT round trips on a bus shared with telemetry.
    view.interval(() => { if (!running) refresh(); }, 15000);
  },
});
