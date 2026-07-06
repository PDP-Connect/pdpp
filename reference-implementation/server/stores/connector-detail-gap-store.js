import { createHash } from 'node:crypto';

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from '../../lib/db.ts';
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

export function sanitizeDetailGapMetadata(value, depth = 0, keyName = '') {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (isSafeRouteTemplate(value, keyName)) return value;
    if (/^https?:\/\//i.test(value) || URL_KEY_PATTERN.test(keyName)) return safeUrlSummary(value);
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH - 1)}…` : value;
  }
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeDetailGapMetadata(entry, depth + 1, keyName));
  }
  if (typeof value !== 'object') return null;

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

function deriveGapId(input, connectorId, connectorInstanceId, grantId, stream, parentStream, recordKey, detailLocator) {
  return input.gapId || hashIdentity([connectorId, connectorInstanceId, grantId || '', stream, parentStream || '', recordKey || '', detailLocator || null]);
}

function normalizeGapInput(input) {
  const { connectorId, connectorInstanceId, stream } = deriveGapIdentity(input);

  const source = sanitizeDetailGapMetadata(input.source || { kind: 'connector', id: connectorId });
  const detailLocator = sanitizeDetailGapMetadata(input.detailLocator ?? null);
  const listCursor = sanitizeDetailGapMetadata(input.listCursor ?? null);
  const scope = sanitizeDetailGapMetadata(input.scope ?? null);
  const lastError = sanitizeDetailGapMetadata(input.lastError ?? null);
  const grantId = nonEmptyString(input.grantId);
  const parentStream = nonEmptyString(input.parentStream);
  const recordKey = input.recordKey == null ? null : String(input.recordKey);
  const reason = nonEmptyString(input.reason) || null;
  const now = input.now || nowIso();
  const gapId = deriveGapId(input, connectorId, connectorInstanceId, grantId, stream, parentStream, recordKey, detailLocator);

  return {
    gapId,
    connectorId,
    connectorInstanceId,
    grantId,
    source,
    stream,
    parentStream,
    recordKey,
    detailLocator,
    listCursor,
    scope,
    reason,
    lastError,
    discoveredRunId: nonEmptyString(input.discoveredRunId),
    lastRunId: nonEmptyString(input.lastRunId) || nonEmptyString(input.discoveredRunId),
    nextAttemptAfter: nonEmptyString(input.nextAttemptAfter),
    now,
  };
}

function rowToGap(row) {
  if (!row) return null;
  return {
    gap_id: row.gap_id,
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id,
    grant_id: row.grant_id ?? null,
    source: parseJson(row.source_json),
    stream: row.stream,
    parent_stream: row.parent_stream ?? null,
    record_key: row.record_key ?? null,
    detail_locator: parseJson(row.detail_locator_json),
    list_cursor: parseJson(row.list_cursor_json),
    scope: parseJson(row.scope_json),
    reason: row.reason ?? null,
    status: row.status,
    attempt_count: row.attempt_count,
    last_attempt_at: row.last_attempt_at ?? null,
    next_attempt_after: row.next_attempt_after ?? null,
    last_error: parseJson(row.last_error_json),
    discovered_run_id: row.discovered_run_id ?? null,
    last_run_id: row.last_run_id ?? null,
    recovered_run_id: row.recovered_run_id ?? null,
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
          -- §10-A: preserve both 'recovered' and 'terminal' — terminal is sticky,
          -- a terminalized gap must not be silently resurrected into the
          -- fillable-pending set by a re-upsert (spec §10-A).
          status = CASE
            WHEN connector_detail_gaps.status IN ('recovered', 'terminal') THEN connector_detail_gaps.status
            ELSE 'pending'
          END,
          next_attempt_after = excluded.next_attempt_after,
          last_error_json = excluded.last_error_json,
          last_run_id = excluded.last_run_id,
          updated_at = excluded.updated_at
        ON CONFLICT(connector_instance_id, ifnull(grant_id, ''), stream, ifnull(parent_stream, ''), ifnull(record_key, ''), ifnull(detail_locator_json, '')) DO UPDATE SET
          source_json = excluded.source_json,
          list_cursor_json = excluded.list_cursor_json,
          scope_json = excluded.scope_json,
          reason = excluded.reason,
          -- §10-A: preserve both 'recovered' and 'terminal' — terminal is sticky.
          status = CASE
            WHEN connector_detail_gaps.status IN ('recovered', 'terminal') THEN connector_detail_gaps.status
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
      return rowToGap(firstSqliteRow(`
        SELECT * FROM connector_detail_gaps
        WHERE connector_instance_id = ?
          AND ifnull(grant_id, '') = ?
          AND stream = ?
          AND ifnull(parent_stream, '') = ?
          AND ifnull(record_key, '') = ?
          AND ifnull(detail_locator_json, '') = ?
        LIMIT 1
      `, [
        gap.connectorInstanceId,
        gap.grantId || '',
        gap.stream,
        gap.parentStream || '',
        gap.recordKey || '',
        detailLocatorJson || '',
      ]));
    },

    async listPendingGaps({ connectorId, grantId = null, streams = null, limit = 100, now = nowIso() } = {}) {
      const connectorInstanceId = nonEmptyString(arguments[0]?.connectorInstanceId) || defaultConnectorInstanceId(connectorId);
      const eligibleAt = nonEmptyString(now) || nowIso();
      const streamList = Array.isArray(streams) ? streams.filter((stream) => typeof stream === 'string' && stream) : null;
      const streamPlaceholders = streamList?.length ? streamList.map(() => '?').join(', ') : null;
      // REVIEWED-DYNAMIC: bounded pending-gap recovery selection over the store-owned table.
      const rows = [...iterateDynamicSqlAcknowledged(`
        SELECT * FROM connector_detail_gaps
        WHERE connector_instance_id = ?
          AND connector_id = ?
          AND (? IS NULL OR grant_id = ?)
          AND status = 'pending'
          AND (next_attempt_after IS NULL OR next_attempt_after <= ?)
          ${streamPlaceholders ? `AND stream IN (${streamPlaceholders})` : ''}
        ORDER BY created_at
        LIMIT ?
      `, [connectorInstanceId, connectorId, grantId, grantId, eligibleAt, ...(streamList ?? []), Math.max(1, Math.min(limit, 500))])];
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

    // Exact reason-scoped count-by-status across every connector instance for a
    // connector type. The operator-console source-pressure backlog rollup uses
    // this for its optional `recovered` count: a single bounded aggregate that
    // returns only a scalar integer (no row bodies, locators, or payloads), in
    // the same connector-wide + reason scope the `pending` projection reads.
    // Throws on a malformed count so the caller can keep `recovered` `null`.
    async countGapsByStatusForConnector(connectorId, { status, reasons = null } = {}) {
      if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported connector detail gap status: ${status}`);
      const reasonScope = normalizeReasonScope(reasons);
      const reasonPlaceholders = reasonScope ? reasonScope.map(() => '?').join(', ') : null;
      // REVIEWED-DYNAMIC: bounded reason-scoped count-by-status aggregate over
      // the store-owned detail-gap table; only a scalar count is returned.
      const row = firstSqliteRow(`
        SELECT COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = ?
          AND status = ?
          ${reasonScope ? `AND reason IN (${reasonPlaceholders})` : ''}
      `, [connectorId, status, ...(reasonScope ?? [])]);
      return coerceCount(row?.gap_count ?? 0);
    },

    async markGapStatus(gapId, status, options = {}) {
      if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported connector detail gap status: ${status}`);
      const now = options.now || nowIso();
      const attemptDelta = status === 'in_progress' ? 1 : 0;
      const recoveredRunId = status === 'recovered' ? nonEmptyString(options.runId) : null;
      // `reason` is COALESCE-updated: only overwritten when the caller supplies
      // one (e.g. the quarantine path stamps `reason = 'quarantined'` so the
      // durable class the recovery-decision classifier reads matches the
      // terminal transition). Absent → the existing reason is preserved.
      const reason = nonEmptyString(options.reason);
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
        status,
        reason,
        attemptDelta,
        attemptDelta,
        now,
        nonEmptyString(options.nextAttemptAfter),
        encodeJson(sanitizeDetailGapMetadata(options.lastError ?? null)),
        nonEmptyString(options.runId),
        recoveredRunId,
        now,
        gapId,
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

    // Reset in_progress gaps from prior runs (different runId, same scope) back
    // to pending so crash leftovers become retryable. Never touches recovered gaps.
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
          AND (last_run_id IS NULL OR last_run_id != ?)
      `, [now, cii, connectorId, grantId, grantId, currentRunId]);
    },

    // Reset still-in_progress gaps served by this run (by gap id) back to pending.
    // Called in run cleanup/finally. Does not decrement attempt_count.
    async resetServedInProgressGaps(gapIds) {
      if (!gapIds || !gapIds.length) return;
      const now = nowIso();
      const placeholders = gapIds.map(() => '?').join(', ');
      // REVIEWED-DYNAMIC: bulk reset of specific in_progress gap ids served this run.
      execDynamicSqlAcknowledged(`
        UPDATE connector_detail_gaps
        SET status = 'pending', updated_at = ?
        WHERE gap_id IN (${placeholders})
          AND status = 'in_progress'
      `, [now, ...gapIds]);
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
        ON CONFLICT (connector_instance_id, COALESCE(grant_id, ''), stream, COALESCE(parent_stream, ''), COALESCE(record_key, ''), COALESCE(detail_locator_json::text, '')) DO UPDATE SET
          source_json = EXCLUDED.source_json,
          list_cursor_json = EXCLUDED.list_cursor_json,
          scope_json = EXCLUDED.scope_json,
          reason = EXCLUDED.reason,
          -- §10-A: preserve both 'recovered' and 'terminal' — terminal is sticky,
          -- a terminalized gap must not be silently resurrected into the
          -- fillable-pending set by a re-upsert (spec §10-A).
          status = CASE
            WHEN connector_detail_gaps.status IN ('recovered', 'terminal') THEN connector_detail_gaps.status
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
        ORDER BY created_at
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

    async countGapsByStatusForConnector(connectorId, { status, reasons = null } = {}) {
      if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported connector detail gap status: ${status}`);
      const reasonScope = normalizeReasonScope(reasons);
      // Bounded reason-scoped count-by-status aggregate (Postgres analogue of
      // the SQLite path). `$3::text[]` is `NULL` when no reason scope is given,
      // so the predicate counts every reason; otherwise it restricts to the
      // supplied source-pressure reasons. Only a scalar count is returned.
      const result = await postgresQuery(`
        SELECT COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = $1
          AND status = $2
          AND ($3::text[] IS NULL OR reason = ANY($3::text[]))
      `, [connectorId, status, reasonScope]);
      return coerceCount(result.rows[0]?.gap_count ?? 0);
    },

    async markGapStatus(gapId, status, options = {}) {
      if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported connector detail gap status: ${status}`);
      const now = options.now || nowIso();
      const attemptDelta = status === 'in_progress' ? 1 : 0;
      const recoveredRunId = status === 'recovered' ? nonEmptyString(options.runId) : null;
      // `reason` is COALESCE-updated (see the SQLite path): only overwritten
      // when supplied, so the quarantine transition can stamp the durable
      // `quarantined` class while ordinary status mutations preserve it.
      const reason = nonEmptyString(options.reason);
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
        status,
        attemptDelta,
        now,
        nonEmptyString(options.nextAttemptAfter),
        encodeJson(sanitizeDetailGapMetadata(options.lastError ?? null)),
        nonEmptyString(options.runId),
        recoveredRunId,
        gapId,
        reason,
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
          AND (last_run_id IS NULL OR last_run_id != $5)
      `, [now, cii, connectorId, grantId, currentRunId]);
    },

    async resetServedInProgressGaps(gapIds) {
      if (!gapIds || !gapIds.length) return;
      const now = nowIso();
      await postgresQuery(`
        UPDATE connector_detail_gaps
        SET status = 'pending', updated_at = $1
        WHERE gap_id = ANY($2::text[])
          AND status = 'in_progress'
      `, [now, gapIds]);
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
