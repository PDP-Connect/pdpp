// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Current-projection invariant checker (test-only, SQLite).
 *
 * This is the payload-free, storage-read counterpart to the operator repair
 * tool `scripts/repair/record-current-projection-repair.mjs`. The repair tool
 * *fixes* drift in a live Postgres database; this helper *detects* the same
 * drift class against the SQLite reference store so a mutation/delete test can
 * assert, after any operation, that the current `records` projection still
 * agrees with the authoritative `record_changes` history.
 *
 * The durable invariant (identical to the repair tool's docstring):
 *
 *   For each (connector_instance_id, stream, record_key), the current
 *   `records` row SHALL represent the latest-version retained `record_changes`
 *   row for that key:
 *     - if the latest history row is non-deleted, a non-deleted current
 *       `records` row SHALL exist with the same version and record_json;
 *     - if the latest history row is deleted, there SHALL be no non-deleted
 *       current `records` row.
 *
 * The Chase symptom that motivated all of this: a `transactions` stream whose
 * `record_changes` carried 1,145 distinct latest-non-deleted keys while the
 * current `records` projection held only 15 rows — 1,130 keys silently lost
 * from the current projection while their authoritative history still said
 * they exist. That is the `missing_current` class below.
 *
 * Mismatch classes returned (mirrors MISMATCH_KINDS in the repair tool):
 *   - missing_current   — latest history non-deleted, but no usable current row
 *   - stale_current     — non-deleted current exists but version/json differs
 *                         from the non-deleted latest history row
 *   - latest_deleted    — latest history deleted but a non-deleted current row
 *                         still exists
 *   - unresolved_pruned — a current row whose version is newer than every
 *                         retained history row, OR a current row whose key has
 *                         no retained history at all (authoritative source
 *                         pruned away)
 *
 * Output discipline: like the repair tool, this only ever surfaces version
 * numbers, deleted flags, byte counts, and truncated record-key identifiers —
 * never raw record payloads. The structural json comparison happens in SQL
 * (`record_json IS NOT DISTINCT FROM` has no direct SQLite spelling, so we use
 * the SQLite-equivalent `IS` operator on the TEXT columns); a drift report can
 * therefore be asserted on / printed without leaking personal data.
 */

import assert from 'node:assert/strict';

import { getDb } from '../../server/db.js';

export const PROJECTION_MISMATCH_KINDS = Object.freeze({
  MISSING_CURRENT: 'missing_current',
  STALE_CURRENT: 'stale_current',
  LATEST_DELETED: 'latest_deleted',
  UNRESOLVED_PRUNED: 'unresolved_pruned',
});

/**
 * Truncate a record_key for human-readable output. Mirrors the repair tool's
 * `truncateKey` so the two surfaces agree on how a key is elided.
 */
export function truncateProjectionKey(key) {
  const s = String(key ?? '');
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * Pure classifier — byte-for-byte the same decision tree as the repair tool's
 * `classifyMismatch`, re-stated here so the test surface does not import the
 * Postgres-only repair module (which pulls in `pg`). Kept in lockstep on
 * purpose: if the repair tool's semantics change, this must change with it,
 * and the regression test pins the equivalence.
 *
 *   latest  = { version, deleted, jsonEqual } | null
 *   current = { version, deleted } | null
 */
export function classifyProjectionMismatch(latest, current) {
  if (!latest) return null;
  const latestVersion = Number(latest.version);

  if (current && Number(current.version) > latestVersion) {
    return PROJECTION_MISMATCH_KINDS.UNRESOLVED_PRUNED;
  }

  if (latest.deleted) {
    if (current && !current.deleted) return PROJECTION_MISMATCH_KINDS.LATEST_DELETED;
    return null;
  }

  if (!current || current.deleted) {
    return PROJECTION_MISMATCH_KINDS.MISSING_CURRENT;
  }
  if (Number(current.version) !== latestVersion || !latest.jsonEqual) {
    return PROJECTION_MISMATCH_KINDS.STALE_CURRENT;
  }
  return null;
}

/**
 * Scan the entire SQLite store (or a scoped slice) and return one payload-free
 * preview per (connector_instance_id, stream, record_key) that violates the
 * current-projection invariant. With no scope, the whole store is checked —
 * this is the cheap "no drift anywhere" assertion a test wants after a bulk
 * mutation.
 *
 * @param {object} [scope]
 * @param {string} [scope.connectorInstanceId]
 * @param {string} [scope.stream]
 * @returns {Array<{recordKey, kind, latestHistoryVersion, latestHistoryDeleted,
 *                  currentExists, currentVersion, currentDeleted}>}
 */
export function detectCurrentProjectionDrift(scope = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (scope.connectorInstanceId != null) {
    where.push('connector_instance_id = ?');
    params.push(scope.connectorInstanceId);
  }
  if (scope.stream != null) {
    where.push('stream = ?');
    params.push(scope.stream);
  }
  // The same predicate is reused for the history CTE, the records join, and
  // the orphan scan; SQLite binds positionally, so the params array is
  // concatenated once per occurrence below.
  const scopeSql = where.length ? `AND ${where.join(' AND ')}` : '';

  // History-driven scan: for every key with retained history, pick the
  // highest-version retained change row and LEFT JOIN the current row. This
  // decides missing_current / stale_current / latest_deleted / (version-newer)
  // unresolved_pruned in one pass. `record_json IS …` is SQLite's structural
  // TEXT comparison (NULL-safe), the analogue of Postgres
  // `IS NOT DISTINCT FROM` used by the repair tool.
  const historyRows = db
    .prepare(
      `WITH latest_history AS (
         SELECT connector_instance_id, stream, record_key, version, deleted, record_json
           FROM record_changes rc
          WHERE rc.version = (
            SELECT MAX(rc2.version)
              FROM record_changes rc2
             WHERE rc2.connector_instance_id = rc.connector_instance_id
               AND rc2.stream = rc.stream
               AND rc2.record_key = rc.record_key
          )
            ${scopeSql}
       )
       SELECT lh.connector_instance_id,
              lh.stream,
              lh.record_key,
              lh.version            AS latest_history_version,
              lh.deleted            AS latest_history_deleted,
              r.version             AS current_version,
              r.deleted             AS current_deleted,
              (r.record_key IS NOT NULL) AS current_exists,
              (r.record_json IS lh.record_json) AS json_equal
         FROM latest_history lh
         LEFT JOIN records r
           ON r.connector_instance_id = lh.connector_instance_id
          AND r.stream = lh.stream
          AND r.record_key = lh.record_key`,
      // the scoped predicate inside the CTE references record_changes columns,
      // which are in scope there; params bind once for that single occurrence.
    )
    .all(...params);

  const previews = [];
  for (const row of historyRows) {
    const latest = {
      version: Number(row.latest_history_version),
      deleted: row.latest_history_deleted === 1,
      jsonEqual: row.json_equal === 1,
    };
    const current = row.current_exists === 1
      ? { version: Number(row.current_version), deleted: row.current_deleted === 1 }
      : null;
    const kind = classifyProjectionMismatch(latest, current);
    if (!kind) continue;
    previews.push({
      connectorInstanceId: row.connector_instance_id,
      stream: row.stream,
      recordKey: row.record_key,
      kind,
      latestHistoryVersion: latest.version,
      latestHistoryDeleted: latest.deleted,
      currentExists: current != null,
      currentVersion: current ? current.version : null,
      currentDeleted: current ? current.deleted : null,
    });
  }

  // Orphan current rows: a current `records` row whose key has NO retained
  // history at all. The history-driven scan above cannot see these. This is
  // the most direct signature of a bulk delete that cleared `record_changes`
  // but left `records` behind — surfaced as unresolved_pruned, never as a
  // false "consistent".
  const orphanWhere = ['NOT EXISTS (SELECT 1 FROM record_changes c WHERE c.connector_instance_id = r.connector_instance_id AND c.stream = r.stream AND c.record_key = r.record_key)'];
  const orphanParams = [];
  if (scope.connectorInstanceId != null) {
    orphanWhere.push('r.connector_instance_id = ?');
    orphanParams.push(scope.connectorInstanceId);
  }
  if (scope.stream != null) {
    orphanWhere.push('r.stream = ?');
    orphanParams.push(scope.stream);
  }
  const orphanRows = db
    .prepare(
      `SELECT r.connector_instance_id, r.stream, r.record_key, r.version, r.deleted
         FROM records r
        WHERE ${orphanWhere.join(' AND ')}`,
    )
    .all(...orphanParams);
  for (const row of orphanRows) {
    previews.push({
      connectorInstanceId: row.connector_instance_id,
      stream: row.stream,
      recordKey: row.record_key,
      kind: PROJECTION_MISMATCH_KINDS.UNRESOLVED_PRUNED,
      latestHistoryVersion: null,
      latestHistoryDeleted: null,
      currentExists: true,
      currentVersion: Number(row.version),
      currentDeleted: row.deleted === 1,
    });
  }

  return previews;
}

/**
 * Format a payload-free one-line summary per drift row, for assertion
 * messages. Never includes record_json.
 */
export function formatDriftPreviews(previews) {
  return previews
    .map(
      (p) =>
        `${p.kind} cin=${truncateProjectionKey(p.connectorInstanceId)} ` +
        `stream=${p.stream} key=${truncateProjectionKey(p.recordKey)} ` +
        `latest_history_version=${p.latestHistoryVersion ?? '-'} ` +
        `latest_deleted=${p.latestHistoryDeleted ?? '-'} ` +
        `current_version=${p.currentVersion ?? '-'} ` +
        `current_deleted=${p.currentDeleted ?? '-'}`,
    )
    .join('\n  ');
}

/**
 * Assert there is no current-projection drift in the given scope (default:
 * the whole store). Throws an AssertionError whose message lists the
 * offending rows (payload-free) so a failing test is self-explaining.
 */
export function assertNoCurrentProjectionDrift(scope = {}) {
  const previews = detectCurrentProjectionDrift(scope);
  assert.equal(
    previews.length,
    0,
    previews.length === 0
      ? 'no drift'
      : `current-projection drift detected (${previews.length} row(s)):\n  ${formatDriftPreviews(previews)}`,
  );
}
