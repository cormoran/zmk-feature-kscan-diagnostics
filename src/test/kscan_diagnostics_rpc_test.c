/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 *
 * native_sim self-test for src/studio/kscan_diagnostics_handler.c, run
 * against tests/studio/ (native_sim/native/zmk_test_mock board + ../test.dtsi
 * -- a real zmk,kscan-mock(rows=2,columns=2) device wired up as the chosen
 * zmk,kscan, with a matching 2x2 zmk,physical-layout + zmk,matrix-transform).
 * Drives the registered handler directly (no transport), the same pattern
 * zmk-feature-watchdog's src/test/watchdog_rpc_test.c uses.
 */

#include <errno.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>

#include <pb_decode.h>
#include <pb_encode.h>
#include <zmk/studio/custom.h>
#include <cormoran/kscan-diagnostics/kscan_diagnostics.pb.h>

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

static custom_subsystem_handler *find_kscan_diagnostics_rpc_handler(void) {
    size_t count;
    STRUCT_SECTION_COUNT(zmk_rpc_custom_subsystem, &count);

    for (size_t i = 0; i < count; i++) {
        struct zmk_rpc_custom_subsystem *subsys;
        STRUCT_SECTION_GET(zmk_rpc_custom_subsystem, i, &subsys);
        if (strcmp(subsys->identifier, "cormoran__kscan_diagnostics") == 0) {
            return subsys->handler;
        }
    }
    return NULL;
}

/* Decode callback for zmk_custom_CallResponse.payload (a pb_callback_t bytes
 * field with no fixed max_size): copies the remaining raw bytes of this
 * submessage into a fixed test buffer, the standard nanopb pattern for
 * decoding a callback-typed bytes field. */
struct call_response_payload_capture {
    uint8_t buf[CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE + 16];
    size_t size;
};

static bool decode_call_response_payload(pb_istream_t *stream, const pb_field_t *field,
                                         void **arg) {
    ARG_UNUSED(field);
    struct call_response_payload_capture *capture = *arg;

    if (stream->bytes_left > sizeof(capture->buf)) {
        LOG_ERR("CallResponse payload too large for test capture buffer: %u",
                (unsigned int)stream->bytes_left);
        return false;
    }

    capture->size = stream->bytes_left;
    return pb_read(stream, capture->buf, capture->size);
}

/* Encodes req, calls the handler, decodes the response into *out. Returns
 * true on success (handler returned true and response decoded OK). */
static bool call_kscan_diagnostics_rpc(const cormoran_kscan_diagnostics_Request *req,
                                       cormoran_kscan_diagnostics_Response *out) {
    custom_subsystem_handler *handler = find_kscan_diagnostics_rpc_handler();
    if (!handler) {
        LOG_ERR("kscan_diagnostics RPC subsystem not registered");
        return false;
    }

    static zmk_custom_CallRequest raw_request;
    raw_request = (zmk_custom_CallRequest){0};
    pb_ostream_t req_stream =
        pb_ostream_from_buffer(raw_request.payload.bytes, sizeof(raw_request.payload.bytes));
    if (!pb_encode(&req_stream, cormoran_kscan_diagnostics_Request_fields, req)) {
        LOG_ERR("Failed to encode kscan_diagnostics request: %s", PB_GET_ERROR(&req_stream));
        return false;
    }
    raw_request.payload.size = req_stream.bytes_written;

    zmk_custom_CallResponse response = zmk_custom_CallResponse_init_zero;
    bool ok = handler(&raw_request, &response.payload);
    if (!ok || !response.payload.funcs.encode) {
        LOG_ERR("kscan_diagnostics RPC handler did not produce a response encoder");
        return false;
    }

    static uint8_t call_resp_buf[CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE + 16];
    pb_ostream_t call_resp_stream = pb_ostream_from_buffer(call_resp_buf, sizeof(call_resp_buf));
    if (!pb_encode(&call_resp_stream, zmk_custom_CallResponse_fields, &response)) {
        LOG_ERR("Failed to encode CallResponse: %s", PB_GET_ERROR(&call_resp_stream));
        return false;
    }

    static struct call_response_payload_capture capture;
    capture = (struct call_response_payload_capture){0};

    zmk_custom_CallResponse decoded_call_resp = zmk_custom_CallResponse_init_zero;
    decoded_call_resp.payload.funcs.decode = decode_call_response_payload;
    decoded_call_resp.payload.arg = &capture;

    pb_istream_t call_resp_istream =
        pb_istream_from_buffer(call_resp_buf, call_resp_stream.bytes_written);
    if (!pb_decode(&call_resp_istream, zmk_custom_CallResponse_fields, &decoded_call_resp)) {
        LOG_ERR("Failed to decode CallResponse: %s", PB_GET_ERROR(&call_resp_istream));
        return false;
    }

    *out = (cormoran_kscan_diagnostics_Response)cormoran_kscan_diagnostics_Response_init_zero;
    pb_istream_t resp_istream = pb_istream_from_buffer(capture.buf, capture.size);
    if (!pb_decode(&resp_istream, cormoran_kscan_diagnostics_Response_fields, out)) {
        LOG_ERR("Failed to decode kscan_diagnostics response: %s", PB_GET_ERROR(&resp_istream));
        return false;
    }

    return true;
}

static int test_rpc_get_info(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_info_tag;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_info_tag) {
        LOG_ERR("expected info response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_Info *info = &resp.response_type.info;
    if (info->layout_count != 1 || info->device_count != 1 || info->stats_enabled != false ||
        info->max_positions != CONFIG_ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS) {
        LOG_ERR("unexpected Info: layout_count=%u device_count=%u stats_enabled=%d "
                "max_positions=%u",
                info->layout_count, info->device_count, info->stats_enabled,
                info->max_positions);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_info");
    return 0;
}

static int test_rpc_get_layout(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_layout_tag;
    req.request_type.get_layout.layout_index = 0;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_layout_tag) {
        LOG_ERR("expected layout response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_Layout *layout = &resp.response_type.layout;
    if (layout->rows != 2 || layout->columns != 2 || layout->key_count != 4) {
        LOG_ERR("unexpected Layout: rows=%u columns=%u key_count=%u", layout->rows,
                layout->columns, layout->key_count);
        return -EINVAL;
    }
    if (layout->device_indices_count != 1 || layout->device_indices[0].leaf_index != 0 ||
        layout->device_indices[0].row_offset != 0 || layout->device_indices[0].col_offset != 0) {
        LOG_ERR("unexpected Layout.device_indices: count=%u",
                (unsigned int)layout->device_indices_count);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_layout");
    return 0;
}

static int test_rpc_get_device(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_device_tag;
    req.request_type.get_device.device_index = 0;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_device_tag) {
        LOG_ERR("expected device response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_Device *device = &resp.response_type.device;
    if (device->type != cormoran_kscan_diagnostics_KscanDriverType_MOCK || device->rows != 2 ||
        device->columns != 2) {
        LOG_ERR("unexpected Device: type=%d rows=%u columns=%u", device->type, device->rows,
                device->columns);
        return -EINVAL;
    }
    if (strcmp(device->node_name, "native_posix_64_kscan_mock") != 0) {
        LOG_ERR("unexpected Device.node_name: %s", device->node_name);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_device");
    return 0;
}

static int test_rpc_get_gpio_pins_empty(void) {
    /* zmk,kscan-mock has no GPIO lines at all (rows/columns are descriptive
     * only -- see topology.c's zmk,kscan-mock block), so this must always
     * report an empty page regardless of requested kind. */
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_gpio_pins_tag;
    req.request_type.get_gpio_pins.device_index = 0;
    req.request_type.get_gpio_pins.kind = cormoran_kscan_diagnostics_GpioLineKind_KIND_UNKNOWN;
    req.request_type.get_gpio_pins.offset = 0;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_gpio_pins_tag) {
        LOG_ERR("expected gpio_pins response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_GpioPins *pins = &resp.response_type.gpio_pins;
    if (pins->total != 0 || pins->pins_count != 0) {
        LOG_ERR("unexpected GpioPins: total=%u pins_count=%u", pins->total,
                (unsigned int)pins->pins_count);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_gpio_pins_empty");
    return 0;
}

static int test_rpc_get_position_map(void) {
    /* tests/test.dtsi's transform0.map is RC(0,0) RC(0,1) RC(1,0) RC(1,1),
     * i.e. row-major position order 0,1,2,3 -- position+1 encoding (0 =
     * unmapped) means the expected cells are 1,2,3,4. */
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_position_map_tag;
    req.request_type.get_position_map.layout_index = 0;
    req.request_type.get_position_map.offset = 0;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }

    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_position_map_tag) {
        LOG_ERR("expected position_map response, got %d", resp.which_response_type);
        return -EINVAL;
    }
    const cormoran_kscan_diagnostics_PositionMap *map = &resp.response_type.position_map;
    if (map->total != 4 || map->offset != 0 || map->cells_count != 4) {
        LOG_ERR("unexpected PositionMap: total=%u offset=%u cells_count=%u", map->total,
                map->offset, (unsigned int)map->cells_count);
        return -EINVAL;
    }
    static const uint32_t expected_cells[4] = {1, 2, 3, 4};
    for (size_t i = 0; i < ARRAY_SIZE(expected_cells); i++) {
        if (map->cells[i] != expected_cells[i]) {
            LOG_ERR("PositionMap.cells[%u] = %u, expected %u", (unsigned int)i, map->cells[i],
                    expected_cells[i]);
            return -EINVAL;
        }
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_get_position_map");
    return 0;
}

static int test_rpc_unknown_index_errors(void) {
    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;
    req.which_request_type = cormoran_kscan_diagnostics_Request_get_device_tag;
    req.request_type.get_device.device_index = 99;

    cormoran_kscan_diagnostics_Response resp;
    if (!call_kscan_diagnostics_rpc(&req, &resp)) {
        return -EINVAL;
    }
    if (resp.which_response_type != cormoran_kscan_diagnostics_Response_error_tag) {
        LOG_ERR("expected error response for unknown device index, got %d",
                resp.which_response_type);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_diagnostics_rpc_unknown_index_errors");
    return 0;
}

static int kscan_diagnostics_rpc_test_init(void) {
    int ret = test_rpc_get_info();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_layout();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_device();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_gpio_pins_empty();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_get_position_map();
    if (ret < 0) {
        return ret;
    }

    ret = test_rpc_unknown_index_errors();
    if (ret < 0) {
        return ret;
    }

    return 0;
}

SYS_INIT(kscan_diagnostics_rpc_test_init, APPLICATION, 99);
