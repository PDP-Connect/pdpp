// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable, versioned receipt for Postgres data migrations that rewrite rows.
 *
 * WHY THIS EXISTS
 *
 * Before this table, `bootstrapPostgresSchema` had no notion of "this
 * migration already ran." Its only guard was table shape plus row presence,
 * so a data migration whose work was already applied still re-derived its
 * whole input set and re-issued its whole `UPDATE` fan-out on every boot.
 * On a populated deployment that turned into minutes of pre-listen index
 * scanning against multi-million-row projections, and a rolled-back
 * transaction left no progress boundary to resume from — the next boot
 * repeated the entire cost.
 *
 * A migration ledger row is the completion authority. It is deliberately NOT
 * derived from a row count or a "looks migrated" heuristic: guessing
 * completion from the data is exactly the failure mode this replaces, and a
 * guess that reads `complete` while a collision remains unresolved would
 * silently retire a fail-closed check. Only an explicit
 * `completePostgresMigration` call — reached after every collision check
 * passed and every batch committed — may write `complete`.
 *
 * SHAPE
 *
 * One row per migration id. `status` is the receipt; `cursor` is the durable
 * resume boundary. `lease_owner`/`lease_expires_at` are DIAGNOSTIC ONLY — an
 * operator-facing "who last ran this and until when did they expect to hold
 * it" breadcrumb, not a concurrency control. Nothing in this module reads
 * `lease_expires_at` to decide whether a claim is stale: `claimPostgresMigration`
 * re-claims any row whose `status` is not `complete` regardless of the lease
 * timestamp (see the "stale running receipt" test in
 * `postgres-boot-migration-resume.test.ts`, which seeds a lease expiring in
 * 2099 and asserts the re-claim still proceeds). The session-scoped
 * `pg_advisory_lock` taken by `bootstrapPostgresSchema` before any migration
 * runs is the sole mechanism that serializes concurrent boots; it is held for
 * the whole bootstrap and is released automatically if the holding
 * connection dies, so it needs no expiry of its own. A future caller must not
 * add a second gate that checks `lease_expires_at` against `now()` — that
 * would be a redundant fence that could disagree with the advisory lock and
 * silently reintroduce a second, weaker concurrency authority.
 * `changed_rows` accumulates the migration's own reported mutation count so
 * an operator can tell a real rewrite from a no-op pass without reading
 * `pg_stat_user_tables`.
 *
 * The ledger is provider-agnostic in intent but Postgres-specific in
 * implementation: SQLite's equivalent migration is a synchronous,
 * single-file, whole-database transaction whose cost profile the incident
 * does not apply to (see `server/db.ts`
 * `migrateLocalDeviceConnectorInstances`). The RI contract is the migration's
 * observable outcome — canonical identity, fail-closed collisions, retained
 * history — not this table's existence.
 */

import type { PoolClient } from "pg";

export const POSTGRES_MIGRATION_LEDGER_TABLE = "storage_migration_ledger";

/**
 * Stable id for the local-device connector canonicalization data migration.
 * Versioned so a future behavior change ships as a NEW id rather than
 * silently re-running under a receipt that attests to different semantics.
 */
export const LOCAL_DEVICE_CANONICALIZATION_MIGRATION_ID = "local_device_connector_canonicalization_v1";

export type PostgresMigrationStatus = "blocked" | "complete" | "pending" | "running";

export interface PostgresMigrationLedgerRow {
  readonly attemptCount: number;
  readonly changedRows: number;
  readonly cursor: string | null;
  readonly lastError: string | null;
  /** Diagnostic only — see the module docblock. Never read to gate a claim. */
  readonly leaseExpiresAt: string | null;
  /** Diagnostic only — see the module docblock. Never read to gate a claim. */
  readonly leaseOwner: string | null;
  readonly migrationId: string;
  readonly status: PostgresMigrationStatus;
}

interface LedgerQueryRow {
  attempt_count: number | string;
  changed_rows: number | string;
  cursor: string | null;
  last_error: string | null;
  lease_expires_at: string | null;
  lease_owner: string | null;
  migration_id: string;
  status: PostgresMigrationStatus;
}

function toRow(row: LedgerQueryRow): PostgresMigrationLedgerRow {
  return {
    attemptCount: Number(row.attempt_count),
    changedRows: Number(row.changed_rows),
    cursor: row.cursor,
    lastError: row.last_error,
    leaseExpiresAt: row.lease_expires_at,
    leaseOwner: row.lease_owner,
    migrationId: row.migration_id,
    status: row.status,
  };
}

/**
 * Install the ledger table. Must run BEFORE any data migration that consults
 * it, and is safe on a mixed-version cluster: an older runtime that does not
 * know the table simply ignores it, and a newer runtime that finds no row
 * treats the migration as `pending` — the conservative direction (it re-runs
 * a resumable, guarded migration) rather than falsely skipping work.
 */
export async function ensurePostgresMigrationLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${POSTGRES_MIGRATION_LEDGER_TABLE} (
      migration_id      TEXT PRIMARY KEY,
      status            TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'blocked')),
      -- Durable resume boundary. Its meaning belongs to the migration that
      -- writes it (for the local-device canonicalization it is the last
      -- fully-committed source_instance_id); the ledger only stores it.
      cursor            TEXT,
      -- Diagnostic breadcrumbs only (who last claimed this and when they
      -- expected to release it). Never read to decide whether a claim is
      -- stale; the session-scoped advisory lock in bootstrapPostgresSchema
      -- is the sole concurrency authority. See the module docblock.
      lease_owner       TEXT,
      lease_expires_at  TEXT,
      attempt_count     INTEGER NOT NULL DEFAULT 0,
      changed_rows      BIGINT NOT NULL DEFAULT 0,
      last_error        TEXT,
      started_at        TEXT,
      updated_at        TEXT NOT NULL,
      completed_at      TEXT
    );
  `);
}

export async function readPostgresMigrationLedgerRow(
  client: PoolClient,
  migrationId: string
): Promise<PostgresMigrationLedgerRow | null> {
  const result = await client.query<LedgerQueryRow>(
    `SELECT migration_id, status, cursor, lease_owner, lease_expires_at, attempt_count, changed_rows, last_error
       FROM ${POSTGRES_MIGRATION_LEDGER_TABLE}
      WHERE migration_id = $1`,
    [migrationId]
  );
  const [row] = result.rows;
  return row ? toRow(row) : null;
}

/**
 * Claim the migration for this process and mark it `running`.
 *
 * Returns `null` when the migration is already `complete` — the caller must
 * then skip its data phase entirely. That skip is the whole point of the
 * ledger, so it is expressed as an explicit absent-claim rather than a
 * boolean the caller could forget to branch on.
 *
 * A `blocked` row is also returned as a claim: a blocked migration is one a
 * previous attempt failed closed on, and re-attempting is correct (the
 * collision may have been reconciled by an operator since). The row's
 * `lastError` survives the reclaim so the failure is not erased by a retry.
 */
export async function claimPostgresMigration(
  client: PoolClient,
  migrationId: string,
  { leaseDurationMs, leaseOwner, nowIso }: { leaseDurationMs: number; leaseOwner: string; nowIso: string }
): Promise<PostgresMigrationLedgerRow | null> {
  const leaseExpiresAt = new Date(Date.parse(nowIso) + leaseDurationMs).toISOString();
  const result = await client.query<LedgerQueryRow>(
    `INSERT INTO ${POSTGRES_MIGRATION_LEDGER_TABLE}(
       migration_id, status, cursor, lease_owner, lease_expires_at, attempt_count, changed_rows, started_at, updated_at
     )
     VALUES ($1, 'running', NULL, $2, $3, 1, 0, $4, $4)
     ON CONFLICT (migration_id) DO UPDATE
       SET status = CASE WHEN ${POSTGRES_MIGRATION_LEDGER_TABLE}.status = 'complete' THEN 'complete' ELSE 'running' END,
           lease_owner = CASE WHEN ${POSTGRES_MIGRATION_LEDGER_TABLE}.status = 'complete'
                              THEN ${POSTGRES_MIGRATION_LEDGER_TABLE}.lease_owner ELSE EXCLUDED.lease_owner END,
           lease_expires_at = CASE WHEN ${POSTGRES_MIGRATION_LEDGER_TABLE}.status = 'complete'
                              THEN ${POSTGRES_MIGRATION_LEDGER_TABLE}.lease_expires_at ELSE EXCLUDED.lease_expires_at END,
           attempt_count = CASE WHEN ${POSTGRES_MIGRATION_LEDGER_TABLE}.status = 'complete'
                              THEN ${POSTGRES_MIGRATION_LEDGER_TABLE}.attempt_count
                              ELSE ${POSTGRES_MIGRATION_LEDGER_TABLE}.attempt_count + 1 END,
           updated_at = EXCLUDED.updated_at
     RETURNING migration_id, status, cursor, lease_owner, lease_expires_at, attempt_count, changed_rows, last_error`,
    [migrationId, leaseOwner, leaseExpiresAt, nowIso]
  );
  const row = toRow(result.rows[0] as LedgerQueryRow);
  return row.status === "complete" ? null : row;
}

/**
 * Advance the durable resume boundary. MUST be called on the same client and
 * inside the same transaction as the batch's data writes: a cursor that
 * commits separately from the work it describes is not a resume boundary, it
 * is a lie that skips a batch after a crash between the two commits.
 */
export async function advancePostgresMigrationCursor(
  client: PoolClient,
  migrationId: string,
  { changedRows, cursor, nowIso }: { changedRows: number; cursor: string; nowIso: string }
): Promise<void> {
  await client.query(
    `UPDATE ${POSTGRES_MIGRATION_LEDGER_TABLE}
        SET cursor = $2,
            changed_rows = changed_rows + $3,
            updated_at = $4
      WHERE migration_id = $1`,
    [migrationId, cursor, changedRows, nowIso]
  );
}

/**
 * Write the completion receipt. Callers must reach this only after every
 * batch committed and every fail-closed check passed; there is deliberately
 * no "complete if it looks done" path.
 */
export async function completePostgresMigration(
  client: PoolClient,
  migrationId: string,
  { nowIso }: { nowIso: string }
): Promise<void> {
  await client.query(
    `UPDATE ${POSTGRES_MIGRATION_LEDGER_TABLE}
        SET status = 'complete',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = NULL,
            completed_at = $2,
            updated_at = $2
      WHERE migration_id = $1`,
    [migrationId, nowIso]
  );
}

/**
 * Record a fail-closed stop. `blocked` is distinct from `pending` so an
 * operator can tell "never started" from "stopped on a collision that needs
 * manual reconciliation", and distinct from `complete` so no boot may treat
 * it as a skip.
 */
export async function blockPostgresMigration(
  client: PoolClient,
  migrationId: string,
  { error, nowIso }: { error: string; nowIso: string }
): Promise<void> {
  await client.query(
    `UPDATE ${POSTGRES_MIGRATION_LEDGER_TABLE}
        SET status = 'blocked',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = $2,
            updated_at = $3
      WHERE migration_id = $1`,
    [migrationId, error.slice(0, 4000), nowIso]
  );
}
