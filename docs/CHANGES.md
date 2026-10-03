# Changes

One section per commit, newest first. Each says **what** changed, **why**,
**how to deploy** it on a running site, **how to verify** it, and **how to roll
back**. Commit hashes are filled in as `git log --oneline` shows them.

---

## 8 — `install.sh viewer`: the video viewer as a service

**What**
- `lib/install-viewer.sh`, five steps:
  1. packages: Xvfb, x11vnc, openbox, and the Qt/xcb runtime libraries the
     vendor bundles need (worked out from the bundles' `ldd` output; also
     added to the UE install)
  2. `pathView2.tar.gz` from `VENDOR_DIR`, sha256-checked, unpacked to
     `$PREFIX/video/viewer/`; `config.json` generated with seven streams from
     `VIEWER_PORT_FIRST` (the same content as the first rig's)
  3. sysctl: 8 MB default UDP receive buffer
  4. `tsn5g-viewer-display.service` (the virtual screen, the same
     `vnc-display.sh` as the UE) and `tsn5g-viewer.service` (the viewer on it,
     restarted if it exits)
  5. enable and start. A viewer that was started by hand is left running.
- site.env: `VIEWER_USER`.

**Why** — on the first rig the core's screen and viewer were started by hand
after every reboot (`~/vnc-display.sh up`, then `cd ~/pathView2 &&
./bin/pathView2`). If nobody did it, the demo had no receiver.

**Deploy**
```bash
sudo mkdir -p /srv/tsn5g-vendor && sudo cp pathView2.tar.gz /srv/tsn5g-vendor/
sudo ./install.sh viewer
```
On the first rig, close the hand-started viewer first (or it is left alone),
then `sudo systemctl start tsn5g-viewer`.

**Verify**
```bash
systemctl is-active tsn5g-viewer-display tsn5g-viewer
ss -ulpn | grep pathView2              # listening on 50451..50457
# from your PC: ssh -L 5902:localhost:5900 <VIEWER_USER>@<core>  -> VNC localhost:5902
```

**Roll back** — `sudo ./install.sh viewer --remove`; start the viewer by hand
as before.

---

## 7 — `install.sh core`: build and run the core and gNB from pinned sources

**What**
- `core/open5gs/src/` — the TSN/5G-ACIA Open5GS fork. On the first rig it
  existed only as a zip plus an unpacked tree. Compared with the zip, the C
  code is unchanged. Local work was in the WebUI (a new **gNB QoS** page:
  `webui/server/routes/gnb-qos.js`, `webui/src/components/GnbQos`,
  `webui/src/containers/GnbQos`, plus routing and sidebar edits) and in the
  config templates. Left out:
  - build output, `node_modules`, `.next`
  - `.bak` files
  - the 3GPP specification PDFs (`3gpp-tsn-docs/`)
  - meson's downloaded subprojects (re-fetched at their pinned `.wrap`
    revisions)
  - `webui/.env`, which holds the WebUI's session secrets; it is regenerated
    on first start.

  The `*.key` files under `src/configs/open5gs/{hnet,tls}` are upstream's
  published test keys, identical to the zip. Nothing uses them: the rendered
  UDM config points at per-site keys that `install.sh core` generates.
- `core/srsran/0001-…patch` — the GBR-on-Modify fix that was an unpushed
  local commit (`078c938` on `4bf1543`). Without it the GBR flow never got its
  guaranteed rate and every DRB looked identical to the modem's LCP.
- `core/build.sh [all|deps|srsran|open5gs|webui]`:
  - deps: Ubuntu packages, UHD 4.6 from the archive, MongoDB 7.0 and Node.js
    20 from their own repositories (the same sources the first rig used);
  - srsRAN: cloned at `SRSRAN_COMMIT`, patched, Release build with
    `-march=native`;
  - Open5GS: meson **debug** buildtype, as the first rig ran it;
  - WebUI: `npm install`.
  Each step skips work that is already done.
- `lib/install-core.sh`, nine steps:
  1. preflight: NICs present, RT CPU isolation active, NFs started outside
     systemd
  2. code to `$PREFIX`
  3. build
  4. configs to `/etc/tsn5g` and per-site UDM hnet keys
  5. sysctl and logrotate
  6. units
  7. enable at boot
  8. start, in order: core, then subscriber, then gNB
  9. checks: 12 NFs, NRF, NGAP

  `SKIP_BUILD=1` re-renders configs without rebuilding.

**Why** — rebuilding the first rig's core by hand meant knowing which zip,
which srsRAN commit plus which uncommitted patch, which build options, and
which apt repositories. Now that knowledge is in one script.

**Deploy** — on a new core (Ubuntu 24.04, X410 cabled, see DEPLOY.md):
```bash
cp site.env.example site.env && nano site.env
cp secrets.env.example secrets.env && chmod 600 secrets.env && nano secrets.env
sudo core/scripts/rt-grub.sh && sudo reboot        # once: real-time kernel parameters
sudo ./install.sh core                             # ~30-60 min, mostly the srsRAN build
```

**Verify**
```bash
/opt/tsn5g/core/scripts/open5gs-ctl.sh status       # 12 NFs, webui, gnb active
sleep 120; /opt/tsn5g/core/scripts/tsn_health.sh    # all PASS
```

**Roll back** — `sudo systemctl disable --now open5gs.target open5gs-webui
srsran-gnb tsn5g-core-net tsn-health.timer`. The build tree is in
`$PREFIX/build` and can simply be deleted.

---

## 6 — Core scripts and systemd units: the core starts at boot, NAT persists

**What**
- **Open5GS under systemd.** `open5gs@.service` (one instance per NF) and
  `open5gs.target` (all 12). Each NF restarts if it dies. Configs come from
  `/etc/tsn5g/open5gs/`. `open5gs-webui.service` runs the WebUI as `CORE_USER`.
  `core/scripts/open5gs-ctl.sh status|start|stop|restart|logs` replaces
  run5gs.sh for daily use.
- **`tsn5g-core-net.service`** (`core-net.sh up`): ogstun with
  `CORE_BEARER_IP`, ogstap, `ip_forward`, MASQUERADE for `UE_POOL` out of
  `CORE_LAN_IF`, and the X410 link (MTU, address, UHD buffers).
- `srsran-gnb.service.in` — the live unit with site values. It is now ordered
  after the core (NG Setup needs the AMF). The log is in `/var/log/tsn5g/` and
  still archived per start.
- `tsn_health.sh`:
  - site values from site.env;
  - repairs through `systemctl start|restart open5gs.target`;
  - **rotating an oversized gnb.log archives it gzipped first** (keeps 5);
  - **pause file** `/etc/tsn5g/health.pause` stops auto-repair during an
    experiment, while checks still run.
- `restart_all.sh`, `post_reboot_check.sh` — parameterised; the second now
  checks the networking that boot sets up.
- `rt-grub.sh` (was `fix_grub_rt.sh`) takes the CPU list from
  `GNB_ISOLATED_CPUS`.
- `x410-find-nic.sh` shows link, speed, **NUMA node** and module per NIC, the
  three things needed to fill in `X410_HOST_IF` and `GNB_NUMA_NODE`.
- `core/etc/90-tsn-udp.conf` (UPF socket buffer 8 MB, UHD buffers,
  ip_forward) and a logrotate rule for the NF logs.
- `core/ptp/` — optional core gPTP, on `CORE_PTP_IF` (new in site.env).
- `docs/history/core/` and `tools/core-experiments/` — the first rig's notes
  and one-off test scripts, unchanged, for reference.

**Why** — on the first rig nothing started the core at boot: the health timer
noticed it was down three minutes later and ran run5gs.sh. NAT and
`ip_forward` were lost on every reboot, until someone ran
post_reboot_check.sh. The gNB could come up before the AMF existed.

**Deploy** — installed by `install.sh core` (commit 7). Moving the first rig's
core onto these units is a maintenance window: it stops the hand-started NFs
and drops the UE for about a minute.

**Verify**
```bash
sudo reboot            # then, with no manual step:
/opt/tsn5g/core/scripts/open5gs-ctl.sh status             # all active
/opt/tsn5g/core/scripts/tsn_health.sh                      # all PASS after ~3 min
sudo iptables -t nat -S POSTROUTING | grep MASQUERADE      # present
```

**Roll back** — `sudo systemctl disable --now open5gs.target open5gs-webui
tsn5g-core-net`, then start the old way (`run5gs.sh start`) and re-install the
previous `srsran-gnb.service` / `tsn-health.service` from the old directory.

---

## 5 — Core configuration in git: gNB, Open5GS, subscriber

**What**
- `core/gnb/gnb.yaml.in` — the live `~/tsntestbed/gnb_x410.yaml` of
  2026-10-03 with its comments, site values replaced by site.env variables
  (PLMN, TAC, X410 address, ARFCN, band, bandwidth, SCS, sample rate, PCI,
  gains, CPU sets). Two deliberate changes:
  - `metrics.enable_log: false` — on, it raised RF underflows about 4×;
    turn it on only while debugging the link.
  - log file `/var/log/tsn5g/gnb.log` instead of the home directory.
- `core/open5gs/configs/*.yaml.in` — the 12 network functions that run
  (nrf scp ausf udm udr pcf nssf bsf amf smf upf tsn-af), from the fork's
  `build/configs/open5gs/`. PLMN, TAC, DNN, UE pool, gateway and MTU come from
  site.env. **Fix:** UDM pointed at `/etc/open5gs/hnet/*.key`, which did not
  exist on the core; it now points at `${ETC_DIR}/open5gs/hnet/`, where
  `install.sh core` generates per-site keys (commit 7).
- `core/open5gs/subscriber.json.in` + `provision.sh` — the UE's record, which
  until now existed only inside MongoDB: static IP, default 5QI 7, UL AMBR
  50 Mbit/s, one PCC rule (5QI 4, GBR 25 / MBR 40 Mbit/s, "permit out udp/tcp
  from any 1-65535 to assigned 5202"). K/OPc come from `secrets.env`; an
  existing record's SQN is kept. `--dry-run` prints the record with keys masked.
- site.env: `GBR_5QI`, `DEFAULT_5QI`, `UE_AMBR_UL_MBPS`, `GNB_SRATE`.

**Why** — none of the core's configuration was under version control. The
subscriber/PCC rule that the whole demo depends on was one accidental WebUI
click from being lost.

**Deploy** — nothing changes on the running core in this commit. The files are
used by `install.sh core` (commit 7). To provision the subscriber on any core:
```bash
cp secrets.env.example secrets.env && chmod 600 secrets.env && nano secrets.env
core/open5gs/provision.sh --dry-run        # check, keys masked
sudo core/open5gs/provision.sh
```

**Verify** — rendered files equal the first rig's live ones except for the
changes listed above:
```bash
DRY_RUN=1 bash -c '. lib/render.sh; load_site; render core/gnb/gnb.yaml.in /etc/tsn5g/gnb.yaml'
diff rendered/etc/tsn5g/gnb.yaml ~/tsntestbed/gnb_x410.yaml     # on the first rig's core
```

**Roll back** — `git revert <this commit>`; nothing outside the repository
changed.

---

## 4 — `install.sh ue`: the whole UE in one command

**What**
- `install.sh` at the repository root: one installer, the role as its argument
  (`ue` now; `core` and `viewer` in later commits). Options: `--dry-run`
  (renders into `rendered/`, changes nothing, needs no sudo), `--site FILE`,
  `--no-start`, `--start-cameras`, `--remove`.
- `lib/install-ue.sh`, nine steps, each safe to repeat:
  1. packages (all from the Ubuntu archive; includes Xvfb, x11vnc, openbox,
     linuxptp, conntrack, tcpdump, libqmi-utils, iperf3)
  2. ModemManager masked
  3. NetworkManager leaves the camera NICs alone; sysctl
  4. code to `$PREFIX` (`/opt/tsn5g`), root-owned; site.env to `$ETC_DIR`
  5. daemon config rendered to `$ETC_DIR/tsn5g-ue.yaml` (previous copy kept as
     `.bak-<date>`); systemd units rendered
  6. sudoers (validated with `visudo` before it is installed) and polkit
  7. encoder bundle unpacked from `$VENDOR_DIR` after a sha256 check against
     `video/MANIFEST`; our `run.sh` and camera configs laid over it
  8. units enabled at boot
  9. started; waits for the UI's `/api/health`. Running encoders are left
     alone unless `--start-cameras`.
- `lib/render.sh` gains `install_sudoers`, `install_bundle`, `wait_health`,
  `backup_if_changed`.
- `video/`: `MANIFEST`, the encoder's `run.sh`, `camera1/2.json.in`.
- The old single-product installer (`ue/scripts/install.sh`, `uninstall.sh`,
  `package.sh`, `ue/systemd/`) is gone; the kiosk unit is a template too.

**Why** — the first rig was assembled by hand over weeks (units copied from the
repo, sudoers installed by hand, encoders unpacked into a home directory, NM
conf written once). A new site now runs one command per machine.

**Deploy** — on a new UE (or to move this one onto `/opt/tsn5g`):
```bash
sudo mkdir -p /srv/tsn5g-vendor && sudo cp pathStream1.tar.gz /srv/tsn5g-vendor/
cp site.env.example site.env && nano site.env
./install.sh ue --dry-run            # read what it would do; files in rendered/
sudo ./install.sh ue
```
On the first rig this replaces the four units that pointed into
`~/camera_application/tsn5g-ue-app`; the daemon restarts (about 10 s, the data
call survives), the encoders are left running until `--start-cameras`.

**Verify**
```bash
systemctl is-active tsn5g-ue tsn5g-cam2-netns tsn5g-vnc-display tsn5g-cameras
curl -s localhost:8080/api/health
/opt/tsn5g/tools/camera-loss-check.sh 30          # both cameras ~0 % loss
```

**Roll back** — `sudo ./install.sh ue --remove`, then re-install the old units
from `~/camera_application/tsn5g-ue-app` (its `scripts/install-autostart.sh`
and `systemd/tsn5g-ue.di1200.service`). `/etc/tsn5g/*.bak-*` holds the
previous config.

---

## 3 — UE scripts, units and tools take their values from site.env

**What**
- `ue/templates/systemd/*.service.in` replace the four rig-bound units
  (`tsn5g-ue`, `tsn5g-cam2-netns`, `tsn5g-vnc-display`, `tsn5g-cameras`):
  code under `${PREFIX}/ue`, config at `${ETC_DIR}/tsn5g-ue.yaml`, screen
  `:${DISPLAY_NUM}`, desktop user `${UE_USER}`.
- `tsn5g-cameras` now also **presses the encoders' Start button** after
  launching them (`ExecStartPost`, the same XTEST helper the UI uses), so
  video flows after a reboot without anyone opening VNC.
- `ue/templates/etc/`: sudoers (checked with `visudo -c`), polkit rule
  (now also covers the three camera units), NetworkManager "leave the camera
  NICs alone" conf (`CAM1_IF`, `CAM2_IF`), sysctl (16 MB socket ceilings,
  `ip_forward` for camera 2's namespace).
- `ue/scripts/site-env.sh`: the one place the rig scripts load settings from
  (`$SITE_ENV`, then `/etc/tsn5g/site.env`, then the checkout's `site.env`).
  `camera2-netns.sh`, `cameras-start.sh`, `vnc-display.sh` use it.
- `install-autostart.sh` renders the unit templates instead of copying fixed
  files; the UI's "up to date" check compares against the rendered template.
- Measurement tools moved to `tools/` (`demo-run.sh`, `lcp-test.sh`,
  `camera-loss-check.sh`, `radio-loss-test.sh` and their analysers) and read
  `tools/common.sh`: `CORE_SSH` (user@core LAN address), `CORE_IP` (core across
  the bearer), `WWAN`, `GBR_PORT`, camera ports. Any of them can be overridden
  for one run, e.g. `CORE_SSH=me@host ./tools/demo-run.sh`.
- Manual modem bring-up helpers `ue_qmi_up.sh` and `at.py` (previously outside
  any repository) are now in `tools/modem/`, with defaults from site.env.

**Why** — the old units and scripts named `/home/amrc/camera_application/…`,
user `amrc`, `enp7s0`, `wwan0`, `tsn_server@10.5.1.19` directly. Two tools
also used `CORE` for different things (an SSH target in one, the bearer
address in another); the new names say which is which.

**Deploy** — through `install.sh ue` (commit 4). To refresh only the boot units
on a rig that already runs from `/opt/tsn5g`:
```bash
sudo /opt/tsn5g/ue/scripts/install-autostart.sh            # --start-cameras to take over running encoders
```

**Verify**
```bash
DRY_RUN=1 bash -c '. lib/render.sh; load_site; render ue/templates/etc/tsn5g-ue.sudoers.in /etc/sudoers.d/tsn5g-ue'
visudo -c -f rendered/etc/sudoers.d/tsn5g-ue          # "parsed OK"
grep -rn "/home/amrc\|tsn_server@" ue/templates tools   # nothing
./tools/demo-run.sh                                      # still runs the demo end to end
```

**Roll back** — `git revert <this commit>`; re-install the previous units with
the previous `install-autostart.sh`.

---

## 2 — One settings file (site.env); UE code reads its site values from config

**What**
- `site.env.example`: every site-specific value in one commented file —
  5G identity (PLMN, DNN, UE pool, GBR port), core addresses and NICs, the
  USRP X410 link, gNB radio and real-time CPU layout, pinned source versions,
  UE NICs, camera serials and ports, PTP, video display/VNC.
  `secrets.env.example` for SIM keys (never committed).
- `lib/render.sh`: loads site.env, renders `*.in` templates substituting only
  site variables (shell `$1`/`$(…)` inside templates untouched), refuses to
  write a file that still has `${UNSET}` in it, supports `--dry-run`
  (output under `rendered/`).
- `ue/templates/tsn5g-ue.yaml.in`: the daemon config as a template, with the
  first rig's final demo state baked in — camera 1 on the GBR bearer
  (`source_port: ${GBR_SOURCE_PORT}`), auto-rate on — and a new `rig:` section.
- `ue/tsn5g_ue/rig.py`: `configure()` takes the namespace, NIC, veth subnet,
  bearer, core IP, display, VNC port, desktop user and GBR port from `rig:`;
  the controller calls it at start-up. `encoder_gui.py` takes the display from
  `TSN5G_DISPLAY`. VNC hints in the UI use the configured user and address.
- `ue/pyproject.toml`: package list now includes `net`, `modem`, `perf` and
  `tsnbridge` (a pip install was missing them).

**Why** — about 120 values were tied to the first rig (its IPs, `enp7s0`,
`wwan0`, user `amrc`, `/home/amrc/…`). A new site now changes one file.

**Deploy** — no effect on a running rig until `install.sh` (commit 4) renders
the config; the daemon falls back to the old defaults when `rig:` is absent.

**Verify**
```bash
cp site.env.example site.env           # or your real values
bash -c '. lib/render.sh; DRY_RUN=1; load_site; render ue/templates/tsn5g-ue.yaml.in /etc/tsn5g/tsn5g-ue.yaml'
less rendered/etc/tsn5g/tsn5g-ue.yaml  # every value comes from site.env
```

**Roll back** — `git revert <this commit>`; the defaults in `rig.py` are the
first rig's values.

---

## 1 — Repository skeleton; UE app imported with its history

**What**
- New repository `tsn5g-testbed` with the role-based layout (`ue/`, `core/`,
  `video/`, `tools/`, `docs/`) described in the README.
- The UE application (previously `~/camera_application/tsn5g-ue-app`) is
  imported into `ue/` with `git subtree`, so all 40 earlier commits keep their
  history (`git log -- ue/`).
- `.gitignore` keeps site settings, secrets, vendor bundles, logs and captures
  out of git.

**Why** — the testbed is moving to new hardware. One repository holding every
part (UE, core, gNB, video) means one clone per machine and settings that
cannot drift apart between UE and core.

**Deploy** — nothing to deploy yet; the running rig is unchanged. This commit
only creates the repository.

**Verify**
```bash
git log --oneline -- ue/ | head        # the UE history is present
git status --ignored | grep site.env   # (after creating one) shown as ignored
```

**Roll back** — delete the repository directory; nothing outside it changed.
