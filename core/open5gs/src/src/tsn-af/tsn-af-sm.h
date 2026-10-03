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

#ifndef TSN_AF_SM_H
#define TSN_AF_SM_H

#include "event.h"

#ifdef __cplusplus
extern "C" {
#endif

void tsn_af_state_initial(ogs_fsm_t *s, tsn_af_event_t *e);
void tsn_af_state_final(ogs_fsm_t *s, tsn_af_event_t *e);
void tsn_af_state_operational(ogs_fsm_t *s, tsn_af_event_t *e);
void tsn_af_state_exception(ogs_fsm_t *s, tsn_af_event_t *e);

#define tsn_af_sm_debug(__pe) \
    ogs_debug("%s(): %s", __func__, tsn_af_event_get_name(__pe))

#ifdef __cplusplus
}
#endif

#endif /* TSN_AF_SM_H */
