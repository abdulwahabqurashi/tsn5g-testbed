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
#include "ntsctsf-handler.h"

static void send_json_response(
        ogs_sbi_stream_t *stream, int status, char *json_str);

/*
 * Ntsctsf_TimeSynchronization service operations
 *
 * POST   /ntsctsf-time-synchronization/v1/subscriptions
 * GET    /ntsctsf-time-synchronization/v1/subscriptions/{id}
 * DELETE /ntsctsf-time-synchronization/v1/subscriptions/{id}
 */
static void handle_subscription_create(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request)
{
    tsn_af_context_t *ctx = tsn_af_self();
    tsn_af_time_sync_t *ts = NULL;
    cJSON *body = NULL;
    cJSON *result = NULL;
    char *json_str = NULL;
    char sub_id[32];

    ogs_assert(stream);
    ogs_assert(request);

    if (!request->http.content || request->http.content_length == 0) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST, NULL,
                "Empty request body", NULL, NULL));
        return;
    }

    body = cJSON_Parse(request->http.content);
    if (!body) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_BAD_REQUEST, NULL,
                "Invalid JSON", NULL, NULL));
        return;
    }

    ts = ogs_calloc(1, sizeof(*ts));
    ogs_assert(ts);

    ogs_snprintf(sub_id, sizeof(sub_id), "tsync-%u", ctx->next_time_sync_id++);
    ts->subscription_id = ogs_strdup(sub_id);

    {
        cJSON *td = cJSON_GetObjectItem(body, "timeDomainNumber");
        if (td && cJSON_IsNumber(td))
            ts->time_domain_number = (uint8_t)td->valuedouble;
    }
    {
        cJSON *offset = cJSON_GetObjectItem(body, "timeOffsetNs");
        if (offset && cJSON_IsNumber(offset))
            ts->time_offset_ns = (uint32_t)offset->valuedouble;
    }
    {
        cJSON *nf_id = cJSON_GetObjectItem(body, "requesterNfId");
        if (nf_id && cJSON_IsString(nf_id))
            ts->requester_nf_id = ogs_strdup(nf_id->valuestring);
    }

    ts->active = true;
    ogs_list_add(&ctx->time_sync_list, ts);

    cJSON_Delete(body);

    ogs_info("[TSCTSF] Time sync subscription '%s' created "
            "(domain=%u, offset=%u ns)",
            ts->subscription_id, ts->time_domain_number,
            ts->time_offset_ns);

    /* Build 201 Created response */
    result = cJSON_CreateObject();
    ogs_assert(result);

    cJSON_AddStringToObject(result, "subscriptionId", ts->subscription_id);
    cJSON_AddNumberToObject(result, "timeDomainNumber",
            ts->time_domain_number);
    cJSON_AddNumberToObject(result, "timeOffsetNs", ts->time_offset_ns);
    cJSON_AddBoolToObject(result, "active", ts->active);
    if (ts->requester_nf_id)
        cJSON_AddStringToObject(result, "requesterNfId",
                ts->requester_nf_id);

    json_str = cJSON_PrintUnformatted(result);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_CREATED, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result);
}

static tsn_af_time_sync_t *find_time_sync(const char *sub_id)
{
    tsn_af_time_sync_t *ts = NULL;

    ogs_list_for_each(&tsn_af_self()->time_sync_list, ts) {
        if (ts->subscription_id &&
            strcmp(ts->subscription_id, sub_id) == 0)
            return ts;
    }

    return NULL;
}

static void handle_subscription_get(
        ogs_sbi_stream_t *stream, const char *sub_id)
{
    tsn_af_time_sync_t *ts = NULL;
    cJSON *result = NULL;
    char *json_str = NULL;

    ogs_assert(stream);
    ogs_assert(sub_id);

    ts = find_time_sync(sub_id);
    if (!ts) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND, NULL,
                "Subscription not found", sub_id, NULL));
        return;
    }

    result = cJSON_CreateObject();
    ogs_assert(result);

    cJSON_AddStringToObject(result, "subscriptionId", ts->subscription_id);
    cJSON_AddNumberToObject(result, "timeDomainNumber",
            ts->time_domain_number);
    cJSON_AddNumberToObject(result, "timeOffsetNs", ts->time_offset_ns);
    cJSON_AddBoolToObject(result, "active", ts->active);
    if (ts->requester_nf_id)
        cJSON_AddStringToObject(result, "requesterNfId",
                ts->requester_nf_id);

    json_str = cJSON_PrintUnformatted(result);
    ogs_assert(json_str);

    send_json_response(stream, OGS_SBI_HTTP_STATUS_OK, json_str);

    cJSON_free(json_str);
    cJSON_Delete(result);
}

static void handle_subscription_delete(
        ogs_sbi_stream_t *stream, const char *sub_id)
{
    tsn_af_time_sync_t *ts = NULL;

    ogs_assert(stream);
    ogs_assert(sub_id);

    ts = find_time_sync(sub_id);
    if (!ts) {
        ogs_assert(true ==
            ogs_sbi_server_send_error(stream,
                OGS_SBI_HTTP_STATUS_NOT_FOUND, NULL,
                "Subscription not found", sub_id, NULL));
        return;
    }

    ogs_info("[TSCTSF] Time sync subscription '%s' deleted", sub_id);

    ogs_list_remove(&tsn_af_self()->time_sync_list, ts);
    if (ts->subscription_id) ogs_free(ts->subscription_id);
    if (ts->requester_nf_id) ogs_free(ts->requester_nf_id);
    ogs_free(ts);

    tsn_af_sbi_send_response(stream, OGS_SBI_HTTP_STATUS_NO_CONTENT);
}

void tsn_af_ntsctsf_handle_request(
        ogs_sbi_stream_t *stream, ogs_sbi_request_t *request,
        ogs_sbi_message_t *recvmsg)
{
    ogs_assert(stream);
    ogs_assert(request);
    ogs_assert(recvmsg);

    /*
     * Route: /ntsctsf-time-synchronization/v1/subscriptions[/{id}]
     *
     * component[0] = "subscriptions"
     * component[1] = subscription_id (optional)
     */
    SWITCH(recvmsg->h.resource.component[0])
    CASE("subscriptions")
        if (!recvmsg->h.resource.component[1]) {
            /* /subscriptions */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_POST)
                handle_subscription_create(stream, request);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        } else {
            /* /subscriptions/{id} */
            SWITCH(recvmsg->h.method)
            CASE(OGS_SBI_HTTP_METHOD_GET)
                handle_subscription_get(stream,
                        recvmsg->h.resource.component[1]);
                break;
            CASE(OGS_SBI_HTTP_METHOD_DELETE)
                handle_subscription_delete(stream,
                        recvmsg->h.resource.component[1]);
                break;
            DEFAULT
                ogs_assert(true ==
                    ogs_sbi_server_send_error(stream,
                        OGS_SBI_HTTP_STATUS_METHOD_NOT_ALLOWED,
                        recvmsg, "Method not allowed",
                        recvmsg->h.method, NULL));
            END
        }
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
