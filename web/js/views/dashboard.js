/* Dashboard — hero throughput chart, KPIs, signal, gPTP, topology, TSN streams. */
(function (T) {
  const { el } = T.util;
  const C = T.charts;

  T.views.dashboard = {
    render(container) {
      const grid = el("div", { class: "grid" }, [
        card("throughput", "5G Link Throughput", "col8"),
        card("conn", "Connection"),
        card("signal", "Signal Quality"),
        card("gptp", "Time Sync · gPTP"),
        card("health", "System Health"),
        card("path", "Network Path", "col12"),
        card("streams", "TSN Streams", "col12"),
      ]);
      container.appendChild(grid);
      this._b = {};
      ["throughput", "conn", "signal", "gptp", "health", "path", "streams"].forEach(
        (k) => (this._b[k] = grid.querySelector("#b-" + k)));
    },

    onData(last) {
      if (!this._b) return;
      const s = last.status || {}, m = s.modem || {}, g = s.gptp || {}, t = s.transport || {};
      const hist = (T.app && T.app.history) || { ul: [], dl: [], offset: [] };
      const series = T.demo ? T.mock.series() : { ul: hist.ul, dl: hist.dl, offset: hist.offset };

      // Throughput
      const ul = series.ul, dl = series.dl;
      const curUL = ul[ul.length - 1] || 0, curDL = dl[dl.length - 1] || 0;
      set(this._b.throughput, [
        el("div", { class: "stat-hero" }, [
          el("span", { class: "num" }, [ (curUL + curDL).toFixed(0) ]),
          el("span", { class: "unit" }, ["Mbps total"]),
        ]),
        el("div", { class: "stat-sub" }, [
          `▲ ${curUL.toFixed(0)} Mbps uplink   ·   ▼ ${curDL.toFixed(0)} Mbps downlink` ]),
        C.area(ul, { h: 150, color: T.theme.blue }),
        C.legend([{ color: T.theme.blue, label: "Uplink (n77)" },
                  { color: T.theme.teal, label: "Downlink" }]),
      ]);
      // overlay DL line on the same chart area
      const dlChart = C.area(dl, { h: 44, color: T.theme.teal, grid: false });
      this._b.throughput.appendChild(dlChart);

      // Connection KPIs + one-click Connect control
      const connecting = s.state === "connecting";
      const busy = connecting || s.state === "stopping";
      const up = s.state === "running";
      const connKids = [
        el("div", { class: "big-state" }, [prettyState(s.state)]),
      ];
      if (connecting && s.step) {
        connKids.push(el("div", { class: "muted", style: "margin-top:2px;font-size:.82rem" },
          ["Step: " + cap(s.step)]));
      }
      if (s.last_error && s.state === "error") {
        connKids.push(el("div", { class: "muted", style: "margin-top:2px;font-size:.82rem;color:var(--red)" },
          [String(s.last_error)]));
      }
      connKids.push(el("div", { class: "kpis", style: "margin-top:14px" }, [
        kpi("Transport", (t.mode || s.active_mode || "—").toUpperCase()),
        kpi("DNN", m.dnn || "tsn"),
        kpi("UE IP", m.ipv4 || "—"),
        kpi("Band", m.band || "—"),
      ]));
      connKids.push(el("div", { class: "btn-row" }, [
        (up || busy)
          ? el("button", { class: "btn danger", disabled: busy ? "disabled" : undefined,
              onclick: () => this._disconnect() }, [connecting ? "Connecting…" : up ? "Disconnect" : "Stopping…"])
          : el("button", { class: "btn primary", onclick: () => this._connect() }, ["Connect to 5G"]),
        el("button", { class: "btn", onclick: () => T.setView("setup") }, ["Guided setup"]),
      ]));
      set(this._b.conn, connKids);

      // Signal
      const sig = m.signal || {};
      const q = quality(sig.rsrp);
      set(this._b.signal, [
        el("div", { class: "gauge-wrap" }, [
          C.gauge(q, { size: 108, color: q > 66 ? T.theme.green : q > 33 ? T.theme.amber : T.theme.red,
            sub: "quality" }),
          el("div", { class: "bars", style: "flex:1" }, [
            bar("RSRP", sig.rsrp, -110, -70, "dBm"),
            bar("RSRQ", sig.rsrq, -20, -3, "dB"),
            bar("SINR", sig.sinr, 0, 30, "dB"),
          ]),
        ]),
      ]);

      // gPTP
      set(this._b.gptp, [
        el("div", { class: "gauge-wrap" }, [
          C.gauge(g.locked ? 100 : 0, { size: 100,
            color: g.locked ? T.theme.green : T.theme.faint,
            label: g.locked ? "LOCK" : "—", big: 15, sub: "802.1AS" }),
          el("div", { style: "flex:1" }, [
            row("Offset", (g.offset_ns != null ? g.offset_ns + " ns" : "—")),
            row("Path delay", (g.path_delay_ns != null ? g.path_delay_ns + " ns" : "—")),
            row("Grandmaster", g.grandmaster || "—"),
          ]),
        ]),
        C.spark(series.offset, { h: 40, color: T.theme.green }),
      ]);

      // Health
      const h = last.health || {};
      const checks = h.checks || {};
      set(this._b.health, Object.keys(checks).length
        ? Object.entries(checks).map(([k, v]) =>
            el("div", { class: "row" }, [
              el("span", { class: "k", style: "display:flex;align-items:center;gap:8px" }, [
                el("span", { class: "dot " + (v ? "ok" : "err") }, []), cap(k)]),
              el("span", { class: "v" }, [badge(v ? "OK" : "DOWN", v ? "green" : "red")]),
            ]))
        : [el("p", { class: "muted" }, ["No health data."])]);

      // Path (topology)
      set(this._b.path, [topology(T.demo ? T.mock.topology() : liveTopo(last))]);

      // Streams — live per-class traffic on the VXLAN overlay
      set(this._b.streams, [streamsTable(T.demo ? T.mock.streams() : liveStreams(last))]);
    },

    /* One-click connect: the backend fills in transport/DNN/NIC defaults from
       config, so we only pass the chosen transport mode. */
    async _connect() {
      if (T.demo) { T.util.toast("Demo mode — connect runs on the UE only"); return; }
      const cfg = (T.app.last && T.app.last.config) || {};
      const mode = (cfg.transport && cfg.transport.mode) || "vxlan";
      try {
        await T.api.connect({ mode });
        T.util.toast("Connecting to 5G…");
      } catch (e) { T.util.toast(e.message || "connect failed", "err"); }
    },
    async _disconnect() {
      if (T.demo) { T.util.toast("Demo mode — disconnect runs on the UE only"); return; }
      try {
        await T.api.disconnect();
        T.util.toast("Disconnecting…");
      } catch (e) { T.util.toast(e.message || "disconnect failed", "err"); }
    },
  };

  /* ---- builders ---- */
  function card(id, title, col) {
    return el("div", { class: "card" + (col ? " " + col : "") }, [
      el("div", { class: "card-head" }, [el("h3", null, [title])]),
      el("div", { id: "b-" + id }, []),
    ]);
  }
  function set(node, kids) { node.innerHTML = ""; kids.forEach((k) => node.appendChild(k)); }
  function kpi(label, val) {
    return el("div", { class: "kpi" }, [
      el("div", { class: "kpi-label" }, [label]),
      el("div", { class: "kpi-val" }, [String(val)]),
    ]);
  }
  function row(k, v) {
    return el("div", { class: "row" }, [el("span", { class: "k" }, [k]),
      el("span", { class: "v mono" }, [v == null ? "—" : String(v)])]);
  }
  function badge(text, kind) { return el("span", { class: "badge " + kind }, [text]); }
  function bar(label, val, lo, hi, unit) {
    const pct = val == null ? 0 : Math.max(0, Math.min(100, ((val - lo) / (hi - lo)) * 100));
    const meter = C.meter(pct, { color: pct > 66 ? T.theme.green : pct > 33 ? T.theme.amber : T.theme.red });
    return el("div", { class: "bar-row" }, [
      el("span", { class: "lab" }, [label]), meter,
      el("span", { class: "val" }, [val == null ? "— " + unit : val + " " + unit]),
    ]);
  }
  function topology(topo) {
    const wrap = el("div", { class: "topo" }, []);
    topo.nodes.forEach((n, i) => {
      wrap.appendChild(el("div", { class: "topo-node " + (n.kind === "ue" ? "ue" : "") }, [
        el("div", { class: "tn-ic", html: T.icon(iconFor(n.kind)) }, []),
        el("div", { class: "tn-name" }, [n.label]),
        el("div", { class: "tn-sub" }, [n.sub || ""]),
      ]));
      const link = topo.links[i];
      if (link) {
        const qcls = link.quality >= 95 ? "green" : link.quality >= 80 ? "amber" : "red";
        wrap.appendChild(el("div", { class: "topo-link " + (link.wireless ? "wireless" : "") }, [
          el("div", { class: "tl-q badge " + qcls }, [link.quality + "%"]),
          el("div", { class: "tl-line" }, []),
          el("div", { class: "tl-lbl" }, [link.label || ""]),
        ]));
      }
    });
    return wrap;
  }
  // Live per-class traffic: map each transport class (VLAN) to its vxlanNN
  // interface counters. Rate/packets/drops are real; per-flow latency/loss need
  // an active probe we don't have, so they are shown as "—" rather than faked.
  function liveStreams(last) {
    const t = (last.status && last.status.transport) || {};
    const ifs = (last.stats && last.stats.interfaces) || {};
    return (t.classes || []).map((c) => {
      const s = ifs["vxlan" + c.vlan] || {};
      const rate = (((s.tx_bytes_per_s || 0) + (s.rx_bytes_per_s || 0)) * 8) / 1e6;
      const pkts = (s.tx_packets != null || s.rx_packets != null)
        ? (s.tx_packets || 0) + (s.rx_packets || 0) : null;
      const drops = (s.tx_dropped || 0) + (s.rx_dropped || 0);
      return { role: c.role || "class", vlan: c.vlan, pcp: c.pcp, dscp: c.dscp,
               rate: rate, pkts: pkts, drops: drops };
    });
  }
  function streamsTable(streams) {
    if (!streams || !streams.length)
      return el("p", { class: "muted" }, ["No active traffic classes (connect a transport first)."]);
    const head = el("tr", null, ["Class", "VLAN", "PCP", "DSCP", "Rate", "Packets", "Drops"]
      .map((h) => el("th", null, [h])));
    const rows = streams.map((s) => {
      const drops = s.drops || 0;
      return el("tr", null, [
        el("td", null, [el("div", { class: "cell-name" }, [
          el("span", { class: "cell-icon", style: "background:" + (s.color || "#0b74ff") }, [String(s.pcp)]),
          s.role])]),
        td(s.vlan), td("PCP " + s.pcp), td(s.dscp),
        td((s.rate != null ? s.rate.toFixed(2) : "—") + " Mbps"),
        td(s.pkts != null ? Number(s.pkts).toLocaleString() : "—"),
        el("td", null, [badge(String(drops), drops ? "amber" : "green")]),
      ]);
    });
    return el("table", { class: "tbl" }, [el("thead", null, [head]), el("tbody", null, rows)]);
  }
  function td(v) { return el("td", { class: "mono" }, [v == null ? "—" : String(v)]); }

  function iconFor(kind) {
    return { device: "device", ue: "radio", cloud: "cloud", server: "server", switch: "sw" }[kind] || "chip";
  }
  function quality(rsrp) { if (rsrp == null) return 0;
    return Math.max(0, Math.min(100, ((rsrp + 110) / 40) * 100)); }
  function prettyState(s) {
    return ({ running: "Connected", idle: "Not connected", connecting: "Connecting…",
      error: "Error", offline: "Service offline" })[s] || s || "—"; }
  function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

  /* live topology derived from real state: 5G link quality from signal, core
     hop from the measured latency to the VXLAN endpoint. */
  function liveTopo(last) {
    const s = last.status || {}, m = s.modem || {}, sig = m.signal || {};
    const link = (last.stats && last.stats.link) || {};
    const connected = s.state === "running";
    const wq = connected ? sigQuality(sig.rsrp) : 0;
    const coreLat = link.latency_ms;
    const coreQ = coreLat != null ? 100 : 0;
    return { nodes: [
      { id: "ue", label: "This UE", sub: "DS-TT · " + (m.model || "modem"), kind: "ue" },
      { id: "5g", label: "5G Network", sub: (m.band || "NR") + (m.operator ? " · " + m.operator : ""), kind: "cloud" },
      { id: "core", label: "NW-TT", sub: "Core " + (link.target || ""), kind: "server" }],
      links: [
        { from: "ue", to: "5g", quality: wq, label: m.band ? (m.band + " · " + (m.ipv4 || "")) : "—", wireless: true },
        { from: "5g", to: "core", quality: coreQ, label: coreLat != null ? coreLat.toFixed(0) + " ms" : "—" }] };
  }
  function sigQuality(rsrp) {
    if (rsrp == null) return 0;
    return Math.max(0, Math.min(100, Math.round(((rsrp + 120) / 70) * 100)));  // -120..-50 dBm -> 0..100
  }
})(window.TSN);
