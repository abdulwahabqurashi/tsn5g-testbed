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

#include "sbi-path.h"
#include "cnc-handler.h"
#include "npcf-handler.h"
#include "npcf-build.h"
#include "qos-select.h"
#include "tsctsf-stub.h"
#include "nsmf-handler.h"
#include "ts24519.h"
#include "bridge-mgmt.h"
#include "bridge-health.h"
#include "bridge-persist.h"
#include "lldp-discovery.h"

static void send_json_response(
        ogs_sbi_stream_t *stream, int status, char *json_str);

/* Existing handlers */
static void cnc_handle_bridges_list(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg);
static void cnc_handle_bridge_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id);
static void cnc_handle_port_configure(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id);
static void cnc_handle_bridge_configure(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id);

/* New CRUD handlers */
static void cnc_handle_bridge_create(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg);
static void cnc_handle_bridge_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id);
static void cnc_handle_bridge_update(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id);
static void cnc_handle_port_create(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id);
static void cnc_handle_port_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str);
static void cnc_handle_port_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str);

/* Analytics handler */
static void cnc_handle_analytics(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg);

/* Interfaces handler */
static void cnc_handle_interfaces_list(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg);

/* Phase C/F/G handlers */
static void cnc_handle_qos_mapping(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id);
static void cnc_handle_tsc_assistance(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id);
static void cnc_handle_stream_reservations(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id);
static void cnc_handle_stream_reservations_list(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id);
static void cnc_handle_stream_reservation_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *stream_id_str);
static void cnc_handle_stream_reservation_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *stream_id_str);
static void cnc_handle_port_gcl(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str);
static void cnc_handle_port_psfp(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str);
static void cnc_handle_port_psfp_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str);
static void cnc_handle_port_psfp_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str);

/* Bridge group handlers */
static void cnc_handle_bridge_group_create(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg);
static void cnc_handle_bridge_groups_list(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg);
static void cnc_handle_bridge_group_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *group_id);
static void cnc_handle_bridge_group_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *group_id);
static void cnc_handle_bridge_group_add_member(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg, const char *group_id);
static void cnc_handle_bridge_group_remove_member(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *group_id, const char *bridge_id);
static void cnc_handle_bridge_group_failover(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *group_id);

/* Helper to parse MAC address string "aa:bb:cc:dd:ee:ff" */
static bool parse_mac_addr(const char *mac_str, uint8_t mac[6])
{
    unsigned int m[6];
    int i;

    if (!mac_str)
        return false;

    if (sscanf(mac_str, "%02x:%02x:%02x:%02x:%02x:%02x",
                &m[0], &m[1], &m[2], &m[3], &m[4], &m[5]) != 6)
        return false;

    for (i = 0; i < 6; i++)
        mac[i] = (uint8_t)m[i];

    return true;
}

void tsn_af_cnc_handle_request(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg)
{
    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(recvmsg);

    /*
     * Route: /tsn-af/v1/bridges[/{id}[/ports[/{portId}[/configure]]]]
     *                             [/configure]
     *
     * component[0] = "bridges"
     * component[1] = bridge_id (optional)
     * component[2] = "ports" or "configure" (optional)
     * component[3] = port_id (optional)
     * component[4] = "configure" (optional)
     */
    SWITCH(recvmsg->h.resource.component[0])
    CASE("bridges")
        if (!recvmsg->h.resource.component[1]) {
            /* /tsn-af/v1/bridges */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_GET)
                cnc_handle_bridges_list(stream, recvmsg);
                break;
            CASE(OGS_SBI_HTTP_METHOD_POST)
                cnc_handle_bridge_create(stream, request, recvmsg);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else if (!recvmsg->h.resource.component[2]) {
            /* /tsn-af/v1/bridges/{id} */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_GET)
                cnc_handle_bridge_get(stream, recvmsg,
                        recvmsg->h.resource.component[1]);
                break;
            CASE(OGS_SBI_HTTP_METHOD_DELETE)
                cnc_handle_bridge_delete(stream, recvmsg,
                        recvmsg->h.resource.component[1]);
                break;
            CASE(OGS_SBI_HTTP_METHOD_PUT)
                cnc_handle_bridge_update(stream, request, recvmsg,
                        recvmsg->h.resource.component[1]);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else if (!strcmp(recvmsg->h.resource.component[2], "ports")) {
            if (!recvmsg->h.resource.component[3]) {
                /* /tsn-af/v1/bridges/{id}/ports */
                SWITCH(recvmsg->h.method)
                CASE(OGS_SBI_HTTP_METHOD_POST)
                    cnc_handle_port_create(stream, request, recvmsg,
                            recvmsg->h.resource.component[1]);
                    break;
                DEFAULT
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                            recvmsg, "Method not allowed",
                            recvmsg->h.method, NULL));
                END
            } else if (!recvmsg->h.resource.component[4]) {
                /* /tsn-af/v1/bridges/{id}/ports/{portId} */
                SWITCH(recvmsg->h.method)
                CASE(OGS_SBI_HTTP_METHOD_GET)
                    cnc_handle_port_get(stream, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                CASE(OGS_SBI_HTTP_METHOD_DELETE)
                    cnc_handle_port_delete(stream, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                DEFAULT
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                            recvmsg, "Method not allowed",
                            recvmsg->h.method, NULL));
                END
            } else if (!strcmp(recvmsg->h.resource.component[4],
                        "configure")) {
                /* /tsn-af/v1/bridges/{id}/ports/{portId}/configure */
                SWITCH(recvmsg->h.method)
                CASE(OGS_SBI_HTTP_METHOD_POST)
                    cnc_handle_port_configure(stream, request, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                DEFAULT
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                            recvmsg, "Method not allowed",
                            recvmsg->h.method, NULL));
                END
            } else if (!strcmp(recvmsg->h.resource.component[4],
                        "gcl")) {
                /* /tsn-af/v1/bridges/{id}/ports/{portId}/gcl */
                SWITCH(recvmsg->h.method)
                CASE(OGS_SBI_HTTP_METHOD_POST)
                    cnc_handle_port_gcl(stream, request, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                DEFAULT
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                            recvmsg, "Method not allowed",
                            recvmsg->h.method, NULL));
                END
            } else if (!strcmp(recvmsg->h.resource.component[4],
                        "psfp")) {
                /* /tsn-af/v1/bridges/{id}/ports/{portId}/psfp */
                SWITCH(recvmsg->h.method)
                CASE(OGS_SBI_HTTP_METHOD_POST)
                    cnc_handle_port_psfp(stream, request, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                CASE(OGS_SBI_HTTP_METHOD_GET)
                    cnc_handle_port_psfp_get(stream, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                CASE(OGS_SBI_HTTP_METHOD_DELETE)
                    cnc_handle_port_psfp_delete(stream, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                DEFAULT
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                            recvmsg, "Method not allowed",
                            recvmsg->h.method, NULL));
                END
            } else {
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_NOT_FOUND,
                        recvmsg, "Resource not found", NULL, NULL));
            }
        } else if (!strcmp(recvmsg->h.resource.component[2], "configure")) {
            /* /tsn-af/v1/bridges/{id}/configure */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_POST)
                cnc_handle_bridge_configure(stream, request, recvmsg,
                        recvmsg->h.resource.component[1]);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else if (!strcmp(recvmsg->h.resource.component[2],
                    "qos-mapping")) {
            /* /tsn-af/v1/bridges/{id}/qos-mapping */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_POST)
                cnc_handle_qos_mapping(stream, request, recvmsg,
                        recvmsg->h.resource.component[1]);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else if (!strcmp(recvmsg->h.resource.component[2],
                    "tsc-assistance")) {
            /* /tsn-af/v1/bridges/{id}/tsc-assistance */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_POST)
                cnc_handle_tsc_assistance(stream, request, recvmsg,
                        recvmsg->h.resource.component[1]);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else if (!strcmp(recvmsg->h.resource.component[2],
                    "stream-reservations")) {
            if (!recvmsg->h.resource.component[3]) {
                /* /tsn-af/v1/bridges/{id}/stream-reservations */
                SWITCH(recvmsg->h.method)
                CASE(OGS_SBI_HTTP_METHOD_POST)
                    cnc_handle_stream_reservations(stream, request, recvmsg,
                            recvmsg->h.resource.component[1]);
                    break;
                CASE(OGS_SBI_HTTP_METHOD_GET)
                    cnc_handle_stream_reservations_list(stream, recvmsg,
                            recvmsg->h.resource.component[1]);
                    break;
                DEFAULT
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                            recvmsg, "Method not allowed",
                            recvmsg->h.method, NULL));
                END
            } else {
                /* /tsn-af/v1/bridges/{id}/stream-reservations/{streamId} */
                SWITCH(recvmsg->h.method)
                CASE(OGS_SBI_HTTP_METHOD_GET)
                    cnc_handle_stream_reservation_get(stream, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                CASE(OGS_SBI_HTTP_METHOD_DELETE)
                    cnc_handle_stream_reservation_delete(stream, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                DEFAULT
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                            recvmsg, "Method not allowed",
                            recvmsg->h.method, NULL));
                END
            }
        } else if (!strcmp(recvmsg->h.resource.component[2],
                    "lldp-neighbors")) {
            /* /tsn-af/v1/bridges/{id}/lldp-neighbors */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_GET)
            {
                tsn_af_bridge_t *br = tsn_af_bridge_find_by_id(
                        recvmsg->h.resource.component[1]);
                if (!br) {
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_NOT_FOUND,
                            recvmsg, "Bridge not found",
                            recvmsg->h.resource.component[1], NULL));
                } else {
                    tsn_af_lldp_neighbor_t *nbr = NULL;
                    cJSON *arr = cJSON_CreateArray();
                    char *json_str;

                    ogs_list_for_each(
                            &tsn_af_lldp_discovery_self()->neighbor_list,
                            nbr) {
                        if (nbr->matched_bridge_id &&
                                !strcmp(nbr->matched_bridge_id,
                                    br->bridge_id)) {
                            cJSON *entry = cJSON_CreateObject();
                            cJSON_AddStringToObject(entry, "chassisId",
                                    nbr->chassis_id_str);
                            cJSON_AddStringToObject(entry, "portId",
                                    nbr->port_id_str);
                            cJSON_AddNumberToObject(entry, "ttl", nbr->ttl);
                            if (nbr->system_name[0])
                                cJSON_AddStringToObject(entry, "systemName",
                                        nbr->system_name);
                            cJSON_AddNumberToObject(entry,
                                    "matchedPortNumber",
                                    nbr->matched_port_number);
                            cJSON_AddBoolToObject(entry, "expired",
                                    nbr->expired);
                            cJSON_AddItemToArray(arr, entry);
                        }
                    }

                    json_str = cJSON_PrintUnformatted(arr);
                    ogs_assert(json_str);
                    send_json_response(stream,
                            OGS_SBI_HTTP_STATUS_OK, json_str);
                    cJSON_free(json_str);
                    cJSON_Delete(arr);
                }
            }
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else {
            ogs_assert(true ==
                ogs_sbi_server_send_error(stream,
                    OGS_SBI_HTTP_STATUS_NOT_FOUND,
                    recvmsg, "Resource not found", NULL, NULL));
        }
        break;

    CASE("pcf-notify")
        SWITCH(recvmsg->h.method)
        CASE(OGS_SBI_HTTP_METHOD_POST)
            tsn_af_npcf_handle_policy_notify(stream, request);
            break;
        DEFAULT
            ogs_assert(true ==
                ogs_sbi_server_send_error(stream,
                    OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                    recvmsg, "Method not allowed",
                    recvmsg->h.method, NULL));
        END
        break;

    CASE("analytics")
        SWITCH(recvmsg->h.method)
        CASE(OGS_SBI_HTTP_METHOD_GET)
            cnc_handle_analytics(stream, recvmsg);
            break;
        DEFAULT
            ogs_assert(true ==
                ogs_sbi_server_send_error(stream,
                    OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                    recvmsg, "Method not allowed",
                    recvmsg->h.method, NULL));
        END
        break;

    CASE("interfaces")
        SWITCH(recvmsg->h.method)
        CASE(OGS_SBI_HTTP_METHOD_GET)
            cnc_handle_interfaces_list(stream, recvmsg);
            break;
        DEFAULT
            ogs_assert(true ==
                ogs_sbi_server_send_error(stream,
                    OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                    recvmsg, "Method not allowed",
                    recvmsg->h.method, NULL));
        END
        break;

    CASE("bridge-groups")
        if (!recvmsg->h.resource.component[1]) {
            /* /tsn-af/v1/bridge-groups */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_POST)
                cnc_handle_bridge_group_create(stream, request, recvmsg);
                break;
            CASE(OGS_SBI_HTTP_METHOD_GET)
                cnc_handle_bridge_groups_list(stream, recvmsg);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else if (!recvmsg->h.resource.component[2]) {
            /* /tsn-af/v1/bridge-groups/{id} */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_GET)
                cnc_handle_bridge_group_get(stream, recvmsg,
                        recvmsg->h.resource.component[1]);
                break;
            CASE(OGS_SBI_HTTP_METHOD_DELETE)
                cnc_handle_bridge_group_delete(stream, recvmsg,
                        recvmsg->h.resource.component[1]);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else if (!strcmp(recvmsg->h.resource.component[2], "members")) {
            if (!recvmsg->h.resource.component[3]) {
                /* /tsn-af/v1/bridge-groups/{id}/members */
                SWITCH(recvmsg->h.method)
                CASE(OGS_SBI_HTTP_METHOD_POST)
                    cnc_handle_bridge_group_add_member(stream, request,
                            recvmsg, recvmsg->h.resource.component[1]);
                    break;
                DEFAULT
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                            recvmsg, "Method not allowed",
                            recvmsg->h.method, NULL));
                END
            } else {
                /* /tsn-af/v1/bridge-groups/{id}/members/{bridgeId} */
                SWITCH(recvmsg->h.method)
                CASE(OGS_SBI_HTTP_METHOD_DELETE)
                    cnc_handle_bridge_group_remove_member(stream, recvmsg,
                            recvmsg->h.resource.component[1],
                            recvmsg->h.resource.component[3]);
                    break;
                DEFAULT
                    ogs_assert(true ==
                        ogs_sbi_server_send_error(stream,
                            OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                            recvmsg, "Method not allowed",
                            recvmsg->h.method, NULL));
                END
            }
        } else if (!strcmp(recvmsg->h.resource.component[2], "failover")) {
            /* /tsn-af/v1/bridge-groups/{id}/failover */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_POST)
                cnc_handle_bridge_group_failover(stream, recvmsg,
                        recvmsg->h.resource.component[1]);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else {
            ogs_assert(true ==
                ogs_sbi_server_send_error(stream,
                    OGS_SBI_HTTP_STATUS_NOT_FOUND,
                    recvmsg, "Resource not found", NULL, NULL));
        }
        break;

    CASE("lldp-neighbors")
        SWITCH(recvmsg->h.method)
        CASE(OGS_SBI_HTTP_METHOD_GET)
        {
            cJSON *arr = tsn_af_lldp_neighbors_to_json();
            char *json_str = cJSON_PrintUnformatted(arr);
            ogs_assert(json_str);
            send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);
            cJSON_free(json_str);
            cJSON_Delete(arr);
        }
            break;
        DEFAULT
            ogs_assert(true ==
                ogs_sbi_server_send_error(stream,
                    OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                    recvmsg, "Method not allowed",
                    recvmsg->h.method, NULL));
        END
        break;

    DEFAULT
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Unknown resource",
                recvmsg->h.resource.component[0], NULL));
    END
}

static void send_json_response(
        ogs_sbi_stream_t *stream, int status, char *json_str)
{
    ogs_sbi_response_t *response = NULL;

    ogs_assert(stream);

    response = ogs_sbi_response_new();
    ogs_assert(response);

    response->status = status;

    if (json_str) {
        response->http.content = ogs_strdup(json_str);
        ogs_assert(response->http.content);
        response->http.content_length = strlen(json_str);
        ogs_sbi_header_set(response->http.headers,
                OGS_SBI_CONTENT_TYPE, OGS_SBI_CONTENT_JSON_TYPE);
    }

    ogs_assert(true == ogs_sbi_server_send_response(stream, response));
}

static void cnc_handle_bridges_list(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg)
{
    tsn_af_bridge_t *bridge = NULL;
    cJSON *json_array = NULL;
    char *json_str = NULL;

    ogs_assert(stream);

    json_array = cJSON_CreateArray();
    ogs_assert(json_array);

    ogs_list_for_each(&tsn_af_self()->bridge_list, bridge) {
        cJSON *bridge_json;
        char mac_str[18];
        int port_count = 0;
        tsn_af_port_t *port = NULL;

        bridge_json = cJSON_CreateObject();
        ogs_assert(bridge_json);

        if (bridge->bridge_id)
            cJSON_AddStringToObject(bridge_json, "bridgeId",
                    bridge->bridge_id);

        /* Add bridge MAC as hex string */
        ogs_snprintf(mac_str, sizeof(mac_str),
                "%02x:%02x:%02x:%02x:%02x:%02x",
                bridge->bridge_mac[0], bridge->bridge_mac[1],
                bridge->bridge_mac[2], bridge->bridge_mac[3],
                bridge->bridge_mac[4], bridge->bridge_mac[5]);
        cJSON_AddStringToObject(bridge_json, "bridgeMac", mac_str);

        if (bridge->dnn)
            cJSON_AddStringToObject(bridge_json, "dnn", bridge->dnn);

        /* Count ports */
        ogs_list_for_each(&bridge->port_list, port) {
            port_count++;
        }
        cJSON_AddNumberToObject(bridge_json, "portCount", port_count);

        if (bridge->linux_bridge_active) {
            cJSON_AddStringToObject(bridge_json, "linuxBridge",
                    bridge->linux_bridge_name);
            cJSON_AddStringToObject(bridge_json, "tapInterface",
                    bridge->tap_name);
            cJSON_AddStringToObject(bridge_json, "bridgeStatus", "active");
        } else {
            cJSON_AddStringToObject(bridge_json, "bridgeStatus", "inactive");
        }
        if (bridge->physical_iface)
            cJSON_AddStringToObject(bridge_json, "physicalInterface",
                    bridge->physical_iface);
        if (bridge->upf_tap_name)
            cJSON_AddStringToObject(bridge_json, "upfTapDevice",
                    bridge->upf_tap_name);

        cJSON_AddItemToArray(json_array, bridge_json);
    }

    json_str = cJSON_PrintUnformatted(json_array);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(json_array);
}

static void cnc_handle_bridge_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;
    cJSON *bridge_json = NULL;
    cJSON *ports_array = NULL;
    char *json_str = NULL;
    char mac_str[18];

    ogs_assert(stream);
    ogs_assert(bridge_id);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    bridge_json = cJSON_CreateObject();
    ogs_assert(bridge_json);

    cJSON_AddStringToObject(bridge_json, "bridgeId", bridge->bridge_id);

    ogs_snprintf(mac_str, sizeof(mac_str),
            "%02x:%02x:%02x:%02x:%02x:%02x",
            bridge->bridge_mac[0], bridge->bridge_mac[1],
            bridge->bridge_mac[2], bridge->bridge_mac[3],
            bridge->bridge_mac[4], bridge->bridge_mac[5]);
    cJSON_AddStringToObject(bridge_json, "bridgeMac", mac_str);

    if (bridge->dnn)
        cJSON_AddStringToObject(bridge_json, "dnn", bridge->dnn);

    /* Add ports array */
    ports_array = cJSON_CreateArray();
    ogs_assert(ports_array);

    ogs_list_for_each(&bridge->port_list, port) {
        cJSON *port_json;
        char port_mac_str[18];

        port_json = cJSON_CreateObject();
        ogs_assert(port_json);

        cJSON_AddNumberToObject(port_json, "portNumber", port->port_number);
        cJSON_AddBoolToObject(port_json, "isNwtt", port->is_nwtt);

        ogs_snprintf(port_mac_str, sizeof(port_mac_str),
                "%02x:%02x:%02x:%02x:%02x:%02x",
                port->mac_addr[0], port->mac_addr[1],
                port->mac_addr[2], port->mac_addr[3],
                port->mac_addr[4], port->mac_addr[5]);
        cJSON_AddStringToObject(port_json, "macAddr", port_mac_str);

        if (port->lldp_chassis_id)
            cJSON_AddStringToObject(port_json, "lldpChassisId",
                    port->lldp_chassis_id);
        if (port->lldp_port_id)
            cJSON_AddStringToObject(port_json, "lldpPortId",
                    port->lldp_port_id);

        cJSON_AddItemToArray(ports_array, port_json);
    }
    cJSON_AddItemToObject(bridge_json, "ports", ports_array);

    if (bridge->linux_bridge_active) {
        cJSON_AddStringToObject(bridge_json, "linuxBridge",
                bridge->linux_bridge_name);
        cJSON_AddStringToObject(bridge_json, "tapInterface",
                bridge->tap_name);
        cJSON_AddStringToObject(bridge_json, "bridgeStatus", "active");
    } else {
        cJSON_AddStringToObject(bridge_json, "bridgeStatus", "inactive");
    }
    if (bridge->physical_iface)
        cJSON_AddStringToObject(bridge_json, "physicalInterface",
                bridge->physical_iface);
    if (bridge->upf_tap_name)
        cJSON_AddStringToObject(bridge_json, "upfTapDevice",
                bridge->upf_tap_name);

    json_str = cJSON_PrintUnformatted(bridge_json);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(bridge_json);
}

static void cnc_handle_bridge_create(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg)
{
    tsn_af_bridge_t *bridge = NULL;
    cJSON *body = NULL;
    cJSON *bridge_id_item = NULL;
    cJSON *bridge_mac_item = NULL;
    cJSON *dnn_item = NULL;
    cJSON *result_json = NULL;
    char *json_str = NULL;
    char mac_str[18];

    ogs_assert(stream);
    ogs_assert(request);

    if (!request->http.content || request->http.content_length == 0) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty request body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    bridge_id_item = cJSON_GetObjectItem(body, "bridgeId");
    if (!bridge_id_item || !cJSON_IsString(bridge_id_item)) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "bridgeId is required", NULL, NULL));
        return;
    }

    /* Check for duplicate */
    if (tsn_af_bridge_find_by_id(bridge_id_item->valuestring)) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_CONFLICT,
                recvmsg, "Bridge already exists",
                bridge_id_item->valuestring, NULL));
        return;
    }

    bridge = tsn_af_bridge_add(bridge_id_item->valuestring);
    if (!bridge) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_INTERNAL_SERVER_ERROR,
                recvmsg, "Failed to create bridge", NULL, NULL));
        return;
    }

    /* Parse optional bridgeMac */
    bridge_mac_item = cJSON_GetObjectItem(body, "bridgeMac");
    if (bridge_mac_item && cJSON_IsString(bridge_mac_item)) {
        parse_mac_addr(bridge_mac_item->valuestring, bridge->bridge_mac);
    }

    /* Parse optional dnn */
    dnn_item = cJSON_GetObjectItem(body, "dnn");
    if (dnn_item && cJSON_IsString(dnn_item)) {
        bridge->dnn = ogs_strdup(dnn_item->valuestring);
    }

    /* Create Linux bridge + TAP */
    if (tsn_af_linux_bridge_create(bridge) != OGS_OK) {
        ogs_warn("[TSN-AF] Linux bridge creation failed "
                "(need CAP_NET_ADMIN?)");
    } else {
        cJSON *phys_item = NULL;

        tsn_af_linux_tap_create(bridge);

        /* Attach physical interface if specified */
        phys_item = cJSON_GetObjectItem(body, "physicalInterface");
        if (phys_item && cJSON_IsString(phys_item) &&
                strlen(phys_item->valuestring) > 0) {
            bridge->physical_iface =
                ogs_strdup(phys_item->valuestring);
            if (tsn_af_linux_bridge_attach_iface(
                    bridge->linux_bridge_name,
                    phys_item->valuestring) != OGS_OK) {
                ogs_warn("[TSN-AF] Failed to attach %s to bridge",
                        phys_item->valuestring);
            }
        }

        /* Attach UPF TAP device if specified (e.g., "ogstap") */
        {
            cJSON *upf_tap_item =
                cJSON_GetObjectItem(body, "upfTapDevice");
            if (upf_tap_item && cJSON_IsString(upf_tap_item) &&
                    strlen(upf_tap_item->valuestring) > 0) {
                bridge->upf_tap_name =
                    ogs_strdup(upf_tap_item->valuestring);
                tsn_af_linux_set_iface_up(
                        upf_tap_item->valuestring);
                if (tsn_af_linux_bridge_attach_iface(
                        bridge->linux_bridge_name,
                        upf_tap_item->valuestring) != OGS_OK) {
                    ogs_warn("[TSN-AF] Failed to attach UPF TAP "
                            "'%s' to bridge",
                            upf_tap_item->valuestring);
                } else {
                    ogs_info("[TSN-AF] UPF TAP '%s' attached "
                            "to bridge '%s'",
                            upf_tap_item->valuestring,
                            bridge->linux_bridge_name);
                }
            }
        }
    }

    cJSON_Delete(body);

    tsn_af_bridge_persist_save();

    /* Build response */
    result_json = cJSON_CreateObject();
    ogs_assert(result_json);

    cJSON_AddStringToObject(result_json, "bridgeId", bridge->bridge_id);

    ogs_snprintf(mac_str, sizeof(mac_str),
            "%02x:%02x:%02x:%02x:%02x:%02x",
            bridge->bridge_mac[0], bridge->bridge_mac[1],
            bridge->bridge_mac[2], bridge->bridge_mac[3],
            bridge->bridge_mac[4], bridge->bridge_mac[5]);
    cJSON_AddStringToObject(result_json, "bridgeMac", mac_str);

    if (bridge->dnn)
        cJSON_AddStringToObject(result_json, "dnn", bridge->dnn);

    cJSON_AddNumberToObject(result_json, "portCount", 0);

    if (bridge->linux_bridge_active) {
        cJSON_AddStringToObject(result_json, "linuxBridge",
                bridge->linux_bridge_name);
        cJSON_AddStringToObject(result_json, "tapInterface",
                bridge->tap_name);
        cJSON_AddStringToObject(result_json, "bridgeStatus", "active");
    } else {
        cJSON_AddStringToObject(result_json, "bridgeStatus", "inactive");
    }
    if (bridge->physical_iface)
        cJSON_AddStringToObject(result_json, "physicalInterface",
                bridge->physical_iface);
    if (bridge->upf_tap_name)
        cJSON_AddStringToObject(result_json, "upfTapDevice",
                bridge->upf_tap_name);

    json_str = cJSON_PrintUnformatted(result_json);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_CREATED, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result_json);
}

static void cnc_handle_bridge_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;

    ogs_assert(stream);
    ogs_assert(bridge_id);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    ogs_info("[TSN-AF] Bridge '%s' deleted", bridge_id);
    tsn_af_bridge_remove(bridge);

    tsn_af_bridge_persist_save();

    send_json_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT, NULL);
}

static void cnc_handle_bridge_update(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;
    cJSON *body = NULL;
    cJSON *dnn_item = NULL;
    cJSON *bridge_mac_item = NULL;
    cJSON *result_json = NULL;
    cJSON *ports_array = NULL;
    tsn_af_port_t *port = NULL;
    char *json_str = NULL;
    char mac_str[18];

    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(bridge_id);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    if (!request->http.content || request->http.content_length == 0) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty request body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    /* Update dnn if provided */
    dnn_item = cJSON_GetObjectItem(body, "dnn");
    if (dnn_item && cJSON_IsString(dnn_item)) {
        if (bridge->dnn)
            ogs_free(bridge->dnn);
        bridge->dnn = ogs_strdup(dnn_item->valuestring);
    }

    /* Update bridgeMac if provided */
    bridge_mac_item = cJSON_GetObjectItem(body, "bridgeMac");
    if (bridge_mac_item && cJSON_IsString(bridge_mac_item)) {
        parse_mac_addr(bridge_mac_item->valuestring, bridge->bridge_mac);
    }

    /* Update UPF TAP device if provided */
    {
        cJSON *upf_tap_item = cJSON_GetObjectItem(body, "upfTapDevice");
        if (upf_tap_item && cJSON_IsString(upf_tap_item) &&
                strlen(upf_tap_item->valuestring) > 0) {
            /* Detach old UPF TAP if different */
            if (bridge->upf_tap_name &&
                    strcmp(bridge->upf_tap_name,
                           upf_tap_item->valuestring) != 0) {
                if (bridge->linux_bridge_active) {
                    tsn_af_linux_bridge_detach_iface(
                            bridge->linux_bridge_name,
                            bridge->upf_tap_name);
                }
                ogs_free(bridge->upf_tap_name);
                bridge->upf_tap_name = NULL;
            }
            if (!bridge->upf_tap_name) {
                bridge->upf_tap_name =
                    ogs_strdup(upf_tap_item->valuestring);
                if (bridge->linux_bridge_active) {
                    tsn_af_linux_set_iface_up(
                            upf_tap_item->valuestring);
                    tsn_af_linux_bridge_attach_iface(
                            bridge->linux_bridge_name,
                            upf_tap_item->valuestring);
                }
            }
        }
    }

    cJSON_Delete(body);

    ogs_info("[TSN-AF] Bridge '%s' updated", bridge_id);

    tsn_af_bridge_persist_save();

    /* Build response (same as bridge_get) */
    result_json = cJSON_CreateObject();
    ogs_assert(result_json);

    cJSON_AddStringToObject(result_json, "bridgeId", bridge->bridge_id);

    ogs_snprintf(mac_str, sizeof(mac_str),
            "%02x:%02x:%02x:%02x:%02x:%02x",
            bridge->bridge_mac[0], bridge->bridge_mac[1],
            bridge->bridge_mac[2], bridge->bridge_mac[3],
            bridge->bridge_mac[4], bridge->bridge_mac[5]);
    cJSON_AddStringToObject(result_json, "bridgeMac", mac_str);

    if (bridge->dnn)
        cJSON_AddStringToObject(result_json, "dnn", bridge->dnn);

    ports_array = cJSON_CreateArray();
    ogs_assert(ports_array);

    ogs_list_for_each(&bridge->port_list, port) {
        cJSON *port_json;
        char port_mac_str[18];

        port_json = cJSON_CreateObject();
        ogs_assert(port_json);

        cJSON_AddNumberToObject(port_json, "portNumber", port->port_number);
        cJSON_AddBoolToObject(port_json, "isNwtt", port->is_nwtt);

        ogs_snprintf(port_mac_str, sizeof(port_mac_str),
                "%02x:%02x:%02x:%02x:%02x:%02x",
                port->mac_addr[0], port->mac_addr[1],
                port->mac_addr[2], port->mac_addr[3],
                port->mac_addr[4], port->mac_addr[5]);
        cJSON_AddStringToObject(port_json, "macAddr", port_mac_str);

        if (port->lldp_chassis_id)
            cJSON_AddStringToObject(port_json, "lldpChassisId",
                    port->lldp_chassis_id);
        if (port->lldp_port_id)
            cJSON_AddStringToObject(port_json, "lldpPortId",
                    port->lldp_port_id);

        cJSON_AddItemToArray(ports_array, port_json);
    }
    cJSON_AddItemToObject(result_json, "ports", ports_array);

    if (bridge->linux_bridge_active) {
        cJSON_AddStringToObject(result_json, "linuxBridge",
                bridge->linux_bridge_name);
        cJSON_AddStringToObject(result_json, "tapInterface",
                bridge->tap_name);
        cJSON_AddStringToObject(result_json, "bridgeStatus", "active");
    } else {
        cJSON_AddStringToObject(result_json, "bridgeStatus", "inactive");
    }
    if (bridge->physical_iface)
        cJSON_AddStringToObject(result_json, "physicalInterface",
                bridge->physical_iface);
    if (bridge->upf_tap_name)
        cJSON_AddStringToObject(result_json, "upfTapDevice",
                bridge->upf_tap_name);

    json_str = cJSON_PrintUnformatted(result_json);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result_json);
}

static void cnc_handle_port_create(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;
    cJSON *body = NULL;
    cJSON *port_num_item = NULL;
    cJSON *is_nwtt_item = NULL;
    cJSON *mac_item = NULL;
    cJSON *result_json = NULL;
    char *json_str = NULL;
    char mac_str[18];

    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(bridge_id);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    if (!request->http.content || request->http.content_length == 0) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty request body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    port_num_item = cJSON_GetObjectItem(body, "portNumber");
    if (!port_num_item || !cJSON_IsNumber(port_num_item)) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "portNumber is required", NULL, NULL));
        return;
    }

    /* Check for duplicate port number */
    if (tsn_af_port_find_by_number(bridge,
                (uint32_t)port_num_item->valuedouble)) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_CONFLICT,
                recvmsg, "Port already exists", NULL, NULL));
        return;
    }

    port = tsn_af_port_add(bridge);
    if (!port) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_INTERNAL_SERVER_ERROR,
                recvmsg, "Failed to create port", NULL, NULL));
        return;
    }

    port->port_number = (uint32_t)port_num_item->valuedouble;

    is_nwtt_item = cJSON_GetObjectItem(body, "isNwtt");
    if (is_nwtt_item && cJSON_IsBool(is_nwtt_item)) {
        port->is_nwtt = cJSON_IsTrue(is_nwtt_item);
    }

    mac_item = cJSON_GetObjectItem(body, "macAddr");
    if (mac_item && cJSON_IsString(mac_item)) {
        parse_mac_addr(mac_item->valuestring, port->mac_addr);
    }

    cJSON_Delete(body);

    ogs_info("[TSN-AF] Port %u created on bridge '%s'",
            port->port_number, bridge->bridge_id);

    /* Build response */
    result_json = cJSON_CreateObject();
    ogs_assert(result_json);

    cJSON_AddNumberToObject(result_json, "portNumber", port->port_number);
    cJSON_AddBoolToObject(result_json, "isNwtt", port->is_nwtt);

    ogs_snprintf(mac_str, sizeof(mac_str),
            "%02x:%02x:%02x:%02x:%02x:%02x",
            port->mac_addr[0], port->mac_addr[1],
            port->mac_addr[2], port->mac_addr[3],
            port->mac_addr[4], port->mac_addr[5]);
    cJSON_AddStringToObject(result_json, "macAddr", mac_str);

    json_str = cJSON_PrintUnformatted(result_json);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_CREATED, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result_json);
}

static void cnc_handle_port_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;
    uint32_t port_number;
    cJSON *port_json = NULL;
    char *json_str = NULL;
    char mac_str[18];

    ogs_assert(stream);
    ogs_assert(bridge_id);
    ogs_assert(port_id_str);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    port_number = atoi(port_id_str);
    port = tsn_af_port_find_by_number(bridge, port_number);
    if (!port) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Port not found", port_id_str, NULL));
        return;
    }

    port_json = cJSON_CreateObject();
    ogs_assert(port_json);

    cJSON_AddNumberToObject(port_json, "portNumber", port->port_number);
    cJSON_AddBoolToObject(port_json, "isNwtt", port->is_nwtt);

    ogs_snprintf(mac_str, sizeof(mac_str),
            "%02x:%02x:%02x:%02x:%02x:%02x",
            port->mac_addr[0], port->mac_addr[1],
            port->mac_addr[2], port->mac_addr[3],
            port->mac_addr[4], port->mac_addr[5]);
    cJSON_AddStringToObject(port_json, "macAddr", mac_str);

    if (port->lldp_chassis_id)
        cJSON_AddStringToObject(port_json, "lldpChassisId",
                port->lldp_chassis_id);
    if (port->lldp_port_id)
        cJSON_AddStringToObject(port_json, "lldpPortId",
                port->lldp_port_id);

    json_str = cJSON_PrintUnformatted(port_json);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(port_json);
}

static void cnc_handle_port_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;
    uint32_t port_number;

    ogs_assert(stream);
    ogs_assert(bridge_id);
    ogs_assert(port_id_str);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    port_number = atoi(port_id_str);
    port = tsn_af_port_find_by_number(bridge, port_number);
    if (!port) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Port not found", port_id_str, NULL));
        return;
    }

    ogs_info("[TSN-AF] Port %u deleted from bridge '%s'",
            port_number, bridge_id);

    ogs_list_remove(&bridge->port_list, port);
    tsn_af_port_remove(port);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT, NULL);
}

static void cnc_handle_port_configure(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;
    uint32_t port_number;

    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(bridge_id);
    ogs_assert(port_id_str);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    port_number = atoi(port_id_str);
    port = tsn_af_port_find_by_number(bridge, port_number);
    if (!port) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Port not found", port_id_str, NULL));
        return;
    }

    /*
     * Parse the request body for port configuration.
     * Expected JSON body may contain:
     * - "mgmtContainer": base64-encoded TS 24.519 port management container
     */
    if (request->http.content && request->http.content_length > 0) {
        cJSON *body = cJSON_Parse(request->http.content);
        if (body) {
            cJSON *mgmt_cont = cJSON_GetObjectItem(body, "mgmtContainer");
            if (mgmt_cont && cJSON_IsString(mgmt_cont)) {
                int decoded_len;
                char *decoded_buf;

                decoded_len = ogs_base64_decode_len(mgmt_cont->valuestring);
                if (decoded_len > 0) {
                    decoded_buf = ogs_calloc(1, decoded_len);
                    ogs_assert(decoded_buf);

                    decoded_len = ogs_base64_decode_binary(
                            (unsigned char *)decoded_buf,
                            mgmt_cont->valuestring);
                    if (decoded_len > 0) {
                        if (port->mgmt_container)
                            ogs_free(port->mgmt_container);
                        port->mgmt_container = (uint8_t *)decoded_buf;
                        port->mgmt_container_len = decoded_len;

                        ogs_info("[TSN-AF] Port %u config updated "
                                "on bridge '%s'",
                                port->port_number, bridge->bridge_id);

                        /* Trigger PCF send */
                        tsn_af_tsctsf_send_port_config(bridge, port);
                    } else {
                        ogs_free(decoded_buf);
                    }
                }
            }

            /* Also handle inline staticFilters JSON */
            {
                cJSON *filters_arr =
                    cJSON_GetObjectItem(body, "staticFilters");
                if (filters_arr && cJSON_IsArray(filters_arr)) {
                    int count = cJSON_GetArraySize(filters_arr);
                    if (count > 0) {
                        ts24519_static_filter_t *filters = NULL;
                        uint8_t *encoded = NULL;
                        uint16_t encoded_len = 0;
                        int i;

                        filters = ogs_calloc(count, sizeof(*filters));
                        ogs_assert(filters);

                        for (i = 0; i < count; i++) {
                            cJSON *f = cJSON_GetArrayItem(filters_arr, i);
                            cJSON *mac = cJSON_GetObjectItem(f, "macAddr");
                            cJSON *vid = cJSON_GetObjectItem(f, "vlanId");
                            cJSON *fwd = cJSON_GetObjectItem(f, "forward");

                            if (mac && cJSON_IsString(mac))
                                parse_mac_addr(mac->valuestring,
                                        filters[i].mac_addr);
                            if (vid && cJSON_IsNumber(vid))
                                filters[i].vlan_id =
                                    (uint16_t)vid->valuedouble;
                            if (fwd && cJSON_IsBool(fwd))
                                filters[i].forward = cJSON_IsTrue(fwd);
                            else
                                filters[i].forward = true;
                        }

                        encoded = ts24519_encode_static_filters(
                                filters, count, &encoded_len);
                        if (encoded) {
                            if (port->mgmt_container)
                                ogs_free(port->mgmt_container);
                            port->mgmt_container = encoded;
                            port->mgmt_container_len = encoded_len;

                            tsn_af_tsctsf_send_port_config(bridge, port);
                        }
                        ogs_free(filters);
                    }
                }
            }

            cJSON_Delete(body);
        }
    }

    /* Send 200 OK */
    tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_OK);
}

static void cnc_handle_bridge_configure(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;

    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(bridge_id);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    /*
     * Parse the request body for bridge configuration.
     * Expected JSON body may contain:
     * - "mgmtContainer": base64-encoded TS 24.519 bridge management container
     */
    if (request->http.content && request->http.content_length > 0) {
        cJSON *body = cJSON_Parse(request->http.content);
        if (body) {
            cJSON *mgmt_cont = cJSON_GetObjectItem(body, "mgmtContainer");
            if (mgmt_cont && cJSON_IsString(mgmt_cont)) {
                int decoded_len;
                char *decoded_buf;

                decoded_len = ogs_base64_decode_len(mgmt_cont->valuestring);
                if (decoded_len > 0) {
                    decoded_buf = ogs_calloc(1, decoded_len);
                    ogs_assert(decoded_buf);

                    decoded_len = ogs_base64_decode_binary(
                            (unsigned char *)decoded_buf,
                            mgmt_cont->valuestring);
                    if (decoded_len > 0) {
                        if (bridge->mgmt_container)
                            ogs_free(bridge->mgmt_container);
                        bridge->mgmt_container = (uint8_t *)decoded_buf;
                        bridge->mgmt_container_len = decoded_len;

                        ogs_info("[TSN-AF] Bridge '%s' config updated",
                                bridge->bridge_id);

                        /* Trigger PCF send */
                        tsn_af_tsctsf_send_bridge_config(bridge);
                    } else {
                        ogs_free(decoded_buf);
                    }
                }
            }
            cJSON_Delete(body);
        }
    }

    /* Send 200 OK */
    tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_OK);
}

/*
 * Phase C: QoS Mapping (PCP to 5QI)
 * POST /tsn-af/v1/bridges/{id}/qos-mapping
 * Body: {"mappings":[{"pcp":7,"5qi":86},{"pcp":6,"5qi":85}]}
 */
static void cnc_handle_qos_mapping(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;
    cJSON *body = NULL;
    cJSON *mappings_arr = NULL;
    cJSON *result = NULL;
    char *json_str = NULL;
    int i, count;

    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(bridge_id);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    if (!request->http.content || request->http.content_length == 0) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty request body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    mappings_arr = cJSON_GetObjectItem(body, "mappings");
    if (!mappings_arr || !cJSON_IsArray(mappings_arr)) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "mappings array required", NULL, NULL));
        return;
    }

    /* Clear existing mappings */
    memset(bridge->qos_map, 0, sizeof(bridge->qos_map));

    count = cJSON_GetArraySize(mappings_arr);
    for (i = 0; i < count && i < TSN_AF_MAX_PCP_VALUES; i++) {
        cJSON *entry = cJSON_GetArrayItem(mappings_arr, i);
        cJSON *pcp_item = cJSON_GetObjectItem(entry, "pcp");
        cJSON *qi_item = cJSON_GetObjectItem(entry, "5qi");

        if (pcp_item && cJSON_IsNumber(pcp_item) &&
            qi_item && cJSON_IsNumber(qi_item)) {
            uint8_t pcp = (uint8_t)pcp_item->valuedouble;
            if (pcp < TSN_AF_MAX_PCP_VALUES) {
                bridge->qos_map[pcp].pcp = pcp;
                bridge->qos_map[pcp]._5qi = (uint8_t)qi_item->valuedouble;
                bridge->qos_map[pcp].configured = true;
            }
        }
    }

    cJSON_Delete(body);

    ogs_info("[TSN-AF] QoS mapping updated for bridge '%s' (%d entries)",
            bridge_id, count);

    /* Push config update to SMF → UPF */
    tsn_af_nsmf_push_config(bridge);

    result = cJSON_CreateObject();
    ogs_assert(result);
    cJSON_AddStringToObject(result, "bridgeId", bridge_id);
    cJSON_AddNumberToObject(result, "mappingCount", count);
    cJSON_AddStringToObject(result, "status", "configured");

    json_str = cJSON_PrintUnformatted(result);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result);
}

/*
 * Phase F: TSC Assistance Info
 * POST /tsn-af/v1/bridges/{id}/tsc-assistance
 */
static void cnc_handle_tsc_assistance(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;
    cJSON *body = NULL;
    cJSON *result = NULL;
    char *json_str = NULL;
    ts24519_tsc_assistance_t tsc_info;

    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(bridge_id);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    if (!request->http.content || request->http.content_length == 0) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty request body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    memset(&tsc_info, 0, sizeof(tsc_info));
    {
        cJSON *item;
        item = cJSON_GetObjectItem(body, "burstArrivalTimeNs");
        if (item && cJSON_IsNumber(item))
            tsc_info.burst_arrival_time_ns = (uint32_t)item->valuedouble;
        item = cJSON_GetObjectItem(body, "periodicityUs");
        if (item && cJSON_IsNumber(item))
            tsc_info.periodicity_us = (uint32_t)item->valuedouble;
        item = cJSON_GetObjectItem(body, "survivalTimeUs");
        if (item && cJSON_IsNumber(item))
            tsc_info.survival_time_us = (uint32_t)item->valuedouble;
    }

    bridge->tsc_assistance.burst_arrival_time_ns =
        tsc_info.burst_arrival_time_ns;
    bridge->tsc_assistance.periodicity_us = tsc_info.periodicity_us;
    bridge->tsc_assistance.survival_time_us = tsc_info.survival_time_us;
    bridge->tsc_assistance.configured = true;

    {
        uint8_t *encoded = NULL;
        uint16_t encoded_len = 0;

        encoded = ts24519_encode_tsc_assistance(&tsc_info, &encoded_len);
        if (encoded) {
            if (bridge->mgmt_container)
                ogs_free(bridge->mgmt_container);
            bridge->mgmt_container = encoded;
            bridge->mgmt_container_len = encoded_len;
            tsn_af_tsctsf_send_bridge_config(bridge);
        }
    }

    cJSON_Delete(body);

    ogs_info("[TSN-AF] TSC assistance configured for bridge '%s' "
            "(burst=%u ns, period=%u us, survival=%u us)",
            bridge_id, tsc_info.burst_arrival_time_ns,
            tsc_info.periodicity_us, tsc_info.survival_time_us);

    /* Push config update to SMF → UPF */
    tsn_af_nsmf_push_config(bridge);

    result = cJSON_CreateObject();
    ogs_assert(result);
    cJSON_AddStringToObject(result, "bridgeId", bridge_id);
    cJSON_AddNumberToObject(result, "burstArrivalTimeNs",
            tsc_info.burst_arrival_time_ns);
    cJSON_AddNumberToObject(result, "periodicityUs",
            tsc_info.periodicity_us);
    cJSON_AddNumberToObject(result, "survivalTimeUs",
            tsc_info.survival_time_us);

    json_str = cJSON_PrintUnformatted(result);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result);
}

/*
 * Helper: build JSON object from a stream reservation
 */
static cJSON *reservation_to_json(
        tsn_af_stream_reservation_t *rsv, const char *bridge_id)
{
    cJSON *obj;
    char mac_str[18];
    const char *state_str;

    ogs_assert(rsv);

    switch (rsv->state) {
    case TSN_AF_STREAM_STATE_ACTIVE:  state_str = "active"; break;
    case TSN_AF_STREAM_STATE_FAILED:  state_str = "failed"; break;
    case TSN_AF_STREAM_STATE_RELEASED: state_str = "released"; break;
    default:                           state_str = "pending"; break;
    }

    obj = cJSON_CreateObject();
    ogs_assert(obj);

    if (bridge_id)
        cJSON_AddStringToObject(obj, "bridgeId", bridge_id);
    cJSON_AddNumberToObject(obj, "streamId", rsv->stream_id);

    ogs_snprintf(mac_str, sizeof(mac_str),
            "%02x:%02x:%02x:%02x:%02x:%02x",
            rsv->dest_mac[0], rsv->dest_mac[1], rsv->dest_mac[2],
            rsv->dest_mac[3], rsv->dest_mac[4], rsv->dest_mac[5]);
    cJSON_AddStringToObject(obj, "destMac", mac_str);
    cJSON_AddNumberToObject(obj, "vlanId", rsv->vlan_id);
    cJSON_AddNumberToObject(obj, "priority", rsv->priority);
    cJSON_AddNumberToObject(obj, "maxFrameSize", rsv->max_frame_size);
    cJSON_AddNumberToObject(obj, "intervalUs", rsv->interval_us);
    cJSON_AddNumberToObject(obj, "maxLatencyUs", rsv->max_latency_us);
    cJSON_AddNumberToObject(obj, "bandwidthBps", (double)rsv->bandwidth_bps);
    cJSON_AddNumberToObject(obj, "filterInstanceId",
            rsv->filter_instance_id);
    cJSON_AddNumberToObject(obj, "gateInstanceId",
            rsv->gate_instance_id);
    cJSON_AddNumberToObject(obj, "targetPortNumber",
            rsv->target_port_number);
    if (rsv->assigned_5qi > 0)
        cJSON_AddNumberToObject(obj, "assigned5qi", rsv->assigned_5qi);
    if (rsv->gbr_bps > 0)
        cJSON_AddNumberToObject(obj, "gbrBps", (double)rsv->gbr_bps);
    if (rsv->mbr_bps > 0)
        cJSON_AddNumberToObject(obj, "mbrBps", (double)rsv->mbr_bps);
    cJSON_AddStringToObject(obj, "status", state_str);

    return obj;
}

/*
 * Phase D: Stream Reservation (Create)
 * POST /tsn-af/v1/bridges/{id}/stream-reservations
 */
static void cnc_handle_stream_reservations(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_stream_reservation_t *rsv = NULL;
    tsn_af_port_t *target_port = NULL;
    cJSON *body = NULL;
    cJSON *result = NULL;
    char *json_str = NULL;
    uint32_t stream_id_val = 0;
    char dest_mac_str[18];

    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(bridge_id);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    if (!request->http.content || request->http.content_length == 0) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty request body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    /* Parse stream ID */
    {
        cJSON *item;
        item = cJSON_GetObjectItem(body, "streamId");
        if (item && cJSON_IsNumber(item))
            stream_id_val = (uint32_t)item->valuedouble;
    }

    if (stream_id_val == 0) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "streamId is required and must be > 0",
                NULL, NULL));
        return;
    }

    /* Check for duplicate */
    if (tsn_af_stream_reservation_find(bridge, stream_id_val)) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_CONFLICT,
                recvmsg, "Stream reservation already exists",
                NULL, NULL));
        return;
    }

    /* Create reservation */
    rsv = tsn_af_stream_reservation_add(bridge, stream_id_val);
    if (!rsv) {
        cJSON_Delete(body);
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_INTERNAL_SERVER_ERROR,
                recvmsg, "Failed to create reservation", NULL, NULL));
        return;
    }

    /* Parse remaining fields */
    {
        cJSON *item;

        item = cJSON_GetObjectItem(body, "destMac");
        if (item && cJSON_IsString(item))
            parse_mac_addr(item->valuestring, rsv->dest_mac);

        item = cJSON_GetObjectItem(body, "vlanId");
        if (item && cJSON_IsNumber(item))
            rsv->vlan_id = (uint16_t)item->valuedouble;

        item = cJSON_GetObjectItem(body, "priority");
        if (item && cJSON_IsNumber(item))
            rsv->priority = (int16_t)item->valuedouble;

        item = cJSON_GetObjectItem(body, "maxFrameSize");
        if (item && cJSON_IsNumber(item))
            rsv->max_frame_size = (uint32_t)item->valuedouble;

        item = cJSON_GetObjectItem(body, "intervalUs");
        if (item && cJSON_IsNumber(item))
            rsv->interval_us = (uint32_t)item->valuedouble;

        item = cJSON_GetObjectItem(body, "maxLatencyUs");
        if (item && cJSON_IsNumber(item))
            rsv->max_latency_us = (uint32_t)item->valuedouble;

        item = cJSON_GetObjectItem(body, "targetPortNumber");
        if (item && cJSON_IsNumber(item))
            rsv->target_port_number = (uint32_t)item->valuedouble;
    }
    cJSON_Delete(body);

    /* Compute required bandwidth: (maxFrameSize * 8) / intervalUs * 1e6 */
    if (rsv->interval_us > 0) {
        rsv->bandwidth_bps =
            ((uint64_t)rsv->max_frame_size * 8 * 1000000) / rsv->interval_us;
    }

    /* Find target NW-TT port (use specified or first available) */
    if (rsv->target_port_number > 0) {
        target_port = tsn_af_port_find_by_number(
                bridge, rsv->target_port_number);
    }
    if (!target_port) {
        ogs_list_for_each(&bridge->port_list, target_port) {
            if (target_port->is_nwtt) {
                rsv->target_port_number = target_port->port_number;
                break;
            }
        }
    }

    /*
     * Build TS 24.519 stream filter + gate for this reservation
     * and store as the port's management container.
     */
    if (target_port) {
        ts24519_stream_filter_t filter;
        ts24519_stream_gate_t gate;
        uint8_t *container = NULL;
        uint16_t container_len = 0;

        memset(&filter, 0, sizeof(filter));
        filter.instance_id = rsv->filter_instance_id;
        memcpy(filter.dest_mac, rsv->dest_mac, 6);
        filter.vlan_id = rsv->vlan_id;
        filter.priority = rsv->priority;
        filter.stream_gate_instance_id = rsv->gate_instance_id;

        memset(&gate, 0, sizeof(gate));
        gate.instance_id = rsv->gate_instance_id;
        gate.gate_open = true;
        gate.ipv = (rsv->priority >= 0) ? (uint8_t)rsv->priority : 0;

        container = ts24519_encode_psfp_container(
                &filter, 1, &gate, 1, &container_len);

        if (container && container_len > 0) {
            if (target_port->mgmt_container)
                ogs_free(target_port->mgmt_container);
            target_port->mgmt_container = container;
            target_port->mgmt_container_len = container_len;

            ogs_info("[TSN-AF] Encoded PSFP container (%u bytes) "
                    "for port %u", container_len,
                    target_port->port_number);

            /* Push to PCF */
            if (bridge->pcf_session_created && bridge->pcf_app_session_id) {
                tsn_af_sbi_discover_and_send(
                    OGS_SBI_SERVICE_TYPE_NPCF_POLICYAUTHORIZATION,
                    NULL,
                    tsn_af_npcf_build_port_mgmt_update,
                    bridge, NULL,
                    TSN_AF_NPCF_STATE_UPDATE, target_port);
            }

            /* Also push directly to SMF */
            tsn_af_nsmf_push_config(bridge);
        }

        /*
         * Phase E: Dynamic QoS — select 5QI and trigger PCF QoS update
         */
        {
            tsn_af_qos_result_t qos_result;

            tsn_af_select_5qi(rsv, bridge, &qos_result);

            rsv->assigned_5qi = qos_result._5qi;
            rsv->assigned_pcp = qos_result.pcp;
            rsv->gbr_bps = qos_result.gbr_bps;
            rsv->mbr_bps = qos_result.mbr_bps;

            /* Send QoS update to PCF if we have a GBR flow */
            if (qos_result.gbr_bps > 0 &&
                    bridge->pcf_session_created &&
                    bridge->pcf_app_session_id) {
                tsn_af_sbi_discover_and_send(
                    OGS_SBI_SERVICE_TYPE_NPCF_POLICYAUTHORIZATION,
                    NULL,
                    tsn_af_npcf_build_qos_update,
                    bridge, NULL,
                    TSN_AF_NPCF_STATE_UPDATE, rsv);

                ogs_info("[TSN-AF] Triggered PCF QoS update for stream %u "
                        "(5QI=%u GBR=%llu MBR=%llu bps)",
                        rsv->stream_id, qos_result._5qi,
                        (unsigned long long)qos_result.gbr_bps,
                        (unsigned long long)qos_result.mbr_bps);
            }
        }

        rsv->state = TSN_AF_STREAM_STATE_ACTIVE;
    } else {
        ogs_warn("[TSN-AF] No NW-TT port found for stream reservation %u",
                stream_id_val);
        rsv->state = TSN_AF_STREAM_STATE_PENDING;
    }

    ogs_snprintf(dest_mac_str, sizeof(dest_mac_str),
            "%02x:%02x:%02x:%02x:%02x:%02x",
            rsv->dest_mac[0], rsv->dest_mac[1], rsv->dest_mac[2],
            rsv->dest_mac[3], rsv->dest_mac[4], rsv->dest_mac[5]);

    ogs_info("[TSN-AF] Stream reservation created: bridge='%s' "
            "stream=%u dest=%s vlan=%u bw=%llu bps",
            bridge_id, stream_id_val, dest_mac_str,
            rsv->vlan_id, (unsigned long long)rsv->bandwidth_bps);

    result = reservation_to_json(rsv, bridge_id);
    json_str = cJSON_PrintUnformatted(result);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_CREATED, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result);
}

/*
 * GET /tsn-af/v1/bridges/{id}/stream-reservations
 */
static void cnc_handle_stream_reservations_list(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_stream_reservation_t *rsv = NULL;
    cJSON *arr = NULL;
    char *json_str = NULL;

    ogs_assert(stream);
    ogs_assert(bridge_id);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    arr = cJSON_CreateArray();
    ogs_assert(arr);

    ogs_list_for_each(&bridge->stream_reservation_list, rsv) {
        cJSON_AddItemToArray(arr, reservation_to_json(rsv, NULL));
    }

    json_str = cJSON_PrintUnformatted(arr);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(arr);
}

/*
 * GET /tsn-af/v1/bridges/{id}/stream-reservations/{streamId}
 */
static void cnc_handle_stream_reservation_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *stream_id_str)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_stream_reservation_t *rsv = NULL;
    uint32_t stream_id_val;
    cJSON *result = NULL;
    char *json_str = NULL;

    ogs_assert(stream);
    ogs_assert(bridge_id);
    ogs_assert(stream_id_str);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    stream_id_val = (uint32_t)atoi(stream_id_str);
    rsv = tsn_af_stream_reservation_find(bridge, stream_id_val);
    if (!rsv) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Stream reservation not found",
                stream_id_str, NULL));
        return;
    }

    result = reservation_to_json(rsv, bridge_id);
    json_str = cJSON_PrintUnformatted(result);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result);
}

/*
 * DELETE /tsn-af/v1/bridges/{id}/stream-reservations/{streamId}
 */
static void cnc_handle_stream_reservation_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *stream_id_str)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_stream_reservation_t *rsv = NULL;
    uint32_t stream_id_val;

    ogs_assert(stream);
    ogs_assert(bridge_id);
    ogs_assert(stream_id_str);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    stream_id_val = (uint32_t)atoi(stream_id_str);
    rsv = tsn_af_stream_reservation_find(bridge, stream_id_val);
    if (!rsv) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Stream reservation not found",
                stream_id_str, NULL));
        return;
    }

    ogs_info("[TSN-AF] Stream reservation %u released for bridge '%s'",
            stream_id_val, bridge_id);

    tsn_af_stream_reservation_remove(bridge, rsv);

    tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT);
}

/*
 * Phase G: Gate Control List (IEEE 802.1Qbv)
 * POST /tsn-af/v1/bridges/{id}/ports/{portId}/gcl
 */
static void cnc_handle_port_gcl(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;
    uint32_t port_number;
    cJSON *body = NULL;
    cJSON *entries_arr = NULL;
    cJSON *result = NULL;
    char *json_str = NULL;

    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(bridge_id);
    ogs_assert(port_id_str);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    port_number = atoi(port_id_str);
    port = tsn_af_port_find_by_number(bridge, port_number);
    if (!port) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Port not found", port_id_str, NULL));
        return;
    }

    if (!request->http.content || request->http.content_length == 0) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty request body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    entries_arr = cJSON_GetObjectItem(body, "entries");
    if (entries_arr && cJSON_IsArray(entries_arr)) {
        int count = cJSON_GetArraySize(entries_arr);
        if (count > 0) {
            ts24519_gate_control_entry_t *gcl_entries = NULL;
            uint8_t *encoded = NULL;
            uint16_t encoded_len = 0;
            int i;

            gcl_entries = ogs_calloc(count, sizeof(*gcl_entries));
            ogs_assert(gcl_entries);

            for (i = 0; i < count; i++) {
                cJSON *entry = cJSON_GetArrayItem(entries_arr, i);
                cJSON *gs = cJSON_GetObjectItem(entry, "gateStates");
                cJSON *ti = cJSON_GetObjectItem(entry, "timeIntervalNs");

                if (gs && cJSON_IsNumber(gs))
                    gcl_entries[i].gate_states =
                        (uint8_t)gs->valuedouble;
                if (ti && cJSON_IsNumber(ti))
                    gcl_entries[i].time_interval_ns =
                        (uint32_t)ti->valuedouble;
            }

            encoded = ts24519_encode_gate_control_list(
                    gcl_entries, count, &encoded_len);
            if (encoded) {
                if (port->mgmt_container)
                    ogs_free(port->mgmt_container);
                port->mgmt_container = encoded;
                port->mgmt_container_len = encoded_len;
                tsn_af_tsctsf_send_port_config(bridge, port);
            }

            ogs_free(gcl_entries);

            ogs_info("[TSN-AF] GCL configured: bridge '%s' port %u "
                    "(%d entries)", bridge_id, port_number, count);
        }
    }

    cJSON_Delete(body);

    result = cJSON_CreateObject();
    ogs_assert(result);
    cJSON_AddStringToObject(result, "bridgeId", bridge_id);
    cJSON_AddNumberToObject(result, "portNumber", port_number);
    cJSON_AddStringToObject(result, "status", "configured");

    json_str = cJSON_PrintUnformatted(result);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result);
}

/*
 * Phase G: Per-Stream Filtering & Policing (IEEE 802.1Qci)
 * POST /tsn-af/v1/bridges/{id}/ports/{portId}/psfp
 */
static void cnc_handle_port_psfp(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;
    uint32_t port_number;
    cJSON *body = NULL;
    cJSON *arr = NULL;
    cJSON *result = NULL;
    char *json_str = NULL;
    uint8_t *container = NULL;
    uint16_t container_len = 0;

    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(bridge_id);
    ogs_assert(port_id_str);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    port_number = atoi(port_id_str);
    port = tsn_af_port_find_by_number(bridge, port_number);
    if (!port) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Port not found", port_id_str, NULL));
        return;
    }

    if (!request->http.content || request->http.content_length == 0) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty request body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    /* Reset PSFP config */
    memset(&port->psfp, 0, sizeof(port->psfp));

    /* Parse stream filters */
    arr = cJSON_GetObjectItem(body, "streamFilters");
    if (arr && cJSON_IsArray(arr)) {
        int count = cJSON_GetArraySize(arr);
        int i;

        if (count > TSN_AF_MAX_PSFP_FILTERS)
            count = TSN_AF_MAX_PSFP_FILTERS;

        for (i = 0; i < count; i++) {
            cJSON *entry = cJSON_GetArrayItem(arr, i);
            ts24519_stream_filter_t *sf = &port->psfp.filters[i];
            cJSON *item;

            item = cJSON_GetObjectItem(entry, "instanceId");
            if (item && cJSON_IsNumber(item))
                sf->instance_id = (uint32_t)item->valuedouble;
            item = cJSON_GetObjectItem(entry, "destMac");
            if (item && cJSON_IsString(item))
                parse_mac_addr(item->valuestring, sf->dest_mac);
            item = cJSON_GetObjectItem(entry, "vlanId");
            if (item && cJSON_IsNumber(item))
                sf->vlan_id = (uint16_t)item->valuedouble;
            item = cJSON_GetObjectItem(entry, "priority");
            if (item && cJSON_IsNumber(item))
                sf->priority = (int16_t)item->valuedouble;
            else
                sf->priority = -1;
            item = cJSON_GetObjectItem(entry, "streamGateInstanceId");
            if (item && cJSON_IsNumber(item))
                sf->stream_gate_instance_id = (uint32_t)item->valuedouble;
        }
        port->psfp.filter_count = count;
    }

    /* Parse stream gates */
    arr = cJSON_GetObjectItem(body, "streamGates");
    if (arr && cJSON_IsArray(arr)) {
        int count = cJSON_GetArraySize(arr);
        int i;

        if (count > TSN_AF_MAX_PSFP_GATES)
            count = TSN_AF_MAX_PSFP_GATES;

        for (i = 0; i < count; i++) {
            cJSON *entry = cJSON_GetArrayItem(arr, i);
            ts24519_stream_gate_t *sg = &port->psfp.gates[i];
            cJSON *item;

            item = cJSON_GetObjectItem(entry, "instanceId");
            if (item && cJSON_IsNumber(item))
                sg->instance_id = (uint32_t)item->valuedouble;
            item = cJSON_GetObjectItem(entry, "gateOpen");
            if (item)
                sg->gate_open = cJSON_IsTrue(item);
            else
                sg->gate_open = true;
            item = cJSON_GetObjectItem(entry, "ipv");
            if (item && cJSON_IsNumber(item))
                sg->ipv = (uint8_t)item->valuedouble;
        }
        port->psfp.gate_count = count;
    }

    /* Parse flow meters */
    arr = cJSON_GetObjectItem(body, "flowMeters");
    if (arr && cJSON_IsArray(arr)) {
        int count = cJSON_GetArraySize(arr);
        int i;

        if (count > TSN_AF_MAX_FLOW_METERS)
            count = TSN_AF_MAX_FLOW_METERS;

        for (i = 0; i < count; i++) {
            cJSON *entry = cJSON_GetArrayItem(arr, i);
            tsn_af_flow_meter_t *fm = &port->psfp.meters[i];
            cJSON *item;

            item = cJSON_GetObjectItem(entry, "meterId");
            if (item && cJSON_IsNumber(item))
                fm->meter_id = (uint32_t)item->valuedouble;
            item = cJSON_GetObjectItem(entry, "cir");
            if (item && cJSON_IsNumber(item))
                fm->committed_info_rate = (uint32_t)item->valuedouble;
            item = cJSON_GetObjectItem(entry, "cbs");
            if (item && cJSON_IsNumber(item))
                fm->committed_burst_size = (uint32_t)item->valuedouble;
            fm->active = true;
        }
        port->psfp.meter_count = count;
    }

    cJSON_Delete(body);

    port->psfp.configured = true;

    /* Encode compound PSFP container (filters + gates + meters) */
    {
        ts24519_flow_meter_t ts_meters[TSN_AF_MAX_FLOW_METERS];
        int i;

        for (i = 0; i < port->psfp.meter_count; i++) {
            ts_meters[i].meter_id = port->psfp.meters[i].meter_id;
            ts_meters[i].committed_info_rate =
                port->psfp.meters[i].committed_info_rate;
            ts_meters[i].committed_burst_size =
                port->psfp.meters[i].committed_burst_size;
        }

        container = ts24519_encode_psfp_container_full(
                port->psfp.filters, port->psfp.filter_count,
                port->psfp.gates, port->psfp.gate_count,
                ts_meters, port->psfp.meter_count,
                &container_len);
    }

    if (container && container_len > 0) {
        if (port->mgmt_container)
            ogs_free(port->mgmt_container);
        port->mgmt_container = container;
        port->mgmt_container_len = container_len;

        /* Push to PCF */
        if (bridge->pcf_session_created && bridge->pcf_app_session_id) {
            tsn_af_sbi_discover_and_send(
                OGS_SBI_SERVICE_TYPE_NPCF_POLICYAUTHORIZATION,
                NULL,
                tsn_af_npcf_build_port_mgmt_update,
                bridge, NULL,
                TSN_AF_NPCF_STATE_UPDATE, port);
        }

        /* Push directly to SMF */
        tsn_af_nsmf_push_config(bridge);
    }

    ogs_info("[TSN-AF] PSFP configured: bridge '%s' port %u "
            "(%d filters, %d gates, %d meters)",
            bridge_id, port_number,
            port->psfp.filter_count,
            port->psfp.gate_count,
            port->psfp.meter_count);

    /* Build response */
    result = cJSON_CreateObject();
    ogs_assert(result);
    cJSON_AddStringToObject(result, "bridgeId", bridge_id);
    cJSON_AddNumberToObject(result, "portNumber", port_number);
    cJSON_AddNumberToObject(result, "filterCount", port->psfp.filter_count);
    cJSON_AddNumberToObject(result, "gateCount", port->psfp.gate_count);
    cJSON_AddNumberToObject(result, "meterCount", port->psfp.meter_count);
    cJSON_AddStringToObject(result, "status", "configured");

    json_str = cJSON_PrintUnformatted(result);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result);
}

/*
 * GET /tsn-af/v1/bridges/{id}/ports/{portId}/psfp
 */
static void cnc_handle_port_psfp_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;
    uint32_t port_number;
    cJSON *result = NULL;
    cJSON *arr = NULL;
    char *json_str = NULL;
    int i;

    ogs_assert(stream);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    port_number = atoi(port_id_str);
    port = tsn_af_port_find_by_number(bridge, port_number);
    if (!port) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Port not found", port_id_str, NULL));
        return;
    }

    result = cJSON_CreateObject();
    ogs_assert(result);

    cJSON_AddStringToObject(result, "bridgeId", bridge_id);
    cJSON_AddNumberToObject(result, "portNumber", port_number);
    cJSON_AddBoolToObject(result, "configured", port->psfp.configured);

    /* Stream filters */
    arr = cJSON_CreateArray();
    for (i = 0; i < port->psfp.filter_count; i++) {
        cJSON *entry = cJSON_CreateObject();
        char mac_str[18];
        ts24519_stream_filter_t *sf = &port->psfp.filters[i];

        cJSON_AddNumberToObject(entry, "instanceId", sf->instance_id);
        ogs_snprintf(mac_str, sizeof(mac_str),
                "%02x:%02x:%02x:%02x:%02x:%02x",
                sf->dest_mac[0], sf->dest_mac[1], sf->dest_mac[2],
                sf->dest_mac[3], sf->dest_mac[4], sf->dest_mac[5]);
        cJSON_AddStringToObject(entry, "destMac", mac_str);
        cJSON_AddNumberToObject(entry, "vlanId", sf->vlan_id);
        cJSON_AddNumberToObject(entry, "priority", sf->priority);
        cJSON_AddNumberToObject(entry, "streamGateInstanceId",
                sf->stream_gate_instance_id);
        cJSON_AddItemToArray(arr, entry);
    }
    cJSON_AddItemToObject(result, "streamFilters", arr);

    /* Stream gates */
    arr = cJSON_CreateArray();
    for (i = 0; i < port->psfp.gate_count; i++) {
        cJSON *entry = cJSON_CreateObject();
        ts24519_stream_gate_t *sg = &port->psfp.gates[i];

        cJSON_AddNumberToObject(entry, "instanceId", sg->instance_id);
        cJSON_AddBoolToObject(entry, "gateOpen", sg->gate_open);
        cJSON_AddNumberToObject(entry, "ipv", sg->ipv);
        cJSON_AddItemToArray(arr, entry);
    }
    cJSON_AddItemToObject(result, "streamGates", arr);

    /* Flow meters */
    arr = cJSON_CreateArray();
    for (i = 0; i < port->psfp.meter_count; i++) {
        cJSON *entry = cJSON_CreateObject();
        tsn_af_flow_meter_t *fm = &port->psfp.meters[i];

        cJSON_AddNumberToObject(entry, "meterId", fm->meter_id);
        cJSON_AddNumberToObject(entry, "cir", fm->committed_info_rate);
        cJSON_AddNumberToObject(entry, "cbs", fm->committed_burst_size);
        cJSON_AddBoolToObject(entry, "active", fm->active);
        cJSON_AddItemToArray(arr, entry);
    }
    cJSON_AddItemToObject(result, "flowMeters", arr);

    json_str = cJSON_PrintUnformatted(result);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result);
}

/*
 * DELETE /tsn-af/v1/bridges/{id}/ports/{portId}/psfp
 */
static void cnc_handle_port_psfp_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *bridge_id, const char *port_id_str)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_port_t *port = NULL;
    uint32_t port_number;

    ogs_assert(stream);

    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (!bridge) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Bridge not found", bridge_id, NULL));
        return;
    }

    port_number = atoi(port_id_str);
    port = tsn_af_port_find_by_number(bridge, port_number);
    if (!port) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Port not found", port_id_str, NULL));
        return;
    }

    /* Clear PSFP config */
    memset(&port->psfp, 0, sizeof(port->psfp));

    /* Clear port management container */
    if (port->mgmt_container) {
        ogs_free(port->mgmt_container);
        port->mgmt_container = NULL;
        port->mgmt_container_len = 0;
    }

    ogs_info("[TSN-AF] PSFP cleared: bridge '%s' port %u",
            bridge_id, port_number);

    /* Push empty config to SMF */
    tsn_af_nsmf_push_config(bridge);

    tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT);
}

/*
 * Bridge Group helpers
 */
static cJSON *bridge_group_to_json(tsn_af_bridge_group_t *group)
{
    tsn_af_bridge_group_member_t *member = NULL;
    cJSON *obj, *members_arr;
    const char *health_str;

    obj = cJSON_CreateObject();
    ogs_assert(obj);

    cJSON_AddStringToObject(obj, "groupId", group->group_id);
    if (group->active_bridge_id)
        cJSON_AddStringToObject(obj, "activeBridgeId",
                group->active_bridge_id);
    cJSON_AddNumberToObject(obj, "healthCheckIntervalMs",
            group->health_check_interval_ms);
    cJSON_AddNumberToObject(obj, "failoverThreshold",
            group->failover_threshold);

    members_arr = cJSON_CreateArray();
    ogs_list_for_each(&group->member_list, member) {
        cJSON *m = cJSON_CreateObject();

        switch (member->health) {
        case TSN_AF_BRIDGE_HEALTH_UP: health_str = "up"; break;
        case TSN_AF_BRIDGE_HEALTH_DEGRADED: health_str = "degraded"; break;
        case TSN_AF_BRIDGE_HEALTH_DOWN: health_str = "down"; break;
        default: health_str = "unknown"; break;
        }

        cJSON_AddStringToObject(m, "bridgeId", member->bridge_id);
        cJSON_AddStringToObject(m, "role",
                member->role == TSN_AF_BRIDGE_ROLE_PRIMARY ? "primary" :
                member->role == TSN_AF_BRIDGE_ROLE_BACKUP ? "backup" :
                "standalone");
        cJSON_AddNumberToObject(m, "priority", member->priority);
        cJSON_AddStringToObject(m, "health", health_str);
        cJSON_AddNumberToObject(m, "consecutiveFailures",
                member->consecutive_failures);
        cJSON_AddItemToArray(members_arr, m);
    }
    cJSON_AddItemToObject(obj, "members", members_arr);

    return obj;
}

static void cnc_handle_bridge_group_create(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg)
{
    cJSON *body, *item;
    tsn_af_bridge_group_t *group;
    const char *group_id = NULL;
    cJSON *result;
    char *json_str;

    if (!request->http.content) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    item = cJSON_GetObjectItem(body, "groupId");
    if (item && cJSON_IsString(item))
        group_id = item->valuestring;

    if (!group_id) {
        cJSON_Delete(body);
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "groupId required", NULL, NULL));
        return;
    }

    if (tsn_af_bridge_group_find_by_id(group_id)) {
        cJSON_Delete(body);
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_CONFLICT,
                recvmsg, "Group already exists", NULL, NULL));
        return;
    }

    group = tsn_af_bridge_group_add(group_id);

    item = cJSON_GetObjectItem(body, "healthCheckIntervalMs");
    if (item && cJSON_IsNumber(item))
        group->health_check_interval_ms = (uint32_t)item->valuedouble;

    item = cJSON_GetObjectItem(body, "failoverThreshold");
    if (item && cJSON_IsNumber(item))
        group->failover_threshold = (uint32_t)item->valuedouble;

    cJSON_Delete(body);

    /* Start health monitoring */
    tsn_af_bridge_health_start(group);

    result = bridge_group_to_json(group);
    json_str = cJSON_PrintUnformatted(result);
    send_json_response(stream, OGS_SBI_HTTP_STATUS_CREATED, json_str);
    cJSON_free(json_str);
    cJSON_Delete(result);
}

static void cnc_handle_bridge_groups_list(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg)
{
    tsn_af_bridge_group_t *group = NULL;
    cJSON *arr = cJSON_CreateArray();
    char *json_str;

    ogs_list_for_each(&tsn_af_self()->bridge_group_list, group) {
        cJSON_AddItemToArray(arr, bridge_group_to_json(group));
    }

    json_str = cJSON_PrintUnformatted(arr);
    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);
    cJSON_free(json_str);
    cJSON_Delete(arr);
}

static void cnc_handle_bridge_group_get(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *group_id)
{
    tsn_af_bridge_group_t *group;
    cJSON *result;
    char *json_str;

    group = tsn_af_bridge_group_find_by_id(group_id);
    if (!group) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Group not found", group_id, NULL));
        return;
    }

    result = bridge_group_to_json(group);
    json_str = cJSON_PrintUnformatted(result);
    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);
    cJSON_free(json_str);
    cJSON_Delete(result);
}

static void cnc_handle_bridge_group_delete(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *group_id)
{
    tsn_af_bridge_group_t *group;

    group = tsn_af_bridge_group_find_by_id(group_id);
    if (!group) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Group not found", group_id, NULL));
        return;
    }

    tsn_af_bridge_health_stop(group);
    tsn_af_bridge_group_remove(group);

    tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT);
}

static void cnc_handle_bridge_group_add_member(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg, const char *group_id)
{
    tsn_af_bridge_group_t *group;
    cJSON *body, *item;
    const char *bridge_id = NULL;
    tsn_af_bridge_role_e role = TSN_AF_BRIDGE_ROLE_BACKUP;
    uint32_t priority = 100;
    tsn_af_bridge_group_member_t *member;
    cJSON *result;
    char *json_str;

    group = tsn_af_bridge_group_find_by_id(group_id);
    if (!group) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Group not found", group_id, NULL));
        return;
    }

    if (!request->http.content) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Empty body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "Invalid JSON", NULL, NULL));
        return;
    }

    item = cJSON_GetObjectItem(body, "bridgeId");
    if (item && cJSON_IsString(item))
        bridge_id = item->valuestring;

    item = cJSON_GetObjectItem(body, "role");
    if (item && cJSON_IsString(item)) {
        if (!strcmp(item->valuestring, "primary"))
            role = TSN_AF_BRIDGE_ROLE_PRIMARY;
        else if (!strcmp(item->valuestring, "backup"))
            role = TSN_AF_BRIDGE_ROLE_BACKUP;
    }

    item = cJSON_GetObjectItem(body, "priority");
    if (item && cJSON_IsNumber(item))
        priority = (uint32_t)item->valuedouble;

    if (!bridge_id) {
        cJSON_Delete(body);
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST,
                recvmsg, "bridgeId required", NULL, NULL));
        return;
    }

    if (tsn_af_bridge_group_find_member(group, bridge_id)) {
        cJSON_Delete(body);
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_CONFLICT,
                recvmsg, "Bridge already in group", NULL, NULL));
        return;
    }

    member = tsn_af_bridge_group_add_member(group, bridge_id, role, priority);
    cJSON_Delete(body);

    if (!member) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_INTERNAL_SERVER_ERROR,
                recvmsg, "Failed to add member", NULL, NULL));
        return;
    }

    result = bridge_group_to_json(group);
    json_str = cJSON_PrintUnformatted(result);
    send_json_response(stream, OGS_SBI_HTTP_STATUS_CREATED, json_str);
    cJSON_free(json_str);
    cJSON_Delete(result);
}

static void cnc_handle_bridge_group_remove_member(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *group_id, const char *bridge_id)
{
    tsn_af_bridge_group_t *group;
    tsn_af_bridge_group_member_t *member;

    group = tsn_af_bridge_group_find_by_id(group_id);
    if (!group) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Group not found", group_id, NULL));
        return;
    }

    member = tsn_af_bridge_group_find_member(group, bridge_id);
    if (!member) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Member not found", bridge_id, NULL));
        return;
    }

    tsn_af_bridge_group_remove_member(group, member);

    tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT);
}

static void cnc_handle_bridge_group_failover(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg,
        const char *group_id)
{
    tsn_af_bridge_group_t *group;
    int rv;
    cJSON *result;
    char *json_str;

    group = tsn_af_bridge_group_find_by_id(group_id);
    if (!group) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND,
                recvmsg, "Group not found", group_id, NULL));
        return;
    }

    rv = tsn_af_bridge_failover(group);
    if (rv != OGS_OK) {
        ogs_assert(true == ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_INTERNAL_SERVER_ERROR,
                recvmsg, "Failover failed (no healthy backup)",
                NULL, NULL));
        return;
    }

    result = bridge_group_to_json(group);
    json_str = cJSON_PrintUnformatted(result);
    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);
    cJSON_free(json_str);
    cJSON_Delete(result);
}

/*
 * Analytics endpoint: GET /tsn-af/v1/analytics
 * Aggregates all TSN AF state into a single JSON response.
 */
static void cnc_handle_analytics(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg)
{
    tsn_af_bridge_t *bridge = NULL;
    tsn_af_time_sync_t *ts = NULL;
    cJSON *root = NULL;
    cJSON *bridges_arr = NULL;
    cJSON *time_sync_arr = NULL;
    cJSON *summary = NULL;
    char *json_str = NULL;

    int total_bridges = 0;
    int active_pcf_sessions = 0;
    int total_ports = 0;
    int nwtt_ports = 0;
    int dstt_ports = 0;
    int configured_qos_mappings = 0;
    int active_time_sync_subs = 0;

    ogs_assert(stream);

    root = cJSON_CreateObject();
    ogs_assert(root);

    /* Build bridges array */
    bridges_arr = cJSON_CreateArray();
    ogs_assert(bridges_arr);

    ogs_list_for_each(&tsn_af_self()->bridge_list, bridge) {
        cJSON *bridge_json = NULL;
        cJSON *ports_arr = NULL;
        cJSON *qos_arr = NULL;
        cJSON *tsc_json = NULL;
        tsn_af_port_t *port = NULL;
        char mac_str[18];
        int i;

        total_bridges++;

        bridge_json = cJSON_CreateObject();
        ogs_assert(bridge_json);

        if (bridge->bridge_id)
            cJSON_AddStringToObject(bridge_json, "bridgeId",
                    bridge->bridge_id);

        ogs_snprintf(mac_str, sizeof(mac_str),
                "%02x:%02x:%02x:%02x:%02x:%02x",
                bridge->bridge_mac[0], bridge->bridge_mac[1],
                bridge->bridge_mac[2], bridge->bridge_mac[3],
                bridge->bridge_mac[4], bridge->bridge_mac[5]);
        cJSON_AddStringToObject(bridge_json, "bridgeMac", mac_str);

        if (bridge->dnn)
            cJSON_AddStringToObject(bridge_json, "dnn", bridge->dnn);

        /* PCF session status */
        cJSON_AddBoolToObject(bridge_json, "pcfSessionCreated",
                bridge->pcf_session_created);
        if (bridge->pcf_app_session_id)
            cJSON_AddStringToObject(bridge_json, "pcfAppSessionId",
                    bridge->pcf_app_session_id);

        if (bridge->pcf_session_created)
            active_pcf_sessions++;

        /* Ports array */
        ports_arr = cJSON_CreateArray();
        ogs_assert(ports_arr);

        ogs_list_for_each(&bridge->port_list, port) {
            cJSON *port_json = NULL;
            char port_mac_str[18];

            total_ports++;
            if (port->is_nwtt)
                nwtt_ports++;
            else
                dstt_ports++;

            port_json = cJSON_CreateObject();
            ogs_assert(port_json);

            cJSON_AddNumberToObject(port_json, "portNumber",
                    port->port_number);
            cJSON_AddBoolToObject(port_json, "isNwtt", port->is_nwtt);

            ogs_snprintf(port_mac_str, sizeof(port_mac_str),
                    "%02x:%02x:%02x:%02x:%02x:%02x",
                    port->mac_addr[0], port->mac_addr[1],
                    port->mac_addr[2], port->mac_addr[3],
                    port->mac_addr[4], port->mac_addr[5]);
            cJSON_AddStringToObject(port_json, "macAddr", port_mac_str);

            if (port->lldp_chassis_id)
                cJSON_AddStringToObject(port_json, "lldpChassisId",
                        port->lldp_chassis_id);
            if (port->lldp_port_id)
                cJSON_AddStringToObject(port_json, "lldpPortId",
                        port->lldp_port_id);

            cJSON_AddBoolToObject(port_json, "hasMgmtContainer",
                    (port->mgmt_container != NULL));

            cJSON_AddItemToArray(ports_arr, port_json);
        }
        cJSON_AddItemToObject(bridge_json, "ports", ports_arr);

        /* QoS mappings */
        qos_arr = cJSON_CreateArray();
        ogs_assert(qos_arr);

        for (i = 0; i < TSN_AF_MAX_PCP_VALUES; i++) {
            if (bridge->qos_map[i].configured) {
                cJSON *qos_json = cJSON_CreateObject();
                ogs_assert(qos_json);

                cJSON_AddNumberToObject(qos_json, "pcp",
                        bridge->qos_map[i].pcp);
                cJSON_AddNumberToObject(qos_json, "5qi",
                        bridge->qos_map[i]._5qi);
                cJSON_AddBoolToObject(qos_json, "configured", true);

                cJSON_AddItemToArray(qos_arr, qos_json);
                configured_qos_mappings++;
            }
        }
        cJSON_AddItemToObject(bridge_json, "qosMappings", qos_arr);

        /* TSC assistance */
        tsc_json = cJSON_CreateObject();
        ogs_assert(tsc_json);

        cJSON_AddBoolToObject(tsc_json, "configured",
                bridge->tsc_assistance.configured);
        cJSON_AddNumberToObject(tsc_json, "burstArrivalTimeNs",
                bridge->tsc_assistance.burst_arrival_time_ns);
        cJSON_AddNumberToObject(tsc_json, "periodicityUs",
                bridge->tsc_assistance.periodicity_us);
        cJSON_AddNumberToObject(tsc_json, "survivalTimeUs",
                bridge->tsc_assistance.survival_time_us);

        cJSON_AddItemToObject(bridge_json, "tscAssistance", tsc_json);

        cJSON_AddItemToArray(bridges_arr, bridge_json);
    }
    cJSON_AddItemToObject(root, "bridges", bridges_arr);

    /* Time sync subscriptions */
    time_sync_arr = cJSON_CreateArray();
    ogs_assert(time_sync_arr);

    ogs_list_for_each(&tsn_af_self()->time_sync_list, ts) {
        cJSON *ts_json = cJSON_CreateObject();
        ogs_assert(ts_json);

        if (ts->subscription_id)
            cJSON_AddStringToObject(ts_json, "subscriptionId",
                    ts->subscription_id);
        cJSON_AddNumberToObject(ts_json, "timeDomainNumber",
                ts->time_domain_number);
        cJSON_AddNumberToObject(ts_json, "timeOffsetNs",
                ts->time_offset_ns);
        cJSON_AddBoolToObject(ts_json, "active", ts->active);
        if (ts->requester_nf_id)
            cJSON_AddStringToObject(ts_json, "requesterNfId",
                    ts->requester_nf_id);

        if (ts->active)
            active_time_sync_subs++;

        cJSON_AddItemToArray(time_sync_arr, ts_json);
    }
    cJSON_AddItemToObject(root, "timeSyncSubscriptions", time_sync_arr);

    /* Summary */
    summary = cJSON_CreateObject();
    ogs_assert(summary);

    cJSON_AddNumberToObject(summary, "totalBridges", total_bridges);
    cJSON_AddNumberToObject(summary, "activePcfSessions",
            active_pcf_sessions);
    cJSON_AddNumberToObject(summary, "totalPorts", total_ports);
    cJSON_AddNumberToObject(summary, "nwttPorts", nwtt_ports);
    cJSON_AddNumberToObject(summary, "dsttPorts", dstt_ports);
    cJSON_AddNumberToObject(summary, "configuredQosMappings",
            configured_qos_mappings);
    cJSON_AddNumberToObject(summary, "activeTimeSyncSubs",
            active_time_sync_subs);

    cJSON_AddItemToObject(root, "summary", summary);

    json_str = cJSON_PrintUnformatted(root);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(root);
}

/*
 * GET /tsn-af/v1/interfaces
 * List physical network interfaces available for bridge attachment.
 */
static void cnc_handle_interfaces_list(
        ogs_sbi_stream_t *stream, ogs_sbi_message_t *recvmsg)
{
    cJSON *ifaces = NULL;
    char *json_str = NULL;

    ogs_assert(stream);

    ifaces = tsn_af_linux_list_interfaces();
    ogs_assert(ifaces);

    json_str = cJSON_PrintUnformatted(ifaces);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(ifaces);
}
