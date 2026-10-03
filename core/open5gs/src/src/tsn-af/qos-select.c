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

#include "qos-select.h"

/*
 * 5QI selection for TSN streams based on 3GPP TS 23.501 Table 5.7.4-1
 *
 * TSC-specific 5QI values (TS 23.501 Table 5.7.4-1):
 *   5QI 55: GBR, delay 150ms, Mission Critical Push-to-Talk
 *   5QI 56: GBR, delay 300ms, Mission Critical
 *   5QI 82: GBR, delay 10ms,  Discrete Automation (non-TSN)
 *   5QI 83: GBR, delay 10ms,  Discrete Automation (non-TSN)
 *   5QI 84: GBR, delay 30ms,  Intelligent Transport Systems
 *   5QI 85: GBR, delay 5ms,   Electricity Distribution HA
 *   5QI 86: GBR, delay 5ms,   TSC non-public (V2X)
 *
 * Standard GBR 5QI values:
 *   5QI 1:  GBR, delay 100ms, Conversational Voice
 *   5QI 2:  GBR, delay 150ms, Conversational Video
 *   5QI 3:  GBR, delay 50ms,  Real-Time Gaming
 *   5QI 4:  GBR, delay 300ms, Non-Conversational Video
 *   5QI 65: GBR, delay 75ms,  Mission Critical Push-to-Talk
 *
 * For TSN deterministic streams:
 *   - Ultra-low latency (<1ms):   5QI 85 (5ms budget, GBR)
 *   - Low latency (<5ms):         5QI 85 (5ms budget, GBR)
 *   - Medium latency (<10ms):     5QI 82 (10ms budget, GBR)
 *   - Standard latency (<50ms):   5QI 3  (50ms budget, GBR)
 *   - Relaxed latency (<100ms):   5QI 1  (100ms budget, GBR)
 *
 * PCP-based mapping (IEEE 802.1Q):
 *   PCP 7: Network Control       -> 5QI 82 (highest TSN priority)
 *   PCP 6: Internetwork Control  -> 5QI 85
 *   PCP 5: Voice                 -> 5QI 1
 *   PCP 4: Video/Controlled Load -> 5QI 3
 *   PCP 3: Excellent Effort      -> 5QI 4
 *   PCP 2: Best Effort           -> 5QI 9 (non-GBR)
 *   PCP 1: Background            -> 5QI 9 (non-GBR)
 *   PCP 0: Default               -> 5QI 9 (non-GBR)
 */

/* Default PCP → 5QI mapping for TSN */
static const uint8_t default_pcp_to_5qi[8] = {
    9,      /* PCP 0: Best Effort (non-GBR) */
    9,      /* PCP 1: Background (non-GBR) */
    9,      /* PCP 2: Spare (non-GBR) */
    4,      /* PCP 3: Excellent Effort (GBR) */
    3,      /* PCP 4: Controlled Load (GBR) */
    1,      /* PCP 5: Voice (GBR) */
    85,     /* PCP 6: Internetwork Control (GBR TSC) */
    82,     /* PCP 7: Network Control (GBR TSC) */
};

/* MBR multiplier: MBR = GBR * this factor */
#define MBR_MULTIPLIER 2

static uint8_t select_5qi_by_latency(uint32_t max_latency_us)
{
    if (max_latency_us == 0)
        return 85;  /* No latency specified — assume TSC low latency */

    if (max_latency_us <= 5000)
        return 85;  /* ≤5ms: TSC Electricity Distribution HA */
    else if (max_latency_us <= 10000)
        return 82;  /* ≤10ms: Discrete Automation */
    else if (max_latency_us <= 50000)
        return 3;   /* ≤50ms: Real-Time Gaming */
    else if (max_latency_us <= 100000)
        return 1;   /* ≤100ms: Conversational Voice */
    else if (max_latency_us <= 150000)
        return 2;   /* ≤150ms: Conversational Video */
    else
        return 4;   /* >150ms: Non-Conversational Video */
}

static bool is_gbr_5qi(uint8_t _5qi)
{
    switch (_5qi) {
    case 1: case 2: case 3: case 4:
    case 65: case 66: case 67:
    case 71: case 72: case 73: case 74: case 75: case 76:
    case 82: case 83: case 84: case 85: case 86:
        return true;
    default:
        return false;
    }
}

void tsn_af_select_5qi(
        tsn_af_stream_reservation_t *rsv,
        tsn_af_bridge_t *bridge,
        tsn_af_qos_result_t *result)
{
    uint8_t pcp;
    uint8_t _5qi = 9;  /* default: best effort */

    ogs_assert(rsv);
    ogs_assert(result);

    memset(result, 0, sizeof(*result));

    /* Determine PCP from priority or default */
    pcp = (rsv->priority >= 0 && rsv->priority <= 7)
        ? (uint8_t)rsv->priority : 0;

    /*
     * Step 1: Check if bridge has explicit PCP→5QI mapping
     */
    if (bridge && bridge->qos_map[pcp].configured) {
        _5qi = bridge->qos_map[pcp]._5qi;
    } else {
        /*
         * Step 2: Select by latency requirement (preferred for TSN)
         */
        if (rsv->max_latency_us > 0) {
            _5qi = select_5qi_by_latency(rsv->max_latency_us);
        } else {
            /*
             * Step 3: Fall back to default PCP mapping
             */
            _5qi = default_pcp_to_5qi[pcp];
        }
    }

    result->_5qi = _5qi;
    result->pcp = pcp;
    result->arp_priority = 2;  /* default ARP priority */

    /*
     * Compute GBR/MBR for GBR 5QI types
     */
    if (is_gbr_5qi(_5qi) && rsv->bandwidth_bps > 0) {
        result->gbr_bps = rsv->bandwidth_bps;
        result->mbr_bps = rsv->bandwidth_bps * MBR_MULTIPLIER;
    } else if (is_gbr_5qi(_5qi)) {
        /*
         * GBR 5QI but no bandwidth computed (missing interval).
         * Use a conservative default: 1 Mbps GBR, 10 Mbps MBR.
         */
        result->gbr_bps = 1000000;
        result->mbr_bps = 10000000;
    }

    ogs_info("[TSN-AF] QoS selection: PCP=%u latency=%u us bw=%llu bps "
            "-> 5QI=%u GBR=%llu MBR=%llu",
            pcp, rsv->max_latency_us,
            (unsigned long long)rsv->bandwidth_bps,
            _5qi,
            (unsigned long long)result->gbr_bps,
            (unsigned long long)result->mbr_bps);
}
