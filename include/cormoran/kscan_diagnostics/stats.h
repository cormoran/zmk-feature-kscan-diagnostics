/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Per-position event statistics (DESIGN.md SS5), exposed via the
 * GetStats/ResetStats RPCs (see cormoran.kscan_diagnostics.PositionStats).
 * Maintained by a ZMK_LISTENER on zmk_position_state_changed running entirely
 * on the event thread; readers (the RPC handler) take a copy under
 * ksd_stats_lock (see stats.c) rather than holding a reference into the live
 * table.
 */
struct ksd_pos_stats {
    uint16_t presses;               /* saturating */
    uint16_t releases;              /* saturating */
    uint16_t min_press_duration_ms; /* 0xFFFF = none observed yet */
    uint16_t min_repress_gap_ms;    /* release -> press gap; 0xFFFF = none yet */
    uint16_t repress_lt[4];         /* gap < 5/10/20/50 ms bucket counts (saturating) */
    uint8_t last_source;            /* zmk_position_state_changed source; UINT8_MAX = local */
};

/** @return CONFIG_ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS, the stats table size. */
size_t ksd_stats_max_positions(void);

/**
 * Copy the stats for position @p position into *out.
 *
 * @retval true position was in range and *out was filled in (zeroed entry if
 *         no events have been observed for it yet).
 * @retval false position >= ksd_stats_max_positions().
 */
bool ksd_stats_get(size_t position, struct ksd_pos_stats *out);

/** Zero every position's counters (the ResetStats RPC). */
void ksd_stats_reset_all(void);

#ifdef __cplusplus
}
#endif
