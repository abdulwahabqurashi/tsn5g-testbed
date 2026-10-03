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

#include "context.h"
#include "gtp-path.h"
#include "nwtt.h"

#if HAVE_NET_ETHERNET_H
#include <net/ethernet.h>
#endif

#include <time.h>

/*
 * High-precision nanosecond timestamp.
 *
 * Uses CLOCK_MONOTONIC_RAW by default for residence time measurement.
 * CLOCK_MONOTONIC_RAW is not affected by NTP/phc2sys adjustments,
 * so durations measured on the same machine won't have clock-step artifacts.
 *
 * When phc2sys is running (syncing system clock to NIC's PHC), the user
 * can select CLOCK_REALTIME for absolute time that is PHC-synchronized.
 *
 * Precision: nanoseconds (~1 ns resolution vs ~1 us from gettimeofday).
 */
uint64_t upf_nwtt_clock_gettime_ns(void)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;
    struct timespec ts;
    clockid_t clk;

    switch (bridge->timestamp.clock_source) {
    case UPF_NWTT_CLOCK_REALTIME:
        clk = CLOCK_REALTIME;
        break;
    case UPF_NWTT_CLOCK_MONOTONIC:
        clk = CLOCK_MONOTONIC_RAW;
        break;
    case UPF_NWTT_CLOCK_SOFTWARE:
    default:
        /* Fallback: gettimeofday-equivalent via CLOCK_REALTIME */
        clk = CLOCK_REALTIME;
        break;
    }

    if (clock_gettime(clk, &ts) != 0) {
        /* Should never fail, but fallback to ogs_time_now */
        return (uint64_t)ogs_time_now() * 1000ULL;
    }

    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

const char *upf_nwtt_clock_source_name(int clock_source)
{
    switch (clock_source) {
    case UPF_NWTT_CLOCK_MONOTONIC:
        return "CLOCK_MONOTONIC_RAW";
    case UPF_NWTT_CLOCK_REALTIME:
        return "CLOCK_REALTIME";
    case UPF_NWTT_CLOCK_SOFTWARE:
    default:
        return "software (gettimeofday)";
    }
}

/*
 * Detect if phc2sys is running (indicates PHC-to-system-clock sync).
 * Also checks for hardware timestamping support on the configured interface.
 */
void upf_nwtt_detect_phc2sys(void)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;
    FILE *fp;
    char line[256];
    char path[128];

    /* Check if phc2sys process is running */
    bridge->timestamp.phc2sys_detected = false;
    fp = popen("pgrep -x phc2sys 2>/dev/null", "r");
    if (fp) {
        if (fgets(line, sizeof(line), fp) != NULL) {
            bridge->timestamp.phc2sys_detected = true;
        }
        pclose(fp);
    }

    /* Check hardware timestamping on configured interface */
    if (bridge->timestamp.phc_interface[0]) {
        ogs_snprintf(path, sizeof(path),
                "/sys/class/net/%s/device/driver",
                bridge->timestamp.phc_interface);
        fp = fopen(path, "r");
        if (fp) {
            fclose(fp);
            ogs_info("[NW-TT] PHC interface '%s' exists",
                    bridge->timestamp.phc_interface);
        } else {
            ogs_warn("[NW-TT] PHC interface '%s' not found",
                    bridge->timestamp.phc_interface);
        }
    }

    if (bridge->timestamp.phc2sys_detected) {
        ogs_info("[NW-TT] phc2sys detected: system clock is PHC-synchronized");
    } else {
        ogs_info("[NW-TT] phc2sys not detected: using unsynchronized %s",
                upf_nwtt_clock_source_name(bridge->timestamp.clock_source));
    }

    ogs_info("[NW-TT] Timestamp source: %s (nanosecond precision)",
            upf_nwtt_clock_source_name(bridge->timestamp.clock_source));
}

/*
 * NW-TT Port Management
 */
upf_nwtt_port_t *upf_nwtt_port_add(ogs_pool_id_t sess_id)
{
    upf_nwtt_port_t *port = NULL;
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;

    port = ogs_calloc(1, sizeof(*port));
    if (!port) {
        ogs_error("upf_nwtt_port_add: ogs_calloc() failed");
        return NULL;
    }

    port->port_number = bridge->next_port_number++;
    port->sess_id = sess_id;
    port->num_filters = 0;
    port->dejitter.enabled = false;
    ogs_list_init(&port->dejitter.queue);

    /* Derive port MAC from bridge MAC: last octet += (port_number + 1)
     * e.g. bridge aa:bb:cc:dd:ee:00 → port 0 = aa:bb:cc:dd:ee:01 */
    memcpy(port->mac_addr, bridge->bridge_mac, 6);
    port->mac_addr[5] =
        (uint8_t)(bridge->bridge_mac[5] + port->port_number + 1);

    /* Copy default QoS mappings from bridge config */
    if (bridge->num_default_qos_mappings > 0) {
        int i;
        port->num_qos_mappings = bridge->num_default_qos_mappings;
        for (i = 0; i < bridge->num_default_qos_mappings; i++) {
            port->qos_mappings[i].pcp =
                bridge->default_qos_mappings[i].pcp;
            port->qos_mappings[i].qfi =
                bridge->default_qos_mappings[i].qfi;
            port->qos_mappings[i].active =
                bridge->default_qos_mappings[i].active;
        }
        ogs_info("[NW-TT] Port %u: copied %d default QoS mappings",
                bridge->next_port_number - 1,
                bridge->num_default_qos_mappings);
    }

    ogs_list_add(&bridge->port_list, port);

    ogs_info("[NW-TT] Port %u added for session "
            "(MAC %02x:%02x:%02x:%02x:%02x:%02x)",
            port->port_number,
            port->mac_addr[0], port->mac_addr[1], port->mac_addr[2],
            port->mac_addr[3], port->mac_addr[4], port->mac_addr[5]);

    return port;
}

void upf_nwtt_port_remove(upf_nwtt_port_t *port)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;
    upf_nwtt_dejitter_entry_t *entry = NULL, *next = NULL;

    ogs_assert(port);

    ogs_list_remove(&bridge->port_list, port);

    /* Free port management container */
    if (port->port_mgmt_container)
        ogs_free(port->port_mgmt_container);

    /* Free de-jitter queue */
    ogs_list_for_each_safe(&port->dejitter.queue, next, entry) {
        ogs_list_remove(&port->dejitter.queue, entry);
        if (entry->pkbuf)
            ogs_pkbuf_free(entry->pkbuf);
        ogs_free(entry);
    }
    if (port->dejitter.timer)
        ogs_timer_delete(port->dejitter.timer);

    ogs_info("[NW-TT] Port %u removed", port->port_number);

    ogs_free(port);
}

upf_nwtt_port_t *upf_nwtt_port_find_by_number(uint32_t port_number)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;
    upf_nwtt_port_t *port = NULL;

    ogs_list_for_each(&bridge->port_list, port) {
        if (port->port_number == port_number)
            return port;
    }

    return NULL;
}

/*
 * TSC Management Information handling
 */
/*
 * TS 24.519 IEI constants for container decoding
 */
#define TS24519_IEI_STREAM_FILTER   0x80
#define TS24519_IEI_STREAM_GATE     0x90
#define TS24519_IEI_FLOW_METER      0xC0

/* Stream filter entry: 18 bytes each */
#define TS24519_STREAM_FILTER_SIZE  18
/* Stream gate entry: 6 bytes each */
#define TS24519_STREAM_GATE_SIZE    6
/* Flow meter entry: 12 bytes each */
#define TS24519_FLOW_METER_SIZE     12

static uint16_t read_be16(const uint8_t *p)
{
    return ((uint16_t)p[0] << 8) | p[1];
}

static uint32_t read_be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | p[3];
}

/*
 * Decode TS 24.519 port management container and populate
 * stream filters, gates, and PSFP meter on the NW-TT port.
 */
static void decode_port_mgmt_container(
        upf_nwtt_port_t *port, uint8_t *data, uint16_t len)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;

    /* Reset stream filters */
    port->num_filters = 0;
    port->meter.active = false;

    while (p + 3 <= end) {
        uint8_t iei = *p;
        uint16_t ie_len = read_be16(p + 1);
        const uint8_t *value = p + 3;

        if (p + 3 + ie_len > end)
            break;

        switch (iei) {
        case TS24519_IEI_STREAM_FILTER:
        {
            int count, i;

            if (ie_len % TS24519_STREAM_FILTER_SIZE != 0)
                break;

            count = ie_len / TS24519_STREAM_FILTER_SIZE;
            if (count > UPF_NWTT_MAX_STREAM_FILTERS)
                count = UPF_NWTT_MAX_STREAM_FILTERS;

            for (i = 0; i < count; i++) {
                upf_nwtt_stream_filter_t *f = &port->filters[i];
                const uint8_t *entry =
                    value + (i * TS24519_STREAM_FILTER_SIZE);

                memset(f, 0, sizeof(*f));
                /* skip instance_id (4 bytes) */
                memcpy(f->dest_mac, entry + 4, 6);
                f->vlan_id = read_be16(entry + 10);
                f->vlan_present = (f->vlan_id != 0);
                /* skip priority (2 bytes) and gate_id (4 bytes) */
                f->active = true;
                f->match_count = 0;
                f->match_bytes = 0;
            }

            port->num_filters = count;
            ogs_info("[NW-TT] Port %u: decoded %d stream filters",
                    port->port_number, count);
            break;
        }

        case TS24519_IEI_STREAM_GATE:
            /* Stream gate instances — log only, no queue scheduling */
            if (ie_len >= TS24519_STREAM_GATE_SIZE) {
                int count = ie_len / TS24519_STREAM_GATE_SIZE;
                ogs_info("[NW-TT] Port %u: decoded %d stream gate instances",
                        port->port_number, count);
            }
            break;

        case 0x70: /* TS24519_IEI_TRAFFIC_CLASS_TABLE */
        {
            /* Traffic class table: 2 bytes per entry (priority + queue_id)
             * We use this to dynamically update PCP→QFI mappings */
            int count, i;

            if (ie_len % 2 != 0)
                break;

            count = ie_len / 2;
            if (count > 8) count = 8;

            port->num_qos_mappings = 0;
            for (i = 0; i < count; i++) {
                uint8_t pcp = value[i * 2];
                uint8_t qfi = value[i * 2 + 1];
                if (pcp < 8) {
                    port->qos_mappings[port->num_qos_mappings].pcp = pcp;
                    port->qos_mappings[port->num_qos_mappings].qfi = qfi;
                    port->qos_mappings[port->num_qos_mappings].active = true;
                    port->num_qos_mappings++;
                }
            }
            ogs_info("[NW-TT] Port %u: updated %d QoS mappings from "
                    "traffic class table",
                    port->port_number, port->num_qos_mappings);
            break;
        }

        case TS24519_IEI_FLOW_METER:
        {
            /* Apply first flow meter to the port's PSFP meter */
            if (ie_len >= TS24519_FLOW_METER_SIZE) {
                /* skip meter_id (4 bytes) */
                port->meter.committed_info_rate = read_be32(value + 4);
                port->meter.committed_burst_size = read_be32(value + 8);
                port->meter.tokens = port->meter.committed_burst_size;
                port->meter.last_update = ogs_get_monotonic_time();
                port->meter.active = true;

                ogs_info("[NW-TT] Port %u: PSFP meter CIR=%u bps CBS=%u bytes",
                        port->port_number,
                        port->meter.committed_info_rate,
                        port->meter.committed_burst_size);

                /* Log additional meters */
                if (ie_len / TS24519_FLOW_METER_SIZE > 1) {
                    ogs_info("[NW-TT] Port %u: %d additional meters "
                            "(only first applied)",
                            port->port_number,
                            (int)(ie_len / TS24519_FLOW_METER_SIZE) - 1);
                }
            }
            break;
        }

        default:
            ogs_debug("[NW-TT] Port %u: unknown IEI 0x%02x (%u bytes)",
                    port->port_number, iei, ie_len);
            break;
        }

        p += 3 + ie_len;
    }
}

static void apply_port_mgmt_container(
        upf_nwtt_port_t *port,
        uint8_t *data, uint16_t len)
{
    ogs_assert(port);

    if (port->port_mgmt_container)
        ogs_free(port->port_mgmt_container);

    if (data && len > 0) {
        port->port_mgmt_container = ogs_memdup(data, len);
        port->port_mgmt_container_len = len;

        /* Decode TS 24.519 IEs to populate stream filters, meters */
        decode_port_mgmt_container(port, data, len);

        ogs_info("[NW-TT] Port %u: updated port mgmt container (%u bytes)",
                port->port_number, len);
    } else {
        port->port_mgmt_container = NULL;
        port->port_mgmt_container_len = 0;
        port->num_filters = 0;
        port->meter.active = false;
    }
}

static void apply_bridge_mgmt_container(
        uint8_t *data, uint16_t len)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;

    if (bridge->bridge_mgmt_container)
        ogs_free(bridge->bridge_mgmt_container);

    if (data && len > 0) {
        bridge->bridge_mgmt_container = ogs_memdup(data, len);
        bridge->bridge_mgmt_container_len = len;
        ogs_info("[NW-TT] Updated bridge mgmt container (%u bytes)", len);
    } else {
        bridge->bridge_mgmt_container = NULL;
        bridge->bridge_mgmt_container_len = 0;
    }
}

int upf_nwtt_handle_tsc_management_info(
        void *sess_ptr,
        uint8_t *port_mgmt_data, uint16_t port_mgmt_len,
        uint8_t *bridge_mgmt_data, uint16_t bridge_mgmt_len,
        uint8_t *nwtt_port_data, uint16_t nwtt_port_len)
{
    upf_sess_t *sess = (upf_sess_t *)sess_ptr;

    ogs_assert(sess);

    if (!sess->tsc.is_tsn || !sess->tsc.nwtt_port) {
        ogs_warn("[NW-TT] TSC mgmt info for non-TSN session");
        return OGS_ERROR;
    }

    /* Apply port management container */
    if (port_mgmt_data && port_mgmt_len > 0) {
        apply_port_mgmt_container(
                sess->tsc.nwtt_port, port_mgmt_data, port_mgmt_len);
    }

    /* Apply bridge management container */
    if (bridge_mgmt_data && bridge_mgmt_len > 0) {
        apply_bridge_mgmt_container(bridge_mgmt_data, bridge_mgmt_len);
    }

    /* Update NW-TT port number if provided */
    if (nwtt_port_data && nwtt_port_len >= 4) {
        uint32_t new_port = 0;
        memcpy(&new_port, nwtt_port_data, 4);
        new_port = be32toh(new_port);
        ogs_info("[NW-TT] Port number update: %u -> %u",
                sess->tsc.nwtt_port->port_number, new_port);
    }

    return OGS_OK;
}

/*
 * Stream filter matching
 *
 * Match an Ethernet frame against a port's stream filter entries.
 * Returns true if the frame matches any filter (or if no filters are set).
 */
bool upf_nwtt_stream_filter_match(
        upf_nwtt_port_t *port, uint8_t *eth_frame, int len)
{
    int i;

    ogs_assert(port);

    if (port->num_filters == 0)
        return true;

    if (len < ETHER_HDR_LEN_SIZE)
        return false;

    for (i = 0; i < port->num_filters; i++) {
        upf_nwtt_stream_filter_t *f = &port->filters[i];

        if (!f->active)
            continue;

        /* Compare destination MAC (first 6 bytes of Ethernet frame) */
        if (memcmp(eth_frame, f->dest_mac, 6) != 0)
            continue;

        /* If VLAN filter is set, check 802.1Q tag */
        if (f->vlan_present) {
            uint16_t eth_type;
            uint16_t tci;
            uint16_t vid;

            memcpy(&eth_type, eth_frame + 12, 2);
            eth_type = be16toh(eth_type);

            if (eth_type == 0x8100) { /* 802.1Q tag */
                memcpy(&tci, eth_frame + 14, 2);
                tci = be16toh(tci);
                vid = tci & 0x0FFF;
                if (vid != f->vlan_id)
                    continue;
            } else {
                /* Frame has no VLAN tag but filter requires one */
                continue;
            }
        }

        f->match_count++;
        f->match_bytes += len;
        return true;
    }

    port->filter_miss_count++;
    return false;
}

/*
 * gPTP frame detection and handling
 */
bool upf_nwtt_is_gptp_frame(uint8_t *eth_frame, int len)
{
    uint16_t eth_type;

    if (len < ETHER_HDR_LEN_SIZE)
        return false;

    memcpy(&eth_type, eth_frame + 12, 2);
    eth_type = be16toh(eth_type);

    return (eth_type == ETHERTYPE_PTP);
}

/*
 * Add residence time correction to a gPTP frame.
 *
 * Per IEEE 802.1AS, transparent clocks (including the 5GS bridge)
 * must add their residence time to the correctionField of PTP event messages.
 * The correctionField is a 48.16 fixed-point nanoseconds value at
 * offset 8 in the PTP header (which starts after the Ethernet header).
 */
void upf_nwtt_gptp_add_residence_time(
        uint8_t *eth_frame, int len, uint64_t ingress_time_ns)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;
    upf_ptp_header_t *ptp;
    int64_t correction;
    uint64_t now_ns;
    int64_t residence_ns;
    int64_t residence_ns_fixed;
    int64_t residence_us;

    if (len < (int)(ETHER_HDR_LEN_SIZE + sizeof(upf_ptp_header_t)))
        return;

    ptp = (upf_ptp_header_t *)(eth_frame + ETHER_HDR_LEN_SIZE);

    /* Only add residence time to event messages (Sync, PDelay_Req/Resp) */
    if (ptp->msg_type != PTP_MSG_SYNC &&
        ptp->msg_type != PTP_MSG_PDELAY_REQ &&
        ptp->msg_type != PTP_MSG_PDELAY_RESP)
        return;

    /* Graceful degradation: skip correction when gPTP is not synced */
    if (bridge->gptp.degrade_on_unsync && !bridge->gptp.synced) {
        bridge->gptp.corrections_skipped++;
        ogs_debug("[NW-TT] gPTP correction skipped (not synced), "
                "total skipped: %llu",
                (unsigned long long)bridge->gptp.corrections_skipped);
        return;
    }

    /* Nanosecond-precision residence time calculation */
    now_ns = upf_nwtt_clock_gettime_ns();
    residence_ns = (int64_t)(now_ns - ingress_time_ns);

    /* Convert nanoseconds to 48.16 fixed-point nanoseconds:
     * shift left by 16 for fixed-point representation */
    residence_ns_fixed = residence_ns * 65536;

    /* Read current correctionField (big-endian 64-bit) */
    correction = (int64_t)be64toh((uint64_t)ptp->correction_field);

    /* Add residence time */
    correction += residence_ns_fixed;

    /* Write back */
    ptp->correction_field = (int64_t)htobe64((uint64_t)correction);

    residence_us = residence_ns / 1000;
    ogs_debug("[NW-TT] gPTP residence time: %lld ns (%lld.%03lld us) "
            "added to correction",
            (long long)residence_ns,
            (long long)(residence_ns / 1000),
            (long long)(residence_ns % 1000));

    /* Update per-port residence time statistics (nanosecond precision) */
    {
        upf_nwtt_port_t *p = NULL;
        ogs_list_for_each(&bridge->port_list, p) {
            if (p->port_number != 0) {
                p->residence_time_stats.total_frames++;
                p->residence_time_stats.last_ns = residence_ns;
                if (p->residence_time_stats.total_frames == 1) {
                    p->residence_time_stats.min_ns = residence_ns;
                    p->residence_time_stats.max_ns = residence_ns;
                    p->residence_time_stats.avg_ns = residence_ns;
                } else {
                    if (residence_ns < p->residence_time_stats.min_ns)
                        p->residence_time_stats.min_ns = residence_ns;
                    if (residence_ns > p->residence_time_stats.max_ns)
                        p->residence_time_stats.max_ns = residence_ns;
                    p->residence_time_stats.avg_ns =
                        (p->residence_time_stats.avg_ns *
                         (int64_t)(p->residence_time_stats.total_frames - 1)
                         + residence_ns) /
                        (int64_t)p->residence_time_stats.total_frames;
                }

                /* Histogram bucketing (still in microseconds for readability) */
                if (residence_us < 100)
                    p->rt_histogram.under_100++;
                else if (residence_us < 500)
                    p->rt_histogram.under_500++;
                else if (residence_us < 1000)
                    p->rt_histogram.under_1000++;
                else if (residence_us < 5000)
                    p->rt_histogram.under_5000++;
                else
                    p->rt_histogram.over_5000++;

                break; /* update first active port found */
            }
        }
    }
}

/*
 * De-jitter buffer: enqueue a packet for delayed release
 */
int upf_nwtt_dejitter_enqueue(upf_nwtt_port_t *port, ogs_pkbuf_t *pkbuf)
{
    upf_nwtt_dejitter_entry_t *entry = NULL;

    ogs_assert(port);
    ogs_assert(pkbuf);

    if (!port->dejitter.enabled)
        return OGS_ERROR;

    if (port->dejitter.queue_depth >= UPF_NWTT_MAX_DEJITTER_QUEUE) {
        ogs_warn("[NW-TT] De-jitter queue full for port %u, dropping packet",
                port->port_number);
        port->dejitter.dropped_overflow++;
        ogs_pkbuf_free(pkbuf);
        return OGS_ERROR;
    }

    entry = ogs_calloc(1, sizeof(*entry));
    if (!entry) {
        ogs_pkbuf_free(pkbuf);
        return OGS_ERROR;
    }

    entry->pkbuf = pkbuf;
    entry->ingress_time_ns = upf_nwtt_clock_gettime_ns();

    ogs_list_add(&port->dejitter.queue, entry);
    port->dejitter.queue_depth++;
    port->dejitter.enqueued++;
    if (port->dejitter.queue_depth > port->dejitter.peak_depth)
        port->dejitter.peak_depth = port->dejitter.queue_depth;

    return OGS_OK;
}

/*
 * De-jitter buffer dequeue.
 * Returns the oldest packet if it has been held for >= target_delay_us.
 * Returns NULL if no packet is ready.
 */
ogs_pkbuf_t *upf_nwtt_dejitter_dequeue(upf_nwtt_port_t *port)
{
    upf_nwtt_dejitter_entry_t *entry = NULL;
    uint64_t now_ns;
    uint64_t hold_ns;
    ogs_pkbuf_t *pkbuf = NULL;

    ogs_assert(port);

    if (!port->dejitter.enabled || port->dejitter.queue_depth == 0)
        return NULL;

    entry = (upf_nwtt_dejitter_entry_t *)
        ogs_list_first(&port->dejitter.queue);
    if (!entry)
        return NULL;

    now_ns = upf_nwtt_clock_gettime_ns();
    hold_ns = (uint64_t)port->dejitter.target_delay_us * 1000;

    if ((now_ns - entry->ingress_time_ns) >= hold_ns) {
        ogs_list_remove(&port->dejitter.queue, entry);
        port->dejitter.queue_depth--;
        port->dejitter.dequeued++;

        pkbuf = entry->pkbuf;
        ogs_free(entry);

        return pkbuf;
    }

    return NULL;
}

/*
 * Flush all packets from the de-jitter buffer (cleanup).
 */
void upf_nwtt_dejitter_flush(upf_nwtt_port_t *port)
{
    upf_nwtt_dejitter_entry_t *entry = NULL, *next = NULL;

    ogs_assert(port);

    ogs_list_for_each_safe(&port->dejitter.queue, next, entry) {
        ogs_list_remove(&port->dejitter.queue, entry);
        if (entry->pkbuf)
            ogs_pkbuf_free(entry->pkbuf);
        ogs_free(entry);
    }

    port->dejitter.queue_depth = 0;
}

/*
 * Initialize de-jitter buffer for a port.
 */
void upf_nwtt_dejitter_init(upf_nwtt_port_t *port, uint32_t target_delay_us)
{
    ogs_assert(port);

    memset(&port->dejitter, 0, sizeof(port->dejitter));
    ogs_list_init(&port->dejitter.queue);
    port->dejitter.target_delay_us = target_delay_us;
    port->dejitter.enabled = (target_delay_us > 0);

    if (port->dejitter.enabled) {
        ogs_info("[NW-TT] Port %u: de-jitter buffer enabled "
                "(target_delay=%u us)",
                port->port_number, target_delay_us);
    }
}

/*
 * LLDP frame detection and handling (IEEE 802.1AB)
 */
bool upf_nwtt_is_lldp_frame(uint8_t *eth_frame, int len)
{
    uint16_t eth_type;

    if (len < ETHER_HDR_LEN_SIZE)
        return false;

    memcpy(&eth_type, eth_frame + 12, 2);
    eth_type = be16toh(eth_type);

    return (eth_type == ETHERTYPE_LLDP);
}

int upf_nwtt_parse_lldp(uint8_t *eth_frame, int len,
        upf_nwtt_lldp_info_t *info)
{
    const uint8_t *p;
    const uint8_t *end;

    ogs_assert(eth_frame);
    ogs_assert(info);

    if (len < ETHER_HDR_LEN_SIZE + 2)
        return OGS_ERROR;

    memset(info, 0, sizeof(*info));

    /* LLDP TLVs start after Ethernet header */
    p = eth_frame + ETHER_HDR_LEN_SIZE;
    end = eth_frame + len;

    while (p + 2 <= end) {
        uint16_t tlv_header;
        uint8_t tlv_type;
        uint16_t tlv_len;

        memcpy(&tlv_header, p, 2);
        tlv_header = be16toh(tlv_header);
        tlv_type = (tlv_header >> 9) & 0x7F;
        tlv_len = tlv_header & 0x01FF;
        p += 2;

        if (p + tlv_len > end)
            break;

        switch (tlv_type) {
        case LLDP_TLV_END:
            goto done;
        case LLDP_TLV_CHASSIS_ID:
            if (tlv_len >= 2) {
                info->chassis_id_subtype = p[0];
                info->chassis_id_len = tlv_len - 1;
                if (info->chassis_id_len > sizeof(info->chassis_id))
                    info->chassis_id_len = sizeof(info->chassis_id);
                memcpy(info->chassis_id, p + 1, info->chassis_id_len);
            }
            break;
        case LLDP_TLV_PORT_ID:
            if (tlv_len >= 2) {
                info->port_id_subtype = p[0];
                info->port_id_len = tlv_len - 1;
                if (info->port_id_len > sizeof(info->port_id))
                    info->port_id_len = sizeof(info->port_id);
                memcpy(info->port_id, p + 1, info->port_id_len);
            }
            break;
        case LLDP_TLV_TTL:
            if (tlv_len >= 2) {
                info->ttl = ((uint16_t)p[0] << 8) | p[1];
            }
            break;
        case LLDP_TLV_PORT_DESC:
            if (tlv_len > 0 && tlv_len < sizeof(info->port_desc)) {
                memcpy(info->port_desc, p, tlv_len);
                info->port_desc[tlv_len] = '\0';
            }
            break;
        case LLDP_TLV_SYS_NAME:
            if (tlv_len > 0 && tlv_len < sizeof(info->system_name)) {
                memcpy(info->system_name, p, tlv_len);
                info->system_name[tlv_len] = '\0';
            }
            break;
        case LLDP_TLV_SYS_DESC:
            if (tlv_len > 0 && tlv_len < sizeof(info->system_desc)) {
                memcpy(info->system_desc, p, tlv_len);
                info->system_desc[tlv_len] = '\0';
            }
            break;
        default:
            break;
        }

        p += tlv_len;
    }

done:
    ogs_info("[NW-TT] LLDP parsed: chassis_id_len=%u port_id_len=%u ttl=%u",
            info->chassis_id_len, info->port_id_len, info->ttl);

    return OGS_OK;
}

int upf_nwtt_relay_lldp_frame(upf_nwtt_port_t *ingress_port,
        uint8_t *eth_frame, int len)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;
    upf_nwtt_port_t *egress_port = NULL;
    int relayed = 0;

    ogs_assert(ingress_port);
    ogs_assert(eth_frame);

    /*
     * LLDP relay: forward the LLDP frame to all other ports on the bridge.
     * For each egress port, find the session and send via GTP-U.
     */
    ogs_list_for_each(&bridge->port_list, egress_port) {
        upf_sess_t *dest_sess = NULL;
        ogs_pfcp_pdr_t *dest_pdr = NULL;
        ogs_pfcp_user_plane_report_t report;
        ogs_pkbuf_t *copy = NULL;

        if (egress_port == ingress_port)
            continue;

        dest_sess = upf_sess_find_by_id(egress_port->sess_id);
        if (!dest_sess) continue;

        /* Find Core→Access PDR for sending to UE */
        ogs_list_for_each(&dest_sess->pfcp.pdr_list, dest_pdr) {
            if (dest_pdr->src_if == OGS_PFCP_INTERFACE_CORE)
                break;
        }
        if (!dest_pdr) continue;

        copy = ogs_pkbuf_alloc(NULL, OGS_MAX_PKT_LEN);
        if (!copy) continue;
        ogs_pkbuf_reserve(copy, OGS_TUN_MAX_HEADROOM);
        ogs_pkbuf_put_data(copy, eth_frame, len);

        memset(&report, 0, sizeof(report));
        ogs_assert(true == ogs_pfcp_up_handle_pdr(
                    dest_pdr, OGS_GTPU_MSGTYPE_GPDU,
                    0, NULL, copy, &report));

        egress_port->traffic.rx_lldp_frames++;
        relayed++;

        ogs_debug("[NW-TT] LLDP relay: port %u -> port %u (%d bytes)",
                ingress_port->port_number,
                egress_port->port_number, len);
    }

    return relayed;
}

/*
 * LLDP frame construction (IEEE 802.1AB)
 *
 * Build an LLDP frame identifying this NW-TT bridge port.
 * Returns the total frame length, or -1 on error.
 */
int upf_nwtt_lldp_build_frame(uint8_t *buf, int max_len,
        upf_nwtt_port_t *port)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;
    uint8_t lldp_mcast[] = LLDP_MCAST_ADDR;
    uint8_t *p;
    uint16_t eth_type;
    uint16_t tlv_hdr;
    const char *sys_name = "Open5GS-NW-TT";
    const char *sys_desc = "5GS TSN Bridge NW-TT Port";
    char port_desc[64];
    int port_desc_len;
    int sys_name_len;
    int sys_desc_len;

    ogs_assert(buf);
    ogs_assert(port);

    if (max_len < 128)
        return -1;

    p = buf;

    /* Ethernet header */
    memcpy(p, lldp_mcast, 6);          /* Dest MAC: LLDP multicast */
    p += 6;
    memcpy(p, port->mac_addr, 6);      /* Source MAC: port MAC */
    p += 6;
    eth_type = htobe16(ETHERTYPE_LLDP);
    memcpy(p, &eth_type, 2);
    p += 2;

    /* Chassis ID TLV (type=1): MAC address subtype (4) */
    tlv_hdr = htobe16((LLDP_TLV_CHASSIS_ID << 9) | 7); /* 1 subtype + 6 MAC */
    memcpy(p, &tlv_hdr, 2); p += 2;
    *p++ = 4;  /* subtype: MAC address */
    memcpy(p, bridge->bridge_mac, 6); p += 6;

    /* Port ID TLV (type=2): locally assigned (7) */
    port_desc_len = ogs_snprintf(port_desc, sizeof(port_desc),
            "nwtt-port-%u", port->port_number);
    tlv_hdr = htobe16((LLDP_TLV_PORT_ID << 9) | (1 + port_desc_len));
    memcpy(p, &tlv_hdr, 2); p += 2;
    *p++ = 7;  /* subtype: locally assigned */
    memcpy(p, port_desc, port_desc_len); p += port_desc_len;

    /* TTL TLV (type=3) */
    tlv_hdr = htobe16((LLDP_TLV_TTL << 9) | 2);
    memcpy(p, &tlv_hdr, 2); p += 2;
    *p++ = (LLDP_DEFAULT_TTL >> 8) & 0xFF;
    *p++ = LLDP_DEFAULT_TTL & 0xFF;

    /* System Name TLV (type=5) */
    sys_name_len = strlen(sys_name);
    tlv_hdr = htobe16((LLDP_TLV_SYS_NAME << 9) | sys_name_len);
    memcpy(p, &tlv_hdr, 2); p += 2;
    memcpy(p, sys_name, sys_name_len); p += sys_name_len;

    /* System Description TLV (type=6) */
    sys_desc_len = strlen(sys_desc);
    tlv_hdr = htobe16((LLDP_TLV_SYS_DESC << 9) | sys_desc_len);
    memcpy(p, &tlv_hdr, 2); p += 2;
    memcpy(p, sys_desc, sys_desc_len); p += sys_desc_len;

    /* End TLV (type=0, length=0) */
    tlv_hdr = 0;
    memcpy(p, &tlv_hdr, 2); p += 2;

    return (int)(p - buf);
}

/*
 * LLDP origination: send LLDP frames from each NW-TT port
 * to the UE (via GTP-U) and to the DN (via TAP).
 */
void upf_nwtt_lldp_originate(void)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;
    upf_nwtt_port_t *port = NULL;
    uint8_t frame_buf[256];

    if (!bridge->enabled) return;

    ogs_list_for_each(&bridge->port_list, port) {
        upf_sess_t *sess = NULL;
        ogs_pfcp_pdr_t *pdr = NULL;
        ogs_pfcp_user_plane_report_t report;
        ogs_pkbuf_t *pkbuf = NULL;
        int frame_len;

        frame_len = upf_nwtt_lldp_build_frame(frame_buf, sizeof(frame_buf),
                port);
        if (frame_len <= 0) continue;

        sess = upf_sess_find_by_id(port->sess_id);
        if (!sess) continue;

        /* Send to UE via GTP-U */
        ogs_list_for_each(&sess->pfcp.pdr_list, pdr) {
            if (pdr->src_if == OGS_PFCP_INTERFACE_CORE)
                break;
        }
        if (pdr) {
            pkbuf = ogs_pkbuf_alloc(NULL, OGS_MAX_PKT_LEN);
            if (pkbuf) {
                ogs_pkbuf_reserve(pkbuf, OGS_TUN_MAX_HEADROOM);
                ogs_pkbuf_put_data(pkbuf, frame_buf, frame_len);

                memset(&report, 0, sizeof(report));
                ogs_assert(true == ogs_pfcp_up_handle_pdr(
                            pdr, OGS_GTPU_MSGTYPE_GPDU,
                            0, NULL, pkbuf, &report));
            }
        }

        /* Also write to TAP for DN */
        if (sess->eth_dev) {
            pkbuf = ogs_pkbuf_alloc(NULL, OGS_MAX_PKT_LEN);
            if (pkbuf) {
                ogs_pkbuf_reserve(pkbuf, OGS_TUN_MAX_HEADROOM);
                ogs_pkbuf_put_data(pkbuf, frame_buf, frame_len);

                if (ogs_tun_write(sess->eth_dev->fd, pkbuf) != OGS_OK)
                    ogs_warn("[NW-TT] LLDP originate: TAP write failed");
                ogs_pkbuf_free(pkbuf);
            }
        }

        ogs_debug("[NW-TT] LLDP originated on port %u (%d bytes)",
                port->port_number, frame_len);
    }
}

/*
 * PCP classification (IEEE 802.1Q priority)
 *
 * Extract the Priority Code Point from a VLAN-tagged Ethernet frame
 * and return the mapped QFI from the port's QoS mapping table.
 * Returns the QFI value or -1 if no mapping found.
 */
int upf_nwtt_classify_pcp(upf_nwtt_port_t *port,
        uint8_t *eth_frame, int len)
{
    uint16_t eth_type;
    uint16_t tci;
    uint8_t pcp;
    int i;

    ogs_assert(port);
    ogs_assert(eth_frame);

    if (len < ETHER_HDR_LEN_SIZE + 4)
        return -1;

    memcpy(&eth_type, eth_frame + 12, 2);
    eth_type = be16toh(eth_type);

    /* Must be 802.1Q tagged */
    if (eth_type != 0x8100)
        return -1;

    memcpy(&tci, eth_frame + 14, 2);
    tci = be16toh(tci);
    pcp = (tci >> 13) & 0x07;

    /* Look up QFI in port's QoS mapping table */
    for (i = 0; i < port->num_qos_mappings; i++) {
        if (port->qos_mappings[i].active &&
            port->qos_mappings[i].pcp == pcp) {
            port->pcp_stats[pcp].frames++;
            port->pcp_stats[pcp].bytes += len;
            return port->qos_mappings[i].qfi;
        }
    }

    return -1;
}

/*
 * PSFP check (IEEE 802.1Qci Per-Stream Filtering and Policing)
 *
 * Check if an Ethernet frame passes the PSFP meter for this port.
 * Returns true if the frame should be forwarded, false if dropped.
 */
bool upf_nwtt_psfp_check(upf_nwtt_port_t *port,
        uint8_t *eth_frame, int len)
{
    upf_nwtt_meter_t *meter;
    ogs_time_t now;
    ogs_time_t elapsed_us;
    uint64_t new_tokens;

    ogs_assert(port);

    meter = &port->meter;
    if (!meter->active)
        return true; /* no metering, pass through */

    now = ogs_time_now();

    /* Replenish tokens based on elapsed time */
    if (meter->last_update > 0) {
        elapsed_us = now - meter->last_update;
        /* tokens = CIR (bits/sec) * elapsed_us / 1000000 / 8 (bytes) */
        new_tokens = (uint64_t)meter->committed_info_rate *
                     (uint64_t)elapsed_us / 8000000ULL;
        meter->tokens += new_tokens;
        if (meter->tokens > meter->committed_burst_size)
            meter->tokens = meter->committed_burst_size;
    }
    meter->last_update = now;

    /* Check if enough tokens for this frame */
    if (meter->tokens >= (uint64_t)len) {
        meter->tokens -= (uint64_t)len;
        port->psfp_stats.passed_frames++;
        port->psfp_stats.passed_bytes += len;
        return true;
    }

    port->psfp_stats.dropped_frames++;
    port->psfp_stats.dropped_bytes += len;

    ogs_debug("[NW-TT] PSFP: frame dropped on port %u (size=%d, tokens=%llu)",
            port->port_number, len, (unsigned long long)meter->tokens);

    return false;
}

/*
 * Reverse QFI → PCP lookup
 *
 * Given a QFI from a GTP-U header, find the corresponding 802.1Q PCP
 * from the port's QoS mapping table (reverse of classify_pcp).
 * Returns PCP (0-7) or -1 if no mapping found.
 */
int upf_nwtt_reverse_qfi_to_pcp(upf_nwtt_port_t *port, uint8_t qfi)
{
    int i;

    ogs_assert(port);

    for (i = 0; i < port->num_qos_mappings; i++) {
        if (port->qos_mappings[i].active &&
            port->qos_mappings[i].qfi == qfi)
            return port->qos_mappings[i].pcp;
    }

    return -1;
}

/*
 * RFC 3550 jitter estimation (nanosecond precision)
 */
void upf_nwtt_port_update_jitter(upf_nwtt_port_t *port, uint64_t now_ns)
{
    ogs_assert(port);

    if (port->jitter.last_arrival_ns > 0) {
        int64_t interval =
            (int64_t)(now_ns - port->jitter.last_arrival_ns);
        if (port->jitter.samples == 0) {
            /* Seed the running mean with the first observed interval;
             * jitter is variation AROUND this, not the interval itself. */
            port->jitter.mean_interval_ns = interval;
        } else {
            /*
             * Packet Delay Variation: smooth the deviation of the
             * inter-arrival interval from its running mean. RFC 3550's
             * D = (Rj-Ri) - (Sj-Si); for periodic traffic the send
             * spacing (Sj-Si) is the mean interval, so subtract it.
             * Without this, J converged to the frame PERIOD (~1 s for
             * 1 Hz gPTP), not the jitter.
             */
            int64_t dev = interval - port->jitter.mean_interval_ns;
            int64_t abs_dev = dev > 0 ? dev : -dev;
            port->jitter.jitter_ns +=
                (abs_dev - port->jitter.jitter_ns) / 16;
            if (port->jitter.jitter_ns > port->jitter.peak_jitter_ns)
                port->jitter.peak_jitter_ns = port->jitter.jitter_ns;
            /* Update running mean interval (EWMA, same gain). */
            port->jitter.mean_interval_ns += dev / 16;
        }
        port->jitter.samples++;
    }
    port->jitter.last_arrival_ns = now_ns;
}

/*
 * Log comprehensive NW-TT port statistics
 */
void upf_nwtt_port_log_stats(upf_nwtt_port_t *port)
{
    int i;

    ogs_assert(port);

    ogs_info("[NW-TT] Port %u stats:", port->port_number);
    ogs_info("  Traffic: rx=%llu/%llu bytes, tx=%llu/%llu bytes, "
             "gPTP=%llu, LLDP=%llu",
             (unsigned long long)port->traffic.rx_frames,
             (unsigned long long)port->traffic.rx_bytes,
             (unsigned long long)port->traffic.tx_frames,
             (unsigned long long)port->traffic.tx_bytes,
             (unsigned long long)port->traffic.rx_gptp_frames,
             (unsigned long long)port->traffic.rx_lldp_frames);
    ogs_info("  PSFP: passed=%llu/%llu bytes, dropped=%llu/%llu bytes",
             (unsigned long long)port->psfp_stats.passed_frames,
             (unsigned long long)port->psfp_stats.passed_bytes,
             (unsigned long long)port->psfp_stats.dropped_frames,
             (unsigned long long)port->psfp_stats.dropped_bytes);
    ogs_info("  Residence time: min=%lld.%03lld avg=%lld.%03lld "
             "max=%lld.%03lld us (%llu frames)",
             (long long)(port->residence_time_stats.min_ns / 1000),
             (long long)(port->residence_time_stats.min_ns % 1000),
             (long long)(port->residence_time_stats.avg_ns / 1000),
             (long long)(port->residence_time_stats.avg_ns % 1000),
             (long long)(port->residence_time_stats.max_ns / 1000),
             (long long)(port->residence_time_stats.max_ns % 1000),
             (unsigned long long)port->residence_time_stats.total_frames);
    ogs_info("  RT histogram: <100us=%llu <500us=%llu <1ms=%llu "
             "<5ms=%llu >=5ms=%llu",
             (unsigned long long)port->rt_histogram.under_100,
             (unsigned long long)port->rt_histogram.under_500,
             (unsigned long long)port->rt_histogram.under_1000,
             (unsigned long long)port->rt_histogram.under_5000,
             (unsigned long long)port->rt_histogram.over_5000);
    ogs_info("  Jitter: current=%lld.%03lld peak=%lld.%03lld us (%llu samples)",
             (long long)(port->jitter.jitter_ns / 1000),
             (long long)(port->jitter.jitter_ns % 1000),
             (long long)(port->jitter.peak_jitter_ns / 1000),
             (long long)(port->jitter.peak_jitter_ns % 1000),
             (unsigned long long)port->jitter.samples);
    for (i = 0; i < 8; i++) {
        if (port->pcp_stats[i].frames > 0)
            ogs_info("  PCP[%d]: %llu frames, %llu bytes",
                     i, (unsigned long long)port->pcp_stats[i].frames,
                     (unsigned long long)port->pcp_stats[i].bytes);
    }
    if (port->dejitter.enabled)
        ogs_info("  De-jitter: enqueued=%llu dequeued=%llu "
                 "dropped=%llu peak_depth=%d",
                 (unsigned long long)port->dejitter.enqueued,
                 (unsigned long long)port->dejitter.dequeued,
                 (unsigned long long)port->dejitter.dropped_overflow,
                 port->dejitter.peak_depth);
    ogs_info("  Stream filters: %d active, %llu misses",
             port->num_filters,
             (unsigned long long)port->filter_miss_count);
}

/*
 * Reset all NW-TT port statistics to zero
 */
void upf_nwtt_port_reset_stats(upf_nwtt_port_t *port)
{
    int i;

    ogs_assert(port);

    memset(&port->traffic, 0, sizeof(port->traffic));
    memset(&port->psfp_stats, 0, sizeof(port->psfp_stats));
    memset(&port->residence_time_stats, 0,
           sizeof(port->residence_time_stats));
    memset(&port->rt_histogram, 0, sizeof(port->rt_histogram));
    port->jitter.last_arrival_ns = 0;
    port->jitter.jitter_ns = 0;
    port->jitter.peak_jitter_ns = 0;
    port->jitter.samples = 0;
    memset(&port->pcp_stats, 0, sizeof(port->pcp_stats));
    port->dejitter.enqueued = 0;
    port->dejitter.dequeued = 0;
    port->dejitter.dropped_overflow = 0;
    port->dejitter.peak_depth = 0;
    port->filter_miss_count = 0;

    /* Also reset per-filter counters */
    for (i = 0; i < port->num_filters; i++) {
        port->filters[i].match_count = 0;
        port->filters[i].match_bytes = 0;
    }
}

/*
 * LLDP periodic origination timer management
 */
static void lldp_tx_timer_cb(void *data)
{
    upf_event_t *e = upf_event_new(UPF_EVT_NWTT_TIMER);
    ogs_assert(e);
    e->timer_id = 1; /* LLDP TX */
    ogs_queue_push(ogs_app()->queue, e);
}

void upf_nwtt_lldp_start_tx(void)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;

    if (bridge->lldp_tx_timer) {
        ogs_warn("[NW-TT] LLDP TX timer already running");
        return;
    }

    bridge->lldp_tx_timer = ogs_timer_add(
            ogs_app()->timer_mgr, lldp_tx_timer_cb, NULL);
    ogs_assert(bridge->lldp_tx_timer);
    ogs_timer_start(bridge->lldp_tx_timer,
            ogs_time_from_sec(LLDP_TX_INTERVAL_SEC));

    ogs_info("[NW-TT] LLDP origination started (interval=%ds)",
            LLDP_TX_INTERVAL_SEC);
}

void upf_nwtt_lldp_stop_tx(void)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;

    if (bridge->lldp_tx_timer) {
        ogs_timer_delete(bridge->lldp_tx_timer);
        bridge->lldp_tx_timer = NULL;
        ogs_info("[NW-TT] LLDP origination stopped");
    }
}

/*
 * gPTP monitoring via pmc (PTP Management Client)
 *
 * Periodically queries a running ptp4l instance for clock
 * synchronization status using the pmc command-line tool.
 */
void upf_nwtt_gptp_poll_status(void)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;
    FILE *fp;
    char cmd[128];
    char line[256];

    if (!bridge->gptp.monitoring_enabled) return;

    /* Query CURRENT_DATA_SET for offset and path delay */
    ogs_snprintf(cmd, sizeof(cmd),
            "pmc -u -b 0 -t %d 'GET CURRENT_DATA_SET' 2>/dev/null",
            bridge->gptp.transport_specific);

    fp = popen(cmd, "r");
    if (!fp) {
        bridge->gptp.synced = false;
        return;
    }

    bridge->gptp.synced = false;
    while (fgets(line, sizeof(line), fp)) {
        char *val;

        if ((val = strstr(line, "offsetFromMaster")) != NULL) {
            val = strchr(val, ' ');
            if (val) {
                bridge->gptp.offset_from_master_ns = strtoll(val, NULL, 10);
                bridge->gptp.synced = true;
            }
        } else if ((val = strstr(line, "meanPathDelay")) != NULL) {
            val = strchr(val, ' ');
            if (val) {
                bridge->gptp.mean_path_delay_ns = strtoll(val, NULL, 10);
            }
        }
    }
    pclose(fp);

    /* Query PARENT_DATA_SET for GM identity */
    ogs_snprintf(cmd, sizeof(cmd),
            "pmc -u -b 0 -t %d 'GET PARENT_DATA_SET' 2>/dev/null",
            bridge->gptp.transport_specific);

    fp = popen(cmd, "r");
    if (fp) {
        while (fgets(line, sizeof(line), fp)) {
            char *val;
            if ((val = strstr(line, "grandmasterIdentity")) != NULL) {
                val = strchr(val, ' ');
                if (val) {
                    while (*val == ' ') val++;
                    ogs_snprintf(bridge->gptp.gm_identity,
                            sizeof(bridge->gptp.gm_identity), "%s", val);
                    /* Remove trailing newline */
                    char *nl = strchr(bridge->gptp.gm_identity, '\n');
                    if (nl) *nl = '\0';
                }
            }
        }
        pclose(fp);
    }

    bridge->gptp.last_poll_time = ogs_time_now();

    /* Detect and log sync state transitions */
    if (bridge->gptp.synced != bridge->gptp.prev_synced) {
        if (bridge->gptp.synced) {
            ogs_warn("[NW-TT] gPTP sync RESTORED: offset=%lld ns, "
                    "corrections_skipped=%llu",
                    (long long)bridge->gptp.offset_from_master_ns,
                    (unsigned long long)bridge->gptp.corrections_skipped);
        } else {
            ogs_warn("[NW-TT] gPTP sync LOST: residence time correction %s",
                    bridge->gptp.degrade_on_unsync ?
                    "SKIPPED" : "still applied (may be inaccurate)");
        }
        bridge->gptp.prev_synced = bridge->gptp.synced;
    }

    if (bridge->gptp.synced) {
        ogs_debug("[NW-TT] gPTP status: offset=%lld ns, "
                "path_delay=%lld ns, GM=%s",
                (long long)bridge->gptp.offset_from_master_ns,
                (long long)bridge->gptp.mean_path_delay_ns,
                bridge->gptp.gm_identity);
    } else {
        ogs_debug("[NW-TT] gPTP: pmc query returned no data "
                "(ptp4l may not be running)");
    }
}

static void gptp_poll_timer_cb(void *data)
{
    upf_event_t *e = upf_event_new(UPF_EVT_NWTT_TIMER);
    ogs_assert(e);
    e->timer_id = 2; /* gPTP poll */
    ogs_queue_push(ogs_app()->queue, e);
}

void upf_nwtt_gptp_start_monitoring(void)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;

    if (!bridge->gptp.monitoring_enabled) return;

    if (bridge->gptp.poll_timer) {
        ogs_warn("[NW-TT] gPTP poll timer already running");
        return;
    }

    bridge->gptp.poll_timer = ogs_timer_add(
            ogs_app()->timer_mgr, gptp_poll_timer_cb, NULL);
    ogs_assert(bridge->gptp.poll_timer);
    ogs_timer_start(bridge->gptp.poll_timer, ogs_time_from_sec(10));

    ogs_info("[NW-TT] gPTP monitoring started (poll_interval=10s, "
            "transport_specific=%d)",
            bridge->gptp.transport_specific);
}

void upf_nwtt_gptp_stop_monitoring(void)
{
    upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;

    if (bridge->gptp.poll_timer) {
        ogs_timer_delete(bridge->gptp.poll_timer);
        bridge->gptp.poll_timer = NULL;
        ogs_info("[NW-TT] gPTP monitoring stopped");
    }
}

/*
 * Encode TSN port metrics as a compact binary report.
 * Format: fixed 64-byte header with key metrics.
 *
 * Offset  Size  Field
 *  0      8     rx_frames
 *  8      8     tx_frames
 * 16      8     psfp_passed_frames
 * 24      8     psfp_dropped_frames
 * 32      8     residence_time_min_ns
 * 40      8     residence_time_max_ns
 * 48      8     residence_time_avg_ns
 * 56      8     jitter_ns (current)
 */
#define TSN_METRICS_REPORT_SIZE 64

static void write_be64(uint8_t *p, uint64_t v)
{
    p[0] = (v >> 56) & 0xFF;
    p[1] = (v >> 48) & 0xFF;
    p[2] = (v >> 40) & 0xFF;
    p[3] = (v >> 32) & 0xFF;
    p[4] = (v >> 24) & 0xFF;
    p[5] = (v >> 16) & 0xFF;
    p[6] = (v >> 8) & 0xFF;
    p[7] = v & 0xFF;
}

uint8_t *upf_nwtt_port_encode_metrics(
        upf_nwtt_port_t *port, uint16_t *out_len)
{
    uint8_t *buf = NULL;

    ogs_assert(port);
    ogs_assert(out_len);

    buf = ogs_calloc(1, TSN_METRICS_REPORT_SIZE);
    if (!buf) return NULL;

    write_be64(buf + 0,  port->traffic.rx_frames);
    write_be64(buf + 8,  port->traffic.tx_frames);
    write_be64(buf + 16, port->psfp_stats.passed_frames);
    write_be64(buf + 24, port->psfp_stats.dropped_frames);
    write_be64(buf + 32, (uint64_t)port->residence_time_stats.min_ns);
    write_be64(buf + 40, (uint64_t)port->residence_time_stats.max_ns);
    write_be64(buf + 48, (uint64_t)port->residence_time_stats.avg_ns);
    write_be64(buf + 56, (uint64_t)port->jitter.jitter_ns);

    *out_len = TSN_METRICS_REPORT_SIZE;

    ogs_info("[NW-TT] Port %u metrics encoded: rx=%llu tx=%llu "
            "psfp_pass=%llu psfp_drop=%llu rt_avg=%lld ns jitter=%lld ns",
            port->port_number,
            (unsigned long long)port->traffic.rx_frames,
            (unsigned long long)port->traffic.tx_frames,
            (unsigned long long)port->psfp_stats.passed_frames,
            (unsigned long long)port->psfp_stats.dropped_frames,
            (long long)port->residence_time_stats.avg_ns,
            (long long)port->jitter.jitter_ns);

    return buf;
}
