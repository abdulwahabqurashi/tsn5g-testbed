#!/bin/bash
# Forced 5G-SA registration on the testbed PLMN, with the access technology
# pinned. Earlier attempts used AT+COPS=1,2,"00102" with no <AcT>, which let the
# modem widen to LTE and drift into limited service on Vodafone.
#   <AcT>=11 -> NR connected to a 5G core (SA). 3GPP TS 27.007.
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"
systemctl stop tsn5g-ue 2>/dev/null

echo "===== 1. restore strict 5G-SA preference ====="
WAIT=15 ./at.py 'AT+QNWPREFCFG="mode_pref",NR5G' \
                'AT+QNWPREFCFG="nr5g_disable_mode",1' \
                'AT+QNWPREFCFG="nr5g_band",78' \
                'AT+QNWPREFCFG="mode_pref"' \
                'AT+QNWPREFCFG="nr5g_disable_mode"' \
                'AT+QNWPREFCFG="nr5g_band"'

echo
echo "WINDOW OPENS: $(date '+%H:%M:%S')   <-- gNB log from here"
echo
echo "===== 2. forced NR5G-SA registration on 00102 (AcT=11) ====="
WAIT=15 ./at.py 'AT+COPS=2' >/dev/null; sleep 2
WAIT=150 ./at.py 'AT+COPS=1,2,"00102",11'

echo
echo "===== 3. result ====="
WAIT=15 ./at.py 'AT+QENG="servingcell"' 'AT+C5GREG?' 'AT+CSQ' 'AT+CEER' 'AT+COPS?'
echo
echo "WINDOW CLOSES: $(date '+%H:%M:%S')"

echo
echo "===== 4. watching 60s ====="
for i in $(seq 1 12); do
    out=$(WAIT=8 ./at.py 'AT+QENG="servingcell"' 'AT+C5GREG?' 2>/dev/null \
          | grep -oE '\+QENG:[^|]*|\+C5GREG:[^|]*' | tr '\n' ' ')
    echo "  [$((i*5))s] $out"
    if echo "$out" | grep -q 'NR5G-SA'; then
        echo; echo "CAMPED - starting data call"; ./ue_qmi_up.sh up && {
            ip -br addr show wwan0 | sed 's/^/  /'
            ping -I wwan0 -c3 -W3 10.45.0.1 2>&1 | sed 's/^/  /'; }
        exit 0
    fi
    sleep 5
done
echo; echo "No camp. Restoring automatic selection."
WAIT=15 ./at.py 'AT+COPS=0' >/dev/null
