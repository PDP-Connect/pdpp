#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0


/**
 * record-current-projection-scan-all
 *
 * Owner/operator-only, READ-ONLY, payload-free drift scanner that audits the
 * current `records` projection against the authoritative `record_changes`
 * history across EVERY `(connector_instance_id, stream)` in the Postgres store
 * at once. It is the all-stream complement to the per-scope
 * `record-current-projection-repair.mjs`: that tool fixes one stream; this one
 * answers "where is there drift anywhere, and of exactly what class?".
 *
 * It never writes. It never prints raw record payloads, personal text,
 * secrets, cookies, or tokens. Every preview line carries only versions,
 * deleted flags, byte counts, payload-equality booleans, and truncated
 * record-key / connector-instance identifiers. The payload comparison
 * (`record_json IS NOT DISTINCT FROM`) happens inside SQL so the bytes never
 * cross the client boundary.
 *
 * Why a finer taxonomy than the repair tool:
 *   The repair tool collapses every "current is newer than retained history"
 *   case into a single `unresolved_pruned` bucket and every version/payload
 *   disagreement into `stale_current`. For remediation planning we need to
 *   split those, because the SAFE action differs:
 *
 *     - missing_current
 *         latest retained history is non-deleted, but no usable current row.
 *         REMEDIATION: project the latest retained history into `records`
 *         (the repair tool's missing_current path; no new version).
 *
 *     - latest_deleted
 *         latest retained history is a tombstone, but a non-deleted current
 *         row survives. REMEDIATION: owner-gated delete reconciliation
 *         (repair tool `--apply-deletes`); never auto-applied.
 *
 *     - current_payload_matches_latest_history_but_version_differs
 *         a live current row whose version != the latest retained history
 *         version, but whose PAYLOAD is byte-equal to that latest history row.
 *         REMEDIATION: SAFE current-version correction — align `records.version`
 *         to the latest retained history version. No source resync needed; the
 *         payload is already provably correct.
 *
 *     - unverified_current_payload_differs_from_latest_history
 *         a live current row whose version != the latest retained history
 *         version AND whose payload DIFFERS from it. The retained history
 *         cannot prove which side is right. REMEDIATION: source resync (re-run
 *         the connector) — NOT a blind version stomp.
 *
 *     - current_version_newer_than_retained_history
 *         the current row's version is strictly greater than EVERY retained
 *         history row for the key. The anchoring history row was pruned away.
 *         REMEDIATION: requires source resync OR an explicit, owner-gated
 *         synthetic maintenance anchor (write a new `record_changes` row that
 *         re-anchors the current payload at a fresh version). Never silent.
 *
 *     - current_no_retained_history
 *         the current row's key has NO retained `record_changes` at all (the
 *         torn-bulk-delete / fully-pruned signature). Same remediation class as
 *         current_version_newer_than_retained_history: resync or owner-gated
 *         synthetic anchor.
 *
 *     - stale_current
 *         a live current row BEHIND the latest non-deleted retained history
 *         (current.version < latest.version). This is a genuine projection lag
 *         the repair tool fixes by projecting the latest retained history
 *         (no new version). Split out from the payload-equal/differ cases above
 *         because here we DO hold the authoritative newer row.
 *
 * The anchor-preservation prune fix (records.js / postgres-records.js) makes
 * the `current_*_history` classes structurally impossible to CREATE going
 * forward; this scanner exists to (a) find the residue that pre-fix pruning
 * already stranded and (b) prove, post-deploy, that the residue is bounded and
 * each row is dispositioned by class.
 *
 * Authorization is by direct database access (`PDPP_DATABASE_URL`), matching
 * the other repair tools. There is no HTTP route and no scheduler.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/record-current-projection-scan-all.mjs \
 *     [--connector-id=<id>] \
 *     [--limit-per-stream=<positive-int>] \
 *     [--json]
 *
 *   --connector-id        optional filter to a single connector_id.
 *   --limit-per-stream    optional cap on preview rows surfaced per stream
 *                         (the aggregate counts are always complete).
 *   --json                emit a machine-readable JSON summary instead of the
 *                         human table (still payload-free).
 *
 * Env:
 *   PDPP_DATABASE_URL     required (postgres connection string).
 *                         PDPP_TEST_POSTGRES_URL is accepted as a fallback.
 *
 * Exit codes:
 *   0  no drift found.
 *   1  drift found (any class). The scan still completed; this is the
 *      "needs remediation" signal an operator/CI can branch on.
 *   2  usage / configuration error.
 */

import pg from 'pg';
import process from 'node:process';

const { Pool } = pg;

export const SCAN_DRIFT_KINDS = Object.freeze({
  MISSING_CURRENT: 'missing_current',
  STALE_CURRENT: 'stale_current',
  LATEST_DELETED: 'latest_deleted',
  CURRENT_NO_RETAINED_HISTORY: 'current_no_retained_history',
  CURRENT_VERSION_NEWER_THAN_RETAINED_HISTORY: 'current_version_newer_than_retained_history',
  CURRENT_PAYLOAD_MATCHES_LATEST_HISTORY_BUT_VERSION_DIFFERS:
    'current_payload_matches_latest_history_but_version_differs',
  UNVERIFIED_CURRENT_PAYLOAD_DIFFERS_FROM_LATEST_HISTORY:
    'unverified_current_payload_differs_from_latest_history',
});

// Remediation disposition per class — consumed by the summary and by an
// operator deciding which tool to reach for. Kept here as the single source of
// truth so the scanner's output and any downstream runbook agree.
export const REMEDIATION_BY_KIND = Object.freeze({
  [SCAN_DRIFT_KINDS.MISSING_CURRENT]:
    'repairable_from_latest_retained_history',
  [SCAN_DRIFT_KINDS.STALE_CURRENT]:
    'repairable_from_latest_retained_history',
  [SCAN_DRIFT_KINDS.LATEST_DELETED]:
    'owner_gated_delete_reconciliation',
  [SCAN_DRIFT_KINDS.CURRENT_PAYLOAD_MATCHES_LATEST_HISTORY_BUT_VERSION_DIFFERS]:
    'safe_current_version_correction',
  [SCAN_DRIFT_KINDS.UNVERIFIED_CURRENT_PAYLOAD_DIFFERS_FROM_LATEST_HISTORY]:
    'source_resync_required',
  [SCAN_DRIFT_KINDS.CURRENT_VERSION_NEWER_THAN_RETAINED_HISTORY]:
    'source_resync_or_owner_gated_synthetic_anchor',
  [SCAN_DRIFT_KINDS.CURRENT_NO_RETAINED_HISTORY]:
    'source_resync_or_owner_gated_synthetic_anchor',
});

// ─── Identifier helper ──────────────────────────────────────────────────

/** Truncate any identifier for payload-free output (head…tail elision). */
export function truncateId(value) {
  const s = String(value ?? '');
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

// ─── Pure classifier ────────────────────────────────────────────────────

/**
 * Decide the fine-grained drift class for one key, or `null` when consistent.
 *
 *   history = {
 *     hasRetained: boolean,        // any retained record_changes for the key
 *     latestVersion: number|null,  // MAX retained version (null if none)
 *     latestDeleted: boolean,      // latest retained row is a tombstone
 *     jsonEqualToCurrent: boolean, // current.record_json IS NOT DISTINCT FROM
 *                                  //   the latest retained row's record_json
 *   }
 *   current = { version: number, deleted: boolean } | null
 *
 * Consistency (returns null):
 *   - current non-deleted, latest non-deleted, same version, payload equal.
 *   - current deleted/absent, latest deleted.
 *
 * Precedence is deliberate: the "current outran retained history" classes are
 * decided first, because once the anchor is gone we cannot trust a payload or
 * version comparison against a stale latest row.
 */
export function classifyScanDrift(history, current) {
  // No current row: only a non-deleted latest history is a problem.
  if (!current || current.deleted) {
    if (history.hasRetained && !history.latestDeleted) {
      return SCAN_DRIFT_KINDS.MISSING_CURRENT;
    }
    return null;
  }

  // A live current row with NO retained history at all.
  if (!history.hasRetained) {
    return SCAN_DRIFT_KINDS.CURRENT_NO_RETAINED_HISTORY;
  }

  const latestVersion = Number(history.latestVersion);

  // A live current row strictly newer than every retained history row: the
  // anchoring row was pruned. Decide this before deleted/version/payload
  // checks — the latest retained row is no longer the current row's source.
  if (Number(current.version) > latestVersion) {
    return SCAN_DRIFT_KINDS.CURRENT_VERSION_NEWER_THAN_RETAINED_HISTORY;
  }

  // Latest retained state is a tombstone but the current row is still live.
  if (history.latestDeleted) {
    return SCAN_DRIFT_KINDS.LATEST_DELETED;
  }

  // Latest retained state is live; current row is at-or-before it.
  if (Number(current.version) === latestVersion) {
    // Same version: consistent iff the payloads agree. A same-version payload
    // disagreement is genuine stale_current (the projection holds a different
    // body than the authoritative row at the same version).
    return history.jsonEqualToCurrent ? null : SCAN_DRIFT_KINDS.STALE_CURRENT;
  }

  // current.version < latestVersion: the projection lags a newer retained row.
  // Split by payload equality so remediation can pick the safe path:
  //   payload equal  → safe version correction (no resync).
  //   payload differ → cannot prove; source resync.
  return history.jsonEqualToCurrent
    ? SCAN_DRIFT_KINDS.CURRENT_PAYLOAD_MATCHES_LATEST_HISTORY_BUT_VERSION_DIFFERS
    : SCAN_DRIFT_KINDS.UNVERIFIED_CURRENT_PAYLOAD_DIFFERS_FROM_LATEST_HISTORY;
}

export function emptyCounts() {
  const out = {};
  for (const kind of Object.values(SCAN_DRIFT_KINDS)) out[kind] = 0;
  return out;
}

// ─── Scan ───────────────────────────────────────────────────────────────

/**
 * Scan every `(connector_instance_id, stream)` (optionally filtered to one
 * connector_id) and return { rows, counts } where `rows` is one payload-free
 * preview per drifting key and `counts` is the per-class aggregate.
 *
 * The query is driven by the union of (a) keys with retained history and
 * (b) live current rows, so both "history exists, current missing" and
 * "current exists, history pruned" are visible in one pass. `json_equal` uses
 * jsonb structural equality so incidental key-order / whitespace never reads
 * as a payload difference.
 */
export async function scanAll({ pool, connectorId, limitPerStream }) {
  const params = [];
  let connectorFilter = '';
  if (connectorId) {
    params.push(connectorId);
    connectorFilter = `AND base.connector_id = $${params.length}`;
  }

  // latest_history: the highest-version retained row per key (DISTINCT ON).
  // full_keys: every (cin, stream, key) seen in EITHER table, so orphan current
  // rows (no history) and missing current rows (history only) both appear.
  const sql = `
    WITH latest_history AS (
      SELECT DISTINCT ON (connector_instance_id, stream, record_key)
             connector_instance_id, stream, record_key,
             version  AS latest_history_version,
             deleted  AS latest_history_deleted,
             record_json AS latest_history_json
        FROM record_changes
       ORDER BY connector_instance_id, stream, record_key, version DESC
    ),
    full_keys AS (
      SELECT connector_id, connector_instance_id, stream, record_key
        FROM record_changes
      UNION
      SELECT connector_id, connector_instance_id, stream, record_key
        FROM records
    )
    SELECT base.connector_instance_id,
           base.stream,
           base.record_key,
           lh.latest_history_version,
           lh.latest_history_deleted,
           (lh.connector_instance_id IS NOT NULL) AS has_retained,
           r.version  AS current_version,
           r.deleted  AS current_deleted,
           (r.record_key IS NOT NULL) AS current_exists,
           (r.record_json IS NOT DISTINCT FROM lh.latest_history_json) AS json_equal
      FROM (SELECT DISTINCT connector_id, connector_instance_id, stream, record_key FROM full_keys) base
      LEFT JOIN latest_history lh
        ON lh.connector_instance_id = base.connector_instance_id
       AND lh.stream = base.stream
       AND lh.record_key = base.record_key
      LEFT JOIN records r
        ON r.connector_instance_id = base.connector_instance_id
       AND r.stream = base.stream
       AND r.record_key = base.record_key
     WHERE TRUE ${connectorFilter}
     ORDER BY base.connector_instance_id, base.stream, base.record_key
  `;

  const result = await pool.query(sql, params);

  const counts = emptyCounts();
  const perStreamShown = new Map();
  const rows = [];
  let totalDrift = 0;

  for (const row of result.rows) {
    const history = {
      hasRetained: row.has_retained === true,
      latestVersion: row.latest_history_version == null ? null : Number(row.latest_history_version),
      latestDeleted: row.latest_history_deleted === true,
      jsonEqualToCurrent: row.json_equal === true,
    };
    const current = row.current_exists === true
      ? { version: Number(row.current_version), deleted: row.current_deleted === true }
      : null;
    const kind = classifyScanDrift(history, current);
    if (!kind) continue;

    counts[kind] += 1;
    totalDrift += 1;

    // Cap per-stream PREVIEW rows (counts stay complete).
    const streamKey = `${row.connector_instance_id} ${row.stream}`;
    const shown = perStreamShown.get(streamKey) || 0;
    if (limitPerStream && shown >= limitPerStream) continue;
    perStreamShown.set(streamKey, shown + 1);

    rows.push({
      connectorInstanceId: row.connector_instance_id,
      stream: row.stream,
      recordKey: row.record_key,
      kind,
      remediation: REMEDIATION_BY_KIND[kind],
      latestHistoryVersion: history.latestVersion,
      latestHistoryDeleted: history.hasRetained ? history.latestDeleted : null,
      currentExists: current != null,
      currentVersion: current ? current.version : null,
      currentDeleted: current ? current.deleted : null,
      payloadEqualToLatestHistory: history.hasRetained && current != null ? history.jsonEqualToCurrent : null,
    });
  }

  return { rows, counts, totalDrift };
}

// ─── Output ─────────────────────────────────────────────────────────────

export function formatScanSummary({ counts, totalDrift, rows }) {
  const lines = [];
  lines.push(`record-current-projection-scan-all: total_drift=${totalDrift}`);
  for (const kind of Object.values(SCAN_DRIFT_KINDS)) {
    lines.push(`  ${kind.padEnd(56)} ${counts[kind]}  → ${REMEDIATION_BY_KIND[kind]}`);
  }
  if (rows.length) {
    lines.push('  drift previews (payload-free):');
    for (const p of rows) {
      lines.push(
        `    ${p.kind.padEnd(56)} cin=${truncateId(p.connectorInstanceId)} ` +
          `stream=${p.stream} key=${truncateId(p.recordKey)} ` +
          `latest_history_version=${p.latestHistoryVersion ?? '-'} ` +
          `latest_deleted=${p.latestHistoryDeleted ?? '-'} ` +
          `current_version=${p.currentVersion ?? '-'} ` +
          `current_deleted=${p.currentDeleted ?? '-'} ` +
          `payload_equal=${p.payloadEqualToLatestHistory ?? '-'}`,
      );
    }
  }
  return lines.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
      else out[arg.slice(2)] = true;
    }
  }
  return out;
}

export function parsePositiveIntOrNull(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return 'invalid';
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 'invalid';
  return n;
}

const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] || '');

if (invokedAsScript) {
  await runCli();
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const connectorId = args['connector-id'] || null;
  const asJson = !!args.json;
  const limitPerStream = parsePositiveIntOrNull(args['limit-per-stream']);
  const databaseUrl =
    process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;

  if (!databaseUrl) {
    console.error('PDPP_DATABASE_URL is required');
    process.exit(2);
  }
  if (limitPerStream === 'invalid') {
    console.error('--limit-per-stream must be a positive integer');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const result = await scanAll({ pool, connectorId, limitPerStream });
    if (asJson) {
      // JSON is payload-free by construction: previews carry only metadata.
      console.log(JSON.stringify({ counts: result.counts, totalDrift: result.totalDrift, rows: result.rows }, null, 2));
    } else {
      console.log(formatScanSummary(result));
    }
    exitCode = result.totalDrift > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}
