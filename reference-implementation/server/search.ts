// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lexical Retrieval Extension — implementation helper.
 *
 * Realizes the public `lexical-retrieval` capability defined in:
 *   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
 *
 * This module is the SINGLE enforcement path for `GET /v1/search`. The route
 * handler in index.js delegates to `runLexicalSearch` and does no parameter
 * parsing, mode branching, planning, FTS5 access, or snippet hydration of its
 * own. The dashboard (apps/console) reaches lexical retrieval through the same
 * public route over HTTP, so there is no second contract.
 *
 * Maintenance hooks (lexicalIndexUpsert, lexicalIndexDelete,
 * lexicalIndexDeleteByConnectorStream) are called from records.js at every
 * record write/update/delete site. JS-side rather than SQLite triggers
 * because index population needs to consult the connector manifest at write
 * time to know which fields are searchable — triggers cannot see manifests.
 */

import { randomBytes } from "node:crypto";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import {
  allowUnboundedReadAcknowledged,
  getMany as dbGetMany,
  getOne as dbGetOne,
  iterateDynamicSqlAcknowledged as dbIterateDynamicSqlAcknowledged,
  exec,
  referenceQueries,
  transaction,
} from "../lib/db.ts";
import type {
  SearchLexicalActor,
  SearchLexicalAdvertisement,
  SearchLexicalConnectorPlan,
  SearchLexicalDependencies,
  SearchLexicalGrant,
  SearchLexicalManifest,
  SearchLexicalPlanEntry,
  SearchLexicalSnapshot,
  SearchLexicalSnapshotResult,
} from "../operations/rs-search-lexical/index.ts";
import {
  executeSearchLexical,
  parseSearchLexicalParams,
  SearchLexicalRequestError,
} from "../operations/rs-search-lexical/index.ts";
import {
  listActiveOwnerBindingsForConnectors,
  resolveDisplayNamesForBindings,
  resolveFanInBindings,
} from "./connection-identity.ts";
import { withConnectorInstanceWrite } from "./connector-instance-write-coordinator.ts";
import { assertGrantedManifestReadAuthority, assertOwnerSearchFilterAuthority } from "./manifest-read-authority.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "./owner-auth.ts";
import {
  postgresLexicalCandidateLimit,
  postgresLexicalCountIndexableTextValues,
  postgresLexicalIndexCountByStream,
  postgresLexicalIndexDelete,
  postgresLexicalIndexDeleteByConnectorStream,
  postgresLexicalIndexInsertMany,
  postgresLexicalIndexUpsert,
  postgresLexicalMetaGetFingerprint,
  postgresLexicalMetaListStreamsForConnector,
  postgresLexicalMetaUpsertFingerprint,
  postgresLexicalRecordsCountNonDeleted,
  postgresLexicalRecordsPageNonDeleted,
  postgresLexicalSearch,
} from "./postgres-search.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";
import { compileRequestFilters, passesGrantRecordConstraints, passesRequestFilters } from "./record-filters.ts";
import { mapSearchFanout } from "./search-fanout.ts";
import { sqliteCountIndexableTextValues } from "./search-index-counts.ts";
import { makeDefaultAccountConnectorInstanceId } from "./stores/connector-instance-store.ts";

type JsonObject = Record<string, unknown>;
type SqlBindValue = string | number | bigint | null | Uint8Array;
const FTS_TERM_SEPARATOR = /\s+/;
interface LexicalManifestStream {
  name: string;
  query?: { search?: { lexical_fields?: string[] } };
  [key: string]: unknown;
}
type LexicalManifest = SearchLexicalManifest & {
  connector_id?: string;
  connector_instance_id?: string;
  storage_binding?: { connector_id?: string; connector_instance_id?: string };
  streams: LexicalManifestStream[];
};
interface LexicalGrantStream {
  fields?: string[];
  instance_ids?: string[];
  name: string;
  resources?: string[];
  time_constraint?: { field: string; since?: string; until?: string } | null;
  [key: string]: unknown;
}
type LexicalGrant = Omit<SearchLexicalGrant, "streams"> & { streams?: LexicalGrantStream[] };
interface LexicalRecordRow {
  id: number | string;
  record_json?: string | null;
  record_key: string;
  [key: string]: unknown;
}
interface LexicalIndexRow {
  emitted_at: string;
  field: string;
  record_json?: string | null;
  record_key: string;
  score: number | string | null;
  snippet_text?: string | null;
  [key: string]: unknown;
}
interface LexicalIndexEntry {
  field: string;
  recordKey: string;
  text: string;
}
type LexicalHit = SearchLexicalSnapshotResult & { score: number };
type LexicalQueryPlanEntry = SearchLexicalPlanEntry & {
  candidateRecordKeys?: string[];
  postgresCandidateFilter?: {
    compiledFilters: ReturnType<typeof compileRequestFilters>;
    streamGrant: LexicalGrantStream;
    manifestStream: LexicalManifestStream;
  };
  connectorInstanceId?: string;
};
interface LexicalSearchResult {
  candidateWindowLimit: number;
  hits: LexicalHit[];
  rankedCandidateCount: number;
  truncated: boolean;
}
type LexicalCollapsedHit = LexicalHit;
interface LexicalPostgresQueryResult {
  rows: LexicalIndexRow[];
  truncated: boolean;
}
interface LexicalMetaRow {
  fields_fingerprint?: string | null;
  [key: string]: unknown;
}
interface LexicalSnapshotRow {
  created_at: string;
  plan_hash: string;
  query: string;
  results_json: string;
  snapshot_id: string;
  [key: string]: unknown;
}
interface LexicalSearchStore {
  indexCountByStream: (args: { connectorInstanceId: string; stream: string }) => Promise<number> | number;
  indexDelete: (args: {
    connectorId: string;
    connectorInstanceId: string;
    recordKey: string;
    stream: string;
  }) => Promise<void> | void;
  indexDeleteByStream: (args: {
    connectorId: string;
    connectorInstanceId: string;
    stream: string;
  }) => Promise<void> | void;
  loadSnapshotRow: (snapshotId: string) => Promise<LexicalSnapshotRow | null> | LexicalSnapshotRow | null;
  metaGetFingerprint: (args: {
    connectorInstanceId: string;
    stream: string;
  }) => Promise<LexicalMetaRow | null> | LexicalMetaRow | null;
  metaListStreamsForConnector: (args: {
    connectorInstanceId: string;
  }) => Promise<Array<{ stream: string }>> | Array<{ stream: string }>;
  metaUpsertFingerprint: (args: {
    connectorId: string;
    connectorInstanceId: string;
    fieldsFingerprint: string;
    stream: string;
    updatedAt: string;
  }) => Promise<void> | void;
  persistSnapshot: (args: {
    planHash: string;
    query: string;
    resultsJson: string;
    snapshotId: string;
  }) => Promise<void> | void;
  recordsCountNonDeleted: (args: { connectorInstanceId: string; stream: string }) => Promise<number> | number;
}
interface LexicalBackfillJob {
  connectorId: string;
  id: string;
  indexedRows: number;
  manifestStreamsChecked: number;
  manifestStreamsTotal: number;
  phase: string;
  recordsScanned: number;
  recordsTotal: number | null;
  startedAt: string;
  stream: string | null;
  updatedAt: string;
}
type LexicalBackfillPhaseHook = ((point: string, context: JsonObject) => void | Promise<void>) | null;
interface SearchRequest {
  query: Record<string, unknown>;
}
interface SearchTokenInfo {
  client_id?: string | null;
  grant?: LexicalGrant & {
    source?: { id?: string; kind?: string };
    subject?: { id?: string | null };
  };
  grant_id?: string | null;
  pdpp_token_kind: "owner" | "client";
  subject_id?: string | null;
}
interface SearchRunOptions {
  buildOwnerReadGrantForManifest: (manifest: LexicalManifest) => LexicalGrant;
  getOwnerSubjectId: () => string | null;
  resolveGrantManifest: (
    actor: SearchTokenInfo
  ) =>
    | Promise<{ manifest: LexicalManifest; storageBinding?: { connector_instance_id?: string | null } }>
    | { manifest: LexicalManifest; storageBinding?: { connector_instance_id?: string | null } };
  resolveOwnerManifestFromScope: (
    scope: JsonObject
  ) =>
    | Promise<{ manifest?: LexicalManifest | null; storageBinding?: { connector_instance_id?: string | null } }>
    | { manifest?: LexicalManifest | null; storageBinding?: { connector_instance_id?: string | null } };
  resolveOwnerScopeForConnector: (connectorId: string) => JsonObject;
  resolveOwnerVisibleConnectorIds: () => Promise<string[]> | string[];
}
type SearchRunArgs = SearchRunOptions & {
  opts?: JsonObject & {
    lexicalRetrievalCapability?: SearchLexicalAdvertisement | null;
    lexicalRetrievalSupported?: boolean;
  };
  req: SearchRequest;
  tokenInfo: SearchTokenInfo;
};
interface PlanFilter {
  filters: ReturnType<typeof compileRequestFilters>;
  streamName: string;
}
type CandidateRecordRow = LexicalDbRow & { record_key: string };
type LexicalConnectorPlan = SearchLexicalConnectorPlan & {
  manifest: LexicalManifest;
  grant: LexicalGrant;
  planEntries: LexicalQueryPlanEntry[];
};
interface LexicalDbRow extends Record<string, unknown> {
  connector_id?: string;
  connector_instance_id?: string;
  created_at?: string;
  emitted_at?: string;
  fields_fingerprint?: string | null;
  id?: number | string;
  n?: number | string;
  plan_hash?: string;
  query?: string;
  record_json?: string | null;
  record_key?: string;
  results_json?: string;
  rowid?: number | string;
  score?: number | string | null;
  snapshot_id?: string;
  snippet_text?: string | null;
  sql?: string;
  stream?: string;
}

function getOne<R extends Record<string, unknown> = LexicalDbRow>(
  query: Parameters<typeof dbGetOne>[0],
  params: Parameters<typeof dbGetOne>[1] = []
): R | null {
  return dbGetOne<R>(query, params);
}

function getMany<R extends Record<string, unknown> = LexicalDbRow>(
  query: Parameters<typeof dbGetMany>[0],
  params: Parameters<typeof dbGetMany>[1],
  options: Parameters<typeof dbGetMany>[2]
) {
  return dbGetMany<R>(query, params, options);
}

async function runSequential<T>(values: Iterable<T>, operation: (value: T) => Promise<void>): Promise<void> {
  let chain = Promise.resolve();
  for (const value of values) {
    chain = chain.then(() => operation(value));
  }
  await chain;
}

async function getConnectorManifest(connectorId: string): Promise<LexicalManifest | null> {
  const auth = await import(new URL("./auth.ts", import.meta.url).href);
  return (await auth.getConnectorManifest(connectorId)) as unknown as LexicalManifest | null;
}

function* iterateDynamicSqlAcknowledged<R extends Record<string, unknown> = LexicalDbRow>(
  sql: string,
  params: Parameters<typeof dbIterateDynamicSqlAcknowledged>[1] = []
): Generator<R, void, unknown> {
  yield* dbIterateDynamicSqlAcknowledged<R>(sql, params);
}
const NOOP_LEXICAL_LOG = (): void => {
  // Deliberately silent when no backfill logger is supplied.
};

let activeLexicalBackfillCount = 0;
let nextLexicalBackfillJobId = 1;
let lexicalBackfillPhaseHook: LexicalBackfillPhaseHook = null;

interface LexicalBackfillManifestStream {
  name: string;
  query?: { search?: { lexical_fields?: string[] } };
}

type LexicalBackfillManifest = LexicalManifest & { connector_id: string; streams: LexicalBackfillManifestStream[] };

interface LexicalBackfillOptions {
  log?: (message?: unknown) => void;
  manifest?: LexicalBackfillManifest;
  signal?: AbortSignal | null;
}

/** Test-only phase seam for deterministic registration/backfill ordering. */
export function __setLexicalBackfillPhaseHookForTest(hook: LexicalBackfillPhaseHook) {
  lexicalBackfillPhaseHook = typeof hook === "function" ? hook : null;
}

async function maybeLexicalBackfillPhaseForTest(point: string, context: JsonObject): Promise<void> {
  await lexicalBackfillPhaseHook?.(point, context);
}
const lexicalBackfillJobs = new Map<string, LexicalBackfillJob>();

function publicLexicalBackfillJob(job: LexicalBackfillJob) {
  return {
    active_jobs: activeLexicalBackfillCount,
    connector_id: job.connectorId,
    id: job.id,
    indexed_rows: job.indexedRows,
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

function latestLexicalBackfillJob(): LexicalBackfillJob | null {
  let latest: LexicalBackfillJob | null = null;
  for (const job of lexicalBackfillJobs.values()) {
    if (!latest || job.updatedAt > latest.updatedAt) {
      latest = job;
    }
  }
  return latest;
}

function updateLexicalBackfillJob(job: LexicalBackfillJob, patch: Partial<LexicalBackfillJob>): LexicalBackfillJob {
  const updated: LexicalBackfillJob = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  lexicalBackfillJobs.set(updated.id, updated);
  return updated;
}

export function isLexicalIndexBackfillActive() {
  return activeLexicalBackfillCount > 0;
}

export function getLexicalIndexBackfillProgress() {
  const job = latestLexicalBackfillJob();
  return job ? publicLexicalBackfillJob(job) : null;
}

function resolveLexicalConnectorInstanceId(connectorId: string, connectorInstanceId: string | null = null): string {
  if (typeof connectorInstanceId === "string" && connectorInstanceId.trim()) {
    return connectorInstanceId.trim();
  }
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

// ─── Lexical index/meta/snapshot store (one adapter selected per backend) ───
//
// Domain-local store for the structurally-identical index, meta, and snapshot
// drift seams: each method is the SAME conceptual op differing only by SQL
// dialect. Dialect SQL/queries move VERBATIM; adapters return RAW rows (or
// perform the write) and any row-shaping stays caller-side. The backend is
// selected ONCE per op via isPostgresStorageBackend(), mirroring the existing
// VectorIndex / BlobStore precedent. The multi-statement rebuild loop, the
// PG-only upsert field-map decomposition, and the SQLite dynamic JSON-path
// count scan are NOT part of this store; they keep their honest per-call
// branch because they differ in more than dialect.
const postgresSearchIndexStore: LexicalSearchStore = {
  indexCountByStream: ({ connectorInstanceId, stream }: { connectorInstanceId: string; stream: string }) =>
    postgresLexicalIndexCountByStream({ connectorInstanceId, stream }),
  indexDelete: ({
    connectorId,
    connectorInstanceId,
    stream,
    recordKey,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    stream: string;
    recordKey: string;
  }) => postgresLexicalIndexDelete({ connectorId, connectorInstanceId, recordKey, stream }),
  indexDeleteByStream: ({
    connectorId,
    connectorInstanceId,
    stream,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    stream: string;
  }) => postgresLexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream }),
  async loadSnapshotRow(snapshotId: string): Promise<LexicalSnapshotRow | null> {
    const { rows } = await postgresQuery(
      `
      SELECT snapshot_id, query, plan_hash, results_json::text AS results_json, created_at
      FROM lexical_search_snapshots
      WHERE snapshot_id = $1
      `,
      [snapshotId]
    );
    return (rows[0] as LexicalSnapshotRow | undefined) ?? null;
  },
  metaGetFingerprint: ({ connectorInstanceId, stream }: { connectorInstanceId: string; stream: string }) =>
    postgresLexicalMetaGetFingerprint({ connectorInstanceId, stream }),
  metaListStreamsForConnector: ({ connectorInstanceId }: { connectorInstanceId: string }) =>
    postgresLexicalMetaListStreamsForConnector({ connectorInstanceId }) as Promise<Array<{ stream: string }>>,
  metaUpsertFingerprint: ({
    connectorId,
    connectorInstanceId,
    stream,
    fieldsFingerprint,
    updatedAt,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    stream: string;
    fieldsFingerprint: string;
    updatedAt: string;
  }) =>
    postgresLexicalMetaUpsertFingerprint({ connectorId, connectorInstanceId, fieldsFingerprint, stream, updatedAt }),
  async persistSnapshot({
    snapshotId,
    query,
    planHash,
    resultsJson,
  }: {
    snapshotId: string;
    query: string;
    planHash: string;
    resultsJson: string;
  }): Promise<void> {
    await postgresQuery(
      `
      INSERT INTO lexical_search_snapshots(snapshot_id, query, plan_hash, results_json)
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
  recordsCountNonDeleted: ({ connectorInstanceId, stream }: { connectorInstanceId: string; stream: string }) =>
    postgresLexicalRecordsCountNonDeleted({ connectorInstanceId, stream }),
};

const sqliteSearchIndexStore: LexicalSearchStore = {
  indexCountByStream: ({ connectorInstanceId, stream }: { connectorInstanceId: string; stream: string }) => {
    const row = getOne(referenceQueries.searchIndexCountByStream, [connectorInstanceId, stream]);
    return Number(row?.n || 0);
  },
  indexDelete: ({
    connectorInstanceId,
    stream,
    recordKey,
  }: {
    connectorInstanceId: string;
    stream: string;
    recordKey: string;
  }) => {
    exec(referenceQueries.searchIndexDeleteByRecordKey, [connectorInstanceId, stream, recordKey]);
  },
  indexDeleteByStream: ({ connectorInstanceId, stream }: { connectorInstanceId: string; stream: string }) => {
    exec(referenceQueries.searchIndexDeleteByStream, [connectorInstanceId, stream]);
    exec(referenceQueries.searchMetaDeleteByStream, [connectorInstanceId, stream]);
  },
  loadSnapshotRow: (snapshotId: string) =>
    getOne<LexicalSnapshotRow>(referenceQueries.searchSnapshotsGetById, [snapshotId]),
  metaGetFingerprint: ({ connectorInstanceId, stream }: { connectorInstanceId: string; stream: string }) =>
    getOne<LexicalMetaRow>(referenceQueries.searchMetaGetFingerprintByStream, [connectorInstanceId, stream]),
  metaListStreamsForConnector: ({ connectorInstanceId }: { connectorInstanceId: string }) =>
    allowUnboundedReadAcknowledged(referenceQueries.searchMetaListStreamsForConnector, [connectorInstanceId]) as Array<{
      stream: string;
    }>,
  metaUpsertFingerprint: ({
    connectorId,
    connectorInstanceId,
    stream,
    fieldsFingerprint,
    updatedAt,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    stream: string;
    fieldsFingerprint: string;
    updatedAt: string;
  }) => {
    exec(referenceQueries.searchMetaUpsertFingerprint, [
      connectorId,
      connectorInstanceId,
      stream,
      fieldsFingerprint,
      updatedAt,
    ]);
  },
  persistSnapshot: ({
    snapshotId,
    query,
    planHash,
    resultsJson,
  }: {
    snapshotId: string;
    query: string;
    planHash: string;
    resultsJson: string;
  }) => {
    exec(referenceQueries.searchSnapshotsInsert, [snapshotId, query, planHash, resultsJson]);
  },
  recordsCountNonDeleted: ({ connectorInstanceId, stream }: { connectorInstanceId: string; stream: string }) => {
    const row = getOne(referenceQueries.searchRecordsCountNonDeleted, [connectorInstanceId, stream]);
    return Number(row?.n || 0);
  },
};

function getSearchIndexStore(): LexicalSearchStore {
  return isPostgresStorageBackend() ? postgresSearchIndexStore : sqliteSearchIndexStore;
}

// ─── Stream-level declaration lookup ───────────────────────────────────────

/**
 * Look up the declared lexical_fields for (connector_id, stream) by reading
 * the connector manifest. Returns an array of top-level scalar string field
 * names, or null if the stream does not participate in lexical retrieval.
 *
 * Manifest validator (auth.ts) already enforces v1 shape constraints, so we
 * trust the declaration here.
 */
async function getStreamLexicalFields(connectorId: string, stream: string): Promise<string[] | null> {
  const manifest = await getConnectorManifest(connectorId);
  if (!manifest) {
    return null;
  }
  const mStream = (manifest.streams || []).find((s: LexicalManifestStream) => s.name === stream);
  const declared = mStream?.query?.search?.lexical_fields;
  if (!Array.isArray(declared) || declared.length === 0) {
    return null;
  }
  return declared;
}

// ─── Index maintenance (called from records.js) ────────────────────────────

/**
 * Upsert FTS rows for a record's declared lexical_fields. No-op for streams
 * that don't participate. Replaces all rows for this (connector_id, stream,
 * record_key) atomically.
 *
 * `data` is the parsed record payload object (i.e. JSON.parse(record_json)),
 * not the JSON string.
 */
export async function lexicalIndexUpsert({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
  data,
  declaredFields,
}: {
  connectorId: string;
  connectorInstanceId?: string | null;
  stream: string;
  recordKey: string;
  data?: JsonObject | null;
  declaredFields?: string[];
}): Promise<void> {
  const declared = declaredFields === undefined ? await getStreamLexicalFields(connectorId, stream) : declaredFields;
  if (!declared) {
    return;
  }
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);

  if (isPostgresStorageBackend()) {
    const fields = Object.fromEntries(
      declared
        .map((field): [string, unknown] => [field, data?.[field]])
        .filter(([, value]) => typeof value === "string" && value.length > 0)
    );
    await postgresLexicalIndexUpsert({
      connectorId,
      connectorInstanceId: resolvedConnectorInstanceId,
      fields,
      recordKey,
      stream,
    });
  } else {
    exec(referenceQueries.searchIndexDeleteByRecordKey, [resolvedConnectorInstanceId, stream, recordKey]);

    for (const field of declared) {
      const value = data?.[field];
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      exec(referenceQueries.searchIndexInsertRow, [
        connectorId,
        resolvedConnectorInstanceId,
        stream,
        recordKey,
        field,
        value,
      ]);
    }
  }
  await lexicalMetaUpsertFingerprint({
    connectorId,
    connectorInstanceId: resolvedConnectorInstanceId,
    fieldsFingerprint: fingerprintLexicalFields(declared),
    stream,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Delete all FTS rows for a single record. Called on hard or soft delete.
 */
export async function lexicalIndexDelete({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
}: {
  connectorId: string;
  connectorInstanceId?: string | null;
  stream: string;
  recordKey: string;
}): Promise<void> {
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);
  await getSearchIndexStore().indexDelete({
    connectorId,
    connectorInstanceId: resolvedConnectorInstanceId,
    recordKey,
    stream,
  });
}

/**
 * Delete all FTS rows for an entire (connector_id, stream). Called on
 * deleteAllRecords (the owner-authenticated reset path).
 */
export async function lexicalIndexDeleteByConnectorStream({
  connectorId,
  connectorInstanceId,
  stream,
}: {
  connectorId: string;
  connectorInstanceId?: string | null;
  stream: string;
}): Promise<void> {
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);
  await getSearchIndexStore().indexDeleteByStream({
    connectorId,
    connectorInstanceId: resolvedConnectorInstanceId,
    stream,
  });
}

// ─── Drift-detect + backfill ───────────────────────────────────────────────

/**
 * Backfill the FTS5 index for one (connector_id, stream) by re-reading every
 * non-deleted record. Used by the higher-level rebuild paths below.
 *
 * Internal helper — callers should prefer `lexicalIndexBackfillForManifest`
 * which handles the per-stream loop, the manifest lookup of declared fields,
 * and the drift check that decides whether a rebuild is needed at all.
 */
// Backend-dispatch wrappers for the three storage operations a lexical rebuild
// performs, so `rebuildLexicalIndexForStream` can express the page loop without
// interleaving `isPostgresStorageBackend()` branches. Pure I/O mechanics.
async function rebuildLexicalDeleteStreamIndex(
  usePostgres: boolean,
  {
    connectorId,
    resolvedConnectorInstanceId,
    stream,
  }: { connectorId: string; resolvedConnectorInstanceId: string; stream: string }
): Promise<void> {
  if (usePostgres) {
    await postgresLexicalIndexDeleteByConnectorStream({
      connectorId,
      connectorInstanceId: resolvedConnectorInstanceId,
      stream,
    });
  } else {
    exec(referenceQueries.searchIndexDeleteByStream, [resolvedConnectorInstanceId, stream]);
  }
}

async function rebuildLexicalFetchRecordsPage(
  usePostgres: boolean,
  {
    resolvedConnectorInstanceId,
    stream,
    lastId,
    limit,
  }: { resolvedConnectorInstanceId: string; stream: string; lastId: number; limit: number }
): Promise<readonly LexicalRecordRow[]> {
  return usePostgres
    ? ((await postgresLexicalRecordsPageNonDeleted({
        afterId: lastId,
        connectorInstanceId: resolvedConnectorInstanceId,
        limit,
        stream,
      })) as unknown as readonly LexicalRecordRow[])
    : (getMany(referenceQueries.searchRecordsPageNonDeleted, [resolvedConnectorInstanceId, stream, lastId], { limit })
        .rows as unknown as readonly LexicalRecordRow[]);
}

async function rebuildLexicalInsertEntries(
  usePostgres: boolean,
  {
    connectorId,
    resolvedConnectorInstanceId,
    stream,
    entries,
  }: { connectorId: string; resolvedConnectorInstanceId: string; stream: string; entries: readonly LexicalIndexEntry[] }
): Promise<void> {
  if (usePostgres) {
    await postgresLexicalIndexInsertMany({
      connectorId,
      connectorInstanceId: resolvedConnectorInstanceId,
      entries,
      stream,
    });
  } else {
    transaction(() => {
      for (const entry of entries) {
        exec(referenceQueries.searchIndexInsertRow, [
          connectorId,
          resolvedConnectorInstanceId,
          stream,
          entry.recordKey,
          entry.field,
          entry.text,
        ]);
      }
    });
  }
}

/**
 * Parse one records page into the lexical rows it contributes. The returned
 * counters are page deltas: corrupt JSON still advances the cursor and scan
 * count, but contributes no index rows.
 *
 * @returns {{
 *   entries: Array<{recordKey: string, field: string, text: string}>,
 *   lastId: number,
 *   scannedRecords: number,
 *   indexEntries: number,
 * }}
 */
function parseLexicalIndexRecordsPage(
  rows: readonly LexicalRecordRow[],
  declaredFields: readonly string[]
): { entries: LexicalIndexEntry[]; indexEntries: number; lastId: number; scannedRecords: number } {
  let lastId = 0;
  let scannedRecords = 0;
  const entries: LexicalIndexEntry[] = [];

  for (const row of rows) {
    lastId = Number(row.id);
    scannedRecords += 1;
    let data: JsonObject | null;
    try {
      data = row.record_json ? JSON.parse(row.record_json) : null;
    } catch {
      // Skip corrupt rows — the index just won't have them; the source
      // record stays intact for whoever needs to repair it.
      continue;
    }
    for (const field of declaredFields) {
      const value = data?.[field];
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      entries.push({ field, recordKey: row.record_key, text: value });
    }
  }

  return { entries, indexEntries: entries.length, lastId, scannedRecords };
}

async function rebuildLexicalIndexForStream({
  connectorId,
  connectorInstanceId,
  stream,
  declaredFields,
  recordsToScan = null,
  progressJob = null,
  signal = null,
}: {
  connectorId: string;
  connectorInstanceId: string | null;
  stream: string;
  declaredFields: readonly string[];
  recordsToScan?: number | null;
  progressJob?: LexicalBackfillJob | null;
  signal?: AbortSignal | null;
}): Promise<number> {
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);
  const usePostgres = isPostgresStorageBackend();
  await rebuildLexicalDeleteStreamIndex(usePostgres, { connectorId, resolvedConnectorInstanceId, stream });

  // Stream the records page-by-page so we don't pull the whole table into
  // memory on big stores.
  const PAGE = 500;
  async function rebuildPage(lastId: number, scanned: number, indexed: number): Promise<number> {
    // Cancellation hook: signaled when the CLI is shutting down so the
    // backfill releases the WAL writer before `closeDb()` runs. Checked
    // between page transactions only — interrupting mid-transaction would
    // leave SQLite to roll the whole page back, which is what we want
    // anyway, but releasing on a clean page boundary keeps progress
    // restartable.
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("lexical backfill aborted");
    }
    const rows = await rebuildLexicalFetchRecordsPage(usePostgres, {
      lastId,
      limit: PAGE,
      resolvedConnectorInstanceId,
      stream,
    });
    if (rows.length === 0) {
      return indexed;
    }
    const {
      entries,
      indexEntries,
      lastId: pageLastId,
      scannedRecords,
    } = parseLexicalIndexRecordsPage(rows, declaredFields);
    const nextLastId = pageLastId;
    const nextScanned = scanned + scannedRecords;
    let nextIndexed = indexed;
    if (entries.length > 0) {
      await rebuildLexicalInsertEntries(usePostgres, {
        connectorId,
        entries,
        resolvedConnectorInstanceId,
        stream,
      });
      nextIndexed += indexEntries;
    }
    if (progressJob) {
      progressJob = updateLexicalBackfillJob(progressJob, {
        indexedRows: nextIndexed,
        recordsScanned: nextScanned,
        recordsTotal: recordsToScan,
      });
    }
    await yieldImmediate();
    if (rows.length < PAGE) {
      return nextIndexed;
    }
    return rebuildPage(nextLastId, nextScanned, nextIndexed);
  }
  return rebuildPage(0, 0, 0);
}

/**
 * Stable fingerprint of a declared lexical_fields set. Used by the drift
 * detector to recognize manifest changes that swap field membership without
 * changing field count (e.g. ['title'] -> ['selftext']) — the row-count
 * heuristic alone cannot detect that case because stale rows satisfy the
 * count band.
 *
 * Fingerprint is JSON of the sorted, unique field-name list. v1
 * lexical_fields are always plain ASCII identifiers from the schema, so the
 * JSON encoding is stable and collision-free.
 */
function fingerprintLexicalFields(declaredFields: readonly string[]): string {
  const unique = Array.from(new Set(declaredFields));
  unique.sort();
  return JSON.stringify(unique);
}

function jsonPathForTopLevelField(field: string): string {
  return `$."${String(field).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function countIndexableTextValues({
  connectorInstanceId,
  stream,
  declaredFields,
}: {
  connectorInstanceId: string;
  stream: string;
  declaredFields: readonly string[];
}): Promise<number> {
  if (isPostgresStorageBackend()) {
    return await postgresLexicalCountIndexableTextValues({
      connectorInstanceId,
      declaredFields,
      stream,
    });
  }
  return sqliteCountIndexableTextValues({
    connectorInstanceId,
    declaredFields,
    iterateDynamicSql: (sql, params) => iterateDynamicSqlAcknowledged<JsonObject>(sql, params as SqlBindValue[]),
    jsonPathForField: jsonPathForTopLevelField,
    stream,
  });
}

async function lexicalMetaGetFingerprint({
  connectorInstanceId,
  stream,
}: {
  connectorInstanceId: string;
  stream: string;
}): Promise<LexicalMetaRow | null> {
  return await getSearchIndexStore().metaGetFingerprint({ connectorInstanceId, stream });
}

async function lexicalMetaExists({
  connectorInstanceId,
  stream,
}: {
  connectorInstanceId: string;
  stream: string;
}): Promise<boolean> {
  if (isPostgresStorageBackend()) {
    return !!(await lexicalMetaGetFingerprint({ connectorInstanceId, stream }));
  }
  return !!getOne(referenceQueries.searchMetaExistsByStream, [connectorInstanceId, stream]);
}

async function lexicalMetaUpsertFingerprint({
  connectorId,
  connectorInstanceId,
  stream,
  fieldsFingerprint,
  updatedAt,
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  fieldsFingerprint: string;
  updatedAt: string;
}): Promise<void> {
  await getSearchIndexStore().metaUpsertFingerprint({
    connectorId,
    connectorInstanceId,
    fieldsFingerprint,
    stream,
    updatedAt,
  });
}

async function lexicalIndexAndMetaDeleteByStream({
  connectorId,
  connectorInstanceId,
  stream,
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
}): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresLexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    return;
  }
  exec(referenceQueries.searchIndexDeleteByStream, [connectorInstanceId, stream]);
  exec(referenceQueries.searchMetaDeleteByStream, [connectorInstanceId, stream]);
}

async function lexicalMetaListStreamsForConnector({
  connectorInstanceId,
}: {
  connectorInstanceId: string;
}): Promise<Array<{ stream: string }>> {
  return await getSearchIndexStore().metaListStreamsForConnector({ connectorInstanceId });
}

async function lexicalIndexCountByStream({
  connectorInstanceId,
  stream,
}: {
  connectorInstanceId: string;
  stream: string;
}): Promise<number> {
  return await getSearchIndexStore().indexCountByStream({ connectorInstanceId, stream });
}

async function lexicalRecordsCountNonDeleted({
  connectorInstanceId,
  stream,
}: {
  connectorInstanceId: string;
  stream: string;
}): Promise<number> {
  return await getSearchIndexStore().recordsCountNonDeleted({ connectorInstanceId, stream });
}

async function resolveLexicalBackfillConnectorInstanceIds({
  connectorId,
  manifest,
}: {
  connectorId: string;
  manifest: LexicalManifest;
}): Promise<string[]> {
  const pinned = manifest.storage_binding?.connector_instance_id || manifest.connector_instance_id;
  if (pinned) {
    return [resolveLexicalConnectorInstanceId(connectorId, pinned)];
  }

  const bindings = await listActiveOwnerBindingsForConnectors({
    connectorIds: [connectorId],
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
  });
  const ids = Array.from(new Set(bindings.map((binding) => binding.connectorInstanceId).filter(Boolean)));
  if (ids.length > 0) {
    return ids.sort();
  }

  return [resolveLexicalConnectorInstanceId(connectorId, null)];
}

/**
 * Drift-detect + rebuild the lexical index for every participating stream of
 * a manifest. Idempotent and safe to call repeatedly.
 *
 * Why this exists: write-path maintenance (lexicalIndexUpsert et al) only
 * keeps records that arrived AFTER the manifest declared lexical_fields in
 * sync. It cannot help with records that already existed when the extension
 * was enabled, or with streams whose lexical_fields declaration changed
 * across a restart. This pass closes that gap.
 *
 * Called from:
 *   - startServer (native mode: backfills the configured native connector)
 *   - registerConnector (polyfill mode: backfills the connector being
 *     registered or updated)
 *
 * Drift detection has two independent signals:
 *
 *   1. Field-set fingerprint mismatch (authoritative). Per (connector_id,
 *      stream) we persist a sorted-JSON fingerprint of the declared
 *      lexical_fields set in lexical_search_meta after every rebuild. If
 *      the current declaration differs from the persisted one, we rebuild
 *      unconditionally. This is what catches same-cardinality field-set
 *      changes such as ['title'] -> ['selftext']: the row-count heuristic
 *      alone would skip that case because stale title rows satisfy the
 *      count band, missing all selftext-only historical hits.
 *
 *   2. Exact row-count guard (secondary). For streams whose fingerprint already
 *      matches, the current index row count must equal the number of non-empty
 *      declared text values in storage. Any mismatch means the index is stale or
 *      partial and is rebuilt.
 *
 * Streams that previously participated but no longer declare
 * lexical_fields are also handled here: their stale index rows and meta
 * fingerprint are dropped so subsequent searches don't return ghost hits.
 *
 * Logging is via the optional `log` callback so tests can stay quiet.
 */
// Process one manifest stream during a backfill pass: drop stale index/meta for
// a stream that no longer participates, or (re)build the lexical index when its
// declared-field fingerprint changed or the on-disk index has drifted. Pure
// index-maintenance mechanics — no grant/auth logic. Threads the mutable
// `progressJob` in and returns the updated job so the caller keeps accumulating
// progress. Early-returns (the former `continue`s) simply yield the job
// unchanged for that stream.
async function backfillLexicalStream({
  connectorId,
  connectorInstanceId,
  mStream,
  stream,
  progressJob,
  log,
  signal,
}: {
  connectorId: string;
  connectorInstanceId: string;
  mStream: LexicalBackfillManifestStream;
  stream: string;
  progressJob: LexicalBackfillJob;
  log: (message?: unknown) => void;
  signal: AbortSignal | null;
}): Promise<LexicalBackfillJob> {
  const declaredFields = mStream.query?.search?.lexical_fields;
  const isParticipating = Array.isArray(declaredFields) && declaredFields.length > 0;

  if (!isParticipating) {
    // Stream is in the manifest but does not participate. If a prior
    // version declared lexical_fields for it, drop the stale index +
    // meta so historical data doesn't keep matching against a field set
    // that's no longer declared.
    const metaExists = await lexicalMetaExists({ connectorInstanceId, stream });
    if (metaExists) {
      log(
        `[PDPP] Lexical index: stream='${stream}' connector='${connectorId}' ` +
          "no longer declares lexical_fields — dropping stale index + meta"
      );
      await lexicalIndexAndMetaDeleteByStream({ connectorId, connectorInstanceId, stream });
    }
    return progressJob;
  }
  progressJob = updateLexicalBackfillJob(progressJob, {
    indexedRows: 0,
    manifestStreamsChecked: Math.min(progressJob.manifestStreamsChecked + 1, progressJob.manifestStreamsTotal),
    phase: "checking",
    recordsScanned: 0,
    recordsTotal: null,
    stream,
  });

  const newFingerprint = fingerprintLexicalFields(declaredFields);

  const fingerprintRow = await lexicalMetaGetFingerprint({ connectorInstanceId, stream });
  const persistedFingerprint = fingerprintRow?.fields_fingerprint ?? null;
  const fingerprintChanged = persistedFingerprint !== newFingerprint;

  let needsRebuild = fingerprintChanged;
  let recordCount = 0;
  let indexCount = 0;
  let expectedIndexRows = 0;

  if (!needsRebuild) {
    // Fingerprint matches — use exact non-empty text counts only to
    // distinguish a complete index from an unbuilt or partially-built one.
    // A loose non-zero heuristic lets historical records remain invisible
    // after a manifest/schema change or interrupted startup backfill.
    recordCount = await lexicalRecordsCountNonDeleted({ connectorInstanceId, stream });
    indexCount = await lexicalIndexCountByStream({ connectorInstanceId, stream });
    expectedIndexRows = await countIndexableTextValues({ connectorInstanceId, declaredFields, stream });

    const maxIndexRows = recordCount * declaredFields.length;
    const inSync = indexCount === expectedIndexRows && indexCount <= maxIndexRows;
    needsRebuild = !inSync;
  }

  if (!needsRebuild) {
    return progressJob;
  }
  if (recordCount === 0) {
    recordCount = await lexicalRecordsCountNonDeleted({ connectorInstanceId, stream });
  }
  progressJob = updateLexicalBackfillJob(progressJob, {
    indexedRows: 0,
    phase: "rebuilding",
    recordsScanned: 0,
    recordsTotal: recordCount,
    stream,
  });

  if (fingerprintChanged) {
    log(
      `[PDPP] Lexical index field-set change for ${connectorId} stream='${stream}' ` +
        `(was=${persistedFingerprint ?? "null"}, now=${newFingerprint}) — rebuilding`
    );
  } else {
    log(
      `[PDPP] Lexical index drift for ${connectorId} stream='${stream}' ` +
        `(records=${recordCount}, index=${indexCount}, expected=${expectedIndexRows}) — rebuilding`
    );
  }

  const indexedRows = await rebuildLexicalIndexForStream({
    connectorId,
    connectorInstanceId,
    declaredFields,
    progressJob,
    recordsToScan: recordCount,
    signal,
    stream,
  });
  log(
    `[PDPP] Lexical index rebuild completed for ${connectorId} stream='${stream}' ` +
      `(records=${recordCount}, indexed_rows=${indexedRows})`
  );

  // Persist the new fingerprint so subsequent backfill calls can skip.
  await lexicalMetaUpsertFingerprint({
    connectorId,
    connectorInstanceId,
    fieldsFingerprint: newFingerprint,
    stream,
    updatedAt: new Date().toISOString(),
  });
  return progressJob;
}

// Backfill every manifest stream for one connector instance, then remove any
// indexed streams no longer named by that manifest. The pass owns its complete
// effectful lifecycle and returns the accumulated progress job to its caller.
async function backfillLexicalConnectorInstance(
  connectorId: string,
  connectorInstanceId: string,
  manifestStreams: LexicalBackfillManifestStream[],
  progressJob: LexicalBackfillJob,
  log: (message?: unknown) => void,
  signal: AbortSignal | null
): Promise<LexicalBackfillJob> {
  // Track which streams we visited so we can detect "previously participated,
  // no longer participates" — those need their stale index rows and meta
  // fingerprint dropped.
  const visitedStreams = new Set<string>();

  let currentProgressJob = progressJob;
  await runSequential(manifestStreams, async (mStream) => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("lexical backfill aborted");
    }
    const stream = mStream.name;
    if (typeof stream !== "string" || stream.length === 0) {
      return;
    }
    visitedStreams.add(stream);

    currentProgressJob = await backfillLexicalStream({
      connectorId,
      connectorInstanceId,
      log,
      mStream,
      progressJob: currentProgressJob,
      signal,
      stream,
    });
  });
  currentProgressJob = updateLexicalBackfillJob(currentProgressJob, {
    indexedRows: 0,
    phase: "cleanup",
    recordsScanned: 0,
    recordsTotal: null,
    stream: null,
  });

  // Streams that previously had a meta row but are no longer in the
  // manifest at all (entire stream removed). Same cleanup as the
  // "no-longer-participating" case above.
  // REVIEWED-BOUNDED: lexical_search_meta is keyed by (connector_instance_id, stream)
  // and the stream count per connector is a small enumeration bounded by the
  // manifest, well below the @max_rows=1024 declared in the artifact.
  const orphanRows = await lexicalMetaListStreamsForConnector({ connectorInstanceId });
  await runSequential(orphanRows, async (row) => {
    if (visitedStreams.has(row.stream)) {
      return;
    }
    log(
      `[PDPP] Lexical index: stream='${row.stream}' connector='${connectorId}' ` +
        "no longer in manifest — dropping stale index + meta"
    );
    await lexicalIndexAndMetaDeleteByStream({ connectorId, connectorInstanceId, stream: row.stream });
  });

  return currentProgressJob;
}

export async function lexicalIndexBackfillForManifest({
  manifest,
  log = NOOP_LEXICAL_LOG,
  signal = null,
}: LexicalBackfillOptions = {}): Promise<LexicalBackfillJob | undefined> {
  if (!(manifest?.connector_id && Array.isArray(manifest?.streams))) {
    return;
  }
  activeLexicalBackfillCount += 1;
  const participatingStreams = manifest.streams.filter((mStream) => {
    const declaredFields = (mStream as LexicalBackfillManifestStream).query?.search?.lexical_fields;
    return Array.isArray(declaredFields) && declaredFields.length > 0;
  }).length;
  let progressJob: LexicalBackfillJob = {
    connectorId: manifest.connector_id,
    id: `lexical_backfill_${nextLexicalBackfillJobId}`,
    indexedRows: 0,
    manifestStreamsChecked: 0,
    manifestStreamsTotal: participatingStreams,
    phase: "planning",
    recordsScanned: 0,
    recordsTotal: null,
    startedAt: new Date().toISOString(),
    stream: null,
    updatedAt: new Date().toISOString(),
  };
  nextLexicalBackfillJobId += 1;
  lexicalBackfillJobs.set(progressJob.id, progressJob);
  try {
    const connectorId = manifest.connector_id;
    const connectorInstanceIds = await resolveLexicalBackfillConnectorInstanceIds({ connectorId, manifest });
    progressJob = updateLexicalBackfillJob(progressJob, {
      manifestStreamsTotal: participatingStreams * connectorInstanceIds.length,
    });

    await runSequential(connectorInstanceIds, async (connectorInstanceId) => {
      await maybeLexicalBackfillPhaseForTest("before-instance-fence", {
        connectorId,
        connectorInstanceId,
      });
      progressJob = await withConnectorInstanceWrite(connectorInstanceId, () =>
        backfillLexicalConnectorInstance(connectorId, connectorInstanceId, manifest.streams, progressJob, log, signal)
      );
    });
    return progressJob;
  } finally {
    activeLexicalBackfillCount = Math.max(0, activeLexicalBackfillCount - 1);
    lexicalBackfillJobs.delete(progressJob.id);
  }
}

// ─── Public-route entry point ──────────────────────────────────────────────

function deriveLexicalSearchInvocationContext({
  isOwner,
  tokenInfo,
  getOwnerSubjectId,
}: {
  isOwner: boolean;
  tokenInfo: SearchTokenInfo;
  getOwnerSubjectId: () => string | null;
}): { actor: SearchLexicalActor; ownerSubjectId: string | null } {
  if (!isOwner) {
    return {
      actor: {
        client_id: tokenInfo.client_id ?? null,
        grant: tokenInfo.grant ?? { streams: [] },
        grant_id: tokenInfo.grant_id ?? null,
        kind: "client",
        subject_id: tokenInfo.subject_id ?? null,
      },
      ownerSubjectId: null,
    };
  }

  // Resolve the owner subject id once so cross-binding fan-in helpers can
  // enumerate every owner-visible connection without piping the value
  // through each per-connector adapter call. Hosts SHOULD provide
  // `getOwnerSubjectId` explicitly; we fall back to the default owner
  // subject for tests that do not wire it.
  const actor: SearchLexicalActor = { kind: "owner", subject_id: tokenInfo.subject_id ?? null };
  const ownerSubjectId = typeof getOwnerSubjectId === "function" ? getOwnerSubjectId() : OWNER_AUTH_DEFAULT_SUBJECT_ID;

  return { actor, ownerSubjectId };
}

// Native dependencies wire the operation against the existing FTS5 / SQLite
// snapshot helpers. The operation owns the public-contract slice (allowlist,
// advertisement gate, mode planning, cursor format, slice math, envelope,
// disclosure data); this adapter keeps the native backend semantics together.
function createLexicalSearchNativeDependencies({
  advertisement,
  ownerSubjectId,
  tokenInfo,
  resolveOwnerVisibleConnectorIds,
  resolveOwnerScopeForConnector,
  resolveOwnerManifestFromScope,
  buildOwnerReadGrantForManifest,
  resolveGrantManifest,
}: SearchRunOptions & {
  advertisement: SearchLexicalAdvertisement | null;
  ownerSubjectId: string;
  tokenInfo: SearchTokenInfo;
}): SearchLexicalDependencies {
  return {
    buildOwnerReadGrantForManifest: (manifest) => buildOwnerReadGrantForManifest(manifest as LexicalManifest),
    buildSearchPlanForGrant: ({ manifest, grant, streamsFilter, filter, filteredStream, connectorId }) => {
      const typedManifest = manifest as LexicalManifest;
      const typedGrant = grant as LexicalGrant;
      const effectiveConnectorId = connectorId || typedManifest.connector_id;
      const connectorInstanceId = effectiveConnectorId
        ? resolveLexicalConnectorInstanceId(
            effectiveConnectorId,
            typedManifest.storage_binding?.connector_instance_id || typedManifest.connector_instance_id
          )
        : null;
      const compiledFilter = compileSingleStreamSearchFilter({
        filter,
        grant: typedGrant,
        manifest: typedManifest,
        streamName: filteredStream,
      });
      const bindingScopedGrant =
        tokenInfo.pdpp_token_kind === "owner" && connectorInstanceId
          ? {
              ...typedGrant,
              streams: (typedGrant.streams ?? []).map((stream) => ({
                ...stream,
                instance_ids: [connectorInstanceId],
              })),
            }
          : typedGrant;
      return buildSearchPlanForGrant({
        compiledFilter,
        connectorId: effectiveConnectorId ?? null,
        connectorInstanceId,
        grant: bindingScopedGrant,
        manifest: typedManifest,
        streamsFilter,
      });
    },
    buildSnapshot: (args) =>
      buildSnapshot(args as { q: string; perConnectorPlans: LexicalConnectorPlan[]; isOwner: boolean }),
    formatRecordUrl: ({ stream, recordKey, connectorId, isOwner: ownerActor }) => {
      const recordPath = `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordKey)}`;
      return ownerActor ? `${recordPath}?connector_id=${encodeURIComponent(connectorId)}` : recordPath;
    },
    getAdvertisement: () => advertisement,
    listOwnerVisibleBindings: async () => {
      const connectorIds = await resolveOwnerVisibleConnectorIds();
      return await listActiveOwnerBindingsForConnectors({
        connectorIds,
        ownerSubjectId,
      });
    },
    listOwnerVisibleConnectorIds: () => resolveOwnerVisibleConnectorIds(),
    loadSnapshot: (snapshotId) => loadSnapshot(snapshotId),
    persistSnapshot: (snapshot) => persistSnapshot(snapshot),
    resolveClientBindings: async (clientActor, { connectionId }) => {
      const grantResolved = await resolveGrantManifest(tokenInfo);
      const baseManifest = grantResolved.manifest as LexicalManifest;
      const connectorId = (baseManifest.storage_binding?.connector_id || baseManifest.connector_id) as string;
      const ownerSubjectIdForGrant =
        tokenInfo.grant?.subject?.id || tokenInfo.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID;
      const grantStreams = clientActor?.grant?.streams || [];
      const authorizedInstanceIds = [...new Set(grantStreams.flatMap((stream) => stream.instance_ids || []))];
      const resolveLexicalFanInBindings = resolveFanInBindings as unknown as (args: {
        authorizedInstanceIds: string[];
        connectorId: string;
        connectorInstanceIdHint: string | null;
        ownerSubjectId: string;
        requestConnectionId: string | null;
      }) => Promise<Awaited<ReturnType<typeof resolveFanInBindings>>>;
      const { bindings } = await resolveLexicalFanInBindings({
        authorizedInstanceIds,
        connectorId,
        connectorInstanceIdHint: grantResolved.storageBinding?.connector_instance_id || null,
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
      if (grantResolved.storageBinding?.connector_instance_id) {
        return {
          ...grantResolved.manifest,
          storage_binding: {
            ...(grantResolved.manifest.storage_binding || {}),
            connector_instance_id: grantResolved.storageBinding.connector_instance_id,
          },
        };
      }
      return grantResolved.manifest;
    },
    resolveOwnerManifestForBinding: async (binding) => {
      try {
        const ownerScope = resolveOwnerScopeForConnector(binding.connectorId);
        // Pin the scope's storage binding to this specific connection so the
        // manifest resolver does not auto-pick a different one when multiple
        // bindings exist under the same connector.
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
        const manifest = resolved.manifest ?? null;
        if (manifest && resolved.storageBinding?.connector_instance_id) {
          return {
            ...manifest,
            storage_binding: {
              ...(manifest.storage_binding || {}),
              connector_instance_id: resolved.storageBinding.connector_instance_id,
            },
          };
        }
        return manifest;
      } catch {
        // Skip connectors whose manifest cannot be resolved. The owner can
        // still read the others; one broken connector should not break the
        // whole search.
        return null;
      }
    },
  };
}

/**
 * The single helper the GET /v1/search route delegates to.
 *
 * Inputs: `req` (Fastify-style), `opts` (server opts including
 * lexicalRetrievalCapability), `tokenInfo` (from requireToken).
 *
 * Returns { envelope, disclosureData } so the route can emit the
 * disclosure.served spine event with consistent shape across modes.
 *
 * Throws errors with `code` set to `invalid_request`, `grant_stream_not_allowed`,
 * etc.; the route's existing rejectQuery / handleError paths shape them into
 * PDPP error envelopes.
 *
 * Per-mode behavior:
 *   - Client token: single grant + manifest. streams[] entries not in the
 *     grant are a hard error (grant_stream_not_allowed).
 *   - Owner token: cross-connector fan-out across every owner-visible
 *     connector. streams[] is a soft filter; an unknown stream name yields
 *     zero hits, not an error. No public connector_id parameter.
 */
export async function runLexicalSearch({
  req,
  opts,
  tokenInfo,
  resolveOwnerVisibleConnectorIds,
  resolveOwnerScopeForConnector,
  resolveOwnerManifestFromScope,
  buildOwnerReadGrantForManifest,
  resolveGrantManifest,
  getOwnerSubjectId,
}: SearchRunArgs): Promise<{ disclosureData: unknown; envelope: Record<string, unknown> }> {
  const isOwner = tokenInfo.pdpp_token_kind === "owner";
  const advertisement = resolveLexicalRetrievalAdvertisement(opts);
  const { actor, ownerSubjectId } = deriveLexicalSearchInvocationContext({
    getOwnerSubjectId,
    isOwner,
    tokenInfo,
  });
  const dependencies = createLexicalSearchNativeDependencies({
    advertisement,
    buildOwnerReadGrantForManifest,
    ownerSubjectId: ownerSubjectId ?? OWNER_AUTH_DEFAULT_SUBJECT_ID,
    resolveGrantManifest,
    resolveOwnerManifestFromScope,
    resolveOwnerScopeForConnector,
    resolveOwnerVisibleConnectorIds,
    tokenInfo,
  } as SearchRunOptions & {
    advertisement: SearchLexicalAdvertisement | null;
    ownerSubjectId: string;
    tokenInfo: SearchTokenInfo;
  });

  let result: Awaited<ReturnType<typeof executeSearchLexical>>;
  try {
    result = await executeSearchLexical({ actor, query: req.query }, dependencies);
  } catch (err) {
    if (err instanceof SearchLexicalRequestError) {
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
      url: "/v1/search",
      ...(result.envelope.next_cursor ? { next_cursor: result.envelope.next_cursor } : {}),
      data: result.envelope.data,
      // Carry the operation's canonical `meta` through to the REST response.
      // `meta` always carries recall disclosure (`count`, `count_accuracy`,
      // `recall`) per openspec/changes/disclose-lexical-recall-windows, plus
      // optional structured `warnings[]` (limit_clamped, deprecated_alias_used,
      // source_skipped_not_applicable). The guard stays defensive in case a
      // future operation revision omits it.
      ...(result.envelope.meta ? { meta: result.envelope.meta } : {}),
    },
  };
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Parse and validate the v1 query-string allowlist.
 *
 * Thin delegating shim: the canonical implementation lives in
 * `operations/rs-search-lexical/index.ts`. Kept exported here so existing
 * callers (notably `lexical-retrieval.test.js`) and any third-party code
 * that imported the helper continue to compile, with the same error
 * shape (`Error` with `code` / `param`) the previous local implementation
 * produced.
 */
export function parseSearchParams(query: Record<string, unknown>): ReturnType<typeof parseSearchLexicalParams> {
  try {
    return parseSearchLexicalParams(query);
  } catch (err) {
    if (err instanceof SearchLexicalRequestError) {
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
 * Per-connector plan: `{ streamName, searchableFields[] }` with empty
 * intersections dropped.
 *
 * Field gating happens HERE — before any FTS5 query is issued. There is no
 * code path that asks the index about an unauthorized field. This is the
 * structural realization of the spec scenario "filter-later enforcement is
 * prohibited".
 *
 * `grant.streams[*].fields` semantics:
 *   - undefined / null / array(0) ⇒ "all fields authorized"
 *   - array(>=1) ⇒ explicit allowlist
 */
function compileSingleStreamSearchFilter({
  manifest,
  grant,
  streamName,
  filter,
}: {
  manifest: LexicalManifest;
  grant: LexicalGrant;
  streamName: string | null;
  filter: unknown;
}): PlanFilter | null {
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
    filters: compileRequestFilters(filter, streamGrant, manifestStream),
    streamName,
  };
}

function hasGrantRecordConstraints(streamGrant: LexicalGrantStream | null | undefined): boolean {
  return !!(
    streamGrant?.time_constraint ||
    (Array.isArray(streamGrant?.resources) && streamGrant.resources.length > 0)
  );
}

function needsCandidateRecordScan(
  streamGrant: LexicalGrantStream | null | undefined,
  compiledFilters: ReturnType<typeof compileRequestFilters> | null | undefined
): boolean {
  return !!(compiledFilters?.length || hasGrantRecordConstraints(streamGrant));
}

function allowedCandidateRecordKeysFromRows(
  rows: Iterable<CandidateRecordRow>,
  {
    streamGrant,
    manifestStream,
    compiledFilters,
  }: {
    streamGrant: LexicalGrantStream;
    manifestStream: LexicalManifestStream;
    compiledFilters: ReturnType<typeof compileRequestFilters>;
  }
): string[] {
  const allowed: string[] = [];
  for (const row of rows) {
    let data: JsonObject | null;
    try {
      data = row.record_json ? JSON.parse(row.record_json) : null;
    } catch {
      continue;
    }
    if (!passesGrantRecordConstraints(data, row.record_key, streamGrant, manifestStream)) {
      continue;
    }
    if (!passesRequestFilters(data, compiledFilters)) {
      continue;
    }
    allowed.push(row.record_key);
  }
  return allowed;
}

export function __filterLexicalCandidateRecordKeysForTest(
  rows: Iterable<{ record_json: string | null; record_key: string }>,
  streamGrant: LexicalGrantStream,
  manifestStream: LexicalManifestStream
): string[] {
  return allowedCandidateRecordKeysFromRows(rows, { compiledFilters: [], manifestStream, streamGrant });
}

async function buildPostgresCandidateRecordKeys({
  connectorInstanceId,
  streamName,
  streamGrant,
  manifestStream,
  compiledFilters,
}: {
  connectorInstanceId: string;
  streamName: string;
  streamGrant: LexicalGrantStream;
  manifestStream: LexicalManifestStream;
  compiledFilters: ReturnType<typeof compileRequestFilters>;
}): Promise<string[] | null> {
  if (!needsCandidateRecordScan(streamGrant, compiledFilters)) {
    return null;
  }

  const where = ["connector_instance_id = $1", "stream = $2", "deleted = FALSE"];
  const binds = [connectorInstanceId, streamName];
  if (Array.isArray(streamGrant.resources) && streamGrant.resources.length > 0) {
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

  return allowedCandidateRecordKeysFromRows(rows as CandidateRecordRow[], {
    compiledFilters,
    manifestStream,
    streamGrant,
  });
}

function buildCandidateRecordKeys({
  connectorInstanceId,
  streamName,
  streamGrant,
  manifestStream,
  compiledFilters,
}: {
  connectorInstanceId: string;
  streamName: string;
  streamGrant: LexicalGrantStream;
  manifestStream: LexicalManifestStream;
  compiledFilters: ReturnType<typeof compileRequestFilters>;
}): string[] | null {
  const needsRecordScan = compiledFilters?.length || hasGrantRecordConstraints(streamGrant);
  if (!needsRecordScan) {
    return null;
  }

  const where = ["connector_instance_id = ?", "stream = ?", "deleted = 0"];
  const binds = [connectorInstanceId, streamName];
  if (Array.isArray(streamGrant.resources) && streamGrant.resources.length > 0) {
    where.push(`record_key IN (${streamGrant.resources.map(() => "?").join(", ")})`);
    binds.push(...streamGrant.resources);
  }

  // REVIEWED-DYNAMIC: candidate-key scan includes a variable resources IN
  // clause and optional JS-side grant/filter predicates, so the SQL shape is
  // grant-dependent and cannot be a static registry artifact.
  const rows = iterateDynamicSqlAcknowledged<CandidateRecordRow>(
    `
    SELECT record_key, record_json
    FROM records
    WHERE ${where.join(" AND ")}
  `,
    binds
  );

  return allowedCandidateRecordKeysFromRows(rows, { compiledFilters, manifestStream, streamGrant });
}

function decideSearchPlanStreamEligibility({
  manifestStream,
  grantStreams,
  streamsFilter,
  compiledFilter,
  resolvedConnectorInstanceId,
}: {
  manifestStream: LexicalManifestStream;
  grantStreams: LexicalGrantStream[];
  streamsFilter: string[] | null;
  compiledFilter: PlanFilter | null;
  resolvedConnectorInstanceId: string | null;
}): {
  compiledFilters: ReturnType<typeof compileRequestFilters>;
  planEntry: LexicalQueryPlanEntry;
  streamGrant: LexicalGrantStream;
} | null {
  const declaredFields = manifestStream.query?.search?.lexical_fields;
  if (!Array.isArray(declaredFields) || declaredFields.length === 0) {
    return null;
  }

  const streamName = manifestStream.name;
  const isRequestedStream = !streamsFilter || streamsFilter.includes(streamName);
  if (!isRequestedStream) {
    return null;
  }

  const streamGrant = grantStreams.find((candidate) => candidate.name === streamName);
  if (!streamGrant) {
    return null;
  }

  if (resolvedConnectorInstanceId && !streamGrant.instance_ids?.includes(resolvedConnectorInstanceId)) {
    return null;
  }

  const grantedFields =
    Array.isArray(streamGrant.fields) && streamGrant.fields.length > 0 ? new Set(streamGrant.fields) : null;
  const searchableFields = grantedFields
    ? declaredFields.filter((field) => grantedFields.has(field))
    : declaredFields.slice();
  if (searchableFields.length === 0) {
    return null;
  }

  const compiledFilters = compiledFilter?.streamName === streamName ? compiledFilter.filters : [];
  return {
    compiledFilters,
    planEntry: {
      streamName,
      ...(resolvedConnectorInstanceId ? { connectorInstanceId: resolvedConnectorInstanceId } : {}),
      searchableFields,
    },
    streamGrant,
  };
}

function applySearchPlanCandidateScan({
  planEntry,
  connectorInstanceId,
  streamGrant,
  manifestStream,
  compiledFilters,
}: {
  planEntry: LexicalQueryPlanEntry;
  connectorInstanceId: string | null;
  streamGrant: LexicalGrantStream;
  manifestStream: LexicalManifestStream;
  compiledFilters: ReturnType<typeof compileRequestFilters>;
}): LexicalQueryPlanEntry {
  const shouldScanCandidates = needsCandidateRecordScan(streamGrant, compiledFilters);
  if (!(connectorInstanceId && shouldScanCandidates)) {
    return planEntry;
  }

  const candidateRecordKeys = isPostgresStorageBackend()
    ? null
    : buildCandidateRecordKeys({
        compiledFilters,
        connectorInstanceId,
        manifestStream,
        streamGrant,
        streamName: planEntry.streamName,
      });
  const postgresCandidateFilter = isPostgresStorageBackend() ? { compiledFilters, manifestStream, streamGrant } : null;

  return {
    ...planEntry,
    ...(candidateRecordKeys ? { candidateRecordKeys } : {}),
    ...(postgresCandidateFilter ? { postgresCandidateFilter } : {}),
  };
}

function buildSearchPlanEntryForGrant({
  manifestStream,
  grantStreams,
  streamsFilter,
  compiledFilter,
  resolvedConnectorInstanceId,
}: {
  manifestStream: LexicalManifestStream;
  grantStreams: LexicalGrantStream[];
  streamsFilter: string[] | null;
  compiledFilter: PlanFilter | null;
  resolvedConnectorInstanceId: string | null;
}): LexicalQueryPlanEntry | null {
  const eligibility = decideSearchPlanStreamEligibility({
    compiledFilter,
    grantStreams,
    manifestStream,
    resolvedConnectorInstanceId,
    streamsFilter,
  });
  if (!eligibility) {
    return null;
  }

  return applySearchPlanCandidateScan({
    ...eligibility,
    connectorInstanceId: resolvedConnectorInstanceId,
    manifestStream,
  });
}

export function buildSearchPlanForGrant({
  manifest,
  grant,
  streamsFilter,
  compiledFilter = null,
  connectorId = null,
  connectorInstanceId = null,
}: {
  manifest: LexicalManifest;
  grant: LexicalGrant;
  streamsFilter: string[] | null;
  compiledFilter?: PlanFilter | null;
  connectorId?: string | null;
  connectorInstanceId?: string | null;
}): LexicalQueryPlanEntry[] {
  assertGrantedManifestReadAuthority(manifest, grant, null);
  assertOwnerSearchFilterAuthority(manifest, streamsFilter);
  if (!grant.streams) {
    return [];
  }
  const resolvedConnectorInstanceId = connectorId
    ? resolveLexicalConnectorInstanceId(
        connectorId,
        connectorInstanceId || manifest.storage_binding?.connector_instance_id || manifest.connector_instance_id
      )
    : null;
  const plan: LexicalQueryPlanEntry[] = [];
  for (const manifestStream of manifest.streams) {
    const planEntry = buildSearchPlanEntryForGrant({
      compiledFilter,
      grantStreams: grant.streams,
      manifestStream,
      resolvedConnectorInstanceId,
      streamsFilter,
    });
    if (planEntry) {
      plan.push(planEntry);
    }
  }
  return plan;
}

function resolveLexicalRetrievalAdvertisement(opts: SearchRunArgs["opts"]): SearchLexicalAdvertisement | null {
  if (opts?.lexicalRetrievalCapability) {
    return opts.lexicalRetrievalCapability;
  }
  // Default advertisement matches buildLexicalRetrievalCapability() defaults.
  if (opts?.lexicalRetrievalSupported === false) {
    return null;
  }
  return {
    cross_stream: true,
    default_limit: 25,
    max_limit: 100,
    score: {
      kind: "bm25",
      order: "lower_is_better",
      supported: true,
      value_semantics: "implementation_relative",
    },
    snippets: true,
    supported: true,
  };
}

// ─── Snapshot building (FTS5 query + ranking) ──────────────────────────────

/**
 * Per-(stream, field) candidate cap applied by the SQLite lexical FTS query
 * (`ORDER BY score ASC LIMIT 200`). This is the bounded candidate window the
 * recall disclosure reports: when a single SQLite query returns this many rows,
 * that source's candidate set may have been truncated, so the ranked snapshot
 * is not guaranteed to represent every caller-visible match.
 *
 * NOTE: this is the SQLite cap only. The Postgres builder has a DIFFERENT
 * effective cap — see `postgresEffectiveCandidateWindowLimit()` — because
 * `postgresLexicalSearch` ranks an inner candidate CTE (default 200) and then
 * clamps the outer returned rows to <=100. The honest `candidate_window_limit`
 * reported per backend reflects the cap that actually bounded that backend.
 *
 * Spec: openspec/changes/disclose-lexical-recall-windows.
 */
const SQLITE_LEXICAL_CANDIDATE_WINDOW_LIMIT = 200;

/**
 * Effective per-(stream, field) candidate cap the Postgres lexical builder
 * actually applies. `postgresLexicalSearch` clamps its outer `LIMIT` to <=100,
 * so even though the inner candidate CTE defaults to 200, no Postgres query
 * returns more than 100 ranked rows. The recall disclosure uses this so the
 * truncation signal (`rows.length >= cap`) is correct for Postgres and the
 * reported `candidate_window_limit` is not a lie.
 */
function postgresEffectiveCandidateWindowLimit(): number {
  // Mirror the clamp inside `postgresLexicalSearch`: the outer LIMIT is
  // Math.min(Math.max(requested, 1), 100). We request the inner CTE limit, so
  // the binding cap is min(candidateLimit, 100).
  return Math.min(postgresLexicalCandidateLimit(), 100);
}

/**
 * Build a snapshot of the ranked result set for (q, perConnectorPlans).
 * Returns { snapshot_id, query, plan_hash, results, recall_meta }.
 *
 * Each result is a candidate with everything needed to shape a search_result
 * object: { connectorId, stream, recordKey, emittedAt, matchedFields, snippet? }.
 *
 * Cross-connector merge uses round-robin so no single connector dominates the
 * early pages. Within a connector, hits are ordered by FTS5's bm25() (lower
 * is better).
 *
 * `recall_meta` carries the operation-level recall disclosure for the WHOLE
 * ranked set (see openspec/changes/disclose-lexical-recall-windows). It is
 * computed from per-source truncation facts so the operation does not have to
 * infer completeness from `has_more`. It counts only the caller-visible sources
 * the fan-in actually searched (grant-safe by construction: the fan-out already
 * resolved authorized bindings/streams/fields upstream).
 */
async function buildSnapshot({
  q,
  perConnectorPlans,
  isOwner,
}: {
  q: string;
  perConnectorPlans: LexicalConnectorPlan[];
  isOwner: boolean;
}): Promise<SearchLexicalSnapshot> {
  const allowsSnippets = true; // reference always supports snippets in v1
  const perConnectorResults = await mapSearchFanout(
    perConnectorPlans,
    async ({
      connectorId,
      planEntries,
      manifest,
    }: {
      connectorId: string | null;
      planEntries: LexicalQueryPlanEntry[];
      manifest: LexicalManifest;
    }) =>
      runFtsQueryForConnector({
        allowsSnippets,
        connectorId: (connectorId || manifest.connector_id) as string,
        ...(planEntries[0]?.connectorInstanceId ||
        manifest.storage_binding?.connector_instance_id ||
        manifest.connector_instance_id
          ? {
              connectorInstanceId:
                planEntries[0]?.connectorInstanceId ||
                manifest.storage_binding?.connector_instance_id ||
                manifest.connector_instance_id,
            }
          : {}),
        planEntries: planEntries as LexicalQueryPlanEntry[],
        q,
      }),
    { isPostgres: isPostgresStorageBackend() }
  );

  const perConnectorHits = perConnectorResults.map((r) => r.hits);
  const recallMeta = computeSnapshotRecallMeta(perConnectorResults);

  // Round-robin merge across connectors, preserving each connector's
  // intra-list relevance order.
  const merged = roundRobinMerge(perConnectorHits);

  // Decorate each hit with the owner-facing display_name when the store has
  // a non-placeholder label for the binding. Lookups are deduped per
  // connection_id so a snapshot with N hits across K bindings makes at most
  // K store roundtrips. We omit the field rather than guess when no label
  // is available.
  const displayNames = await resolveDisplayNamesForBindings(
    merged.map((hit) => ({
      connectorId: hit.connectorId,
      connectorInstanceId: hit.connectorInstanceId ?? null,
    }))
  );
  for (const hit of merged) {
    const displayName = displayNames.get(hit.connectorInstanceId ?? "");
    if (displayName) {
      hit.displayName = displayName;
    }
  }

  return {
    plan_hash: hashPlan({ isOwner, perConnectorPlans }),
    query: q,
    ...(recallMeta ? { recall_meta: recallMeta } : {}),
    results: merged,
    snapshot_id: generateSnapshotId(),
  };
}

/**
 * Fold per-source FTS facts into the operation-level recall/count disclosure.
 *
 * `perConnectorResults` is one entry per searched source (binding), each:
 *   { hits, rankedCandidateCount, truncated, candidateWindowLimit }
 * where `rankedCandidateCount` is the number of distinct records this source
 * contributed, `truncated` is true when at least one of the source's
 * (stream, field) SQL queries filled its backend's candidate window, and
 * `candidateWindowLimit` is the cap that bounded that backend (SQLite=200,
 * Postgres=effective outer clamp).
 *
 * Honesty rules:
 *   - If NO source truncated, the ranked set is the complete caller-visible
 *     match set: count is `exact`, recall is `all_matches` / complete.
 *   - If ANY source truncated, the count is a `lower_bound` (more matches may
 *     exist beyond the window) and recall is `candidate_window` / incomplete.
 *   - Window facts (`ranked_candidate_count`, `candidate_window_limit`,
 *     `sources_searched_count`, `truncated_source_count`) are compact aggregates
 *     only emitted when proven. `truncated_source_count` is omitted unless a
 *     window is active (we never emit a guessed `0`). `candidate_window_limit`
 *     is emitted only when every truncated source shared one cap; if truncated
 *     sources used different caps (mixed backends — not currently possible) we
 *     omit it rather than report a misleading single number.
 */
function computeSnapshotRecallMeta(perConnectorResults: LexicalSearchResult[]): SearchLexicalSnapshot["recall_meta"] {
  const sourcesSearched = perConnectorResults.length;
  const rankedCandidateCount = perConnectorResults.reduce(
    (sum, r) => sum + (Number.isFinite(r.rankedCandidateCount) ? r.rankedCandidateCount : 0),
    0
  );
  const truncatedResults = perConnectorResults.filter((r) => r.truncated);
  const truncatedSourceCount = truncatedResults.length;
  const anyTruncated = truncatedSourceCount > 0;

  if (!anyTruncated) {
    // Every searched source returned strictly fewer rows than the cap, so the
    // ranked set IS the complete caller-visible match set. Count is exact.
    return {
      count: rankedCandidateCount,
      count_accuracy: "exact",
      recall: {
        complete: true,
        ranked_candidate_count: rankedCandidateCount,
        ranking_scope: "all_matches",
        sources_searched_count: sourcesSearched,
        truncated: false,
      },
    };
  }

  // All truncated sources share one cap iff they all report the same
  // `candidateWindowLimit`. (Today a single search hits one backend, so this is
  // always true; the guard keeps the field honest if that ever changes.)
  const truncatedCaps = new Set(truncatedResults.map((r) => r.candidateWindowLimit).filter((n) => Number.isFinite(n)));
  const sharedCap = truncatedCaps.size === 1 ? [...truncatedCaps][0] : null;

  // At least one source's candidate set was capped. We ranked a bounded window;
  // the true caller-visible match count is at least what we ranked.
  return {
    count: rankedCandidateCount,
    count_accuracy: "lower_bound",
    recall: {
      complete: false,
      ranked_candidate_count: rankedCandidateCount,
      ranking_scope: "candidate_window",
      truncated: true,
      ...(sharedCap === null ? {} : { candidate_window_limit: sharedCap }),
      sources_searched_count: sourcesSearched,
      truncated_source_count: truncatedSourceCount,
    },
  };
}

/**
 * Run the FTS5 query for one connector across all of its (stream, field)
 * plan entries. Returns `{ hits, rankedCandidateCount, truncated, candidateWindowLimit }`:
 *   - `hits`: array of collapsed hits sorted by intra-connector relevance;
 *   - `rankedCandidateCount`: number of distinct records this source ranked;
 *   - `truncated`: true when at least one (stream, field) SQL query filled its
 *     backend's candidate window, i.e. the bounded window may have excluded
 *     further caller-visible matches;
 *   - `candidateWindowLimit`: the cap that bounded this backend's queries
 *     (SQLite=`SQLITE_LEXICAL_CANDIDATE_WINDOW_LIMIT`, Postgres=the effective
 *     outer clamp from `postgresEffectiveCandidateWindowLimit()`).
 *
 * For each matching record, we collapse multiple field hits into one hit
 * with a combined matched_fields list and one snippet from the
 * highest-ranked field match.
 *
 * Truncation is observed at the SQL-query level (rows returned >= the cap)
 * rather than after collapse/grant-filtering: a query that filled the window
 * could have more matching rows beyond it, so the honest answer is "may be
 * truncated" even if post-filtering then drops some of those rows.
 */
async function runFtsQueryForConnector({
  connectorId,
  connectorInstanceId,
  planEntries,
  q,
  allowsSnippets,
}: {
  connectorId: string;
  connectorInstanceId?: string | null;
  planEntries: LexicalQueryPlanEntry[];
  q: string;
  allowsSnippets: boolean;
}): Promise<LexicalSearchResult> {
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);
  const branchArgs = { allowsSnippets, connectorId, planEntries, q, resolvedConnectorInstanceId };
  return await (isPostgresStorageBackend()
    ? runFtsQueryForConnectorPostgres(branchArgs)
    : runFtsQueryForConnectorSqlite(branchArgs));
}

// Both FTS backends can return several field matches for a record. Keep the
// collapse decision in one explicit mutation seam so backend query adapters
// only supply their raw row values and score convention.
function applyFtsHitMatch({
  collapsed,
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
  emittedAt,
  recordJson,
  field,
  score,
  snippetText,
  allowsSnippets,
}: {
  collapsed: Map<string, LexicalCollapsedHit>;
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  recordKey: string;
  emittedAt: string;
  recordJson: string | null | undefined;
  field: string;
  score: number;
  snippetText: string | null | undefined;
  allowsSnippets: boolean;
}): void {
  const key = `${stream}:${recordKey}`;
  const existing = collapsed.get(key);
  if (existing) {
    updateCollapsedFtsHit(existing, { allowsSnippets, field, score, snippetText });
    return;
  }
  collapsed.set(
    key,
    makeCollapsedFtsHit({
      allowsSnippets,
      connectorId,
      connectorInstanceId,
      emittedAt,
      field,
      recordJson,
      recordKey,
      score,
      snippetText,
      stream,
    })
  );
}

function updateCollapsedFtsHit(
  hit: LexicalCollapsedHit,
  {
    field,
    score,
    snippetText,
    allowsSnippets,
  }: { field: string; score: number; snippetText: string | null | undefined; allowsSnippets: boolean }
): void {
  if (!hit.matchedFields.includes(field)) {
    hit.matchedFields.push(field);
  }
  if (!(score < hit.score)) {
    return;
  }
  hit.score = score;
  if (allowsSnippets && snippetText) {
    hit.snippet = { field, text: snippetText };
  }
}

function makeCollapsedFtsHit({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
  emittedAt,
  recordJson,
  field,
  score,
  snippetText,
  allowsSnippets,
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  recordKey: string;
  emittedAt: string;
  recordJson: string | null | undefined;
  field: string;
  score: number;
  snippetText: string | null | undefined;
  allowsSnippets: boolean;
}): LexicalCollapsedHit {
  return {
    authoredAt: authoredTimestampFromRecordJson(recordJson),
    connectorId,
    connectorInstanceId,
    emittedAt,
    matchedFields: [field],
    recordKey,
    stream,
    ...(allowsSnippets && snippetText ? { snippet: { field, text: snippetText } } : {}),
    score,
  };
}

async function resolvePostgresPlanEntryCandidateRecordKeys({
  connectorInstanceId,
  entry,
}: {
  connectorInstanceId: string;
  entry: LexicalQueryPlanEntry;
}): Promise<string[] | null> {
  if (Array.isArray(entry.candidateRecordKeys)) {
    return entry.candidateRecordKeys;
  }
  if (!entry.postgresCandidateFilter) {
    return null;
  }
  return await buildPostgresCandidateRecordKeys({
    connectorInstanceId,
    streamName: entry.streamName,
    ...entry.postgresCandidateFilter,
  });
}

async function queryPostgresFtsPlanEntry({
  connectorId,
  connectorInstanceId,
  entry,
  q,
  candidateWindowLimit,
}: {
  connectorId: string;
  connectorInstanceId: string;
  entry: LexicalQueryPlanEntry;
  q: string;
  candidateWindowLimit: number;
}): Promise<LexicalPostgresQueryResult | null> {
  const candidateRecordKeys = await resolvePostgresPlanEntryCandidateRecordKeys({ connectorInstanceId, entry });
  if (Array.isArray(candidateRecordKeys) && candidateRecordKeys.length === 0) {
    return null;
  }
  const rows = await postgresLexicalSearch({
    connectorId,
    connectorInstanceId,
    // Request the inner candidate-CTE size; `postgresLexicalSearch` clamps
    // the returned rows to <=100, so `candidateWindowLimit` (the effective
    // cap) is what bounds `rows.length`.
    limit: postgresLexicalCandidateLimit(),
    q,
    recordKeys: candidateRecordKeys,
    searchableFields: entry.searchableFields,
    stream: entry.streamName,
  });
  return {
    rows: Array.isArray(candidateRecordKeys)
      ? rows.filter((row) => candidateRecordKeys.includes(row.record_key))
      : rows,
    truncated: rows.length >= candidateWindowLimit,
  };
}

// Postgres backend branch of `runFtsQueryForConnector`. Consumes the already
// grant-scoped plan entries (candidate record keys / postgres candidate filter
// are computed upstream) and returns the same
// `{ hits, rankedCandidateCount, truncated, candidateWindowLimit }` shape.
async function runFtsQueryForConnectorPostgres({
  connectorId,
  resolvedConnectorInstanceId,
  planEntries,
  q,
  allowsSnippets,
}: {
  connectorId: string;
  resolvedConnectorInstanceId: string;
  planEntries: LexicalQueryPlanEntry[];
  q: string;
  allowsSnippets: boolean;
}): Promise<LexicalSearchResult> {
  let truncated = false;
  const candidateWindowLimit = postgresEffectiveCandidateWindowLimit();
  const collapsed = new Map<string, LexicalCollapsedHit>();
  const queryResults = await Promise.all(
    planEntries.map(async (entry) => ({
      entry,
      queryResult: await queryPostgresFtsPlanEntry({
        candidateWindowLimit,
        connectorId,
        connectorInstanceId: resolvedConnectorInstanceId,
        entry,
        q,
      }),
    }))
  );
  for (const { entry, queryResult } of queryResults) {
    if (!queryResult) {
      continue;
    }
    if (queryResult.truncated) {
      truncated = true;
    }
    for (const row of queryResult.rows) {
      applyFtsHitMatch({
        allowsSnippets,
        collapsed,
        connectorId,
        connectorInstanceId: resolvedConnectorInstanceId,
        emittedAt: row.emitted_at,
        field: row.field,
        recordJson: row.record_json,
        recordKey: row.record_key,
        score: -Number(row.score || 0),
        snippetText: row.snippet_text,
        stream: entry.streamName,
      });
    }
  }
  const hits = Array.from(collapsed.values()).sort((a, b) => a.score - b.score);
  return { candidateWindowLimit, hits, rankedCandidateCount: hits.length, truncated };
}

function querySqliteFtsPlanEntry({
  connectorInstanceId,
  entry,
  field,
  ftsQuery,
  allowsSnippets,
}: {
  connectorInstanceId: string;
  entry: LexicalQueryPlanEntry;
  field: string;
  ftsQuery: string;
  allowsSnippets: boolean;
}): LexicalIndexRow[] {
  // bm25(lexical_search_index) returns smaller values for better matches
  // (negative-leaning). The public score exposes that implementation-relative
  // ordering honestly rather than normalizing it.
  const snippetExpr = allowsSnippets ? `snippet(lexical_search_index, 5, '<mark>', '</mark>', '…', 48)` : "NULL";
  const recordKeyConstraint = Array.isArray(entry.candidateRecordKeys)
    ? `AND r.record_key IN (${entry.candidateRecordKeys.map(() => "?").join(",")})`
    : "";
  // REVIEWED-DYNAMIC: FTS query has conditional snippet/candidate predicates;
  // SQL composed at call time; the bounded candidate window
  // (SQLITE_LEXICAL_CANDIDATE_WINDOW_LIMIT) is interpolated as a numeric
  // literal.
  const sql = `
        SELECT
          lsi.record_key                          AS record_key,
          ${snippetExpr}                          AS snippet_text,
          bm25(lexical_search_index)              AS score,
          r.emitted_at                            AS emitted_at,
          r.record_json                           AS record_json,
          r.deleted                               AS deleted
        FROM lexical_search_index lsi
        JOIN records r
          ON r.connector_instance_id = lsi.connector_instance_id
         AND r.stream       = lsi.stream
         AND r.record_key   = lsi.record_key
        WHERE lsi.connector_instance_id = ?
          AND lsi.stream       = ?
          AND lsi.field        = ?
          AND lsi.text MATCH   ?
          AND r.deleted = 0
          ${recordKeyConstraint}
        ORDER BY score ASC
        LIMIT ${SQLITE_LEXICAL_CANDIDATE_WINDOW_LIMIT}
      `;
  const rows: LexicalIndexRow[] = [];
  for (const row of iterateDynamicSqlAcknowledged<LexicalIndexRow>(sql, [
    connectorInstanceId,
    entry.streamName,
    field,
    ftsQuery,
    ...(entry.candidateRecordKeys || []),
  ])) {
    rows.push(row);
  }
  return rows;
}

// SQLite backend branch of `runFtsQueryForConnector`. Consumes the already
// grant-scoped plan entries and returns the same
// `{ hits, rankedCandidateCount, truncated, candidateWindowLimit }` shape.
function runFtsQueryForConnectorSqlite({
  connectorId,
  resolvedConnectorInstanceId,
  planEntries,
  q,
  allowsSnippets,
}: {
  connectorId: string;
  resolvedConnectorInstanceId: string;
  planEntries: LexicalQueryPlanEntry[];
  q: string;
  allowsSnippets: boolean;
}): LexicalSearchResult {
  let truncated = false;
  const ftsQuery = buildFtsUserTextQuery(q);
  const candidateWindowLimit = SQLITE_LEXICAL_CANDIDATE_WINDOW_LIMIT;
  // Build one query per stream-field plan entry, scoped to this connector
  // and the (stream, field) pair. This guarantees the index is only ever
  // queried for declared+authorized fields.
  //
  // FTS5 MATCH is column-scoped via the query syntax `field:term`. Since
  // we want to match `q` against the `text` column AND restrict by the
  // UNINDEXED `stream`/`field`/`connector_id` columns, we use a regular
  // WHERE clause for the scoping and MATCH for the lexical query against
  // `text`.
  const collapsed = new Map<string, LexicalCollapsedHit>(); // recordKey → { connectorId, connectorInstanceId, stream, recordKey, emittedAt, matchedFields, snippet?, score }

  for (const entry of planEntries) {
    if (Array.isArray(entry.candidateRecordKeys) && entry.candidateRecordKeys.length === 0) {
      continue;
    }
    for (const field of entry.searchableFields) {
      const rows = querySqliteFtsPlanEntry({
        allowsSnippets,
        connectorInstanceId: resolvedConnectorInstanceId,
        entry,
        field,
        ftsQuery,
      });
      if (rows.length >= candidateWindowLimit) {
        truncated = true;
      }
      for (const row of rows) {
        applyFtsHitMatch({
          allowsSnippets,
          collapsed,
          connectorId,
          connectorInstanceId: resolvedConnectorInstanceId,
          emittedAt: row.emitted_at,
          field,
          recordJson: row.record_json,
          recordKey: row.record_key,
          score: Number(row.score),
          snippetText: row.snippet_text,
          stream: entry.streamName,
        });
      }
    }
  }

  // Intra-connector relevance order
  const hits = Array.from(collapsed.values()).sort((a, b) => a.score - b.score);
  return { candidateWindowLimit, hits, rankedCandidateCount: hits.length, truncated };
}

function authoredTimestampFromRecordJson(recordJson: unknown): string | null {
  if (!recordJson) {
    return null;
  }
  let data = recordJson;
  if (typeof recordJson === "string") {
    try {
      data = JSON.parse(recordJson);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as JsonObject;
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

function buildFtsUserTextQuery(q: string): string {
  const terms = String(q || "")
    .trim()
    .split(FTS_TERM_SEPARATOR)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return terms.length > 0 ? terms.join(" ") : '""';
}

function roundRobinMerge(perConnectorHits: LexicalHit[][]): LexicalHit[] {
  const merged: LexicalHit[] = [];
  let idx = 0;
  let progress = true;
  while (progress) {
    progress = false;
    for (const list of perConnectorHits) {
      if (idx < list.length) {
        const hit = list[idx] as LexicalHit;
        merged.push(hit);
        progress = true;
      }
    }
    idx += 1;
  }
  return merged;
}

// ─── Snapshot persistence ─────────────────────────────────────────────────
//
// `search_result` shaping and cursor encoding live in the canonical
// `rs.search.lexical` operation; only adapter-bound snapshot storage stays
// here.

const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateSnapshotId(): string {
  return `snap_${randomBytes(8).toString("hex")}`;
}

// Deterministic ordering for the per-entry plan summary: by connector instance
// id, then stream. Keeps hashPlan's binding hash stable across enumeration order.
function comparePlanEntrySummary(a: { i: unknown; s: string }, b: { i: unknown; s: string }): number {
  const ia = typeof a.i === "string" ? a.i : "";
  const ib = typeof b.i === "string" ? b.i : "";
  if (ia !== ib) {
    return ia < ib ? -1 : 1;
  }
  if (a.s < b.s) {
    return -1;
  }
  return a.s > b.s ? 1 : 0;
}

// Deterministic ordering for the per-connector plan summary by connector id.
function comparePlanConnectorSummary(a: { c?: string | null }, b: { c?: string | null }): number {
  const left = a.c || "";
  const right = b.c || "";
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function hashPlan({
  perConnectorPlans,
  isOwner,
}: {
  perConnectorPlans: LexicalConnectorPlan[];
  isOwner: boolean;
}): string {
  // Stable hash over the binding set so cursors only survive across requests
  // whose plan covers the same `(connector_id, connector_instance_id,
  // stream, sorted searchable_fields)` topology. A request that adds or
  // removes a binding mid-pagination yields a different hash, invalidating
  // cursor reuse — the natural fall-out is `invalid_cursor` on the next page.
  //
  // We sort the plan summary deterministically (connector_id,
  // connector_instance_id, then stream) so two requests with the same
  // binding set hash equal regardless of enumeration order across owner
  // fan-out and client binding resolution.
  const summary = perConnectorPlans
    .map((p) => ({
      c: p.connectorId,
      e: p.planEntries
        .map((pe) => ({
          f: pe.searchableFields.slice().sort(),
          i: pe.connectorInstanceId || null,
          s: pe.streamName,
        }))
        .sort(comparePlanEntrySummary),
    }))
    .sort(comparePlanConnectorSummary);
  return JSON.stringify({ isOwner, summary });
}

/**
 * Serialize a snapshot's persisted payload into the existing `results_json`
 * column. We avoid a schema migration (the disclosure change is additive) by
 * storing a wrapper `{ results, recall_meta }` rather than a bare results
 * array. `materializeSnapshot` reads both this wrapped shape and the legacy
 * bare-array shape so in-flight pre-upgrade snapshots (5-minute TTL) keep
 * paginating — they just report `not_counted` / `unknown` recall, which is
 * the honest answer for a snapshot built before recall facts were captured.
 */
function serializeSnapshotResultsJson(snapshot: SearchLexicalSnapshot): string {
  return JSON.stringify({
    ...(snapshot.authority_key ? { authority_key: snapshot.authority_key } : {}),
    results: snapshot.results,
    ...(snapshot.recall_meta ? { recall_meta: snapshot.recall_meta } : {}),
  });
}

async function persistSnapshot(snapshot: SearchLexicalSnapshot): Promise<void> {
  const resultsJson = serializeSnapshotResultsJson(snapshot);
  await getSearchIndexStore().persistSnapshot({
    planHash: String(snapshot.plan_hash),
    query: snapshot.query,
    resultsJson,
    snapshotId: snapshot.snapshot_id,
  });
}

async function loadSnapshot(snapshotId: string): Promise<SearchLexicalSnapshot | null> {
  const row = await getSearchIndexStore().loadSnapshotRow(snapshotId);
  return materializeSnapshot(row);
}

function materializeSnapshot(row: LexicalSnapshotRow | null): SearchLexicalSnapshot | null {
  if (!row) {
    return null;
  }
  const createdAt = new Date(`${row.created_at}Z`).getTime();
  if (Number.isFinite(createdAt) && Date.now() - createdAt > SNAPSHOT_TTL_MS) {
    return null;
  }
  const parsed = JSON.parse(row.results_json);
  // Two persisted shapes coexist during the upgrade window:
  //   - new: { results: [...], recall_meta?: {...} }
  //   - legacy: [...] (bare results array from a pre-upgrade snapshot)
  // Cursor pages reuse the snapshot's recall_meta verbatim so every page
  // reports identical recall facts; a legacy snapshot has none, so the
  // operation falls back to an honest not_counted / unknown envelope.
  const isWrapped = parsed && !Array.isArray(parsed) && Array.isArray(parsed.results);
  const results = isWrapped ? parsed.results : parsed;
  const recallMeta = isWrapped && parsed.recall_meta ? parsed.recall_meta : undefined;
  return {
    ...(isWrapped && typeof parsed.authority_key === "string" ? { authority_key: parsed.authority_key } : {}),
    plan_hash: row.plan_hash,
    query: row.query,
    results,
    snapshot_id: row.snapshot_id,
    ...(recallMeta ? { recall_meta: recallMeta } : {}),
  };
}
