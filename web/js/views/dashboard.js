/**
 * Dashboard — is the UE up, and how good is the link?
 *
 * Two changes from the version this replaces. The throughput chart is
 * time-based, so a gap in the data draws as a gap: the old one appended to
 * index-based arrays and skipped the append entirely when a poll failed, which
 * silently compressed the x-axis and made a dropped sample look like a fast
 * one. And the Connect button drives bearer.up rather than the legacy connect
 * path, which rebuilt the VXLAN overlay and used the /30 addressing form.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { confirm, toast } from "../core/dialog.js";
import { clear, h } from "../core/dom.js";
import { bitrate, dbm, db, ms, nn, signalBand } from "../core/format.js";
import * as charts from "../ui/charts.js";
import { bandColor, palette } from "../ui/tokens.js";
import { badge, btnRow, button, card, kpi, row } from "../ui/widgets.js";

export default defineView({
  name: "dashboard",

  async mount(view) {
    const heroBody = h("div");
    const connBody = h("div");
    const signalBody = h("div");
    const healthBody = h("div");
    const linkBody = h("div");

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col8" },
        h("div", { class: "card-head" },
          h("h3", { text: "5G link throughput" }),
          h("span", { class: "hint", text: "5 minutes; gaps are real gaps" })),
        heroBody),
      card("Connection", { span: "col4" }, connBody),
      card("Signal", { span: "col4" }, signalBody),
      card("Link to core", { span: "col4" }, linkBody),
      card("Health", { span: "col4" }, healthBody)));

    // ---- throughput --------------------------------------------------------
    function paintHero(state) {
      const p = palette();
      const { ul, dl } = state.series;
      clear(heroBody);

      const lastUl = ul.length ? ul[ul.length - 1].v : 0;
      const lastDl = dl.length ? dl[dl.length - 1].v : 0;
      heroBody.appendChild(h("div", { class: "stat-hero" },
        h("span", { class: "num", text: (lastUl + lastDl).toFixed(1) }),
        h("span", { class: "unit", text: "Mbit/s total" })));
      heroBody.appendChild(h("div", { class: "stat-sub",
        text: `▲ ${lastUl.toFixed(1)} up   ▼ ${lastDl.toFixed(1)} down` }));

      if (!ul.length && !dl.length) {
        heroBody.appendChild(h("p", { class: "muted" },
          "No counters yet."));
        return;
      }
      const now = Date.now();
      heroBody.appendChild(charts.timeSeries([ul, dl], {
        h: 170, colors: [p.series[0], p.series[1]],
        from: now - 5 * 60 * 1000, to: now, gapMs: 6000,
      }));
      heroBody.appendChild(charts.legend([
        { color: p.series[0], label: "uplink" },
        { color: p.series[1], label: "downlink" },
      ]));
    }

    // ---- connection ---------------------------------------------------------
    function paintConn(state) {
      const s = state.status || {};
      const b = state.bearer || {};
      clear(connBody);

      const up = b.state === "up" || s.state === "running";
      connBody.appendChild(h("div", { class: "big-state",
        text: up ? "Connected" : (s.state || "idle") }));
      if (s.last_error) {
        connBody.appendChild(h("p", { class: "section-hint",
          style: { color: "var(--red)" }, text: s.last_error }));
      }
      connBody.appendChild(h("div", { class: "kpis" },
        kpi("UE IP", b.ipv4 || s.modem?.ipv4),
        kpi("APN", b.apn || s.modem?.dnn),
        kpi("Band", s.modem?.band),
        kpi("Transport", s.active_mode)));

      connBody.appendChild(btnRow(
        button(up ? "Restart call" : "Bring up", {
          kind: "primary",
          onclick: async () => {
            if (up) {
              const ok = await confirm({
                title: "Restart the data call?",
                body: "The UE address will change and any routing profile is "
                    + "re-applied afterwards.",
                confirmLabel: "Restart", danger: true,
              });
              if (!ok) return;
            }
            try {
              await (up ? view.api.bearer.cycle({ confirm: true }, { signal: view.signal })
                        : view.api.bearer.up({}, { signal: view.signal }));
              toast(up ? "restarting" : "bringing up", "ok");
            } catch (err) {
              if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
            }
          },
        }),
        button("Details", { onclick: () => { window.location.hash = "#/connection"; } })));
    }

    // ---- signal --------------------------------------------------------------
    function paintSignal(state) {
      const sig = state.signal.latest || state.status?.modem?.signal || {};
      const p = palette();
      clear(signalBody);
      if (sig.rsrp === null || sig.rsrp === undefined) {
        signalBody.appendChild(h("p", { class: "muted" }, "No reading."));
        return;
      }
      // RSRP and SINR shown separately, never averaged: this rig runs "poor"
      // RSRP with "good" SINR and gets 148 Mbit/s, which one bar would hide.
      for (const [metric, value, unit] of [["rsrp", sig.rsrp, "dBm"],
                                           ["sinr", sig.sinr, "dB"],
                                           ["rsrq", sig.rsrq, "dB"]]) {
        const band = signalBand(metric, value);
        signalBody.appendChild(h("div", { class: "bar-row" },
          h("span", { class: "lab", text: metric.toUpperCase() }),
          charts.meter(metric === "sinr"
            ? Math.max(0, Math.min(100, ((value + 5) / 35) * 100))
            : Math.max(0, Math.min(100, ((value + 120) / 50) * 100)),
            { color: bandColor(band) }),
          h("span", { class: "val", text: value === null || value === undefined
            ? "—" : `${value} ${unit}` })));
      }
      signalBody.appendChild(row("RAT", state.status?.modem?.rat));
      if (sig.stale) {
        signalBody.appendChild(h("p", { class: "hint",
          text: "reading is stale — the modem bus is busy" }));
      }
    }

    // ---- link ----------------------------------------------------------------
    function paintLink(state) {
      const link = state.stats?.link || {};
      const p = palette();
      clear(linkBody);
      linkBody.appendChild(row("Target", link.target, { mono: true }));
      linkBody.appendChild(row("Latency", ms(link.latency_ms)));
      linkBody.appendChild(row("Jitter", ms(link.jitter_ms)));
      const series = state.series.latency;
      if (series.length > 1) {
        const now = Date.now();
        linkBody.appendChild(charts.timeSeries(series, {
          h: 90, colors: [p.series[2]], from: now - 5 * 60 * 1000, to: now,
          gapMs: 8000,
        }));
      }
    }

    // ---- health ---------------------------------------------------------------
    function paintHealth(state) {
      const h2 = state.health || {};
      clear(healthBody);
      const checks = h2.checks || {};
      if (!Object.keys(checks).length) {
        healthBody.appendChild(h("p", { class: "muted" }, "No checks reported."));
        return;
      }
      for (const [name, ok] of Object.entries(checks)) {
        healthBody.appendChild(row(
          name.charAt(0).toUpperCase() + name.slice(1),
          badge(ok ? "ok" : "down", ok ? "green" : "red")));
      }
    }

    // ---- wiring ----------------------------------------------------------------
    function paintAll() {
      const state = view.store.get();
      paintHero(state);
      paintConn(state);
      paintSignal(state);
      paintLink(state);
      paintHealth(state);
    }

    // The bearer is not in the polled snapshot, so fetch it alongside.
    async function loadBearer() {
      try {
        const b = await view.api.bearer.get({ signal: view.signal });
        view.store.patch({ bearer: b });
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          // Non-fatal: the rest of the dashboard still works.
        }
      }
    }

    view.sub((s) => s.stats, paintAll);
    view.sub((s) => s.status, paintAll);
    view.sub((s) => s.health, paintAll);
    view.listen("signal", paintAll);

    await loadBearer();
    paintAll();
    view.interval(loadBearer, 8000);
  },
});
