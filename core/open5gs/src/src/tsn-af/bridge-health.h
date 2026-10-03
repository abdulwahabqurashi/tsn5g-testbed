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

#ifndef TSN_AF_BRIDGE_HEALTH_H
#define TSN_AF_BRIDGE_HEALTH_H

#include "context.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Start health monitoring for a bridge group.
 * Creates a periodic timer that checks all members.
 */
void tsn_af_bridge_health_start(tsn_af_bridge_group_t *group);

/*
 * Stop health monitoring for a bridge group.
 */
void tsn_af_bridge_health_stop(tsn_af_bridge_group_t *group);

/*
 * Health check callback — called periodically by timer.
 * Checks all members, updates health state, triggers failover if needed.
 */
void tsn_af_bridge_health_check(void *data);

/*
 * Perform manual failover for a bridge group.
 * Selects the best available backup and promotes it.
 * Returns OGS_OK on success.
 */
int tsn_af_bridge_failover(tsn_af_bridge_group_t *group);

/*
 * Check health of a single bridge.
 * Returns the updated health state.
 */
tsn_af_bridge_health_e tsn_af_bridge_check_health(tsn_af_bridge_t *bridge);

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_BRIDGE_HEALTH_H */
