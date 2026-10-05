# tools/

Measurement scripts. Run them **on the UE, as the desktop user** (they ask for
sudo when they need it). Every value — the core's SSH address, the bearer
address, the modem interface, ports — comes from `site.env` via `common.sh`.

| Script | What it answers | Needs |
|---|---|---|
| `demo-run.sh` | Does the protected camera keep its frames when the uplink is flooded, with the policy on vs off? (the headline demo) | cameras running, SSH key to the core, sudo on the core once |
| `camera-loss-check.sh [s]` | Are datagrams lost between the UE and the core's N3? (UE counters vs a core capture, same instant) | cameras running |
| `radio-loss-test.sh` | Raw radio loss for four UDP patterns, no cameras | cameras stopped |
| `lcp-test.sh 1\|2\|2b\|2c\|3` | Does the modem honour QoS flow priority under congestion? (LCP brief) | cameras stopped |
| `qbv-live.sh` | Stage 6: does a Qbv gate help on the real uplink? Gate vs today's priority policy, scheduled vs unscheduled talker, plus a scan of the radio's 5 ms TDD frame | cameras stopped, SSH key to the core |
| `gnb-drift.sh` | Does the gNB's radio timing drift against PTP time? Repeated scans of send phase across the 5 ms frame; verdict on whether the X410 needs 10 MHz + PPS | cameras stopped, SSH key to the core, ~30 min |
| `qbv-sandbox.sh` | The same comparison in throwaway namespaces with an emulated radio (no wwan0 touched) | sudo |
| `modem/ue_qmi_up.sh up\|down\|status` | Bring the data call up by hand (the daemon normally does it) | daemon stopped |
| `modem/at.py 'AT…'` | Send one AT command to the modem | — |

| `git-hooks/pre-commit` | Refuses commits containing site.env, secrets, SIM keys, big files (`git config core.hooksPath tools/git-hooks`) | — |
| `core-experiments/` | The first rig's one-off core tests, unchanged (not parameterised) | — |

The analysers (`demo-analyse.py`, `lcp-analyse.py`, `n3count.py`) are run by
the scripts above and can be re-run on a saved result directory.

Results go under `~/demo-runs/`, `~/lcp-runs/`, `~/radio-loss/`.
Override any site value for one run: `CORE_SSH=me@host ./demo-run.sh`.
