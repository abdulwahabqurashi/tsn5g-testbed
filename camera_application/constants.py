"""
Constants shared across the daemon.
"""

# ---- Lifecycle states (surfaced to the UI) --------------------------------
STATE_INITIALIZING = "initializing"   # process starting, loading config
STATE_IDLE = "idle"                   # hardware detected, not connected
STATE_CONNECTING = "connecting"       # running the attach->transport->gptp sequence
STATE_RUNNING = "running"             # fully up and forwarding
STATE_STOPPING = "stopping"           # tearing down
STATE_ERROR = "error"                 # failed; see last_error

# Fine-grained sub-steps reported during STATE_CONNECTING (drives the wizard progress)
STEP_MODEM = "modem"
STEP_TRANSPORT = "transport"
STEP_BRIDGE = "bridge"
STEP_LLDP = "lldp"
STEP_GPTP = "gptp"
STEP_DONE = "done"

CONNECT_STEPS = [STEP_MODEM, STEP_TRANSPORT, STEP_BRIDGE, STEP_LLDP, STEP_GPTP, STEP_DONE]

# ---- Transport modes ------------------------------------------------------
TRANSPORT_ETHERNET = "ethernet"
TRANSPORT_VXLAN = "vxlan"
TRANSPORT_MODES = (TRANSPORT_ETHERNET, TRANSPORT_VXLAN)

# ---- Timing ---------------------------------------------------------------
STATS_INTERVAL = 2.0          # seconds between stats reads
HEALTH_CHECK_INTERVAL = 5.0   # seconds between health checks
MAIN_LOOP_TICK = 0.5          # seconds

# ---- FS TSN3220 hardware limits (802.1Qbv gate control list) --------------
QBV_INTERVAL_MAX_NS = 262136  # max interval per control-list node
QBV_MAX_NODES = 16            # max nodes per interface

# Common TAI base-time anchor so independent switches start their cycles in phase
# once PTP has synchronised their local clocks.
QBV_COMMON_BASE_SEC = 101600
QBV_COMMON_BASE_NS = 0

# ---- Defaults -------------------------------------------------------------
DEFAULT_API_PORT = 8080
DEFAULT_BRIDGE_NAME = "ds-tt-br0"
DEFAULT_LLDP_GROUP_FWD_MASK = 0x4000  # forward LLDP frames
VXLAN_MTU = 1450
