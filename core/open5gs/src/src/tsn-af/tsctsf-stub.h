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

#ifndef TSN_AF_TSCTSF_STUB_H
#define TSN_AF_TSCTSF_STUB_H

#include "context.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Send time domain configuration to UPF via PCF -> SMF -> PFCP path.
 * This encodes the time domain info as a TS 24.519 port management
 * container and sends it through Npcf_PolicyAuthorization.
 */
int tsn_af_tsctsf_configure_time_domain(
        tsn_af_bridge_t *bridge,
        uint8_t time_domain_number,
        uint32_t time_offset_ns);

/*
 * Send port management configuration to UPF via PCF -> SMF -> PFCP path.
 */
int tsn_af_tsctsf_send_port_config(
        tsn_af_bridge_t *bridge,
        tsn_af_port_t *port);

/*
 * Send bridge management configuration to UPF via PCF -> SMF -> PFCP path.
 */
int tsn_af_tsctsf_send_bridge_config(
        tsn_af_bridge_t *bridge);

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_TSCTSF_STUB_H */
