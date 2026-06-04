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

## Construction: prune after the drain, reuse pruneSent, double-bound it

The run-time prune runs inside `runCollectorConnector` after the drain attempt
completes, on both return paths:

1. **Normal path** — after the post-record drain, checkpoint commit, and gap
   recovery, once `finalSummary` is taken. The outbox is at its quietest here:
   ready work has been drained or dead-lettered, and the only rows the prune can
   touch are `succeeded`.
2. **Backlog-skip path** (`maybeSkipScanForBacklog`) — after the pre-scan drain
   has completed. Scan was skipped because open work remains, but the pre-scan
   drain *is* a completed drain attempt, and pruning `succeeded` rows there is
   equally safe. Bounding the tail on a busy lane that keeps skipping scans is
   exactly where it matters.

In both places the prune calls `outbox.pruneSent()` scoped to the run's
`sourceInstanceId`, always supplying BOTH bounds:

- `keepCount: policy.keepRecentCount` — keep the most-recent N `succeeded` rows.
- `olderThanIso: now − policy.keepWithinDays` — keep anything younger than the
  age floor.

`pruneSent` ANDs the two predicates: a row is deleted only when it is BOTH
outside the most-recent-N set AND older than the age floor. So a row survives if
it is recent by count OR recent by age — the conservative reading. The call is
never a "prune all succeeded" call because both bounds are always present; even
if a future caller passed neither, this wrapper supplies both.

`pruneSent`'s own `WHERE status = 'succeeded'` clause makes
ready/leased/retrying/dead-letter rows structurally ineligible. The runner does
not pre-filter or branch on status — it relies on the primitive's invariant, and
the tests pin that invariant directly.

## Why a count-plus-age default, and why these numbers

The constraint is "conservative but bounded; prefer keep-recent-by-count-plus-age
over unlimited retention". The two defaults are tied to existing facts, not
chosen arbitrarily:

- **`keepWithinDays: 30`** reuses the manual `prune-sent` CLI's existing
  `DEFAULT_PRUNE_SENT_OLDER_THAN_DAYS = 30`. The automatic and operator paths
  therefore share one age floor instead of inventing a second number. Thirty
  days of acknowledged tail is ample for after-the-fact forensic inspection of a
  recent run while still aging out indefinitely-retained history.
- **`keepRecentCount: 1000`** is a tenth of the runner's existing per-run
  bounds `maxEnqueuedBatchesPerRun` / `maxQueueDepth` (both `10_000`). It keeps
  roughly the order of a single run's enqueue budget of acknowledged rows per
  source instance for inspection, and caps retention four-plus orders of
  magnitude below the ~170k-row incident. Tying it to an existing policy bound,
  rather than a round number from thin air, is what makes it non-arbitrary.

The count bound is the load-bearing one for the incident shape: a host that runs
the collector every 15 minutes for months accumulates far more than 1,000
acknowledged rows, all older than 30 days, so the count bound caps the file. The
age bound protects a burst: a host that just delivered 5,000 batches in one day
keeps all of them (younger than 30 days) until they age out, so a heavy backfill
is never pruned out from under an operator who might still want to inspect it.

## Why no backup in the automatic path

The manual CLI takes a SQLite backup before `--apply` because a human is running
a one-shot, possibly large, destructive compaction. The automatic path runs
every drain (potentially every 15 minutes). A multi-GB backup file written that
often is itself the disk pressure this change exists to relieve, and it would
defeat the purpose. The automatic path is safe without a backup because:

- It only ever deletes `succeeded` rows the server has already acknowledged —
  there is no undelivered state to lose.
- The delete is doubly bounded (count AND age) and runs in a single transaction
  that cascades to the observed-stream index, so it can never partially prune.

The manual CLI's backup-before-`--apply` behavior is deliberately left
unchanged for operator-driven compaction.

## Operator override without a rebuild

Correctness does not depend on a systemd timer, but operators still need a kill
switch and a way to retune without rebuilding a deployed collector:

- `config.autoPrune` lets a caller (or test) override the policy in process.
- `PDPP_COLLECTOR_AUTO_PRUNE=0|false|off|no` disables the run-time prune.
- `PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT` / `PDPP_COLLECTOR_AUTO_PRUNE_KEEP_DAYS`
  retune the bounds.

`resolveCollectorAutoPrunePolicy` layers default → run-config → env in
increasing precedence. Env wins last so a deployed host can override even a
hard-coded run config. Malformed env values (negative, non-numeric, empty) fall
through to the lower-precedence value rather than throwing, so a typo in an
operator's environment never breaks a collector run.

## Diagnostics

`CollectorRunResult.prunedSent` (`enabled`, `matched`, `pruned`) surfaces the
outcome. `enabled: false` means the prune was turned off; otherwise `pruned` is
how many over-retention `succeeded` rows the drain reclaimed. The
`pdpp-local-collector run` CLI output already spreads the run result, so the
count appears in its JSON without extra plumbing. It never reflects
ready/leased/retrying/dead-letter rows.

## Alternatives considered

- **A standalone systemd timer running `prune-sent`.** Rejected: the constraint
  is explicitly "do not require a separate timer for correctness", and a timer
  is one more thing a new user must install and that can silently fail. Pruning
  on the drain the runner already performs makes the bound intrinsic.
- **Prune by age only (no count bound).** Rejected: a host that runs the
  collector frequently can accumulate an unbounded number of rows that are each
  younger than the age floor at the moment of any single run, so an age-only
  bound does not cap a high-frequency lane. The count bound is what caps the
  incident shape.
- **Prune by count only (no age bound).** Rejected: a single heavy backfill that
  delivers far more than `keepRecentCount` batches would be pruned immediately,
  destroying the recent forensic tail an operator may still want. The age bound
  protects a burst.
- **Take a backup in the automatic path like the CLI.** Rejected: writing a
  multi-GB backup every drain is the disk pressure being fixed.
- **Move the bound into `pruneSent`/the outbox layer as a hard cap.** Rejected:
  the outbox primitive is policy-free on purpose (the CLI and the runner choose
  different bounds and backup behavior). Keeping policy in the runner preserves
  that separation and keeps the destructive primitive a pure mechanism.

## Scope and non-goals

- No new HTTP route, schedule, or timer.
- No change to the manual `prune-sent` CLI, its backup, or its dry-run default.
- No change to which statuses `pruneSent` deletes — `succeeded`-only is the
  existing, relied-upon invariant.
- No change to reference storage; this is local outbox SQLite housekeeping and
  is identical whether the reference backend is SQLite or Postgres.
- Reclaiming the operator's *current* giant outboxes is out of scope for the
  automatic path on its first run after deploy (those rows will age/­count out
  over subsequent runs, or the operator can run the manual `prune-sent --apply`
  once); the report records the one-shot owner command.

## Acceptance checks

- `succeeded` rows over the count-plus-age bound are pruned after a clean
  drain, and the reclaimed count is reported — unit + integration tests.
- ready, leased, retrying, and dead-letter rows are never pruned — unit test
  seeding every status and asserting the row total is preserved.
- The prune can be disabled via policy/env — unit test on the resolver and
  integration test through the runner.
- The run result exposes the prune count for diagnostics — integration test.
- Both bounds are always supplied (never a prune-all) and the prune is scoped
  to one source instance — unit tests.
