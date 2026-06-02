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
 *       grant_connector_state / grant_package row references it.
 *   P6. No active run (controller_active_runs), no schedule
 *       (connector_schedules), no device source instance
 *       (device_source_instances).
 *   P7. No credential row (connector_instance_credentials).
 * Any row that fails the predicate, or whose evidence cannot be evaluated, is
 * SKIPPED with a printed reason — never revoked.
 *
 * Output discipline
 * -----------------
 * Prints ONLY stable identifiers, counts, and reasons. Never prints secrets,
 * tokens, record payloads, grant bodies, or binding JSON contents.
 *
 * Authorization is by direct database access — possession of the SQLite DB
 * path (PDPP_DB_PATH / PDPP_SQLITE_PATH / --db). There is no HTTP route, no
 * scheduler, no automatic background job. SQLite only: the reference's default
 * and the backend this residue exists on. A Postgres deployment should use the
 * same predicate via `--print-predicate` and an operator-reviewed UPDATE.
 *
 * Usage
 * -----
 *   # Dry run (default): identify candidates, mutate nothing.
 *   node reference-implementation/scripts/cleanup-phantom-connections/cleanup-phantom-connections.mjs --db /path/to/pdpp.sqlite
 *
 *   # Apply: revoke the identified candidates.
 *   node reference-implementation/scripts/cleanup-phantom-connections/cleanup-phantom-connections.mjs --db /path/to/pdpp.sqlite --apply
 *
 *   # JSON verdict to stdout.
 *   node ... --db /path/to/pdpp.sqlite --json
 *
 * Env (alternative to --db):
 *   PDPP_DB_PATH or PDPP_SQLITE_PATH    SQLite database file path
 *   PDPP_OWNER_SUBJECT_ID               owner subject id (default: owner_local)
 *
 * Spec: openspec/changes/separate-connector-catalog-from-connections/
 */

import process from 'node:process';

import { closeDb, getDb, initDb } from '../../server/db.js';
import {
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

function parseArgs(argv) {
  const opts = { db: null, apply: false, json: false, printPredicate: false };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--print-predicate') opts.printPredicate = true;
    else if (arg.startsWith('--db=')) opts.db = arg.slice('--db='.length);
    else if (arg === '--db') opts.db = '__NEXT__';
    else if (opts.db === '__NEXT__') opts.db = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.db === '__NEXT__') throw new Error('--db requires a path argument');
  return opts;
}

function resolveDbPath(opts) {
  const path = opts.db || process.env.PDPP_DB_PATH || process.env.PDPP_SQLITE_PATH || '';
  if (!path) {
    throw new Error(
      'No database path. Pass --db <path> or set PDPP_DB_PATH / PDPP_SQLITE_PATH. ' +
        'This tool is SQLite-only; a Postgres deployment must use --print-predicate.',
    );
  }
  return path;
}

const PREDICATE_TEXT = `Phantom default-account cleanup safety predicate (ALL must hold; fail closed):
  P1 source_kind='account' AND source_binding_key='default' AND source_binding_json == {"kind":"default_account"}
  P2 connector_instance_id == deterministic makeDefaultAccountConnectorInstanceId(owner, connector_id)
  P3 status='active'
  P4 zero rows in: ${EVIDENCE_TABLES.join(', ')}
  P5 no grant references the connector_instance_id (grants.storage_binding_json, grant_connector_state, grant_package_members)
  P6 no controller_active_runs, no connector_schedules, no device_source_instances row
  P7 no connector_instance_credentials row
Action on a passing row: updateStatus(id, { status: 'revoked' }). Never delete (deterministic id re-materializes).`;

function countRows(db, sql, params) {
  const row = db.prepare(sql).get(...params);
  // COUNT(*) always returns exactly one row; be defensive anyway.
  const value = row ? Object.values(row)[0] : 0;
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/**
 * Evaluate the safety predicate for one instance row. Returns
 * { candidate: boolean, reasons: string[] } where `reasons` lists the
 * predicate clauses that BLOCK cleanup (empty when candidate === true).
 * Pure read-only; performs no mutation.
 */
export function evaluateInstance(db, instance) {
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
    // Fail closed immediately: without P1 the deterministic-id check below is
    // not even meaningful, and a non-default-account row is out of scope.
    return { candidate: false, reasons };
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
    const count = countRows(db, `SELECT COUNT(*) AS c FROM ${table} WHERE connector_instance_id = ?`, [id]);
    if (count > 0) {
      reasons.push(`P4:${table}=${count}`);
    }
  }

  // P5 — no grant references this connection.
  // (a) any grant whose storage_binding_json text mentions the id.
  const grantBindingRefs = countRows(
    db,
    `SELECT COUNT(*) AS c FROM grants WHERE storage_binding_json IS NOT NULL AND instr(storage_binding_json, ?) > 0`,
    [id],
  );
  if (grantBindingRefs > 0) {
    reasons.push(`P5:grant-storage-binding=${grantBindingRefs}`);
  }
  // (b) grant_connector_state is also covered by P4, but a grant_package
  // member referencing the connection would not be. Check it explicitly.
  if (tableExists(db, 'grant_package_members')) {
    const pkgRefs = countRows(
      db,
      `SELECT COUNT(*) AS c FROM grant_package_members WHERE instr(COALESCE(source_json, ''), ?) > 0`,
      [id],
    );
    if (pkgRefs > 0) {
      reasons.push(`P5:grant-package-member=${pkgRefs}`);
    }
  }

  // P6 — no active run, schedule, or device source instance.
  const activeRuns = countRows(
    db,
    `SELECT COUNT(*) AS c FROM controller_active_runs WHERE connector_instance_id = ?`,
    [id],
  );
  if (activeRuns > 0) reasons.push(`P6:active-run=${activeRuns}`);
  const schedules = countRows(
    db,
    `SELECT COUNT(*) AS c FROM connector_schedules WHERE connector_instance_id = ?`,
    [id],
  );
  if (schedules > 0) reasons.push(`P6:schedule=${schedules}`);
  const devices = countRows(
    db,
    `SELECT COUNT(*) AS c FROM device_source_instances WHERE connector_instance_id = ?`,
    [id],
  );
  if (devices > 0) reasons.push(`P6:device-source-instance=${devices}`);

  // P7 — no credential row.
  const creds = countRows(
    db,
    `SELECT COUNT(*) AS c FROM connector_instance_credentials WHERE connector_instance_id = ?`,
    [id],
  );
  if (creds > 0) reasons.push(`P7:credential=${creds}`);

  return { candidate: reasons.length === 0, reasons };
}

function tableExists(db, name) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return Boolean(row);
}

/**
 * Plan the cleanup over an already-open DB (module-scoped via getDb()). Pure
 * read; returns the candidate set and the skipped set with reasons. Exported
 * for in-process testing.
 */
export function planCleanup({ ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database is not initialized.');
  const store = createSqliteConnectorInstanceStore();
  const instances = store.listByOwner(ownerSubjectId, { limit: 5000 });

  const candidates = [];
  const skipped = [];
  for (const instance of instances) {
    const { candidate, reasons } = evaluateInstance(db, instance);
    const entry = {
      connector_instance_id: instance.connectorInstanceId,
      connector_id: instance.connectorId,
      status: instance.status,
    };
    if (candidate) candidates.push(entry);
    else skipped.push({ ...entry, reasons });
  }
  return { ownerSubjectId, scanned: instances.length, candidates, skipped };
}

/**
 * Apply the revoke to a planned candidate set using the store soft-flip
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.printPredicate) {
    process.stdout.write(`${PREDICATE_TEXT}\n`);
    return 0;
  }
  const dbPath = resolveDbPath(opts);
  const ownerSubjectId = process.env.PDPP_OWNER_SUBJECT_ID || OWNER_AUTH_DEFAULT_SUBJECT_ID;

  initDb(dbPath);
  try {
    const plan = planCleanup({ ownerSubjectId });
    let revoked = [];
    if (opts.apply && plan.candidates.length > 0) {
      revoked = applyRevoke(plan.candidates);
    }
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            owner_subject_id: plan.ownerSubjectId,
            apply: opts.apply,
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
      process.stdout.write(`${printHuman(plan, { apply: opts.apply, revoked })}\n`);
    }
    return 0;
  } finally {
    closeDb();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
