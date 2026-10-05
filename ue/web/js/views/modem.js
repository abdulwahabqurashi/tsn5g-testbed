/**
 * Modem — hardware-level control of the RM520N-GL.
 *
 * Everything here can drop the link, so every action is confirmed, and the two
 * that can strand you (reset while connected, unmasking ModemManager) say what
 * will happen rather than asking a generic "are you sure?".
 */

import { ApiError } from "../core/api.js";
import { defineView } from "../core/component.js";
import { confirm, toast } from "../core/dialog.js";
import { clear, h } from "../core/dom.js";
import { ago, nn } from "../core/format.js";
import { badge, btnRow, button, card, row } from "../ui/widgets.js";

export default defineView({
  name: "modem",

  async mount(view) {
    const busBody = h("div");
    const idBody = h("div");
    const powerBody = h("div");
    const mmBody = h("div");

    view.root.appendChild(h("div", { class: "grid" },
      card("Power & radio", { span: "col6" }, powerBody),
      card("ModemManager", { span: "col6" }, mmBody),
      card("AT bus", { span: "col6" }, busBody),
      card("Identity", { span: "col6" }, idBody)));

    // ---- actions --------------------------------------------------------
    async function job(promise, label) {
      try {
        const res = await promise;
        toast(`${label} started`, "ok");
        return res;
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return null;
        // 428 carries the backend's own explanation of the consequence.
        if (err instanceof ApiError && err.status === 428) {
          toast(err.data?.explain || err.message, "err");
        } else {
          toast(err.message, "err");
        }
        return null;
      }
    }

    async function setRadio(mode) {
      const consequences = {
        off: "The radio powers down. The 5G bearer drops and the UE deregisters.",
        airplane: "The radio stops transmitting. The bearer drops; the SIM stays powered.",
        on: "The radio powers up and the UE will try to register.",
      };
      if (mode !== "on") {
        const ok = await confirm({
          title: `Turn the radio ${mode === "off" ? "off" : "to airplane mode"}?`,
          body: consequences[mode],
          confirmLabel: mode === "off" ? "Power off radio" : "Airplane mode",
          danger: true,
        });
        if (!ok) return;
      }
      await job(view.api.modem.setPower({ radio: mode, confirm: true },
                                        { signal: view.signal }), `radio ${mode}`);
      refresh();
    }

    async function doReset() {
      const connected = view.store.get().status?.state === "running";
      const ok = await confirm({
        title: "Reset the modem?",
        body: "AT+CFUN=1,1 power-cycles the RM520N-GL. USB re-enumerates, so the "
            + "AT and QMI devices disappear for about 40 seconds and the data "
            + "call drops. The AT port may come back with a different number.",
        confirmLabel: "Reset modem",
        danger: true,
        // Typed confirmation only when it will actually break something.
        requireText: connected ? "reset" : null,
      });
      if (!ok) return;
      await job(view.api.modem.reset({ confirm: true }, { signal: view.signal }),
                "modem reset");
    }

    async function setManager(action) {
      const ok = await confirm({
        title: action === "mask" ? "Mask ModemManager?" : "Unmask ModemManager?",
        body: action === "mask"
          ? "Stops ModemManager and prevents D-Bus from restarting it. This is "
            + "the state a UE should normally be in."
          : "ModemManager will contend for /dev/ttyUSB* and may rewrite radio "
            + "preferences underneath this daemon. Stopping it later is not "
            + "enough — it is D-Bus activated and comes straight back.",
        confirmLabel: action === "mask" ? "Mask" : "Unmask anyway",
        danger: action === "unmask",
      });
      if (!ok) return;
      await job(view.api.modem.setManager({ action, confirm: true },
                                          { signal: view.signal }), action);
      refresh();
    }

    // ---- painters --------------------------------------------------------
    function paintPower(power) {
      clear(powerBody);
      const radio = power?.radio;
      const kind = radio === "on" ? "green" : radio === "airplane" ? "amber" : "gray";
      powerBody.appendChild(row("Radio",
        h("span", null, badge(radio ? radio.toUpperCase() : "unknown", kind),
          power?.cfun !== null && power?.cfun !== undefined
            ? h("span", { class: "muted mono", text: `  CFUN=${power.cfun}` }) : null)));
      if (power?.error) powerBody.appendChild(row("Error", power.error, { cls: "muted" }));
      powerBody.appendChild(btnRow(
        button("Radio on", { onclick: () => setRadio("on"), disabled: radio === "on" }),
        button("Airplane", { onclick: () => setRadio("airplane"),
                             disabled: radio === "airplane" }),
        button("Radio off", { kind: "danger", onclick: () => setRadio("off"),
                              disabled: radio === "off" }),
        button("Reset modem", { kind: "danger", onclick: doReset,
                                title: "AT+CFUN=1,1 — about 40 seconds" })));
    }

    function paintManager(mm) {
      clear(mmBody);
      const masked = mm?.masked;
      mmBody.appendChild(row("Unit state",
        badge(mm?.state || "unknown", masked ? "green" : "amber")));
      mmBody.appendChild(row("Running now",
        badge(mm?.active ? "yes" : "no", mm?.active ? "red" : "green")));
      if (mm?.active) {
        mmBody.appendChild(h("p", { class: "section-hint" },
          "ModemManager is running and will contend for the AT port. "
          + "This is the usual cause of intermittent AT failures."));
      }
      mmBody.appendChild(btnRow(
        button("Mask", { onclick: () => setManager("mask"), disabled: masked }),
        button("Unmask", { kind: "danger", onclick: () => setManager("unmask"),
                           disabled: !masked })));
    }

    function paintBus(bus, ports) {
      clear(busBody);
      if (!bus) {
        busBody.appendChild(h("p", { class: "muted" }, "Bus not available."));
        return;
      }
      busBody.appendChild(row("AT port", bus.port, { mono: true }));
      busBody.appendChild(row("QMI device", bus.qmi_device, { mono: true }));
      busBody.appendChild(row("Port open", bus.open ? "yes" : "no (idle)"));
      busBody.appendChild(row("Busy with", bus.busy_with
        ? `${bus.busy_with} (${bus.busy_for_s}s)` : "idle"));
      busBody.appendChild(row("Queue depth", bus.queue_depth));
      if (bus.last_error) busBody.appendChild(row("Last error", bus.last_error, { cls: "muted" }));
      const cands = (ports?.candidates || bus.candidates || []);
      if (cands.length) {
        busBody.appendChild(row("Probed", cands.join(", "), { mono: true }));
      }
      if (!bus.port) {
        busBody.appendChild(h("p", { class: "section-hint" },
          "No AT port answered. The port moves between boots, so try a rescan; "
          + "if it still fails, check that ModemManager is masked and that this "
          + "process can open /dev/ttyUSB* (it runs as root under systemd)."));
      }
      busBody.appendChild(btnRow(
        button("Rescan ports", {
          onclick: async () => {
            await job(view.api.modem.rescan({ signal: view.signal }), "port rescan");
            view.timeout(refresh, 1500);
          },
        }),
        button("Release port", {
          title: "Close the serial port so at.py or the reference scripts can use it",
          onclick: async () => {
            try {
              await view.api.modem.releaseBus({ signal: view.signal });
              toast("port released — at.py can use it now; the bus reopens on "
                    + "the next command", "ok");
              refresh();
            } catch (err) {
              if (!(err instanceof ApiError && err.isAborted)) toast(err.message, "err");
            }
          },
        })));
    }

    function paintIdentity(info) {
      clear(idBody);
      const m = info?.modem || {};
      idBody.appendChild(row("Model", m.model || info?.bus?.model, { mono: true }));
      // null means nobody has measured it yet, which is not the same as "no".
      // These rendered a flat "not ready" / "no" against a UE that was camped
      // and carrying traffic, because the flags behind them were untouched
      // defaults rather than readings.
      const tri = (v, yes, no) => (v === null || v === undefined
        ? badge("unknown", "gray")
        : badge(v ? yes : no, v ? "green" : "amber"));
      idBody.appendChild(row("SIM", tri(m.sim_ready, "ready", "not ready")));
      if (m.sim_ready === null || m.sim_ready === undefined) {
        idBody.appendChild(h("p", { class: "hint" },
          "The SIM is only read during a Check, so it stays unknown until you "
          + "run one."));
      }
    }

    // ---- data ------------------------------------------------------------
    async function refresh() {
      try {
        const info = await view.api.modem.info({ signal: view.signal });
        paintPower(info.power);
        paintBus(info.bus, null);
        paintIdentity(info);
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        clear(busBody);
        busBody.appendChild(h("p", { class: "muted", text: err.message }));
      }
      try {
        paintManager(await view.api.modem.getManager({ signal: view.signal }));
      } catch (err) {
        if (!(err instanceof ApiError && err.isAborted)) {
          clear(mmBody);
          mmBody.appendChild(h("p", { class: "muted", text: err.message }));
        }
      }
    }

    await refresh();
    // Bus state changes without a store update (queue depth, busy-with), so
    // this view polls its own endpoint rather than waiting for the stream.
    view.interval(refresh, 4000);

    // A finished modem job means the picture just changed.
    view.listen("job", (evt) => {
      if (evt.lane === "modem" && ["succeeded", "failed"].includes(evt.state)) {
        view.timeout(refresh, 500);
      }
    });
  },
});
