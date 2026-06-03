#!/usr/bin/env node

/**
 * record-current-projection-repair
 *
 * Owner/operator-only operational tool that reconciles the current
 * `records` projection against the authoritative `record_changes`
 * history for a single scoped `(connector_instance_id, stream)` pair.
 *
 * The durable invariant this tool repairs:
 *
 *   For each `(connector_instance_id, stream, record_key)`, the current
 *   `records` row SHALL represent the latest-version `record_changes`
 *   row for that key:
 *     - if the latest history row is non-deleted, a current `records`
 *       row SHALL exist with the same `version` and `record_json`;
 *     - if the latest history row is deleted, there SHALL be no
 *       non-deleted current `records` row.
 *
 * The Chase symptom that motivated this tool: a `transactions` stream
 * whose `record_changes` carried 1,145 distinct keys (latest non-deleted)
 * while the current `records` projection held only 15 rows. The current
 * projection had silently lost 1,130 keys whose authoritative history
 * still says they exist. This class of drift is invisible to version-churn
 * compaction and is a data-integrity bug, not a UI concern.
 *
 * Mismatch classes this tool detects:
 *
 *   - `missing_current`  — latest history row is non-deleted, but no
 *     current `records` row exists. Repair: INSERT the latest history
 *     projection into `records` (idempotent upsert at the existing
 *     latest version; no new version is allocated).
 *   - `stale_current`    — a non-deleted current row exists but its
 *     `version` and/or `record_json` differ from the latest non-deleted
 *     history row. Repair: UPDATE the current row to the latest history
 *     projection.
 *   - `latest_deleted`   — the latest history row is deleted but a
 *     non-deleted current row exists. This is NOT silently resurrected
 *     and is NOT auto-applied. By default it is reported only. It is
 *     applied (current row marked deleted, consistent with the existing
 *     delete projection in postgres-records.js) only when the operator
 *     additionally passes `--apply-deletes`.
 *   - `unresolved_pruned` — the current row carries a `version` that is
 *     newer than every retained `record_changes` row for the key (its
 *     authoritative source row was pruned by PDPP_CHANGE_HISTORY_LIMIT).
 *     The tool cannot prove what the current row should be, so it
 *     refuses to touch it and reports it for manual review.
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (the same credential that grants owner-level
 * access to the reference Postgres). There is no HTTP route. This tool
 * is Postgres-only, matching record-derived-field-backfill.mjs.
 *
 * Output discipline: only aggregate counts, versions, byte counts, and
 * truncated record-key identifiers are printed. Raw record payloads are
 * never written to stdout.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/record-current-projection-repair.mjs \
 *     --connector-instance-id=cin_... \
 *     --stream=transactions \
 *     [--record-key=<key>] \
 *     [--limit=<positive-int>] \
 *     [--apply] \
 *     [--apply-deletes]
 *
 * Env:
 *   PDPP_DATABASE_URL   required (postgres connection string).
 *                       PDPP_TEST_POSTGRES_URL is accepted as a fallback
 *                       so the same CLI can be exercised against a
 *                       throwaway test database.
 *
 * Default is dry-run. Use --apply to write current-row repairs (insert +
 * update). Latest-deleted reconciliation additionally requires
 * --apply-deletes so a delete is never an accidental side effect of a
 * routine projection repair.
 */

import { createHash } from 'node:crypto';
import pg from 'pg';
import process from 'node:process';

const { Pool } = pg;

// Postgres truncates identifiers to 63 bytes. A backup-table name that
// overflows would silently lose its unique stamp tail and could collide
// with another repair, so the name is composed to stay within this bound.
const PG_IDENTIFIER_MAX = 63;

// Backup tables are created with this prefix so an operator can find and
// manually undo a repair. The suffix is a scope hash plus a readable
// cin/stamp fragment. The prefix is kept short so meaningful readable
// fragments still fit inside Postgres' 63-byte identifier limit.
export const BACKUP_TABLE_PREFIX = 'rcpr_backup';

export const MISMATCH_KINDS = Object.freeze({
  MISSING_CURRENT: 'missing_current',
  STALE_CURRENT: 'stale_current',
  LATEST_DELETED: 'latest_deleted',
  UNRESOLVED_PRUNED: 'unresolved_pruned',
});

// ─── Identifier helpers ─────────────────────────────────────────────────

/**
 * Truncate a record_key for human-readable output. Full keys can be
 * personal identifiers (order ids, message ids); the summary only ever
 * needs enough to disambiguate. Keys <= 16 chars pass through; longer
 * keys are head…tail elided.
 */
export function truncateKey(key) {
  const s = String(key ?? '');
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * Validate a connector_instance_id / stream / backup-stamp token against
 * a conservative identifier grammar so they are safe to interpolate into
 * a `CREATE TABLE` name. Parameters cannot be used for identifiers, so
 * the backup-table name is built from validated tokens only.
 */
export function sanitizeIdentifierToken(value, label) {
  const s = String(value ?? '');
  const cleaned = s.replace(/[^A-Za-z0-9]/g, '_').toLowerCase();
  if (!cleaned || cleaned.length > 96) {
    throw new Error(`unsafe ${label} for backup-table name: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

/**
 * Compose a collision-safe backup-table name for a scoped repair that
 * stays within Postgres' 63-byte identifier limit.
 *
 * Structure:
 *   `<prefix>_<hash8>__<cinFragment>__<stamp>`
 *
 *   - `hash8` is the first 8 hex chars of sha256(cin|stream|stamp); it
 *     guarantees uniqueness across scopes even after the readable parts
 *     are truncated, so two repairs never silently collide on a
 *     truncated tail.
 *   - `cinFragment` is a readable head of the (sanitized) instance id
 *     for operator correlation; it is bounded so the whole name fits.
 *   - `stamp` is the caller-passed run stamp, also bounded.
 *
 * The total length is asserted against PG_IDENTIFIER_MAX so an overflow
 * is a loud failure rather than a silent truncation.
 */
export function backupTableName({ connectorInstanceId, stream, stamp }) {
  const cin = sanitizeIdentifierToken(connectorInstanceId, 'connector-instance-id');
  const strm = sanitizeIdentifierToken(stream, 'stream');
  const stmp = sanitizeIdentifierToken(stamp, 'stamp');
  const hash8 = createHash('sha256')
    .update(JSON.stringify([cin, strm, stmp]))
    .digest('hex')
    .slice(0, 8);
  const base = `${BACKUP_TABLE_PREFIX}_${hash8}`;
  // Budget the remaining bytes between the cin fragment and the stamp,
  // favouring the stamp (correlation handle) but keeping a readable cin
  // head. Two `__` separators cost 4 bytes.
  const stampBudget = Math.min(stmp.length, 16);
  const stampPart = stmp.slice(0, stampBudget);
  const remaining = PG_IDENTIFIER_MAX - base.length - 4 - stampPart.length;
  const cinPart = remaining > 0 ? cin.slice(0, remaining) : '';
  const name = `${base}__${cinPart}__${stampPart}`;
  if (name.length > PG_IDENTIFIER_MAX) {
    // Should be unreachable given the budgeting above; fail loudly if not.
    throw new Error(`backup-table name exceeds ${PG_IDENTIFIER_MAX} bytes: ${name}`);
  }
  return name;
}

// ─── Mismatch classification ────────────────────────────────────────────

/**
 * Pure classifier. Given the latest retained `record_changes` row for a
 * key and the current `records` row (or null), decide the mismatch
 * class, or `null` when the projection is already consistent.
 *
 * Inputs are plain row shapes:
 *   latest  = { version, deleted, jsonEqual } | null
 *     - version:   latest retained history version (number)
 *     - deleted:   boolean — latest history row is a delete
 *     - jsonEqual: boolean — current.record_json IS NOT DISTINCT FROM
 *                  latest.record_json (computed in SQL; only meaningful
 *                  when both a current row and a non-deleted latest exist)
 *   current = { version, deleted } | null
 *
 * `latest` is null only when the key has no retained history at all,
 * which the caller never passes (it scans by history). The classifier
 * returns:
 *   - UNRESOLVED_PRUNED when current.version > latest.version (the
 *     authoritative source was pruned; cannot prove correctness).
 *   - LATEST_DELETED when latest.deleted and a non-deleted current exists.
 *   - MISSING_CURRENT when latest is non-deleted and no usable current
 *     row exists (absent or deleted).
 *   - STALE_CURRENT when a non-deleted current exists but version or
 *     json differs from the non-deleted latest.
 *   - null when consistent.
 */
export function classifyMismatch(latest, current) {
  if (!latest) return null;
  const latestVersion = Number(latest.version);

  // A current row strictly newer than all retained history means the
  // source row was pruned away. We cannot reconstruct the truth, and we
  // must not stomp a row whose history we no longer hold.
  if (current && Number(current.version) > latestVersion) {
    return MISMATCH_KINDS.UNRESOLVED_PRUNED;
  }

  if (latest.deleted) {
    // Latest authoritative state is "deleted". Only a non-deleted current
    // row is a mismatch — anything else (no current row, or an already
    // deleted current row) is already consistent.
    if (current && !current.deleted) return MISMATCH_KINDS.LATEST_DELETED;
    return null;
  }

  // Latest authoritative state is a live (non-deleted) row.
  if (!current || current.deleted) {
    return MISMATCH_KINDS.MISSING_CURRENT;
  }
  if (Number(current.version) !== latestVersion || !latest.jsonEqual) {
    return MISMATCH_KINDS.STALE_CURRENT;
  }
  return null;
}

// Only execute the CLI when invoked as a script. Importing this module
// (e.g. from tests) does not parse argv or open a Pool.
const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] || '');

if (invokedAsScript) {
  await runCli();
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;
  const applyDeletes = !!args['apply-deletes'];
  const connectorInstanceId = args['connector-instance-id'];
  const stream = args.stream;
  const recordKey = args['record-key'] || null;
  const limit = parseLimit(args.limit);
  const databaseUrl =
    process.env.PDPP_DATABASE_URL ||
    process.env.PDPP_TEST_POSTGRES_URL ||
    null;

  if (!connectorInstanceId || !stream) {
    console.error(
      'usage: record-current-projection-repair --connector-instance-id=<id> --stream=<name> [--record-key=<key>] [--limit=N] [--apply] [--apply-deletes]',
    );
    process.exit(2);
  }

  if (!databaseUrl) {
    console.error('PDPP_DATABASE_URL is required');
    process.exit(2);
  }

  if (limit === 'invalid') {
    console.error('--limit must be a positive integer');
    process.exit(2);
  }

  // Stamp the backup table from argv + clock. The clock read lives in the
  // CLI (never in the testable core) so runRepair stays deterministic.
  const stamp = `${Date.now()}`;

  const pool = new Pool({ connectionString: databaseUrl });

  let exitCode = 0;
  try {
    const result = await runRepair({
      pool,
      connectorInstanceId,
      stream,
      recordKey,
      limit,
      apply,
      applyDeletes,
      stamp,
    });
    printSummary(result);
    exitCode = result.failed ? 1 : 0;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

/**
 * Parse `--limit`. Returns `null` if unset, a positive integer if
 * valid, or the sentinel string `'invalid'` if the value is present
 * but not a positive integer. Mirrors record-derived-field-backfill.
 */
export function parseLimit(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return 'invalid';
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 'invalid';
  return n;
}

// ─── Detection ──────────────────────────────────────────────────────────

/**
 * Scan the scoped `(connector_instance_id, stream)` pair and return one
 * preview per record_key that violates the current-projection invariant.
 *
 * The scan is driven by the authoritative `record_changes` history: every
 * distinct key with retained history is considered, plus (for safety) any
 * current `records` row whose key has no retained history at all is
 * surfaced as UNRESOLVED_PRUNED rather than silently ignored.
 *
 * Each preview carries only metadata — versions, deleted flags, byte
 * counts, truncated keys — never raw payloads.
 */
export async function detectMismatches({
  pool,
  connectorInstanceId,
  stream,
  recordKey,
  limit,
}) {
  const params = [connectorInstanceId, stream];
  let keyFilter = '';
  if (recordKey) {
    params.push(recordKey);
    keyFilter = `AND lh.record_key = $${params.length}`;
  }
  const limitClause = limit ? `LIMIT ${Number(limit)}` : '';

  // `latest_history` picks the highest-version retained change row per key
  // (DISTINCT ON). Joining the current `records` row lets one query decide
  // every mismatch class. `json_equal` is computed with jsonb structural
  // equality so incidental key-order / whitespace never reads as stale.
  const sql = `
    WITH latest_history AS (
      SELECT DISTINCT ON (record_key)
             record_key,
             version,
             deleted,
             record_json,
             COALESCE(octet_length(record_json::text), 0)::bigint AS history_json_bytes
        FROM record_changes
       WHERE connector_instance_id = $1
         AND stream = $2
       ORDER BY record_key, version DESC
    )
    SELECT lh.record_key,
           lh.version           AS latest_history_version,
           lh.deleted           AS latest_history_deleted,
           lh.history_json_bytes AS latest_history_json_bytes,
           r.version            AS current_version,
           r.deleted            AS current_deleted,
           COALESCE(octet_length(r.record_json::text), 0)::bigint AS current_json_bytes,
           (r.record_key IS NOT NULL) AS current_exists,
           (r.record_json IS NOT DISTINCT FROM lh.record_json) AS json_equal
      FROM latest_history lh
      LEFT JOIN records r
        ON r.connector_instance_id = $1
       AND r.stream = $2
       AND r.record_key = lh.record_key
     WHERE lh.record_key IS NOT NULL
       ${keyFilter}
     ORDER BY lh.record_key
     ${limitClause}
  `;
  const rows = await pool.query(sql, params);

  const previews = [];
  for (const row of rows.rows) {
    const latest = {
      version: Number(row.latest_history_version),
      deleted: row.latest_history_deleted === true,
      jsonEqual: row.json_equal === true,
    };
    const current = row.current_exists
      ? { version: Number(row.current_version), deleted: row.current_deleted === true }
      : null;
    const kind = classifyMismatch(latest, current);
    if (!kind) continue;
    previews.push({
      recordKey: row.record_key,
      kind,
      latestHistoryVersion: latest.version,
      latestHistoryDeleted: latest.deleted,
      latestHistoryJsonBytes: Number(row.latest_history_json_bytes || 0),
      currentExists: row.current_exists === true,
      currentVersion: current ? current.version : null,
      currentDeleted: current ? current.deleted : null,
      currentJsonBytes: row.current_exists ? Number(row.current_json_bytes || 0) : 0,
    });
  }

  // Orphan current rows: a current row whose key has NO retained history
  // at all. With history retained this should never happen, but if it
  // does (e.g. aggressive pruning that removed every version) we cannot
  // prove the row is correct — surface it as unresolved_pruned, never
  // touch it. This is a separate query because the history-driven scan
  // above can't see keys absent from record_changes.
  const orphanParams = [connectorInstanceId, stream];
  let orphanKeyFilter = '';
  if (recordKey) {
    orphanParams.push(recordKey);
    orphanKeyFilter = `AND r.record_key = $${orphanParams.length}`;
  }
  const orphanLimitClause = limit ? `LIMIT ${Number(limit)}` : '';
  const orphans = await pool.query(
    `SELECT r.record_key,
            r.version AS current_version,
            r.deleted AS current_deleted,
            COALESCE(octet_length(r.record_json::text), 0)::bigint AS current_json_bytes
       FROM records r
      WHERE r.connector_instance_id = $1
        AND r.stream = $2
        ${orphanKeyFilter}
        AND NOT EXISTS (
          SELECT 1 FROM record_changes c
           WHERE c.connector_instance_id = $1
             AND c.stream = $2
             AND c.record_key = r.record_key
        )
      ORDER BY r.record_key
      ${orphanLimitClause}`,
    orphanParams,
  );
  for (const row of orphans.rows) {
    previews.push({
      recordKey: row.record_key,
      kind: MISMATCH_KINDS.UNRESOLVED_PRUNED,
      latestHistoryVersion: null,
      latestHistoryDeleted: null,
      latestHistoryJsonBytes: 0,
      currentExists: true,
      currentVersion: Number(row.current_version),
      currentDeleted: row.current_deleted === true,
      currentJsonBytes: Number(row.current_json_bytes || 0),
    });
  }

  return previews;
}

// ─── Repair ─────────────────────────────────────────────────────────────

export async function runRepair({
  pool,
  connectorInstanceId,
  stream,
  recordKey,
  limit,
  apply,
  applyDeletes,
  stamp,
}) {
  const previews = await detectMismatches({
    pool,
    connectorInstanceId,
    stream,
    recordKey,
    limit,
  });

  const counts = countByKind(previews);

  // What an --apply pass would actually mutate. missing_current and
  // stale_current are always repairable. latest_deleted is repairable
  // only under --apply-deletes. unresolved_pruned is never repairable.
  const repairable = previews.filter((p) => isRepairable(p, applyDeletes));

  const result = {
    connectorInstanceId,
    stream,
    previews,
    counts,
    repairableCount: repairable.length,
    applied: !!apply,
    applyDeletes: !!applyDeletes,
    backupTable: null,
    affected: { inserted: 0, updated: 0, deleted: 0 },
    failed: false,
    retainedSizeDirtyMarked: false,
  };

  if (!apply || repairable.length === 0) {
    return result;
  }

  const backupTable = backupTableName({ connectorInstanceId, stream, stamp });
  result.backupTable = backupTable;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Backup table: snapshot the pre-image of every current `records` row
    // this transaction will insert/update/delete, scoped to the affected
    // keys. For missing_current there is no pre-image row, but the key is
    // still recorded (with NULLs) so the backup is a complete manifest of
    // touched keys. The operator can undo by re-deriving from this table.
    const affectedKeys = repairable.map((p) => p.recordKey);
    await client.query(
      `CREATE TABLE "${backupTable}" AS
         SELECT
           $1::text AS connector_instance_id,
           $2::text AS stream,
           k.record_key,
           r.connector_id,
           r.record_json,
           r.emitted_at,
           r.version,
           r.deleted,
           r.deleted_at,
           r.cursor_value,
           r.primary_key_text,
           (r.record_key IS NOT NULL) AS existed_before
         FROM unnest($3::text[]) AS k(record_key)
         LEFT JOIN records r
           ON r.connector_instance_id = $1
          AND r.stream = $2
          AND r.record_key = k.record_key`,
      [connectorInstanceId, stream, affectedKeys],
    );

    for (const p of repairable) {
      if (p.kind === MISMATCH_KINDS.LATEST_DELETED) {
        await applyDeleteRepair({ client, connectorInstanceId, stream, preview: p });
        result.affected.deleted += 1;
      } else {
        const outcome = await applyProjectionRepair({
          client,
          connectorInstanceId,
          stream,
          preview: p,
        });
        if (outcome === 'inserted') result.affected.inserted += 1;
        else result.affected.updated += 1;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    result.failed = true;
    result.error = String(err && err.message ? err.message : err);
    client.release();
    return result;
  }
  client.release();

  // Reconcile the retained-size read model. The repair changed the
  // current `records` projection (and possibly deletes), so the cached
  // per-stream / per-connection / global byte+count rows are now stale.
  // We mark them dirty here (a cheap, idempotent flag write) and print
  // the exact rebuild command in the summary. We do NOT rebuild inline:
  // a global rebuild scans every connector's records and is an
  // owner-initiated operation, not a side effect of a scoped repair.
  try {
    await markRetainedSizeStreamDirtyDirect({ pool, connectorInstanceId, stream });
    result.retainedSizeDirtyMarked = true;
  } catch (err) {
    // Dirty marking is best-effort; the rebuild command still works
    // regardless. Surface the failure without aborting the (already
    // committed) repair.
    result.retainedSizeDirtyError = String(err && err.message ? err.message : err);
  }

  return result;
}

export function isRepairable(preview, applyDeletes) {
  if (preview.kind === MISMATCH_KINDS.MISSING_CURRENT) return true;
  if (preview.kind === MISMATCH_KINDS.STALE_CURRENT) return true;
  if (preview.kind === MISMATCH_KINDS.LATEST_DELETED) return !!applyDeletes;
  return false; // unresolved_pruned is never repairable
}

export function countByKind(previews) {
  const out = {
    [MISMATCH_KINDS.MISSING_CURRENT]: 0,
    [MISMATCH_KINDS.STALE_CURRENT]: 0,
    [MISMATCH_KINDS.LATEST_DELETED]: 0,
    [MISMATCH_KINDS.UNRESOLVED_PRUNED]: 0,
  };
  for (const p of previews) out[p.kind] += 1;
  return out;
}

/**
 * Insert or update the current `records` row to the latest non-deleted
 * `record_changes` projection for the key. No new version is allocated —
 * the current row is set to the authoritative latest history version, so
 * the repair is a true reconciliation and does not perturb
 * `version_counter` or the changes_since cursor space.
 *
 * The latest history row's full payload is copied via a server-side
 * INSERT…SELECT so the raw record_json never crosses the client/network
 * boundary (and never reaches stdout).
 *
 * Returns 'inserted' or 'updated'.
 */
export async function applyProjectionRepair({ client, connectorInstanceId, stream, preview }) {
  const { recordKey, latestHistoryVersion } = preview;
  // cursor_value mirrors the runtime ingest path: it stores the encoded
  // record_key. primary_key_text likewise defaults to the record_key.
  // (The runtime stores recordKey for both; see postgresIngestRecord.)
  const res = await client.query(
    `WITH latest AS (
       SELECT c.connector_id, c.connector_instance_id, c.stream, c.record_key,
              c.record_json, c.emitted_at, c.version
         FROM record_changes c
        WHERE c.connector_instance_id = $1
          AND c.stream = $2
          AND c.record_key = $3
          AND c.version = $5
          AND c.deleted = FALSE
          AND NOT EXISTS (
            SELECT 1
              FROM record_changes newer
             WHERE newer.connector_instance_id = c.connector_instance_id
               AND newer.stream = c.stream
               AND newer.record_key = c.record_key
               AND newer.version > c.version
          )
     )
     INSERT INTO records
       (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
     SELECT latest.connector_id, latest.connector_instance_id, latest.stream, latest.record_key,
            latest.record_json, latest.emitted_at, latest.version, FALSE, NULL, $4, $4
       FROM latest
     ON CONFLICT (connector_instance_id, stream, record_key) DO UPDATE
       SET connector_id = EXCLUDED.connector_id,
           record_json = EXCLUDED.record_json,
           emitted_at = EXCLUDED.emitted_at,
           version = EXCLUDED.version,
           deleted = FALSE,
           deleted_at = NULL,
           cursor_value = EXCLUDED.cursor_value,
           primary_key_text = EXCLUDED.primary_key_text
       WHERE records.version <= EXCLUDED.version
     RETURNING (xmax = 0) AS inserted`,
    [connectorInstanceId, stream, recordKey, recordKey, latestHistoryVersion],
  );
  if (res.rowCount === 0) {
    // The row is no longer the latest retained history version, it was pruned,
    // or current already advanced beyond it. Fail the transaction rather than
    // stomping newer owner data with a stale precomputed preview.
    throw new Error(
      `latest history version ${latestHistoryVersion} for key is no longer safe to project at apply time`,
    );
  }
  return res.rows[0]?.inserted ? 'inserted' : 'updated';
}

/**
 * Mark the current `records` row deleted, consistent with the latest
 * deleted history row and with the runtime delete projection in
 * postgres-records.js (sets deleted/deleted_at/version/emitted_at from
 * the authoritative delete row). No new version is allocated; the row is
 * aligned to the existing latest deleted history version.
 */
export async function applyDeleteRepair({ client, connectorInstanceId, stream, preview }) {
  const { recordKey, latestHistoryVersion } = preview;
  const res = await client.query(
    `UPDATE records r
        SET deleted = TRUE,
            deleted_at = COALESCE(c.deleted_at, c.emitted_at),
            emitted_at = c.emitted_at,
            version = c.version,
            connector_id = c.connector_id
       FROM record_changes c
      WHERE r.connector_instance_id = $1
        AND r.stream = $2
        AND r.record_key = $3
        AND c.connector_instance_id = $1
        AND c.stream = $2
        AND c.record_key = $3
        AND c.version = $4
        AND c.deleted = TRUE
        AND r.version <= c.version
        AND NOT EXISTS (
          SELECT 1
            FROM record_changes newer
           WHERE newer.connector_instance_id = c.connector_instance_id
             AND newer.stream = c.stream
             AND newer.record_key = c.record_key
             AND newer.version > c.version
        )`,
    [connectorInstanceId, stream, recordKey, latestHistoryVersion],
  );
  if (res.rowCount === 0) {
    throw new Error(
      `delete repair for version ${latestHistoryVersion} is no longer safe to project at apply time`,
    );
  }
}

/**
 * Mark the retained-size read model dirty for the scoped stream and its
 * connection, plus the global projection, using direct SQL. This mirrors
 * markRetainedSizeStreamDirty in retained-size-read-model.js without
 * importing the server module (which would bootstrap a DB connection and
 * pull in the SQLite default). All writes are guarded by table existence
 * so a deployment without the read model (or a bare test schema) does not
 * error.
 */
async function markRetainedSizeStreamDirtyDirect({ pool, connectorInstanceId, stream }) {
  const exists = await pool.query(
    `SELECT to_regclass('public.retained_size_stream') AS s,
            to_regclass('public.retained_size_connection') AS c,
            to_regclass('public.retained_size_global') AS g`,
  );
  const reg = exists.rows[0] || {};
  if (reg.s) {
    await pool.query(
      `UPDATE retained_size_stream SET dirty = 1 WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream],
    );
  }
  if (reg.c) {
    await pool.query(
      `UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = $1`,
      [connectorInstanceId],
    );
  }
  if (reg.g) {
    await pool.query(
      `UPDATE retained_size_global SET dirty = 1 WHERE projection_key = 'global'`,
    );
  }
}

// ─── Output ─────────────────────────────────────────────────────────────

function printSummary(result) {
  const mode = result.applied ? 'APPLIED' : 'DRY-RUN';
  console.log(
    `record-current-projection-repair: ${mode} — connection=${result.connectorInstanceId} stream=${result.stream}`,
  );
  console.log(
    `  mismatches: missing_current=${result.counts.missing_current} ` +
      `stale_current=${result.counts.stale_current} ` +
      `latest_deleted=${result.counts.latest_deleted} ` +
      `unresolved_pruned=${result.counts.unresolved_pruned}`,
  );
  console.log(
    `  repairable this mode: ${result.repairableCount}` +
      (result.applyDeletes ? ' (deletes enabled)' : ' (deletes NOT enabled; pass --apply-deletes to reconcile latest_deleted)'),
  );

  if (result.applied) {
    console.log(
      `  applied: inserted=${result.affected.inserted} updated=${result.affected.updated} deleted=${result.affected.deleted}`,
    );
    if (result.backupTable) {
      console.log(`  backup table: ${result.backupTable}`);
    }
    if (result.failed) {
      console.log(`  status: FAILED — transaction rolled back: ${result.error}`);
    } else if (result.retainedSizeDirtyMarked) {
      console.log('  retained-size read model: marked dirty (rebuild to refresh)');
      console.log('  follow-up (owner): refresh the retained-size read model so the dashboard size is correct:');
      console.log('    POST /v1/_ref/dataset/retained-size/rebuild   (owner-authenticated)');
      console.log('    — or call rebuildRetainedSize() from reference-implementation/server/retained-size-read-model.js');
    } else if (result.retainedSizeDirtyError) {
      console.log(`  retained-size read model: dirty-mark failed (${result.retainedSizeDirtyError}); rebuild still required`);
    }
  } else if (result.repairableCount > 0) {
    console.log('  re-run with --apply to write these repairs (a backup table is created first).');
  }

  // Per-row preview, truncated keys only, capped.
  for (const p of result.previews.slice(0, 20)) {
    console.log(
      `  ${p.kind.padEnd(18)} key=${truncateKey(p.recordKey)} ` +
        `latest_history_version=${p.latestHistoryVersion ?? '-'} ` +
        `latest_deleted=${p.latestHistoryDeleted ?? '-'} ` +
        `current_version=${p.currentVersion ?? '-'} ` +
        `current_deleted=${p.currentDeleted ?? '-'}`,
    );
  }
  if (result.previews.length > 20) {
    console.log(`  … and ${result.previews.length - 20} more`);
  }
}

// ─── Argv parsing (no deps) ─────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}
