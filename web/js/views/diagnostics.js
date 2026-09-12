/* Diagnostics — latency/jitter trends, per-interface traffic, raw status. */
(function (T) {
  const { el } = T.util;
  const C = T.charts;

  T.views.diagnostics = {
    render(container) {
      const grid = el("div", { class: "grid" }, [
        el("div", { class: "card col6" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Core round-trip (ping)"]),
            el("span", { class: "hint", id: "d-lat" }, ["—"])]),
          el("div", { id: "d-lat-chart" }, []),
        ]),
        el("div", { class: "card col6" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Jitter"]),
            el("span", { class: "hint", id: "d-jit" }, ["—"])]),
          el("div", { id: "d-jit-chart" }, []),
        ]),
        el("div", { class: "card col12" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Interface traffic"])]),
          el("div", { id: "d-if" }, []),
        ]),
        el("div", { class: "card col12" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Raw status"])]),
          el("pre", { class: "log", id: "d-raw" }, ["…"]),
        ]),
      ]);
      container.appendChild(grid);
      this._d = {
        lat: grid.querySelector("#d-lat"), jit: grid.querySelector("#d-jit"),
        latC: grid.querySelector("#d-lat-chart"), jitC: grid.querySelector("#d-jit-chart"),
        iff: grid.querySelector("#d-if"), raw: grid.querySelector("#d-raw"),
      };
    },
    onData(last) {
      if (!this._d) return;
      // Live: real RTT samples to the core from the backend probe; jitter is the
      // per-sample delta. Demo: sample sine data.
      let lat, jit, latVal, jitVal;
      if (T.demo) {
        const s = T.mock.series(); lat = s.latency; jit = s.jitter;
        latVal = lat[lat.length - 1]; jitVal = jit[jit.length - 1];
      } else {
        const link = (last.stats && last.stats.link) || {};
        lat = link.samples || [];
        jit = lat.map((v, i, a) => (i ? Math.abs(v - a[i - 1]) : 0));
        latVal = link.latency_ms; jitVal = link.jitter_ms;
      }
      this._d.lat.textContent = (latVal != null ? latVal.toFixed(1) : "—") + " ms";
      this._d.jit.textContent = (jitVal != null ? jitVal.toFixed(1) : "—") + " ms";
      this._d.latC.innerHTML = ""; this._d.latC.appendChild(C.area(lat, { h: 150, color: T.theme.blue }));
      this._d.jitC.innerHTML = ""; this._d.jitC.appendChild(C.area(jit, { h: 150, color: T.theme.purple }));

      const ifaces = (last.stats && last.stats.interfaces) || {};
      const names = Object.keys(ifaces);
      this._d.iff.innerHTML = "";
      if (!names.length) { this._d.iff.appendChild(el("p", { class: "muted" }, ["No interface stats yet."])); }
      else {
        const head = el("tr", null, ["Interface", "RX", "TX", "RX pkts", "TX pkts", "Drops"]
          .map((h) => el("th", null, [h])));
        const rows = names.map((n) => {
          const s = ifaces[n];
          return el("tr", null, [
            el("td", null, [el("div", { class: "cell-name" }, [
              el("span", { class: "cell-icon", style: "background:#0b74ff" }, ["≋"]), n])]),
            td(bytes(s.rx_bytes)), td(bytes(s.tx_bytes)), td(fmt(s.rx_packets)), td(fmt(s.tx_packets)),
            el("td", null, [el("span", { class: "badge " + ((s.rx_dropped + s.tx_dropped) ? "amber" : "green") },
              [String((s.rx_dropped || 0) + (s.tx_dropped || 0))])]),
          ]);
        });
        this._d.iff.appendChild(el("table", { class: "tbl" }, [el("thead", null, [head]), el("tbody", null, rows)]));
      }
      this._d.raw.textContent = JSON.stringify(last.status || {}, null, 2);
    },
  };
  function td(v) { return el("td", { class: "mono" }, [v == null ? "—" : String(v)]); }
  function fmt(n) { return n == null ? "—" : Number(n).toLocaleString(); }
  function bytes(b) {
    if (b == null) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(1) + " " + u[i];
  }
})(window.TSN);
