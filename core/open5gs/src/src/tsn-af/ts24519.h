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

#ifndef TSN_AF_TS24519_H
#define TSN_AF_TS24519_H

#include "ogs-core.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * TS 24.519 Port Management Information Container IEIs
 * Section 9: Information elements
 */
#define TS24519_IEI_STATIC_FILTERING_ENTRIES    0x60
#define TS24519_IEI_TRAFFIC_CLASS_TABLE         0x70
#define TS24519_IEI_STREAM_FILTER_INSTANCE      0x80
#define TS24519_IEI_STREAM_GATE_INSTANCE        0x90
#define TS24519_IEI_TIME_DOMAIN_CONFIG          0xF0
#define TS24519_IEI_NWTT_PORT_NUMBER            0xE0

/* Static filtering entry (Section 9.6) */
typedef struct ts24519_static_filter_s {
    uint8_t     mac_addr[6];    /* destination MAC */
    uint16_t    vlan_id;        /* 802.1Q VID, 0 = no VLAN filter */
    bool        forward;        /* true = forward, false = filter/drop */
} ts24519_static_filter_t;

/* Traffic class table entry (Section 9.7) */
typedef struct ts24519_traffic_class_s {
    uint8_t     priority;       /* 802.1p priority (0-7) */
    uint8_t     queue_id;       /* output queue mapping */
} ts24519_traffic_class_t;

/* Stream filter instance entry (Section 9.8) */
typedef struct ts24519_stream_filter_s {
    uint32_t    instance_id;
    uint8_t     dest_mac[6];
    uint16_t    vlan_id;
    int16_t     priority;       /* -1 = wildcard */
    uint32_t    stream_gate_instance_id;
} ts24519_stream_filter_t;

/* Stream gate instance entry (Section 9.9) */
typedef struct ts24519_stream_gate_s {
    uint32_t    instance_id;
    bool        gate_open;      /* initial gate state */
    uint8_t     ipv;            /* internal priority value */
} ts24519_stream_gate_t;

/* Time domain configuration (Section 9.15) */
typedef struct ts24519_time_domain_s {
    uint8_t     time_domain_number;
    uint32_t    time_offset_ns;
} ts24519_time_domain_t;

/* TSC Assistance Information */
#define TS24519_IEI_TSC_ASSISTANCE_INFO     0xA0

typedef struct ts24519_tsc_assistance_s {
    uint32_t    burst_arrival_time_ns;
    uint32_t    periodicity_us;
    uint32_t    survival_time_us;
} ts24519_tsc_assistance_t;

/* Flow Meter Instance (IEEE 802.1Qci) */
#define TS24519_IEI_FLOW_METER_INSTANCE     0xC0

typedef struct ts24519_flow_meter_s {
    uint32_t    meter_id;
    uint32_t    committed_info_rate;     /* bps */
    uint32_t    committed_burst_size;    /* bytes */
} ts24519_flow_meter_t;

/* Gate Control List (IEEE 802.1Qbv) */
#define TS24519_IEI_GATE_CONTROL_LIST       0xB0

typedef struct ts24519_gate_control_entry_s {
    uint8_t     gate_states;        /* bitmask per queue */
    uint32_t    time_interval_ns;
} ts24519_gate_control_entry_t;

/*
 * Encode a port management container with static filtering entries.
 * Returns allocated buffer (caller must free) and sets *out_len.
 * Returns NULL on error.
 */
uint8_t *ts24519_encode_static_filters(
        ts24519_static_filter_t *filters, int count,
        uint16_t *out_len);

/*
 * Decode static filtering entries from a port management container.
 * Returns allocated array (caller must free) and sets *out_count.
 * Returns NULL on error or if no static filter IEs found.
 */
ts24519_static_filter_t *ts24519_decode_static_filters(
        const uint8_t *data, uint16_t len, int *out_count);

/*
 * Encode a traffic class table.
 * Returns allocated buffer and sets *out_len.
 */
uint8_t *ts24519_encode_traffic_class_table(
        ts24519_traffic_class_t *entries, int count,
        uint16_t *out_len);

/*
 * Decode traffic class table entries.
 * Returns allocated array and sets *out_count.
 */
ts24519_traffic_class_t *ts24519_decode_traffic_class_table(
        const uint8_t *data, uint16_t len, int *out_count);

/*
 * Encode stream filter instance table entries.
 * Returns allocated buffer and sets *out_len.
 */
uint8_t *ts24519_encode_stream_filters(
        ts24519_stream_filter_t *filters, int count,
        uint16_t *out_len);

/*
 * Decode stream filter instance table entries.
 * Returns allocated array and sets *out_count.
 */
ts24519_stream_filter_t *ts24519_decode_stream_filters(
        const uint8_t *data, uint16_t len, int *out_count);

/*
 * Encode time domain configuration.
 * Returns allocated buffer and sets *out_len.
 */
uint8_t *ts24519_encode_time_domain(
        ts24519_time_domain_t *td, uint16_t *out_len);

/*
 * Decode time domain configuration.
 * Returns true on success.
 */
bool ts24519_decode_time_domain(
        const uint8_t *data, uint16_t len,
        ts24519_time_domain_t *out_td);

/*
 * Encode TSC Assistance Information.
 * Returns allocated buffer and sets *out_len.
 */
uint8_t *ts24519_encode_tsc_assistance(
        ts24519_tsc_assistance_t *info, uint16_t *out_len);

/*
 * Decode TSC Assistance Information.
 * Returns true on success.
 */
bool ts24519_decode_tsc_assistance(
        const uint8_t *data, uint16_t len,
        ts24519_tsc_assistance_t *out_info);

/*
 * Encode Gate Control List entries.
 * Returns allocated buffer and sets *out_len.
 */
uint8_t *ts24519_encode_gate_control_list(
        ts24519_gate_control_entry_t *entries, int count,
        uint16_t *out_len);

/*
 * Decode Gate Control List entries.
 * Returns allocated array and sets *out_count.
 */
ts24519_gate_control_entry_t *ts24519_decode_gate_control_list(
        const uint8_t *data, uint16_t len, int *out_count);

/*
 * Encode flow meter instance table entries.
 * Returns allocated buffer and sets *out_len.
 */
uint8_t *ts24519_encode_flow_meters(
        ts24519_flow_meter_t *meters, int count,
        uint16_t *out_len);

/*
 * Decode flow meter instance table entries.
 * Returns allocated array and sets *out_count.
 */
ts24519_flow_meter_t *ts24519_decode_flow_meters(
        const uint8_t *data, uint16_t len, int *out_count);

/*
 * Encode stream gate instance table entries.
 * Returns allocated buffer and sets *out_len.
 */
uint8_t *ts24519_encode_stream_gates(
        ts24519_stream_gate_t *gates, int count,
        uint16_t *out_len);

/*
 * Decode stream gate instance table entries.
 * Returns allocated array and sets *out_count.
 */
ts24519_stream_gate_t *ts24519_decode_stream_gates(
        const uint8_t *data, uint16_t len, int *out_count);

/*
 * Encode a compound PSFP container (stream filters + gates + meters).
 * Concatenates all IE types into a single buffer.
 * Returns allocated buffer and sets *out_len.
 */
uint8_t *ts24519_encode_psfp_container(
        ts24519_stream_filter_t *filters, int filter_count,
        ts24519_stream_gate_t *gates, int gate_count,
        uint16_t *out_len);

/* Extended version including flow meters */
uint8_t *ts24519_encode_psfp_container_full(
        ts24519_stream_filter_t *filters, int filter_count,
        ts24519_stream_gate_t *gates, int gate_count,
        ts24519_flow_meter_t *meters, int meter_count,
        uint16_t *out_len);

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_TS24519_H */
