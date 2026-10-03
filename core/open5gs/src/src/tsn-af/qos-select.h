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

#ifndef TSN_AF_QOS_SELECT_H
#define TSN_AF_QOS_SELECT_H

#include "context.h"

#ifdef __cplusplus
extern "C" {
#endif

/* QoS selection result */
typedef struct tsn_af_qos_result_s {
    uint8_t     _5qi;
    uint64_t    gbr_bps;        /* guaranteed bitrate (0 for non-GBR) */
    uint64_t    mbr_bps;        /* maximum bitrate (0 for non-GBR) */
    uint8_t     pcp;            /* mapped PCP value */
    uint8_t     arp_priority;   /* ARP priority level (1-15) */
} tsn_af_qos_result_t;

/*
 * Select 5QI and compute QoS parameters from TSN stream requirements.
 *
 * Inputs:  stream reservation parameters + optional bridge QoS mappings
 * Output:  5QI, GBR, MBR, PCP, ARP
 */
void tsn_af_select_5qi(
        tsn_af_stream_reservation_t *rsv,
        tsn_af_bridge_t *bridge,
        tsn_af_qos_result_t *result);

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_QOS_SELECT_H */
