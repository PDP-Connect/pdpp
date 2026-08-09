// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scope-keyed (connector_instance_id, stream) dirty flag for lexical +
 * semantic derived index maintenance -- NEVER per-record, matching every
 * other dirty flag in this codebase (retained_size_stream,
 * connector_summary_evidence.dirty).
 *
 * `markSearchIndexDirtySqlite`/`markSearchIndexDirtyPostgres` are called
 * from INSIDE the same durable write transaction as the record mutation
 * that caused it (ingestSqliteRecord/postgresIngestRecord), because unlike
 * the best-effort post-commit connector-summary marker, a missed mark here
 * has no independent future re-trigger if this exact scope never receives
 * another write -- the same-transaction write is required, not optional.
 *
 * A dirty=1 row is a HINT to re-check, not proof of drift: the existing
 * exact-comparison drift-checks (search.ts's backfillLexicalStream,
 * search-semantic.ts's semanticBackfillIndexIsInSync, both already
 * idempotent no-ops when actually in sync) remain the source of truth.
 * `clearSearchIndexDirty` is called only after both checks report in-sync
 * for that scope.
 */

import { exec, execReturningOne, getOne, iterate, referenceQueries } from "../../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

interface SqlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface SearchIndexScopeKey {
  readonly connectorInstanceId: string;
  readonly stream: string;
}

export interface DirtySearchIndexScope extends SearchIndexScopeKey {
  readonly connectorId: string;
  readonly markedAt: string;
}

/** Call from inside the SAME SQLite `writeTransaction` as the record mutation. */
export function markSearchIndexDirtySqlite(
  key: SearchIndexScopeKey & { readonly connectorId: string },
  nowIso: string
): void {
  exec(referenceQueries.searchIndexDirtyMarkDirty, [key.connectorInstanceId, key.connectorId, key.stream, nowIso]);
}

/** Call from inside the SAME `withPostgresTransaction` client as the record mutation. */
export async function markSearchIndexDirtyPostgres(
  client: SqlClient,
  key: SearchIndexScopeKey & { readonly connectorId: string },
  nowIso: string
): Promise<void> {
  await client.query(
    `INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
       connector_id = excluded.connector_id, dirty = 1, marked_at = excluded.marked_at`,
    [key.connectorInstanceId, key.connectorId, key.stream, nowIso]
  );
}

/** Clears the flag after a reconcile proves this scope's lexical+semantic index is in sync. Idempotent. */
export async function clearSearchIndexDirty(key: SearchIndexScopeKey, nowIso: string): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `UPDATE search_index_dirty
       SET dirty = 0, reconciled_at = $3, last_error = NULL, attempts = 0, next_attempt_at = NULL
       WHERE connector_instance_id = $1 AND stream = $2`,
      [key.connectorInstanceId, key.stream, nowIso]
    );
    return;
  }
  exec(referenceQueries.searchIndexDirtyClear, [nowIso, key.connectorInstanceId, key.stream]);
}

// Starvation-avoidance backoff schedule (I5/review): each successive
// failure pushes next_attempt_at further out, capped so a scope is never
// starved for longer than ~10 minutes between retries. Deliberately small
// multipliers (not a full exponential-to-hours curve) because this backlog
// is expected to be tiny in steady state (a crash/restart edge case, not
// routine traffic) -- the goal is "a permanently-broken scope stops eating
// every page's front slot," not "minimize retry cost of a large backlog."
const BACKOFF_SCHEDULE_MS = [0, 5000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

function backoffDelayMsForAttempt(attempts: number): number {
  const index = Math.min(Math.max(attempts, 0), BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[index] ?? BACKOFF_SCHEDULE_MS.at(-1) ?? 600_000;
}

/**
 * Records a reconcile failure for this scope: dirty stays 1, structured
 * evidence for observability (I6), and attempts/next_attempt_at advance so
 * a repeatedly-failing scope backs off instead of permanently occupying
 * the oldest-first queue's front slot (see listDirtySearchIndexScopes).
 */
export async function recordSearchIndexDirtyFailure(key: SearchIndexScopeKey, error: string): Promise<void> {
  if (isPostgresStorageBackend()) {
    const { rows } = await postgresQuery<{ attempts: number }>(
      `UPDATE search_index_dirty
       SET last_error = $3, attempts = attempts + 1
       WHERE connector_instance_id = $1 AND stream = $2
       RETURNING attempts`,
      [key.connectorInstanceId, key.stream, error]
    );
    const attempts = rows[0]?.attempts;
    if (typeof attempts !== "number") {
      return;
    }
    const nextAttemptAt = new Date(Date.now() + backoffDelayMsForAttempt(attempts)).toISOString();
    await postgresQuery(
      "UPDATE search_index_dirty SET next_attempt_at = $3 WHERE connector_instance_id = $1 AND stream = $2",
      [key.connectorInstanceId, key.stream, nextAttemptAt]
    );
    return;
  }
  const row = execReturningOne<{ attempts: number }>(referenceQueries.searchIndexDirtyRecordFailure, [
    error,
    key.connectorInstanceId,
    key.stream,
  ]);
  const nextAttemptAt = new Date(Date.now() + backoffDelayMsForAttempt(row.attempts)).toISOString();
  exec(referenceQueries.searchIndexDirtySetNextAttempt, [nextAttemptAt, key.connectorInstanceId, key.stream]);
}

export async function isSearchIndexScopeDirty(key: SearchIndexScopeKey): Promise<boolean> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<{ dirty: number }>(
      "SELECT dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [key.connectorInstanceId, key.stream]
    );
    return Boolean(result.rows[0]?.dirty);
  }
  const row = getOne<{ dirty: number }>(referenceQueries.searchIndexDirtyGetByScope, [
    key.connectorInstanceId,
    key.stream,
  ]);
  return Boolean(row?.dirty);
}

/**
 * Oldest-first page of currently-dirty AND currently-eligible scopes,
 * bounded by `limit`. "Eligible" excludes a scope still serving out its
 * post-failure backoff (next_attempt_at in the future) -- without this
 * exclusion, a scope that fails every reconcile attempt would occupy the
 * front of this oldest-first ordering forever (failure never advances
 * marked_at), permanently starving every healthy scope behind it out of
 * every page. Re-queried fresh every sweep round.
 */
export async function listDirtySearchIndexScopes(limit: number): Promise<DirtySearchIndexScope[]> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<{
      connector_id: string;
      connector_instance_id: string;
      marked_at: string;
      stream: string;
    }>(
      `SELECT connector_instance_id, connector_id, stream, marked_at
       FROM search_index_dirty
       WHERE dirty <> 0
         AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
       ORDER BY marked_at ASC, connector_instance_id ASC, stream ASC
       LIMIT $1`,
      [limit, new Date().toISOString()]
    );
    return result.rows.map((row) => ({
      connectorId: row.connector_id,
      connectorInstanceId: row.connector_instance_id,
      markedAt: row.marked_at,
      stream: row.stream,
    }));
  }
  const scopes: DirtySearchIndexScope[] = [];
  for (const row of iterate<{
    connector_id: string;
    connector_instance_id: string;
    marked_at: string;
    stream: string;
  }>(referenceQueries.searchIndexDirtyListDirty, [new Date().toISOString()])) {
    scopes.push({
      connectorId: row.connector_id,
      connectorInstanceId: row.connector_instance_id,
      markedAt: row.marked_at,
      stream: row.stream,
    });
    if (scopes.length >= limit) {
      break;
    }
  }
  return scopes;
}

export async function countDirtySearchIndexScopes(): Promise<number> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<{ n: string | number }>(
      "SELECT COUNT(*)::text AS n FROM search_index_dirty WHERE dirty <> 0"
    );
    return Number(result.rows[0]?.n ?? 0);
  }
  const row = getOne<{ n: number }>(referenceQueries.searchIndexDirtyCountDirty, []);
  return row?.n ?? 0;
}
