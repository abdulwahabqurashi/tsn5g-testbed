# Streaming the FLIR camera over 5G to the viewer laptop

## Context

Capture frames from the FLIR camera on the DI-1200, JPEG-compress them with
`pathStream1`, and send them over the **5G bearer** to `pathView2` running on the
laptop at `10.5.0.219`. The point of the exercise is that the frames traverse
UE → gNB → UPF, not the office ethernet.

### Topology and what is already true

| Element | Address | State |
|---|---|---|
| FLIR camera (Point Grey OUI `2c:dd:a3`) | `169.254.143.18` | **reachable**, 0.59 ms on `enp4s0` |
| DI-1200 camera NIC `enp4s0` | `169.254.1.1/16` | up, 1000 Mb/s, MTU 1500 |
| DI-1200 5G bearer `wwan0` | `10.45.0.3/32` | up, MTU 1400, ~25–46 Mbps uplink |
| Core `amrctsnserver` `ogstun` | `10.45.0.1/16` | up |
| Viewer laptop | `10.5.0.219/21` | on the core's LAN, reachable over ethernet |

No camera addressing work is needed. `169.254.1.1/16` already covers
`169.254.143.18`, ping succeeds, and the GigE Vision control port (UDP 3956) answers.

### The routing problem

`10.5.0.219` sits inside `10.5.0.0/21`, which is directly connected on `enp3s0`.
Left alone, every frame leaves over ethernet and the 5G link is not exercised at all.

**Do not fix this with a host route.** `ip route add 10.5.0.219/32 dev wwan0` would
also divert the SSH session you are working from — the terminal dies mid-command.
Instead, mark only the stream's UDP packets and policy-route those, leaving every
other flow on its existing path.

### One piece of good news

The stream runs **uplink** (UE → core). Uplink is the clean direction on this testbed:
the gNB logs zero uplink-late events, and our iperf uplink showed 91–281 retransmits
against 2015 on downlink. The `Downlink data late` problem does not touch this traffic.

---

## Step 1 — Host prerequisites (needs root; you run these)

```bash
# Qt xcb plugin dependency, per the vendor guide
sudo apt install -y libxcb-cursor0

# GigE Vision needs far bigger socket buffers than the 208 KB default,
# or frames are dropped at capture before they ever reach the network
sudo sysctl -w net.core.rmem_max=33554432
sudo sysctl -w net.core.rmem_default=33554432
```

To make the buffer change survive a reboot, add to `/etc/sysctl.d/99-gige.conf`:

```
net.core.rmem_max = 33554432
net.core.rmem_default = 33554432
```

## Step 2 — Force only the stream over 5G (needs root; you run these)

```bash
# mark UDP destined for the stream port
sudo iptables -t mangle -A OUTPUT -p udp --dport 50451 -j MARK --set-mark 0x5

# send marked packets out the bearer, with the bearer's source address
sudo ip rule add fwmark 0x5 table 5
sudo ip route add default dev wwan0 src 10.45.0.3 table 5
```

Verify it applies to the stream and *not* to SSH:

```bash
ip route get 10.5.0.219 mark 0x5     # expect: dev wwan0 src 10.45.0.3
ip route get 10.5.0.219              # expect: dev enp3s0 src 10.5.4.111
```

The second line is the safety check — if it says `wwan0`, stop, because the SSH
session is about to drop.

**To undo** (also note `10.45.0.3` changes on every data call, so these rules must be
rebuilt after any `connect.sh` run):

```bash
sudo ip route flush table 5
sudo ip rule del fwmark 0x5 table 5
sudo iptables -t mangle -D OUTPUT -p udp --dport 50451 -j MARK --set-mark 0x5
```

## Step 3 — Core-side forwarding (check on `amrctsnserver`)

Frames arrive at the UPF with source `10.45.0.3` and destination `10.5.0.219`, so the
core must forward between `ogstun` and its management NIC:

```bash
sysctl net.ipv4.ip_forward                    # must be 1
sudo iptables -t nat -L POSTROUTING -n -v | grep 10.45    # Open5GS installs a MASQUERADE rule
```

**Confirmed 2026-09-11: this was the blocker.** `net.ipv4.ip_forward` was **0** on
`amrctsnserver` (and commented out in `/etc/sysctl.conf`, so never enabled). Frames
arrived on `ogstun` at 12.13 Mbit/s and the kernel discarded every one — the sender
reported nothing, because UDP never does. Do not assume a stock Open5GS install has
forwarding on.

The fix is a genuine change to the lab's network posture — it makes the core a router
between the 5G UE pool and the management LAN — so it is the user's decision, not a
config tweak to apply silently:

```bash
sudo sysctl -w net.ipv4.ip_forward=1
sudo iptables -t nat -A POSTROUTING -s 10.45.0.0/16 -o enp109s0f0np0 -j MASQUERADE
```

The MASQUERADE matters even for a one-way UDP stream: without it the laptop receives
packets sourced from `10.45.0.3`, an address its subnet knows nothing about, which a
host firewall or reverse-path check may discard. With it, the source becomes
`10.5.1.19` — on the laptop's own subnet.

## Step 4 — Point the sender at the viewer

Edit `U5G/x11/pathStream1/config.json`:

```json
{
    "nicid": 0, "ipaddress": "10.5.0.219", "port": "50451",
    "frameRefreshRate":  100,
    "fifoMonitoringRate": 500
}
```

`nicid` is "which interface to send from" and its numbering is undocumented. If frames
do not arrive, that is the first thing to vary — see Verification below for how to tell
which interface it actually chose.

## Step 5 — Run the sender headless

**`offscreen` does not work** — the bundled Qt ships only the `xcb` plugin, so the app
aborts without a real X display. It is also GUI-only: it cannot even print `--help`
headless, and has no CLI or autostart switch. Acquisition must be started by hand in
the window.

An autologin GNOME (Wayland) session is running as `amrc`, so XWayland is available:

```bash
cd /home/amrc/camera_application/U5G/x11/pathStream1
export XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.MF0HV3
export DISPLAY=:0
./run.sh
```

That launches it on the machine's **physical** screen. To drive it from the laptop
instead, reconnect with X forwarding — the window then renders on the laptop while the
data still flows from the DI-1200:

```bash
ssh -X amrc@10.5.4.111
cd /home/amrc/camera_application/U5G/x11/pathStream1 && ./run.sh
```

The Xwayland auth filename is regenerated per session — re-read it from
`/run/user/1000/` after a reboot.

## Step 6 — Viewer runbook (on the laptop, `10.5.0.219`)

The shipped `pathView2` is broken as-is — `ldd` reports `libQt6Core.so.6`,
`libQt6Gui.so.6` and `libQt6Widgets.so.6` missing, because `lib/` ships only
`libQt6Core.so.6.11.2`-style files with no `.so.6` symlinks, and `run.sh` never sets
`LD_LIBRARY_PATH`.

```bash
# 1. copy the viewer across (from the DI-1200)
scp -r amrc@10.5.4.111:/home/amrc/camera_application/U5G/x11/pathView2 ~/

# 2. dependency
sudo apt install -y libxcb-cursor0

# 3. create the missing .so.N symlinks
cd ~/pathView2/lib
for f in *.so.*.*.*; do ln -sf "$f" "${f%.*.*}"; done
ls -l libQt6Core.so.6          # should now be a symlink

# 4. make run.sh find them — add this line before the final exec
#    export LD_LIBRARY_PATH="$appDir/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# 5. open the firewall (UDP, not TCP)
sudo ufw allow 50451:50457/udp

# 6. run it
cd ~/pathView2 && ./run.sh
```

Frames sent to port 50451 arrive as **stream 1001** in the viewer.

## Verification

1. **Camera** — `ping -c3 -I enp4s0 169.254.143.18` succeeds *(already confirmed)*.
2. **Path selection** — with the sender running, confirm frames are on the bearer and
   not on ethernet:
   ```bash
   sudo tcpdump -ni wwan0 udp port 50451 -c 20     # expect packets here
   sudo tcpdump -ni enp3s0 udp port 50451 -c 20    # expect NOTHING here
   ```
   This is the test that actually proves the exercise worked. Everything else can look
   healthy while the traffic quietly uses ethernet.
3. **Arrival** — on the laptop: `sudo tcpdump -ni any udp port 50451`.
4. **Picture** — the viewer window shows video on stream 1001.
5. **Load** — `iperf5g.sh` is still running and will contend with the stream for uplink.
   Stop it before judging video quality.

## Risks and open questions

- **MTU.** `wwan0` is 1400, the camera NIC is 1500. If `pathStream1` emits datagrams
  larger than 1400 they fragment, and losing one fragment loses the whole frame. Not
  controllable from `config.json`; if frames arrive torn, this is the first suspect.
  `tcpdump` on `wwan0` will show the datagram sizes.
- **Bandwidth.** Uplink measured 25–46 Mbps. At `frameRefreshRate: 100` (10 fps) that
  allows roughly 300–500 KB per frame. A full-resolution JPEG may exceed it — if so,
  raise `frameRefreshRate` (slower) or reduce camera resolution/quality.
- **Weak coverage.** RSRP −111 dBm, SINR 6 dB. Video quality will reflect that, and it
  caps both directions independently of the gNB host-jitter issue.
- **UDP is silent on failure.** The sender transmits into the void with no error if
  nothing is listening, so never treat "the sender is running" as evidence of delivery.
- **Address churn.** Every `connect.sh` run assigns a new UE address, invalidating the
  `src 10.45.0.3` in Step 2. Re-check after any bearer restart.
