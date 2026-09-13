#!/bin/bash
# Fast RF-path check: is a stale cell lock pinning the search, and is any RF
# actually reaching the antennas?  ~40s, no long scans.   sudo ./rfcheck.sh
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"
systemctl stop ModemManager tsn5g-ue 2>/dev/null

echo "===== cell lock (the prime suspect) ====="
lock=$(WAIT=10 ./at.py 'AT+QNWLOCK="common/5g"')
echo "$lock"

echo
echo "===== per-antenna RSRP - the antenna test ====="
echo "  -140 / -32768 on every branch = no RF reaching the modem"
WAIT=10 ./at.py 'AT+QRSRP' 'AT+QRSRQ'

echo
echo "===== mode / band ====="
WAIT=10 ./at.py 'AT+QNWPREFCFG="mode_pref"' 'AT+QNWPREFCFG="nr5g_band"' \
                'AT+QNWPREFCFG="nr5g_disable_mode"'

# A lock line carrying a non-zero ARFCN means the search is pinned. Clear it:
# the cell is at ARFCN 626666 (3399.99 MHz), so any other value searches forever.
if echo "$lock" | grep -q 'QNWLOCK' && ! echo "$lock" | grep -qE '"common/5g",0|,0,0,0'; then
    echo
    echo "===== LOCK PRESENT - clearing it to allow a full blind scan ====="
    WAIT=10 ./at.py 'AT+QNWLOCK="common/5g",0' 'AT+QNWLOCK="common/5g"'
    echo "  waiting 60s for the modem to re-scan unpinned..."
    for i in $(seq 1 12); do
        c=$(WAIT=8 ./at.py 'AT+QENG="servingcell"' 'AT+CSQ' 2>/dev/null | grep -oE '\+QENG:[^|]*|\+CSQ:[^|]*' | tr '\n' ' ')
        echo "  [$((i*5))s] $c"
        echo "$c" | grep -q 'NR5G-SA' && { echo; echo "CAMPED. Run: sudo ./connect.sh"; exit 0; }
        sleep 5
    done
else
    echo
    echo "  No cell lock set - the search is already unpinned, so a stale lock"
    echo "  is NOT the cause. Antenna is then the leading suspect (see RSRP above)."
fi
