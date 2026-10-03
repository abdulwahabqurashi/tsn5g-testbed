# Changes

One section per commit, newest first. Each says **what** changed, **why**,
**how to deploy** it on a running site, **how to verify** it, and **how to roll
back**. Commit hashes are filled in as `git log --oneline` shows them.

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
