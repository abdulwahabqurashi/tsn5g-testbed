/** Display formatting. One implementation, so units read the same everywhere. */

const DASH = "—";

export function nn(v, suffix = "") {
  return v === null || v === undefined || v === "" ? DASH : `${v}${suffix}`;
}

export function bytes(n) {
  if (n === null || n === undefined) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function bitrate(bitsPerSecond) {
  if (bitsPerSecond === null || bitsPerSecond === undefined) return DASH;
  const mbps = Number(bitsPerSecond) / 1e6;
  if (mbps >= 100) return `${Math.round(mbps)} Mbps`;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
  return `${(mbps * 1000).toFixed(0)} kbps`;
}

export function mbps(v, digits = 1) {
  return v === null || v === undefined ? DASH : `${Number(v).toFixed(digits)}`;
}

export function ms(v, digits = 1) {
  return v === null || v === undefined ? DASH : `${Number(v).toFixed(digits)} ms`;
}

export function dbm(v) {
  return v === null || v === undefined ? DASH : `${v} dBm`;
}

export function db(v) {
  return v === null || v === undefined ? DASH : `${v} dB`;
}

export function ns(v) {
  if (v === null || v === undefined) return DASH;
  const n = Math.abs(Number(v));
  if (n >= 1e9) return `${(Number(v) / 1e9).toFixed(2)} s`;
  if (n >= 1e6) return `${(Number(v) / 1e6).toFixed(2)} ms`;
  if (n >= 1e3) return `${(Number(v) / 1e3).toFixed(1)} µs`;
  return `${Math.round(Number(v))} ns`;
}

export function duration(seconds) {
  if (seconds === null || seconds === undefined) return DASH;
  const s = Math.floor(Number(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function ago(tsSeconds) {
  if (!tsSeconds) return DASH;
  const delta = Date.now() / 1000 - Number(tsSeconds);
  if (delta < 1) return "just now";
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function clockTime(tsSeconds) {
  if (!tsSeconds) return DASH;
  return new Date(Number(tsSeconds) * 1000).toLocaleTimeString(undefined, { hour12: false });
}

export function titleCase(s) {
  if (!s) return DASH;
  return String(s).replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Signal-quality band for RSRP/RSRQ/SINR, used for gauge colouring. */
export function signalBand(metric, value) {
  if (value === null || value === undefined) return "unknown";
  const v = Number(value);
  // Thresholds are the conventional LTE/NR bands. Note RSRP and SINR say
  // different things: this rig sits at RSRP -102 ("poor" received power) with
  // SINR 18 ("good" quality), which is exactly why its throughput is fine.
  // Reporting one number as "signal" would hide that.
  // Anything below the last threshold falls through to "poor".
  const scales = {
    rsrp: [[-80, "excellent"], [-90, "good"], [-100, "fair"]],
    rsrq: [[-10, "excellent"], [-15, "good"], [-20, "fair"]],
    sinr: [[20, "excellent"], [13, "good"], [0, "fair"]],
  };
  const scale = scales[metric];
  if (!scale) return "unknown";
  if (metric === "sinr") {
    for (const [threshold, band] of scale) if (v >= threshold) return band;
    return "poor";
  }
  for (const [threshold, band] of scale) if (v >= threshold) return band;
  return "poor";
}

export { DASH };
