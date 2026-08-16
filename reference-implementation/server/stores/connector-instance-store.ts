// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  type ConnectorInstanceGroupRow,
  loadOwnerConnectorInstanceGroupsPostgres,
  loadOwnerConnectorInstanceGroupsSqlite,
  resolveCanonicalConnectorInstanceId,
} from "../connector-instance-canonicalization.ts";

// Type definitions
interface ConnectorInstance {
  // Present only on rows returned by `listOwnerVisibleIdentityPage` (Explore's
  // facet listing), which preloads the owner's `connector_instance_groups` map
  // and resolves each row through `resolveCanonicalConnectorInstanceId`.
  // Identity function (equal to `connectorInstanceId`) for an ungrouped row or
  // any other read path that does not pass a group map into `mapInstance`.
  canonicalConnectorInstanceId?: string;
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

interface ActiveConnectorCountRow extends Record<string, unknown> {
  active_count: number | string;
  connector_id: string;
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
  deleteRecordRejectionsPostgres: (
    client: unknown,
    connectorInstanceId: string,
    ownerSubjectId: string
  ) => Promise<number>;
  deleteRecordRejectionsSqlite: (connectorInstanceId: string, ownerSubjectId: string) => number;
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
  iterateDynamicSqlAcknowledged,
  referenceQueries,
  writeTransaction,
} from "../../lib/db.ts";
import {
  withConnectorInstanceControlPlaneWrite,
  withConnectorInstanceWrite,
} from "../connector-instance-write-coordinator.ts";
import type { PostgresTransactionClient } from "../postgres-storage.ts";
import { postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";

const ACTIVE_RESOLUTION_LIMIT = 2;
const ACTIVE_FANIN_LIMIT = 64;
const LIST_LIMIT = 500;
const CONNECTOR_IDENTITY_PAGE_LIMIT_MAX = 100;

export interface ConnectorIdentityPageBoundary {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt: string;
}

/**
 * Optional owner-scoped `connector_id` filter for `listOwnerVisibleIdentityPage`.
 * `null`/omitted preserves the exact prior fleet-wide page. A single string
 * narrows the SAME keyset page (identity, ordering, cursor tuple) to one
 * connector's connections — Add Source, manual upload, and grant discovery
 * enumerate all of one connector's connections without a fleet scan. A
 * readonly array is the bounded repeated-value SET scope (design doc
 * add-source-perf-design-agy-0730.md "Minimal contract"): 1..
 * {@link CONNECTOR_IDENTITY_PAGE_LIMIT_MAX} canonical distinct ids, letting a
 * single exhausted traversal answer "every connection across THESE N catalog
 * types" — the batched Add Source read, never a per-catalog-id fan-out.
 */
export interface ConnectorIdentityPageFilter {
  readonly connectorId?: string | readonly string[] | null;
}

export interface ConnectorInstanceIdentityPage {
  readonly hasMore: boolean;
  readonly rows: readonly ConnectorInstance[];
}

function assertConnectorIdentityPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > CONNECTOR_IDENTITY_PAGE_LIMIT_MAX) {
    throw new RangeError(`Connector identity page limit must be 1..${CONNECTOR_IDENTITY_PAGE_LIMIT_MAX}.`);
  }
}

type ConnectorIdScopeNormalized =
  | { readonly kind: "none" }
  | { readonly kind: "single"; readonly id: string }
  | { readonly kind: "set"; readonly ids: readonly string[] };

/**
 * Normalize the store-level `connectorId` filter (`string | readonly
 * string[] | null`, already canonicalized/deduplicated by the caller —
 * `pagination.ts`'s `parseConnectorIdFilter`) into a template-choice
 * discriminant. A 1-element array collapses to `single` — the exact
 * pre-existing filtered-template shape — so a caller passing a trivial set
 * never pays for the SET template's extra membership join.
 */
function normalizeConnectorIdScope(
  connectorId: string | readonly string[] | null | undefined
): ConnectorIdScopeNormalized {
  if (connectorId === null || connectorId === undefined) {
    return { kind: "none" };
  }
  if (typeof connectorId === "string") {
    return { id: connectorId, kind: "single" };
  }
  if (connectorId.length === 0) {
    return { kind: "none" };
  }
  if (connectorId.length === 1) {
    return { id: connectorId[0] as string, kind: "single" };
  }
  assertConnectorIdentityPageLimit(connectorId.length);
  return { ids: connectorId, kind: "set" };
}

/**
 * Shared bind-parameter array for `listOwnerVisibleIdentityPage`'s static
 * templates (unfiltered/filtered/SET) — identical on both backends, since
 * only the SQL text differs, not the bound values. Isolated so neither
 * store's `listOwnerVisibleIdentityPage` has to re-express the
 * template-choice branch inline. `connectorIdSetParam` carries the SET
 * template's second bind value — an already-JSON-stringified array for
 * SQLite's `json_each`, or the raw string array for Postgres's `unnest`
 * (each backend's caller passes its own encoding); `null`/single-string
 * scope never populates it.
 */
function ownerVisibleIdentityPageParams(
  ownerSubjectId: string,
  connectorId: string | null,
  after: ConnectorIdentityPageBoundary | null,
  limit: number,
  connectorIdSetParam?: string | readonly string[]
): (string | number | null | readonly string[])[] {
  const cursorConnectorId = after ? after.connectorId : null;
  const cursorCreatedAt = after ? after.createdAt : null;
  const cursorInstanceId = after ? after.connectorInstanceId : null;
  const base = [
    ownerSubjectId,
    cursorConnectorId,
    cursorConnectorId,
    cursorConnectorId,
    cursorCreatedAt,
    cursorConnectorId,
    cursorCreatedAt,
    cursorInstanceId,
    limit + 1,
  ];
  if (connectorIdSetParam !== undefined) {
    return [ownerSubjectId, connectorIdSetParam, ...base.slice(1)];
  }
  return connectorId === null ? base : [ownerSubjectId, connectorId, ...base.slice(1)];
}

// The SAME `recovery_reason` string the historical-archive recovery path
// stamps on a PURE recovered fragment (a `historical_archive` binding
// restored from record evidence with no surviving connector_instances row and
// no UAT-transfer marker). Kept as a single named constant, not inlined, so
// the SQLite/Postgres literal and the app-level predicate below (used by any
// point-lookup that bypasses this page) can never drift from each other.
const PURE_RECOVERED_FRAGMENT_RECOVERY_REASON = "connection_metadata_missing";

// Bind-parameter array for the sources-visible unfiltered template: identical
// cursor tuple to `ownerVisibleIdentityPageParams`'s unfiltered shape, with
// the pure-recovered-fragment `recovery_reason` literal bound once as its own
// parameter (never string-interpolated) ahead of the cursor tuple.
function sourcesVisibleIdentityPageParams(
  ownerSubjectId: string,
  after: ConnectorIdentityPageBoundary | null,
  limit: number
): (string | number | null)[] {
  const cursorConnectorId = after ? after.connectorId : null;
  const cursorCreatedAt = after ? after.createdAt : null;
  const cursorInstanceId = after ? after.connectorInstanceId : null;
  return [
    ownerSubjectId,
    PURE_RECOVERED_FRAGMENT_RECOVERY_REASON,
    cursorConnectorId,
    cursorConnectorId,
    cursorConnectorId,
    cursorCreatedAt,
    cursorConnectorId,
    cursorCreatedAt,
    cursorInstanceId,
    limit + 1,
  ];
}

// This is an owner-facing dashboard visibility policy, not a generic status
// filter: drafts and ordinary revoked connections remain visible, while
// retired setup shells and system-only connectors do not consume page slots.
//
// Terminal-gate revision (2026-07-29): the prior single fixed-shape query
// expressed the optional connector_id filter as `(? IS NULL OR connector_id =
// ?)`. SQLite's planner cannot use a composite index's second column
// (`idx_connector_instances_owner_identity_page(owner_subject_id,
// connector_id, created_at, connector_instance_id)`) through that OR shape —
// EXPLAIN showed it fell back to a full `owner_subject_id`-only index scan,
// walking every connection the owner has for a sparse filtered connector
// (real PostgreSQL, whose planner CAN see through the OR, used the composite
// index on both columns). Two static, separately-prepared templates — one
// with a plain sargable `connector_id = ?` equality, one without the
// predicate at all — let SQLite range-scan the composite index on both
// columns in the filtered case, and keep the original owner-only scan in the
// unfiltered case (there is no `connector_id` to seek to when listing every
// connector). The application chooses which template to bind based on
// whether a `connectorId` filter is present; both keep the identical column
// list, NOT LIKE exclusions, visibility predicate, cursor tuple, ordering,
// and limit.
// Exported for EXPLAIN-plan test introspection only (e.g. asserting the
// composite `idx_connector_instances_owner_identity_page` index is seekable
// on `connector_id` for the filtered template) — not part of the store's
// public read surface, which stays `listOwnerVisibleIdentityPage`.
export const SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL = `
SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
FROM connector_instances
WHERE owner_subject_id = ?
  AND connector_id NOT LIKE '%manual_action_stub%'
  AND connector_id NOT LIKE '%manual-action-stub%'
  AND connector_id NOT LIKE '%stream-test-stub%'
  AND connector_id NOT LIKE '%pg_runtime_%'
  AND connector_id NOT LIKE '%pg_canonical_%'
  AND connector_id NOT LIKE '%pg_expand_%'
  AND connector_id NOT LIKE '%pg_lexical_backfill_%'
  AND (status <> 'revoked' OR COALESCE(json_extract(source_binding_json, '$.kind'), '') NOT IN ('browser_enrollment_shell', 'static_secret_draft', 'manual_upload_draft'))
  AND (
    ? IS NULL
    OR connector_id > ?
    OR (connector_id = ? AND created_at > ?)
    OR (connector_id = ? AND created_at = ? AND connector_instance_id > ?)
  )
ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
LIMIT ?`;
export const SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_FILTERED_SQL = `
SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
FROM connector_instances
WHERE owner_subject_id = ?
  AND connector_id = ?
  AND connector_id NOT LIKE '%manual_action_stub%'
  AND connector_id NOT LIKE '%manual-action-stub%'
  AND connector_id NOT LIKE '%stream-test-stub%'
  AND connector_id NOT LIKE '%pg_runtime_%'
  AND connector_id NOT LIKE '%pg_canonical_%'
  AND connector_id NOT LIKE '%pg_expand_%'
  AND connector_id NOT LIKE '%pg_lexical_backfill_%'
  AND (status <> 'revoked' OR COALESCE(json_extract(source_binding_json, '$.kind'), '') NOT IN ('browser_enrollment_shell', 'static_secret_draft', 'manual_upload_draft'))
  AND (
    ? IS NULL
    OR connector_id > ?
    OR (connector_id = ? AND created_at > ?)
    OR (connector_id = ? AND created_at = ? AND connector_instance_id > ?)
  )
ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
LIMIT ?`;
// Bounded SET membership template (design doc add-source-perf-design-agy-0730.md
// "Server shape and bounds": "two static identity-page query templates for a
// set membership predicate"). `json_each` binds the SAME already-validated,
// already-canonicalized, size-capped JSON array `countActiveByOwnerConnectorIds`
// uses — never string-interpolated SQL, never an SQLite-only trick that
// defeats the composite index: `json_each`'s output column joins into a plain
// sargable `connector_id = page_connector_ids.value` equality, which (like
// the single-id FILTERED template above) lets SQLite range-scan
// `idx_connector_instances_owner_identity_page` on both
// `owner_subject_id`/`connector_id`, rather than falling back to an
// owner-only scan the way the old `OR`-shaped predicate did.
export const SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL = `
SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
FROM connector_instances
WHERE owner_subject_id = ?
  AND connector_id IN (SELECT value FROM json_each(?))
  AND connector_id NOT LIKE '%manual_action_stub%'
  AND connector_id NOT LIKE '%manual-action-stub%'
  AND connector_id NOT LIKE '%stream-test-stub%'
  AND connector_id NOT LIKE '%pg_runtime_%'
  AND connector_id NOT LIKE '%pg_canonical_%'
  AND connector_id NOT LIKE '%pg_expand_%'
  AND connector_id NOT LIKE '%pg_lexical_backfill_%'
  AND (status <> 'revoked' OR COALESCE(json_extract(source_binding_json, '$.kind'), '') NOT IN ('browser_enrollment_shell', 'static_secret_draft', 'manual_upload_draft'))
  AND (
    ? IS NULL
    OR connector_id > ?
    OR (connector_id = ? AND created_at > ?)
    OR (connector_id = ? AND created_at = ? AND connector_instance_id > ?)
  )
ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
LIMIT ?`;
// Sources-list-only identity page: EXCLUDES a pure recovered historical
// fragment before LIMIT (never a post-LIMIT filter — the known
// filter-after-LIMIT defect this repo avoids everywhere else, see the
// `RETIRED_SETUP_SHELL_BINDING_KINDS` predicate above). Deliberately a
// SEPARATE template family from `SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_*_SQL`:
// Explore's connection-facet listing and every other read surface use the
// unfiltered templates unchanged, so a hidden fragment's already-ingested
// records stay attributable and reachable there. A `historical_archive`
// binding that ALSO carries a UAT-transfer marker (`latest_uat_source_instance_id`
// or `recovery_reason = 'uat_record_transfer'`) is a manual/UAT-imported
// source, not a bare fragment, and is NOT excluded — the second OR arm below
// keeps it. The Sources page never scopes by `connectorId` (see
// `apps/console/.../sources/page.tsx`), so only the unfiltered shape exists;
// add FILTERED/SET siblings if a future caller needs the scoped form.
export const SQLITE_SOURCES_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL = `
SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
FROM connector_instances
WHERE owner_subject_id = ?
  AND connector_id NOT LIKE '%manual_action_stub%'
  AND connector_id NOT LIKE '%manual-action-stub%'
  AND connector_id NOT LIKE '%stream-test-stub%'
  AND connector_id NOT LIKE '%pg_runtime_%'
  AND connector_id NOT LIKE '%pg_canonical_%'
  AND connector_id NOT LIKE '%pg_expand_%'
  AND connector_id NOT LIKE '%pg_lexical_backfill_%'
  AND (status <> 'revoked' OR COALESCE(json_extract(source_binding_json, '$.kind'), '') NOT IN ('browser_enrollment_shell', 'static_secret_draft', 'manual_upload_draft'))
  AND (
    json_extract(source_binding_json, '$.kind') IS NOT 'historical_archive'
    OR json_extract(source_binding_json, '$.recovery_reason') IS NOT ?
    OR json_extract(source_binding_json, '$.latest_uat_source_instance_id') IS NOT NULL
    OR json_extract(source_binding_json, '$.recovery_reason') IS 'uat_record_transfer'
  )
  AND NOT EXISTS (
    SELECT 1 FROM connector_instance_groups
    WHERE connector_instance_groups.connector_instance_id = connector_instances.connector_instance_id
  )
  AND (
    ? IS NULL
    OR connector_id > ?
    OR (connector_id = ? AND created_at > ?)
    OR (connector_id = ? AND created_at = ? AND connector_instance_id > ?)
  )
ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
LIMIT ?`;

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
// Source-binding kinds whose REVOKED row is a retired setup shell, not an
// ordinary revoked connection — hidden from every owner-visible read surface
// alongside `READ_SURFACE_HIDDEN_STATUSES`. Mirrors the SQL predicate
// `(status <> 'revoked' OR source_binding kind NOT IN (...))` in
// `SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_*_SQL`/the Postgres equivalents below —
// duplicated here (SQL + JS) because `resolveOwnerVisibleConnectionForRoute`'s
// exact-id point lookup (`ref-control.ts`) bypasses the paged query entirely
// and must apply the SAME visibility rule to what it reads via `store.get`.
const RETIRED_SETUP_SHELL_BINDING_KINDS = new Set([
  "browser_enrollment_shell",
  "static_secret_draft",
  "manual_upload_draft",
]);

/**
 * True when `instance` is owner-visible under the SAME rule the identity-page
 * SQL enforces: a `revoked` row whose source-binding kind is a retired setup
 * shell (browser-enrollment shell, static-secret draft, manual-upload draft)
 * is hidden from every read surface, exactly like a `draft`-status row is.
 * Every other status/kind combination is visible. Used by any point-lookup
 * path (`store.get`) that must match the paged listing's visibility contract
 * without re-querying the page.
 */
export function isOwnerVisibleConnectorInstance(instance: {
  readonly status: string;
  readonly sourceBinding: unknown;
}): boolean {
  if (instance.status !== "revoked") {
    return true;
  }
  const { sourceBinding } = instance;
  const kind =
    sourceBinding && typeof sourceBinding === "object" && !Array.isArray(sourceBinding)
      ? (sourceBinding as { kind?: unknown }).kind
      : undefined;
  return typeof kind !== "string" || !RETIRED_SETUP_SHELL_BINDING_KINDS.has(kind);
}
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

// Preloaded, request-scoped default: `mapInstance` never issues a per-row DB
// round trip to resolve canonicalization. Callers with owner context (e.g.
// `listOwnerVisibleIdentityPage`) pass an owner-preloaded map (see
// `loadOwnerConnectorInstanceGroups{Sqlite,Postgres}`); every other call site
// (point lookups, delete flows, other list surfaces) passes nothing and gets
// this shared empty map, so `canonicalConnectorInstanceId` resolves to the
// identity function unless a caller opts in.
const EMPTY_CONNECTOR_INSTANCE_GROUPS: ReadonlyMap<string, ConnectorInstanceGroupRow> = new Map();

function mapInstance(row: ConnectorInstanceRow | null): ConnectorInstance | null;
function mapInstance(row: ConnectorInstanceRow): ConnectorInstance;
function mapInstance(row: ConnectorInstanceRow | null): ConnectorInstance | null {
  if (!row) {
    return null;
  }
  return mapInstanceWithGroups(row, EMPTY_CONNECTOR_INSTANCE_GROUPS);
}

// `mapInstance` variant that resolves `canonicalConnectorInstanceId` through a
// preloaded owner group map, rather than the shared empty default. Kept as a
// distinct name (not an optional second parameter on `mapInstance`) because
// `mapInstance` is used bare as an `Array.prototype.map` callback throughout
// this file, and `Array.map` would otherwise pass its numeric index as that
// second argument.
function mapInstanceWithGroups(
  row: ConnectorInstanceRow,
  groups: ReadonlyMap<string, ConnectorInstanceGroupRow>
): ConnectorInstance {
  return {
    canonicalConnectorInstanceId: resolveCanonicalConnectorInstanceId(row.connector_instance_id, groups),
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
// `FALL_THROUGH_TO_CONNECTOR_ID` when the instance is missing but is either a
// legacy connector_id hint or the deterministic default-account identity (see
// Decision 3 note at the caller). Throws connector_instance_not_found
// otherwise.
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
  // Older grant/storage bindings use connector_id as a default-account hint;
  // direct runtime writers use the deterministic default-account identity.
  // Both are safe fall-through selectors only when they match this owner and
  // connector's exact default binding. Arbitrary or foreign-owner missing
  // instance IDs remain a typed not-found and are never materialized.
  const isDefaultAccountHint =
    allowDefaultAccount &&
    connectorId &&
    (connectorInstanceId === connectorId ||
      connectorInstanceId === makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId));
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

/**
 * Admit a new connector run to one authoritative connection namespace.
 *
 * This is deliberately narrower than `resolveOwnerConnectorInstanceNamespace`:
 * a claimed instance id is always an exact, existing, owner-authorized row.
 * Only an omitted selector may materialize the authenticated owner's default
 * account. Keeping that policy here prevents run creators from treating a
 * connector type (or another owner's deterministic id) as a capability.
 */
export function admitOwnerRunConnection({
  allowDraft = false,
  ownerSubjectId,
  connectorId,
  connectorInstanceId = null,
  connectorInstanceStore,
  displayName = null,
  now,
}: {
  /** Setup routes may explicitly admit the exact draft they just created. */
  allowDraft?: boolean;
  ownerSubjectId: string;
  connectorId: string;
  connectorInstanceId?: string | null;
  connectorInstanceStore: ConnectorInstanceStoreLike;
  displayName?: string | null;
  now?: string;
}): Promise<ConnectorInstanceNamespace> {
  return resolveOwnerConnectorInstanceNamespace({
    // Explicit selectors never materialize or fall through. The broader
    // resolver still supports legacy read compatibility independently.
    allowDefaultAccount: !connectorInstanceId,
    allowStatuses: allowDraft ? ["active", "draft"] : ["active"],
    connectorId,
    connectorInstanceId,
    connectorInstanceStore,
    displayName,
    ownerSubjectId,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * Admit the one owner-session run that is allowed to start from a browser
 * enrollment shell. This is intentionally a separate capability from
 * `admitOwnerRunConnection`: a draft is runnable here only when the exact row
 * belongs to the owner, belongs to the requested connector, and still carries
 * the browser-enrollment-shell binding.
 */
export async function admitOwnerBrowserEnrollmentRunConnection({
  ownerSubjectId,
  connectorId,
  connectorInstanceId,
  connectorInstanceStore,
}: {
  ownerSubjectId: string;
  connectorId: string;
  connectorInstanceId: string | null;
  connectorInstanceStore: ConnectorInstanceStoreLike;
}): Promise<ConnectorInstanceNamespace> {
  if (!connectorInstanceId) {
    throw new ConnectorInstanceResolutionError(
      "connector_instance_selector_required",
      "A browser enrollment run requires an exact connector instance id.",
      { connectorId, ownerSubjectId }
    );
  }
  const namespace = await resolveOwnerConnectorInstanceNamespace({
    allowDefaultAccount: false,
    allowStatuses: ["draft"],
    connectorId,
    connectorInstanceId,
    connectorInstanceStore,
    ownerSubjectId,
  });
  const binding = namespace.sourceBinding;
  const isBrowserEnrollmentShell =
    binding !== null &&
    typeof binding === "object" &&
    !Array.isArray(binding) &&
    (binding as { kind?: unknown }).kind === "browser_enrollment_shell";
  if (!isBrowserEnrollmentShell) {
    throw new ConnectorInstanceResolutionError(
      "browser_enrollment_shell_required",
      `Connector instance '${connectorInstanceId}' is not a browser enrollment shell.`,
      { connectorId, connectorInstanceId, ownerSubjectId }
    );
  }
  return namespace;
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

    // Page-scoped aggregate for the legacy connector-wide run fallback. This
    // intentionally receives only connector ids occurring in one identity
    // page: it must never enumerate the owner's connection inventory.
    countActiveByOwnerConnectorIds(ownerSubjectId: string, connectorIds: readonly string[]): Map<string, number> {
      const ids = [...new Set(connectorIds.filter((id) => id.length > 0))];
      if (ids.length === 0) {
        return new Map();
      }
      assertConnectorIdentityPageLimit(ids.length);
      const { rows } = getMany<ActiveConnectorCountRow>(
        referenceQueries.connectorInstancesCountActiveByOwnerConnectorIds,
        [JSON.stringify(ids), ownerSubjectId],
        { limit: ids.length }
      );
      return new Map(rows.map((row) => [row.connector_id, Number(row.active_count)]));
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
        purge.deleteRecordRejectionsSqlite(connectorInstanceId, instance.ownerSubjectId);
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

    // REVIEWED-DYNAMIC: the reusable keyset boundary needs an optional
    // three-column continuation tuple; the generic `getMany` cursor is
    // intentionally limited to `(cursor_field, rowid)` and cannot represent
    // this identity contract. SQL remains fixed and every value is bound.
    listOwnerVisibleIdentityPage(
      ownerSubjectId: string,
      {
        after = null,
        limit,
        connectorId = null,
      }: { after?: ConnectorIdentityPageBoundary | null; limit: number } & ConnectorIdentityPageFilter
    ): ConnectorInstanceIdentityPage {
      assertConnectorIdentityPageLimit(limit);
      const scope = normalizeConnectorIdScope(connectorId);
      // Static template choice, not a dynamic-shape query: a present single
      // `connectorId` binds the FILTERED template (plain sargable
      // `connector_id = ?`, seekable on the composite index); a SET binds the
      // SET template (`json_each` membership, same index-seekable shape); a
      // `null` filter binds the UNFILTERED template (no connector_id
      // predicate at all). Every other bound value and column is identical
      // across all three (see `ownerVisibleIdentityPageParams`, shared with
      // the PostgreSQL store since only the SQL text differs, not the bound
      // values).
      let sql: string;
      let params: (string | number | null)[];
      if (scope.kind === "set") {
        sql = SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL;
        params = ownerVisibleIdentityPageParams(ownerSubjectId, null, after, limit, JSON.stringify(scope.ids)) as (
          | string
          | number
          | null
        )[];
      } else if (scope.kind === "single") {
        sql = SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_FILTERED_SQL;
        params = ownerVisibleIdentityPageParams(ownerSubjectId, scope.id, after, limit) as (string | number | null)[];
      } else {
        sql = SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL;
        params = ownerVisibleIdentityPageParams(ownerSubjectId, null, after, limit) as (string | number | null)[];
      }
      // SQLite's bind driver never receives a raw array: the SET template's
      // second parameter is always the JSON.stringify'd string bound above
      // (json_each parses it), never the raw `readonly string[]` the shared
      // params helper's return type also allows for the PostgreSQL `unnest`
      // call site below.
      const rows = Array.from(iterateDynamicSqlAcknowledged<ConnectorInstanceRow>(sql, params));
      const hasMore = rows.length > limit;
      const groups = loadOwnerConnectorInstanceGroupsSqlite(ownerSubjectId);
      return { hasMore, rows: rows.slice(0, limit).map((row) => mapInstanceWithGroups(row, groups)) };
    },

    // Sources-page-only sibling of `listOwnerVisibleIdentityPage`: excludes a
    // pure recovered historical fragment BEFORE `LIMIT` (see
    // `SQLITE_SOURCES_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL`'s comment for the
    // exact exclusion contract). Every other caller (Explore's facet listing,
    // Add Source, manual upload) keeps using `listOwnerVisibleIdentityPage`
    // unchanged, so a hidden fragment's connection facet and records stay
    // reachable everywhere except this one paginated list.
    listSourcesVisibleIdentityPage(
      ownerSubjectId: string,
      { after = null, limit }: { after?: ConnectorIdentityPageBoundary | null; limit: number }
    ): ConnectorInstanceIdentityPage {
      assertConnectorIdentityPageLimit(limit);
      const rows = Array.from(
        iterateDynamicSqlAcknowledged<ConnectorInstanceRow>(
          SQLITE_SOURCES_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL,
          sourcesVisibleIdentityPageParams(ownerSubjectId, after, limit)
        )
      );
      const hasMore = rows.length > limit;
      return { hasMore, rows: rows.slice(0, limit).map(mapInstance) };
    },

    // Promotes a temporary setup binding to its durable sibling kind.
    // Guarded by `status = 'draft' AND binding.kind = fromKind`: a
    // concurrent revoke racing this UPDATE loses safely (no row change,
    // `promoted: false`). Never writes the identity tuple
    // (connector_instance_id/owner_subject_id/source_kind/source_binding_key).
    promoteSetupBinding(
      connectorInstanceId: string,
      {
        fromKind,
        sourceBinding,
        updatedAt,
      }: { fromKind: string; sourceBinding: Record<string, unknown>; updatedAt: string }
    ): { instance: ConnectorInstance | null; promoted: boolean } {
      let promoted = false;
      writeTransaction(() => {
        const result = exec(referenceQueries.connectorInstancesPromoteSetupBinding, [
          stableJson(sourceBinding),
          "active",
          updatedAt,
          connectorInstanceId,
          fromKind,
        ]);
        promoted = Boolean(result.changes);
        if (promoted) {
          exec(referenceQueries.connectorSummaryEvidenceMarkDirtyByConnectorInstance, [
            `connector instance promoted from ${fromKind}`,
            connectorInstanceId,
          ]);
        }
      });
      return { instance: this.get(connectorInstanceId), promoted };
    },

    resolveActiveByConnector(ownerSubjectId: string, connectorId: string): ConnectorInstance {
      const rows = getMany<ConnectorInstanceRow>(
        referenceQueries.connectorInstancesListActiveByOwnerConnector,
        [ownerSubjectId, connectorId],
        { limit: ACTIVE_RESOLUTION_LIMIT }
      ).rows.map(mapInstance);
      return resolveSingleActive(rows, ownerSubjectId, connectorId);
    },

    // Terminal-gate revision (2026-07-29): same one-transaction shape as
    // `updateStatus` — the display_name write and its dirty marker commit
    // together, or neither does. Thrown errors (not-found) roll back the
    // whole transaction via better-sqlite3's transaction wrapper, so the
    // not-found check below never leaves a dangling dirty marker.
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
      writeTransaction(() => {
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
        exec(referenceQueries.connectorSummaryEvidenceMarkDirtyByConnectorInstance, [
          "connector instance display_name changed",
          connectorInstanceId,
        ]);
      });
      return this.get(connectorInstanceId);
    },

    // Re-key one owner-session static-secret instance after a synchronous
    // provider probe proves its account identity. The connector instance id
    // is intentionally preserved: records, schedules, history, and callers
    // all address that id. The existing binding unique constraint is the
    // cross-request identity claim; a concurrent claim for the same verified
    // identity raises the backend's normal unique-constraint error for the
    // route to resolve to the winner.
    updateStaticSecretBinding({
      connectorInstanceId,
      connectorId,
      ownerSubjectId,
      sourceBinding,
      sourceBindingKey,
      updatedAt,
    }: {
      connectorId: string;
      connectorInstanceId: string;
      ownerSubjectId: string;
      sourceBinding: Record<string, unknown>;
      sourceBindingKey: string;
      updatedAt: string;
    }): ConnectorInstance | null {
      writeTransaction(() => {
        const result = exec(referenceQueries.connectorInstancesUpdateStaticSecretBinding, [
          sourceBindingKey,
          stableJson(sourceBinding),
          updatedAt,
          connectorInstanceId,
          ownerSubjectId,
          connectorId,
        ]);
        if (result.changes) {
          exec(referenceQueries.connectorSummaryEvidenceMarkDirtyByConnectorInstance, [
            "static-secret binding updated",
            connectorInstanceId,
          ]);
        }
      });
      return this.get(connectorInstanceId);
    },

    // Terminal-gate revision (2026-07-29): the status write and its
    // summary-evidence dirty marker commit in ONE transaction, matching
    // `deleteConnection`'s existing precedent for the same table. A marker
    // write that failed AFTER an already-committed status change (the
    // previous two-statement shape) could silently lose the repair signal;
    // GET is now purely read-only, so there is no read-time reconcile left
    // to paper over that gap.
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
      writeTransaction(() => {
        exec(referenceQueries.connectorInstancesUpdateStatus, [status, updatedAt, revokedAt, connectorInstanceId]);
        exec(referenceQueries.connectorSummaryEvidenceMarkDirtyByConnectorInstance, [
          `connector instance status changed to ${status}`,
          connectorInstanceId,
        ]);
      });
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
          normalized.connectorId,
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

// Exported for EXPLAIN-plan test introspection only, mirroring the SQLite
// constants above — not part of the store's public read surface.
export const POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL = `
SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
FROM connector_instances
WHERE owner_subject_id = $1
  AND connector_id NOT LIKE '%manual_action_stub%'
  AND connector_id NOT LIKE '%manual-action-stub%'
  AND connector_id NOT LIKE '%stream-test-stub%'
  AND connector_id NOT LIKE '%pg_runtime_%'
  AND connector_id NOT LIKE '%pg_canonical_%'
  AND connector_id NOT LIKE '%pg_expand_%'
  AND connector_id NOT LIKE '%pg_lexical_backfill_%'
  AND (status <> 'revoked' OR COALESCE(source_binding_json->>'kind', '') NOT IN ('browser_enrollment_shell', 'static_secret_draft', 'manual_upload_draft'))
  AND (
    $2::text IS NULL
    OR connector_id > $3
    OR (connector_id = $4 AND created_at > $5)
    OR (connector_id = $6 AND created_at = $7 AND connector_instance_id > $8)
  )
ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
LIMIT $9`;
export const POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_FILTERED_SQL = `
SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
FROM connector_instances
WHERE owner_subject_id = $1
  AND connector_id = $2
  AND connector_id NOT LIKE '%manual_action_stub%'
  AND connector_id NOT LIKE '%manual-action-stub%'
  AND connector_id NOT LIKE '%stream-test-stub%'
  AND connector_id NOT LIKE '%pg_runtime_%'
  AND connector_id NOT LIKE '%pg_canonical_%'
  AND connector_id NOT LIKE '%pg_expand_%'
  AND connector_id NOT LIKE '%pg_lexical_backfill_%'
  AND (status <> 'revoked' OR COALESCE(source_binding_json->>'kind', '') NOT IN ('browser_enrollment_shell', 'static_secret_draft', 'manual_upload_draft'))
  AND (
    $3::text IS NULL
    OR connector_id > $4
    OR (connector_id = $5 AND created_at > $6)
    OR (connector_id = $7 AND created_at = $8 AND connector_instance_id > $9)
  )
ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
LIMIT $10`;
// Postgres SET membership peer of the SQLite `json_each` template above,
// mirroring `countActiveByOwnerConnectorIds`'s existing `unnest($n::text[])`
// pattern: a bound `text[]` array, never interpolated SQL, joining into a
// plain sargable `connector_id = page_connector_ids.connector_id` equality
// the composite index can seek on.
export const POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL = `
SELECT ci.connector_instance_id, ci.owner_subject_id, ci.connector_id, ci.display_name, ci.status,
       ci.source_kind, ci.source_binding_key, ci.source_binding_json, ci.created_at, ci.updated_at, ci.revoked_at
FROM connector_instances AS ci
JOIN unnest($2::text[]) AS page_connector_ids(connector_id)
  ON page_connector_ids.connector_id = ci.connector_id
WHERE ci.owner_subject_id = $1
  AND ci.connector_id NOT LIKE '%manual_action_stub%'
  AND ci.connector_id NOT LIKE '%manual-action-stub%'
  AND ci.connector_id NOT LIKE '%stream-test-stub%'
  AND ci.connector_id NOT LIKE '%pg_runtime_%'
  AND ci.connector_id NOT LIKE '%pg_canonical_%'
  AND ci.connector_id NOT LIKE '%pg_expand_%'
  AND ci.connector_id NOT LIKE '%pg_lexical_backfill_%'
  AND (ci.status <> 'revoked' OR COALESCE(ci.source_binding_json->>'kind', '') NOT IN ('browser_enrollment_shell', 'static_secret_draft', 'manual_upload_draft'))
  AND (
    $3::text IS NULL
    OR ci.connector_id > $4
    OR (ci.connector_id = $5 AND ci.created_at > $6)
    OR (ci.connector_id = $7 AND ci.created_at = $8 AND ci.connector_instance_id > $9)
  )
ORDER BY ci.connector_id ASC, ci.created_at ASC, ci.connector_instance_id ASC
LIMIT $10`;

// Postgres mirror of `SQLITE_SOURCES_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL` —
// see that template's comment for the exclusion contract (pure recovered
// fragments only; a `historical_archive` binding carrying a UAT-transfer
// marker stays visible; every other read surface, including Explore's
// facet listing, keeps using the unfiltered templates above unchanged).
export const POSTGRES_SOURCES_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL = `
SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
FROM connector_instances
WHERE owner_subject_id = $1
  AND connector_id NOT LIKE '%manual_action_stub%'
  AND connector_id NOT LIKE '%manual-action-stub%'
  AND connector_id NOT LIKE '%stream-test-stub%'
  AND connector_id NOT LIKE '%pg_runtime_%'
  AND connector_id NOT LIKE '%pg_canonical_%'
  AND connector_id NOT LIKE '%pg_expand_%'
  AND connector_id NOT LIKE '%pg_lexical_backfill_%'
  AND (status <> 'revoked' OR COALESCE(source_binding_json->>'kind', '') NOT IN ('browser_enrollment_shell', 'static_secret_draft', 'manual_upload_draft'))
  AND (
    COALESCE(source_binding_json->>'kind', '') <> 'historical_archive'
    OR COALESCE(source_binding_json->>'recovery_reason', '') <> $2
    OR source_binding_json->>'latest_uat_source_instance_id' IS NOT NULL
    OR source_binding_json->>'recovery_reason' = 'uat_record_transfer'
  )
  AND NOT EXISTS (
    SELECT 1 FROM connector_instance_groups
    WHERE connector_instance_groups.connector_instance_id = connector_instances.connector_instance_id
  )
  AND (
    $3::text IS NULL
    OR connector_id > $4
    OR (connector_id = $5 AND created_at > $6)
    OR (connector_id = $7 AND created_at = $8 AND connector_instance_id > $9)
  )
ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
LIMIT $10`;

export function createPostgresConnectorInstanceStore() {
  const store = {
    // Flip a static-secret draft to active on its first successful ingest. A
    // single conditional UPDATE keyed on `status = 'draft'` is the no-op /
    // concurrency guard: a row that is missing or not draft is untouched. See
    // add-static-secret-owner-session-connect-path design Decision 5.
    // Transaction-scoped connector-instance advisory lock (2026-08-10,
    // harden-connector-instance-write-fence-transaction-native): this is
    // promoteSetupBinding's sibling branch in the same activateDraftConnection
    // control-flow and was missed by that callsite audit -- an unfenced write
    // here could race deleteConnection for the SAME connector instance
    // (delete's row-erasing transaction and this UPDATE with no ordering
    // guarantee between them). Locking matches every other Postgres mutator
    // in this file.
    async activateDraft(
      connectorInstanceId: string,
      { now }: { now?: string } = {}
    ): Promise<ConnectorInstance | null> {
      await withPostgresTransaction(
        async (client: PostgresTransactionClient) => {
          await client.query(
            `UPDATE connector_instances
             SET status = 'active', updated_at = $1, revoked_at = NULL
             WHERE connector_instance_id = $2 AND status = 'draft'`,
            [now ?? new Date().toISOString(), connectorInstanceId]
          );
        },
        { lockConnectorInstanceId: connectorInstanceId }
      );
      return await this.get(connectorInstanceId);
    },

    // Postgres peer of the SQLite page-scoped aggregate above. `unnest` is
    // bounded by the one page's distinct connector ids; the result is bounded
    // again by that same cardinality.
    async countActiveByOwnerConnectorIds(
      ownerSubjectId: string,
      connectorIds: readonly string[]
    ): Promise<Map<string, number>> {
      const ids = [...new Set(connectorIds.filter((id) => id.length > 0))];
      if (ids.length === 0) {
        return new Map();
      }
      assertConnectorIdentityPageLimit(ids.length);
      const result = await postgresQuery<ActiveConnectorCountRow>(
        `SELECT ci.connector_id, COUNT(*)::integer AS active_count
         FROM connector_instances AS ci
         JOIN unnest($2::text[]) AS page_connector_ids(connector_id)
           ON page_connector_ids.connector_id = ci.connector_id
         WHERE ci.owner_subject_id = $1
           AND ci.status = 'active'
         GROUP BY ci.connector_id
         ORDER BY ci.connector_id ASC
         LIMIT $3`,
        [ownerSubjectId, ids, ids.length]
      );
      return new Map(result.rows.map((row) => [row.connector_id, Number(row.active_count)]));
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
        async (client: PostgresTransactionClient) => {
          // Record-family + blob + attention purge runs against the SAME client,
          // so it is atomic with the schedule / device / row deletes below.
          const recordCount = await purge.deleteRecordRowsPostgres(client, connectorInstanceId);
          await purge.deleteRecordRejectionsPostgres(client, connectorInstanceId, instance.ownerSubjectId);
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
            deviceRefsCleared: device.rowCount,
            scheduleDeleted: Number(schedule.rowCount ?? 0) > 0,
          };
        },
        { lockConnectorInstanceId: connectorInstanceId }
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
        deviceRefsCleared: Number(deviceRefsCleared ?? 0),
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

    async listOwnerVisibleIdentityPage(
      ownerSubjectId: string,
      {
        after = null,
        limit,
        connectorId = null,
      }: { after?: ConnectorIdentityPageBoundary | null; limit: number } & ConnectorIdentityPageFilter
    ): Promise<ConnectorInstanceIdentityPage> {
      assertConnectorIdentityPageLimit(limit);
      const scope = normalizeConnectorIdScope(connectorId);
      // Static template choice (terminal-gate revision, 2026-07-29), matching
      // the SQLite store: a plain sargable `connector_id = $2` equality when
      // filtered by one id, a bound `unnest($2::text[])` membership join when
      // filtered by a SET, no connector_id predicate at all when unfiltered.
      // Real PostgreSQL already planned the prior `($2::text IS NULL OR
      // connector_id = $2)` shape onto the composite index correctly, but the
      // static-template requirement applies to both backends, not only the
      // one whose planner happened to see through the dynamic shape. Bound
      // values are shared with the SQLite store via
      // `ownerVisibleIdentityPageParams`.
      let sql: string;
      let params: (string | number | null | readonly string[])[];
      if (scope.kind === "set") {
        sql = POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL;
        params = ownerVisibleIdentityPageParams(ownerSubjectId, null, after, limit, scope.ids);
      } else if (scope.kind === "single") {
        sql = POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_FILTERED_SQL;
        params = ownerVisibleIdentityPageParams(ownerSubjectId, scope.id, after, limit);
      } else {
        sql = POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL;
        params = ownerVisibleIdentityPageParams(ownerSubjectId, null, after, limit);
      }
      const result = await postgresQuery(sql, params);
      const rows = result.rows as ConnectorInstanceRow[];
      const hasMore = rows.length > limit;
      const groups = await loadOwnerConnectorInstanceGroupsPostgres(ownerSubjectId);
      return { hasMore, rows: rows.slice(0, limit).map((row) => mapInstanceWithGroups(row, groups)) };
    },

    // Postgres mirror of the SQLite `listSourcesVisibleIdentityPage` arm
    // above — same exclusion contract, same LIMIT-time enforcement.
    async listSourcesVisibleIdentityPage(
      ownerSubjectId: string,
      { after = null, limit }: { after?: ConnectorIdentityPageBoundary | null; limit: number }
    ): Promise<ConnectorInstanceIdentityPage> {
      assertConnectorIdentityPageLimit(limit);
      const result = await postgresQuery(
        POSTGRES_SOURCES_VISIBLE_IDENTITY_PAGE_UNFILTERED_SQL,
        sourcesVisibleIdentityPageParams(ownerSubjectId, after, limit)
      );
      const rows = result.rows as ConnectorInstanceRow[];
      const hasMore = rows.length > limit;
      return { hasMore, rows: rows.slice(0, limit).map(mapInstance) };
    },

    // Postgres mirror of the SQLite arm above — same `status = 'draft' AND
    // binding.kind = fromKind` guard, same `promoted` result, same
    // identity-preserving contract.
    async promoteSetupBinding(
      connectorInstanceId: string,
      {
        fromKind,
        sourceBinding,
        updatedAt,
      }: { fromKind: string; sourceBinding: Record<string, unknown>; updatedAt: string }
    ): Promise<{ instance: ConnectorInstance | null; promoted: boolean }> {
      let promoted = false;
      await withPostgresTransaction(
        async (client: PostgresTransactionClient) => {
          const result = await client.query(
            `UPDATE connector_instances
             SET source_binding_json = $1::jsonb, status = $2, updated_at = $3
             WHERE connector_instance_id = $4
               AND status = 'draft'
               AND source_binding_json->>'kind' = $5`,
            [stableJson(sourceBinding), "active", updatedAt, connectorInstanceId, fromKind]
          );
          promoted = Boolean(result.rowCount);
          if (promoted) {
            await client.query(
              `UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', last_error = $1 WHERE connector_instance_id = $2`,
              [`connector instance promoted from ${fromKind}`, connectorInstanceId]
            );
          }
        },
        { lockConnectorInstanceId: connectorInstanceId }
      );
      return { instance: await this.get(connectorInstanceId), promoted };
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

    // Terminal-gate revision (2026-07-29): same one-transaction shape as the
    // SQLite store and as `deleteConnection`'s existing precedent for this
    // table — the display_name write and its dirty marker commit together
    // via the SAME client, or neither does.
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
      await withPostgresTransaction(
        async (client: PostgresTransactionClient) => {
          const result = await client.query(
            `UPDATE connector_instances
           SET display_name = $1, updated_at = $2
           WHERE connector_instance_id = $3 AND owner_subject_id = $4`,
            [displayName, updatedAt ?? new Date().toISOString(), connectorInstanceId, ownerSubjectId]
          );
          if (result.rowCount === 0) {
            throw new ConnectorInstanceResolutionError(
              "connector_instance_not_found",
              `Connector instance '${connectorInstanceId}' does not exist for owner '${ownerSubjectId}'.`,
              { connectorInstanceId, ownerSubjectId }
            );
          }
          await client.query(
            `UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', last_error = $1 WHERE connector_instance_id = $2`,
            ["connector instance display_name changed", connectorInstanceId]
          );
        },
        { lockConnectorInstanceId: connectorInstanceId }
      );
      return await this.get(connectorInstanceId);
    },

    // Postgres mirror of the SQLite static-secret identity claim. The binding
    // unique constraint is enforced by the database, not by a process-local
    // read/then-write sequence, so concurrent owners/processes cannot both
    // claim one verified identity.
    async updateStaticSecretBinding({
      connectorInstanceId,
      connectorId,
      ownerSubjectId,
      sourceBinding,
      sourceBindingKey,
      updatedAt,
    }: {
      connectorId: string;
      connectorInstanceId: string;
      ownerSubjectId: string;
      sourceBinding: Record<string, unknown>;
      sourceBindingKey: string;
      updatedAt: string;
    }): Promise<ConnectorInstance | null> {
      await withPostgresTransaction(
        async (client: PostgresTransactionClient) => {
          const result = await client.query(
            `UPDATE connector_instances
             SET source_binding_key = $1,
                 source_binding_json = $2::jsonb,
                 updated_at = $3
             WHERE connector_instance_id = $4
               AND owner_subject_id = $5
               AND connector_id = $6
               AND status IN ('active', 'draft')`,
            [sourceBindingKey, stableJson(sourceBinding), updatedAt, connectorInstanceId, ownerSubjectId, connectorId]
          );
          if (result.rowCount) {
            await client.query(
              `UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', last_error = $1 WHERE connector_instance_id = $2`,
              ["static-secret binding updated", connectorInstanceId]
            );
          }
        },
        { lockConnectorInstanceId: connectorInstanceId }
      );
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
      await withPostgresTransaction(
        async (client: PostgresTransactionClient) => {
          await client.query(
            "UPDATE connector_instances SET status = $1, updated_at = $2, revoked_at = $3 WHERE connector_instance_id = $4",
            [status, updatedAt, revokedAt, connectorInstanceId]
          );
          await client.query(
            `UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', last_error = $1 WHERE connector_instance_id = $2`,
            [`connector instance status changed to ${status}`, connectorInstanceId]
          );
        },
        { lockConnectorInstanceId: connectorInstanceId }
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
      const resultConnectorInstanceId = await withPostgresTransaction(
        async (client: PostgresTransactionClient) => {
          // Tombstone guard: only relevant when no LIVE row exists for this
          // identity yet — an `ON CONFLICT DO UPDATE` hit against an existing
          // row (revoke, pause, reactivate-by-re-enroll) is untouched by this
          // check. See the SQLite arm for the full rationale. Runs on the
          // SAME client/transaction as the INSERT below, inside the SAME
          // connector-instance advisory lock `withPostgresTransaction`
          // acquires via `lockConnectorInstanceId` — the lock (not merely a
          // process-local mutex) is what makes this read-then-write atomic
          // with respect to a concurrent `deleteConnection` transaction for
          // the SAME identity. See
          // harden-connector-instance-write-fence-transaction-native.
          const existing = await client.query<{ connector_instance_id: string }>(
            "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = $1",
            [normalized.connectorInstanceId]
          );
          if (existing.rows.length === 0) {
            const tombstoneResult = await client.query<ConnectorInstanceTombstoneRow>(
              `SELECT connector_instance_id, owner_subject_id, connector_id, source_kind, source_binding_key, deleted_at
               FROM connector_instance_tombstones
               WHERE owner_subject_id = $1 AND connector_id = $2 AND source_kind = $3 AND source_binding_key = $4`,
              [normalized.ownerSubjectId, normalized.connectorId, normalized.sourceKind, normalized.sourceBindingKey]
            );
            assertIdentityNotTombstoned(mapTombstone(tombstoneResult.rows[0]), normalized);
          }
          // Test-only, opt-in — widens the tombstone-check-to-INSERT window so a
          // genuine two-process race is deterministically reproducible. No-op in
          // production.
          await testOnlyUpsertTombstoneCheckDelay();
          // A SAVEPOINT, not a bare try/catch: once ANY statement inside a
          // Postgres transaction errors (including the expected/handled
          // 23505 PK collision below), the WHOLE transaction is aborted
          // (SQLSTATE 25P02, "current transaction is aborted") and refuses
          // every subsequent statement until ROLLBACK. The pre-migration
          // code ran the INSERT and its 23505 fallback UPDATE as two
          // separate AUTOCOMMIT statements, so a 23505 in the first never
          // poisoned the second. Now that both run inside ONE transaction
          // (see this function's header), the fallback path MUST roll back
          // to a savepoint taken before the INSERT, or the collision-repair
          // UPDATE below inherits an already-aborted transaction and itself
          // fails with 25P02. See harden-connector-instance-write-fence-transaction-native.
          await client.query("SAVEPOINT upsert_insert_attempt");
          try {
            // `record_identity_generation` is seeded from the connector's
            // currently persisted manifest, not left at the column default —
            // see the identical rationale in the SQLite arm's `insert.sql`.
            await client.query(
              `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at, record_identity_generation)
               VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
                 COALESCE(
                   (SELECT (manifest #>> '{capabilities,record_identity,generation}')::int
                      FROM connectors WHERE connector_id = $3),
                   0
                 ))
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
            await client.query("RELEASE SAVEPOINT upsert_insert_attempt");
            return normalized.connectorInstanceId;
          } catch (err) {
            if ((err as { code?: string } | null)?.code !== "23505") {
              throw err;
            }
            await client.query("ROLLBACK TO SAVEPOINT upsert_insert_attempt");
            const colliding = await client.query<ConnectorInstanceRow>(
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
            await client.query(
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
            return collidingRow.connector_instance_id;
          }
        },
        { lockConnectorInstanceId: normalized.connectorInstanceId }
      );
      return await this.get(resultConnectorInstanceId);
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
  //
  // Cross-process exclusion is no longer `withConnectorInstanceWrite`'s job
  // (it is now purely an in-process gate — see its docstring). BOTH
  // `deleteConnection` and `upsert` now acquire the SAME transaction-scoped
  // `pg_advisory_xact_lock` directly inside their own `withPostgresTransaction`
  // call (`lockConnectorInstanceId`) — exclusion still enforced by the
  // Postgres server across connections and processes, just transaction-
  // scoped instead of session-scoped. The `withConnectorInstanceWrite` wrap
  // below is kept ONLY to avoid two same-process callers both entering their
  // Postgres transactions concurrently and colliding on `23505`
  // unnecessarily; it is no longer load-bearing for the cross-process
  // invariant. Proven by a genuine two-OS-process discriminator, not just
  // concurrent async calls in one process:
  // test/connector-instance-delete-upsert-two-process-race.test.ts.
  // See openspec/changes/fix-owner-delete-resurrection and
  // harden-connector-instance-write-fence-transaction-native.
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
