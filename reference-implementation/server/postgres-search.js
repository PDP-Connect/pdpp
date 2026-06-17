/**
 * Postgres-backed retrieval index primitives.
 *
 * These primitives are intentionally narrow. Public search envelope semantics
 * remain in operations/rs-search-*; this module owns only Postgres persistence
 * for index rows.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import {
  isPostgresSemanticIterativeScanSupported,
  isPostgresSemanticVectorEmbedding,
  postgresQuery,
  withPostgresTransaction,
} from './postgres-storage.js';
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

function postgresLexicalCandidateLimit({ env = process.env } = {}) {
  const parsed = Number.parseInt(env.PDPP_RS_SEARCH_POSTGRES_CANDIDATE_LIMIT || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.max(parsed, 100), 10000);
  }
  return 1000;
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
  let fieldParam = null;
  if (fields) {
    params.push(fields);
    fieldParam = params.length;
  }
  let recordClause = '';
  if (Array.isArray(recordKeys)) {
    if (recordKeys.length === 0) return [];
    params.push(recordKeys);
    recordClause = `AND lsi.record_key = ANY($${params.length}::text[])`;
  }
  const fieldClause = (alias = 'lsi') => fieldParam === null ? '' : `AND ${alias}.field = ANY($${fieldParam}::text[])`;
  const broadCandidateWindow = !Array.isArray(recordKeys);
  let sql;
  if (broadCandidateWindow) {
    params.push(postgresLexicalCandidateLimit());
    const candidateLimitParam = params.length;
    sql = `WITH candidates AS MATERIALIZED (
       SELECT connector_id, stream, record_key, field, value, document
       FROM lexical_search_index lsi
       WHERE lsi.connector_instance_id = $1
         AND lsi.stream = $2
         ${fieldClause('lsi')}
         AND lsi.document @@ plainto_tsquery('simple', $3)
       LIMIT $${candidateLimitParam}
     )
     SELECT lsi.connector_id, lsi.stream, lsi.record_key, lsi.field,
            r.emitted_at,
            r.record_json::text AS record_json,
            ts_rank_cd(lsi.document, plainto_tsquery('simple', $3)) AS score,
            ts_headline('simple', lsi.value, plainto_tsquery('simple', $3),
              'StartSel=<mark>, StopSel=</mark>, MaxWords=16, MinWords=1') AS snippet_text
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
              'StartSel=<mark>, StopSel=</mark>, MaxWords=16, MinWords=1') AS snippet_text
     FROM lexical_search_index lsi
     JOIN records r
       ON r.connector_instance_id = lsi.connector_instance_id
      AND r.stream = lsi.stream
      AND r.record_key = lsi.record_key
     WHERE lsi.connector_instance_id = $1
       AND lsi.stream = $2
       ${fieldClause('lsi')}
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
    await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
    return client.query(sql, params);
  });
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
  const vectorMode = isPostgresSemanticVectorEmbedding();
  for (const entry of entries) {
    const values = Array.from(entry.vector || []);
    // pgvector rejects empty vectors; an empty embedding could never match a
    // query anyway (the JSONB path scored it at infinite distance).
    if (vectorMode && values.length === 0) continue;
    await postgresQuery(
      // `[0.1,0.2,...]` is simultaneously valid JSON and a valid pgvector
      // literal, so only the cast differs between the two storage modes.
      `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
       VALUES ($1, $2, $3, $4, $5::${vectorMode ? 'vector' : 'jsonb'})
       ON CONFLICT (connector_instance_id, scope_key, record_key) DO UPDATE
         SET embedding = EXCLUDED.embedding`,
      [
        entry.connectorId ?? connectorId,
        entry.connectorInstanceId ?? connectorInstanceId,
        entry.scopeKey,
        entry.recordKey,
        JSON.stringify(values),
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

function compareSemanticHits(a, b) {
  return a.distance - b.distance || a.connectorId.localeCompare(b.connectorId) || a.scopeKey.localeCompare(b.scopeKey) || a.recordKey.localeCompare(b.recordKey);
}

function postgresSemanticCandidateLimit(limit, { env = process.env } = {}) {
  const parsed = Number.parseInt(env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_CANDIDATE_LIMIT || '', 10);
  const configured = Number.isInteger(parsed) && parsed > 0 ? parsed : 1000;
  const requested = Math.max(Number(limit) || 200, 1);
  return Math.min(Math.max(configured, requested), 10_000);
}

function postgresSemanticExactMaxRows({ env = process.env } = {}) {
  const parsed = Number.parseInt(env.PDPP_RS_SEARCH_POSTGRES_SEMANTIC_EXACT_MAX_ROWS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100_000) : 5000;
}

function semanticStreamsFromScopeKeys(scopeKeys) {
  const streams = new Set();
  for (const scopeKey of scopeKeys || []) {
    try {
      const parsed = JSON.parse(scopeKey);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0]) {
        streams.add(parsed[0]);
      }
    } catch {}
  }
  return [...streams].sort();
}

async function postgresSemanticRetainedRowEstimate({ connectorInstanceId, scopeKeys }) {
  const streams = semanticStreamsFromScopeKeys(scopeKeys);
  if (streams.length === 0) return null;
  const result = await postgresQuery(
    `SELECT COALESCE(SUM(record_count), 0)::bigint AS total,
            COUNT(*)::integer AS matched,
            COALESCE(MAX(dirty), 0)::integer AS max_dirty
       FROM retained_size_stream
      WHERE connector_instance_id = $1
        AND stream = ANY($2::text[])`,
    [connectorInstanceId, streams],
  );
  const row = result.rows[0] || {};
  if (Number(row.matched || 0) !== streams.length) return null;
  if (Number(row.max_dirty || 0) !== 0) return null;
  return Number(row.total || 0);
}

async function postgresSemanticSearchVector({
  connectorInstanceId,
  scopeKeys,
  queryVector,
  limit,
  recordKeys,
}) {
  const values = Array.from(queryVector || [], Number);
  const dims = values.length;
  // Typmods cannot be bound parameters; `dims` is validated as a small
  // positive integer (pgvector caps vectors at 16000 dims) before it is
  // interpolated. Non-finite query components cannot form a vector literal
  // and could never produce meaningful distances.
  if (!Number.isInteger(dims) || dims < 1 || dims > 16_000) return [];
  if (!values.every(Number.isFinite)) return [];
  const boundedLimit = Math.max(Number(limit) || 200, 1);
  const params = [connectorInstanceId, scopeKeys, `[${values.join(',')}]`, boundedLimit];
  let recordClause = '';
  if (Array.isArray(recordKeys)) {
    if (recordKeys.length === 0) return [];
    params.push(recordKeys);
    recordClause = `AND record_key = ANY($${params.length}::text[])`;
  }
  const broadProductionSearch = dims === 384 && !Array.isArray(recordKeys);
  const retainedEstimate = broadProductionSearch
    ? await postgresSemanticRetainedRowEstimate({ connectorInstanceId, scopeKeys })
    : null;
  const useCandidateWindow = broadProductionSearch
    && retainedEstimate !== null
    && retainedEstimate > postgresSemanticExactMaxRows();
  const candidateLimit = useCandidateWindow
    ? postgresSemanticCandidateLimit(boundedLimit)
    : boundedLimit;
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
        [connectorInstanceId, scopeKeys, params[2], candidateLimit, boundedLimit],
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
      params,
    );
  });
  return result.rows
    .map((row) => ({
      connectorId: row.connector_id,
      connectorInstanceId: row.connector_instance_id,
      scopeKey: row.scope_key,
      recordKey: row.record_key,
      // Zero-magnitude embeddings score NaN under pgvector cosine distance;
      // the JS path scored them Infinity. Normalize for parity.
      distance: Number.isNaN(Number(row.distance)) ? Number.POSITIVE_INFINITY : Number(row.distance),
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
}) {
  if (isPostgresSemanticVectorEmbedding()) {
    return postgresSemanticSearchVector({ connectorInstanceId, scopeKeys, queryVector, limit, recordKeys });
  }
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
    .sort(compareSemanticHits)
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
