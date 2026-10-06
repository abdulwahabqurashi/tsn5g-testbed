/**
 * Overview — the whole testbed on one screen, the way UniFi's dashboard shows
 * a network: the path first, then a handful of numbers, then two charts.
 *
 *   path      cameras → UE → 5G radio → core, each hop coloured by its state
 *   tiles     link, uplink rate, camera 1's delay, clock offset, signal
 *   charts    5G throughput; camera lanes' one-way delay
 *   side      what needs attention (each with the page that fixes it), last tests
 *
 * Everything polled here is cheap: the snapshot comes from the event stream,
 * the counters and the PTP status every 2–5 s.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { clear, fill, h } from "../core/dom.js";
import { clockTime, ns } from "../core/format.js";
import * as charts from "../ui/charts.js";
import { icon } from "../ui/icons.js";
import { latencyCard } from "../ui/latency.js";
import { axisRow, chip, chips, topoLink, topoNode } from "../ui/observe.js";
import { palette } from "../ui/tokens.js";
import { badge } from "../ui/widgets.js";

const KIND_LABEL = { drift: "Clock drift", qbv: "Uplink priority", demo: "Camera demo", loss: "Uplink loss",
                     camloss: "Camera loss check" };

function tile(label, value, sub, state = "") {
  return h("div", { class: `tile ${state}` },
    h("div", { class: "tile-label", text: label }),
    h("div", { class: "tile-val", text: value }),
    h("div", { class: "tile-sub", text: sub || "" }));
}

function when(ts) {
  const d = new Date(ts * 1000);
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${clockTime(ts)}`;
}

export default defineView({
  name: "dashboard",

  async mount(view) {
    const pathBody = h("div", { class: "topo topo-wide" });
    const tiles = h("div", { class: "tiles" });
    const tputHead = h("div", { class: "card-head" });
    const tputBody = h("div");
    const attnBody = h("div");
    const testsBody = h("div");
    const charts2 = h("div", { class: "grid" });

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col12 card-path" }, pathBody, tiles),
      h("section", { class: "card col8" }, tputHead, tputBody),
      h("section", { class: "card col4" },
        h("div", { class: "card-head" }, h("h3", { text: "Needs attention" })), attnBody)));
    view.root.appendChild(charts2);
    latencyCard(view, charts2, { span: "col8" });
    charts2.appendChild(h("section", { class: "card col4" },
      h("div", { class: "card-head" }, h("h3", { text: "Latest tests" }),
        h("a", { class: "link", href: "#/tests", text: "All tests →" })), testsBody));

    let bearer = null;      // /api/bearer
    let counters = null;    // /api/bearer/counters, two samples for rates
    let prevCounters = null;
    let ptp = null;         // /api/ptp/status
    let lat = null;         // /api/latency
    let cams = {};          // camera name -> Mbit/s

    // ---- path + tiles ---------------------------------------------------------
    function paintTop() {
      const s = view.store.get();
      const sig = s.signal.latest || s.status?.modem?.signal || {};
      const stale = bearer?.state === "up" && lat?.core_silent_s > 30;   // up on paper, nothing gets through
      const linkUp = bearer?.state === "up" && !stale;
      const cur = lat?.current || {};
      const coreOk = linkUp && lat?.reflector;
      const camNames = Object.keys(cams);
      const camOk = camNames.length && camNames.every((n) => cams[n] > 0.2);
      const sinr = sig.sinr;
      const radioState = !linkUp ? "err" : sinr == null ? "" : sinr < 5 ? "warn" : "ok";
      const ul = s.series.ul.length ? s.series.ul[s.series.ul.length - 1].v : null;
      const prot = Object.entries(cams).find(([n]) => n.startsWith("camera1"));

      fill(pathBody,
        topoNode(icon("camera"), "Cameras",
          camNames.length ? camNames.map((n) => `${n.replace(/-.*/, "")} ${cams[n].toFixed(1)}`).join(" · ") + " Mbit/s"
            : "not streaming", camOk ? "ok" : "warn"),
        topoLink("Ethernet", "", camOk ? "ok" : ""),
        topoNode(icon("device"), "UE", bearer?.ipv4 || "no address", linkUp ? "ok" : "err"),
        topoLink("5G NR", "", linkUp ? "ok" : "err"),
        topoNode(icon("radio"), "5G radio", s.status?.modem?.band ? `band ${s.status.modem.band}` : "", radioState),
        topoLink("N3", "", coreOk ? "ok" : ""),
        topoNode(icon("server"), "Core", linkUp ? (lat?.target || "10.45.0.1") : "unreachable",
          coreOk ? "ok" : linkUp ? "warn" : "err"));

      const g = ptp || {};
      const off = g.running ? Math.abs(g.offset_ns ?? NaN) : null;
      fill(tiles,
        tile("5G link", linkUp ? "Online" : stale ? "No traffic" : "Offline",
          linkUp ? `${bearer.apn || ""} · MTU ${bearer.mtu || "?"}` : stale ? "session stale: rebuild it on 5G Link" : "open 5G Link to connect",
          linkUp ? "ok" : "err"),
        tile("Uplink now", ul == null ? "—" : `${ul.toFixed(1)}`, "Mbit/s on the 5G link"),
        tile("Camera 1 delay", cur.protected?.up_p50 != null ? `${cur.protected.up_p50} ms` : "—",
          prot ? `protected lane · p99 ${cur.protected?.up_p99 ?? "—"} ms` : "one-way, protected lane",
          cur.protected?.up_p99 > 100 ? "warn" : cur.protected?.up_p50 != null ? "ok" : ""),
        tile("Clock offset", off == null || Number.isNaN(off) ? "off" : ns(g.offset_ns), "UE NIC vs grandmaster",
          off == null ? "warn" : off < 1000 ? "ok" : "warn"),
        tile("Signal", sinr != null ? `${sinr} dB` : "—", sig.rsrp != null ? `SINR · RSRP ${sig.rsrp} dBm` : "SINR",
          radioState));
    }

    // ---- throughput -------------------------------------------------------------
    function paintTput() {
      const s = view.store.get();
      const p = palette();
      const { ul, dl } = s.series;
      const now = Date.now();
      const lastDl = dl.length ? dl[dl.length - 1].v : null;
      fill(tputHead, h("div", { class: "head-l" }, h("h3", { text: "5G link throughput" })),
        chips(chip(p.series[0], "Up"), chip(p.series[1], "Down",
              lastDl == null ? "—" : `${lastDl.toFixed(1)} Mbit/s`)));
      clear(tputBody);
      if (!ul.length && !dl.length) {
        tputBody.appendChild(h("div", { class: "empty-chart", text: "Waiting for counters…" }));
        return;
      }
      tputBody.appendChild(h("div", { class: "chart-wrap" }, charts.timeSeries([ul, dl], {
        h: 190, colors: [p.series[0], p.series[1]], from: now - 5 * 60 * 1000, to: now, gapMs: 6000 })));
      tputBody.appendChild(axisRow("5 min ago", "", "now"));
    }

    // ---- attention ----------------------------------------------------------------
    function paintAttention() {
      const s = view.store.get();
      const items = [];
      const add = (level, text, href, action) => items.push({ level, text, href, action });
      if (bearer && bearer.state !== "up") add("err", "The 5G data call is down", "#/network", "Connect");
      else if (lat?.core_silent_s > 30) {
        add("err", `Nothing has reached the core for ${Math.round(lat.core_silent_s)} s — the session is stale`,
            "#/network", "Rebuild session");
      }
      if (lat?.config?.enabled && bearer?.state === "up" && !lat.reflector && !(lat.core_silent_s > 30)) {
        add("warn", "No latency replies from the core (reflector not running)", null, null);
      }
      if (ptp && !ptp.running) add("warn", "PTP is not running on the UE", "#/gptp", "Time Sync");
      else if (ptp && ptp.offset_ns != null && Math.abs(ptp.offset_ns) > 1000) add("warn", "PTP offset above 1 µs", "#/gptp", "Time Sync");
      const camNames = Object.keys(cams);
      if (bearer?.state === "up" && !camNames.some((n) => cams[n] > 0.2)) add("info", "Cameras are not streaming", "#/cameras", "Cameras");
      if (counters && counters.policy !== "limited") add("info", `Queue policy is "${counters.policy}" (protection off)`, "#/cameras", "Cameras");
      const sig = s.signal.latest || {};
      if (sig.sinr != null && sig.sinr < 5) add("warn", `Weak radio: SINR ${sig.sinr} dB`, "#/radio", "Radio");
      const err = s.status?.last_error;
      if (err) add("err", err, "#/system", "Logs");

      clear(attnBody);
      if (!items.length) {
        attnBody.appendChild(h("div", { class: "all-good" },
          h("span", { class: "ag-ic" }, icon("check")),
          h("div", null, h("b", { text: "All good" }),
            h("div", { class: "muted", text: "Link, cameras, clock and core are healthy." }))));
        return;
      }
      for (const it of items) {
        attnBody.appendChild(h("div", { class: `attn ${it.level}` },
          h("span", { class: "attn-dot" }),
          h("span", { class: "attn-text", text: it.text }),
          it.href ? h("a", { class: "link", href: it.href, text: `${it.action} →` }) : null));
      }
    }

    // ---- latest tests ---------------------------------------------------------------
    async function loadTests() {
      try {
        const { runs } = await view.api.results.list({ signal: view.signal });
        clear(testsBody);
        if (!runs?.length) {
          testsBody.appendChild(h("p", { class: "muted", text: "No runs yet. Start one from Tests." }));
          return;
        }
        for (const r of runs.slice(0, 4)) {
          testsBody.appendChild(h("a", { class: "mini-run", href: `#/tests?run=${r.kind}/${r.id}` },
            h("div", { class: "mr-top" }, h("b", { text: KIND_LABEL[r.kind] || r.label }),
              h("span", { class: "muted", text: when(r.started) })),
            h("div", { class: "mr-head", text: r.headline })));
        }
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) fill(testsBody, h("p", { class: "muted", text: err.message }));
      }
    }

    // ---- polling ----------------------------------------------------------------------
    const quiet = (err) => { if (!(err instanceof ApiError && err.isAborted)) console.warn(err.message); };

    async function loadFast() {
      try {
        const [b, c, l] = await Promise.all([
          view.api.bearer.get({ signal: view.signal }),
          view.api.bearer.counters({ signal: view.signal }).catch(() => null),
          view.api.latency.status({ signal: view.signal }).catch(() => null)]);
        bearer = b; lat = l;
        if (c) {
          prevCounters = counters; counters = c;
          if (prevCounters && c.t > prevCounters.t) {
            const dt = c.t - prevCounters.t;
            cams = {};
            for (const st of c.streams || []) {
              const old = prevCounters.streams?.find((x) => x.name === st.name);
              if (old) cams[st.name] = Math.max(0, ((st.bytes - old.bytes) * 8) / dt / 1e6);
            }
          }
        }
      } catch (err) { quiet(err); }
      paintTop(); paintAttention();
    }

    async function loadPtp() {
      try { ptp = await view.api.gptp.status({ signal: view.signal }); } catch (err) { quiet(err); }
    }

    view.sub((s) => s.stats, () => { paintTput(); paintTop(); });
    view.listen("signal", paintTop);

    paintTput();
    await Promise.all([loadPtp(), loadFast()]);
    loadTests();
    view.interval(loadFast, 2000);
    view.interval(loadPtp, 5000);
    view.interval(loadTests, 30000);
  },
});
