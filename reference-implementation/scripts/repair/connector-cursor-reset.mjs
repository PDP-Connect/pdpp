#!/usr/bin/env node

/**
 * connector-cursor-reset
 *
 * Owner/operator-only operational tool that resets the incremental-sync
 * cursor for one or more explicit `(connector_instance_id, stream)` pairs by
 * setting `connector_state.state_json` to an empty object (`{}`).
 *
 * Why this tool exists
 * ────────────────────
 * Anchor-preserving pruning (records.js / postgres-records.js) makes the
 * `current_*_history` drift classes structurally impossible to CREATE going
 * forward, and ingest self-heals an unanchored current row on the next
 * unchanged re-emit. But a scheduled INCREMENTAL run does not re-emit a cold
 * stranded key: the connector reads its stored cursor (e.g. github issues
 * `last_updated_at`) and asks the source only for rows changed since then, so
 * a key whose anchor was pruned before the fix shipped never re-enters the
 * stream and never self-heals. The owner-gated recovery for that residue is a
 * FULL source resync — and the lever that turns an incremental run into a full
 * resync is clearing the connector's stored cursor.
 *
 * There is no HTTP route or scheduler hook that resets a cursor; the only
 * mechanism is a direct `connector_state` write. Doing that by hand is
 * error-prone (wrong instance, wrong stream, no pre-image to undo, no scoping
 * guard against blanking every stream at once). This tool makes the operation
 * scoped, dry-run by default, and reversible.
 *
 * What it does NOT do
 * ───────────────────
 *   - It never triggers a run. After a reset the owner triggers the run
 *     explicitly (POST /v1/owner/connections/:id/run) and then reconciles and
 *     re-scans. Decoupling the reset from the run keeps each step auditable.
 *   - It never touches `records` or `record_changes`. The re-anchoring happens
 *     in the ingest path during the subsequent run (self-heal), not here.
 *   - It refuses to operate without at least one explicit `--stream`. There is
 *     deliberately no "reset all streams" mode: a blanket cursor wipe would
 *     force a full re-scan of every stream and is never the minimal action.
 *
 * Safety model
 * ────────────
 *   - Default is dry-run. `--apply` is required to write.
 *   - Before any write, the prior `state_json` for every targeted pair is
 *     snapshotted into a backup table (prefix `ccr_backup`) so the operator can
 *     restore the exact pre-image. The backup is taken inside the same
 *     transaction as the reset.
 *   - Only streams that actually have a `connector_state` row are reset; a
 *     `--stream` with no stored cursor is reported as `absent` and skipped (a
 *     missing cursor already behaves as "no since filter").
 *
 * Output discipline
 * ─────────────────
 * Cursor values are not record payloads, but they can carry source-side
 * timestamps and fingerprints. This tool never prints cursor VALUES. It prints
 * only: the truncated connector-instance id, the stream name, whether a prior
 * cursor existed, and the action taken. The pre-image lives in the backup
 * table for the operator to inspect directly under their own authorization.
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (the same credential that grants owner-level access to
 * the reference Postgres). Postgres-only, matching the sibling repair tools.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/connector-cursor-reset.mjs \
 *     --connector-instance-id=cin_... \
 *     --stream=issues [--stream=pull_requests --stream=repositories] \
 *     [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL   required (postgres connection string).
 *                       PDPP_TEST_POSTGRES_URL is accepted as a fallback so the
 *                       same CLI can run against a throwaway test database.
 *
 * Exit codes:
 *   0  dry-run completed, or apply completed successfully.
 *   1  apply failed (transaction rolled back).
 *   2  usage / configuration error (missing id, no streams, no DB url).
 */

import { createHash } from 'node:crypto';
import pg from 'pg';
import process from 'node:process';

const { Pool } = pg;

// Postgres truncates identifiers to 63 bytes; the backup-table name is
// composed to stay within this bound (same discipline as the projection
// repair tool's backup-table naming).
const PG_IDENTIFIER_MAX = 63;

// Backup tables are created with this prefix so an operator can find and
// restore a pre-reset cursor snapshot.
export const BACKUP_TABLE_PREFIX = 'ccr_backup';

// ─── Identifier helpers ─────────────────────────────────────────────────

/** Truncate any identifier for payload-free output (head…tail elision). */
export function truncateId(value) {
  const s = String(value ?? '');
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * Validate a token against a conservative identifier grammar so it is safe to
 * interpolate into a `CREATE TABLE` name. Parameters cannot be used for
 * identifiers, so the backup-table name is built from validated tokens only.
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
 * Compose a collision-safe backup-table name for a scoped reset that stays
 * within Postgres' 63-byte identifier limit.
 *
 *   `<prefix>_<hash8>__<cinFragment>__<stamp>`
 *
 * `hash8` (sha256 of cin|sortedStreams|stamp) guarantees uniqueness across
 * scopes even after the readable parts are truncated.
 */
export function backupTableName({ connectorInstanceId, streams, stamp }) {
  const cin = sanitizeIdentifierToken(connectorInstanceId, 'connector-instance-id');
  const stmp = sanitizeIdentifierToken(stamp, 'stamp');
  const streamKey = [...streams].sort().join(',');
  const hash8 = createHash('sha256')
    .update(JSON.stringify([cin, streamKey, stmp]))
    .digest('hex')
    .slice(0, 8);
  const base = `${BACKUP_TABLE_PREFIX}_${hash8}`;
  const stampBudget = Math.min(stmp.length, 16);
  const stampPart = stmp.slice(0, stampBudget);
  const remaining = PG_IDENTIFIER_MAX - base.length - 4 - stampPart.length;
  const cinPart = remaining > 0 ? cin.slice(0, remaining) : '';
  const name = `${base}__${cinPart}__${stampPart}`;
  if (name.length > PG_IDENTIFIER_MAX) {
    throw new Error(`backup-table name exceeds ${PG_IDENTIFIER_MAX} bytes: ${name}`);
  }
  return name;
}

// ─── Argument parsing ───────────────────────────────────────────────────

/**
 * Parse argv into { connectorInstanceId, streams[], apply }. `--stream` is
 * repeatable; duplicates are de-duplicated preserving first-seen order.
 */
export function parseArgs(argv) {
  const out = { connectorInstanceId: null, streams: [], apply: false };
  const seen = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const val = eq > 0 ? arg.slice(eq + 1) : true;
    if (key === 'connector-instance-id') out.connectorInstanceId = String(val);
    else if (key === 'stream') {
      const s = String(val);
      if (s && !seen.has(s)) {
        seen.add(s);
        out.streams.push(s);
      }
    } else if (key === 'apply') out.apply = true;
  }
  return out;
}

/**
 * Validate parsed args. Returns an error string or null. Enforces that an
 * explicit instance id and at least one stream are present — there is no
 * blanket reset.
 */
export function validateArgs({ connectorInstanceId, streams }) {
  if (!connectorInstanceId) return '--connector-instance-id is required';
  if (!streams || streams.length === 0) {
    return 'at least one --stream is required (there is no reset-all mode)';
  }
  return null;
}

// ─── Reset ──────────────────────────────────────────────────────────────

/**
 * Reset the cursors for the given (connector_instance_id, streams). In dry-run
 * (apply=false) it reports which targeted streams currently have a stored
 * cursor and which are absent, and writes nothing. In apply mode it snapshots
 * the pre-image into a backup table and sets `state_json` to `'{}'::jsonb` for
 * the present streams, all in one transaction.
 *
 * Returns a payload-free summary:
 *   {
 *     connectorInstanceId, streams,
 *     present: string[],   // streams that had a stored cursor
 *     absent:  string[],   // targeted streams with no connector_state row
 *     applied: boolean,
 *     backupTable: string|null,
 *     resetCount: number,  // rows actually reset (apply only)
 *     failed: boolean, error?: string
 *   }
 */
export async function runCursorReset({ pool, connectorInstanceId, streams, apply, stamp }) {
  // Which targeted streams actually have a stored cursor today.
  const presentResult = await pool.query(
    `SELECT stream FROM connector_state
      WHERE connector_instance_id = $1 AND stream = ANY($2::text[])`,
    [connectorInstanceId, streams],
  );
  const presentSet = new Set(presentResult.rows.map((r) => r.stream));
  const present = streams.filter((s) => presentSet.has(s));
  const absent = streams.filter((s) => !presentSet.has(s));

  const result = {
    connectorInstanceId,
    streams,
    present,
    absent,
    applied: !!apply,
    backupTable: null,
    resetCount: 0,
    failed: false,
  };

  if (!apply || present.length === 0) {
    return result;
  }

  const backupTable = backupTableName({ connectorInstanceId, streams: present, stamp });
  result.backupTable = backupTable;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Snapshot the pre-image cursor for every present stream before the reset.
    // The backup carries the full prior state_json so the operator can restore
    // the exact cursor, plus updated_at for provenance. This table is the undo
    // path; its contents are owner-only and never printed by this tool.
    await client.query(
      `CREATE TABLE "${backupTable}" AS
         SELECT connector_id, connector_instance_id, stream, state_json, updated_at
           FROM connector_state
          WHERE connector_instance_id = $1 AND stream = ANY($2::text[])`,
      [connectorInstanceId, present],
    );

    const reset = await client.query(
      `UPDATE connector_state
          SET state_json = '{}'::jsonb,
              updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE connector_instance_id = $1 AND stream = ANY($2::text[])`,
      [connectorInstanceId, present],
    );
    result.resetCount = reset.rowCount || 0;

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
  return result;
}

// ─── Output ─────────────────────────────────────────────────────────────

export function formatSummary(result) {
  const lines = [];
  const mode = result.applied ? 'APPLY' : 'DRY-RUN';
  lines.push(
    `connector-cursor-reset [${mode}]: cin=${truncateId(result.connectorInstanceId)} ` +
      `targeted=${result.streams.length} present=${result.present.length} absent=${result.absent.length}`,
  );
  for (const s of result.present) {
    lines.push(`  present  ${s}  → ${result.applied ? 'reset to {}' : 'would reset to {}'}`);
  }
  for (const s of result.absent) {
    lines.push(`  absent   ${s}  → no stored cursor; skipped (already behaves as no-since)`);
  }
  if (result.applied) {
    if (result.failed) {
      lines.push(`  FAILED: ${result.error} (transaction rolled back; no cursor changed)`);
    } else {
      lines.push(`  reset_count=${result.resetCount} backup_table=${result.backupTable}`);
      lines.push(
        '  next: trigger a run (POST /v1/owner/connections/<cin>/run), then ' +
          'POST /_ref/dataset/size/reconcile, then re-scan for drift.',
      );
    }
  } else if (result.present.length > 0) {
    lines.push('  (dry-run) re-run with --apply to reset the present cursors.');
  }
  return lines.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────

const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] || '');

if (invokedAsScript) {
  await runCli();
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const validationError = validateArgs(args);
  if (validationError) {
    console.error(validationError);
    process.exit(2);
  }
  const databaseUrl =
    process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error('PDPP_DATABASE_URL is required');
    process.exit(2);
  }

  // A reproducible, sortable stamp for the backup-table name. Date is read
  // once here at the CLI boundary (not inside the pure helpers).
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const result = await runCursorReset({
      pool,
      connectorInstanceId: args.connectorInstanceId,
      streams: args.streams,
      apply: args.apply,
      stamp,
    });
    console.log(formatSummary(result));
    exitCode = result.failed ? 1 : 0;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}
