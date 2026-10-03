# lib/

Used by `install.sh`; not run directly.

| File | What |
|---|---|
| `render.sh` | shared helpers: `load_site`, `render` (envsubst limited to site.env variables; refuses leftovers; `--dry-run` writes to `rendered/`), `install_bundle` (sha256 check), `install_sudoers` (visudo check), `apt_install`, `wait_health` |
| `install-ue.sh` | the 9 steps of `install.sh ue` |
| `install-core.sh` | the 9 steps of `install.sh core` (calls `core/build.sh`) |
| `install-viewer.sh` | the 5 steps of `install.sh viewer` |

Templates (`*.in`) use `${VAR}` for site.env values only; any other `$` in
them (shell code in a unit, `%i`) is left untouched.
