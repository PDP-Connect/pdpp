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

import { randomBytes } from 'crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import {
  allowUnboundedReadAcknowledged,
  exec,
  getMany,
  getOne,
  iterateDynamicSqlAcknowledged,
  referenceQueries,
  transaction,
} from '../lib/db.ts';
import {
  executeSearchLexical,
  parseSearchLexicalParams,
  SearchLexicalRequestError,
} from '../operations/rs-search-lexical/index.ts';
import { getConnectorManifest } from './auth.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import {
  compileRequestFilters,
  passesGrantRecordConstraints,
  passesRequestFilters,
} from './record-filters.js';
import { makeDefaultAccountConnectorInstanceId } from './stores/connector-instance-store.js';
import {
  listActiveOwnerBindingsForConnectors,
  resolveDisplayNamesForBindings,
  resolveFanInBindings,
} from './connection-identity.js';
import {
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
} from './postgres-search.js';
import { isPostgresStorageBackend, postgresQuery } from './postgres-storage.js';

let activeLexicalBackfillCount = 0;
let nextLexicalBackfillJobId = 1;
const lexicalBackfillJobs = new Map();

function publicLexicalBackfillJob(job) {
  return {
    id: job.id,
    connector_id: job.connectorId,
    stream: job.stream,
    phase: job.phase,
    active_jobs: activeLexicalBackfillCount,
    manifest_streams_checked: job.manifestStreamsChecked,
    manifest_streams_total: job.manifestStreamsTotal,
    records_scanned: job.recordsScanned,
    records_total: job.recordsTotal,
    indexed_rows: job.indexedRows,
    started_at: job.startedAt,
    updated_at: job.updatedAt,
  };
}

function latestLexicalBackfillJob() {
  let latest = null;
  for (const job of lexicalBackfillJobs.values()) {
    if (!latest || job.updatedAt > latest.updatedAt) {
      latest = job;
    }
  }
  return latest;
}

function updateLexicalBackfillJob(job, patch) {
  const updated = {
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

function resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId = null) {
  if (typeof connectorInstanceId === 'string' && connectorInstanceId.trim()) {
    return connectorInstanceId.trim();
  }
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

// ─── Stream-level declaration lookup ───────────────────────────────────────

/**
 * Look up the declared lexical_fields for (connector_id, stream) by reading
 * the connector manifest. Returns an array of top-level scalar string field
 * names, or null if the stream does not participate in lexical retrieval.
 *
 * Manifest validator (auth.js) already enforces v1 shape constraints, so we
 * trust the declaration here.
 */
async function getStreamLexicalFields(connectorId, stream) {
  const manifest = await getConnectorManifest(connectorId);
  if (!manifest) return null;
  const mStream = (manifest.streams || []).find((s) => s.name === stream);
  const declared = mStream?.query?.search?.lexical_fields;
  if (!Array.isArray(declared) || declared.length === 0) return null;
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
export async function lexicalIndexUpsert({ connectorId, connectorInstanceId, stream, recordKey, data }) {
  const declared = await getStreamLexicalFields(connectorId, stream);
  if (!declared) return;
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);

  if (isPostgresStorageBackend()) {
    const fields = Object.fromEntries(
      declared
        .map((field) => [field, data?.[field]])
        .filter(([, value]) => typeof value === 'string' && value.length > 0),
    );
    await postgresLexicalIndexUpsert({ connectorId, connectorInstanceId: resolvedConnectorInstanceId, stream, recordKey, fields });
    return;
  }

  exec(referenceQueries.searchIndexDeleteByRecordKey, [resolvedConnectorInstanceId, stream, recordKey]);

  for (const field of declared) {
    const value = data?.[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    exec(referenceQueries.searchIndexInsertRow, [connectorId, resolvedConnectorInstanceId, stream, recordKey, field, value]);
  }
}

/**
 * Delete all FTS rows for a single record. Called on hard or soft delete.
 */
export async function lexicalIndexDelete({ connectorId, connectorInstanceId, stream, recordKey }) {
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);
  if (isPostgresStorageBackend()) {
    await postgresLexicalIndexDelete({ connectorId, connectorInstanceId: resolvedConnectorInstanceId, stream, recordKey });
    return;
  }
  exec(referenceQueries.searchIndexDeleteByRecordKey, [resolvedConnectorInstanceId, stream, recordKey]);
}

/**
 * Delete all FTS rows for an entire (connector_id, stream). Called on
 * deleteAllRecords (the owner-authenticated reset path).
 */
export async function lexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream }) {
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);
  if (isPostgresStorageBackend()) {
    await postgresLexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId: resolvedConnectorInstanceId, stream });
    return;
  }
  exec(referenceQueries.searchIndexDeleteByStream, [resolvedConnectorInstanceId, stream]);
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
async function rebuildLexicalIndexForStream({ connectorId, connectorInstanceId, stream, declaredFields, recordsToScan = null, progressJob = null, signal = null }) {
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);
  const usePostgres = isPostgresStorageBackend();
  if (usePostgres) {
    await postgresLexicalIndexDeleteByConnectorStream({
      connectorId,
      connectorInstanceId: resolvedConnectorInstanceId,
      stream,
    });
  } else {
    exec(referenceQueries.searchIndexDeleteByStream, [resolvedConnectorInstanceId, stream]);
  }

  // Stream the records page-by-page so we don't pull the whole table into
  // memory on big stores.
  const PAGE = 500;
  let lastId = 0;
  let scanned = 0;
  let indexed = 0;
  for (;;) {
    // Cancellation hook: signaled when the CLI is shutting down so the
    // backfill releases the WAL writer before `closeDb()` runs. Checked
    // between page transactions only — interrupting mid-transaction would
    // leave SQLite to roll the whole page back, which is what we want
    // anyway, but releasing on a clean page boundary keeps progress
    // restartable.
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('lexical backfill aborted');
    }
    const rows = usePostgres
      ? await postgresLexicalRecordsPageNonDeleted({
        connectorInstanceId: resolvedConnectorInstanceId,
        stream,
        afterId: lastId,
        limit: PAGE,
      })
      : getMany(
        referenceQueries.searchRecordsPageNonDeleted,
        [resolvedConnectorInstanceId, stream, lastId],
        { limit: PAGE },
      ).rows;
    if (rows.length === 0) break;
    const entries = [];
    for (const row of rows) {
      lastId = Number(row.id);
      scanned += 1;
      let data;
      try {
        data = row.record_json ? JSON.parse(row.record_json) : null;
      } catch {
        // Skip corrupt rows — the index just won't have them; the source
        // record stays intact for whoever needs to repair it.
        continue;
      }
      for (const field of declaredFields) {
        const value = data?.[field];
        if (typeof value !== 'string' || value.length === 0) continue;
        entries.push({ recordKey: row.record_key, field, text: value });
      }
    }
    if (entries.length > 0) {
      if (usePostgres) {
        await postgresLexicalIndexInsertMany({
          connectorId,
          connectorInstanceId: resolvedConnectorInstanceId,
          stream,
          entries,
        });
      } else {
        transaction(() => {
          for (const entry of entries) {
            exec(referenceQueries.searchIndexInsertRow, [connectorId, resolvedConnectorInstanceId, stream, entry.recordKey, entry.field, entry.text]);
          }
        });
      }
      indexed += entries.length;
    }
    if (progressJob) {
      progressJob = updateLexicalBackfillJob(progressJob, {
        recordsScanned: scanned,
        recordsTotal: recordsToScan,
        indexedRows: indexed,
      });
    }
    await yieldImmediate();
    if (rows.length < PAGE) break;
  }
  return indexed;
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
function fingerprintLexicalFields(declaredFields) {
  const unique = Array.from(new Set(declaredFields));
  unique.sort();
  return JSON.stringify(unique);
}

function jsonPathForTopLevelField(field) {
  return `$."${String(field).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function countIndexableTextValues({ connectorInstanceId, stream, declaredFields }) {
  if (isPostgresStorageBackend()) {
    return await postgresLexicalCountIndexableTextValues({
      connectorInstanceId,
      stream,
      declaredFields,
    });
  }
  let total = 0;
  for (const field of declaredFields) {
    const path = jsonPathForTopLevelField(field);
    const row = getOne(referenceQueries.searchRecordsCountIndexableTextValues, [connectorInstanceId, stream, path, path]);
    total += Number(row?.n || 0);
  }
  return total;
}

async function lexicalMetaGetFingerprint({ connectorInstanceId, stream }) {
  if (isPostgresStorageBackend()) {
    return await postgresLexicalMetaGetFingerprint({ connectorInstanceId, stream });
  }
  return getOne(referenceQueries.searchMetaGetFingerprintByStream, [connectorInstanceId, stream]);
}

async function lexicalMetaExists({ connectorInstanceId, stream }) {
  if (isPostgresStorageBackend()) {
    return !!(await lexicalMetaGetFingerprint({ connectorInstanceId, stream }));
  }
  return !!getOne(referenceQueries.searchMetaExistsByStream, [connectorInstanceId, stream]);
}

async function lexicalMetaUpsertFingerprint({ connectorId, connectorInstanceId, stream, fieldsFingerprint, updatedAt }) {
  if (isPostgresStorageBackend()) {
    await postgresLexicalMetaUpsertFingerprint({
      connectorId,
      connectorInstanceId,
      stream,
      fieldsFingerprint,
      updatedAt,
    });
    return;
  }
  exec(referenceQueries.searchMetaUpsertFingerprint, [connectorId, connectorInstanceId, stream, fieldsFingerprint, updatedAt]);
}

async function lexicalIndexAndMetaDeleteByStream({ connectorId, connectorInstanceId, stream }) {
  if (isPostgresStorageBackend()) {
    await postgresLexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    return;
  }
  exec(referenceQueries.searchIndexDeleteByStream, [connectorInstanceId, stream]);
  exec(referenceQueries.searchMetaDeleteByStream, [connectorInstanceId, stream]);
}

async function lexicalMetaListStreamsForConnector({ connectorInstanceId }) {
  if (isPostgresStorageBackend()) {
    return await postgresLexicalMetaListStreamsForConnector({ connectorInstanceId });
  }
  return allowUnboundedReadAcknowledged(
    referenceQueries.searchMetaListStreamsForConnector,
    [connectorInstanceId],
  );
}

async function lexicalIndexCountByStream({ connectorInstanceId, stream }) {
  if (isPostgresStorageBackend()) {
    return await postgresLexicalIndexCountByStream({ connectorInstanceId, stream });
  }
  const row = getOne(referenceQueries.searchIndexCountByStream, [connectorInstanceId, stream]);
  return Number(row?.n || 0);
}

async function lexicalRecordsCountNonDeleted({ connectorInstanceId, stream }) {
  if (isPostgresStorageBackend()) {
    return await postgresLexicalRecordsCountNonDeleted({ connectorInstanceId, stream });
  }
  const row = getOne(referenceQueries.searchRecordsCountNonDeleted, [connectorInstanceId, stream]);
  return Number(row?.n || 0);
}

async function resolveLexicalBackfillConnectorInstanceIds({ connectorId, manifest }) {
  const pinned = manifest.storage_binding?.connector_instance_id || manifest.connector_instance_id;
  if (pinned) {
    return [resolveLexicalConnectorInstanceId(connectorId, pinned)];
  }

  const bindings = await listActiveOwnerBindingsForConnectors({
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorIds: [connectorId],
  });
  const ids = Array.from(
    new Set(bindings.map((binding) => binding.connectorInstanceId).filter(Boolean)),
  );
  if (ids.length > 0) return ids;

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
export async function lexicalIndexBackfillForManifest({ manifest, log = () => {}, signal = null } = {}) {
  if (!manifest?.connector_id || !Array.isArray(manifest?.streams)) return;
  activeLexicalBackfillCount += 1;
  const participatingStreams = manifest.streams.filter((mStream) => {
    const declaredFields = mStream?.query?.search?.lexical_fields;
    return Array.isArray(declaredFields) && declaredFields.length > 0;
  }).length;
  let progressJob = {
    id: `lexical_backfill_${nextLexicalBackfillJobId++}`,
    connectorId: manifest.connector_id,
    stream: null,
    phase: 'planning',
    manifestStreamsChecked: 0,
    manifestStreamsTotal: participatingStreams,
    recordsScanned: 0,
    recordsTotal: null,
    indexedRows: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  lexicalBackfillJobs.set(progressJob.id, progressJob);
  try {
    const connectorId = manifest.connector_id;
    const connectorInstanceIds = await resolveLexicalBackfillConnectorInstanceIds({ connectorId, manifest });
    progressJob = updateLexicalBackfillJob(progressJob, {
      manifestStreamsTotal: participatingStreams * connectorInstanceIds.length,
    });

    for (const connectorInstanceId of connectorInstanceIds) {
      // Track which streams we visited so we can detect "previously
      // participated, no longer participates" — those need their stale index
      // rows and meta fingerprint dropped.
      const visitedStreams = new Set();

      for (const mStream of manifest.streams) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('lexical backfill aborted');
        }
        const stream = mStream?.name;
        if (typeof stream !== 'string' || stream.length === 0) continue;
        visitedStreams.add(stream);

        const declaredFields = mStream?.query?.search?.lexical_fields;
        const isParticipating = Array.isArray(declaredFields) && declaredFields.length > 0;

        if (!isParticipating) {
          // Stream is in the manifest but does not participate. If a prior
          // version declared lexical_fields for it, drop the stale index +
          // meta so historical data doesn't keep matching against a field set
          // that's no longer declared.
          const metaExists = await lexicalMetaExists({ connectorInstanceId, stream });
          if (metaExists) {
            log(`[PDPP] Lexical index: stream='${stream}' connector='${connectorId}' ` +
                `no longer declares lexical_fields — dropping stale index + meta`);
            await lexicalIndexAndMetaDeleteByStream({ connectorId, connectorInstanceId, stream });
          }
          continue;
        }
        progressJob = updateLexicalBackfillJob(progressJob, {
          stream,
          phase: 'checking',
          manifestStreamsChecked: Math.min(
            progressJob.manifestStreamsChecked + 1,
            progressJob.manifestStreamsTotal,
          ),
          recordsScanned: 0,
          recordsTotal: null,
          indexedRows: 0,
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
          expectedIndexRows = await countIndexableTextValues({ connectorInstanceId, stream, declaredFields });

          const maxIndexRows = recordCount * declaredFields.length;
          const inSync = indexCount === expectedIndexRows && indexCount <= maxIndexRows;
          needsRebuild = !inSync;
        }

        if (!needsRebuild) continue;
        if (recordCount === 0) {
          recordCount = await lexicalRecordsCountNonDeleted({ connectorInstanceId, stream });
        }
        progressJob = updateLexicalBackfillJob(progressJob, {
          stream,
          phase: 'rebuilding',
          recordsScanned: 0,
          recordsTotal: recordCount,
          indexedRows: 0,
        });

        if (fingerprintChanged) {
          log(`[PDPP] Lexical index field-set change for ${connectorId} stream='${stream}' ` +
              `(was=${persistedFingerprint ?? 'null'}, now=${newFingerprint}) — rebuilding`);
        } else {
          log(`[PDPP] Lexical index drift for ${connectorId} stream='${stream}' ` +
              `(records=${recordCount}, index=${indexCount}, expected=${expectedIndexRows ?? 'not_checked'}) — rebuilding`);
        }

        const indexedRows = await rebuildLexicalIndexForStream({
          connectorId,
          connectorInstanceId,
          stream,
          declaredFields,
          recordsToScan: recordCount,
          progressJob,
          signal,
        });
        log(`[PDPP] Lexical index rebuild completed for ${connectorId} stream='${stream}' ` +
            `(records=${recordCount}, indexed_rows=${indexedRows})`);

        // Persist the new fingerprint so subsequent backfill calls can skip.
        await lexicalMetaUpsertFingerprint({
          connectorId,
          connectorInstanceId,
          stream,
          fieldsFingerprint: newFingerprint,
          updatedAt: new Date().toISOString(),
        });
      }
      progressJob = updateLexicalBackfillJob(progressJob, {
        stream: null,
        phase: 'cleanup',
        recordsScanned: 0,
        recordsTotal: null,
        indexedRows: 0,
      });

      // Streams that previously had a meta row but are no longer in the
      // manifest at all (entire stream removed). Same cleanup as the
      // "no-longer-participating" case above.
      // REVIEWED-BOUNDED: lexical_search_meta is keyed by (connector_instance_id, stream)
      // and the stream count per connector is a small enumeration bounded by the
      // manifest, well below the @max_rows=1024 declared in the artifact.
      const orphanRows = await lexicalMetaListStreamsForConnector({ connectorInstanceId });
      for (const row of orphanRows) {
        if (visitedStreams.has(row.stream)) continue;
        log(`[PDPP] Lexical index: stream='${row.stream}' connector='${connectorId}' ` +
            `no longer in manifest — dropping stale index + meta`);
        await lexicalIndexAndMetaDeleteByStream({ connectorId, connectorInstanceId, stream: row.stream });
      }
    }
  } finally {
    activeLexicalBackfillCount = Math.max(0, activeLexicalBackfillCount - 1);
    lexicalBackfillJobs.delete(progressJob.id);
  }
}

// ─── Public-route entry point ──────────────────────────────────────────────

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
}) {
  const isOwner = tokenInfo.pdpp_token_kind === 'owner';
  const advertisement = resolveLexicalRetrievalAdvertisement(opts);
  const actor = isOwner
    ? { kind: 'owner', subject_id: tokenInfo.subject_id ?? null }
    : {
        kind: 'client',
        subject_id: tokenInfo.subject_id ?? null,
        client_id: tokenInfo.client_id ?? null,
        grant_id: tokenInfo.grant_id ?? null,
        grant: tokenInfo.grant ?? { streams: [] },
      };

  // Native dependencies wire the operation against the existing FTS5 /
  // SQLite snapshot helpers. The operation owns the public-contract slice
  // (allowlist, advertisement gate, mode planning, cursor format, slice math,
  // envelope, disclosure data); these helpers keep their backend-specific
  // semantics untouched.
  // Resolve the owner subject id once so cross-binding fan-in helpers can
  // enumerate every owner-visible connection without piping the value
  // through each per-connector adapter call. Hosts SHOULD provide
  // `getOwnerSubjectId` explicitly; we fall back to the default owner
  // subject for tests that do not wire it.
  const ownerSubjectId = isOwner
    ? (typeof getOwnerSubjectId === 'function'
        ? getOwnerSubjectId()
        : OWNER_AUTH_DEFAULT_SUBJECT_ID)
    : null;
  const dependencies = {
    getAdvertisement: () => advertisement,
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
      // Find a representative per-stream grant-scope connection_id if all
      // grant streams pin to the same connection. Mixed-constraint grants
      // (different per-stream connection_ids) are addressed in the grant
      // evaluator via per-stream resolution; the search fan-in passes the
      // single pin when all streams agree (or null otherwise).
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
      const effectiveConnectorId = connectorId || manifest?.connector_id;
      const connectorInstanceId = effectiveConnectorId ? resolveLexicalConnectorInstanceId(
        effectiveConnectorId,
        manifest?.storage_binding?.connector_instance_id || manifest?.connector_instance_id,
      ) : null;
      const compiledFilter = compileSingleStreamSearchFilter({
        manifest,
        grant,
        streamName: filteredStream,
        filter,
      });
      return buildSearchPlanForGrant({
        manifest,
        grant,
        streamsFilter,
        compiledFilter,
        connectorId: effectiveConnectorId,
        connectorInstanceId,
      });
    },
    buildSnapshot: (args) => buildSnapshot(args),
    persistSnapshot: (snapshot) => persistSnapshot(snapshot),
    loadSnapshot: (snapshotId) => loadSnapshot(snapshotId),
    formatRecordUrl: ({ stream, recordKey, connectorId, isOwner: ownerActor }) => {
      const recordPath = `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordKey)}`;
      return ownerActor
        ? `${recordPath}?connector_id=${encodeURIComponent(connectorId)}`
        : recordPath;
    },
  };

  let result;
  try {
    result = await executeSearchLexical(
      { actor, query: req.query },
      dependencies,
    );
  } catch (err) {
    if (err instanceof SearchLexicalRequestError) {
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
      url: '/v1/search',
      has_more: result.envelope.has_more,
      ...(result.envelope.next_cursor
        ? { next_cursor: result.envelope.next_cursor }
        : {}),
      data: result.envelope.data,
      // Carry the operation's canonical `meta.warnings[]` (limit_clamped,
      // deprecated_alias_used, source_skipped_not_applicable) through to the
      // REST response. Omitted when the operation produced no warnings so
      // warning-free envelopes are unchanged.
      ...(result.envelope.meta ? { meta: result.envelope.meta } : {}),
    },
    disclosureData: result.disclosureData,
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
export function parseSearchParams(query) {
  try {
    return parseSearchLexicalParams(query);
  } catch (err) {
    if (err instanceof SearchLexicalRequestError) {
      const translated = new Error(err.message);
      translated.code = err.code;
      if (err.param !== undefined) translated.param = err.param;
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

async function buildPostgresCandidateRecordKeys({ connectorInstanceId, streamName, streamGrant, manifestStream, compiledFilters }) {
  if (!needsCandidateRecordScan(streamGrant, compiledFilters)) return null;

  const where = ['connector_instance_id = $1', 'stream = $2', 'deleted = FALSE'];
  const binds = [connectorInstanceId, streamName];
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

function buildCandidateRecordKeys({ connectorInstanceId, streamName, streamGrant, manifestStream, compiledFilters }) {
  const needsRecordScan = compiledFilters?.length || hasGrantRecordConstraints(streamGrant);
  if (!needsRecordScan) return null;

  const where = ['connector_instance_id = ?', 'stream = ?', 'deleted = 0'];
  const binds = [connectorInstanceId, streamName];
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

export function buildSearchPlanForGrant({ manifest, grant, streamsFilter, compiledFilter = null, connectorId = null, connectorInstanceId = null }) {
  if (!manifest?.streams || !grant?.streams) return [];
  const resolvedConnectorInstanceId = connectorId
    ? resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId || manifest?.storage_binding?.connector_instance_id || manifest?.connector_instance_id)
    : null;
  const plan = [];
  for (const mStream of manifest.streams) {
    const declared = mStream?.query?.search?.lexical_fields;
    if (!Array.isArray(declared) || declared.length === 0) continue;
    if (streamsFilter && !streamsFilter.includes(mStream.name)) continue;

    const streamGrant = grant.streams.find((s) => s.name === mStream.name);
    if (!streamGrant) continue;
    if (
      typeof streamGrant.connection_id === 'string'
      && streamGrant.connection_id.length > 0
      && resolvedConnectorInstanceId
      && streamGrant.connection_id !== resolvedConnectorInstanceId
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
    const candidateRecordKeys = resolvedConnectorInstanceId && shouldScanCandidates && !isPostgresStorageBackend()
      ? buildCandidateRecordKeys({
        connectorInstanceId: resolvedConnectorInstanceId,
        streamName: mStream.name,
        streamGrant,
        manifestStream: mStream,
        compiledFilters: filters,
      })
      : null;
    const postgresCandidateFilter = resolvedConnectorInstanceId && shouldScanCandidates && isPostgresStorageBackend()
      ? { streamGrant, manifestStream: mStream, compiledFilters: filters }
      : null;

    plan.push({
      streamName: mStream.name,
      ...(resolvedConnectorInstanceId ? { connectorInstanceId: resolvedConnectorInstanceId } : {}),
      searchableFields: searchable,
      ...(candidateRecordKeys ? { candidateRecordKeys } : {}),
      ...(postgresCandidateFilter ? { postgresCandidateFilter } : {}),
    });
  }
  return plan;
}

function resolveLexicalRetrievalAdvertisement(opts) {
  if (opts?.lexicalRetrievalCapability) return opts.lexicalRetrievalCapability;
  // Default advertisement matches buildLexicalRetrievalCapability() defaults.
  if (opts?.lexicalRetrievalSupported === false) return null;
  return {
    supported: true,
    cross_stream: true,
    snippets: true,
    default_limit: 25,
    max_limit: 100,
    score: {
      supported: true,
      kind: 'bm25',
      order: 'lower_is_better',
      value_semantics: 'implementation_relative',
    },
  };
}

// ─── Snapshot building (FTS5 query + ranking) ──────────────────────────────

/**
 * Build a snapshot of the full ranked result set for (q, perConnectorPlans).
 * Returns { snapshot_id, query, plan_hash, results }.
 *
 * Each result is a candidate with everything needed to shape a search_result
 * object: { connectorId, stream, recordKey, emittedAt, matchedFields, snippet? }.
 *
 * Cross-connector merge uses round-robin so no single connector dominates the
 * early pages. Within a connector, hits are ordered by FTS5's bm25() (lower
 * is better).
 */
async function buildSnapshot({ q, perConnectorPlans, isOwner }) {
  const allowsSnippets = true; // reference always supports snippets in v1
  const perConnectorHits = await Promise.all(
    perConnectorPlans.map(async ({ connectorId, planEntries, manifest }) =>
      runFtsQueryForConnector({
        connectorId: connectorId || manifest?.connector_id,
        connectorInstanceId: planEntries[0]?.connectorInstanceId || manifest?.storage_binding?.connector_instance_id || manifest?.connector_instance_id,
        planEntries,
        q,
        allowsSnippets,
      })
    ),
  );

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
      connectorInstanceId: hit.connectorInstanceId,
      connectorId: hit.connectorId,
    })),
  );
  for (const hit of merged) {
    const displayName = displayNames.get(hit.connectorInstanceId);
    if (displayName) hit.displayName = displayName;
  }

  return {
    snapshot_id: generateSnapshotId(),
    query: q,
    plan_hash: hashPlan({ perConnectorPlans, isOwner }),
    results: merged,
  };
}

/**
 * Run the FTS5 query for one connector across all of its (stream, field)
 * plan entries. Returns an array of hits sorted by intra-connector relevance.
 *
 * For each matching record, we collapse multiple field hits into one hit
 * with a combined matched_fields list and one snippet from the
 * highest-ranked field match.
 */
async function runFtsQueryForConnector({ connectorId, connectorInstanceId, planEntries, q, allowsSnippets }) {
  const resolvedConnectorInstanceId = resolveLexicalConnectorInstanceId(connectorId, connectorInstanceId);
  if (isPostgresStorageBackend()) {
    const collapsed = new Map();
    for (const entry of planEntries) {
      const candidateRecordKeys = Array.isArray(entry.candidateRecordKeys)
        ? entry.candidateRecordKeys
        : entry.postgresCandidateFilter
          ? await buildPostgresCandidateRecordKeys({
            connectorInstanceId: resolvedConnectorInstanceId,
            streamName: entry.streamName,
            ...entry.postgresCandidateFilter,
          })
          : null;
      if (Array.isArray(candidateRecordKeys) && candidateRecordKeys.length === 0) continue;
      const rows = await postgresLexicalSearch({
        connectorId,
        connectorInstanceId: resolvedConnectorInstanceId,
        stream: entry.streamName,
        searchableFields: entry.searchableFields,
        q,
        limit: 200,
        recordKeys: candidateRecordKeys,
      });
      for (const row of rows) {
        if (
          Array.isArray(candidateRecordKeys)
          && !candidateRecordKeys.includes(row.record_key)
        ) {
          continue;
        }
        const key = `${entry.streamName}:${row.record_key}`;
        const score = -Number(row.score || 0);
        const existing = collapsed.get(key);
        if (existing) {
          if (!existing.matchedFields.includes(row.field)) {
            existing.matchedFields.push(row.field);
          }
          if (score < existing.score) {
            existing.score = score;
            if (allowsSnippets && row.snippet_text) {
              existing.snippet = { field: row.field, text: row.snippet_text };
            }
          }
        } else {
          collapsed.set(key, {
            connectorId,
            connectorInstanceId: resolvedConnectorInstanceId,
            stream: entry.streamName,
            recordKey: row.record_key,
            emittedAt: row.emitted_at,
            authoredAt: authoredTimestampFromRecordJson(row.record_json),
            matchedFields: [row.field],
            ...(allowsSnippets && row.snippet_text
              ? { snippet: { field: row.field, text: row.snippet_text } }
              : {}),
            score,
          });
        }
      }
    }
    return Array.from(collapsed.values()).sort((a, b) => a.score - b.score);
  }

  const ftsQuery = buildFtsUserTextQuery(q);
  // Build one query per stream-field plan entry, scoped to this connector
  // and the (stream, field) pair. This guarantees the index is only ever
  // queried for declared+authorized fields.
  //
  // FTS5 MATCH is column-scoped via the query syntax `field:term`. Since
  // we want to match `q` against the `text` column AND restrict by the
  // UNINDEXED `stream`/`field`/`connector_id` columns, we use a regular
  // WHERE clause for the scoping and MATCH for the lexical query against
  // `text`.
  const collapsed = new Map(); // recordKey → { connectorId, connectorInstanceId, stream, recordKey, emittedAt, matchedFields, snippet?, score }

  for (const entry of planEntries) {
    if (Array.isArray(entry.candidateRecordKeys) && entry.candidateRecordKeys.length === 0) continue;
    for (const field of entry.searchableFields) {
      // bm25(lexical_search_index) returns smaller values for better matches
      // (negative-leaning). The public score exposes that implementation-
      // relative ordering honestly rather than normalizing it.
      const snippetExpr = allowsSnippets
        ? `snippet(lexical_search_index, 5, '<mark>', '</mark>', '…', 16)`
        : `NULL`;
      const recordKeyConstraint = Array.isArray(entry.candidateRecordKeys)
        ? `AND r.record_key IN (${entry.candidateRecordKeys.map(() => '?').join(',')})`
        : '';
      // REVIEWED-DYNAMIC: FTS query has conditional snippet/candidate
      // predicates; SQL composed at call time; LIMIT 200 included.
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
        LIMIT 200
      `;
      const rows = [];
      for (const row of iterateDynamicSqlAcknowledged(
        sql,
        [resolvedConnectorInstanceId, entry.streamName, field, ftsQuery, ...(entry.candidateRecordKeys || [])],
      )) {
        rows.push(row);
      }
      for (const row of rows) {
        const key = `${entry.streamName}:${row.record_key}`;
        const existing = collapsed.get(key);
        if (existing) {
          if (!existing.matchedFields.includes(field)) {
            existing.matchedFields.push(field);
          }
          if (row.score < existing.score) {
            existing.score = row.score;
            if (allowsSnippets && row.snippet_text) {
              existing.snippet = { field, text: row.snippet_text };
            }
          }
        } else {
          collapsed.set(key, {
            connectorId,
            connectorInstanceId: resolvedConnectorInstanceId,
            stream: entry.streamName,
            recordKey: row.record_key,
            emittedAt: row.emitted_at,
            authoredAt: authoredTimestampFromRecordJson(row.record_json),
            matchedFields: [field],
            ...(allowsSnippets && row.snippet_text
              ? { snippet: { field, text: row.snippet_text } }
              : {}),
            score: Number(row.score),
          });
        }
      }
    }
  }

  // Intra-connector relevance order
  const hits = Array.from(collapsed.values()).sort((a, b) => a.score - b.score);
  return hits;
}

function authoredTimestampFromRecordJson(recordJson) {
  if (!recordJson) return null;
  let data = recordJson;
  if (typeof recordJson === 'string') {
    try {
      data = JSON.parse(recordJson);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  for (const key of ['sent_at', 'sentAt', 'authored_at', 'authoredAt', 'created_at', 'createdAt', 'source_created_at', 'sourceCreatedAt', 'occurred_at', 'occurredAt', 'updated_at', 'updatedAt']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function buildFtsUserTextQuery(q) {
  const terms = String(q || '')
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return terms.length > 0 ? terms.join(' ') : '""';
}

function roundRobinMerge(perConnectorHits) {
  const merged = [];
  let idx = 0;
  let progress = true;
  while (progress) {
    progress = false;
    for (const list of perConnectorHits) {
      if (idx < list.length) {
        merged.push(list[idx]);
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

function generateSnapshotId() {
  return `snap_${randomBytes(8).toString('hex')}`;
}

function hashPlan({ perConnectorPlans, isOwner }) {
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

async function persistSnapshot(snapshot) {
  if (isPostgresStorageBackend()) {
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
      [snapshot.snapshot_id, snapshot.query, snapshot.plan_hash, JSON.stringify(snapshot.results)],
    );
    return;
  }

  exec(
    referenceQueries.searchSnapshotsInsert,
    [snapshot.snapshot_id, snapshot.query, snapshot.plan_hash, JSON.stringify(snapshot.results)],
  );
}

async function loadSnapshot(snapshotId) {
  if (isPostgresStorageBackend()) {
    const { rows } = await postgresQuery(
      `
      SELECT snapshot_id, query, plan_hash, results_json::text AS results_json, created_at
      FROM lexical_search_snapshots
      WHERE snapshot_id = $1
      `,
      [snapshotId],
    );
    return materializeSnapshot(rows[0]);
  }

  const row = getOne(referenceQueries.searchSnapshotsGetById, [snapshotId]);
  return materializeSnapshot(row);
}

function materializeSnapshot(row) {
  if (!row) return null;
  const createdAt = new Date(row.created_at + 'Z').getTime();
  if (Number.isFinite(createdAt) && Date.now() - createdAt > SNAPSHOT_TTL_MS) {
    return null;
  }
  return {
    snapshot_id: row.snapshot_id,
    query: row.query,
    plan_hash: row.plan_hash,
    results: JSON.parse(row.results_json),
  };
}
