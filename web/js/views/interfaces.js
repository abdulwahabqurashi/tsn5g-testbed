/**
 * Interfaces — see and configure every NIC.
 *
 * The interlock is the point. Reconfiguring the interface that carries your
 * own session drops it mid-request, and the UI cannot tell you afterwards
 * because there is nothing left to tell you with. The backend reports which
 * interface holds the default route; changing that one requires typing its
 * name, and taking it down is refused outright.
 *
 * wwan0 is deliberately read-only here — it belongs to the bearer, and setting
 * a static address on it would fight the data call.
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { asyncSection } from "../core/async.js";
import { confirm, closeDrawer, drawer, toast } from "../core/dialog.js";
import { bytes, nn } from "../core/format.js";
import { clear, h } from "../core/dom.js";
import { badge, btnRow, button, card, field, row, select, table } from "../ui/widgets.js";

export default defineView({
  name: "interfaces",

  async mount(view) {
    const ifaceBody = h("div");
    const wifiBody = h("div");

    view.root.appendChild(h("div", { class: "grid" },
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "Interfaces" }),
          button("Refresh", { onclick: () => section.reload() })),
        ifaceBody),
      h("section", { class: "card col12" },
        h("div", { class: "card-head" },
          h("h3", { text: "Wi-Fi" }),
          button("Scan", { onclick: () => scanWifi() })),
        wifiBody)));

    // ---- interface table ---------------------------------------------------
    const section = asyncSection(ifaceBody, {
      signal: view.signal,
      load: (signal) => view.api.iface.list({ signal }),
      empty: (d) => !(d.interfaces || []).length,
      emptyText: "No interfaces detected.",
      render: (data, host) => {
        const stats = view.store.get().stats?.interfaces || {};
        const rows = (data.interfaces || []).map((i) => {
          const s = stats[i.name] || {};
          return [
            h("span", { class: "cell-name" },
              h("span", { class: `dot ${i.state === "up" ? "ok" : "idle"}` }),
              i.name,
              i.management ? badge("management", "amber") : null,
              i.kind === "modem" ? badge("bearer", "blue") : null),
            i.kind,
            i.state,
            h("span", { class: "mono", text: i.cidr || i.ipv4 || "—" }),
            h("span", { class: "mono", text: i.mac || "—" }),
            s.rx_bytes === undefined ? "—" : bytes(s.rx_bytes),
            s.tx_bytes === undefined ? "—" : bytes(s.tx_bytes),
            configureButton(i),
          ];
        });
        clear(host);
        host.appendChild(table(
          ["Interface", "Kind", "State", "Address", "MAC", "RX", "TX", ""], rows));
        if (data.management) {
          host.appendChild(h("p", { class: "hint" },
            `You are reached over ${data.management}. Changes to it need the `
            + "interface name typed in, and it cannot be taken down from here."));
        }
      },
    });

    function configureButton(iface) {
      if (iface.kind === "modem") {
        return h("span", { class: "hint", title: "owned by the bearer",
                           text: "see Connection" });
      }
      return button("Configure", { onclick: () => openConfigure(iface) });
    }

    // ---- configure drawer --------------------------------------------------
    function openConfigure(iface) {
      const isMgmt = Boolean(iface.management);

      const method = select(
        [{ value: "dhcp", label: "DHCP" },
         { value: "static", label: "Static" },
         ...(isMgmt ? [] : [{ value: "down", label: "Down" }])],
        iface.cidr ? "static" : "dhcp", () => sync(), { class: "mini-select" });

      const address = h("input", { type: "text", class: "mini-input",
                                   value: iface.cidr || "",
                                   placeholder: "192.168.1.50/24" });
      const gateway = h("input", { type: "text", class: "mini-input",
                                   placeholder: "192.168.1.1" });
      const typed = h("input", { type: "text", class: "mini-input",
                                 placeholder: iface.name, autocomplete: "off" });
      const apply = button("Apply", { kind: isMgmt ? "danger" : "primary",
                                      onclick: submit, disabled: isMgmt });

      function sync() {
        const isStatic = method.value === "static";
        address.disabled = !isStatic;
        gateway.disabled = !isStatic;
        if (isMgmt) apply.disabled = typed.value.trim() !== iface.name;
      }
      typed.addEventListener("input", sync);
      method.addEventListener("change", sync);

      const body = h("div", null,
        row("Interface", iface.name, { mono: true }),
        row("Current", iface.cidr || iface.ipv4 || "no address", { mono: true }),
        row("State", iface.state),
        field("Method", method),
        field("Address (CIDR)", address),
        field("Gateway", gateway));

      if (isMgmt) {
        body.appendChild(h("p", { class: "section-hint",
          style: { color: "var(--red)", "font-weight": "600" } },
          `This console is reached over ${iface.name}. Changing it will drop `
          + "this session, and there will be no way to tell you what happened "
          + "— you would simply stop getting replies. Taking it down is not "
          + "offered at all."));
        body.appendChild(field(`Type "${iface.name}" to confirm`, typed));
      }

      body.appendChild(btnRow(apply, button("Cancel", { onclick: closeDrawer })));
      drawer(`Configure ${iface.name}`, body);
      sync();

      async function submit() {
        const payload = { iface: iface.name, method: method.value };
        if (method.value === "static") {
          if (!address.value.trim()) { toast("an address is required", "err"); return; }
          payload.address = address.value.trim();
          if (gateway.value.trim()) payload.gateway = gateway.value.trim();
        }
        if (isMgmt) {
          const ok = await confirm({
            title: `Reconfigure ${iface.name}?`,
            body: "This is the interface carrying your session. If the new "
                + "settings are wrong you will lose access to this machine "
                + "until someone fixes it locally.",
            confirmLabel: "I understand, apply",
            danger: true,
            requireText: iface.name,
          });
          if (!ok) return;
        }
        try {
          await view.api.iface.config(payload, { signal: view.signal });
          toast(`${iface.name} set to ${method.value}`, "ok");
          closeDrawer();
          section.reload();
        } catch (err) {
          if (err instanceof ApiError && err.isAborted) return;
          toast(err.message, "err");
        }
      }
    }

    // ---- wifi ---------------------------------------------------------------
    async function scanWifi() {
      clear(wifiBody);
      wifiBody.appendChild(h("div", { class: "skeleton-wrap" },
        h("div", { class: "skeleton-row" }), h("div", { class: "skeleton-row" })));
      try {
        const res = await view.api.wifi.scan({ signal: view.signal });
        const nets = res.networks || [];
        clear(wifiBody);
        if (!nets.length) {
          wifiBody.appendChild(h("p", { class: "muted" },
            "No networks found. This box may have no Wi-Fi radio."));
          return;
        }
        wifiBody.appendChild(table(["SSID", "Signal", "Security", ""],
          nets.map((n) => [
            n.ssid || "(hidden)",
            `${n.signal ?? "—"}%`,
            n.security || "open",
            button("Connect", { onclick: () => joinWifi(n) }),
          ])));
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(wifiBody);
        wifiBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
    }

    function joinWifi(net) {
      const psk = h("input", { type: "text", class: "mini-input",
                               placeholder: "network password",
                               autocomplete: "off" });
      drawer(`Join ${net.ssid}`, h("div", null,
        row("Security", net.security || "open"),
        row("Signal", `${net.signal ?? "—"}%`),
        field("Password", psk,
              "shown rather than masked — this console is often driven from a "
              + "touchscreen with no keyboard"),
        btnRow(
          button("Connect", { kind: "primary", onclick: async () => {
            try {
              await view.api.wifi.connect({ ssid: net.ssid, psk: psk.value },
                                          { signal: view.signal });
              toast(`joining ${net.ssid}…`, "ok");
              closeDrawer();
            } catch (err) {
              if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
            }
          } }),
          button("Cancel", { onclick: closeDrawer }))));
    }

    wifiBody.appendChild(h("p", { class: "muted" },
      "Press Scan to look for networks."));

    // Counters come from the stream, so the table stays current without polling.
    view.sub((s) => s.stats, () => section.reload());
  },
});
