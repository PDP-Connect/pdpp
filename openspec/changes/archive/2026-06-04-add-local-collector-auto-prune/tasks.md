# Tasks

## 1. Run-time auto-prune construction (count-bounded)

- [x] 1.1 Add `CollectorAutoPrunePolicy` (`enabled`, `keepRecentCount`),
  `DEFAULT_COLLECTOR_AUTO_PRUNE_POLICY` (`enabled: true`,
  `keepRecentCount: 10_000` = `maxEnqueuedBatchesPerRun` / `maxQueueDepth`), and
  `CollectorAutoPruneResult` (`enabled`, `matched`, `pruned`) to
  `packages/polyfill-connectors/src/collector-runner.ts`. No age knob.
- [x] 1.2 Add `resolveCollectorAutoPrunePolicy(override, env)` layering
  default → run-config → env in increasing precedence, with
  `PDPP_COLLECTOR_AUTO_PRUNE` (disable) and
  `PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT` (retune cap) overrides, malformed
  values falling through rather than throwing.
- [x] 1.3 Add `autoPruneSucceededOutbox({ outbox, policy, sourceInstanceId })`
  that, when enabled, calls `outbox.pruneSent()` with `keepCount` as the SOLE
  bound (no `olderThanIso`, never a prune-all) scoped to the source instance,
  and returns the reclaimed count.
- [x] 1.4 Add `CollectorRunConfig.autoPrune` and `CollectorRunResult.prunedSent`.
- [x] 1.5 Wire the prune into `runCollectorConnector`'s normal return path and
  into `maybeSkipScanForBacklog`'s backlog-skip return path, resolving the
  policy once per run, running the prune BEFORE the final heartbeat and before
  the summary the run result returns so the reported outbox counts are
  post-prune.

## 2. Dist wrapper

- [x] 2.1 Rebuild the committed `packages/local-collector/dist/` so the
  published collector carries the source change and the new `prunedSent` result
  field surfaced by the `run` CLI.

## 3. Tests

- [x] 3.1 Unit (`src/collector-auto-prune.test.ts`): policy resolver default
  (cap 10,000, no age key), run-config override, env disable, env precedence +
  retune, malformed fall-through; `autoPruneSucceededOutbox` prunes over the
  count cap and reports the count; REGRESSION — a large set of rows all
  acknowledged "today" prunes down to the cap (catches the v1 count-AND-age
  flaw); REGRESSION — a 15-day spread of fresh rows is capped on the first pass
  (the live incident shape); keeps within cap; never prunes
  ready/leased/retrying/dead-letter; keeps a succeeded row alongside open work;
  no-op when disabled; scoped to one source instance.
- [x] 3.2 Integration (`src/collector-runner.test.ts`): a two-pass run prunes
  the older acknowledged batch and reports `pruned: 1` with NO age trick, and
  the returned `outboxSummary.succeeded` and the final heartbeat outbox
  diagnostics are post-prune; a disabled run retains both acknowledged batches
  and reports `enabled: false`; a single default-policy run prunes nothing and
  retains its acknowledged row.

## 4. Spec + validation

- [x] 4.1 Update the `local-collector-durable-work` requirement so the bound is
  a most-recent-count cap that removes acknowledged rows beyond the cap
  regardless of age, with a scenario pinning the "all acknowledged recently"
  shape and a scenario pinning post-prune reported counts; without a separate
  timer, without touching undelivered work, without a per-run backup, with a
  diagnostic count, and with an operator override.
- [x] 4.2 `pnpm --filter @pdpp/polyfill-connectors run typecheck`; targeted
  collector + outbox tests green; `biome check` clean on touched files;
  `openspec validate add-local-collector-auto-prune --strict`.

## Acceptance checks

- [x] Acknowledged rows over the count cap are pruned after a clean drain and
  the reclaimed count is reported — unit + integration tests.
- [x] A large set of acknowledged rows all acknowledged "today" prunes down to
  the cap (v1-flaw regression) — unit test.
- [x] ready/leased/retrying/dead-letter rows are never pruned — unit test
  seeding every status, asserting the row total is preserved.
- [x] The automatic prune can be disabled and the cap retuned via policy/env
  without a rebuild — resolver unit tests + integration disable test.
- [x] The run result exposes the prune count and post-prune outbox counts —
  integration test.
- [x] The count bound is always supplied (never prune-all) and the prune is
  scoped to one source instance — unit tests.
