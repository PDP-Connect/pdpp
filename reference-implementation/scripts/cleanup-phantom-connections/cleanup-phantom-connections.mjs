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
 *   P2. Default-account-id self-consistency, split into P2a (current) and P2b
 *       (legacy) — see `cleanup-legacy-default-account-id-connections`:
 *         P2a — the row's connector_instance_id equals the CURRENT
 *           makeDefaultAccountConnectorInstanceId(owner, connector_id).
 *         P2b — the id does NOT match the current formula, but the row is
 *           ACCEPTED because P1 above already proved default-account provenance
 *           (source_kind='account', source_binding_key='default',
 *           source_binding_json == {kind:'default_account'}); a legacy
 *           materialization minted under an earlier id-hash formula has exactly
 *           that shape with only the id hash differing. The original P2 hard
 *           block treated a legacy id as a spoofing risk, but spoofing is
 *           neutralized by P4–P7 (any record/grant/schedule/run/credential/
 *           device evidence still refuses the row), so a ZERO-evidence row with
 *           the exact default-account markers is a phantom regardless of which
 *           id formula minted it. P2b does not block; the legacy id is surfaced
 *           as an informational note (P2b:legacy-default-account-id).
 *           Durability: a revoked legacy row survives future reads because
 *           ensureDefaultAccountConnection's guard looks the row up BY BINDING
 *           (owner+connector+account+default), not by id, and returns a revoked
 *           row unchanged (no re-materialization). A non-default binding with a
 *           legacy id is still refused at P1, and a non-deterministic row with
 *           any real evidence is still refused at P4–P7.
 *   P3. status === 'active' (a non-active row is already clean; we never
 *       touch paused/revoked rows).
 *   P4. Zero data across EVERY connector_instance_id-keyed evidence table:
 *       records, record_changes, blobs, connector_state, version_counter,
 *       grant_connector_state, connector_attention_records,
 *       connector_detail_gaps.
 *   P5. No LOAD-BEARING grant scope references the row. P5 is split (see
 *       `cleanup-grant-referenced-zero-record-connections`):
 *         P5a (BLOCKS) — a `grants` row whose storage_binding_json names this
 *           connector_instance_id, OR an ACTIVE grant whose grant_json pins a
 *           stream to it via grant.streams[].connection_id. Both genuinely
 *           scope a read to this connection, so revoking would change what the
 *           grant can read.
 *         P5b (does NOT block) — a `grant_package_members.source_json`
 *           reference is a DISPLAY/audit pointer recorded at package-approval
 *           time. Read fan-in resolves over the connector's active connections
 *           plus the P5a grant-body pins; it never scopes a read from
 *           source_json. So this reference alone is surfaced as an
 *           informational note on the candidate, not a refusal. The revoke
 *           touches ONLY the connector_instances row; the grant package, its
 *           members, child grants, and tokens are left untouched.
 *   P6. No active run (controller_active_runs), no schedule
 *       (connector_schedules), no device source instance
 *       (device_source_instances).
 *   P7. No credential row (connector_instance_credentials).
 * Any row that fails the predicate, or whose evidence cannot be evaluated, is
 * SKIPPED with a printed reason — never revoked. If a required evidence table
 * is MISSING (Postgres `to_regclass` is null), the row fails closed with a
 * `Px:<table>-table-missing` reason — missing evidence never silently passes.
 *
 * Apply-time re-evaluation (TOCTOU safety)
 * ----------------------------------------
 * The dry-run plan is a SNAPSHOT. Between the plan and `--apply` a concurrent
 * write (a new record, grant, schedule, or credential) can make a planned
 * candidate no longer satisfy P4–P7 WITHOUT changing its status — so a bare
 * `WHERE status='active'` re-assert is NOT sufficient. Therefore, at apply time,
 * for EACH candidate the script re-fetches the instance and RE-EVALUATES the
 * full P1–P7 predicate against current evidence before revoking:
 *   - Postgres: inside ONE transaction, the row is locked with
 *     `SELECT ... FOR UPDATE` and all evidence queries run on the SAME client,
 *     so the re-check reads the same consistent snapshot the UPDATE mutates.
 *   - SQLite: the re-check + revoke run inside one `writeTransaction`; SQLite's
 *     single-writer lock serializes it against any other writer.
 * A candidate that fails the re-evaluation is reported under
 * `skipped_at_apply` and left untouched — never force-revoked.
 *
 * Missing-table fail-closed requires a NON-bootstrapping scan
 * -----------------------------------------------------------
 * The fail-closed missing-table guard is only real if the scan connection does
 * not create the tables first. Both `initDb` (SQLite) and `initPostgresStorage`
 * (Postgres) run `CREATE TABLE IF NOT EXISTS` for every known table at init, so
 * scanning through them turns "missing table" into "empty table". The Postgres
 * arm therefore opens its OWN `pg.Pool` directly and never calls
 * `initPostgresStorage`/`bootstrapPostgresSchema`; `to_regclass(null)` then
 * still blocks. The SQLite arm still goes through `initDb` (the store/query
 * layer is bound to the module-scoped handle), so on SQLite the missing-table
 * branch is a PREDICATE-LEVEL guarantee proven by `reasonsFromEvidence` tests,
 * but is not reachable via the SQLite CLI path (initDb always bootstraps). The
 * realistic divergent-deployment case is Postgres, where it IS reachable.
 *
 * Rollback / audit handle
 * ------------------------
 * The revoke is a non-destructive SOFT-FLIP: it changes only
 * status='revoked' + updated_at/revoked_at on the connector_instances row, with
 * NO cascade. It is reversible. The `--apply` output IS the rollback manifest:
 * the JSON `revoked[]` array lists every connector_instance_id revoked and its
 * revoked_at, so re-activating is:
 *   UPDATE connector_instances
 *      SET status = 'active', revoked_at = NULL
 *    WHERE connector_instance_id IN (<the revoked ids>);
 * (A default-account row re-activated this way will again project on the
 * dashboard and participate in grant fan-in, exactly as before the revoke.)
 * No separate backup file is written — a reversible soft-flip does not need one,
 * and the revoked-set output already provides the audit trail.
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
 * (`status='revoked'`, set `updated_at`/`revoked_at`); both wrap the apply-time
 * re-evaluation + revoke in one transaction (see "Apply-time re-evaluation").
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
 *   P5 split:  openspec/changes/cleanup-grant-referenced-zero-record-connections/
 *   P2 split:  openspec/changes/cleanup-legacy-default-account-id-connections/
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { closeDb, getDb, initDb } from '../../server/db.js';
import { writeTransaction } from '../../lib/db.ts';
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
  P2a/P2b default-account-id self-consistency:
      P2a connector_instance_id == deterministic makeDefaultAccountConnectorInstanceId(owner, connector_id), OR
      P2b a LEGACY default-account id (does NOT match the current formula) is ACCEPTED, because P1 above
          already proved default-account provenance and P4-P7 fail closed on any real evidence. The
          non-deterministic id is surfaced as an informational note (P2b:legacy-default-account-id), not a
          block. A revoked legacy row is durable: ensureDefaultAccountConnection's guard looks the row up by
          BINDING (owner+connector+account+default), not by id, and returns a revoked row unchanged.
  P3 status='active'
  P4 zero rows in: ${EVIDENCE_TABLES.join(', ')}
  P5a no LOAD-BEARING grant scope names the connector_instance_id:
      - grants.storage_binding_json names it (P5:grant-storage-binding), OR
      - an ACTIVE grant's grant_json pins a stream to it via grant.streams[].connection_id (P5:grant-stream-pin)
  P5b a grant_package_members.source_json reference is a DISPLAY pointer only and does NOT block;
      it is surfaced as an informational note (P5b:grant-package-member-display-ref). Read fan-in
      resolves over active connector_instances + the P5a grant-body pins, never over source_json.
  P6 no controller_active_runs, no connector_schedules, no device_source_instances row
  P7 no connector_instance_credentials row
Missing evidence table => fail closed (Px:<table>-table-missing), never a silent pass.
Action on a passing row: updateStatus(id, { status: 'revoked' }). Never delete: a deleted default-account
binding (current or legacy id) re-materializes to 'active' on the next read; a revoked one is returned
unchanged by the binding-keyed durability guard.
The revoke touches ONLY the connector_instances row; no grant, grant_package_member, child grant, or token is modified.`;

// ─── Predicate (backend-agnostic) ─────────────────────────────────────────

/**
 * Shape of the per-instance evidence an arm gathers for the predicate:
 *   evidence (zero-data counts):     { [table]: number | 'missing' }
 *   grantStorageBindingRefs:         number | 'missing'   (P5a — load-bearing)
 *   grantStreamPinRefs:              number | 'missing'   (P5a — load-bearing)
 *   grantPackageMemberRefs:          number | null        (P5b — display only;
 *                                                          null = table absent)
 *   activity:                        { [table]: number | 'missing' }
 * A 'missing' value (a required table that does not exist) fails closed.
 *
 * P2 is split into P2a (current deterministic id) and P2b (legacy id) — see
 * `cleanup-legacy-default-account-id-connections`. A legacy id does NOT block;
 * it is surfaced as a `P2b:legacy-default-account-id` note (see
 * `notesFromEvidence`). The blocking predicate (`reasonsFromEvidence`) does not
 * consult the id beyond P1's provenance markers.
 *
 * P5 is split into two distinct sub-checks (see
 * `separate-connector-catalog-from-connections` and
 * `cleanup-grant-referenced-zero-record-connections`):
 *
 *   P5a — LOAD-BEARING grant scope (BLOCKS). An active grant that pins this
 *         connector_instance_id through `grant.streams[].connection_id` in its
 *         grant body (`grantStreamPinRefs`), or that names it in its
 *         `storage_binding_json` (`grantStorageBindingRefs`), genuinely scopes
 *         a read to this connection. Revoking it would change what that grant
 *         can read, so it is a hard, non-relaxable refusal. A missing `grants`
 *         table fails closed.
 *   P5b — NON-load-bearing display reference (does NOT block; informational
 *         note only). A `grant_package_members.source_json` reference
 *         (`grantPackageMemberRefs`) is a display/audit pointer recorded at
 *         package-approval time. Read fan-in resolves over the connector's
 *         currently-active connections plus the grant-body pins above; it never
 *         scopes a read from `grant_package_members.source_json`. So this
 *         reference alone must NOT block cleanup — it is surfaced as a `note`
 *         so the dry-run still discloses it, then ignored as a refusal reason.
 */

/**
 * Pure predicate: given an instance row and the gathered evidence, return the
 * BLOCKING reasons (empty array === candidate). Single source of truth for
 * P1–P7 across both backends. Performs NO IO. The non-blocking P5b display
 * reference is reported separately by `notesFromEvidence`, not here.
 */
export function reasonsFromEvidence(instance, evidence) {
  const reasons = [];

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

  // P2 — default-account-id self-consistency (split into P2a current / P2b
  // legacy; see `cleanup-legacy-default-account-id-connections`).
  //
  //   P2a (current) — `connector_instance_id` equals the current deterministic
  //     `makeDefaultAccountConnectorInstanceId(owner, connector_id)`.
  //   P2b (legacy)  — the id does NOT match the current formula, but the row
  //     already PROVED default-account provenance to reach this line: P1 above
  //     verified `source_kind='account'` + `source_binding_key='default'` +
  //     `source_binding_json == {kind:'default_account'}` and returned early on
  //     any failure. A row that the legacy read-time fan-out materialized under
  //     an earlier id formula (or a different owner-subject hashing input) is
  //     exactly this shape: the marker fields are intact, only the id hash
  //     differs. The original P2 hard-block treated that legacy materialization
  //     as a spoofing risk, but spoofing is already neutralized downstream —
  //     P4–P7 fail closed on ANY record/grant/schedule/run/credential/device
  //     evidence, so a marker-spoofed row that carried real owner-meaningful
  //     state is still refused by its data. A zero-evidence row with the exact
  //     default-account markers is, behaviorally, a phantom regardless of which
  //     id formula minted it, and the revoke is a reversible soft-flip.
  //
  // Durability of a legacy revoke: `ensureDefaultAccountConnection`'s guard
  // looks the row up by BINDING (owner + connector + source_kind='account' +
  // source_binding_key='default'), not by id, and returns a `revoked` row
  // unchanged — so a revoked legacy row survives every future read exactly like
  // a revoked current-id row, with no re-materialization. (A genuinely missing
  // row re-materializes under the CURRENT id; that is correct, not a leak.)
  //
  // P2b therefore does NOT block. The non-deterministic id is surfaced as an
  // informational note (`notesFromEvidence`) so the dry-run discloses every
  // legacy revoke to the operator before they apply. P2a needs no note.

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

  // P5a — LOAD-BEARING grant scope blocks. A grant's storage_binding_json
  // naming this connector_instance_id, OR an active grant body pinning a
  // stream to it via grant.streams[].connection_id, genuinely scopes a read to
  // this connection. Both come from the `grants` table; a missing grants table
  // fails closed for both. (grant_package_members.source_json — the P5b display
  // reference — is NOT consulted here; it is a non-blocking note.)
  if (evidence.grantStorageBindingRefs === 'missing') {
    reasons.push('P5:grants-table-missing');
  } else if (Number(evidence.grantStorageBindingRefs) > 0) {
    reasons.push(`P5:grant-storage-binding=${Number(evidence.grantStorageBindingRefs)}`);
  }
  if (evidence.grantStreamPinRefs === 'missing') {
    // Same underlying `grants` table; emit the table-missing reason once.
    if (evidence.grantStorageBindingRefs !== 'missing') {
      reasons.push('P5:grants-table-missing');
    }
  } else if (Number(evidence.grantStreamPinRefs) > 0) {
    reasons.push(`P5:grant-stream-pin=${Number(evidence.grantStreamPinRefs)}`);
  }

  // P6 / P7 — no active run, schedule, device source instance, or credential.
  for (const { table, clause, label } of ACTIVITY_TABLES) {
    const count = evidence.activity[table];
    if (count === 'missing') reasons.push(`${clause}:${table}-table-missing`);
    else if (Number(count) > 0) reasons.push(`${clause}:${label}=${Number(count)}`);
  }

  return reasons;
}

/**
 * Pure: the NON-blocking informational notes for an instance+evidence. Notes
 * disclose facts about a candidate the operator should see before applying,
 * even though they did not block the revoke. Performs NO IO.
 *
 *   - `P2b:legacy-default-account-id` — the row's `connector_instance_id` does
 *     NOT equal the CURRENT deterministic
 *     `makeDefaultAccountConnectorInstanceId(owner, connector_id)`. Because
 *     notes are only attached to rows that already passed the full P1–P7
 *     predicate (P1 proved default-account provenance, P3 active, P4–P7 zero
 *     evidence), a non-matching id here is a legacy default-account
 *     materialization minted under an earlier id formula. The revoke is durable
 *     by binding (see the P2 comment in `reasonsFromEvidence`). Disclosed so the
 *     operator can see exactly which revokes target legacy ids.
 *   - `P5b:grant-package-member-display-ref` — a count of
 *     `grant_package_members.source_json` rows that name this connection (a
 *     display/audit pointer, not grant scope; see `reasonsFromEvidence` P5).
 *
 * Returns [] when nothing notable applies.
 */
export function notesFromEvidence(instance, evidence) {
  const notes = [];
  const expectedId = makeDefaultAccountConnectorInstanceId(instance.ownerSubjectId, instance.connectorId);
  if (instance.connectorInstanceId !== expectedId) {
    notes.push('P2b:legacy-default-account-id');
  }
  if (
    evidence.grantPackageMemberRefs !== null &&
    evidence.grantPackageMemberRefs !== 'missing' &&
    Number(evidence.grantPackageMemberRefs) > 0
  ) {
    notes.push(`P5b:grant-package-member-display-ref=${Number(evidence.grantPackageMemberRefs)}`);
  }
  return notes;
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
  const grantsTableExists = sqliteTableExists(db, 'grants');
  const grantStorageBindingRefs = grantsTableExists
    ? sqliteCountRows(
        db,
        `SELECT COUNT(*) AS c FROM grants WHERE storage_binding_json IS NOT NULL AND instr(storage_binding_json, ?) > 0`,
        [id],
      )
    : 'missing';
  // P5a — load-bearing grant-body stream pin. An ACTIVE grant whose grant_json
  // pins a stream to this connector_instance_id (grant.streams[].connection_id)
  // genuinely scopes a read. The id is an opaque cin_<hex> token, so a
  // substring match on the active grant's grant_json is conservative: it
  // catches the pin and any over-match only adds a (fail-closed) refusal. Only
  // status='active' grants scope reads, so a revoked grant does not block.
  const grantStreamPinRefs = grantsTableExists
    ? sqliteCountRows(
        db,
        `SELECT COUNT(*) AS c FROM grants WHERE status = 'active' AND grant_json IS NOT NULL AND instr(grant_json, ?) > 0`,
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
  return { zeroData, grantStorageBindingRefs, grantStreamPinRefs, grantPackageMemberRefs, activity };
}

// Cap on the off-owner diagnostic rows enumerated in the report. The diagnostic
// is bounded so a pathological multi-owner table cannot balloon the output; if
// the cap is hit, the report says so (no-silent-caps rule). The COUNT is always
// exact regardless of this cap.
const OFF_OWNER_SAMPLE_LIMIT = 100;

/**
 * Off-owner diagnostic for SQLite. This cleanup scans exactly ONE owner
 * (`ownerSubjectId`); a `connector_instances` row belonging to any OTHER subject
 * is structurally invisible to the scan. In a single-owner reference deployment
 * such a row is orphaned residue (e.g. a stray seed/migration subject), but the
 * tool must never silently pretend the table is fully covered. So we count and
 * sample the off-owner rows and surface them — WITHOUT evaluating or touching
 * them. The operator decides whether to re-run scoped to that subject
 * (`PDPP_OWNER_SUBJECT_ID=<subject> ...`). Pure read-only.
 */
function offOwnerDiagnosticSqlite(db, ownerSubjectId) {
  if (!sqliteTableExists(db, 'connector_instances')) {
    return { count: 0, truncated: false, rows: [] };
  }
  const count = sqliteCountRows(
    db,
    `SELECT COUNT(*) AS c FROM connector_instances WHERE owner_subject_id IS NOT NULL AND owner_subject_id <> ?`,
    [ownerSubjectId],
  );
  const rows = db
    .prepare(
      `SELECT owner_subject_id, connector_id, connector_instance_id, status
         FROM connector_instances
        WHERE owner_subject_id IS NOT NULL AND owner_subject_id <> ?
        ORDER BY owner_subject_id ASC, connector_id ASC, connector_instance_id ASC
        LIMIT ?`,
    )
    .all(ownerSubjectId, OFF_OWNER_SAMPLE_LIMIT)
    .map((r) => ({
      owner_subject_id: r.owner_subject_id,
      connector_id: r.connector_id,
      connector_instance_id: r.connector_instance_id,
      status: r.status,
    }));
  return { count, truncated: count > rows.length, rows };
}

/**
 * Evaluate the safety predicate for one instance row against an open SQLite db.
 * Returns { candidate: boolean, reasons: string[], notes: string[] }. Pure
 * read-only. Kept for in-process testing and backwards-compatible signature.
 */
export function evaluateInstance(db, instance) {
  const evidence = gatherSqliteEvidence(db, instance.connectorInstanceId);
  const reasons = reasonsFromEvidence(instance, evidence);
  const notes = notesFromEvidence(instance, evidence);
  return { candidate: reasons.length === 0, reasons, notes };
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
  // Evaluate each instance once; reuse the same evidence for reasons + notes.
  const evaluated = new Map(instances.map((i) => [i.connectorInstanceId, evaluateInstance(db, i)]));
  return buildPlan(
    ownerSubjectId,
    instances,
    (instance) => evaluated.get(instance.connectorInstanceId).reasons,
    (instance) => evaluated.get(instance.connectorInstanceId).notes,
    offOwnerDiagnosticSqlite(db, ownerSubjectId),
  );
}

/**
 * Apply the revoke to a planned candidate set using the SQLite store soft-flip
 * primitive (the SAME primitive the owner-agent revoke route uses). Before
 * revoking each candidate, RE-FETCH the instance and RE-EVALUATE the full
 * P1–P7 predicate against current evidence inside ONE writeTransaction, so a
 * record/grant/schedule/credential inserted after the plan but before apply
 * causes the row to be skipped (reported under `skippedAtApply`) rather than
 * force-revoked. Single-writer SQLite means the whole re-check-then-revoke
 * sequence is serialized against other writers; the writeTransaction makes it
 * atomic. No cascade. Exported for in-process testing.
 */
export function applyRevoke(candidates, { now = new Date().toISOString() } = {}) {
  const revoked = [];
  const skippedAtApply = [];
  if (candidates.length === 0) return { revoked, skippedAtApply };
  const db = getDb();
  if (!db) throw new Error('Database is not initialized.');
  const store = createSqliteConnectorInstanceStore();
  writeTransaction(() => {
    for (const entry of candidates) {
      const instance = store.get(entry.connector_instance_id);
      if (!instance) {
        skippedAtApply.push({
          connector_instance_id: entry.connector_instance_id,
          connector_id: entry.connector_id,
          reasons: ['apply:instance-not-found'],
        });
        continue;
      }
      // Re-evaluate the FULL predicate against current evidence.
      const reasons = reasonsFromEvidence(instance, gatherSqliteEvidence(db, instance.connectorInstanceId));
      if (reasons.length > 0) {
        skippedAtApply.push({
          connector_instance_id: instance.connectorInstanceId,
          connector_id: instance.connectorId,
          reasons,
        });
        continue;
      }
      const result = store.updateStatus(instance.connectorInstanceId, {
        status: 'revoked',
        updatedAt: now,
        revokedAt: now,
      });
      revoked.push({
        connector_instance_id: instance.connectorInstanceId,
        connector_id: instance.connectorId,
        status: result.status,
        revoked_at: result.revokedAt,
      });
    }
  });
  return { revoked, skippedAtApply };
}

// ─── Postgres arm ────────────────────────────────────────────────────────────

/** True if a regclass-qualified table exists in the connected Postgres db. */
async function pgTableExists(runner, name) {
  const r = await runner.query(`SELECT to_regclass($1) AS oid`, [name]);
  return Boolean(r.rows[0] && r.rows[0].oid);
}

async function pgCount(runner, sql, params) {
  const r = await runner.query(sql, params);
  const value = r.rows[0] ? Object.values(r.rows[0])[0] : 0;
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/**
 * Gather P4–P7 evidence for one instance from a Postgres query-runner (async).
 * `runner` is anything with a `.query(sql, params)` method — a Pool for the
 * read-only plan, or a transaction Client for the apply-time re-evaluation, so
 * the re-check reads the SAME snapshot the UPDATE will mutate.
 */
async function gatherPostgresEvidence(runner, id) {
  const zeroData = {};
  for (const table of EVIDENCE_TABLES) {
    zeroData[table] = (await pgTableExists(runner, table))
      ? await pgCount(runner, `SELECT COUNT(*) AS c FROM ${table} WHERE connector_instance_id = $1`, [id])
      : 'missing';
  }
  const grantsTableExists = await pgTableExists(runner, 'grants');
  const grantStorageBindingRefs = grantsTableExists
    ? await pgCount(
        runner,
        // JSONB column: compare its text rendering. The deterministic id is an
        // opaque token (cin_<hex>) so a substring match is exact in practice.
        `SELECT COUNT(*) AS c FROM grants
          WHERE storage_binding_json IS NOT NULL
            AND position($1 IN storage_binding_json::text) > 0`,
        [id],
      )
    : 'missing';
  // P5a — load-bearing grant-body stream pin. An ACTIVE grant whose grant_json
  // pins a stream to this connector_instance_id (grant.streams[].connection_id)
  // genuinely scopes a read. Same conservative opaque-id substring match,
  // restricted to status='active' grants (a revoked grant scopes nothing).
  const grantStreamPinRefs = grantsTableExists
    ? await pgCount(
        runner,
        `SELECT COUNT(*) AS c FROM grants
          WHERE status = 'active'
            AND grant_json IS NOT NULL
            AND position($1 IN grant_json::text) > 0`,
        [id],
      )
    : 'missing';
  const grantPackageMemberRefs = (await pgTableExists(runner, 'grant_package_members'))
    ? await pgCount(
        runner,
        `SELECT COUNT(*) AS c FROM grant_package_members
          WHERE position($1 IN COALESCE(source_json::text, '')) > 0`,
        [id],
      )
    : null;
  const activity = {};
  for (const { table } of ACTIVITY_TABLES) {
    activity[table] = (await pgTableExists(runner, table))
      ? await pgCount(runner, `SELECT COUNT(*) AS c FROM ${table} WHERE connector_instance_id = $1`, [id])
      : 'missing';
  }
  return { zeroData, grantStorageBindingRefs, grantStreamPinRefs, grantPackageMemberRefs, activity };
}

const PG_INSTANCE_COLUMNS = `connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at`;

function mapPgInstanceRow(row) {
  if (!row) return null;
  return {
    connectorInstanceId: row.connector_instance_id,
    ownerSubjectId: row.owner_subject_id,
    connectorId: row.connector_id,
    displayName: row.display_name,
    status: row.status,
    sourceKind: row.source_kind,
    sourceBindingKey: row.source_binding_key,
    sourceBinding:
      typeof row.source_binding_json === 'string' ? JSON.parse(row.source_binding_json) : row.source_binding_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * List an owner's connector_instances directly from a Postgres query-runner.
 * Inlined (rather than via createPostgresConnectorInstanceStore) so the scan
 * can run on a plain pool that NEVER bootstrapped the schema — a genuinely
 * missing evidence table then stays missing instead of being created empty.
 */
async function listOwnerInstancesPg(runner, ownerSubjectId, { limit = 5000 } = {}) {
  const r = await runner.query(
    `SELECT ${PG_INSTANCE_COLUMNS}
       FROM connector_instances
      WHERE owner_subject_id = $1
      ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
      LIMIT $2`,
    [ownerSubjectId, limit],
  );
  return r.rows.map(mapPgInstanceRow);
}

/**
 * Off-owner diagnostic for Postgres (async sibling of
 * `offOwnerDiagnosticSqlite`). Counts and samples `connector_instances` rows
 * belonging to a subject OTHER than the one this scan targets, so a row that the
 * single-owner scope makes structurally invisible is still surfaced to the
 * operator rather than silently uncovered. Read-only; never evaluated or
 * touched. Runs on the same non-bootstrapping pool as the scan, so a missing
 * `connector_instances` table reports zero off-owner rows rather than creating
 * the table.
 */
async function offOwnerDiagnosticPg(runner, ownerSubjectId) {
  if (!(await pgTableExists(runner, 'connector_instances'))) {
    return { count: 0, truncated: false, rows: [] };
  }
  const count = await pgCount(
    runner,
    `SELECT COUNT(*) AS c FROM connector_instances WHERE owner_subject_id IS NOT NULL AND owner_subject_id <> $1`,
    [ownerSubjectId],
  );
  const r = await runner.query(
    `SELECT owner_subject_id, connector_id, connector_instance_id, status
       FROM connector_instances
      WHERE owner_subject_id IS NOT NULL AND owner_subject_id <> $1
      ORDER BY owner_subject_id ASC, connector_id ASC, connector_instance_id ASC
      LIMIT $2`,
    [ownerSubjectId, OFF_OWNER_SAMPLE_LIMIT],
  );
  const rows = r.rows.map((row) => ({
    owner_subject_id: row.owner_subject_id,
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id,
    status: row.status,
  }));
  return { count, truncated: count > rows.length, rows };
}

/**
 * Evaluate the safety predicate for one instance row against a Postgres
 * query-runner (Pool or transaction Client). Async sibling of
 * `evaluateInstance`. Pure read-only. Exported for testing.
 */
export async function evaluateInstancePg(runner, instance) {
  const evidence = await gatherPostgresEvidence(runner, instance.connectorInstanceId);
  const reasons = reasonsFromEvidence(instance, evidence);
  const notes = notesFromEvidence(instance, evidence);
  return { candidate: reasons.length === 0, reasons, notes };
}

/**
 * Plan the cleanup over a Postgres query-runner. Pure read; identifies
 * candidates and skipped reasons WITHOUT mutation. Exported for in-process
 * testing. Accepts `pool` (back-compat) or any `runner` with `.query`.
 */
export async function planCleanupPg({ pool, runner, ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID }) {
  const queryRunner = runner ?? pool;
  const instances = await listOwnerInstancesPg(queryRunner, ownerSubjectId, { limit: 5000 });
  const evaluated = new Map();
  for (const instance of instances) {
    evaluated.set(instance.connectorInstanceId, await evaluateInstancePg(queryRunner, instance));
  }
  const otherOwners = await offOwnerDiagnosticPg(queryRunner, ownerSubjectId);
  return buildPlan(
    ownerSubjectId,
    instances,
    (instance) => evaluated.get(instance.connectorInstanceId).reasons,
    (instance) => evaluated.get(instance.connectorInstanceId).notes,
    otherOwners,
  );
}

/**
 * Apply the revoke to a planned candidate set on Postgres inside ONE
 * transaction. For EACH candidate, before revoking, re-fetch the row
 * (SELECT ... FOR UPDATE, taking a row lock) and RE-EVALUATE the full P1–P7
 * predicate against current evidence read through the SAME transaction client.
 * Only a row that still satisfies the entire predicate is revoked; any row that
 * gained a record/grant/schedule/credential (or otherwise changed) between plan
 * and apply is skipped and reported under `skippedAtApply` with its fresh
 * reasons. Re-asserting only status='active' (the prior shape) was insufficient
 * because those concurrent inserts do not change status. No cascade. Exported
 * for in-process testing.
 */
export async function applyRevokePg({ pool, runner, candidates, now = new Date().toISOString() }) {
  const queryRunner = runner ?? pool;
  const revoked = [];
  const skippedAtApply = [];
  if (candidates.length === 0) return { revoked, skippedAtApply };
  const client = await queryRunner.connect();
  try {
    await client.query('BEGIN');
    for (const entry of candidates) {
      // Lock the instance row for the duration of the transaction so its
      // status / provenance cannot change underneath the re-evaluation.
      const sel = await client.query(
        `SELECT ${PG_INSTANCE_COLUMNS}
           FROM connector_instances
          WHERE connector_instance_id = $1
          FOR UPDATE`,
        [entry.connector_instance_id],
      );
      const instance = mapPgInstanceRow(sel.rows[0]);
      if (!instance) {
        // The row disappeared between plan and apply (e.g. a delete). Nothing
        // to revoke; record it as skipped-at-apply for the operator.
        skippedAtApply.push({
          connector_instance_id: entry.connector_instance_id,
          connector_id: entry.connector_id,
          reasons: ['apply:instance-not-found'],
        });
        continue;
      }
      // Re-evaluate the FULL predicate against evidence read through this same
      // transaction client (consistent with the locked row).
      const reasons = reasonsFromEvidence(instance, await gatherPostgresEvidence(client, instance.connectorInstanceId));
      if (reasons.length > 0) {
        skippedAtApply.push({
          connector_instance_id: instance.connectorInstanceId,
          connector_id: instance.connectorId,
          reasons,
        });
        continue;
      }
      const r = await client.query(
        `UPDATE connector_instances
            SET status = 'revoked', updated_at = $2, revoked_at = $2
          WHERE connector_instance_id = $1 AND status = 'active'
          RETURNING connector_instance_id, connector_id, status, revoked_at`,
        [instance.connectorInstanceId, now],
      );
      if (r.rowCount === 1) {
        const row = r.rows[0];
        revoked.push({
          connector_instance_id: row.connector_instance_id,
          connector_id: row.connector_id,
          status: row.status,
          revoked_at: row.revoked_at,
        });
      } else {
        // P3 passed under the lock but the conditional UPDATE matched nothing:
        // treat as skipped-at-apply rather than a silent revoke.
        skippedAtApply.push({
          connector_instance_id: instance.connectorInstanceId,
          connector_id: instance.connectorId,
          reasons: [`P3:status-${instance.status}`],
        });
      }
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
  return { revoked, skippedAtApply };
}

// ─── Shared plan/printing ────────────────────────────────────────────────────

function buildPlan(
  ownerSubjectId,
  instances,
  reasonsFor,
  notesFor = () => [],
  otherOwners = { count: 0, truncated: false, rows: [] },
) {
  const candidates = [];
  const skipped = [];
  for (const instance of instances) {
    const reasons = reasonsFor(instance);
    const entry = {
      connector_instance_id: instance.connectorInstanceId,
      connector_id: instance.connectorId,
      status: instance.status,
    };
    if (reasons.length === 0) {
      // Attach NON-blocking informational notes (e.g. the P5b grant-package
      // member display reference) so the dry-run discloses them to the operator
      // even though they did not block the revoke.
      const notes = notesFor(instance);
      candidates.push(notes.length > 0 ? { ...entry, notes } : entry);
    } else {
      skipped.push({ ...entry, reasons });
    }
  }
  return { ownerSubjectId, scanned: instances.length, candidates, skipped, otherOwners };
}

function printHuman(plan, { apply, revoked, skippedAtApply }) {
  const lines = [];
  const otherOwners = plan.otherOwners || { count: 0, truncated: false, rows: [] };
  lines.push(`owner_subject_id: ${plan.ownerSubjectId}`);
  lines.push(`scanned_connections: ${plan.scanned}`);
  lines.push(`phantom_candidates: ${plan.candidates.length}`);
  lines.push(`skipped: ${plan.skipped.length}`);
  lines.push(`other_owner_connections: ${otherOwners.count}`);
  lines.push('');
  if (plan.candidates.length > 0) {
    lines.push(apply ? 'REVOKED phantom default-account connections:' : 'WOULD REVOKE (dry-run) phantom default-account connections:');
    for (const c of plan.candidates) {
      const noteSuffix =
        Array.isArray(c.notes) && c.notes.length > 0 ? `  notes=[${c.notes.join(', ')}]` : '';
      lines.push(`  - ${c.connector_instance_id}  connector=${c.connector_id}  status=${c.status}${noteSuffix}`);
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
  if (apply && skippedAtApply.length > 0) {
    lines.push('Skipped at apply (predicate re-evaluation changed between plan and apply; NOT revoked):');
    for (const s of skippedAtApply) {
      lines.push(`  - ${s.connector_instance_id}  connector=${s.connector_id}  reasons=[${s.reasons.join(', ')}]`);
    }
    lines.push('');
  }
  if (otherOwners.count > 0) {
    lines.push(
      `Other-owner connections (NOT scanned — this run targets owner_subject_id='${plan.ownerSubjectId}' only):`,
    );
    for (const r of otherOwners.rows) {
      lines.push(
        `  - ${r.connector_instance_id}  owner=${r.owner_subject_id}  connector=${r.connector_id}  status=${r.status}`,
      );
    }
    if (otherOwners.truncated) {
      lines.push(`  ... and ${otherOwners.count - otherOwners.rows.length} more (showing first ${otherOwners.rows.length}).`);
    }
    lines.push(
      "  These rows belong to another subject and are left untouched. In a single-owner reference deployment they are",
    );
    lines.push(
      '  orphaned residue; re-run scoped to that subject to evaluate them: PDPP_OWNER_SUBJECT_ID=<subject> <command>.',
    );
    lines.push('');
  }
  if (apply) {
    lines.push(
      `applied: revoked ${revoked.length} connection(s)` +
        (skippedAtApply.length > 0 ? `; skipped ${skippedAtApply.length} at apply-time re-evaluation.` : '.'),
    );
  } else {
    lines.push('dry-run: no changes were made. Re-run with --apply to revoke the candidates above.');
  }
  return lines.join('\n');
}

function emit(plan, { apply, json, revoked, skippedAtApply }) {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          owner_subject_id: plan.ownerSubjectId,
          apply,
          scanned: plan.scanned,
          candidates: plan.candidates,
          skipped: plan.skipped,
          other_owner_connections: plan.otherOwners || { count: 0, truncated: false, rows: [] },
          revoked,
          skipped_at_apply: skippedAtApply,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${printHuman(plan, { apply, revoked, skippedAtApply })}\n`);
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function runSqlite({ path, ownerSubjectId, apply, json }) {
  initDb(path);
  try {
    const plan = planCleanup({ ownerSubjectId });
    let revoked = [];
    let skippedAtApply = [];
    if (apply && plan.candidates.length > 0) {
      ({ revoked, skippedAtApply } = applyRevoke(plan.candidates));
    }
    emit(plan, { apply, json, revoked, skippedAtApply });
  } finally {
    closeDb();
  }
}

async function runPostgres({ url, ownerSubjectId, apply, json }) {
  // Lazy import so the SQLite arm (and `--print-predicate`) never requires `pg`.
  const pg = (await import('pg')).default;
  // Open OUR OWN pool directly. We deliberately do NOT call
  // `initPostgresStorage`, because that runs `bootstrapPostgresSchema`
  // (CREATE TABLE IF NOT EXISTS for every known table) before any scan. That
  // bootstrap would turn a genuinely-missing evidence table into an empty one
  // and silently defeat the P4–P7 missing-table fail-closed guard. Scanning on
  // a non-bootstrapping pool keeps "missing table" missing, so `to_regclass`
  // returning null still blocks. We only read and conditionally UPDATE
  // connector_instances; we never create or migrate schema.
  const pool = new pg.Pool({ connectionString: url });
  try {
    const plan = await planCleanupPg({ runner: pool, ownerSubjectId });
    let revoked = [];
    let skippedAtApply = [];
    if (apply && plan.candidates.length > 0) {
      ({ revoked, skippedAtApply } = await applyRevokePg({ runner: pool, candidates: plan.candidates }));
    }
    emit(plan, { apply, json, revoked, skippedAtApply });
  } finally {
    await pool.end().catch(() => {});
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
