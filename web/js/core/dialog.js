/**
 * Toast, drawer and confirmation dialog.
 *
 * The confirmation is the interesting one. Several actions here can strand the
 * operator — resetting the modem while connected, reconfiguring the interface
 * that carries this very HTTP session — so those take `requireText`, forcing
 * the user to type a word before the button enables. A modal you can dismiss
 * by reflex is not a safeguard.
 */

import { clear, h, on } from "./dom.js";

let toastTimer = null;

export function toast(message, kind = "") {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.className = `toast${kind ? ` ${kind}` : ""}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

export function drawer(title, node) {
  document.getElementById("drawer-title").textContent = title;
  const body = document.getElementById("drawer-body");
  clear(body);
  body.appendChild(node);
  document.getElementById("drawer").hidden = false;
  document.getElementById("drawer-scrim").hidden = false;
}

export function closeDrawer() {
  document.getElementById("drawer").hidden = true;
  document.getElementById("drawer-scrim").hidden = true;
  clear(document.getElementById("drawer-body"));
}

/**
 * confirm({ title, body, confirmLabel, danger, requireText })
 * Resolves true if confirmed, false otherwise. Escape and the scrim cancel.
 */
export function confirm(opts) {
  const {
    title, body, confirmLabel = "Confirm", cancelLabel = "Cancel",
    danger = false, requireText = null,
  } = opts;

  return new Promise((resolve) => {
    const host = document.getElementById("modal-host");
    const previouslyFocused = document.activeElement;

    const okBtn = h("button", {
      class: `btn ${danger ? "danger" : "primary"}`,
      text: confirmLabel,
      disabled: Boolean(requireText),
    });
    const cancelBtn = h("button", { class: "btn", text: cancelLabel });

    const input = requireText
      ? h("input", {
        type: "text",
        class: "confirm-input",
        placeholder: requireText,
        autocomplete: "off",
        spellcheck: "false",
        oninput: (e) => { okBtn.disabled = e.target.value.trim() !== requireText; },
      })
      : null;

    const panel = h("div", {
      class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title,
    },
      h("h2", { class: "modal-title", text: title }),
      h("p", { class: "modal-body", text: body }),
      requireText
        ? h("label", { class: "fld" },
          `Type "${requireText}" to confirm`, input)
        : null,
      h("div", { class: "modal-actions" }, cancelBtn, okBtn));

    const scrim = h("div", { class: "modal-scrim" }, panel);

    function close(result) {
      offKey();
      clear(host);
      host.hidden = true;
      previouslyFocused?.focus?.();
      resolve(result);
    }

    okBtn.addEventListener("click", () => close(true));
    cancelBtn.addEventListener("click", () => close(false));
    scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(false); });

    const offKey = on(document, "keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      if (e.key === "Tab") {
        // Trap focus: a dialog you can tab out of is a dialog you can act
        // behind without noticing.
        const focusable = panel.querySelectorAll("button, input, [tabindex]");
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    clear(host);
    host.appendChild(scrim);
    host.hidden = false;
    (input || cancelBtn).focus();
  });
}
