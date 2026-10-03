# Pushing and pulling from both machines (GitHub)

One private GitHub repository. The UE and the core each have a clone, and
each can commit and push. Settings (`site.env`) and keys (`secrets.env`)
never go to GitHub.

```
            GitHub  (private repo: tsn5g-testbed)
              ▲  │                     ▲  │
         push │  │ pull           push │  │ pull
              │  ▼                     │  ▼
   UE  ~/tsn5g-testbed          core  ~/tsn5g-testbed
```

## One-time setup

### 1. Create the repository (in a browser)

GitHub → **New repository** → name `tsn5g-testbed`, **Private**, *no*
README / .gitignore / licence (the repository already has them) → Create.

### 2. Give each machine its own key (repeat on the UE and on the core)

```bash
ssh-keygen -t ed25519 -C "tsn5g $(hostname)" -f ~/.ssh/id_ed25519   # press Enter for no passphrase, or set one
cat ~/.ssh/id_ed25519.pub                                          # copy this line
```

On GitHub, open the repository → **Settings → Deploy keys → Add deploy key**.
Paste the line, name it after the machine (`ue`, `core`), and tick **Allow
write access**. A deploy key opens only this one repository, which is what
you want on a shared lab machine.

Test it:

```bash
ssh -T git@github.com          # "Hi <you>/tsn5g-testbed! You've successfully authenticated..."
```

Then tell git who you are on that machine (shown in `git log`):

```bash
git config --global user.name  "Your Name"
git config --global user.email "you@sheffield.ac.uk"
```

### 3. First push (from the UE, where the repository was created)

```bash
cd ~/tsn5g-testbed
git remote add origin git@github.com:<your-account>/tsn5g-testbed.git
git push -u origin main
```

### 4. Clone on the core

```bash
cd ~ && git clone git@github.com:<your-account>/tsn5g-testbed.git
cd tsn5g-testbed
git config core.hooksPath tools/git-hooks          # the secret check, once per clone
scp <UE_USER>@<UE_LAN_IP>:tsn5g-testbed/site.env .  # settings travel by scp, never by git
cp secrets.env.example secrets.env && chmod 600 secrets.env && nano secrets.env
```

(The UE's clone already has the hook enabled. On any new clone, run the
`core.hooksPath` line once.)

## Every day, on either machine

```bash
cd ~/tsn5g-testbed
git pull --rebase                 # 1. always start from the latest
# ... edit files ...
git status                        # 2. see what changed
git add <files>                   #    or: git add -A
git commit -m "gNB: raise tx_gain to 44 for the new room"
git push                          # 3. publish
```

Then apply it where it runs:

```bash
sudo ./install.sh core            # on the core (SKIP_BUILD=1 if only configs changed)
sudo ./install.sh ue              # on the UE
```

Rules that keep both sides in step:

1. **Pull before you edit**, every time. Most conflicts come from editing a
   stale copy.
2. **Commit small, with a message that says why.** For anything a person
   will deploy, add an entry to `docs/CHANGES.md` (what / why / deploy /
   verify / roll back) in the same commit.
3. **Edit the repository, not the installed files.** `/opt/tsn5g` and
   `/etc/tsn5g` are overwritten by the next install. Change the template or
   `site.env`, then re-run the install.
4. **A value that differs per site goes in `site.env.example`** as a new
   variable with a comment, and the template uses `${VAR}`.

## If the push is rejected

`! [rejected] main -> main (fetch first)` means the other machine pushed
first:

```bash
git pull --rebase                 # replays your commits on top of theirs
git push
```

If the rebase stops with a **conflict**, git names the file. Open it, keep
the right lines (between `<<<<<<<` and `>>>>>>>`), then:

```bash
git add <file>
git rebase --continue
git push
```

To give up and go back: `git rebase --abort`.

## If the commit is refused by the secret check

The pre-commit hook blocks `site.env`, `secrets.env`, `.env` files, WebUI
backups, anything that looks like a SIM key or private key, and files over
50 MB. Unstage the file (`git restore --staged <file>`) and commit again.
If a secret ever does reach GitHub, deleting it in a new commit is not
enough, because it stays in the history. Change the secret (re-program the
SIM keys, regenerate the key), then clean the history.

## Useful

```bash
git log --oneline -10             # recent commits
git log --oneline -- core/gnb     # history of one area
git diff                          # unstaged changes
git show <hash>                   # one commit in full
git log -- ue/                    # the UE app's history, including before this repository
```
