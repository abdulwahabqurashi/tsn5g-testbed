# video/

The camera **encoder** (`pathStream1`, on the UE) and the **viewer**
(`pathView2`, normally on the core) are vendor applications: FLIR Spinnaker +
Qt binaries, ~90 MB packed. They are **not stored in git** (no licence to
redistribute). This folder holds only what we changed or configure:

| File | What |
|---|---|
| `MANIFEST` | the exact vendor tarballs, by sha256 — install.sh refuses anything else |
| `encoder/run.sh` | replaces the vendor launcher: adds `LD_LIBRARY_PATH` (libSpinnaker has no RUNPATH) and forces Qt's xcb plugin |
| `encoder/camera1.json.in`, `camera2.json.in` | where each encoder sends: `CORE_BEARER_IP`, `CAM1_PORT` / `CAM2_PORT` |
| `viewer/` | viewer config and service (install.sh viewer) |

## Getting the bundles onto a new machine

Copy the two tarballs from the first rig (or from wherever you keep them) into
`VENDOR_DIR` from site.env (default `/srv/tsn5g-vendor`):

```bash
sudo mkdir -p /srv/tsn5g-vendor
# on the UE:   pathStream1.tar.gz     (first rig: ~/camera_application/U5G/x11/pathStream1.tar.gz)
# on the core: pathView2.tar.gz       (first rig: ~/camera_application/U5G/pathView2.tar.gz, the generic build)
scp OLD-UE:camera_application/U5G/x11/pathStream1.tar.gz /srv/tsn5g-vendor/
sha256sum /srv/tsn5g-vendor/*.tar.gz      # must match MANIFEST
```

The installer unpacks the bundle under `$PREFIX/video/`, overlays the files
above and renders the configs. Without the bundle everything else still
installs; the cameras just do not start.
