/*
 * Copyright (C) 2019 by Sukchan Lee <acetcom@gmail.com>
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
#include "n4-build.h"
#include "nwtt.h"

ogs_pkbuf_t *upf_n4_build_session_establishment_response(uint8_t type,
    upf_sess_t *sess, ogs_pfcp_pdr_t *created_pdr[], int num_of_created_pdr)
{
    ogs_pfcp_message_t *pfcp_message = NULL;
    ogs_pfcp_session_establishment_response_t *rsp = NULL;
    ogs_pkbuf_t *pkbuf = NULL;

    int i = 0, j = 0;

    ogs_pfcp_node_id_t node_id;
    ogs_pfcp_f_seid_t f_seid;
    int len = 0;
    uint8_t ds_tt_port_buf[4];
    uint8_t user_plane_node_buf[8]; /* flags(1) + bridge_mac(6) + pad */

    ogs_debug("Session Establishment Response");

    pfcp_message = ogs_calloc(1, sizeof(*pfcp_message));
    if (!pfcp_message) {
        ogs_error("ogs_calloc() failed");
        return NULL;
    }

    rsp = &pfcp_message->pfcp_session_establishment_response;

    /* Node ID */
    ogs_pfcp_sockaddr_to_node_id(&node_id, &len);
    rsp->node_id.presence = 1;
    rsp->node_id.data = &node_id;
    rsp->node_id.len = len;

    /* Cause */
    rsp->cause.presence = 1;
    rsp->cause.u8 = OGS_PFCP_CAUSE_REQUEST_ACCEPTED;

    /* F-SEID */
    ogs_pfcp_sockaddr_to_f_seid(&f_seid, &len);
    f_seid.seid = htobe64(sess->upf_n4_seid);
    rsp->up_f_seid.presence = 1;
    rsp->up_f_seid.data = &f_seid;
    rsp->up_f_seid.len = len;

    ogs_pfcp_pdrbuf_init();

    /* Created PDR */
    for (i = 0, j = 0; i < num_of_created_pdr; i++) {
        bool pdr_presence = ogs_pfcp_build_created_pdr(
                &rsp->created_pdr[j], i, created_pdr[i]);
        if (pdr_presence == true) j++;
    }

    /* Created Bridge Info for TSC */
    if (sess->tsc.is_tsn && sess->tsc.nwtt_port) {
        /* DS-TT Port Number sub-IE */
        memset(ds_tt_port_buf, 0, sizeof(ds_tt_port_buf));
        ds_tt_port_buf[0] = sess->tsc.ds_tt_port_number;
        rsp->created_bridge_info_for_tsc.ds_tt_port_number.presence = 1;
        rsp->created_bridge_info_for_tsc.ds_tt_port_number.data =
            ds_tt_port_buf;
        rsp->created_bridge_info_for_tsc.ds_tt_port_number.len = 4;

        /* 5GS User Plane Node sub-IE (bridge MAC address) */
        memset(user_plane_node_buf, 0, sizeof(user_plane_node_buf));
        user_plane_node_buf[0] = 0x01; /* flags: MAC address present */
        memcpy(&user_plane_node_buf[1],
                upf_self()->nwtt_bridge.bridge_mac, 6);
        rsp->created_bridge_info_for_tsc.fivegs_user_plane_node.presence = 1;
        rsp->created_bridge_info_for_tsc.fivegs_user_plane_node.data =
            user_plane_node_buf;
        rsp->created_bridge_info_for_tsc.fivegs_user_plane_node.len = 7;

        rsp->created_bridge_info_for_tsc.presence = 1;

        /* Log NW-TT port stats in PFCP response */
        if (sess->tsc.nwtt_port)
            upf_nwtt_port_log_stats(sess->tsc.nwtt_port);
    }

    pfcp_message->h.type = type;
    pkbuf = ogs_pfcp_build_msg(pfcp_message);
    ogs_expect(pkbuf);

    ogs_pfcp_pdrbuf_clear();
    ogs_free(pfcp_message);

    return pkbuf;
}

ogs_pkbuf_t *upf_n4_build_session_modification_response(uint8_t type,
    upf_sess_t *sess, ogs_pfcp_pdr_t *created_pdr[], int num_of_created_pdr)
{
    ogs_pfcp_message_t *pfcp_message = NULL;
    ogs_pfcp_session_modification_response_t *rsp = NULL;
    ogs_pkbuf_t *pkbuf = NULL;

    int i = 0, j = 0;

    ogs_debug("Session Modification Response");

    pfcp_message = ogs_calloc(1, sizeof(*pfcp_message));
    if (!pfcp_message) {
        ogs_error("ogs_calloc() failed");
        return NULL;
    }

    rsp = &pfcp_message->pfcp_session_modification_response;

    /* Cause */
    rsp->cause.presence = 1;
    rsp->cause.u8 = OGS_PFCP_CAUSE_REQUEST_ACCEPTED;

    ogs_pfcp_pdrbuf_init();

    /* Created PDR */
    for (i = 0, j = 0; i < num_of_created_pdr; i++) {
        bool pdr_presence = ogs_pfcp_build_created_pdr(
                &rsp->created_pdr[j], i, created_pdr[i]);
        if (pdr_presence == true) j++;
    }

    /* Include TSC Management Information in response for TSN sessions */
    if (sess->tsc.is_tsn && sess->tsc.nwtt_port) {
        upf_nwtt_port_t *port = sess->tsc.nwtt_port;
        upf_nwtt_bridge_t *bridge = &upf_self()->nwtt_bridge;

        /* Port management container */
        if (port->port_mgmt_container && port->port_mgmt_container_len > 0) {
            rsp->tsc_management_information.presence = 1;
            rsp->tsc_management_information.
                port_management_information_container.presence = 1;
            rsp->tsc_management_information.
                port_management_information_container.data =
                    port->port_mgmt_container;
            rsp->tsc_management_information.
                port_management_information_container.len =
                    port->port_mgmt_container_len;
        }

        /* Bridge management container */
        if (bridge->bridge_mgmt_container &&
                bridge->bridge_mgmt_container_len > 0) {
            rsp->tsc_management_information.presence = 1;
            rsp->tsc_management_information.
                user_plane_node_management_information_container.presence = 1;
            rsp->tsc_management_information.
                user_plane_node_management_information_container.data =
                    bridge->bridge_mgmt_container;
            rsp->tsc_management_information.
                user_plane_node_management_information_container.len =
                    bridge->bridge_mgmt_container_len;
        }

        /* NW-TT port number */
        if (rsp->tsc_management_information.presence) {
            uint32_t port_num_be = htobe32(port->port_number);
            rsp->tsc_management_information.nw_tt_port_number.presence = 1;
            rsp->tsc_management_information.nw_tt_port_number.data =
                &port_num_be;
            rsp->tsc_management_information.nw_tt_port_number.len = 4;
        }
    }

    pfcp_message->h.type = type;
    pkbuf = ogs_pfcp_build_msg(pfcp_message);
    ogs_expect(pkbuf);

    ogs_pfcp_pdrbuf_clear();
    ogs_free(pfcp_message);

    return pkbuf;
}

ogs_pkbuf_t *upf_n4_build_session_deletion_response(uint8_t type,
        upf_sess_t *sess)
{
    ogs_pfcp_urr_t *urr = NULL;
    ogs_pfcp_user_plane_report_t report;
    size_t num_of_reports = 0;
    ogs_debug("Session Deletion Response");

    /* Log final NW-TT stats before session teardown */
    if (sess->tsc.is_tsn && sess->tsc.nwtt_port)
        upf_nwtt_port_log_stats(sess->tsc.nwtt_port);

    memset(&report, 0, sizeof(report));
    ogs_list_for_each(&sess->pfcp.urr_list, urr) {
        ogs_assert(num_of_reports < OGS_ARRAY_SIZE(report.usage_report));
        upf_sess_urr_acc_fill_usage_report(sess, urr, &report, num_of_reports);
        report.usage_report[num_of_reports].rep_trigger.termination_report = 1;
        num_of_reports++;
        upf_sess_urr_acc_snapshot(sess, urr);
    }
    report.num_of_usage_report = num_of_reports;

    return ogs_pfcp_build_session_deletion_response(type, OGS_PFCP_CAUSE_REQUEST_ACCEPTED,
                                                    &report);
}
