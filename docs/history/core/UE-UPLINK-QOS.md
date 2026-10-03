# Uplink QoS on the UE Side — handover to the DI-1200

**As of 2026-09-24.** Written for whoever (or whatever) works on the UE.
Everything here was measured on the rig between 22 and 24 September 2026.
Core/RAN: `amrctsnserver`. UE: DI-1200 + Quectel RM520N-GL.

---

## TL;DR

The RM520N **maps** uplink packets onto separate QoS flows correctly. It does
**not prioritise** between them. The network signalled one bearer a 1024× larger
prioritised bit rate, a better logical channel priority and its own logical
channel group; under saturation the modem split uplink 1,335,446 vs 1,335,402
packets. It round-robins regardless.

Consequence: you can give uplink streams different *bearer behaviour* (RLC mode,
PDCP timers, separate counters) but you cannot make the modem *rank* them. All
contention arbitration must happen in the host kernel, upstream of `wwan0`.

---

## 1. Findings

### 1.1 Uplink DOES bind to non-default QoS flows — the design doc is wrong

The design document states:

> "the modem's SDAP will not bind uplink packets to non-default QoS flows. All
> uplink from a given UE arrives on that UE's default flow regardless of
> marking. Per-UE differentiation is available; per-flow-within-a-UE is not."

Measured on N3 (GTP-U, PDU Session Container extension header, QFI field), two
simultaneous uplink flows:

| QoS flow | Packet filter | Uplink packets |
|---|---|---|
| QFI 1 (default) | everything else | 69,404 |
| QFI 2 (PCC rule) | TCP/UDP port 5202 | 69,791 |

Zero cross-contamination. The modem read the QoS rule, matched the packet
filter, and bound those packets to the second flow.

**Why this was never seen before:** until 2026-09-24 only ONE QoS flow had ever
existed on this rig. The default QoS rule is
`OGS_PACKET_FILTER_MATCH_ALL`, bidirectional, `precedence 255` (lowest —
rules are evaluated in *increasing* order of precedence). So it is a catch-all
at the bottom of the list. Everything landing on it was correct behaviour, not
a modem failure. There was simply no other rule to match.

### 1.2 But the modem does NOT prioritise between flows

Decoded from the RRC `masterCellGroup` the gNB sent the UE:

| Bearer | LCID | LC priority | Prioritised bit rate | LCG |
|---|---|---|---|---|
| DRB 1 (5QI 7, non-GBR) | 4 | 5 | `kBps8` | 2 |
| DRB 2 (5QI 4, GBR 40 Mbit/s) | 5 | **4** | **`kBps8192`** | **1** |

`kBps8192` = 8192 kilobytes/s ≈ 65.5 Mbit/s, against 8 kBps. A **1024×**
difference, plus a better priority and a separate logical channel group.

Result under saturation (UDP, 160 Mbit/s offered, ~12% loss, so the scheduler
genuinely had to choose):

| Bearer | Received packets | Loss |
|---|---|---|
| DRB 1 (non-GBR) | 1,335,446 | 11.75% |
| DRB 2 (GBR) | 1,335,402 | 12.74% |

**44 packets apart in 1.34 million.** The modem's Logical Channel
Prioritisation ignores both the priority and the prioritised bit rate.

### 1.3 What this means

- **Can do:** different RLC modes per uplink stream (UM vs AM), different PDCP
  discard/reordering timers, separate per-bearer counters.
- **Cannot do:** make the modem favour one stream when uplink grants are scarce.

The design's conclusion (the gate must arbitrate in the UE kernel) is **right**,
but the stated reason is **wrong**. It is not that flows cannot be separated —
they can. It is that once separated, the modem will not rank them.

---

## 2. Evidence chain

Every hop was observed, not inferred. The conclusion points at the modem, so the
reasoning should be checkable.

| Hop | Observation method | Result |
|---|---|---|
| Subscriber DB → NGAP | PDU Session Modify transfer octets | `02625a00` = 40 Mbit/s GBR; `04c4b400` = 80 Mbit/s MBR |
| NGAP → CU-CP | srsRAN source | **BUG** — Modify path dropped GBR entirely |
| CU-CP → DU (F1AP) | F1AP trace, `f1ap_level: debug` | post-patch: `guaranteedFlowBitRateUplink: 40000000` |
| DU → MAC LC config | srsRAN source | `make_gbr_drb_mac_lc_config()`: priority 4, own LCG, PBR from `gbr_ul` |
| DU → UE (RRC) | decoded `masterCellGroup`, `cu_level: debug` | DRB 2: priority 4, `kBps8192`, LCG 1 |
| **UE LCP** | N3 GTP-U capture under load | **50/50 split** ← the failure |

### The srsRAN bug we found and fixed

`lib/ngap/ngap_asn1_helpers.h` — the NGAP **Setup** path converted
`gBR-QoSInformation` into the internal structures; the **Modify** path did not.
A PCC rule arrives as a Modify, so GBR reached the DU empty, and
`du_bearer_resource_manager.cpp:207` fell through to
`make_non_gbr_drb_mac_lc_config()` — which takes **no arguments** and gives
every non-GBR DRB `pbr = 8 kBps` and the same priority regardless of 5QI.

Patch = 10 lines mirroring the Setup path. Verified on the wire. **Worth
upstreaming** — it affects anyone using PCC rules with srsRAN, independent of
modem.

---

## 3. Three actions for the UE side

### 3.1 Establish firmware revision and raise with Quectel

LCP lives in modem MAC firmware. This is the only route to a real fix.

```
ATI           # model and revision
AT+QGMR       # full firmware revision string
AT+QCFG=?     # every vendor config knob exposed
```

Report the `AT+QGMR` string. Check for a newer RM520N release. If the behaviour
persists, this is the bug report:

> With two DRBs on one PDU session, the network signals DRB 1 with logical
> channel priority 5, prioritised bit rate 8 kBps, LCG 2; and DRB 2 with
> priority 4, prioritised bit rate 8192 kBps, LCG 1. Under uplink saturation
> (12% loss) the modem delivers 1,335,446 packets on DRB 1 and 1,335,402 on
> DRB 2 — an even split, with no effect from prioritised bit rate or priority.

### 3.2 Fix the qdisc on `wwan0` — now the highest-value item

Since the modem will not rank logical channels, ordering must be correct
*before* packets reach it. Whatever the host hands `wwan0` is what goes out.

This makes **Phase 0 task 0.2 the critical path**, not housekeeping:

- The gate orders packets over a 2 ms cycle.
- They then sit in ~4.5 s of `fq_codel` buffer — roughly nine thousand slots.
- `fq_codel` serves flows in round-robin, which **cancels** prioritisation
  rather than merely delaying it.

Two separate faults: the depth, and the round-robin. The code already has
`netdev.shallowfifo()` called at bridge build — find out why it is not taking
effect.

**Cruder variant that works today** and depends on nothing in the modem:
rate-limit the best-effort stream on the host so it cannot consume what the
protected stream needs.

### 3.3 Use the per-flow mapping for what it can do

Do not discard the QoS flow work. Within one UE you can now give uplink streams:

- **Different RLC modes** — UM for latency-sensitive video (no ARQ: a lost
  fragment is lost rather than retransmitted late); AM for control traffic.
- **Different PDCP discard and reordering timers**, per stream.
- **Separate per-bearer counters** — per-stream measurement at the radio layer,
  not only at the application.

---

## 4. Ruled out — do not spend time here

**DSCP will never influence radio scheduling.** Two independent reasons:

1. The DSCP the UE writes sits on the VXLAN outer header, inside the PDU session
   payload, wrapped again in GTP-U on N3. The gNB sees one opaque block. No
   configuration reaches it.
2. Open5GS cannot classify on DSCP at all. The flow-description parser handles
   `O_PROTO`, `O_IP_SRC(_MASK)`, `O_IP_DST(_MASK)`, `O_IP6_*`, `O_IP_SRCPORT`,
   `O_IP_DSTPORT` — and nothing else. There is no `O_DSCP` case.
   `tos_traffic_class` exists in the structs and 3GPP component type 112 is
   defined, but nothing populates them. A DSCP token is parsed by the bundled
   ipfw and then **silently discarded**.

Classify on the 5-tuple. The camera streams are already separated by UDP port
(50451/50452/50453), which the design's own packet diagram identifies as the
classification key.

**More QoS flows will not help.** The limit is not how many flows you can
create — it is that the modem will not rank the logical channels they map to.

**Two PDU sessions will not help either,** same reason. Useful for host-side
routing (separate `wwan` interfaces), not for arbitration.

**Nothing further on RAN or core will change it.** Every hop is verified, the
one real bug is patched, the network signals exactly what it should.

---

## 5. Operational notes

### 5.1 The session-rebuild trap — this cost two rounds

QoS config (subscriber 5QI, PCC rules) is read **only at PDU session
establishment**. And `ue_qmi_up.sh down` does **not** tear the session down — it
calls `--wds-stop-network`, which stops the host-side data call while the modem
keeps its PDN context. `up` then resumes the same session. The UE pings
perfectly the whole time while carrying the previous configuration.

Genuine rebuild needs full deregistration:

```bash
sudo ./ue_qmi_up.sh down
sudo sh -c 'stty -F /dev/ttyUSB2 115200 raw -echo; printf "AT+CFUN=0\r" > /dev/ttyUSB2'
sleep 5
sudo sh -c 'stty -F /dev/ttyUSB2 115200 raw -echo; printf "AT+CFUN=1\r" > /dev/ttyUSB2'
sleep 15
sudo ./ue_qmi_up.sh up
```

Adjust the tty if the script reports a different port — it probes `/dev/ttyUSB*`.

**The only reliable confirmation** is the core's SMF ledger showing
`Removed → 0` then `Added → 1` with the current date. **Not** that the UE is
reachable. Ask the core side to confirm that pair before treating any QoS change
as live.

### 5.2 Test setup currently on the rig

| | |
|---|---|
| UE bearer address | `10.45.0.12` (stable lately; design notes it changes across data calls) |
| Core side | `10.45.0.1`, MTU 1400 |
| iperf3 servers on UE | ports 5201 and 5202 |
| Current PCC rule | TCP **and** UDP to port 5202 → second QoS flow (5QI 4, GBR 40 Mbit/s) |
| Default flow | 5QI 7, RLC UM, `discard_timer: -1` |

**Measurement trap worth inheriting:** an early result was void because the PCC
filter was written for TCP only while the test ran UDP. Both streams sat on the
default flow and split evenly — which looked exactly like a scheduler that does
not differentiate. **Always confirm traffic landed on the intended flow, on N3,
rather than inferring from the port you sent to.**

A second one: a 300 s run was invalidated by another session driving 44 Mbit/s
of concurrent downlink through the same TDD frame. Check the bearer is idle
before starting any timed run.

### 5.3 Radio context

- Cell: 100 MHz n78 TDD, 30 kHz SCS, **0.5 ms slot**
- TDD pattern: **1400 DL : 600 UL slots per 2000** (70/30) — never explicitly
  configured, this is the srsRAN default
- Measured uplink ceiling: **~123 Mbit/s**
- Round-trip: **16–29 ms**

**Hard floor:** any packet delay budget under roughly **30 ms is unachievable on
the uplink here**. A profile with a 10 ms PDCP discard timer (5QI 80) reduced
uplink to **17.5 kbit/s against 110 Mbit/s downlink** — uplink packets expired
in the UE's own PDCP while waiting for a grant. Relevant when choosing gate
cycle lengths and 5QI profiles.

---

## 6. How to verify any of this yourself

On the core side (`amrctsnserver`), with `f1ap_level: debug` and
`cu_level: debug` in `gnb_x410.yaml`:

```bash
# which QoS flows / 5QIs / RLC modes are actually in force
grep -oE '"qoSFlowIdentifier": [0-9]+|"fiveQI": [0-9]+|"rLCMode": "[a-z-]+"' \
  ~/tsntestbed/gnb.log | sort | uniq -c

# per-bearer logical channel config the UE was given
# (requires cu_level: debug — the CU-CP then decodes masterCellGroup)
grep -A6 'mac-LogicalChannelConfig' ~/tsntestbed/gnb.log
```

To see which QFI uplink packets actually carried, capture N3 on loopback (the
gNB and core are co-located, so GTP-U is on `lo`):

```bash
sudo tcpdump -i lo -nn 'udp port 2152' -s 160 -w /tmp/n3.pcap
```

The QFI is in the GTP-U PDU Session Container extension header (type `0x85`),
second byte of the content, lower 6 bits. PDU type `1` = uplink, `0` = downlink.

---

*Companion material: "Anatomy of the Testbed" (system diagrams and the twelve
findings) and "Where the Radio Can See" (the 5QI/DSCP/PCP marking stack).*
