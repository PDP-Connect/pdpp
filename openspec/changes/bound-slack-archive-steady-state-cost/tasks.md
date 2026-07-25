# Tasks

## 1. Incremental message read (run-time fix)

- [x] 1.1 Rewrite `buildMessageRowsQuery` in `connectors/slack/index.ts` to push
  the threshold predicate into the `latest` CTE (per-channel, per-channel+legacy,
  and legacy-only shapes; no-cursor keeps full aggregation). Params ordering
  preserved.
- [x] 1.2 Deterministic byte-identity test
  (`message-query-incremental.test.ts`): seeded synthetic archive with
  multi-chunk `(CHANNEL_ID, TS)` duplicates and rows above/below cursors; asserts
  the new query emits exactly the reference full-aggregate-then-filter set across
  all three threshold shapes.
- [x] 1.3 Mutation tests: past-cursor message emitted; at/below-cursor not; a new
  higher-`CHUNK_ID` chunk for a past-cursor `TS` wins the dedup.
- [x] 1.4 No-cursor/first-run test: full coverage emitted (unchanged).

## 2. Phase timing + size observability

- [x] 2.1 Phase timers in `collect()` around `ensureArchiveOnDisk`
  (`slackdump-subprocess`), `new DatabaseSync` (`archive-open`),
  `runRequestedStreams` (`read-and-emit`); reported via `progress`.
- [x] 2.2 End-of-collect archive size snapshot: `slackdump.sqlite` bytes and
  `__uploads/` presence + byte size, via `progress`.
- [x] 2.3 Test that timing/size progress lines are emitted
  (`archive-reclaim.test.ts`, end-to-end subprocess).

## 3. Opt-in `__uploads/` reclaim escape hatch

- [x] 3.1 `SLACK_RECLAIM_UPLOADS` (bool, default false) in `readSlackOptions` /
  `SlackOpts`.
- [x] 3.2 Commit-gated reclaim via a new `onDurableCommit` runtime hook (runs on
  successful runs after the runtime EOF ack, before exit); removes the
  workspace's `__uploads/` (never sqlite / `-wal` / `-shm`); reports reclaimed
  bytes. Hook added to `src/connector-runtime.ts`.
- [x] 3.3 Tests: disabled → no deletion; enabled → `__uploads/` removed, sqlite +
  sidecars intact, reclaimed-bytes reported; failed-run → residue intact (gate
  honored); direct `reclaimUploads` unit tests.

## 4. Docs

- [x] 4.1 `connectors/slack/README.md`: "Disk and run-time" section — two-problem
  reality, incremental read, phase observability, reclaim escape hatch with
  one-way / no-PDPP-copy / disables-re-download caveats.
- [x] 4.2 Documented `SLACK_RECLAIM_UPLOADS` / `SLACK_SKIP_FILES` interaction
  (steady-state disk = sqlite when files skipped).

## 5. Validation

- [x] 5.1 `openspec validate bound-slack-archive-steady-state-cost --strict`.
- [x] 5.2 Full polyfill-connectors suite green (2646 pass / 6 pre-existing skip);
  slack suite 131 pass; runtime+exit suites green.
- [x] 5.3 Biome/lint clean on touched files.
- [x] 5.4 Residual owner-only live UAT recorded in `design.md`.

## Residual (owner-only, out of scope)

- Live UAT on the real 31 GB archive: confirm run time drops and phase timing
  attributes the remainder correctly.
- One-time `SLACK_RECLAIM_UPLOADS=1` decision on the live host (accepts the
  documented byte loss).

## 6. Live-closure follow-up (2026-07-25): the above shipped, but live UAT
   surfaced three real defects in tasks 2/3 — fixed here

Live run `run_1784954046064` (2026-07-25) ran `SLACK_RECLAIM_UPLOADS=1` against
the real archive and terminated `run.failed` /
`connector_protocol_violation` ("Connector emitted PROGRESS after DONE"),
despite ingesting 322 records across all required streams. Root-caused via the
live spine events (`docker exec pdpp-postgres-1 psql`) and `pdpp-reference-1`
container logs, not assumption.

- [x] 6.1 **Protocol-violation root cause (task 3.2 defect):** `onDurableCommit`
  runs after the runtime has already consumed this run's DONE and torn down its
  message loop (per `flushAndExitAfterRuntimeAck`'s post-stdin-EOF contract).
  The shipped hook called `progress(...)` (stdout JSONL) to report the reclaim —
  which the runtime correctly rejects as "message after DONE",
  `connector_protocol_violation`, failing the run and (per 6.2) permanently
  preventing reclaim from ever succeeding. Fixed: `onDurableCommit`'s signature
  (`src/connector-runtime.ts`) now takes a stderr-only `log` function instead of
  exposing `progress`/`emit`; the Slack connector reports reclaim evidence via
  `log`, never stdout. Structural fix, not just Slack-local: `onDurableCommit`
  no longer has access to the protocol channel at all.
- [x] 6.2 **Reclaim scope defect (task 3.2 defect), first pass:** the reclaim
  plan tracked only the base/positional-channel archive path, never the scoped
  archives `reconcileMessageSourceCache` heals for previously-observed-but-now-
  missing channels. Live evidence: `archive-scoped/.../__uploads` residue
  (19MB + 766MB) survived while the main archive's `__uploads/` was already
  gone. Fixed: `reclaimPlan` lists the base archive plus every `scopedArchives`
  entry the run reconciled. **Superseded/completed by task 7.1** — this first
  pass still missed a successful-but-empty repair attempt (see below).
- [x] 6.3 **Reconciliation timing instrumentation:** the live run showed a
  ~58-minute "scoped slackdump resume" phase between `slackdump-subprocess`
  (172647ms) and `read-and-emit` (35711ms) that neither reported timing existed
  for. Wrapped in `timedPhase(progress, "scoped-archive-reconcile", ...)`.
  **This measures elapsed time only — see task 7.2 for the actual finite bound
  added on independent review.**
- [x] 6.4 Mutation-grade tests added to `archive-reclaim.test.ts` for the 6.2/6.3
  first pass (multi-archive reclaim; phase-timing emission) against a synthetic
  fixture reproducing the live "healed missing channel from an existing scoped
  archive" topology. Existing reclaim-evidence assertion updated to check
  stderr (not stdout) and to match the specific reclaim phrase rather than a
  bare "reclaim" substring (which false-positived against the test's own
  `pdpp-slack-reclaim-*` tmpdir prefix).
- [x] 6.5 `test-harness.ts`: settle `runConnectorProtocolSubprocess` on the
  child's `close` event instead of `exit` — `exit` can fire before stdio pipes
  finish draining their last buffered chunk, a latent race independent of this
  fix but tightened while diagnosing test timing here.

## 7. Independent-gate follow-up (2026-07-25, same day): two REVISE blockers on task 6 — fixed here

Independent review (`/tmp/pdpp-review-f9d5f28b4.md`) confirmed the protocol-safety
and ordinary multi-scoped-reclaim fixes (6.1/6.2) but found two remaining gaps.
Both fixed without broadening scope; `connector-runtime.ts` (stderr-only hook)
and `test-harness.ts` (exit→close) from 6.1/6.5 are unchanged in this pass.

- [x] 7.1 **Empty-successful-repair reclaim gap:** `repairMissingScopedArchive`
  can succeed (`ensureArchiveOnDisk` does not throw — the archive genuinely
  exists on disk, `__uploads/` and all) while `readArchiveChannelIds` finds no
  row matching the requested missing channel. The prior code returned `null`
  from `repairMissingScopedArchive` on that path, and `reclaimPlan` (built only
  from `scopedArchives`) silently excluded that archive forever. Fixed:
  `repairMissingScopedArchive` now returns `{ archivePath, selected }` —
  `archivePath` is set whenever the archive was durably created/read this run,
  independent of whether `selected` (the message-pass-relevant match) is
  non-null. `MessageSourceCacheReconciliation` carries a new
  `reclaimedRepairArchivePaths` field folded into `reclaimPlan` alongside
  `scopedArchives`, deduped via `Set`. Mutation-tested: reverting the
  `reclaimPlan` assignment to drop `reclaimedRepairArchivePaths` makes the new
  test fail with `AssertionError: empty-repair archive __uploads/ ALSO
  reclaimed, despite recovering no matching channel` — confirmed live, then
  restored.
- [x] 7.2 **Timing visibility is not a semantic bound — corrected the claim,
  then made the bound real.** `timedPhase` only measures elapsed wall time; it
  adds no deadline, page/call limit, cancellation, or backlog cap by itself.
  What actually bounds `scoped-archive-reconcile`'s work is structural, and was
  already true before this fix but not stated or observable:
  `baseMissingChannelIds` and `selectScopedArchivesForChannels`'s result are
  both computed ONCE up front from this run's already-fixed
  `priorObservedChannelIds` (a committed STATE array) and `baseChannelIds`
  (this run's own archive scan) — a plain array difference, not a query that
  can grow mid-run. The refresh loop iterates that fixed list exactly once per
  entry (no re-selection, no re-scan of Slack for more missing channels within
  the same run), and the optional single repair attempt after it runs at most
  once more. So the repair-unit count is knowable and finite **before any
  subprocess runs**, and each unit's own Slack-API-side scope is separately
  bounded by `SLACK_LOOKBACK_DAYS` (`-lookback p<N>d`, default `p7d`) — the
  actual finite bound on backlog a single `resume` call can touch, already
  existing before this closure. No arbitrary wall-clock kill was added; none
  was needed, since the existing finite work-unit/lookback semantics are
  already authoritative — they just weren't computed and reported before now.
  Fixed: `reconcileMessageSourceCache` now computes `repairUnitCount` (exact,
  via the same coverage-selection logic `selectScopedArchivesForChannels` uses
  internally, not a heuristic) and the lookback window before starting any
  subprocess, reports `selected N repair unit(s) ... lookback=p<N>d` up front,
  a `completed C/N repair unit(s)` line after each unit, and a
  `finished: C/N repair unit(s) completed, 0 remaining` line at the end.
  Mutation-tested: removing the "finished" line makes both new bound tests
  fail (confirmed live, then restored). OpenSpec claim narrowed accordingly
  (see `design.md` update): the guarantee is "the reconciliation phase's
  repair-unit count and per-unit lookback scope are computed before any
  subprocess runs and reported as a completed/remaining cursor," not "the
  58-minute wall-clock duration is bounded to a specific number" — the
  Slack-API-side duration of each already-bounded unit is inherently variable
  (rate limits, backlog size within the fixed lookback window) and out of this
  connector's control.
- [x] 7.3 Two new tests in `archive-reclaim.test.ts`:
  `SLACK_RECLAIM_UPLOADS=1 reclaims a repair archive that was successfully
  created/read but recovered no matching channel` (+ a paired
  failed-before-durable counterpart preserving the existing invariant) and
  `scoped-archive-reconcile declares 0 selected repair units and does no work
  when there is nothing to heal`, plus the existing phase-timing test extended
  with bound/cursor assertions (`selected N repair unit(s)`, `lookback=p7d`,
  `completed C/N`, `finished: C/N ... 0 remaining`) rather than elapsed-time
  assertions alone.
- [x] 7.4 Full focused suite green: `archive-reclaim.test.ts` (13 tests) +
  `slackdump-runtime.test.ts` (14 tests) = 27 pass, 0 fail. `tsc --noEmit`
  clean. `biome check` clean (no fixes applied after one formatting
  correction). Scope confirmed unchanged outside
  `connectors/slack/{index.ts,archive-reclaim.test.ts}` via `git diff --stat`.

### Still not reproduced locally

The 58-minute wall-clock duration itself (as opposed to the now-computed,
now-reported finite repair-unit/lookback bound that produces it) depends on
live Slack API rate limits and real backlog size within each unit's `p7d`
window; not something a synthetic test can assert a specific millisecond
figure for. Owner UAT (below) is the only way to observe the real number, and
the claim this closure makes is deliberately scoped to the bound, not that
number.
