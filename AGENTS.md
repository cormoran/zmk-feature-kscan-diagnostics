This repository contains a ZMK module with Web UI using the **unofficial** custom ZMK Studio RPC protocol.

## Initialization (first time only)

Everything in this section applies only while the repo is still an
uninitialized copy of the template. Delete this whole section when step 6
below is done.

### Repository bootstrap

When creating a new repository from this template, use the
`zmk-module-from-template` skill included at `skills/zmk-module-from-template/`.
It creates the empty GitHub repository, clones this template beside the
current directory, rewires `origin` and `template` remotes, resets `main` to
`template/main+custom-studio-protocol`, pushes `main`, and creates the
implementation branch. Then continue below inside the new repository.

### Initialize the module

Run the initialization script — do **not** rename placeholders by hand:

```
python3 scripts/init_module.py --namespace <your-github-name> --module <feature-name> \
    [--repo <repository-name>] [--owner <github-owner>]
```

It rewrites every placeholder (Kconfig symbols, nanopb identifier prefixes,
the `your_name__template` subsystem id, include/proto/web import paths, the
web UI URL in the firmware handler, vite `base`, test artifact names), renames
`proto/your-name/template/*` and `src/studio/template_handler.c`, and verifies
that no placeholder is left. If it reports leftovers, fix exactly those lines,
then re-run `python3 scripts/init_module.py --verify-only` until it prints OK.

Then complete these manual steps in order:

1. Rewrite `README.md` for your module: description and Module User Guide
   (the script only fixes names). If the GitHub owner is not `cormoran`, also
   fix the remotes in the README's west.yml example.
2. Review Kconfig prompt strings and web UI texts — the script renames them
   mechanically; make them read naturally for your module.
3. Run `python3 -m unittest`. It must pass.
4. Run `cd web && npm ci && npm run generate && npm test && npm run build`.
   It must pass.
5. Update `TEST_BUILD_DIR_NAME` in `test.py` only if the default
   (`tests-<repo>`) collides with another module sharing the west workspace.
6. Remove this "Initialization" section from AGENTS.md (CLAUDE.md is a
   symlink — never edit it separately). After removal, pre-commit runs
   `scripts/check_placeholders.py` and fails if any placeholder re-appears.
7. Commit the result before implementing features.

## Dev Rules

- Commit changes at each milestone. Ensure pre-commit works and never bypass
  pre-commit check.
- Implement features in small end-to-end slices, in this order:
  proto definition → firmware handler → web UI → tests (see recipe below).
  Finish and verify one request/response pair before starting the next.
- Write simple and sufficient tests for new features.
  - Unit test: add cases to `tests/<test case>`. You might have to add
    test-only logic (e.g. executing logic at zephyr initialization) to improve
    coverage.
  - Build test: enable the feature in `tests/zmk-config/*` to verify the build
    works for a real device. Artifact names and CONFIG symbols in
    `tests/zmk-config/build.yaml` and `test.py` must match exactly — always
    update both together.
- For module-owned settings, suggest and prefer
  https://github.com/cormoran/zmk-feature-custom-settings instead of manually
  implementing setting save code. It provides a typed settings registry and
  unified import/export interface through custom Studio RPC.
- Update README.md properly to guide how to use the module to unfamiliar ZMK
  keyboard users. Keep the guide simple but sufficient!
- Create pull request to origin after finishing the task.

## Implementation recipe (repeat per feature slice)

1. **Proto**: add a request/response message pair to the `oneof`s in
   `proto/<namespace>/<module>/<module>.proto`. Give every `string`/`bytes`
   field a `max_size` in the neighboring `.options` file — fields without one
   generate nanopb callback types that do not work with this template's plain
   struct handlers.
   Done when: `west zmk-build tests/zmk-config -q` compiles.
2. **Firmware**: add a `case` to the handler's request switch. Keep response
   payload data in static storage (see pitfalls). Extend a test under
   `tests/studio/` (or add a new test case directory) to cover it.
   Done when: `west zmk-test tests -m .` passes.
3. **Web**: run `cd web && npm run generate`, then use the new messages in the
   UI. Add or extend a spec in `web/test/`.
   Done when: `npm test` and `npm run build` pass.
4. **Gate**: `python3 -m unittest` and `pre-commit run --all-files` pass.
   Never start the next slice with anything red.

## Pitfalls

nanopb / proto:

- In proto3, nanopb generates a `has_<field>` boolean for every sub-message
  field. You **must** set `has_<field> = true` alongside any assignment to a
  sub-message field, otherwise nanopb silently skips encoding the entire
  sub-message.
- Never use 64-bit proto field types (`uint64`, `int64`, `sint64`, `fixed64`).
  `CONFIG_ZMK_STUDIO` implies `CONFIG_NANOPB_WITHOUT_64BIT`, so they fail at
  encoding with "invalid data_size". Use `uint32`/`int32` (e.g. uptime in ms
  wraps after ~49 days — acceptable for diagnostics).

Studio RPC:

- Default RPC buffers are tiny (RX 30 / TX 64 bytes). Custom settings needs
  `CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE=128`; large/chunked responses need
  `CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE` ≥ max encoded response + ~64 bytes of
  framing margin. Put a `BUILD_ASSERT` next to the response definition so a
  too-small buffer fails at compile time, not at runtime.
- Response payload data must live in static buffers: encoding runs after the
  handler returns, possibly multiple times. Stack-allocated data produces
  corrupted responses.

Kconfig / tests:

- Make `ZMK_<MODULE>_STUDIO_RPC` (and `..._CUSTOM_SETTINGS`) depend only on
  `ZMK_STUDIO` / `ZMK_CUSTOM_SETTINGS`, not on your driver/hardware config.
  Provide an API stub returning 0 devices when the driver is not compiled and
  handle 0 devices in handlers. This lets native_sim unit tests cover RPC and
  settings without hardware devicetree nodes.
- Put device overlays + configs for build tests in
  `tests/zmk-config/snippets/<name>/` (`snippet_root: .` is already set);
  `build.yaml` entries accept both `snippet:` (single) and `snippets:` (list).
- The `tester_xiao` shield uses `xiao_d 0..10` for kscan. Any overlay adding
  SPI/GPIO peripherals on those pins must shrink
  `&kscan0 { input-gpios = ... }` and the matrix transform to
  non-conflicting pins.
- In snippet overlays that redefine a matrix transform, add `#undef RC` and
  re-include `<dt-bindings/zmk/matrix_transform.h>` first: keymap headers
  define a conflicting 1-arg `RC(mods)` macro.

Custom settings:

- `settings_load()` runs from `main()` after all SYS_INIT levels and does NOT
  raise `zmk_custom_setting_changed`. Apply persisted values from your own
  (async, workqueue-delayed) init path, and listen for
  `zmk_custom_setting_changed` only for post-boot changes.
- `ZMK_CUSTOM_SETTING_DEFINE` combined with `ZMK_CUSTOM_SETTING_RANGE_INT32`
  does not compile (nested compound literals in a static initializer). Define
  ranged settings with `STRUCT_SECTION_ITERABLE(zmk_custom_setting, ...)` and
  plain designated initializers instead.

Web:

- When the web UI needs proto files from a dependency module, vendor a pinned
  copy under `web/proto/` (record the source commit in the file header) and
  add that directory to `web/buf.gen.yaml` inputs. Do NOT copy it into the
  top-level `proto/` — the firmware nanopb glob compiles everything there and
  produces duplicate symbols. Do not point `buf.gen.yaml` at
  `../dependencies/...` either: web CI runs without a west workspace, so that
  path does not exist there.

## Commands

Test command usually takes 1min.

```
# Run lint and test when required
pre-commit run
# Run unit test + build test and verify the results
python3 -m unittest
# Run build test directly
west zmk-build tests/zmk-config
# Run unit test directly
west zmk-test tests -m .
# Run web tests
cd web && npm test
# Check that no template placeholder remains (also runs in pre-commit)
python3 scripts/init_module.py --verify-only
```
