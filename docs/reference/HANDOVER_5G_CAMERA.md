# Handover — FLIR camera streaming over 5G

**Date:** 2026-09-11
**Written on:** `amrc-DI-1200` (the UE side), for continuing the work on the core and the video server.

## One-paragraph status

**The pipeline is working.** A FLIR camera feeds `pathStream1`, which JPEG-compresses
213 Mbit/s of raw video down to ~21 Mbit/s and sends it as UDP to `10.5.0.219:50451`
over the 5G bearer. `ip_forward` has been enabled on the core, so frames now reach the
video server. What remains is the viewer setup in Part C, if not already done.

### Update log

- **2026-09-11 ~12:30** — pipeline built; frames reached the core but died there
  (`ip_forward = 0`).
- **2026-09-11 ~13:20** — gNB hit a UHD wedge (1660 PRACH pool depletions); a watchdog
  restarted `srsran-gnb.service` and the PDU session was lost. Open5GS itself never
  restarted. Bearer rebuilt with `connect.sh`; **UE address changed `10.45.0.3` →
  `10.45.0.4`**, requiring the A4/A5 rules to be rebuilt.
- **2026-09-11 ~13:40** — `ip_forward` enabled on the core; stream restored and running
  at 21.4 Mbit/s.

### Post-restart measurements

The gNB restart also improved the radio considerably:

| | Before | After |
|---|---|---|
| RSRP / RSRQ / SINR | −111 dBm / −12 dB / 6 dB | **−102 dBm / −10 dB / 14 dB** |
| TCP downlink | 78.5 Mbit/s | **142 Mbit/s** |
| TCP uplink | 27.5 Mbit/s | 28.9–56.4 Mbit/s (variable) |
| Ping to core | ~21–35 ms | **10.8 ms** |
| Stream rate | 13.2 Mbit/s | 21.4 Mbit/s |

**Retransmit finding:** the downlink retransmit rate stayed at ~67–71 per second across
both measurements, despite SINR improving 8 dB and throughput nearly doubling. Loss that
is constant *in time* rather than proportional to traffic is not SNR-driven — it
supports the gNB `Downlink data late` explanation over a coverage explanation.

---

## Addressing reference

| Element | Address | Notes |
|---|---|---|
| FLIR camera (Point Grey OUI `2c:dd:a3`) | `169.254.143.18` | GigE Vision, control port UDP 3956 |
| DI-1200 camera NIC `enp4s0` | `169.254.1.1/16` | 1000 Mb/s, MTU 1500 |
| DI-1200 LAN `enp3s0` | `10.5.4.111/21` | default route, via `10.5.0.2` |
| DI-1200 5G bearer `wwan0` | `10.45.0.4/32` *(current)* | MTU 1400 — **reassigned on every data call**; was `.2`, then `.3`, now `.4` |
| Core `amrctsnserver` `ogstun` | `10.45.0.1/16` | UE pool / bearer endpoint |
| Core `amrctsnserver` mgmt | `10.5.1.19/21` | `enp109s0f0np0` |
| Video server (laptop) | `10.5.0.219/21` | runs `pathView2` |
| Stream port | UDP **50451** | arrives as stream id **1001** in the viewer |

---

## PART A — What is already DONE on the DI-1200

Nothing here needs repeating unless the machine is rebooted or the bearer is restarted.
Recorded so it can be rebuilt.

### A1. 5G bearer (done)

```bash
sudo /home/amrc/camera_application/connect.sh
```

Camped NR5G-SA on n78, APN `usrptsn`, data call up. Ping to `10.45.0.1` 0% loss, ~21 ms.

### A2. Camera (done — no configuration was needed)

`enp4s0` already held `169.254.1.1/16`, which covers the camera's `169.254.143.18`.
Ping succeeds at 0.59 ms. No IP had to be assigned.

### A3. Host prerequisites (done)

```bash
sudo apt install -y libxcb-cursor0
sudo sysctl -w net.core.rmem_max=33554432     # 208 KB default drops GigE frames at capture
```

### A4. Policy routing — send ONLY the stream over 5G (done)

The viewer is on the LAN, so by default frames would take ethernet. A plain host route
would also divert the SSH session and kill the terminal. These rules move only UDP/50451:

```bash
sudo iptables -t mangle -A OUTPUT -p udp --dport 50451 -j MARK --set-mark 0x5
sudo ip rule add fwmark 0x5 table 5
sudo ip route replace default dev wwan0 table 5
```

The `ip rule` survives address changes; the `table 5` route does **not** if it was added
with a `src` — the kernel drops it when that address disappears. Added without `src`, as
above, it survives.

### A5. Source-address rewrite (done)

`pathStream1` binds its socket to the ethernet address (`nicid: 0`), and for a connected
UDP socket the kernel fixes the source at `connect()` time — before the mark is applied.
Without this the UPF drops the frames as spoofed:

```bash
sudo iptables -t nat -A POSTROUTING -o wwan0 -p udp --dport 50451 -j MASQUERADE
```

**Use `MASQUERADE`, not `SNAT --to-source <addr>`.** The UE address changes on every data
call, and a hardcoded SNAT silently breaks the stream after each bearer restart — this
cost three rebuild cycles on 2026-09-11 before being fixed properly. `MASQUERADE` reads
the interface's current address at runtime. For the same reason A4's route is added
**without** `src`, letting the kernel choose. With both changes the routing survives a
bearer restart and only `pathStream1` needs restarting.

Check there is exactly one rule (they accumulate):

```bash
sudo iptables -t nat -S POSTROUTING | grep 50451
```

### A6. Sender configuration (done)

`U5G/x11/pathStream1/config.json`:

```json
{
    "nicid": 0, "ipaddress": "10.5.0.219", "port": "50451",
    "frameRefreshRate":  100,
    "fifoMonitoringRate": 500
}
```

### A7. Running the sender (done)

`pathStream1` is **GUI-only** — no CLI, no autostart flag, and it will not run
`offscreen` because only the `xcb` Qt plugin is bundled. Acquisition must be started by
hand in the window. A screen is now attached to the DI-1200.

```bash
cd /home/amrc/camera_application/U5G/x11/pathStream1
export XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.MF0HV3   # filename changes per session
export DISPLAY=:0
./run.sh
```

Alternatively, to drive the window from a remote machine: `ssh -X amrc@10.5.4.111`.

### A8. Verified on this side

| Check | Result |
|---|---|
| Camera → `enp4s0` | 212.9 Mbit/s raw |
| JPEG out → `wwan0` | **13.2 Mbit/s** (~16:1 compression) |
| Leaking onto `enp3s0` | ~0 (background SSH only) |
| Arriving at core `ogstun` | 12.13 Mbit/s, ~1992 pps *(measured on the core)* |
| Datagram size | avg 761 bytes — **no fragmentation**, well under the 1400 MTU |
| Uplink headroom | 13.2 of 25–46 Mbit/s measured ceiling |

---

## PART B — What to do on the CORE (`amrctsnserver`)

### B1. The blocker, and the decision it requires

`net.ipv4.ip_forward = 0`, and it is commented out in `/etc/sysctl.conf`, so forwarding
has never been enabled on this machine. Frames arrive on `ogstun` and the kernel
discards them. No NAT rule can help while this is 0 — POSTROUTING is never reached for
forwarded packets.

> **This is a network-posture change, not a config tweak.** Enabling it turns the core
> into a router between the 5G UE pool and the management LAN: anything on the UE
> network can then reach `10.5.x`. That is a decision for whoever owns the lab network.

**Option 1 — enable forwarding** (keeps the viewer on the laptop):

```bash
sudo sysctl -w net.ipv4.ip_forward=1
sudo iptables -t nat -A POSTROUTING -s 10.45.0.0/16 -o enp109s0f0np0 -j MASQUERADE
```

The MASQUERADE matters even for one-way UDP: without it the laptop receives packets
sourced from `10.45.0.3`, an address its subnet knows nothing about, which a host
firewall or reverse-path check may drop. With it the source becomes `10.5.1.19` — on
the laptop's own subnet.

To make it permanent, uncomment `net.ipv4.ip_forward=1` in `/etc/sysctl.conf`. To
revert: `sudo sysctl -w net.ipv4.ip_forward=0` and delete the NAT rule with `-D`.

**Option 2 — avoid the change entirely.** Run `pathView2` on the core itself and set
`"ipaddress": "10.45.0.1"` in `pathStream1/config.json`. Frames terminate on the core,
so no forwarding, no NAT, no posture change — and the traffic still crosses
UE → gNB → UPF, so it remains a valid 5G test. The only cost is watching the video on
the core's screen rather than the laptop.

### B2. Already checked — do not re-investigate

- `10.5.0.219` is **on-link** on `enp109s0f0np0` (`10.5.1.19/21` covers `10.5.0.0`–`10.5.7.255`). No extra route needed, just ARP.
- `rp_filter` is 2 (loose) everywhere, and the reverse route to `10.45.0.3` goes via `ogstun` anyway. It will not interfere.
- Frames **are** arriving on `ogstun` at full rate, so the SNAT in A5 is working correctly.

---

## PART C — What to do on the VIDEO SERVER (laptop, `10.5.0.219`)

The zip is already on this machine.

### C1. Extract

```bash
unzip x11.zip
cd x11
tar -xzf pathView2.tar.gz     # if pathView2/ is not already a folder
```

### C2. Install the one missing package

```bash
sudo apt install -y libxcb-cursor0
```

Required by the Qt xcb plugin from Qt 6.5 onward; Ubuntu 24.04 does not ship it.

### C3. Fix the shipped viewer — it will NOT start as-is

Two separate faults, both confirmed by inspection:

**Fault 1 — missing `.so.6` symlinks.** `lib/` ships `libQt6Core.so.6.11.2` etc., but
the binary asks for `libQt6Core.so.6`, `libQt6Gui.so.6`, `libQt6Widgets.so.6`:

```bash
cd pathView2/lib
for f in libQt6*.so.6.*.*; do ln -sf "$f" "${f%.*.*}"; done
ls -l libQt6Core.so.6          # must now be a symlink
cd ..
```

**Fault 2 — `run.sh` never sets `LD_LIBRARY_PATH`,** so the loader never looks in
`lib/`. Add this line to `pathView2/run.sh` immediately before the final `exec`:

```bash
export LD_LIBRARY_PATH="$appDir/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

Verify both fixes took:

```bash
LD_LIBRARY_PATH=./lib ldd bin/pathView2 | grep "not found"    # must print nothing
```

`libturbojpeg.so.0` is bundled. `libGLX.so.0` and `libOpenGL.so.0` come from the system
(`libglvnd0`) and are present on any normal desktop.

### C4. Open the firewall — UDP, not TCP

```bash
sudo ufw allow 50451:50457/udp
```

### C5. Run it

```bash
cd pathView2 && ./run.sh
```

A window opens. Frames sent to port 50451 appear as **stream 1001**. The viewer alone
shows no video — it is only a receiver.

---

## PART D — Verification

**On the laptop**, confirm frames are arriving before blaming the application:

```bash
sudo tcpdump -ni any udp port 50451 -c 20
```

If Option 1 (forwarding) was used, the source will be `10.5.1.19`. If packets appear
here but the window stays black, the problem is the viewer; if nothing appears, the
problem is upstream.

**On the core**, confirm forwarding is now working:

```bash
sudo tcpdump -ni ogstun -c 20 udp port 50451              # frames in
sudo tcpdump -ni enp109s0f0np0 -c 20 udp port 50451       # frames out — this was empty before
```

**On the DI-1200**, confirm the stream is still on the bearer and not on ethernet:

```bash
cat /sys/class/net/wwan0/statistics/tx_bytes    # sample twice, ~10 s apart
cat /sys/class/net/enp3s0/statistics/tx_bytes   # should stay near-flat
```

---

## PART E — Gotchas

- **UDP is silent on failure.** The sender reports nothing when frames are discarded.
  A running sender is never evidence of delivery. This is what hid the `ip_forward`
  problem for so long.
- **The UE address changes on every data call.** It was `10.45.0.2` on 2026-09-08 and
  `10.45.0.3` on 2026-09-11. Both A4 and A5 hardcode it, so after any `connect.sh` run:
  re-read `ip -4 -o addr show wwan0` and rebuild those two rules.
- **Never add a plain host route for `10.5.0.219` via `wwan0`.** It diverts the SSH
  session and drops the terminal. Use the fwmark approach in A4.
- **The gNB has a real-time problem.** ~1.35 RF underflows/sec baseline, plus bursts of
  16–40 `Downlink data late` events per minute. There is **no uplink equivalent** — this
  stream is uplink, so it is unaffected. It does hurt anything measured downlink.
- **Coverage is weak:** RSRP −111 dBm, RSRQ −12 dB, SINR 6 dB. This caps throughput in
  both directions regardless of anything else.
- **Bandwidth headroom:** 13.2 Mbit/s used of a 25–46 Mbit/s uplink. If frames are
  dropped, raise `frameRefreshRate` (slower) or lower camera resolution before
  suspecting the network.
- **`ModemManager` is masked** so it cannot fight for the modem. Undo when finished:
  `sudo systemctl unmask ModemManager`.

## PART F — Related files on the DI-1200

| File | Purpose |
|---|---|
| `CAMERA_5G_PLAN.md` | the fuller plan this handover condenses |
| `connect.sh` | end-to-end 5G bring-up |
| `iperf5g.sh` | constant TCP/UDP link measurement (`MODE=tcp\|udp\|both`) |
| `iperf_logs/*/summary.csv` | 137 legs of TCP stability data, not yet analysed |
| `diag.sh`, `at.py` | modem diagnostics (need root) |
