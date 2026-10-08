# Changes

One section per commit, newest first. Each says **what** changed, **why**,
**how to deploy** it on a running site, **how to verify** it, and **how to roll
back**. To read one commit in full: `git show <hash>`.

| # | Commit | Title |
|---|---|---|
| 21 | *(see `git log -- ue/tsn5g_ue/net/campath.py`)* | Only video enters a camera tunnel |
| 20 | `843846b` | VXLAN path: PCP fixed per VLAN; demo and loss check count tunnelled video |
| 19 | `307983f` | Cameras over VLAN 70/80 in VXLAN (DS-TT on the UE, NW-TT on the core) |
| 18 | `f9fb14d` | gNB crash fixed (srsRAN patch 0002); the UE rebuilds a silent session by itself |
| 17 | `27e9e60` | A stale 5G session is detected and rebuilt with one click |
| 16 | `6773581` | One-click tests fixed for real runs; camera loss check on the console |
| 15 | `ce0ee7e` | Console revamp: 8 pages, one-click tests |
| 14 | `9576362` | Cameras at 20 fps, fixed addresses; auto-rate measures only the radio |
| 13 | `d5e99ad` | Live one-way latency; visual pages; cameras keep their address |
| 12 | `eada6e8` | QoS control on the core: profiles, apply, verify |
| 11 | `cffc73e` | Auto-rate retuned; cameras followed; first rig switched |
| 10 | `4492961` | Stage 6: the Qbv gate measured; SR period 5 ms |
| 9 | `a9bc3c5` | Documentation: deploy guide, lessons, GitHub workflow, secret check |
| 8 | `ab7c260` | `install.sh viewer`: the video viewer as a service |
| 7 | `3376c28` | `install.sh core`: build and run the core and gNB from pinned sources |
| 6 | `aeeb776` | Core scripts and systemd units: the core starts at boot, NAT persists |
| 5 | `1df0865` | Core configuration in git: gNB, Open5GS, subscriber |
| 4 | `8627f1d` | `install.sh ue`: the whole UE in one command |
| 3 | `796eed2` | UE scripts, units and tools take their values from site.env |
| 2 | `df77be5` | One settings file (site.env); UE code reads its site values from config |
| 1 | `d6e4a04` | Repository skeleton; UE app imported with its history (`40f27c2`) |

Before these, `git log -- ue/` shows the UE application's own 40 commits
(`cab4d17` … `fe7c587`).

---

## 21 — Only video enters a camera tunnel

**What** — the PCP fix works: on the core, camera 1 arrives as
`vlan 70, p 4`. The same capture showed two kinds of traffic in the tunnel
that are not video, both now kept out on the UE:
- **Camera discovery:** the encoder sends GigE Vision discovery broadcasts
  (`255.255.255.255:3956`) and SSDP-style multicast on every interface,
  tunnels included. Each tunnel now drops UDP not addressed to its camera's
  video port. Video fragments still pass, because a port match never applies
  to a fragment.
- **IPv6 housekeeping:** the tunnel devices' own MLD and neighbour
  solicitations crossed 5G untagged. IPv6 is now off on the `tb-cam*`
  devices.

**Deploy** — `sudo ./install.sh ue`; the tunnels are rebuilt when the daemon
restarts.

**Verify** — on the core, `sudo tcpdump -i nwtt-vx70 -e -n -c 20 'not (udp port 50451)'`
captures nothing beyond ARP.

---

## 20 — VXLAN path: PCP fixed per VLAN; demo and loss check count tunnelled video

**What**
- First run on the rig (8 Oct): both tunnels carried video, camera 1's outer
  header was source port 5202 with DSCP 34, and camera 2's was 5212 with
  DSCP 0. But VLAN 70 arrived with **PCP 0**, not 4: the priority set before
  the veth did not survive it.
  - Each tunnel's VLAN device now stamps a fixed PCP: 4 on VLAN 70, 0 on
    VLAN 80.
- `demo-run.sh` captures on `-i any`, so in VXLAN mode it counts the
  unwrapped video on `nwtt70`/`nwtt80`. In direct mode it counts `ogstun` as
  before.
- `n3count.py` (camera loss check) counts tunnels by their outer source port
  when the video is in VXLAN.

**Deploy** — `git pull` on the core (the tools run from the UE but copy
`n3count.py` over), then `sudo ./install.sh ue` on the UE. The tunnels are
rebuilt with the new PCP when the daemon restarts.

**Verify** — on the core,
`sudo tcpdump -i nwtt-vx70 -e -n -c 3` shows `vlan 70, p 4` and
`-i nwtt-vx80` shows `vlan 80, p 0`. A camera demo in VXLAN mode gives
camera percentages near 100 % in the baseline phase.

**Roll back** — `git revert`.

---

## 19 — Cameras over VLAN 70/80 in VXLAN (DS-TT on the UE, NW-TT on the core)

**What**
- **UE:** `ue/tsn5g_ue/net/campath.py`. On the Cameras page, **Video path**
  switches between *Direct* (UDP to the core, as before) and
  *VLAN + VXLAN*. With *VLAN + VXLAN*, each camera has its own tunnel, built
  by the TSN bridge's data path:

  | | Camera 1 | Camera 2 |
  |---|---|---|
  | VLAN · PCP | 70 · 4 | 80 · 0 |
  | VXLAN | VNI 70, outer source port **5202**, DSCP 34 | VNI 80, source port 5212, DSCP 0 |
  | UE → server | 10.70.0.2 → 10.70.0.1:50451 | 10.80.0.2 → 10.80.0.1:50452 |
  | 5G flow · UE lane | GBR (QFI 2) · protected | default · best effort |

  - Camera 1 keeps everything that protects it today. The GBR rule matches
    the outer source port, and the lanes, auto-rate and counters classify
    the outer packets.
  - The switch re-points both encoders and restarts them. The choice is
    saved, and the tunnels are rebuilt after every new data call.
  - The old empty VXLAN overlay (`vxlan60/70/80`) is stopped when the
    tunnels are built; it used the same VNIs and had no far end.
- **Core:** `core/scripts/nw-tt.sh` and `tsn5g-nwtt.service` (added to
  `install.sh core`) build the tunnel ends: `nwtt-vx70`/`nwtt-vx80` on
  `ogstun`, learning the UE's end, with VLAN devices `nwtt70`/`nwtt80` that
  carry 10.70.0.1 and 10.80.0.1 for the video server.
  `core/vxlan/README.md` is the core's guide.

**Why** — the blueprint's DS-TT/NW-TT stage: the cameras' traffic crosses 5G
as tagged Ethernet with its PCP, so the 5G system plus the two translators
act as one TSN bridge.

**Deploy**
1. Core: `git pull && sudo core/scripts/nw-tt.sh up` (or `install.sh core`).
2. UE: `sudo ./install.sh ue`.
3. UE: Cameras → Video path → **VLAN + VXLAN**.

**Verify**
- Cameras page: both tunnels *up*, and *Core endpoint* shows "10.70.0.1
  answers" / "10.80.0.1 answers".
- Core: `sudo core/scripts/nw-tt.sh status` shows the learned UE end and
  rising packet counts.
- The viewer shows both cameras.
- Tests → *Camera demo*: camera 1 still kept whole.

**Roll back** — Video path → **Direct** (removes the tunnels and re-points the
encoders). Core: `sudo core/scripts/nw-tt.sh down`.

---

## 18 — gNB crash fixed (srsRAN patch 0002); the UE rebuilds a silent session by itself

**What**
- `core/srsran/0002-scheduler-forget-a-UE-s-QoS-rows-when-it-is-deactiva.patch`:
  - When a UE is deactivated, `logical_channel_system::deactivate()` erases
    the UE's GBR tracking rows but keeps their ids. A buffer report or grant
    that arrives before the UE is removed then aborts the gNB:
    `Assertion has_row_id(rid) failed` in `lcg_qos_context`.
  - The patch resets the ids. It also passes the old LCG id to `remove_lcg()`.
  - Both bugs are still in upstream `main`.
- `ue/tsn5g_ue/watchdog.py`: after `latency.auto_rebuild_s` (90 s) with no
  reply from the core, the UE checks once with a ping over the bearer, then
  runs **Rebuild session** itself.
  - At most one attempt every 10 minutes.
  - `GET /api/latency` reports it under `watchdog`.

**Why** — the 5G link was dead twice, for hours each time:
- 6 Oct, 09:57: the core's health check restarted the gNB at 6.8 GB of memory.
- 8 Oct, 07:18: the gNB aborted on the GBR bookkeeping bug above.

Both times the gNB came back, but the modem never re-attached (no PRACH at
all) until its session was rebuilt by hand.

**Deploy**
- **Core:** rebuild srsRAN with both patches, then restart the gNB at a quiet
  moment:
  ```bash
  cd ~/tsn5g-testbed && git pull
  cd ~/srsRAN_Project && git am ~/tsn5g-testbed/core/srsran/0002-*.patch
  cmake --build build -j"$(nproc)" --target gnb
  sudo systemctl restart srsran-gnb
  ```
  `core/build.sh srsran` does the same for a fresh build.
- **UE:** `sudo ./install.sh ue` (re-renders the config with `auto_rebuild_s`).

**Verify**
- gNB: `journalctl -u srsran-gnb` shows no `has_row_id` abort.
- UE: stop the gNB for 3 minutes, then start it. Within about 2 minutes the
  UE rebuilds by itself: the log says "rebuilding the 5G session" and the
  Overview turns green.

**Roll back**
- Core: `git -C ~/srsRAN_Project reset --hard HEAD~1` and rebuild.
- UE: `auto_rebuild_s: 0` in `site.env`/the config, or `git revert`.

---

## 17 — A stale 5G session is detected and rebuilt with one click

**What**
- The latency probe tracks when the core last answered (`core_silent_s` in
  `GET /api/latency`).
- Health counts the link as down once the core has been silent for 30 s,
  even though the data call still has an address.
- Overview: the 5G link tile says **No traffic**, and "Needs attention"
  links to the fix.
- 5G Link → Data call has a **Rebuild session** button
  (`POST /api/bearer/rebuild`). It re-registers the modem (AT+CFUN=0/1) and
  builds a new PDU session.

**Why** — on 6 Oct the gNB restarted at 09:57 and the modem never
reconnected: the gNB showed `nof_ues=0` and no attach attempts at all. The UE
reported the call as up for five hours while nothing crossed the radio. The
only fix was a session rebuild, which the console had no button for.

**Deploy** — `sudo ./install.sh ue`.

**Verify** — with the gNB stopped, the Overview shows *No traffic* within
about 30 s. **Rebuild session** after the gNB is back brings the latency
chart back.

**Roll back** — `git revert` and `sudo ./install.sh ue`.

---

## 16 — One-click tests fixed for real runs; camera loss check on the console

**What**
- `qbv-live.sh` and `gnb-drift.sh` fetch results from the core with
  `ssh … cat` instead of `scp`.
  - From the console, ssh/scp run as the desktop user. That user cannot write
    into the root-created result folder, so every phase of the first console
    run of *Uplink priority* said "no talker result".
- `camera-loss-check.sh`, rewritten:
  - It slices the core capture with the measured UE/core clock offset. It was
    comparing two windows 37 s apart.
  - It takes the UE's current bearer address; it was fixed at `10.45.0.12`.
  - The capture starts through `core_capture`, with no password prompt.
  - It is on the Tests page as **Camera loss check** (~1 min, cameras
    running).
- `tools/common.sh`: `core_clock_offset`, now shared with `demo-run.sh`.
- `testrun.py`: after a test, Start is pressed until both cameras send video
  (up to 3 tries). If video is already flowing, it does not press at all.
- Auto-rate:
  - no warning when protection is switched off while it runs;
  - it removes the old rule that put its ping in the protected lane.

**Deploy** — `sudo ./install.sh ue`.

**Verify**
- Tests → *Uplink priority* (Quick): the result shows its phases with loss
  and delay.
- Tests → *Camera loss check*: both cameras show near 0 % lost.

**Roll back** — `git revert` and `sudo ./install.sh ue`.

---

## 15 — Console revamp: 8 pages, one-click tests

**What**
- Navigation goes from 17 pages to 8. Pages that answered one question
  between them are now tabs of one page (`web/js/ui/tabs.js`):
  - Testbed: **Overview**, **Cameras**, **Tests** (Test runs · Speed test),
    **Time Sync**;
  - Set-up: **5G Link** (Data call · Interfaces · Routing), **Radio**
    (Signal · Cell & bands · Modem);
  - System: **System** (Logs · Diagnostics · AT console), **TSN Lab**
    (bridge · VXLAN transport · switch, which this rig does not use today).
  - Old addresses (`#/signal`, `#/connection`, …) redirect to the right tab.
- **Overview**, laid out like UniFi's dashboard:
  - the path (cameras → UE → 5G radio → core) with each hop coloured by its
    state;
  - five tiles (link, uplink, camera 1 delay, clock offset, SINR);
  - 5G throughput and the live one-way delay of the two camera lanes;
  - "Needs attention", with a link to the page that fixes each item;
  - the latest test results.
- **Tests**: each CLI tool is a tile with **Run** (camera demo, uplink loss,
  uplink priority, radio clock drift). The run shows live (steps, progress,
  output) and has a **Stop** button; the result opens when it finishes.
  - New in the daemon: `testrun.py`, `GET /api/tests` and
    `POST /api/tests/{id}/run` (job `test.run`, perf lane).
  - The runner pauses the cameras for tests that need a quiet uplink and
    restarts them afterwards. For the demo it starts them.
  - The tools run as root with `TSN5G_AS_USER`. `tools/common.sh` then runs
    ssh/scp as the desktop user, so their key to the core is used.
  - The tools still run from a shell exactly as before.
- **Cameras**:
  - the checklist folds to "Ready for the demo" once all checks pass;
  - live streams are tiles with a one-click **Protection On/Off**;
  - auto-rate is compact, with its settings folded away.
- **Time Sync**: the path and its numbers are one card.
- Fixes:
  - the sidebar status said "Degraded" on every healthy rig. Health checked
    the legacy VXLAN overlay; it now checks the 5G data call;
  - the throughput chart counted every NIC, not the 5G link;
  - the Radio charts stretched a 1 dB wobble to full height;
  - buttons used a different font;
  - the Connection page never showed the last run's output (`echo()` was
    undefined);
  - the CSS for `col5`/`col7` was missing.
- `tools/demo-run.sh`: the core capture starts through `core_capture`, without
  a password prompt (see Deploy). `radio-loss-test.sh` results show under Tests.

**Why** — the user asked for every test to be one click, for UniFi's look
and for no pages that repeat each other. The demo, the loss test, the Qbv test
and the drift test were shell-only, and needed sudo on both machines.

**Deploy**
1. On the core, once, so that a capture needs no password:
   ```bash
   sudo groupadd -f pcap && sudo usermod -aG pcap $USER
   sudo chgrp pcap /usr/bin/tcpdump && sudo chmod 750 /usr/bin/tcpdump
   sudo setcap cap_net_raw,cap_net_admin=eip /usr/bin/tcpdump
   ```
   (a new SSH login picks up the group). Only the camera demo needs this.
2. On the UE: `git pull && sudo ./install.sh ue` (the daemon restarts).

**Verify**
- The sidebar says *Online*.
- The Overview path is green end to end.
- Tests → *Uplink loss* → Run: the cameras pause, four variants run, the
  cameras come back and the result opens. Stop mid-run restores the queue.

**Roll back** — `git revert` this commit and `sudo ./install.sh ue`. The core's
tcpdump change: `sudo setcap -r /usr/bin/tcpdump && sudo chmod 755 /usr/bin/tcpdump`.

---

## 14 — Cameras fixed at 20 fps and fixed addresses; auto-rate measures only the radio

**What**
- `tools/camera-framerate.py`: reads the camera's own GenICam description
  over GVCP (formula nodes included) and sets `AcquisitionFrameRate`, saved to
  User Set 1 as the power-up default. Both cameras: **20 fps**.
- `tools/gige-discover.py --set-persistent`: both cameras keep their address
  (/24 mask matching the NIC) across power cycles.
- Auto-rate:
  - its ping has its own top-priority HTB class `1:5` (protected becomes
    prio 1, best effort prio 2);
  - its thresholds are back to floor 30 / cut at +30 ms;
  - the gentle probing (+2 %/0.25 s) stays.
- Auto-rate no longer dies on a missing delay sample.

**Why** — on 5 Oct the cameras ran at 66 fps, not ~18: with no fixed rate,
the frame rate follows auto-exposure, so the uplink load followed the light.
Auto-rate's ping rode camera 1's lane, so once camera 1 exceeded the shaped
rate the ping measured the UE's own queue and auto-rate spiralled to its
floor. Camera 2 was starved before any flood started. LESSONS.md has both.

**Result** (demo, 5 Oct 17:02, cameras at 20 fps, 50 Mbit/s flood):
- policy on: camera 1 **100.0 %**, camera 2 3.5 %;
- policy off: 98.3 % / 98.8 %;
- protected one-way delay ~15 ms;
- baseline 100 %/100 %.

**Deploy** — per camera, once, with the encoders stopped (DEPLOY.md §4.1):
```bash
sudo python3 tools/camera-framerate.py --iface <CAM_IF> --fps 20 --save
sudo python3 tools/gige-discover.py --iface <CAM_IF> --set-persistent <CAM_IP> --serial <SERIAL>
```
(camera 2 inside `sudo ip netns exec cam2 …`)

**Verify** — `camera-framerate.py --show` gives `AcquisitionResultingFrameRate
20.00`; after a power cycle the camera keeps 20 fps and its address.

**Roll back** — `--fps` with another value (or re-save the camera's Default
user set in SpinView); `--set-persistent` with another address.

---

## 13 — Live one-way latency; visual Time Sync and Tests pages; cameras keep their address

**What**
- **One-way latency probe** (`ue/tsn5g_ue/net/latency.py`): 20 small packets a
  second in each camera lane.
  - **Protected lane:** sent from `GBR_SOURCE_PORT` into HTB class 1:10, so
    the same GBR flow and the same priority as camera 1.
  - **Best-effort lane:** the default flow, like camera 2.
  - `core/scripts/latency-reflector.py` stamps each probe on the core and
    sends it back. Both system clocks are PTP-disciplined to UTC, so the UE
    gets real one-way delay in each direction.
  - Per-second statistics kept for an hour; API `GET/PUT /api/latency`,
    `GET /api/latency/history`.
  - Core unit `tsn5g-latency-reflector.service` (part of `install.sh core`).
- **Tests page** (Testing → Tests):
  - a live latency card: protected vs best-effort uplink, median and p99,
    downlink, loss, and a health strip;
  - the saved runs: drift as a waterfall heatmap, the QoS test, the camera demo.
- **Time Sync page** redrawn, UniFi-style:
  - the clock path with a colour-coded offset on each link;
  - four big numbers;
  - the health chart with a lock strip;
  - the events.

  Daemon PTP history: `/api/ptp/history`.
- **`tools/gige-discover.py --set-persistent`** stores each camera's address
  and a /24 mask in the camera, so the vendor SDK stops moving camera 2.

**Why** — both clocks are now on PTP, so latency can be shown as one-way
delay per lane rather than delay variation. Camera 2 had moved between three
addresses in one day.

**Deploy**
```bash
sudo ./install.sh ue                                            # UE: new code and pages
# core: start the reflector (or install.sh core installs the unit)
python3 ~/tsn5g-testbed/core/scripts/latency-reflector.py &
# cameras, once, with the encoders stopped:
sudo systemctl stop tsn5g-cameras
sudo ip netns exec cam2 python3 tools/gige-discover.py --iface enp7s0 --set-persistent 169.254.143.19 --serial 25170574
sudo python3 tools/gige-discover.py --iface enp8s0 --set-persistent 169.254.144.18 --serial 25170575
sudo systemctl start tsn5g-cameras
```

**Verify** — Tests shows "live" with protected median of a few ms and 0 %
loss. After the cameras restart, `journalctl -u tsn5g-cameras` has no
"camera answers at …" line.

**Roll back** — `PUT /api/latency {"enabled": false}`; the persistent
camera address is undone with SpinView or by re-running `--set-persistent`
with another address.

---

## 12 — QoS control on the core: profiles, apply, verify (Stages 4/5)

**What**
- `core/qos/profiles.json`: named QoS profiles (protected camera 5QI 4 GBR 25/40
  on UE source port 5202; a smaller GBR variant; video-priority 5QI 6;
  control-low-latency 5QI 3).
- `core/qos/qos-ctl.py`:
  - `profiles`: lists the library;
  - `show`: MongoDB PCC rules, SMF live flows (`/pdu-info`) and the gNB config's
    treatment per 5QI, flagging mismatches and 5QIs the gNB has no entry for;
  - `apply PROFILE… [--rebuild]` / `--clear`: writes the PCC rules (backup
    first, keys untouched) and optionally has the UE build a new session
    through its API;
  - `verify`: captures uplink N3, reads the QFI from each GTP-U packet's PDU
    Session Container, and reports per UE source port which flow it really
    used, against what its rule says (PASS/FAIL).

**Why** — Stage 4 aimed to read the QoS rules back from the modem, but the
RM520N reports none:
- `AT+C5GQOSRDP` is unsupported;
- `+CGEQOSRDP` and `+CGTFTRDP` return empty;
- QMI QoS reports "not supported".

The core has the rules, the live flows and the packets themselves, so control
and verification live there. Before this, the PCC rule existed only as a
hand-edited MongoDB record; the source-port trap (LESSONS.md) is what `verify`
now catches.

**Deploy** — `git pull` on the core; the tool runs from the checkout or from
`/opt/tsn5g/core/qos/` after `install.sh core`. It needs mongosh and tcpdump
(both installed with the core).

**Verify**
```bash
core/qos/qos-ctl.py show                  # configured and live flows agree
sudo core/qos/qos-ctl.py verify           # with the cameras running: camera 1 -> 5QI 4, PASS
```

**Roll back** — restore the previous rules from the newest backup in
`/var/lib/tsn5g/qos-backups/` (its `slice[].session[].pcc_rule`), or re-run
`core/open5gs/provision.sh`, which writes the standard camera rule.

---

## 11 — Auto-rate retuned; cameras followed when they move; first rig switched to the repo

**What**
- Auto-rate probes gently: `raise_pct` and `interval_s` are now settings
  (API and config), defaulting to +2 % per 0.25 s with two pings per tick
  (was +6 % per 0.5 s). The template also lowers the floor from 30 to
  15 Mbit/s and cuts once the modem holds 15 ms (was 30 ms). `configure()`
  validates a copy, so a rejected request changes nothing.
- Cameras: `probe()` and `wait_control_free()` fall back to a broadcast GVCP
  discovery on the camera's own NIC when the camera doesn't answer at its
  configured address, follow the address that answers, and log the move.
  The vendor SDK forces camera 2 onto a new address each time it opens it
  (seen: .18, .19, .20).
- `tools/gige-discover.py`: lists the GigE cameras on a NIC whatever their
  address; `--force-ip` moves one.
- `camera2-netns.sh`: `SUDO_USER` is unset under systemd (latent bug, first
  hit by a fresh `up`).
- `site.env`: `CAM2_IP=169.254.143.19`.
- The first rig's UE now runs from `/opt/tsn5g` (`install.sh ue`).

**Why** — under an 80 Mbit/s flood the old auto-rate let the protected
stream's p99 reach 145 ms: each raise overshot the radio, and the excess queued
in the modem. Measured with `tools/qbv-live.sh`, phase R-auto:

| Auto-rate | loss | p50 | p99 |
|---|---|---|---|
| old: +6 %/0.5 s, floor 30, cut at 30 ms | 0 % | 4.5 ms | 145 ms |
| thresholds only (floor 15, cut at 15 ms) | 0 % | 9.0 ms | 98 ms |
| **new: + gentle probing** | **0 %** | **3.3 ms** | **56 ms** |

The camera demo afterwards (`demo-run.sh`, 3 off/on pairs): camera 1 kept
**99.9 %** with the policy on against **79.8 %** off; camera 2 gave way to 11 %,
the same as before the change.

**Deploy** — `sudo ./install.sh ue`. Settings saved earlier through the UI
keep their values; set `raise_pct`/`interval_s` with
`PUT /api/bearer/autorate` if they were saved before this change.

**Verify** — `tools/qbv-live.sh` with `PHASES="R-auto"` gives p99 ≈ 50-60 ms;
`/opt/tsn5g/tools/demo-run.sh` keeps camera 1 at ≥ 99.8 %.

**Roll back** — `PUT /api/bearer/autorate` with
`{"raise_pct":6,"interval_s":0.5,"min_mbps":30,"delay_hi_ms":30,"delay_lo_ms":12}`.

---

## 10 — Stage 6: the Qbv gate measured; SR period 5 ms in the gNB template

**What**
- `tools/qbv-sandbox.sh`: gate designs in throwaway namespaces with an
  emulated radio.
- `tools/qbv-live.sh`: the real uplink, using the time-stamped talker
  `tools/qbv-talker.py`.
  - Phases: no policy; today's priority shaper; 4 ms and 5 ms gates; the
    daemon's auto-rate policy; a sweep of send phase across the 5 ms TDD frame.
  - Run a subset with `PHASES=…`.
  - It prints per-hop counters (namespace, veth, forwarding, NAT, conntrack)
    for every phase.
- `core/gnb/gnb.yaml.in`: `cell_cfg.pucch.sr_period_ms: 5` (was the default 20).
- `ue/scripts/cameras-start.sh`: clears the cameras' conntrack entries on start
  (a fixed-port NAT collision could black out camera 1 for up to 30 s).
- LESSONS.md: the Stage 6 findings.

**Why** — see LESSONS.md, "Time-sensitive uplink". Measured on the first rig,
2026-10-04, against an 80 Mbit/s flood with a 9.6 Mbit/s protected talker on
the GBR flow:

| Policy | loss | delay variation p50 / p99 |
|---|---|---|
| none | 22.7 % | 113 / 374 ms |
| priority shaper at 40 Mbit/s | 0 % | 5-12 / 84-130 ms |
| priority shaper at 25 Mbit/s | 0 % | 3-4 / 28 ms |
| + 4 ms or 5 ms gate | 0 % | no better; timed talker 30-41 ms p50 (clocks not aligned) |

**Deploy** — the gNB change: `sudo SKIP_BUILD=1 ./install.sh core`, or on the
first rig add the two lines under `cell_cfg:` in `gnb_x410.yaml` and restart
srsran-gnb. The UE must re-establish its data call afterwards.

**Verify** — `grep sr_period_ms /var/log/tsn5g/gnb.log` shows 5;
`PHASES="P-baseline B-uni" tools/qbv-live.sh` gives an idle p50 of ~12 ms.

**Roll back** — remove the `pucch:` block and restart the gNB.

---

## 9 — Documentation: deploy guide, lessons, GitHub workflow, secret check

**What**
- `docs/DEPLOY.md` — a new site from scratch. It covers:
  - hardware;
  - filling in site.env, and where to find each value;
  - core RT tuning (BIOS, picking cores, `rt-grub.sh`);
  - the X410 link;
  - the three installs in order (core, viewer, UE);
  - first connection and the demo;
  - a symptom → cause table;
  - changing things later;
  - moving the first rig onto this layout.
- `docs/LESSONS.md` — every trap from the first rig: symptom, cause, and
  where the fix now lives.
- `docs/GITHUB.md` — a private repo, a deploy key per machine, the first push
  from the UE, a clone on the core, the everyday pull / commit / push, and
  what to do on rejection, conflict or a refused commit.
- `tools/git-hooks/pre-commit` — refuses site.env, secrets.env, `.env` files,
  WebUI backups, SIM keys or private keys in added lines (Open5GS's upstream
  test keys excepted), and files over 50 MB. Enable it with
  `git config core.hooksPath tools/git-hooks`.
- `install.sh core` disables `fwupd-refresh.timer` (it wedged the X410 stream
  on the first rig).
- `core/ptp/ptp4l-gptp.conf` no longer names the first rig's NIC. The
  interface comes from `-i CORE_PTP_IF`; before, ptp4l would also have run on
  the old port.
- README layout, `lib/README.md`, `tools/README.md`.

**Why** — the testbed is moving to new hardware and will be used by people
who were not there when it was built.

**Deploy** — documentation only. Enable the hook in each clone:
`git config core.hooksPath tools/git-hooks`.

**Verify** — follow DEPLOY.md on the new hardware. That is the acceptance test.

**Roll back** — `git revert <this commit>`.

---

## 8 — `install.sh viewer`: the video viewer as a service

**What**
- `lib/install-viewer.sh`, five steps:
  1. packages: Xvfb, x11vnc, openbox, and the Qt/xcb runtime libraries the
     vendor bundles need (worked out from the bundles' `ldd` output; also
     added to the UE install)
  2. `pathView2.tar.gz` from `VENDOR_DIR`, sha256-checked, unpacked to
     `$PREFIX/video/viewer/`; `config.json` generated with seven streams from
     `VIEWER_PORT_FIRST` (the same content as the first rig's)
  3. sysctl: 8 MB default UDP receive buffer
  4. `tsn5g-viewer-display.service` (the virtual screen, the same
     `vnc-display.sh` as the UE) and `tsn5g-viewer.service` (the viewer on it,
     restarted if it exits)
  5. enable and start. A viewer that was started by hand is left running.
- site.env: `VIEWER_USER`.

**Why** — on the first rig the core's screen and viewer were started by hand
after every reboot (`~/vnc-display.sh up`, then `cd ~/pathView2 &&
./bin/pathView2`). If nobody did it, the demo had no receiver.

**Deploy**
```bash
sudo mkdir -p /srv/tsn5g-vendor && sudo cp pathView2.tar.gz /srv/tsn5g-vendor/
sudo ./install.sh viewer
```
On the first rig, close the hand-started viewer first (or it is left alone),
then `sudo systemctl start tsn5g-viewer`.

**Verify**
```bash
systemctl is-active tsn5g-viewer-display tsn5g-viewer
ss -ulpn | grep pathView2              # listening on 50451..50457
# from your PC: ssh -L 5902:localhost:5900 <VIEWER_USER>@<core>  -> VNC localhost:5902
```

**Roll back** — `sudo ./install.sh viewer --remove`; start the viewer by hand
as before.

---

## 7 — `install.sh core`: build and run the core and gNB from pinned sources

**What**
- `core/open5gs/src/` — the TSN/5G-ACIA Open5GS fork. On the first rig it
  existed only as a zip plus an unpacked tree. Compared with the zip, the C
  code is unchanged. Local work was in the WebUI (a new **gNB QoS** page:
  `webui/server/routes/gnb-qos.js`, `webui/src/components/GnbQos`,
  `webui/src/containers/GnbQos`, plus routing and sidebar edits) and in the
  config templates. Left out:
  - build output, `node_modules`, `.next`
  - `.bak` files
  - the 3GPP specification PDFs (`3gpp-tsn-docs/`)
  - meson's downloaded subprojects (re-fetched at their pinned `.wrap`
    revisions)
  - `webui/.env`, which holds the WebUI's session secrets; it is regenerated
    on first start.

  The `*.key` files under `src/configs/open5gs/{hnet,tls}` are upstream's
  published test keys, identical to the zip. Nothing uses them: the rendered
  UDM config points at per-site keys that `install.sh core` generates.
- `core/srsran/0001-…patch` — the GBR-on-Modify fix that was an unpushed
  local commit (`078c938` on `4bf1543`). Without it the GBR flow never got its
  guaranteed rate and every DRB looked identical to the modem's LCP.
- `core/build.sh [all|deps|srsran|open5gs|webui]`:
  - deps: Ubuntu packages, UHD 4.6 from the archive, MongoDB 7.0 and Node.js
    20 from their own repositories (the same sources the first rig used);
  - srsRAN: cloned at `SRSRAN_COMMIT`, patched, Release build with
    `-march=native`;
  - Open5GS: meson **debug** buildtype, as the first rig ran it;
  - WebUI: `npm install`.
  Each step skips work that is already done.
- `lib/install-core.sh`, nine steps:
  1. preflight: NICs present, RT CPU isolation active, NFs started outside
     systemd
  2. code to `$PREFIX`
  3. build
  4. configs to `/etc/tsn5g` and per-site UDM hnet keys
  5. sysctl and logrotate
  6. units
  7. enable at boot
  8. start, in order: core, then subscriber, then gNB
  9. checks: 12 NFs, NRF, NGAP

  `SKIP_BUILD=1` re-renders configs without rebuilding.

**Why** — rebuilding the first rig's core by hand meant knowing which zip,
which srsRAN commit plus which uncommitted patch, which build options, and
which apt repositories. Now that knowledge is in one script.

**Deploy** — on a new core (Ubuntu 24.04, X410 cabled, see DEPLOY.md):
```bash
cp site.env.example site.env && nano site.env
cp secrets.env.example secrets.env && chmod 600 secrets.env && nano secrets.env
sudo core/scripts/rt-grub.sh && sudo reboot        # once: real-time kernel parameters
sudo ./install.sh core                             # ~30-60 min, mostly the srsRAN build
```

**Verify**
```bash
/opt/tsn5g/core/scripts/open5gs-ctl.sh status       # 12 NFs, webui, gnb active
sleep 120; /opt/tsn5g/core/scripts/tsn_health.sh    # all PASS
```

**Roll back** — `sudo systemctl disable --now open5gs.target open5gs-webui
srsran-gnb tsn5g-core-net tsn-health.timer`. The build tree is in
`$PREFIX/build` and can simply be deleted.

---

## 6 — Core scripts and systemd units: the core starts at boot, NAT persists

**What**
- **Open5GS under systemd.** `open5gs@.service` (one instance per NF) and
  `open5gs.target` (all 12). Each NF restarts if it dies. Configs come from
  `/etc/tsn5g/open5gs/`. `open5gs-webui.service` runs the WebUI as `CORE_USER`.
  `core/scripts/open5gs-ctl.sh status|start|stop|restart|logs` replaces
  run5gs.sh for daily use.
- **`tsn5g-core-net.service`** (`core-net.sh up`): ogstun with
  `CORE_BEARER_IP`, ogstap, `ip_forward`, MASQUERADE for `UE_POOL` out of
  `CORE_LAN_IF`, and the X410 link (MTU, address, UHD buffers).
- `srsran-gnb.service.in` — the live unit with site values. It is now ordered
  after the core (NG Setup needs the AMF). The log is in `/var/log/tsn5g/` and
  still archived per start.
- `tsn_health.sh`:
  - site values from site.env;
  - repairs through `systemctl start|restart open5gs.target`;
  - **rotating an oversized gnb.log archives it gzipped first** (keeps 5);
  - **pause file** `/etc/tsn5g/health.pause` stops auto-repair during an
    experiment, while checks still run.
- `restart_all.sh`, `post_reboot_check.sh` — parameterised; the second now
  checks the networking that boot sets up.
- `rt-grub.sh` (was `fix_grub_rt.sh`) takes the CPU list from
  `GNB_ISOLATED_CPUS`.
- `x410-find-nic.sh` shows link, speed, **NUMA node** and module per NIC, the
  three things needed to fill in `X410_HOST_IF` and `GNB_NUMA_NODE`.
- `core/etc/90-tsn-udp.conf` (UPF socket buffer 8 MB, UHD buffers,
  ip_forward) and a logrotate rule for the NF logs.
- `core/ptp/` — optional core gPTP, on `CORE_PTP_IF` (new in site.env).
- `docs/history/core/` and `tools/core-experiments/` — the first rig's notes
  and one-off test scripts, unchanged, for reference.

**Why** — on the first rig nothing started the core at boot: the health timer
noticed it was down three minutes later and ran run5gs.sh. NAT and
`ip_forward` were lost on every reboot, until someone ran
post_reboot_check.sh. The gNB could come up before the AMF existed.

**Deploy** — installed by `install.sh core` (commit 7). Moving the first rig's
core onto these units is a maintenance window: it stops the hand-started NFs
and drops the UE for about a minute.

**Verify**
```bash
sudo reboot            # then, with no manual step:
/opt/tsn5g/core/scripts/open5gs-ctl.sh status             # all active
/opt/tsn5g/core/scripts/tsn_health.sh                      # all PASS after ~3 min
sudo iptables -t nat -S POSTROUTING | grep MASQUERADE      # present
```

**Roll back** — `sudo systemctl disable --now open5gs.target open5gs-webui
tsn5g-core-net`, then start the old way (`run5gs.sh start`) and re-install the
previous `srsran-gnb.service` / `tsn-health.service` from the old directory.

---

## 5 — Core configuration in git: gNB, Open5GS, subscriber

**What**
- `core/gnb/gnb.yaml.in` — the live `~/tsntestbed/gnb_x410.yaml` of
  2026-10-03 with its comments, site values replaced by site.env variables
  (PLMN, TAC, X410 address, ARFCN, band, bandwidth, SCS, sample rate, PCI,
  gains, CPU sets). Two deliberate changes:
  - `metrics.enable_log: false` — on, it raised RF underflows about 4×;
    turn it on only while debugging the link.
  - log file `/var/log/tsn5g/gnb.log` instead of the home directory.
- `core/open5gs/configs/*.yaml.in` — the 12 network functions that run
  (nrf scp ausf udm udr pcf nssf bsf amf smf upf tsn-af), from the fork's
  `build/configs/open5gs/`. PLMN, TAC, DNN, UE pool, gateway and MTU come from
  site.env. **Fix:** UDM pointed at `/etc/open5gs/hnet/*.key`, which did not
  exist on the core; it now points at `${ETC_DIR}/open5gs/hnet/`, where
  `install.sh core` generates per-site keys (commit 7).
- `core/open5gs/subscriber.json.in` + `provision.sh` — the UE's record, which
  until now existed only inside MongoDB: static IP, default 5QI 7, UL AMBR
  50 Mbit/s, one PCC rule (5QI 4, GBR 25 / MBR 40 Mbit/s, "permit out udp/tcp
  from any 1-65535 to assigned 5202"). K/OPc come from `secrets.env`; an
  existing record's SQN is kept. `--dry-run` prints the record with keys masked.
- site.env: `GBR_5QI`, `DEFAULT_5QI`, `UE_AMBR_UL_MBPS`, `GNB_SRATE`.

**Why** — none of the core's configuration was under version control. The
subscriber/PCC rule that the whole demo depends on was one accidental WebUI
click from being lost.

**Deploy** — nothing changes on the running core in this commit. The files are
used by `install.sh core` (commit 7). To provision the subscriber on any core:
```bash
cp secrets.env.example secrets.env && chmod 600 secrets.env && nano secrets.env
core/open5gs/provision.sh --dry-run        # check, keys masked
sudo core/open5gs/provision.sh
```

**Verify** — rendered files equal the first rig's live ones except for the
changes listed above:
```bash
DRY_RUN=1 bash -c '. lib/render.sh; load_site; render core/gnb/gnb.yaml.in /etc/tsn5g/gnb.yaml'
diff rendered/etc/tsn5g/gnb.yaml ~/tsntestbed/gnb_x410.yaml     # on the first rig's core
```

**Roll back** — `git revert <this commit>`; nothing outside the repository
changed.

---

## 4 — `install.sh ue`: the whole UE in one command

**What**
- `install.sh` at the repository root: one installer, the role as its argument
  (`ue` now; `core` and `viewer` in later commits). Options: `--dry-run`
  (renders into `rendered/`, changes nothing, needs no sudo), `--site FILE`,
  `--no-start`, `--start-cameras`, `--remove`.
- `lib/install-ue.sh`, nine steps, each safe to repeat:
  1. packages (all from the Ubuntu archive; includes Xvfb, x11vnc, openbox,
     linuxptp, conntrack, tcpdump, libqmi-utils, iperf3)
  2. ModemManager masked
  3. NetworkManager leaves the camera NICs alone; sysctl
  4. code to `$PREFIX` (`/opt/tsn5g`), root-owned; site.env to `$ETC_DIR`
  5. daemon config rendered to `$ETC_DIR/tsn5g-ue.yaml` (previous copy kept as
     `.bak-<date>`); systemd units rendered
  6. sudoers (validated with `visudo` before it is installed) and polkit
  7. encoder bundle unpacked from `$VENDOR_DIR` after a sha256 check against
     `video/MANIFEST`; our `run.sh` and camera configs laid over it
  8. units enabled at boot
  9. started; waits for the UI's `/api/health`. Running encoders are left
     alone unless `--start-cameras`.
- `lib/render.sh` gains `install_sudoers`, `install_bundle`, `wait_health`,
  `backup_if_changed`.
- `video/`: `MANIFEST`, the encoder's `run.sh`, `camera1/2.json.in`.
- The old single-product installer (`ue/scripts/install.sh`, `uninstall.sh`,
  `package.sh`, `ue/systemd/`) is gone; the kiosk unit is a template too.

**Why** — the first rig was assembled by hand over weeks (units copied from the
repo, sudoers installed by hand, encoders unpacked into a home directory, NM
conf written once). A new site now runs one command per machine.

**Deploy** — on a new UE (or to move this one onto `/opt/tsn5g`):
```bash
sudo mkdir -p /srv/tsn5g-vendor && sudo cp pathStream1.tar.gz /srv/tsn5g-vendor/
cp site.env.example site.env && nano site.env
./install.sh ue --dry-run            # read what it would do; files in rendered/
sudo ./install.sh ue
```
On the first rig this replaces the four units that pointed into
`~/camera_application/tsn5g-ue-app`; the daemon restarts (about 10 s, the data
call survives), the encoders are left running until `--start-cameras`.

**Verify**
```bash
systemctl is-active tsn5g-ue tsn5g-cam2-netns tsn5g-vnc-display tsn5g-cameras
curl -s localhost:8080/api/health
/opt/tsn5g/tools/camera-loss-check.sh 30          # both cameras ~0 % loss
```

**Roll back** — `sudo ./install.sh ue --remove`, then re-install the old units
from `~/camera_application/tsn5g-ue-app` (its `scripts/install-autostart.sh`
and `systemd/tsn5g-ue.di1200.service`). `/etc/tsn5g/*.bak-*` holds the
previous config.

---

## 3 — UE scripts, units and tools take their values from site.env

**What**
- `ue/templates/systemd/*.service.in` replace the four rig-bound units
  (`tsn5g-ue`, `tsn5g-cam2-netns`, `tsn5g-vnc-display`, `tsn5g-cameras`):
  code under `${PREFIX}/ue`, config at `${ETC_DIR}/tsn5g-ue.yaml`, screen
  `:${DISPLAY_NUM}`, desktop user `${UE_USER}`.
- `tsn5g-cameras` now also **presses the encoders' Start button** after
  launching them (`ExecStartPost`, the same XTEST helper the UI uses), so
  video flows after a reboot without anyone opening VNC.
- `ue/templates/etc/`: sudoers (checked with `visudo -c`), polkit rule
  (now also covers the three camera units), NetworkManager "leave the camera
  NICs alone" conf (`CAM1_IF`, `CAM2_IF`), sysctl (16 MB socket ceilings,
  `ip_forward` for camera 2's namespace).
- `ue/scripts/site-env.sh`: the one place the rig scripts load settings from
  (`$SITE_ENV`, then `/etc/tsn5g/site.env`, then the checkout's `site.env`).
  `camera2-netns.sh`, `cameras-start.sh`, `vnc-display.sh` use it.
- `install-autostart.sh` renders the unit templates instead of copying fixed
  files; the UI's "up to date" check compares against the rendered template.
- Measurement tools moved to `tools/` (`demo-run.sh`, `lcp-test.sh`,
  `camera-loss-check.sh`, `radio-loss-test.sh` and their analysers) and read
  `tools/common.sh`: `CORE_SSH` (user@core LAN address), `CORE_IP` (core across
  the bearer), `WWAN`, `GBR_PORT`, camera ports. Any of them can be overridden
  for one run, e.g. `CORE_SSH=me@host ./tools/demo-run.sh`.
- Manual modem bring-up helpers `ue_qmi_up.sh` and `at.py` (previously outside
  any repository) are now in `tools/modem/`, with defaults from site.env.

**Why** — the old units and scripts named `/home/amrc/camera_application/…`,
user `amrc`, `enp7s0`, `wwan0`, `tsn_server@10.5.1.19` directly. Two tools
also used `CORE` for different things (an SSH target in one, the bearer
address in another); the new names say which is which.

**Deploy** — through `install.sh ue` (commit 4). To refresh only the boot units
on a rig that already runs from `/opt/tsn5g`:
```bash
sudo /opt/tsn5g/ue/scripts/install-autostart.sh            # --start-cameras to take over running encoders
```

**Verify**
```bash
DRY_RUN=1 bash -c '. lib/render.sh; load_site; render ue/templates/etc/tsn5g-ue.sudoers.in /etc/sudoers.d/tsn5g-ue'
visudo -c -f rendered/etc/sudoers.d/tsn5g-ue          # "parsed OK"
grep -rn "/home/amrc\|tsn_server@" ue/templates tools   # nothing
./tools/demo-run.sh                                      # still runs the demo end to end
```

**Roll back** — `git revert <this commit>`; re-install the previous units with
the previous `install-autostart.sh`.

---

## 2 — One settings file (site.env); UE code reads its site values from config

**What**
- `site.env.example`: every site-specific value in one commented file —
  5G identity (PLMN, DNN, UE pool, GBR port), core addresses and NICs, the
  USRP X410 link, gNB radio and real-time CPU layout, pinned source versions,
  UE NICs, camera serials and ports, PTP, video display/VNC.
  `secrets.env.example` for SIM keys (never committed).
- `lib/render.sh`: loads site.env, renders `*.in` templates substituting only
  site variables (shell `$1`/`$(…)` inside templates untouched), refuses to
  write a file that still has `${UNSET}` in it, supports `--dry-run`
  (output under `rendered/`).
- `ue/templates/tsn5g-ue.yaml.in`: the daemon config as a template, with the
  first rig's final demo state baked in — camera 1 on the GBR bearer
  (`source_port: ${GBR_SOURCE_PORT}`), auto-rate on — and a new `rig:` section.
- `ue/tsn5g_ue/rig.py`: `configure()` takes the namespace, NIC, veth subnet,
  bearer, core IP, display, VNC port, desktop user and GBR port from `rig:`;
  the controller calls it at start-up. `encoder_gui.py` takes the display from
  `TSN5G_DISPLAY`. VNC hints in the UI use the configured user and address.
- `ue/pyproject.toml`: package list now includes `net`, `modem`, `perf` and
  `tsnbridge` (a pip install was missing them).

**Why** — about 120 values were tied to the first rig (its IPs, `enp7s0`,
`wwan0`, user `amrc`, `/home/amrc/…`). A new site now changes one file.

**Deploy** — no effect on a running rig until `install.sh` (commit 4) renders
the config; the daemon falls back to the old defaults when `rig:` is absent.

**Verify**
```bash
cp site.env.example site.env           # or your real values
bash -c '. lib/render.sh; DRY_RUN=1; load_site; render ue/templates/tsn5g-ue.yaml.in /etc/tsn5g/tsn5g-ue.yaml'
less rendered/etc/tsn5g/tsn5g-ue.yaml  # every value comes from site.env
```

**Roll back** — `git revert <this commit>`; the defaults in `rig.py` are the
first rig's values.

---

## 1 — Repository skeleton; UE app imported with its history

**What**
- New repository `tsn5g-testbed` with the role-based layout (`ue/`, `core/`,
  `video/`, `tools/`, `docs/`) described in the README.
- The UE application (previously `~/camera_application/tsn5g-ue-app`) is
  imported into `ue/` with `git subtree`, so all 40 earlier commits keep their
  history (`git log -- ue/`).
- `.gitignore` keeps site settings, secrets, vendor bundles, logs and captures
  out of git.

**Why** — the testbed is moving to new hardware. One repository holding every
part (UE, core, gNB, video) means one clone per machine and settings that
cannot drift apart between UE and core.

**Deploy** — nothing to deploy yet; the running rig is unchanged. This commit
only creates the repository.

**Verify**
```bash
git log --oneline -- ue/ | head        # the UE history is present
git status --ignored | grep site.env   # (after creating one) shown as ignored
```

**Roll back** — delete the repository directory; nothing outside it changed.
