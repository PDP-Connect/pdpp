/**
 * PDPP Authorization Server — grant issuance + token management
 *
 * Simplified AS for the current reference flow:
 * - Implements a real owner device flow for CLI/self-export
 * - Stages PDPP client requests through a PAR-backed pending-consent substrate
 * - Issues opaque bearer tokens (random strings)
 * - Implements RFC 7662-style introspection with PDPP extensions
 */
import { randomBytes } from 'crypto';
import { getDb, runWithSqliteBusyRetry } from './db.js';
import { createTraceContext, emitSpineEvent } from '../lib/spine.ts';

function generateToken() {
  return randomBytes(32).toString('hex');
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

let configuredNativeManifest = null;
const PENDING_CONSENT_REQUEST_URI_PREFIX = 'urn:pdpp:pending-consent:';
const SUPPORTED_CLIENT_AUTH_METHODS = new Set(['none']);
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
  'scenario_id',
]);
const SUPPORTED_AUTHORIZATION_DETAIL_FIELDS = new Set([
  'access_mode',
  'connector_id',
  'provider_id',
  'purpose_code',
  'purpose_description',
  'retention',
  'streams',
  'type',
]);
const SUPPORTED_STREAM_SELECTION_FIELDS = new Set([
  'client_claims',
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
    const err = new Error('grant_types metadata is not supported by the current reference registration profile');
    err.code = 'invalid_client_metadata';
    throw err;
  }

  if (metadata.response_types?.length) {
    const err = new Error('response_types metadata is not supported by the current reference registration profile');
    err.code = 'invalid_client_metadata';
    throw err;
  }

  if (metadata.application_type) {
    const err = new Error('application_type metadata is not supported by the current reference registration profile');
    err.code = 'invalid_client_metadata';
    throw err;
  }

  return {
    client_name: metadata.client_name,
    redirect_uris: metadata.redirect_uris,
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
  };
}

function isEnvelopeRequest(input) {
  return Array.isArray(input?.authorization_details);
}

function normalizePendingGrantRequest(input, opts = {}) {
  const invalidRequest = (message) => {
    const err = new Error(message);
    err.code = 'invalid_request';
    throw err;
  };

  if (!input || typeof input !== 'object') {
    invalidRequest('Grant initiation requires a JSON object body');
  }

  const unsupportedRequestFields = Object.keys(input).filter((field) => !SUPPORTED_PENDING_REQUEST_FIELDS.has(field));
  if (unsupportedRequestFields.length) {
    invalidRequest(`Unsupported request fields: ${unsupportedRequestFields.join(', ')}`);
  }

  if (!isEnvelopeRequest(input)) {
    invalidRequest('Grant initiation requires authorization_details');
  }

  if (typeof input.client_id !== 'string' || !input.client_id.trim()) {
    invalidRequest('Grant initiation requires client_id');
  }

  if (input.authorization_details.length !== 1) {
    invalidRequest('Exactly one authorization_details entry is supported in the current reference flow');
  }

  const detail = input.authorization_details[0];
  if (!detail || detail.type !== 'https://pdpp.org/data-access') {
    invalidRequest('Unsupported authorization_details type');
  }
  const unsupportedDetailFields = Object.keys(detail).filter((field) => !SUPPORTED_AUTHORIZATION_DETAIL_FIELDS.has(field));
  if (unsupportedDetailFields.length) {
    invalidRequest(`Unsupported authorization_details fields: ${unsupportedDetailFields.join(', ')}`);
  }
  if (!Array.isArray(detail.streams) || detail.streams.length === 0) {
    invalidRequest('authorization_details[0].streams must be a non-empty array');
  }
  if (detail.connector_id && detail.provider_id) {
    invalidRequest('authorization_details must not include both connector_id and provider_id');
  }
  if (!SUPPORTED_ACCESS_MODES.has(detail.access_mode)) {
    invalidRequest('authorization_details[0].access_mode must be "single_use" or "continuous"');
  }
  for (const stream of detail.streams) {
    if (!stream || typeof stream !== 'object') {
      invalidRequest('authorization_details[0].streams entries must be objects');
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
  if (detail.provider_id && configuredNativeProviderId && detail.provider_id !== configuredNativeProviderId) {
    invalidRequest(`Unknown native provider: ${detail.provider_id}`);
  }

  const bindingKind = detail.connector_id ? 'connector' : (detail.provider_id ? 'provider_native' : null);
  const providerId = detail.provider_id || configuredNativeProviderId;
  const resolvedConnectorId = bindingKind === 'connector'
    ? detail.connector_id
    : (bindingKind === 'provider_native' ? configuredNativeStorageConnectorId : null);
  if (!bindingKind || !resolvedConnectorId) {
    invalidRequest('authorization_details must include connector_id for polyfill access or provider_id for native provider access');
  }

  const sourceBinding = bindingKind === 'provider_native'
    ? {
        binding_kind: bindingKind,
        provider_id: providerId,
      }
    : {
        binding_kind: bindingKind,
        connector_id: resolvedConnectorId,
      };

  return {
    request_kind: 'pdpp_selection_request',
    request_version: 'reference.v1',
    client: {
      client_id: input.client_id.trim(),
      client_display: normalizeClientDisplay(input.client_display),
    },
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
  if (!sourceBinding || typeof sourceBinding !== 'object') {
    throw bindingError(code, `${fieldName} is required`);
  }

  if (sourceBinding.binding_kind === 'connector') {
    if (!isNonEmptyString(sourceBinding.connector_id)) {
      throw bindingError(code, `${fieldName}.connector_id is required for connector access`);
    }
    return { binding_kind: 'connector', connector_id: sourceBinding.connector_id };
  }

  if (sourceBinding.binding_kind === 'provider_native') {
    if (!isNonEmptyString(sourceBinding.provider_id)) {
      throw bindingError(code, `${fieldName}.provider_id is required for native provider access`);
    }
    return { binding_kind: 'provider_native', provider_id: sourceBinding.provider_id };
  }

  throw bindingError(code, `${fieldName}.binding_kind must be 'connector' or 'provider_native'`);
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
  if (sourceBinding.binding_kind === 'connector' && !hasExactBindingKeys(requestSourceBinding, ['binding_kind', 'connector_id'])) {
    throw bindingError('invalid_request', 'source_binding must include only binding_kind and connector_id');
  }
  if (sourceBinding.binding_kind === 'provider_native' && !hasExactBindingKeys(requestSourceBinding, ['binding_kind', 'provider_id'])) {
    throw bindingError('invalid_request', 'source_binding must include only binding_kind and provider_id');
  }
  if (!hasExactBindingKeys(requestStorageBinding, ['connector_id'])) {
    throw bindingError('invalid_request', 'storage_binding must include only connector_id');
  }

  if (
    sourceBinding.binding_kind === 'connector'
    && sourceBinding.connector_id !== storageBinding.connector_id
  ) {
    throw bindingError('invalid_request', 'source_binding.connector_id must match storage_binding.connector_id');
  }

  if (sourceBinding.binding_kind === 'provider_native') {
    const nativeManifest = resolveConfiguredNativeManifest();
    const nativeStorageBinding = resolveConfiguredNativeStorageBinding();
    if (!nativeManifest?.provider_id || !nativeStorageBinding?.connector_id) {
      throw bindingError('invalid_request', 'native provider access requires a configured native manifest');
    }
    if (sourceBinding.provider_id !== nativeManifest.provider_id) {
      throw bindingError('invalid_request', 'source_binding.provider_id must match the configured native provider');
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
    const err = sourceBinding?.binding_kind === 'provider_native'
      ? new Error(`Unknown native provider: ${sourceBinding.provider_id}`)
      : new Error(`Unknown connector: ${grantStorageConnectorId}`);
    err.code = 'invalid_request';
    throw err;
  });
}

function resolveGrantSelection(selection = {}, manifest = {}) {
  let streams = selection.streams || [];
  if (streams.length === 1 && streams[0].name === '*') {
    streams = manifest.streams.map((stream) => ({ name: stream.name }));
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
  if (sourceBinding.binding_kind === 'connector' && !hasExactBindingKeys(grant?.source, ['binding_kind', 'connector_id'])) {
    throw bindingError('grant_invalid', 'grant.source must include only binding_kind and connector_id');
  }
  if (sourceBinding.binding_kind === 'provider_native' && !hasExactBindingKeys(grant?.source, ['binding_kind', 'provider_id'])) {
    throw bindingError('grant_invalid', 'grant.source must include only binding_kind and provider_id');
  }
  if (!hasExactBindingKeys(storageBinding, ['connector_id'])) {
    throw bindingError('grant_invalid', 'grant_storage_binding must include only connector_id');
  }

  if (
    sourceBinding.binding_kind === 'connector'
    && sourceBinding.connector_id !== normalizedStorageBinding.connector_id
  ) {
    throw bindingError('grant_invalid', 'grant.source.connector_id must match grant_storage_binding.connector_id');
  }

  if (sourceBinding.binding_kind === 'provider_native') {
    const nativeManifest = resolveConfiguredNativeManifest();
    const nativeStorageBinding = resolveConfiguredNativeStorageBinding();
    if (!nativeManifest?.provider_id || !nativeStorageBinding?.connector_id) {
      throw bindingError('grant_invalid', 'provider-native grants require a configured native manifest');
    }
    if (sourceBinding.provider_id !== nativeManifest.provider_id) {
      throw bindingError('grant_invalid', 'grant.source.provider_id must match the configured native provider');
    }
    if (normalizedStorageBinding.connector_id !== nativeStorageBinding.connector_id) {
      throw bindingError('grant_invalid', 'grant_storage_binding.connector_id must match the configured native storage binding');
    }
  }

  return { sourceBinding, storageBinding: normalizedStorageBinding };
}

function describeSourceBinding(sourceBinding) {
  if (sourceBinding?.binding_kind === 'provider_native') {
    return isNonEmptyString(sourceBinding.provider_id)
      ? { binding_kind: 'provider_native', provider_id: sourceBinding.provider_id }
      : null;
  }
  if (sourceBinding?.binding_kind === 'connector' && isNonEmptyString(sourceBinding.connector_id)) {
    return { binding_kind: 'connector', connector_id: sourceBinding.connector_id };
  }
  return null;
}

function describeGrantSource(grant) {
  return describeSourceBinding(grant?.source);
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
    const expectedKeys = sourceBinding.binding_kind === 'provider_native'
      ? ['binding_kind', 'provider_id']
      : ['binding_kind', 'connector_id'];
    if (!hasExactBindingKeys(grant?.source, expectedKeys)) {
      return null;
    }
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
  return getDb().prepare(
    'SELECT * FROM pending_consents WHERE device_code = ?'
  ).get(deviceCode) || null;
}

async function createPendingConsent(deviceCode, userCode, params, expiresAt) {
  const createdAt = nowIso();
  const traceContext = getRequestTraceContext(params);
  getDb().prepare(`
    INSERT INTO pending_consents(
      device_code, user_code, params_json, status,
      request_id, trace_id, scenario_id, created_at, expires_at
    ) VALUES(?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    deviceCode,
    userCode,
    JSON.stringify(params),
    traceContext.request_id,
    traceContext.trace_id,
    traceContext.scenario_id || null,
    createdAt,
    expiresAt,
  );
}

async function markPendingConsentApproved(deviceCode, { subjectId, grantId, tokenId, aiTrainingConsented }) {
  getDb().prepare(`
    UPDATE pending_consents
    SET status = 'approved',
        subject_id = ?,
        grant_id = ?,
        token_id = ?,
        ai_training_consented = ?,
        approved_at = ?
    WHERE device_code = ?
  `).run(subjectId, grantId, tokenId, aiTrainingConsented ? 1 : null, nowIso(), deviceCode);
}

async function markPendingConsentDenied(deviceCode) {
  getDb().prepare(`
    UPDATE pending_consents
    SET status = 'denied', denied_at = ?
    WHERE device_code = ? AND status = 'pending'
  `).run(nowIso(), deviceCode);
}

async function markPendingConsentExpired(deviceCode) {
  getDb().prepare(`
    UPDATE pending_consents
    SET status = 'expired'
    WHERE device_code = ? AND status = 'pending'
  `).run(deviceCode);
}

async function getOwnerDeviceAuthRow(deviceCode) {
  return getDb().prepare(
    'SELECT * FROM owner_device_auth WHERE device_code = ?'
  ).get(deviceCode) || null;
}

async function getOwnerDeviceAuthRowByUserCode(userCode) {
  return getDb().prepare(
    'SELECT * FROM owner_device_auth WHERE user_code = ?'
  ).get(userCode) || null;
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
  getDb().prepare(`
    INSERT INTO owner_device_auth(
      device_code, user_code, client_id, status, interval_seconds,
      created_at, expires_at, request_id, trace_id, scenario_id
    ) VALUES(?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(deviceCode, userCode, clientId, intervalSeconds, nowIso(), expiresAt, requestId, traceId, scenarioId);
}

async function markOwnerDeviceAuthApproved(deviceCode, { subjectId, tokenId }) {
  getDb().prepare(`
    UPDATE owner_device_auth
    SET status = 'approved',
        subject_id = ?,
        token_id = ?,
        approved_at = ?
    WHERE device_code = ?
  `).run(subjectId, tokenId, nowIso(), deviceCode);
}

async function markOwnerDeviceAuthDenied(deviceCode) {
  getDb().prepare(`
    UPDATE owner_device_auth
    SET status = 'denied', denied_at = ?
    WHERE device_code = ? AND status = 'pending'
  `).run(nowIso(), deviceCode);
}

async function markOwnerDeviceAuthExpired(deviceCode) {
  getDb().prepare(`
    UPDATE owner_device_auth
    SET status = 'expired'
    WHERE device_code = ? AND status = 'pending'
  `).run(deviceCode);
}

async function updateOwnerDeviceAuthLastPolled(deviceCode) {
  getDb().prepare(`
    UPDATE owner_device_auth
    SET last_polled_at = ?
    WHERE device_code = ?
  `).run(nowIso(), deviceCode);
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
    metadata = normalizeClientRegistrationMetadata(rawMetadata);
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

  const normalizedMetadata = normalizeClientRegistrationMetadata(metadata);
  const timestamp = nowIso();
  getDb().prepare(`
    INSERT INTO oauth_clients(
      client_id, registration_mode, token_endpoint_auth_method,
      client_secret, metadata_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET
      registration_mode = excluded.registration_mode,
      token_endpoint_auth_method = excluded.token_endpoint_auth_method,
      client_secret = excluded.client_secret,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    clientId,
    registrationMode,
    normalizedMetadata.token_endpoint_auth_method,
    clientSecret,
    JSON.stringify(normalizedMetadata),
    timestamp,
    timestamp,
  );
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
  const row = getDb().prepare(`
    SELECT client_id, registration_mode, token_endpoint_auth_method, client_secret, metadata_json, created_at, updated_at
    FROM oauth_clients
    WHERE client_id = ?
  `).get(clientId);
  return mapRegisteredClientRow(row || null);
}

export async function registerDynamicClient(input = {}) {
  const metadata = normalizeClientRegistrationMetadata(input);
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
    client_uri: registered.metadata.client_uri || null,
    logo_uri: registered.metadata.logo_uri || null,
    policy_uri: registered.metadata.policy_uri || null,
    tos_uri: registered.metadata.tos_uri || null,
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
  'interaction_posture',
  'session_lifetime_seconds',
  'rate_limit_sensitivity',
  'bot_detection_sensitivity',
  'background_safe',
  'rationale',
]);

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

function validateConnectorManifest(manifest = {}, code = 'invalid_request', opts = {}) {
  if (!isNonEmptyString(manifest.connector_id)) {
    throw invalidConnectorManifest('connector_id is required', code);
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

  validateRefreshPolicyCapability(manifest, code);

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
      const allowedKeys = new Set(['count', 'sum', 'min', 'max', 'group_by']);
      const unknownKeys = Object.keys(declared).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations has unsupported keys: ${unknownKeys.join(', ')}`, code);
      }
      if (declared.count !== undefined && declared.count !== true) {
        throw invalidConnectorManifest(`Stream '${stream.name}' query.aggregations.count must be true when declared`, code);
      }
      for (const key of ['sum', 'min', 'max', 'group_by']) {
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
export async function registerConnector(manifest) {
  validateConnectorManifest(manifest);
  getDb().prepare(`
    INSERT INTO connectors(connector_id, manifest)
    VALUES(?, ?)
    ON CONFLICT(connector_id) DO UPDATE SET manifest = excluded.manifest
  `).run(manifest.connector_id, JSON.stringify(manifest));
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
  await lexicalIndexBackfillForManifest({ manifest });

  // Semantic retrieval index drift-detect + backfill. Parallel to lexical;
  // handles the same three cases for semantic_fields, plus the backend-
  // identity change case (model_id/dimensions/distance_metric drift).
  // No-op when no embedding backend is configured (semanticRetrievalSupported
  // === false at startServer time) or when no stream declares semantic_fields.
  const { semanticIndexBackfillForManifest, getSemanticBackend } = await import('./search-semantic.js');
  if (getSemanticBackend()) {
    await semanticIndexBackfillForManifest({ manifest });
  }
  return manifest.connector_id;
}

/**
 * List all registered connector_ids. Returned in stable id order so callers
 * (e.g. the lexical retrieval extension's owner-mode cross-connector
 * fan-out) get deterministic enumeration.
 */
export async function listRegisteredConnectorIds() {
  const rows = getDb().prepare(
    'SELECT connector_id FROM connectors ORDER BY connector_id ASC'
  ).all();
  return rows.map((row) => row.connector_id);
}

/**
 * Get manifest by connector_id
 */
export async function getConnectorManifest(connectorId) {
  if (!connectorId) return null;

  const row = getDb().prepare(
    'SELECT manifest FROM connectors WHERE connector_id = ?'
  ).get(connectorId);
  if (!row) return null;
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
 * Persist a pending grant-approval request and expose it as a PAR-backed consent request.
 * Returns the staged request URI plus the consent URL for the primary request/approval flow.
 */
export async function initiateGrant(input, opts = {}) {
  const normalized = normalizePendingGrantRequest(input, opts);
  requireStructuredPendingRequestShape(normalized);
  const traceContext = getRequestTraceContext(normalized, opts.scenarioId || input?.scenario_id);
  normalized.trace_context = traceContext;
  const sourceBinding = getRequestSourceBinding(normalized);

  try {
    const registeredClient = await getRegisteredClient(normalized.client.client_id);
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
  try {
    requireStructuredPendingRequestShape(request);
    await requirePendingRequestClientRegistration(request);
    const { sourceBinding, storageBinding } = requireStructuredPendingRequestBindings(request);
    request.source_binding = describeSourceBinding(sourceBinding);
    request.storage_binding = normalizeStorageBinding(storageBinding);
    const manifest = await requireGrantManifestForBindings(sourceBinding, storageBinding);
    requirePendingRequestContractAgainstManifest(request, manifest);
  } catch (err) {
    await emitPendingConsentRejected(request, row, err);
    throw err;
  }
  return {
    request,
    userCode: row.user_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
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

  const db = getDb();
  const request = JSON.parse(pending.params_json);
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
  const { ai_training_consented } = opts;
  if (selection.purpose_code === 'https://pdpp.org/purpose/ai_training' && !ai_training_consented) {
    throw new Error('Explicit affirmative consent required for ai_training purpose');
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

  db.prepare(`
    INSERT INTO grants(
      grant_id, subject_id, client_id, storage_binding_json, grant_json,
      access_mode, issued_at, expires_at, trace_id, scenario_id
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
  );

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
  const db = getDb();
  // better-sqlite3 transactions must be synchronous. We prepare the body as a
  // synchronous function and wrap it; the public export stays `async` because
  // external callers `await issueToken(...)`.
  const issue = db.transaction(() => {
    const grantRow = db.prepare(`
      SELECT access_mode, consumed, status, trace_id, scenario_id, grant_json, storage_binding_json
      FROM grants
      WHERE grant_id = ?
    `).get(grantId);

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
      db.prepare('UPDATE grants SET consumed = 1 WHERE grant_id = ?').run(grantId);
    }

    const tokenId = generateToken();
    db.prepare(`
      INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
      VALUES(?, ?, ?, ?, 'client', ?)
    `).run(tokenId, grantId, subjectId, clientId, expiresAt);

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
  return issue();
}
async function issueOwnerTokenRecord(subjectId, meta = {}) {
  const tokenId = generateToken();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare(`
    INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
    VALUES(?, NULL, ?, NULL, 'owner', ?)
  `).run(tokenId, subjectId, expiresAt);
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
  const row = getDb().prepare(`
    SELECT t.token_id, t.grant_id, t.subject_id, t.client_id, t.token_kind, t.expires_at, t.revoked,
           g.status as grant_status, g.grant_json, g.trace_id, g.scenario_id,
           g.storage_binding_json
    FROM tokens t
    LEFT JOIN grants g ON t.grant_id = g.grant_id
    WHERE t.token_id = ?
  `).get(token);

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

  const result = {
    active: true,
    pdpp_token_kind: row.token_kind,
    subject_id: row.subject_id,
    exp: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : null,
  };

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
  const db = getDb();
  const row0 = db.prepare(`
    SELECT client_id, subject_id, trace_id, scenario_id, grant_json, storage_binding_json
    FROM grants
    WHERE grant_id = ?
  `).get(grantId);

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

  db.prepare("UPDATE grants SET status = 'revoked' WHERE grant_id = ?").run(grantId);
  // Also revoke all tokens for this grant
  db.prepare('UPDATE tokens SET revoked = 1 WHERE grant_id = ?').run(grantId);

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
