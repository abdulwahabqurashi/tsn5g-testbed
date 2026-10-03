# Handover — TSN-5G UE Console

> **Historical.** This describes the first rig as it ran from
> `~/camera_application/tsn5g-ue-app`. In this repository the units, sudoers and
> polkit files are templates under `ue/templates/`, the tools are in `tools/`,
> and everything installs to `/opt/tsn5g` with `install.sh ue` — see
> `docs/DEPLOY.md` at the repository root.

Read this instead of re-deriving the project. Written 22 Sep 2026, after the
session that built the console and the software TSN bridge.

Everything here was verified on the rig unless marked otherwise. Where a claim
is a guess, it says so.

---

## 0. Read this part first — it will save you an hour

**`sudo` is denied to you, but the operating system is not the thing denying
it.** Two separate layers were previously conflated here; keeping them apart
saves the hour.

**Layer 1 — Claude Code policy.** `~/.claude/remote-settings.json`, pushed from
the AMRC org console, denies `Bash(sudo *)`, `Bash(curl *)`, `Bash(wget *)`,
`Bash(rm -rf *)`, and reads of `./.env*`, `~/.ssh/**`. With
`allowManagedPermissionRulesOnly: true` your own user and project settings are
inert for permissions, and `deny` beats `allow` regardless. **No local config
change restores `sudo`.** Do not hand-edit the managed file — it resyncs, and
it is a governance control. A sandbox also sets `denyWrite: ["/etc", ...]`, so
`/etc` is closed to you whatever your privilege.

**Layer 2 — the OS, which already says yes.** `/etc/sudoers.d/tsn5g-ue`
(source: `docs/tsn5g-ue.sudoers`) grants `amrc` NOPASSWD on this unit's
`systemctl` verbs plus `ip`, `tc`, `iptables`, `qmicli`, `ptp4l` and friends,
and `amrc` is in group `sudo`. Nothing at the OS level is in your way.

So the fix is not to obtain `sudo`. It is to **stop putting the word `sudo` in
the command**:

- **`systemctl` never needed it.** It asks polkit, where `manage-units` and
  `reload-daemon` default to `auth_admin_keep` — a password prompt via an
  authentication agent. A non-interactive shell has no agent, so the D-Bus call
  hangs ~25 s and reports `Method call timed out`. That is a *missing-agent*
  error wearing a permission error's clothes, and it is why earlier sessions saw
  `daemon-reload` "sometimes" succeed: a desktop agent on the seat0 session
  occasionally fielded the prompt. `docs/tsn5g-ue.polkit.rules`, installed to
  `/etc/polkit-1/rules.d/10-tsn5g-ue.rules`, answers polkit directly for this
  project's units. **Plain `systemctl restart tsn5g-ue` then works from your own
  shell, immediately.** If it hangs instead, the rule is not installed — the
  file header carries the one-line install, which the operator must run.
- Use `python3` + `http.client`, never `curl`, to talk to the API.
- **For privileged *inspection*, use `GET /api/debug/snapshot`.** The daemon is
  root and already reads what your shell cannot: `routing.live.mangle_output`,
  `nat_postrouting`, `ip_rule` and `tables` are the `iptables -S` and `ip rule`
  output you would otherwise need sudo for, plus `bearer`, `bus`, `interfaces`,
  `commands` (the shell log with exit codes and output) and `log`. Reach for it
  before concluding something is unreachable.
- `journalctl -u tsn5g-ue` works unprivileged — this user is in group `adm`.
- Mutating `ip`/`tc`/`iptables` from your shell is still blocked, and that is
  correct: the daemon owns them and you reach them through the API. Read-only
  forms (`ip -d link show`, `tc qdisc show`) work unprivileged already.
- Editing `/etc/systemd/system/tsn5g-ue.service` remains an operator step,
  blocked by the sandbox rather than by privilege. It is rare.

**The daemon runs as root**, so anything it does through the API — bringing the
bearer up, building interfaces, applying `tc` — works fine. It is only your own
shell that is unprivileged, and now only in the ways listed above.

---

## 1. Where things are

| Path | What |
|---|---|
| `/home/amrc/camera_application/tsn5g-ue-app` | the console, a git repo |
| `/home/amrc/camera_application/vxlan` | DS-TT / NW-TT `.deb`s and READMEs |
| `/home/amrc/camera_application/tsn-docs` | the six design documents, HTML + PDF |
| `/home/amrc/camera_application/U5G` | `pathStream1` / `pathView2` camera apps |
| `/home/amrc/camera_application/iperf_logs` | iperf history, `iperf5g.sh` format |
| `/etc/systemd/system/tsn5g-ue.service` | the unit (matches `systemd/tsn5g-ue.di1200.service`) |
| `docs/tsn5g-ue.sudoers` | source of `/etc/sudoers.d/tsn5g-ue` — the OS-level grant |
| `docs/tsn5g-ue.polkit.rules` | source of `/etc/polkit-1/rules.d/10-tsn5g-ue.rules` — why plain `systemctl` works |
| `config/tsn5g-ue.di1200.yaml` | the **live** config. `tsn5g-ue.example.yaml` is the shipped template |

UI at `http://10.5.4.111:8080/`. Service is `tsn5g-ue`.

---

## 2. The rig

**DI-1200** (`amrc-DI-1200`), Ubuntu 24.04, kernel 6.8, x86_64.

- **Modem** Quectel RM520N-GL, **USB** (`2c7c:0801`) — not PCIe/MHI.
  QMI `/dev/cdc-wdm0`, AT on `/dev/ttyUSB*`.
  **The AT port number moves between boots** (seen at ttyUSB2 and ttyUSB3 the
  same day). Never pin `modem.device`.
- **ModemManager is masked.** Stopping is not enough — D-Bus restarts it.
- **NICs** `enp3s0` management `10.5.4.111/21` (default route via `10.5.0.2`),
  `enp4s0` camera `169.254.1.1/16`, `enp7s0` switch `192.168.1.20/24`.
  Six NICs report hardware timestamping; `wwan0` does not.
- **Bearer** `wwan0`, raw-IP, **MTU 1400**, APN `usrptsn`, PLMN `00102`, n78.
  **The UE address changes on every data call** — seen `.3 .6 .7 .12` in nine
  days. Anything that pins it will break.
- **Core** `10.45.0.1`. **Camera** FLIR Blackfly S at `169.254.143.18`.
  **TSN switch** FS TSN3220 at `192.168.1.1`, MAC `64:9d:99:52:66:56`.

### Hardware facts that constrain the design

```
wwan0            1 TX queue   ethtool -L → "Operation not supported"
vxlan*, br*      1 TX queue
enp3s0/4s0/7s0   4 TX queues
```

`taprio` needs one non-overlapping queue range per traffic class, so **a gate
schedule cannot be expressed on `wwan0`**. That is why the bridge puts the gate
on a veth created with `numtxqueues 8`.

---

## 3. Hard rules — do not break these

- **`nr5g_disable_mode` must be `0`.** On this firmware 1 and 2 prevent SA
  camping, and 1 makes band-mask writes fail *silently*. The API refuses
  anything else.
- **`AT+QPRTPARA=3` is never automated** — it wipes NV to factory defaults.
  On the console deny-list.
- **Never `iptables -F`.** Delete recorded rules individually. Shared machine.
- **`MASQUERADE`, never `SNAT --to-source`** — the UE address changes.
- Default route via the modem needs `api.allow_default_via_modem: true` *and*
  an explicit confirm.
- Commits end with the AMRC trailer and `Claude-Session:` line.

---

## 4. What exists

All seven planned phases plus the TSN bridge. 12,023 lines of Python across 69
files, 6,521 of JS across 34, 15 views, **98 routes, 31 job kinds**.

Architecture: stdlib `http.server` (no aiohttp — everything blocks anyway),
EventBus + SSE with a permanent polling fallback, JobManager with lanes
(`modem bearer perf switch net`) that **rejects when busy rather than queueing**,
SQLite history, `ModemBus` as the single owner of the AT port with priorities,
native ES modules with **no bundler and no npm**.

### The new package: `tsn5g_ue/tsnbridge/`

Deliberately separate from `transport/`. That one builds the overlay the console
always built; this is the path where the UE classifies, gates and tags itself so
no switch is needed. Both coexist. **`transport/` was not touched.**

```
profiles.py   gate schedules + switch-mask → traffic-class conversion
netdev.py     ip/tc wrappers, idempotent, none swallowing errors
gate.py       taprio apply/clear/status
mark.py       classification, removed by exact match, never a flush
datapath.py   veth → vlan → vxlan → modem
manager.py    facade; every status call re-reads the kernel
```

API `/api/bridge{,/profiles,/build,/teardown,/gate,/rules}`, jobs
`bridge.build` / `bridge.teardown`, UI at **Advanced → TSN Bridge**.

Verified live: veth with **8 TX queues**, MTU **1346**, `tb-ctrltv` showing
`vlan protocol 802.1Q id 60` riding the VXLAN device, `taprio` in the kernel
with `clockid TAI base-time 101600000000000` and gatemasks
`0x2/150µs 0x0/30µs 0x3/820µs`.

### Tooling

| Script | Does |
|---|---|
| `scripts/lint-js.sh` | syntax, import resolution, house rules. **Zero exemptions** |
| `scripts/check-endpoints.py` | every path in `core/api.js` against a live box |
| `scripts/ui-check.py` | drives real Firefox over Marionette. **96 checks** |
| `scripts/package.sh` | → `dist/tsn5g-ue-<ver>.tar.gz`, touches only `dist/` |
| `scripts/install.sh` | one command; waits for `/api/health` before claiming success |

`ui-check.py` also renders the design docs to PDF via Marionette
`WebDriver:Print` — see `scratchpad/topdf.py` pattern. No PDF tools are installed.

---

## 5. Findings — things that were wrong and are now right

The recurring fault was **code asserting what it had not measured**. If you find
more, that is the shape to look for.

**Closed:** all 12 original bugs plus B23.

Later rounds found:

- Cell-lock form hard-coded to this rig (`624000/78/PCI 1`); band mask fell back
  to literal `"78"` in two places.
- `/api/modem` served `registered: false` / `sim_ready: false` / `ipv4: null`
  against a UE camped and carrying traffic — those flags were only written by
  `check()`, which nothing calls on a timer. Now derived from live evidence,
  with `null` meaning unmeasured rather than "no".
- Forbidden-PLMN list reported "None" when the read had **failed**
  (`AT+QFPLMNCFG="get"` errors on this firmware).
- **`RuntimeDirectory` had no `RuntimeDirectoryPreserve`**, so systemd deleted
  `/run/tsn5g-ue` on every stop and took the bearer's PDH/CID with it. This
  silently undid the B2 fix on every restart. Units now set it; **the installed
  unit needs `daemon-reload` to pick it up** (done once, verify it persists).
- iperf client address was hard-bound to the bearer, so a wired target hung for
  30 s. Now a **Client** field plus a preflight that compares the bind address's
  owning interface against the egress device — `ip route get X from Y` alone is
  not enough, it answers happily for a pairing that cannot work.
- Background traffic **started but could not be stopped**: iperf3 block-buffers
  into a pipe (~11 min to flush 4 KB at `-i 10`), so the cancel flag was never
  seen. Fixed with `select()` + `--forceflush -i 2`.
- Connection stepper: job emits `succeeded/running/failed`, CSS styled
  `.done/.active/.err` — **the names never matched**, so no step could colour and
  a failure looked identical to pending.
- Static IP did nothing and said it worked — `nmcli con mod <iface>` takes a
  *connection* name. Now resolved by device, profile created if absent, verified
  by re-reading.
- iperf failure diagnosis contradicted itself: logged "server is busy" then
  appended "the far side is likely down". **Fixed but uncommitted.**

### Measured on the rig

- iperf3 TCP up **147.5–148.1 Mbit/s**, 0 retries (historical was 88–133)
- Wired path to `10.5.1.19`: **938.98 Mbit/s**
- Link to core **21.5–26.8 ms**
- **Camera JPEG frame: 24,167 bytes mean** over 160,172 samples in
  `pathstream.log`, from a 1,166,400-byte raw frame — **48:1**. At 10 fps that is
  **1.93 Mbit/s per camera**, not the 300–500 KB/frame the old plan assumed.
  Two compressed cameras use ~2% of the uplink, so **nothing congests without a
  flood**.

---

## 6. Research context

The user is **Abdul Wahab Qurashi**, second author on *"End-to-End Time-Sensitive
Networking over 5G Using VXLAN for Priority-Aware Industrial Traffic"*. Findings
from that paper that constrain everything:

- **Uplink QoS-flow binding fails on the RM520N** — its SDAP will not bind
  uplink packets to non-default flows, so all uplink uses QFI 1 regardless of
  DSCP. Downlink works, two-level only.
- **Priority preservation comes from the marking chain, not the 5G QoS regime.**
  The 5G segment behaves as a Layer-3-transparent tunnel for priority.
- Their testbed **bridges raw GigE Vision**; the video server decodes with the
  camera SDK. The edge-compression design is a departure from that.
- Qbv affects **loss, not latency** — median OWD ~11 ms is radio-bound; P99
  45–107 ms with no monotonic cycle dependence. Gating cut CONTROL loss 10.4% → 3%.
- Their gNB was a CloudRAN Polaris 10, **not** srsRAN.

### The current plan

Three cameras, two UEs (two on UE1, one on UE2), **no TSN switch hardware**.
`taprio` arbitrates *inside* UE1; 5QI arbitrates *between* UEs. Compression by
`pathStream1` on the UE, congestion from a background flood, session-AMBR as the
bandwidth lever.

Full architecture with diagrams:
`tsn-docs/06-ue-as-tsn-bridge.html` (or the artifact at
`https://claude.ai/code/artifact/34258321-3ed5-49be-ab59-d34869d718a8`).

### srsRAN, researched not tested

Has `time_qos` policy alongside `time_rr`; `sched_expert_cfg` exposes
`qos_weight_function` (`gbr_prioritized`/`multivariate`), `prio_enabled`,
`pdb_enabled`, `gbr_enabled`; `configs/qos.yml` covers 18 5QIs including 82–85.
**Undocumented:** whether it separates *two UEs*, and whether QoS weighting
reaches *uplink* grants. Both are stop conditions — test before building UE 2.

---

## 7. State right now

- Service **active**, bearer up `10.45.0.12`. **The handle changes on every
  restart** — the daemon re-dials rather than adopting the preserved one
  (seen `3800377824` -> `3799127376`, cid 21 -> 22, same IP).
  `RuntimeDirectoryPreserve` still earns its place: it keeps the old handle
  alive long enough to tear the call down cleanly instead of orphaning it.
  Read the live value from `/api/debug/snapshot`, never from a past note.
- Radio healthy: **RSRP −95, SINR 21**, NR5G-SA, cell `00066C000`.
- **The 5G data path recovered on 22 Sep** after nine days dead. It is working.
- TSN bridge **built**: `tb-ctrl*` and `tb-video*` exist, `ctrl` gated with
  `urllc-5qi82`, one CLASSIFY rule on udp/50451. Tear down via
  `POST /api/bridge/teardown {}` if you want a clean box.
- `ui-check` **95/96** before the nav fix; that fix is uncommitted.

### Uncommitted, both verified

- `scripts/ui-check.py` — nav check now asserts containment, not an exact list
  (adding the bridge view broke it).
- `tsn5g_ue/perf/iperf.py` — failure diagnosis reads the real error.

**Needs a restart to load the iperf fix.**

### Blocked, not ours

- **Core's iperf3 server is busy** — `the server is busy running a test`,
  confirmed directly. Serves one at a time. 5G throughput unmeasurable until it
  frees or a second server runs on another port.
- **TSN switch has no management service.** ARP resolves, but SSH/telnet/HTTP/
  HTTPS all closed. Needs console access to enable SSH.
- **Camera routing half-applied:** `ip rule` and mangle marks exist but table 5
  is empty, so marked traffic falls through to ethernet. The Routing view flags
  it; applying a profile fixes it but changes live forwarding.

### Not built

- PTP (plan phase 5) — GPS grandmaster, wired sideband, `ptp4l` per UE.
- UE 2 and camera C.
- Bearer-token auth (`api.token`), `/api/apps` seam, kiosk density pass.
- Console surfaces for PTP status and named camera streams (classification
  currently takes a raw port number).

---

## 8. How to check it still works

```bash
systemctl is-active tsn5g-ue
./scripts/lint-js.sh                 # expect: OK: 34 files clean
python3 scripts/check-endpoints.py   # expect: 98 routes, all resolving
timeout 800 python3 scripts/ui-check.py   # expect 96/96 once the nav fix lands
```

```python
# the API, without curl
import http.client, json
c = http.client.HTTPConnection('127.0.0.1', 8080, timeout=30)
c.request('GET', '/api/bridge'); print(json.loads(c.getresponse().read()))
```

Worth knowing: `/api/health` reports `healthy: true` from component checks only —
it does **not** test data-plane reachability, so it stayed green through nine
days of a dead core. Do not trust it as an end-to-end signal.

---

## 9. Working style that paid off here

- **Verify, do not assert.** Nearly every bug found was code reporting success
  it had not checked. Read the kernel back.
- **Say what is blocked before building around it.** The `taprio`/single-queue
  constraint was worth finding early; so was the SDAP limitation.
- **Correct yourself plainly.** Several conclusions in this session were wrong
  and revised — the hairpin argument, the "Qbv is blocked" verdict, the marking
  placement for the compressed path. The user pushed back each time and was
  right each time.
- Commit messages carry the *why*, especially for anything non-obvious.
