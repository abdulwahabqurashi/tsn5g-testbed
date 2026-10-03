#!/bin/bash
#
# Open5GS Core + WebUI startup script
# Usage: sudo ./run5gs.sh [start|stop|status|restart|logs]
#

BASEDIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$BASEDIR/build"
CONFIGS="$BUILD/configs/open5gs"
LOGDIR="/var/local/log/open5gs"
WEBUI_DIR="$BASEDIR/webui"
WEBUI_ADDR="10.5.1.19"   # this host's management IP (was 10.5.0.84)

# Auto-detect node path from SUDO_USER's nvm or system PATH
if [ -n "$SUDO_USER" ]; then
    USER_HOME=$(eval echo "~$SUDO_USER")
    NVM_NODE=$(ls -d "$USER_HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -1)
    if [ -n "$NVM_NODE" ]; then
        NODE_DIR="$NVM_NODE"
    else
        NODE_DIR="$(dirname "$(which node 2>/dev/null)")"
    fi
else
    NODE_DIR="$(dirname "$(which node 2>/dev/null)")"
fi

NFS_5G="nrf scp ausf udm udr pcf nssf bsf amf smf upf tsn-af"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_root() {
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}This script must be run as root (sudo)${NC}"
        exit 1
    fi
}

setup_logs() {
    mkdir -p "$LOGDIR"
    chmod 777 "$LOGDIR"
    for nf in $NFS_5G; do
        touch "$LOGDIR/${nf}.log"
        chmod 666 "$LOGDIR/${nf}.log"
    done
    touch "$LOGDIR/webui.log"
    chmod 666 "$LOGDIR/webui.log"
}

setup_tun() {
    if ! ip link show ogstun &>/dev/null; then
        echo -e "${YELLOW}Creating ogstun...${NC}"
        ip tuntap add name ogstun mode tun
        ip addr add 10.45.0.1/16 dev ogstun
        ip addr add 2001:db8:cafe::1/48 dev ogstun
        ip link set ogstun up
    else
        echo -e "${GREEN}ogstun already exists${NC}"
    fi
    if ! ip link show ogstap &>/dev/null; then
        echo -e "${YELLOW}Creating ogstap (Ethernet PDU sessions)...${NC}"
        ip tuntap add name ogstap mode tap
        ip link set ogstap up
    else
        echo -e "${GREEN}ogstap already exists${NC}"
        ip link set ogstap up 2>/dev/null
    fi
}

start_mongodb() {
    if ! systemctl is-active --quiet mongod; then
        echo -e "${YELLOW}Starting MongoDB...${NC}"
        systemctl start mongod
        sleep 1
        if systemctl is-active --quiet mongod; then
            echo -e "${GREEN}MongoDB started${NC}"
        else
            echo -e "${RED}MongoDB failed to start${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}MongoDB already running${NC}"
    fi
}

start_core() {
    cd "$BASEDIR"
    echo ""
    echo "=== Starting 5G Core NFs ==="
    for nf in $NFS_5G; do
        local bin="$BUILD/src/$nf/open5gs-${nf}d"
        local cfg="$CONFIGS/${nf}.yaml"

        if [ ! -f "$bin" ]; then
            echo -e "${RED}Binary not found: $bin${NC}"
            continue
        fi
        if [ ! -f "$cfg" ]; then
            echo -e "${RED}Config not found: $cfg${NC}"
            continue
        fi

        if pgrep -x "open5gs-${nf}d" &>/dev/null; then
            echo -e "${GREEN}  $nf: already running${NC}"
            continue
        fi

        # Clear old log before starting
        > "$LOGDIR/${nf}.log" 2>/dev/null

        "$bin" -c "$cfg" -D
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}  $nf: started${NC}"
        else
            echo -e "${RED}  $nf: FAILED${NC}"
        fi

        # Give NRF time to be ready
        if [ "$nf" = "nrf" ]; then
            sleep 1
        fi
    done

    # Verify logs are being written
    sleep 2
    local missing_logs=""
    for nf in $NFS_5G; do
        if pgrep -x "open5gs-${nf}d" &>/dev/null; then
            if [ ! -s "$LOGDIR/${nf}.log" ]; then
                missing_logs="$missing_logs $nf"
            fi
        fi
    done
    if [ -n "$missing_logs" ]; then
        echo -e "${YELLOW}  Warning: No log output yet for:${missing_logs}${NC}"
    fi
}

start_webui() {
    echo ""
    echo "=== Starting WebUI ==="
    if pgrep -f "node.*server/index" &>/dev/null; then
        echo -e "${GREEN}WebUI already running${NC}"
        return
    fi

    if [ -z "$NODE_DIR" ] || [ ! -f "$NODE_DIR/node" ]; then
        echo -e "${RED}Node.js not found. Install Node.js or nvm first.${NC}"
        return
    fi

    if [ ! -d "$WEBUI_DIR/node_modules" ]; then
        echo -e "${YELLOW}Installing WebUI dependencies...${NC}"
        (cd "$WEBUI_DIR" && sudo -u "$SUDO_USER" env PATH="$NODE_DIR:$PATH" "$NODE_DIR/npm" install --legacy-peer-deps 2>/dev/null)
    fi

    > "$LOGDIR/webui.log" 2>/dev/null
    (cd "$WEBUI_DIR" && sudo -u "$SUDO_USER" env PATH="$NODE_DIR:$PATH" HOSTNAME="$WEBUI_ADDR" nohup "$NODE_DIR/npm" run dev > "$LOGDIR/webui.log" 2>&1 &)
    sleep 2

    if pgrep -f "node.*server/index" &>/dev/null; then
        echo -e "${GREEN}WebUI started at http://$WEBUI_ADDR:9999${NC}"
    else
        echo -e "${YELLOW}WebUI starting (check $LOGDIR/webui.log)${NC}"
    fi
}

stop_all() {
    echo "=== Stopping all Open5GS services ==="

    # Stop WebUI
    pkill -f "node.*webui" 2>/dev/null
    pkill -f "node.*server/index" 2>/dev/null
    echo "  WebUI: stopped"

    # Stop NFs in reverse order
    for nf in $(echo "$NFS_5G" | tr ' ' '\n' | tac); do
        pkill -x "open5gs-${nf}d" 2>/dev/null
    done

    sleep 2

    # Force kill anything remaining
    local remaining=$(pgrep -f "open5gs-.*d" 2>/dev/null)
    if [ -n "$remaining" ]; then
        echo -e "${YELLOW}  Force killing remaining processes...${NC}"
        pkill -9 -f "open5gs-.*d" 2>/dev/null
        sleep 1
    fi

    # Verify
    for nf in $NFS_5G; do
        if pgrep -x "open5gs-${nf}d" &>/dev/null; then
            echo -e "  ${RED}$nf: still running!${NC}"
        else
            echo -e "  ${GREEN}$nf: stopped${NC}"
        fi
    done

    echo "Done. (MongoDB left running)"
}

show_status() {
    echo "=== Open5GS Service Status ==="
    echo ""

    if systemctl is-active --quiet mongod; then
        echo -e "  ${GREEN}mongodb:  running${NC}"
    else
        echo -e "  ${RED}mongodb:  stopped${NC}"
    fi

    if ip link show ogstun &>/dev/null; then
        echo -e "  ${GREEN}ogstun:   up${NC}"
    else
        echo -e "  ${RED}ogstun:   missing${NC}"
    fi

    echo ""

    for nf in $NFS_5G; do
        pid=$(pgrep -x "open5gs-${nf}d" 2>/dev/null)
        if [ -n "$pid" ]; then
            local logsize=$(stat -c%s "$LOGDIR/${nf}.log" 2>/dev/null || echo "0")
            echo -e "  ${GREEN}$nf:$(printf '%*s' $((8 - ${#nf})) '') running (PID $pid, log ${logsize}B)${NC}"
        else
            echo -e "  ${RED}$nf:$(printf '%*s' $((8 - ${#nf})) '') stopped${NC}"
        fi
    done

    echo ""

    pid=$(pgrep -f "node.*server/index" 2>/dev/null)
    if [ -n "$pid" ]; then
        echo -e "  ${GREEN}webui:    running (PID $pid) -> http://$WEBUI_ADDR:9999${NC}"
    else
        echo -e "  ${RED}webui:    stopped${NC}"
    fi
}

show_logs() {
    local nf="${2:-all}"
    if [ "$nf" = "all" ]; then
        echo "=== Tailing all logs (Ctrl+C to stop) ==="
        tail -f "$LOGDIR"/*.log
    else
        if [ -f "$LOGDIR/${nf}.log" ]; then
            echo "=== Tailing $nf log (Ctrl+C to stop) ==="
            tail -f "$LOGDIR/${nf}.log"
        else
            echo -e "${RED}Log file not found: $LOGDIR/${nf}.log${NC}"
            echo "Available: $(ls "$LOGDIR"/*.log 2>/dev/null | xargs -n1 basename | sed 's/.log//' | tr '\n' ' ')"
        fi
    fi
}

case "${1:-start}" in
    start)
        check_root
        setup_logs
        start_mongodb
        setup_tun
        start_core
        start_webui
        echo ""
        show_status
        ;;
    stop)
        check_root
        stop_all
        ;;
    status)
        show_status
        ;;
    restart)
        check_root
        stop_all
        sleep 1
        setup_logs
        start_mongodb
        setup_tun
        start_core
        start_webui
        echo ""
        show_status
        ;;
    logs)
        show_logs "$@"
        ;;
    *)
        echo "Usage: sudo $0 {start|stop|status|restart|logs [nf-name]}"
        echo ""
        echo "Examples:"
        echo "  sudo $0 start          # Start all services"
        echo "  sudo $0 stop           # Stop all services"
        echo "  sudo $0 restart        # Restart all services"
        echo "  sudo $0 status         # Show status (with log sizes)"
        echo "  sudo $0 logs           # Tail all logs"
        echo "  sudo $0 logs smf       # Tail SMF log only"
        echo "  sudo $0 logs amf       # Tail AMF log only"
        exit 1
        ;;
esac
