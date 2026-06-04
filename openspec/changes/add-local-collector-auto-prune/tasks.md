# Tasks

## 1. Run-time auto-prune construction

- [x] 1.1 Add `CollectorAutoPrunePolicy` (`enabled`, `keepRecentCount`,
  `keepWithinDays`), `DEFAULT_COLLECTOR_AUTO_PRUNE_POLICY`
  (`enabled: true`, `keepRecentCount: 1000`, `keepWithinDays: 30`), and
  `CollectorAutoPruneResult` (`enabled`, `matched`, `pruned`) to
  `packages/polyfill-connectors/src/collector-runner.ts`.
- [x] 1.2 Add `resolveCollectorAutoPrunePolicy(override, env)` layering
  default → run-config → env in increasing precedence, with
  `PDPP_COLLECTOR_AUTO_PRUNE` (disable) and
  `PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT` / `PDPP_COLLECTOR_AUTO_PRUNE_KEEP_DAYS`
  (retune) overrides, malformed values falling through rather than throwing.
- [x] 1.3 Add `autoPruneSucceededOutbox({ outbox, policy, sourceInstanceId, now })`
  that, when enabled, calls `outbox.pruneSent()` with BOTH `keepCount` and
  `olderThanIso` (never a prune-all) scoped to the source instance, and returns
  the reclaimed count.
- [x] 1.4 Add `CollectorRunConfig.autoPrune` and `CollectorRunResult.prunedSent`.
- [x] 1.5 Wire the prune into `runCollectorConnector`'s normal return path
  (after the final drain/checkpoint/gap-recovery) and into
  `maybeSkipScanForBacklog`'s backlog-skip return path (after the completed
  pre-scan drain), resolving the policy once per run.

## 2. Dist wrapper

- [x] 2.1 Rebuild the committed `packages/local-collector/dist/` so the
  published collector carries the source change and the new `prunedSent` result
  field surfaced by the `run` CLI.

## 3. Tests

- [x] 3.1 Unit (`src/collector-auto-prune.test.ts`): policy resolver default,
  run-config override, env disable, env precedence + retune, malformed
  fall-through; `autoPruneSucceededOutbox` prunes over both bounds and reports
  the count; keeps recent-by-count; keeps young-by-age; never prunes
  ready/leased/retrying/dead-letter; keeps a succeeded row alongside open work;
  no-op when disabled; scoped to one source instance.
- [x] 3.2 Integration (`src/collector-runner.test.ts`): a two-pass run prunes
  the older acknowledged batch and reports `pruned: 1`; a disabled run retains
  both acknowledged batches and reports `enabled: false`; a single default-policy
  run prunes nothing and retains its acknowledged row.

## 4. Spec + validation

- [x] 4.1 Add the `local-collector-durable-work` requirement that the runner
  bounds retained acknowledged outbox rows after a drain, without a separate
  timer, without touching undelivered work, without a per-run backup, with a
  diagnostic count, and with an operator override.
- [x] 4.2 `pnpm --filter @pdpp/polyfill-connectors run typecheck`; targeted
  collector + outbox tests green; `biome check` clean on touched files;
  `openspec validate add-local-collector-auto-prune --strict`.

## Acceptance checks

- [x] Acknowledged rows over the count-plus-age bound are pruned after a clean
  drain and the reclaimed count is reported — unit + integration tests.
- [x] ready/leased/retrying/dead-letter rows are never pruned — unit test
  seeding every status, asserting the row total is preserved.
- [x] The automatic prune can be disabled and retuned via policy/env without a
  rebuild — resolver unit tests + integration disable test.
- [x] The run result exposes the prune count for diagnostics — integration test.
- [x] Both bounds are always supplied (never prune-all) and the prune is scoped
  to one source instance — unit tests.
