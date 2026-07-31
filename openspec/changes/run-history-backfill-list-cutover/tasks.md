## 1. Cursor store generalization (no new table)

- [x] `connector-maintenance-cursor-store.ts`: parameterize `CURSOR_NAME` as a
      `cursorName` argument (`ConnectorMaintenanceCursorName = "connector_summary_evidence"
      | "run_history_backfill"`), both SQLite and Postgres implementations;
      `createConnectorMaintenanceCursorStore` defaults to `"connector_summary_evidence"`
      so the existing evidence-sweep call sites are unaffected.
- [x] Widen `connector_maintenance_cursor.name`'s `CHECK` constraint on both backends
      (fresh-install schema + a migration for existing databases: SQLite table rebuild,
      Postgres `DROP`/`ADD CONSTRAINT` via `pg_get_constraintdef`).

## 2. Bounded backfill fold stage

- [x] `server/stores/run-history-backfill-stage.ts` (new): candidate-run discovery by
      `event_seq > cursor` over run-lifecycle event types, excluding run_ids already in
      `run_history`; batch fold via unmodified `summarizeEvents`/
      `postgresFoldRunSummariesByIds`; legacy connector-wide singleton attribution
      (`resolveActiveByConnector`, throws-on-ambiguous reused directly); `facts_json`
      extraction from the terminal event's raw data (batched, zero extra query on
      SQLite; one small batched query on Postgres); `INSERT ... ON CONFLICT(run_id) DO
      NOTHING`; cursor commits only after the batch lands.
- [x] `createResumableRunHistoryBackfillStage`: fenced-lease wrapper mirroring
      `createResumableConnectorMaintenanceSweep`'s pattern for the evidence sweep.
- [x] `runStartupRunHistoryBackfillToCompletion`: bounded multi-round startup
      accelerator, capped rounds, never a traffic gate.

## 3. Chassis wiring

- [x] `connector-maintenance-sweep.ts`: new `Promise.all` branch, independently
      best-effort, `onPhaseError` extended with `"run_history_backfill"`.
- [x] `server/index.ts`: `runHistoryBackfillStage` instance shared between the periodic
      sweep and the startup one-shot; `startupRunHistoryBackfillDone` exposed on
      `StartServerResult` and awaited only in the CLI's graceful-shutdown drain (same
      pattern as `startupSummaryEvidenceSweepDone`), never blocking `startServer`.

## 4. LIST/detail cutover

- [x] `SchedulerRunHistoryRecord` gains `factsJson?: Record<string, unknown> | null`;
      `ProductRunHistoryRecord` (status admits `"running"`) added as the product-reader
      shape, distinct from the scheduler-scoped type so scheduler-only consumers'
      narrower status union is preserved.
- [x] `listLatestRunHistoryForProductByConnectionIds` /
      `getLatestRunHistoryForProductByConnectionId` (both backends): unscoped `run_history`
      reads (no `scheduler_managed` filter), including `running` rows, including
      `facts_json`.
- [x] `productRunHistoryToConnectorRunSummary` (ref-control.ts): the read-time
      composition rule — `running` + live lease → `in_progress`; `running` + no lease →
      `failed`; terminal row → stored status. Existing vocabulary only.
- [x] `ConnectorSummaryProjectionDeps.getLatestRunSummaryForConnectionId` replaces
      `getLatestRunHistoryForConnection`/`listRunSummariesForConnector`; batched via the
      same `loadConnectorSummaryProjectionDeps` Promise.all, page-scoped.
- [x] `latestRunFactsJsonByRunId` deps field: the already-batched `facts_json` per
      run_id, feeding the adaptive-rate-controller snapshot's terminal-event fast path
      instead of a second per-run spine read.

## 5. Dead code deletion

- [x] Deleted: `toConnectorRunSummary`, `schedulerRunHistoryToConnectorRunSummary`,
      `getLatestRunSummaryForConnection` (R7-transitional three-tier composition),
      `createConnectorRunSummariesReader`, `listPageRunSummaries`,
      `readRunTerminalEventData` (and its now-orphaned `RunTerminalEventRow` type).
- [x] Kept (oracle/other-consumer support, per R9.2): `listRunSummariesByConnectorIds`,
      `postgresListRunSummariesByConnectorIds`, `listSpineCorrelations`,
      `canUseConnectorWideRunSummaryFallback`, `runSummaryMatchesConnection` (used by
      `test/connector-run-fallback-matcher.test.ts` and
      `test/ref-connectors-list-operation.test.ts` as oracles).

## 6. Tests

- [x] `test/run-history-backfill-cutover.test.ts` (new, 9 tests): candidate corpus
      (scheduled/manual/browser/cancelled/legacy-connector-wide) backfilled correctly;
      legacy connector-wide run skipped when 0 or >1 active instances; idempotency
      (rerun from the same checkpoint inserts zero); crash-resume (fresh stage instance
      sharing the durable cursor resumes without skip/duplicate); race — concurrent live
      terminal write vs. backfill insert lands exactly one row, terminal facts win; race
      — two concurrent sweep owners fence to exactly one via the cursor store's lease;
      boundedness — batchSize caps rows/statements per round, a zero-duration-budget
      round yields without a partial insert; the product LIST route
      (`getConnectorSummaryForRoute`) performs zero `spine_events` statements for a
      **terminal** run's GET, on SQLite (instrumented via a `better-sqlite3` prototype
      patch, not a per-instance wrap, since the Proxy-cached `db.prepare` call would
      otherwise under-count); the active-run/lease overlay renders `in_progress`/`failed`
      using the existing vocabulary. **Correction (REVISE, second gate pass,
      2026-07-30): this file's zero-spine claim was overclaimed as unqualified "the
      product LIST route performs zero spine_events statements" — it never drove an
      in-progress run through the route and never ran on Postgres, so it missed the
      `readLatestCollectionRateForRun` spine fallback that fired on every route for a
      currently-running connection. See §8 below for the closing proof (all three
      run-state cases × both backends).**
- [x] `test/scheduler-store-semantic-surface.test.ts`: fixture updated for the new
      `factsJson: null` field `listRunHistory`'s hydration now always includes (that
      reader's column set never selected `facts_json`, so it round-trips null).
- [x] Regression sweep, all green: `run-history-writer-authority.test.ts` (8/8),
      `ref-connectors-list-operation.test.ts` (73/73),
      `scheduler-store-semantic-surface.test.ts` (12/13, 1 live-Postgres skip),
      `connector-run-fallback-matcher.test.ts`, plus 17 controller/connector-summary
      consumer test files (125/126, 1 unrelated skip), plus the full `pdpp.test.ts`
      integration suite (118/118).
- [x] `pnpm typecheck` clean; `ultracite check` clean on every touched file (pre-existing
      unrelated lint findings in untouched files left as-is).

## 7. Out of scope (deferred)

- [ ] `listActiveRuns()` page-scoping (R3) — separate gate item.
- [ ] Cleanup slice: delete `postgres-spine.ts`'s CTE fold / `lib/spine.ts`'s
      `listRunSummariesByConnectorIds` from the codebase entirely, once backfill
      completion is monitored stable in production and the equivalence oracle is no
      longer needed (R9.2's cleanup slice, explicitly deferred — "the old fold survives
      only as the test oracle, then is deleted").

## 8. REVISE fix (second gate pass, 2026-07-30): G1 closure, no carve-out

- [x] Root cause: `readLatestCollectionRateForRun` (ref-control.ts) kept a spine-read
      fallback (`spine_events WHERE event_type = 'run.progress_reported'`) for a
      still-running run's `collection_rate`, reached from all five connector-summary
      routes via `projectConnectorSummaryForInstance`. The first landing declared this
      "out of section 9's scope" as a genuinely different feature — the gate rejected
      that carve-out: §3 G1 and R9.3 oracle 5 state the zero-spine bar with no
      route/feature exception.
- [x] `isRunHistoryRelevantEventType` (run-history-writer.ts) extended to recognize
      `run.progress_reported`.
- [x] `writeSqliteRunHistoryForSpineEvent` / `writePostgresRunHistoryForSpineEvent`: new
      branch merges `collection_rate` into the running row's `facts_json` — SQLite via
      `json_patch(COALESCE(facts_json, '{}'), json(?))` (new query
      `controllerMergeRunHistoryCollectionRate` /
      `merge-run-history-collection-rate.sql`), Postgres via
      `COALESCE(facts_json, '{}'::jsonb) || jsonb_build_object('collection_rate', $1::jsonb)`
      — both a single atomic statement, fenced by `WHERE run_id = ? AND status =
      'running'` so a concurrent/later terminal write always wins and cannot be
      overwritten by a stale in-flight progress merge. Postgres's transaction wrapping
      (`postgresEmitSpineEvent`) covers the new event type automatically since it keys
      off `isRunHistoryRelevantEventType`.
- [x] `readLatestCollectionRateForRun` simplified to a synchronous, unconditional
      `facts_json` read (no `terminalData`/spine-fallback branch); its spine SQL deleted
      entirely — `spineGetRunLatestCollectionRateEvent` removed from the query registry
      and its SQL file (`server/queries/spine/get-run-latest-collection-rate-event.sql`)
      deleted; the inline Postgres slow-path query deleted.
- [x] `latestRunFactsJsonByRunId` deps field's doc comment corrected (no longer
      describes a "fast path" — it is now the only path).
- [x] `test/active-run-summary-zero-spine.test.ts` (new, 6 tests, dual-backend, zero
      skips against the sanctioned Postgres instance): zero `spine_events` statements
      for (a) an in-progress run with `collection_rate` merged via
      `run.progress_reported`, (b) a terminal run, (c) a connection with no run at all —
      each proven on both SQLite (`better-sqlite3` prototype patch) and real Postgres
      (`pg.Pool.prototype.query` patch, same instrumentation technique the gate's own
      probe used).
- [x] Regression sweep re-run clean: `run-history-backfill-cutover.test.ts` (9/9),
      `run-history-writer-authority.test.ts` (8/8 incl. live Postgres),
      `scheduler-store-semantic-surface.test.ts` (13/13 incl. live Postgres),
      `active-run-summary-zero-spine.test.ts` (6/6, zero skips), full `pdpp.test.ts`
      (118/118). `pnpm typecheck` clean; `ultracite check` clean on every touched file.

## 9. REVISE fix (second gate pass, 2026-07-30): fleet-migration `completed_at` repair reachability

- [x] Root cause: `e44bf3391`'s `ALTER COLUMN completed_at DROP NOT NULL` (Postgres) /
      table-rebuild (SQLite) repair lived inside
      `migratePostgresRunHistoryRename`/`migrateRunHistoryRename`'s `legacyExists`-gated
      branch, which returns immediately once `scheduler_run_history` no longer exists.
      A database whose rename already executed under an earlier deployment of this
      migration (before `e44bf3391` shipped) is permanently stuck on the legacy `NOT
      NULL` constraint — the repair's own guard is false by the time the fix ships, so
      `run.started` throws forever on that database. Found live: the gate's own
      sanctioned Postgres instance was in exactly this stuck state.
- [x] `migratePostgresRunHistoryCompletedAtNullable` (Postgres) /
      `migrateRunHistoryCompletedAtNullable` (SQLite): extracted into standalone
      functions that check `run_history`'s own existence and `completed_at`
      nullability directly — independent of `scheduler_run_history` — and run
      unconditionally right after the rename migration on both backends.
      `migratePostgresRunHistoryRename`/`migrateRunHistoryRename` no longer contain the
      `completed_at` repair at all.
- [x] SQLite repair preserves both indexes (`idx_run_history_connector_completed`,
      `uniq_run_history_run_id`) across the rebuild — the original e44bf3391 rebuild
      already recreated the connector/completed_at index but this extraction re-verified
      and kept both explicitly.
- [x] `test/run-history-completed-at-fleet-migration.test.ts` (new, 4 tests, dual-backend,
      zero skips against the sanctioned Postgres instance): a pre-renamed-stuck database
      (run_history already exists, no scheduler_run_history, completed_at still NOT
      NULL) is repaired on the next boot on both backends; idempotent under a second
      boot; row data, `id` values, and both indexes survive intact; a fresh install is
      unaffected (no-op immediately).
- [x] Test isolation (mid-task correction): every Postgres test in this file and in
      `active-run-summary-zero-spine.test.ts` runs against its own disposable,
      uniquely-named database (`withTemporaryPostgresDatabase`), never the shared
      `pdpp_test` base database — the fixtures are destructive (`DROP TABLE`/raw
      `CREATE TABLE` against `run_history`) and must never touch state another test run
      depends on. Guaranteed create+drop cleanup even on assertion failure. The shared
      base database, incidentally corrupted mid-session by an earlier draft of these
      tests that mutated it directly, was restored to its canonical bootstrapped schema
      (drop + normal-bootstrap rebuild, no ad hoc data preservation) and verified clean;
      zero leftover child databases from this task's own test runs (8 pre-existing,
      unrelated leftover databases from other test suites were left untouched — not this
      task's blast radius).
- [x] Regression sweep re-run clean: `run-history-completed-at-fleet-migration.test.ts`
      (4/4, zero skips), `run-history-writer-authority.test.ts` (8/8 incl. live
      Postgres), full `pdpp.test.ts` (118/118). `pnpm typecheck` clean; `ultracite check`
      clean on every touched file.

## 10. LIVE CANARY REVISE (2026-07-30): duplicate `run_id` identity fix

- [x] Root cause: candidate `1a4d32971` was rolled back to `1392a386f` after Postgres
      migration could not create `uniq_pg_run_history_run_id` (error 42P10), then every
      `ON CONFLICT(run_id)` writer/backfill insert failed the same way. Read-only live
      proof: exactly 2 duplicate `run_id`s, each representing TWO DISTINCT connection
      histories, not duplicate rows — `run_1782401113918` = a failed run on
      `cin_11deac...` and a succeeded run on a different connection `cin_b110...`;
      `run_1782865411684` = a failed run on `cin_11deac...` and a succeeded run on
      `cin_c858...`. `run_id` is minted independently by several call sites
      (`runtime/scheduler/run-executor.ts`, `runtime/controller.ts`, `runtime/index.ts`)
      using `Date.now()`-based generators with no connection-scoped entropy, so two
      different connections can legitimately produce the identical `run_id` string —
      `run_id` alone was never a safe uniqueness/conflict/identity key. No historical
      rows were deleted, collapsed, or relabeled; no live data was patched — this is a
      schema/write-path fix only.
- [x] The real identity is the pair `(run_id, connector_instance_id)`. Unique index
      renamed and widened on both backends: SQLite `uniq_run_history_run_id_instance`,
      Postgres `uniq_pg_run_history_run_id_instance`, both
      `ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL` — the
      old bare-`run_id` index is explicitly `DROP INDEX IF EXISTS`'d at each migration
      site before the composite one is created. No swallowed index-creation error: the
      migration sites that used to fail-open (try/catch, log, continue) on duplicate
      `run_id` data now create the composite index unconditionally, with no
      compatibility read path — it succeeds because the composite key does not collide
      on the live data shape, and if it ever did, that would be a genuine anomaly this
      migration must surface loudly, not hide.
- [x] Every `ON CONFLICT(run_id)` writer retargeted to `ON CONFLICT(run_id,
      connector_instance_id)`: `start-run-history.sql`,
      `insert-finalized-run-history.sql`, `insert-run-history.sql` (SQLite), plus their
      3 Postgres inline mirrors in `run-history-writer.ts` and `scheduler-store.ts`, and
      the backfill stage's own insert.
- [x] Every `UPDATE run_history ... WHERE run_id = ?` (finalize, progress-merge) now
      also fences on `AND connector_instance_id = ?` on both backends
      (`finalize-run-history.sql`, `merge-run-history-collection-rate.sql`, and their 2
      Postgres inline mirrors) — without this fence, a terminal or progress write for
      one connection's run could match and corrupt a DIFFERENT connection's
      still-running row sharing the same `run_id`. This is the actual live-corruption
      vector, independent of the index/ON CONFLICT fix.
- [x] Backfill stage (`run-history-backfill-stage.ts`): candidate discovery now
      `GROUP BY run_id, connector_instance_id` (sourced from the real, indexed
      `spine_events.connector_instance_id` column, not `data_json` parsing at discovery
      time), idempotency-skip keyed on the composite pair. Event-window fold: both
      backends fetch by `run_id` exactly as before (the SAME unmodified batched fetch —
      `loadEventsForSummaries`/`fetchRowsForSummaries`), then filter the returned window
      down to one candidate's own connection BEFORE folding — Postgres via the real
      `connector_instance_id` column already on each fetched row, SQLite via
      `connectionIdFromEventData` (now exported from `lib/spine.ts`, the same
      `data.connector_instance_id`/`data.connection_id` precedence `summarizeEvents`
      itself uses internally). The fold functions themselves
      (`summarizeEvents`/`summarizeRows`, the latter now exported from
      `lib/postgres-spine.ts`) are genuinely unmodified — only their input window is
      pre-scoped. A legacy candidate with `connectorInstanceId === null` groups into its
      own NULL-instance bucket and flows through the existing
      `resolveLegacyConnectorWideInstanceId` singleton path unchanged (R9.2).
- [x] `test/run-history-duplicate-run-id-identity.test.ts` (new, 4 tests, dual-backend):
      (1) SQLite — two connections sharing a run_id each get their own row; a progress
      event for one connection merges only into that connection's `facts_json`, never
      the other's; finalizing one connection does not affect the other's still-running
      row; `scheduler.appendRunHistory`'s upsert enriches only the targeted connection's
      row. (2) SQLite — the backfill stage discovers two connections sharing a run_id as
      two separate `(run_id, connector_instance_id)` candidates and folds each with only
      its own connection's event window (not a blended one), idempotent on a second
      round. (3) PostgreSQL — migration builds the composite unique index over data
      reproducing the exact live 42P10 failure shape (two rows sharing a run_id across
      distinct connections), preserving both rows, and a subsequent
      `ON CONFLICT(run_id, connector_instance_id)` write for a THIRD connection sharing
      the same run_id succeeds. (4) PostgreSQL — the same connection-isolation proof as
      (1), against real Postgres via the live spine writer.
- [x] Existing test files updated for the renamed/widened index:
      `run-history-completed-at-fleet-migration.test.ts`'s SQLite and Postgres fixtures
      and assertions now reference `uniq_run_history_run_id_instance`/
      `uniq_pg_run_history_run_id_instance` on the composite key.
- [x] Regression sweep re-run clean: `run-history-duplicate-run-id-identity.test.ts`
      (4/4, zero skips against sanctioned Postgres),
      `run-history-completed-at-fleet-migration.test.ts` (4/4),
      `run-history-backfill-cutover.test.ts` (9/9),
      `run-history-writer-authority.test.ts` (8/8 incl. live Postgres),
      `active-run-summary-zero-spine.test.ts` (6/6, zero skips) — 27/27 combined.
      `pnpm typecheck` clean (only pre-existing unrelated errors remain);
      `ultracite check` clean on every touched file.
- [x] Test-accounting: 2 new PostgreSQL bare-boolean-skip test names added to
      `scripts/test-accounting/receipt.ts`'s exact named-skip mapping; verified via a
      real memory-default run through `structuredNodeSummary` (both skips explained,
      zero "unexplained skip" throws).

## 11. SECOND LIVE CANARY REVISE (2026-07-30): interrupted-migration reconciliation

- [x] Root cause: candidate `f2b1ebe20` failed startup because
      `migratePostgresRunHistoryRename` found BOTH `scheduler_run_history` and a
      non-empty `run_history` and threw ("refusing to guess which is authoritative").
      A real interrupted migration: the first rejected canary (candidate `1a4d32971`)
      had already renamed `scheduler_run_history` -> `run_history` and
      backfilled/live-wrote into it before being rolled back to old revision
      `1392a386f`, which predates the entire `run_history` generalization (commit
      `998028a82`) and has zero knowledge of `run_history`/the rename — it recreates
      `scheduler_run_history` fresh via its own `CREATE TABLE IF NOT EXISTS` and
      resumes writing to it. Live read-only measurement (2026-07-30 19:23 CDT):
      `scheduler_run_history`=22 rows (actively growing since rollback),
      `run_history`=11,415 rows (frozen since the interrupted candidate stopped),
      composite-identity overlap=0 (a pure disjoint union on the actual live data) —
      but numeric `id` values DO overlap between the two tables, so legacy ids must
      never be reused/preserved blindly. No live data edits were made; the live
      instance stayed on old revision `1392a386f` throughout this investigation.
- [x] `reconcilePostgresLegacySchedulerRunHistory` (Postgres) /
      `reconcileLegacySchedulerRunHistory` (SQLite): both
      `migratePostgresRunHistoryRename`/`migrateRunHistoryRename` no longer throw on
      "both tables non-empty" — they reconcile losslessly. Composite-identity
      (`run_id IS NOT NULL`) rows merge via the SAME `ON CONFLICT(run_id,
      connector_instance_id) DO UPDATE SET field = excluded.field` upsert contract
      `insert-run-history.sql` already establishes for "a scheduler row meets an
      existing `run_history` row" (scheduler-owned fields win; `facts_json`/
      `trigger_kind`, which `scheduler_run_history` never carried, are left
      untouched). `run_id IS NULL` rows (never conflict under the partial unique
      index) insert unconditionally, exactly once, since the whole merge runs inside
      ONE all-or-nothing transaction — table existence is therefore the only
      idempotency marker needed; no persisted provenance marker on `run_history` rows
      (a synthetic `facts_json` marker was considered and explicitly rejected —
      contaminates product facts with migration metadata and is unnecessary given the
      atomic-transaction guarantee). A genuine count-based invariant (every legacy row
      traceable in `run_history` — existence check for `run_id IS NOT NULL`,
      before/after NULL-count delta for `run_id IS NULL`) is verified BEFORE
      `DROP TABLE scheduler_run_history`; a mismatch throws loudly rather than
      dropping unreconciled data. Legacy numeric `id` values are never reused — every
      merged row gets a fresh `run_history` id from that table's own sequence
      (confirmed necessary live: the two tables' ids overlap).
- [x] `test/run-history-interrupted-migration-reconciliation.test.ts` (new, 7 tests,
      dual-backend): fresh install unaffected; legacy-only migration (no interruption)
      still a pure rename; interrupted-migration reconciliation merges losslessly
      (composite-identity overlap via the established upsert contract, disjoint rows
      from both tables preserved, `run_id IS NULL` rows preserved without collision,
      duplicate `run_id` across two different connections survives without
      collapsing, no legacy id reused); idempotent on a second boot (already-gone
      legacy table = pure no-op); a simulated crash mid-reconciliation (transaction
      never commits) leaves `scheduler_run_history` fully intact for a clean retry.
      Every scenario proven on both SQLite and real Postgres (2/2 Postgres-specific
      tests run live against the sanctioned instance, zero skips when
      `PDPP_TEST_POSTGRES_URL` is set).
- [x] Regression sweep: this file's own 7/7 (5/5 SQLite + 2/2 live Postgres); combined
      with `run-history-completed-at-fleet-migration.test.ts`,
      `run-history-backfill-cutover.test.ts`, `run-history-writer-authority.test.ts`,
      `run-history-duplicate-run-id-identity.test.ts`,
      `active-run-summary-zero-spine.test.ts` — 38/38. Full RI suite
      (`node scripts/run-tests.ts`, memory-default) diffed byte-for-byte against
      unmodified HEAD (`378cac600`, captured before this turn's changes): identical
      set of 10 pre-existing failures on both runs, zero new regressions.
      `pnpm typecheck` clean (same pre-existing unrelated errors, unchanged);
      `ultracite check` clean on every touched file; `node
      scripts/quality-ratchet/check-mass-ratchet.ts --files server/db.ts,server/postgres-storage.ts`
      passes with no justification bump needed.
- [x] Test-accounting: 2 new PostgreSQL bare-boolean-skip test names added to
      `scripts/test-accounting/receipt.ts`'s exact named-skip mapping; a matching
      narrow regression added to `scripts/test-accounting/inventory.test.ts`; verified
      via a real memory-default run through `structuredNodeSummary` (both skips
      explained, zero "unexplained skip" throws).
      `test-accounting.manifest.json`'s memory-default `"PDPP_TEST_POSTGRES_URL
      unset"` baseline updated `129 -> 136` (129 original + 3 from
      `active-run-summary-zero-spine.test.ts` + 2 from
      `run-history-duplicate-run-id-identity.test.ts` + 2 from this turn — the prior
      two deltas had been deferred/never applied; this is an arithmetic derivation
      from known deltas, not a live-verified full authority-run count — flagged for
      confirmation on the next full `test-accounting:check` pass).

## 12. FOURTH-PASS GATE REVISE (2026-07-30): duplicate composite key within scheduler_run_history

- [x] Root cause: the fourth-pass adversarial gate found that `scheduler_run_history`
      can itself contain multiple rows sharing the identical `(run_id,
      connector_instance_id)` pair — structurally reachable because the
      pre-generalization scheduler writer at the rolled-back revision `1392a386f` does
      a plain `INSERT` with no `ON CONFLICT` clause at all (confirmed via direct
      source read: `git show 1392a386f:.../scheduler-store.ts:528-566`), so a
      retried/duplicate scheduled-run completion under that currently-live writer can
      produce exactly this shape. On Postgres, `reconcilePostgresLegacySchedulerRunHistory`'s
      composite-identity merge INSERT (`ON CONFLICT ... DO UPDATE`) throws `ON CONFLICT
      DO UPDATE command cannot affect row a second time` whenever two source rows
      target the same conflict key — a hard Postgres restriction independent of
      `ORDER BY`. This is on the exact backend (Postgres) and exact code path
      (interrupted-migration reconciliation) the live incident is about; if the real
      database's `scheduler_run_history` contains even one such duplicate pair, the
      migration would throw on every boot attempt, permanently blocking that database
      until manual intervention — the exact outcome this reconciliation effort exists
      to avoid. The SQLite path does not have this bug (`INSERT ... SELECT ... ON
      CONFLICT DO UPDATE` applies duplicate source rows in order, last one wins, no
      error) — a genuine backend asymmetry.
- [x] `reconcilePostgresLegacySchedulerRunHistory` (Postgres): the composite-identity
      merge's source is now pre-deduplicated via `SELECT DISTINCT ON (run_id,
      connector_instance_id) ... ORDER BY run_id, connector_instance_id, id DESC`,
      keeping only the highest `id` (the latest write) per pair — extending the same
      "scheduler's newer write wins" semantics the merge already establishes for the
      cross-table overlap case (via `ON CONFLICT DO UPDATE`) to the intra-table case.
- [x] `reconcileLegacySchedulerRunHistory` (SQLite): the equivalent dedup added for
      defense-in-depth and cross-backend consistency (`ROW_NUMBER() OVER (PARTITION BY
      run_id, connector_instance_id ORDER BY id DESC) ... WHERE rn = 1`), rather than
      relying on the undocumented, backend-specific tolerance for duplicate
      `ON CONFLICT` source rows.
- [x] `test/run-history-interrupted-migration-reconciliation.test.ts`: 2 new tests
      (dual-backend) reproducing the exact gate-probe fixture shape — two
      `scheduler_run_history` rows sharing the identical composite key, different
      `attempt`/`status` — proving the migration no longer throws, exactly one row
      survives for that composite key, and it reflects the highest-`id` (latest)
      source row's fields. The Postgres test was independently verified to reproduce
      the exact gate-reported error (`ON CONFLICT DO UPDATE command cannot affect row
      a second time`) when run against the pre-fix code (`git stash` of the two
      migration files), confirming it is a genuine discriminating regression test, not
      merely a fixture that happens to pass.
- [x] All previously-gated behavior preserved and re-verified in the same run: fresh
      install, legacy-only migration, composite-identity overlap merge (scheduler
      wins), disjoint-row preservation (both directions), `run_id IS NULL` handling,
      duplicate `run_id` across two *different* connections, idempotency on a second
      boot, and crash-before-commit safety — all 7 pre-existing tests in this file
      still pass unchanged, alongside the 2 new ones (9/9 total, dual-backend, zero
      skips against the sanctioned Postgres instance).
- [x] Per direct instruction, only focused discriminating tests were run (this file,
      both profiles), plus `openspec validate --strict` and the touched-file gates
      (`pnpm typecheck`, `ultracite check`, mass ratchet) — the broad suite was not
      re-run, consistent with the third and fourth gate passes' own guidance that
      already-settled ground need not be re-verified.
