#!/bin/bash
# Day-to-day control of the Open5GS core (replaces the first rig's run5gs.sh).
#
#   open5gs-ctl.sh status            NFs, MongoDB, ogstun, WebUI at a glance
#   sudo open5gs-ctl.sh start|stop|restart
#   open5gs-ctl.sh logs [nf]         tail one NF's log, or all of them
#
# The NFs are systemd units (open5gs@<nf>.service, pulled in by open5gs.target),
# so they start at boot and restart if one dies.
NFS="nrf scp ausf udm udr pcf nssf bsf amf smf upf tsn-af"
LOGDIR=/var/local/log/open5gs
case "${1:-status}" in
    start|stop|restart) exec systemctl "$1" open5gs.target ;;
    logs)
        if [ -n "${2:-}" ]; then exec tail -f "$LOGDIR/$2.log"; else exec tail -f "$LOGDIR"/*.log; fi ;;
    status)
        printf "  %-8s %s\n" mongod "$(systemctl is-active mongod)"
        printf "  %-8s %s\n" ogstun "$(ip -br addr show ogstun 2>/dev/null | awk '{print $2, $3}' || echo missing)"
        for nf in $NFS; do
            printf "  %-8s %s\n" "$nf" "$(systemctl is-active "open5gs@$nf")"
        done
        printf "  %-8s %s\n" webui "$(systemctl is-active open5gs-webui)"
        printf "  %-8s %s\n" gnb "$(systemctl is-active srsran-gnb)" ;;
    *) echo "usage: $0 status|start|stop|restart|logs [nf]" >&2; exit 2 ;;
esac
