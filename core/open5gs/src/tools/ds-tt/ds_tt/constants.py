"""
Constants for DS-TT — mirrors definitions from src/upf/nwtt.h.
"""

# IEEE 802.1AS / gPTP EtherTypes
ETHERTYPE_PTP = 0x88F7
ETHERTYPE_LLDP = 0x88CC
ETHERTYPE_8021Q = 0x8100  # 802.1Q VLAN tag

# PTP message types (IEEE 1588 / 802.1AS)
PTP_MSG_SYNC = 0x0
PTP_MSG_DELAY_REQ = 0x1
PTP_MSG_PDELAY_REQ = 0x2
PTP_MSG_PDELAY_RESP = 0x3
PTP_MSG_FOLLOW_UP = 0x8
PTP_MSG_DELAY_RESP = 0x9
PTP_MSG_PDELAY_RESP_FUP = 0xA
PTP_MSG_ANNOUNCE = 0xB
PTP_MSG_SIGNALING = 0xC
PTP_MSG_MANAGEMENT = 0xD

PTP_MSG_NAMES = {
    PTP_MSG_SYNC: "Sync",
    PTP_MSG_DELAY_REQ: "Delay_Req",
    PTP_MSG_PDELAY_REQ: "Pdelay_Req",
    PTP_MSG_PDELAY_RESP: "Pdelay_Resp",
    PTP_MSG_FOLLOW_UP: "Follow_Up",
    PTP_MSG_DELAY_RESP: "Delay_Resp",
    PTP_MSG_PDELAY_RESP_FUP: "Pdelay_Resp_Follow_Up",
    PTP_MSG_ANNOUNCE: "Announce",
    PTP_MSG_SIGNALING: "Signaling",
    PTP_MSG_MANAGEMENT: "Management",
}

# LLDP TLV types
LLDP_TLV_END = 0
LLDP_TLV_CHASSIS_ID = 1
LLDP_TLV_PORT_ID = 2
LLDP_TLV_TTL = 3

# Ethernet header length
ETHER_HDR_LEN = 14

# 802.1Q VLAN tag length (TPID + TCI)
VLAN_TAG_LEN = 4

# gPTP multicast destination MAC (IEEE 802.1AS)
GPTP_MULTICAST_MAC = "01:80:c2:00:00:0e"

# LLDP multicast destination MAC
LLDP_MULTICAST_MAC = "01:80:c2:00:00:0e"

# Bridge group_fwd_mask bit for LLDP (bit 14)
LLDP_GROUP_FWD_MASK = 0x4000

# Default PCP-to-QFI mapping (3GPP TS 23.501 Table 5.7.4-1)
DEFAULT_PCP_QFI_MAP = {
    0: 1,   # Best Effort → QFI 1
    1: 2,   # Background → QFI 2
    2: 3,   # Excellent Effort → QFI 3
    3: 4,   # Critical Applications → QFI 4
    4: 5,   # Video → QFI 5
    5: 6,   # Voice → QFI 6
    6: 7,   # Internetwork Control → QFI 7
    7: 8,   # Network Control → QFI 8
}

# Quectel RM520N modem constants
MODEM_BAUD_RATE = 115200
MODEM_TIMEOUT = 5  # seconds
MODEM_INIT_RETRY_INTERVAL = 3  # seconds
MODEM_MAX_INIT_RETRIES = 20

# 5G registration check interval
REG_CHECK_INTERVAL = 2  # seconds

# Health check interval
HEALTH_CHECK_INTERVAL = 5  # seconds

# Stats collection interval
STATS_INTERVAL = 2  # seconds
