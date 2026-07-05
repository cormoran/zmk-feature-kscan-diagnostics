# DESIGN: zmk-feature-kscan-diagnostics

Diagnose keyscan (kscan) hardware problems of a ZMK keyboard from a web page:
broken/unstable wires, bad solder joints on key sockets/switches, switch
chatter, and "none of the above → probably software config". The firmware
module collects kscan **topology** and **per-key event statistics** and exposes
them over the custom ZMK Studio RPC protocol; all fault-estimation logic lives
in the **web UI**, which renders the physical key layout (official Studio
protocol), overlays the electrical wiring, and visualizes key presses live.

This document is the source of truth for the implementation phases. Keep it
updated when a phase deviates from the plan.

## 1. Scope

- **Feature module** (no new kscan driver, no DT bindings of its own, no
  shields). It observes the kscan devices that are already in the user's build.
- Supports **all official ZMK kscan implementations** at compile time:
  `zmk,kscan-gpio-matrix`, `zmk,kscan-gpio-direct`, `zmk,kscan-gpio-charlieplex`,
  `zmk,kscan-gpio-demux`, `zmk,kscan-mock`, plus the wrappers
  `zmk,kscan-composite` (resolved into its children with row/col offsets) and
  `zmk,kscan-sideband-behaviors` (unwrapped to its inner kscan).
- Live key-event streaming is **NOT implemented here**. The web UI consumes
  [zmk-feature-input-stream](https://github.com/cormoran/zmk-feature-input-stream)
  (subsystem identifier `zmk__input_stream`) when the firmware includes it.
  This module only adds what input-stream does not have: topology and
  accurate-time statistics (see §3.1 for why both are needed).
- Out of scope for v1 (backlog, §9): active GPIO self-test (driving lines while
  the kscan driver runs is unsafe), raw pre-debounce scan visibility (needs a
  kscan wrapper driver), wiring info for split-peripheral halves, upstream
  input-stream improvements (timestamp + sequence number).

### Known limitations (documented in README, surfaced in web UI)

1. **Post-debounce visibility only.** `zmk_position_state_changed` fires after
   the driver's debounce. Chatter shorter than the debounce window is invisible;
   chatter that *is* visible (double-fire) is exactly the chatter that bothers
   the user, so this is acceptable.
2. **input-stream events carry no timestamps** and its notification queue drops
   silently when full. Live view uses browser receive time (good enough for
   visualization); all timing analysis uses this module's firmware-side
   counters, which are ground truth.
3. **Split keyboards**: position events from the peripheral half reach the
   central (with `source != LOCAL`) and are counted in stats, but GPIO/wiring
   topology is only available for the central half (the peripheral's DT is in
   the other image). Sub-5 ms chatter buckets are unreliable for peripheral
   positions (split transport jitter). The web UI labels the peripheral half
   "wiring info unavailable, timing approximate".
4. **Ghost keys on unmapped matrix cells are invisible** — `app/src/kscan.c`
   drops (row,col) pairs with no transform entry. Phantom presses on *mapped*
   positions (the usual 4th-corner ghost) are visible and diagnosed.

## 2. Architecture overview

```
firmware                                      web (React + TS, vite)
┌───────────────────────────────┐             ┌──────────────────────────────┐
│ topology.c   compile-time DT  │  custom RPC │ useKscanDiagnostics          │
│              tables (§4)      │◄───────────►│  (topology + stats fetch)    │
│ stats.c      per-position     │             │ useInputStream (live events) │
│              counters (§5)    │             │ useOfficialKeymap            │
│ studio/kscan_diagnostics_     │  official   │  (GetPhysicalLayouts/Keymap) │
│   handler.c  RPC handler (§6) │  Studio RPC │ KeyboardView (SVG overlay)   │
│ [zmk-feature-input-stream]────┼─notifs─────►│ TestWizard + DiagnosisEngine │
└───────────────────────────────┘             └──────────────────────────────┘
```

- Subsystem identifier: `cormoran__kscan_diagnostics` (27 chars < 32 limit).
- Security: `ZMK_STUDIO_RPC_HANDLER_UNSECURED`. Rationale: a broken keyboard
  may be unable to type the `&studio_unlock` combo; topology and aggregate
  counters are not sensitive. Note: input-stream is SECURED, so the *live*
  view needs an unlock — the wizard must degrade to the stats-only path and
  tell the user (or suggest `CONFIG_ZMK_STUDIO_LOCKING=n` in a diagnostics
  build).
- No firmware-initiated notifications in v1 (input-stream covers live events).

### 3.1 Division of labor (why two data paths)

| Need | Source | Why |
|---|---|---|
| Render keyboard | official Studio `keymap.GetPhysicalLayouts` / `GetKeymap` | same data zmk.studio uses; no duplication |
| Which wire/pin is each key on | this module: topology RPC | only the firmware's DT knows it |
| Live press visualization | input-stream notifications | already exists; drops/latency OK for eyes |
| Chatter timing, exact counts | this module: stats RPC | notification drops + no timestamps make web-side timing wrong; firmware counters are lossless |

## 3. Firmware: Kconfig surface

| Symbol | Type | Default | Meaning |
|---|---|---|---|
| `ZMK_KSCAN_DIAGNOSTICS` | bool | n | master switch; stats collection (depends on `ZMK`) |
| `ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC` | bool | y if `ZMK_KSCAN_DIAGNOSTICS && ZMK_STUDIO` | RPC subsystem. **Depends only on `ZMK_STUDIO`**, not on any kscan compat, so native_sim builds with zero devices (stub returns 0 devices — template rule) |
| `ZMK_KSCAN_DIAGNOSTICS_MAX_POSITIONS` | int | 128 | stats table size (≈28 B/position RAM, see §5) |
| `ZMK_STUDIO_RPC_TX_BUF_SIZE` | — | module sets **256** when RPC enabled | largest chunk ≈160 B + envelope; add `BUILD_ASSERT` on encoded max sizes |
| RX buf | — | keep template default (128) | our requests are ≤16 B |

No runtime custom settings in v1: the chatter threshold is applied **web-side**
against fixed firmware histogram buckets (§5), so nothing needs tuning on the
device. (`zmk-feature-custom-settings` stays out of the dependency set.)

## 4. Firmware: topology collection (`src/topology.c`)

All wiring data is extracted **at compile time with DT macros** — kscan driver
config structs are private, there is no runtime API. Public accessors in
`include/cormoran/kscan_diagnostics/topology.h`; everything returns data from
`static const` tables.

Per-compat `DT_FOREACH_STATUS_OKAY` builds a **leaf device table**:

| Field | Source |
|---|---|
| `const struct device *dev` | `DEVICE_DT_GET(n)` |
| node name | `DT_NODE_FULL_NAME(n)` |
| type enum | which compat matched (MATRIX/DIRECT/CHARLIEPLEX/DEMUX/MOCK) |
| rows/cols/inputs | `DT_PROP_LEN(n, row_gpios)` etc. per compat (direct: `input-gpios` **or** `input-keys` phandles; charlieplex: rows=cols=len(`gpios`); demux: inputs + 2^len(`output-gpios`) virtual cols; mock: `rows`/`columns` props) |
| debounce press/release/scan-period/poll-period | replicate each driver's own macro logic, including the deprecated `debounce-period` fallback and Kconfig fallbacks (`CONFIG_ZMK_KSCAN_DEBOUNCE_*`) — copy the `INST_DEBOUNCE_*` macros from the drivers |
| `diode_row2col`, `toggle_mode` | matrix `diode-direction` enum, direct `toggle-mode` |
| GPIO lines | per line kind (ROW/COL/INPUT/OUTPUT/CHARLIE): `DEVICE_DT_NAME(DT_GPIO_CTLR_BY_IDX(n, prop, i))`, `DT_GPIO_PIN_BY_IDX`, `DT_GPIO_FLAGS_BY_IDX` (report `GPIO_ACTIVE_LOW` bit + raw dt_flags) |

**Wrappers**: a second table for `zmk,kscan-composite` children (`kscan`
phandle → resolved at runtime by comparing `const struct device *` against the
leaf table; `row-offset`/`col-offset` kept) and `zmk,kscan-sideband-behaviors`
(maps wrapper device → inner device). Resolution function:
`topology_resolve(dev)` → list of `{leaf_index, row_offset, col_offset}`.

**Per-layout table** from `DT_FOREACH_STATUS_OKAY(zmk_physical_layout)`:
transform phandle's `rows`/`columns` props, kscan phandle device. At runtime,
match ZMK's `zmk_physical_layouts_get_list()` entries to this table by
comparing the `kscan` device pointer (fall back to index order — both arrays
come from the same DT instances). Mirror ZMK's fallback: when no
`zmk,physical-layout` node exists, ZMK synthesizes one from `chosen` nodes —
replicate that condition (see `app/src/physical_layouts.c`) or document that
Studio (required anyway) needs physical layouts.

**Position map** is computed at runtime via the public
`zmk_matrix_transform_row_column_to_position(layout->matrix_transform, r, c)`
iterating r×c of the selected layout (dims from our DT table). No private
struct access.

**Zero-device rule** (template): when no kscan compat is okay, tables are empty
and every accessor returns 0 devices/layout dims — RPC and native_sim tests
must still build and run.

## 5. Firmware: event statistics (`src/stats.c`)

`ZMK_LISTENER` on `zmk_position_state_changed` (exactly like input-stream's
listener, but always-on when `ZMK_KSCAN_DIAGNOSTICS=y`; counters are cheap).
Per position `p < min(transform len, MAX_POSITIONS)`:

```c
struct ksd_pos_stats {          /* exposed via RPC */
    uint16_t presses, releases;             /* saturating */
    uint16_t min_press_duration_ms;         /* 0xFFFF = none yet */
    uint16_t min_repress_gap_ms;            /* release→press gap, 0xFFFF = none */
    uint16_t repress_lt[4];                 /* gap < 5/10/20/50 ms bucket counts */
    uint8_t  last_source;                   /* zmk event source; UINT8_MAX=local */
};                                          /* 17 B + scratch below */
struct ksd_pos_scratch {                    /* internal */
    uint32_t last_press_ms, last_release_ms; /* truncated ev->timestamp */
};
```

≈28 B/position ⇒ 3.6 KB RAM at the default 128 positions — acceptable for a
temporarily-added diagnostics module; shrink via Kconfig for tiny MCUs.
Fixed buckets (5/10/20/50 ms) let the web pick any threshold without a
firmware setting. `reset` RPC zeroes everything. Guard concurrent access with
a spinlock or by running entirely on the event thread (listener) + reading
snapshot in RPC handler with lock held (copy per-chunk, 2 entries — cheap;
see §6 for why the page shrank from the originally-planned 3 to 2).

## 6. RPC protocol (`proto/cormoran/kscan_diagnostics/kscan_diagnostics.proto`)

`package cormoran.kscan_diagnostics;` — one `Request`/`Response` oneof pair
(template rule). All messages small; chunked where unbounded. **nanopb rules:
`has_<field>=true` on every sub-message, no 64-bit types, every string/bytes
field gets a `.options` max_size.**

| Request | Response | Notes / encoded-size budget (TX=256) |
|---|---|---|
| `GetInfo{}` | `Info{proto_version=1, layout_count, selected_layout, device_count, stats_enabled, max_positions, uptime_ms}` | ~30 B |
| `GetLayout{layout_index}` | `Layout{layout_index, display_name(≤24), rows, columns, key_count, device_indices[≤4] (resolved leaf devices + their offsets: repeated LayoutDevice{leaf_index,row_offset,col_offset})}` | ~60 B |
| `GetDevice{device_index}` | `Device{device_index, node_name(≤24), type, rows, columns, inputs, debounce_press_ms, debounce_release_ms, debounce_scan_period_ms, poll_period_ms, diode_row2col, toggle_mode}` | ~70 B |
| `GetGpioPins{device_index, kind, offset}` | `GpioPins{total, offset, pins[≤4]{index, port(≤12), pin, active_low, dt_flags}}` | 4×~41 B ≈ 180 B (Phase B measured this against TX=256 and shrank the page from the originally-planned 6 to 4 to leave the required 64 B framing margin — see src/studio/kscan_diagnostics_handler.c) |
| `GetPositionMap{layout_index, offset}` | `PositionMap{total, offset, cells[≤24]}` — row-major over rows×cols, value = position+1, 0 = unmapped | ≤24×5 B ≈ 130 B |
| `GetStats{offset}` | `Stats{total, offset, entries[≤2] PositionStats{position, presses, releases, min_press_duration_ms, min_repress_gap_ms, repress_lt5/lt10/lt20/lt50, last_source}}` | 2×~62 B ≈ 140 B (largest response → sizes the TX assert; **Phase C measured this against TX=256 and shrank the page from the originally-planned 3 to 2** — each PositionStats has 10 uint32 fields, ~3x GpioPin's field count, so 3 entries (~202 B) would have overflowed the 64 B framing margin — see src/studio/kscan_diagnostics_handler.c) |
| `ResetStats{}` | `Ok{}` | |
| (any decode/range error) | `Error{message ≤48}` | |

`enum KscanDriverType { UNKNOWN=0; MATRIX=1; DIRECT=2; CHARLIEPLEX=3; DEMUX=4; MOCK=5; }`
`enum GpioLineKind { KIND_UNKNOWN=0; ROW=1; COL=2; INPUT=3; OUTPUT=4; CHARLIE=5; }`

Handler: `src/studio/kscan_diagnostics_handler.c`, standard template shape
(see input-stream's handler for the decode/dispatch skeleton). Responses use
the shared static response buffer; chunk state must live in the static
response (encoding may run twice — template rule). Add
`BUILD_ASSERT(<max encoded Response> + 64 <= CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE)`
using the nanopb generated `_size` constants.

## 7. Web UI (`web/`)

Data hooks (all in `web/src/`):
- `useOfficialKeymap` — official Studio protocol via the connection from
  `useZMKApp()` (`@zmkfirmware/zmk-studio-ts-client`, cormoran fork already in
  the template): `keymap.getPhysicalLayouts` (key x/y/w/h/r for rendering) and
  `keymap.getKeymap` (bindings, for the software-level hints).
- `useKscanDiagnostics` — `findSubsystem("cormoran__kscan_diagnostics")` +
  `ZMKCustomSubsystem.callRPC`; sequences Info → Layout(s) → Device(s) →
  GpioPins(chunks) → PositionMap(chunks) into one `Topology` object; `getStats`
  (chunked) and `resetStats`.
- `useInputStream` — feature-detect `findSubsystem("zmk__input_stream")`;
  enable stream; collect `KeyEventNotification{position, pressed, behavior_id,
  param1, param2}` with `receivedAt = performance.now()`. Generate its ts-proto
  types by pointing `web/buf.gen.yaml` at input-stream's proto **as an
  additional input** (template rule: never vendor-copy protos). If pulling that
  repo in is awkward, vendoring under `web/proto-external/` with a sync note is
  the fallback — decide in Phase D, prefer buf pointing at a git input.

Screens (single-page, sections):
1. **Connect bar** — template standard (WebSerial), lock-state banner.
2. **Keyboard view** — SVG from physical layout; per-key fill by state
   (untested / ok / pressed-now / suspect / dead / unmapped-half); hover shows
   (row,col), GPIO port+pin of its row & col lines, debounce config; "wiring
   mode" toggle draws row/col groupings as colored outlines so a whole broken
   line is visually obvious.
3. **Test wizard** (state machine, the main flow):
   - *coverage*: asks the user to press every key once (order-free); live
     events (or stats-diff polling when input-stream is absent/locked: poll
     `GetStats` at ~2 Hz and diff press counts) mark keys ok.
   - *retest*: for keys not seen, targeted "press key X 5 times"; stats diff
     confirms dead vs intermittent.
   - *chatter*: fetch stats; flag positions with `repress_lt*` counts > 0 (web
     threshold slider picks which bucket matters).
   - *report*: DiagnosisEngine output with concrete actions.
4. **Stats table** — raw per-position counters, reset button, CSV export.

**DiagnosisEngine** (`web/src/diagnosis/*.ts`, pure functions, jest-tested):
input `{topology, coverage, statsBefore/After, eventLog}` → findings ranked:
- ≥2 dead keys all sharing row R (and their columns proven alive elsewhere) →
  `ROW_FAULT(R)` → "check wire/solder on GPIO <port> <pin>"; same for columns.
- isolated dead key with proven-alive row+col → `KEY_FAULT` → "reflow socket /
  swap switch at <key>".
- `repress_lt*` > 0 → `CHATTER` → "replace switch or raise debounce-press-ms
  (currently <n> ms from topology)".
- event at a position the wizard did not request while 3 rectangle-corners
  held → `GHOST` → "check diode at <key>" (only when topology says matrix).
- intermittent line (coverage pass-rate clustered on one row/col across
  retests) → `UNSTABLE_LINE` → "wiggle-test the wire on <port> <pin>".
- keys OK at position level but user reports missing characters → point at
  keymap/behavior (show binding from input-stream event / GetKeymap) →
  `SOFTWARE_SUSPECT`.
Rules must cite which evidence fired; confidence = simple tiers (high/med/low).

## 8. Testing

- **native_sim** (`tests/`, `west zmk-test tests -m .`):
  - zero-device build: RPC handler + stats compile, Info returns 0 devices.
  - mock build: `zmk,kscan-mock` + matrix transform + physical layout in the
    test overlay; scripted mock events drive real `position_state_changed` →
    assert stats counters (incl. a scripted fast re-press) and PositionMap
    correctness through the RPC handler called directly. **Phase C pitfall**:
    `tests/studio/`'s board (`native_sim//zmk_test_mock`) sets `exit-after` on
    the mock kscan device, which calls `exit(0)` shortly after the scripted
    event list is exhausted; a stats test that needs to `k_sleep()` past the
    last scripted event to assert via RPC races that auto-exit (and
    `run-test.sh` has no timeout of its own, so simply deleting `exit-after`
    without replacing it hangs the harness forever). Fix used here:
    `tests/test.dtsi` deletes `exit-after` and the test itself calls `exit()`
    once done (see `src/test/kscan_diagnostics_rpc_test.c`, same pattern as
    `zmk-feature-watchdog`'s `watchdog_test.c`). Also,
    `CONFIG_NATIVE_SIM_SLOWDOWN_TO_REAL_TIME=y` makes this a real
    wall-clock-timed simulation (several ms of jitter per event hop observed
    in practice), so timing assertions use tolerant ranges / the widest
    chatter bucket (`<50ms`) rather than exact milliseconds or a narrow
    bucket.
- **Build tests** (`tests/zmk-config/build.yaml`, snippets under
  `tests/zmk-config/snippets/` — template snippet rule; assert in `test.py`):
  - `xiao_ble//zmk` + `tester_xiao` (direct kscan) + RPC on — baseline.
  - snippet `diag-matrix`: matrix kscan node (remember the `RC()` macro clash
    pitfall: `#undef RC` + re-include `matrix_transform.h` in overlays that
    redefine a transform; keep pins within tester_xiao's `xiao_d 0..10`,
    shrinking `&kscan0` if needed).
  - snippet `diag-composite`: composite wrapping direct+matrix with offsets.
  - snippet `diag-charlieplex-demux`: one build compiling both remaining
    compats (instances may coexist; layout selects one).
- **Web**: jest for DiagnosisEngine (table-driven fixtures per §7 rule) and
  hook/component tests via `createConnectedMockZMKApp({subsystems:
  ["cormoran__kscan_diagnostics", "zmk__input_stream"]})`.
- **Hardware** (this PC's rig — see `skills/develop-zmk-module/references/hardware-rig.md`
  in the workspace; XIAO nRF52840 + J-Link, **no physical switches attached**):
  - flash the **mock-kscan** build (scripted events incl. chatter-like bursts):
    validates the full chain Info/Device(type=MOCK)/PositionMap/Stats over real
    USB RPC via `PYTHONPATH=tools tools/zmk-studio-rpc --transport pyusb ...`
    from the workspace root.
  - flash the direct-kscan tester build: validates GpioPins lists real
    `xiao_d` pins. If a pin can be safely jumpered to GND in the rig, one real
    keypress validates stats end-to-end (optional).
  - Rig pitfalls that WILL bite: `CONFIG_FLASH_LOAD_OFFSET=0x0` overlay
    required (stale bootloader region), never `erase`, RTT via `JLinkExe`
    `savebin` (not RTTLogger), zero RTT control block before reset,
    `-DCONFIG_LOG_PROCESS_THREAD_STARTUP_DELAY_MS=0`.

## 9. Phase plan (subagent handoff)

Phase A (template init) is **done** by the setup agent. Each phase: read this
file + `skills/zmk-module-dev/SKILL.md` first; work inside the nix devshell
(`nix --extra-experimental-features 'nix-command flakes' develop
../nix --command bash -lc '<cmd>'` from the repo, west already initialized);
run `python3 -m unittest` (+ web commands for web phases); commit at
milestones on `codex/init-kscan-diagnostics` (or a stacked branch); **no push,
no PR** unless asked. pre-commit: `SKIP=prettier,eslint,jest,web-build
pre-commit run --all-files` + run the npm checks directly.

- **B — proto + topology + RPC** (§4, §6 minus stats): proto/.options, Kconfig,
  topology tables, handler with Info/Layout/Device/GpioPins/PositionMap,
  zero-device native_sim test, mock-kscan native_sim test for PositionMap,
  build-test snippets (matrix/composite/charlieplex+demux). Biggest phase;
  the DT macro tables are the hard part — keep per-compat code in separate
  `#if DT_HAS_COMPAT_STATUS_OKAY(...)` blocks.
- **C — stats** (§5) — **done**: listener, counters, GetStats/ResetStats,
  native_sim test with scripted mock events incl. fast re-press bucket
  assertion. Deviations: Stats page shrank to 2 entries (not 3, see §6);
  see §8 for the `exit-after`/native_sim-timing pitfalls hit along the way.
- **D — web UI** (§7) — **done**: `useKscanDiagnostics`/`useOfficialKeymap`/
  `useInputStream` hooks, `KeyboardView` (SVG-like absolute-positioned
  keycap grid, rotation-aware, wiring-mode border overlay), `TestWizard`
  (coverage → retest → chatter → report state machine), `DiagnosisEngine`
  (`web/src/diagnosis/engine.ts`, all six §7 rules, jest-fixtured in
  `web/test/diagnosis/`), `StatsTable` with CSV export, wired into `App.tsx`.
  Deviations:
  - **input-stream proto**: vendored a pinned copy under
    `web/proto-external/zmk/input_stream/` (commit noted in the file header)
    as a second `buf.gen.yaml` input, rather than pointing at a sibling
    checkout path — keeps `npm run generate` reproducible when the sibling
    module repo isn't cloned next to this one (web CI has no west
    workspace).
  - **`GpioPin` has no `kind` field** (only `GetGpioPins`' request has a
    `kind` filter), so `useKscanDiagnostics` fetches GPIO lines once per
    kind (ROW/COL/INPUT/OUTPUT/CHARLIE) instead of one unfiltered page, and
    `KscanDevice.gpioLinesByKind` keeps them separated for
    `resolveRowColLines`.
  - **Pre-existing web build break fixed**: ts-proto's default `export enum`
    output for this module's new `KscanDriverType`/`GpioLineKind` enums
    trips `tsconfig.app.json`'s `erasableSyntaxOnly` (TS1294). Added
    `buf.gen.yaml`'s `enumsAsLiterals=true`, the same fix already used by
    `zmk-feature-watchdog`'s `IncidentType` enum. This broke `npm run build`
    at the start of Phase D (before any Phase D code was added) and was
    fixed as a minimal, in-scope correction.
  - **GHOST rule** only fires when the wizard is given an explicit
    `requestedPositions` set (so it can tell "unexpected" presses apart);
    `TestWizard` always supplies one (`positionsUnderTest`), but a
    DiagnosisEngine caller that omits it silently skips GHOST rather than
    erroring — documented as a deliberate "opt-in" design in
    `diagnosis/types.ts`, not a bug.
- **E — hardware validation** (§8): mock build + direct build on the rig,
  record actual RPC transcripts into `docs/validation.md`.
- **F — docs + PR**: README user guide (how to add the module + west.yml
  example, how to run a diagnosis session), then PR to origin.

Backlog (separate issues, not v1): input-stream upstream PR adding
`timestamp_ms` + `seq` to `KeyEventNotification`; kscan wrapper driver for
pre-debounce raw scan streaming; active GPIO line self-test; peripheral-half
topology via split RPC.

## 10. Design decisions record

- **UNSECURED subsystem** — a broken keyboard can't necessarily unlock Studio
  (§2). Aggregate counters only; no keylogging surface beyond what input-stream
  (SECURED) already gates.
- **No custom settings dependency** — fixed histogram buckets moved the only
  tunable (chatter threshold) to the web (§5). Cuts scope and RAM.
- **Stats in firmware, diagnosis in web** — notification loss + missing
  timestamps make web-only timing wrong (§3.1); conversely fault rules will
  iterate fast in TS with jest fixtures, so they don't belong in firmware.
- **Compile-time DT tables** — no runtime API exists for kscan wiring; private
  driver structs must not be poked. Cost: per-compat macro code (§4).
- **Chunked polling RPCs, no notifications** — topology is static, stats are
  poll-friendly, and input-stream already owns the live event channel.
