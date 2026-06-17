/**
 * Connector-summary evidence read model — reference-only, owner-facing.
 *
 * Maintains DURABLE per-connection evidence for the owner-console connector
 * summary (`/_ref/connectors`). It is the SLVP-ideal construction the design
 * note calls for: a maintained, dual-backend, incrementally-updated evidence
 * store with dirty marking, lazy reconcile, full rebuild, and an honesty
 * envelope — modeled directly on `retained-size-read-model.js`.
 *
 * Load-bearing decision (openspec/changes/maintain-connector-summary-read-model
 * design.md): persist DURABLE evidence only. Time-relative and runtime-relative
 * synthesis — freshness, connection_health, collection_report, rendered_verdict,
 * next_action — is NEVER persisted here. Those are computed on read against the
 * current `now` and controller/runtime liveness so a cached verdict can never
 * say a source is healthy after its evidence has gone stale or blocked.
 *
 * This module is storage + maintenance scaffolding. It does NOT yet back the
 * `/_ref/connectors` hot path; the read-path swap is a later slice. The rebuild
 * derives evidence from already-durable canonical state (connector_instances +
 * the maintained retained_size_* projection); it never re-runs connectors or
 * reads credentials.
 *
 * Spec: openspec/changes/maintain-connector-summary-read-model/
 */

import { getDb } from './db.js';
import {
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresTransaction,
} from './postgres-storage.js';

// Reference-only convention: the owner runs one personal server, so every
// connector_instances row is the owner's. Rebuild scopes to this subject the
// same way the connector-summary projection does. Kept as a constant so a
// future multi-owner reference can thread it through without a code search.
const REFERENCE_OWNER_SUBJECT_ID = 'owner_local';

function nowIso() {
  return new Date().toISOString();
}

/**
 * Strip anything that looks like a credential/token (long base64-ish runs)
 * out of an error string before it lands in durable metadata, and bound the
 * length. Same contract as the retained-size projection's sanitizer.
 */
function sanitizeProjectionError(err) {
  const message = err instanceof Error ? err.message : String(err || 'unknown error');
  return message.replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]').slice(0, 240);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List maintained connector-summary evidence rows. Optionally narrow to one
 * connection by `connectorInstanceId`. Returns DURABLE evidence only — callers
 * synthesize freshness/health/verdict on read.
 */
export async function listConnectorSummaryEvidence({ connectorInstanceId } = {}) {
  if (isPostgresStorageBackend()) {
    const params = [];
    let where = '';
    if (connectorInstanceId) {
      params.push(connectorInstanceId);
      where = `WHERE connector_instance_id = $${params.length}`;
    }
    const result = await postgresQuery(
      `SELECT connector_instance_id, connector_id, display_name, status, source_kind,
              revoked_at, total_records, stream_count, last_record_updated_at,
              dirty, computed_at, source_event_seq, state, last_error
         FROM connector_summary_evidence
         ${where}
         ORDER BY connector_instance_id ASC`,
      params,
    );
    return result.rows.map(shapeEvidenceRow);
  }
  const db = getDb();
  const rows = connectorInstanceId
    ? db
      .prepare(
        `SELECT connector_instance_id, connector_id, display_name, status, source_kind,
                revoked_at, total_records, stream_count, last_record_updated_at,
                dirty, computed_at, source_event_seq, state, last_error
           FROM connector_summary_evidence
          WHERE connector_instance_id = ?
          ORDER BY connector_instance_id ASC`,
      )
      .all(connectorInstanceId)
    : db
      .prepare(
        `SELECT connector_instance_id, connector_id, display_name, status, source_kind,
                revoked_at, total_records, stream_count, last_record_updated_at,
                dirty, computed_at, source_event_seq, state, last_error
           FROM connector_summary_evidence
          ORDER BY connector_instance_id ASC`,
      )
      .all();
  return rows.map(shapeEvidenceRow);
}

/**
 * Read exactly one connection's maintained evidence, or `null` when no row
 * exists yet. Scoped/detail callers use this so they never fall back to the
 * shallow full-list overview.
 */
export async function getConnectorSummaryEvidence(connectorInstanceId) {
  if (!connectorInstanceId) return null;
  const rows = await listConnectorSummaryEvidence({ connectorInstanceId });
  return rows[0] ?? null;
}

function shapeEvidenceRow(row) {
  return {
    connector_instance_id: row.connector_instance_id,
    connector_id: row.connector_id,
    display_name: row.display_name,
    status: row.status,
    source_kind: row.source_kind,
    revoked_at: row.revoked_at || null,
    total_records: Number(row.total_records || 0),
    stream_count: Number(row.stream_count || 0),
    last_record_updated_at: row.last_record_updated_at || null,
    dirty: Number(row.dirty || 0) !== 0,
    computed_at: row.computed_at || null,
    source_event_seq: row.source_event_seq == null ? null : Number(row.source_event_seq),
    state: row.state || 'unknown',
    last_error: row.last_error || null,
  };
}

// ---------------------------------------------------------------------------
// Dirty markers
// ---------------------------------------------------------------------------

/**
 * Mark one connection's evidence dirty. Best-effort: a marker failure is
 * non-fatal because the canonical state (connector_instances + retained_size_*)
 * is untouched and a subsequent reconcile/rebuild repairs the row. Same
 * dirty-on-failure contract as the retained-size projection.
 *
 * `sourceEventSeq`, when provided, records the monotonic seq of the event that
 * dirtied the row so a later reconcile can detect it is acting on the freshest
 * cause. It is advisory metadata, never load-bearing for correctness.
 */
export async function markConnectorSummaryEvidenceDirty({ connectorInstanceId, reason, sourceEventSeq } = {}) {
  if (!connectorInstanceId) {
    return;
  }
  const sanitized = reason ? sanitizeProjectionError(reason) : null;
  try {
    if (isPostgresStorageBackend()) {
      await postgresQuery(
        `UPDATE connector_summary_evidence
            SET dirty = 1,
                state = 'stale',
                last_error = $2,
                source_event_seq = COALESCE($3, source_event_seq)
          WHERE connector_instance_id = $1`,
        [connectorInstanceId, sanitized, sourceEventSeq == null ? null : Number(sourceEventSeq)],
      );
      return;
    }
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET dirty = 1,
                state = 'stale',
                last_error = ?,
                source_event_seq = COALESCE(?, source_event_seq)
          WHERE connector_instance_id = ?`,
      )
      .run(sanitized, sourceEventSeq == null ? null : Number(sourceEventSeq), connectorInstanceId);
  } catch {
    // Best-effort marker; rebuild/reconcile will repair.
  }
}

/**
 * Mark every maintained evidence row dirty. Used when a bulk write touched an
 * unknown set of connections (the same fallback the retained-size projection
 * uses when it cannot scope the delta).
 */
export async function markAllConnectorSummaryEvidenceDirty(reason) {
  const sanitized = reason ? sanitizeProjectionError(reason) : null;
  try {
    if (isPostgresStorageBackend()) {
      await postgresQuery(
        `UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', last_error = $1`,
        [sanitized],
      );
      return;
    }
    getDb()
      .prepare(`UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', last_error = ?`)
      .run(sanitized);
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Evidence extraction (pure, shared by rebuild and reconcile)
// ---------------------------------------------------------------------------

/**
 * Read the durable identity/lifecycle rows for every owner connection. These
 * are the connector_instances facts the summary needs (id, type, display name,
 * status, source kind, revoked time) — never a synthesized verdict.
 */
async function readConnectorInstanceRows() {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT connector_instance_id, connector_id, display_name, status, source_kind, revoked_at
         FROM connector_instances
        WHERE owner_subject_id = $1
        ORDER BY connector_instance_id ASC`,
      [REFERENCE_OWNER_SUBJECT_ID],
    );
    return result.rows.map(normalizeInstanceRow);
  }
  const rows = getDb()
    .prepare(
      `SELECT connector_instance_id, connector_id, display_name, status, source_kind, revoked_at
         FROM connector_instances
        WHERE owner_subject_id = ?
        ORDER BY connector_instance_id ASC`,
    )
    .all(REFERENCE_OWNER_SUBJECT_ID);
  return rows.map(normalizeInstanceRow);
}

function normalizeInstanceRow(row) {
  return {
    connector_instance_id: row.connector_instance_id,
    connector_id: row.connector_id,
    display_name: row.display_name,
    status: row.status,
    source_kind: row.source_kind,
    revoked_at: row.revoked_at || null,
  };
}

/**
 * Read durable record-count evidence per connection from the maintained
 * retained-size projection. `total_records` is the live record count and
 * `stream_count` is the number of distinct streams with records. These are
 * already-durable canonical counts; we do not re-aggregate the records table
 * here, so rebuild stays cheap and reads one maintained source.
 *
 * Returns a Map keyed by connector_instance_id → { total_records, stream_count }.
 */
async function readConnectionCountEvidence() {
  const map = new Map();
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT connector_instance_id,
              COALESCE(SUM(record_count), 0)::bigint AS total_records,
              COUNT(*) FILTER (WHERE record_count > 0)::bigint AS stream_count
         FROM retained_size_stream
        GROUP BY connector_instance_id`,
    );
    for (const row of result.rows) {
      map.set(row.connector_instance_id, {
        total_records: Number(row.total_records || 0),
        stream_count: Number(row.stream_count || 0),
      });
    }
    return map;
  }
  const rows = getDb()
    .prepare(
      `SELECT connector_instance_id,
              COALESCE(SUM(record_count), 0) AS total_records,
              SUM(CASE WHEN record_count > 0 THEN 1 ELSE 0 END) AS stream_count
         FROM retained_size_stream
        GROUP BY connector_instance_id`,
    )
    .all();
  for (const row of rows) {
    map.set(row.connector_instance_id, {
      total_records: Number(row.total_records || 0),
      stream_count: Number(row.stream_count || 0),
    });
  }
  return map;
}

async function readConnectionRecordRecencyEvidence() {
  const map = new Map();
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT connector_instance_id,
              MAX(emitted_at) AS last_record_updated_at
         FROM records
        WHERE deleted = FALSE
        GROUP BY connector_instance_id`,
    );
    for (const row of result.rows) {
      map.set(row.connector_instance_id, row.last_record_updated_at || null);
    }
    return map;
  }

  const rows = getDb()
    .prepare(
      `SELECT connector_instance_id,
              MAX(emitted_at) AS last_record_updated_at
         FROM records
        WHERE deleted = 0
        GROUP BY connector_instance_id`,
    )
    .all();
  for (const row of rows) {
    map.set(row.connector_instance_id, row.last_record_updated_at || null);
  }
  return map;
}

/**
 * Combine identity rows with count evidence into the durable evidence shape.
 * Pure: no storage, no `now`, no synthesis. Shared by rebuild and reconcile so
 * both paths produce byte-identical evidence.
 */
function buildEvidenceRows(instanceRows, countsByInstanceId, recencyByInstanceId) {
  return instanceRows.map((row) => {
    const counts = countsByInstanceId.get(row.connector_instance_id) ?? {
      total_records: 0,
      stream_count: 0,
    };
    return {
      connector_instance_id: row.connector_instance_id,
      connector_id: row.connector_id,
      display_name: row.display_name,
      status: row.status,
      source_kind: row.source_kind,
      revoked_at: row.revoked_at,
      total_records: counts.total_records,
      stream_count: counts.stream_count,
      last_record_updated_at: recencyByInstanceId.get(row.connector_instance_id) || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild every connector-summary evidence row from canonical durable state
 * (connector_instances + the maintained retained_size projection). Does NOT
 * re-run connectors or read credentials. On completion all rows are clean
 * (`dirty = 0`, `state = 'fresh'`) and rows for connections that no longer
 * exist are removed.
 *
 * Returns the maintained evidence rows (post-rebuild).
 */
export async function rebuildConnectorSummaryEvidence() {
  const instanceRows = await readConnectorInstanceRows();
  const counts = await readConnectionCountEvidence();
  const recencies = await readConnectionRecordRecencyEvidence();
  const evidence = buildEvidenceRows(instanceRows, counts, recencies);
  const computedAt = nowIso();
  if (isPostgresStorageBackend()) {
    await rebuildPostgres(evidence, computedAt);
  } else {
    rebuildSqlite(evidence, computedAt);
  }
  return listConnectorSummaryEvidence();
}

function rebuildSqlite(evidence, computedAt) {
  const db = getDb();
  const keep = new Set(evidence.map((row) => row.connector_instance_id));
  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO connector_summary_evidence(
         connector_instance_id, connector_id, display_name, status, source_kind,
         revoked_at, total_records, stream_count, last_record_updated_at,
         dirty, computed_at, source_event_seq, state, last_error
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 'fresh', NULL)
       ON CONFLICT(connector_instance_id) DO UPDATE SET
         connector_id = excluded.connector_id,
         display_name = excluded.display_name,
         status = excluded.status,
         source_kind = excluded.source_kind,
         revoked_at = excluded.revoked_at,
         total_records = excluded.total_records,
         stream_count = excluded.stream_count,
         last_record_updated_at = excluded.last_record_updated_at,
         dirty = 0,
         computed_at = excluded.computed_at,
         state = 'fresh',
         last_error = NULL`,
    );
    for (const row of evidence) {
      upsert.run(
        row.connector_instance_id,
        row.connector_id,
        row.display_name,
        row.status,
        row.source_kind,
        row.revoked_at,
        row.total_records,
        row.stream_count,
        row.last_record_updated_at,
        computedAt,
      );
    }
    // Drop rows for connections that no longer exist in canonical state.
    const existing = db.prepare('SELECT connector_instance_id FROM connector_summary_evidence').all();
    const stale = existing
      .map((r) => r.connector_instance_id)
      .filter((id) => !keep.has(id));
    const del = db.prepare('DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?');
    for (const id of stale) {
      del.run(id);
    }
  })();
}

async function rebuildPostgres(evidence, computedAt) {
  const keep = evidence.map((row) => row.connector_instance_id);
  await withPostgresTransaction(async (client) => {
    for (const row of evidence) {
      await client.query(
        `INSERT INTO connector_summary_evidence(
           connector_instance_id, connector_id, display_name, status, source_kind,
           revoked_at, total_records, stream_count, last_record_updated_at,
           dirty, computed_at, source_event_seq, state, last_error
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, NULL, 'fresh', NULL)
         ON CONFLICT (connector_instance_id) DO UPDATE SET
           connector_id = EXCLUDED.connector_id,
           display_name = EXCLUDED.display_name,
           status = EXCLUDED.status,
           source_kind = EXCLUDED.source_kind,
           revoked_at = EXCLUDED.revoked_at,
           total_records = EXCLUDED.total_records,
           stream_count = EXCLUDED.stream_count,
           last_record_updated_at = EXCLUDED.last_record_updated_at,
           dirty = 0,
           computed_at = EXCLUDED.computed_at,
           state = 'fresh',
           last_error = NULL`,
        [
          row.connector_instance_id,
          row.connector_id,
          row.display_name,
          row.status,
          row.source_kind,
          row.revoked_at,
          row.total_records,
          row.stream_count,
          row.last_record_updated_at,
          computedAt,
        ],
      );
    }
    if (keep.length > 0) {
      await client.query(
        `DELETE FROM connector_summary_evidence WHERE connector_instance_id <> ALL($1::text[])`,
        [keep],
      );
    } else {
      await client.query('DELETE FROM connector_summary_evidence');
    }
  });
}

// ---------------------------------------------------------------------------
// Reconcile (light pass over dirty rows only)
// ---------------------------------------------------------------------------

/**
 * Reconcile dirty evidence rows by recomputing only those rows from canonical
 * state. Bounded to "dirty rows only" so it stays cheap relative to a full
 * rebuild. A no-op when no rows are dirty. Returns `{ reconciled }`.
 *
 * A dirty row whose connection has since been deleted is dropped. A dirty row
 * whose connection still exists is refreshed to clean (`dirty = 0`,
 * `state = 'fresh'`).
 */
export async function reconcileDirtyConnectorSummaryEvidence() {
  if (isPostgresStorageBackend()) {
    return reconcileDirtyPostgres();
  }
  return reconcileDirtySqlite();
}

function reconcileDirtySqlite() {
  const db = getDb();
  const dirty = db
    .prepare('SELECT connector_instance_id FROM connector_summary_evidence WHERE dirty <> 0')
    .all();
  if (dirty.length === 0) {
    return { reconciled: 0 };
  }
  const dirtyIds = new Set(dirty.map((r) => r.connector_instance_id));
  const instanceRows = readConnectorInstanceRowsSync(db).filter((row) =>
    dirtyIds.has(row.connector_instance_id),
  );
  const counts = readConnectionCountEvidenceSync(db);
  const recencies = readConnectionRecordRecencyEvidenceSync(db);
  const evidence = buildEvidenceRows(instanceRows, counts, recencies);
  const computedAt = nowIso();
  let reconciled = 0;
  db.transaction(() => {
    const liveIds = new Set(evidence.map((row) => row.connector_instance_id));
    const update = db.prepare(
      `UPDATE connector_summary_evidence SET
         connector_id = ?,
         display_name = ?,
         status = ?,
         source_kind = ?,
         revoked_at = ?,
         total_records = ?,
         stream_count = ?,
         last_record_updated_at = ?,
         dirty = 0,
         computed_at = ?,
         state = 'fresh',
         last_error = NULL
       WHERE connector_instance_id = ?`,
    );
    for (const row of evidence) {
      update.run(
        row.connector_id,
        row.display_name,
        row.status,
        row.source_kind,
        row.revoked_at,
        row.total_records,
        row.stream_count,
        row.last_record_updated_at,
        computedAt,
        row.connector_instance_id,
      );
      reconciled += 1;
    }
    // Dirty rows whose connection vanished from canonical state are dropped.
    const del = db.prepare('DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?');
    for (const id of dirtyIds) {
      if (!liveIds.has(id)) {
        del.run(id);
        reconciled += 1;
      }
    }
  })();
  return { reconciled };
}

// Synchronous SQLite helpers used by reconcile so the whole pass stays inside
// one better-sqlite3 transaction without awaiting across statements.
function readConnectorInstanceRowsSync(db) {
  return db
    .prepare(
      `SELECT connector_instance_id, connector_id, display_name, status, source_kind, revoked_at
         FROM connector_instances
        WHERE owner_subject_id = ?
        ORDER BY connector_instance_id ASC`,
    )
    .all(REFERENCE_OWNER_SUBJECT_ID)
    .map(normalizeInstanceRow);
}

function readConnectionCountEvidenceSync(db) {
  const map = new Map();
  const rows = db
    .prepare(
      `SELECT connector_instance_id,
              COALESCE(SUM(record_count), 0) AS total_records,
              SUM(CASE WHEN record_count > 0 THEN 1 ELSE 0 END) AS stream_count
         FROM retained_size_stream
        GROUP BY connector_instance_id`,
    )
    .all();
  for (const row of rows) {
    map.set(row.connector_instance_id, {
      total_records: Number(row.total_records || 0),
      stream_count: Number(row.stream_count || 0),
    });
  }
  return map;
}

function readConnectionRecordRecencyEvidenceSync(db) {
  const map = new Map();
  const rows = db
    .prepare(
      `SELECT connector_instance_id,
              MAX(emitted_at) AS last_record_updated_at
         FROM records
        WHERE deleted = 0
        GROUP BY connector_instance_id`,
    )
    .all();
  for (const row of rows) {
    map.set(row.connector_instance_id, row.last_record_updated_at || null);
  }
  return map;
}

async function reconcileDirtyPostgres() {
  const dirty = await postgresQuery(
    'SELECT connector_instance_id FROM connector_summary_evidence WHERE dirty <> 0',
  );
  if (dirty.rows.length === 0) {
    return { reconciled: 0 };
  }
  const dirtyIds = new Set(dirty.rows.map((r) => r.connector_instance_id));
  const instanceRows = (await readConnectorInstanceRows()).filter((row) =>
    dirtyIds.has(row.connector_instance_id),
  );
  const counts = await readConnectionCountEvidence();
  const recencies = await readConnectionRecordRecencyEvidence();
  const evidence = buildEvidenceRows(instanceRows, counts, recencies);
  const liveIds = new Set(evidence.map((row) => row.connector_instance_id));
  const computedAt = nowIso();
  let reconciled = 0;
  await withPostgresTransaction(async (client) => {
    for (const row of evidence) {
      await client.query(
        `UPDATE connector_summary_evidence SET
           connector_id = $2,
           display_name = $3,
           status = $4,
           source_kind = $5,
           revoked_at = $6,
           total_records = $7,
           stream_count = $8,
           last_record_updated_at = $9,
           dirty = 0,
           computed_at = $10,
           state = 'fresh',
           last_error = NULL
         WHERE connector_instance_id = $1`,
        [
          row.connector_instance_id,
          row.connector_id,
          row.display_name,
          row.status,
          row.source_kind,
          row.revoked_at,
          row.total_records,
          row.stream_count,
          row.last_record_updated_at,
          computedAt,
        ],
      );
      reconciled += 1;
    }
    for (const id of dirtyIds) {
      if (!liveIds.has(id)) {
        await client.query('DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1', [id]);
        reconciled += 1;
      }
    }
  });
  return { reconciled };
}
