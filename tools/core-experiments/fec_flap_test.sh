#!/bin/bash
# Sweep FEC modes on the Broadcom breakout legs, flapping the link after each
# change so the 10G DAC re-negotiates, and report carrier/link/active-FEC.
# The X410 side is fixed (autoneg on, 10G); we just need one server leg to lock.

LEGS="enp69s0f0np0 enp69s0f1np1"

for IF in $LEGS; do
  echo "==================== $IF ===================="
  ethtool -s "$IF" speed 10000 autoneg off 2>/dev/null
  sleep 2
  for fec in off baser rs auto; do
    ethtool --set-fec "$IF" encoding "$fec" 2>/dev/null
    ip link set "$IF" down; sleep 1; ip link set "$IF" up
    sleep 6
    car=$(cat /sys/class/net/$IF/carrier 2>/dev/null)
    ld=$(ethtool "$IF" 2>/dev/null | awk -F': ' '/Link detected/{print $2}')
    afec=$(ethtool --show-fec "$IF" 2>/dev/null | awk -F': ' '/Active/{print $2}')
    sp=$(ethtool "$IF" 2>/dev/null | awk -F': ' '/Speed:/{print $2}')
    printf "  fec=%-6s carrier=%-2s link=%-4s speed=%-10s active_fec=%s\n" \
           "$fec" "${car:-?}" "${ld:-?}" "${sp:-?}" "${afec:-?}"
  done
done
echo "==================== done ===================="
echo "If any line shows carrier=1 / link=yes, that FEC mode is the winner."