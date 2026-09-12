/* API client + shared helpers. Exposes a global `TSN`. */
window.TSN = window.TSN || { views: {} };

(function (T) {
  const base = ""; // same-origin

  async function req(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && data.error) || res.statusText || ("HTTP " + res.status);
      const err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    return data;
  }

  T.api = {
    status:      () => req("GET", "/api/status"),
    health:      () => req("GET", "/api/health"),
    stats:       () => req("GET", "/api/stats"),
    discovery:   () => req("GET", "/api/discovery"),
    config:      () => req("GET", "/api/config"),
    updateConfig:(patch) => req("PUT", "/api/config", patch),
    connect:     (body) => req("POST", "/api/connect", body),
    disconnect:  () => req("POST", "/api/disconnect", {}),
    switchProfiles: () => req("GET", "/api/switch/profiles"),
    switchApply: (body) => req("POST", "/api/switch/apply", body),
    switchDisable: (body) => req("POST", "/api/switch/disable", body),
    switchStatus: (q) => req("GET", "/api/switch/status?" + new URLSearchParams(q)),
  };

  /* ---- tiny DOM + UX helpers ---- */
  T.util = {
    el(tag, attrs, children) {
      const e = document.createElement(tag);
      if (attrs) for (const k in attrs) {
        if (k === "class") e.className = attrs[k];
        else if (k === "html") e.innerHTML = attrs[k];
        else if (k.startsWith("on") && typeof attrs[k] === "function")
          e.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
      }
      (children || []).forEach((c) =>
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
      return e;
    },
    row(k, v, mono) {
      return T.util.el("div", { class: "row" }, [
        T.util.el("span", { class: "k" }, [k]),
        T.util.el("span", { class: "v" + (mono ? " mono" : "") }, [v == null ? "—" : String(v)]),
      ]);
    },
    toast(msg, kind) {
      const t = document.getElementById("toast");
      t.textContent = msg; t.className = "toast" + (kind ? " " + kind : "");
      t.hidden = false;
      clearTimeout(T.util._tt);
      T.util._tt = setTimeout(() => { t.hidden = true; }, 3200);
    },
    drawer(title, node) {
      document.getElementById("drawer-title").textContent = title;
      const body = document.getElementById("drawer-body");
      body.innerHTML = ""; body.appendChild(node);
      document.getElementById("drawer").hidden = false;
      document.getElementById("drawer-scrim").hidden = false;
    },
    closeDrawer() {
      document.getElementById("drawer").hidden = true;
      document.getElementById("drawer-scrim").hidden = true;
    },
  };
})(window.TSN);
