/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <zephyr/kernel.h>
#include <zmk/event_manager.h>
#include <cormoran/kscan_diagnostics/query.h>

/*
 * Split event-relay carriers for peripheral kscan diagnostics queries.
 *
 * `ksd_relay_query` travels central -> peripheral (identifier "KDq"),
 * `ksd_relay_reply` travels peripheral -> central (identifier "KDr"). Each
 * carries an opaque nanopb-encoded inner Request/Response (the same messages
 * the Studio RPC uses), so the peripheral answers with the shared
 * ksd_query_dispatch against its own topology/stats tables -- no duplicate
 * query logic. See src/split/kscan_diagnostics_relay.c and DESIGN.md.
 *
 * The whole struct is copied into the relay payload, so it must fit
 * CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN (asserted by the relay macros). The
 * data buffers below are sized to the encoded inner message maxima, not to
 * DATA_LEN, to keep each relayed frame as small as the message allows.
 */

/* Largest encoded inner Request (GetGpioPins: 3 uint32 fields + framing). */
#define KSD_RELAY_QUERY_DATA_MAX 32
/* Largest encoded inner Response (a GpioPins page). */
#define KSD_RELAY_REPLY_DATA_MAX 192

BUILD_ASSERT(KSCAN_DIAGNOSTICS_RPC_ESTIMATED_MAX_RESPONSE_SIZE <= KSD_RELAY_REPLY_DATA_MAX,
             "kscan diagnostics Response no longer fits the relay reply buffer");

struct ksd_relay_query {
    uint8_t source; /* ZMK_RELAY_EVENT_SOURCE_SELF on send; sender index+1 on receive */
    uint8_t req_id; /* echoed back in the reply for client correlation */
    uint8_t len;    /* bytes of `data` in use */
    uint8_t data[KSD_RELAY_QUERY_DATA_MAX]; /* encoded inner Request */
};

struct ksd_relay_reply {
    uint8_t source;
    uint8_t req_id;
    uint8_t len;
    uint8_t data[KSD_RELAY_REPLY_DATA_MAX]; /* encoded inner Response */
};

/*
 * The relay transport reassembles up to CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN
 * bytes, and the whole reply struct is copied into that payload. ZMK's default
 * (128) is too small for a GpioPins page, so both split halves must build with
 * CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=256. The module sets that as a Kconfig
 * default, but a `default` can lose Kconfig parse-order to ZMK's own default,
 * so set it explicitly in your config if this assert fires. (ZMK's own
 * __ZMK_RELAY_ASSERT_SIZE also guards this; this one just explains the fix.)
 */
BUILD_ASSERT(sizeof(struct ksd_relay_reply) <= CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN,
             "kscan diagnostics peripheral replies need "
             "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=256 on both split halves");

ZMK_EVENT_DECLARE(ksd_relay_query);
ZMK_EVENT_DECLARE(ksd_relay_reply);
