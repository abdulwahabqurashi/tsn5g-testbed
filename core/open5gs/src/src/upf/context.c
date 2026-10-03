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
#include "pfcp-path.h"

static upf_context_t self;

int __upf_log_domain;

static OGS_POOL(upf_sess_pool, upf_sess_t);
static OGS_POOL(upf_n4_seid_pool, ogs_pool_id_t);

static int context_initialized = 0;

static void upf_sess_urr_acc_remove_all(upf_sess_t *sess);

void upf_context_init(void)
{
    ogs_assert(context_initialized == 0);

    /* Initialize UPF context */
    memset(&self, 0, sizeof(upf_context_t));

    ogs_log_install_domain(&__upf_log_domain, "upf", ogs_core()->log.level);

    /* Setup UP Function Features */
    ogs_pfcp_self()->up_function_features.ftup = 1;
    ogs_pfcp_self()->up_function_features.empu = 1;
    ogs_pfcp_self()->up_function_features.mnop = 1;
    ogs_pfcp_self()->up_function_features.vtime = 1;
    ogs_pfcp_self()->up_function_features.frrt = 1;
    ogs_pfcp_self()->up_function_features_len = 4;

    ogs_list_init(&self.sess_list);
    ogs_pool_init(&upf_sess_pool, ogs_app()->pool.sess);
    ogs_pool_init(&upf_n4_seid_pool, ogs_app()->pool.sess);
    ogs_pool_random_id_generate(&upf_n4_seid_pool);

    /* Initialize NW-TT bridge */
    memset(&self.nwtt_bridge, 0, sizeof(self.nwtt_bridge));
    ogs_list_init(&self.nwtt_bridge.port_list);
    self.nwtt_bridge.next_port_number = 1;

    self.upf_n4_seid_hash = ogs_hash_make();
    ogs_assert(self.upf_n4_seid_hash);
    self.smf_n4_seid_hash = ogs_hash_make();
    ogs_assert(self.smf_n4_seid_hash);
    self.smf_n4_f_seid_hash = ogs_hash_make();
    ogs_assert(self.smf_n4_f_seid_hash);
    self.ipv4_hash = ogs_hash_make();
    ogs_assert(self.ipv4_hash);
    self.ipv6_hash = ogs_hash_make();
    ogs_assert(self.ipv6_hash);
    self.mac_hash = ogs_hash_make();
    ogs_assert(self.mac_hash);

    context_initialized = 1;
}

static void free_upf_route_trie_node(struct upf_route_trie_node *node)
{
    if (!node)
        return;
    free_upf_route_trie_node(node->left);
    free_upf_route_trie_node(node->right);
    ogs_free(node);
}

void upf_context_final(void)
{
    ogs_assert(context_initialized == 1);

    /* Remove all sessions first - this also cleans up NW-TT ports
     * via upf_sess_remove() -> upf_nwtt_port_remove() */
    upf_sess_remove_all();

    /* Free remaining NW-TT bridge resources (mgmt container only;
     * ports were already freed by session removal above) */
    if (self.nwtt_bridge.bridge_mgmt_container)
        ogs_free(self.nwtt_bridge.bridge_mgmt_container);

    ogs_assert(self.upf_n4_seid_hash);
    ogs_hash_destroy(self.upf_n4_seid_hash);
    ogs_assert(self.smf_n4_seid_hash);
    ogs_hash_destroy(self.smf_n4_seid_hash);
    ogs_assert(self.smf_n4_f_seid_hash);
    ogs_hash_destroy(self.smf_n4_f_seid_hash);
    ogs_assert(self.ipv4_hash);
    ogs_hash_destroy(self.ipv4_hash);
    ogs_assert(self.ipv6_hash);
    ogs_hash_destroy(self.ipv6_hash);
    ogs_assert(self.mac_hash);
    ogs_hash_destroy(self.mac_hash);

    free_upf_route_trie_node(self.ipv4_framed_routes);
    free_upf_route_trie_node(self.ipv6_framed_routes);

    ogs_pool_final(&upf_sess_pool);
    ogs_pool_final(&upf_n4_seid_pool);

    context_initialized = 0;
}

upf_context_t *upf_self(void)
{
    return &self;
}

static int upf_context_prepare(void)
{
    return OGS_OK;
}

static int upf_context_validation(void)
{
    if (ogs_list_first(&ogs_gtp_self()->gtpu_list) == NULL) {
        ogs_error("No upf.gtpu.address in '%s'", ogs_app()->file);
        return OGS_ERROR;
    }
    if (ogs_list_first(&ogs_pfcp_self()->subnet_list) == NULL) {
        ogs_error("No upf.session.subnet: in '%s'", ogs_app()->file);
        return OGS_ERROR;
    }
    return OGS_OK;
}

int upf_context_parse_config(void)
{
    int rv;
    yaml_document_t *document = NULL;
    ogs_yaml_iter_t root_iter;
    int idx = 0;

    document = ogs_app()->document;
    ogs_assert(document);

    rv = upf_context_prepare();
    if (rv != OGS_OK) return rv;

    ogs_yaml_iter_init(&root_iter, document);
    while (ogs_yaml_iter_next(&root_iter)) {
        const char *root_key = ogs_yaml_iter_key(&root_iter);
        ogs_assert(root_key);
        if ((!strcmp(root_key, "upf")) &&
            (idx++ == ogs_app()->config_section_id)) {
            ogs_yaml_iter_t upf_iter;
            ogs_yaml_iter_recurse(&root_iter, &upf_iter);
            while (ogs_yaml_iter_next(&upf_iter)) {
                const char *upf_key = ogs_yaml_iter_key(&upf_iter);
                ogs_assert(upf_key);
                if (!strcmp(upf_key, "gtpu")) {
                    /* handle config in gtp library */
                } else if (!strcmp(upf_key, "pfcp")) {
                    /* handle config in pfcp library */
                } else if (!strcmp(upf_key, "smf")) {
                    /* handle config in pfcp library */
                } else if (!strcmp(upf_key, "session")) {
                    /* handle config in pfcp library */
                } else if (!strcmp(upf_key, "metrics")) {
                    /* handle config in metrics library */
                } else if (!strcmp(upf_key, "nwtt")) {
                    ogs_yaml_iter_t nwtt_iter;
                    ogs_yaml_iter_recurse(&upf_iter, &nwtt_iter);
                    while (ogs_yaml_iter_next(&nwtt_iter)) {
                        const char *nwtt_key =
                            ogs_yaml_iter_key(&nwtt_iter);
                        ogs_assert(nwtt_key);
                        if (!strcmp(nwtt_key, "enabled")) {
                            self.nwtt_bridge.enabled =
                                ogs_yaml_iter_bool(&nwtt_iter);
                        } else if (!strcmp(nwtt_key,
                                    "dl_mac_adaptation")) {
                            self.nwtt_bridge.dl_mac_adapt =
                                ogs_yaml_iter_bool(&nwtt_iter);
                        } else if (!strcmp(nwtt_key, "bridge_id")) {
                            self.nwtt_bridge.bridge_id =
                                atoi(ogs_yaml_iter_value(&nwtt_iter));
                        } else if (!strcmp(nwtt_key, "bridge_mac")) {
                            const char *mac_str =
                                ogs_yaml_iter_value(&nwtt_iter);
                            if (mac_str) {
                                unsigned int m[6];
                                if (sscanf(mac_str,
                                        "%02x:%02x:%02x:%02x:%02x:%02x",
                                        &m[0], &m[1], &m[2],
                                        &m[3], &m[4], &m[5]) == 6) {
                                    int mi;
                                    for (mi = 0; mi < 6; mi++)
                                        self.nwtt_bridge.bridge_mac[mi] =
                                            (uint8_t)m[mi];
                                }
                            }
                        } else if (!strcmp(nwtt_key, "qos_mappings")) {
                            ogs_yaml_iter_t qm_array;
                            ogs_yaml_iter_recurse(&nwtt_iter, &qm_array);
                            self.nwtt_bridge.num_default_qos_mappings = 0;
                            do {
                                ogs_yaml_iter_t qm_iter;
                                uint8_t pcp = 0;
                                uint8_t qfi = 0;
                                bool has_pcp = false, has_qfi = false;
                                int idx;

                                if (ogs_yaml_iter_type(&qm_array) ==
                                        YAML_MAPPING_NODE) {
                                    memcpy(&qm_iter, &qm_array,
                                            sizeof(ogs_yaml_iter_t));
                                } else if (ogs_yaml_iter_type(&qm_array) ==
                                        YAML_SEQUENCE_NODE) {
                                    if (!ogs_yaml_iter_next(&qm_array))
                                        break;
                                    ogs_yaml_iter_recurse(&qm_array, &qm_iter);
                                } else if (ogs_yaml_iter_type(&qm_array) ==
                                        YAML_SCALAR_NODE) {
                                    break;
                                } else
                                    ogs_assert_if_reached();

                                while (ogs_yaml_iter_next(&qm_iter)) {
                                    const char *qm_key =
                                        ogs_yaml_iter_key(&qm_iter);
                                    ogs_assert(qm_key);
                                    if (!strcmp(qm_key, "pcp")) {
                                        pcp = atoi(
                                            ogs_yaml_iter_value(&qm_iter));
                                        has_pcp = true;
                                    } else if (!strcmp(qm_key, "qfi")) {
                                        qfi = atoi(
                                            ogs_yaml_iter_value(&qm_iter));
                                        has_qfi = true;
                                    } else
                                        ogs_warn("unknown key `%s`", qm_key);
                                }

                                if (has_pcp && has_qfi) {
                                    idx = self.nwtt_bridge
                                            .num_default_qos_mappings;
                                    if (idx < 8) {
                                        self.nwtt_bridge
                                            .default_qos_mappings[idx].pcp =
                                                pcp;
                                        self.nwtt_bridge
                                            .default_qos_mappings[idx].qfi =
                                                qfi;
                                        self.nwtt_bridge
                                            .default_qos_mappings[idx].active =
                                                true;
                                        self.nwtt_bridge
                                            .num_default_qos_mappings++;
                                        ogs_info("NW-TT QoS mapping: "
                                                "PCP %u -> QFI %u",
                                                pcp, qfi);
                                    }
                                }
                            } while (ogs_yaml_iter_type(&qm_array) ==
                                    YAML_SEQUENCE_NODE);
                        } else if (!strcmp(nwtt_key, "timestamp")) {
                            ogs_yaml_iter_t ts_iter;
                            ogs_yaml_iter_recurse(&nwtt_iter, &ts_iter);
                            while (ogs_yaml_iter_next(&ts_iter)) {
                                const char *ts_key =
                                    ogs_yaml_iter_key(&ts_iter);
                                ogs_assert(ts_key);
                                if (!strcmp(ts_key, "clock_source")) {
                                    const char *v =
                                        ogs_yaml_iter_value(&ts_iter);
                                    if (!strcmp(v, "monotonic") ||
                                        !strcmp(v, "CLOCK_MONOTONIC_RAW"))
                                        self.nwtt_bridge.timestamp
                                            .clock_source =
                                            UPF_NWTT_CLOCK_MONOTONIC;
                                    else if (!strcmp(v, "realtime") ||
                                             !strcmp(v, "CLOCK_REALTIME"))
                                        self.nwtt_bridge.timestamp
                                            .clock_source =
                                            UPF_NWTT_CLOCK_REALTIME;
                                    else
                                        self.nwtt_bridge.timestamp
                                            .clock_source =
                                            UPF_NWTT_CLOCK_SOFTWARE;
                                } else if (!strcmp(ts_key, "phc_interface")) {
                                    const char *v =
                                        ogs_yaml_iter_value(&ts_iter);
                                    if (v)
                                        ogs_cpystrn(
                                            self.nwtt_bridge.timestamp
                                                .phc_interface,
                                            v, sizeof(self.nwtt_bridge
                                                .timestamp.phc_interface));
                                } else
                                    ogs_warn("unknown key `%s`", ts_key);
                            }
                        } else if (!strcmp(nwtt_key, "gptp")) {
                            ogs_yaml_iter_t gptp_iter;
                            ogs_yaml_iter_recurse(&nwtt_iter, &gptp_iter);
                            while (ogs_yaml_iter_next(&gptp_iter)) {
                                const char *gptp_key =
                                    ogs_yaml_iter_key(&gptp_iter);
                                ogs_assert(gptp_key);
                                if (!strcmp(gptp_key, "enabled")) {
                                    self.nwtt_bridge.gptp.enabled =
                                        ogs_yaml_iter_bool(&gptp_iter);
                                } else if (!strcmp(gptp_key,
                                            "time_domain_number")) {
                                    self.nwtt_bridge.gptp.time_domain_number =
                                        atoi(ogs_yaml_iter_value(&gptp_iter));
                                } else if (!strcmp(gptp_key, "monitoring")) {
                                    ogs_yaml_iter_t mon_iter;
                                    ogs_yaml_iter_recurse(
                                            &gptp_iter, &mon_iter);
                                    while (ogs_yaml_iter_next(&mon_iter)) {
                                        const char *mon_key =
                                            ogs_yaml_iter_key(&mon_iter);
                                        ogs_assert(mon_key);
                                        if (!strcmp(mon_key, "enabled")) {
                                            self.nwtt_bridge.gptp
                                                .monitoring_enabled =
                                                ogs_yaml_iter_bool(&mon_iter);
                                        } else if (!strcmp(mon_key,
                                                    "transport_specific")) {
                                            self.nwtt_bridge.gptp
                                                .transport_specific =
                                                atoi(ogs_yaml_iter_value(
                                                        &mon_iter));
                                        } else
                                            ogs_warn("unknown key `%s`",
                                                    mon_key);
                                    }
                                } else if (!strcmp(gptp_key,
                                            "degrade_on_unsync")) {
                                    self.nwtt_bridge.gptp.degrade_on_unsync =
                                        ogs_yaml_iter_bool(&gptp_iter);
                                    if (self.nwtt_bridge.gptp.degrade_on_unsync)
                                        ogs_info("NW-TT gPTP: "
                                                "degrade_on_unsync enabled");
                                } else
                                    ogs_warn("unknown key `%s`", gptp_key);
                            }
                        } else
                            ogs_warn("unknown key `%s`", nwtt_key);
                    }
                    if (self.nwtt_bridge.enabled) {
                        /* Default to CLOCK_MONOTONIC_RAW if not configured */
                        if (self.nwtt_bridge.timestamp.clock_source == 0)
                            self.nwtt_bridge.timestamp.clock_source =
                                UPF_NWTT_CLOCK_MONOTONIC;
                        ogs_info("NW-TT bridge enabled: id=%u, "
                                "timestamp=%s",
                                self.nwtt_bridge.bridge_id,
                                upf_nwtt_clock_source_name(
                                    self.nwtt_bridge.timestamp.clock_source));
                    }
                } else
                    ogs_warn("unknown key `%s`", upf_key);
            }
        }
    }

    rv = upf_context_validation();
    if (rv != OGS_OK) return rv;

    return OGS_OK;
}

upf_sess_t *upf_sess_add(ogs_pfcp_f_seid_t *cp_f_seid)
{
    upf_sess_t *sess = NULL;

    ogs_assert(cp_f_seid);

    ogs_pool_id_calloc(&upf_sess_pool, &sess);
    if (!sess) {
        ogs_error("Maximum number of Session reached");
        return NULL;
    }

    ogs_pfcp_pool_init(&sess->pfcp);

    /* Set UPF-N4-SEID */
    ogs_pool_alloc(&upf_n4_seid_pool, &sess->upf_n4_seid_node);
    ogs_assert(sess->upf_n4_seid_node);

    sess->upf_n4_seid = *(sess->upf_n4_seid_node);

    ogs_hash_set(self.upf_n4_seid_hash, &sess->upf_n4_seid,
            sizeof(sess->upf_n4_seid), sess);

    /* Since F-SEID is composed of ogs_ip_t and uint64-seid,
     * all these values must be put into the structure-smf_n4_f_seid
     * before creating hash */
    sess->smf_n4_f_seid.seid = cp_f_seid->seid;
    ogs_assert(OGS_OK ==
            ogs_pfcp_f_seid_to_ip(cp_f_seid, &sess->smf_n4_f_seid.ip));

    ogs_hash_set(self.smf_n4_f_seid_hash, &sess->smf_n4_f_seid,
            sizeof(sess->smf_n4_f_seid), sess);
    ogs_hash_set(self.smf_n4_seid_hash, &sess->smf_n4_f_seid.seid,
            sizeof(sess->smf_n4_f_seid.seid), sess);

    ogs_list_add(&self.sess_list, sess);
    upf_metrics_inst_global_inc(UPF_METR_GLOB_GAUGE_UPF_SESSIONNBR);

    ogs_info("[Added] Number of UPF-Sessions is now %d",
            ogs_list_count(&self.sess_list));

    return sess;
}

int upf_sess_remove(upf_sess_t *sess)
{
    ogs_assert(sess);

    /* Remove NW-TT port if this was a TSN session */
    if (sess->tsc.nwtt_port) {
        upf_nwtt_port_remove(sess->tsc.nwtt_port);
        sess->tsc.nwtt_port = NULL;
    }

    upf_sess_urr_acc_remove_all(sess);

    ogs_list_remove(&self.sess_list, sess);
    ogs_pfcp_sess_clear(&sess->pfcp);

    ogs_hash_set(self.upf_n4_seid_hash, &sess->upf_n4_seid,
            sizeof(sess->upf_n4_seid), NULL);

    ogs_hash_set(self.smf_n4_seid_hash, &sess->smf_n4_f_seid.seid,
            sizeof(sess->smf_n4_f_seid.seid), NULL);
    ogs_hash_set(self.smf_n4_f_seid_hash, &sess->smf_n4_f_seid,
            sizeof(sess->smf_n4_f_seid), NULL);

    if (sess->ipv4) {
        ogs_hash_set(self.ipv4_hash, sess->ipv4->addr, OGS_IPV4_LEN, NULL);
        ogs_pfcp_ue_ip_free(sess->ipv4);
    }
    if (sess->ipv6) {
        ogs_hash_set(self.ipv6_hash,
                sess->ipv6->addr, OGS_IPV6_DEFAULT_PREFIX_LEN >> 3, NULL);
        ogs_pfcp_ue_ip_free(sess->ipv6);
    }

    upf_sess_set_ue_ipv4_framed_routes(sess, NULL);
    upf_sess_set_ue_ipv6_framed_routes(sess, NULL);

    /* Remove learned MACs from hash */
    upf_sess_clear_ue_macs(sess);

    ogs_pfcp_pool_final(&sess->pfcp);

    ogs_pool_free(&upf_n4_seid_pool, sess->upf_n4_seid_node);
    ogs_pool_id_free(&upf_sess_pool, sess);
    if (sess->apn_dnn)
        ogs_free(sess->apn_dnn);
    upf_metrics_inst_global_dec(UPF_METR_GLOB_GAUGE_UPF_SESSIONNBR);

    ogs_info("[Removed] Number of UPF-sessions is now %d",
            ogs_list_count(&self.sess_list));

    return OGS_OK;
}

void upf_sess_remove_all(void)
{
    upf_sess_t *sess = NULL, *next = NULL;

    ogs_list_for_each_safe(&self.sess_list, next, sess) {
        upf_sess_remove(sess);
    }
}

upf_sess_t *upf_sess_find_by_smf_n4_seid(uint64_t seid)
{
    return ogs_hash_get(self.smf_n4_seid_hash, &seid, sizeof(seid));
}

upf_sess_t *upf_sess_find_by_smf_n4_f_seid(ogs_pfcp_f_seid_t *f_seid)
{
    struct {
        uint64_t seid;
        ogs_ip_t ip;
    } key;

    ogs_assert(f_seid);
    ogs_assert(OGS_OK == ogs_pfcp_f_seid_to_ip(f_seid, &key.ip));
    key.seid = f_seid->seid;

    return ogs_hash_get(self.smf_n4_f_seid_hash, &key, sizeof(key));
}

upf_sess_t *upf_sess_find_by_upf_n4_seid(uint64_t seid)
{
    return ogs_hash_get(self.upf_n4_seid_hash, &seid, sizeof(seid));
}

upf_sess_t *upf_sess_find_by_ipv4(uint32_t addr)
{
    upf_sess_t *ret;
    struct upf_route_trie_node *trie = self.ipv4_framed_routes;
    const int nbits = sizeof(addr) << 3;
    int i;

    ogs_assert(self.ipv4_hash);

    ret = ogs_hash_get(self.ipv4_hash, &addr, OGS_IPV4_LEN);
    if (ret)
        return ret;

    for (i =  0; i <= nbits; i++) {
        int bit = nbits - i - 1;

        if (!trie)
            break;
        if (trie->sess)
            ret = trie->sess;
        if (i == nbits)
            break;

        if ((1 << bit) & be32toh(addr))
            trie = trie->right;
        else
            trie = trie->left;
    }
    return ret;
}

upf_sess_t *upf_sess_find_by_ipv6(uint32_t *addr6)
{
    upf_sess_t *ret = NULL;
    struct upf_route_trie_node *trie = self.ipv6_framed_routes;
    int i;
    const int chunk_size = sizeof(*addr6) << 3;

    ogs_assert(self.ipv6_hash);
    ogs_assert(addr6);
    ret = ogs_hash_get(
            self.ipv6_hash, addr6, OGS_IPV6_DEFAULT_PREFIX_LEN >> 3);
    if (ret)
        return ret;

    for (i = 0; i <= OGS_IPV6_128_PREFIX_LEN; i++) {
        int part = i / chunk_size;
        int bit = (OGS_IPV6_128_PREFIX_LEN - i - 1) % chunk_size;

        if (!trie)
            break;
        if (trie->sess)
            ret = trie->sess;
        if (i == OGS_IPV6_128_PREFIX_LEN)
            break;

        if ((1 << bit) & be32toh(addr6[part]))
            trie = trie->right;
        else
            trie = trie->left;
    }
    return ret;
}

upf_sess_t *upf_sess_find_by_id(ogs_pool_id_t id)
{
    return ogs_pool_find_by_id(&upf_sess_pool, id);
}

upf_sess_t *upf_sess_find_by_eth_dev_fd(ogs_socket_t fd)
{
    upf_sess_t *sess = NULL;
    ogs_list_for_each(&self.sess_list, sess) {
        if (sess->eth_dev && sess->eth_dev->fd == fd)
            return sess;
    }
    return NULL;
}

upf_sess_t *upf_sess_find_by_mac(uint8_t *mac_addr)
{
    ogs_assert(mac_addr);
    return (upf_sess_t *)ogs_hash_get(self.mac_hash, mac_addr, 6);
}

void upf_sess_learn_ue_mac(upf_sess_t *sess, uint8_t *mac_addr)
{
    int i, slot = -1, oldest = -1;
    upf_sess_t *owner = NULL;

    ogs_assert(sess);
    ogs_assert(mac_addr);

    for (i = 0; i < UPF_MAX_UE_MACS; i++) {
        if (sess->ue_macs[i].used &&
                memcmp(sess->ue_macs[i].addr, mac_addr, 6) == 0) {
            sess->ue_macs[i].last_seen = ogs_time_now();
            return;
        }
    }

    /* MAC moved from another session (device re-attached elsewhere) */
    owner = upf_sess_find_by_mac(mac_addr);
    if (owner && owner != sess) {
        for (i = 0; i < UPF_MAX_UE_MACS; i++) {
            if (owner->ue_macs[i].used &&
                    memcmp(owner->ue_macs[i].addr, mac_addr, 6) == 0) {
                ogs_hash_set(self.mac_hash, owner->ue_macs[i].addr, 6, NULL);
                owner->ue_macs[i].used = false;
                owner->num_of_ue_macs--;
                break;
            }
        }
    }

    for (i = 0; i < UPF_MAX_UE_MACS; i++) {
        if (!sess->ue_macs[i].used) {
            slot = i;
            break;
        }
        if (oldest < 0 || sess->ue_macs[i].last_seen <
                sess->ue_macs[oldest].last_seen)
            oldest = i;
    }
    if (slot < 0) {
        slot = oldest;
        ogs_hash_set(self.mac_hash, sess->ue_macs[slot].addr, 6, NULL);
        sess->ue_macs[slot].used = false;
        sess->num_of_ue_macs--;
    }

    memcpy(sess->ue_macs[slot].addr, mac_addr, 6);
    sess->ue_macs[slot].used = true;
    sess->ue_macs[slot].last_seen = ogs_time_now();
    sess->num_of_ue_macs++;
    ogs_hash_set(self.mac_hash, sess->ue_macs[slot].addr, 6, sess);

    if (!sess->gw_mac_learned) {
        memcpy(sess->gw_mac, mac_addr, 6);
        sess->gw_mac_learned = true;
        ogs_info("[NW-TT] Session gateway MAC "
                "%02x:%02x:%02x:%02x:%02x:%02x",
                mac_addr[0], mac_addr[1], mac_addr[2],
                mac_addr[3], mac_addr[4], mac_addr[5]);
    }

    ogs_info("[NW-TT] Learned MAC %02x:%02x:%02x:%02x:%02x:%02x "
            "for Ethernet PDU session (%d MAC%s)",
            mac_addr[0], mac_addr[1], mac_addr[2],
            mac_addr[3], mac_addr[4], mac_addr[5],
            sess->num_of_ue_macs, sess->num_of_ue_macs == 1 ? "" : "s");
}

void upf_sess_clear_ue_macs(upf_sess_t *sess)
{
    int i;

    ogs_assert(sess);

    for (i = 0; i < UPF_MAX_UE_MACS; i++) {
        if (sess->ue_macs[i].used) {
            ogs_hash_set(self.mac_hash, sess->ue_macs[i].addr, 6, NULL);
            sess->ue_macs[i].used = false;
        }
    }
    sess->num_of_ue_macs = 0;
    sess->gw_mac_learned = false;
}

const uint8_t *upf_sess_latest_ue_mac(upf_sess_t *sess)
{
    int i, latest = -1;

    ogs_assert(sess);

    for (i = 0; i < UPF_MAX_UE_MACS; i++) {
        if (!sess->ue_macs[i].used)
            continue;
        if (latest < 0 || sess->ue_macs[i].last_seen >
                sess->ue_macs[latest].last_seen)
            latest = i;
    }
    return latest < 0 ? NULL : sess->ue_macs[latest].addr;
}

upf_sess_t *upf_sess_add_by_message(ogs_pfcp_message_t *message)
{
    upf_sess_t *sess = NULL;
    ogs_pfcp_f_seid_t *f_seid = NULL;

    ogs_pfcp_session_establishment_request_t *req =
        &message->pfcp_session_establishment_request;;

    f_seid = req->cp_f_seid.data;
    if (req->cp_f_seid.presence == 0 || f_seid == NULL) {
        ogs_error("No CP F-SEID");
        return NULL;
    }
    if (f_seid->ipv4 == 0 && f_seid->ipv6 == 0) {
        ogs_error("No IPv4 or IPv6");
        return NULL;
    }
    f_seid->seid = be64toh(f_seid->seid);

    sess = upf_sess_find_by_smf_n4_f_seid(f_seid);
    if (!sess) {
        sess = upf_sess_add(f_seid);
        if (!sess) {
            ogs_error("No Session Context");
            return NULL;
        }
    }
    ogs_assert(sess);

    return sess;
}

uint8_t upf_sess_set_ue_ip(upf_sess_t *sess,
        uint8_t session_type, ogs_pfcp_pdr_t *pdr)
{
    ogs_pfcp_ue_ip_addr_t *ue_ip = NULL;
    char buf1[OGS_ADDRSTRLEN];
    char buf2[OGS_ADDRSTRLEN];

    uint8_t cause_value = OGS_PFCP_CAUSE_REQUEST_ACCEPTED;

    ogs_assert(sess);
    ogs_assert(pdr);

    if (session_type == OGS_PDU_SESSION_TYPE_ETHERNET) {
        /* Ethernet PDU: no IP allocation. Find TAP device by DNN. */
        ogs_pfcp_subnet_t *eth_subnet = NULL;
        ogs_pfcp_dev_t *eth_dev = NULL;

        ogs_list_for_each(&ogs_pfcp_self()->subnet_list, eth_subnet) {
            if (eth_subnet->dev && eth_subnet->dev->is_tap &&
                    pdr->dnn && eth_subnet->dnn[0] &&
                    !strcmp(eth_subnet->dnn, pdr->dnn)) {
                eth_dev = eth_subnet->dev;
                break;
            }
        }
        if (!eth_dev) {
            /* Fallback: first TAP device */
            ogs_list_for_each(&ogs_pfcp_self()->dev_list, eth_dev) {
                if (eth_dev->is_tap) break;
            }
        }
        if (eth_dev) {
            sess->eth_dev = eth_dev;
            sess->session_type = OGS_PDU_SESSION_TYPE_ETHERNET;
            ogs_info("Ethernet PDU session: using TAP '%s' (DNN:%s)",
                    eth_dev->ifname, pdr->dnn ? pdr->dnn : "");
        } else {
            ogs_warn("Ethernet PDU session but no TAP device found");
        }
        return cause_value;
    }

    ogs_assert(pdr->ue_ip_addr_len);
    ue_ip = &pdr->ue_ip_addr;
    ogs_assert(ue_ip);

    if (sess->ipv4) {
        ogs_hash_set(self.ipv4_hash,
                sess->ipv4->addr, OGS_IPV4_LEN, NULL);
        ogs_pfcp_ue_ip_free(sess->ipv4);
    }
    if (sess->ipv6) {
        ogs_hash_set(self.ipv6_hash,
                sess->ipv6->addr, OGS_IPV6_DEFAULT_PREFIX_LEN >> 3, NULL);
        ogs_pfcp_ue_ip_free(sess->ipv6);
    }

    /* Set PDN-Type and UE IP Address */
    if (session_type == OGS_PDU_SESSION_TYPE_IPV4) {
        if (ue_ip->ipv4 || pdr->dnn) {
            sess->ipv4 = ogs_pfcp_ue_ip_alloc(&cause_value, AF_INET,
                            pdr->dnn, (uint8_t *)&(ue_ip->addr));
            if (!sess->ipv4) {
                ogs_error("ogs_pfcp_ue_ip_alloc() failed[%d]", cause_value);
                ogs_assert(cause_value != OGS_PFCP_CAUSE_REQUEST_ACCEPTED);
                return cause_value;
            }
            ogs_hash_set(self.ipv4_hash, sess->ipv4->addr, OGS_IPV4_LEN, sess);
        } else {
            ogs_warn("Cannot support PDN-Type[%d], [IPv4:%d IPv6:%d DNN:%s]",
                session_type, ue_ip->ipv4, ue_ip->ipv6,
                pdr->dnn ? pdr->dnn : "");
        }
    } else if (session_type == OGS_PDU_SESSION_TYPE_IPV6) {
        if (ue_ip->ipv6 || pdr->dnn) {
            sess->ipv6 = ogs_pfcp_ue_ip_alloc(&cause_value, AF_INET6,
                            pdr->dnn, ue_ip->addr6);
            if (!sess->ipv6) {
                ogs_error("ogs_pfcp_ue_ip_alloc() failed[%d]", cause_value);
                ogs_assert(cause_value != OGS_PFCP_CAUSE_REQUEST_ACCEPTED);
                return cause_value;
            }
            ogs_hash_set(self.ipv6_hash, sess->ipv6->addr,
                    OGS_IPV6_DEFAULT_PREFIX_LEN >> 3, sess);
        } else {
            ogs_warn("Cannot support PDN-Type[%d], [IPv4:%d IPv6:%d DNN:%s]",
                session_type, ue_ip->ipv4, ue_ip->ipv6,
                pdr->dnn ? pdr->dnn : "");
        }
    } else if (session_type == OGS_PDU_SESSION_TYPE_IPV4V6) {
        if (ue_ip->ipv4 || pdr->dnn) {
            sess->ipv4 = ogs_pfcp_ue_ip_alloc(&cause_value, AF_INET,
                            pdr->dnn, (uint8_t *)&(ue_ip->both.addr));
            if (!sess->ipv4) {
                ogs_error("ogs_pfcp_ue_ip_alloc() failed[%d]", cause_value);
                ogs_assert(cause_value != OGS_PFCP_CAUSE_REQUEST_ACCEPTED);
                return cause_value;
            }
            ogs_hash_set(self.ipv4_hash, sess->ipv4->addr, OGS_IPV4_LEN, sess);
        } else {
            ogs_warn("Cannot support PDN-Type[%d], [IPv4:%d IPv6:%d DNN:%s]",
                session_type, ue_ip->ipv4, ue_ip->ipv6,
                pdr->dnn ? pdr->dnn : "");
        }

        if (ue_ip->ipv6 || pdr->dnn) {
            sess->ipv6 = ogs_pfcp_ue_ip_alloc(&cause_value, AF_INET6,
                            pdr->dnn, ue_ip->both.addr6);
            if (!sess->ipv6) {
                ogs_error("ogs_pfcp_ue_ip_alloc() failed[%d]", cause_value);
                ogs_assert(cause_value != OGS_PFCP_CAUSE_REQUEST_ACCEPTED);
                if (sess->ipv4) {
                    ogs_hash_set(self.ipv4_hash,
                            sess->ipv4->addr, OGS_IPV4_LEN, NULL);
                    ogs_pfcp_ue_ip_free(sess->ipv4);
                    sess->ipv4 = NULL;
                }
                return cause_value;
            }
            ogs_hash_set(self.ipv6_hash, sess->ipv6->addr,
                    OGS_IPV6_DEFAULT_PREFIX_LEN >> 3, sess);
        } else {
            ogs_warn("Cannot support PDN-Type[%d], [IPv4:%d IPv6:%d DNN:%s]",
                session_type, ue_ip->ipv4, ue_ip->ipv6,
                pdr->dnn ? pdr->dnn : "");
        }
    } else {
        ogs_error("Invalid PDN-Type[%d], [IPv4:%d IPv6:%d DNN:%s]",
                session_type, ue_ip->ipv4, ue_ip->ipv6,
                pdr->dnn ? pdr->dnn : "");
        return OGS_PFCP_CAUSE_SERVICE_NOT_SUPPORTED;
    }

    ogs_info("UE F-SEID[UP:0x%lx CP:0x%lx] "
             "APN[%s] PDN-Type[%d] IPv4[%s] IPv6[%s]",
        (long)sess->upf_n4_seid, (long)sess->smf_n4_f_seid.seid,
        pdr->dnn, session_type,
        sess->ipv4 ? OGS_INET_NTOP(&sess->ipv4->addr, buf1) : "",
        sess->ipv6 ? OGS_INET6_NTOP(&sess->ipv6->addr, buf2) : "");

    return cause_value;
}

/* Remove amd free framed ROUTE from TRIE. It isn't an error if the framed
   route doesn't exist in TRIE. */
static void free_framed_route_from_trie(ogs_ipsubnet_t *route)
{
    const int chunk_size = sizeof(route->sub[0]) << 3;
    const int is_ipv4 = route->family == AF_INET;
    const int nbits = is_ipv4 ? chunk_size : OGS_IPV6_128_PREFIX_LEN;
    struct upf_route_trie_node **trie =
        is_ipv4 ? &self.ipv4_framed_routes : &self.ipv6_framed_routes;

    struct upf_route_trie_node **to_free_tries[OGS_IPV6_128_PREFIX_LEN + 1];
    int free_from = 0;
    int i = 0;

    for (i = 0; i <= nbits; i++) {
        int part = i / chunk_size;
        int bit = (nbits - i - 1) % chunk_size;

        if (!*trie)
            break;
        to_free_tries[i] = trie;

        if (i == nbits ||
            ((1 << bit) & be32toh(route->mask[part])) == 0) {
            (*trie)->sess = NULL;
            if ((*trie)->left || (*trie)->right)
                free_from = i + 1;
            i++;
            break;
        }

        if ((1 << bit) & be32toh(route->sub[part])) {
            if ((*trie)->left || (*trie)->sess)
                free_from = i + 1;
            trie = &(*trie)->right;
        } else {
            if ((*trie)->right || (*trie)->sess)
                free_from = i + 1;
            trie = &(*trie)->left;
        }
    }

    for (i = i - 1; i >= free_from; i--) {
        trie = to_free_tries[i];
        ogs_free(*trie);
        *trie = NULL;
    }
}

static void add_framed_route_to_trie(ogs_ipsubnet_t *route, upf_sess_t *sess)
{
    const int chunk_size = sizeof(route->sub[0]) << 3;
    const int is_ipv4 = route->family == AF_INET;
    const int nbits = is_ipv4 ? chunk_size : OGS_IPV6_128_PREFIX_LEN;
    struct upf_route_trie_node **trie =
        is_ipv4 ? &self.ipv4_framed_routes : &self.ipv6_framed_routes;
    int i = 0;

    for (i = 0; i <= nbits; i++) {
        int part = i / chunk_size;
        int bit = (nbits - i - 1) % chunk_size;

        if (!*trie)
            *trie = ogs_calloc(1, sizeof(**trie));

        if (i == nbits ||
            ((1 << bit) & be32toh(route->mask[part])) == 0) {
            (*trie)->sess = sess;
            break;
        }

        if ((1 << bit) & be32toh(route->sub[part])) {
            trie = &(*trie)->right;
        } else {
            trie = &(*trie)->left;
        }
    }
}

static int parse_framed_route(ogs_ipsubnet_t *subnet, const char *framed_route)
{
    char *mask = ogs_strdup(framed_route);
    char *addr = strsep(&mask, "/");
    int rv;

    rv = ogs_ipsubnet(subnet, addr, mask);
    ogs_free(addr);
    return rv;
}

uint8_t upf_sess_set_ue_ipv4_framed_routes(upf_sess_t *sess,
        char *framed_routes[])
{
    int i = 0, j = 0, rv;
    uint8_t cause_value = OGS_PFCP_CAUSE_REQUEST_ACCEPTED;

    ogs_assert(sess);

    for (i = 0; i < OGS_MAX_NUM_OF_FRAMED_ROUTES_IN_PDI; i++) {
        if (!sess->ipv4_framed_routes || !sess->ipv4_framed_routes[i].family)
            break;
        free_framed_route_from_trie(&sess->ipv4_framed_routes[i]);
        memset(&sess->ipv4_framed_routes[i], 0,
               sizeof(sess->ipv4_framed_routes[i]));
    }

    for (i = 0, j = 0; i < OGS_MAX_NUM_OF_FRAMED_ROUTES_IN_PDI; i++) {
        if (!framed_routes || !framed_routes[i])
            break;

        if (sess->ipv4_framed_routes == NULL) {
            sess->ipv4_framed_routes = ogs_calloc(
                OGS_MAX_NUM_OF_FRAMED_ROUTES_IN_PDI, sizeof(ogs_ipsubnet_t));
            ogs_assert(sess->ipv4_framed_routes);
        }

        rv = parse_framed_route(&sess->ipv4_framed_routes[j], framed_routes[i]);

        if (rv != OGS_OK) {
            ogs_warn("Ignoring invalid framed route %s", framed_routes[i]);
            memset(&sess->ipv4_framed_routes[j], 0,
                   sizeof(sess->ipv4_framed_routes[j]));
            continue;
        }
        add_framed_route_to_trie(&sess->ipv4_framed_routes[j], sess);
        j++;
    }
    if (j == 0 && sess->ipv4_framed_routes) {
        ogs_free(sess->ipv4_framed_routes);
        sess->ipv4_framed_routes = NULL;
    }

    return cause_value;
}

uint8_t upf_sess_set_ue_ipv6_framed_routes(upf_sess_t *sess,
        char *framed_routes[])
{
    int i = 0, j = 0, rv;
    uint8_t cause_value = OGS_PFCP_CAUSE_REQUEST_ACCEPTED;

    ogs_assert(sess);

    for (i = 0; i < OGS_MAX_NUM_OF_FRAMED_ROUTES_IN_PDI; i++) {
        if (!sess->ipv6_framed_routes || !sess->ipv6_framed_routes[i].family)
            break;
        free_framed_route_from_trie(&sess->ipv6_framed_routes[i]);
    }

    for (i = 0, j = 0; i < OGS_MAX_NUM_OF_FRAMED_ROUTES_IN_PDI; i++) {
        if (!framed_routes || !framed_routes[i])
            break;

        if (sess->ipv6_framed_routes == NULL) {
            sess->ipv6_framed_routes = ogs_calloc(
                OGS_MAX_NUM_OF_FRAMED_ROUTES_IN_PDI, sizeof(ogs_ipsubnet_t));
            ogs_assert(sess->ipv6_framed_routes);
        }

        rv = parse_framed_route(&sess->ipv6_framed_routes[j], framed_routes[i]);

        if (rv != OGS_OK) {
            ogs_warn("Ignoring invalid framed route %s", framed_routes[i]);
            memset(&sess->ipv6_framed_routes[j], 0,
                   sizeof(sess->ipv6_framed_routes[j]));
            continue;
        }
        add_framed_route_to_trie(&sess->ipv6_framed_routes[j], sess);
        j++;
    }
    if (j == 0 && sess->ipv6_framed_routes) {
        ogs_free(sess->ipv6_framed_routes);
        sess->ipv6_framed_routes = NULL;
    }

    return cause_value;
}

void upf_sess_urr_acc_add(upf_sess_t *sess, ogs_pfcp_urr_t *urr, size_t size, bool is_uplink)
{
    upf_sess_urr_acc_t *urr_acc = NULL;
    uint64_t vol;

    ogs_assert(urr->id > 0 && urr->id <= OGS_MAX_NUM_OF_URR);
    urr_acc = &sess->urr_acc[urr->id-1];

    /* Increment total & ul octets + pkts */
    urr_acc->total_octets += size;
    urr_acc->total_pkts++;
    if (is_uplink) {
        urr_acc->ul_octets += size;
        urr_acc->ul_pkts++;
    } else {
        urr_acc->dl_octets += size;
        urr_acc->dl_pkts++;
    }

    urr_acc->time_of_last_packet = ogs_time_now();
    if (urr_acc->time_of_first_packet == 0)
        urr_acc->time_of_first_packet = urr_acc->time_of_last_packet;

    /* generate report if volume threshold/quota is reached */
    vol = urr_acc->total_octets - urr_acc->last_report.total_octets;
    if ((urr->rep_triggers.volume_quota && urr->vol_quota.tovol && vol >= urr->vol_quota.total_volume) ||
        (urr->rep_triggers.volume_threshold && urr->vol_threshold.tovol && vol >= urr->vol_threshold.total_volume)) {
        ogs_pfcp_user_plane_report_t report;
        memset(&report, 0, sizeof(report));
        upf_sess_urr_acc_fill_usage_report(sess, urr, &report, 0);
        report.num_of_usage_report = 1;
        upf_sess_urr_acc_snapshot(sess, urr);

        ogs_assert(OGS_OK ==
            upf_pfcp_send_session_report_request(sess, &report));
        /* Start new report period/iteration: */
        upf_sess_urr_acc_timers_setup(sess, urr);
    }
}

/* report struct must be memzeroed before first use of this function.
 * report->num_of_usage_report must be set by the caller */
void upf_sess_urr_acc_fill_usage_report(upf_sess_t *sess, const ogs_pfcp_urr_t *urr,
                                  ogs_pfcp_user_plane_report_t *report, unsigned int idx)
{
    upf_sess_urr_acc_t *urr_acc = NULL;
    ogs_time_t last_report_timestamp;
    ogs_time_t now;

    ogs_assert(urr->id > 0 && urr->id <= OGS_MAX_NUM_OF_URR);
    urr_acc = &sess->urr_acc[urr->id-1];

    now = ogs_time_now(); /* we need UTC for start_time and end_time */

    if (urr_acc->last_report.timestamp)
        last_report_timestamp = urr_acc->last_report.timestamp;
    else
        last_report_timestamp = ogs_time_from_ntp32(urr_acc->time_start);

    report->type.usage_report = 1;
    report->usage_report[idx].id = urr->id;
    report->usage_report[idx].seqn = urr_acc->report_seqn++;
    report->usage_report[idx].start_time = urr_acc->time_start;
    report->usage_report[idx].end_time = ogs_time_to_ntp32(now);
    report->usage_report[idx].vol_measurement = (ogs_pfcp_volume_measurement_t){
        .dlnop = 1,
        .ulnop = 1,
        .tonop = 1,
        .dlvol = 1,
        .ulvol = 1,
        .tovol = 1,
        .total_volume = urr_acc->total_octets - urr_acc->last_report.total_octets,
        .uplink_volume = urr_acc->ul_octets - urr_acc->last_report.ul_octets,
        .downlink_volume = urr_acc->dl_octets - urr_acc->last_report.dl_octets,
        .total_n_packets = urr_acc->total_pkts - urr_acc->last_report.total_pkts,
        .uplink_n_packets = urr_acc->ul_pkts - urr_acc->last_report.ul_pkts,
        .downlink_n_packets = urr_acc->dl_pkts - urr_acc->last_report.dl_pkts,
    };
    if (now >= last_report_timestamp)
        report->usage_report[idx].dur_measurement = ((now - last_report_timestamp) + (OGS_USEC_PER_SEC/2)) / OGS_USEC_PER_SEC; /* FIXME: should use MONOTONIC here */
    /* else memset sets it to 0 */
    report->usage_report[idx].time_of_first_packet = ogs_time_to_ntp32(urr_acc->time_of_first_packet); /* TODO: First since last report? */
    report->usage_report[idx].time_of_last_packet = ogs_time_to_ntp32(urr_acc->time_of_last_packet);

    /* Time triggers: */
    if (urr->quota_validity_time > 0 &&
            report->usage_report[idx].dur_measurement >= urr->quota_validity_time)
        report->usage_report[idx].rep_trigger.quota_validity_time = 1;
    if (urr->time_quota > 0 &&
            report->usage_report[idx].dur_measurement >= urr->time_quota)
        report->usage_report[idx].rep_trigger.time_quota = 1;
    if (urr->time_threshold > 0 &&
            report->usage_report[idx].dur_measurement >= urr->time_threshold)
        report->usage_report[idx].rep_trigger.time_threshold = 1;

    /* Volume triggers: */
    if (urr->rep_triggers.volume_quota && urr->vol_quota.tovol &&
            report->usage_report[idx].vol_measurement.total_volume >= urr->vol_quota.total_volume)
        report->usage_report[idx].rep_trigger.volume_quota = 1;
    if (urr->rep_triggers.volume_threshold && urr->vol_threshold.tovol &&
            report->usage_report[idx].vol_measurement.total_volume >= urr->vol_threshold.total_volume)
        report->usage_report[idx].rep_trigger.volume_threshold = 1;
}

void upf_sess_urr_acc_snapshot(upf_sess_t *sess, ogs_pfcp_urr_t *urr)
{
    upf_sess_urr_acc_t *urr_acc = NULL;

    ogs_assert(urr->id > 0 && urr->id <= OGS_MAX_NUM_OF_URR);
    urr_acc = &sess->urr_acc[urr->id-1];

    urr_acc->last_report.total_octets = urr_acc->total_octets;
    urr_acc->last_report.dl_octets = urr_acc->dl_octets;
    urr_acc->last_report.ul_octets = urr_acc->ul_octets;
    urr_acc->last_report.total_pkts = urr_acc->total_pkts;
    urr_acc->last_report.dl_pkts = urr_acc->dl_pkts;
    urr_acc->last_report.ul_pkts = urr_acc->ul_pkts;
    urr_acc->last_report.timestamp = ogs_time_now();
}

static void upf_sess_urr_acc_timers_cb(void *data)
{
    ogs_pfcp_urr_t *urr = (ogs_pfcp_urr_t *)data;
    ogs_pfcp_user_plane_report_t report;
    ogs_pfcp_sess_t *pfcp_sess = urr->sess;
    upf_sess_t *sess = UPF_SESS(pfcp_sess);

    ogs_info("upf_time_threshold_cb() triggered! urr=%p", urr);

    if (urr->rep_triggers.quota_validity_time ||
        urr->rep_triggers.time_quota ||
        urr->rep_triggers.time_threshold) {
        memset(&report, 0, sizeof(report));
        upf_sess_urr_acc_fill_usage_report(sess, urr, &report, 0);
        report.num_of_usage_report = 1;
        upf_sess_urr_acc_snapshot(sess, urr);

        ogs_assert(OGS_OK ==
            upf_pfcp_send_session_report_request(sess, &report));
    }
    /* Start new report period/iteration: */
    upf_sess_urr_acc_timers_setup(sess, urr);
}

static void upf_sess_urr_acc_validity_time_setup(upf_sess_t *sess, ogs_pfcp_urr_t *urr)
{
    upf_sess_urr_acc_t *urr_acc = NULL;

    ogs_assert(urr->id > 0 && urr->id <= OGS_MAX_NUM_OF_URR);
    urr_acc = &sess->urr_acc[urr->id-1];

    ogs_debug("Installing URR Quota Validity Time timer");
    urr_acc->reporting_enabled = true;
    if (!urr_acc->t_validity_time)
        urr_acc->t_validity_time = ogs_timer_add(ogs_app()->timer_mgr,
                                        upf_sess_urr_acc_timers_cb, urr);
    ogs_timer_start(urr_acc->t_validity_time,
            ogs_time_from_sec(urr->quota_validity_time));
}

static void upf_sess_urr_acc_time_quota_setup(upf_sess_t *sess, ogs_pfcp_urr_t *urr)
{
    upf_sess_urr_acc_t *urr_acc = NULL;

    ogs_assert(urr->id > 0 && urr->id <= OGS_MAX_NUM_OF_URR);
    urr_acc = &sess->urr_acc[urr->id-1];

    ogs_debug("Installing URR Time Quota timer");
    urr_acc->reporting_enabled = true;
    if (!urr_acc->t_time_quota)
        urr_acc->t_time_quota = ogs_timer_add(ogs_app()->timer_mgr,
                                        upf_sess_urr_acc_timers_cb, urr);
    ogs_timer_start(urr_acc->t_time_quota, ogs_time_from_sec(urr->time_quota));
}

static void upf_sess_urr_acc_time_threshold_setup(upf_sess_t *sess, ogs_pfcp_urr_t *urr)
{
    upf_sess_urr_acc_t *urr_acc = NULL;

    ogs_assert(urr->id > 0 && urr->id <= OGS_MAX_NUM_OF_URR);
    urr_acc = &sess->urr_acc[urr->id-1];

    ogs_debug("Installing URR Time Threshold timer");
    urr_acc->reporting_enabled = true;
    if (!urr_acc->t_time_threshold)
        urr_acc->t_time_threshold = ogs_timer_add(ogs_app()->timer_mgr,
                                        upf_sess_urr_acc_timers_cb, urr);
    ogs_timer_start(urr_acc->t_time_threshold,
            ogs_time_from_sec(urr->time_threshold));
}

void upf_sess_urr_acc_timers_setup(upf_sess_t *sess, ogs_pfcp_urr_t *urr)
{
    upf_sess_urr_acc_t *urr_acc = NULL;

    ogs_assert(urr->id > 0 && urr->id <= OGS_MAX_NUM_OF_URR);
    urr_acc = &sess->urr_acc[urr->id-1];

    urr_acc->time_start = ogs_time_ntp32_now();
    if (urr->rep_triggers.quota_validity_time && urr->quota_validity_time > 0)
        upf_sess_urr_acc_validity_time_setup(sess, urr);
    if (urr->rep_triggers.time_quota && urr->time_quota > 0)
        upf_sess_urr_acc_time_quota_setup(sess, urr);
    if (urr->rep_triggers.time_threshold && urr->time_threshold > 0)
        upf_sess_urr_acc_time_threshold_setup(sess, urr);
}

static void upf_sess_urr_acc_remove_all(upf_sess_t *sess)
{
    unsigned int i;
    for (i = 0; i < OGS_ARRAY_SIZE(sess->urr_acc); i++) {
        if (sess->urr_acc[i].t_time_threshold) {
            ogs_timer_delete(sess->urr_acc[i].t_time_threshold);
            sess->urr_acc[i].t_time_threshold = NULL;
        }
        if (sess->urr_acc[i].t_validity_time) {
            ogs_timer_delete(sess->urr_acc[i].t_validity_time);
            sess->urr_acc[i].t_validity_time = NULL;
        }
        if (sess->urr_acc[i].t_time_quota) {
            ogs_timer_delete(sess->urr_acc[i].t_time_quota);
            sess->urr_acc[i].t_time_quota = NULL;
        }
    }
}
