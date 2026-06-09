/**
 * PDPP Authorization Server — grant issuance + token management
 *
 * Simplified AS for the current reference flow:
 * - Implements a real owner device flow for CLI/self-export
 * - Stages PDPP client requests through a PAR-backed pending-consent substrate
 * - Issues opaque bearer tokens (random strings)
 * - Implements RFC 7662-style introspection with PDPP extensions
 */
import { createHash, randomBytes } from 'crypto';
import {
  BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
  BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
} from '@pdpp/reference-contract';
import { getDb, runWithSqliteBusyRetry } from './db.js';
import {
  allowUnboundedReadAcknowledged,
  exec,
  getOne,
  referenceQueries,
  transaction,
} from '../lib/db.ts';
import { createTraceContext, emitSpineEvent } from '../lib/spine.ts';
import {
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresTransaction,
} from './postgres-storage.js';
import {
  canonicalConnectorKey,
  canonicalConnectorKeyFromManifest,
  isConnectorKey,
} from './connector-key.js';
import {
  listActiveBindingsForGrant,
  projectBindingForWire,
} from './connection-identity.js';

function generateToken() {
  return randomBytes(32).toString('hex');
}

function generateOAuthRefreshToken() {
  return `rt_${randomBytes(32).toString('base64url')}`;
}

function hashOAuthRefreshToken(refreshToken) {
  return createHash('sha256').update(String(refreshToken)).digest('base64url');
}

function generateId(prefix = 'id') {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function expiresInIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isExpired(row) {
  return new Date(row.expires_at).getTime() <= Date.now();
}

async function pgOne(sql, params = []) {
  const result = await postgresQuery(sql, params);
  return result.rows[0] || null;
}

async function pgExec(sql, params = []) {
  const result = await postgresQuery(sql, params);
  return { changes: result.rowCount || 0 };
}

let configuredNativeManifest = null;
const LEGACY_LOCAL_CONNECTOR_MANIFEST_ALIASES = new Map([
  ['claude_code', 'claude-code'],
  ['codex', 'codex'],
]);
const PENDING_CONSENT_REQUEST_URI_PREFIX = 'urn:pdpp:pending-consent:';
const SUPPORTED_CLIENT_AUTH_METHODS = new Set(['none']);
const SUPPORTED_DYNAMIC_CLIENT_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);
const SUPPORTED_DYNAMIC_CLIENT_RESPONSE_TYPES = new Set(['code']);
const SUPPORTED_DYNAMIC_CLIENT_APPLICATION_TYPES = new Set(['web', 'native']);
const SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS = new Set(['S256']);
const PKCE_CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const SUPPORTED_REGISTRATION_MODES = new Set(['dynamic', 'pre_registered_public']);
const SUPPORTED_DYNAMIC_CLIENT_METADATA_FIELDS = new Set([
  'application_type',
  'client_name',
  'client_uri',
  'grant_types',
  'logo_uri',
  'policy_uri',
  'redirect_uris',
  'response_types',
  'token_endpoint_auth_method',
  'tos_uri',
]);
const SUPPORTED_PENDING_REQUEST_FIELDS = new Set([
  'authorization_details',
  'client_display',
  'client_id',
  'parent_package_id',
  'scenario_id',
]);
const SUPPORTED_AUTHORIZATION_DETAIL_FIELDS = new Set([
  'access_mode',
  'purpose_code',
  'purpose_description',
  'retention',
  'source',
  'streams',
  'type',
]);
const SUPPORTED_STREAM_SELECTION_FIELDS = new Set([
  'client_claims',
  'connection_id',
  'fields',
  'name',
  'necessity',
  'resources',
  'time_range',
  'view',
]);
const SUPPORTED_NORMALIZED_PENDING_REQUEST_FIELDS = new Set([
  'client',
  'manifest_version',
  'request_kind',
  'request_version',
  'selection',
  'source_binding',
  'storage_binding',
  'trace_context',
]);
const SUPPORTED_PENDING_CLIENT_FIELDS = new Set([
  'client_display',
  'client_id',
]);
const SUPPORTED_ACCESS_MODES = new Set(['single_use', 'continuous']);
const SUPPORTED_PENDING_SELECTION_FIELDS = new Set([
  'access_mode',
  'purpose_code',
  'purpose_description',
  'retention',
  'streams',
  'type',
]);
const SUPPORTED_RANGE_OPERATORS = new Set(['gte', 'gt', 'lte', 'lt']);

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function bindingError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTopLevelSearchableStringField(fieldSchema) {
  const type = fieldSchema?.type;
  if (type === 'string') return true;
  if (!Array.isArray(type) || !type.includes('string')) return false;
  return type.every((entry) => entry === 'string' || entry === 'null');
}

/**
 * Mirror of the records-path cursor-field compatibility check. Kept small and
 * colocated with the validator so authoring mistakes are caught at registration
 * rather than at first read. Must stay in sync with
 * reference-implementation/server/records.js::classifyCursorFieldSqlSupport.
 */
function isReferenceCompatibleCursorSchema(fieldSchema) {
  if (!fieldSchema || typeof fieldSchema !== 'object') return false;
  const rawType = fieldSchema.type;
  const typeList = Array.isArray(rawType) ? rawType : rawType != null ? [rawType] : [];
  const nonNull = typeList.filter((t) => t !== 'null');
  if (nonNull.length !== 1) return false;
  const only = nonNull[0];
  if (only === 'integer' || only === 'number') return true;
  if (only === 'string') {
    return fieldSchema.format === 'date' || fieldSchema.format === 'date-time';
  }
  return false;
}

function isRangeQueryableFieldSchema(fieldSchema) {
  return isReferenceCompatibleCursorSchema(fieldSchema);
}

function nonNullSchemaTypes(schema) {
  const rawType = schema?.type;
  const typeList = Array.isArray(rawType) ? rawType : rawType != null ? [rawType] : [];
  return typeList.filter((type) => type !== 'null');
}

function schemaTypeIncludes(fieldSchema, typeName) {
  const rawType = fieldSchema?.type;
  if (rawType === typeName) return true;
  return Array.isArray(rawType) && rawType.includes(typeName);
}

function validateBlobRefSchemaDeclaration(stream, fieldSchema, code) {
  if (!schemaTypeIncludes(fieldSchema, 'object')) {
    throw invalidConnectorManifest(`Stream '${stream.name}' blob_ref must be an object or nullable object`, code);
  }
  const properties = fieldSchema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw invalidConnectorManifest(`Stream '${stream.name}' blob_ref must declare object properties`, code);
  }
  for (const [fieldName, expectedType] of Object.entries({
    blob_id: 'string',
    mime_type: 'string',
    size_bytes: 'integer',
    sha256: 'string',
  })) {
    if (!properties[fieldName] || properties[fieldName].type !== expectedType) {
      throw invalidConnectorManifest(`Stream '${stream.name}' blob_ref.${fieldName} must be type ${expectedType}`, code);
    }
  }
  const required = Array.isArray(fieldSchema.required) ? fieldSchema.required : [];
  if (!required.includes('blob_id')) {
    throw invalidConnectorManifest(`Stream '${stream.name}' blob_ref must require blob_id`, code);
  }
}

function isNumericAggregateFieldSchema(fieldSchema) {
  const nonNull = nonNullSchemaTypes(fieldSchema);
  return nonNull.length === 1 && (nonNull[0] === 'integer' || nonNull[0] === 'number');
}

function isMinMaxAggregateFieldSchema(fieldSchema) {
  return isReferenceCompatibleCursorSchema(fieldSchema);
}

function isScalarAggregateGroupFieldSchema(fieldSchema) {
  const nonNull = nonNullSchemaTypes(fieldSchema);
  if (nonNull.length !== 1) return false;
  return ['boolean', 'integer', 'number', 'string'].includes(nonNull[0]);
}

// `group_by_time` buckets a date/date-time field with calendar `date_trunc`
// semantics, so the declared field must be a string with format date or
// date-time (nullable variant allowed). See:
//   openspec/changes/add-aggregate-time-buckets-and-distinct
function isTimeBucketAggregateFieldSchema(fieldSchema) {
  const nonNull = nonNullSchemaTypes(fieldSchema);
  if (nonNull.length !== 1 || nonNull[0] !== 'string') return false;
  return fieldSchema?.format === 'date' || fieldSchema?.format === 'date-time';
}

function resolveConfiguredNativeStorageBinding(opts = {}) {
  const nativeManifest = resolveConfiguredNativeManifest(opts);
  const connectorId = nativeManifest?.storage_binding?.connector_id;
  return isNonEmptyString(connectorId) ? { connector_id: connectorId } : null;
}

export function buildPendingConsentRequestUri(deviceCode) {
  return `${PENDING_CONSENT_REQUEST_URI_PREFIX}${deviceCode}`;
}

export function parsePendingConsentRequestUri(requestUri) {
  if (typeof requestUri !== 'string' || !requestUri.startsWith(PENDING_CONSENT_REQUEST_URI_PREFIX)) {
    return null;
  }
  const deviceCode = requestUri.slice(PENDING_CONSENT_REQUEST_URI_PREFIX.length).trim();
  return deviceCode || null;
}

export function buildPendingConsentAuthorizationUrl(requestUri, opts = {}) {
  const baseUrl = opts.baseUrl || process.env.AS_PUBLIC_URL || `http://localhost:${process.env.AS_PORT || '7662'}`;
  return `${baseUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`;
}

export function configureNativeManifest(manifest = null) {
  configuredNativeManifest = manifest ? cloneJson(manifest) : null;
}

/**
 * Return a defensive copy of the currently-configured native manifest, or
 * null when the reference is running in polyfill mode. Diagnostics-only:
 * callers that need the manifest for an auth decision go through
 * getManifestForStorageBinding / getConnectorManifest.
 */
export function getConfiguredNativeManifest() {
  return configuredNativeManifest ? cloneJson(configuredNativeManifest) : null;
}

function resolveConfiguredNativeManifest(opts = {}) {
  return opts.nativeManifest || configuredNativeManifest || null;
}

function normalizeClientDisplay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const next = {
    name: raw.name || null,
    uri: raw.uri || null,
    logo_uri: raw.logo_uri || null,
    policy_uri: raw.policy_uri || null,
    tos_uri: raw.tos_uri || null,
  };
  return Object.values(next).some(Boolean) ? next : null;
}

function normalizeStringArray(value, fieldName) {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    const err = new Error(`${fieldName} must be an array of non-empty strings`);
    err.code = 'invalid_client_metadata';
    throw err;
  }
  return value.map((item) => item.trim());
}

function normalizeUri(value, fieldName) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  try {
    new URL(trimmed);
  } catch {
    const err = new Error(`${fieldName} must be a valid absolute URI`);
    err.code = 'invalid_client_metadata';
    throw err;
  }
  return trimmed;
}

function normalizeUriArray(value, fieldName) {
  const values = normalizeStringArray(value, fieldName);
  if (!values) return undefined;
  return values.map((item) => normalizeUri(item, fieldName));
}

function isLoopbackRedirectHost(hostname) {
  // URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]"); strip the
  // brackets before comparing so IPv6 loopback is recognized (RFC 8252).
  const normalized = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

function isLoopbackHttpRedirectUri(redirectUri) {
  const parsed = new URL(redirectUri);
  return parsed.protocol === 'http:' && isLoopbackRedirectHost(parsed.hostname);
}

function inferApplicationTypeFromRedirectUris(redirectUris = []) {
  return redirectUris.some((redirectUri) => isLoopbackHttpRedirectUri(redirectUri)) ? 'native' : undefined;
}

function validateAuthorizationCodeRedirectUris(redirectUris = [], applicationType = 'web') {
  for (const redirectUri of redirectUris) {
    const parsed = new URL(redirectUri);
    if (applicationType === 'native' && parsed.protocol === 'http:' && isLoopbackRedirectHost(parsed.hostname)) {
      continue;
    }
    if (parsed.protocol !== 'https:') {
      const err = new Error(
        applicationType === 'native'
          ? 'authorization_code redirect_uris must use https, or loopback http for native clients'
          : 'authorization_code redirect_uris must use https for web clients',
      );
      err.code = 'invalid_client_metadata';
      throw err;
    }
  }
}

function normalizeClientRegistrationMetadata(input = {}) {
  const tokenEndpointAuthMethod = input.token_endpoint_auth_method || 'none';
  if (!SUPPORTED_CLIENT_AUTH_METHODS.has(tokenEndpointAuthMethod)) {
    const err = new Error(`Unsupported token_endpoint_auth_method: ${tokenEndpointAuthMethod}`);
    err.code = 'invalid_client_metadata';
    throw err;
  }

  if (input.client_secret != null) {
    const err = new Error('client_secret must not be supplied; the current reference only registers public clients');
    err.code = 'invalid_client_metadata';
    throw err;
  }

  const unsupportedFields = Object.keys(input).filter((field) => !SUPPORTED_DYNAMIC_CLIENT_METADATA_FIELDS.has(field));
  if (unsupportedFields.length) {
    const err = new Error(`Unsupported client metadata fields: ${unsupportedFields.join(', ')}`);
    err.code = 'invalid_client_metadata';
    throw err;
  }

  const metadata = {
    client_name: typeof input.client_name === 'string' && input.client_name.trim() ? input.client_name.trim() : null,
    redirect_uris: normalizeUriArray(input.redirect_uris, 'redirect_uris'),
    grant_types: normalizeStringArray(input.grant_types, 'grant_types'),
    response_types: normalizeStringArray(input.response_types, 'response_types'),
    application_type: typeof input.application_type === 'string' && input.application_type.trim()
      ? input.application_type.trim()
      : undefined,
    client_uri: normalizeUri(input.client_uri, 'client_uri'),
    logo_uri: normalizeUri(input.logo_uri, 'logo_uri'),
    policy_uri: normalizeUri(input.policy_uri, 'policy_uri'),
    tos_uri: normalizeUri(input.tos_uri, 'tos_uri'),
    token_endpoint_auth_method: tokenEndpointAuthMethod,
  };

  if (metadata.grant_types?.length) {
    const unsupported = metadata.grant_types.filter((type) => !SUPPORTED_DYNAMIC_CLIENT_GRANT_TYPES.has(type));
    if (unsupported.length) {
      const err = new Error(`Unsupported grant_types metadata values: ${unsupported.join(', ')}`);
      err.code = 'invalid_client_metadata';
      throw err;
    }
  }

  if (metadata.response_types?.length) {
    const unsupported = metadata.response_types.filter((type) => !SUPPORTED_DYNAMIC_CLIENT_RESPONSE_TYPES.has(type));
    if (unsupported.length) {
      const err = new Error(`Unsupported response_types metadata values: ${unsupported.join(', ')}`);
      err.code = 'invalid_client_metadata';
      throw err;
    }
  }

  if (metadata.application_type) {
    if (!SUPPORTED_DYNAMIC_CLIENT_APPLICATION_TYPES.has(metadata.application_type)) {
      const err = new Error(`Unsupported application_type metadata value: ${metadata.application_type}`);
      err.code = 'invalid_client_metadata';
      throw err;
    }
  } else if (metadata.redirect_uris?.length) {
    metadata.application_type = inferApplicationTypeFromRedirectUris(metadata.redirect_uris);
  }

  const wantsAuthorizationCode =
    metadata.grant_types?.includes('authorization_code') || metadata.response_types?.includes('code');
  if (metadata.grant_types?.includes('refresh_token') && !metadata.grant_types?.includes('authorization_code')) {
    const err = new Error('refresh_token grant_type requires authorization_code');
    err.code = 'invalid_client_metadata';
    throw err;
  }
  if (wantsAuthorizationCode && !metadata.redirect_uris?.length) {
    const err = new Error('redirect_uris is required for authorization_code clients');
    err.code = 'invalid_client_metadata';
    throw err;
  }
  if (wantsAuthorizationCode) {
    validateAuthorizationCodeRedirectUris(metadata.redirect_uris, metadata.application_type || 'web');
  }

  return {
    client_name: metadata.client_name,
    redirect_uris: metadata.redirect_uris,
    grant_types: metadata.grant_types,
    response_types: metadata.response_types,
    application_type: metadata.application_type,
    client_uri: metadata.client_uri,
    logo_uri: metadata.logo_uri,
    policy_uri: metadata.policy_uri,
    tos_uri: metadata.tos_uri,
    token_endpoint_auth_method: metadata.token_endpoint_auth_method,
  };
}

function buildClientDisplayFromRegistration(metadata = {}) {
  return normalizeClientDisplay({
    name: metadata.client_name,
    uri: metadata.client_uri,
    logo_uri: metadata.logo_uri,
    policy_uri: metadata.policy_uri,
    tos_uri: metadata.tos_uri,
  });
}

function normalizeStreamSelection(stream = {}) {
  return {
    name: stream.name,
    necessity: stream.necessity || undefined,
    view: stream.view || undefined,
    fields: Array.isArray(stream.fields) ? stream.fields : undefined,
    time_range: stream.time_range || undefined,
    resources: Array.isArray(stream.resources) ? stream.resources : undefined,
    client_claims: stream.client_claims || undefined,
    connection_id: typeof stream.connection_id === 'string' && stream.connection_id
      ? stream.connection_id
      : undefined,
  };
}

function isEnvelopeRequest(input) {
  return Array.isArray(input?.authorization_details);
}

function invalidGrantInitiationRequest(message) {
  const err = new Error(message);
  err.code = 'invalid_request';
  throw err;
}

function requireStagedRequestEnvelope(input) {
  if (!input || typeof input !== 'object') {
    invalidGrantInitiationRequest('Grant initiation requires a JSON object body');
  }

  const unsupportedRequestFields = Object.keys(input).filter((field) => !SUPPORTED_PENDING_REQUEST_FIELDS.has(field));
  if (unsupportedRequestFields.length) {
    invalidGrantInitiationRequest(`Unsupported request fields: ${unsupportedRequestFields.join(', ')}`);
  }

  if (!isEnvelopeRequest(input)) {
    invalidGrantInitiationRequest('Grant initiation requires authorization_details');
  }

  if (typeof input.client_id !== 'string' || !input.client_id.trim()) {
    invalidGrantInitiationRequest('Grant initiation requires client_id');
  }

  if (input.authorization_details.length < 1) {
    invalidGrantInitiationRequest('authorization_details must contain at least one entry');
  }

  return input.client_id.trim();
}

function normalizeAuthorizationDetail(detail, index, opts = {}) {
  const invalidRequest = (message) => {
    const err = new Error(message);
    err.code = 'invalid_request';
    throw err;
  };
  const at = `authorization_details[${index}]`;
  if (!detail || detail.type !== 'https://pdpp.org/data-access') {
    invalidRequest('Unsupported authorization_details type');
  }
  if ('connector_id' in detail || 'provider_id' in detail) {
    invalidRequest("authorization_details must use source: { kind: 'connector' | 'provider_native', id }");
  }
  const unsupportedDetailFields = Object.keys(detail).filter((field) => !SUPPORTED_AUTHORIZATION_DETAIL_FIELDS.has(field));
  if (unsupportedDetailFields.length) {
    invalidRequest(`Unsupported authorization_details fields: ${unsupportedDetailFields.join(', ')}`);
  }
  if (!Array.isArray(detail.streams) || detail.streams.length === 0) {
    invalidRequest(`${at}.streams must be a non-empty array`);
  }
  if (!SUPPORTED_ACCESS_MODES.has(detail.access_mode)) {
    invalidRequest(`${at}.access_mode must be "single_use" or "continuous"`);
  }
  for (const stream of detail.streams) {
    if (!stream || typeof stream !== 'object') {
      invalidRequest(`${at}.streams entries must be objects`);
    }
    const unsupportedStreamFields = Object.keys(stream).filter((field) => !SUPPORTED_STREAM_SELECTION_FIELDS.has(field));
    if (unsupportedStreamFields.length) {
      invalidRequest(`Unsupported stream selection fields on '${stream.name || 'unknown'}': ${unsupportedStreamFields.join(', ')}`);
    }
  }

  const nativeManifest = resolveConfiguredNativeManifest(opts);
  const configuredNativeProviderId = nativeManifest?.provider_id || null;
  const configuredNativeStorageBinding = resolveConfiguredNativeStorageBinding(opts);
  const configuredNativeStorageConnectorId = configuredNativeStorageBinding?.connector_id || null;
  const detailSource = detail.source;
  if (!detailSource || typeof detailSource !== 'object' || Array.isArray(detailSource)) {
    invalidRequest(`${at}.source must be { kind: 'connector' | 'provider_native', id }`);
  }
  const detailSourceKeys = Object.keys(detailSource).sort();
  if (detailSourceKeys.length !== 2 || detailSourceKeys[0] !== 'id' || detailSourceKeys[1] !== 'kind') {
    invalidRequest(`${at}.source must include only kind and id`);
  }
  const bindingKind = detailSource.kind;
  const sourceId = detailSource.id;
  if (!['connector', 'provider_native'].includes(bindingKind) || !isNonEmptyString(sourceId)) {
    invalidRequest(`${at}.source.kind must be 'connector' or 'provider_native' and source.id is required`);
  }
  if (bindingKind === 'provider_native' && configuredNativeProviderId && sourceId !== configuredNativeProviderId) {
    invalidRequest(`Unknown source: { kind: 'provider_native', id: '${sourceId}' }`);
  }
  // Normalize URL-shaped first-party connector ids to their canonical short
  // keys at the grant-initiation boundary so pending consents and issued
  // grants always store a canonical connector_id, not a registry URL.
  // Unknown / custom connector ids are preserved as-is (fail open) so
  // third-party manifests continue to work without being in the allowlist.
  const rawSourceConnectorId = bindingKind === 'connector' ? sourceId : configuredNativeStorageConnectorId;
  const resolvedConnectorId = rawSourceConnectorId
    ? (canonicalConnectorKey(rawSourceConnectorId) ?? rawSourceConnectorId)
    : rawSourceConnectorId;
  if (!resolvedConnectorId) {
    invalidRequest(`${at}.source requires configured native storage for provider_native access`);
  }

  // Use the canonical connector id in the source binding too so that
  // source_binding.id === storage_binding.connector_id, which the approval
  // path validates. For provider_native grants the source id is the
  // provider_id (not a connector_id), so we only normalize connector sources.
  const canonicalSourceId = bindingKind === 'connector'
    ? (canonicalConnectorKey(sourceId) ?? sourceId)
    : sourceId;
  const sourceBinding = { kind: bindingKind, id: canonicalSourceId };

  return {
    selection: {
      type: detail.type,
      purpose_code: detail.purpose_code,
      purpose_description: detail.purpose_description || undefined,
      access_mode: detail.access_mode,
      retention: detail.retention || undefined,
      streams: (detail.streams || []).map(normalizeStreamSelection),
    },
    source_binding: sourceBinding,
    storage_binding: { connector_id: resolvedConnectorId },
  };
}

function normalizePendingGrantRequest(input, opts = {}) {
  const clientId = requireStagedRequestEnvelope(input);
  if (input.authorization_details.length !== 1) {
    invalidGrantInitiationRequest('Exactly one authorization_details entry is supported in this flow; use the staged batch path for multi-entry requests');
  }
  // Defensive guard: `initiateGrant` routes parent-linked add-source requests
  // to the staged lineage path, even when they add exactly one source.
  if (input.parent_package_id !== undefined && input.parent_package_id !== null) {
    invalidGrantInitiationRequest('parent_package_id is only supported on the staged batch path');
  }
  const entry = normalizeAuthorizationDetail(input.authorization_details[0], 0, opts);
  return {
    request_kind: 'pdpp_selection_request',
    request_version: 'reference.v1',
    client: {
      client_id: clientId,
      client_display: normalizeClientDisplay(input.client_display),
    },
    selection: entry.selection,
    source_binding: entry.source_binding,
    storage_binding: entry.storage_binding,
  };
}

function normalizeStagedGrantRequestBatch(input, opts = {}) {
  const clientId = requireStagedRequestEnvelope(input);
  const entries = input.authorization_details.map((detail, index) => normalizeAuthorizationDetail(detail, index, opts));
  const entryCount = entries.length;
  const overSoftCap = entryCount > BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP;
  // The soft cap is a reference-contract policy constant, not a hard limit
  // (design.md rejects a hard cap). Over-cap requests are accepted but
  // flagged — never silently truncated — and the over-cap sources are named
  // so the owner sees exactly which sources push past the cap.
  const overCapSources = overSoftCap
    ? entries
        .slice(BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP)
        .map((entry) => describeSourceBinding(entry.source_binding))
    : [];
  return {
    request_kind: 'pdpp_selection_request_batch',
    request_version: 'reference.v1',
    client: {
      client_id: clientId,
      client_display: normalizeClientDisplay(input.client_display),
    },
    entries,
    entry_count: entryCount,
    soft_cap: BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
    warning_threshold: BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
    soft_cap_warning: entryCount >= BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
    over_soft_cap: overSoftCap,
    over_cap_sources: overCapSources,
    // Incremental add-source lineage. `parent_package_id` links this staged
    // batch to a prior same-client package so the dashboard can render a
    // cumulative per-client view. It is grouping/audit metadata, not a new
    // authorization primitive: it never re-issues, widens, or mutates the
    // prior package's child grants. Validity (existence, same client, same
    // owner, active) is enforced at initiation and re-checked at approval,
    // before any new package row or child grant is written.
    parent_package_id: normalizeParentPackageIdInput(input.parent_package_id),
  };
}

function normalizeParentPackageIdInput(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    invalidGrantInitiationRequest('parent_package_id must be a non-empty string when provided');
  }
  return value.trim();
}

function isStagedBatchRequest(request) {
  return request?.request_kind === 'pdpp_selection_request_batch' && Array.isArray(request.entries);
}

function getRequestTraceContext(request, scenarioId) {
  if (request?.trace_context?.trace_id && request?.trace_context?.request_id) {
    return request.trace_context;
  }
  return createTraceContext({ scenarioId });
}

function getPersistedPendingTraceContext(row = {}) {
  if (row?.trace_id && row?.request_id) {
    return {
      request_id: row.request_id,
      trace_id: row.trace_id,
      ...(row.scenario_id ? { scenario_id: row.scenario_id } : {}),
    };
  }
  return null;
}

function requirePersistedPendingTraceContext(row = {}) {
  const traceContext = getPersistedPendingTraceContext(row);
  if (traceContext) return traceContext;
  throw bindingError('invalid_request', 'Pending consent row is missing persisted trace correlation');
}

function getRequestSourceBinding(request = {}) {
  return request.source_binding || null;
}

function getRequestStorageBinding(request = {}) {
  return request.storage_binding?.connector_id ? request.storage_binding : null;
}

function attachTraceContext(err, traceContext) {
  if (traceContext?.trace_id) err.trace_id = traceContext.trace_id;
  if (traceContext?.request_id) err.request_id = traceContext.request_id;
  if (traceContext?.scenario_id) err.scenario_id = traceContext.scenario_id;
  return err;
}

function buildPendingRequestRejectionData(request = {}, pending = {}) {
  return {
    user_code: pending.user_code,
    source: describeSourceBinding(getRequestSourceBinding(request)),
    access_mode: request.selection?.access_mode || null,
    purpose_code: request.selection?.purpose_code || null,
    stream_names: (request.selection?.streams || []).map((stream) => stream.name),
  };
}

async function emitPendingConsentRejected(request, pending, err, opts = {}) {
  const traceContext = getPersistedPendingTraceContext(pending);
  if (!traceContext) {
    return err;
  }
  attachTraceContext(err, traceContext);
  await emitSpineEvent({
    event_type: 'request.rejected',
    trace_id: traceContext.trace_id,
    scenario_id: traceContext.scenario_id,
    request_id: traceContext.request_id,
    actor_type: 'authorization_server',
    actor_id: 'pdpp_as',
    ...(opts.subjectId
      ? {
          subject_type: 'subject',
          subject_id: opts.subjectId,
        }
      : {}),
    object_type: 'pending_consent',
    object_id: pending.device_code,
    status: 'rejected',
    client_id: request.client?.client_id || null,
    data: {
      ...buildPendingRequestRejectionData(request, pending),
      error: {
        code: err.code || 'api_error',
        message: err.message,
      },
    },
  });
  return err;
}

function requireStructuredPendingRequestShape(request = {}) {
  const unsupportedRequestFields = Object.keys(request).filter((field) => !SUPPORTED_NORMALIZED_PENDING_REQUEST_FIELDS.has(field));
  if (unsupportedRequestFields.length) {
    throw bindingError('invalid_request', `Unsupported pending request fields: ${unsupportedRequestFields.join(', ')}`);
  }
  if (request.request_kind !== 'pdpp_selection_request') {
    throw bindingError('invalid_request', 'request_kind must be pdpp_selection_request');
  }
  if (request.request_version !== 'reference.v1') {
    throw bindingError('invalid_request', 'request_version must be reference.v1');
  }
  if (!request.client || typeof request.client !== 'object') {
    throw bindingError('invalid_request', 'client is required');
  }
  const unsupportedClientFields = Object.keys(request.client).filter((field) => !SUPPORTED_PENDING_CLIENT_FIELDS.has(field));
  if (unsupportedClientFields.length) {
    throw bindingError('invalid_request', `Unsupported pending client fields: ${unsupportedClientFields.join(', ')}`);
  }
  if (!isNonEmptyString(request.client.client_id)) {
    throw bindingError('invalid_request', 'client.client_id is required');
  }
  if (!request.selection || typeof request.selection !== 'object') {
    throw bindingError('invalid_request', 'selection is required');
  }
  const unsupportedSelectionFields = Object.keys(request.selection).filter((field) => !SUPPORTED_PENDING_SELECTION_FIELDS.has(field));
  if (unsupportedSelectionFields.length) {
    throw bindingError('invalid_request', `Unsupported pending selection fields: ${unsupportedSelectionFields.join(', ')}`);
  }
  if (request.selection.type !== 'https://pdpp.org/data-access') {
    throw bindingError('invalid_request', 'selection.type must be https://pdpp.org/data-access');
  }
  if (!Array.isArray(request.selection.streams) || request.selection.streams.length === 0) {
    throw bindingError('invalid_request', 'selection.streams must be a non-empty array');
  }
  for (const stream of request.selection.streams) {
    if (!stream || typeof stream !== 'object') {
      throw bindingError('invalid_request', 'selection.streams entries must be objects');
    }
    const unsupportedStreamFields = Object.keys(stream).filter((field) => !SUPPORTED_STREAM_SELECTION_FIELDS.has(field));
    if (unsupportedStreamFields.length) {
      throw bindingError('invalid_request', `Unsupported pending stream selection fields on '${stream.name || 'unknown'}': ${unsupportedStreamFields.join(', ')}`);
    }
  }
}

function requireStructuredSourceBinding(sourceBinding, { code, fieldName }) {
  if (!sourceBinding || typeof sourceBinding !== 'object' || Array.isArray(sourceBinding)) {
    throw bindingError(code, `${fieldName} is required`);
  }
  if (!hasExactBindingKeys(sourceBinding, ['kind', 'id'])) {
    throw bindingError(code, `${fieldName} must include only kind and id`);
  }
  if (!['connector', 'provider_native'].includes(sourceBinding.kind)) {
    throw bindingError(code, `${fieldName}.kind must be 'connector' or 'provider_native'`);
  }
  if (!isNonEmptyString(sourceBinding.id)) {
    throw bindingError(code, `${fieldName}.id is required`);
  }
  return { kind: sourceBinding.kind, id: sourceBinding.id };
}

function requireStructuredStorageBinding(storageBinding, { code, fieldName }) {
  if (!storageBinding || typeof storageBinding !== 'object' || !isNonEmptyString(storageBinding.connector_id)) {
    throw bindingError(code, `${fieldName}.connector_id is required`);
  }
  return { connector_id: storageBinding.connector_id };
}

function hasExactBindingKeys(value, expectedKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpectedKeys.length) return false;
  return sortedExpectedKeys.every((key, index) => actualKeys[index] === key);
}

function requireStructuredPendingRequestBindings(request = {}) {
  const requestSourceBinding = getRequestSourceBinding(request);
  const requestStorageBinding = getRequestStorageBinding(request);
  const sourceBinding = requireStructuredSourceBinding(requestSourceBinding, {
    code: 'invalid_request',
    fieldName: 'source_binding',
  });
  const storageBinding = requireStructuredStorageBinding(requestStorageBinding, {
    code: 'invalid_request',
    fieldName: 'storage_binding',
  });
  if (!hasExactBindingKeys(requestStorageBinding, ['connector_id'])) {
    throw bindingError('invalid_request', 'storage_binding must include only connector_id');
  }

  if (
    sourceBinding.kind === 'connector'
    && sourceBinding.id !== storageBinding.connector_id
  ) {
    throw bindingError('invalid_request', 'source_binding.id must match storage_binding.connector_id for connector access');
  }

  if (sourceBinding.kind === 'provider_native') {
    const nativeManifest = resolveConfiguredNativeManifest();
    const nativeStorageBinding = resolveConfiguredNativeStorageBinding();
    if (!nativeManifest?.provider_id || !nativeStorageBinding?.connector_id) {
      throw bindingError('invalid_request', 'native provider access requires a configured native manifest');
    }
    if (sourceBinding.id !== nativeManifest.provider_id) {
      throw bindingError('invalid_request', 'source_binding.id must match the configured native provider');
    }
    if (storageBinding.connector_id !== nativeStorageBinding.connector_id) {
      throw bindingError('invalid_request', 'storage_binding.connector_id must match the configured native storage binding');
    }
  }

  return { sourceBinding, storageBinding };
}

function requireGrantManifestForBindings(sourceBinding, storageBinding, opts = {}) {
  const grantStorageConnectorId = storageBinding?.connector_id || null;
  return getManifestForStorageBinding(storageBinding, opts).then((manifest) => {
    if (manifest) return manifest;
    const source = sourceBinding?.kind && sourceBinding?.id
      ? `{ kind: '${sourceBinding.kind}', id: '${sourceBinding.id}' }`
      : `{ kind: 'connector', id: '${grantStorageConnectorId || 'unknown'}' }`;
    const err = new Error(`Unknown source: ${source}`);
    err.code = 'invalid_request';
    throw err;
  });
}

function resolveGrantSelection(selection = {}, manifest = {}) {
  let streams = selection.streams || [];
  if (streams.length === 1 && streams[0].name === '*') {
    // Expanding the wildcard MUST preserve a per-stream `connection_id`
    // constraint. A wildcard pinned to a connection (the hosted MCP picker's
    // whole-source approval for a chosen sibling connection) means "every
    // stream, but only from this connection" — dropping the pin here would
    // silently fan the grant back in across every connection of the connector.
    const wildcardConnectionId = isNonEmptyString(streams[0].connection_id) ? streams[0].connection_id : null;
    streams = manifest.streams.map((stream) => (
      wildcardConnectionId
        ? { name: stream.name, connection_id: wildcardConnectionId }
        : { name: stream.name }
    ));
  }

  return streams.map((streamRequest) => {
    const manifestStream = manifest.streams.find((stream) => stream.name === streamRequest.name);
    if (!manifestStream) {
      throw bindingError('invalid_request', `Unknown stream: ${streamRequest.name}`);
    }

    if (streamRequest.time_range && !manifestStream.consent_time_field) {
      throw bindingError('invalid_request', `Stream '${streamRequest.name}' does not support time_range (no consent_time_field)`);
    }

    if (streamRequest.view && streamRequest.fields) {
      throw bindingError('invalid_request', `Stream '${streamRequest.name}' view and fields are mutually exclusive`);
    }

    const resolved = { name: streamRequest.name };
    if (streamRequest.view) {
      const viewDef = (manifestStream.views || []).find((view) => view.id === streamRequest.view);
      if (!viewDef) {
        throw bindingError('invalid_request', `Unknown view '${streamRequest.view}' on stream '${streamRequest.name}'`);
      }
      resolved.view = streamRequest.view;
      resolved.fields = viewDef.fields;
    } else if (streamRequest.fields) {
      if (!manifestStream.selection?.fields) {
        throw bindingError('invalid_request', `Stream '${streamRequest.name}' does not support field-level selection`);
      }
      if (
        !Array.isArray(streamRequest.fields)
        || streamRequest.fields.length === 0
        || streamRequest.fields.some((field) => !isNonEmptyString(field))
      ) {
        throw bindingError('invalid_request', `Stream '${streamRequest.name}' fields must be a non-empty array of field names`);
      }
      const allowedFields = new Set(Object.keys(manifestStream.schema?.properties || {}));
      const unknownFields = streamRequest.fields.filter((field) => !allowedFields.has(field));
      if (unknownFields.length) {
        throw bindingError('invalid_request', `Unknown fields on stream '${streamRequest.name}': ${unknownFields.join(', ')}`);
      }
      resolved.fields = streamRequest.fields;
    }
    if (streamRequest.time_range) resolved.time_range = streamRequest.time_range;
    if (streamRequest.resources) resolved.resources = streamRequest.resources;
    if (typeof streamRequest.connection_id === 'string' && streamRequest.connection_id) {
      resolved.connection_id = streamRequest.connection_id;
    }
    return resolved;
  });
}

function requireStructuredGrantBindings(grant = {}, storageBinding) {
  const sourceBinding = requireStructuredSourceBinding(grant?.source, {
    code: 'grant_invalid',
    fieldName: 'grant.source',
  });
  const normalizedStorageBinding = requireStructuredStorageBinding(storageBinding, {
    code: 'grant_invalid',
    fieldName: 'grant_storage_binding',
  });
  if (!hasExactBindingKeys(storageBinding, ['connector_id'])) {
    throw bindingError('grant_invalid', 'grant_storage_binding must include only connector_id');
  }

  if (
    sourceBinding.kind === 'connector'
    && sourceBinding.id !== normalizedStorageBinding.connector_id
  ) {
    throw bindingError('grant_invalid', 'grant.source.id must match grant_storage_binding.connector_id for connector access');
  }

  if (sourceBinding.kind === 'provider_native') {
    const nativeManifest = resolveConfiguredNativeManifest();
    const nativeStorageBinding = resolveConfiguredNativeStorageBinding();
    if (!nativeManifest?.provider_id || !nativeStorageBinding?.connector_id) {
      throw bindingError('grant_invalid', 'provider-native grants require a configured native manifest');
    }
    if (sourceBinding.id !== nativeManifest.provider_id) {
      throw bindingError('grant_invalid', 'grant.source.id must match the configured native provider');
    }
    if (normalizedStorageBinding.connector_id !== nativeStorageBinding.connector_id) {
      throw bindingError('grant_invalid', 'grant_storage_binding.connector_id must match the configured native storage binding');
    }
  }

  return { sourceBinding, storageBinding: normalizedStorageBinding };
}

function describeSourceBinding(sourceBinding) {
  if (['connector', 'provider_native'].includes(sourceBinding?.kind) && isNonEmptyString(sourceBinding.id)) {
    return { kind: sourceBinding.kind, id: sourceBinding.id };
  }
  return null;
}

function describeGrantSource(grant) {
  return describeSourceBinding(grant?.source);
}

// Hosted MCP grant packages persist a `connection_id` on each member's
// `source_json`, so package consumers (e.g., the MCP fan-out search) can
// disambiguate child grants whose `{kind,id}` source binding alone collides
// — e.g., two Codex connections under the same connector. The grant
// storage_binding itself stays `{connector_id}` only, per main's invariant
// (see `requireStructuredStorageBinding`).
function enrichSourceWithConnectionId(source, connectionId) {
  if (!source || typeof source !== 'object') return source;
  if (source.connection_id || !isNonEmptyString(connectionId)) return source;
  return { ...source, connection_id: connectionId };
}

function normalizeStorageBinding(storageBinding) {
  if (!storageBinding?.connector_id) return null;
  return { connector_id: storageBinding.connector_id };
}

function serializeStorageBinding(storageBinding) {
  return storageBinding ? JSON.stringify(storageBinding) : null;
}

function parseStorageBindingJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.connector_id ? parsed : null;
  } catch {
    return null;
  }
}

function readPersistedGrantStorageBinding(row = {}) {
  return parseStorageBindingJson(row.storage_binding_json);
}

function describePersistedGrantSource(row = {}) {
  try {
    const grant = JSON.parse(row.grant_json);
    const sourceBinding = requireStructuredSourceBinding(grant?.source, {
      code: 'grant_invalid',
      fieldName: 'grant.source',
    });
    return describeSourceBinding(sourceBinding);
  } catch {
    return null;
  }
}

function buildGrantInvalidError(context = {}) {
  const err = new Error('Grant is malformed or no longer valid');
  err.code = 'grant_invalid';
  if (context.request_id) {
    err.request_id = context.request_id;
  }
  if (context.trace_id) {
    err.trace_id = context.trace_id;
  }
  return err;
}

function hasExactFieldSet(fields = [], expectedFields = []) {
  if (!Array.isArray(fields) || !Array.isArray(expectedFields) || fields.length !== expectedFields.length) {
    return false;
  }
  const actual = new Set(fields);
  if (actual.size !== expectedFields.length) return false;
  return expectedFields.every((field) => actual.has(field));
}

export function requireGrantContractAgainstManifest(grant = {}, manifest = {}) {
  if (!isNonEmptyString(grant?.manifest_version)) {
    throw bindingError('grant_invalid', 'grant.manifest_version is required');
  }
  if (!SUPPORTED_ACCESS_MODES.has(grant?.access_mode)) {
    throw bindingError('grant_invalid', 'grant.access_mode must be "single_use" or "continuous"');
  }
  if (!isNonEmptyString(manifest?.version) || grant.manifest_version !== manifest.version) {
    throw bindingError(
      'grant_invalid',
      `grant.manifest_version '${grant.manifest_version}' does not match current manifest version '${manifest?.version || 'unknown'}'`,
    );
  }
  if (!Array.isArray(grant?.streams) || grant.streams.length === 0) {
    throw bindingError('grant_invalid', 'grant.streams must be a non-empty array');
  }

  for (const streamGrant of grant.streams) {
    if (!isNonEmptyString(streamGrant?.name)) {
      throw bindingError('grant_invalid', 'grant.streams entries must include a non-empty name');
    }

    const manifestStream = manifest.streams?.find((stream) => stream.name === streamGrant.name);
    if (!manifestStream) {
      throw bindingError('grant_invalid', `Unknown stream in persisted grant: ${streamGrant.name}`);
    }

    if (streamGrant.time_range && !manifestStream.consent_time_field) {
      throw bindingError(
        'grant_invalid',
        `Persisted grant stream '${streamGrant.name}' does not support time_range (no consent_time_field)`,
      );
    }

    if (streamGrant.view) {
      const viewDef = (manifestStream.views || []).find((view) => view.id === streamGrant.view);
      if (!viewDef) {
        throw bindingError(
          'grant_invalid',
          `Unknown persisted grant view '${streamGrant.view}' on stream '${streamGrant.name}'`,
        );
      }
      if (!Array.isArray(streamGrant.fields) || !streamGrant.fields.length || streamGrant.fields.some((field) => !isNonEmptyString(field))) {
        throw bindingError(
          'grant_invalid',
          `Persisted grant view '${streamGrant.view}' on stream '${streamGrant.name}' must include resolved fields`,
        );
      }
      if (!hasExactFieldSet(streamGrant.fields, viewDef.fields)) {
        throw bindingError(
          'grant_invalid',
          `Persisted grant view '${streamGrant.view}' on stream '${streamGrant.name}' no longer matches the manifest view definition`,
        );
      }
      continue;
    }

    if (!streamGrant.fields) continue;
    if (!manifestStream.selection?.fields) {
      throw bindingError(
        'grant_invalid',
        `Persisted grant stream '${streamGrant.name}' does not support field-level selection`,
      );
    }
    if (
      !Array.isArray(streamGrant.fields)
      || streamGrant.fields.length === 0
      || streamGrant.fields.some((field) => !isNonEmptyString(field))
    ) {
      throw bindingError(
        'grant_invalid',
        `Persisted grant stream '${streamGrant.name}' fields must be a non-empty array of field names`,
      );
    }
    const allowedFields = new Set(Object.keys(manifestStream.schema?.properties || {}));
    const unknownFields = streamGrant.fields.filter((field) => !allowedFields.has(field));
    if (unknownFields.length) {
      throw bindingError(
        'grant_invalid',
        `Unknown fields in persisted grant stream '${streamGrant.name}': ${unknownFields.join(', ')}`,
      );
    }
  }
}

function requirePendingRequestContractAgainstManifest(request = {}, manifest = {}) {
  if (!isNonEmptyString(request?.manifest_version)) {
    throw bindingError('invalid_request', 'pending request manifest_version is required');
  }
  if (!isNonEmptyString(manifest?.version) || request.manifest_version !== manifest.version) {
    throw bindingError(
      'invalid_request',
      `Pending consent request manifest_version '${request.manifest_version}' does not match current manifest version '${manifest?.version || 'unknown'}'`,
    );
  }
  return resolveGrantSelection(request.selection, manifest);
}

async function requirePendingRequestClientRegistration(request = {}) {
  const clientId = request?.client?.client_id || null;
  if (!clientId) {
    throw bindingError('invalid_request', 'client.client_id is required');
  }
  const registeredClient = await getRegisteredClient(clientId);
  if (!registeredClient) {
    throw bindingError('invalid_client', `Unknown client_id: ${clientId}`);
  }
  request.client = {
    ...request.client,
    client_id: clientId,
    client_display: buildClientDisplayFromRegistration(registeredClient.metadata),
  };
  return registeredClient;
}

export function requirePersistedGrantState(row = {}) {
  try {
    const grant = JSON.parse(row.grant_json);
    const bindings = requireStructuredGrantBindings(
      grant,
      readPersistedGrantStorageBinding(row),
    );
    grant.source = describeSourceBinding(bindings.sourceBinding);
    return {
      grant,
      sourceBinding: bindings.sourceBinding,
      storageBinding: bindings.storageBinding,
    };
  } catch {
    throw buildGrantInvalidError();
  }
}

export async function requireResolvedPersistedGrantState(row = {}, opts = {}) {
  try {
    const {
      grant,
      sourceBinding,
      storageBinding,
    } = requirePersistedGrantState(row);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    requireGrantContractAgainstManifest(grant, manifest);
    return {
      grant,
      sourceBinding,
      storageBinding,
      manifest,
    };
  } catch (err) {
    if (err?.code === 'grant_invalid') {
      throw buildGrantInvalidError();
    }
    throw err;
  }
}

async function getPendingConsentRow(deviceCode) {
  if (isPostgresStorageBackend()) {
    return pgOne(
      `SELECT device_code, user_code, params_json::text AS params_json, status,
              subject_id, grant_id, token_id, ai_training_consented,
              request_id, trace_id, scenario_id, created_at, expires_at,
              approved_at, denied_at, approval_id
       FROM pending_consents
       WHERE device_code = $1`,
      [deviceCode],
    );
  }
  return getOne(referenceQueries.authPendingConsentsGetByDeviceCode, [deviceCode]);
}

async function createPendingConsent(deviceCode, userCode, params, expiresAt) {
  const createdAt = nowIso();
  const traceContext = getRequestTraceContext(params);
  // approval_id is the non-redeemable opaque public id for `_ref/approvals`
  // projections. Generated alongside the row so every public read surface
  // has a stable id without exposing the live device_code.
  const approvalId = generateId('appr');
  if (isPostgresStorageBackend()) {
    await pgExec(
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
      ],
    );
    return;
  }
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
  ]);
}

export async function getPendingConsentRowByApprovalId(approvalId) {
  if (typeof approvalId !== 'string' || !approvalId) return null;
  if (isPostgresStorageBackend()) {
    return pgOne(
      `SELECT device_code, user_code, params_json::text AS params_json, status,
              subject_id, grant_id, token_id, ai_training_consented,
              request_id, trace_id, scenario_id, created_at, expires_at,
              approved_at, denied_at, approval_id
       FROM pending_consents
       WHERE approval_id = $1`,
      [approvalId],
    );
  }
  return getOne(referenceQueries.authPendingConsentsGetByApprovalId, [approvalId]);
}

async function markPendingConsentApproved(deviceCode, { subjectId, grantId, tokenId, aiTrainingConsented }) {
  if (isPostgresStorageBackend()) {
    await pgExec(
      `UPDATE pending_consents
       SET status = 'approved',
           subject_id = $1,
           grant_id = $2,
           token_id = $3,
           ai_training_consented = $4,
           approved_at = $5
       WHERE device_code = $6`,
      [subjectId, grantId, tokenId, aiTrainingConsented ? true : null, nowIso(), deviceCode],
    );
    return;
  }
  exec(referenceQueries.authPendingConsentsMarkApproved, [
    subjectId,
    grantId,
    tokenId,
    aiTrainingConsented ? 1 : null,
    nowIso(),
    deviceCode,
  ]);
}

async function markPendingConsentDenied(deviceCode) {
  if (isPostgresStorageBackend()) {
    await pgExec(
      `UPDATE pending_consents
       SET status = 'denied', denied_at = $1
       WHERE device_code = $2 AND status = 'pending'`,
      [nowIso(), deviceCode],
    );
    return;
  }
  exec(referenceQueries.authPendingConsentsMarkDenied, [nowIso(), deviceCode]);
}

async function markPendingConsentExpired(deviceCode) {
  if (isPostgresStorageBackend()) {
    await pgExec(
      "UPDATE pending_consents SET status = 'expired' WHERE device_code = $1 AND status = 'pending'",
      [deviceCode],
    );
    return;
  }
  exec(referenceQueries.authPendingConsentsMarkExpired, [deviceCode]);
}

async function getOwnerDeviceAuthRow(deviceCode) {
  if (isPostgresStorageBackend()) {
    return pgOne(
      `SELECT *
       FROM owner_device_auth
       WHERE device_code = $1`,
      [deviceCode],
    );
  }
  return getOne(referenceQueries.authOwnerDeviceAuthGetByDeviceCode, [deviceCode]);
}

async function getOwnerDeviceAuthRowByUserCode(userCode) {
  if (isPostgresStorageBackend()) {
    return pgOne(
      `SELECT *
       FROM owner_device_auth
       WHERE user_code = $1`,
      [userCode],
    );
  }
  return getOne(referenceQueries.authOwnerDeviceAuthGetByUserCode, [userCode]);
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
}) {
  // approval_id mirrors `pending_consents.approval_id` — see
  // createPendingConsent for rationale.
  const approvalId = generateId('appr');
  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO owner_device_auth(
         device_code, user_code, client_id, status, interval_seconds,
         created_at, expires_at, request_id, trace_id, scenario_id, approval_id
       ) VALUES($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10)`,
      [
        deviceCode,
        userCode,
        clientId,
        intervalSeconds,
        nowIso(),
        expiresAt,
        requestId,
        traceId,
        scenarioId,
        approvalId,
      ],
    );
    return;
  }
  exec(referenceQueries.authOwnerDeviceAuthInsert, [
    deviceCode,
    userCode,
    clientId,
    intervalSeconds,
    nowIso(),
    expiresAt,
    requestId,
    traceId,
    scenarioId,
    approvalId,
  ]);
}

export async function getOwnerDeviceAuthRowByApprovalId(approvalId) {
  if (typeof approvalId !== 'string' || !approvalId) return null;
  if (isPostgresStorageBackend()) {
    return pgOne(
      `SELECT *
       FROM owner_device_auth
       WHERE approval_id = $1`,
      [approvalId],
    );
  }
  return getOne(referenceQueries.authOwnerDeviceAuthGetByApprovalId, [approvalId]);
}

async function markOwnerDeviceAuthApproved(deviceCode, { subjectId, tokenId }) {
  if (isPostgresStorageBackend()) {
    await pgExec(
      `UPDATE owner_device_auth
       SET status = 'approved',
           subject_id = $1,
           token_id = $2,
           approved_at = $3
       WHERE device_code = $4`,
      [subjectId, tokenId, nowIso(), deviceCode],
    );
    return;
  }
  exec(referenceQueries.authOwnerDeviceAuthMarkApproved, [
    subjectId,
    tokenId,
    nowIso(),
    deviceCode,
  ]);
}

async function markOwnerDeviceAuthDenied(deviceCode) {
  if (isPostgresStorageBackend()) {
    await pgExec(
      `UPDATE owner_device_auth
       SET status = 'denied', denied_at = $1
       WHERE device_code = $2 AND status = 'pending'`,
      [nowIso(), deviceCode],
    );
    return;
  }
  exec(referenceQueries.authOwnerDeviceAuthMarkDenied, [nowIso(), deviceCode]);
}

async function markOwnerDeviceAuthExpired(deviceCode) {
  if (isPostgresStorageBackend()) {
    await pgExec(
      "UPDATE owner_device_auth SET status = 'expired' WHERE device_code = $1 AND status = 'pending'",
      [deviceCode],
    );
    return;
  }
  exec(referenceQueries.authOwnerDeviceAuthMarkExpired, [deviceCode]);
}

async function updateOwnerDeviceAuthLastPolled(deviceCode) {
  if (isPostgresStorageBackend()) {
    await pgExec(
      "UPDATE owner_device_auth SET last_polled_at = $1 WHERE device_code = $2",
      [nowIso(), deviceCode],
    );
    return;
  }
  exec(referenceQueries.authOwnerDeviceAuthUpdateLastPolled, [nowIso(), deviceCode]);
}

function buildInvalidRegisteredClientError(clientId) {
  const err = new Error(`Registered client ${clientId} is malformed or no longer valid`);
  err.code = 'invalid_client';
  return err;
}

function attachOwnerDeviceTraceContext(err, row) {
  if (!err || !row) return err;
  if (row.request_id) err.request_id = row.request_id;
  if (row.trace_id) err.trace_id = row.trace_id;
  if (row.scenario_id) err.scenario_id = row.scenario_id;
  return err;
}

function mapRegisteredClientRow(row) {
  if (!row) return null;
  let rawMetadata;
  try {
    rawMetadata = JSON.parse(row.metadata_json);
  } catch {
    throw buildInvalidRegisteredClientError(row.client_id);
  }
  let metadata;
  try {
    // Strip the spec-only client metadata to its supported field set, but
    // re-attach reference-only stamps the route layer added (e.g.
    // `issuer_subject_id` from owner-session-authed DCR). The normalizer
    // strict-rejects unknown fields, so we hold these aside, normalize,
    // then merge them back in.
    const referenceOnlyStamps = {};
    if (typeof rawMetadata?.issuer_subject_id === 'string' && rawMetadata.issuer_subject_id) {
      referenceOnlyStamps.issuer_subject_id = rawMetadata.issuer_subject_id;
    }
    const stripped = { ...rawMetadata };
    delete stripped.issuer_subject_id;
    metadata = normalizeClientRegistrationMetadata(stripped);
    Object.assign(metadata, referenceOnlyStamps);
  } catch {
    throw buildInvalidRegisteredClientError(row.client_id);
  }
  if (metadata.token_endpoint_auth_method !== row.token_endpoint_auth_method) {
    throw buildInvalidRegisteredClientError(row.client_id);
  }
  return {
    client_id: row.client_id,
    registration_mode: row.registration_mode,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    client_secret: row.client_secret || null,
    metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function upsertRegisteredClient({
  clientId,
  registrationMode,
  metadata,
  clientSecret = null,
}) {
  if (!SUPPORTED_REGISTRATION_MODES.has(registrationMode)) {
    const err = new Error(`Unsupported registration mode: ${registrationMode}`);
    err.code = 'invalid_client_metadata';
    throw err;
  }

  // Hold reference-only stamps (e.g. `issuer_subject_id` injected by the
  // owner-session-authed DCR route) aside; the spec normalizer rejects
  // unknown fields, but these stamps must round-trip to disk so downstream
  // listings/deletions can scope by operator. Strip before normalization,
  // re-attach after, persist the merged JSON.
  const referenceOnlyStamps = {};
  if (metadata && typeof metadata.issuer_subject_id === 'string' && metadata.issuer_subject_id) {
    referenceOnlyStamps.issuer_subject_id = metadata.issuer_subject_id;
  }
  const inputForSpecNormalize = { ...metadata };
  delete inputForSpecNormalize.issuer_subject_id;
  const normalizedMetadata = normalizeClientRegistrationMetadata(inputForSpecNormalize);
  const persistedMetadata = { ...normalizedMetadata, ...referenceOnlyStamps };
  const timestamp = nowIso();
  if (isPostgresStorageBackend()) {
    await pgExec(
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
      [
        clientId,
        registrationMode,
        normalizedMetadata.token_endpoint_auth_method,
        clientSecret,
        JSON.stringify(persistedMetadata),
        timestamp,
        timestamp,
      ],
    );
    return;
  }
  exec(referenceQueries.authOauthClientsUpsert, [
    clientId,
    registrationMode,
    normalizedMetadata.token_endpoint_auth_method,
    clientSecret,
    JSON.stringify(persistedMetadata),
    timestamp,
    timestamp,
  ]);
}

export async function seedPreRegisteredClients(clients = [], opts = {}) {
  // Startup seeding races against a sibling process that may still be
  // shutting down (Docker dev compose runs `node --watch`, and `--watch`
  // restart can briefly overlap with the old process's WAL writer). The
  // canonical SQLite `busy_timeout` covers most of this window; the
  // bounded application-level retry below covers the residual gap on
  // slow hosts / bind-mounted volumes where the lock release becomes
  // visible to the new opener fractionally late.
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
  for (const client of clients) {
    if (!client?.client_id) continue;
    if (isPostgresStorageBackend()) {
      await upsertRegisteredClient({
        clientId: client.client_id,
        registrationMode: client.registration_mode || 'pre_registered_public',
        metadata: client.metadata || {
          client_name: client.client_name || client.client_id,
          token_endpoint_auth_method: client.token_endpoint_auth_method || 'none',
        },
        clientSecret: client.client_secret || null,
      });
      continue;
    }
    await runWithSqliteBusyRetry(
      () => upsertRegisteredClient({
        clientId: client.client_id,
        registrationMode: client.registration_mode || 'pre_registered_public',
        metadata: client.metadata || {
          client_name: client.client_name || client.client_id,
          token_endpoint_auth_method: client.token_endpoint_auth_method || 'none',
        },
        clientSecret: client.client_secret || null,
      }),
      { onRetry, ...(opts.retry || {}) },
    );
  }
}

export async function getRegisteredClient(clientId) {
  if (!clientId) return null;
  if (isPostgresStorageBackend()) {
    const row = await pgOne(
      `SELECT client_id, registration_mode, token_endpoint_auth_method,
              client_secret, metadata_json::text AS metadata_json, created_at, updated_at
       FROM oauth_clients
       WHERE client_id = $1`,
      [clientId],
    );
    return mapRegisteredClientRow(row || null);
  }
  const row = getOne(referenceQueries.authOauthClientsGetByClientId, [clientId]);
  return mapRegisteredClientRow(row || null);
}

// ─── CIMD document store ─────────────────────────────────────────────────────

export async function createCimdDocument({ clientName, redirectUris, logoUri } = {}) {
  const { randomBytes: rb } = await import('node:crypto');
  const documentId = `cimd_${rb(12).toString('hex')}`;
  const now = nowIso();
  const redirectUrisJson = JSON.stringify(Array.isArray(redirectUris) ? redirectUris : []);
  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO cimd_client_documents(document_id, client_name, redirect_uris, logo_uri, created_at, updated_at)
       VALUES($1, $2, $3::jsonb, $4, $5, $6)`,
      [documentId, clientName || null, redirectUrisJson, logoUri || null, now, now],
    );
  } else {
    getDb().prepare(
      'INSERT INTO cimd_client_documents(document_id, client_name, redirect_uris, logo_uri, created_at, updated_at) VALUES(?,?,?,?,?,?)',
    ).run(documentId, clientName || null, redirectUrisJson, logoUri || null, now, now);
  }
  return documentId;
}

export async function getCimdDocument(documentId) {
  if (!documentId) return null;
  let row;
  if (isPostgresStorageBackend()) {
    row = await pgOne(
      `SELECT document_id, client_name, redirect_uris::text AS redirect_uris, logo_uri, created_at, updated_at
       FROM cimd_client_documents WHERE document_id = $1`,
      [documentId],
    );
  } else {
    row = getDb().prepare(
      'SELECT document_id, client_name, redirect_uris, logo_uri, created_at, updated_at FROM cimd_client_documents WHERE document_id = ?',
    ).get(documentId);
  }
  if (!row) return null;
  return {
    document_id: row.document_id,
    client_name: row.client_name || null,
    redirect_uris: (() => { try { return JSON.parse(row.redirect_uris); } catch { return []; } })(),
    logo_uri: row.logo_uri || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listCimdDocuments() {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      'SELECT document_id, client_name, redirect_uris::text AS redirect_uris, logo_uri, created_at, updated_at FROM cimd_client_documents ORDER BY created_at DESC',
    );
    return result.rows.map((row) => ({
      document_id: row.document_id,
      client_name: row.client_name || null,
      redirect_uris: (() => { try { return JSON.parse(row.redirect_uris); } catch { return []; } })(),
      logo_uri: row.logo_uri || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }
  const rows = getDb().prepare(
    'SELECT document_id, client_name, redirect_uris, logo_uri, created_at, updated_at FROM cimd_client_documents ORDER BY created_at DESC',
  ).all();
  return rows.map((row) => ({
    document_id: row.document_id,
    client_name: row.client_name || null,
    redirect_uris: (() => { try { return JSON.parse(row.redirect_uris); } catch { return []; } })(),
    logo_uri: row.logo_uri || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function deleteCimdDocument(documentId, { clientId = null, requestId = null, traceId = null } = {}) {
  const { invalidateCimdCache } = await import('./cimd.js');
  const existingDocument = await getCimdDocument(documentId);
  if (!existingDocument) {
    const err = new Error(`CIMD document not found: ${documentId}`);
    err.code = 'not_found';
    throw err;
  }
  let revokeResult = null;
  if (clientId) {
    revokeResult = await revokeClientAccessArtifacts(clientId, {
      requestId,
      traceId,
      subscriptionDisableReason: 'client_deleted',
    });
  }
  if (isPostgresStorageBackend()) {
    const result = await pgExec(
      'DELETE FROM cimd_client_documents WHERE document_id = $1',
      [documentId],
    );
    if ((result.changes ?? 0) === 0) {
      const err = new Error(`CIMD document not found: ${documentId}`);
      err.code = 'not_found';
      throw err;
    }
  } else {
    getDb().prepare('DELETE FROM cimd_client_documents WHERE document_id = ?').run(documentId);
  }
  if (clientId) {
    invalidateCimdCache(clientId);
    await emitSpineEvent({
      event_type: 'client.deleted',
      trace_id: traceId || undefined,
      scenario_id: undefined,
      request_id: requestId || undefined,
      actor_type: 'authorization_server',
      actor_id: 'pdpp_as',
      object_type: 'client',
      object_id: clientId,
      status: 'succeeded',
      client_id: clientId,
      data: {
        registration_mode: 'client_id_metadata_document',
        document_id: documentId,
        revoked_grant_count: revokeResult?.revokedGrantIds.length ?? 0,
        revoked_package_count: revokeResult?.revokedPackageIds.length ?? 0,
        revoked_owner_token_count: revokeResult?.revokedOwnerTokenCount ?? 0,
        disabled_subscription_count: revokeResult?.disabledSubscriptionCount ?? 0,
      },
    });
  } else {
    // Best effort for callers that only know the document id.
    invalidateCimdCache(documentId);
  }
}

async function bindDynamicClientToApprovingOwner(registeredClient, subjectId) {
  if (!(registeredClient?.client_id && subjectId)) {
    return registeredClient;
  }
  if (registeredClient.registration_mode !== 'dynamic') {
    return registeredClient;
  }
  const existingSubject = registeredClient.metadata?.issuer_subject_id || null;
  if (existingSubject) {
    if (existingSubject !== subjectId) {
      const err = new Error('Dynamic client is bound to a different owner subject');
      err.code = 'forbidden';
      throw err;
    }
    return registeredClient;
  }

  await upsertRegisteredClient({
    clientId: registeredClient.client_id,
    registrationMode: registeredClient.registration_mode,
    metadata: {
      ...registeredClient.metadata,
      issuer_subject_id: subjectId,
    },
    clientSecret: registeredClient.client_secret || null,
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
export async function listOwnerIssuedClients(subjectId) {
  if (!subjectId) return [];
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT client_id, client_secret, registration_mode, token_endpoint_auth_method,
              metadata_json::text AS metadata_json, created_at, updated_at
       FROM oauth_clients
       WHERE registration_mode = 'dynamic'
         AND metadata_json->>'issuer_subject_id' = $1
       ORDER BY created_at DESC`,
      [subjectId],
    );
    return Promise.all(result.rows.map(async (row) => {
      const mapped = mapRegisteredClientRow(row);
      if (!mapped) return null;
      const countRow = await pgOne(
        `SELECT COUNT(*)::int AS active_token_count
         FROM tokens
         WHERE client_id = $1 AND revoked = FALSE`,
        [mapped.client_id],
      );
      return {
        client_id: mapped.client_id,
        client_name: mapped.metadata.client_name || null,
        created_at: mapped.created_at,
        active_token_count: countRow ? Number(countRow.active_token_count) || 0 : 0,
      };
    })).then((rows) => rows.filter(Boolean));
  }
  // REVIEWED-BOUNDED: per-operator dashboard-issued tokens are operator-scale
  // (small in practice). The query's @max_rows=256 caps pathological growth.
  const rows = allowUnboundedReadAcknowledged(referenceQueries.authOauthClientsListByIssuerSubject, [subjectId]);
  return rows.map((row) => {
    const mapped = mapRegisteredClientRow(row);
    if (!mapped) return null;
    const countRow = getOne(referenceQueries.authTokensCountActiveByClientId, [mapped.client_id]);
    return {
      client_id: mapped.client_id,
      client_name: mapped.metadata.client_name || null,
      created_at: mapped.created_at,
      active_token_count: countRow ? Number(countRow.active_token_count) || 0 : 0,
    };
  }).filter(Boolean);
}

async function revokeClientAccessArtifacts(
  clientId,
  { requestId, traceId, subscriptionDisableReason = 'client_deleted' } = {},
) {
  // Package refresh tokens are package-bound, not child-grant-bound. Capture
  // active packages before child grants are revoked so client deletion cannot
  // leave refreshable hosted-MCP packages behind.
  const packageRows = isPostgresStorageBackend()
    ? (await postgresQuery(
        `SELECT package_id
         FROM grant_packages
         WHERE client_id = $1 AND status = 'active'
         ORDER BY created_at ASC`,
        [clientId],
      )).rows
    : allowUnboundedReadAcknowledged(referenceQueries.authGrantPackagesListAll, [])
        .filter((row) => row.client_id === clientId && row.status === 'active')
        .map((row) => ({ package_id: row.package_id }));

  // Cascade-revoke any client-token grants tied to this client. Owner self-
  // export tokens (via the device flow) live in `tokens` directly with
  // grant_id=NULL, so they don't show up here — they're handled by the
  // separate token-cascade below.
  // REVIEWED-BOUNDED: per-token clients in operator usage have at most a few
  // active grants. The query's @max_rows=1024 bounds pathological cases.
  const grantRows = isPostgresStorageBackend()
    ? (await postgresQuery(
        `SELECT grant_id
         FROM grants
         WHERE client_id = $1 AND status = 'active'
         ORDER BY issued_at ASC`,
        [clientId],
      )).rows
    : allowUnboundedReadAcknowledged(referenceQueries.authGrantsListActiveIdsByClientId, [clientId]);
  const revokedGrantIds = [];
  for (const row of grantRows) {
    try {
      await revokeGrant(row.grant_id, { request_id: requestId, trace_id: traceId });
      revokedGrantIds.push(row.grant_id);
    } catch (err) {
      // Best-effort revoke: a grant that's already revoked / consumed is
      // not an error for the client-delete cascade. Anything else
      // propagates and aborts the delete (we'd rather leave the client
      // row in place than lie about cascade completeness).
      if (err?.code === 'grant_invalid' || err?.code === 'not_found') {
        continue;
      }
      throw err;
    }
  }

  const revokedPackageIds = [];
  for (const row of packageRows) {
    try {
      const result = await revokeGrantPackage(row.package_id, { request_id: requestId, trace_id: traceId });
      if (result.status !== 'revoked') {
        const err = new Error(`Failed to revoke every child grant in package ${row.package_id}`);
        err.code = 'grant_package_revoke_partial';
        err.result = result;
        throw err;
      }
      revokedPackageIds.push(row.package_id);
    } catch (err) {
      if (err?.code === 'already_revoked' || err?.code === 'not_found') {
        continue;
      }
      throw err;
    }
  }

  // Cascade-revoke any owner self-export tokens issued against this client.
  // This is what makes per-token DCR's "Revoke" button cascade to the bearer
  // for owner tokens (which never have a grant row).
  const tokenRevoke = isPostgresStorageBackend()
    ? await pgExec("UPDATE tokens SET revoked = TRUE WHERE client_id = $1 AND revoked = FALSE", [clientId])
    : exec(referenceQueries.authTokensRevokeByClientId, [clientId]);
  const revokedOwnerTokenCount = tokenRevoke?.changes ?? 0;
  const disabledSubscriptionCount = await disableClientEventSubscriptionsForDeletedClient(
    clientId,
    subscriptionDisableReason,
  );

  return { revokedGrantIds, revokedPackageIds, revokedOwnerTokenCount, disabledSubscriptionCount };
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
export async function deleteRegisteredClient(clientId, { actingSubjectId, requestId, traceId } = {}) {
  if (!clientId) {
    const err = new Error('client_id is required');
    err.code = 'invalid_request';
    throw err;
  }

  const client = await getRegisteredClient(clientId);
  if (!client) {
    const err = new Error(`Unknown client_id: ${clientId}`);
    err.code = 'not_found';
    throw err;
  }
  if (client.registration_mode !== 'dynamic') {
    const err = new Error('Pre-registered clients cannot be deleted via the registration management API');
    err.code = 'forbidden';
    throw err;
  }
  const ownerSubject = client.metadata.issuer_subject_id || null;
  if (!ownerSubject || ownerSubject !== actingSubjectId) {
    const err = new Error('Caller is not the operator who registered this client');
    err.code = 'forbidden';
    throw err;
  }

  const {
    revokedGrantIds,
    revokedPackageIds,
    revokedOwnerTokenCount,
    disabledSubscriptionCount,
  } = await revokeClientAccessArtifacts(clientId, { requestId, traceId });

  if (isPostgresStorageBackend()) {
    await pgExec("DELETE FROM oauth_clients WHERE client_id = $1", [clientId]);
  } else {
    exec(referenceQueries.authOauthClientsDeleteByClientId, [clientId]);
  }

  await emitSpineEvent({
    event_type: 'client.deleted',
    trace_id: traceId,
    scenario_id: undefined,
    request_id: requestId,
    actor_type: 'subject',
    actor_id: actingSubjectId,
    subject_type: 'subject',
    subject_id: actingSubjectId,
    object_type: 'client',
    object_id: clientId,
    status: 'succeeded',
    client_id: clientId,
    data: {
      registration_mode: 'dynamic',
      revoked_grant_count: revokedGrantIds.length,
      revoked_package_count: revokedPackageIds.length,
      revoked_owner_token_count: revokedOwnerTokenCount,
      disabled_subscription_count: disabledSubscriptionCount,
    },
  });

  return { revokedGrantIds, revokedPackageIds, revokedOwnerTokenCount, disabledSubscriptionCount };
}

async function disableClientEventSubscriptionsForDeletedClient(clientId, disabledReason = 'client_deleted') {
  const disabledAt = nowIso();
  if (isPostgresStorageBackend()) {
    const rows = (
      await postgresQuery(
        `SELECT subscription_id, status
           FROM client_event_subscriptions
          WHERE client_id = $1
          ORDER BY created_at ASC`,
        [clientId],
      )
    ).rows;
    let affected = 0;
    for (const row of rows) {
      if (row.status === 'deleted' || row.status === 'disabled_revoked') continue;
      await pgExec(
        `UPDATE client_event_queue
            SET status = 'dropped'
          WHERE subscription_id = $1
            AND status = 'pending'`,
        [row.subscription_id],
      );
      await pgExec(
        `UPDATE client_event_subscriptions
            SET status = 'disabled_revoked',
                updated_at = $1,
                disabled_at = $1,
                disabled_reason = $2
          WHERE subscription_id = $3`,
        [disabledAt, disabledReason, row.subscription_id],
      );
      affected += 1;
    }
    return affected;
  }

  const rows = allowUnboundedReadAcknowledged(referenceQueries.clientEventSubscriptionsListSubscriptionsByClient, [
    clientId,
  ]);
  let affected = 0;
  for (const row of rows) {
    if (row.status === 'deleted' || row.status === 'disabled_revoked') continue;
    exec(referenceQueries.clientEventSubscriptionsDropQueuedForSubscription, [row.subscription_id]);
    exec(referenceQueries.clientEventSubscriptionsUpdateStatus, [
      'disabled_revoked',
      disabledAt,
      disabledAt,
      disabledReason,
      row.subscription_id,
    ]);
    affected += 1;
  }
  return affected;
}

export async function registerDynamicClient(input = {}, extraMetadata = {}) {
  const metadata = normalizeClientRegistrationMetadata(input);

  // Optional reference-only stamps the route layer can pass through after
  // strict spec-field normalization. Today only `issuer_subject_id` is used
  // — the dashboard injects the operator's signed-in subject so
  // `_ref/clients?owner=true` can scope listings/deletions to that operator.
  // Anonymous callers cannot set this because the route never reads the
  // field from the request body — it only honors the owner-session subject.
  // See openspec/changes/dcr-per-owner-token-with-revoke/.
  if (typeof extraMetadata.issuer_subject_id === 'string' && extraMetadata.issuer_subject_id) {
    metadata.issuer_subject_id = extraMetadata.issuer_subject_id;
  }

  const clientId = generateId('cli');
  await upsertRegisteredClient({
    clientId,
    registrationMode: 'dynamic',
    metadata,
    clientSecret: null,
  });
  const registered = await getRegisteredClient(clientId);
  return {
    client_id: registered.client_id,
    client_id_issued_at: Math.floor(new Date(registered.created_at).getTime() / 1000),
    token_endpoint_auth_method: registered.token_endpoint_auth_method,
    client_name: registered.metadata.client_name || null,
    redirect_uris: registered.metadata.redirect_uris || undefined,
    grant_types: registered.metadata.grant_types || undefined,
    response_types: registered.metadata.response_types || undefined,
    application_type: registered.metadata.application_type || undefined,
    client_uri: registered.metadata.client_uri || undefined,
    logo_uri: registered.metadata.logo_uri || undefined,
    policy_uri: registered.metadata.policy_uri || undefined,
    tos_uri: registered.metadata.tos_uri || undefined,
  };
}

function invalidConnectorManifest(message, code = 'invalid_request') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

// Allowed values for the `capabilities.refresh_policy` declaration.
// Kept inline (rather than imported from a shared module) so the
// reference validator stays self-contained: this is reference/polyfill
// metadata, not normative PDPP core protocol, and the vocabulary
// SHOULD be promoted through a Collection Profile or companion spec
// before it is treated as portable across implementations. See
// `openspec/changes/add-connector-refresh-policy-controls/specs/polyfill-runtime/spec.md`.
const REFRESH_POLICY_RECOMMENDED_MODES = new Set(['automatic', 'manual', 'paused']);
const REFRESH_POLICY_INTERACTION_POSTURES = new Set([
  'none',
  'credentials',
  'otp_likely',
  'manual_action_likely',
]);
const REFRESH_POLICY_SENSITIVITY_LEVELS = new Set(['low', 'medium', 'high']);
const REFRESH_POLICY_ALLOWED_KEYS = new Set([
  'recommended_mode',
  'recommended_interval_seconds',
  'minimum_interval_seconds',
  'maximum_staleness_seconds',
  'assisted_after_owner_auth',
  'interaction_posture',
  'session_lifetime_seconds',
  'rate_limit_sensitivity',
  'bot_detection_sensitivity',
  'background_safe',
  'rationale',
]);
const RUNTIME_REQUIREMENT_BINDINGS = new Set(['browser', 'filesystem', 'interactive', 'network']);
const STREAM_AVAILABILITY_STATES = new Set(['supported', 'unsupported_in_mode', 'experimental', 'deprecated']);
const STREAM_AVAILABILITY_ALLOWED_KEYS = new Set(['future_modes', 'mode', 'reason', 'state']);

function validateRuntimeRequirements(manifest, code) {
  const requirements = manifest.runtime_requirements;
  if (requirements === undefined || requirements === null) return;
  if (typeof requirements !== 'object' || Array.isArray(requirements)) {
    throw invalidConnectorManifest('runtime_requirements must be an object when declared', code);
  }
  const bindings = requirements.bindings;
  if (bindings === undefined || bindings === null) return;
  if (typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw invalidConnectorManifest('runtime_requirements.bindings must be an object when declared', code);
  }
  const unknownBindings = Object.keys(bindings).filter((binding) => !RUNTIME_REQUIREMENT_BINDINGS.has(binding));
  if (unknownBindings.length) {
    throw invalidConnectorManifest(
      `runtime_requirements.bindings has unsupported keys: ${unknownBindings.join(', ')}`,
      code,
    );
  }
  for (const [binding, requirement] of Object.entries(bindings)) {
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
      throw invalidConnectorManifest(`runtime_requirements.bindings.${binding} must be an object`, code);
    }
    if (requirement.required !== undefined && typeof requirement.required !== 'boolean') {
      throw invalidConnectorManifest(`runtime_requirements.bindings.${binding}.required must be a boolean`, code);
    }
  }
  const externalTools = requirements.external_tools;
  if (externalTools === undefined || externalTools === null) return;
  if (!Array.isArray(externalTools)) {
    throw invalidConnectorManifest('runtime_requirements.external_tools must be an array when declared', code);
  }
  const allowedToolKeys = new Set(['detect', 'install_hint', 'license', 'min_version', 'name', 'purpose']);
  const seenToolNames = new Set();
  for (const [index, tool] of externalTools.entries()) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      throw invalidConnectorManifest(`runtime_requirements.external_tools[${index}] must be an object`, code);
    }
    const unknownKeys = Object.keys(tool).filter((key) => !allowedToolKeys.has(key));
    if (unknownKeys.length) {
      throw invalidConnectorManifest(
        `runtime_requirements.external_tools[${index}] has unsupported keys: ${unknownKeys.join(', ')}`,
        code,
      );
    }
    for (const fieldName of ['name', 'license', 'purpose']) {
      if (!isNonEmptyString(tool[fieldName])) {
        throw invalidConnectorManifest(
          `runtime_requirements.external_tools[${index}].${fieldName} must be a non-empty string`,
          code,
        );
      }
    }
    if (seenToolNames.has(tool.name)) {
      throw invalidConnectorManifest(`runtime_requirements.external_tools duplicates tool '${tool.name}'`, code);
    }
    seenToolNames.add(tool.name);
    for (const fieldName of ['install_hint', 'min_version']) {
      if (tool[fieldName] !== undefined && !isNonEmptyString(tool[fieldName])) {
        throw invalidConnectorManifest(
          `runtime_requirements.external_tools[${index}].${fieldName} must be a non-empty string`,
          code,
        );
      }
    }
    if (tool.detect !== undefined) {
      if (!tool.detect || typeof tool.detect !== 'object' || Array.isArray(tool.detect)) {
        throw invalidConnectorManifest(`runtime_requirements.external_tools[${index}].detect must be an object`, code);
      }
      if (!isNonEmptyString(tool.detect.command)) {
        throw invalidConnectorManifest(
          `runtime_requirements.external_tools[${index}].detect.command must be a non-empty string`,
          code,
        );
      }
      if (
        tool.detect.exit_code !== undefined
        && (!Number.isInteger(tool.detect.exit_code) || tool.detect.exit_code < 0)
      ) {
        throw invalidConnectorManifest(
          `runtime_requirements.external_tools[${index}].detect.exit_code must be a non-negative integer`,
          code,
        );
      }
    }
  }
}

function validateRefreshPolicyCapability(manifest, code) {
  const capabilities = manifest.capabilities;
  if (capabilities === undefined || capabilities === null) return;
  if (typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw invalidConnectorManifest('capabilities must be an object when declared', code);
  }
  const policy = capabilities.refresh_policy;
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw invalidConnectorManifest('capabilities.refresh_policy must be an object when declared', code);
  }
  const unknownKeys = Object.keys(policy).filter((key) => !REFRESH_POLICY_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(
      `capabilities.refresh_policy has unsupported keys: ${unknownKeys.join(', ')}`,
      code,
    );
  }
  if (!isNonEmptyString(policy.recommended_mode) || !REFRESH_POLICY_RECOMMENDED_MODES.has(policy.recommended_mode)) {
    throw invalidConnectorManifest(
      'capabilities.refresh_policy.recommended_mode must be one of: automatic, manual, paused',
      code,
    );
  }
  if (!isNonEmptyString(policy.rationale)) {
    throw invalidConnectorManifest(
      'capabilities.refresh_policy.rationale must be a non-empty owner-readable string',
      code,
    );
  }
  for (const intervalKey of [
    'recommended_interval_seconds',
    'minimum_interval_seconds',
    'maximum_staleness_seconds',
    'session_lifetime_seconds',
  ]) {
    if (policy[intervalKey] !== undefined && !isPositiveInteger(policy[intervalKey])) {
      throw invalidConnectorManifest(
        `capabilities.refresh_policy.${intervalKey} must be a positive integer when declared`,
        code,
      );
    }
  }
  if (
    policy.recommended_interval_seconds !== undefined
    && policy.minimum_interval_seconds !== undefined
    && policy.recommended_interval_seconds < policy.minimum_interval_seconds
  ) {
    throw invalidConnectorManifest(
      'capabilities.refresh_policy.recommended_interval_seconds must be >= minimum_interval_seconds',
      code,
    );
  }
  if (
    policy.interaction_posture !== undefined
    && (!isNonEmptyString(policy.interaction_posture) || !REFRESH_POLICY_INTERACTION_POSTURES.has(policy.interaction_posture))
  ) {
    throw invalidConnectorManifest(
      'capabilities.refresh_policy.interaction_posture must be one of: none, credentials, otp_likely, manual_action_likely',
      code,
    );
  }
  for (const sensitivityKey of ['rate_limit_sensitivity', 'bot_detection_sensitivity']) {
    if (
      policy[sensitivityKey] !== undefined
      && (!isNonEmptyString(policy[sensitivityKey]) || !REFRESH_POLICY_SENSITIVITY_LEVELS.has(policy[sensitivityKey]))
    ) {
      throw invalidConnectorManifest(
        `capabilities.refresh_policy.${sensitivityKey} must be one of: low, medium, high`,
        code,
      );
    }
  }
  if (policy.background_safe !== undefined && typeof policy.background_safe !== 'boolean') {
    throw invalidConnectorManifest(
      'capabilities.refresh_policy.background_safe must be a boolean when declared',
      code,
    );
  }
  if (policy.assisted_after_owner_auth !== undefined && typeof policy.assisted_after_owner_auth !== 'boolean') {
    throw invalidConnectorManifest(
      'capabilities.refresh_policy.assisted_after_owner_auth must be a boolean when declared',
      code,
    );
  }
}

const MANIFEST_SENSITIVITY_LEVELS = new Set(['standard', 'sensitive']);
const DEFAULT_MANIFEST_SENSITIVITY = 'standard';

function validateManifestSensitivity(manifest, code) {
  const sensitivity = manifest.sensitivity;
  if (sensitivity === undefined) return;
  if (!isNonEmptyString(sensitivity) || !MANIFEST_SENSITIVITY_LEVELS.has(sensitivity)) {
    throw invalidConnectorManifest(
      'sensitivity must be "standard" or "sensitive" when declared',
      code,
    );
  }
}

export function resolveManifestSensitivity(manifest = {}) {
  return manifest?.sensitivity === 'sensitive' ? 'sensitive' : DEFAULT_MANIFEST_SENSITIVITY;
}

function validateStreamExpandDeclarations({
  code,
  manifestStreamsByName,
  schemaProperties,
  stream,
}) {
  const declared = stream.query?.expand;
  if (declared === undefined) return;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw invalidConnectorManifest(`Stream '${stream.name}' query.expand must be a non-empty array`, code);
  }

  const relationships = new Map();
  for (const relationship of stream.relationships || []) {
    if (!isNonEmptyString(relationship?.name)) continue;
    relationships.set(relationship.name, relationship);
  }

  const seen = new Set();
  for (const capability of declared) {
    if (!isNonEmptyString(capability?.name)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand entries must include a non-empty name`, code);
    }
    if (seen.has(capability.name)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand has duplicate entry '${capability.name}'`, code);
    }
    seen.add(capability.name);

    const relationship = relationships.get(capability.name);
    if (!relationship) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand entry '${capability.name}' must match a same-stream relationships[] entry`, code);
    }
    if (!isNonEmptyString(relationship.stream)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' relationship '${relationship.name}' must include a related stream`, code);
    }
    if (!isNonEmptyString(relationship.foreign_key)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' relationship '${relationship.name}' must include a foreign_key`, code);
    }
    if (!['has_one', 'has_many'].includes(relationship.cardinality)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' relationship '${relationship.name}' must use cardinality has_one or has_many`, code);
    }

    const relatedStream = manifestStreamsByName.get(relationship.stream);
    if (!relatedStream) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand entry '${capability.name}' references unknown related stream '${relationship.stream}'`, code);
    }
    const relatedProperties = relatedStream?.schema?.properties;
    if (!relatedProperties || typeof relatedProperties !== 'object' || Array.isArray(relatedProperties)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand entry '${capability.name}' related stream '${relationship.stream}' must include schema.properties`, code);
    }
    if (!Object.prototype.hasOwnProperty.call(relatedProperties, relationship.foreign_key)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand entry '${capability.name}' foreign_key '${relationship.foreign_key}' must be a top-level property on related stream '${relationship.stream}'`, code);
    }

    if (capability.default_limit !== undefined && !isPositiveInteger(capability.default_limit)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand entry '${capability.name}' default_limit must be a positive integer`, code);
    }
    if (capability.max_limit !== undefined && !isPositiveInteger(capability.max_limit)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand entry '${capability.name}' max_limit must be a positive integer`, code);
    }
    if (
      capability.default_limit !== undefined
      && capability.max_limit !== undefined
      && capability.default_limit > capability.max_limit
    ) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand entry '${capability.name}' default_limit must be less than or equal to max_limit`, code);
    }
    if (relationship.cardinality === 'has_one' && (capability.default_limit !== undefined || capability.max_limit !== undefined)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' query.expand entry '${capability.name}' must not declare limits for has_one relationships`, code);
    }

    // The parent stream's schema was already validated above; this extra check
    // keeps the validator close to the runtime's parent-record-key join shape.
    if (!schemaProperties || typeof schemaProperties !== 'object' || Array.isArray(schemaProperties)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' must include schema.properties`, code);
    }
  }
}

function validateStreamAvailabilityDeclaration(stream, code) {
  const availability = stream.availability;
  if (availability === undefined || availability === null) return;
  if (typeof availability !== 'object' || Array.isArray(availability)) {
    throw invalidConnectorManifest(`Stream '${stream.name}' availability must be an object`, code);
  }
  const unknownKeys = Object.keys(availability).filter((key) => !STREAM_AVAILABILITY_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(
      `Stream '${stream.name}' availability has unsupported keys: ${unknownKeys.join(', ')}`,
      code,
    );
  }
  if (!isNonEmptyString(availability.state) || !STREAM_AVAILABILITY_STATES.has(availability.state)) {
    throw invalidConnectorManifest(
      `Stream '${stream.name}' availability.state must be one of: supported, unsupported_in_mode, experimental, deprecated`,
      code,
    );
  }
  if (availability.state === 'unsupported_in_mode' && !isNonEmptyString(availability.mode)) {
    throw invalidConnectorManifest(
      `Stream '${stream.name}' availability.mode must be a non-empty string when state is unsupported_in_mode`,
      code,
    );
  }
  for (const fieldName of ['mode', 'reason']) {
    if (availability[fieldName] !== undefined && !isNonEmptyString(availability[fieldName])) {
      throw invalidConnectorManifest(`Stream '${stream.name}' availability.${fieldName} must be a non-empty string`, code);
    }
  }
  if (
    availability.future_modes !== undefined
    && (!Array.isArray(availability.future_modes)
      || availability.future_modes.length === 0
      || availability.future_modes.some((mode) => !isNonEmptyString(mode)))
  ) {
    throw invalidConnectorManifest(
      `Stream '${stream.name}' availability.future_modes must be a non-empty array of strings`,
      code,
    );
  }
}

function validateConnectorManifest(manifest = {}, code = 'invalid_request', opts = {}) {
  const hasConnectorId = isNonEmptyString(manifest.connector_id);
  const hasConnectorKey = isNonEmptyString(manifest.connector_key);
  if (!(hasConnectorId || hasConnectorKey)) {
    throw invalidConnectorManifest('connector_key or connector_id is required', code);
  }
  if (hasConnectorKey && !isConnectorKey(manifest.connector_key)) {
    throw invalidConnectorManifest('connector_key must be a non-empty slug-like key, not a URL', code);
  }
  if (hasConnectorId && hasConnectorKey) {
    const connectorId = manifest.connector_id.trim();
    const connectorKey = manifest.connector_key.trim();
    const canonicalFromConnectorId = canonicalConnectorKey(manifest.connector_id);
    if (canonicalFromConnectorId && canonicalFromConnectorId !== connectorKey) {
      throw invalidConnectorManifest('connector_key must match the canonical key for connector_id', code);
    }
    if (!canonicalFromConnectorId && connectorId !== connectorKey) {
      throw invalidConnectorManifest(
        'connector_id must match connector_key; use manifest_uri for registry or document provenance',
        code,
      );
    }
  }
  if (isNonEmptyString(manifest.provider_id)) {
    throw invalidConnectorManifest('Connector registry only accepts connector manifests; provider_id is not allowed', code);
  }
  if (manifest.storage_binding !== undefined) {
    throw invalidConnectorManifest('Connector registry only accepts connector manifests; storage_binding is not allowed', code);
  }
  if (!Array.isArray(manifest.streams) || manifest.streams.length === 0) {
    throw invalidConnectorManifest('Connector manifests must include a non-empty streams array', code);
  }

  validateRuntimeRequirements(manifest, code);
  validateRefreshPolicyCapability(manifest, code);
  validateManifestSensitivity(manifest, code);

  const manifestStreamsByName = new Map(
    manifest.streams
      .filter((stream) => isNonEmptyString(stream?.name))
      .map((stream) => [stream.name, stream]),
  );
  const seenStreamNames = new Set();
  for (const stream of manifest.streams) {
    if (!isNonEmptyString(stream?.name)) {
      throw invalidConnectorManifest('Each connector stream must include a non-empty name', code);
    }
    if (seenStreamNames.has(stream.name)) {
      throw invalidConnectorManifest(`Duplicate stream name: ${stream.name}`, code);
    }
    seenStreamNames.add(stream.name);
    validateStreamAvailabilityDeclaration(stream, code);

    const schemaProperties = stream?.schema?.properties;
    if (!schemaProperties || typeof schemaProperties !== 'object' || Array.isArray(schemaProperties)) {
      throw invalidConnectorManifest(`Stream '${stream.name}' must include schema.properties`, code);
    }
    const schemaFieldNames = new Set(Object.keys(schemaProperties));

    const primaryKey = Array.isArray(stream.primary_key)
      ? stream.primary_key
      : (isNonEmptyString(stream.primary_key) ? [stream.primary_key] : []);
    if (!primaryKey.length || primaryKey.some((field) => !isNonEmptyString(field))) {
      throw invalidConnectorManifest(`Stream '${stream.name}' must include a non-empty primary_key`, code);
    }
    const unknownPrimaryKeyFields = primaryKey.filter((field) => !schemaFieldNames.has(field));
    if (unknownPrimaryKeyFields.length) {
      throw invalidConnectorManifest(`Stream '${stream.name}' primary_key fields must exist in schema.properties: ${unknownPrimaryKeyFields.join(', ')}`, code);
    }

    for (const fieldName of ['cursor_field', 'consent_time_field']) {
      if (stream[fieldName] != null && !schemaFieldNames.has(stream[fieldName])) {
        throw invalidConnectorManifest(`Stream '${stream.name}' ${fieldName} must exist in schema.properties`, code);
      }
    }

    if (schemaProperties.blob_ref !== undefined) {
      validateBlobRefSchemaDeclaration(stream, schemaProperties.blob_ref, code);
    }

    // Reference guardrail: the SQL-backed records path only supports a narrow
    // set of `cursor_field` shapes (see
    // reference-implementation/server/records.js::classifyCursorFieldSqlSupport).
    // Reject incompatible declarations at registration time so the same bug
    // class (500s on /records for shipped manifests) cannot recur.
    //
    // Skipped on read (`skipCursorFieldSortCheck: true`): a DB that predates
    // this guardrail may still hold stale manifests; blocking reads on them
    // would defeat the whole point of the runtime JS-comparator fallback in
    // records.js. Registration-time paths always enforce the check.
    if (stream.cursor_field != null && !opts.skipCursorFieldSortCheck) {
      const cursorSchema = schemaProperties[stream.cursor_field];
      if (!isReferenceCompatibleCursorSchema(cursorSchema)) {
        throw invalidConnectorManifest(
          `Stream '${stream.name}' cursor_field '${stream.cursor_field}' has an unsupported schema for the reference records path. ` +
            'Supported shapes: integer, number, string with format "date" or "date-time", or the nullable variants of those. ' +
            `Declared: type=${JSON.stringify(cursorSchema?.type)}${cursorSchema?.format ? ` format="${cursorSchema.format}"` : ''}.`,
          code,
        );
      }
    }

    const seenViewIds = new Set();
    for (const view of stream.views || []) {
      if (!isNonEmptyString(view?.id)) {
        throw invalidConnectorManifest(`Stream '${stream.name}' views must include a non-empty id`, code);
      }
      if (seenViewIds.has(view.id)) {
        throw invalidConnectorManifest(`Stream '${stream.name}' has duplicate view id '${view.id}'`, code);
      }
      seenViewIds.add(view.id);
      if (!Array.isArray(view.fields) || !view.fields.length || view.fields.some((field) => !isNonEmptyString(field))) {
        throw invalidConnectorManifest(`Stream '${stream.name}' view '${view.id}' must include a non-empty fields array`, code);
      }
      const unknownViewFields = view.fields.filter((field) => !schemaFieldNames.has(field));
      if (unknownViewFields.length) {
        throw invalidConnectorManifest(`Stream '${stream.name}' view '${view.id}' references unknown fields: ${unknownViewFields.join(', ')}`, code);
      }
    }

    // query.search.lexical_fields — the public lexical-retrieval extension's
    // stream-level declaration. v1 accepts only top-level scalar text fields
    // declared in schema.properties: `type: "string"` and the common nullable
    // form `type: ["string", "null"]`. Nested paths, arrays, blobs, unknown
    // fields, and non-string scalar types are rejected. See:
    //   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
    if (stream.query?.search?.lexical_fields !== undefined) {
      const declared = stream.query.search.lexical_fields;
      if (!Array.isArray(declared) || declared.length === 0) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.search.lexical_fields must be a non-empty array of strings`, code);
      }
      if (declared.some((field) => !isNonEmptyString(field))) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.search.lexical_fields entries must be non-empty strings`, code);
      }
      for (const fieldName of declared) {
        if (!schemaFieldNames.has(fieldName)) {
          throw invalidConnectorManifest(`Stream '${stream.name}' query.search.lexical_fields references unknown field '${fieldName}'`, code);
        }
        const fieldSchema = schemaProperties[fieldName];
        if (!isTopLevelSearchableStringField(fieldSchema)) {
          throw invalidConnectorManifest(`Stream '${stream.name}' query.search.lexical_fields entry '${fieldName}' must be a top-level string or nullable-string field; v1 does not support nested paths, arrays, blobs, or non-string scalar types`, code);
        }
      }
    }

    // query.search.semantic_fields — the public semantic-retrieval experimental
    // extension's stream-level declaration. Independent from lexical_fields:
    // either, both, or neither MAY be declared on a stream, and a field listed
    // in one is NOT automatically listed in the other. Same v1 shape constraints
    // as lexical_fields: top-level scalar text fields declared in schema.properties
    // (`type: "string"` or the common nullable form `type: ["string", "null"]`);
    // nested paths, arrays, blobs, non-string scalars, and unknown fields are
    // rejected. Records whose field value is actually null are skipped at index
    // time (see server/search-semantic.js::rebuildSemanticIndexForStream). See:
    //   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
    if (stream.query?.search?.semantic_fields !== undefined) {
      const declared = stream.query.search.semantic_fields;
      if (!Array.isArray(declared) || declared.length === 0) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.search.semantic_fields must be a non-empty array of strings`, code);
      }
      if (declared.some((field) => !isNonEmptyString(field))) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.search.semantic_fields entries must be non-empty strings`, code);
      }
      for (const fieldName of declared) {
        if (!schemaFieldNames.has(fieldName)) {
          throw invalidConnectorManifest(`Stream '${stream.name}' query.search.semantic_fields references unknown field '${fieldName}'`, code);
        }
        const fieldSchema = schemaProperties[fieldName];
        if (!isTopLevelSearchableStringField(fieldSchema)) {
          throw invalidConnectorManifest(`Stream '${stream.name}' query.search.semantic_fields entry '${fieldName}' must be a top-level string or nullable-string field; v1 does not support nested paths, arrays, blobs, or non-string scalar types`, code);
        }
      }
    }

    if (stream.query?.range_filters !== undefined) {
      const declared = stream.query.range_filters;
      if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.range_filters must be an object keyed by field name`, code);
      }
      for (const [fieldName, operators] of Object.entries(declared)) {
        if (!schemaFieldNames.has(fieldName)) {
          throw invalidConnectorManifest(`Stream '${stream.name}' query.range_filters references unknown field '${fieldName}'`, code);
        }
        if (!Array.isArray(operators) || operators.length === 0 || operators.some((operator) => !SUPPORTED_RANGE_OPERATORS.has(operator))) {
          throw invalidConnectorManifest(`Stream '${stream.name}' query.range_filters entry '${fieldName}' must use supported operators: gte, gt, lte, lt`, code);
        }
        const fieldSchema = schemaProperties[fieldName];
        if (!isRangeQueryableFieldSchema(fieldSchema)) {
          throw invalidConnectorManifest(`Stream '${stream.name}' query.range_filters entry '${fieldName}' must be an integer, number, date, date-time, or nullable variant`, code);
        }
      }
    }

    if (stream.query?.aggregations !== undefined) {
      const declared = stream.query.aggregations;
      if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations must be an object`, code);
      }
      const allowedKeys = new Set(['count', 'sum', 'min', 'max', 'group_by', 'group_by_time', 'count_distinct']);
      const unknownKeys = Object.keys(declared).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations has unsupported keys: ${unknownKeys.join(', ')}`, code);
      }
      if (declared.count !== undefined && declared.count !== true) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.count must be true when declared`, code);
      }
      for (const key of ['sum', 'min', 'max', 'group_by', 'group_by_time', 'count_distinct']) {
        const fields = declared[key];
        if (fields === undefined) continue;
        if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => !isNonEmptyString(field))) {
          throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.${key} must be a non-empty array of field names`, code);
        }
        const seenFields = new Set();
        for (const fieldName of fields) {
          if (seenFields.has(fieldName)) {
            throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.${key} duplicates field '${fieldName}'`, code);
          }
          seenFields.add(fieldName);
          if (!schemaFieldNames.has(fieldName)) {
            throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.${key} references unknown field '${fieldName}'`, code);
          }
          const fieldSchema = schemaProperties[fieldName];
          if (key === 'sum' && !isNumericAggregateFieldSchema(fieldSchema)) {
            throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.sum entry '${fieldName}' must be an integer, number, or nullable variant`, code);
          }
          if ((key === 'min' || key === 'max') && !isMinMaxAggregateFieldSchema(fieldSchema)) {
            throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.${key} entry '${fieldName}' must be an integer, number, date, date-time, or nullable variant`, code);
          }
          if (key === 'group_by' && !isScalarAggregateGroupFieldSchema(fieldSchema)) {
            throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.group_by entry '${fieldName}' must be a top-level scalar field; arrays, objects, blobs, and ambiguous types are not supported`, code);
          }
          if (key === 'group_by_time' && !isTimeBucketAggregateFieldSchema(fieldSchema)) {
            throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.group_by_time entry '${fieldName}' must be a string field with format date or date-time, or the nullable variant`, code);
          }
          if (key === 'count_distinct' && !isScalarAggregateGroupFieldSchema(fieldSchema)) {
            throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.count_distinct entry '${fieldName}' must be a top-level scalar field; arrays, objects, blobs, and ambiguous types are not supported`, code);
          }
        }
      }
    }

    validateStreamExpandDeclarations({
      code,
      manifestStreamsByName,
      schemaProperties,
      stream,
    });
  }
}

/**
 * Register or update a connector manifest
 */
export async function registerConnector(manifest, options = {}) {
  validateConnectorManifest(manifest);
  const { connectorId, storedManifest } = normalizeConnectorManifestForStorage(manifest);
  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO connectors(connector_id, manifest)
       VALUES($1, $2::jsonb)
       ON CONFLICT (connector_id) DO UPDATE SET manifest = EXCLUDED.manifest`,
      [connectorId, JSON.stringify(storedManifest)],
    );
  } else {
    exec(referenceQueries.authConnectorsUpsert, [
      connectorId,
      JSON.stringify(storedManifest),
    ]);
  }

  if (options.backfillRetrievalIndexes === false) {
    return connectorId;
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
  const { lexicalIndexBackfillForManifest } = await import('./search.js');
  await lexicalIndexBackfillForManifest({ manifest: storedManifest });

  // Semantic retrieval index drift-detect + backfill. Parallel to lexical;
  // handles the same three cases for semantic_fields, plus the backend-
  // identity change case (model_id/dimensions/distance_metric drift).
  // No-op when no embedding backend is configured (semanticRetrievalSupported
  // === false at startServer time) or when no stream declares semantic_fields.
  const { semanticIndexBackfillForManifest, getSemanticBackend } = await import('./search-semantic.js');
  if (getSemanticBackend()) {
    await semanticIndexBackfillForManifest({ manifest: storedManifest });
  }
  return connectorId;
}

function normalizeConnectorManifestForStorage(manifest) {
  const connectorId = canonicalConnectorKeyFromManifest(manifest) ?? manifest.connector_id;
  const storedManifest = {
    ...cloneJson(manifest),
    connector_key: connectorId,
    connector_id: connectorId,
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
export async function listRegisteredConnectorIds() {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT connector_id
       FROM connectors
       ORDER BY connector_id ASC`,
    );
    return result.rows.map((row) => row.connector_id);
  }
  // REVIEWED-BOUNDED: connectors table is O(registered providers); whole-table scan is acceptable.
  const rows = allowUnboundedReadAcknowledged(referenceQueries.authConnectorsListIds);
  return rows.map((row) => row.connector_id);
}

/**
 * Get manifest by connector_id
 */
export async function getConnectorManifest(connectorId) {
  if (!connectorId) return null;

  const row = await getConnectorManifestRow(connectorId);
  if (!row) return null;
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

async function getConnectorManifestRow(connectorId) {
  const exact = isPostgresStorageBackend()
    ? await pgOne(
        `SELECT manifest::text AS manifest
         FROM connectors
         WHERE connector_id = $1`,
        [connectorId],
      )
    : getOne(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (exact) return exact;
  const canonical = canonicalConnectorKey(connectorId);
  if (!canonical || canonical === connectorId) return null;
  return isPostgresStorageBackend()
    ? await pgOne(
        `SELECT manifest::text AS manifest
         FROM connectors
         WHERE connector_id = $1`,
        [canonical],
      )
    : getOne(referenceQueries.authConnectorsGetManifestById, [canonical]);
}

function parseAndValidateConnectorManifestRow(row, connectorId) {
  try {
    const manifest = JSON.parse(row.manifest);
    // Read-path validation: skip the reference cursor_field sort-compat check
    // so stale DB manifests (pre-guardrail) still flow through to the records
    // module's in-memory fallback. Registration-time paths enforce the full
    // check; see validateConnectorManifest.
    validateConnectorManifest(manifest, 'connector_invalid', { skipCursorFieldSortCheck: true });
    return manifest;
  } catch {
    throw invalidConnectorManifest(`Connector manifest for ${connectorId} is malformed or no longer valid`, 'connector_invalid');
  }
}

async function getLegacyLocalConnectorAliasManifest(connectorId) {
  const canonicalConnectorId = LEGACY_LOCAL_CONNECTOR_MANIFEST_ALIASES.get(connectorId);
  if (!canonicalConnectorId) return null;
  const canonicalRow = await getConnectorManifestRow(canonicalConnectorId);
  if (!canonicalRow) return null;
  const manifest = parseAndValidateConnectorManifestRow(canonicalRow, canonicalConnectorId);
  return cloneJson(manifest);
}

export async function getManifestForStorageBinding(storageBinding, opts = {}) {
  const connectorId = storageBinding?.connector_id || null;
  if (!connectorId) return null;

  const nativeManifest = resolveConfiguredNativeManifest(opts);
  if (nativeManifest?.storage_binding?.connector_id === connectorId) {
    return cloneJson(nativeManifest);
  }

  return getConnectorManifest(connectorId);
}

/**
 * Resolve a CIMD client_id to a synthetic registered-client shape.
 * Handles same-origin (local) lookup and external fetch with SSRF guards.
 * Throws with err.code = 'cimd_fetch_failed' or 'invalid_request' on failure.
 */
export async function revokeCimdClientAccessForSecurityMetadataChange(
  { clientId, previousSecurityHash = null, nextSecurityHash = null },
  opts = {},
) {
  const requestId = opts.requestId || opts.request_id || null;
  const traceId = opts.traceId || opts.trace_id || null;
  const revokeResult = await revokeClientAccessArtifacts(clientId, {
    requestId,
    traceId,
    subscriptionDisableReason: 'client_metadata_changed',
  });
  await emitSpineEvent({
    event_type: 'client.metadata_changed',
    trace_id: traceId || undefined,
    scenario_id: opts.scenarioId || opts.scenario_id || undefined,
    request_id: requestId || undefined,
    actor_type: 'authorization_server',
    actor_id: 'pdpp_as',
    object_type: 'client',
    object_id: clientId,
    status: 'succeeded',
    client_id: clientId,
    data: {
      registration_mode: 'client_id_metadata_document',
      reason: 'security_relevant_metadata_changed',
      previous_security_hash: previousSecurityHash,
      next_security_hash: nextSecurityHash,
      revoked_grant_count: revokeResult.revokedGrantIds.length,
      revoked_package_count: revokeResult.revokedPackageIds.length,
      revoked_owner_token_count: revokeResult.revokedOwnerTokenCount,
      disabled_subscription_count: revokeResult.disabledSubscriptionCount,
    },
  });
}

async function resolveCimdClientForGrant(clientId, opts = {}) {
  const {
    isCimdClientId,
    validateCimdUrl,
    fetchCimdDocument,
    buildCimdRegisteredClient,
  } = await import('./cimd.js');

  if (!isCimdClientId(clientId)) return null;

  // Validate URL structure before any fetch
  validateCimdUrl(clientId);

  // Same-origin check: if client_id matches our issuer + /oauth/client-metadata/:id,
  // resolve from local storage instead of a network self-fetch.
  const issuerBase = opts.issuerBase || opts.baseUrl || process.env.AS_PUBLIC_URL || null;
  if (issuerBase) {
    try {
      const issuerUrl = new URL(issuerBase);
      const clientUrl = new URL(clientId);
      if (
        clientUrl.origin === issuerUrl.origin
        && clientUrl.pathname.startsWith('/oauth/client-metadata/')
      ) {
        const docId = clientUrl.pathname.replace('/oauth/client-metadata/', '').replace(/^\//, '');
        const localDoc = await getCimdDocument(docId);
        if (!localDoc) {
          const err = new Error(`CIMD local document not found for ${clientId}`);
          err.code = 'invalid_client';
          throw err;
        }
        const doc = {
          client_id: clientId,
          client_name: localDoc.client_name,
          redirect_uris: localDoc.redirect_uris,
          logo_uri: localDoc.logo_uri,
          token_endpoint_auth_method: 'none',
        };
        return buildCimdRegisteredClient(clientId, doc);
      }
    } catch (err) {
      if (err.code === 'invalid_client' || err.code === 'invalid_request') throw err;
      // URL parse failure — fall through to external fetch
    }
  }

  // External fetch with SSRF guards, timeout, size cap
  const { doc } = await fetchCimdDocument(clientId, {
    onSecurityRelevantMetadataChange: (event) =>
      revokeCimdClientAccessForSecurityMetadataChange(event, opts),
  });
  return buildCimdRegisteredClient(clientId, doc);
}

export async function resolveOAuthClient(clientId, opts = {}) {
  let registeredClient = await getRegisteredClient(clientId);
  if (registeredClient) return registeredClient;
  const { isCimdClientId } = await import('./cimd.js');
  if (isCimdClientId(clientId)) {
    registeredClient = await resolveCimdClientForGrant(clientId, opts);
  }
  return registeredClient;
}

/**
 * Persist a pending grant-approval request and expose it as a PAR-backed consent request.
 * Returns the staged request URI plus the consent URL for the primary request/approval flow.
 */
export async function initiateGrant(input, opts = {}) {
  const hasParentPackageId = input?.parent_package_id !== undefined && input?.parent_package_id !== null;
  if (Array.isArray(input?.authorization_details) && (input.authorization_details.length > 1 || hasParentPackageId)) {
    return initiateStagedGrantBatch(input, opts);
  }
  const normalized = normalizePendingGrantRequest(input, opts);
  requireStructuredPendingRequestShape(normalized);
  const traceContext = getRequestTraceContext(normalized, opts.scenarioId || input?.scenario_id);
  normalized.trace_context = traceContext;
  const sourceBinding = getRequestSourceBinding(normalized);

  try {
    const registeredClient = await resolveOAuthClient(normalized.client.client_id, opts);
    if (!registeredClient) {
      const err = new Error(`Unknown client_id: ${normalized.client.client_id}`);
      err.code = 'invalid_client';
      throw err;
    }
    normalized.client.client_display = buildClientDisplayFromRegistration(registeredClient.metadata);
    const storageBinding = getRequestStorageBinding(normalized);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    resolveGrantSelection(normalized.selection, manifest);
    normalized.manifest_version = manifest.version;

    const deviceCode = generateId('dc');
    const userCode = randomBytes(3).toString('hex').toUpperCase();
    const verificationBaseUrl = opts.baseUrl || process.env.AS_PUBLIC_URL || `http://localhost:${process.env.AS_PORT || '7662'}`;
    const expiresAt = expiresInIso(300);

    await createPendingConsent(deviceCode, userCode, normalized, expiresAt);
    const requestEventData = {
      user_code: userCode,
      source: describeSourceBinding(sourceBinding),
      access_mode: normalized.selection?.access_mode || null,
      purpose_code: normalized.selection?.purpose_code || null,
      stream_names: (normalized.selection?.streams || []).map((stream) => stream.name),
    };

    await emitSpineEvent({
      event_type: 'request.submitted',
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      request_id: traceContext.request_id,
      actor_type: 'client',
      actor_id: normalized.client.client_id,
      object_type: 'pending_consent',
      object_id: deviceCode,
      status: 'succeeded',
      client_id: normalized.client.client_id,
      data: requestEventData,
    });

    const requestUri = buildPendingConsentRequestUri(deviceCode);
    return {
      request_uri: requestUri,
      authorization_url: buildPendingConsentAuthorizationUrl(requestUri, { baseUrl: verificationBaseUrl }),
      expires_in: 300,
      trace_context: traceContext,
    };
  } catch (err) {
    err.trace_id = traceContext.trace_id;
    err.request_id = traceContext.request_id;
    err.scenario_id = traceContext.scenario_id;
    await emitSpineEvent({
      event_type: 'request.rejected',
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      request_id: traceContext.request_id,
      actor_type: 'client',
      actor_id: normalized.client?.client_id || 'unknown',
      object_type: 'request',
      object_id: traceContext.request_id,
      status: 'rejected',
      client_id: normalized.client?.client_id || null,
      data: {
        source: describeSourceBinding(sourceBinding),
        access_mode: normalized.selection?.access_mode || null,
        purpose_code: normalized.selection?.purpose_code || null,
        stream_names: (normalized.selection?.streams || []).map((stream) => stream.name),
        error: {
          code: err.code || 'api_error',
          message: err.message,
        },
      },
    });
    throw err;
  }
}

function asSingleEntryRequestSlice(batchRequest, entry) {
  return {
    request_kind: 'pdpp_selection_request',
    request_version: batchRequest.request_version,
    client: batchRequest.client,
    selection: entry.selection,
    source_binding: entry.source_binding,
    storage_binding: entry.storage_binding,
    ...(entry.manifest_version ? { manifest_version: entry.manifest_version } : {}),
    ...(batchRequest.trace_context ? { trace_context: batchRequest.trace_context } : {}),
  };
}

async function initiateStagedGrantBatch(input, opts = {}) {
  const batch = normalizeStagedGrantRequestBatch(input, opts);
  const traceContext = getRequestTraceContext(batch, opts.scenarioId || input?.scenario_id);
  batch.trace_context = traceContext;
  const firstSource = batch.entries[0]?.source_binding || null;

  try {
    const registeredClient = await getRegisteredClient(batch.client.client_id);
    if (!registeredClient) {
      const err = new Error(`Unknown client_id: ${batch.client.client_id}`);
      err.code = 'invalid_client';
      throw err;
    }
    batch.client.client_display = buildClientDisplayFromRegistration(registeredClient.metadata);

    // Incremental add-source linkage: validate the parent now (same client,
    // exists, active) so a malformed/cross-client link fails closed before a
    // pending consent is created. The owner-scoped re-check happens at
    // approval, when the approving subject is known.
    await requireValidParentPackageLinkage(batch.parent_package_id, {
      clientId: registeredClient.client_id,
    });

    for (const entry of batch.entries) {
      const slice = asSingleEntryRequestSlice(batch, entry);
      requireStructuredPendingRequestShape(slice);
      const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(slice);
      entry.source_binding = describeSourceBinding(sourceBinding);
      entry.storage_binding = normalizeStorageBinding(storageBinding);
      const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
      resolveGrantSelection(entry.selection, manifest);
      entry.manifest_version = manifest.version;
    }

    const deviceCode = generateId('dc');
    const userCode = randomBytes(3).toString('hex').toUpperCase();
    const verificationBaseUrl = opts.baseUrl || process.env.AS_PUBLIC_URL || `http://localhost:${process.env.AS_PORT || '7662'}`;
    const expiresAt = expiresInIso(300);

    await createPendingConsent(deviceCode, userCode, batch, expiresAt);
    await emitSpineEvent({
      event_type: 'request.submitted',
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      request_id: traceContext.request_id,
      actor_type: 'client',
      actor_id: batch.client.client_id,
      object_type: 'pending_consent',
      object_id: deviceCode,
      status: 'succeeded',
      client_id: batch.client.client_id,
      data: {
        user_code: userCode,
        staged: true,
        entry_count: batch.entry_count,
        soft_cap_warning: batch.soft_cap_warning,
        over_soft_cap: batch.over_soft_cap,
        over_cap_sources: batch.over_cap_sources,
        ...(batch.parent_package_id ? { parent_package_id: batch.parent_package_id } : {}),
        sources: batch.entries.map((entry) => describeSourceBinding(entry.source_binding)),
      },
    });

    const requestUri = buildPendingConsentRequestUri(deviceCode);
    return {
      request_uri: requestUri,
      authorization_url: buildPendingConsentAuthorizationUrl(requestUri, { baseUrl: verificationBaseUrl }),
      expires_in: 300,
      trace_context: traceContext,
    };
  } catch (err) {
    err.trace_id = traceContext.trace_id;
    err.request_id = traceContext.request_id;
    err.scenario_id = traceContext.scenario_id;
    await emitSpineEvent({
      event_type: 'request.rejected',
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      request_id: traceContext.request_id,
      actor_type: 'client',
      actor_id: batch.client?.client_id || 'unknown',
      object_type: 'request',
      object_id: traceContext.request_id,
      status: 'rejected',
      client_id: batch.client?.client_id || null,
      data: {
        source: describeSourceBinding(firstSource),
        staged: true,
        entry_count: batch.entry_count,
        error: {
          code: err.code || 'api_error',
          message: err.message,
        },
      },
    });
    throw err;
  }
}

async function buildBatchConsentCards(request, opts = {}) {
  const cards = [];
  for (let index = 0; index < request.entries.length; index += 1) {
    const entry = request.entries[index];
    const slice = asSingleEntryRequestSlice(request, entry);
    requireStructuredPendingRequestShape(slice);
    const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(slice);
    entry.source_binding = describeSourceBinding(sourceBinding);
    entry.storage_binding = normalizeStorageBinding(storageBinding);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    slice.manifest_version = entry.manifest_version;
    const resolvedStreams = requirePendingRequestContractAgainstManifest(slice, manifest);
    cards.push({
      index,
      source: describeSourceBinding(sourceBinding),
      sensitivity: resolveManifestSensitivity(manifest),
      access_mode: entry.selection?.access_mode || null,
      purpose_code: entry.selection?.purpose_code || null,
      retention: entry.selection?.retention ?? null,
      resolvedStreams,
      manifestStreamNames: Array.isArray(manifest?.streams)
        ? manifest.streams.map((stream) => stream.name).filter((name) => typeof name === 'string')
        : null,
    });
  }
  return cards;
}

function summarizeBatchCumulativeRisk(cards = []) {
  return {
    source_count: cards.length,
    sensitive_source_count: cards.filter((card) => card.sensitivity === 'sensitive').length,
    continuous_access_count: cards.filter((card) => card.access_mode === 'continuous').length,
    no_time_bound_count: cards.filter((card) => cardHasNoTimeBound(card)).length,
    no_field_projection_count: cards.filter((card) => {
      const streams = Array.isArray(card.resolvedStreams) ? card.resolvedStreams : [];
      return streams.some((stream) => !Array.isArray(stream.fields) || stream.fields.length === 0);
    }).length,
    total_stream_count: cards.reduce((total, card) => (
      total + (Array.isArray(card.resolvedStreams) ? card.resolvedStreams.length : 0)
    ), 0),
  };
}

function cardRequestsAllStreams(card) {
  const manifestNames = Array.isArray(card?.manifestStreamNames) ? card.manifestStreamNames : null;
  const resolved = Array.isArray(card?.resolvedStreams) ? card.resolvedStreams : [];
  if (!manifestNames || manifestNames.length === 0 || resolved.length === 0) return false;
  const requested = new Set(resolved.map((stream) => stream.name));
  return manifestNames.every((name) => requested.has(name));
}

function cardHasNoTimeBound(card) {
  const resolved = Array.isArray(card?.resolvedStreams) ? card.resolvedStreams : [];
  if (resolved.length === 0) return true;
  return resolved.some((stream) => !stream.time_range);
}

function evaluateBatchApproveAllGate(cards = []) {
  const reasons = [];
  const sensitiveCount = cards.filter((card) => card.sensitivity === 'sensitive').length;
  if (cards.some((card) => card.access_mode === 'continuous' && cardRequestsAllStreams(card))) {
    reasons.push('continuous_all_streams');
  }
  if (cards.some((card) => card.sensitivity === 'sensitive' && cardHasNoTimeBound(card))) {
    reasons.push('sensitive_no_time_bound');
  }
  if (sensitiveCount >= 3) {
    reasons.push('three_or_more_sensitive_sources');
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
function narrowingHasAnyDirective(narrowing) {
  if (!narrowing || typeof narrowing !== 'object') return false;
  return (
    Array.isArray(narrowing.streams)
    || (narrowing.fields && typeof narrowing.fields === 'object')
    || (narrowing.since && typeof narrowing.since === 'object')
  );
}

function parseIsoInstant(value, { sourceLabel, streamName }) {
  if (!isNonEmptyString(value)) {
    throw bindingError(
      'invalid_request',
      `Narrowed time bound for '${sourceLabel}' stream '${streamName}' must be a non-empty ISO-8601 string`,
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw bindingError(
      'invalid_request',
      `Narrowed time bound '${value}' for '${sourceLabel}' stream '${streamName}' is not a valid ISO-8601 instant`,
    );
  }
  return ms;
}

function narrowResolvedSelectionForSource(baselineResolved, narrowing, sourceLabel) {
  const baseline = Array.isArray(baselineResolved) ? baselineResolved : [];
  if (!narrowingHasAnyDirective(narrowing)) {
    return baseline;
  }

  const baselineByName = new Map(baseline.map((stream) => [stream.name, stream]));

  // 1. Resolve which streams the owner keeps. Absent/empty keeps the full
  //    baseline; any named stream must exist in the baseline (no widening to a
  //    stream the client did not stage).
  let keptNames;
  if (Array.isArray(narrowing.streams)) {
    if (narrowing.streams.length === 0) {
      throw bindingError(
        'invalid_request',
        `Narrowed stream set for '${sourceLabel}' must keep at least one stream`,
      );
    }
    const seen = new Set();
    for (const name of narrowing.streams) {
      if (!isNonEmptyString(name)) {
        throw bindingError('invalid_request', `Narrowed stream name for '${sourceLabel}' must be a non-empty string`);
      }
      if (!baselineByName.has(name)) {
        throw bindingError(
          'invalid_request',
        `Cannot narrow '${sourceLabel}' to stream '${name}': it was not in the staged request (widening is forbidden)`,
        );
      }
      seen.add(name);
    }
    keptNames = baseline.map((stream) => stream.name).filter((name) => seen.has(name));
  } else {
    keptNames = baseline.map((stream) => stream.name);
  }

  const fieldsNarrowing = narrowing.fields && typeof narrowing.fields === 'object' ? narrowing.fields : {};
  const sinceNarrowing = narrowing.since && typeof narrowing.since === 'object' ? narrowing.since : {};

  // Reject directives that reference a stream the owner is not keeping — those
  // can only be a client/UI mistake and must not silently no-op.
  for (const targetMap of [fieldsNarrowing, sinceNarrowing]) {
    for (const streamName of Object.keys(targetMap)) {
      if (!keptNames.includes(streamName)) {
        throw bindingError(
          'invalid_request',
          `Narrowing references '${sourceLabel}' stream '${streamName}', which is not in the approved stream set`,
        );
      }
    }
  }

  return keptNames.map((name) => {
    const baseStream = baselineByName.get(name);
    const narrowed = { ...baseStream };

    // 2. Field narrowing: the narrowed set must be a non-empty subset of the
    //    baseline fields. If the baseline carried no `fields` (full record),
    //    the baseline ceiling is the manifest-resolved stream and we cannot
    //    safely subset against an unknown set here, so we forbid field
    //    narrowing on an unprojected stream and require the client/UI to stage
    //    a projection first. This keeps "no widen" provable.
    if (Object.prototype.hasOwnProperty.call(fieldsNarrowing, name)) {
      const requestedFields = fieldsNarrowing[name];
      if (!Array.isArray(requestedFields) || requestedFields.length === 0) {
        throw bindingError(
          'invalid_request',
          `Narrowed field set for '${sourceLabel}' stream '${name}' must be a non-empty array`,
        );
      }
      const baselineFields = Array.isArray(baseStream.fields) ? baseStream.fields : null;
      if (!baselineFields) {
        throw bindingError(
          'invalid_request',
          `Cannot narrow fields for '${sourceLabel}' stream '${name}': the staged request placed no field projection on it, so a field subset cannot be proven to be narrower`,
        );
      }
      const baselineFieldSet = new Set(baselineFields);
      const seenFields = new Set();
      for (const field of requestedFields) {
        if (!isNonEmptyString(field)) {
          throw bindingError('invalid_request', `Narrowed field name for '${sourceLabel}' stream '${name}' must be a non-empty string`);
        }
        if (!baselineFieldSet.has(field)) {
          throw bindingError(
            'invalid_request',
            `Cannot narrow '${sourceLabel}' stream '${name}' to field '${field}': it was not in the staged field set (widening is forbidden)`,
          );
        }
        seenFields.add(field);
      }
      // Preserve baseline ordering; drop a `view` since fields now diverge from it.
      narrowed.fields = baselineFields.filter((field) => seenFields.has(field));
      if (narrowed.view) delete narrowed.view;
    }

    // 3. Time narrowing: tighten an existing `since`. The narrowed `since` must
    //    be greater than or equal to the staged `since` (a later start is a
    //    narrower window). We only allow tightening a stream that ALREADY
    //    carries a staged time bound: the resolved baseline does not tell us
    //    whether an unbounded stream supports `time_range` at all (that lives in
    //    the manifest's `consent_time_field`), so adding a brand-new bound here
    //    could persist an unenforceable range. Tighten-only keeps "no widen"
    //    provable from the baseline alone.
    if (Object.prototype.hasOwnProperty.call(sinceNarrowing, name)) {
      const baselineSince = baseStream.time_range?.since;
      if (!isNonEmptyString(baselineSince)) {
        throw bindingError(
          'invalid_request',
          `Cannot set a time bound on '${sourceLabel}' stream '${name}': the staged request placed no time bound on it, so a tighter bound cannot be proven against it`,
        );
      }
      const requestedSince = sinceNarrowing[name];
      const requestedMs = parseIsoInstant(requestedSince, { sourceLabel, streamName: name });
      const baselineMs = Date.parse(baselineSince);
      if (!Number.isNaN(baselineMs) && requestedMs < baselineMs) {
        throw bindingError(
          'invalid_request',
          `Cannot narrow '${sourceLabel}' stream '${name}' to start at '${requestedSince}': that is earlier than the staged bound '${baselineSince}' (widening is forbidden)`,
        );
      }
      narrowed.time_range = { ...baseStream.time_range, since: requestedSince };
    }

    return narrowed;
  });
}

async function getPendingConsentBatch(request, row) {
  try {
    await requirePendingRequestClientRegistration(request);
    const cards = await buildBatchConsentCards(request);
    return {
      request,
      batch: true,
      userCode: row.user_code,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      cards,
      cumulativeRisk: summarizeBatchCumulativeRisk(cards),
      approveAllGate: evaluateBatchApproveAllGate(cards),
      softCapWarning: Boolean(request.soft_cap_warning),
      overSoftCap: Boolean(request.over_soft_cap),
      overCapSources: Array.isArray(request.over_cap_sources) ? request.over_cap_sources : [],
      softCap: request.soft_cap ?? BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
    };
  } catch (err) {
    await emitPendingConsentRejected(
      { client: request.client, selection: request.entries?.[0]?.selection, source_binding: request.entries?.[0]?.source_binding },
      row,
      err,
    );
    throw err;
  }
}

function resolveApprovedEntryIndexes(request, opts) {
  const total = request.entries.length;
  if (opts.approvedSourceIndexes === undefined || opts.approvedSourceIndexes === null) {
    return Array.from({ length: total }, (_unused, index) => index);
  }
  if (!Array.isArray(opts.approvedSourceIndexes)) {
    throw bindingError('invalid_request', 'approved_source_indexes must be an array of staged entry indexes');
  }
  const seen = new Set();
  for (const raw of opts.approvedSourceIndexes) {
    const index = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw bindingError('invalid_request', `approved_source_indexes contains an out-of-range entry index: ${raw}`);
    }
    seen.add(index);
  }
  if (seen.size === 0) {
    throw bindingError('invalid_request', 'approved_source_indexes must approve at least one staged source');
  }
  return Array.from(seen).sort((a, b) => a - b);
}

async function approveStagedGrantBatch(deviceCode, pending, request, subjectId, opts = {}) {
  const traceContext = requirePersistedPendingTraceContext(pending);
  request.trace_context = traceContext;

  let approvedIndexes;
  try {
    approvedIndexes = resolveApprovedEntryIndexes(request, opts);
    const isApproveAll = opts.approvedSourceIndexes === undefined || opts.approvedSourceIndexes === null;
    if (isApproveAll) {
      const gate = evaluateBatchApproveAllGate(await buildBatchConsentCards(request, opts));
      if (gate.approve_all_suppressed) {
        const err = new Error(
          `Approve-all is not available for this request (${gate.suppression_reasons.join(', ')}); confirm each source individually`,
        );
        err.code = 'invalid_request';
        err.param = 'approved_source_indexes';
        throw err;
      }
      if (opts.confirmedApproveAll !== true) {
        const err = new Error('Approve-all requires a re-asserting confirmation of the per-source list');
        err.code = 'invalid_request';
        err.param = 'confirm_approve_all';
        throw err;
      }
    }
  } catch (err) {
    await emitPendingConsentRejected(
      { client: request.client, selection: request.entries?.[0]?.selection, source_binding: request.entries?.[0]?.source_binding },
      pending,
      err,
      { subjectId },
    );
    throw err;
  }

  const approvedEntries = approvedIndexes.map((index) => request.entries[index]);
  for (const entry of approvedEntries) {
    if (entry.selection?.purpose_code === 'https://pdpp.org/purpose/ai_training') {
      const err = new Error('Staged batch consent does not cover ai_training; request it as a single-entry grant');
      err.code = 'invalid_request';
      err.param = 'purpose_code';
      throw err;
    }
  }

  // One access mode per package (tranche scope guard). Every child grant a package issues
  // must carry the same access mode; per-source access-mode mixing is not offered in this
  // tranche. An owner who needs different modes for different sources runs separate ceremonies.
  const approvedAccessModes = new Set(
    approvedEntries.map((entry) => entry.selection?.access_mode || null),
  );
  if (approvedAccessModes.size > 1) {
    const err = new Error(
      `A batch package applies one access mode to every source; the approved sources mix access modes (${Array.from(
        approvedAccessModes,
      )
        .map((mode) => mode ?? 'unspecified')
        .sort()
        .join(', ')}). Run a separate ceremony per access mode.`,
    );
    err.code = 'invalid_request';
    err.param = 'access_mode';
    throw err;
  }

  const sourceNarrowing = opts.sourceNarrowing && typeof opts.sourceNarrowing === 'object'
    ? opts.sourceNarrowing
    : {};
  // Owner narrowing is keyed by staged source index. A directive that targets a
  // source the owner did not approve can only be a UI/client mistake and must
  // not silently no-op, so reject it before issuing anything.
  for (const key of Object.keys(sourceNarrowing)) {
    const index = Number(key);
    if (!Number.isInteger(index) || !approvedIndexes.includes(index)) {
      const err = new Error(
        `Narrowing references staged source index ${key}, which is not in the approved set`,
      );
      err.code = 'invalid_request';
      err.param = 'source_narrowing';
      throw err;
    }
  }

  let registeredClient;
  let parentPackage = null;
  const resolvedEntries = [];
  try {
    registeredClient = await requirePendingRequestClientRegistration(request);
    // Re-validate incremental add-source linkage now that the approving owner
    // (subjectId) is known. Fail closed before any new package row or child
    // grant is written if the parent is missing, cross-client, cross-owner,
    // or no longer active. The prior package and its child grants are never
    // re-issued or mutated by this link.
    parentPackage = await requireValidParentPackageLinkage(request.parent_package_id, {
      clientId: registeredClient.client_id,
      subjectId,
    });
    for (let position = 0; position < approvedEntries.length; position += 1) {
      const entry = approvedEntries[position];
      const stagedIndex = approvedIndexes[position];
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
        sourceNarrowing[stagedIndex],
        sourceBinding?.id || `source ${stagedIndex + 1}`,
      );
      resolvedEntries.push({ entry, slice, sourceBinding, storageBinding, manifest, resolvedStreams });
    }
  } catch (err) {
    await emitPendingConsentRejected(
      { client: request.client, selection: request.entries?.[0]?.selection, source_binding: request.entries?.[0]?.source_binding },
      pending,
      err,
      { subjectId },
    );
    throw err;
  }

  const packageId = generateId('gpkg');
  const createdAt = nowIso();
  const packageEnvelope = {
    version: 'reference.batch_consent.v1',
    package_id: packageId,
    subject: { id: subjectId },
    client: {
      client_id: registeredClient.client_id,
      ...(request.client?.client_display ? { client_display: request.client.client_display } : {}),
    },
    staged_source_count: request.entries.length,
    approved_source_count: resolvedEntries.length,
    approved_source_indexes: approvedIndexes,
    source_bounded_child_grants: true,
    ...(parentPackage ? { parent_package_id: parentPackage.package_id } : {}),
  };

  const parentPackageId = parentPackage ? parentPackage.package_id : null;
  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO grant_packages(
         package_id, subject_id, client_id, status, package_json,
         parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
       ) VALUES($1, $2, $3, 'active', $4::jsonb, $5, $6, $7, $8, $9, NULL)`,
      [
        packageId,
        subjectId,
        registeredClient.client_id,
        JSON.stringify(packageEnvelope),
        parentPackageId,
        traceContext.trace_id,
        traceContext.scenario_id,
        createdAt,
        createdAt,
      ],
    );
  } else {
    exec(referenceQueries.authGrantPackagesInsert, [
      packageId,
      subjectId,
      registeredClient.client_id,
      JSON.stringify(packageEnvelope),
      parentPackageId,
      traceContext.trace_id,
      traceContext.scenario_id,
      createdAt,
      createdAt,
    ]);
  }

  const childGrants = [];
  for (const resolved of resolvedEntries) {
    const { grant, token } = await persistChildGrantForPackage({
      request: resolved.slice,
      registeredClient,
      subjectId,
      sourceBinding: resolved.sourceBinding,
      storageBinding: resolved.storageBinding,
      manifest: resolved.manifest,
      resolvedStreams: resolved.resolvedStreams,
      traceContext,
    });
    const source = describePackageMemberSource(grant);
    const addedAt = nowIso();
    if (isPostgresStorageBackend()) {
      await pgExec(
        `INSERT INTO grant_package_members(
           package_id, grant_id, token_id, source_json, status, added_at, revoked_at
         ) VALUES($1, $2, $3, $4::jsonb, 'active', $5, NULL)`,
        [packageId, grant.grant_id, token, JSON.stringify(source), addedAt],
      );
    } else {
      exec(referenceQueries.authGrantPackageMembersInsert, [
        packageId,
        grant.grant_id,
        token,
        JSON.stringify(source),
        addedAt,
      ]);
    }
    childGrants.push({ grant, token, source });
  }

  await emitSpineEvent({
    event_type: 'consent.approved',
    trace_id: traceContext.trace_id,
    scenario_id: traceContext.scenario_id,
    request_id: traceContext.request_id,
    actor_type: 'subject',
    actor_id: subjectId,
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'pending_consent',
    object_id: deviceCode,
    status: 'succeeded',
    client_id: registeredClient.client_id,
    data: {
      user_code: pending.user_code,
      package_id: packageId,
      approved_source_indexes: approvedIndexes,
    },
  });

  const packageToken = await issuePackageToken(packageId, subjectId, registeredClient.client_id, null, {
    traceContext,
    source: 'batch_consent_package',
  });

  await emitSpineEvent({
    event_type: 'grant_package.issued',
    trace_id: traceContext.trace_id,
    scenario_id: traceContext.scenario_id,
    request_id: traceContext.request_id,
    actor_type: 'authorization_server',
    actor_id: 'pdpp_as',
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'grant_package',
    object_id: packageId,
    status: 'succeeded',
    client_id: registeredClient.client_id,
    token_id: packageToken,
    data: {
      child_grant_ids: childGrants.map((entry) => entry.grant.grant_id),
      sources: childGrants.map((entry) => entry.source),
    },
  });

  await markPendingConsentApproved(deviceCode, {
    subjectId,
    grantId: packageId,
    tokenId: packageToken,
    aiTrainingConsented: false,
  });

  return {
    grant: {
      package: true,
      package_id: packageId,
      grant_id: packageId,
      child_grants: childGrants.map((entry) => ({
        grant_id: entry.grant.grant_id,
        source: entry.source,
      })),
    },
    token: packageToken,
    package: true,
    package_id: packageId,
  };
}

/**
 * Get pending consent request for display in consent UI
 */
export async function getPendingConsent(deviceCode) {
  const row = await getPendingConsentRow(deviceCode);
  if (!row) return null;
  if (row.status !== 'pending') return null;
  if (isExpired(row)) {
    await markPendingConsentExpired(deviceCode);
    return null;
  }
  const request = JSON.parse(row.params_json);
  request.trace_context = requirePersistedPendingTraceContext(row);
  if (isStagedBatchRequest(request)) {
    return getPendingConsentBatch(request, row);
  }
  let resolvedStreams = null;
  let manifestStreamNames = null;
  try {
    requireStructuredPendingRequestShape(request);
    await requirePendingRequestClientRegistration(request);
    const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request);
    request.source_binding = describeSourceBinding(sourceBinding);
    request.storage_binding = normalizeStorageBinding(storageBinding);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding);
    resolvedStreams = requirePendingRequestContractAgainstManifest(request, manifest);
    manifestStreamNames = Array.isArray(manifest?.streams)
      ? manifest.streams.map((stream) => stream.name).filter((name) => typeof name === 'string')
      : null;
  } catch (err) {
    await emitPendingConsentRejected(request, row, err);
    throw err;
  }
  return {
    request,
    userCode: row.user_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedStreams,
    manifestStreamNames,
  };
}

/**
 * Approve a pending grant request — creates the grant and access token
 * Called by the current consent surface after user approval.
 * This is grant issuance, not owner authentication.
 */
export async function approveGrant(deviceCode, subjectId = 'owner_local', opts = {}) {
  const pending = await getPendingConsentRow(deviceCode);
  if (!pending) {
    const err = new Error('Unknown device code');
    err.code = 'not_found';
    throw err;
  }
  if (pending.status !== 'pending') {
    const err = new Error('Pending consent request is not available');
    err.code = 'not_found';
    throw err;
  }
  if (isExpired(pending)) {
    await markPendingConsentExpired(deviceCode);
    const err = new Error('Pending consent request has expired');
    err.code = 'not_found';
    throw err;
  }

  const request = JSON.parse(pending.params_json);
  if (isStagedBatchRequest(request)) {
    return approveStagedGrantBatch(deviceCode, pending, request, subjectId, opts);
  }
  const traceContext = requirePersistedPendingTraceContext(pending);
  request.trace_context = traceContext;
  let registeredClient;
  let sourceBinding;
  let storageBinding;
  let manifest;
  let resolvedStreams;

  try {
    requireStructuredPendingRequestShape(request);
    registeredClient = await requirePendingRequestClientRegistration(request);
    ({ sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request));
    request.source_binding = describeSourceBinding(sourceBinding);
    request.storage_binding = normalizeStorageBinding(storageBinding);
    manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    resolvedStreams = requirePendingRequestContractAgainstManifest(request, manifest);
  } catch (err) {
    await emitPendingConsentRejected(request, pending, err, { subjectId });
    throw err;
  }

  const selection = request.selection;
  const client = request.client || {};

  // The AS MUST obtain explicit affirmative consent before issuing ai_training grants.
  // A missing affirmation is a consent-policy rejection, not an internal failure;
  // surface it as a typed PDPP error envelope (status 400, code `invalid_request`)
  // so callers do not see it as a generic 500.
  const { ai_training_consented } = opts;
  if (selection.purpose_code === 'https://pdpp.org/purpose/ai_training' && !ai_training_consented) {
    const err = new Error('Explicit affirmative consent required for ai_training purpose');
    err.code = 'invalid_request';
    err.param = 'ai_training_consented';
    throw err;
  }

  const grantId = generateId('grt');
  const issuedAt = nowIso();
  const expiresAt = selection.access_mode === 'single_use'
    ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24h reference default
    : null;

  const persistedSource = describeSourceBinding(sourceBinding);
  const persistedStorageBinding = normalizeStorageBinding(storageBinding);

  const grant = {
    version: '0.1.0',
    grant_id: grantId,
    issued_at: issuedAt,
    subject: { id: subjectId },
    client: {
      client_id: registeredClient.client_id,
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

  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO grants(
         grant_id, subject_id, client_id, storage_binding_json, grant_json,
         access_mode, issued_at, expires_at, trace_id, scenario_id
       ) VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        grantId,
        subjectId,
        registeredClient.client_id,
        serializeStorageBinding(persistedStorageBinding),
        JSON.stringify(grant),
        selection.access_mode,
        issuedAt,
        expiresAt,
        traceContext.trace_id,
        traceContext.scenario_id,
      ],
    );
  } else {
    exec(referenceQueries.authGrantsInsert, [
      grantId,
      subjectId,
      registeredClient.client_id,
      serializeStorageBinding(persistedStorageBinding),
      JSON.stringify(grant),
      selection.access_mode,
      issuedAt,
      expiresAt,
      traceContext.trace_id,
      traceContext.scenario_id,
    ]);
  }

  await emitSpineEvent({
    event_type: 'consent.approved',
    trace_id: traceContext.trace_id,
    scenario_id: traceContext.scenario_id,
    request_id: traceContext.request_id,
    actor_type: 'subject',
    actor_id: subjectId,
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'pending_consent',
    object_id: deviceCode,
    status: 'succeeded',
    grant_id: grantId,
    client_id: registeredClient.client_id,
    data: {
      user_code: pending.user_code,
      source: describeSourceBinding(sourceBinding),
    },
  });

  const grantIssuedEventData = {
    source: describeGrantSource(grant),
    access_mode: selection.access_mode,
    purpose_code: selection.purpose_code,
    stream_names: resolvedStreams.map((stream) => stream.name),
    retention: selection.retention ?? null,
  };

  await emitSpineEvent({
    event_type: 'grant.issued',
    trace_id: traceContext.trace_id,
    scenario_id: traceContext.scenario_id,
    request_id: traceContext.request_id,
    actor_type: 'authorization_server',
    actor_id: 'pdpp_as',
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'grant',
    object_id: grantId,
    status: 'succeeded',
    grant_id: grantId,
    client_id: registeredClient.client_id,
    data: grantIssuedEventData,
  });

  // Issue access token
  const token = await issueToken(grantId, subjectId, registeredClient.client_id, expiresAt, {
    traceContext,
    source: 'grant_approval',
  });

  await markPendingConsentApproved(deviceCode, {
    subjectId,
    grantId,
    tokenId: token,
    aiTrainingConsented: ai_training_consented,
  });

  return { grant, token };
}

function base64UrlSha256(value) {
  return createHash('sha256').update(String(value)).digest('base64url');
}

function isUsableAuthorizationCodePkceChallenge(challenge, method) {
  return (
    isNonEmptyString(challenge)
    && PKCE_CODE_VERIFIER_RE.test(challenge)
    && SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS.has(method)
  );
}

function buildOAuthAuthorizationCodeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function clientSupportsOAuthRefreshToken(registeredClient) {
  return registeredClient?.metadata?.grant_types?.includes('refresh_token') === true;
}

function buildOAuthRefreshTokenError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function issueOAuthRefreshToken({ clientId, grantId, subjectId, expiresAt = null }) {
  const refreshToken = generateOAuthRefreshToken();
  const refreshTokenHash = hashOAuthRefreshToken(refreshToken);
  const createdAt = nowIso();
  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO oauth_refresh_tokens(
         refresh_token_hash, client_id, grant_id, subject_id, status,
         created_at, expires_at, last_used_at, revoked_at
       ) VALUES($1, $2, $3, $4, 'active', $5, $6, NULL, NULL)`,
      [refreshTokenHash, clientId, grantId, subjectId, createdAt, expiresAt],
    );
  } else {
    exec(referenceQueries.authOauthRefreshTokensInsert, [
      refreshTokenHash,
      clientId,
      grantId,
      subjectId,
      createdAt,
      expiresAt,
    ]);
  }
  return refreshToken;
}

async function issueOAuthRefreshTokenForPackage({ clientId, packageId, subjectId, expiresAt = null }) {
  const refreshToken = generateOAuthRefreshToken();
  const refreshTokenHash = hashOAuthRefreshToken(refreshToken);
  const createdAt = nowIso();
  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO oauth_refresh_tokens(
         refresh_token_hash, client_id, grant_id, package_id, subject_id, status,
         created_at, expires_at, last_used_at, revoked_at
       ) VALUES($1, $2, NULL, $3, $4, 'active', $5, $6, NULL, NULL)`,
      [refreshTokenHash, clientId, packageId, subjectId, createdAt, expiresAt],
    );
  } else {
    exec(referenceQueries.authOauthRefreshTokensInsertPackage, [
      refreshTokenHash,
      clientId,
      packageId,
      subjectId,
      createdAt,
      expiresAt,
    ]);
  }
  return refreshToken;
}

async function issuePackageToken(packageId, subjectId, clientId, expiresAt = null, meta = {}) {
  const tokenId = generateToken();
  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO tokens(token_id, grant_id, package_id, subject_id, client_id, token_kind, expires_at)
       VALUES($1, NULL, $2, $3, $4, 'mcp_package', $5)`,
      [tokenId, packageId, subjectId, clientId, expiresAt],
    );
  } else {
    exec(referenceQueries.authTokensInsertMcpPackage, [tokenId, packageId, subjectId, clientId, expiresAt]);
  }

  await emitSpineEvent({
    event_type: 'token.issued',
    trace_id: meta.traceContext?.trace_id || undefined,
    scenario_id: meta.traceContext?.scenario_id || undefined,
    request_id: meta.traceContext?.request_id || undefined,
    actor_type: 'authorization_server',
    actor_id: 'pdpp_as',
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'token',
    object_id: tokenId,
    status: 'succeeded',
    client_id: clientId,
    token_id: tokenId,
    data: {
      token_kind: 'mcp_package',
      grant_package_id: packageId,
      issuance_path: meta.source || 'hosted_mcp_package',
    },
  });

  return tokenId;
}

function parsePackageJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizePackageRow(row) {
  if (!row) return null;
  return {
    package_id: row.package_id,
    subject_id: row.subject_id,
    client_id: row.client_id,
    status: row.status,
    package: parsePackageJson(row.package_json),
    parent_package_id: row.parent_package_id || null,
    trace_id: row.trace_id || null,
    scenario_id: row.scenario_id || null,
    created_at: row.created_at,
    approved_at: row.approved_at,
    revoked_at: row.revoked_at || null,
  };
}

/**
 * Fetch a raw grant_packages row (status-agnostic) for lineage validation.
 * Mirrors the column set used by `getGrantPackageForOwner` and includes
 * `parent_package_id` so the linkage chain can be walked.
 */
async function getGrantPackageRow(packageId) {
  if (!isNonEmptyString(packageId)) return null;
  const row = isPostgresStorageBackend()
    ? await pgOne(
        `SELECT package_id, subject_id, client_id, status, package_json::text AS package_json,
                parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
           FROM grant_packages
           WHERE package_id = $1`,
        [packageId],
      )
    : getOne(referenceQueries.authGrantPackagesGetById, [packageId]);
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
async function requireValidParentPackageLinkage(parentPackageId, { clientId, subjectId } = {}) {
  if (parentPackageId === undefined || parentPackageId === null) return null;
  const linkageError = (message) => {
    const err = new Error(message);
    err.code = 'invalid_request';
    err.param = 'parent_package_id';
    return err;
  };
  if (!isNonEmptyString(parentPackageId)) {
    throw linkageError('parent_package_id must be a non-empty string');
  }
  const parent = await getGrantPackageRow(parentPackageId);
  if (!parent) {
    throw linkageError(`parent_package_id ${parentPackageId} does not exist`);
  }
  if (isNonEmptyString(clientId) && parent.client_id !== clientId) {
    throw linkageError('parent_package_id belongs to a different client; cross-client lineage is not allowed');
  }
  if (isNonEmptyString(subjectId) && parent.subject_id !== subjectId) {
    throw linkageError('parent_package_id belongs to a different owner; cross-owner lineage is not allowed');
  }
  if (parent.status !== 'active') {
    throw linkageError(`parent_package_id ${parentPackageId} is ${parent.status}; cannot link to an inactive package`);
  }
  return parent;
}

function describePackageMemberSource(grant, connectionId = null, metadata = null) {
  const source = describeGrantSource(grant);
  if (!source) return null;
  return {
    ...source,
    ...(isNonEmptyString(connectionId) ? { connection_id: connectionId } : {}),
    ...(metadata?.display_name ? { display_name: metadata.display_name } : {}),
    ...(metadata?.connector_display_name ? { connector_display_name: metadata.connector_display_name } : {}),
  };
}

function isRawConnectionDisplayName(source) {
  return isNonEmptyString(source?.connection_id) && source.display_name === source.connection_id;
}

async function normalizePersistedPackageMemberSource(source, { ownerSubjectId = null } = {}) {
  if (!source || typeof source !== 'object') return source;
  if (!isRawConnectionDisplayName(source)) return source;

  const sanitized = { ...source };
  const connectorId = isNonEmptyString(sanitized.id) ? sanitized.id : null;
  if (isNonEmptyString(ownerSubjectId) && connectorId) {
    const active = await listActiveBindingsForGrant({ ownerSubjectId, connectorId }).catch(() => []);
    const binding = active.find((row) => row.connectorInstanceId === sanitized.connection_id) || null;
    const displayName = projectBindingForWire(binding)?.display_name || null;
    if (displayName) {
      sanitized.display_name = displayName;
      return sanitized;
    }
  }

  delete sanitized.display_name;
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
}) {
  const selection = request.selection;
  const client = request.client || {};

  // Hosted MCP packages never carry ai_training; reject if a client tries.
  if (selection.purpose_code === 'https://pdpp.org/purpose/ai_training') {
    const err = new Error('Hosted MCP package consent does not cover ai_training');
    err.code = 'invalid_request';
    err.param = 'purpose_code';
    throw err;
  }

  const grantId = generateId('grt');
  const issuedAt = nowIso();
  const expiresAt = selection.access_mode === 'single_use'
    ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    : null;

  const persistedSource = describeSourceBinding(sourceBinding);
  const persistedStorageBinding = normalizeStorageBinding(storageBinding);

  const grant = {
    version: '0.1.0',
    grant_id: grantId,
    issued_at: issuedAt,
    subject: { id: subjectId },
    client: {
      client_id: registeredClient.client_id,
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

  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO grants(
         grant_id, subject_id, client_id, storage_binding_json, grant_json,
         access_mode, issued_at, expires_at, trace_id, scenario_id
       ) VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        grantId,
        subjectId,
        registeredClient.client_id,
        serializeStorageBinding(persistedStorageBinding),
        JSON.stringify(grant),
        selection.access_mode,
        issuedAt,
        expiresAt,
        traceContext.trace_id,
        traceContext.scenario_id,
      ],
    );
  } else {
    exec(referenceQueries.authGrantsInsert, [
      grantId,
      subjectId,
      registeredClient.client_id,
      serializeStorageBinding(persistedStorageBinding),
      JSON.stringify(grant),
      selection.access_mode,
      issuedAt,
      expiresAt,
      traceContext.trace_id,
      traceContext.scenario_id,
    ]);
  }

  await emitSpineEvent({
    event_type: 'grant.issued',
    trace_id: traceContext.trace_id,
    scenario_id: traceContext.scenario_id,
    request_id: traceContext.request_id,
    actor_type: 'authorization_server',
    actor_id: 'pdpp_as',
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'grant',
    object_id: grantId,
    status: 'succeeded',
    grant_id: grantId,
    client_id: registeredClient.client_id,
    data: {
      source: describeGrantSource(grant),
      access_mode: selection.access_mode,
      purpose_code: selection.purpose_code,
      stream_names: resolvedStreams.map((stream) => stream.name),
      retention: selection.retention ?? null,
    },
  });

  const token = await issueToken(grantId, subjectId, registeredClient.client_id, expiresAt, {
    traceContext,
    source: 'hosted_mcp_package_child',
  });

  return { grant, token, expiresAt };
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
  subjectId = 'owner_local',
  opts = {},
}) {
  if (!isNonEmptyString(clientId)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'client_id is required');
  }
  if (!Array.isArray(authorizationDetails) || authorizationDetails.length === 0) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'At least one source must be selected');
  }

  const registeredClient = await getRegisteredClient(clientId);
  if (!registeredClient) {
    throw buildOAuthAuthorizationCodeError('invalid_client', 'Unknown client_id');
  }

  const packageId = generateId('gpkg');
  const traceContext = createTraceContext({ scenarioId: opts.scenarioId });
  const createdAt = nowIso();
  const packageEnvelope = {
    version: 'reference.mcp_package.v1',
    package_id: packageId,
    subject: { id: subjectId },
    client: {
      client_id: clientId,
      client_display: buildClientDisplayFromRegistration(registeredClient.metadata),
    },
    approved_source_count: authorizationDetails.length,
    source_bounded_child_grants: true,
  };

  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO grant_packages(
         package_id, subject_id, client_id, status, package_json,
         parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
       ) VALUES($1, $2, $3, 'active', $4::jsonb, $5, $6, $7, $8, $9, NULL)`,
      [
        packageId,
        subjectId,
        clientId,
        JSON.stringify(packageEnvelope),
        null,
        traceContext.trace_id,
        traceContext.scenario_id,
        createdAt,
        createdAt,
      ],
    );
  } else {
    exec(referenceQueries.authGrantPackagesInsert, [
      packageId,
      subjectId,
      clientId,
      JSON.stringify(packageEnvelope),
      null,
      traceContext.trace_id,
      traceContext.scenario_id,
      createdAt,
      createdAt,
    ]);
  }

  const childGrants = [];
  for (const [index, detail] of authorizationDetails.entries()) {
    const request = normalizePendingGrantRequest(
      { client_id: clientId, authorization_details: [detail] },
      opts,
    );
    const selectedStorageBinding = normalizeStorageBinding(storageBindings[index]);
    if (selectedStorageBinding) {
      request.storage_binding = selectedStorageBinding;
    }
    requireStructuredPendingRequestShape(request);
    request.trace_context = traceContext;
    const childRegisteredClient = await requirePendingRequestClientRegistration(request);
    const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request);
    request.source_binding = describeSourceBinding(sourceBinding);
    request.storage_binding = normalizeStorageBinding(storageBinding);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding, opts);
    request.manifest_version = manifest.version;
    const resolvedStreams = resolveGrantSelection(request.selection, manifest);
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
    const connectionId = isNonEmptyString(connectionIds[index]) ? connectionIds[index] : null;
    const source = describePackageMemberSource(grant, connectionId, sourceMetadata[index]);
    const addedAt = nowIso();
    if (isPostgresStorageBackend()) {
      await pgExec(
        `INSERT INTO grant_package_members(
           package_id, grant_id, token_id, source_json, status, added_at, revoked_at
         ) VALUES($1, $2, $3, $4::jsonb, 'active', $5, NULL)`,
        [packageId, grant.grant_id, token, JSON.stringify(source), addedAt],
      );
    } else {
      exec(referenceQueries.authGrantPackageMembersInsert, [
        packageId,
        grant.grant_id,
        token,
        JSON.stringify(source),
        addedAt,
      ]);
    }
    childGrants.push({ grant, token, source, connection_id: connectionId });
  }

  const packageToken = await issuePackageToken(packageId, subjectId, clientId, null, {
    traceContext,
    source: 'hosted_mcp_package',
  });

  await emitSpineEvent({
    event_type: 'grant_package.issued',
    trace_id: traceContext.trace_id,
    scenario_id: traceContext.scenario_id,
    request_id: traceContext.request_id,
    actor_type: 'authorization_server',
    actor_id: 'pdpp_as',
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'grant_package',
    object_id: packageId,
    status: 'succeeded',
    client_id: clientId,
    token_id: packageToken,
    data: {
      child_grant_ids: childGrants.map((entry) => entry.grant.grant_id),
      sources: childGrants.map((entry) => entry.source),
    },
  });

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

/**
 * Resolve a hosted-MCP package id to its currently active members. Each
 * member entry exposes the child grant, its access token, its storage
 * binding, and an enriched `source` (with `connection_id` when known) that
 * the MCP fan-out can use to scope per-source reads.
 *
 * Returns `null` when the package itself is missing or revoked. An active
 * package with all members revoked returns `{ package, members: [] }`.
 */
export async function getGrantPackageAccess(packageId) {
  if (!isNonEmptyString(packageId)) return null;
  const packageRow = isPostgresStorageBackend()
    ? await pgOne(
        `SELECT package_id, subject_id, client_id, status, package_json::text AS package_json,
                parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
         FROM grant_packages
         WHERE package_id = $1`,
        [packageId],
      )
    : getOne(referenceQueries.authGrantPackagesGetById, [packageId]);
  const grantPackage = normalizePackageRow(packageRow);
  if (!grantPackage || grantPackage.status !== 'active') {
    return null;
  }

  const memberRows = isPostgresStorageBackend()
    ? (await postgresQuery(
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
        [packageId],
      )).rows
    : allowUnboundedReadAcknowledged(referenceQueries.authGrantPackageMembersListActiveByPackage, [packageId]);

  const activeMembers = [];
  for (const row of memberRows) {
    if (row.grant_status !== 'active' || row.token_revoked) continue;
    if (row.token_expires_at && new Date(row.token_expires_at).getTime() <= Date.now()) continue;
    let grantState;
    try {
      grantState = requirePersistedGrantState(row);
    } catch {
      continue;
    }
    const persistedSource = await normalizePersistedPackageMemberSource(
      parsePackageJson(row.source_json) || describeGrantSource(grantState.grant),
      { ownerSubjectId: grantPackage.subject_id },
    );
    activeMembers.push({
      package_id: packageId,
      grant_id: row.grant_id,
      token: row.token_id,
      source: persistedSource,
      grant: grantState.grant,
      grant_storage_binding: grantState.storageBinding,
      connection_id: persistedSource?.connection_id || null,
    });
  }

  return {
    package: grantPackage,
    members: activeMembers,
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
function encodeGrantPackageCursor(row) {
  return Buffer.from(JSON.stringify({
    created_at: row.created_at,
    package_id: row.package_id,
  }), 'utf8').toString('base64url');
}

function decodeGrantPackageCursor(cursor) {
  if (!isNonEmptyString(cursor)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      decoded
      && isNonEmptyString(decoded.created_at)
      && isNonEmptyString(decoded.package_id)
    ) {
      return {
        created_at: decoded.created_at,
        package_id: decoded.package_id,
      };
    }
  } catch {
    // handled below
  }
  const err = new Error('Invalid grant package cursor');
  err.code = 'invalid_cursor';
  throw err;
}

export async function listGrantPackagesForOwner(opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  const cursor = decodeGrantPackageCursor(opts.cursor);
  let rows;
  if (isPostgresStorageBackend()) {
    const params = [];
    let where = '';
    if (cursor) {
      params.push(cursor.created_at, cursor.package_id);
      where = 'WHERE (gp.created_at < $1 OR (gp.created_at = $1 AND gp.package_id < $2))';
    }
    params.push(limit + 1);
    const limitPlaceholder = `$${params.length}`;
    rows = (await postgresQuery(
      `SELECT gp.package_id, gp.subject_id, gp.client_id, gp.status,
              gp.parent_package_id, gp.trace_id, gp.scenario_id, gp.created_at, gp.approved_at, gp.revoked_at,
              (SELECT COUNT(*) FROM grant_package_members gpm
                 WHERE gpm.package_id = gp.package_id) AS member_count
         FROM grant_packages gp
         ${where}
         ORDER BY gp.created_at DESC, gp.package_id DESC
         LIMIT ${limitPlaceholder}`,
      params,
    )).rows;
  } else {
    rows = [
      ...allowUnboundedReadAcknowledged(referenceQueries.authGrantPackagesListAll, []),
    ];
    if (cursor) {
      rows = rows.filter((row) => (
        row.created_at < cursor.created_at
        || (row.created_at === cursor.created_at && row.package_id < cursor.package_id)
      ));
    }
    rows = rows.slice(0, limit + 1);
  }
  const normalized = rows
    .map((row) => {
      const pkg = normalizePackageRow(row);
      if (!pkg) return null;
      const memberCount =
        row.member_count === null || row.member_count === undefined
          ? 0
          : Number(row.member_count);
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
    next_cursor: tail ? encodeGrantPackageCursor(tail) : null,
    limit,
  };
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
export async function getGrantPackageForOwner(packageId) {
  if (!isNonEmptyString(packageId)) return null;
  const packageRow = isPostgresStorageBackend()
    ? await pgOne(
        `SELECT package_id, subject_id, client_id, status, package_json::text AS package_json,
                parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
           FROM grant_packages
           WHERE package_id = $1`,
        [packageId],
      )
    : getOne(referenceQueries.authGrantPackagesGetById, [packageId]);
  const grantPackage = normalizePackageRow(packageRow);
  if (!grantPackage) return null;

  // For operator visibility we ALWAYS return every member row, even ones
  // marked revoked, so the operator can see the cascade history on a
  // revoked package detail page. The MCP fan-out path uses
  // `getGrantPackageAccess`, which intentionally hides revoked rows.
  const memberRows = isPostgresStorageBackend()
    ? (await postgresQuery(
        `SELECT gm.package_id, gm.grant_id, gm.source_json::text AS source_json,
                gm.status AS member_status, gm.added_at, gm.revoked_at AS member_revoked_at,
                g.status AS grant_status
           FROM grant_package_members gm
           JOIN grants g ON gm.grant_id = g.grant_id
           WHERE gm.package_id = $1
           ORDER BY gm.added_at, gm.grant_id`,
        [packageId],
      )).rows
    : allowUnboundedReadAcknowledged(referenceQueries.authGrantPackageMembersListAllByPackage, [packageId]);

  const children = await Promise.all(memberRows.map(async (row) => ({
    grant_id: row.grant_id,
    grant_status: row.grant_status,
    member_status: row.member_status,
    added_at: row.added_at,
    revoked_at: row.member_revoked_at || null,
    source: await normalizePersistedPackageMemberSource(parsePackageJson(row.source_json) || null, {
      ownerSubjectId: grantPackage.subject_id,
    }),
  })));

  return {
    ...grantPackage,
    member_count: children.length,
    children,
  };
}

/**
 * Direct children of a package in the add-source lineage: every package
 * whose `parent_package_id` equals `packageId`. Used to walk the lineage
 * tree downward when assembling the cumulative per-client view. Returns
 * normalized package rows (no members).
 */
async function listGrantPackagesByParent(packageId) {
  if (!isNonEmptyString(packageId)) return [];
  if (isPostgresStorageBackend()) {
    const rows = (await postgresQuery(
      `SELECT package_id, subject_id, client_id, status, package_json::text AS package_json,
              parent_package_id, trace_id, scenario_id, created_at, approved_at, revoked_at
         FROM grant_packages
         WHERE parent_package_id = $1
         ORDER BY created_at, package_id`,
      [packageId],
    )).rows;
    return rows.map(normalizePackageRow).filter(Boolean);
  }
  // SQLite: the package count per deployment is bounded (small enumeration
  // table); filter the all-packages listing by parent in JS rather than add
  // another registered query.
  const rows = allowUnboundedReadAcknowledged(referenceQueries.authGrantPackagesListAll, []);
  return rows
    .map(normalizePackageRow)
    .filter((pkg) => pkg && pkg.parent_package_id === packageId);
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
export async function getCumulativeClientAccessForPackage(packageId) {
  if (!isNonEmptyString(packageId)) return null;
  const start = await getGrantPackageRow(packageId);
  if (!start) return null;

  // Walk up to the lineage root. Bound the walk by a visited set so a
  // corrupt cycle cannot loop forever.
  const visitedUp = new Set();
  let root = start;
  while (root.parent_package_id && !visitedUp.has(root.package_id)) {
    visitedUp.add(root.package_id);
    const parent = await getGrantPackageRow(root.parent_package_id);
    if (!parent) break;
    // Scope guard: a parent that does not match the starting client/owner is
    // not part of this client's cumulative view; stop ascending there.
    if (parent.client_id !== start.client_id || parent.subject_id !== start.subject_id) break;
    root = parent;
  }

  const clientId = root.client_id;
  const subjectId = root.subject_id;

  // Walk the tree downward from the root, gathering same-client/owner packages.
  const lineageIds = [];
  const seen = new Set();
  const queue = [root.package_id];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    lineageIds.push(current);
    const childPackages = await listGrantPackagesByParent(current);
    for (const child of childPackages) {
      if (child.client_id !== clientId || child.subject_id !== subjectId) continue;
      if (!seen.has(child.package_id)) queue.push(child.package_id);
    }
  }

  // Assemble per-package detail (with members) in lineage order.
  const packages = [];
  const cumulativeChildren = [];
  for (const id of lineageIds) {
    const detail = await getGrantPackageForOwner(id);
    if (!detail) continue;
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

  const activeChildren = cumulativeChildren.filter(
    (child) => child.grant_status === 'active' && child.member_status === 'active',
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
export async function getGrantPackageIdForGrant(grantId) {
  if (!isNonEmptyString(grantId)) return null;
  if (isPostgresStorageBackend()) {
    const row = await pgOne(
      `SELECT package_id
         FROM grant_package_members
         WHERE grant_id = $1
         ORDER BY added_at
         LIMIT 1`,
      [grantId],
    );
    return row?.package_id ?? null;
  }
  const row = getOne(referenceQueries.authGrantPackageMembersGetPackageIdByGrant, [grantId]);
  return row?.package_id ?? null;
}

async function listActiveGrantPackageMembersForRevocation(packageId) {
  if (!isNonEmptyString(packageId)) return [];
  if (isPostgresStorageBackend()) {
    return (await postgresQuery(
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
      [packageId],
    )).rows;
  }
  return allowUnboundedReadAcknowledged(referenceQueries.authGrantPackageMembersListActiveByPackage, [packageId]);
}

async function markGrantPackageMemberRevoked(packageId, grantId, revokedAt) {
  if (isPostgresStorageBackend()) {
    await pgExec(
      `UPDATE grant_package_members
       SET status = 'revoked', revoked_at = $1
       WHERE package_id = $2 AND grant_id = $3 AND status = 'active'`,
      [revokedAt, packageId, grantId],
    );
    return;
  }
  exec(referenceQueries.authGrantPackageMembersMarkRevokedByGrant, [revokedAt, packageId, grantId]);
}

async function markGrantPackageRevoked(packageId, revokedAt) {
  if (isPostgresStorageBackend()) {
    await pgExec(
      "UPDATE grant_packages SET status = 'revoked', revoked_at = $1 WHERE package_id = $2 AND status = 'active'",
      [revokedAt, packageId],
    );
    await pgExec("UPDATE tokens SET revoked = TRUE WHERE package_id = $1", [packageId]);
    await pgExec(
      "UPDATE grant_package_members SET status = 'revoked', revoked_at = $1 WHERE package_id = $2 AND status = 'active'",
      [revokedAt, packageId],
    );
    await pgExec(
      "UPDATE oauth_refresh_tokens SET status = 'revoked', revoked_at = $1 WHERE package_id = $2 AND status = 'active'",
      [revokedAt, packageId],
    );
    return;
  }
  exec(referenceQueries.authGrantPackagesMarkRevoked, [revokedAt, packageId]);
  exec(referenceQueries.authTokensRevokeByPackage, [packageId]);
  exec(referenceQueries.authGrantPackageMembersMarkRevokedByPackage, [revokedAt, packageId]);
  exec(referenceQueries.authOauthRefreshTokensRevokeByPackage, [revokedAt, packageId]);
}

function normalizePackageRevokeError(grantId, err) {
  const code = isNonEmptyString(err?.code) ? err.code : 'revoke_failed';
  const message = isNonEmptyString(err?.message) ? err.message : 'Child grant revoke failed';
  return {
    grant_id: grantId,
    error: { code, message },
  };
}

export async function revokeGrantPackage(packageId, context = {}) {
  const activeMembers = await listActiveGrantPackageMembersForRevocation(packageId);
  const revokedChildGrants = [];
  const notRevokedChildGrants = [];

  for (const member of activeMembers) {
    if (member.grant_status !== 'active') continue;
    try {
      await revokeGrant(member.grant_id, context);
      const childRevokedAt = nowIso();
      await markGrantPackageMemberRevoked(packageId, member.grant_id, childRevokedAt);
      revokedChildGrants.push(member.grant_id);
    } catch (err) {
      notRevokedChildGrants.push(normalizePackageRevokeError(member.grant_id, err));
    }
  }

  if (notRevokedChildGrants.length) {
    await emitSpineEvent({
      event_type: 'grant_package.revoke_partial',
      trace_id: context.trace_id || undefined,
      scenario_id: context.scenario_id || undefined,
      request_id: context.request_id || undefined,
      actor_type: 'authorization_server',
      actor_id: 'pdpp_as',
      object_type: 'grant_package',
      object_id: packageId,
      status: 'failed',
      data: {
        revoked_child_grants: revokedChildGrants,
        not_revoked_child_grants: notRevokedChildGrants,
      },
    });
    return {
      status: 'partial_failure',
      package_id: packageId,
      revoked_at: null,
      revoked_child_grants: revokedChildGrants,
      not_revoked_child_grants: notRevokedChildGrants,
    };
  }

  const now = nowIso();
  await markGrantPackageRevoked(packageId, now);

  await emitSpineEvent({
    event_type: 'grant_package.revoked',
    trace_id: context.trace_id || undefined,
    scenario_id: context.scenario_id || undefined,
    request_id: context.request_id || undefined,
    actor_type: 'authorization_server',
    actor_id: 'pdpp_as',
    object_type: 'grant_package',
    object_id: packageId,
    status: 'succeeded',
    data: {
      revoked_child_grants: revokedChildGrants,
    },
  });
  return {
    status: 'revoked',
    package_id: packageId,
    revoked_at: now,
    revoked_child_grants: revokedChildGrants,
    not_revoked_child_grants: [],
  };
}

export async function issueOAuthAuthorizationCodeForPackageDeviceCode(deviceCode, { packageId, token }) {
  if (!isNonEmptyString(deviceCode)) return null;
  const row = isPostgresStorageBackend()
    ? await pgOne(
        `SELECT id, device_code, client_id, redirect_uri, state, status, expires_at
         FROM oauth_authorization_codes
         WHERE device_code = $1`,
        [deviceCode],
      )
    : getOne(referenceQueries.authOauthAuthorizationCodesGetByDeviceCode, [deviceCode]);

  if (!row || row.status !== 'pending') return null;
  if (isExpired(row)) {
    if (isPostgresStorageBackend()) {
      await pgExec(
        `UPDATE oauth_authorization_codes SET status = 'expired' WHERE device_code = $1 AND status = 'pending'`,
        [deviceCode],
      );
    } else {
      exec(referenceQueries.authOauthAuthorizationCodesMarkExpiredByDeviceCode, [deviceCode]);
    }
    throw buildOAuthAuthorizationCodeError('invalid_request', 'OAuth authorization request has expired');
  }

  const code = generateId('oacode');
  const issuedAt = nowIso();
  const expiresAt = expiresInIso(300);
  if (isPostgresStorageBackend()) {
    await pgExec(
      `UPDATE oauth_authorization_codes
       SET code = $1, grant_id = NULL, package_id = $2, token_id = $3, status = 'issued',
           issued_at = $4, expires_at = $5
       WHERE device_code = $6 AND status = 'pending'`,
      [code, packageId, token, issuedAt, expiresAt, deviceCode],
    );
  } else {
    exec(
      referenceQueries.authOauthAuthorizationCodesIssuePackageForDeviceCode,
      [code, packageId, token, issuedAt, expiresAt, deviceCode],
    );
  }

  return {
    code,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    state: row.state || null,
    expires_at: expiresAt,
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
}) {
  if (!isNonEmptyString(deviceCode)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'device_code is required');
  }
  if (!isNonEmptyString(clientId)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'client_id is required');
  }
  if (!isNonEmptyString(redirectUri)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'redirect_uri is required');
  }
  if (!isUsableAuthorizationCodePkceChallenge(codeChallenge, codeChallengeMethod)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'code_challenge_method must be S256 and code_challenge must be 43-128 characters');
  }

  const row = {
    id: generateId('oac'),
    deviceCode,
    clientId,
    redirectUri,
    state: state || null,
    codeChallenge,
    codeChallengeMethod,
    createdAt: nowIso(),
    expiresAt: expiresInIso(expiresInSeconds),
  };

  if (isPostgresStorageBackend()) {
    await pgExec(
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
      [
        row.id,
        row.deviceCode,
        row.clientId,
        row.redirectUri,
        row.state,
        row.codeChallenge,
        row.codeChallengeMethod,
        row.createdAt,
        row.expiresAt,
      ],
    );
  } else {
    exec(
      referenceQueries.authOauthAuthorizationCodesUpsertPending,
      [
        row.id,
        row.deviceCode,
        row.clientId,
        row.redirectUri,
        row.state,
        row.codeChallenge,
        row.codeChallengeMethod,
        row.createdAt,
        row.expiresAt,
      ],
    );
  }

  return { ...row, status: 'pending' };
}

export async function issueOAuthAuthorizationCodeForDeviceCode(deviceCode, { grantId, token }) {
  if (!isNonEmptyString(deviceCode)) return null;
  const row = isPostgresStorageBackend()
    ? await pgOne(
        `SELECT id, device_code, client_id, redirect_uri, state, status, expires_at
         FROM oauth_authorization_codes
         WHERE device_code = $1`,
        [deviceCode],
      )
    : getOne(referenceQueries.authOauthAuthorizationCodesGetByDeviceCode, [deviceCode]);

  if (!row || row.status !== 'pending') return null;
  if (isExpired(row)) {
    if (isPostgresStorageBackend()) {
      await pgExec(
        `UPDATE oauth_authorization_codes SET status = 'expired' WHERE device_code = $1 AND status = 'pending'`,
        [deviceCode],
      );
    } else {
      exec(referenceQueries.authOauthAuthorizationCodesMarkExpiredByDeviceCode, [deviceCode]);
    }
    throw buildOAuthAuthorizationCodeError('invalid_request', 'OAuth authorization request has expired');
  }

  const code = generateId('oacode');
  const issuedAt = nowIso();
  const expiresAt = expiresInIso(300);
  if (isPostgresStorageBackend()) {
    await pgExec(
      `UPDATE oauth_authorization_codes
       SET code = $1, grant_id = $2, token_id = $3, status = 'issued',
           issued_at = $4, expires_at = $5
       WHERE device_code = $6 AND status = 'pending'`,
      [code, grantId, token, issuedAt, expiresAt, deviceCode],
    );
  } else {
    exec(
      referenceQueries.authOauthAuthorizationCodesIssueForDeviceCode,
      [code, grantId, token, issuedAt, expiresAt, deviceCode],
    );
  }

  return {
    code,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    state: row.state || null,
    expires_at: expiresAt,
  };
}

export async function exchangeOAuthAuthorizationCode({
  code,
  clientId,
  redirectUri,
  codeVerifier,
  baseUrl = null,
  issuerBase = null,
}) {
  if (!isNonEmptyString(code)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'code is required');
  }
  if (!isNonEmptyString(clientId)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'client_id is required');
  }
  if (!isNonEmptyString(redirectUri)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'redirect_uri is required');
  }
  if (!isNonEmptyString(codeVerifier)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'code_verifier is required');
  }
  if (!PKCE_CODE_VERIFIER_RE.test(codeVerifier)) {
    throw buildOAuthAuthorizationCodeError('invalid_request', 'code_verifier must be 43-128 unreserved URI characters');
  }

  const row = isPostgresStorageBackend()
    ? await pgOne(
        `SELECT id, code, client_id, redirect_uri, code_challenge, code_challenge_method,
                status, grant_id, package_id, token_id, expires_at, consumed_at
         FROM oauth_authorization_codes
         WHERE code = $1`,
        [code],
      )
    : getOne(referenceQueries.authOauthAuthorizationCodesGetByCode, [code]);

  if (!row || row.status !== 'issued' || row.consumed_at) {
    throw buildOAuthAuthorizationCodeError('invalid_grant', 'Authorization code is invalid or already used');
  }
  if (isExpired(row)) {
    throw buildOAuthAuthorizationCodeError('invalid_grant', 'Authorization code has expired');
  }
  if (row.client_id !== clientId) {
    throw buildOAuthAuthorizationCodeError('invalid_grant', 'Authorization code client_id mismatch');
  }
  if (row.redirect_uri !== redirectUri) {
    throw buildOAuthAuthorizationCodeError('invalid_grant', 'Authorization code redirect_uri mismatch');
  }
  if (row.code_challenge_method !== 'S256' || base64UrlSha256(codeVerifier) !== row.code_challenge) {
    throw buildOAuthAuthorizationCodeError('invalid_grant', 'Authorization code PKCE verification failed');
  }

  const registeredClient = await resolveOAuthClient(clientId, { baseUrl, issuerBase });
  if (!registeredClient) {
    throw buildOAuthAuthorizationCodeError('invalid_client', 'Unknown client_id');
  }

  const consumedAt = nowIso();
  const updated = isPostgresStorageBackend()
    ? await pgExec(
        `UPDATE oauth_authorization_codes
         SET status = 'consumed', consumed_at = $1
         WHERE code = $2 AND status = 'issued' AND consumed_at IS NULL`,
        [consumedAt, code],
      )
    : exec(
        referenceQueries.authOauthAuthorizationCodesConsumeCode,
        [consumedAt, code],
      );

  if (!updated.changes) {
    throw buildOAuthAuthorizationCodeError('invalid_grant', 'Authorization code is invalid or already used');
  }

  const response = {
    access_token: row.token_id,
    token_type: 'Bearer',
    ...(row.package_id ? { grant_package_id: row.package_id } : { grant_id: row.grant_id }),
  };

  if (clientSupportsOAuthRefreshToken(registeredClient)) {
    const tokenInfo = await introspect(row.token_id);
    const tokenMatches = row.package_id
      ? tokenInfo.grant_package_id === row.package_id && tokenInfo.pdpp_token_kind === 'mcp_package'
      : tokenInfo.grant_id === row.grant_id && tokenInfo.pdpp_token_kind === 'client';
    if (!tokenInfo.active || tokenInfo.client_id !== clientId || !tokenMatches) {
      throw buildOAuthAuthorizationCodeError('invalid_grant', 'Issued grant token is no longer active');
    }
    response.refresh_token = row.package_id
      ? await issueOAuthRefreshTokenForPackage({
          clientId,
          packageId: row.package_id,
          subjectId: tokenInfo.subject_id,
          expiresAt: tokenInfo.exp ? new Date(tokenInfo.exp * 1000).toISOString() : null,
        })
      : await issueOAuthRefreshToken({
          clientId,
          grantId: row.grant_id,
          subjectId: tokenInfo.subject_id,
          expiresAt: tokenInfo.exp ? new Date(tokenInfo.exp * 1000).toISOString() : null,
        });
  }

  return response;
}

export async function exchangeOAuthRefreshToken({
  refreshToken,
  clientId,
}) {
  if (!isNonEmptyString(refreshToken)) {
    throw buildOAuthRefreshTokenError('invalid_request', 'refresh_token is required');
  }
  if (!isNonEmptyString(clientId)) {
    throw buildOAuthRefreshTokenError('invalid_request', 'client_id is required');
  }

  const refreshTokenHash = hashOAuthRefreshToken(refreshToken);
  const row = isPostgresStorageBackend()
    ? await pgOne(
        `SELECT refresh_token_hash, client_id, grant_id, package_id, subject_id, status,
                created_at, expires_at, last_used_at, revoked_at
         FROM oauth_refresh_tokens
         WHERE refresh_token_hash = $1`,
        [refreshTokenHash],
      )
    : getOne(referenceQueries.authOauthRefreshTokensGetByToken, [refreshTokenHash]);

  if (!row || row.status !== 'active' || row.revoked_at) {
    throw buildOAuthRefreshTokenError('invalid_grant', 'Refresh token is invalid');
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    throw buildOAuthRefreshTokenError('invalid_grant', 'Refresh token has expired');
  }
  if (row.client_id !== clientId) {
    throw buildOAuthRefreshTokenError('invalid_grant', 'Refresh token client_id mismatch');
  }

  const registeredClient = await getRegisteredClient(clientId);
  if (!registeredClient || !clientSupportsOAuthRefreshToken(registeredClient)) {
    throw buildOAuthRefreshTokenError('invalid_grant', 'Client is not registered for refresh_token');
  }

  let accessToken;
  try {
    if (row.package_id) {
      const grantPackage = await getGrantPackageAccess(row.package_id);
      if (!grantPackage) {
        const err = new Error('Grant package is no longer active');
        err.code = 'package_revoked';
        throw err;
      }
      accessToken = await issuePackageToken(row.package_id, row.subject_id, row.client_id, row.expires_at || null, {
        source: 'oauth_refresh_token',
      });
    } else {
      accessToken = await issueToken(row.grant_id, row.subject_id, row.client_id, row.expires_at || null, {
        source: 'oauth_refresh_token',
      });
    }
  } catch (err) {
    const code = [
      'grant_revoked',
      'grant_invalid',
      'grant_consumed',
      'package_revoked',
      'not_found',
    ].includes(err?.code) ? 'invalid_grant' : (err?.code || 'invalid_grant');
    throw buildOAuthRefreshTokenError(code, err?.message || 'Refresh token grant is no longer valid');
  }

  const usedAt = nowIso();
  if (isPostgresStorageBackend()) {
    await pgExec(
      `UPDATE oauth_refresh_tokens
       SET last_used_at = $1
       WHERE refresh_token_hash = $2 AND status = 'active'`,
      [usedAt, refreshTokenHash],
    );
  } else {
    exec(referenceQueries.authOauthRefreshTokensMarkUsed, [usedAt, refreshTokenHash]);
  }

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    refresh_token: refreshToken,
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
const consentExchangeCodes = new Map();
const CONSENT_EXCHANGE_CODE_TTL_MS = 5 * 60 * 1000;

function pruneExpiredConsentExchangeCodes(now = Date.now()) {
  for (const [code, entry] of consentExchangeCodes) {
    if (entry.consumed || entry.expiresAt <= now) {
      consentExchangeCodes.delete(code);
    }
  }
}

export function createConsentExchangeCode({ grantId, token, grant, ttlMs = CONSENT_EXCHANGE_CODE_TTL_MS }) {
  if (!grantId || !token || !grant) {
    throw new Error('createConsentExchangeCode requires grantId, token, and grant');
  }
  pruneExpiredConsentExchangeCodes();
  const code = `cex_${randomBytes(32).toString('hex')}`;
  consentExchangeCodes.set(code, {
    grantId,
    token,
    grant,
    expiresAt: Date.now() + ttlMs,
    consumed: false,
  });
  return code;
}

export function consumeConsentExchangeCode(code) {
  if (typeof code !== 'string' || code.length === 0) {
    return { ok: false, reason: 'unknown' };
  }
  const entry = consentExchangeCodes.get(code);
  if (!entry) {
    return { ok: false, reason: 'unknown' };
  }
  if (entry.consumed) {
    return { ok: false, reason: 'consumed' };
  }
  if (entry.expiresAt <= Date.now()) {
    consentExchangeCodes.delete(code);
    return { ok: false, reason: 'expired' };
  }
  entry.consumed = true;
  consentExchangeCodes.delete(code);
  return {
    ok: true,
    grantId: entry.grantId,
    token: entry.token,
    grant: entry.grant,
  };
}

/** Test-only escape hatch: clear the in-memory exchange-code store. */
export function _resetConsentExchangeCodes() {
  consentExchangeCodes.clear();
}

/**
 * Deny and clear a pending grant request
 */
export async function denyGrant(deviceCode) {
  const pending = await getPendingConsentRow(deviceCode);
  if (!pending || pending.status !== 'pending') return false;
  if (isExpired(pending)) {
    await markPendingConsentExpired(deviceCode);
    return false;
  }
  await markPendingConsentDenied(deviceCode);

  const request = JSON.parse(pending.params_json);
  const traceContext = requirePersistedPendingTraceContext(pending);
  request.trace_context = traceContext;
  const { sourceBinding } = requireStructuredPendingRequestBindings(request);
  await emitSpineEvent({
    event_type: 'consent.denied',
    trace_id: traceContext.trace_id,
    scenario_id: traceContext.scenario_id,
    request_id: traceContext.request_id,
    actor_type: 'subject',
    actor_id: pending.subject_id || 'owner_local',
    object_type: 'pending_consent',
    object_id: deviceCode,
    status: 'denied',
    client_id: request.client?.client_id || null,
    data: {
      user_code: pending.user_code,
      source: describeSourceBinding(sourceBinding),
    },
  });

  return true;
}

/**
 * Start an owner device authorization flow (RFC 8628-shaped).
 * Returns { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }.
 */
export async function initiateOwnerDeviceAuthorization(clientId, opts = {}) {
  const traceContext = createTraceContext({ scenarioId: opts.scenarioId });
  try {
    if (!clientId) {
      const err = new Error('client_id is required');
      err.code = 'invalid_request';
      throw err;
    }
    const registeredClient = await getRegisteredClient(clientId);
    if (!registeredClient) {
      const err = new Error(`Unknown client_id: ${clientId}`);
      err.code = 'invalid_client';
      throw err;
    }

    const deviceCode = generateId('dc_owner');
    const userCode = randomBytes(3).toString('hex').toUpperCase();
    const verificationBaseUrl = opts.baseUrl || process.env.AS_PUBLIC_URL || `http://localhost:${process.env.AS_PORT || '7662'}`;
    const expiresIn = opts.expiresIn || 300;
    const interval = opts.interval || 1;
    const expiresAt = expiresInIso(expiresIn);

    await createOwnerDeviceAuth({
      deviceCode,
      userCode,
      clientId,
      intervalSeconds: interval,
      expiresAt,
      requestId: traceContext.request_id,
      traceId: traceContext.trace_id,
      scenarioId: traceContext.scenario_id,
    });

    await emitSpineEvent({
      event_type: 'request.submitted',
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      request_id: traceContext.request_id,
      actor_type: 'client',
      actor_id: registeredClient.client_id,
      object_type: 'owner_device_auth',
      object_id: deviceCode,
      status: 'succeeded',
      client_id: registeredClient.client_id,
      data: {
        issuance_path: 'owner_device_flow',
        user_code: userCode,
      },
    });

    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${verificationBaseUrl}/device`,
      verification_uri_complete: `${verificationBaseUrl}/device?user_code=${encodeURIComponent(userCode)}`,
      expires_in: expiresIn,
      interval,
      trace_context: traceContext,
    };
  } catch (err) {
    err.trace_id = traceContext.trace_id;
    err.request_id = traceContext.request_id;
    err.scenario_id = traceContext.scenario_id;
    await emitSpineEvent({
      event_type: 'request.rejected',
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      request_id: traceContext.request_id,
      actor_type: 'client',
      actor_id: clientId || 'unknown',
      object_type: 'request',
      object_id: traceContext.request_id,
      status: 'rejected',
      client_id: clientId || null,
      data: {
        issuance_path: 'owner_device_flow',
        error: {
          code: err.code || 'invalid_request',
          message: err.message,
        },
      },
    });
    throw err;
  }
}

/**
 * Look up an owner-device authorization request by user code for verification UI.
 */
export async function getOwnerDeviceAuthorizationByUserCode(userCode) {
  if (!userCode) return null;
  const row = await getOwnerDeviceAuthRowByUserCode(userCode);
  if (!row) return null;
  if (row.status !== 'pending') return null;
  if (isExpired(row)) {
    await markOwnerDeviceAuthExpired(row.device_code);
    return null;
  }
  let registeredClient;
  try {
    registeredClient = await getRegisteredClient(row.client_id);
  } catch (err) {
    if (err?.code === 'invalid_client') {
      return null;
    }
    throw err;
  }
  if (!registeredClient) {
    return null;
  }
  return {
    device_code: row.device_code,
    user_code: row.user_code,
    client_id: registeredClient.client_id,
    interval: row.interval_seconds,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/**
 * Approve an owner-device authorization and mint an owner token.
 */
export async function approveOwnerDeviceAuthorization(userCode, subjectId = 'owner_local') {
  const pending = await getOwnerDeviceAuthRowByUserCode(userCode);
  if (!pending) {
    const err = new Error('Unknown user code');
    err.code = 'not_found';
    throw err;
  }
  if (pending.status !== 'pending') {
    throw attachOwnerDeviceTraceContext(Object.assign(new Error('Owner device authorization is not available'), {
      code: 'not_found',
    }), pending);
  }
  if (isExpired(pending)) {
    await markOwnerDeviceAuthExpired(pending.device_code);
    throw attachOwnerDeviceTraceContext(Object.assign(new Error('Owner device authorization has expired'), {
      code: 'not_found',
    }), pending);
  }
  let registeredClient;
  try {
    registeredClient = await getRegisteredClient(pending.client_id);
  } catch (err) {
    if (err?.code === 'invalid_client') {
      throw attachOwnerDeviceTraceContext(err, pending);
    }
    throw err;
  }
  if (!registeredClient) {
    const err = new Error(`Unknown client_id: ${pending.client_id}`);
    err.code = 'invalid_client';
    throw attachOwnerDeviceTraceContext(err, pending);
  }
  try {
    registeredClient = await bindDynamicClientToApprovingOwner(registeredClient, subjectId);
  } catch (err) {
    throw attachOwnerDeviceTraceContext(err, pending);
  }

  const traceContext = pending.trace_id
    ? {
        request_id: pending.request_id || undefined,
        trace_id: pending.trace_id,
        scenario_id: pending.scenario_id || undefined,
      }
    : null;

  await emitSpineEvent({
    event_type: 'consent.approved',
    trace_id: traceContext?.trace_id || undefined,
    scenario_id: traceContext?.scenario_id || undefined,
    request_id: traceContext?.request_id || undefined,
    actor_type: 'subject',
    actor_id: subjectId,
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'owner_device_auth',
    object_id: pending.device_code,
    status: 'succeeded',
    client_id: registeredClient.client_id,
    data: {
      issuance_path: 'owner_device_flow',
      user_code: pending.user_code,
    },
  });

  const token = await issueOwnerToken(subjectId, {
    traceContext,
    clientId: registeredClient.client_id,
    userCode: pending.user_code,
  });
  await markOwnerDeviceAuthApproved(pending.device_code, { subjectId, tokenId: token });

  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: 365 * 24 * 60 * 60,
    subject_id: subjectId,
  };
}

export async function denyOwnerDeviceAuthorization(userCode, subjectId = 'owner_local') {
  const pending = await getOwnerDeviceAuthRowByUserCode(userCode);
  if (!pending) {
    const err = new Error('Unknown user code');
    err.code = 'not_found';
    throw err;
  }
  if (pending.status !== 'pending') {
    throw attachOwnerDeviceTraceContext(Object.assign(new Error('Owner device authorization is not available'), {
      code: 'not_found',
    }), pending);
  }
  if (isExpired(pending)) {
    await markOwnerDeviceAuthExpired(pending.device_code);
    throw attachOwnerDeviceTraceContext(Object.assign(new Error('Owner device authorization has expired'), {
      code: 'not_found',
    }), pending);
  }

  const traceContext = pending.trace_id
    ? {
        request_id: pending.request_id || undefined,
        trace_id: pending.trace_id,
        scenario_id: pending.scenario_id || undefined,
      }
    : null;

  await markOwnerDeviceAuthDenied(pending.device_code);
  await emitSpineEvent({
    event_type: 'request.rejected',
    trace_id: traceContext?.trace_id || undefined,
    scenario_id: traceContext?.scenario_id || undefined,
    request_id: traceContext?.request_id || undefined,
    actor_type: 'subject',
    actor_id: subjectId,
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'owner_device_auth',
    object_id: pending.device_code,
    status: 'rejected',
    client_id: pending.client_id,
    data: {
      issuance_path: 'owner_device_flow',
      user_code: pending.user_code,
      error: {
        code: 'access_denied',
        message: 'The resource owner denied the request',
      },
    },
  });
}

/**
 * RFC 8628-style device-code polling for owner tokens.
 */
export async function exchangeOwnerDeviceCode({ clientId, deviceCode }) {
  if (!clientId || !deviceCode) {
    const err = new Error('client_id and device_code are required');
    err.code = 'invalid_request';
    throw err;
  }

  const row = await getOwnerDeviceAuthRow(deviceCode);
  if (!row || row.client_id !== clientId) {
    const err = new Error('Unknown or invalid device_code');
    err.code = 'invalid_grant';
    throw err;
  }
  let registeredClient;
  try {
    registeredClient = await getRegisteredClient(clientId);
  } catch (err) {
    if (err?.code === 'invalid_client') {
      throw attachOwnerDeviceTraceContext(err, row);
    }
    throw err;
  }
  if (!registeredClient) {
    const err = new Error(`Unknown client_id: ${clientId}`);
    err.code = 'invalid_client';
    throw attachOwnerDeviceTraceContext(err, row);
  }

  if (row.status === 'pending' && isExpired(row)) {
    await markOwnerDeviceAuthExpired(deviceCode);
    throw attachOwnerDeviceTraceContext(Object.assign(new Error('Device code has expired'), {
      code: 'expired_token',
    }), row);
  }

  if (row.status === 'denied') {
    throw attachOwnerDeviceTraceContext(Object.assign(new Error('The resource owner denied the request'), {
      code: 'access_denied',
    }), row);
  }

  if (row.status === 'expired') {
    throw attachOwnerDeviceTraceContext(Object.assign(new Error('Device code has expired'), {
      code: 'expired_token',
    }), row);
  }

  if (row.status === 'pending') {
    if (row.last_polled_at) {
      const sinceLastPollMs = Date.now() - new Date(row.last_polled_at).getTime();
      if (sinceLastPollMs < row.interval_seconds * 1000) {
        throw attachOwnerDeviceTraceContext(Object.assign(new Error('Polling too quickly'), {
          code: 'slow_down',
        }), row);
      }
    }
    await updateOwnerDeviceAuthLastPolled(deviceCode);
    throw attachOwnerDeviceTraceContext(Object.assign(new Error('Authorization still pending'), {
      code: 'authorization_pending',
    }), row);
  }

  const tokenInfo = await introspect(row.token_id);
  if (!tokenInfo.active || !tokenInfo.exp) {
    throw attachOwnerDeviceTraceContext(Object.assign(new Error('Owner token is no longer active'), {
      code: 'expired_token',
    }), row);
  }

  return {
    access_token: row.token_id,
    token_type: 'Bearer',
    expires_in: Math.max(tokenInfo.exp - Math.floor(Date.now() / 1000), 0),
    trace_context: row.trace_id
      ? {
          request_id: row.request_id || undefined,
          trace_id: row.trace_id,
          scenario_id: row.scenario_id || undefined,
        }
      : null,
  };
}

/**
 * Issue an access token bound to a grant
 */
export async function issueToken(grantId, subjectId, clientId, expiresAt, meta = {}) {
  if (isPostgresStorageBackend()) {
    const { tokenId, grantRow, persistedGrant } = await withPostgresTransaction(async (client) => {
      const result = await client.query(
        `SELECT access_mode, consumed, status, trace_id, scenario_id,
                grant_json::text AS grant_json,
                storage_binding_json::text AS storage_binding_json
         FROM grants
         WHERE grant_id = $1
         FOR UPDATE`,
        [grantId],
      );
      const row = result.rows[0] || null;

      if (!row) {
        const err = new Error(`Unknown grant: ${grantId}`);
        err.code = 'grant_invalid';
        throw err;
      }

      if (row.status !== 'active') {
        const err = new Error(
          row.status === 'revoked'
            ? 'Grant has been revoked'
            : `Grant is not active: ${row.status}`
        );
        err.code = row.status === 'revoked' ? 'grant_revoked' : 'grant_invalid';
        throw err;
      }

      if (row.access_mode === 'single_use') {
        if (row.consumed) {
          const err = new Error('Grant has already been consumed');
          err.code = 'grant_consumed';
          throw err;
        }
        await client.query("UPDATE grants SET consumed = TRUE WHERE grant_id = $1", [grantId]);
      }

      const nextTokenId = generateToken();
      await client.query(
        `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
         VALUES($1, $2, $3, $4, 'client', $5)`,
        [nextTokenId, grantId, subjectId, clientId, expiresAt],
      );
      return {
        tokenId: nextTokenId,
        grantRow: row,
        persistedGrant: requirePersistedGrantState(row).grant,
      };
    });

    await emitSpineEvent({
      event_type: 'token.issued',
      trace_id: meta.traceContext?.trace_id || grantRow.trace_id || undefined,
      scenario_id: meta.traceContext?.scenario_id || grantRow.scenario_id || undefined,
      request_id: meta.traceContext?.request_id || undefined,
      actor_type: 'authorization_server',
      actor_id: 'pdpp_as',
      subject_type: 'subject',
      subject_id: subjectId,
      object_type: 'token',
      object_id: tokenId,
      status: 'succeeded',
      grant_id: grantId,
      client_id: clientId,
      token_id: tokenId,
      data: {
        token_kind: 'client',
        issuance_path: meta.source || 'grant',
        source: describeGrantSource(persistedGrant),
      },
    });

    return tokenId;
  }

  // better-sqlite3 transactions must be synchronous. We prepare the body as a
  // synchronous function and wrap it; the public export stays `async` because
  // external callers `await issueToken(...)`.
  return transaction(() => {
    const grantRow = getOne(referenceQueries.authGrantsGetForIssuance, [grantId]);

    if (!grantRow) {
      const err = new Error(`Unknown grant: ${grantId}`);
      err.code = 'grant_invalid';
      throw err;
    }

    if (grantRow.status !== 'active') {
      const err = new Error(
        grantRow.status === 'revoked'
          ? 'Grant has been revoked'
          : `Grant is not active: ${grantRow.status}`
      );
      err.code = grantRow.status === 'revoked' ? 'grant_revoked' : 'grant_invalid';
      throw err;
    }

    if (grantRow.access_mode === 'single_use') {
      if (grantRow.consumed) {
        const err = new Error('Grant has already been consumed');
        err.code = 'grant_consumed';
        throw err;
      }
      exec(referenceQueries.authGrantsMarkConsumed, [grantId]);
    }

    const tokenId = generateToken();
    exec(referenceQueries.authTokensInsertClient, [
      tokenId,
      grantId,
      subjectId,
      clientId,
      expiresAt,
    ]);

    const { grant: persistedGrant } = requirePersistedGrantState(grantRow);
    // emitSpineEvent is sync internally; calling without await is fine
    // because the INSERT it triggers has completed before this returns.
    emitSpineEvent({
      event_type: 'token.issued',
      trace_id: meta.traceContext?.trace_id || grantRow.trace_id || undefined,
      scenario_id: meta.traceContext?.scenario_id || grantRow.scenario_id || undefined,
      request_id: meta.traceContext?.request_id || undefined,
      actor_type: 'authorization_server',
      actor_id: 'pdpp_as',
      subject_type: 'subject',
      subject_id: subjectId,
      object_type: 'token',
      object_id: tokenId,
      status: 'succeeded',
      grant_id: grantId,
      client_id: clientId,
      token_id: tokenId,
      data: {
        token_kind: 'client',
        issuance_path: meta.source || 'grant',
        source: describeGrantSource(persistedGrant),
      },
    });

    return tokenId;
  });
}
async function issueOwnerTokenRecord(subjectId, meta = {}) {
  const tokenId = generateToken();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  // Record the issuing client_id when the caller knows it (per-token DCR
  // path). Pre-DCR callers pass NULL and the row stays as before.
  // See openspec/changes/dcr-per-owner-token-with-revoke/.
  if (isPostgresStorageBackend()) {
    await pgExec(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
       VALUES($1, NULL, $2, $3, 'owner', $4)`,
      [tokenId, subjectId, meta.clientId || null, expiresAt],
    );
  } else {
    exec(referenceQueries.authTokensInsertOwner, [tokenId, subjectId, meta.clientId || null, expiresAt]);
  }
  await emitSpineEvent({
    event_type: 'token.issued',
    trace_id: meta.traceContext?.trace_id || undefined,
    scenario_id: meta.traceContext?.scenario_id || undefined,
    request_id: meta.traceContext?.request_id || undefined,
    actor_type: 'authorization_server',
    actor_id: 'pdpp_as',
    subject_type: 'subject',
    subject_id: subjectId,
    object_type: 'token',
    object_id: tokenId,
    status: 'succeeded',
    client_id: meta.clientId || null,
    token_id: tokenId,
    data: {
      token_kind: 'owner',
      issuance_path: 'owner_device_flow',
      ...(meta.userCode ? { user_code: meta.userCode } : {}),
    },
  });
  return { tokenId, expiresAt };
}

/**
 * Reference bootstrap helper for issuing an owner token for a subject.
 * This remains useful for isolated harness setup, but the public owner path is the device flow.
 */
export async function issueOwnerToken(subjectId, meta = {}) {
  const { tokenId } = await issueOwnerTokenRecord(subjectId, meta);
  return tokenId;
}

/**
 * RFC 7662-style introspection with PDPP extensions
 */
export async function introspect(token) {
  const row = isPostgresStorageBackend()
    ? await pgOne(
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
        [token],
      )
    : getOne(referenceQueries.authTokensGetIntrospection, [token]);

  if (!row) return { active: false };

  if (row.revoked) {
    return {
      active: false,
      inactive_reason: row.token_kind === 'client' ? 'grant_revoked' : 'token_revoked',
      ...(row.token_kind === 'client'
        ? {
            grant_id: row.grant_id,
            client_id: row.client_id,
            subject_id: row.subject_id,
            trace_id: row.trace_id,
            scenario_id: row.scenario_id,
          }
        : row.token_kind === 'mcp_package'
          ? {
              grant_package_id: row.package_id,
              client_id: row.client_id,
              subject_id: row.subject_id,
              trace_id: row.package_trace_id,
              scenario_id: row.package_scenario_id,
            }
          : {}),
    };
  }

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return {
      active: false,
      inactive_reason: row.token_kind === 'client' ? 'grant_expired' : 'token_expired',
      ...(row.token_kind === 'client'
        ? {
            grant_id: row.grant_id,
            client_id: row.client_id,
            subject_id: row.subject_id,
            trace_id: row.trace_id,
            scenario_id: row.scenario_id,
          }
        : row.token_kind === 'mcp_package'
          ? {
              grant_package_id: row.package_id,
              client_id: row.client_id,
              subject_id: row.subject_id,
              trace_id: row.package_trace_id,
              scenario_id: row.package_scenario_id,
            }
          : {}),
    };
  }

  // Check grant still active (for client tokens)
  if (row.token_kind === 'client' && row.grant_status !== 'active') {
    return {
      active: false,
      inactive_reason: 'grant_revoked',
      grant_id: row.grant_id,
      client_id: row.client_id,
      subject_id: row.subject_id,
      trace_id: row.trace_id,
      scenario_id: row.scenario_id,
    };
  }

  if (row.token_kind === 'mcp_package' && row.package_status !== 'active') {
    return {
      active: false,
      inactive_reason: 'package_revoked',
      grant_package_id: row.package_id,
      client_id: row.client_id,
      subject_id: row.subject_id,
      trace_id: row.package_trace_id,
      scenario_id: row.package_scenario_id,
    };
  }

  const result = {
    active: true,
    pdpp_token_kind: row.token_kind,
    subject_id: row.subject_id,
    exp: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : null,
  };

  if (row.token_kind === 'owner' && row.client_id) {
    result.client_id = row.client_id;
  }

  if (row.token_kind === 'mcp_package') {
    result.grant_package_id = row.package_id;
    result.client_id = row.client_id;
    result.package = parsePackageJson(row.package_json);
    result.trace_id = row.package_trace_id;
    result.scenario_id = row.package_scenario_id;
  }

  if (row.token_kind === 'client') {
    try {
      const {
        grant: parsedGrant,
        storageBinding: grantStorageBinding,
      } = requirePersistedGrantState(row);
      try {
        const manifest = await getManifestForStorageBinding(grantStorageBinding);
        if (manifest) {
          requireGrantContractAgainstManifest(parsedGrant, manifest);
        }
      } catch (err) {
        if (err?.code === 'grant_invalid') {
          return {
            active: false,
            inactive_reason: 'grant_invalid',
            grant_id: row.grant_id,
            client_id: row.client_id,
            subject_id: row.subject_id,
            trace_id: row.trace_id,
            scenario_id: row.scenario_id,
          };
        }
      }
      result.grant_id = row.grant_id;
      result.client_id = row.client_id;
      result.grant = parsedGrant;
      result.grant_storage_binding = grantStorageBinding;
      result.trace_id = row.trace_id;
      result.scenario_id = row.scenario_id;
    } catch {
      return {
        active: false,
        inactive_reason: 'grant_invalid',
        grant_id: row.grant_id,
        client_id: row.client_id,
        subject_id: row.subject_id,
        trace_id: row.trace_id,
        scenario_id: row.scenario_id,
      };
    }
  }

  return result;
}

/**
 * Revoke a grant
 */
export async function revokeGrant(grantId, context = {}) {
  const row0 = isPostgresStorageBackend()
    ? await pgOne(
        `SELECT client_id, subject_id, trace_id, scenario_id,
                grant_json::text AS grant_json,
                storage_binding_json::text AS storage_binding_json
         FROM grants
         WHERE grant_id = $1`,
        [grantId],
      )
    : getOne(referenceQueries.authGrantsGetForRevocation, [grantId]);

  let parsedGrant = null;
  if (row0) {
    try {
      const {
        grant,
        storageBinding,
      } = requirePersistedGrantState(row0);
      const manifest = await getManifestForStorageBinding(storageBinding);
      if (manifest) {
        requireGrantContractAgainstManifest(grant, manifest);
      }
      parsedGrant = grant;
    } catch (err) {
      if (err?.code === 'grant_invalid') {
        const row = row0;
        const sourceDescriptor = describePersistedGrantSource(row);
        await emitSpineEvent({
          event_type: 'grant.revoke_rejected',
          trace_id: row.trace_id || undefined,
          scenario_id: row.scenario_id || undefined,
          request_id: context.request_id || undefined,
          actor_type: 'authorization_server',
          actor_id: 'pdpp_as',
          subject_type: 'subject',
          subject_id: row.subject_id,
          object_type: 'grant',
          object_id: grantId,
          status: 'rejected',
          grant_id: grantId,
          client_id: row.client_id,
          data: {
            ...(sourceDescriptor ? { source: sourceDescriptor } : {}),
            error: {
              code: 'grant_invalid',
              message: 'Grant is malformed or no longer valid',
            },
          },
        });
        throw buildGrantInvalidError({
          request_id: context.request_id,
          trace_id: row.trace_id,
        });
      }
      throw err;
    }
  }

  if (isPostgresStorageBackend()) {
    await pgExec("UPDATE grants SET status = 'revoked' WHERE grant_id = $1", [grantId]);
    // Also revoke all tokens for this grant.
    await pgExec("UPDATE tokens SET revoked = TRUE WHERE grant_id = $1", [grantId]);
    await pgExec(
      "UPDATE oauth_refresh_tokens SET status = 'revoked', revoked_at = $1 WHERE grant_id = $2 AND status = 'active'",
      [nowIso(), grantId],
    );
  } else {
    exec(referenceQueries.authGrantsMarkRevoked, [grantId]);
    // Also revoke all tokens for this grant
    exec(referenceQueries.authTokensRevokeByGrant, [grantId]);
    exec(referenceQueries.authOauthRefreshTokensRevokeByGrant, [nowIso(), grantId]);
  }

  if (row0 && parsedGrant) {
    const row = row0;
    await emitSpineEvent({
      event_type: 'grant.revoked',
      trace_id: row.trace_id || undefined,
      scenario_id: row.scenario_id || undefined,
      actor_type: 'authorization_server',
      actor_id: 'pdpp_as',
      request_id: context.request_id || undefined,
      subject_type: 'subject',
      subject_id: row.subject_id,
      object_type: 'grant',
      object_id: grantId,
      status: 'succeeded',
      grant_id: grantId,
      client_id: row.client_id,
      data: {
        source: describeGrantSource(parsedGrant),
      },
    });
  }

  return {
    request_id: context.request_id || null,
    trace_id: row0?.trace_id || null,
  };
}
