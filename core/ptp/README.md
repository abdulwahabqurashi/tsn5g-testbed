# core/ptp — wired PTP on the core

One command:

```bash
sudo core/ptp/setup-ptp.sh --iface "$CORE_PTP_IF"      # enp37s0f0np0 here
sudo core/ptp/setup-ptp.sh --iface enp37s0f0np0 --detect-only   # probe, change nothing
```

It finds the grandmaster on the wire, writes `/etc/linuxptp/ptp4l-tsn.conf`,
installs `ptp4l-tsn.service` and `phc2sys-tsn.service`, grants the WebUI a
narrow sudo right to start/stop them, and waits for servo state `s2`.

## Measured on this rig (2026-10-05)

| | |
|---|---|
| Port | `enp37s0f0np0` — Intel E810 (`ice`), `/dev/ptp0` |
| Profile | **IEEE 1588 Annex F over L2**, untagged, domain 0 |
| Destination MAC | `01:1b:19:00:00:00` |
| Grandmaster | `000580.fffe.087a51` — the same clock the UE follows |
| NIC → GM | mean 28.6 ns |
| System clock → UTC | mean 20.9 ns |
| Path delay | 1881 ns |

Both services are enabled, so PTP survives a reboot.

## Four things that cost a day, in order of how much

**1. Never pass `-w` to phc2sys here.** It reads the UTC offset from ptp4l over
the management interface and **silently overrides `-O`**. This grandmaster
advertises the ARB timescale (`ptp4l` logs *"foreign master not using PTP
timescale"*), so ptp4l has no valid offset to give, phc2sys applies 0, and the
system clock is steered to the PHC itself — i.e. to TAI. Observed: the clock
marched 6 seconds into the future in under a minute, **reporting `s2` the whole
time**. `s2` means "tracking something", not "tracking the right thing".

**2. The grandmaster runs TAI, exactly UTC+37.** `phc_ctl /dev/ptp0 cmp` gave
`-37000174971 ns`. So phc2sys needs `-O -37`; with the default `-O 0` the host
sits 37 s in the future and nothing reports an error. The UE independently
arrived at the same value.

**3. This is NOT 802.1AS.** The earlier `install-ptp.sh` / `ptp4l-gptp.conf` in
this directory assumed gPTP (P2P delay, `transportSpecific 0x1`,
`01:80:C2:00:00:0E`). Against a 1588 grandmaster that mismatch is silent —
ptp4l simply never leaves `s0`. `setup-ptp.sh` decides the profile from the
**destination MAC**, which is unambiguous and survives VLAN tags.

**4. The grandmaster announces slowly.** With `logAnnounceInterval 0` (expect
1/s) ptp4l found the GM, hit `ANNOUNCE_RECEIPT_TIMEOUT_EXPIRES` and dropped back
to LISTENING in a loop — which looks exactly like a profile mismatch and is not.
Defaults are now `logAnnounceInterval 1` + `announceReceiptTimeout 10` (20 s of
tolerance); `--announce-interval` / `--announce-timeout` override them.

## VLAN

The core's switch port is an **untagged access port** in the PTP VLAN, so no
VLAN is configured here — `--vlan` exists for a trunk port. The UE runs tagged
on VLAN 4011; the two ends may differ, the switch handles it. Note
`<parent>.<vlan>` can exceed the 15-character interface-name limit
(`enp37s0f0np0.4011` is 20), so the script falls back to `ptp<vlan>`.

## Why the WebUI drives systemd instead of spawning ptp4l

The WebUI runs unprivileged; ptp4l needs `CAP_NET_RAW`, `CAP_NET_ADMIN` and
write access to `/dev/ptpN`. Rather than run the UI as root, `setup-ptp.sh`
installs `/etc/sudoers.d/open5gs-webui-ptp` granting exactly start/stop/restart
of the two units plus one **read-only** `systemctl show --property=Id` — the
readiness panel needs a way to prove it holds the permission without starting
anything. `tcpdump` is deliberately **not** granted: it would let the UI capture
traffic on any interface. Detection stays a command a human runs.

Status and control: WebUI → **Time Sync** → *PTP setup*.
