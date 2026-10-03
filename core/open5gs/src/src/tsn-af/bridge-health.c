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

#include "bridge-health.h"
#include "nsmf-handler.h"
#include "npcf-build.h"
#include "sbi-path.h"

#include <stdio.h>
#include <string.h>

/*
 * Check Linux bridge interface operstate via sysfs.
 * Returns true if interface is "up".
 */
static bool check_linux_bridge_operstate(tsn_af_bridge_t *bridge)
{
    char path[256];
    FILE *fp;
    char state[32];

    if (!bridge->linux_bridge_active)
        return false;

    if (bridge->linux_bridge_name[0] == '\0')
        return false;

    ogs_snprintf(path, sizeof(path),
            "/sys/class/net/%s/operstate", bridge->linux_bridge_name);

    fp = fopen(path, "r");
    if (!fp)
        return false;

    memset(state, 0, sizeof(state));
    if (fgets(state, sizeof(state), fp)) {
        /* Remove trailing newline */
        char *nl = strchr(state, '\n');
        if (nl) *nl = '\0';
    }
    fclose(fp);

    return (!strcmp(state, "up") || !strcmp(state, "unknown"));
}

tsn_af_bridge_health_e tsn_af_bridge_check_health(tsn_af_bridge_t *bridge)
{
    bool pcf_ok = false;
    bool iface_ok = false;

    ogs_assert(bridge);

    /* Check 1: PCF AppSession exists */
    pcf_ok = bridge->pcf_session_created;

    /* Check 2: Linux bridge interface is up */
    if (bridge->linux_bridge_active)
        iface_ok = check_linux_bridge_operstate(bridge);
    else
        iface_ok = true;  /* No Linux bridge = not applicable */

    /* Determine health */
    if (pcf_ok && iface_ok) {
        bridge->health = TSN_AF_BRIDGE_HEALTH_UP;
    } else if (pcf_ok || iface_ok) {
        bridge->health = TSN_AF_BRIDGE_HEALTH_DEGRADED;
    } else {
        bridge->health = TSN_AF_BRIDGE_HEALTH_DOWN;
    }

    return bridge->health;
}

/*
 * Select the best backup bridge for failover.
 * Returns the member with lowest priority and HEALTH_UP.
 */
static tsn_af_bridge_group_member_t *select_failover_target(
        tsn_af_bridge_group_t *group)
{
    tsn_af_bridge_group_member_t *member = NULL;
    tsn_af_bridge_group_member_t *best = NULL;

    ogs_list_for_each(&group->member_list, member) {
        if (member->role == TSN_AF_BRIDGE_ROLE_BACKUP &&
                member->health == TSN_AF_BRIDGE_HEALTH_UP) {
            if (!best || member->priority < best->priority)
                best = member;
        }
    }

    return best;
}

/*
 * Copy stream reservations from one bridge to another.
 */
static void migrate_stream_reservations(
        tsn_af_bridge_t *from, tsn_af_bridge_t *to)
{
    tsn_af_stream_reservation_t *rsv = NULL;

    ogs_assert(from);
    ogs_assert(to);

    ogs_list_for_each(&from->stream_reservation_list, rsv) {
        tsn_af_stream_reservation_t *new_rsv = NULL;

        if (rsv->state != TSN_AF_STREAM_STATE_ACTIVE)
            continue;

        new_rsv = tsn_af_stream_reservation_add(to, rsv->stream_id);
        if (!new_rsv) continue;

        memcpy(new_rsv->dest_mac, rsv->dest_mac, 6);
        new_rsv->vlan_id = rsv->vlan_id;
        new_rsv->priority = rsv->priority;
        new_rsv->max_frame_size = rsv->max_frame_size;
        new_rsv->interval_us = rsv->interval_us;
        new_rsv->max_latency_us = rsv->max_latency_us;
        new_rsv->bandwidth_bps = rsv->bandwidth_bps;
        new_rsv->assigned_5qi = rsv->assigned_5qi;
        new_rsv->assigned_pcp = rsv->assigned_pcp;
        new_rsv->gbr_bps = rsv->gbr_bps;
        new_rsv->mbr_bps = rsv->mbr_bps;
        new_rsv->state = TSN_AF_STREAM_STATE_ACTIVE;

        ogs_info("[TSN-AF] Migrated stream %u from bridge '%s' to '%s'",
                rsv->stream_id, from->bridge_id, to->bridge_id);
    }
}

int tsn_af_bridge_failover(tsn_af_bridge_group_t *group)
{
    tsn_af_bridge_group_member_t *target = NULL;
    tsn_af_bridge_group_member_t *old_primary = NULL;
    tsn_af_bridge_t *old_bridge = NULL;
    tsn_af_bridge_t *new_bridge = NULL;

    ogs_assert(group);

    target = select_failover_target(group);
    if (!target) {
        ogs_error("[TSN-AF] No healthy backup available for group '%s'",
                group->group_id);
        return OGS_ERROR;
    }

    new_bridge = tsn_af_bridge_find_by_id(target->bridge_id);
    if (!new_bridge) {
        ogs_error("[TSN-AF] Failover target bridge '%s' not found",
                target->bridge_id);
        return OGS_ERROR;
    }

    ogs_warn("[TSN-AF] FAILOVER: group '%s' switching from '%s' to '%s'",
            group->group_id,
            group->active_bridge_id ? group->active_bridge_id : "(none)",
            target->bridge_id);

    /* Find and demote old primary */
    if (group->active_bridge_id) {
        old_primary = tsn_af_bridge_group_find_member(
                group, group->active_bridge_id);
        old_bridge = tsn_af_bridge_find_by_id(group->active_bridge_id);

        if (old_primary) {
            old_primary->role = TSN_AF_BRIDGE_ROLE_BACKUP;
            if (old_bridge)
                old_bridge->role = TSN_AF_BRIDGE_ROLE_BACKUP;
        }
    }

    /* Migrate stream reservations */
    if (old_bridge)
        migrate_stream_reservations(old_bridge, new_bridge);

    /* Copy management containers if the new bridge doesn't have them */
    if (old_bridge &&
            old_bridge->mgmt_container && old_bridge->mgmt_container_len > 0 &&
            (!new_bridge->mgmt_container || new_bridge->mgmt_container_len == 0)) {
        new_bridge->mgmt_container =
            ogs_calloc(1, old_bridge->mgmt_container_len);
        if (new_bridge->mgmt_container) {
            memcpy(new_bridge->mgmt_container,
                    old_bridge->mgmt_container,
                    old_bridge->mgmt_container_len);
            new_bridge->mgmt_container_len = old_bridge->mgmt_container_len;
        }
    }

    /* Promote target to primary */
    target->role = TSN_AF_BRIDGE_ROLE_PRIMARY;
    new_bridge->role = TSN_AF_BRIDGE_ROLE_PRIMARY;

    /* Update active bridge */
    if (group->active_bridge_id)
        ogs_free(group->active_bridge_id);
    group->active_bridge_id = ogs_strdup(target->bridge_id);

    /* Push config to PCF for the new primary */
    if (new_bridge->pcf_session_created && new_bridge->pcf_app_session_id) {
        tsn_af_sbi_discover_and_send(
            OGS_SBI_SERVICE_TYPE_NPCF_POLICYAUTHORIZATION,
            NULL,
            tsn_af_npcf_build_bridge_mgmt_update,
            new_bridge, NULL,
            TSN_AF_NPCF_STATE_UPDATE, NULL);
    }

    /* Push config to SMF */
    tsn_af_nsmf_push_config(new_bridge);

    ogs_warn("[TSN-AF] FAILOVER complete: group '%s' active='%s'",
            group->group_id, group->active_bridge_id);

    return OGS_OK;
}

void tsn_af_bridge_health_check(void *data)
{
    tsn_af_bridge_group_t *group = (tsn_af_bridge_group_t *)data;
    tsn_af_bridge_group_member_t *member = NULL;
    bool active_is_down = false;

    ogs_assert(group);

    ogs_list_for_each(&group->member_list, member) {
        tsn_af_bridge_t *bridge = NULL;
        tsn_af_bridge_health_e health;

        bridge = tsn_af_bridge_find_by_id(member->bridge_id);
        if (!bridge) {
            member->health = TSN_AF_BRIDGE_HEALTH_DOWN;
            member->consecutive_failures++;
            continue;
        }

        health = tsn_af_bridge_check_health(bridge);
        member->last_health_check = ogs_get_monotonic_time();

        if (health == TSN_AF_BRIDGE_HEALTH_UP) {
            member->consecutive_failures = 0;
            member->health = TSN_AF_BRIDGE_HEALTH_UP;
        } else if (health == TSN_AF_BRIDGE_HEALTH_DEGRADED) {
            member->consecutive_failures++;
            member->health = TSN_AF_BRIDGE_HEALTH_DEGRADED;
        } else {
            member->consecutive_failures++;
            member->health = TSN_AF_BRIDGE_HEALTH_DOWN;
        }

        /* Check if active bridge has failed */
        if (group->active_bridge_id &&
                !strcmp(member->bridge_id, group->active_bridge_id) &&
                member->health == TSN_AF_BRIDGE_HEALTH_DOWN &&
                member->consecutive_failures >= group->failover_threshold) {
            active_is_down = true;
        }
    }

    /* Trigger failover if active bridge is down */
    if (active_is_down) {
        ogs_warn("[TSN-AF] Active bridge '%s' is DOWN in group '%s' "
                "(triggering failover)",
                group->active_bridge_id, group->group_id);
        tsn_af_bridge_failover(group);
    }

    /* Restart health timer */
    if (group->health_timer) {
        ogs_timer_start(group->health_timer,
                ogs_time_from_msec(group->health_check_interval_ms));
    }
}

void tsn_af_bridge_health_start(tsn_af_bridge_group_t *group)
{
    ogs_assert(group);

    if (group->health_timer) {
        ogs_timer_delete(group->health_timer);
        group->health_timer = NULL;
    }

    group->health_timer = ogs_timer_add(ogs_app()->timer_mgr,
            tsn_af_bridge_health_check, group);
    ogs_assert(group->health_timer);

    ogs_timer_start(group->health_timer,
            ogs_time_from_msec(group->health_check_interval_ms));

    ogs_info("[TSN-AF] Health monitoring started for group '%s' "
            "(interval=%u ms, threshold=%u)",
            group->group_id,
            group->health_check_interval_ms,
            group->failover_threshold);
}

void tsn_af_bridge_health_stop(tsn_af_bridge_group_t *group)
{
    ogs_assert(group);

    if (group->health_timer) {
        ogs_timer_delete(group->health_timer);
        group->health_timer = NULL;
    }

    ogs_info("[TSN-AF] Health monitoring stopped for group '%s'",
            group->group_id);
}
