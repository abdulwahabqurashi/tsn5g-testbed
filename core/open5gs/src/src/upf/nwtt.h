/*
 * Copyright (C) 2024 by Open5GS Contributors
 *
 * This file is part of Open5GS.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#ifndef UPF_NWTT_H
#define UPF_NWTT_H

#include "ogs-core.h"

#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Hardware-synced nanosecond timestamp clock sources */
#define UPF_NWTT_CLOCK_SOFTWARE     0   /* gettimeofday (us precision) */
#define UPF_NWTT_CLOCK_MONOTONIC    1   /* CLOCK_MONOTONIC_RAW (ns, no NTP) */
#define UPF_NWTT_CLOCK_REALTIME     2   /* CLOCK_REALTIME (ns, PHC-synced) */

/* IEEE 802.1AS / gPTP constants */
#define ETHERTYPE_PTP               0x88F7
#define ETHERTYPE_LLDP              0x88CC

/* PTP message types (IEEE 1588 / 802.1AS) */
#define PTP_MSG_SYNC                0x0
#define PTP_MSG_DELAY_REQ           0x1
#define PTP_MSG_PDELAY_REQ          0x2
#define PTP_MSG_PDELAY_RESP         0x3
#define PTP_MSG_FOLLOW_UP           0x8
#define PTP_MSG_DELAY_RESP          0x9
#define PTP_MSG_PDELAY_RESP_FUP     0xA
#define PTP_MSG_ANNOUNCE            0xB
#define PTP_MSG_SIGNALING           0xC
#define PTP_MSG_MANAGEMENT          0xD

/* Maximum stream filter entries per NW-TT port */
#define UPF_NWTT_MAX_STREAM_FILTERS 16

/* Maximum de-jitter queue depth */
#define UPF_NWTT_MAX_DEJITTER_QUEUE 64

/* Ethernet header length */
#define ETHER_HDR_LEN_SIZE          14

/* PTP header (IEEE 1588-2008 / 802.1AS) - packed for wire format */
typedef struct upf_ptp_header_s {
    uint8_t     msg_type:4;
    uint8_t     transport_specific:4;
    uint8_t     version_ptp:4;
    uint8_t     reserved0:4;
    uint16_t    message_length;
    uint8_t     domain_number;
    uint8_t     reserved1;
    uint16_t    flags;
    int64_t     correction_field;   /* 48.16 fixed-point nanoseconds */
    uint32_t    reserved2;
    uint8_t     source_port_id[10]; /* clockIdentity(8) + portNumber(2) */
    uint16_t    sequence_id;
    uint8_t     control;
    int8_t      log_message_interval;
} __attribute__((packed)) upf_ptp_header_t;

/* Stream filter entry: dest MAC + VLAN ID for TSN stream identification */
typedef struct upf_nwtt_stream_filter_s {
    ogs_lnode_t lnode;

    uint8_t     dest_mac[6];
    bool        vlan_present;
    uint16_t    vlan_id;
    bool        active;

    /* Per-filter match counters */
    uint64_t    match_count;
    uint64_t    match_bytes;
} upf_nwtt_stream_filter_t;

/* LLDP TLV types */
#define LLDP_TLV_END                0
#define LLDP_TLV_CHASSIS_ID         1
#define LLDP_TLV_PORT_ID            2
#define LLDP_TLV_TTL                3
#define LLDP_TLV_PORT_DESC          4
#define LLDP_TLV_SYS_NAME           5
#define LLDP_TLV_SYS_DESC           6
#define LLDP_TLV_SYS_CAP            7
#define LLDP_TLV_MGMT_ADDR          8

/* LLDP multicast destination MAC */
#define LLDP_MCAST_ADDR             {0x01, 0x80, 0xC2, 0x00, 0x00, 0x0E}
#define LLDP_DEFAULT_TTL            120
#define LLDP_TX_INTERVAL_SEC        30

/* LLDP parsed info */
typedef struct upf_nwtt_lldp_info_s {
    uint8_t chassis_id_subtype;
    uint8_t chassis_id[256];
    uint16_t chassis_id_len;
    uint8_t port_id_subtype;
    uint8_t port_id[256];
    uint16_t port_id_len;
    uint16_t ttl;
    char system_name[256];
    char system_desc[256];
    char port_desc[256];
} upf_nwtt_lldp_info_t;

/* PSFP meter (IEEE 802.1Qci) */
typedef struct upf_nwtt_meter_s {
    uint32_t committed_info_rate;    /* bps */
    uint32_t committed_burst_size;   /* bytes */
    uint64_t tokens;
    ogs_time_t last_update;
    bool active;
} upf_nwtt_meter_t;

/* De-jitter buffer entry */
typedef struct upf_nwtt_dejitter_entry_s {
    ogs_lnode_t lnode;
    ogs_pkbuf_t *pkbuf;
    uint64_t    ingress_time_ns;  /* nanosecond timestamp */
} upf_nwtt_dejitter_entry_t;

/* De-jitter buffer state */
typedef struct upf_nwtt_dejitter_s {
    bool        enabled;
    uint32_t    target_delay_us;    /* target hold time in microseconds */
    ogs_list_t  queue;              /* list of upf_nwtt_dejitter_entry_t */
    int         queue_depth;
    ogs_timer_t *timer;

    /* De-jitter buffer counters */
    uint64_t    enqueued;           /* total frames enqueued */
    uint64_t    dequeued;           /* total frames released */
    uint64_t    dropped_overflow;   /* drops due to queue full */
    int         peak_depth;         /* high watermark */
} upf_nwtt_dejitter_t;

/* Per-session NW-TT port */
typedef struct upf_nwtt_port_s {
    ogs_lnode_t lnode;

    uint32_t    port_number;
    uint8_t     mac_addr[6];

    /* Stream filter entries for this port */
    upf_nwtt_stream_filter_t filters[UPF_NWTT_MAX_STREAM_FILTERS];
    int         num_filters;

    /* Port management container (opaque TS 24.519 encoded bytes) */
    uint8_t     *port_mgmt_container;
    uint16_t    port_mgmt_container_len;

    /* QoS mapping: PCP → QFI */
    struct {
        uint8_t pcp;
        uint8_t qfi;
        bool active;
    } qos_mappings[8];
    int num_qos_mappings;

    /* Residence time statistics (nanosecond precision internally) */
    struct {
        uint64_t total_frames;
        int64_t  min_ns;
        int64_t  max_ns;
        int64_t  avg_ns;
        int64_t  last_ns;
    } residence_time_stats;

    /* Residence time histogram (microsecond buckets) */
    struct {
        uint64_t under_100;       /* < 100 us */
        uint64_t under_500;       /* 100-499 us */
        uint64_t under_1000;      /* 500-999 us */
        uint64_t under_5000;      /* 1-4.999 ms */
        uint64_t over_5000;       /* >= 5 ms */
    } rt_histogram;

    /* Per-port traffic counters */
    struct {
        uint64_t rx_frames;         /* frames received from GTP-U (egress to DN) */
        uint64_t tx_frames;         /* frames sent to GTP-U (ingress from DN) */
        uint64_t rx_bytes;
        uint64_t tx_bytes;
        uint64_t rx_gptp_frames;    /* gPTP frames processed */
        uint64_t rx_lldp_frames;    /* LLDP frames relayed */
        uint64_t mbr_dropped_frames; /* DL frames policed by QER MBR */
    } traffic;

    /* PSFP (802.1Qci) counters */
    struct {
        uint64_t passed_frames;
        uint64_t passed_bytes;
        uint64_t dropped_frames;
        uint64_t dropped_bytes;
    } psfp_stats;

    /* Inter-arrival jitter (RFC 3550 style, nanosecond precision) */
    struct {
        uint64_t last_arrival_ns;  /* timestamp of previous frame (ns) */
        int64_t  mean_interval_ns; /* EWMA of inter-arrival interval (ns) */
        int64_t  jitter_ns;        /* smoothed |interval - mean| = PDV (ns) */
        int64_t  peak_jitter_ns;
        uint64_t samples;
    } jitter;

    /* Per-PCP class counters (8 priority classes) */
    struct {
        uint64_t frames;
        uint64_t bytes;
    } pcp_stats[8];

    /* Frames matching no stream filter */
    uint64_t    filter_miss_count;

    /* PSFP meter */
    upf_nwtt_meter_t meter;

    /* De-jitter buffer state */
    upf_nwtt_dejitter_t dejitter;

    /* LLDP neighbor info (learned from UE or DN) */
    upf_nwtt_lldp_info_t lldp_neighbor;
    bool            lldp_neighbor_valid;

    /* Back-pointer to session pool id */
    ogs_pool_id_t sess_id;
} upf_nwtt_port_t;

/* Global NW-TT bridge state (one per UPF) */
typedef struct upf_nwtt_bridge_s {
    bool        enabled;

    /* Downlink MAC adaptation for routed-mode UEs (5G routers whose
     * modem only accepts downlink unicast addressed to its own MAC):
     * readdress downlink IP unicast to the session gateway MAC and
     * send ARP replies as broadcast. */
    bool        dl_mac_adapt;

    /* Bridge identification */
    uint32_t    bridge_id;
    uint8_t     bridge_mac[6];

    /* NW-TT ports (one per TSN session) */
    ogs_list_t  port_list;
    uint32_t    next_port_number;

    /* Bridge management container (opaque bytes) */
    uint8_t     *bridge_mgmt_container;
    uint16_t    bridge_mgmt_container_len;

    /* Default QoS mappings (PCP → QFI) from YAML config */
    struct {
        uint8_t pcp;
        uint8_t qfi;
        bool active;
    } default_qos_mappings[8];
    int num_default_qos_mappings;

    /* High-precision timestamp configuration */
    struct {
        int     clock_source;           /* UPF_NWTT_CLOCK_* */
        char    phc_interface[64];      /* NIC for PHC (e.g. "enp132s0") */
        bool    phc2sys_detected;       /* phc2sys process found */
    } timestamp;

    /* gPTP / IEEE 802.1AS state */
    struct {
        bool    enabled;
        uint8_t time_domain_number;
        /* linuxptp monitoring state */
        bool    monitoring_enabled;
        uint8_t transport_specific;
        ogs_timer_t *poll_timer;
        int64_t offset_from_master_ns;
        int64_t mean_path_delay_ns;
        char    gm_identity[20];
        bool    synced;
        bool    prev_synced;            /* previous state for transition detect */
        bool    degrade_on_unsync;      /* skip correction when unsynced */
        uint64_t corrections_skipped;   /* counter for skipped corrections */
        ogs_time_t last_poll_time;
    } gptp;

    /* LLDP periodic origination */
    ogs_timer_t *lldp_tx_timer;
} upf_nwtt_bridge_t;

/* Port management */
upf_nwtt_port_t *upf_nwtt_port_add(ogs_pool_id_t sess_id);
void upf_nwtt_port_remove(upf_nwtt_port_t *port);
upf_nwtt_port_t *upf_nwtt_port_find_by_number(uint32_t port_number);

/* TSC Management Information handling */
int upf_nwtt_handle_tsc_management_info(
        void *sess,
        uint8_t *port_mgmt_data, uint16_t port_mgmt_len,
        uint8_t *bridge_mgmt_data, uint16_t bridge_mgmt_len,
        uint8_t *nwtt_port_data, uint16_t nwtt_port_len);

/* Stream filter matching */
bool upf_nwtt_stream_filter_match(
        upf_nwtt_port_t *port, uint8_t *eth_frame, int len);

/* High-precision nanosecond timestamp */
uint64_t upf_nwtt_clock_gettime_ns(void);
void upf_nwtt_detect_phc2sys(void);
const char *upf_nwtt_clock_source_name(int clock_source);

/* gPTP frame handling */
bool upf_nwtt_is_gptp_frame(uint8_t *eth_frame, int len);
void upf_nwtt_gptp_add_residence_time(
        uint8_t *eth_frame, int len, uint64_t ingress_time_ns);

/* LLDP frame handling */
bool upf_nwtt_is_lldp_frame(uint8_t *eth_frame, int len);
int upf_nwtt_parse_lldp(uint8_t *eth_frame, int len,
        upf_nwtt_lldp_info_t *info);
int upf_nwtt_relay_lldp_frame(upf_nwtt_port_t *ingress_port,
        uint8_t *eth_frame, int len);

/* PCP classification (802.1Q priority) */
int upf_nwtt_classify_pcp(upf_nwtt_port_t *port,
        uint8_t *eth_frame, int len);

/* PSFP check */
bool upf_nwtt_psfp_check(upf_nwtt_port_t *port,
        uint8_t *eth_frame, int len);

/* Reverse QFI → PCP lookup. Returns PCP (0-7) or -1 if no mapping. */
int upf_nwtt_reverse_qfi_to_pcp(upf_nwtt_port_t *port, uint8_t qfi);

/* LLDP frame construction and origination */
int upf_nwtt_lldp_build_frame(uint8_t *buf, int max_len,
        upf_nwtt_port_t *port);
void upf_nwtt_lldp_originate(void);
void upf_nwtt_lldp_start_tx(void);
void upf_nwtt_lldp_stop_tx(void);

/* gPTP monitoring (linuxptp / pmc integration) */
void upf_nwtt_gptp_poll_status(void);
void upf_nwtt_gptp_start_monitoring(void);
void upf_nwtt_gptp_stop_monitoring(void);

/* De-jitter buffer */
int upf_nwtt_dejitter_enqueue(upf_nwtt_port_t *port, ogs_pkbuf_t *pkbuf);
ogs_pkbuf_t *upf_nwtt_dejitter_dequeue(upf_nwtt_port_t *port);
void upf_nwtt_dejitter_flush(upf_nwtt_port_t *port);
void upf_nwtt_dejitter_init(upf_nwtt_port_t *port, uint32_t target_delay_us);

/* Analytics */
void upf_nwtt_port_update_jitter(upf_nwtt_port_t *port, uint64_t now_ns);
void upf_nwtt_port_log_stats(upf_nwtt_port_t *port);
void upf_nwtt_port_reset_stats(upf_nwtt_port_t *port);

/*
 * Encode TSN port metrics as a JSON blob for inclusion in
 * PFCP reports (stored as opaque container bytes).
 * Returns allocated buffer (caller frees) and sets *out_len.
 */
uint8_t *upf_nwtt_port_encode_metrics(
        upf_nwtt_port_t *port, uint16_t *out_len);

#ifdef __cplusplus
}
#endif

#endif /* UPF_NWTT_H */
