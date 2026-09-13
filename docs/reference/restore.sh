#!/bin/bash
# Use the firmware's own band-restore command, revealed by AT+QNWPREFCFG=?
# ("restore_band"). Targeted - unlike AT+QPRTPARA=3 it should not disturb
# usbnet/QMI composition.
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"

echo "===== before ====="
WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_band"' 'AT+QNWPREFCFG="rf_band"' \
                'AT+QNWPREFCFG="ue_capability_band"'

echo
echo "===== invoking restore_band ====="
WAIT=30 ./at.py 'AT+QNWPREFCFG="restore_band"'
sleep 3
WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_band"'

echo
echo "===== modem reset so it takes effect (USB re-enumerates, ~35s) ====="
WAIT=20 ./at.py 'AT+CFUN=1,1' >/dev/null 2>&1
sleep 40

echo "===== after reset ====="
band=$(WAIT=20 ./at.py 'AT+QNWPREFCFG="nr5g_band"' | grep -o '"nr5g_band",[^ |]*' | cut -d, -f2)
echo "  nr5g_band = ${band:-?}"
WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_band"' 'AT+QNWPREFCFG="mode_pref"' \
                'AT+QCFG="usbnet"'

case "$band" in
    ''|0) echo; echo "STILL 0 - stop here and report back before trying anything else."; exit 1 ;;
esac

echo
echo "===== band is back - reapplying testbed config ====="
WAIT=15 ./at.py 'AT+QNWPREFCFG="mode_pref",NR5G' \
                'AT+QNWPREFCFG="nr5g_disable_mode",1' \
                'AT+QNWPREFCFG="mode_pref"' \
                'AT+QNWPREFCFG="nr5g_disable_mode"' \
                'AT+QNWPREFCFG="nr5g_band"'

echo
echo "===== watching 90s for the testbed cell ====="
for i in $(seq 1 18); do
    out=$(WAIT=8 ./at.py 'AT+QENG="servingcell"' 'AT+CSQ' 2>/dev/null \
          | grep -oE '\+QENG:[^|]*|\+CSQ:[^|]*' | tr '\n' ' ')
    echo "  [$((i*5))s] $out"
    echo "$out" | grep -q 'NR5G-SA' && { echo; echo "CAMPED - run: sudo ./ue_qmi_up.sh up"; exit 0; }
    sleep 5
done
