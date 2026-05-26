#!/usr/bin/env node

/**
 * record-derived-field-backfill
 *
 * Owner/operator-only operational tool that repairs current `records`
 * rows whose registered derived fields were clobbered by a connector's
 * prior runs. The repair is scoped per-stream by a registered policy
 * and is strictly additive: it allocates new versions through the
 * atomic allocator and appends a new `record_changes` row per repaired
 * record. It never mutates or deletes any existing history row.
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (the same credential that grants owner-level
 * access to the reference Postgres). There is no HTTP route.
 *
 * Equivalence guard: a prior `record_changes` row is only used as a
 * refill source if, after removing every field in the policy's
 * `derivedFields` from both sides, current and prior are
 * jsonb-structurally equal. This ensures the repair only runs when
 * the prior row is genuinely "the same record minus the clobbered
 * derived fields" and never when some other (non-derived) field has
 * also changed.
 *
 * Scope (current policies):
 *   - sessions (codex) — refill `message_count` and `function_call_count`.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/record-derived-field-backfill.mjs \
 *     --connector-instance-id=cin_... \
 *     --stream=sessions \
 *     [--record-key=<key>] \
 *     [--limit=<positive-int>] \
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
 * A repair policy declares the set of derived fields that the repair
 * is permitted to refill for a stream. Adding a new entry here is a
 * code-review gate.
 *
 *   - `derivedFields` is the set of payload keys the repair may refill.
 *     The repair SHALL refill only these keys; everything else is
 *     copied from the current row. The equivalence guard (below)
 *     normalises these same keys away from both sides before deciding
 *     a prior `record_changes` row is a safe refill source.
 */
export const REPAIR_POLICIES = {
  // Codex sessions: the only currently recognised stream.
  sessions: {
    label: 'codex:sessions',
    derivedFields: ['message_count', 'function_call_count'],
  },
};

/**
 * Return a copy of `payload` with every field in `derivedFields`
 * removed. Used by the equivalence guard to compare current and prior
 * rows independent of the (possibly clobbered) derived fields.
 */
export function stripDerivedFields(payload, derivedFields) {
  const out = { ...payload };
  for (const f of derivedFields) {
    delete out[f];
  }
  return out;
}

/**
 * Decide whether `prior` is a safe refill source for `current`.
 *
 *   1. Equivalence guard — current and prior MUST be jsonb-structurally
 *      equal after removing all `derivedFields` from both sides. If not,
 *      some non-derived field has changed and the prior row does not
 *      represent the same record.
 *   2. There MUST be at least one derived field where `current[f]` is
 *      null AND `prior[f]` is non-null; otherwise there is nothing to
 *      refill.
 *
 * Returns `null` if `prior` is not usable; otherwise returns the
 * subset of derived fields that would actually be refilled.
 */
export async function evaluatePriorAsRefillSource(pool, current, prior, derivedFields) {
  const normalisedCurrent = stripDerivedFields(current, derivedFields);
  const normalisedPrior = stripDerivedFields(prior, derivedFields);
  if (!(await jsonbStructurallyEqual(pool, normalisedCurrent, normalisedPrior))) {
    return null;
  }
  const refillable = derivedFields.filter(
    (f) => current[f] == null && prior[f] != null,
  );
  return refillable.length > 0 ? refillable : null;
}

async function jsonbStructurallyEqual(pool, a, b) {
  const r = await pool.query(
    `SELECT $1::jsonb IS NOT DISTINCT FROM $2::jsonb AS eq`,
    [JSON.stringify(a), JSON.stringify(b)],
  );
  return r.rows[0]?.eq === true;
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

  if (limit === 'invalid') {
    console.error('--limit must be a positive integer');
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
}

/**
 * Parse `--limit`. Returns `null` if unset, a positive integer if
 * valid, or the sentinel string `'invalid'` if the value is present
 * but not a positive integer. The CLI rejects `'invalid'` early.
 */
export function parseLimit(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return 'invalid';
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 'invalid';
  return n;
}

// ─── Repair loop ────────────────────────────────────────────────────────

export async function runRepair({
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
    // Scan history newest-first. The first prior row that satisfies
    // the equivalence guard AND has at least one refillable derived
    // field is the chosen source; if none qualify, the record is
    // skipped (no version allocated, no row appended).
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
    let refillFields = null;
    for (const h of history.rows) {
      if (h.version === row.current_version) continue;
      const refillable = await evaluatePriorAsRefillSource(
        pool,
        current,
        h.record_json,
        policy.derivedFields,
      );
      if (refillable) {
        chosen = h;
        refillFields = refillable;
        break;
      }
    }
    if (!chosen) continue;

    const merged = mergePayload(current, chosen.record_json, refillFields);
    previews.push({
      connectorId: row.connector_id,
      recordKey: row.record_key,
      currentVersion: row.current_version,
      sourceVersion: chosen.version,
      fieldsRefilled: refillFields,
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

export function mergePayload(current, prior, derivedFields) {
  const merged = { ...current };
  for (const f of derivedFields) {
    if (merged[f] == null && prior[f] != null) {
      merged[f] = prior[f];
    }
  }
  return merged;
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
