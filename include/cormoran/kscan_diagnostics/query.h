/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <cormoran/kscan_diagnostics/kscan_diagnostics.pb.h>

/*
 * Estimated worst-case encoded size of a Response produced by
 * ksd_query_dispatch (the GpioPins page; see the arithmetic in
 * src/kscan_diagnostics_query.c). Each transport that carries a Response
 * BUILD_ASSERTs its own buffer against this: the Studio RPC TX buffer in
 * src/studio/kscan_diagnostics_handler.c and the split relay payload in
 * src/split/kscan_diagnostics_relay_events.h.
 */
#define KSCAN_DIAGNOSTICS_RPC_ESTIMATED_MAX_RESPONSE_SIZE 180

/*
 * Shared topology/stats query dispatch.
 *
 * Reads only from src/topology.c and src/stats.c tables (compile-time DT +
 * runtime counters), so it is transport-agnostic: the central Studio RPC
 * handler (src/studio/kscan_diagnostics_handler.c) calls it for a locally
 * connected keyboard, and -- compiled into the split *peripheral* image --
 * the relay handler (src/split/kscan_diagnostics_relay.c) calls it to answer
 * a relayed query against that peripheral's own DT tables.
 *
 * Does NOT handle Request_query_peripheral_tag: that request is central-only
 * relay plumbing (it wraps one of the requests below), so the handler that
 * owns the relay intercepts it before calling this dispatch.
 */
void ksd_query_dispatch(const cormoran_kscan_diagnostics_Request *req,
                        cormoran_kscan_diagnostics_Response *resp);

/* Fill `resp` with an Error response carrying `message` (truncated to fit). */
void ksd_query_set_error(cormoran_kscan_diagnostics_Response *resp, const char *message);
