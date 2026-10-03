# Changes

One section per commit, newest first. Each says **what** changed, **why**,
**how to deploy** it on a running site, **how to verify** it, and **how to roll
back**. Commit hashes are filled in as `git log --oneline` shows them.

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
