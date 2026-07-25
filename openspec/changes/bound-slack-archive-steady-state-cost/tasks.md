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
- [x] 6.2 **Reclaim scope defect (task 3.2 defect):** the reclaim plan tracked
  only the base/positional-channel archive path, never the scoped archives
  `reconcileMessageSourceCache` heals for previously-observed-but-now-missing
  channels. Live evidence: `archive-scoped/.../__uploads` residue (19MB + 766MB)
  survived while the main archive's `__uploads/` was already gone. Fixed:
  `reclaimPlan` now lists the base archive plus every `scopedArchives` entry the
  run actually reconciled this run; `onDurableCommit` reclaims each in turn.
- [x] 6.3 **Invisible reconciliation cost (task 2 defect):** the live run showed
  a ~58-minute "scoped slackdump resume" phase between `slackdump-subprocess`
  (172647ms) and `read-and-emit` (35711ms) that neither reported timing existed
  for — `reconcileMessageSourceCache`'s own per-missing-channel slackdump
  `resume` subprocess calls ran untimed. This is genuine Slack-API-side backlog
  catch-up (verified against upstream slackdump's `resume` — it drives real
  `conversations.history`/`replies` calls per healed channel, rate-limited by
  Slack, cost scales with backlog not local sqlite size), not a redundant call;
  the safe fix is making the cost visible, not removing it. Fixed: wrapped in
  `timedPhase(progress, "scoped-archive-reconcile", ...)`.
- [x] 6.4 Mutation-grade tests added to `archive-reclaim.test.ts`: multi-archive
  reclaim (base + scoped, byte counts asserted per archive, sqlite untouched in
  both) and `scoped-archive-reconcile` phase-timing emission, both against a
  synthetic fixture reproducing the live "healed missing channel from an
  existing scoped archive" topology. Existing reclaim-evidence assertion
  updated to check stderr (not stdout) and to match the specific reclaim phrase
  rather than a bare "reclaim" substring (which false-positived against the
  test's own `pdpp-slack-reclaim-*` tmpdir prefix).
- [x] 6.5 `test-harness.ts`: settle `runConnectorProtocolSubprocess` on the
  child's `close` event instead of `exit` — `exit` can fire before stdio pipes
  finish draining their last buffered chunk, a latent race independent of this
  fix but tightened while diagnosing test timing here.

### Still not reproduced locally

The 58-minute duration itself (as opposed to its cause and now-visible timing)
depends on live Slack API rate limits and real backlog size; not something a
synthetic test can assert a specific number for. Owner UAT (below) is the only
way to observe the real bounded number.
