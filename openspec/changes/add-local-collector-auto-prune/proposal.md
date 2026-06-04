# Bound retained acknowledged local-collector outbox rows automatically

## Why

The memory-pressure root-cause investigation (`ri-memory-pressure-rootcause-v1`)
found a local-collector outbox SQLite file holding ~35 GB of `succeeded` rows.
The durable outbox keeps one row per acknowledged outbound work item — a
delivered record batch, checkpoint, gap, or blob upload — and nothing in the
normal run path ever removes them. The server already holds the durable copy;
the local `succeeded` row only survives as a forensic tail. Without a bound it
accumulates one row per acknowledged batch on every run, forever.

The primitive to reclaim that tail already exists:
`LocalDeviceOutbox.pruneSent()` deletes only `succeeded` rows under an age
and/or count bound in a single transaction, and the `pdpp-local-collector
prune-sent` CLI wraps it for one-shot operator compaction. But the normal
`runCollectorConnector` drain path never calls it and no timer exists, so the
only relief is a human remembering to run a manual command. That is not an
SLVP-ideal construction: a brand-new user who never runs the CLI hits the same
35 GB outbox, and "the queue silently grows without bound until the host runs
out of disk" is a latent failure every install carries.

The fix is to make the bound automatic and durable-by-construction: after a
collector drain attempt completes — the moment the outbox is quietest and
pruning `succeeded` rows can never race undelivered work — prune the retained
acknowledged tail back to a conservative count-plus-age bound, reusing the
existing `pruneSent()` primitive. The automatic path takes no backup (a
multi-GB backup every 15 minutes is exactly the disk pressure it exists to
relieve) and relies on the doubly-bounded `succeeded`-only delete for safety.
The manual CLI keeps its backup-before-`--apply` behavior unchanged.

This is local outbox SQLite housekeeping. It is independent of the reference
storage backend (SQLite or Postgres): the local collector's outbox is always a
local SQLite file regardless of where the reference server persists records.

## What Changes

- Add a `CollectorAutoPrunePolicy` (`enabled`, `keepRecentCount`,
  `keepWithinDays`) and a conservative default
  (`enabled: true`, `keepRecentCount: 1000`, `keepWithinDays: 30`) to
  `packages/polyfill-connectors/src/collector-runner.ts`.
- After the collector drain attempt completes — on both the normal-scan return
  path and the backlog-skip return path — call `outbox.pruneSent()` scoped to
  the run's source instance, always supplying BOTH a `keepCount` and an
  `olderThanIso` bound so the prune is doubly bounded and never a "prune all
  succeeded" call. Only `succeeded` rows are eligible inside `pruneSent`; the
  ready/leased/retrying/dead-letter rows the run may leave behind are
  structurally out of scope.
- Surface the prune outcome on `CollectorRunResult.prunedSent`
  (`enabled`, `matched`, `pruned`) so the run result, and therefore the
  `pdpp-local-collector run` CLI output that spreads it, exposes the reclaimed
  count for diagnostics without inspecting the SQLite file.
- Add an operator override path that needs no rebuild: a `config.autoPrune`
  run-config override plus environment overrides
  (`PDPP_COLLECTOR_AUTO_PRUNE=0|false|off|no` to disable;
  `PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT`,
  `PDPP_COLLECTOR_AUTO_PRUNE_KEEP_DAYS` to retune the bounds), with env taking
  final precedence and malformed values falling through rather than throwing.
- Rebuild the committed `packages/local-collector/dist/` wrapper so the
  published collector carries the new behavior and result field.
- Extend the `local-collector-durable-work` capability spec with a requirement
  that the runner bounds its retained acknowledged outbox rows after a drain
  without a separate timer and without touching undelivered work.

No new HTTP route, schedule, or systemd timer is introduced. The manual
`prune-sent` CLI, its backup behavior, and its dry-run default are unchanged.
No pending, leased, ready, retryable, or dead-letter row is ever a prune
candidate.

## Capabilities

- Modified: local-collector-durable-work

## Impact

- `packages/polyfill-connectors/src/collector-runner.ts` — `CollectorAutoPrunePolicy`,
  `DEFAULT_COLLECTOR_AUTO_PRUNE_POLICY`, `resolveCollectorAutoPrunePolicy`,
  `autoPruneSucceededOutbox`, `CollectorAutoPruneResult`; `CollectorRunConfig.autoPrune`;
  `CollectorRunResult.prunedSent`; the prune step wired into both return paths
  of `runCollectorConnector` and `maybeSkipScanForBacklog`.
- `packages/polyfill-connectors/src/collector-auto-prune.test.ts` — new unit
  tests for the policy resolver and the bounded, status-scoped prune.
- `packages/polyfill-connectors/src/collector-runner.test.ts` — new integration
  tests proving the prune fires after a clean drain, can be disabled, and is a
  no-op within the default bounds.
- `packages/local-collector/dist/**` — regenerated wrapper carrying the source
  change and the new result field.
- `openspec/specs/local-collector-durable-work/spec.md` — via this change's
  delta.
