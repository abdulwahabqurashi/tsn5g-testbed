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

#ifndef TSN_AF_NSMF_HANDLER_H
#define TSN_AF_NSMF_HANDLER_H

#include "context.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Push TSN config from TSN-AF to SMF via HTTP/2
 *
 * The SMF exposes: POST /nsmf-tsn/v1/bridges/{bridge_mac}/config
 * Body: JSON with base64-encoded management containers
 *
 * This triggers SMF → UPF PFCP Session Modification with
 * TSC Management Information IEs.
 */
int tsn_af_nsmf_push_config(tsn_af_bridge_t *bridge);

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_NSMF_HANDLER_H */
