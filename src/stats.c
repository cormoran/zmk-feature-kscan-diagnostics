/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 *
 * Per-position event statistics (DESIGN.md SS5). A ZMK_LISTENER on
 * zmk_position_state_changed is always-on when CONFIG_ZMK_KSCAN_DIAGNOSTICS=y
 * (unlike input-stream's opt-in streaming -- counters are cheap to maintain).
 * Runs entirely on the event thread; the RPC handler (and tests) read a
 * snapshot copy taken under a spinlock, matching zmk-module-devtool's
 * log_ring_lock pattern.
 */

#include <cormoran/kscan_diagnostics/stats.h>

#include <string.h>

#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>

#include <zmk/events/position_state_changed.h>
#include <zmk/event_manager.h>

#define KSD_STATS_MAX_POSITIONS CONFIG_ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS

/* Internal per-position scratch, not exposed via RPC (DESIGN.md SS5). */
struct ksd_pos_scratch {
    uint32_t last_press_ms;
    uint32_t last_release_ms;
    bool has_last_press;
    bool has_last_release;
};

static struct ksd_pos_stats ksd_stats_table[KSD_STATS_MAX_POSITIONS];
static struct ksd_pos_scratch ksd_scratch_table[KSD_STATS_MAX_POSITIONS];
static struct k_spinlock ksd_stats_lock;

size_t ksd_stats_max_positions(void) { return KSD_STATS_MAX_POSITIONS; }

bool ksd_stats_get(size_t position, struct ksd_pos_stats *out) {
    if (position >= KSD_STATS_MAX_POSITIONS) {
        return false;
    }
    K_SPINLOCK(&ksd_stats_lock) { *out = ksd_stats_table[position]; }
    return true;
}

void ksd_stats_reset_all(void) {
    K_SPINLOCK(&ksd_stats_lock) {
        memset(ksd_stats_table, 0, sizeof(ksd_stats_table));
        memset(ksd_scratch_table, 0, sizeof(ksd_scratch_table));
        for (size_t i = 0; i < KSD_STATS_MAX_POSITIONS; i++) {
            ksd_stats_table[i].min_press_duration_ms = UINT16_MAX;
            ksd_stats_table[i].min_repress_gap_ms = UINT16_MAX;
        }
    }
}

static uint16_t sat_inc_u16(uint16_t v) { return v == UINT16_MAX ? v : (uint16_t)(v + 1); }

static void handle_press(struct ksd_pos_stats *stats, struct ksd_pos_scratch *scratch,
                         uint32_t now_ms, uint8_t source) {
    stats->presses = sat_inc_u16(stats->presses);
    stats->last_source = source;

    if (scratch->has_last_release) {
        uint32_t gap = now_ms - scratch->last_release_ms;
        if (gap < stats->min_repress_gap_ms) {
            stats->min_repress_gap_ms = (uint16_t)MIN(gap, UINT16_MAX);
        }
        if (gap < 5) {
            stats->repress_lt[0] = sat_inc_u16(stats->repress_lt[0]);
        } else if (gap < 10) {
            stats->repress_lt[1] = sat_inc_u16(stats->repress_lt[1]);
        } else if (gap < 20) {
            stats->repress_lt[2] = sat_inc_u16(stats->repress_lt[2]);
        } else if (gap < 50) {
            stats->repress_lt[3] = sat_inc_u16(stats->repress_lt[3]);
        }
    }

    scratch->last_press_ms = now_ms;
    scratch->has_last_press = true;
}

static void handle_release(struct ksd_pos_stats *stats, struct ksd_pos_scratch *scratch,
                           uint32_t now_ms, uint8_t source) {
    stats->releases = sat_inc_u16(stats->releases);
    stats->last_source = source;

    if (scratch->has_last_press) {
        uint32_t duration = now_ms - scratch->last_press_ms;
        if (duration < stats->min_press_duration_ms) {
            stats->min_press_duration_ms = (uint16_t)MIN(duration, UINT16_MAX);
        }
    }

    scratch->last_release_ms = now_ms;
    scratch->has_last_release = true;
}

static int ksd_stats_on_position_state_changed(const zmk_event_t *eh) {
    const struct zmk_position_state_changed *ev = as_zmk_position_state_changed(eh);
    if (!ev) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (ev->position >= KSD_STATS_MAX_POSITIONS) {
        return ZMK_EV_EVENT_BUBBLE;
    }

    uint32_t now_ms = (uint32_t)ev->timestamp;

    K_SPINLOCK(&ksd_stats_lock) {
        struct ksd_pos_stats *stats = &ksd_stats_table[ev->position];
        struct ksd_pos_scratch *scratch = &ksd_scratch_table[ev->position];
        if (ev->state) {
            handle_press(stats, scratch, now_ms, ev->source);
        } else {
            handle_release(stats, scratch, now_ms, ev->source);
        }
    }

    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(kscan_diagnostics_stats, ksd_stats_on_position_state_changed);
ZMK_SUBSCRIPTION(kscan_diagnostics_stats, zmk_position_state_changed);

static int ksd_stats_init(void) {
    ksd_stats_reset_all();
    return 0;
}

SYS_INIT(ksd_stats_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
