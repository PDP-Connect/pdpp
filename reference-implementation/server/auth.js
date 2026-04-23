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
import { getDb, sql } from './db.js';
import { createTraceContext, emitSpineEvent } from '../lib/spine.js';

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
const SUPPORTED_PENDING_SELECTION_FIELDS = new Set([
  'access_mode',
  'purpose_code',
  'purpose_description',
  'retention',
  'streams',
  'type',
]);

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
  const db = getDb();
  const rows = await db.query(sql`
    SELECT * FROM pending_consents WHERE device_code = ${deviceCode}
  `);
  return rows[0] || null;
}

async function createPendingConsent(deviceCode, userCode, params, expiresAt) {
  const db = getDb();
  const createdAt = nowIso();
  const traceContext = getRequestTraceContext(params);
  await db.query(sql`
    INSERT INTO pending_consents(device_code, user_code, params_json, status, request_id, trace_id, scenario_id, created_at, expires_at)
    VALUES(
      ${deviceCode},
      ${userCode},
      ${JSON.stringify(params)},
      'pending',
      ${traceContext.request_id},
      ${traceContext.trace_id},
      ${traceContext.scenario_id || null},
      ${createdAt},
      ${expiresAt}
    )
  `);
}

async function markPendingConsentApproved(deviceCode, { subjectId, grantId, tokenId, aiTrainingConsented }) {
  const db = getDb();
  await db.query(sql`
    UPDATE pending_consents
    SET status = 'approved',
        subject_id = ${subjectId},
        grant_id = ${grantId},
        token_id = ${tokenId},
        ai_training_consented = ${aiTrainingConsented ? 1 : null},
        approved_at = ${nowIso()}
    WHERE device_code = ${deviceCode}
  `);
}

async function markPendingConsentDenied(deviceCode) {
  const db = getDb();
  await db.query(sql`
    UPDATE pending_consents
    SET status = 'denied',
        denied_at = ${nowIso()}
    WHERE device_code = ${deviceCode}
      AND status = 'pending'
  `);
}

async function markPendingConsentExpired(deviceCode) {
  const db = getDb();
  await db.query(sql`
    UPDATE pending_consents
    SET status = 'expired'
    WHERE device_code = ${deviceCode}
      AND status = 'pending'
  `);
}

async function getOwnerDeviceAuthRow(deviceCode) {
  const db = getDb();
  const rows = await db.query(sql`
    SELECT * FROM owner_device_auth WHERE device_code = ${deviceCode}
  `);
  return rows[0] || null;
}

async function getOwnerDeviceAuthRowByUserCode(userCode) {
  const db = getDb();
  const rows = await db.query(sql`
    SELECT * FROM owner_device_auth WHERE user_code = ${userCode}
  `);
  return rows[0] || null;
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
  const db = getDb();
  await db.query(sql`
    INSERT INTO owner_device_auth(device_code, user_code, client_id, status, interval_seconds, created_at, expires_at, request_id, trace_id, scenario_id)
    VALUES(${deviceCode}, ${userCode}, ${clientId}, 'pending', ${intervalSeconds}, ${nowIso()}, ${expiresAt}, ${requestId}, ${traceId}, ${scenarioId})
  `);
}

async function markOwnerDeviceAuthApproved(deviceCode, { subjectId, tokenId }) {
  const db = getDb();
  await db.query(sql`
    UPDATE owner_device_auth
    SET status = 'approved',
        subject_id = ${subjectId},
        token_id = ${tokenId},
        approved_at = ${nowIso()}
    WHERE device_code = ${deviceCode}
  `);
}

async function markOwnerDeviceAuthDenied(deviceCode) {
  const db = getDb();
  await db.query(sql`
    UPDATE owner_device_auth
    SET status = 'denied',
        denied_at = ${nowIso()}
    WHERE device_code = ${deviceCode}
      AND status = 'pending'
  `);
}

async function markOwnerDeviceAuthExpired(deviceCode) {
  const db = getDb();
  await db.query(sql`
    UPDATE owner_device_auth
    SET status = 'expired'
    WHERE device_code = ${deviceCode}
      AND status = 'pending'
  `);
}

async function updateOwnerDeviceAuthLastPolled(deviceCode) {
  const db = getDb();
  await db.query(sql`
    UPDATE owner_device_auth
    SET last_polled_at = ${nowIso()}
    WHERE device_code = ${deviceCode}
  `);
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
  const db = getDb();
  const timestamp = nowIso();
  await db.query(sql`
    INSERT INTO oauth_clients(client_id, registration_mode, token_endpoint_auth_method, client_secret, metadata_json, created_at, updated_at)
    VALUES(
      ${clientId},
      ${registrationMode},
      ${normalizedMetadata.token_endpoint_auth_method},
      ${clientSecret},
      ${JSON.stringify(normalizedMetadata)},
      ${timestamp},
      ${timestamp}
    )
    ON CONFLICT(client_id) DO UPDATE SET
      registration_mode = excluded.registration_mode,
      token_endpoint_auth_method = excluded.token_endpoint_auth_method,
      client_secret = excluded.client_secret,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `);
}

export async function seedPreRegisteredClients(clients = []) {
  for (const client of clients) {
    if (!client?.client_id) continue;
    await upsertRegisteredClient({
      clientId: client.client_id,
      registrationMode: client.registration_mode || 'pre_registered_public',
      metadata: client.metadata || {
        client_name: client.client_name || client.client_id,
        token_endpoint_auth_method: client.token_endpoint_auth_method || 'none',
      },
      clientSecret: client.client_secret || null,
    });
  }
}

export async function getRegisteredClient(clientId) {
  if (!clientId) return null;
  const db = getDb();
  const rows = await db.query(sql`
    SELECT client_id, registration_mode, token_endpoint_auth_method, client_secret, metadata_json, created_at, updated_at
    FROM oauth_clients
    WHERE client_id = ${clientId}
  `);
  return mapRegisteredClientRow(rows[0] || null);
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

function validateConnectorManifest(manifest = {}, code = 'invalid_request') {
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
    // stream-level declaration. v1 accepts only top-level scalar string fields
    // declared in schema.properties. Nested paths, arrays, blobs, and unknown
    // fields are rejected. See:
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
        if (fieldSchema?.type !== 'string') {
          throw invalidConnectorManifest(`Stream '${stream.name}' query.search.lexical_fields entry '${fieldName}' must be a top-level string field; v1 does not support nested paths, arrays, or non-string types`, code);
        }
      }
    }
  }
}

/**
 * Register or update a connector manifest
 */
export async function registerConnector(manifest) {
  validateConnectorManifest(manifest);
  const db = getDb();
  await db.query(sql`
    INSERT INTO connectors(connector_id, manifest)
    VALUES(${manifest.connector_id}, ${JSON.stringify(manifest)})
    ON CONFLICT(connector_id) DO UPDATE SET manifest = excluded.manifest
  `);
  return manifest.connector_id;
}

/**
 * Get manifest by connector_id
 */
export async function getConnectorManifest(connectorId) {
  if (!connectorId) return null;

  const db = getDb();
  const rows = await db.query(sql`
    SELECT manifest FROM connectors WHERE connector_id = ${connectorId}
  `);
  if (!rows.length) return null;
  try {
    const manifest = JSON.parse(rows[0].manifest);
    validateConnectorManifest(manifest, 'connector_invalid');
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

  await db.query(sql`
    INSERT INTO grants(
      grant_id,
      subject_id,
      client_id,
      storage_binding_json,
      grant_json,
      access_mode,
      issued_at,
      expires_at,
      trace_id,
      scenario_id
    )
    VALUES(
      ${grantId},
      ${subjectId},
      ${registeredClient.client_id},
      ${serializeStorageBinding(persistedStorageBinding)},
      ${JSON.stringify(grant)},
      ${selection.access_mode},
      ${issuedAt},
      ${expiresAt},
      ${traceContext.trace_id},
      ${traceContext.scenario_id}
    )
  `);

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
  return db.tx(async (tx) => {
    const grantRows = await tx.query(sql`
      SELECT access_mode, consumed, status, trace_id, scenario_id, grant_json, storage_binding_json
      FROM grants
      WHERE grant_id = ${grantId}
    `);

    if (!grantRows.length) {
      const err = new Error(`Unknown grant: ${grantId}`);
      err.code = 'grant_invalid';
      throw err;
    }

    const grantRow = grantRows[0];
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
      await tx.query(sql`
        UPDATE grants
        SET consumed = 1
        WHERE grant_id = ${grantId}
      `);
    }

    const tokenId = generateToken();
    await tx.query(sql`
      INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
      VALUES(${tokenId}, ${grantId}, ${subjectId}, ${clientId}, 'client', ${expiresAt})
    `);

    const {
      grant: persistedGrant,
      storageBinding: grantStorageBinding,
    } = requirePersistedGrantState(grantRow);
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
    }, tx);

    return tokenId;
  });
}
async function issueOwnerTokenRecord(subjectId, meta = {}) {
  const db = getDb();
  const tokenId = generateToken();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await db.query(sql`
    INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
    VALUES(${tokenId}, NULL, ${subjectId}, NULL, 'owner', ${expiresAt})
  `);
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
  const db = getDb();
  const rows = await db.query(sql`
    SELECT t.token_id, t.grant_id, t.subject_id, t.client_id, t.token_kind, t.expires_at, t.revoked,
           g.status as grant_status, g.grant_json, g.trace_id, g.scenario_id,
           g.storage_binding_json
    FROM tokens t
    LEFT JOIN grants g ON t.grant_id = g.grant_id
    WHERE t.token_id = ${token}
  `);

  if (!rows.length) return { active: false };

  const row = rows[0];

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
  const rows = await db.query(sql`
    SELECT client_id, subject_id, trace_id, scenario_id, grant_json, storage_binding_json
    FROM grants
    WHERE grant_id = ${grantId}
  `);

  let parsedGrant = null;
  if (rows.length) {
    try {
      const {
        grant,
        storageBinding,
      } = requirePersistedGrantState(rows[0]);
      const manifest = await getManifestForStorageBinding(storageBinding);
      if (manifest) {
        requireGrantContractAgainstManifest(grant, manifest);
      }
      parsedGrant = grant;
    } catch (err) {
      if (err?.code === 'grant_invalid') {
        const row = rows[0];
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

  await db.query(sql`UPDATE grants SET status = 'revoked' WHERE grant_id = ${grantId}`);
  // Also revoke all tokens for this grant
  await db.query(sql`UPDATE tokens SET revoked = 1 WHERE grant_id = ${grantId}`);

  if (rows.length && parsedGrant) {
    const row = rows[0];
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
    trace_id: rows[0]?.trace_id || null,
  };
}
