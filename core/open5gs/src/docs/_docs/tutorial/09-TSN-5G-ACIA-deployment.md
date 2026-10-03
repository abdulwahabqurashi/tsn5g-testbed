---
title: 5G-TSN Deployment Guide (5G-ACIA)
---

This guide describes how to deploy this Open5GS TSN/5G-ACIA fork as an
IEEE 802.1 TSN logical bridge per 3GPP TS 23.501 §5.27/5.28, from build to a
verified Ethernet (L2) PDU session carrying TSN traffic. It is written from a
real deployment against a CloudRAN Polaris gNB and an AIlink 5G router
(Quectel RM500U-CNV) with a Raspberry Pi end station, and includes every
pitfall found on the way.

---

## 1. Architecture

The 5G system is exposed to the TSN network as a single logical 802.1 bridge:

```
                        ┌────────────────────── 5GS logical TSN bridge ──────────────────────┐
 TSN end station        │                                                                    │   TSN network / CNC
┌──────────────┐  eth   │ ┌────────┐   NR    ┌─────────┐  N3/GTP-U  ┌───────────────────┐    │  ┌──────────────┐
│ Raspberry Pi ├────────┼─┤ DS-TT  │◄───────►│  gNB    ├───────────►│  UPF + NW-TT      │◄───┼──┤ bridge port  │
│ (ptp4l etc.) │        │ │(UE/mo- │         │(Polaris)│            │  (ogstap, PSFP,   │    │  │ (tsn-br-1 +  │
└──────────────┘        │ │ dem)   │         └────┬────┘            │   gPTP, PCP→QFI)  │    │  │  phys. NIC)  │
                        │ └────────┘              │ N2/NGAP         └─────────┬─────────┘    │  └──────────────┘
                        │                    ┌────┴────┐   SBI  ┌─────────────┴──────────┐   │
                        │                    │   AMF   │◄──────►│ SMF / PCF / TSN-AF     │◄──┼── CNC (REST)
                        │                    └─────────┘        │ (TSCTSF, TS 24.519)    │   │
                        │                                       └────────────────────────┘   │
                        └────────────────────────────────────────────────────────────────────┘
```

Key components added by this fork:

| Component | Location | Role |
|---|---|---|
| TSN-AF / TSCTSF | `src/tsn-af/` (`open5gs-tsn-afd`) | CNC-facing REST API, TS 24.519 containers, bridge management/persistence, LLDP discovery, QoS→5QI mapping |
| NW-TT | `src/upf/nwtt.c` | Network-side TSN translator inside the UPF: gPTP residence time, PSFP filtering/policing, PCP→QFI classification, jitter stats |
| Ethernet PDU sessions | SMF/PCF/UPF | L2 (type 5) sessions bound to a TAP device (`ogstap`), one NW-TT port per session |
| DS-TT daemon | `tools/ds-tt/` | Optional device-side translator (Python) for bridge/VLAN/gPTP/LLDP and modem AT control |

---

## 2. Hardware and software prerequisites

Validated testbed:

* **Core host**: Ubuntu, kernel with TUN/TAP; a spare NIC for the TSN network
  side (bridged into `tsn-br-1`), and a NIC on the gNB transport network.
* **gNB**: CloudRAN Polaris (NGAP over SCTP to the AMF, GTP-U on N3).
* **UE**: AIlink industrial 5G router with Quectel **RM500U-CNV** module,
  configured for a 5G LAN / Ethernet dial profile.
* **End station**: Raspberry Pi (or any Ethernet device) plugged into the
  AIlink LAN, running `linuxptp` for PTP-over-5G tests.

Build dependencies (Ubuntu):

```bash
sudo apt install ninja-build build-essential flex bison libsctp-dev \
  libgnutls28-dev libgcrypt-dev libssl-dev libmongoc-dev libbson-dev \
  libnghttp2-dev libmicrohttpd-dev libcurl4-gnutls-dev libtins-dev \
  libtalloc-dev libyaml-dev meson mongodb-org nodejs
```

MongoDB must be running (`mongodb://localhost/open5gs`); the WebUI and all
core NFs share it. Two core variants can share one MongoDB — subscribers
provisioned once are visible to both.

---

## 3. Build

```bash
meson setup build
ninja -C build
```

Configuration templates in `configs/open5gs/*.yaml.in` are instantiated into
`build/configs/open5gs/*.yaml` at setup time. **Always edit the `.yaml.in`
templates** — plain `.yaml` edits are silently lost on the next
`meson setup`/regeneration (this caused several field failures: wrong PLMN,
wrong freeDiameter path).

---

## 4. Core configuration

The values below are the testbed's; adapt addresses to your site.

### 4.1 PLMN and subscriber identity

* PLMN: `999/90` (test PLMN). It must be identical in **three places**:
  AMF (`guami`, `tai`, `plmn_support`), NRF (`serving` PLMN), and the SIM.
* A mismatch produces `Registration reject [95]` (semantically incorrect
  message) at the AMF — check the NRF's serving PLMN first, it is the one
  that regenerates wrong most easily.
* Test SIM IMSI: `999909123456022`, provisioned via WebUI with:
  * Session type **Ethernet** (type 5), DNN **TSN**
  * Standard test K/OPc keys, SUCI null-scheme

### 4.2 AMF (`configs/open5gs/amf.yaml.in`)

```yaml
amf:
  ngap:
    server:
      - address: 10.11.8.101        # transport-network IP the gNB reaches
  security:
    integrity_order: [ NIA2, NIA1 ] # do NOT list NIA0 first
    ciphering_order: [ NEA0, NEA1, NEA2 ]
```

`integrity_order` including NIA0 at the head causes `Registration reject
[23]` (UE security capability mismatch) with this UE.

### 4.3 SMF (`configs/open5gs/smf.yaml.in`)

```yaml
smf:
  session:
    - subnet: 10.45.0.0/16          # IP sessions (unchanged)
      gateway: 10.45.0.1
      dnn: internet
    - dnn: TSN                      # Ethernet PDU sessions
      dev: ogstap                   # TAP device — MUST be TAP, not TUN
  freeDiameter: /etc/freeDiameter/smf.conf   # absolute, existing path
```

Ethernet PDU sessions need a **TAP** device (L2 frames); a TUN device only
carries L3 and silently breaks the session. The freeDiameter path must point
at an existing config or the SMF exits at startup.

### 4.4 UPF (`configs/open5gs/upf.yaml.in`)

```yaml
upf:
  session:
    - subnet: 10.45.0.0/16
      gateway: 10.45.0.1
    - dnn: TSN
      dev: ogstap
  nwtt:
    enabled: true
    bridge_id: 1
    gptp:
      enabled: true
    qos_mapping:                    # PCP → QFI (802.1Q priority to 5QI flow)
      - pcp: 7
        qfi: 86
      - pcp: 6
        qfi: 85
      - pcp: 5
        qfi: 84
```

### 4.5 Time keeping

The NW-TT residence-time and jitter clocks use `CLOCK_MONOTONIC_RAW` —
**do not run `phc2sys` against the system clock** on the core host. A stepped
system clock breaks freeDiameter certificate validation and crashes the SMF
("freeDiameter not yet activated"). Keep NTP for the system clock; PHC
hardware timestamping is used independently where available.

---

## 5. Host network setup

```bash
# TAP for Ethernet PDU sessions (created by run5gs.sh as well)
sudo ip tuntap add name ogstap mode tap
sudo ip link set ogstap up

# TSN-side bridge: joins the 5G L2 segment to the physical TSN network
sudo ip link add tsn-br-1 type bridge
sudo ip link set tsn-br-1 up
sudo ip link set ogstap master tsn-br-1
sudo ip link set <physical-tsn-nic> master tsn-br-1
sudo ip addr add 192.168.8.5/24 dev tsn-br-1   # core's IP on the UE LAN

# forward gPTP/LLDP (link-local multicast) through the bridge
echo 0x4000 | sudo tee /sys/class/net/tsn-br-1/bridge/group_fwd_mask
```

Note: every broadcast on the physical NIC's LAN floods into `ogstap` and is
carried over the radio. On a busy lab LAN consider VLAN-separating the TSN
segment to avoid burning air-interface capacity on unrelated broadcast
traffic.

---

## 6. Running the core

```bash
sudo ./run5gs.sh start      # MongoDB check + ogstun/ogstap + all NFs + WebUI
./run5gs.sh logs smf        # tail one NF log (/var/local/log/open5gs/)
sudo ./run5gs.sh stop
```

`run5gs.sh` starts: nrf scp ausf udm udr pcf nssf bsf amf smf upf **tsn-af**
and the WebUI (bound to `$WEBUI_ADDR`, default `10.5.0.84`, port 9999).

For unattended management (restarting NFs from scripts/CI without a password
prompt) a scoped sudoers rule is convenient:

```
# /etc/sudoers.d/open5gs-core   (chmod 440)
open5gs ALL=(root) NOPASSWD: /usr/bin/pkill, /usr/bin/kill, \
  /path/to/run5gs.sh, /path/to/build/src/*/open5gs-*, /usr/sbin/ip
```

When killing an NF from scripts use `pkill -x open5gs-<nf>d` (exact match) —
`pkill -f` matches your own shell's command line and kills it.

---

## 7. UE (AIlink / RM500U) configuration

Dial profile on the router:

* **APN**: `TSN`
* **Protocol / PDP type**: `Ethernet` (maps to PDU session type 5)
* **Dial function**: `5glan`
* IMS off; SA mode; bands as appropriate (n77/n78 typical for private cells)

Verify from the router's AT console:

```
AT+CGDCONT?     →  +CGDCONT: 1,"Ethernet","TSN",...
AT+C5GREG?      →  +C5GREG: 2,1  (registered) after attach
AT+QENG="servingcell"   → shows the serving NR cell (or SEARCH if none)
```

### Known UE-side limitations (RM500U-CNV, important)

1. **Routed-mode downlink unicast.** Some 5G routers do not transparently
   bridge downlink unicast to LAN devices (only frames addressed to the
   modem's own MAC, plus broadcast/multicast, are delivered). This fork
   handles that transparently: enable `dl_mac_adaptation: true` in the
   UPF `nwtt` config. The UPF then readdresses downlink IP unicast to the
   session gateway MAC (first MAC learned per session, `gw_mac` in
   `/tsn-info`) so the UE-side router delivers it by IP, and emits ARP
   replies as broadcast so LAN devices can resolve network-side hosts.
   With this enabled, full bidirectional unicast works with zero UE-side
   configuration. (Historical note: the symptom "ARP resolves but
   ping/TCP fails" on old builds was primarily a UPF bug — the TUN-era
   ARP proxy silently dropped ARP on Ethernet-session TAPs; fixed, see
   §11.) The module-level alternative is `AT+QCFG="nat",0` +
   `AT+QCFG="5glan",1,1` where AT access exists.
2. **No SIB9 / no GNSS output**: the module does not expose 5G network time
   to the host or LAN, so DS-TT-side time sync must come over the user plane
   (PTP) — see §9.
3. **Router NAT**: disable MASQ/NAT and any WAN-zone drop rules on the
   mobile interface; the 5G side is a private L2 segment, not an internet
   uplink. Note this alone does not fix (1) — that is below IP.
4. The router's dial daemon reconfigures the module on every redial; verify
   AT-level settings persist after a redial before relying on them.

---

## 8. Verification checklist

Work down this list in order; each step's failure mode is listed.

1. **gNB ↔ AMF**: `NG Setup` in `amf.log` ("Number of gNBs is now 1").
   Check the SCTP association with `ss -S | grep 38412` — **not** `ss -tan`
   (SCTP is invisible to TCP queries).
   * A kernel association can show `ESTAB` while the gNB application is
     wedged (no NGAP traffic, stale GTP-U still flowing). Restarting the AMF
     forces teardown; a healthy gNB re-runs NG Setup within ~30 s. If it
     does not come back, restart the gNB.
2. **UE registration**: "Registration complete" for your IMSI in `amf.log`.
   * Reject `[95]` → PLMN mismatch (check NRF serving PLMN).
   * Reject `[23]` → integrity order (remove NIA0).
   * Nothing arrives at all → the gNB cell is not serving; check
     `AT+QENG="servingcell"` on the modem and restart the gNB radio.
3. **Ethernet PDU session**: SMF logs the session with `DNN[TSN]` and empty
   IPv4/IPv6; UPF logs `Ethernet PDU session: using TAP 'ogstap'` and the
   NW-TT port creation.
   * PCF 400 "No IPv4 address" → running an old build without the
     Ethernet-session exception in `pcf/npcf-handler.c`.
4. **Data plane**: `curl http://127.0.0.7:9090/tsn-info` — the port's
   `rx_frames` (uplink) must grow when a LAN device talks; `ue_macs` lists
   every learned device MAC behind the session.
   * Uplink stuck at 0 on an old build → the TAP-write FAR condition fix in
     `upf/gtp-path.c` is missing.
5. **End-to-end L2**: from the core, `arping -I tsn-br-1 <device-ip>`
   (broadcast — always crosses if the session is up). Then `ping` (unicast —
   subject to UE limitation §7.1).
6. **Session stability**: if `amf.log` shows `UE Context Release [Action:3]`
   every ~90 s, the gNB's RRC inactivity timer is releasing the idle UE.
   Configure a longer timer on the gNB, and/or keep the session busy
   (a 1 Hz ping or the PTP stream itself). Note that after core NF restarts
   the resume/paging chain for Ethernet sessions can wedge (session shows
   `resource_status: 0` and downlink goes to a dead tunnel) — one redial on
   the router re-establishes clean state. UPF restarts are recovered
   automatically by PFCP restoration (the SMF re-creates sessions), but the
   gNB-side tunnel is only refreshed by a session re-establishment.

---

## 9. TSN features and testing

### PTP over 5G (gPTP / IEEE 1588)

* The NW-TT acts as a transparent-clock-style forwarder; the DS-TT side
  (Pi) runs `ptp4l`. L2 PTP uses **multicast**, so it is unaffected by the
  RM500U unicast limitation.
* Achievable accuracy is bounded by 5G radio latency variation (~16–26 ms
  one-way with drift): best samples ~2–3 µs, RMS ~0.9–1 ms with a tuned
  servo. Useful `ptp4l` settings: `delay_filter moving_median`, a slow PI
  servo or `linreg`, long `delay/sync` intervals.
* Without SIB9/TSCAI to the gNB there is no access-stratum time injection;
  the user-plane path is the only sync channel.

### PSFP (802.1Qci), PCP→QFI, LLDP, CNC

* Stream filters/gates/meters are pushed via the TSN-AF (TS 24.519
  containers) or configured in the WebUI (5GS Bridge → stream filters);
  per-port PSFP counters appear in `/tsn-info` and TSN Monitoring.
* PCP→QFI mapping (§4.4) maps 802.1Q priorities onto distinct QoS flows;
  verify with VLAN-tagged traffic at different PCPs.
* LLDP: the NW-TT originates/relays LLDP (30 s interval); discovered
  neighbors appear in the topology view and `/tsn-info`.
* CNC REST API: bridge/port management on the TSN-AF SBI address
  (`configs/open5gs/tsn-af.yaml.in`, default `127.0.0.30:7777`); bridge
  definitions persist across restarts in
  `/var/lib/open5gs/tsn-af-bridges.json`.

### Throughput characteristics and overload protection

Measured on this testbed (45 Mbps DL / ~100 Mbps UL radio):

* **Paced traffic** (UDP, PTP, cyclic industrial streams) runs at the full
  radio rate with 0% loss — TSN workloads are unaffected by the notes below.
* **Un-paced bulk TCP downlink** collapses (~1 Mbps) against the gNB's very
  shallow downlink buffer: line-rate micro-bursts overflow it, every loss
  halves the congestion window, and throughput settles at cwnd/RTT. Fix by
  pacing downlink at the core host, slightly under the radio rate:
  `tc qdisc replace dev <N3-iface> root cake bandwidth 40Mbit`.
* **Session-AMBR is enforced by this UPF** (token-bucket QER policer,
  100 ms burst, TS 23.501 §5.7.1 — not present in stock Open5GS). Set a
  realistic Session-AMBR in the subscriber profile (e.g. 40M DL / 100M UL);
  overload is then dropped at the UPF before it can bury the RAN — a 1 Gbps
  UDP flood polices cleanly to the AMBR with concurrent traffic and the
  session unaffected. Policed drops appear as `mbr_dropped_frames` in
  `/tsn-info`. Without enforcement, a flood wedges the user plane (session
  shows `resource_status: 0` until re-established).

### GBR QoS flows

The SMF omits the PDU-Session AMBR IE for GBR-only sessions per TS 38.413
§9.3.4.1 (some gNBs reject GBR-only sessions that carry AMBR). Mixed and
non-GBR sessions include AMBR as usual.

---

## 10. Monitoring

* **WebUI** (`http://<WEBUI_ADDR>:9999`): Dashboard (live throughput,
  clients, port grid), 5GS Bridge (bridge config, NW-TT ports, topology),
  TSN Monitoring (PSFP, jitter history), UE Performance (live DL/UL
  throughput, latency probe), Logs (all NF logs).
* **Raw endpoints**: UPF `http://127.0.0.7:9090/tsn-info` (JSON: bridge,
  ports, traffic/PSFP/jitter counters, learned `ue_macs`); AMF
  `http://127.0.0.5:9090/ue-info`; Prometheus metrics on each NF's
  metrics port.
* **Logs**: `/var/local/log/open5gs/<nf>.log`.

---

## 11. Troubleshooting quick reference

| Symptom | Cause | Fix |
|---|---|---|
| Registration reject [95] | PLMN mismatch (usually NRF serving PLMN) | Align PLMN in AMF+NRF+SIM |
| Registration reject [23] | NIA0 first in integrity_order | `[NIA2, NIA1]` |
| SMF exits: freeDiameter "No such file" | Regenerated config points at missing path | Fix `freeDiameter:` in `smf.yaml.in` |
| SMF crash: freeDiameter "not yet activated" | System clock stepped (phc2sys) | Stop phc2sys, restore NTP |
| PCF 400 "No IPv4 address" (Ethernet session) | Old build | Update: Ethernet/Unstructured exception in PCF |
| NW-TT `rx_frames` stuck at 0 | Old build (uplink FAR condition) | Update `upf/gtp-path.c` |
| ARP works, ping/TCP dead (network→UE) | Old build: UPF ARP proxy ate ARP on TAPs; routed-mode UE | Update UPF; enable `dl_mac_adaptation` (§7.1) |
| DL TCP stuck ~1 Mbps, UDP fine | Shallow gNB DL buffer vs TCP bursts | Pace with `tc cake` (§9) |
| Traffic flood wedges the session | No AMBR enforcement (stock) | This UPF polices Session-AMBR (§9) |
| UE idles every ~90 s (`Release Action:3`) | gNB RRC inactivity timer | Raise timer; keepalive traffic |
| gNB SCTP ESTAB but silent | gNB app wedged behind kernel socket | Restart AMF (forces NG re-setup) or gNB |
| No attach, `+COPS: 0`, cell not found | gNB radio not serving | Restart gNB |
| Session dead after core restarts (`resource_status: 0`) | Stale tunnel state | One redial on the router |
| Jitter shows huge values (~seconds) | Old build measured inter-arrival | Update: PDV jitter fix in `nwtt.c` |

---

## 12. File map (fork-specific)

| Path | Content |
|---|---|
| `src/tsn-af/` | TSN-AF/TSCTSF NF (CNC handler, TS 24.519, bridge mgmt/persist/health, LLDP, QoS select) |
| `src/upf/nwtt.c/.h` | NW-TT data path (gPTP, PSFP, PCP→QFI, jitter) |
| `src/upf/tsn-info.c` | `/tsn-info` JSON endpoint |
| `src/upf/gtp-path.c` | Ethernet PDU forwarding, MAC learning (per-session table), UE-UE hairpin |
| `src/smf/ngap-build.c` | GBR-aware AMBR IE handling |
| `tools/ds-tt/` | Device-side TSN translator daemon |
| `tools/ue-perf/` | Standalone UE performance collector + HTML report |
| `run5gs.sh` | Stack orchestration |
| `webui/` | AMRC management console |
