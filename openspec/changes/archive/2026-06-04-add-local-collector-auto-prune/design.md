# Design: automatic bound on retained acknowledged outbox rows

## Problem

`LocalDeviceOutbox` keeps a row per outbound work item and transitions it to
`succeeded` on server acknowledgement. Acknowledged rows are never read again —
the server holds the durable copy — but the normal run path never deletes them,
so the file grows one row per acknowledged batch per run without bound. The live
incident was a ~35 GB outbox holding ~170k+ `succeeded` rows. The `pruneSent()`
primitive and the `prune-sent` CLI exist, but only a human invoking the CLI ever
calls them, so the bound is not a construction — it is an operator chore a new
user never knows to perform.

## Construction: prune after the drain, reuse pruneSent, bound by count

The run-time prune runs inside `runCollectorConnector` after the drain attempt
completes, on both return paths:

1. **Normal path** — after the post-record drain, checkpoint commit, and gap
   recovery. The outbox is at its quietest here: ready work has been drained or
   dead-lettered, and the only rows the prune can touch are `succeeded`.
2. **Backlog-skip path** (`maybeSkipScanForBacklog`) — after the pre-scan drain
   has completed. Scan was skipped because open work remains, but the pre-scan
   drain *is* a completed drain attempt, and pruning `succeeded` rows there is
   equally safe. Bounding the tail on a busy lane that keeps skipping scans is
   exactly where it matters.

In both places the prune calls `outbox.pruneSent()` scoped to the run's
`sourceInstanceId`, supplying a single bound:

- `keepCount: policy.keepRecentCount` — keep the most-recent N `succeeded` rows
  per source instance and prune every older one.

No `olderThanIso` is passed. The retained tail is therefore a **true upper
bound**: it can never exceed `keepRecentCount` rows, no matter how fast or how
recently the source acknowledged them.

`pruneSent`'s own `WHERE status = 'succeeded'` clause makes
ready/leased/retrying/dead-letter rows structurally ineligible. The runner does
not pre-filter or branch on status — it relies on the primitive's invariant, and
the tests pin that invariant directly. `keepCount` is always present, so the call
is never a "prune all succeeded" call.

## Why count-only, not count-AND-age (the v1 correction)

The v1 implementation supplied BOTH a `keepCount` and an `olderThanIso` floor of
30 days. `pruneSent` ANDs those predicates: a row is deleted only when it is
BOTH outside the most-recent-N set AND older than the age floor. That silently
defeated the cap for the exact incident shape this change exists to fix.

The live incident's ~170k `succeeded` rows were all acknowledged over roughly
`2026-05-20 .. 2026-06-04` — about 15 days, none older than 30 days. Under the
ANDed bounds, the age clause `COALESCE(acknowledged_at, updated_at) < now − 30d`
matched **zero** rows, so the prune deleted nothing on the next run. The file
would have kept growing until the operator ran the manual CLI — the same chore
the change was meant to eliminate.

A count-only bound makes the cap load-bearing on the very first post-deploy run:
every `succeeded` row outside the most-recent N is pruned regardless of age, so
the 170k-row tail collapses to N rows immediately.

This is not a new pattern — it mirrors the manual `prune-sent` CLI, which
*already* drops the age filter when `--keep-count` is the operator's sole policy
"so the count cap works independently of row age" (see
`pruneSentOutboxRows`). The automatic path now uses that same count-only
mechanism. The age window remains available to operators through the CLI's
explicit `--older-than-days` flag.

## Why this default count, and why it is non-arbitrary

`keepRecentCount: 10_000` is the runner's own per-run / per-source bound, not a
fraction invented for this change:

- `maxEnqueuedBatchesPerRun` (10,000) is the first-backfill/scan enqueue budget:
  the most record batches one invocation will durably enqueue before stopping.
- `maxQueueDepth` (10,000) is the pending-or-retrying ceiling per source
  instance before the runner refuses to scan.

Both are `10_000`. Setting the retained acknowledged cap to the same number
keeps roughly **one run's enqueue budget / one queue's depth** worth of
acknowledged rows — the amount of in-flight work the runner already permits to
exist for a source — rather than an arbitrary slice of it. It caps retention
more than an order of magnitude below the ~170k-row incident while keeping ample
recent history for after-the-fact inspection.

(v1 used `1000`, justified only as "a tenth of" those bounds — an arbitrary
fraction. Tying the cap to the bound itself is the defensible choice.)

The count bound is sufficient on its own for every growth shape:

- **High-frequency lane** (the incident): a host that runs the collector every
  15 minutes accumulates far more than 10,000 acknowledged rows, so the cap
  holds the file flat.
- **Heavy backfill burst**: a single scan can enqueue at most
  `maxEnqueuedBatchesPerRun` (10,000) batches, so a burst cannot exceed the cap
  in one run; the most-recent 10,000 acknowledged rows are always retained for
  inspection, and older ones age out by count on subsequent runs.

## Why no backup in the automatic path

The manual CLI takes a SQLite backup before `--apply` because a human is running
a one-shot, possibly large, destructive compaction. The automatic path runs
every drain (potentially every 15 minutes). A multi-GB backup file written that
often is itself the disk pressure this change exists to relieve, and it would
defeat the purpose. The automatic path is safe without a backup because:

- It only ever deletes `succeeded` rows the server has already acknowledged —
  there is no undelivered state to lose.
- The delete is bounded by count (never a prune-all) and runs in a single
  transaction that cascades to the observed-stream index, so it can never
  partially prune.

The manual CLI's backup-before-`--apply` behavior is deliberately left
unchanged for operator-driven compaction.

## Diagnostics are post-prune

The prune runs **before** the final heartbeat and before the summary the run
result returns, on both paths. So `finalSummary` / `summaryAfterGap`, the
heartbeat `outbox` diagnostics, and `CollectorRunResult.outboxSummary` all
report the **post-prune** `succeeded` / `total` counts — the server never
records a stale pre-prune tail. This is safe to reorder because the prune only
ever removes `succeeded` rows: the pending/ready/leased/retrying/dead-letter
counts, `records_pending`, and the heartbeat status are identical before and
after the prune, so reordering changes only the reported `succeeded`/`total`.

`CollectorRunResult.prunedSent` (`enabled`, `matched`, `pruned`) surfaces the
prune outcome itself. `enabled: false` means the prune was turned off; otherwise
`pruned` is how many over-cap `succeeded` rows the drain reclaimed. The
`pdpp-local-collector run` CLI output already spreads the run result, so the
count appears in its JSON without extra plumbing. It never reflects
ready/leased/retrying/dead-letter rows.

## Operator override without a rebuild

Correctness does not depend on a systemd timer, but operators still need a kill
switch and a way to retune without rebuilding a deployed collector:

- `config.autoPrune` lets a caller (or test) override the policy in process.
- `PDPP_COLLECTOR_AUTO_PRUNE=0|false|off|no` disables the run-time prune.
- `PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT` retunes the count bound.

`resolveCollectorAutoPrunePolicy` layers default → run-config → env in
increasing precedence. Env wins last so a deployed host can override even a
hard-coded run config. Malformed env values (negative, non-numeric, empty) fall
through to the lower-precedence value rather than throwing, so a typo in an
operator's environment never breaks a collector run.

## Alternatives considered

- **A standalone systemd timer running `prune-sent`.** Rejected: the constraint
  is explicitly "do not require a separate timer for correctness", and a timer
  is one more thing a new user must install and that can silently fail. Pruning
  on the drain the runner already performs makes the bound intrinsic.
- **Count AND age (the v1 design).** Rejected — and this is the v2 correction.
  ANDing a 30-day age floor with the count cap means a row survives if it is
  recent by count OR recent by age, so a fast lane whose entire tail is younger
  than the floor is never pruned. The live 35 GB / 170k-row outbox (all
  acknowledged within ~15 days) would have reclaimed zero rows on the next run.
  An age floor cannot bound a high-frequency lane; only a count cap can.
- **Count OR age (prune if outside-N OR older-than-age).** Rejected as
  unnecessary complexity. An old row that is still inside the most-recent N is
  already harmless — the tail is bounded by N — so reaping it early buys
  nothing the count cap does not already guarantee. The operator who wants a
  time window has the manual CLI's `--older-than-days`.
- **Take a backup in the automatic path like the CLI.** Rejected: writing a
  multi-GB backup every drain is the disk pressure being fixed.
- **Move the bound into `pruneSent`/the outbox layer as a hard cap.** Rejected:
  the outbox primitive is policy-free on purpose (the CLI and the runner choose
  different bounds and backup behavior). Keeping policy in the runner preserves
  that separation and keeps the destructive primitive a pure mechanism.

## Scope and non-goals

- No new HTTP route, schedule, or timer.
- No change to the manual `prune-sent` CLI, its backup, its dry-run default, or
  its optional `--older-than-days` age window.
- No change to which statuses `pruneSent` deletes — `succeeded`-only is the
  existing, relied-upon invariant.
- No change to reference storage; this is local outbox SQLite housekeeping and
  is identical whether the reference backend is SQLite or Postgres.

## Reclaiming the current giant outbox

This is **in scope** under the count-only bound. On the first run after deploy,
the prune reclaims the operator's current acknowledged tail down to
`keepRecentCount` rows in a single bounded transaction, regardless of how
recently those rows were acknowledged. The ~170k-row / 35 GB incident outbox
collapses to ~10,000 rows on its next collector run — no manual CLI invocation
required. (The manual `prune-sent --apply` remains available for an operator who
wants to compact immediately or to a tighter bound, with a backup.)

## Acceptance checks

- `succeeded` rows over the count cap are pruned after a clean drain, and the
  reclaimed count is reported — unit + integration tests.
- A large set of `succeeded` rows all acknowledged "today" is pruned down to the
  count cap (the v1-flaw regression) — unit test.
- ready, leased, retrying, and dead-letter rows are never pruned — unit test
  seeding every status and asserting the row total is preserved.
- The prune can be disabled and the count retuned via policy/env — unit test on
  the resolver and integration test through the runner.
- The run result and heartbeat report post-prune `succeeded` counts — integration
  test asserting `outboxSummary.succeeded` and the final heartbeat's outbox
  diagnostics.
- The count bound is always supplied (never a prune-all) and the prune is scoped
  to one source instance — unit tests.
