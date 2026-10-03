#!/bin/bash
# End-to-end UE bring-up: clear contention, confirm SA config, wait for a cell,
# start the data call, verify the data plane.   sudo ./connect.sh
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"

echo "===== 1. take competing services out of the way ====="
# ModemManager is D-Bus activated: `stop` alone does NOT hold it down - NetworkManager
# or any mmcli call restarts it within seconds, and it then rewrites nr5g_disable_mode
# back to 2 (SA disabled). Masking is what actually keeps it off the modem.
systemctl mask --now ModemManager 2>/dev/null
systemctl stop tsn5g-ue 2>/dev/null
for s in ModemManager tsn5g-ue; do printf '  %-14s %s\n' "$s" "$(systemctl is-active $s)"; done
echo "  (undo later with: sudo systemctl unmask ModemManager)"

echo
echo "===== 2. confirm SA-only config survived ====="
# VERIFIED 2026-09-08: this modem (RM520NGLAAR03A01M4G) only operates on SA with
# nr5g_disable_mode=0. Values 1 and 2 both prevent camping, and 1 additionally
# causes writes to nr5g_band to be silently rejected. Do NOT "restore" it to 1.
mode=$(WAIT=10 ./at.py 'AT+QNWPREFCFG="nr5g_disable_mode"' | grep -o 'nr5g_disable_mode",[0-9]' | cut -d, -f2)
band=$(WAIT=10 ./at.py 'AT+QNWPREFCFG="nr5g_band"' | grep -o '"nr5g_band",[^ |]*' | cut -d, -f2)
echo "  nr5g_disable_mode = ${mode:-unknown}  (must be 0)"
echo "  nr5g_band         = ${band:-unknown}  (must contain 78)"
if [ "$mode" != "0" ]; then
    echo "  wrong value - setting to 0"
    WAIT=10 ./at.py 'AT+QNWPREFCFG="nr5g_disable_mode",0' >/dev/null
fi

echo
echo "===== 3. waiting up to 120s for a serving cell ====="
camped=0
for i in $(seq 1 24); do
    out=$(WAIT=8 ./at.py 'AT+QENG="servingcell"' 'AT+CSQ' 2>/dev/null)
    cell=$(echo "$out" | grep -o '+QENG:.*' | head -1)
    csq=$(echo "$out"  | grep -o '+CSQ:[^|]*' | head -1)
    echo "  [$((i*5))s] $cell   $csq"
    if echo "$cell" | grep -q 'NR5G-SA'; then camped=1; break; fi
    sleep 5
done

if [ "$camped" != "1" ]; then
    echo
    echo "STILL NO CELL. The UE is configured correctly (SA, n78, APN usrptsn) but hears"
    echo "nothing. Check on the gNB host: is the cell actually radiating (USRP streaming,"
    echo "no underflow), and is it on band n78 with PLMN 00102?"
    exit 1
fi

echo
echo "===== 4. camped - starting the data call ====="
./ue_qmi_up.sh up || exit 1

echo
echo "===== 5. verifying the data plane ====="
ip -br addr show wwan0 | sed 's/^/  /'
echo "  --- ping core 10.45.0.1 ---"
ping -I wwan0 -c3 -W3 10.45.0.1 2>&1 | sed 's/^/  /'
