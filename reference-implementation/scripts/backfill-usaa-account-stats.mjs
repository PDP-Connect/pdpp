#!/usr/bin/env node

/**
 * backfill-usaa-account-stats
 *
 * Owner/operator-only migration tool that lifts USAA's pre-split numeric
 * account balances out of `usaa/accounts` retained entity history and into the
 * append-keyed `usaa/account_stats` observation stream, where the forward path
 * already writes them.
 *
 * Background.
 *   `split-usaa-account-balance-observation-streams` (archived 2026-06-04)
 *   moved `balance_cents`/`available_balance_cents` off the `usaa/accounts`
 *   entity body and into the `usaa/account_stats` stream, keyed
 *   `${account_id}:${observed_on}` (one observation per account per UTC day).
 *   The split backfilled NOTHING: `account_stats` only carries observations
 *   from the day the split shipped forward. Every balance movement BEFORE the
 *   split re-versioned the `accounts` entity, so the pre-split balances survive
 *   ONLY as `record_changes` history on `usaa/accounts`. The evidence lane
 *   `ri-version-rationality-evidence-v1` classified `usaa/accounts` as the one
 *   watch row that is legitimate retained history mixed with contamination:
 *   collapsing it (canonical compaction) would permanently destroy those real
 *   pre-split balance observations. This tool migrates them first, after which
 *   the entity history is pure name/url/shape contamination and becomes a
 *   legitimate canonical-collapse candidate — a sequencing the durable
 *   reference-architecture requirement makes normative.
 *
 * Relationship to backfill-point-in-time-stats.mjs.
 *   That sibling tool backfills the three POINT_IN_TIME_REAL_FIELD_STREAMS
 *   (github/user, slack/channels, ynab/accounts) and additionally PRUNES the
 *   migrated source history. `usaa/accounts` is deliberately NOT one of those
 *   streams: it is higher-risk and held out of that registry so a routine
 *   backfill+prune run can never touch it. This tool is backfill-ONLY (it never
 *   deletes or mutates `usaa/accounts` history) and adds a per-run inserted-key
 *   table + `--rollback` so the additive migration is exactly reversible. The
 *   `observed_on` derivation and same-day latest-wins rule mirror the sibling.
 *
 * Scope is single-source by construction. The only source→target relationship
 * is `usaa/accounts` → `usaa/account_stats` for connector_instance
 * `cin_bc1efca69a1c386d610f0924` (overridable with --instance). The stat-record
 * builder below is a byte-parity reimplementation of the connector's
 * `buildAccountStatsRecord` (see USAA_ACCOUNT_STATS_BUILDER_SOURCE); a parity
 * test pins it.
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` / `PDPP_TEST_POSTGRES_URL` / `--db`. There is no HTTP
 * route, no scheduler, no automatic background job.
 *
 * Modes (dry-run by default; nothing is written without --apply / --rollback):
 *
 *   (default)            Enumerate candidate daily observations and report
 *                        counts: candidates, net-new, skipped (already in
 *                        account_stats), same-day-resolved. No writes.
 *
 *   --apply              Insert the net-new observations into account_stats
 *                        (records + record_changes, version 1 per new key)
 *                        through the same ingest invariants the connector uses.
 *                        Before the inserts, copy the source history read into
 *                        backfill_usaa_account_stats_source_<runId> and, in the
 *                        SAME transaction as the inserts, record every inserted
 *                        account_stats key into
 *                        backfill_usaa_account_stats_inserted_<runId>.
 *                        Idempotent: existing account_stats keys are skipped,
 *                        never overwritten, so a second --apply inserts 0.
 *
 *   --rollback <runId>   Delete from records + record_changes exactly the
 *                        account_stats keys listed in
 *                        backfill_usaa_account_stats_inserted_<runId> and
 *                        nothing else. Refuses any key not in that table.
 *                        Forward-path rows (never in the inserted table) are
 *                        untouched.
 *
 * Safety properties:
 *   - Current/forward rows are authoritative: the insert set is candidate keys
 *     MINUS keys already present in account_stats. Never updates/deletes a row.
 *   - Same-day conflicts resolve to the latest source version for the day; the
 *     dropped version(s) remain in the per-run source backup for audit.
 *   - No `--apply` against live retained history until a copied/narrow database
 *     proves candidate count, net-new insert count, current-row preservation,
 *     idempotence, and rollback restoration. (Operator gate — enforced by
 *     review, not by the script; the script will run against any DB it is
 *     pointed at, which is why the default is dry-run.)
 *
 * Usage:
 *   node reference-implementation/scripts/backfill-usaa-account-stats.mjs \
 *     [--db=<postgres-url>] [--instance=cin_...] \
 *     [--apply | --rollback=<runId>]
 *
 * Env:
 *   PDPP_DATABASE_URL or PDPP_TEST_POSTGRES_URL    required if --db absent
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

const { Pool } = pg;

// ─── Constants ──────────────────────────────────────────────────────────

/** The USAA connection whose pre-split balance history is migrated. */
export const DEFAULT_USAA_INSTANCE = 'cin_bc1efca69a1c386d610f0924';
export const SOURCE_STREAM = 'accounts';
export const TARGET_STREAM = 'account_stats';

/**
 * The connector builder this tool's stat-record reconstruction mirrors. A
 * parity test pins the shape. Importing the TS function directly is not
 * possible from a plain .mjs script (the connector package exports only `.ts`
 * entry points with no compiled JS), so — exactly as the sibling
 * backfill-point-in-time-stats.mjs does for its three policies — the builder is
 * reimplemented byte-for-byte and cross-checked by test.
 */
export const USAA_ACCOUNT_STATS_BUILDER_SOURCE =
  'packages/polyfill-connectors/connectors/usaa/parsers.ts:buildAccountStatsRecord';

// ─── Observation transform ──────────────────────────────────────────────

/**
 * UTC calendar date (`YYYY-MM-DD`) of an ISO emitted_at timestamp. Mirrors the
 * connector's `observedOn = emittedAt.slice(0, 10)` derivation in
 * `emitAccountsStream`, normalizing offset-bearing timestamps to UTC.
 */
export function observedOnFromEmittedAt(emittedAt) {
  if (typeof emittedAt !== 'string' || emittedAt.length < 10) return null;
  const d = new Date(emittedAt);
  if (Number.isNaN(d.getTime())) {
    return /^\d{4}-\d{2}-\d{2}/.test(emittedAt) ? emittedAt.slice(0, 10) : null;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * True when an integer cents value is present and parseable. The history body
 * stores `balance_cents` as a number; only numeric values are real
 * observations to migrate (a `null`/absent/non-numeric balance is a pre/post
 * split shape artifact, not a balance).
 */
export function numericCentsOrNull(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Byte-parity reimplementation of the connector's `buildAccountStatsRecord`.
 * The historical `usaa/accounts` entity body already carries the resolved
 * `id` (the same value `accountId()` produces), so the stat record is built
 * straight from `body.id` and the numeric `balance_cents` — no DashboardAccount
 * is reconstructed. `available_balance_cents` is hardcoded `null`, matching the
 * builder (no history version carried a numeric available balance).
 *
 * Returns null when the body has no usable account id or no numeric balance.
 */
export function buildAccountStatsRecordFromHistory(body, observedOn) {
  if (!body || typeof body !== 'object') return null;
  const accountId = body.id;
  if (accountId === undefined || accountId === null || accountId === '') return null;
  const balanceCents = numericCentsOrNull(body.balance_cents);
  if (balanceCents === null) return null;
  const id = String(accountId);
  return {
    id: `${id}:${observedOn}`,
    account_id: id,
    observed_on: observedOn,
    balance_cents: balanceCents,
    available_balance_cents: null,
  };
}

/**
 * Plan the per-day observations to backfill from one account key's history.
 *
 * `rows` is `{ version, record_json (object|string), emitted_at, deleted }`
 * sorted ascending by version. Returns a Map keyed by `observed_on` whose value
 * is `{ observedOn, statBody, sourceVersion, droppedVersions }` — the canonical
 * (latest non-tombstone numeric-balance version on that day) observation, plus
 * the earlier same-day source versions it superseded (for the audit trail).
 * Days with no numeric-balance version are absent from the map.
 */
export function planObservationsForKey(rows) {
  const byDay = new Map();
  for (const row of rows) {
    if (row.deleted) continue;
    const body = typeof row.record_json === 'string'
      ? JSON.parse(row.record_json)
      : row.record_json;
    const observedOn = observedOnFromEmittedAt(row.emitted_at);
    if (!observedOn) continue;
    const statBody = buildAccountStatsRecordFromHistory(body, observedOn);
    if (!statBody) continue;
    const version = Number(row.version);
    const prior = byDay.get(observedOn);
    // Latest same-day version wins. rows are ascending, but compare versions
    // explicitly so the rule does not depend on scan order. The superseded
    // version is recorded as dropped.
    if (!prior || version > prior.sourceVersion) {
      byDay.set(observedOn, {
        observedOn,
        statBody,
        sourceVersion: version,
        droppedVersions: prior
          ? [...prior.droppedVersions, prior.sourceVersion]
          : [],
      });
    } else {
      prior.droppedVersions.push(version);
    }
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
 * Insert one stat observation into account_stats, mirroring
 * postgres-records.postgresIngestRecord's non-delete write path: allocate a
 * stream-global version, upsert `records`, append `record_changes`. The stat
 * key (`${account_id}:${observed_on}`) is the record_key; `primary_key_text`
 * mirrors it (single-field `id` primary key, as the connector emits).
 *
 * Returns 'inserted' when a new key was created, or 'exists' when the key was
 * already present (idempotent skip — never overwrites a forward/prior row).
 */
async function ingestStatRecord(client, connectorId, connectorInstanceId, statBody, emittedAt) {
  const recordKey = String(statBody.id);
  const existing = await client.query(
    `SELECT 1 FROM records
      WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
      LIMIT 1`,
    [connectorInstanceId, TARGET_STREAM, recordKey],
  );
  if (existing.rows.length) return 'exists';

  const recordJson = JSON.stringify(statBody);
  const nextVersion = await allocateNextVersion(client, connectorId, connectorInstanceId, TARGET_STREAM);
  const inserted = await client.query(
    `INSERT INTO records
       (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, NULL, $8, $9)
     ON CONFLICT (connector_instance_id, stream, record_key) DO NOTHING
     RETURNING 1`,
    [connectorId, connectorInstanceId, TARGET_STREAM, recordKey, recordJson, emittedAt, nextVersion, null, recordKey],
  );
  if (!inserted.rowCount) return 'exists';
  await client.query(
    `INSERT INTO record_changes
       (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE, NULL)`,
    [connectorId, connectorInstanceId, TARGET_STREAM, recordKey, nextVersion, recordJson, emittedAt],
  );
  return 'inserted';
}

// ─── Plan ───────────────────────────────────────────────────────────────

/**
 * Scan `usaa/accounts` current keys, read each key's full history, reconstruct
 * per-day observations, subtract keys already present in account_stats, and
 * return the insert plan plus the source rows read (for the per-run source
 * backup) and the same-day resolution audit.
 */
export async function planBackfill({ pool, connectorId, connectorInstanceId }) {
  const keys = await pool.query(
    `SELECT record_key FROM records
      WHERE connector_instance_id = $1 AND stream = $2
      ORDER BY record_key`,
    [connectorInstanceId, SOURCE_STREAM],
  );

  let scannedKeys = 0;
  let scannedVersions = 0;
  let candidateCount = 0;
  let skipped = 0;
  let sameDayResolved = 0;
  // statBody by target record_key, with the synthetic emitted_at stamp.
  const toInsert = new Map();
  // Every source history row read, for the per-run source backup table.
  const sourceRows = [];
  // Same-day resolution audit: { account_id, observed_on, kept, dropped[] }.
  const sameDayResolutions = [];

  for (const { record_key: recordKey } of keys.rows) {
    scannedKeys += 1;
    const history = await pool.query(
      `SELECT version, record_json, emitted_at, deleted
         FROM record_changes
        WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
        ORDER BY version ASC`,
      [connectorInstanceId, SOURCE_STREAM, recordKey],
    );
    scannedVersions += history.rows.length;
    for (const r of history.rows) {
      sourceRows.push({ recordKey, ...r });
    }
    const byDay = planObservationsForKey(history.rows);
    for (const { statBody, observedOn, droppedVersions } of byDay.values()) {
      candidateCount += 1;
      if (droppedVersions.length) {
        sameDayResolved += 1;
        sameDayResolutions.push({
          accountId: statBody.account_id,
          observedOn,
          keptVersion: byDay.get(observedOn).sourceVersion,
          droppedVersions,
        });
      }
      const targetKey = String(statBody.id);
      const present = await pool.query(
        `SELECT 1 FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
          LIMIT 1`,
        [connectorInstanceId, TARGET_STREAM, targetKey],
      );
      if (present.rows.length || toInsert.has(targetKey)) {
        skipped += 1;
        continue;
      }
      // observed_on (not emitted_at) is the load-bearing field for these append
      // records. Stamp noon UTC of the observed day — a stable synthetic
      // timestamp that sorts within the day and never collides with a real
      // same-day forward observation's exact timestamp.
      toInsert.set(targetKey, {
        statBody,
        emittedAt: `${observedOn}T12:00:00.000Z`,
      });
    }
  }

  return {
    connectorId,
    connectorInstanceId,
    sourceStream: SOURCE_STREAM,
    targetStream: TARGET_STREAM,
    scannedKeys,
    scannedVersions,
    candidateCount,
    skipped,
    sameDayResolved,
    insertCount: toInsert.size,
    toInsert,
    sourceRows,
    sameDayResolutions,
  };
}

// ─── Apply ──────────────────────────────────────────────────────────────

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function sourceBackupTable(runId) {
  return `backfill_usaa_account_stats_source_${runId}`;
}
export function insertedBackupTable(runId) {
  return `backfill_usaa_account_stats_inserted_${runId}`;
}

/**
 * Apply the backfill under a fresh runId.
 *
 *   1. Create + populate the per-run SOURCE backup table with every
 *      `usaa/accounts` history row this run read (audit trail of the exact
 *      input), OUTSIDE the insert transaction — it is read-only history, so a
 *      failure there must not partially insert.
 *   2. In ONE transaction: insert each net-new observation, and record its
 *      account_stats key in the per-run INSERTED table. The record and the
 *      effect commit together or not at all.
 *
 * Returns { runId, inserted, skipped, sourceTable, insertedTable }.
 */
export async function applyBackfill({ pool, plan, runId }) {
  const sourceTable = sourceBackupTable(runId);
  const insertedTable = insertedBackupTable(runId);

  // (1) Source backup — read-only history snapshot, outside the insert txn.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(sourceTable)} (
       connector_id TEXT NOT NULL,
       connector_instance_id TEXT NOT NULL,
       stream TEXT NOT NULL,
       record_key TEXT NOT NULL,
       version BIGINT NOT NULL,
       record_json JSONB,
       emitted_at TEXT NOT NULL,
       deleted BOOLEAN NOT NULL,
       backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await pool.query(
    `INSERT INTO ${quoteIdent(sourceTable)}
       (connector_id, connector_instance_id, stream, record_key, version,
        record_json, emitted_at, deleted)
     SELECT rc.connector_id, rc.connector_instance_id, rc.stream, rc.record_key,
            rc.version, rc.record_json, rc.emitted_at, rc.deleted
       FROM record_changes rc
      WHERE rc.connector_instance_id = $1 AND rc.stream = $2`,
    [plan.connectorInstanceId, plan.sourceStream],
  );

  // (2) Inserted-key table + inserts in one transaction.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(insertedTable)} (
       connector_id TEXT NOT NULL,
       connector_instance_id TEXT NOT NULL,
       stream TEXT NOT NULL,
       record_key TEXT NOT NULL,
       version BIGINT NOT NULL,
       inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  if (!plan.insertCount) {
    return { runId, inserted: 0, skipped: plan.skipped, sourceTable, insertedTable };
  }

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
        statBody,
        emittedAt,
      );
      if (result === 'inserted') {
        inserted += 1;
        const recordKey = String(statBody.id);
        await client.query(
          `INSERT INTO ${quoteIdent(insertedTable)}
             (connector_id, connector_instance_id, stream, record_key, version)
           SELECT r.connector_id, r.connector_instance_id, r.stream, r.record_key, r.version
             FROM records r
            WHERE r.connector_instance_id = $1 AND r.stream = $2 AND r.record_key = $3`,
          [plan.connectorInstanceId, plan.targetStream, recordKey],
        );
      } else {
        skipped += 1;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
  return { runId, inserted, skipped: plan.skipped + skipped, sourceTable, insertedTable };
}

/**
 * Mark retained-size projections dirty for the target stream. Kept out of the
 * mutation transaction so a dirty-marker failure can never roll back a
 * successful insert. Mirrors backfill-point-in-time-stats.markScopesDirty.
 */
export async function markScopesDirty({ pool, connectorInstanceId, stream }) {
  try {
    await pool.query(
      `UPDATE retained_size_stream SET dirty = 1
        WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream],
    );
    await pool.query(
      `UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = $1`,
      [connectorInstanceId],
    );
    await pool.query(`UPDATE retained_size_global SET dirty = 1`);
  } catch {
    // Non-fatal: next bulk write / rebuild detects drift.
  }
}

// ─── Rollback ───────────────────────────────────────────────────────────

async function tableExists(pool, table) {
  const r = await pool.query('SELECT to_regclass($1) AS oid', [table]);
  return !!r.rows[0].oid;
}

/**
 * Rollback the inserts recorded for `runId`. Deletes from records +
 * record_changes EXACTLY the account_stats keys listed in the run's inserted
 * table — joined ON the inserted table so a key absent from it is never
 * touched. Forward-path rows (never recorded as inserted) are untouched.
 *
 * Returns { runId, deleted } or throws if the inserted table is missing.
 */
export async function applyRollback({ pool, connectorInstanceId, runId }) {
  const insertedTable = insertedBackupTable(runId);
  if (!(await tableExists(pool, insertedTable))) {
    throw new Error(
      `inserted-key table "${insertedTable}" not found — cannot roll back run "${runId}"`,
    );
  }

  const client = await pool.connect();
  let deleted = 0;
  try {
    await client.query('BEGIN');
    // record_changes first, then records — both keyed by EXACT membership in
    // the inserted table (record_key + version), so no forward-path row and no
    // key outside this run can be deleted.
    await client.query(
      `DELETE FROM record_changes rc
        USING ${quoteIdent(insertedTable)} ins
       WHERE rc.connector_instance_id = ins.connector_instance_id
         AND rc.stream = ins.stream
         AND rc.record_key = ins.record_key
         AND rc.version = ins.version
         AND rc.connector_instance_id = $1
         AND rc.stream = $2`,
      [connectorInstanceId, TARGET_STREAM],
    );
    const delRecords = await client.query(
      `DELETE FROM records r
        USING ${quoteIdent(insertedTable)} ins
       WHERE r.connector_instance_id = ins.connector_instance_id
         AND r.stream = ins.stream
         AND r.record_key = ins.record_key
         AND r.version = ins.version
         AND r.connector_instance_id = $1
         AND r.stream = $2`,
      [connectorInstanceId, TARGET_STREAM],
    );
    deleted = delRecords.rowCount;
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
  return { runId, deleted };
}

// ─── Argv parsing ───────────────────────────────────────────────────────

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

/** Deterministic-enough run id. Not cryptographic — just a unique table suffix. */
function newRunId() {
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const rollbackRunId = typeof args.rollback === 'string' ? args.rollback : null;
  const rollbackRequested = !!args.rollback;
  const connectorInstanceId = args.instance || DEFAULT_USAA_INSTANCE;
  const databaseUrl =
    args.db || process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;

  if (apply && rollbackRequested) {
    console.error('--apply and --rollback are mutually exclusive');
    process.exit(2);
  }
  if (rollbackRequested && !rollbackRunId) {
    console.error('--rollback requires a runId: --rollback=<runId>');
    process.exit(2);
  }
  if (!databaseUrl) {
    console.error(
      'a database is required: pass --db=<postgres-url> or set PDPP_DATABASE_URL / PDPP_TEST_POSTGRES_URL',
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const r = await pool.query(
      `SELECT connector_id FROM connector_instances WHERE connector_instance_id = $1`,
      [connectorInstanceId],
    );
    if (!r.rows.length) {
      console.error(`connector_instance_id "${connectorInstanceId}" not found`);
      process.exit(2);
    }
    const connectorId = r.rows[0].connector_id;

    if (rollbackRunId) {
      const result = await applyRollback({ pool, connectorInstanceId, runId: rollbackRunId });
      await markScopesDirty({ pool, connectorInstanceId, stream: TARGET_STREAM });
      console.log(
        `ROLLBACK run ${result.runId}: deleted ${result.deleted} backfilled account_stats observation(s).`,
      );
      return;
    }

    const plan = await planBackfill({ pool, connectorId, connectorInstanceId });
    printPlan({ plan, apply });

    if (apply) {
      const runId = newRunId();
      const result = await applyBackfill({ pool, plan, runId });
      await markScopesDirty({ pool, connectorInstanceId, stream: TARGET_STREAM });
      console.log(
        `APPLIED backfill run ${result.runId}: inserted ${result.inserted}, skipped ${result.skipped}. ` +
        `source backup "${result.sourceTable}"; inserted-key table "${result.insertedTable}". ` +
        `Roll back with --rollback=${result.runId}.`,
      );
    }
  } catch (err) {
    console.error('backfill-usaa-account-stats failed:', err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

function printPlan({ plan, apply }) {
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`backfill-usaa-account-stats: ${mode} — ${plan.connectorInstanceId}/${plan.sourceStream} → ${plan.targetStream}`);
  console.log(`  scannedKeys:        ${plan.scannedKeys}`);
  console.log(`  scannedVersions:    ${plan.scannedVersions}`);
  console.log(`  candidates:         ${plan.candidateCount}`);
  console.log(`  skipped (present):  ${plan.skipped}`);
  console.log(`  sameDayResolved:    ${plan.sameDayResolved}`);
  console.log(`  net-new (insert):   ${plan.insertCount}`);
}
