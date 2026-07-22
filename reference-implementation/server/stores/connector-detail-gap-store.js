// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from '../../lib/db.ts';
import { DEFAULT_QUARANTINE_POLICY } from '../../runtime/recovery-quarantine.ts';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../owner-auth.ts';
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from '../postgres-storage.js';
import { makeDefaultAccountConnectorInstanceId } from './connector-instance-store.js';

const VALID_STATUSES = new Set(['pending', 'in_progress', 'recovered', 'terminal']);
const SECRET_KEY_PATTERN = /(authorization|bearer|cookie|token|secret|password|credential|request_body|body|payload|raw|private)/i;
const URL_KEY_PATTERN = /(url|uri|href|endpoint)/i;
const MAX_STRING_LENGTH = 300;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 5;
const PENDING_GAP_ROTATION_WINDOW_SECONDS = 15 * 60;
const PENDING_GAP_MAX_AGE_BUCKETS = 8;
// A row's own `attempt_count` term in the selection rank is clamped at the
// quarantine no-progress threshold. The age bonus is capped at
// `PENDING_GAP_MAX_AGE_BUCKETS`, so without this clamp a row served past the
// threshold keeps climbing `attempt_count` on every re-defer and its rank
// gets strictly worse forever — permanently sinking it behind the rest of
// the backlog. Once starved that way it is never selected again, so it can
// never reach `maybeQuarantineGap` (runtime/recovery-quarantine.ts) either,
// which only evaluates a row when it IS selected and re-defers. Clamping the
// attempt_count term at the SAME threshold quarantine uses means a row can
// never rank worse than a fresh threshold-attempt row: once it ages back to
// the front (the same mechanism that already rescues old rows from a
// fresh-arrival flood), it is selected once more and either recovers or
// crosses the quarantine threshold and terminalizes. This only ever raises
// (never lowers) the effective rank of a row already past its no-progress
// budget — ordering for every row under the threshold is unaffected.
const PENDING_GAP_ATTEMPT_RANK_CLAMP = DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts;
const SAFE_ROUTE_TEMPLATE_KEY_PATTERN = /^(endpoint_route|route_template)$/i;
const SAFE_ROUTE_TEMPLATE_PATTERN = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[A-Za-z0-9._~!$&'()*+,;=:@/%{}-]+$/;

function nowIso() {
  return new Date().toISOString();
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hashIdentity(parts) {
  return `gap_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

/**
 * The stable natural-identity component that distinguishes one detail gap from
 * another WITHIN a `(connector_instance_id, grant_id, stream, parent_stream)`
 * scope.
 *
 * When a `record_key` is present it is the identity — the `detail_locator_json`
 * is deliberately excluded because the locator SHAPE is volatile (connectors
 * add fields like `order_date` over time). Hashing the whole locator into
 * identity meant a locator-schema change minted a NEW identity for the SAME
 * record, orphaning the old-shape pending row so it could never be closed when
 * the record was later recovered under the new shape.
 *
 * When `record_key` is absent the locator text is the only disambiguator, so it
 * is retained. BOTH branches are namespaced with a disjoint prefix (`key:` vs
 * `loc:`) so a record_key whose literal value starts with `loc:` can never
 * collide with a locator-only gap (and vice versa).
 *
 * The value is `NULLIF`-normalized so a NULL/empty `record_key` is never a
 * uniqueness loophole. The DB identity index applies the same branch logic; for
 * locator-only JSON, storage-backend JSON text canonicalization remains the
 * uniqueness authority.
 */
export function detailGapIdentityKey(recordKey, detailLocatorText) {
  const key = nonEmptyString(recordKey);
  if (key) return `key:${key}`;
  return `loc:${detailLocatorText == null ? '' : detailLocatorText}`;
}

function defaultConnectorInstanceId(connectorId) {
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

function safeUrlSummary(value) {
  try {
    const parsed = new URL(value);
    return {
      scheme: parsed.protocol.replace(/:$/, ''),
      host: parsed.hostname,
      path_hash: createHash('sha256').update(parsed.pathname || '/').digest('hex').slice(0, 16),
    };
  } catch {
    return '[redacted-url]';
  }
}

function isSafeRouteTemplate(value, keyName) {
  return SAFE_ROUTE_TEMPLATE_KEY_PATTERN.test(keyName)
    && SAFE_ROUTE_TEMPLATE_PATTERN.test(value)
    && !value.includes('?')
    && !value.includes('#')
    && !value.includes('//');
}

function isSimpleMetadataValue(value) {
  return value == null || typeof value === 'boolean' || typeof value === 'number';
}

function sanitizeStringMetadata(value, keyName) {
  if (isSafeRouteTemplate(value, keyName)) return value;
  if (/^https?:\/\//i.test(value) || URL_KEY_PATTERN.test(keyName)) return safeUrlSummary(value);
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH - 1)}…` : value;
}

function sanitizeArrayMetadata(value, depth, keyName) {
  return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeDetailGapMetadata(entry, depth + 1, keyName));
}

function sanitizeObjectMetadata(value, depth) {
  const out = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizeDetailGapMetadata(entry, depth + 1, key);
  }
  return out;
}

export function sanitizeDetailGapMetadata(value, depth = 0, keyName = '') {
  if (isSimpleMetadataValue(value)) return value;
  if (typeof value === 'string') return sanitizeStringMetadata(value, keyName);
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return sanitizeArrayMetadata(value, depth, keyName);
  if (typeof value !== 'object') return null;
  return sanitizeObjectMetadata(value, depth);
}

function encodeJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  return JSON.parse(value);
}

function deriveGapIdentity(input) {
  const connectorId = nonEmptyString(input?.connectorId);
  const connectorInstanceId = nonEmptyString(input?.connectorInstanceId) || (connectorId ? defaultConnectorInstanceId(connectorId) : null);
  const stream = nonEmptyString(input?.stream);
  if (!connectorId) throw new Error('connector detail gap requires connectorId');
  if (!connectorInstanceId) throw new Error('connector detail gap requires connectorInstanceId');
  if (!stream) throw new Error('connector detail gap requires stream');
  return { connectorId, connectorInstanceId, stream };
}

function deriveGapId(input, connectorInstanceId, grantId, stream, parentStream, recordKey, detailLocator) {
  // Identity intentionally EXCLUDES the volatile locator when a record_key is
  // present (see `detailGapIdentityKey`), so a locator-schema change (e.g. a
  // connector adding `order_date`) re-upserts the SAME identity instead of
  // orphaning the old-shape pending row.
  const identityKey = detailGapIdentityKey(recordKey, encodeJson(detailLocator));
  return input.gapId || hashIdentity([connectorInstanceId, grantId || '', stream, parentStream || '', identityKey]);
}

function normalizeGapMetadata(input, connectorId) {
  return {
    source: sanitizeDetailGapMetadata(input.source || { kind: 'connector', id: connectorId }),
    detailLocator: sanitizeDetailGapMetadata(input.detailLocator ?? null),
    listCursor: sanitizeDetailGapMetadata(input.listCursor ?? null),
    scope: sanitizeDetailGapMetadata(input.scope ?? null),
    lastError: sanitizeDetailGapMetadata(input.lastError ?? null),
  };
}

function normalizeGapInput(input) {
  const { connectorId, connectorInstanceId, stream } = deriveGapIdentity(input);
  const metadata = normalizeGapMetadata(input, connectorId);
  const grantId = nonEmptyString(input.grantId);
  const parentStream = nonEmptyString(input.parentStream);
  const recordKey = input.recordKey == null ? null : String(input.recordKey);
  const reason = nonEmptyString(input.reason) || null;
  const now = input.now || nowIso();
  const gapId = deriveGapId(input, connectorInstanceId, grantId, stream, parentStream, recordKey, metadata.detailLocator);

  return {
    gapId,
    connectorId,
    connectorInstanceId,
    grantId,
    source: metadata.source,
    stream,
    parentStream,
    recordKey,
    detailLocator: metadata.detailLocator,
    listCursor: metadata.listCursor,
    scope: metadata.scope,
    reason,
    lastError: metadata.lastError,
    discoveredRunId: nonEmptyString(input.discoveredRunId),
    lastRunId: nonEmptyString(input.lastRunId) || nonEmptyString(input.discoveredRunId),
    nextAttemptAfter: nonEmptyString(input.nextAttemptAfter),
    now,
  };
}

function nullableGapRowValue(value) {
  return value ?? null;
}

function rowToGap(row) {
  if (!row) return null;
  return {
    gap_id: row.gap_id,
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id,
    grant_id: nullableGapRowValue(row.grant_id),
    source: parseJson(row.source_json),
    stream: row.stream,
    parent_stream: nullableGapRowValue(row.parent_stream),
    record_key: nullableGapRowValue(row.record_key),
    detail_locator: parseJson(row.detail_locator_json),
    list_cursor: parseJson(row.list_cursor_json),
    scope: parseJson(row.scope_json),
    reason: nullableGapRowValue(row.reason),
    status: row.status,
    attempt_count: row.attempt_count,
    last_attempt_at: nullableGapRowValue(row.last_attempt_at),
    next_attempt_after: nullableGapRowValue(row.next_attempt_after),
    last_error: parseJson(row.last_error_json),
    discovered_run_id: nullableGapRowValue(row.discovered_run_id),
    last_run_id: nullableGapRowValue(row.last_run_id),
    recovered_run_id: nullableGapRowValue(row.recovered_run_id),
    lease_run_id: nullableGapRowValue(row.lease_run_id),
    lease_id: nullableGapRowValue(row.lease_id),
    lease_attempted: Number(row.lease_attempted || 0) === 1,
    lease_expires_at: nullableGapRowValue(row.lease_expires_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function firstSqliteRow(sql, params = []) {
  for (const row of iterateDynamicSqlAcknowledged(sql, params)) {
    return row;
  }
  return null;
}

/**
 * Coerce a SQL `COUNT(*)` scalar into a finite non-negative integer. SQLite
 * returns it as a JS number; the Postgres `pg` driver returns a `bigint` as a
 * string. A NaN / negative / unparseable value throws so the caller can keep
 * the optional `recovered` rollup `null` (unmeasured) rather than surface a
 * fabricated count.
 */
function coerceCount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`connector detail gap count is not a non-negative integer: ${String(value)}`);
  }
  return Math.floor(n);
}

/**
 * Normalize the reason list for a reason-scoped count. Returns a de-duped array
 * of non-empty strings, or `null` when no usable reason is supplied (the caller
 * treats `null` as "no reason scope" and counts every reason).
 */
function normalizeReasonScope(reasons) {
  if (!Array.isArray(reasons)) return null;
  const out = [...new Set(reasons.filter((reason) => typeof reason === 'string' && reason))];
  return out.length ? out : null;
}

function normalizeStreamScope(streams) {
  if (!Array.isArray(streams)) return null;
  const out = [...new Set(streams.filter((stream) => typeof stream === 'string' && stream))];
  return out.length ? out : null;
}

function normalizeGapMutationLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return 100;
  return Math.max(1, Math.min(Math.floor(n), 500));
}

function assertValidGapStatus(status) {
  if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported connector detail gap status: ${status}`);
}

function optionalSqlPlaceholders(values) {
  return values?.length ? values.map(() => '?').join(', ') : null;
}

// `NULLIF(last_attempt_at, '')` normalizes an empty-string last_attempt_at to
// NULL before the COALESCE fallback to created_at, on BOTH engines. Not
// reachable today (last_attempt_at is only ever NULL or a non-empty ISO
// string — see the `options.now || nowIso()` writes in markGapStatus), but an
// engine-specific empty-string special-case would otherwise be a silent trap:
// SQLite's bare COALESCE treats '' as a real (non-NULL) value and ages from
// epoch 1970, while Postgres's NULLIF'd COALESCE falls back to created_at.
function pendingGapOrderBySql(isPostgres) {
  if (isPostgres) {
    return `
        (
          LEAST(attempt_count, ${PENDING_GAP_ATTEMPT_RANK_CLAMP}) - LEAST(
            ${PENDING_GAP_MAX_AGE_BUCKETS},
            COALESCE(
              FLOOR(EXTRACT(EPOCH FROM ($4::timestamptz - COALESCE(NULLIF(last_attempt_at, ''), created_at)::timestamptz)) / ${PENDING_GAP_ROTATION_WINDOW_SECONDS}),
              0
            )
          )
        ),
        COALESCE(NULLIF(last_attempt_at, ''), created_at),
        gap_id
      `;
  }
  return `
        (
          MIN(attempt_count, ${PENDING_GAP_ATTEMPT_RANK_CLAMP}) - MIN(
            ${PENDING_GAP_MAX_AGE_BUCKETS},
            COALESCE(
              CAST((unixepoch(?) - unixepoch(COALESCE(NULLIF(last_attempt_at, ''), created_at))) / ${PENDING_GAP_ROTATION_WINDOW_SECONDS} AS INTEGER),
              0
            )
          )
        ),
        COALESCE(NULLIF(last_attempt_at, ''), created_at),
        gap_id
      `;
}

function normalizePendingGapScope(rawInput, connectorId, grantId, streams, limit, now) {
  const connectorInstanceId = nonEmptyString(rawInput?.connectorInstanceId) || defaultConnectorInstanceId(connectorId);
  const eligibleAt = nonEmptyString(now) || nowIso();
  const streamList = Array.isArray(streams)
    ? streams.filter((stream) => typeof stream === 'string' && stream)
    : null;
  return {
    connectorInstanceId,
    connectorId,
    grantId,
    eligibleAt,
    streamList,
    limit: Math.max(1, Math.min(limit, 500)),
  };
}

function normalizeGapStatusMutation(gapId, status, options) {
  assertValidGapStatus(status);
  const now = options.now || nowIso();
  const attemptDelta = status === 'in_progress' ? 1 : 0;
  const recoveredRunId = status === 'recovered' ? nonEmptyString(options.runId) : null;
  const reason = nonEmptyString(options.reason);
  return {
    gapId,
    status,
    now,
    attemptDelta,
    recoveredRunId,
    reason,
    nextAttemptAfter: nonEmptyString(options.nextAttemptAfter),
    lastErrorJson: encodeJson(sanitizeDetailGapMetadata(options.lastError ?? null)),
    runId: nonEmptyString(options.runId),
  };
}

function normalizeLease(lease) {
  const gapId = nonEmptyString(lease?.gapId);
  const runId = nonEmptyString(lease?.runId);
  const leaseId = nonEmptyString(lease?.leaseId);
  if (!gapId || !runId || !leaseId) {
    throw new Error('detail-gap lease requires gapId, runId, and leaseId');
  }
  return { gapId, runId, leaseId };
}

function requeueReasonForQuarantinedGap(gap) {
  const previousReason = nonEmptyString(gap?.last_error?.reason);
  if (
    previousReason === 'retry_exhausted'
    || previousReason === 'temporary_unavailable'
    || previousReason === 'run_cap_deferred'
  ) {
    return previousReason;
  }
  return 'temporary_unavailable';
}

function buildQuarantineRetryLastError(gap, now) {
  const prior = gap?.last_error && typeof gap.last_error === 'object' ? gap.last_error : {};
  return sanitizeDetailGapMetadata({
    class: 'quarantine_retry_requested',
    previous_class: typeof prior.class === 'string' ? prior.class : null,
    previous_failure_class: typeof prior.failure_class === 'string' ? prior.failure_class : null,
    previous_reason: gap?.reason ?? null,
    requeued_at: now,
  });
}

function normalizeQuarantinedRequeueScope(connectorId, connectorInstanceId, options = {}) {
  const cid = nonEmptyString(connectorId);
  if (!cid) throw new Error('requeueQuarantinedTerminalGapsForConnectorInstance requires connectorId');
  return {
    connectorId: cid,
    connectorInstanceId: nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(cid),
    limit: normalizeGapMutationLimit(options.limit),
    now: nonEmptyString(options.now) || nowIso(),
    streams: normalizeStreamScope(options.streams),
  };
}

function sqliteQuarantinedRequeueRows(scope) {
  const streamPlaceholders = optionalSqlPlaceholders(scope.streams);
  // REVIEWED-DYNAMIC: bounded repair selection for terminal quarantined
  // detail gaps. Only non-payload row metadata is read and the caller must
  // scope by one connector instance; terminal rows are never blanket-reset.
  return [...iterateDynamicSqlAcknowledged(`
    SELECT * FROM connector_detail_gaps
    WHERE connector_id = ?
      AND connector_instance_id = ?
      AND status = 'terminal'
      AND reason = 'quarantined'
      ${streamPlaceholders ? `AND stream IN (${streamPlaceholders})` : ''}
    ORDER BY updated_at, created_at
    LIMIT ?
  `, [scope.connectorId, scope.connectorInstanceId, ...(scope.streams ?? []), scope.limit])].map(rowToGap);
}

function requeueSqliteQuarantinedRows(rows, scope) {
  let requeued = 0;
  for (const gap of rows) {
    // REVIEWED-DYNAMIC: scoped status reset for operator-approved retry of
    // quarantined no-progress detail gaps after a connector/runtime fix.
    const result = execDynamicSqlAcknowledged(`
      UPDATE connector_detail_gaps
      SET status = 'pending',
          reason = ?,
          attempt_count = 0,
          last_attempt_at = NULL,
          next_attempt_after = NULL,
          last_error_json = ?,
          updated_at = ?
      WHERE gap_id = ?
        AND connector_id = ?
        AND connector_instance_id = ?
        AND status = 'terminal'
        AND reason = 'quarantined'
    `, [
      requeueReasonForQuarantinedGap(gap),
      encodeJson(buildQuarantineRetryLastError(gap, scope.now)),
      scope.now,
      gap.gap_id,
      scope.connectorId,
      scope.connectorInstanceId,
    ]);
    requeued += Number(result.changes || 0);
  }
  return { matched: rows.length, requeued };
}

async function postgresQuarantinedRequeueRows(scope) {
  const result = await postgresQuery(`
    SELECT * FROM connector_detail_gaps
    WHERE connector_id = $1
      AND connector_instance_id = $2
      AND status = 'terminal'
      AND reason = 'quarantined'
      AND ($3::text[] IS NULL OR stream = ANY($3::text[]))
    ORDER BY updated_at, created_at
    LIMIT $4
  `, [scope.connectorId, scope.connectorInstanceId, scope.streams, scope.limit]);
  return result.rows.map(rowToGap);
}

async function requeuePostgresQuarantinedRows(rows, scope) {
  let requeued = 0;
  for (const gap of rows) {
    const updated = await postgresQuery(`
      UPDATE connector_detail_gaps
      SET status = 'pending',
          reason = $1,
          attempt_count = 0,
          last_attempt_at = NULL,
          next_attempt_after = NULL,
          last_error_json = $2::jsonb,
          updated_at = $3
      WHERE gap_id = $4
        AND connector_id = $5
        AND connector_instance_id = $6
        AND status = 'terminal'
        AND reason = 'quarantined'
    `, [
      requeueReasonForQuarantinedGap(gap),
      encodeJson(buildQuarantineRetryLastError(gap, scope.now)),
      scope.now,
      gap.gap_id,
      scope.connectorId,
      scope.connectorInstanceId,
    ]);
    requeued += Number(updated.rowCount || 0);
  }
  return { matched: rows.length, requeued };
}

export function createSqliteConnectorDetailGapStore() {
  return {
    async upsertPendingGap(input) {
      const gap = normalizeGapInput(input);
      const detailLocatorJson = encodeJson(gap.detailLocator);
      // REVIEWED-DYNAMIC: connector_detail_gaps is owned by this store and
      // not yet represented in the static query registry.
      execDynamicSqlAcknowledged(`
        INSERT INTO connector_detail_gaps(
          gap_id, connector_id, connector_instance_id, grant_id, source_json, stream, parent_stream, record_key,
          detail_locator_json, list_cursor_json, scope_json, reason, status, attempt_count,
          next_attempt_after, last_error_json, discovered_run_id, last_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(gap_id) DO UPDATE SET
          source_json = excluded.source_json,
          detail_locator_json = excluded.detail_locator_json,
          list_cursor_json = excluded.list_cursor_json,
          scope_json = excluded.scope_json,
          reason = excluded.reason,
          -- §10-A: 'terminal' is always sticky — a terminalized gap must not be
          -- silently resurrected into the fillable-pending set by a re-upsert.
          -- 'recovered' is sticky ONLY against a re-upsert from the SAME run
          -- that recovered it (an ordinary-forward-pass re-defer with no new
          -- attempt evidence, per the original §10-A regression) — i.e. a
          -- NON-NULL 'recovered_run_id' that matches 'excluded.last_run_id'
          -- exactly. A NULL 'recovered_run_id' (a run-id-less recovery, e.g.
          -- the local-collector policy-budget path in
          -- 'ref-device-exporters.ts:recoverLocalCollectorGap', which marks a
          -- gap recovered with '{}' — no spine run backs it) carries no
          -- same-attempt context to compare against, so SQL's 'NULL = x'
          -- already evaluates false/unmatched for every 'x' here — the row is
          -- NEVER treated as a same-attempt re-defer and always reopens on the
          -- next re-upsert. Do not special-case NULL as a stickiness
          -- wildcard: an earlier revision did 'recovered_run_id IS NULL OR
          -- ...', which made every run-id-less recovery sticky FOREVER
          -- (P1 review finding, reproduced locally: a gap recovered via
          -- 'markGapStatus(id, 'recovered', {})' never reopened on a later
          -- 'upsertPendingGap' with a real 'lastRunId') — the exact opposite
          -- of the reopen-on-later-evidence rule this fix exists to enforce.
          -- A re-upsert from a LATER run (or ANY re-upsert of a null-run-id
          -- recovery) reopens the row to 'pending': the connector is
          -- reporting, with fresh attempt evidence, that a previously-closed
          -- record is missing again — treating that as permanently satisfied
          -- silently strands it outside both the pending-retry queue and the
          -- quarantine escalation path forever (live Amazon order_items
          -- evidence: 12 order ids stuck 'recovered' while DETAIL_COVERAGE
          -- reported them uncovered on every run for weeks).
          status = CASE
            WHEN connector_detail_gaps.status = 'terminal' THEN 'terminal'
            WHEN connector_detail_gaps.status = 'recovered'
              AND connector_detail_gaps.recovered_run_id = excluded.last_run_id
              THEN 'recovered'
            ELSE 'pending'
          END,
          next_attempt_after = excluded.next_attempt_after,
          last_error_json = excluded.last_error_json,
          last_run_id = excluded.last_run_id,
          updated_at = excluded.updated_at
        -- Identity conflict target = the natural key, with the volatile locator
        -- dropped when a record_key exists (see detailGapIdentityKey). This is
        -- what closes the locator-drift orphan class: a re-discovery under a new
        -- locator shape re-upserts the SAME row instead of inserting a duplicate.
        ON CONFLICT(connector_instance_id, ifnull(grant_id, ''), stream, ifnull(parent_stream, ''), CASE WHEN nullif(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || ifnull(detail_locator_json, '') END) DO UPDATE SET
          source_json = excluded.source_json,
          detail_locator_json = excluded.detail_locator_json,
          list_cursor_json = excluded.list_cursor_json,
          scope_json = excluded.scope_json,
          reason = excluded.reason,
          -- §10-A: see the mirrored ON CONFLICT(gap_id) branch above for the
          -- reopen-on-later-run rationale and the NULL-recovered_run_id
          -- non-wildcard rule (a run-id-less recovery is never same-attempt).
          status = CASE
            WHEN connector_detail_gaps.status = 'terminal' THEN 'terminal'
            WHEN connector_detail_gaps.status = 'recovered'
              AND connector_detail_gaps.recovered_run_id = excluded.last_run_id
              THEN 'recovered'
            ELSE 'pending'
          END,
          next_attempt_after = excluded.next_attempt_after,
          last_error_json = excluded.last_error_json,
          last_run_id = excluded.last_run_id,
          updated_at = excluded.updated_at
      `, [
        gap.gapId,
        gap.connectorId,
        gap.connectorInstanceId,
        gap.grantId,
        encodeJson(gap.source),
        gap.stream,
        gap.parentStream,
        gap.recordKey,
        detailLocatorJson,
        encodeJson(gap.listCursor),
        encodeJson(gap.scope),
        gap.reason,
        gap.nextAttemptAfter,
        encodeJson(gap.lastError),
        gap.discoveredRunId,
        gap.lastRunId,
        gap.now,
        gap.now,
      ]);
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned detail-gap table.
      // Look up by the identity expression (NOT the locator): on a locator-drift
      // re-upsert the stored row updates to the newer locator shape, so a
      // locator-based lookup against the old shape would miss.
      return rowToGap(firstSqliteRow(`
        SELECT * FROM connector_detail_gaps
        WHERE connector_instance_id = ?
          AND ifnull(grant_id, '') = ?
          AND stream = ?
          AND ifnull(parent_stream, '') = ?
          AND CASE WHEN nullif(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || ifnull(detail_locator_json, '') END = ?
        LIMIT 1
      `, [
        gap.connectorInstanceId,
        gap.grantId || '',
        gap.stream,
        gap.parentStream || '',
        detailGapIdentityKey(gap.recordKey, detailLocatorJson),
      ]));
    },

    async listPendingGaps({ connectorId, grantId = null, streams = null, limit = 100, now = nowIso() } = {}) {
      const scope = normalizePendingGapScope(arguments[0], connectorId, grantId, streams, limit, now);
      const streamPlaceholders = optionalSqlPlaceholders(scope.streamList);
      // REVIEWED-DYNAMIC: bounded pending-gap recovery selection over the
      // store-owned table. The order rotates with age: newer zero-attempt
      // work stays near the front, but older eligible rows gain priority over
      // time so a steady stream of fresh work cannot starve already-waiting
      // gaps. `next_attempt_after` still gates eligibility before the order
      // applies.
      const rows = [...iterateDynamicSqlAcknowledged(`
        SELECT * FROM connector_detail_gaps
        WHERE connector_instance_id = ?
          AND connector_id = ?
          AND (? IS NULL OR grant_id = ?)
          AND status = 'pending'
          AND (next_attempt_after IS NULL OR next_attempt_after <= ?)
          ${streamPlaceholders ? `AND stream IN (${streamPlaceholders})` : ''}
        ORDER BY ${pendingGapOrderBySql(false)}
        LIMIT ?
      `, [scope.connectorInstanceId, scope.connectorId, scope.grantId, scope.grantId, scope.eligibleAt, ...(scope.streamList ?? []), scope.eligibleAt, scope.limit])];
      return rows.map(rowToGap);
    },

    // Diagnostic listing across all connector instances for a connector type.
    // Used by the operator-console projection so per-source-instance gaps
    // (e.g. one device per local Codex install) are not silently dropped
    // when the projection has no single instance to filter by.
    async listPendingGapsForConnector(connectorId, { limit = 100 } = {}) {
      // REVIEWED-DYNAMIC: bounded diagnostics scan of pending gaps for one connector type.
      const rows = [...iterateDynamicSqlAcknowledged(`
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = ?
          AND status = 'pending'
        ORDER BY created_at
        LIMIT ?
      `, [connectorId, Math.max(1, Math.min(limit, 500))])];
      return rows.map(rowToGap);
    },

    async listPendingGapsForConnectorInstance(connectorId, connectorInstanceId, { limit = 100 } = {}) {
      // REVIEWED-DYNAMIC: bounded diagnostics scan of pending gaps for one connection.
      const rows = [...iterateDynamicSqlAcknowledged(`
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = ?
          AND connector_instance_id = ?
          AND status = 'pending'
        ORDER BY created_at
        LIMIT ?
      `, [connectorId, connectorInstanceId, Math.max(1, Math.min(limit, 500))])];
      return rows.map(rowToGap);
    },

    // Exact reason-scoped count-by-status across every connector instance for a
    // connector type. The operator-console source-pressure backlog rollup uses
    // this for its optional `recovered` count: a single bounded aggregate that
    // returns only a scalar integer (no row bodies, locators, or payloads), in
    // the same connector-wide + reason scope the `pending` projection reads.
    // Throws on a malformed count so the caller can keep `recovered` `null`.
    async countGapsByStatusForConnector(connectorId, { status, reasons = null, connectorInstanceId = null } = {}) {
      assertValidGapStatus(status);
      const scopedConnectorInstanceId = nonEmptyString(connectorInstanceId);
      const reasonScope = normalizeReasonScope(reasons);
      const reasonPlaceholders = optionalSqlPlaceholders(reasonScope);
      // REVIEWED-DYNAMIC: bounded reason-scoped count-by-status aggregate over
      // the store-owned detail-gap table; only a scalar count is returned.
      const row = firstSqliteRow(`
        SELECT COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = ?
          AND status = ?
          AND (? IS NULL OR connector_instance_id = ?)
          ${reasonScope ? `AND reason IN (${reasonPlaceholders})` : ''}
      `, [connectorId, status, scopedConnectorInstanceId, scopedConnectorInstanceId, ...(reasonScope ?? [])]);
      return coerceCount(row?.gap_count ?? 0);
    },

    async countGapsByStatusByStreamForConnector(connectorId, { status, connectorInstanceId = null } = {}) {
      if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported connector detail gap status: ${status}`);
      const scopedConnectorInstanceId = nonEmptyString(connectorInstanceId);
      // REVIEWED-DYNAMIC: bounded grouped count-by-status aggregate over the
      // store-owned detail-gap table; only stream names and counts are returned.
      const rows = [...iterateDynamicSqlAcknowledged(`
        SELECT stream, COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = ?
          AND status = ?
          AND (? IS NULL OR connector_instance_id = ?)
        GROUP BY stream
        ORDER BY stream
      `, [connectorId, status, scopedConnectorInstanceId, scopedConnectorInstanceId])];
      return rows.map((row) => ({ stream: row.stream, count: coerceCount(row.gap_count ?? 0) }));
    },

    async markGapStatus(gapId, status, options = {}) {
      const mutation = normalizeGapStatusMutation(gapId, status, options);
      // `reason` is COALESCE-updated: only overwritten when the caller supplies
      // one (e.g. the quarantine path stamps `reason = 'quarantined'` so the
      // durable class the recovery-decision classifier reads matches the
      // terminal transition). Absent → the existing reason is preserved.
      // REVIEWED-DYNAMIC: status mutation for the store-owned detail-gap table.
      execDynamicSqlAcknowledged(`
        UPDATE connector_detail_gaps
        SET status = ?,
            reason = COALESCE(?, reason),
            attempt_count = attempt_count + ?,
            last_attempt_at = CASE WHEN ? = 1 THEN ? ELSE last_attempt_at END,
            next_attempt_after = ?,
            last_error_json = ?,
            last_run_id = COALESCE(?, last_run_id),
            recovered_run_id = COALESCE(?, recovered_run_id),
            updated_at = ?
        WHERE gap_id = ?
      `, [
        mutation.status,
        mutation.reason,
        mutation.attemptDelta,
        mutation.attemptDelta,
        mutation.now,
        mutation.nextAttemptAfter,
        mutation.lastErrorJson,
        mutation.runId,
        mutation.recoveredRunId,
        mutation.now,
        mutation.gapId,
      ]);
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned detail-gap table.
      return rowToGap(firstSqliteRow('SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1', [gapId]));
    },

    // Single-row read by gap id, or null if absent. Used by the §10-A terminal
    // classifier to read attempt_count BEFORE deciding to terminalize — a
    // read-then-decide pattern that avoids a write-then-rollback window where a
    // concurrent reader (or a crash between writes) could observe a gap as
    // terminal that should still be pending.
    async getGapById(gapId) {
      const id = nonEmptyString(gapId);
      if (!id) return null;
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned detail-gap table.
      return rowToGap(firstSqliteRow('SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1', [id]));
    },

    async claimPendingGaps(gapIds, { runId, leaseId, leaseExpiresAt } = {}) {
      const owner = normalizeLease({ gapId: 'claim-owner', runId, leaseId });
      const expiresAt = nonEmptyString(leaseExpiresAt);
      if (!expiresAt) throw new Error('detail-gap lease requires leaseExpiresAt');
      const claimedGapIds = [];
      for (const gapId of gapIds || []) {
        const id = nonEmptyString(gapId);
        if (!id) continue;
        const result = execDynamicSqlAcknowledged(`
          UPDATE connector_detail_gaps
          SET status = 'in_progress', lease_run_id = ?, lease_id = ?, lease_attempted = 0,
              lease_expires_at = ?, updated_at = ?
          WHERE gap_id = ? AND status = 'pending'
        `, [owner.runId, owner.leaseId, expiresAt, nowIso(), id]);
        if (Number(result.changes || 0) === 1) claimedGapIds.push(id);
      }
      return claimedGapIds;
    },

    async markLeasedGapAttempt(lease) {
      const owner = normalizeLease(lease);
      const now = nowIso();
      const result = execDynamicSqlAcknowledged(`
        UPDATE connector_detail_gaps
        SET attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN ? ELSE last_attempt_at END,
            lease_attempted = 1, updated_at = ?
        WHERE gap_id = ? AND status = 'in_progress'
          AND lease_run_id = ? AND lease_id = ?
      `, [now, now, owner.gapId, owner.runId, owner.leaseId]);
      if (Number(result.changes || 0) !== 1) return null;
      return rowToGap(firstSqliteRow('SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1', [owner.gapId]));
    },

    async settleLeasedGapRecovered(lease) {
      const owner = normalizeLease(lease);
      const now = nowIso();
      const result = execDynamicSqlAcknowledged(`
        UPDATE connector_detail_gaps
        SET status = 'recovered', recovered_run_id = ?, last_run_id = ?,
            attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN ? ELSE last_attempt_at END,
            lease_run_id = NULL, lease_id = NULL, lease_attempted = 0, lease_expires_at = NULL,
            updated_at = ?
        WHERE gap_id = ? AND status = 'in_progress'
          AND lease_run_id = ? AND lease_id = ?
      `, [owner.runId, owner.runId, now, now, owner.gapId, owner.runId, owner.leaseId]);
      if (Number(result.changes || 0) !== 1) return null;
      return rowToGap(firstSqliteRow('SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1', [owner.gapId]));
    },

    async settleLeasedGapPending(lease, input) {
      const owner = normalizeLease(lease);
      const gap = normalizeGapInput(input);
      const detailLocatorJson = encodeJson(gap.detailLocator);
      const result = execDynamicSqlAcknowledged(`
        UPDATE connector_detail_gaps
        SET source_json = ?, detail_locator_json = ?, list_cursor_json = ?, scope_json = ?, reason = ?,
            status = 'pending', next_attempt_after = ?, last_error_json = ?, last_run_id = ?,
            attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN ? ELSE last_attempt_at END,
            lease_run_id = NULL, lease_id = NULL, lease_attempted = 0, lease_expires_at = NULL,
            updated_at = ?
        WHERE gap_id = ? AND status = 'in_progress'
          AND lease_run_id = ? AND lease_id = ?
      `, [
        encodeJson(gap.source), detailLocatorJson, encodeJson(gap.listCursor), encodeJson(gap.scope), gap.reason,
        gap.nextAttemptAfter, encodeJson(gap.lastError), gap.lastRunId, gap.now, gap.now,
        owner.gapId, owner.runId, owner.leaseId,
      ]);
      if (Number(result.changes || 0) !== 1) return null;
      return rowToGap(firstSqliteRow('SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1', [owner.gapId]));
    },

    async releaseLeasedGaps(leases) {
      let released = 0;
      let lost = 0;
      let attemptedUnsettled = 0;
      for (const lease of leases || []) {
        const owner = normalizeLease(lease);
        const row = firstSqliteRow(`
          SELECT lease_attempted FROM connector_detail_gaps
          WHERE gap_id = ? AND status = 'in_progress' AND lease_run_id = ? AND lease_id = ?
        `, [owner.gapId, owner.runId, owner.leaseId]);
        if (!row) { lost += 1; continue; }
        const result = execDynamicSqlAcknowledged(`
          UPDATE connector_detail_gaps
          SET status = 'pending', lease_run_id = NULL, lease_id = NULL, lease_attempted = 0,
              lease_expires_at = NULL, updated_at = ?
          WHERE gap_id = ? AND status = 'in_progress' AND lease_run_id = ? AND lease_id = ?
        `, [nowIso(), owner.gapId, owner.runId, owner.leaseId]);
        if (Number(result.changes || 0) === 1) {
          released += 1;
          attemptedUnsettled += Number(row.lease_attempted || 0) === 1 ? 1 : 0;
        } else {
          lost += 1;
        }
      }
      return { released, lost, attemptedUnsettled };
    },

    // Reclaim only an expired owner lease. A different live run is not evidence
    // of a crash and must never be stolen merely because its run id differs.
    async reclaimStrandedInProgressGaps({ connectorId, connectorInstanceId, grantId, currentRunId }) {
      const cii = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(connectorId);
      const now = nowIso();
      // REVIEWED-DYNAMIC: bulk status reset for stranded in_progress gaps from prior runs.
      execDynamicSqlAcknowledged(`
        UPDATE connector_detail_gaps
        SET status = 'pending', updated_at = ?
        WHERE connector_instance_id = ?
          AND connector_id = ?
          AND (? IS NULL OR grant_id = ?)
          AND status = 'in_progress'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `, [now, cii, connectorId, grantId, grantId, now]);
    },

    async requeueQuarantinedTerminalGapsForConnectorInstance(connectorId, connectorInstanceId, options = {}) {
      const scope = normalizeQuarantinedRequeueScope(connectorId, connectorInstanceId, options);
      return requeueSqliteQuarantinedRows(sqliteQuarantinedRequeueRows(scope), scope);
    },
  };
}

export function createPostgresConnectorDetailGapStore() {
  return {
    async upsertPendingGap(input) {
      const gap = normalizeGapInput(input);
      const result = await postgresQuery(`
        INSERT INTO connector_detail_gaps(
          gap_id, connector_id, connector_instance_id, grant_id, source_json, stream, parent_stream, record_key,
          detail_locator_json, list_cursor_json, scope_json, reason, status, attempt_count,
          next_attempt_after, last_error_json, discovered_run_id, last_run_id, created_at, updated_at
        ) VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, 'pending', 0, $13, $14::jsonb, $15, $16, $17, $17)
        -- Identity conflict target = the natural key, with the volatile locator
        -- dropped when a record_key exists (see detailGapIdentityKey). Closes the
        -- locator-drift orphan class: a re-discovery under a new locator shape
        -- re-upserts the SAME row instead of inserting a duplicate.
        ON CONFLICT (connector_instance_id, COALESCE(grant_id, ''), stream, COALESCE(parent_stream, ''), (CASE WHEN NULLIF(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || COALESCE(detail_locator_json::text, '') END)) DO UPDATE SET
          source_json = EXCLUDED.source_json,
          detail_locator_json = EXCLUDED.detail_locator_json,
          list_cursor_json = EXCLUDED.list_cursor_json,
          scope_json = EXCLUDED.scope_json,
          reason = EXCLUDED.reason,
          -- §10-A: 'terminal' is always sticky — a terminalized gap must not be
          -- silently resurrected into the fillable-pending set by a re-upsert.
          -- 'recovered' is sticky ONLY against a re-upsert from the SAME run
          -- that recovered it (an ordinary-forward-pass re-defer with no new
          -- attempt evidence, per the original §10-A regression) — i.e. a
          -- NON-NULL 'recovered_run_id' that matches 'EXCLUDED.last_run_id'
          -- exactly. A NULL 'recovered_run_id' (a run-id-less recovery, e.g.
          -- the local-collector policy-budget path in
          -- 'ref-device-exporters.ts:recoverLocalCollectorGap', which marks a
          -- gap recovered with '{}' — no spine run backs it) carries no
          -- same-attempt context to compare against, so SQL's 'NULL = x'
          -- already evaluates false/unmatched for every 'x' here — the row is
          -- NEVER treated as a same-attempt re-defer and always reopens on the
          -- next re-upsert. Do not special-case NULL as a stickiness
          -- wildcard: an earlier revision did 'recovered_run_id IS NULL OR
          -- ...', which made every run-id-less recovery sticky FOREVER
          -- (P1 review finding) — the exact opposite of the reopen-on-later-
          -- evidence rule this fix exists to enforce. A re-upsert from a
          -- LATER run (or ANY re-upsert of a null-run-id recovery) reopens
          -- the row to 'pending': the connector is reporting, with fresh
          -- attempt evidence, that a previously-closed record is missing
          -- again — treating that as permanently satisfied silently strands
          -- it outside both the pending-retry queue and the quarantine
          -- escalation path forever (live Amazon order_items evidence: 12
          -- order ids stuck 'recovered' while DETAIL_COVERAGE reported them
          -- uncovered on every run for weeks).
          status = CASE
            WHEN connector_detail_gaps.status = 'terminal' THEN 'terminal'
            WHEN connector_detail_gaps.status = 'recovered'
              AND connector_detail_gaps.recovered_run_id = EXCLUDED.last_run_id
              THEN 'recovered'
            ELSE 'pending'
          END,
          next_attempt_after = EXCLUDED.next_attempt_after,
          last_error_json = EXCLUDED.last_error_json,
          last_run_id = EXCLUDED.last_run_id,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `, [
        gap.gapId,
        gap.connectorId,
        gap.connectorInstanceId,
        gap.grantId,
        JSON.stringify(gap.source),
        gap.stream,
        gap.parentStream,
        gap.recordKey,
        encodeJson(gap.detailLocator),
        encodeJson(gap.listCursor),
        encodeJson(gap.scope),
        gap.reason,
        gap.nextAttemptAfter,
        encodeJson(gap.lastError),
        gap.discoveredRunId,
        gap.lastRunId,
        gap.now,
      ]);
      return rowToGap(result.rows[0]);
    },

    async listPendingGaps({ connectorId, grantId = null, streams = null, limit = 100, now = nowIso() } = {}) {
      const connectorInstanceId = nonEmptyString(arguments[0]?.connectorInstanceId) || defaultConnectorInstanceId(connectorId);
      const eligibleAt = nonEmptyString(now) || nowIso();
      const result = await postgresQuery(`
        SELECT * FROM connector_detail_gaps
        WHERE connector_instance_id = $1
          AND connector_id = $2
          AND ($3::text IS NULL OR grant_id = $3)
          AND status = 'pending'
          AND (next_attempt_after IS NULL OR next_attempt_after <= $4)
          AND ($5::text[] IS NULL OR stream = ANY($5::text[]))
        ORDER BY ${pendingGapOrderBySql(true)}
        LIMIT $6
      `, [
        connectorInstanceId,
        connectorId,
        grantId,
        eligibleAt,
        Array.isArray(streams) && streams.length ? streams : null,
        Math.max(1, Math.min(limit, 500)),
      ]);
      return result.rows.map(rowToGap);
    },

    async listPendingGapsForConnector(connectorId, { limit = 100 } = {}) {
      const result = await postgresQuery(`
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = $1
          AND status = 'pending'
        ORDER BY created_at
        LIMIT $2
      `, [connectorId, Math.max(1, Math.min(limit, 500))]);
      return result.rows.map(rowToGap);
    },

    async listPendingGapsForConnectorInstance(connectorId, connectorInstanceId, { limit = 100 } = {}) {
      const result = await postgresQuery(`
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = $1
          AND connector_instance_id = $2
          AND status = 'pending'
        ORDER BY created_at
        LIMIT $3
      `, [connectorId, connectorInstanceId, Math.max(1, Math.min(limit, 500))]);
      return result.rows.map(rowToGap);
    },

    async countGapsByStatusForConnector(connectorId, { status, reasons = null, connectorInstanceId = null } = {}) {
      assertValidGapStatus(status);
      const reasonScope = normalizeReasonScope(reasons);
      const scopedConnectorInstanceId = nonEmptyString(connectorInstanceId);
      // Bounded reason-scoped count-by-status aggregate (Postgres analogue of
      // the SQLite path). `$3::text[]` is `NULL` when no reason scope is given,
      // so the predicate counts every reason; otherwise it restricts to the
      // supplied source-pressure reasons. Only a scalar count is returned.
      const result = await postgresQuery(`
        SELECT COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = $1
          AND status = $2
          AND ($3::text[] IS NULL OR reason = ANY($3::text[]))
          AND ($4::text IS NULL OR connector_instance_id = $4)
      `, [connectorId, status, reasonScope, scopedConnectorInstanceId]);
      return coerceCount(result.rows[0]?.gap_count ?? 0);
    },

    async countGapsByStatusByStreamForConnector(connectorId, { status, connectorInstanceId = null } = {}) {
      if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported connector detail gap status: ${status}`);
      const scopedConnectorInstanceId = nonEmptyString(connectorInstanceId);
      const result = await postgresQuery(`
        SELECT stream, COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = $1
          AND status = $2
          AND ($3::text IS NULL OR connector_instance_id = $3)
        GROUP BY stream
        ORDER BY stream
      `, [connectorId, status, scopedConnectorInstanceId]);
      return result.rows.map((row) => ({ stream: row.stream, count: coerceCount(row.gap_count ?? 0) }));
    },

    async markGapStatus(gapId, status, options = {}) {
      const mutation = normalizeGapStatusMutation(gapId, status, options);
      // `reason` is COALESCE-updated (see the SQLite path): only overwritten
      // when supplied, so the quarantine transition can stamp the durable
      // `quarantined` class while ordinary status mutations preserve it.
      const result = await postgresQuery(`
        UPDATE connector_detail_gaps
        SET status = $1,
            reason = COALESCE($9, reason),
            attempt_count = attempt_count + $2,
            last_attempt_at = CASE WHEN $2 = 1 THEN $3 ELSE last_attempt_at END,
            next_attempt_after = $4,
            last_error_json = $5::jsonb,
            last_run_id = COALESCE($6, last_run_id),
            recovered_run_id = COALESCE($7, recovered_run_id),
            updated_at = $3
        WHERE gap_id = $8
        RETURNING *
      `, [
        mutation.status,
        mutation.attemptDelta,
        mutation.now,
        mutation.nextAttemptAfter,
        mutation.lastErrorJson,
        mutation.runId,
        mutation.recoveredRunId,
        mutation.gapId,
        mutation.reason,
      ]);
      return rowToGap(result.rows[0]);
    },

    // Single-row read by gap id, or null if absent. See the SQLite path for the
    // read-then-decide rationale (§10-A terminal classifier).
    async getGapById(gapId) {
      const id = nonEmptyString(gapId);
      if (!id) return null;
      const result = await postgresQuery('SELECT * FROM connector_detail_gaps WHERE gap_id = $1 LIMIT 1', [id]);
      return result.rows[0] ? rowToGap(result.rows[0]) : null;
    },

    async claimPendingGaps(gapIds, { runId, leaseId, leaseExpiresAt } = {}) {
      const owner = normalizeLease({ gapId: 'claim-owner', runId, leaseId });
      const expiresAt = nonEmptyString(leaseExpiresAt);
      if (!expiresAt) throw new Error('detail-gap lease requires leaseExpiresAt');
      const claimedGapIds = [];
      for (const gapId of gapIds || []) {
        const id = nonEmptyString(gapId);
        if (!id) continue;
        const result = await postgresQuery(`
          UPDATE connector_detail_gaps
          SET status = 'in_progress', lease_run_id = $1, lease_id = $2, lease_attempted = 0,
              lease_expires_at = $3, updated_at = $4
          WHERE gap_id = $5 AND status = 'pending'
          RETURNING gap_id
        `, [owner.runId, owner.leaseId, expiresAt, nowIso(), id]);
        if (result.rows[0]?.gap_id) claimedGapIds.push(result.rows[0].gap_id);
      }
      return claimedGapIds;
    },

    async markLeasedGapAttempt(lease) {
      const owner = normalizeLease(lease);
      const now = nowIso();
      const result = await postgresQuery(`
        UPDATE connector_detail_gaps
        SET attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN $1 ELSE last_attempt_at END,
            lease_attempted = 1, updated_at = $1
        WHERE gap_id = $2 AND status = 'in_progress' AND lease_run_id = $3 AND lease_id = $4
        RETURNING *
      `, [now, owner.gapId, owner.runId, owner.leaseId]);
      return result.rows[0] ? rowToGap(result.rows[0]) : null;
    },

    async settleLeasedGapRecovered(lease) {
      const owner = normalizeLease(lease);
      const now = nowIso();
      const result = await postgresQuery(`
        UPDATE connector_detail_gaps
        SET status = 'recovered', recovered_run_id = $1, last_run_id = $1,
            attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN $2 ELSE last_attempt_at END,
            lease_run_id = NULL, lease_id = NULL, lease_attempted = 0, lease_expires_at = NULL,
            updated_at = $2
        WHERE gap_id = $3 AND status = 'in_progress' AND lease_run_id = $1 AND lease_id = $4
        RETURNING *
      `, [owner.runId, now, owner.gapId, owner.leaseId]);
      return result.rows[0] ? rowToGap(result.rows[0]) : null;
    },

    async settleLeasedGapPending(lease, input) {
      const owner = normalizeLease(lease);
      const gap = normalizeGapInput(input);
      const result = await postgresQuery(`
        UPDATE connector_detail_gaps
        SET source_json = $1::jsonb, detail_locator_json = $2::jsonb, list_cursor_json = $3::jsonb,
            scope_json = $4::jsonb, reason = $5, status = 'pending', next_attempt_after = $6,
            last_error_json = $7::jsonb, last_run_id = $8,
            attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN $9 ELSE last_attempt_at END,
            lease_run_id = NULL, lease_id = NULL, lease_attempted = 0, lease_expires_at = NULL,
            updated_at = $9
        WHERE gap_id = $10 AND status = 'in_progress' AND lease_run_id = $11 AND lease_id = $12
        RETURNING *
      `, [
        JSON.stringify(gap.source), encodeJson(gap.detailLocator), encodeJson(gap.listCursor), JSON.stringify(gap.scope),
        gap.reason, gap.nextAttemptAfter, encodeJson(gap.lastError), gap.lastRunId, gap.now,
        owner.gapId, owner.runId, owner.leaseId,
      ]);
      return result.rows[0] ? rowToGap(result.rows[0]) : null;
    },

    async releaseLeasedGaps(leases) {
      let released = 0;
      let lost = 0;
      let attemptedUnsettled = 0;
      for (const lease of leases || []) {
        const owner = normalizeLease(lease);
        const result = await postgresQuery(`
          WITH leased AS (
            SELECT gap_id, lease_attempted
            FROM connector_detail_gaps
            WHERE gap_id = $2 AND status = 'in_progress' AND lease_run_id = $3 AND lease_id = $4
            FOR UPDATE
          )
          UPDATE connector_detail_gaps
          SET status = 'pending', lease_run_id = NULL, lease_id = NULL, lease_attempted = 0,
              lease_expires_at = NULL, updated_at = $1
          FROM leased
          WHERE connector_detail_gaps.gap_id = leased.gap_id
          RETURNING leased.lease_attempted
        `, [nowIso(), owner.gapId, owner.runId, owner.leaseId]);
        const row = result.rows[0];
        if (!row) { lost += 1; continue; }
        released += 1;
        attemptedUnsettled += Number(row.lease_attempted || 0) === 1 ? 1 : 0;
      }
      return { released, lost, attemptedUnsettled };
    },

    async reclaimStrandedInProgressGaps({ connectorId, connectorInstanceId, grantId, currentRunId }) {
      const cii = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(connectorId);
      const now = nowIso();
      await postgresQuery(`
        UPDATE connector_detail_gaps
        SET status = 'pending', updated_at = $1
        WHERE connector_instance_id = $2
          AND connector_id = $3
          AND ($4::text IS NULL OR grant_id = $4)
          AND status = 'in_progress'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= $5
      `, [now, cii, connectorId, grantId, now]);
    },

    async requeueQuarantinedTerminalGapsForConnectorInstance(connectorId, connectorInstanceId, options = {}) {
      const scope = normalizeQuarantinedRequeueScope(connectorId, connectorInstanceId, options);
      return requeuePostgresQuarantinedRows(await postgresQuarantinedRequeueRows(scope), scope);
    },
  };
}

export function createConnectorDetailGapStore() {
  return isPostgresStorageBackend() ? createPostgresConnectorDetailGapStore() : createSqliteConnectorDetailGapStore();
}

let defaultStore = null;
let defaultBackend = null;

export function getDefaultConnectorDetailGapStore() {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultBackend !== backend) {
    defaultStore = createConnectorDetailGapStore();
    defaultBackend = backend;
  }
  return defaultStore;
}
