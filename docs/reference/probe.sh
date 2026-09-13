#!/bin/bash
# nr5g_band writes return OK but never commit, and restore_band did nothing.
# Check whether a band policy is clamping it, then try ordered write sequences.
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"

rd() { WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_band"' | grep -o '"nr5g_band",[^ |]*' | cut -d, -f2; }

echo "===== 1. is a policy clamping the band list? ====="
WAIT=20 ./at.py 'AT+QNWPREFCFG="policy_band"' 'AT+QNWPREFCFG="policy_mode"' \
                'AT+QNWPREFCFG="rat_acq_order"' 'AT+QNWPREFCFG="nrdc_mode"' \
                'AT+QNWPREFCFG="nrdc_nr5g_band"' 'AT+QNWPREFCFG="srv_domain"'

echo
echo "===== 2. try: enable SA+NSA first, then write the band ====="
WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_disable_mode",0' >/dev/null
WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_band",78' >/dev/null
echo "  reads: $(rd)"

echo
echo "===== 3. try: set mode_pref to NR5G first, then the band ====="
WAIT=15 ./at.py 'AT+QNWPREFCFG="mode_pref",NR5G' >/dev/null
WAIT=15 ./at.py 'AT+QNWPREFCFG="nr5g_band",78' >/dev/null
echo "  reads: $(rd)"

echo
echo "===== 4. try: write the full supported SA list verbatim from rf_band ====="
FULL='1:2:3:5:7:8:12:13:14:18:20:25:26:28:29:30:38:40:41:48:66:70:71:75:76:77:78:79'
WAIT=20 ./at.py "AT+QNWPREFCFG=\"nr5g_band\",$FULL" >/dev/null
echo "  reads: $(rd)"

echo
echo "===== 5. try: mirror it from nsa_nr5g_band ====="
WAIT=20 ./at.py "AT+QNWPREFCFG=\"nsa_nr5g_band\",$FULL" 'AT+QNWPREFCFG="nsa_nr5g_band"' >/dev/null
WAIT=20 ./at.py "AT+QNWPREFCFG=\"nr5g_band\",$FULL" >/dev/null
echo "  reads: $(rd)"

echo
echo "===== final state ====="
WAIT=20 ./at.py 'AT+QNWPREFCFG="nr5g_band"' 'AT+QNWPREFCFG="nsa_nr5g_band"' \
                'AT+QNWPREFCFG="mode_pref"' 'AT+QNWPREFCFG="nr5g_disable_mode"'
