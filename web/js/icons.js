/* Inline SVG icon set (stroke-based, currentColor). Exposes TSN.icon(name). */
(function (T) {
  const P = (d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;
  const I = {
    grid: P("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"),
    bolt: P("M13 3 4 14h6l-1 7 9-11h-6z"),
    swap: P("M7 7h13l-3-3M17 17H4l3 3"),
    chip: P("M8 8h8v8H8zM4 10V8M4 14v2M20 10V8M20 14v2M9 4h2M13 4h2M9 20h2M13 20h2M4 9h2M4 13h2M18 9h2M18 13h2"),
    clock: P("M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"),
    pulse: P("M3 12h4l2 6 4-14 2 8h6"),
    device: P("M4 5h16v11H4zM9 20h6M12 16v4"),
    cloud: P("M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A3.5 3.5 0 0 1 17 18z"),
    server: P("M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01"),
    sw: P("M4 7h16v4H4zM4 13h16v4H4zM8 9h.01M8 15h.01M16 9l-2 0M16 15l-2 0"),
    signal: P("M4 20v-3M9 20v-7M14 20v-11M19 20V6"),
    check: P("M5 12l4 4 10-10"),
    radio: P("M12 12a0 0 0 1 0 0M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.5 18.5a9 9 0 0 1 0-13M18.5 5.5a9 9 0 0 1 0 13"),
    wifi: P("M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M11 18.5a1.5 1.5 0 0 1 2 0"),
    eth: P("M7 4h10v4H7zM12 8v4M6 12h12v3H6zM8 15v3M12 15v3M16 15v3"),
    gauge2: P("M12 13l4-3M20 13a8 8 0 1 0-16 0M4 13h2M18 13h2M12 5v2"),
    speed: P("M12 14a2 2 0 1 0 0-4M13.5 10.5 17 8M4.5 18a9 9 0 1 1 15 0"),
    plug: P("M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5"),
  };
  T.icon = (name, cls) =>
    `<svg viewBox="0 0 24 24" ${cls ? `class="${cls}"` : ""} aria-hidden="true">${I[name] || I.grid}</svg>`;

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-i]").forEach((n) => { n.innerHTML = T.icon(n.dataset.i); });
  });
})(window.TSN);
