/**
 * Live log tail.
 *
 * The first view written against the new lifecycle, and the one that proves
 * the event stream end to end: a line logged by the daemon appears here
 * without a request being made.
 *
 * Lines arrive on the bus rather than through the store. A store patch per
 * line would re-render the pane thousands of times under `-l debug`; here each
 * line is one appended node, and the ring is trimmed in the DOM.
 *
 * Follow mode disengages when you scroll up, which is the behaviour every
 * terminal has and every web log viewer forgets — nothing is more annoying
 * than being yanked to the bottom while reading.
 */

import { defineView } from "../core/component.js";
import { atBottom, clear, h } from "../core/dom.js";
import { ApiError } from "../core/api.js";
import { clockTime } from "../core/format.js";
import { toast } from "../core/dialog.js";

const LEVELS = ["debug", "info", "warning", "error", "critical"];
const MAX_NODES = 2000;

export default defineView({
  name: "logs",

  async mount(view) {
    const state = { follow: true, filter: "", minLevel: "debug", paused: false };

    const pane = h("div", { class: "log logpane", tabindex: "0" });
    const countEl = h("span", { class: "hint", text: "0 lines" });

    // -- controls --------------------------------------------------------
    const levelFilter = h("select", { class: "mini-select", "aria-label": "Minimum level" },
      ...LEVELS.map((l) => h("option", { value: l, text: l.toUpperCase() })));
    levelFilter.value = state.minLevel;
    view.dom(levelFilter, "change", () => { state.minLevel = levelFilter.value; repaint(); });

    const textFilter = h("input", {
      type: "search", class: "mini-input", placeholder: "Filter text…",
      "aria-label": "Filter log text",
    });
    view.dom(textFilter, "input", () => { state.filter = textFilter.value.toLowerCase(); repaint(); });

    const pauseBtn = h("button", { class: "btn", type: "button", text: "Pause" });
    view.dom(pauseBtn, "click", () => {
      state.paused = !state.paused;
      pauseBtn.textContent = state.paused ? "Resume" : "Pause";
      pauseBtn.classList.toggle("primary", state.paused);
      view.store.patch({ logs: { paused: state.paused } });
    });

    const followBtn = h("button", { class: "btn primary", type: "button", text: "Following" });
    view.dom(followBtn, "click", () => setFollow(!state.follow));

    const copyBtn = h("button", { class: "btn", type: "button", text: "Copy" });
    view.dom(copyBtn, "click", async () => {
      const text = visible().map(fmt).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        toast(`${visible().length} lines copied`, "ok");
      } catch {
        toast("clipboard unavailable — select the text instead", "err");
      }
    });

    const clearBtn = h("button", { class: "btn", type: "button", text: "Clear view" });
    view.dom(clearBtn, "click", () => {
      view.store.patch({ logs: { lines: [] } });
      repaint();
      toast("view cleared (the daemon's buffer is untouched)");
    });

    // -- runtime log level ------------------------------------------------
    const levelSetter = h("select", { class: "mini-select", "aria-label": "Daemon log level" },
      ...LEVELS.map((l) => h("option", { value: l, text: l })));
    view.dom(levelSetter, "change", async () => {
      const level = levelSetter.value;
      try {
        await view.api.logs.setLevel({ level }, { signal: view.signal });
        toast(`daemon log level set to ${level}`, "ok");
      } catch (err) {
        if (err instanceof ApiError && err.isAborted) return;
        toast(err.message, "err");
      }
    });

    // -- layout ------------------------------------------------------------
    view.root.appendChild(
      h("div", { class: "grid" },
        h("section", { class: "card col12" },
          h("div", { class: "card-head" },
            h("h3", { text: "Live log" }),
            countEl),
          h("div", { class: "toolbar" },
            levelFilter, textFilter, pauseBtn, followBtn, copyBtn, clearBtn,
            h("span", { class: "toolbar-spacer" }),
            h("label", { class: "inline-fld" }, "Daemon level", levelSetter)),
          pane)));

    // -- data --------------------------------------------------------------
    function fmt(e) {
      return `${clockTime(e.ts)}  ${String(e.level).padEnd(8)} ${e.logger}  ${e.message}`;
    }

    function passes(e) {
      if (LEVELS.indexOf(String(e.level).toLowerCase()) < LEVELS.indexOf(state.minLevel)) {
        return false;
      }
      if (!state.filter) return true;
      return `${e.logger} ${e.message}`.toLowerCase().includes(state.filter);
    }

    function visible() {
      return view.store.get().logs.lines.filter(passes);
    }

    function lineNode(e) {
      return h("div", { class: `logline lvl-${String(e.level).toLowerCase()}`, text: fmt(e) });
    }

    function repaint() {
      const rows = visible();
      clear(pane);
      const slice = rows.slice(-MAX_NODES);
      for (const e of slice) pane.appendChild(lineNode(e));
      countEl.textContent = `${rows.length} line${rows.length === 1 ? "" : "s"}`;
      if (state.follow) pane.scrollTop = pane.scrollHeight;
    }

    function setFollow(on) {
      state.follow = on;
      followBtn.textContent = on ? "Following" : "Follow";
      followBtn.classList.toggle("primary", on);
      if (on) pane.scrollTop = pane.scrollHeight;
    }

    // Scrolling up means "I am reading"; stop yanking the view down.
    view.dom(pane, "scroll", () => {
      const bottom = atBottom(pane);
      if (!bottom && state.follow) setFollow(false);
      else if (bottom && !state.follow) setFollow(true);
    });

    // Live lines: append one node instead of repainting the pane.
    view.listen("log", (entry) => {
      if (state.paused || !passes(entry)) return;
      const stick = state.follow;
      pane.appendChild(lineNode(entry));
      while (pane.childElementCount > MAX_NODES) pane.removeChild(pane.firstChild);
      countEl.textContent = `${visible().length} lines`;
      if (stick) pane.scrollTop = pane.scrollHeight;
    });

    // Backfill from the daemon's ring so the view is not empty on arrival.
    try {
      const [tail, levelInfo] = await Promise.all([
        view.api.logs.tail({ limit: 500 }, { signal: view.signal }),
        view.api.logs.getLevel({ signal: view.signal }).catch(() => null),
      ]);
      const existing = view.store.get().logs.lines;
      const seen = new Set(existing.map((e) => e.id));
      const merged = existing
        .concat((tail.lines || []).filter((e) => !seen.has(e.id)))
        .sort((a, b) => (a.id || 0) - (b.id || 0));
      view.store.patch({ logs: { lines: merged, lastId: tail.last_id || 0 } });
      if (levelInfo?.root) levelSetter.value = levelInfo.root;
    } catch (err) {
      if (!(err instanceof ApiError && err.isAborted)) {
        pane.appendChild(h("div", { class: "logline lvl-error", text: `backfill failed: ${err.message}` }));
      }
    }

    repaint();
  },
});
