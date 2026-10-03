#!/bin/bash
# Forces a registration attempt with timestamps, so it can be correlated against
# the gNB log. If the gNB logs NO PRACH/RRC attempt in this window, the UE's
# transmit path is dead (MAIN antenna). If it logs attempts that fail, uplink is
# marginal rather than absent.
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")"
systemctl stop tsn5g-ue 2>/dev/null

echo "WINDOW OPENS: $(date '+%H:%M:%S')  <-- grep the gNB log from here"
WAIT=15 ./at.py 'AT+COPS=2'                  # deregister first
sleep 2
echo "FORCING ATTEMPT: $(date '+%H:%M:%S')"
WAIT=120 ./at.py 'AT+COPS=1,2,"00102"'
echo "ATTEMPT RETURNED: $(date '+%H:%M:%S')"
WAIT=15 ./at.py 'AT+QENG="servingcell"' 'AT+C5GREG?' 'AT+CSQ' 'AT+CEER'
WAIT=15 ./at.py 'AT+COPS=0'                  # back to automatic
echo "WINDOW CLOSES: $(date '+%H:%M:%S')"
