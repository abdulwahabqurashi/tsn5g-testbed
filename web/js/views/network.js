/* Network — Ethernet + WiFi interfaces on the Cincoze DI-1200 edge PC. */
(function (T) {
  const { el, toast } = T.util;

  T.views.network = {
    async render(container) {
      const ifaces = await this._ifaces();
      const wifi = await this._wifi();

      container.appendChild(el("div", { class: "grid" }, [
        el("div", { class: "card col8" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Interfaces"]),
            el("span", { class: "hint" }, ["Cincoze DI-1200"])]),
          ifaceTable(ifaces, (n) => this._configure(n)),
        ]),
        el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [el("h3", null, ["Wi-Fi"]),
            el("button", { class: "btn ghost", title: "Rescan", onclick: () => T.setView("network") }, ["⟳"])]),
          wifiList(wifi, (net) => this._connect(net)),
        ]),
      ]));
    },

    async _ifaces() {
      if (T.demo) return T.mock.interfaces();
      try { return (await get("/api/interfaces")).interfaces || []; } catch (_) { return []; }
    },
    async _wifi() {
      if (T.demo) return T.mock.wifi();
      try { return (await get("/api/wifi/scan")).networks || []; } catch (_) { return []; }
    },

    _configure(iface) {
      const method = el("select", { id: "if-method" }, ["dhcp", "static", "down"]
        .map((m) => el("option", { value: m }, [m.toUpperCase()])));
      const addr = el("input", { id: "if-addr", placeholder: "192.168.1.50/24", value: iface.ipv4 || "" });
      const gw = el("input", { id: "if-gw", placeholder: "192.168.1.1" });
      const body = el("div", null, [
        el("div", { class: "row" }, [el("span", { class: "k" }, ["Interface"]),
          el("span", { class: "v mono" }, [iface.name])]),
        el("label", { class: "fld" }, ["IP method", method]),
        el("label", { class: "fld" }, ["Static address (CIDR)", addr]),
        el("label", { class: "fld" }, ["Gateway (optional)", gw]),
        el("div", { class: "btn-row" }, [
          el("button", { class: "btn primary", onclick: async () => {
            const payload = { iface: iface.name, method: method.value,
              address: addr.value.trim(), gateway: gw.value.trim() || undefined };
            if (T.demo) { toast("Demo — not applied", "ok"); T.util.closeDrawer(); return; }
            try { await post("/api/interfaces/config", payload); toast("Applied", "ok");
              T.util.closeDrawer(); T.setView("network"); }
            catch (e) { toast(e.message, "err"); }
          } }, ["Apply"]),
        ]),
      ]);
      T.util.drawer("Configure " + iface.name, body);
    },

    _connect(net) {
      const pass = el("input", { id: "wifi-pass", type: "password", placeholder: "Wi-Fi password" });
      const body = el("div", null, [
        el("div", { class: "row" }, [el("span", { class: "k" }, ["Network"]),
          el("span", { class: "v" }, [net.ssid])]),
        el("div", { class: "row" }, [el("span", { class: "k" }, ["Security"]),
          el("span", { class: "v" }, [net.security])]),
        net.security && net.security !== "Open" ? el("label", { class: "fld" }, ["Password", pass]) : el("div"),
        el("div", { class: "btn-row" }, [
          el("button", { class: "btn primary", onclick: async () => {
            if (T.demo) { toast("Demo — simulated connect to " + net.ssid, "ok"); T.util.closeDrawer(); return; }
            try { await post("/api/wifi/connect", { ssid: net.ssid, psk: pass.value });
              toast("Connecting to " + net.ssid + "…"); T.util.closeDrawer(); }
            catch (e) { toast(e.message, "err"); }
          } }, ["Connect"]),
        ]),
      ]);
      T.util.drawer("Connect to Wi-Fi", body);
    },
  };

  function ifaceTable(ifaces, onCfg) {
    if (!ifaces.length) return el("p", { class: "muted" }, ["No interfaces detected."]);
    const icon = { modem: "radio", ethernet: "eth", wifi: "wifi" };
    const color = { modem: "#7c5cff", ethernet: "#0b74ff", wifi: "#16b364" };
    const head = el("tr", null, ["Interface", "Type", "State", "Speed", "IPv4", "MAC", ""]
      .map((h) => el("th", null, [h])));
    const rows = ifaces.map((i) => el("tr", null, [
      el("td", null, [el("div", { class: "cell-name" }, [
        el("span", { class: "cell-icon", style: "background:" + (color[i.kind] || "#98a2b3"),
          html: T.icon(icon[i.kind] || "chip") }, []), i.name])]),
      el("td", null, [el("span", { class: "tag" }, [i.kind])]),
      el("td", null, [el("span", { class: "badge " + (i.state === "up" ? "green" : "gray") },
        [i.state === "up" ? "Up" : "Down"])]),
      td(i.speed || "—"), td(i.ipv4 || "—"), el("td", { class: "mono muted" }, [i.mac || "—"]),
      el("td", null, [i.kind === "modem" ? el("span", { class: "muted", style: "font-size:.8rem" }, ["managed"])
        : el("button", { class: "btn ghost", title: "Configure", onclick: () => onCfg(i) }, ["⚙"])]),
    ]));
    return el("div", { style: "overflow-x:auto" }, [
      el("table", { class: "tbl" }, [el("thead", null, [head]), el("tbody", null, rows)])]);
  }

  function wifiList(nets, onConnect) {
    if (!nets.length) return el("p", { class: "muted" }, ["No networks found."]);
    return el("div", { class: "wifi-list" }, nets.map((n) => el("div", { class: "wifi-item" }, [
      el("div", { class: "wifi-ic", html: T.icon("wifi") }, []),
      el("div", { style: "flex:1;min-width:0" }, [
        el("div", { class: "wifi-ssid" }, [n.ssid,
          n.active ? el("span", { class: "badge green", style: "margin-left:8px" }, ["Connected"]) : ""]),
        el("div", { class: "wifi-meta" }, [n.security + " · " + n.signal + "%"]),
      ]),
      el("div", { class: "wifi-sig", title: n.signal + "%" }, [sigIcon(n.signal)]),
      el("button", { class: "btn ghost", onclick: () => onConnect(n) }, ["→"]),
    ])));
  }
  function sigIcon(sig) {
    const bars = sig > 66 ? 3 : sig > 33 ? 2 : 1;
    const col = sig > 66 ? "#16b364" : sig > 33 ? "#f59e0b" : "#ef4444";
    const b = (h, on) => `<rect x="${on * 6}" y="${16 - h}" width="4" height="${h}" rx="1" fill="${on <= bars ? col : '#e0e4ea'}"/>`;
    return svg(`${b(6, 1)}${b(10, 2)}${b(14, 3)}`);
  }
  function svg(inner) { const d = document.createElement("div");
    d.innerHTML = `<svg width="22" height="18" viewBox="0 0 18 18">${inner}</svg>`; return d.firstChild; }
  function td(v) { return el("td", { class: "mono" }, [v == null ? "—" : String(v)]); }
  async function get(p) { const r = await fetch(p); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
  async function post(p, b) { const r = await fetch(p, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
    if (!r.ok) throw new Error("HTTP " + r.status); return r.json().catch(() => ({})); }
})(window.TSN);
