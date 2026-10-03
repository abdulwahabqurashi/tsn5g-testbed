#!/bin/bash
# Decisive RF-path test: can this modem hear ANY cell on ANY band?
# Temporarily allows LTE (public LTE is everywhere) then restores 5G-SA config.
# Takes 4-6 minutes.   sudo ./rftest.sh
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"
systemctl stop ModemManager tsn5g-ue 2>/dev/null

restore() {
    echo
    echo "===== restoring 5G SA-only config ====="
    WAIT=15 ./at.py 'AT+QNWPREFCFG="mode_pref",NR5G' \
                    'AT+QNWPREFCFG="nr5g_disable_mode",1' \
                    'AT+QNWPREFCFG="mode_pref"' \
                    'AT+QNWPREFCFG="nr5g_disable_mode"'
}
trap restore EXIT

echo "===== 1. NR-only scan of the testbed band ====="
WAIT=240 ./at.py 'AT+QSCAN=3,1'

echo
echo "===== 2. widening to all RATs (LTE + NR) for the reachability test ====="
WAIT=15 ./at.py 'AT+QNWPREFCFG="mode_pref",AUTO' 'AT+QNWPREFCFG="mode_pref"'

echo
echo "===== 3. full operator scan - 2-3 minutes ====="
echo "  If the antenna works you WILL see UK operators here (23410/23415/23420/23430)."
echo "  A completely empty list means no RF is reaching the modem."
WAIT=220 ./at.py 'AT+COPS=?'
