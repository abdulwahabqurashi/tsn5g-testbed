# tools/core-experiments/

One-off experiments run on the first rig's core (2026-09), kept as the record
of how results in `docs/history/core/` were obtained. They are **not**
parameterised — they name that server's NICs and paths. Read before reusing.

| Script | What it measured |
|---|---|
| `an_test.sh`, `fec_flap_test.sh` | X410 10G link: auto-negotiation and FEC flaps |
| `check_x410_modules.sh` | which ports have a DAC/transceiver (superseded by `core/scripts/x410-find-nic.sh`) |
| `irq_move_test.sh` | moving NIC IRQs off the gNB's isolated cores |
| `profile_compare.sh` | gNB real-time profile before/after the grub RT parameters |
| `qos_measure.sh`, `uplink_test.sh` | early uplink QoS / throughput runs |
