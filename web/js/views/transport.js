/* Transport — active mode + the VLAN→VNI/PCP/DSCP overlay map. */
(function (T) {
  const { el } = T.util;

  T.views.transport = {
    render(container, app) {
      const s = (app.last && app.last.status) || (T.demo ? T.mock.status() : {});
      const cfg = (app.last && app.last.config) || {};
      const t = s.transport || {};
      const mode = t.mode || (cfg.transport && cfg.transport.mode) || "vxlan";
      const classes = t.classes || (T.demo ? demoClasses() : []);

      const grid = el("div", { class: "grid" }, [
        el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Active transport"])]),
          row("Mode", (mode || "—").toUpperCase()),
          row("State", s.state || "—"),
          row("Bridge", t.bridge || "ds-tt-br0", true),
          row("Core / remote", t.core_ip || "10.45.0.1", true),
          row("MTU", t.mtu || 1450),
        ]),
        el("div", { class: "card col8" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Traffic-class overlay map"]),
            el("span", { class: "hint" }, ["VLAN → VNI"])]),
          el("p", { class: "section-hint" },
            ["Each TSN VLAN rides its own VXLAN tunnel; PCP is preserved and mapped to the outer DSCP for 5G QoS visibility."]),
          classTable(classes),
          el("div", { class: "btn-row" }, [
            el("button", { class: "btn", onclick: () => editDrawer(cfg) }, ["Edit overlay map"])]),
        ]),
      ]);
      container.appendChild(grid);
    },
  };

  function classTable(classes) {
    if (!classes.length) return el("p", { class: "muted" }, ["No overlay map configured."]);
    const head = el("tr", null, ["Class", "VLAN", "VNI", "UDP port", "PCP", "DSCP"].map((h) => el("th", null, [h])));
    const colors = { control: T.theme.control, hp_video: T.theme.hpvideo, be_video: T.theme.bevideo };
    const rows = classes.map((c) => el("tr", null, [
      el("td", null, [el("div", { class: "cell-name" }, [
        el("span", { class: "cell-icon", style: "background:" + (colors[c.role] || "#98a2b3") }, [String(c.pcp)]),
        (c.role || "").replace("_", " ").toUpperCase() || "—"])]),
      td(c.vlan), td(c.vni != null ? c.vni : c.vlan), td(c.dstport || (4789 + (c.vlan % 10 || 0))),
      td("PCP " + c.pcp), td(c.dscp),
    ]));
    return el("table", { class: "tbl" }, [el("thead", null, [head]), el("tbody", null, rows)]);
  }
  function td(v) { return el("td", { class: "mono" }, [v == null ? "—" : String(v)]); }
  function row(k, v, mono) { return el("div", { class: "row" }, [el("span", { class: "k" }, [k]),
    el("span", { class: "v" + (mono ? " mono" : "") }, [v == null ? "—" : String(v)])]); }
  function demoClasses() {
    return [{ vlan: 60, vni: 60, dstport: 4789, pcp: 7, dscp: 46, role: "control" },
            { vlan: 70, vni: 70, dstport: 4790, pcp: 4, dscp: 34, role: "hp_video" },
            { vlan: 80, vni: 80, dstport: 4791, pcp: 0, dscp: 0, role: "be_video" }];
  }
  function editDrawer(cfg) {
    const map = (cfg.vxlan && cfg.vxlan.vlan_map) || demoClasses();
    const area = el("textarea", { style: "width:100%;height:260px" }, [JSON.stringify(map, null, 2)]);
    const save = el("button", { class: "btn primary", onclick: async () => {
      try {
        const parsed = JSON.parse(area.value);
        if (T.demo) { T.util.toast("Demo mode — not persisted", "ok"); T.util.closeDrawer(); return; }
        await T.api.updateConfig({ vxlan: { vlan_map: parsed } });
        T.util.toast("Overlay map saved", "ok"); T.util.closeDrawer(); T.setView("transport");
      } catch (e) { T.util.toast("Save failed: " + e.message, "err"); }
    } }, ["Save"]);
    T.util.drawer("Edit VXLAN overlay map", el("div", null, [
      el("p", { class: "section-hint" }, ["JSON list of {vlan, vni, dstport, pcp, dscp, role}."]),
      area, el("div", { class: "btn-row" }, [save])]));
  }
})(window.TSN);
