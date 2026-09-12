/* Time Sync — gPTP (IEEE 802.1AS) status with lock gauge + offset trend. */
(function (T) {
  const { el } = T.util;
  const C = T.charts;

  T.views.gptp = {
    render(container) {
      const grid = el("div", { class: "grid" }, [
        el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Sync status"])]),
          el("div", { id: "g-gauge", style: "display:flex;justify-content:center;padding:10px 0" }, []),
          el("div", { id: "g-rows" }, []),
        ]),
        el("div", { class: "card col8" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Clock offset to grandmaster"]),
            el("span", { class: "hint" }, ["nanoseconds"])]),
          el("div", { id: "g-chart" }, []),
          el("p", { class: "section-hint", style: "margin-top:10px" },
            ["Transparent-clock residence-time correction keeps the device-side clock within the sub-microsecond TSN budget."]),
        ]),
      ]);
      container.appendChild(grid);
      this._g = { gauge: grid.querySelector("#g-gauge"), rows: grid.querySelector("#g-rows"),
        chart: grid.querySelector("#g-chart") };
    },
    onData(last) {
      if (!this._g) return;
      const g = (last.status && last.status.gptp) || {};
      const series = T.demo ? T.mock.series().offset
        : (((T.app && T.app.history) || {}).offset || []);
      this._g.gauge.innerHTML = "";
      this._g.gauge.appendChild(C.gauge(g.locked ? 100 : 0, { size: 140,
        color: g.locked ? T.theme.green : T.theme.faint,
        label: g.locked ? "LOCKED" : "UNLOCKED", big: 15, sub: "802.1AS" }));
      this._g.rows.innerHTML = "";
      [["Enabled", g.enabled ? "Yes" : "No"], ["Running", g.running ? "Yes" : "No"],
       ["Offset", g.offset_ns != null ? g.offset_ns + " ns" : "—"],
       ["Path delay", g.path_delay_ns != null ? g.path_delay_ns + " ns" : "—"],
       ["Grandmaster", g.grandmaster || "—"],
       ["Interfaces", (g.interfaces || []).join(", ") || "—"]].forEach(([k, v]) =>
        this._g.rows.appendChild(el("div", { class: "row" }, [el("span", { class: "k" }, [k]),
          el("span", { class: "v mono" }, [String(v)])])));
      this._g.chart.innerHTML = "";
      this._g.chart.appendChild(C.area(series, { h: 160, color: T.theme.green,
        min: -120, max: 120 }));
    },
  };
})(window.TSN);
