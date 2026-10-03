/*
 * Copyright (C) 2019 by Sukchan Lee <acetcom@gmail.com>
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

#include "upf-sm.h"
#include "context.h"
#include "event.h"
#include "pfcp-path.h"
#include "gtp-path.h"
#include "nwtt.h"

void upf_state_initial(ogs_fsm_t *s, upf_event_t *e)
{
    upf_sm_debug(e);

    ogs_assert(s);

    OGS_FSM_TRAN(s, &upf_state_operational);
}

void upf_state_final(ogs_fsm_t *s, upf_event_t *e)
{
    upf_sm_debug(e);

    ogs_assert(s);
}

void upf_state_operational(ogs_fsm_t *s, upf_event_t *e)
{
    int rv;
    ogs_pkbuf_t *recvbuf = NULL;

    ogs_pfcp_message_t *pfcp_message = NULL;
    ogs_pfcp_node_t *node = NULL;
    ogs_pfcp_xact_t *xact = NULL;

    upf_sm_debug(e);

    ogs_assert(s);

    switch (e->id) {
    case OGS_FSM_ENTRY_SIG:
        break;

    case OGS_FSM_EXIT_SIG:
        break;

    case UPF_EVT_N4_MESSAGE:
        ogs_assert(e);
        recvbuf = e->pkbuf;
        ogs_assert(recvbuf);
        pfcp_message = e->pfcp_message;
        ogs_assert(pfcp_message);
        node = e->pfcp_node;
        ogs_assert(node);
        ogs_assert(OGS_FSM_STATE(&node->sm));

        rv = ogs_pfcp_xact_receive(node, &pfcp_message->h, &xact);
        if (rv != OGS_OK) {
            ogs_pkbuf_free(recvbuf);
            ogs_pfcp_message_free(pfcp_message);
            break;
        }

        e->pfcp_xact_id = xact ? xact->id : OGS_INVALID_POOL_ID;
        ogs_fsm_dispatch(&node->sm, e);
        if (OGS_FSM_CHECK(&node->sm, upf_pfcp_state_exception)) {
            ogs_error("PFCP state machine exception");
        }

        ogs_pkbuf_free(recvbuf);
        ogs_pfcp_message_free(pfcp_message);
        break;
    case UPF_EVT_N4_TIMER:
    case UPF_EVT_N4_NO_HEARTBEAT:
        node = e->pfcp_node;
        ogs_assert(node);
        ogs_assert(OGS_FSM_STATE(&node->sm));

        ogs_fsm_dispatch(&node->sm, e);
        break;

    case UPF_EVT_NWTT_TIMER:
        switch (e->timer_id) {
        case 1: /* LLDP TX timer */
            upf_nwtt_lldp_originate();
            /* Re-arm timer */
            if (upf_self()->nwtt_bridge.lldp_tx_timer) {
                ogs_timer_start(upf_self()->nwtt_bridge.lldp_tx_timer,
                        ogs_time_from_sec(LLDP_TX_INTERVAL_SEC));
            }
            break;
        case 2: /* gPTP poll timer */
            upf_nwtt_gptp_poll_status();
            /* Re-arm timer */
            if (upf_self()->nwtt_bridge.gptp.poll_timer) {
                ogs_timer_start(upf_self()->nwtt_bridge.gptp.poll_timer,
                        ogs_time_from_sec(10));
            }
            break;
        default:
            ogs_warn("Unknown NW-TT timer_id=%d", e->timer_id);
            break;
        }
        break;

    default:
        ogs_error("No handler for event %s", upf_event_get_name(e));
        break;
    }
}
