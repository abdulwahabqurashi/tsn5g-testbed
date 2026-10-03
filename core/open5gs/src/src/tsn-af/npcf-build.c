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

#include "npcf-build.h"
#include "qos-select.h"

static char *base64_encode_container(uint8_t *data, uint16_t len)
{
    char *b64 = NULL;
    int b64_len;

    if (!data || len == 0)
        return NULL;

    b64_len = ogs_base64_encode_len(len);
    b64 = ogs_calloc(1, b64_len);
    ogs_assert(b64);
    ogs_base64_encode_binary(b64, data, len);

    return b64;
}

ogs_sbi_request_t *tsn_af_npcf_build_create(
        tsn_af_bridge_t *bridge, void *data)
{
    ogs_sbi_message_t message;
    ogs_sbi_request_t *request = NULL;

    OpenAPI_app_session_context_t app_session;
    OpenAPI_app_session_context_req_data_t asc_req_data;
    OpenAPI_bridge_management_container_t bridge_man_cont;
    OpenAPI_port_management_container_t dstt_port_cont;
    OpenAPI_list_t *nwtt_list = NULL;
    tsn_af_port_t *port = NULL;
    char *b64 = NULL;
    bool has_dstt = false;

    ogs_assert(bridge);

    memset(&message, 0, sizeof(message));
    message.h.method = (char *)OGS_SBI_HTTP_METHOD_POST;
    message.h.service.name =
        (char *)OGS_SBI_SERVICE_NAME_NPCF_POLICYAUTHORIZATION;
    message.h.api.version = (char *)OGS_SBI_API_V1;
    message.h.resource.component[0] = (char *)"app-sessions";

    memset(&app_session, 0, sizeof(app_session));
    memset(&asc_req_data, 0, sizeof(asc_req_data));
    memset(&bridge_man_cont, 0, sizeof(bridge_man_cont));
    memset(&dstt_port_cont, 0, sizeof(dstt_port_cont));

    /* Set DNN if available */
    if (bridge->dnn)
        asc_req_data.dnn = bridge->dnn;

    /* Set notification URI from our SBI address */
    {
        ogs_sbi_server_t *server = NULL;

        server = ogs_list_first(&ogs_sbi_self()->server_list);
        if (server) {
            char buf[OGS_ADDRSTRLEN];
            ogs_sockaddr_t *addr = server->node.addr;

            if (addr) {
                asc_req_data.notif_uri = ogs_msprintf(
                        "http://%s:%d/tsn-af/v1/pcf-notify",
                        OGS_ADDR(addr, buf), OGS_PORT(addr));
            }
        }
    }

    /* Bridge management container (base64-encoded) */
    if (bridge->mgmt_container && bridge->mgmt_container_len > 0) {
        b64 = base64_encode_container(
                bridge->mgmt_container, bridge->mgmt_container_len);
        if (b64) {
            bridge_man_cont.bridge_man_cont = b64;
            asc_req_data.tsn_bridge_man_cont = &bridge_man_cont;
        }
    }

    /* NW-TT port management containers */
    nwtt_list = OpenAPI_list_create();
    ogs_assert(nwtt_list);

    ogs_list_for_each(&bridge->port_list, port) {
        if (port->is_nwtt) {
            if (port->mgmt_container && port->mgmt_container_len > 0) {
                char *port_b64 = base64_encode_container(
                        port->mgmt_container, port->mgmt_container_len);
                if (port_b64) {
                    OpenAPI_port_management_container_t *pmc =
                        OpenAPI_port_management_container_create(
                                port_b64, (int)port->port_number);
                    ogs_assert(pmc);
                    OpenAPI_list_add(nwtt_list, pmc);
                }
            }
        } else {
            /* DS-TT port */
            if (port->mgmt_container && port->mgmt_container_len > 0) {
                char *dstt_b64 = base64_encode_container(
                        port->mgmt_container, port->mgmt_container_len);
                if (dstt_b64) {
                    dstt_port_cont.port_man_cont = dstt_b64;
                    dstt_port_cont.port_num = (int)port->port_number;
                    asc_req_data.tsn_port_man_cont_dstt = &dstt_port_cont;
                    has_dstt = true;
                }
            }
        }
    }

    if (nwtt_list->count > 0)
        asc_req_data.tsn_port_man_cont_nwtts = nwtt_list;

    /* Subscribe to PCF events for TSN bridge management */
    {
        OpenAPI_events_subsc_req_data_t ev_subsc;
        OpenAPI_list_t *events = NULL;

        memset(&ev_subsc, 0, sizeof(ev_subsc));

        events = OpenAPI_list_create();
        ogs_assert(events);

        /* SUCCESSFUL_RESOURCES_ALLOCATION */
        {
            OpenAPI_af_event_subscription_t *sub =
                OpenAPI_af_event_subscription_create(
                    OpenAPI_npcf_af_event_SUCCESSFUL_RESOURCES_ALLOCATION,
                    0, false, 0, false, 0);
            ogs_assert(sub);
            OpenAPI_list_add(events, sub);
        }
        /* FAILED_RESOURCES_ALLOCATION */
        {
            OpenAPI_af_event_subscription_t *sub =
                OpenAPI_af_event_subscription_create(
                    OpenAPI_npcf_af_event_FAILED_RESOURCES_ALLOCATION,
                    0, false, 0, false, 0);
            ogs_assert(sub);
            OpenAPI_list_add(events, sub);
        }
        /* SUCCESSFUL_QOS_UPDATE */
        {
            OpenAPI_af_event_subscription_t *sub =
                OpenAPI_af_event_subscription_create(
                    OpenAPI_npcf_af_event_SUCCESSFUL_QOS_UPDATE,
                    0, false, 0, false, 0);
            ogs_assert(sub);
            OpenAPI_list_add(events, sub);
        }
        /* FAILED_QOS_UPDATE */
        {
            OpenAPI_af_event_subscription_t *sub =
                OpenAPI_af_event_subscription_create(
                    OpenAPI_npcf_af_event_FAILED_QOS_UPDATE,
                    0, false, 0, false, 0);
            ogs_assert(sub);
            OpenAPI_list_add(events, sub);
        }
        /* TSN_BRIDGE_INFO */
        {
            OpenAPI_af_event_subscription_t *sub =
                OpenAPI_af_event_subscription_create(
                    OpenAPI_npcf_af_event_TSN_BRIDGE_INFO,
                    0, false, 0, false, 0);
            ogs_assert(sub);
            OpenAPI_list_add(events, sub);
        }

        ev_subsc.events = events;
        ev_subsc.notif_uri = asc_req_data.notif_uri;
        asc_req_data.ev_subsc = &ev_subsc;

        app_session.asc_req_data = &asc_req_data;
        message.AppSessionContext = &app_session;

        request = ogs_sbi_build_request(&message);

        /* Free event subscription items */
        {
            OpenAPI_lnode_t *ev_node = NULL;
            OpenAPI_list_for_each(events, ev_node) {
                OpenAPI_af_event_subscription_free(ev_node->data);
            }
        }
        OpenAPI_list_free(events);
        asc_req_data.ev_subsc = NULL;
    }

    /* Cleanup */
    if (b64)
        ogs_free(b64);
    if (asc_req_data.notif_uri)
        ogs_free(asc_req_data.notif_uri);

    /* Free NW-TT list items */
    {
        OpenAPI_lnode_t *node = NULL;
        OpenAPI_list_for_each(nwtt_list, node) {
            OpenAPI_port_management_container_t *pmc = node->data;
            if (pmc) {
                if (pmc->port_man_cont)
                    ogs_free(pmc->port_man_cont);
                ogs_free(pmc);
            }
        }
    }
    OpenAPI_list_free(nwtt_list);

    if (has_dstt && dstt_port_cont.port_man_cont)
        ogs_free(dstt_port_cont.port_man_cont);

    return request;
}

ogs_sbi_request_t *tsn_af_npcf_build_port_mgmt_update(
        tsn_af_bridge_t *bridge, void *data)
{
    tsn_af_port_t *port = (tsn_af_port_t *)data;
    ogs_sbi_message_t message;
    ogs_sbi_request_t *request = NULL;

    OpenAPI_app_session_context_update_data_patch_t patch;
    OpenAPI_app_session_context_update_data_t update_data;
    OpenAPI_port_management_container_t port_cont;
    OpenAPI_list_t *nwtt_list = NULL;
    char *port_b64 = NULL;

    ogs_assert(bridge);
    ogs_assert(port);

    memset(&message, 0, sizeof(message));
    message.h.method = (char *)OGS_SBI_HTTP_METHOD_PATCH;
    message.h.service.name =
        (char *)OGS_SBI_SERVICE_NAME_NPCF_POLICYAUTHORIZATION;
    message.h.api.version = (char *)OGS_SBI_API_V1;
    message.h.resource.component[0] = (char *)"app-sessions";
    message.h.resource.component[1] = bridge->pcf_app_session_id;

    memset(&patch, 0, sizeof(patch));
    memset(&update_data, 0, sizeof(update_data));
    memset(&port_cont, 0, sizeof(port_cont));

    /* Base64-encode port management container */
    if (port->mgmt_container && port->mgmt_container_len > 0) {
        port_b64 = base64_encode_container(
                port->mgmt_container, port->mgmt_container_len);
        if (port_b64) {
            port_cont.port_man_cont = port_b64;
            port_cont.port_num = (int)port->port_number;

            if (port->is_nwtt) {
                nwtt_list = OpenAPI_list_create();
                ogs_assert(nwtt_list);
                OpenAPI_list_add(nwtt_list, &port_cont);
                update_data.tsn_port_man_cont_nwtts = nwtt_list;
            } else {
                update_data.tsn_port_man_cont_dstt = &port_cont;
            }
        }
    }

    patch.asc_req_data = &update_data;
    message.AppSessionContextUpdateDataPatch = &patch;

    request = ogs_sbi_build_request(&message);

    /* Cleanup */
    if (port_b64)
        ogs_free(port_b64);
    if (nwtt_list)
        OpenAPI_list_free(nwtt_list);

    return request;
}

ogs_sbi_request_t *tsn_af_npcf_build_bridge_mgmt_update(
        tsn_af_bridge_t *bridge, void *data)
{
    ogs_sbi_message_t message;
    ogs_sbi_request_t *request = NULL;

    OpenAPI_app_session_context_update_data_patch_t patch;
    OpenAPI_app_session_context_update_data_t update_data;
    OpenAPI_bridge_management_container_t bridge_man_cont;
    char *b64 = NULL;

    ogs_assert(bridge);

    memset(&message, 0, sizeof(message));
    message.h.method = (char *)OGS_SBI_HTTP_METHOD_PATCH;
    message.h.service.name =
        (char *)OGS_SBI_SERVICE_NAME_NPCF_POLICYAUTHORIZATION;
    message.h.api.version = (char *)OGS_SBI_API_V1;
    message.h.resource.component[0] = (char *)"app-sessions";
    message.h.resource.component[1] = bridge->pcf_app_session_id;

    memset(&patch, 0, sizeof(patch));
    memset(&update_data, 0, sizeof(update_data));
    memset(&bridge_man_cont, 0, sizeof(bridge_man_cont));

    /* Base64-encode bridge management container */
    if (bridge->mgmt_container && bridge->mgmt_container_len > 0) {
        b64 = base64_encode_container(
                bridge->mgmt_container, bridge->mgmt_container_len);
        if (b64) {
            bridge_man_cont.bridge_man_cont = b64;
            update_data.tsn_bridge_man_cont = &bridge_man_cont;
        }
    }

    patch.asc_req_data = &update_data;
    message.AppSessionContextUpdateDataPatch = &patch;

    request = ogs_sbi_build_request(&message);

    if (b64)
        ogs_free(b64);

    return request;
}

ogs_sbi_request_t *tsn_af_npcf_build_qos_update(
        tsn_af_bridge_t *bridge, void *data)
{
    tsn_af_stream_reservation_t *rsv = (tsn_af_stream_reservation_t *)data;
    ogs_sbi_message_t message;
    ogs_sbi_request_t *request = NULL;

    OpenAPI_app_session_context_update_data_patch_t patch;
    OpenAPI_app_session_context_update_data_t update_data;
    OpenAPI_media_component_t *med_comp = NULL;
    OpenAPI_list_t *med_comp_list = NULL;
    OpenAPI_map_t *med_comp_map = NULL;
    OpenAPI_tsn_qos_container_t *tsn_qos = NULL;
    OpenAPI_tscai_input_container_t *tscai_dl = NULL;
    char *mar_bw_dl = NULL, *mar_bw_ul = NULL;
    char med_comp_key[8];

    ogs_assert(bridge);
    ogs_assert(rsv);

    if (!bridge->pcf_app_session_id) {
        ogs_error("[TSN-AF] No AppSession for QoS update");
        return NULL;
    }

    memset(&message, 0, sizeof(message));
    message.h.method = (char *)OGS_SBI_HTTP_METHOD_PATCH;
    message.h.service.name =
        (char *)OGS_SBI_SERVICE_NAME_NPCF_POLICYAUTHORIZATION;
    message.h.api.version = (char *)OGS_SBI_API_V1;
    message.h.resource.component[0] = (char *)"app-sessions";
    message.h.resource.component[1] = bridge->pcf_app_session_id;

    memset(&patch, 0, sizeof(patch));
    memset(&update_data, 0, sizeof(update_data));

    /* TSN QoS Container */
    tsn_qos = OpenAPI_tsn_qos_container_create(
            rsv->max_frame_size > 0,    /* is_max_tsc_burst_size */
            (int)rsv->max_frame_size,   /* max_tsc_burst_size (bytes) */
            rsv->max_latency_us > 0,    /* is_tsc_pack_delay */
            (int)rsv->max_latency_us,   /* tsc_pack_delay (microseconds) */
            rsv->priority >= 0,         /* is_tsc_prio_level */
            (int)rsv->priority          /* tsc_prio_level */
    );
    ogs_assert(tsn_qos);

    /* TSCAI Input Container (DL) */
    if (rsv->interval_us > 0) {
        tscai_dl = OpenAPI_tscai_input_container_create(
                true,                   /* is_periodicity */
                (int)rsv->interval_us,  /* periodicity (microseconds) */
                NULL,                   /* burst_arrival_time */
                false, 0,               /* sur_time_in_num_msg */
                false, 0                /* sur_time_in_time */
        );
        ogs_assert(tscai_dl);
    }

    /* Bandwidth strings: "N bps" format */
    if (rsv->mbr_bps > 0) {
        mar_bw_dl = ogs_msprintf("%llu bps",
                (unsigned long long)rsv->mbr_bps);
        mar_bw_ul = ogs_msprintf("%llu bps",
                (unsigned long long)rsv->mbr_bps);
    }

    /* Build MediaComponent */
    ogs_snprintf(med_comp_key, sizeof(med_comp_key), "%u",
            rsv->stream_id);

    med_comp = OpenAPI_media_component_create(
            NULL,           /* af_app_id */
            NULL,           /* af_rout_req */
            NULL,           /* qos_reference */
            false, 0,       /* dis_ue_notif */
            NULL,           /* alt_ser_reqs */
            NULL,           /* alt_ser_reqs_data */
            false, 0,       /* cont_ver */
            NULL,           /* codecs */
            false, 0.0,     /* des_max_latency */
            false, 0.0,     /* des_max_loss */
            NULL,           /* flus_id */
            0,              /* f_status */
            mar_bw_dl,      /* mar_bw_dl */
            mar_bw_ul,      /* mar_bw_ul */
            false, false, 0,    /* max_packet_loss_rate_dl */
            false, false, 0,    /* max_packet_loss_rate_ul */
            NULL,           /* max_supp_bw_dl */
            NULL,           /* max_supp_bw_ul */
            (int)rsv->stream_id,    /* med_comp_n */
            NULL,           /* med_sub_comps */
            0,              /* med_type */
            NULL,           /* min_des_bw_dl */
            NULL,           /* min_des_bw_ul */
            NULL,           /* mir_bw_dl */
            NULL,           /* mir_bw_ul */
            0,              /* preempt_cap */
            0,              /* preempt_vuln */
            0,              /* prio_sharing_ind */
            0,              /* res_prio */
            NULL,           /* rr_bw */
            NULL,           /* rs_bw */
            false, 0,       /* sharing_key_dl */
            false, 0,       /* sharing_key_ul */
            tsn_qos,        /* tsn_qos */
            false,          /* is_tscai_input_dl_null */
            tscai_dl,       /* tscai_input_dl */
            false,          /* is_tscai_input_ul_null */
            NULL,           /* tscai_input_ul */
            false, 0        /* tscai_time_dom */
    );
    ogs_assert(med_comp);

    /* Wrap in map list: key=stream_id, value=MediaComponent */
    med_comp_list = OpenAPI_list_create();
    ogs_assert(med_comp_list);

    med_comp_map = OpenAPI_map_create(
            ogs_strdup(med_comp_key), med_comp);
    ogs_assert(med_comp_map);
    OpenAPI_list_add(med_comp_list, med_comp_map);

    update_data.med_components = med_comp_list;

    patch.asc_req_data = &update_data;
    message.AppSessionContextUpdateDataPatch = &patch;

    request = ogs_sbi_build_request(&message);

    ogs_info("[TSN-AF] Built QoS update for stream %u: "
            "5QI=%u GBR=%llu MBR=%llu bps",
            rsv->stream_id, rsv->assigned_5qi,
            (unsigned long long)rsv->gbr_bps,
            (unsigned long long)rsv->mbr_bps);

    /* Cleanup */
    if (med_comp_map) {
        if (med_comp_map->key)
            ogs_free(med_comp_map->key);
        ogs_free(med_comp_map);
    }
    OpenAPI_media_component_free(med_comp);
    OpenAPI_list_free(med_comp_list);

    return request;
}
