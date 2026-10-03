/*
 * Copyright (C) 2019-2023 by Sukchan Lee <acetcom@gmail.com>
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

#include "context.h"

#if HAVE_NETINET_IP_H
#include <netinet/ip.h>
#endif

#if HAVE_NETINET_IP6_H
#include <netinet/ip6.h>
#endif

#if HAVE_NETINET_IP_ICMP_H
#include <netinet/ip_icmp.h>
#endif

#if HAVE_NETINET_ICMP6_H
#include <netinet/icmp6.h>
#endif

#if HAVE_SYS_IOCTL_H
#include <sys/ioctl.h>
#endif

#if HAVE_NET_IF_DL_H
#include <net/if_dl.h>
#endif

#if HAVE_IFADDRS_H
#include <ifaddrs.h>
#endif

#include "arp-nd.h"
#include "event.h"
#include "gtp-path.h"
#include "pfcp-path.h"
#include "rule-match.h"
#include "nwtt.h"

#define UPF_GTP_HANDLED     1

const uint8_t proxy_mac_addr[] = { 0x0e, 0x00, 0x00, 0x00, 0x00, 0x01 };

static ogs_pkbuf_pool_t *packet_pool = NULL;

static void upf_gtp_handle_multicast(ogs_pkbuf_t *recvbuf);

static int check_framed_routes(upf_sess_t *sess, int family, uint32_t *addr)
{
    int i = 0;
    ogs_ipsubnet_t *routes = family == AF_INET ?
        sess->ipv4_framed_routes : sess->ipv6_framed_routes;

    if (!routes)
        return false;

    for (i = 0; i < OGS_MAX_NUM_OF_FRAMED_ROUTES_IN_PDI; i++) {
        uint32_t *sub = routes[i].sub;
        uint32_t *mask = routes[i].mask;

        if (!routes[i].family)
            break;

        if (family == AF_INET) {
            if (sub[0] == (addr[0] & mask[0]))
                return true;
        } else {
            if (sub[0] == (addr[0] & mask[0]) &&
                sub[1] == (addr[1] & mask[1]) &&
                sub[2] == (addr[2] & mask[2]) &&
                sub[3] == (addr[3] & mask[3]))
                return true;
        }
    }
    return false;
}

static uint16_t _get_eth_type(uint8_t *data, uint len) {
    if (len > ETHER_HDR_LEN) {
        struct ether_header *hdr = (struct ether_header*)data;
        return htobe16(hdr->ether_type);
    }
    return 0;
}

/* QER MBR enforcement (TS 23.501 5.7.1: the UPF polices Session-AMBR /
 * MBR downlink). Token bucket per QER direction; burst allowance is
 * 100 ms at the enforced rate. Returns true if the packet may pass.
 * A zero MBR means no enforcement. */
static bool qer_mbr_pass(ogs_pfcp_qer_t *qer, uint32_t bytes, bool downlink)
{
    uint64_t rate, *tokens, burst, bits;
    ogs_time_t now, elapsed, *last_fill;

    if (!qer)
        return true;

    rate = downlink ? qer->mbr.downlink : qer->mbr.uplink;
    if (!rate)
        return true;

    now = ogs_time_now();
    tokens = downlink ? &qer->policer.dl_tokens : &qer->policer.ul_tokens;
    last_fill = downlink ?
        &qer->policer.dl_last_fill : &qer->policer.ul_last_fill;
    burst = rate / 10;                  /* 100 ms of rate, in bits */
    if (burst < 12000 * 8)
        burst = 12000 * 8;              /* at least ~8 full frames */

    if (*last_fill) {
        elapsed = now - *last_fill;
        *tokens += rate * elapsed / OGS_USEC_PER_SEC;
    } else {
        *tokens = burst;
    }
    *last_fill = now;
    if (*tokens > burst)
        *tokens = burst;

    bits = (uint64_t)bytes * 8;
    if (*tokens < bits)
        return false;

    *tokens -= bits;
    return true;
}

static void _gtpv1_tun_recv_common_cb(
        short when, ogs_socket_t fd, bool has_eth, void *data)
{
    ogs_pkbuf_t *recvbuf = NULL;

    upf_sess_t *sess = NULL;
    ogs_pfcp_pdr_t *pdr = NULL;
    ogs_pfcp_pdr_t *fallback_pdr = NULL;
    ogs_pfcp_far_t *far = NULL;
    ogs_pfcp_user_plane_report_t report;
    int i;

    /* NW-TT: saved Ethernet header for TSN ingress processing */
    uint8_t nwtt_eth_hdr[18];
    int nwtt_eth_hdr_len = 0;
    int nwtt_pcp_qfi = -1;

    recvbuf = ogs_tun_read(fd, packet_pool);
    if (!recvbuf) {
        ogs_warn("ogs_tun_read() failed");
        return;
    }

    if (has_eth) {
        ogs_pkbuf_t *replybuf = NULL;
        uint16_t eth_type = _get_eth_type(recvbuf->data, recvbuf->len);
        uint8_t size;

        /* On a TAP bound to an Ethernet PDU session, ARP/ND belong to
         * the bridged L2 segment and must be forwarded transparently.
         * The proxy below is for IP PDU sessions only - running it here
         * swallowed every ARP reply toward devices behind the UE. */
        upf_sess_t *tap_eth_sess = upf_sess_find_by_eth_dev_fd(fd);

        if (eth_type == ETHERTYPE_ARP && !tap_eth_sess) {
            if (is_arp_req(recvbuf->data, recvbuf->len) &&
                    upf_sess_find_by_ipv4(
                        arp_parse_target_addr(recvbuf->data, recvbuf->len))) {
                replybuf = ogs_pkbuf_alloc(packet_pool, OGS_MAX_PKT_LEN);
                ogs_assert(replybuf);
                ogs_pkbuf_reserve(replybuf, OGS_TUN_MAX_HEADROOM);
                ogs_pkbuf_put(replybuf, OGS_MAX_PKT_LEN-OGS_TUN_MAX_HEADROOM);
                size = arp_reply(replybuf->data, recvbuf->data, recvbuf->len,
                    proxy_mac_addr);
                ogs_pkbuf_trim(replybuf, size);
                ogs_info("[SEND] reply to ARP request: %u", size);
            } else {
                goto cleanup;
            }
        } else if (eth_type == ETHERTYPE_IPV6 && !tap_eth_sess &&
                    is_nd_req(recvbuf->data, recvbuf->len)) {
            replybuf = ogs_pkbuf_alloc(packet_pool, OGS_MAX_PKT_LEN);
            ogs_assert(replybuf);
            ogs_pkbuf_reserve(replybuf, OGS_TUN_MAX_HEADROOM);
            ogs_pkbuf_put(replybuf, OGS_MAX_PKT_LEN-OGS_TUN_MAX_HEADROOM);
            size = nd_reply(replybuf->data, recvbuf->data, recvbuf->len,
                proxy_mac_addr);
            ogs_pkbuf_trim(replybuf, size);
            ogs_info("[SEND] reply to ND solicit: %u", size);
        }
        if (replybuf) {
            if (ogs_tun_write(fd, replybuf) != OGS_OK)
                ogs_warn("ogs_tun_write() for reply failed");
            
            ogs_pkbuf_free(replybuf);
            goto cleanup;
        }
        /* gPTP pass-through: forward PTP frames without stripping Ethernet */
        if (eth_type == ETHERTYPE_PTP &&
            upf_self()->nwtt_bridge.enabled &&
            upf_self()->nwtt_bridge.gptp.enabled) {
            ogs_debug("[NW-TT] gPTP frame received on TAP (%d bytes)",
                    recvbuf->len);
            /* gPTP frames are forwarded via normal PDR/FAR matching
             * after session lookup below, without stripping Ethernet header.
             * Residence time correction is applied at egress. */
            goto find_sess_for_gptp;
        }

        /* LLDP frame interception for TSN bridge:
         * Relay from DN (TAP) to UE (GTP-U) via TSN session */
        if (eth_type == ETHERTYPE_LLDP &&
            upf_self()->nwtt_bridge.enabled) {
            ogs_debug("[NW-TT] LLDP frame from DN (%d bytes), "
                    "relaying to UE via GTP-U", recvbuf->len);
            goto find_sess_for_lldp;
        }

        /* IEEE 802.1D reserved link-local range 01:80:c2:00:00:00..0f
         * (STP/MSTP BPDUs, pause frames, ...): a bridge port must not
         * relay these (802.1D 7.12.3), and the DN-side switch emits
         * BPDUs every 2s. Drop silently before session forwarding.
         * gPTP/LLDP (both 01:80:c2:00:00:0e by EtherType) were already
         * dispatched above. */
        {
            static const uint8_t br_reserved[5] =
                    { 0x01, 0x80, 0xc2, 0x00, 0x00 };
            if (recvbuf->len >= ETHER_HDR_LEN &&
                    memcmp(recvbuf->data, br_reserved, 5) == 0 &&
                    (recvbuf->data[5] & 0xf0) == 0x00) {
                ogs_debug("[NW-TT] Dropping 802.1D link-local frame "
                        "(dst ...:%02x)", recvbuf->data[5]);
                goto cleanup;
            }
        }

        /* 802.3/LLC frames carry a length field (< 0x0600), not an
         * EtherType; nothing above the TSN data path consumes them. */
        if (eth_type < 0x0600) {
            ogs_debug("[NW-TT] Dropping LLC/802.3 frame (length 0x%x)",
                    eth_type);
            goto cleanup;
        }

        /* Check for Ethernet PDU session on this TAP device */
        if (tap_eth_sess) {
            sess = tap_eth_sess;
            goto forward_ethernet_frame;
        }

        if (eth_type != ETHERTYPE_IP && eth_type != ETHERTYPE_IPV6) {
            ogs_debug("[DROP] Invalid eth_type [%x]", eth_type);
            goto cleanup;
        }

        /* NW-TT: save Ethernet header before stripping for TSN processing */
        if (upf_self()->nwtt_bridge.enabled && recvbuf->len >= 14) {
            nwtt_eth_hdr_len = recvbuf->len >= 18 ? 18 : 14;
            memcpy(nwtt_eth_hdr, recvbuf->data, nwtt_eth_hdr_len);
        }

        ogs_pkbuf_pull(recvbuf, ETHER_HDR_LEN);
    }
    if (0) {
find_sess_for_gptp:
        /* For gPTP frames, find session by checking all TSN sessions */
        {
            upf_sess_t *tsn_sess = NULL;
            ogs_list_for_each(&upf_self()->sess_list, tsn_sess) {
                if (tsn_sess->tsc.is_tsn) {
                    sess = tsn_sess;
                    if (sess->tsc.nwtt_port)
                        sess->tsc.nwtt_port->traffic.rx_gptp_frames++;
                    break;
                }
            }
            if (!sess)
                goto cleanup;

            /* Find a downlink PDR */
            ogs_list_for_each(&sess->pfcp.pdr_list, pdr) {
                far = pdr->far;
                ogs_assert(far);
                if (pdr->src_if == OGS_PFCP_INTERFACE_CORE)
                    break;
            }
            if (!pdr)
                goto cleanup;

            /* Add residence time for gPTP at egress (ns precision) */
            upf_nwtt_gptp_add_residence_time(
                    recvbuf->data, recvbuf->len,
                    upf_nwtt_clock_gettime_ns());

            ogs_assert(true == ogs_pfcp_up_handle_pdr(
                        pdr, OGS_GTPU_MSGTYPE_GPDU, 0,
                        NULL, recvbuf, &report));
            return;
        }
    }
    if (0) {
find_sess_for_lldp:
        /* Relay LLDP frame from DN to UE via GTP-U tunnel */
        {
            upf_sess_t *tsn_sess = NULL;
            ogs_list_for_each(&upf_self()->sess_list, tsn_sess) {
                if (tsn_sess->tsc.is_tsn) {
                    sess = tsn_sess;
                    if (sess->tsc.nwtt_port)
                        sess->tsc.nwtt_port->traffic.rx_lldp_frames++;
                    break;
                }
            }
            if (!sess)
                goto cleanup;

            /* Find a downlink PDR */
            ogs_list_for_each(&sess->pfcp.pdr_list, pdr) {
                far = pdr->far;
                ogs_assert(far);
                if (pdr->src_if == OGS_PFCP_INTERFACE_CORE)
                    break;
            }
            if (!pdr)
                goto cleanup;

            /* Send LLDP frame with Ethernet header intact via GTP-U */
            ogs_assert(true == ogs_pfcp_up_handle_pdr(
                        pdr, OGS_GTPU_MSGTYPE_GPDU, 0,
                        NULL, recvbuf, &report));
            return;
        }
    }
    if (0) {
forward_ethernet_frame:
        /* Ethernet PDU session: forward entire Ethernet frame via GTP-U */
        {
            /* Downlink MAC adaptation for routed-mode UEs (5G routers
             * whose modem drops downlink unicast not addressed to its
             * own MAC): readdress IP unicast to the session gateway
             * MAC so the UE-side router delivers it by IP, and send
             * ARP replies as broadcast so LAN devices can resolve
             * network-side hosts. */
            if (upf_self()->nwtt_bridge.dl_mac_adapt &&
                    recvbuf->len >= ETHER_HDR_LEN) {
                uint8_t *dst = recvbuf->data;
                uint16_t adapt_et =
                    (recvbuf->data[12] << 8) | recvbuf->data[13];
                int adapt_off = ETHER_HDR_LEN;

                if (adapt_et == 0x8100 && recvbuf->len >= 18) {
                    adapt_et =
                        (recvbuf->data[16] << 8) | recvbuf->data[17];
                    adapt_off = 18;
                }

                if (adapt_et == ETHERTYPE_ARP &&
                        recvbuf->len >= adapt_off + 8 &&
                        recvbuf->data[adapt_off + 6] == 0 &&
                        recvbuf->data[adapt_off + 7] == 2) {
                    /* ARP reply -> broadcast (RFC 826 permits it) */
                    memset(dst, 0xff, 6);
                } else if ((adapt_et == ETHERTYPE_IP ||
                            adapt_et == ETHERTYPE_IPV6) &&
                        !(dst[0] & 0x01) &&
                        sess->gw_mac_learned &&
                        memcmp(dst, sess->gw_mac, 6) != 0) {
                    memcpy(dst, sess->gw_mac, 6);
                }
            }

            /* NW-TT processing if TSN */
            if (sess->tsc.is_tsn && sess->tsc.nwtt_port) {
                sess->tsc.nwtt_port->traffic.tx_frames++;
                sess->tsc.nwtt_port->traffic.tx_bytes += recvbuf->len;

                if (!upf_nwtt_psfp_check(sess->tsc.nwtt_port,
                        recvbuf->data, recvbuf->len)) {
                    goto cleanup;
                }
                nwtt_pcp_qfi = upf_nwtt_classify_pcp(sess->tsc.nwtt_port,
                        recvbuf->data, recvbuf->len);
            }

            /* Find downlink PDR */
            ogs_list_for_each(&sess->pfcp.pdr_list, pdr) {
                far = pdr->far;
                ogs_assert(far);
                if (pdr->src_if == OGS_PFCP_INTERFACE_CORE)
                    break;
            }
            if (!pdr)
                goto cleanup;

            /* NW-TT: if PCP classified a QFI, prefer PDR with matching QER */
            if (nwtt_pcp_qfi >= 0) {
                if (!pdr->qer ||
                        pdr->qer->qfi != (uint8_t)nwtt_pcp_qfi) {
                    ogs_pfcp_pdr_t *tsn_pdr = NULL;
                    ogs_list_for_each(&sess->pfcp.pdr_list, tsn_pdr) {
                        if (tsn_pdr->src_if != OGS_PFCP_INTERFACE_CORE)
                            continue;
                        if (!tsn_pdr->far ||
                            tsn_pdr->far->dst_if !=
                                OGS_PFCP_INTERFACE_ACCESS)
                            continue;
                        if (tsn_pdr->qer &&
                            tsn_pdr->qer->qfi ==
                                (uint8_t)nwtt_pcp_qfi) {
                            pdr = tsn_pdr;
                            break;
                        }
                    }
                }
            }

            /* Session-AMBR / MBR downlink enforcement: drop excess
             * here so bursts can never overwhelm the RAN downlink. */
            if (!qer_mbr_pass(pdr->qer, recvbuf->len, true)) {
                if (sess->tsc.is_tsn && sess->tsc.nwtt_port)
                    sess->tsc.nwtt_port->traffic.mbr_dropped_frames++;
                goto cleanup;
            }

            for (i = 0; i < pdr->num_of_urr; i++)
                upf_sess_urr_acc_add(
                        sess, pdr->urr[i], recvbuf->len, false);

            /* Forward with Ethernet header intact */
            ogs_assert(true == ogs_pfcp_up_handle_pdr(
                        pdr, OGS_GTPU_MSGTYPE_GPDU, 0,
                        NULL, recvbuf, &report));

            if (report.type.downlink_data_report) {
                report.downlink_data.pdr_id = pdr->id;
                if (pdr->qer && pdr->qer->qfi)
                    report.downlink_data.qfi = pdr->qer->qfi;
                ogs_assert(OGS_OK ==
                    upf_pfcp_send_session_report_request(sess, &report));
            }
            return;
        }
    }

    sess = upf_sess_find_by_ue_ip_address(recvbuf);
    if (!sess)
        goto cleanup;

    /* NW-TT ingress processing for TSN sessions */
    if (sess->tsc.is_tsn && sess->tsc.nwtt_port && nwtt_eth_hdr_len > 0) {
        /* Stream filter: drop frames that don't match any filter entry */
        if (!upf_nwtt_stream_filter_match(sess->tsc.nwtt_port,
                nwtt_eth_hdr, nwtt_eth_hdr_len)) {
            ogs_info("[NW-TT] Ingress stream filter mismatch, dropping");
            goto cleanup;
        }

        /* PSFP metering: drop frames exceeding committed rate */
        if (!upf_nwtt_psfp_check(sess->tsc.nwtt_port,
                nwtt_eth_hdr, recvbuf->len + 14)) {
            ogs_info("[NW-TT] PSFP meter drop on ingress");
            goto cleanup;
        }

        sess->tsc.nwtt_port->traffic.tx_frames++;
        sess->tsc.nwtt_port->traffic.tx_bytes += recvbuf->len;

        /* PCP → QFI classification for PDR selection */
        nwtt_pcp_qfi = upf_nwtt_classify_pcp(sess->tsc.nwtt_port,
                nwtt_eth_hdr, nwtt_eth_hdr_len);
    }

    ogs_list_for_each(&sess->pfcp.pdr_list, pdr) {
        far = pdr->far;
        ogs_assert(far);

        /* Check if PDR is Downlink */
        if (pdr->src_if != OGS_PFCP_INTERFACE_CORE)
            continue;

        /* Save the Fallback PDR : Lowest precedence downlink PDR */
        fallback_pdr = pdr;

        /* Check if FAR is Downlink */
        if (far->dst_if != OGS_PFCP_INTERFACE_ACCESS)
            continue;

        /* Check if Outer header creation */
        if (far->outer_header_creation.ip4 == 0 &&
            far->outer_header_creation.ip6 == 0 &&
            far->outer_header_creation.udp4 == 0 &&
            far->outer_header_creation.udp6 == 0 &&
            far->outer_header_creation.gtpu4 == 0 &&
            far->outer_header_creation.gtpu6 == 0)
            continue;

        /* Check if Rule List in PDR */
        if (ogs_list_first(&pdr->rule_list) &&
            ogs_pfcp_pdr_rule_find_by_packet(pdr, recvbuf) == NULL)
            continue;

        break;
    }

    if (!pdr)
        pdr = fallback_pdr;

    /* NW-TT: if PCP classified a QFI, prefer PDR with matching QER QFI */
    if (nwtt_pcp_qfi >= 0 && pdr) {
        if (!pdr->qer || pdr->qer->qfi != (uint8_t)nwtt_pcp_qfi) {
            ogs_pfcp_pdr_t *tsn_pdr = NULL;
            ogs_list_for_each(&sess->pfcp.pdr_list, tsn_pdr) {
                if (tsn_pdr->src_if != OGS_PFCP_INTERFACE_CORE)
                    continue;
                if (!tsn_pdr->far ||
                    tsn_pdr->far->dst_if != OGS_PFCP_INTERFACE_ACCESS)
                    continue;
                if (tsn_pdr->qer &&
                    tsn_pdr->qer->qfi == (uint8_t)nwtt_pcp_qfi) {
                    ogs_debug("[NW-TT] PCP->QFI: selected PDR with QFI %d",
                            nwtt_pcp_qfi);
                    pdr = tsn_pdr;
                    break;
                }
            }
        }
    }

    if (!pdr) {
        if (ogs_global_conf()->parameter.multicast) {
            upf_gtp_handle_multicast(recvbuf);
        }
        goto cleanup;
    }

    /* Session-AMBR / MBR downlink enforcement (IP PDU sessions) */
    if (!qer_mbr_pass(pdr->qer, recvbuf->len, true))
        goto cleanup;

    /* Increment total & dl octets + pkts */
    for (i = 0; i < pdr->num_of_urr; i++)
        upf_sess_urr_acc_add(sess, pdr->urr[i], recvbuf->len, false);

    ogs_assert(true == ogs_pfcp_up_handle_pdr(
                pdr, OGS_GTPU_MSGTYPE_GPDU, 0, NULL, recvbuf, &report));

    /*
     * Issue #2210, Discussion #2208, #2209
     *
     * Metrics reduce data plane performance.
     * It should not be used on the UPF/SGW-U data plane
     * until this issue is resolved.
     */
#if 0
    upf_metrics_inst_global_inc(UPF_METR_GLOB_CTR_GTP_OUTDATAPKTN3UPF);
    upf_metrics_inst_by_qfi_add(pdr->qer->qfi,
        UPF_METR_CTR_GTP_OUTDATAVOLUMEQOSLEVELN3UPF, recvbuf->len);
#endif

    if (report.type.downlink_data_report) {
        ogs_assert(pdr->sess);
        sess = UPF_SESS(pdr->sess);
        ogs_assert(sess);

        report.downlink_data.pdr_id = pdr->id;
        if (pdr->qer && pdr->qer->qfi)
            report.downlink_data.qfi = pdr->qer->qfi; /* for 5GC */

        ogs_assert(OGS_OK ==
            upf_pfcp_send_session_report_request(sess, &report));
    }

    /*
     * The ogs_pfcp_up_handle_pdr() function
     * buffers or frees the Packet Buffer(pkbuf) memory.
     */
    return;

cleanup:
    ogs_pkbuf_free(recvbuf);
}

static void _gtpv1_tun_recv_cb(short when, ogs_socket_t fd, void *data)
{
    _gtpv1_tun_recv_common_cb(when, fd, false, data);
}

static void _gtpv1_tun_recv_eth_cb(short when, ogs_socket_t fd, void *data)
{
    _gtpv1_tun_recv_common_cb(when, fd, true, data);
}

static void _gtpv1_u_recv_cb(short when, ogs_socket_t fd, void *data)
{
    int len;
    ssize_t size;
    char buf1[OGS_ADDRSTRLEN];
    char buf2[OGS_ADDRSTRLEN];

    upf_sess_t *sess = NULL;

    ogs_pkbuf_t *pkbuf = NULL;
    ogs_sock_t *sock = NULL;
    ogs_sockaddr_t from;

    ogs_gtp2_header_t *gtp_h = NULL;
    ogs_gtp2_header_desc_t header_desc;
    ogs_pfcp_user_plane_report_t report;

    ogs_assert(fd != INVALID_SOCKET);
    sock = data;
    ogs_assert(sock);

    pkbuf = ogs_pkbuf_alloc(packet_pool, OGS_MAX_PKT_LEN);
    ogs_assert(pkbuf);
    ogs_pkbuf_reserve(pkbuf, OGS_TUN_MAX_HEADROOM);
    ogs_pkbuf_put(pkbuf, OGS_MAX_PKT_LEN-OGS_TUN_MAX_HEADROOM);

    size = ogs_recvfrom(fd, pkbuf->data, pkbuf->len, 0, &from);
    if (size <= 0) {
        ogs_log_message(OGS_LOG_ERROR, ogs_socket_errno,
                "ogs_recv() failed");
        goto cleanup;
    }

    ogs_pkbuf_trim(pkbuf, size);

    ogs_assert(pkbuf);
    ogs_assert(pkbuf->len);

    gtp_h = (ogs_gtp2_header_t *)pkbuf->data;
    if (gtp_h->version != OGS_GTP2_VERSION_1) {
        ogs_error("[DROP] Invalid GTPU version [%d]", gtp_h->version);
        ogs_log_hexdump(OGS_LOG_ERROR, pkbuf->data, pkbuf->len);
        goto cleanup;
    }

    len = ogs_gtpu_parse_header(&header_desc, pkbuf);
    if (len < 0) {
        ogs_error("[DROP] Cannot decode GTPU packet");
        ogs_log_hexdump(OGS_LOG_ERROR, pkbuf->data, pkbuf->len);
        goto cleanup;
    }
    if (header_desc.type == OGS_GTPU_MSGTYPE_ECHO_REQ) {
        ogs_pkbuf_t *echo_rsp;

        ogs_info("[RECV] Echo Request from [%s]", OGS_ADDR(&from, buf1));
        echo_rsp = ogs_gtp2_handle_echo_req(pkbuf);
        ogs_expect(echo_rsp);
        if (echo_rsp) {
            ssize_t sent;

            /* Echo reply */
            ogs_info("[SEND] Echo Response to [%s]", OGS_ADDR(&from, buf1));

            sent = ogs_sendto(fd, echo_rsp->data, echo_rsp->len, 0, &from);
            if (sent < 0 || sent != echo_rsp->len) {
                ogs_log_message(OGS_LOG_ERROR, ogs_socket_errno,
                        "ogs_sendto() failed");
            }
            ogs_pkbuf_free(echo_rsp);
        }
        goto cleanup;
    }
    if (header_desc.type != OGS_GTPU_MSGTYPE_END_MARKER &&
        pkbuf->len <= len) {
        ogs_error("[DROP] Small GTPU packet(type:%d len:%d)",
                header_desc.type, len);
        ogs_log_hexdump(OGS_LOG_ERROR, pkbuf->data, pkbuf->len);
        goto cleanup;
    }

    ogs_trace("[RECV] GPU-U Type [%d] from [%s] : TEID[0x%x]",
            header_desc.type, OGS_ADDR(&from, buf1), header_desc.teid);

    /* Remove GTP header and send packets to TUN interface */
    ogs_assert(ogs_pkbuf_pull(pkbuf, len));

    if (header_desc.type == OGS_GTPU_MSGTYPE_END_MARKER) {
        /* Nothing */

    } else if (header_desc.type == OGS_GTPU_MSGTYPE_ERR_IND) {
        ogs_pfcp_far_t *far = NULL;

        far = ogs_pfcp_far_find_by_gtpu_error_indication(pkbuf);
        if (far) {
            ogs_assert(true ==
                ogs_pfcp_up_handle_error_indication(far, &report));

            if (report.type.error_indication_report) {
                ogs_assert(far->sess);
                sess = UPF_SESS(far->sess);
                ogs_assert(sess);

                ogs_assert(OGS_OK ==
                    upf_pfcp_send_session_report_request(sess, &report));
            }

        } else {
            ogs_error("[DROP] Cannot find FAR by Error-Indication");
            ogs_log_hexdump(OGS_LOG_ERROR, pkbuf->data, pkbuf->len);
        }
    } else if (header_desc.type == OGS_GTPU_MSGTYPE_GPDU) {
        uint16_t eth_type = 0;
        struct ip *ip_h = NULL;
        uint32_t *src_addr = NULL;
        ogs_pfcp_object_t *pfcp_object = NULL;
        ogs_pfcp_sess_t *pfcp_sess = NULL;
        ogs_pfcp_pdr_t *pdr = NULL;
        ogs_pfcp_far_t *far = NULL;

        ogs_pfcp_subnet_t *subnet = NULL;
        ogs_pfcp_dev_t *dev = NULL;
        int i;

        ip_h = (struct ip *)pkbuf->data;
        ogs_assert(ip_h);

        /*
         * Issue #2210, Discussion #2208, #2209
         *
         * Metrics reduce data plane performance.
         * It should not be used on the UPF/SGW-U data plane
         * until this issue is resolved.
         */
#if 0
        upf_metrics_inst_global_inc(UPF_METR_GLOB_CTR_GTP_INDATAPKTN3UPF);
        upf_metrics_inst_by_qfi_add(header_desc.qos_flow_identifier,
                UPF_METR_CTR_GTP_INDATAVOLUMEQOSLEVELN3UPF, pkbuf->len);
#endif

        pfcp_object = ogs_pfcp_object_find_by_teid(header_desc.teid);
        if (!pfcp_object) {
            /*
             * TS23.527 Restoration procedures
             * 4.3 UPF Restoration Procedures
             * 4.3.2 Restoration Procedure for PSA UPF Restart
             *
             * The UPF shall not send GTP-U Error indication message
             * for a configurable period after an UPF restart
             * when the UPF receives a G-PDU not matching any PDRs.
             */
            if (ogs_time_ntp32_now() >
                   (ogs_pfcp_self()->local_recovery +
                    ogs_time_sec(ogs_local_conf()->time.message.pfcp.
                        association_interval))) {
                ogs_error("[%s] Send Error Indication [TEID:0x%x] to [%s]",
                        OGS_ADDR(&sock->local_addr, buf1),
                        header_desc.teid,
                        OGS_ADDR(&from, buf2));
                ogs_gtp1_send_error_indication(
                        sock, header_desc.teid,
                        header_desc.qos_flow_identifier, &from);
            }
            goto cleanup;
        }

        switch(pfcp_object->type) {
        case OGS_PFCP_OBJ_PDR_TYPE:
            /* UPF does not use PDR TYPE */
            ogs_assert_if_reached();
            pdr = (ogs_pfcp_pdr_t *)pfcp_object;
            ogs_assert(pdr);
            break;
        case OGS_PFCP_OBJ_SESS_TYPE:
            pfcp_sess = (ogs_pfcp_sess_t *)pfcp_object;
            ogs_assert(pfcp_sess);

            ogs_list_for_each(&pfcp_sess->pdr_list, pdr) {

                /*
                 * Originally, we checked the Source Interface
                 * for packets received with a TEID.
                 *
                 * However, in the case of Home Routed Roaming,
                 * packets arriving at the V-UPF from the Core
                 * do not come through a TUN interface
                 * but as standard GTP-U packets.
                 *
                 * Therefore, this code has been removed to support
                 * the roaming functionality.
                 */
#if 0 /* <DEPRECATED> */
                if (pdr->src_if != OGS_PFCP_INTERFACE_ACCESS &&
                    pdr->src_if != OGS_PFCP_INTERFACE_CP_FUNCTION)
                    continue;
#endif

                /* Check if TEID */
                if (header_desc.teid != pdr->f_teid.teid)
                    continue;

                /* Check if QFI */
                if (pdr->qfi && pdr->qfi != header_desc.qos_flow_identifier)
                    continue;

                /* Check if Rule List in PDR */
                if (ogs_list_first(&pdr->rule_list) &&
                    ogs_pfcp_pdr_rule_find_by_packet(pdr, pkbuf) == NULL)
                    continue;

                break;
            }

            if (!pdr) {
                /*
                 * TS23.527 Restoration procedures
                 * 4.3 UPF Restoration Procedures
                 * 4.3.2 Restoration Procedure for PSA UPF Restart
                 *
                 * The UPF shall not send GTP-U Error indication message
                 * for a configurable period after an UPF restart
                 * when the UPF receives a G-PDU not matching any PDRs.
                 */
                if (ogs_time_ntp32_now() >
                       (ogs_pfcp_self()->local_recovery +
                        ogs_time_sec(ogs_local_conf()->time.message.pfcp.
                            association_interval))) {
                    ogs_error(
                            "[%s] Send Error Indication [TEID:0x%x] to [%s]",
                            OGS_ADDR(&sock->local_addr, buf1),
                            header_desc.teid,
                            OGS_ADDR(&from, buf2));
                    ogs_gtp1_send_error_indication(
                            sock, header_desc.teid,
                            header_desc.qos_flow_identifier, &from);
                }
                goto cleanup;
            }

            break;
        default:
            ogs_fatal("Unknown type [%d]", pfcp_object->type);
            ogs_assert_if_reached();
        }

        ogs_assert(pdr);
        ogs_assert(pdr->sess);
        ogs_assert(pdr->sess->obj.type == OGS_PFCP_OBJ_SESS_TYPE);

        sess = UPF_SESS(pdr->sess);
        ogs_assert(sess);

        far = pdr->far;
        ogs_assert(far);

        /*
         * From Issue #1354
         *
         * Do not check Router Advertisement
         *    pdr->src_if = OGS_PFCP_INTERFACE_CP_FUNCTION;
         *    far->dst_if = OGS_PFCP_INTERFACE_ACCESS;
         *
         * Do not check Indirect Tunnel
         *    pdr->dst_if = OGS_PFCP_INTERFACE_ACCESS;
         *    far->dst_if = OGS_PFCP_INTERFACE_ACCESS;
         */

        /*
         * The implementation was initially based on Issue #1354,
         * where the system was designed not to perform checks
         * when FAR->dst_if was set to ACCESS.
         *
         * However, this has now been updated
         * to a new approach that checks for IP source spoofing
         * only when PDR->src_if is set to ACCESS.
         *
         * That said, for Home Routed Roaming scenarios, the system skips
         * this process during uplink traffic, as the V-UPF does not hold
         * IP address information in such cases.
         *
         * <Normal>
         * o DL
         *  PDR->src : Core/N6
         *  FAT->dst : Access/N3
         * o UL
         *  PDR->src : Access/N3
         *  FAT->dst : Core/N6
         * o CP2UP
         *  PDR->src : CP-function
         *  FAT->dst : Access/N3
         * o UP2CP
         *  PDR->src : Access/N3
         *  FAT->dst : CP-function
         *
         * <Indirect>
         *  PDR->src : Access/UL-Forwarding
         *  FAT->dst : Access/DL-Forwarding
         *
         * <Home Routed Roaming>
         * - VPLMN
         * o DL
         *  PDR->src : Core/N9-for-roaming
         *  FAT->dst : Access/N3
         * o UL
         *  PDR->src : Access/N3
         *  FAT->dst : Core/N9-for-roaming
         * - HPLMN
         * o DL
         *  PDR->src : Core/N6
         *  FAT->dst : Access/N9-for-roaming
         * o UL
         *  PDR->src : Access/N9-for-roaming
         *  FAT->dst : Core/N6
         */

        /*
         * We first verify whether the Source Interface of the PDR is set
         * to ACCESS and if it corresponds to N3 3GPP ACCESS.
         *
         * This is because IP source spoofing checks are performed only
         * in such cases.
         */
        if (pdr->src_if == OGS_PFCP_INTERFACE_ACCESS &&
            pdr->src_if_type_presence == true &&
            (pdr->src_if_type == OGS_PFCP_3GPP_INTERFACE_TYPE_N3_3GPP_ACCESS ||
             pdr->src_if_type == OGS_PFCP_3GPP_INTERFACE_TYPE_N9_FOR_ROAMING)) {

            if (far->dst_if_type_presence == true &&
                far->dst_if_type ==
                    OGS_PFCP_3GPP_INTERFACE_TYPE_N9_FOR_ROAMING) {
                /*
                 * <SKIP>
                 *
                 * However, Home Routed Roaming is excluded from this check,
                 * as the V-UPF does not have the necessary IP address
                 * information to perform the verification.
                 */

            } else if (sess->eth_dev) {
                /* Ethernet PDU session: GTP-U payload is a full Ethernet
                 * frame, not an IP packet. Skip IP spoofing check. */

            } else if (ip_h->ip_v == 4 && sess->ipv4) {
                src_addr = (void *)&ip_h->ip_src.s_addr;
                ogs_assert(src_addr);

                if (src_addr[0] == sess->ipv4->addr[0]) {
                    /* Source IP address should be matched in uplink */
                } else if (check_framed_routes(sess, AF_INET, src_addr)) {
                    /* Or source IP address should match a framed route */
                } else {
                    ogs_error("[DROP] Source IP-%d Spoofing APN:%s SrcIf:%d DstIf:%d TEID:0x%x",
                                ip_h->ip_v, pdr->dnn, pdr->src_if, far->dst_if, header_desc.teid);
                    ogs_error("       SRC:%08X, UE:%08X",
                        be32toh(src_addr[0]), be32toh(sess->ipv4->addr[0]));
                    ogs_log_hexdump(OGS_LOG_ERROR, pkbuf->data, pkbuf->len);

                    goto cleanup;
                }

                subnet = sess->ipv4->subnet;
                eth_type = ETHERTYPE_IP;

            } else if (ip_h->ip_v == 6 && sess->ipv6) {
                struct ip6_hdr *ip6_h = (struct ip6_hdr *)pkbuf->data;
                ogs_assert(ip6_h);
                src_addr = (void *)ip6_h->ip6_src.s6_addr;
                ogs_assert(src_addr);

    /*
     * Discussion #1776 was raised,
     * but we decided not to allow unspecified addresses
     * because Open5GS has already sent interface identifiers
     * in the registgration/attach process.
     *
     *
     * RFC4861
     * 4.  Message Formats
     * 4.1.  Router Solicitation Message Format
     * IP Fields:
     *    Source Address
     *                  An IP address assigned to the sending interface, or
     *                  the unspecified address if no address is assigned
     *                  to the sending interface.
     *
     * 6.1.  Message Validation
     * 6.1.1.  Validation of Router Solicitation Messages
     *  Hosts MUST silently discard any received Router Solicitation
     *  Messages.
     *
     *  A router MUST silently discard any received Router Solicitation
     *  messages that do not satisfy all of the following validity checks:
     *
     *  ..
     *  ..
     *
     *  - If the IP source address is the unspecified address, there is no
     *    source link-layer address option in the message.
     */
                if (IN6_IS_ADDR_LINKLOCAL((struct in6_addr *)src_addr) &&
                    src_addr[2] == sess->ipv6->addr[2] &&
                    src_addr[3] == sess->ipv6->addr[3]) {
                    /*
                     * if Link-local address,
                     * Interface Identifier should be matched
                     */
                } else if (src_addr[0] == sess->ipv6->addr[0] &&
                            src_addr[1] == sess->ipv6->addr[1]) {
                    /*
                     * If Global address
                     * 64 bit prefix should be matched
                     */
                } else if (check_framed_routes(sess, AF_INET6, src_addr)) {
                    /* Or source IP address should match a framed route */
                } else {
                    ogs_error("[DROP] Source IP-%d Spoofing APN:%s SrcIf:%d DstIf:%d TEID:0x%x",
                                ip_h->ip_v, pdr->dnn, pdr->src_if, far->dst_if, header_desc.teid);
                    ogs_error("SRC:%08x %08x %08x %08x",
                            be32toh(src_addr[0]), be32toh(src_addr[1]),
                            be32toh(src_addr[2]), be32toh(src_addr[3]));
                    ogs_error("UE:%08x %08x %08x %08x",
                            be32toh(sess->ipv6->addr[0]),
                            be32toh(sess->ipv6->addr[1]),
                            be32toh(sess->ipv6->addr[2]),
                            be32toh(sess->ipv6->addr[3]));
                    ogs_log_hexdump(OGS_LOG_ERROR, pkbuf->data, pkbuf->len);

                    goto cleanup;
                }

                subnet = sess->ipv6->subnet;
                eth_type = ETHERTYPE_IPV6;

            } else {
                ogs_error("Invalid packet [IP version:%d, Packet Length:%d]",
                        ip_h->ip_v, pkbuf->len);
                ogs_log_hexdump(OGS_LOG_ERROR, pkbuf->data, pkbuf->len);
                goto cleanup;
            }

        }

        if (sess->eth_dev ||
            (far->dst_if == OGS_PFCP_INTERFACE_CORE &&
             far->dst_if_type_presence == true &&
             far->dst_if_type == OGS_PFCP_3GPP_INTERFACE_TYPE_N6)) {
            /*
             * Ethernet PDU sessions always reach the DN via the local NW-TT
             * TAP/bridge. The SMF's TSN bridge model sets the uplink FAR
             * dst_if to a 5G-VN/CP interface (not CORE/N6), so gate the TAP
             * write on sess->eth_dev rather than the destination interface.
             * Without this, uplink Ethernet frames were silently skipped.
             */

            if (sess->eth_dev) {
                /* Ethernet PDU: write frame directly to TAP */
                dev = sess->eth_dev;
                ogs_assert(dev);

                if (sess->tsc.nwtt_port) {
                    sess->tsc.nwtt_port->traffic.rx_frames++;
                    sess->tsc.nwtt_port->traffic.rx_bytes += pkbuf->len;
                    upf_nwtt_port_update_jitter(
                            sess->tsc.nwtt_port,
                            upf_nwtt_clock_gettime_ns());
                }

                for (i = 0; i < pdr->num_of_urr; i++)
                    upf_sess_urr_acc_add(
                            sess, pdr->urr[i], pkbuf->len, true);

                /* MAC address learning from Ethernet PDU frames */
                if (pkbuf->len >= 14)
                    upf_sess_learn_ue_mac(sess, pkbuf->data + 6);

                /* NW-TT processing for Ethernet frames */
                if (dev->is_tap && sess->tsc.is_tsn) {
                    if (upf_self()->nwtt_bridge.gptp.enabled &&
                            upf_nwtt_is_gptp_frame(
                                pkbuf->data, pkbuf->len)) {
                        upf_nwtt_gptp_add_residence_time(
                                pkbuf->data, pkbuf->len,
                                upf_nwtt_clock_gettime_ns());
                    }
                    if (sess->tsc.nwtt_port &&
                            !upf_nwtt_psfp_check(sess->tsc.nwtt_port,
                                pkbuf->data, pkbuf->len)) {
                        ogs_debug("[NW-TT] PSFP drop on Ethernet egress");
                        goto cleanup;
                    }
                }

                /* UE-to-UE hairpinning for Ethernet PDU sessions */
                if (pkbuf->len >= 14) {
                    uint8_t *dest_mac = pkbuf->data;

                    if (dest_mac[0] & 0x01) {
                        /* Broadcast/Multicast: send to TAP AND
                         * replicate to all other UE sessions */
                        upf_sess_t *other = NULL;

                        /* Write to TAP for DN first */
                        ogs_pkbuf_t *dn_copy = ogs_pkbuf_copy(pkbuf);
                        if (dn_copy) {
                            if (ogs_tun_write(dev->fd, dn_copy) != OGS_OK)
                                ogs_warn("ogs_tun_write() failed "
                                        "[broadcast to DN]");
                            ogs_pkbuf_free(dn_copy);
                        }

                        /* Replicate to other UEs on same TAP */
                        ogs_list_for_each(&upf_self()->sess_list, other) {
                            ogs_pfcp_pdr_t *hp_pdr = NULL;
                            ogs_pfcp_user_plane_report_t hp_report;
                            ogs_pkbuf_t *ue_copy = NULL;

                            if (other == sess) continue;
                            if (!other->eth_dev ||
                                    other->eth_dev != sess->eth_dev)
                                continue;
                            if (other->num_of_ue_macs == 0) continue;

                            /* Find Core→Access PDR */
                            ogs_list_for_each(
                                    &other->pfcp.pdr_list, hp_pdr) {
                                if (hp_pdr->src_if ==
                                        OGS_PFCP_INTERFACE_CORE)
                                    break;
                            }
                            if (!hp_pdr) continue;

                            ue_copy = ogs_pkbuf_copy(pkbuf);
                            if (!ue_copy) continue;

                            memset(&hp_report, 0, sizeof(hp_report));
                            ogs_assert(true ==
                                ogs_pfcp_up_handle_pdr(
                                    hp_pdr, OGS_GTPU_MSGTYPE_GPDU,
                                    0, NULL, ue_copy, &hp_report));
                        }
                        goto cleanup;

                    } else {
                        /* Unicast: check if dest MAC is another UE */
                        upf_sess_t *dest_sess =
                                upf_sess_find_by_mac(dest_mac);

                        if (dest_sess && dest_sess != sess &&
                                dest_sess->eth_dev == sess->eth_dev) {
                            /* Hairpin: send via dest UE's GTP-U tunnel */
                            ogs_pfcp_pdr_t *hp_pdr = NULL;
                            ogs_pfcp_user_plane_report_t hp_report;

                            ogs_list_for_each(
                                    &dest_sess->pfcp.pdr_list, hp_pdr) {
                                if (hp_pdr->src_if ==
                                        OGS_PFCP_INTERFACE_CORE)
                                    break;
                            }

                            if (hp_pdr) {
                                ogs_debug("[NW-TT] Hairpin: "
                                    "%02x:%02x:%02x:%02x:%02x:%02x -> "
                                    "%02x:%02x:%02x:%02x:%02x:%02x",
                                    pkbuf->data[6],
                                    pkbuf->data[7],
                                    pkbuf->data[8],
                                    pkbuf->data[9],
                                    pkbuf->data[10],
                                    pkbuf->data[11],
                                    dest_mac[0], dest_mac[1],
                                    dest_mac[2], dest_mac[3],
                                    dest_mac[4], dest_mac[5]);

                                memset(&hp_report, 0,
                                        sizeof(hp_report));
                                ogs_assert(true ==
                                    ogs_pfcp_up_handle_pdr(
                                        hp_pdr,
                                        OGS_GTPU_MSGTYPE_GPDU,
                                        0, NULL, pkbuf,
                                        &hp_report));
                                /* pkbuf consumed by handle_pdr */
                                return;
                            }
                        }
                    }
                }

                /* Normal path: write to TAP */
                if (ogs_tun_write(dev->fd, pkbuf) != OGS_OK)
                    ogs_warn("ogs_tun_write() failed [Ethernet PDU]");
                goto cleanup;
            }

            if (!subnet) {
#if 0 /* It's redundant log message */
                ogs_error("[DROP] Cannot find subnet V:%d, IPv4:%p, IPv6:%p",
                        ip_h->ip_v, sess->ipv4, sess->ipv6);
                ogs_log_hexdump(OGS_LOG_ERROR, pkbuf->data, pkbuf->len);
#endif
                goto cleanup;
            }

            dev = subnet->dev;
            ogs_assert(dev);

            /* Increment total & ul octets + pkts */
            for (i = 0; i < pdr->num_of_urr; i++)
                upf_sess_urr_acc_add(sess, pdr->urr[i], pkbuf->len, true);

            if (dev->is_tap) {
                /* Check if this is a gPTP frame arriving in GTP-U */
                if (sess->tsc.is_tsn &&
                    upf_self()->nwtt_bridge.gptp.enabled &&
                    upf_nwtt_is_gptp_frame(pkbuf->data, pkbuf->len)) {
                    /* gPTP: add residence time and write directly to TAP
                     * (frame already has Ethernet header from GTP-U) */
                    upf_nwtt_gptp_add_residence_time(
                            pkbuf->data, pkbuf->len,
                            upf_nwtt_clock_gettime_ns());
                    if (ogs_tun_write(dev->fd, pkbuf) != OGS_OK)
                        ogs_warn("ogs_tun_write() failed");
                    goto cleanup;
                }

                /* LLDP from UE (GTP-U) → parse, store neighbor, relay */
                if (sess->tsc.is_tsn &&
                    upf_self()->nwtt_bridge.enabled &&
                    upf_nwtt_is_lldp_frame(pkbuf->data, pkbuf->len)) {
                    ogs_debug("[NW-TT] LLDP frame from UE (%d bytes)",
                            pkbuf->len);

                    /* Parse and store LLDP neighbor info */
                    if (sess->tsc.nwtt_port) {
                        if (upf_nwtt_parse_lldp(pkbuf->data, pkbuf->len,
                                &sess->tsc.nwtt_port->lldp_neighbor)
                                == OGS_OK) {
                            sess->tsc.nwtt_port->lldp_neighbor_valid = true;
                        }
                        sess->tsc.nwtt_port->traffic.rx_lldp_frames++;

                        /* Relay to other ports via GTP-U */
                        upf_nwtt_relay_lldp_frame(sess->tsc.nwtt_port,
                                pkbuf->data, pkbuf->len);
                    }

                    /* Also write to TAP for DN */
                    if (ogs_tun_write(dev->fd, pkbuf) != OGS_OK)
                        ogs_warn("ogs_tun_write() failed for LLDP relay");
                    goto cleanup;
                }

                /* NW-TT egress: PSFP metering before sending to DN */
                if (sess->tsc.is_tsn && sess->tsc.nwtt_port) {
                    if (!upf_nwtt_psfp_check(sess->tsc.nwtt_port,
                            pkbuf->data, pkbuf->len + 14)) {
                        ogs_debug("[NW-TT] PSFP meter drop on egress");
                        goto cleanup;
                    }
                    sess->tsc.nwtt_port->traffic.rx_frames++;
                    sess->tsc.nwtt_port->traffic.rx_bytes += pkbuf->len;
                }

                /* Construct Ethernet header */
                ogs_assert(eth_type);
                eth_type = htobe16(eth_type);
                ogs_pkbuf_push(pkbuf, sizeof(eth_type));
                memcpy(pkbuf->data, &eth_type, sizeof(eth_type));
                ogs_pkbuf_push(pkbuf, ETHER_ADDR_LEN);
                memcpy(pkbuf->data, proxy_mac_addr, ETHER_ADDR_LEN);
                ogs_pkbuf_push(pkbuf, ETHER_ADDR_LEN);
                memcpy(pkbuf->data, dev->mac_addr, ETHER_ADDR_LEN);

                /* NW-TT egress: insert 802.1Q VLAN tag with PCP from
                 * reverse QFI→PCP mapping for TSN QoS on the DN */
                if (sess->tsc.is_tsn && sess->tsc.nwtt_port &&
                    pdr->qer && pdr->qer->qfi) {
                    int nwtt_pcp = upf_nwtt_reverse_qfi_to_pcp(
                            sess->tsc.nwtt_port, pdr->qer->qfi);
                    if (nwtt_pcp >= 0) {
                        uint16_t tpid = htobe16(0x8100);
                        uint16_t tci = htobe16(
                                ((uint16_t)nwtt_pcp << 13));
                        /* Make room for 4-byte VLAN tag, shift MACs back */
                        ogs_pkbuf_push(pkbuf, 4);
                        memmove(pkbuf->data, pkbuf->data + 4, 12);
                        memcpy(pkbuf->data + 12, &tpid, 2);
                        memcpy(pkbuf->data + 14, &tci, 2);
                        ogs_debug("[NW-TT] Egress: inserted 802.1Q tag "
                                "PCP=%d for QFI=%u",
                                nwtt_pcp, pdr->qer->qfi);
                    }
                }
            }

            /*
             * Hairpinning for IP PDU sessions is handled by IP routing
             * via the TUN/TAP interface and the kernel. For Ethernet PDU
             * sessions, hairpinning is handled above via MAC learning.
             */
            if (ogs_tun_write(dev->fd, pkbuf) != OGS_OK)
                ogs_warn("ogs_tun_write() failed");

        } else {

            /*
             * The following code is unnecessary and has been removed.
             * The reason for its initial implementation is unclear.
             */
#if 0 /* <DEPRECATED> */
            if (far->dst_if == OGS_PFCP_INTERFACE_CP_FUNCTION) {
                if (!far->gnode) {
                    ogs_error("No Outer Header Creation in FAR");
                    goto cleanup;
                }

                if ((far->apply_action & OGS_PFCP_APPLY_ACTION_FORW) == 0) {
                    ogs_error("Not supported Apply Action [0x%x]",
                                far->apply_action);
                    goto cleanup;
                }
            }
#endif

            ogs_assert(true == ogs_pfcp_up_handle_pdr(
                        pdr, header_desc.type, len, &header_desc,
                        pkbuf, &report));

#if 0 /* <DEPRECATED> */
            if (far->dst_if == OGS_PFCP_INTERFACE_CP_FUNCTION) {
                ogs_assert(report.type.downlink_data_report == 0);
            }
#endif

            if (report.type.downlink_data_report) {
                ogs_error("User Traffic Buffered");

                report.downlink_data.pdr_id = pdr->id;
                if (pdr->qer && pdr->qer->qfi)
                    report.downlink_data.qfi = pdr->qer->qfi; /* for 5GC */

                ogs_assert(OGS_OK ==
                    upf_pfcp_send_session_report_request(sess, &report));
            }

            /*
             * The ogs_pfcp_up_handle_pdr() function
             * buffers or frees the Packet Buffer(pkbuf) memory.
             */
            return;
        }
    } else {
        ogs_error("[DROP] Invalid GTPU Type [%d]", header_desc.type);
        ogs_log_hexdump(OGS_LOG_ERROR, pkbuf->data, pkbuf->len);
    }

cleanup:
    ogs_pkbuf_free(pkbuf);
}

int upf_gtp_init(void)
{
    ogs_pkbuf_config_t config;
    memset(&config, 0, sizeof config);

    config.cluster_2048_pool = ogs_app()->pool.gtpu;

#if OGS_USE_TALLOC == 1
    /* allocate a talloc pool for GTP to ensure it doesn't have to go back
     * to the libc malloc all the time */
    packet_pool = talloc_pool(__ogs_talloc_core, 1000*1024);
    ogs_assert(packet_pool);
#else
    packet_pool = ogs_pkbuf_pool_create(&config);
#endif

    return OGS_OK;
}

void upf_gtp_final(void)
{
    ogs_pkbuf_pool_destroy(packet_pool);
}

static void _get_dev_mac_addr(char *ifname, uint8_t *mac_addr)
{
#ifdef SIOCGIFHWADDR
    int fd = socket(PF_INET, SOCK_DGRAM, 0);
    ogs_assert(fd);
    struct ifreq req;
    memset(&req, 0, sizeof(req));
    ogs_cpystrn(req.ifr_name, ifname, IF_NAMESIZE-1);
    ogs_assert(ioctl(fd, SIOCGIFHWADDR, &req) == 0);
    memcpy(mac_addr, req.ifr_hwaddr.sa_data, ETHER_ADDR_LEN);
#else
    struct ifaddrs *ifap;
    ogs_assert(getifaddrs(&ifap) == 0);
    struct ifaddrs *p;
    for (p = ifap; p; p = p->ifa_next) {
        if (strncmp(ifname, p->ifa_name, IF_NAMESIZE-1) == 0) {
            struct sockaddr_dl* sdp = (struct sockaddr_dl*) p->ifa_addr;
            memcpy(mac_addr, sdp->sdl_data + sdp->sdl_nlen, ETHER_ADDR_LEN);
            freeifaddrs(ifap);
            return;
        }
    }
    ogs_assert(0); /* interface not found. */
#endif
}

int upf_gtp_open(void)
{
    ogs_pfcp_dev_t *dev = NULL;
    ogs_pfcp_subnet_t *subnet = NULL;
    ogs_socknode_t *node = NULL;
    ogs_sock_t *sock = NULL;
    int rc;

    ogs_list_for_each(&ogs_gtp_self()->gtpu_list, node) {
        sock = ogs_gtp_server(node);
        if (!sock) return OGS_ERROR;

        if (sock->family == AF_INET)
            ogs_gtp_self()->gtpu_sock = sock;
        else if (sock->family == AF_INET6)
            ogs_gtp_self()->gtpu_sock6 = sock;

        node->poll = ogs_pollset_add(ogs_app()->pollset,
                OGS_POLLIN, sock->fd, _gtpv1_u_recv_cb, sock);
        ogs_assert(node->poll);
    }

    OGS_SETUP_GTPU_SERVER;

    /* NOTE : tun device can be created via following command.
     *
     * $ sudo ip tuntap add name ogstun mode tun
     *
     * Also, before running upf, assign the one IP from IP pool of UE
     * to ogstun. The IP should not be assigned to UE
     *
     * $ sudo ifconfig ogstun 45.45.0.1/16 up
     *
     */

    /* Open Tun interface */
    ogs_list_for_each(&ogs_pfcp_self()->dev_list, dev) {
        dev->is_tap = strstr(dev->ifname, "tap");
        dev->fd = ogs_tun_open(dev->ifname, OGS_MAX_IFNAME_LEN, dev->is_tap);
        if (dev->fd == INVALID_SOCKET) {
            ogs_error("tun_open(dev:%s) failed", dev->ifname);
            return OGS_ERROR;
        }

        if (dev->is_tap) {
            _get_dev_mac_addr(dev->ifname, dev->mac_addr);
            dev->poll = ogs_pollset_add(ogs_app()->pollset,
                    OGS_POLLIN, dev->fd, _gtpv1_tun_recv_eth_cb, NULL);
            ogs_assert(dev->poll);
        } else {
            dev->poll = ogs_pollset_add(ogs_app()->pollset,
                    OGS_POLLIN, dev->fd, _gtpv1_tun_recv_cb, NULL);
            ogs_assert(dev->poll);
        }

        ogs_assert(dev->poll);
    }

    /*
     * On Linux, it is possible to create a persistent tun/tap
     * interface which will continue to exist even if open5gs quit,
     * although this is normally not required.
     * It can be useful to set up a tun/tap interface owned
     * by a non-root user, so open5gs can be started without
     * needing any root privileges at all.
     */

    /* Set P-to-P IP address with Netmask
     * Note that Linux will skip this configuration */
    ogs_list_for_each(&ogs_pfcp_self()->subnet_list, subnet) {
        ogs_assert(subnet->dev);
        if (subnet->family == AF_UNSPEC)
            continue;  /* Ethernet session — no IP to set */
        rc = ogs_tun_set_ip(subnet->dev->ifname, &subnet->gw, &subnet->sub);
        if (rc != OGS_OK) {
            ogs_error("ogs_tun_set_ip(dev:%s) failed", subnet->dev->ifname);
            return OGS_ERROR;
        }
    }

    return OGS_OK;
}

void upf_gtp_close(void)
{
    ogs_pfcp_dev_t *dev = NULL;

    ogs_socknode_remove_all(&ogs_gtp_self()->gtpu_list);

    ogs_list_for_each(&ogs_pfcp_self()->dev_list, dev) {
        if (dev->poll)
            ogs_pollset_remove(dev->poll);
        ogs_closesocket(dev->fd);
    }
}

static void upf_gtp_handle_multicast(ogs_pkbuf_t *recvbuf)
{
    struct ip *ip_h =  NULL;
    struct ip6_hdr *ip6_h = NULL;
    ogs_pfcp_user_plane_report_t report;

    ip_h = (struct ip *)recvbuf->data;
    if (ip_h->ip_v == 6) {
#if COMPILE_ERROR_IN_MAC_OS_X  /* Compiler error in Mac OS X platform */
        ip6_h = (struct ip6_hdr *)recvbuf->data;
        if (IN6_IS_ADDR_MULTICAST(&ip6_h->ip6_dst))
#else
        struct in6_addr ip6_dst;
        ip6_h = (struct ip6_hdr *)recvbuf->data;
        memcpy(&ip6_dst, &ip6_h->ip6_dst, sizeof(struct in6_addr));
        if (IN6_IS_ADDR_MULTICAST(&ip6_dst))
#endif
        {
            upf_sess_t *sess = NULL;

            /* IPv6 Multicast */
            ogs_list_for_each(&upf_self()->sess_list, sess) {
                if (sess->ipv6) {
                    /* PDN IPv6 is available */
                    ogs_pfcp_pdr_t *pdr = NULL;

                    ogs_list_for_each(&sess->pfcp.pdr_list, pdr) {
                        if (pdr->src_if == OGS_PFCP_INTERFACE_CORE) {
                            ogs_pkbuf_t *sendbuf = ogs_pkbuf_copy(recvbuf);
                            ogs_assert(sendbuf);
                            ogs_assert(true ==
                                ogs_pfcp_up_handle_pdr(
                                    pdr, OGS_GTPU_MSGTYPE_GPDU, 0,
                                    NULL, sendbuf, &report));
                            break;
                        }
                    }

                    return;
                }
            }
        }
    }
}
