/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#include <string.h>

#include <pb_decode.h>
#include <pb_encode.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <zmk/event_manager.h>
#include <cormoran/kscan_diagnostics/kscan_diagnostics.pb.h>
#include <cormoran/kscan_diagnostics/query.h>
#include <cormoran/kscan_diagnostics/relay.h>
#include <cormoran/kscan_diagnostics/relay_events.h>

#if IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC)
#include <zmk/studio/custom.h>
#endif

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

/*
 * Wire both relay carriers in both directions. The direction macros are
 * self-role-gating (the wrong-direction one expands empty per role), and the
 * HANDLE macros only fire when a relay frame with the matching identifier is
 * actually received -- a central never receives "KDq" and a peripheral never
 * receives "KDr", so listing all four here is safe on either role.
 *
 *   central  --KDq (query)-->  peripheral   (CENTRAL_TO_PERIPHERAL + HANDLE)
 *   peripheral --KDr (reply)--> central     (PERIPHERAL_TO_CENTRAL + HANDLE)
 */
ZMK_RELAY_EVENT_CENTRAL_TO_PERIPHERAL(ksd_relay_query, KDq, source)
ZMK_RELAY_EVENT_PERIPHERAL_TO_CENTRAL(ksd_relay_reply, KDr, source)
ZMK_RELAY_EVENT_HANDLE(ksd_relay_query, KDq, source)
ZMK_RELAY_EVENT_HANDLE(ksd_relay_reply, KDr, source)

#if !IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)

/*
 * Peripheral side: a relayed query has been re-raised locally by
 * ZMK_RELAY_EVENT_HANDLE(ksd_relay_query). Decode the inner Request, answer it
 * with the shared dispatch against THIS peripheral's own topology/stats
 * tables, and raise a reply (relayed back to the central).
 *
 * Runs on the split relay-receive work queue (serialized), so the static
 * scratch buffers below need no extra locking and keep the work-queue stack
 * small.
 */
static cormoran_kscan_diagnostics_Request answer_req;
static cormoran_kscan_diagnostics_Response answer_resp;
static struct ksd_relay_reply answer_reply;

static int ksd_relay_answer_query(const zmk_event_t *eh) {
    const struct ksd_relay_query *query = as_ksd_relay_query(eh);
    if (query == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }

    answer_req = (cormoran_kscan_diagnostics_Request)cormoran_kscan_diagnostics_Request_init_zero;
    pb_istream_t is = pb_istream_from_buffer(query->data, query->len);
    if (!pb_decode(&is, cormoran_kscan_diagnostics_Request_fields, &answer_req)) {
        LOG_WRN("Failed to decode relayed kscan diagnostics query: %s", PB_GET_ERROR(&is));
        return ZMK_EV_EVENT_BUBBLE;
    }

    answer_resp =
        (cormoran_kscan_diagnostics_Response)cormoran_kscan_diagnostics_Response_init_zero;
    ksd_query_dispatch(&answer_req, &answer_resp);

    answer_reply = (struct ksd_relay_reply){
        .source = ZMK_RELAY_EVENT_SOURCE_SELF,
        .req_id = query->req_id,
    };
    pb_ostream_t os = pb_ostream_from_buffer(answer_reply.data, sizeof(answer_reply.data));
    if (!pb_encode(&os, cormoran_kscan_diagnostics_Response_fields, &answer_resp)) {
        LOG_ERR("Failed to encode relayed kscan diagnostics reply: %s", PB_GET_ERROR(&os));
        return ZMK_EV_EVENT_BUBBLE;
    }
    answer_reply.len = (uint8_t)os.bytes_written;

    raise_ksd_relay_reply(answer_reply);
    return ZMK_EV_EVENT_HANDLED;
}

ZMK_LISTENER(ksd_relay_answer, ksd_relay_answer_query);
ZMK_SUBSCRIPTION(ksd_relay_answer, ksd_relay_query);

#else // CONFIG_ZMK_SPLIT_ROLE_CENTRAL

/*
 * Central side: a peripheral's reply has been re-raised locally by
 * ZMK_RELAY_EVENT_HANDLE(ksd_relay_reply), with `source` stamped to the
 * peripheral index+1. Forward it to the connected Studio client as a
 * PeripheralEvent notification. Only compiled when the Studio RPC subsystem is
 * present (that is where notifications are delivered).
 */
#if IS_ENABLED(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC)

#define KSCAN_DIAGNOSTICS_SUBSYSTEM_IDENTIFIER "cormoran__kscan_diagnostics"

static int ksd_relay_subsystem_index(void) {
    size_t count;
    STRUCT_SECTION_COUNT(zmk_rpc_custom_subsystem, &count);
    for (size_t i = 0; i < count; i++) {
        struct zmk_rpc_custom_subsystem *subsys;
        STRUCT_SECTION_GET(zmk_rpc_custom_subsystem, i, &subsys);
        if (strcmp(subsys->identifier, KSCAN_DIAGNOSTICS_SUBSYSTEM_IDENTIFIER) == 0) {
            return (int)i;
        }
    }
    return -ENOENT;
}

static bool ksd_relay_encode_peripheral_event(pb_ostream_t *stream, const pb_field_t *field,
                                              void *const *arg) {
    const cormoran_kscan_diagnostics_PeripheralEvent *event =
        (const cormoran_kscan_diagnostics_PeripheralEvent *)*arg;
    return zmk_rpc_custom_subsystem_encode_response_payload(
        stream, field, cormoran_kscan_diagnostics_PeripheralEvent_fields, event);
}

static int ksd_relay_notify_reply(const zmk_event_t *eh) {
    const struct ksd_relay_reply *reply = as_ksd_relay_reply(eh);
    if (reply == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }

    int index = ksd_relay_subsystem_index();
    if (index < 0) {
        LOG_WRN("kscan diagnostics subsystem not registered, dropping peripheral reply");
        return ZMK_EV_EVENT_BUBBLE;
    }

    cormoran_kscan_diagnostics_PeripheralEvent event =
        cormoran_kscan_diagnostics_PeripheralEvent_init_zero;
    event.source = reply->source;
    event.req_id = reply->req_id;
    event.payload.size = MIN(reply->len, sizeof(event.payload.bytes));
    memcpy(event.payload.bytes, reply->data, event.payload.size);

    // encode_payload runs inline within raise_zmk_studio_custom_notification, so
    // pointing at the stack-local `event` is safe (see zmk/studio/custom.h).
    raise_zmk_studio_custom_notification((struct zmk_studio_custom_notification){
        .subsystem_index = (uint8_t)index,
        .encode_payload =
            {
                .funcs.encode = ksd_relay_encode_peripheral_event,
                .arg = (void *)&event,
            },
    });
    return ZMK_EV_EVENT_HANDLED;
}

ZMK_LISTENER(ksd_relay_notify, ksd_relay_notify_reply);
ZMK_SUBSCRIPTION(ksd_relay_notify, ksd_relay_reply);

#endif // CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC

/*
 * Central side entry point for the QueryPeripheral RPC (called from the Studio
 * handler): wrap the client's inner Request and broadcast it to all connected
 * peripherals, then acknowledge immediately. Replies arrive asynchronously via
 * ksd_relay_notify_reply above.
 */
void ksd_relay_central_query(const cormoran_kscan_diagnostics_QueryPeripheral *req,
                             cormoran_kscan_diagnostics_Response *resp) {
    if (req->payload.size > KSD_RELAY_QUERY_DATA_MAX) {
        ksd_query_set_error(resp, "QueryPeripheral payload too large");
        return;
    }

    struct ksd_relay_query query = {
        .source = ZMK_RELAY_EVENT_SOURCE_SELF,
        .req_id = (uint8_t)req->req_id,
        .len = (uint8_t)req->payload.size,
    };
    memcpy(query.data, req->payload.bytes, query.len);

    raise_ksd_relay_query(query);

    cormoran_kscan_diagnostics_Ok ok = cormoran_kscan_diagnostics_Ok_init_zero;
    resp->which_response_type = cormoran_kscan_diagnostics_Response_ok_tag;
    resp->response_type.ok = ok;
}

#endif // CONFIG_ZMK_SPLIT_ROLE_CENTRAL
