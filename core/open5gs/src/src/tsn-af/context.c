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
#include "bridge-mgmt.h"

static tsn_af_context_t self;
int __tsn_af_log_domain;

static int context_initialized = 0;

void tsn_af_context_init(void)
{
    ogs_assert(context_initialized == 0);

    memset(&self, 0, sizeof(tsn_af_context_t));

    ogs_log_install_domain(&__tsn_af_log_domain, "tsn-af",
            ogs_core()->log.level);

    ogs_list_init(&self.bridge_list);
    self.bridge_hash = ogs_hash_make();
    ogs_assert(self.bridge_hash);

    ogs_list_init(&self.bridge_group_list);
    self.bridge_group_hash = ogs_hash_make();
    ogs_assert(self.bridge_group_hash);

    ogs_list_init(&self.time_sync_list);
    self.next_time_sync_id = 1;

    context_initialized = 1;
}

void tsn_af_context_final(void)
{
    ogs_assert(context_initialized == 1);

    /* Free bridge groups */
    {
        tsn_af_bridge_group_t *grp = NULL, *next_grp = NULL;
        ogs_list_for_each_safe(&self.bridge_group_list, next_grp, grp) {
            tsn_af_bridge_group_remove(grp);
        }
    }

    tsn_af_bridge_remove_all();

    /* Free time sync subscriptions */
    {
        tsn_af_time_sync_t *ts = NULL, *next_ts = NULL;
        ogs_list_for_each_safe(&self.time_sync_list, next_ts, ts) {
            ogs_list_remove(&self.time_sync_list, ts);
            if (ts->subscription_id) ogs_free(ts->subscription_id);
            if (ts->requester_nf_id) ogs_free(ts->requester_nf_id);
            ogs_free(ts);
        }
    }

    ogs_assert(self.bridge_hash);
    ogs_hash_destroy(self.bridge_hash);

    if (self.bridge_group_hash)
        ogs_hash_destroy(self.bridge_group_hash);

    context_initialized = 0;
}

tsn_af_context_t *tsn_af_self(void)
{
    return &self;
}

static int tsn_af_context_prepare(void)
{
    return OGS_OK;
}

static int tsn_af_context_validation(void)
{
    return OGS_OK;
}

int tsn_af_context_parse_config(void)
{
    int rv;
    yaml_document_t *document = NULL;
    ogs_yaml_iter_t root_iter;
    int idx = 0;

    document = ogs_app()->document;
    ogs_assert(document);

    rv = tsn_af_context_prepare();
    if (rv != OGS_OK) return rv;

    ogs_yaml_iter_init(&root_iter, document);
    while (ogs_yaml_iter_next(&root_iter)) {
        const char *root_key = ogs_yaml_iter_key(&root_iter);
        ogs_assert(root_key);
        if ((!strcmp(root_key, "tsn-af")) &&
            (idx++ == ogs_app()->config_section_id)) {
            ogs_yaml_iter_t tsn_af_iter;
            ogs_yaml_iter_recurse(&root_iter, &tsn_af_iter);
            while (ogs_yaml_iter_next(&tsn_af_iter)) {
                const char *tsn_af_key =
                    ogs_yaml_iter_key(&tsn_af_iter);
                ogs_assert(tsn_af_key);
                if (!strcmp(tsn_af_key, "default")) {
                    /* handle config in sbi library */
                } else if (!strcmp(tsn_af_key, "sbi")) {
                    /* handle config in sbi library */
                } else if (!strcmp(tsn_af_key, "nrf")) {
                    /* handle config in sbi library */
                } else if (!strcmp(tsn_af_key, "scp")) {
                    /* handle config in sbi library */
                } else if (!strcmp(tsn_af_key, "service_name")) {
                    /* handle config in sbi library */
                } else if (!strcmp(tsn_af_key, "discovery")) {
                    /* handle config in sbi library */
                } else
                    ogs_warn("unknown key `%s`", tsn_af_key);
            }
        }
    }

    rv = tsn_af_context_validation();
    if (rv != OGS_OK) return rv;

    return OGS_OK;
}

tsn_af_bridge_t *tsn_af_bridge_add(const char *bridge_id)
{
    tsn_af_bridge_t *bridge = NULL;

    ogs_assert(bridge_id);

    bridge = ogs_calloc(1, sizeof(*bridge));
    if (!bridge) {
        ogs_error("ogs_calloc() failed");
        return NULL;
    }

    bridge->bridge_id = ogs_strdup(bridge_id);
    ogs_assert(bridge->bridge_id);

    ogs_list_init(&bridge->port_list);
    ogs_list_init(&bridge->stream_reservation_list);
    bridge->next_filter_instance_id = 1;
    bridge->next_gate_instance_id = 1;

    ogs_hash_set(self.bridge_hash, bridge->bridge_id,
            strlen(bridge->bridge_id), bridge);

    ogs_list_add(&self.bridge_list, bridge);

    ogs_info("[TSN-AF] Bridge '%s' added", bridge_id);

    return bridge;
}

void tsn_af_bridge_remove(tsn_af_bridge_t *bridge)
{
    tsn_af_port_t *port = NULL, *next_port = NULL;

    ogs_assert(bridge);

    /* Destroy Linux bridge and TAP if active */
    if (bridge->linux_bridge_active) {
        tsn_af_linux_bridge_destroy(bridge);
    }

    ogs_list_remove(&self.bridge_list, bridge);

    if (bridge->bridge_id) {
        ogs_hash_set(self.bridge_hash, bridge->bridge_id,
                strlen(bridge->bridge_id), NULL);
        ogs_free(bridge->bridge_id);
    }

    /* Remove all stream reservations */
    {
        tsn_af_stream_reservation_t *rsv = NULL, *next_rsv = NULL;
        ogs_list_for_each_safe(
                &bridge->stream_reservation_list, next_rsv, rsv) {
            ogs_list_remove(&bridge->stream_reservation_list, rsv);
            ogs_free(rsv);
        }
    }

    /* Remove all ports from list, then free each */
    ogs_list_for_each_safe(&bridge->port_list, next_port, port) {
        ogs_list_remove(&bridge->port_list, port);
        tsn_af_port_remove(port);
    }

    ogs_sbi_object_free(&bridge->sbi);

    if (bridge->pcf_app_session_id)
        ogs_free(bridge->pcf_app_session_id);
    if (bridge->mgmt_container)
        ogs_free(bridge->mgmt_container);
    if (bridge->dnn)
        ogs_free(bridge->dnn);
    if (bridge->ue_ipv4_addr)
        ogs_free(bridge->ue_ipv4_addr);
    if (bridge->ue_ipv6_addr_prefix)
        ogs_free(bridge->ue_ipv6_addr_prefix);
    if (bridge->physical_iface)
        ogs_free(bridge->physical_iface);
    if (bridge->upf_tap_name)
        ogs_free(bridge->upf_tap_name);
    if (bridge->group_id)
        ogs_free(bridge->group_id);

    ogs_free(bridge);
}

void tsn_af_bridge_remove_all(void)
{
    tsn_af_bridge_t *bridge = NULL, *next = NULL;

    ogs_list_for_each_safe(&self.bridge_list, next, bridge) {
        tsn_af_bridge_remove(bridge);
    }
}

tsn_af_bridge_t *tsn_af_bridge_find_by_id(const char *bridge_id)
{
    ogs_assert(bridge_id);
    return ogs_hash_get(self.bridge_hash, bridge_id, strlen(bridge_id));
}

tsn_af_port_t *tsn_af_port_add(tsn_af_bridge_t *bridge)
{
    tsn_af_port_t *port = NULL;

    ogs_assert(bridge);

    port = ogs_calloc(1, sizeof(*port));
    if (!port) {
        ogs_error("ogs_calloc() failed");
        return NULL;
    }

    ogs_list_add(&bridge->port_list, port);

    return port;
}

tsn_af_port_t *tsn_af_port_find_by_number(
        tsn_af_bridge_t *bridge, uint32_t port_number)
{
    tsn_af_port_t *port = NULL;

    ogs_assert(bridge);

    ogs_list_for_each(&bridge->port_list, port) {
        if (port->port_number == port_number)
            return port;
    }

    return NULL;
}

void tsn_af_port_remove(tsn_af_port_t *port)
{
    ogs_assert(port);

    /* Note: caller must remove port from bridge->port_list
     * before calling this function (see tsn_af_bridge_remove) */

    if (port->mgmt_container)
        ogs_free(port->mgmt_container);
    if (port->lldp_chassis_id)
        ogs_free(port->lldp_chassis_id);
    if (port->lldp_port_id)
        ogs_free(port->lldp_port_id);
    if (port->pcf_policy_uri)
        ogs_free(port->pcf_policy_uri);

    ogs_free(port);
}

tsn_af_stream_reservation_t *tsn_af_stream_reservation_add(
        tsn_af_bridge_t *bridge, uint32_t stream_id)
{
    tsn_af_stream_reservation_t *reservation = NULL;

    ogs_assert(bridge);

    reservation = ogs_calloc(1, sizeof(*reservation));
    if (!reservation) {
        ogs_error("ogs_calloc() failed");
        return NULL;
    }

    reservation->stream_id = stream_id;
    reservation->priority = -1;
    reservation->state = TSN_AF_STREAM_STATE_PENDING;

    /* Assign auto-incrementing filter and gate instance IDs */
    reservation->filter_instance_id = bridge->next_filter_instance_id++;
    reservation->gate_instance_id = bridge->next_gate_instance_id++;

    ogs_list_add(&bridge->stream_reservation_list, reservation);

    ogs_info("[TSN-AF] Stream reservation %u added to bridge '%s' "
            "(filter=%u, gate=%u)",
            stream_id, bridge->bridge_id,
            reservation->filter_instance_id,
            reservation->gate_instance_id);

    return reservation;
}

void tsn_af_stream_reservation_remove(
        tsn_af_bridge_t *bridge, tsn_af_stream_reservation_t *reservation)
{
    ogs_assert(bridge);
    ogs_assert(reservation);

    ogs_list_remove(&bridge->stream_reservation_list, reservation);

    ogs_info("[TSN-AF] Stream reservation %u removed from bridge '%s'",
            reservation->stream_id, bridge->bridge_id);

    ogs_free(reservation);
}

tsn_af_stream_reservation_t *tsn_af_stream_reservation_find(
        tsn_af_bridge_t *bridge, uint32_t stream_id)
{
    tsn_af_stream_reservation_t *reservation = NULL;

    ogs_assert(bridge);

    ogs_list_for_each(&bridge->stream_reservation_list, reservation) {
        if (reservation->stream_id == stream_id)
            return reservation;
    }

    return NULL;
}

tsn_af_bridge_group_t *tsn_af_bridge_group_add(const char *group_id)
{
    tsn_af_bridge_group_t *group = NULL;

    ogs_assert(group_id);

    group = ogs_calloc(1, sizeof(*group));
    if (!group) return NULL;

    group->group_id = ogs_strdup(group_id);
    ogs_assert(group->group_id);

    ogs_list_init(&group->member_list);
    group->health_check_interval_ms = 5000;
    group->failover_threshold = 3;

    ogs_hash_set(self.bridge_group_hash, group->group_id,
            strlen(group->group_id), group);
    ogs_list_add(&self.bridge_group_list, group);

    ogs_info("[TSN-AF] Bridge group '%s' added", group_id);

    return group;
}

void tsn_af_bridge_group_remove(tsn_af_bridge_group_t *group)
{
    tsn_af_bridge_group_member_t *member = NULL, *next = NULL;

    ogs_assert(group);

    /* Stop health timer */
    if (group->health_timer) {
        ogs_timer_delete(group->health_timer);
        group->health_timer = NULL;
    }

    /* Remove all members */
    ogs_list_for_each_safe(&group->member_list, next, member) {
        ogs_list_remove(&group->member_list, member);
        if (member->bridge_id)
            ogs_free(member->bridge_id);
        ogs_free(member);
    }

    ogs_list_remove(&self.bridge_group_list, group);

    if (group->group_id) {
        ogs_hash_set(self.bridge_group_hash, group->group_id,
                strlen(group->group_id), NULL);
        ogs_free(group->group_id);
    }
    if (group->active_bridge_id)
        ogs_free(group->active_bridge_id);

    ogs_free(group);
}

tsn_af_bridge_group_t *tsn_af_bridge_group_find_by_id(const char *group_id)
{
    ogs_assert(group_id);
    return ogs_hash_get(self.bridge_group_hash,
            group_id, strlen(group_id));
}

tsn_af_bridge_group_member_t *tsn_af_bridge_group_add_member(
        tsn_af_bridge_group_t *group, const char *bridge_id,
        tsn_af_bridge_role_e role, uint32_t priority)
{
    tsn_af_bridge_group_member_t *member = NULL;
    tsn_af_bridge_t *bridge = NULL;

    ogs_assert(group);
    ogs_assert(bridge_id);

    member = ogs_calloc(1, sizeof(*member));
    if (!member) return NULL;

    member->bridge_id = ogs_strdup(bridge_id);
    ogs_assert(member->bridge_id);
    member->role = role;
    member->priority = priority;
    member->health = TSN_AF_BRIDGE_HEALTH_UNKNOWN;

    ogs_list_add(&group->member_list, member);

    /* Update the bridge's group reference */
    bridge = tsn_af_bridge_find_by_id(bridge_id);
    if (bridge) {
        if (bridge->group_id)
            ogs_free(bridge->group_id);
        bridge->group_id = ogs_strdup(group->group_id);
        bridge->role = role;
    }

    /* If this is the first primary, set as active */
    if (role == TSN_AF_BRIDGE_ROLE_PRIMARY && !group->active_bridge_id) {
        group->active_bridge_id = ogs_strdup(bridge_id);
    }

    ogs_info("[TSN-AF] Bridge '%s' added to group '%s' "
            "(role=%s priority=%u)",
            bridge_id, group->group_id,
            role == TSN_AF_BRIDGE_ROLE_PRIMARY ? "primary" :
            role == TSN_AF_BRIDGE_ROLE_BACKUP ? "backup" : "standalone",
            priority);

    return member;
}

void tsn_af_bridge_group_remove_member(
        tsn_af_bridge_group_t *group, tsn_af_bridge_group_member_t *member)
{
    tsn_af_bridge_t *bridge = NULL;

    ogs_assert(group);
    ogs_assert(member);

    /* Clear bridge's group reference */
    bridge = tsn_af_bridge_find_by_id(member->bridge_id);
    if (bridge) {
        if (bridge->group_id) {
            ogs_free(bridge->group_id);
            bridge->group_id = NULL;
        }
        bridge->role = TSN_AF_BRIDGE_ROLE_STANDALONE;
    }

    ogs_list_remove(&group->member_list, member);

    if (member->bridge_id)
        ogs_free(member->bridge_id);
    ogs_free(member);
}

tsn_af_bridge_group_member_t *tsn_af_bridge_group_find_member(
        tsn_af_bridge_group_t *group, const char *bridge_id)
{
    tsn_af_bridge_group_member_t *member = NULL;

    ogs_assert(group);
    ogs_assert(bridge_id);

    ogs_list_for_each(&group->member_list, member) {
        if (!strcmp(member->bridge_id, bridge_id))
            return member;
    }

    return NULL;
}
