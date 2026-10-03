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

#include "ts24519.h"
#include "ogs-core.h"

/*
 * TS 24.519 TLV format:
 *   1 byte IEI
 *   2 bytes length (big-endian)
 *   N bytes value
 */

static void write_uint16_be(uint8_t *p, uint16_t v)
{
    p[0] = (v >> 8) & 0xff;
    p[1] = v & 0xff;
}

static uint16_t read_uint16_be(const uint8_t *p)
{
    return ((uint16_t)p[0] << 8) | p[1];
}

static void write_uint32_be(uint8_t *p, uint32_t v)
{
    p[0] = (v >> 24) & 0xff;
    p[1] = (v >> 16) & 0xff;
    p[2] = (v >> 8) & 0xff;
    p[3] = v & 0xff;
}

static uint32_t read_uint32_be(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | p[3];
}

/*
 * Static filtering entry encoding (Section 9.6):
 *   6 bytes MAC address
 *   2 bytes VLAN ID
 *   1 byte  flags (bit 0 = forward)
 *   Total: 9 bytes per entry
 */
#define STATIC_FILTER_ENTRY_SIZE 9

uint8_t *ts24519_encode_static_filters(
        ts24519_static_filter_t *filters, int count,
        uint16_t *out_len)
{
    uint16_t value_len;
    uint16_t total_len;
    uint8_t *buf, *p;
    int i;

    ogs_assert(filters);
    ogs_assert(out_len);

    if (count <= 0) return NULL;

    value_len = count * STATIC_FILTER_ENTRY_SIZE;
    total_len = 1 + 2 + value_len; /* IEI + length + value */

    buf = ogs_calloc(1, total_len);
    if (!buf) return NULL;

    p = buf;
    *p++ = TS24519_IEI_STATIC_FILTERING_ENTRIES;
    write_uint16_be(p, value_len);
    p += 2;

    for (i = 0; i < count; i++) {
        memcpy(p, filters[i].mac_addr, 6);
        p += 6;
        write_uint16_be(p, filters[i].vlan_id);
        p += 2;
        *p++ = filters[i].forward ? 0x01 : 0x00;
    }

    *out_len = total_len;
    return buf;
}

ts24519_static_filter_t *ts24519_decode_static_filters(
        const uint8_t *data, uint16_t len, int *out_count)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    ts24519_static_filter_t *filters = NULL;

    ogs_assert(data);
    ogs_assert(out_count);

    *out_count = 0;

    /* Search for static filtering IEI */
    while (p + 3 <= end) {
        uint8_t iei = *p;
        uint16_t ie_len;

        if (p + 3 > end) break;
        ie_len = read_uint16_be(p + 1);

        if (iei == TS24519_IEI_STATIC_FILTERING_ENTRIES) {
            const uint8_t *value = p + 3;
            int count, i;

            if (p + 3 + ie_len > end) break;
            if (ie_len % STATIC_FILTER_ENTRY_SIZE != 0) break;

            count = ie_len / STATIC_FILTER_ENTRY_SIZE;
            filters = ogs_calloc(count, sizeof(*filters));
            if (!filters) return NULL;

            for (i = 0; i < count; i++) {
                memcpy(filters[i].mac_addr, value, 6);
                value += 6;
                filters[i].vlan_id = read_uint16_be(value);
                value += 2;
                filters[i].forward = (*value & 0x01) ? true : false;
                value++;
            }

            *out_count = count;
            return filters;
        }

        p += 3 + ie_len;
    }

    return NULL;
}

/*
 * Traffic class table entry encoding (Section 9.7):
 *   1 byte priority
 *   1 byte queue_id
 *   Total: 2 bytes per entry
 */
#define TRAFFIC_CLASS_ENTRY_SIZE 2

uint8_t *ts24519_encode_traffic_class_table(
        ts24519_traffic_class_t *entries, int count,
        uint16_t *out_len)
{
    uint16_t value_len;
    uint16_t total_len;
    uint8_t *buf, *p;
    int i;

    ogs_assert(entries);
    ogs_assert(out_len);

    if (count <= 0) return NULL;

    value_len = count * TRAFFIC_CLASS_ENTRY_SIZE;
    total_len = 1 + 2 + value_len;

    buf = ogs_calloc(1, total_len);
    if (!buf) return NULL;

    p = buf;
    *p++ = TS24519_IEI_TRAFFIC_CLASS_TABLE;
    write_uint16_be(p, value_len);
    p += 2;

    for (i = 0; i < count; i++) {
        *p++ = entries[i].priority;
        *p++ = entries[i].queue_id;
    }

    *out_len = total_len;
    return buf;
}

ts24519_traffic_class_t *ts24519_decode_traffic_class_table(
        const uint8_t *data, uint16_t len, int *out_count)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    ts24519_traffic_class_t *entries = NULL;

    ogs_assert(data);
    ogs_assert(out_count);

    *out_count = 0;

    while (p + 3 <= end) {
        uint8_t iei = *p;
        uint16_t ie_len = read_uint16_be(p + 1);

        if (iei == TS24519_IEI_TRAFFIC_CLASS_TABLE) {
            const uint8_t *value = p + 3;
            int count, i;

            if (p + 3 + ie_len > end) break;
            if (ie_len % TRAFFIC_CLASS_ENTRY_SIZE != 0) break;

            count = ie_len / TRAFFIC_CLASS_ENTRY_SIZE;
            entries = ogs_calloc(count, sizeof(*entries));
            if (!entries) return NULL;

            for (i = 0; i < count; i++) {
                entries[i].priority = *value++;
                entries[i].queue_id = *value++;
            }

            *out_count = count;
            return entries;
        }

        p += 3 + ie_len;
    }

    return NULL;
}

/*
 * Stream filter instance entry encoding (Section 9.8):
 *   4 bytes instance_id
 *   6 bytes dest_mac
 *   2 bytes vlan_id
 *   2 bytes priority (signed)
 *   4 bytes stream_gate_instance_id
 *   Total: 18 bytes per entry
 */
#define STREAM_FILTER_ENTRY_SIZE 18

uint8_t *ts24519_encode_stream_filters(
        ts24519_stream_filter_t *filters, int count,
        uint16_t *out_len)
{
    uint16_t value_len;
    uint16_t total_len;
    uint8_t *buf, *p;
    int i;

    ogs_assert(filters);
    ogs_assert(out_len);

    if (count <= 0) return NULL;

    value_len = count * STREAM_FILTER_ENTRY_SIZE;
    total_len = 1 + 2 + value_len;

    buf = ogs_calloc(1, total_len);
    if (!buf) return NULL;

    p = buf;
    *p++ = TS24519_IEI_STREAM_FILTER_INSTANCE;
    write_uint16_be(p, value_len);
    p += 2;

    for (i = 0; i < count; i++) {
        write_uint32_be(p, filters[i].instance_id);
        p += 4;
        memcpy(p, filters[i].dest_mac, 6);
        p += 6;
        write_uint16_be(p, filters[i].vlan_id);
        p += 2;
        write_uint16_be(p, (uint16_t)filters[i].priority);
        p += 2;
        write_uint32_be(p, filters[i].stream_gate_instance_id);
        p += 4;
    }

    *out_len = total_len;
    return buf;
}

ts24519_stream_filter_t *ts24519_decode_stream_filters(
        const uint8_t *data, uint16_t len, int *out_count)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    ts24519_stream_filter_t *filters = NULL;

    ogs_assert(data);
    ogs_assert(out_count);

    *out_count = 0;

    while (p + 3 <= end) {
        uint8_t iei = *p;
        uint16_t ie_len = read_uint16_be(p + 1);

        if (iei == TS24519_IEI_STREAM_FILTER_INSTANCE) {
            const uint8_t *value = p + 3;
            int count, i;

            if (p + 3 + ie_len > end) break;
            if (ie_len % STREAM_FILTER_ENTRY_SIZE != 0) break;

            count = ie_len / STREAM_FILTER_ENTRY_SIZE;
            filters = ogs_calloc(count, sizeof(*filters));
            if (!filters) return NULL;

            for (i = 0; i < count; i++) {
                filters[i].instance_id = read_uint32_be(value);
                value += 4;
                memcpy(filters[i].dest_mac, value, 6);
                value += 6;
                filters[i].vlan_id = read_uint16_be(value);
                value += 2;
                filters[i].priority = (int16_t)read_uint16_be(value);
                value += 2;
                filters[i].stream_gate_instance_id = read_uint32_be(value);
                value += 4;
            }

            *out_count = count;
            return filters;
        }

        p += 3 + ie_len;
    }

    return NULL;
}

/*
 * Time domain configuration encoding (Section 9.15):
 *   1 byte  time_domain_number
 *   4 bytes time_offset_ns
 *   Total: 5 bytes
 */
#define TIME_DOMAIN_SIZE 5

uint8_t *ts24519_encode_time_domain(
        ts24519_time_domain_t *td, uint16_t *out_len)
{
    uint16_t total_len;
    uint8_t *buf, *p;

    ogs_assert(td);
    ogs_assert(out_len);

    total_len = 1 + 2 + TIME_DOMAIN_SIZE;

    buf = ogs_calloc(1, total_len);
    if (!buf) return NULL;

    p = buf;
    *p++ = TS24519_IEI_TIME_DOMAIN_CONFIG;
    write_uint16_be(p, TIME_DOMAIN_SIZE);
    p += 2;

    *p++ = td->time_domain_number;
    write_uint32_be(p, td->time_offset_ns);

    *out_len = total_len;
    return buf;
}

bool ts24519_decode_time_domain(
        const uint8_t *data, uint16_t len,
        ts24519_time_domain_t *out_td)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;

    ogs_assert(data);
    ogs_assert(out_td);

    while (p + 3 <= end) {
        uint8_t iei = *p;
        uint16_t ie_len = read_uint16_be(p + 1);

        if (iei == TS24519_IEI_TIME_DOMAIN_CONFIG) {
            const uint8_t *value = p + 3;

            if (p + 3 + ie_len > end) break;
            if (ie_len < TIME_DOMAIN_SIZE) break;

            out_td->time_domain_number = *value++;
            out_td->time_offset_ns = read_uint32_be(value);
            return true;
        }

        p += 3 + ie_len;
    }

    return false;
}

/*
 * TSC Assistance Information encoding:
 *   4 bytes burst_arrival_time_ns
 *   4 bytes periodicity_us
 *   4 bytes survival_time_us
 *   Total: 12 bytes
 */
#define TSC_ASSISTANCE_SIZE 12

uint8_t *ts24519_encode_tsc_assistance(
        ts24519_tsc_assistance_t *info, uint16_t *out_len)
{
    uint16_t total_len;
    uint8_t *buf, *p;

    ogs_assert(info);
    ogs_assert(out_len);

    total_len = 1 + 2 + TSC_ASSISTANCE_SIZE;

    buf = ogs_calloc(1, total_len);
    if (!buf) return NULL;

    p = buf;
    *p++ = TS24519_IEI_TSC_ASSISTANCE_INFO;
    write_uint16_be(p, TSC_ASSISTANCE_SIZE);
    p += 2;

    write_uint32_be(p, info->burst_arrival_time_ns);
    p += 4;
    write_uint32_be(p, info->periodicity_us);
    p += 4;
    write_uint32_be(p, info->survival_time_us);

    *out_len = total_len;
    return buf;
}

bool ts24519_decode_tsc_assistance(
        const uint8_t *data, uint16_t len,
        ts24519_tsc_assistance_t *out_info)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;

    ogs_assert(data);
    ogs_assert(out_info);

    while (p + 3 <= end) {
        uint8_t iei = *p;
        uint16_t ie_len = read_uint16_be(p + 1);

        if (iei == TS24519_IEI_TSC_ASSISTANCE_INFO) {
            const uint8_t *value = p + 3;

            if (p + 3 + ie_len > end) break;
            if (ie_len < TSC_ASSISTANCE_SIZE) break;

            out_info->burst_arrival_time_ns = read_uint32_be(value);
            value += 4;
            out_info->periodicity_us = read_uint32_be(value);
            value += 4;
            out_info->survival_time_us = read_uint32_be(value);
            return true;
        }

        p += 3 + ie_len;
    }

    return false;
}

/*
 * Gate Control List entry encoding (IEEE 802.1Qbv):
 *   1 byte  gate_states (bitmask per queue)
 *   4 bytes time_interval_ns
 *   Total: 5 bytes per entry
 */
#define GCL_ENTRY_SIZE 5

uint8_t *ts24519_encode_gate_control_list(
        ts24519_gate_control_entry_t *entries, int count,
        uint16_t *out_len)
{
    uint16_t value_len;
    uint16_t total_len;
    uint8_t *buf, *p;
    int i;

    ogs_assert(entries);
    ogs_assert(out_len);

    if (count <= 0) return NULL;

    value_len = count * GCL_ENTRY_SIZE;
    total_len = 1 + 2 + value_len;

    buf = ogs_calloc(1, total_len);
    if (!buf) return NULL;

    p = buf;
    *p++ = TS24519_IEI_GATE_CONTROL_LIST;
    write_uint16_be(p, value_len);
    p += 2;

    for (i = 0; i < count; i++) {
        *p++ = entries[i].gate_states;
        write_uint32_be(p, entries[i].time_interval_ns);
        p += 4;
    }

    *out_len = total_len;
    return buf;
}

ts24519_gate_control_entry_t *ts24519_decode_gate_control_list(
        const uint8_t *data, uint16_t len, int *out_count)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    ts24519_gate_control_entry_t *entries = NULL;

    ogs_assert(data);
    ogs_assert(out_count);

    *out_count = 0;

    while (p + 3 <= end) {
        uint8_t iei = *p;
        uint16_t ie_len = read_uint16_be(p + 1);

        if (iei == TS24519_IEI_GATE_CONTROL_LIST) {
            const uint8_t *value = p + 3;
            int count, i;

            if (p + 3 + ie_len > end) break;
            if (ie_len % GCL_ENTRY_SIZE != 0) break;

            count = ie_len / GCL_ENTRY_SIZE;
            entries = ogs_calloc(count, sizeof(*entries));
            if (!entries) return NULL;

            for (i = 0; i < count; i++) {
                entries[i].gate_states = *value++;
                entries[i].time_interval_ns = read_uint32_be(value);
                value += 4;
            }

            *out_count = count;
            return entries;
        }

        p += 3 + ie_len;
    }

    return NULL;
}

/*
 * Stream Gate Instance (IEI 0x90)
 * Each entry: 4 bytes instance_id + 1 byte gate_open + 1 byte ipv = 6 bytes
 */
#define STREAM_GATE_ENTRY_SIZE 6

uint8_t *ts24519_encode_stream_gates(
        ts24519_stream_gate_t *gates, int count,
        uint16_t *out_len)
{
    uint16_t value_len;
    uint16_t total_len;
    uint8_t *buf, *p;
    int i;

    ogs_assert(gates);
    ogs_assert(out_len);

    if (count <= 0) return NULL;

    value_len = count * STREAM_GATE_ENTRY_SIZE;
    total_len = 1 + 2 + value_len;

    buf = ogs_calloc(1, total_len);
    if (!buf) return NULL;

    p = buf;
    *p++ = TS24519_IEI_STREAM_GATE_INSTANCE;
    write_uint16_be(p, value_len);
    p += 2;

    for (i = 0; i < count; i++) {
        write_uint32_be(p, gates[i].instance_id);
        p += 4;
        *p++ = gates[i].gate_open ? 1 : 0;
        *p++ = gates[i].ipv;
    }

    *out_len = total_len;
    return buf;
}

ts24519_stream_gate_t *ts24519_decode_stream_gates(
        const uint8_t *data, uint16_t len, int *out_count)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    ts24519_stream_gate_t *gates = NULL;

    ogs_assert(data);
    ogs_assert(out_count);

    *out_count = 0;

    while (p + 3 <= end) {
        uint8_t iei = *p;
        uint16_t ie_len = read_uint16_be(p + 1);
        const uint8_t *value = p + 3;
        int i, count;

        if (iei == TS24519_IEI_STREAM_GATE_INSTANCE) {
            if (ie_len % STREAM_GATE_ENTRY_SIZE != 0) break;

            count = ie_len / STREAM_GATE_ENTRY_SIZE;
            gates = ogs_calloc(count, sizeof(*gates));
            if (!gates) return NULL;

            for (i = 0; i < count; i++) {
                gates[i].instance_id = read_uint32_be(value);
                value += 4;
                gates[i].gate_open = (*value++ != 0);
                gates[i].ipv = *value++;
            }

            *out_count = count;
            return gates;
        }

        p += 3 + ie_len;
    }

    return NULL;
}

uint8_t *ts24519_encode_psfp_container(
        ts24519_stream_filter_t *filters, int filter_count,
        ts24519_stream_gate_t *gates, int gate_count,
        uint16_t *out_len)
{
    uint8_t *filter_buf = NULL, *gate_buf = NULL, *combined = NULL;
    uint16_t filter_len = 0, gate_len = 0, total_len = 0;

    ogs_assert(out_len);

    if (filters && filter_count > 0)
        filter_buf = ts24519_encode_stream_filters(
                filters, filter_count, &filter_len);

    if (gates && gate_count > 0)
        gate_buf = ts24519_encode_stream_gates(
                gates, gate_count, &gate_len);

    total_len = filter_len + gate_len;
    if (total_len == 0) {
        *out_len = 0;
        return NULL;
    }

    combined = ogs_calloc(1, total_len);
    if (!combined) {
        if (filter_buf) ogs_free(filter_buf);
        if (gate_buf) ogs_free(gate_buf);
        return NULL;
    }

    if (filter_buf) {
        memcpy(combined, filter_buf, filter_len);
        ogs_free(filter_buf);
    }
    if (gate_buf) {
        memcpy(combined + filter_len, gate_buf, gate_len);
        ogs_free(gate_buf);
    }

    *out_len = total_len;
    return combined;
}

/*
 * Flow Meter Instance (IEI 0xC0)
 * Each entry: 4 bytes meter_id + 4 bytes CIR + 4 bytes CBS = 12 bytes
 */
#define FLOW_METER_ENTRY_SIZE 12

uint8_t *ts24519_encode_flow_meters(
        ts24519_flow_meter_t *meters, int count,
        uint16_t *out_len)
{
    uint16_t value_len;
    uint16_t total_len;
    uint8_t *buf, *p;
    int i;

    ogs_assert(meters);
    ogs_assert(out_len);

    if (count <= 0) return NULL;

    value_len = count * FLOW_METER_ENTRY_SIZE;
    total_len = 1 + 2 + value_len;

    buf = ogs_calloc(1, total_len);
    if (!buf) return NULL;

    p = buf;
    *p++ = TS24519_IEI_FLOW_METER_INSTANCE;
    write_uint16_be(p, value_len);
    p += 2;

    for (i = 0; i < count; i++) {
        write_uint32_be(p, meters[i].meter_id);
        p += 4;
        write_uint32_be(p, meters[i].committed_info_rate);
        p += 4;
        write_uint32_be(p, meters[i].committed_burst_size);
        p += 4;
    }

    *out_len = total_len;
    return buf;
}

ts24519_flow_meter_t *ts24519_decode_flow_meters(
        const uint8_t *data, uint16_t len, int *out_count)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    ts24519_flow_meter_t *meters = NULL;

    ogs_assert(data);
    ogs_assert(out_count);

    *out_count = 0;

    while (p + 3 <= end) {
        uint8_t iei = *p;
        uint16_t ie_len = read_uint16_be(p + 1);
        const uint8_t *value = p + 3;
        int i, count;

        if (iei == TS24519_IEI_FLOW_METER_INSTANCE) {
            if (ie_len % FLOW_METER_ENTRY_SIZE != 0) break;

            count = ie_len / FLOW_METER_ENTRY_SIZE;
            meters = ogs_calloc(count, sizeof(*meters));
            if (!meters) return NULL;

            for (i = 0; i < count; i++) {
                meters[i].meter_id = read_uint32_be(value);
                value += 4;
                meters[i].committed_info_rate = read_uint32_be(value);
                value += 4;
                meters[i].committed_burst_size = read_uint32_be(value);
                value += 4;
            }

            *out_count = count;
            return meters;
        }

        p += 3 + ie_len;
    }

    return NULL;
}

uint8_t *ts24519_encode_psfp_container_full(
        ts24519_stream_filter_t *filters, int filter_count,
        ts24519_stream_gate_t *gates, int gate_count,
        ts24519_flow_meter_t *meters, int meter_count,
        uint16_t *out_len)
{
    uint8_t *filter_buf = NULL, *gate_buf = NULL, *meter_buf = NULL;
    uint8_t *combined = NULL;
    uint16_t filter_len = 0, gate_len = 0, meter_len = 0, total_len = 0;
    uint16_t offset = 0;

    ogs_assert(out_len);

    if (filters && filter_count > 0)
        filter_buf = ts24519_encode_stream_filters(
                filters, filter_count, &filter_len);

    if (gates && gate_count > 0)
        gate_buf = ts24519_encode_stream_gates(
                gates, gate_count, &gate_len);

    if (meters && meter_count > 0)
        meter_buf = ts24519_encode_flow_meters(
                meters, meter_count, &meter_len);

    total_len = filter_len + gate_len + meter_len;
    if (total_len == 0) {
        *out_len = 0;
        return NULL;
    }

    combined = ogs_calloc(1, total_len);
    if (!combined) {
        if (filter_buf) ogs_free(filter_buf);
        if (gate_buf) ogs_free(gate_buf);
        if (meter_buf) ogs_free(meter_buf);
        return NULL;
    }

    if (filter_buf) {
        memcpy(combined + offset, filter_buf, filter_len);
        offset += filter_len;
        ogs_free(filter_buf);
    }
    if (gate_buf) {
        memcpy(combined + offset, gate_buf, gate_len);
        offset += gate_len;
        ogs_free(gate_buf);
    }
    if (meter_buf) {
        memcpy(combined + offset, meter_buf, meter_len);
        ogs_free(meter_buf);
    }

    *out_len = total_len;
    return combined;
}
