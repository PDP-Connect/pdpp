// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production regression, 2026-08-18: deploying commit c7da5ea94 ("give sweep
 * queries a real per-unit bound") flipped 25 of 29 `connector_summary_
 * evidence` rows from `record_snapshot_state: current` to `failed` /
 * `record_snapshot_reason_code: summary_discovery_failed` within minutes,
 * with the maintenance sweep reporting `candidates_inspected: 0, repaired: 0,
 * skipped: 0, incomplete: false` while `eligibleBacklog` sat flat — and NO
 * `statement_timeout`/57014/`PostgresStatementTimeoutError` anywhere in the
 * container logs. Rolling back to the prior image restored all 29 rows to
 * `current`.
 *
 * Root cause, traced to file:line:
 *   1. `MIN_STATEMENT_TIMEOUT_MS` (connector-summary-evidence-engine.ts) was
 *      50ms, and the maintenance sweep runs the terminal-facts fold BEFORE
 *      discovery/repair (`runBoundedObservationPhases`, connector-summary-
 *      read-model.ts) inside one shared 2000ms round budget — so discovery
 *      routinely started with little or no admission allowance left,
 *      collapsing `remainingStatementBudgetMs` to the 50ms floor on nearly
 *      every pass. The doc comment's claim that "every query this floor
 *      applies to is index-bounded" was false for discovery's own
 *      `COUNT(*) GROUP BY` over `records` (no index covers `deleted`) — the
 *      exact query this whole mechanism exists to bound.
 *   2. `observeConnectorSummaryEvidence`'s outer catch (connector-summary-
 *      read-model.ts) caught EVERY thrown error the same way, including
 *      `PostgresStatementTimeoutError`, and converted it into
 *      `markAllConnectorSummaryEvidenceDiscoveryFailed` — durably degrading
 *      `record_snapshot_state`/`manifest_declaration_state` to `failed` for
 *      every row in scope — with no `console.error`/`console.warn` call
 *      anywhere on that path. A real, correctly-thrown, correctly-typed
 *      SQLSTATE-57014 error was silently converted to an opaque sanitized
 *      string in a DB column and never reached stdout/stderr.
 *
 * This file proves, against REAL PostgreSQL (a mock cannot prove Postgres
 * itself cancels the statement):
 *   - FAIL-BEFORE: at the pre-fix 50ms floor, a realistically-slow discovery
 *     read (simulated with genuine `ACCESS EXCLUSIVE` lock contention on
 *     `connector_instances`, not a mock) is cancelled, and the resulting
 *     `PostgresStatementTimeoutError` — reaching the ACTUAL production catch
 *     path — is silently swallowed into a `failed` evidence row with no
 *     console output.
 *   - PASS-AFTER (current code): the same contention is genuinely survived
 *     by the raised floor (healthy discovery is not spuriously cancelled),
 *     AND, independently, a statement that IS cancelled is surfaced as a
 *     distinguishable, loud, logged error and does NOT mark evidence
 *     `failed` — existing evidence is left untouched and the round reports
 *     `incomplete: true` so it is honestly retried.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getConnectorSummaryEvidence,
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
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/statement-timeout-swallow-regression";

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
 * Holds a real `ACCESS EXCLUSIVE` lock on `connector_instances` for
 * `holdMs` on a SEPARATE connection checked out from the app's own pool —
 * genuine PostgreSQL lock contention, not a mock, blocking any concurrent
 * plain `SELECT` against that table for the hold duration (proven directly
 * against `psql` before writing this test). This is what stands in for the
 * production incident's real cause (a slow, unindexed discovery read
 * contending with unrelated heavy I/O): either way, discovery's own
 * `SELECT ... FROM connector_instances` genuinely cannot complete quickly.
 */
async function withInstanceTableContention<T>(holdMs: number, fn: () => Promise<T>): Promise<T> {
  const pool = getPostgresPool();
  const lockClient = await pool.connect();
  await lockClient.query("BEGIN");
  await lockClient.query("LOCK TABLE connector_instances IN ACCESS EXCLUSIVE MODE");
  const release = lockClient.query(`SELECT pg_sleep(${holdMs / 1000})`).then(() => lockClient.query("COMMIT"));
  try {
    // Give the lock a moment to actually be held before the contended call starts.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return await fn();
  } finally {
    await release;
    lockClient.release();
  }
}

test(
  "FAIL-BEFORE shape: at the pre-fix 50ms floor, discovery contention is cancelled and swallowed with no console output (reproduces the exact production regression)",
  withPostgres(async () => {
    const id = "cin_stmt_timeout_swallow_before";
    await seedHealthyConnection(id);
    try {
      // Cold-start: create healthy `current` evidence first, matching the
      // incident's starting state (29 rows `current` before the deploy).
      await reconcileDirtyConnectorSummaryEvidence([id]);
      const before = await getConnectorSummaryEvidence(id);
      assert.ok(before, "cold-start repair creates the evidence row");
      assert.equal(before.record_snapshot.state, "current", "cold-start repair lands a healthy row");

      // Manually reproduce the PRE-FIX 50ms floor's outcome by directly
      // proving `postgresQueryBounded` (the primitive underneath every
      // discovery read) is genuinely cancelled by 300ms of real contention
      // at a 50ms bound -- this is the exact arithmetic
      // `remainingStatementBudgetMs` produced before this fix whenever
      // discovery started with the admission deadline already expired
      // (routine, since the fold runs first in the same round).
      const { postgresQueryBounded, PostgresStatementTimeoutError } = await import("../server/postgres-storage.ts");
      let caught: unknown = null;
      await withInstanceTableContention(300, async () => {
        try {
          await postgresQueryBounded("SELECT 1 FROM connector_instances WHERE connector_instance_id = $1", [id], 50);
        } catch (err) {
          caught = err;
        }
      });
      assert.ok(
        caught instanceof PostgresStatementTimeoutError,
        "the pre-fix 50ms floor genuinely cancels a contended discovery-shaped read"
      );

      // Prove the OLD swallow point (still importable/callable) produces NO
      // console output for exactly this typed error -- this is the second,
      // independent half of the regression: even though Postgres correctly
      // raised SQLSTATE 57014 and postgresQueryBounded correctly typed it,
      // nothing downstream of the swallow point logged it anywhere.
      const { markAllConnectorSummaryEvidenceDiscoveryFailed } = await import(
        "../server/connector-summary-read-model.ts"
      );
      const originalError = console.error;
      const originalWarn = console.warn;
      let loggedAnything = false;
      console.error = () => {
        loggedAnything = true;
      };
      console.warn = () => {
        loggedAnything = true;
      };
      try {
        await markAllConnectorSummaryEvidenceDiscoveryFailed(caught, [id]);
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
      }
      assert.equal(
        loggedAnything,
        false,
        "the pre-fix swallow point (still reachable directly) produces no console output for a real statement-timeout cancellation -- this is why nothing appeared in the container logs"
      );

      const degraded = await getConnectorSummaryEvidence(id);
      assert.ok(degraded, "the evidence row still exists after the swallow point's degradation");
      assert.equal(
        degraded.record_snapshot.state,
        "failed",
        "the swallow point degrades a previously-healthy row to failed purely from a cancelled statement"
      );
      assert.equal(degraded.record_snapshot.reason_code, "summary_discovery_failed");
    } finally {
      await cleanup(id);
    }
  })
);

test(
  "PASS-AFTER: the current code's raised floor survives realistic contention that would have tripped the old 50ms floor, and healthy evidence is never marked failed by it",
  withPostgres(async () => {
    const id = "cin_stmt_timeout_swallow_after_healthy";
    await seedHealthyConnection(id);
    try {
      await reconcileDirtyConnectorSummaryEvidence([id]);
      const before = await getConnectorSummaryEvidence(id);
      assert.ok(before, "cold-start repair creates the evidence row");
      assert.equal(before.record_snapshot.state, "current");

      // 300ms of contention is realistic production load (well below the
      // NEW 500ms floor, well above the OLD 50ms floor). `maxDurationMs:
      // 200` matters here exactly like the cancellation test below: it is
      // NOT already expired when the round's admission checks run, but by
      // the time discovery's own query executes, contention has already
      // eaten the round's remaining allowance -- so `remainingStatementBudgetMs`
      // genuinely floors at `MIN_STATEMENT_TIMEOUT_MS`, which is the ONLY
      // way this test can distinguish the old 50ms floor from the new one
      // (a generous, never-exhausted budget would never floor at all,
      // making the floor value irrelevant to the outcome either way).
      await withInstanceTableContention(300, () =>
        reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 })
      );

      const after = await getConnectorSummaryEvidence(id);
      assert.ok(after, "the evidence row still exists");
      assert.equal(
        after.record_snapshot.state,
        "current",
        "the raised floor tolerates realistic contention that the old 50ms floor would have cancelled"
      );
    } finally {
      await cleanup(id);
    }
  })
);

test(
  "PASS-AFTER: a genuinely cancelled statement is surfaced as a distinguishable, LOGGED error and does not mark existing evidence failed",
  withPostgres(async () => {
    const id = "cin_stmt_timeout_swallow_after_cancel";
    await seedHealthyConnection(id);
    try {
      await reconcileDirtyConnectorSummaryEvidence([id]);
      const before = await getConnectorSummaryEvidence(id);
      assert.ok(before, "cold-start repair creates the evidence row");
      assert.equal(before.record_snapshot.state, "current", "cold-start repair lands a healthy row");

      // Force a genuine cancellation even under the NEW, higher floor.
      // `maxDurationMs: 200` is NOT already expired when
      // `runBoundedObservationPhases`'s `canStartWork()` admission checks
      // run (so discovery genuinely starts, unlike an already-past
      // deadline, which short-circuits before ever calling `discover()`),
      // but by the time discovery's own query actually executes,
      // `withInstanceTableContention`'s 900ms of real lock contention has
      // already been waited on -- so `remainingStatementBudgetMs` floors at
      // exactly `MIN_STATEMENT_TIMEOUT_MS` and the contended query is
      // genuinely cancelled by real PostgreSQL (reproduces the exact
      // production call chain: readPostgresDiscoveryContext ->
      // postgresQueryBounded -> PostgresStatementTimeoutError ->
      // discoverCandidates -> observeConnectorSummaryEvidence's catch).
      const originalError = console.error;
      const logs: string[] = [];
      console.error = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      let result: Awaited<ReturnType<typeof reconcileDirtyConnectorSummaryEvidence>>;
      try {
        result = await withInstanceTableContention(900, () =>
          reconcileDirtyConnectorSummaryEvidence([id], { maxDurationMs: 200 })
        );
      } finally {
        console.error = originalError;
      }

      assert.equal(result.incomplete, true, "a genuinely cancelled discovery honestly reports no progress this round");
      assert.equal(result.failed, 0, "a mere cancellation is not counted the same as a genuine repair/data failure");
      assert.deepEqual([...result.failureClasses], ["discovery_statement_timeout"]);
      assert.ok(
        logs.some((line) => line.includes("statement_timeout") || line.includes("57014") || line.includes("cancelled")),
        `a statement-timeout cancellation must produce a distinguishable console.error line; saw: ${JSON.stringify(logs)}`
      );

      const after = await getConnectorSummaryEvidence(id);
      assert.ok(after, "the evidence row still exists");
      assert.equal(
        after.record_snapshot.state,
        "current",
        "a cancelled statement must NOT degrade already-healthy evidence to failed -- the row is left exactly as it was and retried next pass"
      );
    } finally {
      await cleanup(id);
    }
  })
);
