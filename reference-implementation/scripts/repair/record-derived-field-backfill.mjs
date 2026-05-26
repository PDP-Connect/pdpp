#!/usr/bin/env node

/**
 * record-derived-field-backfill
 *
 * Owner-only operational tool that repairs current `records` rows whose
 * derived fields were clobbered by a connector's prior runs. The repair
 * is scoped per-stream by a registered policy and is strictly additive:
 * it allocates new versions through the atomic allocator and appends a
 * new `record_changes` row per repaired record. It never mutates or
 * deletes any existing history row.
 *
 * Scope (current policies):
 *   - codex:sessions — refill `message_count` and `function_call_count`
 *     from the most recent prior `record_changes` row that carries a
 *     non-null value, when the current row is byte-equivalent (jsonb
 *     structural equality) to that prior row except for those two
 *     fields being null vs non-null.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/record-derived-field-backfill.mjs \
 *     --connector-instance-id=cin_... \
 *     --stream=sessions \
 *     [--record-key=<key>] \
 *     [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL   required (postgres connection string)
 *
 * Default is dry-run. Use --apply to actually write the repairs.
 *
 * Spec: openspec/changes/repair-record-version-noop-detection/specs/
 *       reference-implementation-architecture/spec.md
 */

import pg from 'pg';
import process from 'node:process';

const { Pool } = pg;

// ─── Policy registry ────────────────────────────────────────────────────

/**
 * A repair policy describes how to detect a repairable record for a
 * specific stream and how to merge the prior row's value into the
 * current row.
 *
 * Each policy is `{ derivedFields: string[], priorIsBetter(current, prior): boolean }`.
 *
 *   - `derivedFields` is the set of payload keys the repair may refill.
 *     The policy SHALL refill only these keys; everything else is
 *     copied from the current row.
 *   - `priorIsBetter(current, prior)` decides if a candidate prior row
 *     should be preferred. It runs per (current row, candidate prior)
 *     pair, ordered by descending prior version. Return true to use
 *     the prior values and stop searching.
 *
 * The repair refuses to write unless the merged result is structurally
 * different from the current row.
 */
const REPAIR_POLICIES = {
  // The Codex `sessions` derived-field repair: the only currently
  // recognised stream. Adding a new entry here is a code-review gate.
  sessions: {
    label: 'codex:sessions',
    derivedFields: ['message_count', 'function_call_count'],
    priorIsBetter(current, prior) {
      // Only refill when current is null and prior is non-null. Never
      // overwrite an existing value.
      if (current.message_count == null && prior.message_count != null) return true;
      if (current.function_call_count == null && prior.function_call_count != null) return true;
      return false;
    },
  },
};

const args = parseArgs(process.argv.slice(2));
const apply = !!args.apply;
const connectorInstanceId = args['connector-instance-id'];
const stream = args.stream;
const recordKey = args['record-key'] || null;
const limit = args.limit ? Number(args.limit) : null;
const databaseUrl =
  process.env.PDPP_DATABASE_URL ||
  process.env.PDPP_TEST_POSTGRES_URL ||
  null;

if (!connectorInstanceId || !stream) {
  console.error(
    'usage: record-derived-field-backfill --connector-instance-id=<id> --stream=<name> [--record-key=<key>] [--limit=N] [--apply]',
  );
  process.exit(2);
}

if (!databaseUrl) {
  console.error('PDPP_DATABASE_URL is required');
  process.exit(2);
}

const policy = REPAIR_POLICIES[stream];

if (!policy) {
  console.error(
    `no repair policy registered for stream "${stream}". Registered policies: ${Object.keys(REPAIR_POLICIES).join(', ')}`,
  );
  process.exit(2);
}

const pool = new Pool({ connectionString: databaseUrl });

let exitCode = 0;
try {
  const result = await runRepair({
    pool,
    connectorInstanceId,
    stream,
    recordKey,
    limit,
    policy,
    apply,
  });
  printSummary(result);
  exitCode = result.failed ? 1 : 0;
} finally {
  await pool.end();
}
process.exit(exitCode);

// ─── Repair loop ────────────────────────────────────────────────────────

async function runRepair({
  pool,
  connectorInstanceId,
  stream,
  recordKey,
  limit,
  policy,
  apply,
}) {
  const previews = [];
  let failed = false;

  const filters = [
    'connector_instance_id = $1',
    'stream = $2',
    'deleted = FALSE',
  ];
  const params = [connectorInstanceId, stream];
  if (recordKey) {
    filters.push(`record_key = $${params.length + 1}`);
    params.push(recordKey);
  }
  // Cheap pre-filter: at least one derived field must be null (or
  // missing) on the current row to be worth scanning history.
  const nullChecks = policy.derivedFields
    .map((f) => `(NOT (record_json ? '${f}') OR record_json->>'${f}' IS NULL)`)
    .join(' OR ');
  filters.push(`(${nullChecks})`);

  const limitClause = limit ? `LIMIT ${Number(limit)}` : '';
  const currentRows = await pool.query(
    `SELECT connector_id, record_key, record_json, version AS current_version
     FROM records
     WHERE ${filters.join(' AND ')}
     ${limitClause}`,
    params,
  );

  for (const row of currentRows.rows) {
    const current = row.record_json;
    // Find a prior change row with a better derived-field set.
    const history = await pool.query(
      `SELECT version, record_json
       FROM record_changes
       WHERE connector_instance_id = $1
         AND stream = $2
         AND record_key = $3
         AND deleted = FALSE
       ORDER BY version DESC
       LIMIT 200`,
      [connectorInstanceId, stream, row.record_key],
    );

    let chosen = null;
    for (const h of history.rows) {
      if (h.version === row.current_version) continue;
      if (policy.priorIsBetter(current, h.record_json)) {
        chosen = h;
        break;
      }
    }
    if (!chosen) continue;

    const merged = mergePayload(current, chosen.record_json, policy.derivedFields);
    if (await isStructurallyEqual(pool, current, merged)) {
      // Nothing to write.
      continue;
    }

    previews.push({
      connectorId: row.connector_id,
      recordKey: row.record_key,
      currentVersion: row.current_version,
      sourceVersion: chosen.version,
      fieldsRefilled: policy.derivedFields.filter(
        (f) => current[f] !== merged[f],
      ),
      merged,
    });
  }

  if (apply) {
    for (const p of previews) {
      try {
        await applyRepair({
          pool,
          connectorInstanceId,
          stream,
          recordKey: p.recordKey,
          connectorId: p.connectorId,
          mergedJson: p.merged,
        });
      } catch (err) {
        failed = true;
        p.error = String(err && err.message ? err.message : err);
      }
    }
  }

  return { previews, applied: apply, failed };
}

function mergePayload(current, prior, derivedFields) {
  const merged = { ...current };
  for (const f of derivedFields) {
    if (merged[f] == null && prior[f] != null) {
      merged[f] = prior[f];
    }
  }
  return merged;
}

async function isStructurallyEqual(pool, a, b) {
  const r = await pool.query(
    `SELECT $1::jsonb IS NOT DISTINCT FROM $2::jsonb AS eq`,
    [JSON.stringify(a), JSON.stringify(b)],
  );
  return r.rows[0]?.eq === true;
}

async function applyRepair({
  pool,
  connectorInstanceId,
  stream,
  recordKey,
  connectorId,
  mergedJson,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nextVersion = await allocateNextVersion(client, {
      connectorId,
      connectorInstanceId,
      stream,
    });
    const emittedAt = new Date().toISOString();
    const jsonText = JSON.stringify(mergedJson);
    await client.query(
      `INSERT INTO records
         (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, NULL, NULL, $4)
       ON CONFLICT (connector_instance_id, stream, record_key) DO UPDATE
         SET connector_id = EXCLUDED.connector_id,
             record_json = EXCLUDED.record_json,
             emitted_at = EXCLUDED.emitted_at,
             version = EXCLUDED.version`,
      [connectorId, connectorInstanceId, stream, recordKey, jsonText, emittedAt, nextVersion],
    );
    await client.query(
      `INSERT INTO record_changes
         (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE, NULL)`,
      [connectorId, connectorInstanceId, stream, recordKey, nextVersion, jsonText, emittedAt],
    );
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function allocateNextVersion(client, { connectorId, connectorInstanceId, stream }) {
  const r = await client.query(
    `INSERT INTO version_counter (connector_id, connector_instance_id, stream, max_version)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE
       SET max_version = version_counter.max_version + 1
     RETURNING max_version`,
    [connectorId, connectorInstanceId, stream],
  );
  return Number(r.rows[0].max_version);
}

// ─── Output ─────────────────────────────────────────────────────────────

function printSummary({ previews, applied, failed }) {
  console.log(
    `record-derived-field-backfill: ${applied ? 'APPLIED' : 'DRY-RUN'} — ` +
      `${previews.length} record(s) ${applied ? 'repaired' : 'would be repaired'}`,
  );
  if (failed) {
    console.log('  status: some repairs failed (see per-row errors below)');
  }
  for (const p of previews.slice(0, 20)) {
    const tag = p.error ? `FAIL  ` : applied ? `APPLY ` : `DRY   `;
    console.log(
      `  ${tag} record_key=${p.recordKey} current_version=${p.currentVersion} source_version=${p.sourceVersion} fields=${p.fieldsRefilled.join(',')}`,
    );
    if (p.error) console.log(`         error: ${p.error}`);
  }
  if (previews.length > 20) {
    console.log(`  … and ${previews.length - 20} more`);
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
