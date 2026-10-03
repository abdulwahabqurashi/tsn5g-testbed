#!/bin/bash
# Pin the modem to the testbed cell found by AT+QSCAN:
#   PLMN 001/02, SSB ARFCN 624000, band 78, PCI 1, SCS 30kHz (index 1)
# QNWLOCK argument order varies by firmware, so try the documented variants and
# keep whichever the modem accepts.   sudo ./lock5g.sh
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"
systemctl stop tsn5g-ue 2>/dev/null

ARFCN=624000; SCS=1; BAND=78; PCI=1

echo "===== current mode / lock ====="
WAIT=10 ./at.py 'AT+QNWPREFCFG="mode_pref"' 'AT+QNWPREFCFG="nr5g_disable_mode"' \
                'AT+QNWLOCK="common/5g"'

echo
echo "===== trying QNWLOCK variants (ERROR just means wrong arg order) ====="
for v in "\"common/5g\",$ARFCN,$SCS,$BAND" \
         "\"common/5g\",1,$ARFCN,$SCS,$BAND" \
         "\"common/5g\",$ARFCN,$SCS,$BAND,$PCI" \
         "\"common/5g\",1,$ARFCN,$SCS,$BAND,$PCI"; do
    r=$(WAIT=10 ./at.py "AT+QNWLOCK=$v" 2>/dev/null | tail -1)
    echo "  AT+QNWLOCK=$v  ->  ${r##*-> }"
    case "$r" in *OK*) echo "  ACCEPTED"; break ;; esac
done

echo
echo "===== lock now reads ====="
WAIT=10 ./at.py 'AT+QNWLOCK="common/5g"'

echo
echo "===== resetting radio and watching 90s ====="
WAIT=15 ./at.py 'AT+CFUN=0' >/dev/null; sleep 2
WAIT=15 ./at.py 'AT+CFUN=1' >/dev/null; sleep 5
for i in $(seq 1 18); do
    out=$(WAIT=8 ./at.py 'AT+QENG="servingcell"' 'AT+C5GREG?' 'AT+CSQ' 2>/dev/null \
          | grep -oE '\+QENG:[^|]*|\+C5GREG:[^|]*|\+CSQ:[^|]*' | tr '\n' ' ')
    echo "  [$((i*5))s] $out"
    if echo "$out" | grep -q 'NR5G-SA'; then
        echo; echo "CAMPED - starting data call"; ./ue_qmi_up.sh up && {
            ip -br addr show wwan0 | sed 's/^/  /'
            ping -I wwan0 -c3 -W3 10.45.0.1 2>&1 | sed 's/^/  /'; }
        exit 0
    fi
    sleep 5
done
echo
echo "No camp. Clear the lock with:  sudo ./at.py 'AT+QNWLOCK=\"common/5g\",0'"
