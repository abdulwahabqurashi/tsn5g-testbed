#!/bin/bash
# Report which high-speed ports have a transceiver/DAC cable plugged in.
NICS="enp37s0f0np0 enp37s0f1np1 enp69s0f0np0 enp69s0f1np1 enp110s0f0np0 enp110s0f1np1 enp109s0f0np0 enp109s0f1np1 eno1np0 eno2np1"

for n in $NICS; do
    echo "==================== $n ===================="
    out=$(ethtool -m "$n" 2>&1)
    if echo "$out" | grep -qiE "Identifier|Vendor|Cable type|Transceiver"; then
        echo "$out" | grep -iE "Identifier|Vendor name|Vendor PN|Cable type|Cable length|Transceiver type|Connector" | head -8
        echo "  --> MODULE/CABLE PRESENT"
    else
        echo "$out" | head -2
        echo "  --> no module (empty port) or not readable"
    fi
done
