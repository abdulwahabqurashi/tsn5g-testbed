#!/bin/bash
# RECOVERY: force5g.sh zeroed the NR band mask (nr5g_band -> 0), leaving the
# modem with no 5G bands to search. Restore it. The Quectel value is a
# colon-separated band list; try the syntaxes and keep whichever reads back.
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"

echo "===== current (expect nr5g_band = 0) ====="
WAIT=10 ./at.py 'AT+QNWPREFCFG="nr5g_band"' 'AT+QNWPREFCFG="mode_pref"'

echo
echo "===== trying to restore the band list ====="
for v in '78' '"78"' '1:3:7:8:20:28:38:40:41:77:78:79' '"1:3:7:8:20:28:38:40:41:77:78:79"'; do
    WAIT=10 ./at.py "AT+QNWPREFCFG=\"nr5g_band\",$v" >/dev/null 2>&1
    now=$(WAIT=10 ./at.py 'AT+QNWPREFCFG="nr5g_band"' | grep -o 'nr5g_band",[^ |]*' | cut -d, -f2)
    echo "  set $v  ->  reads back: ${now:-?}"
    case "$now" in ''|0) ;; *) echo "  RESTORED"; break ;; esac
done

echo
echo "===== final state ====="
WAIT=10 ./at.py 'AT+QNWPREFCFG="nr5g_band"' 'AT+QNWPREFCFG="mode_pref"' \
                'AT+QNWPREFCFG="nr5g_disable_mode"' 'AT+COPS?'

echo
echo "===== radio cycle + 60s watch ====="
WAIT=15 ./at.py 'AT+CFUN=0' >/dev/null; sleep 2
WAIT=15 ./at.py 'AT+CFUN=1' >/dev/null; sleep 5
for i in $(seq 1 12); do
    out=$(WAIT=8 ./at.py 'AT+QENG="servingcell"' 'AT+CSQ' 2>/dev/null \
          | grep -oE '\+QENG:[^|]*|\+CSQ:[^|]*' | tr '\n' ' ')
    echo "  [$((i*5))s] $out"
    echo "$out" | grep -q 'NR5G-SA' && { echo "CAMPED"; exit 0; }
    sleep 5
done
