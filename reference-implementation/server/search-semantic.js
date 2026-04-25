/**
 * Semantic Retrieval Experimental Extension — implementation helper.
 *
 * Realizes the public `semantic-retrieval` capability defined in:
 *   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
 *
 * Parallel to server/search.js (lexical retrieval). The approved implementation
 * tranche requires:
 *   - dedicated route GET /v1/search/semantic (no mutation of /v1/search)
 *   - text-query only (no raw vectors, no client-supplied embeddings)
 *   - persistent default index (sqlite-vec preferred, SQLite-BLOB flat fallback)
 *   - grant-safe snippets (verbatim substrings, never model-generated)
 *   - capabilities.semantic_retrieval with stability: "experimental"
 *   - retrieval_mode: "semantic" (lexical_blending: false in v1)
 *   - restart persistence and startup backfill without re-ingest
 *   - no silent substitution of a non-semantic fallback
 *
 * This module does NOT import from server/search.js. The absence of that
 * import is the load-bearing "no silent lexical fallback" invariant — a
 * reader can verify it with a static grep, and any future contributor who
 * tries to add the import would be visibly crossing a module boundary.
 *
 * Spec: openspec/changes/implement-semantic-retrieval-experimental-extension/
 *       specs/reference-implementation-architecture/spec.md
 */

import { randomBytes, createHash } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getConnectorManifest } from './auth.js';
import { getDb } from './db.js';
import {
  compileRequestFilters,
  passesGrantRecordConstraints,
  passesRequestFilters,
} from './record-filters.js';

// ─── scope_key encoding ────────────────────────────────────────────────────

/**
 * Canonical unambiguous encoding of a (stream, field) pair. Owner directive:
 * use JSON.stringify so a stream or field containing '|' cannot collide with
 * a different (stream, field) pair.
 */
export function encodeScopeKey(stream, field) {
  return JSON.stringify([stream, field]);
}

function encodeVectorPairKey(scopeKey, recordKey) {
  return JSON.stringify([scopeKey, recordKey]);
}

function scopeKeyPrefixForStream(stream) {
  return `${JSON.stringify([stream]).slice(0, -1)},`;
}

// ─── Stream-level declaration lookup ───────────────────────────────────────

async function getStreamSemanticFields(connectorId, stream) {
  const manifest = await getConnectorManifest(connectorId);
  if (!manifest) return null;
  const mStream = (manifest.streams || []).find((s) => s.name === stream);
  const declared = mStream?.query?.search?.semantic_fields;
  if (!Array.isArray(declared) || declared.length === 0) return null;
  return declared;
}

// ─── Embedding backend (pluggable; default deterministic stub) ─────────────

/**
 * Deterministic hash-based embedding stub. Explicit promises:
 *   - Determinism: embedQuery(t) byte-equal across invocations
 *   - Distinctness: distinct inputs produce distinct vectors (collision
 *     negligible for test corpora)
 *   - Reflexive exact-match: embedQuery(t) === embedDocument(t) exactly, so
 *     a query whose text is identical to a stored field value ranks that
 *     record at distance 0 (the top hit)
 *
 * Explicit NON-promises (tests MUST NOT assume these):
 *   - paraphrase / synonymy / multilingual / conceptual similarity
 *   - any ordering beyond "exact-match ranks first"
 *
 * Model identifier `pdpp-reference-stub-embed-v0` deliberately names itself
 * as a stub and does NOT impersonate any hosted provider.
 */
export function makeStubBackend({ dimensions = 64 } = {}) {
  function hashEmbed(text) {
    // FNV-1a-style mix over sha256 digest slices → Float32Array[dimensions].
    // Deterministic and reflexive: embedQuery and embedDocument use the same
    // function, so the query "hello" and the document "hello" produce the
    // exact same vector (distance 0 under cosine).
    const vec = new Float32Array(dimensions);
    if (typeof text !== 'string' || text.length === 0) return vec;
    const digest = createHash('sha512').update(text, 'utf8').digest();
    for (let i = 0; i < dimensions; i++) {
      const byte = digest[i % digest.length];
      // Map each byte to [-1, 1] range; normalize at the end.
      vec[i] = (byte / 127.5) - 1.0;
    }
    // Normalize so cosine distance works cleanly.
    let norm = 0;
    for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dimensions; i++) vec[i] /= norm;
    return vec;
  }
  return {
    profileId: () => 'stub',
    model: () => 'pdpp-reference-stub-embed-v0',
    dimensions: () => dimensions,
    distanceMetric: () => 'cosine',
    identity: () => `stub:${dimensions}:cosine`,
    embedQuery: async (t) => hashEmbed(t),
    embedDocument: async (t) => hashEmbed(t),
    available: () => true,
    languageBias: () => null,
  };
}

const LOCAL_EMBEDDING_PROFILES = {
  minilm: {
    profileId: 'minilm',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
    distanceMetric: 'cosine',
    dtype: 'q4',
    languageBias: {
      primary: 'en',
      note: 'Compact English-biased MiniLM profile. Use multilingual-minilm for Italian or mixed-language corpora.',
    },
  },
  'multilingual-minilm': {
    profileId: 'multilingual-minilm',
    modelId: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dimensions: 384,
    distanceMetric: 'cosine',
    dtype: 'q4',
    languageBias: {
      primary: 'multi',
      note: 'Multilingual MiniLM profile suitable for Italian and other supported sentence-transformer languages.',
    },
  },
};

const DISTANCE_METRICS = new Set(['cosine', 'dot', 'l2']);
const EMBEDDING_BACKEND_ENV = 'PDPP_SEMANTIC_EMBEDDING_BACKEND';
export const DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS = 2048;
const DEFAULT_TRANSFORMERS_CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.cache',
  'transformers',
);

function parsePositiveInteger(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function normalizeDownloadAllowed(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function resolveLocalEmbeddingProfile(env = process.env) {
  const requestedProfile = (env.PDPP_EMBEDDING_PROFILE_ID || 'minilm').trim();
  const profile = LOCAL_EMBEDDING_PROFILES[requestedProfile];
  if (!profile) {
    throw new Error(`PDPP_EMBEDDING_PROFILE_ID must be one of: ${Object.keys(LOCAL_EMBEDDING_PROFILES).join(', ')}`);
  }
  const modelId = (env.PDPP_EMBEDDING_MODEL_ID || profile.modelId).trim();
  const dimensions = parsePositiveInteger(env.PDPP_EMBEDDING_DIMENSIONS, profile.dimensions, 'PDPP_EMBEDDING_DIMENSIONS');
  const distanceMetric = (env.PDPP_EMBEDDING_DISTANCE_METRIC || profile.distanceMetric).trim();
  if (!DISTANCE_METRICS.has(distanceMetric)) {
    throw new Error(`PDPP_EMBEDDING_DISTANCE_METRIC must be one of: ${Array.from(DISTANCE_METRICS).join(', ')}`);
  }
  const dtype = (env.PDPP_EMBEDDING_DTYPE || profile.dtype).trim();
  const cacheDir = path.resolve(env.PDPP_EMBEDDING_CACHE_DIR || env.TRANSFORMERS_CACHE || DEFAULT_TRANSFORMERS_CACHE_DIR);
  return {
    ...profile,
    profileId: requestedProfile,
    modelId,
    dimensions,
    distanceMetric,
    dtype,
    cacheDir,
    downloadAllowed: normalizeDownloadAllowed(env.PDPP_EMBEDDING_DOWNLOAD_ALLOWED),
  };
}

function dtypeModelFile(dtype) {
  const suffixes = {
    fp32: '',
    fp16: '_fp16',
    q8: '_quantized',
    int8: '_int8',
    uint8: '_uint8',
    q4: '_q4',
    q4f16: '_q4f16',
    q2: '_q2',
    q2f16: '_q2f16',
    q1: '_q1',
    q1f16: '_q1f16',
    bnb4: '_bnb4',
  };
  const suffix = suffixes[dtype] ?? `_${dtype}`;
  return `model${suffix}.onnx`;
}

function modelCachePresent({ cacheDir, modelId, dtype }) {
  const required = [
    path.join(cacheDir, modelId, 'config.json'),
    path.join(cacheDir, modelId, 'onnx', dtypeModelFile(dtype)),
  ];
  return required.every((file) => fs.existsSync(file));
}

function normalizeEmbeddingVector(output, expectedDimensions) {
  const raw = output?.data ?? output;
  const arr = ArrayBuffer.isView(raw) ? raw : Array.isArray(raw) ? raw : null;
  if (!arr) {
    throw new Error('embedding backend returned an unsupported output shape');
  }
  const vec = Float32Array.from(arr);
  if (vec.length !== expectedDimensions) {
    throw new Error(`embedding backend returned ${vec.length} dimensions; expected ${expectedDimensions}`);
  }
  return vec;
}

function normalizeSemanticEmbeddingInput(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS) return value;
  return value.slice(0, DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS);
}

/**
 * Local Transformers.js embedding backend used by the operational reference.
 * It runs entirely in-process, requires no hosted API key, and lazily loads
 * the selected ONNX model on first semantic index/query work.
 */
export function makeLocalTransformerBackend(config = resolveLocalEmbeddingProfile()) {
  let extractorPromise = null;
  let lastLoadError = null;

  async function getExtractor() {
    if (extractorPromise) return extractorPromise;
    extractorPromise = import('@huggingface/transformers')
      .then(async ({ env, LogLevel, pipeline }) => {
        env.allowLocalModels = true;
        env.allowRemoteModels = config.downloadAllowed;
        env.cacheDir = config.cacheDir;
        if (LogLevel?.ERROR !== undefined) {
          env.logLevel = LogLevel.ERROR;
        }
        return pipeline('feature-extraction', config.modelId, { dtype: config.dtype });
      })
      .catch((err) => {
        lastLoadError = err;
        extractorPromise = null;
        throw err;
      });
    return extractorPromise;
  }

  async function embed(text) {
    const extractor = await getExtractor();
    const output = await extractor(String(text || ''), { pooling: 'mean', normalize: true });
    return normalizeEmbeddingVector(output, config.dimensions);
  }

  return {
    profileId: () => config.profileId,
    model: () => config.modelId,
    dimensions: () => config.dimensions,
    distanceMetric: () => config.distanceMetric,
    dtype: () => config.dtype,
    identity: () => `${config.profileId}:${config.modelId}:${config.dtype}:${config.dimensions}:${config.distanceMetric}`,
    embedQuery: embed,
    embedDocument: embed,
    available: () => {
      if (lastLoadError) return false;
      return config.downloadAllowed || modelCachePresent(config);
    },
    languageBias: () => config.languageBias,
    modelCachePath: () => config.cacheDir,
    modelCachePresent: () => modelCachePresent(config),
    downloadAllowed: () => config.downloadAllowed,
  };
}

export function resolveSemanticBackendFromEnv(env = process.env) {
  const defaultMode = env.PDPP_REFERENCE_OPERATIONAL_DEFAULTS === '1' ? 'local' : 'stub';
  const mode = (env[EMBEDDING_BACKEND_ENV] || defaultMode).trim().toLowerCase();
  if (['0', 'false', 'off', 'none', 'disabled'].includes(mode)) return null;
  if (['local', 'transformers', 'transformers-js'].includes(mode)) {
    return makeLocalTransformerBackend(resolveLocalEmbeddingProfile(env));
  }
  if (mode === 'stub') return makeStubBackend();
  throw new Error(`${EMBEDDING_BACKEND_ENV} must be one of: local, stub, disabled`);
}

// Module-scoped backend, configured by configureSemanticBackend() or left
// null (extension is not advertised).
let backend = null;
let activeBackfillCount = 0;
let nextBackfillJobId = 1;
const backfillJobs = new Map();

/**
 * Configure or clear the module-scoped embedding backend. Pass null to
 * disable the extension. The default is the deterministic local stub; a
 * hosted provider adapter can be installed by passing an object that
 * implements the EmbeddingBackend interface.
 *
 * When no backend is configured:
 *   - capabilities.semantic_retrieval is NOT advertised with supported: true
 *   - GET /v1/search/semantic is not registered
 *   - the vector index is never populated
 */
export function configureSemanticBackend(b) {
  backend = b;
}

export function getSemanticBackend() {
  return backend;
}

export function isSemanticIndexBackfillActive() {
  return activeBackfillCount > 0;
}

function publicBackfillJob(job) {
  return {
    id: job.id,
    connector_id: job.connectorId,
    stream: job.stream,
    phase: job.phase,
    active_jobs: activeBackfillCount,
    manifest_streams_checked: job.manifestStreamsChecked,
    manifest_streams_total: job.manifestStreamsTotal,
    records_scanned: job.recordsScanned,
    records_total: job.recordsTotal,
    indexed_vectors: job.indexedVectors,
    started_at: job.startedAt,
    updated_at: job.updatedAt,
  };
}

function latestBackfillJob() {
  let latest = null;
  for (const job of backfillJobs.values()) {
    if (!latest || job.updatedAt > latest.updatedAt) {
      latest = job;
    }
  }
  return latest;
}

function updateBackfillJob(job, patch) {
  const updated = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  backfillJobs.set(updated.id, updated);
  return updated;
}

export function getSemanticIndexBackfillProgress() {
  const job = latestBackfillJob();
  return job ? publicBackfillJob(job) : null;
}

// ─── Vector index interface + backends ─────────────────────────────────────

/**
 * Persistent SQLite-backed flat vector store for environments where
 * sqlite-vec cannot be loaded. Stores embeddings as BLOBs in a regular
 * SQLite table; distance is computed in JavaScript after the WHERE clause
 * narrows to the plan-scoped (connector_id, scope_key) tuples.
 *
 * Same interface surface and same persistence guarantees as the sqlite-vec
 * backend. Slower throughput at large N, but correct and grant-safe.
 */
function makeBlobFlatIndex({ db, dimensions, distanceMetric }) {
  const byteLen = dimensions * 4;
  const upsertStmt = db.prepare(`
    INSERT INTO semantic_search_blob(connector_id, scope_key, record_key, embedding)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(connector_id, scope_key, record_key) DO UPDATE SET
      embedding = excluded.embedding
  `);
  const upsertManyTx = db.transaction((entries) => {
    for (const entry of entries) {
      const buf = Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength);
      upsertStmt.run(entry.connectorId, entry.scopeKey, entry.recordKey, buf);
    }
  });

  function distance(a, b) {
    if (distanceMetric === 'cosine') {
      // Vectors are pre-normalized by the stub; for hosted backends we
      // still fall back to a dot-product equivalent which is fine because
      // both stored and query vectors go through the same backend.
      let dot = 0;
      for (let i = 0; i < dimensions; i++) dot += a[i] * b[i];
      return 1 - dot;
    }
    if (distanceMetric === 'dot') {
      let dot = 0;
      for (let i = 0; i < dimensions; i++) dot += a[i] * b[i];
      return -dot;
    }
    // l2
    let sum = 0;
    for (let i = 0; i < dimensions; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  return {
    kind: 'blob-flat',
    async upsert({ connectorId, scopeKey, recordKey, vector }) {
      const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
      upsertStmt.run(connectorId, scopeKey, recordKey, buf);
    },
    async upsertMany(entries) {
      if (entries.length === 0) return;
      upsertManyTx(entries);
    },
    async deleteRecord({ connectorId, stream, recordKey }) {
      // scope_key contains stream as the first JSON array element. Use
      // a LIKE match anchored on the opening characters of scope_key's
      // JSON encoding to narrow before comparing the stream name exactly
      // against the decoded scope_key.
      const streamPrefix = scopeKeyPrefixForStream(stream); // e.g. '["posts",'
      db.prepare(`
        DELETE FROM semantic_search_blob
        WHERE connector_id = ?
          AND record_key = ?
          AND scope_key LIKE ?
      `).run(connectorId, recordKey, `${streamPrefix}%`);
    },
    async deleteByConnectorStream({ connectorId, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      db.prepare(`
        DELETE FROM semantic_search_blob
        WHERE connector_id = ?
          AND scope_key LIKE ?
      `).run(connectorId, `${streamPrefix}%`);
    },
    async deleteByConnectorScope({ connectorId, scopeKey }) {
      db.prepare(`
        DELETE FROM semantic_search_blob
        WHERE connector_id = ? AND scope_key = ?
      `).run(connectorId, scopeKey);
    },
    async deleteByConnector({ connectorId }) {
      db.prepare(`
        DELETE FROM semantic_search_blob
        WHERE connector_id = ?
      `).run(connectorId);
    },
    async queryPerConnector({ connectorId, scopeKeys, queryVector, limit, recordKeys = null }) {
      if (!Array.isArray(scopeKeys) || scopeKeys.length === 0) return [];
      if (Array.isArray(recordKeys) && recordKeys.length === 0) return [];
      const placeholders = scopeKeys.map(() => '?').join(',');
      const recordKeyClause = Array.isArray(recordKeys)
        ? `AND record_key IN (${recordKeys.map(() => '?').join(',')})`
        : '';
      const rows = db.prepare(`
        SELECT scope_key, record_key, embedding
        FROM semantic_search_blob
        WHERE connector_id = ?
          AND scope_key IN (${placeholders})
          ${recordKeyClause}
      `).all(connectorId, ...scopeKeys, ...(recordKeys || []));
      const scored = [];
      for (const row of rows) {
        if (!row.embedding || row.embedding.length !== byteLen) continue;
        const buf = Buffer.isBuffer(row.embedding)
          ? row.embedding
          : Buffer.from(row.embedding);
        const storedVec = new Float32Array(buf.buffer, buf.byteOffset, dimensions);
        const d = distance(queryVector, storedVec);
        scored.push({
          connectorId,
          scopeKey: row.scope_key,
          recordKey: row.record_key,
          distance: d,
        });
      }
      scored.sort(compareHits);
      return scored.slice(0, limit);
    },
    countAll() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM semantic_search_blob').get();
      return Number(row?.n || 0);
    },
    countByConnectorScope(connectorId, scopeKey) {
      const row = db.prepare(`
        SELECT COUNT(*) AS n FROM semantic_search_blob
        WHERE connector_id = ? AND scope_key = ?
      `).get(connectorId, scopeKey);
      return Number(row?.n || 0);
    },
    async listExistingKeys({ connectorId, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      const rows = db.prepare(`
        SELECT scope_key, record_key
        FROM semantic_search_blob
        WHERE connector_id = ?
          AND scope_key LIKE ?
      `).all(connectorId, `${streamPrefix}%`);
      return new Set(rows.map((row) => encodeVectorPairKey(row.scope_key, row.record_key)));
    },
  };
}

/**
 * sqlite-vec-backed persistent vector index. Preferred when the extension
 * can be loaded (see db.js loadVectorExtension). Stores vectors in a vec0
 * virtual table; scope_key is a metadata column filtered INSIDE the KNN
 * query (not post-filtered). connector_id is a PARTITION KEY, so owner
 * fan-out is one query per authorized connector, merged in JS.
 *
 * vec0 uses an integer rowid; we maintain semantic_search_rowid as a
 * sidecar mapping (connector_id, scope_key, record_key) → rowid so we can
 * upsert by logical identity.
 */
function makeSqliteVecIndex({ db, dimensions, distanceMetric }) {
  // Bootstrap the vec0 virtual table lazily on first use. Dimensions and
  // distance_metric are baked into the schema. If either changes, recreate
  // the virtual table and let manifest backfill rebuild from stored records.
  function ensureTable() {
    const existing = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'semantic_search_vec'
    `).get();
    if (existing) {
      const sql = String(existing.sql || '');
      const expectedDims = `FLOAT[${dimensions}]`;
      const expectedMetric = `distance_metric=${distanceMetric}`;
      if (sql.includes(expectedDims) && sql.includes(expectedMetric)) {
        return;
      }
      db.prepare('DROP TABLE semantic_search_vec').run();
      db.prepare('DELETE FROM semantic_search_rowid').run();
      db.prepare('DELETE FROM semantic_search_meta').run();
      db.prepare('DELETE FROM semantic_search_backfill_progress').run();
      db.prepare('DELETE FROM semantic_search_snapshots').run();
    }
    db.prepare(`
      CREATE VIRTUAL TABLE semantic_search_vec USING vec0(
        connector_id TEXT PARTITION KEY,
        scope_key    TEXT,
        +record_key  TEXT,
        embedding    FLOAT[${dimensions}] distance_metric=${distanceMetric}
      )
    `).run();
  }
  ensureTable();

  const selectRowidStmt = db.prepare(`
    SELECT rowid FROM semantic_search_rowid
    WHERE connector_id = ? AND scope_key = ? AND record_key = ?
  `);
  const updateVecStmt = db.prepare(`
    UPDATE semantic_search_vec SET embedding = ? WHERE rowid = ?
  `);
  const insertVecStmt = db.prepare(`
    INSERT INTO semantic_search_vec(connector_id, scope_key, record_key, embedding)
    VALUES(?, ?, ?, ?)
  `);
  const insertRowidStmt = db.prepare(`
    INSERT INTO semantic_search_rowid(connector_id, scope_key, record_key, rowid)
    VALUES(?, ?, ?, ?)
  `);

  function upsertOne({ connectorId, scopeKey, recordKey, vector }) {
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const existing = selectRowidStmt.get(connectorId, scopeKey, recordKey);
    if (existing) {
      updateVecStmt.run(buf, existing.rowid);
      return;
    }
    const info = insertVecStmt.run(connectorId, scopeKey, recordKey, buf);
    insertRowidStmt.run(connectorId, scopeKey, recordKey, Number(info.lastInsertRowid));
  }

  const upsertManyTx = db.transaction((entries) => {
    for (const entry of entries) {
      upsertOne(entry);
    }
  });

  return {
    kind: 'sqlite-vec',
    async upsert({ connectorId, scopeKey, recordKey, vector }) {
      upsertOne({ connectorId, scopeKey, recordKey, vector });
    },
    async upsertMany(entries) {
      if (entries.length === 0) return;
      upsertManyTx(entries);
    },
    async deleteRecord({ connectorId, stream, recordKey }) {
      // Any scope_key whose first array element is stream.
      const streamPrefix = scopeKeyPrefixForStream(stream);
      const rows = db.prepare(`
        SELECT rowid, scope_key FROM semantic_search_rowid
        WHERE connector_id = ? AND record_key = ? AND scope_key LIKE ?
      `).all(connectorId, recordKey, `${streamPrefix}%`);
      for (const row of rows) {
        db.prepare('DELETE FROM semantic_search_vec WHERE rowid = ?').run(row.rowid);
        db.prepare(`
          DELETE FROM semantic_search_rowid
          WHERE connector_id = ? AND scope_key = ? AND record_key = ?
        `).run(connectorId, row.scope_key, recordKey);
      }
    },
    async deleteByConnectorStream({ connectorId, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      const rows = db.prepare(`
        SELECT rowid FROM semantic_search_rowid
        WHERE connector_id = ? AND scope_key LIKE ?
      `).all(connectorId, `${streamPrefix}%`);
      for (const row of rows) {
        db.prepare('DELETE FROM semantic_search_vec WHERE rowid = ?').run(row.rowid);
      }
      db.prepare(`
        DELETE FROM semantic_search_rowid
        WHERE connector_id = ? AND scope_key LIKE ?
      `).run(connectorId, `${streamPrefix}%`);
    },
    async deleteByConnectorScope({ connectorId, scopeKey }) {
      const rows = db.prepare(`
        SELECT rowid FROM semantic_search_rowid
        WHERE connector_id = ? AND scope_key = ?
      `).all(connectorId, scopeKey);
      for (const row of rows) {
        db.prepare('DELETE FROM semantic_search_vec WHERE rowid = ?').run(row.rowid);
      }
      db.prepare(`
        DELETE FROM semantic_search_rowid
        WHERE connector_id = ? AND scope_key = ?
      `).run(connectorId, scopeKey);
    },
    async deleteByConnector({ connectorId }) {
      const rows = db.prepare(`
        SELECT rowid FROM semantic_search_rowid WHERE connector_id = ?
      `).all(connectorId);
      for (const row of rows) {
        db.prepare('DELETE FROM semantic_search_vec WHERE rowid = ?').run(row.rowid);
      }
      db.prepare('DELETE FROM semantic_search_rowid WHERE connector_id = ?').run(connectorId);
    },
    async queryPerConnector({ connectorId, scopeKeys, queryVector, limit, recordKeys = null }) {
      if (!Array.isArray(scopeKeys) || scopeKeys.length === 0) return [];
      if (Array.isArray(recordKeys) && recordKeys.length === 0) return [];
      const placeholders = scopeKeys.map(() => '?').join(',');
      const recordKeyClause = Array.isArray(recordKeys)
        ? `AND rowid IN (
             SELECT rowid
             FROM semantic_search_rowid
             WHERE connector_id = ?
               AND scope_key IN (${placeholders})
               AND record_key IN (${recordKeys.map(() => '?').join(',')})
           )`
        : '';
      const buf = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
      const rows = db.prepare(`
        SELECT connector_id, scope_key, record_key, distance
        FROM semantic_search_vec
        WHERE embedding MATCH ?
          AND connector_id = ?
          AND scope_key IN (${placeholders})
          ${recordKeyClause}
        ORDER BY distance LIMIT ?
      `).all(
        buf,
        connectorId,
        ...scopeKeys,
        ...(recordKeys ? [connectorId, ...scopeKeys, ...recordKeys] : []),
        limit,
      );
      const hits = rows.map((r) => ({
        connectorId: r.connector_id,
        scopeKey: r.scope_key,
        recordKey: r.record_key,
        distance: r.distance,
      }));
      // vec0 orders by distance already; apply the secondary total-order
      // tie-breakers here so merge-in-app is deterministic.
      hits.sort(compareHits);
      return hits;
    },
    countAll() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM semantic_search_rowid').get();
      return Number(row?.n || 0);
    },
    countByConnectorScope(connectorId, scopeKey) {
      const row = db.prepare(`
        SELECT COUNT(*) AS n FROM semantic_search_rowid
        WHERE connector_id = ? AND scope_key = ?
      `).get(connectorId, scopeKey);
      return Number(row?.n || 0);
    },
    async listExistingKeys({ connectorId, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      const rows = db.prepare(`
        SELECT scope_key, record_key
        FROM semantic_search_rowid
        WHERE connector_id = ?
          AND scope_key LIKE ?
      `).all(connectorId, `${streamPrefix}%`);
      return new Set(rows.map((row) => encodeVectorPairKey(row.scope_key, row.record_key)));
    },
  };
}

/**
 * Total order for merged hits. Owner directive: sort by distance, then
 * connector_id, then scope_key, then record_key. Drives page slicing,
 * has_more, and cursor round-trips.
 */
function compareHits(a, b) {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.connectorId !== b.connectorId) return a.connectorId < b.connectorId ? -1 : 1;
  if (a.scopeKey !== b.scopeKey) return a.scopeKey < b.scopeKey ? -1 : 1;
  if (a.recordKey !== b.recordKey) return a.recordKey < b.recordKey ? -1 : 1;
  return 0;
}

// Cached vector index handle keyed on the current db instance. getDb()
// returns a fresh Proxy wrapper after every initDb(), so when tests call
// closeDb()+initDb() between cases the cache naturally invalidates (the
// old handle's `db` reference is no longer current). This replaces an
// earlier module-scoped `let vectorIndex = null` that survived across
// DB reopens and triggered "database connection is not open" crashes.
let cachedIndex = null;
let cachedIndexDb = null;

function ensureVectorIndex() {
  if (!backend) return null;
  const db = getDb();
  if (!db) return null;
  if (cachedIndex && cachedIndexDb === db) return cachedIndex;
  const kind = db.vectorIndexKind || 'blob-flat';
  const dimensions = backend.dimensions();
  const distanceMetric = backend.distanceMetric();
  if (kind === 'sqlite-vec') {
    cachedIndex = makeSqliteVecIndex({ db, dimensions, distanceMetric });
  } else {
    cachedIndex = makeBlobFlatIndex({ db, dimensions, distanceMetric });
  }
  cachedIndexDb = db;
  return cachedIndex;
}

/**
 * Clear the module-scoped vector index handle. Kept as a named test helper
 * even though the db-identity check above handles normal test lifecycles —
 * callers that swap the backend without touching the db (model_id change in
 * place) still need a way to force reconstruction.
 */
export function resetVectorIndexForTests() {
  cachedIndex = null;
  cachedIndexDb = null;
}

// ─── Index maintenance (called from records.js) ────────────────────────────

export async function semanticIndexUpsert({ connectorId, stream, recordKey, data }) {
  if (!backend) return;
  const declared = await getStreamSemanticFields(connectorId, stream);
  if (!declared) return;
  const index = ensureVectorIndex();
  if (!index) return;
  const entries = [];
  for (const field of declared) {
    const text = normalizeSemanticEmbeddingInput(data?.[field]);
    if (!text) continue;
    const vector = await backend.embedDocument(text);
    entries.push({
      connectorId,
      scopeKey: encodeScopeKey(stream, field),
      recordKey,
      vector,
    });
  }
  // Delete only this logical record's stale vectors after embeddings succeed.
  // Deleting by scope here would wipe every row for the field.
  await index.deleteRecord({ connectorId, stream, recordKey });
  if (entries.length > 0 && typeof index.upsertMany === 'function') {
    await index.upsertMany(entries);
    return;
  }
  for (const entry of entries) {
    await index.upsert(entry);
  }
}

export async function semanticIndexDelete({ connectorId, stream, recordKey }) {
  if (!backend) return;
  const index = ensureVectorIndex();
  if (!index) return;
  await index.deleteRecord({ connectorId, stream, recordKey });
}

export async function semanticIndexDeleteByConnectorStream({ connectorId, stream }) {
  if (!backend) return;
  const index = ensureVectorIndex();
  if (!index) return;
  await index.deleteByConnectorStream({ connectorId, stream });
}

// ─── Drift-detect + backfill ───────────────────────────────────────────────

function fingerprintSemanticFields(declaredFields) {
  const unique = Array.from(new Set(declaredFields));
  unique.sort();
  return JSON.stringify(unique);
}

function semanticIdentityMatches(row, { fieldsFingerprint, modelId, dimensions, distanceMetric }) {
  return !!row
    && row.fields_fingerprint === fieldsFingerprint
    && row.model_id === modelId
    && Number(row.dimensions) === dimensions
    && row.distance_metric === distanceMetric;
}

function jsonPathForTopLevelField(field) {
  return `$."${String(field).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function countIndexableSemanticValues({ db, connectorId, stream, declaredFields }) {
  const stmt = db.prepare(`
    SELECT COUNT(*) AS n
    FROM records
    WHERE connector_id = ?
      AND stream = ?
      AND deleted = 0
      AND json_type(record_json, ?) = 'text'
      AND length(json_extract(record_json, ?)) > 0
  `);
  let total = 0;
  for (const field of declaredFields) {
    const path = jsonPathForTopLevelField(field);
    total += Number(stmt.get(connectorId, stream, path, path)?.n || 0);
  }
  return total;
}

function backendStorageIdentity(b) {
  const parts = [
    `model=${b.model()}`,
    `dimensions=${b.dimensions()}`,
    `metric=${b.distanceMetric()}`,
  ];
  if (typeof b.profileId === 'function') {
    parts.push(`profile=${b.profileId()}`);
  }
  if (typeof b.dtype === 'function') {
    parts.push(`dtype=${b.dtype()}`);
  }
  return parts.join(';');
}

async function rebuildSemanticIndexForStream({
  connectorId,
  stream,
  declaredFields,
  recordsToScan = null,
  progressJob = null,
  existingKeys = null,
}) {
  const index = ensureVectorIndex();
  if (!index || !backend) return 0;

  const db = getDb();
  const PAGE = 500;
  let lastId = 0;
  let indexed = 0;
  let scanned = 0;
  for (;;) {
    const rows = db.prepare(`
      SELECT id, record_key, record_json
      FROM records
      WHERE connector_id = ?
        AND stream = ?
        AND deleted = 0
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(connectorId, stream, lastId, PAGE);
    if (rows.length === 0) break;
    const entries = [];
    for (const row of rows) {
      lastId = Number(row.id);
      let data;
      try {
        data = row.record_json ? JSON.parse(row.record_json) : null;
      } catch {
        continue;
      }
      for (const field of declaredFields) {
        const text = normalizeSemanticEmbeddingInput(data?.[field]);
        if (!text) continue;
        const scopeKey = encodeScopeKey(stream, field);
        if (existingKeys?.has(encodeVectorPairKey(scopeKey, row.record_key))) {
          continue;
        }
        const vector = await backend.embedDocument(text);
        entries.push({
          connectorId,
          scopeKey,
          recordKey: row.record_key,
          vector,
        });
      }
    }
    if (entries.length > 0 && typeof index.upsertMany === 'function') {
      await index.upsertMany(entries);
    } else {
      for (const entry of entries) {
        await index.upsert(entry);
      }
    }
    scanned += rows.length;
    indexed += entries.length;
    if (progressJob) {
      progressJob = updateBackfillJob(progressJob, {
        recordsScanned: scanned,
        recordsTotal: recordsToScan,
        indexedVectors: indexed,
      });
    }
    await yieldImmediate();
    if (rows.length < PAGE) break;
  }
  return indexed;
}

function upsertBackfillProgress(db, { connectorId, stream, fieldsFingerprint, modelId, dimensions, distanceMetric }) {
  db.prepare(`
    INSERT INTO semantic_search_backfill_progress(connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connector_id, stream) DO UPDATE SET
      fields_fingerprint = excluded.fields_fingerprint,
      model_id           = excluded.model_id,
      dimensions         = excluded.dimensions,
      distance_metric    = excluded.distance_metric,
      updated_at         = excluded.updated_at
  `).run(connectorId, stream, fieldsFingerprint, modelId, dimensions, distanceMetric, new Date().toISOString());
}

function deleteBackfillProgress(db, { connectorId, stream }) {
  db.prepare(`
    DELETE FROM semantic_search_backfill_progress
    WHERE connector_id = ? AND stream = ?
  `).run(connectorId, stream);
}

/**
 * Drift-detect + rebuild the semantic index for every participating stream
 * of a manifest. Parallel to lexicalIndexBackfillForManifest.
 *
 * Drift signals:
 *   1. fields_fingerprint mismatch (authoritative). Catches same-cardinality
 *      swaps like ['title'] → ['selftext'].
 *   2. model_id / dimensions / distance_metric mismatch (backend identity).
 *      Any change invalidates every row — the stored vectors were produced
 *      by a different model.
 *   3. Row-count guard for streams whose fingerprint already matches.
 *      A zero index is rebuilt only when records actually contain non-empty
 *      declared text; non-zero in-band counts are left alone to avoid
 *      destructive full-stream rebuilds from benign count skew.
 *
 * Streams that previously participated but no longer declare semantic_fields
 * have their stale index rows + meta dropped. Same pattern as lexical.
 *
 * Called from:
 *   - startServer (native mode)
 *   - registerConnector (polyfill mode)
 */
export async function semanticIndexBackfillForManifest({ manifest, log = () => {} } = {}) {
  if (!manifest?.connector_id || !Array.isArray(manifest?.streams)) return;
  if (!backend) return;
  activeBackfillCount += 1;
  const participatingStreams = manifest.streams.filter((mStream) => {
    const declaredFields = mStream?.query?.search?.semantic_fields;
    return Array.isArray(declaredFields) && declaredFields.length > 0;
  }).length;
  let progressJob = {
    id: `semantic_backfill_${nextBackfillJobId++}`,
    connectorId: manifest.connector_id,
    stream: null,
    phase: 'planning',
    manifestStreamsChecked: 0,
    manifestStreamsTotal: participatingStreams,
    recordsScanned: 0,
    recordsTotal: null,
    indexedVectors: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  backfillJobs.set(progressJob.id, progressJob);
  try {
  const connectorId = manifest.connector_id;
  const db = getDb();
  const index = ensureVectorIndex();
  if (!index) return;

  const currentModel = backendStorageIdentity(backend);
  const currentDims = backend.dimensions();
  const currentMetric = backend.distanceMetric();

  const visitedStreams = new Set();

  for (const mStream of manifest.streams) {
    const stream = mStream?.name;
    if (typeof stream !== 'string' || stream.length === 0) continue;
    visitedStreams.add(stream);

    const declaredFields = mStream?.query?.search?.semantic_fields;
    const isParticipating = Array.isArray(declaredFields) && declaredFields.length > 0;

    if (!isParticipating) {
      const staleRows = db.prepare(`
        SELECT stream FROM semantic_search_meta
        WHERE connector_id = ? AND stream = ?
        UNION
        SELECT stream FROM semantic_search_backfill_progress
        WHERE connector_id = ? AND stream = ?
      `).all(connectorId, stream, connectorId, stream);
      if (staleRows.length > 0) {
        log(`[PDPP] Semantic index: stream='${stream}' connector='${connectorId}' ` +
            `no longer declares semantic_fields — dropping stale index + meta/progress`);
        await index.deleteByConnectorStream({ connectorId, stream });
        db.prepare(`
          DELETE FROM semantic_search_meta
          WHERE connector_id = ? AND stream = ?
        `).run(connectorId, stream);
        deleteBackfillProgress(db, { connectorId, stream });
      }
      continue;
    }
    progressJob = updateBackfillJob(progressJob, {
      stream,
      phase: 'checking',
      manifestStreamsChecked: Math.min(progressJob.manifestStreamsChecked + 1, progressJob.manifestStreamsTotal),
      recordsScanned: 0,
      recordsTotal: null,
      indexedVectors: 0,
    });

    const newFingerprint = fingerprintSemanticFields(declaredFields);
    const metaRow = db.prepare(`
      SELECT fields_fingerprint, model_id, dimensions, distance_metric
      FROM semantic_search_meta
      WHERE connector_id = ? AND stream = ?
    `).get(connectorId, stream);
    const progressRow = db.prepare(`
      SELECT fields_fingerprint, model_id, dimensions, distance_metric
      FROM semantic_search_backfill_progress
      WHERE connector_id = ? AND stream = ?
    `).get(connectorId, stream);
    const currentIdentity = {
      fieldsFingerprint: newFingerprint,
      modelId: currentModel,
      dimensions: currentDims,
      distanceMetric: currentMetric,
    };
    const progressMatches = semanticIdentityMatches(progressRow, currentIdentity);

    const fingerprintChanged = !metaRow || metaRow.fields_fingerprint !== newFingerprint;
    const backendChanged = !metaRow
      || metaRow.model_id !== currentModel
      || Number(metaRow.dimensions) !== currentDims
      || metaRow.distance_metric !== currentMetric;

    let needsRebuild = fingerprintChanged || backendChanged || progressMatches;
    let canResume = progressMatches;

    if (!needsRebuild) {
      // Row-count guard. Exact semantic counts are expensive and brittle for
      // large local stores; use exact expected rows only to distinguish
      // "empty because no indexable text exists" from "empty because the index
      // was never built". Non-zero in-band counts are treated as usable.
      const recordCountRow = db.prepare(`
        SELECT COUNT(*) AS n
        FROM records
        WHERE connector_id = ? AND stream = ? AND deleted = 0
      `).get(connectorId, stream);
      const recordCount = Number(recordCountRow?.n || 0);

      // Index count across all declared (stream, field) scope_keys.
      let indexCount = 0;
      for (const field of declaredFields) {
        indexCount += index.countByConnectorScope(connectorId, encodeScopeKey(stream, field));
      }
      const maxIndexRows = recordCount * declaredFields.length;
      const expectedIndexRows = indexCount === 0 || indexCount > maxIndexRows
        ? countIndexableSemanticValues({ db, connectorId, stream, declaredFields })
        : null;
      const inSync = indexCount > 0
        ? indexCount <= maxIndexRows
        : expectedIndexRows === 0;
      needsRebuild = !inSync;
      if (needsRebuild) {
        canResume = false;
        log(`[PDPP] Semantic index drift for ${connectorId} stream='${stream}' ` +
            `(records=${recordCount}, index=${indexCount}, expected=${expectedIndexRows ?? 'not_checked'}, max=${maxIndexRows}) — rebuilding`);
      } else if (progressRow) {
        deleteBackfillProgress(db, { connectorId, stream });
      }
    } else if (canResume) {
      log(`[PDPP] Semantic index resume for ${connectorId} stream='${stream}' ` +
          `(fields=${newFingerprint}, model=${currentModel}, dims=${currentDims}, metric=${currentMetric})`);
    } else if (fingerprintChanged) {
      log(`[PDPP] Semantic index field-set change for ${connectorId} stream='${stream}' ` +
          `(was=${metaRow?.fields_fingerprint ?? 'null'}, now=${newFingerprint}) — rebuilding`);
    } else if (backendChanged) {
      log(`[PDPP] Semantic index backend identity changed for ${connectorId} stream='${stream}' ` +
          `(model=${metaRow?.model_id ?? 'null'}→${currentModel}, ` +
          `dims=${metaRow?.dimensions ?? 'null'}→${currentDims}, ` +
          `metric=${metaRow?.distance_metric ?? 'null'}→${currentMetric}) — rebuilding`);
    }

    if (!needsRebuild) continue;

    upsertBackfillProgress(db, { connectorId, stream, ...currentIdentity });
    let existingKeys = null;
    if (canResume && typeof index.listExistingKeys === 'function') {
      existingKeys = await index.listExistingKeys({ connectorId, stream });
    } else {
      await index.deleteByConnectorStream({ connectorId, stream });
    }

    const recordCountRow = db.prepare(`
      SELECT COUNT(*) AS n
      FROM records
      WHERE connector_id = ? AND stream = ? AND deleted = 0
    `).get(connectorId, stream);
    const recordsToScan = Number(recordCountRow?.n || 0);
    progressJob = updateBackfillJob(progressJob, {
      stream,
      phase: 'rebuilding',
      recordsScanned: 0,
      recordsTotal: recordsToScan,
      indexedVectors: 0,
    });
    log(`[PDPP] Semantic index rebuild starting for ${connectorId} stream='${stream}' ` +
        `(records=${recordsToScan}, fields=${declaredFields.length}, mode=${canResume ? 'resume' : 'fresh'})`);
    const indexed = await rebuildSemanticIndexForStream({
      connectorId,
      stream,
      declaredFields,
      recordsToScan,
      progressJob,
      existingKeys,
    });
    log(`[PDPP] Semantic index rebuild completed for ${connectorId} stream='${stream}' ` +
        `(records=${recordsToScan}, indexed=${indexed})`);

    db.prepare(`
      INSERT INTO semantic_search_meta(connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id, stream) DO UPDATE SET
        fields_fingerprint = excluded.fields_fingerprint,
        model_id           = excluded.model_id,
        dimensions         = excluded.dimensions,
        distance_metric    = excluded.distance_metric,
        updated_at         = excluded.updated_at
    `).run(connectorId, stream, newFingerprint, currentModel, currentDims, currentMetric, new Date().toISOString());
    deleteBackfillProgress(db, { connectorId, stream });
  }
  progressJob = updateBackfillJob(progressJob, {
    stream: null,
    phase: 'cleanup',
    recordsScanned: 0,
    recordsTotal: null,
    indexedVectors: 0,
  });

  // Orphan rows: streams that previously had complete meta or in-progress
  // progress but are gone from the manifest entirely.
  const orphanRows = db.prepare(`
    SELECT stream FROM semantic_search_meta WHERE connector_id = ?
    UNION
    SELECT stream FROM semantic_search_backfill_progress WHERE connector_id = ?
  `).all(connectorId, connectorId);
  for (const row of orphanRows) {
    if (visitedStreams.has(row.stream)) continue;
    log(`[PDPP] Semantic index: stream='${row.stream}' connector='${connectorId}' ` +
        `no longer in manifest — dropping stale index + meta/progress`);
    await index.deleteByConnectorStream({ connectorId, stream: row.stream });
    db.prepare(`
      DELETE FROM semantic_search_meta
      WHERE connector_id = ? AND stream = ?
    `).run(connectorId, row.stream);
    deleteBackfillProgress(db, { connectorId, stream: row.stream });
  }
  } finally {
    activeBackfillCount = Math.max(0, activeBackfillCount - 1);
    backfillJobs.delete(progressJob.id);
  }
}

/**
 * Compute the honest index_state for the advertisement. Walks
 * semantic_search_meta for the configured connectors and compares the
 * persisted (model_id, dimensions, distance_metric) against the currently
 * configured backend. Any mismatch ⇒ stale.
 *
 * Returns 'built' | 'building' | 'stale'.
 */
export function computeIndexState() {
  if (!backend) return 'stale';
  if (isSemanticIndexBackfillActive()) return 'building';
  const db = getDb();
  const progressRow = db.prepare(`
    SELECT 1 AS n
    FROM semantic_search_backfill_progress
    LIMIT 1
  `).get();
  if (progressRow) return 'stale';
  const rows = db.prepare(`
    SELECT model_id, dimensions, distance_metric
    FROM semantic_search_meta
  `).all();
  // No meta rows means nothing has been backfilled yet. If any participating
  // manifest exists, backfill hasn't run → stale. If no manifests declare
  // semantic_fields at all, there's nothing to index and "built" is honest.
  // We can't cheaply tell these apart here, but the boot path always calls
  // semanticIndexBackfillForManifest before advertising, so "built" is the
  // right steady-state answer when meta is empty.
  if (rows.length === 0) return 'built';
  const currentStorageIdentity = backendStorageIdentity(backend);
  const currentDims = backend.dimensions();
  const currentMetric = backend.distanceMetric();
  for (const row of rows) {
    if (
      row.model_id !== currentStorageIdentity
      || Number(row.dimensions) !== currentDims
      || row.distance_metric !== currentMetric
    ) {
      return 'stale';
    }
  }
  return 'built';
}

// ─── Public-route entry point ──────────────────────────────────────────────

const ALLOWED_PARAMS = new Set(['q', 'limit', 'cursor', 'streams', 'streams[]', 'filter']);

// Parameters that MUST be rejected explicitly (not silently ignored). Some
// of these overlap with "anything not in ALLOWED_PARAMS" — the explicit list
// makes the rejection intentional and visible in source.
const FORBIDDEN_PARAMS = new Set([
  'vector', 'embedding', 'embed',
  'model', 'model_id', 'model_family',
  'rank', 'boost', 'weights', 'blend',
  'connector_id',
  'fields', 'expand', 'expand[]', 'expand_limit', 'expand_limit[]',
  'order', 'sort', 'mode',
]);

export function parseSemanticSearchParams(query) {
  for (const key of Object.keys(query)) {
    if (FORBIDDEN_PARAMS.has(key)) {
      const err = new Error(`Unsupported query parameter: ${key}`);
      err.code = 'invalid_request';
      err.param = key;
      throw err;
    }
    if (!ALLOWED_PARAMS.has(key)) {
      const err = new Error(`Unsupported query parameter: ${key}`);
      err.code = 'invalid_request';
      err.param = key;
      throw err;
    }
  }
  const q = typeof query.q === 'string' ? query.q : '';
  if (!q) {
    const err = new Error('q is required');
    err.code = 'invalid_request';
    err.param = 'q';
    throw err;
  }
  const limit = clampLimit(query.limit);
  const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor : null;
  const streams = normalizeStreamsParam(query.streams ?? query['streams[]']);
  const hasFilter = Object.prototype.hasOwnProperty.call(query, 'filter');
  if (hasFilter && (!streams || streams.length !== 1)) {
    const err = new Error(
      "filter[...] requires exactly one streams[] value (e.g. ?streams[]=messages&filter[received_at][gte]=...). filter[stream] and filter[connector_id] are not supported.",
    );
    err.code = 'invalid_request';
    err.param = 'streams';
    throw err;
  }
  return {
    q,
    limit,
    cursor,
    streams,
    filter: hasFilter ? query.filter : null,
    filteredStream: hasFilter ? streams[0] : null,
  };
}

function clampLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return 25;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 25;
  return Math.min(Math.floor(n), 100);
}

function normalizeStreamsParam(raw) {
  if (raw === undefined || raw === null) return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  const cleaned = arr
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Build a per-connector plan: for each participating stream in the manifest
 * that is in the grant and has at least one (declared semantic_fields ∩
 * grant projection) field, include an entry with the scope_keys.
 *
 * Field gating happens HERE — before any embedding or index call. There is
 * no code path that asks the index about an unauthorized or undeclared
 * field. This is the structural realization of the spec's "no embed
 * everything, filter later" rule.
 */
function compileSingleStreamSearchFilter({ manifest, grant, streamName, filter }) {
  if (!streamName) return null;
  const manifestStream = (manifest?.streams || []).find((s) => s.name === streamName);
  if (!manifestStream) return null;
  const streamGrant = (grant?.streams || []).find((s) => s.name === streamName);
  if (!streamGrant) return null;
  return {
    streamName,
    filters: compileRequestFilters(filter, streamGrant, manifestStream),
  };
}

function hasGrantRecordConstraints(streamGrant) {
  return !!(
    streamGrant?.time_range
    || (Array.isArray(streamGrant?.resources) && streamGrant.resources.length > 0)
  );
}

function buildCandidateRecordKeys({ connectorId, streamName, streamGrant, manifestStream, compiledFilters }) {
  const needsRecordScan = compiledFilters?.length || hasGrantRecordConstraints(streamGrant);
  if (!needsRecordScan) return null;

  const db = getDb();
  const where = ['connector_id = ?', 'stream = ?', 'deleted = 0'];
  const binds = [connectorId, streamName];
  if (Array.isArray(streamGrant?.resources) && streamGrant.resources.length > 0) {
    where.push(`record_key IN (${streamGrant.resources.map(() => '?').join(', ')})`);
    binds.push(...streamGrant.resources);
  }

  const rows = db.prepare(`
    SELECT record_key, record_json
    FROM records
    WHERE ${where.join(' AND ')}
  `).all(...binds);

  const allowed = [];
  for (const row of rows) {
    let data;
    try {
      data = row.record_json ? JSON.parse(row.record_json) : null;
    } catch {
      continue;
    }
    if (!passesGrantRecordConstraints(data, row.record_key, streamGrant, manifestStream)) continue;
    if (!passesRequestFilters(data, compiledFilters)) continue;
    allowed.push(row.record_key);
  }
  return allowed;
}

export function buildSemanticSearchPlanForGrant({ manifest, grant, streamsFilter, compiledFilter = null, connectorId = null }) {
  if (!manifest?.streams || !grant?.streams) return [];
  const plan = [];
  for (const mStream of manifest.streams) {
    const declared = mStream?.query?.search?.semantic_fields;
    if (!Array.isArray(declared) || declared.length === 0) continue;
    if (streamsFilter && !streamsFilter.includes(mStream.name)) continue;

    const streamGrant = grant.streams.find((s) => s.name === mStream.name);
    if (!streamGrant) continue;

    const grantedFields = Array.isArray(streamGrant.fields) && streamGrant.fields.length > 0
      ? new Set(streamGrant.fields)
      : null;
    const searchable = grantedFields
      ? declared.filter((f) => grantedFields.has(f))
      : declared.slice();
    if (searchable.length === 0) continue;
    const filters = compiledFilter?.streamName === mStream.name ? compiledFilter.filters : [];
    const candidateRecordKeys = connectorId
      ? buildCandidateRecordKeys({
        connectorId,
        streamName: mStream.name,
        streamGrant,
        manifestStream: mStream,
        compiledFilters: filters,
      })
      : null;

    plan.push({
      streamName: mStream.name,
      searchableFields: searchable,
      scopeKeys: searchable.map((f) => encodeScopeKey(mStream.name, f)),
      ...(candidateRecordKeys ? { candidateRecordKeys } : {}),
    });
  }
  return plan;
}

function resolveSemanticRetrievalAdvertisement(opts) {
  if (opts?.semanticRetrievalCapability) return opts.semanticRetrievalCapability;
  if (opts?.semanticRetrievalSupported === false) return null;
  if (!backend) return null;
  const profileId = typeof backend.profileId === 'function' ? backend.profileId() : null;
  const dtype = typeof backend.dtype === 'function' ? backend.dtype() : null;
  const model = backend.model();
  const dimensions = backend.dimensions();
  const distanceMetric = backend.distanceMetric();
  return {
    supported: true,
    cross_stream: true,
    default_limit: 25,
    max_limit: 100,
    score: {
      supported: true,
      kind: 'semantic_distance',
      order: 'lower_is_better',
      value_semantics: 'distance',
      comparable_with: {
        backend_identity: [
          profileId ? `profile=${profileId}` : null,
          `model=${model}`,
          dtype ? `dtype=${dtype}` : null,
          `dimensions=${dimensions}`,
          `metric=${distanceMetric}`,
        ].filter(Boolean).join(';'),
        model,
        dimensions,
        distance_metric: distanceMetric,
        ...(profileId ? { profile_id: profileId } : {}),
        ...(dtype ? { dtype } : {}),
      },
    },
  };
}

function advertisesSemanticScore(advertisement) {
  return !!(
    advertisement
    && advertisement.supported !== false
    && advertisement.score?.supported === true
    && advertisement.score.kind === 'semantic_distance'
    && advertisement.score.order === 'lower_is_better'
  );
}

/**
 * The single helper the GET /v1/search/semantic route delegates to.
 */
export async function runSemanticSearch({
  req,
  opts,
  tokenInfo,
  resolveOwnerVisibleConnectorIds,
  resolveOwnerScopeForConnector,
  resolveOwnerManifestFromScope,
  buildOwnerReadGrantForManifest,
  resolveGrantManifest,
}) {
  if (!backend || !backend.available()) {
    // Route registration should prevent reaching this helper when no backend
    // is configured, but defend in depth.
    const err = new Error('semantic retrieval is not configured');
    err.code = 'not_found';
    throw err;
  }

  const params = parseSemanticSearchParams(req.query);

  const advertisement = resolveSemanticRetrievalAdvertisement(opts);
  if (
    advertisement
    && advertisement.cross_stream === false
    && (!params.streams || params.streams.length === 0)
  ) {
    const err = new Error('streams[] is required when cross_stream search is disabled');
    err.code = 'invalid_request';
    err.param = 'streams';
    throw err;
  }

  const isOwner = tokenInfo.pdpp_token_kind === 'owner';

  // Per-mode planning (mirrors runLexicalSearch).
  let perConnectorPlans;
  if (isOwner) {
    const connectorIds = await resolveOwnerVisibleConnectorIds();
    perConnectorPlans = [];
    for (const connectorId of connectorIds) {
      let manifest;
      try {
        const ownerScope = resolveOwnerScopeForConnector(connectorId);
        const resolved = await resolveOwnerManifestFromScope(ownerScope);
        manifest = resolved.manifest;
      } catch {
        continue;
      }
      const grant = buildOwnerReadGrantForManifest(manifest);
      const compiledFilter = compileSingleStreamSearchFilter({
        manifest,
        grant,
        streamName: params.filteredStream,
        filter: params.filter,
      });
      const planEntries = buildSemanticSearchPlanForGrant({
        manifest,
        grant,
        streamsFilter: params.streams,
        compiledFilter,
        connectorId,
      });
      if (planEntries.length === 0) continue;
      perConnectorPlans.push({ connectorId, manifest, grant, planEntries });
    }
  } else {
    const grantResolved = await resolveGrantManifest(tokenInfo);
    const manifest = grantResolved.manifest;
    const grant = tokenInfo.grant;
    const connectorId = grant?.source?.connector_id ?? null;

    if (params.streams) {
      for (const s of params.streams) {
        const inGrant = (grant?.streams || []).some((g) => g.name === s);
        if (!inGrant) {
          const err = new Error(`Stream '${s}' not in grant`);
          err.code = 'grant_stream_not_allowed';
          throw err;
        }
      }
    }

    const planEntries = buildSemanticSearchPlanForGrant({
      manifest,
      grant,
      streamsFilter: params.streams,
      compiledFilter: compileSingleStreamSearchFilter({
        manifest,
        grant,
        streamName: params.filteredStream,
        filter: params.filter,
      }),
      connectorId,
    });
    perConnectorPlans = planEntries.length === 0
      ? []
      : [{ connectorId, manifest, grant, planEntries }];
  }

  // Resolve cursor → snapshot.
  let snapshotId;
  let snapshot;
  if (params.cursor) {
    const decoded = decodeSemanticSearchCursor(params.cursor);
    if (!decoded) {
      const err = new Error('Cursor is malformed');
      err.code = 'invalid_cursor';
      throw err;
    }
    snapshotId = decoded.snap;
    snapshot = await loadSemanticSnapshot(snapshotId);
    if (!snapshot) {
      const err = new Error('Cursor refers to an expired or unknown snapshot');
      err.code = 'invalid_cursor';
      throw err;
    }
    // Stale-cursor check: backend identity on the snapshot must match the
    // current backend. Any divergence ⇒ invalid_cursor (the spec permits
    // this, and recomputing under a different model would be dishonest).
    const currentBackendHash = hashBackendIdentity(backend);
    if (snapshot.backend_hash !== currentBackendHash) {
      const err = new Error('Cursor predates a backend identity change');
      err.code = 'invalid_cursor';
      throw err;
    }
  } else {
    snapshot = await buildSemanticSnapshot({
      q: params.q,
      perConnectorPlans,
      isOwner,
    });
    snapshotId = snapshot.snapshot_id;
    await persistSemanticSnapshot(snapshot);
  }

  const offset = params.cursor
    ? (decodeSemanticSearchCursor(params.cursor)?.off ?? 0)
    : 0;
  const limit = params.limit;
  const allHits = snapshot.results;
  const slice = allHits.slice(offset, offset + limit);
  const hasMore = offset + limit < allHits.length;
  const nextCursor = hasMore
    ? encodeSemanticSearchCursor({ snap: snapshotId, off: offset + limit })
    : null;

  // Hydrate verbatim grant-safe snippets and build search_result objects.
  const emitScore = advertisesSemanticScore(advertisement);
  const data = [];
  for (const hit of slice) {
    data.push(await buildSemanticSearchResult({ hit, isOwner, emitScore }));
  }

  return {
    envelope: {
      object: 'list',
      url: '/v1/search/semantic',
      has_more: hasMore,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      data,
    },
    disclosureData: {
      query_shape: 'search_semantic',
      record_count: data.length,
      has_more: hasMore,
      mode: isOwner ? 'owner' : 'client',
      connector_count: perConnectorPlans.length,
    },
  };
}

// ─── Snapshot building ─────────────────────────────────────────────────────

/**
 * Build a snapshot of the full ranked result set. Per-connector KNN is
 * issued in parallel; each connector's hits are merged under the total
 * order (distance, connector_id, scope_key, record_key). The snapshot
 * stores enough to page without re-embedding or re-querying.
 *
 * Honest index_state check is implicit: a 'stale' backfill state would be
 * surfaced in the advertisement, but the route runs regardless — the hits
 * are honestly computed semantic hits from the records we have, and no
 * non-semantic fallback is substituted. This realizes the spec scenario
 * "SHALL NOT silently substitute a non-semantic fallback": if the index
 * rows don't exist, hits are absent (empty data) but retrieval_mode still
 * says semantic on any hits that do come back.
 */
async function buildSemanticSnapshot({ q, perConnectorPlans, isOwner }) {
  const queryVector = await backend.embedQuery(normalizeSemanticEmbeddingInput(q) ?? '');
  const index = ensureVectorIndex();

  // Configurable KNN overscan — we fetch more per connector than the final
  // page needs so the merged top-N is accurate. Matches the lexical
  // snapshot's approach of caching a reasonable upper bound.
  const PER_CONNECTOR_LIMIT = 200;

  const perConnectorHits = await Promise.all(
    perConnectorPlans.map(async ({ connectorId, planEntries }) => {
      const entryHits = [];
      for (const entry of planEntries) {
        if (entry.scopeKeys.length === 0) continue;
        entryHits.push(...await index.queryPerConnector({
          connectorId,
          scopeKeys: entry.scopeKeys,
          queryVector,
          limit: PER_CONNECTOR_LIMIT,
          recordKeys: entry.candidateRecordKeys,
        }));
      }
      return entryHits.sort(compareHits).slice(0, PER_CONNECTOR_LIMIT);
    }),
  );

  // Merge under total order.
  const merged = perConnectorHits.flat().sort(compareHits);

  // Collapse per-record hits: a record can match multiple fields (multiple
  // scope_keys), so one (connector, stream, record_key) maps to multiple
  // raw hits. Preserve the best (smallest) distance and union the matched
  // fields. The collapsed list is re-sorted under the same total order so
  // ties resolve deterministically.
  const collapsed = new Map();
  for (const hit of merged) {
    const [stream, field] = JSON.parse(hit.scopeKey);
    // Use an explicit escaped separator so the source file stays plain text
    // while the composite key remains unambiguous.
    const collapseKey = `${hit.connectorId}\u0000${stream}\u0000${hit.recordKey}`;
    const existing = collapsed.get(collapseKey);
    if (existing) {
      if (!existing.matchedFields.includes(field)) {
        existing.matchedFields.push(field);
      }
      if (hit.distance < existing.distance) {
        existing.distance = hit.distance;
        existing.topField = field;
      }
    } else {
      collapsed.set(collapseKey, {
        connectorId: hit.connectorId,
        stream,
        recordKey: hit.recordKey,
        matchedFields: [field],
        distance: hit.distance,
        topField: field,
        // scope_key of the current best field — used for the total-order
        // comparison at collapse time.
        scopeKey: hit.scopeKey,
      });
    }
  }
  const collapsedArr = Array.from(collapsed.values()).sort(compareHits);

  return {
    snapshot_id: generateSnapshotId(),
    query: q,
    plan_hash: hashSemanticPlan({ perConnectorPlans, isOwner }),
    backend_hash: hashBackendIdentity(backend),
    results: collapsedArr,
  };
}

// ─── search_result shaping + grant-safe snippets ───────────────────────────

async function buildSemanticSearchResult({ hit, isOwner, emitScore }) {
  const recordPath = `/v1/streams/${encodeURIComponent(hit.stream)}/records/${encodeURIComponent(hit.recordKey)}`;
  const recordUrl = isOwner
    ? `${recordPath}?connector_id=${encodeURIComponent(hit.connectorId)}`
    : recordPath;

  // Hydrate the emitted_at + snippet source text from the records table.
  // Snippet is a verbatim contiguous substring of the matched field's stored
  // value. NEVER a paraphrase, summary, or model-generated text.
  const db = getDb();
  const recordRow = db.prepare(`
    SELECT emitted_at, record_json FROM records
    WHERE connector_id = ? AND stream = ? AND record_key = ? AND deleted = 0
  `).get(hit.connectorId, hit.stream, hit.recordKey);

  const emittedAt = recordRow?.emitted_at ?? null;
  let snippet;
  if (recordRow?.record_json) {
    try {
      const data = JSON.parse(recordRow.record_json);
      const value = data?.[hit.topField];
      if (typeof value === 'string' && value.length > 0) {
        snippet = { field: hit.topField, text: pickVerbatimExcerpt(value) };
      }
    } catch {
      // Corrupt record_json — skip snippet rather than fabricate.
    }
  }

  const result = {
    object: 'search_result',
    stream: hit.stream,
    record_key: hit.recordKey,
    connector_id: hit.connectorId,
    record_url: recordUrl,
    emitted_at: emittedAt,
    matched_fields: hit.matchedFields,
    retrieval_mode: 'semantic', // v1: lexical_blending is false
  };
  if (emitScore && Number.isFinite(hit.distance)) {
    result.score = {
      kind: 'semantic_distance',
      value: hit.distance,
      order: 'lower_is_better',
    };
  }
  if (snippet) result.snippet = snippet;
  return result;
}

/**
 * Pick a verbatim excerpt from `text`. Contract: the returned string MUST
 * be a contiguous substring of `text`. No paraphrase, no summary, no model
 * generation.
 *
 * v1 heuristic: return up to the first ~160 characters, trimmed to a word
 * boundary when possible. Simple and honest. Future tranches may replace
 * this with query-aware extraction — still verbatim.
 */
function pickVerbatimExcerpt(text) {
  const MAX = 160;
  if (text.length <= MAX) return text;
  const head = text.slice(0, MAX);
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace > 40) return head.slice(0, lastSpace) + '…';
  return head + '…';
}

// ─── Snapshot persistence + cursor encoding ────────────────────────────────

const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateSnapshotId() {
  return `snap_${randomBytes(8).toString('hex')}`;
}

function hashSemanticPlan({ perConnectorPlans, isOwner }) {
  const summary = perConnectorPlans.map((p) => ({
    c: p.connectorId,
    e: p.planEntries.map((pe) => ({
      s: pe.streamName,
      f: pe.searchableFields.slice().sort(),
    })),
  }));
  return JSON.stringify({ isOwner, summary });
}

function hashBackendIdentity(b) {
  return JSON.stringify({
    identity: backendStorageIdentity(b),
  });
}

async function persistSemanticSnapshot(snapshot) {
  const db = getDb();
  db.prepare(`
    INSERT INTO semantic_search_snapshots(snapshot_id, query, plan_hash, results_json)
    VALUES(?, ?, ?, ?)
  `).run(
    snapshot.snapshot_id,
    snapshot.query,
    // Store backend_hash alongside plan_hash so stale-cursor detection is
    // deterministic across restarts — the snapshot row is the source of
    // truth about what backend produced the cached distances.
    JSON.stringify({ plan: snapshot.plan_hash, backend: snapshot.backend_hash }),
    JSON.stringify(snapshot.results),
  );
}

async function loadSemanticSnapshot(snapshotId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT snapshot_id, query, plan_hash, results_json, created_at
    FROM semantic_search_snapshots
    WHERE snapshot_id = ?
  `).all(snapshotId);
  if (rows.length === 0) return null;
  const row = rows[0];
  const createdAt = new Date(row.created_at + 'Z').getTime();
  if (Number.isFinite(createdAt) && Date.now() - createdAt > SNAPSHOT_TTL_MS) {
    return null;
  }
  let planEnvelope;
  try {
    planEnvelope = JSON.parse(row.plan_hash);
  } catch {
    return null;
  }
  return {
    snapshot_id: row.snapshot_id,
    query: row.query,
    plan_hash: planEnvelope.plan,
    backend_hash: planEnvelope.backend,
    results: JSON.parse(row.results_json),
  };
}

/**
 * Semantic cursors are prefixed to distinguish them from lexical cursors
 * on the wire. The prefix is checked in decode; a cursor without the
 * prefix is rejected as invalid_cursor. This realizes the spec scenario
 * "cursor from /v1/search passed to /v1/search/semantic → invalid_cursor".
 */
const SEMANTIC_CURSOR_PREFIX = 'sem1.';

function encodeSemanticSearchCursor({ snap, off }) {
  const json = JSON.stringify({ snap, off });
  return SEMANTIC_CURSOR_PREFIX + Buffer.from(json, 'utf8').toString('base64url');
}

function decodeSemanticSearchCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.startsWith(SEMANTIC_CURSOR_PREFIX)) {
    return null;
  }
  try {
    const body = cursor.slice(SEMANTIC_CURSOR_PREFIX.length);
    const json = Buffer.from(body, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (typeof parsed.snap !== 'string' || typeof parsed.off !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}
