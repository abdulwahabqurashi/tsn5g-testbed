# API contract

The authoritative description of the HTTP surface. Both halves of the work — the
Python daemon and the `web/` UI — are written against this document, and
`scripts/check-endpoints.sh` checks a running box against it.

Base URL is the same origin that served the UI: `http://<ue>:8080`.

---

## 1. Conventions

### Responses

Every response sets `Content-Length` — required, because the server speaks
HTTP/1.1 with keep-alive.

Every non-2xx JSON body is:

```json
{ "error": "human readable, safe to show a user", "detail": "optional: stderr, traceback, raw output" }
```

`error` is what the UI renders. `detail` goes in a collapsed disclosure. The UI
must never invent a message like `HTTP 500` when `error` is present.

| Status | Meaning |
|---|---|
| `200` | synchronous success |
| `202` | a job was created; body is `{"job_id", "kind", "lane"}` |
| `204` | success, no body (`OPTIONS`) |
| `304` | static asset unchanged (`If-None-Match` matched) |
| `400` | malformed or missing field — `{"error": "missing field: 'host'"}` |
| `403` | refused by the safety layer — `{"error", "denied": true, "rule"}` |
| `404` | no such route or resource |
| `409` | the lane is busy — `{"error": "lane busy", "job_id": "<the one holding it>"}` |
| `428` | this action requires `{"confirm": true}` — `{"error", "explain"}` |
| `503` | too many SSE clients; carries `Retry-After` |

### Timing

Anything that can exceed ~200 ms is a **job**, not a blocking request. Handlers
do no blocking work; read models are served from snapshots the daemon loop
refreshes.

### Jobs

```json
{
  "id": "j-7f3a2c",
  "kind": "bearer.up",
  "lane": "bearer",
  "state": "queued | running | succeeded | failed | cancelled",
  "steps": [ { "name": "preflight", "state": "succeeded", "started": 0, "finished": 0, "detail": "" } ],
  "progress": { "pct": 40, "step": "start-network", "message": "" },
  "lines": ["06:57:13  starting network..."],
  "result": null,
  "error": null,
  "created": 0, "started": 0, "finished": 0,
  "cancellable": true
}
```

**Lanes** are `modem`, `bearer`, `perf`, `switch`, `net`. One worker per lane,
**reject-if-busy**: submitting to a busy lane returns `409` naming the job that
holds it. An honest 409 is better than a queue that silently fires four minutes
later.

Long-lived jobs (`iperf.loop`, `perf.dummy`) stay in `running` until stopped.
Stop and cancel are the same operation: `DELETE /api/jobs/{id}`.

### Confirmation

These require `{"confirm": true}` in the body, else `428`:
`modem.reset`, `modem.power(off)`, `modem.manager(unmask)`, `radio.repair_band`,
`bearer.down`, `bearer.cycle`, `net.routing.clear`, `net.ifconfig` on the
interface carrying the default route, iperf run deletion, Qbv disable, and any
AT command on the `WARN` list.

---

## 2. Events (SSE)

```
GET /api/events?topics=job,signal,log&last_id=417
```

```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

No `Content-Length`. A `: ping` comment every 15 s. Each event carries an
incrementing `id:`, so a reconnect with `Last-Event-ID` resumes rather than
losing the tail.

```
id: 418
event: job
data: {"job_id":"j-7f3a2c","state":"running","step":"start-network","pct":40}
```

**Topics:** `state`, `job`, `modem`, `signal`, `bearer`, `stats`, `iperf`,
`log`, `audit`, `alert`.

Client rules:
- **Exactly one `EventSource` per tab.** HTTP/1.1 caps a browser at ~6
  connections per origin; a second stream starves the tab's own requests.
- `EventSource` can sit in `OPEN` on a dead TCP connection with no error event
  ever firing. Treat 25 s of silence (against the 15 s ping) as dead regardless
  of `readyState`.
- After 3 consecutive failures, fall back to polling. The fallback is permanent,
  not transitional.

Server rules:
- Per-client queue is bounded (256). On overflow do **not** block the publisher:
  emit `event: overflow`, close the stream, and let the client resync from
  `/api/status`.
- `MAX_SSE_CLIENTS = 8`, beyond which `503` + `Retry-After: 5`.

---

## 3. Routes

Legend: **J** = returns `202` + job. **C** = requires `confirm`.

### System

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/status` | controller snapshot: state, step, modem, bearer, transport, gptp, tas |
| `GET` | `/api/health` | `{healthy, checks{modem,transport,gptp}, state}` |
| `GET` | `/api/stats` | per-interface counters + rates, link latency/jitter series |
| `GET` | `/api/discovery` | modem ports, NICs, platform, inferred role |
| `GET` | `/api/config` | YAML + settings overlay merged, with a `_source` map |
| `PUT` | `/api/config` | patch; writes the **overlay**, never the operator's YAML |
| `GET` | `/api/version` | `{version, git, built}` |
| `GET` | `/api/spec` | the route table, as JSON |
| `GET` | `/api/debug/snapshot` | one blob for bug reports; replaces `diag.sh` |

### Jobs

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/jobs` | `?state=&kind=&limit=` — live plus history |
| `GET` | `/api/jobs/{id}` | full job including `steps` |
| `GET` | `/api/jobs/{id}/log` | `?since=` → `{lines, next}` |
| `DELETE` | `/api/jobs/{id}` | cancel a running job / stop a long-lived one |

### Modem — hardware, power, raw AT

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/api/modem` | | bus status + QMI state + identity (IMEI masked) |
| `GET` | `/api/modem/ports` | | `{at, qmi, model, candidates}` |
| `POST` | `/api/modem/ports/rescan` | | **J** |
| `GET`/`PUT` | `/api/modem/power` | `{"radio":"on\|off\|airplane"}` | **J**, **C** for `off`. `CFUN=1/0/4` |
| `POST` | `/api/modem/reset` | `{confirm}` | **J**, **C**. `CFUN=1,1` then ~40 s USB re-enumeration, reported as progress |
| `GET`/`PUT` | `/api/modem/manager` | `{"action":"mask\|unmask"}` | **C** for unmask — it will fight for the port and rewrite radio prefs |
| `POST` | `/api/modem/at` | `{"cmd","timeout"}` | safety-checked; `200 {cmd, lines[], raw, ms}` or `403` |
| `GET` | `/api/modem/at/history` | | last 200 transactions from the audit log |
| `POST` | `/api/modem/bus/release` | | close the serial port so `at.py` can be used by hand |

### Radio — registration

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/api/radio` | | `{registered, reg_state, operator, rat, plmn, cell{...}, lock, prefs}` |
| `GET`/`PUT` | `/api/radio/prefs` | `{mode_pref, nr5g_band, nr5g_disable_mode}` | **J**. `nr5g_disable_mode` is validated to **0**; 1 and 2 are rejected `400` |
| `POST` | `/api/radio/plmn/select` | `{plmn, act, mode}` | **J**. `AT+COPS=1,2,"00102",11` |
| `GET` | `/api/radio/plmn/forbidden` | | `AT+QFPLMNCFG="get"` |
| `DELETE` | `/api/radio/plmn/forbidden/{plmn}` | | **J** |
| `GET`/`PUT`/`DELETE` | `/api/radio/lock` | `{arfcn, scs, band, pci}` | **J**. Tries the four `QNWLOCK` argument orders |
| `POST` | `/api/radio/scan` | `{"kind":"nr\|operators\|both"}` | **J**, 2–4 min, cancellable |
| `POST` | `/api/radio/camp/wait` | `{timeout_s}` | **J** |
| `POST` | `/api/radio/diagnose` | | **J** |
| `POST` | `/api/radio/band/repair` | `{confirm}` | **J**, **C** |

### Signal

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/signal` | `{rsrp, rsrq, sinr, rssi, band, arfcn, pci, rat, ts, stale}` |
| `GET` | `/api/signal/history` | `?from=&to=&step=&limit=` — downsampled |
| `PUT` | `/api/signal/poll` | `{interval_s, enabled}` — 0 disables during a scan |

Also pushed on SSE topic `signal`. When the AT bus is busy with a bulk
operation, telemetry **skips** rather than queueing, and publishes `stale: true`.

### Bearer

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/api/bearer` | | `{state, apn, ipv4, gw, mtu, pdh, cid, since, packet_service}` |
| `POST` | `/api/bearer/up` | `{apn, ip_type, routes, default_route, dns}` | **J** |
| `POST` | `/api/bearer/down` | `{confirm}` | **J**, **C** |
| `POST` | `/api/bearer/cycle` | `{confirm}` | **J**, **C**. down + up + re-apply routing |
| `POST` | `/api/connect` | | **J** — end to end, was `connect.sh` |
| `POST` | `/api/disconnect` | | **J** |

`bearer.up` emits exactly these step names, matching `ue_qmi_up.sh`:
`preflight → prepare-iface → start-network → read-settings → configure-iface → verify`.

`default_route` is only accepted when `api.allow_default_via_modem: true` is set
in the YAML (default false), and is **C** even then: it routes your SSH session
over 5G.

### Network

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/api/net/interfaces` | | |
| `PUT` | `/api/net/interfaces/{name}/ip` | `{method, address, gateway}` | **J**. Refuses `wwan0` — that is `/api/bearer`. **C** if this interface carries the default route |
| `GET` | `/api/net/routes` | | `ip route`, `ip rule`, `ip route show table 5` |
| `GET`/`PUT`/`DELETE` | `/api/net/routing-profile` | `{name, proto, dport, mark, table, dev, masquerade}` | **J**; **C** to clear |
| `POST` | `/api/net/routing-profile/verify` | | `ip route get` probes → `{stream_via, mgmt_via, ok, warnings}` |
| `GET` | `/api/net/wifi/scan` | | |
| `POST` | `/api/net/wifi/connect` | `{ssid, psk}` | **J** |

Routing profiles are idempotent: the exact rules added are recorded in
`/run/tsn5g-ue/routing.applied` and deleted individually before re-adding.
Never `iptables -F` — flushing a chain on a shared box is not ours to do.

### Performance

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/api/iperf/defaults` | | server, bind iface, UDP rates from config |
| `POST` | `/api/iperf/run` | `{server, port, proto, dir, duration, parallel, bind_iface, udp_rate, length, omit}` | **J** |
| `POST` | `/api/iperf/loop` | `{legs, duration, sample_radio}` | **J**, runs until cancelled |
| `GET` | `/api/iperf/runs` | `?limit=` | |
| `GET` | `/api/iperf/runs/{id}` | | run meta + legs |
| `GET` | `/api/iperf/runs/{id}/legs` | `?leg=&since_seq=` | rows matching `summary.csv` |
| `GET` | `/api/iperf/runs/{id}/summary.csv` | | the file, verbatim |
| `DELETE` | `/api/iperf/runs/{id}` | `{confirm}` | **C** |
| `GET`/`POST`/`DELETE` | `/api/perf/dummy` | `{kind, server, dir, bitrate, parallel, port, dscp, length}` | **J**. `kind` is `load` (continuous iperf3 TCP) or `flow` (synthetic app flow) |

`-B <current wwan0 address>` is **mandatory** and read live at job start — the
SMF reassigns the UE address on every data call, so a cached bind address
silently sends the test over ethernet.

On-disk layout is unchanged from `iperf5g.sh`, so existing runs stay readable:
`iperf_logs/<YYYYmmdd-HHMMSS>/summary.csv` with the header
`ts,seq,leg,proto,dir,mbps,retransmits,rtt_ms,jitter_ms,loss_pct,rsrp_dbm,sinr_db,status`
plus `%04d_<leg>.json` per leg.

### Logs and debug

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/logs` | `?level=&logger=&since_id=&limit=` — in-process ring |
| `GET` | `/api/logs/journal` | `?unit=&lines=&since=` |
| `GET`/`PUT` | `/api/logs/level` | `{logger, level}` — runtime, persisted to the overlay |
| `GET` | `/api/debug/commands` | `?limit=&kind=at\|shell` — argv, rc, stdout/stderr heads, duration |

SSE topic `log` carries INFO and above only; DEBUG stays in the ring or it
floods the stream.

### Advanced (TSN) — existing contracts, unchanged

`/api/transport/{start,stop}`, `/api/gptp/{start,stop}`,
`/api/tas/{apply,clear,profiles}`, `/api/switch/{profiles,apply,disable,status}`.
The `start` and `apply` verbs become jobs; request and response shapes do not
change.

> `POST /api/tas/apply` requires an explicit `profile` or `slots`. The config
> keys `tas.default_profile` and `switch.default_profile` are read by nothing;
> omitting the profile raises `unknown profile: None`.

### Applications (seam)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/apps` | returns `[]` today. The nav section renders only when non-empty |

---

## 4. Safety layer

### Never accepted, at any layer

- `AT+QNWPREFCFG="nr5g_disable_mode",1` and `,2` — verified 2026-09-08, this
  firmware only camps on SA with `0`, and `1` additionally makes `nr5g_band`
  writes fail silently.
- `AT+QPRTPARA` in any form (`=3` wipes NV).
- `AT+QCFG="usbnet"` **writes** — changing it destroys `/dev/cdc-wdm0` and the
  QMI path with it.
- `AT+EGMR` (IMEI), `AT+QFCT`, `AT+CRSM`, `AT+CSIM`, `AT&F`, `ATZ`.
- Any default route via `wwan0` in the **main** table, unless explicitly enabled
  in config *and* confirmed.

### Warned, and routed through the job system

`CFUN=0`, `CFUN=1,1`, `COPS=2`, `QNWLOCK`, `restore_band`. These need
`{"confirm": true}`; the `428` response carries an `explain` string describing
the consequence.

Every AT transaction, allowed or denied, is written to the audit log.

### The routing guard

Before and after every `net.routing.apply`:

```
ip route get <mgmt_peer>          # must stay on the management NIC
ip route get <stream_dst> mark 5  # expected: dev wwan0
ip route get <stream_dst>         # must NOT be wwan0
```

If the management egress changed, the rules just added are **rolled back
automatically** and the job fails with a before/after table.
