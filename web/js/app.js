/* App shell: navigation, polling loop, demo-mode data source, status fan-out. */
(function (T) {
  const titles = {
    dashboard: "Dashboard", setup: "Guided Setup", speedtest: "Speed Test",
    network: "Network", transport: "Transport", switch: "TSN Switch",
    gptp: "Time Sync", diagnostics: "Diagnostics",
  };

  const app = {
    current: "dashboard",
    last: { status: null, health: null, stats: null, discovery: null, config: null },
    // Rolling live time-series built from the instantaneous values each poll
    // returns (backend reports rates/offset per sample; we keep the history).
    history: { ul: [], dl: [], offset: [], latency: [] },
  };
  T.app = app;

  const HCAP = 48;
  function recordHistory() {
    const push = (k, v) => { const a = app.history[k]; a.push(v); if (a.length > HCAP) a.shift(); };
    const ifs = (app.last.stats && app.last.stats.interfaces) || {};
    const w = ifs.wwan0 || null;
    push("ul", w ? +(((w.tx_bytes_per_s || 0) * 8) / 1e6).toFixed(2) : 0);  // uplink Mbps
    push("dl", w ? +(((w.rx_bytes_per_s || 0) * 8) / 1e6).toFixed(2) : 0);  // downlink Mbps
    const g = (app.last.status && app.last.status.gptp) || {};
    push("offset", g.offset_ns != null ? g.offset_ns : 0);
    const lk = (app.last.stats && app.last.stats.link) || {};
    push("latency", lk.latency_ms != null ? lk.latency_ms : 0);
  }

  function setView(name) {
    if (!T.views[name]) name = "dashboard";
    app.current = name;
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === name));
    document.getElementById("view-title").textContent = titles[name] || name;
    const content = document.getElementById("content");
    content.innerHTML = "";
    T.views[name].render(content, app);
    if (T.views[name].onData && app.last.status) T.views[name].onData(app.last);
  }
  T.setView = setView;

  function applyHealth(health, status) {
    const badge = document.getElementById("health-badge");
    const state = (status && status.state) || "…";
    let cls = "is-idle", label = state;
    if (state === "running") { cls = health && health.healthy ? "is-ok" : "is-warn";
      label = health && health.healthy ? "Connected" : "Connected · issues"; }
    else if (state === "error") { cls = "is-err"; label = "Error"; }
    else if (state === "connecting") { cls = "is-warn"; label = "Connecting…"; }
    else if (state === "idle") { cls = "is-idle"; label = "Not connected"; }
    else if (state === "offline") { cls = "is-err"; label = "Service offline"; }
    badge.className = "health-badge " + cls;
    badge.querySelector(".label").textContent = label;
    const pill = document.getElementById("conn-pill");
    pill.className = "conn-pill " + cls;
    document.getElementById("conn-label").textContent = label;
  }

  async function poll() {
    if (T.demo) {
      T.mock.tick();
      app.last.status = T.mock.status();
      app.last.health = T.mock.health();
      app.last.stats = T.mock.stats();
      app.last.discovery = T.mock.discovery();
    } else {
      try {
        const [status, health, stats] = await Promise.all([
          T.api.status(), T.api.health(), T.api.stats()]);
        app.last.status = status; app.last.health = health; app.last.stats = stats;
      } catch (e) { applyHealth(null, { state: "offline" }); return; }
      recordHistory();
    }
    applyHealth(app.last.health, app.last.status);
    const v = T.views[app.current];
    if (v && v.onData) v.onData(app.last);
  }

  async function loadConfig() {
    if (!T.demo) { try { app.last.config = await T.api.config(); } catch (_) {} }
  }

  async function init() {
    await loadConfig();
    document.getElementById("nav").addEventListener("click", (e) => {
      const btn = e.target.closest(".nav-item"); if (btn) setView(btn.dataset.view);
    });
    document.getElementById("refresh-btn").addEventListener("click", poll);
    document.getElementById("drawer-close").addEventListener("click", T.util.closeDrawer);
    document.getElementById("drawer-scrim").addEventListener("click", T.util.closeDrawer);
    document.getElementById("demo-toggle").addEventListener("change", (e) => {
      T.demo = e.target.checked; loadConfig().then(() => { poll(); setView(app.current); });
    });

    setView("dashboard");
    poll();
    setInterval(poll, 2000);
  }

  document.addEventListener("DOMContentLoaded", init);
})(window.TSN);
