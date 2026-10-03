#!/bin/bash
# Try autoneg-ON (Clause 73) on the Broadcom breakout legs — how 25G-class ports
# normally establish a 10G-CR DAC link. Flap after each change and report.

LEGS="enp69s0f0np0 enp69s0f1np1"

for IF in $LEGS; do
  echo "==================== $IF ===================="

  echo "--- attempt 1: autoneg ON, advertise 10G ---"
  ethtool -s "$IF" autoneg on speed 10000 2>&1
  ip link set "$IF" down; sleep 1; ip link set "$IF" up
  sleep 7
  printf "  carrier=%s link=%s adv=[%s]\n" \
    "$(cat /sys/class/net/$IF/carrier)" \
    "$(ethtool $IF 2>/dev/null | awk -F': ' '/Link detected/{print $2}')" \
    "$(ethtool $IF 2>/dev/null | awk -F': ' '/Advertised link modes/{print $2}')"

  echo "--- attempt 2: autoneg ON, default advertise ---"
  ethtool -s "$IF" autoneg on 2>&1
  ip link set "$IF" down; sleep 1; ip link set "$IF" up
  sleep 7
  printf "  carrier=%s link=%s\n" \
    "$(cat /sys/class/net/$IF/carrier)" \
    "$(ethtool $IF 2>/dev/null | awk -F': ' '/Link detected/{print $2}')"
done
echo "==================== done ===================="