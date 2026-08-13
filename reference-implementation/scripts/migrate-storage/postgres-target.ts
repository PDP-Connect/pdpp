/**
 * Postgres target for storage migration.
 *
 * Connects to a Postgres database, bootstraps the PDPP schema,
 * and provides batch insert + verification primitives.
 *
 * Reuses the canonical schema bootstrap from ../../server/postgres-storage.js
 */

import type { Pool as PgPool, PoolClient } from "pg";
import { Pool } from "pg";
import { closePostgresStorage, getPostgresPool, initPostgresStorage } from "../../server/postgres-storage.ts";
import type { RawValue } from "./transformers.ts";

type SqlValue = RawValue;
type SqlRow = Record<string, SqlValue>;

export function currentTargetPool(): PgPool {
  return getPostgresPool();
}

const ALL_TABLE_NAMES = [
  "connectors",
  "oauth_clients",
  "grants",
  "tokens",
  "pending_consents",
  "owner_device_auth",
  "device_exporters",
  "device_ingest_credentials",
  "device_enrollment_codes",
  "device_source_instances",
  "device_ingest_batch_outcomes",
  "source_webhook_events",
  "source_webhook_run_receipts",
  "connector_state",
  "grant_connector_state",
  "connector_schedules",
  "controller_active_runs",
  "run_history",
  "scheduler_last_run_times",
  "records",
  "record_changes",
  "version_counter",
  "blobs",
  "blob_bindings",
  "spine_events",
  "lexical_search_index",
  "lexical_search_snapshots",
  "lexical_search_meta",
  "semantic_search_blob",
  "semantic_search_snapshots",
  "semantic_search_meta",
  "semantic_search_backfill_progress",
];

/**
 * Opens a Postgres connection pool.
 * @param {string} databaseUrl - Connection string
 * @returns {Promise<{pool: Pool, close: () => Promise<void>}>}
 */
export function openPostgresTarget(databaseUrl: string): { pool: PgPool; close: () => Promise<void> } {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    close: async () => {
      await pool.end();
    },
    pool,
  };
}

/**
 * Bootstraps the canonical PDPP schema.
 *
 * Strategy: call initPostgresStorage() from postgres-storage.js, which:
 * 1. Creates the module-level pool
 * 2. Calls bootstrapPostgresSchema() (idempotent, CREATE TABLE IF NOT EXISTS)
 * 3. Runs optional migrations
 *
 * After this returns, getPostgresPool() is safe to call.
 *
 * @param {string} databaseUrl - Connection string
 * @returns {Promise<void>}
 */
export async function bootstrapTargetSchema(databaseUrl: string): Promise<void> {
  await initPostgresStorage({
    backend: "postgres",
    databaseUrl,
  });
}

/**
 * Closes the schema bootstrap and the module-level pool.
 * Call this after you're done with the target.
 *
 * @returns {Promise<void>}
 */
export async function closeTargetSchema() {
  await closePostgresStorage();
}

/**
 * Returns the row count for a table.
 * @param {Pool} pool - Postgres pool
 * @param {string} tableName - Table name (will be quoted)
 * @returns {Promise<number>}
 */
export async function tableRowCount(pool: PgPool, tableName: string): Promise<number> {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM "${tableName}"`);
  return result.rows[0]?.count ?? 0;
}

/**
 * Returns true iff every table is empty.
 * @param {Pool} pool - Postgres pool
 * @param {string[]} [tableNames] - Defaults to ALL_TABLE_NAMES
 * @returns {Promise<boolean>}
 */
export function isTargetEmpty(pool: PgPool, tableNames: readonly string[] = ALL_TABLE_NAMES): Promise<boolean> {
  async function checkAt(index: number): Promise<boolean> {
    const tableName = tableNames[index];
    if (!tableName) {
      return true;
    }
    if ((await tableRowCount(pool, tableName)) > 0) {
      return false;
    }
    return checkAt(index + 1);
  }
  return checkAt(0);
}

/**
 * Single-statement multi-row INSERT.
 *
 * Generates: INSERT INTO "<t>" ("<c1>", "<c2>", ...) VALUES ($1,$2,...), ($N+1,...), ...
 *
 * Each row must be a tuple in columnNames order.
 * No type coercion — caller's transformer must produce values acceptable to node-postgres
 * (Date, string, number, Buffer, boolean, null, plain objects for JSONB).
 *
 * @param {object} client - Postgres client (from pool.connect() or transaction context)
 * @param {string} tableName - Table name
 * @param {string[]} columnNames - Column names in order
 * @param rows - Array of value tuples
 * @returns {Promise<number>} - Rows inserted
 */
export async function insertBatch(
  client: PoolClient,
  tableName: string,
  columnNames: readonly string[],
  rows: readonly (readonly SqlValue[])[]
): Promise<number> {
  if (!rows.length) {
    return 0;
  }

  const quotedTable = `"${tableName}"`;
  const quotedCols = columnNames.map((c) => `"${c}"`).join(", ");

  let paramIndex = 1;
  const valueClauses: string[] = [];
  const values: SqlValue[] = [];

  for (const row of rows) {
    const placeholders: string[] = [];
    for (const val of row) {
      values.push(val);
      placeholders.push(`$${paramIndex}`);
      paramIndex += 1;
    }
    valueClauses.push(`(${placeholders.join(", ")})`);
  }

  const sql = `INSERT INTO ${quotedTable} (${quotedCols}) VALUES ${valueClauses.join(", ")}`;
  const result = await client.query(sql, values);
  return result.rowCount ?? 0;
}

/**
 * Transaction wrapper.
 *
 * Opens a client, BEGIN, calls fn(client), COMMIT, releases.
 * On throw, automatically rolls back.
 *
 * Re-exports withPostgresTransaction from postgres-storage.js
 * but for use with an explicit pool.
 *
 * @param {Pool} pool - Postgres pool
 * @param {(client: object) => Promise<T>} fn - Callback
 * @returns {Promise<T>}
 */
export async function withTx<T>(pool: PgPool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback errors must not hide the original transaction error.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Samples up to `limit` rows from a table for fingerprinting/comparison.
 *
 * Returns rows ordered by primaryKey (or by ctid if pk is null),
 * each row as a JSON-stable string suitable for cross-side comparison.
 *
 * @param {Pool} pool - Postgres pool
 * @param {string} tableName - Table name
 * @param {string|null} primaryKey - Column name to order by (e.g., 'id'), or null for ctid
 * @param {number} [limit=8] - Max rows to return
 * @returns {Promise<string[]>} - Array of JSON-stringified rows
 */
export async function sampleRowFingerprint(
  pool: PgPool,
  tableName: string,
  primaryKey: string | null,
  limit = 8
): Promise<string[]> {
  const quotedTable = `"${tableName}"`;
  const orderBy = primaryKey ? `"${primaryKey}"` : "ctid";
  const sql = `SELECT * FROM ${quotedTable} ORDER BY ${orderBy} ASC LIMIT $1`;

  const result = await pool.query(sql, [limit]);
  return result.rows.map((row: SqlRow) => JSON.stringify(row, Object.keys(row).sort()));
}
