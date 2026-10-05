/**
 * A page made of tabs, each an ordinary view.
 *
 * Several small pages that answered one question between them (Signal,
 * Registration, Modem) are now one page with tabs. The tab views are unchanged
 * modules; this host mounts the chosen one under a tab bar and tears it down on
 * the way out, so each keeps its own lifecycle. The tab lives in the URL
 * (#/radio?tab=cell), so refresh and back still land where you were.
 */

import { runView } from "../core/component.js";
import { h } from "../core/dom.js";

/** tabs: [{id, title, load: () => import(...)}]; the first is the default. */
export function tabbedView(name, tabs) {
  return {
    name,
    async mount(view) {
      const want = view.query.tab;
      const tab = tabs.find((t) => t.id === want) || tabs[0];
      const base = location.hash.replace(/^#/, "").split("?")[0] || "/";

      view.root.appendChild(h("nav", { class: "page-tabs", "aria-label": "Sections" },
        ...tabs.map((t) => h("a", {
          class: `page-tab${t === tab ? " on" : ""}`,
          href: `#${base}${t === tabs[0] ? "" : `?tab=${t.id}`}`,
          text: t.title,
        }))));
      const outlet = h("div", { class: "tab-outlet" });
      view.root.appendChild(outlet);

      const mod = await tab.load();
      const child = await runView(mod.default || mod, {
        root: outlet,
        ctx: { store: view.store, api: view.api, bus: view.bus, params: view.params, query: view.query },
      });
      view.onCleanup(() => { child.destroy(); });
      view.child = child;
      child.update(view.store.get());
    },
    update(state, view) {
      view.child?.update(state);
    },
  };
}
