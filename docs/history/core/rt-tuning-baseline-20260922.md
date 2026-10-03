# Pre-change baseline — uplink discards before RT kernel tuning

Captured 2026-09-22 22:26 local, after the GRUB repair but **before** the second
reboot, so the numbers below are all from kernels with **no RT tuning at all**
(the 22:11 reboot applied `isolcpus` only, and no load was run under it).

Counts are from `~/tsntestbed/gnb-archive/`. `RF: underflow` is excluded from
the verdict — it is the known no-traffic false alarm, not a fault signal.

| archived log | `Discarded uplink slot` | `RF: overflow` | note |
|---|---|---|---|
| `gnb-20260918T071153Z.log` | **10410** | 9 | wedge captured this day |
| `gnb-20260919T085943Z.log` | **40355** | 7 | worst observed |
| `gnb-20260921T055515Z.log` | 0 | 11 | overflow without discards |
| `gnb-20260922T054344Z.log` | 0 | 8 | |
| `gnb-20260922T072323Z.log` | 0 | 7 | |
| `gnb-20260922T211304Z.log` | **2137** | 0 | **primary baseline — see below** |
| `gnb-20260922T221326Z.log` | 281 | 0 | tail of the same session, pre-reboot |

## Primary baseline for the before/after comparison

`gnb-archive/gnb-20260922T211304Z.log`

- Log covers 2026-09-22 **16:32:52 → ~21:13**
- **2137** `Discarded uplink slot` events
- Discards span **16:45:53 → 20:49:40** — i.e. recurring across the whole
  loaded period, not one isolated burst
- `RF: overflow`: 0 in this window

## What "fixed" looks like

Re-run the **same** uplink iperf (same duration, same offered rate) on the fully
tuned kernel and count discards over a comparable loaded window.

- **Confirmed** — discards near zero, or down by an order of magnitude, with no
  `RF: overflow`, and uplink throughput recovered.
- **Refuted** — discards still in the hundreds-to-thousands. Then the limit is
  not scheduling jitter and the next lever is load reduction (bandwidth or MCS),
  not more isolation.

Compare like for like: the 2137 figure is over roughly four hours of intermittent
load, so normalise to discards per minute of actual uplink load rather than
comparing raw totals against a short test run.

## Caveat

gNB stdout buffering makes `journalctl` timestamps lag by up to 65 min, so
correlate by position within `gnb.log` and by the in-line ISO timestamps the gNB
writes itself (as used above) — not by wall-clock journal times.
