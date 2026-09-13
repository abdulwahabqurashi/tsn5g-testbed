#!/bin/bash
# Is ANY 5G cell audible to this modem? Definitive UE-side test. sudo ./scan.sh
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"

echo "===== cell lock config (empty = blind scan) ====="
WAIT=10 ./at.py 'AT+QNWLOCK="common/5g"' 'AT+QNWPREFCFG="nr5g_band"'

echo
echo "===== per-antenna RSRP (-140 on all = no RF / antenna problem) ====="
WAIT=10 ./at.py 'AT+QRSRP' 'AT+QRSRQ'

echo
echo "===== full 5G band scan - THIS TAKES 2-4 MINUTES, be patient ====="
WAIT=240 ./at.py 'AT+QSCAN=3,1'

echo
echo "===== operator scan - another 2-3 minutes ====="
WAIT=200 ./at.py 'AT+COPS=?'
