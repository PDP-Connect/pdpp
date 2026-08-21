// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres-backed retrieval index primitives.
 *
 * These primitives are intentionally narrow. Public search envelope semantics
 * remain in operations/rs-search-*; this module owns only Postgres persistence
 * for index rows.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "./owner-auth.ts";
import type { PostgresTransactionClient } from "./postgres-storage.ts";
import {
  isPostgresSemanticIterativeScanSupported,
  isPostgresSemanticVectorEmbedding,
  postgresBulkQuery,
  postgresQuery,
  withPostgresTransaction,
} from "./postgres-storage.ts";
import { sumCountRows } from "./search-index-counts.ts";
import { makeDefaultAccountConnectorInstanceId } from "./stores/connector-instance-store.ts";

type SearchEnvironment = NodeJS.ProcessEnv;

interface ConnectorStreamScope {
  connectorId: string;
  connectorInstanceId?: string;
  stream: string;
}

interface RecordScope extends ConnectorStreamScope {
  recordKey: string;
}

interface LexicalIndexEntry {
  field: string;
  recordKey: string;
  text: string;
}

interface LexicalTextEntry {
  field: string;
  value: string;
}

interface SemanticIndexEntry {
  connectorId?: string;
  connectorInstanceId?: string;
  recordKey: string;
  scopeKey: string;
  vector?: Iterable<number>;
  /** See search-semantic.ts's `SemanticIndexEntry.version` header — backfill-only. */
  version?: number;
}

interface NormalizedSemanticIndexEntry {
  connectorId: string;
  connectorInstanceId: string;
  recordKey: string;
  scopeKey: string;
  values: number[];
  version?: number;
}

interface SemanticHit {
  connectorId: string;
  connectorInstanceId: string;
  distance: number;
  recordKey: string;
  scopeKey: string;
}

interface EnvironmentOptions {
  env?: SearchEnvironment;
}

function lexicalTextEntries(fields: Record<string, unknown> | null | undefined): LexicalTextEntry[] {
  if (!fields || typeof fields !== "object") {
    return [];
  }
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([field, value]) => ({ field, value: String(value) }));
}

function defaultConnectorInstanceId(connectorId: string): string {
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

async function upsertLexicalEntries(
  entries: readonly LexicalTextEntry[],
  index: number,
  scope: Required<RecordScope>,
  client: PostgresTransactionClient
): Promise<void> {
  const entry = entries[index];
  if (!entry) {
    return;
  }
  await client.query(
    `INSERT INTO lexical_search_index (connector_id, connector_instance_id, stream, record_key, field, value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (connector_instance_id, stream, record_key, field) DO UPDATE
         SET value = EXCLUDED.value`,
    [scope.connectorId, scope.connectorInstanceId, scope.stream, scope.recordKey, entry.field, entry.value]
  );
  await upsertLexicalEntries(entries, index + 1, scope, client);
}

export function postgresLexicalCandidateLimit({ env = process.env }: EnvironmentOptions = {}): number {
  const parsed = Number.parseInt(env.PDPP_RS_SEARCH_POSTGRES_CANDIDATE_LIMIT || "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.max(parsed, 100), 10_000);
  }
  return 200;
}

/**
 * Bulk/backfill lexical upsert. Not version-gated: callers are the manifest
 * rebuild/backfill paths, which recompute from the current authoritative
 * `records` row and are not racing a per-record deferred publish. Per-record
 * ingest maintenance must use `postgresLexicalIndexPublishIfCurrent` instead.
 */
export async function postgresLexicalIndexUpsert({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  recordKey,
  fields,
}: RecordScope & { fields: Record<string, unknown> }) {
  const entries = lexicalTextEntries(fields);
  await withPostgresTransaction(async (client) => {
    await client.query(
      "DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
      [connectorInstanceId, stream, recordKey]
    );
    await upsertLexicalEntries(entries, 0, { connectorId, connectorInstanceId, recordKey, stream }, client);
  });
}

export async function postgresLexicalIndexDelete({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  recordKey,
}: RecordScope) {
  await withPostgresTransaction((client) =>
    postgresLexicalIndexDeleteWithClient(client, { connectorInstanceId, recordKey, stream })
  );
}

/**
 * Applies already-computed lexical field values using the CALLER's existing
 * transaction client — no version check, no transaction of its own. The
 * caller (`records.ts`) owns the single version-gated transaction both this
 * and the semantic equivalent write into, so lexical and semantic publish
 * land atomically together against ONE re-read of `records.version`. See
 * harden-connector-instance-write-fence-transaction-native.
 */
export async function postgresLexicalIndexPublishWithClient(
  client: PostgresTransactionClient,
  {
    connectorId,
    connectorInstanceId = defaultConnectorInstanceId(connectorId),
    stream,
    recordKey,
    fields,
  }: RecordScope & { fields: Record<string, unknown> }
): Promise<void> {
  await postgresLexicalIndexDeleteWithClient(client, { connectorInstanceId, recordKey, stream });
  const entries = lexicalTextEntries(fields);
  await upsertLexicalEntries(entries, 0, { connectorId, connectorInstanceId, recordKey, stream }, client);
}

/** Postgres client-scoped lexical delete — see `postgresLexicalIndexPublishWithClient`'s header. */
export async function postgresLexicalIndexDeleteWithClient(
  client: PostgresTransactionClient,
  { connectorInstanceId, stream, recordKey }: { connectorInstanceId: string; stream: string; recordKey: string }
): Promise<void> {
  await client.query(
    "DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
    [connectorInstanceId, stream, recordKey]
  );
}

export async function postgresLexicalIndexDeleteByConnectorStream({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
}: ConnectorStreamScope) {
  await postgresQuery("DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
  await postgresQuery("DELETE FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
}

export async function postgresLexicalIndexInsertMany({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  entries,
}: ConnectorStreamScope & { entries: readonly LexicalIndexEntry[] }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 0;
  }
  // Version-guarded: `entries[].version` is the `records.version` each
  // row's text was read at (a backfill page read, taken before this insert
  // runs — see rebuildLexicalIndexForStream). The JOIN re-checks that
  // version is STILL current and the row is still live at insert time; a
  // row a concurrent delete/newer-write has since superseded is silently
  // skipped rather than resurrected/overwritten. See
  // harden-connector-instance-write-fence-transaction-native.
  await postgresQuery(
    `INSERT INTO lexical_search_index (connector_id, connector_instance_id, stream, record_key, field, value)
     SELECT $1, $2, $3, rows.record_key, rows.field, rows.value
     FROM unnest($4::text[], $5::text[], $6::text[], $7::bigint[]) AS rows(record_key, field, value, version)
     JOIN records r
       ON r.connector_instance_id = $2
      AND r.stream = $3
      AND r.record_key = rows.record_key
      AND r.version = rows.version
      AND r.deleted = FALSE
     ON CONFLICT (connector_instance_id, stream, record_key, field) DO UPDATE
       SET connector_id = EXCLUDED.connector_id,
           value = EXCLUDED.value`,
    [
      connectorId,
      connectorInstanceId,
      stream,
      entries.map((entry) => entry.recordKey),
      entries.map((entry) => entry.field),
      entries.map((entry) => entry.text),
      entries.map((entry) => entry.version),
    ]
  );
  return entries.length;
}

export async function postgresLexicalMetaGetFingerprint({
  connectorInstanceId,
  stream,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">>) {
  const result = await postgresQuery(
    "SELECT fields_fingerprint FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = $2",
    [connectorInstanceId, stream]
  );
  return result.rows[0] || null;
}

export async function postgresLexicalMetaUpsertFingerprint({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  fieldsFingerprint,
  updatedAt,
}: ConnectorStreamScope & { fieldsFingerprint: string; updatedAt: string }) {
  await withPostgresTransaction((client) =>
    postgresLexicalMetaUpsertFingerprintWithClient(client, {
      connectorId,
      connectorInstanceId,
      fieldsFingerprint,
      stream,
      updatedAt,
    })
  );
}

/** Client-scoped variant — see `postgresLexicalIndexPublishWithClient`'s header. */
export async function postgresLexicalMetaUpsertFingerprintWithClient(
  client: PostgresTransactionClient,
  {
    connectorId,
    connectorInstanceId = defaultConnectorInstanceId(connectorId),
    stream,
    fieldsFingerprint,
    updatedAt,
  }: ConnectorStreamScope & { fieldsFingerprint: string; updatedAt: string }
): Promise<void> {
  await client.query(
    `INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at)
     VALUES($1, $2, $3, $4, $5)
     ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
       connector_id = EXCLUDED.connector_id,
       fields_fingerprint = EXCLUDED.fields_fingerprint,
       updated_at = EXCLUDED.updated_at`,
    [connectorId, connectorInstanceId, stream, fieldsFingerprint, updatedAt]
  );
}

export async function postgresLexicalMetaListStreamsForConnector({
  connectorInstanceId,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId">>) {
  const result = await postgresQuery(
    "SELECT stream FROM lexical_search_meta WHERE connector_instance_id = $1 ORDER BY stream",
    [connectorInstanceId]
  );
  return result.rows;
}

export async function postgresLexicalIndexCountByStream({
  connectorInstanceId,
  stream,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">>) {
  const result = await postgresQuery(
    "SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2",
    [connectorInstanceId, stream]
  );
  return Number(result.rows[0]?.n || 0);
}

export async function postgresLexicalRecordsCountNonDeleted({
  connectorInstanceId,
  stream,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">>) {
  const result = await postgresQuery(
    "SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE",
    [connectorInstanceId, stream]
  );
  return Number(result.rows[0]?.n || 0);
}

export async function postgresLexicalCountIndexableTextValues({
  connectorInstanceId,
  stream,
  declaredFields,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">> & { declaredFields?: readonly string[] }) {
  const fields = declaredFields || [];
  if (fields.length === 0) {
    return 0;
  }
  const result = await postgresQuery(
    `SELECT declared_fields.field_ordinal, declared_fields.field, COUNT(*) AS n
     FROM unnest($3::text[]) WITH ORDINALITY AS declared_fields(field, field_ordinal)
     JOIN records
       ON records.connector_instance_id = $1
      AND records.stream = $2
      AND records.deleted = FALSE
      AND COALESCE(records.record_json ->> declared_fields.field, '') <> ''
     GROUP BY declared_fields.field_ordinal, declared_fields.field`,
    [connectorInstanceId, stream, fields]
  );
  return sumCountRows(result.rows);
}

export async function postgresLexicalRecordsPageNonDeleted({
  connectorInstanceId,
  stream,
  afterId,
  limit,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">> & { afterId: number; limit: number }) {
  const result = await postgresQuery(
    `SELECT id, record_key, record_json::text AS record_json, version
     FROM records
     WHERE connector_instance_id = $1
       AND stream = $2
       AND deleted = FALSE
       AND id > $3
     ORDER BY id ASC
     LIMIT $4`,
    [connectorInstanceId, stream, afterId, limit]
  );
  return result.rows;
}

export async function postgresLexicalSearch({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  searchableFields,
  q,
  limit = 25,
  recordKeys = null,
}: ConnectorStreamScope & {
  searchableFields?: readonly string[];
  q: string;
  limit?: number;
  recordKeys?: readonly string[] | null;
}) {
  const fields = Array.isArray(searchableFields) && searchableFields.length > 0 ? searchableFields : null;
  const params: unknown[] = [connectorInstanceId, stream, q, Math.min(Math.max(Number(limit) || 25, 1), 100)];
  let fieldParam: number | null = null;
  if (fields) {
    params.push(fields);
    fieldParam = params.length;
  }
  let recordClause = "";
  if (Array.isArray(recordKeys)) {
    if (recordKeys.length === 0) {
      return [];
    }
    params.push(recordKeys);
    recordClause = `AND lsi.record_key = ANY($${params.length}::text[])`;
  }
  const fieldClause = (alias = "lsi") =>
    fieldParam === null ? "" : `AND ${alias}.field = ANY($${fieldParam}::text[])`;
  const broadCandidateWindow = !Array.isArray(recordKeys);
  let sql = "";
  if (broadCandidateWindow) {
    params.push(postgresLexicalCandidateLimit());
    const candidateLimitParam = params.length;
    sql = `WITH candidates AS MATERIALIZED (
       SELECT connector_id, stream, record_key, field, value, document
       FROM lexical_search_index lsi
       WHERE lsi.connector_instance_id = $1
         AND lsi.stream = $2
         ${fieldClause("lsi")}
         AND lsi.document @@ plainto_tsquery('simple', $3)
       LIMIT $${candidateLimitParam}
     )
     SELECT lsi.connector_id, lsi.stream, lsi.record_key, lsi.field,
            r.emitted_at,
            r.record_json::text AS record_json,
            ts_rank_cd(lsi.document, plainto_tsquery('simple', $3)) AS score,
            ts_headline('simple', lsi.value, plainto_tsquery('simple', $3),
              'StartSel=<mark>, StopSel=</mark>, MaxWords=48, MinWords=12') AS snippet_text
     FROM candidates lsi
     JOIN records r
       ON r.connector_instance_id = $1
      AND r.stream = lsi.stream
      AND r.record_key = lsi.record_key
     WHERE r.deleted = FALSE
     ORDER BY score DESC, lsi.record_key ASC
     LIMIT $4`;
  } else {
    sql = `SELECT lsi.connector_id, lsi.stream, lsi.record_key, lsi.field,
            r.emitted_at,
            r.record_json::text AS record_json,
            ts_rank_cd(document, plainto_tsquery('simple', $3)) AS score,
            ts_headline('simple', value, plainto_tsquery('simple', $3),
              'StartSel=<mark>, StopSel=</mark>, MaxWords=48, MinWords=12') AS snippet_text
     FROM lexical_search_index lsi
     JOIN records r
       ON r.connector_instance_id = lsi.connector_instance_id
      AND r.stream = lsi.stream
      AND r.record_key = lsi.record_key
     WHERE lsi.connector_instance_id = $1
       AND lsi.stream = $2
       ${fieldClause("lsi")}
       ${recordClause}
       AND document @@ plainto_tsquery('simple', $3)
       AND r.deleted = FALSE
     ORDER BY score DESC, lsi.record_key ASC
     LIMIT $4`;
  }
  const result = await withPostgresTransaction(async (client) => {
    // Parallel FTS plans allocate dynamic shared memory; Docker's default
    // /dev/shm is small enough that broad owner searches can fail with 53100.
    // Keep this scoped to the lexical read transaction rather than mutating
    // global Postgres settings.
    await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
    return client.query(sql, params);
  });
  return result.rows;
}

export async function postgresSemanticIndexDelete({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  recordKey,
}: RecordScope) {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  await postgresQuery(
    "DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2 AND record_key = $3",
    [connectorInstanceId, `${scopePrefix}%`, recordKey]
  );
}

export async function postgresSemanticIndexDeleteByConnectorStream({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
}: ConnectorStreamScope) {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  await postgresQuery("DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2", [
    connectorInstanceId,
    `${scopePrefix}%`,
  ]);
  await postgresQuery("DELETE FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
  await postgresQuery(
    "DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 AND stream = $2",
    [connectorInstanceId, stream]
  );
}

export async function postgresListSemanticConnectorInstanceIds({
  connectorId,
  stream,
}: Pick<ConnectorStreamScope, "connectorId" | "stream">) {
  const result = await postgresQuery(
    `SELECT connector_instance_id
     FROM (
       SELECT DISTINCT connector_instance_id
       FROM records
       WHERE connector_id = $1 AND stream = $2
       UNION
       SELECT DISTINCT connector_instance_id
       FROM semantic_search_meta
       WHERE connector_id = $1 AND stream = $2
       UNION
       SELECT DISTINCT connector_instance_id
       FROM semantic_search_backfill_progress
       WHERE connector_id = $1 AND stream = $2
     ) ids
     WHERE connector_instance_id IS NOT NULL
     ORDER BY connector_instance_id`,
    [connectorId, stream]
  );
  return result.rows.map((row) => row.connector_instance_id).filter(Boolean);
}

export async function postgresCountSemanticRecords({
  connectorInstanceId,
  stream,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">>) {
  const result = await postgresQuery(
    "SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE",
    [connectorInstanceId, stream]
  );
  return Number(result.rows[0]?.n || 0);
}

export async function postgresCountIndexableSemanticValues({
  connectorInstanceId,
  stream,
  declaredFields,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">> & { declaredFields?: readonly string[] }) {
  const fields = declaredFields || [];
  if (fields.length === 0) {
    return 0;
  }
  const result = await postgresQuery(
    `SELECT declared_fields.field_ordinal, declared_fields.field, COUNT(*) AS n
     FROM unnest($3::text[]) WITH ORDINALITY AS declared_fields(field, field_ordinal)
     JOIN records
       ON records.connector_instance_id = $1
      AND records.stream = $2
      AND records.deleted = FALSE
      AND NULLIF(BTRIM(records.record_json ->> declared_fields.field), '') IS NOT NULL
     GROUP BY declared_fields.field_ordinal, declared_fields.field`,
    [connectorInstanceId, stream, fields]
  );
  return sumCountRows(result.rows);
}

export async function postgresCountSemanticIndexByScope({
  connectorId,
  connectorInstanceId,
  scopeKey,
}: Required<Pick<ConnectorStreamScope, "connectorId" | "connectorInstanceId">> & { scopeKey: string }) {
  const result = await postgresQuery(
    `SELECT COUNT(*) AS n
     FROM semantic_search_blob
     WHERE connector_id = $1 AND connector_instance_id = $2 AND scope_key = $3`,
    [connectorId, connectorInstanceId, scopeKey]
  );
  return Number(result.rows[0]?.n || 0);
}

export async function postgresListExistingSemanticKeys({
  connectorId,
  connectorInstanceId,
  stream,
}: Required<ConnectorStreamScope>) {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  const result = await postgresQuery(
    `SELECT scope_key, record_key
     FROM semantic_search_blob
     WHERE connector_id = $1
       AND connector_instance_id = $2
       AND scope_key LIKE $3`,
    [connectorId, connectorInstanceId, `${scopePrefix}%`]
  );
  return new Set(
    result.rows.map((row) => JSON.stringify([row.scope_key, `${connectorInstanceId}\u0000${row.record_key}`]))
  );
}

function normalizedSemanticRow(
  entry: SemanticIndexEntry,
  connectorId: string,
  resolvedConnectorInstanceId: string
): NormalizedSemanticIndexEntry {
  const row: NormalizedSemanticIndexEntry = {
    connectorId: entry.connectorId ?? connectorId,
    connectorInstanceId: resolvedConnectorInstanceId,
    recordKey: entry.recordKey,
    scopeKey: entry.scopeKey,
    values: Array.from(entry.vector || []),
  };
  if (typeof entry.version === "number") {
    row.version = entry.version;
  }
  return row;
}

function dedupeSemanticEntries({
  connectorId,
  connectorInstanceId,
  entries,
}: Required<Pick<ConnectorStreamScope, "connectorId" | "connectorInstanceId">> & {
  entries?: readonly SemanticIndexEntry[];
}): NormalizedSemanticIndexEntry[] {
  const deduped = new Map<string, NormalizedSemanticIndexEntry>();
  for (const entry of entries ?? []) {
    const resolvedConnectorInstanceId = entry.connectorInstanceId ?? connectorInstanceId;
    const key = JSON.stringify([resolvedConnectorInstanceId, entry.scopeKey, entry.recordKey]);
    deduped.set(key, normalizedSemanticRow(entry, connectorId, resolvedConnectorInstanceId));
  }
  return Array.from(deduped.values());
}

function semanticInsertManyRows(
  connectorId: string,
  connectorInstanceId: string,
  entries: readonly SemanticIndexEntry[]
): NormalizedSemanticIndexEntry[] {
  const vectorMode = isPostgresSemanticVectorEmbedding();
  return (
    dedupeSemanticEntries({ connectorId, connectorInstanceId, entries })
      // pgvector rejects empty vectors; an empty embedding could never match a
      // query anyway (the JSONB path scored it at infinite distance).
      .filter((entry) => !vectorMode || entry.values.length > 0)
  );
}

async function insertSemanticRows(
  rows: readonly NormalizedSemanticIndexEntry[],
  query: (sql: string, params: unknown[]) => Promise<unknown>
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const vectorMode = isPostgresSemanticVectorEmbedding();
  await query(
    // The embedding parameter is text: pg accepts a JSON array literal as both
    // valid JSON and valid pgvector input, but the target type differs between
    // the two storage modes.
    `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
     SELECT rows.connector_id, rows.connector_instance_id, rows.scope_key, rows.record_key, rows.embedding::${vectorMode ? "vector" : "jsonb"}
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
       AS rows(connector_id, connector_instance_id, scope_key, record_key, embedding)
     ON CONFLICT (connector_instance_id, scope_key, record_key) DO UPDATE
       SET embedding = EXCLUDED.embedding`,
    [
      rows.map((entry) => entry.connectorId),
      rows.map((entry) => entry.connectorInstanceId),
      rows.map((entry) => entry.scopeKey),
      rows.map((entry) => entry.recordKey),
      rows.map((entry) => JSON.stringify(entry.values)),
    ]
  );
  return rows.length;
}

/**
 * Bulk semantic insert for the LIVE per-record ingest CAS path only
 * (`applySemanticEntriesWithClient`/`applySemanticEntriesSync` in
 * search-semantic.ts) — that caller already owns a version-gated
 * transaction around this call, so no per-row check happens here. Backfill
 * (`rebuildSemanticIndexForStream`) MUST use `postgresSemanticIndexInsertManyGuarded`
 * instead, since it has no such enclosing transaction of its own and reads
 * each row on its own schedule, well before this insert runs.
 */
export function postgresSemanticIndexInsertMany({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  entries,
}: Required<Pick<ConnectorStreamScope, "connectorId">> & {
  connectorInstanceId?: string;
  entries: readonly SemanticIndexEntry[];
}) {
  const rows = semanticInsertManyRows(connectorId, connectorInstanceId, entries);
  return insertSemanticRows(rows, (sql, params) => postgresQuery(sql, params as unknown[]));
}

/**
 * Version-guarded semantic insert for the BACKFILL path
 * (`rebuildSemanticIndexForStream`). Every `entries[]` row MUST carry the
 * `records.version` its source text was read at (a backfill page read,
 * taken well before this insert runs, with embedding computed in between —
 * unlocked). Re-checks that version is STILL current and the row still
 * live, atomically within this one INSERT statement's own snapshot,
 * immediately before writing — a row a concurrent delete/newer-write has
 * since superseded is silently skipped, never resurrected/overwritten.
 * See harden-connector-instance-write-fence-transaction-native.
 *
 * Runs on the BULK lane (`postgresBulkQuery`): this is background backfill
 * work, so it must neither consume a connection the owner's page loads need
 * nor run unbounded once Postgres has admitted it. The single-statement
 * version-CAS above is unchanged — `postgresBulkQuery` wraps exactly this
 * one statement in its own short BEGIN/COMMIT, so the statement's snapshot
 * semantics, and therefore the CAS, are identical.
 */
export async function postgresSemanticIndexInsertManyGuarded({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  entries,
}: Required<Pick<ConnectorStreamScope, "connectorId" | "stream">> & {
  connectorInstanceId?: string;
  entries: readonly SemanticIndexEntry[];
}): Promise<number> {
  const rows = semanticInsertManyRows(connectorId, connectorInstanceId, entries).filter(
    (row): row is NormalizedSemanticIndexEntry & { version: number } => typeof row.version === "number"
  );
  if (rows.length === 0) {
    return 0;
  }
  const vectorMode = isPostgresSemanticVectorEmbedding();
  await postgresBulkQuery(
    `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
     SELECT rows.connector_id, rows.connector_instance_id, rows.scope_key, rows.record_key, rows.embedding::${vectorMode ? "vector" : "jsonb"}
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[])
       AS rows(connector_id, connector_instance_id, scope_key, record_key, embedding, version)
     JOIN records r
       ON r.connector_instance_id = $7
      AND r.stream = $8
      AND r.record_key = rows.record_key
      AND r.version = rows.version
      AND r.deleted = FALSE
     ON CONFLICT (connector_instance_id, scope_key, record_key) DO UPDATE
       SET embedding = EXCLUDED.embedding`,
    [
      rows.map((entry) => entry.connectorId),
      rows.map((entry) => entry.connectorInstanceId),
      rows.map((entry) => entry.scopeKey),
      rows.map((entry) => entry.recordKey),
      rows.map((entry) => JSON.stringify(entry.values)),
      rows.map((entry) => entry.version),
      connectorInstanceId,
      stream,
    ]
  );
  return rows.length;
}

export async function postgresSemanticIndexUpsertMany({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  recordKey,
  entries,
}: RecordScope & { entries: readonly SemanticIndexEntry[] }) {
  await postgresSemanticIndexDelete({ connectorId, connectorInstanceId, recordKey, stream });
  return await postgresSemanticIndexInsertMany({ connectorId, connectorInstanceId, entries });
}

/**
 * Applies already-computed semantic entries using the CALLER's existing
 * transaction client — no version check, no transaction of its own. See
 * `postgresLexicalIndexPublishWithClient`'s header: the caller owns the
 * single version-gated transaction both this and the lexical equivalent
 * write into, so the two index families publish atomically together.
 */
export async function postgresSemanticIndexPublishWithClient(
  client: PostgresTransactionClient,
  {
    connectorId,
    connectorInstanceId = defaultConnectorInstanceId(connectorId),
    stream,
    recordKey,
    entries,
  }: RecordScope & { entries: readonly SemanticIndexEntry[] }
): Promise<void> {
  const rows = semanticInsertManyRows(connectorId, connectorInstanceId, entries);
  const scopePrefix = `[${JSON.stringify(stream)},`;
  await client.query(
    "DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2 AND record_key = $3",
    [connectorInstanceId, `${scopePrefix}%`, recordKey]
  );
  await insertSemanticRows(rows, (sql, params) => client.query(sql, params as unknown[]));
}

/** Postgres client-scoped semantic delete — see `postgresSemanticIndexPublishWithClient`'s header. */
export async function postgresSemanticIndexDeleteWithClient(
  client: PostgresTransactionClient,
  { connectorInstanceId, stream, recordKey }: { connectorInstanceId: string; stream: string; recordKey: string }
): Promise<void> {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  await client.query(
    "DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2 AND record_key = $3",
    [connectorInstanceId, `${scopePrefix}%`, recordKey]
  );
}

/**
 * The semantic backfill's coverage scan: one keyset page of `records`.
 *
 * Runs on the BULK lane. This statement is the one live `pg_stat_activity`
 * sampling caught at 27.4s during the 2026-08-21 incident — it is background
 * work, and it was competing for the same connections as the owner's page
 * loads while doing it. Its COST is addressed by
 * `idx_pg_records_instance_stream_id` (this exact keyset shape); the bulk
 * lane and bounded statement here are the backstop, so a page that goes
 * pathological anyway is cancelled by Postgres instead of holding a
 * connection open indefinitely.
 *
 * Already chunked by construction: the caller (`rebuildSemanticIndexForStream`)
 * pages 500 rows at a time and each page is its own statement, so no
 * transaction spans pages and the keyset cursor only advances past a page
 * that committed.
 */
export async function postgresSemanticRecordsPage({
  connectorInstanceId,
  stream,
  lastId,
  limit,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">> & { lastId: number; limit: number }) {
  const result = await postgresBulkQuery(
    `SELECT id, record_key, record_json, version
     FROM records
     WHERE connector_instance_id = $1
       AND stream = $2
       AND deleted = FALSE
       AND id > $3
     ORDER BY id ASC
     LIMIT $4`,
    [connectorInstanceId, stream, lastId, limit]
  );
  return result.rows;
}

export async function postgresGetSemanticMeta({
  connectorInstanceId,
  stream,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">>) {
  const result = await postgresQuery(
    `SELECT fields_fingerprint, model_id, dimensions, distance_metric
     FROM semantic_search_meta
     WHERE connector_instance_id = $1 AND stream = $2`,
    [connectorInstanceId, stream]
  );
  return result.rows[0] || null;
}

export async function postgresUpsertSemanticMeta({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  fieldsFingerprint,
  modelId,
  dimensions,
  distanceMetric,
}: ConnectorStreamScope & { dimensions: number; distanceMetric: string; fieldsFingerprint: string; modelId: string }) {
  await postgresQuery(
    `INSERT INTO semantic_search_meta(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE
       SET connector_id = EXCLUDED.connector_id,
           fields_fingerprint = EXCLUDED.fields_fingerprint,
           model_id = EXCLUDED.model_id,
           dimensions = EXCLUDED.dimensions,
           distance_metric = EXCLUDED.distance_metric,
           updated_at = EXCLUDED.updated_at`,
    [
      connectorInstanceId,
      connectorId,
      stream,
      fieldsFingerprint,
      modelId,
      dimensions,
      distanceMetric,
      new Date().toISOString(),
    ]
  );
}

/** Client-scoped variant — see `postgresLexicalIndexPublishWithClient`'s header. */
export async function postgresUpsertSemanticMetaWithClient(
  client: PostgresTransactionClient,
  {
    connectorId,
    connectorInstanceId = defaultConnectorInstanceId(connectorId),
    stream,
    fieldsFingerprint,
    modelId,
    dimensions,
    distanceMetric,
  }: ConnectorStreamScope & { dimensions: number; distanceMetric: string; fieldsFingerprint: string; modelId: string }
): Promise<void> {
  await client.query(
    `INSERT INTO semantic_search_meta(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE
       SET connector_id = EXCLUDED.connector_id,
           fields_fingerprint = EXCLUDED.fields_fingerprint,
           model_id = EXCLUDED.model_id,
           dimensions = EXCLUDED.dimensions,
           distance_metric = EXCLUDED.distance_metric,
           updated_at = EXCLUDED.updated_at`,
    [
      connectorInstanceId,
      connectorId,
      stream,
      fieldsFingerprint,
      modelId,
      dimensions,
      distanceMetric,
      new Date().toISOString(),
    ]
  );
}

export async function postgresDeleteSemanticMeta({
  connectorInstanceId,
  stream,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">>) {
  await postgresQuery("DELETE FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
}

export async function postgresGetSemanticProgress({
  connectorInstanceId,
  stream,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">>) {
  const result = await postgresQuery(
    `SELECT fields_fingerprint, model_id, dimensions, distance_metric
     FROM semantic_search_backfill_progress
     WHERE connector_instance_id = $1 AND stream = $2`,
    [connectorInstanceId, stream]
  );
  return result.rows[0] || null;
}

export async function postgresUpsertSemanticProgress({
  connectorId,
  connectorInstanceId,
  stream,
  fieldsFingerprint,
  modelId,
  dimensions,
  distanceMetric,
}: Required<ConnectorStreamScope> & {
  dimensions: number;
  distanceMetric: string;
  fieldsFingerprint: string;
  modelId: string;
}) {
  await postgresQuery(
    `INSERT INTO semantic_search_backfill_progress(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE
       SET connector_id = EXCLUDED.connector_id,
           fields_fingerprint = EXCLUDED.fields_fingerprint,
           model_id = EXCLUDED.model_id,
           dimensions = EXCLUDED.dimensions,
           distance_metric = EXCLUDED.distance_metric,
           updated_at = EXCLUDED.updated_at`,
    [
      connectorInstanceId,
      connectorId,
      stream,
      fieldsFingerprint,
      modelId,
      dimensions,
      distanceMetric,
      new Date().toISOString(),
    ]
  );
}

export async function postgresDeleteSemanticProgress({
  connectorInstanceId,
  stream,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId" | "stream">>) {
  await postgresQuery(
    "DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 AND stream = $2",
    [connectorInstanceId, stream]
  );
}

export async function postgresAnySemanticProgressRow() {
  const result = await postgresQuery("SELECT 1 AS n FROM semantic_search_backfill_progress LIMIT 1", []);
  return result.rows[0] || null;
}

export async function postgresListAllSemanticMetaIdentities() {
  const result = await postgresQuery("SELECT model_id, dimensions, distance_metric FROM semantic_search_meta", []);
  return result.rows;
}

export async function postgresListSemanticStreamsForConnector({
  connectorId,
}: Pick<ConnectorStreamScope, "connectorId">) {
  const result = await postgresQuery(
    `SELECT stream
     FROM (
       SELECT DISTINCT stream FROM semantic_search_meta WHERE connector_id = $1
       UNION
       SELECT DISTINCT stream FROM semantic_search_backfill_progress WHERE connector_id = $1
     ) streams
     ORDER BY stream`,
    [connectorId]
  );
  return result.rows.map((row) => row.stream).filter(Boolean);
}

function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let index = 0; index < len; index += 1) {
    const av = Number(a[index]) || 0;
    const bv = Number(b[index]) || 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return 1 - dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function compareSemanticHits(a: SemanticHit, b: SemanticHit): number {
  return (
    a.distance - b.distance ||
    a.connectorId.localeCompare(b.connectorId) ||
    a.scopeKey.localeCompare(b.scopeKey) ||
    a.recordKey.localeCompare(b.recordKey)
  );
}

function postgresSemanticCandidateLimit(limit: number, { env = process.env }: EnvironmentOptions = {}): number {
  const parsed = Number.parseInt(env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT || "", 10);
  const configured = Number.isInteger(parsed) && parsed > 0 ? parsed : 200;
  const requested = Math.max(Number(limit) || 200, 1);
  return Math.min(Math.max(configured, requested), 10_000);
}

function postgresSemanticExactMaxRows({ env = process.env }: EnvironmentOptions = {}): number {
  const parsed = Number.parseInt(env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100_000) : 10_000;
}

function semanticStreamsFromScopeKeys(scopeKeys: readonly string[] | null | undefined): string[] {
  const streams = new Set<string>();
  for (const scopeKey of scopeKeys ?? []) {
    try {
      const parsed = JSON.parse(scopeKey);
      if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0]) {
        streams.add(parsed[0]);
      }
    } catch {
      // Malformed legacy scope keys are ignored: they cannot name a stream.
    }
  }
  return [...streams].sort();
}

async function postgresSemanticRetainedRowEstimate({
  connectorInstanceId,
  scopeKeys,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId">> & { scopeKeys: readonly string[] }) {
  const streams = semanticStreamsFromScopeKeys(scopeKeys);
  if (streams.length === 0) {
    return null;
  }
  const result = await postgresQuery(
    `SELECT COALESCE(SUM(record_count), 0)::bigint AS total,
            COUNT(*)::integer AS matched,
            COALESCE(MAX(dirty), 0)::integer AS max_dirty
       FROM retained_size_stream
      WHERE connector_instance_id = $1
        AND stream = ANY($2::text[])`,
    [connectorInstanceId, streams]
  );
  const row = result.rows[0] || {};
  if (Number(row.matched || 0) !== streams.length) {
    return null;
  }
  if (Number(row.max_dirty || 0) !== 0) {
    return null;
  }
  return Number(row.total || 0);
}

async function postgresSemanticSearchVector({
  connectorInstanceId,
  scopeKeys,
  queryVector,
  limit,
  recordKeys,
}: Required<Pick<ConnectorStreamScope, "connectorInstanceId">> & {
  scopeKeys: readonly string[];
  queryVector: Iterable<number>;
  limit: number;
  recordKeys: readonly string[] | null;
}): Promise<SemanticHit[]> {
  const values = Array.from(queryVector || [], Number);
  const dims = values.length;
  // Typmods cannot be bound parameters; `dims` is validated as a small
  // positive integer (pgvector caps vectors at 16000 dims) before it is
  // interpolated. Non-finite query components cannot form a vector literal
  // and could never produce meaningful distances.
  if (!Number.isInteger(dims) || dims < 1 || dims > 16_000) {
    return [];
  }
  if (!values.every(Number.isFinite)) {
    return [];
  }
  const boundedLimit = Math.max(Number(limit) || 200, 1);
  const params: unknown[] = [connectorInstanceId, scopeKeys, `[${values.join(",")}]`, boundedLimit];
  let recordClause = "";
  if (Array.isArray(recordKeys)) {
    if (recordKeys.length === 0) {
      return [];
    }
    params.push(recordKeys);
    recordClause = `AND record_key = ANY($${params.length}::text[])`;
  }
  const broadProductionSearch = dims === 384 && !Array.isArray(recordKeys);
  const retainedEstimate = broadProductionSearch
    ? await postgresSemanticRetainedRowEstimate({ connectorInstanceId, scopeKeys })
    : null;
  const useCandidateWindow =
    broadProductionSearch && retainedEstimate !== null && retainedEstimate > postgresSemanticExactMaxRows();
  const candidateLimit = useCandidateWindow ? postgresSemanticCandidateLimit(boundedLimit) : boundedLimit;
  // The HNSW default ef_search (40) would silently cap a larger overscan;
  // clamp to pgvector's [1, 1000] GUC range. Integer-validated above via
  // candidateLimit/boundedLimit (Number(...) || 200, Math.max 1).
  const efSearch = Math.min(Math.max(Math.trunc(candidateLimit), 40), 1000);
  const result = await withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
    if (isPostgresSemanticIterativeScanSupported()) {
      // Keep filtered HNSW scans exact-ordered and complete (pgvector >= 0.8).
      await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
    }
    if (useCandidateWindow) {
      // The live Postgres planner chooses the exact (connector_instance_id,
      // scope_key) btree path when both filters appear on the HNSW scan, which
      // turns large Gmail/ChatGPT semantic reads into multi-second full exact
      // scans. Keep the ANN boundary at the connector, then apply the grant
      // scope filter to that bounded candidate set. Scope keys are still
      // enforced before rows leave the database.
      return client.query(
        `WITH ann AS MATERIALIZED (
           SELECT connector_id, connector_instance_id, scope_key, record_key,
                  (embedding::vector(${dims}) <=> $3::vector(${dims}))::float8 AS distance
             FROM semantic_search_blob
            WHERE connector_instance_id = $1
              AND vector_dims(embedding) = ${dims}
            ORDER BY embedding::vector(${dims}) <=> $3::vector(${dims})
            LIMIT $4
         )
         SELECT connector_id, connector_instance_id, scope_key, record_key, distance
           FROM ann
          WHERE scope_key = ANY($2::text[])
          ORDER BY distance ASC, connector_id ASC, scope_key ASC, record_key ASC
          LIMIT $5`,
        [connectorInstanceId, scopeKeys, params[2], candidateLimit, boundedLimit]
      );
    }
    // Secondary tie-break keys stay out of ORDER BY (they would disqualify
    // the ANN index); the <= LIMIT rows are re-sorted below under the same
    // total order the JSONB brute-force path used.
    return client.query(
      `SELECT connector_id, connector_instance_id, scope_key, record_key,
              (embedding::vector(${dims}) <=> $3::vector(${dims}))::float8 AS distance
       FROM semantic_search_blob
       WHERE connector_instance_id = $1
         AND scope_key = ANY($2::text[])
         AND vector_dims(embedding) = ${dims}
         ${recordClause}
       ORDER BY embedding::vector(${dims}) <=> $3::vector(${dims})
       LIMIT $4`,
      params
    );
  });
  return result.rows
    .map((row) => ({
      connectorId: row.connector_id,
      connectorInstanceId: row.connector_instance_id,
      // Zero-magnitude embeddings score NaN under pgvector cosine distance;
      // the JS path scored them Infinity. Normalize for parity.
      distance: Number.isNaN(Number(row.distance)) ? Number.POSITIVE_INFINITY : Number(row.distance),
      recordKey: row.record_key,
      scopeKey: row.scope_key,
    }))
    .sort(compareSemanticHits);
}

export async function postgresSemanticSearch({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  scopeKeys,
  queryVector,
  limit = 200,
  recordKeys = null,
}: ConnectorStreamScope & {
  scopeKeys: readonly string[];
  queryVector: readonly number[];
  limit?: number;
  recordKeys?: readonly string[] | null;
}): Promise<SemanticHit[]> {
  if (isPostgresSemanticVectorEmbedding()) {
    return postgresSemanticSearchVector({ connectorInstanceId, limit, queryVector, recordKeys, scopeKeys });
  }
  const params: unknown[] = [connectorInstanceId, scopeKeys, Math.max(Number(limit) || 200, 1)];
  let recordClause = "";
  if (Array.isArray(recordKeys)) {
    if (recordKeys.length === 0) {
      return [];
    }
    params.push(recordKeys);
    recordClause = `AND record_key = ANY($${params.length}::text[])`;
  }
  const result = await postgresQuery(
    `SELECT connector_id, connector_instance_id, scope_key, record_key, embedding
     FROM semantic_search_blob
     WHERE connector_instance_id = $1
       AND scope_key = ANY($2::text[])
       ${recordClause}
     LIMIT $3`,
    params
  );
  return result.rows
    .map((row) => ({
      connectorId: row.connector_id,
      connectorInstanceId: row.connector_instance_id,
      distance: cosineDistance(queryVector, Array.isArray(row.embedding) ? row.embedding : []),
      recordKey: row.record_key,
      scopeKey: row.scope_key,
    }))
    .sort(compareSemanticHits)
    .slice(0, limit);
}

export async function postgresGetSemanticRecord({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  recordKey,
}: RecordScope) {
  const result = await postgresQuery(
    `SELECT emitted_at, record_json
     FROM records
     WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE`,
    [connectorInstanceId, stream, recordKey]
  );
  return result.rows[0] || null;
}
