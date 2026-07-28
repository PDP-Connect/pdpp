// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { BindValue, Page } from "../lib/db.ts";
import {
  allowUnboundedReadAcknowledged,
  getMany as dbGetMany,
  getOne as dbGetOne,
  iterateDynamicSqlAcknowledged as dbIterateDynamicSqlAcknowledged,
  exec,
  execDynamicSqlAcknowledged,
  referenceQueries,
  transaction,
} from "../lib/db.ts";
import type {
  SearchSemanticActor,
  SearchSemanticConnectorPlan,
  SearchSemanticDependencies,
  SearchSemanticGrant,
  SearchSemanticManifest,
  SearchSemanticManifestStream,
  SearchSemanticPlanEntry,
  SearchSemanticSnapshot,
  SearchSemanticSnapshotResult,
} from "../operations/rs-search-semantic/index.ts";
import {
  executeSearchSemantic,
  parseSearchSemanticParams,
  SearchSemanticRequestError,
} from "../operations/rs-search-semantic/index.ts";
import {
  listActiveOwnerBindingsForConnectors,
  resolveDisplayNamesForBindings,
  resolveFanInBindings,
} from "./connection-identity.ts";
import { withConnectorInstanceWrite } from "./connector-instance-write-coordinator.ts";
import { getDb } from "./db.ts";
import { LocalTransformerExecutor } from "./local-transformer-executor.ts";
import { assertGrantedManifestReadAuthority, assertOwnerSearchFilterAuthority } from "./manifest-read-authority.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "./owner-auth.ts";
import {
  postgresAnySemanticProgressRow,
  postgresCountIndexableSemanticValues,
  postgresCountSemanticIndexByScope,
  postgresCountSemanticRecords,
  postgresDeleteSemanticMeta,
  postgresDeleteSemanticProgress,
  postgresGetSemanticMeta,
  postgresGetSemanticProgress,
  postgresGetSemanticRecord,
  postgresListAllSemanticMetaIdentities,
  postgresListExistingSemanticKeys,
  postgresListSemanticConnectorInstanceIds,
  postgresListSemanticStreamsForConnector,
  postgresSemanticIndexDelete,
  postgresSemanticIndexDeleteByConnectorStream,
  postgresSemanticIndexInsertMany,
  postgresSemanticIndexUpsertMany,
  postgresSemanticRecordsPage,
  postgresSemanticSearch,
  postgresUpsertSemanticMeta,
  postgresUpsertSemanticProgress,
} from "./postgres-search.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";
import type { CompiledFilter } from "./record-filters.ts";
import { compileRequestFilters, passesGrantRecordConstraints, passesRequestFilters } from "./record-filters.ts";
import { mapSearchFanout } from "./search-fanout.ts";
import { sqliteCountIndexableTextValues } from "./search-index-counts.ts";

type SemanticManifestStream = SearchSemanticManifestStream & {
  query?: { search?: { semantic_fields?: string[] } };
};

type SemanticBackfillManifest = SearchSemanticManifest & {
  connector_id: string;
  streams: SemanticManifestStream[];
};
type SemanticSearchManifest = SearchSemanticManifest & {
  connector_id?: string;
  storage_binding?: { connector_id?: string; connector_instance_id?: string };
  streams: SemanticManifestStream[];
};

interface SemanticPlanEntry extends SearchSemanticPlanEntry {
  candidateRecordKeys?: string[] | null;
  connectorInstanceId?: string | null;
  postgresCandidateFilter?: {
    compiledFilters: CompiledFilter[];
    manifestStream: SemanticManifestStream;
    streamGrant: SemanticStreamGrant;
  };
  scopeKeys: string[];
}

interface SemanticConnectorPlan extends SearchSemanticConnectorPlan {
  grant: SemanticGrant;
  manifest: SemanticSearchManifest;
  planEntries: SemanticPlanEntry[];
}

interface CollapsedSemanticHit extends SemanticIndexHit {
  displayName?: string;
  matchedFields: string[];
  stream: string;
  topField: string;
}

interface SemanticGrant extends SearchSemanticGrant {
  streams?: Array<{
    name: string;
    fields?: string[];
    connection_id?: string;
    resources?: string[];
    time_range?: unknown;
    [key: string]: unknown;
  }>;
  subject?: { id?: string };
}
type SemanticStreamGrant = NonNullable<SemanticGrant["streams"]>[number];

interface SemanticPlanFilter {
  filters: CompiledFilter[];
  streamName: string;
}

interface SemanticRequestTokenInfo {
  client_id?: string | null;
  grant?: SemanticGrant;
  grant_id?: string | null;
  pdpp_token_kind: "owner" | "client";
  subject_id?: string | null;
}

interface SemanticResolvedGrant {
  manifest: SemanticSearchManifest;
  storageBinding?: { connector_id?: string; connector_instance_id?: string };
}

interface SemanticRunArgs {
  buildOwnerReadGrantForManifest: (manifest: SearchSemanticManifest) => SemanticGrant;
  getOwnerSubjectId?: () => string | null;
  opts: SemanticRunOptions;
  req: { query: Record<string, unknown> };
  resolveGrantManifest: (tokenInfo: SemanticRequestTokenInfo) => Promise<SemanticResolvedGrant>;
  resolveOwnerManifestFromScope: (scope: Record<string, unknown>) => Promise<SemanticResolvedGrant>;
  resolveOwnerScopeForConnector: (connectorId: string) => Record<string, unknown>;
  resolveOwnerVisibleConnectorIds: () => Promise<string[]>;
  tokenInfo: SemanticRequestTokenInfo;
}

interface SemanticRunOptions {
  semanticRetrievalCapability?: Record<string, unknown> | null;
  semanticRetrievalSupported?: boolean;
}

interface SemanticBackfillOptions {
  log?: (message: string) => void;
  manifest?: SemanticBackfillManifest;
  signal?: AbortSignal | null;
}

type SemanticDistanceMetric = "cosine" | "dot" | "l2";
type SemanticVector = Float32Array;
type SemanticRecordData = Record<string, unknown>;

interface SemanticEmbeddingBackend {
  available: () => boolean;
  close?: () => void;
  dimensions: () => number;
  distanceMetric: () => SemanticDistanceMetric;
  embedDocument: (text: string) => Promise<SemanticVector>;
  embedQuery: (text: string) => Promise<SemanticVector>;
  identity: () => string;
  languageBias: () => unknown;
  model: () => string;
  profileId: () => string;
  supportsDeviceAttemptDeadline?: () => boolean;
  [key: string]: unknown;
}

type SemanticEmbeddingConfig = Record<string, unknown> & {
  cacheDir: string;
  dimensions: number;
  distanceMetric: SemanticDistanceMetric;
  downloadAllowed: boolean;
  dtype: string;
  languageBias: { note: string; primary: string };
  modelId: string;
  profileId: string;
};

interface SemanticEmbeddingProfile {
  dimensions: number;
  distanceMetric: SemanticDistanceMetric;
  dtype: string;
  languageBias: { note: string; primary: string };
  modelId: string;
  profileId: string;
}

interface SemanticWorkWaiter {
  resolve: () => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface SemanticBackfillJob {
  connectorId: string;
  id: string;
  indexedVectors: number;
  manifestStreamsChecked: number;
  manifestStreamsTotal: number;
  phase: string;
  recordsScanned: number;
  recordsTotal: number | null;
  startedAt: string;
  stream: string | null;
  updatedAt: string;
}

interface SemanticDbRow {
  connector_id: string;
  connector_instance_id: string;
  created_at: string;
  dimensions: number;
  distance: number;
  distance_metric: SemanticDistanceMetric;
  embedding: Uint8Array;
  fields_fingerprint: string;
  id: number;
  model_id: string;
  n: number;
  plan_hash: string;
  record_json?: string | null;
  record_key: string;
  results_json: string;
  rowid: number;
  scope_key: string;
  snapshot_id: string;
  sql: string;
  stream: string;
  vector: Uint8Array;
  [key: string]: unknown;
}

interface SemanticIndexHit {
  connectorId: string;
  connectorInstanceId: string;
  distance: number;
  recordKey: string;
  scopeKey: string;
}

interface SemanticIndexEntry {
  connectorId: string;
  connectorInstanceId: string;
  recordKey: string;
  scopeKey: string;
  vector: SemanticVector;
}

interface SemanticIndex {
  countAll: () => number;
  countByConnectorScope: (connectorId: string, scopeKey: string, connectorInstanceId?: string | null) => number;
  deleteByConnector: (args: { connectorId: string }) => Promise<void> | void;
  deleteByConnectorScope: (args: {
    connectorId: string;
    connectorInstanceId?: string | null;
    scopeKey: string;
  }) => Promise<void> | void;
  deleteByConnectorStream: (args: {
    connectorId: string;
    connectorInstanceId?: string | null;
    stream: string;
  }) => Promise<void> | void;
  deleteRecord: (args: {
    connectorId: string;
    connectorInstanceId?: string | null;
    stream: string;
    recordKey: string;
  }) => Promise<void> | void;
  kind: string;
  listExistingKeys: (args: {
    connectorId: string;
    connectorInstanceId?: string | null;
    stream: string;
  }) => Promise<Set<string>> | Set<string>;
  queryPerConnector: (args: {
    connectorId: string;
    connectorInstanceId?: string | null;
    scopeKeys: string[];
    queryVector: SemanticVector;
    limit: number;
    recordKeys?: string[] | null;
  }) => Promise<SemanticIndexHit[]> | SemanticIndexHit[];
  upsert: (args: SemanticIndexEntry) => Promise<void> | void;
  upsertMany: (entries: SemanticIndexEntry[]) => Promise<void> | void;
}

interface SemanticVectorCacheEntry {
  expiresAt: number;
  promise: Promise<SemanticVector>;
}

async function runSequential<T>(values: Iterable<T>, operation: (value: T) => Promise<void>): Promise<void> {
  let chain = Promise.resolve();
  for (const value of values) {
    chain = chain.then(() => operation(value));
  }
  await chain;
}

function getOne<R extends SemanticDbRow = SemanticDbRow>(
  query: Parameters<typeof dbGetOne>[0],
  params: Parameters<typeof dbGetOne>[1] = []
): R | null {
  return dbGetOne<R>(query, params);
}

function getMany<R extends SemanticDbRow = SemanticDbRow>(
  query: Parameters<typeof dbGetMany>[0],
  params: Parameters<typeof dbGetMany>[1],
  options: Parameters<typeof dbGetMany>[2]
): Page<R> {
  return dbGetMany<R>(query, params, options);
}

async function getConnectorManifest(connectorId: string): Promise<SemanticSearchManifest | null> {
  const auth = await import(new URL("./auth.js", import.meta.url).href);
  return (await auth.getConnectorManifest(connectorId)) as unknown as SemanticSearchManifest | null;
}

function* iterateDynamicSqlAcknowledged<R extends SemanticDbRow = SemanticDbRow>(
  sql: string,
  params: Parameters<typeof dbIterateDynamicSqlAcknowledged>[1] = []
): Generator<R, void, unknown> {
  yield* dbIterateDynamicSqlAcknowledged<R>(sql, params);
}

// ─── scope_key encoding ────────────────────────────────────────────────────

/**
 * Canonical unambiguous encoding of a (stream, field) pair. Owner directive:
 * use JSON.stringify so a stream or field containing '|' cannot collide with
 * a different (stream, field) pair.
 */
export function encodeScopeKey(stream: string, field: string): string {
  return JSON.stringify([stream, field]);
}

function encodeVectorPairKey(scopeKey: string, recordKey: string): string {
  return JSON.stringify([scopeKey, recordKey]);
}

function scopeKeyPrefixForStream(stream: string): string {
  return `${JSON.stringify([stream]).slice(0, -1)},`;
}

// ─── Stream-level declaration lookup ───────────────────────────────────────

async function getStreamSemanticFields(connectorId: string, stream: string): Promise<string[] | null> {
  const manifest = await getConnectorManifest(connectorId);
  if (!manifest) {
    return null;
  }
  const mStream = (manifest.streams || []).find((s: SemanticManifestStream) => s.name === stream);
  const declared = mStream?.query?.search?.semantic_fields;
  if (!Array.isArray(declared) || declared.length === 0) {
    return null;
  }
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
export function makeStubBackend({ dimensions = 64 }: { dimensions?: number } = {}): SemanticEmbeddingBackend {
  function hashEmbed(text: string): SemanticVector {
    // FNV-1a-style mix over sha256 digest slices → Float32Array[dimensions].
    // Deterministic and reflexive: embedQuery and embedDocument use the same
    // function, so the query "hello" and the document "hello" produce the
    // exact same vector (distance 0 under cosine).
    const vec = new Float32Array(dimensions);
    if (typeof text !== "string" || text.length === 0) {
      return vec;
    }
    const digest = createHash("sha512").update(text, "utf8").digest();
    for (let i = 0; i < dimensions; i += 1) {
      const byte = digest[i % digest.length] as number;
      // Map each byte to [-1, 1] range; normalize at the end.
      vec[i] = byte / 127.5 - 1.0;
    }
    // Normalize so cosine distance works cleanly.
    let norm = 0;
    for (let i = 0; i < dimensions; i += 1) {
      const value = vec[i] as number;
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dimensions; i += 1) {
      vec[i] = (vec[i] as number) / norm;
    }
    return vec;
  }
  return {
    available: () => true,
    dimensions: () => dimensions,
    distanceMetric: () => "cosine",
    embedDocument: async (t) => hashEmbed(t),
    embedQuery: async (t) => hashEmbed(t),
    identity: () => `stub:${dimensions}:cosine`,
    languageBias: () => null,
    model: () => "pdpp-reference-stub-embed-v0",
    profileId: () => "stub",
    supportsDeviceAttemptDeadline: () => true,
  };
}

const LOCAL_EMBEDDING_PROFILES: Record<string, SemanticEmbeddingProfile> = {
  minilm: {
    dimensions: 384,
    distanceMetric: "cosine",
    dtype: "q4",
    languageBias: {
      note: "Compact English-biased MiniLM profile. Use multilingual-minilm for Italian or mixed-language corpora.",
      primary: "en",
    },
    modelId: "Xenova/all-MiniLM-L6-v2",
    profileId: "minilm",
  },
  "multilingual-minilm": {
    dimensions: 384,
    distanceMetric: "cosine",
    dtype: "q4",
    languageBias: {
      note: "Multilingual MiniLM profile suitable for Italian and other supported sentence-transformer languages.",
      primary: "multi",
    },
    modelId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    profileId: "multilingual-minilm",
  },
};

const DISTANCE_METRICS = new Set<SemanticDistanceMetric>(["cosine", "dot", "l2"]);
const EMBEDDING_BACKEND_ENV = "PDPP_SEMANTIC_EMBEDDING_BACKEND";
export const DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS = 2048;
// The child-executor receipt found no work limit that was materially faster
// than one across two warmed rounds, so reliability wins by default.
const DEFAULT_SEMANTIC_WORK_LIMIT = 1;
const DEFAULT_SEMANTIC_WORK_QUEUE_LIMIT = 16;
const DEFAULT_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS = 30_000;
const TRANSIENT_LOCAL_EXECUTOR_CODES = new Set([
  "transformer_deadline",
  "transformer_child_exited",
  "transformer_child_io_failed",
  "transformer_terminating",
  "transformer_spawn_failed",
  "transformer_work_busy",
]);
const DEFAULT_TRANSFORMERS_CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".cache",
  "transformers"
);

function parsePositiveInteger(raw: string | number | null | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

export class SemanticWorkAdmissionError extends Error {
  readonly code = "semantic_work_busy";

  constructor() {
    super("semantic index work is saturated");
    this.name = "SemanticWorkAdmissionError";
  }
}

let activeSemanticWork = 0;
const semanticWorkWaiters: SemanticWorkWaiter[] = [];

function configuredSemanticWorkLimit() {
  const requested = parsePositiveInteger(
    process.env.PDPP_SEMANTIC_WORK_LIMIT,
    DEFAULT_SEMANTIC_WORK_LIMIT,
    "PDPP_SEMANTIC_WORK_LIMIT"
  );
  // The operational benchmark selects a value from this explicit set. Eight
  // is a hard ceiling so request fan-out cannot overrun the local model host.
  return [1, 2, 4, 8].includes(requested) ? requested : DEFAULT_SEMANTIC_WORK_LIMIT;
}

function configuredSemanticWorkQueueLimit() {
  return parsePositiveInteger(
    process.env.PDPP_SEMANTIC_WORK_QUEUE_LIMIT,
    DEFAULT_SEMANTIC_WORK_QUEUE_LIMIT,
    "PDPP_SEMANTIC_WORK_QUEUE_LIMIT"
  );
}

function configuredSemanticWorkAcquireDeadlineMs() {
  return parsePositiveInteger(
    process.env.PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS,
    DEFAULT_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS,
    "PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS"
  );
}

function removeSemanticWorkWaiter(waiter: SemanticWorkWaiter): void {
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
  await new Promise<void>((resolve, reject) => {
    const waiter: SemanticWorkWaiter = {
      resolve: () => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        clearTimeout(waiter.timer);
        resolve();
      },
      settled: false,
      timer: setTimeout(() => {
        if (waiter.settled) {
          return;
        }
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
    if (!next || next.settled) {
      continue;
    }
    next.resolve();
    return;
  }
  activeSemanticWork = Math.max(0, activeSemanticWork - 1);
}

async function embedWithSemanticAdmission(operation: () => Promise<SemanticVector>): Promise<SemanticVector> {
  await acquireSemanticWork();
  try {
    return await operation();
  } finally {
    releaseSemanticWork();
  }
}

function embedDocumentWithAdmission(text: string): Promise<SemanticVector> {
  const activeBackend = requireSemanticBackend();
  return embedWithSemanticAdmission(() => activeBackend.embedDocument(text));
}

function embedQueryWithAdmission(text: string): Promise<SemanticVector> {
  const activeBackend = requireSemanticBackend();
  return embedWithSemanticAdmission(() => activeBackend.embedQuery(text));
}

function requireSemanticBackend(): SemanticEmbeddingBackend {
  if (!backend) {
    throw new Error("semantic embedding backend is not configured");
  }
  return backend;
}

export function semanticWorkStatsForTests() {
  return { active: activeSemanticWork, queued: semanticWorkWaiters.length };
}

function normalizeDownloadAllowed(raw: string | boolean | null | undefined): boolean {
  if (raw === undefined || raw === null || raw === "") {
    return true;
  }
  return !["0", "false", "no", "off"].includes(String(raw).toLowerCase());
}

function resolveLocalEmbeddingProfile(env: NodeJS.ProcessEnv = process.env): SemanticEmbeddingConfig {
  const requestedProfile = (env.PDPP_EMBEDDING_PROFILE_ID || "minilm").trim();
  const profile = LOCAL_EMBEDDING_PROFILES[requestedProfile];
  if (!profile) {
    throw new Error(`PDPP_EMBEDDING_PROFILE_ID must be one of: ${Object.keys(LOCAL_EMBEDDING_PROFILES).join(", ")}`);
  }
  const modelId = (env.PDPP_EMBEDDING_MODEL_ID || profile.modelId).trim();
  const dimensions = parsePositiveInteger(
    env.PDPP_EMBEDDING_DIMENSIONS,
    profile.dimensions,
    "PDPP_EMBEDDING_DIMENSIONS"
  );
  const distanceMetric = (
    env.PDPP_EMBEDDING_DISTANCE_METRIC || profile.distanceMetric
  ).trim() as SemanticDistanceMetric;
  if (!DISTANCE_METRICS.has(distanceMetric)) {
    throw new Error(`PDPP_EMBEDDING_DISTANCE_METRIC must be one of: ${Array.from(DISTANCE_METRICS).join(", ")}`);
  }
  const dtype = (env.PDPP_EMBEDDING_DTYPE || profile.dtype).trim();
  const cacheDir = path.resolve(
    env.PDPP_EMBEDDING_CACHE_DIR || env.TRANSFORMERS_CACHE || DEFAULT_TRANSFORMERS_CACHE_DIR
  );
  return {
    ...profile,
    cacheDir,
    dimensions,
    distanceMetric,
    downloadAllowed: normalizeDownloadAllowed(env.PDPP_EMBEDDING_DOWNLOAD_ALLOWED),
    dtype,
    modelId,
    profileId: requestedProfile,
  };
}

function dtypeModelFile(dtype: string): string {
  const suffixes: Record<string, string> = {
    bnb4: "_bnb4",
    fp16: "_fp16",
    fp32: "",
    int8: "_int8",
    q1: "_q1",
    q1f16: "_q1f16",
    q2: "_q2",
    q2f16: "_q2f16",
    q4: "_q4",
    q4f16: "_q4f16",
    q8: "_quantized",
    uint8: "_uint8",
  };
  const suffix = suffixes[dtype] ?? `_${dtype}`;
  return `model${suffix}.onnx`;
}

function modelCachePresent({
  cacheDir,
  modelId,
  dtype,
}: Pick<SemanticEmbeddingConfig, "cacheDir" | "modelId" | "dtype">): boolean {
  const required = [
    path.join(cacheDir, modelId, "config.json"),
    path.join(cacheDir, modelId, "onnx", dtypeModelFile(dtype)),
  ];
  return required.every((file) => fs.existsSync(file));
}

function normalizeEmbeddingVector(
  output: { data?: ArrayLike<number> } | ArrayLike<number>,
  expectedDimensions: number
): SemanticVector {
  const raw = "data" in output ? (output.data ?? output) : output;
  let arr: ArrayLike<number> | null = null;
  if (ArrayBuffer.isView(raw) || Array.isArray(raw)) {
    arr = raw as ArrayLike<number>;
  }
  if (!arr) {
    throw new Error("embedding backend returned an unsupported output shape");
  }
  const vec = Float32Array.from(Array.from(arr as ArrayLike<number>));
  if (vec.length !== expectedDimensions) {
    throw new Error(`embedding backend returned ${vec.length} dimensions; expected ${expectedDimensions}`);
  }
  return vec;
}

function normalizeSemanticEmbeddingInput(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (value.length <= DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS) {
    return value;
  }
  return value.slice(0, DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS);
}

/**
 * Local Transformers.js embedding backend used by the operational reference.
 * A credential-free OS child owns the model and is fenced on every deadline;
 * the parent lazily starts it on first semantic index/query work.
 */
export function makeLocalTransformerBackend(
  config: SemanticEmbeddingConfig = resolveLocalEmbeddingProfile(),
  { executorOptions = {} }: { executorOptions?: Record<string, unknown> } = {}
): SemanticEmbeddingBackend {
  let lastLoadError: unknown = null;
  const executor = new LocalTransformerExecutor(executorOptions);

  async function embed(text: string): Promise<SemanticVector> {
    try {
      return normalizeEmbeddingVector(
        await executor.embed(
          String(text || ""),
          `${config.profileId}:${config.modelId}:${config.dtype}:${config.dimensions}:${config.distanceMetric}`,
          config
        ),
        config.dimensions
      );
    } catch (err) {
      // A confirmed child deadline/exit or bounded admission rejection fences
      // only the current generation. The executor can start a replacement
      // generation after its exit is confirmed, so these transient lifecycle
      // outcomes must not deadlock semantic preflight on `available() ===
      // false`. Model-load/shape failures remain sticky and fail safely until
      // the backend is reconfigured; missing cache is independently rejected
      // by the normal availability check below.
      const code = err && typeof err === "object" && "code" in err ? err.code : null;
      if (typeof code !== "string" || !TRANSIENT_LOCAL_EXECUTOR_CODES.has(code)) {
        lastLoadError = err;
      }
      throw err;
    }
  }

  return {
    available: () => {
      if (lastLoadError) {
        return false;
      }
      return config.downloadAllowed || modelCachePresent(config);
    },
    close: () => executor.close(),
    dimensions: () => config.dimensions,
    distanceMetric: () => config.distanceMetric,
    downloadAllowed: () => config.downloadAllowed,
    dtype: () => config.dtype,
    embedDocument: embed,
    embedQuery: embed,
    executionTelemetry: () => executor.telemetry(),
    identity: () =>
      `${config.profileId}:${config.modelId}:${config.dtype}:${config.dimensions}:${config.distanceMetric}`,
    languageBias: () => config.languageBias,
    model: () => config.modelId,
    modelCachePath: () => config.cacheDir,
    modelCachePresent: () => modelCachePresent(config),
    profileId: () => config.profileId,
    resetExecutionTelemetry: () => executor.resetTelemetry(),
    supportsDeviceAttemptDeadline: () => true,
  };
}

export function resolveSemanticBackendFromEnv(env: NodeJS.ProcessEnv = process.env): SemanticEmbeddingBackend | null {
  const defaultMode = env.PDPP_REFERENCE_OPERATIONAL_DEFAULTS === "1" ? "local" : "stub";
  const mode = (env[EMBEDDING_BACKEND_ENV] || defaultMode).trim().toLowerCase();
  if (["0", "false", "off", "none", "disabled"].includes(mode)) {
    return null;
  }
  if (["local", "transformers", "transformers-js"].includes(mode)) {
    if (env.NODE_ENV === "production" && env.PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT !== "1") {
      throw new Error(
        "production local semantic execution requires PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1"
      );
    }
    return makeLocalTransformerBackend(resolveLocalEmbeddingProfile(env));
  }
  if (mode === "stub") {
    return makeStubBackend();
  }
  throw new Error(`${EMBEDDING_BACKEND_ENV} must be one of: local, stub, disabled`);
}

// Module-scoped backend, configured by configureSemanticBackend() or left
// null (extension is not advertised).
let backend: SemanticEmbeddingBackend | null = null;
let activeBackfillCount = 0;
let nextBackfillJobId = 1;
const backfillJobs = new Map<string, SemanticBackfillJob>();
const semanticQueryVectorCache = new Map<string, SemanticVectorCacheEntry>();
const DEFAULT_SEMANTIC_QUERY_VECTOR_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_SEMANTIC_QUERY_VECTOR_CACHE_MAX = 128;

function semanticQueryVectorCacheTtlMs({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): number {
  const parsed = Number.parseInt(env.PDPP_SEMANTIC_QUERY_VECTOR_CACHE_MS || "", 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return DEFAULT_SEMANTIC_QUERY_VECTOR_CACHE_MS;
}

function semanticQueryVectorCacheMax({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): number {
  const parsed = Number.parseInt(env.PDPP_SEMANTIC_QUERY_VECTOR_CACHE_MAX || "", 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return DEFAULT_SEMANTIC_QUERY_VECTOR_CACHE_MAX;
}

function pruneSemanticQueryVectorCache(maxEntries: number): void {
  while (semanticQueryVectorCache.size > maxEntries) {
    const oldestKey = semanticQueryVectorCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    semanticQueryVectorCache.delete(oldestKey);
  }
}

function embedSemanticQueryWithCache(input: unknown): Promise<SemanticVector> {
  const text = normalizeSemanticEmbeddingInput(input) ?? "";
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
export function configureSemanticBackend(b: SemanticEmbeddingBackend | null): void {
  backend = b;
  semanticQueryVectorCache.clear();
}

export function getSemanticBackend(): SemanticEmbeddingBackend | null {
  return backend;
}

export function isSemanticCapabilityAvailable() {
  if (!backend || typeof backend.embedDocument !== "function") {
    return false;
  }
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

function publicBackfillJob(job: SemanticBackfillJob): Record<string, unknown> {
  return {
    active_jobs: activeBackfillCount,
    connector_id: job.connectorId,
    id: job.id,
    indexed_vectors: job.indexedVectors,
    manifest_streams_checked: job.manifestStreamsChecked,
    manifest_streams_total: job.manifestStreamsTotal,
    phase: job.phase,
    records_scanned: job.recordsScanned,
    records_total: job.recordsTotal,
    started_at: job.startedAt,
    stream: job.stream,
    updated_at: job.updatedAt,
  };
}

function latestBackfillJob(): SemanticBackfillJob | null {
  let latest: SemanticBackfillJob | null = null;
  for (const job of backfillJobs.values()) {
    if (!latest || job.updatedAt > latest.updatedAt) {
      latest = job;
    }
  }
  return latest;
}

function updateBackfillJob(job: SemanticBackfillJob, patch: Partial<SemanticBackfillJob>): SemanticBackfillJob {
  const updated: SemanticBackfillJob = {
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
function makeBlobFlatIndex({
  dimensions,
  distanceMetric,
}: {
  db?: unknown;
  dimensions: number;
  distanceMetric: SemanticDistanceMetric;
}): SemanticIndex {
  const byteLen = dimensions * 4;

  function distance(a: SemanticVector, b: SemanticVector): number {
    if (distanceMetric === "cosine") {
      // Vectors are pre-normalized by the stub; for hosted backends we
      // still fall back to a dot-product equivalent which is fine because
      // both stored and query vectors go through the same backend.
      let dot = 0;
      for (let i = 0; i < dimensions; i += 1) {
        dot += (a[i] as number) * (b[i] as number);
      }
      return 1 - dot;
    }
    if (distanceMetric === "dot") {
      let dot = 0;
      for (let i = 0; i < dimensions; i += 1) {
        dot += (a[i] as number) * (b[i] as number);
      }
      return -dot;
    }
    // l2
    let sum = 0;
    for (let i = 0; i < dimensions; i += 1) {
      const d = (a[i] as number) - (b[i] as number);
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  function collectBlobHits(
    rows: Iterable<SemanticDbRow>,
    connectorId: string,
    queryVector: SemanticVector,
    limit: number
  ): SemanticIndexHit[] {
    const scored: SemanticIndexHit[] = [];
    for (const row of rows) {
      if (!row.embedding || row.embedding.length !== byteLen) {
        continue;
      }
      const buf = Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding);
      const storedVec = new Float32Array(buf.buffer, buf.byteOffset, dimensions);
      scored.push({
        connectorId,
        connectorInstanceId: row.connector_instance_id,
        distance: distance(queryVector, storedVec),
        recordKey: row.record_key,
        scopeKey: row.scope_key,
      });
    }
    return scored.sort(compareHits).slice(0, limit);
  }

  return {
    countAll() {
      const row = getOne(referenceQueries.searchSemanticBlobCountAll, []);
      return Number(row?.n || 0);
    },
    countByConnectorScope(connectorId, scopeKey, connectorInstanceId = null) {
      if (connectorInstanceId) {
        const [row] = Array.from(
          iterateDynamicSqlAcknowledged(
            "SELECT COUNT(*) AS n FROM semantic_search_blob WHERE connector_instance_id = ? AND connector_id = ? AND scope_key = ?",
            [connectorInstanceId, connectorId, scopeKey]
          )
        );
        return Number(row?.n || 0);
      }
      const row = getOne(referenceQueries.searchSemanticBlobCountByScope, [connectorId, scopeKey]);
      return Number(row?.n || 0);
    },
    deleteByConnector({ connectorId }: { connectorId: string }): void {
      exec(referenceQueries.searchSemanticBlobDeleteByConnector, [connectorId]);
    },
    deleteByConnectorScope({
      connectorId,
      connectorInstanceId = null,
      scopeKey,
    }: {
      connectorId: string;
      connectorInstanceId?: string | null;
      scopeKey: string;
    }): void {
      if (connectorInstanceId) {
        execDynamicSqlAcknowledged(
          "DELETE FROM semantic_search_blob WHERE connector_instance_id = ? AND connector_id = ? AND scope_key = ?",
          [connectorInstanceId, connectorId, scopeKey]
        );
        return;
      }
      exec(referenceQueries.searchSemanticBlobDeleteByScope, [connectorId, scopeKey]);
    },
    deleteByConnectorStream({
      connectorId,
      connectorInstanceId = null,
      stream,
    }: {
      connectorId: string;
      connectorInstanceId?: string | null;
      stream: string;
    }): void {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      if (connectorInstanceId) {
        execDynamicSqlAcknowledged(
          "DELETE FROM semantic_search_blob WHERE connector_instance_id = ? AND connector_id = ? AND scope_key LIKE ?",
          [connectorInstanceId, connectorId, `${streamPrefix}%`]
        );
        return;
      }
      exec(referenceQueries.searchSemanticBlobDeleteByStreamPrefix, [connectorId, `${streamPrefix}%`]);
    },
    deleteRecord({
      connectorId,
      connectorInstanceId,
      stream,
      recordKey,
    }: {
      connectorId: string;
      connectorInstanceId?: string | null;
      stream: string;
      recordKey: string;
    }): void {
      // scope_key contains stream as the first JSON array element. Use
      // a LIKE match anchored on the opening characters of scope_key's
      // JSON encoding to narrow before comparing the stream name exactly
      // against the decoded scope_key.
      const streamPrefix = scopeKeyPrefixForStream(stream); // e.g. '["posts",'
      if (!connectorInstanceId) {
        execDynamicSqlAcknowledged(
          "DELETE FROM semantic_search_blob WHERE connector_id = ? AND record_key = ? AND scope_key LIKE ?",
          [connectorId, recordKey, `${streamPrefix}%`]
        );
        return;
      }
      exec(referenceQueries.searchSemanticBlobDeleteByRecordAndStreamPrefix, [
        connectorId,
        connectorInstanceId,
        recordKey,
        `${streamPrefix}%`,
      ]);
    },
    kind: "blob-flat",
    listExistingKeys({
      connectorId,
      connectorInstanceId = null,
      stream,
    }: {
      connectorId: string;
      connectorInstanceId?: string | null;
      stream: string;
    }): Set<string> {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      const PAGE = 1000;
      const result = new Set<string>();
      let cursorRowid = 0;
      for (;;) {
        const rows = connectorInstanceId
          ? Array.from(
              iterateDynamicSqlAcknowledged(
                `SELECT rowid, connector_instance_id, scope_key, record_key
             FROM semantic_search_blob
             WHERE connector_instance_id = ?
               AND connector_id = ?
               AND scope_key LIKE ?
               AND rowid > ?
             ORDER BY rowid ASC
             LIMIT ?`,
                [connectorInstanceId, connectorId, `${streamPrefix}%`, cursorRowid, PAGE]
              )
            )
          : getMany(
              referenceQueries.searchSemanticBlobListExistingKeysByStreamPrefix,
              [connectorId, `${streamPrefix}%`, cursorRowid],
              { limit: PAGE }
            ).rows;
        for (const row of rows) {
          result.add(encodeVectorPairKey(row.scope_key, `${row.connector_instance_id}\u0000${row.record_key}`));
          cursorRowid = Number(row.rowid);
        }
        if (rows.length < PAGE) {
          break;
        }
      }
      return result;
    },
    queryPerConnector({
      connectorId,
      connectorInstanceId = null,
      scopeKeys,
      queryVector,
      limit,
      recordKeys = null,
    }: {
      connectorId: string;
      connectorInstanceId?: string | null;
      scopeKeys: string[];
      queryVector: SemanticVector;
      limit: number;
      recordKeys?: string[] | null;
    }): SemanticIndexHit[] {
      if (!Array.isArray(scopeKeys) || scopeKeys.length === 0) {
        return [];
      }
      if (Array.isArray(recordKeys) && recordKeys.length === 0) {
        return [];
      }
      const placeholders = scopeKeys.map(() => "?").join(",");
      const recordKeyClause = Array.isArray(recordKeys)
        ? `AND record_key IN (${recordKeys.map(() => "?").join(",")})`
        : "";
      // REVIEWED-DYNAMIC: SCOPE_KEY and RECORD_KEY IN-clauses have variable
      // cardinality from the grant-narrowed plan; SQL composed at call time;
      // overall row count is bounded by the plan's authorized scope+record
      // tuples and we slice to `limit` after distance scoring.
      const instanceClause = connectorInstanceId ? "AND connector_instance_id = ?" : "";
      const sql = `
        SELECT connector_instance_id, scope_key, record_key, embedding
        FROM semantic_search_blob
        WHERE connector_id = ?
          ${instanceClause}
          AND scope_key IN (${placeholders})
          ${recordKeyClause}
      `;
      return collectBlobHits(
        iterateDynamicSqlAcknowledged(sql, [
          connectorId,
          ...(connectorInstanceId ? [connectorInstanceId] : []),
          ...scopeKeys,
          ...(recordKeys || []),
        ]),
        connectorId,
        queryVector,
        limit
      );
    },
    upsert({ connectorId, connectorInstanceId, scopeKey, recordKey, vector }: SemanticIndexEntry): void {
      const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
      exec(referenceQueries.searchSemanticBlobUpsert, [connectorInstanceId, connectorId, scopeKey, recordKey, buf]);
    },
    upsertMany(entries: SemanticIndexEntry[]): void {
      if (entries.length === 0) {
        return;
      }
      transaction(() => {
        for (const entry of entries) {
          const buf = Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength);
          exec(referenceQueries.searchSemanticBlobUpsert, [
            entry.connectorInstanceId,
            entry.connectorId,
            entry.scopeKey,
            entry.recordKey,
            buf,
          ]);
        }
      });
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
function makeSqliteVecIndex({
  dimensions,
  distanceMetric,
}: {
  db?: unknown;
  dimensions: number;
  distanceMetric: SemanticDistanceMetric;
}): SemanticIndex {
  // Bootstrap the vec0 virtual table lazily on first use. Dimensions and
  // distance_metric are baked into the schema. If either changes, recreate
  // the virtual table and let manifest backfill rebuild from stored records.
  function ensureTable() {
    const existing = getOne(referenceQueries.searchSemanticVecGetTableSql, []);
    if (existing) {
      const sql = String(existing.sql || "");
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
      execDynamicSqlAcknowledged("DROP TABLE semantic_search_vec", []);
      exec(referenceQueries.searchSemanticRowidDeleteAll, []);
      exec(referenceQueries.searchSemanticMetaDeleteAll, []);
      exec(referenceQueries.searchSemanticProgressDeleteAll, []);
      exec(referenceQueries.searchSemanticSnapshotsDeleteAll, []);
    }
    // REVIEWED-DYNAMIC: CREATE VIRTUAL TABLE has dimensions/metric
    // interpolated from validated backend config (small enumeration of
    // metrics × backend-defined dimensions). No user input crosses into
    // the SQL string.
    execDynamicSqlAcknowledged(
      `
      CREATE VIRTUAL TABLE semantic_search_vec USING vec0(
        connector_instance_id TEXT PARTITION KEY,
        connector_id TEXT,
        scope_key    TEXT,
        +record_key  TEXT,
        embedding    FLOAT[${dimensions}] distance_metric=${distanceMetric}
      )
    `,
      []
    );
  }
  ensureTable();

  function upsertOne({ connectorId, connectorInstanceId, scopeKey, recordKey, vector }: SemanticIndexEntry): void {
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const existing = getOne(referenceQueries.searchSemanticRowidGetRowidByIdentity, [
      connectorInstanceId,
      scopeKey,
      recordKey,
    ]);
    if (existing) {
      // REVIEWED-DYNAMIC: UPDATE on semantic_search_vec is a runtime
      // mutation the wrapper cannot register because the table is
      // created lazily; static prepare validation would fail before
      // ensureTable() runs.
      execDynamicSqlAcknowledged("UPDATE semantic_search_vec SET embedding = ? WHERE rowid = ?", [buf, existing.rowid]);
      return;
    }
    // REVIEWED-DYNAMIC: INSERT into semantic_search_vec is a runtime
    // mutation against a lazily-created table.
    const info = execDynamicSqlAcknowledged(
      "INSERT INTO semantic_search_vec(connector_instance_id, connector_id, scope_key, record_key, embedding) VALUES(?, ?, ?, ?, ?)",
      [connectorInstanceId, connectorId, scopeKey, recordKey, buf]
    );
    exec(referenceQueries.searchSemanticRowidInsert, [
      connectorInstanceId,
      connectorId,
      scopeKey,
      recordKey,
      Number(info.lastInsertRowid),
    ]);
  }

  // Page through the rowid sidecar and delete corresponding vec rows.
  // The vec table mutations use the dynamic helper (lazy table) and the
  // sidecar mutations use static wrapper artifacts.
  const ROWID_PAGE = 1000;

  function deleteVecByRowid(rowid: number): void {
    // REVIEWED-DYNAMIC: DELETE on semantic_search_vec runs against the
    // lazily-created table; static registration would fail.
    execDynamicSqlAcknowledged("DELETE FROM semantic_search_vec WHERE rowid = ?", [rowid]);
  }

  function deleteRecordAcrossInstances({
    connectorId,
    recordKey,
    streamPrefix,
  }: {
    connectorId: string;
    recordKey: string;
    streamPrefix: string;
  }): void {
    let cursorRowid = 0;
    for (;;) {
      const rows = Array.from(
        iterateDynamicSqlAcknowledged(
          `SELECT rowid, connector_instance_id, scope_key
         FROM semantic_search_rowid
         WHERE connector_id = ? AND record_key = ? AND scope_key LIKE ? AND rowid > ?
         ORDER BY rowid ASC
         LIMIT ?`,
          [connectorId, recordKey, `${streamPrefix}%`, cursorRowid, ROWID_PAGE]
        )
      );
      for (const row of rows) {
        deleteVecByRowid(row.rowid);
        exec(referenceQueries.searchSemanticRowidDeleteByIdentity, [
          row.connector_instance_id,
          row.scope_key,
          recordKey,
        ]);
        cursorRowid = Number(row.rowid);
      }
      if (rows.length < ROWID_PAGE) {
        break;
      }
    }
  }

  function deleteRecordForInstance({
    connectorId,
    connectorInstanceId,
    recordKey,
    streamPrefix,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    recordKey: string;
    streamPrefix: string;
  }): void {
    let cursorRowid = 0;
    for (;;) {
      const page = getMany(
        referenceQueries.searchSemanticRowidPageByRecordAndStreamPrefix,
        [connectorId, connectorInstanceId, recordKey, `${streamPrefix}%`, cursorRowid],
        { limit: ROWID_PAGE }
      );
      for (const row of page.rows) {
        deleteVecByRowid(row.rowid);
        exec(referenceQueries.searchSemanticRowidDeleteByIdentity, [connectorInstanceId, row.scope_key, recordKey]);
        cursorRowid = Number(row.rowid);
      }
      if (!page.truncated) {
        break;
      }
    }
  }

  return {
    countAll() {
      const row = getOne(referenceQueries.searchSemanticRowidCountAll, []);
      return Number(row?.n || 0);
    },
    countByConnectorScope(connectorId, scopeKey, connectorInstanceId = null) {
      if (connectorInstanceId) {
        const [row] = Array.from(
          iterateDynamicSqlAcknowledged(
            "SELECT COUNT(*) AS n FROM semantic_search_rowid WHERE connector_instance_id = ? AND connector_id = ? AND scope_key = ?",
            [connectorInstanceId, connectorId, scopeKey]
          )
        );
        return Number(row?.n || 0);
      }
      const row = getOne(referenceQueries.searchSemanticRowidCountByScope, [connectorId, scopeKey]);
      return Number(row?.n || 0);
    },
    deleteByConnector({ connectorId }) {
      let cursorRowid = 0;
      for (;;) {
        const page = getMany(referenceQueries.searchSemanticRowidPageByConnector, [connectorId, cursorRowid], {
          limit: ROWID_PAGE,
        });
        for (const row of page.rows) {
          deleteVecByRowid(row.rowid);
          cursorRowid = Number(row.rowid);
        }
        if (!page.truncated) {
          break;
        }
      }
      exec(referenceQueries.searchSemanticRowidDeleteByConnector, [connectorId]);
    },
    deleteByConnectorScope({ connectorId, scopeKey }) {
      let cursorRowid = 0;
      for (;;) {
        const page = getMany(referenceQueries.searchSemanticRowidPageByScope, [connectorId, scopeKey, cursorRowid], {
          limit: ROWID_PAGE,
        });
        for (const row of page.rows) {
          deleteVecByRowid(row.rowid);
          cursorRowid = Number(row.rowid);
        }
        if (!page.truncated) {
          break;
        }
      }
      exec(referenceQueries.searchSemanticRowidDeleteByScope, [connectorId, scopeKey]);
    },
    deleteByConnectorStream({ connectorId, connectorInstanceId = null, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      if (connectorInstanceId) {
        const rows = Array.from(
          iterateDynamicSqlAcknowledged(
            `SELECT rowid
           FROM semantic_search_rowid
           WHERE connector_instance_id = ? AND connector_id = ? AND scope_key LIKE ?`,
            [connectorInstanceId, connectorId, `${streamPrefix}%`]
          )
        );
        for (const row of rows) {
          deleteVecByRowid(row.rowid);
        }
        execDynamicSqlAcknowledged(
          "DELETE FROM semantic_search_rowid WHERE connector_instance_id = ? AND connector_id = ? AND scope_key LIKE ?",
          [connectorInstanceId, connectorId, `${streamPrefix}%`]
        );
        return;
      }
      let cursorRowid = 0;
      for (;;) {
        const page = getMany(
          referenceQueries.searchSemanticRowidPageByStreamPrefix,
          [connectorId, `${streamPrefix}%`, cursorRowid],
          { limit: ROWID_PAGE }
        );
        for (const row of page.rows) {
          deleteVecByRowid(row.rowid);
          cursorRowid = Number(row.rowid);
        }
        if (!page.truncated) {
          break;
        }
      }
      exec(referenceQueries.searchSemanticRowidDeleteByStreamPrefix, [connectorId, `${streamPrefix}%`]);
    },
    deleteRecord({ connectorId, connectorInstanceId, stream, recordKey }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      if (!connectorInstanceId) {
        deleteRecordAcrossInstances({ connectorId, recordKey, streamPrefix });
        return;
      }
      deleteRecordForInstance({ connectorId, connectorInstanceId, recordKey, streamPrefix });
    },
    kind: "sqlite-vec",
    listExistingKeys({ connectorId, connectorInstanceId = null, stream }) {
      const streamPrefix = scopeKeyPrefixForStream(stream);
      const PAGE = 1000;
      const result = new Set<string>();
      let cursorRowid = 0;
      for (;;) {
        const rows = connectorInstanceId
          ? Array.from(
              iterateDynamicSqlAcknowledged(
                `SELECT rowid, connector_instance_id, scope_key, record_key
             FROM semantic_search_rowid
             WHERE connector_instance_id = ?
               AND connector_id = ?
               AND scope_key LIKE ?
               AND rowid > ?
             ORDER BY rowid ASC
             LIMIT ?`,
                [connectorInstanceId, connectorId, `${streamPrefix}%`, cursorRowid, PAGE]
              )
            )
          : getMany(
              referenceQueries.searchSemanticRowidListExistingKeysByStreamPrefix,
              [connectorId, `${streamPrefix}%`, cursorRowid],
              { limit: PAGE }
            ).rows;
        for (const row of rows) {
          result.add(encodeVectorPairKey(row.scope_key, `${row.connector_instance_id}\u0000${row.record_key}`));
          cursorRowid = Number(row.rowid);
        }
        if (rows.length < PAGE) {
          break;
        }
      }
      return result;
    },
    queryPerConnector({ connectorId, connectorInstanceId = null, scopeKeys, queryVector, limit, recordKeys = null }) {
      if (!Array.isArray(scopeKeys) || scopeKeys.length === 0) {
        return [];
      }
      if (Array.isArray(recordKeys) && recordKeys.length === 0) {
        return [];
      }
      const placeholders = scopeKeys.map(() => "?").join(",");
      const connectorInstanceIds = connectorInstanceId
        ? [connectorInstanceId]
        : Array.from(
            iterateDynamicSqlAcknowledged(
              `SELECT DISTINCT connector_instance_id
           FROM semantic_search_rowid
           WHERE connector_id = ?
             AND scope_key IN (${placeholders})`,
              [connectorId, ...scopeKeys]
            )
          )
            .map((row) => row.connector_instance_id)
            .filter(Boolean);
      if (connectorInstanceIds.length === 0) {
        return [];
      }
      const recordKeyClause = Array.isArray(recordKeys)
        ? `AND rowid IN (
             SELECT rowid
             FROM semantic_search_rowid
             WHERE connector_id = ?
               AND scope_key IN (${placeholders})
               AND record_key IN (${recordKeys.map(() => "?").join(",")})
           )`
        : "";
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
      const hits: SemanticIndexHit[] = [];
      for (const instanceId of connectorInstanceIds) {
        const params = [
          buf,
          instanceId,
          connectorId,
          ...scopeKeys,
          ...(recordKeys ? [connectorId, ...scopeKeys, ...recordKeys] : []),
          limit,
        ];
        for (const r of iterateDynamicSqlAcknowledged(sql, params)) {
          hits.push({
            connectorId: r.connector_id,
            connectorInstanceId: r.connector_instance_id,
            distance: Number(r.distance),
            recordKey: r.record_key,
            scopeKey: r.scope_key,
          });
        }
      }
      // vec0 orders by distance already; apply the secondary total-order
      // tie-breakers here so merge-in-app is deterministic.
      hits.sort(compareHits);
      return hits;
    },
    upsert({ connectorId, connectorInstanceId, scopeKey, recordKey, vector }) {
      upsertOne({ connectorId, connectorInstanceId, recordKey, scopeKey, vector });
    },
    upsertMany(entries) {
      if (entries.length === 0) {
        return;
      }
      transaction(() => {
        for (const entry of entries) {
          upsertOne(entry);
        }
      });
    },
  };
}

/**
 * Total order for merged hits. Owner directive: sort by distance, then
 * connector_id, then scope_key, then record_key. Drives page slicing,
 * has_more, and cursor round-trips.
 */
function compareHits(a: SemanticIndexHit, b: SemanticIndexHit): number {
  if (a.distance !== b.distance) {
    return a.distance - b.distance;
  }
  if (a.connectorId !== b.connectorId) {
    return a.connectorId < b.connectorId ? -1 : 1;
  }
  if (a.connectorInstanceId !== b.connectorInstanceId) {
    return a.connectorInstanceId < b.connectorInstanceId ? -1 : 1;
  }
  if (a.scopeKey !== b.scopeKey) {
    return a.scopeKey < b.scopeKey ? -1 : 1;
  }
  if (a.recordKey !== b.recordKey) {
    return a.recordKey < b.recordKey ? -1 : 1;
  }
  return 0;
}

// Cached vector index handle keyed on the current db instance. getDb()
// returns a fresh Proxy wrapper after every initDb(), so when tests call
// closeDb()+initDb() between cases the cache naturally invalidates (the
// old handle's `db` reference is no longer current). This replaces an
// earlier module-scoped `let vectorIndex = null` that survived across
// DB reopens and triggered "database connection is not open" crashes.
let cachedIndex: SemanticIndex | null = null;
let cachedIndexDb: unknown = null;

function ensureVectorIndex(): SemanticIndex | null {
  if (!backend) {
    return null;
  }
  const db = getDb();
  if (cachedIndex && cachedIndexDb === db) {
    return cachedIndex;
  }
  const kind = db.vectorIndexKind;
  const dimensions = backend.dimensions();
  const distanceMetric = backend.distanceMetric();
  if (kind === "sqlite-vec") {
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

export async function semanticIndexUpsert({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
  data,
  declaredFields,
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  recordKey: string;
  data?: SemanticRecordData | null;
  declaredFields?: string[];
}): Promise<void> {
  if (!backend) {
    return;
  }
  const declared = declaredFields === undefined ? await getStreamSemanticFields(connectorId, stream) : declaredFields;
  if (!declared) {
    return;
  }
  const entries = (
    await Promise.all(
      declared.map(async (field) => {
        const text = normalizeSemanticEmbeddingInput(data?.[field]);
        if (!text) {
          return null;
        }
        return {
          connectorId,
          connectorInstanceId,
          recordKey,
          scopeKey: encodeScopeKey(stream, field),
          vector: await embedDocumentWithAdmission(text),
        } satisfies SemanticIndexEntry;
      })
    )
  ).filter((entry): entry is SemanticIndexEntry => entry !== null);
  if (isPostgresStorageBackend()) {
    await postgresSemanticIndexUpsertMany({ connectorId, connectorInstanceId, entries, recordKey, stream });
    if (entries.length > 0) {
      await postgresUpsertSemanticMeta({
        connectorId,
        connectorInstanceId,
        dimensions: backend.dimensions(),
        distanceMetric: backend.distanceMetric(),
        fieldsFingerprint: fingerprintSemanticFields(declared),
        modelId: backendStorageIdentity(backend),
        stream,
      });
    }
    return;
  }
  const index = ensureVectorIndex();
  if (!index) {
    return;
  }
  // Delete only this logical record's stale vectors after embeddings succeed.
  // Deleting by scope here would wipe every row for the field.
  await index.deleteRecord({ connectorId, connectorInstanceId, recordKey, stream });
  if (entries.length > 0 && typeof index.upsertMany === "function") {
    await index.upsertMany(entries);
    exec(referenceQueries.searchSemanticMetaUpsert, [
      connectorInstanceId,
      connectorId,
      stream,
      fingerprintSemanticFields(declared),
      backendStorageIdentity(backend),
      backend.dimensions(),
      backend.distanceMetric(),
      new Date().toISOString(),
    ]);
    return;
  }
  await runSequential(entries, (entry) => Promise.resolve(index.upsert(entry)));
  if (entries.length > 0) {
    exec(referenceQueries.searchSemanticMetaUpsert, [
      connectorInstanceId,
      connectorId,
      stream,
      fingerprintSemanticFields(declared),
      backendStorageIdentity(backend),
      backend.dimensions(),
      backend.distanceMetric(),
      new Date().toISOString(),
    ]);
  }
}

export async function semanticIndexDelete({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  recordKey: string;
}): Promise<void> {
  if (!backend) {
    return;
  }
  if (isPostgresStorageBackend()) {
    await postgresSemanticIndexDelete({ connectorId, connectorInstanceId, recordKey, stream });
    return;
  }
  const index = ensureVectorIndex();
  if (!index) {
    return;
  }
  await index.deleteRecord({ connectorId, connectorInstanceId, recordKey, stream });
}

export async function semanticIndexDeleteByConnectorStream({
  connectorId,
  connectorInstanceId,
  stream,
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
}): Promise<void> {
  if (!backend) {
    return;
  }
  if (isPostgresStorageBackend()) {
    await postgresSemanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    return;
  }
  const index = ensureVectorIndex();
  if (!index) {
    return;
  }
  await index.deleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  execDynamicSqlAcknowledged("DELETE FROM semantic_search_meta WHERE connector_instance_id = ? AND stream = ?", [
    connectorInstanceId,
    stream,
  ]);
  deleteBackfillProgress({ connectorId, connectorInstanceId, stream });
}

// ─── Drift-detect + backfill ───────────────────────────────────────────────

function fingerprintSemanticFields(declaredFields: readonly string[]): string {
  const unique = Array.from(new Set(declaredFields));
  unique.sort();
  return JSON.stringify(unique);
}

function semanticIdentityMatches(
  row: SemanticDbRow | null,
  {
    fieldsFingerprint,
    modelId,
    dimensions,
    distanceMetric,
  }: { fieldsFingerprint: string; modelId: string; dimensions: number; distanceMetric: SemanticDistanceMetric }
): boolean {
  return (
    !!row &&
    row.fields_fingerprint === fieldsFingerprint &&
    row.model_id === modelId &&
    Number(row.dimensions) === dimensions &&
    row.distance_metric === distanceMetric
  );
}

function jsonPathForTopLevelField(field: string): string {
  return `$."${String(field).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function countIndexableSemanticValues({
  connectorInstanceId,
  stream,
  declaredFields,
}: {
  connectorInstanceId: string;
  stream: string;
  declaredFields: readonly string[];
}): number {
  return sqliteCountIndexableTextValues({
    connectorInstanceId,
    declaredFields,
    iterateDynamicSql: (sql, params) => iterateDynamicSqlAcknowledged(sql, params as readonly BindValue[]),
    jsonPathForField: jsonPathForTopLevelField,
    stream,
  });
}

function listSemanticConnectorInstanceIds({ connectorId, stream }: { connectorId: string; stream: string }): string[] {
  const rows = iterateDynamicSqlAcknowledged(
    `
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
  `,
    [connectorId, stream, connectorId, stream, connectorId, stream]
  );
  return Array.from(rows, (row) => row.connector_instance_id).filter(Boolean);
}

function backendStorageIdentity(b: SemanticEmbeddingBackend): string {
  const parts = [`model=${b.model()}`, `dimensions=${b.dimensions()}`, `metric=${b.distanceMetric()}`];
  if (typeof b.profileId === "function") {
    parts.push(`profile=${b.profileId()}`);
  }
  if (typeof b.dtype === "function") {
    parts.push(`dtype=${b.dtype()}`);
  }
  return parts.join(";");
}

async function buildSemanticIndexEntries(
  rows: readonly SemanticDbRow[],
  declaredFields: readonly string[],
  connectorId: string,
  connectorInstanceId: string,
  stream: string,
  existingKeys: Set<string> | null
): Promise<SemanticIndexEntry[]> {
  const entries: SemanticIndexEntry[] = [];
  let embeddingChain = Promise.resolve();
  for (const row of rows) {
    let data: SemanticRecordData | null;
    try {
      data = typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json;
    } catch {
      continue;
    }
    for (const field of declaredFields) {
      const text = normalizeSemanticEmbeddingInput(data?.[field]);
      if (!text) {
        continue;
      }
      const scopeKey = encodeScopeKey(stream, field);
      if (existingKeys?.has(encodeVectorPairKey(scopeKey, `${connectorInstanceId}\u0000${row.record_key}`))) {
        continue;
      }
      embeddingChain = embeddingChain.then(async () => {
        entries.push({
          connectorId,
          connectorInstanceId,
          recordKey: row.record_key,
          scopeKey,
          vector: await embedDocumentWithAdmission(text),
        });
      });
    }
  }
  await embeddingChain;
  return entries;
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
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  declaredFields: readonly string[];
  recordsToScan?: number | null;
  progressJob?: SemanticBackfillJob | null;
  existingKeys?: Set<string> | null;
  signal?: AbortSignal | null;
}): Promise<number> {
  const usePostgres = isPostgresStorageBackend();
  const index = usePostgres ? null : ensureVectorIndex();
  if (!((usePostgres || index) && backend)) {
    return 0;
  }
  const vectorIndex = index as SemanticIndex;

  const PAGE = 500;
  async function rebuildPage(lastId: number, indexed: number, scanned: number): Promise<number> {
    let currentProgressJob = progressJob;
    // Cancellation hook (see lexical counterpart in search.js): the CLI
    // shutdown handler aborts the signal before closing the DB so the
    // embed/upsert loop releases the WAL writer cleanly.
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("semantic backfill aborted");
    }
    const rows: readonly SemanticDbRow[] = usePostgres
      ? ((await postgresSemanticRecordsPage({
          connectorInstanceId,
          lastId,
          limit: PAGE,
          stream,
        })) as unknown as readonly SemanticDbRow[])
      : getMany(referenceQueries.searchSemanticRecordsPageNonDeleted, [connectorInstanceId, stream, lastId], {
          limit: PAGE,
        }).rows;
    if (rows.length === 0) {
      return indexed;
    }
    const lastRow = rows.at(-1);
    const nextLastId = lastRow ? Number(lastRow.id) : lastId;
    const nextScanned = scanned + rows.length;
    const entries = await buildSemanticIndexEntries(
      rows,
      declaredFields,
      connectorId,
      connectorInstanceId,
      stream,
      existingKeys
    );
    const nextIndexed = indexed + entries.length;
    if (usePostgres) {
      await postgresSemanticIndexInsertMany({ connectorId, connectorInstanceId, entries });
    } else if (entries.length > 0) {
      await vectorIndex.upsertMany(entries);
    }
    if (currentProgressJob) {
      currentProgressJob = updateBackfillJob(currentProgressJob, {
        indexedVectors: nextIndexed,
        recordsScanned: nextScanned,
        recordsTotal: recordsToScan,
      });
    }
    await yieldImmediate();
    if (rows.length < PAGE) {
      return nextIndexed;
    }
    return rebuildPage(nextLastId, nextIndexed, nextScanned);
  }
  return await rebuildPage(0, 0, 0);
}

function upsertBackfillProgress({
  connectorId,
  connectorInstanceId,
  stream,
  fieldsFingerprint,
  modelId,
  dimensions,
  distanceMetric,
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  fieldsFingerprint: string;
  modelId: string;
  dimensions: number;
  distanceMetric: SemanticDistanceMetric;
}): void {
  exec(referenceQueries.searchSemanticProgressUpsert, [
    connectorInstanceId,
    connectorId,
    stream,
    fieldsFingerprint,
    modelId,
    dimensions,
    distanceMetric,
    new Date().toISOString(),
  ]);
}

function deleteBackfillProgress({
  connectorId,
  connectorInstanceId = null,
  stream,
}: {
  connectorId: string;
  connectorInstanceId?: string | null;
  stream: string;
}): void {
  if (!connectorInstanceId) {
    exec(referenceQueries.searchSemanticProgressDeleteByStream, [connectorId, stream]);
    return;
  }
  execDynamicSqlAcknowledged(
    "DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = ? AND stream = ?",
    [connectorInstanceId, stream]
  );
}

// Discover the complete instance set before taking any writer fence. A stream
// can be current, removed from the manifest, or represented only by an
// interrupted backfill row; all three need the same per-instance critical
// section. The caller then holds one fence per instance, never two at once.
async function resolveSemanticBackfillConnectorInstanceIds({
  connectorId,
  manifest,
}: {
  connectorId: string;
  manifest: SemanticBackfillManifest;
}): Promise<string[]> {
  const usePostgres = isPostgresStorageBackend();
  const streams = new Set(
    manifest.streams.map((stream) => stream?.name).filter((stream) => typeof stream === "string" && stream.length > 0)
  );
  if (usePostgres) {
    for (const stream of await postgresListSemanticStreamsForConnector({ connectorId })) {
      streams.add(stream);
    }
  } else {
    for (const row of allowUnboundedReadAcknowledged(referenceQueries.searchSemanticMetaListStreamsForConnector, [
      connectorId,
    ]) as SemanticDbRow[]) {
      streams.add(row.stream);
    }
    for (const row of allowUnboundedReadAcknowledged(referenceQueries.searchSemanticProgressListStreamsForConnector, [
      connectorId,
    ]) as SemanticDbRow[]) {
      streams.add(row.stream);
    }
  }

  const connectorInstanceIds = new Set<string>();
  await runSequential(streams, async (stream) => {
    const ids = usePostgres
      ? await postgresListSemanticConnectorInstanceIds({ connectorId, stream })
      : listSemanticConnectorInstanceIds({ connectorId, stream });
    for (const connectorInstanceId of ids) {
      connectorInstanceIds.add(connectorInstanceId);
    }
  });
  return [...connectorInstanceIds].sort();
}

interface SemanticBackfillIdentity {
  dimensions: number;
  distanceMetric: SemanticDistanceMetric;
  fieldsFingerprint: string;
  modelId: string;
}

interface SemanticBackfillContext {
  connectorId: string;
  currentIdentity: SemanticBackfillIdentity;
  currentMetric: SemanticDistanceMetric;
  currentModel: string;
  index: SemanticIndex | null;
  log: (message: string) => void;
  signal: AbortSignal | null;
  usePostgres: boolean;
  vectorIndex: SemanticIndex;
}

async function semanticBackfillIndexIsInSync({
  connectorId,
  connectorInstanceId,
  declaredFields,
  stream,
  usePostgres,
  vectorIndex,
}: {
  connectorId: string;
  connectorInstanceId: string;
  declaredFields: readonly string[];
  stream: string;
  usePostgres: boolean;
  vectorIndex: SemanticIndex;
}): Promise<boolean> {
  const recordCount = usePostgres
    ? await postgresCountSemanticRecords({ connectorInstanceId, stream })
    : Number(getOne(referenceQueries.searchSemanticRecordsCountNonDeleted, [connectorInstanceId, stream])?.n || 0);
  const indexCounts = await Promise.all(
    declaredFields.map((field) =>
      usePostgres
        ? postgresCountSemanticIndexByScope({
            connectorId,
            connectorInstanceId,
            scopeKey: encodeScopeKey(stream, field),
          })
        : vectorIndex.countByConnectorScope(connectorId, encodeScopeKey(stream, field), connectorInstanceId)
    )
  );
  const indexCount = indexCounts.reduce((total, count) => total + count, 0);
  const maxIndexRows = recordCount * declaredFields.length;
  let expectedIndexRows: number | null = null;
  if (indexCount === 0 || indexCount > maxIndexRows) {
    expectedIndexRows = usePostgres
      ? await postgresCountIndexableSemanticValues({ connectorInstanceId, declaredFields, stream })
      : countIndexableSemanticValues({ connectorInstanceId, declaredFields, stream });
  }
  return indexCount > 0 ? indexCount <= maxIndexRows : expectedIndexRows === 0;
}

function logSemanticBackfillDecision({
  backendChanged,
  canResume,
  connectorId,
  currentIdentity,
  currentMetric,
  currentModel,
  fingerprintChanged,
  log,
  metaRow,
  newFingerprint,
  stream,
}: {
  backendChanged: boolean;
  canResume: boolean;
  connectorId: string;
  currentIdentity: SemanticBackfillIdentity;
  currentMetric: SemanticDistanceMetric;
  currentModel: string;
  fingerprintChanged: boolean;
  log: (message: string) => void;
  metaRow: SemanticDbRow | null;
  newFingerprint: string;
  stream: string;
}): void {
  if (canResume) {
    log(
      `[PDPP] Semantic index resume for ${connectorId} stream='${stream}' ` +
        `(fields=${newFingerprint}, model=${currentModel}, dims=${currentIdentity.dimensions}, metric=${currentMetric})`
    );
  } else if (fingerprintChanged) {
    log(
      `[PDPP] Semantic index field-set change for ${connectorId} stream='${stream}' ` +
        `(was=${displaySemanticMetaValue(metaRow?.fields_fingerprint)}, now=${newFingerprint}) — rebuilding`
    );
  } else if (backendChanged) {
    log(
      `[PDPP] Semantic index backend identity changed for ${connectorId} stream='${stream}' ` +
        `(model=${displaySemanticMetaValue(metaRow?.model_id)}→${currentModel}, ` +
        `dims=${displaySemanticMetaValue(metaRow?.dimensions)}→${currentIdentity.dimensions}, ` +
        `metric=${displaySemanticMetaValue(metaRow?.distance_metric)}→${currentMetric}) — rebuilding`
    );
  }
}

function displaySemanticMetaValue(value: unknown): string {
  return value === null || value === undefined ? "null" : String(value);
}

async function inspectSemanticBackfillInstance({
  context,
  connectorInstanceId,
  declaredFields,
  newFingerprint,
  stream,
}: {
  context: SemanticBackfillContext;
  connectorInstanceId: string;
  declaredFields: readonly string[];
  newFingerprint: string;
  stream: string;
}): Promise<{ canResume: boolean; needsRebuild: boolean }> {
  const { connectorId, currentIdentity, currentMetric, currentModel, log, usePostgres, vectorIndex } = context;
  const metaRow = usePostgres
    ? await postgresGetSemanticMeta({ connectorInstanceId, stream })
    : getOne(referenceQueries.searchSemanticMetaGetByStream, [connectorInstanceId, stream]);
  const progressRow = usePostgres
    ? await postgresGetSemanticProgress({ connectorInstanceId, stream })
    : getOne(referenceQueries.searchSemanticProgressGetByStream, [connectorInstanceId, stream]);
  const progressMatches = semanticIdentityMatches(progressRow as SemanticDbRow | null, currentIdentity);
  const fingerprintChanged = !metaRow || metaRow.fields_fingerprint !== newFingerprint;
  const backendChanged =
    !metaRow ||
    metaRow.model_id !== currentModel ||
    Number(metaRow.dimensions) !== currentIdentity.dimensions ||
    metaRow.distance_metric !== currentMetric;
  let needsRebuild = fingerprintChanged || backendChanged || progressMatches;
  let canResume = progressMatches;

  if (needsRebuild) {
    logSemanticBackfillDecision({
      backendChanged,
      canResume,
      connectorId,
      currentIdentity,
      currentMetric,
      currentModel,
      fingerprintChanged,
      log,
      metaRow: metaRow as SemanticDbRow | null,
      newFingerprint,
      stream,
    });
  } else {
    const inSync = await semanticBackfillIndexIsInSync({
      connectorId,
      connectorInstanceId,
      declaredFields,
      stream,
      usePostgres,
      vectorIndex,
    });
    needsRebuild = !inSync;
    if (needsRebuild) {
      canResume = false;
      log(`[PDPP] Semantic index drift for ${connectorId} stream='${stream}' — rebuilding`);
    } else if (progressRow) {
      if (usePostgres) {
        await postgresDeleteSemanticProgress({ connectorInstanceId, stream });
      } else {
        deleteBackfillProgress({ connectorId, connectorInstanceId, stream });
      }
    }
  }
  return { canResume, needsRebuild };
}

async function prepareSemanticBackfillKeys({
  context,
  canResume,
  connectorInstanceId,
  stream,
}: {
  context: SemanticBackfillContext;
  canResume: boolean;
  connectorInstanceId: string;
  stream: string;
}): Promise<Set<string> | null> {
  const { connectorId, index, usePostgres, vectorIndex } = context;
  if (usePostgres && canResume) {
    return postgresListExistingSemanticKeys({ connectorId, connectorInstanceId, stream });
  }
  if (canResume && index && typeof index.listExistingKeys === "function") {
    return index.listExistingKeys({ connectorId, connectorInstanceId, stream });
  }
  if (usePostgres) {
    await postgresSemanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  } else {
    await vectorIndex.deleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  }
  return null;
}

async function rebuildSemanticBackfillInstance({
  context,
  connectorInstanceId,
  declaredFields,
  newFingerprint,
  progressJob,
  canResume,
  stream,
}: {
  context: SemanticBackfillContext;
  connectorInstanceId: string;
  declaredFields: readonly string[];
  newFingerprint: string;
  progressJob: SemanticBackfillJob;
  canResume: boolean;
  stream: string;
}): Promise<SemanticBackfillJob> {
  const { connectorId, currentIdentity, currentMetric, currentModel, log, signal, usePostgres } = context;
  if (usePostgres) {
    await postgresUpsertSemanticProgress({ connectorId, connectorInstanceId, ...currentIdentity, stream });
  } else {
    upsertBackfillProgress({ connectorId, connectorInstanceId, stream, ...currentIdentity });
  }
  const existingKeys = await prepareSemanticBackfillKeys({ canResume, connectorInstanceId, context, stream });
  const recordsToScan = usePostgres
    ? await postgresCountSemanticRecords({ connectorInstanceId, stream })
    : Number(getOne(referenceQueries.searchSemanticRecordsCountNonDeleted, [connectorInstanceId, stream])?.n || 0);
  const rebuildingJob = updateBackfillJob(progressJob, {
    indexedVectors: 0,
    phase: "rebuilding",
    recordsScanned: 0,
    recordsTotal: recordsToScan,
    stream,
  });
  log(
    `[PDPP] Semantic index rebuild starting for ${connectorId} stream='${stream}' ` +
      `(records=${recordsToScan}, fields=${declaredFields.length}, mode=${canResume ? "resume" : "fresh"})`
  );
  const indexed = await rebuildSemanticIndexForStream({
    connectorId,
    connectorInstanceId,
    declaredFields,
    existingKeys,
    progressJob: rebuildingJob,
    recordsToScan,
    signal,
    stream,
  });
  log(
    `[PDPP] Semantic index rebuild completed for ${connectorId} stream='${stream}' ` +
      `(records=${recordsToScan}, indexed=${indexed})`
  );
  if (usePostgres) {
    await postgresUpsertSemanticMeta({
      connectorId,
      connectorInstanceId,
      dimensions: currentIdentity.dimensions,
      distanceMetric: currentMetric,
      fieldsFingerprint: newFingerprint,
      modelId: currentModel,
      stream,
    });
    await postgresDeleteSemanticProgress({ connectorInstanceId, stream });
  } else {
    exec(referenceQueries.searchSemanticMetaUpsert, [
      connectorInstanceId,
      connectorId,
      stream,
      newFingerprint,
      currentModel,
      currentIdentity.dimensions,
      currentMetric,
      new Date().toISOString(),
    ]);
    deleteBackfillProgress({ connectorId, connectorInstanceId, stream });
  }
  return rebuildingJob;
}

async function deleteSemanticNonParticipatingStream({
  context,
  connectorInstanceIds,
  stream,
}: {
  context: SemanticBackfillContext;
  connectorInstanceIds: string[];
  stream: string;
}): Promise<void> {
  const { connectorId, usePostgres, vectorIndex } = context;
  await runSequential(connectorInstanceIds, async (connectorInstanceId) => {
    if (usePostgres) {
      await postgresSemanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
      await postgresDeleteSemanticMeta({ connectorInstanceId, stream });
      await postgresDeleteSemanticProgress({ connectorInstanceId, stream });
    } else {
      await vectorIndex.deleteByConnectorStream({ connectorId, connectorInstanceId, stream });
      execDynamicSqlAcknowledged("DELETE FROM semantic_search_meta WHERE connector_instance_id = ? AND stream = ?", [
        connectorInstanceId,
        stream,
      ]);
      deleteBackfillProgress({ connectorId, connectorInstanceId, stream });
    }
  });
}

async function backfillSemanticManifestStream({
  context,
  fencedConnectorInstanceId,
  mStream,
  progressJob,
}: {
  context: SemanticBackfillContext;
  fencedConnectorInstanceId: string;
  mStream: SemanticManifestStream;
  progressJob: SemanticBackfillJob;
}): Promise<SemanticBackfillJob> {
  const { connectorId, log, usePostgres } = context;
  const stream = mStream.name;
  const declaredFields = mStream.query?.search?.semantic_fields;
  if (!Array.isArray(declaredFields) || declaredFields.length === 0) {
    const ids = usePostgres
      ? await postgresListSemanticConnectorInstanceIds({ connectorId, stream })
      : listSemanticConnectorInstanceIds({ connectorId, stream });
    if (ids.length > 0) {
      log(
        `[PDPP] Semantic index: stream='${stream}' connector='${connectorId}' ` +
          "no longer declares semantic_fields — dropping stale index + meta/progress"
      );
      await deleteSemanticNonParticipatingStream({
        connectorInstanceIds: ids.filter((id) => id === fencedConnectorInstanceId),
        context,
        stream,
      });
    }
    return progressJob;
  }
  let currentProgressJob = updateBackfillJob(progressJob, {
    indexedVectors: 0,
    manifestStreamsChecked: Math.min(progressJob.manifestStreamsChecked + 1, progressJob.manifestStreamsTotal),
    phase: "checking",
    recordsScanned: 0,
    recordsTotal: null,
    stream,
  });
  const newFingerprint = fingerprintSemanticFields(declaredFields);
  const connectorInstanceIds = usePostgres
    ? await postgresListSemanticConnectorInstanceIds({ connectorId, stream })
    : listSemanticConnectorInstanceIds({ connectorId, stream });
  await runSequential(
    connectorInstanceIds.filter((id) => id === fencedConnectorInstanceId),
    async (connectorInstanceId) => {
      const { canResume, needsRebuild } = await inspectSemanticBackfillInstance({
        connectorInstanceId,
        context,
        declaredFields,
        newFingerprint,
        stream,
      });
      if (needsRebuild) {
        currentProgressJob = await rebuildSemanticBackfillInstance({
          canResume,
          connectorInstanceId,
          context,
          declaredFields,
          newFingerprint,
          progressJob: currentProgressJob,
          stream,
        });
      }
    }
  );
  return currentProgressJob;
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
  log = () => {
    // Deliberately silent when no backfill logger is supplied.
  },
  signal = null,
}: SemanticBackfillOptions = {}): Promise<void> {
  if (!(manifest?.connector_id && Array.isArray(manifest?.streams))) {
    return;
  }
  if (!backend) {
    return;
  }
  const connectorId = manifest.connector_id;
  const connectorInstanceIds = await resolveSemanticBackfillConnectorInstanceIds({ connectorId, manifest });
  await runSequential(connectorInstanceIds, async (connectorInstanceId) => {
    await withConnectorInstanceWrite(connectorInstanceId, () =>
      backfillSemanticIndexForConnectorInstance({
        fencedConnectorInstanceId: connectorInstanceId,
        log,
        manifest,
        signal,
      })
    );
  });
}

// The public entry point obtains one coordinator scope per id. This helper is
// deliberately private so no external caller can select an instance and skip
// that fence; all current/removed/orphan stream effects below run within it.
async function backfillSemanticIndexForConnectorInstance({
  manifest,
  log,
  signal,
  fencedConnectorInstanceId,
}: {
  manifest: SemanticBackfillManifest;
  log: (message: string) => void;
  signal: AbortSignal | null;
  fencedConnectorInstanceId: string;
}): Promise<void> {
  const connectorId = manifest.connector_id;
  activeBackfillCount += 1;
  const participatingStreams = manifest.streams.filter((mStream: SemanticManifestStream) => {
    const declaredFields = mStream.query?.search?.semantic_fields;
    return Array.isArray(declaredFields) && declaredFields.length > 0;
  }).length;
  let progressJob: SemanticBackfillJob = {
    connectorId: manifest.connector_id,
    id: `semantic_backfill_${nextBackfillJobId}`,
    indexedVectors: 0,
    manifestStreamsChecked: 0,
    manifestStreamsTotal: participatingStreams,
    phase: "planning",
    recordsScanned: 0,
    recordsTotal: 0,
    startedAt: new Date().toISOString(),
    stream: null,
    updatedAt: new Date().toISOString(),
  };
  nextBackfillJobId += 1;
  backfillJobs.set(progressJob.id, progressJob);
  try {
    const usePostgres = isPostgresStorageBackend();
    const index = usePostgres ? null : ensureVectorIndex();
    if (!(usePostgres || index)) {
      return;
    }
    const vectorIndex = index as SemanticIndex;

    const activeBackend = requireSemanticBackend();
    const currentModel = backendStorageIdentity(activeBackend);
    const currentDims = activeBackend.dimensions();
    const currentMetric = activeBackend.distanceMetric();

    const visitedStreams = new Set<string>();

    await runSequential(manifest.streams, async (mStream) => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("semantic backfill aborted");
      }
      const stream = mStream?.name;
      if (typeof stream !== "string" || stream.length === 0) {
        return;
      }
      visitedStreams.add(stream);
      progressJob = await backfillSemanticManifestStream({
        context: {
          connectorId,
          currentIdentity: {
            dimensions: currentDims,
            distanceMetric: currentMetric,
            fieldsFingerprint: fingerprintSemanticFields(mStream.query?.search?.semantic_fields ?? []),
            modelId: currentModel,
          },
          currentMetric,
          currentModel,
          index,
          log,
          signal,
          usePostgres,
          vectorIndex,
        },
        fencedConnectorInstanceId,
        mStream,
        progressJob,
      });
    });
    progressJob = updateBackfillJob(progressJob, {
      indexedVectors: 0,
      phase: "cleanup",
      recordsScanned: 0,
      recordsTotal: null,
      stream: null,
    });

    // Orphan rows: streams that previously had complete meta or in-progress
    // progress but are gone from the manifest entirely.
    // REVIEWED-BOUNDED: meta+progress rows are keyed by (connector_id, stream)
    // and the stream count per connector is bounded by the manifest, well
    // below the @max_rows=1024 declared on each artifact.
    const orphanStreams = new Set<string>();
    if (usePostgres) {
      for (const stream of await postgresListSemanticStreamsForConnector({ connectorId })) {
        orphanStreams.add(stream);
      }
    } else {
      for (const row of allowUnboundedReadAcknowledged(referenceQueries.searchSemanticMetaListStreamsForConnector, [
        connectorId,
      ]) as SemanticDbRow[]) {
        orphanStreams.add(row.stream);
      }
      // REVIEWED-BOUNDED: progress rows are keyed by (connector_id, stream); the
      // stream count per connector is bounded by the manifest, well below the
      // @max_rows=1024 declared on the artifact.
      for (const row of allowUnboundedReadAcknowledged(referenceQueries.searchSemanticProgressListStreamsForConnector, [
        connectorId,
      ]) as SemanticDbRow[]) {
        orphanStreams.add(row.stream);
      }
    }
    await runSequential(orphanStreams, async (orphanStream) => {
      if (visitedStreams.has(orphanStream)) {
        return;
      }
      log(
        `[PDPP] Semantic index: stream='${orphanStream}' connector='${connectorId}' ` +
          "no longer in manifest — dropping stale index + meta/progress"
      );
      const connectorInstanceIds = usePostgres
        ? await postgresListSemanticConnectorInstanceIds({ connectorId, stream: orphanStream })
        : listSemanticConnectorInstanceIds({ connectorId, stream: orphanStream });
      await runSequential(
        connectorInstanceIds.filter((id) => id === fencedConnectorInstanceId),
        async (connectorInstanceId) => {
          if (usePostgres) {
            await postgresSemanticIndexDeleteByConnectorStream({
              connectorId,
              connectorInstanceId,
              stream: orphanStream,
            });
            await postgresDeleteSemanticMeta({ connectorInstanceId, stream: orphanStream });
            await postgresDeleteSemanticProgress({ connectorInstanceId, stream: orphanStream });
          } else {
            await vectorIndex.deleteByConnectorStream({
              connectorId,
              connectorInstanceId,
              stream: orphanStream,
            });
            execDynamicSqlAcknowledged(
              "DELETE FROM semantic_search_meta WHERE connector_instance_id = ? AND stream = ?",
              [connectorInstanceId, orphanStream]
            );
            deleteBackfillProgress({ connectorId, connectorInstanceId, stream: orphanStream });
          }
        }
      );
    });
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
export async function computeIndexState(
  deps: {
    isPostgresStorageBackend?: () => boolean;
    postgresAnySemanticProgressRow?: () => Promise<unknown>;
    postgresListAllSemanticMetaIdentities?: () => Promise<SemanticDbRow[]>;
  } = {}
): Promise<"built" | "building" | "stale"> {
  if (!backend) {
    return "stale";
  }
  if (isSemanticIndexBackfillActive()) {
    return "building";
  }
  const usePostgres = deps.isPostgresStorageBackend ? deps.isPostgresStorageBackend() : isPostgresStorageBackend();
  const readProgressExistsAny = usePostgres
    ? deps.postgresAnySemanticProgressRow || postgresAnySemanticProgressRow
    : // REVIEWED-BOUNDED: small_enumeration_table — single-row existence probe.
      () => getOne(referenceQueries.searchSemanticProgressExistsAny, []);
  const readMetaIdentities = usePostgres
    ? deps.postgresListAllSemanticMetaIdentities || postgresListAllSemanticMetaIdentities
    : // REVIEWED-BOUNDED: semantic_search_meta is keyed by (connector_id,
      // stream); total row count is bounded by the live manifest's stream
      // count summed across connectors and stays well under
      // @max_rows=1024 in practice.
      () => allowUnboundedReadAcknowledged(referenceQueries.searchSemanticMetaListAllIdentities, []);

  const progressRow = await readProgressExistsAny();
  if (progressRow) {
    return "stale";
  }
  const rows = (await readMetaIdentities()) as SemanticDbRow[];
  // No meta rows means nothing has been backfilled yet. If any participating
  // manifest exists, backfill hasn't run → stale. If no manifests declare
  // semantic_fields at all, there's nothing to index and "built" is honest.
  // We can't cheaply tell these apart here, but the boot path always calls
  // semanticIndexBackfillForManifest before advertising, so "built" is the
  // right steady-state answer when meta is empty.
  if (rows.length === 0) {
    return "built";
  }
  const currentStorageIdentity = backendStorageIdentity(backend);
  const currentDims = backend.dimensions();
  const currentMetric = backend.distanceMetric();
  for (const row of rows) {
    if (
      row.model_id !== currentStorageIdentity ||
      Number(row.dimensions) !== currentDims ||
      row.distance_metric !== currentMetric
    ) {
      return "stale";
    }
  }
  return "built";
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
export function parseSemanticSearchParams(
  query: Record<string, unknown>
): ReturnType<typeof parseSearchSemanticParams> {
  try {
    return parseSearchSemanticParams(query);
  } catch (err) {
    if (err instanceof SearchSemanticRequestError) {
      const translated = new Error(err.message) as Error & { code?: string; param?: string };
      translated.code = err.code;
      if (err.param !== undefined) {
        translated.param = err.param;
      }
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
function compileSingleStreamSearchFilter({
  manifest,
  grant,
  streamName,
  filter,
}: {
  manifest: SemanticSearchManifest;
  grant: SemanticGrant;
  streamName: string | null;
  filter: unknown;
}): SemanticPlanFilter | null {
  if (!streamName) {
    return null;
  }
  const manifestStream = (manifest.streams || []).find((s) => s.name === streamName);
  if (!manifestStream) {
    return null;
  }
  const streamGrant = (grant.streams || []).find((s) => s.name === streamName);
  if (!streamGrant) {
    return null;
  }
  return {
    filters: compileRequestFilters(
      filter,
      streamGrant as Parameters<typeof compileRequestFilters>[1],
      manifestStream as Parameters<typeof compileRequestFilters>[2]
    ),
    streamName,
  };
}

function hasGrantRecordConstraints(streamGrant: SemanticStreamGrant | null | undefined): boolean {
  return !!(streamGrant?.time_range || (Array.isArray(streamGrant?.resources) && streamGrant.resources.length > 0));
}

function needsCandidateRecordScan(
  streamGrant: SemanticStreamGrant | null | undefined,
  compiledFilters: readonly CompiledFilter[] | null | undefined
): boolean {
  return !!(compiledFilters?.length || hasGrantRecordConstraints(streamGrant));
}

function allowedCandidateRecordKeysFromRows(
  rows: Iterable<SemanticDbRow>,
  {
    streamGrant,
    manifestStream,
    compiledFilters,
  }: { streamGrant: SemanticStreamGrant; manifestStream: SemanticManifestStream; compiledFilters: CompiledFilter[] }
): string[] {
  const allowed: string[] = [];
  for (const row of rows) {
    let data: SemanticRecordData | null;
    try {
      data = row.record_json ? JSON.parse(row.record_json) : null;
    } catch {
      continue;
    }
    if (
      !passesGrantRecordConstraints(
        data,
        row.record_key,
        streamGrant as Parameters<typeof passesGrantRecordConstraints>[2],
        manifestStream as Parameters<typeof passesGrantRecordConstraints>[3]
      )
    ) {
      continue;
    }
    if (!passesRequestFilters(data, compiledFilters)) {
      continue;
    }
    allowed.push(row.record_key);
  }
  return allowed;
}

async function buildPostgresCandidateRecordKeys({
  connectorId,
  connectorInstanceId,
  streamName,
  streamGrant,
  manifestStream,
  compiledFilters,
}: {
  connectorId: string;
  connectorInstanceId?: string | null;
  streamName: string;
  streamGrant: SemanticStreamGrant;
  manifestStream: SemanticManifestStream;
  compiledFilters: CompiledFilter[];
}): Promise<string[] | null> {
  if (!needsCandidateRecordScan(streamGrant, compiledFilters)) {
    return null;
  }

  const where = connectorInstanceId
    ? ["connector_instance_id = $1", "stream = $2", "deleted = FALSE"]
    : ["connector_id = $1", "stream = $2", "deleted = FALSE"];
  const binds = [connectorInstanceId || connectorId, streamName];
  if (Array.isArray(streamGrant?.resources) && streamGrant.resources.length > 0) {
    const placeholders = streamGrant.resources.map((_, index) => `$${binds.length + index + 1}`);
    where.push(`record_key IN (${placeholders.join(", ")})`);
    binds.push(...streamGrant.resources);
  }

  // REVIEWED-DYNAMIC: candidate-key scan includes a variable resources IN
  // clause and optional JS-side grant/filter predicates, so the SQL shape is
  // grant-dependent and cannot be a static registry artifact.
  const { rows } = await postgresQuery(
    `SELECT record_key, record_json::text AS record_json
     FROM records
     WHERE ${where.join(" AND ")}`,
    binds
  );

  return allowedCandidateRecordKeysFromRows(rows as SemanticDbRow[], { compiledFilters, manifestStream, streamGrant });
}

function buildCandidateRecordKeys({
  connectorId,
  connectorInstanceId,
  streamName,
  streamGrant,
  manifestStream,
  compiledFilters,
}: {
  connectorId: string;
  connectorInstanceId?: string | null;
  streamName: string;
  streamGrant: SemanticStreamGrant;
  manifestStream: SemanticManifestStream;
  compiledFilters: CompiledFilter[];
}): string[] | null {
  const needsRecordScan = compiledFilters.length || hasGrantRecordConstraints(streamGrant);
  if (!needsRecordScan) {
    return null;
  }

  const where = connectorInstanceId
    ? ["connector_instance_id = ?", "stream = ?", "deleted = 0"]
    : ["connector_id = ?", "stream = ?", "deleted = 0"];
  const binds = [connectorInstanceId || connectorId, streamName];
  if (Array.isArray(streamGrant?.resources) && streamGrant.resources.length > 0) {
    where.push(`record_key IN (${streamGrant.resources.map(() => "?").join(", ")})`);
    binds.push(...streamGrant.resources);
  }

  // REVIEWED-DYNAMIC: candidate-key scan includes a variable resources IN
  // clause and optional JS-side grant/filter predicates, so the SQL shape is
  // grant-dependent and cannot be a static registry artifact.
  const rows = iterateDynamicSqlAcknowledged<SemanticDbRow>(
    `
    SELECT record_key, record_json
    FROM records
    WHERE ${where.join(" AND ")}
  `,
    binds
  );

  return allowedCandidateRecordKeysFromRows(rows, { compiledFilters, manifestStream, streamGrant });
}

function buildSemanticPlanEntryForGrant({
  connectorId,
  connectorInstanceId,
  compiledFilter,
  manifestStream: mStream,
  streamGrant,
}: {
  connectorId: string | null;
  connectorInstanceId: string | null;
  compiledFilter: SemanticPlanFilter | null;
  manifestStream: SemanticManifestStream;
  streamGrant: SemanticStreamGrant;
}): SemanticPlanEntry | null {
  const declared = mStream.query?.search?.semantic_fields;
  if (!Array.isArray(declared) || declared.length === 0) {
    return null;
  }
  if (
    typeof streamGrant.connection_id === "string" &&
    streamGrant.connection_id.length > 0 &&
    connectorInstanceId &&
    streamGrant.connection_id !== connectorInstanceId
  ) {
    return null;
  }
  const grantedFields =
    Array.isArray(streamGrant.fields) && streamGrant.fields.length > 0 ? new Set(streamGrant.fields) : null;
  const searchable = grantedFields ? declared.filter((f) => grantedFields.has(f)) : declared.slice();
  if (searchable.length === 0) {
    return null;
  }
  const filters = compiledFilter?.streamName === mStream.name ? compiledFilter.filters : [];
  const shouldScanCandidates = needsCandidateRecordScan(streamGrant, filters);
  const candidateRecordKeys =
    connectorId && shouldScanCandidates && !isPostgresStorageBackend()
      ? buildCandidateRecordKeys({
          compiledFilters: filters,
          connectorId,
          connectorInstanceId,
          manifestStream: mStream,
          streamGrant,
          streamName: mStream.name,
        })
      : null;
  const postgresCandidateFilter =
    connectorId && shouldScanCandidates && isPostgresStorageBackend()
      ? { compiledFilters: filters, manifestStream: mStream, streamGrant }
      : null;

  return {
    scopeKeys: searchable.map((f) => encodeScopeKey(mStream.name, f)),
    searchableFields: searchable,
    streamName: mStream.name,
    ...(connectorInstanceId ? { connectorInstanceId } : {}),
    ...(candidateRecordKeys ? { candidateRecordKeys } : {}),
    ...(postgresCandidateFilter ? { postgresCandidateFilter } : {}),
  };
}

export function buildSemanticSearchPlanForGrant({
  manifest,
  grant,
  streamsFilter,
  compiledFilter = null,
  connectorId = null,
  connectorInstanceId = null,
}: {
  manifest: SemanticSearchManifest;
  grant: SemanticGrant;
  streamsFilter: string[] | null;
  compiledFilter?: SemanticPlanFilter | null;
  connectorId?: string | null;
  connectorInstanceId?: string | null;
}): SemanticPlanEntry[] {
  assertGrantedManifestReadAuthority(manifest, grant, null);
  assertOwnerSearchFilterAuthority(manifest, streamsFilter);
  if (!grant.streams) {
    return [];
  }
  const plan: SemanticPlanEntry[] = [];
  for (const mStream of manifest.streams) {
    if (streamsFilter && !streamsFilter.includes(mStream.name)) {
      continue;
    }
    const streamGrant = grant.streams.find((s) => s.name === mStream.name);
    if (!streamGrant) {
      continue;
    }
    const entry = buildSemanticPlanEntryForGrant({
      compiledFilter,
      connectorId,
      connectorInstanceId,
      manifestStream: mStream,
      streamGrant,
    });
    if (entry) {
      plan.push(entry);
    }
  }
  return plan;
}

function resolveSemanticRetrievalAdvertisement(opts: SemanticRunOptions): Record<string, unknown> | null {
  if (opts.semanticRetrievalCapability) {
    return opts.semanticRetrievalCapability;
  }
  if (opts.semanticRetrievalSupported === false) {
    return null;
  }
  if (!backend) {
    return null;
  }
  const profileId = typeof backend.profileId === "function" ? backend.profileId() : null;
  const dtype = typeof backend.dtype === "function" ? backend.dtype() : null;
  const model = backend.model();
  const dimensions = backend.dimensions();
  const distanceMetric = backend.distanceMetric();
  return {
    cross_stream: true,
    default_limit: 25,
    max_limit: 100,
    score: {
      comparable_with: {
        backend_identity: [
          profileId ? `profile=${profileId}` : null,
          `model=${model}`,
          dtype ? `dtype=${dtype}` : null,
          `dimensions=${dimensions}`,
          `metric=${distanceMetric}`,
        ]
          .filter(Boolean)
          .join(";"),
        dimensions,
        distance_metric: distanceMetric,
        model,
        ...(profileId ? { profile_id: profileId } : {}),
        ...(dtype ? { dtype } : {}),
      },
      kind: "semantic_distance",
      order: "lower_is_better",
      supported: true,
      value_semantics: "distance",
    },
    supported: true,
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
}: SemanticRunArgs): Promise<{ disclosureData: unknown; envelope: Record<string, unknown> }> {
  if (!backend?.available()) {
    // Route registration should prevent reaching this helper when no backend
    // is configured, but defend in depth.
    const err = new Error("semantic retrieval is not configured") as Error & { code?: string };
    err.code = "not_found";
    throw err;
  }

  const isOwner = tokenInfo.pdpp_token_kind === "owner";
  const advertisement = resolveSemanticRetrievalAdvertisement(opts);
  const actor: SearchSemanticActor = isOwner
    ? { kind: "owner", subject_id: tokenInfo.subject_id ?? null }
    : {
        client_id: tokenInfo.client_id ?? null,
        grant: tokenInfo.grant ?? { streams: [] },
        grant_id: tokenInfo.grant_id ?? null,
        kind: "client",
        subject_id: tokenInfo.subject_id ?? null,
      };

  let ownerSubjectId: string | null = null;
  if (isOwner) {
    ownerSubjectId = typeof getOwnerSubjectId === "function" ? getOwnerSubjectId() : OWNER_AUTH_DEFAULT_SUBJECT_ID;
  }

  // Native dependencies wire the operation against the existing embedding
  // pipeline, vector index, snapshot tables, and records-table snippet
  // hydration. The operation owns the public-contract slice; these helpers
  // keep their backend-specific semantics untouched.
  const dependencies: SearchSemanticDependencies = {
    buildOwnerReadGrantForManifest: (manifest) => buildOwnerReadGrantForManifest(manifest),
    buildSearchPlanForGrant: ({ manifest, grant, streamsFilter, filter, filteredStream, connectorId }) => {
      const typedManifest = manifest as SemanticSearchManifest;
      const typedGrant = grant as SemanticGrant;
      const connectorInstanceId: string | null =
        (typedManifest.storage_binding as { connector_instance_id?: string } | undefined)?.connector_instance_id ||
        (typedManifest.connector_id as string | undefined) ||
        null;
      const compiledFilter = compileSingleStreamSearchFilter({
        filter,
        grant: typedGrant,
        manifest: typedManifest,
        streamName: filteredStream,
      });
      return buildSemanticSearchPlanForGrant({
        compiledFilter,
        connectorId,
        connectorInstanceId,
        grant: typedGrant,
        manifest: typedManifest,
        streamsFilter,
      });
    },
    buildSnapshot: (args) =>
      buildSemanticSnapshot({
        ...args,
        perConnectorPlans: args.perConnectorPlans as SemanticConnectorPlan[],
      }),
    formatRecordUrl: ({ stream, recordKey, connectorId, isOwner: ownerActor }) => {
      const recordPath = `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordKey)}`;
      return ownerActor ? `${recordPath}?connector_id=${encodeURIComponent(connectorId)}` : recordPath;
    },
    getAdvertisement: () => advertisement,
    getCurrentBackendIdentity: () => hashBackendIdentity(backend),
    hydrateResult: ({ hit }) =>
      hydrateSemanticSearchResult({ hit: hit as SearchSemanticSnapshotResult & { topField: string } }),
    listOwnerVisibleBindings: async () => {
      const connectorIds = await resolveOwnerVisibleConnectorIds();
      return await listActiveOwnerBindingsForConnectors({
        connectorIds,
        ownerSubjectId,
      });
    },
    listOwnerVisibleConnectorIds: () => resolveOwnerVisibleConnectorIds(),
    loadSnapshot: (snapshotId) => loadSemanticSnapshot(snapshotId),
    persistSnapshot: (snapshot) => persistSemanticSnapshot(snapshot),
    resolveClientBindings: async (clientActor, { connectionId }) => {
      const grantResolved = await resolveGrantManifest(tokenInfo);
      const baseManifest = grantResolved.manifest as SemanticSearchManifest;
      const connectorId = (baseManifest.storage_binding?.connector_id || baseManifest.connector_id) as string;
      const ownerSubjectIdForGrant =
        (tokenInfo.grant?.subject?.id as string | undefined) || tokenInfo.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID;
      const grantStreams = clientActor?.grant?.streams || [];
      let grantStreamConnectionId: string | null = null;
      const pinned = grantStreams
        .map((s) => s?.connection_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      if (pinned.length === grantStreams.length && pinned.length > 0) {
        const unique = new Set(pinned);
        if (unique.size === 1) {
          grantStreamConnectionId = pinned[0] ?? null;
        }
      }
      const resolveSemanticFanInBindings = resolveFanInBindings as unknown as (args: {
        connectorId: string;
        connectorInstanceIdHint: string | null;
        grantStreamConnectionId: string | null;
        ownerSubjectId: string;
        requestConnectionId: string | null;
      }) => Promise<Awaited<ReturnType<typeof resolveFanInBindings>>>;
      const { bindings } = await resolveSemanticFanInBindings({
        connectorId,
        connectorInstanceIdHint: grantResolved.storageBinding?.connector_instance_id || null,
        grantStreamConnectionId: grantStreamConnectionId || null,
        ownerSubjectId: ownerSubjectIdForGrant,
        requestConnectionId: connectionId,
      });
      return bindings.map((b) => ({
        connectorInstanceId: b.connectorInstanceId,
        manifest: {
          ...baseManifest,
          storage_binding: {
            ...(baseManifest.storage_binding || {}),
            connector_id: b.connectorId || connectorId,
            connector_instance_id: b.connectorInstanceId,
          },
        },
        ...(b.displayName ? { displayName: b.displayName } : {}),
      }));
    },
    resolveClientManifest: async () => {
      const grantResolved = await resolveGrantManifest(tokenInfo);
      return grantResolved.manifest;
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
        const manifest = resolved.manifest as unknown as SemanticSearchManifest | null;
        if (manifest) {
          return {
            ...manifest,
            storage_binding: {
              ...(manifest.storage_binding || {}),
              connector_instance_id: resolved.storageBinding?.connector_instance_id ?? binding.connectorInstanceId,
            },
          };
        }
        return null;
      } catch {
        return null;
      }
    },
    resolveOwnerManifestForConnector: async (connectorId) => {
      try {
        const ownerScope = resolveOwnerScopeForConnector(connectorId);
        const resolved = await resolveOwnerManifestFromScope(ownerScope);
        return resolved.manifest;
      } catch {
        // Skip connectors whose manifest cannot be resolved. The owner can
        // still read the others; one broken connector should not break the
        // whole search.
        return null;
      }
    },
  };

  let result: Awaited<ReturnType<typeof executeSearchSemantic>>;
  try {
    result = await executeSearchSemantic({ actor, query: req.query }, dependencies);
  } catch (err) {
    if (err instanceof SearchSemanticRequestError) {
      // Translate operation-typed errors into the plain-object error shape
      // the existing native error path expects (`err.code`, optional
      // `err.param`). Preserves the previous public error envelope.
      const translated = new Error(err.message) as Error & { code?: string; param?: string };
      translated.code = err.code;
      if (err.param !== undefined) {
        translated.param = err.param;
      }
      throw translated;
    }
    throw err;
  }

  return {
    disclosureData: result.disclosureData,
    envelope: {
      has_more: result.envelope.has_more,
      object: "list",
      url: "/v1/search/semantic",
      ...(result.envelope.next_cursor ? { next_cursor: result.envelope.next_cursor } : {}),
      data: result.envelope.data,
      // Carry the operation's canonical `meta.warnings[]` (limit_clamped,
      // deprecated_alias_used, source_skipped_not_applicable) through to the
      // REST response. Omitted when the operation produced no warnings.
      ...(result.envelope.meta ? { meta: result.envelope.meta } : {}),
    },
  };
}

// ─── Snapshot building ─────────────────────────────────────────────────────

async function queryPostgresSemanticPlanEntries({
  connectorId,
  planEntries,
  perConnectorLimit,
  queryVector,
}: {
  connectorId: string;
  planEntries: SemanticPlanEntry[];
  perConnectorLimit: number;
  queryVector: SemanticVector;
}): Promise<SemanticIndexHit[]> {
  const requests = buildPostgresSemanticPlanRequests(planEntries);
  const hits = await Promise.all(
    requests.map(async (request) => {
      const recordKeys =
        request.candidateRecordKeys ??
        (request.postgresCandidateFilter
          ? await buildPostgresCandidateRecordKeys({
              connectorId,
              connectorInstanceId: request.connectorInstanceId,
              streamName: request.streamName as string,
              ...request.postgresCandidateFilter,
            })
          : null);
      return postgresSemanticSearch({
        connectorId,
        connectorInstanceId: request.connectorInstanceId as string,
        limit: perConnectorLimit,
        queryVector: Array.from(queryVector),
        recordKeys,
        scopeKeys: request.scopeKeys,
        stream: request.streamName ?? "",
      });
    })
  );
  return hits.flat();
}

async function queryVectorSemanticPlanEntries({
  connectorId,
  index,
  planEntries,
  perConnectorLimit,
  queryVector,
}: {
  connectorId: string;
  index: SemanticIndex;
  planEntries: SemanticPlanEntry[];
  perConnectorLimit: number;
  queryVector: SemanticVector;
}): Promise<SemanticIndexHit[]> {
  const hits = await Promise.all(
    planEntries
      .filter((entry) => entry.scopeKeys.length > 0)
      .map((entry) =>
        index.queryPerConnector({
          connectorId,
          connectorInstanceId: entry.connectorInstanceId ?? null,
          limit: perConnectorLimit,
          queryVector,
          recordKeys: entry.candidateRecordKeys ?? null,
          scopeKeys: entry.scopeKeys,
        })
      )
  );
  return hits.flat();
}

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
async function buildSemanticSnapshot({
  q,
  perConnectorPlans,
  isOwner,
  pageLimit = 25,
}: {
  q: string;
  perConnectorPlans: SemanticConnectorPlan[];
  isOwner: boolean;
  pageLimit?: number;
}): Promise<SearchSemanticSnapshot> {
  const queryVector = await embedSemanticQueryWithCache(q);
  const index = isPostgresStorageBackend() ? null : ensureVectorIndex();

  // Fetch enough per connector to survive field-level duplicate collapse
  // without forcing every first page to pay for the public maximum.
  const perConnectorLimit = resolveSemanticPerConnectorLimit(pageLimit);

  const perConnectorHits = await mapSearchFanout(
    perConnectorPlans,
    async ({ connectorId, planEntries }) => {
      const entryHits = isPostgresStorageBackend()
        ? await queryPostgresSemanticPlanEntries({
            connectorId: connectorId as string,
            perConnectorLimit,
            planEntries,
            queryVector,
          })
        : await queryVectorSemanticPlanEntries({
            connectorId: connectorId as string,
            index: index as SemanticIndex,
            perConnectorLimit,
            planEntries,
            queryVector,
          });
      return entryHits.sort(compareHits).slice(0, perConnectorLimit);
    },
    { isPostgres: isPostgresStorageBackend() }
  );

  // Merge under total order.
  const merged = perConnectorHits.flat().sort(compareHits);

  // Collapse per-record hits: a record can match multiple fields (multiple
  // scope_keys), so one (connector, stream, record_key) maps to multiple
  // raw hits. Preserve the best (smallest) distance and union the matched
  // fields. The collapsed list is re-sorted under the same total order so
  // ties resolve deterministically.
  const collapsed = new Map<string, CollapsedSemanticHit>();
  for (const hit of merged) {
    const [stream, field] = JSON.parse(hit.scopeKey);
    // Use an explicit escaped separator so the source file stays plain text
    // while the composite key remains unambiguous.
    const collapseKey = `${hit.connectorInstanceId ?? ""}\u0000${hit.connectorId}\u0000${stream}\u0000${hit.recordKey}`;
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
        distance: hit.distance,
        matchedFields: [field],
        recordKey: hit.recordKey,
        // scope_key of the current best field — used for the total-order
        // comparison at collapse time.
        scopeKey: hit.scopeKey,
        stream,
        topField: field,
      });
    }
  }
  const collapsedArr = Array.from(collapsed.values()).sort(compareHits);

  // Decorate each hit with the owner-facing display_name when the store has
  // a non-placeholder label for the binding. Lookups are deduped per
  // connection_id; placeholder labels are omitted, not faked.
  const displayNames = await resolveDisplayNamesForBindings(
    collapsedArr.map((hit) => ({
      connectorId: hit.connectorId,
      connectorInstanceId: hit.connectorInstanceId,
    }))
  );
  for (const hit of collapsedArr) {
    const displayName = displayNames.get(hit.connectorInstanceId);
    if (displayName) {
      hit.displayName = displayName;
    }
  }

  return {
    backend_hash: hashBackendIdentity(backend),
    plan_hash: hashSemanticPlan({ isOwner, perConnectorPlans }),
    query: q,
    results: collapsedArr as unknown as SearchSemanticSnapshotResult[],
    snapshot_id: generateSnapshotId(),
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
interface SemanticRecordRow extends SemanticDbRow {
  authored_at?: string | null;
  emitted_at?: string | null;
}

interface SemanticSearchStore {
  getRecordRow: (args: {
    connectorId: string;
    connectorInstanceId: string | null;
    stream: string;
    recordKey: string;
  }) => Promise<SemanticRecordRow | null> | SemanticRecordRow | null;
  loadSnapshotRow: (snapshotId: string) => Promise<SemanticDbRow | null> | SemanticDbRow | null;
  persistSnapshot: (args: {
    snapshotId: string;
    query: string;
    planHash: string;
    resultsJson: string;
  }) => Promise<void> | void;
}

const postgresSemanticSearchStore: SemanticSearchStore = {
  getRecordRow: ({ connectorId, connectorInstanceId, stream, recordKey }) =>
    postgresGetSemanticRecord({
      connectorId,
      connectorInstanceId: connectorInstanceId as string,
      recordKey,
      stream,
    }) as unknown as Promise<SemanticRecordRow | null>,
  async loadSnapshotRow(snapshotId) {
    const { rows } = await postgresQuery(
      `
      SELECT snapshot_id, query, plan_hash, results_json::text AS results_json, created_at
      FROM semantic_search_snapshots
      WHERE snapshot_id = $1
      `,
      [snapshotId]
    );
    return (rows[0] as SemanticDbRow | undefined) ?? null;
  },
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
      [snapshotId, query, planHash, resultsJson]
    );
  },
};

const sqliteSemanticSearchStore: SemanticSearchStore = {
  getRecordRow: ({ connectorInstanceId, stream, recordKey }) =>
    getOne(referenceQueries.searchSemanticRecordsGetRecordByKey, [connectorInstanceId, stream, recordKey]),
  loadSnapshotRow: (snapshotId) => getOne(referenceQueries.searchSemanticSnapshotsGetById, [snapshotId]),
  persistSnapshot: ({ snapshotId, query, planHash, resultsJson }) => {
    exec(referenceQueries.searchSemanticSnapshotsInsert, [snapshotId, query, planHash, resultsJson]);
  },
};

function getSemanticSearchStore(): SemanticSearchStore {
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
async function hydrateSemanticSearchResult({
  hit,
}: {
  hit: SearchSemanticSnapshotResult & { topField: string };
}): Promise<{ authoredAt: string | null; emittedAt: string | null; snippet: { field: string; text: string } | null }> {
  const recordRow = await getSemanticSearchStore().getRecordRow({
    connectorId: hit.connectorId,
    connectorInstanceId: hit.connectorInstanceId ?? null,
    recordKey: hit.recordKey,
    stream: hit.stream,
  });

  const emittedAt = recordRow?.emitted_at ?? null;
  let authoredAt: string | null = null;
  let snippet: { field: string; text: string } | null = null;
  if (recordRow?.record_json) {
    try {
      const data =
        typeof recordRow.record_json === "string" ? JSON.parse(recordRow.record_json) : recordRow.record_json;
      authoredAt = authoredTimestampFromRecordData(data);
      const value = data?.[hit.topField];
      if (typeof value === "string" && value.length > 0) {
        snippet = { field: hit.topField, text: pickVerbatimExcerpt(value) };
      }
    } catch {
      // Corrupt record_json — skip snippet rather than fabricate.
    }
  }
  return { authoredAt, emittedAt, snippet };
}

function authoredTimestampFromRecordData(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as SemanticRecordData;
  for (const key of [
    "sent_at",
    "sentAt",
    "authored_at",
    "authoredAt",
    "created_at",
    "createdAt",
    "source_created_at",
    "sourceCreatedAt",
    "occurred_at",
    "occurredAt",
    "updated_at",
    "updatedAt",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
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
function pickVerbatimExcerpt(text: string): string {
  const MAX = 160;
  if (text.length <= MAX) {
    return text;
  }
  const head = text.slice(0, MAX);
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 40) {
    return `${head.slice(0, lastSpace)}…`;
  }
  return `${head}…`;
}

// ─── Snapshot persistence + cursor encoding ────────────────────────────────

const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateSnapshotId(): string {
  return `snap_${randomBytes(8).toString("hex")}`;
}

function hashSemanticPlan({
  perConnectorPlans,
  isOwner,
}: {
  perConnectorPlans: SemanticConnectorPlan[];
  isOwner: boolean;
}): string {
  // Include `connector_instance_id` per plan entry and sort
  // deterministically so the snapshot's binding set is part of the cursor
  // identity. A request that adds or removes a binding mid-pagination
  // yields a different hash, invalidating cursor reuse.
  const summary = perConnectorPlans
    .map((p) => ({
      c: p.connectorId,
      e: p.planEntries
        .map((pe) => ({
          f: pe.searchableFields.slice().sort(),
          i: pe.connectorInstanceId || null,
          s: pe.streamName,
        }))
        .sort((a, b) => {
          const ia = a.i || "";
          const ib = b.i || "";
          if (ia !== ib) {
            return ia < ib ? -1 : 1;
          }
          if (a.s < b.s) {
            return -1;
          }
          return a.s > b.s ? 1 : 0;
        }),
    }))
    .sort((a, b) => {
      const left = a.c || "";
      const right = b.c || "";
      if (left < right) {
        return -1;
      }
      return left > right ? 1 : 0;
    });
  return JSON.stringify({ isOwner, summary });
}

function hashBackendIdentity(b: SemanticEmbeddingBackend | null): string {
  if (!b) {
    return "semantic-disabled";
  }
  return JSON.stringify({
    identity: backendStorageIdentity(b),
  });
}

export function resolveSemanticPerConnectorLimit(pageLimit: number): number {
  const normalized = Math.max(1, Math.min(Number(pageLimit) || 25, 100));
  return Math.min(100, Math.max(25, Math.ceil(normalized * 1.5), normalized + 10));
}

interface SemanticPostgresPlanRequest {
  candidateRecordKeys: string[] | null | undefined;
  connectorInstanceId: string | null;
  postgresCandidateFilter: SemanticPlanEntry["postgresCandidateFilter"] | null | undefined;
  scopeKeys: string[];
  streamName: string | null;
}

export function buildPostgresSemanticPlanRequests(
  planEntries: SemanticPlanEntry[] = []
): SemanticPostgresPlanRequest[] {
  const simpleByConnection = new Map<string, { connectorInstanceId: string | null; scopeKeys: Set<string> }>();
  const requests: SemanticPostgresPlanRequest[] = [];

  for (const entry of planEntries) {
    if (!(entry && Array.isArray(entry.scopeKeys)) || entry.scopeKeys.length === 0) {
      continue;
    }
    const hasCandidateRecordKeys = Array.isArray(entry.candidateRecordKeys);
    const hasCandidateFilter = !!entry.postgresCandidateFilter;
    if (hasCandidateRecordKeys || hasCandidateFilter) {
      requests.push({
        candidateRecordKeys: entry.candidateRecordKeys,
        connectorInstanceId: entry.connectorInstanceId ?? null,
        postgresCandidateFilter: entry.postgresCandidateFilter,
        scopeKeys: [...new Set(entry.scopeKeys)],
        streamName: entry.streamName,
      });
      continue;
    }

    const key = entry.connectorInstanceId ?? "";
    let merged = simpleByConnection.get(key);
    if (!merged) {
      merged = {
        connectorInstanceId: entry.connectorInstanceId ?? null,
        scopeKeys: new Set(),
      };
      simpleByConnection.set(key, merged);
    }
    for (const scopeKey of entry.scopeKeys) {
      merged.scopeKeys.add(scopeKey);
    }
  }

  for (const merged of simpleByConnection.values()) {
    requests.unshift({
      candidateRecordKeys: null,
      connectorInstanceId: merged.connectorInstanceId,
      postgresCandidateFilter: null,
      scopeKeys: [...merged.scopeKeys].sort(),
      streamName: null,
    });
  }

  return requests;
}

async function persistSemanticSnapshot(snapshot: SearchSemanticSnapshot): Promise<void> {
  // Store backend_hash alongside plan_hash so stale-cursor detection is
  // deterministic across restarts: the snapshot row is the source of truth
  // about what backend produced the cached distances.
  const planHash = JSON.stringify({ backend: snapshot.backend_hash, plan: snapshot.plan_hash });
  const resultsJson = JSON.stringify(snapshot.results);

  await getSemanticSearchStore().persistSnapshot({
    planHash,
    query: snapshot.query,
    resultsJson,
    snapshotId: snapshot.snapshot_id,
  });
}

async function loadSemanticSnapshot(snapshotId: string): Promise<SearchSemanticSnapshot | null> {
  const row = await getSemanticSearchStore().loadSnapshotRow(snapshotId);
  return materializeSemanticSnapshot(row);
}

function materializeSemanticSnapshot(row: SemanticDbRow | null): SearchSemanticSnapshot | null {
  if (!row) {
    return null;
  }
  const createdAt = new Date(`${String(row.created_at)}Z`).getTime();
  if (Number.isFinite(createdAt) && Date.now() - createdAt > SNAPSHOT_TTL_MS) {
    return null;
  }
  let planEnvelope: { backend?: string; plan?: string };
  try {
    planEnvelope = JSON.parse(String(row.plan_hash));
  } catch {
    return null;
  }
  return {
    backend_hash: planEnvelope.backend ?? "",
    plan_hash: planEnvelope.plan ?? "",
    query: String(row.query),
    results: JSON.parse(String(row.results_json)) as SearchSemanticSnapshotResult[],
    snapshot_id: String(row.snapshot_id),
  };
}
