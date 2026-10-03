#!/bin/bash
# The modem CAN see the testbed cell (001/02, ARFCN 624000, RSRP -101, SINR 40)
# but will not camp. Prime suspect: PLMN 00102 is in the SIM's forbidden-PLMN
# list (EF_FPLMN), which survives reboots. Clear it and force manual selection.
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"
systemctl stop tsn5g-ue 2>/dev/null

echo "===== 1. current selection mode + forbidden PLMN list ====="
WAIT=15 ./at.py 'AT+COPS?' 'AT+QFPLMNCFG="get"' 'AT+CPIN?'

echo
echo "===== 2. clearing the forbidden PLMN list ====="
WAIT=15 ./at.py 'AT+QFPLMNCFG="delete","00102"' 'AT+QFPLMNCFG="get"'

echo
echo "===== 3. forcing manual registration on 00102 (may take 60-90s) ====="
WAIT=120 ./at.py 'AT+COPS=1,2,"00102"'

echo
echo "===== 4. did it camp? ====="
for i in $(seq 1 12); do
    out=$(WAIT=10 ./at.py 'AT+QENG="servingcell"' 'AT+C5GREG?' 'AT+CSQ' 2>/dev/null \
          | grep -oE '\+QENG:[^|]*|\+C5GREG:[^|]*|\+CSQ:[^|]*' | tr '\n' ' ')
    echo "  [$((i*5))s] $out"
    if echo "$out" | grep -q 'NR5G-SA'; then
        echo
        echo "CAMPED - starting the data call"
        ./ue_qmi_up.sh up && {
            echo; echo "=== data plane ==="
            ip -br addr show wwan0 | sed 's/^/  /'
            ping -I wwan0 -c3 -W3 10.45.0.1 2>&1 | sed 's/^/  /'
        }
        exit 0
    fi
    sleep 5
done

echo
echo "Did not camp. Capture AT+COPS=1,2,\"00102\" output above - if it returned"
echo "ERROR, the rejection cause is the next thing to read from the core logs."
