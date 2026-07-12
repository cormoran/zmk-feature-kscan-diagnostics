/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#include <pb_decode.h>
#include <pb_encode.h>
#include <zephyr/kernel.h>
#include <zmk/studio/custom.h>
#include <cormoran/kscan_diagnostics/kscan_diagnostics.pb.h>
#include <cormoran/kscan_diagnostics/query.h>

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

/*
 * Studio RPC transport budget: the encoded Response must fit the Studio RPC
 * TX buffer with the ~64 B framing margin. The worst-case Response size
 * (GpioPins page) is estimated in src/kscan_diagnostics_query.c and shared as
 * KSCAN_DIAGNOSTICS_RPC_ESTIMATED_MAX_RESPONSE_SIZE.
 * CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=256 is configured in
 * tests/studio/native_sim.conf and tests/zmk-config/build.yaml.
 */
BUILD_ASSERT(KSCAN_DIAGNOSTICS_RPC_ESTIMATED_MAX_RESPONSE_SIZE + 64 <=
                 CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE,
             "CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE is too small for a full kscan diagnostics "
             "GpioPins/Stats response -- see the arithmetic comment in "
             "src/kscan_diagnostics_query.c");

static struct zmk_rpc_custom_subsystem_meta kscan_diagnostics_subsystem_meta = {
    ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS("https://cormoran.github.io/zmk-feature-kscan-diagnostics/"),
    // Unsecured is suggested by default to avoid unlocking in un-reliable
    // environments -- a broken keyboard may not be able to type the
    // &studio_unlock combo (DESIGN.md SS2). Topology and aggregate counters
    // are not sensitive.
    .security = ZMK_STUDIO_RPC_HANDLER_UNSECURED,
};

ZMK_RPC_CUSTOM_SUBSYSTEM(cormoran__kscan_diagnostics, &kscan_diagnostics_subsystem_meta,
                         kscan_diagnostics_rpc_handle_request);

ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(cormoran__kscan_diagnostics,
                                         cormoran_kscan_diagnostics_Response);

static bool kscan_diagnostics_rpc_handle_request(const zmk_custom_CallRequest *raw_request,
                                                 pb_callback_t *encode_response) {
    cormoran_kscan_diagnostics_Response *resp = ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(
        cormoran__kscan_diagnostics, encode_response);

    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;

    pb_istream_t req_stream =
        pb_istream_from_buffer(raw_request->payload.bytes, raw_request->payload.size);
    if (!pb_decode(&req_stream, cormoran_kscan_diagnostics_Request_fields, &req)) {
        LOG_WRN("Failed to decode kscan_diagnostics request: %s", PB_GET_ERROR(&req_stream));
        ksd_query_set_error(resp, "Failed to decode request");
        return true;
    }

    ksd_query_dispatch(&req, resp);
    return true;
}
