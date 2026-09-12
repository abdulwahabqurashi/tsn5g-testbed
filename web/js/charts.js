/* Lightweight dependency-free SVG charts, styled to match UniFi. Exposes TSN.charts + TSN.theme. */
(function (T) {
  const NS = "http://www.w3.org/2000/svg";
  let _uid = 0;
  const uid = (p) => `${p}-${++_uid}`;

  T.theme = {
    blue: "#0b74ff", blueSoft: "#e8f1ff",
    teal: "#11b3c6", purple: "#7c5cff",
    green: "#16b364", amber: "#f59e0b", red: "#ef4444",
    ink: "#1b1f27", soft: "#68707d", faint: "#aeb6c2",
    grid: "#eef1f5", track: "#eceff3",
    // class colors (CONTROL / HP-VIDEO / BE)
    control: "#0b74ff", hpvideo: "#7c5cff", bevideo: "#98a2b3",
  };

  function el(tag, attrs, kids) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => e.appendChild(c));
    return e;
  }
  function svg(w, h) {
    const s = el("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none",
      width: "100%", height: h, class: "chart" });
    return s;
  }

  /* Area / line chart with gradient fill + dashed gridlines. */
  function area(values, opts) {
    opts = opts || {};
    const w = opts.w || 640, h = opts.h || 150;
    const padL = 0, padR = 0, padT = 10, padB = 12;
    const color = opts.color || T.theme.blue;
    const vals = values.length ? values : [0, 0];
    const lo = opts.min != null ? opts.min : Math.min(...vals);
    const hi = opts.max != null ? opts.max : Math.max(...vals);
    const span = (hi - lo) || 1;
    const iw = w - padL - padR, ih = h - padT - padB;
    const x = (i) => padL + (vals.length === 1 ? 0 : (i / (vals.length - 1)) * iw);
    const y = (v) => padT + ih - ((v - lo) / span) * ih;

    const s = svg(w, h);
    const gid = uid("grad");
    const defs = el("defs", null, [
      el("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, [
        el("stop", { offset: "0%", "stop-color": color, "stop-opacity": "0.28" }),
        el("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0" }),
      ]),
    ]);
    s.appendChild(defs);

    if (opts.grid !== false) {
      for (let g = 0; g <= 3; g++) {
        const gy = padT + (g / 3) * ih;
        s.appendChild(el("line", { x1: padL, y1: gy, x2: w - padR, y2: gy,
          stroke: T.theme.grid, "stroke-width": 1, "stroke-dasharray": "3 4" }));
      }
    }
    const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const areaPath = `M${x(0)},${y(vals[0])} L${line
      .split(" ").join(" L")} L${x(vals.length - 1)},${padT + ih} L${x(0)},${padT + ih} Z`;
    s.appendChild(el("path", { d: areaPath, fill: `url(#${gid})` }));
    s.appendChild(el("polyline", { points: line, fill: "none", stroke: color,
      "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    // last point marker
    s.appendChild(el("circle", { cx: x(vals.length - 1), cy: y(vals[vals.length - 1]),
      r: 3, fill: "#fff", stroke: color, "stroke-width": 2 }));
    return s;
  }

  /* Tiny sparkline (line only, no axes). */
  function spark(values, opts) {
    opts = opts || {};
    const w = opts.w || 120, h = opts.h || 34;
    const color = opts.color || T.theme.green;
    const vals = values.length ? values : [0, 0];
    const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
    const x = (i) => (i / (vals.length - 1)) * w;
    const y = (v) => h - 3 - ((v - lo) / span) * (h - 6);
    const s = svg(w, h);
    const gid = uid("sg");
    s.appendChild(el("defs", null, [el("linearGradient",
      { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, [
        el("stop", { offset: "0%", "stop-color": color, "stop-opacity": ".25" }),
        el("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0" })])]));
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    s.appendChild(el("path", { d: `M0,${h} L${pts.split(" ").join(" L")} L${w},${h} Z`,
      fill: `url(#${gid})` }));
    s.appendChild(el("polyline", { points: pts, fill: "none", stroke: color,
      "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    return s;
  }

  /* Circular gauge (0..100) with center label. */
  function gauge(pct, opts) {
    opts = opts || {};
    const size = opts.size || 120, sw = opts.stroke || 10;
    const r = (size - sw) / 2, c = size / 2, circ = 2 * Math.PI * r;
    const color = opts.color || T.theme.green;
    const p = Math.max(0, Math.min(100, pct));
    const s = svg(size, size);
    s.setAttribute("height", size); s.removeAttribute("preserveAspectRatio");
    s.setAttribute("viewBox", `0 0 ${size} ${size}`);
    s.appendChild(el("circle", { cx: c, cy: c, r, fill: "none",
      stroke: T.theme.track, "stroke-width": sw }));
    s.appendChild(el("circle", { cx: c, cy: c, r, fill: "none", stroke: color,
      "stroke-width": sw, "stroke-linecap": "round",
      "stroke-dasharray": `${(p / 100) * circ} ${circ}`,
      transform: `rotate(-90 ${c} ${c})` }));
    const t1 = el("text", { x: c, y: c - 2, "text-anchor": "middle",
      "font-size": opts.big || 22, "font-weight": 700, fill: T.theme.ink });
    t1.textContent = opts.label != null ? opts.label : `${Math.round(p)}%`;
    s.appendChild(t1);
    if (opts.sub) {
      const t2 = el("text", { x: c, y: c + 16, "text-anchor": "middle",
        "font-size": 10, fill: T.theme.soft });
      t2.textContent = opts.sub; s.appendChild(t2);
    }
    return s;
  }

  /* Thin horizontal meter bar. */
  function meter(pct, opts) {
    opts = opts || {};
    const color = opts.color || T.theme.blue;
    const wrap = document.createElement("div");
    wrap.className = "meter";
    const fill = document.createElement("div");
    fill.className = "meter-fill";
    fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    fill.style.background = color;
    wrap.appendChild(fill);
    return wrap;
  }

  /* 802.1Qbv gate timeline: 3 lanes (Q7/Q4/Q0) of open/closed blocks over a cycle. */
  function gateTimeline(slots, cycleNs, opts) {
    opts = opts || {};
    const w = opts.w || 640, laneH = 26, gap = 8, top = 18;
    const lanes = [
      { name: "Q7 · CONTROL", bit: 128, color: T.theme.control },
      { name: "Q4 · HP VIDEO", bit: 16, color: T.theme.hpvideo },
      { name: "Q0 · BEST-EFFORT", bit: 1, color: T.theme.bevideo },
    ];
    const h = top + lanes.length * (laneH + gap);
    const s = svg(w, h); s.setAttribute("height", h);
    const total = cycleNs || slots.reduce((a, sl) => a + sl[1], 0) || 1;
    const labelW = 118, trackX = labelW, trackW = w - labelW - 4;

    // cycle label
    const ct = el("text", { x: w, y: 12, "text-anchor": "end", "font-size": 11,
      fill: T.theme.soft });
    ct.textContent = `cycle ${(total / 1000).toLocaleString()} µs`;
    s.appendChild(ct);

    lanes.forEach((lane, li) => {
      const ly = top + li * (laneH + gap);
      const lbl = el("text", { x: 0, y: ly + laneH / 2 + 4, "font-size": 11,
        "font-weight": 600, fill: T.theme.soft });
      lbl.textContent = lane.name;
      s.appendChild(lbl);
      // track background (closed)
      s.appendChild(el("rect", { x: trackX, y: ly, width: trackW, height: laneH,
        rx: 5, fill: T.theme.track }));
      let cursor = 0;
      slots.forEach((sl) => {
        const [gate, interval] = sl;
        const open = (gate & lane.bit) !== 0;
        const bx = trackX + (cursor / total) * trackW;
        const bw = (interval / total) * trackW;
        if (open && bw > 0.5) {
          s.appendChild(el("rect", { x: bx, y: ly, width: Math.max(1.5, bw - 0.5),
            height: laneH, rx: 4, fill: lane.color, opacity: 0.92 }));
        }
        cursor += interval;
      });
    });
    return s;
  }

  /* Legend row of colored dots. */
  function legend(items) {
    const wrap = document.createElement("div");
    wrap.className = "legend";
    items.forEach((it) => {
      const s = document.createElement("span");
      s.className = "legend-item";
      s.innerHTML = `<i style="background:${it.color}"></i>${it.label}`;
      wrap.appendChild(s);
    });
    return wrap;
  }

  T.charts = { area, spark, gauge, meter, gateTimeline, legend };
})(window.TSN);
