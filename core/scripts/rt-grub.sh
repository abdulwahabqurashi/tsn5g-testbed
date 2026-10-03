#!/bin/bash
# Set GRUB_CMDLINE_LINUX_DEFAULT to the gNB's five real-time parameters, on ONE line.
#
#   sudo core/scripts/rt-grub.sh          (CPU list from site.env GNB_ISOLATED_CPUS)
#
# Why this exists instead of editing by hand:
#   The previous hand edit left the five parameters spread over five physical
#   lines inside one pair of quotes. grub-mkconfig sources /etc/default/grub as
#   shell, so the variable ended up containing embedded newlines and only the
#   text before the first newline (isolcpus=...) reached the linux line in
#   grub.cfg. nohz_full, rcu_nocbs and the two max_cstate settings were silently
#   dropped -- the reboot looked successful but applied 1 of 5 parameters.
#
#   This script rewrites the whole assignment as a single line and then VERIFIES
#   the generated grub.cfg actually contains all five before letting you reboot.
#
# Does NOT reboot. Read the output, then reboot yourself.
set -euo pipefail

GRUB=/etc/default/grub
. "$(dirname "$(readlink -f "$0")")/site-env.sh"   # shellcheck disable=SC1091
# The cores srsRAN pins its own threads to (GNB_RU_CPUS + GNB_MAIN_CPUS), all on
# the X410 NIC's NUMA node. See docs/DEPLOY.md "real-time tuning" for choosing them.
CPUS=${GNB_ISOLATED_CPUS:?set GNB_ISOLATED_CPUS in site.env}
WANT="isolcpus=$CPUS nohz_full=$CPUS rcu_nocbs=$CPUS intel_idle.max_cstate=1 processor.max_cstate=1"

if [ "$EUID" -ne 0 ]; then
    echo "Must run as root:  sudo $0" >&2
    exit 1
fi

# ----------------------------------------------------------------- 1. backup
BAK="$GRUB.bak-partial-$(date -u +%Y%m%d-%H%M%S)"
cp -a "$GRUB" "$BAK"
echo "-- backed up current $GRUB to $BAK"

# ------------------------------------------------------------------ 2. rewrite
# Collapse the multi-line assignment into one line. Matches from the line that
# opens GRUB_CMDLINE_LINUX_DEFAULT=" through to the line carrying the closing
# quote, however many lines that spans.
python3 - "$GRUB" "$WANT" <<'PY'
import re, sys
path, want = sys.argv[1], sys.argv[2]
src = open(path).read()

# Only the active (uncommented) assignment. DOTALL so it spans newlines;
# non-greedy so it stops at the first closing quote.
pat = re.compile(r'^GRUB_CMDLINE_LINUX_DEFAULT=".*?"', re.M | re.S)
hits = pat.findall(src)
if len(hits) != 1:
    sys.exit(f"expected exactly 1 active GRUB_CMDLINE_LINUX_DEFAULT, found {len(hits)} -- "
             "not touching the file, fix it by hand")

new = f'GRUB_CMDLINE_LINUX_DEFAULT="{want}"'
out = pat.sub(lambda _: new, src, count=1)
open(path, 'w').write(out)
print("-- rewrote the assignment as a single line")
PY

echo
echo "-- /etc/default/grub now reads:"
grep -n '^GRUB_CMDLINE' "$GRUB" | sed 's/^/   /'

# --------------------------------------------- 3. sanity-check the source file
n=$(grep -c '^GRUB_CMDLINE_LINUX_DEFAULT' "$GRUB")
if [ "$n" -ne 1 ]; then
    echo "FAIL: found $n active GRUB_CMDLINE_LINUX_DEFAULT lines, expected 1" >&2
    echo "      restore with: cp -a $BAK $GRUB" >&2
    exit 1
fi

# ----------------------------------------------------------------- 4. generate
echo
echo "-- running update-grub"
update-grub

# ------------------------------------------- 5. verify what actually landed
echo
echo "-- verifying /boot/grub/grub.cfg (this is the check that was missed before)"
line=$(grep -m1 '^[[:space:]]*linux.*isolcpus' /boot/grub/grub.cfg || true)
if [ -z "$line" ]; then
    echo "FAIL: no linux line in grub.cfg carries isolcpus at all." >&2
    echo "      restore with: cp -a $BAK $GRUB && update-grub" >&2
    exit 1
fi

missing=0
for p in "isolcpus=$CPUS" "nohz_full=$CPUS" "rcu_nocbs=$CPUS" \
         "intel_idle.max_cstate=1" "processor.max_cstate=1"; do
    if grep -qF -- "$p" <<<"$line"; then
        echo "   OK      $p"
    else
        echo "   MISSING $p"
        missing=$((missing+1))
    fi
done

echo
if [ "$missing" -ne 0 ]; then
    echo "FAIL: $missing of 5 parameters did not reach grub.cfg. DO NOT REBOOT." >&2
    echo "      restore with: cp -a $BAK $GRUB && update-grub" >&2
    exit 1
fi

cat <<EOF
RESULT: all 5 parameters are present in /boot/grub/grub.cfg. Safe to reboot.

Next:
  1. sudo reboot     (drops the UE's bearer and the X410 stream)
  2. After it comes back: sudo /opt/tsn5g/core/scripts/post_reboot_check.sh

If it does not boot: hold Shift for the GRUB menu, press e, delete the added
parameters from the linux line, Ctrl-X to boot once, then:
  sudo cp -a $BAK /etc/default/grub && sudo update-grub
EOF
