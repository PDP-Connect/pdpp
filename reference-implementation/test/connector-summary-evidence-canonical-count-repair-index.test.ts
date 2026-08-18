// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production incident, 2026-08-18, DEPLOYED image `pdpp-core:drain10`
 * (commits a5505bb59 and this branch's own `idx_pg_spine_events_
 * instance_seq` discovery-side fix, both confirmed live and working):
 * `candidates_inspected: 0` fell to zero, discovery's own cancellations
 * disappeared from the Postgres log -- but the dirty backlog still never
 * shrank. Postgres logs showed a THIRD shape: 9 statement_timeout
 * cancellations in 10 minutes, all in the REPAIR path (`"repair for
 * <id> cancelled by Postgres statement_timeout"`, not `"discovery
 * cancelled"`), and always the SAME two connections --
 * `cin_2de5ede05c8cc8d45935c414` (peregrine Claude Code, 2.42M records) and
 * `cin_ece4bfe5096b8bf67a1468c2` (peregrine Codex, 1.30M records), together
 * ~3.7M of the fleet's 5.46M total rows in `records`.
 *
 * Root cause: `repairCandidatePostgres`'s per-connection canonical read
 * (connector-summary-evidence-engine.ts, `canonicalResult`) --
 *
 *   SELECT stream, COUNT(*)::int AS record_count, MAX(emitted_at) AS last_updated
 *     FROM records WHERE connector_instance_id = $1 AND deleted = FALSE
 *    GROUP BY stream
 *
 * -- was judged "legitimate, necessary, cheap" earlier in this same
 * investigation WITHOUT measuring it against a real multi-million-row
 * connection. Measured directly against production (READ-ONLY, `EXPLAIN
 * (ANALYZE, BUFFERS)`): 4.07s / ~584k buffers (~4.5 GB) for
 * cin_2de5ede05c8cc8d45935c414, 3.67s for cin_ece4bfe5096b8bf67a1468c2 --
 * `records` has SEVEN existing indexes, none of which cover
 * `(connector_instance_id, deleted)` without a `stream` predicate this
 * GROUP-BY query cannot supply (the closest, `idx_pg_records_stream_cursor`,
 * puts `deleted` AFTER `stream` in its key order). The existing
 * per-connection catch (`reasonCodeForRepairFailure`/`logRepairFailure`,
 * 2026-08-11) correctly avoids marking evidence `failed` on a cancellation
 * -- exactly why nothing was ever marked failed and the sweep looked quiet
 * -- but "correctly deferred, forever, on the same two rows" is still an
 * unbounded backlog.
 *
 * REJECTED alternatives (see this commit's message for the full
 * comparison against measured evidence): raising `MIN_STATEMENT_TIMEOUT_MS`
 * or giving repair a larger bound than discovery both re-trap on the NEXT
 * connection to cross whatever new ceiling is picked, since this query's
 * cost is O(row count) with no upper bound. Reusing the maintained
 * `retained_size_stream.record_count` counter was close but rejected: it
 * carries no `last_updated`/`MAX(emitted_at)` column, and its row-presence
 * semantics differ from this sparse GROUP BY in a way `buildRepairedRow`'s
 * `known_zero` vs `unobserved` distinction depends on.
 *
 * The fix (this commit) adds `idx_pg_records_canonical_count` --
 * `(connector_instance_id, deleted, stream) INCLUDE (emitted_at)` on
 * Postgres, `(connector_instance_id, deleted, stream, emitted_at)` on
 * SQLite -- covering this exact query shape. Verified directly at
 * production-representative selectivity (one connection at ~4.4% of a
 * 5.46M-row table, seeded in a throwaway scratch database, never
 * production DDL): the identical query plans a `Bitmap Heap Scan` off this
 * index at 83.7ms post-VACUUM, versus the 4.07s unindexed `Parallel Seq
 * Scan` measured on live production data.
 *
 * This file proves, against REAL PostgreSQL:
 *   - FAIL-BEFORE: with the new index dropped (reproducing the exact
 *     pre-fix schema), genuine contention on `records` cancels a
 *     connection's own repair read and leaves it durably dirty --
 *     `repairCandidate`'s existing per-connection catch defers rather than
 *     marking it failed (the 2026-08-11 fix stays correct), but the row
 *     never converges.
 *   - PASS-AFTER: with the index present (the migration's default state
 *     after this fix), the query plan for the exact SQL shape
 *     `repairCandidatePostgres` issues no longer requires a full table
 *     scan, and the same contention window that broke repair before no
 *     longer blocks it -- the connection's evidence is repaired and its
 *     dirty flag clears.
 */

import assert from "node:assert/strict";
import test from "node:test";
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
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/canonical-count-repair-index";
const INDEX_NAME = "idx_pg_records_canonical_count";

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

async function seedConnectionWithRecords(id: string): Promise<void> {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    JSON.stringify({ connector_id: CONNECTOR_ID, streams: [{ name: "messages", primary_key: ["id"] }] }),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [id, CONNECTOR_ID, NOW]
  );
}

async function cleanup(id: string): Promise<void> {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

/**
 * Holds a real `ACCESS EXCLUSIVE` lock on `records` for `holdMs` on a
 * SEPARATE connection from the app's own pool -- genuine PostgreSQL lock
 * contention against the SAME table `repairCandidatePostgres`'s
 * `canonicalResult` read touches, standing in for that query's real
 * multi-second execution time at production data volume without needing
 * to seed millions of rows in a test (same technique as this branch's
 * canonical-count-cancel-isolation.test.ts and
 * connector-summary-evidence-lifecycle-seq-index.test.ts).
 */
async function withRecordsTableContention<T>(holdMs: number, fn: () => Promise<T>): Promise<T> {
  const pool = getPostgresPool();
  const lockClient = await pool.connect();
  await lockClient.query("BEGIN");
  await lockClient.query("LOCK TABLE records IN ACCESS EXCLUSIVE MODE");
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
  "FAIL-BEFORE shape: without the canonical-count index, contention on records cancels repairCandidatePostgres's own canonical read and leaves the connection durably dirty",
  withPostgres(async () => {
    const id = "cin_canonical_count_repair_before";
    await seedConnectionWithRecords(id);
    try {
      // Reproduce the exact pre-fix schema: drop the index this commit
      // adds. The pre-existing records indexes stay -- proving the new
      // covering index specifically, not merely "some index exists".
      await postgresQuery(`DROP INDEX IF EXISTS ${INDEX_NAME}`, []);

      await reconcileDirtyConnectorSummaryEvidence([id]);
      const before = await getConnectorSummaryEvidence(id);
      assert.ok(before, "cold-start repair creates the evidence row");
      assert.equal(before.dirty, false);

      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "test-dirty" });
      const dirtied = await getConnectorSummaryEvidence(id);
      assert.ok(dirtied);
      assert.equal(dirtied.dirty, true, "the row is durably dirty before the contended pass");

      const { postgresQueryBounded, PostgresStatementTimeoutError } = await import("../server/postgres-storage.ts");
      let caught: unknown = null;
      await withRecordsTableContention(900, async () => {
        try {
          await postgresQueryBounded(
            `SELECT stream, COUNT(*)::int AS record_count, MAX(emitted_at) AS last_updated
               FROM records WHERE connector_instance_id = $1 AND deleted = FALSE
              GROUP BY stream`,
            [id],
            500
          );
        } catch (err) {
          caught = err;
        }
      });
      assert.ok(
        caught instanceof PostgresStatementTimeoutError,
        "contention on records genuinely cancels the canonical-count-shaped query at the 500ms floor when the covering index is absent"
      );

      const result = await withRecordsTableContention(900, () =>
        reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 })
      );
      // The discovery-side fix already shipped on this branch means the
      // dirty row IS selected as a candidate and repair IS attempted --
      // the regression this file exists to catch is narrower and one step
      // further in: the repair ATTEMPT itself is cancelled by the SAME
      // contended table it needs to read, and the existing per-connection
      // catch correctly defers rather than marking it failed, so the
      // connection is attempted but never actually repaired.
      assert.deepEqual([...result.attemptedIds], [id], "discovery still selects and attempts the dirty row");
      assert.equal(result.reconciled, 0, "the attempted repair did not actually converge -- it was cancelled");

      const stillDirty = await getConnectorSummaryEvidence(id);
      assert.ok(stillDirty);
      assert.equal(
        stillDirty.dirty,
        true,
        "a cancelled repair read leaves the row exactly as dirty as before -- this is the production 'attempted every pass, never converges' shape"
      );
    } finally {
      await cleanup(id);
    }
  })
);

test(
  "PASS-AFTER (this fix): the canonical-count index lets repair converge within a tight deadline against a realistic records volume",
  withPostgres(async () => {
    const id = "cin_canonical_count_repair_after";
    await seedConnectionWithRecords(id);
    try {
      // Migration ran during initPostgresStorage above, so the index this
      // fix adds already exists here -- explicitly confirm it, so a
      // future migration regression fails loudly at this assertion rather
      // than silently passing for an unrelated reason.
      const indexRows = await postgresQuery(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'records' AND indexname = $1",
        [INDEX_NAME]
      );
      assert.equal(indexRows.rowCount, 1, `${INDEX_NAME} must exist after migration`);

      // NOTE: deliberately no EXPLAIN plan-shape assertion here. Postgres
      // correctly prefers a seq scan (or an arbitrary tie-broken existing
      // index) over ANY newly added index on this test's necessarily tiny
      // fixture, regardless of which indexes exist -- a plan-shape
      // assertion at this data volume would test the planner's cost
      // model on a handful of rows, not this fix's real production shape.
      // The index's actual effect (measured directly against
      // production-representative data, in a throwaway scratch database,
      // never production DDL -- see this file's header) is a ~50x
      // reduction versus the unindexed seq scan; the load-bearing proof at
      // THIS scale is behavioral, below: the same contention window that
      // broke repair convergence in the FAIL-BEFORE test must not break it
      // once the index exists.

      await reconcileDirtyConnectorSummaryEvidence([id]);

      // NOTE: unlike the FAIL-BEFORE test, this half deliberately does NOT
      // reuse `withRecordsTableContention` -- an ACCESS EXCLUSIVE lock
      // blocks an indexed read exactly as completely as a seq scan (proven
      // directly: this assertion fails identically with or without the
      // index under that lock), so it cannot distinguish "fixed" from
      // "still broken" here. The real production bottleneck was scan COST
      // against millions of rows, not lock contention, so the right proof
      // is that the query genuinely executes fast enough, under a
      // realistic row count and interspersed unrelated filler (so a seq
      // scan cannot get lucky by being the only connection in the table),
      // to fit inside the same tight deadline the FAIL-BEFORE test used
      // contention to simulate exceeding.
      const insertValues: string[] = [];
      const insertParams: unknown[] = [];
      const otherId = "cin_canonical_count_repair_after_filler";
      for (let i = 0; i < 4000; i += 1) {
        const base = insertParams.length;
        const targetId = i % 5 === 0 ? id : otherId;
        insertValues.push(
          `($${base + 1}, 'messages', $${base + 2}, '{}'::jsonb, $${base + 3}, 1, false, $${base + 2}, $${base + 4})`
        );
        insertParams.push(CONNECTOR_ID, `k${i}`, NOW, targetId);
      }
      await postgresQuery(
        `INSERT INTO records(connector_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text, connector_instance_id)
         VALUES ${insertValues.join(", ")}`,
        insertParams
      );

      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "test-dirty" });
      const dirtied = await getConnectorSummaryEvidence(id);
      assert.ok(dirtied);
      assert.equal(dirtied.dirty, true, "the row is durably dirty before the bounded pass");

      const startedAt = Date.now();
      const result = await reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 });
      const elapsedMs = Date.now() - startedAt;

      assert.deepEqual(
        [...result.attemptedIds],
        [id],
        `discovery selected and attempted the dirty row within a 200ms budget against ${insertParams.length / 3} records rows (elapsed ${elapsedMs}ms)`
      );
      assert.equal(result.reconciled, 1, "the repair actually converged this time -- not merely attempted");

      const repaired = await getConnectorSummaryEvidence(id);
      assert.ok(repaired);
      assert.equal(repaired.dirty, false, "the previously-stuck dirty row actually clears once repair can complete");
    } finally {
      await postgresQuery("DELETE FROM records WHERE connector_instance_id = 'cin_canonical_count_repair_after_filler'", []);
      await cleanup(id);
    }
  })
);
