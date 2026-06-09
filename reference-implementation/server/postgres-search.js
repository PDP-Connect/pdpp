/**
 * Postgres-backed retrieval index primitives.
 *
 * These primitives are intentionally narrow. Public search envelope semantics
 * remain in operations/rs-search-*; this module owns only Postgres persistence
 * for index rows.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import { postgresQuery } from './postgres-storage.js';
import { makeDefaultAccountConnectorInstanceId } from './stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';

function lexicalTextEntries(fields) {
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([field, value]) => ({ field, value: String(value) }));
}

function defaultConnectorInstanceId(connectorId) {
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

export async function postgresLexicalIndexUpsert({ connectorId, connectorInstanceId = defaultConnectorInstanceId(connectorId), stream, recordKey, fields }) {
  await postgresQuery(
    'DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3',
    [connectorInstanceId, stream, recordKey],
  );
  const entries = lexicalTextEntries(fields);
  for (const entry of entries) {
    await postgresQuery(
      `INSERT INTO lexical_search_index (connector_id, connector_instance_id, stream, record_key, field, value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (connector_instance_id, stream, record_key, field) DO UPDATE
         SET value = EXCLUDED.value`,
      [connectorId, connectorInstanceId, stream, recordKey, entry.field, entry.value],
    );
  }
}

export async function postgresLexicalIndexDelete({ connectorId, connectorInstanceId = defaultConnectorInstanceId(connectorId), stream, recordKey }) {
  await postgresQuery(
    'DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3',
    [connectorInstanceId, stream, recordKey],
  );
}

export async function postgresLexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId = defaultConnectorInstanceId(connectorId), stream }) {
  await postgresQuery(
    'DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  await postgresQuery(
    'DELETE FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
}

export async function postgresLexicalIndexInsertMany({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  entries,
}) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  await postgresQuery(
    `INSERT INTO lexical_search_index (connector_id, connector_instance_id, stream, record_key, field, value)
     SELECT $1, $2, $3, rows.record_key, rows.field, rows.value
     FROM unnest($4::text[], $5::text[], $6::text[]) AS rows(record_key, field, value)
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
    ],
  );
  return entries.length;
}

export async function postgresLexicalMetaGetFingerprint({ connectorInstanceId, stream }) {
  const result = await postgresQuery(
    'SELECT fields_fingerprint FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  return result.rows[0] || null;
}

export async function postgresLexicalMetaUpsertFingerprint({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  stream,
  fieldsFingerprint,
  updatedAt,
}) {
  await postgresQuery(
    `INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at)
     VALUES($1, $2, $3, $4, $5)
     ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
       connector_id = EXCLUDED.connector_id,
       fields_fingerprint = EXCLUDED.fields_fingerprint,
       updated_at = EXCLUDED.updated_at`,
    [connectorId, connectorInstanceId, stream, fieldsFingerprint, updatedAt],
  );
}

export async function postgresLexicalMetaListStreamsForConnector({ connectorInstanceId }) {
  const result = await postgresQuery(
    'SELECT stream FROM lexical_search_meta WHERE connector_instance_id = $1 ORDER BY stream',
    [connectorInstanceId],
  );
  return result.rows;
}

export async function postgresLexicalIndexCountByStream({ connectorInstanceId, stream }) {
  const result = await postgresQuery(
    'SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  return Number(result.rows[0]?.n || 0);
}

export async function postgresLexicalRecordsCountNonDeleted({ connectorInstanceId, stream }) {
  const result = await postgresQuery(
    'SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE',
    [connectorInstanceId, stream],
  );
  return Number(result.rows[0]?.n || 0);
}

export async function postgresLexicalCountIndexableTextValues({ connectorInstanceId, stream, declaredFields }) {
  let total = 0;
  for (const field of declaredFields || []) {
    const result = await postgresQuery(
      `SELECT COUNT(*) AS n
       FROM records
       WHERE connector_instance_id = $1
         AND stream = $2
         AND deleted = FALSE
         AND COALESCE(record_json ->> $3, '') <> ''`,
      [connectorInstanceId, stream, field],
    );
    total += Number(result.rows[0]?.n || 0);
  }
  return total;
}

export async function postgresLexicalRecordsPageNonDeleted({
  connectorInstanceId,
  stream,
  afterId,
  limit,
}) {
  const result = await postgresQuery(
    `SELECT id, record_key, record_json::text AS record_json
     FROM records
     WHERE connector_instance_id = $1
       AND stream = $2
       AND deleted = FALSE
       AND id > $3
     ORDER BY id ASC
     LIMIT $4`,
    [connectorInstanceId, stream, afterId, limit],
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
}) {
  const fields = Array.isArray(searchableFields) && searchableFields.length > 0
    ? searchableFields
    : null;
  const params = [connectorInstanceId, stream, q, Math.min(Math.max(Number(limit) || 25, 1), 100)];
  let fieldClause = '';
  if (fields) {
    params.push(fields);
    fieldClause = `AND lsi.field = ANY($${params.length}::text[])`;
  }
  let recordClause = '';
  if (Array.isArray(recordKeys)) {
    if (recordKeys.length === 0) return [];
    params.push(recordKeys);
    recordClause = `AND lsi.record_key = ANY($${params.length}::text[])`;
  }
  const result = await postgresQuery(
    `SELECT lsi.connector_id, lsi.stream, lsi.record_key, lsi.field,
            r.emitted_at,
            r.record_json::text AS record_json,
            ts_rank_cd(document, plainto_tsquery('simple', $3)) AS score,
            ts_headline('simple', value, plainto_tsquery('simple', $3),
              'StartSel=<mark>, StopSel=</mark>, MaxWords=16, MinWords=1') AS snippet_text
     FROM lexical_search_index lsi
     JOIN records r
       ON r.connector_instance_id = lsi.connector_instance_id
      AND r.stream = lsi.stream
      AND r.record_key = lsi.record_key
     WHERE lsi.connector_instance_id = $1
       AND lsi.stream = $2
       ${fieldClause}
       ${recordClause}
       AND document @@ plainto_tsquery('simple', $3)
       AND r.deleted = FALSE
     ORDER BY score DESC, record_key ASC
     LIMIT $4`,
    params,
  );
  return result.rows;
}

export async function postgresSemanticIndexDelete({ connectorId, connectorInstanceId = defaultConnectorInstanceId(connectorId), stream, recordKey }) {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  await postgresQuery(
    'DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2 AND record_key = $3',
    [connectorInstanceId, `${scopePrefix}%`, recordKey],
  );
}

export async function postgresSemanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId = defaultConnectorInstanceId(connectorId), stream }) {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  await postgresQuery(
    'DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2',
    [connectorInstanceId, `${scopePrefix}%`],
  );
  await postgresQuery(
    'DELETE FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  await postgresQuery(
    'DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
}

export async function postgresListSemanticConnectorInstanceIds({ connectorId, stream }) {
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
    [connectorId, stream],
  );
  return result.rows.map((row) => row.connector_instance_id).filter(Boolean);
}

export async function postgresCountSemanticRecords({ connectorInstanceId, stream }) {
  const result = await postgresQuery(
    'SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE',
    [connectorInstanceId, stream],
  );
  return Number(result.rows[0]?.n || 0);
}

export async function postgresCountIndexableSemanticValues({ connectorInstanceId, stream, declaredFields }) {
  let total = 0;
  for (const field of declaredFields) {
    const result = await postgresQuery(
      `SELECT COUNT(*) AS n
       FROM records
       WHERE connector_instance_id = $1
         AND stream = $2
         AND deleted = FALSE
         AND NULLIF(BTRIM(record_json ->> $3), '') IS NOT NULL`,
      [connectorInstanceId, stream, field],
    );
    total += Number(result.rows[0]?.n || 0);
  }
  return total;
}

export async function postgresCountSemanticIndexByScope({ connectorId, connectorInstanceId, scopeKey }) {
  const result = await postgresQuery(
    `SELECT COUNT(*) AS n
     FROM semantic_search_blob
     WHERE connector_id = $1 AND connector_instance_id = $2 AND scope_key = $3`,
    [connectorId, connectorInstanceId, scopeKey],
  );
  return Number(result.rows[0]?.n || 0);
}

export async function postgresListExistingSemanticKeys({ connectorId, connectorInstanceId, stream }) {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  const result = await postgresQuery(
    `SELECT scope_key, record_key
     FROM semantic_search_blob
     WHERE connector_id = $1
       AND connector_instance_id = $2
       AND scope_key LIKE $3`,
    [connectorId, connectorInstanceId, `${scopePrefix}%`],
  );
  return new Set(result.rows.map((row) => JSON.stringify([row.scope_key, `${connectorInstanceId}\u0000${row.record_key}`])));
}

export async function postgresSemanticIndexUpsertMany({ connectorId, connectorInstanceId = defaultConnectorInstanceId(connectorId), stream, recordKey, entries }) {
  await postgresSemanticIndexDelete({ connectorId, connectorInstanceId, stream, recordKey });
  for (const entry of entries) {
    await postgresQuery(
      `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (connector_instance_id, scope_key, record_key) DO UPDATE
         SET embedding = EXCLUDED.embedding`,
      [
        entry.connectorId ?? connectorId,
        entry.connectorInstanceId ?? connectorInstanceId,
        entry.scopeKey,
        entry.recordKey,
        JSON.stringify(Array.from(entry.vector || [])),
      ],
    );
  }
}

export async function postgresSemanticRecordsPage({ connectorInstanceId, stream, lastId, limit }) {
  const result = await postgresQuery(
    `SELECT id, record_key, record_json
     FROM records
     WHERE connector_instance_id = $1
       AND stream = $2
       AND deleted = FALSE
       AND id > $3
     ORDER BY id ASC
     LIMIT $4`,
    [connectorInstanceId, stream, lastId, limit],
  );
  return result.rows;
}

export async function postgresGetSemanticMeta({ connectorInstanceId, stream }) {
  const result = await postgresQuery(
    `SELECT fields_fingerprint, model_id, dimensions, distance_metric
     FROM semantic_search_meta
     WHERE connector_instance_id = $1 AND stream = $2`,
    [connectorInstanceId, stream],
  );
  return result.rows[0] || null;
}

export async function postgresUpsertSemanticMeta({ connectorId, connectorInstanceId, stream, fieldsFingerprint, modelId, dimensions, distanceMetric }) {
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
    [connectorInstanceId, connectorId, stream, fieldsFingerprint, modelId, dimensions, distanceMetric, new Date().toISOString()],
  );
}

export async function postgresDeleteSemanticMeta({ connectorInstanceId, stream }) {
  await postgresQuery(
    'DELETE FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
}

export async function postgresGetSemanticProgress({ connectorInstanceId, stream }) {
  const result = await postgresQuery(
    `SELECT fields_fingerprint, model_id, dimensions, distance_metric
     FROM semantic_search_backfill_progress
     WHERE connector_instance_id = $1 AND stream = $2`,
    [connectorInstanceId, stream],
  );
  return result.rows[0] || null;
}

export async function postgresUpsertSemanticProgress({ connectorId, connectorInstanceId, stream, fieldsFingerprint, modelId, dimensions, distanceMetric }) {
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
    [connectorInstanceId, connectorId, stream, fieldsFingerprint, modelId, dimensions, distanceMetric, new Date().toISOString()],
  );
}

export async function postgresDeleteSemanticProgress({ connectorInstanceId, stream }) {
  await postgresQuery(
    'DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
}

export async function postgresAnySemanticProgressRow() {
  const result = await postgresQuery(
    'SELECT 1 AS n FROM semantic_search_backfill_progress LIMIT 1',
    [],
  );
  return result.rows[0] || null;
}

export async function postgresListAllSemanticMetaIdentities() {
  const result = await postgresQuery(
    'SELECT model_id, dimensions, distance_metric FROM semantic_search_meta',
    [],
  );
  return result.rows;
}

export async function postgresListSemanticStreamsForConnector({ connectorId }) {
  const result = await postgresQuery(
    `SELECT stream
     FROM (
       SELECT DISTINCT stream FROM semantic_search_meta WHERE connector_id = $1
       UNION
       SELECT DISTINCT stream FROM semantic_search_backfill_progress WHERE connector_id = $1
     ) streams
     ORDER BY stream`,
    [connectorId],
  );
  return result.rows.map((row) => row.stream).filter(Boolean);
}

function cosineDistance(a, b) {
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
  if (magA === 0 || magB === 0) return Number.POSITIVE_INFINITY;
  return 1 - dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export async function postgresSemanticSearch({
  connectorId,
  connectorInstanceId = defaultConnectorInstanceId(connectorId),
  scopeKeys,
  queryVector,
  limit = 200,
  recordKeys = null,
}) {
  const params = [connectorInstanceId, scopeKeys, Math.max(Number(limit) || 200, 1)];
  let recordClause = '';
  if (Array.isArray(recordKeys)) {
    if (recordKeys.length === 0) return [];
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
    params,
  );
  return result.rows
    .map((row) => ({
      connectorId: row.connector_id,
      connectorInstanceId: row.connector_instance_id,
      scopeKey: row.scope_key,
      recordKey: row.record_key,
      distance: cosineDistance(queryVector, Array.isArray(row.embedding) ? row.embedding : []),
    }))
    .sort((a, b) => a.distance - b.distance || a.connectorId.localeCompare(b.connectorId) || a.scopeKey.localeCompare(b.scopeKey) || a.recordKey.localeCompare(b.recordKey))
    .slice(0, limit);
}

export async function postgresGetSemanticRecord({ connectorId, connectorInstanceId = defaultConnectorInstanceId(connectorId), stream, recordKey }) {
  const result = await postgresQuery(
    `SELECT emitted_at, record_json
     FROM records
     WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE`,
    [connectorInstanceId, stream, recordKey],
  );
  return result.rows[0] || null;
}
