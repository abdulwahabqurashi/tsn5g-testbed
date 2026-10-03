# tsn5g-testbed

A TSN-over-5G testbed: two industrial cameras behind a 5G UE, a private 5G
core and gNB, and a video viewer — with a protected camera that keeps every
frame when the uplink is flooded, and a best-effort camera that does not.

Everything needed to rebuild it on new hardware is in this repository.

## The machines (roles)

| Role | What runs there | Install |
|---|---|---|
| **ue** | UE daemon + web UI, Quectel RM520N modem, two FLIR cameras, camera encoders, PTP slave | `./install.sh ue` |
| **core** | Open5GS (TSN fork) core, srsRAN gNB driving a USRP X410, MongoDB, health watchdog | `./install.sh core` |
| **viewer** | the video viewer on a virtual screen shared over VNC (normally on the core) | `./install.sh viewer` |

## Quick start on a new machine

```bash
git clone git@github.com:<you>/tsn5g-testbed.git && cd tsn5g-testbed
cp site.env.example site.env && nano site.env     # this site's IPs, NICs, users, serials …
sudo ./install.sh <role>                           # ue | core | viewer   (--dry-run first)
```

`site.env` is the only file you edit. Every config file, systemd unit and
script is generated from it, so nothing in the repository needs changing for a
new site. Secrets (SIM keys) go in `secrets.env`; neither file is committed.

## Layout

```
site.env.example     every site-specific value, with comments  (copy to site.env)
secrets.env.example  SIM keys (copy to secrets.env, core only)
install.sh           one installer: ./install.sh ue | core | viewer  [--dry-run]
lib/                 installer steps per role + template rendering
ue/                  UE daemon + web UI (tsn5g_ue/, web/), rig scripts, templates/
core/                gnb/ and open5gs/ configs, open5gs/src (the fork), srsran/ patch,
                     scripts/ (health, restart, RT tuning), systemd/, build.sh
video/               encoder/viewer overlays and configs; vendor bundles by sha256 (MANIFEST)
tools/               measurement scripts (demo-run, camera-loss-check, lcp-test ...),
                     modem/ helpers, git-hooks/
docs/                DEPLOY, CHANGES, LESSONS, GITHUB; history/ = first-rig notes
```

Installed layout on every machine: code in `/opt/tsn5g`, rendered configs and
a copy of `site.env` in `/etc/tsn5g`, logs in `/var/log/tsn5g`.

## Documentation

- [docs/DEPLOY.md](docs/DEPLOY.md) — building a new site from scratch, step by step
- [docs/CHANGES.md](docs/CHANGES.md) — what each commit changed, why, how to deploy and verify it
- [docs/LESSONS.md](docs/LESSONS.md) — problems found on the first rig and how they were fixed
- [docs/GITHUB.md](docs/GITHUB.md) — pushing changes from the UE and from the core
