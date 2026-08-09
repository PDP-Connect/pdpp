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
// Values are whole seconds (never sub-second) because SQLite's relative
// date modifiers ('+N seconds') only support whole-second granularity --
// the SAME schedule is baked into both queries/search/index-dirty/
// record-failure.sql (SQLite CASE ladder) and the Postgres CASE expression
// below; if this schedule ever changes, both must change together (there
// is no single source of truth across the SQL/JS boundary, since LAND
// review finding #1 requires the whole increment+backoff computation to
// happen in ONE atomic statement per backend, which rules out computing
// the delay in JS and passing it as a parameter).
const BACKOFF_SCHEDULE_SECONDS = [0, 5, 15, 30, 60, 120, 300, 600];

// Postgres CASE expression mirroring record-failure.sql's SQLite ladder
// exactly, keyed on the POST-increment attempts value. to_char(...) forces
// the exact toISOString() shape (YYYY-MM-DDTHH:MM:SS.mmmZ) rather than
// Postgres's own ::text cast shape (space-separated, +00 offset), which
// would otherwise silently break the lexicographic next_attempt_at <= ?
// comparisons in list-dirty's eligibility filter against app-generated
// ISO strings elsewhere in this table.
const POSTGRES_BACKOFF_CASE = (() => {
  const whens = BACKOFF_SCHEDULE_SECONDS.slice(1, -1)
    .map((seconds, index) => `WHEN attempts + 1 = ${index + 1} THEN ${seconds}`)
    .join("\n      ");
  const last = BACKOFF_SCHEDULE_SECONDS.at(-1);
  return `CASE
      WHEN attempts + 1 <= 0 THEN 0
      ${whens}
      ELSE ${last}
    END`;
})();

/**
 * Records a reconcile failure for this scope: dirty stays 1, structured
 * evidence for observability (I6), and attempts/next_attempt_at advance
 * atomically (LAND review finding #1: previously two separate statements,
 * so a crash between them could leave attempts incremented but backoff not
 * yet applied) so a repeatedly-failing scope backs off instead of
 * permanently occupying the oldest-first queue's front slot (see
 * listDirtySearchIndexScopes).
 */
export async function recordSearchIndexDirtyFailure(key: SearchIndexScopeKey, error: string): Promise<void> {
  const nowIso = new Date().toISOString();
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `UPDATE search_index_dirty
       SET last_error = $3,
           attempts = attempts + 1,
           next_attempt_at = to_char(
             ($4::timestamptz + ${POSTGRES_BACKOFF_CASE} * interval '1 second') AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )
       WHERE connector_instance_id = $1 AND stream = $2`,
      [key.connectorInstanceId, key.stream, error, nowIso]
    );
    return;
  }
  exec(referenceQueries.searchIndexDirtyRecordFailure, [error, nowIso, key.connectorInstanceId, key.stream]);
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
