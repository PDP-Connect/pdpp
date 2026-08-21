// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One test body, both backends.
 *
 * The run-lifecycle property tests MUST run against SQLite and PostgreSQL
 * from a single body. A backend-specific divergence is invisible to a
 * suite that only exercises one of them by construction, and this repo has
 * shipped that failure twice: `run_generation` reached SQLite without
 * PostgreSQL, and 6,792 tests stayed green while the deployed backend could
 * not paginate. The terminal-set divergence this program repairs is the same
 * shape — the SQLite-side and PostgreSQL-side declarations omitted DIFFERENT
 * members.
 *
 * So the driver interface here is deliberately thin: `changes` is the one
 * fact a compare-and-swap needs (`.changes` on better-sqlite3, `rowCount` on
 * pg), and normalizing it is what lets the invariant be stated once.
 *
 * The PostgreSQL lane is gated on PDPP_TEST_POSTGRES_URL and is reported as
 * SKIPPED rather than silently absent, because "ran on one backend" must be
 * distinguishable from "ran on both".
 */

import type { QueryResultRow } from "pg";
import { closeDb, getDb, initDb } from "../../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./dedicated-postgres-test-url.ts";

export interface RunLifecycleBackend {
  /** Run a statement, returning the number of rows it changed. */
  readonly exec: (sql: string, params: readonly unknown[]) => Promise<number>;
  readonly name: "sqlite" | "postgres";
  /** Read rows back for assertions. */
  readonly query: <T extends QueryResultRow>(sql: string, params?: readonly unknown[]) => Promise<T[]>;
  readonly teardown: () => Promise<void>;
}

interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => { changes: number };
}

interface SqliteHandle {
  prepare: (sql: string) => SqliteStatement;
}

export const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

export function createSqliteBackend(): Promise<RunLifecycleBackend> {
  initDb(":memory:");
  const raw = getDb() as unknown as SqliteHandle;
  return Promise.resolve({
    exec: (sql, params) => Promise.resolve(raw.prepare(sql).run(...params).changes),
    name: "sqlite",
    query: <T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) =>
      Promise.resolve(raw.prepare(sql).all(...params) as T[]),
    teardown: () => {
      closeDb();
      return Promise.resolve();
    },
  });
}

export async function createPostgresBackend(databaseUrl: string): Promise<RunLifecycleBackend> {
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  return {
    exec: async (sql, params) => {
      const result = await postgresQuery(sql, params as unknown[]);
      return result.rowCount ?? 0;
    },
    name: "postgres",
    query: async <T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
      const result = await postgresQuery<T>(sql, params as unknown[]);
      return result.rows;
    },
    teardown: () => closePostgresStorage(),
  };
}

/**
 * Insert a run row directly, so a test can place a run in any state without
 * driving the whole runtime. The point of these tests is the transition
 * predicate, not the executor's plumbing.
 */
export async function seedRun(
  backend: RunLifecycleBackend,
  run: {
    connectorId?: string;
    connectorInstanceId: string;
    ownerEpoch: string | null;
    runId: string;
    status: string;
  }
): Promise<void> {
  const connectorId = run.connectorId ?? "test_connector";
  const startedAt = "2026-08-21T00:00:00.000Z";
  const sql =
    backend.name === "postgres"
      ? `INSERT INTO run_history
           (run_id, connector_instance_id, connector_id, source_json, status, started_at, owner_epoch, records_emitted)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, 7)`
      : `INSERT INTO run_history
           (run_id, connector_instance_id, connector_id, source_json, status, started_at, owner_epoch, records_emitted)
         VALUES (?, ?, ?, '{}', ?, ?, ?, 7)`;
  await backend.exec(sql, [run.runId, run.connectorInstanceId, connectorId, run.status, startedAt, run.ownerEpoch]);
}

export async function readRun(
  backend: RunLifecycleBackend,
  runId: string,
  connectorInstanceId: string
): Promise<{ owner_epoch: string | null; records_emitted: number; status: string } | null> {
  const sql =
    backend.name === "postgres"
      ? "SELECT status, owner_epoch, records_emitted FROM run_history WHERE run_id = $1 AND connector_instance_id = $2"
      : "SELECT status, owner_epoch, records_emitted FROM run_history WHERE run_id = ? AND connector_instance_id = ?";
  const rows = await backend.query<{
    owner_epoch: string | null;
    records_emitted: number;
    status: string;
  }>(sql, [runId, connectorInstanceId]);
  return rows[0] ?? null;
}

/** Remove every run row, so cases within one backend do not leak into each other. */
export async function resetRuns(backend: RunLifecycleBackend): Promise<void> {
  await backend.exec("DELETE FROM run_history", []);
}
