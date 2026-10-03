/*
 * Copyright (C) 2019-2023 by Sukchan Lee <acetcom@gmail.com>
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

#ifndef UPF_CONTEXT_H
#define UPF_CONTEXT_H

#include "upf-config.h"

#if HAVE_NET_IF_H
#include <net/if.h>
#endif

#include "ogs-gtp.h"
#include "ogs-pfcp.h"
#include "ogs-app.h"

#include "ipfw/ogs-ipfw.h"

#include "timer.h"
#include "upf-sm.h"
#include "metrics.h"
#include "nwtt.h"

#ifdef __cplusplus
extern "C" {
#endif

extern int __upf_log_domain;

#undef OGS_LOG_DOMAIN
#define OGS_LOG_DOMAIN __upf_log_domain

struct upf_route_trie_node;

typedef struct upf_context_s {
    ogs_hash_t *upf_n4_seid_hash;   /* hash table (UPF-N4-SEID) */
    ogs_hash_t *smf_n4_seid_hash;   /* hash table (SMF-N4-SEID) */
    ogs_hash_t *smf_n4_f_seid_hash; /* hash table (SMF-N4-F-SEID) */
    ogs_hash_t *ipv4_hash;  /* hash table (IPv4 Address) */
    ogs_hash_t *ipv6_hash;  /* hash table (IPv6 Address) */
    ogs_hash_t *mac_hash;   /* hash table (MAC Address → sess) for hairpin */

    /* IPv4 framed routes trie */
    struct upf_route_trie_node *ipv4_framed_routes;
    /* IPv6 framed routes trie */
    struct upf_route_trie_node *ipv6_framed_routes;

    ogs_list_t sess_list;

    /* NW-TT bridge state for TSN support */
    upf_nwtt_bridge_t nwtt_bridge;
} upf_context_t;

/* trie mapping from IP framed routes to session. */
struct upf_route_trie_node {
    struct upf_route_trie_node *left;
    struct upf_route_trie_node *right;
    upf_sess_t *sess;
};

/* Accounting: */
typedef struct upf_sess_urr_acc_s {
    bool reporting_enabled;
    ogs_timer_t *t_validity_time; /* Quota Validity Time expiration handler */
    ogs_timer_t *t_time_quota; /* Time Quota expiration handler */
    ogs_timer_t *t_time_threshold; /* Time Threshold expiration handler */
    uint32_t time_start; /* When t_time_* started */
    ogs_pfcp_urr_ur_seqn_t report_seqn; /* Next seqn to use when reporting */
    uint64_t total_octets;
    uint64_t ul_octets;
    uint64_t dl_octets;
    uint64_t total_pkts;
    uint64_t ul_pkts;
    uint64_t dl_pkts;
    ogs_time_t time_of_first_packet;
    ogs_time_t time_of_last_packet;
    /* Snapshot of measurement when last report was sent: */
    struct {
        uint64_t total_octets;
        uint64_t ul_octets;
        uint64_t dl_octets;
        uint64_t total_pkts;
        uint64_t ul_pkts;
        uint64_t dl_pkts;
        ogs_time_t timestamp;
    } last_report;
} upf_sess_urr_acc_t;

#define UPF_SESS(pfcp_sess) ogs_container_of(pfcp_sess, upf_sess_t, pfcp)
typedef struct upf_sess_s {
    ogs_lnode_t     lnode;
    ogs_pool_id_t   id;
    ogs_pool_id_t   *upf_n4_seid_node;  /* A node of UPF-N4-SEID */

    ogs_pfcp_sess_t pfcp;

    uint64_t        upf_n4_seid;        /* UPF SEID is derived from NODE */
    struct {
        uint64_t    seid;
        ogs_ip_t    ip;
    } smf_n4_f_seid;                    /* SMF SEID is received from Peer */

    /* APN Configuration */
    ogs_pfcp_ue_ip_t *ipv4;
    ogs_pfcp_ue_ip_t *ipv6;

    ogs_ipsubnet_t   *ipv4_framed_routes;
    ogs_ipsubnet_t   *ipv6_framed_routes;

    char            *gx_sid;            /* Gx Session ID */
    ogs_pfcp_node_t *pfcp_node;

    /* Accounting: */
    upf_sess_urr_acc_t urr_acc[OGS_MAX_NUM_OF_URR]; /* FIXME: This probably needs to be mved to a hashtable or alike */
    char            *apn_dnn;            /* APN/DNN Item */

    /* Ethernet PDU session */
    ogs_pfcp_dev_t  *eth_dev;           /* TAP device for Ethernet PDU */
    uint8_t         session_type;       /* OGS_PDU_SESSION_TYPE_* */

    /* Learned source MACs (Ethernet PDU). One UE may bridge a whole
     * LAN segment (router + endpoints), so keep a table rather than a
     * single slot; oldest entry is evicted when full. */
#define UPF_MAX_UE_MACS 16
    struct {
        bool        used;
        uint8_t     addr[6];
        ogs_time_t  last_seen;
    } ue_macs[UPF_MAX_UE_MACS];
    int             num_of_ue_macs;

    /* Session gateway MAC: first MAC learned on the session (the
     * UE/modem announces itself before LAN devices talk). Downlink
     * MAC adaptation readdresses IP unicast to it. */
    uint8_t         gw_mac[6];
    bool            gw_mac_learned;

    /* TSN / TSC state */
    struct {
        bool is_tsn;
        upf_nwtt_port_t *nwtt_port;
        uint8_t ds_tt_port_number;
    } tsc;
} upf_sess_t;

void upf_context_init(void);
void upf_context_final(void);
upf_context_t *upf_self(void);

int upf_context_parse_config(void);

upf_sess_t *upf_sess_add_by_message(ogs_pfcp_message_t *message);

upf_sess_t *upf_sess_add(ogs_pfcp_f_seid_t *f_seid);
int upf_sess_remove(upf_sess_t *sess);
void upf_sess_remove_all(void);
upf_sess_t *upf_sess_find_by_smf_n4_seid(uint64_t seid);
upf_sess_t *upf_sess_find_by_smf_n4_f_seid(ogs_pfcp_f_seid_t *f_seid);
upf_sess_t *upf_sess_find_by_upf_n4_seid(uint64_t seid);
upf_sess_t *upf_sess_find_by_ipv4(uint32_t addr);
upf_sess_t *upf_sess_find_by_ipv6(uint32_t *addr6);
upf_sess_t *upf_sess_find_by_id(ogs_pool_id_t id);
upf_sess_t *upf_sess_find_by_eth_dev_fd(ogs_socket_t fd);
upf_sess_t *upf_sess_find_by_mac(uint8_t *mac_addr);
void upf_sess_learn_ue_mac(upf_sess_t *sess, uint8_t *mac_addr);
void upf_sess_clear_ue_macs(upf_sess_t *sess);
const uint8_t *upf_sess_latest_ue_mac(upf_sess_t *sess);

uint8_t upf_sess_set_ue_ip(upf_sess_t *sess,
        uint8_t session_type, ogs_pfcp_pdr_t *pdr);
uint8_t upf_sess_set_ue_ipv4_framed_routes(upf_sess_t *sess,
        char *framed_routes[]);
uint8_t upf_sess_set_ue_ipv6_framed_routes(upf_sess_t *sess,
        char *framed_routes[]);

void upf_sess_urr_acc_add(upf_sess_t *sess, ogs_pfcp_urr_t *urr, size_t size, bool is_uplink);
void upf_sess_urr_acc_fill_usage_report(upf_sess_t *sess, const ogs_pfcp_urr_t *urr,
                                        ogs_pfcp_user_plane_report_t *report, unsigned int idx);
void upf_sess_urr_acc_snapshot(upf_sess_t *sess, ogs_pfcp_urr_t *urr);
void upf_sess_urr_acc_timers_setup(upf_sess_t *sess, ogs_pfcp_urr_t *urr);

#ifdef __cplusplus
}
#endif

#endif /* UPF_CONTEXT_H */
