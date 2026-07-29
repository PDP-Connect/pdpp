// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

// Type definitions
interface ConnectorInstance {
  connectorId: string;
  connectorInstanceId: string;
  createdAt?: string;
  displayName: string;
  ownerSubjectId: string;
  revokedAt: string | null;
  sourceBinding: unknown;
  sourceBindingKey: string;
  sourceKind: string;
  status: string;
  updatedAt?: string;
}

// Raw SQLite/Postgres row shape for `connector_instances`, as selected by
// every query in `server/queries/connector-instances/*.sql` and the inline
// Postgres SELECTs below. `mapInstance` converts this to `ConnectorInstance`.
interface ConnectorInstanceRow extends Record<string, unknown> {
  connector_id: string;
  connector_instance_id: string;
  created_at: string;
  display_name: string;
  owner_subject_id: string;
  revoked_at: string | null;
  source_binding_json: string | null;
  source_binding_key: string;
  source_kind: string;
  status: string;
  updated_at: string;
}

// Raw row shape for `controller_active_runs`, as selected by
// `server/queries/controller/list-active-runs.sql`.
interface ActiveRunRow {
  connector_id: string;
  connector_instance_id: string;
  run_generation: number;
  run_id: string;
  scenario_id: string | null;
  started_at: string;
  trace_id: string | null;
}

// Active-run summary returned by `getActiveRun`.
interface ActiveRunSummary {
  connectorId: string;
  runId: string;
  startedAt: string;
}

// Record shape accepted by `upsert` / `normalizeRecord`. Every field is
// optional at the call site — `normalizeRecord` fills in the required
// derived fields (id, status, sourceKind, sourceBindingKey/Json).
interface ConnectorInstanceUpsertRecord {
  connectorId: string;
  connectorInstanceId?: string | undefined;
  createdAt?: string | undefined;
  displayName?: string | undefined;
  ownerSubjectId: string;
  revokedAt?: string | null | undefined;
  sourceBinding?: unknown;
  sourceBindingKey?: string | undefined;
  sourceKind?: string | undefined;
  status?: string | undefined;
  updatedAt?: string | undefined;
}

// Normalized/validated shape produced by `normalizeRecord`, consumed by both
// backend `upsert` implementations.
interface NormalizedConnectorInstanceRecord {
  connectorId: string;
  connectorInstanceId: string;
  createdAt: string | undefined;
  displayName: string;
  ownerSubjectId: string;
  revokedAt: string | null;
  sourceBindingJson: string;
  sourceBindingKey: string;
  sourceKind: string;
  status: string;
  updatedAt: string | undefined;
}

// Namespace shape returned by `resolveOwnerConnectorInstanceNamespace` and
// its helpers.
interface ConnectorInstanceNamespace {
  connectorId: string;
  connectorInstanceId: string;
  createdDefaultAccount: boolean;
  displayName: string;
  ownerSubjectId: string;
  selector: "connector_instance_id" | "connector_id";
  sourceBinding: unknown;
  sourceBindingKey: string;
  sourceKind: string;
  status: string;
}

// Minimal shape of the store methods used by the free functions in this
// module (`resolveOwnerConnectorInstanceNamespace` and its helpers). Both the
// SQLite and Postgres store objects satisfy this structurally.
interface ConnectorInstanceStoreLike {
  ensureDefaultAccountConnection: (args: {
    ownerSubjectId: string;
    connectorId: string;
    displayName?: string | null;
    now?: string;
  }) => ConnectorInstance | Promise<ConnectorInstance>;
  get: (connectorInstanceId: string) => ConnectorInstance | null | Promise<ConnectorInstance | null>;
  resolveActiveByConnector: (
    ownerSubjectId: string,
    connectorId: string
  ) => ConnectorInstance | Promise<ConnectorInstance>;
}

// Injected purge collaborator for `deleteConnection`. Wired by the host
// (`server/index.js`) to `enumerateConnectionStreams`,
// `deleteConnectionRecordRowsSqlite`, `deleteConnectionRecordRowsPostgres`,
// and `teardownConnectionSearchProjection` in `server/records.js`. Injected
// (rather than imported) to avoid a records.js <-> store import cycle.
interface ConnectorInstanceDeletePurge {
  deleteRecordRowsPostgres: (client: unknown, connectorInstanceId: string) => Promise<number>;
  deleteRecordRowsSqlite: (connectorInstanceId: string) => number;
  enumerateStreams: (storageTarget: { connector_id: string; connector_instance_id: string }) => Promise<{
    connectorId: string;
    connectorInstanceId: string;
    streams: string[];
  }>;
  teardownProjection: (args: {
    connectorId: string;
    connectorInstanceId: string;
    streams: string[];
    deletedRecordCount: number;
  }) => Promise<void>;
}

import {
  allowUnboundedReadAcknowledged,
  exec,
  getMany,
  getOne,
  referenceQueries,
  writeTransaction,
} from "../../lib/db.ts";
import {
  withConnectorInstanceControlPlaneWrite,
  withConnectorInstanceWrite,
} from "../connector-instance-write-coordinator.ts";
import { postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";

const ACTIVE_RESOLUTION_LIMIT = 2;
const ACTIVE_FANIN_LIMIT = 64;
const LIST_LIMIT = 500;
// `draft` is reserved for static-secret owner-session connection setup: a real
// connector_instances row that is excluded from every connection read surface
// until its first successful ingest flips it to `active`. Only the owner-session
// static-secret draft-create surface produces a `draft`; no other
// materialization path does. See add-static-secret-owner-session-connect-path
// design Decision 1.
const VALID_STATUSES = new Set(["active", "paused", "revoked", "draft"]);
// Statuses hidden from `listByOwner` (the single choke point for every
// connection read surface). A draft must never appear in a list, count, or
// dashboard view. See Decision 2.
const READ_SURFACE_HIDDEN_STATUSES = new Set(["draft"]);
// `browser_collector` is a peer of `local_device` on the connector-instance
// source-binding axis: a binding collected by a local collector driving a
// browser session for a browser-bound connector. See
// add-browser-collector-enrollment-primitive design Decision 1.
const VALID_SOURCE_KINDS = new Set(["account", "local_device", "browser_collector", "manual"]);
const DEFAULT_ACCOUNT_SOURCE_BINDING_KEY = "default";
const DEFAULT_ACCOUNT_SOURCE_BINDING = Object.freeze({ kind: "default_account" });

export class ConnectorInstanceResolutionError extends Error {
  code: string;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConnectorInstanceResolutionError";
    this.code = code;
    Object.assign(this, details);
  }
}

// Thrown by `deleteConnection` when the cascade is refused for a typed reason
// (an in-flight run holds the active-run lease, or the connection is a
// default-account binding whose deterministic id would silently re-materialize
// — see Decision 1). The route maps `code` to the HTTP status via
// `codeToStatus` (connection_run_active → 409, default_account_delete_unsupported
// → 409). Distinct from ConnectorInstanceResolutionError so a delete-refusal is
// never confused with a not-found/ownership outcome.
export class ConnectorInstanceDeleteError extends Error {
  code: string;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConnectorInstanceDeleteError";
    this.code = code;
    Object.assign(this, details);
  }
}

// Shared precondition check for `deleteConnection` on both backends. Resolves
// the row, verifies owner ownership BEFORE any mutation (foreign/unknown id →
// connector_instance_not_found, which the route maps to 404 without leaking
// existence — invariant I5), refuses an in-flight active run (I7), and refuses a
// default-account binding whose deterministic id would re-materialize (I6,
// Decision 1 fallback: typed-unsupported rather than a half-built tombstone).
// Returns the resolved instance when the delete may proceed.
function assertDeletableConnection(
  instance: ConnectorInstance | null,
  {
    connectorInstanceId,
    ownerSubjectId,
    hasActiveRun,
  }: { connectorInstanceId: string; ownerSubjectId: string; hasActiveRun: boolean }
): ConnectorInstance {
  if (!instance || instance.ownerSubjectId !== ownerSubjectId) {
    // Absent OR foreign — both surface as not-found so existence is not leaked
    // across owners and a repeat delete of an already-deleted id is typed.
    throw new ConnectorInstanceResolutionError(
      "connector_instance_not_found",
      `Connector instance '${connectorInstanceId}' does not exist for owner '${ownerSubjectId}'.`,
      { connectorInstanceId, ownerSubjectId }
    );
  }
  if (hasActiveRun) {
    throw new ConnectorInstanceDeleteError(
      "connection_run_active",
      `Connection '${connectorInstanceId}' has an active collection run; stop or await the run before deleting.`,
      { connectorInstanceId, ownerSubjectId }
    );
  }
  if (instance.sourceKind === "account" && instance.sourceBindingKey === DEFAULT_ACCOUNT_SOURCE_BINDING_KEY) {
    // The default-account id is deterministic, so a hard row delete would be
    // silently re-materialized to active (with zero records) by the next
    // `ensureDefaultAccountConnection` read. A tombstone ledger now exists
    // (see fix-owner-delete-resurrection) and WOULD block that
    // materialization the same way it blocks device-exporter re-enroll — but
    // default-account delete stays typed-unsupported regardless, rather than
    // changing this route's behavior as a side effect of the tombstone fix.
    // Device-collected and explicit (non-default) account connections have
    // non-deterministic binding keys and are deletable. See
    // add-owner-connection-delete-contract Decision 1.
    throw new ConnectorInstanceDeleteError(
      "default_account_delete_unsupported",
      `Connection '${connectorInstanceId}' is a default-account binding; deleting it is not supported, because the deterministic default-account id would otherwise be resolved outside the normal upsert path. Revoke it instead, or re-initiate to replace it.`,
      { connectorId: instance.connectorId, connectorInstanceId, ownerSubjectId }
    );
  }
  return instance;
}

// Non-secret deletion summary returned by `deleteConnection` for the audit
// event + route response. Carries only counts and stable identifiers — never
// record contents or secrets.
function buildDeleteSummary(
  instance: ConnectorInstance,
  {
    deletedRecordCount,
    deletedStreamCount,
    scheduleDeleted,
    deviceRefsCleared,
  }: {
    deletedRecordCount: number;
    deletedStreamCount: number;
    scheduleDeleted: boolean;
    deviceRefsCleared: number;
  }
) {
  return {
    connection_id: instance.connectorInstanceId,
    connector_id: instance.connectorId,
    deleted_record_count: deletedRecordCount,
    deleted_stream_count: deletedStreamCount,
    device_refs_cleared: deviceRefsCleared,
    schedule_deleted: scheduleDeleted,
    source_kind: instance.sourceKind,
  };
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "{}";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Asserts a just-written row round-trips through a follow-up read within the
// same store. Used after `upsert`/`get(justInsertedId)` pairs where a null
// result would mean the write itself silently failed — a store-invariant
// violation, not a normal not-found outcome.
function assertRow<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}

export function makeConnectorInstanceSourceBindingKey(sourceBinding: unknown): string {
  return hashKey(stableJson(sourceBinding ?? {}));
}

function makeConnectorInstanceId({
  ownerSubjectId,
  connectorId,
  sourceKind,
  sourceBindingKey,
}: {
  ownerSubjectId: string;
  connectorId: string;
  sourceKind: string;
  sourceBindingKey: string;
}) {
  return `cin_${hashKey(`${ownerSubjectId}\n${connectorId}\n${sourceKind}\n${sourceBindingKey}`).slice(0, 24)}`;
}

// Design D8 (fix-enroll-connector-instance-pk-collision). A legacy
// deployment computed source_binding_key from the FULL sourceBinding object
// (including device_id/source_instance_id, which are per-enrollment, not
// per-binding) before deviceExporterSourceBindingIdentity narrowed it to the
// stable {kind, local_binding_name} shape. A legacy row's key therefore
// never matches today's ON CONFLICT(owner, connector, source_kind,
// source_binding_key) target for the SAME logical binding, so a retried
// upsert falls through to INSERT -- whose deterministic id can coincide with
// that legacy row's PRIMARY KEY (the legacy row's own id predates
// makeConnectorInstanceId and was assigned some other way). Extracts the
// local_binding_name this store instance already agrees is stable
// (record.sourceBinding.local_binding_name) so the caller can decide,
// without re-deriving any hashing logic, whether a PK-colliding row is
// provably the SAME logical binding (only its key derivation is stale) or a
// genuinely unrelated row that must never be touched.
function extractLocalBindingName(sourceBinding: unknown): string | null {
  const value = (sourceBinding as { local_binding_name?: unknown } | null | undefined)?.local_binding_name;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// True only when `existingRow` is PROVABLY the same logical binding as
// `normalized` under a legacy key derivation -- same owner, connector, and
// source_kind, and the local_binding_name embedded in the existing row's own
// stored source_binding_json matches the binding being upserted now. Never
// matches on id alone (a coincidental PK collision against an unrelated
// binding must fail closed, not be treated as a match).
function isSameLogicalBindingUnderLegacyKey(
  existingRow:
    | { connector_id?: unknown; owner_subject_id?: unknown; source_binding_json?: unknown; source_kind?: unknown }
    | null
    | undefined,
  normalized: { connectorId: string; ownerSubjectId: string; sourceKind: string },
  currentLocalBindingName: string | null
): boolean {
  if (!existingRow || currentLocalBindingName === null) {
    return false;
  }
  if (
    existingRow.owner_subject_id !== normalized.ownerSubjectId ||
    existingRow.connector_id !== normalized.connectorId ||
    existingRow.source_kind !== normalized.sourceKind
  ) {
    return false;
  }
  const existingBinding =
    typeof existingRow.source_binding_json === "string"
      ? JSON.parse(existingRow.source_binding_json)
      : existingRow.source_binding_json;
  return extractLocalBindingName(existingBinding) === currentLocalBindingName;
}

export function makeDefaultAccountConnectorInstanceId(ownerSubjectId: string, connectorId: string): string {
  return makeConnectorInstanceId({
    connectorId,
    ownerSubjectId,
    sourceBindingKey: DEFAULT_ACCOUNT_SOURCE_BINDING_KEY,
    sourceKind: "account",
  });
}

// Throws when `value` is not one of `validSet`, using the exact
// `Invalid connector instance ${label} '${value}'.` message both callers
// (sourceKind/status) already relied on.
function assertOneOf(validSet: Set<string>, value: string, label: string): void {
  if (!validSet.has(value)) {
    throw new Error(`Invalid connector instance ${label} '${value}'.`);
  }
}

function normalizeRecord(record: ConnectorInstanceUpsertRecord): NormalizedConnectorInstanceRecord {
  if (!record.ownerSubjectId) {
    throw new Error("ownerSubjectId is required.");
  }
  if (!record.connectorId) {
    throw new Error("connectorId is required.");
  }
  const sourceKind = record.sourceKind ?? "manual";
  assertOneOf(VALID_SOURCE_KINDS, sourceKind, "sourceKind");
  const status = record.status ?? "active";
  assertOneOf(VALID_STATUSES, status, "status");
  const sourceBindingJson = stableJson(record.sourceBinding ?? {});
  const sourceBindingKey = record.sourceBindingKey ?? makeConnectorInstanceSourceBindingKey(record.sourceBinding ?? {});
  return {
    connectorId: record.connectorId,
    connectorInstanceId:
      record.connectorInstanceId ??
      makeConnectorInstanceId({
        connectorId: record.connectorId,
        ownerSubjectId: record.ownerSubjectId,
        sourceBindingKey,
        sourceKind,
      }),
    createdAt: record.createdAt,
    displayName: record.displayName ?? record.connectorId,
    ownerSubjectId: record.ownerSubjectId,
    revokedAt: record.revokedAt ?? null,
    sourceBindingJson,
    sourceBindingKey,
    sourceKind,
    status,
    updatedAt: record.updatedAt,
  };
}

function mapInstance(row: ConnectorInstanceRow | null): ConnectorInstance | null;
function mapInstance(row: ConnectorInstanceRow): ConnectorInstance;
function mapInstance(row: ConnectorInstanceRow | null): ConnectorInstance | null {
  if (!row) {
    return null;
  }
  return {
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    createdAt: row.created_at,
    displayName: row.display_name,
    ownerSubjectId: row.owner_subject_id,
    revokedAt: row.revoked_at,
    sourceBinding:
      typeof row.source_binding_json === "string" ? JSON.parse(row.source_binding_json) : row.source_binding_json,
    sourceBindingKey: row.source_binding_key,
    sourceKind: row.source_kind,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

interface ConnectorInstanceTombstone {
  connectorId: string;
  connectorInstanceId: string;
  deletedAt: string;
  ownerSubjectId: string;
  sourceBindingKey: string;
  sourceKind: string;
}

interface ConnectorInstanceTombstoneRow extends Record<string, unknown> {
  connector_id: string;
  connector_instance_id: string;
  deleted_at: string;
  owner_subject_id: string;
  source_binding_key: string;
  source_kind: string;
}

function mapTombstone(row: ConnectorInstanceTombstoneRow | null | undefined): ConnectorInstanceTombstone | null {
  if (!row) {
    return null;
  }
  return {
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    deletedAt: row.deleted_at,
    ownerSubjectId: row.owner_subject_id,
    sourceBindingKey: row.source_binding_key,
    sourceKind: row.source_kind,
  };
}

// Throws `connection_tombstoned` when `normalized`'s identity
// (owner/connector/source_kind/source_binding_key) was previously
// owner-deleted. `tombstone` is the already-fetched tombstone row (or null),
// resolved by the caller so this stays a plain sync assertion usable from
// both the sync SQLite store and the awaited Postgres store. See
// openspec/changes/fix-owner-delete-resurrection.
function assertIdentityNotTombstoned(
  tombstone: ConnectorInstanceTombstone | null,
  normalized: { connectorId: string; ownerSubjectId: string; sourceBindingKey: string; sourceKind: string }
): void {
  if (!tombstone) {
    return;
  }
  throw new ConnectorInstanceDeleteError(
    "connection_tombstoned",
    `Connector instance identity for owner '${normalized.ownerSubjectId}', connector '${normalized.connectorId}' was previously deleted by the owner and cannot be silently re-created. Re-enroll under a distinct binding, or ask the owner to explicitly re-initiate this connection.`,
    {
      connectorId: normalized.connectorId,
      ownerSubjectId: normalized.ownerSubjectId,
      sourceBindingKey: normalized.sourceBindingKey,
      sourceKind: normalized.sourceKind,
    }
  );
}

// Test-only, opt-in delay between the Postgres upsert's tombstone check and
// its INSERT — the exact window a delete/upsert TOCTOU race must widen to be
// deterministically reproducible rather than a timing-luck flake. A complete
// no-op unless PDPP_TEST_UPSERT_TOMBSTONE_CHECK_DELAY_MS is set to a positive
// integer (never set in production). See
// test/connector-instance-delete-upsert-two-process-race.test.js.
async function testOnlyUpsertTombstoneCheckDelay(): Promise<void> {
  const raw = process.env.PDPP_TEST_UPSERT_TOMBSTONE_CHECK_DELAY_MS;
  const ms = raw ? Number.parseInt(raw, 10) : 0;
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSingleActive(
  rows: ConnectorInstance[],
  ownerSubjectId: string,
  connectorId: string
): ConnectorInstance {
  if (rows.length === 0) {
    throw new ConnectorInstanceResolutionError(
      "connector_instance_not_found",
      `No active connector instance exists for owner '${ownerSubjectId}' and connector '${connectorId}'.`,
      { connectorId, ownerSubjectId }
    );
  }
  if (rows.length > 1) {
    throw new ConnectorInstanceResolutionError(
      "ambiguous_connector_instance",
      `Connector '${connectorId}' has multiple active instances for owner '${ownerSubjectId}'.`,
      { connectorId, ownerSubjectId }
    );
  }
  // `rows.length` is exactly 1 here (the 0 and >1 cases both throw above).
  return rows[0] as ConnectorInstance;
}

function namespaceFromInstance(
  instance: ConnectorInstance,
  {
    selector,
    createdDefaultAccount = false,
  }: { selector: "connector_instance_id" | "connector_id"; createdDefaultAccount?: boolean }
): ConnectorInstanceNamespace {
  return {
    connectorId: instance.connectorId,
    connectorInstanceId: instance.connectorInstanceId,
    createdDefaultAccount,
    displayName: instance.displayName,
    ownerSubjectId: instance.ownerSubjectId,
    selector,
    sourceBinding: instance.sourceBinding,
    sourceBindingKey: instance.sourceBindingKey,
    sourceKind: instance.sourceKind,
    status: instance.status,
  };
}

// Sentinel returned by `resolveByExplicitInstanceId` to mean "no explicit-id
// namespace was resolved; fall through to the connector_id resolution path" —
// the previously-implicit fall-through (a missing instance whose id doubles as
// a default-account connector_id hint) made explicit as a named return value
// instead of a trailing comment.
const FALL_THROUGH_TO_CONNECTOR_ID = Symbol("fall-through-to-connector-id");

// Resolves the explicit `connector_instance_id` selector: fetches the row and
// runs its full validation chain (owner-mismatch, connector-mismatch,
// status-inactive) UNCHANGED. Returns a namespace on a valid hit, or
// `FALL_THROUGH_TO_CONNECTOR_ID` when the instance is missing but doubles as
// a legacy default-account connector_id hint (see Decision 3 note at the
// caller). Throws connector_instance_not_found otherwise.
function resolveByExplicitInstanceId(
  instance: ConnectorInstance | null,
  {
    ownerSubjectId,
    connectorId,
    connectorInstanceId,
    allowStatuses,
    allowDefaultAccount,
  }: {
    ownerSubjectId: string;
    connectorId: string | null;
    connectorInstanceId: string;
    allowStatuses: string[];
    allowDefaultAccount: boolean;
  }
): ConnectorInstanceNamespace | typeof FALL_THROUGH_TO_CONNECTOR_ID {
  if (instance) {
    if (instance.ownerSubjectId !== ownerSubjectId) {
      throw new ConnectorInstanceResolutionError(
        "connector_instance_owner_mismatch",
        `Connector instance '${connectorInstanceId}' does not belong to owner '${ownerSubjectId}'.`,
        { actualOwnerSubjectId: instance.ownerSubjectId, connectorId, connectorInstanceId, ownerSubjectId }
      );
    }
    if (connectorId && instance.connectorId !== connectorId) {
      throw new ConnectorInstanceResolutionError(
        "connector_instance_connector_mismatch",
        `Connector instance '${connectorInstanceId}' belongs to connector '${instance.connectorId}', not '${connectorId}'.`,
        { actualConnectorId: instance.connectorId, connectorId, connectorInstanceId, ownerSubjectId }
      );
    }
    if (!allowStatuses.includes(instance.status)) {
      throw new ConnectorInstanceResolutionError(
        "connector_instance_inactive",
        `Connector instance '${connectorInstanceId}' is '${instance.status}', not active.`,
        { connectorId: instance.connectorId, connectorInstanceId, ownerSubjectId, status: instance.status }
      );
    }
    return namespaceFromInstance(instance, { selector: "connector_instance_id" });
  }
  // Older grant/storage bindings can use connector_id as a default account
  // instance hint. When the instance is missing but this hint applies, we
  // fall through past this whole block to the connector_id resolution path
  // below instead of treating the missing id as a hard not-found.
  const isDefaultAccountHint = allowDefaultAccount && connectorId && connectorInstanceId === connectorId;
  if (!isDefaultAccountHint) {
    throw new ConnectorInstanceResolutionError(
      "connector_instance_not_found",
      `Connector instance '${connectorInstanceId}' does not exist.`,
      { connectorId, connectorInstanceId, ownerSubjectId }
    );
  }
  return FALL_THROUGH_TO_CONNECTOR_ID;
}

// Resolves the `connector_id` selector against the store's single-active
// lookup and maps the hit to a namespace. Lets `connector_instance_not_found`
// (and any other store error) propagate to the caller unchanged.
async function resolveByConnectorId(
  store: ConnectorInstanceStoreLike,
  ownerSubjectId: string,
  connectorId: string
): Promise<ConnectorInstanceNamespace> {
  const instance = await store.resolveActiveByConnector(ownerSubjectId, connectorId);
  return namespaceFromInstance(instance, { selector: "connector_id" });
}

// Materializes (or reads) the deterministic default-account connection for
// `connectorId`, enforcing the two UNCHANGED guards around it: a non-active
// row is refused as not-found (revoke-durability — the store returns a
// revoked row unchanged rather than resurrecting it, so this is the
// load-bearing half of the guard, see "Deferred: connection-revoke
// durability" → Unit 1), and an unregistered connector's FK failure is
// remapped to a clean not-found instead of bubbling the raw driver error.
async function materializeDefaultAccount(
  store: ConnectorInstanceStoreLike,
  {
    ownerSubjectId,
    connectorId,
    displayName,
    now,
  }: { ownerSubjectId: string; connectorId: string; displayName: string | null; now: string }
): Promise<ConnectorInstanceNamespace> {
  try {
    const instance = await store.ensureDefaultAccountConnection({
      connectorId,
      displayName,
      now,
      ownerSubjectId,
    });
    // The default-account materialization respects a deliberate revoke (it
    // returns the revoked row unchanged rather than resurrecting it). A
    // non-active row is therefore NOT a usable namespace: surface it as
    // "no active connection" so the ingest/write path fails closed (the write
    // is refused) and read callers that tolerate connector_instance_not_found
    // fall through to their no-active-source handling, instead of binding to
    // a revoked connection. This is the load-bearing half of the durability
    // guard — without it, the store-level guard alone would still hand back a
    // revoked namespace. See add-owner-agent-control-surface design
    // "Deferred: connection-revoke durability" → Unit 1.
    if (instance.status !== "active") {
      throw new ConnectorInstanceResolutionError(
        "connector_instance_not_found",
        `No active default-account connection exists for owner '${ownerSubjectId}' and connector '${connectorId}'; the default-account connection is '${instance.status}'.`,
        { connectorId, connectorInstanceId: instance.connectorInstanceId, ownerSubjectId, status: instance.status }
      );
    }
    return namespaceFromInstance(instance, { createdDefaultAccount: true, selector: "connector_id" });
  } catch (err) {
    // The connector_instances row references connectors(connector_id). If
    // the connector is not registered (e.g. the grant points at a stale
    // connector id or a synthetic native-storage id that never lived in
    // the catalog), the default-account upsert fails its FK check. Surface
    // this as a clean connector_instance_not_found so the caller can map
    // it to the right "unknown connector" 404 instead of bubbling SQLite's
    // 500.
    const errCode = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
    if (errCode === "SQLITE_CONSTRAINT_FOREIGNKEY" || errCode === "23503") {
      // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
      throw new ConnectorInstanceResolutionError(
        "connector_instance_not_found",
        `Connector '${connectorId}' is not registered; no connector instance namespace available.`,
        { connectorId, ownerSubjectId }
      );
    }
    throw err;
  }
}

export async function resolveOwnerConnectorInstanceNamespace({
  ownerSubjectId,
  connectorId = null,
  connectorInstanceId = null,
  connectorInstanceStore,
  allowDefaultAccount = false,
  // Statuses admissible when an instance is addressed explicitly by
  // connector_instance_id. Defaults to active-only. ONLY the owner-session
  // capture path and the owner-authenticated first-ingest path pass
  // `['active', 'draft']` to reach a static-secret draft. No grant-scoped,
  // client, MCP, or owner-agent READ path passes a non-default value, so a
  // draft is never resolvable as a read target. See
  // add-static-secret-owner-session-connect-path design Decision 3.
  allowStatuses = ["active"],
  displayName = null,
  now = new Date().toISOString(),
}: {
  ownerSubjectId: string;
  connectorId?: string | null;
  connectorInstanceId?: string | null;
  connectorInstanceStore: ConnectorInstanceStoreLike;
  allowDefaultAccount?: boolean;
  allowStatuses?: string[];
  displayName?: string | null;
  now?: string;
}): Promise<ConnectorInstanceNamespace> {
  if (!ownerSubjectId) {
    throw new ConnectorInstanceResolutionError(
      "owner_subject_required",
      "ownerSubjectId is required to resolve a connector instance namespace."
    );
  }
  if (!connectorInstanceStore) {
    throw new ConnectorInstanceResolutionError(
      "connector_instance_store_required",
      "connectorInstanceStore is required to resolve a connector instance namespace.",
      { connectorId, connectorInstanceId, ownerSubjectId }
    );
  }

  if (connectorInstanceId) {
    const instance = await connectorInstanceStore.get(connectorInstanceId);
    const explicitResult = resolveByExplicitInstanceId(instance, {
      allowDefaultAccount,
      allowStatuses,
      connectorId,
      connectorInstanceId,
      ownerSubjectId,
    });
    if (explicitResult !== FALL_THROUGH_TO_CONNECTOR_ID) {
      return explicitResult;
    }
    // intentional fall-through to the connector_id resolution path
  }

  if (!connectorId) {
    throw new ConnectorInstanceResolutionError(
      "connector_instance_selector_required",
      "Provide connector_instance_id or connector_id to resolve a connector instance namespace.",
      { ownerSubjectId }
    );
  }

  try {
    return await resolveByConnectorId(connectorInstanceStore, ownerSubjectId, connectorId);
  } catch (err) {
    const shouldTryDefaultAccount =
      allowDefaultAccount &&
      err instanceof ConnectorInstanceResolutionError &&
      err.code === "connector_instance_not_found";
    if (!shouldTryDefaultAccount) {
      throw err;
    }
  }

  return materializeDefaultAccount(connectorInstanceStore, {
    connectorId,
    displayName: displayName ?? connectorId,
    now,
    ownerSubjectId,
  });
}

export function createSqliteConnectorInstanceStore() {
  const store = {
    // Flip a static-secret draft to active on its first successful ingest.
    // No-op when the row is missing or not `draft` (idempotent and safe under a
    // concurrent first run — a second activation finds the row already active).
    // Never moves a paused/revoked row to active. See
    // add-static-secret-owner-session-connect-path design Decision 5.
    activateDraft(connectorInstanceId: string, { now }: { now?: string } = {}): ConnectorInstance | null {
      const instance = this.get(connectorInstanceId);
      if (instance?.status !== "draft") {
        return instance;
      }
      return this.updateStatus(connectorInstanceId, {
        revokedAt: null,
        status: "active",
        updatedAt: now ?? new Date().toISOString(),
      });
    },

    // Connection-scoped destructive delete of ONE connection, keyed strictly on
    // connector_instance_id. Erases the connection's records/history/blobs/
    // attention/search, its schedule, clears its device source-instance
    // back-reference, and removes the connector_instances row LAST. Preserves
    // the audit spine, disclosure grants, sibling connections, the device edge
    // itself, and any controller_active_runs row (an in-flight run is REFUSED,
    // never erased).
    //
    // Order (matches the contract's store-primitive section):
    //   1. resolve + verify ownership, refuse active-run, refuse default-account
    //      (assertDeletableConnection) — BEFORE any mutation (I5/I6/I7).
    //   2. enumerate the connection's streams (pre-commit read) so the
    //      post-commit search teardown knows what to clear.
    //   3. in ONE writeTransaction: erase the record-family/blob/attention rows
    //      (`purge.deleteRecordRowsSqlite`, which opens NO transaction of its
    //      own), then delete the schedule, clear the device back-reference, and
    //      delete the connector_instances row LAST. The ENTIRE durable cascade
    //      is one transaction (I8): a failure in EITHER the record purge OR the
    //      schedule/device/row cleanup rolls the whole cascade back, leaving the
    //      connection fully intact — no half-deleted connection.
    //   4. AFTER the durable commit: tear down the rebuildable search-index
    //      projection (`purge.teardownProjection`). Its failure does NOT undo or
    //      invalidate the committed source-of-truth delete.
    //
    // `purge` is injected (rather than imported) to avoid a records.js ↔ store
    // import cycle. It exposes `enumerateStreams`, `deleteRecordRowsSqlite`, and
    // `teardownProjection`; the host wires these to the `records.js` phases.
    async deleteConnection(
      connectorInstanceId: string,
      {
        ownerSubjectId,
        now,
        purge,
      }: {
        ownerSubjectId: string;
        now?: string;
        purge: ConnectorInstanceDeletePurge;
      }
    ) {
      const instanceLookup = this.get(connectorInstanceId);
      const activeRuns = allowUnboundedReadAcknowledged<ActiveRunRow>(referenceQueries.controllerListActiveRuns);
      const hasActiveRun = activeRuns.some((run) => run.connector_instance_id === connectorInstanceId);
      const instance = assertDeletableConnection(instanceLookup, { connectorInstanceId, hasActiveRun, ownerSubjectId });

      const storageTarget = { connector_id: instance.connectorId, connector_instance_id: connectorInstanceId };
      const { streams } = await purge.enumerateStreams(storageTarget);

      const stamp = now ?? new Date().toISOString();
      const { deletedRecordCount, scheduleDeleted, deviceRefsCleared } = writeTransaction(() => {
        // Record-family + blob + attention purge runs INSIDE this transaction
        // (no inner transaction of its own), so it is atomic with the schedule /
        // device / row deletes below.
        const recordCount = purge.deleteRecordRowsSqlite(connectorInstanceId);
        exec(referenceQueries.connectorInstancesDeleteManifestWriteViolationsByConnectorInstance, [
          connectorInstanceId,
        ]);
        exec(referenceQueries.connectorInstancesDeleteSummaryEvidenceByConnectorInstance, [connectorInstanceId]);
        const schedule = exec(referenceQueries.controllerDeleteSchedule, [connectorInstanceId]);
        const device = exec(referenceQueries.deviceExportersClearSourceInstanceConnectorRef, [
          stamp,
          connectorInstanceId,
        ]);
        // Record the tombstone BEFORE removing the row, same transaction: the
        // durable fact that this identity was owner-deleted must survive even
        // though the row itself is about to be erased. See
        // openspec/changes/fix-owner-delete-resurrection.
        exec(referenceQueries.connectorInstancesInsertTombstone, [
          instance.connectorInstanceId,
          instance.ownerSubjectId,
          instance.connectorId,
          instance.sourceKind,
          instance.sourceBindingKey,
          stamp,
        ]);
        exec(referenceQueries.connectorInstancesDeleteById, [connectorInstanceId]);
        return {
          deletedRecordCount: recordCount,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          deviceRefsCleared: device?.changes ?? 0,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          scheduleDeleted: (schedule?.changes ?? 0) > 0,
        };
      });

      // Post-commit, rebuildable projection teardown. A failure here leaves
      // orphaned (but unreachable — the records are gone) index rows; it does
      // NOT mean the committed delete failed.
      await purge.teardownProjection({
        connectorId: instance.connectorId,
        connectorInstanceId,
        deletedRecordCount,
        streams,
      });

      return buildDeleteSummary(instance, {
        deletedRecordCount,
        deletedStreamCount: streams.length,
        deviceRefsCleared,
        scheduleDeleted,
      });
    },

    ensureDefaultAccountConnection({
      ownerSubjectId,
      connectorId,
      displayName,
      now,
    }: {
      ownerSubjectId: string;
      connectorId: string;
      displayName?: string | null;
      now?: string;
    }): ConnectorInstance {
      // Durability guard: a deliberately-revoked default-account connection
      // MUST NOT be silently resurrected to active. Read the deterministically
      // keyed row first; if the owner revoked it, return it unchanged so the
      // revoke survives. Only a missing or active row materializes/upserts.
      // The device re-enroll path upserts under a different source_binding_key
      // and never reaches this method, so its reactivation semantics are
      // untouched. See add-owner-agent-control-surface design "Deferred:
      // connection-revoke durability" → Unit 1.
      const existing = this.getByBinding({
        connectorId,
        ownerSubjectId,
        sourceBindingKey: DEFAULT_ACCOUNT_SOURCE_BINDING_KEY,
        sourceKind: "account",
      });
      if (existing && existing.status === "revoked") {
        return existing;
      }
      return assertRow(
        this.upsert({
          connectorId,
          connectorInstanceId: makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId),
          createdAt: now,
          displayName: displayName ?? connectorId,
          ownerSubjectId,
          sourceBinding: { ...DEFAULT_ACCOUNT_SOURCE_BINDING },
          sourceBindingKey: DEFAULT_ACCOUNT_SOURCE_BINDING_KEY,
          sourceKind: "account",
          status: "active",
          updatedAt: now,
        }),
        `Failed to materialize default-account connector instance for owner '${ownerSubjectId}' and connector '${connectorId}'.`
      );
    },

    get(connectorInstanceId: string): ConnectorInstance | null {
      return mapInstance(getOne(referenceQueries.connectorInstancesGetById, [connectorInstanceId]));
    },

    // Non-secret in-flight-run lookup for ONE connection, keyed on
    // connector_instance_id. `controller_active_runs` holds exactly one row per
    // connection with a controller-managed run currently in flight (the same
    // table `deleteConnection` reads to refuse an active-run delete). Returns
    // `{ runId, connectorId, startedAt }` for the live run or `null` when idle.
    // This is the persistent link from a static-secret `draft` connection to
    // its first sync, so the owner setup-status surface can show "first sync
    // running" without scanning connector-keyed run history. The enumeration is
    // bounded (one row per registered connector) and read-only.
    getActiveRun(connectorInstanceId: string): ActiveRunSummary | null {
      const rows = allowUnboundedReadAcknowledged<ActiveRunRow>(referenceQueries.controllerListActiveRuns);
      const row = rows.find((run) => run.connector_instance_id === connectorInstanceId);
      if (!row) {
        return null;
      }
      return { connectorId: row.connector_id, runId: row.run_id, startedAt: row.started_at };
    },

    getByBinding({
      ownerSubjectId,
      connectorId,
      sourceKind,
      sourceBindingKey,
    }: {
      ownerSubjectId: string;
      connectorId: string;
      sourceKind: string;
      sourceBindingKey: string;
    }): ConnectorInstance | null {
      return mapInstance(
        getOne<ConnectorInstanceRow>(referenceQueries.connectorInstancesGetByBinding, [
          ownerSubjectId,
          connectorId,
          sourceKind,
          sourceBindingKey,
        ])
      );
    },

    // Reads the tombstone (if any) for one identity. Consulted ONLY by
    // `upsert`'s no-existing-row path; no other read surface in the system
    // queries this table. See openspec/changes/fix-owner-delete-resurrection.
    getTombstoneByBinding({
      ownerSubjectId,
      connectorId,
      sourceKind,
      sourceBindingKey,
    }: {
      ownerSubjectId: string;
      connectorId: string;
      sourceKind: string;
      sourceBindingKey: string;
    }): ConnectorInstanceTombstone | null {
      return mapTombstone(
        getOne<ConnectorInstanceTombstoneRow>(referenceQueries.connectorInstancesGetTombstoneByBinding, [
          ownerSubjectId,
          connectorId,
          sourceKind,
          sourceBindingKey,
        ])
      );
    },

    listActiveByConnector(
      ownerSubjectId: string,
      connectorId: string,
      { limit = ACTIVE_FANIN_LIMIT }: { limit?: number } = {}
    ): ConnectorInstance[] {
      return getMany<ConnectorInstanceRow>(
        referenceQueries.connectorInstancesListActiveByOwnerConnector,
        [ownerSubjectId, connectorId],
        { limit }
      ).rows.map(mapInstance);
    },

    listByOwner(ownerSubjectId: string, { limit = LIST_LIMIT }: { limit?: number } = {}): ConnectorInstance[] {
      // Draft instances are invisible to this read; the
      // `connectorInstancesListByOwner` query excludes `status = 'draft'` in
      // SQL (so the LIMIT window counts only visible rows). The JS post-filter
      // below is defense-in-depth in case the query is ever swapped. This is
      // the choke point for /_ref/connections, /_ref/connector-instances,
      // owner-agent reads, templates, and device-exporter listings — surfaces
      // where a not-yet-ingested draft would read as a misleadingly "already
      // connected" row. See Decision 2. The owner-facing dashboard/Sources/
      // Syncs summary path is the one deliberate exception: it needs drafts
      // visible (as an explicit setup-in-progress state) for connection
      // discoverability, so it reads `listByOwnerIncludingDrafts` instead. See
      // fix-pending-connection-discovery design.
      return getMany<ConnectorInstanceRow>(referenceQueries.connectorInstancesListByOwner, [ownerSubjectId], { limit })
        .rows.map(mapInstance)
        .filter((instance) => !READ_SURFACE_HIDDEN_STATUSES.has(instance.status));
    },

    // Same rows as `listByOwner`, but includes `draft` instances. Scoped to
    // the dashboard/Sources/Syncs connector-summary projection
    // (`listConnectorInstanceRowsForDashboard` in ref-control.ts) — the one
    // owner-facing surface responsible for making a freshly created,
    // not-yet-ingested connection discoverable as "setup in progress" rather
    // than invisible until its first successful ingest. Every other consumer
    // of `listByOwner` should keep hiding drafts (see Decision 2 above); do
    // not redirect a new caller here without confirming it renders a draft as
    // a distinct pending state, not as an already-configured connection.
    listByOwnerIncludingDrafts(
      ownerSubjectId: string,
      { limit = LIST_LIMIT }: { limit?: number } = {}
    ): ConnectorInstance[] {
      return getMany<ConnectorInstanceRow>(
        referenceQueries.connectorInstancesListByOwnerIncludingDrafts,
        [ownerSubjectId],
        {
          limit,
        }
      ).rows.map(mapInstance);
    },

    // Returns all browser-enrollment shells (any owner). Used by the TTL
    // retirement sweep to find shells whose enrollment_expires_at has passed.
    // Historical method/query name says "Draft", but active shell rows are
    // still incomplete until their source_binding_json.kind changes.
    // The optional ownerSubjectId filter is applied client-side after the
    // bounded read to avoid dynamic SQL.
    listDraftBrowserEnrollmentShells(ownerSubjectId: string | null = null): ConnectorInstance[] {
      const rows = allowUnboundedReadAcknowledged<ConnectorInstanceRow>(
        referenceQueries.connectorInstancesListDraftBrowserEnrollmentShells
      );
      const instances = rows.map(mapInstance);
      if (ownerSubjectId) {
        return instances.filter((i) => i.ownerSubjectId === ownerSubjectId);
      }
      return instances;
    },

    resolveActiveByConnector(ownerSubjectId: string, connectorId: string): ConnectorInstance {
      const rows = getMany<ConnectorInstanceRow>(
        referenceQueries.connectorInstancesListActiveByOwnerConnector,
        [ownerSubjectId, connectorId],
        { limit: ACTIVE_RESOLUTION_LIMIT }
      ).rows.map(mapInstance);
      return resolveSingleActive(rows, ownerSubjectId, connectorId);
    },

    setDisplayName(
      connectorInstanceId: string,
      {
        ownerSubjectId,
        displayName,
        updatedAt,
      }: {
        ownerSubjectId: string;
        displayName: string;
        updatedAt?: string;
      }
    ): ConnectorInstance | null {
      assertOwnerSetDisplayNameArgs({ connectorInstanceId, displayName, ownerSubjectId });
      const result = exec(referenceQueries.connectorInstancesUpdateDisplayName, [
        displayName,
        updatedAt ?? new Date().toISOString(),
        connectorInstanceId,
        ownerSubjectId,
      ]);
      if (!result || result.changes === 0) {
        throw new ConnectorInstanceResolutionError(
          "connector_instance_not_found",
          `Connector instance '${connectorInstanceId}' does not exist for owner '${ownerSubjectId}'.`,
          { connectorInstanceId, ownerSubjectId }
        );
      }
      return this.get(connectorInstanceId);
    },

    updateStatus(
      connectorInstanceId: string,
      {
        status,
        updatedAt,
        revokedAt = null,
      }: {
        status: string;
        updatedAt: string;
        revokedAt?: string | null;
      }
    ): ConnectorInstance | null {
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`Invalid connector instance status '${status}'.`);
      }
      exec(referenceQueries.connectorInstancesUpdateStatus, [status, updatedAt, revokedAt, connectorInstanceId]);
      return this.get(connectorInstanceId);
    },
    // Design D8 (fix-enroll-connector-instance-pk-collision). See the
    // Postgres implementation's doc comment for the full rationale: a legacy
    // row's source_binding_key (computed under the older, larger sourceBinding
    // shape) never matches the named ON CONFLICT target for the SAME logical
    // binding under today's stable {kind, local_binding_name} key, so the
    // INSERT is attempted and can collide on the PRIMARY KEY with that
    // legacy row -- the SAME logical binding, just keyed under a stale
    // derivation. better-sqlite3 raises SQLITE_CONSTRAINT_PRIMARYKEY
    // (distinct from the named ON CONFLICT target's own
    // SQLITE_CONSTRAINT_UNIQUE) for exactly this case. On that error, look
    // up the colliding row and migrate it in place ONLY if it is PROVABLY
    // the same logical binding (see isSameLogicalBindingUnderLegacyKey);
    // otherwise fail closed by re-throwing.
    upsert(record: ConnectorInstanceUpsertRecord): ConnectorInstance | null {
      const normalized = normalizeRecord(record);
      const currentLocalBindingName = extractLocalBindingName(record.sourceBinding);
      // Tombstone guard: only relevant when no LIVE row exists for this
      // identity yet — an `ON CONFLICT DO UPDATE` hit against an existing row
      // (revoke, pause, reactivate-by-re-enroll) is untouched by this check.
      // A missing row for a tombstoned identity means the identity was
      // owner-deleted; refuse to silently re-materialize it. See
      // openspec/changes/fix-owner-delete-resurrection.
      if (!this.get(normalized.connectorInstanceId)) {
        assertIdentityNotTombstoned(
          this.getTombstoneByBinding({
            connectorId: normalized.connectorId,
            ownerSubjectId: normalized.ownerSubjectId,
            sourceBindingKey: normalized.sourceBindingKey,
            sourceKind: normalized.sourceKind,
          }),
          normalized
        );
      }
      try {
        exec(referenceQueries.connectorInstancesInsert, [
          normalized.connectorInstanceId,
          normalized.ownerSubjectId,
          normalized.connectorId,
          normalized.displayName,
          normalized.status,
          normalized.sourceKind,
          normalized.sourceBindingKey,
          normalized.sourceBindingJson,
          normalized.createdAt ?? null,
          normalized.updatedAt ?? null,
          normalized.revokedAt,
        ]);
        return this.get(normalized.connectorInstanceId);
      } catch (err) {
        if ((err as { code?: string } | null)?.code !== "SQLITE_CONSTRAINT_PRIMARYKEY") {
          throw err;
        }
        const collidingRow = getOne(referenceQueries.connectorInstancesGetById, [
          normalized.connectorInstanceId,
        ]) as ConnectorInstanceRow | null;
        if (!isSameLogicalBindingUnderLegacyKey(collidingRow, normalized, currentLocalBindingName)) {
          throw err;
        }
        exec(referenceQueries.connectorInstancesMigrateLegacyBindingKey, [
          normalized.displayName,
          normalized.status,
          normalized.sourceBindingKey,
          normalized.sourceBindingJson,
          normalized.updatedAt ?? null,
          normalized.revokedAt,
          (collidingRow as ConnectorInstanceRow).connector_instance_id,
        ]);
        return this.get((collidingRow as ConnectorInstanceRow).connector_instance_id);
      }
    },
  };
  const deleteConnectionUncoordinated = store.deleteConnection;
  store.deleteConnection = (connectorInstanceId, options) =>
    withConnectorInstanceWrite(connectorInstanceId, () =>
      deleteConnectionUncoordinated.call(store, connectorInstanceId, options)
    );
  // `upsert` is NOT wrapped in write coordination here: better-sqlite3 is
  // synchronous and single-connection per process, so there is no genuine
  // multi-process race to close on this backend (unlike Postgres — see the
  // Postgres arm's `upsert` wrap and its rationale). Wrapping this
  // synchronous method in the async coordinator would silently change its
  // sync-\>async calling contract for every existing caller. The tombstone
  // guard inside `upsert` itself (see `assertIdentityNotTombstoned` above)
  // is already sufficient here: a single-process, single-connection SQLite
  // handle can never interleave the tombstone check and the INSERT with a
  // concurrent delete on a DIFFERENT connection.
  return Object.assign(store, {
    async upsertForEnrollment(record: ConnectorInstanceUpsertRecord): Promise<ConnectorInstance | null> {
      return await store.upsert(record);
    },
  });
}

// Error shape used for the invalid_request throws below: a plain `Error`
// annotated with the `code`/`param` fields the route layer's error mapper
// reads (see `codeToStatus`/error-shaping in the route handlers).
class InvalidRequestError extends Error {
  code: string;
  param: string;

  constructor(message: string, param: string) {
    super(message);
    this.name = "InvalidRequestError";
    this.code = "invalid_request";
    this.param = param;
  }
}

function assertOwnerSetDisplayNameArgs({
  connectorInstanceId,
  ownerSubjectId,
  displayName,
}: {
  connectorInstanceId: unknown;
  ownerSubjectId: unknown;
  displayName: unknown;
}): void {
  if (typeof connectorInstanceId !== "string" || !connectorInstanceId) {
    throw new ConnectorInstanceResolutionError(
      "connector_instance_selector_required",
      "connectorInstanceId is required to set a display name."
    );
  }
  if (typeof ownerSubjectId !== "string" || !ownerSubjectId) {
    throw new ConnectorInstanceResolutionError(
      "owner_subject_required",
      "ownerSubjectId is required to set a display name."
    );
  }
  if (typeof displayName !== "string") {
    throw new InvalidRequestError("display_name must be a string.", "display_name");
  }
  const trimmed = displayName.trim();
  if (!trimmed) {
    throw new InvalidRequestError("display_name must be a non-empty string.", "display_name");
  }
  if (trimmed.length > 200) {
    throw new InvalidRequestError("display_name must be at most 200 characters.", "display_name");
  }
}

export function createPostgresConnectorInstanceStore() {
  const store = {
    // Flip a static-secret draft to active on its first successful ingest. A
    // single conditional UPDATE keyed on `status = 'draft'` is the no-op /
    // concurrency guard: a row that is missing or not draft is untouched. See
    // add-static-secret-owner-session-connect-path design Decision 5.
    async activateDraft(
      connectorInstanceId: string,
      { now }: { now?: string } = {}
    ): Promise<ConnectorInstance | null> {
      await postgresQuery(
        `UPDATE connector_instances
         SET status = 'active', updated_at = $1, revoked_at = NULL
         WHERE connector_instance_id = $2 AND status = 'draft'`,
        [now ?? new Date().toISOString(), connectorInstanceId]
      );
      return await this.get(connectorInstanceId);
    },

    // Postgres connection-scoped delete. Mirrors the SQLite arm exactly: resolve
    // + verify ownership, refuse active-run (I7) and default-account (I6/Decision
    // 1), enumerate streams, then erase the record-family rows AND the schedule +
    // device back-ref + connector_instances row inside ONE withPostgresTransaction
    // — the record purge binds against the SAME `client`, so the whole durable
    // cascade is one BEGIN/COMMIT (I8). Search-index teardown runs post-commit.
    // See the SQLite `deleteConnection` for the full ordering rationale.
    async deleteConnection(
      connectorInstanceId: string,
      {
        ownerSubjectId,
        now,
        purge,
      }: {
        ownerSubjectId: string;
        now?: string;
        purge: ConnectorInstanceDeletePurge;
      }
    ) {
      const instanceLookup = await this.get(connectorInstanceId);
      const activeRuns = await postgresQuery(
        "SELECT connector_instance_id FROM controller_active_runs WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const hasActiveRun = activeRuns.rows.length > 0;
      const instance = assertDeletableConnection(instanceLookup, { connectorInstanceId, hasActiveRun, ownerSubjectId });

      const storageTarget = { connector_id: instance.connectorId, connector_instance_id: connectorInstanceId };
      const { streams } = await purge.enumerateStreams(storageTarget);

      const stamp = now ?? new Date().toISOString();
      const { deletedRecordCount, scheduleDeleted, deviceRefsCleared } = await withPostgresTransaction(
        async (client: {
          query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null; rows: unknown[] }>;
        }) => {
          // Record-family + blob + attention purge runs against the SAME client,
          // so it is atomic with the schedule / device / row deletes below.
          const recordCount = await purge.deleteRecordRowsPostgres(client, connectorInstanceId);
          await client.query("DELETE FROM manifest_write_violations WHERE connector_instance_id = $1", [
            connectorInstanceId,
          ]);
          await client.query("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [
            connectorInstanceId,
          ]);
          const schedule = await client.query("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [
            connectorInstanceId,
          ]);
          const device = await client.query(
            "UPDATE device_source_instances SET connector_instance_id = NULL, updated_at = $1 WHERE connector_instance_id = $2",
            [stamp, connectorInstanceId]
          );
          // Record the tombstone BEFORE removing the row, same transaction: the
          // durable fact that this identity was owner-deleted must survive even
          // though the row itself is about to be erased. See
          // openspec/changes/fix-owner-delete-resurrection.
          await client.query(
            `INSERT INTO connector_instance_tombstones(connector_instance_id, owner_subject_id, connector_id, source_kind, source_binding_key, deleted_at)
           VALUES($1, $2, $3, $4, $5, $6)
           ON CONFLICT(owner_subject_id, connector_id, source_kind, source_binding_key) DO NOTHING`,
            [
              instance.connectorInstanceId,
              instance.ownerSubjectId,
              instance.connectorId,
              instance.sourceKind,
              instance.sourceBindingKey,
              stamp,
            ]
          );
          await client.query("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
          return {
            deletedRecordCount: recordCount,
            // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
            deviceRefsCleared: device?.rowCount ?? 0,
            // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
            scheduleDeleted: (schedule?.rowCount ?? 0) > 0,
          };
        }
      );

      // Post-commit, rebuildable projection teardown (see SQLite arm).
      await purge.teardownProjection({
        connectorId: instance.connectorId,
        connectorInstanceId,
        deletedRecordCount,
        streams,
      });

      return buildDeleteSummary(instance, {
        deletedRecordCount,
        deletedStreamCount: streams.length,
        deviceRefsCleared,
        scheduleDeleted,
      });
    },

    async ensureDefaultAccountConnection({
      ownerSubjectId,
      connectorId,
      displayName,
      now,
    }: {
      ownerSubjectId: string;
      connectorId: string;
      displayName?: string | null;
      now?: string;
    }): Promise<ConnectorInstance> {
      // Durability guard: a deliberately-revoked default-account connection
      // MUST NOT be silently resurrected to active. Read the deterministically
      // keyed row first; if the owner revoked it, return it unchanged so the
      // revoke survives. Only a missing or active row materializes/upserts.
      // The device re-enroll path upserts under a different source_binding_key
      // and never reaches this method, so its reactivation semantics are
      // untouched. See add-owner-agent-control-surface design "Deferred:
      // connection-revoke durability" → Unit 1.
      const existing = await this.getByBinding({
        connectorId,
        ownerSubjectId,
        sourceBindingKey: DEFAULT_ACCOUNT_SOURCE_BINDING_KEY,
        sourceKind: "account",
      });
      if (existing && existing.status === "revoked") {
        return existing;
      }
      return assertRow(
        await this.upsert({
          connectorId,
          connectorInstanceId: makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId),
          createdAt: now,
          displayName: displayName ?? connectorId,
          ownerSubjectId,
          sourceBinding: { ...DEFAULT_ACCOUNT_SOURCE_BINDING },
          sourceBindingKey: DEFAULT_ACCOUNT_SOURCE_BINDING_KEY,
          sourceKind: "account",
          status: "active",
          updatedAt: now,
        }),
        `Failed to materialize default-account connector instance for owner '${ownerSubjectId}' and connector '${connectorId}'.`
      );
    },

    async get(connectorInstanceId: string): Promise<ConnectorInstance | null> {
      const result = await postgresQuery<ConnectorInstanceRow>(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances WHERE connector_instance_id = $1`,
        [connectorInstanceId]
      );
      const row: ConnectorInstanceRow | undefined = result.rows[0];
      return row ? mapInstance(row) : null;
    },

    // Non-secret in-flight-run lookup for ONE connection (see the SQLite arm).
    // Direct keyed read on the Postgres `controller_active_runs` table.
    async getActiveRun(connectorInstanceId: string): Promise<ActiveRunSummary | null> {
      const result = await postgresQuery<ActiveRunRow>(
        `SELECT run_id, connector_id, started_at
         FROM controller_active_runs WHERE connector_instance_id = $1`,
        [connectorInstanceId]
      );
      const row: ActiveRunRow | undefined = result.rows[0];
      if (!row) {
        return null;
      }
      return { connectorId: row.connector_id, runId: row.run_id, startedAt: row.started_at };
    },

    async getByBinding({
      ownerSubjectId,
      connectorId,
      sourceKind,
      sourceBindingKey,
    }: {
      ownerSubjectId: string;
      connectorId: string;
      sourceKind: string;
      sourceBindingKey: string;
    }): Promise<ConnectorInstance | null> {
      const result = await postgresQuery<ConnectorInstanceRow>(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1 AND connector_id = $2 AND source_kind = $3 AND source_binding_key = $4`,
        [ownerSubjectId, connectorId, sourceKind, sourceBindingKey]
      );
      const row: ConnectorInstanceRow | undefined = result.rows[0];
      return row ? mapInstance(row) : null;
    },

    // Reads the tombstone (if any) for one identity. Consulted ONLY by
    // `upsert`'s no-existing-row path; no other read surface in the system
    // queries this table. See openspec/changes/fix-owner-delete-resurrection.
    async getTombstoneByBinding({
      ownerSubjectId,
      connectorId,
      sourceKind,
      sourceBindingKey,
    }: {
      ownerSubjectId: string;
      connectorId: string;
      sourceKind: string;
      sourceBindingKey: string;
    }): Promise<ConnectorInstanceTombstone | null> {
      const result = await postgresQuery<ConnectorInstanceTombstoneRow>(
        `SELECT connector_instance_id, owner_subject_id, connector_id, source_kind, source_binding_key, deleted_at
         FROM connector_instance_tombstones
         WHERE owner_subject_id = $1 AND connector_id = $2 AND source_kind = $3 AND source_binding_key = $4`,
        [ownerSubjectId, connectorId, sourceKind, sourceBindingKey]
      );
      const row: ConnectorInstanceTombstoneRow | undefined = result.rows[0];
      return mapTombstone(row);
    },

    async listActiveByConnector(
      ownerSubjectId: string,
      connectorId: string,
      { limit = ACTIVE_FANIN_LIMIT }: { limit?: number } = {}
    ): Promise<ConnectorInstance[]> {
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1 AND connector_id = $2 AND status = 'active'
         ORDER BY created_at ASC, connector_instance_id ASC
         LIMIT $3`,
        [ownerSubjectId, connectorId, limit]
      );
      return (result.rows as ConnectorInstanceRow[]).map(mapInstance);
    },

    async listByOwner(
      ownerSubjectId: string,
      { limit = LIST_LIMIT }: { limit?: number } = {}
    ): Promise<ConnectorInstance[]> {
      // Draft instances are invisible to this read (see SQLite arm /
      // Decision 2). Filtered in SQL here so the LIMIT applies to visible
      // rows. The dashboard/Sources/Syncs summary path is the one deliberate
      // exception — see `listByOwnerIncludingDrafts` below.
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1 AND status <> 'draft'
         ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
         LIMIT $2`,
        [ownerSubjectId, limit]
      );
      return (result.rows as ConnectorInstanceRow[]).map(mapInstance);
    },

    // Same rows as `listByOwner`, but includes `draft` instances. See the
    // SQLite arm's `listByOwnerIncludingDrafts` for the scoping rule (dashboard
    // summary path only).
    async listByOwnerIncludingDrafts(
      ownerSubjectId: string,
      { limit = LIST_LIMIT }: { limit?: number } = {}
    ): Promise<ConnectorInstance[]> {
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1
         ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
         LIMIT $2`,
        [ownerSubjectId, limit]
      );
      return (result.rows as ConnectorInstanceRow[]).map(mapInstance);
    },

    // Returns all browser-enrollment shells (any owner, or filtered by
    // ownerSubjectId). Used by the TTL retirement sweep. Historical method
    // name says "Draft", but active shell rows are still incomplete until
    // their source_binding_json.kind changes.
    async listDraftBrowserEnrollmentShells(ownerSubjectId: string | null = null): Promise<ConnectorInstance[]> {
      const result = ownerSubjectId
        ? await postgresQuery(
            `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
             FROM connector_instances
             WHERE status IN ('draft', 'active')
               AND source_binding_json->>'kind' = 'browser_enrollment_shell'
               AND owner_subject_id = $1
             ORDER BY created_at ASC, connector_instance_id ASC
             LIMIT 256`,
            [ownerSubjectId]
          )
        : await postgresQuery(
            `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
             FROM connector_instances
             WHERE status IN ('draft', 'active')
               AND source_binding_json->>'kind' = 'browser_enrollment_shell'
             ORDER BY created_at ASC, connector_instance_id ASC
             LIMIT 256`
          );
      return (result.rows as ConnectorInstanceRow[]).map(mapInstance);
    },

    async resolveActiveByConnector(ownerSubjectId: string, connectorId: string): Promise<ConnectorInstance> {
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1 AND connector_id = $2 AND status = 'active'
         ORDER BY created_at ASC, connector_instance_id ASC
         LIMIT $3`,
        [ownerSubjectId, connectorId, ACTIVE_RESOLUTION_LIMIT]
      );
      return resolveSingleActive((result.rows as ConnectorInstanceRow[]).map(mapInstance), ownerSubjectId, connectorId);
    },

    async setDisplayName(
      connectorInstanceId: string,
      {
        ownerSubjectId,
        displayName,
        updatedAt,
      }: {
        ownerSubjectId: string;
        displayName: string;
        updatedAt?: string;
      }
    ): Promise<ConnectorInstance | null> {
      assertOwnerSetDisplayNameArgs({ connectorInstanceId, displayName, ownerSubjectId });
      const result = await postgresQuery(
        `UPDATE connector_instances
         SET display_name = $1, updated_at = $2
         WHERE connector_instance_id = $3 AND owner_subject_id = $4`,
        [displayName, updatedAt ?? new Date().toISOString(), connectorInstanceId, ownerSubjectId]
      );
      if (!result || result.rowCount === 0) {
        throw new ConnectorInstanceResolutionError(
          "connector_instance_not_found",
          `Connector instance '${connectorInstanceId}' does not exist for owner '${ownerSubjectId}'.`,
          { connectorInstanceId, ownerSubjectId }
        );
      }
      return await this.get(connectorInstanceId);
    },

    async updateStatus(
      connectorInstanceId: string,
      {
        status,
        updatedAt,
        revokedAt = null,
      }: {
        status: string;
        updatedAt: string;
        revokedAt?: string | null;
      }
    ): Promise<ConnectorInstance | null> {
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`Invalid connector instance status '${status}'.`);
      }
      await postgresQuery(
        "UPDATE connector_instances SET status = $1, updated_at = $2, revoked_at = $3 WHERE connector_instance_id = $4",
        [status, updatedAt, revokedAt, connectorInstanceId]
      );
      return await this.get(connectorInstanceId);
    },
    // Design D8 (fix-enroll-connector-instance-pk-collision). connectorInstanceId
    // is normally deterministic (makeConnectorInstanceId, hashed from owner +
    // connector + sourceKind + sourceBindingKey) so a retried upsert for the
    // SAME logical binding always targets the SAME row, and the ON CONFLICT
    // target above (the binding's own unique key) absorbs every same-binding
    // race by design -- it can never itself raise 23505.
    //
    // A live counterexample proved a residual gap: a pre-D6/D7 deployment
    // computed source_binding_key from the FULL sourceBinding object
    // (including per-enrollment device_id/source_instance_id), before
    // deviceExporterSourceBindingIdentity narrowed it to the stable
    // {kind, local_binding_name} shape. That legacy row's key therefore never
    // matches the ON CONFLICT target above for the SAME logical binding --
    // Postgres attempts the INSERT -- whose deterministic id (computed from
    // TODAY's key) happens to equal that legacy row's own PRIMARY KEY (the
    // legacy row's id predates makeConnectorInstanceId and was assigned by
    // an older mechanism). This is a legacy key-normalization gap, not a
    // cryptographic collision: the colliding row genuinely IS this binding's
    // pre-existing connector instance, just keyed under a stale derivation.
    //
    // On a PRIMARY KEY conflict, look up the colliding row and check whether
    // it is PROVABLY the same logical binding under the legacy key shape
    // (same owner/connector/source_kind, and the local_binding_name embedded
    // in its own stored source_binding_json matches this binding's). Only
    // then migrate it in place -- UPDATE its source_binding_key/
    // source_binding_json to the current stable shape and return that SAME
    // connector_instance_id, preserving one logical connector instance and
    // every reference to it. A collision against any row that is NOT
    // provably this same binding (different owner/connector/kind, or a
    // mismatched/unrecoverable local_binding_name) FAILS CLOSED by
    // re-throwing the raw 23505 -- never adopted, never silently retried
    // under a different id, since that would either corrupt an unrelated
    // connector instance or fork a duplicate for this one.
    async upsert(record: ConnectorInstanceUpsertRecord): Promise<ConnectorInstance | null> {
      const normalized = normalizeRecord(record);
      const currentLocalBindingName = extractLocalBindingName(record.sourceBinding);
      // Tombstone guard: only relevant when no LIVE row exists for this
      // identity yet — an `ON CONFLICT DO UPDATE` hit against an existing row
      // (revoke, pause, reactivate-by-re-enroll) is untouched by this check.
      // See the SQLite arm for the full rationale.
      if (!(await this.get(normalized.connectorInstanceId))) {
        assertIdentityNotTombstoned(
          await this.getTombstoneByBinding({
            connectorId: normalized.connectorId,
            ownerSubjectId: normalized.ownerSubjectId,
            sourceBindingKey: normalized.sourceBindingKey,
            sourceKind: normalized.sourceKind,
          }),
          normalized
        );
      }
      // Test-only, opt-in — widens the tombstone-check-to-INSERT window so a
      // genuine two-process race is deterministically reproducible. No-op in
      // production.
      await testOnlyUpsertTombstoneCheckDelay();
      try {
        await postgresQuery(
          `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
           ON CONFLICT(owner_subject_id, connector_id, source_kind, source_binding_key) DO UPDATE SET
             display_name = excluded.display_name,
             status = excluded.status,
             source_binding_json = excluded.source_binding_json,
             updated_at = excluded.updated_at,
             revoked_at = excluded.revoked_at`,
          [
            normalized.connectorInstanceId,
            normalized.ownerSubjectId,
            normalized.connectorId,
            normalized.displayName,
            normalized.status,
            normalized.sourceKind,
            normalized.sourceBindingKey,
            normalized.sourceBindingJson,
            normalized.createdAt,
            normalized.updatedAt,
            normalized.revokedAt,
          ]
        );
        return await this.get(normalized.connectorInstanceId);
      } catch (err) {
        if ((err as { code?: string } | null)?.code !== "23505") {
          throw err;
        }
        const colliding = await postgresQuery<ConnectorInstanceRow>(
          `SELECT connector_instance_id, owner_subject_id, connector_id, source_kind, source_binding_json
             FROM connector_instances WHERE connector_instance_id = $1`,
          [normalized.connectorInstanceId]
        );
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        const collidingRow = colliding.rows[0];
        if (!collidingRow) {
          throw err;
        }
        if (!isSameLogicalBindingUnderLegacyKey(collidingRow, normalized, currentLocalBindingName)) {
          throw err;
        }
        await postgresQuery(
          `UPDATE connector_instances SET
             display_name = $1,
             status = $2,
             source_binding_key = $3,
             source_binding_json = $4::jsonb,
             updated_at = $5,
             revoked_at = $6
           WHERE connector_instance_id = $7`,
          [
            normalized.displayName,
            normalized.status,
            normalized.sourceBindingKey,
            normalized.sourceBindingJson,
            normalized.updatedAt,
            normalized.revokedAt,
            collidingRow.connector_instance_id,
          ]
        );
        return await this.get(collidingRow.connector_instance_id);
      }
    },
  };
  const deleteConnectionUncoordinated = store.deleteConnection;
  store.deleteConnection = (connectorInstanceId, options) =>
    withConnectorInstanceWrite(connectorInstanceId, () =>
      deleteConnectionUncoordinated.call(store, connectorInstanceId, options)
    );
  // Close the delete/upsert TOCTOU: without this, a concurrent delete and
  // upsert for the SAME identity could interleave between the tombstone
  // check and the INSERT (the tombstone commits after upsert already read
  // "no tombstone"), resurrecting the connection despite the guard above.
  // Coordinated on the SAME deterministic connector_instance_id
  // `deleteConnection` uses, so a delete and an upsert for the same
  // identity always serialize through the one per-identity gate.
  // `withConnectorInstanceWrite`'s Postgres path acquires a REAL
  // `pg_try_advisory_lock` (postgresCoordinationEnabled() /
  // acquirePostgresAdvisoryLock in connector-instance-write-coordinator.ts)
  // -- exclusion enforced by the Postgres server across connections and
  // processes, not merely the coordinator's in-process mutex. Proven by a
  // genuine two-OS-process discriminator, not just concurrent async calls
  // in one process: test/connector-instance-delete-upsert-two-process-race.test.js.
  // See openspec/changes/fix-owner-delete-resurrection.
  const upsertUncoordinated = store.upsert;
  store.upsert = (record) =>
    withConnectorInstanceWrite(normalizeRecord(record).connectorInstanceId, () =>
      upsertUncoordinated.call(store, record)
    );
  return Object.assign(store, {
    upsertForEnrollment: (record: ConnectorInstanceUpsertRecord) =>
      withConnectorInstanceControlPlaneWrite(normalizeRecord(record).connectorInstanceId, () =>
        upsertUncoordinated.call(store, record)
      ),
  });
}
