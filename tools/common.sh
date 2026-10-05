# Sourced by every measurement tool: the site's names for things, from site.env.
# Override any of them per run, e.g.  CORE_SSH=me@10.0.0.5 ./demo-run.sh
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/../ue/scripts/site-env.sh"

WWAN=${WWAN:-${MODEM_WWAN:-wwan0}}                                  # the modem's data interface
CORE_SSH=${CORE_SSH:-${CORE_USER:-tsn_server}@${CORE_LAN_IP:-10.5.1.19}}  # ssh target for the core
CORE_IP=${CORE_IP:-${CORE_BEARER_IP:-10.45.0.1}}                   # the core across the bearer
GBR_PORT=${GBR_SOURCE_PORT:-5202}                                  # source port of the GBR flow
CAM1_PORT=${CAM1_PORT:-50451}
CAM2_PORT=${CAM2_PORT:-50452}
API=${API:-http://localhost:${API_PORT:-8080}}
ENCODER_SCRIPT=${PREFIX:-/opt/tsn5g}/ue/scripts/cameras-start.sh
# not installed yet (first rig before install.sh ue): the checkout's copy
[ -x "$ENCODER_SCRIPT" ] || ENCODER_SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ue/scripts/cameras-start.sh
export CAM1_PORT CAM2_PORT GBR_PORT

# Started from the console: the daemon is root, but the SSH key to the core is
# the desktop user's. Run ssh and scp as that user so their key, config and
# known_hosts are used; sudo needs no password as root.
if [ "$(id -u)" -eq 0 ] && [ -n "${TSN5G_AS_USER:-}" ]; then
    ssh() { runuser -u "$TSN5G_AS_USER" -- ssh "$@"; }
    scp() { runuser -u "$TSN5G_AS_USER" -- scp "$@"; }
    export -f ssh scp
fi

# core_capture SECONDS PCAP 'TCPDUMP ARGS': start a capture on the core in the
# background. Without a password if the core allows it (tcpdump with
# capabilities, or a NOPASSWD rule; see core/README.md "Captures for the UE's
# tests"); otherwise asks for the core's sudo password, which only works from a
# terminal.
core_capture() {
    local secs=$1 pcap=$2 args=$3
    if ssh -o BatchMode=yes "$CORE_SSH" "getcap \$(command -v tcpdump) 2>/dev/null | grep -q cap_net_raw && id -nG | grep -qw pcap" 2>/dev/null; then
        ssh -o BatchMode=yes "$CORE_SSH" "nohup timeout $secs tcpdump $args -w $pcap >/dev/null 2>&1 </dev/null &"
    elif ssh -o BatchMode=yes "$CORE_SSH" "sudo -n tcpdump --version" >/dev/null 2>&1; then
        ssh -o BatchMode=yes "$CORE_SSH" "nohup timeout $secs sudo -n tcpdump $args -w $pcap >/dev/null 2>&1 </dev/null &"
    elif [ -t 0 ]; then
        echo "(the core's sudo password)"
        ssh -t "$CORE_SSH" "sudo -b timeout $secs tcpdump $args -w $pcap >/dev/null 2>&1"
    else
        echo "error: the core does not allow a capture without a password. On the core, once:" >&2
        echo "  sudo groupadd -f pcap && sudo usermod -aG pcap \$USER && sudo chgrp pcap /usr/bin/tcpdump" >&2
        echo "  sudo chmod 750 /usr/bin/tcpdump && sudo setcap cap_net_raw,cap_net_admin=eip /usr/bin/tcpdump" >&2
        return 1
    fi || return 1
    sleep 2
    ssh -o BatchMode=yes "$CORE_SSH" "test -e $pcap" || { echo "error: the capture did not start on the core" >&2; return 1; }
}
