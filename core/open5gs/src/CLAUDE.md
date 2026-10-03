# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **TSN (Time-Sensitive Networking) / 5G-ACIA fork of Open5GS 2.7.6** that integrates a 5G core with IEEE 802.1 TSN bridging for deterministic industrial networking, per 3GPP TS 23.501 §5.27/5.28 and TS 24.519. Reference 3GPP specs are checked in under `3gpp-tsn-docs/`.

Open5GS itself is a C implementation of 5G Core (5GC) and 4G EPC network functions (AMF, SMF, UPF, NRF, UDM, UDR, AUSF, PCF, NSSF, BSF, SCP, SEPP, plus 4G MME/SGW/HSS/PCRF). Licensed under GNU AGPL v3.0.

## TSN Additions (what differs from upstream Open5GS)

The 5G-TSN "logical bridge" model: TSN-AF/TSCTSF exposes the 5G system to a TSN CNC as if it were an 802.1 bridge; the UPF hosts the network-side translator (NW-TT); a Python DS-TT daemon runs on the device side.

- **`src/tsn-af/`** — New network function: TSN Application Function / TSCTSF (`open5gs-tsn-afd`, config `configs/open5gs/tsn-af.yaml.in`, SBI on 127.0.0.30:7777). Key files:
  - `cnc-handler.c` — REST endpoint for the TSN CNC (bridge/port management requests)
  - `ts24519.c` — 3GPP TS 24.519 encoding: PSFP stream filters/gates/meters (802.1Qci/Qbv), time domains, TSC Assistance Information
  - `bridge-mgmt.c` / `bridge-health.c` — creates and monitors Linux bridges and TAP devices
  - `lldp-discovery.c` — LLDP (802.1AB) endpoint discovery
  - `npcf-*`, `nsmf-handler.c`, `ntsctsf-handler.c`, `qos-select.c` — PCF/SMF integration and TSN QoS-to-5QI mapping
- **`src/upf/nwtt.c`** — NW-TT (network-side TSN translator) inside the UPF: gPTP (802.1AS) frame processing with hardware PTP clock (PHC) and linuxptp integration, PSFP per-stream filtering/policing, LLDP relay, PCP↔QFI QoS mapping, de-jitter buffering, residence-time/jitter statistics. `src/upf/tsn-info.c` dumps TSN state.
- **SMF TSN extensions** — per-session `tsn_info` in `src/smf/context.h`, propagated over N4/PFCP (`n4-build.c`, `n4-handler.c`) and policy (`npcf-build.c`).
- **`lib/sbi/openapi/model/`** — added TSN models: `tsctsf_info`, `tsn_bridge_info`, `pdu_session_tsn_bridge`, `tsn_qos_container`, etc.
- **`tools/ds-tt/`** — DS-TT (device-side TSN translator): standalone Python 3.8+ package/daemon (`pip install -e .`, entry point `ds-tt`; deps pyserial/pyroute2/pyyaml; systemd units and a web UI included). Manages device-side bridge/VLAN, gPTP, LLDP, and 5G modem (serial AT commands). `tools/test-bridge.py` tests bridge forwarding with veth pairs.

There is no upstream remote to sync with — treat TSN code as first-class, not a patch set.

## Build Commands

```bash
# Install dependencies (Ubuntu)
sudo apt install ninja-build build-essential flex bison libsctp-dev \
  libgnutls28-dev libgcrypt-dev libssl-dev libmongoc-dev libbson-dev \
  libnghttp2-dev libmicrohttpd-dev libcurl4-gnutls-dev libtins-dev \
  libtalloc-dev libyaml-dev meson

# Configure and build
meson setup build
ninja -C build

# Run all tests (requires MongoDB running and TUN devices configured)
meson test -C build -v

# Run a single test suite
meson test -C build -v --suite unit
meson test -C build -v --suite registration
```

### TUN Device Setup (Required for Tests)

Tests require TUN network interfaces. Run `misc/netconf.sh` or manually:

```bash
sudo ip tuntap add name ogstun mode tun
sudo ip addr add 10.45.0.1/16 dev ogstun
sudo ip addr add 2001:db8:cafe::1/48 dev ogstun
sudo ip link set ogstun up
```

Additional interfaces ogstun2 (10.46.0.1/16) and ogstun3 (10.47.0.1/16) are needed for full test coverage.

## Running the Core

`./run5gs.sh` (run as root) starts/stops the whole stack from the local `build/` tree:

```bash
sudo ./run5gs.sh start      # MongoDB + ogstun + 5G NFs (nrf scp ausf udm udr pcf nssf bsf amf smf upf) + WebUI
sudo ./run5gs.sh stop|restart|status
./run5gs.sh logs [nf-name]  # tail /var/local/log/open5gs/<nf>.log
```

Note: `run5gs.sh` does not start `tsn-afd`; run it manually when needed:
`build/src/tsn-af/open5gs-tsn-afd -c build/configs/open5gs/tsn-af.yaml`

Each service is a separate process: `open5gs-<service>d -c <config>.yaml`. CLI flags: `-c` config file, `-l` log file, `-e` log level, `-D` daemon mode. Send SIGUSR1 for talloc memory stats, SIGUSR2 for full memory report. Configuration files are YAML templates in `configs/open5gs/` (e.g., `amf.yaml.in`, `smf.yaml.in`), instantiated into `build/configs/open5gs/`.

## Architecture

### Service Pattern

Each network function in `src/` follows a consistent modular pattern:

```
src/<service>/
├── app.c                    # Service initialization and lifecycle
├── context.c/h              # Global state and session contexts
├── event.c/h                # Event definitions for the event loop
├── <service>-sm.c/h         # Finite state machine (FSM) for the service
├── init.c                   # Module registration
├── <interface>-build.c      # Protocol message construction
├── <interface>-handler.c    # Incoming message processing
├── <interface>-path.c       # Request routing/path building
└── metrics.c/h              # Prometheus metrics
```

### Core Libraries (`lib/`)

- **core/** - Foundation: event loop (epoll/kqueue), talloc memory management, sockets (TCP/UDP/SCTP), timers, logging, data structures (hash tables, red-black trees)
- **sbi/** - HTTP/2 REST APIs for 5G Service-Based Interface (uses nghttp2)
- **nas/5gs/** and **nas/eps/** - NAS protocol encoders/decoders for 5G and 4G
- **ngap/** - 5G gNodeB control plane protocol (ASN.1-based)
- **s1ap/** - 4G eNodeB control plane protocol (ASN.1-based)
- **gtp/v1/** and **gtp/v2/** - GTP tunnel protocol for user plane
- **pfcp/** - Packet Forwarding Control Protocol (SMF-UPF N4 interface)
- **diameter/** - 4G Diameter protocol interfaces (Gx, Rx, S6a, Cx, etc.)
- **crypt/** - 3GPP security algorithms: Milenage, KASUMI, SNOW-3G, ZUC, AES, SHA, KDF
- **dbi/** - MongoDB database interface for subscriber data
- **app/** - Application framework, YAML configuration parsing

### Inter-Service Communication

- **5G services** communicate via SBI (HTTP/2 REST) through NRF for service discovery
- **4G services** use Diameter protocol and GTPv2-C
- **Control plane** transport: SCTP (NGAP for 5G, S1AP for 4G)
- **User plane**: GTP-U tunnels managed via PFCP between SMF and UPF
- **TSN control plane**: CNC → TSN-AF (REST) → PCF/SMF (SBI) → UPF (PFCP/N4), carrying TS 24.519 port/bridge management containers

### Test Organization (`tests/`)

Tests use the ABTS (Apache Bench Test Suite) framework defined in `lib/core/abts.c`.

- **unit/** - Protocol message encoding/decoding tests (NAS, NGAP, S1AP, GTP, SBI, security)
- **core/**, **crypt/**, **sctp/** - Library-level tests
- **registration/**, **attach/**, **vonr/**, **volte/**, **handover/**, **csfb/**, **slice/**, **non3gpp/**, **transfer/** - End-to-end procedure tests simulating UE/gNB/eNB interactions
- Tests require MongoDB and TUN devices; most run non-parallel

### WebUI

Node.js/React application in `webui/` for subscriber management. Uses MongoDB, Express, Next.js, Redux. Started by `run5gs.sh` at http://localhost:9999.

## Code Style

- C standard: gnu89
- Indentation: 4 spaces (see `.editorconfig`)
- Compiler enforces: `-Werror=missing-prototypes`, `-Werror=missing-declarations`, `-Werror=implicit-function-declaration`, `-Werror=return-type`, `-Werror=incompatible-pointer-types`
- Memory management uses talloc hierarchical allocator throughout
- Static analysis configured via `.clang-tidy`
