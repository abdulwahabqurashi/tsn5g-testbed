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

#include "nsmf-handler.h"
#include "ts24519.h"

/*
 * Push TSN management containers from TSN-AF to SMF.
 *
 * The SMF exposes: POST /nsmf-tsn/v1/bridges/{bridge_mac}/config
 *
 * Body JSON:
 * {
 *   "portMgmtContainer": "<base64>",    // TS 24.519 port mgmt container
 *   "bridgeMgmtContainer": "<base64>"   // TS 24.519 bridge mgmt container
 * }
 *
 * The SMF will then issue a PFCP Session Modification to the UPF
 * with TSC Management Information IE to apply the config.
 */

static int nsmf_client_cb(
        int status, ogs_sbi_response_t *response, void *data)
{
    if (status != OGS_OK) {
        ogs_warn("[TSN-AF] nSMF config push failed (status=%d)", status);
        return OGS_ERROR;
    }

    if (response) {
        ogs_info("[TSN-AF] nSMF config push response: %d",
                response->status);
        ogs_sbi_response_free(response);
    }

    return OGS_OK;
}

int tsn_af_nsmf_push_config(tsn_af_bridge_t *bridge)
{
    ogs_sbi_request_t *request = NULL;
    ogs_sbi_client_t *client = NULL;
    ogs_sbi_nf_instance_t *nf_instance = NULL;
    cJSON *body = NULL;
    char *body_str = NULL;
    char mac_str[18];
    char uri[256];

    ogs_assert(bridge);

    /* Build bridge MAC string for URL */
    ogs_snprintf(mac_str, sizeof(mac_str),
            "%02x:%02x:%02x:%02x:%02x:%02x",
            bridge->bridge_mac[0], bridge->bridge_mac[1],
            bridge->bridge_mac[2], bridge->bridge_mac[3],
            bridge->bridge_mac[4], bridge->bridge_mac[5]);

    /* Build JSON body */
    body = cJSON_CreateObject();
    ogs_assert(body);

    /* Encode port management container (from first NW-TT port) */
    {
        tsn_af_port_t *port = NULL;
        ogs_list_for_each(&bridge->port_list, port) {
            if (port->is_nwtt && port->mgmt_container &&
                    port->mgmt_container_len > 0) {
                char *b64 = NULL;
                int b64_len;

                b64_len = ogs_base64_encode_len(port->mgmt_container_len);
                b64 = ogs_calloc(1, b64_len);
                ogs_assert(b64);

                ogs_base64_encode_binary(b64,
                        port->mgmt_container, port->mgmt_container_len);
                cJSON_AddStringToObject(body, "portMgmtContainer", b64);
                ogs_free(b64);
                break; /* first NW-TT port */
            }
        }
    }

    /* Encode bridge management container */
    if (bridge->mgmt_container && bridge->mgmt_container_len > 0) {
        char *b64 = NULL;
        int b64_len;

        b64_len = ogs_base64_encode_len(bridge->mgmt_container_len);
        b64 = ogs_calloc(1, b64_len);
        ogs_assert(b64);

        ogs_base64_encode_binary(b64,
                bridge->mgmt_container, bridge->mgmt_container_len);
        cJSON_AddStringToObject(body, "bridgeMgmtContainer", b64);
        ogs_free(b64);
    }

    body_str = cJSON_PrintUnformatted(body);
    ogs_assert(body_str);
    cJSON_Delete(body);

    /* Build SBI request */
    request = ogs_sbi_request_new();
    ogs_assert(request);

    request->h.method = (char *)OGS_SBI_HTTP_METHOD_POST;

    ogs_snprintf(uri, sizeof(uri),
            "/nsmf-tsn/v1/bridges/%s/config", mac_str);
    request->h.uri = ogs_strdup(uri);
    ogs_assert(request->h.uri);

    request->http.content = body_str;
    request->http.content_length = strlen(body_str);
    ogs_sbi_header_set(request->http.headers,
            OGS_SBI_CONTENT_TYPE, OGS_SBI_CONTENT_JSON_TYPE);

    /*
     * Find SMF NF instance via NRF-discovered NF instance list.
     * Use the first available SMF NF instance with a client.
     */
    ogs_list_for_each(
            &ogs_sbi_self()->nf_instance_list, nf_instance) {
        if (nf_instance->nf_type == OpenAPI_nf_type_SMF &&
                nf_instance->client) {
            client = nf_instance->client;
            break;
        }
    }

    if (!client) {
        ogs_warn("[TSN-AF] No SMF SBI client available for config push");
        ogs_sbi_request_free(request);
        return OGS_ERROR;
    }

    ogs_info("[TSN-AF] Pushing config to SMF for bridge '%s' (MAC %s)",
            bridge->bridge_id, mac_str);

    ogs_sbi_client_send_request(client, nsmf_client_cb, request, NULL);

    return OGS_OK;
}
