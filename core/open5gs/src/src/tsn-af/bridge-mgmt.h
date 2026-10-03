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

#ifndef TSN_AF_BRIDGE_MGMT_H
#define TSN_AF_BRIDGE_MGMT_H

#include "context.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Linux bridge lifecycle */
int tsn_af_linux_bridge_create(tsn_af_bridge_t *bridge);
int tsn_af_linux_bridge_destroy(tsn_af_bridge_t *bridge);

/* TAP device lifecycle */
int tsn_af_linux_tap_create(tsn_af_bridge_t *bridge);
void tsn_af_linux_tap_destroy(tsn_af_bridge_t *bridge);

/* Attach/detach physical NIC to/from bridge */
int tsn_af_linux_bridge_attach_iface(
        const char *bridge_name, const char *ifname);
int tsn_af_linux_bridge_detach_iface(
        const char *bridge_name, const char *ifname);

/* Set interface up */
int tsn_af_linux_set_iface_up(const char *ifname);

/* List physical network interfaces (returns cJSON array) */
cJSON *tsn_af_linux_list_interfaces(void);

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_BRIDGE_MGMT_H */
