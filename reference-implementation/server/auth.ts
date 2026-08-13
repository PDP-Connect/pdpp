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
import { createRequire } from "node:module";
import {
  BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
  BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
  ResolvedGrantSchema,
  validateResponse,
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
  writeTransaction,
} from "../lib/db.ts";
import { postgresEmitSpineEventInTransaction } from "../lib/postgres-spine.ts";
import { createTraceContext, emitSpineEvent as emitRawSpineEvent, type SpineEventInput } from "../lib/spine.ts";
import type { CimdFetchDependencies, CimdTransportFailureEvent } from "./cimd.ts";
import { listActiveBindingsForGrant, projectBindingForWire } from "./connection-identity.ts";
import { canonicalConnectorKey, canonicalConnectorKeyFromManifest } from "./connector-key.ts";
import {
  invalidConnectorManifest,
  resolveManifestSensitivity,
  validateConnectorManifest,
} from "./connector-manifest-validation.ts";
import {
  projectResolvedCoreGrantStreams as coreProjectResolvedGrantStreams,
  coreSchemaRequiredFields,
  createRetainedCoreConsentSnapshot,
  materializeCoreResolvedGrant,
  readRetainedCoreConsentSnapshot,
  resolveCoreEligibleInstanceIds,
  validateCoreSelectionRequest,
} from "./core-source-authorization.ts";
import { getDb, runWithSqliteBusyRetry } from "./db.ts";
import {
  base64UrlSha256,
  generateOAuthRefreshToken,
  generateToken,
  hashOAuthRefreshToken,
  PKCE_CODE_VERIFIER_RE,
  SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS,
} from "./oauth-substrate/primitives.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "./postgres-storage.ts";
import { buildGrantedAuthorizationDetail } from "./source-approved-authorization.ts";
import { snapshotSourceDeclaration } from "./source-declaration.ts";
import { snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest } from "./source-declaration-legacy-collection.ts";
import {
  type AcceptedSourceDeclarationRevisionStore,
  acceptedRevisionEvidenceReference,
} from "./source-declaration-trust/revision-store.ts";
import { getAcceptedProviderNativeDeclarationRevision } from "./source-declaration-trust/service.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
  resolveOwnerConnectorInstanceNamespace,
} from "./stores/connector-instance-store.ts";

// ─── Domain types ─────────────────────────────────────────────────────────────

interface AuthError extends Error {
  code?: string;
  fresh_authorization_required?: boolean;
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

interface InitiateGrantOptions {
  acceptedProviderNativeRevision?: AcceptedProviderNativeRevisionForConsent;
  /** Internal handle produced by provider-native onboarding. It is evidence, never a grant right. */
  acceptedRevisionReference?: string;
  acceptedRevisionStore?: AcceptedSourceDeclarationRevisionStore;
  baseUrl?: string;
  cimdFetchDependencies?: CimdFetchDependencies;
  issuerBase?: string;
  /** Explicit local/test operator provisioning. This is not verified provider-native discovery. */
  nativeManifest?: DbRow | null;
  /** Required when nativeManifest supplies storage only for an accepted provider-native revision. */
  nativeManifestMode?: "fulfillment_only" | "local_operator_provisioning";
  onCimdTransportFailure?: (event: CimdTransportFailureEvent) => void;
  scenarioId?: string;
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
  fields?: string[];
  instance_ids?: string[];
  name: string;
  necessity?: string;
  resources?: string[];
  time_constraint?: { field: string; since?: string; until?: string };
  time_range?: { since?: string; [key: string]: unknown };
  view?: string;
}

interface RawStreamSelection {
  fields?: unknown[] | undefined;
  instance_ids?: unknown[] | undefined;
  name: unknown;
  necessity?: unknown | undefined;
  resources?: unknown[] | undefined;
  time_range?: unknown | undefined;
  view?: unknown | undefined;
}

interface GrantSelection {
  access_mode: string;
  client_claims?: unknown | undefined;
  purpose_code: string;
  purpose_description?: string | undefined;
  retention?: unknown | undefined;
  selection_preset?: string | undefined;
  streams?: RawStreamSelection[] | undefined;
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
  source_declaration_snapshot?: SourceDeclarationSnapshot | undefined;
  storage_binding?: StorageBinding | null | undefined;
  trace_context?: TraceContext | undefined;
}

interface BatchEntry {
  manifest_version?: string | undefined;
  selection: GrantSelection;
  source_binding?: SourceBinding | null | undefined;
  source_declaration_snapshot?: SourceDeclarationSnapshot | undefined;
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

interface ConsentExchangeRow extends DbRow {
  code_hash: string;
  created_at: string;
  expires_at: string;
  grant_id: string | null;
  package_id: string | null;
  proof_hash: string | null;
  redeemed_at: string | null;
  token_expires_at: string | null;
  token_id: string;
  token_revoked: boolean | number;
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
    client_id: string;
  };
  expires_at: string | null;
  grant_id: string;
  issued_at: string;
  purpose_code: string;
  purpose_description: string | undefined;
  retention: unknown;
  selection_preset?: string;
  source: SourceBinding;
  source_declaration: { version: string };
  streams: ResolvedGrantStream[];
  subject: { id: string };
  version: string;
}

interface ResolvedGrantStream extends Record<string, unknown> {
  fields: string[];
  instance_ids: string[];
  name: string;
  resources?: string[];
  time_constraint?: { field: string; since?: string; until?: string };
}

interface SourceDeclarationSnapshot {
  accepted_revision_reference?: string;
  declaration: DbRow;
  declaration_version: string;
  publisher_attribution?: SourcePublisherAttribution;
  resolved_streams: StreamSelection[];
  resource_authority?: SourceResourceAuthority;
  snapshot_version: "reference.source-declaration-snapshot.v1";
  source: SourceBinding;
  source_sensitivity: string;
}

interface SourcePublisherAttribution {
  id: string;
  status: "unverified";
}

type SourceResourceAuthority =
  | { authority_binding: string; status: "verified" }
  | { status: "local_operator_provisioned" };

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
  grant_access_mode?: string;
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
  scenario_id: string | null;
  status: string;
  subject_id: string;
  trace_id: string | null;
}

interface GrantPackageCursor {
  created_at: string;
  package_id: string;
}

interface PendingConsentRow extends DbRow {
  approval_review_digest?: string | null;
  approval_review_json?: string | null;
  approval_review_revision?: string | null;
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

export type OwnerDeviceApprovalFaultHook = (stage: "before_token_insert" | "after_token_insert") => void;

export type AuthorizationDecisionFaultStage = "after_cas_before_event" | "after_event_before_commit";
export type AuthorizationDecisionFaultHook = (stage: AuthorizationDecisionFaultStage) => void;

interface OwnerDeviceApprovalInput {
  clientId: string;
  consentApprovedEvent: AuthSpineEventInput;
  deviceCode: string;
  expiresAt: string;
  faultHook?: OwnerDeviceApprovalFaultHook | undefined;
  pendingSnapshot: OwnerDeviceAuthRow;
  subjectId: string;
  tokenId: string;
  tokenIssuedEvent: AuthSpineEventInput;
}

interface OAuthPendingCodeRow extends DbRow {
  client_id: string;
  consumed_at: string | null;
  device_code: string;
  expires_at: string;
  grant_id: string | null;
  issued_at: string | null;
  issued_code: string | null;
  package_id: string | null;
  redirect_uri: string;
  state: string | null;
  status: string;
  token_id: string | null;
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
  family_id: string;
  generation: number;
  grant_id: string | null;
  package_id: string | null;
  parent_generation: number | null;
  revoked_at: string | null;
  status: string;
  subject_id: string;
  superseded_at: string | null;
}

interface GrantIssuanceRow extends DbRow {
  access_mode: string;
  client_id: string;
  consumed: boolean | number;
  expires_at: string | null;
  grant_id: string;
  grant_json: string;
  scenario_id: string | null;
  status: string;
  storage_binding_json: string | null;
  subject_id: string;
  trace_id: string;
}

interface GrantRevocationRow extends DbRow {
  access_mode: string;
  client_id: string;
  expires_at: string | null;
  grant_id: string;
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
  refresh_family_active: boolean | number | null;
  refresh_family_id: string | null;
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
  exp?: number;
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
    paramsJson: string;
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
  markDeniedAtomically: (input: {
    deviceCode: string;
    deniedAt: string;
    event: AuthSpineEventInput;
    faultHook?: AuthorizationDecisionFaultHook;
  }) => MaybePromise<StoreWriteResult>;
  markExpired: (input: { deviceCode: string }) => MaybePromise<StoreWriteResult>;
  updateLastPolled: (input: { deviceCode: string; polledAt: string }) => MaybePromise<StoreWriteResult>;
}

interface OwnerDeviceAuthStore {
  approveAtomically: (input: OwnerDeviceApprovalInput) => MaybePromise<OwnerDeviceAuthRow>;
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
  markDeniedAtomically: (input: {
    deviceCode: string;
    deniedAt: string;
    event: AuthSpineEventInput;
    faultHook?: AuthorizationDecisionFaultHook;
  }) => MaybePromise<StoreWriteResult>;
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
  listBySourceId: (sourceId: string) => MaybePromise<readonly DbRow[]>;
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
  insert: (input: {
    refreshTokenHash: string;
    familyId: string;
    generation: number;
    parentGeneration: number | null;
    clientId: string;
    grantId: string;
    subjectId: string;
    createdAt: string;
    expiresAt: string | null;
  }) => MaybePromise<StoreWriteResult>;
  insertForPackage: (input: {
    refreshTokenHash: string;
    familyId: string;
    generation: number;
    parentGeneration: number | null;
    clientId: string;
    packageId: string;
    subjectId: string;
    createdAt: string;
    expiresAt: string | null;
  }) => MaybePromise<StoreWriteResult>;
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

const OAUTH_REFRESH_ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;

function refreshAccessTokenExpiresAt(issuedAt: string, refreshFamilyExpiresAt: string | null): string {
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token issuance time is invalid");
  }
  const shortExpiryMs = issuedAtMs + OAUTH_REFRESH_ACCESS_TOKEN_LIFETIME_SECONDS * 1000;
  if (!refreshFamilyExpiresAt) {
    return new Date(shortExpiryMs).toISOString();
  }
  const familyExpiryMs = Date.parse(refreshFamilyExpiresAt);
  if (!Number.isFinite(familyExpiryMs)) {
    throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token family expiry is invalid");
  }
  return new Date(Math.min(shortExpiryMs, familyExpiryMs)).toISOString();
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
const SUPPORTED_STREAM_SELECTION_FIELDS = new Set([
  "fields",
  "instance_ids",
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
  "source_declaration_snapshot",
  "source_binding",
  "storage_binding",
  "trace_context",
]);
const SUPPORTED_PENDING_CLIENT_FIELDS = new Set(["client_display", "client_id", "registration_mode"]);
const SUPPORTED_PENDING_SELECTION_FIELDS = new Set([
  "access_mode",
  "client_claims",
  "purpose_code",
  "purpose_description",
  "retention",
  "selection_preset",
  "streams",
  "type",
]);
function cloneJson<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

interface ContractSchemaError {
  instancePath?: string;
  message?: string;
}

interface ContractSchemaValidator {
  errors?: ContractSchemaError[] | null;
  (value: unknown): boolean;
}

interface ContractAjv {
  compile: (schema: object) => ContractSchemaValidator;
}

const requireFromReferenceContract = createRequire(import.meta.resolve("@pdpp/reference-contract"));
const ContractAjv2020 = requireFromReferenceContract("ajv/dist/2020.js") as new (
  options?: Record<string, unknown>
) => ContractAjv;
const addContractFormats = requireFromReferenceContract("ajv-formats") as (ajv: ContractAjv) => void;
const contractAjv = new ContractAjv2020({ allErrors: true, strict: false });
addContractFormats(contractAjv);
const validateResolvedGrantContract = contractAjv.compile(ResolvedGrantSchema);

function contractValidationMessage(validator: ContractSchemaValidator): string {
  return (validator.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message || "is invalid"}`)
    .join("; ");
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

const CURRENT_GRANT_PACKAGE_VERSION = "reference.mcp_package.v2";
const LEGACY_CONNECTOR_PROJECTION_PUBLISHER_ID = "https://pdpp.dev/reference-implementation";
const CANONICAL_NON_NEGATIVE_INTEGER_KEY_RE = /^(0|[1-9][0-9]*)$/;

function retainableSourceDeclaration(
  sourceBinding: SourceBinding,
  manifest: DbRow
): { declaration: DbRow; declarationVersion: string } {
  if (manifest.source_declaration !== undefined) {
    const declaration = snapshotSourceDeclaration(manifest.source_declaration);
    if (declaration.source.id !== sourceBinding.id || declaration.source.kind !== sourceBinding.kind) {
      throw bindingError("invalid_request", "Configured SourceDeclaration does not match the requested source");
    }
    return {
      declaration: declaration as unknown as DbRow,
      declarationVersion: declaration.declaration_version,
    };
  }

  if (sourceBinding.kind !== "connector") {
    throw bindingError("invalid_request", "The requested source has no retained SourceDeclaration");
  }

  const connectorImplementationId = isNonEmptyString(manifest.manifest_uri) ? manifest.manifest_uri : sourceBinding.id;
  if (!isNonEmptyString(manifest.version)) {
    throw bindingError("invalid_request", "Connector manifest version must be a non-empty string");
  }
  const declaration = snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(manifest, {
    connectorImplementationId,
    publisherId: LEGACY_CONNECTOR_PROJECTION_PUBLISHER_ID,
    sourceId: sourceBinding.id,
  });
  return {
    declaration: declaration as unknown as DbRow,
    declarationVersion: declaration.declaration_version,
  };
}

interface RetainedSourceDeclarationTrust {
  accepted_revision_reference?: string;
  publisher_attribution: SourcePublisherAttribution;
  resource_authority: SourceResourceAuthority;
}

interface AcceptedProviderNativeRevisionForConsent {
  declaration: DbRow;
  source: SourceBinding;
  trust: RetainedSourceDeclarationTrust & { accepted_revision_reference: string };
}

async function prepareInitiateGrantOptions(opts: InitiateGrantOptions): Promise<InitiateGrantOptions> {
  const { acceptedRevisionReference, acceptedRevisionStore } = opts;
  if (!(acceptedRevisionReference || acceptedRevisionStore)) {
    return opts;
  }
  if (!(isNonEmptyString(acceptedRevisionReference) && acceptedRevisionStore)) {
    throw bindingError(
      "invalid_request",
      "Accepted provider-native revision reference and revision store must be supplied together"
    );
  }
  if (opts.acceptedProviderNativeRevision) {
    throw bindingError("invalid_request", "Accepted provider-native revision was supplied through two authority paths");
  }
  if (resolveConfiguredNativeManifest(opts) && opts.nativeManifestMode !== "fulfillment_only") {
    throw bindingError(
      "invalid_request",
      "Accepted provider-native revisions require nativeManifest to be explicitly marked fulfillment_only"
    );
  }

  const accepted = await getAcceptedProviderNativeDeclarationRevision(
    { acceptedRevisionReference },
    { revisionStore: acceptedRevisionStore }
  );
  if (!accepted) {
    throw bindingError("invalid_request", "Accepted provider-native declaration revision was not found");
  }
  const declaration = snapshotSourceDeclaration(accepted.parsedDeclaration);
  if (
    accepted.acceptedRevisionReference !== acceptedRevisionReference ||
    accepted.declarationVersion !== declaration.declaration_version ||
    accepted.sourceId !== declaration.source.id ||
    declaration.source.kind !== "provider_native" ||
    !isNonEmptyString(accepted.authorityBinding)
  ) {
    throw bindingError("invalid_request", "Accepted provider-native declaration revision does not match the request");
  }

  return {
    ...opts,
    acceptedProviderNativeRevision: {
      declaration: declaration as unknown as DbRow,
      source: { id: declaration.source.id, kind: "provider_native" },
      trust: {
        accepted_revision_reference: accepted.acceptedRevisionReference,
        publisher_attribution: { id: declaration.publisher.id, status: "unverified" },
        resource_authority: { authority_binding: accepted.authorityBinding, status: "verified" },
      },
    },
  };
}

function localOperatorProvisioningTrust(declaration: DbRow): RetainedSourceDeclarationTrust {
  const publisher = isRecord(declaration.publisher) ? declaration.publisher.id : null;
  if (!isNonEmptyString(publisher)) {
    throw bindingError("invalid_request", "Operator-provisioned SourceDeclaration publisher is invalid");
  }
  return {
    publisher_attribution: { id: publisher, status: "unverified" },
    resource_authority: { status: "local_operator_provisioned" },
  };
}

/**
 * Persistence boundary for the declaration retained with a pending consent.
 * Today the carrier is params_json; keeping construction and reads here lets
 * the store move it to a dedicated column without changing consent logic.
 */
async function retainSourceDeclarationSnapshot(
  request: PendingRequest,
  sourceBinding: SourceBinding,
  storageBinding: StorageBinding,
  manifest: DbRow,
  opts: InitiateGrantOptions = {}
): Promise<SourceDeclarationSnapshot> {
  const preparedAccepted = opts.acceptedProviderNativeRevision ?? null;
  const accepted = preparedAccepted && preparedAccepted.source.id === sourceBinding.id ? preparedAccepted : null;
  if (accepted && accepted.source.kind !== sourceBinding.kind) {
    throw bindingError("invalid_request", "Accepted provider-native declaration revision does not match the request");
  }
  const retained = accepted
    ? { declaration: accepted.declaration, declarationVersion: accepted.declaration.declaration_version as string }
    : await retainableSourceDeclaration(sourceBinding, manifest);
  const coreSnapshot = createRetainedCoreConsentSnapshot({
    declaration: retained.declaration,
    selection: request.selection as unknown as import("./core-source-authorization.ts").CoreSelection,
    source: sourceBinding,
    sourceSensitivity: resolveManifestSensitivity(manifest),
  }) as unknown as SourceDeclarationSnapshot;
  let trust: RetainedSourceDeclarationTrust | null = accepted ? accepted.trust : null;
  if (!trust && sourceBinding.kind === "provider_native") {
    if (
      opts.nativeManifestMode !== "local_operator_provisioning" ||
      !isConfiguredFulfillment(sourceBinding, storageBinding, opts)
    ) {
      throw bindingError(
        "invalid_request",
        "Provider-native consent requires an accepted revision or explicit local operator provisioning"
      );
    }
    trust = localOperatorProvisioningTrust(coreSnapshot.declaration);
  }
  const snapshot: SourceDeclarationSnapshot = trust ? { ...coreSnapshot, ...trust } : coreSnapshot;
  request.source_declaration_snapshot = snapshot;
  request.manifest_version = retained.declarationVersion;
  return snapshot;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is one fail-closed persistence evidence boundary; splitting its coupled shape checks would obscure the invariant.
function readRetainedSourceDeclarationSnapshot(request: Partial<PendingRequest>): SourceDeclarationSnapshot {
  if (!request.selection) {
    throw bindingError("invalid_request", "Pending consent selection is missing");
  }
  try {
    if (!isRecord(request.source_declaration_snapshot)) {
      throw new Error("Pending consent declaration snapshot is missing");
    }
    const {
      accepted_revision_reference: acceptedRevisionReference,
      publisher_attribution: publisherAttribution,
      resource_authority: resourceAuthority,
      ...coreSnapshot
    } = request.source_declaration_snapshot;
    const retained = readRetainedCoreConsentSnapshot({
      selection: request.selection as unknown as import("./core-source-authorization.ts").CoreSelection,
      snapshot: coreSnapshot,
      source: request.source_binding,
    }) as unknown as SourceDeclarationSnapshot;
    const hasTrustEvidence =
      acceptedRevisionReference !== undefined || publisherAttribution !== undefined || resourceAuthority !== undefined;
    if (retained.source.kind !== "provider_native") {
      if (hasTrustEvidence) {
        throw new Error("Connector declaration snapshot must not contain provider-native trust evidence");
      }
      return retained;
    }
    if (!(isRecord(publisherAttribution) && publisherAttribution.status === "unverified")) {
      throw new Error("Provider-native publisher attribution evidence is missing or invalid");
    }
    const declarationPublisher = isRecord(retained.declaration.publisher) ? retained.declaration.publisher.id : null;
    if (!isNonEmptyString(publisherAttribution.id) || publisherAttribution.id !== declarationPublisher) {
      throw new Error("Provider-native publisher attribution does not match the retained declaration");
    }
    if (!isRecord(resourceAuthority)) {
      throw new Error("Provider-native resource authority evidence is missing");
    }
    if (acceptedRevisionReference !== undefined) {
      if (
        !isNonEmptyString(acceptedRevisionReference) ||
        resourceAuthority.status !== "verified" ||
        !isNonEmptyString(resourceAuthority.authority_binding)
      ) {
        throw new Error("Accepted provider-native resource authority evidence is invalid");
      }
      const expectedReference = acceptedRevisionEvidenceReference({
        authorityBinding: resourceAuthority.authority_binding as string,
        declarationVersion: retained.declaration_version,
        sourceId: retained.source.id,
      });
      if (acceptedRevisionReference !== expectedReference) {
        throw new Error("Accepted provider-native revision evidence is stale or tampered");
      }
    } else if (
      resourceAuthority.status !== "local_operator_provisioned" ||
      Object.keys(resourceAuthority).some((key) => key !== "status")
    ) {
      throw new Error("Operator-provisioned provider-native authority evidence is invalid");
    }
    return {
      ...retained,
      ...(acceptedRevisionReference ? { accepted_revision_reference: acceptedRevisionReference } : {}),
      publisher_attribution: { id: publisherAttribution.id, status: "unverified" },
      resource_authority:
        resourceAuthority.status === "verified"
          ? { authority_binding: resourceAuthority.authority_binding as string, status: "verified" }
          : { status: "local_operator_provisioned" },
    };
  } catch (cause: unknown) {
    const err = bindingError(
      "invalid_request",
      cause instanceof Error ? cause.message : "Pending consent snapshot is invalid"
    );
    err.cause = cause;
    throw err;
  }
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

function resolveConfiguredSourceBinding(opts: { nativeManifest?: DbRow | null } = {}): SourceBinding | null {
  const manifest = resolveConfiguredNativeManifest(opts);
  if (!isRecord(manifest?.source_declaration)) {
    return null;
  }
  const declaration = snapshotSourceDeclaration(manifest.source_declaration);
  return { id: declaration.source.id, kind: declaration.source.kind };
}

function isConfiguredFulfillment(
  sourceBinding: SourceBinding,
  storageBinding: StorageBinding,
  opts: { nativeManifest?: DbRow | null } = {}
): boolean {
  const configuredSource = resolveConfiguredSourceBinding(opts);
  const configuredStorage = resolveConfiguredNativeStorageBinding(opts);
  return configuredSource?.id === sourceBinding.id && configuredStorage?.connector_id === storageBinding.connector_id;
}

function isConfiguredStorageFulfillment(
  storageBinding: StorageBinding,
  opts: { nativeManifest?: DbRow | null } = {}
): boolean {
  return resolveConfiguredNativeStorageBinding(opts)?.connector_id === storageBinding.connector_id;
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

function normalizeStreamSelection(stream: RawStreamSelection): RawStreamSelection {
  return {
    fields: Array.isArray(stream.fields) ? stream.fields : undefined,
    instance_ids: Array.isArray(stream.instance_ids) ? stream.instance_ids : undefined,
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
// a scheme plus scheme-specific part, e.g. https://pdpp.dev/purpose/analytics.
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
  selection_preset?: string;
  streams?: RawStreamSelection[];
}

function requireAuthorizationDetailInput(detail: unknown, _index: number): AuthorizationDetailInput {
  const validated = validateCoreSelectionRequest(detail);
  const hasPreset = isNonEmptyString(validated.selection_preset);
  return {
    ...validated,
    access_mode: validated.access_mode,
    ...(hasPreset
      ? { selection_preset: validated.selection_preset as string }
      : { streams: (validated.streams ?? []).map((stream) => ({ ...stream })) }),
  };
}

async function resolveRegisteredSourceStorageConnectorId(sourceBinding: SourceBinding): Promise<string | null> {
  const rows = await getConnectorCatalogStore().listBySourceId(sourceBinding.id);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length > 1) {
    throw bindingError("invalid_request", `Source '${sourceBinding.id}' has multiple local fulfillment bindings`);
  }
  const [row] = rows;
  if (!(row && isNonEmptyString(row.connector_id))) {
    throw bindingError("invalid_request", `Source '${sourceBinding.id}' has an invalid local fulfillment binding`);
  }
  const manifest = parseAndValidateConnectorManifestRow(row, row.connector_id);
  const declaration = snapshotSourceDeclaration(manifest.source_declaration);
  if (declaration.source.id !== sourceBinding.id || declaration.source.kind !== sourceBinding.kind) {
    invalidGrantInitiationRequest(`Source kind does not match the retained declaration for '${sourceBinding.id}'`);
  }
  return row.connector_id;
}

async function resolveRegisteredSourceBindingById(sourceId: string): Promise<{
  sourceBinding: SourceBinding;
  storageConnectorId: string;
} | null> {
  const rows = await getConnectorCatalogStore().listBySourceId(sourceId);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length > 1) {
    throw bindingError("invalid_request", `Source '${sourceId}' has multiple local fulfillment bindings`);
  }
  const [row] = rows;
  if (!(row && isNonEmptyString(row.connector_id))) {
    throw bindingError("invalid_request", `Source '${sourceId}' has an invalid local fulfillment binding`);
  }
  const manifest = parseAndValidateConnectorManifestRow(row, row.connector_id);
  const declaration = snapshotSourceDeclaration(manifest.source_declaration);
  if (declaration.source.id !== sourceId) {
    invalidGrantInitiationRequest(`Source id does not match the retained declaration for '${sourceId}'`);
  }
  return {
    sourceBinding: { id: declaration.source.id, kind: declaration.source.kind },
    storageConnectorId: row.connector_id,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing request/declaration compatibility boundary; keep validation local.
async function resolveAuthorizationDetailBindings(
  detail: AuthorizationDetailInput,
  index: number,
  opts: InitiateGrantOptions
): Promise<{ sourceBinding: SourceBinding; storageBinding: StorageBinding }> {
  const at = `authorization_details[${index}]`;
  const acceptedSource = opts.acceptedProviderNativeRevision ? opts.acceptedProviderNativeRevision.source : null;
  const configuredSource = opts.nativeManifestMode === "fulfillment_only" ? null : resolveConfiguredSourceBinding(opts);
  const configuredNativeStorageBinding = resolveConfiguredNativeStorageBinding(opts);
  const configuredNativeStorageConnectorId = configuredNativeStorageBinding?.connector_id || null;
  const detailSource = detail.source;
  if (!isRecord(detailSource)) {
    throw bindingError(
      "invalid_request",
      `${at}.source must be { id } or { kind: 'connector' | 'provider_native', id }`
    );
  }
  const detailSourceKeys = Object.keys(detailSource).sort();
  const sourceHasKind = detailSourceKeys.includes("kind");
  if (
    !(
      (detailSourceKeys.length === 1 && detailSourceKeys[0] === "id") ||
      (detailSourceKeys.length === 2 && detailSourceKeys[0] === "id" && detailSourceKeys[1] === "kind")
    )
  ) {
    invalidGrantInitiationRequest(`${at}.source must include only id and optional kind`);
  }
  const sourceId = detailSource.id;
  const explicitKind = sourceHasKind ? detailSource.kind : null;
  if (
    !(
      (explicitKind === null || explicitKind === "connector" || explicitKind === "provider_native") &&
      isNonEmptyString(sourceId)
    )
  ) {
    throw bindingError(
      "invalid_request",
      `${at}.source.kind must be 'connector' or 'provider_native' when present and source.id is required`
    );
  }
  if (!isAbsoluteUriPurposeCode(sourceId)) {
    throw bindingError("invalid_request", `${at}.source.id must be an absolute URI`);
  }
  const selectsConfiguredSource = configuredSource?.id === sourceId;
  const selectsAcceptedSource = acceptedSource !== null && acceptedSource.id === sourceId;
  if (selectsAcceptedSource && explicitKind && explicitKind !== "provider_native") {
    invalidGrantInitiationRequest(`Source kind does not match the accepted declaration for '${sourceId}'`);
  }
  if (selectsConfiguredSource && explicitKind && configuredSource.kind !== explicitKind) {
    invalidGrantInitiationRequest(`Source kind does not match the retained declaration for '${sourceId}'`);
  }
  let sourceBinding: SourceBinding = {
    id: sourceId,
    kind: explicitKind || (acceptedSource ? acceptedSource.kind : null) || configuredSource?.kind || "connector",
  };
  let rawSourceConnectorId: string | null = null;
  if (selectsAcceptedSource) {
    if (opts.nativeManifestMode !== "fulfillment_only") {
      throw bindingError(
        "invalid_request",
        "Accepted provider-native source has no explicit local fulfillment binding"
      );
    }
    sourceBinding = acceptedSource;
    rawSourceConnectorId = configuredNativeStorageConnectorId;
  } else if (selectsConfiguredSource) {
    rawSourceConnectorId = configuredNativeStorageConnectorId;
  } else {
    const registered = explicitKind
      ? { sourceBinding, storageConnectorId: await resolveRegisteredSourceStorageConnectorId(sourceBinding) }
      : await resolveRegisteredSourceBindingById(sourceId);
    if (registered?.sourceBinding) {
      ({ sourceBinding } = registered);
    }
    rawSourceConnectorId = registered?.storageConnectorId ?? null;
  }
  const resolvedConnectorId = rawSourceConnectorId;
  if (!resolvedConnectorId) {
    throw bindingError("invalid_request", `Unknown source: { id: '${sourceId}' }`);
  }

  return { sourceBinding, storageBinding: { connector_id: resolvedConnectorId } };
}

async function normalizeAuthorizationDetail(
  rawDetail: unknown,
  index: number,
  opts: InitiateGrantOptions = {}
): Promise<{ selection: GrantSelection; source_binding: SourceBinding; storage_binding: StorageBinding }> {
  const detail = requireAuthorizationDetailInput(rawDetail, index);
  const { sourceBinding, storageBinding } = await resolveAuthorizationDetailBindings(detail, index, opts);

  return {
    selection: {
      access_mode: detail.access_mode,
      client_claims: detail.client_claims || undefined,
      purpose_code: detail.purpose_code as string,
      purpose_description: isNonEmptyString(detail.purpose_description) ? detail.purpose_description : undefined,
      retention: detail.retention || undefined,
      ...(detail.selection_preset
        ? { selection_preset: detail.selection_preset }
        : { streams: (detail.streams ?? []).map(normalizeStreamSelection) }),
      type: "https://pdpp.dev/data-access",
    },
    source_binding: sourceBinding,
    storage_binding: storageBinding,
  };
}

async function normalizePendingGrantRequest(
  input: Record<string, unknown>,
  opts: InitiateGrantOptions = {}
): Promise<PendingRequest> {
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
  const entry = await normalizeAuthorizationDetail(envelope.authorization_details[0], 0, opts);
  if (
    opts.acceptedProviderNativeRevision &&
    entry.source_binding.id !== opts.acceptedProviderNativeRevision.source.id
  ) {
    invalidGrantInitiationRequest("Accepted provider-native declaration revision does not match the requested source");
  }
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

async function normalizeStagedGrantRequestBatch(
  input: Record<string, unknown>,
  opts: InitiateGrantOptions = {}
): Promise<StagedBatchRequest> {
  const envelope = requireStagedRequestEnvelope(input);
  const clientId = envelope.client_id;
  const entries = await Promise.all(
    envelope.authorization_details.map((detail, index) => normalizeAuthorizationDetail(detail, index, opts))
  );
  if (opts.acceptedProviderNativeRevision) {
    const acceptedSourceId = opts.acceptedProviderNativeRevision.source.id;
    const acceptedSourceCount = entries.filter((entry) => entry.source_binding.id === acceptedSourceId).length;
    if (acceptedSourceCount === 0) {
      invalidGrantInitiationRequest(
        "Accepted provider-native declaration revision does not match any requested source"
      );
    }
    if (acceptedSourceCount > 1) {
      invalidGrantInitiationRequest(
        "One accepted provider-native declaration revision can authorize only one staged source"
      );
    }
  }
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
  const snapshot = request.source_declaration_snapshot;
  return {
    access_mode: request.selection?.access_mode || null,
    purpose_code: request.selection?.purpose_code || null,
    source: describeSourceBinding(getRequestSourceBinding(request)),
    stream_names: (request.selection?.streams || []).map((stream) => stream.name),
    ...(isRecord(snapshot)
      ? {
          source_declaration_snapshot: {
            declaration_version: snapshot.declaration_version,
            snapshot_version: snapshot.snapshot_version,
            source: snapshot.source,
          },
        }
      : {}),
    user_code: pending.user_code,
  };
}

function buildResolvedSnapshotEvidence(
  request: Partial<PendingRequest>,
  resolvedStreams: ResolvedGrantStream[]
): Record<string, unknown> {
  const snapshot = readRetainedSourceDeclarationSnapshot(request);
  return {
    resolved_streams: resolvedStreams.map((stream) => ({
      fields: [...(stream.fields ?? [])],
      instance_ids: [...stream.instance_ids],
      name: stream.name,
      ...(stream.resources ? { resources: cloneJson(stream.resources) } : {}),
      ...(stream.time_constraint ? { time_constraint: cloneJson(stream.time_constraint) } : {}),
    })),
    source_declaration_snapshot: {
      ...(snapshot.accepted_revision_reference
        ? { accepted_revision_reference: snapshot.accepted_revision_reference }
        : {}),
      declaration: snapshot.declaration,
      declaration_version: snapshot.declaration_version,
      ...(snapshot.publisher_attribution ? { publisher_attribution: snapshot.publisher_attribution } : {}),
      ...(snapshot.resource_authority ? { resource_authority: snapshot.resource_authority } : {}),
      snapshot_version: snapshot.snapshot_version,
      source: snapshot.source,
    },
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

function requirePendingSelectionSelector(selection: GrantSelection): void {
  const hasStreams = Array.isArray(selection.streams) && selection.streams.length > 0;
  const hasPreset = isNonEmptyString(selection.selection_preset);
  if (hasStreams === hasPreset) {
    throw bindingError("invalid_request", "selection must include exactly one of streams or selection_preset");
  }
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
  if (request.selection.type !== "https://pdpp.dev/data-access") {
    throw bindingError("invalid_request", "selection.type must be https://pdpp.dev/data-access");
  }
  requirePendingSelectionSelector(request.selection as unknown as GrantSelection);
  if (!isNonEmptyString(request.selection.access_mode)) {
    throw bindingError("invalid_request", "selection.access_mode is required");
  }
  const selectedStreams = Array.isArray(request.selection.streams) ? request.selection.streams : [];
  for (const stream of selectedStreams) {
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

async function resolveEligibleInstanceIdsForApproval(
  streams: StreamSelection[],
  sourceBinding: SourceBinding,
  storageBinding: StorageBinding,
  subjectId: string,
  opts: { acceptedRevisionFulfillment?: boolean } = {}
): Promise<StreamSelection[]> {
  const connectorInstanceStore = isPostgresStorageBackend()
    ? createPostgresConnectorInstanceStore()
    : createSqliteConnectorInstanceStore();
  const configuredFulfillment = opts.acceptedRevisionFulfillment
    ? isConfiguredStorageFulfillment(storageBinding)
    : isConfiguredFulfillment(sourceBinding, storageBinding);
  const configuredDefaultInstanceId = configuredFulfillment
    ? makeDefaultAccountConnectorInstanceId(subjectId, storageBinding.connector_id)
    : null;
  const explicitIds = Array.from(new Set(streams.flatMap((stream) => stream.instance_ids ?? [])));
  const explicitBindings = await Promise.all(
    explicitIds.map(async (connectorInstanceId) => {
      try {
        const binding = await resolveOwnerConnectorInstanceNamespace({
          allowDefaultAccount: false,
          connectorId: storageBinding.connector_id,
          connectorInstanceId,
          connectorInstanceStore,
          ownerSubjectId: subjectId,
        });
        return [connectorInstanceId, binding.connectorInstanceId] as const;
      } catch (error) {
        if (configuredDefaultInstanceId === connectorInstanceId) {
          return [connectorInstanceId, connectorInstanceId] as const;
        }
        if (configuredFulfillment) {
          throw bindingError(
            "invalid_request",
            `Configured source instance_ids must equal its configured local instance '${configuredDefaultInstanceId}'`
          );
        }
        throw error;
      }
    })
  );
  const eligibleInstanceIds = new Set(explicitBindings.map(([, instanceId]) => instanceId));
  if (streams.some((stream) => (stream.instance_ids ?? []).length === 0)) {
    const activeBindings = await connectorInstanceStore.listActiveByConnector(subjectId, storageBinding.connector_id, {
      limit: 2,
    });
    if (activeBindings.length === 0 && configuredDefaultInstanceId) {
      eligibleInstanceIds.add(configuredDefaultInstanceId);
    } else {
      for (const binding of activeBindings) {
        eligibleInstanceIds.add(binding.connectorInstanceId);
      }
    }
  }
  return resolveCoreEligibleInstanceIds({
    eligibleInstanceIdsByStream: Object.fromEntries(streams.map((stream) => [stream.name, [...eligibleInstanceIds]])),
    streams,
  }) as StreamSelection[];
}

function projectResolvedGrantStreams(streams: StreamSelection[]): ResolvedGrantStream[] {
  return coreProjectResolvedGrantStreams(streams) as ResolvedGrantStream[];
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

function buildUnsupportedLegacyAuthorizationStateError(): AuthError {
  const err: AuthError = new Error("Persisted authorization state predates PDPP 0.1.0; fresh consent is required");
  err.code = "authorization_state.unsupported_legacy_shape";
  return err;
}

function isUnsupportedLegacyGrantShape(grant: DbRow): boolean {
  if (grant.version !== "0.1.0" || !isRecord(grant.source_declaration) || !Array.isArray(grant.streams)) {
    return true;
  }
  return grant.streams.some(
    (stream) => !(isRecord(stream) && Array.isArray(stream.instance_ids) && Array.isArray(stream.fields))
  );
}

function requireClosedResolvedGrant(grant: unknown, code: "grant_invalid" | "invalid_request"): DbRow {
  const candidate = cloneJson(grant);
  if (!validateResolvedGrantContract(candidate)) {
    throw bindingError(code, `Resolved grant is invalid: ${contractValidationMessage(validateResolvedGrantContract)}`);
  }
  const resolved = candidate as DbRow;
  if (resolved.version !== "0.1.0") {
    throw bindingError(code, "Resolved grant version is unsupported; fresh consent is required");
  }
  const streams = resolved.streams ?? [];
  const streamNames = streams.map((stream) => stream.name);
  if (new Set(streamNames).size !== streamNames.length) {
    throw bindingError(code, "Resolved grant stream names must be unique");
  }
  for (const stream of streams) {
    const constraint = isRecord(stream.time_constraint) ? stream.time_constraint : null;
    if (
      constraint &&
      isNonEmptyString(constraint.since) &&
      isNonEmptyString(constraint.until) &&
      Date.parse(constraint.since) > Date.parse(constraint.until)
    ) {
      throw bindingError(code, `Resolved stream '${stream.name}' time_constraint.since must not follow until`);
    }
  }
  return resolved;
}

function requirePersistedGrantColumnBindings(
  grant: DbRow,
  row: DbRow,
  code: "grant_invalid" | "invalid_request",
  tokenBinding?: { clientId: unknown; expiresAt: unknown; grantId: unknown; subjectId: unknown }
): void {
  const client = isRecord(grant.client) ? grant.client : null;
  const subject = isRecord(grant.subject) ? grant.subject : null;
  const persistedGrantId = row.persisted_grant_id;
  const persistedSubjectId = row.grant_subject_id;
  const persistedClientId = row.grant_client_id;
  const persistedAccessMode = row.grant_access_mode;
  const persistedExpiresAt = row.grant_expires_at ?? null;
  if (
    !(
      isNonEmptyString(persistedGrantId) &&
      isNonEmptyString(persistedSubjectId) &&
      isNonEmptyString(persistedClientId) &&
      isNonEmptyString(persistedAccessMode)
    ) ||
    grant.grant_id !== persistedGrantId ||
    client?.client_id !== persistedClientId ||
    subject?.id !== persistedSubjectId ||
    grant.access_mode !== persistedAccessMode ||
    (grant.expires_at ?? null) !== persistedExpiresAt
  ) {
    throw bindingError(code, "Resolved grant does not match its persisted grant binding");
  }
  const tokenExpiresAt = tokenBinding?.expiresAt ?? null;
  const tokenExpiryMillis = isNonEmptyString(tokenExpiresAt) ? Date.parse(tokenExpiresAt) : Number.NaN;
  const grantExpiryMillis = isNonEmptyString(persistedExpiresAt) ? Date.parse(persistedExpiresAt) : Number.NaN;
  const tokenExpiryViolatesGrant =
    (tokenExpiresAt !== null && !Number.isFinite(tokenExpiryMillis)) ||
    (persistedExpiresAt !== null &&
      (tokenExpiresAt === null || !Number.isFinite(grantExpiryMillis) || tokenExpiryMillis > grantExpiryMillis));
  if (
    tokenBinding &&
    (tokenBinding.grantId !== persistedGrantId ||
      tokenBinding.subjectId !== persistedSubjectId ||
      tokenBinding.clientId !== persistedClientId ||
      tokenExpiryViolatesGrant)
  ) {
    throw bindingError(code, "Token binding does not match its persisted grant");
  }
}

// The accepted resolved grant, not a mutable manifest, is authoritative.
export function requireGrantContractAgainstManifest(grant: DbRow = {}, _manifest: DbRow = {}): void {
  requireClosedResolvedGrant(grant, "grant_invalid");
}

function resolvePendingRequestAgainstSnapshot(request: Partial<PendingRequest> = {}): StreamSelection[] {
  const snapshot = readRetainedSourceDeclarationSnapshot(request);
  return cloneJson(snapshot.resolved_streams);
}

async function resolveSnapshotStreamsForApproval(
  streams: StreamSelection[],
  sourceBinding: SourceBinding,
  storageBinding: StorageBinding,
  subjectId: string,
  opts: { acceptedRevisionFulfillment?: boolean } = {}
): Promise<ResolvedGrantStream[]> {
  const eligibleStreams = await resolveEligibleInstanceIdsForApproval(
    streams,
    sourceBinding,
    storageBinding,
    subjectId,
    opts
  );
  return projectResolvedGrantStreams(eligibleStreams);
}

function resolvePendingRequestForApproval(
  request: Partial<PendingRequest>,
  sourceBinding: SourceBinding,
  storageBinding: StorageBinding,
  subjectId: string
): Promise<ResolvedGrantStream[]> {
  const snapshot = readRetainedSourceDeclarationSnapshot(request);
  return resolveSnapshotStreamsForApproval(
    cloneJson(snapshot.resolved_streams),
    sourceBinding,
    storageBinding,
    subjectId,
    { acceptedRevisionFulfillment: Boolean(snapshot.accepted_revision_reference) }
  );
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
    if (isUnsupportedLegacyGrantShape(parsedGrant)) {
      throw buildUnsupportedLegacyAuthorizationStateError();
    }
    const grant = requireClosedResolvedGrant(parsedGrant, "grant_invalid");
    let tokenBinding: { clientId: unknown; expiresAt: unknown; grantId: unknown; subjectId: unknown } | undefined;
    if (row.token_kind === "client") {
      tokenBinding = {
        clientId: row.client_id,
        expiresAt: row.expires_at ?? null,
        grantId: row.grant_id,
        subjectId: row.subject_id,
      };
    } else if (isNonEmptyString(row.token_grant_id)) {
      tokenBinding = {
        clientId: row.token_client_id,
        expiresAt: row.token_expires_at ?? null,
        grantId: row.token_grant_id,
        subjectId: row.token_subject_id,
      };
    }
    requirePersistedGrantColumnBindings(grant, row, "grant_invalid", tokenBinding);
    const bindings = requireStructuredGrantBindings(grant, readPersistedGrantStorageBinding(row));
    grant.source = describeSourceBinding(bindings.sourceBinding);
    return {
      grant,
      sourceBinding: bindings.sourceBinding,
      storageBinding: bindings.storageBinding,
    };
  } catch (cause: unknown) {
    if (isAuthError(cause) && cause.code === "authorization_state.unsupported_legacy_shape") {
      throw cause;
    }
    const err = buildGrantInvalidError();
    err.cause = cause;
    throw err;
  }
}

export function requireResolvedPersistedGrantState(
  row: DbRow = {},
  _opts: { nativeManifest?: DbRow | null } = {}
): { grant: DbRow; sourceBinding: SourceBinding; storageBinding: StorageBinding } {
  try {
    const { grant, sourceBinding, storageBinding } = requirePersistedGrantState(row);
    return {
      grant,
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
              approved_at, denied_at, interval_seconds, last_polled_at,
              approval_review_revision, approval_review_digest, approval_review_json::text AS approval_review_json,
              approval_id
       FROM pending_consents
       WHERE approval_id = $1`,
      [approvalId]
    ),
  getByDeviceCode: (deviceCode) =>
    pgOne<PendingConsentRow>(
      `SELECT device_code, user_code, params_json::text AS params_json, status,
              subject_id, grant_id, token_id, ai_training_consented,
              request_id, trace_id, scenario_id, created_at, expires_at,
              approved_at, denied_at, interval_seconds, last_polled_at,
              approval_review_revision, approval_review_digest, approval_review_json::text AS approval_review_json,
              approval_id
       FROM pending_consents
       WHERE device_code = $1`,
      [deviceCode]
    ),
  insert: ({ deviceCode, userCode, paramsJson, traceContext, createdAt, expiresAt, approvalId }) =>
    pgExec(
      `INSERT INTO pending_consents(
         device_code, user_code, params_json, status,
         request_id, trace_id, scenario_id, created_at, expires_at, approval_id
       ) VALUES($1, $2, $3::jsonb, 'pending', $4, $5, $6, $7, $8, $9)`,
      [
        deviceCode,
        userCode,
        paramsJson,
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
  markDeniedAtomically: ({ deviceCode, deniedAt, event, faultHook }) =>
    withPostgresTransaction(async (client) => {
      const result = await client.query(
        `UPDATE pending_consents
         SET status = 'denied', denied_at = $1
         WHERE device_code = $2 AND status = 'pending'
         RETURNING device_code`,
        [deniedAt, deviceCode]
      );
      if (result.rowCount !== 1) {
        const err: AuthError = new Error("Pending consent approval conflict");
        err.code = "approval_conflict";
        throw err;
      }
      await faultHook?.("after_cas_before_event");
      await postgresEmitSpineEventInTransaction(client, event as SpineEventInput);
      await faultHook?.("after_event_before_commit");
      return { changes: 1 };
    }),
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
  insert: ({ deviceCode, userCode, paramsJson, traceContext, createdAt, expiresAt, approvalId }) =>
    exec(referenceQueries.authPendingConsentsInsert, [
      deviceCode,
      userCode,
      paramsJson,
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
  markDeniedAtomically: ({ deviceCode, deniedAt, event, faultHook }) =>
    writeTransaction(() => {
      const result = exec(referenceQueries.authPendingConsentsMarkDenied, [deniedAt, deviceCode]);
      if (result.changes !== 1) {
        const err: AuthError = new Error("Pending consent approval conflict");
        err.code = "approval_conflict";
        throw err;
      }
      faultHook?.("after_cas_before_event");
      emitRawSpineEvent(event as SpineEventInput, getDb());
      faultHook?.("after_event_before_commit");
      return result;
    }),
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

function buildOwnerDeviceUnavailableError(row: OwnerDeviceAuthRow): AuthError {
  return attachOwnerDeviceTraceContext(
    Object.assign(new Error("Owner device authorization is not available"), {
      code: "not_found",
    }),
    row
  );
}

function buildOwnerDeviceApprovalConflictError(row: OwnerDeviceAuthRow): AuthError {
  return attachOwnerDeviceTraceContext(
    Object.assign(new Error("Pending consent approval conflict"), {
      code: "approval_conflict",
    }),
    row
  );
}

function requireOwnerDeviceApprovedSubject(row: OwnerDeviceAuthRow, subjectId: string): void {
  if (row.subject_id === subjectId) {
    return;
  }
  throw buildOwnerDeviceUnavailableError(row);
}

function requireOwnerDevicePendingForApproval(row: OwnerDeviceAuthRow, input: OwnerDeviceApprovalInput): void {
  if (
    row.client_id !== input.clientId ||
    input.clientId !== input.pendingSnapshot.client_id ||
    row.user_code !== input.pendingSnapshot.user_code ||
    row.approval_id !== input.pendingSnapshot.approval_id
  ) {
    throw buildOwnerDeviceUnavailableError(row);
  }
}

function buildOwnerDeviceExpiredError(row: OwnerDeviceAuthRow): AuthError {
  return attachOwnerDeviceTraceContext(
    Object.assign(new Error("Owner device authorization has expired"), {
      code: "not_found",
    }),
    row
  );
}

function isOwnerDeviceExpiredError(err: unknown): err is AuthError {
  return isAuthError(err) && err.code === "not_found" && err.message === "Owner device authorization has expired";
}

function requireDynamicClientSubject(registeredClient: RegisteredClient, subjectId: string): RegisteredClient {
  const existingSubject =
    registeredClient.registration_mode === "dynamic" ? registeredClient.metadata.issuer_subject_id || null : null;
  if (existingSubject && existingSubject !== subjectId) {
    const err: AuthError = new Error("Dynamic client is bound to a different owner subject");
    err.code = "forbidden";
    throw err;
  }
  return registeredClient;
}

const postgresOwnerDeviceAuthStore: OwnerDeviceAuthStore = {
  approveAtomically: (input) =>
    withPostgresTransaction(async (client) => {
      const existing = await client.query<OwnerDeviceAuthRow>(
        `SELECT *
         FROM owner_device_auth
         WHERE device_code = $1
         FOR UPDATE`,
        [input.deviceCode]
      );
      const [row] = existing.rows;
      if (!row) {
        const err: AuthError = new Error("Unknown user code");
        err.code = "not_found";
        throw err;
      }
      if (row.status === "approved" && row.token_id) {
        requireOwnerDeviceApprovedSubject(row, input.subjectId);
        return row;
      }
      if (row.status === "denied") {
        throw buildOwnerDeviceApprovalConflictError(row);
      }
      if (row.status !== "pending") {
        throw buildOwnerDeviceUnavailableError(row);
      }
      requireOwnerDevicePendingForApproval(row, input);
      if (isExpired(row)) {
        throw buildOwnerDeviceExpiredError(row);
      }
      const clientRowResult = await client.query<RegisteredClientRow>(
        `SELECT client_id, registration_mode, token_endpoint_auth_method,
                client_secret, metadata_json::text AS metadata_json, created_at, updated_at
         FROM oauth_clients
         WHERE client_id = $1
         FOR UPDATE`,
        [input.clientId]
      );
      const registeredClient = mapRegisteredClientRow(clientRowResult.rows[0] ?? null);
      if (!registeredClient) {
        throw ownerDeviceExchangeError(row, "invalid_client", `Unknown client_id: ${input.clientId}`);
      }
      requireDynamicClientSubject(registeredClient, input.subjectId);
      if (registeredClient.registration_mode === "dynamic" && !registeredClient.metadata.issuer_subject_id) {
        await client.query(
          `UPDATE oauth_clients
           SET metadata_json = $2::jsonb,
               updated_at = $3
           WHERE client_id = $1`,
          [
            registeredClient.client_id,
            JSON.stringify({ ...registeredClient.metadata, issuer_subject_id: input.subjectId }),
            nowIso(),
          ]
        );
      }
      input.faultHook?.("before_token_insert");
      await client.query(
        `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
         VALUES($1, NULL, $2, $3, 'owner', $4)`,
        [input.tokenId, input.subjectId, input.clientId, input.expiresAt]
      );
      input.faultHook?.("after_token_insert");
      await postgresEmitSpineEventInTransaction(client, input.consentApprovedEvent as SpineEventInput);
      await postgresEmitSpineEventInTransaction(client, input.tokenIssuedEvent as SpineEventInput);
      const approved = await client.query<OwnerDeviceAuthRow>(
        `UPDATE owner_device_auth
         SET status = 'approved',
             subject_id = $2,
             token_id = $3,
             approved_at = $4
         WHERE device_code = $1
           AND status = 'pending'
        RETURNING *`,
        [input.deviceCode, input.subjectId, input.tokenId, nowIso()]
      );
      const [approvedRow] = approved.rows;
      return approvedRow as OwnerDeviceAuthRow;
    }),
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
  markDeniedAtomically: ({ deviceCode, deniedAt, event, faultHook }) =>
    withPostgresTransaction(async (client) => {
      const result = await client.query(
        `UPDATE owner_device_auth
         SET status = 'denied', denied_at = $1
         WHERE device_code = $2 AND status = 'pending'
         RETURNING device_code`,
        [deniedAt, deviceCode]
      );
      if (result.rowCount !== 1) {
        const err: AuthError = new Error("Pending consent approval conflict");
        err.code = "approval_conflict";
        throw err;
      }
      await faultHook?.("after_cas_before_event");
      await postgresEmitSpineEventInTransaction(client, event as SpineEventInput);
      await faultHook?.("after_event_before_commit");
      return { changes: 1 };
    }),
  markExpired: ({ deviceCode }) =>
    pgExec("UPDATE owner_device_auth SET status = 'expired' WHERE device_code = $1 AND status = 'pending'", [
      deviceCode,
    ]),
  updateLastPolled: ({ deviceCode, polledAt }) =>
    pgExec("UPDATE owner_device_auth SET last_polled_at = $1 WHERE device_code = $2", [polledAt, deviceCode]),
};

const sqliteOwnerDeviceAuthStore: OwnerDeviceAuthStore = {
  approveAtomically: (input) =>
    transaction(() => {
      const row = getOne<OwnerDeviceAuthRow>(referenceQueries.authOwnerDeviceAuthGetByDeviceCode, [input.deviceCode]);
      if (!row) {
        const err: AuthError = new Error("Unknown user code");
        err.code = "not_found";
        throw err;
      }
      if (row.status === "approved" && row.token_id) {
        requireOwnerDeviceApprovedSubject(row, input.subjectId);
        return row;
      }
      if (row.status === "denied") {
        throw buildOwnerDeviceApprovalConflictError(row);
      }
      if (row.status !== "pending") {
        throw buildOwnerDeviceUnavailableError(row);
      }
      requireOwnerDevicePendingForApproval(row, input);
      if (isExpired(row)) {
        throw buildOwnerDeviceExpiredError(row);
      }
      const registeredClient = mapRegisteredClientRow(
        getOne<RegisteredClientRow>(referenceQueries.authOauthClientsGetByClientId, [input.clientId])
      );
      if (!registeredClient) {
        throw ownerDeviceExchangeError(row, "invalid_client", `Unknown client_id: ${input.clientId}`);
      }
      requireDynamicClientSubject(registeredClient, input.subjectId);
      if (registeredClient.registration_mode === "dynamic" && !registeredClient.metadata.issuer_subject_id) {
        exec(referenceQueries.authOauthClientsUpsert, [
          registeredClient.client_id,
          registeredClient.registration_mode,
          registeredClient.token_endpoint_auth_method,
          registeredClient.client_secret,
          JSON.stringify({ ...registeredClient.metadata, issuer_subject_id: input.subjectId }),
          registeredClient.created_at || nowIso(),
          nowIso(),
        ]);
      }
      input.faultHook?.("before_token_insert");
      exec(referenceQueries.authTokensInsertOwner, [input.tokenId, input.subjectId, input.clientId, input.expiresAt]);
      input.faultHook?.("after_token_insert");
      emitRawSpineEvent(input.consentApprovedEvent as SpineEventInput, getDb());
      emitRawSpineEvent(input.tokenIssuedEvent as SpineEventInput, getDb());
      exec(referenceQueries.authOwnerDeviceAuthMarkApproved, [
        input.subjectId,
        input.tokenId,
        nowIso(),
        input.deviceCode,
      ]);
      return {
        ...row,
        status: "approved",
        subject_id: input.subjectId,
        token_id: input.tokenId,
      };
    }),
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
  markDeniedAtomically: ({ deviceCode, deniedAt, event, faultHook }) =>
    writeTransaction(() => {
      const result = exec(referenceQueries.authOwnerDeviceAuthMarkDenied, [deniedAt, deviceCode]);
      if (result.changes !== 1) {
        const err: AuthError = new Error("Pending consent approval conflict");
        err.code = "approval_conflict";
        throw err;
      }
      faultHook?.("after_cas_before_event");
      emitRawSpineEvent(event as SpineEventInput, getDb());
      faultHook?.("after_event_before_commit");
      return result;
    }),
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
  listBySourceId: async (sourceId) =>
    (
      await postgresQuery<DbRow>(
        `SELECT connector_id, manifest::text AS manifest
           FROM connectors
          WHERE manifest #>> '{source_declaration,source,id}' = $1
          ORDER BY connector_id ASC
          LIMIT 2`,
        [sourceId]
      )
    ).rows,
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
  listBySourceId: (sourceId) =>
    getDb()
      .prepare(
        `SELECT connector_id, manifest
           FROM connectors
          WHERE json_extract(manifest, '$.source_declaration.source.id') = ?
          ORDER BY connector_id ASC
          LIMIT 2`
      )
      .all<DbRow>(sourceId),
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

function serializePendingConsentParams(params: PendingRequest | StagedBatchRequest): string {
  if (isStagedBatchRequest(params)) {
    for (const entry of params.entries) {
      readRetainedSourceDeclarationSnapshot(asSingleEntryRequestSlice(params, entry));
    }
  } else {
    readRetainedSourceDeclarationSnapshot(params);
  }
  return JSON.stringify(cloneJson(params));
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
  const paramsJson = serializePendingConsentParams(params);
  await getPendingConsentStore().insert({
    approvalId,
    createdAt,
    deviceCode,
    expiresAt,
    paramsJson,
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

function buildConsentApprovedEventInput({
  deviceCode,
  pending,
  registeredClient,
  request,
  resolvedStreams,
  sourceBinding,
  subjectId,
  traceContext,
  grantId,
}: {
  deviceCode: string;
  pending: PendingConsentRow;
  registeredClient: RegisteredClient;
  request: PendingRequest;
  resolvedStreams: ResolvedGrantStream[];
  sourceBinding: SourceBinding;
  subjectId: string;
  traceContext: TraceContext;
  grantId: string;
}): AuthSpineEventInput {
  return {
    actor_id: subjectId,
    actor_type: "subject",
    client_id: registeredClient.client_id,
    data: {
      source: describeSourceBinding(sourceBinding),
      ...buildResolvedSnapshotEvidence(request, resolvedStreams),
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
  };
}

function buildGrantIssuedEventInput({
  grant,
  grantId,
  registeredClient,
  request,
  resolvedStreams,
  selection,
  subjectId,
  traceContext,
}: {
  grant: GrantEnvelope;
  grantId: string;
  registeredClient: RegisteredClient;
  request: PendingRequest;
  resolvedStreams: ResolvedGrantStream[];
  selection: GrantSelection;
  subjectId: string;
  traceContext: TraceContext;
}): AuthSpineEventInput {
  return {
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: registeredClient.client_id,
    data: {
      access_mode: selection.access_mode,
      purpose_code: selection.purpose_code,
      retention: selection.retention ?? null,
      source: describeGrantSource(grant),
      ...buildResolvedSnapshotEvidence(request, resolvedStreams),
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
  };
}

function buildTokenIssuedEventInput({
  clientId,
  grant,
  grantId,
  subjectId,
  tokenId,
  traceContext,
}: {
  clientId: string;
  grant: GrantEnvelope;
  grantId: string;
  subjectId: string;
  tokenId: string;
  traceContext: TraceContext;
}): AuthSpineEventInput {
  return {
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: clientId,
    data: {
      issuance_path: "grant_approval",
      source: describeGrantSource(grant),
      token_kind: "client",
    },
    event_type: "token.issued",
    grant_id: grantId,
    object_id: tokenId,
    object_type: "token",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    token_id: tokenId,
    trace_id: traceContext.trace_id,
  };
}

function canonicalApprovalReviewJson(value: unknown): string {
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

function normalizeApprovalReviewClientClaims(raw: unknown): { commitments: string[] } | null {
  if (!isRecord(raw)) {
    return null;
  }
  const commitments = Array.isArray(raw.commitments)
    ? raw.commitments.filter((value): value is string => typeof value === "string" && value.trim() !== "")
    : [];
  return commitments.length > 0 ? { commitments } : null;
}

function buildApprovalReviewArtifact(input: {
  aiTrainingConsented: boolean | null;
  client: unknown;
  expiresAt: string | null;
  request: PendingRequest;
  resolvedStreams: ResolvedGrantStream[] | StreamSelection[];
  subjectId: string;
}): { artifactJson: string; digest: string; revision: string } {
  const { request } = input;
  const snapshot = readRetainedSourceDeclarationSnapshot(request);
  const { selection } = request;
  const artifact = {
    access_mode: selection.access_mode,
    ai_training_consented: input.aiTrainingConsented,
    client: input.client,
    client_claims: normalizeApprovalReviewClientClaims(selection.client_claims),
    expires_at: input.expiresAt,
    purpose_code: selection.purpose_code,
    purpose_description: selection.purpose_description ?? null,
    resolved_streams: input.resolvedStreams,
    retention: selection.retention ?? null,
    selection_preset: selection.selection_preset ?? null,
    source: describeSourceBinding(request.source_binding),
    source_declaration: buildApprovalReviewSourceDeclaration(snapshot),
    subject: { id: input.subjectId },
    version: "reference.approval-review.v1",
  };
  const artifactJson = canonicalApprovalReviewJson(artifact);
  const digest = `sha256:${base64UrlSha256(artifactJson)}`;
  return { artifactJson, digest, revision: `reference.approval-review.v1:${digest}` };
}

function buildApprovalReviewSourceDeclaration(snapshot: SourceDeclarationSnapshot): Record<string, unknown> {
  return {
    ...(snapshot.accepted_revision_reference
      ? { accepted_revision_reference: snapshot.accepted_revision_reference }
      : {}),
    digest: `sha256:${base64UrlSha256(canonicalApprovalReviewJson(snapshot.declaration))}`,
    ...(snapshot.publisher_attribution ? { publisher_attribution: snapshot.publisher_attribution } : {}),
    ...(snapshot.resource_authority ? { resource_authority: snapshot.resource_authority } : {}),
    version: snapshot.declaration_version,
  };
}

function buildBatchApprovalReviewArtifact(input: {
  approvedIndexes: number[];
  client: unknown;
  entries: {
    index: number;
    request: PendingRequest;
    resolvedStreams: ResolvedGrantStream[] | StreamSelection[];
  }[];
  expiresAt: string | null;
  parentPackageId: string | null;
  sourceNarrowing: Record<string, unknown>;
  subjectId: string;
}): { artifactJson: string; digest: string; revision: string } {
  const [firstEntry] = input.entries;
  const artifact = {
    access_mode: firstEntry ? firstEntry.request.selection.access_mode : null,
    approved_source_indexes: input.approvedIndexes,
    client: input.client,
    expires_at: input.expiresAt,
    parent_package_id: input.parentPackageId,
    source_narrowing: input.sourceNarrowing,
    sources: input.entries.map(({ index, request, resolvedStreams }) => {
      const snapshot = readRetainedSourceDeclarationSnapshot(request);
      return {
        access_mode: request.selection.access_mode,
        client_claims: normalizeApprovalReviewClientClaims(request.selection.client_claims),
        index,
        purpose_code: request.selection.purpose_code,
        purpose_description: request.selection.purpose_description ?? null,
        resolved_streams: resolvedStreams,
        retention: request.selection.retention ?? null,
        selection_preset: request.selection.selection_preset ?? null,
        source: describeSourceBinding(request.source_binding),
        source_declaration: buildApprovalReviewSourceDeclaration(snapshot),
      };
    }),
    subject: { id: input.subjectId },
    version: "reference.batch-approval-review.v1",
  };
  const artifactJson = canonicalApprovalReviewJson(artifact);
  const digest = `sha256:${base64UrlSha256(artifactJson)}`;
  return { artifactJson, digest, revision: `reference.batch-approval-review.v1:${digest}` };
}

async function persistApprovalReviewArtifact(input: {
  deviceCode: string;
  artifactJson: string;
  digest: string;
  revision: string;
}): Promise<void> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `UPDATE pending_consents
          SET approval_review_revision = $2,
              approval_review_digest = $3,
              approval_review_json = $4::jsonb
        WHERE device_code = $1
          AND status = 'pending'`,
      [input.deviceCode, input.revision, input.digest, input.artifactJson]
    );
    if (result.rowCount !== 1) {
      const err: AuthError = new Error("Pending consent approval conflict");
      err.code = "approval_conflict";
      throw err;
    }
    return;
  }
  const result = execDynamicSqlAcknowledged(
    `UPDATE pending_consents
        SET approval_review_revision = ?,
            approval_review_digest = ?,
            approval_review_json = ?
      WHERE device_code = ?
        AND status = 'pending'`,
    [input.revision, input.digest, input.artifactJson, input.deviceCode]
  );
  if (result.changes !== 1) {
    const err: AuthError = new Error("Pending consent approval conflict");
    err.code = "approval_conflict";
    throw err;
  }
}

function requireMatchingApprovalReview(
  row: PendingConsentRow,
  revision: unknown
): {
  aiTrainingConsented: boolean | null;
  expiresAt: string | null;
  resolvedStreams: ResolvedGrantStream[];
  subjectId: string;
} {
  if (!isNonEmptyString(revision)) {
    throw bindingError("invalid_request", "approval_review_revision is required");
  }
  if (!(isNonEmptyString(row.approval_review_revision) && isNonEmptyString(row.approval_review_json))) {
    throw bindingError("invalid_request", "Pending consent must be reviewed again before approval");
  }
  if (revision !== row.approval_review_revision) {
    throw bindingError("invalid_request", "Pending consent review is stale");
  }
  const parsed = parsePersistedApprovalReviewRow(row);
  if (!(isRecord(parsed.subject) && isNonEmptyString(parsed.subject.id))) {
    throw bindingError("invalid_request", "Pending consent review subject is malformed; review the request again");
  }
  return {
    aiTrainingConsented: typeof parsed.ai_training_consented === "boolean" ? parsed.ai_training_consented : null,
    expiresAt: typeof parsed.expires_at === "string" ? parsed.expires_at : null,
    resolvedStreams: parsed.resolved_streams as ResolvedGrantStream[],
    subjectId: parsed.subject.id,
  };
}

function persistedBatchReviewOptions(row: PendingConsentRow): ApproveStagedGrantBatchOptions {
  if (!isNonEmptyString(row.approval_review_json)) {
    throw bindingError("invalid_request", "Pending consent must be reviewed again before approval");
  }
  const parsed = parsePersistedApprovalReviewRow(row);
  requireBatchApprovalReviewArtifact(parsed);
  return {
    approvedSourceIndexes: parsed.approved_source_indexes.map((index) => Number(index)),
    reviewExpiresAt: typeof parsed.expires_at === "string" ? parsed.expires_at : null,
    sourceNarrowing: isRecord(parsed.source_narrowing) ? parsed.source_narrowing : {},
  };
}

function parsePersistedApprovalReview(raw: string): Record<string, unknown> & { subject?: { id?: unknown } } {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error("approval review must be an object");
    }
    requirePersistedApprovalReviewShape(parsed);
    return parsed as Record<string, unknown> & { subject?: { id?: unknown } };
  } catch (err: unknown) {
    if (isAuthError(err) && err.code) {
      throw err;
    }
    throw bindingError("invalid_request", "Pending consent review is malformed; review the request again");
  }
}

function parsePersistedApprovalReviewRow(
  row: PendingConsentRow
): Record<string, unknown> & { subject?: { id?: unknown } } {
  if (!(isNonEmptyString(row.approval_review_json) && isNonEmptyString(row.approval_review_digest))) {
    throw bindingError("invalid_request", "Pending consent must be reviewed again before approval");
  }
  const parsed = parsePersistedApprovalReview(row.approval_review_json);
  const artifactJson = canonicalApprovalReviewJson(parsed);
  const digest = `sha256:${base64UrlSha256(artifactJson)}`;
  const version = typeof parsed.version === "string" ? parsed.version : null;
  if (digest !== row.approval_review_digest || !version || `${version}:${digest}` !== row.approval_review_revision) {
    throw bindingError("invalid_request", "Pending consent review is stale");
  }
  const validation = validateResponse("reviewConsent", {
    body: {
      approval_review: parsed,
      approval_review_revision: row.approval_review_revision,
      batch: version === "reference.batch-approval-review.v1",
      request_uri: "urn:pdpp:pending-consent:review-validation",
    },
    status: 200,
  });
  if (validation.ok !== true) {
    throw bindingError("invalid_request", "Pending consent review is malformed; review the request again");
  }
  requireReviewSourceTrustMatchesSourceKind(parsed);
  return parsed;
}

function requireReviewSourceTrustMatchesSourceKind(review: Record<string, unknown>): void {
  const sources = review.version === "reference.batch-approval-review.v1" ? review.sources : [review];
  if (!Array.isArray(sources)) {
    throw bindingError("invalid_request", "Pending consent review is malformed; review the request again");
  }
  for (const item of sources) {
    const source = isRecord(item) && isRecord(item.source) ? item.source : null;
    const declaration = isRecord(item) && isRecord(item.source_declaration) ? item.source_declaration : null;
    if (!(source && declaration)) {
      throw bindingError("invalid_request", "Pending consent review is malformed; review the request again");
    }
    const hasTrust =
      declaration.accepted_revision_reference !== undefined ||
      declaration.publisher_attribution !== undefined ||
      declaration.resource_authority !== undefined;
    if ((source.kind === "provider_native") !== hasTrust) {
      throw bindingError(
        "invalid_request",
        "Pending consent review source authority is malformed; review the request again"
      );
    }
  }
}

function hasPersistedApprovalReview(row: PendingConsentRow): boolean {
  return [row.approval_review_json, row.approval_review_digest, row.approval_review_revision].some(
    (value) => value !== null && value !== undefined
  );
}

async function readValidatedPersistedApprovalReview(deviceCode: string): Promise<{
  artifact: Record<string, unknown> & { subject?: { id?: unknown } };
  artifactJson: string;
  digest: string;
  revision: string;
}> {
  const row = await getPendingConsentRow(deviceCode);
  if (row?.status !== "pending") {
    const err: AuthError = new Error("Pending consent approval conflict");
    err.code = "approval_conflict";
    throw err;
  }
  const artifact = parsePersistedApprovalReviewRow(row);
  if (
    !(
      isNonEmptyString(row.approval_review_json) &&
      isNonEmptyString(row.approval_review_digest) &&
      isNonEmptyString(row.approval_review_revision)
    )
  ) {
    throw bindingError("invalid_request", "Pending consent must be reviewed again before approval");
  }
  return {
    artifact,
    artifactJson: row.approval_review_json,
    digest: row.approval_review_digest,
    revision: row.approval_review_revision,
  };
}

function requirePersistedApprovalReviewShape(parsed: Record<string, unknown>): void {
  const { version } = parsed;
  if (version === "reference.approval-review.v1") {
    if (
      !(
        isRecord(parsed.subject) &&
        isNonEmptyString(parsed.subject.id) &&
        Array.isArray(parsed.resolved_streams) &&
        (typeof parsed.ai_training_consented === "boolean" || parsed.ai_training_consented === null)
      )
    ) {
      throw bindingError("invalid_request", "Pending consent review is malformed; review the request again");
    }
    return;
  }
  if (version === "reference.batch-approval-review.v1") {
    requireBatchApprovalReviewArtifact(parsed);
    return;
  }
  throw bindingError("invalid_request", "Pending consent review is malformed; review the request again");
}

function requireBatchApprovalReviewArtifact(parsed: Record<string, unknown>): asserts parsed is Record<
  string,
  unknown
> & {
  approved_source_indexes: unknown[];
  expires_at?: unknown;
  source_narrowing?: unknown;
  sources: unknown[];
} {
  if (
    parsed.version !== "reference.batch-approval-review.v1" ||
    !Array.isArray(parsed.approved_source_indexes) ||
    !(isRecord(parsed.subject) && isNonEmptyString(parsed.subject.id)) ||
    !Array.isArray(parsed.sources)
  ) {
    throw bindingError("invalid_request", "Pending batch review is malformed; review the request again");
  }
  for (const index of parsed.approved_source_indexes) {
    if (!Number.isInteger(Number(index))) {
      throw bindingError(
        "invalid_request",
        "Pending batch review has invalid source indexes; review the request again"
      );
    }
  }
  for (const source of parsed.sources) {
    if (!(isRecord(source) && Number.isInteger(Number(source.index)) && Array.isArray(source.resolved_streams))) {
      throw bindingError("invalid_request", "Pending batch review has invalid source facts; review the request again");
    }
  }
  if (parsed.source_narrowing !== undefined && !isRecord(parsed.source_narrowing)) {
    throw bindingError("invalid_request", "Pending batch review has invalid narrowing facts; review the request again");
  }
}

function requireNumericObjectKeys(input: Record<string, unknown>, param: string): void {
  for (const key of Object.keys(input)) {
    if (!CANONICAL_NON_NEGATIVE_INTEGER_KEY_RE.test(key)) {
      const err: AuthError = new Error(`${param} key '${key}' must be a staged source index`);
      err.code = "invalid_request";
      err.param = param;
      throw err;
    }
  }
}

interface ReviewedInstanceCheck {
  allowConfiguredFulfillmentDefault: boolean;
  connectorId: string;
  connectorInstanceId: string;
  subjectId: string;
}

function reviewedInstanceChecksForGrant(input: {
  acceptedRevisionFulfillment?: boolean;
  resolvedStreams: ResolvedGrantStream[];
  sourceBinding: SourceBinding;
  storageBinding: StorageBinding;
  subjectId: string;
}): ReviewedInstanceCheck[] {
  const configuredFulfillment = input.acceptedRevisionFulfillment
    ? isConfiguredStorageFulfillment(input.storageBinding)
    : isConfiguredFulfillment(input.sourceBinding, input.storageBinding);
  const configuredDefaultInstanceId = configuredFulfillment
    ? makeDefaultAccountConnectorInstanceId(input.subjectId, input.storageBinding.connector_id)
    : null;
  const seen = new Set<string>();
  const checks: ReviewedInstanceCheck[] = [];
  for (const stream of input.resolvedStreams) {
    for (const connectorInstanceId of stream.instance_ids) {
      const key = `${input.storageBinding.connector_id}\0${connectorInstanceId}\0${input.subjectId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      checks.push({
        allowConfiguredFulfillmentDefault: connectorInstanceId === configuredDefaultInstanceId,
        connectorId: input.storageBinding.connector_id,
        connectorInstanceId,
        subjectId: input.subjectId,
      });
    }
  }
  return checks;
}

function reviewedInstanceChangedError(connectorInstanceId: string): AuthError {
  const err: AuthError = new Error(
    `Reviewed source instance '${connectorInstanceId}' is no longer eligible; review the request again`
  );
  err.code = "invalid_request";
  return err;
}

function coerceAiTrainingConsent(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true" || value === "1" || value === "on") {
    return true;
  }
  if (value === "false" || value === "0" || value === "off") {
    return false;
  }
  const err = bindingError("invalid_request", "ai_training_consented must be a boolean");
  err.param = "ai_training_consented";
  throw err;
}

function requireReviewedAiTrainingConsent(selection: GrantSelection, aiTrainingConsented: boolean | null): void {
  if (selection.purpose_code === "https://pdpp.dev/purpose/ai_training" && aiTrainingConsented !== true) {
    const err: AuthError = new Error("Explicit affirmative consent required for ai_training purpose");
    err.code = "invalid_request";
    err.param = "ai_training_consented";
    throw err;
  }
}

function requireSqliteReviewedInstancesActive(checks: ReviewedInstanceCheck[]): void {
  for (const check of checks) {
    const row = getOne(referenceQueries.authConnectorInstancesGetReviewedActive, [
      check.connectorInstanceId,
      check.connectorId,
      check.subjectId,
    ]);
    if (!row) {
      if (check.allowConfiguredFulfillmentDefault) {
        continue;
      }
      throw reviewedInstanceChangedError(check.connectorInstanceId);
    }
  }
}

async function requirePostgresReviewedInstancesActive(
  client: PostgresTransactionClient,
  checks: ReviewedInstanceCheck[]
): Promise<void> {
  for (const check of checks) {
    // biome-ignore lint/performance/noAwaitInLoops: These row locks are intentionally acquired inside the approval transaction.
    const result = await client.query(
      `SELECT connector_instance_id
         FROM connector_instances
        WHERE connector_instance_id = $1
          AND connector_id = $2
          AND owner_subject_id = $3
          AND status = 'active'
        FOR UPDATE`,
      [check.connectorInstanceId, check.connectorId, check.subjectId]
    );
    if (result.rowCount !== 1) {
      if (check.allowConfiguredFulfillmentDefault) {
        continue;
      }
      throw reviewedInstanceChangedError(check.connectorInstanceId);
    }
  }
}

function requireSqliteParentPackageStillEligible(input: {
  clientId: string;
  parentPackageId: string | null;
  subjectId: string;
}): void {
  if (!input.parentPackageId) {
    return;
  }
  const row = getDb()
    .prepare(
      `SELECT package_id
         FROM grant_packages
        WHERE package_id = ?
          AND client_id = ?
          AND subject_id = ?
          AND status = 'active'`
    )
    .get(input.parentPackageId, input.clientId, input.subjectId);
  if (!row) {
    throw parentPackageChangedError(input.parentPackageId);
  }
}

async function requirePostgresParentPackageStillEligible(
  client: PostgresTransactionClient,
  input: {
    clientId: string;
    parentPackageId: string | null;
    subjectId: string;
  }
): Promise<void> {
  if (!input.parentPackageId) {
    return;
  }
  const result = await client.query(
    `SELECT package_id
       FROM grant_packages
      WHERE package_id = $1
        AND client_id = $2
        AND subject_id = $3
        AND status = 'active'
      FOR UPDATE`,
    [input.parentPackageId, input.clientId, input.subjectId]
  );
  if (result.rowCount !== 1) {
    throw parentPackageChangedError(input.parentPackageId);
  }
}

function parentPackageChangedError(packageId: string): AuthError {
  const err: AuthError = new Error(`parent_package_id ${packageId} is no longer eligible; review the request again`);
  err.code = "invalid_request";
  err.param = "parent_package_id";
  return err;
}

async function persistApprovedSingleGrantAtomically({
  accessMode,
  aiTrainingConsented,
  clientId,
  consentApprovedEvent,
  deviceCode,
  expiresAt,
  grantId,
  grantIssuedEvent,
  grantJson,
  issuedAt,
  persistedStorageBinding,
  subjectId,
  tokenIssuedEvent,
  traceContext,
  reviewedRevision,
  reviewedInstanceChecks,
}: {
  accessMode: string;
  aiTrainingConsented: boolean | null | undefined;
  clientId: string;
  consentApprovedEvent: AuthSpineEventInput;
  deviceCode: string;
  expiresAt: string | null;
  grantId: string;
  grantIssuedEvent: AuthSpineEventInput;
  grantJson: string;
  issuedAt: string;
  persistedStorageBinding: StorageBinding | null;
  subjectId: string;
  tokenIssuedEvent: (tokenId: string) => AuthSpineEventInput;
  traceContext: TraceContext;
  reviewedRevision: string;
  reviewedInstanceChecks: ReviewedInstanceCheck[];
}): Promise<string> {
  const storageBindingJson = serializeStorageBinding(persistedStorageBinding);

  if (isPostgresStorageBackend()) {
    return await withPostgresTransaction(async (client) => {
      const claim = await client.query(
        `UPDATE pending_consents
            SET status = 'approving', subject_id = $2
          WHERE device_code = $1
            AND status = 'pending'
            AND approval_review_revision = $3
          RETURNING device_code`,
        [deviceCode, subjectId, reviewedRevision]
      );
      if (claim.rowCount !== 1) {
        const err: AuthError = new Error("Pending consent approval conflict");
        err.code = "approval_conflict";
        throw err;
      }
      await requirePostgresReviewedInstancesActive(client, reviewedInstanceChecks);

      await client.query(
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
          traceContext.trace_id,
          traceContext.scenario_id ?? null,
        ]
      );
      const { tokenId } = await insertPostgresGrantToken(client, { clientId, expiresAt, grantId, subjectId });
      await postgresEmitSpineEventInTransaction(client, consentApprovedEvent as SpineEventInput);
      await postgresEmitSpineEventInTransaction(client, grantIssuedEvent as SpineEventInput);
      await postgresEmitSpineEventInTransaction(client, tokenIssuedEvent(tokenId) as SpineEventInput);
      const finalApproval = await client.query(
        `UPDATE pending_consents
            SET status = 'approved',
                subject_id = $2,
                grant_id = $3,
                token_id = $4,
                ai_training_consented = $5,
                approved_at = $6
          WHERE device_code = $1
            AND status = 'approving'`,
        [deviceCode, subjectId, grantId, tokenId, aiTrainingConsented ?? null, nowIso()]
      );
      if (finalApproval.rowCount !== 1) {
        const err: AuthError = new Error("Pending consent approval conflict");
        err.code = "approval_conflict";
        throw err;
      }
      return tokenId;
    });
  }

  return transaction(() => {
    const db = getDb();
    const claim = db
      .prepare(
        `UPDATE pending_consents
            SET status = 'approving', subject_id = ?
          WHERE device_code = ?
            AND status = 'pending'
            AND approval_review_revision = ?`
      )
      .run(subjectId, deviceCode, reviewedRevision);
    if (claim.changes !== 1) {
      const err: AuthError = new Error("Pending consent approval conflict");
      err.code = "approval_conflict";
      throw err;
    }
    requireSqliteReviewedInstancesActive(reviewedInstanceChecks);
    exec(referenceQueries.authGrantsInsert, [
      grantId,
      subjectId,
      clientId,
      storageBindingJson,
      grantJson,
      accessMode,
      issuedAt,
      expiresAt,
      traceContext.trace_id,
      traceContext.scenario_id ?? null,
    ]);
    const { tokenId } = insertSqliteGrantTokenInCurrentTransaction({ clientId, expiresAt, grantId, subjectId });
    emitRawSpineEvent(consentApprovedEvent as SpineEventInput, db);
    emitRawSpineEvent(grantIssuedEvent as SpineEventInput, db);
    emitRawSpineEvent(tokenIssuedEvent(tokenId) as SpineEventInput, db);
    const finalApproval = db
      .prepare(
        `UPDATE pending_consents
          SET status = 'approved',
              subject_id = ?,
              grant_id = ?,
              token_id = ?,
              ai_training_consented = ?,
              approved_at = ?
        WHERE device_code = ?
          AND status = 'approving'`
      )
      .run(
        subjectId,
        grantId,
        tokenId,
        aiTrainingConsented === undefined ? null : Number(aiTrainingConsented),
        nowIso(),
        deviceCode
      );
    if (finalApproval.changes !== 1) {
      const err: AuthError = new Error("Pending consent approval conflict");
      err.code = "approval_conflict";
      throw err;
    }
    return tokenId;
  });
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
  if (!isRecord(storedManifest.source_declaration) && isNonEmptyString(manifest.connector_id)) {
    // `connector_id` is the local storage key after canonicalization. When a
    // legacy manifest carried a URL-shaped identity in `manifest_uri`, retain
    // that explicit URI as the SourceDeclaration identity instead of asking
    // the projection to materialize a non-URI storage key (for example the
    // local `codex` catalog entry).
    const sourceId = isNonEmptyString(manifest.manifest_uri)
      ? manifest.manifest_uri.trim()
      : manifest.connector_id.trim();
    storedManifest.source_declaration = snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(
      storedManifest,
      {
        connectorImplementationId: isNonEmptyString(storedManifest.manifest_uri)
          ? storedManifest.manifest_uri
          : sourceId,
        publisherId: LEGACY_CONNECTOR_PROJECTION_PUBLISHER_ID,
        sourceId,
      }
    );
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol boundary retains its existing ordered local/self-hosted/external resolution branches; observability only forwards an optional sink.
async function resolveCimdClientForGrant(
  clientId: string,
  opts: {
    issuerBase?: string;
    baseUrl?: string;
    requestId?: string | null;
    request_id?: string | null;
    traceId?: string | null;
    trace_id?: string | null;
    cimdFetchDependencies?: CimdFetchDependencies;
    onCimdTransportFailure?: (event: CimdTransportFailureEvent) => void;
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
    ...opts.cimdFetchDependencies,
    onSecurityRelevantMetadataChange: (event) => revokeCimdClientAccessForSecurityMetadataChange(event, opts),
    ...(opts.onCimdTransportFailure ? { onTransportFailure: opts.onCimdTransportFailure } : {}),
    ...((opts.requestId ?? opts.request_id) === undefined ? {} : { requestId: opts.requestId ?? opts.request_id }),
    ...((opts.traceId ?? opts.trace_id) === undefined ? {} : { traceId: opts.traceId ?? opts.trace_id }),
  });
  return normalizeCimdRegisteredClient(buildCimdRegisteredClient(clientId, doc));
}

export async function resolveOAuthClient(
  clientId: unknown,
  opts: {
    issuerBase?: string;
    baseUrl?: string;
    cimdFetchDependencies?: CimdFetchDependencies;
    onCimdTransportFailure?: (event: CimdTransportFailureEvent) => void;
    requestId?: string | null;
    request_id?: string | null;
    traceId?: string | null;
    trace_id?: string | null;
  } = {}
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

async function requireInitiationRegisteredClient(
  request: PendingRequest,
  opts: InitiateGrantOptions,
  traceContext: TraceContext
): Promise<RegisteredClient> {
  const registeredClient = await resolveOAuthClient(request.client.client_id, {
    ...opts,
    requestId: traceContext.request_id,
    traceId: traceContext.trace_id,
  });
  if (!registeredClient) {
    const err: AuthError = new Error(`Unknown client_id: ${request.client.client_id}`);
    err.code = "invalid_client";
    throw err;
  }
  return registeredClient;
}

/**
 * Persist a pending grant-approval request and expose it as a PAR-backed consent request.
 * Returns the staged request URI plus the consent URL for the primary request/approval flow.
 */
export async function initiateGrant(
  input: Record<string, unknown>,
  opts: InitiateGrantOptions = {}
): Promise<Record<string, unknown>> {
  const preparedOpts = await prepareInitiateGrantOptions(opts);
  if (requiresStagedGrantBatch(input)) {
    return initiateStagedGrantBatch(input, preparedOpts);
  }
  const normalized = await normalizePendingGrantRequest(input, preparedOpts);
  requireStructuredPendingRequestShape(normalized);
  const traceContext = getRequestTraceContext(
    normalized,
    opts.scenarioId || (isNonEmptyString(input.scenario_id) ? input.scenario_id : null)
  );
  normalized.trace_context = traceContext;
  const sourceBinding = getRequestSourceBinding(normalized);

  try {
    const registeredClient = await requireInitiationRegisteredClient(normalized, preparedOpts, traceContext);
    applyRegisteredClientToPendingRequestClient(normalized, registeredClient);
    const { sourceBinding: validatedSourceBinding, storageBinding } =
      requireStructuredPendingRequestBindings(normalized);
    const manifest = await requireGrantManifestForBindings(validatedSourceBinding, storageBinding, preparedOpts);
    await retainSourceDeclarationSnapshot(normalized, validatedSourceBinding, storageBinding, manifest, preparedOpts);
    resolvePendingRequestAgainstSnapshot(normalized);

    const deviceCode = generateId("dc");
    const userCode = randomBytes(3).toString("hex").toUpperCase();
    const verificationBaseUrl =
      opts.baseUrl || process.env.AS_PUBLIC_URL || `http://localhost:${process.env.AS_PORT || "7662"}`;
    const expiresAt = expiresInIso(300);

    await createPendingConsent(deviceCode, userCode, normalized, expiresAt);
    const requestEventData = {
      access_mode: normalized.selection.access_mode || null,
      purpose_code: normalized.selection.purpose_code || null,
      selection_preset: normalized.selection.selection_preset ?? null,
      source: describeSourceBinding(sourceBinding),
      stream_names: (normalized.selection.streams ?? []).map((stream) => stream.name),
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
        stream_names: (normalized.selection.streams ?? []).map((stream) => stream.name),
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
    ...(entry.source_declaration_snapshot ? { source_declaration_snapshot: entry.source_declaration_snapshot } : {}),
    source_binding: entry.source_binding,
    storage_binding: entry.storage_binding,
    ...(entry.manifest_version ? { manifest_version: entry.manifest_version } : {}),
    ...(batchRequest.trace_context ? { trace_context: batchRequest.trace_context } : {}),
  };
}

async function initiateStagedGrantBatch(
  input: Record<string, unknown>,
  opts: InitiateGrantOptions = {}
): Promise<Record<string, unknown>> {
  const batch = await normalizeStagedGrantRequestBatch(input, opts);
  const traceContext = getRequestTraceContext(
    batch,
    opts.scenarioId || (isNonEmptyString(input.scenario_id) ? input.scenario_id : null)
  );
  batch.trace_context = traceContext;
  const firstSource = batch.entries[0]?.source_binding || null;

  try {
    const registeredClient = await resolveOAuthClient(batch.client.client_id, {
      ...opts,
      requestId: traceContext.request_id,
      traceId: traceContext.trace_id,
    });
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
      await retainSourceDeclarationSnapshot(slice, sourceBinding, storageBinding, manifest, opts);
      resolvePendingRequestAgainstSnapshot(slice);
      entry.source_declaration_snapshot = slice.source_declaration_snapshot;
      entry.manifest_version = slice.manifest_version;
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

function buildBatchConsentCards(request: StagedBatchRequest): Record<string, unknown>[] {
  return request.entries.map((entry, index) => {
    const slice = asSingleEntryRequestSlice(request, entry);
    requireStructuredPendingRequestShape(slice);
    const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(slice);
    entry.source_binding = describeSourceBinding(sourceBinding);
    entry.storage_binding = normalizeStorageBinding(storageBinding);
    const snapshot = readRetainedSourceDeclarationSnapshot(slice);
    const resolvedStreams = resolvePendingRequestAgainstSnapshot(slice);
    return {
      access_mode: entry.selection?.access_mode || null,
      client_claims: entry.selection?.client_claims ?? null,
      index,
      manifestStreamNames: Array.isArray(snapshot.declaration.streams)
        ? snapshot.declaration.streams.map((stream) => stream.name).filter((name) => typeof name === "string")
        : null,
      purpose_code: entry.selection?.purpose_code || null,
      resolvedStreams,
      retention: entry.selection?.retention ?? null,
      sensitivity: snapshot.source_sensitivity,
      source: describeSourceBinding(sourceBinding),
    };
  });
}

function buildBatchConsentCardsFromReviewArtifact(
  artifact: Record<string, unknown> & { subject?: { id?: unknown } }
): Record<string, unknown>[] {
  requireBatchApprovalReviewArtifact(artifact);
  return artifact.sources.map((source) => {
    if (!isRecord(source)) {
      throw bindingError("invalid_request", "Pending batch review has invalid source facts; review the request again");
    }
    return {
      access_mode: source.access_mode || null,
      client_claims: normalizeApprovalReviewClientClaims(source.client_claims),
      index: source.index,
      manifestStreamNames: null,
      purpose_code: source.purpose_code || null,
      resolvedStreams: source.resolved_streams,
      retention: source.retention ?? null,
      sensitivity: null,
      source: source.source,
    };
  });
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
  return resolved.some((stream) => !(isRecord(stream) && stream.time_constraint));
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
// `time_constraint.since` bound, but MUST NOT widen beyond what the client
// staged and the owner reviewed. Narrowing is validated against the staged
// resolved baseline retained in the declaration snapshot, which is the
// authoritative ceiling of what the client asked for. Anything not a
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
  const baselineConstraint = narrowed.time_constraint;
  if (!(baselineConstraint && isNonEmptyString(baselineConstraint.since))) {
    throw bindingError(
      "invalid_request",
      `Cannot set a time bound on '${sourceLabel}' stream '${name}': the staged request placed no time bound on it, so a tighter bound cannot be proven against it`
    );
  }
  const baselineSince = baselineConstraint.since;
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
  narrowed.time_constraint = { ...baselineConstraint, since: requestedSince };
}

function narrowResolvedStream(
  baseStream: StreamSelection,
  fieldsNarrowing: Record<string, unknown>,
  sinceNarrowing: Record<string, unknown>,
  sourceLabel: string,
  requiredFields: string[]
): StreamSelection {
  const narrowed = { ...baseStream };
  if (Object.hasOwn(fieldsNarrowing, narrowed.name)) {
    applyFieldNarrowing(narrowed, fieldsNarrowing[narrowed.name], sourceLabel);
    narrowed.fields = [...new Set([...(narrowed.fields ?? []), ...requiredFields])];
  }
  if (Object.hasOwn(sinceNarrowing, narrowed.name)) {
    applySinceNarrowing(narrowed, sinceNarrowing[narrowed.name], sourceLabel);
  }
  return narrowed;
}

function narrowResolvedSelectionForSource(
  baselineResolved: StreamSelection[],
  narrowing: Record<string, unknown> | null | undefined,
  sourceLabel: string,
  declaration: DbRow,
  requiredStreamNames: readonly string[] = []
): StreamSelection[] {
  const baseline = Array.isArray(baselineResolved) ? baselineResolved : [];
  if (!narrowingHasAnyDirective(narrowing)) {
    return baseline;
  }
  const baselineByName = new Map(baseline.map((stream) => [stream.name, stream]));
  const keptNames = resolveKeptStreamNames(baseline, narrowing.streams, baselineByName, sourceLabel);
  const droppedRequired = requiredStreamNames.filter((name) => !keptNames.includes(name));
  if (droppedRequired.length > 0) {
    throw bindingError(
      "invalid_request",
      `Cannot drop required streams for '${sourceLabel}': ${droppedRequired.join(", ")}`
    );
  }
  const fieldsNarrowing = isRecord(narrowing.fields) ? narrowing.fields : {};
  const sinceNarrowing = isRecord(narrowing.since) ? narrowing.since : {};
  requireNarrowingTargetsKept(keptNames, [fieldsNarrowing, sinceNarrowing], sourceLabel);
  return keptNames.map((name) => {
    const baseStream = baselineByName.get(name);
    if (!baseStream) {
      throw bindingError("invalid_request", `Unknown staged stream '${name}' for '${sourceLabel}'`);
    }
    const declarationStream = getManifestStreams(declaration).find((stream) => stream.name === name);
    if (!declarationStream) {
      throw bindingError("invalid_request", `Retained declaration has no stream '${name}' for '${sourceLabel}'`);
    }
    return narrowResolvedStream(
      baseStream,
      fieldsNarrowing,
      sinceNarrowing,
      sourceLabel,
      coreSchemaRequiredFields(
        declarationStream as unknown as import("@pdpp/reference-contract/public/source").SourceDeclarationStream
      )
    );
  });
}

interface PendingConsentDisplayOptions extends Record<string, unknown> {
  ai_training_consented?: unknown;
  approvedSourceIndexes?: number[] | null;
  confirmedApproveAll?: boolean;
  finalizeReview?: boolean;
  nativeManifest?: DbRow | null;
  sourceNarrowing?: Record<string, unknown>;
  subjectId?: string | null;
}

async function getPendingConsentBatch(
  request: StagedBatchRequest,
  row: PendingConsentRow,
  opts: PendingConsentDisplayOptions = {}
): Promise<Record<string, unknown>> {
  try {
    let cards: Record<string, unknown>[];
    let review: (Record<string, unknown> & { subject?: { id?: unknown } }) | null = null;
    let reviewArtifact: string | null = null;
    let reviewDigest: string | null = null;
    let reviewRevision: string | null = null;
    const hasFinalChoice =
      opts.approvedSourceIndexes !== undefined ||
      opts.sourceNarrowing !== undefined ||
      opts.confirmedApproveAll === true;
    if (opts.ai_training_consented !== undefined && hasFinalChoice) {
      throw bindingError("invalid_request", "Batch approval review does not accept ai_training_consented");
    }
    if (opts.finalizeReview && opts.subjectId && hasFinalChoice) {
      const batchState = await buildReviewedBatchApprovalState(request, row, opts.subjectId, {
        ...opts,
      });
      await persistApprovalReviewArtifact({ deviceCode: row.device_code, ...batchState.review });
      const persisted = await readValidatedPersistedApprovalReview(row.device_code);
      review = persisted.artifact;
      reviewArtifact = persisted.artifactJson;
      reviewDigest = persisted.digest;
      reviewRevision = persisted.revision;
      cards = buildBatchConsentCardsFromReviewArtifact(review);
    } else if (hasPersistedApprovalReview(row)) {
      const persisted = await readValidatedPersistedApprovalReview(row.device_code);
      review = persisted.artifact;
      reviewArtifact = persisted.artifactJson;
      reviewDigest = persisted.digest;
      reviewRevision = persisted.revision;
      cards = buildBatchConsentCardsFromReviewArtifact(review);
    } else {
      await requirePendingRequestClientRegistration(request, opts);
      cards = await buildBatchConsentCards(request);
    }
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
      review,
      reviewArtifact,
      reviewDigest,
      reviewRevision,
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
        ...(firstEntry
          ? {
              selection: firstEntry.selection,
              source_binding: firstEntry.source_binding,
              source_declaration_snapshot: firstEntry.source_declaration_snapshot,
            }
          : {}),
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
  approval_review_revision?: unknown;
  approvedSourceIndexes?: number[] | null;
  confirmedApproveAll?: boolean;
  narrowings?: Record<string, unknown>[] | null;
  nativeManifest?: DbRow | null;
  reviewExpiresAt?: string | null;
  sourceNarrowing?: Record<string, unknown>;
}

interface ReviewedBatchApprovalState {
  approvedIndexes: number[];
  parentPackage: GrantPackageNormalized | null;
  registeredClient: RegisteredClient;
  resolvedEntries: {
    entry: BatchEntry;
    index: number;
    resolvedStreams: ResolvedGrantStream[];
    slice: PendingRequest;
    sourceBinding: SourceBinding;
    storageBinding: StorageBinding;
  }[];
  review: { artifactJson: string; digest: string; revision: string };
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
      ...(firstEntry
        ? {
            selection: firstEntry.selection,
            source_binding: firstEntry.source_binding,
            source_declaration_snapshot: firstEntry.source_declaration_snapshot,
          }
        : {}),
    },
    pending,
    err,
    { subjectId }
  );
  throw err;
}

function requireBatchEntryPolicy(approvedEntries: BatchEntry[]): void {
  for (const entry of approvedEntries) {
    if (entry.selection.purpose_code === "https://pdpp.dev/purpose/ai_training") {
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
      const gate = evaluateBatchApproveAllGate(await buildBatchConsentCards(request));
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
  opts: ApproveStagedGrantBatchOptions = {}
): Promise<{ grant: DbRow; package: boolean; package_id: string; token: string }> {
  const traceContext = requirePersistedPendingTraceContext(pending);
  request.trace_context = traceContext;
  const reviewed = requireMatchingApprovalReview(pending as PendingConsentRow, opts.approval_review_revision);
  const { subjectId } = reviewed;
  const persistedOptions = persistedBatchReviewOptions(pending as PendingConsentRow);
  const batchState = await buildReviewedBatchApprovalState(request, pending, subjectId, persistedOptions);
  if (
    batchState.review.revision !== pending.approval_review_revision ||
    batchState.review.digest !== pending.approval_review_digest
  ) {
    throw bindingError("invalid_request", "Pending consent review is stale");
  }

  return await persistApprovedBatchGrantAtomically({
    deviceCode,
    pending,
    subjectId,
    traceContext,
    ...batchState,
  });
}

async function buildReviewedBatchApprovalState(
  request: StagedBatchRequest,
  pending: DbRow,
  subjectId: string,
  opts: ApproveStagedGrantBatchOptions = {}
): Promise<ReviewedBatchApprovalState> {
  const { approvedEntries, approvedIndexes } = await resolveApprovedBatchEntries(request, pending, subjectId, opts);
  const sourceNarrowing = opts.sourceNarrowing && typeof opts.sourceNarrowing === "object" ? opts.sourceNarrowing : {};
  requireNumericObjectKeys(sourceNarrowing, "source_narrowing");
  requireApprovedSourceNarrowings(sourceNarrowing, approvedIndexes);
  let registeredClient: RegisteredClient;
  let parentPackage: GrantPackageNormalized | null = null;
  const resolvedEntries: {
    entry: BatchEntry;
    index: number;
    resolvedStreams: ResolvedGrantStream[];
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
    for (const [position, entry] of approvedEntries.entries()) {
      const stagedIndex = approvedIndexes[position];
      if (stagedIndex === undefined) {
        throw bindingError("invalid_request", `Approved source position ${position} is unavailable`);
      }
      const slice = asSingleEntryRequestSlice(request, entry);
      requireStructuredPendingRequestShape(slice);
      const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(slice);
      entry.source_binding = describeSourceBinding(sourceBinding);
      entry.storage_binding = normalizeStorageBinding(storageBinding);
      const baselineStreams = resolvePendingRequestAgainstSnapshot(slice);
      const retainedDeclaration = readRetainedSourceDeclarationSnapshot(slice).declaration;
      // Apply owner per-source narrowing against the staged resolved baseline.
      // narrowResolvedSelectionForSource proves the result is a subset/tightening
      // of what the client staged; widening throws invalid_request here, before
      // any package row or child grant is written.
      const narrowedStreams = narrowResolvedSelectionForSource(
        baselineStreams,
        isRecord(sourceNarrowing[stagedIndex]) ? sourceNarrowing[stagedIndex] : null,
        sourceBinding.id || `source ${stagedIndex + 1}`,
        retainedDeclaration
      );
      // biome-ignore lint/performance/noAwaitInLoops: Per-source eligibility is intentionally resolved in stable approval order before any package write.
      const resolvedStreams = await resolveSnapshotStreamsForApproval(
        narrowedStreams,
        sourceBinding,
        storageBinding,
        subjectId
      );
      resolvedEntries.push({ entry, index: stagedIndex, resolvedStreams, slice, sourceBinding, storageBinding });
    }
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    const [firstEntry] = request.entries;
    await emitPendingConsentRejected(
      {
        client: request.client,
        ...(firstEntry
          ? {
              selection: firstEntry.selection,
              source_binding: firstEntry.source_binding,
              source_declaration_snapshot: firstEntry.source_declaration_snapshot,
            }
          : {}),
      },
      pending,
      err,
      { subjectId }
    );
    throw err;
  }
  const [firstResolvedEntry] = resolvedEntries;
  if (!firstResolvedEntry) {
    throw bindingError("invalid_request", "No approved batch entries are available");
  }
  const expiresAt =
    firstResolvedEntry.entry.selection.access_mode === "single_use"
      ? (opts.reviewExpiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
      : null;
  const review = buildBatchApprovalReviewArtifact({
    approvedIndexes,
    client: request.client,
    entries: resolvedEntries.map((entry) => ({
      index: entry.index,
      request: entry.slice,
      resolvedStreams: entry.resolvedStreams,
    })),
    expiresAt,
    parentPackageId: parentPackage ? parentPackage.package_id : null,
    sourceNarrowing,
    subjectId,
  });
  return {
    approvedIndexes,
    parentPackage,
    registeredClient,
    resolvedEntries,
    review,
  };
}

async function persistApprovedBatchGrantAtomically({
  approvedIndexes,
  deviceCode,
  parentPackage,
  pending,
  registeredClient,
  resolvedEntries,
  review,
  subjectId,
  traceContext,
}: ReviewedBatchApprovalState & {
  deviceCode: string;
  pending: DbRow;
  subjectId: string;
  traceContext: TraceContext;
}): Promise<{ grant: DbRow; package: boolean; package_id: string; token: string }> {
  const packageId = generateId("gpkg");
  const createdAt = nowIso();
  const packageEnvelope = {
    approved_source_count: resolvedEntries.length,
    client: {
      client_display: buildClientDisplayFromRegistration(registeredClient.metadata),
      client_id: registeredClient.client_id,
      registration_mode: registeredClient.registration_mode || "pre_registered_public",
    },
    package_id: packageId,
    source_bounded_child_grants: true,
    subject: { id: subjectId },
    version: CURRENT_GRANT_PACKAGE_VERSION,
  };

  const parentPackageId = parentPackage ? parentPackage.package_id : null;
  const reviewPayload = JSON.parse(review.artifactJson) as { expires_at?: string | null };
  const childGrants: { grant: GrantEnvelope; source: Record<string, unknown> | null; token: string }[] = [];
  for (const resolved of resolvedEntries) {
    const grantId = generateId("grt");
    const issuedAt = createdAt;
    const expiresAt = resolved.entry.selection.access_mode === "single_use" ? (reviewPayload.expires_at ?? null) : null;
    const grant = materializeCoreResolvedGrant({
      accessMode: resolved.entry.selection.access_mode,
      clientId: registeredClient.client_id,
      expiresAt,
      grantId,
      issuedAt,
      purposeCode: resolved.entry.selection.purpose_code,
      purposeDescription: resolved.entry.selection.purpose_description,
      resolvedStreams: resolved.resolvedStreams,
      retention: resolved.entry.selection.retention,
      selectionPreset: resolved.entry.selection.selection_preset,
      snapshot: readRetainedSourceDeclarationSnapshot(
        resolved.slice
      ) as unknown as import("./core-source-authorization.ts").RetainedCoreConsentSnapshot,
      subjectId,
    }) as unknown as GrantEnvelope;
    const source = describePackageMemberSource(grant);
    if (!isNonEmptyString(grant.grant_id)) {
      throw bindingError("grant_invalid", "Issued child grant is missing grant_id");
    }
    childGrants.push({ grant, source, token: "" });
  }

  const consentApprovedEvent: AuthSpineEventInput = {
    actor_id: subjectId,
    actor_type: "subject",
    client_id: registeredClient.client_id,
    data: {
      approved_source_indexes: approvedIndexes,
      package_id: packageId,
      sources: resolvedEntries.map((resolved) =>
        buildResolvedSnapshotEvidence(resolved.slice, resolved.resolvedStreams)
      ),
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
  };
  const grantPackageIssuedEvent = (issuedPackageToken: string): AuthSpineEventInput => ({
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
    token_id: issuedPackageToken,
    trace_id: traceContext.trace_id,
  });

  const packageToken = await persistApprovedBatchRowsAtomically({
    childGrants,
    clientId: registeredClient.client_id,
    consentApprovedEvent,
    createdAt,
    deviceCode,
    grantPackageIssuedEvent,
    packageEnvelope,
    packageId,
    parentPackageId,
    pending,
    resolvedEntries,
    reviewRevision: review.revision,
    subjectId,
    traceContext,
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

async function persistApprovedBatchRowsAtomically(input: {
  childGrants: { grant: GrantEnvelope; source: Record<string, unknown> | null; token: string }[];
  clientId: string;
  consentApprovedEvent: AuthSpineEventInput;
  createdAt: string;
  deviceCode: string;
  grantPackageIssuedEvent: (packageToken: string) => AuthSpineEventInput;
  packageEnvelope: Record<string, unknown>;
  packageId: string;
  parentPackageId: string | null;
  pending: DbRow;
  resolvedEntries: {
    entry: BatchEntry;
    resolvedStreams: ResolvedGrantStream[];
    slice: PendingRequest;
    storageBinding: StorageBinding;
  }[];
  reviewRevision: string;
  subjectId: string;
  traceContext: TraceContext;
}): Promise<string> {
  const packageJson = JSON.stringify(input.packageEnvelope);
  if (isPostgresStorageBackend()) {
    return await withPostgresTransaction(async (client) => {
      const claim = await client.query(
        `UPDATE pending_consents
            SET status = 'approving', subject_id = $2
          WHERE device_code = $1
            AND status = 'pending'
            AND approval_review_revision = $3
          RETURNING device_code`,
        [input.deviceCode, input.subjectId, input.reviewRevision]
      );
      if (claim.rowCount !== 1) {
        const err: AuthError = new Error("Pending consent approval conflict");
        err.code = "approval_conflict";
        throw err;
      }
      await requirePostgresParentPackageStillEligible(client, {
        clientId: input.clientId,
        parentPackageId: input.parentPackageId,
        subjectId: input.subjectId,
      });
      await requirePostgresReviewedInstancesActive(
        client,
        input.resolvedEntries.flatMap((entry) =>
          reviewedInstanceChecksForGrant({
            acceptedRevisionFulfillment: Boolean(
              readRetainedSourceDeclarationSnapshot(entry.slice).accepted_revision_reference
            ),
            resolvedStreams: entry.resolvedStreams,
            sourceBinding: entry.slice.source_binding as SourceBinding,
            storageBinding: entry.storageBinding,
            subjectId: input.subjectId,
          })
        )
      );
      await client.query(
        `INSERT INTO grant_packages(
           package_id, subject_id, client_id, status, package_json,
           parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
         ) VALUES($1, $2, $3, 'active', $4::jsonb, $5, $6, $7, $8, $9, NULL)`,
        [
          input.packageId,
          input.subjectId,
          input.clientId,
          packageJson,
          input.parentPackageId,
          input.traceContext.trace_id,
          input.traceContext.scenario_id ?? null,
          input.createdAt,
          input.createdAt,
        ]
      );
      for (const [index, child] of input.childGrants.entries()) {
        const resolved = input.resolvedEntries[index];
        if (!resolved) {
          throw bindingError("grant_invalid", `Missing resolved batch entry ${index}`);
        }
        // biome-ignore lint/performance/noAwaitInLoops: Child grant/package rows must be written in package member order inside one transaction.
        await client.query(
          `INSERT INTO grants(
             grant_id, subject_id, client_id, storage_binding_json, grant_json,
             access_mode, issued_at, expires_at, trace_id, scenario_id
           ) VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
          [
            child.grant.grant_id,
            input.subjectId,
            input.clientId,
            serializeStorageBinding(normalizeStorageBinding(resolved.storageBinding)),
            JSON.stringify(child.grant),
            resolved.entry.selection.access_mode,
            child.grant.issued_at,
            child.grant.expires_at ?? null,
            input.traceContext.trace_id,
            input.traceContext.scenario_id ?? null,
          ]
        );
        const { tokenId } = await insertPostgresGrantToken(client, {
          clientId: input.clientId,
          expiresAt: child.grant.expires_at ?? null,
          grantId: child.grant.grant_id as string,
          subjectId: input.subjectId,
        });
        child.token = tokenId;
        await client.query(
          `INSERT INTO grant_package_members(
             package_id, grant_id, token_id, source_json, status, added_at, revoked_at
           ) VALUES($1, $2, $3, $4::jsonb, 'active', $5, NULL)`,
          [input.packageId, child.grant.grant_id, tokenId, JSON.stringify(child.source), input.createdAt]
        );
        await postgresEmitSpineEventInTransaction(
          client,
          buildGrantIssuedEventInput({
            grant: child.grant,
            grantId: child.grant.grant_id as string,
            registeredClient: {
              client_id: input.clientId,
              client_secret: null,
              created_at: null,
              metadata: { token_endpoint_auth_method: "none" },
              registration_mode: "pre_registered_public",
              token_endpoint_auth_method: "none",
              updated_at: null,
            },
            request: resolved.slice,
            resolvedStreams: resolved.resolvedStreams,
            selection: resolved.entry.selection,
            subjectId: input.subjectId,
            traceContext: input.traceContext,
          }) as SpineEventInput
        );
        await postgresEmitSpineEventInTransaction(
          client,
          buildTokenIssuedEventInput({
            clientId: input.clientId,
            grant: child.grant,
            grantId: child.grant.grant_id as string,
            subjectId: input.subjectId,
            tokenId,
            traceContext: input.traceContext,
          }) as SpineEventInput
        );
      }
      await postgresEmitSpineEventInTransaction(client, input.consentApprovedEvent as SpineEventInput);
      const packageToken = generateToken();
      await client.query(
        `INSERT INTO tokens(token_id, grant_id, package_id, subject_id, client_id, token_kind, expires_at)
         VALUES($1, NULL, $2, $3, $4, 'mcp_package', NULL)`,
        [packageToken, input.packageId, input.subjectId, input.clientId]
      );
      await postgresEmitSpineEventInTransaction(client, input.grantPackageIssuedEvent(packageToken) as SpineEventInput);
      const finalApproval = await client.query(
        `UPDATE pending_consents
            SET status = 'approved',
                subject_id = $2,
                grant_id = $3,
                token_id = $4,
                ai_training_consented = FALSE,
                approved_at = $5
          WHERE device_code = $1
            AND status = 'approving'`,
        [input.deviceCode, input.subjectId, input.packageId, packageToken, input.createdAt]
      );
      if (finalApproval.rowCount !== 1) {
        const err: AuthError = new Error("Pending consent approval conflict");
        err.code = "approval_conflict";
        throw err;
      }
      return packageToken;
    });
  }

  return transaction(() => {
    const db = getDb();
    const claim = db
      .prepare(
        `UPDATE pending_consents
            SET status = 'approving', subject_id = ?
          WHERE device_code = ?
            AND status = 'pending'
            AND approval_review_revision = ?`
      )
      .run(input.subjectId, input.deviceCode, input.reviewRevision);
    if (claim.changes !== 1) {
      const err: AuthError = new Error("Pending consent approval conflict");
      err.code = "approval_conflict";
      throw err;
    }
    requireSqliteParentPackageStillEligible({
      clientId: input.clientId,
      parentPackageId: input.parentPackageId,
      subjectId: input.subjectId,
    });
    requireSqliteReviewedInstancesActive(
      input.resolvedEntries.flatMap((entry) =>
        reviewedInstanceChecksForGrant({
          acceptedRevisionFulfillment: Boolean(
            readRetainedSourceDeclarationSnapshot(entry.slice).accepted_revision_reference
          ),
          resolvedStreams: entry.resolvedStreams,
          sourceBinding: entry.slice.source_binding as SourceBinding,
          storageBinding: entry.storageBinding,
          subjectId: input.subjectId,
        })
      )
    );
    exec(referenceQueries.authGrantPackagesInsert, [
      input.packageId,
      input.subjectId,
      input.clientId,
      packageJson,
      input.parentPackageId,
      input.traceContext.trace_id,
      input.traceContext.scenario_id ?? null,
      input.createdAt,
      input.createdAt,
    ]);
    for (const [index, child] of input.childGrants.entries()) {
      const resolved = input.resolvedEntries[index];
      if (!resolved) {
        throw bindingError("grant_invalid", `Missing resolved batch entry ${index}`);
      }
      exec(referenceQueries.authGrantsInsert, [
        child.grant.grant_id,
        input.subjectId,
        input.clientId,
        serializeStorageBinding(normalizeStorageBinding(resolved.storageBinding)),
        JSON.stringify(child.grant),
        resolved.entry.selection.access_mode,
        child.grant.issued_at,
        child.grant.expires_at ?? null,
        input.traceContext.trace_id,
        input.traceContext.scenario_id ?? null,
      ]);
      const { tokenId } = insertSqliteGrantTokenInCurrentTransaction({
        clientId: input.clientId,
        expiresAt: child.grant.expires_at ?? null,
        grantId: child.grant.grant_id as string,
        subjectId: input.subjectId,
      });
      child.token = tokenId;
      exec(referenceQueries.authGrantPackageMembersInsert, [
        input.packageId,
        child.grant.grant_id,
        tokenId,
        JSON.stringify(child.source),
        input.createdAt,
      ]);
      emitRawSpineEvent(
        buildGrantIssuedEventInput({
          grant: child.grant,
          grantId: child.grant.grant_id as string,
          registeredClient: {
            client_id: input.clientId,
            client_secret: null,
            created_at: null,
            metadata: { token_endpoint_auth_method: "none" },
            registration_mode: "pre_registered_public",
            token_endpoint_auth_method: "none",
            updated_at: null,
          },
          request: resolved.slice,
          resolvedStreams: resolved.resolvedStreams,
          selection: resolved.entry.selection,
          subjectId: input.subjectId,
          traceContext: input.traceContext,
        }) as SpineEventInput,
        db
      );
      emitRawSpineEvent(
        buildTokenIssuedEventInput({
          clientId: input.clientId,
          grant: child.grant,
          grantId: child.grant.grant_id as string,
          subjectId: input.subjectId,
          tokenId,
          traceContext: input.traceContext,
        }) as SpineEventInput,
        db
      );
    }
    emitRawSpineEvent(input.consentApprovedEvent as SpineEventInput, db);
    const packageToken = generateToken();
    exec(referenceQueries.authTokensInsertMcpPackage, [
      packageToken,
      input.packageId,
      input.subjectId,
      input.clientId,
      null,
    ]);
    emitRawSpineEvent(input.grantPackageIssuedEvent(packageToken) as SpineEventInput, db);
    const finalApproval = db
      .prepare(
        `UPDATE pending_consents
            SET status = 'approved',
                subject_id = ?,
                grant_id = ?,
                token_id = ?,
                ai_training_consented = 0,
                approved_at = ?
          WHERE device_code = ?
            AND status = 'approving'`
      )
      .run(input.subjectId, input.packageId, packageToken, input.createdAt, input.deviceCode);
    if (finalApproval.changes !== 1) {
      const err: AuthError = new Error("Pending consent approval conflict");
      err.code = "approval_conflict";
      throw err;
    }
    return packageToken;
  });
}

async function getReviewedPendingConsentProjection(
  deviceCode: string,
  row: PendingConsentRow,
  request: Record<string, unknown>,
  opts: PendingConsentDisplayOptions
): Promise<Record<string, unknown>> {
  const persisted = await readValidatedPersistedApprovalReview(deviceCode);
  if (persisted.artifact.version === "reference.batch-approval-review.v1") {
    if (!isStagedBatchRequest(request)) {
      throw bindingError("invalid_request", "Pending consent review does not match the staged request");
    }
    return getPendingConsentBatch(request, row, opts);
  }
  const artifactStreams = Array.isArray(persisted.artifact.resolved_streams)
    ? (persisted.artifact.resolved_streams as StreamSelection[])
    : [];
  return {
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    manifestStreamNames: null,
    request,
    resolvedStreams: artifactStreams,
    review: persisted.artifact,
    reviewArtifact: persisted.artifactJson,
    reviewDigest: persisted.digest,
    reviewRevision: persisted.revision,
    userCode: row.user_code,
  };
}

async function resolveSingleConsentReviewStreams(
  request: PendingRequest,
  sourceBinding: SourceBinding,
  storageBinding: StorageBinding,
  opts: PendingConsentDisplayOptions
): Promise<ResolvedGrantStream[] | StreamSelection[]> {
  const baselineStreams = resolvePendingRequestAgainstSnapshot(request);
  const sourceNarrowing = opts.sourceNarrowing && typeof opts.sourceNarrowing === "object" ? opts.sourceNarrowing : {};
  requireNumericObjectKeys(sourceNarrowing, "source_narrowing");
  requireApprovedSourceNarrowings(sourceNarrowing, [0]);
  const requiredStreamNames = (request.selection.streams ?? [])
    .filter((stream) => stream.necessity !== "optional" && isNonEmptyString(stream.name) && stream.name !== "*")
    .map((stream) => stream.name as string);
  const narrowedStreams = narrowResolvedSelectionForSource(
    baselineStreams,
    isRecord(sourceNarrowing["0"]) ? sourceNarrowing["0"] : null,
    sourceBinding.id,
    readRetainedSourceDeclarationSnapshot(request).declaration,
    requiredStreamNames
  );
  return opts.subjectId && storageBinding
    ? await resolveSnapshotStreamsForApproval(narrowedStreams, sourceBinding, storageBinding, opts.subjectId)
    : narrowedStreams;
}

/**
 * Get pending consent request for display in consent UI
 */
export async function getPendingConsent(
  deviceCode: string,
  opts: PendingConsentDisplayOptions = {}
): Promise<Record<string, unknown> | null> {
  const row = await getPendingConsentRow(deviceCode);
  if (row?.status !== "pending") {
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
  if (hasPersistedApprovalReview(row)) {
    return getReviewedPendingConsentProjection(deviceCode, row, request, opts);
  }
  if (isStagedBatchRequest(request)) {
    return getPendingConsentBatch(request, row, opts);
  }
  let resolvedStreams: StreamSelection[] | null = null;
  let manifestStreamNames: string[] | null = null;
  let review: (Record<string, unknown> & { subject?: { id?: unknown } }) | null = null;
  try {
    requireStructuredPendingRequestShape(request);
    await requirePendingRequestClientRegistration(request, opts);
    const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request);
    request.source_binding = describeSourceBinding(sourceBinding);
    request.storage_binding = normalizeStorageBinding(storageBinding);
    const snapshot = readRetainedSourceDeclarationSnapshot(request);
    resolvedStreams = await resolveSingleConsentReviewStreams(request, sourceBinding, storageBinding, opts);
    manifestStreamNames = Array.isArray(snapshot.declaration.streams)
      ? snapshot.declaration.streams.map((stream) => stream.name).filter((name) => typeof name === "string")
      : null;
    if (opts.finalizeReview && opts.subjectId) {
      const aiTrainingConsented = coerceAiTrainingConsent(opts.ai_training_consented);
      requireReviewedAiTrainingConsent(request.selection, aiTrainingConsented);
      const artifact = buildApprovalReviewArtifact({
        aiTrainingConsented,
        client: request.client,
        expiresAt:
          request.selection.access_mode === "single_use"
            ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            : null,
        request,
        resolvedStreams: resolvedStreams ?? [],
        subjectId: opts.subjectId,
      });
      await persistApprovalReviewArtifact({ deviceCode, ...artifact });
      const persisted = await readValidatedPersistedApprovalReview(deviceCode);
      review = persisted.artifact;
      row.approval_review_digest = persisted.digest;
      row.approval_review_json = persisted.artifactJson;
      row.approval_review_revision = persisted.revision;
    }
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
    review,
    reviewArtifact: row.approval_review_json ?? null,
    reviewDigest: row.approval_review_digest ?? null,
    reviewRevision: row.approval_review_revision ?? null,
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
  _legacySubjectId = "owner_local",
  opts: {
    ai_training_consented?: unknown;
    approval_review_revision?: unknown;
    approvedSourceIndexes?: number[] | null;
    nativeManifest?: DbRow | null;
    baseUrl?: string;
    confirmedApproveAll?: boolean;
    sourceNarrowing?: Record<string, unknown>;
  } = {}
): Promise<{ grant: DbRow; package?: boolean; package_id?: string; token: string }> {
  if (opts.ai_training_consented !== undefined) {
    const err = bindingError("invalid_request", "ai_training_consented is only accepted during consent review");
    err.param = "ai_training_consented";
    throw err;
  }
  const pending = await getPendingConsentRow(deviceCode);
  if (!pending) {
    const err: AuthError = new Error("Unknown device code");
    err.code = "not_found";
    throw err;
  }
  if (pending.status === "approved") {
    return resumeApprovedGrant(pending, _legacySubjectId);
  }
  if (pending.status !== "pending") {
    if (opts.approval_review_revision && opts.approval_review_revision === pending.approval_review_revision) {
      const err: AuthError = new Error("Pending consent approval conflict");
      err.code = "approval_conflict";
      throw err;
    }
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
    return approveStagedGrantBatch(deviceCode, pending, request, opts);
  }
  requireStructuredPendingRequestShape(request);
  const reviewed = requireMatchingApprovalReview(pending, opts.approval_review_revision);
  const { aiTrainingConsented, subjectId } = reviewed;
  const traceContext = requirePersistedPendingTraceContext(pending);
  request.trace_context = traceContext;
  let registeredClient: RegisteredClient;
  let sourceBinding: SourceBinding;
  let storageBinding: StorageBinding;
  let resolvedStreams: ResolvedGrantStream[];

  try {
    registeredClient = await requirePendingRequestClientRegistration(request, opts);
    ({ sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request));
    request.source_binding = describeSourceBinding(sourceBinding);
    request.storage_binding = normalizeStorageBinding(storageBinding);
    ({ resolvedStreams } = reviewed);
  } catch (err: unknown) {
    if (!isAuthError(err)) {
      throw err;
    }
    await emitPendingConsentRejected(request, pending, err, { subjectId });
    throw err;
  }

  const { selection } = request;

  // The AS MUST obtain explicit affirmative consent before issuing ai_training grants.
  // A missing affirmation is a consent-policy rejection, not an internal failure;
  // surface it as a typed PDPP error envelope (status 400, code `invalid_request`)
  // so callers do not see it as a generic 500.
  requireReviewedAiTrainingConsent(selection, aiTrainingConsented);

  const grantId = generateId("grt");
  const issuedAt = nowIso();
  const { expiresAt } = reviewed;

  const persistedStorageBinding = normalizeStorageBinding(storageBinding);
  const approvalArtifact = buildApprovalReviewArtifact({
    aiTrainingConsented,
    client: request.client,
    expiresAt,
    request,
    resolvedStreams,
    subjectId,
  });
  if (
    approvalArtifact.revision !== pending.approval_review_revision ||
    approvalArtifact.digest !== pending.approval_review_digest
  ) {
    throw bindingError("invalid_request", "Pending consent review is stale");
  }

  const grant = materializeCoreResolvedGrant({
    accessMode: selection.access_mode,
    clientId: registeredClient.client_id,
    expiresAt,
    grantId,
    issuedAt,
    purposeCode: selection.purpose_code,
    purposeDescription: selection.purpose_description,
    resolvedStreams,
    retention: selection.retention,
    selectionPreset: selection.selection_preset,
    snapshot: readRetainedSourceDeclarationSnapshot(
      request
    ) as unknown as import("./core-source-authorization.ts").RetainedCoreConsentSnapshot,
    subjectId,
  }) as unknown as GrantEnvelope;

  const token = await persistApprovedSingleGrantAtomically({
    accessMode: selection.access_mode,
    aiTrainingConsented,
    clientId: registeredClient.client_id,
    consentApprovedEvent: buildConsentApprovedEventInput({
      deviceCode,
      grantId,
      pending,
      registeredClient,
      request,
      resolvedStreams,
      sourceBinding,
      subjectId,
      traceContext,
    }),
    deviceCode,
    expiresAt,
    grantId,
    grantIssuedEvent: buildGrantIssuedEventInput({
      grant,
      grantId,
      registeredClient,
      request,
      resolvedStreams,
      selection,
      subjectId,
      traceContext,
    }),
    grantJson: JSON.stringify(grant),
    issuedAt,
    persistedStorageBinding,
    reviewedInstanceChecks: reviewedInstanceChecksForGrant({
      acceptedRevisionFulfillment: Boolean(readRetainedSourceDeclarationSnapshot(request).accepted_revision_reference),
      resolvedStreams,
      sourceBinding,
      storageBinding,
      subjectId,
    }),
    reviewedRevision: approvalArtifact.revision,
    subjectId,
    tokenIssuedEvent: (tokenId) =>
      buildTokenIssuedEventInput({
        clientId: registeredClient.client_id,
        grant,
        grantId,
        subjectId,
        tokenId,
        traceContext,
      }),
    traceContext,
  });

  return { grant, token };
}

async function resumeApprovedGrant(
  pending: PendingConsentRow,
  subjectId: string
): Promise<{ grant: DbRow; package?: boolean; package_id?: string; token: string }> {
  if (pending.subject_id !== subjectId || !isNonEmptyString(pending.grant_id) || !isNonEmptyString(pending.token_id)) {
    const err: AuthError = new Error("Approved consent result is not available");
    err.code = "not_found";
    throw err;
  }
  const tokenInfo = await introspect(pending.token_id);
  if (!tokenInfo.active) {
    const err: AuthError = new Error("Approved consent result is not available");
    err.code = "not_found";
    throw err;
  }
  if (tokenInfo.pdpp_token_kind === "mcp_package" && tokenInfo.grant_package_id === pending.grant_id) {
    const packageRow = normalizePackageRow(await getGrantPackageStore().getPackageById(pending.grant_id));
    if (!(packageRow && packageRow.status === "active" && packageRow.subject_id === subjectId)) {
      const err: AuthError = new Error("Approved consent package is not available");
      err.code = "not_found";
      throw err;
    }
    const members = await getGrantPackageStore().listAllMembers(pending.grant_id);
    return {
      grant: buildConsentPackageGrant(pending.grant_id, members),
      package: true,
      package_id: pending.grant_id,
      token: pending.token_id,
    };
  }
  if (tokenInfo.grant_id !== pending.grant_id) {
    const err: AuthError = new Error("Approved consent token is not active");
    err.code = "not_found";
    throw err;
  }
  const row = isPostgresStorageBackend()
    ? await pgOne<DbRow>(
        `SELECT g.grant_id, g.grant_json::text AS grant_json
           FROM grants g
          WHERE g.grant_id = $1 AND g.subject_id = $2 AND g.status = 'active'`,
        [pending.grant_id, subjectId]
      )
    : getOne<DbRow>(referenceQueries.authGrantsGetForRevocation, [pending.grant_id]);
  if (!row || row.status === "revoked" || !isNonEmptyString(row.grant_json)) {
    const err: AuthError = new Error("Approved consent result is not available");
    err.code = "not_found";
    throw err;
  }
  const grant: unknown = JSON.parse(row.grant_json);
  if (!isRecord(grant) || grant.grant_id !== pending.grant_id) {
    throw bindingError("grant_invalid", "Approved consent grant is malformed");
  }
  return { grant, token: pending.token_id };
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
  const payload: Record<string, unknown> = {
    access_token: row.token_id,
    token_type: "Bearer",
    trace_context: getPersistedPendingTraceContext(row),
  };
  if (typeof tokenInfo.exp === "number" && Number.isFinite(tokenInfo.exp)) {
    payload.expires_in = Math.max(tokenInfo.exp - Math.floor(Date.now() / 1000), 0);
  }
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

interface PreparedInitialOAuthRefreshToken {
  readonly clientId: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly familyId: string;
  readonly grantId?: string;
  readonly packageId?: string;
  readonly refreshToken: string;
  readonly refreshTokenHash: string;
  readonly subjectId: string;
}

function prepareInitialOAuthRefreshToken({
  clientId,
  grantId,
  subjectId,
  expiresAt = null,
}: {
  clientId: string;
  grantId: string;
  subjectId: string;
  expiresAt?: string | null;
}): PreparedInitialOAuthRefreshToken {
  const refreshToken = generateOAuthRefreshToken();
  return {
    clientId,
    createdAt: nowIso(),
    expiresAt,
    familyId: generateId("rtf"),
    grantId,
    refreshToken,
    refreshTokenHash: hashOAuthRefreshToken(refreshToken),
    subjectId,
  };
}

function prepareInitialOAuthRefreshTokenForPackage({
  clientId,
  packageId,
  subjectId,
  expiresAt = null,
}: {
  clientId: string;
  packageId: string;
  subjectId: string;
  expiresAt?: string | null;
}): PreparedInitialOAuthRefreshToken {
  const refreshToken = generateOAuthRefreshToken();
  return {
    clientId,
    createdAt: nowIso(),
    expiresAt,
    familyId: generateId("rtf"),
    packageId,
    refreshToken,
    refreshTokenHash: hashOAuthRefreshToken(refreshToken),
    subjectId,
  };
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
              g.grant_id AS persisted_grant_id, g.subject_id AS grant_subject_id,
              g.client_id AS grant_client_id, g.access_mode AS grant_access_mode,
              g.expires_at AS grant_expires_at,
              g.storage_binding_json::text AS storage_binding_json,
              t.grant_id AS token_grant_id, t.subject_id AS token_subject_id,
              t.client_id AS token_client_id, t.revoked AS token_revoked,
              t.expires_at AS token_expires_at
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
              g.status AS grant_status, g.access_mode AS grant_access_mode
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
      `SELECT id, device_code, client_id, redirect_uri, state, status, expires_at,
              code AS issued_code, grant_id, package_id, token_id, issued_at, consumed_at
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
         package_id = NULL,
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

const sqliteRefreshTokenStore: RefreshTokenStore = {
  insert: ({
    refreshTokenHash,
    familyId,
    generation,
    parentGeneration,
    clientId,
    grantId,
    subjectId,
    createdAt,
    expiresAt,
  }) =>
    exec(referenceQueries.authOauthRefreshTokensInsert, [
      refreshTokenHash,
      familyId,
      generation,
      parentGeneration,
      clientId,
      grantId,
      subjectId,
      createdAt,
      expiresAt,
    ]),
  insertForPackage: ({
    refreshTokenHash,
    familyId,
    generation,
    parentGeneration,
    clientId,
    packageId,
    subjectId,
    createdAt,
    expiresAt,
  }) =>
    exec(
      requireMutationQuery(referenceQueries.authOauthRefreshTokensInsertPackage, "authOauthRefreshTokensInsertPackage"),
      [refreshTokenHash, familyId, generation, parentGeneration, clientId, packageId, subjectId, createdAt, expiresAt]
    ),
};

const postgresTokenStore: TokenStore = {
  getIntrospection: (token) =>
    pgOne<TokenIntrospectionRow>(
      `SELECT t.token_id, t.grant_id, t.package_id, t.refresh_family_id,
                CASE
                  WHEN t.refresh_family_id IS NULL THEN NULL
                  ELSE EXISTS(
                    SELECT 1
                    FROM oauth_refresh_tokens rt
                    WHERE rt.family_id = t.refresh_family_id
                      AND rt.status = 'active'
                      AND rt.revoked_at IS NULL
                  )
                END AS refresh_family_active,
                t.subject_id, t.client_id, t.token_kind, t.expires_at, t.revoked,
                g.status AS grant_status,
                g.grant_id AS persisted_grant_id,
                g.subject_id AS grant_subject_id,
                g.client_id AS grant_client_id,
                g.access_mode AS grant_access_mode,
                g.expires_at AS grant_expires_at,
                g.grant_json::text AS grant_json,
                g.trace_id,
                g.scenario_id,
                gp.status AS package_status,
                gp.package_json::text AS package_json,
                gp.trace_id AS package_trace_id,
                gp.scenario_id AS package_scenario_id,
                gp.package_id AS persisted_package_id,
                gp.subject_id AS package_subject_id,
                gp.client_id AS package_client_id,
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
  const packageRow = await getGrantPackageStore().getPackageById(packageId);
  const grantPackage = normalizePackageRow(packageRow);
  if (
    !grantPackage ||
    grantPackage.package_id !== packageId ||
    grantPackage.subject_id !== subjectId ||
    grantPackage.client_id !== clientId
  ) {
    throw buildOAuthAuthorizationCodeError(
      "invalid_grant",
      "Grant package binding is invalid; fresh consent is required"
    );
  }
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

function requireCurrentPackageEnvelope(row: DbRow): Record<string, unknown> | null {
  const envelope = parsePackageJson(row.package_json);
  if (
    !(
      envelope &&
      hasExactBindingKeys(envelope, [
        "approved_source_count",
        "client",
        "package_id",
        "source_bounded_child_grants",
        "subject",
        "version",
      ]) &&
      envelope.version === CURRENT_GRANT_PACKAGE_VERSION &&
      envelope.package_id === row.package_id &&
      envelope.source_bounded_child_grants === true &&
      Number.isInteger(envelope.approved_source_count) &&
      Number(envelope.approved_source_count) > 0 &&
      hasExactBindingKeys(envelope.client, ["client_display", "client_id", "registration_mode"]) &&
      isRecord(envelope.client) &&
      envelope.client.client_id === row.client_id &&
      hasExactBindingKeys(envelope.subject, ["id"]) &&
      isRecord(envelope.subject) &&
      envelope.subject.id === row.subject_id
    )
  ) {
    return null;
  }
  return envelope;
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
  const packageEnvelope = requireCurrentPackageEnvelope(row);
  if (!packageEnvelope) {
    return null;
  }
  return {
    approved_at: row.approved_at,
    client_id: row.client_id,
    created_at: row.created_at,
    package: packageEnvelope,
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
  metadata: Record<string, unknown> | null = null
): Record<string, unknown> | null {
  const source = describeGrantSource(grant);
  if (!source) {
    return null;
  }
  const instanceIds = Array.from(
    new Set(
      (Array.isArray(grant.streams) ? grant.streams : []).flatMap((stream) =>
        isRecord(stream) && Array.isArray(stream.instance_ids) ? stream.instance_ids.filter(isNonEmptyString) : []
      )
    )
  );
  return {
    ...source,
    ...(instanceIds.length === 1 ? { connection_id: instanceIds[0] } : {}),
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
  storageBinding,
  resolvedStreams,
  traceContext,
}: {
  request: PendingRequest;
  registeredClient: RegisteredClient;
  subjectId: string;
  storageBinding: StorageBinding;
  resolvedStreams: ResolvedGrantStream[];
  traceContext: TraceContext;
}): Promise<{ grant: GrantEnvelope; token: string; expiresAt: string | null }> {
  const { selection } = request;

  // Hosted MCP packages never carry ai_training; reject if a client tries.
  if (selection.purpose_code === "https://pdpp.dev/purpose/ai_training") {
    const err: AuthError = new Error("Hosted MCP package consent does not cover ai_training");
    err.code = "invalid_request";
    err.param = "purpose_code";
    throw err;
  }

  const grantId = generateId("grt");
  const issuedAt = nowIso();
  const expiresAt =
    selection.access_mode === "single_use" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;

  const persistedStorageBinding = normalizeStorageBinding(storageBinding);
  const snapshot = readRetainedSourceDeclarationSnapshot(request);

  const grant = materializeCoreResolvedGrant({
    accessMode: selection.access_mode,
    clientId: registeredClient.client_id,
    expiresAt,
    grantId,
    issuedAt,
    purposeCode: selection.purpose_code,
    purposeDescription: selection.purpose_description,
    resolvedStreams,
    retention: selection.retention,
    selectionPreset: selection.selection_preset,
    snapshot: snapshot as unknown as import("./core-source-authorization.ts").RetainedCoreConsentSnapshot,
    subjectId,
  }) as unknown as GrantEnvelope;

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
      ...buildResolvedSnapshotEvidence(request, resolvedStreams),
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
    version: CURRENT_GRANT_PACKAGE_VERSION,
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
    const request = await normalizePendingGrantRequest({ authorization_details: [detail], client_id: clientId }, opts);
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
    await retainSourceDeclarationSnapshot(request, sourceBinding, storageBinding, manifest, opts);
    const resolvedStreams = await resolvePendingRequestForApproval(request, sourceBinding, storageBinding, subjectId);
    const { grant, token } = await persistChildGrantForPackage({
      registeredClient: childRegisteredClient,
      request,
      resolvedStreams,
      storageBinding,
      subjectId,
      traceContext,
    });
    const grantedInstanceIds = Array.from(new Set(grant.streams.flatMap((stream) => stream.instance_ids ?? [])));
    const connectionId = grantedInstanceIds.length === 1 ? (grantedInstanceIds[0] ?? null) : null;
    const source = describePackageMemberSource(grant, sourceMetadata[index]);
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
    const grantSubjectId = isRecord(grantState.grant.subject) ? grantState.grant.subject.id : null;
    const grantClientId = isRecord(grantState.grant.client) ? grantState.grant.client.client_id : null;
    if (
      grantSubjectId !== grantPackage.subject_id ||
      grantClientId !== grantPackage.client_id ||
      row.grant_subject_id !== grantPackage.subject_id ||
      row.grant_client_id !== grantPackage.client_id ||
      row.token_subject_id !== grantPackage.subject_id ||
      row.token_client_id !== grantPackage.client_id
    ) {
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
      `SELECT gp.package_id, gp.subject_id, gp.client_id, gp.status, gp.package_json::text AS package_json,
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

type OAuthAuthorizationCodeBinding =
  | { grantId: string; kind: "grant"; token: string }
  | { kind: "package"; packageId: string; token: string };

function authorizationCodeDelivery(row: OAuthPendingCodeRow): Record<string, unknown> {
  return {
    client_id: row.client_id,
    code: row.issued_code,
    expires_at: row.expires_at,
    redirect_uri: row.redirect_uri,
    state: row.state || null,
  };
}

function issuedCodeMatchesBinding(row: OAuthPendingCodeRow, binding: OAuthAuthorizationCodeBinding): boolean {
  if (row.token_id !== binding.token) {
    return false;
  }
  return binding.kind === "package"
    ? row.package_id === binding.packageId && row.grant_id === null
    : row.grant_id === binding.grantId && row.package_id === null;
}

function recoverIssuedOAuthAuthorizationCode(
  row: OAuthPendingCodeRow | null,
  binding: OAuthAuthorizationCodeBinding
): Record<string, unknown> | null {
  if (!row) {
    return null;
  }
  if (
    row.status !== "issued" ||
    row.consumed_at ||
    isExpired(row) ||
    !isNonEmptyString(row.issued_code) ||
    !issuedCodeMatchesBinding(row, binding)
  ) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "OAuth authorization code delivery is not recoverable");
  }
  return authorizationCodeDelivery(row);
}

async function issueOrRecoverOAuthAuthorizationCode(
  deviceCode: unknown,
  binding: OAuthAuthorizationCodeBinding
): Promise<Record<string, unknown> | null> {
  if (!isNonEmptyString(deviceCode)) {
    return null;
  }
  const oauthCodeStore = getOAuthCodeStore();
  const row = await oauthCodeStore.getByDeviceCode(deviceCode);
  if (row?.status !== "pending") {
    return recoverIssuedOAuthAuthorizationCode(row, binding);
  }
  if (isExpired(row)) {
    await oauthCodeStore.markExpiredByDeviceCode(deviceCode);
    throw buildOAuthAuthorizationCodeError("invalid_request", "OAuth authorization request has expired");
  }

  const code = generateId("oacode");
  const issuedAt = nowIso();
  const expiresAt = expiresInIso(300);
  const updated =
    binding.kind === "package"
      ? await oauthCodeStore.issueForPackageDeviceCode({
          code,
          deviceCode,
          expiresAt,
          issuedAt,
          packageId: binding.packageId,
          token: binding.token,
        })
      : await oauthCodeStore.issueForDeviceCode({
          code,
          deviceCode,
          expiresAt,
          grantId: binding.grantId,
          issuedAt,
          token: binding.token,
        });
  if (!updated.changes) {
    return recoverIssuedOAuthAuthorizationCode(await oauthCodeStore.getByDeviceCode(deviceCode), binding);
  }
  return authorizationCodeDelivery({
    ...row,
    consumed_at: null,
    expires_at: expiresAt,
    grant_id: binding.kind === "grant" ? binding.grantId : null,
    issued_at: issuedAt,
    issued_code: code,
    package_id: binding.kind === "package" ? binding.packageId : null,
    status: "issued",
    token_id: binding.token,
  });
}

export async function issueOAuthAuthorizationCodeForPackageDeviceCode(
  deviceCode: unknown,
  { packageId, token }: { packageId: string; token: string }
): Promise<Record<string, unknown> | null> {
  return await issueOrRecoverOAuthAuthorizationCode(deviceCode, { kind: "package", packageId, token });
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
  return await issueOrRecoverOAuthAuthorizationCode(deviceCode, { grantId, kind: "grant", token });
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

function prepareOAuthRefreshTokenForAuthorizationCode(
  row: OAuthIssuedCodeRow,
  clientId: string,
  tokenInfo: TokenIntrospectionResult & { subject_id: string }
): PreparedInitialOAuthRefreshToken {
  const expiresAt = typeof tokenInfo.exp === "number" ? new Date(tokenInfo.exp * 1000).toISOString() : null;
  if (isNonEmptyString(row.package_id)) {
    return prepareInitialOAuthRefreshTokenForPackage({
      clientId,
      expiresAt,
      packageId: row.package_id,
      subjectId: tokenInfo.subject_id,
    });
  }
  if (!isNonEmptyString(row.grant_id)) {
    throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code is missing its grant binding");
  }
  return prepareInitialOAuthRefreshToken({
    clientId,
    expiresAt,
    grantId: row.grant_id,
    subjectId: tokenInfo.subject_id,
  });
}

async function authorizationCodeBindingSupportsRefresh(
  row: OAuthIssuedCodeRow,
  tokenInfo: TokenIntrospectionResult
): Promise<boolean> {
  if (isNonEmptyString(row.grant_id)) {
    return isRecord(tokenInfo.grant) && tokenInfo.grant.access_mode === "continuous";
  }
  if (!isNonEmptyString(row.package_id)) {
    return false;
  }
  const members = await getGrantPackageStore().listAllMembers(row.package_id);
  return members.length > 0 && members.every((member) => member.grant_access_mode === "continuous");
}

async function consumeOAuthAuthorizationCodeAtomically({
  code,
  consumedAt,
  refresh,
  tokenId,
}: {
  code: string;
  consumedAt: string;
  refresh: PreparedInitialOAuthRefreshToken | null;
  tokenId: string;
}): Promise<void> {
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      const consumed = await client.query(
        `UPDATE oauth_authorization_codes
            SET status = 'consumed', consumed_at = $1
          WHERE code = $2 AND status = 'issued' AND consumed_at IS NULL`,
        [consumedAt, code]
      );
      if (consumed.rowCount !== 1) {
        throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code is invalid or already used");
      }
      if (!refresh) {
        return;
      }
      const accessTokenExpiresAt = refreshAccessTokenExpiresAt(refresh.createdAt, refresh.expiresAt);
      await client.query(
        `INSERT INTO oauth_refresh_tokens(
           refresh_token_hash, family_id, generation, parent_generation, client_id,
           grant_id, package_id, subject_id, status, created_at, expires_at,
           last_used_at, superseded_at, revoked_at
         ) VALUES($1, $2, 0, NULL, $3, $4, $5, $6, 'active', $7, $8, NULL, NULL, NULL)`,
        [
          refresh.refreshTokenHash,
          refresh.familyId,
          refresh.clientId,
          refresh.grantId ?? null,
          refresh.packageId ?? null,
          refresh.subjectId,
          refresh.createdAt,
          refresh.expiresAt,
        ]
      );
      const linked = await client.query(
        `UPDATE tokens
            SET refresh_family_id = $1, expires_at = $2
          WHERE token_id = $3 AND refresh_family_id IS NULL`,
        [refresh.familyId, accessTokenExpiresAt, tokenId]
      );
      if (linked.rowCount !== 1) {
        throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code access token linkage failed");
      }
    });
    return;
  }

  writeTransaction(() => {
    const consumed = exec(referenceQueries.authOauthAuthorizationCodesConsumeCode, [consumedAt, code]);
    if (!consumed.changes) {
      throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code is invalid or already used");
    }
    if (!refresh) {
      return;
    }
    const accessTokenExpiresAt = refreshAccessTokenExpiresAt(refresh.createdAt, refresh.expiresAt);
    if (refresh.packageId) {
      sqliteRefreshTokenStore.insertForPackage({
        clientId: refresh.clientId,
        createdAt: refresh.createdAt,
        expiresAt: refresh.expiresAt,
        familyId: refresh.familyId,
        generation: 0,
        packageId: refresh.packageId,
        parentGeneration: null,
        refreshTokenHash: refresh.refreshTokenHash,
        subjectId: refresh.subjectId,
      });
      const linked = exec(referenceQueries.authTokensLinkRefreshFamily, [
        refresh.familyId,
        accessTokenExpiresAt,
        tokenId,
      ]);
      if (linked.changes !== 1) {
        throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code access token linkage failed");
      }
      return;
    }
    if (!refresh.grantId) {
      throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code is missing its grant binding");
    }
    sqliteRefreshTokenStore.insert({
      clientId: refresh.clientId,
      createdAt: refresh.createdAt,
      expiresAt: refresh.expiresAt,
      familyId: refresh.familyId,
      generation: 0,
      grantId: refresh.grantId,
      parentGeneration: null,
      refreshTokenHash: refresh.refreshTokenHash,
      subjectId: refresh.subjectId,
    });
    const linked = exec(referenceQueries.authTokensLinkRefreshFamily, [
      refresh.familyId,
      accessTokenExpiresAt,
      tokenId,
    ]);
    if (linked.changes !== 1) {
      throw buildOAuthAuthorizationCodeError("invalid_grant", "Authorization code access token linkage failed");
    }
  });
}

async function requireOAuthAuthorizationCodeTokenInfo(
  row: OAuthIssuedCodeRow,
  clientId: string
): Promise<TokenIntrospectionResult & { subject_id: string }> {
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
  return tokenInfo as TokenIntrospectionResult & { subject_id: string };
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

  const response: Record<string, unknown> = {
    access_token: row.token_id,
    token_type: "Bearer",
    ...(row.package_id ? { grant_package_id: row.package_id } : { grant_id: row.grant_id }),
  };

  const tokenInfo = await requireOAuthAuthorizationCodeTokenInfo(row, normalized.clientId);
  if (row.grant_id) {
    response.authorization_details = [buildGrantedAuthorizationDetail(tokenInfo.grant)];
  }
  const refresh =
    clientSupportsOAuthRefreshToken(registeredClient) && (await authorizationCodeBindingSupportsRefresh(row, tokenInfo))
      ? prepareOAuthRefreshTokenForAuthorizationCode(row, normalized.clientId, tokenInfo)
      : null;
  await consumeOAuthAuthorizationCodeAtomically({
    code: normalized.code,
    consumedAt: nowIso(),
    refresh,
    tokenId: row.token_id,
  });
  if (refresh) {
    response.refresh_token = refresh.refreshToken;
    response.access_token_expires_at = refreshAccessTokenExpiresAt(refresh.createdAt, refresh.expiresAt);
  } else if (typeof tokenInfo.exp === "number") {
    response.access_token_expires_at = new Date(tokenInfo.exp * 1000).toISOString();
  }

  return response;
}

type RefreshRotationOutcome =
  | { kind: "invalid" }
  | { kind: "reused" }
  | { accessToken: string; accessTokenExpiresAt: string; kind: "rotated"; row: RefreshTokenRow };

function isCurrentRefreshFamilyRow(row: RefreshTokenRow | null): row is RefreshTokenRow {
  return !!(
    row &&
    isNonEmptyString(row.family_id) &&
    Number.isInteger(row.generation) &&
    row.generation >= 0 &&
    ((row.generation === 0 && row.parent_generation === null) ||
      (row.generation > 0 && row.parent_generation === row.generation - 1))
  );
}

function refreshRowMatchesClientAndLifetime(row: RefreshTokenRow, clientId: string): boolean {
  if (row.client_id !== clientId) {
    return false;
  }
  if (!row.expires_at) {
    return true;
  }
  const expiresAt = Date.parse(row.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function hasRefreshAuthorizationBinding(row: RefreshTokenRow): boolean {
  return isNonEmptyString(row.package_id) !== isNonEmptyString(row.grant_id);
}

function refreshGrantUnavailable(message: string): AuthError {
  return buildOAuthRefreshTokenError("invalid_grant", message);
}

function refreshTokenIssuedEvent({
  grantId,
  packageId,
  persistedGrant,
  row,
  scenarioId,
  tokenId,
  traceId,
}: {
  grantId?: string;
  packageId?: string;
  persistedGrant?: DbRow;
  row: RefreshTokenRow;
  scenarioId?: string | null;
  tokenId: string;
  traceId?: string | null;
}): SpineEventInput {
  return {
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: row.client_id,
    data: {
      issuance_path: "oauth_refresh_token",
      refresh_family_id: row.family_id,
      ...(packageId ? { grant_package_id: packageId } : {}),
      ...(persistedGrant ? { source: describeGrantSource(persistedGrant) } : {}),
      token_kind: packageId ? "mcp_package" : "client",
    },
    event_type: "token.issued",
    ...(grantId ? { grant_id: grantId } : {}),
    object_id: tokenId,
    object_type: "token",
    ...(scenarioId ? { scenario_id: scenarioId } : {}),
    status: "succeeded",
    subject_id: row.subject_id,
    subject_type: "subject",
    token_id: tokenId,
    ...(traceId ? { trace_id: traceId } : {}),
  };
}

interface RefreshAuthorizationRow {
  client_id: string;
  status: string;
  subject_id: string;
}

function refreshAuthorizationRowMatches(
  candidate: RefreshAuthorizationRow | null | undefined,
  refreshRow: RefreshTokenRow
): candidate is RefreshAuthorizationRow {
  return !!(
    candidate &&
    candidate.status === "active" &&
    candidate.client_id === refreshRow.client_id &&
    candidate.subject_id === refreshRow.subject_id
  );
}

function requireRefreshGrantRow(
  candidate: GrantIssuanceRow | null | undefined,
  refreshRow: RefreshTokenRow
): GrantIssuanceRow {
  if (!refreshAuthorizationRowMatches(candidate, refreshRow)) {
    throw refreshGrantUnavailable("Refresh token grant is no longer active");
  }
  return candidate;
}

function requireRefreshPackageRow(
  candidate: GrantPackageListRow | null | undefined,
  refreshRow: RefreshTokenRow
): GrantPackageListRow {
  if (!refreshAuthorizationRowMatches(candidate, refreshRow)) {
    throw refreshGrantUnavailable("Refresh token grant package is no longer active");
  }
  return candidate;
}

function requireRefreshGrantAvailableForConsumption(grantRow: GrantIssuanceRow): void {
  if (grantRow.access_mode !== "single_use") {
    return;
  }
  if (grantRow.consumed) {
    throw refreshGrantUnavailable("Refresh token grant has already been consumed");
  }
}

async function issuePostgresRefreshGrantAccessToken(
  client: PostgresTransactionClient,
  row: RefreshTokenRow,
  grantId: string,
  tokenId: string,
  accessTokenExpiresAt: string
): Promise<string> {
  const grantResult = await client.query<GrantIssuanceRow>(
    `SELECT grant_id AS persisted_grant_id, subject_id AS grant_subject_id,
            client_id AS grant_client_id, access_mode AS grant_access_mode,
            expires_at AS grant_expires_at,
            access_mode, client_id, consumed, status, subject_id, trace_id, scenario_id,
            grant_json::text AS grant_json,
            storage_binding_json::text AS storage_binding_json
       FROM grants
      WHERE grant_id = $1
      FOR UPDATE`,
    [grantId]
  );
  const grantRow = requireRefreshGrantRow(grantResult.rows[0], row);
  requireRefreshGrantAvailableForConsumption(grantRow);
  if (grantRow.access_mode === "single_use") {
    await client.query("UPDATE grants SET consumed = TRUE WHERE grant_id = $1", [grantId]);
  }
  const persistedGrant = requirePersistedGrantState(grantRow).grant;
  await client.query(
    `INSERT INTO tokens(
       token_id, grant_id, refresh_family_id, subject_id, client_id, token_kind, expires_at
     ) VALUES($1, $2, $3, $4, $5, 'client', $6)`,
    [tokenId, grantId, row.family_id, row.subject_id, row.client_id, accessTokenExpiresAt]
  );
  await postgresEmitSpineEventInTransaction(
    client,
    refreshTokenIssuedEvent({
      grantId,
      persistedGrant,
      row,
      scenarioId: grantRow.scenario_id,
      tokenId,
      traceId: grantRow.trace_id,
    })
  );
  return tokenId;
}

async function issuePostgresRefreshPackageAccessToken(
  client: PostgresTransactionClient,
  row: RefreshTokenRow,
  packageId: string,
  tokenId: string,
  accessTokenExpiresAt: string
): Promise<string> {
  const packageResult = await client.query<GrantPackageListRow>(
    `SELECT package_id, subject_id, client_id, status, package_json::text AS package_json,
            parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
       FROM grant_packages
      WHERE package_id = $1
      FOR UPDATE`,
    [packageId]
  );
  const packageRow = requireRefreshPackageRow(packageResult.rows[0], row);
  const members = await client.query<{ access_mode: string }>(
    `SELECT g.access_mode
       FROM grant_package_members gm
       JOIN grants g ON g.grant_id = gm.grant_id
      WHERE gm.package_id = $1`,
    [packageId]
  );
  if (members.rows.length === 0 || members.rows.some((member) => member.access_mode !== "continuous")) {
    throw refreshGrantUnavailable("Refresh token package contains a non-continuous grant");
  }
  await client.query(
    `INSERT INTO tokens(
       token_id, grant_id, package_id, refresh_family_id, subject_id, client_id, token_kind, expires_at
     ) VALUES($1, NULL, $2, $3, $4, $5, 'mcp_package', $6)`,
    [tokenId, packageId, row.family_id, row.subject_id, row.client_id, accessTokenExpiresAt]
  );
  await postgresEmitSpineEventInTransaction(
    client,
    refreshTokenIssuedEvent({
      packageId,
      row,
      scenarioId: packageRow.scenario_id,
      tokenId,
      traceId: packageRow.trace_id,
    })
  );
  return tokenId;
}

async function issuePostgresOAuthRefreshAccessToken(
  client: PostgresTransactionClient,
  row: RefreshTokenRow,
  accessTokenExpiresAt: string
): Promise<string> {
  const tokenId = generateToken();
  if (isNonEmptyString(row.grant_id)) {
    return await issuePostgresRefreshGrantAccessToken(client, row, row.grant_id, tokenId, accessTokenExpiresAt);
  }
  if (isNonEmptyString(row.package_id)) {
    return await issuePostgresRefreshPackageAccessToken(client, row, row.package_id, tokenId, accessTokenExpiresAt);
  }
  throw refreshGrantUnavailable("Refresh token has no authorization binding");
}

function issueSqliteRefreshGrantAccessToken(
  row: RefreshTokenRow,
  grantId: string,
  tokenId: string,
  accessTokenExpiresAt: string
): string {
  const grantRow = requireRefreshGrantRow(
    getOne<GrantIssuanceRow>(referenceQueries.authGrantsGetForIssuance, [grantId]),
    row
  );
  requireRefreshGrantAvailableForConsumption(grantRow);
  if (grantRow.access_mode === "single_use") {
    exec(referenceQueries.authGrantsMarkConsumed, [grantId]);
  }
  const persistedGrant = requirePersistedGrantState(grantRow).grant;
  exec(referenceQueries.authTokensInsertRefreshClient, [
    tokenId,
    grantId,
    row.family_id,
    row.subject_id,
    row.client_id,
    accessTokenExpiresAt,
  ]);
  emitRawSpineEvent(
    refreshTokenIssuedEvent({
      grantId,
      persistedGrant,
      row,
      scenarioId: grantRow.scenario_id,
      tokenId,
      traceId: grantRow.trace_id,
    })
  );
  return tokenId;
}

function issueSqliteRefreshPackageAccessToken(
  row: RefreshTokenRow,
  packageId: string,
  tokenId: string,
  accessTokenExpiresAt: string
): string {
  const packageRow = requireRefreshPackageRow(
    getOne<GrantPackageListRow>(referenceQueries.authGrantPackagesGetById, [packageId]),
    row
  );
  const members = allowUnboundedReadAcknowledged<GrantPackageMemberRow>(
    referenceQueries.authGrantPackageMembersListAllByPackage,
    [packageId]
  );
  if (members.length === 0 || members.some((member) => member.grant_access_mode !== "continuous")) {
    throw refreshGrantUnavailable("Refresh token package contains a non-continuous grant");
  }
  exec(referenceQueries.authTokensInsertRefreshMcpPackage, [
    tokenId,
    packageId,
    row.family_id,
    row.subject_id,
    row.client_id,
    accessTokenExpiresAt,
  ]);
  emitRawSpineEvent(
    refreshTokenIssuedEvent({
      packageId,
      row,
      scenarioId: packageRow.scenario_id,
      tokenId,
      traceId: packageRow.trace_id,
    })
  );
  return tokenId;
}

function issueSqliteOAuthRefreshAccessToken(row: RefreshTokenRow, accessTokenExpiresAt: string): string {
  const tokenId = generateToken();
  if (isNonEmptyString(row.grant_id)) {
    return issueSqliteRefreshGrantAccessToken(row, row.grant_id, tokenId, accessTokenExpiresAt);
  }
  if (isNonEmptyString(row.package_id)) {
    return issueSqliteRefreshPackageAccessToken(row, row.package_id, tokenId, accessTokenExpiresAt);
  }
  throw refreshGrantUnavailable("Refresh token has no authorization binding");
}

async function rotatePostgresOAuthRefreshToken({
  clientId,
  refreshTokenHash,
  rotatedAt,
  successorTokenHash,
}: {
  clientId: string;
  refreshTokenHash: string;
  rotatedAt: string;
  successorTokenHash: string;
}): Promise<RefreshRotationOutcome> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The transaction keeps family validation, bearer issuance, event persistence, and rotation in one rollback boundary.
  return await withPostgresTransaction(async (client) => {
    const familyResult = await client.query<{ family_id: string | null }>(
      `SELECT family_id
         FROM oauth_refresh_tokens
        WHERE refresh_token_hash = $1`,
      [refreshTokenHash]
    );
    const familyId = familyResult.rows[0]?.family_id;
    if (!isNonEmptyString(familyId)) {
      return { kind: "invalid" };
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [familyId]);
    const result = await client.query<RefreshTokenRow>(
      `SELECT refresh_token_hash, family_id, generation, parent_generation, client_id,
              grant_id, package_id, subject_id, status, created_at, expires_at,
              last_used_at, superseded_at, revoked_at
         FROM oauth_refresh_tokens
         WHERE refresh_token_hash = $1
         FOR UPDATE`,
      [refreshTokenHash]
    );
    const row = result.rows[0] ?? null;
    if (
      !(
        isCurrentRefreshFamilyRow(row) &&
        refreshRowMatchesClientAndLifetime(row, clientId) &&
        hasRefreshAuthorizationBinding(row)
      )
    ) {
      return { kind: "invalid" };
    }
    if (row.family_id !== familyId) {
      return { kind: "invalid" };
    }
    if (row.status === "superseded") {
      await client.query(
        `UPDATE oauth_refresh_tokens
            SET status = 'revoked', revoked_at = $1
          WHERE family_id = $2 AND status <> 'revoked'`,
        [rotatedAt, row.family_id]
      );
      await client.query("UPDATE tokens SET revoked = TRUE WHERE refresh_family_id = $1 AND revoked = FALSE", [
        row.family_id,
      ]);
      return { kind: "reused" };
    }
    if (row.status !== "active" || row.revoked_at) {
      return { kind: "invalid" };
    }

    let accessToken: string;
    const accessTokenExpiresAt = refreshAccessTokenExpiresAt(rotatedAt, row.expires_at);
    try {
      accessToken = await issuePostgresOAuthRefreshAccessToken(client, row, accessTokenExpiresAt);
    } catch (error: unknown) {
      if (!(isAuthError(error) && error.code === "invalid_grant")) {
        throw error;
      }
      await client.query(
        `UPDATE oauth_refresh_tokens
            SET status = 'revoked', revoked_at = $1
          WHERE family_id = $2 AND status <> 'revoked'`,
        [rotatedAt, row.family_id]
      );
      await client.query("UPDATE tokens SET revoked = TRUE WHERE refresh_family_id = $1 AND revoked = FALSE", [
        row.family_id,
      ]);
      return { kind: "invalid" };
    }

    const superseded = await client.query(
      `UPDATE oauth_refresh_tokens
          SET status = 'superseded', last_used_at = $1, superseded_at = $1
        WHERE refresh_token_hash = $2 AND status = 'active'`,
      [rotatedAt, refreshTokenHash]
    );
    if (superseded.rowCount !== 1) {
      throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token rotation lost its active generation");
    }
    await client.query(
      `INSERT INTO oauth_refresh_tokens(
         refresh_token_hash, family_id, generation, parent_generation, client_id,
         grant_id, package_id, subject_id, status, created_at, expires_at,
         last_used_at, superseded_at, revoked_at
       ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, NULL, NULL, NULL)`,
      [
        successorTokenHash,
        row.family_id,
        row.generation + 1,
        row.generation,
        row.client_id,
        row.grant_id,
        row.package_id,
        row.subject_id,
        rotatedAt,
        row.expires_at,
      ]
    );
    return { accessToken, accessTokenExpiresAt, kind: "rotated", row };
  });
}

function rotateSqliteOAuthRefreshToken({
  clientId,
  refreshTokenHash,
  rotatedAt,
  successorTokenHash,
}: {
  clientId: string;
  refreshTokenHash: string;
  rotatedAt: string;
  successorTokenHash: string;
}): RefreshRotationOutcome {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The transaction keeps family validation, bearer issuance, event persistence, and rotation in one rollback boundary.
  return writeTransaction(() => {
    const row = getOne<RefreshTokenRow>(referenceQueries.authOauthRefreshTokensGetByToken, [refreshTokenHash]);
    if (
      !(
        isCurrentRefreshFamilyRow(row) &&
        refreshRowMatchesClientAndLifetime(row, clientId) &&
        hasRefreshAuthorizationBinding(row)
      )
    ) {
      return { kind: "invalid" };
    }
    if (row.status === "superseded") {
      exec(referenceQueries.authOauthRefreshTokensRevokeFamily, [rotatedAt, row.family_id]);
      exec(referenceQueries.authTokensRevokeByRefreshFamily, [row.family_id]);
      return { kind: "reused" };
    }
    if (row.status !== "active" || row.revoked_at) {
      return { kind: "invalid" };
    }

    let accessToken: string;
    const accessTokenExpiresAt = refreshAccessTokenExpiresAt(rotatedAt, row.expires_at);
    try {
      accessToken = issueSqliteOAuthRefreshAccessToken(row, accessTokenExpiresAt);
    } catch (error: unknown) {
      if (!(isAuthError(error) && error.code === "invalid_grant")) {
        throw error;
      }
      exec(referenceQueries.authOauthRefreshTokensRevokeFamily, [rotatedAt, row.family_id]);
      exec(referenceQueries.authTokensRevokeByRefreshFamily, [row.family_id]);
      return { kind: "invalid" };
    }

    const superseded = exec(referenceQueries.authOauthRefreshTokensSupersedeActive, [
      rotatedAt,
      rotatedAt,
      refreshTokenHash,
    ]);
    if (superseded.changes !== 1) {
      throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token rotation lost its active generation");
    }
    const successor = {
      clientId: row.client_id,
      createdAt: rotatedAt,
      expiresAt: row.expires_at,
      familyId: row.family_id,
      generation: row.generation + 1,
      parentGeneration: row.generation,
      refreshTokenHash: successorTokenHash,
      subjectId: row.subject_id,
    };
    if (isNonEmptyString(row.package_id)) {
      sqliteRefreshTokenStore.insertForPackage({ ...successor, packageId: row.package_id });
    } else if (isNonEmptyString(row.grant_id)) {
      sqliteRefreshTokenStore.insert({ ...successor, grantId: row.grant_id });
    } else {
      throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token has no authorization binding");
    }
    return { accessToken, accessTokenExpiresAt, kind: "rotated", row };
  });
}

async function rotateOAuthRefreshToken(input: {
  clientId: string;
  refreshTokenHash: string;
  rotatedAt: string;
  successorTokenHash: string;
}): Promise<RefreshRotationOutcome> {
  return await (isPostgresStorageBackend()
    ? rotatePostgresOAuthRefreshToken(input)
    : Promise.resolve(rotateSqliteOAuthRefreshToken(input)));
}

function reusedOAuthRefreshTokenError(): AuthError {
  const error = buildOAuthRefreshTokenError(
    "invalid_grant",
    "Refresh token reuse revoked its family; fresh authorization is required"
  );
  error.fresh_authorization_required = true;
  return error;
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

  const registeredClient = await getRegisteredClient(clientId);
  if (!(registeredClient && clientSupportsOAuthRefreshToken(registeredClient))) {
    throw buildOAuthRefreshTokenError("invalid_grant", "Client is not registered for refresh_token");
  }

  const refreshTokenHash = hashOAuthRefreshToken(refreshToken);
  const successorToken = generateOAuthRefreshToken();
  const rotatedAt = nowIso();
  const outcome = await rotateOAuthRefreshToken({
    clientId,
    refreshTokenHash,
    rotatedAt,
    successorTokenHash: hashOAuthRefreshToken(successorToken),
  });
  if (outcome.kind === "reused") {
    throw reusedOAuthRefreshTokenError();
  }
  if (outcome.kind !== "rotated") {
    throw buildOAuthRefreshTokenError("invalid_grant", "Refresh token is invalid");
  }

  return {
    access_token: outcome.accessToken,
    access_token_expires_at: outcome.accessTokenExpiresAt,
    refresh_token: successorToken,
    token_type: "Bearer",
    ...(outcome.row.package_id ? { grant_package_id: outcome.row.package_id } : { grant_id: outcome.row.grant_id }),
  };
}

const CONSENT_EXCHANGE_CODE_TTL_MS = 5 * 60 * 1000;
const CONSENT_EXCHANGE_CODE_RE = /^cex_[0-9a-f]{64}$/;

function buildConsentPackageGrant(
  packageId: string,
  memberRows: readonly GrantPackageMemberRow[]
): Record<string, unknown> {
  return {
    child_grants: memberRows.map((row) => ({
      grant_id: row.grant_id,
      source: parsePackageJson(row.source_json),
    })),
    grant_id: packageId,
    package: true,
    package_id: packageId,
  };
}

function consentExchangeTokenIsActive(row: ConsentExchangeRow): boolean {
  return (
    !row.token_revoked &&
    (!row.token_expires_at || new Date(row.token_expires_at).getTime() > Date.now()) &&
    Boolean(row.grant_id) !== Boolean(row.package_id)
  );
}

function parseConsentExchangeCodeCredential(code: string): { codeHash: string } | null {
  if (!CONSENT_EXCHANGE_CODE_RE.test(code)) {
    return null;
  }
  return { codeHash: base64UrlSha256(code) };
}

export async function createConsentExchangeCode({
  grantId,
  token,
  grant,
  ttlMs = CONSENT_EXCHANGE_CODE_TTL_MS,
  recoveryProof,
}: {
  grantId: string;
  token: string;
  grant: Record<string, unknown>;
  recoveryProof?: string;
  ttlMs?: number;
}): Promise<string> {
  if (!(grantId && token && isRecord(grant) && (grant.grant_id === grantId || grant.package_id === grantId))) {
    throw new Error("createConsentExchangeCode requires a matching grantId, token, and grant");
  }
  const tokenInfo = await introspect(token);
  const isPackage = tokenInfo.pdpp_token_kind === "mcp_package";
  if (!tokenInfo.active || (isPackage ? tokenInfo.grant_package_id !== grantId : tokenInfo.grant_id !== grantId)) {
    throw new Error("createConsentExchangeCode requires an active token bound to the approved result");
  }
  const codeSecret = `cex_${randomBytes(32).toString("hex")}`;
  const codeHash = base64UrlSha256(codeSecret);
  const proofHash =
    typeof recoveryProof === "string" && recoveryProof.length > 0 ? base64UrlSha256(recoveryProof) : null;
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      await client.query(
        `UPDATE consent_exchange_codes
            SET redeemed_at = $1,
                expires_at = $1
          WHERE token_id = $2
            AND redeemed_at IS NULL`,
        [createdAt, token]
      );
      await client.query(
        `INSERT INTO consent_exchange_codes(
           code_hash, proof_hash, token_id, created_at, expires_at, redeemed_at
         ) VALUES($1, $2, $3, $4, $5, NULL)`,
        [codeHash, proofHash, token, createdAt, expiresAt]
      );
    });
  } else {
    transaction(() => {
      exec(referenceQueries.authConsentExchangeCodesInvalidateOutstandingByToken as MutationQuery, [
        createdAt,
        createdAt,
        token,
      ]);
      exec(referenceQueries.authConsentExchangeCodesInsert, [codeHash, proofHash, token, createdAt, expiresAt]);
    });
  }
  return codeSecret;
}

function consentExchangeProofMatches(row: ConsentExchangeRow, proofHash: string | null): boolean {
  if (!row.proof_hash) {
    return true;
  }
  return proofHash === row.proof_hash;
}

function consentExchangeRedeemedReason(row: ConsentExchangeRow, proofHash: string | null): "consumed" | null {
  if (!row.redeemed_at) {
    return null;
  }
  return row.proof_hash && consentExchangeProofMatches(row, proofHash) ? null : "consumed";
}

async function loadPostgresConsentExchangeGrant(
  client: PostgresTransactionClient,
  row: ConsentExchangeRow
): Promise<
  | { ok: false; reason: "revoked" | "unknown" }
  | { grant: Record<string, unknown>; grantId?: string; ok: true; packageId?: string }
> {
  if (row.grant_id) {
    const grantResult = await client.query<DbRow>(
      `SELECT grant_id, grant_json::text AS grant_json
       FROM grants
      WHERE grant_id = $1 AND status = 'active'
      FOR SHARE`,
      [row.grant_id]
    );
    const grantRow = grantResult.rows[0] || null;
    if (!(grantRow && isNonEmptyString(grantRow.grant_json))) {
      return { ok: false, reason: "revoked" };
    }
    const parsed: unknown = JSON.parse(grantRow.grant_json);
    if (!isRecord(parsed) || parsed.grant_id !== row.grant_id) {
      return { ok: false, reason: "unknown" };
    }
    return { grant: parsed, grantId: row.grant_id, ok: true };
  }
  const packageResult = await client.query<DbRow>(
    `SELECT package_id
     FROM grant_packages
    WHERE package_id = $1 AND status = 'active'
    FOR SHARE`,
    [row.package_id]
  );
  if (!packageResult.rows[0]) {
    return { ok: false, reason: "revoked" };
  }
  const members = await client.query<GrantPackageMemberRow>(
    `SELECT gm.grant_id, gm.source_json::text AS source_json
     FROM grant_package_members gm
    WHERE gm.package_id = $1
    ORDER BY gm.added_at, gm.grant_id`,
    [row.package_id]
  );
  if (!row.package_id) {
    return { ok: false, reason: "unknown" };
  }
  return {
    grant: buildConsentPackageGrant(row.package_id, members.rows),
    ok: true,
    packageId: row.package_id,
  };
}

export async function consumeConsentExchangeCode(
  code: unknown,
  recoveryProof?: unknown
): Promise<{
  ok: boolean;
  reason?: string;
  grantId?: string;
  packageId?: string;
  token?: string;
  grant?: Record<string, unknown>;
}> {
  if (typeof code !== "string" || code.length === 0) {
    return { ok: false, reason: "unknown" };
  }
  const parsedCredential = parseConsentExchangeCodeCredential(code);
  if (!parsedCredential) {
    return { ok: false, reason: "unknown" };
  }
  const { codeHash } = parsedCredential;
  const proofHash =
    typeof recoveryProof === "string" && recoveryProof.length > 0 ? base64UrlSha256(recoveryProof) : null;
  const redeemedAt = nowIso();
  const result = isPostgresStorageBackend()
    ? await withPostgresTransaction(
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This transaction deliberately keeps row lock, active-authority validation, envelope reconstruction, and first-redemption transition in one auditable atomic unit.
        async (client) => {
          const selected = await client.query<ConsentExchangeRow>(
            `SELECT c.code_hash, c.proof_hash, c.token_id, c.created_at, c.expires_at,
                  c.redeemed_at, t.grant_id, t.package_id,
                  t.revoked AS token_revoked, t.expires_at AS token_expires_at
             FROM consent_exchange_codes c
             JOIN tokens t ON t.token_id = c.token_id
            WHERE c.code_hash = $1
            FOR UPDATE OF c, t`,
            [codeHash]
          );
          const row = selected.rows[0] || null;
          if (!row) {
            return { ok: false as const, reason: "unknown" };
          }
          if (!consentExchangeProofMatches(row, proofHash)) {
            return { ok: false as const, reason: row.redeemed_at ? "consumed" : "unknown" };
          }
          if (new Date(row.expires_at).getTime() <= Date.now()) {
            return { ok: false as const, reason: "expired" };
          }
          if (!consentExchangeTokenIsActive(row)) {
            return { ok: false as const, reason: "revoked" };
          }
          const redeemedReason = consentExchangeRedeemedReason(row, proofHash);
          if (redeemedReason) {
            return { ok: false as const, reason: redeemedReason };
          }
          const loaded = await loadPostgresConsentExchangeGrant(client, row);
          if (!loaded.ok) {
            return { ok: false as const, reason: loaded.reason };
          }
          if (!row.redeemed_at) {
            await client.query(
              "UPDATE consent_exchange_codes SET redeemed_at = $1 WHERE code_hash = $2 AND redeemed_at IS NULL",
              [redeemedAt, codeHash]
            );
          }
          return {
            grant: loaded.grant,
            ok: true as const,
            token: row.token_id,
            ...(loaded.packageId ? { packageId: loaded.packageId } : { grantId: loaded.grantId as string }),
          };
        }
      )
    : transaction(
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SQLite mirrors the PostgreSQL atomic unit so authority validation and first redemption cannot be split across transactions.
        () => {
          const row = getOne<ConsentExchangeRow>(referenceQueries.authConsentExchangeCodesGetForRedemption, [codeHash]);
          if (!row) {
            return { ok: false as const, reason: "unknown" };
          }
          if (!consentExchangeProofMatches(row, proofHash)) {
            return { ok: false as const, reason: row.redeemed_at ? "consumed" : "unknown" };
          }
          if (new Date(row.expires_at).getTime() <= Date.now()) {
            return { ok: false as const, reason: "expired" };
          }
          if (!consentExchangeTokenIsActive(row)) {
            return { ok: false as const, reason: "revoked" };
          }
          const redeemedReason = consentExchangeRedeemedReason(row, proofHash);
          if (redeemedReason) {
            return { ok: false as const, reason: redeemedReason };
          }
          let grant: Record<string, unknown>;
          let grantId: string | undefined;
          let packageId: string | undefined;
          if (row.grant_id) {
            const grantRow = getOne<DbRow>(referenceQueries.authGrantsGetForRevocation, [row.grant_id]);
            if (!(grantRow && grantRow.status === "active" && isNonEmptyString(grantRow.grant_json))) {
              return { ok: false as const, reason: "revoked" };
            }
            const parsed: unknown = JSON.parse(grantRow.grant_json);
            if (!isRecord(parsed) || parsed.grant_id !== row.grant_id) {
              return { ok: false as const, reason: "unknown" };
            }
            grant = parsed;
            grantId = row.grant_id;
          } else {
            const packageRow = sqliteGrantPackageStore.getPackageById(row.package_id || "") as DbRow | null;
            if (!(packageRow && packageRow.status === "active" && row.package_id)) {
              return { ok: false as const, reason: "revoked" };
            }
            const members = sqliteGrantPackageStore.listAllMembers(row.package_id) as readonly GrantPackageMemberRow[];
            packageId = row.package_id;
            grant = buildConsentPackageGrant(packageId, members);
          }
          if (!row.redeemed_at) {
            exec(referenceQueries.authConsentExchangeCodesMarkRedeemed, [redeemedAt, codeHash]);
          }
          return {
            grant,
            ok: true as const,
            token: row.token_id,
            ...(packageId ? { packageId } : { grantId: grantId as string }),
          };
        }
      );
  return result;
}

/**
 * Deny and clear a pending grant request
 */
function buildPendingConsentDeniedEventContext(
  request: unknown,
  userCode: string | null | undefined
): { clientId: string; data: Record<string, unknown> } {
  if (isStagedBatchRequest(request)) {
    if (!isNonEmptyString(request.client.client_id) || request.entries.length === 0) {
      throw bindingError("invalid_request", "Batch pending request is malformed");
    }
    const sources = request.entries.map((entry) => {
      const slice = asSingleEntryRequestSlice(request, entry);
      requireStructuredPendingRequestShape(slice);
      return describeSourceBinding(requireStructuredPendingRequestBindings(slice).sourceBinding);
    });
    return {
      clientId: request.client.client_id,
      data: { sources, user_code: userCode },
    };
  }
  requireStructuredPendingRequestShape(request);
  return {
    clientId: request.client.client_id,
    data: {
      source: describeSourceBinding(requireStructuredPendingRequestBindings(request).sourceBinding),
      user_code: userCode,
    },
  };
}

export async function denyGrant(
  deviceCode: string,
  opts: { beforeCasHook?: () => void | Promise<void>; faultHook?: AuthorizationDecisionFaultHook } = {}
): Promise<boolean> {
  const pending = await getPendingConsentRow(deviceCode);
  if (pending?.status !== "pending") {
    return false;
  }
  if (isExpired(pending)) {
    await markPendingConsentExpired(deviceCode);
    return false;
  }
  const request: unknown = JSON.parse(pending.params_json);
  const traceContext = requirePersistedPendingTraceContext(pending);
  const deniedContext = buildPendingConsentDeniedEventContext(request, pending.user_code);
  const deniedEvent: AuthSpineEventInput = {
    actor_id: pending.subject_id || "owner_local",
    actor_type: "subject",
    client_id: deniedContext.clientId,
    data: deniedContext.data,
    event_type: "consent.denied",
    object_id: deviceCode,
    object_type: "pending_consent",
    request_id: traceContext.request_id,
    scenario_id: traceContext.scenario_id,
    status: "denied",
    trace_id: traceContext.trace_id,
  };
  await opts.beforeCasHook?.();
  await getPendingConsentStore().markDeniedAtomically({
    deniedAt: nowIso(),
    deviceCode,
    event: deniedEvent,
    ...(opts.faultHook ? { faultHook: opts.faultHook } : {}),
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
  subjectId = "owner_local",
  opts: { faultHook?: OwnerDeviceApprovalFaultHook } = {}
): Promise<Record<string, unknown>> {
  const pending = await getOwnerDeviceAuthRowByUserCode(userCode);
  if (!pending) {
    const err: AuthError = new Error("Unknown user code");
    err.code = "not_found";
    throw err;
  }

  const traceContext = ownerDeviceTraceContext(pending);
  const token = generateToken();
  const tokenExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  let approved: OwnerDeviceAuthRow;
  try {
    approved = await getOwnerDeviceAuthStore().approveAtomically({
      clientId: pending.client_id,
      consentApprovedEvent: buildOwnerDeviceConsentApprovedEvent({
        clientId: pending.client_id,
        pending,
        subjectId,
        traceContext,
      }),
      deviceCode: pending.device_code,
      expiresAt: tokenExpiresAt,
      faultHook: opts.faultHook,
      pendingSnapshot: pending,
      subjectId,
      tokenId: token,
      tokenIssuedEvent: buildOwnerDeviceTokenIssuedEvent({
        clientId: pending.client_id,
        pending,
        subjectId,
        token,
        traceContext,
      }),
    });
  } catch (err: unknown) {
    if (isOwnerDeviceExpiredError(err)) {
      await markOwnerDeviceAuthExpired(pending.device_code);
    }
    throw err;
  }

  return ownerDeviceApprovalResponse(approved, subjectId);
}

export async function denyOwnerDeviceAuthorization(
  userCode: unknown,
  subjectId = "owner_local",
  opts: { beforeCasHook?: () => void | Promise<void>; faultHook?: AuthorizationDecisionFaultHook } = {}
): Promise<void> {
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

  const rejectedEvent: AuthSpineEventInput = {
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
  };
  await opts.beforeCasHook?.();
  try {
    await getOwnerDeviceAuthStore().markDeniedAtomically({
      deniedAt: nowIso(),
      deviceCode: pending.device_code,
      event: rejectedEvent,
      ...(opts.faultHook ? { faultHook: opts.faultHook } : {}),
    });
  } catch (err: unknown) {
    if (isAuthError(err) && err.code === "approval_conflict") {
      throw attachOwnerDeviceTraceContext(err, pending);
    }
    throw err;
  }
}

function ownerDeviceExchangeError(row: OwnerDeviceAuthRow, code: string, message: string): AuthError {
  const err: AuthError = new Error(message);
  err.code = code;
  return attachOwnerDeviceTraceContext(err, row);
}

function ownerDeviceApprovalResponse(row: OwnerDeviceAuthRow, fallbackSubjectId: string): Record<string, unknown> {
  return {
    access_token: row.token_id,
    expires_in: 365 * 24 * 60 * 60,
    subject_id: row.subject_id || fallbackSubjectId,
    token_type: "Bearer",
  };
}

function ownerDeviceTraceContext(row: OwnerDeviceAuthRow): TraceContext | null {
  if (!(isNonEmptyString(row.trace_id) && isNonEmptyString(row.request_id))) {
    return null;
  }
  return {
    request_id: row.request_id,
    ...(isNonEmptyString(row.scenario_id) ? { scenario_id: row.scenario_id } : {}),
    trace_id: row.trace_id,
  };
}

function ownerDeviceTraceEventFields(
  traceContext: TraceContext | null
): Pick<AuthSpineEventInput, "request_id" | "scenario_id" | "trace_id"> {
  return traceContext
    ? {
        request_id: traceContext.request_id,
        scenario_id: traceContext.scenario_id,
        trace_id: traceContext.trace_id,
      }
    : {};
}

function buildOwnerDeviceConsentApprovedEvent({
  clientId,
  pending,
  subjectId,
  traceContext,
}: {
  clientId: string;
  pending: OwnerDeviceAuthRow;
  subjectId: string;
  traceContext: TraceContext | null;
}): AuthSpineEventInput {
  return {
    actor_id: subjectId,
    actor_type: "subject",
    client_id: clientId,
    data: {
      issuance_path: "owner_device_flow",
      user_code: pending.user_code,
    },
    event_type: "consent.approved",
    object_id: pending.device_code,
    object_type: "owner_device_auth",
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    ...ownerDeviceTraceEventFields(traceContext),
  };
}

function buildOwnerDeviceTokenIssuedEvent({
  clientId,
  pending,
  subjectId,
  token,
  traceContext,
}: {
  clientId: string;
  pending: OwnerDeviceAuthRow;
  subjectId: string;
  token: string;
  traceContext: TraceContext | null;
}): AuthSpineEventInput {
  return {
    actor_id: "pdpp_as",
    actor_type: "authorization_server",
    client_id: clientId,
    data: {
      issuance_path: "owner_device_flow",
      token_kind: "owner",
      user_code: pending.user_code,
    },
    event_type: "token.issued",
    object_id: token,
    object_type: "token",
    status: "succeeded",
    subject_id: subjectId,
    subject_type: "subject",
    token_id: token,
    ...ownerDeviceTraceEventFields(traceContext),
  };
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
    `SELECT grant_id AS persisted_grant_id, subject_id AS grant_subject_id,
            client_id AS grant_client_id, access_mode AS grant_access_mode,
            expires_at AS grant_expires_at,
            grant_id, subject_id, client_id, access_mode, expires_at,
            consumed, status, trace_id, scenario_id,
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
  const persistedGrant = requirePersistedGrantState(row).grant;
  requirePersistedGrantColumnBindings(persistedGrant, row, "grant_invalid", {
    clientId,
    expiresAt,
    grantId,
    subjectId,
  });
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
    persistedGrant,
    tokenId,
  };
}

function insertSqliteGrantTokenInCurrentTransaction({
  clientId,
  expiresAt,
  grantId,
  subjectId,
}: {
  clientId: string;
  expiresAt: string | null;
  grantId: string;
  subjectId: string;
}): { grantRow: GrantIssuanceRow; persistedGrant: DbRow; tokenId: string } {
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
  const { grant: persistedGrant } = requirePersistedGrantState(grantRow);
  requirePersistedGrantColumnBindings(persistedGrant, grantRow, "grant_invalid", {
    clientId,
    expiresAt,
    grantId,
    subjectId,
  });
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
  return { grantRow, persistedGrant, tokenId };
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
    const { grantRow, persistedGrant, tokenId } = insertSqliteGrantTokenInCurrentTransaction({
      clientId,
      expiresAt,
      grantId,
      subjectId,
    });

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

function inactiveUnsupportedLegacyGrantToken(row: TokenIntrospectionRow): TokenIntrospectionResult {
  return {
    active: false,
    client_id: row.client_id,
    grant_id: row.grant_id,
    inactive_reason: "authorization_state.unsupported_legacy_shape",
    scenario_id: row.scenario_id,
    subject_id: row.subject_id,
    trace_id: row.trace_id,
  };
}

function enrichPackageTokenIntrospection(
  row: TokenIntrospectionRow,
  result: TokenIntrospectionResult
): TokenIntrospectionResult {
  const packageEnvelope = requireCurrentPackageEnvelope(row);
  if (
    !packageEnvelope ||
    row.package_id !== row.persisted_package_id ||
    row.subject_id !== row.package_subject_id ||
    row.client_id !== row.package_client_id
  ) {
    return {
      active: false,
      client_id: row.client_id,
      grant_package_id: row.package_id,
      inactive_reason: "package_invalid",
      scenario_id: row.package_scenario_id,
      subject_id: row.subject_id,
      trace_id: row.package_trace_id,
    };
  }
  result.grant_package_id = row.package_id;
  result.client_id = row.client_id;
  result.package = packageEnvelope;
  result.trace_id = row.package_trace_id;
  result.scenario_id = row.package_scenario_id;
  return result;
}

function enrichClientTokenIntrospection(
  row: TokenIntrospectionRow,
  result: TokenIntrospectionResult
): TokenIntrospectionResult {
  try {
    const { grant: parsedGrant, storageBinding: grantStorageBinding } = requirePersistedGrantState(row);
    result.grant_id = row.grant_id;
    result.client_id = row.client_id;
    result.grant = parsedGrant;
    result.grant_storage_binding = grantStorageBinding;
    result.trace_id = row.trace_id;
    result.scenario_id = row.scenario_id;
    return result;
  } catch (err: unknown) {
    if (isAuthError(err) && err.code === "authorization_state.unsupported_legacy_shape") {
      return inactiveUnsupportedLegacyGrantToken(row);
    }
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

  if (row.refresh_family_id && !row.refresh_family_active) {
    return {
      active: false,
      inactive_reason: "refresh_family_revoked",
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
    pdpp_token_kind: row.token_kind,
    subject_id: row.subject_id,
  };
  if (row.expires_at) {
    result.exp = Math.floor(new Date(row.expires_at).getTime() / 1000);
  }

  if (row.token_kind === "owner" && row.client_id) {
    result.client_id = row.client_id;
  }

  if (row.token_kind === "mcp_package") {
    return enrichPackageTokenIntrospection(row, result);
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

const REVOCATION_INVALID_GRANT_ERROR_CODES = new Set<string | undefined>([
  "authorization_state.unsupported_legacy_shape",
  "grant_invalid",
]);

async function requireRevocablePersistedGrant(
  row: GrantRevocationRow,
  grantId: string,
  context: GrantRevocationContext
): Promise<DbRow> {
  try {
    const { grant } = requirePersistedGrantState(row);
    return grant;
  } catch (err: unknown) {
    if (!(isAuthError(err) && REVOCATION_INVALID_GRANT_ERROR_CODES.has(err.code))) {
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
                grant_id AS persisted_grant_id, subject_id AS grant_subject_id,
                client_id AS grant_client_id, access_mode AS grant_access_mode,
                expires_at AS grant_expires_at,
                grant_id, access_mode, expires_at,
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
