# core/qos/

QoS for the UE's PDU session, managed and checked from the core.

```bash
core/qos/qos-ctl.py profiles                 # the library (profiles.json)
core/qos/qos-ctl.py show                     # MongoDB rules | SMF live flows | gNB per 5QI
sudo core/qos/qos-ctl.py apply camera-protected --rebuild
sudo core/qos/qos-ctl.py verify --seconds 10 # which QoS flow each UE source port really used
```

Why on the core: the UE's modem does not report its QoS rules (`AT+C5GQOSRDP`
unsupported, `+CGEQOSRDP`/`+CGTFTRDP` empty, QMI "QoS not supported"). The
core has the rules (MongoDB), the live flows (SMF `/pdu-info`) and, in every
uplink GTP-U packet, the QFI the radio carried it on.

- A profile becomes one **PCC rule** = one QoS flow, matched on the UE's
  **source port** (the rule is written "to assigned PORT"; Open5GS swaps it for
  the uplink).
- Changes take effect only in a **new PDU session**: `--rebuild` asks the UE's
  API to build one (`/api/bearer/rebuild`), or use the UE console.
- Every `apply` saves the previous subscriber record (without keys) under
  `/var/lib/tsn5g/qos-backups/`. SIM keys and SQN are never touched.
- A 5QI that has no `qos:` entry in the gNB config gets srsRAN's defaults;
  `show` and `apply` warn about it (for 5QI 4 the default was RLC UM, which lost
  camera frames).

To add a profile, add an entry to `profiles.json` (5qi, arp, gbr_mbps/mbr_mbps
for GBR, port, protocols) and commit it.
