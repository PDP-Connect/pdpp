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
