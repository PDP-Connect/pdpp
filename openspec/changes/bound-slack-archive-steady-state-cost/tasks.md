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

## 8. Live REVISE after deploy `aa038775d` (2026-07-25): repair-unit count
   bound (task 7.2) was correct but insufficient — a retained unit's `resume`
   still ran unbounded, forever — fixed here

Live evidence, `run_1784962644222`: run succeeded (no `connector_protocol_
violation` — task 6.1's fix held), but `scoped-archive-reconcile` still took
3,291,850ms (54m52s) with the selection message reading `selected 1 repair
unit(s) (1 existing scoped archive refresh(es) + 0 new-repair attempt(s) for
0 uncovered channel(s)), each bounded to lookback=p7d` — the task 7.2 bound
was reported accurately, and was still not enough. The single unit
(`archive-scoped/62fd13bace2a/`, ~4.9GB / ~1.95M messages / ~137k `CHANNEL`
rows) showed continuous `messages`/`channels`/`max_chunk` growth for the
entire run via the connector's own per-minute progress snapshots — genuine,
ongoing Slack-side activity, not a stalled/inaccessible channel.

- [x] 8.1 **Root cause (two compounding facts, both verified against source):**
  (a) `SLACK_MEMBER_ONLY=true` (default) permanently excludes a channel from
  the main archive's scan once no longer a member — `baseMissingChannelIds`
  for such a channel is a structural, non-resolving condition, not a
  transient blip; the scoped-archive mechanism's own history
  (`c18662d83`/`41a47885d`, "historical holes") shows it was designed for
  rare one-time backfills, not permanent per-run maintenance. (b) Verified
  against slackdump v4.4.2 source (`cmd/slackdump/internal/resume/
  resume.go:298`, `internal/chunk/backend/dbase/source.go:369-405`):
  `resume <path>`'s channel scope is always re-derived from every channel
  **already recorded in that archive's DB**, never filtered to the specific
  channel(s) the connector's `positionalChannels` targets in a `resume` call
  (only `archive` respects that arg — `buildArchiveArgs` pushes it;
  `resume`'s built args never do). So a scoped archive whose on-disk channel
  set ever drifted wider than its one intended target channel gets that
  ENTIRE recorded set re-synced on every future `resume`, cost scaling with
  accumulated archive size — the same defect class D1/task-1 fixed for the
  main archive, reintroduced here for scoped archives.
- [x] 8.2 **Fix — lifecycle/owed-work throttle (not a wall-clock timeout):**
  `resume -lookback pNd` cannot discover data older than `now - N days`
  regardless of invocation frequency, so invoking it more often than once per
  lookback period cannot recover anything a less-frequent invocation would
  miss (the backlog is caught in one call once due). Added
  `scoped_archive_resumed_at: Record<archivePath, isoTimestamp>` to the
  `messages` STATE cursor (`types.ts`). `reconcileMessageSourceCache` checks,
  per selected scoped archive, `scopedArchiveDueForResume` (no prior
  timestamp, or elapsed ≥ `SLACK_LOOKBACK_DAYS`); if not due,
  `refreshScopedArchive` returns immediately — `ensureArchiveOnDisk` (and the
  slackdump subprocess) is never invoked for that archive this run. If due,
  it resumes as before and the timestamp advances to this run's `emittedAt`.
  A successful repair attempt also stamps a fresh timestamp (it necessarily
  just resumed/archived that path). Progress reporting extended: `selected N
  repair unit(s) (... X due for resume + Y throttled (not yet due) ...)`
  up front, `completed C/N repair unit(s) (resumed | throttled, not owed)`
  per unit.
- [x] 8.3 **Retirement/reclaim determination (required by the brief):**
  determined the bloated scoped archive's `slackdump.sqlite` CANNOT be safely
  deleted/retired — it remains the only durable resume state for a
  permanently-missing channel; deleting it forces a costlier from-scratch
  `archive` invocation next time, the same unsafe-DB-deletion class already
  rejected for the main archive (see `design.md` rejected alternatives). Its
  `__uploads/` residue was already safely reclaimable via task 7.1's fix
  (throttling changes only whether `resume` runs, not whether the archive is
  selected/read, so it stays in `scopedArchives` and therefore in
  `reclaimPlan`) — no additional reclaim code change was needed.
- [x] 8.4 Deterministic mutation-grade regression added to
  `archive-reclaim.test.ts`: `scoped-archive-reconcile throttles a scoped
  archive's resume to at most once per lookback window` (seeds
  `scoped_archive_resumed_at` = now, asserts the resume subprocess path
  — `ensureArchiveOnDisk`'s own "reading existing archive at ..." line — is
  never reached for that archive, and the throttled timestamp is carried
  forward unchanged) and `scoped-archive-reconcile resumes a scoped archive
  again once its lookback throttle window has elapsed` (seeds a
  `scoped_archive_resumed_at` 8 days in the past, asserts the resume DOES
  fire and the timestamp advances). **Mutation-tested twice**: disabling the
  throttle check entirely fails the first test
  (`AssertionError: explicitly reports the throttle decision for this
  archive`); forcing `scopedArchiveDueForResume` to always return `false`
  fails the second test (`AssertionError: reports the archive as due for
  resume once the throttle window has elapsed`). Both confirmed live, then
  reverted.
- [x] 8.5 Focused suite green: `archive-reclaim.test.ts` (15 tests, 2 new) +
  `slackdump-runtime.test.ts` (14 tests) = 29 pass, 0 fail. `tsc --noEmit`
  clean. `biome check` clean (one formatting auto-fix applied, re-verified
  clean after). `git diff --check` clean.

### Still not reproduced locally (task 8)

The throttle's real multi-day elapse behavior (does a run 8 days after the
last resume genuinely re-fire, catching the accumulated backlog with no gap,
on the live host specifically) cannot be observed in one sitting — synthetic
tests inject the elapsed-time boundary deterministically instead. Owner UAT
across a real multi-day window is the only way to observe this on the live
connection; recorded in `design.md`'s residual risks.
