#!/bin/bash
# Which NIC is cabled to the USRP X410? Brings every physical NIC up, then
# shows module (DAC/transceiver) presence, link and speed. Use the answer for
# X410_HOST_IF in site.env, and its NUMA node for GNB_NUMA_NODE.
#
#   sudo core/scripts/x410-find-nic.sh
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
nics=$(for d in /sys/class/net/*; do [ -e "$d/device" ] && basename "$d"; done)
for n in $nics; do ip link set "$n" up 2>/dev/null; done
echo "waiting 6 s for link negotiation..."; sleep 6
printf "\n  %-16s %-5s %-10s %-5s %s\n" NIC LINK SPEED NUMA MODULE
for n in $nics; do
    ld=$(ethtool "$n" 2>/dev/null | awk '/Link detected/ {print $3}')
    sp=$(ethtool "$n" 2>/dev/null | awk '/Speed:/ {print $2}')
    numa=$(cat "/sys/class/net/$n/device/numa_node" 2>/dev/null)
    mod=$(ethtool -m "$n" 2>/dev/null | awk -F: '/Vendor name|Cable type/ {gsub(/^ +/,"",$2); printf "%s ", $2}')
    printf "  %-16s %-5s %-10s %-5s %s\n" "$n" "${ld:-?}" "${sp:-?}" "${numa:-?}" "${mod:--}"
done
echo
echo "The X410 NIC has LINK yes at 10000Mb/s (or more) and a DAC/transceiver listed."
echo "The X410 answers at 192.168.10.2 by default (X410_ADDR); give the host an address in that /24."
