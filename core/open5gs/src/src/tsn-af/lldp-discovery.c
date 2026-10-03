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

#include "lldp-discovery.h"

#include <sys/socket.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <unistd.h>

static tsn_af_lldp_discovery_t self;

#define LLDP_RECV_BUF_SIZE  2048
#define LLDP_AGING_INTERVAL ogs_time_from_sec(30)

tsn_af_lldp_discovery_t *tsn_af_lldp_discovery_self(void)
{
    return &self;
}

/*
 * Format raw bytes as hex string (e.g., MAC "01:02:03:04:05:06")
 */
static void format_id_string(
        const uint8_t *data, int len, uint8_t subtype, char *out, int out_len)
{
    int i, pos = 0;

    if (len <= 0 || !out || out_len <= 0) {
        if (out && out_len > 0) out[0] = '\0';
        return;
    }

    /* Subtype 4 = MAC address */
    if (subtype == 4 && len == 6) {
        ogs_snprintf(out, out_len,
                "%02x:%02x:%02x:%02x:%02x:%02x",
                data[0], data[1], data[2],
                data[3], data[4], data[5]);
        return;
    }

    /* Subtype 5,6,7 = string-based IDs */
    if (subtype >= 5 && subtype <= 7) {
        int copy_len = len < (out_len - 1) ? len : (out_len - 1);
        memcpy(out, data, copy_len);
        out[copy_len] = '\0';
        return;
    }

    /* Default: hex dump */
    for (i = 0; i < len && pos + 3 < out_len; i++) {
        if (i > 0) out[pos++] = ':';
        pos += ogs_snprintf(out + pos, out_len - pos, "%02x", data[i]);
    }
    out[pos] = '\0';
}

static int parse_lldp_frame(
        const uint8_t *frame, int len,
        tsn_af_lldp_neighbor_t *neighbor)
{
    const uint8_t *p;
    const uint8_t *end;

    ogs_assert(frame);
    ogs_assert(neighbor);

    /* Skip Ethernet header (14 bytes: dst[6] + src[6] + ethertype[2]) */
    if (len < 14 + 2)
        return OGS_ERROR;

    p = frame + 14;
    end = frame + len;

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
                uint16_t id_len = tlv_len - 1;
                neighbor->chassis_id_subtype = p[0];
                if (id_len > sizeof(neighbor->chassis_id))
                    id_len = sizeof(neighbor->chassis_id);
                neighbor->chassis_id_len = (uint8_t)id_len;
                memcpy(neighbor->chassis_id, p + 1, id_len);
            }
            break;
        case LLDP_TLV_PORT_ID:
            if (tlv_len >= 2) {
                uint16_t id_len = tlv_len - 1;
                neighbor->port_id_subtype = p[0];
                if (id_len > sizeof(neighbor->port_id))
                    id_len = sizeof(neighbor->port_id);
                neighbor->port_id_len = (uint8_t)id_len;
                memcpy(neighbor->port_id, p + 1, id_len);
            }
            break;
        case LLDP_TLV_TTL:
            if (tlv_len >= 2)
                neighbor->ttl = ((uint16_t)p[0] << 8) | p[1];
            break;
        case LLDP_TLV_PORT_DESC:
            if (tlv_len > 0 && tlv_len < sizeof(neighbor->port_desc)) {
                memcpy(neighbor->port_desc, p, tlv_len);
                neighbor->port_desc[tlv_len] = '\0';
            }
            break;
        case LLDP_TLV_SYS_NAME:
            if (tlv_len > 0 && tlv_len < sizeof(neighbor->system_name)) {
                memcpy(neighbor->system_name, p, tlv_len);
                neighbor->system_name[tlv_len] = '\0';
            }
            break;
        default:
            break;
        }

        p += tlv_len;
    }

done:
    /* Format ID strings */
    format_id_string(neighbor->chassis_id, neighbor->chassis_id_len,
            neighbor->chassis_id_subtype,
            neighbor->chassis_id_str, sizeof(neighbor->chassis_id_str));
    format_id_string(neighbor->port_id, neighbor->port_id_len,
            neighbor->port_id_subtype,
            neighbor->port_id_str, sizeof(neighbor->port_id_str));

    neighbor->last_seen = ogs_get_monotonic_time();
    neighbor->expired = false;

    return OGS_OK;
}

static tsn_af_lldp_neighbor_t *find_or_create_neighbor(
        const char *chassis_id_str, const char *port_id_str)
{
    tsn_af_lldp_neighbor_t *nbr = NULL;

    /* Search existing */
    ogs_list_for_each(&self.neighbor_list, nbr) {
        if (!strcmp(nbr->chassis_id_str, chassis_id_str) &&
                !strcmp(nbr->port_id_str, port_id_str))
            return nbr;
    }

    /* Create new */
    nbr = ogs_calloc(1, sizeof(*nbr));
    if (!nbr) return NULL;

    ogs_list_add(&self.neighbor_list, nbr);
    self.neighbor_count++;

    return nbr;
}

static void try_match_to_port(tsn_af_lldp_neighbor_t *nbr)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;

    ogs_list_for_each(&tsn_af_self()->bridge_list, bridge) {
        ogs_list_for_each(&bridge->port_list, port) {
            /*
             * Match by existing LLDP chassis/port ID if set,
             * or by MAC address.
             */
            if (port->lldp_chassis_id &&
                    !strcmp(port->lldp_chassis_id, nbr->chassis_id_str)) {
                if (nbr->matched_bridge_id)
                    ogs_free(nbr->matched_bridge_id);
                nbr->matched_bridge_id = ogs_strdup(bridge->bridge_id);
                nbr->matched_port_number = port->port_number;

                /* Update port's LLDP info */
                if (port->lldp_port_id)
                    ogs_free(port->lldp_port_id);
                port->lldp_port_id = ogs_strdup(nbr->port_id_str);

                ogs_info("[TSN-AF] LLDP matched: chassis='%s' -> "
                        "bridge='%s' port=%u",
                        nbr->chassis_id_str, bridge->bridge_id,
                        port->port_number);
                return;
            }

            /* Match by MAC address (chassis_id subtype 4 = MAC) */
            if (nbr->chassis_id_subtype == 4 &&
                    nbr->chassis_id_len == 6 &&
                    memcmp(port->mac_addr, nbr->chassis_id, 6) == 0) {

                if (port->lldp_chassis_id)
                    ogs_free(port->lldp_chassis_id);
                port->lldp_chassis_id = ogs_strdup(nbr->chassis_id_str);

                if (port->lldp_port_id)
                    ogs_free(port->lldp_port_id);
                port->lldp_port_id = ogs_strdup(nbr->port_id_str);

                if (nbr->matched_bridge_id)
                    ogs_free(nbr->matched_bridge_id);
                nbr->matched_bridge_id = ogs_strdup(bridge->bridge_id);
                nbr->matched_port_number = port->port_number;

                ogs_info("[TSN-AF] LLDP MAC matched: %s -> "
                        "bridge='%s' port=%u",
                        nbr->chassis_id_str, bridge->bridge_id,
                        port->port_number);
                return;
            }
        }
    }
}

void tsn_af_lldp_discovery_recv(short when, ogs_socket_t fd, void *data)
{
    uint8_t buf[LLDP_RECV_BUF_SIZE];
    struct sockaddr_ll sll;
    socklen_t sll_len = sizeof(sll);
    ssize_t nread;
    tsn_af_lldp_neighbor_t parsed;
    tsn_af_lldp_neighbor_t *nbr = NULL;

    memset(&sll, 0, sizeof(sll));
    nread = recvfrom(fd, buf, sizeof(buf), 0,
            (struct sockaddr *)&sll, &sll_len);
    if (nread <= 0)
        return;

    self.frames_received++;

    memset(&parsed, 0, sizeof(parsed));

    /* Get interface name */
    if (sll.sll_ifindex > 0) {
        if_indextoname(sll.sll_ifindex, parsed.iface_name);
    }

    if (parse_lldp_frame(buf, (int)nread, &parsed) != OGS_OK)
        return;

    if (parsed.chassis_id_len == 0)
        return;

    self.frames_parsed++;

    /* Find or create neighbor entry */
    nbr = find_or_create_neighbor(
            parsed.chassis_id_str, parsed.port_id_str);
    if (!nbr) return;

    /* Update neighbor data */
    memcpy(nbr->chassis_id, parsed.chassis_id, parsed.chassis_id_len);
    nbr->chassis_id_len = parsed.chassis_id_len;
    nbr->chassis_id_subtype = parsed.chassis_id_subtype;
    memcpy(nbr->port_id, parsed.port_id, parsed.port_id_len);
    nbr->port_id_len = parsed.port_id_len;
    nbr->port_id_subtype = parsed.port_id_subtype;
    nbr->ttl = parsed.ttl;
    ogs_cpystrn(nbr->system_name, parsed.system_name,
            sizeof(nbr->system_name));
    ogs_cpystrn(nbr->port_desc, parsed.port_desc,
            sizeof(nbr->port_desc));
    ogs_cpystrn(nbr->chassis_id_str, parsed.chassis_id_str,
            sizeof(nbr->chassis_id_str));
    ogs_cpystrn(nbr->port_id_str, parsed.port_id_str,
            sizeof(nbr->port_id_str));
    ogs_cpystrn(nbr->iface_name, parsed.iface_name,
            sizeof(nbr->iface_name));
    nbr->last_seen = parsed.last_seen;
    nbr->expired = false;

    /* Try to correlate with bridge ports */
    try_match_to_port(nbr);

    ogs_debug("[TSN-AF] LLDP neighbor: chassis='%s' port='%s' "
            "sys='%s' ttl=%u iface=%s",
            nbr->chassis_id_str, nbr->port_id_str,
            nbr->system_name, nbr->ttl, nbr->iface_name);
}

void tsn_af_lldp_discovery_age_neighbors(void *data)
{
    tsn_af_lldp_neighbor_t *nbr = NULL, *next = NULL;
    ogs_time_t now = ogs_get_monotonic_time();

    ogs_list_for_each_safe(&self.neighbor_list, next, nbr) {
        ogs_time_t age_sec =
            (now - nbr->last_seen) / OGS_USEC_PER_SEC;

        if (nbr->ttl > 0 && age_sec > (ogs_time_t)nbr->ttl) {
            if (!nbr->expired) {
                nbr->expired = true;
                ogs_info("[TSN-AF] LLDP neighbor expired: chassis='%s' "
                        "(age=%lld ttl=%u)",
                        nbr->chassis_id_str,
                        (long long)age_sec, nbr->ttl);
            }
        }
    }

    /* Restart aging timer */
    if (self.aging_timer)
        ogs_timer_start(self.aging_timer, LLDP_AGING_INTERVAL);
}

tsn_af_lldp_neighbor_t *tsn_af_lldp_neighbor_find_by_chassis(
        const char *chassis_id_str)
{
    tsn_af_lldp_neighbor_t *nbr = NULL;

    if (!chassis_id_str) return NULL;

    ogs_list_for_each(&self.neighbor_list, nbr) {
        if (!strcmp(nbr->chassis_id_str, chassis_id_str))
            return nbr;
    }

    return NULL;
}

cJSON *tsn_af_lldp_neighbors_to_json(void)
{
    tsn_af_lldp_neighbor_t *nbr = NULL;
    cJSON *arr = cJSON_CreateArray();
    ogs_assert(arr);

    ogs_list_for_each(&self.neighbor_list, nbr) {
        cJSON *entry = cJSON_CreateObject();
        ogs_time_t age_sec =
            (ogs_get_monotonic_time() - nbr->last_seen) / OGS_USEC_PER_SEC;

        cJSON_AddStringToObject(entry, "chassisId", nbr->chassis_id_str);
        cJSON_AddStringToObject(entry, "portId", nbr->port_id_str);
        cJSON_AddNumberToObject(entry, "ttl", nbr->ttl);
        if (nbr->system_name[0])
            cJSON_AddStringToObject(entry, "systemName", nbr->system_name);
        if (nbr->port_desc[0])
            cJSON_AddStringToObject(entry, "portDesc", nbr->port_desc);
        if (nbr->iface_name[0])
            cJSON_AddStringToObject(entry, "interface", nbr->iface_name);
        cJSON_AddNumberToObject(entry, "ageSec", (double)age_sec);
        cJSON_AddBoolToObject(entry, "expired", nbr->expired);

        if (nbr->matched_bridge_id) {
            cJSON_AddStringToObject(entry, "matchedBridgeId",
                    nbr->matched_bridge_id);
            cJSON_AddNumberToObject(entry, "matchedPortNumber",
                    nbr->matched_port_number);
        }

        cJSON_AddItemToArray(arr, entry);
    }

    return arr;
}

int tsn_af_lldp_discovery_init(void)
{
    int fd;
    struct sockaddr_ll sll;

    memset(&self, 0, sizeof(self));
    ogs_list_init(&self.neighbor_list);

    /* Create raw socket for LLDP (Ethertype 0x88CC) */
    fd = socket(AF_PACKET, SOCK_RAW, htons(LLDP_ETHERTYPE));
    if (fd < 0) {
        ogs_warn("[TSN-AF] Cannot open LLDP raw socket (need CAP_NET_RAW): %s",
                strerror(errno));
        ogs_warn("[TSN-AF] LLDP discovery disabled "
                "(run with sudo or set CAP_NET_RAW)");
        self.enabled = false;
        return OGS_OK;  /* Non-fatal: TSN-AF works without LLDP */
    }

    /* Bind to all interfaces */
    memset(&sll, 0, sizeof(sll));
    sll.sll_family = AF_PACKET;
    sll.sll_protocol = htons(LLDP_ETHERTYPE);
    sll.sll_ifindex = 0;  /* all interfaces */

    if (bind(fd, (struct sockaddr *)&sll, sizeof(sll)) < 0) {
        ogs_warn("[TSN-AF] Cannot bind LLDP socket: %s",
                strerror(errno));
        close(fd);
        self.enabled = false;
        return OGS_OK;
    }

    self.raw_fd = fd;

    /* Register with pollset */
    self.poll = ogs_pollset_add(ogs_app()->pollset,
            OGS_POLLIN, fd,
            tsn_af_lldp_discovery_recv, NULL);
    ogs_assert(self.poll);

    /* Start aging timer */
    self.aging_timer = ogs_timer_add(ogs_app()->timer_mgr,
            tsn_af_lldp_discovery_age_neighbors, NULL);
    ogs_assert(self.aging_timer);
    ogs_timer_start(self.aging_timer, LLDP_AGING_INTERVAL);

    self.enabled = true;

    ogs_info("[TSN-AF] LLDP discovery initialized (fd=%d)", fd);

    return OGS_OK;
}

void tsn_af_lldp_discovery_final(void)
{
    tsn_af_lldp_neighbor_t *nbr = NULL, *next = NULL;

    if (self.aging_timer) {
        ogs_timer_delete(self.aging_timer);
        self.aging_timer = NULL;
    }

    if (self.poll) {
        ogs_pollset_remove(self.poll);
        self.poll = NULL;
    }

    if (self.raw_fd > 0) {
        close(self.raw_fd);
        self.raw_fd = 0;
    }

    /* Free all neighbors */
    ogs_list_for_each_safe(&self.neighbor_list, next, nbr) {
        ogs_list_remove(&self.neighbor_list, nbr);
        if (nbr->matched_bridge_id)
            ogs_free(nbr->matched_bridge_id);
        ogs_free(nbr);
    }

    self.enabled = false;

    ogs_info("[TSN-AF] LLDP discovery finalized "
            "(rx=%u parsed=%u)",
            self.frames_received, self.frames_parsed);
}
