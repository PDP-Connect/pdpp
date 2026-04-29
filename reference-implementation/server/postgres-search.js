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

function lexicalTextEntries(fields) {
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([field, value]) => ({ field, value: String(value) }));
}

export async function postgresLexicalIndexUpsert({ connectorId, stream, recordKey, fields }) {
  await postgresQuery(
    'DELETE FROM lexical_search_index WHERE connector_id = $1 AND stream = $2 AND record_key = $3',
    [connectorId, stream, recordKey],
  );
  const entries = lexicalTextEntries(fields);
  for (const entry of entries) {
    await postgresQuery(
      `INSERT INTO lexical_search_index (connector_id, stream, record_key, field, value)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connector_id, stream, record_key, field) DO UPDATE
         SET value = EXCLUDED.value`,
      [connectorId, stream, recordKey, entry.field, entry.value],
    );
  }
}

export async function postgresLexicalIndexDelete({ connectorId, stream, recordKey }) {
  await postgresQuery(
    'DELETE FROM lexical_search_index WHERE connector_id = $1 AND stream = $2 AND record_key = $3',
    [connectorId, stream, recordKey],
  );
}

export async function postgresLexicalIndexDeleteByConnectorStream({ connectorId, stream }) {
  await postgresQuery(
    'DELETE FROM lexical_search_index WHERE connector_id = $1 AND stream = $2',
    [connectorId, stream],
  );
  await postgresQuery(
    'DELETE FROM lexical_search_meta WHERE connector_id = $1 AND stream = $2',
    [connectorId, stream],
  );
}

export async function postgresLexicalSearch({ connectorId, stream, searchableFields, q, limit = 25 }) {
  const fields = Array.isArray(searchableFields) && searchableFields.length > 0
    ? searchableFields
    : null;
  const params = [connectorId, stream, q, Math.min(Math.max(Number(limit) || 25, 1), 100)];
  let fieldClause = '';
  if (fields) {
    params.push(fields);
    fieldClause = `AND lsi.field = ANY($${params.length}::text[])`;
  }
  const result = await postgresQuery(
    `SELECT lsi.connector_id, lsi.stream, lsi.record_key, lsi.field,
            r.emitted_at,
            ts_rank_cd(document, plainto_tsquery('simple', $3)) AS score,
            ts_headline('simple', value, plainto_tsquery('simple', $3),
              'StartSel=, StopSel=, MaxWords=16, MinWords=1') AS snippet_text
     FROM lexical_search_index lsi
     JOIN records r
       ON r.connector_id = lsi.connector_id
      AND r.stream = lsi.stream
      AND r.record_key = lsi.record_key
     WHERE lsi.connector_id = $1
       AND lsi.stream = $2
       ${fieldClause}
       AND document @@ plainto_tsquery('simple', $3)
       AND r.deleted = FALSE
     ORDER BY score DESC, record_key ASC
     LIMIT $4`,
    params,
  );
  return result.rows;
}

export async function postgresSemanticIndexDelete({ connectorId, stream, recordKey }) {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  await postgresQuery(
    'DELETE FROM semantic_search_blob WHERE connector_id = $1 AND scope_key LIKE $2 AND record_key = $3',
    [connectorId, `${scopePrefix}%`, recordKey],
  );
}

export async function postgresSemanticIndexDeleteByConnectorStream({ connectorId, stream }) {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  await postgresQuery(
    'DELETE FROM semantic_search_blob WHERE connector_id = $1 AND scope_key LIKE $2',
    [connectorId, `${scopePrefix}%`],
  );
  await postgresQuery(
    'DELETE FROM semantic_search_meta WHERE connector_id = $1 AND stream = $2',
    [connectorId, stream],
  );
  await postgresQuery(
    'DELETE FROM semantic_search_backfill_progress WHERE connector_id = $1 AND stream = $2',
    [connectorId, stream],
  );
}

export async function postgresSemanticIndexUpsertMany({ connectorId, stream, recordKey, entries }) {
  await postgresSemanticIndexDelete({ connectorId, stream, recordKey });
  for (const entry of entries) {
    await postgresQuery(
      `INSERT INTO semantic_search_blob (connector_id, scope_key, record_key, embedding)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (connector_id, scope_key, record_key) DO UPDATE
         SET embedding = EXCLUDED.embedding`,
      [entry.connectorId, entry.scopeKey, entry.recordKey, JSON.stringify(Array.from(entry.vector || []))],
    );
  }
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
  scopeKeys,
  queryVector,
  limit = 200,
  recordKeys = null,
}) {
  const params = [connectorId, scopeKeys, Math.max(Number(limit) || 200, 1)];
  let recordClause = '';
  if (Array.isArray(recordKeys)) {
    if (recordKeys.length === 0) return [];
    params.push(recordKeys);
    recordClause = `AND record_key = ANY($${params.length}::text[])`;
  }
  const result = await postgresQuery(
    `SELECT connector_id, scope_key, record_key, embedding
     FROM semantic_search_blob
     WHERE connector_id = $1
       AND scope_key = ANY($2::text[])
       ${recordClause}
     LIMIT $3`,
    params,
  );
  return result.rows
    .map((row) => ({
      connectorId: row.connector_id,
      scopeKey: row.scope_key,
      recordKey: row.record_key,
      distance: cosineDistance(queryVector, Array.isArray(row.embedding) ? row.embedding : []),
    }))
    .sort((a, b) => a.distance - b.distance || a.connectorId.localeCompare(b.connectorId) || a.scopeKey.localeCompare(b.scopeKey) || a.recordKey.localeCompare(b.recordKey))
    .slice(0, limit);
}

export async function postgresGetSemanticRecord({ connectorId, stream, recordKey }) {
  const result = await postgresQuery(
    `SELECT emitted_at, record_json
     FROM records
     WHERE connector_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE`,
    [connectorId, stream, recordKey],
  );
  return result.rows[0] || null;
}
