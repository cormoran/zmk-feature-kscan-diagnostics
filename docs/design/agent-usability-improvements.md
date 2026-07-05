# Design: agent-friendly template usability improvements

Status: P0 items implemented in this PR; P1/P2 items proposed.
Date: 2026-07-05

## 1. Goal

This template exists so that a ZMK user can direct a coding agent to build a
web-enabled ZMK module (custom Studio RPC + web UI) easily and reliably. The
target user is not necessarily a firmware expert, and the agent is not
necessarily a frontier model: the design must hold up when the work is done by
a mid-tier model (Sonnet class) running with limited context and weaker
long-horizon discipline.

This document analyzes where the current template makes that hard, states
design principles for reliable agent-driven development, and proposes a
prioritized set of improvements.

## 2. Evidence: where users and agents stumble today

Findings from auditing this repository and the six modules already derived
from it (zmk-feature-custom-settings, -default-layer, -os-detection,
-runtime-combo, -runtime-macro, zmk-driver-pmw3610-with-custom-studio-rpc):

1. **Initialization was ~75 hand edits with no verification.** Placeholders
   (`your-name`, `your_name`, `template`, `ZMK_TEMPLATE_FEATURE`,
   `module_template_board`, ...) appear across C, proto, `.options`,
   TypeScript, Kconfig, CMake, YAML, and Python. Nothing checked the result;
   a missed spot surfaced later as a confusing build or runtime failure.
2. **Two required edits were not even in the checklist.** The firmware
   handler hardcodes `http://cormoran.github.io/zmk-module-template/` as the
   subsystem UI URL, and `web/vite.config.ts` falls back to
   `"/repo-name/"` — forgetting either fails silently (wrong UI URL served to
   users; local web build 404s assets while CI, which sets `VITE_BASE`,
   stays green).
3. **Consistency traps.** `tests/zmk-config/build.yaml` artifact names,
   `test.py` expectations, and Kconfig symbol names must agree exactly.
   Half of the derived repos skipped the `TEST_BUILD_DIR_NAME` update.
4. **Critical knowledge lived outside the repository.** Pitfalls that every
   derived module hit in practice (RPC RX/TX buffer sizes, static response
   buffer lifetime, the zero-device/native_sim Kconfig pattern, settings boot
   ordering, `RANGE_INT32` not compiling, `RC()` macro clash, tester_xiao pin
   conflicts) were documented only in the author's private workspace skill,
   not in AGENTS.md. A fresh agent in a fresh clone could not know them.
5. **Web CI cannot see west dependencies.** zmk-driver-pmw3610 had to learn
   the hard way that `web/buf.gen.yaml` cannot reference
   `../dependencies/<module>/proto` in CI (no west workspace there) and that
   vendoring into the top-level `proto/` breaks the firmware nanopb glob.
   The working pattern (vendor a pinned copy under `web/proto/`) was
   discovered per-repo and never fed back into the template.
6. **CI never validates the path users actually take.** All workflows test
   the pristine template; none test "bootstrap → initialize → tests pass",
   which is the sequence every real user runs exactly once — with no retry
   experience.

## 3. Design principles for weak-model reliability

The difference between a frontier model and a mid-tier model is mostly not
knowledge — it is consistency over long mechanical sequences and recovery
from underspecified situations. The template can compensate structurally:

1. **Scripts over instructions.** Any step that is deterministic
   (renaming, verification, scaffolding) must be a script the agent runs,
   not a prose checklist the agent interprets. A 75-edit rename is a
   guaranteed failure mode for a weak model; a one-command script with a
   built-in verifier is a guaranteed success.
2. **Machine-checkable "done".** Every phase ends with a command whose
   output decides pass/fail (`--verify-only`, `python3 -m unittest`,
   `npm test`). "Read the diff and confirm it looks right" is not a gate.
3. **Guardrails that fail loudly and say the fix.** pre-commit hooks and
   compile-time asserts catch drift the moment it happens, with an error
   message that names the file/line and the command that repairs it. A weak
   model recovers well from a specific error; it recovers badly from silent
   corruption discovered three phases later.
4. **All needed knowledge in-repo, loaded when it is needed.**
   Pitfalls belong in the repository, phrased as short imperative rules
   ("never X, do Y instead"), not as war stories — knowledge in an external
   workspace does not exist for an agent cloning the repo. But AGENTS.md
   itself stays short: it is always in context, so it carries only the core
   rules plus mandatory pointers, while task-specific detail lives in skills
   (`skills/zmk-module-dev/`) read at the moment they apply. This both saves
   context for weak models and keeps the rules adjacent to the task.
5. **Small end-to-end slices with a fixed order.** "proto → firmware → web →
   tests, one request/response pair at a time, never proceed on red" bounds
   the blast radius of any single mistake and keeps the working set small
   enough for limited context windows.
6. **One source of truth per fact.** Names derived from `--namespace`/
   `--module` in one place; artifact names asserted consistent by tests, not
   by discipline.

## 4. Improvements

### P0 — implemented in this PR

| # | Change | Principle |
|---|--------|-----------|
| P0-1 | `scripts/init_module.py`: one-command initialization. Rewrites all placeholder identifiers, paths, URLs (including the two previously undocumented ones: subsystem UI URL, vite `base`), renames the proto/handler files, then self-verifies and prints file:line for anything left. `--verify-only` re-checks anytime; `--dry-run` previews. | 1, 2, 6 |
| P0-2 | `scripts/check_placeholders.py` wired into pre-commit. No-op while the repo is still the pristine template (detected by the AGENTS.md Initialization section); once initialized, any surviving placeholder fails the commit with a file:line listing. | 3 |
| P0-3 | AGENTS.md kept short (init flow + core rules + commands); the detail moved to `skills/zmk-module-dev/SKILL.md`: an "Implementation recipe" giving the per-slice order with a Done-when command for each step, plus the consistency rule for `build.yaml`/`test.py`. AGENTS.md points to the skill with a read-before-coding rule. | 2, 5 |
| P0-4 | Knowledge upstreamed into `skills/zmk-module-dev/SKILL.md` Pitfalls: RPC buffer sizes + `BUILD_ASSERT` guidance, static response buffer lifetime, zero-device/native_sim Kconfig pattern, settings boot ordering, `RANGE_INT32` workaround, `RC()` clash, tester_xiao pins, snippet-based test wiring, and the `web/proto/` vendoring rule for dependency protos. | 4 |

### P1 — proposed next

**P1-1: Init-path CI job.** Add a workflow job (in `zmk-module.yml`) that, on
the template repo only, runs `scripts/init_module.py --namespace ci-check
--module sample-feature`, then `python3 -m unittest` and the web build. This
makes the one path every user takes exactly once a tested path, and turns
"template refactor broke initialization" into a red PR instead of a broken
first-user experience. (The placeholder guard makes the verify half cheap;
the firmware build is the expensive part — reuse the existing west cache.)

**P1-2: Relax `.claude/hooks/restrict_gh.py` to allow read-only `gh`.**
Dev Rules ask agents to create a PR and fix CI failures, but the hook blocks
everything except `gh pr create` — including `gh pr checks`, `gh run view`,
`gh api` GETs. Allowlist read-only subcommands (`pr view/checks/list`,
`run view/watch/list`, `issue view`, GET-only `gh api`) so an agent can
actually monitor CI without a human relaying results.

**P1-3: Web proto dependency helper.** Encode the `web/proto/` vendoring
pattern as a script (`scripts/vendor_web_proto.py <module> <path>`), which
copies from `dependencies/<module>/proto`, stamps the source commit into the
header, and registers the directory in `buf.gen.yaml` inputs. Re-running it
refreshes the pin. This replaces the per-repo rediscovery that pmw3610 went
through.

**P1-4: Single source for repo-derived names.** `vite.config.ts` can default
`base` from `package.json`'s `name` (set by init to the repo name), removing
the last silently-wrong fallback. Similarly the subsystem UI URL could move
to a Kconfig string with the URL as default, so the handler file no longer
embeds a deploy-specific constant.

### P2 — later / opportunistic

- **Worked-example doc**: an annotated "adding a second RPC" diff
  (proto + `.options` + handler case + web call + tests) that a weak model
  can pattern-match against, instead of generalizing from the single sample.
- **Troubleshooting table**: map the common failure signatures to fixes
  ("invalid data_size" → 64-bit proto field; empty sub-message → missing
  `has_<field>`; encode fail on long string → `.options` max_size; web asset
  404 → `VITE_BASE`). Error-driven lookup is the recovery mode weak models
  are best at.
- **nanopb sizing guidance**: rule of thumb for choosing `max_size` and its
  interaction with `ZMK_STUDIO_RPC_TX_BUF_SIZE`, plus a `BUILD_ASSERT`
  example in the sample handler itself.
- **Proto version/capability field** in the sample protocol so firmware and
  web UI mismatches are detectable at connect time.
- **Devcontainer**: run `npm ci` in `web/` during init.sh so the web
  toolchain works immediately.
- **Template-sync guidance**: document that `template-sync.yml` PRs against
  an initialized repo will conflict on renamed files and how to resolve
  (prefer local names, take template's structural changes).
- **Publish the web libraries to npm** (`@cormoran/zmk-studio-react-hook`,
  patched ts-client) so `npm ci` does not depend on GitHub availability and
  commit-pinned github: URLs.

## 5. Compatibility and rollout

- The init script and guard are additive; the manual checklist remains valid
  as a fallback and the guard only activates after initialization, so the
  template repo's own CI and existing derived repos (which already removed
  the Initialization section **and** contain no placeholders) are unaffected.
  A derived repo that syncs this change and still has a stray placeholder
  will get a pre-commit failure with an exact location — the intended
  behavior.
- `scripts/`, `skills/`, `docs/design/`, and `template-sync.yml` are excluded
  from rewriting and scanning because they legitimately reference the
  template.
- P1-1 should land before any further template refactors; it is the
  regression net for everything else in this document.
