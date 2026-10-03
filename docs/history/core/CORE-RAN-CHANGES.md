# Core / RAN changes — 2026-09-28

**Companion to `UE-UPLINK-QOS.md`** (which covers the DI-1200 side). This file is
the core and RAN half: what was changed on `amrctsnserver`, why, how it was
verified, and what the UE side needs to know.

Driven by `TSN-REVIEW-CHECKLIST.md`. Full audit with per-item evidence is in
`review/TSN-REVIEW-RESULTS.md`; this is the short version.

Scope: **core and RAN only.** Nothing on the DI-1200 was touched — no shell access
from this host. Sections D (UE host), E (TSN switches) and G (paper) were not
attempted.

---

## 1. What changed — four items

### 1.1 PCC GBR resized down (review item B1)

**Where:** MongoDB `open5gs.subscribers`, `imsi 001020000000001`, `pcc_rule[0]`.

| | before | after |
|---|---|---|
| GBR UL / DL | 40 / 40 Mbit/s | **25 / 25** |
| MBR UL / DL | 80 / 80 Mbit/s | **40 / 40** |

**Why.** 40 Mbit/s GBR was 80% of the measured ~50 Mbit/s *loaded* uplink ceiling,
and 80% of the session's own 50 Mbit/s UL AMBR. A GBR the link cannot honour under
load makes "did the GBR flow receive its GBR" unanswerable by construction. Sized
per checklist F1 item 2 (GBR ≈ 1.25× stream rate, MBR ≈ 2×) against F3's suggested
20 Mbit/s test stream.

**5QI unchanged at 4.** Flow filters unchanged (TCP *and* UDP to port 5202).

**Backup:** `review/subscriber-001020000000001.bak-20260928-pre-gbr-resize.json`

**Verified reaching the DU**, not just the database:
```
guaranteedFlowBitRateUplink":   25000000     (was 40000000)
maxFlowBitRateUplink":          40000000     (was 80000000)
```

> **This takes effect only at PDU session establishment.** `--wds-stop-network`
> does not rebuild the session. Confirm via the SMF ledger `Removed → 0` then
> `Added → 1`, never by pinging the UE.

### 1.2 RLC mode confounder removed (review item C2)

**Where:** `gnb_x410.yaml`, the `5QI 4` entry in the `qos:` block.

```
before:  rlc.mode: am        (with the full am: sub-block)
after:   rlc.mode: um-bidir  (mirrors the 5QI 7 block key-for-key)
```

**Why.** The GBR-vs-non-GBR uplink comparison ran 5QI 4 on AM against 5QI 7 on UM,
so every result to date — including the 1,335,446 / 1,335,402 saturation run —
varied retransmission behaviour *and* logical-channel priority at the same time.
Two variables, one measurement. F1 item 1 requires both test bearers on the same
mode; UM is the one 5QI 7 already used.

Resulting table: **5QI 9 → `am`, 5QI 7 → `um-bidir`, 5QI 4 → `um-bidir`.**

**Verified on the wire**, not just in config — both DRBs decode as
`um-Bi-Directional` in the RRC. (The `am` entries elsewhere in the RRC are SRBs,
which are always AM.)

> **Accepted cost.** 5QI 4's 3GPP target is PER 1e-6, which requires ARQ. Under UM
> there is none, so the profile no longer meets its own error target. **5QI 4 is now
> a TEST profile, not a production one.**

**Backup:** `gnb_x410.yaml.bak-prefix-c2c5-20260928-124718`

### 1.3 Per-LCG BSR capture enabled (review item C5)

**Where:** `gnb_x410.yaml`, `log:` block. Added `mac_level: debug`.

**Why, and why this specific key** — this took real digging and is worth recording:

- Per-LCG BSRs come from the **scheduler** event logger, which emits the report only
  when `mode == debug` (`scheduler_event_logger.cpp:188`).
- There is **no `sched_level` key** in this build (`4bf1543`). The only logger keys
  are `mac / rlc / f1ap / f1u / gtpu / du_level`.
- `du_high_logger_registrator.h:38` sets the `MAC` **and** `SCHED` channels together
  from `mac_level`.

So `mac_level: debug` is the only lever that exists. There is no cheaper one.

Without it, F3 cannot distinguish its two key outcomes — "modem ignores LC priority"
(its LCG backlogged in the BSRs) from "loss is upstream of the MAC" (its LCG mostly
empty).

**Verified live:**
```
- BSR: ue=0 rnti=0x4601 type="Short BSR" report={0, 0, 0, 0, 0, 0, 0, 0} pending_bytes=0
Long BSR   3
Short BSR  148
```
The 8-element array is the per-LCG report. Long BSRs *are* being emitted, so the
fully-populated array will be available under load. Zeros because the link is idle.

> **Cost: `gnb.log` grows at ~86 MB/h with a UE attached.** The watchdog's
> `GNB_LOG_MAX_MB` is 512, so ~6 h before it trips, and srsRAN truncates the file at
> every gNB start. Keep F3 bounded and copy `gnb.log` aside immediately after.
> **REVERT this to `warning` (delete the line) once F3 is done.**

### 1.4 srsRAN GBR patch committed (review item P1)

The 10-line fix that makes this whole experiment possible was an **uncommitted
working-tree change**. Any `git checkout` / `stash` / `clean` would have reverted it
silently — no error, the DU just falls back to `make_non_gbr_drb_mac_lc_config()`
and every bearer returns to `pbr = 8 kBps`.

```
repo    ~/srsRAN_Project
branch  tsn/ngap-modify-gbr-fix      (off main; main untouched at 4bf1543)
commit  078c938                      1 file changed, 10 insertions(+)
file    lib/ngap/ngap_asn1_helpers.h
```

**Not pushed** — `origin` is the upstream `srsran/srsRAN_Project`, not an AMRC
remote. The commit message is written to stand as an upstream contribution if that
is ever wanted; the bug affects anyone using PCC rules to add GBR flows with srsRAN,
independent of modem.

Git identity was unset repo-wide and globally; set **repo-locally** to
`a.w.qurashi <a.w.qurashi@sheffield.ac.uk>`.

---

## 2. Verified live state

Captured 2026-09-28 13:00 UTC. gNB restarted 12:54:46, PDU session established
12:57:21 — i.e. after both the restart and the Mongo change, so this session carries
the new QoS.

| Layer | State |
|---|---|
| Core | 12 NFs up; NRF `127.0.0.10:7777`; PFCP associated |
| N2 | NGAP `ESTAB` to AMF `127.0.0.5:38412` |
| Cell | n78, 100 MHz, `dl_arfcn 626666`, PCI 1, `CellID 0x66c000`, TAC 1, PLMN 00102 |
| UE | `imsi-001020000000001`, DNN `usrptsn`, **10.45.0.12**, ping 2/2 ~14 ms |
| QoS flows | QFI 1 (5QI 7) and QFI 2 (5QI 4) — both present, DRB2 `defaultDRB: false` |
| RF | `RF: late` **0**, `RF: overflow` **0**, underflow 69–73/min (normal idle band) |

### Logical-channel config now signalled to the UE

| Bearer | Priority | Prioritised bit rate | LCG | RLC (RRC) |
|---|---|---|---|---|
| DRB 1 (5QI 7, non-GBR) | 5 | `kBps8` | 2 | `um-Bi-Directional` |
| DRB 2 (5QI 4, GBR 25M) | **4** | **`kBps4096`** | **1** | `um-Bi-Directional` |

The PBR tracked the GBR change exactly as `get_pbr_ceil(gbr_ul)` predicts:
40 Mbit/s → `kBps8192` (24 Sep), 25 Mbit/s → `kBps4096` (now). Differentiation is
**512×**, down from 1024× — still far beyond anything an LCP implementation could
reasonably ignore.

### RF-late baseline (review item C6)

**Baseline: `RF: late` = 0/min steady state.** Measured over 27 min idle on the
pre-restart process: 88 events total, all in **two bursts of 44, each under 2 ms**
(cold start, and one unexplained 1.3 ms stall). Zero in every other minute.
`RF: overflow` 0 throughout.

> The right F3 test is **"does `late` become *continuous*"**, not "is the total
> non-zero". A burst is a transient; a rate is a problem.

---

## 3. Measurement trap — read this before trusting any RF number

**`journalctl` reports zero RF events on a healthy *and* a wedging radio alike.**

`gnb_x410.yaml` sets `log.filename: gnb.log`, so srsRAN routes its `[RF]`,
`[SCHED]`, `[MAC]` and `[FAPI]` channels **to that file**. Only the console banner
reaches stdout, which is what journald captures. Measured side by side over the same
window:

| source | RF: late | RF: overflow | underflow |
|---|---|---|---|
| `gnb.log` (authoritative) | **88** | 0 | **2072** |
| `journalctl -u srsran-gnb` | 0 | 0 | 0 |

**Always count from `gnb.log`.** I reported "zero RF late" from journalctl during
this session and had to retract it. Note srsRAN truncates `gnb.log` at every gNB
start, so the window is only ever "since the current process started".

---

## 4. What the UE side should know

1. **The GBR is now 25 Mbit/s, not 40.** Size the protected test stream to ~20
   Mbit/s so it sits below GBR, per F3.
2. **Both test bearers are on RLC UM now.** Any previous result that compared
   AM-vs-UM is not comparable with what comes next.
3. **The network signals strong differentiation** — priority 4 vs 5, `kBps4096` vs
   `kBps8`, separate LCGs. If the modem still splits ~50/50 under saturation, the
   network is not the reason.
4. **A2 and A3 are settled on the RAN side.** The UE genuinely received
   differentiated LC configs, and GBR genuinely reached the DU. Both re-verified on
   a live session today with primary evidence, not transcription.
5. **The modem's LCP is still `UNPROVEN`, not cleared and not guilty.** Until
   `wwan0`'s qdisc during the last run is established, a host-side round-robin
   equaliser (`fq_codel`) explains the 44-packet split just as completely as a modem
   that ignores LCP. **A bug report to Quectel is not supportable on current
   evidence.**

### Still needed from the UE side

| Item | What is needed |
|---|---|
| A1 | `tc qdisc` state on `wwan0` **at the time of the 1,335,446 / 1,335,402 run** — before/after is only `UNPROVEN` |
| A4 | The raw run output. `ul-5202.log` and `profile-runs/5QI7-UM.json` on this host are *different runs*; the 1.34M counts exist here only as a summary table |
| — | `LAST_RUN_TIME` and `UE_REPO` path |
| D1–D6 | qdisc persistence, classification rules, taprio gate config, rate limiter, modem firmware (`ATI` / `AT+QGMR`), session-rebuild tooling |

### Still needed from elsewhere

- **Section E (TSN switches):** `SWITCH_A`, `SWITCH_B` mgmt access and
  `SWITCH_PORT_RATE`. Nothing found on this host.
- **Section G (paper):** `PAPER_TEX_DIR`. No `.tex` anywhere under `/home/tsn_server`.

---

## 5. Must be reverted after F3

| What | Restore to | How |
|---|---|---|
| `mac_level: debug` | `warning` | delete the line in `gnb_x410.yaml` (unset inherits `all_level`) |
| 5QI 4 `rlc.mode: um-bidir` | `am` | only if 5QI 4 is wanted as a production profile again — full `am:` block is in `gnb_x410.yaml.bak-prefix-c2c5-20260928-124718` |

Both need a gNB restart, which drops every UE session.

---

## 6. Open items on the core/RAN side

**`[PHY] [E] The modulator is busy`** — fired three times on the pre-restart process
(12:23:08.349, 12:32:45.007, 12:33:53.007) against two `RF: late` bursts. Pairing is
tight for burst 1 (5 ms), loose for burst 2 (~1 s), and 12:32:45 has no matching
burst. A lead, not a cause. It logs at `[E]`, one level above `RF: late`'s `[W]`,
and the 12:32:45 event is followed by `[SCHED] Discarding error indication ...
results ... already been erased`. Not investigated.

**`build/` is untracked in `~/srsRAN_Project`.** The *source* is safe now (§1.4) but
the built gNB binary is not — `git clean -fdx` there would wipe it and force a full
rebuild. Adding `build/` to `.gitignore` would protect against the common
`git clean -fd`, though not `-x`. Left as the operator's call.

**Metrics `du_report_period: 1000` is disarmed, not removed.** `enable_log` and
`enable_json` are both `false`, so it is inert. Re-enabling metrics without also
raising the period reproduces the 2026-09-23 event that took `RF: late` from ~15/min
to ~1665/min. Note that was *metrics* logging, not `mac_level` — `mac_level: debug`
produced **zero** `RF: late` over six minutes with a UE attached.

**Open5GS has no systemd unit.** It does not survive a power cycle, while
`srsran-gnb.service` is enabled and crash-loops into a dead radio (10,984 restarts
during the 26–28 Sep outage). Bring-up order and recovery are unchanged and out of
scope here.
