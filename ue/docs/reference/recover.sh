#!/bin/bash
# RECOVERY 2: nr5g_band is stuck at 0. Ask the modem for the accepted syntax
# (test command), then retry the write with the radio offline - several Quectel
# QNWPREFCFG parameters only commit while CFUN=0.
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"

echo "===== 1. what syntax does this firmware accept? ====="
WAIT=20 ./at.py 'AT+QNWPREFCFG=?'

echo
echo "===== 2. what does the module support / report now ====="
WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_band"' 'AT+QNWPREFCFG="lte_band"' \
                'AT+QNWPREFCFG="mode_pref"' 'AT+CGMR'

echo
echo "===== 3. retry the write with the radio OFFLINE ====="
WAIT=20 ./at.py 'AT+CFUN=0'
sleep 3
for v in '78' '1:78' '2:78' '0x2000000000000000000' '1:3:7:8:20:28:38:40:41:77:78:79'; do
    WAIT=15 ./at.py "AT+QNWPREFCFG=\"nr5g_band\",$v" 2>/dev/null | tail -1
    now=$(WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_band"' | grep -o '"nr5g_band",[^ |]*' | cut -d, -f2)
    echo "  -> after setting [$v] reads: ${now:-?}"
    case "$now" in ''|0) ;; *) echo "  RESTORED as $now"; break ;; esac
done
WAIT=20 ./at.py 'AT+CFUN=1'
sleep 5

echo
echo "===== 4. final ====="
WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_band"' 'AT+QNWPREFCFG="mode_pref"' \
                'AT+QNWPREFCFG="nr5g_disable_mode"'
echo
echo "If nr5g_band is STILL 0, the fallback is a modem-side config reset:"
echo "  sudo ./at.py 'AT+QPRTPARA=3'    # restore NV to defaults, then AT+CFUN=1,1"
echo "Do NOT run that without reading the note in the chat first."
