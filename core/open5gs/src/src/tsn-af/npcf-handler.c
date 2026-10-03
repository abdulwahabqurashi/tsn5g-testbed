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
#include "npcf-handler.h"
#include "nsmf-handler.h"

void tsn_af_npcf_handle_policy_auth_response(
        int state, tsn_af_bridge_t *bridge, ogs_sbi_message_t *recvmsg)
{
    ogs_assert(recvmsg);
    ogs_assert(bridge);

    if (state == TSN_AF_NPCF_STATE_CREATE) {
        if (recvmsg->res_status == OGS_SBI_HTTP_STATUS_CREATED) {
            /* Extract app session ID from Location header */
            if (recvmsg->http.location) {
                char *last_slash = strrchr(recvmsg->http.location, '/');
                if (last_slash && *(last_slash + 1)) {
                    if (bridge->pcf_app_session_id)
                        ogs_free(bridge->pcf_app_session_id);
                    bridge->pcf_app_session_id =
                        ogs_strdup(last_slash + 1);
                    bridge->pcf_session_created = true;

                    ogs_info("[TSN-AF] AppSession created for bridge '%s': %s",
                            bridge->bridge_id,
                            bridge->pcf_app_session_id);
                }
            } else {
                /* Fallback: mark created even without Location */
                bridge->pcf_session_created = true;
                ogs_info("[TSN-AF] AppSession created for bridge '%s' "
                        "(no Location header)", bridge->bridge_id);
            }

            if (recvmsg->AppSessionContext) {
                ogs_info("[TSN-AF] Received AppSessionContext from PCF");
            }
        } else {
            ogs_error("[TSN-AF] PCF AppSession creation failed for "
                    "bridge '%s' [%d]",
                    bridge->bridge_id, recvmsg->res_status);
        }
    } else if (state == TSN_AF_NPCF_STATE_UPDATE) {
        if (recvmsg->res_status == OGS_SBI_HTTP_STATUS_OK ||
            recvmsg->res_status == OGS_SBI_HTTP_STATUS_NO_CONTENT) {
            ogs_info("[TSN-AF] AppSession updated for bridge '%s'",
                    bridge->bridge_id);
        } else {
            ogs_error("[TSN-AF] PCF AppSession update failed for "
                    "bridge '%s' [%d]",
                    bridge->bridge_id, recvmsg->res_status);
        }
    } else {
        ogs_error("[TSN-AF] Unknown NPCF state [%d] for bridge '%s'",
                state, bridge->bridge_id);
    }
}

static tsn_af_bridge_t *find_bridge_by_ev_subs_uri(const char *uri)
{
    tsn_af_bridge_t *bridge = NULL;

    if (!uri) return NULL;

    /*
     * The ev_subs_uri contains the notification URI we set when creating
     * the AppSession.  We can match it to a bridge by checking if the
     * bridge has an active PCF session.  For now, if there's only one
     * bridge with a PCF session, return it.  A more robust approach
     * would embed the bridge_id in the notification URI path.
     */
    ogs_list_for_each(&tsn_af_self()->bridge_list, bridge) {
        if (bridge->pcf_session_created)
            return bridge;
    }

    return NULL;
}

static void handle_tsn_bridge_info_containers(
        tsn_af_bridge_t *bridge, cJSON *root)
{
    cJSON *tsn_bridge_man_cont = NULL;
    cJSON *tsn_port_man_cont_dstt = NULL;
    cJSON *tsn_port_man_cont_nwtts = NULL;
    bool containers_updated = false;

    /* Bridge management container */
    tsn_bridge_man_cont = cJSON_GetObjectItemCaseSensitive(
            root, "tsnBridgeManCont");
    if (tsn_bridge_man_cont) {
        cJSON *b64_item = cJSON_GetObjectItemCaseSensitive(
                tsn_bridge_man_cont, "bridgeManCont");
        if (b64_item && cJSON_IsString(b64_item) && b64_item->valuestring) {
            uint8_t *decoded = NULL;
            int decoded_len;

            decoded_len = ogs_base64_decode_len(b64_item->valuestring);
            decoded = ogs_calloc(1, decoded_len);
            ogs_assert(decoded);

            decoded_len = ogs_base64_decode_binary(
                    decoded, b64_item->valuestring);
            if (decoded_len > 0) {
                if (bridge->mgmt_container)
                    ogs_free(bridge->mgmt_container);
                bridge->mgmt_container = decoded;
                bridge->mgmt_container_len = decoded_len;
                containers_updated = true;

                ogs_info("[TSN-AF] Updated bridge '%s' management container "
                        "(%d bytes)", bridge->bridge_id, decoded_len);
            } else {
                ogs_free(decoded);
            }
        }
    }

    /* DS-TT port management container */
    tsn_port_man_cont_dstt = cJSON_GetObjectItemCaseSensitive(
            root, "tsnPortManContDstt");
    if (tsn_port_man_cont_dstt) {
        cJSON *b64_item = cJSON_GetObjectItemCaseSensitive(
                tsn_port_man_cont_dstt, "portManCont");
        cJSON *port_num_item = cJSON_GetObjectItemCaseSensitive(
                tsn_port_man_cont_dstt, "portNum");

        if (b64_item && cJSON_IsString(b64_item) && b64_item->valuestring) {
            uint32_t port_num = 0;
            tsn_af_port_t *port = NULL;

            if (port_num_item && cJSON_IsNumber(port_num_item))
                port_num = port_num_item->valueint;

            /* Find DS-TT port */
            ogs_list_for_each(&bridge->port_list, port) {
                if (!port->is_nwtt &&
                        (port_num == 0 || port->port_number == port_num))
                    break;
            }

            if (port) {
                uint8_t *decoded = NULL;
                int decoded_len;

                decoded_len = ogs_base64_decode_len(b64_item->valuestring);
                decoded = ogs_calloc(1, decoded_len);
                ogs_assert(decoded);

                decoded_len = ogs_base64_decode_binary(
                        decoded, b64_item->valuestring);
                if (decoded_len > 0) {
                    if (port->mgmt_container)
                        ogs_free(port->mgmt_container);
                    port->mgmt_container = decoded;
                    port->mgmt_container_len = decoded_len;
                    containers_updated = true;

                    ogs_info("[TSN-AF] Updated DS-TT port %u container "
                            "(%d bytes)", port->port_number, decoded_len);
                } else {
                    ogs_free(decoded);
                }
            }
        }
    }

    /* NW-TT port management containers */
    tsn_port_man_cont_nwtts = cJSON_GetObjectItemCaseSensitive(
            root, "tsnPortManContNwtts");
    if (tsn_port_man_cont_nwtts && cJSON_IsArray(tsn_port_man_cont_nwtts)) {
        cJSON *nwtt_item = NULL;
        cJSON_ArrayForEach(nwtt_item, tsn_port_man_cont_nwtts) {
            cJSON *b64_item = cJSON_GetObjectItemCaseSensitive(
                    nwtt_item, "portManCont");
            cJSON *port_num_item = cJSON_GetObjectItemCaseSensitive(
                    nwtt_item, "portNum");

            if (b64_item && cJSON_IsString(b64_item) &&
                    b64_item->valuestring &&
                    port_num_item && cJSON_IsNumber(port_num_item)) {
                uint32_t port_num = port_num_item->valueint;
                tsn_af_port_t *port = tsn_af_port_find_by_number(
                        bridge, port_num);

                if (port && port->is_nwtt) {
                    uint8_t *decoded = NULL;
                    int decoded_len;

                    decoded_len = ogs_base64_decode_len(b64_item->valuestring);
                    decoded = ogs_calloc(1, decoded_len);
                    ogs_assert(decoded);

                    decoded_len = ogs_base64_decode_binary(
                            decoded, b64_item->valuestring);
                    if (decoded_len > 0) {
                        if (port->mgmt_container)
                            ogs_free(port->mgmt_container);
                        port->mgmt_container = decoded;
                        port->mgmt_container_len = decoded_len;
                        containers_updated = true;

                        ogs_info("[TSN-AF] Updated NW-TT port %u container "
                                "(%d bytes)", port->port_number, decoded_len);
                    } else {
                        ogs_free(decoded);
                    }
                }
            }
        }
    }

    /* Re-push updated containers to SMF → UPF */
    if (containers_updated) {
        ogs_info("[TSN-AF] Re-pushing updated containers to SMF "
                "for bridge '%s'", bridge->bridge_id);
        tsn_af_nsmf_push_config(bridge);
    }
}

void tsn_af_npcf_handle_policy_notify(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request)
{
    cJSON *root = NULL;
    cJSON *ev_notifs = NULL;
    cJSON *ev_subs_uri = NULL;
    tsn_af_bridge_t *bridge = NULL;

    ogs_assert(stream);
    ogs_assert(request);

    ogs_info("[TSN-AF] Received PCF policy notification");

    if (!request->http.content || request->http.content_length == 0) {
        ogs_warn("[TSN-AF] Empty PCF notification body");
        tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT);
        return;
    }

    root = cJSON_Parse(request->http.content);
    if (!root) {
        ogs_error("[TSN-AF] Failed to parse PCF notification JSON");
        tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_BAD_REQUEST);
        return;
    }

    /* Find the bridge associated with this notification */
    ev_subs_uri = cJSON_GetObjectItemCaseSensitive(root, "evSubsUri");
    if (ev_subs_uri && cJSON_IsString(ev_subs_uri))
        bridge = find_bridge_by_ev_subs_uri(ev_subs_uri->valuestring);

    if (!bridge) {
        /* Fallback: use first bridge with active PCF session */
        ogs_list_for_each(&tsn_af_self()->bridge_list, bridge) {
            if (bridge->pcf_session_created)
                break;
        }
    }

    if (!bridge) {
        ogs_warn("[TSN-AF] No bridge found for PCF notification");
        cJSON_Delete(root);
        tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT);
        return;
    }

    /* Update notification tracking */
    bridge->pcf_notify_state.notification_count++;
    bridge->pcf_notify_state.last_notification_time = ogs_get_monotonic_time();

    /* Process event notifications */
    ev_notifs = cJSON_GetObjectItemCaseSensitive(root, "evNotifs");
    if (ev_notifs && cJSON_IsArray(ev_notifs)) {
        cJSON *notif = NULL;
        cJSON_ArrayForEach(notif, ev_notifs) {
            cJSON *event = cJSON_GetObjectItemCaseSensitive(notif, "event");
            if (!event || !cJSON_IsString(event))
                continue;

            if (!strcmp(event->valuestring, "SUCCESSFUL_RESOURCES_ALLOCATION")) {
                bridge->pcf_notify_state.resources_allocated = true;
                bridge->pcf_notify_state.resources_failed = false;
                ogs_info("[TSN-AF] Bridge '%s': resources allocated",
                        bridge->bridge_id);

            } else if (!strcmp(event->valuestring,
                        "FAILED_RESOURCES_ALLOCATION")) {
                bridge->pcf_notify_state.resources_failed = true;
                bridge->pcf_notify_state.resources_allocated = false;
                ogs_error("[TSN-AF] Bridge '%s': resource allocation failed",
                        bridge->bridge_id);

            } else if (!strcmp(event->valuestring,
                        "SUCCESSFUL_QOS_UPDATE")) {
                tsn_af_stream_reservation_t *rsv_iter = NULL;
                bridge->pcf_notify_state.qos_updated = true;
                bridge->pcf_notify_state.qos_failed = false;
                ogs_info("[TSN-AF] Bridge '%s': QoS updated",
                        bridge->bridge_id);

                /* Mark pending stream reservations as active */
                ogs_list_for_each(
                        &bridge->stream_reservation_list, rsv_iter) {
                    if (rsv_iter->state == TSN_AF_STREAM_STATE_PENDING) {
                        rsv_iter->state = TSN_AF_STREAM_STATE_ACTIVE;
                        ogs_info("[TSN-AF] Stream %u: QoS confirmed active",
                                rsv_iter->stream_id);
                    }
                }

            } else if (!strcmp(event->valuestring, "FAILED_QOS_UPDATE")) {
                tsn_af_stream_reservation_t *rsv_iter = NULL;
                bridge->pcf_notify_state.qos_failed = true;
                bridge->pcf_notify_state.qos_updated = false;
                ogs_error("[TSN-AF] Bridge '%s': QoS update failed",
                        bridge->bridge_id);

                /* Mark pending stream reservations as failed */
                ogs_list_for_each(
                        &bridge->stream_reservation_list, rsv_iter) {
                    if (rsv_iter->state == TSN_AF_STREAM_STATE_PENDING) {
                        rsv_iter->state = TSN_AF_STREAM_STATE_FAILED;
                        ogs_error("[TSN-AF] Stream %u: QoS failed",
                                rsv_iter->stream_id);
                    }
                }

            } else if (!strcmp(event->valuestring, "TSN_BRIDGE_INFO")) {
                ogs_info("[TSN-AF] Bridge '%s': TSN bridge info update",
                        bridge->bridge_id);
                handle_tsn_bridge_info_containers(bridge, root);

            } else {
                ogs_info("[TSN-AF] Bridge '%s': unhandled event '%s'",
                        bridge->bridge_id, event->valuestring);
            }
        }
    } else {
        /*
         * No evNotifs array — check for top-level management containers
         * (some PCF implementations send containers directly)
         */
        handle_tsn_bridge_info_containers(bridge, root);
    }

    cJSON_Delete(root);
    tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT);
}
