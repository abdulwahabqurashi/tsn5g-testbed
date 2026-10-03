# Reference scripts

These are the **known-good manual procedures** for this rig, copied here verbatim
so they are version-controlled alongside the code that replaces them.

They are *specifications*, not dependencies. The daemon does not execute any of
them — it cannot: six of these scripts run `systemctl stop tsn5g-ue`, so shelling
out to them from the daemon would kill the daemon. They also all call `at.py`,
which opens `/dev/ttyUSB*` exclusively with no locking, and two independent
serial owners is a race rather than a design.

## The originals are still live

The working copies remain at `/home/amrc/camera_application/*.sh` and that is
still where you run them:

```sh
cd /home/amrc/camera_application
sudo ./connect.sh
```

They stay there until the feature that replaces each one has been verified on
hardware. These copies are the reference; those are the escape hatch for when
the daemon is dead.

## Script → module map

| Script | Replaced by | Phase |
|---|---|---|
| `ue_qmi_up.sh` | `tsn5g_ue/net/bearer.py` — the 5 steps become 5 job steps | 4 |
| `connect.sh` | job `bearer.connect` (mask MM → assert prefs → wait camp → bearer.up → verify) | 4 |
| `camp.sh` | `modem/radio.py`: `clear_forbidden_plmn()`, `select_plmn()`, `wait_for_camp()` | 5 |
| `lock5g.sh` | `radio.set_cell_lock()`, incl. the four-variant `QNWLOCK` argument-order probe | 5 |
| `fixband.sh`, `recover.sh`, `probe.sh`, `restore.sh` | one `radio.repair_band` job (band-syntax ladder + `restore_band`) | 5 |
| `scan.sh` | job `radio.scan` (`AT+QSCAN=3,1`, `AT+COPS=?`) | 5 |
| `rfcheck.sh` | job `radio.diagnose` | 5 |
| `force5g.sh`, `fix5g.sh`, `attempt.sh` | `radio.force_register(plmn, act=11)` | 5 |
| `rftest.sh` | **not ported as-is** — see the warning below | 5 |
| `diag.sh` | `GET /api/debug/snapshot` | 7 |
| `iperf5g.sh` | `tsn5g_ue/perf/iperf.py`, keeping the identical `summary.csv` schema | 6 |
| `at.py` | superseded by `modem/bus.py` + the Debug AT console; kept as the offline tool | 3 |

## Two things that must not be carried across

**1. `nr5g_disable_mode` must be 0.**
`connect.sh` records a verification dated 2026-09-08: this firmware
(`RM520NGLAAR03A01M4G`) only camps on SA with `nr5g_disable_mode=0`. Values 1 and
2 both prevent camping, and 1 additionally causes writes to `nr5g_band` to be
silently rejected.

`force5g.sh`, `fix5g.sh`, `restore.sh` and `rftest.sh`'s `trap restore EXIT` all
set it to **1**. Every one of those lines is deleted in the port, and the API
rejects any value other than 0.

**2. `AT+QPRTPARA=3` is not automated.**
`recover.sh` documents it as a last resort and deliberately does not run it. It
restores NV to defaults. It stays manual, and it is on the AT console deny-list.

## Other gotchas these scripts encode

- `--client-no-release-cid` is required on `--wds-start-network`, or the data
  call collapses the moment `qmicli` exits. It also means the session can only
  be stopped with the saved packet-data-handle and CID.
- `-B <wwan0 address>` is mandatory for iperf3. Without it an unbound run to
  anything outside `10.45.0.0/16` quietly travels over gigabit ethernet and
  reports numbers unrelated to 5G.
- The UE address is reassigned by the SMF on every data call (`.2 → .3 → .4 →
  .5` across the logs). Anything that caches it is wrong: use `MASQUERADE` not
  `SNAT --to-source`, and add the table-5 route with no `src`.
- The AT port moves between boots. Probe for it; never hard-code `ttyUSB2`.
- ModemManager must be **masked**, not stopped — D-Bus reactivates it.
