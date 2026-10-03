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

#include "bridge-mgmt.h"
#include "ogs-tun.h"

#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <linux/sockios.h>
#include <unistd.h>
#include <dirent.h>

#ifndef SIOCBRADDBR
#define SIOCBRADDBR 0x89a0
#endif
#ifndef SIOCBRDELBR
#define SIOCBRDELBR 0x89a1
#endif
#ifndef SIOCBRADDIF
#define SIOCBRADDIF 0x89a2
#endif
#ifndef SIOCBRDELIF
#define SIOCBRDELIF 0x89a3
#endif

int tsn_af_linux_set_iface_up(const char *ifname)
{
    int fd;
    struct ifreq ifr;

    ogs_assert(ifname);

    fd = socket(AF_LOCAL, SOCK_STREAM, 0);
    if (fd < 0) {
        ogs_error("socket() failed for set_iface_up");
        return OGS_ERROR;
    }

    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);

    if (ioctl(fd, SIOCGIFFLAGS, &ifr) < 0) {
        ogs_error("ioctl(SIOCGIFFLAGS) failed for %s", ifname);
        close(fd);
        return OGS_ERROR;
    }

    ifr.ifr_flags |= IFF_UP | IFF_RUNNING;

    if (ioctl(fd, SIOCSIFFLAGS, &ifr) < 0) {
        ogs_error("ioctl(SIOCSIFFLAGS) failed for %s", ifname);
        close(fd);
        return OGS_ERROR;
    }

    close(fd);
    ogs_info("[TSN-AF] Interface '%s' set UP", ifname);
    return OGS_OK;
}

int tsn_af_linux_bridge_create(tsn_af_bridge_t *bridge)
{
    int fd, rv;

    ogs_assert(bridge);
    ogs_assert(bridge->bridge_id);

    /* Name: "tsn-br-<bridge_id>" (truncated to IFNAMSIZ) */
    ogs_snprintf(bridge->linux_bridge_name,
            sizeof(bridge->linux_bridge_name),
            "tsn-br-%s", bridge->bridge_id);

    fd = socket(AF_LOCAL, SOCK_STREAM, 0);
    if (fd < 0) {
        ogs_error("socket() failed for bridge_create");
        return OGS_ERROR;
    }

    rv = ioctl(fd, SIOCBRADDBR, bridge->linux_bridge_name);
    close(fd);

    if (rv < 0 && errno == EEXIST) {
        /* Stale bridge from a previous run (TSN-AF state is in-memory
         * only): adopt it and re-attach interfaces below. */
        ogs_warn("[TSN-AF] Linux bridge '%s' already exists - adopting",
                bridge->linux_bridge_name);
    } else if (rv < 0) {
        ogs_error("ioctl(SIOCBRADDBR) failed for '%s'",
                bridge->linux_bridge_name);
        return OGS_ERROR;
    }

    /* Bring bridge up */
    tsn_af_linux_set_iface_up(bridge->linux_bridge_name);
    bridge->linux_bridge_active = true;

    /* Forward 802.1 link-local multicast (LLDP 01-80-C2-00-00-0E and
     * gPTP peer-delay) across the bridge: group_fwd_mask bit 14. */
    {
        char path[128];
        FILE *fp;
        ogs_snprintf(path, sizeof(path),
                "/sys/class/net/%s/bridge/group_fwd_mask",
                bridge->linux_bridge_name);
        fp = fopen(path, "w");
        if (fp) {
            fputs("0x4000", fp);
            fclose(fp);
            ogs_info("[TSN-AF] group_fwd_mask=0x4000 on '%s' "
                    "(LLDP/gPTP forwarding)", bridge->linux_bridge_name);
        } else {
            ogs_warn("[TSN-AF] cannot set group_fwd_mask on '%s'",
                    bridge->linux_bridge_name);
        }
    }

    ogs_info("[TSN-AF] Linux bridge '%s' created",
            bridge->linux_bridge_name);

    return OGS_OK;
}

int tsn_af_linux_bridge_destroy(tsn_af_bridge_t *bridge)
{
    int fd, rv;

    ogs_assert(bridge);

    if (!bridge->linux_bridge_active)
        return OGS_OK;

    /* Destroy TAP first if it exists */
    tsn_af_linux_tap_destroy(bridge);

    /* Detach physical interface if attached */
    if (bridge->physical_iface) {
        tsn_af_linux_bridge_detach_iface(
                bridge->linux_bridge_name, bridge->physical_iface);
    }

    /* Detach UPF TAP device if attached */
    if (bridge->upf_tap_name) {
        tsn_af_linux_bridge_detach_iface(
                bridge->linux_bridge_name, bridge->upf_tap_name);
    }

    fd = socket(AF_LOCAL, SOCK_STREAM, 0);
    if (fd < 0) {
        ogs_error("socket() failed for bridge_destroy");
        return OGS_ERROR;
    }

    rv = ioctl(fd, SIOCBRDELBR, bridge->linux_bridge_name);
    close(fd);

    if (rv < 0) {
        ogs_error("ioctl(SIOCBRDELBR) failed for '%s'",
                bridge->linux_bridge_name);
        return OGS_ERROR;
    }

    bridge->linux_bridge_active = false;

    ogs_info("[TSN-AF] Linux bridge '%s' destroyed",
            bridge->linux_bridge_name);

    return OGS_OK;
}

int tsn_af_linux_tap_create(tsn_af_bridge_t *bridge)
{
    ogs_assert(bridge);
    ogs_assert(bridge->bridge_id);

    /* Name: "tsn-tap-<bridge_id>" */
    ogs_snprintf(bridge->tap_name, sizeof(bridge->tap_name),
            "tsn-tap-%s", bridge->bridge_id);

    bridge->tap_fd = ogs_tun_open(
            bridge->tap_name, sizeof(bridge->tap_name), 1 /* is_tap */);
    if (bridge->tap_fd == INVALID_SOCKET) {
        ogs_error("[TSN-AF] Failed to create TAP '%s'", bridge->tap_name);
        return OGS_ERROR;
    }

    /* Bring TAP up and attach to bridge */
    tsn_af_linux_set_iface_up(bridge->tap_name);
    tsn_af_linux_bridge_attach_iface(
            bridge->linux_bridge_name, bridge->tap_name);

    ogs_info("[TSN-AF] TAP '%s' created and attached to '%s'",
            bridge->tap_name, bridge->linux_bridge_name);

    return OGS_OK;
}

void tsn_af_linux_tap_destroy(tsn_af_bridge_t *bridge)
{
    ogs_assert(bridge);

    if (bridge->tap_fd != INVALID_SOCKET && bridge->tap_fd != 0) {
        /* Detach from bridge first */
        if (bridge->linux_bridge_active && strlen(bridge->tap_name) > 0) {
            tsn_af_linux_bridge_detach_iface(
                    bridge->linux_bridge_name, bridge->tap_name);
        }

        close(bridge->tap_fd);
        bridge->tap_fd = INVALID_SOCKET;

        ogs_info("[TSN-AF] TAP '%s' destroyed", bridge->tap_name);
    }
}

int tsn_af_linux_bridge_attach_iface(
        const char *bridge_name, const char *ifname)
{
    int fd;
    struct ifreq ifr;
    int rv;

    ogs_assert(bridge_name);
    ogs_assert(ifname);

    fd = socket(AF_LOCAL, SOCK_STREAM, 0);
    if (fd < 0) {
        ogs_error("socket() failed for bridge_attach_iface");
        return OGS_ERROR;
    }

    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, bridge_name, IFNAMSIZ - 1);
    ifr.ifr_ifindex = if_nametoindex(ifname);
    if (ifr.ifr_ifindex == 0) {
        ogs_error("if_nametoindex() failed for '%s'", ifname);
        close(fd);
        return OGS_ERROR;
    }

    rv = ioctl(fd, SIOCBRADDIF, &ifr);
    close(fd);

    if (rv < 0) {
        ogs_error("ioctl(SIOCBRADDIF) failed: attach '%s' to '%s'",
                ifname, bridge_name);
        return OGS_ERROR;
    }

    ogs_info("[TSN-AF] Attached '%s' to bridge '%s'", ifname, bridge_name);
    return OGS_OK;
}

int tsn_af_linux_bridge_detach_iface(
        const char *bridge_name, const char *ifname)
{
    int fd;
    struct ifreq ifr;
    int rv;

    ogs_assert(bridge_name);
    ogs_assert(ifname);

    fd = socket(AF_LOCAL, SOCK_STREAM, 0);
    if (fd < 0) {
        ogs_error("socket() failed for bridge_detach_iface");
        return OGS_ERROR;
    }

    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, bridge_name, IFNAMSIZ - 1);
    ifr.ifr_ifindex = if_nametoindex(ifname);
    if (ifr.ifr_ifindex == 0) {
        close(fd);
        return OGS_ERROR;
    }

    rv = ioctl(fd, SIOCBRDELIF, &ifr);
    close(fd);

    if (rv < 0) {
        ogs_error("ioctl(SIOCBRDELIF) failed: detach '%s' from '%s'",
                ifname, bridge_name);
        return OGS_ERROR;
    }

    ogs_info("[TSN-AF] Detached '%s' from bridge '%s'", ifname, bridge_name);
    return OGS_OK;
}

cJSON *tsn_af_linux_list_interfaces(void)
{
    cJSON *ifaces_arr = NULL;
    DIR *dir = NULL;
    struct dirent *entry = NULL;

    ifaces_arr = cJSON_CreateArray();
    ogs_assert(ifaces_arr);

    dir = opendir("/sys/class/net");
    if (!dir) {
        ogs_error("opendir(/sys/class/net) failed");
        return ifaces_arr;
    }

    while ((entry = readdir(dir)) != NULL) {
        char path_buf[256];
        char read_buf[128];
        cJSON *iface_json = NULL;
        FILE *fp = NULL;
        struct stat st;

        /* Skip . and .. */
        if (entry->d_name[0] == '.')
            continue;

        /* Skip loopback */
        if (!strcmp(entry->d_name, "lo"))
            continue;

        /* Skip virtual interfaces by prefix */
        if (!strncmp(entry->d_name, "docker", 6))
            continue;
        if (!strncmp(entry->d_name, "veth", 4))
            continue;
        if (!strncmp(entry->d_name, "br-", 3))
            continue;
        if (!strncmp(entry->d_name, "ogstun", 6))
            continue;
        if (!strncmp(entry->d_name, "tsn-", 4))
            continue;

        /* Check if physical: /sys/class/net/<name>/device must exist */
        ogs_snprintf(path_buf, sizeof(path_buf),
                "/sys/class/net/%s/device", entry->d_name);
        if (lstat(path_buf, &st) < 0)
            continue;

        iface_json = cJSON_CreateObject();
        ogs_assert(iface_json);

        cJSON_AddStringToObject(iface_json, "name", entry->d_name);

        /* Read MAC address */
        ogs_snprintf(path_buf, sizeof(path_buf),
                "/sys/class/net/%s/address", entry->d_name);
        fp = fopen(path_buf, "r");
        if (fp) {
            memset(read_buf, 0, sizeof(read_buf));
            if (fgets(read_buf, sizeof(read_buf), fp)) {
                /* Trim trailing newline */
                size_t len = strlen(read_buf);
                if (len > 0 && read_buf[len - 1] == '\n')
                    read_buf[len - 1] = '\0';
                cJSON_AddStringToObject(iface_json, "mac", read_buf);
            }
            fclose(fp);
        }

        /* Read operational state */
        ogs_snprintf(path_buf, sizeof(path_buf),
                "/sys/class/net/%s/operstate", entry->d_name);
        fp = fopen(path_buf, "r");
        if (fp) {
            memset(read_buf, 0, sizeof(read_buf));
            if (fgets(read_buf, sizeof(read_buf), fp)) {
                size_t len = strlen(read_buf);
                if (len > 0 && read_buf[len - 1] == '\n')
                    read_buf[len - 1] = '\0';
                cJSON_AddStringToObject(iface_json, "status", read_buf);
            }
            fclose(fp);
        }

        /* Read link speed (may fail if link is down) */
        ogs_snprintf(path_buf, sizeof(path_buf),
                "/sys/class/net/%s/speed", entry->d_name);
        fp = fopen(path_buf, "r");
        if (fp) {
            memset(read_buf, 0, sizeof(read_buf));
            if (fgets(read_buf, sizeof(read_buf), fp)) {
                int speed = atoi(read_buf);
                if (speed > 0)
                    cJSON_AddNumberToObject(iface_json, "speed", speed);
            }
            fclose(fp);
        }

        cJSON_AddItemToArray(ifaces_arr, iface_json);
    }

    closedir(dir);
    return ifaces_arr;
}
