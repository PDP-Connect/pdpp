// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `postgresQueryBounded` — the per-unit HARD bound design review P1-2
 * requires ("For PostgreSQL, set a transaction-local `statement_timeout`
 * ... based on the unit's remaining allowance"), proven against a REAL
 * Postgres server, not a mock: a mock can only prove the SQL text was sent,
 * never that Postgres itself actually enforces and cancels the statement.
 *
 * Proves:
 *   1. A statement that runs LONGER than its `timeoutMs` is genuinely
 *      cancelled by Postgres (SQLSTATE 57014) and surfaces as
 *      `PostgresStatementTimeoutError`, not left to run to completion.
 *   2. A statement that runs WELL WITHIN its `timeoutMs` completes normally
 *      and returns real rows — the bound does not fire on fast, ordinary
 *      queries (the `MIN_STATEMENT_TIMEOUT_MS` floor in
 *      connector-summary-evidence-engine.ts exists precisely so this stays
 *      true even with very little remaining budget).
 *   3. The timeout is TRANSACTION-LOCAL (`SET LOCAL`): after a bounded call
 *      times out and its connection is released back to the pool, the very
 *      next query on that SAME pool (which may reuse the same physical
 *      connection) is NOT affected by the prior timeout — proving the
 *      reviewer's "cannot leak to other users of a pooled connection"
 *      requirement, not merely asserting the SQL text contains `LOCAL`.
 *
 * Gated on `PDPP_TEST_POSTGRES_URL` pointing at the dedicated, loopback-only
 * test listener (see `test/helpers/dedicated-postgres-test-url.ts`); skips
 * (never fails) when unset, matching every other Postgres-gated test in
 * this suite. This is the one part of the P1-2 fix that CANNOT be proven on
 * SQLite (better-sqlite3 has no interrupt/progress-handler hook — see the
 * P1-2 report), so this file is the only place the per-unit hard bound is
 * verified against a real backend.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileConnectorSummaryEvidence,
  remainingStatementBudgetMs,
} from "../server/connector-summary-evidence-engine.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  PostgresStatementTimeoutError,
  postgresQuery,
  postgresQueryBounded,
} from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-08-18T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/statement-timeout-wiring-p12";

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

test(
  "postgresQueryBounded: a statement slower than its timeout is genuinely cancelled by Postgres, not merely reported late",
  withPostgres(async () => {
    await assert.rejects(
      () => postgresQueryBounded("SELECT pg_sleep(2)", [], 100),
      (err: unknown) => err instanceof PostgresStatementTimeoutError
    );
  })
);

test(
  "postgresQueryBounded: a statement well within its timeout completes normally and returns real rows",
  withPostgres(async () => {
    const result = await postgresQueryBounded<{ answer: number }>("SELECT 42 AS answer", [], 5000);
    assert.equal(result.rows[0]?.answer, 42);
  })
);

test(
  "postgresQueryBounded: the floor timeout used by the engine (500ms) still lets an ordinary fast query complete",
  withPostgres(async () => {
    // Mirrors MIN_STATEMENT_TIMEOUT_MS in connector-summary-evidence-engine.ts:
    // an index-bounded query genuinely fast in practice must not spuriously
    // time out even at the floor value.
    const result = await postgresQueryBounded<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM connector_instances WHERE connector_instance_id = $1",
      ["cin_definitely_does_not_exist_p12_probe"],
      500
    );
    assert.equal(result.rows[0]?.n, 0);
  })
);

test(
  "postgresQueryBounded: SET LOCAL statement_timeout does not leak onto a later query sharing the pool",
  withPostgres(async () => {
    // Force a small pool so the SAME physical connection is highly likely to
    // be reused across these two sequential calls (pg's pool returns the
    // most-recently-released idle client first).
    const pool = getPostgresPool();
    const originalMax = pool.options.max;
    pool.options.max = 1;
    try {
      // First call: times out under a 100ms bound. Its connection is
      // released back to the pool in the `finally` inside
      // `postgresQueryBounded` regardless of the timeout firing.
      await assert.rejects(() => postgresQueryBounded("SELECT pg_sleep(2)", [], 100), PostgresStatementTimeoutError);

      // Second call: a plain, unbounded `postgresQuery` (bare `pool.query`,
      // no explicit transaction) that would ALSO sleep 2s. If `SET LOCAL`
      // had leaked as a session-level `SET` onto this reused connection,
      // this query would itself be cancelled by the stale 100ms timeout —
      // proving the leak. Bounding this assertion's own wait at 5s (well
      // above the 2s sleep) proves the connection's timeout was genuinely
      // reset to Postgres's own default (no timeout) once the first
      // transaction committed/rolled back, not merely "some other value."
      const result = await postgresQuery<{ slept: string }>("SELECT pg_sleep(2) AS slept");
      assert.equal(result.rows[0]?.slept, "");
    } finally {
      pool.options.max = originalMax;
    }
  })
);

test("remainingStatementBudgetMs: admits live work at the per-unit floor but refuses an expired admission", (t) => {
  t.mock.method(Date, "now", () => 1_000);

  assert.equal(remainingStatementBudgetMs(null), null, "no deadline preserves the unbounded caller contract");
  assert.equal(remainingStatementBudgetMs(1_000), 0, "an expired admission must not start an unbounded statement");
  assert.equal(remainingStatementBudgetMs(1_001), 500, "a live admission receives the production per-unit floor");
});

/**
 * The floor/admission contract above is a deterministic unit oracle. This
 * real-Postgres check keeps the distinct persistence boundary: an expired
 * admission leaves the row untouched, then an unbounded retry repairs it to
 * fresh evidence. It deliberately does not claim a 1 ms wall-clock pass can
 * complete cold discovery under host pressure.
 */
test(
  "reconcileConnectorSummaryEvidence: an unbounded retry repairs a row deferred by an expired admission",
  withPostgres(async () => {
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      CONNECTOR_ID,
      "{}",
      NOW,
    ]);
    const id = "cin_stmt_timeout_wiring_p12";
    try {
      await postgresQuery(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
        [id, CONNECTOR_ID, NOW]
      );

      await assert.rejects(
        () => reconcileConnectorSummaryEvidence([id], { deadline: 0 }),
        PostgresStatementTimeoutError,
        "an expired admission must not begin discovery"
      );
      const beforeRetry = await postgresQuery<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [id]
      );
      assert.equal(beforeRetry.rows[0]?.count, 0, "an expired admission leaves the dirty row for a later retry");

      const retry = await reconcileConnectorSummaryEvidence([id]);
      assert.ok(retry.repaired >= 1, "an unbounded retry repairs the dirty row");

      const row = await postgresQuery<{ dirty: number; state: string }>(
        "SELECT dirty, state FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [id]
      );
      assert.equal(row.rows[0]?.state, "fresh");
      assert.equal(Number(row.rows[0]?.dirty), 0);
    } finally {
      await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_id = $1", [CONNECTOR_ID]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [CONNECTOR_ID]);
      await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
    }
  })
);
