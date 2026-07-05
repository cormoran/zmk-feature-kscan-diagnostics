/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#include <stdio.h>
#include <string.h>

#include <pb_decode.h>
#include <pb_encode.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <zmk/studio/custom.h>
#include <cormoran/kscan-diagnostics/kscan_diagnostics.pb.h>
#include <cormoran/kscan_diagnostics/topology.h>

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

/*
 * Response size budget (DESIGN.md SS6): the two chunked responses are the
 * largest members of the Response oneof.
 *
 * GpioPins (KSCAN_DIAGNOSTICS_RPC_GPIO_PAGE_SIZE=4 pins, must match
 * kscan_diagnostics.options' GpioPins.pins max_count):
 *   total, offset (2 uint32 fields)                        ~=  2 *  6 =  12
 *   per GpioPin: index, pin, active_low, dt_flags (4 fields) ~= 4 *  6 = 24
 *               port (tag+len+12 chars)                     ~=        15
 *               submessage tag+len                          ~=         2
 *   per pin total                                           ~=        41
 *   4 pins                                                  ~=       164
 *   GpioPins submessage tag+len                             ~=         4
 *   ------------------------------------------------------------------
 *   total                                                   ~=       180
 *
 * PositionMap (KSCAN_DIAGNOSTICS_RPC_POSITION_PAGE_SIZE=24 cells, must match
 * kscan_diagnostics.options' PositionMap.cells max_count):
 *   total, offset (2 uint32 fields)                         ~=        12
 *   24 cells, varint packed repeated uint32 (~2 B each worst case) ~= 48
 *   PositionMap submessage tag+len                          ~=         4
 *   ------------------------------------------------------------------
 *   total                                                   ~=        64
 *
 * GpioPins is the larger of the two.  Response oneof wrapper adds a few more
 * bytes; rounded up with headroom below.
 * CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=256 is configured in
 * tests/studio/native_sim.conf and tests/zmk-config/build.yaml.
 */
#define KSCAN_DIAGNOSTICS_RPC_GPIO_PAGE_SIZE 4
#define KSCAN_DIAGNOSTICS_RPC_POSITION_PAGE_SIZE 24
#define KSCAN_DIAGNOSTICS_RPC_ESTIMATED_MAX_RESPONSE_SIZE 180

BUILD_ASSERT(KSCAN_DIAGNOSTICS_RPC_ESTIMATED_MAX_RESPONSE_SIZE + 64 <=
                 CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE,
             "CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE is too small for a full kscan diagnostics "
             "GpioPins response -- see the arithmetic comment above");

BUILD_ASSERT(KSCAN_DIAGNOSTICS_RPC_GPIO_PAGE_SIZE <= 4, "must match kscan_diagnostics.options");
BUILD_ASSERT(KSCAN_DIAGNOSTICS_RPC_POSITION_PAGE_SIZE <= 24,
             "must match kscan_diagnostics.options");

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

static void set_error(cormoran_kscan_diagnostics_Response *resp, const char *message) {
    cormoran_kscan_diagnostics_Error err = cormoran_kscan_diagnostics_Error_init_zero;
    snprintf(err.message, sizeof(err.message), "%s", message);
    resp->which_response_type = cormoran_kscan_diagnostics_Response_error_tag;
    resp->response_type.error = err;
}

static void handle_get_info(const cormoran_kscan_diagnostics_GetInfo *req,
                            cormoran_kscan_diagnostics_Response *resp) {
    ARG_UNUSED(req);

    cormoran_kscan_diagnostics_Info info = cormoran_kscan_diagnostics_Info_init_zero;
    info.proto_version = 1;
    info.layout_count = (uint32_t)ksd_topology_layout_count();
    info.selected_layout = (uint32_t)ksd_topology_selected_layout();
    info.device_count = (uint32_t)ksd_topology_device_count();
    info.stats_enabled = false; /* stats land in Phase C */
    info.max_positions = CONFIG_ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS;
    info.uptime_ms = (uint32_t)k_uptime_get();

    resp->which_response_type = cormoran_kscan_diagnostics_Response_info_tag;
    resp->response_type.info = info;
}

static void handle_get_layout(const cormoran_kscan_diagnostics_GetLayout *req,
                              cormoran_kscan_diagnostics_Response *resp) {
    const struct ksd_layout *layout = ksd_topology_get_layout(req->layout_index);
    if (layout == NULL) {
        set_error(resp, "Unknown layout index");
        return;
    }

    cormoran_kscan_diagnostics_Layout out = cormoran_kscan_diagnostics_Layout_init_zero;
    out.layout_index = req->layout_index;
    snprintf(out.display_name, sizeof(out.display_name), "%s",
             layout->display_name ? layout->display_name : "");
    out.rows = layout->rows;
    out.columns = layout->columns;
    out.key_count = layout->key_count;

    size_t count = MIN(layout->device_count, ARRAY_SIZE(out.device_indices));
    for (size_t i = 0; i < count; i++) {
        out.device_indices[i].leaf_index = layout->devices[i].leaf_index;
        out.device_indices[i].row_offset = layout->devices[i].row_offset;
        out.device_indices[i].col_offset = layout->devices[i].col_offset;
    }
    out.device_indices_count = (pb_size_t)count;

    resp->which_response_type = cormoran_kscan_diagnostics_Response_layout_tag;
    resp->response_type.layout = out;
}

static void handle_get_device(const cormoran_kscan_diagnostics_GetDevice *req,
                              cormoran_kscan_diagnostics_Response *resp) {
    const struct ksd_device *device = ksd_topology_get_device(req->device_index);
    if (device == NULL) {
        set_error(resp, "Unknown device index");
        return;
    }

    cormoran_kscan_diagnostics_Device out = cormoran_kscan_diagnostics_Device_init_zero;
    out.device_index = req->device_index;
    snprintf(out.node_name, sizeof(out.node_name), "%s",
             device->node_name ? device->node_name : "");
    out.type = (cormoran_kscan_diagnostics_KscanDriverType)device->type;
    out.rows = device->rows;
    out.columns = device->columns;
    out.inputs = device->inputs;
    out.debounce_press_ms = device->debounce_press_ms;
    out.debounce_release_ms = device->debounce_release_ms;
    out.debounce_scan_period_ms = device->debounce_scan_period_ms;
    out.poll_period_ms = device->poll_period_ms;
    out.diode_row2col = device->diode_row2col;
    out.toggle_mode = device->toggle_mode;

    resp->which_response_type = cormoran_kscan_diagnostics_Response_device_tag;
    resp->response_type.device = out;
}

static bool gpio_line_matches_kind(const struct ksd_gpio_line *line, uint32_t kind) {
    if (kind == cormoran_kscan_diagnostics_GpioLineKind_KIND_UNKNOWN) {
        return true; /* unfiltered: return every line regardless of kind */
    }
    return (uint32_t)line->kind == kind;
}

static void handle_get_gpio_pins(const cormoran_kscan_diagnostics_GetGpioPins *req,
                                 cormoran_kscan_diagnostics_Response *resp) {
    const struct ksd_device *device = ksd_topology_get_device(req->device_index);
    if (device == NULL) {
        set_error(resp, "Unknown device index");
        return;
    }

    cormoran_kscan_diagnostics_GpioPins out = cormoran_kscan_diagnostics_GpioPins_init_zero;

    /* Count matching lines first so `total` is correct even when the
     * requested offset is past the matching subset. */
    uint32_t total = 0;
    for (size_t i = 0; i < device->gpio_line_count; i++) {
        if (gpio_line_matches_kind(&device->gpio_lines[i], req->kind)) {
            total++;
        }
    }

    out.total = total;
    out.offset = req->offset;

    uint32_t seen = 0;
    for (size_t i = 0;
         i < device->gpio_line_count && out.pins_count < KSCAN_DIAGNOSTICS_RPC_GPIO_PAGE_SIZE;
         i++) {
        const struct ksd_gpio_line *line = &device->gpio_lines[i];
        if (!gpio_line_matches_kind(line, req->kind)) {
            continue;
        }
        if (seen < req->offset) {
            seen++;
            continue;
        }
        cormoran_kscan_diagnostics_GpioPin *pin = &out.pins[out.pins_count];
        pin->index = line->index;
        snprintf(pin->port, sizeof(pin->port), "%s", line->port_name ? line->port_name : "");
        pin->pin = line->pin;
        pin->active_low = line->active_low;
        pin->dt_flags = line->dt_flags;
        out.pins_count++;
        seen++;
    }

    resp->which_response_type = cormoran_kscan_diagnostics_Response_gpio_pins_tag;
    resp->response_type.gpio_pins = out;
}

static void handle_get_position_map(const cormoran_kscan_diagnostics_GetPositionMap *req,
                                    cormoran_kscan_diagnostics_Response *resp) {
    const struct ksd_layout *layout = ksd_topology_get_layout(req->layout_index);
    if (layout == NULL) {
        set_error(resp, "Unknown layout index");
        return;
    }

    cormoran_kscan_diagnostics_PositionMap out = cormoran_kscan_diagnostics_PositionMap_init_zero;

    uint32_t total = (uint32_t)layout->rows * (uint32_t)layout->columns;
    out.total = total;
    out.offset = req->offset;

    for (uint32_t cell = req->offset;
         cell < total && out.cells_count < KSCAN_DIAGNOSTICS_RPC_POSITION_PAGE_SIZE; cell++) {
        uint32_t row = cell / layout->columns;
        uint32_t column = cell % layout->columns;
        int32_t position = ksd_topology_position_for_cell(req->layout_index, row, column);
        /* 0 = unmapped, otherwise position+1 (DESIGN.md SS6). */
        out.cells[out.cells_count] = (position < 0) ? 0 : (uint32_t)(position + 1);
        out.cells_count++;
    }

    resp->which_response_type = cormoran_kscan_diagnostics_Response_position_map_tag;
    resp->response_type.position_map = out;
}

static bool kscan_diagnostics_rpc_handle_request(const zmk_custom_CallRequest *raw_request,
                                                 pb_callback_t *encode_response) {
    cormoran_kscan_diagnostics_Response *resp = ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(
        cormoran__kscan_diagnostics, encode_response);

    cormoran_kscan_diagnostics_Request req = cormoran_kscan_diagnostics_Request_init_zero;

    pb_istream_t req_stream =
        pb_istream_from_buffer(raw_request->payload.bytes, raw_request->payload.size);
    if (!pb_decode(&req_stream, cormoran_kscan_diagnostics_Request_fields, &req)) {
        LOG_WRN("Failed to decode kscan_diagnostics request: %s", PB_GET_ERROR(&req_stream));
        set_error(resp, "Failed to decode request");
        return true;
    }

    switch (req.which_request_type) {
    case cormoran_kscan_diagnostics_Request_get_info_tag:
        handle_get_info(&req.request_type.get_info, resp);
        break;
    case cormoran_kscan_diagnostics_Request_get_layout_tag:
        handle_get_layout(&req.request_type.get_layout, resp);
        break;
    case cormoran_kscan_diagnostics_Request_get_device_tag:
        handle_get_device(&req.request_type.get_device, resp);
        break;
    case cormoran_kscan_diagnostics_Request_get_gpio_pins_tag:
        handle_get_gpio_pins(&req.request_type.get_gpio_pins, resp);
        break;
    case cormoran_kscan_diagnostics_Request_get_position_map_tag:
        handle_get_position_map(&req.request_type.get_position_map, resp);
        break;
    default:
        LOG_WRN("Unsupported kscan_diagnostics request type: %d", req.which_request_type);
        set_error(resp, "Unsupported request type");
        break;
    }

    return true;
}
