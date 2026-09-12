# TSN-5G UE Console

Plug-and-play, **100% UI-driven** application for the **User Equipment (UE)** side of an
end-to-end *Time-Sensitive Networking (TSN) over 5G* system.

It runs on a Linux UE (e.g. Cincoze DI-1200 with a Quectel RM520N-GL 5G modem) and lets a
non-expert, from a web UI — **no terminal, ever**:

1. **Attach** the UE to the 5G network.
2. **Choose the transport** with one click — **VXLAN overlay** or **native Ethernet PDU**.
3. **Bridge** a local wired TSN device onto the 5G link, with **gPTP** time sync.
4. **Forward TSN configuration to the wired switch** (IEEE 802.1Qbv gate schedules,
   VLAN/PCP) — one-click presets for the FS TSN3220.

> Scope is **UE + wired switch only**. The 5G core subscriber (IMSI/K/OPC, DNN, PDU
> session type, PCC rules) is assumed already provisioned on the core.

## How it runs

A single Python service (`tsn5g_ue`) runs as root on the UE and serves a
dependency-free web UI on `http://<ue>:8080`. A thin kiosk wrapper can auto-open that
URL full-screen at boot so the UE behaves like an appliance.

```
Browser / kiosk (UI)  ──HTTP──►  tsn5g-ue daemon (:8080)
                                  ├─ Discovery      (modem, NICs, VLAN/role)
                                  ├─ Modem          (attach: Ethernet-PDU | IP)
                                  ├─ Transport      (EthernetTransport | VxlanTransport)
                                  ├─ gPTP           (ptp4l TC + phc2sys)
                                  ├─ Switch         (FS TSN3220 Qbv presets over SSH)
                                  └─ Controller     (state machine: idle→connecting→running)
```

## Install (on the UE, once during imaging)

```bash
sudo ./scripts/install.sh          # installs deps + systemd units
```

Then open `http://<ue-ip>:8080` (or let the kiosk wrapper open it automatically).

## Development

```bash
pip install -e .
python -m tsn5g_ue -c config/tsn5g-ue.example.yaml
```

## Status

Scaffold. Module signatures, config schema, API routes, and the UI shell are in place.
Data-plane / modem / switch behaviour is ported from the reference testbed
incrementally — see [`docs/PORTING.md`](docs/PORTING.md).

## License

AGPL-3.0-or-later (ports logic from Open5GS-derived TSN tooling).
