# Tasks — bound-connector-run-by-owner-cap

The bounded-run cap itself landed on `workstream/ri-chatgpt-bounded-run-cap-v1`
in commit `65b98f82` (`feat(chatgpt): bound each run by max detail fetches /
wall-clock`). This change is the OpenSpec record that non-trivial connector
behavior was owed, plus the display-copy honesty fix it implied. The §1 spec
lane and the §3 copy fix are this lane's deliverables; §2 documents the already-
landed implementation; §4 is owner closeout.

## 1. Spec delta (this lane)

- [x] Add the `polyfill-runtime` requirement for the owner-configured bounded-run
  cap (default-off, run-scoped shared budget, finite cap deferral as a resumable
  `DETAIL_GAP`, wall-clock bounded by one in-flight fetch).
- [x] Add the `polyfill-runtime` requirement that a run-cap deferral is **not**
  source pressure (resumable reason outside the source-pressure set; no cooldown
  armed; excluded from the source-pressure backlog rollup; distinct error class;
  no HTTP failure status).
- [x] Add the `polyfill-runtime` requirement that run-cap and generic
  retry-exhausted copy are distinct and honest (neither implies a busy service).
- [x] Confirm no overlap with `surface-source-pressure-detail-gap-backlog` (that
  rollup is reason-scoped to source pressure and therefore excludes a cap
  deferral by construction — this change makes that exclusion normative).
- [x] `openspec validate bound-connector-run-by-owner-cap --strict`.
- [x] `openspec validate --all --strict`.
- [x] `git diff --check`.

## 2. Implementation (landed in `65b98f82` — recorded here, not re-done)

- [x] `resolveChatGptMaxDetailFetchesPerRun` / `resolveChatGptMaxRunWallClockMs`
  env resolvers (`PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN` /
  `PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS`), default off (disable sentinel →
  `Infinity`).
- [x] `ChatGptRunBudget` — pure, injectable-clock, run-scoped; lazy wall-clock
  anchor; created once in `collect()` and threaded via `StreamDeps.runBudget`
  through the recovery pass and the forward pass.
- [x] `makeRunCapDeferredConversationDetailGap` — defers as `reason:
  retry_exhausted` (outside `SOURCE_PRESSURE_GAP_REASONS`) with
  `error.class: run_cap_deferred` and no HTTP status; cap checked between fetches;
  fetch count incremented only after a successful hydration; trip announced once.
- [x] Cursor commits the hydrated prefix; deferred keys land in
  `DETAIL_COVERAGE.gap_keys`; recovery (`gap.stream === "messages"`, not
  reason-filtered) re-hydrates the deferred records first next run.
- [x] Tests: env resolvers, budget unit, fetch-count cap, wall-clock cap (injected
  clock), default-off, shared recovery+forward budget
  (`connectors/chatgpt/integration.test.ts`).

## 3. Display copy honesty fix (this lane)

- [x] In `reference-implementation/runtime/display-messages.ts`, make
  `retry_exhausted` (generic wire reason) and `run_cap_deferred` (configured
  run-cap error class) **distinct** strings; keep the generic reason generic and
  the class specific to a per-run budget; neither implies a busy service.
- [x] Keep the registry completeness test green
  (`test/display-messages.test.js`): `retry_exhausted` is the scanned `reason:`
  literal and stays registered; `run_cap_deferred` is an `error.class` (not
  scanned) but stays registered so a surface looking it up gets specific copy.

## 4. Owner closeout

- [ ] Owner-only live verification: run the ChatGPT detail lane against a real
  large/cold account with a cap configured, confirm the run stops at the budget,
  the remainder defers as `retry_exhausted` / `run_cap_deferred` gaps, the
  source-pressure cooldown is **not** armed, and the next run recovers the
  deferred records first. Record as a residual risk if it is the only remaining
  step. (No live ChatGPT run has been performed; all evidence to date is from
  fixtures/mocks and the existing connector contract.)
- [ ] Archive this change once the spec delta is folded into `polyfill-runtime`
  and the owner-only live verification is recorded.

## Acceptance checks

Reproducible from the worktree (`node_modules` symlinked from the main checkout):

```sh
# ChatGPT connector incl. the 7 cap tests
node --test --import tsx \
  packages/polyfill-connectors/connectors/chatgpt/integration.test.ts \
  packages/polyfill-connectors/connectors/chatgpt/cursor.test.ts \
  packages/polyfill-connectors/connectors/chatgpt/parsers.test.ts

# display-messages registry (run-cap copy distinct + completeness)
node --test --import tsx reference-implementation/test/display-messages.test.js

openspec validate bound-connector-run-by-owner-cap --strict
git diff --check
```
