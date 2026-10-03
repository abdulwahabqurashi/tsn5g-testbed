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

#ifndef TSN_AF_NPCF_BUILD_H
#define TSN_AF_NPCF_BUILD_H

#include "context.h"

#ifdef __cplusplus
extern "C" {
#endif

ogs_sbi_request_t *tsn_af_npcf_build_create(
        tsn_af_bridge_t *bridge, void *data);

ogs_sbi_request_t *tsn_af_npcf_build_port_mgmt_update(
        tsn_af_bridge_t *bridge, void *data);

ogs_sbi_request_t *tsn_af_npcf_build_bridge_mgmt_update(
        tsn_af_bridge_t *bridge, void *data);

ogs_sbi_request_t *tsn_af_npcf_build_qos_update(
        tsn_af_bridge_t *bridge, void *data);

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_NPCF_BUILD_H */
