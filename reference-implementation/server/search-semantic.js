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
import { LocalTransformerExecutor } from './local-transformer-executor.ts';
import { withConnectorInstanceWrite } from './connector-instance-write-coordinator.ts';
import {
  allowUnboundedReadAcknowledged,
  exec,
  execDynamicSqlAcknowledged,
  getMany,
  getOne,
  iterateDynamicSqlAcknowledged,
  referenceQueries,
  transaction,
} from '../lib/db.ts';
import {
  executeSearchSemantic,
  parseSearchSemanticParams,
  SearchSemanticRequestError,
} from '../operations/rs-search-semantic/index.ts';
import { getConnectorManifest } from './auth.js';
import { assertGrantedManifestReadAuthority } from './manifest-read-authority.ts';
import { getDb } from './db.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import { sqliteCountIndexableTextValues } from './search-index-counts.ts';
import {
  compileRequestFilters,
  passesGrantRecordConstraints,
  passesRequestFilters,
} from './record-filters.js';
import {
  postgresAnySemanticProgressRow,
  postgresSemanticIndexDelete,
  postgresSemanticIndexDeleteByConnectorStream,
  postgresSemanticIndexInsertMany,
  postgresSemanticIndexUpsertMany,
  postgresSemanticSearch,
  postgresGetSemanticRecord,
  postgresCountIndexableSemanticValues,
  postgresCountSemanticIndexByScope,
  postgresCountSemanticRecords,
  postgresDeleteSemanticMeta,
  postgresDeleteSemanticProgress,
  postgresGetSemanticMeta,
  postgresGetSemanticProgress,
  postgresListAllSemanticMetaIdentities,
  postgresListExistingSemanticKeys,
  postgresListSemanticConnectorInstanceIds,
  postgresListSemanticStreamsForConnector,
  postgresSemanticRecordsPage,
  postgresUpsertSemanticMeta,
  postgresUpsertSemanticProgress,
} from './postgres-search.js';
import { isPostgresStorageBackend, postgresQuery } from './postgres-storage.js';
import {
  listActiveOwnerBindingsForConnectors,
  resolveDisplayNamesForBindings,
  resolveFanInBindings,
} from './connection-identity.js';
import { mapSearchFanout } from './search-fanout.ts';

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
    supportsDeviceAttemptDeadline: () => true,
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
// The child-executor receipt found no work limit that was materially faster
// than one across two warmed rounds, so reliability wins by default.
const DEFAULT_SEMANTIC_WORK_LIMIT = 1;
const DEFAULT_SEMANTIC_WORK_QUEUE_LIMIT = 16;
const DEFAULT_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS = 30_000;
const TRANSIENT_LOCAL_EXECUTOR_CODES = new Set([
  'transformer_deadline',
  'transformer_child_exited',
  'transformer_child_io_failed',
  'transformer_terminating',
  'transformer_spawn_failed',
  'transformer_work_busy',
]);
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

export class SemanticWorkAdmissionError extends Error {
  constructor() {
    super('semantic index work is saturated');
    this.name = 'SemanticWorkAdmissionError';
    this.code = 'semantic_work_busy';
  }
}

let activeSemanticWork = 0;
const semanticWorkWaiters = [];

function configuredSemanticWorkLimit() {
  const requested = parsePositiveInteger(
    process.env.PDPP_SEMANTIC_WORK_LIMIT,
    DEFAULT_SEMANTIC_WORK_LIMIT,
    'PDPP_SEMANTIC_WORK_LIMIT',
  );
  // The operational benchmark selects a value from this explicit set. Eight
  // is a hard ceiling so request fan-out cannot overrun the local model host.
  return [1, 2, 4, 8].includes(requested) ? requested : DEFAULT_SEMANTIC_WORK_LIMIT;
}

function configuredSemanticWorkQueueLimit() {
  return parsePositiveInteger(
    process.env.PDPP_SEMANTIC_WORK_QUEUE_LIMIT,
    DEFAULT_SEMANTIC_WORK_QUEUE_LIMIT,
    'PDPP_SEMANTIC_WORK_QUEUE_LIMIT',
  );
}

function configuredSemanticWorkAcquireDeadlineMs() {
  return parsePositiveInteger(
    process.env.PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS,
    DEFAULT_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS,
    'PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS',
  );
}

function removeSemanticWorkWaiter(waiter) {
  const index = semanticWorkWaiters.indexOf(waiter);
  if (index >= 0) {
    semanticWorkWaiters.splice(index, 1);
  }
}

async function acquireSemanticWork() {
  if (activeSemanticWork < configuredSemanticWorkLimit() && semanticWorkWaiters.length === 0) {
    activeSemanticWork += 1;
    return;
  }
  if (semanticWorkWaiters.length >= configuredSemanticWorkQueueLimit()) {
    throw new SemanticWorkAdmissionError();
  }
  await new Promise((resolve, reject) => {
    const waiter = {
      settled: false,
      resolve: () => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        resolve();
      },
      timer: setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        removeSemanticWorkWaiter(waiter);
        reject(new SemanticWorkAdmissionError());
      }, configuredSemanticWorkAcquireDeadlineMs()),
    };
    semanticWorkWaiters.push(waiter);
  });
}

function releaseSemanticWork() {
  while (semanticWorkWaiters.length > 0) {
    const next = semanticWorkWaiters.shift();
    if (!next || next.settled) continue;
    next.resolve();
    return;
  }
  activeSemanticWork = Math.max(0, activeSemanticWork - 1);
}

async function embedWithSemanticAdmission(operation) {
  await acquireSemanticWork();
  try {
    return await operation();
  } finally {
    releaseSemanticWork();
  }
}

async function embedDocumentWithAdmission(text) {
  return embedWithSemanticAdmission(() => backend.embedDocument(text));
}

async function embedQueryWithAdmission(text) {
  return embedWithSemanticAdmission(() => backend.embedQuery(text));
}

export function semanticWorkStatsForTests() {
  return { active: activeSemanticWork, queued: semanticWorkWaiters.length };
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
 * A credential-free OS child owns the model and is fenced on every deadline;
 * the parent lazily starts it on first semantic index/query work.
 */
export function makeLocalTransformerBackend(config = resolveLocalEmbeddingProfile(), { executorOptions = {} } = {}) {
  let lastLoadError = null;
  const executor = new LocalTransformerExecutor(executorOptions);

  async function embed(text) {
    try {
      return normalizeEmbeddingVector(
        await executor.embed(String(text || ''), `${config.profileId}:${config.modelId}:${config.dtype}:${config.dimensions}:${config.distanceMetric}`, config),
        config.dimensions,
      );
    } catch (err) {
      // A confirmed child deadline/exit or bounded admission rejection fences
      // only the current generation. The executor can start a replacement
      // generation after its exit is confirmed, so these transient lifecycle
      // outcomes must not deadlock semantic preflight on `available() ===
      // false`. Model-load/shape failures remain sticky and fail safely until
      // the backend is reconfigured; missing cache is independently rejected
      // by the normal availability check below.
      const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
      if (typeof code !== 'string' || !TRANSIENT_LOCAL_EXECUTOR_CODES.has(code)) {
        lastLoadError = err;
      }
      throw err;
    }
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
    supportsDeviceAttemptDeadline: () => true,
    executionTelemetry: () => executor.telemetry(),
    resetExecutionTelemetry: () => executor.resetTelemetry(),
    close: () => executor.close(),
  };
}

export function resolveSemanticBackendFromEnv(env = process.env) {
  const defaultMode = env.PDPP_REFERENCE_OPERATIONAL_DEFAULTS === '1' ? 'local' : 'stub';
  const mode = (env[EMBEDDING_BACKEND_ENV] || defaultMode).trim().toLowerCase();
  if (['0', 'false', 'off', 'none', 'disabled'].includes(mode)) return null;
  if (['local', 'transformers', 'transformers-js'].includes(mode)) {
    if (env.NODE_ENV === 'production' && env.PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT !== '1') {
      throw new Error('production local semantic execution requires PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1');
    }
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
const semanticQueryVectorCache = new Map();
const DEFAULT_SEMANTIC_QUERY_VECTOR_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_SEMANTIC_QUERY_VECTOR_CACHE_MAX = 128;

function semanticQueryVectorCacheTtlMs({ env = process.env } = {}) {
  const parsed = Number.parseInt(env.PDPP_SEMANTIC_QUERY_VECTOR_CACHE_MS || '', 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return DEFAULT_SEMANTIC_QUERY_VECTOR_CACHE_MS;
}

function semanticQueryVectorCacheMax({ env = process.env } = {}) {
  const parsed = Number.parseInt(env.PDPP_SEMANTIC_QUERY_VECTOR_CACHE_MAX || '', 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return DEFAULT_SEMANTIC_QUERY_VECTOR_CACHE_MAX;
}

function pruneSemanticQueryVectorCache(maxEntries) {
  while (semanticQueryVectorCache.size > maxEntries) {
    const oldestKey = semanticQueryVectorCache.keys().next().value;
    if (!oldestKey) return;
    semanticQueryVectorCache.delete(oldestKey);
  }
}

async function embedSemanticQueryWithCache(input) {
  const text = normalizeSemanticEmbeddingInput(input) ?? '';
  const ttlMs = semanticQueryVectorCacheTtlMs();
  const maxEntries = semanticQueryVectorCacheMax();
  if (ttlMs === 0 || maxEntries === 0) {
    return embedQueryWithAdmission(text);
  }

  const key = `${hashBackendIdentity(backend)}\u0000${text}`;
  const now = Date.now();
  const existing = semanticQueryVectorCache.get(key);
  if (existing && existing.expiresAt > now) {
    // Refresh insertion order for a tiny LRU.
    semanticQueryVectorCache.delete(key);
    semanticQueryVectorCache.set(key, existing);
    return existing.promise;
  }

  const promise = Promise.resolve()
    .then(() => embedQueryWithAdmission(text))
    .catch((err) => {
      semanticQueryVectorCache.delete(key);
      throw err;
    });
  semanticQueryVectorCache.set(key, {
    expiresAt: now + ttlMs,
    promise,
  });
  pruneSemanticQueryVectorCache(maxEntries);
  return promise;
}

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
  semanticQueryVectorCache.clear();
}

export function getSemanticBackend() {
  return backend;
}

export function isSemanticCapabilityAvailable() {
  if (!backend || typeof backend.embedDocument !== 'function') return false;
  try {
    return backend.available?.() !== false;
  } catch {
    return false;
  }
}

export function supportsDeviceSemanticAttemptDeadline() {
  return isSemanticCapabilityAvailable() && backend?.supportsDeviceAttemptDeadline?.() === true;
}

// A stable, capability-level identity for reservation fencing. It deliberately
// contains no endpoint, path, or credential material: callers only need to
// know whether the backend's embedding contract changed while work was live.
export function getSemanticCapabilityIdentity() {
  return backend ? backendStorageIdentity(backend) : "semantic-disabled";
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
function makeBlobFlatIndex({ dimensions, distanceMetric }) {
  const byteLen = dimensions * 4;

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
    async upsert({ connectorId, connectorInstanceId, scopeKey, recordKey, vector }) {
      const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
      exec(referenceQueries.searchSemanticBlobUpsert, [connectorInstanceId, connectorId, scopeKey, recordKey, buf]);
    },
    async upsertMany(entries) {
      if (entries.length === 0) return;
      transaction(() => {
        for (const entry of entries) {
          const buf = Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength);
          exec(referenceQueries.searchSemanticBlobUpsert, [entry.connectorInstanceId, entry.connectorId, entry.scopeKey, entry.recordKey, buf]);
        }
      });
    },
    async deleteRecord({ connectorId, connectorInstanceId, stream, recordKey }) {
      // scope_key contains stream as the first JSON array element. Use
      // a LIKE match anchored on the opening characters of scope_key's
      // JSON encoding to narrow before comparing the stream name exactly
      // against the decoded scope_key.
      const streamPrefix = scopeKeyPrefixForStream(stream); // e.g. '["posts",'
      if (!connectorInstanceId) {
        execDynamicSqlAcknowledged(
          'DELETE FROM semantic_search_blob WHERE connector_id = ? AND record_key = ? AND scope_key LIKE ?',
          [connectorId, recordKey, `${streamPrefix}%`],
        );
        return;
      }
      exec(
        referenceQueries.searchSemanticBlobDeleteByRecordAndStreamPrefix,
        [connectorId, connectorInstanceId, recordKey, `${streamPrefix}%`],
      );
    },
    async deleteByConnectorStream({ connectorId, connectorInstanceId = null, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      if (connectorInstanceId) {
        execDynamicSqlAcknowledged(
          'DELETE FROM semantic_search_blob WHERE connector_instance_id = ? AND connector_id = ? AND scope_key LIKE ?',
          [connectorInstanceId, connectorId, `${streamPrefix}%`],
        );
        return;
      }
      exec(
        referenceQueries.searchSemanticBlobDeleteByStreamPrefix,
        [connectorId, `${streamPrefix}%`],
      );
    },
    async deleteByConnectorScope({ connectorId, connectorInstanceId = null, scopeKey }) {
      if (connectorInstanceId) {
        execDynamicSqlAcknowledged(
          'DELETE FROM semantic_search_blob WHERE connector_instance_id = ? AND connector_id = ? AND scope_key = ?',
          [connectorInstanceId, connectorId, scopeKey],
        );
        return;
      }
      exec(referenceQueries.searchSemanticBlobDeleteByScope, [connectorId, scopeKey]);
    },
    async deleteByConnector({ connectorId }) {
      exec(referenceQueries.searchSemanticBlobDeleteByConnector, [connectorId]);
    },
    async queryPerConnector({ connectorId, connectorInstanceId = null, scopeKeys, queryVector, limit, recordKeys = null }) {
      if (!Array.isArray(scopeKeys) || scopeKeys.length === 0) return [];
      if (Array.isArray(recordKeys) && recordKeys.length === 0) return [];
      const placeholders = scopeKeys.map(() => '?').join(',');
      const recordKeyClause = Array.isArray(recordKeys)
        ? `AND record_key IN (${recordKeys.map(() => '?').join(',')})`
        : '';
      // REVIEWED-DYNAMIC: SCOPE_KEY and RECORD_KEY IN-clauses have variable
      // cardinality from the grant-narrowed plan; SQL composed at call time;
      // overall row count is bounded by the plan's authorized scope+record
      // tuples and we slice to `limit` after distance scoring.
      const instanceClause = connectorInstanceId ? 'AND connector_instance_id = ?' : '';
      const sql = `
        SELECT connector_instance_id, scope_key, record_key, embedding
        FROM semantic_search_blob
        WHERE connector_id = ?
          ${instanceClause}
          AND scope_key IN (${placeholders})
          ${recordKeyClause}
      `;
      const scored = [];
      for (const row of iterateDynamicSqlAcknowledged(
        sql,
        [connectorId, ...(connectorInstanceId ? [connectorInstanceId] : []), ...scopeKeys, ...(recordKeys || [])],
      )) {
        if (!row.embedding || row.embedding.length !== byteLen) continue;
        const buf = Buffer.isBuffer(row.embedding)
          ? row.embedding
          : Buffer.from(row.embedding);
        const storedVec = new Float32Array(buf.buffer, buf.byteOffset, dimensions);
        const d = distance(queryVector, storedVec);
        scored.push({
          connectorId,
          connectorInstanceId: row.connector_instance_id,
          scopeKey: row.scope_key,
          recordKey: row.record_key,
          distance: d,
        });
      }
      scored.sort(compareHits);
      return scored.slice(0, limit);
    },
    countAll() {
      const row = getOne(referenceQueries.searchSemanticBlobCountAll, []);
      return Number(row?.n || 0);
    },
    countByConnectorScope(connectorId, scopeKey, connectorInstanceId = null) {
      if (connectorInstanceId) {
        const row = Array.from(iterateDynamicSqlAcknowledged(
          'SELECT COUNT(*) AS n FROM semantic_search_blob WHERE connector_instance_id = ? AND connector_id = ? AND scope_key = ?',
          [connectorInstanceId, connectorId, scopeKey],
        ))[0];
        return Number(row?.n || 0);
      }
      const row = getOne(referenceQueries.searchSemanticBlobCountByScope, [connectorId, scopeKey]);
      return Number(row?.n || 0);
    },
    async listExistingKeys({ connectorId, connectorInstanceId = null, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      const PAGE = 1000;
      const result = new Set();
      let cursorRowid = 0;
      for (;;) {
        const rows = connectorInstanceId
          ? Array.from(iterateDynamicSqlAcknowledged(
            `SELECT rowid, connector_instance_id, scope_key, record_key
             FROM semantic_search_blob
             WHERE connector_instance_id = ?
               AND connector_id = ?
               AND scope_key LIKE ?
               AND rowid > ?
             ORDER BY rowid ASC
             LIMIT ?`,
            [connectorInstanceId, connectorId, `${streamPrefix}%`, cursorRowid, PAGE],
          ))
          : getMany(
            referenceQueries.searchSemanticBlobListExistingKeysByStreamPrefix,
            [connectorId, `${streamPrefix}%`, cursorRowid],
            { limit: PAGE },
          ).rows;
        for (const row of rows) {
          result.add(encodeVectorPairKey(row.scope_key, `${row.connector_instance_id}\u0000${row.record_key}`));
          cursorRowid = Number(row.rowid);
        }
        if (rows.length < PAGE) break;
      }
      return result;
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
function makeSqliteVecIndex({ dimensions, distanceMetric }) {
  // Bootstrap the vec0 virtual table lazily on first use. Dimensions and
  // distance_metric are baked into the schema. If either changes, recreate
  // the virtual table and let manifest backfill rebuild from stored records.
  function ensureTable() {
    const existing = getOne(referenceQueries.searchSemanticVecGetTableSql, []);
    if (existing) {
      const sql = String(existing.sql || '');
      const expectedDims = `FLOAT[${dimensions}]`;
      const expectedMetric = `distance_metric=${distanceMetric}`;
      if (sql.includes(expectedDims) && sql.includes(expectedMetric)) {
        return;
      }
      // REVIEWED-DYNAMIC: DROP/CREATE of semantic_search_vec is DDL the
      // wrapper cannot register because the table is created at runtime
      // with backend-derived dimensions/metric; the registry's prepare
      // validation would fail before the table exists. The static
      // sibling tables ARE registered.
      execDynamicSqlAcknowledged('DROP TABLE semantic_search_vec', []);
      exec(referenceQueries.searchSemanticRowidDeleteAll, []);
      exec(referenceQueries.searchSemanticMetaDeleteAll, []);
      exec(referenceQueries.searchSemanticProgressDeleteAll, []);
      exec(referenceQueries.searchSemanticSnapshotsDeleteAll, []);
    }
    // REVIEWED-DYNAMIC: CREATE VIRTUAL TABLE has dimensions/metric
    // interpolated from validated backend config (small enumeration of
    // metrics × backend-defined dimensions). No user input crosses into
    // the SQL string.
    execDynamicSqlAcknowledged(`
      CREATE VIRTUAL TABLE semantic_search_vec USING vec0(
        connector_instance_id TEXT PARTITION KEY,
        connector_id TEXT,
        scope_key    TEXT,
        +record_key  TEXT,
        embedding    FLOAT[${dimensions}] distance_metric=${distanceMetric}
      )
    `, []);
  }
  ensureTable();

  function upsertOne({ connectorId, connectorInstanceId, scopeKey, recordKey, vector }) {
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const existing = getOne(referenceQueries.searchSemanticRowidGetRowidByIdentity, [connectorInstanceId, scopeKey, recordKey]);
    if (existing) {
      // REVIEWED-DYNAMIC: UPDATE on semantic_search_vec is a runtime
      // mutation the wrapper cannot register because the table is
      // created lazily; static prepare validation would fail before
      // ensureTable() runs.
      execDynamicSqlAcknowledged('UPDATE semantic_search_vec SET embedding = ? WHERE rowid = ?', [buf, existing.rowid]);
      return;
    }
    // REVIEWED-DYNAMIC: INSERT into semantic_search_vec is a runtime
    // mutation against a lazily-created table.
    const info = execDynamicSqlAcknowledged(
      'INSERT INTO semantic_search_vec(connector_instance_id, connector_id, scope_key, record_key, embedding) VALUES(?, ?, ?, ?, ?)',
      [connectorInstanceId, connectorId, scopeKey, recordKey, buf],
    );
    exec(referenceQueries.searchSemanticRowidInsert, [connectorInstanceId, connectorId, scopeKey, recordKey, Number(info.lastInsertRowid)]);
  }

  // Page through the rowid sidecar and delete corresponding vec rows.
  // The vec table mutations use the dynamic helper (lazy table) and the
  // sidecar mutations use static wrapper artifacts.
  const ROWID_PAGE = 1000;

  function deleteVecByRowid(rowid) {
    // REVIEWED-DYNAMIC: DELETE on semantic_search_vec runs against the
    // lazily-created table; static registration would fail.
    execDynamicSqlAcknowledged('DELETE FROM semantic_search_vec WHERE rowid = ?', [rowid]);
  }

  return {
    kind: 'sqlite-vec',
    async upsert({ connectorId, scopeKey, recordKey, vector }) {
      upsertOne({ connectorId, scopeKey, recordKey, vector });
    },
    async upsertMany(entries) {
      if (entries.length === 0) return;
      transaction(() => {
        for (const entry of entries) {
          upsertOne(entry);
        }
      });
    },
    async deleteRecord({ connectorId, connectorInstanceId, stream, recordKey }) {
      // Any scope_key whose first array element is stream.
      const streamPrefix = scopeKeyPrefixForStream(stream);
      if (!connectorInstanceId) {
        let cursorRowid = 0;
        for (;;) {
          const rows = Array.from(iterateDynamicSqlAcknowledged(
            `SELECT rowid, connector_instance_id, scope_key
             FROM semantic_search_rowid
             WHERE connector_id = ? AND record_key = ? AND scope_key LIKE ? AND rowid > ?
             ORDER BY rowid ASC
             LIMIT ?`,
            [connectorId, recordKey, `${streamPrefix}%`, cursorRowid, ROWID_PAGE],
          ));
          for (const row of rows) {
            deleteVecByRowid(row.rowid);
            exec(referenceQueries.searchSemanticRowidDeleteByIdentity, [row.connector_instance_id, row.scope_key, recordKey]);
            cursorRowid = Number(row.rowid);
          }
          if (rows.length < ROWID_PAGE) break;
        }
        return;
      }
      let cursorRowid = 0;
      for (;;) {
        const page = getMany(
          referenceQueries.searchSemanticRowidPageByRecordAndStreamPrefix,
          [connectorId, connectorInstanceId, recordKey, `${streamPrefix}%`, cursorRowid],
          { limit: ROWID_PAGE },
        );
        for (const row of page.rows) {
          deleteVecByRowid(row.rowid);
          exec(referenceQueries.searchSemanticRowidDeleteByIdentity, [connectorInstanceId, row.scope_key, recordKey]);
          cursorRowid = Number(row.rowid);
        }
        if (!page.truncated) break;
      }
    },
    async deleteByConnectorStream({ connectorId, connectorInstanceId = null, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      if (connectorInstanceId) {
        const rows = Array.from(iterateDynamicSqlAcknowledged(
          `SELECT rowid
           FROM semantic_search_rowid
           WHERE connector_instance_id = ? AND connector_id = ? AND scope_key LIKE ?`,
          [connectorInstanceId, connectorId, `${streamPrefix}%`],
        ));
        for (const row of rows) {
          deleteVecByRowid(row.rowid);
        }
        execDynamicSqlAcknowledged(
          'DELETE FROM semantic_search_rowid WHERE connector_instance_id = ? AND connector_id = ? AND scope_key LIKE ?',
          [connectorInstanceId, connectorId, `${streamPrefix}%`],
        );
        return;
      }
      let cursorRowid = 0;
      for (;;) {
        const page = getMany(
          referenceQueries.searchSemanticRowidPageByStreamPrefix,
          [connectorId, `${streamPrefix}%`, cursorRowid],
          { limit: ROWID_PAGE },
        );
        for (const row of page.rows) {
          deleteVecByRowid(row.rowid);
          cursorRowid = Number(row.rowid);
        }
        if (!page.truncated) break;
      }
      exec(referenceQueries.searchSemanticRowidDeleteByStreamPrefix, [connectorId, `${streamPrefix}%`]);
    },
    async deleteByConnectorScope({ connectorId, scopeKey }) {
      let cursorRowid = 0;
      for (;;) {
        const page = getMany(
          referenceQueries.searchSemanticRowidPageByScope,
          [connectorId, scopeKey, cursorRowid],
          { limit: ROWID_PAGE },
        );
        for (const row of page.rows) {
          deleteVecByRowid(row.rowid);
          cursorRowid = Number(row.rowid);
        }
        if (!page.truncated) break;
      }
      exec(referenceQueries.searchSemanticRowidDeleteByScope, [connectorId, scopeKey]);
    },
    async deleteByConnector({ connectorId }) {
      let cursorRowid = 0;
      for (;;) {
        const page = getMany(
          referenceQueries.searchSemanticRowidPageByConnector,
          [connectorId, cursorRowid],
          { limit: ROWID_PAGE },
        );
        for (const row of page.rows) {
          deleteVecByRowid(row.rowid);
          cursorRowid = Number(row.rowid);
        }
        if (!page.truncated) break;
      }
      exec(referenceQueries.searchSemanticRowidDeleteByConnector, [connectorId]);
    },
    async queryPerConnector({ connectorId, connectorInstanceId = null, scopeKeys, queryVector, limit, recordKeys = null }) {
      if (!Array.isArray(scopeKeys) || scopeKeys.length === 0) return [];
      if (Array.isArray(recordKeys) && recordKeys.length === 0) return [];
      const placeholders = scopeKeys.map(() => '?').join(',');
      const connectorInstanceIds = connectorInstanceId
        ? [connectorInstanceId]
        : Array.from(iterateDynamicSqlAcknowledged(
          `SELECT DISTINCT connector_instance_id
           FROM semantic_search_rowid
           WHERE connector_id = ?
             AND scope_key IN (${placeholders})`,
          [connectorId, ...scopeKeys],
        )).map((row) => row.connector_instance_id).filter(Boolean);
      if (connectorInstanceIds.length === 0) return [];
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
      // REVIEWED-DYNAMIC: scope_key/record_key IN-clauses have variable
      // cardinality from the grant-narrowed plan; the embedding MATCH
      // also targets the lazily-created semantic_search_vec table that
      // the registry cannot validate at boot. Caller binds `limit` so
      // the read is bounded.
      const sql = `
        SELECT connector_instance_id, connector_id, scope_key, record_key, distance
        FROM semantic_search_vec
        WHERE embedding MATCH ?
          AND connector_instance_id = ?
          AND connector_id = ?
          AND scope_key IN (${placeholders})
          ${recordKeyClause}
        ORDER BY distance LIMIT ?
      `;
      const hits = [];
      for (const connectorInstanceId of connectorInstanceIds) {
        const params = [
          buf,
          connectorInstanceId,
          connectorId,
          ...scopeKeys,
          ...(recordKeys ? [connectorId, ...scopeKeys, ...recordKeys] : []),
          limit,
        ];
        for (const r of iterateDynamicSqlAcknowledged(sql, params)) {
          hits.push({
            connectorId: r.connector_id,
            connectorInstanceId: r.connector_instance_id,
            scopeKey: r.scope_key,
            recordKey: r.record_key,
            distance: r.distance,
          });
        }
      }
      // vec0 orders by distance already; apply the secondary total-order
      // tie-breakers here so merge-in-app is deterministic.
      hits.sort(compareHits);
      return hits;
    },
    countAll() {
      const row = getOne(referenceQueries.searchSemanticRowidCountAll, []);
      return Number(row?.n || 0);
    },
    countByConnectorScope(connectorId, scopeKey, connectorInstanceId = null) {
      if (connectorInstanceId) {
        const row = Array.from(iterateDynamicSqlAcknowledged(
          'SELECT COUNT(*) AS n FROM semantic_search_rowid WHERE connector_instance_id = ? AND connector_id = ? AND scope_key = ?',
          [connectorInstanceId, connectorId, scopeKey],
        ))[0];
        return Number(row?.n || 0);
      }
      const row = getOne(referenceQueries.searchSemanticRowidCountByScope, [connectorId, scopeKey]);
      return Number(row?.n || 0);
    },
    async listExistingKeys({ connectorId, connectorInstanceId = null, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      const PAGE = 1000;
      const result = new Set();
      let cursorRowid = 0;
      for (;;) {
        const rows = connectorInstanceId
          ? Array.from(iterateDynamicSqlAcknowledged(
            `SELECT rowid, connector_instance_id, scope_key, record_key
             FROM semantic_search_rowid
             WHERE connector_instance_id = ?
               AND connector_id = ?
               AND scope_key LIKE ?
               AND rowid > ?
             ORDER BY rowid ASC
             LIMIT ?`,
            [connectorInstanceId, connectorId, `${streamPrefix}%`, cursorRowid, PAGE],
          ))
          : getMany(
            referenceQueries.searchSemanticRowidListExistingKeysByStreamPrefix,
            [connectorId, `${streamPrefix}%`, cursorRowid],
            { limit: PAGE },
          ).rows;
        for (const row of rows) {
          result.add(encodeVectorPairKey(row.scope_key, `${row.connector_instance_id}\u0000${row.record_key}`));
          cursorRowid = Number(row.rowid);
        }
        if (rows.length < PAGE) break;
      }
      return result;
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
  if ((a.connectorInstanceId ?? '') !== (b.connectorInstanceId ?? '')) {
    return (a.connectorInstanceId ?? '') < (b.connectorInstanceId ?? '') ? -1 : 1;
  }
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

export async function semanticIndexUpsert({ connectorId, connectorInstanceId, stream, recordKey, data, declaredFields }) {
  if (!backend) return;
  const declared = declaredFields === undefined ? await getStreamSemanticFields(connectorId, stream) : declaredFields;
  if (!declared) return;
  const entries = [];
  for (const field of declared) {
    const text = normalizeSemanticEmbeddingInput(data?.[field]);
    if (!text) continue;
    const vector = await embedDocumentWithAdmission(text);
    entries.push({
      connectorId,
      connectorInstanceId,
      scopeKey: encodeScopeKey(stream, field),
      recordKey,
      vector,
    });
  }
  if (isPostgresStorageBackend()) {
    await postgresSemanticIndexUpsertMany({ connectorId, connectorInstanceId, stream, recordKey, entries });
    if (entries.length > 0) {
      await postgresUpsertSemanticMeta({
        connectorId,
        connectorInstanceId,
        stream,
        fieldsFingerprint: fingerprintSemanticFields(declared),
        modelId: backendStorageIdentity(backend),
        dimensions: backend.dimensions(),
        distanceMetric: backend.distanceMetric(),
      });
    }
    return;
  }
  const index = ensureVectorIndex();
  if (!index) return;
  // Delete only this logical record's stale vectors after embeddings succeed.
  // Deleting by scope here would wipe every row for the field.
  await index.deleteRecord({ connectorId, connectorInstanceId, stream, recordKey });
  if (entries.length > 0 && typeof index.upsertMany === 'function') {
    await index.upsertMany(entries);
    exec(
      referenceQueries.searchSemanticMetaUpsert,
      [
        connectorInstanceId,
        connectorId,
        stream,
        fingerprintSemanticFields(declared),
        backendStorageIdentity(backend),
        backend.dimensions(),
        backend.distanceMetric(),
        new Date().toISOString(),
      ],
    );
    return;
  }
  for (const entry of entries) {
    await index.upsert(entry);
  }
  if (entries.length > 0) {
    exec(
      referenceQueries.searchSemanticMetaUpsert,
      [
        connectorInstanceId,
        connectorId,
        stream,
        fingerprintSemanticFields(declared),
        backendStorageIdentity(backend),
        backend.dimensions(),
        backend.distanceMetric(),
        new Date().toISOString(),
      ],
    );
  }
}

export async function semanticIndexDelete({ connectorId, connectorInstanceId, stream, recordKey }) {
  if (!backend) return;
  if (isPostgresStorageBackend()) {
    await postgresSemanticIndexDelete({ connectorId, connectorInstanceId, stream, recordKey });
    return;
  }
  const index = ensureVectorIndex();
  if (!index) return;
  await index.deleteRecord({ connectorId, connectorInstanceId, stream, recordKey });
}

export async function semanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream }) {
  if (!backend) return;
  if (isPostgresStorageBackend()) {
    await postgresSemanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    return;
  }
  const index = ensureVectorIndex();
  if (!index) return;
  await index.deleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  execDynamicSqlAcknowledged(
    'DELETE FROM semantic_search_meta WHERE connector_instance_id = ? AND stream = ?',
    [connectorInstanceId, stream],
  );
  deleteBackfillProgress({ connectorId, connectorInstanceId, stream });
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

function countIndexableSemanticValues({ connectorInstanceId, stream, declaredFields }) {
  return sqliteCountIndexableTextValues({
    connectorInstanceId,
    stream,
    declaredFields,
    jsonPathForField: jsonPathForTopLevelField,
    iterateDynamicSql: iterateDynamicSqlAcknowledged,
  });
}

function listSemanticConnectorInstanceIds({ connectorId, stream }) {
  const rows = iterateDynamicSqlAcknowledged(`
    SELECT DISTINCT connector_instance_id
    FROM records
    WHERE connector_id = ? AND stream = ?
    UNION
    SELECT DISTINCT connector_instance_id
    FROM semantic_search_meta
    WHERE connector_id = ? AND stream = ?
    UNION
    SELECT DISTINCT connector_instance_id
    FROM semantic_search_backfill_progress
    WHERE connector_id = ? AND stream = ?
    ORDER BY connector_instance_id
  `, [connectorId, stream, connectorId, stream, connectorId, stream]);
  return Array.from(rows, (row) => row.connector_instance_id).filter(Boolean);
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
  connectorInstanceId,
  stream,
  declaredFields,
  recordsToScan = null,
  progressJob = null,
  existingKeys = null,
  signal = null,
}) {
  const usePostgres = isPostgresStorageBackend();
  const index = usePostgres ? null : ensureVectorIndex();
  if ((!usePostgres && !index) || !backend) return 0;

  const PAGE = 500;
  let lastId = 0;
  let indexed = 0;
  let scanned = 0;
  for (;;) {
    // Cancellation hook (see lexical counterpart in search.js): the CLI
    // shutdown handler aborts the signal before closing the DB so the
    // embed/upsert loop releases the WAL writer cleanly.
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('semantic backfill aborted');
    }
    const rows = usePostgres
      ? await postgresSemanticRecordsPage({ connectorInstanceId, stream, lastId, limit: PAGE })
      : getMany(
        referenceQueries.searchSemanticRecordsPageNonDeleted,
        [connectorInstanceId, stream, lastId],
        { limit: PAGE },
      ).rows;
    if (rows.length === 0) break;
    const entries = [];
    for (const row of rows) {
      lastId = Number(row.id);
      let data;
      try {
        data = typeof row.record_json === 'string'
          ? JSON.parse(row.record_json)
          : row.record_json;
      } catch {
        continue;
      }
      for (const field of declaredFields) {
        const text = normalizeSemanticEmbeddingInput(data?.[field]);
        if (!text) continue;
        const scopeKey = encodeScopeKey(stream, field);
        if (existingKeys?.has(encodeVectorPairKey(scopeKey, `${connectorInstanceId}\u0000${row.record_key}`))) {
          continue;
        }
        const vector = await embedDocumentWithAdmission(text);
        entries.push({
          connectorId,
          connectorInstanceId,
          scopeKey,
          recordKey: row.record_key,
          vector,
        });
      }
    }
    if (usePostgres) {
      await postgresSemanticIndexInsertMany({ connectorId, connectorInstanceId, entries });
    } else if (entries.length > 0 && typeof index.upsertMany === 'function') {
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

function upsertBackfillProgress({ connectorId, connectorInstanceId, stream, fieldsFingerprint, modelId, dimensions, distanceMetric }) {
  exec(
    referenceQueries.searchSemanticProgressUpsert,
    [connectorInstanceId, connectorId, stream, fieldsFingerprint, modelId, dimensions, distanceMetric, new Date().toISOString()],
  );
}

function deleteBackfillProgress({ connectorId, connectorInstanceId = null, stream }) {
  if (!connectorInstanceId) {
    exec(referenceQueries.searchSemanticProgressDeleteByStream, [connectorId, stream]);
    return;
  }
  execDynamicSqlAcknowledged(
    'DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = ? AND stream = ?',
    [connectorInstanceId, stream],
  );
}

// Discover the complete instance set before taking any writer fence. A stream
// can be current, removed from the manifest, or represented only by an
// interrupted backfill row; all three need the same per-instance critical
// section. The caller then holds one fence per instance, never two at once.
async function resolveSemanticBackfillConnectorInstanceIds({ connectorId, manifest }) {
  const usePostgres = isPostgresStorageBackend();
  const streams = new Set(
    manifest.streams
      .map((stream) => stream?.name)
      .filter((stream) => typeof stream === 'string' && stream.length > 0),
  );
  if (usePostgres) {
    for (const stream of await postgresListSemanticStreamsForConnector({ connectorId })) {
      streams.add(stream);
    }
  } else {
    for (const row of allowUnboundedReadAcknowledged(
      referenceQueries.searchSemanticMetaListStreamsForConnector,
      [connectorId],
    )) {
      streams.add(row.stream);
    }
    for (const row of allowUnboundedReadAcknowledged(
      referenceQueries.searchSemanticProgressListStreamsForConnector,
      [connectorId],
    )) {
      streams.add(row.stream);
    }
  }

  const connectorInstanceIds = new Set();
  for (const stream of streams) {
    const ids = usePostgres
      ? await postgresListSemanticConnectorInstanceIds({ connectorId, stream })
      : listSemanticConnectorInstanceIds({ connectorId, stream });
    for (const connectorInstanceId of ids) connectorInstanceIds.add(connectorInstanceId);
  }
  return [...connectorInstanceIds].sort();
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
export async function semanticIndexBackfillForManifest({
  manifest,
  log = () => {},
  signal = null,
} = {}) {
  if (!manifest?.connector_id || !Array.isArray(manifest?.streams)) return;
  if (!backend) return;
  const connectorId = manifest.connector_id;
  const connectorInstanceIds = await resolveSemanticBackfillConnectorInstanceIds({ connectorId, manifest });
  for (const connectorInstanceId of connectorInstanceIds) {
    await withConnectorInstanceWrite(connectorInstanceId, () =>
      backfillSemanticIndexForConnectorInstance({
        manifest,
        log,
        signal,
        fencedConnectorInstanceId: connectorInstanceId,
      }),
    );
  }
}

// The public entry point obtains one coordinator scope per id. This helper is
// deliberately private so no external caller can select an instance and skip
// that fence; all current/removed/orphan stream effects below run within it.
async function backfillSemanticIndexForConnectorInstance({
  manifest,
  log,
  signal,
  fencedConnectorInstanceId,
}) {
  const connectorId = manifest.connector_id;
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
  const usePostgres = isPostgresStorageBackend();
  const index = usePostgres ? null : ensureVectorIndex();
  if (!usePostgres && !index) return;

  const currentModel = backendStorageIdentity(backend);
  const currentDims = backend.dimensions();
  const currentMetric = backend.distanceMetric();

  const visitedStreams = new Set();

  for (const mStream of manifest.streams) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('semantic backfill aborted');
    }
    const stream = mStream?.name;
    if (typeof stream !== 'string' || stream.length === 0) continue;
    visitedStreams.add(stream);

    const declaredFields = mStream?.query?.search?.semantic_fields;
    const isParticipating = Array.isArray(declaredFields) && declaredFields.length > 0;

    if (!isParticipating) {
      const connectorInstanceIds = usePostgres
        ? await postgresListSemanticConnectorInstanceIds({ connectorId, stream })
        : listSemanticConnectorInstanceIds({ connectorId, stream });
      if (connectorInstanceIds.length > 0) {
        log(`[PDPP] Semantic index: stream='${stream}' connector='${connectorId}' ` +
            `no longer declares semantic_fields — dropping stale index + meta/progress`);
        for (const connectorInstanceId of connectorInstanceIds.filter((id) => id === fencedConnectorInstanceId)) {
          if (usePostgres) {
            await postgresSemanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
            await postgresDeleteSemanticMeta({ connectorInstanceId, stream });
            await postgresDeleteSemanticProgress({ connectorInstanceId, stream });
          } else {
            await index.deleteByConnectorStream({ connectorId, connectorInstanceId, stream });
            execDynamicSqlAcknowledged(
              'DELETE FROM semantic_search_meta WHERE connector_instance_id = ? AND stream = ?',
              [connectorInstanceId, stream],
            );
            deleteBackfillProgress({ connectorId, connectorInstanceId, stream });
          }
        }
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
    const currentIdentity = {
      fieldsFingerprint: newFingerprint,
      modelId: currentModel,
      dimensions: currentDims,
      distanceMetric: currentMetric,
    };
    const connectorInstanceIds = usePostgres
      ? await postgresListSemanticConnectorInstanceIds({ connectorId, stream })
      : listSemanticConnectorInstanceIds({ connectorId, stream });
    for (const connectorInstanceId of connectorInstanceIds.filter((id) => id === fencedConnectorInstanceId)) {
    const metaRow = usePostgres
      ? await postgresGetSemanticMeta({ connectorInstanceId, stream })
      : getOne(referenceQueries.searchSemanticMetaGetByStream, [connectorInstanceId, stream]);
    const progressRow = usePostgres
      ? await postgresGetSemanticProgress({ connectorInstanceId, stream })
      : getOne(referenceQueries.searchSemanticProgressGetByStream, [connectorInstanceId, stream]);
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
      const recordCount = usePostgres
        ? await postgresCountSemanticRecords({ connectorInstanceId, stream })
        : Number(getOne(referenceQueries.searchSemanticRecordsCountNonDeleted, [connectorInstanceId, stream])?.n || 0);

      // Index count across all declared (stream, field) scope_keys.
      let indexCount = 0;
      for (const field of declaredFields) {
        indexCount += usePostgres
          ? await postgresCountSemanticIndexByScope({ connectorId, connectorInstanceId, scopeKey: encodeScopeKey(stream, field) })
          : index.countByConnectorScope(connectorId, encodeScopeKey(stream, field), connectorInstanceId);
      }
      const maxIndexRows = recordCount * declaredFields.length;
      const expectedIndexRows = indexCount === 0 || indexCount > maxIndexRows
        ? (usePostgres
          ? await postgresCountIndexableSemanticValues({ connectorInstanceId, stream, declaredFields })
          : countIndexableSemanticValues({ connectorInstanceId, stream, declaredFields }))
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
        if (usePostgres) {
          await postgresDeleteSemanticProgress({ connectorInstanceId, stream });
        } else {
          deleteBackfillProgress({ connectorId, connectorInstanceId, stream });
        }
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

    if (usePostgres) {
      await postgresUpsertSemanticProgress({
        connectorId,
        connectorInstanceId,
        stream,
        fieldsFingerprint: currentIdentity.fieldsFingerprint,
        modelId: currentIdentity.modelId,
        dimensions: currentIdentity.dimensions,
        distanceMetric: currentIdentity.distanceMetric,
      });
    } else {
      upsertBackfillProgress({ connectorId, connectorInstanceId, stream, ...currentIdentity });
    }
    let existingKeys = null;
    if (usePostgres && canResume) {
      existingKeys = await postgresListExistingSemanticKeys({ connectorId, connectorInstanceId, stream });
    } else if (canResume && typeof index.listExistingKeys === 'function') {
      existingKeys = await index.listExistingKeys({ connectorId, connectorInstanceId, stream });
    } else if (usePostgres) {
      await postgresSemanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    } else {
      await index.deleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    }

    const recordsToScan = usePostgres
      ? await postgresCountSemanticRecords({ connectorInstanceId, stream })
      : Number(getOne(referenceQueries.searchSemanticRecordsCountNonDeleted, [connectorInstanceId, stream])?.n || 0);
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
      connectorInstanceId,
      stream,
      declaredFields,
      recordsToScan,
      progressJob,
      existingKeys,
      signal,
    });
    log(`[PDPP] Semantic index rebuild completed for ${connectorId} stream='${stream}' ` +
        `(records=${recordsToScan}, indexed=${indexed})`);

    if (usePostgres) {
      await postgresUpsertSemanticMeta({
        connectorId,
        connectorInstanceId,
        stream,
        fieldsFingerprint: newFingerprint,
        modelId: currentModel,
        dimensions: currentDims,
        distanceMetric: currentMetric,
      });
      await postgresDeleteSemanticProgress({ connectorInstanceId, stream });
    } else {
      exec(
        referenceQueries.searchSemanticMetaUpsert,
        [connectorInstanceId, connectorId, stream, newFingerprint, currentModel, currentDims, currentMetric, new Date().toISOString()],
      );
      deleteBackfillProgress({ connectorId, connectorInstanceId, stream });
    }
  }
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
  // REVIEWED-BOUNDED: meta+progress rows are keyed by (connector_id, stream)
  // and the stream count per connector is bounded by the manifest, well
  // below the @max_rows=1024 declared on each artifact.
  const orphanStreams = new Set();
  if (usePostgres) {
    for (const stream of await postgresListSemanticStreamsForConnector({ connectorId })) {
      orphanStreams.add(stream);
    }
  } else {
    for (const row of allowUnboundedReadAcknowledged(
      referenceQueries.searchSemanticMetaListStreamsForConnector,
      [connectorId],
    )) {
      orphanStreams.add(row.stream);
    }
    // REVIEWED-BOUNDED: progress rows are keyed by (connector_id, stream); the
    // stream count per connector is bounded by the manifest, well below the
    // @max_rows=1024 declared on the artifact.
    for (const row of allowUnboundedReadAcknowledged(
      referenceQueries.searchSemanticProgressListStreamsForConnector,
      [connectorId],
    )) {
      orphanStreams.add(row.stream);
    }
  }
  for (const orphanStream of orphanStreams) {
    if (visitedStreams.has(orphanStream)) continue;
    log(`[PDPP] Semantic index: stream='${orphanStream}' connector='${connectorId}' ` +
        `no longer in manifest — dropping stale index + meta/progress`);
    const connectorInstanceIds = usePostgres
      ? await postgresListSemanticConnectorInstanceIds({ connectorId, stream: orphanStream })
      : listSemanticConnectorInstanceIds({ connectorId, stream: orphanStream });
    for (const connectorInstanceId of connectorInstanceIds.filter((id) => id === fencedConnectorInstanceId)) {
      if (usePostgres) {
        await postgresSemanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream: orphanStream });
        await postgresDeleteSemanticMeta({ connectorInstanceId, stream: orphanStream });
        await postgresDeleteSemanticProgress({ connectorInstanceId, stream: orphanStream });
      } else {
        await index.deleteByConnectorStream({ connectorId, connectorInstanceId, stream: orphanStream });
        execDynamicSqlAcknowledged(
          'DELETE FROM semantic_search_meta WHERE connector_instance_id = ? AND stream = ?',
          [connectorInstanceId, orphanStream],
        );
        deleteBackfillProgress({ connectorId, connectorInstanceId, stream: orphanStream });
      }
    }
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
 * Reads from the active storage backend so Postgres-mode deployments do
 * not observe orphaned SQLite progress/meta rows left from an earlier
 * configuration.
 *
 * Returns 'built' | 'building' | 'stale'.
 *
 * The `deps` argument is a test seam; production callers pass nothing and
 * get the live storage-backend wiring.
 */
export async function computeIndexState(deps = {}) {
  if (!backend) return 'stale';
  if (isSemanticIndexBackfillActive()) return 'building';
  const usePostgres = deps.isPostgresStorageBackend
    ? deps.isPostgresStorageBackend()
    : isPostgresStorageBackend();
  const readProgressExistsAny = usePostgres
    ? (deps.postgresAnySemanticProgressRow || postgresAnySemanticProgressRow)
    // REVIEWED-BOUNDED: small_enumeration_table — single-row existence probe.
    : () => getOne(referenceQueries.searchSemanticProgressExistsAny, []);
  const readMetaIdentities = usePostgres
    ? (deps.postgresListAllSemanticMetaIdentities || postgresListAllSemanticMetaIdentities)
    // REVIEWED-BOUNDED: semantic_search_meta is keyed by (connector_id,
    // stream); total row count is bounded by the live manifest's stream
    // count summed across connectors and stays well under
    // @max_rows=1024 in practice.
    : () => allowUnboundedReadAcknowledged(referenceQueries.searchSemanticMetaListAllIdentities, []);

  const progressRow = await readProgressExistsAny();
  if (progressRow) return 'stale';
  const rows = await readMetaIdentities();
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

/**
 * Parse and validate the v1 semantic-search query-string allowlist + the
 * explicit forbidden-parameter list.
 *
 * Thin delegating shim: the canonical implementation lives in
 * `operations/rs-search-semantic/index.ts`. Kept exported here so existing
 * direct importers (notably `semantic-retrieval.test.js`) continue to
 * receive the same plain-`Error` shape (`err.code`, optional `err.param`)
 * the previous local implementation produced.
 */
export function parseSemanticSearchParams(query) {
  try {
    return parseSearchSemanticParams(query);
  } catch (err) {
    if (err instanceof SearchSemanticRequestError) {
      const translated = new Error(err.message);
      translated.code = err.code;
      if (err.param !== undefined) translated.param = err.param;
      throw translated;
    }
    throw err;
  }
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

function needsCandidateRecordScan(streamGrant, compiledFilters) {
  return !!(compiledFilters?.length || hasGrantRecordConstraints(streamGrant));
}

function allowedCandidateRecordKeysFromRows(rows, { streamGrant, manifestStream, compiledFilters }) {
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

async function buildPostgresCandidateRecordKeys({ connectorId, connectorInstanceId, streamName, streamGrant, manifestStream, compiledFilters }) {
  if (!needsCandidateRecordScan(streamGrant, compiledFilters)) return null;

  const where = connectorInstanceId
    ? ['connector_instance_id = $1', 'stream = $2', 'deleted = FALSE']
    : ['connector_id = $1', 'stream = $2', 'deleted = FALSE'];
  const binds = [connectorInstanceId || connectorId, streamName];
  if (Array.isArray(streamGrant?.resources) && streamGrant.resources.length > 0) {
    const placeholders = streamGrant.resources.map((_, index) => `$${binds.length + index + 1}`);
    where.push(`record_key IN (${placeholders.join(', ')})`);
    binds.push(...streamGrant.resources);
  }

  // REVIEWED-DYNAMIC: candidate-key scan includes a variable resources IN
  // clause and optional JS-side grant/filter predicates, so the SQL shape is
  // grant-dependent and cannot be a static registry artifact.
  const rows = (await postgresQuery(
    `SELECT record_key, record_json::text AS record_json
     FROM records
     WHERE ${where.join(' AND ')}`,
    binds,
  )).rows;

  return allowedCandidateRecordKeysFromRows(rows, { streamGrant, manifestStream, compiledFilters });
}

function buildCandidateRecordKeys({ connectorId, connectorInstanceId, streamName, streamGrant, manifestStream, compiledFilters }) {
  const needsRecordScan = compiledFilters?.length || hasGrantRecordConstraints(streamGrant);
  if (!needsRecordScan) return null;

  const where = connectorInstanceId
    ? ['connector_instance_id = ?', 'stream = ?', 'deleted = 0']
    : ['connector_id = ?', 'stream = ?', 'deleted = 0'];
  const binds = [connectorInstanceId || connectorId, streamName];
  if (Array.isArray(streamGrant?.resources) && streamGrant.resources.length > 0) {
    where.push(`record_key IN (${streamGrant.resources.map(() => '?').join(', ')})`);
    binds.push(...streamGrant.resources);
  }

  // REVIEWED-DYNAMIC: candidate-key scan includes a variable resources IN
  // clause and optional JS-side grant/filter predicates, so the SQL shape is
  // grant-dependent and cannot be a static registry artifact.
  const rows = iterateDynamicSqlAcknowledged(`
    SELECT record_key, record_json
    FROM records
    WHERE ${where.join(' AND ')}
  `, binds);

  return allowedCandidateRecordKeysFromRows(rows, { streamGrant, manifestStream, compiledFilters });
}

export function buildSemanticSearchPlanForGrant({ manifest, grant, streamsFilter, compiledFilter = null, connectorId = null, connectorInstanceId = null }) {
  if (!manifest?.streams || !grant?.streams) return [];
  assertGrantedManifestReadAuthority(manifest, grant, streamsFilter);
  const plan = [];
  for (const mStream of manifest.streams) {
    const declared = mStream?.query?.search?.semantic_fields;
    if (!Array.isArray(declared) || declared.length === 0) continue;
    if (streamsFilter && !streamsFilter.includes(mStream.name)) continue;

    const streamGrant = grant.streams.find((s) => s.name === mStream.name);
    if (!streamGrant) continue;
    if (
      typeof streamGrant.connection_id === 'string'
      && streamGrant.connection_id.length > 0
      && connectorInstanceId
      && streamGrant.connection_id !== connectorInstanceId
    ) {
      continue;
    }

    const grantedFields = Array.isArray(streamGrant.fields) && streamGrant.fields.length > 0
      ? new Set(streamGrant.fields)
      : null;
    const searchable = grantedFields
      ? declared.filter((f) => grantedFields.has(f))
      : declared.slice();
    if (searchable.length === 0) continue;
    const filters = compiledFilter?.streamName === mStream.name ? compiledFilter.filters : [];
    const shouldScanCandidates = needsCandidateRecordScan(streamGrant, filters);
    const candidateRecordKeys = connectorId && shouldScanCandidates && !isPostgresStorageBackend()
      ? buildCandidateRecordKeys({
        connectorId,
        connectorInstanceId,
        streamName: mStream.name,
        streamGrant,
        manifestStream: mStream,
        compiledFilters: filters,
      })
      : null;
    const postgresCandidateFilter = connectorId && shouldScanCandidates && isPostgresStorageBackend()
      ? { streamGrant, manifestStream: mStream, compiledFilters: filters }
      : null;

    plan.push({
      streamName: mStream.name,
      searchableFields: searchable,
      scopeKeys: searchable.map((f) => encodeScopeKey(mStream.name, f)),
      ...(connectorInstanceId ? { connectorInstanceId } : {}),
      ...(candidateRecordKeys ? { candidateRecordKeys } : {}),
      ...(postgresCandidateFilter ? { postgresCandidateFilter } : {}),
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

/**
 * The single helper the GET /v1/search/semantic route delegates to.
 *
 * Thin native dependency-wiring shell around the canonical
 * `executeSearchSemantic` operation in
 * `operations/rs-search-semantic/index.ts`. The operation owns the
 * public-contract slice (allowlist + forbidden parameters, `q` required,
 * `limit` clamping, `streams[]` normalization, `filter[...]` coupling,
 * cross-stream advertisement gate, mode classification, cursor encode/decode
 * with the `sem1.` prefix, snapshot orchestration with backend-identity
 * stale-cursor detection, slice math, score-advertisement gate,
 * `search_result` shaping including `retrieval_mode: "semantic"`,
 * list-envelope, and `disclosure.served` data block); this shell preserves
 * the existing native semantics by wiring those concerns onto the live
 * embedding pipeline, vector index, snapshot tables, records-table snippet
 * hydration, and `record_url` formatting.
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
  getOwnerSubjectId,
}) {
  if (!backend || !backend.available()) {
    // Route registration should prevent reaching this helper when no backend
    // is configured, but defend in depth.
    const err = new Error('semantic retrieval is not configured');
    err.code = 'not_found';
    throw err;
  }

  const isOwner = tokenInfo.pdpp_token_kind === 'owner';
  const advertisement = resolveSemanticRetrievalAdvertisement(opts);
  const actor = isOwner
    ? { kind: 'owner', subject_id: tokenInfo.subject_id ?? null }
    : {
        kind: 'client',
        subject_id: tokenInfo.subject_id ?? null,
        client_id: tokenInfo.client_id ?? null,
        grant_id: tokenInfo.grant_id ?? null,
        grant: tokenInfo.grant ?? { streams: [] },
      };

  const ownerSubjectId = isOwner
    ? (typeof getOwnerSubjectId === 'function'
        ? getOwnerSubjectId()
        : OWNER_AUTH_DEFAULT_SUBJECT_ID)
    : null;

  // Native dependencies wire the operation against the existing embedding
  // pipeline, vector index, snapshot tables, and records-table snippet
  // hydration. The operation owns the public-contract slice; these helpers
  // keep their backend-specific semantics untouched.
  const dependencies = {
    getAdvertisement: () => advertisement,
    getCurrentBackendIdentity: () => hashBackendIdentity(backend),
    listOwnerVisibleConnectorIds: () => resolveOwnerVisibleConnectorIds(),
    listOwnerVisibleBindings: async () => {
      const connectorIds = await resolveOwnerVisibleConnectorIds();
      return await listActiveOwnerBindingsForConnectors({
        ownerSubjectId,
        connectorIds,
      });
    },
    resolveOwnerManifestForConnector: async (connectorId) => {
      try {
        const ownerScope = resolveOwnerScopeForConnector(connectorId);
        const resolved = await resolveOwnerManifestFromScope(ownerScope);
        return resolved.manifest ?? null;
      } catch {
        // Skip connectors whose manifest cannot be resolved. The owner can
        // still read the others; one broken connector should not break the
        // whole search.
        return null;
      }
    },
    resolveOwnerManifestForBinding: async (binding) => {
      try {
        const ownerScope = resolveOwnerScopeForConnector(binding.connectorId);
        const pinnedScope = {
          ...ownerScope,
          storage_binding: {
            ...(ownerScope.storage_binding || {}),
            connector_id: binding.connectorId,
            connector_instance_id: binding.connectorInstanceId,
          },
        };
        const resolved = await resolveOwnerManifestFromScope(pinnedScope);
        const manifest = resolved.manifest ?? null;
        if (manifest) {
          return {
            ...manifest,
            storage_binding: {
              ...(manifest.storage_binding || {}),
              connector_instance_id:
                resolved.storageBinding?.connector_instance_id
                ?? binding.connectorInstanceId,
            },
          };
        }
        return null;
      } catch {
        return null;
      }
    },
    buildOwnerReadGrantForManifest: (manifest) =>
      buildOwnerReadGrantForManifest(manifest),
    resolveClientManifest: async () => {
      const grantResolved = await resolveGrantManifest(tokenInfo);
      return grantResolved.manifest;
    },
    resolveClientBindings: async (clientActor, { connectionId }) => {
      const grantResolved = await resolveGrantManifest(tokenInfo);
      const baseManifest = grantResolved.manifest;
      const connectorId = baseManifest?.storage_binding?.connector_id
        || baseManifest?.connector_id
        || null;
      const ownerSubjectIdForGrant =
        tokenInfo?.grant?.subject?.id
        || tokenInfo?.subject_id
        || OWNER_AUTH_DEFAULT_SUBJECT_ID;
      const grantStreams = clientActor?.grant?.streams || [];
      let grantStreamConnectionId = null;
      const pinned = grantStreams
        .map((s) => s?.connection_id)
        .filter((v) => typeof v === 'string' && v.length > 0);
      if (pinned.length === grantStreams.length && pinned.length > 0) {
        const unique = new Set(pinned);
        if (unique.size === 1) grantStreamConnectionId = pinned[0];
      }
      const { bindings } = await resolveFanInBindings({
        ownerSubjectId: ownerSubjectIdForGrant,
        connectorId,
        connectorInstanceIdHint:
          grantResolved.storageBinding?.connector_instance_id || null,
        requestConnectionId: connectionId,
        grantStreamConnectionId,
      });
      return bindings.map((b) => ({
        manifest: {
          ...baseManifest,
          storage_binding: {
            ...(baseManifest.storage_binding || {}),
            connector_id: b.connectorId || connectorId,
            connector_instance_id: b.connectorInstanceId,
          },
        },
        connectorInstanceId: b.connectorInstanceId,
        ...(b.displayName ? { displayName: b.displayName } : {}),
      }));
    },
    buildSearchPlanForGrant: ({
      manifest,
      grant,
      streamsFilter,
      filter,
      filteredStream,
      connectorId,
    }) => {
      const connectorInstanceId =
        manifest?.storage_binding?.connector_instance_id || manifest?.connector_instance_id || null;
      const compiledFilter = compileSingleStreamSearchFilter({
        manifest,
        grant,
        streamName: filteredStream,
        filter,
      });
      return buildSemanticSearchPlanForGrant({
        manifest,
        grant,
        streamsFilter,
        compiledFilter,
        connectorId,
        connectorInstanceId,
      });
    },
    buildSnapshot: (args) => buildSemanticSnapshot(args),
    persistSnapshot: (snapshot) => persistSemanticSnapshot(snapshot),
    loadSnapshot: (snapshotId) => loadSemanticSnapshot(snapshotId),
    hydrateResult: ({ hit }) => hydrateSemanticSearchResult({ hit }),
    formatRecordUrl: ({ stream, recordKey, connectorId, isOwner: ownerActor }) => {
      const recordPath = `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordKey)}`;
      return ownerActor
        ? `${recordPath}?connector_id=${encodeURIComponent(connectorId)}`
        : recordPath;
    },
  };

  let result;
  try {
    result = await executeSearchSemantic(
      { actor, query: req.query },
      dependencies,
    );
  } catch (err) {
    if (err instanceof SearchSemanticRequestError) {
      // Translate operation-typed errors into the plain-object error shape
      // the existing native error path expects (`err.code`, optional
      // `err.param`). Preserves the previous public error envelope.
      const translated = new Error(err.message);
      translated.code = err.code;
      if (err.param !== undefined) translated.param = err.param;
      throw translated;
    }
    throw err;
  }

  return {
    envelope: {
      object: 'list',
      url: '/v1/search/semantic',
      has_more: result.envelope.has_more,
      ...(result.envelope.next_cursor
        ? { next_cursor: result.envelope.next_cursor }
        : {}),
      data: result.envelope.data,
      // Carry the operation's canonical `meta.warnings[]` (limit_clamped,
      // deprecated_alias_used, source_skipped_not_applicable) through to the
      // REST response. Omitted when the operation produced no warnings.
      ...(result.envelope.meta ? { meta: result.envelope.meta } : {}),
    },
    disclosureData: result.disclosureData,
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
async function buildSemanticSnapshot({ q, perConnectorPlans, isOwner, pageLimit = 25 }) {
  const queryVector = await embedSemanticQueryWithCache(q);
  const index = isPostgresStorageBackend() ? null : ensureVectorIndex();

  // Fetch enough per connector to survive field-level duplicate collapse
  // without forcing every first page to pay for the public maximum.
  const perConnectorLimit = resolveSemanticPerConnectorLimit(pageLimit);

  const perConnectorHits = await mapSearchFanout(
    perConnectorPlans,
    async ({ connectorId, planEntries }) => {
      const entryHits = [];
      if (isPostgresStorageBackend()) {
        for (const request of buildPostgresSemanticPlanRequests(planEntries)) {
          const recordKeys = Array.isArray(request.candidateRecordKeys)
            ? request.candidateRecordKeys
            : request.postgresCandidateFilter
              ? await buildPostgresCandidateRecordKeys({
                connectorId,
                connectorInstanceId: request.connectorInstanceId,
                streamName: request.streamName,
                ...request.postgresCandidateFilter,
              })
              : null;
          entryHits.push(...await postgresSemanticSearch({
            connectorId,
            connectorInstanceId: request.connectorInstanceId,
            scopeKeys: request.scopeKeys,
            queryVector,
            limit: perConnectorLimit,
            recordKeys,
          }));
        }
      } else {
        for (const entry of planEntries) {
          if (entry.scopeKeys.length === 0) continue;
          entryHits.push(...await index.queryPerConnector({
            connectorId,
            connectorInstanceId: entry.connectorInstanceId,
            scopeKeys: entry.scopeKeys,
            queryVector,
            limit: perConnectorLimit,
            recordKeys: entry.candidateRecordKeys,
          }));
        }
      }
      return entryHits.sort(compareHits).slice(0, perConnectorLimit);
    },
    { isPostgres: isPostgresStorageBackend() },
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
    const collapseKey = `${hit.connectorInstanceId ?? ''}\u0000${hit.connectorId}\u0000${stream}\u0000${hit.recordKey}`;
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
        connectorInstanceId: hit.connectorInstanceId ?? null,
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

  // Decorate each hit with the owner-facing display_name when the store has
  // a non-placeholder label for the binding. Lookups are deduped per
  // connection_id; placeholder labels are omitted, not faked.
  const displayNames = await resolveDisplayNamesForBindings(
    collapsedArr.map((hit) => ({
      connectorInstanceId: hit.connectorInstanceId,
      connectorId: hit.connectorId,
    })),
  );
  for (const hit of collapsedArr) {
    const displayName = displayNames.get(hit.connectorInstanceId);
    if (displayName) hit.displayName = displayName;
  }

  return {
    snapshot_id: generateSnapshotId(),
    query: q,
    plan_hash: hashSemanticPlan({ perConnectorPlans, isOwner }),
    backend_hash: hashBackendIdentity(backend),
    results: collapsedArr,
  };
}

// ─── Semantic record-retrieval + snapshot store (one adapter per backend) ───
//
// Domain-local store for the structurally-identical, dialect-only seams in this
// module's snapshot/hydration shell: the records-table read by key
// (hydrateSemanticSearchResult) and the semantic_search_snapshots persist/load
// (persistSemanticSnapshot / loadSemanticSnapshot). Each method is the SAME
// conceptual op differing only by SQL dialect ($N vs ?, ::jsonb / ::text,
// deleted = FALSE vs 0). The dialect SQL/queries move VERBATIM; adapters return
// the RAW row (or perform the write) and any row-shaping
// (materializeSemanticSnapshot, snippet extraction) stays caller-side. The
// backend is selected ONCE per op via isPostgresStorageBackend(), mirroring the
// lexical getSearchIndexStore() precedent in search.js and the existing
// VectorIndex / BlobStore convention. Vector-index / embedding / distance /
// HNSW operations are NOT part of this store; they keep their own backend
// routing in postgres-search.js + the local VectorIndex.
const postgresSemanticSearchStore = {
  getRecordRow: ({ connectorId, connectorInstanceId, stream, recordKey }) =>
    postgresGetSemanticRecord({ connectorId, connectorInstanceId, stream, recordKey }),
  async persistSnapshot({ snapshotId, query, planHash, resultsJson }) {
    await postgresQuery(
      `
      INSERT INTO semantic_search_snapshots(snapshot_id, query, plan_hash, results_json)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        query = excluded.query,
        plan_hash = excluded.plan_hash,
        results_json = excluded.results_json,
        created_at = (now() AT TIME ZONE 'utc')::text
      `,
      [snapshotId, query, planHash, resultsJson],
    );
  },
  async loadSnapshotRow(snapshotId) {
    const { rows } = await postgresQuery(
      `
      SELECT snapshot_id, query, plan_hash, results_json::text AS results_json, created_at
      FROM semantic_search_snapshots
      WHERE snapshot_id = $1
      `,
      [snapshotId],
    );
    return rows[0];
  },
};

const sqliteSemanticSearchStore = {
  getRecordRow: ({ connectorInstanceId, stream, recordKey }) =>
    getOne(
      referenceQueries.searchSemanticRecordsGetRecordByKey,
      [connectorInstanceId, stream, recordKey],
    ),
  persistSnapshot: ({ snapshotId, query, planHash, resultsJson }) => {
    exec(
      referenceQueries.searchSemanticSnapshotsInsert,
      [snapshotId, query, planHash, resultsJson],
    );
  },
  loadSnapshotRow: (snapshotId) =>
    getOne(referenceQueries.searchSemanticSnapshotsGetById, [snapshotId]),
};

function getSemanticSearchStore() {
  return isPostgresStorageBackend() ? postgresSemanticSearchStore : sqliteSemanticSearchStore;
}

// ─── search_result hydration + grant-safe snippets ─────────────────────────

/**
 * Hydrate `emitted_at` and `snippet` for one semantic snapshot hit. The
 * operation calls this once per emitted hit so the records-table read stays
 * in this native shell rather than crossing the operation boundary.
 *
 * Snippet is a verbatim contiguous substring of the matched field's stored
 * value. NEVER a paraphrase, summary, or model-generated text. Field-grant
 * intersection happens in `buildSemanticSearchPlanForGrant` (the snippet's
 * source field is one of the grant-authorized matched fields, so the
 * snippet is grant-safe by construction).
 */
async function hydrateSemanticSearchResult({ hit }) {
  const recordRow = await getSemanticSearchStore().getRecordRow({
    connectorId: hit.connectorId,
    connectorInstanceId: hit.connectorInstanceId ?? null,
    stream: hit.stream,
    recordKey: hit.recordKey,
  });

  const emittedAt = recordRow?.emitted_at ?? null;
  let authoredAt = null;
  let snippet = null;
  if (recordRow?.record_json) {
    try {
      const data = typeof recordRow.record_json === 'string'
        ? JSON.parse(recordRow.record_json)
        : recordRow.record_json;
      authoredAt = authoredTimestampFromRecordData(data);
      const value = data?.[hit.topField];
      if (typeof value === 'string' && value.length > 0) {
        snippet = { field: hit.topField, text: pickVerbatimExcerpt(value) };
      }
    } catch {
      // Corrupt record_json — skip snippet rather than fabricate.
    }
  }
  return { emittedAt, authoredAt, snippet };
}

function authoredTimestampFromRecordData(data) {
  if (!data || typeof data !== 'object') return null;
  for (const key of ['sent_at', 'sentAt', 'authored_at', 'authoredAt', 'created_at', 'createdAt', 'source_created_at', 'sourceCreatedAt', 'occurred_at', 'occurredAt', 'updated_at', 'updatedAt']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
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
  // Include `connector_instance_id` per plan entry and sort
  // deterministically so the snapshot's binding set is part of the cursor
  // identity. A request that adds or removes a binding mid-pagination
  // yields a different hash, invalidating cursor reuse.
  const summary = perConnectorPlans.map((p) => ({
    c: p.connectorId,
    e: p.planEntries
      .map((pe) => ({
        i: pe.connectorInstanceId || null,
        s: pe.streamName,
        f: pe.searchableFields.slice().sort(),
      }))
      .sort((a, b) => {
        const ia = a.i || '';
        const ib = b.i || '';
        if (ia !== ib) return ia < ib ? -1 : 1;
        return a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
      }),
  })).sort((a, b) => (a.c || '') < (b.c || '') ? -1 : (a.c || '') > (b.c || '') ? 1 : 0);
  return JSON.stringify({ isOwner, summary });
}

function hashBackendIdentity(b) {
  return JSON.stringify({
    identity: backendStorageIdentity(b),
  });
}

export function resolveSemanticPerConnectorLimit(pageLimit) {
  const normalized = Math.max(1, Math.min(Number(pageLimit) || 25, 100));
  return Math.min(100, Math.max(25, Math.ceil(normalized * 1.5), normalized + 10));
}

export function buildPostgresSemanticPlanRequests(planEntries = []) {
  const simpleByConnection = new Map();
  const requests = [];

  for (const entry of planEntries) {
    if (!entry || !Array.isArray(entry.scopeKeys) || entry.scopeKeys.length === 0) continue;
    const hasCandidateRecordKeys = Array.isArray(entry.candidateRecordKeys);
    const hasCandidateFilter = !!entry.postgresCandidateFilter;
    if (hasCandidateRecordKeys || hasCandidateFilter) {
      requests.push({
        connectorInstanceId: entry.connectorInstanceId ?? null,
        streamName: entry.streamName,
        scopeKeys: [...new Set(entry.scopeKeys)],
        candidateRecordKeys: entry.candidateRecordKeys,
        postgresCandidateFilter: entry.postgresCandidateFilter,
      });
      continue;
    }

    const key = entry.connectorInstanceId ?? '';
    let merged = simpleByConnection.get(key);
    if (!merged) {
      merged = {
        connectorInstanceId: entry.connectorInstanceId ?? null,
        scopeKeys: new Set(),
      };
      simpleByConnection.set(key, merged);
    }
    for (const scopeKey of entry.scopeKeys) merged.scopeKeys.add(scopeKey);
  }

  for (const merged of simpleByConnection.values()) {
    requests.unshift({
      connectorInstanceId: merged.connectorInstanceId,
      streamName: null,
      scopeKeys: [...merged.scopeKeys].sort(),
      candidateRecordKeys: null,
      postgresCandidateFilter: null,
    });
  }

  return requests;
}

async function persistSemanticSnapshot(snapshot) {
  // Store backend_hash alongside plan_hash so stale-cursor detection is
  // deterministic across restarts: the snapshot row is the source of truth
  // about what backend produced the cached distances.
  const planHash = JSON.stringify({ plan: snapshot.plan_hash, backend: snapshot.backend_hash });
  const resultsJson = JSON.stringify(snapshot.results);

  await getSemanticSearchStore().persistSnapshot({
    snapshotId: snapshot.snapshot_id,
    query: snapshot.query,
    planHash,
    resultsJson,
  });
}

async function loadSemanticSnapshot(snapshotId) {
  const row = await getSemanticSearchStore().loadSnapshotRow(snapshotId);
  return materializeSemanticSnapshot(row);
}

function materializeSemanticSnapshot(row) {
  if (!row) return null;
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
