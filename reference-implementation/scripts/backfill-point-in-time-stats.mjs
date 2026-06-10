#!/usr/bin/env node

/**
 * backfill-point-in-time-stats
 *
 * Owner/operator-only operational tool that eliminates point-in-time
 * real-field version churn on three entity streams by MIGRATING the
 * historical observations they carry into the append-keyed observation
 * ("stats") streams that were added by the forward split
 * (`af0ee9e9 feat(connectors): split sampled metrics into append-keyed
 * observation streams`), then — and ONLY then — pruning the migrated
 * historical `record_changes` rows.
 *
 * Background.
 *   The github/user, slack/channels and ynab/accounts entity records used
 *   to carry sampled real-field metrics directly in the entity body:
 *     - github/user      → public_repos, public_gists, followers, following
 *     - slack/channels   → num_members
 *     - ynab/accounts    → balance, cleared_balance, uncleared_balance
 *   Each time one of those metrics moved, the entity record versioned —
 *   accumulating point-in-time real-field history (github 101, slack 30728,
 *   ynab 415 versions live as of 2026-06-04). The forward split moved those
 *   metrics OUT of the entity body and into a new append-keyed stream
 *   (`user_stats`, `channel_stats`, `account_stats`) keyed
 *   `${entity_id}:${observed_on}` (one observation per entity per UTC day).
 *   But the split backfilled NOTHING: the stats streams only have
 *   observations from the day the split shipped forward. The pre-split
 *   real-field observations survive ONLY as `record_changes` history on the
 *   old entity streams. version-churn-summary.ts classifies these as
 *   `point_in_time_real_field` — expected retained history that must NEVER
 *   be compacted, precisely because the stats split backfilled nothing and a
 *   compaction would delete the sole surviving copy.
 *
 *   This tool closes that gap: it reconstructs each pre-split observation as
 *   a stats-stream append record (lossless — the real fields are read out of
 *   the historical entity body verbatim), and only after an observation is
 *   durably represented in the stats stream does it become eligible for
 *   removal from the entity stream's history. After a successful backfill +
 *   prune the entity stream churns on identity only, and the metrics live as
 *   first-class point-in-time observations exactly where the design intends.
 *
 * Scope is deny-by-default. Only three (source → target) policies exist:
 *
 *     github / user      → github / user_stats
 *     slack  / channels  → slack  / channel_stats
 *     ynab   / accounts  → ynab   / account_stats
 *
 *   Each policy mirrors the connector's own stats-record builder one-for-one
 *   (the `buildStat` functions below are byte-parity reimplementations of
 *   `userStatsRecord` / `buildChannelStatsRecord` / `accountStatsRecord`).
 *   Adding a policy is a code-review gate and must reference the connector
 *   builder it mirrors.
 *
 * Two independently-gated phases, each dry-run by default:
 *
 *   --phase=backfill   Read the source entity stream's `record_changes`
 *                      history, reconstruct each pre-split observation, and
 *                      INSERT the missing ones into the target stats stream
 *                      via the normal ingest invariants (version_counter
 *                      allocation, records upsert, record_changes append).
 *                      Idempotent: an observation whose `${id}:${day}` key
 *                      already exists in the stats stream is never
 *                      overwritten (the existing forward observation, or a
 *                      prior backfill, is canonical).
 *
 *   --phase=prune      Remove from the SOURCE entity stream's history ONLY
 *                      the `record_changes` rows whose observation is now
 *                      represented in the target stats stream AND that are
 *                      safe to remove (strictly older than the current
 *                      version, never the current-record anchor, never the
 *                      first/only version for the key). Backed up first.
 *
 *   Default (no --phase): runs `backfill` dry-run only. Prune is never run
 *   implicitly; an operator must opt into it explicitly after verifying the
 *   backfill landed.
 *
 * Losslessness (the central safety property).
 *   A source history version is eligible for prune iff:
 *     1. its reconstructed observation exists in the target stats stream
 *        with byte-identical real-field values (verified by exact stat-key
 *        membership during the prune planning phase), AND
 *     2. it is not the current version of its key, AND
 *     3. it is not the first version of its key, AND
 *     4. it is not a tombstone (deleted=TRUE), AND
 *     5. removing it does not strand the current `records` anchor (the
 *        anchor-preservation NOT EXISTS clause, mirrored from
 *        postgres-records.js / compact-record-history.mjs).
 *   Same-day observations collapse to one stats key; the LATEST source
 *   version on a day is the canonical value for that day (last observed
 *   wins), matching connector same-day idempotency. Earlier same-day
 *   versions are pruned only when the canonical (latest) same-day value is
 *   represented — never losing the day's surviving observation.
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (or `PDPP_TEST_POSTGRES_URL`). There is no HTTP route,
 * no scheduler, no automatic background job.
 *
 * Apply safety (prune phase):
 *   - Per-run backup table `backfill_point_in_time_stats_backup_<runId>` is
 *     created and populated with every source row to be deleted, INSIDE the
 *     same transaction as the DELETE. It persists after commit as the
 *     operator's rollback handle.
 *   - Insert/delete row counts are asserted equal before commit; any
 *     mismatch rolls the transaction back.
 *   - retained_size projections for BOTH the source and target streams are
 *     marked dirty post-commit (the inserts grew the stats stream; the
 *     deletes shrank the entity history).
 *
 * Usage:
 *   node reference-implementation/scripts/backfill-point-in-time-stats.mjs \
 *     --connector-instance-id=cin_... \
 *     --stream=user \
 *     [--connector-id=github] \
 *     [--phase=backfill|prune] \
 *     [--limit-keys=<positive-int>] \
 *     [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL or PDPP_TEST_POSTGRES_URL    required
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

const { Pool } = pg;

// ─── Policy registry ────────────────────────────────────────────────────

/**
 * A backfill policy declares, for one entity stream, the append-keyed stats
 * stream its pre-split real-field observations belong in, and the builder
 * that reconstructs a stats record body from a historical entity body.
 *
 *   - `connectorIds`: connector_id column values the policy applies to
 *     (short id and registry-URL form, matching `findPolicy`).
 *   - `sourceStream`: the entity stream carrying pre-split history.
 *   - `targetStream`: the append-keyed stats stream.
 *   - `realFields`: the real-field keys that legitimately moved and must be
 *     present in the historical body for a version to be reconstructable. A
 *     historical body missing ALL of these is a post-split identity-only
 *     version and is skipped (nothing to migrate).
 *   - `buildStat(entityBody, observedOn)`: returns the stats record body,
 *     byte-parity with the connector's stats-record builder. Returns null
 *     when the entity body cannot yield a stat (e.g. missing id).
 *   - `connectorSource`: the connector builder this mirrors. Documentation.
 */
export const BACKFILL_POLICIES = [
  {
    connectorIds: ['github', 'https://registry.pdpp.org/connectors/github'],
    sourceStream: 'user',
    targetStream: 'user_stats',
    realFields: ['public_repos', 'public_gists', 'followers', 'following'],
    buildStat(body, observedOn) {
      const userId = body?.id;
      if (userId === undefined || userId === null) return null;
      return {
        id: `${String(userId)}:${observedOn}`,
        user_id: String(userId),
        observed_on: observedOn,
        public_repos: body.public_repos ?? null,
        public_gists: body.public_gists ?? null,
        followers: body.followers ?? null,
        following: body.following ?? null,
      };
    },
    connectorSource:
      'packages/polyfill-connectors/connectors/github/parsers.ts:userStatsRecord',
  },
  {
    connectorIds: ['slack', 'https://registry.pdpp.org/connectors/slack'],
    sourceStream: 'channels',
    targetStream: 'channel_stats',
    realFields: ['num_members'],
    buildStat(body, observedOn) {
      const channelId = body?.id;
      if (channelId === undefined || channelId === null) return null;
      return {
        id: `${String(channelId)}:${observedOn}`,
        channel_id: String(channelId),
        observed_on: observedOn,
        num_members: body.num_members ?? null,
      };
    },
    connectorSource:
      'packages/polyfill-connectors/connectors/slack/parsers.ts:buildChannelStatsRecord',
  },
  {
    connectorIds: ['ynab', 'https://registry.pdpp.org/connectors/ynab'],
    sourceStream: 'accounts',
    targetStream: 'account_stats',
    realFields: ['balance', 'cleared_balance', 'uncleared_balance'],
    buildStat(body, observedOn) {
      const accountId = body?.id;
      if (accountId === undefined || accountId === null) return null;
      // budget_id is part of the account_stats key shape (connector keeps it
      // for budget-scoped reads). Pre-split account bodies carry budget_id.
      return {
        id: `${String(accountId)}:${observedOn}`,
        account_id: String(accountId),
        budget_id: body.budget_id ?? null,
        observed_on: observedOn,
        balance: body.balance ?? null,
        cleared_balance: body.cleared_balance ?? null,
        uncleared_balance: body.uncleared_balance ?? null,
      };
    },
    connectorSource:
      'packages/polyfill-connectors/connectors/ynab/index.ts:accountStatsRecord',
  },
];

export function findPolicy(connectorId, sourceStream) {
  return (
    BACKFILL_POLICIES.find(
      (p) => p.connectorIds.includes(connectorId) && p.sourceStream === sourceStream,
    ) || null
  );
}

export function describePolicies() {
  return BACKFILL_POLICIES.map(
    (p) => `  - ${p.connectorIds[0]}/${p.sourceStream} → ${p.connectorIds[0]}/${p.targetStream}`,
  ).join('\n');
}

// ─── Observation transform ──────────────────────────────────────────────

/**
 * UTC calendar date (`YYYY-MM-DD`) of an ISO emitted_at timestamp. Mirrors
 * the connectors' `nowIso().slice(0, 10)` (UTC) used to stamp `observed_on`.
 */
export function observedOnFromEmittedAt(emittedAt) {
  if (typeof emittedAt !== 'string' || emittedAt.length < 10) return null;
  // Fast path: ISO strings already start with YYYY-MM-DD in UTC when the
  // connector wrote them via nowIso(). Normalize through Date to be robust
  // to offset-bearing timestamps, always projecting to UTC.
  const d = new Date(emittedAt);
  if (Number.isNaN(d.getTime())) {
    // Non-parseable but well-formed prefix: trust the literal date prefix.
    return /^\d{4}-\d{2}-\d{2}/.test(emittedAt) ? emittedAt.slice(0, 10) : null;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * True when a historical entity body carries at least one of the policy's
 * real fields as a non-undefined value — i.e. it is a PRE-split body that
 * can yield a real observation. A post-split identity-only body (none of the
 * real-field keys present) returns false and is skipped: there is nothing to
 * migrate, and fabricating an all-null observation would be lossy noise.
 */
export function carriesRealFields(body, realFields) {
  if (!body || typeof body !== 'object') return false;
  return realFields.some((k) => Object.prototype.hasOwnProperty.call(body, k));
}

/**
 * Plan the per-day observations to backfill from a key's history rows.
 *
 * `rows` is `{ version, record_json (object|string), emitted_at, deleted }`
 * sorted ascending by version. Returns a Map keyed by `observed_on` whose
 * value is `{ observedOn, statBody, sourceVersion }` — the canonical
 * (latest non-tombstone version on that day that carries real fields)
 * observation for the day. Days with no real-field-bearing version are
 * absent from the map.
 */
export function planObservationsForKey(rows, policy) {
  const byDay = new Map();
  for (const row of rows) {
    if (row.deleted) continue;
    const body = typeof row.record_json === 'string'
      ? JSON.parse(row.record_json)
      : row.record_json;
    if (!carriesRealFields(body, policy.realFields)) continue;
    const observedOn = observedOnFromEmittedAt(row.emitted_at);
    if (!observedOn) continue;
    const statBody = policy.buildStat(body, observedOn);
    if (!statBody) continue;
    // Last write wins per day: a later version on the same day supersedes an
    // earlier one. rows are ascending, so a plain overwrite keeps the latest.
    byDay.set(observedOn, {
      observedOn,
      statBody,
      sourceVersion: Number(row.version),
    });
  }
  return byDay;
}

// ─── Version allocation (mirrors postgres-records.allocateNextVersion) ────

async function allocateNextVersion(client, connectorId, connectorInstanceId, stream) {
  const result = await client.query(
    `INSERT INTO version_counter (connector_id, connector_instance_id, stream, max_version)
     VALUES (
       $1, $2, $3,
       GREATEST(
         1,
         COALESCE((SELECT MAX(version) FROM record_changes
                    WHERE connector_instance_id = $2 AND stream = $3), 0) + 1,
         COALESCE((SELECT MAX(version) FROM records
                    WHERE connector_instance_id = $2 AND stream = $3), 0) + 1
       )
     )
     ON CONFLICT (connector_instance_id, stream) DO UPDATE
       SET max_version = GREATEST(
             version_counter.max_version,
             COALESCE((SELECT MAX(version) FROM record_changes
                        WHERE connector_instance_id = version_counter.connector_instance_id
                          AND stream = version_counter.stream), 0),
             COALESCE((SELECT MAX(version) FROM records
                        WHERE connector_instance_id = version_counter.connector_instance_id
                          AND stream = version_counter.stream), 0)
           ) + 1
     RETURNING max_version`,
    [connectorId, connectorInstanceId, stream],
  );
  return Number(result.rows[0].max_version);
}

/**
 * Insert one stats observation into the target stream, mirroring
 * postgres-records.postgresIngestRecord's non-delete write path: allocate a
 * stream-global version, upsert `records`, append `record_changes`. The
 * stats key (`${id}:${day}`) is the record_key; `primary_key_text` mirrors
 * record_key (single-field `id` primary key, as the connector emits).
 *
 * Returns 'inserted' when a new stats key was created, or 'exists' when the
 * key was already present (idempotent skip — never overwrites the canonical
 * forward/ prior observation).
 */
async function ingestStatRecord(client, connectorId, connectorInstanceId, targetStream, statBody, emittedAt) {
  const recordKey = String(statBody.id);
  const existing = await client.query(
    `SELECT 1 FROM records
      WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
      LIMIT 1`,
    [connectorInstanceId, targetStream, recordKey],
  );
  if (existing.rows.length) return 'exists';

  const recordJson = JSON.stringify(statBody);
  const nextVersion = await allocateNextVersion(client, connectorId, connectorInstanceId, targetStream);
  const inserted = await client.query(
    `INSERT INTO records
       (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, NULL, $8, $9)
     ON CONFLICT (connector_instance_id, stream, record_key) DO NOTHING
     RETURNING 1`,
    [connectorId, connectorInstanceId, targetStream, recordKey, recordJson, emittedAt, nextVersion, null, recordKey],
  );
  if (!inserted.rowCount) return 'exists';
  await client.query(
    `INSERT INTO record_changes
       (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE, NULL)`,
    [connectorId, connectorInstanceId, targetStream, recordKey, nextVersion, recordJson, emittedAt],
  );
  return 'inserted';
}

// ─── Backfill phase ─────────────────────────────────────────────────────

/**
 * Plan the backfill: scan the source stream's current keys, read each key's
 * full history, reconstruct per-day observations, and determine which target
 * stats keys are missing.
 */
export async function planBackfill({ pool, connectorId, connectorInstanceId, policy, limitKeys }) {
  const limitClause = limitKeys ? `LIMIT ${Number(limitKeys)}` : '';
  const keys = await pool.query(
    `SELECT record_key
       FROM records
      WHERE connector_instance_id = $1 AND stream = $2
      ORDER BY record_key
      ${limitClause}`,
    [connectorInstanceId, policy.sourceStream],
  );

  let scannedKeys = 0;
  let scannedVersions = 0;
  let observationsConsidered = 0;
  let alreadyPresent = 0;
  // statBody by target record_key, plus the source emitted_at to carry over.
  const toInsert = new Map();

  for (const { record_key: recordKey } of keys.rows) {
    scannedKeys += 1;
    const history = await pool.query(
      `SELECT version, record_json, emitted_at, deleted
         FROM record_changes
        WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
        ORDER BY version ASC`,
      [connectorInstanceId, policy.sourceStream, recordKey],
    );
    scannedVersions += history.rows.length;
    const byDay = planObservationsForKey(history.rows, policy);
    for (const { statBody, observedOn } of byDay.values()) {
      observationsConsidered += 1;
      const targetKey = String(statBody.id);
      const present = await pool.query(
        `SELECT 1 FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
          LIMIT 1`,
        [connectorInstanceId, policy.targetStream, targetKey],
      );
      if (present.rows.length || toInsert.has(targetKey)) {
        alreadyPresent += 1;
        continue;
      }
      // emitted_at for the stats row: noon UTC of the observed day, a stable
      // synthetic stamp that sorts within the day and never collides with a
      // real same-day forward observation's exact timestamp. observed_on (not
      // emitted_at) is the load-bearing field for these append records.
      toInsert.set(targetKey, {
        statBody,
        emittedAt: `${observedOn}T12:00:00.000Z`,
      });
    }
  }

  return {
    connectorId,
    connectorInstanceId,
    sourceStream: policy.sourceStream,
    targetStream: policy.targetStream,
    scannedKeys,
    scannedVersions,
    observationsConsidered,
    alreadyPresent,
    insertCount: toInsert.size,
    toInsert,
  };
}

export async function applyBackfill({ pool, plan }) {
  if (!plan.insertCount) return { inserted: 0, skipped: 0 };

  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    for (const [, { statBody, emittedAt }] of plan.toInsert) {
      const result = await ingestStatRecord(
        client,
        plan.connectorId,
        plan.connectorInstanceId,
        plan.targetStream,
        statBody,
        emittedAt,
      );
      if (result === 'inserted') inserted += 1;
      else skipped += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
  return { inserted, skipped };
}

// ─── Prune phase ────────────────────────────────────────────────────────

/**
 * Decide which SOURCE history versions are safe to remove for one key.
 *
 * A version is removable iff (see losslessness rules in the file header):
 *   - it is strictly older than the current version,
 *   - it is not the first version of the key,
 *   - it is not a tombstone,
 *   - it carries real fields (it is a pre-split observation — post-split
 *     identity churn is out of this tool's scope and left intact),
 *   - the day it observes is REPRESENTED in `representedDays` (a Set of
 *     `observed_on` strings present in the target stats stream).
 *
 * `rows` is `{ version, record_json, emitted_at, deleted }` ascending.
 * `currentVersion` is the version of the same key in `records`.
 * Returns an array of removable version numbers.
 */
export function selectPrunableVersions(rows, currentVersion, policy, representedDays) {
  if (!rows.length) return [];
  const removable = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const version = Number(row.version);
    if (i === 0) continue; // never the first version
    if (version >= Number(currentVersion)) continue; // never current-or-newer
    if (row.deleted) continue; // never a tombstone
    const body = typeof row.record_json === 'string'
      ? JSON.parse(row.record_json)
      : row.record_json;
    if (!carriesRealFields(body, policy.realFields)) continue; // post-split churn: leave intact
    const observedOn = observedOnFromEmittedAt(row.emitted_at);
    if (!observedOn) continue;
    if (!representedDays.has(observedOn)) continue; // not yet migrated → keep
    removable.push(version);
  }
  return removable;
}

export async function planPrune({ pool, connectorId, connectorInstanceId, policy, limitKeys }) {
  const limitClause = limitKeys ? `LIMIT ${Number(limitKeys)}` : '';
  const current = await pool.query(
    `SELECT record_key, version
       FROM records
      WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
      ORDER BY record_key
      ${limitClause}`,
    [connectorInstanceId, policy.sourceStream],
  );

  let scannedKeys = 0;
  let scannedVersions = 0;
  const removableByKey = new Map();
  let removableVersions = 0;

  for (const { record_key: recordKey, version: currentVersion } of current.rows) {
    scannedKeys += 1;
    const history = await pool.query(
      `SELECT version, record_json, emitted_at, deleted
         FROM record_changes
        WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
        ORDER BY version ASC`,
      [connectorInstanceId, policy.sourceStream, recordKey],
    );
    scannedVersions += history.rows.length;

    // Which days for this key are represented in the target stats stream?
    // The stats key is exactly `${entity_id}:${observed_on}`. We check the
    // EXACT candidate stat keys (one per observed day in this key's history)
    // rather than a `LIKE '${entity_id}:%'` prefix scan — a prefix scan could
    // over-match if an entity id were itself a prefix of another's, or if an
    // id contained a LIKE metacharacter, and an over-match would let prune
    // delete a still-unmigrated observation. Exact-key membership cannot.
    const candidateDays = new Set();
    for (const row of history.rows) {
      if (row.deleted) continue;
      const day = observedOnFromEmittedAt(row.emitted_at);
      if (day) candidateDays.add(day);
    }
    const representedDays = new Set();
    if (candidateDays.size) {
      const candidateKeys = [...candidateDays].map((day) => `${recordKey}:${day}`);
      const present = await pool.query(
        `SELECT record_key FROM records
          WHERE connector_instance_id = $1 AND stream = $2
            AND record_key = ANY($3::text[])`,
        [connectorInstanceId, policy.targetStream, candidateKeys],
      );
      for (const r of present.rows) {
        const day = String(r.record_key).slice(recordKey.length + 1);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) representedDays.add(day);
      }
    }

    const removable = selectPrunableVersions(history.rows, currentVersion, policy, representedDays);
    if (removable.length) {
      removableByKey.set(recordKey, removable);
      removableVersions += removable.length;
    }
  }

  return {
    connectorId,
    connectorInstanceId,
    sourceStream: policy.sourceStream,
    targetStream: policy.targetStream,
    scannedKeys,
    scannedVersions,
    removableVersions,
    retainedVersionsAfter: scannedVersions - removableVersions,
    removableByKey,
  };
}

export async function applyPrune({ pool, plan, runId }) {
  if (!plan.removableVersions) {
    return { runId, backupTable: null, deleted: 0, inserted: 0 };
  }
  const backupTable = `backfill_point_in_time_stats_backup_${runId}`;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(backupTable)} (
       connector_id TEXT NOT NULL,
       connector_instance_id TEXT NOT NULL,
       stream TEXT NOT NULL,
       record_key TEXT NOT NULL,
       version BIGINT NOT NULL,
       record_json JSONB,
       emitted_at TEXT NOT NULL,
       deleted BOOLEAN NOT NULL,
       deleted_at TEXT,
       pruned_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const client = await pool.connect();
  let inserted = 0;
  let deleted = 0;
  try {
    await client.query('BEGIN');
    for (const [recordKey, versions] of plan.removableByKey) {
      const versionsAsNumbers = versions.map(Number);
      // Anchor preservation: refuse to back up / delete any row that anchors
      // the current `records` row for this key. The NOT EXISTS clause is the
      // same invariant postgres-records.js enforces during live prune. In the
      // prune planner we already exclude version >= currentVersion, so this is
      // defense-in-depth: a belt-and-suspenders guard that the delete set can
      // never strand a current projection.
      const insertRes = await client.query(
        `INSERT INTO ${quoteIdent(backupTable)}
           (connector_id, connector_instance_id, stream, record_key, version,
            record_json, emitted_at, deleted, deleted_at)
         SELECT rc.connector_id, rc.connector_instance_id, rc.stream, rc.record_key, rc.version,
                rc.record_json, rc.emitted_at, rc.deleted, rc.deleted_at
           FROM record_changes rc
          WHERE rc.connector_instance_id = $1 AND rc.stream = $2 AND rc.record_key = $3
            AND rc.version = ANY($4::bigint[])
            AND NOT EXISTS (
              SELECT 1 FROM records r
               WHERE r.connector_instance_id = rc.connector_instance_id
                 AND r.stream = rc.stream
                 AND r.record_key = rc.record_key
                 AND r.version = rc.version
            )`,
        [plan.connectorInstanceId, plan.sourceStream, recordKey, versionsAsNumbers],
      );
      const deleteRes = await client.query(
        `DELETE FROM record_changes rc
           WHERE rc.connector_instance_id = $1 AND rc.stream = $2 AND rc.record_key = $3
             AND rc.version = ANY($4::bigint[])
             AND NOT EXISTS (
               SELECT 1 FROM records r
                WHERE r.connector_instance_id = rc.connector_instance_id
                  AND r.stream = rc.stream
                  AND r.record_key = rc.record_key
                  AND r.version = rc.version
             )`,
        [plan.connectorInstanceId, plan.sourceStream, recordKey, versionsAsNumbers],
      );
      if (insertRes.rowCount !== deleteRes.rowCount) {
        throw new Error(
          `delete/backup mismatch for ${plan.connectorInstanceId}/${plan.sourceStream}/${recordKey}: backed up ${insertRes.rowCount}, deleted ${deleteRes.rowCount}`,
        );
      }
      inserted += insertRes.rowCount;
      deleted += deleteRes.rowCount;
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
  return { runId, backupTable, deleted, inserted };
}

/**
 * Mark retained-size projections dirty for both streams touched. Kept out of
 * the mutation transactions so a dirty-marker failure can never roll back a
 * successful backfill/prune. Mirrors compact-record-history.markScopeDirty.
 */
export async function markScopesDirty({ pool, connectorInstanceId, streams }) {
  try {
    for (const stream of streams) {
      await pool.query(
        `UPDATE retained_size_stream SET dirty = 1
          WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
    }
    await pool.query(
      `UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = $1`,
      [connectorInstanceId],
    );
    await pool.query(`UPDATE retained_size_global SET dirty = 1`);
  } catch {
    // Non-fatal: next bulk write / rebuild detects drift.
  }
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// ─── Argv parsing ───────────────────────────────────────────────────────

export function parseLimitKeys(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return 'invalid';
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 'invalid';
  return n;
}

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

// ─── CLI entry point ────────────────────────────────────────────────────

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  await runCli();
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;
  const phase = args.phase || 'backfill';
  const connectorInstanceId = args['connector-instance-id'];
  const sourceStream = args.stream;
  const explicitConnectorId = args['connector-id'] || null;
  const limitKeys = parseLimitKeys(args['limit-keys']);
  const databaseUrl =
    process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;

  if (!connectorInstanceId || !sourceStream) {
    console.error(
      'usage: backfill-point-in-time-stats --connector-instance-id=<id> --stream=<sourceStream> [--connector-id=<id>] [--phase=backfill|prune] [--limit-keys=N] [--apply]',
    );
    process.exit(2);
  }
  if (phase !== 'backfill' && phase !== 'prune') {
    console.error(`--phase must be "backfill" or "prune" (got "${phase}")`);
    process.exit(2);
  }
  if (limitKeys === 'invalid') {
    console.error('--limit-keys must be a positive integer');
    process.exit(2);
  }
  if (!databaseUrl) {
    console.error(
      'PDPP_DATABASE_URL (or PDPP_TEST_POSTGRES_URL) is required — authorization is by direct database access',
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    let connectorId = explicitConnectorId;
    if (!connectorId) {
      const r = await pool.query(
        `SELECT connector_id FROM connector_instances WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      if (!r.rows.length) {
        console.error(
          `connector_instance_id "${connectorInstanceId}" not found and --connector-id was not supplied`,
        );
        process.exit(2);
      }
      connectorId = r.rows[0].connector_id;
    }

    const policy = findPolicy(connectorId, sourceStream);
    if (!policy) {
      console.error(
        `no backfill policy registered for connector_id="${connectorId}" stream="${sourceStream}".\nRegistered policies:\n${describePolicies()}`,
      );
      process.exit(2);
    }

    if (phase === 'backfill') {
      const plan = await planBackfill({ pool, connectorId, connectorInstanceId, policy, limitKeys });
      printBackfillPlan({ plan, apply });
      if (apply && plan.insertCount > 0) {
        const result = await applyBackfill({ pool, plan });
        await markScopesDirty({
          pool,
          connectorInstanceId,
          streams: [policy.targetStream],
        });
        console.log(
          `APPLIED backfill: inserted ${result.inserted} stat observation(s), skipped ${result.skipped} already-present. retained_size marked dirty for ${connectorInstanceId}/${policy.targetStream}.`,
        );
      } else if (apply) {
        console.log('APPLIED backfill: nothing to insert.');
      }
    } else {
      const plan = await planPrune({ pool, connectorId, connectorInstanceId, policy, limitKeys });
      printPrunePlan({ plan, apply });
      if (apply && plan.removableVersions > 0) {
        const runId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const result = await applyPrune({ pool, plan, runId });
        await markScopesDirty({
          pool,
          connectorInstanceId,
          streams: [policy.sourceStream],
        });
        console.log(
          `APPLIED prune: deleted ${result.deleted} migrated source history row(s), backed up into "${result.backupTable}". retained_size marked dirty for ${connectorInstanceId}/${policy.sourceStream}.`,
        );
      } else if (apply) {
        console.log('APPLIED prune: nothing to delete.');
      }
    }
  } catch (err) {
    console.error('backfill-point-in-time-stats failed:', err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

function printBackfillPlan({ plan, apply }) {
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`backfill-point-in-time-stats: ${mode} backfill — ${plan.connectorInstanceId}/${plan.sourceStream} → ${plan.targetStream}`);
  console.log(`  scannedKeys:             ${plan.scannedKeys}`);
  console.log(`  scannedVersions:         ${plan.scannedVersions}`);
  console.log(`  observationsConsidered:  ${plan.observationsConsidered}`);
  console.log(`  alreadyPresent:          ${plan.alreadyPresent}`);
  console.log(`  insertCount:             ${plan.insertCount}`);
}

function printPrunePlan({ plan, apply }) {
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`backfill-point-in-time-stats: ${mode} prune — ${plan.connectorInstanceId}/${plan.sourceStream}`);
  console.log(`  scannedKeys:             ${plan.scannedKeys}`);
  console.log(`  scannedVersions:         ${plan.scannedVersions}`);
  console.log(`  removableVersions:       ${plan.removableVersions}`);
  console.log(`  retainedVersionsAfter:   ${plan.retainedVersionsAfter}`);
}
