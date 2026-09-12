/* Reusable dynamic 802.1Qbv gate-schedule editor. Exposes TSN.qbvEditor().
   Returns { node, get } where get() -> { slots:[[gate,ns],...], cycle_ns, guard }. */
(function (T) {
  const { el } = T.util;
  const C = T.charts;

  // gate bits: Q7=CONTROL=128, Q4=HP-VIDEO=16, Q0=BEST-EFFORT=1
  const gateOf = (r) => (r.q7 ? 128 : 0) | (r.q4 ? 16 : 0) | (r.q0 ? 1 : 0);

  T.qbvEditor = function (initial) {
    const state = {
      guard: initial && initial.guard != null ? initial.guard : true,
      rows: (initial && initial.rows) || [
        { q7: 1, q4: 0, q0: 0, us: 150 },   // CONTROL window
        { q7: 0, q4: 0, q0: 0, us: 30 },    // guard
        { q7: 0, q4: 1, q0: 0, us: 320 },   // HP VIDEO window
        { q7: 1, q4: 1, q0: 1, us: 500 },   // shared
      ],
    };

    const preview = el("div", { class: "qbv-preview" }, []);
    const tbody = el("tbody", null, []);
    const cycleLbl = el("span", { class: "mono" }, ["—"]);
    const guardChk = el("input", { type: "checkbox", checked: state.guard ? "checked" : undefined,
      onchange: (e) => { state.guard = e.target.checked; } });

    function render() {
      tbody.innerHTML = "";
      state.rows.forEach((r, i) => tbody.appendChild(rowEl(r, i)));
      const cycle = state.rows.reduce((a, r) => a + (+r.us || 0), 0);
      cycleLbl.textContent = cycle.toLocaleString() + " µs";
      preview.innerHTML = "";
      preview.appendChild(C.gateTimeline(slots(), cycle * 1000, {}));
    }
    function rowEl(r, i) {
      const chk = (key) => el("input", { type: "checkbox", checked: r[key] ? "checked" : undefined,
        onchange: (e) => { r[key] = e.target.checked ? 1 : 0; render(); } });
      const num = el("input", { type: "number", min: "1", value: r.us, class: "qbv-int",
        onchange: (e) => { r.us = Math.max(1, +e.target.value || 1); render(); } });
      return el("tr", null, [
        el("td", { class: "mono" }, [String(i + 1)]),
        el("td", { style: "text-align:center" }, [chk("q7")]),
        el("td", { style: "text-align:center" }, [chk("q4")]),
        el("td", { style: "text-align:center" }, [chk("q0")]),
        el("td", null, [num]),
        el("td", null, [el("button", { class: "btn ghost", title: "Remove",
          onclick: () => { state.rows.splice(i, 1); render(); } }, ["✕"])]),
      ]);
    }
    function slots() { return state.rows.map((r) => [gateOf(r), (+r.us || 0) * 1000]); }

    const node = el("div", { class: "qbv-editor" }, [
      el("table", { class: "tbl qbv-tbl" }, [
        el("thead", null, [el("tr", null, ["#", "Q7", "Q4", "Q0", "Interval (µs)", ""]
          .map((h) => el("th", null, [h])))]),
        tbody,
      ]),
      el("div", { class: "btn-row", style: "margin-top:10px" }, [
        el("button", { class: "btn", onclick: () => { state.rows.push({ q7: 1, q4: 1, q0: 1, us: 100 }); render(); } },
          ["+ Add window"]),
        el("label", { class: "switch", style: "margin-left:auto" }, [
          guardChk, el("span", { class: "track" }, []), "Guard band"]),
      ]),
      el("div", { class: "row" }, [el("span", { class: "k" }, ["Cycle time"]),
        el("span", { class: "v" }, [cycleLbl])]),
      C.legend([{ color: T.theme.control, label: "Q7 CONTROL" },
                { color: T.theme.hpvideo, label: "Q4 HP VIDEO" },
                { color: T.theme.bevideo, label: "Q0 BEST-EFFORT" }]),
      preview,
    ]);

    render();
    return {
      node,
      get() {
        const cycle_ns = state.rows.reduce((a, r) => a + (+r.us || 0), 0) * 1000;
        return { slots: slots(), cycle_ns, guard: state.guard };
      },
    };
  };
})(window.TSN);
