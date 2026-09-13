#!/bin/bash
# Restore 5G SA operation and wait for the UE to camp. No option flags: sudo ./fix5g.sh
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"

echo "== current =="
./at.py 'AT+QNWPREFCFG="nr5g_disable_mode"' 'AT+QNWPREFCFG="mode_pref"'

echo
echo "== setting SA-only (nr5g_disable_mode=1) =="
./at.py 'AT+QNWPREFCFG="nr5g_disable_mode",1' 'AT+QNWPREFCFG="nr5g_disable_mode"'

echo
echo "== waiting up to 90s for a serving cell =="
for i in $(seq 1 18); do
    out=$(./at.py 'AT+QENG="servingcell"' 'AT+C5GREG?' 'AT+CSQ' 2>/dev/null | tail -3)
    echo "[$((i*5))s] $(echo "$out" | tr '\n' ' ')"
    if echo "$out" | grep -q 'NR5G-SA'; then
        echo
        echo "CAMPED. Now run:  sudo ./ue_qmi_up.sh up"
        exit 0
    fi
    sleep 5
done

echo
echo "Still searching. Forcing a modem reset (AT+CFUN=1,1); USB re-enumerates, ~30s."
./at.py 'AT+CFUN=1,1'
sleep 35
./at.py 'AT+QENG="servingcell"' 'AT+C5GREG?' 'AT+CSQ'
echo
echo "If still SEARCH, the fault is outside the UE: check the gNB is on n78/PLMN 00102"
echo "and that the antennas are seated on MAIN/DIV."
