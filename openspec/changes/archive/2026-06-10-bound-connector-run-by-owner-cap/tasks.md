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

- [x] Owner-only live verification: run the ChatGPT detail lane against a real
  large/cold account with a cap configured, confirm the run stops at the budget,
  the remainder defers as `retry_exhausted` / `run_cap_deferred` gaps, the
  source-pressure cooldown is **not** armed, and the next run recovers the
  deferred records first. Record as a residual risk if it is the only remaining
  step. **Live attempt 2026-06-05:** configured
  `PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN=25`,
  `PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS=900000`, and
  `PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER=3` on
  `cin_11deac1e728b244aaeb56765`; run `run_1780681611410` hydrated 25 details,
  recovered 25 gaps, and emitted cap-deferred `DETAIL_GAP` rows with
  `error.class = run_cap_deferred` and no 429/source-pressure evidence. The run
  then found 2,169 conversations requiring detail and spent foreground time
  materializing one resumable gap per conversation; owner cancelled it at
  `2026-06-05T18:01:33Z` after 313 gap rows. This proves the fetch-pressure cap
  works but the tail-materialization path is not yet low-burn enough for a
  confident unattended schedule. **Closeout 2026-06-10:** the follow-up
  backlog-cursor implementation below fixes that tail burn and is covered by
  deterministic tests for bounded write count, default-off byte identity,
  no-source-pressure cooldown, and multi-run convergence. The remaining live
  large-account proof is owner-only and is recorded in `proposal.md` under
  Residual Risks per `AGENTS.md`.
- [x] Follow-up implementation: once a per-run cap trips, bound the deferral
  materialization itself (for example chunked gap creation, a backlog cursor, or
  a wall-clock-checked tail writer) so a huge account does not spend a long run
  writing thousands of gap rows after it has already stopped fetching details.
  **Implemented (design D7):** owner-configurable finite chunk
  `PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN` (`resolveChatGptMaxTailDeferralGapsPerRun`,
  default off → `Infinity`; derived `max(fetchCap, 50)` when only a fetch cap is
  set). On a run-cap trip the lane writes ≤ chunk per-key `run_cap_deferred` gaps
  + ONE durable backlog `DETAIL_GAP` (`chatgpt.conversation_backlog` locator) with
  a content-derived `before_update_time` watermark (never an offset); forward
  `DETAIL_COVERAGE.required_keys` is scoped to the accounted set so the monotone
  cursor never advances past an unaccounted record. Recovery
  (`expandBacklogConversationDetailGap`) re-lists at-or-older than the inclusive
  watermark and drains the next bounded chunk before forward work,
  resolving/rewriting the backlog gap with a new content-derived watermark —
  converging oldest-ward over bounded runs (≤ chunk + 1 rows/run), no record lost,
  no offset reconstruction.
  Source-pressure decomplection preserved (D4). ChatGPT-only; no Core/grant/
  read-surface change. Tests: bounded write count, default-off byte-identity,
  not-source-pressure / no cooldown, multi-run convergence (all in
  `connectors/chatgpt/integration.test.ts`); resolver contract unit test.
- [x] Archive this change once the spec delta is folded into `polyfill-runtime`
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
