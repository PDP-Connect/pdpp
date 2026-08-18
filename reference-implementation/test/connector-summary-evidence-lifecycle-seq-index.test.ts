// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production incident, 2026-08-18, DEPLOYED image `pdpp-core:drain10`
 * (commit a5505bb59, immediately after it shipped): the exact
 * `candidates_inspected: 0, skipped: 0, repaired: 0` symptom the deployed
 * fix was meant to close PERSISTED, unchanged, after deploy. Postgres logs
 * confirmed the OLD `records`-count query (the one a5505bb59 removed) was
 * genuinely gone from the running container's queries after restart -- but a
 * DIFFERENT query immediately took its place as the thing that times out:
 *
 *   SELECT connector_instance_id, MAX(event_seq) AS max_seq FROM spine_events
 *     WHERE connector_instance_id = ANY($1::text[]) GROUP BY connector_instance_id
 *
 * (`readPostgresDiscoveryContext`'s `maxLifecycleSeqResult`,
 * connector-summary-evidence-engine.ts, feeding `classifyCandidate`'s
 * `lifecycle_checkpoint_lag` comparison -- a genuinely load-bearing signal
 * added 2026-07-29, unlike the redundant `records` count a5505bb59 deleted).
 *
 * Root cause: `idx_pg_spine_events_terminal_instance_seq` only covers the
 * four TERMINAL event types (`WHERE event_type IN ('run.completed', ...)`).
 * The lifecycle query groups by `connector_instance_id` over EVERY event
 * type, so it fell through to a full parallel seq scan -- measured directly
 * against production, 2026-08-18: 1.5-1.9s / ~117k buffers (~940 MB) via
 * `EXPLAIN (ANALYZE, BUFFERS)` on 1.4M spine_events rows, with the scoped
 * `= ANY(...)` form no faster (the planner cannot prune an unindexed
 * column). That was slow enough, under real production contention, to blow
 * discovery's remaining per-pass admission allowance every ~60s sweep pass.
 *
 * Because `readPostgresDiscoveryContext` issues every one of its seven
 * sequential queries through `postgresDiscoveryQuery` with NO per-query
 * try/catch (unlike `repairCandidate`, which the 2026-08-11
 * `reasonCodeForRepairFailure`/`logRepairFailure` machinery isolates
 * per-connection), a `PostgresStatementTimeoutError` cancelling THIS query
 * propagates out of `discoverCandidates` exactly like the `records` count
 * used to -- `observeConnectorSummaryEvidence`'s existing 92c9fc83e catch
 * converts that into a clean `candidates_inspected: 0, incomplete: true`
 * pass (not a crash, not corrupted evidence), but it also means NOTHING in
 * the batch was ever classified: a durably-`dirty` row (which
 * `classifyCandidate` would resolve on its very FIRST comparison, long
 * before it would ever reach the lifecycle-seq comparison this cancelled
 * query feeds) is never even attempted. Same "repaired: 0, skipped: 0
 * forever" shape as the incident a5505bb59 fixed, one query later in the
 * same sequential list.
 *
 * The fix (this commit) adds a general, unfiltered
 * `(connector_instance_id, event_seq)` index -- `idx_pg_spine_events_
 * instance_seq` in postgres-storage.ts, `idx_spine_events_instance_seq` in
 * db.ts -- covering every event type, not just the four terminal ones. This
 * is the SAME fix already proven for the terminal-scoped case
 * (`idx_pg_spine_events_terminal_instance_seq`); unlike the `records` count
 * a5505bb59 deleted, the lifecycle-seq query cannot simply be removed -- it
 * is the only durable backstop for `run.started`/`run.progress_reported`
 * events beyond terminal outcomes (see `classifyCandidate`'s
 * `lifecycle_checkpoint_lag` doc, 2026-07-29 terminal-gate revision).
 *
 * SECOND, DETERMINISTIC call site (found chasing a fresh log line that
 * appeared post-restart and looked, at first, like a DIFFERENT bug): every
 * ~60s tick, `connector-maintenance-sweep.ts` alternates which of two
 * tranches (`walk` / dirty-priority `acceleration`) runs first
 * (`runBoundedSummaryEvidenceSweep`, 2026-08-12 starvation fix). On a
 * `walkFirst` tick, `runWalkTranche` is awaited BEFORE
 * `runAccelerationTranche` -- and if the walk's own `onPageConverged`
 * callback throws anything other than the one allow-listed
 * `TERMINAL_PROJECTION_PUBLICATION_RACE` (`isExpectedProjectionRace`,
 * connector-summary-read-model.ts), that throw propagates out of the WHOLE
 * `runBoundedSummaryEvidenceSweep` call -- `runAccelerationTranche` (the
 * ONLY path that reads the dirty-priority backlog) never runs AT ALL that
 * tick. Production, 2026-08-18: connection `cin_992b0c94cebeb3066ba42a6e`
 * (Signal, 6,448 records, created 19:22:40, ZERO `spine_events` rows) had no
 * `connector_summary_evidence` row at all, so every walk page reaching it
 * threw `"Cannot publish connector list summary without canonical evidence"`
 * (`ref-control.ts:7012`) -- NOT the allow-listed race, so it escaped
 * uncaught, killing the walk tranche (and, on `walkFirst` ticks, the
 * acceleration tranche with it) every time its page came up. That
 * connection never got its OWN evidence row created for the SAME reason:
 * `repairCandidatePostgres`'s per-connection lifecycle read --
 * `SELECT MAX(event_seq) FROM spine_events WHERE connector_instance_id =
 * $1` (connector-summary-evidence-engine.ts, `lifecycleHighWaterResult`,
 * NO event_type filter, NO GROUP BY) -- hits the exact same unindexed
 * column. Proven directly against production (READ-ONLY): even with ZERO
 * matching rows, `EXPLAIN (ANALYZE, BUFFERS)` against this query for
 * `cin_992b0c94cebeb3066ba42a6e` still timed out at a 10-SECOND budget --
 * an unindexed predicate cannot be pruned by absence of matches, so a
 * connection with NO spine history pays the SAME full-scan cost as one
 * with millions. The general index this file's other tests prove covers
 * `readPostgresDiscoveryContext`'s batched, GROUP-BY form also covers this
 * single-row, non-grouped form -- confirmed directly: `EXPLAIN` for the
 * identical zero-match shape plans an `Index Only Scan`
 * (`idx_pg_spine_events_instance_seq`) once the index exists, not a scan of
 * the whole table. One index fix closes both the batched-discovery
 * starvation AND the per-connection repair failure that was crashing the
 * walk tranche.
 *
 * This file proves, against REAL PostgreSQL:
 *   - FAIL-BEFORE: with the new index dropped (reproducing the exact
 *     pre-fix schema), genuine contention on `spine_events` cancels the
 *     lifecycle-seq query and aborts discovery for the WHOLE requested
 *     batch -- an unambiguously dirty row is never even attempted.
 *   - PASS-AFTER: with the index present (the migration's default state
 *     after this fix), the query plan for the exact SQL shape
 *     `readPostgresDiscoveryContext` issues no longer requires a full
 *     table scan (`EXPLAIN` shows an Index Scan/Only Scan, not a Seq
 *     Scan), and the same contention window that broke discovery before no
 *     longer blocks it -- the dirty row is discovered, classified, and
 *     attempted.
 *   - PER-CONNECTION REPAIR, zero-match case: a connection with NO
 *     `spine_events` rows at all (the Signal shape above) can still create
 *     its evidence row via `repairCandidate` within a tight deadline --
 *     proving the fix closes the repair-side failure, not just the
 *     batched-discovery side.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import {
  getConnectorSummaryEvidence,
  markConnectorSummaryEvidenceDirty,
  reconcileDirtyConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-08-18T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/lifecycle-seq-index";
const INDEX_NAME = "idx_pg_spine_events_instance_seq";

function withPostgres(fn: () => Promise<void>) {
  return async () => {
    if (!POSTGRES_URL) {
      return;
    }
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await fn();
    } finally {
      await closePostgresStorage();
    }
  };
}

async function seedHealthyConnection(id: string): Promise<void> {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    JSON.stringify({ connector_id: CONNECTOR_ID, streams: [{ name: "items", primary_key: ["id"] }] }),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [id, CONNECTOR_ID, NOW]
  );
  // A NON-terminal lifecycle event -- exercises exactly the general index
  // this fix adds, not the pre-existing terminal-scoped one.
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      boot_epoch: "boot-lifecycle-seq-index",
      connection_id: id,
      connector_instance_id: id,
      seq: 1,
      source: { id: CONNECTOR_ID, kind: "connector" },
      trigger_kind: "manual",
    },
    event_id: `evt_${id}_started`,
    event_type: "run.started",
    object_id: `run_${id}`,
    object_type: "run",
    run_id: `run_${id}`,
    status: "started",
  });
}

async function cleanup(id: string): Promise<void> {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

/**
 * Holds a real `ACCESS EXCLUSIVE` lock on `spine_events` for `holdMs` on a
 * SEPARATE connection from the app's own pool -- genuine PostgreSQL lock
 * contention against the SAME table the lifecycle-seq query reads, standing
 * in for that query's real multi-second execution time at production data
 * volume without needing to seed 1.4M rows in a test.
 */
async function withSpineEventsTableContention<T>(holdMs: number, fn: () => Promise<T>): Promise<T> {
  const pool = getPostgresPool();
  const lockClient = await pool.connect();
  await lockClient.query("BEGIN");
  await lockClient.query("LOCK TABLE spine_events IN ACCESS EXCLUSIVE MODE");
  const release = lockClient.query(`SELECT pg_sleep(${holdMs / 1000})`).then(() => lockClient.query("COMMIT"));
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return await fn();
  } finally {
    await release;
    lockClient.release();
  }
}

test(
  "FAIL-BEFORE shape: without the general lifecycle-seq index, contention on spine_events cancels the lifecycle query and aborts discovery for the WHOLE batch",
  withPostgres(async () => {
    const id = "cin_lifecycle_seq_index_before";
    await seedHealthyConnection(id);
    try {
      // Reproduce the exact pre-fix schema: drop the index this commit adds.
      // The pre-existing terminal-scoped index stays -- proving the general
      // index specifically, not merely "some index exists".
      await postgresQuery(`DROP INDEX IF EXISTS ${INDEX_NAME}`, []);

      await reconcileDirtyConnectorSummaryEvidence([id]);
      const before = await getConnectorSummaryEvidence(id);
      assert.ok(before, "cold-start repair creates the evidence row");

      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "test-dirty" });
      const dirtied = await getConnectorSummaryEvidence(id);
      assert.ok(dirtied);
      assert.equal(dirtied.dirty, true, "the row is durably dirty before the contended pass");

      const { postgresQueryBounded, PostgresStatementTimeoutError } = await import("../server/postgres-storage.ts");
      let caught: unknown = null;
      await withSpineEventsTableContention(900, async () => {
        try {
          await postgresQueryBounded(
            `SELECT connector_instance_id, MAX(event_seq) AS max_seq FROM spine_events
              WHERE connector_instance_id = ANY($1::text[])
              GROUP BY connector_instance_id`,
            [[id]],
            500
          );
        } catch (err) {
          caught = err;
        }
      });
      assert.ok(
        caught instanceof PostgresStatementTimeoutError,
        "contention on spine_events genuinely cancels the lifecycle-seq-shaped query at the 500ms floor when the general index is absent"
      );

      const result = await withSpineEventsTableContention(900, () =>
        reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 })
      );
      assert.equal(result.incomplete, true);
      assert.deepEqual(
        [...result.attemptedIds],
        [],
        "an aborted-batch discovery never attempted the unambiguously dirty row -- the production 'repaired: 0, skipped: 0 forever' shape"
      );

      const stillDirty = await getConnectorSummaryEvidence(id);
      assert.ok(stillDirty);
      assert.equal(stillDirty.dirty, true, "the dirty flag never clears when discovery never even attempted the row");
    } finally {
      await cleanup(id);
    }
  })
);

test(
  "PASS-AFTER (this fix): the general lifecycle-seq index removes the seq scan, and the same contention window no longer blocks discovery",
  withPostgres(async () => {
    const id = "cin_lifecycle_seq_index_after";
    await seedHealthyConnection(id);
    try {
      // Migration ran during initPostgresStorage above, so the index this
      // fix adds already exists here -- explicitly confirm it, so a future
      // migration regression fails loudly at this assertion rather than
      // silently passing for an unrelated reason.
      const indexRows = await postgresQuery(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'spine_events' AND indexname = $1",
        [INDEX_NAME]
      );
      assert.equal(indexRows.rowCount, 1, `${INDEX_NAME} must exist after migration`);

      // The query plan for the EXACT shape readPostgresDiscoveryContext
      // issues must not be a full scan of spine_events any more.
      const explainRows = await postgresQuery(
        `EXPLAIN (FORMAT JSON) SELECT connector_instance_id, MAX(event_seq) AS max_seq FROM spine_events
          WHERE connector_instance_id = ANY($1::text[])
          GROUP BY connector_instance_id`,
        [[id]]
      );
      const plan = JSON.stringify(explainRows.rows[0]["QUERY PLAN"]);
      assert.ok(
        !plan.includes("Seq Scan"),
        `lifecycle-seq query must not plan a full Seq Scan once the general index exists: ${plan}`
      );

      await reconcileDirtyConnectorSummaryEvidence([id]);
      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "test-dirty" });
      const dirtied = await getConnectorSummaryEvidence(id);
      assert.ok(dirtied);
      assert.equal(dirtied.dirty, true, "the row is durably dirty before the contended pass");

      // NOTE: the FAIL-BEFORE test's `LOCK TABLE ... ACCESS EXCLUSIVE`
      // technique cannot be reused here to prove the positive case: an
      // ACCESS EXCLUSIVE lock blocks ALL access to the table, including an
      // index scan, so it cannot distinguish "fast indexed read" from "slow
      // seq scan" -- it would fail this assertion even with a perfect index
      // and prove nothing. The real production bottleneck was scan COST
      // against 1.4M rows, not lock contention, so the right proof here is
      // that the query genuinely executes fast enough, under a realistic
      // row count, to fit inside the SAME tight deadline the FAIL-BEFORE
      // test used contention to simulate exceeding.
      const insertValues: string[] = [];
      const insertParams: unknown[] = [];
      for (let i = 0; i < 4000; i += 1) {
        const base = insertParams.length;
        insertValues.push(
          `($${base + 1}, 'run.progress_reported', $${base + 2}, $${base + 2}, 'default', $${base + 3}, 'runtime', $${CONNECTOR_ID ? base + 4 : base + 4}, 'run', $${base + 5}, 'in_progress', '{}'::jsonb, 'v1', $${base + 6})`
        );
        insertParams.push(
          `evt_fill_${i}`,
          NOW,
          `trc_fill_${i}`,
          CONNECTOR_ID,
          `run_fill_${i}`,
          `cin_lifecycle_seq_index_filler_${i % 50}`
        );
      }
      await postgresQuery(
        `INSERT INTO spine_events(
           event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id, actor_type, actor_id,
           object_type, object_id, status, data_json, version, connector_instance_id
         ) VALUES ${insertValues.join(", ")}`,
        insertParams
      );

      const startedAt = Date.now();
      const result = await reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 });
      const elapsedMs = Date.now() - startedAt;

      assert.deepEqual(
        [...result.attemptedIds],
        [id],
        `discovery selected and attempted the dirty row within a 200ms budget against ${insertParams.length / 6} unrelated spine_events rows (elapsed ${elapsedMs}ms) -- the indexed lifecycle-seq read no longer needs a full spine_events scan`
      );

      const repaired = await getConnectorSummaryEvidence(id);
      assert.ok(repaired);
      assert.equal(repaired.dirty, false, "the previously-stuck dirty row actually clears once discovery can select it");
    } finally {
      await postgresQuery("DELETE FROM spine_events WHERE event_id LIKE 'evt_fill_%'", []);
      await cleanup(id);
    }
  })
);

test(
  "PER-CONNECTION REPAIR (Signal production shape): a connection with ZERO spine_events rows and no evidence row yet still creates its evidence within a tight deadline",
  withPostgres(async () => {
    // Reproduces cin_992b0c94cebeb3066ba42a6e exactly: an active
    // connector_instances row, NO connector_summary_evidence row at all
    // (never observed), and NO spine_events rows whatsoever -- unlike
    // seedHealthyConnection, deliberately does NOT call emitSpineEvent.
    // repairCandidatePostgres's lifecycleHighWaterResult read
    // (SELECT MAX(event_seq) FROM spine_events WHERE connector_instance_id
    // = $1, no event_type filter, no GROUP BY) has to prove the ABSENCE of
    // any matching row, which an unindexed scan cannot do any cheaper than
    // proving presence -- production measured this exact zero-match query
    // still timing out at a 10-SECOND budget before this fix.
    const id = "cin_lifecycle_seq_index_zero_match_repair";
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
    await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [id]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      CONNECTOR_ID,
      JSON.stringify({ connector_id: CONNECTOR_ID, streams: [{ name: "items", primary_key: ["id"] }] }),
      NOW,
    ]);
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
      [id, CONNECTOR_ID, NOW]
    );
    try {
      const before = await getConnectorSummaryEvidence(id);
      assert.equal(before, null, "no evidence row exists yet -- exactly the Signal production shape");

      const zeroRows = await postgresQuery("SELECT 1 FROM spine_events WHERE connector_instance_id = $1", [id]);
      assert.equal(zeroRows.rowCount, 0, "the connection genuinely has no spine_events rows");

      // Same contention proof as the FAIL-BEFORE test above, on the SAME
      // table: without the general index, even a zero-match scan of
      // spine_events is a full table scan, so contention that would only
      // slow an indexed lookup marginally is enough to blow this tight
      // deadline for the unindexed shape. This directly reproduces why
      // Signal's repair kept timing out in production despite having no
      // spine_events rows of its own to read.
      await postgresQuery("DROP INDEX IF EXISTS idx_pg_spine_events_instance_seq", []);
      let caught: unknown = null;
      const { PostgresStatementTimeoutError } = await import("../server/postgres-storage.ts");
      const beforeResult = await withSpineEventsTableContention(900, async () => {
        try {
          return await reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 });
        } catch (err) {
          caught = err;
          return null;
        }
      });
      const beforeAttempted = beforeResult ? [...beforeResult.attemptedIds] : [];
      assert.ok(
        caught instanceof PostgresStatementTimeoutError || beforeAttempted.length === 0,
        "FAIL-BEFORE: without the index, contention on spine_events blocks the zero-match repair read from completing in time"
      );

      // Restore the index (the migration's normal, durable state). NOTE:
      // unlike the FAIL-BEFORE half above, this PASS-AFTER half deliberately
      // does NOT reuse the lock-contention technique -- an ACCESS EXCLUSIVE
      // lock blocks an indexed read exactly as completely as a seq scan (see
      // the batched PASS-AFTER test's note above), so it cannot distinguish
      // "fixed" from "still broken" here either. The real proof is that the
      // repair, run without artificial contention, both succeeds AND
      // measurably needs no full scan for the exact zero-match query shape.
      await postgresQuery(
        `CREATE INDEX IF NOT EXISTS idx_pg_spine_events_instance_seq
           ON spine_events(connector_instance_id, event_seq)
           WHERE connector_instance_id IS NOT NULL`,
        []
      );
      const explainRows = await postgresQuery(
        "EXPLAIN (FORMAT JSON) SELECT MAX(event_seq) AS max_seq FROM spine_events WHERE connector_instance_id = $1",
        [id]
      );
      const plan = JSON.stringify(explainRows.rows[0]["QUERY PLAN"]);
      assert.ok(
        !plan.includes("Seq Scan"),
        `repairCandidatePostgres's zero-match lifecycle read must not plan a full Seq Scan once the general index exists: ${plan}`
      );

      const result = await reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 });
      assert.deepEqual(
        [...result.attemptedIds],
        [id],
        "PASS-AFTER: a never-observed connection with zero spine_events rows must still be attempted -- classifyCandidate resolves it as 'missing' on its very first comparison"
      );

      const created = await getConnectorSummaryEvidence(id);
      assert.ok(created, "repair created the evidence row -- this is what a page's onPageConverged publish step needs to stop throwing 'Cannot publish connector list summary without canonical evidence'");
      assert.equal(created.dirty, false);
    } finally {
      await cleanup(id);
    }
  })
);
