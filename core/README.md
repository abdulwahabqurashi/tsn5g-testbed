# core/

The 5G core (Open5GS, TSN/5G-ACIA fork) and the gNB (srsRAN Project on a USRP
X410), both on one server. Installed with `sudo ./install.sh core`.

| Path | What |
|---|---|
| `gnb/gnb.yaml.in` | the gNB config — first rig's tuned state (RLC AM for 5QI 4/7/9, PUSCH link-adaptation fix, CPU pinning) |
| `open5gs/configs/*.yaml.in` | the 12 Open5GS network functions that run (PLMN, TAC, DNN, UE pool, MTU from site.env) |
| `open5gs/subscriber.json.in` | the UE's subscriber record: static IP, default 5QI, GBR flow on source port `GBR_SOURCE_PORT` |
| `open5gs/provision.sh` | writes that record into MongoDB (keys from `secrets.env`; `--dry-run` shows it masked) |

Rendered files land in `/etc/tsn5g/` (`gnb.yaml`, `open5gs/*.yaml`); the
network functions and the gNB are started from there, not from the build tree.
