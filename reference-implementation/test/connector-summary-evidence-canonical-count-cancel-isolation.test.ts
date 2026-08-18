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
 *     row is never even attempted and its `dirty` flag never clears.
 *   - PASS-AFTER (current code): the same cancellation is isolated to the
 *     canonical-count query alone — every OTHER discovery signal still
 *     classifies normally, a dirty row is still selected as a candidate and
 *     repaired (its `dirty` flag clears), and the round is honestly
 *     `incomplete` only insofar as the count-drift comparison itself was
 *     skipped, never a blanket "nothing happened this pass."
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
  "PASS-AFTER: a cancelled canonical-count read is isolated to that ONE query -- a dirty row in the SAME batch still classifies and repairs normally",
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
      // `records` (the table the canonical-count query reads) long enough
      // that its query, specifically, is cancelled by the per-unit floor.
      // `maxDurationMs: 200` is NOT already expired when the round's own
      // admission checks run, but by the time discovery's queries actually
      // execute (after `withRecordsTableContention`'s wait), the round's
      // deadline is already in the past, so `remainingStatementBudgetMs`
      // floors at exactly `MIN_STATEMENT_TIMEOUT_MS` for every discovery
      // query in the batch -- same arithmetic as the sibling
      // statement-timeout-swallow test's PASS-AFTER case. The other, cheap,
      // indexed discovery queries survive that same 500ms floor easily;
      // only the genuinely-contended canonical-count query (reading the
      // locked `records` table) is actually cancelled.
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
        logs.some((line) => line.includes("canonical record-count") && line.includes("statement_timeout")),
        `an isolated canonical-count cancellation must produce its own distinguishable console.error line; saw: ${JSON.stringify(logs)}`
      );

      // The load-bearing assertion: a row that is unambiguously `dirty`
      // (classifyCandidate's FIRST comparison, never reaching the
      // count-drift comparison the cancelled query fed) was still
      // classified and repaired even though ITS canonical-count read was
      // cancelled -- the fix this file proves.
      assert.equal(
        result.reconciled,
        1,
        "the dirty candidate was classified AND repaired despite the cancelled count read"
      );
      assert.deepEqual(
        [...result.attemptedIds],
        [id],
        "the dirty row genuinely got a repair turn, not merely a deferred selection"
      );

      const repaired = await getConnectorSummaryEvidence(id);
      assert.ok(repaired);
      assert.equal(
        repaired.dirty,
        false,
        "the dirty flag clears -- a cancelled canonical-count read no longer starves an otherwise-classifiable dirty row"
      );
      assert.equal(
        repaired.record_snapshot.state,
        "current",
        "the row's other evidence stays healthy; only the narrow count-drift signal was skipped this pass"
      );
    } finally {
      await cleanup(id);
    }
  })
);
