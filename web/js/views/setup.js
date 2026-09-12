/* Guided Setup — a step-by-step timeline the operator follows top to bottom.
   Order (dependency-correct): Modem → Transport → gPTP → DS-TT Qbv → Switch. */
(function (T) {
  const { el, toast } = T.util;
  const C = T.charts;

  const FALLBACK_PROFILES = [
    { name: "urllc-5qi82", description: "5QI-82: 150µs CTRL | 30µs guard | 320µs HP | 500µs all",
      cycle_ns: 1000000, slots: [[128, 150000], [0, 30000], [16, 320000], [255, 500000]] },
    { name: "short-500us", description: "500µs cycle CTRL | guard | HP | all",
      cycle_ns: 500000, slots: [[128, 100000], [0, 30000], [16, 150000], [255, 220000]] },
    { name: "long-4ms", description: "4ms video-heavy (HW max)",
      cycle_ns: 4000000, slots: [[128, 500000], [16, 1500000], [255, 2000000]] },
    { name: "all-open", description: "Baseline, no shaping",
      cycle_ns: 1000000, slots: [[255, 1000000]] },
  ];

  const STEPS = [
    { id: "modem", n: 1, title: "Modem & 5G", desc: "Check the SIM, 5G registration and signal — verify the link works." },
    { id: "transport", n: 2, title: "Transport", desc: "Choose VXLAN or Ethernet PDU, activate the session and bridge the wired device." },
    { id: "gptp", n: 3, title: "Time Sync (gPTP)", desc: "Start the IEEE 802.1AS transparent clock and wait for lock." },
    { id: "tas", n: 4, title: "TSN Scheduling (802.1Qbv)", desc: "Apply the device-side time-aware gate schedule (taprio). Requires gPTP lock." },
    { id: "switch", n: 5, title: "Switch Configuration", desc: "Push the VLAN/PCP and Qbv schedule to the wired FS TSN3220." },
  ];

  T.views.setup = {
    _local: { modem: false, transport: false, gptp: false, tas: false, switch: false },
    _mode: "vxlan", _profiles: FALLBACK_PROFILES, _tasProfile: "urllc-5qi82", _swProfile: "urllc-5qi82",

    async render(container, app) {
      try { this._profiles = (await T.api.switchProfiles()).profiles || FALLBACK_PROFILES; }
      catch (_) { this._profiles = FALLBACK_PROFILES; }
      const disc = (app.last && app.last.discovery) || (T.demo ? T.mock.discovery() : {});
      this._nics = (disc.tsn_nics || []).map((n) => n.interface);
      if (!this._vlanMap) this._vlanMap = [
        { vlan: 60, vni: 60, pcp: 7, dscp: 46, role: "control" },
        { vlan: 70, vni: 70, pcp: 4, dscp: 34, role: "hp_video" },
        { vlan: 80, vni: 80, pcp: 0, dscp: 0, role: "be_video" },
      ];

      const wrap = el("div", null, [
        el("div", { class: "setup-head" }, [
          el("div", null, [
            el("h3", { style: "margin:0;font-size:.95rem;color:var(--ink);text-transform:none;letter-spacing:0" },
              ["Guided setup"]),
            el("p", { class: "tl-desc", style: "margin-top:2px" },
              ["Follow the steps in order. Each one depends on the previous."]),
          ]),
          el("div", { class: "btn-row" }, [
            el("button", { class: "btn", onclick: () => this._reset() }, ["Reset"]),
            el("button", { class: "btn primary", onclick: () => this._runAll() }, ["Run all steps"]),
          ]),
        ]),
        el("div", { class: "timeline", id: "timeline" }, STEPS.map((s) => this._stepEl(s))),
      ]);
      container.appendChild(wrap);
      this._refresh();
    },

    _stepEl(s) {
      const body = el("div", { class: "tl-body", id: "body-" + s.id }, [this._body(s.id)]);
      return el("div", { class: "tl-item", id: "item-" + s.id }, [
        el("div", { class: "tl-gutter" }, [
          el("div", { class: "tl-node", id: "node-" + s.id }, [String(s.n)]),
          el("div", { class: "tl-line" }, []),
        ]),
        el("div", { class: "tl-card" }, [
          el("div", { class: "tl-head" }, [
            el("div", null, [el("div", { class: "tl-title" }, [s.title]),
              el("p", { class: "tl-desc" }, [s.desc])]),
            el("span", { class: "badge gray", id: "st-" + s.id }, ["Pending"]),
          ]),
          body,
          el("div", { class: "tl-result", id: "res-" + s.id, hidden: "hidden" }, []),
        ]),
      ]);
    },

    /* ---- per-step body controls ---- */
    _body(id) {
      if (id === "modem")
        return el("div", { class: "btn-row" }, [
          el("button", { class: "btn primary", id: "btn-modem", onclick: () => this._checkModem() }, ["Check modem"])]);
      if (id === "transport")
        return el("div", null, [
          el("div", { class: "choice-grid" }, [
            choice("vxlan", "🌐", "VXLAN overlay", "Over an IP PDU session (COTS modems)."),
            choice("ethernet", "🔌", "Ethernet PDU", "Native L2 (802-3 mode)."),
          ]),
          el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px" }, [
            el("label", { class: "fld" }, ["DNN", el("input", { id: "s-dnn", value: "tsn" })]),
            el("label", { class: "fld" }, ["Wired TSN NIC",
              el("select", { id: "s-nic" }, (this._nics.length ? this._nics : ["enp2s0"])
                .map((n) => el("option", { value: n }, [n])))]),
          ]),
          el("label", { class: "fld", style: "margin-bottom:4px" }, ["Traffic-class map (VLAN → PCP → DSCP)"]),
          el("p", { class: "tl-desc", style: "margin:0 0 8px" },
            ["PCP is set here per class and drives both the overlay and the switch classifiers."]),
          pcpTable(this._vlanMap),
          el("div", { class: "btn-row" }, [
            el("button", { class: "btn ghost", onclick: () => { this._vlanMap.push({ vlan: 90, vni: 90, pcp: 0, dscp: 0, role: "class" }); T.setView("setup"); } }, ["+ Add class"]),
            el("button", { class: "btn primary", id: "btn-transport", onclick: () => this._startTransport() }, ["Bring up transport"])]),
        ]);
      if (id === "gptp")
        return el("div", { class: "btn-row" }, [
          el("button", { class: "btn primary", id: "btn-gptp", onclick: () => this._startGptp() }, ["Start gPTP"])]);
      if (id === "tas")
        return el("div", null, [
          el("label", { class: "fld" }, ["Schedule preset",
            profileSelect("s-tas-profile", this._profiles, this._tasProfile, (n) => { this._tasProfile = n; this._drawGate("tas", n); })]),
          el("div", { id: "gate-tas" }, []),
          el("div", { class: "btn-row" }, [
            el("button", { class: "btn", onclick: () => this._applyTas(true) }, ["Preview command"]),
            el("button", { class: "btn primary", id: "btn-tas", onclick: () => this._applyTas(false) }, ["Apply schedule"])]),
        ]);
      if (id === "switch")
        return el("div", null, [
          el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:12px" }, [
            el("label", { class: "fld" }, ["Switch host", el("input", { id: "s-sw-host", value: "192.168.1.1" })]),
            el("label", { class: "fld" }, ["Ports", el("input", { id: "s-sw-ports", value: "1-8" })]),
            el("label", { class: "fld" }, ["Username", el("input", { id: "s-sw-user", value: "admin" })]),
            el("label", { class: "fld" }, ["Password", el("input", { id: "s-sw-pass", type: "password" })]),
          ]),
          el("label", { class: "fld" }, ["Schedule preset",
            profileSelect("s-sw-profile", this._profiles, this._swProfile, (n) => { this._swProfile = n; this._drawGate("switch", n); })]),
          el("div", { id: "gate-switch" }, []),
          el("div", { class: "btn-row" }, [
            el("button", { class: "btn", onclick: () => this._switch(true) }, ["Preview CLI"]),
            el("button", { class: "btn primary", id: "btn-switch", onclick: () => this._switch(false) }, ["Apply to switch"])]),
        ]);
      return el("div", null, []);
    },

    /* ---- actions ---- */
    async _checkModem() {
      setBusy("modem", true);
      if (T.demo) { await wait(700); this._local.modem = true;
        this._result("modem", modemResult((T.mock.status().modem))); this._refresh(); setBusy("modem", false); return; }
      try { await T.api.post ? null : null; } catch (_) {}
      try { await fetchPost("/api/modem/check"); toast("Checking modem…"); } catch (e) { toast(e.message, "err"); }
      setBusy("modem", false);
    },
    async _startTransport() {
      const body = { mode: this._mode, dnn: v("s-dnn"), wired_nics: [v("s-nic")].filter(Boolean),
        vlan_map: this._vlanMap };
      setBusy("transport", true);
      if (T.demo) { await wait(900); this._local.transport = true;
        this._result("transport", transportResult(body, this._mode, this._vlanMap)); this._refresh(); setBusy("transport", false); return; }
      try { await fetchPost("/api/transport/start", body); toast("Bringing up transport…"); } catch (e) { toast(e.message, "err"); }
      setBusy("transport", false);
    },
    async _startGptp() {
      setBusy("gptp", true);
      if (T.demo) { await wait(1000); this._local.gptp = true;
        this._result("gptp", gptpResult(T.mock.status().gptp)); this._refresh(); setBusy("gptp", false); return; }
      try { await fetchPost("/api/gptp/start"); toast("Starting gPTP…"); } catch (e) { toast(e.message, "err"); }
      setBusy("gptp", false);
    },
    async _applyTas(dry) {
      const profile = this._tasProfile;
      if (T.demo || dry) {
        const p = this._prof(profile);
        const res = el("div", null, [
          el("div", { class: "muted", style: "font-size:.82rem;margin-bottom:8px" },
            [dry ? "taprio command preview:" : "Applied device-side schedule:"]),
          C.gateTimeline(p.slots, p.cycle_ns, {}),
        ]);
        this._result("tas", res);
        if (!dry) { this._local.tas = true; this._refresh(); }
        return;
      }
      try { const r = await fetchPost("/api/tas/apply", { profile, dry_run: dry });
        this._result("tas", el("pre", { class: "log" }, [r.cmd || JSON.stringify(r, null, 2)]));
        this._local.tas = true; this._refresh(); toast("Schedule applied", "ok");
      } catch (e) { toast(e.message, "err"); }
    },
    async _switch(dry) {
      const f = { host: v("s-sw-host"), user: v("s-sw-user"), password: v("s-sw-pass"),
        ports: v("s-sw-ports"), profile: this._swProfile };
      if (T.demo && !dry) { this._result("switch", el("pre", { class: "log" }, [demoSwitchOut(f)]));
        this._local.switch = true; this._refresh(); toast("Pushed to switch", "ok"); return; }
      try {
        const r = await T.api.switchApply({ ...f, dry_run: dry });
        this._result("switch", el("pre", { class: "log" }, [dry ? (r.cli || "") : (r.output || "applied")]));
        if (!dry) { this._local.switch = true; this._refresh(); toast("Pushed to switch", "ok"); }
      } catch (e) { toast(e.message, "err"); }
    },

    async _runAll() {
      await this._checkModem(); await this._startTransport();
      await this._startGptp(); await this._applyTas(false); await this._switch(false);
    },
    _reset() { this._local = { modem: false, transport: false, gptp: false, tas: false, switch: false };
      T.setView("setup"); },

    _select(mode) { this._mode = mode;
      document.querySelectorAll(".choice").forEach((c) => c.classList.toggle("sel", c.dataset.mode === mode)); },

    _prof(name) { return this._profiles.find((p) => p.name === name) ||
      FALLBACK_PROFILES.find((p) => p.name === name) || FALLBACK_PROFILES[0]; },
    _drawGate(which, name) {
      const host = document.getElementById("gate-" + which); if (!host) return;
      const p = this._prof(name); host.innerHTML = "";
      host.appendChild(C.gateTimeline(p.slots, p.cycle_ns, {}));
    },
    _result(id, node) {
      const r = document.getElementById("res-" + id); if (!r) return;
      r.hidden = false; r.innerHTML = ""; r.appendChild(node);
    },

    onData(last) {
      if (!T.demo) {
        const s = last.status || {};
        this._local.modem = !!(s.modem && s.modem.registered);
        this._local.transport = !!s.transport;
        this._local.gptp = !!(s.gptp && (s.gptp.locked || s.gptp.running));
        this._local.tas = !!(s.tas && s.tas.applied && Object.keys(s.tas.applied).length);
      }
      this._refresh();
    },

    _refresh() {
      const order = STEPS.map((s) => s.id);
      let firstIncomplete = order.findIndex((id) => !this._local[id]);
      if (firstIncomplete < 0) firstIncomplete = order.length;
      STEPS.forEach((s, i) => {
        const item = document.getElementById("item-" + s.id);
        const node = document.getElementById("node-" + s.id);
        const st = document.getElementById("st-" + s.id);
        if (!item) return;
        const done = this._local[s.id];
        const active = i === firstIncomplete;
        const locked = i > firstIncomplete;
        item.className = "tl-item" + (done ? " done" : active ? " active" : locked ? " locked" : "");
        if (node) node.innerHTML = done ? T.icon("check") : String(s.n);
        if (st) { st.className = "badge " + (done ? "green" : active ? "blue" : "gray");
          st.textContent = done ? "Done" : active ? "Ready" : "Waiting"; }
      });
      // seed gate previews
      this._drawGate("tas", this._tasProfile); this._drawGate("switch", this._swProfile);
      this._select(this._mode);
    },
  };

  /* ---- helpers ---- */
  function choice(mode, ico, title, desc) {
    return el("div", { class: "choice", "data-mode": mode, onclick: () => T.views.setup._select(mode) }, [
      el("div", { class: "pill-ico" }, [ico]), el("h4", null, [title]), el("p", null, [desc])]);
  }
  function profileSelect(id, profiles, sel, onChange) {
    const s = el("select", { id, onchange: (e) => onChange(e.target.value) },
      profiles.map((p) => el("option", { value: p.name, selected: p.name === sel ? "selected" : undefined },
        [p.name + " — " + (p.description || "")])));
    return s;
  }
  function modemResult(m) {
    return el("div", null, [
      row("SIM", m.sim_ready === false ? "Not ready" : "Ready", m.sim_ready !== false),
      row("Registration", m.registered ? ("Registered · " + (m.operator || "5G")) : "Not registered", m.registered),
      signalBars(m.signal || {}),
    ]);
  }
  function transportResult(body, mode, map) {
    const classes = (map || []).map((c) => (c.role || "class") + " V" + c.vlan + "/PCP" + c.pcp + "/DSCP" + c.dscp).join(", ");
    return el("div", null, [
      row("Mode", mode.toUpperCase(), true), row("DNN", body.dnn, true),
      row("Bridge", "ds-tt-br0", true), row("Wired NIC", (body.wired_nics || []).join(", "), true),
      row("MTU", mode === "vxlan" ? "1450" : "1500", true),
      row("Classes", classes || "—")]);
  }
  function pcpTable(map) {
    const head = el("tr", null, ["Class", "VLAN", "VNI", "PCP", "DSCP", ""].map((h) => el("th", null, [h])));
    const num = (obj, key, min, max) => el("input", { type: "number", class: "qbv-int",
      value: obj[key], min: String(min), max: String(max),
      onchange: (e) => { obj[key] = Math.max(min, Math.min(max, +e.target.value || 0)); } });
    const rows = map.map((c, i) => el("tr", null, [
      el("td", null, [el("input", { value: c.role || "", style: "width:96px",
        onchange: (e) => { c.role = e.target.value; } })]),
      el("td", null, [num(c, "vlan", 1, 4094)]), el("td", null, [num(c, "vni", 1, 16000000)]),
      el("td", null, [num(c, "pcp", 0, 7)]), el("td", null, [num(c, "dscp", 0, 63)]),
      el("td", null, [el("button", { class: "btn ghost", onclick: () => { map.splice(i, 1); T.setView("setup"); } }, ["✕"])]),
    ]));
    return el("div", { style: "overflow-x:auto" }, [el("table", { class: "tbl qbv-tbl" },
      [el("thead", null, [head]), el("tbody", null, rows)])]);
  }
  function gptpResult(g) {
    return el("div", { style: "display:flex;gap:16px;align-items:center" }, [
      C.gauge(g.locked ? 100 : 0, { size: 92, color: g.locked ? T.theme.green : T.theme.faint,
        label: g.locked ? "LOCK" : "—", big: 13, sub: "802.1AS" }),
      el("div", { style: "flex:1" }, [row("Offset", (g.offset_ns != null ? g.offset_ns + " ns" : "—"), true),
        row("Path delay", (g.path_delay_ns != null ? g.path_delay_ns + " ns" : "—"), true),
        row("Grandmaster", g.grandmaster || "—", true)])]);
  }
  function signalBars(sig) {
    const bar = (label, val, lo, hi, unit) => {
      const pct = val == null ? 0 : Math.max(0, Math.min(100, ((val - lo) / (hi - lo)) * 100));
      return el("div", { class: "bar-row" }, [el("span", { class: "lab" }, [label]),
        C.meter(pct, { color: pct > 66 ? T.theme.green : pct > 33 ? T.theme.amber : T.theme.red }),
        el("span", { class: "val" }, [val == null ? "—" : val + " " + unit])]);
    };
    return el("div", { class: "bars", style: "margin-top:10px" }, [
      bar("RSRP", sig.rsrp, -110, -70, "dBm"), bar("RSRQ", sig.rsrq, -20, -3, "dB"),
      bar("SINR", sig.sinr, 0, 30, "dB")]);
  }
  function row(k, val, ok) {
    const v = (ok === true) ? el("span", { class: "badge green" }, [String(val)])
      : (ok === false) ? el("span", { class: "badge amber" }, [String(val)])
      : el("span", { class: "v mono" }, [String(val)]);
    return el("div", { class: "row" }, [el("span", { class: "k" }, [k]), el("span", { class: "v" }, [v])]);
  }
  function setBusy(id, busy) { const b = document.getElementById("btn-" + id);
    if (b) { b.disabled = busy; if (busy) b.dataset.t = b.textContent, b.textContent = "Working…";
      else if (b.dataset.t) b.textContent = b.dataset.t; } }
  function v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ""; }
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function fetchPost(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json().catch(() => ({}));
  }
  function demoSwitchOut(f) {
    return `[*] ${f.user}@${f.host} ports ${f.ports} profile ${f.profile}\n` +
      `[+] tsn flow classifiers installed\n[+] gate-control-list programmed\n` +
      `[+] tsn qbv enable / config-change\n[+] save force\n[+] Applied.`;
  }
})(window.TSN);
