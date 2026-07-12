/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <cormoran/kscan_diagnostics/kscan_diagnostics.pb.h>

/*
 * Handle a QueryPeripheral RPC on the split central: relay the wrapped inner
 * Request to all connected peripherals and answer the RPC immediately with an
 * Ok acknowledgement (or an Error). Each peripheral's reply arrives later as a
 * PeripheralEvent notification (see src/split/kscan_diagnostics_relay.c).
 *
 * Only defined when CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT is enabled on the
 * central role; the Studio handler guards the call site on the same symbol.
 */
void ksd_relay_central_query(const cormoran_kscan_diagnostics_QueryPeripheral *req,
                             cormoran_kscan_diagnostics_Response *resp);
