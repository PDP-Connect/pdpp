/**
 * Lexical Retrieval Extension — implementation helper.
 *
 * Realizes the public `lexical-retrieval` capability defined in:
 *   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
 *
 * This module is the SINGLE enforcement path for `GET /v1/search`. The route
 * handler in index.js delegates to `runLexicalSearch` and does no parameter
 * parsing, mode branching, planning, FTS5 access, or snippet hydration of its
 * own. The dashboard (apps/web) reaches lexical retrieval through the same
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
import { getConnectorManifest } from './auth.js';
import { getDb } from './db.js';
import {
  compileRequestFilters,
  passesGrantRecordConstraints,
  passesRequestFilters,
} from './record-filters.js';

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
export async function lexicalIndexUpsert({ connectorId, stream, recordKey, data }) {
  const declared = await getStreamLexicalFields(connectorId, stream);
  if (!declared) return;

  const db = getDb();
  db.prepare(`
    DELETE FROM lexical_search_index
    WHERE connector_id = ? AND stream = ? AND record_key = ?
  `).run(connectorId, stream, recordKey);

  for (const field of declared) {
    const value = data?.[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    db.prepare(`
      INSERT INTO lexical_search_index(connector_id, stream, record_key, field, text)
      VALUES(?, ?, ?, ?, ?)
    `).run(connectorId, stream, recordKey, field, value);
  }
}

/**
 * Delete all FTS rows for a single record. Called on hard or soft delete.
 */
export async function lexicalIndexDelete({ connectorId, stream, recordKey }) {
  const db = getDb();
  db.prepare(`
    DELETE FROM lexical_search_index
    WHERE connector_id = ? AND stream = ? AND record_key = ?
  `).run(connectorId, stream, recordKey);
}

/**
 * Delete all FTS rows for an entire (connector_id, stream). Called on
 * deleteAllRecords (the owner-authenticated reset path).
 */
export async function lexicalIndexDeleteByConnectorStream({ connectorId, stream }) {
  const db = getDb();
  db.prepare(`
    DELETE FROM lexical_search_index
    WHERE connector_id = ? AND stream = ?
  `).run(connectorId, stream);
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
async function rebuildLexicalIndexForStream({ connectorId, stream, declaredFields, recordsToScan = null, progressJob = null }) {
  const db = getDb();
  db.prepare(`
    DELETE FROM lexical_search_index
    WHERE connector_id = ? AND stream = ?
  `).run(connectorId, stream);

  const insertStmt = db.prepare(`
    INSERT INTO lexical_search_index(connector_id, stream, record_key, field, text)
    VALUES(?, ?, ?, ?, ?)
  `);
  const insertRows = db.transaction((entries) => {
    for (const entry of entries) {
      insertStmt.run(connectorId, stream, entry.recordKey, entry.field, entry.text);
    }
  });

  // Stream the records page-by-page so we don't pull the whole table into
  // memory on big stores.
  const PAGE = 500;
  let lastId = 0;
  let scanned = 0;
  let indexed = 0;
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
      insertRows(entries);
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
 *   2. Row-count band (secondary). For streams whose fingerprint already
 *      matches, we still check that the indexed row count is in the
 *      expected band [1, recordCount * declaredFields.length] (or both
 *      zero). This catches degenerate cases like "manifest unchanged but
 *      index rows manually deleted" or "extension first enabled on a
 *      non-empty DB" without requiring a fingerprint comparison.
 *
 * Streams that previously participated but no longer declare
 * lexical_fields are also handled here: their stale index rows and meta
 * fingerprint are dropped so subsequent searches don't return ghost hits.
 *
 * Logging is via the optional `log` callback so tests can stay quiet.
 */
export async function lexicalIndexBackfillForManifest({ manifest, log = () => {} } = {}) {
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
  const db = getDb();

  // Track which streams we visited so we can detect "previously
  // participated, no longer participates" — those need their stale index
  // rows and meta fingerprint dropped.
  const visitedStreams = new Set();

  for (const mStream of manifest.streams) {
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
      const metaRows = db.prepare(`
        SELECT 1 FROM lexical_search_meta
        WHERE connector_id = ? AND stream = ?
      `).all(connectorId, stream);
      if (metaRows.length > 0) {
        log(`[PDPP] Lexical index: stream='${stream}' connector='${connectorId}' ` +
            `no longer declares lexical_fields — dropping stale index + meta`);
        db.prepare(`
          DELETE FROM lexical_search_index
          WHERE connector_id = ? AND stream = ?
        `).run(connectorId, stream);
        db.prepare(`
          DELETE FROM lexical_search_meta
          WHERE connector_id = ? AND stream = ?
        `).run(connectorId, stream);
      }
      continue;
    }
    progressJob = updateLexicalBackfillJob(progressJob, {
      stream,
      phase: 'checking',
      manifestStreamsChecked: Math.min(progressJob.manifestStreamsChecked + 1, progressJob.manifestStreamsTotal),
      recordsScanned: 0,
      recordsTotal: null,
      indexedRows: 0,
    });

    const newFingerprint = fingerprintLexicalFields(declaredFields);

    const metaRows = db.prepare(`
      SELECT fields_fingerprint
      FROM lexical_search_meta
      WHERE connector_id = ? AND stream = ?
    `).all(connectorId, stream);
    const persistedFingerprint = metaRows[0]?.fields_fingerprint ?? null;
    const fingerprintChanged = persistedFingerprint !== newFingerprint;

    let needsRebuild = fingerprintChanged;
    let recordCount = 0;
    let indexCount = 0;
    let upperBound = 0;

    const countRecords = () => {
      const row = db.prepare(`
        SELECT COUNT(*) AS n
        FROM records
        WHERE connector_id = ? AND stream = ? AND deleted = 0
      `).get(connectorId, stream);
      return Number(row?.n || 0);
    };

    if (!needsRebuild) {
      // Fingerprint matches — fall back to the row-count band check for
      // degenerate cases. This is cheap and catches "index rows missing
      // for a stream that has records" without re-reading the records.
      recordCount = countRecords();

      const indexCountRows = db.prepare(`
        SELECT COUNT(*) AS n
        FROM lexical_search_index
        WHERE connector_id = ? AND stream = ?
      `).all(connectorId, stream);
      indexCount = Number(indexCountRows[0]?.n || 0);

      upperBound = recordCount * declaredFields.length;
      const inSync =
        recordCount === 0
          ? indexCount === 0
          : indexCount > 0 && indexCount <= upperBound;
      needsRebuild = !inSync;
    }

    if (!needsRebuild) continue;
    if (recordCount === 0) {
      recordCount = countRecords();
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
          `(records=${recordCount}, index=${indexCount}, expected ≤ ${upperBound}) — rebuilding`);
    }

    const indexedRows = await rebuildLexicalIndexForStream({
      connectorId,
      stream,
      declaredFields,
      recordsToScan: recordCount,
      progressJob,
    });
    log(`[PDPP] Lexical index rebuild completed for ${connectorId} stream='${stream}' ` +
        `(records=${recordCount}, indexed_rows=${indexedRows})`);

    // Persist the new fingerprint so subsequent backfill calls can skip.
    db.prepare(`
      INSERT INTO lexical_search_meta(connector_id, stream, fields_fingerprint, updated_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(connector_id, stream) DO UPDATE SET
        fields_fingerprint = excluded.fields_fingerprint,
        updated_at = excluded.updated_at
    `).run(connectorId, stream, newFingerprint, new Date().toISOString());
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
  const orphanRows = db.prepare(`
    SELECT stream
    FROM lexical_search_meta
    WHERE connector_id = ?
  `).all(connectorId);
  for (const row of orphanRows) {
    if (visitedStreams.has(row.stream)) continue;
    log(`[PDPP] Lexical index: stream='${row.stream}' connector='${connectorId}' ` +
        `no longer in manifest — dropping stale index + meta`);
    db.prepare(`
      DELETE FROM lexical_search_index
      WHERE connector_id = ? AND stream = ?
    `).run(connectorId, row.stream);
    db.prepare(`
      DELETE FROM lexical_search_meta
      WHERE connector_id = ? AND stream = ?
    `).run(connectorId, row.stream);
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
}) {
  // 1. Strict parameter allowlist
  const params = parseSearchParams(req.query);

  // 2. Cross-stream advertisement check (if opts say cross_stream is false,
  //    streams[] becomes mandatory).
  const advertisement = resolveLexicalRetrievalAdvertisement(opts);
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

  // 3. Per-mode planning
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
        // Skip connectors whose manifest cannot be resolved. The owner can
        // still read the others; one broken connector should not break the
        // whole search.
        continue;
      }
      const grant = buildOwnerReadGrantForManifest(manifest);
      const compiledFilter = compileSingleStreamSearchFilter({
        manifest,
        grant,
        streamName: params.filteredStream,
        filter: params.filter,
      });
      const planEntries = buildSearchPlanForGrant({
        manifest,
        grant,
        streamsFilter: params.streams,
        compiledFilter,
        connectorId,
      });
      if (planEntries.length === 0) continue;
      perConnectorPlans.push({ connectorId, manifest, grant, planEntries });
    }
    // Owner-mode streams[] is a soft filter: unknown stream names just
    // produce zero hits. Per the patched approved spec.
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

    const planEntries = buildSearchPlanForGrant({
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

  // 4. Resolve cursor → snapshot. New cursor: build snapshot, persist it.
  let snapshotId;
  let snapshot;
  if (params.cursor) {
    const decoded = decodeSearchCursor(params.cursor);
    if (!decoded) {
      const err = new Error('Cursor is malformed');
      err.code = 'invalid_cursor';
      throw err;
    }
    snapshotId = decoded.snap;
    snapshot = await loadSnapshot(snapshotId);
    if (!snapshot) {
      const err = new Error('Cursor refers to an expired or unknown snapshot');
      err.code = 'invalid_cursor';
      throw err;
    }
  } else {
    snapshot = await buildSnapshot({
      q: params.q,
      perConnectorPlans,
      isOwner,
    });
    snapshotId = snapshot.snapshot_id;
    await persistSnapshot(snapshot);
  }

  // 5. Slice the snapshot
  const offset = params.cursor
    ? (decodeSearchCursor(params.cursor)?.off ?? 0)
    : 0;
  const limit = params.limit;
  const allHits = snapshot.results;
  const slice = allHits.slice(offset, offset + limit);
  const hasMore = offset + limit < allHits.length;
  const nextCursor = hasMore
    ? encodeSearchCursor({ snap: snapshotId, off: offset + limit })
    : null;

  // 6. Shape into search_result objects. Scores are public only when the
  // metadata advertisement says this server emits them.
  const emitScore = advertisesScore(advertisement);
  const data = slice.map((hit) => buildSearchResult({ hit, isOwner, emitScore }));

  return {
    envelope: {
      object: 'list',
      url: '/v1/search',
      has_more: hasMore,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      data,
    },
    disclosureData: {
      query_shape: 'search',
      record_count: data.length,
      has_more: hasMore,
      mode: isOwner ? 'owner' : 'client',
      connector_count: perConnectorPlans.length,
    },
  };
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

const ALLOWED_PARAMS = new Set(['q', 'limit', 'cursor', 'streams', 'streams[]', 'filter']);

/**
 * Parse and validate the v1 query-string allowlist.
 *
 * Throws invalid_request with `param` set to the rejected key.
 */
export function parseSearchParams(query) {
  for (const key of Object.keys(query)) {
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
    const err = new Error('filter[...] requires exactly one streams[] value');
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

export function buildSearchPlanForGrant({ manifest, grant, streamsFilter, compiledFilter = null, connectorId = null }) {
  if (!manifest?.streams || !grant?.streams) return [];
  const plan = [];
  for (const mStream of manifest.streams) {
    const declared = mStream?.query?.search?.lexical_fields;
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
      ...(candidateRecordKeys ? { candidateRecordKeys } : {}),
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

function advertisesScore(advertisement) {
  return !!(
    advertisement
    && advertisement.supported !== false
    && advertisement.score?.supported === true
    && advertisement.score.kind === 'bm25'
    && advertisement.score.order === 'lower_is_better'
  );
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
    perConnectorPlans.map(async ({ connectorId, planEntries }) =>
      runFtsQueryForConnector({ connectorId, planEntries, q, allowsSnippets })
    ),
  );

  // Round-robin merge across connectors, preserving each connector's
  // intra-list relevance order.
  const merged = roundRobinMerge(perConnectorHits);

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
async function runFtsQueryForConnector({ connectorId, planEntries, q, allowsSnippets }) {
  const db = getDb();
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
  const collapsed = new Map(); // recordKey → { connectorId, stream, recordKey, emittedAt, matchedFields, snippet?, score }

  for (const entry of planEntries) {
    if (Array.isArray(entry.candidateRecordKeys) && entry.candidateRecordKeys.length === 0) continue;
    for (const field of entry.searchableFields) {
      // bm25(lexical_search_index) returns smaller values for better matches
      // (negative-leaning). The public score exposes that implementation-
      // relative ordering honestly rather than normalizing it.
      const snippetExpr = allowsSnippets
        ? `snippet(lexical_search_index, 4, '', '', '…', 16)`
        : `NULL`;
      const recordKeyConstraint = Array.isArray(entry.candidateRecordKeys)
        ? `AND r.record_key IN (${entry.candidateRecordKeys.map(() => '?').join(',')})`
        : '';
      const rows = db.prepare(`
        SELECT
          lsi.record_key                          AS record_key,
          ${snippetExpr}                          AS snippet_text,
          bm25(lexical_search_index)              AS score,
          r.emitted_at                            AS emitted_at,
          r.deleted                               AS deleted
        FROM lexical_search_index lsi
        JOIN records r
          ON r.connector_id = lsi.connector_id
         AND r.stream       = lsi.stream
         AND r.record_key   = lsi.record_key
        WHERE lsi.connector_id = ?
          AND lsi.stream       = ?
          AND lsi.field        = ?
          AND lsi.text MATCH   ?
          AND r.deleted = 0
          ${recordKeyConstraint}
        ORDER BY score ASC
        LIMIT 200
      `).all(connectorId, entry.streamName, field, ftsQuery, ...(entry.candidateRecordKeys || []));
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
            stream: entry.streamName,
            recordKey: row.record_key,
            emittedAt: row.emitted_at,
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

// ─── search_result shaping ─────────────────────────────────────────────────

function buildSearchResult({ hit, isOwner, emitScore }) {
  const recordPath = `/v1/streams/${encodeURIComponent(hit.stream)}/records/${encodeURIComponent(hit.recordKey)}`;
  const recordUrl = isOwner
    ? `${recordPath}?connector_id=${encodeURIComponent(hit.connectorId)}`
    : recordPath;
  const result = {
    object: 'search_result',
    stream: hit.stream,
    record_key: hit.recordKey,
    connector_id: hit.connectorId,
    record_url: recordUrl,
    emitted_at: hit.emittedAt,
    matched_fields: hit.matchedFields,
  };
  if (emitScore && Number.isFinite(hit.score)) {
    result.score = {
      kind: 'bm25',
      value: hit.score,
      order: 'lower_is_better',
    };
  }
  if (hit.snippet) result.snippet = hit.snippet;
  return result;
}

// ─── Snapshot persistence + cursor encoding ────────────────────────────────

const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateSnapshotId() {
  return `snap_${randomBytes(8).toString('hex')}`;
}

function hashPlan({ perConnectorPlans, isOwner }) {
  // Cheap stable hash; only used to sanity-check snapshot reuse.
  const summary = perConnectorPlans.map((p) => ({
    c: p.connectorId,
    e: p.planEntries.map((pe) => ({ s: pe.streamName, f: pe.searchableFields.slice().sort() })),
  }));
  return JSON.stringify({ isOwner, summary });
}

async function persistSnapshot(snapshot) {
  const db = getDb();
  db.prepare(`
    INSERT INTO lexical_search_snapshots(snapshot_id, query, plan_hash, results_json)
    VALUES(?, ?, ?, ?)
  `).run(snapshot.snapshot_id, snapshot.query, snapshot.plan_hash, JSON.stringify(snapshot.results));
}

async function loadSnapshot(snapshotId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT snapshot_id, query, plan_hash, results_json, created_at
    FROM lexical_search_snapshots
    WHERE snapshot_id = ?
  `).all(snapshotId);
  if (rows.length === 0) return null;
  const row = rows[0];
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

function encodeSearchCursor({ snap, off }) {
  const json = JSON.stringify({ snap, off });
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeSearchCursor(cursor) {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (typeof parsed.snap !== 'string' || typeof parsed.off !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}
