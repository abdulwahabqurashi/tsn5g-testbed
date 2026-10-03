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

#ifndef TSN_AF_CONTEXT_H
#define TSN_AF_CONTEXT_H

#include "ogs-sbi.h"
#include "ogs-app.h"

#include "event.h"
#include "tsn-af-sm.h"
#include "ts24519.h"

#ifdef __cplusplus
extern "C" {
#endif

extern int __tsn_af_log_domain;

#undef OGS_LOG_DOMAIN
#define OGS_LOG_DOMAIN __tsn_af_log_domain

/* PSFP flow meter configuration */
#define TSN_AF_MAX_FLOW_METERS 8

typedef struct tsn_af_flow_meter_s {
    uint32_t    meter_id;
    uint32_t    committed_info_rate;     /* bps */
    uint32_t    committed_burst_size;    /* bytes */
    bool        active;
} tsn_af_flow_meter_t;

/* Per-port PSFP configuration */
#define TSN_AF_MAX_PSFP_FILTERS 16
#define TSN_AF_MAX_PSFP_GATES   16

typedef struct tsn_af_psfp_config_s {
    ts24519_stream_filter_t filters[TSN_AF_MAX_PSFP_FILTERS];
    int                     filter_count;

    ts24519_stream_gate_t   gates[TSN_AF_MAX_PSFP_GATES];
    int                     gate_count;

    tsn_af_flow_meter_t     meters[TSN_AF_MAX_FLOW_METERS];
    int                     meter_count;

    bool                    configured;
} tsn_af_psfp_config_t;

/* TSN AF port (represents a DS-TT or NW-TT port) */
typedef struct tsn_af_port_s {
    ogs_lnode_t lnode;

    uint32_t    port_number;
    bool        is_nwtt;        /* true = NW-TT, false = DS-TT */
    uint8_t     mac_addr[6];

    /* Port management container (TS 24.519 encoded) */
    uint8_t     *mgmt_container;
    uint16_t    mgmt_container_len;

    /* PSFP configuration */
    tsn_af_psfp_config_t psfp;

    /* LLDP-discovered info */
    char        *lldp_chassis_id;
    char        *lldp_port_id;

    /* PCF policy reference */
    char        *pcf_policy_uri;
} tsn_af_port_t;

/* PCF AppSession state constants */
#define TSN_AF_NPCF_STATE_CREATE    1
#define TSN_AF_NPCF_STATE_UPDATE    2

/* QoS mapping (PCP to 5QI) */
#define TSN_AF_MAX_PCP_VALUES 8
typedef struct tsn_af_qos_mapping_s {
    uint8_t pcp;
    uint8_t _5qi;
    bool configured;
} tsn_af_qos_mapping_t;

/* TSC Assistance Info */
typedef struct tsn_af_tsc_assistance_s {
    uint32_t burst_arrival_time_ns;
    uint32_t periodicity_us;
    uint32_t survival_time_us;
    bool configured;
} tsn_af_tsc_assistance_t;

/* Time synchronization subscription */
typedef struct tsn_af_time_sync_s {
    ogs_lnode_t lnode;
    char *subscription_id;
    uint8_t time_domain_number;
    uint32_t time_offset_ns;
    bool active;
    char *requester_nf_id;
} tsn_af_time_sync_t;

/* PCF notification state tracking */
typedef struct tsn_af_pcf_notify_state_s {
    uint32_t    notification_count;
    ogs_time_t  last_notification_time;
    bool        resources_allocated;
    bool        resources_failed;
    bool        qos_updated;
    bool        qos_failed;
} tsn_af_pcf_notify_state_t;

/* Stream reservation state */
typedef enum {
    TSN_AF_STREAM_STATE_PENDING,
    TSN_AF_STREAM_STATE_ACTIVE,
    TSN_AF_STREAM_STATE_FAILED,
    TSN_AF_STREAM_STATE_RELEASED
} tsn_af_stream_state_e;

/* Stream reservation (Phase D) */
typedef struct tsn_af_stream_reservation_s {
    ogs_lnode_t lnode;

    uint32_t    stream_id;
    uint8_t     dest_mac[6];
    uint16_t    vlan_id;
    int16_t     priority;           /* -1 = wildcard */
    uint32_t    max_frame_size;
    uint32_t    interval_us;
    uint32_t    max_latency_us;
    uint64_t    bandwidth_bps;      /* computed: max_frame_size*8/interval_us*1e6 */

    /* Associated stream filter/gate instance IDs */
    uint32_t    filter_instance_id;
    uint32_t    gate_instance_id;

    /* QoS mapping result */
    uint8_t     assigned_5qi;
    uint8_t     assigned_pcp;
    uint64_t    gbr_bps;            /* guaranteed bitrate */
    uint64_t    mbr_bps;            /* maximum bitrate */

    /* Target NW-TT port */
    uint32_t    target_port_number;

    tsn_af_stream_state_e state;
} tsn_af_stream_reservation_t;

#define TSN_AF_MAX_STREAM_RESERVATIONS 64

/* Bridge role in a redundancy group */
typedef enum {
    TSN_AF_BRIDGE_ROLE_STANDALONE,
    TSN_AF_BRIDGE_ROLE_PRIMARY,
    TSN_AF_BRIDGE_ROLE_BACKUP
} tsn_af_bridge_role_e;

/* Bridge health state */
typedef enum {
    TSN_AF_BRIDGE_HEALTH_UNKNOWN,
    TSN_AF_BRIDGE_HEALTH_UP,
    TSN_AF_BRIDGE_HEALTH_DEGRADED,
    TSN_AF_BRIDGE_HEALTH_DOWN
} tsn_af_bridge_health_e;

/* TSN AF bridge (represents a 5GS TSN bridge) */
typedef struct tsn_af_bridge_s {
    ogs_lnode_t lnode;

    ogs_sbi_object_t sbi;       /* for SBI xact tracking (discover_and_send) */

    char        *bridge_id;
    uint8_t     bridge_mac[6];

    /* Port list */
    ogs_list_t  port_list;

    /* Bridge management container */
    uint8_t     *mgmt_container;
    uint16_t    mgmt_container_len;

    /* Associated DNN and S-NSSAI */
    char        *dnn;
    ogs_s_nssai_t s_nssai;

    /* UE IP address (if available) */
    char        *ue_ipv4_addr;
    char        *ue_ipv6_addr_prefix;

    /* PCF AppSession state */
    char        *pcf_app_session_id;
    bool        pcf_session_created;
    tsn_af_pcf_notify_state_t pcf_notify_state;

    /* Stream reservations */
    ogs_list_t  stream_reservation_list;
    uint32_t    next_filter_instance_id;
    uint32_t    next_gate_instance_id;

    /* QoS mapping (PCP → 5QI) */
    tsn_af_qos_mapping_t qos_map[TSN_AF_MAX_PCP_VALUES];

    /* TSC Assistance Info */
    tsn_af_tsc_assistance_t tsc_assistance;

    /* Redundancy group membership */
    tsn_af_bridge_role_e    role;
    tsn_af_bridge_health_e  health;
    char                    *group_id;  /* NULL if standalone */

    /* Linux bridge management (Stage 2) */
    char        linux_bridge_name[16];  /* "tsn-br-<id>" */
    char        tap_name[16];           /* "tsn-tap-<id>" */
    ogs_socket_t tap_fd;                /* TAP file descriptor */
    char        *physical_iface;        /* Selected physical NIC name */
    char        *upf_tap_name;          /* UPF's TAP device (e.g., ogstap) */
    bool        linux_bridge_active;    /* Kernel bridge exists */
} tsn_af_bridge_t;

/* Bridge group member */
typedef struct tsn_af_bridge_group_member_s {
    ogs_lnode_t lnode;
    char        *bridge_id;
    tsn_af_bridge_role_e role;
    tsn_af_bridge_health_e health;
    uint32_t    priority;               /* lower = higher priority */
    ogs_time_t  last_health_check;
    uint32_t    consecutive_failures;
} tsn_af_bridge_group_member_t;

/* Bridge group (redundancy/failover) */
typedef struct tsn_af_bridge_group_s {
    ogs_lnode_t lnode;

    char        *group_id;
    ogs_list_t  member_list;

    /* Active bridge tracking */
    char        *active_bridge_id;

    /* Health check config */
    uint32_t    health_check_interval_ms;
    uint32_t    failover_threshold;     /* consecutive failures before failover */
    ogs_timer_t *health_timer;
} tsn_af_bridge_group_t;

/* TSN AF global context */
typedef struct tsn_af_context_s {
    ogs_list_t  bridge_list;
    ogs_hash_t  *bridge_hash;  /* keyed by bridge_id string */

    /* Bridge groups (redundancy) */
    ogs_list_t  bridge_group_list;
    ogs_hash_t  *bridge_group_hash;

    /* TSCTSF time sync subscriptions */
    ogs_list_t  time_sync_list;
    uint32_t    next_time_sync_id;
} tsn_af_context_t;

void tsn_af_context_init(void);
void tsn_af_context_final(void);
tsn_af_context_t *tsn_af_self(void);

int tsn_af_context_parse_config(void);

tsn_af_bridge_t *tsn_af_bridge_add(const char *bridge_id);
void tsn_af_bridge_remove(tsn_af_bridge_t *bridge);
void tsn_af_bridge_remove_all(void);
tsn_af_bridge_t *tsn_af_bridge_find_by_id(const char *bridge_id);

tsn_af_port_t *tsn_af_port_add(tsn_af_bridge_t *bridge);
void tsn_af_port_remove(tsn_af_port_t *port);
tsn_af_port_t *tsn_af_port_find_by_number(
        tsn_af_bridge_t *bridge, uint32_t port_number);

tsn_af_stream_reservation_t *tsn_af_stream_reservation_add(
        tsn_af_bridge_t *bridge, uint32_t stream_id);
void tsn_af_stream_reservation_remove(
        tsn_af_bridge_t *bridge, tsn_af_stream_reservation_t *reservation);
tsn_af_stream_reservation_t *tsn_af_stream_reservation_find(
        tsn_af_bridge_t *bridge, uint32_t stream_id);

tsn_af_bridge_group_t *tsn_af_bridge_group_add(const char *group_id);
void tsn_af_bridge_group_remove(tsn_af_bridge_group_t *group);
tsn_af_bridge_group_t *tsn_af_bridge_group_find_by_id(const char *group_id);
tsn_af_bridge_group_member_t *tsn_af_bridge_group_add_member(
        tsn_af_bridge_group_t *group, const char *bridge_id,
        tsn_af_bridge_role_e role, uint32_t priority);
void tsn_af_bridge_group_remove_member(
        tsn_af_bridge_group_t *group, tsn_af_bridge_group_member_t *member);
tsn_af_bridge_group_member_t *tsn_af_bridge_group_find_member(
        tsn_af_bridge_group_t *group, const char *bridge_id);

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_CONTEXT_H */
