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

#ifndef TSN_AF_LLDP_DISCOVERY_H
#define TSN_AF_LLDP_DISCOVERY_H

#include "context.h"

#ifdef __cplusplus
extern "C" {
#endif

/* LLDP constants */
#define LLDP_ETHERTYPE              0x88CC
#define LLDP_TLV_END                0
#define LLDP_TLV_CHASSIS_ID         1
#define LLDP_TLV_PORT_ID            2
#define LLDP_TLV_TTL                3
#define LLDP_TLV_PORT_DESC          4
#define LLDP_TLV_SYS_NAME           5
#define LLDP_TLV_SYS_DESC           6

/* LLDP neighbor information (discovered) */
typedef struct tsn_af_lldp_neighbor_s {
    ogs_lnode_t lnode;

    /* Source interface */
    char        iface_name[16];

    /* TLV data */
    uint8_t     chassis_id[256];
    uint8_t     chassis_id_len;
    uint8_t     chassis_id_subtype;

    uint8_t     port_id[256];
    uint8_t     port_id_len;
    uint8_t     port_id_subtype;

    uint16_t    ttl;
    char        system_name[256];
    char        port_desc[256];

    /* Formatted strings for easy matching */
    char        chassis_id_str[64];
    char        port_id_str[64];

    /* Timing */
    ogs_time_t  last_seen;
    bool        expired;

    /* Associated bridge/port (if matched) */
    char        *matched_bridge_id;
    uint32_t    matched_port_number;
} tsn_af_lldp_neighbor_t;

/* LLDP discovery context (per TSN-AF instance) */
typedef struct tsn_af_lldp_discovery_s {
    bool        enabled;
    int         raw_fd;             /* AF_PACKET raw socket */
    ogs_poll_t  *poll;              /* pollset registration */
    ogs_timer_t *aging_timer;       /* neighbor TTL expiry check */

    ogs_list_t  neighbor_list;
    uint32_t    neighbor_count;

    uint32_t    frames_received;
    uint32_t    frames_parsed;
} tsn_af_lldp_discovery_t;

/*
 * Initialize LLDP discovery subsystem.
 * Opens raw socket, registers with pollset.
 */
int tsn_af_lldp_discovery_init(void);

/*
 * Shutdown LLDP discovery.
 * Closes socket, frees neighbors.
 */
void tsn_af_lldp_discovery_final(void);

/*
 * Called when the raw socket has data ready.
 * Reads one LLDP frame, parses TLVs, updates neighbor list.
 */
void tsn_af_lldp_discovery_recv(short when, ogs_socket_t fd, void *data);

/*
 * Age out neighbors whose TTL has expired.
 * Called periodically by the aging timer.
 */
void tsn_af_lldp_discovery_age_neighbors(void *data);

/*
 * Get the LLDP discovery context.
 */
tsn_af_lldp_discovery_t *tsn_af_lldp_discovery_self(void);

/*
 * Find a neighbor by chassis_id string.
 */
tsn_af_lldp_neighbor_t *tsn_af_lldp_neighbor_find_by_chassis(
        const char *chassis_id_str);

/*
 * Build JSON array of all discovered neighbors.
 * Caller must cJSON_Delete the result.
 */
cJSON *tsn_af_lldp_neighbors_to_json(void);

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_LLDP_DISCOVERY_H */
