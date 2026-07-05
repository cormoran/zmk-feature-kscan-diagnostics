# Phase E: hardware validation

Validates the real ZMK Studio custom-RPC round trip
(`cormoran__kscan_diagnostics`) on physical hardware: SEGGER J-Link + Seeed
XIAO nRF52840, **no physical key switches attached**. Uses `zmk,kscan-mock`
(scripted firmware-generated key events, no switches needed) plus the
existing direct-kscan build (`tester_xiao`'s real `xiao_d 0..10` GPIO pins) to
exercise the full chain: flash -> boot -> RPC client on this PC talks to the
custom subsystem over USB -> GetInfo/GetLayout/GetDevice/GetGpioPins/
GetPositionMap/GetStats/ResetStats all return sane data.

Rig: `skills/develop-zmk-module/references/hardware-rig.md` (this workspace).
Board used: "Abyss Tester XIAO", serial `10E4D16A1E4BFE9C`, driven by J-Link
serial `1057792823` (no `CONFIG_FLASH_LOAD_OFFSET`/code-partition workaround
needed for this specific unit -- see
`zmk-dev-two-jlink-rig-project` session memory).

## Build

New build-test artifact `kscan_diagnostics_board_hw_mock` in
`tests/zmk-config/build.yaml`, backed by a new snippet
`tests/zmk-config/snippets/diag-hw-mock/`:

```
west zmk-build tests/zmk-config -af hw_mock -q
```

cmake args: `-DCONFIG_ZMK_STUDIO=y -DCONFIG_ZMK_KSCAN_DIAGNOSTICS=y
-DCONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC=y -DCONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE=256
-DCONFIG_LOG_PROCESS_THREAD_STARTUP_DELAY_MS=0 -DCONFIG_SEGGER_RTT_BUFFER_SIZE_UP=8192
-DCONFIG_USE_SEGGER_RTT=y -DCONFIG_LOG_BACKEND_RTT=y -DCONFIG_LOG=y`,
snippets `studio-rpc-usb-uart` + `diag-hw-mock`.

`diag-hw-mock.overlay` replaces `tester_xiao`'s baseline direct kscan with a
`zmk,kscan-mock(rows=2,columns=2)` plus a 2x2 physical layout/matrix-transform
(same topology as `tests/test.dtsi`'s native_sim fixture) and a scripted
`events` list. See that file's header comment for the full script and the
timing-model writeup below.

The existing `kscan_diagnostics_board_with_rpc` artifact (direct kscan,
`tester_xiao`'s real `xiao_d 0..10` pins) was reused as-is to validate
`GetGpioPins` against real GPIO pin numbers/ports.

Ran inside the nix devshell from the repo root:

```
nix --extra-experimental-features 'nix-command flakes' develop /home/ubuntu/zmk-workspace/nix \
  --command bash -lc 'west zmk-build tests/zmk-config -af hw_mock -q'
```

## Flash

Per `skills/develop-zmk-module/references/hardware-rig.md`: `loadfile <hex>`
(JLinkExe's own implicit sector erase/compare, not a manual `erase`) + `r` +
`go`, via a real command file (`JLinkExe` can't read stdin):

```
SelectEmuBySN 1057792823
device nRF52840_xxAA
if SWD
speed 4000
loadfile <build>/zephyr/zmk.hex
r
go
Exit
```

```
JLinkExe -NoGui 1 -CommandFile <file>.jlink
```

This unit did **not** need the `CONFIG_FLASH_LOAD_OFFSET`/code-partition
devicetree override that the rig doc warns about for the "stale flash" unit
-- confirmed via `arm-zephyr-eabi-objdump -f zephyr/zmk.elf | grep 'start
address'` before flashing (start address `0x345cd`, i.e. linked normally
against the standard `code_partition@0x27000`) and successful USB
enumeration/RPC afterward. That workaround is specific to the *other* XIAO
unit on this rig ("Module Test", serial `0C5B206D3B120A9F`, J-Link
`1050398082`), per prior-session memory
(`zmk-dev-two-jlink-rig-project`), not this one.

## Boot confirmation via RTT

Zeroed the `_SEGGER_RTT` signature (`w4 <addr>, 0x00000000` x4 at
`_SEGGER_RTT`'s address, found via `arm-zephyr-eabi-nm zephyr/zmk.elf | grep
_SEGGER_RTT` -> `20002010`), reset (`r`+`go`), then read the up-buffer-0
descriptor with `mem32 0x20002000, 0x40` and dumped the ring buffer with
`savebin <file> <pBuffer> <SizeOfBuffer>` + `strings`.

Confirmed boot and the mock kscan generating scripted events, e.g.:

```
[00:00:04.260,894]
<dbg> zmk: kscan_mock_work_handler_0: ev 2409627648 row 0 column 0 state 1
[00:00:04.260,986]
<dbg> zmk: zmk_physical_layouts_kscan_process_msgq: Row: 0, col: 0, position: 0, pressed: true
[00:00:04.261,016]
<dbg> zmk: position_state_changed_listener: 0 bubble (no undecided hold_tap active)
```

RTT logging on this rig only reliably shows a slice of history around the
capture time -- `CONFIG_SEGGER_RTT_BUFFER_SIZE_UP=8192` still wraps within a
few hundred ms of `DBG`-level ZMK boot logging (BLE/USB/battery-voltage
-divider init all log at `<dbg>`). This matches the design's own conclusion
(DESIGN.md SS3.1, SS10): **the RPC-reported stats counters are the ground
truth for timing analysis, not logs.** RTT here is only used to confirm
"the firmware is alive and the mock is producing events," not for exact
timing reconstruction.

## RPC transcripts

All calls via
`tools/zmk-studio-rpc --workspace /home/ubuntu/zmk-workspace --transport pyusb
custom-call --identifier cormoran__kscan_diagnostics --proto
zmk-feature-kscan-diagnostics/proto/cormoran/kscan_diagnostics/kscan_diagnostics.proto
--request-type cormoran.kscan_diagnostics.Request --response-type
cormoran.kscan_diagnostics.Response --json '<request>'`, run from the
workspace root. No `/dev/ttyACM*`/`zmk-hp-zmk-tty-*` node existed for this
build (`CONFIG_CONSOLE=n`, and `studio-rpc-usb-uart`'s CDC ACM interface isn't
surfaced under this rig's tty naming), so the pyusb transport was used
directly; it auto-detected the USB interface without needing
`--usb-data-interface`. `custom-list` confirmed the subsystem is registered
and reachable while Studio lock state is `LOCKED` (expected -- this subsystem
is deliberately UNSECURED, DESIGN.md SS2/SS10).

### Mock build (`kscan_diagnostics_board_hw_mock`)

`GetInfo`:
```json
{
  "info": {
    "proto_version": 1, "layout_count": 3, "selected_layout": 2,
    "device_count": 1, "stats_enabled": true, "max_positions": 128,
    "uptime_ms": 38863
  }
}
```
`layout_count=3` = `tester_xiao`'s two built-in layouts (`XIAO Pinout`, `Single
Row`) plus this snippet's own `diag_hw_mock_physical_layout`; `selected_layout=2`
is the last one, matching the snippet's `chosen{zmk,physical-layout}` override.
`device_count=1` matches the single mock kscan device.

`GetLayout(2)`:
```json
{
  "layout": {
    "layout_index": 2, "display_name": "Diag HW Mock Layout",
    "rows": 2, "columns": 2, "key_count": 4,
    "device_indices": [{}]
  }
}
```
Matches the snippet's 2x2 layout exactly.

`GetDevice(0)`:
```json
{ "device": { "node_name": "kscan", "type": "MOCK", "rows": 2, "columns": 2 } }
```

`GetGpioPins(device=0, kind=KIND_UNKNOWN, offset=0)`:
```json
{ "gpio_pins": {} }
```
Empty as expected -- `zmk,kscan-mock` has no GPIO lines (topology.c's
zero-line rule for MOCK devices).

`GetPositionMap(layout=2, offset=0)`:
```json
{ "position_map": { "total": 4, "cells": [1, 2, 3, 4] } }
```
Matches the 2x2 identity transform (`RC(0,0) RC(0,1) RC(1,0) RC(1,1)`).

`GetStats(offset=0)` and `GetStats(offset=2)` after the scripted event list
finished playing (see "Timing model" section below for why the script looks
the way it does):
```json
{
  "stats": {
    "total": 128,
    "entries": [
      { "presses": 2, "releases": 2, "min_press_duration_ms": 200,
        "min_repress_gap_ms": 30, "repress_lt50": 1, "last_source": 255 },
      { "position": 1, "presses": 1, "releases": 1,
        "min_press_duration_ms": 200, "min_repress_gap_ms": 65535,
        "last_source": 255 }
    ]
  }
}
```
```json
{
  "stats": {
    "total": 128, "offset": 2,
    "entries": [
      { "position": 2, "min_press_duration_ms": 65535, "min_repress_gap_ms": 65535 },
      { "position": 3, "presses": 1, "releases": 1, "min_press_duration_ms": 500,
        "min_repress_gap_ms": 65535, "last_source": 255 }
    ]
  }
}
```
Exact match with the script's designed timeline (position 0: two press/release
pairs, 200ms holds, 30ms repress gap landing in the `<50ms` bucket; position 1:
one clean press/release, no repress; position 3: the throwaway warm-up pair;
position 2: untouched sentinels).

`ResetStats` -> `{"ok": {}}`, followed by `GetStats(offset=0)` showing both
entries zeroed with `min_press_duration_ms`/`min_repress_gap_ms` back to the
`65535` (`UINT16_MAX`) "no observation yet" sentinel.

### Direct-kscan build (`kscan_diagnostics_board_with_rpc`)

Reflashed the existing direct-kscan artifact to validate `GetGpioPins`
against real `xiao_d 0..10` pins (no switches needed to read topology; a real
keypress was not exercised since no switch is wired to this rig).

`GetDevice(0)`:
```json
{
  "device": {
    "node_name": "kscan", "type": "DIRECT", "rows": 1, "columns": 11,
    "inputs": 11, "debounce_press_ms": 10, "debounce_release_ms": 10,
    "debounce_scan_period_ms": 1, "poll_period_ms": 10
  }
}
```

`GetGpioPins(device=0, offset=0/4/8)` (3 pages, page size 4):
```
index 0: gpio@500000 pin 2  active_low=true dt_flags=17
index 1: gpio@500000 pin 3  active_low=true dt_flags=17
index 2: gpio@500000 pin 28 active_low=true dt_flags=17
index 3: gpio@500000 pin 29 active_low=true dt_flags=17
index 4: gpio@500000 pin 4  active_low=true dt_flags=17
index 5: gpio@500000 pin 5  active_low=true dt_flags=17
index 6: gpio@500003 pin 11 active_low=true dt_flags=17
index 7: gpio@500003 pin 12 active_low=true dt_flags=17
index 8: gpio@500003 pin 13 active_low=true dt_flags=17
index 9: gpio@500003 pin 14 active_low=true dt_flags=17
index 10: gpio@500003 pin 15 active_low=true dt_flags=17
```
`total=11` across two ports (`gpio@500000`=P0, `gpio@500003`=P1), matching
the real XIAO nRF52840 pin mapping for `xiao_d 0..10`
(P0.02/P0.03/P0.28/P0.29/P0.04/P0.05/P1.11/P1.12/P1.13/P1.14/P1.15).
`active_low=true`, `dt_flags=17` (`0x11` = `GPIO_ACTIVE_LOW(1) |
GPIO_PULL_UP(0x10)`) matches `tester_xiao.overlay`'s
`GPIO_ACTIVE_LOW | GPIO_PULL_UP` on every input line.

## Bugs found and fixed

### 1. Proto/include directory name (`kscan-diagnostics` vs `kscan_diagnostics`) broke the RPC CLI tool

`proto/cormoran/kscan-diagnostics/` (hyphen) held package
`cormoran.kscan_diagnostics` (underscore) -- inconsistent with every other
module in this workspace (`animation`, `watchdog`, `devtool`, ... all use a
single word / underscore, never a hyphen). `tools/zmk-studio-rpc
custom-call`'s proto loader (`tools/zmk_studio_rpc/proto.py`,
`_guess_custom_include_dir` + `_module_name_for`) derives a Python module path
directly from the proto file's directory structure, so it tried to import
`cormoran.kscan-diagnostics.kscan_diagnostics_pb2` -- a hyphen is not a valid
Python identifier, so this always failed with `ModuleNotFoundError`. This
blocked driving the RPC calls this phase is supposed to validate, so it was
fixed as part of this phase rather than deferred:

- Renamed `proto/cormoran/kscan-diagnostics/` ->
  `proto/cormoran/kscan_diagnostics/` (`git mv`, both `.proto` and `.options`).
- Updated the two firmware `#include`s
  (`src/studio/kscan_diagnostics_handler.c`,
  `src/test/kscan_diagnostics_rpc_test.c`) from
  `<cormoran/kscan-diagnostics/kscan_diagnostics.pb.h>` to
  `<cormoran/kscan_diagnostics/kscan_diagnostics.pb.h>` (nanopb's
  `nanopb_generate_cpp(... RELPATH ...)` mirrors the proto directory
  structure into the generated include path).
- Moved the (gitignored, generated) web proto output
  `web/src/proto/cormoran/kscan-diagnostics/` ->
  `web/src/proto/cormoran/kscan_diagnostics/` and updated every import site
  (`useKscanDiagnostics.ts`, `kscanDiagnosticsTypes.ts`, `diagnosis/types.ts`,
  `diagnosis/engine.ts`, and the web test files under `web/test/`) to the new
  path, then regenerated via `npm run generate` (buf points at `../proto`
  wholesale, so it picked up the rename automatically).
- Verified: `west zmk-test tests -m .` (both native_sim suites still PASS),
  `west zmk-build tests/zmk-config -af hw_mock -q` (rebuilds clean after the
  include-path fix), `cd web && npm test` (38/38 pass) and `npm run build`
  (clean).

No behavior change to the firmware or web app -- purely a path/naming fix,
required to make the documented hardware-validation RPC CLI usable for this
module at all.

### 2. `zmk,kscan-mock`'s `events` timing model is one-event-behind (test-script pitfall, not a firmware bug)

While designing the mock event script for hardware, an initial script
(`ZMK_MOCK_PRESS(0,0,20) ZMK_MOCK_RELEASE(0,0,200) ZMK_MOCK_PRESS(0,0,30) ...`,
intending a ~30ms chatter gap) produced `GetStats` results that looked
swapped: `min_press_duration_ms` and `min_repress_gap_ms` did not match the
scripted delays at all. Root-caused via RTT logs
(`kscan_mock_schedule_next_event_0: delaying next keypress: 4000` logged
*immediately after* a press whose own scripted delay was `4000`, not the
following event's delay) plus reading
`dependencies/zmk/app/module/drivers/kscan/kscan_mock.c`'s
`kscan_mock_work_handler`: it fires `events[event_index]`, calls
`kscan_mock_schedule_next_event(dev)` **before** incrementing
`event_index`, so that call re-reads the just-fired event's own delay to arm
the timer for the *next* event. Net effect (confirmed by direct simulation
and cross-checked against real firmware output, see the overlay's header
comment for the full derivation):
- `events[0]`'s delay is consumed **twice** (once for event 0's own initial
  wait, redundantly again for the wait before event 1).
- Every other `events[i]`'s delay controls the wait before event `i+1`, not
  event `i`.
- The last event's own delay field is **never consumed** (no event follows
  it).

This is not a firmware bug -- `tests/test.dtsi`'s existing native_sim fixture
technically has the same shift, but its assertions use wide tolerant ranges
(DESIGN.md SS8's own noted jitter tolerance) that happen to still pass under
the shifted timing, which is why this was never noticed there. It only became
visible on hardware because the shift changes which numbers land in which
bucket, and the initial hardware script's margins were too tight to survive
both the shift and real boot-time scheduling jitter (~170-200ms measured
during the first ~500ms of boot, vs native_sim's ~6ms jitter budget with no
such contention).

Fixed by rewriting `diag-hw-mock.overlay`'s event script to (a) start with a
throwaway warm-up press/release pair whose double-consumed timing nobody
depends on, (b) run the real assertions from event index 2 onward where the
`events[i].delay` -> "wait before event i+1" mapping is clean 1:1, and (c)
start the real sequence at t=4s so it's clear of boot-time workqueue
contention. Documented the exact mechanism and a worked derivation in the
overlay's own header comment so a future session does not have to
rediscover it.

**Regression test added**: `src/test/kscan_mock_timing_test.c` (native_sim,
new `tests/mock-timing/` fixture + `CONFIG_ZMK_KSCAN_DIAGNOSTICS_MOCK_TIMING_TEST`
Kconfig gate) directly exercises `zmk,kscan-mock`'s scheduling -- reading
`src/stats.c`'s counters via `ksd_stats_get()`, no Studio/RPC dependency --
with an event script whose delays are chosen so that the "naive" (wrong)
interpretation and the actual (one-event-behind) interpretation predict
clearly different position-0 stats, and asserts the actual firmware behavior
matches the one-event-behind model documented above. This pins down the
mock's real semantics so future scripts (in this repo or a sibling module)
can be designed correctly the first time, and so any future upstream change
to `kscan_mock.c`'s scheduling order gets caught. Verified the test actually
discriminates (not just trivially passing) by temporarily substituting the
naive model's predicted ranges and confirming it fails.
