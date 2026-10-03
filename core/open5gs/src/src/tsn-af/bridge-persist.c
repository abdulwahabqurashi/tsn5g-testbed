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

/*
 * Bridge configuration persistence.
 *
 * TSN-AF bridge state is otherwise in-memory only, so a restart loses
 * every CNC-created bridge while the kernel objects (bridge, TAPs) live
 * on. The CNC handlers call tsn_af_bridge_persist_save() after each
 * mutation; tsn_af_bridge_persist_restore() re-creates the bridges at
 * startup (bridge-mgmt adopts kernel devices that already exist).
 *
 * Only the bridge-level configuration is persisted. Ports and their
 * QoS/GCL/PSFP containers are runtime state driven by PDU sessions and
 * the CNC, and are re-established through those paths.
 */

#include <sys/stat.h>

#include "context.h"
#include "bridge-mgmt.h"
#include "bridge-persist.h"

#define TSN_AF_STATE_DIR    "/var/lib/open5gs"
#define TSN_AF_STATE_FILE   TSN_AF_STATE_DIR "/tsn-af-bridges.json"
#define TSN_AF_STATE_TMP    TSN_AF_STATE_FILE ".tmp"

static void format_mac(const uint8_t *mac, char *buf, size_t len)
{
    ogs_snprintf(buf, len, "%02x:%02x:%02x:%02x:%02x:%02x",
            mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

static bool parse_mac(const char *str, uint8_t *mac)
{
    return sscanf(str, "%2hhx:%2hhx:%2hhx:%2hhx:%2hhx:%2hhx",
            &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) == 6;
}

void tsn_af_bridge_persist_save(void)
{
    tsn_af_bridge_t *bridge = NULL;
    cJSON *root = NULL;
    char *text = NULL;
    FILE *fp = NULL;

    root = cJSON_CreateArray();
    ogs_assert(root);

    ogs_list_for_each(&tsn_af_self()->bridge_list, bridge) {
        char mac_str[18];
        cJSON *item = cJSON_CreateObject();
        ogs_assert(item);

        cJSON_AddStringToObject(item, "bridgeId", bridge->bridge_id);
        format_mac(bridge->bridge_mac, mac_str, sizeof(mac_str));
        cJSON_AddStringToObject(item, "bridgeMac", mac_str);
        if (bridge->dnn)
            cJSON_AddStringToObject(item, "dnn", bridge->dnn);
        if (bridge->physical_iface)
            cJSON_AddStringToObject(item,
                    "physicalInterface", bridge->physical_iface);
        if (bridge->upf_tap_name)
            cJSON_AddStringToObject(item,
                    "upfTapDevice", bridge->upf_tap_name);

        cJSON_AddItemToArray(root, item);
    }

    text = cJSON_Print(root);
    cJSON_Delete(root);
    if (!text) {
        ogs_error("[TSN-AF] persist: cJSON_Print() failed");
        return;
    }

    if (mkdir(TSN_AF_STATE_DIR, 0755) != 0 && errno != EEXIST)
        ogs_warn("[TSN-AF] persist: mkdir(%s) failed", TSN_AF_STATE_DIR);

    fp = fopen(TSN_AF_STATE_TMP, "w");
    if (!fp) {
        ogs_error("[TSN-AF] persist: cannot write %s", TSN_AF_STATE_TMP);
        ogs_free(text);
        return;
    }
    fputs(text, fp);
    fclose(fp);
    ogs_free(text);

    if (rename(TSN_AF_STATE_TMP, TSN_AF_STATE_FILE) != 0)
        ogs_error("[TSN-AF] persist: rename to %s failed",
                TSN_AF_STATE_FILE);
    else
        ogs_debug("[TSN-AF] persist: saved bridge state to %s",
                TSN_AF_STATE_FILE);
}

static void restore_one(cJSON *item)
{
    tsn_af_bridge_t *bridge = NULL;
    cJSON *j = NULL;
    const char *bridge_id = NULL;

    j = cJSON_GetObjectItem(item, "bridgeId");
    if (!j || !cJSON_IsString(j))
        return;
    bridge_id = j->valuestring;

    if (tsn_af_bridge_find_by_id(bridge_id)) {
        ogs_warn("[TSN-AF] persist: bridge '%s' already exists, skipping",
                bridge_id);
        return;
    }

    bridge = tsn_af_bridge_add(bridge_id);
    if (!bridge) {
        ogs_error("[TSN-AF] persist: failed to add bridge '%s'", bridge_id);
        return;
    }

    j = cJSON_GetObjectItem(item, "bridgeMac");
    if (j && cJSON_IsString(j))
        parse_mac(j->valuestring, bridge->bridge_mac);

    j = cJSON_GetObjectItem(item, "dnn");
    if (j && cJSON_IsString(j))
        bridge->dnn = ogs_strdup(j->valuestring);

    if (tsn_af_linux_bridge_create(bridge) != OGS_OK) {
        ogs_warn("[TSN-AF] persist: Linux bridge creation failed for '%s'",
                bridge_id);
        return;
    }

    tsn_af_linux_tap_create(bridge);

    j = cJSON_GetObjectItem(item, "physicalInterface");
    if (j && cJSON_IsString(j) && strlen(j->valuestring) > 0) {
        bridge->physical_iface = ogs_strdup(j->valuestring);
        if (tsn_af_linux_bridge_attach_iface(
                bridge->linux_bridge_name, j->valuestring) != OGS_OK)
            ogs_warn("[TSN-AF] persist: failed to attach '%s'",
                    j->valuestring);
    }

    j = cJSON_GetObjectItem(item, "upfTapDevice");
    if (j && cJSON_IsString(j) && strlen(j->valuestring) > 0) {
        bridge->upf_tap_name = ogs_strdup(j->valuestring);
        tsn_af_linux_set_iface_up(j->valuestring);
        if (tsn_af_linux_bridge_attach_iface(
                bridge->linux_bridge_name, j->valuestring) != OGS_OK)
            ogs_warn("[TSN-AF] persist: failed to attach UPF TAP '%s'",
                    j->valuestring);
    }

    ogs_info("[TSN-AF] persist: restored bridge '%s' (%s%s%s)",
            bridge_id,
            bridge->physical_iface ? bridge->physical_iface : "-",
            bridge->upf_tap_name ? " + " : "",
            bridge->upf_tap_name ? bridge->upf_tap_name : "");
}

void tsn_af_bridge_persist_restore(void)
{
    FILE *fp = NULL;
    long size = 0;
    char *buf = NULL;
    cJSON *root = NULL, *item = NULL;
    int count = 0;

    fp = fopen(TSN_AF_STATE_FILE, "r");
    if (!fp)
        return; /* nothing persisted yet */

    fseek(fp, 0, SEEK_END);
    size = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (size <= 0 || size > 1024 * 1024) {
        fclose(fp);
        ogs_warn("[TSN-AF] persist: invalid state file size %ld", size);
        return;
    }

    buf = ogs_malloc(size + 1);
    ogs_assert(buf);
    if (fread(buf, 1, size, fp) != (size_t)size) {
        fclose(fp);
        ogs_free(buf);
        ogs_error("[TSN-AF] persist: short read on %s", TSN_AF_STATE_FILE);
        return;
    }
    fclose(fp);
    buf[size] = '\0';

    root = cJSON_Parse(buf);
    ogs_free(buf);
    if (!root || !cJSON_IsArray(root)) {
        if (root) cJSON_Delete(root);
        ogs_error("[TSN-AF] persist: cannot parse %s", TSN_AF_STATE_FILE);
        return;
    }

    cJSON_ArrayForEach(item, root) {
        restore_one(item);
        count++;
    }
    cJSON_Delete(root);

    if (count)
        ogs_info("[TSN-AF] persist: processed %d bridge(s) from %s",
                count, TSN_AF_STATE_FILE);
}
