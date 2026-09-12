/* Speed Test — WiFiman-style: big live number over a filling blue area graph. */
(function (T) {
  const { el, toast } = T.util;
  const C = T.charts;

  T.views.speedtest = {
    _timer: null,
    render(container) {
      this._stop();
      const wrap = el("div", { class: "grid" }, [
        el("div", { class: "card col8 speed-hero" }, [
          el("div", { class: "speed-phase", id: "sp-phase" }, ["Ready"]),
          el("div", { class: "speed-num" }, [
            el("span", { id: "sp-num" }, ["0.00"]),
            el("span", { class: "speed-unit" }, ["Mbps"]),
          ]),
          el("div", { class: "speed-sub", id: "sp-sub" }, ["Test throughput over the 5G link"]),
          el("div", { id: "sp-chart", class: "speed-chart" }, []),
          el("div", { class: "btn-row", style: "justify-content:center" }, [
            el("button", { class: "btn primary", id: "sp-btn", onclick: () => this._start() }, ["Start test"]),
          ]),
        ]),
        el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Results"])]),
          el("div", { class: "kpis", style: "grid-template-columns:1fr 1fr" }, [
            kpi("Download", "sp-dl", "Mbps"), kpi("Upload", "sp-ul", "Mbps"),
            kpi("Ping", "sp-ping", "ms"), kpi("Jitter", "sp-jit", "ms"),
          ]),
          el("div", { class: "row", style: "margin-top:12px" }, [
            el("span", { class: "k" }, ["Server"]),
            el("span", { class: "v mono", id: "sp-server" }, [T.demo ? "iperf3 · core (demo)" : "—"]),
          ]),
        ]),
      ]);
      container.appendChild(wrap);
      this._els = ids(["sp-phase", "sp-num", "sp-sub", "sp-chart", "sp-btn",
        "sp-dl", "sp-ul", "sp-ping", "sp-jit", "sp-server"]);
      this._draw([0, 0]);
    },

    _start() {
      if (this._running) return;
      this._running = true;
      this._els["sp-btn"].disabled = true;
      this._els["sp-btn"].textContent = "Testing…";
      if (T.demo) return this._simulate();
      this._live();
    },

    /* ----- demo simulation (WiFiman-style ramp) ----- */
    _simulate() {
      const seq = [
        { phase: "Ping", ms: 700 },
        { phase: "Download", target: 182, ms: 3200, key: "sp-dl" },
        { phase: "Upload", target: 88, ms: 3000, key: "sp-ul" },
      ];
      this._els["sp-ping"].firstChild.textContent = "9.4";
      this._els["sp-jit"].firstChild.textContent = "1.3";
      let si = 0, samples = [];
      const runPhase = () => {
        if (si >= seq.length) return this._finish();
        const s = seq[si++];
        this._els["sp-phase"].textContent = s.phase;
        this._els["sp-phase"].style.color = s.phase === "Upload" ? T.theme.teal : T.theme.blue;
        if (s.phase === "Ping") { setTimeout(runPhase, s.ms); return; }
        samples = []; const t0 = performance.now();
        const tick = () => {
          const p = Math.min(1, (performance.now() - t0) / s.ms);
          const val = s.target * (0.35 + 0.65 * p) * (0.9 + Math.random() * 0.2);
          samples.push(val); if (samples.length > 60) samples.shift();
          this._els["sp-num"].textContent = val.toFixed(2);
          this._els[s.key].firstChild.textContent = Math.max(
            +this._els[s.key].firstChild.textContent || 0, val).toFixed(1);
          this._draw(samples, s.phase === "Upload" ? T.theme.teal : T.theme.blue);
          if (p < 1) this._timer = requestAnimationFrame(tick); else setTimeout(runPhase, 250);
        };
        tick();
      };
      runPhase();
    },

    /* ----- live: drive the backend iperf3 test ----- */
    async _live() {
      try { await post("/api/speedtest/run", {}); } catch (e) { toast(e.message, "err"); this._finish(); return; }
      this._poll = setInterval(async () => {
        let r; try { r = await get("/api/speedtest/result"); } catch (_) { return; }
        this._els["sp-phase"].textContent = cap(r.phase || r.state || "");
        this._els["sp-server"].textContent = r.server || "—";
        if (r.samples && r.samples.length) {
          this._els["sp-num"].textContent = r.samples[r.samples.length - 1].toFixed(2);
          this._draw(r.samples);
        }
        if (r.download_mbps != null) this._els["sp-dl"].firstChild.textContent = r.download_mbps;
        if (r.upload_mbps != null) this._els["sp-ul"].firstChild.textContent = r.upload_mbps;
        if (r.ping_ms != null) this._els["sp-ping"].firstChild.textContent = r.ping_ms;
        if (r.jitter_ms != null) this._els["sp-jit"].firstChild.textContent = r.jitter_ms;
        if (r.state === "done" || r.state === "error") {
          if (r.state === "error") toast(r.error || "speed test failed", "err");
          clearInterval(this._poll); this._finish();
        }
      }, 500);
    },

    _finish() {
      this._running = false;
      this._els["sp-phase"].textContent = "Complete";
      this._els["sp-phase"].style.color = T.theme.green;
      this._els["sp-btn"].disabled = false;
      this._els["sp-btn"].textContent = "Run again";
    },
    _draw(samples, color) {
      const host = this._els["sp-chart"]; host.innerHTML = "";
      host.appendChild(C.area(samples.length ? samples : [0, 0], { h: 210, color: color || T.theme.blue, min: 0 }));
    },
    _stop() {
      this._running = false;
      if (this._timer) cancelAnimationFrame(this._timer);
      if (this._poll) clearInterval(this._poll);
    },
  };

  function kpi(label, id, unit) {
    return el("div", { class: "kpi" }, [el("div", { class: "kpi-label" }, [label]),
      el("div", { class: "kpi-val", id }, ["—", el("small", null, [" " + unit])])]);
  }
  function ids(list) { const o = {}; list.forEach((i) => (o[i] = document.getElementById(i))); return o; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  async function get(p) { const r = await fetch(p); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
  async function post(p, b) { const r = await fetch(p, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
    if (!r.ok) throw new Error("HTTP " + r.status); return r.json().catch(() => ({})); }
})(window.TSN);
