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

import { exec, getOne, iterate, referenceQueries } from "../../lib/db.ts";
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
      `UPDATE search_index_dirty SET dirty = 0, reconciled_at = $3, last_error = NULL
       WHERE connector_instance_id = $1 AND stream = $2`,
      [key.connectorInstanceId, key.stream, nowIso]
    );
    return;
  }
  exec(referenceQueries.searchIndexDirtyClear, [nowIso, key.connectorInstanceId, key.stream]);
}

/** Records a reconcile failure for this scope: dirty stays 1, structured evidence for observability (I6). */
export async function recordSearchIndexDirtyFailure(key: SearchIndexScopeKey, error: string): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      "UPDATE search_index_dirty SET last_error = $3 WHERE connector_instance_id = $1 AND stream = $2",
      [key.connectorInstanceId, key.stream, error]
    );
    return;
  }
  exec(referenceQueries.searchIndexDirtyRecordFailure, [error, key.connectorInstanceId, key.stream]);
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

/** Oldest-first page of currently-dirty scopes, bounded by `limit`. Re-queried fresh every sweep round. */
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
       ORDER BY marked_at ASC, connector_instance_id ASC, stream ASC
       LIMIT $1`,
      [limit]
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
  }>(referenceQueries.searchIndexDirtyListDirty, [])) {
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
