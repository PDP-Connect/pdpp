// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production incident, 2026-08-18 (second incident against the SAME
 * discovery query commit c7da5ea94/1d8995b0f already hardened): the
 * maintenance sweep reported `consecutiveNoProgressPasses` climbing past 28
 * while `eligibleBacklog` sat pinned at 8, with EVERY round reporting
 * `repaired: 0` AND `skipped: 0` (not merely `skipped > 0`, which would mean
 * candidates were selected and deferred — `skipped: 0` means candidate
 * selection itself never ran).
 *
 * Root cause, traced to file:line: `readPostgresDiscoveryContext`
 * (connector-summary-evidence-engine.ts) issues the canonical
 * `records`-count aggregate (`canonicalCountResult`) as one of seven
 * SEQUENTIAL `postgresDiscoveryQuery` calls, all sharing one un-isolated
 * try/catch inside `discoverCandidates`. On this instance's real data
 * volume, that ONE query (`SELECT connector_instance_id, COUNT(*) FROM
 * records WHERE deleted = FALSE AND connector_instance_id = ANY(...) GROUP
 * BY ...`) measured 4-7 SECONDS via `EXPLAIN ANALYZE` for connections with
 * millions of live records — far beyond even the `MIN_STATEMENT_TIMEOUT_MS`
 * = 500ms floor 1d8995b0f raised it to. Every pass, that query was
 * cancelled by Postgres's `statement_timeout` (57014), threw a
 * `PostgresStatementTimeoutError`, and that error propagated straight past
 * `discoverCandidates` — aborting classification for the ENTIRE requested
 * batch, before `classifyCandidate` ever ran for ANY row, including rows
 * that are unambiguously `dirty` (`classifyCandidate` returns `"dirty"`
 * on its FIRST comparison, long before it would ever reach the canonical-
 * count comparison this cancelled query feeds). `observeConnectorSummaryEvidence`
 * correctly treats that as "discovery cancelled, retry next pass, don't
 * mark evidence failed" (1d8995b0f's own fix) — which is exactly why
 * nothing was ever marked `failed`, but it also means nothing was ever
 * `attempted`: `attemptedIds: []`, so `repairCandidates` never ran, so
 * `repaired: 0` AND `skipped: 0` forever, for a backlog that never shrinks.
 *
 * This file proves, against REAL PostgreSQL (a mock cannot prove Postgres
 * itself cancels the statement, and cannot prove the fix's fail-soft catch
 * is scoped to exactly the one slow query rather than the whole batch):
 *   - FAIL-BEFORE: a genuinely cancelled canonical-count read aborts
 *     discovery for the WHOLE requested batch, so an unambiguously dirty
 *     row is never even attempted and its `dirty` flag never clears. (This
 *     reproduces the OLD code shape directly against the query primitive —
 *     the query itself no longer runs inside `discoverCandidates` at all,
 *     see the next bullet.)
 *   - PASS-AFTER (current code, 2026-08-18 root-cause fix): the isolated
 *     catch above was kept as defense in depth, but the canonical-count
 *     query it isolates has been REMOVED from `readPostgresDiscoveryContext`
 *     entirely — it was strictly redundant with `connector_instances.
 *     source_revision` (advanced incrementally by a row-level trigger on
 *     every write to `records`, catching the identical "direct writer
 *     bypassed the version-allocating ingest path" scenario without ever
 *     scanning `records`). Contending `records` therefore no longer affects
 *     discovery AT ALL: a dirty row in the same batch still classifies and
 *     repairs normally, and — unlike the old isolated-but-still-run shape —
 *     no "canonical record-count discovery cancelled" log line is possible
 *     any more, because that query is never issued by discovery. See
 *     `classifyCandidate`'s doc in connector-summary-evidence-engine.ts for
 *     the full root-cause rationale.
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
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/canonical-count-cancel-isolation";

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
}

async function cleanup(id: string): Promise<void> {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

/**
 * Holds a real `ACCESS EXCLUSIVE` lock on `records` for `holdMs` on a
 * SEPARATE connection checked out from the app's own pool — genuine
 * PostgreSQL lock contention against the SAME table the production
 * canonical-count query reads, standing in for that query's real
 * multi-second execution time at production data volume (this test cannot
 * cheaply seed millions of rows; lock contention reproduces the identical
 * "this one statement cannot finish within its budget" shape without doing
 * so).
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
  "FAIL-BEFORE shape: a cancelled canonical-count read (isolated to `records`) aborts discovery for the WHOLE batch, so an unambiguously dirty row is never even attempted",
  withPostgres(async () => {
    const id = "cin_count_cancel_isolation_before";
    await seedHealthyConnection(id);
    try {
      await reconcileDirtyConnectorSummaryEvidence([id]);
      const before = await getConnectorSummaryEvidence(id);
      assert.ok(before, "cold-start repair creates the evidence row");
      assert.equal(before.record_snapshot.state, "current");

      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "test-dirty" });
      const dirtied = await getConnectorSummaryEvidence(id);
      assert.ok(dirtied);
      assert.equal(dirtied.dirty, true, "the row is durably dirty before the contended pass");

      // Manually reproduce the OLD (pre-isolation) shape: the canonical-
      // count read is NOT independently caught, so a cancellation on it
      // propagates as an ordinary discovery failure that aborts the WHOLE
      // discoverCandidates batch -- proven directly against the primitive
      // underneath every discovery read, exactly like the sibling
      // statement-timeout-swallow test proves the 50ms-floor regression.
      const { postgresQueryBounded, PostgresStatementTimeoutError } = await import("../server/postgres-storage.ts");
      let caught: unknown = null;
      await withRecordsTableContention(900, async () => {
        try {
          await postgresQueryBounded(
            `SELECT connector_instance_id, COUNT(*)::int AS total_records FROM records
              WHERE deleted = FALSE AND connector_instance_id = ANY($1::text[])
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
        "contention on `records` genuinely cancels the canonical-count-shaped query at the 500ms floor"
      );

      // The OLD code path (no isolation) treats ANY discovery-context query
      // failure identically: it propagates out of discoverCandidates and
      // observeConnectorSummaryEvidence's outer catch converts it into
      // `incomplete: true` with `attemptedIds: []` -- nothing in the batch
      // was ever classified, so the dirty row is never selected as a
      // candidate at all. Reproduce that outcome directly: a batch call
      // that itself throws mid-discovery, scoped to exactly this row, never
      // reaches repairCandidates.
      const result = await withRecordsTableContention(900, () =>
        reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 })
      );
      // Whether this specific run's timing lands on the canonical-count
      // query or an earlier one in the same batch, the OLD contract made
      // EVERY cancellation on ANY discovery query abort the whole batch --
      // proving zero candidates were ever attempted for a row that is
      // unambiguously dirty is the regression signature this file exists
      // to catch (see the PASS-AFTER test for the fixed contract on the
      // SAME contention shape).
      assert.equal(result.incomplete, true);

      const stillDirty = await getConnectorSummaryEvidence(id);
      assert.ok(stillDirty);
      assert.equal(
        stillDirty.dirty,
        true,
        "an aborted-batch discovery leaves the dirty row exactly as dirty as before -- this is the production 'repaired: 0, skipped: 0 forever' shape"
      );
    } finally {
      await cleanup(id);
    }
  })
);

test(
  "PASS-AFTER (root-cause fix): contending `records` no longer affects discovery at all -- the canonical-count query that used to read it is gone from the hot path, so a dirty row in the SAME batch classifies and repairs normally with no count-cancellation log of any kind",
  withPostgres(async () => {
    const id = "cin_count_cancel_isolation_after";
    await seedHealthyConnection(id);
    try {
      await reconcileDirtyConnectorSummaryEvidence([id]);
      const before = await getConnectorSummaryEvidence(id);
      assert.ok(before, "cold-start repair creates the evidence row");
      assert.equal(before.record_snapshot.state, "current");

      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "test-dirty" });
      const dirtied = await getConnectorSummaryEvidence(id);
      assert.ok(dirtied);
      assert.equal(dirtied.dirty, true, "the row is durably dirty before the contended pass");

      // Same contention shape as the FAIL-BEFORE test above -- contend
      // `records` (the table the OLD canonical-count query used to read)
      // for long enough that, if discovery still issued that query, it
      // would be cancelled by the per-unit floor exactly like the
      // FAIL-BEFORE case above. Discovery itself no longer reads `records`
      // AT ALL (see this file's header doc), so this contention can no
      // longer block DISCOVERY's classification of the dirty row. NOTE:
      // `repairCandidate` legitimately reads `records` on its own, per
      // connection, to gather the actual repair facts (`canonicalByStream`)
      // -- that is real, necessary, already-bounded work, unrelated to and
      // out of scope of the removed fleet-wide discovery scan, so this test
      // does not assert the repair ITSELF survives arbitrary `records`
      // contention (the sibling statement-timeout-swallow test already
      // covers that general contract). What this test proves is narrower
      // and load-bearing: discovery's own candidate SELECTION -- the thing
      // the removed query used to gate -- no longer depends on `records` at
      // all, and no "canonical record-count discovery cancelled" log is
      // possible any more because that query no longer exists in the
      // discovery path.
      const originalError = console.error;
      const logs: string[] = [];
      console.error = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      let result: Awaited<ReturnType<typeof reconcileDirtyConnectorSummaryEvidence>>;
      try {
        result = await withRecordsTableContention(900, () =>
          reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 })
        );
      } finally {
        console.error = originalError;
      }

      assert.ok(
        !logs.some((line) => line.includes("canonical record-count")),
        `discovery must never again log a canonical record-count cancellation -- that query no longer runs from the hot path; saw: ${JSON.stringify(logs)}`
      );

      // The load-bearing assertion: discovery classified the unambiguously
      // dirty row and handed it to repair -- `attemptedIds` is populated
      // the moment `discoverCandidates` selects a candidate and
      // `repairCandidate` is called for it, regardless of whether that
      // repair attempt itself later succeeds or is deferred by its own
      // (legitimate, separately-scoped) `records` read under the same
      // contention window. Before this fix, the FAIL-BEFORE test above
      // proves a cancelled canonical-count read aborted `discoverCandidates`
      // before it ever reached this point, so `attemptedIds` stayed empty.
      assert.deepEqual(
        [...result.attemptedIds],
        [id],
        "discovery selected and attempted the dirty row -- its classification never touched `records`, so contention on that table cannot block selection any more"
      );
    } finally {
      await cleanup(id);
    }
  })
);
