#!/usr/bin/env node
/**
 * cleanup-phantom-connections
 *
 * Owner/operator-only, dry-run-default operational tool that REVOKES residual
 * phantom default-account `connector_instances` rows left behind by the
 * read-time catalog fan-out that `main` already removed
 * (`separate-connector-catalog-from-connections`).
 *
 * Background
 * ----------
 * Before the fix, the dashboard / catalog read
 * (`listConnectorInstanceRowsForDashboard`) called
 * `ensureDefaultAccountConnection` for every registered public connector when
 * the owner had zero connections. That `upsert` persisted `status:'active'`
 * default-account rows — "phantom" connections the owner never created, each
 * with zero records, which surfaced on every owner-connections surface and
 * (worse) participated in grant fan-in resolution. `main` stopped the read
 * from creating NEW phantoms; this script reduces the EXISTING residual rows
 * on an instance that was materialized before the fix landed.
 *
 * Why REVOKE, not DELETE
 * ----------------------
 * A default-account row has a DETERMINISTIC id
 * (`makeDefaultAccountConnectorInstanceId(owner, connector_id)`). The
 * connection-delete contract (`assertDeletableConnection`) deliberately
 * REFUSES to hard-delete a default-account binding
 * (`default_account_delete_unsupported`) precisely because a hard delete would
 * be silently re-materialized to `active` by the next
 * `ensureDefaultAccountConnection` call, since no deletion-tombstone ledger
 * exists. REVOKE is the contract's prescribed terminal state for these rows:
 *   - the durability guard in `ensureDefaultAccountConnection` returns a
 *     `revoked` row unchanged rather than resurrecting it, so the revoke
 *     survives every future read;
 *   - the dashboard projection (`listConnectorInstanceRowsForDashboard`)
 *     already filters out `status === 'revoked'` rows, so a revoked phantom
 *     disappears from every owner-connections surface;
 *   - grant fan-in (`listActiveByConnector`, SQL `WHERE status='active'`)
 *     skips revoked rows, so the grant-resolution leak is closed.
 * Revoke therefore achieves the cleanup goal (the row is gone from every
 * owner-facing surface and from grant resolution) with NO destructive cascade
 * and NO re-materialization risk.
 *
 * Safety predicate (ALL must hold — fail closed on ANY ambiguity)
 * ---------------------------------------------------------------
 * A row is a candidate ONLY if every one of these is true:
 *   P1. Default-account provenance: source_kind === 'account',
 *       source_binding_key === 'default', and source_binding_json parses to
 *       exactly { kind: 'default_account' }.
 *   P2. Deterministic-id self-consistency: the row's connector_instance_id
 *       equals makeDefaultAccountConnectorInstanceId(owner, connector_id).
 *       (Proves it is a materialized default-account row, not a spoofed
 *       binding that merely copied the marker fields.)
 *   P3. status === 'active' (a non-active row is already clean; we never
 *       touch paused/revoked rows).
 *   P4. Zero data across EVERY connector_instance_id-keyed evidence table:
 *       records, record_changes, blobs, connector_state, version_counter,
 *       grant_connector_state, connector_attention_records,
 *       connector_detail_gaps.
 *   P5. No grant references the row: no `grants` row whose
 *       storage_binding_json mentions this connector_instance_id, and no
 *       grant_package_member references it.
 *   P6. No active run (controller_active_runs), no schedule
 *       (connector_schedules), no device source instance
 *       (device_source_instances).
 *   P7. No credential row (connector_instance_credentials).
 * Any row that fails the predicate, or whose evidence cannot be evaluated, is
 * SKIPPED with a printed reason — never revoked. If a required evidence table
 * is MISSING (Postgres `to_regclass` is null), the row fails closed with a
 * `Px:<table>-table-missing` reason — missing evidence never silently passes.
 *
 * Output discipline
 * -----------------
 * Prints ONLY stable identifiers, counts, and reasons. Never prints secrets,
 * tokens, record payloads, grant bodies, binding JSON contents, or the
 * database URL / credentials.
 *
 * Backends
 * --------
 * Authorization is by direct database access. There is no HTTP route, no
 * scheduler, no automatic background job. Two backends are supported, matching
 * the reference's own storage layer:
 *   - SQLite (the reference default): `--db <path>` / PDPP_DB_PATH /
 *     PDPP_SQLITE_PATH.
 *   - Postgres (the reference's other supported backend, used by many
 *     deployments): `--database-url <url>` / PDPP_DATABASE_URL /
 *     PDPP_TEST_POSTGRES_URL.
 * Exactly one backend is selected per run. A Postgres URL (flag or env) selects
 * the Postgres arm; otherwise the SQLite arm is used. Both arms share the same
 * deny-by-default predicate (`reasonsFromEvidence`) and the same revoke action
 * (`status='revoked'`, set `updated_at`/`revoked_at`); the Postgres apply wraps
 * all updates in one transaction.
 *
 * Usage
 * -----
 *   # Dry run (default): identify candidates, mutate nothing.
 *   node .../cleanup-phantom-connections.mjs --db /path/to/pdpp.sqlite
 *   node .../cleanup-phantom-connections.mjs --database-url postgres://.../pdpp
 *
 *   # Apply: revoke the identified candidates.
 *   node .../cleanup-phantom-connections.mjs --db /path/to/pdpp.sqlite --apply
 *   node .../cleanup-phantom-connections.mjs --database-url postgres://.../pdpp --apply
 *
 *   # JSON verdict to stdout.
 *   node ... --db /path/to/pdpp.sqlite --json
 *
 *   # Print the predicate without touching a DB.
 *   node ... --print-predicate
 *
 * Env (alternative to flags):
 *   PDPP_DB_PATH or PDPP_SQLITE_PATH               SQLite database file path
 *   PDPP_DATABASE_URL or PDPP_TEST_POSTGRES_URL    Postgres connection string
 *   PDPP_OWNER_SUBJECT_ID                          owner subject id (default: owner_local)
 *
 * Spec: openspec/changes/separate-connector-catalog-from-connections/
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { closeDb, getDb, initDb } from '../../server/db.js';
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from '../../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../../server/owner-auth.ts';

const DEFAULT_ACCOUNT_SOURCE_BINDING_KEY = 'default';

// Every table that carries a connector_instance_id and would represent real,
// owner-meaningful state. A candidate must have ZERO rows across ALL of them.
// (records/record_changes/blobs/state/versions = ingested data; attention/gaps
// = operator-visible work; grant_connector_state = a grant's per-connection
// cursor.) Listed explicitly rather than derived so a future schema addition
// does not silently widen the "is empty" claim — see the no-silent-caps rule.
const EVIDENCE_TABLES = Object.freeze([
  'records',
  'record_changes',
  'blobs',
  'connector_state',
  'version_counter',
  'grant_connector_state',
  'connector_attention_records',
  'connector_detail_gaps',
]);

// Single-instance lookups that block cleanup (P6 / P7). Each is a table whose
// presence of ANY row for the connector_instance_id means live activity or a
// stored credential. The reason label is what gets printed for a blocked row.
const ACTIVITY_TABLES = Object.freeze([
  { table: 'controller_active_runs', clause: 'P6', label: 'active-run' },
  { table: 'connector_schedules', clause: 'P6', label: 'schedule' },
  { table: 'device_source_instances', clause: 'P6', label: 'device-source-instance' },
  { table: 'connector_instance_credentials', clause: 'P7', label: 'credential' },
]);

function parseArgs(argv) {
  const opts = { db: null, databaseUrl: null, apply: false, json: false, printPredicate: false };
  let pending = null;
  for (const arg of argv) {
    if (pending) {
      opts[pending] = arg;
      pending = null;
      continue;
    }
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--print-predicate') opts.printPredicate = true;
    else if (arg.startsWith('--db=')) opts.db = arg.slice('--db='.length);
    else if (arg === '--db') pending = 'db';
    else if (arg.startsWith('--database-url=')) opts.databaseUrl = arg.slice('--database-url='.length);
    else if (arg === '--database-url') pending = 'databaseUrl';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (pending === 'db') throw new Error('--db requires a path argument');
  if (pending === 'databaseUrl') throw new Error('--database-url requires a connection-string argument');
  return opts;
}

/**
 * Decide which backend to use. A Postgres URL (flag or env) selects Postgres;
 * otherwise SQLite. Returns { kind: 'postgres', url } | { kind: 'sqlite', path }.
 * Throws if neither is resolvable.
 */
function resolveBackend(opts, env = process.env) {
  const databaseUrl = opts.databaseUrl || env.PDPP_DATABASE_URL || env.PDPP_TEST_POSTGRES_URL || '';
  if (databaseUrl) return { kind: 'postgres', url: databaseUrl };
  const path = opts.db || env.PDPP_DB_PATH || env.PDPP_SQLITE_PATH || '';
  if (path) return { kind: 'sqlite', path };
  throw new Error(
    'No database selected. Pass --db <path> (SQLite) or --database-url <url> (Postgres), ' +
      'or set PDPP_DB_PATH / PDPP_SQLITE_PATH / PDPP_DATABASE_URL / PDPP_TEST_POSTGRES_URL.',
  );
}

const PREDICATE_TEXT = `Phantom default-account cleanup safety predicate (ALL must hold; fail closed):
  P1 source_kind='account' AND source_binding_key='default' AND source_binding_json == {"kind":"default_account"}
  P2 connector_instance_id == deterministic makeDefaultAccountConnectorInstanceId(owner, connector_id)
  P3 status='active'
  P4 zero rows in: ${EVIDENCE_TABLES.join(', ')}
  P5 no grant references the connector_instance_id (grants.storage_binding_json, grant_package_members.source_json)
  P6 no controller_active_runs, no connector_schedules, no device_source_instances row
  P7 no connector_instance_credentials row
Missing evidence table => fail closed (Px:<table>-table-missing), never a silent pass.
Action on a passing row: updateStatus(id, { status: 'revoked' }). Never delete (deterministic id re-materializes).`;

// ─── Predicate (backend-agnostic) ─────────────────────────────────────────

/**
 * Shape of the per-instance evidence an arm gathers for the predicate:
 *   evidence (zero-data counts):     { [table]: number | 'missing' }
 *   grantStorageBindingRefs:         number
 *   grantPackageMemberRefs:          number | null   (null = table absent)
 *   activity:                        { [table]: number | 'missing' }
 * A 'missing' value (a required table that does not exist) fails closed.
 */

/**
 * Pure predicate: given an instance row and the gathered evidence, return the
 * BLOCKING reasons (empty array === candidate). Single source of truth for
 * P1–P7 across both backends. Performs NO IO.
 */
export function reasonsFromEvidence(instance, evidence) {
  const reasons = [];
  const id = instance.connectorInstanceId;

  // P1 — default-account provenance.
  const bindingIsDefault =
    instance.sourceBinding &&
    typeof instance.sourceBinding === 'object' &&
    !Array.isArray(instance.sourceBinding) &&
    Object.keys(instance.sourceBinding).length === 1 &&
    instance.sourceBinding.kind === 'default_account';
  if (
    instance.sourceKind !== 'account' ||
    instance.sourceBindingKey !== DEFAULT_ACCOUNT_SOURCE_BINDING_KEY ||
    !bindingIsDefault
  ) {
    reasons.push('P1:not-default-account-provenance');
    // Fail closed immediately: without P1 the deterministic-id check is not
    // even meaningful, and a non-default-account row is out of scope.
    return reasons;
  }

  // P2 — deterministic-id self-consistency.
  const expectedId = makeDefaultAccountConnectorInstanceId(instance.ownerSubjectId, instance.connectorId);
  if (id !== expectedId) {
    reasons.push('P2:id-not-deterministic-default-account');
  }

  // P3 — active only.
  if (instance.status !== 'active') {
    reasons.push(`P3:status-${instance.status}`);
  }

  // P4 — zero evidence rows across all instance-keyed tables.
  for (const table of EVIDENCE_TABLES) {
    const count = evidence.zeroData[table];
    if (count === 'missing') reasons.push(`P4:${table}-table-missing`);
    else if (Number(count) > 0) reasons.push(`P4:${table}=${Number(count)}`);
  }

  // P5 — no grant references this connection.
  if (evidence.grantStorageBindingRefs === 'missing') {
    reasons.push('P5:grants-table-missing');
  } else if (Number(evidence.grantStorageBindingRefs) > 0) {
    reasons.push(`P5:grant-storage-binding=${Number(evidence.grantStorageBindingRefs)}`);
  }
  // grant_package_members is optional in some schemas; null === table absent
  // (not a block — the table genuinely does not exist), a number is checked.
  if (evidence.grantPackageMemberRefs !== null && Number(evidence.grantPackageMemberRefs) > 0) {
    reasons.push(`P5:grant-package-member=${Number(evidence.grantPackageMemberRefs)}`);
  }

  // P6 / P7 — no active run, schedule, device source instance, or credential.
  for (const { table, clause, label } of ACTIVITY_TABLES) {
    const count = evidence.activity[table];
    if (count === 'missing') reasons.push(`${clause}:${table}-table-missing`);
    else if (Number(count) > 0) reasons.push(`${clause}:${label}=${Number(count)}`);
  }

  return reasons;
}

// ─── SQLite arm ────────────────────────────────────────────────────────────

function sqliteCountRows(db, sql, params) {
  const row = db.prepare(sql).get(...params);
  const value = row ? Object.values(row)[0] : 0;
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

function sqliteTableExists(db, name) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return Boolean(row);
}

/** Gather P4–P7 evidence for one instance from an open SQLite db (sync). */
function gatherSqliteEvidence(db, id) {
  const zeroData = {};
  for (const table of EVIDENCE_TABLES) {
    zeroData[table] = sqliteTableExists(db, table)
      ? sqliteCountRows(db, `SELECT COUNT(*) AS c FROM ${table} WHERE connector_instance_id = ?`, [id])
      : 'missing';
  }
  const grantStorageBindingRefs = sqliteTableExists(db, 'grants')
    ? sqliteCountRows(
        db,
        `SELECT COUNT(*) AS c FROM grants WHERE storage_binding_json IS NOT NULL AND instr(storage_binding_json, ?) > 0`,
        [id],
      )
    : 'missing';
  const grantPackageMemberRefs = sqliteTableExists(db, 'grant_package_members')
    ? sqliteCountRows(
        db,
        `SELECT COUNT(*) AS c FROM grant_package_members WHERE instr(COALESCE(source_json, ''), ?) > 0`,
        [id],
      )
    : null;
  const activity = {};
  for (const { table } of ACTIVITY_TABLES) {
    activity[table] = sqliteTableExists(db, table)
      ? sqliteCountRows(db, `SELECT COUNT(*) AS c FROM ${table} WHERE connector_instance_id = ?`, [id])
      : 'missing';
  }
  return { zeroData, grantStorageBindingRefs, grantPackageMemberRefs, activity };
}

/**
 * Evaluate the safety predicate for one instance row against an open SQLite db.
 * Returns { candidate: boolean, reasons: string[] }. Pure read-only.
 * Kept for in-process testing and backwards-compatible signature.
 */
export function evaluateInstance(db, instance) {
  const reasons = reasonsFromEvidence(instance, gatherSqliteEvidence(db, instance.connectorInstanceId));
  return { candidate: reasons.length === 0, reasons };
}

/**
 * Plan the cleanup over an already-open SQLite db (module-scoped via getDb()).
 * Pure read; returns candidate + skipped sets with reasons. Exported for
 * in-process testing.
 */
export function planCleanup({ ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database is not initialized.');
  const store = createSqliteConnectorInstanceStore();
  const instances = store.listByOwner(ownerSubjectId, { limit: 5000 });
  return buildPlan(ownerSubjectId, instances, (instance) => evaluateInstance(db, instance).reasons);
}

/**
 * Apply the revoke to a planned candidate set using the SQLite store soft-flip
 * primitive (the SAME primitive the owner-agent revoke route uses). No
 * cascade. Exported for in-process testing.
 */
export function applyRevoke(candidates, { now = new Date().toISOString() } = {}) {
  const store = createSqliteConnectorInstanceStore();
  const revoked = [];
  for (const entry of candidates) {
    const result = store.updateStatus(entry.connector_instance_id, {
      status: 'revoked',
      updatedAt: now,
      revokedAt: now,
    });
    revoked.push({
      connector_instance_id: entry.connector_instance_id,
      connector_id: entry.connector_id,
      status: result.status,
      revoked_at: result.revokedAt,
    });
  }
  return revoked;
}

// ─── Postgres arm ────────────────────────────────────────────────────────────

/** True if a regclass-qualified table exists in the connected Postgres db. */
async function pgTableExists(pool, name) {
  const r = await pool.query(`SELECT to_regclass($1) AS oid`, [name]);
  return Boolean(r.rows[0] && r.rows[0].oid);
}

async function pgCount(pool, sql, params) {
  const r = await pool.query(sql, params);
  const value = r.rows[0] ? Object.values(r.rows[0])[0] : 0;
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/** Gather P4–P7 evidence for one instance from a Postgres pool (async). */
async function gatherPostgresEvidence(pool, id) {
  const zeroData = {};
  for (const table of EVIDENCE_TABLES) {
    zeroData[table] = (await pgTableExists(pool, table))
      ? await pgCount(pool, `SELECT COUNT(*) AS c FROM ${table} WHERE connector_instance_id = $1`, [id])
      : 'missing';
  }
  const grantStorageBindingRefs = (await pgTableExists(pool, 'grants'))
    ? await pgCount(
        pool,
        // JSONB column: compare its text rendering. The deterministic id is an
        // opaque token (cin_<hex>) so a substring match is exact in practice.
        `SELECT COUNT(*) AS c FROM grants
          WHERE storage_binding_json IS NOT NULL
            AND position($1 IN storage_binding_json::text) > 0`,
        [id],
      )
    : 'missing';
  const grantPackageMemberRefs = (await pgTableExists(pool, 'grant_package_members'))
    ? await pgCount(
        pool,
        `SELECT COUNT(*) AS c FROM grant_package_members
          WHERE position($1 IN COALESCE(source_json::text, '')) > 0`,
        [id],
      )
    : null;
  const activity = {};
  for (const { table } of ACTIVITY_TABLES) {
    activity[table] = (await pgTableExists(pool, table))
      ? await pgCount(pool, `SELECT COUNT(*) AS c FROM ${table} WHERE connector_instance_id = $1`, [id])
      : 'missing';
  }
  return { zeroData, grantStorageBindingRefs, grantPackageMemberRefs, activity };
}

/**
 * Evaluate the safety predicate for one instance row against a Postgres pool.
 * Async sibling of `evaluateInstance`. Pure read-only. Exported for testing.
 */
export async function evaluateInstancePg(pool, instance) {
  const reasons = reasonsFromEvidence(instance, await gatherPostgresEvidence(pool, instance.connectorInstanceId));
  return { candidate: reasons.length === 0, reasons };
}

/**
 * Plan the cleanup over a Postgres pool. Pure read; identifies candidates and
 * skipped reasons WITHOUT mutation. Exported for in-process testing.
 */
export async function planCleanupPg({ pool, ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID }) {
  const store = createPostgresConnectorInstanceStore();
  const instances = await store.listByOwner(ownerSubjectId, { limit: 5000 });
  const evaluated = [];
  for (const instance of instances) {
    evaluated.push({ instance, reasons: (await evaluateInstancePg(pool, instance)).reasons });
  }
  return buildPlan(ownerSubjectId, evaluated.map((e) => e.instance), (instance) => {
    const found = evaluated.find((e) => e.instance.connectorInstanceId === instance.connectorInstanceId);
    return found.reasons;
  });
}

/**
 * Apply the revoke to a planned candidate set on Postgres inside ONE
 * transaction. Updates only candidate ids to status='revoked', setting
 * updated_at/revoked_at. No cascade. Exported for in-process testing.
 */
export async function applyRevokePg({ pool, candidates, now = new Date().toISOString() }) {
  const revoked = [];
  if (candidates.length === 0) return revoked;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of candidates) {
      const r = await client.query(
        // Re-assert status='active' in the WHERE so a row that changed between
        // plan and apply (a concurrent run, a new grant) is NOT revoked.
        `UPDATE connector_instances
            SET status = 'revoked', updated_at = $2, revoked_at = $2
          WHERE connector_instance_id = $1 AND status = 'active'
          RETURNING connector_instance_id, connector_id, status, revoked_at`,
        [entry.connector_instance_id, now],
      );
      if (r.rowCount === 1) {
        const row = r.rows[0];
        revoked.push({
          connector_instance_id: row.connector_instance_id,
          connector_id: row.connector_id,
          status: row.status,
          revoked_at: row.revoked_at,
        });
      }
      // rowCount === 0 means the row was no longer an active candidate; skip it
      // silently rather than forcing the revoke. It will reappear in the next
      // dry-run with its blocking reason.
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    client.release();
  }
  return revoked;
}

// ─── Shared plan/printing ────────────────────────────────────────────────────

function buildPlan(ownerSubjectId, instances, reasonsFor) {
  const candidates = [];
  const skipped = [];
  for (const instance of instances) {
    const reasons = reasonsFor(instance);
    const entry = {
      connector_instance_id: instance.connectorInstanceId,
      connector_id: instance.connectorId,
      status: instance.status,
    };
    if (reasons.length === 0) candidates.push(entry);
    else skipped.push({ ...entry, reasons });
  }
  return { ownerSubjectId, scanned: instances.length, candidates, skipped };
}

function printHuman(plan, { apply, revoked }) {
  const lines = [];
  lines.push(`owner_subject_id: ${plan.ownerSubjectId}`);
  lines.push(`scanned_connections: ${plan.scanned}`);
  lines.push(`phantom_candidates: ${plan.candidates.length}`);
  lines.push(`skipped: ${plan.skipped.length}`);
  lines.push('');
  if (plan.candidates.length > 0) {
    lines.push(apply ? 'REVOKED phantom default-account connections:' : 'WOULD REVOKE (dry-run) phantom default-account connections:');
    for (const c of plan.candidates) {
      lines.push(`  - ${c.connector_instance_id}  connector=${c.connector_id}  status=${c.status}`);
    }
    lines.push('');
  }
  if (plan.skipped.length > 0) {
    lines.push('Skipped (failed safety predicate; left untouched):');
    for (const s of plan.skipped) {
      lines.push(`  - ${s.connector_instance_id}  connector=${s.connector_id}  reasons=[${s.reasons.join(', ')}]`);
    }
    lines.push('');
  }
  if (apply) {
    lines.push(`applied: revoked ${revoked.length} connection(s).`);
  } else {
    lines.push('dry-run: no changes were made. Re-run with --apply to revoke the candidates above.');
  }
  return lines.join('\n');
}

function emit(plan, { apply, json, revoked }) {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          owner_subject_id: plan.ownerSubjectId,
          apply,
          scanned: plan.scanned,
          candidates: plan.candidates,
          skipped: plan.skipped,
          revoked,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${printHuman(plan, { apply, revoked })}\n`);
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function runSqlite({ path, ownerSubjectId, apply, json }) {
  initDb(path);
  try {
    const plan = planCleanup({ ownerSubjectId });
    let revoked = [];
    if (apply && plan.candidates.length > 0) {
      revoked = applyRevoke(plan.candidates);
    }
    emit(plan, { apply, json, revoked });
  } finally {
    closeDb();
  }
}

async function runPostgres({ url, ownerSubjectId, apply, json }) {
  // Lazy import so the SQLite arm (and `--print-predicate`) never requires `pg`.
  const { initPostgresStorage, closePostgresStorage, getPostgresPool } = await import(
    '../../server/postgres-storage.js'
  );
  // initPostgresStorage installs the module-scoped pool that the store layer
  // (createPostgresConnectorInstanceStore → postgresQuery) and our evidence
  // queries both talk through. Use that ONE pool for everything, including the
  // apply transaction (pool.connect()). It also bootstraps the schema, so a
  // missing-table fail-closed path only triggers on a genuinely divergent
  // deployment, not a fresh db.
  await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
  const pool = getPostgresPool();
  try {
    const plan = await planCleanupPg({ pool, ownerSubjectId });
    let revoked = [];
    if (apply && plan.candidates.length > 0) {
      revoked = await applyRevokePg({ pool, candidates: plan.candidates });
    }
    emit(plan, { apply, json, revoked });
  } finally {
    await closePostgresStorage().catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.printPredicate) {
    process.stdout.write(`${PREDICATE_TEXT}\n`);
    return 0;
  }
  const backend = resolveBackend(opts);
  const ownerSubjectId = process.env.PDPP_OWNER_SUBJECT_ID || OWNER_AUTH_DEFAULT_SUBJECT_ID;

  if (backend.kind === 'postgres') {
    await runPostgres({ url: backend.url, ownerSubjectId, apply: opts.apply, json: opts.json });
  } else {
    await runSqlite({ path: backend.path, ownerSubjectId, apply: opts.apply, json: opts.json });
  }
  return 0;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
