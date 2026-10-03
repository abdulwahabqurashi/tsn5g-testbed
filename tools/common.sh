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
