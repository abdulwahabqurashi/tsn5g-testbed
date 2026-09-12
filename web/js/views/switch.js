/* TSN Switch — push 802.1Qbv to the FS TSN3220: named presets OR a dynamic,
   user-defined gate schedule you build and configure on the switch on the fly. */
(function (T) {
  const { el, toast } = T.util;
  const C = T.charts;

  const FALLBACK = [
    { name: "urllc-5qi82", description: "5QI-82: 150µs CTRL | 30µs guard | 320µs HP | 500µs all",
      cycle_ns: 1000000, slots: [[128, 150000], [0, 30000], [16, 320000], [255, 500000]] },
    { name: "short-500us", description: "500µs cycle CTRL | guard | HP | all",
      cycle_ns: 500000, slots: [[128, 100000], [0, 30000], [16, 150000], [255, 220000]] },
    { name: "long-4ms", description: "4ms video-heavy (HW max)",
      cycle_ns: 4000000, slots: [[128, 500000], [16, 1500000], [255, 2000000]] },
    { name: "all-open", description: "Baseline, no shaping",
      cycle_ns: 1000000, slots: [[255, 1000000]] },
  ];

  T.views.switch = {
    _mode: "preset", _profiles: FALLBACK, _sel: "urllc-5qi82", _editor: null,
    async render(container) {
      try { this._profiles = (await T.api.switchProfiles()).profiles || FALLBACK; }
      catch (_) { this._profiles = FALLBACK; }
      const status = T.demo ? T.mock.switchStatus() : null;

      const left = el("div", { class: "card col6" }, [
        el("div", { class: "card-head" }, [el("h3", null, ["Apply 802.1Qbv"]),
          el("span", { class: "hint" }, ["FS TSN3220"])]),
        el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:12px" }, [
          field("Switch host", "sw-host", (status && status.host) || "192.168.1.1"),
          field("Ports", "sw-ports", "1-8", "text", "e.g. 1-8 or 1,3,5"),
          field("Username", "sw-user", "admin"),
          field("Password", "sw-pass", "", "password", "per apply"),
        ]),
        el("div", { class: "seg", style: "margin:6px 0 4px" }, [
          segBtn("preset", "Preset", this._mode, (m) => this._setMode(m)),
          segBtn("custom", "Custom (dynamic)", this._mode, (m) => this._setMode(m)),
        ]),
        el("div", { id: "sw-config" }, []),
        el("div", { class: "btn-row" }, [
          el("button", { class: "btn", onclick: () => this._apply(true) }, ["Preview CLI"]),
          el("button", { class: "btn primary", onclick: () => this._apply(false) }, ["Apply"]),
          el("button", { class: "btn danger", onclick: () => this._disable() }, ["Disable Qbv"]),
        ]),
      ]);

      const right = el("div", { class: "card col6" }, [
        el("div", { class: "card-head" }, [el("h3", null, ["Gate schedule"]),
          el("span", { class: "hint", id: "gt-name" }, [this._sel])]),
        el("div", { id: "gate-viz" }, []),
        C.legend([{ color: T.theme.control, label: "CONTROL (Q7)" },
                  { color: T.theme.hpvideo, label: "HP VIDEO (Q4)" },
                  { color: T.theme.bevideo, label: "BEST-EFFORT (Q0)" }]),
        statusBlock(status),
      ]);

      container.appendChild(el("div", { class: "grid" }, [left, right]));
      this._cfg = document.getElementById("sw-config");
      this._viz = document.getElementById("gate-viz");
      this._setMode(this._mode);
    },

    _setMode(mode) {
      this._mode = mode;
      document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.seg === mode));
      this._cfg.innerHTML = "";
      if (mode === "preset") {
        this._cfg.appendChild(presetList(this._profiles, this._sel, (n) => this._select(n)));
        this._renderGate();
      } else {
        this._editor = T.qbvEditor(null);
        this._cfg.appendChild(this._editor.node);
        this._viz.innerHTML = "";  // custom editor has its own live preview
        document.getElementById("gt-name").textContent = "custom";
      }
    },
    _select(name) { this._sel = name;
      document.querySelectorAll(".preset").forEach((p) => p.classList.toggle("sel", p.dataset.name === name));
      document.getElementById("gt-name").textContent = name; this._renderGate(); },
    _renderGate() {
      const p = this._profiles.find((x) => x.name === this._sel) || FALLBACK[0];
      this._viz.innerHTML = ""; this._viz.appendChild(C.gateTimeline(p.slots, p.cycle_ns, {}));
    },
    _form() { return { host: v("sw-host"), user: v("sw-user"), password: v("sw-pass"), ports: v("sw-ports") }; },

    async _apply(dry) {
      const f = this._form();
      const body = this._mode === "custom"
        ? { ...f, ...this._editor.get(), dry_run: dry }
        : { ...f, profile: this._sel, dry_run: dry };
      try {
        if (T.demo && !dry) { showResult("Applied — switch output (demo)", demoOut(f, this._mode, body)); toast("Applied", "ok"); return; }
        const res = await T.api.switchApply(body);
        showResult(dry ? "Preview — generated CLI (not sent)" : "Applied — switch output",
          dry ? (res.cli || "") : (res.output || "(applied)"));
        if (!dry) toast("Applied", "ok");
      } catch (e) { toast("Apply failed: " + e.message, "err"); }
    },
    async _disable() {
      const f = this._form();
      try {
        if (T.demo) return showResult("Qbv disabled (demo)", `[+] undo tsn qbv enable on ${f.ports}\n[+] save force\n[+] switch reachable.`);
        const res = await T.api.switchDisable(f);
        showResult("Qbv disabled — switch output", res.output || "(disabled)"); toast("Qbv disabled", "ok");
      } catch (e) { toast("Disable failed: " + e.message, "err"); }
    },
  };

  function field(label, id, val, type, ph) {
    return el("label", { class: "fld" }, [label,
      el("input", { id, value: val, type: type || "text", placeholder: ph || "" })]);
  }
  function segBtn(key, label, cur, onClick) {
    return el("button", { class: "seg-b" + (key === cur ? " on" : ""), "data-seg": key,
      onclick: () => onClick(key) }, [label]);
  }
  function presetList(profiles, sel, onSel) {
    return el("div", null, profiles.map((p) =>
      el("label", { class: "preset" + (p.name === sel ? " sel" : ""), "data-name": p.name, onclick: () => onSel(p.name) }, [
        el("input", { type: "radio", name: "preset", checked: p.name === sel ? "checked" : undefined }),
        el("div", null, [el("div", { class: "p-name" }, [p.name]), el("div", { class: "p-desc" }, [p.description || ""])]),
      ])));
  }
  function statusBlock(status) {
    if (!status) return el("div", null, []);
    const rv = (k, v) => el("div", { class: "row" }, [el("span", { class: "k" }, [k]), el("span", { class: "v mono" }, [String(v)])]);
    return el("div", { style: "margin-top:16px" }, [
      el("div", { class: "row" }, [el("span", { class: "k" }, ["Switch"]),
        el("span", { class: "v" }, [el("span", { class: "badge " + (status.reachable ? "green" : "red") }, [status.reachable ? "Reachable" : "Offline"])])]),
      rv("Active profile", status.profile), rv("Cycle time", (status.cycle_ns / 1000) + " µs"),
      rv("Qbv ports", (status.ports || []).join(", ")),
      el("div", { class: "row" }, [el("span", { class: "k" }, ["PTP"]),
        el("span", { class: "v" }, [el("span", { class: "badge " + (status.ptp_locked ? "green" : "amber") }, [status.ptp_locked ? "Locked" : "Unlocked"])])]),
    ]);
  }
  function v(id) { return document.getElementById(id).value.trim(); }
  function showResult(title, text) { T.util.drawer(title, el("pre", { class: "log" }, [text])); }
  function demoOut(f, mode, body) {
    const sched = mode === "custom" ? `${body.slots.length} windows, cycle ${(body.cycle_ns/1000)}µs` : `preset ${body.profile}`;
    return `[*] ${f.user}@${f.host}  ports ${f.ports}\n[*] ${sched}\n` +
      `[+] tsn flow classifiers installed\n[+] gate-control-list programmed\n` +
      `[+] tsn qbv enable / config-change\n[+] save force\n[+] Applied.`;
  }
})(window.TSN);
