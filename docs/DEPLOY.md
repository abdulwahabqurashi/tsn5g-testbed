# Deploying the testbed on new hardware

This builds the whole testbed (5G core and gNB, video viewer, and the UE with
its two cameras) on new machines, from this repository alone. Three install
commands, one per role. Everything that differs between sites lives in
`site.env`.

```
 ┌───────────── UE (DI-1200 class PC) ─────────────┐          ┌──────────────── core server ─────────────────┐
 │ camera 1 ─ CAM1_IF   encoder 1 ─┐               │   5G NR   │ srsRAN gNB ── X410_HOST_IF ══ USRP X410      │
 │ camera 2 ─ CAM2_IF   encoder 2 ─┤ (netns)       │ ~~~~~~~~~ │   │ NGAP/GTP-U (loopback)                    │
 │                      tsn5g-ue daemon + web UI ──┤ RM520N    │ Open5GS (12 NFs) ── ogstun CORE_BEARER_IP    │
 │ PTP_IF ── TSN switch / grandmaster              │ modem     │ viewer (pathView2) on screen :99, VNC        │
 └───────── UE_LAN_IP ─────────────────────────────┘           └───────── CORE_LAN_IP ────────────────────────┘
```

Order: **core → viewer → UE**. The UE needs a core to attach to, and the
cameras need a viewer to send to.

---

## 0. What you need

| Item | First rig | Notes |
|---|---|---|
| Core server | 4-socket x86, 112 cores, Ubuntu 24.04 | Real-time capable. The gNB uses 16 isolated cores on the X410 NIC's NUMA node |
| SDR | Ettus USRP X410, 10G DAC to the core | X410 at `192.168.10.2` (its default), FPGA image matching UHD 4.6 |
| UE PC | Advantech DI-1200, Ubuntu 24.04 | Three spare NICs: camera 1, camera 2, PTP |
| Modem | Quectel RM520N-GL (USB, QMI mode) | Test SIM programmed with your PLMN, K, OPc |
| Cameras | 2 × FLIR Blackfly S (GigE Vision) | Static link-local addresses (`CAM*_IP`) |
| Vendor bundles | `pathStream1.tar.gz`, `pathView2.tar.gz` | Not in git, see `video/README.md`; hashes in `video/MANIFEST` |
| Optional | TSN switch + PTP grandmaster | For PTP on the UE (`PTP_IF`, `PTP_VLAN`) |

Both machines: Ubuntu **24.04** server/desktop, a sudo-capable login user
(`CORE_USER` / `UE_USER`), internet access during install (apt, GitHub, npm).

## 1. Fill in site.env (once, then copy it to both machines)

```bash
git clone git@github.com:<you>/tsn5g-testbed.git && cd tsn5g-testbed
cp site.env.example site.env
nano site.env
```

Every line is commented. The values that are always different on new
hardware:

| What | Variables | How to find it |
|---|---|---|
| Users | `CORE_USER`, `UE_USER`, `VIEWER_USER` | `whoami` on each machine |
| Addresses | `CORE_LAN_IP`, `CORE_LAN_IF`, `CORE_LAN_GW`, `UE_LAN_IP` | `ip -br addr`, `ip route` |
| X410 NIC | `X410_HOST_IF`, `GNB_NUMA_NODE` | `sudo core/scripts/x410-find-nic.sh` (shows link, speed, NUMA node) |
| gNB CPUs | `GNB_RU_CPUS`, `GNB_MAIN_CPUS`, `GNB_ISOLATED_CPUS` | see §2.1 |
| UE NICs | `CAM1_IF`, `CAM2_IF`, `PTP_IF`, `MODEM_WWAN` | `ip -br link`; the modem shows up as `wwan0` |
| Cameras | `CAM1_SERIAL`, `CAM2_SERIAL` | label on the camera |
| SIM | `UE_IMSI` here; K and OPc in `secrets.env` | SIM programming record |

The radio (ARFCN, band, bandwidth, gains), PLMN, DNN, UE pool, GBR settings
and ports can stay as they are unless your licence or network needs
otherwise.

The SIM keys go in a second file, used only on the core:

```bash
cp secrets.env.example secrets.env && chmod 600 secrets.env && nano secrets.env
```

`site.env` and `secrets.env` are git-ignored. Copy them to the other machine
with `scp`, not through GitHub.

## 2. Core server

### 2.1 Real-time tuning (once, needs a reboot)

The gNB must meet a slot deadline every 0.5 ms. On the first rig, an untuned
kernel caused RF underflows and "Downlink data late" bursts, and the X410
stream wedged occasionally.

1. **BIOS:** disable C-states deeper than C1, disable turbo/SpeedStep (or set
   the performance profile), disable SMT if you can spare the cores.
2. **Pick the cores.** All on the X410 NIC's NUMA node (`GNB_NUMA_NODE`), one
   per physical core:
   ```bash
   lscpu -e=CPU,NODE,CORE | awk -v n=1 '$2==n'      # CPUs on node 1
   ```
   4 for the radio (`GNB_RU_CPUS`), 12 for the PHY pool (`GNB_MAIN_CPUS`),
   and `GNB_ISOLATED_CPUS` = both lists together.
3. **Apply and reboot:**
   ```bash
   sudo core/scripts/rt-grub.sh     # writes the 5 kernel parameters, verifies grub.cfg
   sudo reboot
   sudo /opt/tsn5g/core/scripts/post_reboot_check.sh    # after install; or check:
   cat /sys/devices/system/cpu/isolated                  # = GNB_ISOLATED_CPUS
   ```

### 2.2 X410 link

Cable the X410's QSFP port to the 10G NIC with a DAC. The installer sets the
NIC's MTU to `X410_MTU` (9000; UHD needs jumbo frames) and gives it
`X410_HOST_IP` (the same /24 as the X410). Check:

```bash
ping -c3 192.168.10.2 && uhd_find_devices --args addr=192.168.10.2
```

### 2.3 Install

```bash
./install.sh core --dry-run      # read what it will do; rendered files in ./rendered/
sudo ./install.sh core           # 30-60 min the first time (srsRAN build)
```

It installs packages (UHD, MongoDB 7, Node 20), builds srsRAN at the pinned
commit plus our patch, builds the Open5GS fork, renders every config into
`/etc/tsn5g/`, creates the subscriber in MongoDB, and starts everything in
order: networking, then the 12 Open5GS NFs, then the WebUI, then the gNB.
From then on all of it starts at boot.

### 2.4 Check

```bash
/opt/tsn5g/core/scripts/open5gs-ctl.sh status     # everything "active"
sleep 120; /opt/tsn5g/core/scripts/tsn_health.sh  # all PASS (needs 2 min of gNB log)
```

The WebUI is at `http://<CORE_LAN_IP>:9999`. Change its default admin
password at first login.

## 3. Viewer (normally on the core)

```bash
sudo mkdir -p /srv/tsn5g-vendor && sudo cp pathView2.tar.gz /srv/tsn5g-vendor/
sudo ./install.sh viewer
```

Watch it from your PC through an SSH tunnel (x11vnc listens on localhost
only):

```bash
ssh -L 5902:localhost:5900 <VIEWER_USER>@<CORE_LAN_IP>      # then VNC viewer -> localhost:5902
```

## 4. UE

### 4.1 Hardware

- Modem in **QMI** mode (`AT+QCFG="usbnet"` → 0), SIM inserted.
- Camera 1 on `CAM1_IF`, camera 2 on `CAM2_IF`, each directly cabled. Their
  static IPs (`CAM*_IP`) must be in the host-side /24 (`CAM*_HOST_ADDR`).
  Set them with SpinView once.
- PTP NIC (`PTP_IF`, an Intel I210 or similar with a hardware clock) to the
  TSN switch, if you use PTP.

**Camera settings (once per camera, encoders stopped):** fix the frame rate,
so the uplink load does not follow the light (without it the rate tracks
auto-exposure, anywhere from ~18 to 66 fps), and give each camera a fixed
address with a /24 mask matching its NIC, so the camera SDK never moves it:
```bash
sudo python3 tools/camera-framerate.py --iface <CAM1_IF> --fps 20 --save
sudo python3 tools/gige-discover.py --iface <CAM1_IF> --set-persistent <CAM1_IP> --serial <CAM1_SERIAL>
# camera 2: the same, inside its namespace once install.sh ue has created it:
sudo ip netns exec cam2 python3 tools/camera-framerate.py --iface <CAM2_IF> --fps 20 --save
sudo ip netns exec cam2 python3 tools/gige-discover.py --iface <CAM2_IF> --set-persistent <CAM2_IP> --serial <CAM2_SERIAL>
```

### 4.2 Install

```bash
scp <core>:tsn5g-testbed/site.env .                     # the same site.env
sudo mkdir -p /srv/tsn5g-vendor && sudo cp pathStream1.tar.gz /srv/tsn5g-vendor/
./install.sh ue --dry-run
sudo ./install.sh ue
```

It masks ModemManager, tells NetworkManager to leave the camera NICs alone,
puts the code in `/opt/tsn5g`, and renders the daemon config. It installs
four units:
- `tsn5g-cam2-netns`: camera 2 gets its own network namespace;
- `tsn5g-ue`: the daemon and web UI;
- `tsn5g-vnc-display`: the virtual screen;
- `tsn5g-cameras`: both encoders, with Start pressed for you.

### 4.3 First connection

1. Web UI `http://<UE_LAN_IP>:8080`. Open **Modem** and check that the SIM
   and signal are seen.
2. **Connection → Bring up.** The modem attaches (SA, band n78) and the data
   call comes up with `UE_IP`.
3. Check the cameras end to end:
   ```bash
   /opt/tsn5g/tools/camera-loss-check.sh 30         # both cameras ~0 % loss
   ```
4. The demo (about 15 minutes; it floods the uplink with the policy off and
   on):
   ```bash
   /opt/tsn5g/tools/demo-run.sh                     # needs: ssh-copy-id <CORE_USER>@<CORE_LAN_IP>
   ```
   Expected: camera 1 keeps about 100 % of its frames with the policy on,
   against about 80 % off. Camera 2 (best effort) gives way.

## 5. When something is wrong

| Symptom | Look at | Usual cause |
|---|---|---|
| Modem never camps (`+QENG ... SEARCH`) | `tools/modem/at.py 'AT+QNWPREFCFG="nr5g_disable_mode"'` | must be **0** on RM520N firmware (LESSONS.md) |
| UE attaches, no data call | `journalctl -u open5gs@smf`, the WebUI subscriber | DNN or IMSI mismatch, keys wrong in secrets.env |
| Throughput ~940 Mbit/s | the test target | you tested over the LAN; the 5G path is `CORE_BEARER_IP` |
| Uplink camera loss | `grep 'Scheduler UE' /var/log/tsn5g/gnb.log` (set `metrics.enable_log: true` briefly) | PUSCH BLER: link adaptation (already tuned in gnb.yaml.in), or weak signal |
| gNB restarts repeatedly | `journalctl -u srsran-gnb`, `ping 192.168.10.2` | X410 unreachable, MTU not 9000, wrong `X410_HOST_IF` |
| Many "Downlink data late" | `/sys/devices/system/cpu/isolated` | RT tuning not applied (§2.1) |
| Camera 2 not streaming | `sudo ip netns exec cam2 ping <core>`, `systemctl status tsn5g-cam2-netns` | NIC name changed, namespace missing |
| Encoders up but nothing in the viewer | `ss -ulpn` on the core, VNC on both | Start not pressed, viewer not running, wrong `CORE_BEARER_IP` in camera json |
| `systemctl` hangs ~25 s from the UI | polkit rule installed? | `install.sh ue` installs it |

During an experiment you can pause the core's auto-repair (it checks every 5
minutes and may restart things): `sudo touch /etc/tsn5g/health.pause`.
Remove the file afterwards.

## 6. Changing something later

Edit `site.env` (or a template), commit, pull on the machine, and run the
same install command again. It converges: it re-renders configs, keeps a
`.bak-<date>` of the daemon and gNB configs it replaces, and restarts what
changed. `SKIP_BUILD=1 sudo ./install.sh core` skips the rebuild when only
configs changed. Each commit's entry in `docs/CHANGES.md` says how to deploy
and verify it.

## 7. Moving the first rig onto this layout

The first rig still runs from `~/camera_application/tsn5g-ue-app` (UE) and
`~/tsntestbed` (core). Switching each machine over is one install command,
but it restarts services, so do it in a quiet window:

- **Core:** `sudo ./install.sh core`. Before it starts the systemd units, it
  stops the NFs that run5gs.sh started by hand. The UE drops for about a
  minute.
- **Viewer:** close the hand-started pathView2, then `sudo ./install.sh viewer`.
- **UE:** `sudo ./install.sh ue --start-cameras`. The daemon restarts (the
  data call survives) and the encoders are relaunched under systemd.

The old directories can stay as they are until you are happy, then be
archived.
