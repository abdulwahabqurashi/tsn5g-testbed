> **First rig, 2026-09-30.** Interface names below are that server's. On a new
> site set `CORE_PTP_IF` in site.env and run `sudo core/ptp/install-ptp.sh`.

# PTP / time synchronisation setup — staged 2026-09-30

## Why this is not done yet: two blockers

**1. The only hardware-PTP-capable ports are unplugged.**

| Interface | PHC | Timestamping | Link |
|---|---|---|---|
| `enp37s0f0np0` | **/dev/ptp0** | **hardware** tx+rx, raw clock | **down, carrier=0** |
| `enp37s0f1np1` | /dev/ptp0 | hardware | down, carrier=0 |
| `enp109s0f0np0` (mgmt) | none | software only | up |
| `enp109s0f1np1` (X410 fronthaul) | none | software only | up |

`/dev/ptp0` is `ice-0000:25:00.0-clk` — Intel E810, driver `ice`, fw 4.40.
**Software-only timestamping gives tens of microseconds and is not usable for TSN.**
So PTP must run on `enp37s0f0np0`, which needs a cable to the TSN switch / grandmaster.

**2. `linuxptp` is not installed** — no `ptp4l`, `phc2sys`, `pmc`, `phc_ctl`, `ts2phc`.

## The trap: phc2sys alone does nothing

`upf_nwtt_detect_phc2sys()` (`src/upf/nwtt.c:87`) runs literally:

```c
fp = popen("pgrep -x phc2sys 2>/dev/null", "r");
```

It only sets a flag that changes **a log line**. The clock actually used comes from
`clock_source` in `upf.yaml`, and the source comment at `nwtt.c:33-38` is explicit:

> CLOCK_MONOTONIC_RAW is not affected by NTP/phc2sys adjustments.
> When phc2sys is running ... the user can select CLOCK_REALTIME.

Current setting is `clock_source: monotonic`. **If you start phc2sys without changing
it, the UPF will log "phc2sys detected: system clock is PHC-synchronized" while
timestamps still come from an unsynchronised raw clock.** False confidence.

## Order of operations

1. **Cable `enp37s0f0np0`** to the TSN switch / grandmaster. Verify:
   `cat /sys/class/net/enp37s0f0np0/carrier` must return `1`.
2. `sudo ./install-ptp.sh` — installs linuxptp, config, and both systemd units.
   It refuses to run if there is no carrier.
3. **Edit `upf.yaml`** (see below) — without this, step 2 achieves nothing measurable.
4. Restart the UPF and confirm the log line changed.

## Required upf.yaml change

Runtime file: `~/tsntestbed/Open5GS-TSN-ACIA-master/build/configs/open5gs/upf.yaml`
(also update `configs/open5gs/upf.yaml.in`, or a `meson --reconfigure` reverts it).

```yaml
  nwtt:
    timestamp:
      clock_source: realtime           # was: monotonic
      phc_interface: enp37s0f0np0      # optional; UPF logs whether it exists
```

Valid `clock_source` values (`src/upf/context.c:281`): `monotonic` /
`CLOCK_MONOTONIC_RAW`, `realtime` / `CLOCK_REALTIME`. Anything else silently falls
back to SOFTWARE. Unknown keys under `timestamp:` only warn — unlike the gNB config,
they are not fatal.

## Verification

```bash
# PTP is locked (offset should settle to tens/hundreds of ns, not µs)
journalctl -u ptp4l-gptp -f          # look for "rms" converging
journalctl -u phc2sys-gptp -f
pmc -u -b 0 'GET TIME_STATUS_NP'     # gmPresent, master_offset

# UPF picked it up
grep -a 'NW-TT' /var/local/log/open5gs/upf.log | tail -5
# want: "phc2sys detected: system clock is PHC-synchronized"
#       "Timestamp source: CLOCK_REALTIME"
```

## Decisions still needed

- **Profile.** `ptp4l-gptp.conf` assumes **gPTP / IEEE 802.1AS** (L2 transport, P2P
  delay, `01:80:C2:00:00:0E`, domain 0). This matches `upf.yaml`'s
  `gptp.time_domain_number: 0`. If the TSN switches run plain IEEE 1588 default
  profile instead (UDP/IPv4, E2E delay), the config must change.
- **Role.** Config sets `slaveOnly 1` — this host is a *client* of the network's
  grandmaster. If this host should *be* the grandmaster, remove `slaveOnly` and lower
  `priority1` (e.g. 128).
- **Which switch port** `enp37s0f0np0` connects to, and whether that port is in the
  same PTP domain as the two switches' wired sideband.

## Context

Checklist item E1 asks whether anything synchronises the switches to the gNB's frame
timing. Nothing does, and this work does not change that — **PTP here disciplines the
UPF's NW-TT timestamps, not the gNB's radio frame timing.** The two remain
independent. See `VERIFICATION-STATUS.md` U10.
