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

/*
 * TSN analytics JSON dumper for the Prometheus HTTP server (/tsn-info).
 * Serializes all NW-TT port analytics as JSON using ogs_snprintf.
 *
 * path: http://UPF_IP:9090/tsn-info
 */

#include "context.h"
#include "nwtt.h"
#include "tsn-info.h"

static size_t dump_port(char *p, char *end, upf_nwtt_port_t *port,
        bool first_port)
{
    char *start = p;
    int i;
    bool first;

    if (!first_port)
        p += ogs_snprintf(p, end - p, ",");

    p += ogs_snprintf(p, end - p,
            "{\"port_number\":%u,"
            "\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",",
            port->port_number,
            port->mac_addr[0], port->mac_addr[1], port->mac_addr[2],
            port->mac_addr[3], port->mac_addr[4], port->mac_addr[5]);

    /* Device identity learned from uplink traffic (DS-TT side MACs).
     * "ue_mac" keeps the most recently seen for backward compatibility;
     * "ue_macs" lists every device behind the session. */
    {
        upf_sess_t *sess = upf_sess_find_by_id(port->sess_id);
        if (sess && sess->num_of_ue_macs > 0) {
            const uint8_t *m = upf_sess_latest_ue_mac(sess);
            int i, n = 0;

            if (m)
                p += ogs_snprintf(p, end - p,
                        "\"ue_mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",",
                        m[0], m[1], m[2], m[3], m[4], m[5]);
            p += ogs_snprintf(p, end - p, "\"ue_macs\":[");
            for (i = 0; i < UPF_MAX_UE_MACS; i++) {
                if (!sess->ue_macs[i].used)
                    continue;
                p += ogs_snprintf(p, end - p,
                        "%s\"%02x:%02x:%02x:%02x:%02x:%02x\"",
                        n ? "," : "",
                        sess->ue_macs[i].addr[0], sess->ue_macs[i].addr[1],
                        sess->ue_macs[i].addr[2], sess->ue_macs[i].addr[3],
                        sess->ue_macs[i].addr[4], sess->ue_macs[i].addr[5]);
                n++;
            }
            p += ogs_snprintf(p, end - p, "],");
            if (sess->gw_mac_learned)
                p += ogs_snprintf(p, end - p,
                        "\"gw_mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",",
                        sess->gw_mac[0], sess->gw_mac[1], sess->gw_mac[2],
                        sess->gw_mac[3], sess->gw_mac[4], sess->gw_mac[5]);
        }
    }

    /* Traffic */
    p += ogs_snprintf(p, end - p,
            "\"traffic\":{"
            "\"rx_frames\":%llu,\"rx_bytes\":%llu,"
            "\"tx_frames\":%llu,\"tx_bytes\":%llu,"
            "\"gptp_frames\":%llu,\"lldp_frames\":%llu,"
            "\"mbr_dropped_frames\":%llu},",
            (unsigned long long)port->traffic.rx_frames,
            (unsigned long long)port->traffic.rx_bytes,
            (unsigned long long)port->traffic.tx_frames,
            (unsigned long long)port->traffic.tx_bytes,
            (unsigned long long)port->traffic.rx_gptp_frames,
            (unsigned long long)port->traffic.rx_lldp_frames,
            (unsigned long long)port->traffic.mbr_dropped_frames);

    /* PSFP */
    p += ogs_snprintf(p, end - p,
            "\"psfp\":{"
            "\"passed_frames\":%llu,\"passed_bytes\":%llu,"
            "\"dropped_frames\":%llu,\"dropped_bytes\":%llu},",
            (unsigned long long)port->psfp_stats.passed_frames,
            (unsigned long long)port->psfp_stats.passed_bytes,
            (unsigned long long)port->psfp_stats.dropped_frames,
            (unsigned long long)port->psfp_stats.dropped_bytes);

    /* Residence time (nanosecond precision, also report in us for compat) */
    p += ogs_snprintf(p, end - p,
            "\"residence_time\":{"
            "\"total_frames\":%llu,"
            "\"min_ns\":%lld,\"max_ns\":%lld,\"avg_ns\":%lld,"
            "\"min_us\":%lld,\"max_us\":%lld,\"avg_us\":%lld,"
            "\"histogram\":{"
            "\"under_100us\":%llu,\"under_500us\":%llu,"
            "\"under_1ms\":%llu,\"under_5ms\":%llu,\"over_5ms\":%llu}},",
            (unsigned long long)port->residence_time_stats.total_frames,
            (long long)port->residence_time_stats.min_ns,
            (long long)port->residence_time_stats.max_ns,
            (long long)port->residence_time_stats.avg_ns,
            (long long)(port->residence_time_stats.min_ns / 1000),
            (long long)(port->residence_time_stats.max_ns / 1000),
            (long long)(port->residence_time_stats.avg_ns / 1000),
            (unsigned long long)port->rt_histogram.under_100,
            (unsigned long long)port->rt_histogram.under_500,
            (unsigned long long)port->rt_histogram.under_1000,
            (unsigned long long)port->rt_histogram.under_5000,
            (unsigned long long)port->rt_histogram.over_5000);

    /* Jitter (nanosecond precision, also report in us for compat) */
    p += ogs_snprintf(p, end - p,
            "\"jitter\":{"
            "\"current_ns\":%lld,\"peak_ns\":%lld,"
            "\"current_us\":%lld,\"peak_us\":%lld,"
            "\"samples\":%llu},",
            (long long)port->jitter.jitter_ns,
            (long long)port->jitter.peak_jitter_ns,
            (long long)(port->jitter.jitter_ns / 1000),
            (long long)(port->jitter.peak_jitter_ns / 1000),
            (unsigned long long)port->jitter.samples);

    /* PCP stats (only non-zero entries) */
    p += ogs_snprintf(p, end - p, "\"pcp_stats\":[");
    first = true;
    for (i = 0; i < 8; i++) {
        if (port->pcp_stats[i].frames > 0) {
            if (!first)
                p += ogs_snprintf(p, end - p, ",");
            p += ogs_snprintf(p, end - p,
                    "{\"pcp\":%d,\"frames\":%llu,\"bytes\":%llu}",
                    i,
                    (unsigned long long)port->pcp_stats[i].frames,
                    (unsigned long long)port->pcp_stats[i].bytes);
            first = false;
        }
    }
    p += ogs_snprintf(p, end - p, "],");

    /* De-jitter */
    p += ogs_snprintf(p, end - p,
            "\"dejitter\":{"
            "\"enabled\":%s,\"target_delay_us\":%u,"
            "\"enqueued\":%llu,\"dequeued\":%llu,"
            "\"dropped_overflow\":%llu,\"peak_depth\":%d,"
            "\"current_depth\":%d},",
            port->dejitter.enabled ? "true" : "false",
            port->dejitter.target_delay_us,
            (unsigned long long)port->dejitter.enqueued,
            (unsigned long long)port->dejitter.dequeued,
            (unsigned long long)port->dejitter.dropped_overflow,
            port->dejitter.peak_depth,
            port->dejitter.queue_depth);

    /* Stream filters */
    p += ogs_snprintf(p, end - p,
            "\"stream_filters\":{"
            "\"count\":%d,\"miss_count\":%llu,\"entries\":[",
            port->num_filters,
            (unsigned long long)port->filter_miss_count);

    first = true;
    for (i = 0; i < port->num_filters; i++) {
        upf_nwtt_stream_filter_t *f = &port->filters[i];
        if (!f->active)
            continue;
        if (!first)
            p += ogs_snprintf(p, end - p, ",");
        p += ogs_snprintf(p, end - p,
                "{\"dest_mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\","
                "\"vlan_id\":%u,"
                "\"match_count\":%llu,\"match_bytes\":%llu}",
                f->dest_mac[0], f->dest_mac[1], f->dest_mac[2],
                f->dest_mac[3], f->dest_mac[4], f->dest_mac[5],
                f->vlan_present ? (unsigned)f->vlan_id : 0,
                (unsigned long long)f->match_count,
                (unsigned long long)f->match_bytes);
        first = false;
    }
    p += ogs_snprintf(p, end - p, "]}");

    /* LLDP neighbor info (if learned) */
    if (port->lldp_neighbor_valid) {
        upf_nwtt_lldp_info_t *n = &port->lldp_neighbor;
        p += ogs_snprintf(p, end - p,
                ",\"lldp_neighbor\":{\"chassis_id\":\"");
        /* Format chassis ID as hex bytes */
        for (i = 0; i < n->chassis_id_len && i < 32; i++) {
            p += ogs_snprintf(p, end - p, "%s%02x",
                    i > 0 ? ":" : "", n->chassis_id[i]);
        }
        p += ogs_snprintf(p, end - p,
                "\",\"port_id\":\"");
        for (i = 0; i < n->port_id_len && i < 32; i++) {
            p += ogs_snprintf(p, end - p, "%s%02x",
                    i > 0 ? ":" : "", n->port_id[i]);
        }
        p += ogs_snprintf(p, end - p,
                "\",\"ttl\":%u", n->ttl);
        if (n->system_name[0])
            p += ogs_snprintf(p, end - p,
                    ",\"system_name\":\"%s\"", n->system_name);
        if (n->system_desc[0])
            p += ogs_snprintf(p, end - p,
                    ",\"system_desc\":\"%s\"", n->system_desc);
        if (n->port_desc[0])
            p += ogs_snprintf(p, end - p,
                    ",\"port_desc\":\"%s\"", n->port_desc);
        p += ogs_snprintf(p, end - p, "}");
    }

    p += ogs_snprintf(p, end - p, "}");

    return (size_t)(p - start);
}

size_t upf_dump_tsn_info(char *buf, size_t buflen,
        size_t page, size_t page_size)
{
    char *p = buf;
    char *end = buf + buflen;
    upf_nwtt_bridge_t *bridge;
    upf_nwtt_port_t *port = NULL;
    bool first_port;

    (void)page;
    (void)page_size;

    if (!buf || buflen < 3)
        return 0;

    bridge = &upf_self()->nwtt_bridge;

    /* Root object */
    p += ogs_snprintf(p, end - p, "{");

    /* Bridge info */
    p += ogs_snprintf(p, end - p,
            "\"bridge\":{"
            "\"id\":%u,"
            "\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\","
            "\"gptp_enabled\":%s,"
            "\"timestamp_source\":\"%s\","
            "\"timestamp_precision_ns\":true,"
            "\"phc2sys_detected\":%s",
            bridge->bridge_id,
            bridge->bridge_mac[0], bridge->bridge_mac[1],
            bridge->bridge_mac[2], bridge->bridge_mac[3],
            bridge->bridge_mac[4], bridge->bridge_mac[5],
            bridge->gptp.enabled ? "true" : "false",
            upf_nwtt_clock_source_name(bridge->timestamp.clock_source),
            bridge->timestamp.phc2sys_detected ? "true" : "false");
    if (bridge->timestamp.phc_interface[0])
        p += ogs_snprintf(p, end - p,
                ",\"phc_interface\":\"%s\"",
                bridge->timestamp.phc_interface);

    /* gPTP monitoring status */
    if (bridge->gptp.monitoring_enabled) {
        p += ogs_snprintf(p, end - p,
                ",\"gptp_monitoring\":{"
                "\"enabled\":true,"
                "\"synced\":%s,"
                "\"degrade_on_unsync\":%s,"
                "\"corrections_skipped\":%llu,"
                "\"offset_from_master_ns\":%lld,"
                "\"mean_path_delay_ns\":%lld",
                bridge->gptp.synced ? "true" : "false",
                bridge->gptp.degrade_on_unsync ? "true" : "false",
                (unsigned long long)bridge->gptp.corrections_skipped,
                (long long)bridge->gptp.offset_from_master_ns,
                (long long)bridge->gptp.mean_path_delay_ns);
        if (bridge->gptp.gm_identity[0])
            p += ogs_snprintf(p, end - p,
                    ",\"gm_identity\":\"%s\"",
                    bridge->gptp.gm_identity);
        if (bridge->gptp.last_poll_time)
            p += ogs_snprintf(p, end - p,
                    ",\"last_poll_epoch\":%llu",
                    (unsigned long long)(bridge->gptp.last_poll_time /
                        OGS_USEC_PER_SEC));
        p += ogs_snprintf(p, end - p, "}");
    }

    p += ogs_snprintf(p, end - p, "},");

    /* Ports array */
    p += ogs_snprintf(p, end - p, "\"ports\":[");

    first_port = true;
    ogs_list_for_each(&bridge->port_list, port) {
        p += dump_port(p, end, port, first_port);
        first_port = false;
    }

    p += ogs_snprintf(p, end - p, "]}");

    return (size_t)(p - buf);
}
