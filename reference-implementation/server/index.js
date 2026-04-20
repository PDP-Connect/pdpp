/**
 * PDPP Personal Server
 *
 * Combined AS + RS implementing PDPP v0.1.0 core spec.
 * Starts on port 7662 (AS/introspection) and 7663 (RS query API).
 */
import express from 'express';
import { getDb, initDb, sql } from './db.js';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  resolvePublicUrl,
  stripTrailingSlash,
} from './metadata.js';
import { createTraceContext, emitSpineEvent, generateSpineId, listSpineCorrelations, listSpineEvents, searchSpine } from '../lib/spine.js';
import {
  registerConnector, getConnectorManifest, getManifestForStorageBinding, initiateGrant, getPendingConsent,
  approveGrant, introspect, revokeGrant, denyGrant,
  initiateOwnerDeviceAuthorization, getOwnerDeviceAuthorizationByUserCode,
  approveOwnerDeviceAuthorization, denyOwnerDeviceAuthorization, exchangeOwnerDeviceCode, configureNativeManifest,
  parsePendingConsentRequestUri, registerDynamicClient, requireGrantContractAgainstManifest, requireResolvedPersistedGrantState, seedPreRegisteredClients,
} from './auth.js';
import {
  ingestRecord, queryRecords, getRecord, deleteRecord, deleteAllRecords,
  listStreams, listAllStreams, getSyncState, putSyncState,
} from './records.js';

const AS_PORT = parseInt(process.env.AS_PORT || '7662');
const RS_PORT = parseInt(process.env.RS_PORT || '7663');
const DB_PATH = process.env.PDPP_DB_PATH || process.env.DB_PATH || ':memory:';
const PDPP_PROVIDER_NAME = process.env.PDPP_PROVIDER_NAME || 'PDPP Reference Provider';
const PDPP_PROVIDER_CONNECT_VERSION = process.env.PDPP_PROVIDER_CONNECT_VERSION || 'draft-2026-04-16';
const PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION = process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION !== '0';
const PDPP_DCR_INITIAL_ACCESS_TOKENS = (process.env.PDPP_DCR_INITIAL_ACCESS_TOKENS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const PDPP_REFERENCE_TRACE_ID_HEADER = 'PDPP-Reference-Trace-Id';

// ─── Helpers ────────────────────────────────────────────────────────────────

function pdppError(res, status, code, message, param = null) {
  const body = { error: { type: typeFor(status), code, message } };
  if (param) body.error.param = param;
  body.error.request_id = ensureRequestId(res);
  res.status(status).json(body);
}

function typeFor(status) {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 410) return 'gone_error';
  if (status === 429) return 'rate_limit_error';
  return 'api_error';
}

const codeToStatus = {
  grant_stream_not_allowed: 403,
  grant_expired: 403,
  grant_revoked: 403,
  grant_consumed: 403,
  grant_invalid: 403,
  field_not_granted: 403,
  insufficient_scope: 403,
  invalid_cursor: 400,
  invalid_request: 400,
  invalid_client: 400,
  invalid_client_metadata: 400,
  connector_invalid: 400,
  invalid_record: 400,
  invalid_record_identity: 400,
  invalid_expand: 400,
  unknown_field: 400,
  unsupported_version: 400,
  authentication_error: 401,
  blob_not_found: 404,
  not_found: 404,
  cursor_expired: 410,
};

function handleError(res, err) {
  const code = err.code || 'api_error';
  const status = codeToStatus[code] || 500;
  if (err.request_id) {
    res.setHeader('Request-Id', err.request_id);
  }
  if (err.trace_id) {
    setReferenceTraceId(res, err.trace_id);
  }
  pdppError(res, status, code, err.message);
}

function oauthError(res, status, code, description) {
  res.status(status).json({
    error: code,
    error_description: description,
  });
}

function ensureRequestId(res) {
  const existing = res.getHeader('Request-Id');
  if (typeof existing === 'string' && existing.trim()) {
    return existing.trim();
  }
  const generated = generateSpineId('req');
  res.setHeader('Request-Id', generated);
  return generated;
}

function setReferenceTraceId(res, traceId) {
  if (traceId) {
    res.setHeader(PDPP_REFERENCE_TRACE_ID_HEADER, traceId);
  }
}

function summarizeClientRegistrationRequest(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    requested_client_name: typeof body.client_name === 'string' ? body.client_name : null,
    requested_token_endpoint_auth_method:
      typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : null,
    requested_redirect_uri_count: Array.isArray(body.redirect_uris) ? body.redirect_uris.length : 0,
    requested_metadata_fields: Object.keys(body).sort(),
  };
}

function normalizeFieldListParam(value) {
  if (value == null) return null;
  const rawValues = Array.isArray(value) ? value : [value];
  const fields = rawValues
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  return fields.length ? fields : null;
}

function validateRequestedQueryFieldParams(requestParams, manifestStream) {
  if (requestParams.fields != null) {
    const normalizedFields = normalizeFieldListParam(requestParams.fields);
    if (!normalizedFields) {
      const err = new Error('fields must be a comma-separated list of field names');
      err.code = 'invalid_request';
      throw err;
    }
    requestParams.fields = normalizedFields;
  }

  const allowedFields = new Set(Object.keys(manifestStream?.schema?.properties || {}));
  if (!allowedFields.size) return;

  if (requestParams.fields) {
    const unknownFields = requestParams.fields.filter((field) => !allowedFields.has(field));
    if (unknownFields.length) {
      const err = new Error(`Unknown field: ${unknownFields.join(', ')}`);
      err.code = 'unknown_field';
      throw err;
    }
  }

  if (requestParams.filter && typeof requestParams.filter === 'object') {
    const unknownFilterFields = Object.keys(requestParams.filter).filter((field) => !allowedFields.has(field));
    if (unknownFilterFields.length) {
      const err = new Error(`Unknown field: ${unknownFilterFields.join(', ')}`);
      err.code = 'unknown_field';
      throw err;
    }
  }
}

function buildQueryActorContext(tokenInfo = {}) {
  return {
    actorType: tokenInfo.pdpp_token_kind === 'owner' ? 'subject' : 'client',
    actorId: tokenInfo.pdpp_token_kind === 'owner' ? tokenInfo.subject_id : tokenInfo.client_id,
    traceId: tokenInfo.trace_id || generateSpineId('trc_qry'),
    scenarioId: tokenInfo.scenario_id || undefined,
  };
}

function inferAuthGateQueryContext(req, tokenInfo = {}) {
  if (req.method !== 'GET') return null;

  const segments = String(req.path || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments[0] !== 'v1' || segments[1] !== 'streams') return null;
  const parsedLimit = typeof req.query?.limit === 'string' ? Number.parseInt(req.query.limit, 10) : null;
  const inferredLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
  const hasChangesSince = typeof req.query?.changes_since === 'string' && req.query.changes_since.length > 0;

  if (segments.length === 2) {
    return { queryShape: 'stream_list', streamId: null };
  }
  if (segments.length === 3) {
    return { queryShape: 'stream_metadata', streamId: segments[2] };
  }
  if (segments.length === 4 && segments[3] === 'records') {
    return {
      queryShape: 'record_list',
      streamId: segments[2],
      requestedRecordId: null,
      hasChangesSince,
      limit: inferredLimit,
    };
  }
  if (segments.length === 5 && segments[3] === 'records') {
    return { queryShape: 'record_detail', streamId: segments[2], requestedRecordId: segments[4] };
  }

  return null;
}

async function emitQueryRejected(context, req, err) {
  if (!context?.queryId) return;
  const code = err.code || 'api_error';
  const status = codeToStatus[code] || 500;
  const data = {
    ...(context.queryData || {}),
    error: {
      code,
      message: err.message,
      http_status: status,
    },
  };
  if (Object.prototype.hasOwnProperty.call(context, 'sourceDescriptor')) {
    data.source = context.sourceDescriptor ?? null;
  }

  await emitSpineEvent({
    event_type: 'query.rejected',
    trace_id: context.traceId,
    scenario_id: context.scenarioId,
    actor_type: context.actorType,
    actor_id: context.actorId,
    subject_type: 'subject',
    subject_id: context.tokenInfo?.subject_id || null,
    object_type: 'query',
    object_id: context.queryId,
    status: 'failed',
    grant_id: context.tokenInfo?.grant_id || null,
    client_id: context.tokenInfo?.client_id || null,
    stream_id: context.streamId || null,
    token_id: req.headers.authorization?.slice(7) || null,
    data,
  });
}

async function emitQueryReceived(context, req) {
  if (!context?.queryId) return;
  if (context.receivedEmitted) return;
  context.receivedEmitted = true;

  const data = {
    ...(context.queryData || {}),
  };
  if (Object.prototype.hasOwnProperty.call(context, 'sourceDescriptor')) {
    data.source = context.sourceDescriptor ?? null;
  }

  await emitSpineEvent({
    event_type: 'query.received',
    trace_id: context.traceId,
    scenario_id: context.scenarioId,
    actor_type: context.actorType,
    actor_id: context.actorId,
    subject_type: 'subject',
    subject_id: context.tokenInfo?.subject_id || null,
    object_type: 'query',
    object_id: context.queryId,
    status: 'started',
    grant_id: context.tokenInfo?.grant_id || null,
    client_id: context.tokenInfo?.client_id || null,
    stream_id: context.streamId || null,
    token_id: req.headers.authorization?.slice(7) || null,
    data,
  });
}

async function rejectQuery(res, req, context, err, param = null) {
  if (context?.traceId) {
    setReferenceTraceId(res, context.traceId);
  }
  await emitQueryRejected(context, req, err);
  const code = err.code || 'api_error';
  const status = codeToStatus[code] || 500;
  return pdppError(res, status, code, err.message, param);
}

function buildStateContext(req, res, { connectorId, grantId = null, traceId = null, scenarioId = null, operation, requestedStreams = null } = {}) {
  const requestId = ensureRequestId(res);
  return {
    requestId,
    actorType: 'subject',
    actorId: req.tokenInfo?.subject_id || null,
    traceId: traceId || generateSpineId('trc_state'),
    scenarioId: scenarioId || undefined,
    grantId,
    connectorId,
    sourceDescriptor: connectorId ? { binding_kind: 'connector', connector_id: connectorId } : null,
    operation,
    requestedStreams,
    requestedEmitted: false,
  };
}

async function emitStateEvent(req, context, eventType, status, data = {}) {
  await emitSpineEvent({
    event_type: eventType,
    trace_id: context.traceId,
    scenario_id: context.scenarioId,
    actor_type: context.actorType,
    actor_id: context.actorId,
    subject_type: 'subject',
    subject_id: req.tokenInfo?.subject_id || null,
    object_type: 'state_request',
    object_id: context.requestId,
    status,
    grant_id: context.grantId || null,
    token_id: req.headers.authorization?.slice(7) || null,
    data: {
      ...(context.sourceDescriptor ? { source: context.sourceDescriptor } : {}),
      state_scope: context.grantId ? 'grant' : 'owner',
      operation: context.operation,
      ...(Array.isArray(context.requestedStreams) ? { requested_streams: context.requestedStreams } : {}),
      ...data,
    },
  });
}

async function emitStateRequested(req, context) {
  if (context.requestedEmitted) return;
  context.requestedEmitted = true;
  await emitStateEvent(req, context, 'state.requested', 'started');
}

async function rejectState(res, req, context, err) {
  if (err.trace_id) {
    context.traceId = err.trace_id;
  }
  if (err.scenario_id) {
    context.scenarioId = err.scenario_id;
  }
  setReferenceTraceId(res, context.traceId);
  await emitStateRequested(req, context);
  const code = err.code || 'api_error';
  const status = codeToStatus[code] || 500;
  await emitStateEvent(req, context, 'state.rejected', 'failed', {
    error: {
      code,
      message: err.message,
      http_status: status,
    },
  });
  return pdppError(res, status, code, err.message);
}

function buildMutationContext(req, res, {
  connectorId,
  operation,
  streamId = null,
  requestedRecordId = null,
  submittedRecordCount = null,
  traceId = null,
  scenarioId = null,
} = {}) {
  const requestId = ensureRequestId(res);
  return {
    requestId,
    actorType: 'subject',
    actorId: req.tokenInfo?.subject_id || null,
    traceId: traceId || generateSpineId('trc_mut'),
    scenarioId: scenarioId || undefined,
    connectorId,
    sourceDescriptor: connectorId ? { binding_kind: 'connector', connector_id: connectorId } : null,
    operation,
    streamId,
    requestedRecordId,
    submittedRecordCount,
    requestedEmitted: false,
  };
}

async function emitMutationEvent(req, context, eventType, status, data = {}) {
  await emitSpineEvent({
    event_type: eventType,
    trace_id: context.traceId,
    scenario_id: context.scenarioId,
    actor_type: context.actorType,
    actor_id: context.actorId,
    subject_type: 'subject',
    subject_id: req.tokenInfo?.subject_id || null,
    object_type: 'mutation_request',
    object_id: context.requestId,
    status,
    stream_id: context.streamId || null,
    token_id: req.headers.authorization?.slice(7) || null,
    data: {
      source: context.sourceDescriptor ?? null,
      operation: context.operation,
      ...(context.requestedRecordId ? { requested_record_id: context.requestedRecordId } : {}),
      ...(typeof context.submittedRecordCount === 'number' ? { submitted_record_count: context.submittedRecordCount } : {}),
      ...data,
    },
  });
}

async function emitMutationRequested(req, context) {
  if (context.requestedEmitted) return;
  context.requestedEmitted = true;
  await emitMutationEvent(req, context, 'mutation.requested', 'started');
}

async function rejectMutation(res, req, context, err) {
  if (err.trace_id) {
    context.traceId = err.trace_id;
  }
  if (err.scenario_id) {
    context.scenarioId = err.scenario_id;
  }
  setReferenceTraceId(res, context.traceId);
  await emitMutationRequested(req, context);
  const code = err.code || 'api_error';
  const status = codeToStatus[code] || 500;
  await emitMutationEvent(req, context, 'mutation.rejected', 'failed', {
    error: {
      code,
      message: err.message,
      http_status: status,
    },
  });
  return pdppError(res, status, code, err.message);
}

function buildTimelineEnvelope(object, idKey, idValue, events) {
  const traceId = events.find((event) => event.trace_id)?.trace_id || null;
  return {
    object,
    [idKey]: idValue,
    trace_id: traceId,
    event_count: events.length,
    data: events,
  };
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

async function requireToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return pdppError(res, 401, 'authentication_error', 'Missing Bearer token');
  }
  const token = auth.slice(7);
  const info = await introspect(token);
  if (!info.active) {
    if (info.trace_id) {
      setReferenceTraceId(res, info.trace_id);
    }
    const authGateQuery = inferAuthGateQueryContext(req, info);
    if (authGateQuery && info.trace_id) {
      const authGateContext = {
        tokenInfo: info,
        queryId: ensureRequestId(res),
        actorType: 'client',
        actorId: info.client_id || null,
        traceId: info.trace_id,
        scenarioId: info.scenario_id || undefined,
        streamId: authGateQuery.streamId,
        queryData: {
          query_shape: authGateQuery.queryShape,
          auth_gate: true,
          ...(authGateQuery.queryShape === 'record_list'
            ? {
                has_changes_since: authGateQuery.hasChangesSince ?? false,
                limit: authGateQuery.limit ?? null,
              }
            : {}),
          ...(authGateQuery.requestedRecordId
            ? { requested_record_id: authGateQuery.requestedRecordId }
            : {}),
        },
      };
      await emitQueryReceived(authGateContext, req);
      await emitQueryRejected(authGateContext, req, {
        code: info.inactive_reason || 'authentication_error',
        message:
          info.inactive_reason === 'grant_revoked'
            ? 'Grant has been revoked'
            : info.inactive_reason === 'grant_expired'
              ? 'Grant has expired'
              : info.inactive_reason === 'grant_invalid'
                ? 'Grant is malformed or no longer valid'
                : 'Invalid or expired token',
      });
    }
    if (info.inactive_reason === 'grant_revoked') {
      return pdppError(res, 403, 'grant_revoked', 'Grant has been revoked');
    }
    if (info.inactive_reason === 'grant_expired') {
      return pdppError(res, 403, 'grant_expired', 'Grant has expired');
    }
    if (info.inactive_reason === 'grant_invalid') {
      return pdppError(res, 403, 'grant_invalid', 'Grant is malformed or no longer valid');
    }
    return pdppError(res, 401, 'authentication_error', 'Invalid or expired token');
  }
  req.tokenInfo = info;
  next();
}

function requireOwner(req, res, next) {
  if (req.tokenInfo.pdpp_token_kind !== 'owner') {
    return pdppError(res, 403, 'permission_error', 'Owner token required');
  }
  next();
}

function requireClient(req, res, next) {
  if (req.tokenInfo.pdpp_token_kind !== 'client') {
    return pdppError(res, 403, 'permission_error', 'Client token required');
  }
  next();
}

function resolveNativeStorageBinding(opts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  const connectorId = nativeManifest?.storage_binding?.connector_id;
  if (!connectorId) return null;
  return { connector_id: connectorId };
}

function resolveSingleConnectorIdQueryValue(rawConnectorId) {
  if (typeof rawConnectorId !== 'string') return null;
  const trimmed = rawConnectorId.trim();
  return trimmed || null;
}

function resolveOwnerReadScope(req, opts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  const nativeStorageBinding = resolveNativeStorageBinding(opts);
  if (nativeManifest && nativeStorageBinding) {
    return {
      public_scope: 'native',
      source: {
        binding_kind: 'provider_native',
        provider_id: nativeManifest.provider_id,
      },
      storage_binding: nativeStorageBinding,
    };
  }

  const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
  if (!connectorId) {
    const err = new Error('connector_id must be a single non-empty string for polyfill owner access');
    err.code = 'invalid_request';
    throw err;
  }

  return {
    public_scope: 'polyfill',
    source: { binding_kind: 'connector', connector_id: connectorId },
    storage_binding: { connector_id: connectorId },
  };
}

function resolveProviderName(opts = {}) {
  return opts.providerName || process.env.PDPP_PROVIDER_NAME || PDPP_PROVIDER_NAME;
}

function resolveNativeManifest(opts = {}) {
  return opts.nativeManifest || null;
}

function validateNativeConfiguration(opts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  if (!nativeManifest) {
    return null;
  }

  if (!nativeManifest.provider_id) {
    throw new Error('Native manifest must include provider_id');
  }
  if (nativeManifest.connector_id) {
    throw new Error('Native manifest must not include connector_id');
  }

  if (!nativeManifest.storage_binding?.connector_id) {
    throw new Error('Native manifest must include storage_binding.connector_id');
  }
  const unsupportedStorageBindingFields = Object.keys(nativeManifest.storage_binding || {}).filter((field) => field !== 'connector_id');
  if (unsupportedStorageBindingFields.length) {
    throw new Error('Native manifest storage_binding must include only connector_id');
  }
  return {
    nativeManifest,
  };
}

function defaultPreRegisteredPublicClients() {
  return [
    { client_id: 'longview', metadata: { client_name: 'Longview', token_endpoint_auth_method: 'none' } },
    { client_id: 'longview_planning_v1', metadata: { client_name: 'Longview', token_endpoint_auth_method: 'none' } },
    { client_id: 'cli_longview', metadata: { client_name: 'Longview CLI', token_endpoint_auth_method: 'none' } },
    { client_id: 'concert_recommendation_app', metadata: { client_name: 'Concert Recommendation App', token_endpoint_auth_method: 'none' } },
  ];
}

function resolveDynamicClientRegistrationEnabled(opts = {}) {
  const requested = opts.enableDynamicClientRegistration ?? PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION;
  const initialAccessTokens = resolveDynamicClientRegistrationInitialAccessTokens(opts);
  return requested && initialAccessTokens.length > 0;
}

function resolveDynamicClientRegistrationInitialAccessTokens(opts = {}) {
  if (Array.isArray(opts.dynamicClientRegistrationInitialAccessTokens)) {
    return opts.dynamicClientRegistrationInitialAccessTokens.filter(Boolean);
  }
  return PDPP_DCR_INITIAL_ACCESS_TOKENS;
}

function resolvePreRegisteredPublicClients(opts = {}) {
  return opts.preRegisteredPublicClients || defaultPreRegisteredPublicClients();
}

function buildSourceDescriptor(sourceBinding = null) {
  if (sourceBinding?.binding_kind === 'provider_native' && sourceBinding.provider_id) {
    return { binding_kind: 'provider_native', provider_id: sourceBinding.provider_id };
  }
  if (sourceBinding?.binding_kind === 'connector' && sourceBinding.connector_id) {
    return { binding_kind: 'connector', connector_id: sourceBinding.connector_id };
  }
  return null;
}

function resolveGrantStorageBinding(tokenInfo) {
  if (tokenInfo?.grant_storage_binding?.connector_id) return tokenInfo.grant_storage_binding;
  return null;
}

function buildOwnerReadGrant(streamName) {
  return {
    streams: [{ name: streamName }],
  };
}

async function resolveOwnerManifestFromScope(ownerScope, opts = {}) {
  const storageBinding = ownerScope.storage_binding || null;
  const manifest = await getManifestForStorageBinding(storageBinding, opts);
  if (!manifest) {
    const err = new Error(
      ownerScope.source.binding_kind === 'provider_native'
        ? `Unknown native provider: ${ownerScope.source.provider_id}`
        : `Unknown connector: ${storageBinding?.connector_id || 'unknown'}`
    );
    err.code = 'not_found';
    throw err;
  }
  return { ownerScope, storageBinding, manifest };
}

async function resolveOwnerManifest(req, opts = {}) {
  const ownerScope = resolveOwnerReadScope(req, opts);
  return resolveOwnerManifestFromScope(ownerScope, opts);
}

async function resolveGrantManifest(tokenInfo, opts = {}) {
  const storageBinding = resolveGrantStorageBinding(tokenInfo);
  const source = buildSourceDescriptor(tokenInfo?.grant?.source);
  const manifest = await getManifestForStorageBinding(storageBinding, opts);
  if (!manifest) {
    const err = source?.binding_kind === 'provider_native'
      ? new Error(`Unknown native provider: ${source.provider_id}`)
      : new Error(`Unknown connector: ${storageBinding?.connector_id || 'unknown'}`);
    err.code = 'not_found';
    throw err;
  }
  requireGrantContractAgainstManifest(tokenInfo?.grant, manifest);
  return { storageBinding, source, manifest };
}

async function resolveRegisteredConnectorManifest(connectorId) {
  const manifest = await getConnectorManifest(connectorId);
  if (!manifest) {
    const err = new Error(`Unknown connector: ${connectorId}`);
    err.code = 'not_found';
    throw err;
  }
  return manifest;
}

function buildGrantInvalidError() {
  const err = new Error('Grant is malformed or no longer valid');
  err.code = 'grant_invalid';
  return err;
}

async function resolveGrantScopedStateGrant(connectorId, grantId) {
  const rows = await getDb().query(sql`
    SELECT grant_json, storage_binding_json, trace_id, scenario_id
    FROM grants
    WHERE grant_id = ${grantId}
  `);
  if (!rows.length) {
    const err = new Error(`Unknown grant: ${grantId}`);
    err.code = 'not_found';
    throw err;
  }

  try {
    const resolved = await requireResolvedPersistedGrantState(rows[0]);
    if (resolved.grant.access_mode !== 'continuous') {
      const err = new Error(`Grant '${grantId}' does not support grant-scoped state because access_mode is ${resolved.grant.access_mode || 'unknown'}`);
      err.code = 'invalid_request';
      err.trace_id = rows[0].trace_id || null;
      err.scenario_id = rows[0].scenario_id || undefined;
      throw err;
    }
    if (resolved.storageBinding.connector_id !== connectorId) {
      const err = new Error(`Grant '${grantId}' is not scoped to connector ${connectorId}`);
      err.code = 'invalid_request';
      err.trace_id = rows[0].trace_id || null;
      err.scenario_id = rows[0].scenario_id || undefined;
      throw err;
    }
    return {
      grantId,
      grant: resolved.grant,
      storageBinding: resolved.storageBinding,
      grantedStreams: new Set(resolved.grant.streams.map((stream) => stream.name)),
      traceId: rows[0].trace_id || null,
      scenarioId: rows[0].scenario_id || undefined,
    };
  } catch (err) {
    if (err?.code === 'invalid_request' || err?.code === 'not_found') {
      err.trace_id = rows[0].trace_id || null;
      err.scenario_id = rows[0].scenario_id || undefined;
      throw err;
    }
    const invalidErr = buildGrantInvalidError();
    invalidErr.trace_id = rows[0].trace_id || null;
    invalidErr.scenario_id = rows[0].scenario_id || undefined;
    throw invalidErr;
  }
}

function normalizePrimaryKey(primaryKey) {
  if (Array.isArray(primaryKey)) return primaryKey;
  if (typeof primaryKey === 'string' && primaryKey.trim()) return [primaryKey];
  return [];
}

// ─── AS App ─────────────────────────────────────────────────────────────────

function buildAsApp(opts = {}) {
  const app = express();
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  const dynamicClientRegistrationEnabled = resolveDynamicClientRegistrationEnabled(opts);
  const dynamicClientRegistrationInitialAccessTokens = resolveDynamicClientRegistrationInitialAccessTokens(opts);
  // State-commit payloads on file-import connectors (claude-code, codex,
  // google_takeout) can carry a per-file-mtime cursor that exceeds the
  // default Express 100kb limit. A previous claude-code run hit 413
  // PayloadTooLargeError mid-commit and partially committed 3 of 4 state
  // streams, silently re-running work on next invocation.
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100mb' }));

  function renderPendingGrantConsentHtml(pending, requestUri) {
    const request = pending.request;
    const client = request.client || {};
    const selection = request.selection || {};
    const sourceBinding = request.source_binding;
    const clientName = client.client_display?.name || client.client_id || 'Client application';
    const connectorId = sourceBinding?.connector_id;
    const providerId = sourceBinding?.provider_id;
    const showConnectorLabel = sourceBinding?.binding_kind !== 'provider_native';
    return `
      <!DOCTYPE html>
      <html>
      <head><title>${providerName} Consent</title><style>
        body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px; }
        .grant-box { border: 1px solid #ccc; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .stream { background: #f5f5f5; padding: 8px 12px; border-radius: 4px; margin: 4px 0; font-family: monospace; }
        button { padding: 10px 24px; font-size: 16px; cursor: pointer; border-radius: 6px; border: none; }
        .approve { background: #2563eb; color: white; }
        .deny { background: #dc2626; color: white; margin-left: 10px; }
        .code { font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #2563eb; }
      </style></head>
      <body>
        <h1>${providerName} Data Access Request</h1>
        <p class="code">${pending.userCode}</p>
        <div class="grant-box">
          <p><strong>App:</strong> ${clientName}</p>
          ${showConnectorLabel && connectorId ? `<p><strong>Connector:</strong> ${connectorId}</p>` : ''}
          ${!showConnectorLabel && providerId ? `<p><strong>Provider:</strong> ${providerId}</p>` : ''}
          <p><strong>Purpose:</strong> ${selection.purpose_description || selection.purpose_code}</p>
          <p><strong>Access Mode:</strong> ${selection.access_mode}</p>
          ${selection.retention ? `<p><strong>Retention:</strong> ${selection.retention.on_expiry} after ${selection.retention.max_duration}</p>` : ''}
          <p><strong>Streams requested:</strong></p>
          ${(selection.streams || []).map(s => `
            <div class="stream">
              ${s.name}
              ${s.time_range ? ` (since ${s.time_range.since || 'any'})` : ''}
              ${s.fields ? ` [fields: ${s.fields.join(', ')}]` : ''}
              ${s.view ? ` [view: ${s.view}]` : ''}
              ${s.necessity === 'optional' ? ' (optional)' : ''}
            </div>
          `).join('')}
        </div>
        <form method="POST" action="/consent/approve">
          <input type="hidden" name="request_uri" value="${requestUri}" />
          <button type="submit" class="approve">Approve</button>
        </form>
        <form method="POST" action="/consent/deny" style="display:inline">
          <input type="hidden" name="request_uri" value="${requestUri}" />
          <button type="submit" class="deny">Deny</button>
        </form>
      </body>
      </html>
    `;
  }

  async function getPendingGrantFromRequestUri(requestUri) {
    const deviceCode = parsePendingConsentRequestUri(requestUri);
    if (!deviceCode) return { deviceCode: null, pending: null };
    const pending = await getPendingConsent(deviceCode);
    return { deviceCode, pending };
  }

  app.use((req, res, next) => {
    res.setHeader('Request-Id', req.get('Request-Id') || generateSpineId('req'));
    next();
  });

  // Primary reference surface: RFC 8414 authorization-server metadata.
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const explicitIssuer = opts.asIssuer || opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null);
    const issuer = resolvePublicUrl(req, explicitIssuer);
    const providerConnectCapabilities = ['owner_self_export', 'cli_device_connect', 'third_party_client_connect'];
    const registrationModesSupported = dynamicClientRegistrationEnabled
      ? ['dynamic', 'pre_registered_public']
      : ['pre_registered_public'];
    res.json(
      buildAuthorizationServerMetadata({
        issuer,
        introspectionEndpoint: `${issuer}/introspect`,
        pushedAuthorizationRequestEndpoint: `${issuer}/oauth/par`,
        registrationEndpoint: dynamicClientRegistrationEnabled ? `${issuer}/oauth/register` : null,
        providerConnectCapabilities,
        registrationModesSupported,
        authorizationDetailsTypesSupported: ['https://pdpp.org/data-access'],
        tokenEndpoint: `${issuer}/oauth/token`,
        tokenEndpointAuthMethodsSupported: ['none'],
        deviceAuthorizationEndpoint: `${issuer}/oauth/device_authorization`,
        grantTypesSupported: ['urn:ietf:params:oauth:grant-type:device_code'],
      })
    );
  });

  app.post('/oauth/register', async (req, res) => {
    const traceContext = createTraceContext();
    const requestSummary = summarizeClientRegistrationRequest(req.body);
    res.setHeader('Request-Id', traceContext.request_id);
    setReferenceTraceId(res, traceContext.trace_id);
    try {
      if (!dynamicClientRegistrationEnabled) {
        const err = new Error('Dynamic client registration is not enabled');
        err.code = 'invalid_request';
        throw err;
      }

      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        const err = new Error('Initial access token required');
        err.code = 'invalid_client';
        throw err;
      }

      const initialAccessToken = auth.slice(7);
      if (!dynamicClientRegistrationInitialAccessTokens.includes(initialAccessToken)) {
        const err = new Error('Invalid initial access token');
        err.code = 'invalid_client';
        throw err;
      }

      const registered = await registerDynamicClient(req.body || {});
      await emitSpineEvent({
        event_type: 'client.registered',
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        request_id: traceContext.request_id,
        actor_type: 'client',
        actor_id: registered.client_id,
        object_type: 'client',
        object_id: registered.client_id,
        status: 'succeeded',
        client_id: registered.client_id,
        data: {
          registration_mode: 'dynamic',
          client_name: registered.client_name || null,
          token_endpoint_auth_method: registered.token_endpoint_auth_method || null,
          redirect_uri_count: Array.isArray(registered.redirect_uris) ? registered.redirect_uris.length : 0,
        },
      });
      res.status(201).json(registered);
    } catch (err) {
      await emitSpineEvent({
        event_type: 'client.register_rejected',
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        request_id: traceContext.request_id,
        actor_type: 'client',
        actor_id: 'dynamic_registration',
        object_type: 'client_registration',
        object_id: traceContext.request_id,
        status: 'rejected',
        data: {
          ...requestSummary,
          error: {
            code: err.code || 'invalid_client_metadata',
            message: err.message,
          },
        },
      });
      const status = err.code === 'invalid_client'
        ? 401
        : (err.code === 'invalid_request' ? 404 : 400);
      oauthError(res, status, err.code || 'invalid_client_metadata', err.message);
    }
  });

  app.post('/oauth/device_authorization', async (req, res) => {
    try {
      const clientId = req.body.client_id;
      if (!clientId) {
        return oauthError(res, 400, 'invalid_request', 'client_id is required');
      }

      const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
      const result = await initiateOwnerDeviceAuthorization(clientId, {
        baseUrl: explicitBaseUrl || `${req.protocol}://${req.get('host')}`,
      });
      const traceContext = result.trace_context || null;
      if (traceContext?.request_id) {
        res.setHeader('Request-Id', traceContext.request_id);
      }
      if (traceContext?.trace_id) {
        setReferenceTraceId(res, traceContext.trace_id);
      }
      const { trace_context: _traceContext, ...publicResult } = result;
      res.status(200).json(publicResult);
    } catch (err) {
      if (err.request_id) {
        res.setHeader('Request-Id', err.request_id);
      }
      if (err.trace_id) {
        setReferenceTraceId(res, err.trace_id);
      }
      oauthError(res, 400, err.code || 'invalid_request', err.message);
    }
  });

  app.post('/oauth/token', async (req, res) => {
    const grantType = req.body.grant_type;
    if (grantType !== 'urn:ietf:params:oauth:grant-type:device_code') {
      return oauthError(res, 400, 'unsupported_grant_type', 'Only device_code grant_type is supported here');
    }

    try {
      const result = await exchangeOwnerDeviceCode({
        clientId: req.body.client_id,
        deviceCode: req.body.device_code,
      });
      const traceContext = result.trace_context || null;
      if (traceContext?.request_id) {
        res.setHeader('Request-Id', traceContext.request_id);
      }
      if (traceContext?.trace_id) {
        setReferenceTraceId(res, traceContext.trace_id);
      }
      const { trace_context: _traceContext, ...publicResult } = result;
      res.status(200).json(publicResult);
    } catch (err) {
      const status = ['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant', 'invalid_client'].includes(err.code)
        ? 400
        : 500;
      if (err.request_id) {
        res.setHeader('Request-Id', err.request_id);
      }
      if (err.trace_id) {
        setReferenceTraceId(res, err.trace_id);
      }
      oauthError(res, status, err.code || 'server_error', err.message);
    }
  });

  app.get('/device', async (req, res) => {
    const userCode = typeof req.query.user_code === 'string' ? req.query.user_code : '';
    const pending = userCode ? await getOwnerDeviceAuthorizationByUserCode(userCode) : null;

    if (!userCode || !pending) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>${providerName} Device Verification</title><style>
          body { font-family: system-ui; max-width: 560px; margin: 40px auto; padding: 20px; }
          form { display: flex; gap: 12px; align-items: end; }
          input, button { padding: 10px 12px; font-size: 16px; }
          button { cursor: pointer; }
        </style></head>
        <body>
          <h1>Enter verification code</h1>
          <p>Paste the code shown by the CLI to continue the owner sign-in flow.</p>
          <form method="GET" action="/device">
            <label>User code<br /><input name="user_code" value="${userCode || ''}" autofocus /></label>
            <button type="submit">Continue</button>
          </form>
        </body>
        </html>
      `);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Approve ${providerName} CLI Access</title><style>
        body { font-family: system-ui; max-width: 620px; margin: 40px auto; padding: 20px; }
        .box { border: 1px solid #d4d4d8; border-radius: 12px; padding: 20px; margin: 20px 0; }
        .code { font-size: 28px; letter-spacing: 4px; font-weight: 700; color: #1d4ed8; }
        input, button { padding: 10px 12px; font-size: 16px; }
        button { cursor: pointer; background: #1d4ed8; color: white; border: none; border-radius: 8px; }
      </style></head>
      <body>
        <h1>Approve owner access to ${providerName}</h1>
        <div class="box">
          <p><strong>Client:</strong> ${pending.client_id}</p>
          <p><strong>User code:</strong> <span class="code">${pending.user_code}</span></p>
          <p><strong>Expires:</strong> ${pending.expires_at}</p>
        </div>
        <form method="POST" action="/device/approve">
          <input type="hidden" name="user_code" value="${pending.user_code}" />
          <label>Subject ID<br /><input name="subject_id" value="owner_local" /></label>
          <div style="margin-top: 16px;">
            <button type="submit">Approve and issue owner token</button>
            <button class="deny" type="submit" formaction="/device/deny">Deny</button>
          </div>
        </form>
      </body>
      </html>
    `);
  });

  app.post('/device/approve', async (req, res) => {
    try {
      const userCode = req.body.user_code;
      const subjectId = req.body.subject_id || 'owner_local';
      if (!userCode) {
        return oauthError(res, 400, 'invalid_request', 'user_code is required');
      }

      await approveOwnerDeviceAuthorization(userCode, subjectId);
      res.send(`
        <!DOCTYPE html>
        <html><body style="font-family: system-ui; max-width: 560px; margin: 40px auto; padding: 20px;">
          <h1>Approved</h1>
          <p>The CLI can return to polling and complete sign-in now.</p>
        </body></html>
      `);
    } catch (err) {
      if (err.request_id) {
        res.setHeader('Request-Id', err.request_id);
      }
      if (err.trace_id) {
        setReferenceTraceId(res, err.trace_id);
      }
      oauthError(res, 400, err.code || 'invalid_request', err.message);
    }
  });

  app.post('/device/deny', async (req, res) => {
    try {
      const userCode = req.body.user_code;
      const subjectId = req.body.subject_id || 'owner_local';
      if (!userCode) {
        return oauthError(res, 400, 'invalid_request', 'user_code is required');
      }

      await denyOwnerDeviceAuthorization(userCode, subjectId);
      res.send(`
        <!DOCTYPE html>
        <html><body style="font-family: system-ui; max-width: 560px; margin: 40px auto; padding: 20px;">
          <h1>Denied</h1>
          <p>The CLI will stop polling and report that access was denied.</p>
        </body></html>
      `);
    } catch (err) {
      if (err.request_id) {
        res.setHeader('Request-Id', err.request_id);
      }
      if (err.trace_id) {
        setReferenceTraceId(res, err.trace_id);
      }
      oauthError(res, 400, err.code || 'invalid_request', err.message);
    }
  });

  // RFC 7662-style token introspection with PDPP extensions
  app.post('/introspect', async (req, res) => {
    const token = req.body.token;
    if (!token) return pdppError(res, 400, 'invalid_request', 'Missing token parameter');
    const info = await introspect(token);
    const publicInfo = { ...info };
    delete publicInfo.grant_storage_binding;
    res.json(publicInfo);
  });

  // Reference-only event spine inspection surfaces for CLI/tests/future console.
  function parseListFilters(query) {
    return {
      limit: query.limit,
      cursor: query.cursor,
      since: query.since,
      until: query.until,
      status: query.status,
      clientId: query.client_id,
      providerId: query.provider_id,
      connectorId: query.connector_id,
      grantId: query.grant_id,
      q: query.q,
    };
  }

  function summaryToTrace(s) {
    return {
      object: 'trace_summary',
      trace_id: s.id,
      first_at: s.first_at,
      last_at: s.last_at,
      event_count: s.event_count,
      status: s.status,
      kinds: s.kinds,
      request_id: s.request_id,
      grant_id: s.grant_id,
      run_id: s.run_id,
      client_id: s.client_id,
      provider_id: s.provider_id,
      actor_type: s.actor_type,
      actor_id: s.actor_id,
      failure: s.failure,
    };
  }

  function summaryToGrant(s) {
    return {
      object: 'grant_summary',
      grant_id: s.id,
      first_at: s.first_at,
      last_at: s.last_at,
      event_count: s.event_count,
      status: s.status,
      kinds: s.kinds,
      client_id: s.client_id,
      provider_id: s.provider_id,
      connector_id: s.connector_id || null,
      failure: s.failure,
    };
  }

  function summaryToRun(s) {
    return {
      object: 'run_summary',
      run_id: s.id,
      first_at: s.first_at,
      last_at: s.last_at,
      event_count: s.event_count,
      status: s.status,
      kinds: s.kinds,
      connector_id: s.connector_id || null,
      provider_id: s.provider_id,
      grant_id: s.grant_id,
      failure_reason: s.failure?.reason || null,
    };
  }

  app.get('/_ref/traces', async (req, res) => {
    try {
      const { summaries, hasMore, nextCursor } = await listSpineCorrelations('trace', parseListFilters(req.query));
      const body = {
        object: 'list',
        data: summaries.map(summaryToTrace),
        has_more: hasMore,
      };
      if (nextCursor) body.next_cursor = nextCursor;
      res.json(body);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/grants', async (req, res) => {
    try {
      const { summaries, hasMore, nextCursor } = await listSpineCorrelations('grant', parseListFilters(req.query));
      const body = {
        object: 'list',
        data: summaries.map(summaryToGrant),
        has_more: hasMore,
      };
      if (nextCursor) body.next_cursor = nextCursor;
      res.json(body);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/runs', async (req, res) => {
    try {
      const { summaries, hasMore, nextCursor } = await listSpineCorrelations('run', parseListFilters(req.query));
      const body = {
        object: 'list',
        data: summaries.map(summaryToRun),
        has_more: hasMore,
      };
      if (nextCursor) body.next_cursor = nextCursor;
      res.json(body);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/search', async (req, res) => {
    try {
      const result = await searchSpine(req.query.q || '');
      res.json({
        object: 'search_result',
        exact: result.exact,
        traces: result.traces.map(summaryToTrace),
        grants: result.grants.map(summaryToGrant),
        runs: result.runs.map(summaryToRun),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/traces/:traceId', async (req, res) => {
    try {
      const traceId = decodeURIComponent(req.params.traceId);
      const events = await listSpineEvents({ traceId });
      if (!events.length) return pdppError(res, 404, 'not_found', 'Trace not found');
      res.json(buildTimelineEnvelope('trace', 'trace_id', traceId, events));
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/grants/:grantId/timeline', async (req, res) => {
    try {
      const grantId = decodeURIComponent(req.params.grantId);
      const events = await listSpineEvents({ grantId });
      if (!events.length) return pdppError(res, 404, 'not_found', 'Grant timeline not found');
      res.json(buildTimelineEnvelope('grant_timeline', 'grant_id', grantId, events));
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/runs/:runId/timeline', async (req, res) => {
    try {
      const runId = decodeURIComponent(req.params.runId);
      const events = await listSpineEvents({ runId });
      if (!events.length) return pdppError(res, 404, 'not_found', 'Run timeline not found');
      res.json(buildTimelineEnvelope('run_timeline', 'run_id', runId, events));
    } catch (err) {
      handleError(res, err);
    }
  });

  if (!nativeMode) {
    // Polyfill-only connector registry surface for the reference personal-server world.
    app.post('/connectors', async (req, res) => {
      try {
        const manifest = req.body;
        if (!manifest.connector_id) return pdppError(res, 400, 'invalid_request', 'Missing connector_id');
        await registerConnector(manifest);
        res.status(201).json({ connector_id: manifest.connector_id });
      } catch (err) {
        handleError(res, err);
      }
    });

    // Polyfill-only connector registry surface for the reference personal-server world.
    app.get('/connectors/:connectorId', async (req, res) => {
      try {
        const manifest = await getConnectorManifest(decodeURIComponent(req.params.connectorId));
        if (!manifest) return pdppError(res, 404, 'not_found', 'Connector not found');
        res.json(manifest);
      } catch (err) {
        handleError(res, err);
      }
    });
  }

  // Primary provider-connect request front door: RFC 9126-style request staging.
  // The persisted pending-consent substrate remains the same; only the public start surface changes.
  app.post('/oauth/par', async (req, res) => {
    try {
      const result = await initiateGrant(req.body, {
        baseUrl: process.env.AS_PUBLIC_URL || `${req.protocol}://${req.get('host')}`,
        nativeManifest: resolveNativeManifest(opts),
      });
      const traceContext = result.trace_context || null;
      if (traceContext?.request_id) {
        res.setHeader('Request-Id', traceContext.request_id);
      }
      if (traceContext?.trace_id) {
        setReferenceTraceId(res, traceContext.trace_id);
      }
      const { trace_context: _traceContext, ...publicResult } = result;
      res.status(201).json({
        request_uri: publicResult.request_uri,
        authorization_url: publicResult.authorization_url,
        expires_in: publicResult.expires_in,
      });
    } catch (err) {
      handleError(res, err);
    }
  });


  // Primary consent shell for the current provider-connect request/approval profile.
  app.get('/consent', async (req, res) => {
    try {
      const requestUri = typeof req.query.request_uri === 'string' ? req.query.request_uri : null;
      if (!requestUri) return pdppError(res, 400, 'invalid_request', 'request_uri is required');
      const { pending } = await getPendingGrantFromRequestUri(requestUri);
      if (!pending) return res.status(404).send('Not found');
      res.send(renderPendingGrantConsentHtml(pending, requestUri));
    } catch (err) {
      handleError(res, err);
    }
  });


  // Primary approval surface for the current provider-connect request/approval profile.
  app.post('/consent/approve', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const requestUri = req.body?.request_uri || req.query?.request_uri;
      const { deviceCode, pending } = await getPendingGrantFromRequestUri(requestUri);
      if (!deviceCode) return pdppError(res, 400, 'invalid_request', 'request_uri is required');
      const traceContext = pending?.request?.trace_context || null;
      if (traceContext?.request_id) {
        res.setHeader('Request-Id', traceContext.request_id);
      }
      if (traceContext?.trace_id) {
        setReferenceTraceId(res, traceContext.trace_id);
      }
      const subjectId = req.body?.subject_id || req.query?.subject_id || 'owner_local';
      const approveOpts = { ai_training_consented: req.body?.ai_training_consented };
      const { grant, token } = await approveGrant(deviceCode, subjectId, approveOpts);
      const wantsJson = req.is('application/json') || req.accepts(['html', 'json']) === 'json';
      if (wantsJson) {
        return res.json({ grant_id: grant.grant_id, token, grant });
      }
      res.send(`
        <html><body>
        <h2>✓ Access Approved</h2>
        <p>Grant ID: <code>${grant.grant_id}</code></p>
        <p>Token (copy to use with RS): <code>${token}</code></p>
        </body></html>
      `);
    } catch (err) {
      handleError(res, err);
    }
  });


  app.post('/consent/deny', async (req, res) => {
    try {
      const requestUri = req.body?.request_uri || req.query?.request_uri;
      const { deviceCode, pending } = await getPendingGrantFromRequestUri(requestUri);
      if (!deviceCode) return pdppError(res, 400, 'invalid_request', 'request_uri is required');
      const traceContext = pending?.request?.trace_context || null;
      if (traceContext?.request_id) {
        res.setHeader('Request-Id', traceContext.request_id);
      }
      if (traceContext?.trace_id) {
        setReferenceTraceId(res, traceContext.trace_id);
      }
      const deleted = await denyGrant(deviceCode);
      if (!deleted) return pdppError(res, 404, 'not_found', 'Pending consent request not found');
      res.send(`
        <html><body>
        <h2>Access Denied</h2>
        <p>The pending data access request was rejected and cleared.</p>
        </body></html>
      `);
    } catch (err) {
      handleError(res, err);
    }
  });



  // Primary reference surface.
  app.post('/grants/:grantId/revoke', async (req, res) => {
    try {
      const requestId = ensureRequestId(res);
      const result = await revokeGrant(req.params.grantId, { request_id: requestId });
      if (result?.trace_id) {
        setReferenceTraceId(res, result.trace_id);
      }
      res.json({ revoked: true });
    } catch (err) {
      handleError(res, err);
    }
  });
  return app;
}

// ─── RS App ─────────────────────────────────────────────────────────────────

function buildRsApp(opts = {}) {
  const app = express();
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  // Match AS limit so ingest batches (especially IMAP with full email bodies
  // and file-import connectors with large state cursors) don't 413.
  app.use(express.json({ limit: '100mb' }));

  app.use((req, res, next) => {
    res.setHeader('Request-Id', req.get('Request-Id') || generateSpineId('req'));
    // PDPP-Version negotiation
    const requestedVersion = req.headers['pdpp-version'];
    const CURRENT_VERSION = '2026-04-06';
    if (requestedVersion && requestedVersion !== CURRENT_VERSION) {
      return pdppError(res, 400, 'unsupported_version',
        `PDPP-Version '${requestedVersion}' is not supported. Current: ${CURRENT_VERSION}`);
    }
    res.setHeader('PDPP-Version', CURRENT_VERSION);
    next();
  });

  // Primary reference surface: RFC 9728 protected-resource metadata.
  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const explicitResource = opts.rsPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.RS_PUBLIC_URL : null);
    const resource = resolvePublicUrl(req, explicitResource);
    const explicitIssuer = opts.asIssuer || opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null);
    const fallbackIssuer = `${req.protocol}://${req.hostname}:${opts.asPort || AS_PORT}`;
    const issuer = stripTrailingSlash(explicitIssuer || fallbackIssuer);
    res.json(
      buildProtectedResourceMetadata({
        resource,
        resourceName: `${providerName} Resource Server`,
        authorizationServers: [issuer],
        queryBase: `${resource}/v1`,
        providerConnectVersion: PDPP_PROVIDER_CONNECT_VERSION,
        selfExportSupported: true,
        tokenKindsSupported: ['owner', 'client'],
      })
    );
  });

  // GET /v1/streams — list streams (client or owner)
  app.get('/v1/streams', requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);

      let sourceDescriptor;
      let streamSummaries = [];
      let manifest = null;
      queryContext = {
        tokenInfo,
        queryId,
        actorType,
        actorId,
        traceId,
        scenarioId,
        sourceDescriptor: null,
        queryData: { query_shape: 'stream_list' },
      };
      if (tokenInfo.pdpp_token_kind === 'owner') {
        const ownerScope = resolveOwnerReadScope(req, opts);
        sourceDescriptor = buildSourceDescriptor(ownerScope.source);
        queryContext.sourceDescriptor = sourceDescriptor;

        await resolveOwnerManifest(req, opts);
        streamSummaries = await listAllStreams(ownerScope.storage_binding);
      } else {
        const grant = tokenInfo.grant;
        sourceDescriptor = buildSourceDescriptor(grant?.source);
        queryContext.sourceDescriptor = sourceDescriptor;
        queryContext.queryData.stream_count_limit = Array.isArray(grant?.streams) ? grant.streams.length : null;

        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        const { storageBinding } = grantResolved;
        manifest = grantResolved.manifest;
        streamSummaries = await listStreams(storageBinding, grant, manifest);
      }

      await emitQueryReceived(queryContext, req);

      await emitSpineEvent({
        event_type: 'disclosure.served',
        trace_id: traceId,
        scenario_id: scenarioId,
        actor_type: actorType,
        actor_id: actorId,
        subject_type: 'subject',
        subject_id: tokenInfo.subject_id || null,
        object_type: 'query',
        object_id: queryId,
        status: 'succeeded',
        grant_id: tokenInfo.grant_id || null,
        client_id: tokenInfo.client_id || null,
        token_id: req.headers.authorization?.slice(7) || null,
        data: {
          source: sourceDescriptor,
          query_shape: 'stream_list',
          stream_count: streamSummaries.length,
        },
      });

      res.json({ object: 'list', data: streamSummaries });
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream — stream metadata
  app.get('/v1/streams/:stream', requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);

      let manifest;
      let sourceDescriptor = tokenInfo.pdpp_token_kind === 'owner'
        ? null
        : buildSourceDescriptor(tokenInfo.grant?.source);

      queryContext = {
        tokenInfo,
        queryId,
        actorType,
        actorId,
        traceId,
        scenarioId,
        sourceDescriptor,
        streamId: req.params.stream,
        queryData: { query_shape: 'stream_metadata' },
      };

      if (tokenInfo.pdpp_token_kind === 'owner') {
        const ownerScope = resolveOwnerReadScope(req, opts);
        sourceDescriptor = buildSourceDescriptor(ownerScope.source);
        queryContext.sourceDescriptor = sourceDescriptor;
        const ownerResolved = await resolveOwnerManifestFromScope(ownerScope, opts);
        manifest = ownerResolved.manifest;
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        manifest = grantResolved.manifest;
        sourceDescriptor = grantResolved.source;
        queryContext.sourceDescriptor = sourceDescriptor;
      }

      await emitQueryReceived(queryContext, req);

      const mStream = manifest?.streams?.find(s => s.name === req.params.stream);
      if (!mStream) {
        const err = new Error(`Stream '${req.params.stream}' not found`);
        err.code = 'not_found';
        return await rejectQuery(res, req, queryContext, err);
      }
      if (tokenInfo.pdpp_token_kind === 'client') {
        const streamGrant = tokenInfo.grant?.streams?.find((stream) => stream.name === req.params.stream);
        if (!streamGrant) {
          const err = new Error(`Stream '${req.params.stream}' not in grant`);
          err.code = 'grant_stream_not_allowed';
          return await rejectQuery(res, req, queryContext, err);
        }
      }

      const metadataBody = {
        object: 'stream_metadata',
        name: mStream.name,
        semantics: mStream.semantics,
        schema: mStream.schema,
        primary_key: normalizePrimaryKey(mStream.primary_key),
        cursor_field: mStream.cursor_field,
        consent_time_field: mStream.consent_time_field,
        selection: mStream.selection,
        views: mStream.views || [],
        relationships: mStream.relationships || [],
      };

      await emitSpineEvent({
        event_type: 'disclosure.served',
        trace_id: traceId,
        scenario_id: scenarioId,
        actor_type: actorType,
        actor_id: actorId,
        subject_type: 'subject',
        subject_id: tokenInfo.subject_id || null,
        object_type: 'query',
        object_id: queryId,
        status: 'succeeded',
        grant_id: tokenInfo.grant_id || null,
        client_id: tokenInfo.client_id || null,
        stream_id: req.params.stream,
        token_id: req.headers.authorization?.slice(7) || null,
        data: {
          source: sourceDescriptor,
          query_shape: 'stream_metadata',
          view_count: metadataBody.views.length,
          relationship_count: metadataBody.relationships.length,
        },
      });

      res.json(metadataBody);
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream/records
  app.get('/v1/streams/:stream/records', requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);

      let grant = tokenInfo.grant;
      let sourceDescriptor = tokenInfo.pdpp_token_kind === 'owner'
        ? null
        : buildSourceDescriptor(grant?.source);
      let storageBinding = null;
      let manifest;
      const requestParams = { ...req.query };
      const queryEventData = {
        query_shape: 'record_list',
        has_changes_since: !!requestParams.changes_since,
        limit: requestParams.limit ? Number(requestParams.limit) : null,
        ...(typeof req.query.view === 'string' && req.query.view.trim()
          ? { requested_view: req.query.view.trim() }
          : {}),
      };
      queryContext = {
        tokenInfo,
        queryId,
        actorType,
        actorId,
        traceId,
        scenarioId,
        sourceDescriptor,
        streamId: req.params.stream,
        queryData: { ...queryEventData },
      };

      if (tokenInfo.pdpp_token_kind === 'owner') {
        // Self-export: owner can query without a client grant.
        const ownerScope = resolveOwnerReadScope(req, opts);
        sourceDescriptor = buildSourceDescriptor(ownerScope.source);
        queryContext.sourceDescriptor = sourceDescriptor;
        const ownerResolved = await resolveOwnerManifestFromScope(ownerScope, opts);
        storageBinding = ownerResolved.storageBinding;
        manifest = ownerResolved.manifest;
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        storageBinding = grantResolved.storageBinding;
        sourceDescriptor = grantResolved.source;
        manifest = grantResolved.manifest;
        queryContext.sourceDescriptor = sourceDescriptor;
      }

      await emitQueryReceived(queryContext, req);

      if (tokenInfo.pdpp_token_kind === 'owner') {
        const mStream = manifest.streams.find((stream) => stream.name === req.params.stream);
        if (!mStream) {
          const err = new Error(`Stream '${req.params.stream}' not found`);
          err.code = 'not_found';
          return await rejectQuery(res, req, queryContext, err);
        }
        grant = buildOwnerReadGrant(req.params.stream);
      }

      // View and fields mutual exclusion
      if (req.query.view && req.query.fields) {
        const err = new Error('view and fields are mutually exclusive');
        err.code = 'invalid_request';
        return await rejectQuery(res, req, queryContext, err);
      }

      const mStream = manifest?.streams?.find(s => s.name === req.params.stream);
      validateRequestedQueryFieldParams(requestParams, mStream);

      if (req.query.view && !requestParams.fields) {
        const viewDef = (mStream?.views || []).find(v => v.id === req.query.view);
        if (!viewDef) {
          const err = new Error(`Unknown view: ${req.query.view}`);
          err.code = 'invalid_request';
          return await rejectQuery(res, req, queryContext, err);
        }
        // Check view is within grant fields
        const streamGrant = grant.streams.find(s => s.name === req.params.stream);
        if (streamGrant?.fields) {
          const unauthorized = viewDef.fields.filter(f => !streamGrant.fields.includes(f));
          if (unauthorized.length) {
            const err = new Error(`View includes fields not in grant: ${unauthorized.join(', ')}`);
            err.code = 'field_not_granted';
            return await rejectQuery(res, req, queryContext, err);
          }
        }
        requestParams.fields = viewDef.fields;
        delete requestParams.view;
      }

      const result = await queryRecords(storageBinding, req.params.stream, grant, requestParams, manifest);

      const disclosureEventData = {
        source: sourceDescriptor,
        query_shape: 'record_list',
        record_count: result.data?.length || 0,
        has_more: !!result.has_more,
        has_next_changes_since: !!result.next_changes_since,
      };

      await emitSpineEvent({
        event_type: 'disclosure.served',
        trace_id: traceId,
        scenario_id: scenarioId,
        actor_type: actorType,
        actor_id: actorId,
        subject_type: 'subject',
        subject_id: tokenInfo.subject_id || null,
        object_type: 'query',
        object_id: queryId,
        status: 'succeeded',
        grant_id: tokenInfo.grant_id || null,
        client_id: tokenInfo.client_id || null,
        stream_id: req.params.stream,
        token_id: req.headers.authorization?.slice(7) || null,
        data: disclosureEventData,
      });

      res.json({ ...result, url: req.path });
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream/records/:id
  app.get('/v1/streams/:stream/records/:id', requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);
      let grant = tokenInfo.grant;
      let storageBinding = null;
      let sourceDescriptor = tokenInfo.pdpp_token_kind === 'owner'
        ? null
        : buildSourceDescriptor(grant?.source);
      let manifest;
      const requestedRecordId = decodeURIComponent(req.params.id);
      queryContext = {
        tokenInfo,
        queryId,
        actorType,
        actorId,
        traceId,
        scenarioId,
        sourceDescriptor,
        streamId: req.params.stream,
        queryData: {
          query_shape: 'record_detail',
          requested_record_id: requestedRecordId,
          has_changes_since: false,
          limit: null,
        },
      };

      if (tokenInfo.pdpp_token_kind === 'owner') {
        const ownerScope = resolveOwnerReadScope(req, opts);
        queryContext.sourceDescriptor = buildSourceDescriptor(ownerScope.source);
        const ownerResolved = await resolveOwnerManifestFromScope(ownerScope, opts);
        storageBinding = ownerResolved.storageBinding;
        manifest = ownerResolved.manifest;
        grant = buildOwnerReadGrant(req.params.stream);
        sourceDescriptor = buildSourceDescriptor(ownerScope.source);
        queryContext.sourceDescriptor = sourceDescriptor;
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        storageBinding = grantResolved.storageBinding;
        manifest = grantResolved.manifest;
        sourceDescriptor = grantResolved.source;
        queryContext.sourceDescriptor = sourceDescriptor;
      }
      await emitQueryReceived(queryContext, req);
      const record = await getRecord(storageBinding, req.params.stream,
        requestedRecordId, grant, manifest);
      await emitSpineEvent({
        event_type: 'disclosure.served',
        trace_id: traceId,
        scenario_id: scenarioId,
        actor_type: actorType,
        actor_id: actorId,
        subject_type: 'subject',
        subject_id: tokenInfo.subject_id || null,
        object_type: 'query',
        object_id: queryId,
        status: 'succeeded',
        grant_id: tokenInfo.grant_id || null,
        client_id: tokenInfo.client_id || null,
        stream_id: req.params.stream,
        token_id: req.headers.authorization?.slice(7) || null,
        data: {
          source: sourceDescriptor,
          query_shape: 'record_detail',
          record_count: record ? 1 : 0,
          has_more: false,
          has_next_changes_since: false,
          requested_record_id: requestedRecordId,
        },
      });
      res.json(record);
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  if (!nativeMode) {
    // DELETE /v1/streams/:stream/records (owner-authenticated reference reset for polyfill mode)
    app.delete('/v1/streams/:stream/records', requireToken, requireOwner, async (req, res) => {
      const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
      const mutationContext = buildMutationContext(req, res, {
        connectorId,
        operation: 'delete_stream_records',
        streamId: req.params.stream,
      });
      try {
        if (!connectorId) {
          const err = new Error('connector_id must be a single non-empty string');
          err.code = 'invalid_request';
          return await rejectMutation(res, req, mutationContext, err);
        }
        setReferenceTraceId(res, mutationContext.traceId);
        await emitMutationRequested(req, mutationContext);
        const manifest = await resolveRegisteredConnectorManifest(connectorId);
        const manifestStream = (manifest.streams || []).find((stream) => stream.name === req.params.stream);
        if (!manifestStream) {
          const err = new Error(`Stream '${req.params.stream}' not found for connector ${connectorId}`);
          err.code = 'not_found';
          return await rejectMutation(res, req, mutationContext, err);
        }
        const deletedRecordCount = await deleteAllRecords(connectorId, req.params.stream);
        await emitMutationEvent(req, mutationContext, 'mutation.completed', 'succeeded', {
          deleted_record_count: deletedRecordCount,
        });
        res.status(204).end();
      } catch (err) {
        return await rejectMutation(res, req, mutationContext, err);
      }
    });

    // DELETE /v1/streams/:stream/records/:id (owner-authenticated)
    app.delete('/v1/streams/:stream/records/:id', requireToken, requireOwner, async (req, res) => {
      const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
      const requestedRecordId = decodeURIComponent(req.params.id);
      const mutationContext = buildMutationContext(req, res, {
        connectorId,
        operation: 'delete_record',
        streamId: req.params.stream,
        requestedRecordId,
      });
      try {
        if (!connectorId) {
          const err = new Error('connector_id must be a single non-empty string');
          err.code = 'invalid_request';
          return await rejectMutation(res, req, mutationContext, err);
        }
        setReferenceTraceId(res, mutationContext.traceId);
        await emitMutationRequested(req, mutationContext);
        const manifest = await resolveRegisteredConnectorManifest(connectorId);
        const manifestStream = (manifest.streams || []).find((stream) => stream.name === req.params.stream);
        if (!manifestStream) {
          const err = new Error(`Stream '${req.params.stream}' not found for connector ${connectorId}`);
          err.code = 'not_found';
          return await rejectMutation(res, req, mutationContext, err);
        }
        const deletedRecordCount = await deleteRecord(connectorId, req.params.stream, requestedRecordId);
        await emitMutationEvent(req, mutationContext, 'mutation.completed', 'succeeded', {
          deleted_record_count: deletedRecordCount,
        });
        res.status(204).end();
      } catch (err) {
        return await rejectMutation(res, req, mutationContext, err);
      }
    });

    // POST /v1/ingest/:stream (Collection Profile, owner-authenticated)
    app.post('/v1/ingest/:stream', requireToken, requireOwner, express.text({ type: 'application/x-ndjson', limit: '200mb' }), async (req, res) => {
      const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
      const lines = (req.body || '').split('\n').filter((line) => line.trim());
      const mutationContext = buildMutationContext(req, res, {
        connectorId,
        operation: 'ingest_records',
        streamId: req.params.stream,
        submittedRecordCount: lines.length,
      });
      try {
        if (!connectorId) {
          const err = new Error('connector_id must be a single non-empty string');
          err.code = 'invalid_request';
          return await rejectMutation(res, req, mutationContext, err);
        }
        setReferenceTraceId(res, mutationContext.traceId);
        await emitMutationRequested(req, mutationContext);
        const manifest = await resolveRegisteredConnectorManifest(connectorId);
        const manifestStream = (manifest.streams || []).find((stream) => stream.name === req.params.stream);
        if (!manifestStream) {
          const err = new Error(`Stream '${req.params.stream}' not found for connector ${connectorId}`);
          err.code = 'not_found';
          return await rejectMutation(res, req, mutationContext, err);
        }
        let accepted = 0, rejected = 0;
        const errors = [];

        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            await ingestRecord(connectorId, { ...record, stream: req.params.stream });
            accepted++;
          } catch (e) {
            rejected++;
            errors.push(e.message);
          }
        }

        await emitMutationEvent(req, mutationContext, 'mutation.completed', 'succeeded', {
          records_accepted: accepted,
          records_rejected: rejected,
          error_count: errors.length,
        });
        res.json({ stream: req.params.stream, records_accepted: accepted, records_rejected: rejected, errors });
      } catch (err) {
        return await rejectMutation(res, req, mutationContext, err);
      }
    });

    // GET /v1/state/:connectorId (Collection Profile, owner-authenticated)
    app.get('/v1/state/:connectorId', requireToken, requireOwner, async (req, res) => {
      const connectorId = decodeURIComponent(req.params.connectorId);
      const grantId = typeof req.query.grant_id === 'string' ? req.query.grant_id : null;
      const stateContext = buildStateContext(req, res, {
        connectorId,
        grantId,
        operation: 'read',
      });
      try {
        await resolveRegisteredConnectorManifest(connectorId);
        const grantScope = grantId ? await resolveGrantScopedStateGrant(connectorId, grantId) : null;
        if (grantScope?.traceId) {
          stateContext.traceId = grantScope.traceId;
          stateContext.scenarioId = grantScope.scenarioId;
        }
        setReferenceTraceId(res, stateContext.traceId);
        await emitStateRequested(req, stateContext);
        const state = await getSyncState(connectorId, {
          grantId,
          allowedStreams: grantScope?.grantedStreams || null,
        });
        await emitStateEvent(req, stateContext, 'state.served', 'succeeded', {
          visible_streams: Object.keys(state?.state || {}),
          updated_at: state?.updated_at || null,
        });
        res.json(state);
      } catch (err) {
        return await rejectState(res, req, stateContext, err);
      }
    });

    // PUT /v1/state/:connectorId (Collection Profile, owner-authenticated)
    app.put('/v1/state/:connectorId', requireToken, requireOwner, async (req, res) => {
      const connectorId = decodeURIComponent(req.params.connectorId);
      const grantId = typeof req.query.grant_id === 'string' ? req.query.grant_id : null;
      const requestedStreams = (
        req.body?.state
        && typeof req.body.state === 'object'
        && !Array.isArray(req.body.state)
      ) ? Object.keys(req.body.state) : [];
      const stateContext = buildStateContext(req, res, {
        connectorId,
        grantId,
        operation: 'write',
        requestedStreams,
      });
      try {
        const manifest = await resolveRegisteredConnectorManifest(connectorId);
        const grantScope = grantId ? await resolveGrantScopedStateGrant(connectorId, grantId) : null;
        if (grantScope?.traceId) {
          stateContext.traceId = grantScope.traceId;
          stateContext.scenarioId = grantScope.scenarioId;
        }
        setReferenceTraceId(res, stateContext.traceId);
        await emitStateRequested(req, stateContext);
        const stateMap = req.body.state || {};
        const manifestStreams = new Set((manifest.streams || []).map((stream) => stream.name));
        for (const stream of Object.keys(stateMap)) {
          if (!manifestStreams.has(stream)) {
            const err = new Error(`Stream '${stream}' not found for connector ${connectorId}`);
            err.code = 'not_found';
            return await rejectState(res, req, stateContext, err);
          }
          if (grantScope && !grantScope.grantedStreams.has(stream)) {
            const err = new Error(`Grant '${grantId}' is not scoped to stream ${stream}`);
            err.code = 'invalid_request';
            return await rejectState(res, req, stateContext, err);
          }
        }
        const state = await putSyncState(connectorId, stateMap, {
          grantId,
          allowedStreams: grantScope?.grantedStreams || null,
        });
        await emitStateEvent(req, stateContext, 'state.updated', 'succeeded', {
          persisted_streams: Object.keys(state?.state || {}),
          updated_at: state?.updated_at || null,
        });
        res.json(state);
      } catch (err) {
        return await rejectState(res, req, stateContext, err);
      }
    });
  }

  return app;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function startServer(opts = {}) {
  const log = opts.quiet ? () => {} : console.error;
  const nativeConfig = validateNativeConfiguration(opts);
  await initDb(opts.dbPath || DB_PATH);
  await seedPreRegisteredClients(resolvePreRegisteredPublicClients(opts));
  log('[PDPP] Database initialized');

  configureNativeManifest(nativeConfig?.nativeManifest || null);
  const providerName =
    opts.providerName ||
    nativeConfig?.nativeManifest?.display_name ||
    nativeConfig?.nativeManifest?.name ||
    process.env.PDPP_PROVIDER_NAME ||
    PDPP_PROVIDER_NAME;

  const requestedAsPort = opts.asPort ?? AS_PORT;
  const requestedRsPort = opts.rsPort ?? RS_PORT;
  const ignoreAmbientPublicUrls =
    opts.ignoreAmbientPublicUrls ??
    ((requestedAsPort === 0 || requestedRsPort === 0) && !opts.asPublicUrl && !opts.rsPublicUrl && !opts.asIssuer);
  const asApp = buildAsApp({
    nativeManifest: nativeConfig?.nativeManifest || null,
    providerName,
    enableDynamicClientRegistration: resolveDynamicClientRegistrationEnabled(opts),
    dynamicClientRegistrationInitialAccessTokens: resolveDynamicClientRegistrationInitialAccessTokens(opts),
    asPublicUrl: opts.asPublicUrl,
    asIssuer: opts.asIssuer,
    ignoreAmbientPublicUrls,
  });

  // opts.bindHost — restrict listening interface (e.g. '127.0.0.1'). Default
  // is undefined which lets Node bind to all interfaces. Passing '127.0.0.1'
  // keeps the server off the LAN/public internet.
  const bindHost = opts.bindHost;

  return new Promise((resolve) => {
    const asListen = bindHost
      ? (port, cb) => asApp.listen(port, bindHost, cb)
      : (port, cb) => asApp.listen(port, cb);
    const asServer = asListen(requestedAsPort, () => {
      const asPort = asServer.address().port;
      const asPublicUrl = opts.asPublicUrl || opts.asIssuer || `http://localhost:${asPort}`;
      log(`[PDPP AS] Authorization server on http://localhost:${asPort}`);
      const rsApp = buildRsApp({
        asPort,
        nativeManifest: nativeConfig?.nativeManifest || null,
        providerName,
        asPublicUrl,
        asIssuer: opts.asIssuer || asPublicUrl,
        rsPublicUrl: opts.rsPublicUrl,
        ignoreAmbientPublicUrls,
      });
      const rsListen = bindHost
        ? (port, cb) => rsApp.listen(port, bindHost, cb)
        : (port, cb) => rsApp.listen(port, cb);
      const rsServer = rsListen(requestedRsPort, () => {
        const rsPort = rsServer.address().port;
        log(`[PDPP RS] Resource server on http://localhost:${rsPort}`);
        resolve({ asServer, rsServer, asPort, rsPort });
      });
    });
  });
}

// Run directly
if (process.argv[1] && process.argv[1].endsWith('server/index.js')) {
  startServer().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
