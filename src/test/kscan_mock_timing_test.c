/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 *
 * Regression test for zmk,kscan-mock's real event-scheduling timing model,
 * discovered the hard way during Phase E hardware validation (see
 * docs/validation.md and
 * tests/zmk-config/snippets/diag-hw-mock/diag-hw-mock.overlay's header
 * comment for the full story): `kscan_mock_work_handler` fires
 * `events[event_index]` and calls `kscan_mock_schedule_next_event(dev)`
 * *before* incrementing `event_index` (see
 * dependencies/zmk/app/module/drivers/kscan/kscan_mock.c), so that call
 * re-reads the just-fired event's own delay field to arm the timer for the
 * *next* event rather than that event's own delay. Net effect:
 * `events[0]`'s delay is consumed twice (once for event 0's own initial
 * wait, again -- redundantly -- for the wait before event 1); every other
 * `events[i]`'s delay controls the wait before event `i+1`, not event `i`;
 * and the last event's own delay field is never consumed.
 *
 * This test does not touch Studio/RPC at all -- it reads
 * src/stats.c's counters directly via ksd_stats_get(), which is exactly
 * what a real diagnostics session (or the GetStats RPC) would report, and
 * asserts they match the *actual* (one-event-behind) model rather than the
 * naive "each event's own delay is the wait before that event" reading that
 * an initial hardware test script wrongly assumed. See
 * tests/mock-timing/native_sim.keymap for the exact scripted event list and
 * the two models' distinct predictions.
 */

#include <errno.h>
#include <stdlib.h>

#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include <cormoran/kscan_diagnostics/stats.h>

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

static int test_mock_timing_model(void) {
    struct ksd_pos_stats stats;
    if (!ksd_stats_get(0, &stats)) {
        LOG_ERR("ksd_stats_get(0) failed");
        return -EINVAL;
    }

    /*
     * tests/mock-timing/native_sim.keymap scripts (DT delay values):
     *   ZMK_MOCK_PRESS(0,0,50) ZMK_MOCK_RELEASE(0,0,10)
     *   ZMK_MOCK_PRESS(0,0,40) ZMK_MOCK_RELEASE(0,0,0)
     * Under the actual (one-event-behind) model, real firing times are
     * T = [50, 100, 110, 150]:
     *   hold1  = T[1]-T[0] = 50ms
     *   gap    = T[2]-T[1] = 10ms  (repress gap)
     *   hold2  = T[3]-T[2] = 40ms
     * so min_press_duration_ms should settle at min(50, 40) = 40, and
     * min_repress_gap_ms at 10 (falling in the "<20ms" bucket, not "<10ms").
     *
     * A naive (wrong) reading of the same DT array -- each event's own delay
     * is the wait before *that* event -- would instead predict
     * T = [50, 60, 100, 100]: hold1=10, gap=40, hold2=0, i.e.
     * min_press_duration_ms=0 and min_repress_gap_ms=40 (a "<50ms" bucket
     * hit, not "<20ms"). The two models are clearly distinguishable; this
     * test pins down which one is real.
     *
     * CONFIG_NATIVE_SIM_SLOWDOWN_TO_REAL_TIME=y (ZMK's native_sim default)
     * makes this a real wall-clock-timed simulation with a few ms of jitter
     * per hop (same as tests/test.dtsi's own comment), so assert tolerant
     * ranges rather than exact milliseconds.
     */
    if (stats.presses != 2 || stats.releases != 2) {
        LOG_ERR("unexpected counts: presses=%u releases=%u", stats.presses, stats.releases);
        return -EINVAL;
    }
    if (stats.min_press_duration_ms < 30 || stats.min_press_duration_ms > 45) {
        LOG_ERR("min_press_duration_ms=%u outside actual-model range [30,45] -- if this is "
                "near 0 or 10, the mock's timing model may have changed and "
                "tests/zmk-config/snippets/diag-hw-mock/ + docs/validation.md need updating",
                stats.min_press_duration_ms);
        return -EINVAL;
    }
    if (stats.min_repress_gap_ms < 5 || stats.min_repress_gap_ms > 15) {
        LOG_ERR("min_repress_gap_ms=%u outside actual-model range [5,15] -- if this is "
                "near 40, the mock's timing model may have changed and "
                "tests/zmk-config/snippets/diag-hw-mock/ + docs/validation.md need updating",
                stats.min_repress_gap_ms);
        return -EINVAL;
    }
    /* gap ~10ms must land in the "<20ms" bucket, not "<10ms" or "<50ms". */
    if (stats.repress_lt[2] != 1 || stats.repress_lt[0] != 0 || stats.repress_lt[1] != 0 ||
        stats.repress_lt[3] != 0) {
        LOG_ERR("unexpected repress buckets: lt5=%u lt10=%u lt20=%u lt50=%u", stats.repress_lt[0],
                stats.repress_lt[1], stats.repress_lt[2], stats.repress_lt[3]);
        return -EINVAL;
    }

    LOG_INF("PASS: kscan_mock_timing_model");
    return 0;
}

static int kscan_mock_timing_test_run(void) {
    /* Scripted events finish well within a few hundred ms; sleep past that
     * before asserting (same pattern as src/test/kscan_diagnostics_rpc_test.c). */
    k_sleep(K_MSEC(500));

    int ret = test_mock_timing_model();

    /* No `exit-after` on this fixture's &kscan (deleted in
     * tests/mock-timing/native_sim.keymap) -- this test must end the process
     * itself, same reasoning as kscan_diagnostics_rpc_test.c. */
    exit(ret < 0 ? 1 : 0);
    return 0; /* unreachable */
}

SYS_INIT(kscan_mock_timing_test_run, APPLICATION, 99);
