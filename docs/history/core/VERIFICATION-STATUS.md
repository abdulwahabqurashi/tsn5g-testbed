# Verification status — what is proven, what was tested, what is not

**As of 2026-09-29 09:15 UTC.** Core/RAN side, `amrctsnserver`.
Companion to `CORE-RAN-CHANGES.md` (what was changed) and
`review/TSN-REVIEW-RESULTS.md` (the full checklist audit).

---

## 0. Headline

**The control plane is fully verified. The user plane is not.**

Every signalling step — subscriber → PCC → NGAP → F1AP → DU → MAC LC config → RRC →
UE — has been observed carrying the right values on a live session. What has **not**
been reproduced since the reconfiguration is *traffic actually landing on the GBR
QoS flow*.

**The F3 run of 2026-09-28 14:21–14:24 did not test the modem's LCP.** All test
traffic went onto a single logical channel, so there was nothing for logical channel
prioritisation to arbitrate. The run is void for its stated purpose — not a negative
result, a null one.

**The modem's LCP therefore remains `UNTESTED`.** Three runs have now been attempted;
none is known to have presented two simultaneously-backlogged logical channels to the
modem.

---

## 1. WORKING — verified, with the test that proved it

Each row states the claim, the evidence, and *when* it was observed. "Live" means on
the session established 2026-09-28 12:57:21, after all reconfiguration.

### 1.1 Radio and transport

| # | Claim | Evidence | When |
|---|---|---|---|
| W1 | X410 opens and the cell broadcasts | `Cell pci=1, bw=100 MHz, 1T1R, dl_arfcn=626666 (n78), dl_freq=3399.99 MHz, dl_ssb_arfcn=624000` | live |
| W2 | N2/NGAP established | `N2: Connection to AMF on 127.0.0.5:38412 completed`; SCTP `ESTAB` | live |
| W3 | Core healthy | 12 NFs up; NRF `127.0.0.10:7777`; `PFCP associated` | live |
| W4 | UE registers and gets a bearer | `[imsi-001020000000001] Registration complete`; `IPv4[10.45.0.12]`; ping 2/2 ~14–31 ms | live |
| W5 | Radio is stable under debug logging and test load | **`RF: late` 0 and `RF: overflow` 0 across the entire 19-hour log**, including the 14:21–14:24 test window | live |

**W5 is a substantive finding, not housekeeping.** `mac_level: debug` was feared to
reproduce the 2026-09-23 storm (~1665 `RF: late`/min). It produced **zero** over 19
hours including under load. That storm is now attributable to **1 Hz metrics
logging**, which remains disabled — not to MAC/SCHED debug logging. `underflow` ran
274 in the test window, consistent with the normal loaded band.

### 1.2 QoS control plane — the full signalling chain

This is the part that is genuinely, end-to-end proven.

| # | Hop | Evidence | When |
|---|---|---|---|
| W6 | Subscriber → PCC rule installed | Mongo `pcc_rule[0]`: 5QI 4, GBR 25/25, MBR 40/40, flows TCP+UDP port 5202 | live |
| W7 | PCC → NGAP → **DU** carries GBR | `guaranteedFlowBitRateUplink": 25000000`, `maxFlowBitRateUplink": 40000000` | live |
| W8 | Second QoS flow created | `qoSFlowIdentifier` 1 **and** 2 present; `fiveQI` 7 and 4 | live |
| W9 | Second DRB created | `[CU-UP] ue=0: Modified DRB2. psi=1 f1u_teid=0x000002`; `"defaultDRB": false` | live |
| W10 | **Differentiated MAC LC config reaches the UE** | DRB 1: priority 5, `kBps8`, LCG 2 · DRB 2: priority **4**, `kBps4096`, LCG **1** | live |
| W11 | Both bearers on the same RLC mode | both DRBs decode `um-Bi-Directional` in RRC | live |
| W12 | PBR tracks GBR correctly | GBR 40 M → `kBps8192` (24 Sep); GBR 25 M → `kBps4096` (live). Matches `get_pbr_ceil(gbr_ul)` | both |

**W10 and W12 together are the strongest result of this work.** The network signals a
**512×** prioritised-bit-rate difference, a better logical channel priority, and a
separate logical channel group. W12 shows this is a live computed value that tracks a
configuration change, not a static artefact.

### 1.3 The srsRAN GBR bug — found, fixed, verified, committed

| # | Claim | Evidence |
|---|---|---|
| W13 | NGAP Modify path dropped GBR (Setup path did not) | `ngap_asn1_helpers.h`; DU fell through to `make_non_gbr_drb_mac_lc_config()` → every DRB `pbr = 8 kBps` |
| W14 | Patch works | post-patch DU receives `guaranteedFlowBitRateUplink`, and W10's differentiated config appears |
| W15 | Patch is durable | commit `078c938` on branch `tsn/ngap-modify-gbr-fix` |

### 1.4 Instrumentation

| # | Claim | Evidence |
|---|---|---|
| W16 | Per-LCG BSR capture works | `Long BSR` ×502 with populated arrays, e.g. `report={2: 700000}` |
| W17 | The flood **does** backlog the modem's MAC | peak reported backlog **700,000 bytes** on LCG 2 |

**W17 answers the methodological worry directly.** The concern was that host-side
backpressure would prevent a backlog ever reaching the modem. It did not — the modem
held and reported a 700 KB backlog. **The F3 flood methodology is sound.** The run
failed for an unrelated reason (§3).

---

## 2. TESTED — what was actually run, and what each showed

| Run | Date | What it showed | Status |
|---|---|---|---|
| Saturation A | 24 Sep | 1,335,446 vs 1,335,402 packets, loss 11.75% / 12.74% | **Void for LCP.** Confounded by AM/UM mismatch; and equal *delivery* from unequal *offer* is the signature of a shared drain under backpressure, not fair queueing |
| QFI binding | 24 Sep | QFI 1: 69,404 pkts · QFI 2: 69,791 pkts, zero cross-contamination | **Valid.** Proves uplink *can* bind to a non-default QoS flow — see §2.1 |
| F3 run 1 | 28 Sep 14:21–14:24 | All backlog on LCG 2; LCG 1 never occupied | **Void.** Did not test LCP — see §3 |

### 2.1 The one test that confirmed user-plane mapping — and its caveat

The **only** direct evidence that traffic reaches QFI 2 is the 2026-09-24 N3 capture:
69,791 uplink packets on QFI 2 against 69,404 on QFI 1, zero cross-contamination.

**That was before the reconfiguration** (GBR was 40 Mbit/s, 5QI 4 was on RLC AM) and
it has **not been reproduced since**. Critically, `ul-5202.log` shows how that run was
driven:

```
Connecting to host 10.45.0.12, port 5202
Reverse mode, remote host 10.45.0.12 is sending
[  5] local 10.45.0.1 port 46313 connected to 10.45.0.12 port 5202
```

**Reverse mode** — an iperf3 *server on the UE* at port 5202, with the core pulling.
That makes the UE's uplink **source** port 5202. This matters (§3.2).

---

## 3. NOT WORKING — the F3 run did not test what it was meant to

### 3.1 The evidence

Every non-empty BSR report in the entire 19-hour log, without exception:

```
report={2: 700000}   ×13,212
report={2: 77284}    ×3,093
report={2: 55474}    ×2,537
report={2: 107669}   ×1,795
...
report={0,0,0,0,0,0,0,0}  ×67,368   (idle)
```

**Index 2 only. LCG 1 never once reported a backlog.**

Mapped against the signalled config (W10):

| LCG | Bearer | 5QI | Backlog observed |
|---|---|---|---|
| **2** | DRB 1 | 7 (non-GBR, default) | up to **700 KB**, sustained |
| **1** | DRB 2 | 4 (GBR 25 Mbit/s) | **none, ever** |

Corroborated independently: `lcid=5` (DRB 2) has only 921 lines across 19 hours —
signalling-level, not data. And the recoverable part of the N3 capture shows **only
QFI 1**, no QFI 2.

### 3.2 What this means, and the leading hypothesis

Both the protected stream and the flood landed on the **default bearer**. With both
streams on one logical channel, LCP had nothing to arbitrate — the split it produced
is a property of a single queue, not of prioritisation. **This is the same class of
error as the documented 24 Sep trap** (`UE-UPLINK-QOS.md` §5.2), where a filter
mismatch put both streams on the default flow and produced an even split that looked
exactly like a scheduler that does not differentiate.

**Leading hypothesis — direction of the iperf3 session.** The PCC filter is
`permit out ... to assigned 5202`. Open5GS derives the uplink filter by swapping
source and destination, so **uplink matches only when the UE's SOURCE port is 5202**.
That happens when an iperf3 **server runs on the UE** at 5202 and the core pulls with
`-R` — exactly the reverse-mode setup of the 24 Sep run that *did* work. If this run
instead had the UE as an iperf3 **client** (`iperf3 -c <core> -p 5202`), the UE's
source port is ephemeral and the filter never matches, so everything falls to the
default flow.

Stated as a hypothesis because the UE-side command is not recorded on this host and I
have no shell access to the DI-1200. It is consistent with all four observations
(no QFI 2 on N3, no LCG 1 backlog, trivial `lcid=5`, working 24 Sep reverse-mode run).

### 3.3 Instrumentation failure — my error

The N3 capture is **corrupt beyond 14:02:30**:

```
tcpdump: pcap_loop: invalid packet capture length 1745356544, bigger than snaplen of 160
```

200 MB on disk, 653 packets recoverable. The `-B 65536` (64 MB) buffer I specified was
never flushed cleanly on termination. My command was wrong: it needed `-C`/`-W`
rotation or a clean `SIGINT` shutdown path. **The N3 capture did not cover the test
window**, so the QFI split had to be inferred from BSR data instead. Next run must use
rotation and the capture must be verified readable *before* the run is trusted.

---

## 4. NOT TESTED — honest list

| # | Item | Why it is untested |
|---|---|---|
| U1 | **Modem LCP (the whole question)** | No run has presented two simultaneously-backlogged logical channels. Three attempts, none valid |
| U2 | **User-plane mapping post-reconfiguration** | QFI 2 binding proven only on 24 Sep, pre-change. Not reproduced with GBR 25 / RLC UM |
| U3 | Whether the GBR flow receives its GBR | Needs U2 first. It has never carried load |
| U4 | Loaded uplink ceiling for the current config | Not measured this run; historical figures (~123 idle, ~50 loaded) remain unreconciled |
| U5 | `wwan0` qdisc during the 24 Sep run (A1) | UE-side. Reported as `pfifo`, but the inference drawn from it was withdrawn |
| U6 | Offered vs delivered for the 24 Sep run (A4) | Raw run output not on this host; packet size and duration unrecorded |
| U7 | Sections D1–D6 (UE host) | No shell access to DI-1200 |
| U8 | Sections E1–E7 (TSN switches, Qbv, PTP) | No switch address or credentials |
| U9 | Section G (paper consistency) | No `.tex` anywhere under `/home/tsn_server` |
| U10 | Whether switches are phase-aligned to gNB frame timing | UPF logs `phc2sys not detected`; NW-TT timestamps off an unsynchronised clock |
| U11 | `RF: late` under load *without* debug logging | Baseline is idle-only; debug-on-under-load is now known good (W5), the inverse is not measured |

**On U1 — the correct statement.** The modem's LCP is not "suspect" and not
"cleared". It is **untested**. No measurement to date is known to have put a backlog
on more than one of its logical channels. Any Quectel bug report remains
unsupportable.

---

## 5. What run 2 needs

1. **Verify the mapping before trusting the run.** Start traffic, confirm QFI 2 is
   carrying it on N3 *and* that LCG 1 shows a backlog in the BSRs — then start the
   measurement. This is a pre-flight gate, not a post-hoc check.
2. **Match the 24 Sep topology**: iperf3 server on the UE at 5202, core pulls with
   `-R`, so the UE's uplink source port is 5202. Or change the PCC filter to match
   whatever the UE actually sends.
3. **Fix the capture**: add rotation (`-C 100 -W 20`), drop `-B` to something modest,
   and confirm the file reads back cleanly before relying on it.
4. **Success criterion for validity** (independent of the result): BSRs must show
   **both LCG 1 and LCG 2 non-empty simultaneously**. Without that, the run is void
   again whatever the throughput split says.

---

## 6. Housekeeping — needs attention now

| Item | State | Risk |
|---|---|---|
| `gnb.log` | **2.6 GB** on disk | Grew unbounded overnight under `mac_level: debug` |
| `tsn-health.timer` | **still stopped** since 28 Sep 14:00 | No watchdog cover for ~19 h; nothing would have caught a wedge |
| Disk | 73 GB free | Not yet critical |
| `mac_level: debug` | still active | Intended for a bounded run, has been on ~20 h |
| N3 capture | `review/n3-f3.pcap`, 200 MB, corrupt | Occupies space, unusable past 14:02:30 |

Restarting the watchdog also restores the gNB-restart auto-repair path, which has been
absent throughout. `gnb.log` is truncated at each gNB start, so preserve anything
wanted from the test windows (14:02–14:04, 14:21–14:24) before any restart.
