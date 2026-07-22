// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted MCP grant-package lifecycle — package/group/member row operations,
 * package-token issuance, owner/MCP package views, and package cascade
 * orchestration.
 *
 * DOES NOT own: generic grant issuance (external dep), generic grant
 * revocation (external dep), OAuth authorization-code or refresh-token
 * exchange (follow-up / OAuth-owned), request-boundary parsing (stays in
 * auth.js), or the staged-consent approval wrapper (consent/auth flow).
 *
 * Invariants:
 * - Package token never replaces or weakens child-grant enforcement.
 * - connection_id is identity metadata, not an authority boundary.
 * - parent_package_id is lineage metadata only; does not grant prior access.
 * - MCP access returns only ACTIVE packages with active non-revoked/non-expired members.
 * - Owner views CAN show revoked/history where MCP access must hide them.
 * - Revocation cascades: package token + members + child grants + refresh tokens.
 * - Partial-failure reporting is preserved.
 * - Postgres/SQLite store parity.
 */

import { randomBytes } from "node:crypto";
import { allowUnboundedReadAcknowledged, exec, getOne, referenceQueries } from "../lib/db.ts";
import { createTraceContext, emitSpineEvent, type SpineEventInput, type SpineTraceContext } from "../lib/spine.ts";
import { listActiveBindingsForGrant, projectBindingForWire } from "./connection-identity.js";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.js";

// ---------------------------------------------------------------------------
// Local pure utilities (no auth.js dep needed for these)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function generateId(prefix = "id"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parsePackageJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Postgres dialect shims (mirror the wrappers defined in auth.js)
// ---------------------------------------------------------------------------

async function pgOne(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | null> {
  const result = await postgresQuery(sql, params);
  return (result.rows[0] as Record<string, unknown>) ?? null;
}

async function pgExec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  const result = await postgresQuery(sql, params);
  return { changes: (result.rowCount as number | null) ?? 0 };
}

function requireReferenceQuery<K extends keyof typeof referenceQueries>(name: K): (typeof referenceQueries)[K] {
  const query = referenceQueries[name];
  if (!query || typeof query.sql !== "string" || query.sql.length === 0) {
    throw new Error(`Missing SQLite reference query: ${String(name)}`);
  }
  return query;
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface MemberRow extends Record<string, unknown> {
  readonly added_at: string;
  readonly grant_id: string;
  readonly grant_json?: string | null;
  readonly grant_status?: string;
  readonly member_revoked_at?: string | null;
  readonly member_status?: string;
  readonly package_id: string;
  readonly revoked_at: string | null;
  readonly source_json: string | null;
  readonly status: string;
  readonly storage_binding_json?: string | null;
  readonly token_expires_at?: string | null;
  readonly token_id: string;
  readonly token_revoked?: boolean | number | null;
}

// ---------------------------------------------------------------------------
// Public output types (consumed by routes and index.js)
// ---------------------------------------------------------------------------

/** Normalized grant_packages row returned by owner/MCP views. */
export interface NormalizedPackage {
  readonly approved_at: string | null;
  readonly client_id: string;
  readonly created_at: string;
  readonly package: Record<string, unknown> | null;
  readonly package_id: string;
  readonly parent_package_id: string | null;
  readonly revoked_at: string | null;
  readonly scenario_id: string | null;
  readonly status: string;
  readonly subject_id: string;
  readonly trace_id: string | null;
}

/** One active member in a package access result (MCP fan-out path). */
export interface PackageAccessMember {
  readonly connection_id: string | null;
  readonly grant: Record<string, unknown>;
  readonly grant_id: string;
  readonly grant_storage_binding: { readonly connector_id: string } | null;
  readonly package_id: string;
  readonly source: Record<string, unknown> | null;
  readonly token: string;
}

/** Result of getGrantPackageAccess (MCP fan-out). */
export interface GrantPackageAccess {
  readonly members: readonly PackageAccessMember[];
  readonly package: NormalizedPackage;
}

/** One child entry in an owner detail view. */
export interface PackageChildEntry {
  readonly added_at: string;
  readonly grant_id: string;
  readonly grant_status: string;
  readonly member_status: string;
  readonly revoked_at: string | null;
  readonly source: Record<string, unknown> | null;
}

/** Owner detail view of a grant package (includes all members). */
export interface GrantPackageSummaryRow extends NormalizedPackage {
  readonly children: readonly PackageChildEntry[];
  readonly member_count: number;
}

/** One entry in the owner list page. */
export interface GrantPackageListEntry extends NormalizedPackage {
  readonly member_count: number;
}

/** Paginated owner list result. */
export interface GrantPackageListPage {
  readonly data: readonly GrantPackageListEntry[];
  readonly has_more: boolean;
  readonly limit: number;
  readonly next_cursor: string | null;
}

/** Cumulative per-client access across a linked package lineage. */
export interface CumulativeClientAccess {
  readonly active_child_count: number;
  readonly children: readonly (PackageChildEntry & { readonly package_id: string })[];
  readonly client_id: string;
  readonly package_count: number;
  readonly packages: readonly {
    readonly package_id: string;
    readonly parent_package_id: string | null;
    readonly status: string;
    readonly created_at: string;
    readonly approved_at: string | null;
    readonly revoked_at: string | null;
    readonly member_count: number;
  }[];
  readonly root_package_id: string;
  readonly subject_id: string;
}

/** Result of revokeGrantPackage. */
export interface GrantPackageRevokeResult {
  readonly not_revoked_child_grants: readonly {
    readonly grant_id: string;
    readonly error: { readonly code: string; readonly message: string };
  }[];
  readonly package_id: string;
  readonly revoked_at: string | null;
  readonly revoked_child_grants: readonly string[];
  readonly status: "revoked" | "partial_failure";
}

/** Return shape of createHostedMcpGrantPackage. */
export interface PackageGrantResult {
  readonly child_grants: readonly {
    readonly grant: Record<string, unknown>;
    readonly token: string;
    readonly source: Record<string, unknown> | null;
    readonly connection_id: string | null;
  }[];
  readonly package: Record<string, unknown>;
  readonly package_id: string;
  readonly token: string;
  readonly trace_context: SpineTraceContext;
}

/** Return shape of requireValidParentPackageLinkage. */
export interface ValidParentPackage extends NormalizedPackage {}

// ---------------------------------------------------------------------------
// External dependency types (injected from auth.js — no import-back)
// ---------------------------------------------------------------------------

interface SourceBinding {
  readonly id: string;
  readonly kind: "connector" | "provider_native";
}

interface StorageBinding {
  readonly connector_id: string;
}

interface RegisteredClient {
  readonly client_id: string;
  readonly metadata: Record<string, unknown>;
  readonly registration_mode: string;
}

interface PendingRequest {
  authorization_details?: unknown[];
  client?: Record<string, unknown>;
  client_id?: string;
  manifest_version?: string;
  selection?: Record<string, unknown>;
  source_binding?: { kind: string; id: string } | null;
  storage_binding?: StorageBinding | null;
  trace_context?: SpineTraceContext;
  [key: string]: unknown;
}

interface GrantManifest {
  readonly version: string;
  [key: string]: unknown;
}

interface PersistedGrantState {
  readonly grant: Record<string, unknown>;
  readonly sourceBinding: SourceBinding;
  readonly storageBinding: StorageBinding | null;
}

interface PersistGrantArgs {
  readonly accessMode: string;
  readonly clientId: string;
  readonly expiresAt: string | null;
  readonly grantId: string;
  readonly grantJson: string;
  readonly issuedAt: string;
  readonly scenarioId: string | null;
  readonly storageBindingJson: string | null;
  readonly subjectId: string;
  readonly traceId: string | null;
}

/**
 * External dependencies that auth.js injects. The module never imports auth.js;
 * auth.js calls createGrantPackageLifecycle once and re-exports the bound methods.
 */
export interface GrantPackageLifecycleDeps {
  /** Build the client display object from registration metadata. */
  readonly buildClientDisplayFromRegistration: (metadata: Record<string, unknown>) => Record<string, unknown> | null;
  /** Build an OAuth error with a code property. */
  readonly buildOAuthAuthorizationCodeError: (code: string, message: string) => Error & { code: string };
  /** Extract the source binding descriptor from a grant object. */
  readonly describeGrantSource: (grant: Record<string, unknown>) => { kind: string; id: string } | null;
  /** Describe a source binding as a {kind, id} object, or null. */
  readonly describeSourceBinding: (sourceBinding: unknown) => { kind: string; id: string } | null;
  /** Generic child-grant issuer (stays in auth.js — used by non-package paths too). */
  readonly issueToken: (
    grantId: string,
    subjectId: string,
    clientId: string,
    expiresAt: string | null,
    meta?: Record<string, unknown>
  ) => Promise<string>;
  /** Normalize a raw grant-init payload into a structured pending request. */
  readonly normalizePendingGrantRequest: (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>
  ) => PendingRequest;
  /** Normalize a raw storage binding, returning null if invalid. */
  readonly normalizeStorageBinding: (storageBinding: unknown) => StorageBinding | null;
  /** Generic grants-row persistence; owned by auth.js/generic grant issuance. */
  readonly persistGrant: (args: PersistGrantArgs) => Promise<unknown>;
  /** Resolve the connector manifest for a binding pair. */
  readonly requireGrantManifestForBindings: (
    sourceBinding: SourceBinding,
    storageBinding: StorageBinding | null,
    opts?: Record<string, unknown>
  ) => Promise<GrantManifest>;
  /** Validate and resolve client registration against the pending request. */
  readonly requirePendingRequestClientRegistration: (
    request: PendingRequest,
    opts?: Record<string, unknown>
  ) => Promise<RegisteredClient>;
  /** Parse persisted grant JSON + storage-binding JSON into structured state. */
  readonly requirePersistedGrantState: (row: Record<string, unknown>) => PersistedGrantState;
  /** Validate and return structured source + storage bindings. */
  readonly requireStructuredPendingRequestBindings: (request: PendingRequest) => {
    sourceBinding: SourceBinding;
    storageBinding: StorageBinding | null;
  };
  /** Validate the pending request structure (throws on failure). */
  readonly requireStructuredPendingRequestShape: (request: PendingRequest) => void;
  /** Resolve selected streams from the manifest. */
  readonly resolveGrantSelection: (
    selection: Record<string, unknown>,
    manifest: GrantManifest
  ) => readonly Record<string, unknown>[];
  /** Resolve a registered OAuth client. */
  readonly resolveOAuthClient: (clientId: string, opts?: Record<string, unknown>) => Promise<RegisteredClient | null>;
  /** Generic grant revoker (stays in auth.js). */
  readonly revokeGrant: (grantId: string, context?: Record<string, unknown>) => Promise<void>;
  /** Serialize a storage binding to JSON string or null. */
  readonly serializeStorageBinding: (storageBinding: StorageBinding | null) => string | null;
}

/** The bound lifecycle methods returned from createGrantPackageLifecycle. */
export interface GrantPackageLifecycle {
  readonly createHostedMcpGrantPackage: (args: {
    clientId: string;
    authorizationDetails: unknown[];
    storageBindings?: Array<{ connector_id: string }>;
    connectionIds?: Array<string | null>;
    sourceMetadata?: Record<string, unknown>[];
    subjectId?: string;
    opts?: Record<string, unknown>;
  }) => Promise<PackageGrantResult>;
  readonly getCumulativeClientAccessForPackage: (packageId: string) => Promise<CumulativeClientAccess | null>;
  readonly getGrantPackageAccess: (packageId: string) => Promise<GrantPackageAccess | null>;
  readonly getGrantPackageForOwner: (packageId: string) => Promise<GrantPackageSummaryRow | null>;
  readonly getGrantPackageIdForGrant: (grantId: string) => Promise<string | null>;
  /**
   * Issue a package-scoped access token and record a token.issued spine event.
   * Kept on the lifecycle so auth.js (OAuth refresh path) doesn't own a copy.
   */
  readonly issuePackageToken: (
    packageId: string,
    subjectId: string,
    clientId: string,
    expiresAt: string | null,
    meta?: Record<string, unknown>
  ) => Promise<string>;
  readonly listActivePackageIdsForClient: (clientId: string) => Promise<readonly string[]>;
  readonly listGrantPackagesForOwner: (opts?: {
    limit?: number;
    cursor?: string | null;
  }) => Promise<GrantPackageListPage>;
  /**
   * Persist the rows for a staged-batch-consent package (package + child grants
   * + members + package token). Called by the staged-approval path in auth.js
   * after it has resolved bindings, narrowed streams, and built the package
   * envelope — the module owns the DB writes and token issuance so the helpers
   * don't live in two places.
   */
  readonly persistStagedBatchPackage: (args: {
    packageId: string;
    subjectId: string;
    registeredClient: { client_id: string; registration_mode: string };
    packageEnvelope: Record<string, unknown>;
    parentPackageId: string | null;
    traceContext: SpineTraceContext;
    createdAt: string;
    resolvedEntries: ReadonlyArray<{
      slice: Record<string, unknown>;
      sourceBinding: { kind: string; id: string };
      storageBinding: { connector_id: string } | null;
      manifest: { version: string };
      resolvedStreams: readonly Record<string, unknown>[];
    }>;
  }) => Promise<{
    childGrants: Array<{
      grant: Record<string, unknown>;
      token: string;
      source: Record<string, unknown> | null;
    }>;
    packageToken: string;
  }>;
  /**
   * Validate a parent_package_id before linking a new package to it.
   * Used by the staged-consent approval path in auth.js (stays there; calls
   * this from the lifecycle so auth.js stops owning the lineage invariant).
   */
  readonly requireValidParentPackageLinkage: (
    parentPackageId: string | null | undefined,
    opts?: { clientId?: string; subjectId?: string }
  ) => Promise<NormalizedPackage | null>;
  readonly revokeGrantPackage: (
    packageId: string,
    context?: Record<string, unknown>
  ) => Promise<GrantPackageRevokeResult>;
}

// ---------------------------------------------------------------------------
// Internal grant-package row store (dialect-isolated, not exported)
// ---------------------------------------------------------------------------

interface GrantPackageStore {
  getPackageById(packageId: string): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  getPackageIdForGrant(grantId: string): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  insertPackage(args: {
    packageId: string;
    subjectId: string;
    clientId: string;
    packageJson: string;
    parentPackageId: string | null;
    traceId: string;
    scenarioId: string;
    createdAt: string;
    approvedAt: string;
  }): Promise<{ changes: number }> | { changes: number };
  insertPackageMember(args: {
    packageId: string;
    grantId: string;
    tokenId: string;
    sourceJson: string;
    addedAt: string;
  }): Promise<{ changes: number }> | { changes: number };
  insertPackageToken(args: {
    tokenId: string;
    packageId: string;
    subjectId: string;
    clientId: string;
    expiresAt: string | null;
  }): Promise<{ changes: number }> | { changes: number };
  listActiveMembers(packageId: string): Promise<readonly MemberRow[]> | readonly MemberRow[];
  listAllMembers(packageId: string): Promise<readonly MemberRow[]> | readonly MemberRow[];
  markMemberRevoked(args: {
    packageId: string;
    grantId: string;
    revokedAt: string;
  }): Promise<{ changes: number }> | { changes: number };
  markPackageRevokedCascade(args: { packageId: string; revokedAt: string }): Promise<void> | void;
}

const postgresGrantPackageStore: GrantPackageStore = {
  insertPackageToken: ({
    tokenId,
    packageId,
    subjectId,
    clientId,
    expiresAt,
  }: {
    tokenId: string;
    packageId: string;
    subjectId: string;
    clientId: string;
    expiresAt: string | null;
  }): Promise<{ changes: number }> =>
    pgExec(
      `INSERT INTO tokens(token_id, grant_id, package_id, subject_id, client_id, token_kind, expires_at)
       VALUES($1, NULL, $2, $3, $4, 'mcp_package', $5)`,
      [tokenId, packageId, subjectId, clientId, expiresAt]
    ),

  getPackageById: (packageId: string): Promise<Record<string, unknown> | null> =>
    pgOne(
      `SELECT package_id, subject_id, client_id, status, package_json::text AS package_json,
              parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
         FROM grant_packages
         WHERE package_id = $1`,
      [packageId]
    ),

  insertPackage: ({
    packageId,
    subjectId,
    clientId,
    packageJson,
    parentPackageId,
    traceId,
    scenarioId,
    createdAt,
    approvedAt,
  }: {
    packageId: string;
    subjectId: string;
    clientId: string;
    packageJson: string;
    parentPackageId: string | null;
    traceId: string;
    scenarioId: string;
    createdAt: string;
    approvedAt: string;
  }): Promise<{ changes: number }> =>
    pgExec(
      `INSERT INTO grant_packages(
         package_id, subject_id, client_id, status, package_json,
         parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
       ) VALUES($1, $2, $3, 'active', $4::jsonb, $5, $6, $7, $8, $9, NULL)`,
      [packageId, subjectId, clientId, packageJson, parentPackageId, traceId, scenarioId, createdAt, approvedAt]
    ),

  insertPackageMember: ({
    packageId,
    grantId,
    tokenId,
    sourceJson,
    addedAt,
  }: {
    packageId: string;
    grantId: string;
    tokenId: string;
    sourceJson: string;
    addedAt: string;
  }): Promise<{ changes: number }> =>
    pgExec(
      `INSERT INTO grant_package_members(
         package_id, grant_id, token_id, source_json, status, added_at, revoked_at
       ) VALUES($1, $2, $3, $4::jsonb, 'active', $5, NULL)`,
      [packageId, grantId, tokenId, sourceJson, addedAt]
    ),

  listActiveMembers: async (packageId: string): Promise<MemberRow[]> =>
    (
      await postgresQuery(
        `SELECT gm.package_id, gm.grant_id, gm.token_id, gm.source_json::text AS source_json,
                gm.status, gm.added_at, gm.revoked_at,
                g.status AS grant_status, g.grant_json::text AS grant_json,
                g.storage_binding_json::text AS storage_binding_json,
                t.revoked AS token_revoked, t.expires_at AS token_expires_at
         FROM grant_package_members gm
         JOIN grants g ON gm.grant_id = g.grant_id
         JOIN tokens t ON gm.token_id = t.token_id
         WHERE gm.package_id = $1
           AND gm.status = 'active'
         ORDER BY gm.added_at, gm.grant_id`,
        [packageId]
      )
    ).rows as MemberRow[],

  listAllMembers: async (packageId: string): Promise<MemberRow[]> =>
    (
      await postgresQuery(
        `SELECT gm.package_id, gm.grant_id, gm.source_json::text AS source_json,
                gm.status AS member_status, gm.added_at, gm.revoked_at AS member_revoked_at,
                g.status AS grant_status
           FROM grant_package_members gm
           JOIN grants g ON gm.grant_id = g.grant_id
           WHERE gm.package_id = $1
           ORDER BY gm.added_at, gm.grant_id`,
        [packageId]
      )
    ).rows as MemberRow[],

  getPackageIdForGrant: (grantId: string): Promise<Record<string, unknown> | null> =>
    pgOne(
      `SELECT package_id
         FROM grant_package_members
         WHERE grant_id = $1
         ORDER BY added_at
         LIMIT 1`,
      [grantId]
    ),

  markMemberRevoked: ({
    packageId,
    grantId,
    revokedAt,
  }: {
    packageId: string;
    grantId: string;
    revokedAt: string;
  }): Promise<{ changes: number }> =>
    pgExec(
      `UPDATE grant_package_members
       SET status = 'revoked', revoked_at = $1
       WHERE package_id = $2 AND grant_id = $3 AND status = 'active'`,
      [revokedAt, packageId, grantId]
    ),

  markPackageRevokedCascade: async ({
    packageId,
    revokedAt,
  }: {
    packageId: string;
    revokedAt: string;
  }): Promise<void> => {
    await pgExec(
      "UPDATE grant_packages SET status = 'revoked', revoked_at = $1 WHERE package_id = $2 AND status = 'active'",
      [revokedAt, packageId]
    );
    await pgExec("UPDATE tokens SET revoked = TRUE WHERE package_id = $1", [packageId]);
    await pgExec(
      "UPDATE grant_package_members SET status = 'revoked', revoked_at = $1 WHERE package_id = $2 AND status = 'active'",
      [revokedAt, packageId]
    );
    await pgExec(
      "UPDATE oauth_refresh_tokens SET status = 'revoked', revoked_at = $1 WHERE package_id = $2 AND status = 'active'",
      [revokedAt, packageId]
    );
  },
};

const sqliteGrantPackageStore: GrantPackageStore = {
  insertPackageToken: ({
    tokenId,
    packageId,
    subjectId,
    clientId,
    expiresAt,
  }: {
    tokenId: string;
    packageId: string;
    subjectId: string;
    clientId: string;
    expiresAt: string | null;
  }) => exec(requireReferenceQuery("authTokensInsertMcpPackage"), [tokenId, packageId, subjectId, clientId, expiresAt]),

  getPackageById: (packageId: string) =>
    getOne<Record<string, unknown>>(requireReferenceQuery("authGrantPackagesGetById"), [packageId]),

  insertPackage: ({
    packageId,
    subjectId,
    clientId,
    packageJson,
    parentPackageId,
    traceId,
    scenarioId,
    createdAt,
    approvedAt,
  }: {
    packageId: string;
    subjectId: string;
    clientId: string;
    packageJson: string;
    parentPackageId: string | null;
    traceId: string;
    scenarioId: string;
    createdAt: string;
    approvedAt: string;
  }) =>
    exec(requireReferenceQuery("authGrantPackagesInsert"), [
      packageId,
      subjectId,
      clientId,
      packageJson,
      parentPackageId,
      traceId,
      scenarioId,
      createdAt,
      approvedAt,
    ]),

  insertPackageMember: ({
    packageId,
    grantId,
    tokenId,
    sourceJson,
    addedAt,
  }: {
    packageId: string;
    grantId: string;
    tokenId: string;
    sourceJson: string;
    addedAt: string;
  }) =>
    exec(requireReferenceQuery("authGrantPackageMembersInsert"), [packageId, grantId, tokenId, sourceJson, addedAt]),

  listActiveMembers: (packageId: string): readonly MemberRow[] =>
    allowUnboundedReadAcknowledged<MemberRow>(requireReferenceQuery("authGrantPackageMembersListActiveByPackage"), [
      packageId,
    ]),

  listAllMembers: (packageId: string): readonly MemberRow[] =>
    allowUnboundedReadAcknowledged<MemberRow>(requireReferenceQuery("authGrantPackageMembersListAllByPackage"), [
      packageId,
    ]),

  getPackageIdForGrant: (grantId: string) =>
    getOne<Record<string, unknown>>(requireReferenceQuery("authGrantPackageMembersGetPackageIdByGrant"), [grantId]),

  markMemberRevoked: ({ packageId, grantId, revokedAt }: { packageId: string; grantId: string; revokedAt: string }) =>
    exec(requireReferenceQuery("authGrantPackageMembersMarkRevokedByGrant"), [revokedAt, packageId, grantId]),

  markPackageRevokedCascade: ({ packageId, revokedAt }: { packageId: string; revokedAt: string }): void => {
    exec(requireReferenceQuery("authGrantPackagesMarkRevoked"), [revokedAt, packageId]);
    exec(requireReferenceQuery("authTokensRevokeByPackage"), [packageId]);
    exec(requireReferenceQuery("authGrantPackageMembersMarkRevokedByPackage"), [revokedAt, packageId]);
    exec(requireReferenceQuery("authOauthRefreshTokensRevokeByPackage"), [revokedAt, packageId]);
  },
};

function getGrantPackageStore(): GrantPackageStore {
  return isPostgresStorageBackend() ? postgresGrantPackageStore : sqliteGrantPackageStore;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizePackageRow(row: Record<string, unknown> | null): NormalizedPackage | null {
  if (!row) {
    return null;
  }
  return {
    package_id: row.package_id as string,
    subject_id: row.subject_id as string,
    client_id: row.client_id as string,
    status: row.status as string,
    package: parsePackageJson(row.package_json),
    parent_package_id: (row.parent_package_id as string | null) ?? null,
    trace_id: (row.trace_id as string | null) ?? null,
    scenario_id: (row.scenario_id as string | null) ?? null,
    created_at: row.created_at as string,
    approved_at: (row.approved_at as string | null) ?? null,
    revoked_at: (row.revoked_at as string | null) ?? null,
  };
}

async function getGrantPackageRow(packageId: string): Promise<NormalizedPackage | null> {
  if (!isNonEmptyString(packageId)) {
    return null;
  }
  const row = await getGrantPackageStore().getPackageById(packageId);
  return normalizePackageRow(row as Record<string, unknown> | null);
}

function encodeGrantPackageCursor(row: { created_at: string; package_id: string }): string {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, package_id: row.package_id }), "utf8").toString(
    "base64url"
  );
}

function decodeGrantPackageCursor(
  cursor: string | null | undefined
): { created_at: string; package_id: string } | null {
  if (!isNonEmptyString(cursor)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      decoded !== null &&
      typeof decoded === "object" &&
      isNonEmptyString((decoded as Record<string, unknown>).created_at) &&
      isNonEmptyString((decoded as Record<string, unknown>).package_id)
    ) {
      return {
        created_at: (decoded as Record<string, unknown>).created_at as string,
        package_id: (decoded as Record<string, unknown>).package_id as string,
      };
    }
  } catch {
    // fall through
  }
  const err = Object.assign(new Error("Invalid grant package cursor"), { code: "invalid_cursor" });
  throw err;
}

function normalizePackageRevokeError(
  grantId: string,
  err: unknown
): { grant_id: string; error: { code: string; message: string } } {
  const e = err as Record<string, unknown>;
  const code = isNonEmptyString(e?.code) ? (e.code as string) : "revoke_failed";
  const message = isNonEmptyString(e?.message) ? (e.message as string) : "Child grant revoke failed";
  return { grant_id: grantId, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Factory — creates bound lifecycle methods; call once from auth.js
// ---------------------------------------------------------------------------

/**
 * Create the grant-package lifecycle object. Auth.js calls this once at
 * module load time, passing auth-internal helpers as dependencies. The
 * returned methods are re-exported from auth.js so existing route consumers
 * keep working without any import changes.
 */
export function createGrantPackageLifecycle(deps: GrantPackageLifecycleDeps): GrantPackageLifecycle {
  const {
    persistGrant,
    issueToken,
    revokeGrant,
    resolveOAuthClient,
    normalizePendingGrantRequest,
    requireStructuredPendingRequestShape,
    requirePendingRequestClientRegistration,
    requireStructuredPendingRequestBindings,
    requireGrantManifestForBindings,
    resolveGrantSelection,
    buildClientDisplayFromRegistration,
    describeSourceBinding,
    normalizeStorageBinding,
    serializeStorageBinding,
    describeGrantSource,
    requirePersistedGrantState,
    buildOAuthAuthorizationCodeError,
  } = deps;

  // -------------------------------------------------------------------------
  // Internal helpers that use injected deps
  // -------------------------------------------------------------------------

  async function issuePackageToken(
    packageId: string,
    subjectId: string,
    clientId: string,
    expiresAt: string | null = null,
    meta: Record<string, unknown> = {}
  ): Promise<string> {
    const tokenId = generateId("tok");
    await getGrantPackageStore().insertPackageToken({
      tokenId,
      packageId,
      subjectId,
      clientId,
      expiresAt,
    });

    const traceContext = meta.traceContext as SpineTraceContext | undefined;
    await emitSpineEvent({
      event_type: "token.issued",
      trace_id: traceContext?.trace_id ?? null,
      scenario_id: traceContext?.scenario_id ?? null,
      request_id: traceContext?.request_id ?? null,
      actor_type: "authorization_server",
      actor_id: "pdpp_as",
      subject_type: "subject",
      subject_id: subjectId,
      object_type: "token",
      object_id: tokenId,
      status: "succeeded",
      client_id: clientId,
      token_id: tokenId,
      data: {
        token_kind: "mcp_package",
        grant_package_id: packageId,
        issuance_path: (meta.source as string | undefined) ?? "hosted_mcp_package",
      },
    } satisfies SpineEventInput);

    return tokenId;
  }

  async function requireValidParentPackageLinkage(
    parentPackageId: string | null | undefined,
    { clientId, subjectId }: { clientId?: string; subjectId?: string } = {}
  ): Promise<NormalizedPackage | null> {
    if (parentPackageId === undefined || parentPackageId === null) {
      return null;
    }
    const linkageError = (message: string): Error & { code: string; param: string } =>
      Object.assign(new Error(message), {
        code: "invalid_request",
        param: "parent_package_id",
      });
    if (!isNonEmptyString(parentPackageId)) {
      throw linkageError("parent_package_id must be a non-empty string");
    }
    const parent = await getGrantPackageRow(parentPackageId);
    if (!parent) {
      throw linkageError(`parent_package_id ${parentPackageId} does not exist`);
    }
    if (isNonEmptyString(clientId) && parent.client_id !== clientId) {
      throw linkageError("parent_package_id belongs to a different client; cross-client lineage is not allowed");
    }
    if (isNonEmptyString(subjectId) && parent.subject_id !== subjectId) {
      throw linkageError("parent_package_id belongs to a different owner; cross-owner lineage is not allowed");
    }
    if (parent.status !== "active") {
      throw linkageError(
        `parent_package_id ${parentPackageId} is ${parent.status}; cannot link to an inactive package`
      );
    }
    return parent;
  }

  function describePackageMemberSource(
    grant: Record<string, unknown>,
    connectionId: string | null = null,
    metadata: Record<string, unknown> | null = null
  ): Record<string, unknown> | null {
    const source = describeGrantSource(grant);
    if (!source) {
      return null;
    }
    return {
      ...source,
      ...(isNonEmptyString(connectionId) ? { connection_id: connectionId } : {}),
      ...(metadata?.display_name ? { display_name: metadata.display_name } : {}),
      ...(metadata?.connector_display_name ? { connector_display_name: metadata.connector_display_name } : {}),
    };
  }

  function applyPendingRequestStorageBinding(request: PendingRequest, rawStorageBinding: unknown): void {
    const selectedStorageBinding = normalizeStorageBinding(rawStorageBinding);
    if (selectedStorageBinding) {
      request.storage_binding = selectedStorageBinding;
    }
  }

  function isRawConnectionDisplayName(source: Record<string, unknown> | null): boolean {
    return isNonEmptyString(source?.connection_id) && source?.display_name === source?.connection_id;
  }

  async function normalizePersistedPackageMemberSource(
    source: Record<string, unknown> | null,
    { ownerSubjectId = null }: { ownerSubjectId?: string | null } = {}
  ): Promise<Record<string, unknown> | null> {
    if (!source || typeof source !== "object") {
      return source;
    }
    if (!isRawConnectionDisplayName(source)) {
      return source;
    }

    const sanitized = { ...source };
    const connectorId = isNonEmptyString(sanitized.id) ? (sanitized.id as string) : null;
    if (isNonEmptyString(ownerSubjectId) && connectorId) {
      const active = await listActiveBindingsForGrant({
        ownerSubjectId,
        connectorId,
      }).catch(() => []);
      const binding =
        (active as Record<string, unknown>[]).find((row) => row.connectorInstanceId === sanitized.connection_id) ??
        null;
      const displayName =
        (projectBindingForWire(binding as never) as Record<string, unknown> | null)?.display_name ?? null;
      if (displayName) {
        sanitized.display_name = displayName;
        return sanitized;
      }
    }

    sanitized.display_name = undefined;
    return sanitized;
  }

  async function persistChildGrantForPackage({
    request,
    registeredClient,
    subjectId,
    sourceBinding,
    storageBinding,
    manifest,
    resolvedStreams,
    traceContext,
  }: {
    request: PendingRequest;
    registeredClient: RegisteredClient;
    subjectId: string;
    sourceBinding: SourceBinding;
    storageBinding: StorageBinding | null;
    manifest: GrantManifest;
    resolvedStreams: readonly Record<string, unknown>[];
    traceContext: SpineTraceContext;
  }): Promise<{ grant: Record<string, unknown>; token: string; expiresAt: string | null }> {
    const selection = request.selection as Record<string, unknown>;
    const client = (request.client as Record<string, unknown> | undefined) ?? {};

    if (selection.purpose_code === "https://pdpp.org/purpose/ai_training") {
      throw Object.assign(new Error("Hosted MCP package consent does not cover ai_training"), {
        code: "invalid_request",
        param: "purpose_code",
      });
    }

    const grantId = generateId("grt");
    const issuedAt = nowIso();
    const expiresAt =
      selection.access_mode === "single_use" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;

    const persistedSource = describeSourceBinding(sourceBinding);
    const persistedStorageBinding = normalizeStorageBinding(storageBinding);

    const grant: Record<string, unknown> = {
      version: "0.1.0",
      grant_id: grantId,
      issued_at: issuedAt,
      subject: { id: subjectId },
      client: {
        client_id: registeredClient.client_id,
        registration_mode: registeredClient.registration_mode || "pre_registered_public",
        ...(client.client_display ? { client_display: client.client_display } : {}),
      },
      source: persistedSource,
      manifest_version: manifest.version,
      purpose_code: selection.purpose_code,
      purpose_description: selection.purpose_description,
      access_mode: selection.access_mode,
      streams: resolvedStreams,
      retention: selection.retention,
      expires_at: expiresAt,
    };

    await persistGrant({
      grantId,
      subjectId,
      clientId: registeredClient.client_id,
      storageBindingJson: serializeStorageBinding(persistedStorageBinding),
      grantJson: JSON.stringify(grant),
      accessMode: selection.access_mode as string,
      issuedAt,
      expiresAt,
      traceId: traceContext.trace_id,
      scenarioId: traceContext.scenario_id,
    });

    await emitSpineEvent({
      event_type: "grant.issued",
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      request_id: traceContext.request_id,
      actor_type: "authorization_server",
      actor_id: "pdpp_as",
      subject_type: "subject",
      subject_id: subjectId,
      object_type: "grant",
      object_id: grantId,
      status: "succeeded",
      grant_id: grantId,
      client_id: registeredClient.client_id,
      data: {
        source: describeGrantSource(grant),
        access_mode: selection.access_mode,
        purpose_code: selection.purpose_code,
        stream_names: resolvedStreams.map((stream) => stream.name),
        retention: (selection.retention as unknown) ?? null,
      },
    } satisfies SpineEventInput);

    const token = await issueToken(grantId, subjectId, registeredClient.client_id, expiresAt, {
      traceContext,
      source: "hosted_mcp_package_child",
    });

    return { grant, token, expiresAt };
  }

  // -------------------------------------------------------------------------
  // Publicly bound lifecycle methods
  // -------------------------------------------------------------------------

  async function createHostedMcpGrantPackage({
    clientId,
    authorizationDetails,
    storageBindings = [],
    connectionIds = [],
    sourceMetadata = [],
    subjectId = "owner_local",
    opts = {},
  }: {
    clientId: string;
    authorizationDetails: unknown[];
    storageBindings?: Array<{ connector_id: string }>;
    connectionIds?: Array<string | null>;
    sourceMetadata?: Record<string, unknown>[];
    subjectId?: string;
    opts?: Record<string, unknown>;
  }): Promise<PackageGrantResult> {
    if (!isNonEmptyString(clientId)) {
      throw buildOAuthAuthorizationCodeError("invalid_request", "client_id is required");
    }
    if (!Array.isArray(authorizationDetails) || authorizationDetails.length === 0) {
      throw buildOAuthAuthorizationCodeError("invalid_request", "At least one source must be selected");
    }

    const registeredClient = await resolveOAuthClient(clientId, opts);
    if (!registeredClient) {
      throw buildOAuthAuthorizationCodeError("invalid_client", "Unknown client_id");
    }

    const packageId = generateId("gpkg");
    const scenarioIdVal = opts.scenarioId;
    const traceContext =
      typeof scenarioIdVal === "string" ? createTraceContext({ scenarioId: scenarioIdVal }) : createTraceContext();
    const createdAt = nowIso();
    const packageEnvelope: Record<string, unknown> = {
      version: "reference.mcp_package.v1",
      package_id: packageId,
      subject: { id: subjectId },
      client: {
        client_id: clientId,
        registration_mode: registeredClient.registration_mode || "pre_registered_public",
        client_display: buildClientDisplayFromRegistration(registeredClient.metadata),
      },
      approved_source_count: authorizationDetails.length,
      source_bounded_child_grants: true,
    };

    await getGrantPackageStore().insertPackage({
      packageId,
      subjectId,
      clientId,
      packageJson: JSON.stringify(packageEnvelope),
      parentPackageId: null,
      traceId: traceContext.trace_id,
      scenarioId: traceContext.scenario_id,
      createdAt,
      approvedAt: createdAt,
    });

    const childGrants: Array<{
      grant: Record<string, unknown>;
      token: string;
      source: Record<string, unknown> | null;
      connection_id: string | null;
    }> = [];

    for (const [index, detail] of authorizationDetails.entries()) {
      const request = normalizePendingGrantRequest({ client_id: clientId, authorization_details: [detail] }, opts);
      applyPendingRequestStorageBinding(request, storageBindings[index] ?? null);
      requireStructuredPendingRequestShape(request);
      request.trace_context = traceContext;
      const childRegisteredClient = await requirePendingRequestClientRegistration(request, opts);
      const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request);
      request.source_binding = describeSourceBinding(sourceBinding);
      request.storage_binding = normalizeStorageBinding(storageBinding);
      const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
      request.manifest_version = manifest.version;
      const resolvedStreams = resolveGrantSelection(request.selection as Record<string, unknown>, manifest);
      const { grant, token } = await persistChildGrantForPackage({
        request,
        registeredClient: childRegisteredClient,
        subjectId,
        sourceBinding,
        storageBinding,
        manifest,
        resolvedStreams,
        traceContext,
      });
      const connectionId = isNonEmptyString(connectionIds[index] ?? null) ? (connectionIds[index] as string) : null;
      const source = describePackageMemberSource(
        grant,
        connectionId,
        (sourceMetadata[index] as Record<string, unknown> | undefined) ?? null
      );
      const addedAt = nowIso();
      await getGrantPackageStore().insertPackageMember({
        packageId,
        grantId: grant.grant_id as string,
        tokenId: token,
        sourceJson: JSON.stringify(source),
        addedAt,
      });
      childGrants.push({ grant, token, source, connection_id: connectionId });
    }

    const packageToken = await issuePackageToken(packageId, subjectId, clientId, null, {
      traceContext,
      source: "hosted_mcp_package",
    });

    await emitSpineEvent({
      event_type: "grant_package.issued",
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      request_id: traceContext.request_id,
      actor_type: "authorization_server",
      actor_id: "pdpp_as",
      subject_type: "subject",
      subject_id: subjectId,
      object_type: "grant_package",
      object_id: packageId,
      status: "succeeded",
      client_id: clientId,
      token_id: packageToken,
      data: {
        child_grant_ids: childGrants.map((entry) => entry.grant.grant_id),
        sources: childGrants.map((entry) => entry.source),
      },
    } satisfies SpineEventInput);

    return {
      package: {
        ...packageEnvelope,
        child_grants: childGrants.map((entry) => ({
          grant_id: entry.grant.grant_id,
          source: entry.source,
        })),
      },
      package_id: packageId,
      token: packageToken,
      child_grants: childGrants,
      trace_context: traceContext,
    };
  }

  async function getGrantPackageAccess(packageId: string): Promise<GrantPackageAccess | null> {
    if (!isNonEmptyString(packageId)) {
      return null;
    }
    const store = getGrantPackageStore();
    const packageRow = await store.getPackageById(packageId);
    const grantPackage = normalizePackageRow(packageRow as Record<string, unknown> | null);
    if (grantPackage?.status !== "active") {
      return null;
    }

    const memberRows = (await store.listActiveMembers(packageId)) as MemberRow[];

    const activeMembers: PackageAccessMember[] = [];
    for (const row of memberRows) {
      if (row.grant_status !== "active" || row.token_revoked) {
        continue;
      }
      if (row.token_expires_at && new Date(row.token_expires_at).getTime() <= Date.now()) {
        continue;
      }
      let grantState: PersistedGrantState;
      try {
        grantState = requirePersistedGrantState(row);
      } catch {
        continue;
      }
      const persistedSource = await normalizePersistedPackageMemberSource(
        parsePackageJson(row.source_json) ?? describeGrantSource(grantState.grant),
        { ownerSubjectId: grantPackage.subject_id }
      );
      activeMembers.push({
        package_id: packageId,
        grant_id: row.grant_id,
        token: row.token_id,
        source: persistedSource,
        grant: grantState.grant,
        grant_storage_binding: grantState.storageBinding,
        connection_id: (persistedSource?.connection_id as string | null) ?? null,
      });
    }

    return { package: grantPackage, members: activeMembers };
  }

  async function listGrantPackagesForOwner(
    opts: { limit?: number; cursor?: string | null } = {}
  ): Promise<GrantPackageListPage> {
    const limit = Number.isInteger(opts.limit) && (opts.limit ?? 0) > 0 ? (opts.limit as number) : 50;
    const cursor = decodeGrantPackageCursor(opts.cursor);
    let rows: Record<string, unknown>[];

    if (isPostgresStorageBackend()) {
      const params: unknown[] = [];
      let where = "";
      if (cursor) {
        params.push(cursor.created_at, cursor.package_id);
        where = "WHERE (gp.created_at < $1 OR (gp.created_at = $1 AND gp.package_id < $2))";
      }
      params.push(limit + 1);
      const limitPlaceholder = `$${params.length}`;
      rows = (
        await postgresQuery(
          `SELECT gp.package_id, gp.subject_id, gp.client_id, gp.status,
                  gp.parent_package_id, gp.trace_id, gp.scenario_id, gp.created_at, gp.approved_at, gp.revoked_at,
                  (SELECT COUNT(*) FROM grant_package_members gpm
                     WHERE gpm.package_id = gp.package_id) AS member_count
             FROM grant_packages gp
             ${where}
             ORDER BY gp.created_at DESC, gp.package_id DESC
             LIMIT ${limitPlaceholder}`,
          params
        )
      ).rows as Record<string, unknown>[];
    } else {
      const allRows = [
        ...allowUnboundedReadAcknowledged<Record<string, unknown>>(
          requireReferenceQuery("authGrantPackagesListAll"),
          []
        ),
      ];
      rows = cursor
        ? allRows.filter(
            (row) =>
              (row.created_at as string) < cursor.created_at ||
              ((row.created_at as string) === cursor.created_at && (row.package_id as string) < cursor.package_id)
          )
        : allRows;
      rows = rows.slice(0, limit + 1);
    }

    const normalized = rows
      .map((row) => {
        const pkg = normalizePackageRow(row);
        if (!pkg) {
          return null;
        }
        const memberCount = row.member_count === null || row.member_count === undefined ? 0 : Number(row.member_count);
        return {
          ...pkg,
          member_count: Number.isFinite(memberCount) ? memberCount : 0,
        };
      })
      .filter((row): row is GrantPackageListEntry => row !== null);

    const data = normalized.slice(0, limit);
    const hasMore = normalized.length > limit;
    const tail = hasMore ? (data.at(-1) ?? null) : null;
    return {
      data,
      has_more: hasMore,
      next_cursor: tail ? encodeGrantPackageCursor(tail) : null,
      limit,
    };
  }

  async function listActivePackageIdsForClient(clientId: string): Promise<string[]> {
    if (!isNonEmptyString(clientId)) {
      return [];
    }
    if (isPostgresStorageBackend()) {
      const rows = (
        await postgresQuery(
          `SELECT package_id
             FROM grant_packages
             WHERE client_id = $1 AND status = 'active'
             ORDER BY created_at ASC`,
          [clientId]
        )
      ).rows as Record<string, unknown>[];
      return rows.map((row) => row.package_id).filter((id): id is string => isNonEmptyString(id));
    }
    return allowUnboundedReadAcknowledged<Record<string, unknown>>(
      requireReferenceQuery("authGrantPackagesListAll"),
      []
    )
      .filter((row) => row.client_id === clientId && row.status === "active")
      .map((row) => row.package_id)
      .filter((id): id is string => isNonEmptyString(id));
  }

  async function getGrantPackageForOwner(packageId: string): Promise<GrantPackageSummaryRow | null> {
    if (!isNonEmptyString(packageId)) {
      return null;
    }
    const store = getGrantPackageStore();
    const packageRow = await store.getPackageById(packageId);
    const grantPackage = normalizePackageRow(packageRow as Record<string, unknown> | null);
    if (!grantPackage) {
      return null;
    }

    const memberRows = (await store.listAllMembers(packageId)) as MemberRow[];

    const children = await Promise.all(
      memberRows.map(async (row) => ({
        grant_id: row.grant_id,
        grant_status: (row.grant_status ?? "") as string,
        member_status: (row.member_status ?? "") as string,
        added_at: row.added_at,
        revoked_at: (row.member_revoked_at as string | null) ?? null,
        source: await normalizePersistedPackageMemberSource(parsePackageJson(row.source_json) ?? null, {
          ownerSubjectId: grantPackage.subject_id,
        }),
      }))
    );

    return {
      ...grantPackage,
      member_count: children.length,
      children,
    };
  }

  async function listGrantPackagesByParent(packageId: string): Promise<NormalizedPackage[]> {
    if (!isNonEmptyString(packageId)) {
      return [];
    }
    if (isPostgresStorageBackend()) {
      const rows = (
        await postgresQuery(
          `SELECT package_id, subject_id, client_id, status, package_json::text AS package_json,
                  parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
             FROM grant_packages
             WHERE parent_package_id = $1
             ORDER BY created_at, package_id`,
          [packageId]
        )
      ).rows as Record<string, unknown>[];
      return rows.map(normalizePackageRow).filter((p): p is NormalizedPackage => p !== null);
    }
    const rows = allowUnboundedReadAcknowledged<Record<string, unknown>>(
      requireReferenceQuery("authGrantPackagesListAll"),
      []
    );
    return rows
      .map(normalizePackageRow)
      .filter((pkg): pkg is NormalizedPackage => pkg !== null && pkg.parent_package_id === packageId);
  }

  async function findCumulativeAccessRoot(start: NormalizedPackage): Promise<NormalizedPackage> {
    const visitedUp = new Set<string>();
    let root = start;
    while (root.parent_package_id && !visitedUp.has(root.package_id)) {
      visitedUp.add(root.package_id);
      const parent = await getGrantPackageRow(root.parent_package_id);
      if (!parent) {
        break;
      }
      if (parent.client_id !== start.client_id || parent.subject_id !== start.subject_id) {
        break;
      }
      root = parent;
    }
    return root;
  }

  async function collectCumulativePackageLineageIds(root: NormalizedPackage): Promise<string[]> {
    const lineageIds: string[] = [];
    const seen = new Set<string>();
    const queue = [root.package_id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || seen.has(current)) {
        continue;
      }
      seen.add(current);
      lineageIds.push(current);
      const childPackages = await listGrantPackagesByParent(current);
      for (const child of childPackages) {
        if (child.client_id !== root.client_id || child.subject_id !== root.subject_id) {
          continue;
        }
        if (!seen.has(child.package_id)) {
          queue.push(child.package_id);
        }
      }
    }
    return lineageIds;
  }

  async function collectCumulativePackageDetails(lineageIds: readonly string[]): Promise<{
    cumulativeChildren: (PackageChildEntry & { package_id: string })[];
    packages: CumulativeClientAccess["packages"][number][];
  }> {
    const packages: CumulativeClientAccess["packages"][number][] = [];
    const cumulativeChildren: (PackageChildEntry & { package_id: string })[] = [];
    for (const id of lineageIds) {
      const detail = await getGrantPackageForOwner(id);
      if (!detail) {
        continue;
      }
      packages.push({
        package_id: detail.package_id,
        parent_package_id: detail.parent_package_id,
        status: detail.status,
        created_at: detail.created_at,
        approved_at: detail.approved_at,
        revoked_at: detail.revoked_at,
        member_count: detail.member_count,
      });
      for (const child of detail.children) {
        cumulativeChildren.push({ ...child, package_id: detail.package_id });
      }
    }
    return { cumulativeChildren, packages };
  }

  async function getCumulativeClientAccessForPackage(packageId: string): Promise<CumulativeClientAccess | null> {
    if (!isNonEmptyString(packageId)) {
      return null;
    }
    const start = await getGrantPackageRow(packageId);
    if (!start) {
      return null;
    }

    const root = await findCumulativeAccessRoot(start);

    const clientId = root.client_id;
    const subjectId = root.subject_id;
    const lineageIds = await collectCumulativePackageLineageIds(root);
    const { cumulativeChildren, packages } = await collectCumulativePackageDetails(lineageIds);

    const activeChildren = cumulativeChildren.filter(
      (child) => child.grant_status === "active" && child.member_status === "active"
    );

    return {
      client_id: clientId,
      subject_id: subjectId,
      root_package_id: root.package_id,
      package_count: packages.length,
      packages,
      children: cumulativeChildren,
      active_child_count: activeChildren.length,
    };
  }

  async function getGrantPackageIdForGrant(grantId: string): Promise<string | null> {
    if (!isNonEmptyString(grantId)) {
      return null;
    }
    const row = await getGrantPackageStore().getPackageIdForGrant(grantId);
    return ((row as Record<string, unknown> | null)?.package_id as string | null) ?? null;
  }

  async function revokeGrantPackage(
    packageId: string,
    context: Record<string, unknown> = {}
  ): Promise<GrantPackageRevokeResult> {
    const memberRows = await getGrantPackageStore().listActiveMembers(packageId);
    const activeMembers = memberRows as MemberRow[];
    const revokedChildGrants: string[] = [];
    const notRevokedChildGrants: GrantPackageRevokeResult["not_revoked_child_grants"][number][] = [];

    for (const member of activeMembers) {
      if (member.grant_status !== "active") {
        continue;
      }
      try {
        await revokeGrant(member.grant_id, context);
        const childRevokedAt = nowIso();
        await getGrantPackageStore().markMemberRevoked({
          packageId,
          grantId: member.grant_id,
          revokedAt: childRevokedAt,
        });
        revokedChildGrants.push(member.grant_id);
      } catch (err) {
        notRevokedChildGrants.push(normalizePackageRevokeError(member.grant_id, err));
      }
    }

    if (notRevokedChildGrants.length > 0) {
      await emitSpineEvent({
        event_type: "grant_package.revoke_partial",
        trace_id: (context.trace_id as string | undefined) ?? null,
        scenario_id: (context.scenario_id as string | undefined) ?? null,
        request_id: (context.request_id as string | undefined) ?? null,
        actor_type: "authorization_server",
        actor_id: "pdpp_as",
        object_type: "grant_package",
        object_id: packageId,
        status: "failed",
        data: {
          revoked_child_grants: revokedChildGrants,
          not_revoked_child_grants: notRevokedChildGrants,
        },
      } satisfies SpineEventInput);
      return {
        status: "partial_failure",
        package_id: packageId,
        revoked_at: null,
        revoked_child_grants: revokedChildGrants,
        not_revoked_child_grants: notRevokedChildGrants,
      };
    }

    const now = nowIso();
    await getGrantPackageStore().markPackageRevokedCascade({ packageId, revokedAt: now });

    await emitSpineEvent({
      event_type: "grant_package.revoked",
      trace_id: (context.trace_id as string | undefined) ?? null,
      scenario_id: (context.scenario_id as string | undefined) ?? null,
      request_id: (context.request_id as string | undefined) ?? null,
      actor_type: "authorization_server",
      actor_id: "pdpp_as",
      object_type: "grant_package",
      object_id: packageId,
      status: "succeeded",
      data: { revoked_child_grants: revokedChildGrants },
    } satisfies SpineEventInput);

    return {
      status: "revoked",
      package_id: packageId,
      revoked_at: now,
      revoked_child_grants: revokedChildGrants,
      not_revoked_child_grants: [],
    };
  }

  async function persistStagedBatchPackage({
    packageId,
    subjectId,
    registeredClient,
    packageEnvelope,
    parentPackageId,
    traceContext,
    createdAt,
    resolvedEntries,
  }: {
    packageId: string;
    subjectId: string;
    registeredClient: { client_id: string; registration_mode: string };
    packageEnvelope: Record<string, unknown>;
    parentPackageId: string | null;
    traceContext: SpineTraceContext;
    createdAt: string;
    resolvedEntries: ReadonlyArray<{
      slice: Record<string, unknown>;
      sourceBinding: { kind: string; id: string };
      storageBinding: { connector_id: string } | null;
      manifest: { version: string };
      resolvedStreams: readonly Record<string, unknown>[];
    }>;
  }): Promise<{
    childGrants: Array<{
      grant: Record<string, unknown>;
      token: string;
      source: Record<string, unknown> | null;
    }>;
    packageToken: string;
  }> {
    await getGrantPackageStore().insertPackage({
      packageId,
      subjectId,
      clientId: registeredClient.client_id,
      packageJson: JSON.stringify(packageEnvelope),
      parentPackageId,
      traceId: traceContext.trace_id,
      scenarioId: traceContext.scenario_id,
      createdAt,
      approvedAt: createdAt,
    });

    const childGrants: Array<{
      grant: Record<string, unknown>;
      token: string;
      source: Record<string, unknown> | null;
    }> = [];

    for (const resolved of resolvedEntries) {
      const { grant, token } = await persistChildGrantForPackage({
        request: resolved.slice as PendingRequest,
        registeredClient: registeredClient as RegisteredClient,
        subjectId,
        sourceBinding: resolved.sourceBinding as SourceBinding,
        storageBinding: resolved.storageBinding as StorageBinding | null,
        manifest: resolved.manifest as GrantManifest,
        resolvedStreams: resolved.resolvedStreams,
        traceContext,
      });
      const source = describePackageMemberSource(grant);
      const addedAt = nowIso();
      await getGrantPackageStore().insertPackageMember({
        packageId,
        grantId: grant.grant_id as string,
        tokenId: token,
        sourceJson: JSON.stringify(source),
        addedAt,
      });
      childGrants.push({ grant, token, source });
    }

    const packageToken = await issuePackageToken(packageId, subjectId, registeredClient.client_id, null, {
      traceContext,
      source: "batch_consent_package",
    });

    return { childGrants, packageToken };
  }

  return {
    createHostedMcpGrantPackage,
    getGrantPackageAccess,
    listGrantPackagesForOwner,
    getGrantPackageForOwner,
    getCumulativeClientAccessForPackage,
    getGrantPackageIdForGrant,
    listActivePackageIdsForClient,
    requireValidParentPackageLinkage,
    revokeGrantPackage,
    persistStagedBatchPackage,
    issuePackageToken,
  };
}
