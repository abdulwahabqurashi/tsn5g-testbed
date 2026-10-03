# TSN-5G UE Console — User Guide

A web console for a 5G user equipment (UE): bring the radio up, attach to a 5G
network, control registration and cell selection, configure IP and policy
routing, and measure throughput — from a browser, with no shell.

It was built for a Quectel RM520N-GL on Ubuntu, driving a private 5G standalone
network. Other Quectel modems using the same AT and QMI interfaces will likely
work; nothing outside the modem layer is vendor-specific.

---

## 1. Install

On the UE machine (Ubuntu 22.04 or 24.04):

```bash
tar xzf tsn5g-ue-<version>.tar.gz
cd tsn5g-ue-<version>
sudo ./install.sh
```

The installer reports the URL when the UI is answering — it waits and verifies
rather than assuming. Open `http://<the-ue>:8080/`.

**It masks ModemManager.** Both it and this daemon want `/dev/ttyUSB*`; if both
run they fight, and ModemManager rewrites radio preferences underneath you.
Stopping it is not enough, D-Bus restarts it — masking is the only thing that
holds. Pass `--no-mask-mm` if you need it, and expect contention.

To remove: `sudo ./uninstall.sh` (add `--purge` to drop config and history too).

### Before your first connection

Two values in `/etc/tsn5g-ue/tsn5g-ue.yaml` must match your network:

| Field | What it is |
|---|---|
| `modem.dnn` | Your APN. A wrong APN is the most common reason a data call fails. |
| `vxlan.core_ip` | Your 5G core / UPF address. Also the default iperf server and the reachability probe target. |

Then `sudo systemctl restart tsn5g-ue`.

> **Restarting without a password prompt.** `systemctl` does not go through
> `sudo` — it asks polkit, which by default wants an administrator password
> typed into an authentication agent. A non-interactive shell or script has
> no agent, so the call hangs and then reports `Method call timed out`, which
> looks like a permission error but is not. Installing the rule shipped at
> `docs/tsn5g-ue.polkit.rules` lets the console user run plain
> `systemctl restart tsn5g-ue` with no `sudo` and no prompt. See that file's
> header for the one-line install and what it does and does not grant.

Everything else auto-detects. In particular **do not pin `modem.device`** — the
AT serial port number moves between boots (we have seen the same machine use
`ttyUSB2` and `ttyUSB3` on the same day). The daemon probes for it.

---

## 2. Getting connected

Five minutes, in this order. Each step tells you whether to continue.

### Step 1 — Modem

Open **Modem**. You want:

- **AT port** — a real device path. If blank, the modem is not enumerating;
  check USB and that it is in QMI mode.
- **Model** — e.g. `RM520N-GL`.
- **Radio** — `on`. If it is off or in airplane mode, turn it on here.

Press **Check** to read the SIM. `SIM: ready` means the card is present and
unlocked. Until you press Check, SIM shows **unknown** — that is honest, not a
failure: nothing has asked the card yet.

### Step 2 — Registration

Open **Registration**. This is where a UE that will not connect usually gets
stuck, and where the console gives you the most leverage.

**Serving cell** tells you whether you are camped. `Registered: yes` with a RAT
of `NR5G-SA` and an ARFCN means the radio side is done — go to step 3.

If you are not registered:

- **SA only** should be `yes` for a standalone network. The button sets
  `mode_pref=NR5G` with `nr5g_disable_mode=0`.
- **NR band mask** must include the band your network transmits on. If it is
  empty, nothing will camp — use **Repair bands** with your band number.
- **PLMN** — press **Select manually** with your network's MCC+MNC (e.g.
  `00102` for a private network) to pin it. **Automatic** lets the modem choose.
- **Scan cells** surveys what is on the air. It takes up to four minutes. Each
  result row has a **Lock** button.
- **Diagnose RF** runs a sequence of checks and reports what it found.

**Forbidden PLMNs** is worth knowing about: after repeated failures a network
lands on this list inside the SIM and is then refused *forever*, across
reboots, with no error that says so. If a network that used to work stopped,
look here first. (Some firmware refuses to report the list — the panel says so
rather than claiming it is empty.)

**Cell lock** pins the UE to one cell. The form is pre-filled from the cell you
are camped on. Use it to stop the UE roaming between cells during a
measurement. A wrong ARFCN or PCI here leaves the UE unable to camp at all
until you clear it.

> **One setting to leave alone.** `nr5g_disable_mode` must be `0`. On this
> firmware, `1` and `2` prevent SA camping entirely, and `1` additionally makes
> band-mask writes fail *silently*. The console refuses any other value and
> shows SA-only as a derived state rather than a number you can type.

### Step 3 — Connection

Open **Connection** and press **Bring up**.

Six steps run, and you watch them: pre-flight, prepare interface, start data
call, read assigned settings, apply address and routes, verify data plane. The
current step pulses; finished steps go green with the time they took.

When it succeeds the card shows **Connected** with your UE address. The
verify step tells you the truth about the data plane — if the core does not
answer it says so, rather than reporting success because an address was
assigned.

**If verify reports no answer:** the radio is fine (you are camped) but nothing
is coming back from the network. Usually the core or the gNB, not the UE.
Check `modem.dnn` matches your APN, and that your core is actually up.

### Step 4 — Prove it works

**Throughput** → **Run once**. Defaults to TCP uplink to your core.

Read the line under the form before you press it — it says which interface the
test will actually use. If it is red, the client and server cannot reach each
other and the test is refused immediately with the reason.

---

## 3. The views

### Dashboard
Throughput over five minutes, connection state, signal, latency to the core,
and health checks. The chart is time-based: a gap in the data draws as a gap,
so a dropped sample cannot masquerade as a slow one.

### Connection
The bearer: state, UE address, gateway, MTU, DNS, and the QMI handle.

**Bring up / Restart call / Take down.** Restarting changes the UE address —
the core assigns a new one each time — and any routing profile is re-applied
afterwards.

If it warns that no QMI handle is recorded, the call can only be *abandoned*,
not stopped: the interface gets flushed while the session stays alive inside
the modem. Restart the call to take ownership of it.

### Modem
Power and radio state, `CFUN` control, reset, ModemManager masking, AT port
probing, and the bus state. **Release AT port** hands the serial port back so
you can use your own tools against it without stopping the service.

### Registration
Covered above. Also: preferences (mode, bands, RAT order), operator selection,
cell lock, scan, camp-wait, diagnose, band repair.

### Signal
RSRP, RSRQ and SINR with history over 5 minutes to 24 hours, per-antenna
branch readings, and CSV export.

RSRP and SINR are shown separately and never averaged — a link can have "poor"
RSRP and "good" SINR and still perform well, which a single bar would hide.
Per-branch readings are worth a look: if only some antenna branches report a
value, that is usually a cabling problem.

### Interfaces
Every network interface, its addresses, and which one carries your management
route. Setting a static IP on that interface is gated behind typed confirmation
— it is the one that can strand you. The bearer interface is not editable here;
it belongs to Connection.

### Routing
Policy routing: send some traffic over 5G and the rest over wired, by port,
protocol or destination.

**Verify** runs `ip route get` three ways and shows the answers. Applying a
profile rolls itself back automatically if your management route moves.

Watch for the warning that a rule points at an **empty table**. That is the
failure that looks like success: the rules and marks are all present, the
lookup finds nothing, and the traffic quietly leaves over ethernet with nothing
erroring.

### Throughput
iperf3 against a server of your choosing.

- **Client** — which local address to send *from*. Defaults to the bearer, so a
  test measures 5G and not your ethernet. Change it to measure a different path.
- **Server** — where `iperf3 -s` is running.
- **Run once** / **Run all four legs** (TCP and UDP, both directions) /
  **Continuous loop**.

While a test runs you get the live rate, a progress bar and a moving chart,
driven by the interface's own byte counters. Results include RSRP and SINR
captured at run time, so a slow result can be correlated with the radio.

**Background traffic** fills the link so you can see what happens to something
else while it is busy — either continuous iperf3, or a rate-shaped UDP flow
that behaves like a camera stream (steady, rather than iperf3's bursts).
Remember to stop it before measuring anything else.

History is on disk in CSV, one row per leg, and survives reinstalls.

### Logs
The daemon log, live over a stream, with level filtering. Also the systemd
journal.

### Debug
A raw AT console with the diagnostic commands as buttons, a log of every AT
transaction with timings, and an inspector showing every API call the UI made —
which is how you can tell a panel showing data from a panel showing nothing.

Dangerous commands are refused with the reason. `AT+QPRTPARA=3` restores NV to
factory defaults and is blocked outright; commands that drop the link ask for
confirmation first.

### Diagnostics
One button that gathers controller state, modem, bearer, routing tables, recent
log and kernel state into a single snapshot you can copy into a bug report.

### Advanced
Only relevant if you are doing TSN work:

- **Transport** — the VXLAN overlay that carries layer-2 traffic over 5G.
- **TSN Switch** — 802.1Qbv gate schedules on an FS TSN3220. Preview the CLI
  before applying. The password is used for that action and never stored.
- **Time Sync** — gPTP (`ptp4l`). Needs a NIC with hardware timestamping and a
  grandmaster on the wire; the view tells you what it found.

---

## 4. When something is wrong

| Symptom | Where to look |
|---|---|
| No AT port, no model | **Modem**. USB enumeration or the modem is not in QMI mode. |
| Not registering | **Registration**. Band mask, SA-only, PLMN, forbidden list. |
| Registered but no data | **Connection**. Check the verify step. Usually APN or core. |
| Connected but nothing works | **Routing**. Look for a rule pointing at an empty table. |
| Throughput far too high | You measured ethernet. Check the **Client** address. |
| Test hangs then times out | The client and server cannot reach each other — the path line under the form says so before you run it. |
| Everything looks fine, still broken | **Diagnostics** → snapshot, and send it with your report. |

Useful from a shell:

```bash
systemctl status tsn5g-ue
journalctl -u tsn5g-ue -f
ip -br addr show wwan0
curl -s localhost:8080/api/health
```

---

## 5. Notes on safety

The console runs as root — it drives the modem, creates interfaces, and edits
routing. Some deliberate limits:

- **No default route over 5G** without explicitly enabling it in the config
  *and* confirming. It would route your own SSH session over the modem.
- **Firewall rules are removed individually**, by exact match, never with a
  chain flush. Flushing a chain on a shared machine is not this tool's business.
- **NAT uses MASQUERADE, not SNAT** — the UE address changes on every data call,
  so a pinned source address goes stale and traffic stops silently.
- **Config is never rewritten.** Changes made in the UI go to a separate
  overlay; your commented YAML is left alone. Each section shows where its
  value came from.

There is **no authentication** by default. Do not put port 8080 on an untrusted
network.

---

## 6. Feedback

Please include a **Diagnostics snapshot** — it carries the software version,
the modem and bearer state, routing, and the recent log, which is most of what
anyone needs to understand a report.

Also useful: what you expected, what happened, and whether the UI told you
anything about it. A panel that is wrong is a bug; a panel that is silent is
usually a worse one.
