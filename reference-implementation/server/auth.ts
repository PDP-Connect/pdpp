// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Authorization Server — grant issuance + token management
 *
 * Simplified AS for the current reference flow:
 * - Implements a real owner device flow for CLI/self-export
 * - Stages PDPP client requests through a PAR-backed pending-consent substrate
 * - Issues opaque bearer tokens (random strings)
 * - Implements RFC 7662-style introspection with PDPP extensions
 */
import { randomBytes } from "node:crypto";
import {
  BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
  BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
} from "@pdpp/reference-contract";
import {
  allowUnboundedReadAcknowledged,
  exec,
  execDynamicSqlAcknowledged,
  getOne,
  type MutationQuery,
  type RegisteredQuery,
  referenceQueries,
  transaction,
} from "../lib/db.ts";
import { createTraceContext, emitSpineEvent as emitRawSpineEvent, type SpineEventInput } from "../lib/spine.ts";
import { listActiveBindingsForGrant, projectBindingForWire } from "./connection-identity.ts";
import { canonicalConnectorKey, canonicalConnectorKeyFromManifest } from "./connector-key.ts";
import {
  invalidConnectorManifest,
  resolveManifestSensitivity,
  validateConnectorManifest,
} from "./connector-manifest-validation.ts";
import { getDb, runWithSqliteBusyRetry } from "./db.ts";
import { assertManifestReadAuthority } from "./manifest-read-authority.ts";
import {
  base64UrlSha256,
  generateOAuthRefreshToken,
  generateToken,
  hashOAuthRefreshToken,
  PKCE_CODE_VERIFIER_RE,
  SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS,
} from "./oauth-substrate/primitives.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "./postgres-storage.ts";

// ─── Domain types ─────────────────────────────────────────────────────────────

interface AuthError extends Error {
  code?: string;
  param?: string;
  request_id?: string;
  result?: unknown;
  scenario_id?: string;
  trace_id?: string;
}

interface TraceContext {
  request_id: string;
  scenario_id?: string;
  trace_id: string;
}

interface SourceBinding extends Record<string, unknown> {
  connection_id?: string;
  id: string;
  kind: "connector" | "provider_native";
}

interface StorageBinding {
  connector_id: string;
}

interface StreamSelection extends Record<string, unknown> {
  client_claims?: unknown;
  connection_id?: string;
  fields?: string[];
  name: string;
  necessity?: string;
  resources?: unknown[];
  time_range?: { since?: string; [key: string]: unknown };
  view?: string;
}

interface RawStreamSelection {
  client_claims?: unknown | undefined;
  connection_id?: string | undefined;
  fields?: unknown[] | undefined;
  name: unknown;
  necessity?: unknown | undefined;
  resources?: unknown[] | undefined;
  time_range?: unknown | undefined;
  view?: unknown | undefined;
}

interface GrantSelection {
  access_mode: string;
  purpose_code?: string | undefined;
  purpose_description?: string | undefined;
  retention?: unknown | undefined;
  streams: RawStreamSelection[];
  type: string;
}

interface PendingRequestClient {
  client_display?: ClientDisplay | null;
  client_id: string;
  registration_mode?: string;
}

interface PendingRequest {
  client: PendingRequestClient;
  manifest_version?: string | undefined;
  request_kind: string;
  request_version: string;
  selection: GrantSelection;
  source_binding?: SourceBinding | null | undefined;
  storage_binding?: StorageBinding | null | undefined;
  trace_context?: TraceContext | undefined;
}

interface BatchEntry {
  manifest_version?: string | undefined;
  selection: GrantSelection;
  source_binding?: SourceBinding | null | undefined;
  storage_binding?: StorageBinding | null | undefined;
}

interface StagedBatchRequest {
  client: PendingRequestClient;
  entries: BatchEntry[];
  entry_count: number;
  over_cap_sources: (SourceBinding | null)[];
  over_soft_cap: boolean;
  parent_package_id: string | null;
  request_kind: string;
  request_version: string;
  soft_cap: number;
  soft_cap_warning: boolean;
  trace_context?: TraceContext | undefined;
  warning_threshold: number;
}

interface ClientDisplay {
  logo_uri: string | null;
  name: string | null;
  policy_uri: string | null;
  tos_uri: string | null;
  uri: string | null;
}

interface ClientMetadata {
  application_type?: string | undefined;
  client_name?: string | null;
  client_uri?: string | null | undefined;
  grant_types?: string[] | undefined;
  issuer_subject_id?: string;
  logo_uri?: string | null | undefined;
  policy_uri?: string | null | undefined;
  redirect_uris?: string[] | undefined;
  response_types?: string[] | undefined;
  token_endpoint_auth_method: string;
  tos_uri?: string | null | undefined;
}

interface RegisteredClient {
  client_id: string;
  client_secret: string | null;
  created_at: string | null;
  metadata: ClientMetadata;
  registration_mode: string;
  token_endpoint_auth_method: string;
  updated_at: string | null;
}

interface ConsentExchangeEntry {
  consumed: boolean;
  expiresAt: number;
  grant: Record<string, unknown>;
  grantId: string;
  token: string;
}

interface GrantPackageNormalized {
  approved_at: string;
  client_id: string;
  created_at: string;
  package: Record<string, unknown> | null;
  package_id: string;
  parent_package_id: string | null;
  revoked_at: string | null;
  scenario_id: string | null;
  status: string;
  subject_id: string;
  trace_id: string | null;
}

interface KnownDbFields {
  access_mode?: string;
  active_token_count?: number | string;
  approval_id?: string;
  approved_at?: string;
  client_id?: string | null;
  client_name?: string | null;
  client_secret?: string | null;
  code?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  connection_id?: string;
  connector_id?: string;
  consumed_at?: string | null;
  created_at?: string;
  denied_at?: string;
  device_code?: string;
  expires_at?: string | null;
  grant_id?: string | null;
  grant_json?: string | null;
  grant_storage_binding?: string;
  interval_seconds?: number;
  last_polled_at?: string | null;
  manifest?: string;
  manifest_version?: string;
  metadata?: Record<string, unknown>;
  metadata_json?: string;
  package_count?: number | string;
  package_id?: string | null;
  package_json?: string | null;
  package_status?: string | null;
  params_json?: string;
  parent_package_id?: string | null;
  provider_id?: string;
  redirect_uri?: string;
  redirect_uris?: string;
  registration_mode?: string;
  request_id?: string | null;
  revoked?: boolean | number;
  revoked_at?: string | null;
  scenario_id?: string | null;
  source?: unknown;
  status?: string;
  storage_binding?: StorageBinding;
  storage_binding_json?: string | null;
  streams?: Record<string, unknown>[];
  subject_id?: string | null;
  subscription_id?: string;
  token_endpoint_auth_method?: string;
  token_id?: string | null;
  token_kind?: string;
  trace_id?: string | null;
  updated_at?: string;
  user_code?: string;
  version?: string;
}

type DbRow = Record<string, unknown> & KnownDbFields;
type MaybePromise<T> = T | Promise<T>;
interface StoreWriteResult {
  changes: number;
}
type SqliteBusyRetryOptions = NonNullable<Parameters<typeof runWithSqliteBusyRetry>[1]>;

interface GrantEnvelope extends DbRow {
  access_mode: string;
  client: {
    client_display?: ClientDisplay;
    client_id: string;
    registration_mode: string;
  };
  expires_at: string | null;
  grant_id: string;
  issued_at: string;
  manifest_version: string;
  purpose_code: string | undefined;
  purpose_description: string | undefined;
  retention: unknown;
  source: SourceBinding | null;
  streams: StreamSelection[];
  subject: { id: string };
  version: string;
}

interface RegisteredClientRow extends DbRow {
  client_id: string;
  client_secret: string | null;
  created_at: string;
  metadata_json: string;
  registration_mode: string;
  token_endpoint_auth_method: string;
  updated_at: string;
}

interface GrantPackageMemberRow extends DbRow {
  added_at: string;
  grant_id: string;
  grant_status: string;
  member_revoked_at?: string | null;
  member_status?: string;
  source_json: string | null;
  token_expires_at?: string | null;
  token_id?: string;
  token_revoked?: boolean | number;
}

interface GrantPackageListRow extends DbRow {
  approved_at: string;
  client_id: string;
  created_at: string;
  member_count?: number | string;
  package_id: string;
  status: string;
  subject_id: string;
}

interface GrantPackageCursor {
  created_at: string;
  package_id: string;
}

interface PendingConsentRow extends DbRow {
  created_at: string;
  device_code: string;
  expires_at: string;
  grant_id: string | null;
  interval_seconds: number;
  last_polled_at: string | null;
  params_json: string;
  request_id: string;
  scenario_id: string | null;
  status: string;
  subject_id?: string | null;
  token_id: string | null;
  trace_id: string;
  user_code: string;
}

interface OwnerDeviceAuthRow extends DbRow {
  client_id: string;
  created_at: string;
  device_code: string;
  expires_at: string;
  interval_seconds: number;
  last_polled_at: string | null;
  request_id: string | null;
  scenario_id: string | null;
  status: string;
  subject_id: string | null;
  token_id: string | null;
  trace_id: string | null;
  user_code: string;
}

interface OAuthPendingCodeRow extends DbRow {
  client_id: string;
  device_code: string;
  expires_at: string;
  redirect_uri: string;
  state: string | null;
  status: string;
}

interface OAuthIssuedCodeRow extends DbRow {
  client_id: string;
  code: string;
  code_challenge: string;
  code_challenge_method: string;
  consumed_at: string | null;
  expires_at: string;
  grant_id: string | null;
  package_id: string | null;
  redirect_uri: string;
  status: string;
  token_id: string;
}

interface RefreshTokenRow extends DbRow {
  client_id: string;
  expires_at: string | null;
  grant_id: string | null;
  package_id: string | null;
  revoked_at: string | null;
  status: string;
  subject_id: string;
}

interface GrantIssuanceRow extends DbRow {
  access_mode: string;
  consumed: boolean | number;
  grant_json: string;
  scenario_id: string | null;
  status: string;
  storage_binding_json: string | null;
  trace_id: string;
}

interface GrantRevocationRow extends DbRow {
  client_id: string;
  grant_json: string;
  scenario_id: string | null;
  storage_binding_json: string | null;
  subject_id: string;
  trace_id: string | null;
}

interface TokenIntrospectionRow extends DbRow {
  client_id: string | null;
  expires_at: string | null;
  grant_id: string | null;
  grant_json: string | null;
  grant_status: string | null;
  package_id: string | null;
  package_json: string | null;
  package_scenario_id: string | null;
  package_status: string | null;
  package_trace_id: string | null;
  revoked: boolean | number;
  scenario_id: string | null;
  storage_binding_json: string | null;
  subject_id: string;
  token_kind: string;
  trace_id: string | null;
}

interface TokenIntrospectionResult extends Record<string, unknown> {
  active: boolean;
  client_id?: string | null;
  exp?: number | null;
  grant_id?: string | null;
  grant_package_id?: string | null;
  pdpp_token_kind?: string;
  scenario_id?: string | null;
  subject_id?: string;
  trace_id?: string | null;
}

interface ClientAccessRevocationResult {
  disabledSubscriptionCount: number;
  revokedGrantIds: string[];
  revokedOwnerTokenCount: number;
  revokedPackageIds: string[];
}

interface PreRegisteredClientInput {
  client_id?: unknown;
  client_name?: unknown;
  client_secret?: unknown;
  metadata?: unknown;
  registration_mode?: unknown;
  token_endpoint_auth_method?: unknown;
  [key: string]: unknown;
}

interface PendingConsentStore {
  getByApprovalId: (approvalId: string) => MaybePromise<PendingConsentRow | null>;
  getByDeviceCode: (deviceCode: string) => MaybePromise<PendingConsentRow | null>;
  insert: (input: {
    deviceCode: string;
    userCode: string;
    params: PendingRequest | StagedBatchRequest;
    traceContext: TraceContext;
    createdAt: string;
    expiresAt: string;
    approvalId: string;
  }) => MaybePromise<StoreWriteResult>;
  markApproved: (input: {
    deviceCode: string;
    subjectId: string;
    grantId: string;
    tokenId: string;
    aiTrainingConsented: boolean | null | undefined;
    approvedAt: string;
  }) => MaybePromise<StoreWriteResult>;
  markDenied: (input: { deviceCode: string; deniedAt: string }) => MaybePromise<StoreWriteResult>;
  markExpired: (input: { deviceCode: string }) => MaybePromise<StoreWriteResult>;
  updateLastPolled: (input: { deviceCode: string; polledAt: string }) => MaybePromise<StoreWriteResult>;
}

interface OwnerDeviceAuthStore {
  getByApprovalId: (approvalId: string) => MaybePromise<OwnerDeviceAuthRow | null>;
  getByDeviceCode: (deviceCode: string) => MaybePromise<OwnerDeviceAuthRow | null>;
  getByUserCode: (userCode: string) => MaybePromise<OwnerDeviceAuthRow | null>;
  insert: (input: {
    deviceCode: string;
    userCode: string;
    clientId: string;
    intervalSeconds: number;
    createdAt: string;
    expiresAt: string;
    requestId: string | null;
    traceId: string | null;
    scenarioId: string | null;
    approvalId: string;
  }) => MaybePromise<StoreWriteResult>;
  markApproved: (input: {
    deviceCode: string;
    subjectId: string;
    tokenId: string;
    approvedAt: string;
  }) => MaybePromise<StoreWriteResult>;
  markDenied: (input: { deviceCode: string; deniedAt: string }) => MaybePromise<StoreWriteResult>;
  markExpired: (input: { deviceCode: string }) => MaybePromise<StoreWriteResult>;
  updateLastPolled: (input: { deviceCode: string; polledAt: string }) => MaybePromise<StoreWriteResult>;
}

interface RegisteredClientStore {
  countActiveTokensByClientId: (clientId: string) => MaybePromise<DbRow | null>;
  deleteByClientId: (clientId: string) => MaybePromise<StoreWriteResult>;
  getByClientId: (clientId: string) => MaybePromise<RegisteredClientRow | null>;
  listByIssuerSubject: (subjectId: string) => MaybePromise<readonly RegisteredClientRow[]>;
  upsert: (input: {
    clientId: string;
    registrationMode: string;
    tokenEndpointAuthMethod: string;
    clientSecret: string | null;
    persistedMetadataJson: string;
    timestamp: string;
  }) => MaybePromise<StoreWriteResult>;
}

interface CimdRow extends DbRow {
  client_name: string | null;
  created_at: string;
  document_id: string;
  logo_uri: string | null;
  redirect_uris: string;
  updated_at: string;
}

interface CimdStore {
  getById: (documentId: string) => MaybePromise<CimdRow | null | undefined>;
  insert: (input: {
    documentId: string;
    clientName: string | null;
    redirectUrisJson: string;
    logoUri: string | null;
    now: string;
  }) => MaybePromise<StoreWriteResult | { changes: number | bigint }>;
  listAll: () => MaybePromise<readonly CimdRow[]>;
}

interface ConnectorCatalogStore {
  getManifestById: (connectorId: string) => MaybePromise<DbRow | null>;
  listIds: () => MaybePromise<readonly DbRow[]>;
  upsert: (input: { connectorId: string; manifestJson: string }) => MaybePromise<StoreWriteResult>;
}

interface GrantPackageStore {
  getPackageById: (packageId: string) => MaybePromise<DbRow | null>;
  getPackageIdForGrant: (grantId: string) => MaybePromise<DbRow | null>;
  insertChildGrant: (input: {
    grantId: string;
    subjectId: string;
    clientId: string;
    storageBindingJson: string | null;
    grantJson: string;
    accessMode: string;
    issuedAt: string;
    expiresAt: string | null;
    traceId: string;
    scenarioId: string | null;
  }) => MaybePromise<StoreWriteResult>;
  insertPackage: (input: {
    packageId: string;
    subjectId: string;
    clientId: string;
    packageJson: string;
    parentPackageId: string | null;
    traceId: string;
    scenarioId: string | null;
    createdAt: string;
    approvedAt: string;
  }) => MaybePromise<StoreWriteResult>;
  insertPackageMember: (input: {
    packageId: string;
    grantId: string;
    tokenId: string;
    sourceJson: string;
    addedAt: string;
  }) => MaybePromise<StoreWriteResult>;
  insertPackageToken: (input: {
    tokenId: string;
    packageId: string;
    subjectId: string;
    clientId: string;
    expiresAt: string | null;
  }) => MaybePromise<StoreWriteResult>;
  listActiveMembers: (packageId: string) => MaybePromise<readonly GrantPackageMemberRow[]>;
  listAllMembers: (packageId: string) => MaybePromise<readonly GrantPackageMemberRow[]>;
  markMemberRevoked: (input: {
    packageId: string;
    grantId: string;
    revokedAt: string;
  }) => MaybePromise<StoreWriteResult>;
  markPackageRevokedCascade: (input: { packageId: string; revokedAt: string }) => MaybePromise<void>;
}

interface OAuthCodeStore {
  consumeCode: (input: { consumedAt: string; code: string }) => MaybePromise<StoreWriteResult>;
  getByCode: (code: string) => MaybePromise<OAuthIssuedCodeRow | null>;
  getByDeviceCode: (deviceCode: string) => MaybePromise<OAuthPendingCodeRow | null>;
  issueForDeviceCode: (input: {
    code: string;
    grantId: string;
    token: string;
    issuedAt: string;
    expiresAt: string;
    deviceCode: string;
  }) => MaybePromise<StoreWriteResult>;
  issueForPackageDeviceCode: (input: {
    code: string;
    packageId: string;
    token: string;
    issuedAt: string;
    expiresAt: string;
    deviceCode: string;
  }) => MaybePromise<StoreWriteResult>;
  markExpiredByDeviceCode: (deviceCode: string) => MaybePromise<StoreWriteResult>;
  upsertPending: (input: {
    id: string;
    deviceCode: string;
    clientId: string;
    redirectUri: string;
    state: string | null;
    codeChallenge: string;
    codeChallengeMethod: string;
    createdAt: string;
    expiresAt: string;
  }) => MaybePromise<StoreWriteResult>;
}

interface RefreshTokenStore {
  getByTokenHash: (refreshTokenHash: string) => MaybePromise<RefreshTokenRow | null>;
  insert: (input: {
    refreshTokenHash: string;
    clientId: string;
    grantId: string;
    subjectId: string;
    createdAt: string;
    expiresAt: string | null;
  }) => MaybePromise<StoreWriteResult>;
  insertForPackage: (input: {
    refreshTokenHash: string;
    clientId: string;
    packageId: string;
    subjectId: string;
    createdAt: string;
    expiresAt: string | null;
  }) => MaybePromise<StoreWriteResult>;
  markUsed: (input: { usedAt: string; refreshTokenHash: string }) => MaybePromise<StoreWriteResult>;
}

interface TokenStore {
  getIntrospection: (token: string) => MaybePromise<TokenIntrospectionRow | null>;
  insertOwner: (input: {
    tokenId: string;
    subjectId: string;
    clientId: string | null;
    expiresAt: string;
  }) => MaybePromise<StoreWriteResult>;
  listActiveByClientId: (clientId: string) => MaybePromise<readonly DbRow[]>;
  revokeByClientId: (clientId: string) => MaybePromise<StoreWriteResult>;
  revokeByTokenId: (tokenId: string, clientId: string) => MaybePromise<StoreWriteResult>;
}

function generateId(prefix = "id"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiresInIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isExpired(row: DbRow): boolean {
  return new Date(String(row.expires_at)).getTime() <= Date.now();
}

async function pgOne<Row extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<Row | null> {
  const result = await postgresQuery<Row>(sql, params);
  return result.rows[0] ?? null;
}

async function pgExec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  const result = await postgresQuery(sql, params);
  return { changes: result.rowCount ?? 0 };
}

let configuredNativeManifest: DbRow | null = null;
const LEGACY_LOCAL_CONNECTOR_MANIFEST_ALIASES = new Map([
  ["claude_code", "claude-code"],
  ["codex", "codex"],
]);
const PENDING_CONSENT_REQUEST_URI_PREFIX = "urn:pdpp:pending-consent:";
const LEADING_SLASH_RE = /^\//;
const TRAILING_SLASHES_RE = /\/+$/;
const SUPPORTED_CLIENT_AUTH_METHODS = new Set(["none"]);
const SUPPORTED_DYNAMIC_CLIENT_GRANT_TYPES = new Set([
  "authorization_code",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:device_code",
]);
const SUPPORTED_DYNAMIC_CLIENT_RESPONSE_TYPES = new Set(["code"]);
const SUPPORTED_DYNAMIC_CLIENT_APPLICATION_TYPES = new Set(["web", "native"]);
const SUPPORTED_REGISTRATION_MODES = new Set(["dynamic", "pre_registered_public"]);
const SUPPORTED_DYNAMIC_CLIENT_METADATA_FIELDS = new Set([
  "application_type",
  "client_name",
  "client_uri",
  "grant_types",
  "logo_uri",
  "policy_uri",
  "redirect_uris",
  "response_types",
  "token_endpoint_auth_method",
  "tos_uri",
]);
const SUPPORTED_PENDING_REQUEST_FIELDS = new Set([
  "authorization_details",
  "client_display",
  "client_id",
  "parent_package_id",
  "scenario_id",
]);
const SUPPORTED_AUTHORIZATION_DETAIL_FIELDS = new Set([
  "access_mode",
  "purpose_code",
  "purpose_description",
  "retention",
  "source",
  "streams",
  "type",
]);
const SUPPORTED_STREAM_SELECTION_FIELDS = new Set([
  "client_claims",
  "connection_id",
  "fields",
  "name",
  "necessity",
  "resources",
  "time_range",
  "view",
]);
const SUPPORTED_NORMALIZED_PENDING_REQUEST_FIELDS = new Set([
  "client",
  "manifest_version",
  "request_kind",
  "request_version",
  "selection",
  "source_binding",
  "storage_binding",
  "trace_context",
]);
const SUPPORTED_PENDING_CLIENT_FIELDS = new Set(["client_display", "client_id", "registration_mode"]);
const SUPPORTED_ACCESS_MODES = new Set(["single_use", "continuous"]);
const SUPPORTED_PENDING_SELECTION_FIELDS = new Set([
  "access_mode",
  "purpose_code",
  "purpose_description",
  "retention",
  "streams",
  "type",
]);
function cloneJson<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function bindingError(code: string, message: string): AuthError {
  const err: AuthError = new Error(message);
  err.code = code;
  return err;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthError(value: unknown): value is AuthError {
  return value instanceof Error;
}

function requireMutationQuery(query: RegisteredQuery | undefined, contractName: string): MutationQuery {
  if (query?.terminator !== "exec") {
    throw bindingError("server_error", `Missing SQLite mutation query contract: ${contractName}`);
  }
  return query;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

async function forEachSequential<T>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<void>,
  index = 0
): Promise<void> {
  if (index >= values.length) {
    return;
  }
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Sequential operation received a sparse entry at index ${index}`);
  }
  await operation(value, index);
  await forEachSequential(values, operation, index + 1);
}

function getManifestStreams(manifest: DbRow): Record<string, unknown>[] {
  return Array.isArray(manifest.streams) ? manifest.streams.filter(isRecord) : [];
}

function requireManifestVersion(manifest: DbRow): string {
  if (!isNonEmptyString(manifest.version)) {
    throw bindingError("invalid_request", "Manifest version is required");
  }
  return manifest.version;
}

type AuthSpineEventInput = {
  [Key in keyof SpineEventInput]?: SpineEventInput[Key] | undefined;
};

function emitSpineEvent(input: AuthSpineEventInput): ReturnType<typeof emitRawSpineEvent> {
  const definedEntries = Object.entries(input).filter(
    (entry): entry is [string, Exclude<unknown, undefined>] => entry[1] !== undefined
  );
  return emitRawSpineEvent(Object.fromEntries(definedEntries) as SpineEventInput);
}

function resolveConfiguredNativeStorageBinding(opts: { nativeManifest?: DbRow | null } = {}): StorageBinding | null {
  const nativeManifest = resolveConfiguredNativeManifest(opts);
  const storageBinding = nativeManifest?.storage_binding;
  const connectorId = isRecord(storageBinding) ? storageBinding.connector_id : null;
  return isNonEmptyString(connectorId) ? { connector_id: connectorId } : null;
}

export function buildPendingConsentRequestUri(deviceCode: string): string {
  return `${PENDING_CONSENT_REQUEST_URI_PREFIX}${deviceCode}`;
}

export function parsePendingConsentRequestUri(requestUri: unknown): string | null {
  if (typeof requestUri !== "string" || !requestUri.startsWith(PENDING_CONSENT_REQUEST_URI_PREFIX)) {
    return null;
  }
  const deviceCode = requestUri.slice(PENDING_CONSENT_REQUEST_URI_PREFIX.length).trim();
  return deviceCode || null;
}

export function buildPendingConsentAuthorizationUrl(requestUri: string, opts: { baseUrl?: string } = {}): string {
  const baseUrl = opts.baseUrl || process.env.AS_PUBLIC_URL || `http://localhost:${process.env.AS_PORT || "7662"}`;
  return `${baseUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`;
}

export function configureNativeManifest(manifest: DbRow | null = null): void {
  configuredNativeManifest = manifest ? cloneJson(manifest) : null;
}

/**
 * Return a defensive copy of the currently-configured native manifest, or
 * null when the reference is running in polyfill mode. Diagnostics-only:
 * callers that need the manifest for an auth decision go through
 * getManifestForStorageBinding / getConnectorManifest.
 */
export function getConfiguredNativeManifest(): DbRow | null {
  return configuredNativeManifest ? cloneJson(configuredNativeManifest) : null;
}

function resolveConfiguredNativeManifest(opts: { nativeManifest?: DbRow | null } = {}): DbRow | null {
  return opts.nativeManifest ?? configuredNativeManifest ?? null;
}

function normalizeClientDisplay(raw: unknown): ClientDisplay | null {
  if (!isRecord(raw)) {
    return null;
  }
  const next: ClientDisplay = {
    logo_uri: typeof raw.logo_uri === "string" ? raw.logo_uri : null,
    name: typeof raw.name === "string" ? raw.name : null,
    policy_uri: typeof raw.policy_uri === "string" ? raw.policy_uri : null,
    tos_uri: typeof raw.tos_uri === "string" ? raw.tos_uri : null,
    uri: typeof raw.uri === "string" ? raw.uri : null,
  };
  return Object.values(next).some(Boolean) ? next : null;
}

function normalizeStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === null || value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    const err: AuthError = new Error(`${fieldName} must be an array of non-empty strings`);
    err.code = "invalid_client_metadata";
    throw err;
  }
  return value.map((item) => item.trim());
}

function normalizeUri(value: unknown, fieldName: string): string | null | undefined {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  try {
    const parsedUri = new URL(trimmed);
    if (!parsedUri.protocol) {
      throw new TypeError("URI must include a protocol");
    }
  } catch (cause: unknown) {
    const err: AuthError = new Error(`${fieldName} must be a valid absolute URI`);
    err.cause = cause;
    err.code = "invalid_client_metadata";
    throw err;
  }
  return trimmed;
}

function normalizeUriArray(value: unknown, fieldName: string): string[] | undefined {
  const values = normalizeStringArray(value, fieldName);
  if (!values) {
    return;
  }
  return values.map((item) => {
    const uri = normalizeUri(item, fieldName);
    if (!uri) {
      throw bindingError("invalid_client_metadata", `${fieldName} must be a valid absolute URI`);
    }
    return uri;
  });
}

function isLoopbackRedirectHost(hostname: unknown): boolean {
  // URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]"); strip the
  // brackets before comparing so IPv6 loopback is recognized (RFC 8252).
  const normalized = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function isLoopbackHttpRedirectUri(redirectUri: string): boolean {
  const parsed = new URL(redirectUri);
  return parsed.protocol === "http:" && isLoopbackRedirectHost(parsed.hostname);
}

function inferApplicationTypeFromRedirectUris(redirectUris: string[] = []): "native" | undefined {
  return redirectUris.some((redirectUri) => isLoopbackHttpRedirectUri(redirectUri)) ? "native" : undefined;
}

function validateAuthorizationCodeRedirectUris(redirectUris: string[] = [], applicationType = "web"): void {
  for (const redirectUri of redirectUris) {
    const parsed = new URL(redirectUri);
    if (applicationType === "native" && parsed.protocol === "http:" && isLoopbackRedirectHost(parsed.hostname)) {
      continue;
    }
    if (parsed.protocol !== "https:") {
      const err: AuthError = new Error(
        applicationType === "native"
          ? "authorization_code redirect_uris must use https, or loopback http for native clients"
          : "authorization_code redirect_uris must use https for web clients"
      );
      err.code = "invalid_client_metadata";
      throw err;
    }
  }
}

function requireSupportedClientRegistrationMetadata(input: Record<string, unknown>): string {
  const rawTokenEndpointAuthMethod = input.token_endpoint_auth_method || "none";
  const tokenEndpointAuthMethod = typeof rawTokenEndpointAuthMethod === "string" ? rawTokenEndpointAuthMethod : "";
  if (!SUPPORTED_CLIENT_AUTH_METHODS.has(tokenEndpointAuthMethod)) {
    const err: AuthError = new Error(`Unsupported token_endpoint_auth_method: ${tokenEndpointAuthMethod}`);
    err.code = "invalid_client_metadata";
    throw err;
  }

  if (input.client_secret !== null && input.client_secret !== undefined) {
    const err: AuthError = new Error(
      "client_secret must not be supplied; the current reference only registers public clients"
    );
    err.code = "invalid_client_metadata";
    throw err;
  }

  const unsupportedFields = Object.keys(input).filter((field) => !SUPPORTED_DYNAMIC_CLIENT_METADATA_FIELDS.has(field));
  if (unsupportedFields.length) {
    const err: AuthError = new Error(`Unsupported client metadata fields: ${unsupportedFields.join(", ")}`);
    err.code = "invalid_client_metadata";
    throw err;
  }
  return tokenEndpointAuthMethod;
}

function validateClientRegistrationCapabilities(metadata: ClientMetadata): void {
  if (metadata.grant_types?.length) {
    const unsupported = metadata.grant_types.filter((type) => !SUPPORTED_DYNAMIC_CLIENT_GRANT_TYPES.has(type));
    if (unsupported.length) {
      const err: AuthError = new Error(`Unsupported grant_types metadata values: ${unsupported.join(", ")}`);
      err.code = "invalid_client_metadata";
      throw err;
    }
  }

  if (metadata.response_types?.length) {
    const unsupported = metadata.response_types.filter((type) => !SUPPORTED_DYNAMIC_CLIENT_RESPONSE_TYPES.has(type));
    if (unsupported.length) {
      const err: AuthError = new Error(`Unsupported response_types metadata values: ${unsupported.join(", ")}`);
      err.code = "invalid_client_metadata";
      throw err;
    }
  }

  if (metadata.application_type && !SUPPORTED_DYNAMIC_CLIENT_APPLICATION_TYPES.has(metadata.application_type)) {
    const err: AuthError = new Error(`Unsupported application_type metadata value: ${metadata.application_type}`);
    err.code = "invalid_client_metadata";
    throw err;
  }
}

function requireCoherentAuthorizationCodeMetadata(metadata: ClientMetadata): void {
  const wantsAuthorizationCode =
    metadata.grant_types?.includes("authorization_code") || metadata.response_types?.includes("code");
  if (metadata.grant_types?.includes("refresh_token") && !metadata.grant_types.includes("authorization_code")) {
    const err: AuthError = new Error("refresh_token grant_type requires authorization_code");
    err.code = "invalid_client_metadata";
    throw err;
  }
  if (wantsAuthorizationCode && !metadata.redirect_uris?.length) {
    const err: AuthError = new Error("redirect_uris is required for authorization_code clients");
    err.code = "invalid_client_metadata";
    throw err;
  }
  if (wantsAuthorizationCode) {
    validateAuthorizationCodeRedirectUris(metadata.redirect_uris, metadata.application_type || "web");
  }
}

function normalizeClientRegistrationMetadata(input: Record<string, unknown> = {}): ClientMetadata {
  const tokenEndpointAuthMethod = requireSupportedClientRegistrationMetadata(input);
  const metadata = {
    application_type:
      typeof input.application_type === "string" && input.application_type.trim()
        ? input.application_type.trim()
        : undefined,
    client_name: typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim() : null,
    client_uri: normalizeUri(input.client_uri, "client_uri"),
    grant_types: normalizeStringArray(input.grant_types, "grant_types"),
    logo_uri: normalizeUri(input.logo_uri, "logo_uri"),
    policy_uri: normalizeUri(input.policy_uri, "policy_uri"),
    redirect_uris: normalizeUriArray(input.redirect_uris, "redirect_uris"),
    response_types: normalizeStringArray(input.response_types, "response_types"),
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    tos_uri: normalizeUri(input.tos_uri, "tos_uri"),
  };

  validateClientRegistrationCapabilities(metadata);
  if (!metadata.application_type && metadata.redirect_uris?.length) {
    metadata.application_type = inferApplicationTypeFromRedirectUris(metadata.redirect_uris);
  }
  requireCoherentAuthorizationCodeMetadata(metadata);

  return {
    application_type: metadata.application_type,
    client_name: metadata.client_name,
    client_uri: metadata.client_uri,
    grant_types: metadata.grant_types,
    logo_uri: metadata.logo_uri,
    policy_uri: metadata.policy_uri,
    redirect_uris: metadata.redirect_uris,
    response_types: metadata.response_types,
    token_endpoint_auth_method: metadata.token_endpoint_auth_method,
    tos_uri: metadata.tos_uri,
  };
}

function buildClientDisplayFromRegistration(metadata: Partial<ClientMetadata> = {}): ClientDisplay | null {
  return normalizeClientDisplay({
    logo_uri: metadata.logo_uri,
    name: metadata.client_name,
    policy_uri: metadata.policy_uri,
    tos_uri: metadata.tos_uri,
    uri: metadata.client_uri,
  });
}

function applyRegisteredClientToPendingRequestClient(
  request: { client: PendingRequestClient },
  registeredClient: RegisteredClient
): void {
  Object.assign(request.client, {
    client_display: buildClientDisplayFromRegistration(registeredClient.metadata),
    client_id: registeredClient.client_id,
    registration_mode: registeredClient.registration_mode || "pre_registered_public",
  });
}

function normalizeStreamSelection(stream: Record<string, unknown>): RawStreamSelection {
  return {
    client_claims: stream.client_claims || undefined,
    connection_id: typeof stream.connection_id === "string" && stream.connection_id ? stream.connection_id : undefined,
    fields: Array.isArray(stream.fields) ? stream.fields : undefined,
    name: stream.name,
    necessity: stream.necessity || undefined,
    resources: Array.isArray(stream.resources) ? stream.resources : undefined,
    time_range: stream.time_range || undefined,
    view: stream.view || undefined,
  };
}

interface GrantRequestEnvelope extends Record<string, unknown> {
  authorization_details: unknown[];
  client_id: string;
}

function isEnvelopeRequest(input: unknown): input is Record<string, unknown> & { authorization_details: unknown[] } {
  return isRecord(input) && Array.isArray(input.authorization_details);
}

function invalidGrantInitiationRequest(message: string): never {
  const err: AuthError = new Error(message);
  err.code = "invalid_request";
  throw err;
}

function requireStagedRequestEnvelope(input: unknown): GrantRequestEnvelope {
  if (!isRecord(input)) {
    invalidGrantInitiationRequest("Grant initiation requires a JSON object body");
  }

  const unsupportedRequestFields = Object.keys(input).filter((field) => !SUPPORTED_PENDING_REQUEST_FIELDS.has(field));
  if (unsupportedRequestFields.length) {
    invalidGrantInitiationRequest(`Unsupported request fields: ${unsupportedRequestFields.join(", ")}`);
  }

  if (!isEnvelopeRequest(input)) {
    invalidGrantInitiationRequest("Grant initiation requires authorization_details");
  }

  if (typeof input.client_id !== "string" || !input.client_id.trim()) {
    invalidGrantInitiationRequest("Grant initiation requires client_id");
  }

  if (input.authorization_details.length < 1) {
    invalidGrantInitiationRequest("authorization_details must contain at least one entry");
  }

  return { ...input, client_id: input.client_id.trim() };
}

// A purpose_code must be a syntactically valid absolute URI (spec-core.md:428):
// a scheme plus scheme-specific part, e.g. https://pdpp.org/purpose/analytics.
// Bare tokens like "analytics" or "assist.summarize" are not absolute URIs and
// are rejected for syntax; this is independent of whether the code is in any
// registry (unknown absolute URIs MUST still be accepted).
function isAbsoluteUriPurposeCode(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

interface AuthorizationDetailInput extends Record<string, unknown> {
  access_mode: string;
  streams: Record<string, unknown>[];
}

function requireAuthorizationDetailInput(detail: unknown, index: number): AuthorizationDetailInput {
  const at = `authorization_details[${index}]`;
  if (!isRecord(detail)) {
    throw bindingError("invalid_request", "Unsupported authorization_details type");
  }
  if (detail.type !== "https://pdpp.org/data-access") {
    invalidGrantInitiationRequest("Unsupported authorization_details type");
  }
  if ("connector_id" in detail || "provider_id" in detail) {
    invalidGrantInitiationRequest(
      "authorization_details must use source: { kind: 'connector' | 'provider_native', id }"
    );
  }
  const unsupportedDetailFields = Object.keys(detail).filter(
    (field) => !SUPPORTED_AUTHORIZATION_DETAIL_FIELDS.has(field)
  );
  if (unsupportedDetailFields.length) {
    invalidGrantInitiationRequest(`Unsupported authorization_details fields: ${unsupportedDetailFields.join(", ")}`);
  }
  if (!Array.isArray(detail.streams) || detail.streams.length === 0) {
    throw bindingError("invalid_request", `${at}.streams must be a non-empty array`);
  }
  if (typeof detail.access_mode !== "string" || !SUPPORTED_ACCESS_MODES.has(detail.access_mode)) {
    throw bindingError("invalid_request", `${at}.access_mode must be "single_use" or "continuous"`);
  }
  // purpose_code must be a syntactically valid absolute URI (spec-core.md:428).
  // The AS validates SYNTAX only here; it MUST NOT reject a code merely for being
  // unrecognized. Registry membership is advisory, enforced (if at all) by local
  // policy elsewhere.
  if (detail.purpose_code !== undefined && !isAbsoluteUriPurposeCode(detail.purpose_code)) {
    invalidGrantInitiationRequest(`${at}.purpose_code must be a syntactically valid absolute URI`);
  }
  const streams: Record<string, unknown>[] = [];
  for (const stream of detail.streams) {
    if (!isRecord(stream)) {
      invalidGrantInitiationRequest(`${at}.streams entries must be objects`);
    }
    const unsupportedStreamFields = Object.keys(stream).filter(
      (field) => !SUPPORTED_STREAM_SELECTION_FIELDS.has(field)
    );
    if (unsupportedStreamFields.length) {
      invalidGrantInitiationRequest(
        `Unsupported stream selection fields on '${stream.name || "unknown"}': ${unsupportedStreamFields.join(", ")}`
      );
    }
    streams.push(stream);
  }
  return { ...detail, access_mode: detail.access_mode, streams };
}

function resolveAuthorizationDetailBindings(
  detail: AuthorizationDetailInput,
  index: number,
  opts: { nativeManifest?: DbRow | null }
): { sourceBinding: SourceBinding; storageBinding: StorageBinding } {
  const at = `authorization_details[${index}]`;
  const nativeManifest = resolveConfiguredNativeManifest(opts);
  const configuredNativeProviderId = nativeManifest?.provider_id || null;
  const configuredNativeStorageBinding = resolveConfiguredNativeStorageBinding(opts);
  const configuredNativeStorageConnectorId = configuredNativeStorageBinding?.connector_id || null;
  const detailSource = detail.source;
  if (!isRecord(detailSource)) {
    throw bindingError("invalid_request", `${at}.source must be { kind: 'connector' | 'provider_native', id }`);
  }
  const detailSourceKeys = Object.keys(detailSource).sort();
  if (detailSourceKeys.length !== 2 || detailSourceKeys[0] !== "id" || detailSourceKeys[1] !== "kind") {
    invalidGrantInitiationRequest(`${at}.source must include only kind and id`);
  }
  const bindingKind = detailSource.kind;
  const sourceId = detailSource.id;
  if (!((bindingKind === "connector" || bindingKind === "provider_native") && isNonEmptyString(sourceId))) {
    throw bindingError(
      "invalid_request",
      `${at}.source.kind must be 'connector' or 'provider_native' and source.id is required`
    );
  }
  if (bindingKind === "provider_native" && configuredNativeProviderId && sourceId !== configuredNativeProviderId) {
    invalidGrantInitiationRequest(`Unknown source: { kind: 'provider_native', id: '${sourceId}' }`);
  }
  // Normalize URL-shaped first-party connector ids to their canonical short
  // keys at the grant-initiation boundary so pending consents and issued
  // grants always store a canonical connector_id, not a registry URL.
  // Unknown / custom connector ids are preserved as-is (fail open) so
  // third-party manifests continue to work without being in the allowlist.
  const rawSourceConnectorId = bindingKind === "connector" ? sourceId : configuredNativeStorageConnectorId;
  const resolvedConnectorId = rawSourceConnectorId
    ? (canonicalConnectorKey(rawSourceConnectorId) ?? rawSourceConnectorId)
    : rawSourceConnectorId;
  if (!resolvedConnectorId) {
    throw bindingError("invalid_request", `${at}.source requires configured native storage for provider_native access`);
  }

  // Use the canonical connector id in the source binding too so that
  // source_binding.id === storage_binding.connector_id, which the approval
  // path validates. For provider_native grants the source id is the
  // provider_id (not a connector_id), so we only normalize connector sources.
  const canonicalSourceId = bindingKind === "connector" ? (canonicalConnectorKey(sourceId) ?? sourceId) : sourceId;
  const sourceBinding: SourceBinding = { id: canonicalSourceId, kind: bindingKind };
  return { sourceBinding, storageBinding: { connector_id: resolvedConnectorId } };
}

function normalizeAuthorizationDetail(
  rawDetail: unknown,
  index: number,
  opts: { nativeManifest?: DbRow | null } = {}
): { selection: GrantSelection; source_binding: SourceBinding; storage_binding: StorageBinding } {
  const detail = requireAuthorizationDetailInput(rawDetail, index);
  const { sourceBinding, storageBinding } = resolveAuthorizationDetailBindings(detail, index, opts);

  return {
    selection: {
      access_mode: detail.access_mode,
      purpose_code: isNonEmptyString(detail.purpose_code) ? detail.purpose_code : undefined,
      purpose_description: isNonEmptyString(detail.purpose_description) ? detail.purpose_description : undefined,
      retention: detail.retention || undefined,
      streams: detail.streams.map(normalizeStreamSelection),
      type: "https://pdpp.org/data-access",
    },
    source_binding: sourceBinding,
    storage_binding: storageBinding,
  };
}

function normalizePendingGrantRequest(
  input: Record<string, unknown>,
  opts: { nativeManifest?: DbRow | null } = {}
): PendingRequest {
  const envelope = requireStagedRequestEnvelope(input);
  const clientId = envelope.client_id;
  if (envelope.authorization_details.length !== 1) {
    invalidGrantInitiationRequest(
      "Exactly one authorization_details entry is supported in this flow; use the staged batch path for multi-entry requests"
    );
  }
  // Defensive guard: `initiateGrant` routes parent-linked add-source requests
  // to the staged lineage path, even when they add exactly one source.
  if (input.parent_package_id !== undefined && input.parent_package_id !== null) {
    invalidGrantInitiationRequest("parent_package_id is only supported on the staged batch path");
  }
  const entry = normalizeAuthorizationDetail(envelope.authorization_details[0], 0, opts);
  return {
    client: {
      client_display: normalizeClientDisplay(input.client_display),
      client_id: clientId,
    },
    request_kind: "pdpp_selection_request",
    request_version: "reference.v1",
    selection: entry.selection,
    source_binding: entry.source_binding,
    storage_binding: entry.storage_binding,
  };
}

function normalizeStagedGrantRequestBatch(
  input: Record<string, unknown>,
  opts: { nativeManifest?: DbRow | null } = {}
): StagedBatchRequest {
  const envelope = requireStagedRequestEnvelope(input);
  const clientId = envelope.client_id;
  const entries = envelope.authorization_details.map((detail, index) =>
    normalizeAuthorizationDetail(detail, index, opts)
  );
  const entryCount = entries.length;
  const overSoftCap = entryCount > BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP;
  // The soft cap is a reference-contract policy constant, not a hard limit
  // (design.md rejects a hard cap). Over-cap requests are accepted but
  // flagged — never silently truncated — and the over-cap sources are named
  // so the owner sees exactly which sources push past the cap.
  const overCapSources = overSoftCap
    ? entries.slice(BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP).map((entry) => describeSourceBinding(entry.source_binding))
    : [];
  return {
    client: {
      client_display: normalizeClientDisplay(input.client_display),
      client_id: clientId,
    },
    entries,
    entry_count: entryCount,
    over_cap_sources: overCapSources,
    over_soft_cap: overSoftCap,
    // Incremental add-source lineage. `parent_package_id` links this staged
    // batch to a prior same-client package so the dashboard can render a
    // cumulative per-client view. It is grouping/audit metadata, not a new
    // authorization primitive: it never re-issues, widens, or mutates the
    // prior package's child grants. Validity (existence, same client, same
    // owner, active) is enforced at initiation and re-checked at approval,
    // before any new package row or child grant is written.
    parent_package_id: normalizeParentPackageIdInput(input.parent_package_id),
    request_kind: "pdpp_selection_request_batch",
    request_version: "reference.v1",
    soft_cap: BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
    soft_cap_warning: entryCount >= BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
    warning_threshold: BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
  };
}

function normalizeParentPackageIdInput(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    invalidGrantInitiationRequest("parent_package_id must be a non-empty string when provided");
  }
  return value.trim();
}

function isStagedBatchRequest(request: unknown): request is StagedBatchRequest {
  return isRecord(request) && request.request_kind === "pdpp_selection_request_batch" && Array.isArray(request.entries);
}

function getRequestTraceContext(
  request: Partial<PendingRequest | StagedBatchRequest>,
  scenarioId?: string | null
): TraceContext {
  if (request?.trace_context?.trace_id && request?.trace_context?.request_id) {
    return request.trace_context;
  }
  return createTraceContext(scenarioId ? { scenarioId } : {});
}

function getPersistedPendingTraceContext(row: DbRow = {}): TraceContext | null {
  if (isNonEmptyString(row.trace_id) && isNonEmptyString(row.request_id)) {
    return {
      request_id: row.request_id,
      trace_id: row.trace_id,
      ...(isNonEmptyString(row.scenario_id) ? { scenario_id: row.scenario_id } : {}),
    };
  }
  return null;
}

function requirePersistedPendingTraceContext(row: DbRow = {}): TraceContext {
  const traceContext = getPersistedPendingTraceContext(row);
  if (traceContext) {
    return traceContext;
  }
  throw bindingError("invalid_request", "Pending consent row is missing persisted trace correlation");
}

function getRequestSourceBinding(request: Partial<PendingRequest> = {}): SourceBinding | null {
  return request.source_binding ?? null;
}

function getRequestStorageBinding(request: Partial<PendingRequest> = {}): StorageBinding | null {
  return request.storage_binding?.connector_id ? request.storage_binding : null;
}

function attachTraceContext(err: AuthError, traceContext: TraceContext | null | undefined): AuthError {
  if (traceContext?.trace_id) {
    err.trace_id = traceContext.trace_id;
  }
  if (traceContext?.request_id) {
    err.request_id = traceContext.request_id;
  }
  if (traceContext?.scenario_id) {
    err.scenario_id = traceContext.scenario_id;
  }
  return err;
}

function buildPendingRequestRejectionData(
  request: Partial<PendingRequest> = {},
  pending: DbRow = {}
): Record<string, unknown> {
  return {
    access_mode: request.selection?.access_mode || null,
    purpose_code: request.selection?.purpose_code || null,
    source: describeSourceBinding(getRequestSourceBinding(request)),
    stream_names: (request.selection?.streams || []).map((stream) => stream.name),
    user_code: pending.user_code,
  };
}

async function emitPendingConsentRejected(
  request: Partial<PendingRequest>,
  pending: DbRow,
  err: AuthError,
  opts: { subjectId?: string } = {}
): Promise<AuthError> {
  const traceContext = getPersistedPendingTraceContext(pending);
  if (!traceContext) {
    return err;
  }
  attachTraceContext(err, traceContext);
  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    event_type: "request.rejected",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    trace_id: traceContext.trace_id,
    ...(opts.subjectId
      ? {
          subject_id: opts.subjectId,
          subject_type: "subject",
        }
      : {}),
    client_id: request.client?.client_id || null,
    data: {
      ...buildPendingRequestRejectionData(request, pending),
      error: {
        code: err.code || "api_error",
        message: err.message,
      },
    },
    object_id: isNonEmptyString(pending.device_code) ? pending.device_code : null,
    object_type: "pending_consent",
    status: "rejected",
  });
  return err;
}

function requireStructuredPendingRequestShape(request: unknown): asserts request is PendingRequest {
  if (!isRecord(request)) {
    throw bindingError("invalid_request", "pending request must be an object");
  }
  const unsupportedRequestFields = Object.keys(request).filter(
    (field) => !SUPPORTED_NORMALIZED_PENDING_REQUEST_FIELDS.has(field)
  );
  if (unsupportedRequestFields.length) {
    throw bindingError("invalid_request", `Unsupported pending request fields: ${unsupportedRequestFields.join(", ")}`);
  }
  if (request.request_kind !== "pdpp_selection_request") {
    throw bindingError("invalid_request", "request_kind must be pdpp_selection_request");
  }
  if (request.request_version !== "reference.v1") {
    throw bindingError("invalid_request", "request_version must be reference.v1");
  }
  if (!isRecord(request.client)) {
    throw bindingError("invalid_request", "client is required");
  }
  const unsupportedClientFields = Object.keys(request.client).filter(
    (field) => !SUPPORTED_PENDING_CLIENT_FIELDS.has(field)
  );
  if (unsupportedClientFields.length) {
    throw bindingError("invalid_request", `Unsupported pending client fields: ${unsupportedClientFields.join(", ")}`);
  }
  if (!isNonEmptyString(request.client.client_id)) {
    throw bindingError("invalid_request", "client.client_id is required");
  }
  if (!isRecord(request.selection)) {
    throw bindingError("invalid_request", "selection is required");
  }
  const unsupportedSelectionFields = Object.keys(request.selection).filter(
    (field) => !SUPPORTED_PENDING_SELECTION_FIELDS.has(field)
  );
  if (unsupportedSelectionFields.length) {
    throw bindingError(
      "invalid_request",
      `Unsupported pending selection fields: ${unsupportedSelectionFields.join(", ")}`
    );
  }
  if (request.selection.type !== "https://pdpp.org/data-access") {
    throw bindingError("invalid_request", "selection.type must be https://pdpp.org/data-access");
  }
  if (!Array.isArray(request.selection.streams) || request.selection.streams.length === 0) {
    throw bindingError("invalid_request", "selection.streams must be a non-empty array");
  }
  if (!isNonEmptyString(request.selection.access_mode)) {
    throw bindingError("invalid_request", "selection.access_mode is required");
  }
  for (const stream of request.selection.streams) {
    if (!stream || typeof stream !== "object") {
      throw bindingError("invalid_request", "selection.streams entries must be objects");
    }
    const unsupportedStreamFields = Object.keys(stream).filter(
      (field) => !SUPPORTED_STREAM_SELECTION_FIELDS.has(field)
    );
    if (unsupportedStreamFields.length) {
      throw bindingError(
        "invalid_request",
        `Unsupported pending stream selection fields on '${stream.name || "unknown"}': ${unsupportedStreamFields.join(", ")}`
      );
    }
  }
}

function requireStructuredSourceBinding(
  sourceBinding: unknown,
  { code, fieldName }: { code: string; fieldName: string }
): SourceBinding {
  if (!isRecord(sourceBinding)) {
    throw bindingError(code, `${fieldName} is required`);
  }
  if (!hasExactBindingKeys(sourceBinding, ["kind", "id"])) {
    throw bindingError(code, `${fieldName} must include only kind and id`);
  }
  if (sourceBinding.kind !== "connector" && sourceBinding.kind !== "provider_native") {
    throw bindingError(code, `${fieldName}.kind must be 'connector' or 'provider_native'`);
  }
  if (!isNonEmptyString(sourceBinding.id)) {
    throw bindingError(code, `${fieldName}.id is required`);
  }
  return { id: sourceBinding.id, kind: sourceBinding.kind };
}

function requireStructuredStorageBinding(
  storageBinding: unknown,
  { code, fieldName }: { code: string; fieldName: string }
): StorageBinding {
  if (!(isRecord(storageBinding) && isNonEmptyString(storageBinding.connector_id))) {
    throw bindingError(code, `${fieldName}.connector_id is required`);
  }
  return { connector_id: storageBinding.connector_id };
}

function hasExactBindingKeys(value: unknown, expectedKeys: string[] = []): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpectedKeys.length) {
    return false;
  }
  return sortedExpectedKeys.every((key, index) => actualKeys[index] === key);
}

function requireStructuredPendingRequestBindings(request: Partial<PendingRequest> = {}): {
  sourceBinding: SourceBinding;
  storageBinding: StorageBinding;
} {
  const requestSourceBinding = getRequestSourceBinding(request);
  const requestStorageBinding = getRequestStorageBinding(request);
  const sourceBinding = requireStructuredSourceBinding(requestSourceBinding, {
    code: "invalid_request",
    fieldName: "source_binding",
  });
  const storageBinding = requireStructuredStorageBinding(requestStorageBinding, {
    code: "invalid_request",
    fieldName: "storage_binding",
  });
  if (!hasExactBindingKeys(requestStorageBinding, ["connector_id"])) {
    throw bindingError("invalid_request", "storage_binding must include only connector_id");
  }

  if (sourceBinding.kind === "connector" && sourceBinding.id !== storageBinding.connector_id) {
    throw bindingError(
      "invalid_request",
      "source_binding.id must match storage_binding.connector_id for connector access"
    );
  }

  if (sourceBinding.kind === "provider_native") {
    const nativeManifest = resolveConfiguredNativeManifest();
    const nativeStorageBinding = resolveConfiguredNativeStorageBinding();
    if (!(nativeManifest?.provider_id && nativeStorageBinding?.connector_id)) {
      throw bindingError("invalid_request", "native provider access requires a configured native manifest");
    }
    if (sourceBinding.id !== nativeManifest.provider_id) {
      throw bindingError("invalid_request", "source_binding.id must match the configured native provider");
    }
    if (storageBinding.connector_id !== nativeStorageBinding.connector_id) {
      throw bindingError(
        "invalid_request",
        "storage_binding.connector_id must match the configured native storage binding"
      );
    }
  }

  return { sourceBinding, storageBinding };
}

function requireGrantManifestForBindings(
  sourceBinding: SourceBinding | null | undefined,
  storageBinding: StorageBinding | null | undefined,
  opts: { nativeManifest?: DbRow | null } = {}
): Promise<DbRow> {
  const grantStorageConnectorId = storageBinding?.connector_id || null;
  return getManifestForStorageBinding(storageBinding, opts).then((manifest) => {
    if (manifest) {
      return manifest;
    }
    const source =
      sourceBinding?.kind && sourceBinding?.id
        ? `{ kind: '${sourceBinding.kind}', id: '${sourceBinding.id}' }`
        : `{ kind: 'connector', id: '${grantStorageConnectorId || "unknown"}' }`;
    const err: AuthError = new Error(`Unknown source: ${source}`);
    err.code = "invalid_request";
    throw err;
  });
}

function requireRequestedManifestStream(
  manifest: DbRow,
  manifestStreams: Record<string, unknown>[],
  streamName: string
): Record<string, unknown> {
  try {
    assertManifestReadAuthority(manifest, streamName, { actor: "client" });
    const manifestStream = manifestStreams.find((stream) => stream.name === streamName);
    if (manifestStream) {
      return manifestStream;
    }
  } catch (cause: unknown) {
    const err = bindingError("invalid_request", `Unknown stream: ${streamName}`);
    err.cause = cause;
    throw err;
  }
  throw bindingError("invalid_request", `Unknown stream: ${streamName}`);
}

function resolveRequestedView(
  streamRequest: RawStreamSelection,
  manifestStream: Record<string, unknown>,
  streamName: string
): Pick<StreamSelection, "fields" | "view"> {
  if (!isNonEmptyString(streamRequest.view)) {
    throw bindingError("invalid_request", `Unknown view '${streamRequest.view}' on stream '${streamName}'`);
  }
  const manifestViews = Array.isArray(manifestStream.views) ? manifestStream.views.filter(isRecord) : [];
  const viewDef = manifestViews.find((view) => view.id === streamRequest.view);
  if (!(viewDef && isNonEmptyStringArray(viewDef.fields))) {
    throw bindingError("invalid_request", `Unknown view '${streamRequest.view}' on stream '${streamName}'`);
  }
  return { fields: viewDef.fields, view: streamRequest.view };
}

function resolveRequestedFields(
  streamRequest: RawStreamSelection,
  manifestStream: Record<string, unknown>,
  streamName: string
): Pick<StreamSelection, "fields"> {
  if (!(isRecord(manifestStream.selection) && manifestStream.selection.fields)) {
    throw bindingError("invalid_request", `Stream '${streamName}' does not support field-level selection`);
  }
  if (!isNonEmptyStringArray(streamRequest.fields)) {
    throw bindingError("invalid_request", `Stream '${streamName}' fields must be a non-empty array of field names`);
  }
  const schemaProperties =
    isRecord(manifestStream.schema) && isRecord(manifestStream.schema.properties)
      ? manifestStream.schema.properties
      : {};
  const allowedFields = new Set(Object.keys(schemaProperties));
  const unknownFields = streamRequest.fields.filter((field) => !allowedFields.has(field));
  if (unknownFields.length) {
    throw bindingError("invalid_request", `Unknown fields on stream '${streamName}': ${unknownFields.join(", ")}`);
  }
  return { fields: streamRequest.fields };
}

function resolveGrantStream(
  streamRequest: RawStreamSelection,
  manifest: DbRow,
  manifestStreams: Record<string, unknown>[]
): StreamSelection {
  if (!isNonEmptyString(streamRequest.name)) {
    throw bindingError("invalid_request", "Stream name must be a non-empty string");
  }
  const streamName = streamRequest.name;
  const manifestStream = requireRequestedManifestStream(manifest, manifestStreams, streamName);
  if (streamRequest.time_range && !manifestStream.consent_time_field) {
    throw bindingError("invalid_request", `Stream '${streamName}' does not support time_range (no consent_time_field)`);
  }
  if (streamRequest.view && streamRequest.fields) {
    throw bindingError("invalid_request", `Stream '${streamName}' view and fields are mutually exclusive`);
  }

  let projection: Pick<StreamSelection, "fields" | "view"> = {};
  if (streamRequest.view) {
    projection = resolveRequestedView(streamRequest, manifestStream, streamName);
  } else if (streamRequest.fields) {
    projection = resolveRequestedFields(streamRequest, manifestStream, streamName);
  }
  return {
    ...projection,
    ...(isRecord(streamRequest.time_range) ? { time_range: streamRequest.time_range } : {}),
    ...(streamRequest.resources ? { resources: streamRequest.resources } : {}),
    ...(isNonEmptyString(streamRequest.connection_id) ? { connection_id: streamRequest.connection_id } : {}),
    name: streamName,
  };
}

function resolveGrantSelection(selection: Partial<GrantSelection> = {}, manifest: DbRow = {}): StreamSelection[] {
  let streams = selection.streams || [];
  const manifestStreams = getManifestStreams(manifest);
  const onlyStream = streams.length === 1 ? streams[0] : undefined;
  if (onlyStream?.name === "*") {
    // Expanding the wildcard MUST preserve a per-stream `connection_id`
    // constraint. A wildcard pinned to a connection (the hosted MCP picker's
    // whole-source approval for a chosen sibling connection) means "every
    // stream, but only from this connection" — dropping the pin here would
    // silently fan the grant back in across every connection of the connector.
    const wildcardConnectionId = isNonEmptyString(onlyStream.connection_id) ? onlyStream.connection_id : null;
    streams = manifestStreams.map((stream) =>
      wildcardConnectionId ? { connection_id: wildcardConnectionId, name: stream.name } : { name: stream.name }
    );
  }
  return streams.map((streamRequest) => resolveGrantStream(streamRequest, manifest, manifestStreams));
}

function requireStructuredGrantBindings(
  grant: DbRow,
  storageBinding: unknown
): { sourceBinding: SourceBinding; storageBinding: StorageBinding } {
  const sourceBinding = requireStructuredSourceBinding(grant.source, {
    code: "grant_invalid",
    fieldName: "grant.source",
  });
  const normalizedStorageBinding = requireStructuredStorageBinding(storageBinding, {
    code: "grant_invalid",
    fieldName: "grant_storage_binding",
  });
  if (!hasExactBindingKeys(storageBinding, ["connector_id"])) {
    throw bindingError("grant_invalid", "grant_storage_binding must include only connector_id");
  }

  if (sourceBinding.kind === "connector" && sourceBinding.id !== normalizedStorageBinding.connector_id) {
    throw bindingError(
      "grant_invalid",
      "grant.source.id must match grant_storage_binding.connector_id for connector access"
    );
  }

  if (sourceBinding.kind === "provider_native") {
    const nativeManifest = resolveConfiguredNativeManifest();
    const nativeStorageBinding = resolveConfiguredNativeStorageBinding();
    if (!(nativeManifest?.provider_id && nativeStorageBinding?.connector_id)) {
      throw bindingError("grant_invalid", "provider-native grants require a configured native manifest");
    }
    if (sourceBinding.id !== nativeManifest.provider_id) {
      throw bindingError("grant_invalid", "grant.source.id must match the configured native provider");
    }
    if (normalizedStorageBinding.connector_id !== nativeStorageBinding.connector_id) {
      throw bindingError(
        "grant_invalid",
        "grant_storage_binding.connector_id must match the configured native storage binding"
      );
    }
  }

  return { sourceBinding, storageBinding: normalizedStorageBinding };
}

function describeSourceBinding(sourceBinding: SourceBinding | null | undefined): SourceBinding | null {
  if (
    sourceBinding &&
    (sourceBinding.kind === "connector" || sourceBinding.kind === "provider_native") &&
    isNonEmptyString(sourceBinding.id)
  ) {
    return { id: sourceBinding.id, kind: sourceBinding.kind };
  }
  return null;
}

function describeGrantSource(grant: DbRow | null | undefined): SourceBinding | null {
  try {
    return grant
      ? requireStructuredSourceBinding(grant.source, { code: "grant_invalid", fieldName: "grant.source" })
      : null;
  } catch {
    return null;
  }
}

function normalizeStorageBinding(storageBinding: StorageBinding | null | undefined): StorageBinding | null {
  if (!storageBinding?.connector_id) {
    return null;
  }
  return { connector_id: storageBinding.connector_id };
}

function serializeStorageBinding(storageBinding: StorageBinding | null | undefined): string | null {
  return storageBinding ? JSON.stringify(storageBinding) : null;
}

function parseStorageBindingJson(raw: unknown): StorageBinding | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && isNonEmptyString(parsed.connector_id)
      ? { ...parsed, connector_id: parsed.connector_id }
      : null;
  } catch {
    return null;
  }
}

function readPersistedGrantStorageBinding(row: DbRow = {}): StorageBinding | null {
  return parseStorageBindingJson(row.storage_binding_json);
}

function describePersistedGrantSource(row: DbRow = {}): SourceBinding | null {
  try {
    if (!isNonEmptyString(row.grant_json)) {
      return null;
    }
    const grant = JSON.parse(row.grant_json);
    const sourceBinding = requireStructuredSourceBinding(isRecord(grant) ? grant.source : null, {
      code: "grant_invalid",
      fieldName: "grant.source",
    });
    return describeSourceBinding(sourceBinding);
  } catch {
    return null;
  }
}

function buildGrantInvalidError(context: { request_id?: string | null; trace_id?: string | null } = {}): AuthError {
  const err: AuthError = new Error("Grant is malformed or no longer valid");
  err.code = "grant_invalid";
  if (context.request_id) {
    err.request_id = context.request_id;
  }
  if (context.trace_id) {
    err.trace_id = context.trace_id;
  }
  return err;
}

function hasExactFieldSet(fields: unknown[] = [], expectedFields: string[] = []): boolean {
  if (!(Array.isArray(fields) && Array.isArray(expectedFields)) || fields.length !== expectedFields.length) {
    return false;
  }
  const actual = new Set(fields);
  if (actual.size !== expectedFields.length) {
    return false;
  }
  return expectedFields.every((field) => actual.has(field));
}

function requirePersistedGrantManifestStream(
  streamGrant: Record<string, unknown>,
  manifest: DbRow,
  manifestStreams: Record<string, unknown>[]
): Record<string, unknown> {
  const streamName = String(streamGrant.name);
  try {
    assertManifestReadAuthority(manifest, streamName, { actor: "client" });
    const manifestStream = manifestStreams.find((stream) => stream.name === streamName);
    if (manifestStream) {
      return manifestStream;
    }
  } catch (cause: unknown) {
    const err = bindingError("grant_invalid", `Unknown stream in persisted grant: ${streamName}`);
    err.cause = cause;
    throw err;
  }
  throw bindingError("grant_invalid", `Unknown stream in persisted grant: ${streamName}`);
}

function requirePersistedGrantView(
  streamGrant: Record<string, unknown>,
  manifestStream: Record<string, unknown>
): void {
  const manifestViews = Array.isArray(manifestStream.views) ? manifestStream.views.filter(isRecord) : [];
  const viewDef = manifestViews.find((view) => view.id === streamGrant.view);
  if (!viewDef) {
    throw bindingError(
      "grant_invalid",
      `Unknown persisted grant view '${streamGrant.view}' on stream '${streamGrant.name}'`
    );
  }
  if (!isNonEmptyStringArray(streamGrant.fields)) {
    throw bindingError(
      "grant_invalid",
      `Persisted grant view '${streamGrant.view}' on stream '${streamGrant.name}' must include resolved fields`
    );
  }
  if (!(isNonEmptyStringArray(viewDef.fields) && hasExactFieldSet(streamGrant.fields, viewDef.fields))) {
    throw bindingError(
      "grant_invalid",
      `Persisted grant view '${streamGrant.view}' on stream '${streamGrant.name}' no longer matches the manifest view definition`
    );
  }
}

function requirePersistedGrantFields(
  streamGrant: Record<string, unknown>,
  manifestStream: Record<string, unknown>
): void {
  if (!(isRecord(manifestStream.selection) && manifestStream.selection.fields)) {
    throw bindingError(
      "grant_invalid",
      `Persisted grant stream '${streamGrant.name}' does not support field-level selection`
    );
  }
  if (!isNonEmptyStringArray(streamGrant.fields)) {
    throw bindingError(
      "grant_invalid",
      `Persisted grant stream '${streamGrant.name}' fields must be a non-empty array of field names`
    );
  }
  const schemaProperties =
    isRecord(manifestStream.schema) && isRecord(manifestStream.schema.properties)
      ? manifestStream.schema.properties
      : {};
  const allowedFields = new Set(Object.keys(schemaProperties));
  const unknownFields = streamGrant.fields.filter((field) => !allowedFields.has(field));
  if (unknownFields.length) {
    throw bindingError(
      "grant_invalid",
      `Unknown fields in persisted grant stream '${streamGrant.name}': ${unknownFields.join(", ")}`
    );
  }
}

function requirePersistedGrantStream(
  streamGrant: unknown,
  manifest: DbRow,
  manifestStreams: Record<string, unknown>[]
): void {
  if (!(isRecord(streamGrant) && isNonEmptyString(streamGrant.name))) {
    throw bindingError("grant_invalid", "grant.streams entries must include a non-empty name");
  }
  const manifestStream = requirePersistedGrantManifestStream(streamGrant, manifest, manifestStreams);
  if (streamGrant.time_range && !manifestStream.consent_time_field) {
    throw bindingError(
      "grant_invalid",
      `Persisted grant stream '${streamGrant.name}' does not support time_range (no consent_time_field)`
    );
  }
  if (streamGrant.view) {
    requirePersistedGrantView(streamGrant, manifestStream);
  } else if (streamGrant.fields) {
    requirePersistedGrantFields(streamGrant, manifestStream);
  }
}

export function requireGrantContractAgainstManifest(grant: DbRow = {}, manifest: DbRow = {}): void {
  if (!isNonEmptyString(grant.manifest_version)) {
    throw bindingError("grant_invalid", "grant.manifest_version is required");
  }
  if (typeof grant.access_mode !== "string" || !SUPPORTED_ACCESS_MODES.has(grant.access_mode)) {
    throw bindingError("grant_invalid", 'grant.access_mode must be "single_use" or "continuous"');
  }
  if (!isNonEmptyString(manifest.version) || grant.manifest_version !== manifest.version) {
    throw bindingError(
      "grant_invalid",
      `grant.manifest_version '${grant.manifest_version}' does not match current manifest version '${manifest.version || "unknown"}'`
    );
  }
  if (!Array.isArray(grant.streams) || grant.streams.length === 0) {
    throw bindingError("grant_invalid", "grant.streams must be a non-empty array");
  }
  const manifestStreams = getManifestStreams(manifest);
  for (const streamGrant of grant.streams) {
    requirePersistedGrantStream(streamGrant, manifest, manifestStreams);
  }
}

function requirePendingRequestContractAgainstManifest(
  request: Partial<PendingRequest> = {},
  manifest: DbRow = {}
): StreamSelection[] {
  if (!isNonEmptyString(request.manifest_version)) {
    throw bindingError("invalid_request", "pending request manifest_version is required");
  }
  if (!isNonEmptyString(manifest.version) || request.manifest_version !== manifest.version) {
    throw bindingError(
      "invalid_request",
      `Pending consent request manifest_version '${request.manifest_version}' does not match current manifest version '${manifest.version || "unknown"}'`
    );
  }
  return resolveGrantSelection(request.selection, manifest);
}

async function requirePendingRequestClientRegistration(
  request: Partial<PendingRequest> = {},
  opts: Record<string, unknown> = {}
): Promise<RegisteredClient> {
  const clientId = request.client?.client_id || null;
  if (!clientId) {
    throw bindingError("invalid_request", "client.client_id is required");
  }
  const registeredClient = await resolveOAuthClient(clientId, opts);
  if (!registeredClient) {
    throw bindingError("invalid_client", `Unknown client_id: ${clientId}`);
  }
  if (!request.client) {
    throw bindingError("invalid_request", "client is required");
  }
  applyRegisteredClientToPendingRequestClient({ client: request.client }, registeredClient);
  return registeredClient;
}

export function requirePersistedGrantState(row: DbRow = {}): {
  grant: DbRow;
  sourceBinding: SourceBinding;
  storageBinding: StorageBinding;
} {
  try {
    if (!isNonEmptyString(row.grant_json)) {
      throw buildGrantInvalidError();
    }
    const parsedGrant = JSON.parse(row.grant_json);
    if (!isRecord(parsedGrant)) {
      throw buildGrantInvalidError();
    }
    const grant: DbRow = parsedGrant;
    const bindings = requireStructuredGrantBindings(grant, readPersistedGrantStorageBinding(row));
    grant.source = describeSourceBinding(bindings.sourceBinding);
    return {
      grant,
      sourceBinding: bindings.sourceBinding,
      storageBinding: bindings.storageBinding,
    };
  } catch (cause: unknown) {
    const err = buildGrantInvalidError();
    err.cause = cause;
    throw err;
  }
}

export async function requireResolvedPersistedGrantState(
  row: DbRow = {},
  opts: { nativeManifest?: DbRow | null } = {}
): Promise<{ grant: DbRow; sourceBinding: SourceBinding; storageBinding: StorageBinding; manifest: DbRow }> {
  try {
    const { grant, sourceBinding, storageBinding } = requirePersistedGrantState(row);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    requireGrantContractAgainstManifest(grant, manifest);
    return {
      grant,
      manifest,
      sourceBinding,
      storageBinding,
    };
  } catch (err: unknown) {
    if (isAuthError(err) && err.code === "grant_invalid") {
      throw buildGrantInvalidError();
    }
    throw err;
  }
}

// ─── Consent + owner-device-auth stores ────────────────────────────────────
//
// Two cohesive, domain-local stores for the consent and owner-device-auth
// drift seams. Each method is the SAME conceptual row op differing ONLY by SQL
// dialect (placeholder $1.. vs ?, the params_json::text cast, boolean coercion
// true|null vs 1|null). Dialect SQL/queries move VERBATIM from the old inline
// branches; the adapters return RAW rows (or perform the write) and any
// caller-side concerns (the approval_id guard, JSON.stringify, trace context,
// nowIso timestamps) stay in the calling function. The backend is selected
// ONCE per op via isPostgresStorageBackend(), mirroring the existing
// search.js getSearchIndexStore / VectorIndex / BlobStore precedent. Each
// backend keeps its OWN coercion; the boolean ai_training_consented is
// true|null on Postgres and 1|null on SQLite and must NOT be unified.

const postgresPendingConsentStore: PendingConsentStore = {
  getByApprovalId: (approvalId) =>
    pgOne<PendingConsentRow>(
      `SELECT device_code, user_code, params_json::text AS params_json, status,
              subject_id, grant_id, token_id, ai_training_consented,
              request_id, trace_id, scenario_id, created_at, expires_at,
              approved_at, denied_at, interval_seconds, last_polled_at, approval_id
       FROM pending_consents
       WHERE approval_id = $1`,
      [approvalId]
    ),
  getByDeviceCode: (deviceCode) =>
    pgOne<PendingConsentRow>(
      `SELECT device_code, user_code, params_json::text AS params_json, status,
              subject_id, grant_id, token_id, ai_training_consented,
              request_id, trace_id, scenario_id, created_at, expires_at,
              approved_at, denied_at, interval_seconds, last_polled_at, approval_id
       FROM pending_consents
       WHERE device_code = $1`,
      [deviceCode]
    ),
  insert: ({ deviceCode, userCode, params, traceContext, createdAt, expiresAt, approvalId }) =>
    pgExec(
      `INSERT INTO pending_consents(
         device_code, user_code, params_json, status,
         request_id, trace_id, scenario_id, created_at, expires_at, approval_id
       ) VALUES($1, $2, $3::jsonb, 'pending', $4, $5, $6, $7, $8, $9)`,
      [
        deviceCode,
        userCode,
        JSON.stringify(params),
        traceContext.request_id,
        traceContext.trace_id,
        traceContext.scenario_id || null,
        createdAt,
        expiresAt,
        approvalId,
      ]
    ),
  markApproved: ({ deviceCode, subjectId, grantId, tokenId, aiTrainingConsented, approvedAt }) =>
    pgExec(
      `UPDATE pending_consents
       SET status = 'approved',
           subject_id = $1,
           grant_id = $2,
           token_id = $3,
           ai_training_consented = $4,
           approved_at = $5
       WHERE device_code = $6`,
      [subjectId, grantId, tokenId, aiTrainingConsented ? true : null, approvedAt, deviceCode]
    ),
  markDenied: ({ deviceCode, deniedAt }) =>
    pgExec(
      `UPDATE pending_consents
       SET status = 'denied', denied_at = $1
       WHERE device_code = $2 AND status = 'pending'`,
      [deniedAt, deviceCode]
    ),
  markExpired: ({ deviceCode }) =>
    pgExec("UPDATE pending_consents SET status = 'expired' WHERE device_code = $1 AND status = 'pending'", [
      deviceCode,
    ]),
  updateLastPolled: ({ deviceCode, polledAt }) =>
    pgExec("UPDATE pending_consents SET last_polled_at = $1 WHERE device_code = $2", [polledAt, deviceCode]),
};

const sqlitePendingConsentStore: PendingConsentStore = {
  getByApprovalId: (approvalId) =>
    getOne<PendingConsentRow>(referenceQueries.authPendingConsentsGetByApprovalId, [approvalId]),
  getByDeviceCode: (deviceCode) =>
    getOne<PendingConsentRow>(referenceQueries.authPendingConsentsGetByDeviceCode, [deviceCode]),
  insert: ({ deviceCode, userCode, params, traceContext, createdAt, expiresAt, approvalId }) =>
    exec(referenceQueries.authPendingConsentsInsert, [
      deviceCode,
      userCode,
      JSON.stringify(params),
      traceContext.request_id,
      traceContext.trace_id,
      traceContext.scenario_id || null,
      createdAt,
      expiresAt,
      approvalId,
    ]),
  markApproved: ({ deviceCode, subjectId, grantId, tokenId, aiTrainingConsented, approvedAt }) =>
    exec(referenceQueries.authPendingConsentsMarkApproved, [
      subjectId,
      grantId,
      tokenId,
      aiTrainingConsented ? 1 : null,
      approvedAt,
      deviceCode,
    ]),
  markDenied: ({ deviceCode, deniedAt }) =>
    exec(referenceQueries.authPendingConsentsMarkDenied, [deniedAt, deviceCode]),
  markExpired: ({ deviceCode }) => exec(referenceQueries.authPendingConsentsMarkExpired, [deviceCode]),
  updateLastPolled: ({ deviceCode, polledAt }) => {
    const query = requireMutationQuery(
      referenceQueries.authPendingConsentsUpdateLastPolled,
      "authPendingConsentsUpdateLastPolled"
    );
    return exec(query, [polledAt, deviceCode]);
  },
};

function getPendingConsentStore() {
  return isPostgresStorageBackend() ? postgresPendingConsentStore : sqlitePendingConsentStore;
}

const postgresOwnerDeviceAuthStore: OwnerDeviceAuthStore = {
  getByApprovalId: (approvalId) =>
    pgOne<OwnerDeviceAuthRow>(
      `SELECT *
       FROM owner_device_auth
       WHERE approval_id = $1`,
      [approvalId]
    ),
  getByDeviceCode: (deviceCode) =>
    pgOne<OwnerDeviceAuthRow>(
      `SELECT *
       FROM owner_device_auth
       WHERE device_code = $1`,
      [deviceCode]
    ),
  getByUserCode: (userCode) =>
    pgOne<OwnerDeviceAuthRow>(
      `SELECT *
       FROM owner_device_auth
       WHERE user_code = $1`,
      [userCode]
    ),
  insert: ({
    deviceCode,
    userCode,
    clientId,
    intervalSeconds,
    createdAt,
    expiresAt,
    requestId,
    traceId,
    scenarioId,
    approvalId,
  }) =>
    pgExec(
      `INSERT INTO owner_device_auth(
         device_code, user_code, client_id, status, interval_seconds,
         created_at, expires_at, request_id, trace_id, scenario_id, approval_id
       ) VALUES($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10)`,
      [
        deviceCode,
        userCode,
        clientId,
        intervalSeconds,
        createdAt,
        expiresAt,
        requestId,
        traceId,
        scenarioId,
        approvalId,
      ]
    ),
  markApproved: ({ deviceCode, subjectId, tokenId, approvedAt }) =>
    pgExec(
      `UPDATE owner_device_auth
       SET status = 'approved',
           subject_id = $1,
           token_id = $2,
           approved_at = $3
       WHERE device_code = $4`,
      [subjectId, tokenId, approvedAt, deviceCode]
    ),
  markDenied: ({ deviceCode, deniedAt }) =>
    pgExec(
      `UPDATE owner_device_auth
       SET status = 'denied', denied_at = $1
       WHERE device_code = $2 AND status = 'pending'`,
      [deniedAt, deviceCode]
    ),
  markExpired: ({ deviceCode }) =>
    pgExec("UPDATE owner_device_auth SET status = 'expired' WHERE device_code = $1 AND status = 'pending'", [
      deviceCode,
    ]),
  updateLastPolled: ({ deviceCode, polledAt }) =>
    pgExec("UPDATE owner_device_auth SET last_polled_at = $1 WHERE device_code = $2", [polledAt, deviceCode]),
};

const sqliteOwnerDeviceAuthStore: OwnerDeviceAuthStore = {
  getByApprovalId: (approvalId) =>
    getOne<OwnerDeviceAuthRow>(referenceQueries.authOwnerDeviceAuthGetByApprovalId, [approvalId]),
  getByDeviceCode: (deviceCode) =>
    getOne<OwnerDeviceAuthRow>(referenceQueries.authOwnerDeviceAuthGetByDeviceCode, [deviceCode]),
  getByUserCode: (userCode) =>
    getOne<OwnerDeviceAuthRow>(referenceQueries.authOwnerDeviceAuthGetByUserCode, [userCode]),
  insert: ({
    deviceCode,
    userCode,
    clientId,
    intervalSeconds,
    createdAt,
    expiresAt,
    requestId,
    traceId,
    scenarioId,
    approvalId,
  }) =>
    exec(referenceQueries.authOwnerDeviceAuthInsert, [
      deviceCode,
      userCode,
      clientId,
      intervalSeconds,
      createdAt,
      expiresAt,
      requestId,
      traceId,
      scenarioId,
      approvalId,
    ]),
  markApproved: ({ deviceCode, subjectId, tokenId, approvedAt }) =>
    exec(referenceQueries.authOwnerDeviceAuthMarkApproved, [subjectId, tokenId, approvedAt, deviceCode]),
  markDenied: ({ deviceCode, deniedAt }) =>
    exec(referenceQueries.authOwnerDeviceAuthMarkDenied, [deniedAt, deviceCode]),
  markExpired: ({ deviceCode }) => exec(referenceQueries.authOwnerDeviceAuthMarkExpired, [deviceCode]),
  updateLastPolled: ({ deviceCode, polledAt }) =>
    exec(referenceQueries.authOwnerDeviceAuthUpdateLastPolled, [polledAt, deviceCode]),
};

function getOwnerDeviceAuthStore() {
  return isPostgresStorageBackend() ? postgresOwnerDeviceAuthStore : sqliteOwnerDeviceAuthStore;
}

// ─── Registered-client / CIMD-document / connector-catalog stores ────────────
//
// Three cohesive, domain-local stores for the oauth_clients,
// cimd_client_documents, and connectors drift seams. Each method is the SAME
// conceptual row op differing ONLY by SQL dialect (placeholder $1.. vs ?, the
// ::jsonb / ::text casts, column order). Dialect SQL moves VERBATIM from the
// old inline branches; the adapters return RAW rows (or perform the write) and
// any caller-side concerns (mapRegisteredClientRow, the redirect_uris JSON
// shaping, the active-token-count orchestration, spine events) stay in the
// calling function. The backend is selected ONCE per op via
// isPostgresStorageBackend(), mirroring the getPendingConsentStore /
// getOwnerDeviceAuthStore precedent above. Each backend keeps its own read
// primitive (postgresQuery/pgOne/pgExec vs getOne/exec/allowUnboundedReadAcknowledged).

const postgresRegisteredClientStore: RegisteredClientStore = {
  countActiveTokensByClientId: (clientId) =>
    pgOne(
      `SELECT COUNT(*)::int AS active_token_count
       FROM tokens
       WHERE client_id = $1 AND revoked = FALSE`,
      [clientId]
    ),
  deleteByClientId: (clientId) => pgExec("DELETE FROM oauth_clients WHERE client_id = $1", [clientId]),
  getByClientId: (clientId) =>
    pgOne<RegisteredClientRow>(
      `SELECT client_id, registration_mode, token_endpoint_auth_method,
              client_secret, metadata_json::text AS metadata_json, created_at, updated_at
       FROM oauth_clients
       WHERE client_id = $1`,
      [clientId]
    ),
  listByIssuerSubject: async (subjectId) =>
    (
      await postgresQuery<RegisteredClientRow>(
        `SELECT client_id, client_secret, registration_mode, token_endpoint_auth_method,
              metadata_json::text AS metadata_json, created_at, updated_at
       FROM oauth_clients
       WHERE registration_mode = 'dynamic'
         AND metadata_json->>'issuer_subject_id' = $1
       ORDER BY created_at DESC`,
        [subjectId]
      )
    ).rows,
  upsert: ({ clientId, registrationMode, tokenEndpointAuthMethod, clientSecret, persistedMetadataJson, timestamp }) =>
    pgExec(
      `INSERT INTO oauth_clients(
         client_id, registration_mode, token_endpoint_auth_method,
         client_secret, metadata_json, created_at, updated_at
       ) VALUES($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (client_id) DO UPDATE SET
         registration_mode = EXCLUDED.registration_mode,
         token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
         client_secret = EXCLUDED.client_secret,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
      [clientId, registrationMode, tokenEndpointAuthMethod, clientSecret, persistedMetadataJson, timestamp, timestamp]
    ),
};

const sqliteRegisteredClientStore: RegisteredClientStore = {
  countActiveTokensByClientId: (clientId) => getOne(referenceQueries.authTokensCountActiveByClientId, [clientId]),
  deleteByClientId: (clientId) => exec(referenceQueries.authOauthClientsDeleteByClientId, [clientId]),
  getByClientId: (clientId) => getOne<RegisteredClientRow>(referenceQueries.authOauthClientsGetByClientId, [clientId]),
  // REVIEWED-BOUNDED: per-operator dashboard-issued tokens are operator-scale
  // (small in practice). The query's @max_rows=256 caps pathological growth.
  listByIssuerSubject: (subjectId) =>
    allowUnboundedReadAcknowledged<RegisteredClientRow>(referenceQueries.authOauthClientsListByIssuerSubject, [
      subjectId,
    ]),
  upsert: ({ clientId, registrationMode, tokenEndpointAuthMethod, clientSecret, persistedMetadataJson, timestamp }) =>
    exec(referenceQueries.authOauthClientsUpsert, [
      clientId,
      registrationMode,
      tokenEndpointAuthMethod,
      clientSecret,
      persistedMetadataJson,
      timestamp,
      timestamp,
    ]),
};

function getRegisteredClientStore() {
  return isPostgresStorageBackend() ? postgresRegisteredClientStore : sqliteRegisteredClientStore;
}

const postgresCimdStore: CimdStore = {
  getById: (documentId) =>
    pgOne<CimdRow>(
      `SELECT document_id, client_name, redirect_uris::text AS redirect_uris, logo_uri, created_at, updated_at
       FROM cimd_client_documents WHERE document_id = $1`,
      [documentId]
    ),
  insert: ({ documentId, clientName, redirectUrisJson, logoUri, now }) =>
    pgExec(
      `INSERT INTO cimd_client_documents(document_id, client_name, redirect_uris, logo_uri, created_at, updated_at)
       VALUES($1, $2, $3::jsonb, $4, $5, $6)`,
      [documentId, clientName, redirectUrisJson, logoUri, now, now]
    ),
  listAll: async () =>
    (
      await postgresQuery<CimdRow>(
        "SELECT document_id, client_name, redirect_uris::text AS redirect_uris, logo_uri, created_at, updated_at FROM cimd_client_documents ORDER BY created_at DESC"
      )
    ).rows,
};

const sqliteCimdStore: CimdStore = {
  getById: (documentId) =>
    getDb()
      .prepare(
        "SELECT document_id, client_name, redirect_uris, logo_uri, created_at, updated_at FROM cimd_client_documents WHERE document_id = ?"
      )
      .get<CimdRow>(documentId),
  insert: ({ documentId, clientName, redirectUrisJson, logoUri, now }) =>
    getDb()
      .prepare(
        "INSERT INTO cimd_client_documents(document_id, client_name, redirect_uris, logo_uri, created_at, updated_at) VALUES(?,?,?,?,?,?)"
      )
      .run(documentId, clientName, redirectUrisJson, logoUri, now, now),
  listAll: () =>
    getDb()
      .prepare(
        "SELECT document_id, client_name, redirect_uris, logo_uri, created_at, updated_at FROM cimd_client_documents ORDER BY created_at DESC"
      )
      .all<CimdRow>(),
};

function getCimdStore() {
  return isPostgresStorageBackend() ? postgresCimdStore : sqliteCimdStore;
}

const postgresConnectorCatalogStore: ConnectorCatalogStore = {
  getManifestById: (connectorId) =>
    pgOne(
      `SELECT manifest::text AS manifest
       FROM connectors
       WHERE connector_id = $1`,
      [connectorId]
    ),
  listIds: async () =>
    (
      await postgresQuery<GrantPackageMemberRow>(
        `SELECT connector_id
       FROM connectors
       ORDER BY connector_id ASC`
      )
    ).rows,
  upsert: ({ connectorId, manifestJson }) =>
    pgExec(
      `INSERT INTO connectors(connector_id, manifest)
       VALUES($1, $2::jsonb)
       ON CONFLICT (connector_id) DO UPDATE SET manifest = EXCLUDED.manifest`,
      [connectorId, manifestJson]
    ),
};

const sqliteConnectorCatalogStore: ConnectorCatalogStore = {
  getManifestById: (connectorId) => getOne(referenceQueries.authConnectorsGetManifestById, [connectorId]),
  // REVIEWED-BOUNDED: connectors table is O(registered providers); whole-table scan is acceptable.
  listIds: () => allowUnboundedReadAcknowledged(referenceQueries.authConnectorsListIds),
  upsert: ({ connectorId, manifestJson }) => exec(referenceQueries.authConnectorsUpsert, [connectorId, manifestJson]),
};

/**
 * The registry write is the manifest-generation boundary.  The manifest row,
 * every affected connection's monotonic generation, and the disposable
 * summary invalidation commit together.  Do not move this into summary
 * repair: an unobserved remove/re-add must still advance twice.
 */
function canonicalManifestJson(rawManifest: string): string {
  const value = JSON.parse(rawManifest);
  return JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return candidate;
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(candidate).sort()) {
      sorted[key] = candidate[key];
    }
    return sorted;
  });
}

async function persistManifestAndAdvanceGenerations(connectorId: string, manifestJson: string): Promise<boolean> {
  if (isPostgresStorageBackend()) {
    return await withPostgresTransaction(async (client) => {
      const changed = await client.query(
        `INSERT INTO connectors(connector_id, manifest)
         VALUES($1, $2::jsonb)
         ON CONFLICT (connector_id) DO UPDATE SET manifest = EXCLUDED.manifest
           WHERE connectors.manifest IS DISTINCT FROM EXCLUDED.manifest
         RETURNING connector_id`,
        [connectorId, manifestJson]
      );
      if (changed.rowCount === 0) {
        return false;
      }
      await client.query(
        `UPDATE connector_instances
            SET manifest_generation = manifest_generation + 1
          WHERE connector_id = $1`,
        [connectorId]
      );
      await client.query(
        `UPDATE connector_summary_evidence
            SET dirty = 1, state = 'stale'
          WHERE connector_id = $1`,
        [connectorId]
      );
      return true;
    });
  }
  return transaction(() => {
    const db = getDb();
    const existing = db
      .prepare("SELECT manifest FROM connectors WHERE connector_id = ?")
      .get<{ manifest?: string }>(connectorId);
    if (existing?.manifest && canonicalManifestJson(existing.manifest) === canonicalManifestJson(manifestJson)) {
      return false;
    }
    execDynamicSqlAcknowledged(
      `INSERT INTO connectors(connector_id, manifest) VALUES(?, ?)
       ON CONFLICT(connector_id) DO UPDATE SET manifest = excluded.manifest`,
      [connectorId, manifestJson]
    );
    execDynamicSqlAcknowledged(
      "UPDATE connector_instances SET manifest_generation = manifest_generation + 1 WHERE connector_id = ?",
      [connectorId]
    );
    execDynamicSqlAcknowledged(
      "UPDATE connector_summary_evidence SET dirty = 1, state = 'stale' WHERE connector_id = ?",
      [connectorId]
    );
    return true;
  });
}

function getConnectorCatalogStore() {
  return isPostgresStorageBackend() ? postgresConnectorCatalogStore : sqliteConnectorCatalogStore;
}

async function getPendingConsentRow(deviceCode: string): Promise<PendingConsentRow | null> {
  return await getPendingConsentStore().getByDeviceCode(deviceCode);
}

async function createPendingConsent(
  deviceCode: string,
  userCode: string,
  params: PendingRequest | StagedBatchRequest,
  expiresAt: string
): Promise<void> {
  const createdAt = nowIso();
  const traceContext = getRequestTraceContext(params);
  // approval_id is the non-redeemable opaque public id for `_ref/approvals`
  // projections. Generated alongside the row so every public read surface
  // has a stable id without exposing the live device_code.
  const approvalId = generateId("appr");
  await getPendingConsentStore().insert({
    approvalId,
    createdAt,
    deviceCode,
    expiresAt,
    params,
    traceContext,
    userCode,
  });
}

export async function getPendingConsentRowByApprovalId(approvalId: unknown): Promise<PendingConsentRow | null> {
  if (typeof approvalId !== "string" || !approvalId) {
    return null;
  }
  return await getPendingConsentStore().getByApprovalId(approvalId);
}

async function markPendingConsentApproved(
  deviceCode: string,
  {
    subjectId,
    grantId,
    tokenId,
    aiTrainingConsented,
  }: { subjectId: string; grantId: string; tokenId: string; aiTrainingConsented: boolean | null | undefined }
): Promise<void> {
  await getPendingConsentStore().markApproved({
    aiTrainingConsented,
    approvedAt: nowIso(),
    deviceCode,
    grantId,
    subjectId,
    tokenId,
  });
}

async function markPendingConsentDenied(deviceCode: string): Promise<void> {
  await getPendingConsentStore().markDenied({ deniedAt: nowIso(), deviceCode });
}

async function markPendingConsentExpired(deviceCode: string): Promise<void> {
  await getPendingConsentStore().markExpired({ deviceCode });
}

async function updatePendingConsentLastPolled(deviceCode: string): Promise<void> {
  const polledAt = nowIso();
  await getPendingConsentStore().updateLastPolled({ deviceCode, polledAt });
}

async function getOwnerDeviceAuthRow(deviceCode: unknown): Promise<OwnerDeviceAuthRow | null> {
  if (!isNonEmptyString(deviceCode)) {
    return null;
  }
  return await getOwnerDeviceAuthStore().getByDeviceCode(deviceCode);
}

async function getOwnerDeviceAuthRowByUserCode(userCode: unknown): Promise<OwnerDeviceAuthRow | null> {
  if (!isNonEmptyString(userCode)) {
    return null;
  }
  return await getOwnerDeviceAuthStore().getByUserCode(userCode);
}

async function createOwnerDeviceAuth({
  deviceCode,
  userCode,
  clientId,
  intervalSeconds,
  expiresAt,
  requestId = null,
  traceId = null,
  scenarioId = null,
}: {
  deviceCode: string;
  userCode: string;
  clientId: string;
  intervalSeconds: number;
  expiresAt: string;
  requestId?: string | null;
  traceId?: string | null;
  scenarioId?: string | null;
}): Promise<void> {
  // approval_id mirrors `pending_consents.approval_id` — see
  // createPendingConsent for rationale.
  const approvalId = generateId("appr");
  await getOwnerDeviceAuthStore().insert({
    approvalId,
    clientId,
    createdAt: nowIso(),
    deviceCode,
    expiresAt,
    intervalSeconds,
    requestId,
    scenarioId,
    traceId,
    userCode,
  });
}

export async function getOwnerDeviceAuthRowByApprovalId(approvalId: unknown): Promise<OwnerDeviceAuthRow | null> {
  if (typeof approvalId !== "string" || !approvalId) {
    return null;
  }
  return await getOwnerDeviceAuthStore().getByApprovalId(approvalId);
}

async function markOwnerDeviceAuthApproved(
  deviceCode: string,
  { subjectId, tokenId }: { subjectId: string; tokenId: string }
): Promise<void> {
  await getOwnerDeviceAuthStore().markApproved({
    approvedAt: nowIso(),
    deviceCode,
    subjectId,
    tokenId,
  });
}

async function markOwnerDeviceAuthDenied(deviceCode: string): Promise<void> {
  await getOwnerDeviceAuthStore().markDenied({ deniedAt: nowIso(), deviceCode });
}

async function markOwnerDeviceAuthExpired(deviceCode: string): Promise<void> {
  await getOwnerDeviceAuthStore().markExpired({ deviceCode });
}

async function updateOwnerDeviceAuthLastPolled(deviceCode: string): Promise<void> {
  await getOwnerDeviceAuthStore().updateLastPolled({ deviceCode, polledAt: nowIso() });
}

function buildInvalidRegisteredClientError(clientId: unknown): AuthError {
  const err: AuthError = new Error(`Registered client ${clientId} is malformed or no longer valid`);
  err.code = "invalid_client";
  return err;
}

function attachOwnerDeviceTraceContext(err: AuthError, row: DbRow | null | undefined): AuthError {
  if (!(err && row)) {
    return err;
  }
  if (row.request_id) {
    err.request_id = String(row.request_id);
  }
  if (row.trace_id) {
    err.trace_id = String(row.trace_id);
  }
  if (row.scenario_id) {
    err.scenario_id = String(row.scenario_id);
  }
  return err;
}

function mapRegisteredClientRow(row: RegisteredClientRow | null | undefined): RegisteredClient | null {
  if (!row) {
    return null;
  }
  let rawMetadata: Record<string, unknown>;
  try {
    const parsedMetadata: unknown = JSON.parse(row.metadata_json);
    if (!isRecord(parsedMetadata)) {
      throw buildInvalidRegisteredClientError(row.client_id);
    }
    rawMetadata = parsedMetadata;
  } catch (cause: unknown) {
    const err = buildInvalidRegisteredClientError(row.client_id);
    err.cause = cause;
    throw err;
  }
  let metadata: ClientMetadata;
  try {
    // Strip the spec-only client metadata to its supported field set, but
    // re-attach reference-only stamps the route layer added (e.g.
    // `issuer_subject_id` from owner-session-authed DCR). The normalizer
    // strict-rejects unknown fields, so we hold these aside, normalize,
    // then merge them back in.
    const referenceOnlyStamps: Pick<ClientMetadata, "issuer_subject_id"> | Record<string, never> = {};
    if (typeof rawMetadata.issuer_subject_id === "string" && rawMetadata.issuer_subject_id) {
      referenceOnlyStamps.issuer_subject_id = rawMetadata.issuer_subject_id;
    }
    const stripped = { ...rawMetadata };
    Reflect.deleteProperty(stripped, "issuer_subject_id");
    metadata = normalizeClientRegistrationMetadata(stripped);
    Object.assign(metadata, referenceOnlyStamps);
  } catch (cause: unknown) {
    const err = buildInvalidRegisteredClientError(row.client_id);
    err.cause = cause;
    throw err;
  }
  if (metadata.token_endpoint_auth_method !== row.token_endpoint_auth_method) {
    throw buildInvalidRegisteredClientError(row.client_id);
  }
  return {
    client_id: row.client_id,
    client_secret: row.client_secret || null,
    created_at: row.created_at,
    metadata,
    registration_mode: row.registration_mode,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    updated_at: row.updated_at,
  };
}

async function upsertRegisteredClient({
  clientId,
  registrationMode,
  metadata,
  clientSecret = null,
}: {
  clientId: string;
  registrationMode: string;
  metadata: ClientMetadata | Record<string, unknown>;
  clientSecret?: string | null;
}): Promise<void> {
  if (!SUPPORTED_REGISTRATION_MODES.has(registrationMode)) {
    const err: AuthError = new Error(`Unsupported registration mode: ${registrationMode}`);
    err.code = "invalid_client_metadata";
    throw err;
  }

  // Hold reference-only stamps (e.g. `issuer_subject_id` injected by the
  // owner-session-authed DCR route) aside; the spec normalizer rejects
  // unknown fields, but these stamps must round-trip to disk so downstream
  // listings/deletions can scope by operator. Strip before normalization,
  // re-attach after, persist the merged JSON.
  const referenceOnlyStamps: Pick<ClientMetadata, "issuer_subject_id"> | Record<string, never> = {};
  if (metadata && typeof metadata.issuer_subject_id === "string" && metadata.issuer_subject_id) {
    referenceOnlyStamps.issuer_subject_id = metadata.issuer_subject_id;
  }
  const inputForSpecNormalize = { ...metadata };
  Reflect.deleteProperty(inputForSpecNormalize, "issuer_subject_id");
  const normalizedMetadata = normalizeClientRegistrationMetadata(inputForSpecNormalize);
  const persistedMetadata = { ...normalizedMetadata, ...referenceOnlyStamps };
  const timestamp = nowIso();
  await getRegisteredClientStore().upsert({
    clientId,
    clientSecret,
    persistedMetadataJson: JSON.stringify(persistedMetadata),
    registrationMode,
    timestamp,
    tokenEndpointAuthMethod: normalizedMetadata.token_endpoint_auth_method,
  });
}

export async function seedPreRegisteredClients(
  clients: PreRegisteredClientInput[] = [],
  opts: { onRetry?: SqliteBusyRetryOptions["onRetry"]; retry?: SqliteBusyRetryOptions } = {}
): Promise<void> {
  // Startup seeding races against a sibling process that may still be
  // shutting down (Docker dev compose runs `node --watch`, and `--watch`
  // restart can briefly overlap with the old process's WAL writer). The
  // canonical SQLite `busy_timeout` covers most of this window; the
  // bounded application-level retry below covers the residual gap on
  // slow hosts / bind-mounted volumes where the lock release becomes
  // visible to the new opener fractionally late.
  const { onRetry } = opts;
  await forEachSequential(clients, async (client) => {
    if (!isNonEmptyString(client.client_id)) {
      return;
    }
    const clientId = client.client_id;
    const clientSecret = isNonEmptyString(client.client_secret) ? client.client_secret : null;
    const registrationMode = isNonEmptyString(client.registration_mode)
      ? client.registration_mode
      : "pre_registered_public";
    const metadata = isRecord(client.metadata)
      ? client.metadata
      : {
          client_name: isNonEmptyString(client.client_name) ? client.client_name : clientId,
          token_endpoint_auth_method: isNonEmptyString(client.token_endpoint_auth_method)
            ? client.token_endpoint_auth_method
            : "none",
        };
    if (isPostgresStorageBackend()) {
      await upsertRegisteredClient({
        clientId,
        clientSecret,
        metadata,
        registrationMode,
      });
      return;
    }
    await runWithSqliteBusyRetry(
      () =>
        upsertRegisteredClient({
          clientId,
          clientSecret,
          metadata,
          registrationMode,
        }),
      { ...(opts.retry ?? {}), ...(onRetry ? { onRetry } : {}) }
    );
  });
}

export async function getRegisteredClient(clientId: unknown): Promise<RegisteredClient | null> {
  if (!isNonEmptyString(clientId)) {
    return null;
  }
  const row = await getRegisteredClientStore().getByClientId(clientId);
  return mapRegisteredClientRow(row || null);
}

// ─── CIMD document store ─────────────────────────────────────────────────────

export async function createCimdDocument({
  clientName,
  redirectUris,
  logoUri,
}: {
  clientName?: string | null;
  redirectUris?: string[];
  logoUri?: string | null;
} = {}): Promise<string> {
  const { randomBytes: rb } = await import("node:crypto");
  const documentId = `cimd_${rb(12).toString("hex")}`;
  const now = nowIso();
  const redirectUrisJson = JSON.stringify(Array.isArray(redirectUris) ? redirectUris : []);
  await getCimdStore().insert({
    clientName: clientName || null,
    documentId,
    logoUri: logoUri || null,
    now,
    redirectUrisJson,
  });
  return documentId;
}

export async function getCimdDocument(documentId: unknown): Promise<Record<string, unknown> | null> {
  if (!isNonEmptyString(documentId)) {
    return null;
  }
  const row = await getCimdStore().getById(documentId);
  if (!row) {
    return null;
  }
  return {
    client_name: row.client_name || null,
    created_at: row.created_at,
    document_id: row.document_id,
    logo_uri: row.logo_uri || null,
    redirect_uris: (() => {
      try {
        return JSON.parse(row.redirect_uris);
      } catch {
        return [];
      }
    })(),
    updated_at: row.updated_at,
  };
}

export async function listCimdDocuments(): Promise<Record<string, unknown>[]> {
  const rows = await getCimdStore().listAll();
  return rows.map((row) => ({
    client_name: row.client_name || null,
    created_at: row.created_at,
    document_id: row.document_id,
    logo_uri: row.logo_uri || null,
    redirect_uris: (() => {
      try {
        return JSON.parse(row.redirect_uris);
      } catch {
        return [];
      }
    })(),
    updated_at: row.updated_at,
  }));
}

export async function deleteCimdDocument(
  documentId: string,
  {
    clientId = null,
    requestId = null,
    traceId = null,
  }: { clientId?: string | null; requestId?: string | null; traceId?: string | null } = {}
): Promise<void> {
  const { invalidateCimdCache } = await import("./cimd.ts");
  const existingDocument = await getCimdDocument(documentId);
  if (!existingDocument) {
    const err: AuthError = new Error(`CIMD document not found: ${documentId}`);
    err.code = "not_found";
    throw err;
  }
  let revokeResult: ClientAccessRevocationResult | null = null;
  if (clientId) {
    revokeResult = await revokeClientAccessArtifacts(clientId, {
      requestId,
      subscriptionDisableReason: "client_deleted",
      traceId,
    });
  }
  if (isPostgresStorageBackend()) {
    const result = await pgExec("DELETE FROM cimd_client_documents WHERE document_id = $1", [documentId]);
    if (result.changes === 0) {
      const err: AuthError = new Error(`CIMD document not found: ${documentId}`);
      err.code = "not_found";
      throw err;
    }
  } else {
    execDynamicSqlAcknowledged("DELETE FROM cimd_client_documents WHERE document_id = ?", [documentId]);
  }
  if (clientId && revokeResult) {
    invalidateCimdCache(clientId);
    await emitSpineEvent({
      actor_id: "pdpp_as",
      actor_type: "authorization_server",
      client_id: clientId,
      data: {
        disabled_subscription_count: revokeResult.disabledSubscriptionCount,
        document_id: documentId,
        registration_mode: "client_id_metadata_document",
        revoked_grant_count: revokeResult.revokedGrantIds.length,
        revoked_owner_token_count: revokeResult.revokedOwnerTokenCount,
        revoked_package_count: revokeResult.revokedPackageIds.length,
      },
      event_type: "client.deleted",
      object_id: clientId,
      object_type: "client",
      request_id: requestId || undefined,
      scenario_id: undefined,
      status: "succeeded",
      trace_id: traceId || undefined,
    });
  } else {
    // Best effort for callers that only know the document id.
    invalidateCimdCache(documentId);
  }
}

async function bindDynamicClientToApprovingOwner(
  registeredClient: RegisteredClient,
  subjectId: string
): Promise<RegisteredClient> {
  if (!(registeredClient.client_id && subjectId)) {
    return registeredClient;
  }
  if (registeredClient.registration_mode !== "dynamic") {
    return registeredClient;
  }
  const existingSubject = registeredClient.metadata.issuer_subject_id || null;
  if (existingSubject) {
    if (existingSubject !== subjectId) {
      const err: AuthError = new Error("Dynamic client is bound to a different owner subject");
      err.code = "forbidden";
      throw err;
    }
    return registeredClient;
  }

  await upsertRegisteredClient({
    clientId: registeredClient.client_id,
    clientSecret: registeredClient.client_secret || null,
    metadata: {
      ...registeredClient.metadata,
      issuer_subject_id: subjectId,
    },
    registrationMode: registeredClient.registration_mode,
  });
  return (await getRegisteredClient(registeredClient.client_id)) || registeredClient;
}

/**
 * Operator-scoped listing of dynamic clients the dashboard registered on
 * behalf of a particular owner-session subject. Backs `GET /_ref/clients?owner=true`.
 * Returns `[{ client_id, client_name, created_at, active_token_count }]`.
 *
 * Spec: openspec/changes/dcr-per-owner-token-with-revoke/specs/
 *       reference-implementation-architecture/spec.md
 */
export async function listOwnerIssuedClients(subjectId: unknown): Promise<Record<string, unknown>[]> {
  if (!isNonEmptyString(subjectId)) {
    return [];
  }
  const store = getRegisteredClientStore();
  const rows = await store.listByIssuerSubject(subjectId);
  const projected = await Promise.all(
    rows.map(async (row) => {
      const mapped = mapRegisteredClientRow(row);
      if (!mapped) {
        return null;
      }
      const countRow = await store.countActiveTokensByClientId(mapped.client_id);
      return {
        active_token_count: countRow ? Number(countRow.active_token_count) || 0 : 0,
        client_id: mapped.client_id,
        client_name: mapped.metadata.client_name || null,
        created_at: mapped.created_at,
      };
    })
  );
  return projected.flatMap((client) => (client ? [client] : []));
}

/**
 * Derive a stable, NON-REVERSIBLE public token id from the literal bearer.
 * `tokens.token_id` stores the raw bearer (see `redactSpineEventForPublic`),
 * so it must never leave the AS. This digest is a one-way SHA-256 of the
 * bearer, prefixed `tok_`, safe to render and to use as a per-token revoke
 * handle: knowing the public id does not recover the bearer.
 */
function deriveOwnerTokenPublicId(tokenId: string): string {
  return `tok_${base64UrlSha256(tokenId)}`;
}

/**
 * Project one active-token row for owner-console display. Drops the literal
 * bearer (`token_id`) entirely and replaces it with the non-reversible public
 * id. This is the single choke point that guarantees no bearer leaks through
 * the per-client token listing.
 */
function projectOwnerClientTokenRow(row: DbRow): {
  object: string;
  token_id_public: string;
  token_kind: unknown;
  created_at: unknown;
  expires_at: unknown;
} {
  if (!isNonEmptyString(row.token_id)) {
    throw bindingError("grant_invalid", "Stored owner token is missing token_id");
  }
  return {
    created_at: row.created_at,
    expires_at: row.expires_at ?? null,
    object: "owner_client_token",
    token_id_public: deriveOwnerTokenPublicId(row.token_id),
    token_kind: row.token_kind,
  };
}

/**
 * Assert the acting owner-session subject registered `clientId` (dynamic
 * client whose `metadata.issuer_subject_id` matches). Mirrors the guard in
 * `deleteRegisteredClient`/`updateRegisteredClientName` so the per-client
 * token surfaces cannot be used to read or revoke another operator's tokens.
 * Throws `not_found` (unknown/pre-registered) or `forbidden` (wrong owner).
 */
async function requireOwnerClient(clientId: string, actingSubjectId: string): Promise<RegisteredClient> {
  const client = await getRegisteredClient(clientId);
  if (client?.registration_mode !== "dynamic") {
    const err: AuthError = new Error(`Unknown client_id: ${clientId}`);
    err.code = "not_found";
    throw err;
  }
  const ownerSubject = client.metadata.issuer_subject_id || null;
  if (!ownerSubject || ownerSubject !== actingSubjectId) {
    const err: AuthError = new Error("Caller is not the operator who registered this client");
    err.code = "forbidden";
    throw err;
  }
  return client;
}

/**
 * Owner-scoped listing of a client's active bearer tokens. Backs
 * `GET /_ref/clients/:clientId/tokens?owner=true` and the per-client
 * drilldown surfaced when `active_token_count > 1`.
 *
 * Returns `[{ object, token_id_public, token_kind, created_at, expires_at }]`
 * — the literal bearer is never included. Throws `not_found`/`forbidden` when
 * the acting subject does not own the client.
 */
export async function listActiveTokensForOwnerClient(
  clientId: unknown,
  actingSubjectId: string
): Promise<Record<string, unknown>[]> {
  if (!isNonEmptyString(clientId)) {
    return [];
  }
  await requireOwnerClient(clientId, actingSubjectId);
  const rows = await getTokenStore().listActiveByClientId(clientId);
  return rows.map((row) => projectOwnerClientTokenRow(row));
}

/**
 * Owner-scoped per-token revoke. Revokes exactly one of a client's bearers,
 * addressed by its non-bearer public id, without deleting the client or
 * touching its other tokens. The public id is matched against the digest of
 * each live bearer server-side (the bearer never leaves the AS), and the
 * revoke is additionally scoped to `client_id` so a public id minted for one
 * client cannot revoke another client's token.
 *
 * Returns `{ revoked: boolean, token_id_public }`. `revoked` is false when no
 * active token matches the public id (idempotent / already-revoked). Throws
 * `not_found`/`forbidden` when the acting subject does not own the client.
 */
export async function revokeOwnerClientTokenByPublicId(
  clientId: unknown,
  tokenIdPublic: unknown,
  actingSubjectId: string
): Promise<{ revoked: boolean; token_id_public: unknown }> {
  if (!isNonEmptyString(clientId)) {
    const err: AuthError = new Error("client_id is required");
    err.code = "invalid_request";
    throw err;
  }
  if (!isNonEmptyString(tokenIdPublic)) {
    const err: AuthError = new Error("token_id_public is required");
    err.code = "invalid_request";
    throw err;
  }
  await requireOwnerClient(clientId, actingSubjectId);
  const store = getTokenStore();
  const rows = await store.listActiveByClientId(clientId);
  const match = rows.find(
    (row) => isNonEmptyString(row.token_id) && deriveOwnerTokenPublicId(row.token_id) === tokenIdPublic
  );
  if (!(match && isNonEmptyString(match.token_id))) {
    return { revoked: false, token_id_public: tokenIdPublic };
  }
  const result = await store.revokeByTokenId(match.token_id, clientId);
  const { changes } = result;
  const revoked = Number(changes) > 0;
  if (revoked) {
    await emitSpineEvent({
      actor_id: actingSubjectId,
      actor_type: "subject",
      client_id: clientId,
      data: {
        revocation_path: "owner_console_per_token",
        token_id_public: tokenIdPublic,
        token_kind: match.token_kind,
      },
      event_type: "token.revoked",
      object_id: "<redacted-token-id>",
      object_type: "token",
      status: "succeeded",
      subject_id: actingSubjectId,
      subject_type: "subject",
    });
  }
  return { revoked, token_id_public: tokenIdPublic };
}

async function revokeClientAccessArtifacts(
  clientId: string,
  {
    requestId,
    traceId,
    subscriptionDisableReason = "client_deleted",
  }: { requestId?: string | null; traceId?: string | null; subscriptionDisableReason?: string } = {}
): Promise<ClientAccessRevocationResult> {
  // Package refresh tokens are package-bound, not child-grant-bound. Capture
  // active packages before child grants are revoked so client deletion cannot
  // leave refreshable hosted-MCP packages behind.
  const packageRows: DbRow[] = isPostgresStorageBackend()
    ? (
        await postgresQuery<DbRow>(
          `SELECT package_id
         FROM grant_packages
         WHERE client_id = $1 AND status = 'active'
         ORDER BY created_at ASC`,
          [clientId]
        )
      ).rows
    : allowUnboundedReadAcknowledged<DbRow>(referenceQueries.authGrantPackagesListAll, []).filter(
        (row) => row.client_id === clientId && row.status === "active"
      );

  // Cascade-revoke any client-token grants tied to this client. Owner self-
  // export tokens (via the device flow) live in `tokens` directly with
  // grant_id=NULL, so they don't show up here — they're handled by the
  // separate token-cascade below.
  // REVIEWED-BOUNDED: per-token clients in operator usage have at most a few
  // active grants. The query's @max_rows=1024 bounds pathological cases.
  const grantRows = isPostgresStorageBackend()
    ? (
        await postgresQuery<DbRow>(
          `SELECT grant_id
         FROM grants
         WHERE client_id = $1 AND status = 'active'
         ORDER BY issued_at ASC`,
          [clientId]
        )
      ).rows
    : allowUnboundedReadAcknowledged<DbRow>(referenceQueries.authGrantsListActiveIdsByClientId, [clientId]);
  const revokedGrantIds: string[] = [];
  await forEachSequential(grantRows, async (row) => {
    try {
      if (!isNonEmptyString(row.grant_id)) {
        return;
      }
      await revokeGrant(row.grant_id, {
        ...(requestId === undefined ? {} : { request_id: requestId }),
        ...(traceId === undefined ? {} : { trace_id: traceId }),
      });
      revokedGrantIds.push(row.grant_id);
    } catch (err: unknown) {
      // Best-effort revoke: a grant that's already revoked / consumed is
      // not an error for the client-delete cascade. Anything else
      // propagates and aborts the delete (we'd rather leave the client
      // row in place than lie about cascade completeness).
      if (isAuthError(err) && (err.code === "grant_invalid" || err.code === "not_found")) {
        return;
      }
      throw err;
    }
  });

  const revokedPackageIds: string[] = [];
  await forEachSequential(packageRows, async (row) => {
    try {
      if (!isNonEmptyString(row.package_id)) {
        return;
      }
      const result = await revokeGrantPackage(row.package_id, {
        ...(requestId === undefined ? {} : { request_id: requestId }),
        ...(traceId === undefined ? {} : { trace_id: traceId }),
      });
      if (result.status !== "revoked") {
        const err: AuthError = new Error(`Failed to revoke every child grant in package ${row.package_id}`);
        err.code = "grant_package_revoke_partial";
        err.result = result;
        throw err;
      }
      revokedPackageIds.push(row.package_id);
    } catch (err: unknown) {
      if (isAuthError(err) && (err.code === "already_revoked" || err.code === "not_found")) {
        return;
      }
      throw err;
    }
  });

  // Cascade-revoke any owner self-export tokens issued against this client.
  // This is what makes per-token DCR's "Revoke" button cascade to the bearer
  // for owner tokens (which never have a grant row).
  const tokenRevoke = await getTokenStore().revokeByClientId(clientId);
  const revokedOwnerTokenCount = tokenRevoke.changes;
  const disabledSubscriptionCount = await disableClientEventSubscriptionsForDeletedClient(
    clientId,
    subscriptionDisableReason
  );

  return { disabledSubscriptionCount, revokedGrantIds, revokedOwnerTokenCount, revokedPackageIds };
}

// Owner-facing client labels are short display strings, not credential
// material. Cap the update path defensively (RFC 7591 registration itself
// applies no length ceiling, but the owner-console rename affordance is a
// good place to keep a single-line label single-line without touching the
// register path's behaviour).
const MAX_CLIENT_NAME_LENGTH = 256;

/**
 * RFC 7592 client-metadata update, owner-session-gated by the route. The
 * reference supports editing exactly one field: the owner-facing
 * `client_name` label. Everything else about the client (scope, bearer
 * material, registration mode) is immutable here — an owner renames the
 * credential's label, they do not re-scope it.
 *
 * Guards mirror `deleteRegisteredClient`:
 * - Refuses non-dynamic clients (protects pre-registered seeds).
 * - Refuses if the acting subject is not the registering operator
 *   (`metadata.issuer_subject_id`), stopping cross-operator edits.
 *
 * On success the client's `metadata.client_name` is replaced and
 * `oauth_clients.updated_at` is bumped (via `upsertRegisteredClient`), so
 * the next `GET /_ref/clients?owner=true` read reflects the rename in one
 * render cycle. Returns the re-read projection
 * `{ client_id, client_name, created_at, updated_at }`.
 *
 * Throws an error with a `code` of `not_found` | `forbidden` |
 * `invalid_client_metadata` otherwise.
 */
export async function updateRegisteredClientName(
  clientId: unknown,
  { clientName, actingSubjectId }: { clientName?: unknown; actingSubjectId?: unknown } = {}
): Promise<Record<string, unknown>> {
  if (!isNonEmptyString(clientId)) {
    const err: AuthError = new Error("client_id is required");
    err.code = "invalid_request";
    throw err;
  }
  if (typeof clientName !== "string" || !clientName.trim()) {
    const err: AuthError = new Error("client_name must be a non-empty string");
    err.code = "invalid_client_metadata";
    throw err;
  }
  const trimmedName = clientName.trim();
  if (trimmedName.length > MAX_CLIENT_NAME_LENGTH) {
    const err: AuthError = new Error(`client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`);
    err.code = "invalid_client_metadata";
    throw err;
  }

  const client = await getRegisteredClient(clientId);
  if (!client) {
    const err: AuthError = new Error(`Unknown client_id: ${clientId}`);
    err.code = "not_found";
    throw err;
  }
  if (client.registration_mode !== "dynamic") {
    const err: AuthError = new Error("Pre-registered clients cannot be updated via the registration management API");
    err.code = "forbidden";
    throw err;
  }
  const ownerSubject = client.metadata.issuer_subject_id || null;
  if (!ownerSubject || ownerSubject !== actingSubjectId) {
    const err: AuthError = new Error("Caller is not the operator who registered this client");
    err.code = "forbidden";
    throw err;
  }

  // Preserve every other metadata field (including the reference-only
  // `issuer_subject_id` stamp); overwrite only the label. `mapped.metadata`
  // is already a normalized round-trip, so re-normalization in
  // `upsertRegisteredClient` is lossless. The upsert bumps `updated_at`.
  await upsertRegisteredClient({
    clientId,
    clientSecret: client.client_secret || null,
    metadata: { ...client.metadata, client_name: trimmedName },
    registrationMode: client.registration_mode,
  });

  const updated = await getRegisteredClient(clientId);
  if (!updated) {
    const err: AuthError = new Error(`Updated client was not found: ${clientId}`);
    err.code = "not_found";
    throw err;
  }
  return {
    client_id: clientId,
    client_name: updated.metadata.client_name || null,
    created_at: updated.created_at || client.created_at,
    updated_at: updated.updated_at || null,
  };
}

/**
 * RFC 7592 client deletion, owner-session-gated by the route.
 * - Refuses non-dynamic clients (protects pre-registered seeds).
 * - Refuses if the acting subject doesn't match the registered
 *   `metadata.issuer_subject_id` (stops cross-operator deletes).
 * - Cascade-revokes every active grant and hosted-MCP grant package tied to
 *   the client via the existing revoke codepaths so spine events fire.
 * - Idempotent on subsequent calls (returns `not_found`).
 *
 * Returns revoked grant/package/token counts on success. Throws an error
 * with a `code` of `not_found` | `forbidden` otherwise.
 */
export async function deleteRegisteredClient(
  clientId: unknown,
  {
    actingSubjectId,
    requestId,
    traceId,
  }: { actingSubjectId?: string; requestId?: string | null; traceId?: string | null } = {}
): Promise<{
  revokedGrantIds: string[];
  revokedPackageIds: string[];
  revokedOwnerTokenCount: number;
  disabledSubscriptionCount: number;
}> {
  if (!isNonEmptyString(clientId)) {
    const err: AuthError = new Error("client_id is required");
    err.code = "invalid_request";
    throw err;
  }

  const client = await getRegisteredClient(clientId);
  if (!client) {
    const err: AuthError = new Error(`Unknown client_id: ${clientId}`);
    err.code = "not_found";
    throw err;
  }
  if (client.registration_mode !== "dynamic") {
    const err: AuthError = new Error("Pre-registered clients cannot be deleted via the registration management API");
    err.code = "forbidden";
    throw err;
  }
  const ownerSubject = client.metadata.issuer_subject_id || null;
  if (!ownerSubject || ownerSubject !== actingSubjectId) {
    const err: AuthError = new Error("Caller is not the operator who registered this client");
    err.code = "forbidden";
    throw err;
  }

  const { revokedGrantIds, revokedPackageIds, revokedOwnerTokenCount, disabledSubscriptionCount } =
    await revokeClientAccessArtifacts(clientId, {
      ...(requestId === undefined ? {} : { requestId }),
      ...(traceId === undefined ? {} : { traceId }),
    });

  await getRegisteredClientStore().deleteByClientId(clientId);

  await emitSpineEvent({
    actor_id: actingSubjectId,
    actor_type: "subject",
    client_id: clientId,
    data: {
      disabled_subscription_count: disabledSubscriptionCount,
      registration_mode: "dynamic",
      revoked_grant_count: revokedGrantIds.length,
      revoked_owner_token_count: revokedOwnerTokenCount,
      revoked_package_count: revokedPackageIds.length,
    },
    event_type: "client.deleted",
    object_id: clientId,
    object_type: "client",
    request_id: requestId,
    scenario_id: undefined,
    status: "succeeded",
    subject_id: actingSubjectId,
    subject_type: "subject",
    trace_id: traceId,
  });

  return { disabledSubscriptionCount, revokedGrantIds, revokedOwnerTokenCount, revokedPackageIds };
}

async function disableClientEventSubscriptionsForDeletedClient(
  clientId: string,
  disabledReason = "client_deleted"
): Promise<number> {
  const disabledAt = nowIso();
  if (isPostgresStorageBackend()) {
    const { rows } = await postgresQuery<DbRow>(
      `SELECT subscription_id, status
           FROM client_event_subscriptions
          WHERE client_id = $1
          ORDER BY created_at ASC`,
      [clientId]
    );
    let affected = 0;
    await forEachSequential(rows, async (row) => {
      if (row.status === "deleted" || row.status === "disabled_revoked") {
        return;
      }
      if (!isNonEmptyString(row.subscription_id)) {
        return;
      }
      await pgExec(
        `UPDATE client_event_queue
            SET status = 'dropped'
          WHERE subscription_id = $1
            AND status = 'pending'`,
        [row.subscription_id]
      );
      await pgExec(
        `UPDATE client_event_subscriptions
            SET status = 'disabled_revoked',
                updated_at = $1,
                disabled_at = $1,
                disabled_reason = $2
          WHERE subscription_id = $3`,
        [disabledAt, disabledReason, row.subscription_id]
      );
      affected += 1;
    });
    return affected;
  }

  const rows = allowUnboundedReadAcknowledged<DbRow>(
    referenceQueries.clientEventSubscriptionsListSubscriptionsByClient,
    [clientId]
  );
  let affected = 0;
  for (const row of rows) {
    if (row.status === "deleted" || row.status === "disabled_revoked") {
      continue;
    }
    if (!isNonEmptyString(row.subscription_id)) {
      continue;
    }
    exec(referenceQueries.clientEventSubscriptionsDropQueuedForSubscription, [row.subscription_id]);
    exec(referenceQueries.clientEventSubscriptionsUpdateStatus, [
      "disabled_revoked",
      disabledAt,
      disabledAt,
      disabledReason,
      row.subscription_id,
    ]);
    affected += 1;
  }
  return affected;
}

export async function registerDynamicClient(
  input: Record<string, unknown> = {},
  extraMetadata: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const metadata = normalizeClientRegistrationMetadata(input);

  // Optional reference-only stamps the route layer can pass through after
  // strict spec-field normalization. Today only `issuer_subject_id` is used
  // — the dashboard injects the operator's signed-in subject so
  // `_ref/clients?owner=true` can scope listings/deletions to that operator.
  // Anonymous callers cannot set this because the route never reads the
  // field from the request body — it only honors the owner-session subject.
  // See openspec/changes/dcr-per-owner-token-with-revoke/.
  if (typeof extraMetadata.issuer_subject_id === "string" && extraMetadata.issuer_subject_id) {
    metadata.issuer_subject_id = extraMetadata.issuer_subject_id;
  }

  const clientId = generateId("cli");
  await upsertRegisteredClient({
    clientId,
    clientSecret: null,
    metadata,
    registrationMode: "dynamic",
  });
  const registered = await getRegisteredClient(clientId);
  if (!registered) {
    throw buildInvalidRegisteredClientError(clientId);
  }
  if (!registered.created_at) {
    throw buildInvalidRegisteredClientError(clientId);
  }
  // Seed optional identity URI fields from AS_PUBLIC_URL when the registrant
  // omitted them. This gives PDPP's own AS a stable, discoverable identity in
  // every DCR response without altering any caller-supplied values.
  const asBase = process.env.AS_PUBLIC_URL ? process.env.AS_PUBLIC_URL.replace(TRAILING_SLASHES_RE, "") : null;
  return {
    application_type: registered.metadata.application_type || undefined,
    client_id: registered.client_id,
    client_id_issued_at: Math.floor(new Date(registered.created_at).getTime() / 1000),
    client_name: registered.metadata.client_name || null,
    client_uri: registered.metadata.client_uri || (asBase ? asBase : undefined),
    grant_types: registered.metadata.grant_types || undefined,
    logo_uri: registered.metadata.logo_uri || (asBase ? `${asBase}/icon.svg` : undefined),
    policy_uri: registered.metadata.policy_uri || (asBase ? asBase : undefined),
    redirect_uris: registered.metadata.redirect_uris || undefined,
    response_types: registered.metadata.response_types || undefined,
    token_endpoint_auth_method: registered.token_endpoint_auth_method,
    tos_uri: registered.metadata.tos_uri || (asBase ? asBase : undefined),
  };
}

let registerConnectorPhaseHook: ((point: string, context: Record<string, unknown>) => Promise<void>) | null = null;

/** Test-only registration phase seam; production never installs a hook. */
export function __setRegisterConnectorPhaseHookForTest(
  hook: ((point: string, context: Record<string, unknown>) => Promise<void>) | null
): void {
  registerConnectorPhaseHook = typeof hook === "function" ? hook : null;
}

async function maybeRegisterConnectorPhaseForTest(point: string, context: Record<string, unknown>): Promise<void> {
  await registerConnectorPhaseHook?.(point, context);
}

/**
 * Register or update a connector manifest
 */
export async function registerConnector(
  manifest: Record<string, unknown>,
  options: { backfillRetrievalIndexes?: boolean } = {}
): Promise<string> {
  validateConnectorManifest(manifest);
  const { connectorId, storedManifest } = normalizeConnectorManifestForStorage(manifest);
  await persistManifestAndAdvanceGenerations(connectorId, JSON.stringify(storedManifest));
  await maybeRegisterConnectorPhaseForTest("after-manifest-persisted", { connectorId, manifest: storedManifest });

  const postgresBackend = isPostgresStorageBackend();
  if (postgresBackend) {
    // Not fenced — keep the manifest-shape cache coherent regardless of
    // whether the fenced repair below runs.
    const { invalidatePostgresRecordManifestCache } = await import("./postgres-records.ts");
    invalidatePostgresRecordManifestCache(connectorId);
  }

  if (options.backfillRetrievalIndexes === false) {
    const postgresRecords = await import("./postgres-records.ts");
    const cursorBackfill =
      "postgresBackfillRecordCursorValuesForManifest" in postgresRecords
        ? postgresRecords.postgresBackfillRecordCursorValuesForManifest
        : null;
    if (typeof cursorBackfill !== "function") {
      throw new Error("Missing postgres record cursor-value backfill contract");
    }
    await cursorBackfill(storedManifest);
    return connectorId;
  }

  // Derived-column (cursor/primary-key/semantic-time) repair for records
  // already stored under this connector_id. Like retrieval-index backfill
  // below, this enumerates every OTHER connector_instance_id sharing this
  // connector_id and takes withConnectorInstanceWrite (the same per-instance
  // writer-admission fence bulk ingest holds) for each one — it is NOT a
  // no-op just because the instance being registered is fresh, since a
  // shared connector_id (e.g. a local-collector type enrolled by more than
  // one device) can already have OTHER instances mid-ingest. A caller that
  // opts out of retrieval-index maintenance because it is re-registering an
  // unchanged manifest (enroll, manifest-reconcile) has no derived-column
  // drift to repair either, so the early return above already skips this too.
  // See fix-enroll-writer-fence-residual-coupling design D4.
  if (postgresBackend) {
    const { postgresBackfillRecordSortPositionsForManifest } = await import("./postgres-records.ts");
    await postgresBackfillRecordSortPositionsForManifest(
      storedManifest as Parameters<typeof postgresBackfillRecordSortPositionsForManifest>[0]
    );
  } else {
    const { backfillSqliteRecordSemanticTimesForManifest } = await import("./records.ts");
    await backfillSqliteRecordSemanticTimesForManifest(
      storedManifest as Parameters<typeof backfillSqliteRecordSemanticTimesForManifest>[0]
    );
  }

  // Lexical retrieval index drift-detect + backfill. Handles three cases
  // the write-path maintenance (search.js#lexicalIndexUpsert) cannot:
  //   1. A connector is registered for the first time on a DB that already
  //      has records under that connector_id (e.g. a reset that preserved
  //      records but dropped the connector row).
  //   2. A connector's manifest is updated to add lexical_fields where it
  //      previously declared none.
  //   3. A connector's manifest is updated to add or remove lexical_fields
  //      entries on an already-participating stream.
  // No-op for connectors with no participating streams.
  // Lazy import keeps the records ↔ search ↔ auth cycle clean.
  const { lexicalIndexBackfillForManifest } = await import("./search.ts");
  await lexicalIndexBackfillForManifest({
    manifest: storedManifest as NonNullable<
      NonNullable<Parameters<typeof lexicalIndexBackfillForManifest>[0]>["manifest"]
    >,
  });

  // Semantic retrieval index drift-detect + backfill. Parallel to lexical;
  // handles the same three cases for semantic_fields, plus the backend-
  // identity change case (model_id/dimensions/distance_metric drift).
  // No-op when no embedding backend is configured (semanticRetrievalSupported
  // === false at startServer time) or when no stream declares semantic_fields.
  const { semanticIndexBackfillForManifest, getSemanticBackend } = await import("./search-semantic.ts");
  if (getSemanticBackend()) {
    await semanticIndexBackfillForManifest({
      manifest: storedManifest as NonNullable<
        NonNullable<Parameters<typeof semanticIndexBackfillForManifest>[0]>["manifest"]
      >,
    });
  }
  return connectorId;
}

function normalizeConnectorManifestForStorage(manifest: Record<string, unknown>): {
  connectorId: string;
  storedManifest: Record<string, unknown>;
} {
  const connectorId = canonicalConnectorKeyFromManifest(manifest) ?? manifest.connector_id;
  if (!isNonEmptyString(connectorId)) {
    throw invalidConnectorManifest("connector_id is required");
  }
  const storedManifest: Record<string, unknown> = {
    ...cloneJson(manifest),
    connector_id: connectorId,
    connector_key: connectorId,
  };
  if (!storedManifest.manifest_uri && isNonEmptyString(manifest.connector_id)) {
    const originalConnectorId = manifest.connector_id.trim();
    if (originalConnectorId !== connectorId) {
      storedManifest.manifest_uri = originalConnectorId;
    }
  }
  return { connectorId, storedManifest };
}

/**
 * List all registered connector_ids. Returned in stable id order so callers
 * (e.g. the lexical retrieval extension's owner-mode cross-connector
 * fan-out) get deterministic enumeration.
 */
export async function listRegisteredConnectorIds(): Promise<string[]> {
  const rows = await getConnectorCatalogStore().listIds();
  return rows.flatMap((row) => (isNonEmptyString(row.connector_id) ? [row.connector_id] : []));
}

/**
 * Get manifest by connector_id
 */
export async function getConnectorManifest(connectorId: unknown): Promise<DbRow | null> {
  if (!isNonEmptyString(connectorId)) {
    return null;
  }

  const row = await getConnectorManifestRow(connectorId);
  if (!row) {
    return null;
  }
  try {
    return parseAndValidateConnectorManifestRow(row, connectorId);
  } catch (err) {
    const legacyAlias = await getLegacyLocalConnectorAliasManifest(connectorId);
    if (legacyAlias) {
      return legacyAlias;
    }
    throw err;
  }
}

async function getConnectorManifestRow(connectorId: string): Promise<DbRow | null> {
  const store = getConnectorCatalogStore();
  const exact = await store.getManifestById(connectorId);
  if (exact) {
    return exact;
  }
  const canonical = canonicalConnectorKey(connectorId);
  if (!canonical || canonical === connectorId) {
    return null;
  }
  return store.getManifestById(canonical);
}

function parseAndValidateConnectorManifestRow(row: DbRow, connectorId: unknown): DbRow {
  try {
    if (!isNonEmptyString(row.manifest)) {
      throw invalidConnectorManifest("Stored connector manifest is missing");
    }
    const manifest: unknown = JSON.parse(row.manifest);
    if (!isRecord(manifest)) {
      throw invalidConnectorManifest("Stored connector manifest must be an object");
    }
    // Read-path validation: skip the reference cursor_field sort-compat check
    // so stale DB manifests (pre-guardrail) still flow through to the records
    // module's in-memory fallback. Registration-time paths enforce the full
    // check; see validateConnectorManifest.
    validateConnectorManifest(manifest, "connector_invalid", { skipCursorFieldSortCheck: true });
    return manifest;
  } catch (cause: unknown) {
    const err = invalidConnectorManifest(
      `Connector manifest for ${connectorId} is malformed or no longer valid`,
      "connector_invalid"
    );
    err.cause = cause;
    throw err;
  }
}

async function getLegacyLocalConnectorAliasManifest(connectorId: string): Promise<DbRow | null> {
  const canonicalConnectorId = LEGACY_LOCAL_CONNECTOR_MANIFEST_ALIASES.get(connectorId);
  if (!canonicalConnectorId) {
    return null;
  }
  const canonicalRow = await getConnectorManifestRow(canonicalConnectorId);
  if (!canonicalRow) {
    return null;
  }
  const manifest = parseAndValidateConnectorManifestRow(canonicalRow, canonicalConnectorId);
  return cloneJson(manifest);
}

export async function getManifestForStorageBinding(
  storageBinding: StorageBinding | null | undefined,
  opts: { nativeManifest?: DbRow | null } = {}
): Promise<DbRow | null> {
  const connectorId = storageBinding?.connector_id || null;
  if (!connectorId) {
    return null;
  }

  const nativeManifest = resolveConfiguredNativeManifest(opts);
  if (nativeManifest?.storage_binding?.connector_id === connectorId) {
    return cloneJson(nativeManifest);
  }

  return await getConnectorManifest(connectorId);
}

/**
 * Resolve a CIMD client_id to a synthetic registered-client shape.
 * Handles same-origin (local) lookup and external fetch with SSRF guards.
 * Throws with err.code = 'cimd_fetch_failed' or 'invalid_request' on failure.
 */
export async function revokeCimdClientAccessForSecurityMetadataChange(
  {
    clientId,
    previousSecurityHash = null,
    nextSecurityHash = null,
  }: { clientId: string; previousSecurityHash?: string | null; nextSecurityHash?: string | null },
  opts: {
    requestId?: string | null;
    request_id?: string | null;
    traceId?: string | null;
    trace_id?: string | null;
    scenarioId?: string;
    scenario_id?: string;
  } = {}
): Promise<void> {
  const requestId = opts.requestId || opts.request_id || null;
  const traceId = opts.traceId || opts.trace_id || null;
  const revokeResult = await revokeClientAccessArtifacts(clientId, {
    requestId,
    subscriptionDisableReason: "client_metadata_changed",
    traceId,
  });
  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: clientId,
    data: {
      disabled_subscription_count: revokeResult.disabledSubscriptionCount,
      next_security_hash: nextSecurityHash,
      previous_security_hash: previousSecurityHash,
      reason: "security_relevant_metadata_changed",
      registration_mode: "client_id_metadata_document",
      revoked_grant_count: revokeResult.revokedGrantIds.length,
      revoked_owner_token_count: revokeResult.revokedOwnerTokenCount,
      revoked_package_count: revokeResult.revokedPackageIds.length,
    },
    event_type: "client.metadata_changed",
    object_id: clientId,
    object_type: "client",
    request_id: requestId || undefined,
    scenario_id: opts.scenarioId || opts.scenario_id || undefined,
    status: "succeeded",
    trace_id: traceId || undefined,
  });
}

function normalizeCimdRegisteredClient(value: unknown): RegisteredClient {
  if (!(isRecord(value) && isNonEmptyString(value.client_id) && isRecord(value.metadata))) {
    throw bindingError("invalid_client", "CIMD client metadata is malformed");
  }
  const tokenEndpointAuthMethod = isNonEmptyString(value.token_endpoint_auth_method)
    ? value.token_endpoint_auth_method
    : "none";
  return {
    client_id: value.client_id,
    client_secret: null,
    created_at: null,
    metadata: {
      client_name: isNonEmptyString(value.metadata.client_name) ? value.metadata.client_name : null,
      client_uri: isNonEmptyString(value.metadata.client_uri) ? value.metadata.client_uri : null,
      logo_uri: isNonEmptyString(value.metadata.logo_uri) ? value.metadata.logo_uri : null,
      redirect_uris: Array.isArray(value.metadata.redirect_uris)
        ? value.metadata.redirect_uris.filter(isNonEmptyString)
        : [],
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    },
    registration_mode: isNonEmptyString(value.registration_mode)
      ? value.registration_mode
      : "client_id_metadata_document",
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    updated_at: null,
  };
}

async function resolveCimdClientForGrant(
  clientId: string,
  opts: {
    issuerBase?: string;
    baseUrl?: string;
    requestId?: string | null;
    request_id?: string | null;
    traceId?: string | null;
    trace_id?: string | null;
  } = {}
): Promise<RegisteredClient | null> {
  const { isCimdClientId, validateCimdUrl, fetchCimdDocument, buildCimdRegisteredClient } = await import("./cimd.ts");

  if (!isCimdClientId(clientId)) {
    return null;
  }

  // Validate URL structure before any fetch
  validateCimdUrl(clientId);

  // Same-origin check: if client_id matches our issuer + /oauth/client-metadata/:id,
  // resolve from local storage instead of a network self-fetch.
  const issuerBase = opts.issuerBase || opts.baseUrl || process.env.AS_PUBLIC_URL || null;
  if (issuerBase) {
    try {
      const issuerUrl = new URL(issuerBase);
      const clientUrl = new URL(clientId);
      if (clientUrl.origin === issuerUrl.origin && clientUrl.pathname.startsWith("/oauth/client-metadata/")) {
        const docId = clientUrl.pathname.replace("/oauth/client-metadata/", "").replace(LEADING_SLASH_RE, "");
        const localDoc = await getCimdDocument(docId);
        if (!localDoc) {
          const err: AuthError = new Error(`CIMD local document not found for ${clientId}`);
          err.code = "invalid_client";
          throw err;
        }
        const doc = {
          client_id: clientId,
          client_name: localDoc.client_name,
          logo_uri: localDoc.logo_uri,
          redirect_uris: localDoc.redirect_uris,
          token_endpoint_auth_method: "none",
        };
        return normalizeCimdRegisteredClient(buildCimdRegisteredClient(clientId, doc));
      }
    } catch (err: unknown) {
      if (isAuthError(err) && (err.code === "invalid_client" || err.code === "invalid_request")) {
        throw err;
      }
      // URL parse failure — fall through to external fetch
    }
  }

  // External fetch with SSRF guards, timeout, size cap
  const { doc } = await fetchCimdDocument(clientId, {
    onSecurityRelevantMetadataChange: (event) => revokeCimdClientAccessForSecurityMetadataChange(event, opts),
  });
  return normalizeCimdRegisteredClient(buildCimdRegisteredClient(clientId, doc));
}

export async function resolveOAuthClient(
  clientId: unknown,
  opts: { issuerBase?: string; baseUrl?: string } = {}
): Promise<RegisteredClient | null> {
  let registeredClient = await getRegisteredClient(clientId);
  if (registeredClient) {
    return registeredClient;
  }
  const { isCimdClientId } = await import("./cimd.ts");
  if (isNonEmptyString(clientId) && isCimdClientId(clientId)) {
    registeredClient = await resolveCimdClientForGrant(clientId, opts);
  }
  return registeredClient;
}

function requiresStagedGrantBatch(input: Record<string, unknown>): boolean {
  const hasParentPackageId = input.parent_package_id !== undefined && input.parent_package_id !== null;
  return Array.isArray(input.authorization_details) && (input.authorization_details.length > 1 || hasParentPackageId);
}

/**
 * Persist a pending grant-approval request and expose it as a PAR-backed consent request.
 * Returns the staged request URI plus the consent URL for the primary request/approval flow.
 */
export async function initiateGrant(
  input: Record<string, unknown>,
  opts: { scenarioId?: string; baseUrl?: string; nativeManifest?: DbRow | null; issuerBase?: string } = {}
): Promise<Record<string, unknown>> {
  if (requiresStagedGrantBatch(input)) {
    return initiateStagedGrantBatch(input, opts);
  }
  const normalized = normalizePendingGrantRequest(input, opts);
  requireStructuredPendingRequestShape(normalized);
  const traceContext = getRequestTraceContext(
    normalized,
    opts.scenarioId || (isNonEmptyString(input.scenario_id) ? input.scenario_id : null)
  );
  normalized.trace_context = traceContext;
  const sourceBinding = getRequestSourceBinding(normalized);

  try {
    const registeredClient = await resolveOAuthClient(normalized.client.client_id, opts);
    if (!registeredClient) {
      const err: AuthError = new Error(`Unknown client_id: ${normalized.client.client_id}`);
      err.code = "invalid_client";
      throw err;
    }
    applyRegisteredClientToPendingRequestClient(normalized, registeredClient);
    const storageBinding = getRequestStorageBinding(normalized);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    resolveGrantSelection(normalized.selection, manifest);
    normalized.manifest_version = requireManifestVersion(manifest);

    const deviceCode = generateId("dc");
    const userCode = randomBytes(3).toString("hex").toUpperCase();
    const verificationBaseUrl =
      opts.baseUrl || process.env.AS_PUBLIC_URL || `http://localhost:${process.env.AS_PORT || "7662"}`;
    const expiresAt = expiresInIso(300);

    await createPendingConsent(deviceCode, userCode, normalized, expiresAt);
    const requestEventData = {
      access_mode: normalized.selection.access_mode || null,
      purpose_code: normalized.selection.purpose_code || null,
      source: describeSourceBinding(sourceBinding),
      stream_names: normalized.selection.streams.map((stream) => stream.name),
      user_code: userCode,
    };

    await emitSpineEvent({
      actor_id: normalized.client.client_id,
      actor_type: "client",
      client_id: normalized.client.client_id,
      data: requestEventData,
      event_type: "request.submitted",
      object_id: deviceCode,
      object_type: "pending_consent",
      request_id: traceContext.request_id,
      scenario_id: traceContext.scenario_id,
      status: "succeeded",
      trace_id: traceContext.trace_id,
    });

    const requestUri = buildPendingConsentRequestUri(deviceCode);
    return {
      authorization_url: buildPendingConsentAuthorizationUrl(requestUri, { baseUrl: verificationBaseUrl }),
      expires_in: 300,
      request_uri: requestUri,
      trace_context: traceContext,
      user_code: userCode,
    };
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    err.trace_id = traceContext.trace_id;
    err.request_id = traceContext.request_id;
    if (traceContext.scenario_id) {
      err.scenario_id = traceContext.scenario_id;
    }
    await emitSpineEvent({
      actor_id: normalized.client.client_id || "unknown",
      actor_type: "client",
      client_id: normalized.client.client_id || null,
      data: {
        access_mode: normalized.selection.access_mode || null,
        error: {
          code: err.code || "api_error",
          message: err.message,
        },
        purpose_code: normalized.selection.purpose_code || null,
        source: describeSourceBinding(sourceBinding),
        stream_names: normalized.selection.streams.map((stream) => stream.name),
      },
      event_type: "request.rejected",
      object_id: traceContext.request_id,
      object_type: "request",
      request_id: traceContext.request_id,
      scenario_id: traceContext.scenario_id,
      status: "rejected",
      trace_id: traceContext.trace_id,
    });
    throw err;
  }
}

function asSingleEntryRequestSlice(batchRequest: StagedBatchRequest, entry: BatchEntry): PendingRequest {
  return {
    client: batchRequest.client,
    request_kind: "pdpp_selection_request",
    request_version: batchRequest.request_version,
    selection: entry.selection,
    source_binding: entry.source_binding,
    storage_binding: entry.storage_binding,
    ...(entry.manifest_version ? { manifest_version: entry.manifest_version } : {}),
    ...(batchRequest.trace_context ? { trace_context: batchRequest.trace_context } : {}),
  };
}

async function initiateStagedGrantBatch(
  input: Record<string, unknown>,
  opts: { scenarioId?: string; baseUrl?: string; nativeManifest?: DbRow | null; issuerBase?: string } = {}
): Promise<Record<string, unknown>> {
  const batch = normalizeStagedGrantRequestBatch(input, opts);
  const traceContext = getRequestTraceContext(
    batch,
    opts.scenarioId || (isNonEmptyString(input.scenario_id) ? input.scenario_id : null)
  );
  batch.trace_context = traceContext;
  const firstSource = batch.entries[0]?.source_binding || null;

  try {
    const registeredClient = await resolveOAuthClient(batch.client.client_id, opts);
    if (!registeredClient) {
      const err: AuthError = new Error(`Unknown client_id: ${batch.client.client_id}`);
      err.code = "invalid_client";
      throw err;
    }
    applyRegisteredClientToPendingRequestClient(batch, registeredClient);

    // Incremental add-source linkage: validate the parent now (same client,
    // exists, active) so a malformed/cross-client link fails closed before a
    // pending consent is created. The owner-scoped re-check happens at
    // approval, when the approving subject is known.
    await requireValidParentPackageLinkage(batch.parent_package_id, {
      clientId: registeredClient.client_id,
    });

    await forEachSequential(batch.entries, async (entry) => {
      const slice = asSingleEntryRequestSlice(batch, entry);
      requireStructuredPendingRequestShape(slice);
      const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(slice);
      entry.source_binding = describeSourceBinding(sourceBinding);
      entry.storage_binding = normalizeStorageBinding(storageBinding);
      const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
      resolveGrantSelection(entry.selection, manifest);
      entry.manifest_version = requireManifestVersion(manifest);
    });

    const deviceCode = generateId("dc");
    const userCode = randomBytes(3).toString("hex").toUpperCase();
    const verificationBaseUrl =
      opts.baseUrl || process.env.AS_PUBLIC_URL || `http://localhost:${process.env.AS_PORT || "7662"}`;
    const expiresAt = expiresInIso(300);

    await createPendingConsent(deviceCode, userCode, batch, expiresAt);
    await emitSpineEvent({
      actor_id: batch.client.client_id,
      actor_type: "client",
      client_id: batch.client.client_id,
      data: {
        entry_count: batch.entry_count,
        over_cap_sources: batch.over_cap_sources,
        over_soft_cap: batch.over_soft_cap,
        soft_cap_warning: batch.soft_cap_warning,
        staged: true,
        user_code: userCode,
        ...(batch.parent_package_id ? { parent_package_id: batch.parent_package_id } : {}),
        sources: batch.entries.map((entry) => describeSourceBinding(entry.source_binding)),
      },
      event_type: "request.submitted",
      object_id: deviceCode,
      object_type: "pending_consent",
      request_id: traceContext.request_id,
      scenario_id: traceContext.scenario_id,
      status: "succeeded",
      trace_id: traceContext.trace_id,
    });

    const requestUri = buildPendingConsentRequestUri(deviceCode);
    return {
      authorization_url: buildPendingConsentAuthorizationUrl(requestUri, { baseUrl: verificationBaseUrl }),
      expires_in: 300,
      request_uri: requestUri,
      trace_context: traceContext,
      user_code: userCode,
    };
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    err.trace_id = traceContext.trace_id;
    err.request_id = traceContext.request_id;
    if (traceContext.scenario_id) {
      err.scenario_id = traceContext.scenario_id;
    }
    await emitSpineEvent({
      actor_id: batch.client.client_id || "unknown",
      actor_type: "client",
      client_id: batch.client.client_id || null,
      data: {
        entry_count: batch.entry_count,
        error: {
          code: err.code || "api_error",
          message: err.message,
        },
        source: describeSourceBinding(firstSource),
        staged: true,
      },
      event_type: "request.rejected",
      object_id: traceContext.request_id,
      object_type: "request",
      request_id: traceContext.request_id,
      scenario_id: traceContext.scenario_id,
      status: "rejected",
      trace_id: traceContext.trace_id,
    });
    throw err;
  }
}

async function buildBatchConsentCards(
  request: StagedBatchRequest,
  opts: { nativeManifest?: DbRow | null } = {}
): Promise<Record<string, unknown>[]> {
  const cards: Record<string, unknown>[] = [];
  await forEachSequential(request.entries, async (entry, index) => {
    const slice = asSingleEntryRequestSlice(request, entry);
    requireStructuredPendingRequestShape(slice);
    const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(slice);
    entry.source_binding = describeSourceBinding(sourceBinding);
    entry.storage_binding = normalizeStorageBinding(storageBinding);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    slice.manifest_version = entry.manifest_version;
    const resolvedStreams = requirePendingRequestContractAgainstManifest(slice, manifest);
    cards.push({
      access_mode: entry.selection?.access_mode || null,
      index,
      manifestStreamNames: Array.isArray(manifest.streams)
        ? manifest.streams.map((stream) => stream.name).filter((name) => typeof name === "string")
        : null,
      purpose_code: entry.selection?.purpose_code || null,
      resolvedStreams,
      retention: entry.selection?.retention ?? null,
      sensitivity: resolveManifestSensitivity(manifest),
      source: describeSourceBinding(sourceBinding),
    });
  });
  return cards;
}

function summarizeBatchCumulativeRisk(cards: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    continuous_access_count: cards.filter((card) => card.access_mode === "continuous").length,
    no_field_projection_count: cards.filter((card) => {
      const streams = Array.isArray(card.resolvedStreams) ? card.resolvedStreams : [];
      return streams.some(
        (stream) => !(isRecord(stream) && Array.isArray(stream.fields)) || stream.fields.length === 0
      );
    }).length,
    no_time_bound_count: cards.filter((card) => cardHasNoTimeBound(card)).length,
    sensitive_source_count: cards.filter((card) => card.sensitivity === "sensitive").length,
    source_count: cards.length,
    total_stream_count: cards.reduce(
      (total, card) => total + (Array.isArray(card.resolvedStreams) ? card.resolvedStreams.length : 0),
      0
    ),
  };
}

function cardRequestsAllStreams(card: Record<string, unknown>): boolean {
  const manifestNames = Array.isArray(card.manifestStreamNames) ? card.manifestStreamNames : null;
  const resolved = Array.isArray(card.resolvedStreams) ? card.resolvedStreams : [];
  if (!manifestNames || manifestNames.length === 0 || resolved.length === 0) {
    return false;
  }
  const requested = new Set(resolved.flatMap((stream) => (isRecord(stream) ? [stream.name] : [])));
  return manifestNames.every((name) => requested.has(name));
}

function cardHasNoTimeBound(card: Record<string, unknown>): boolean {
  const resolved = Array.isArray(card.resolvedStreams) ? card.resolvedStreams : [];
  if (resolved.length === 0) {
    return true;
  }
  return resolved.some((stream) => !(isRecord(stream) && stream.time_range));
}

function evaluateBatchApproveAllGate(cards: Record<string, unknown>[] = []): {
  approve_all_suppressed: boolean;
  suppression_reasons: string[];
} {
  const reasons: string[] = [];
  const sensitiveCount = cards.filter((card) => card.sensitivity === "sensitive").length;
  if (cards.some((card) => card.access_mode === "continuous" && cardRequestsAllStreams(card))) {
    reasons.push("continuous_all_streams");
  }
  if (cards.some((card) => card.sensitivity === "sensitive" && cardHasNoTimeBound(card))) {
    reasons.push("sensitive_no_time_bound");
  }
  if (sensitiveCount >= 3) {
    reasons.push("three_or_more_sensitive_sources");
  }
  return {
    approve_all_suppressed: reasons.length > 0,
    suppression_reasons: reasons,
  };
}

// Owner-driven per-source narrowing applied at approval time. The owner may
// reduce a staged entry's streams, reduce a stream's fields, and tighten a
// `time_range.since` bound, but MUST NOT widen beyond what the client
// staged and the owner reviewed. Narrowing is validated against the staged
// resolved baseline (`resolveGrantSelection(entry.selection, manifest)`), which
// is the authoritative ceiling of what the client asked for. Anything not a
// subset/tightening of that baseline is rejected before any grant is issued.
//
// Shape (per staged source index):
//   { streams?: string[], fields?: { [stream]: string[] }, since?: { [stream]: ISO } }
// `streams` keeps only the named subset; an empty/missing `streams` keeps all
// baseline streams. `fields[stream]` narrows that stream's field set to a
// subset of its baseline fields. `since[stream]` sets/tightens that stream's
// time bound. Streams dropped by `streams` are removed entirely.
function narrowingHasAnyDirective(narrowing: unknown): narrowing is Record<string, unknown> {
  if (!isRecord(narrowing)) {
    return false;
  }
  return Boolean(
    Array.isArray(narrowing.streams) ||
      (narrowing.fields && typeof narrowing.fields === "object") ||
      (narrowing.since && typeof narrowing.since === "object")
  );
}

function parseIsoInstant(
  value: unknown,
  { sourceLabel, streamName }: { sourceLabel: string; streamName: string }
): number {
  if (!isNonEmptyString(value)) {
    throw bindingError(
      "invalid_request",
      `Narrowed time bound for '${sourceLabel}' stream '${streamName}' must be a non-empty ISO-8601 string`
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw bindingError(
      "invalid_request",
      `Narrowed time bound '${value}' for '${sourceLabel}' stream '${streamName}' is not a valid ISO-8601 instant`
    );
  }
  return ms;
}

function resolveKeptStreamNames(
  baseline: StreamSelection[],
  requestedStreams: unknown,
  baselineByName: Map<string, StreamSelection>,
  sourceLabel: string
): string[] {
  if (!Array.isArray(requestedStreams)) {
    return baseline.map((stream) => stream.name);
  }
  if (requestedStreams.length === 0) {
    throw bindingError("invalid_request", `Narrowed stream set for '${sourceLabel}' must keep at least one stream`);
  }
  const seen = new Set<string>();
  for (const name of requestedStreams) {
    if (!isNonEmptyString(name)) {
      throw bindingError("invalid_request", `Narrowed stream name for '${sourceLabel}' must be a non-empty string`);
    }
    if (!baselineByName.has(name)) {
      throw bindingError(
        "invalid_request",
        `Cannot narrow '${sourceLabel}' to stream '${name}': it was not in the staged request (widening is forbidden)`
      );
    }
    seen.add(name);
  }
  return baseline.map((stream) => stream.name).filter((name) => seen.has(name));
}

function requireNarrowingTargetsKept(
  keptNames: string[],
  targetMaps: Record<string, unknown>[],
  sourceLabel: string
): void {
  for (const targetMap of targetMaps) {
    for (const streamName of Object.keys(targetMap)) {
      if (!keptNames.includes(streamName)) {
        throw bindingError(
          "invalid_request",
          `Narrowing references '${sourceLabel}' stream '${streamName}', which is not in the approved stream set`
        );
      }
    }
  }
}

function applyFieldNarrowing(narrowed: StreamSelection, requestedFields: unknown, sourceLabel: string): void {
  const { name } = narrowed;
  if (!Array.isArray(requestedFields) || requestedFields.length === 0) {
    throw bindingError(
      "invalid_request",
      `Narrowed field set for '${sourceLabel}' stream '${name}' must be a non-empty array`
    );
  }
  const baselineFields = Array.isArray(narrowed.fields) ? narrowed.fields : null;
  if (!baselineFields) {
    throw bindingError(
      "invalid_request",
      `Cannot narrow fields for '${sourceLabel}' stream '${name}': the staged request placed no field projection on it, so a field subset cannot be proven to be narrower`
    );
  }
  const baselineFieldSet = new Set(baselineFields);
  const seenFields = new Set<string>();
  for (const field of requestedFields) {
    if (!isNonEmptyString(field)) {
      throw bindingError(
        "invalid_request",
        `Narrowed field name for '${sourceLabel}' stream '${name}' must be a non-empty string`
      );
    }
    if (!baselineFieldSet.has(field)) {
      throw bindingError(
        "invalid_request",
        `Cannot narrow '${sourceLabel}' stream '${name}' to field '${field}': it was not in the staged field set (widening is forbidden)`
      );
    }
    seenFields.add(field);
  }
  narrowed.fields = baselineFields.filter((field) => seenFields.has(field));
  if (narrowed.view) {
    Reflect.deleteProperty(narrowed, "view");
  }
}

function applySinceNarrowing(narrowed: StreamSelection, requestedSince: unknown, sourceLabel: string): void {
  const { name } = narrowed;
  const baselineSince = narrowed.time_range?.since;
  if (!isNonEmptyString(baselineSince)) {
    throw bindingError(
      "invalid_request",
      `Cannot set a time bound on '${sourceLabel}' stream '${name}': the staged request placed no time bound on it, so a tighter bound cannot be proven against it`
    );
  }
  const requestedMs = parseIsoInstant(requestedSince, { sourceLabel, streamName: name });
  if (!isNonEmptyString(requestedSince)) {
    throw bindingError(
      "invalid_request",
      `Narrowed time bound for '${sourceLabel}' stream '${name}' must be a non-empty ISO-8601 string`
    );
  }
  const baselineMs = Date.parse(baselineSince);
  if (!Number.isNaN(baselineMs) && requestedMs < baselineMs) {
    throw bindingError(
      "invalid_request",
      `Cannot narrow '${sourceLabel}' stream '${name}' to start at '${requestedSince}': that is earlier than the staged bound '${baselineSince}' (widening is forbidden)`
    );
  }
  narrowed.time_range = { ...narrowed.time_range, since: requestedSince };
}

function narrowResolvedStream(
  baseStream: StreamSelection,
  fieldsNarrowing: Record<string, unknown>,
  sinceNarrowing: Record<string, unknown>,
  sourceLabel: string
): StreamSelection {
  const narrowed = { ...baseStream };
  if (Object.hasOwn(fieldsNarrowing, narrowed.name)) {
    applyFieldNarrowing(narrowed, fieldsNarrowing[narrowed.name], sourceLabel);
  }
  if (Object.hasOwn(sinceNarrowing, narrowed.name)) {
    applySinceNarrowing(narrowed, sinceNarrowing[narrowed.name], sourceLabel);
  }
  return narrowed;
}

function narrowResolvedSelectionForSource(
  baselineResolved: StreamSelection[],
  narrowing: Record<string, unknown> | null | undefined,
  sourceLabel: string
): StreamSelection[] {
  const baseline = Array.isArray(baselineResolved) ? baselineResolved : [];
  if (!narrowingHasAnyDirective(narrowing)) {
    return baseline;
  }
  const baselineByName = new Map(baseline.map((stream) => [stream.name, stream]));
  const keptNames = resolveKeptStreamNames(baseline, narrowing.streams, baselineByName, sourceLabel);
  const fieldsNarrowing = isRecord(narrowing.fields) ? narrowing.fields : {};
  const sinceNarrowing = isRecord(narrowing.since) ? narrowing.since : {};
  requireNarrowingTargetsKept(keptNames, [fieldsNarrowing, sinceNarrowing], sourceLabel);
  return keptNames.map((name) => {
    const baseStream = baselineByName.get(name);
    if (!baseStream) {
      throw bindingError("invalid_request", `Unknown staged stream '${name}' for '${sourceLabel}'`);
    }
    return narrowResolvedStream(baseStream, fieldsNarrowing, sinceNarrowing, sourceLabel);
  });
}

async function getPendingConsentBatch(
  request: StagedBatchRequest,
  row: DbRow,
  opts: { nativeManifest?: DbRow | null } = {}
): Promise<Record<string, unknown>> {
  try {
    await requirePendingRequestClientRegistration(request, opts);
    const cards = await buildBatchConsentCards(request);
    return {
      approveAllGate: evaluateBatchApproveAllGate(cards),
      batch: true,
      cards,
      createdAt: row.created_at,
      cumulativeRisk: summarizeBatchCumulativeRisk(cards),
      expiresAt: row.expires_at,
      overCapSources: Array.isArray(request.over_cap_sources) ? request.over_cap_sources : [],
      overSoftCap: Boolean(request.over_soft_cap),
      request,
      softCap: request.soft_cap,
      softCapWarning: Boolean(request.soft_cap_warning),
      userCode: row.user_code,
    };
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    const [firstEntry] = request.entries;
    await emitPendingConsentRejected(
      {
        client: request.client,
        ...(firstEntry ? { selection: firstEntry.selection, source_binding: firstEntry.source_binding } : {}),
      },
      row,
      err
    );
    throw err;
  }
}

function resolveApprovedEntryIndexes(
  request: StagedBatchRequest,
  opts: { approvedSourceIndexes?: number[] | null }
): number[] {
  const total = request.entries.length;
  if (opts.approvedSourceIndexes === undefined || opts.approvedSourceIndexes === null) {
    return Array.from({ length: total }, (_unused, index) => index);
  }
  if (!Array.isArray(opts.approvedSourceIndexes)) {
    throw bindingError("invalid_request", "approved_source_indexes must be an array of staged entry indexes");
  }
  const seen = new Set<number>();
  for (const raw of opts.approvedSourceIndexes) {
    const index = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw bindingError("invalid_request", `approved_source_indexes contains an out-of-range entry index: ${raw}`);
    }
    seen.add(index);
  }
  if (seen.size === 0) {
    throw bindingError("invalid_request", "approved_source_indexes must approve at least one staged source");
  }
  return Array.from(seen).sort((a, b) => a - b);
}

interface ApproveStagedGrantBatchOptions {
  ai_training_consented?: boolean | null;
  approvedSourceIndexes?: number[] | null;
  confirmedApproveAll?: boolean;
  narrowings?: Record<string, unknown>[] | null;
  nativeManifest?: DbRow | null;
  sourceNarrowing?: Record<string, unknown>;
}

async function rejectStagedBatchApproval(
  request: StagedBatchRequest,
  pending: DbRow,
  subjectId: string,
  err: AuthError
): Promise<never> {
  const [firstEntry] = request.entries;
  await emitPendingConsentRejected(
    {
      client: request.client,
      ...(firstEntry ? { selection: firstEntry.selection, source_binding: firstEntry.source_binding } : {}),
    },
    pending,
    err,
    { subjectId }
  );
  throw err;
}

function requireBatchEntryPolicy(approvedEntries: BatchEntry[]): void {
  for (const entry of approvedEntries) {
    if (entry.selection.purpose_code === "https://pdpp.org/purpose/ai_training") {
      const err: AuthError = new Error(
        "Staged batch consent does not cover ai_training; request it as a single-entry grant"
      );
      err.code = "invalid_request";
      err.param = "purpose_code";
      throw err;
    }
  }
  const approvedAccessModes = new Set(approvedEntries.map((entry) => entry.selection.access_mode || null));
  if (approvedAccessModes.size > 1) {
    const err: AuthError = new Error(
      `A batch package applies one access mode to every source; the approved sources mix access modes (${Array.from(
        approvedAccessModes
      )
        .map((mode) => mode ?? "unspecified")
        .sort()
        .join(", ")}). Run a separate ceremony per access mode.`
    );
    err.code = "invalid_request";
    err.param = "access_mode";
    throw err;
  }
}

async function resolveApprovedBatchEntries(
  request: StagedBatchRequest,
  pending: DbRow,
  subjectId: string,
  opts: ApproveStagedGrantBatchOptions
): Promise<{ approvedEntries: BatchEntry[]; approvedIndexes: number[] }> {
  try {
    const approvedIndexes = resolveApprovedEntryIndexes(request, opts);
    const isApproveAll = opts.approvedSourceIndexes === undefined || opts.approvedSourceIndexes === null;
    if (isApproveAll) {
      const gate = evaluateBatchApproveAllGate(await buildBatchConsentCards(request, opts));
      if (gate.approve_all_suppressed) {
        const err: AuthError = new Error(
          `Approve-all is not available for this request (${gate.suppression_reasons.join(", ")}); confirm each source individually`
        );
        err.code = "invalid_request";
        err.param = "approved_source_indexes";
        throw err;
      }
      if (opts.confirmedApproveAll !== true) {
        const err: AuthError = new Error("Approve-all requires a re-asserting confirmation of the per-source list");
        err.code = "invalid_request";
        err.param = "confirm_approve_all";
        throw err;
      }
    }
    const approvedEntries = approvedIndexes.map((index) => {
      const entry = request.entries[index];
      if (!entry) {
        throw bindingError("invalid_request", `Approved source index ${index} is unavailable`);
      }
      return entry;
    });
    requireBatchEntryPolicy(approvedEntries);
    return { approvedEntries, approvedIndexes };
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    return rejectStagedBatchApproval(request, pending, subjectId, err);
  }
}

function requireApprovedSourceNarrowings(sourceNarrowing: Record<string, unknown>, approvedIndexes: number[]): void {
  for (const key of Object.keys(sourceNarrowing)) {
    const index = Number(key);
    if (!(Number.isInteger(index) && approvedIndexes.includes(index))) {
      const err: AuthError = new Error(
        `Narrowing references staged source index ${key}, which is not in the approved set`
      );
      err.code = "invalid_request";
      err.param = "source_narrowing";
      throw err;
    }
  }
}

async function approveStagedGrantBatch(
  deviceCode: string,
  pending: DbRow,
  request: StagedBatchRequest,
  subjectId: string,
  opts: ApproveStagedGrantBatchOptions = {}
): Promise<{ grant: DbRow; package: boolean; package_id: string; token: string }> {
  const traceContext = requirePersistedPendingTraceContext(pending);
  request.trace_context = traceContext;
  const { approvedEntries, approvedIndexes } = await resolveApprovedBatchEntries(request, pending, subjectId, opts);
  const sourceNarrowing = opts.sourceNarrowing && typeof opts.sourceNarrowing === "object" ? opts.sourceNarrowing : {};
  requireApprovedSourceNarrowings(sourceNarrowing, approvedIndexes);

  let registeredClient: RegisteredClient;
  let parentPackage: GrantPackageNormalized | null = null;
  const resolvedEntries: {
    entry: BatchEntry;
    manifest: DbRow;
    resolvedStreams: StreamSelection[];
    slice: PendingRequest;
    sourceBinding: SourceBinding;
    storageBinding: StorageBinding;
  }[] = [];
  try {
    registeredClient = await requirePendingRequestClientRegistration(request, { ...opts });
    // Re-validate incremental add-source linkage now that the approving owner
    // (subjectId) is known. Fail closed before any new package row or child
    // grant is written if the parent is missing, cross-client, cross-owner,
    // or no longer active. The prior package and its child grants are never
    // re-issued or mutated by this link.
    parentPackage = await requireValidParentPackageLinkage(request.parent_package_id, {
      clientId: registeredClient.client_id,
      subjectId,
    });
    await forEachSequential(approvedEntries, async (entry, position) => {
      const stagedIndex = approvedIndexes[position];
      if (stagedIndex === undefined) {
        throw bindingError("invalid_request", `Approved source position ${position} is unavailable`);
      }
      const slice = asSingleEntryRequestSlice(request, entry);
      requireStructuredPendingRequestShape(slice);
      const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(slice);
      entry.source_binding = describeSourceBinding(sourceBinding);
      entry.storage_binding = normalizeStorageBinding(storageBinding);
      const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
      slice.manifest_version = entry.manifest_version;
      const baselineStreams = requirePendingRequestContractAgainstManifest(slice, manifest);
      // Apply owner per-source narrowing against the staged resolved baseline.
      // narrowResolvedSelectionForSource proves the result is a subset/tightening
      // of what the client staged; widening throws invalid_request here, before
      // any package row or child grant is written.
      const resolvedStreams = narrowResolvedSelectionForSource(
        baselineStreams,
        isRecord(sourceNarrowing[stagedIndex]) ? sourceNarrowing[stagedIndex] : null,
        sourceBinding.id || `source ${stagedIndex + 1}`
      );
      resolvedEntries.push({ entry, manifest, resolvedStreams, slice, sourceBinding, storageBinding });
    });
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    const [firstEntry] = request.entries;
    await emitPendingConsentRejected(
      {
        client: request.client,
        ...(firstEntry ? { selection: firstEntry.selection, source_binding: firstEntry.source_binding } : {}),
      },
      pending,
      err,
      { subjectId }
    );
    throw err;
  }

  const packageId = generateId("gpkg");
  const createdAt = nowIso();
  const packageEnvelope = {
    approved_source_count: resolvedEntries.length,
    approved_source_indexes: approvedIndexes,
    client: {
      client_id: registeredClient.client_id,
      ...(request.client.client_display ? { client_display: request.client.client_display } : {}),
    },
    package_id: packageId,
    source_bounded_child_grants: true,
    staged_source_count: request.entries.length,
    subject: { id: subjectId },
    version: "reference.batch_consent.v1",
    ...(parentPackage ? { parent_package_id: parentPackage.package_id } : {}),
  };

  const parentPackageId = parentPackage ? parentPackage.package_id : null;
  await getGrantPackageStore().insertPackage({
    approvedAt: createdAt,
    clientId: registeredClient.client_id,
    createdAt,
    packageId,
    packageJson: JSON.stringify(packageEnvelope),
    parentPackageId,
    scenarioId: traceContext.scenario_id ?? null,
    subjectId,
    traceId: traceContext.trace_id,
  });

  const childGrants: { grant: GrantEnvelope; source: Record<string, unknown> | null; token: string }[] = [];
  await forEachSequential(resolvedEntries, async (resolved) => {
    const { grant, token } = await persistChildGrantForPackage({
      manifest: resolved.manifest,
      registeredClient,
      request: resolved.slice,
      resolvedStreams: resolved.resolvedStreams,
      sourceBinding: resolved.sourceBinding,
      storageBinding: resolved.storageBinding,
      subjectId,
      traceContext,
    });
    const source = describePackageMemberSource(grant);
    if (!isNonEmptyString(grant.grant_id)) {
      throw bindingError("grant_invalid", "Issued child grant is missing grant_id");
    }
    const addedAt = nowIso();
    await getGrantPackageStore().insertPackageMember({
      addedAt,
      grantId: grant.grant_id,
      packageId,
      sourceJson: JSON.stringify(source),
      tokenId: token,
    });
    childGrants.push({ grant, source, token });
  });

  await emitSpineEvent({
    actor_id: subjectId,
    actor_type: "subject",
    client_id: registeredClient.client_id,
    data: {
      approved_source_indexes: approvedIndexes,
      package_id: packageId,
      user_code: pending.user_code,
    },
    event_type: "consent.approved",
    object_id: deviceCode,
    object_type: "pending_consent",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    trace_id: traceContext.trace_id,
  });

  const packageToken = await issuePackageToken(packageId, subjectId, registeredClient.client_id, null, {
    source: "batch_consent_package",
    traceContext,
  });

  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: registeredClient.client_id,
    data: {
      child_grant_ids: childGrants.map((entry) => entry.grant.grant_id),
      sources: childGrants.map((entry) => entry.source),
    },
    event_type: "grant_package.issued",
    object_id: packageId,
    object_type: "grant_package",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    token_id: packageToken,
    trace_id: traceContext.trace_id,
  });

  await markPendingConsentApproved(deviceCode, {
    aiTrainingConsented: false,
    grantId: packageId,
    subjectId,
    tokenId: packageToken,
  });

  return {
    grant: {
      child_grants: childGrants.map((entry) => ({
        grant_id: entry.grant.grant_id,
        source: entry.source,
      })),
      grant_id: packageId,
      package: true,
      package_id: packageId,
    },
    package: true,
    package_id: packageId,
    token: packageToken,
  };
}

/**
 * Get pending consent request for display in consent UI
 */
export async function getPendingConsent(
  deviceCode: string,
  opts: { nativeManifest?: DbRow | null } = {}
): Promise<Record<string, unknown> | null> {
  const row = await getPendingConsentRow(deviceCode);
  if (!row) {
    return null;
  }
  if (row.status !== "pending") {
    return null;
  }
  if (isExpired(row)) {
    await markPendingConsentExpired(deviceCode);
    return null;
  }
  if (!isNonEmptyString(row.params_json)) {
    throw bindingError("invalid_request", "Pending consent request payload is missing");
  }
  const request: unknown = JSON.parse(row.params_json);
  if (!isRecord(request)) {
    throw bindingError("invalid_request", "Pending consent request payload must be an object");
  }
  request.trace_context = requirePersistedPendingTraceContext(row);
  if (isStagedBatchRequest(request)) {
    return getPendingConsentBatch(request, row, opts);
  }
  let resolvedStreams: StreamSelection[] | null = null;
  let manifestStreamNames: string[] | null = null;
  try {
    requireStructuredPendingRequestShape(request);
    await requirePendingRequestClientRegistration(request, opts);
    const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request);
    request.source_binding = describeSourceBinding(sourceBinding);
    request.storage_binding = normalizeStorageBinding(storageBinding);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding);
    resolvedStreams = requirePendingRequestContractAgainstManifest(request, manifest);
    manifestStreamNames = Array.isArray(manifest.streams)
      ? manifest.streams.map((stream) => stream.name).filter((name) => typeof name === "string")
      : null;
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    await emitPendingConsentRejected(request, row, err);
    throw err;
  }
  return {
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    manifestStreamNames,
    request,
    resolvedStreams,
    userCode: row.user_code,
  };
}

/**
 * Approve a pending grant request — creates the grant and access token
 * Called by the current consent surface after user approval.
 * This is grant issuance, not owner authentication.
 */
export async function approveGrant(
  deviceCode: string,
  subjectId = "owner_local",
  opts: { ai_training_consented?: boolean | null; nativeManifest?: DbRow | null; baseUrl?: string } = {}
): Promise<{ grant: DbRow; token: string }> {
  const pending = await getPendingConsentRow(deviceCode);
  if (!pending) {
    const err: AuthError = new Error("Unknown device code");
    err.code = "not_found";
    throw err;
  }
  if (pending.status !== "pending") {
    const err: AuthError = new Error("Pending consent request is not available");
    err.code = "not_found";
    throw err;
  }
  if (isExpired(pending)) {
    await markPendingConsentExpired(deviceCode);
    const err: AuthError = new Error("Pending consent request has expired");
    err.code = "not_found";
    throw err;
  }

  if (!isNonEmptyString(pending.params_json)) {
    throw bindingError("invalid_request", "Pending consent request payload is missing");
  }
  const request: unknown = JSON.parse(pending.params_json);
  if (isStagedBatchRequest(request)) {
    return approveStagedGrantBatch(deviceCode, pending, request, subjectId, opts);
  }
  requireStructuredPendingRequestShape(request);
  const traceContext = requirePersistedPendingTraceContext(pending);
  request.trace_context = traceContext;
  let registeredClient: RegisteredClient;
  let sourceBinding: SourceBinding;
  let storageBinding: StorageBinding;
  let manifest: DbRow;
  let resolvedStreams: StreamSelection[];

  try {
    registeredClient = await requirePendingRequestClientRegistration(request, opts);
    ({ sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request));
    request.source_binding = describeSourceBinding(sourceBinding);
    request.storage_binding = normalizeStorageBinding(storageBinding);
    manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    resolvedStreams = requirePendingRequestContractAgainstManifest(request, manifest);
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    await emitPendingConsentRejected(request, pending, err, { subjectId });
    throw err;
  }

  const { client, selection } = request;

  // The AS MUST obtain explicit affirmative consent before issuing ai_training grants.
  // A missing affirmation is a consent-policy rejection, not an internal failure;
  // surface it as a typed PDPP error envelope (status 400, code `invalid_request`)
  // so callers do not see it as a generic 500.
  const { ai_training_consented } = opts;
  if (selection.purpose_code === "https://pdpp.org/purpose/ai_training" && !ai_training_consented) {
    const err: AuthError = new Error("Explicit affirmative consent required for ai_training purpose");
    err.code = "invalid_request";
    err.param = "ai_training_consented";
    throw err;
  }

  const grantId = generateId("grt");
  const issuedAt = nowIso();
  const expiresAt =
    selection.access_mode === "single_use"
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24h reference default
      : null;

  const persistedSource = describeSourceBinding(sourceBinding);
  const persistedStorageBinding = normalizeStorageBinding(storageBinding);

  const grant: GrantEnvelope = {
    access_mode: selection.access_mode,
    client: {
      client_id: registeredClient.client_id,
      registration_mode: registeredClient.registration_mode || "pre_registered_public",
      ...(client.client_display ? { client_display: client.client_display } : {}),
    },
    expires_at: expiresAt,
    grant_id: grantId,
    issued_at: issuedAt,
    manifest_version: requireManifestVersion(manifest),
    purpose_code: selection.purpose_code,
    purpose_description: selection.purpose_description,
    retention: selection.retention,
    source: persistedSource,
    streams: resolvedStreams,
    subject: { id: subjectId },
    version: "0.1.0",
  };

  // Same grants-row INSERT the grant-package child-grant flow uses; reuse the
  // shared store method so the two call sites cannot drift.
  await getGrantPackageStore().insertChildGrant({
    accessMode: selection.access_mode,
    clientId: registeredClient.client_id,
    expiresAt,
    grantId,
    grantJson: JSON.stringify(grant),
    issuedAt,
    scenarioId: traceContext.scenario_id ?? null,
    storageBindingJson: serializeStorageBinding(persistedStorageBinding),
    subjectId,
    traceId: traceContext.trace_id,
  });

  await emitSpineEvent({
    actor_id: subjectId,
    actor_type: "subject",
    client_id: registeredClient.client_id,
    data: {
      source: describeSourceBinding(sourceBinding),
      user_code: pending.user_code,
    },
    event_type: "consent.approved",
    grant_id: grantId,
    object_id: deviceCode,
    object_type: "pending_consent",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    trace_id: traceContext.trace_id,
  });

  const grantIssuedEventData = {
    access_mode: selection.access_mode,
    purpose_code: selection.purpose_code,
    retention: selection.retention ?? null,
    source: describeGrantSource(grant),
    stream_names: resolvedStreams.map((stream) => stream.name),
  };

  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: registeredClient.client_id,
    data: grantIssuedEventData,
    event_type: "grant.issued",
    grant_id: grantId,
    object_id: grantId,
    object_type: "grant",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    trace_id: traceContext.trace_id,
  });

  // Issue access token
  const token = await issueToken(grantId, subjectId, registeredClient.client_id, expiresAt, {
    source: "grant_approval",
    traceContext,
  });

  await markPendingConsentApproved(deviceCode, {
    aiTrainingConsented: ai_training_consented,
    grantId,
    subjectId,
    tokenId: token,
  });

  return { grant, token };
}

function buildGrantScopedDeviceExchangeError(code: string, message: string, row: DbRow | null = null): AuthError {
  const err: AuthError = new Error(message);
  err.code = code;
  if (row) {
    attachTraceContext(err, getPersistedPendingTraceContext(row));
  }
  return err;
}

function parsePendingConsentParams(row: DbRow): Record<string, unknown> {
  if (!isNonEmptyString(row.params_json)) {
    throw buildGrantScopedDeviceExchangeError("invalid_grant", "Pending consent request is malformed", row);
  }
  try {
    const parsed: unknown = JSON.parse(row.params_json);
    if (!isRecord(parsed)) {
      throw new Error("Pending consent params must be an object");
    }
    return parsed;
  } catch (cause: unknown) {
    const err = buildGrantScopedDeviceExchangeError("invalid_grant", "Pending consent request is malformed", row);
    err.cause = cause;
    throw err;
  }
}

async function requireApprovedGrantScopedDeviceCode(row: DbRow, deviceCode: string): Promise<void> {
  if (row.status === "pending" && isExpired(row)) {
    await markPendingConsentExpired(deviceCode);
    throw buildGrantScopedDeviceExchangeError("expired_token", "Device code has expired", row);
  }
  if (row.status === "pending") {
    if (row.last_polled_at) {
      const intervalSeconds =
        Number.isFinite(Number(row.interval_seconds)) && Number(row.interval_seconds) > 0
          ? Number(row.interval_seconds)
          : 2;
      const sinceLastPollMs = Date.now() - new Date(row.last_polled_at).getTime();
      if (sinceLastPollMs < intervalSeconds * 1000) {
        throw buildGrantScopedDeviceExchangeError("slow_down", "Polling too quickly", row);
      }
    }
    await updatePendingConsentLastPolled(deviceCode);
    throw buildGrantScopedDeviceExchangeError("authorization_pending", "Authorization still pending", row);
  }
  if (row.status === "denied") {
    throw buildGrantScopedDeviceExchangeError("access_denied", "The resource owner denied the request", row);
  }
  if (row.status === "expired") {
    throw buildGrantScopedDeviceExchangeError("expired_token", "Device code has expired", row);
  }
  if (row.status !== "approved" || !row.token_id) {
    throw buildGrantScopedDeviceExchangeError("invalid_grant", "Device code is not redeemable", row);
  }
}

async function buildGrantScopedDeviceTokenPayload(row: DbRow, clientId: string): Promise<Record<string, unknown>> {
  const tokenInfo = await introspect(row.token_id);
  if (!tokenInfo.active) {
    throw buildGrantScopedDeviceExchangeError("expired_token", "Client token is no longer active", row);
  }
  if (tokenInfo.pdpp_token_kind !== "client" && tokenInfo.pdpp_token_kind !== "mcp_package") {
    throw buildGrantScopedDeviceExchangeError(
      "invalid_grant",
      "Device code did not redeem to a grant-scoped MCP client token",
      row
    );
  }
  if (tokenInfo.client_id !== clientId) {
    throw buildGrantScopedDeviceExchangeError("invalid_client", "Client token is not bound to this client_id", row);
  }
  const exp =
    typeof tokenInfo.exp === "number" && Number.isFinite(tokenInfo.exp) && tokenInfo.exp
      ? tokenInfo.exp
      : Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const payload: Record<string, unknown> = {
    access_token: row.token_id,
    expires_in: Math.max(exp - Math.floor(Date.now() / 1000), 0),
    token_type: "Bearer",
    trace_context: getPersistedPendingTraceContext(row),
  };
  if (tokenInfo.pdpp_token_kind === "mcp_package") {
    payload.grant_package_id = tokenInfo.grant_package_id || row.grant_id || null;
  } else {
    payload.grant_id = tokenInfo.grant_id || row.grant_id || null;
  }
  return payload;
}

/**
 * Redeem an approved pending-consent device code as a grant-scoped MCP
 * client token. This intentionally uses the existing pending-consent grant
 * machinery: device authorization is only a headless transport into the same
 * approval path, not a parallel grant engine.
 */
export async function exchangeGrantScopedDeviceCode({
  clientId,
  deviceCode,
}: {
  clientId: string;
  deviceCode: string;
}): Promise<Record<string, unknown>> {
  if (!(clientId && deviceCode)) {
    throw buildGrantScopedDeviceExchangeError("invalid_request", "client_id and device_code are required");
  }

  const row = await getPendingConsentRow(deviceCode);
  if (!row) {
    throw buildGrantScopedDeviceExchangeError("invalid_grant", "Unknown or invalid device_code");
  }

  const request = parsePendingConsentParams(row);
  const requestClientId = isRecord(request.client) ? request.client.client_id : null;
  if (requestClientId !== clientId) {
    throw buildGrantScopedDeviceExchangeError("invalid_client", "device_code is not bound to this client_id", row);
  }

  await requireApprovedGrantScopedDeviceCode(row, deviceCode);
  return buildGrantScopedDeviceTokenPayload(row, clientId);
}

function isUsableAuthorizationCodePkceChallenge(challenge: unknown, method: unknown): boolean {
  return (
    isNonEmptyString(challenge) &&
    PKCE_CODE_VERIFIER_RE.test(challenge) &&
    isNonEmptyString(method) &&
    SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS.has(method)
  );
}

function buildOAuthAuthorizationCodeError(code: string, message: string): AuthError {
  const err: AuthError = new Error(message);
  err.code = code;
  return err;
}

function clientSupportsOAuthRefreshToken(registeredClient: RegisteredClient | null | undefined): boolean {
  if (!registeredClient) {
    return false;
  }
  return registeredClient.metadata.grant_types?.includes("refresh_token") === true;
}

function buildOAuthRefreshTokenError(code: string, message: string): AuthError {
  const err: AuthError = new Error(message);
  err.code = code;
  return err;
}

async function issueOAuthRefreshToken({
  clientId,
  grantId,
  subjectId,
  expiresAt = null,
}: {
  clientId: string;
  grantId: string;
  subjectId: string;
  expiresAt?: string | null;
}): Promise<string> {
  const refreshToken = generateOAuthRefreshToken();
  const refreshTokenHash = hashOAuthRefreshToken(refreshToken);
  const createdAt = nowIso();
  await getRefreshTokenStore().insert({ clientId, createdAt, expiresAt, grantId, refreshTokenHash, subjectId });
  return refreshToken;
}

async function issueOAuthRefreshTokenForPackage({
  clientId,
  packageId,
  subjectId,
  expiresAt = null,
}: {
  clientId: string;
  packageId: string;
  subjectId: string;
  expiresAt?: string | null;
}): Promise<string> {
  const refreshToken = generateOAuthRefreshToken();
  const refreshTokenHash = hashOAuthRefreshToken(refreshToken);
  const createdAt = nowIso();
  await getRefreshTokenStore().insertForPackage({
    clientId,
    createdAt,
    expiresAt,
    packageId,
    refreshTokenHash,
    subjectId,
  });
  return refreshToken;
}

// Grant-package row operations. One adapter per backend; the dialect SQL
// moves verbatim from the inline `isPostgresStorageBackend()` branches that
// previously lived in each helper below. Every method is a single conceptual
// row operation (one statement, or the cohesive revoke cascade); all
// orchestration (spine events, the child-grant loop, envelope building,
// row normalization, partial-failure accounting) stays caller-side so the
// adapters remain thin and dialect-only.
const postgresGrantPackageStore: GrantPackageStore = {
  getPackageById: (packageId) =>
    pgOne(
      `SELECT package_id, subject_id, client_id, status, package_json::text AS package_json,
              parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
         FROM grant_packages
         WHERE package_id = $1`,
      [packageId]
    ),
  getPackageIdForGrant: (grantId) =>
    pgOne(
      `SELECT package_id
         FROM grant_package_members
         WHERE grant_id = $1
         ORDER BY added_at
         LIMIT 1`,
      [grantId]
    ),
  insertChildGrant: ({
    grantId,
    subjectId,
    clientId,
    storageBindingJson,
    grantJson,
    accessMode,
    issuedAt,
    expiresAt,
    traceId,
    scenarioId,
  }) =>
    pgExec(
      `INSERT INTO grants(
         grant_id, subject_id, client_id, storage_binding_json, grant_json,
         access_mode, issued_at, expires_at, trace_id, scenario_id
       ) VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        grantId,
        subjectId,
        clientId,
        storageBindingJson,
        grantJson,
        accessMode,
        issuedAt,
        expiresAt,
        traceId,
        scenarioId,
      ]
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
  }) =>
    pgExec(
      `INSERT INTO grant_packages(
         package_id, subject_id, client_id, status, package_json,
         parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
       ) VALUES($1, $2, $3, 'active', $4::jsonb, $5, $6, $7, $8, $9, NULL)`,
      [packageId, subjectId, clientId, packageJson, parentPackageId, traceId, scenarioId, createdAt, approvedAt]
    ),
  insertPackageMember: ({ packageId, grantId, tokenId, sourceJson, addedAt }) =>
    pgExec(
      `INSERT INTO grant_package_members(
         package_id, grant_id, token_id, source_json, status, added_at, revoked_at
       ) VALUES($1, $2, $3, $4::jsonb, 'active', $5, NULL)`,
      [packageId, grantId, tokenId, sourceJson, addedAt]
    ),
  insertPackageToken: ({ tokenId, packageId, subjectId, clientId, expiresAt }) =>
    pgExec(
      `INSERT INTO tokens(token_id, grant_id, package_id, subject_id, client_id, token_kind, expires_at)
       VALUES($1, NULL, $2, $3, $4, 'mcp_package', $5)`,
      [tokenId, packageId, subjectId, clientId, expiresAt]
    ),
  listActiveMembers: async (packageId) =>
    (
      await postgresQuery<GrantPackageMemberRow>(
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
    ).rows,
  listAllMembers: async (packageId) =>
    (
      await postgresQuery<GrantPackageMemberRow>(
        `SELECT gm.package_id, gm.grant_id, gm.source_json::text AS source_json,
              gm.status AS member_status, gm.added_at, gm.revoked_at AS member_revoked_at,
              g.status AS grant_status
         FROM grant_package_members gm
         JOIN grants g ON gm.grant_id = g.grant_id
         WHERE gm.package_id = $1
         ORDER BY gm.added_at, gm.grant_id`,
        [packageId]
      )
    ).rows,
  markMemberRevoked: ({ packageId, grantId, revokedAt }) =>
    pgExec(
      `UPDATE grant_package_members
       SET status = 'revoked', revoked_at = $1
       WHERE package_id = $2 AND grant_id = $3 AND status = 'active'`,
      [revokedAt, packageId, grantId]
    ),
  markPackageRevokedCascade: async ({ packageId, revokedAt }) => {
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
  getPackageById: (packageId) => getOne(referenceQueries.authGrantPackagesGetById, [packageId]),
  getPackageIdForGrant: (grantId) => getOne(referenceQueries.authGrantPackageMembersGetPackageIdByGrant, [grantId]),
  insertChildGrant: ({
    grantId,
    subjectId,
    clientId,
    storageBindingJson,
    grantJson,
    accessMode,
    issuedAt,
    expiresAt,
    traceId,
    scenarioId,
  }) =>
    exec(referenceQueries.authGrantsInsert, [
      grantId,
      subjectId,
      clientId,
      storageBindingJson,
      grantJson,
      accessMode,
      issuedAt,
      expiresAt,
      traceId,
      scenarioId,
    ]),
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
  }) =>
    exec(referenceQueries.authGrantPackagesInsert, [
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
  insertPackageMember: ({ packageId, grantId, tokenId, sourceJson, addedAt }) =>
    exec(referenceQueries.authGrantPackageMembersInsert, [packageId, grantId, tokenId, sourceJson, addedAt]),
  insertPackageToken: ({ tokenId, packageId, subjectId, clientId, expiresAt }) =>
    exec(referenceQueries.authTokensInsertMcpPackage, [tokenId, packageId, subjectId, clientId, expiresAt]),
  listActiveMembers: (packageId) =>
    allowUnboundedReadAcknowledged<GrantPackageMemberRow>(referenceQueries.authGrantPackageMembersListActiveByPackage, [
      packageId,
    ]),
  listAllMembers: (packageId) =>
    allowUnboundedReadAcknowledged<GrantPackageMemberRow>(referenceQueries.authGrantPackageMembersListAllByPackage, [
      packageId,
    ]),
  markMemberRevoked: ({ packageId, grantId, revokedAt }) =>
    exec(referenceQueries.authGrantPackageMembersMarkRevokedByGrant, [revokedAt, packageId, grantId]),
  markPackageRevokedCascade: ({ packageId, revokedAt }) => {
    exec(referenceQueries.authGrantPackagesMarkRevoked, [revokedAt, packageId]);
    exec(referenceQueries.authTokensRevokeByPackage, [packageId]);
    exec(referenceQueries.authGrantPackageMembersMarkRevokedByPackage, [revokedAt, packageId]);
    exec(referenceQueries.authOauthRefreshTokensRevokeByPackage, [revokedAt, packageId]);
  },
};

function getGrantPackageStore() {
  return isPostgresStorageBackend() ? postgresGrantPackageStore : sqliteGrantPackageStore;
}

// Three cohesive, domain-local stores for the dialect-only token /
// oauth-authorization-code / oauth-refresh-token row seams. Each method is the
// SAME conceptual row op differing ONLY by SQL dialect (placeholder $1.. vs ?,
// the introspection join, status literals). Dialect SQL/queries move VERBATIM
// from the old inline `isPostgresStorageBackend()` branches; the adapters
// return RAW rows (or perform the write and return its `{ changes }`) and the
// orchestration (row shaping, expiry checks, PKCE verification, error mapping,
// spine events, single-use guards) stays in the calling functions. The backend
// is selected ONCE per op via isPostgresStorageBackend(), mirroring the
// existing getPendingConsentStore / getOwnerDeviceAuthStore / getGrantPackageStore
// precedent.
//
// SKIPPED (left as honest inline keeps, not folded into these stores):
//   - issueToken: the Postgres branch is a withPostgresTransaction(SELECT ...
//     FOR UPDATE, UPDATE consumed, INSERT token) and the SQLite branch is a
//     synchronous transaction(); divergent multi-statement control flow, not a
//     single dialect-only op.
//   - the grant-revoke and grant-package-revoke token / refresh-token cascades:
//     multi-statement cascades already isolated in their orchestration
//     (revokeGrant, markPackageRevokedCascade); wrapping adds an incidental hop.
const postgresOAuthCodeStore: OAuthCodeStore = {
  consumeCode: ({ consumedAt, code }) =>
    pgExec(
      `UPDATE oauth_authorization_codes
         SET status = 'consumed', consumed_at = $1
         WHERE code = $2 AND status = 'issued' AND consumed_at IS NULL`,
      [consumedAt, code]
    ),
  getByCode: (code) =>
    pgOne<OAuthIssuedCodeRow>(
      `SELECT id, code, client_id, redirect_uri, code_challenge, code_challenge_method,
                status, grant_id, package_id, token_id, expires_at, consumed_at
         FROM oauth_authorization_codes
         WHERE code = $1`,
      [code]
    ),
  getByDeviceCode: (deviceCode) =>
    pgOne<OAuthPendingCodeRow>(
      `SELECT id, device_code, client_id, redirect_uri, state, status, expires_at
         FROM oauth_authorization_codes
         WHERE device_code = $1`,
      [deviceCode]
    ),
  issueForDeviceCode: ({ code, grantId, token, issuedAt, expiresAt, deviceCode }) =>
    pgExec(
      `UPDATE oauth_authorization_codes
       SET code = $1, grant_id = $2, token_id = $3, status = 'issued',
           issued_at = $4, expires_at = $5
       WHERE device_code = $6 AND status = 'pending'`,
      [code, grantId, token, issuedAt, expiresAt, deviceCode]
    ),
  issueForPackageDeviceCode: ({ code, packageId, token, issuedAt, expiresAt, deviceCode }) =>
    pgExec(
      `UPDATE oauth_authorization_codes
       SET code = $1, grant_id = NULL, package_id = $2, token_id = $3, status = 'issued',
           issued_at = $4, expires_at = $5
       WHERE device_code = $6 AND status = 'pending'`,
      [code, packageId, token, issuedAt, expiresAt, deviceCode]
    ),
  markExpiredByDeviceCode: (deviceCode) =>
    pgExec(`UPDATE oauth_authorization_codes SET status = 'expired' WHERE device_code = $1 AND status = 'pending'`, [
      deviceCode,
    ]),
  upsertPending: ({
    id,
    deviceCode,
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
    createdAt,
    expiresAt,
  }) =>
    pgExec(
      `INSERT INTO oauth_authorization_codes(
         id, device_code, client_id, redirect_uri, state, code_challenge,
         code_challenge_method, status, created_at, expires_at
       ) VALUES($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
       ON CONFLICT(device_code) DO UPDATE SET
         client_id = excluded.client_id,
         redirect_uri = excluded.redirect_uri,
         state = excluded.state,
         code_challenge = excluded.code_challenge,
         code_challenge_method = excluded.code_challenge_method,
         status = 'pending',
         code = NULL,
         grant_id = NULL,
         token_id = NULL,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         issued_at = NULL,
         consumed_at = NULL`,
      [id, deviceCode, clientId, redirectUri, state, codeChallenge, codeChallengeMethod, createdAt, expiresAt]
    ),
};

const sqliteOAuthCodeStore: OAuthCodeStore = {
  consumeCode: ({ consumedAt, code }) =>
    exec(referenceQueries.authOauthAuthorizationCodesConsumeCode, [consumedAt, code]),
  getByCode: (code) => getOne<OAuthIssuedCodeRow>(referenceQueries.authOauthAuthorizationCodesGetByCode, [code]),
  getByDeviceCode: (deviceCode) =>
    getOne<OAuthPendingCodeRow>(referenceQueries.authOauthAuthorizationCodesGetByDeviceCode, [deviceCode]),
  issueForDeviceCode: ({ code, grantId, token, issuedAt, expiresAt, deviceCode }) =>
    exec(referenceQueries.authOauthAuthorizationCodesIssueForDeviceCode, [
      code,
      grantId,
      token,
      issuedAt,
      expiresAt,
      deviceCode,
    ]),
  issueForPackageDeviceCode: ({ code, packageId, token, issuedAt, expiresAt, deviceCode }) =>
    exec(
      requireMutationQuery(
        referenceQueries.authOauthAuthorizationCodesIssuePackageForDeviceCode,
        "authOauthAuthorizationCodesIssuePackageForDeviceCode"
      ),
      [code, packageId, token, issuedAt, expiresAt, deviceCode]
    ),
  markExpiredByDeviceCode: (deviceCode) =>
    exec(referenceQueries.authOauthAuthorizationCodesMarkExpiredByDeviceCode, [deviceCode]),
  upsertPending: ({
    id,
    deviceCode,
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
    createdAt,
    expiresAt,
  }) =>
    exec(referenceQueries.authOauthAuthorizationCodesUpsertPending, [
      id,
      deviceCode,
      clientId,
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod,
      createdAt,
      expiresAt,
    ]),
};

function getOAuthCodeStore() {
  return isPostgresStorageBackend() ? postgresOAuthCodeStore : sqliteOAuthCodeStore;
}

const postgresRefreshTokenStore: RefreshTokenStore = {
  getByTokenHash: (refreshTokenHash) =>
    pgOne<RefreshTokenRow>(
      `SELECT refresh_token_hash, client_id, grant_id, package_id, subject_id, status,
                created_at, expires_at, last_used_at, revoked_at
         FROM oauth_refresh_tokens
         WHERE refresh_token_hash = $1`,
      [refreshTokenHash]
    ),
  insert: ({ refreshTokenHash, clientId, grantId, subjectId, createdAt, expiresAt }) =>
    pgExec(
      `INSERT INTO oauth_refresh_tokens(
         refresh_token_hash, client_id, grant_id, subject_id, status,
         created_at, expires_at, last_used_at, revoked_at
       ) VALUES($1, $2, $3, $4, 'active', $5, $6, NULL, NULL)`,
      [refreshTokenHash, clientId, grantId, subjectId, createdAt, expiresAt]
    ),
  insertForPackage: ({ refreshTokenHash, clientId, packageId, subjectId, createdAt, expiresAt }) =>
    pgExec(
      `INSERT INTO oauth_refresh_tokens(
         refresh_token_hash, client_id, grant_id, package_id, subject_id, status,
         created_at, expires_at, last_used_at, revoked_at
       ) VALUES($1, $2, NULL, $3, $4, 'active', $5, $6, NULL, NULL)`,
      [refreshTokenHash, clientId, packageId, subjectId, createdAt, expiresAt]
    ),
  markUsed: ({ usedAt, refreshTokenHash }) =>
    pgExec(
      `UPDATE oauth_refresh_tokens
       SET last_used_at = $1
       WHERE refresh_token_hash = $2 AND status = 'active'`,
      [usedAt, refreshTokenHash]
    ),
};

const sqliteRefreshTokenStore: RefreshTokenStore = {
  getByTokenHash: (refreshTokenHash) =>
    getOne<RefreshTokenRow>(referenceQueries.authOauthRefreshTokensGetByToken, [refreshTokenHash]),
  insert: ({ refreshTokenHash, clientId, grantId, subjectId, createdAt, expiresAt }) =>
    exec(referenceQueries.authOauthRefreshTokensInsert, [
      refreshTokenHash,
      clientId,
      grantId,
      subjectId,
      createdAt,
      expiresAt,
    ]),
  insertForPackage: ({ refreshTokenHash, clientId, packageId, subjectId, createdAt, expiresAt }) =>
    exec(
      requireMutationQuery(referenceQueries.authOauthRefreshTokensInsertPackage, "authOauthRefreshTokensInsertPackage"),
      [refreshTokenHash, clientId, packageId, subjectId, createdAt, expiresAt]
    ),
  markUsed: ({ usedAt, refreshTokenHash }) =>
    exec(referenceQueries.authOauthRefreshTokensMarkUsed, [usedAt, refreshTokenHash]),
};

function getRefreshTokenStore() {
  return isPostgresStorageBackend() ? postgresRefreshTokenStore : sqliteRefreshTokenStore;
}

const postgresTokenStore: TokenStore = {
  getIntrospection: (token) =>
    pgOne<TokenIntrospectionRow>(
      `SELECT t.token_id, t.grant_id, t.package_id, t.subject_id, t.client_id, t.token_kind, t.expires_at, t.revoked,
                g.status AS grant_status,
                g.grant_json::text AS grant_json,
                g.trace_id,
                g.scenario_id,
                gp.status AS package_status,
                gp.package_json::text AS package_json,
                gp.trace_id AS package_trace_id,
                gp.scenario_id AS package_scenario_id,
                g.storage_binding_json::text AS storage_binding_json
         FROM tokens t
         LEFT JOIN grants g ON t.grant_id = g.grant_id
         LEFT JOIN grant_packages gp ON t.package_id = gp.package_id
         WHERE t.token_id = $1`,
      [token]
    ),
  insertOwner: ({ tokenId, subjectId, clientId, expiresAt }) =>
    pgExec(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
       VALUES($1, NULL, $2, $3, 'owner', $4)`,
      [tokenId, subjectId, clientId, expiresAt]
    ),
  // REVIEWED-BOUNDED: live bearers per operator client are operator-scale
  // (small). The mirrored SQLite query's @max_rows=256 caps pathological growth.
  listActiveByClientId: async (clientId) =>
    (
      await postgresQuery(
        `SELECT token_id, token_kind, created_at, expires_at
       FROM tokens
       WHERE client_id = $1 AND revoked = FALSE
       ORDER BY created_at DESC`,
        [clientId]
      )
    ).rows,
  revokeByClientId: (clientId) =>
    pgExec("UPDATE tokens SET revoked = TRUE WHERE client_id = $1 AND revoked = FALSE", [clientId]),
  revokeByTokenId: (tokenId, clientId) =>
    pgExec("UPDATE tokens SET revoked = TRUE WHERE token_id = $1 AND client_id = $2 AND revoked = FALSE", [
      tokenId,
      clientId,
    ]),
};

const sqliteTokenStore: TokenStore = {
  getIntrospection: (token) => getOne<TokenIntrospectionRow>(referenceQueries.authTokensGetIntrospection, [token]),
  insertOwner: ({ tokenId, subjectId, clientId, expiresAt }) =>
    exec(referenceQueries.authTokensInsertOwner, [tokenId, subjectId, clientId, expiresAt]),
  listActiveByClientId: (clientId) =>
    allowUnboundedReadAcknowledged(referenceQueries.authTokensListActiveByClientId, [clientId]),
  revokeByClientId: (clientId) => exec(referenceQueries.authTokensRevokeByClientId, [clientId]),
  revokeByTokenId: (tokenId, clientId) => exec(referenceQueries.authTokensRevokeByTokenId, [tokenId, clientId]),
};

function getTokenStore() {
  return isPostgresStorageBackend() ? postgresTokenStore : sqliteTokenStore;
}

async function issuePackageToken(
  packageId: string,
  subjectId: string,
  clientId: string,
  expiresAt: string | null = null,
  meta: { traceContext?: TraceContext | null; source?: string } = {}
): Promise<string> {
  const tokenId = generateToken();
  await getGrantPackageStore().insertPackageToken({ clientId, expiresAt, packageId, subjectId, tokenId });

  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: clientId,
    data: {
      grant_package_id: packageId,
      issuance_path: meta.source || "hosted_mcp_package",
      token_kind: "mcp_package",
    },
    event_type: "token.issued",
    object_id: tokenId,
    object_type: "token",
    request_id: meta.traceContext?.request_id || undefined,
    scenario_id: meta.traceContext?.scenario_id || undefined,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    token_id: tokenId,
    trace_id: meta.traceContext?.trace_id || undefined,
  });

  return tokenId;
}

function parsePackageJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizePackageRow(row: DbRow | null | undefined): GrantPackageNormalized | null {
  if (
    !(
      row &&
      isNonEmptyString(row.approved_at) &&
      isNonEmptyString(row.client_id) &&
      isNonEmptyString(row.created_at) &&
      isNonEmptyString(row.package_id) &&
      isNonEmptyString(row.status) &&
      isNonEmptyString(row.subject_id)
    )
  ) {
    return null;
  }
  return {
    approved_at: row.approved_at,
    client_id: row.client_id,
    created_at: row.created_at,
    package: parsePackageJson(row.package_json),
    package_id: row.package_id,
    parent_package_id: row.parent_package_id || null,
    revoked_at: row.revoked_at || null,
    scenario_id: row.scenario_id || null,
    status: row.status,
    subject_id: row.subject_id,
    trace_id: row.trace_id || null,
  };
}

/**
 * Fetch a raw grant_packages row (status-agnostic) for lineage validation.
 * Mirrors the column set used by `getGrantPackageForOwner` and includes
 * `parent_package_id` so the linkage chain can be walked.
 */
async function getGrantPackageRow(packageId: unknown): Promise<GrantPackageNormalized | null> {
  if (!isNonEmptyString(packageId)) {
    return null;
  }
  const row = await getGrantPackageStore().getPackageById(packageId);
  return normalizePackageRow(row);
}

/**
 * Validate an incremental add-source `parent_package_id` against the staged
 * batch's client and owner. Fails closed (typed `invalid_request`) when the
 * parent is missing, belongs to a different client, belongs to a different
 * owner, or is not active. Returns the normalized parent package row when
 * valid. `parent_package_id` is lineage/cumulative-view metadata only; this
 * check governs whether a *new* package may record the link, never whether
 * the prior package's grants change (they never do).
 */
async function requireValidParentPackageLinkage(
  parentPackageId: unknown,
  { clientId, subjectId }: { clientId?: string; subjectId?: string } = {}
): Promise<GrantPackageNormalized | null> {
  if (parentPackageId === undefined || parentPackageId === null) {
    return null;
  }
  const linkageError = (message: string): AuthError => {
    const err: AuthError = new Error(message);
    err.code = "invalid_request";
    err.param = "parent_package_id";
    return err;
  };
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
    throw linkageError(`parent_package_id ${parentPackageId} is ${parent.status}; cannot link to an inactive package`);
  }
  return parent;
}

function describePackageMemberSource(
  grant: DbRow,
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

function isRawConnectionDisplayName(source: Record<string, unknown> | null | undefined): boolean {
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
  const connectorId = isNonEmptyString(sanitized.id) ? sanitized.id : null;
  if (isNonEmptyString(ownerSubjectId) && connectorId) {
    const active = await listActiveBindingsForGrant({ connectorId, ownerSubjectId }).catch(() => []);
    const binding = active.find((row) => row.connectorInstanceId === sanitized.connection_id) || null;
    const displayName = projectBindingForWire(binding)?.display_name || null;
    if (displayName) {
      sanitized.display_name = displayName;
      return sanitized;
    }
  }

  Reflect.deleteProperty(sanitized, "display_name");
  return sanitized;
}

/**
 * Persist one source-bounded child grant + access token for a hosted MCP
 * grant package. Mirrors the durable steps in `approveGrant` for one
 * `authorization_details[]` entry, without the consent-row / pending-consent
 * coupling. Returns `{ grant, token, expiresAt }`.
 *
 * The package envelope is a transport convenience — it does NOT change the
 * Core invariant that each issued grant is source-bounded.
 */
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
  storageBinding: StorageBinding;
  manifest: DbRow;
  resolvedStreams: StreamSelection[];
  traceContext: TraceContext;
}): Promise<{ grant: GrantEnvelope; token: string; expiresAt: string | null }> {
  const { client, selection } = request;

  // Hosted MCP packages never carry ai_training; reject if a client tries.
  if (selection.purpose_code === "https://pdpp.org/purpose/ai_training") {
    const err: AuthError = new Error("Hosted MCP package consent does not cover ai_training");
    err.code = "invalid_request";
    err.param = "purpose_code";
    throw err;
  }

  const grantId = generateId("grt");
  const issuedAt = nowIso();
  const expiresAt =
    selection.access_mode === "single_use" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;

  const persistedSource = describeSourceBinding(sourceBinding);
  const persistedStorageBinding = normalizeStorageBinding(storageBinding);

  const grant: GrantEnvelope = {
    access_mode: selection.access_mode,
    client: {
      client_id: registeredClient.client_id,
      registration_mode: registeredClient.registration_mode || "pre_registered_public",
      ...(client.client_display ? { client_display: client.client_display } : {}),
    },
    expires_at: expiresAt,
    grant_id: grantId,
    issued_at: issuedAt,
    manifest_version: requireManifestVersion(manifest),
    purpose_code: selection.purpose_code,
    purpose_description: selection.purpose_description,
    retention: selection.retention,
    source: persistedSource,
    streams: resolvedStreams,
    subject: { id: subjectId },
    version: "0.1.0",
  };

  await getGrantPackageStore().insertChildGrant({
    accessMode: selection.access_mode,
    clientId: registeredClient.client_id,
    expiresAt,
    grantId,
    grantJson: JSON.stringify(grant),
    issuedAt,
    scenarioId: isNonEmptyString(traceContext.scenario_id) ? traceContext.scenario_id : null,
    storageBindingJson: serializeStorageBinding(persistedStorageBinding),
    subjectId,
    traceId: traceContext.trace_id,
  });

  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: registeredClient.client_id,
    data: {
      access_mode: selection.access_mode,
      purpose_code: selection.purpose_code,
      retention: selection.retention ?? null,
      source: describeGrantSource(grant),
      stream_names: resolvedStreams.map((stream) => stream.name),
    },
    event_type: "grant.issued",
    grant_id: grantId,
    object_id: grantId,
    object_type: "grant",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    trace_id: traceContext.trace_id,
  });

  const token = await issueToken(grantId, subjectId, registeredClient.client_id, expiresAt, {
    source: "hosted_mcp_package_child",
    traceContext,
  });

  return { expiresAt, grant, token };
}

/**
 * Create one hosted MCP grant package: one independent source-bounded child
 * grant per `authorization_details[]` entry, plus a single package-bound
 * access token returned to the client. The package token never replaces or
 * weakens child-grant enforcement — the RS still authorizes every read
 * through the child grant whose source matches the request.
 *
 * @param {object} args
 * @param {string} args.clientId
 * @param {object[]} args.authorizationDetails — one entry per selected source.
 * @param {object[]} args.storageBindings — same-index `{connector_id}` per detail.
 * @param {string[]} args.connectionIds — same-index `connection_id` per detail
 *   (may be null for connectors without owner-configured connection rows).
 * @param {object[]} args.sourceMetadata — display hints per detail.
 * @param {string} [args.subjectId]
 * @param {object} [args.opts]
 */
export async function createHostedMcpGrantPackage({
  clientId,
  authorizationDetails,
  storageBindings = [],
  connectionIds = [],
  sourceMetadata = [],
  subjectId = "owner_local",
  opts = {},
}: {
  clientId: string;
  authorizationDetails: Record<string, unknown>[];
  storageBindings?: (StorageBinding | null | undefined)[];
  connectionIds?: (string | null)[];
  sourceMetadata?: Record<string, unknown>[];
  subjectId?: string;
  opts?: { scenarioId?: string; nativeManifest?: DbRow | null; issuerBase?: string };
}): Promise<Record<string, unknown>> {
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
  const traceContext = createTraceContext(opts.scenarioId ? { scenarioId: opts.scenarioId } : {});
  const createdAt = nowIso();
  const packageEnvelope = {
    approved_source_count: authorizationDetails.length,
    client: {
      client_display: buildClientDisplayFromRegistration(registeredClient.metadata),
      client_id: clientId,
      registration_mode: registeredClient.registration_mode || "pre_registered_public",
    },
    package_id: packageId,
    source_bounded_child_grants: true,
    subject: { id: subjectId },
    version: "reference.mcp_package.v1",
  };

  await getGrantPackageStore().insertPackage({
    approvedAt: createdAt,
    clientId,
    createdAt,
    packageId,
    packageJson: JSON.stringify(packageEnvelope),
    parentPackageId: null,
    scenarioId: traceContext.scenario_id,
    subjectId,
    traceId: traceContext.trace_id,
  });

  const childGrants: {
    connection_id: string | null;
    grant: GrantEnvelope;
    source: Record<string, unknown> | null;
    token: string;
  }[] = [];
  await forEachSequential(authorizationDetails, async (detail, index) => {
    const request = normalizePendingGrantRequest({ authorization_details: [detail], client_id: clientId }, opts);
    const selectedStorageBinding = normalizeStorageBinding(storageBindings[index]);
    if (selectedStorageBinding) {
      request.storage_binding = selectedStorageBinding;
    }
    requireStructuredPendingRequestShape(request);
    request.trace_context = traceContext;
    const childRegisteredClient = await requirePendingRequestClientRegistration(request, opts);
    const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request);
    request.source_binding = describeSourceBinding(sourceBinding);
    request.storage_binding = normalizeStorageBinding(storageBinding);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    request.manifest_version = requireManifestVersion(manifest);
    const resolvedStreams = resolveGrantSelection(request.selection, manifest);
    const { grant, token } = await persistChildGrantForPackage({
      manifest,
      registeredClient: childRegisteredClient,
      request,
      resolvedStreams,
      sourceBinding,
      storageBinding,
      subjectId,
      traceContext,
    });
    const connectionId = isNonEmptyString(connectionIds[index]) ? connectionIds[index] : null;
    const source = describePackageMemberSource(grant, connectionId, sourceMetadata[index]);
    const addedAt = nowIso();
    await getGrantPackageStore().insertPackageMember({
      addedAt,
      grantId: grant.grant_id,
      packageId,
      sourceJson: JSON.stringify(source),
      tokenId: token,
    });
    childGrants.push({ connection_id: connectionId, grant, source, token });
  });

  const packageToken = await issuePackageToken(packageId, subjectId, clientId, null, {
    source: "hosted_mcp_package",
    traceContext,
  });

  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: clientId,
    data: {
      child_grant_ids: childGrants.map((entry) => entry.grant.grant_id),
      sources: childGrants.map((entry) => entry.source),
    },
    event_type: "grant_package.issued",
    object_id: packageId,
    object_type: "grant_package",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    token_id: packageToken,
    trace_id: traceContext.trace_id,
  });

  return {
    child_grants: childGrants,
    package: {
      ...packageEnvelope,
      child_grants: childGrants.map((entry) => ({
        grant_id: entry.grant.grant_id,
        source: entry.source,
      })),
    },
    package_id: packageId,
    token: packageToken,
    trace_context: traceContext,
  };
}

/**
 * Resolve a hosted-MCP package id to its currently active members. Each
 * member entry exposes the child grant, its access token, its storage
 * binding, and an enriched `source` (with `connection_id` when known) that
 * the MCP fan-out can use to scope per-source reads.
 *
 * Returns `null` when the package itself is missing or revoked. An active
 * package with all members revoked returns `{ package, members: [] }`.
 */
export async function getGrantPackageAccess(packageId: unknown): Promise<Record<string, unknown> | null> {
  if (!isNonEmptyString(packageId)) {
    return null;
  }
  const store = getGrantPackageStore();
  const packageRow = await store.getPackageById(packageId);
  const grantPackage = normalizePackageRow(packageRow);
  if (grantPackage?.status !== "active") {
    return null;
  }

  const memberRows = await store.listActiveMembers(packageId);

  const activeMembers: Record<string, unknown>[] = [];
  await forEachSequential(memberRows, async (row) => {
    if (row.grant_status !== "active" || row.token_revoked) {
      return;
    }
    if (row.token_expires_at && new Date(row.token_expires_at).getTime() <= Date.now()) {
      return;
    }
    let grantState: ReturnType<typeof requirePersistedGrantState>;
    try {
      grantState = requirePersistedGrantState(row);
    } catch {
      return;
    }
    const persistedSource = await normalizePersistedPackageMemberSource(
      parsePackageJson(row.source_json) || describeGrantSource(grantState.grant),
      { ownerSubjectId: grantPackage.subject_id }
    );
    activeMembers.push({
      connection_id: persistedSource?.connection_id || null,
      grant: grantState.grant,
      grant_id: row.grant_id,
      grant_storage_binding: grantState.storageBinding,
      package_id: packageId,
      source: persistedSource,
      token: row.token_id,
    });
  });

  return {
    members: activeMembers,
    package: grantPackage,
  };
}

/**
 * Owner-facing list of every grant package the deployment has issued,
 * ordered by created_at DESC. Each row exposes the package metadata plus
 * the count of `grant_package_members` so the operator UI can render the
 * blast radius before the operator clicks into the detail page.
 *
 * Reference-only operator surface. Not part of the PDPP protocol; do
 * not expose to clients.
 */
function encodeGrantPackageCursor(row: GrantPackageCursor): string {
  return Buffer.from(
    JSON.stringify({
      created_at: row.created_at,
      package_id: row.package_id,
    }),
    "utf8"
  ).toString("base64url");
}

function decodeGrantPackageCursor(cursor: unknown): GrantPackageCursor | null {
  if (!isNonEmptyString(cursor)) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (isRecord(decoded) && isNonEmptyString(decoded.created_at) && isNonEmptyString(decoded.package_id)) {
      return {
        created_at: decoded.created_at,
        package_id: decoded.package_id,
      };
    }
  } catch {
    // handled below
  }
  const err: AuthError = new Error("Invalid grant package cursor");
  err.code = "invalid_cursor";
  throw err;
}

export async function listGrantPackagesForOwner(
  opts: { limit?: number; cursor?: string } = {}
): Promise<Record<string, unknown>> {
  const requestedLimit = opts.limit;
  const limit =
    typeof requestedLimit === "number" && Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 50;
  const cursor = decodeGrantPackageCursor(opts.cursor);
  let rows: GrantPackageListRow[];
  if (isPostgresStorageBackend()) {
    const params: unknown[] = [];
    let where = "";
    if (cursor) {
      params.push(cursor.created_at, cursor.package_id);
      where = "WHERE (gp.created_at < $1 OR (gp.created_at = $1 AND gp.package_id < $2))";
    }
    params.push(limit + 1);
    const limitPlaceholder = `$${params.length}`;
    ({ rows } = await postgresQuery<GrantPackageListRow>(
      `SELECT gp.package_id, gp.subject_id, gp.client_id, gp.status,
              gp.parent_package_id, gp.trace_id, gp.scenario_id, gp.created_at, gp.approved_at, gp.revoked_at,
              (SELECT COUNT(*) FROM grant_package_members gpm
                 WHERE gpm.package_id = gp.package_id) AS member_count
         FROM grant_packages gp
         ${where}
         ORDER BY gp.created_at DESC, gp.package_id DESC
         LIMIT ${limitPlaceholder}`,
      params
    ));
  } else {
    rows = [...allowUnboundedReadAcknowledged<GrantPackageListRow>(referenceQueries.authGrantPackagesListAll, [])];
    if (cursor) {
      rows = rows.filter(
        (row) =>
          row.created_at < cursor.created_at ||
          (row.created_at === cursor.created_at && row.package_id < cursor.package_id)
      );
    }
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
    .filter((row) => row !== null);
  const data = normalized.slice(0, limit);
  const hasMore = normalized.length > limit;
  const tail = hasMore ? data.at(-1) : null;
  return {
    data,
    has_more: hasMore,
    limit,
    next_cursor: tail ? encodeGrantPackageCursor(tail) : null,
  };
}

/**
 * Cheap total grant-package count for the owner-console overview badge. Lets
 * the overview surface package presence/count without paging the full
 * `/_ref/grant-packages` list. Owner-session-gated by the route. Returns a
 * non-negative integer.
 */
export async function countGrantPackagesForOwner(): Promise<number> {
  if (isPostgresStorageBackend()) {
    const row = await pgOne<{ package_count: number } & DbRow>(
      "SELECT COUNT(*)::int AS package_count FROM grant_packages"
    );
    const count = row ? Number(row.package_count) : 0;
    return Number.isFinite(count) ? count : 0;
  }
  const row = getOne<{ package_count: number | string }>(referenceQueries.authGrantPackagesCount, []);
  const count = row ? Number(row.package_count) : 0;
  return Number.isFinite(count) ? count : 0;
}

/**
 * Owner-facing detail view of a grant package, regardless of status.
 * Returns the package row + every member row (active and revoked) so
 * the operator can see the full child-grant cascade after revocation.
 * Unlike `getGrantPackageAccess` (consumed by the MCP fan-out, which
 * needs only active members of an active package), this helper is
 * non-discriminatory.
 *
 * Returns `null` when the package id does not exist.
 */
export async function getGrantPackageForOwner(packageId: unknown): Promise<Record<string, unknown> | null> {
  if (!isNonEmptyString(packageId)) {
    return null;
  }
  const store = getGrantPackageStore();
  const packageRow = await store.getPackageById(packageId);
  const grantPackage = normalizePackageRow(packageRow);
  if (!grantPackage) {
    return null;
  }

  // For operator visibility we ALWAYS return every member row, even ones
  // marked revoked, so the operator can see the cascade history on a
  // revoked package detail page. The MCP fan-out path uses
  // `getGrantPackageAccess`, which intentionally hides revoked rows.
  const memberRows = await store.listAllMembers(packageId);

  const children = await Promise.all(
    memberRows.map(async (row) => ({
      added_at: row.added_at,
      grant_id: row.grant_id,
      grant_status: row.grant_status,
      member_status: row.member_status,
      revoked_at: row.member_revoked_at || null,
      source: await normalizePersistedPackageMemberSource(parsePackageJson(row.source_json) || null, {
        ownerSubjectId: grantPackage.subject_id,
      }),
    }))
  );

  return {
    ...grantPackage,
    children,
    member_count: children.length,
  };
}

/**
 * Direct children of a package in the add-source lineage: every package
 * whose `parent_package_id` equals `packageId`. Used to walk the lineage
 * tree downward when assembling the cumulative per-client view. Returns
 * normalized package rows (no members).
 */
async function listGrantPackagesByParent(packageId: string): Promise<GrantPackageNormalized[]> {
  if (!isNonEmptyString(packageId)) {
    return [];
  }
  if (isPostgresStorageBackend()) {
    const { rows } = await postgresQuery<GrantPackageListRow>(
      `SELECT package_id, subject_id, client_id, status, package_json::text AS package_json,
              parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
         FROM grant_packages
         WHERE parent_package_id = $1
         ORDER BY created_at, package_id`,
      [packageId]
    );
    return rows.map(normalizePackageRow).filter((row): row is GrantPackageNormalized => row !== null);
  }
  // SQLite: the package count per deployment is bounded (small enumeration
  // table); filter the all-packages listing by parent in JS rather than add
  // another registered query.
  const rows = allowUnboundedReadAcknowledged<GrantPackageListRow>(referenceQueries.authGrantPackagesListAll, []);
  return rows
    .map(normalizePackageRow)
    .filter((pkg): pkg is GrantPackageNormalized => pkg?.parent_package_id === packageId);
}

async function findGrantPackageLineageRoot(
  start: GrantPackageNormalized,
  current: GrantPackageNormalized = start,
  visited = new Set<string>()
): Promise<GrantPackageNormalized> {
  if (!current.parent_package_id || visited.has(current.package_id)) {
    return current;
  }
  visited.add(current.package_id);
  const parent = await getGrantPackageRow(current.parent_package_id);
  if (!parent || parent.client_id !== start.client_id || parent.subject_id !== start.subject_id) {
    return current;
  }
  return findGrantPackageLineageRoot(start, parent, visited);
}

async function collectGrantPackageLineageIds(
  queue: string[],
  clientId: string,
  subjectId: string,
  seen = new Set<string>(),
  lineageIds: string[] = []
): Promise<string[]> {
  const current = queue.shift();
  if (!current) {
    return lineageIds;
  }
  if (seen.has(current)) {
    return collectGrantPackageLineageIds(queue, clientId, subjectId, seen, lineageIds);
  }
  seen.add(current);
  lineageIds.push(current);
  const childPackages = await listGrantPackagesByParent(current);
  for (const child of childPackages) {
    if (child.client_id === clientId && child.subject_id === subjectId && !seen.has(child.package_id)) {
      queue.push(child.package_id);
    }
  }
  return collectGrantPackageLineageIds(queue, clientId, subjectId, seen, lineageIds);
}

/**
 * Cumulative per-client view across one client's linked add-source packages.
 *
 * Given any package in a lineage, resolves the lineage ROOT by following
 * `parent_package_id` to the top, then walks the tree downward to gather every
 * linked package for the SAME client and owner. Returns the root, the ordered
 * lineage, and the union of child grants across the lineage so the dashboard
 * can render the cumulative picture a client currently holds.
 *
 * Lineage is grouping/audit metadata only: each child grant in the returned
 * `children` array remains independently revocable, and `package_id` /
 * `parent_package_id` carry no source or stream authority. Cross-client and
 * cross-owner packages are never mixed into the cumulative view — the walk is
 * scoped to the root package's client_id and subject_id and skips any linked
 * row that does not match (a fail-closed guard against a tampered link).
 *
 * Returns `null` when the starting package id does not exist.
 */
export async function getCumulativeClientAccessForPackage(packageId: unknown): Promise<Record<string, unknown> | null> {
  if (!isNonEmptyString(packageId)) {
    return null;
  }
  const start = await getGrantPackageRow(packageId);
  if (!start) {
    return null;
  }

  // Walk up to the lineage root. Bound the walk by a visited set so a
  // corrupt cycle cannot loop forever.
  const root = await findGrantPackageLineageRoot(start);

  const clientId = root.client_id;
  const subjectId = root.subject_id;

  // Walk the tree downward from the root, gathering same-client/owner packages.
  const lineageIds = await collectGrantPackageLineageIds([root.package_id], clientId, subjectId);

  // Assemble per-package detail (with members) in lineage order.
  const packages: Record<string, unknown>[] = [];
  const cumulativeChildren: Record<string, unknown>[] = [];
  await forEachSequential(lineageIds, async (id) => {
    const detail = await getGrantPackageForOwner(id);
    if (!detail) {
      return;
    }
    packages.push({
      approved_at: detail.approved_at,
      created_at: detail.created_at,
      member_count: detail.member_count,
      package_id: detail.package_id,
      parent_package_id: detail.parent_package_id,
      revoked_at: detail.revoked_at,
      status: detail.status,
    });
    const children = Array.isArray(detail.children) ? detail.children.filter(isRecord) : [];
    for (const child of children) {
      cumulativeChildren.push({ ...child, package_id: detail.package_id });
    }
  });

  const activeChildren = cumulativeChildren.filter(
    (child) => child.grant_status === "active" && child.member_status === "active"
  );

  return {
    active_child_count: activeChildren.length,
    children: cumulativeChildren,
    client_id: clientId,
    package_count: packages.length,
    packages,
    root_package_id: root.package_id,
    subject_id: subjectId,
  };
}

/**
 * Resolve a child grant to its parent package id, if any. The binding
 * fact lives on `grant_package_members`, the table that joins child
 * grants to the package they were approved under. The MCP refresh token
 * issued alongside the package carries `tokens.package_id` but has a
 * NULL `grant_id`, so it does not participate in this lookup; only the
 * per-source child grants appear in `grant_package_members`.
 *
 * Returns `null` for grants that are not bound to a package.
 */
export async function getGrantPackageIdForGrant(grantId: unknown): Promise<string | null> {
  if (!isNonEmptyString(grantId)) {
    return null;
  }
  const row = await getGrantPackageStore().getPackageIdForGrant(grantId);
  return isNonEmptyString(row?.package_id) ? row.package_id : null;
}

async function listActiveGrantPackageMembersForRevocation(
  packageId: string
): Promise<readonly GrantPackageMemberRow[]> {
  if (!isNonEmptyString(packageId)) {
    return [];
  }
  return await getGrantPackageStore().listActiveMembers(packageId);
}

async function markGrantPackageMemberRevoked(packageId: string, grantId: string, revokedAt: string): Promise<void> {
  await getGrantPackageStore().markMemberRevoked({ grantId, packageId, revokedAt });
}

async function markGrantPackageRevoked(packageId: string, revokedAt: string): Promise<void> {
  await getGrantPackageStore().markPackageRevokedCascade({ packageId, revokedAt });
}

function normalizePackageRevokeError(
  grantId: string,
  err: AuthError
): { grant_id: string; error: { code: string; message: string } } {
  const code = isNonEmptyString(err.code) ? err.code : "revoke_failed";
  const message = isNonEmptyString(err.message) ? err.message : "Child grant revoke failed";
  return {
    error: { code, message },
    grant_id: grantId,
  };
}

export async function revokeGrantPackage(
  packageId: string,
  context: { trace_id?: string | null; scenario_id?: string | null; request_id?: string | null } = {}
): Promise<Record<string, unknown>> {
  const activeMembers = await listActiveGrantPackageMembersForRevocation(packageId);
  const revokedChildGrants: string[] = [];
  const notRevokedChildGrants: { grant_id: string; error: { code: string; message: string } }[] = [];

  await forEachSequential(activeMembers, async (member) => {
    if (member.grant_status !== "active" || !isNonEmptyString(member.grant_id)) {
      return;
    }
    try {
      await revokeGrant(member.grant_id, context);
      const childRevokedAt = nowIso();
      await markGrantPackageMemberRevoked(packageId, member.grant_id, childRevokedAt);
      revokedChildGrants.push(member.grant_id);
    } catch (err: unknown) {
      if (!isAuthError(err)) {
        throw err;
      }
      notRevokedChildGrants.push(normalizePackageRevokeError(member.grant_id, err));
    }
  });

  if (notRevokedChildGrants.length) {
    await emitSpineEvent({
      actor_id: "pdpp_as",
      actor_type: "authorization_server",
      data: {
        not_revoked_child_grants: notRevokedChildGrants,
        revoked_child_grants: revokedChildGrants,
      },
      event_type: "grant_package.revoke_partial",
      object_id: packageId,
      object_type: "grant_package",
      request_id: context.request_id || undefined,
      scenario_id: context.scenario_id || undefined,
      status: "failed",
      trace_id: context.trace_id || undefined,
    });
    return {
      not_revoked_child_grants: notRevokedChildGrants,
      package_id: packageId,
      revoked_at: null,
      revoked_child_grants: revokedChildGrants,
      status: "partial_failure",
    };
  }

  const now = nowIso();
  await markGrantPackageRevoked(packageId, now);

  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    data: {
      revoked_child_grants: revokedChildGrants,
    },
    event_type: "grant_package.revoked",
    object_id: packageId,
    object_type: "grant_package",
    request_id: context.request_id || undefined,
    scenario_id: context.scenario_id || undefined,
    status: "succeeded",
    trace_id: context.trace_id || undefined,
  });
  return {
    not_revoked_child_grants: [],
    package_id: packageId,
    revoked_at: now,
    revoked_child_grants: revokedChildGrants,
    status: "revoked",
  };
}

export async function issueOAuthAuthorizationCodeForPackageDeviceCode(
  deviceCode: unknown,
  { packageId, token }: { packageId: string; token: string }
): Promise<Record<string, unknown> | null> {
  if (!isNonEmptyString(deviceCode)) {
    return null;
  }
  const oauthCodeStore = getOAuthCodeStore();
  const row = await oauthCodeStore.getByDeviceCode(deviceCode);

  if (row?.status !== "pending") {
    return null;
  }
  if (isExpired(row)) {
    await oauthCodeStore.markExpiredByDeviceCode(deviceCode);
    throw buildOAuthAuthorizationCodeError("invalid_request", "OAuth authorization request has expired");
  }

  const code = generateId("oacode");
  const issuedAt = nowIso();
  const expiresAt = expiresInIso(300);
  await oauthCodeStore.issueForPackageDeviceCode({ code, deviceCode, expiresAt, issuedAt, packageId, token });

  return {
    client_id: row.client_id,
    code,
    expires_at: expiresAt,
    redirect_uri: row.redirect_uri,
    state: row.state || null,
  };
}

export async function stageOAuthAuthorizationCodeRequest({
  deviceCode,
  clientId,
  redirectUri,
  state = null,
  codeChallenge,
  codeChallengeMethod,
  expiresInSeconds = 300,
}: {
  deviceCode: unknown;
  clientId: unknown;
  redirectUri: unknown;
  state?: string | null;
  codeChallenge: unknown;
  codeChallengeMethod: unknown;
  expiresInSeconds?: number;
}): Promise<Record<string, unknown>> {
  if (!isNonEmptyString(deviceCode)) {
    throw buildOAuthAuthorizationCodeError("invalid_request", "device_code is required");
  }
  if (!isNonEmptyString(clientId)) {
    throw buildOAuthAuthorizationCodeError("invalid_request", "client_id is required");
  }
  if (!isNonEmptyString(redirectUri)) {
    throw buildOAuthAuthorizationCodeError("invalid_request", "redirect_uri is required");
  }
  if (!isUsableAuthorizationCodePkceChallenge(codeChallenge, codeChallengeMethod)) {
    throw buildOAuthAuthorizationCodeError(
      "invalid_request",
      "code_challenge_method must be S256 and code_challenge must be 43-128 characters"
    );
  }
  if (!(isNonEmptyString(codeChallenge) && isNonEmptyString(codeChallengeMethod))) {
    throw buildOAuthAuthorizationCodeError("invalid_request", "PKCE challenge values are required");
  }

  const row = {
    clientId,
    codeChallenge,
    codeChallengeMethod,
    createdAt: nowIso(),
    deviceCode,
    expiresAt: expiresInIso(expiresInSeconds),
    id: generateId("oac"),
    redirectUri,
    state: state || null,
  };

  await getOAuthCodeStore().upsertPending({
    clientId: row.clientId,
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
    createdAt: row.createdAt,
    deviceCode: row.deviceCode,
    expiresAt: row.expiresAt,
    id: row.id,
    redirectUri: row.redirectUri,
    state: row.state,
  });

  return { ...row, status: "pending" };
}

export async function issueOAuthAuthorizationCodeForDeviceCode(
  deviceCode: unknown,
  { grantId, token }: { grantId: string; token: string }
): Promise<Record<string, unknown> | null> {
  if (!isNonEmptyString(deviceCode)) {
    return null;
  }
  const oauthCodeStore = getOAuthCodeStore();
  const row = await oauthCodeStore.getByDeviceCode(deviceCode);

  if (row?.status !== "pending") {
    return null;
  }
  if (isExpired(row)) {
    await oauthCodeStore.markExpiredByDeviceCode(deviceCode);
    throw buildOAuthAuthorizationCodeError("invalid_request", "OAuth authorization request has expired");
  }

  const code = generateId("oacode");
  const issuedAt = nowIso();
  const expiresAt = expiresInIso(300);
  await oauthCodeStore.issueForDeviceCode({ code, deviceCode, expiresAt, grantId, issuedAt, token });

  return {
    client_id: row.client_id,
    code,
    expires_at: expiresAt,
    redirect_uri: row.redirect_uri,
    state: row.state || null,
  };
}

function requireOAuthAuthorizationCodeExchangeInput(input: {
  code: unknown;
  clientId: unknown;
  redirectUri: unknown;
  codeVerifier: unknown;
}): { clientId: string; code: string; codeVerifier: string; redirectUri: string } {
  if (!isNonEmptyString(input.code)) {
    throw buildOAuthAuthorizationCodeError("invalid_request", "code is required");
  }
  if (!isNonEmptyString(input.clientId)) {
    throw buildOAuthAuthorizationCodeError("invalid_request", "client_id is required");
  }
  if (!isNonEmptyString(input.redirectUri)) {
    throw buildOAuthAuthorizationCodeError("invalid_request", "redirect_uri is required");
  }
  if (!isNonEmptyString(input.codeVerifier)) {
    throw buildOAuthAuthorizationCodeError("invalid_request", "code_verifier is required");
  }
  if (!PKCE_CODE_VERIFIER_RE.test(input.codeVerifier)) {
    throw buildOAuthAuthorizationCodeError("invalid_request", "code_verifier must be 43-128 unreserved URI characters");
  }
  return {
    clientId: input.clientId,
    code: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
  };
}

function requireRedeemableOAuthAuthorizationCode(
  row: OAuthIssuedCodeRow | null,
  clientId: string,
  redirectUri: string,
  codeVerifier: string
): OAuthIssuedCodeRow {
  if (row?.status !== "issued" || row.consumed_at) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code is invalid or already used");
  }
  if (isExpired(row)) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code has expired");
  }
  if (row.client_id !== clientId) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code client_id mismatch");
  }
  if (row.redirect_uri !== redirectUri) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code redirect_uri mismatch");
  }
  if (row.code_challenge_method !== "S256" || base64UrlSha256(codeVerifier) !== row.code_challenge) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code PKCE verification failed");
  }
  return row;
}

async function addOAuthRefreshTokenToAuthorizationResponse(
  response: Record<string, unknown>,
  row: OAuthIssuedCodeRow,
  clientId: string
): Promise<void> {
  const tokenInfo = await introspect(row.token_id);
  const tokenMatches = row.package_id
    ? tokenInfo.grant_package_id === row.package_id && tokenInfo.pdpp_token_kind === "mcp_package"
    : tokenInfo.grant_id === row.grant_id && tokenInfo.pdpp_token_kind === "client";
  if (!tokenInfo.active || tokenInfo.client_id !== clientId || !tokenMatches) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Issued grant token is no longer active");
  }
  if (!isNonEmptyString(tokenInfo.subject_id)) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Issued grant token is missing its subject binding");
  }
  const expiresAt = typeof tokenInfo.exp === "number" ? new Date(tokenInfo.exp * 1000).toISOString() : null;
  if (isNonEmptyString(row.package_id)) {
    response.refresh_token = await issueOAuthRefreshTokenForPackage({
      clientId,
      expiresAt,
      packageId: row.package_id,
      subjectId: tokenInfo.subject_id,
    });
    return;
  }
  if (!isNonEmptyString(row.grant_id)) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code is missing its grant binding");
  }
  response.refresh_token = await issueOAuthRefreshToken({
    clientId,
    expiresAt,
    grantId: row.grant_id,
    subjectId: tokenInfo.subject_id,
  });
}

export async function exchangeOAuthAuthorizationCode({
  code,
  clientId,
  redirectUri,
  codeVerifier,
  baseUrl = null,
  issuerBase = null,
}: {
  code: unknown;
  clientId: unknown;
  redirectUri: unknown;
  codeVerifier: unknown;
  baseUrl?: string | null;
  issuerBase?: string | null;
}): Promise<Record<string, unknown>> {
  const normalized = requireOAuthAuthorizationCodeExchangeInput({ clientId, code, codeVerifier, redirectUri });
  const oauthCodeStore = getOAuthCodeStore();
  const row = requireRedeemableOAuthAuthorizationCode(
    await oauthCodeStore.getByCode(normalized.code),
    normalized.clientId,
    normalized.redirectUri,
    normalized.codeVerifier
  );
  const registeredClient = await resolveOAuthClient(normalized.clientId, {
    ...(baseUrl ? { baseUrl } : {}),
    ...(issuerBase ? { issuerBase } : {}),
  });
  if (!registeredClient) {
    throw buildOAuthAuthorizationCodeError("invalid_client", "Unknown client_id");
  }

  const consumedAt = nowIso();
  const updated = await oauthCodeStore.consumeCode({ code: normalized.code, consumedAt });

  if (!updated.changes) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code is invalid or already used");
  }

  const response: Record<string, unknown> = {
    access_token: row.token_id,
    token_type: "Bearer",
    ...(row.package_id ? { grant_package_id: row.package_id } : { grant_id: row.grant_id }),
  };

  if (clientSupportsOAuthRefreshToken(registeredClient)) {
    await addOAuthRefreshTokenToAuthorizationResponse(response, row, normalized.clientId);
  }

  return response;
}

function requireActiveOAuthRefreshToken(row: RefreshTokenRow | null, clientId: string): RefreshTokenRow {
  if (row?.status !== "active" || row.revoked_at) {
    throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token is invalid");
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token has expired");
  }
  if (row.client_id !== clientId) {
    throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token client_id mismatch");
  }
  return row;
}

async function issueAccessTokenForOAuthRefresh(row: RefreshTokenRow): Promise<string> {
  try {
    if (isNonEmptyString(row.package_id)) {
      const grantPackage = await getGrantPackageAccess(row.package_id);
      if (!grantPackage) {
        const err: AuthError = new Error("Grant package is no longer active");
        err.code = "package_revoked";
        throw err;
      }
      return issuePackageToken(row.package_id, row.subject_id, row.client_id, row.expires_at || null, {
        source: "oauth_refresh_token",
      });
    }
    if (isNonEmptyString(row.grant_id)) {
      return issueToken(row.grant_id, row.subject_id, row.client_id, row.expires_at || null, {
        source: "oauth_refresh_token",
      });
    }
    throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token has no grant binding");
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    const code =
      isNonEmptyString(err.code) &&
      ["grant_revoked", "grant_invalid", "grant_consumed", "package_revoked", "not_found"].includes(err.code)
        ? "invalid_grant"
        : err.code || "invalid_grant";
    throw buildOAuthRefreshTokenError(code, err.message || "Refresh token grant is no longer valid");
  }
}

export async function exchangeOAuthRefreshToken({
  refreshToken,
  clientId,
}: {
  refreshToken: unknown;
  clientId: unknown;
}): Promise<Record<string, unknown>> {
  if (!isNonEmptyString(refreshToken)) {
    throw buildOAuthRefreshTokenError("invalid_request", "refresh_token is required");
  }
  if (!isNonEmptyString(clientId)) {
    throw buildOAuthRefreshTokenError("invalid_request", "client_id is required");
  }

  const refreshTokenHash = hashOAuthRefreshToken(refreshToken);
  const refreshTokenStore = getRefreshTokenStore();
  const row = requireActiveOAuthRefreshToken(await refreshTokenStore.getByTokenHash(refreshTokenHash), clientId);

  const registeredClient = await getRegisteredClient(clientId);
  if (!(registeredClient && clientSupportsOAuthRefreshToken(registeredClient))) {
    throw buildOAuthRefreshTokenError("invalid_grant", "Client is not registered for refresh_token");
  }

  const accessToken = await issueAccessTokenForOAuthRefresh(row);

  const usedAt = nowIso();
  await refreshTokenStore.markUsed({ refreshTokenHash, usedAt });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    ...(row.package_id ? { grant_package_id: row.package_id } : { grant_id: row.grant_id }),
  };
}

/**
 * Consent exchange-code store.
 *
 * The HTML branch of `POST /consent/approve` SHALL NOT render the live client
 * bearer to the browser; instead it mints a single-use opaque exchange code,
 * stores `{ code -> { grantId, token, grant, expiresAt, consumed } }` here,
 * and tells the caller to redeem the code at `POST /consent/exchange`.
 *
 * In-memory by design: the reference is single-process, the codes are
 * short-lived, and a code that survives a process restart would weaken the
 * "short-lived single-use ticket" property. See
 * openspec/changes/harden-consent-token-handoff/design.md.
 */
const consentExchangeCodes = new Map<string, ConsentExchangeEntry>();
const CONSENT_EXCHANGE_CODE_TTL_MS = 5 * 60 * 1000;

function pruneExpiredConsentExchangeCodes(now = Date.now()): void {
  for (const [code, entry] of consentExchangeCodes) {
    if (entry.consumed || entry.expiresAt <= now) {
      consentExchangeCodes.delete(code);
    }
  }
}

export function createConsentExchangeCode({
  grantId,
  token,
  grant,
  ttlMs = CONSENT_EXCHANGE_CODE_TTL_MS,
}: {
  grantId: string;
  token: string;
  grant: Record<string, unknown>;
  ttlMs?: number;
}): string {
  if (!(grantId && token && grant)) {
    throw new Error("createConsentExchangeCode requires grantId, token, and grant");
  }
  pruneExpiredConsentExchangeCodes();
  const code = `cex_${randomBytes(32).toString("hex")}`;
  consentExchangeCodes.set(code, {
    consumed: false,
    expiresAt: Date.now() + ttlMs,
    grant,
    grantId,
    token,
  });
  return code;
}

export function consumeConsentExchangeCode(code: unknown): {
  ok: boolean;
  reason?: string;
  grantId?: string;
  token?: string;
  grant?: Record<string, unknown>;
} {
  if (typeof code !== "string" || code.length === 0) {
    return { ok: false, reason: "unknown" };
  }
  const entry = consentExchangeCodes.get(code);
  if (!entry) {
    return { ok: false, reason: "unknown" };
  }
  if (entry.consumed) {
    return { ok: false, reason: "consumed" };
  }
  if (entry.expiresAt <= Date.now()) {
    consentExchangeCodes.delete(code);
    return { ok: false, reason: "expired" };
  }
  entry.consumed = true;
  consentExchangeCodes.delete(code);
  return {
    grant: entry.grant,
    grantId: entry.grantId,
    ok: true,
    token: entry.token,
  };
}

/** Test-only escape hatch: clear the in-memory exchange-code store. */
export function _resetConsentExchangeCodes(): void {
  consentExchangeCodes.clear();
}

/**
 * Deny and clear a pending grant request
 */
export async function denyGrant(deviceCode: string): Promise<boolean> {
  const pending = await getPendingConsentRow(deviceCode);
  if (pending?.status !== "pending") {
    return false;
  }
  if (isExpired(pending)) {
    await markPendingConsentExpired(deviceCode);
    return false;
  }
  await markPendingConsentDenied(deviceCode);

  const request: unknown = JSON.parse(pending.params_json);
  requireStructuredPendingRequestShape(request);
  const traceContext = requirePersistedPendingTraceContext(pending);
  request.trace_context = traceContext;
  const { sourceBinding } = requireStructuredPendingRequestBindings(request);
  await emitSpineEvent({
    actor_id: pending.subject_id || "owner_local",
    actor_type: "subject",
    client_id: request.client?.client_id || null,
    data: {
      source: describeSourceBinding(sourceBinding),
      user_code: pending.user_code,
    },
    event_type: "consent.denied",
    object_id: deviceCode,
    object_type: "pending_consent",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    status: "denied",
    trace_id: traceContext.trace_id,
  });

  return true;
}

/**
 * Start an owner device authorization flow (RFC 8628-shaped).
 * Returns { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }.
 */
export async function initiateOwnerDeviceAuthorization(
  clientId: unknown,
  opts: { scenarioId?: string; baseUrl?: string; expiresIn?: number; interval?: number } = {}
): Promise<Record<string, unknown>> {
  const traceContext = createTraceContext(opts.scenarioId ? { scenarioId: opts.scenarioId } : {});
  try {
    if (!isNonEmptyString(clientId)) {
      const err: AuthError = new Error("client_id is required");
      err.code = "invalid_request";
      throw err;
    }
    const registeredClient = await getRegisteredClient(clientId);
    if (!registeredClient) {
      const err: AuthError = new Error(`Unknown client_id: ${clientId}`);
      err.code = "invalid_client";
      throw err;
    }

    const deviceCode = generateId("dc_owner");
    const userCode = randomBytes(3).toString("hex").toUpperCase();
    const verificationBaseUrl =
      opts.baseUrl || process.env.AS_PUBLIC_URL || `http://localhost:${process.env.AS_PORT || "7662"}`;
    const expiresIn = opts.expiresIn || 300;
    const interval = opts.interval || 1;
    const expiresAt = expiresInIso(expiresIn);

    await createOwnerDeviceAuth({
      clientId,
      deviceCode,
      expiresAt,
      intervalSeconds: interval,
      requestId: traceContext.request_id,
      scenarioId: traceContext.scenario_id,
      traceId: traceContext.trace_id,
      userCode,
    });

    await emitSpineEvent({
      actor_id: registeredClient.client_id,
      actor_type: "client",
      client_id: registeredClient.client_id,
      data: {
        issuance_path: "owner_device_flow",
        user_code: userCode,
      },
      event_type: "request.submitted",
      object_id: deviceCode,
      object_type: "owner_device_auth",
      request_id: traceContext.request_id,
      scenario_id: traceContext.scenario_id,
      status: "succeeded",
      trace_id: traceContext.trace_id,
    });

    return {
      device_code: deviceCode,
      expires_in: expiresIn,
      interval,
      trace_context: traceContext,
      user_code: userCode,
      verification_uri: `${verificationBaseUrl}/device`,
      verification_uri_complete: `${verificationBaseUrl}/device?user_code=${encodeURIComponent(userCode)}`,
    };
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    err.trace_id = traceContext.trace_id;
    err.request_id = traceContext.request_id;
    if (traceContext.scenario_id) {
      err.scenario_id = traceContext.scenario_id;
    }
    await emitSpineEvent({
      actor_id: isNonEmptyString(clientId) ? clientId : "unknown",
      actor_type: "client",
      client_id: isNonEmptyString(clientId) ? clientId : null,
      data: {
        error: {
          code: err.code || "invalid_request",
          message: err.message,
        },
        issuance_path: "owner_device_flow",
      },
      event_type: "request.rejected",
      object_id: traceContext.request_id,
      object_type: "request",
      request_id: traceContext.request_id,
      scenario_id: traceContext.scenario_id,
      status: "rejected",
      trace_id: traceContext.trace_id,
    });
    throw err;
  }
}

/**
 * Look up an owner-device authorization request by user code for verification UI.
 */
export async function getOwnerDeviceAuthorizationByUserCode(
  userCode: unknown
): Promise<Record<string, unknown> | null> {
  if (!userCode) {
    return null;
  }
  const row = await getOwnerDeviceAuthRowByUserCode(userCode);
  if (!row) {
    return null;
  }
  if (row.status !== "pending") {
    return null;
  }
  if (isExpired(row)) {
    await markOwnerDeviceAuthExpired(row.device_code);
    return null;
  }
  let registeredClient: RegisteredClient | null;
  try {
    registeredClient = await getRegisteredClient(row.client_id);
  } catch (err: unknown) {
    if (isAuthError(err) && err.code === "invalid_client") {
      return null;
    }
    throw err;
  }
  if (!registeredClient) {
    return null;
  }
  return {
    client_id: registeredClient.client_id,
    created_at: row.created_at,
    device_code: row.device_code,
    expires_at: row.expires_at,
    interval: row.interval_seconds,
    user_code: row.user_code,
  };
}

/**
 * Approve an owner-device authorization and mint an owner token.
 */
export async function approveOwnerDeviceAuthorization(
  userCode: unknown,
  subjectId = "owner_local"
): Promise<Record<string, unknown>> {
  const pending = await getOwnerDeviceAuthRowByUserCode(userCode);
  if (!pending) {
    const err: AuthError = new Error("Unknown user code");
    err.code = "not_found";
    throw err;
  }
  if (pending.status !== "pending") {
    throw attachOwnerDeviceTraceContext(
      Object.assign(new Error("Owner device authorization is not available"), {
        code: "not_found",
      }),
      pending
    );
  }
  if (isExpired(pending)) {
    await markOwnerDeviceAuthExpired(pending.device_code);
    throw attachOwnerDeviceTraceContext(
      Object.assign(new Error("Owner device authorization has expired"), {
        code: "not_found",
      }),
      pending
    );
  }
  let registeredClient: RegisteredClient | null;
  try {
    registeredClient = await getRegisteredClient(pending.client_id);
  } catch (err: unknown) {
    if (isAuthError(err) && err.code === "invalid_client") {
      throw attachOwnerDeviceTraceContext(err, pending);
    }
    throw err;
  }
  if (!registeredClient) {
    const err: AuthError = new Error(`Unknown client_id: ${pending.client_id}`);
    err.code = "invalid_client";
    throw attachOwnerDeviceTraceContext(err, pending);
  }
  try {
    registeredClient = await bindDynamicClientToApprovingOwner(registeredClient, subjectId);
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    throw attachOwnerDeviceTraceContext(err, pending);
  }

  const traceContext =
    isNonEmptyString(pending.trace_id) && isNonEmptyString(pending.request_id)
      ? {
          request_id: pending.request_id,
          ...(isNonEmptyString(pending.scenario_id) ? { scenario_id: pending.scenario_id } : {}),
          trace_id: pending.trace_id,
        }
      : null;

  await emitSpineEvent({
    actor_id: subjectId,
    actor_type: "subject",
    client_id: registeredClient.client_id,
    data: {
      issuance_path: "owner_device_flow",
      user_code: pending.user_code,
    },
    event_type: "consent.approved",
    object_id: pending.device_code,
    object_type: "owner_device_auth",
    request_id: traceContext?.request_id || undefined,
    scenario_id: traceContext?.scenario_id || undefined,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    trace_id: traceContext?.trace_id || undefined,
  });

  const token = await issueOwnerToken(subjectId, {
    clientId: registeredClient.client_id,
    traceContext,
    userCode: pending.user_code,
  });
  await markOwnerDeviceAuthApproved(pending.device_code, { subjectId, tokenId: token });

  return {
    access_token: token,
    expires_in: 365 * 24 * 60 * 60,
    subject_id: subjectId,
    token_type: "Bearer",
  };
}

export async function denyOwnerDeviceAuthorization(userCode: unknown, subjectId = "owner_local"): Promise<void> {
  const pending = await getOwnerDeviceAuthRowByUserCode(userCode);
  if (!pending) {
    const err: AuthError = new Error("Unknown user code");
    err.code = "not_found";
    throw err;
  }
  if (pending.status !== "pending") {
    throw attachOwnerDeviceTraceContext(
      Object.assign(new Error("Owner device authorization is not available"), {
        code: "not_found",
      }),
      pending
    );
  }
  if (isExpired(pending)) {
    await markOwnerDeviceAuthExpired(pending.device_code);
    throw attachOwnerDeviceTraceContext(
      Object.assign(new Error("Owner device authorization has expired"), {
        code: "not_found",
      }),
      pending
    );
  }

  const traceContext =
    isNonEmptyString(pending.trace_id) && isNonEmptyString(pending.request_id)
      ? {
          request_id: pending.request_id,
          ...(isNonEmptyString(pending.scenario_id) ? { scenario_id: pending.scenario_id } : {}),
          trace_id: pending.trace_id,
        }
      : null;

  await markOwnerDeviceAuthDenied(pending.device_code);
  await emitSpineEvent({
    actor_id: subjectId,
    actor_type: "subject",
    client_id: pending.client_id,
    data: {
      error: {
        code: "access_denied",
        message: "The resource owner denied the request",
      },
      issuance_path: "owner_device_flow",
      user_code: pending.user_code,
    },
    event_type: "request.rejected",
    object_id: pending.device_code,
    object_type: "owner_device_auth",
    request_id: traceContext?.request_id || undefined,
    scenario_id: traceContext?.scenario_id || undefined,
    status: "rejected",
    subject_id: subjectId,
    subject_type: "subject",
    trace_id: traceContext?.trace_id || undefined,
  });
}

function ownerDeviceExchangeError(row: OwnerDeviceAuthRow, code: string, message: string): AuthError {
  const err: AuthError = new Error(message);
  err.code = code;
  return attachOwnerDeviceTraceContext(err, row);
}

async function requireOwnerDeviceClient(row: OwnerDeviceAuthRow, clientId: string): Promise<void> {
  try {
    const registeredClient = await getRegisteredClient(clientId);
    if (!registeredClient) {
      throw ownerDeviceExchangeError(row, "invalid_client", `Unknown client_id: ${clientId}`);
    }
  } catch (err: unknown) {
    if (isAuthError(err) && err.code === "invalid_client") {
      throw attachOwnerDeviceTraceContext(err, row);
    }
    throw err;
  }
}

async function requireApprovedOwnerDeviceCode(row: OwnerDeviceAuthRow, deviceCode: string): Promise<void> {
  if (row.status === "pending" && isExpired(row)) {
    await markOwnerDeviceAuthExpired(deviceCode);
    throw ownerDeviceExchangeError(row, "expired_token", "Device code has expired");
  }
  if (row.status === "denied") {
    throw ownerDeviceExchangeError(row, "access_denied", "The resource owner denied the request");
  }
  if (row.status === "expired") {
    throw ownerDeviceExchangeError(row, "expired_token", "Device code has expired");
  }
  if (row.status === "pending") {
    if (row.last_polled_at) {
      const sinceLastPollMs = Date.now() - new Date(row.last_polled_at).getTime();
      if (sinceLastPollMs < row.interval_seconds * 1000) {
        throw ownerDeviceExchangeError(row, "slow_down", "Polling too quickly");
      }
    }
    await updateOwnerDeviceAuthLastPolled(deviceCode);
    throw ownerDeviceExchangeError(row, "authorization_pending", "Authorization still pending");
  }
  if (!isNonEmptyString(row.token_id)) {
    throw ownerDeviceExchangeError(row, "expired_token", "Owner token is unavailable");
  }
}

/**
 * RFC 8628-style device-code polling for owner tokens.
 */
export async function exchangeOwnerDeviceCode({
  clientId,
  deviceCode,
}: {
  clientId: unknown;
  deviceCode: unknown;
}): Promise<Record<string, unknown>> {
  if (!(isNonEmptyString(clientId) && isNonEmptyString(deviceCode))) {
    const err: AuthError = new Error("client_id and device_code are required");
    err.code = "invalid_request";
    throw err;
  }

  const row = await getOwnerDeviceAuthRow(deviceCode);
  if (!row || row.client_id !== clientId) {
    const err: AuthError = new Error("Unknown or invalid device_code");
    err.code = "invalid_grant";
    throw err;
  }
  await requireOwnerDeviceClient(row, clientId);
  await requireApprovedOwnerDeviceCode(row, deviceCode);
  const tokenInfo = await introspect(row.token_id);
  if (!(tokenInfo.active && tokenInfo.exp)) {
    throw attachOwnerDeviceTraceContext(
      Object.assign(new Error("Owner token is no longer active"), {
        code: "expired_token",
      }),
      row
    );
  }

  return {
    access_token: row.token_id,
    expires_in: Math.max(tokenInfo.exp - Math.floor(Date.now() / 1000), 0),
    token_type: "Bearer",
    trace_context: row.trace_id
      ? {
          request_id: row.request_id || undefined,
          scenario_id: row.scenario_id || undefined,
          trace_id: row.trace_id,
        }
      : null,
  };
}

/**
 * Issue an access token bound to a grant
 */
type PostgresTransactionClient = Parameters<Parameters<typeof withPostgresTransaction>[0]>[0];

async function insertPostgresGrantToken(
  client: PostgresTransactionClient,
  {
    clientId,
    expiresAt,
    grantId,
    subjectId,
  }: { clientId: string; expiresAt: string | null; grantId: string; subjectId: string }
): Promise<{ grantRow: GrantIssuanceRow; persistedGrant: DbRow; tokenId: string }> {
  const result = await client.query<GrantIssuanceRow>(
    `SELECT access_mode, consumed, status, trace_id, scenario_id,
            grant_json::text AS grant_json,
            storage_binding_json::text AS storage_binding_json
     FROM grants
     WHERE grant_id = $1
     FOR UPDATE`,
    [grantId]
  );
  const row = result.rows[0] || null;
  if (!row) {
    const err: AuthError = new Error(`Unknown grant: ${grantId}`);
    err.code = "grant_invalid";
    throw err;
  }
  if (row.status !== "active") {
    const err: AuthError = new Error(
      row.status === "revoked" ? "Grant has been revoked" : `Grant is not active: ${row.status}`
    );
    err.code = row.status === "revoked" ? "grant_revoked" : "grant_invalid";
    throw err;
  }
  if (row.access_mode === "single_use") {
    if (row.consumed) {
      const err: AuthError = new Error("Grant has already been consumed");
      err.code = "grant_consumed";
      throw err;
    }
    await client.query("UPDATE grants SET consumed = TRUE WHERE grant_id = $1", [grantId]);
  }
  const tokenId = generateToken();
  await client.query(
    `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
     VALUES($1, $2, $3, $4, 'client', $5)`,
    [tokenId, grantId, subjectId, clientId, expiresAt]
  );
  return {
    grantRow: row,
    persistedGrant: requirePersistedGrantState(row).grant,
    tokenId,
  };
}

export async function issueToken(
  grantId: string,
  subjectId: string,
  clientId: string,
  expiresAt: string | null,
  meta: { traceContext?: TraceContext | null; source?: string } = {}
): Promise<string> {
  if (isPostgresStorageBackend()) {
    const { tokenId, grantRow, persistedGrant } = await withPostgresTransaction((client) =>
      insertPostgresGrantToken(client, { clientId, expiresAt, grantId, subjectId })
    );

    await emitSpineEvent({
      actor_id: "pdpp_as",
      actor_type: "authorization_server",
      client_id: clientId,
      data: {
        issuance_path: meta.source || "grant",
        source: describeGrantSource(persistedGrant),
        token_kind: "client",
      },
      event_type: "token.issued",
      grant_id: grantId,
      object_id: tokenId,
      object_type: "token",
      request_id: meta.traceContext?.request_id || undefined,
      scenario_id: meta.traceContext?.scenario_id || grantRow.scenario_id || undefined,
      status: "succeeded",
      subject_id: subjectId,
      subject_type: "subject",
      token_id: tokenId,
      trace_id: meta.traceContext?.trace_id || grantRow.trace_id || undefined,
    });

    return tokenId;
  }

  // better-sqlite3 transactions must be synchronous. We prepare the body as a
  // synchronous function and wrap it; the public export stays `async` because
  // external callers `await issueToken(...)`.
  return transaction(() => {
    const grantRow = getOne<GrantIssuanceRow>(referenceQueries.authGrantsGetForIssuance, [grantId]);

    if (!grantRow) {
      const err: AuthError = new Error(`Unknown grant: ${grantId}`);
      err.code = "grant_invalid";
      throw err;
    }

    if (grantRow.status !== "active") {
      const err: AuthError = new Error(
        grantRow.status === "revoked" ? "Grant has been revoked" : `Grant is not active: ${grantRow.status}`
      );
      err.code = grantRow.status === "revoked" ? "grant_revoked" : "grant_invalid";
      throw err;
    }

    if (grantRow.access_mode === "single_use") {
      if (grantRow.consumed) {
        const err: AuthError = new Error("Grant has already been consumed");
        err.code = "grant_consumed";
        throw err;
      }
      exec(referenceQueries.authGrantsMarkConsumed, [grantId]);
    }

    const tokenId = generateToken();
    exec(referenceQueries.authTokensInsertClient, [tokenId, grantId, subjectId, clientId, expiresAt]);

    const { grant: persistedGrant } = requirePersistedGrantState(grantRow);
    // emitSpineEvent is sync internally; calling without await is fine
    // because the INSERT it triggers has completed before this returns.
    emitSpineEvent({
      actor_id: "pdpp_as",
      actor_type: "authorization_server",
      client_id: clientId,
      data: {
        issuance_path: meta.source || "grant",
        source: describeGrantSource(persistedGrant),
        token_kind: "client",
      },
      event_type: "token.issued",
      grant_id: grantId,
      object_id: tokenId,
      object_type: "token",
      request_id: meta.traceContext?.request_id || undefined,
      scenario_id: meta.traceContext?.scenario_id || grantRow.scenario_id || undefined,
      status: "succeeded",
      subject_id: subjectId,
      subject_type: "subject",
      token_id: tokenId,
      trace_id: meta.traceContext?.trace_id || grantRow.trace_id || undefined,
    });

    return tokenId;
  });
}
async function issueOwnerTokenRecord(
  subjectId: string,
  meta: { traceContext?: TraceContext | null; clientId?: string | null; userCode?: string } = {}
): Promise<{ tokenId: string; expiresAt: string }> {
  const tokenId = generateToken();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  // Record the issuing client_id when the caller knows it (per-token DCR
  // path). Pre-DCR callers pass NULL and the row stays as before.
  // See openspec/changes/dcr-per-owner-token-with-revoke/.
  await getTokenStore().insertOwner({ clientId: meta.clientId || null, expiresAt, subjectId, tokenId });
  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: meta.clientId || null,
    data: {
      issuance_path: "owner_device_flow",
      token_kind: "owner",
      ...(meta.userCode ? { user_code: meta.userCode } : {}),
    },
    event_type: "token.issued",
    object_id: tokenId,
    object_type: "token",
    request_id: meta.traceContext?.request_id || undefined,
    scenario_id: meta.traceContext?.scenario_id || undefined,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    token_id: tokenId,
    trace_id: meta.traceContext?.trace_id || undefined,
  });
  return { expiresAt, tokenId };
}

/**
 * Reference bootstrap helper for issuing an owner token for a subject.
 * This remains useful for isolated harness setup, but the public owner path is the device flow.
 */
export async function issueOwnerToken(
  subjectId: string,
  meta: { traceContext?: TraceContext | null; clientId?: string | null; userCode?: string } = {}
): Promise<string> {
  const { tokenId } = await issueOwnerTokenRecord(subjectId, meta);
  return tokenId;
}

function getInactiveTokenBinding(row: TokenIntrospectionRow): Record<string, unknown> {
  if (row.token_kind === "client") {
    return {
      client_id: row.client_id,
      grant_id: row.grant_id,
      scenario_id: row.scenario_id,
      subject_id: row.subject_id,
      trace_id: row.trace_id,
    };
  }
  if (row.token_kind === "mcp_package") {
    return {
      client_id: row.client_id,
      grant_package_id: row.package_id,
      scenario_id: row.package_scenario_id,
      subject_id: row.subject_id,
      trace_id: row.package_trace_id,
    };
  }
  return {};
}

function inactiveInvalidGrantToken(row: TokenIntrospectionRow): TokenIntrospectionResult {
  return {
    active: false,
    client_id: row.client_id,
    grant_id: row.grant_id,
    inactive_reason: "grant_invalid",
    scenario_id: row.scenario_id,
    subject_id: row.subject_id,
    trace_id: row.trace_id,
  };
}

async function enrichClientTokenIntrospection(
  row: TokenIntrospectionRow,
  result: TokenIntrospectionResult
): Promise<TokenIntrospectionResult> {
  try {
    const { grant: parsedGrant, storageBinding: grantStorageBinding } = requirePersistedGrantState(row);
    try {
      const manifest = await getManifestForStorageBinding(grantStorageBinding);
      if (manifest) {
        requireGrantContractAgainstManifest(parsedGrant, manifest);
      }
    } catch (err: unknown) {
      if (isAuthError(err) && err.code === "grant_invalid") {
        return inactiveInvalidGrantToken(row);
      }
      throw err;
    }
    result.grant_id = row.grant_id;
    result.client_id = row.client_id;
    result.grant = parsedGrant;
    result.grant_storage_binding = grantStorageBinding;
    result.trace_id = row.trace_id;
    result.scenario_id = row.scenario_id;
    return result;
  } catch (err: unknown) {
    if (!isAuthError(err) || err.code !== "grant_invalid") {
      throw err;
    }
    return inactiveInvalidGrantToken(row);
  }
}

/**
 * RFC 7662-style introspection with PDPP extensions
 */
export async function introspect(token: unknown): Promise<TokenIntrospectionResult> {
  if (!isNonEmptyString(token)) {
    return { active: false };
  }
  const row = await getTokenStore().getIntrospection(token);

  if (!row) {
    return { active: false };
  }

  if (row.revoked) {
    return {
      active: false,
      inactive_reason: row.token_kind === "client" ? "grant_revoked" : "token_revoked",
      ...getInactiveTokenBinding(row),
    };
  }

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return {
      active: false,
      inactive_reason: row.token_kind === "client" ? "grant_expired" : "token_expired",
      ...getInactiveTokenBinding(row),
    };
  }

  // Check grant still active (for client tokens)
  if (row.token_kind === "client" && row.grant_status !== "active") {
    return {
      active: false,
      client_id: row.client_id,
      grant_id: row.grant_id,
      inactive_reason: "grant_revoked",
      scenario_id: row.scenario_id,
      subject_id: row.subject_id,
      trace_id: row.trace_id,
    };
  }

  if (row.token_kind === "mcp_package" && row.package_status !== "active") {
    return {
      active: false,
      client_id: row.client_id,
      grant_package_id: row.package_id,
      inactive_reason: "package_revoked",
      scenario_id: row.package_scenario_id,
      subject_id: row.subject_id,
      trace_id: row.package_trace_id,
    };
  }

  const result: TokenIntrospectionResult = {
    active: true,
    exp: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : null,
    pdpp_token_kind: row.token_kind,
    subject_id: row.subject_id,
  };

  if (row.token_kind === "owner" && row.client_id) {
    result.client_id = row.client_id;
  }

  if (row.token_kind === "mcp_package") {
    result.grant_package_id = row.package_id;
    result.client_id = row.client_id;
    result.package = parsePackageJson(row.package_json);
    result.trace_id = row.package_trace_id;
    result.scenario_id = row.package_scenario_id;
  }

  if (row.token_kind === "client") {
    return enrichClientTokenIntrospection(row, result);
  }

  return result;
}

/**
 * Revoke a grant
 */
interface GrantRevocationContext {
  request_id?: string | null;
  scenario_id?: string | null;
  trace_id?: string | null;
}

async function requireRevocablePersistedGrant(
  row: GrantRevocationRow,
  grantId: string,
  context: GrantRevocationContext
): Promise<DbRow> {
  try {
    const { grant, storageBinding } = requirePersistedGrantState(row);
    const manifest = await getManifestForStorageBinding(storageBinding);
    if (manifest) {
      requireGrantContractAgainstManifest(grant, manifest);
    }
    return grant;
  } catch (err: unknown) {
    if (!(isAuthError(err) && err.code === "grant_invalid")) {
      throw err;
    }
    const sourceDescriptor = describePersistedGrantSource(row);
    await emitSpineEvent({
      actor_id: "pdpp_as",
      actor_type: "authorization_server",
      client_id: row.client_id,
      data: {
        ...(sourceDescriptor ? { source: sourceDescriptor } : {}),
        error: {
          code: "grant_invalid",
          message: "Grant is malformed or no longer valid",
        },
      },
      event_type: "grant.revoke_rejected",
      grant_id: grantId,
      object_id: grantId,
      object_type: "grant",
      request_id: context.request_id || undefined,
      scenario_id: row.scenario_id || undefined,
      status: "rejected",
      subject_id: row.subject_id,
      subject_type: "subject",
      trace_id: row.trace_id || undefined,
    });
    throw buildGrantInvalidError({
      ...(context.request_id === undefined ? {} : { request_id: context.request_id }),
      ...(row.trace_id === undefined ? {} : { trace_id: row.trace_id }),
    });
  }
}

async function revokeGrantStorage(grantId: string): Promise<void> {
  if (isPostgresStorageBackend()) {
    await pgExec("UPDATE grants SET status = 'revoked' WHERE grant_id = $1", [grantId]);
    await pgExec("UPDATE tokens SET revoked = TRUE WHERE grant_id = $1", [grantId]);
    await pgExec(
      "UPDATE oauth_refresh_tokens SET status = 'revoked', revoked_at = $1 WHERE grant_id = $2 AND status = 'active'",
      [nowIso(), grantId]
    );
    return;
  }
  exec(referenceQueries.authGrantsMarkRevoked, [grantId]);
  exec(referenceQueries.authTokensRevokeByGrant, [grantId]);
  exec(referenceQueries.authOauthRefreshTokensRevokeByGrant, [nowIso(), grantId]);
}

async function emitGrantRevoked(
  row: GrantRevocationRow,
  parsedGrant: DbRow,
  grantId: string,
  context: GrantRevocationContext
): Promise<void> {
  await emitSpineEvent({
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: row.client_id,
    data: {
      source: describeGrantSource(parsedGrant),
    },
    event_type: "grant.revoked",
    grant_id: grantId,
    object_id: grantId,
    object_type: "grant",
    request_id: context.request_id || undefined,
    scenario_id: row.scenario_id || undefined,
    status: "succeeded",
    subject_id: row.subject_id,
    subject_type: "subject",
    trace_id: row.trace_id || undefined,
  });
}

export async function revokeGrant(
  grantId: string,
  context: GrantRevocationContext = {}
): Promise<{ request_id: string | null; trace_id: string | null }> {
  const row0 = isPostgresStorageBackend()
    ? await pgOne<GrantRevocationRow>(
        `SELECT client_id, subject_id, trace_id, scenario_id,
                grant_json::text AS grant_json,
                storage_binding_json::text AS storage_binding_json
         FROM grants
         WHERE grant_id = $1`,
        [grantId]
      )
    : getOne<GrantRevocationRow>(referenceQueries.authGrantsGetForRevocation, [grantId]);

  const parsedGrant = row0 ? await requireRevocablePersistedGrant(row0, grantId, context) : null;
  await revokeGrantStorage(grantId);
  if (row0 && parsedGrant) {
    await emitGrantRevoked(row0, parsedGrant, grantId, context);
  }

  return {
    request_id: context.request_id || null,
    trace_id: row0?.trace_id || null,
  };
}
