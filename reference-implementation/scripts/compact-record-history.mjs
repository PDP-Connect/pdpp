#!/usr/bin/env node

/**
 * compact-record-history
 *
 * Owner/operator-only operational tool that compacts provably-redundant
 * adjacent historical `record_changes` rows under a per-stream
 * fingerprint policy that mirrors the connector's own no-op-emit
 * definition.
 *
 * Scope is deny-by-default. Only the five `(connector_id, stream)` pairs
 * whose connectors ship a semantic fingerprint cursor (a08d7a0a,
 * 47ec8edd) are eligible:
 *
 *   - gmail / threads
 *   - slack / workspace   (fingerprint excludes `fetched_at`)
 *   - slack / users
 *   - slack / files
 *   - ynab  / payee_locations
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (or `PDPP_TEST_POSTGRES_URL`). There is no HTTP
 * route, no scheduler, no automatic background job.
 *
 * Default is dry-run. Use --apply to actually delete redundant rows.
 *
 * Apply safety:
 *   - Per-run backup table `compact_record_history_backup_<runId>` is
 *     created and populated with every row to be deleted, INSIDE the
 *     same transaction as the DELETE. The table persists after commit
 *     as the operator's rollback handle.
 *   - Insert/delete row counts are asserted equal before commit; any
 *     mismatch rolls the transaction back.
 *
 * Usage:
 *   node reference-implementation/scripts/compact-record-history.mjs \
 *     --connector-instance-id=cin_... \
 *     --stream=threads \
 *     [--connector-id=gmail] \
 *     [--limit-keys=<positive-int>] \
 *     [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL or PDPP_TEST_POSTGRES_URL    required
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import { createHash } from 'node:crypto';
import process from 'node:process';

import pg from 'pg';

const { Pool } = pg;

// ─── Policy registry ────────────────────────────────────────────────────

/**
 * A compaction policy declares the per-stream fingerprint definition the
 * connector uses to decide whether a freshly-emitted record is "the same
 * record" as its prior version. This script mirrors that definition
 * one-for-one so a "removable historical version" classification here
 * matches the connector's "no-op emit" classification.
 *
 * Adding a new entry here is a code-review gate. The policy must
 * reference an existing connector-side fingerprint helper.
 *
 *   - `connectorId`: the connector_id column value the policy applies to.
 *   - `stream`: the stream column value the policy applies to.
 *   - `excludeKeys`: payload keys excluded from the fingerprint. Mirrors
 *     the connector's `excludeKeys` argument to its own fingerprint
 *     helper. Slack `workspace` excludes `fetched_at` because the
 *     connector excludes it (a08d7a0a — without exclusion the connector
 *     gate would never fire and the 31k-version workspace churn would
 *     not stop).
 *   - `connectorSource`: the connector file the policy mirrors. Pure
 *     documentation; not consumed at runtime.
 */
export const COMPACTION_POLICIES = [
  {
    connectorIds: ['gmail', 'https://registry.pdpp.org/connectors/gmail'],
    stream: 'threads',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/gmail/parsers.ts:buildThreadFingerprint',
  },
  {
    connectorIds: ['slack', 'https://registry.pdpp.org/connectors/slack'],
    stream: 'workspace',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/slack/parsers.ts:recordFingerprint + index.ts FINGERPRINTED_STREAMS (workspace excludes fetched_at)',
  },
  {
    connectorIds: ['slack', 'https://registry.pdpp.org/connectors/slack'],
    stream: 'users',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/slack/parsers.ts:recordFingerprint',
  },
  {
    connectorIds: ['slack', 'https://registry.pdpp.org/connectors/slack'],
    stream: 'files',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/slack/parsers.ts:recordFingerprint',
  },
  {
    connectorIds: ['ynab', 'https://registry.pdpp.org/connectors/ynab'],
    stream: 'payee_locations',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/ynab/index.ts:payeeLocationFingerprint',
  },
];

export function findPolicy(connectorId, stream) {
  return (
    COMPACTION_POLICIES.find(
      (p) => p.connectorIds.includes(connectorId) && p.stream === stream,
    ) || null
  );
}

export function describePolicies() {
  return COMPACTION_POLICIES.map(
    (p) =>
      `  - ${p.connectorIds[0]}/${p.stream}${p.excludeKeys.length ? ` (excludes ${p.excludeKeys.join(',')})` : ''}`,
  ).join('\n');
}

// ─── Fingerprint helper ─────────────────────────────────────────────────

/**
 * Stable per-record fingerprint. Same shape as the connector-side
 * `recordFingerprint` / `buildThreadFingerprint` / `payeeLocationFingerprint`
 * helpers: SHA-1 over a stable-stringified canonical form that sorts
 * object keys and excludes the named keys at the top level.
 *
 * Top-level-only exclusion matches the connector helpers — none of them
 * recurse exclude into nested objects.
 */
export function recordFingerprint(record, excludeKeys = []) {
  const exclude = new Set(excludeKeys);
  const canonical = stableStringify(record, exclude);
  return createHash('sha1').update(canonical).digest('hex');
}

function stableStringify(value, exclude) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, EMPTY_SET)).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([k]) => !exclude.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, EMPTY_SET)}`).join(',')}}`;
}

const EMPTY_SET = new Set();

// ─── Retention selector ─────────────────────────────────────────────────

/**
 * Decide which `record_changes` versions are safe to remove.
 *
 * `rows` is an array of `{ version, record_json, deleted }` sorted by
 * `version` ascending. `currentVersion` is the version of the same key
 * in `records`. `policy` provides `excludeKeys`.
 *
 * Retention rules (design.md §Retention rule):
 *
 *   - never remove `currentVersion`;
 *   - never remove a tombstone (`deleted = true`);
 *   - never remove the first version for the key;
 *   - never remove the most recent prior version whose fingerprint
 *     differs from the current row's fingerprint;
 *   - a tombstone bounds compaction — a non-tombstone whose
 *     immediately-prior surviving row is a tombstone is retained even
 *     if a same-fingerprint non-tombstone exists further back;
 *   - otherwise remove a non-tombstone whose immediately-prior
 *     surviving row is a non-tombstone with the same fingerprint.
 *
 * Returns an array of versions (numbers) that may be removed.
 */
export function selectRemovableVersions(rows, currentVersion, policy) {
  if (!rows.length) return [];

  const excludeKeys = policy.excludeKeys || [];

  // Pre-compute fingerprints once per row.
  const enriched = rows.map((r) => ({
    version: Number(r.version),
    deleted: !!r.deleted,
    fingerprint: r.deleted ? TOMBSTONE_FP : recordFingerprint(r.record_json || {}, excludeKeys),
  }));

  // Locate the current row's fingerprint (if present); used to retain the
  // most recent prior version with a different fingerprint.
  const currentRow = enriched.find((r) => r.version === Number(currentVersion));
  const currentFingerprint = currentRow ? currentRow.fingerprint : null;

  // Identify "the most recent prior row whose fingerprint differs from
  // the current row's fingerprint" — must be retained.
  let mostRecentDifferingPrior = null;
  if (currentRow) {
    for (let i = enriched.length - 1; i >= 0; i--) {
      const r = enriched[i];
      if (r.version >= currentRow.version) continue;
      if (r.fingerprint !== currentFingerprint) {
        mostRecentDifferingPrior = r.version;
        break;
      }
    }
  }

  const removable = [];

  // Walk ascending. `prevSurviving` is the prior row that survives — the
  // last one we did not mark removable. A tombstone is always a
  // surviving row.
  let prevSurviving = null;
  for (let i = 0; i < enriched.length; i++) {
    const row = enriched[i];

    // Hard pins: first row, current row, tombstone, most-recent-differing-prior.
    if (i === 0) {
      prevSurviving = row;
      continue;
    }
    if (row.version === Number(currentVersion)) {
      prevSurviving = row;
      continue;
    }
    if (row.deleted) {
      prevSurviving = row;
      continue;
    }
    if (row.version === mostRecentDifferingPrior) {
      prevSurviving = row;
      continue;
    }

    // Tombstones bound compaction — if the immediate predecessor is a
    // tombstone, this row marks a real resurrection and must be retained.
    if (prevSurviving && prevSurviving.deleted) {
      prevSurviving = row;
      continue;
    }

    // Same-fingerprint adjacent non-tombstone: removable.
    if (prevSurviving && prevSurviving.fingerprint === row.fingerprint) {
      removable.push(row.version);
      // prevSurviving does not change — the surviving anchor stays.
      continue;
    }

    // Otherwise, retain.
    prevSurviving = row;
  }

  return removable;
}

const TOMBSTONE_FP = '__tombstone__';

// ─── Argv parsing ───────────────────────────────────────────────────────

/**
 * Parse `--limit-keys`. Returns `null` if unset, a positive integer if
 * valid, or the sentinel string `'invalid'` if the value is present but
 * not a positive integer. The CLI rejects `'invalid'` early.
 */
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
      if (eq > 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

// ─── Compaction loop ────────────────────────────────────────────────────

export async function planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys }) {
  // Fetch the current row versions (and connector_id, for consistency).
  const limitClause = limitKeys ? `LIMIT ${Number(limitKeys)}` : '';
  const current = await pool.query(
    `SELECT connector_id, record_key, version
       FROM records
      WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
      ORDER BY record_key
      ${limitClause}`,
    [connectorInstanceId, stream],
  );

  let scannedKeys = 0;
  let scannedVersions = 0;
  const removableByKey = new Map();
  let removedBytesEstimate = 0;
  const connectorIdsSeen = new Set();

  for (const row of current.rows) {
    scannedKeys += 1;
    connectorIdsSeen.add(row.connector_id);
    const history = await pool.query(
      `SELECT version, record_json, deleted, octet_length(record_json::text) AS payload_bytes
         FROM record_changes
        WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
        ORDER BY version ASC`,
      [connectorInstanceId, stream, row.record_key],
    );
    scannedVersions += history.rows.length;
    const removable = selectRemovableVersions(history.rows, row.version, policy);
    if (removable.length) {
      removableByKey.set(row.record_key, removable);
      const removableSet = new Set(removable.map(Number));
      for (const h of history.rows) {
        if (removableSet.has(Number(h.version))) {
          removedBytesEstimate += Number(h.payload_bytes || 0);
        }
      }
    }
  }

  const removableVersions = Array.from(removableByKey.values()).reduce(
    (n, arr) => n + arr.length,
    0,
  );

  return {
    connectorInstanceId,
    stream,
    scannedKeys,
    scannedVersions,
    removableVersions,
    retainedVersionsAfter: scannedVersions - removableVersions,
    estimatedRemovedBytes: removedBytesEstimate,
    removableByKey,
    connectorIdsSeen: Array.from(connectorIdsSeen),
  };
}

export async function applyCompaction({ pool, plan, runId }) {
  if (!plan.removableVersions) {
    return { runId, backupTable: null, deleted: 0, inserted: 0 };
  }

  const backupTable = `compact_record_history_backup_${runId}`;
  // Create backup table once per run, shared across (connector_instance_id, stream).
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
       compacted_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const client = await pool.connect();
  let inserted = 0;
  let deleted = 0;
  try {
    await client.query('BEGIN');

    for (const [recordKey, versions] of plan.removableByKey) {
      const versionsAsNumbers = versions.map(Number);
      const insertRes = await client.query(
        `INSERT INTO ${quoteIdent(backupTable)}
           (connector_id, connector_instance_id, stream, record_key, version,
            record_json, emitted_at, deleted, deleted_at)
         SELECT connector_id, connector_instance_id, stream, record_key, version,
                record_json, emitted_at, deleted, deleted_at
           FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
            AND version = ANY($4::bigint[])`,
        [plan.connectorInstanceId, plan.stream, recordKey, versionsAsNumbers],
      );
      const deleteRes = await client.query(
        `DELETE FROM record_changes
           WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
             AND version = ANY($4::bigint[])`,
        [plan.connectorInstanceId, plan.stream, recordKey, versionsAsNumbers],
      );
      if (insertRes.rowCount !== versionsAsNumbers.length) {
        throw new Error(
          `backup insert count mismatch for ${plan.connectorInstanceId}/${plan.stream}/${recordKey}: expected ${versionsAsNumbers.length}, got ${insertRes.rowCount}`,
        );
      }
      if (deleteRes.rowCount !== insertRes.rowCount) {
        throw new Error(
          `delete/backup mismatch for ${plan.connectorInstanceId}/${plan.stream}/${recordKey}: backed up ${insertRes.rowCount}, deleted ${deleteRes.rowCount}`,
        );
      }
      inserted += insertRes.rowCount;
      deleted += deleteRes.rowCount;
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }

  return { runId, backupTable, deleted, inserted };
}

/**
 * Mark the retained-size projection dirty for the scope. We deliberately
 * keep this in a separate post-commit step rather than inside the
 * compaction transaction so a dirty-marker failure can never roll back
 * a successful compaction.
 */
export async function markScopeDirty({ pool, connectorInstanceId, stream }) {
  try {
    await pool.query(
      `UPDATE retained_size_stream
          SET dirty = 1
        WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream],
    );
    await pool.query(
      `UPDATE retained_size_connection
          SET dirty = 1
        WHERE connector_instance_id = $1`,
      [connectorInstanceId],
    );
    await pool.query(
      `UPDATE retained_size_global SET dirty = 1`,
    );
  } catch {
    // Dirty marker failure is non-fatal — the projection will be marked
    // dirty by the next bulk write or the next rebuild will detect drift.
  }
}

// Quote an identifier (table/column) for safe interpolation. The backup
// table name is composed from a generated runId, but we still defend
// against any future caller passing user input.
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// ─── CLI entry point ────────────────────────────────────────────────────

const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] || '');

if (invokedAsScript) {
  await runCli();
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;
  const connectorInstanceId = args['connector-instance-id'];
  const stream = args.stream;
  const explicitConnectorId = args['connector-id'] || null;
  const limitKeys = parseLimitKeys(args['limit-keys']);
  const databaseUrl =
    process.env.PDPP_DATABASE_URL ||
    process.env.PDPP_TEST_POSTGRES_URL ||
    null;

  if (!connectorInstanceId || !stream) {
    console.error(
      'usage: compact-record-history --connector-instance-id=<id> --stream=<name> [--connector-id=<id>] [--limit-keys=N] [--apply]',
    );
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

  // Resolve connector_id if not supplied: look it up from connector_instances.
  let connectorId = explicitConnectorId;
  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
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

    const policy = findPolicy(connectorId, stream);
    if (!policy) {
      console.error(
        `no compaction policy registered for connector_id="${connectorId}" stream="${stream}".\nRegistered policies:\n${describePolicies()}`,
      );
      process.exit(2);
    }

    const plan = await planCompaction({
      pool,
      connectorInstanceId,
      stream,
      policy,
      limitKeys,
    });

    printPlan({ plan, apply });

    if (apply && plan.removableVersions > 0) {
      const runId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const result = await applyCompaction({ pool, plan, runId });
      await markScopeDirty({
        pool,
        connectorInstanceId,
        stream,
      });
      console.log(
        `APPLIED: deleted ${result.deleted} row(s), backed up into "${result.backupTable}". retained_size_stream marked dirty for ${connectorInstanceId}/${stream}.`,
      );
    } else if (apply) {
      console.log('APPLIED: nothing to delete.');
    }
  } catch (err) {
    console.error('compact-record-history failed:', err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

function printPlan({ plan, apply }) {
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(
    `compact-record-history: ${mode} — ${plan.connectorInstanceId}/${plan.stream}`,
  );
  console.log(`  connector_id(s) seen: ${plan.connectorIdsSeen.join(', ') || '(none)'}`);
  console.log(`  scannedKeys:           ${plan.scannedKeys}`);
  console.log(`  scannedVersions:       ${plan.scannedVersions}`);
  console.log(`  removableVersions:     ${plan.removableVersions}`);
  console.log(`  retainedVersionsAfter: ${plan.retainedVersionsAfter}`);
  console.log(`  estimatedRemovedBytes: ${plan.estimatedRemovedBytes}`);
}
