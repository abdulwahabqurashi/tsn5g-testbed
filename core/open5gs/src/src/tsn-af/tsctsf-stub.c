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

#include "tsctsf-stub.h"
#include "sbi-path.h"
#include "npcf-build.h"
#include "ts24519.h"

int tsn_af_tsctsf_configure_time_domain(
        tsn_af_bridge_t *bridge,
        uint8_t time_domain_number,
        uint32_t time_offset_ns)
{
    ts24519_time_domain_t td;
    uint8_t *encoded = NULL;
    uint16_t encoded_len = 0;

    ogs_assert(bridge);

    memset(&td, 0, sizeof(td));
    td.time_domain_number = time_domain_number;
    td.time_offset_ns = time_offset_ns;

    encoded = ts24519_encode_time_domain(&td, &encoded_len);
    if (!encoded) {
        ogs_error("[TSN-AF] Failed to encode time domain config");
        return OGS_ERROR;
    }

    /*
     * Store as bridge management container to be sent via
     * Npcf_PolicyAuthorization -> SMF -> PFCP TSC Management Info.
     */
    if (bridge->mgmt_container)
        ogs_free(bridge->mgmt_container);
    bridge->mgmt_container = encoded;
    bridge->mgmt_container_len = encoded_len;

    ogs_info("[TSN-AF] Time domain %d configured for bridge '%s' "
            "(offset=%u ns)",
            time_domain_number, bridge->bridge_id, time_offset_ns);

    return OGS_OK;
}

int tsn_af_tsctsf_send_port_config(
        tsn_af_bridge_t *bridge,
        tsn_af_port_t *port)
{
    int rv;

    ogs_assert(bridge);
    ogs_assert(port);

    if (!port->mgmt_container || port->mgmt_container_len == 0) {
        ogs_warn("[TSN-AF] No management container for port %u on bridge '%s'",
                port->port_number, bridge->bridge_id);
        return OGS_ERROR;
    }

    if (!bridge->pcf_session_created) {
        /* First time: create AppSession at PCF */
        ogs_info("[TSN-AF] Creating PCF AppSession for bridge '%s' "
                "(triggered by port %u config)",
                bridge->bridge_id, port->port_number);

        rv = tsn_af_sbi_discover_and_send(
                OGS_SBI_SERVICE_TYPE_NPCF_POLICYAUTHORIZATION,
                NULL,
                tsn_af_npcf_build_create,
                bridge, NULL,
                TSN_AF_NPCF_STATE_CREATE, NULL);
    } else {
        /* AppSession exists: send update with port container */
        ogs_info("[TSN-AF] Updating PCF AppSession for bridge '%s' "
                "(port %u config, %u bytes)",
                bridge->bridge_id, port->port_number,
                port->mgmt_container_len);

        rv = tsn_af_sbi_discover_and_send(
                OGS_SBI_SERVICE_TYPE_NPCF_POLICYAUTHORIZATION,
                NULL,
                tsn_af_npcf_build_port_mgmt_update,
                bridge, NULL,
                TSN_AF_NPCF_STATE_UPDATE, port);
    }

    return rv;
}

int tsn_af_tsctsf_send_bridge_config(
        tsn_af_bridge_t *bridge)
{
    int rv;

    ogs_assert(bridge);

    if (!bridge->mgmt_container || bridge->mgmt_container_len == 0) {
        ogs_warn("[TSN-AF] No management container for bridge '%s'",
                bridge->bridge_id);
        return OGS_ERROR;
    }

    if (!bridge->pcf_session_created) {
        /* First time: create AppSession at PCF */
        ogs_info("[TSN-AF] Creating PCF AppSession for bridge '%s' "
                "(triggered by bridge config)",
                bridge->bridge_id);

        rv = tsn_af_sbi_discover_and_send(
                OGS_SBI_SERVICE_TYPE_NPCF_POLICYAUTHORIZATION,
                NULL,
                tsn_af_npcf_build_create,
                bridge, NULL,
                TSN_AF_NPCF_STATE_CREATE, NULL);
    } else {
        /* AppSession exists: send update with bridge container */
        ogs_info("[TSN-AF] Updating PCF AppSession for bridge '%s' "
                "(bridge config, %u bytes)",
                bridge->bridge_id, bridge->mgmt_container_len);

        rv = tsn_af_sbi_discover_and_send(
                OGS_SBI_SERVICE_TYPE_NPCF_POLICYAUTHORIZATION,
                NULL,
                tsn_af_npcf_build_bridge_mgmt_update,
                bridge, NULL,
                TSN_AF_NPCF_STATE_UPDATE, NULL);
    }

    return rv;
}
