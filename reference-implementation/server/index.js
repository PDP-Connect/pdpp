/**
 * PDPP Personal Server
 *
 * Combined AS + RS implementing PDPP v0.1.0 core spec.
 * Starts on port 7662 (AS/introspection) and 7663 (RS query API).
 */
import { createHash } from 'node:crypto';

import { closeDb, getDb, initDb } from './db.js';
import {
  buildAuthorizationServerMetadata,
  buildHybridRetrievalCapability,
  buildLexicalRetrievalCapability,
  buildProtectedResourceMetadata,
  buildSemanticRetrievalCapability,
  resolvePublicUrl,
  resolveSiblingPublicUrl,
  shouldUseDirectRequestOrigin,
  stripTrailingSlash,
} from './metadata.ts';
import { createTraceContext, emitSpineEvent, generateSpineId, listSpineCorrelations, listSpineEventsPage, searchSpine } from '../lib/spine.ts';
import { exec, getOne, InvalidCursorError, referenceQueries, transaction } from '../lib/db.ts';
import {
  registerConnector, getConnectorManifest, getConfiguredNativeManifest, getManifestForStorageBinding, initiateGrant, getPendingConsent,
  approveGrant, introspect, revokeGrant, denyGrant,
  createConsentExchangeCode, consumeConsentExchangeCode,
  initiateOwnerDeviceAuthorization, getOwnerDeviceAuthorizationByUserCode,
  approveOwnerDeviceAuthorization, denyOwnerDeviceAuthorization, exchangeOwnerDeviceCode, configureNativeManifest,
  deleteRegisteredClient, listOwnerIssuedClients, listRegisteredConnectorIds,
  parsePendingConsentRequestUri, registerDynamicClient, requireGrantContractAgainstManifest, requireResolvedPersistedGrantState, seedPreRegisteredClients,
  getPendingConsentRowByApprovalId, getOwnerDeviceAuthRowByApprovalId,
  buildPendingConsentRequestUri,
} from './auth.js';
import {
  ingestRecord, queryRecords, aggregateRecords, getRecord, deleteRecord, deleteAllRecords,
  listStreams, listAllStreams, getSyncState, putSyncState, getDatasetSummary,
} from './records.js';
import { getLexicalIndexBackfillProgress, lexicalIndexBackfillForManifest, runLexicalSearch } from './search.js';
import { runHybridSearch } from './search-hybrid.js';
import { reconcilePolyfillManifests } from './polyfill-manifest-reconcile.ts';
import {
  computeIndexState as computeSemanticIndexState,
  configureSemanticBackend,
  getSemanticIndexBackfillProgress,
  getSemanticBackend,
  resolveSemanticBackendFromEnv,
  runSemanticSearch,
  semanticIndexBackfillForManifest,
} from './search-semantic.js';
import { collectDeploymentDiagnostics } from './deployment-diagnostics.ts';
import { createOwnerAuthPlaceholder, OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import { createController } from '../runtime/controller.ts';
import { isClosedPipeWriteError } from '../runtime/pipe-errors.js';
import { createApp, buildLogger } from './transport.js';
import {
  HOSTED_UI_CSS,
  HOSTED_UI_CSS_PATH,
  escapeHtml as hostedEscape,
  renderActionRow,
  renderEmptyState,
  renderHostedDocument,
  renderKeyValueList,
  renderPageIntro,
  renderResultState,
  renderSurface,
} from './hosted-ui.js';
import {
  getConnectorDetail,
  listConnectorSummaries,
  listPendingApprovals,
  listRecordsTimeline,
} from './ref-control.ts';
import {
  DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
  DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS,
} from './reference-local-defaults.ts';
import {
  resolveReferenceRevision,
  setReferenceRevisionHeader,
} from './reference-revision.js';
import { resolveReferenceTopology } from './reference-topology.ts';

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

// Heuristic: is this DB path a canonical polyfill-connectors deployment DB?
// Used to decide whether to auto-reconcile persisted manifests on startup.
// The dev script's default
// (`../packages/polyfill-connectors/.pdpp-data/pdpp.sqlite`) is the
// authoritative sentinel; overrides use the explicit opts/env knob.
function looksLikePolyfillDeploymentDbPath(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') return false;
  if (dbPath === ':memory:') return false;
  return dbPath.includes('/polyfill-connectors/') && dbPath.endsWith('pdpp.sqlite');
}

async function collectRetrievalStartupBackfillManifests({ nativeManifest, logger }) {
  if (nativeManifest) {
    return [nativeManifest];
  }

  const manifests = [];
  const connectorIds = await listRegisteredConnectorIds();
  for (const connectorId of connectorIds) {
    try {
      const manifest = await getConnectorManifest(connectorId);
      if (manifest) {
        manifests.push(manifest);
      }
    } catch (err) {
      logger.warn(
        { err, connectorId },
        'skipping retrieval startup backfill for connector with invalid manifest',
      );
    }
  }
  return manifests;
}

async function runRetrievalStartupBackfill({ manifests, logger, signal = null }) {
  if (manifests.length === 0) {
    return;
  }

  const startedAt = Date.now();
  logger.info({ connectorCount: manifests.length }, 'retrieval startup backfill started');

  for (const manifest of manifests) {
    if (signal?.aborted) {
      logger.info({ reason: 'shutdown' }, 'retrieval startup backfill aborted between connectors');
      return;
    }
    const connectorId = manifest.connector_id;
    try {
      logger.info({ connectorId }, 'retrieval startup backfill connector started');
      await lexicalIndexBackfillForManifest({
        manifest,
        log: (msg) => logger.info(msg),
        signal,
      });
      const semanticBackend = getSemanticBackend();
      if (semanticBackend?.available()) {
        await semanticIndexBackfillForManifest({
          manifest,
          log: (msg) => logger.info(msg),
          signal,
        });
      }
      logger.info({ connectorId }, 'retrieval startup backfill connector completed');
    } catch (err) {
      // If the abort is the cause, log at info — this is an expected
      // shutdown path, not an operator-visible failure.
      if (signal?.aborted) {
        logger.info(
          { connectorId, reason: 'shutdown' },
          'retrieval startup backfill connector aborted',
        );
        return;
      }
      logger.warn(
        { err, connectorId },
        'retrieval startup backfill failed for connector',
      );
    }
  }

  logger.info(
    { connectorCount: manifests.length, duration_ms: Date.now() - startedAt },
    'retrieval startup backfill completed',
  );
}

function scheduleRetrievalStartupBackfill({ manifests, logger, signal = null }) {
  if (manifests.length === 0) {
    return Promise.resolve();
  }

  logger.info(
    { connectorCount: manifests.length },
    'retrieval startup backfill scheduled after AS/RS listen',
  );

  return new Promise((resolve) => setImmediate(resolve))
    .then(() => runRetrievalStartupBackfill({ manifests, logger, signal }))
    .catch((err) => {
      // Abort-driven exits travel through this catch when the loop
      // re-throws an AbortError-like value before reaching the inner
      // try/catch (e.g., between connectors). Treat as a clean shutdown.
      if (signal?.aborted) {
        logger.info({ reason: 'shutdown' }, 'retrieval startup backfill aborted');
        return;
      }
      logger.warn({ err }, 'retrieval startup backfill crashed');
    });
}

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
  run_already_active: 409,
  no_pending_interaction: 409,
  interaction_id_mismatch: 409,
  invalid_status: 400,
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
  pdppError(res, status, code, err.message, err.param || null);
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
  if (segments.length === 4 && segments[3] === 'aggregate') {
    return {
      queryShape: 'stream_aggregate',
      streamId: segments[2],
      metric: typeof req.query?.metric === 'string' ? req.query.metric : null,
      field: typeof req.query?.field === 'string' ? req.query.field : null,
      groupBy: typeof req.query?.group_by === 'string' ? req.query.group_by : null,
    };
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

// Strip live-bearer-shaped fields from a spine event before it leaves the
// reference. `token_id` on `spine_events` is the literal opaque bearer in the
// reference's introspection table — see auth.js::issueToken — so a public
// `_ref` timeline read MUST NOT echo it back. `token.issued` events also use
// the bearer string as their `object_id` (because `object_type === 'token'`),
// so we redact that too.
//
// `pending_consent` and `owner_device_auth` events use the live `device_code`
// as their `object_id`, and `request.submitted` for `owner_device_auth`
// carries `data.user_code` — both are bearer-equivalent in the takeover
// chain (the device_code redeems for an owner bearer at /oauth/token; the
// user_code is the human verifier that completes the device flow). We
// redact both here so trace/timeline reads cannot leak them.
//
// The schema-level fix lives in `openspec/changes/
// harden-reference-auth-surfaces/design-notes/
// spine-token-id-storage-2026-04-27.md`; this projection is the read-time
// guarantee we ship today.
const REDACTED_OBJECT_ID_LITERAL_BY_TYPE = {
  token: '<redacted-token-id>',
  pending_consent: '<redacted-device-code>',
  owner_device_auth: '<redacted-device-code>',
};
const REDACTED_BEARER_DATA_KEYS = new Set(['device_code', 'user_code', 'request_uri']);

function redactSpineEventForPublic(event) {
  if (!event || typeof event !== 'object') return event;
  const { token_id: _token_id, ...rest } = event;
  const objectIdLiteral = REDACTED_OBJECT_ID_LITERAL_BY_TYPE[rest.object_type];
  if (objectIdLiteral && typeof rest.object_id === 'string') {
    rest.object_id = objectIdLiteral;
  }
  if (rest.data && typeof rest.data === 'object' && !Array.isArray(rest.data)) {
    let cloned = null;
    for (const key of REDACTED_BEARER_DATA_KEYS) {
      if (key in rest.data) {
        if (!cloned) cloned = { ...rest.data };
        cloned[key] = '<redacted-bearer>';
      }
    }
    if (cloned) rest.data = cloned;
  }
  return rest;
}

function buildTimelineEnvelope(object, idKey, idValue, events, pagination = null) {
  const traceId = events.find((event) => event.trace_id)?.trace_id || null;
  const envelope = {
    object,
    [idKey]: idValue,
    trace_id: traceId,
    event_count: events.length,
    data: events.map(redactSpineEventForPublic),
  };
  if (pagination) {
    envelope.truncated = pagination.truncated;
    envelope.next_cursor = pagination.next_cursor;
    envelope.limit = pagination.limit;
  }
  return envelope;
}

const TIMELINE_DEFAULT_LIMIT = 2_000;
const TIMELINE_MAX_LIMIT = 5_000;

function parseTimelinePageOptions(req, res) {
  const rawLimit = req.query?.limit;
  let limit = TIMELINE_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      pdppError(res, 400, 'invalid_request', `limit must be a positive integer (got "${rawLimit}")`, 'limit');
      return null;
    }
    if (parsed > TIMELINE_MAX_LIMIT) {
      pdppError(res, 400, 'invalid_request', `limit ${parsed} exceeds maximum ${TIMELINE_MAX_LIMIT}`, 'limit');
      return null;
    }
    limit = parsed;
  }
  const cursor = typeof req.query?.cursor === 'string' && req.query.cursor.length > 0
    ? req.query.cursor
    : null;
  return { limit, cursor };
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

// Auth gate for `POST /grants/:grantId/revoke`. Accepts:
//   - any owner bearer whose token row is real and not token-level-revoked or
//     token-level-expired. (A still-good owner bearer SHALL be able to revoke
//     any grant. We do not require introspection's `active === true` because
//     owner tokens have no grant binding to invalidate.)
//   - a client bearer whose token row is real, not token-level-revoked or
//     token-level-expired, and whose row's `grant_id` matches the URL
//     `:grantId`. We deliberately allow `grant_invalid`/`grant_revoked`/
//     `grant_expired` introspection here because the bearer string itself is
//     authentic and the legitimate use of a client token whose grant is
//     malformed-or-expired-or-already-revoked is to revoke the grant the
//     client holds.
// Anything else fails before any state mutation. See spec at
// openspec/changes/harden-reference-auth-surfaces/specs/
//   reference-implementation-architecture/spec.md
async function requireRevokeAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return pdppError(res, 401, 'authentication_error', 'Missing Bearer token');
  }
  const token = auth.slice(7);
  let info;
  try {
    info = await introspect(token);
  } catch {
    return pdppError(res, 401, 'authentication_error', 'Invalid or expired token');
  }
  // No introspection row at all (unknown bearer) → 401.
  if (!info || (info.active === false && !info.inactive_reason)) {
    return pdppError(res, 401, 'authentication_error', 'Invalid or expired token');
  }
  // Token-level inactive reasons (the token itself, not the grant, is bad).
  // We reject these because the bearer's authenticity is in question.
  const tokenLevelInactive = new Set(['token_revoked', 'token_expired']);
  if (info.active === false && tokenLevelInactive.has(info.inactive_reason)) {
    return pdppError(res, 401, 'authentication_error', 'Invalid or expired token');
  }
  // Token kind: owner tokens have no grant binding so introspection
  // signals their kind via `pdpp_token_kind`. Inactive owner introspection
  // (`token_revoked` / `token_expired`) is already handled above. If the
  // active introspection lacks `pdpp_token_kind`, treat as not-permitted.
  const grantId = req.params.grantId;
  if (info.pdpp_token_kind === 'owner') {
    req.tokenInfo = info;
    return next();
  }
  // Client bearer path: accept iff the row's grant_id matches the URL.
  // `grant_id` is populated even on inactive client introspections that
  // carry a grant-state inactive_reason.
  if (info.pdpp_token_kind === 'client' || (info.active === false && info.grant_id)) {
    if (info.grant_id && info.grant_id === grantId) {
      req.tokenInfo = info;
      return next();
    }
    return pdppError(res, 403, 'permission_error', 'Client token is not bound to this grant');
  }
  return pdppError(res, 403, 'permission_error', 'Token kind not permitted to revoke');
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
  // Copy the shared frozen defaults into plain mutable entries so downstream
  // code that mutates metadata during seeding can operate normally.
  return DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => ({
    ...client,
    metadata: { ...client.metadata },
  }));
}

function resolveDynamicClientRegistrationEnabled(opts = {}) {
  const requested = opts.enableDynamicClientRegistration ?? PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION;
  const initialAccessTokens = resolveDynamicClientRegistrationInitialAccessTokens(opts);
  return requested && initialAccessTokens.length > 0;
}

function resolveDynamicClientRegistrationInitialAccessTokens(opts = {}) {
  // Explicit opts win, including an explicit empty array for tests that want
  // to prove "DCR off" without toggling the enable flag.
  if (Array.isArray(opts.dynamicClientRegistrationInitialAccessTokens)) {
    return opts.dynamicClientRegistrationInitialAccessTokens.filter(Boolean);
  }
  if (PDPP_DCR_INITIAL_ACCESS_TOKENS.length > 0) {
    return PDPP_DCR_INITIAL_ACCESS_TOKENS;
  }
  // Reference-local convenience: if the operator has not configured an
  // initial access token through env or opts, fall back to the shared local
  // default so DCR is usable by default in the forkable reference setup.
  // Explicit `PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION=0` still disables DCR
  // via `resolveDynamicClientRegistrationEnabled`.
  return [DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN];
}

function resolvePreRegisteredPublicClients(opts = {}) {
  return opts.preRegisteredPublicClients || defaultPreRegisteredPublicClients();
}

function resolveOwnerAuthPlaceholderConfig(opts = {}) {
  // Explicit opts win over env so the harness can set them per-test. When
  // neither is set, placeholder auth stays off and the server keeps its
  // current open local-dev behavior.
  const password =
    opts.ownerAuthPassword ??
    (typeof process.env.PDPP_OWNER_PASSWORD === 'string' && process.env.PDPP_OWNER_PASSWORD
      ? process.env.PDPP_OWNER_PASSWORD
      : null);
  const subjectId =
    opts.ownerAuthSubjectId ??
    (typeof process.env.PDPP_OWNER_SUBJECT_ID === 'string' && process.env.PDPP_OWNER_SUBJECT_ID
      ? process.env.PDPP_OWNER_SUBJECT_ID
      : null);
  // Force `Secure` on owner cookies behind a TLS-terminating proxy where
  // `req.secure` and `X-Forwarded-Proto` cannot be relied on. Default off
  // so plain-HTTP local development continues to issue usable cookies.
  const forceSecureCookies =
    opts.ownerAuthForceSecureCookies ??
    (process.env.PDPP_OWNER_FORCE_SECURE_COOKIES === '1' ||
      process.env.PDPP_OWNER_FORCE_SECURE_COOKIES === 'true');
  // SameSite mode for the owner session and CSRF cookies. `lax` keeps the
  // existing flow (login redirects from /owner/login back to /consent)
  // working. `strict` is opt-in for deployments that don't rely on
  // top-level navigation following a redirect.
  const sameSiteRaw =
    typeof opts.ownerAuthSameSite === 'string'
      ? opts.ownerAuthSameSite
      : process.env.PDPP_OWNER_SAMESITE;
  const sameSite = sameSiteRaw === 'strict' ? 'strict' : 'lax';
  return { password, subjectId, forceSecureCookies: Boolean(forceSecureCookies), sameSite };
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
  const row = getOne(referenceQueries.grantsGetScopedStateById, [grantId]);
  if (!row) {
    const err = new Error(`Unknown grant: ${grantId}`);
    err.code = 'not_found';
    throw err;
  }

  try {
    const resolved = await requireResolvedPersistedGrantState(row);
    if (resolved.grant.access_mode !== 'continuous') {
      const err = new Error(`Grant '${grantId}' does not support grant-scoped state because access_mode is ${resolved.grant.access_mode || 'unknown'}`);
      err.code = 'invalid_request';
      err.trace_id = row.trace_id || null;
      err.scenario_id = row.scenario_id || undefined;
      throw err;
    }
    if (resolved.storageBinding.connector_id !== connectorId) {
      const err = new Error(`Grant '${grantId}' is not scoped to connector ${connectorId}`);
      err.code = 'invalid_request';
      err.trace_id = row.trace_id || null;
      err.scenario_id = row.scenario_id || undefined;
      throw err;
    }
    return {
      grantId,
      grant: resolved.grant,
      storageBinding: resolved.storageBinding,
      grantedStreams: new Set(resolved.grant.streams.map((stream) => stream.name)),
      traceId: row.trace_id || null,
      scenarioId: row.scenario_id || undefined,
    };
  } catch (err) {
    if (err?.code === 'invalid_request' || err?.code === 'not_found') {
      err.trace_id = row.trace_id || null;
      err.scenario_id = row.scenario_id || undefined;
      throw err;
    }
    const invalidErr = buildGrantInvalidError();
    invalidErr.trace_id = row.trace_id || null;
    invalidErr.scenario_id = row.scenario_id || undefined;
    throw invalidErr;
  }
}

function normalizePrimaryKey(primaryKey) {
  if (Array.isArray(primaryKey)) return primaryKey;
  if (typeof primaryKey === 'string' && primaryKey.trim()) return [primaryKey];
  return [];
}

function buildFreshness(lastUpdated = null) {
  if (!lastUpdated) {
    return { status: 'unknown' };
  }
  return {
    status: 'unknown',
    captured_at: lastUpdated,
    last_attempted_at: lastUpdated,
  };
}

function hasObjectEntries(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function getNonNullSchemaTypes(schema) {
  const rawType = schema?.type;
  if (!rawType) return new Set();
  const types = Array.isArray(rawType) ? rawType : [rawType];
  return new Set(types.filter((type) => type !== 'null'));
}

function isExactFilterableSchema(schema) {
  const types = getNonNullSchemaTypes(schema);
  if (types.size !== 1) return false;
  const [type] = types;
  return ['boolean', 'integer', 'number', 'string'].includes(type);
}

function buildFieldCapabilityFlag({ declared, granted, operators = null }) {
  const flag = {
    declared,
    usable: declared && granted,
  };
  if (operators) {
    flag.operators = operators;
  }
  if (declared && !granted) {
    flag.reason = 'field_not_granted';
  }
  return flag;
}

function buildFieldAggregationCapabilities(aggregations, field, granted) {
  return {
    sum: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.sum) && aggregations.sum.includes(field),
      granted,
    }),
    min: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.min) && aggregations.min.includes(field),
      granted,
    }),
    max: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.max) && aggregations.max.includes(field),
      granted,
    }),
    group_by: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.group_by) && aggregations.group_by.includes(field),
      granted,
    }),
  };
}

function buildFieldCapabilities(manifestStream, streamGrant = null) {
  const properties = manifestStream?.schema?.properties || {};
  const grantedFields = Array.isArray(streamGrant?.fields) && streamGrant.fields.length > 0
    ? new Set(streamGrant.fields)
    : null;
  const rangeFilters = manifestStream?.query?.range_filters || {};
  const lexicalFields = new Set(manifestStream?.query?.search?.lexical_fields || []);
  const semanticFields = new Set(manifestStream?.query?.search?.semantic_fields || []);
  const aggregations = manifestStream?.query?.aggregations || {};

  return Object.fromEntries(
    Object.entries(properties).map(([field, schema]) => {
      const granted = !grantedFields || grantedFields.has(field);
      const rangeOperators = Array.isArray(rangeFilters[field]) ? rangeFilters[field] : null;
      return [field, {
        schema,
        granted,
        exact_filter: buildFieldCapabilityFlag({
          declared: isExactFilterableSchema(schema),
          granted,
        }),
        range_filter: buildFieldCapabilityFlag({
          declared: Boolean(rangeOperators),
          granted,
          operators: rangeOperators || undefined,
        }),
        lexical_search: buildFieldCapabilityFlag({
          declared: lexicalFields.has(field),
          granted,
        }),
        semantic_search: buildFieldCapabilityFlag({
          declared: semanticFields.has(field),
          granted,
        }),
        aggregation: buildFieldAggregationCapabilities(aggregations, field, granted),
      }];
    }),
  );
}

function buildStreamMetadataEntry({ manifestStream, streamGrant = null, grantStreams = [], freshness = null }) {
  const expandStreamGrant = streamGrant
    ? { ...streamGrant, grantStreams }
    : null;
  return {
    object: 'stream_metadata',
    name: manifestStream.name,
    semantics: manifestStream.semantics,
    schema: manifestStream.schema,
    primary_key: normalizePrimaryKey(manifestStream.primary_key),
    cursor_field: manifestStream.cursor_field,
    consent_time_field: manifestStream.consent_time_field,
    selection: manifestStream.selection,
    views: manifestStream.views || [],
    relationships: manifestStream.relationships || [],
    query: manifestStream.query || {},
    field_capabilities: buildFieldCapabilities(manifestStream, streamGrant),
    expand_capabilities: buildExpandCapabilities(manifestStream, expandStreamGrant),
    freshness: freshness ?? buildFreshness(null),
  };
}

function buildExpandCapabilities(manifestStream, streamGrant = null) {
  const relationships = new Map((manifestStream?.relationships || []).map((relationship) => [relationship.name, relationship]));
  const grantedStreams = Array.isArray(streamGrant?.grantStreams)
    ? new Set(streamGrant.grantStreams.map((stream) => stream.name))
    : null;

  return (manifestStream?.query?.expand || [])
    .map((capability) => {
      const relationship = relationships.get(capability.name);
      if (!relationship) return null;
      const granted = !grantedStreams || grantedStreams.has(relationship.stream);
      const entry = {
        name: capability.name,
        stream: relationship.stream,
        cardinality: relationship.cardinality,
        granted,
        usable: granted,
      };
      if (relationship.foreign_key) {
        entry.foreign_key = relationship.foreign_key;
      }
      if (capability.default_limit !== undefined) {
        entry.default_limit = capability.default_limit;
      }
      if (capability.max_limit !== undefined) {
        entry.max_limit = capability.max_limit;
      }
      if (!granted) {
        entry.reason = 'related_stream_not_granted';
      }
      return entry;
    })
    .filter(Boolean);
}

function buildDiscoveryUrl(path, connectorId = null) {
  const connectorQuery = connectorId ? `?connector_id=${encodeURIComponent(connectorId)}` : '';
  return `${path}${connectorQuery}`;
}

function buildStreamDiscoveryCapabilities({ connectorId = null, stream }) {
  const encodedStream = encodeURIComponent(stream.name);
  const rangeFilters = stream.query?.range_filters;
  const expand = stream.query?.expand;
  const aggregations = stream.query?.aggregations;
  const hasAggregations = hasObjectEntries(aggregations);

  return {
    stream_metadata: true,
    metadata_url: buildDiscoveryUrl(`/v1/streams/${encodedStream}`, connectorId),
    records: true,
    records_url: buildDiscoveryUrl(`/v1/streams/${encodedStream}/records`, connectorId),
    aggregate: hasAggregations,
    aggregate_url: hasAggregations
      ? buildDiscoveryUrl(`/v1/streams/${encodedStream}/aggregate`, connectorId)
      : null,
    exact_filters: true,
    range_filters: hasObjectEntries(rangeFilters),
    expand: Array.isArray(expand) && expand.length > 0,
    changes_since: true,
  };
}

function buildStreamDiscoverySummary({ connectorId = null, stream, summary = null }) {
  const lastUpdated = summary?.last_updated || null;
  return {
    object: 'stream',
    name: stream.name,
    record_count: summary?.record_count || 0,
    last_updated: lastUpdated,
    freshness: buildFreshness(lastUpdated),
    capabilities: buildStreamDiscoveryCapabilities({ connectorId, stream }),
  };
}

async function buildConnectorSchemaItem({ source, storageBinding, manifest, grant = null }) {
  const connectorId = source?.binding_kind === 'connector' ? source.connector_id : null;
  const streamSummaries = grant
    ? await listStreams(storageBinding, grant, manifest)
    : await listAllStreams(storageBinding);
  const summaryByName = new Map(streamSummaries.map((summary) => [summary.name, summary]));
  const grantStreamByName = grant
    ? new Map((grant.streams || []).map((streamGrant) => [streamGrant.name, streamGrant]))
    : null;
  const visibleStreams = grant
    ? grant.streams
      .map((streamGrant) => manifest.streams.find((stream) => stream.name === streamGrant.name))
      .filter(Boolean)
    : manifest.streams || [];
  const grantStreams = grant?.streams || [];

  const streams = visibleStreams.map((manifestStream) => {
    const lastUpdated = summaryByName.get(manifestStream.name)?.last_updated || null;
    return buildStreamMetadataEntry({
      manifestStream,
      streamGrant: grantStreamByName ? grantStreamByName.get(manifestStream.name) || null : null,
      grantStreams,
      freshness: buildFreshness(lastUpdated),
    });
  });

  const item = {
    object: 'connector',
    source,
    stream_count: streams.length,
    streams,
  };
  if (connectorId) {
    item.connector_id = connectorId;
  }
  return item;
}

async function buildConnectorDiscoveryItem({ source, storageBinding, manifest, grant = null }) {
  const connectorId = source?.binding_kind === 'connector' ? source.connector_id : null;
  const streamSummaries = grant
    ? await listStreams(storageBinding, grant, manifest)
    : await listAllStreams(storageBinding);
  const summaryByName = new Map(streamSummaries.map((summary) => [summary.name, summary]));
  const visibleStreams = grant
    ? grant.streams
      .map((streamGrant) => manifest.streams.find((stream) => stream.name === streamGrant.name))
      .filter(Boolean)
    : manifest.streams || [];

  const item = {
    object: 'connector',
    source,
    stream_count: visibleStreams.length,
    streams: visibleStreams.map((stream) => buildStreamDiscoverySummary({
      connectorId,
      stream,
      summary: summaryByName.get(stream.name) || null,
    })),
  };

  if (connectorId) {
    item.connector_id = connectorId;
  }

  return item;
}

function decorateBlobRefValue(blobRef) {
  if (!blobRef || typeof blobRef !== 'object' || typeof blobRef.blob_id !== 'string' || !blobRef.blob_id) {
    return blobRef;
  }
  return {
    ...blobRef,
    fetch_url: `/v1/blobs/${encodeURIComponent(blobRef.blob_id)}`,
  };
}

function decorateRecordBlobRefs(record) {
  if (!record || typeof record !== 'object') return record;
  const next = { ...record };
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data) && record.data.blob_ref) {
    next.data = {
      ...record.data,
      blob_ref: decorateBlobRefValue(record.data.blob_ref),
    };
  }
  if (record.expanded && typeof record.expanded === 'object' && !Array.isArray(record.expanded)) {
    next.expanded = Object.fromEntries(
      Object.entries(record.expanded).map(([name, value]) => {
        if (value && typeof value === 'object' && Array.isArray(value.data)) {
          return [name, { ...value, data: value.data.map(decorateRecordBlobRefs) }];
        }
        return [name, decorateRecordBlobRefs(value)];
      }),
    );
  }
  return next;
}

function resolveSingleNonEmptyQueryValue(rawValue, name) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    const err = new Error(`${name} must be a single non-empty string`);
    err.code = 'invalid_request';
    throw err;
  }
  return rawValue.trim();
}

function normalizeUploadContentType(rawContentType) {
  if (typeof rawContentType !== 'string') {
    const err = new Error('Content-Type header is required');
    err.code = 'invalid_request';
    throw err;
  }
  const mediaType = rawContentType.split(';')[0].trim().toLowerCase();
  if (!mediaType || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType)) {
    const err = new Error('Content-Type header must be a valid media type');
    err.code = 'invalid_request';
    throw err;
  }
  return mediaType;
}

function coerceUploadBodyToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  const err = new Error('Blob upload body must be bytes');
  err.code = 'invalid_request';
  throw err;
}

function persistContentAddressedBlob({ connectorId, stream, recordKey, mimeType, data }) {
  const sha256 = createHash('sha256').update(data).digest('hex');
  const blobId = `blob_sha256_${sha256}`;
  const sizeBytes = data.byteLength;
  const stored = transaction(() => {
    exec(referenceQueries.blobsInsertBlob, [
      blobId, connectorId, stream, recordKey, mimeType, sizeBytes, sha256, data,
    ]);

    const row = getOne(referenceQueries.blobsGetStoredById, [blobId]);
    if (!row || row.sha256 !== sha256 || Number(row.size_bytes) !== sizeBytes) {
      const err = new Error('Blob storage collision');
      err.code = 'api_error';
      throw err;
    }

    exec(referenceQueries.blobsInsertBinding, [blobId, connectorId, stream, recordKey]);

    return row;
  });
  return {
    blob_id: blobId,
    sha256,
    size_bytes: Number(stored.size_bytes),
    mime_type: stored.mime_type || mimeType,
  };
}

async function getVisibleStreamFreshness({ tokenInfo, storageBinding, stream, manifest }) {
  if (tokenInfo?.pdpp_token_kind === 'owner') {
    const summaries = await listAllStreams(storageBinding);
    const summary = summaries.find((entry) => entry.name === stream);
    return buildFreshness(summary?.last_updated || null);
  }

  const streamGrant = tokenInfo?.grant?.streams?.find((entry) => entry.name === stream);
  if (!streamGrant) {
    const err = new Error(`Stream '${stream}' not in grant`);
    err.code = 'grant_stream_not_allowed';
    throw err;
  }
  const summaries = await listStreams(storageBinding, { streams: [streamGrant] }, manifest);
  return buildFreshness(summaries[0]?.last_updated || null);
}

async function resolveAuthorizedBlob(req, blobId, opts = {}) {
  const rows = getDb().prepare(`
    SELECT blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data
    FROM blobs
    WHERE blob_id = ?
    LIMIT 1
  `).all(blobId);
  if (!rows.length) {
    const err = new Error('Blob not found');
    err.code = 'blob_not_found';
    throw err;
  }

  const blob = rows[0];
  const { tokenInfo } = req;
  let storageBinding;
  let manifest;

  if (tokenInfo.pdpp_token_kind === 'owner') {
    const ownerScope = resolveOwnerReadScope(req, opts);
    const ownerResolved = await resolveOwnerManifestFromScope(ownerScope, opts);
    storageBinding = ownerResolved.storageBinding;
    manifest = ownerResolved.manifest;
  } else {
    const grantResolved = await resolveGrantManifest(tokenInfo, opts);
    storageBinding = grantResolved.storageBinding;
    manifest = grantResolved.manifest;
  }

  const bindings = getDb().prepare(`
    SELECT connector_id, stream, record_key
    FROM blob_bindings
    WHERE blob_id = ?
    UNION
    SELECT connector_id, stream, record_key
    FROM blobs
    WHERE blob_id = ?
  `).all(blobId, blobId);

  for (const binding of bindings) {
    if (storageBinding?.connector_id !== binding.connector_id) continue;
    try {
      const grant = tokenInfo.pdpp_token_kind === 'owner'
        ? buildOwnerReadGrant(binding.stream)
        : tokenInfo.grant;
      const visibleRecord = await getRecord(storageBinding, binding.stream, binding.record_key, grant, manifest);
      if (visibleRecord?.data?.blob_ref?.blob_id === blobId) {
        return blob;
      }
    } catch {
      // Try the next binding; callers only learn whether any visible record
      // exposes the requested blob reference.
    }
  }

  const err = new Error('Blob not found');
  err.code = 'blob_not_found';
  throw err;
}

// ─── AS App ─────────────────────────────────────────────────────────────────

function buildAsApp(opts = {}) {
  const app = createApp({ logger: opts.logger });
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  const referenceRevision = resolveReferenceRevision(opts);
  const controller = opts.controller || null;
  const dynamicClientRegistrationEnabled = resolveDynamicClientRegistrationEnabled(opts);
  const dynamicClientRegistrationInitialAccessTokens = resolveDynamicClientRegistrationInitialAccessTokens(opts);
  const ownerAuthConfig = resolveOwnerAuthPlaceholderConfig(opts);
  const ownerAuth = createOwnerAuthPlaceholder({
    password: ownerAuthConfig.password,
    subjectId: ownerAuthConfig.subjectId,
    forceSecureCookies: ownerAuthConfig.forceSecureCookies,
    sameSite: ownerAuthConfig.sameSite,
    providerName,
  });
  app.use((req, res, next) => {
    res.setHeader('Request-Id', req.get('Request-Id') || generateSpineId('req'));
    setReferenceRevisionHeader(res, referenceRevision);
    // Clickjacking defense for reference hosted-UI pages (consent, device,
    // owner-login, approval results). The headers are harmless on JSON
    // responses, so we set them on every AS response. See
    // openspec/changes/harden-reference-auth-surfaces/specs/
    //   reference-implementation-architecture/spec.md
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  });

  // Shared hosted-UI stylesheet for reference server-rendered HTML pages
  // (consent, device, approval results, owner-login). This is a
  // reference-only asset, not a PDPP protocol surface. See
  // `reference-implementation/server/hosted-ui.js`.
  app.get(HOSTED_UI_CSS_PATH, (req, res) => {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(HOSTED_UI_CSS);
  });

  // Cold-start discovery index: a tiny unauthenticated pointer at `/` so an
  // integrator probing the AS root learns where the AS well-known endpoint
  // lives without trial-and-error. The body intentionally restates the
  // running reference revision (also exposed via the response header) so an
  // LLM agent has a single document to read.
  app.get('/', { contract: 'getAsDiscoveryIndex' }, (req, res) => {
    res.json({
      object: 'pdpp_discovery_index',
      role: 'authorization_server',
      resource_name: providerName,
      links: {
        well_known_authorization_server: '/.well-known/oauth-authorization-server',
      },
      reference_revision: referenceRevision,
    });
  });

  // Reference-only owner-auth placeholder. This is NOT a public PDPP
  // protocol surface; it gates local approval UIs when
  // `PDPP_OWNER_PASSWORD` is set, and is a no-op otherwise. See
  // `reference-implementation/server/owner-auth.js`.
  ownerAuth.attachRoutes(app);

  function renderPendingGrantConsentHtml(pending, requestUri, csrfToken) {
    const request = pending.request;
    const client = request.client || {};
    const selection = request.selection || {};
    const sourceBinding = request.source_binding;
    const clientName = client.client_display?.name || client.client_id || 'Client application';
    const connectorId = sourceBinding?.connector_id;
    const providerId = sourceBinding?.provider_id;
    const showConnectorLabel = sourceBinding?.binding_kind !== 'provider_native';
    const sourceLabel = showConnectorLabel
      ? (connectorId || 'this source')
      : (providerId || 'this source');

    const requestedStreams = Array.isArray(selection.streams) ? selection.streams : [];
    const isWildcardRequest = requestedStreams.length === 1 && requestedStreams[0]?.name === '*';
    const manifestStreamNames = Array.isArray(pending.manifestStreamNames)
      ? pending.manifestStreamNames
      : null;

    let streamsBlock;
    if (isWildcardRequest) {
      // The owner must see effective scope, not the protocol shorthand `*`.
      const resolvedNames = manifestStreamNames && manifestStreamNames.length > 0
        ? manifestStreamNames
        : null;
      const countSummary = resolvedNames
        ? `All streams for ${sourceLabel} (${resolvedNames.length}) are in scope.`
        : `All streams for ${sourceLabel} are in scope.`;
      const resolvedList = resolvedNames
        ? `<ul class="hosted-ui-streams">${
            resolvedNames
              .map((name) => `<li><span class="hosted-ui-stream-name">${hostedEscape(name)}</span></li>`)
              .join('')
          }</ul>`
        : '';
      streamsBlock = `
      <div>
        <span class="pdpp-title">Streams requested</span>
        <div class="hosted-ui-warning" role="note">
          <span class="hosted-ui-warning-title">All streams</span>
          <span class="hosted-ui-warning-body">${hostedEscape(countSummary)}</span>
        </div>
        ${resolvedList}
      </div>`;
    } else {
      const streamItems = requestedStreams
        .map((s) => {
          const fragments = [
            s.time_range ? `since ${s.time_range.since || 'any'}` : null,
            s.fields ? `fields: ${s.fields.join(', ')}` : null,
            s.view ? `view: ${s.view}` : null,
            s.necessity === 'optional' ? 'optional' : null,
          ].filter(Boolean);
          const meta = fragments.length
            ? ` <span class="hosted-ui-stream-meta">${hostedEscape(fragments.join(' · '))}</span>`
            : '';
          return `<li><span class="hosted-ui-stream-name">${hostedEscape(s.name)}</span>${meta}</li>`;
        })
        .join('');
      streamsBlock = `
      <div>
        <span class="pdpp-title">Streams requested</span>
        <ul class="hosted-ui-streams">${streamItems}</ul>
      </div>`;
    }

    const isContinuous = selection.access_mode === 'continuous';
    const hasRetentionBound = Boolean(selection.retention?.max_duration);

    let continuousBlock = '';
    if (isContinuous) {
      const continuousBody = hasRetentionBound
        ? 'This is long-lived access — the client may keep reading until the grant is revoked or its retention bound is reached.'
        : 'This is long-lived access with no explicit expiry. The client may keep reading until you revoke the grant.';
      continuousBlock = `
      <div class="hosted-ui-warning" role="note">
        <span class="hosted-ui-warning-title">Continuous access</span>
        <span class="hosted-ui-warning-body">${hostedEscape(continuousBody)}</span>
      </div>`;
    }

    const facts = renderKeyValueList([
      { label: 'Requesting app', value: clientName },
      showConnectorLabel && connectorId ? { label: 'Connector', value: connectorId } : null,
      !showConnectorLabel && providerId ? { label: 'Provider', value: providerId } : null,
      { label: 'Purpose', value: selection.purpose_description || selection.purpose_code },
      { label: 'Access mode', value: selection.access_mode },
      selection.retention
        ? { label: 'Retention', value: `${selection.retention.on_expiry} after ${selection.retention.max_duration}` }
        : null,
    ].filter(Boolean));

    const codeBlock = pending.userCode
      ? `<div><span class="pdpp-eyebrow">Verification code</span><div class="hosted-ui-code">${hostedEscape(pending.userCode)}</div></div>`
      : '';

    const csrfHidden = csrfToken
      ? [{ name: ownerAuth.csrfFieldName, value: csrfToken }]
      : [];
    const actions = renderActionRow([
      {
        label: 'Allow access',
        variant: 'primary',
        method: 'POST',
        action: '/consent/approve',
        hidden: [...csrfHidden, { name: 'request_uri', value: requestUri }],
      },
      {
        label: 'Deny',
        variant: 'danger',
        method: 'POST',
        action: '/consent/deny',
        hidden: [...csrfHidden, { name: 'request_uri', value: requestUri }],
      },
    ]);

    const body = [
      renderPageIntro({
        eyebrow: 'Data access request',
        title: `${clientName} wants access to your data`,
        lede: 'Review what this app is asking for. Your server will only release what you allow here.',
      }),
      renderSurface({ surface: 'human', children: [codeBlock, facts, streamsBlock, continuousBlock, actions].filter(Boolean).join('\n'), ariaLabel: 'Consent request' }),
    ].join('\n');

    return renderHostedDocument({
      title: `${providerName} — Consent request`,
      providerName,
      body,
    });
  }

  async function getPendingGrantFromRequestUri(requestUri) {
    const deviceCode = parsePendingConsentRequestUri(requestUri);
    if (!deviceCode) return { deviceCode: null, pending: null };
    const pending = await getPendingConsent(deviceCode);
    return { deviceCode, pending };
  }

  // Primary reference surface: RFC 8414 authorization-server metadata.
  app.get('/.well-known/oauth-authorization-server', { contract: 'getAuthorizationServerMetadata' }, (req, res) => {
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

  app.post('/oauth/register', { contract: 'registerDynamicClient' }, async (req, res) => {
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

      // Owner-session-authed callers (the dashboard issuing a per-token
      // client) get their session subject stamped onto the registration so
      // _ref/clients?owner=true can scope listings/deletions to that
      // operator. Anonymous callers cannot tag themselves to a subject —
      // we never read the field from the request body.
      const ownerSession = ownerAuth.readOwnerSession(req);
      const extraMetadata = ownerSession?.sub ? { issuer_subject_id: ownerSession.sub } : {};
      const registrationInput = req.body && typeof req.body === 'object' ? { ...req.body } : {};
      // `issuer_subject_id` is a reference-only stamp owned by the AS route
      // layer. Anonymous DCR callers cannot tag themselves to an owner, and
      // owner-authed callers get the session subject, not the body value.
      delete registrationInput.issuer_subject_id;
      const registered = await registerDynamicClient(registrationInput, extraMetadata);
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

  // RFC 7592 client deletion. Owner-session-gated rather than registration-
  // access-token-gated by deliberate design choice — see the rationale in
  // openspec/changes/dcr-per-owner-token-with-revoke/design.md. Cascades to
  // revoke every active grant tied to the client; refuses pre-registered
  // clients and cross-operator deletes. Idempotent: a second call returns
  // 404 not_found.
  app.delete('/oauth/register/:clientId', ownerAuth.requireOwnerSession, async (req, res) => {
    const traceContext = createTraceContext();
    res.setHeader('Request-Id', traceContext.request_id);
    setReferenceTraceId(res, traceContext.trace_id);
    try {
      const clientId = decodeURIComponent(req.params.clientId);
      const actingSubjectId = req.ownerSession?.sub || ownerAuth.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID;
      await deleteRegisteredClient(clientId, {
        actingSubjectId,
        requestId: traceContext.request_id,
        traceId: traceContext.trace_id,
      });
      res.status(204).end();
    } catch (err) {
      const status = err.code === 'not_found' ? 404 : (err.code === 'forbidden' ? 403 : 400);
      pdppError(res, status, err.code || 'invalid_request', err.message);
    }
  });

  app.post('/oauth/device_authorization', { contract: 'startOwnerDeviceAuthorization' }, async (req, res) => {
    try {
      const clientId = req.body.client_id;
      if (!clientId) {
        return oauthError(res, 400, 'invalid_request', 'client_id is required');
      }

      const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
      const result = await initiateOwnerDeviceAuthorization(clientId, {
        baseUrl: resolvePublicUrl(req, explicitBaseUrl),
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

  app.post('/oauth/token', { contract: 'exchangeOwnerDeviceToken' }, async (req, res) => {
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

  app.get('/device', ownerAuth.requireOwnerSession, async (req, res) => {
    const userCode = typeof req.query.user_code === 'string' ? req.query.user_code : '';
    const pending = userCode ? await getOwnerDeviceAuthorizationByUserCode(userCode) : null;

    if (!userCode || !pending) {
      const emptyBody = [
        renderPageIntro({
          eyebrow: 'Device verification',
          title: 'Enter verification code',
          lede: 'Paste the code shown by the CLI to continue the owner sign-in flow.',
        }),
        renderEmptyState({
          form: {
            method: 'GET',
            action: '/device',
            submitLabel: 'Continue',
            fields: [
              { name: 'user_code', label: 'User code', value: userCode || '', autofocus: true, autocomplete: 'one-time-code' },
            ],
          },
        }),
      ].join('\n');
      return res.send(renderHostedDocument({
        title: `${providerName} — Device verification`,
        providerName,
        body: emptyBody,
      }));
    }

    const facts = renderKeyValueList([
      { label: 'Client', value: pending.client_id },
      { label: 'User code', html: `<span class="hosted-ui-code">${hostedEscape(pending.user_code)}</span>` },
      { label: 'Expires', value: pending.expires_at },
    ]);

    const ownerBlock = ownerAuth.enabled
      ? renderKeyValueList([
          { label: 'Owner subject', html: `<code>${hostedEscape(ownerAuth.subjectId)}</code> <span class="pdpp-caption">signed-in owner</span>` },
        ])
      : `<div class="hosted-ui-field">
  <label for="hosted-ui-subject_id">Subject ID</label>
  <input id="hosted-ui-subject_id" name="subject_id" value="owner_local" type="text" />
</div>`;

    const csrfToken = ownerAuth.ensureCsrfToken(req, res);
    const csrfField = ownerAuth.renderCsrfField(csrfToken);
    const formOpen = `<form class="hosted-ui-surface" method="POST" action="/device/approve" data-surface="human" aria-label="Approve CLI access">
  ${csrfField}
  <input type="hidden" name="user_code" value="${hostedEscape(pending.user_code)}" />
  ${facts}
  ${ownerBlock}
  <div class="hosted-ui-actions">
    <button type="submit" class="hosted-ui-button" data-variant="primary">Approve and issue owner token</button>
    <button type="submit" class="hosted-ui-button" data-variant="danger" formaction="/device/deny">Deny</button>
  </div>
</form>`;

    const body = [
      renderPageIntro({
        eyebrow: 'Device verification',
        title: `Approve owner access to ${providerName}`,
        lede: 'A CLI is asking to sign in on your behalf. Approve only if you started this on a device you trust.',
      }),
      formOpen,
    ].join('\n');

    res.send(renderHostedDocument({
      title: `${providerName} — Approve CLI access`,
      providerName,
      body,
    }));
  });

  app.post('/device/approve', ownerAuth.requireOwnerSession, ownerAuth.requireCsrf, async (req, res) => {
    try {
      // approval_id is the non-redeemable opaque public id projected by
      // /_ref/approvals; the operator dashboard sends it instead of the
      // user_code so the user_code stays off public read surfaces.
      // We resolve approval_id -> user_code here, on the AS side, behind
      // the existing owner-session + CSRF gate.
      const approvalId = req.body.approval_id;
      let userCode = req.body.user_code;
      if (!userCode && approvalId) {
        const row = await getOwnerDeviceAuthRowByApprovalId(approvalId);
        if (!row || row.status !== 'pending') {
          return oauthError(res, 404, 'not_found', 'No pending device authorization for approval_id');
        }
        userCode = row.user_code;
      }
      const subjectId = ownerAuth.enabled
        ? ownerAuth.subjectId
        : (req.body.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID);
      if (!userCode) {
        return oauthError(res, 400, 'invalid_request', 'user_code or approval_id is required');
      }

      await approveOwnerDeviceAuthorization(userCode, subjectId);
      res.send(renderHostedDocument({
        title: `${providerName} — Device access approved`,
        providerName,
        body: [
          renderPageIntro({ eyebrow: 'Device verification', title: 'Approved' }),
          renderSurface({
            surface: 'human',
            children: renderResultState({
              tone: 'success',
              title: 'CLI access approved',
              body: 'The CLI can return to polling and complete sign-in now.',
            }),
          }),
        ].join('\n'),
      }));
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

  app.post('/device/deny', ownerAuth.requireOwnerSession, ownerAuth.requireCsrf, async (req, res) => {
    try {
      const approvalId = req.body.approval_id;
      let userCode = req.body.user_code;
      if (!userCode && approvalId) {
        const row = await getOwnerDeviceAuthRowByApprovalId(approvalId);
        if (!row || row.status !== 'pending') {
          return oauthError(res, 404, 'not_found', 'No pending device authorization for approval_id');
        }
        userCode = row.user_code;
      }
      const subjectId = ownerAuth.enabled
        ? ownerAuth.subjectId
        : (req.body.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID);
      if (!userCode) {
        return oauthError(res, 400, 'invalid_request', 'user_code or approval_id is required');
      }

      await denyOwnerDeviceAuthorization(userCode, subjectId);
      res.send(renderHostedDocument({
        title: `${providerName} — Device access denied`,
        providerName,
        body: [
          renderPageIntro({ eyebrow: 'Device verification', title: 'Denied' }),
          renderSurface({
            children: renderResultState({
              tone: 'danger',
              title: 'CLI access denied',
              body: 'The CLI will stop polling and report that access was denied.',
            }),
          }),
        ].join('\n'),
      }));
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
  app.post('/introspect', { contract: 'introspectToken' }, async (req, res) => {
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
      needs_input: Boolean(s.needs_input),
      connector_id: s.connector_id || null,
      provider_id: s.provider_id,
      grant_id: s.grant_id,
      failure_reason: s.failure?.reason || null,
    };
  }

  app.get('/_ref/traces', ownerAuth.requireOwnerSession, async (req, res) => {
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

  app.get('/_ref/grants', ownerAuth.requireOwnerSession, async (req, res) => {
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

  app.get('/_ref/runs', ownerAuth.requireOwnerSession, async (req, res) => {
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

  // Reference-only — not the public lexical retrieval surface.
  // /_ref/search is a spine-only artifact/id-jump helper for the operator
  // console. The public lexical retrieval contract lives at GET /v1/search;
  // these two routes share neither shape nor backing. See:
  //   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
  app.get('/_ref/search', { contract: 'refSearch' }, ownerAuth.requireOwnerSession, async (req, res) => {
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

  app.get('/_ref/traces/:traceId', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const traceId = decodeURIComponent(req.params.traceId);
      const opts = parseTimelinePageOptions(req, res);
      if (!opts) return;
      const page = listSpineEventsPage('trace', traceId, opts);
      if (!page.events.length && !opts.cursor) return pdppError(res, 404, 'not_found', 'Trace not found');
      res.json(buildTimelineEnvelope('trace', 'trace_id', traceId, page.events, page));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return pdppError(res, 400, 'invalid_cursor', err.message, 'cursor');
      }
      handleError(res, err);
    }
  });

  app.get('/_ref/grants/:grantId/timeline', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const grantId = decodeURIComponent(req.params.grantId);
      const opts = parseTimelinePageOptions(req, res);
      if (!opts) return;
      const page = listSpineEventsPage('grant', grantId, opts);
      if (!page.events.length && !opts.cursor) return pdppError(res, 404, 'not_found', 'Grant timeline not found');
      res.json(buildTimelineEnvelope('grant_timeline', 'grant_id', grantId, page.events, page));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return pdppError(res, 400, 'invalid_cursor', err.message, 'cursor');
      }
      handleError(res, err);
    }
  });

  app.get('/_ref/runs/:runId/timeline', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const runId = decodeURIComponent(req.params.runId);
      const opts = parseTimelinePageOptions(req, res);
      if (!opts) return;
      const page = listSpineEventsPage('run', runId, opts);
      if (!page.events.length && !opts.cursor) return pdppError(res, 404, 'not_found', 'Run timeline not found');
      res.json(buildTimelineEnvelope('run_timeline', 'run_id', runId, page.events, page));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return pdppError(res, 400, 'invalid_cursor', err.message, 'cursor');
      }
      handleError(res, err);
    }
  });

  // Reference-only, owner-only control surface: answer the current pending
  // interaction for a live controller-managed run. The read path remains the
  // existing run timeline; this route is mutation-only and is not a public
  // PDPP API. Submitted `data` satisfies the current run only — it is not
  // written to `.env.local`, SQLite config/state, or spine event payloads.
  app.post(
    '/_ref/runs/:runId/interaction',
    { contract: 'refRunInteraction' },
    ownerAuth.requireOwnerSession,
    async (req, res) => {
      try {
        if (!controller || typeof controller.respondToInteraction !== 'function') {
          return pdppError(res, 404, 'not_found', 'Controller is not configured on this server');
        }
        const runId = decodeURIComponent(req.params.runId);
        const body = req.body || {};
        if (typeof body.interaction_id !== 'string' || !body.interaction_id.trim()) {
          return pdppError(res, 400, 'invalid_request', 'interaction_id is required', 'interaction_id');
        }
        if (body.status !== 'success' && body.status !== 'cancelled') {
          return pdppError(res, 400, 'invalid_status', 'status must be "success" or "cancelled"', 'status');
        }
        if (body.data != null && (typeof body.data !== 'object' || Array.isArray(body.data))) {
          return pdppError(res, 400, 'invalid_request', 'data must be an object if provided', 'data');
        }
        const result = controller.respondToInteraction(runId, {
          interaction_id: body.interaction_id,
          status: body.status,
          data: body.data,
        });
        res.status(202).json({
          object: 'run_interaction_ack',
          run_id: runId,
          interaction_id: body.interaction_id,
          status: result.status,
        });
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  // Reference-only dataset summary for the operator-console hero band. Returns
  // live aggregate counts and retained-bytes totals across the substrate, plus
  // top connectors by record count. Not a PDPP protocol surface.
  app.get('/_ref/dataset/summary', { contract: 'refDatasetSummary' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const summary = await getDatasetSummary();
      res.json(summary);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/connectors', { contract: 'refListConnectors' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const data = await listConnectorSummaries(controller);
      res.json({ object: 'list', data });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/connectors/:connectorId', { contract: 'refGetConnector' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const connectorId = decodeURIComponent(req.params.connectorId);
      const detail = await getConnectorDetail(connectorId, controller);
      res.json(detail);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/approvals', { contract: 'refListApprovals' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const data = await listPendingApprovals();
      res.json({ object: 'list', data });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/records/timeline', { contract: 'refRecordsTimeline' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const limit = req.query.limit == null ? 50 : Number.parseInt(String(req.query.limit), 10);
      const order = req.query.order === 'asc' ? 'asc' : 'desc';
      const timestampMode = req.query.timestamp_mode === 'ingest' ? 'ingest' : 'native';
      const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
      const stream = typeof req.query.stream === 'string' && req.query.stream.trim() ? req.query.stream.trim() : null;
      const since = typeof req.query.since === 'string' && req.query.since.trim() ? req.query.since.trim() : null;
      const until = typeof req.query.until === 'string' && req.query.until.trim() ? req.query.until.trim() : null;
      const result = await listRecordsTimeline({
        connectorId,
        stream,
        since,
        until,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
        order,
        timestampMode,
      });
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/schedules', { contract: 'refListSchedules' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const data = controller ? await controller.listSchedules() : [];
      res.json({ object: 'list', data });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/connectors/:connectorId/schedule', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const connectorId = decodeURIComponent(req.params.connectorId);
      const schedule = controller ? await controller.getSchedule(connectorId) : null;
      if (!schedule) {
        return pdppError(res, 404, 'not_found', `No schedule for connector: ${connectorId}`);
      }
      res.json(schedule);
    } catch (err) {
      handleError(res, err);
    }
  });

  // /_ref/deployment — reference operator diagnostics. Not a PDPP protocol
  // surface; the dashboard's /dashboard/deployment page reads this. Secret
  // redaction is enforced inside collectDeploymentDiagnostics.
  app.get('/_ref/deployment', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const report = await collectDeploymentDiagnostics(
        {
          getBackend: () => getSemanticBackend(),
          getDb: () => getDb(),
          computeIndexState: () => computeSemanticIndexState(),
          getBackfillProgress: () => getSemanticIndexBackfillProgress(),
          getLexicalBackfillProgress: () => getLexicalIndexBackfillProgress(),
          getConfiguredNativeManifest: () => getConfiguredNativeManifest(),
          listRegisteredConnectorIds: () => listRegisteredConnectorIds(),
          getConnectorManifest: (connectorId) => getConnectorManifest(connectorId),
        },
        { dbPath: opts.dbPath || DB_PATH }
      );
      res.json(report);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Operator-issued client listing. Backs the dashboard Tokens page so an
  // operator can see and revoke the credentials they registered. Returns
  // only dynamic clients whose `metadata.issuer_subject_id` matches the
  // requesting owner-session subject — so the listing is per-operator and
  // pre-registered seeds (`pdpp-web-dashboard`, `cli_longview`, ...) never
  // appear here. Spec: openspec/changes/dcr-per-owner-token-with-revoke/.
  app.get('/_ref/clients', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const subjectId = req.ownerSession?.sub || ownerAuth.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID;
      // ?owner=true reserves room for future filters (e.g. `?registered_by=anyone`
      // for an admin view). Today only owner=true is meaningful.
      if (req.query?.owner !== 'true') {
        return pdppError(res, 400, 'invalid_request', "owner=true query parameter is required");
      }
      const data = await listOwnerIssuedClients(subjectId);
      res.json({ object: 'list', data });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(
    '/_ref/connectors/:connectorId/run',
    { contract: 'refRunConnector' },
    ownerAuth.requireOwnerSession,
    async (req, res) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId);
        const started = await controller.runNow(connectorId);
        res.status(202).json(started);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.put(
    '/_ref/connectors/:connectorId/schedule',
    { contract: 'refPutConnectorSchedule' },
    ownerAuth.requireOwnerSession,
    async (req, res) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId);
        await resolveRegisteredConnectorManifest(connectorId);
        const result = await controller.upsertSchedule(connectorId, req.body || {});
        // Include policy_warning in the response so dashboard can surface it
        // without a second round-trip.
        const responseBody = result.policy_warning
          ? { ...result.schedule, policy_warning: result.policy_warning }
          : result.schedule;
        res.json(responseBody);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.post(
    '/_ref/connectors/:connectorId/schedule/pause',
    { contract: 'refPauseConnectorSchedule' },
    ownerAuth.requireOwnerSession,
    async (req, res) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId);
        const schedule = await controller.setScheduleEnabled(connectorId, false);
        res.json(schedule);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.post(
    '/_ref/connectors/:connectorId/schedule/resume',
    { contract: 'refResumeConnectorSchedule' },
    ownerAuth.requireOwnerSession,
    async (req, res) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId);
        const schedule = await controller.setScheduleEnabled(connectorId, true);
        res.json(schedule);
      } catch (err) {
        handleError(res, err);
      }
    }
  );

  app.delete(
    '/_ref/connectors/:connectorId/schedule',
    { contract: 'refDeleteConnectorSchedule' },
    ownerAuth.requireOwnerSession,
    async (req, res) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId);
        const deleted = await controller.deleteSchedule(connectorId);
        if (!deleted) {
          return pdppError(res, 404, 'not_found', `Schedule not found for connector: ${connectorId}`);
        }
        res.status(204).end();
      } catch (err) {
        handleError(res, err);
      }
    }
  );

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
  app.post('/oauth/par', { contract: 'createPushedAuthorizationRequest' }, async (req, res) => {
    try {
      const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
      const result = await initiateGrant(req.body, {
        baseUrl: resolvePublicUrl(req, explicitBaseUrl),
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
  app.get('/consent', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const requestUri = typeof req.query.request_uri === 'string' ? req.query.request_uri : null;
      if (!requestUri) return pdppError(res, 400, 'invalid_request', 'request_uri is required');
      const { pending } = await getPendingGrantFromRequestUri(requestUri);
      if (!pending) return res.status(404).send('Not found');
      const csrfToken = ownerAuth.ensureCsrfToken(req, res);
      res.send(renderPendingGrantConsentHtml(pending, requestUri, csrfToken));
    } catch (err) {
      handleError(res, err);
    }
  });


  // Primary approval surface for the current provider-connect request/approval profile.
  app.post('/consent/approve', { contract: 'approveConsent' }, ownerAuth.requireOwnerSession, ownerAuth.requireCsrf, async (req, res) => {
    try {
      // approval_id (from the operator dashboard) resolves on the AS side
      // to the canonical request_uri so the live device_code never leaves
      // the AS through a public read surface.
      let requestUri = req.body?.request_uri || req.query?.request_uri;
      const approvalId = req.body?.approval_id || req.query?.approval_id;
      if (!requestUri && approvalId) {
        const row = await getPendingConsentRowByApprovalId(approvalId);
        if (!row || row.status !== 'pending') {
          return pdppError(res, 404, 'not_found', 'No pending consent for approval_id');
        }
        requestUri = buildPendingConsentRequestUri(row.device_code);
      }
      const { deviceCode, pending } = await getPendingGrantFromRequestUri(requestUri);
      if (!deviceCode) return pdppError(res, 400, 'invalid_request', 'request_uri or approval_id is required');
      const traceContext = pending?.request?.trace_context || null;
      if (traceContext?.request_id) {
        res.setHeader('Request-Id', traceContext.request_id);
      }
      if (traceContext?.trace_id) {
        setReferenceTraceId(res, traceContext.trace_id);
      }
      const subjectId = ownerAuth.enabled
        ? ownerAuth.subjectId
        : (req.body?.subject_id || req.query?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID);
      const approveOpts = { ai_training_consented: req.body?.ai_training_consented };
      const { grant, token } = await approveGrant(deviceCode, subjectId, approveOpts);
      const wantsJson = req.is('application/json') || req.accepts(['html', 'json']) === 'json';
      if (wantsJson) {
        return res.json({ grant_id: grant.grant_id, token, grant });
      }
      // The HTML approval surface is the human-hosted owner consent page. The
      // bearer SHALL NOT appear anywhere in this response (browser history,
      // screenshots, screen-shares, password-manager autofill, chat
      // transcripts that paste the rendered page). Mint a single-use opaque
      // exchange code for the cold-agent handoff path; the client redeems it
      // at POST /consent/exchange to receive the bearer in a JSON body.
      // Spec: openspec/changes/harden-consent-token-handoff/specs/
      //       reference-implementation-architecture/spec.md
      const exchangeCode = createConsentExchangeCode({
        grantId: grant.grant_id,
        token,
        grant,
      });
      res.send(renderHostedDocument({
        title: `${providerName} — Access approved`,
        providerName,
        body: [
          renderPageIntro({
            eyebrow: 'Consent result',
            title: 'Access approved',
            lede: 'A grant was issued for this request. Hand the exchange code below to the client that requested access; it will redeem the code for an access token over a fresh JSON request.',
          }),
          renderSurface({
            surface: 'human',
            children: renderResultState({
              tone: 'success',
              title: 'Grant issued',
              body: 'You can revoke this access any time from the grants dashboard. The exchange code is single-use and expires shortly.',
            }),
          }),
          renderSurface({
            surface: 'protocol',
            ariaLabel: 'Technical grant details',
            children: renderKeyValueList([
              { label: 'Grant ID', html: `<code>${hostedEscape(grant.grant_id)}</code>` },
              { label: 'Consent exchange code', html: `<code>${hostedEscape(exchangeCode)}</code>` },
              { label: 'Redeem at', html: `<code>POST /consent/exchange</code>` },
            ]),
          }),
        ].join('\n'),
      }));
    } catch (err) {
      handleError(res, err);
    }
  });


  app.post('/consent/deny', ownerAuth.requireOwnerSession, ownerAuth.requireCsrf, async (req, res) => {
    try {
      let requestUri = req.body?.request_uri || req.query?.request_uri;
      const approvalId = req.body?.approval_id || req.query?.approval_id;
      if (!requestUri && approvalId) {
        const row = await getPendingConsentRowByApprovalId(approvalId);
        if (!row || row.status !== 'pending') {
          return pdppError(res, 404, 'not_found', 'No pending consent for approval_id');
        }
        requestUri = buildPendingConsentRequestUri(row.device_code);
      }
      const { deviceCode, pending } = await getPendingGrantFromRequestUri(requestUri);
      if (!deviceCode) return pdppError(res, 400, 'invalid_request', 'request_uri or approval_id is required');
      const traceContext = pending?.request?.trace_context || null;
      if (traceContext?.request_id) {
        res.setHeader('Request-Id', traceContext.request_id);
      }
      if (traceContext?.trace_id) {
        setReferenceTraceId(res, traceContext.trace_id);
      }
      const deleted = await denyGrant(deviceCode);
      if (!deleted) return pdppError(res, 404, 'not_found', 'Pending consent request not found');
      res.send(renderHostedDocument({
        title: `${providerName} — Access denied`,
        providerName,
        body: [
          renderPageIntro({ eyebrow: 'Consent result', title: 'Access Denied' }),
          renderSurface({
            children: renderResultState({
              tone: 'danger',
              title: 'Request rejected',
              body: 'The pending data access request was rejected and cleared.',
            }),
          }),
        ].join('\n'),
      }));
    } catch (err) {
      handleError(res, err);
    }
  });


  // Reference-only redemption surface for the human-hosted approval flow.
  // The HTML branch of POST /consent/approve embeds an opaque single-use code
  // instead of the live bearer; the client (or human relaying for the client)
  // redeems the code here to receive the same JSON body the JSON branch of
  // POST /consent/approve already returns. Spec:
  //   openspec/changes/harden-consent-token-handoff/specs/
  //     reference-implementation-architecture/spec.md
  app.post('/consent/exchange', { contract: 'exchangeConsentCode' }, async (req, res) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code : null;
      if (!code) {
        return pdppError(res, 400, 'invalid_request', 'code is required');
      }
      const result = consumeConsentExchangeCode(code);
      if (!result.ok) {
        if (result.reason === 'expired') {
          return pdppError(res, 410, 'invalid_grant', 'Consent exchange code has expired');
        }
        if (result.reason === 'consumed') {
          return pdppError(res, 410, 'invalid_grant', 'Consent exchange code has already been redeemed');
        }
        return pdppError(res, 404, 'not_found', 'Unknown consent exchange code');
      }
      return res.json({ grant_id: result.grantId, token: result.token, grant: result.grant });
    } catch (err) {
      handleError(res, err);
    }
  });


  // Primary reference surface.
  app.post('/grants/:grantId/revoke', { contract: 'revokeGrant' }, requireRevokeAuth, async (req, res) => {
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

function buildAgentDiscoveryMetadata(origin) {
  if (!origin) {
    return null;
  }
  const base = stripTrailingSlash(origin);
  return {
    advisory: true,
    skill_name: 'pdpp-data-access',
    recommended_flow: 'pdpp agent',
    skill_catalog: `${base}/.well-known/skills/index.json`,
    skill: `${base}/.well-known/skills/pdpp-data-access/SKILL.md`,
    llms_txt: `${base}/llms.txt`,
    llms_full_txt: `${base}/llms-full.txt`,
  };
}

function buildRsApp(opts = {}) {
  const app = createApp({ logger: opts.logger });
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  const referenceRevision = resolveReferenceRevision(opts);

  app.use((req, res, next) => {
    res.setHeader('Request-Id', req.get('Request-Id') || generateSpineId('req'));
    setReferenceRevisionHeader(res, referenceRevision);
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

  // Cold-start discovery index: a tiny unauthenticated pointer at `/` so a
  // probe at the RS root learns where the well-known endpoint, capability
  // schema, and core query base live before guessing at REST/LLM-API
  // conventions. See openspec/changes/polish-reference-api-discovery-seams.
  app.get('/', { contract: 'getRsDiscoveryIndex' }, (req, res) => {
    res.json({
      object: 'pdpp_discovery_index',
      role: 'resource_server',
      resource_name: providerName,
      links: {
        well_known: '/.well-known/oauth-protected-resource',
        schema: '/v1/schema',
        core_query_base: '/v1',
        connectors: '/v1/connectors',
      },
      reference_revision: referenceRevision,
    });
  });

  // Primary reference surface: RFC 9728 protected-resource metadata.
  app.get('/.well-known/oauth-protected-resource', { contract: 'getProtectedResourceMetadata' }, (req, res) => {
    const explicitResource = opts.rsPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.RS_PUBLIC_URL : null);
    const resource = resolvePublicUrl(req, explicitResource);
    const explicitIssuer = opts.asIssuer || opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null);
    const fallbackIssuer = `${req.protocol}://${req.hostname}:${opts.asPort || AS_PORT}`;
    const issuer = resolvePublicUrl(req, shouldUseDirectRequestOrigin(req, explicitIssuer) ? fallbackIssuer : explicitIssuer || fallbackIssuer);

    // Lexical retrieval extension advertisement. Exposed by default; reference
    // forks or test fixtures can suppress it by passing
    // opts.lexicalRetrievalSupported === false (omits the block) or
    // opts.lexicalRetrievalCapability (overrides the shape outright). See:
    //   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
    const capabilities = {};
    if (opts.lexicalRetrievalCapability) {
      capabilities.lexical_retrieval = opts.lexicalRetrievalCapability;
    } else if (opts.lexicalRetrievalSupported !== false) {
      capabilities.lexical_retrieval = buildLexicalRetrievalCapability();
    }

    // Semantic retrieval experimental extension advertisement. Truthfulness
    // rules (enforced by buildSemanticRetrievalCapability + this call site):
    //   - Only published when a real embedding backend is configured and
    //     available. opts.semanticRetrievalSupported === false suppresses it
    //     explicitly; opts.semanticRetrievalCapability overrides the shape.
    //   - model / dimensions / distance_metric come from the live backend.
    //   - index_state is read from computeSemanticIndexState at request time;
    //     backend-identity drift flips it to "stale" honestly.
    //   - stability is hardcoded "experimental" in v1; query_input is "text";
    //     lexical_blending is false. See:
    //   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
    if (opts.semanticRetrievalCapability) {
      capabilities.semantic_retrieval = opts.semanticRetrievalCapability;
    } else if (opts.semanticRetrievalSupported !== false) {
      const semBackend = getSemanticBackend();
      if (semBackend && semBackend.available()) {
        const semCap = buildSemanticRetrievalCapability({
          model: semBackend.model(),
          dimensions: semBackend.dimensions(),
          distanceMetric: semBackend.distanceMetric(),
          indexState: computeSemanticIndexState(),
          profileId: semBackend.profileId ? semBackend.profileId() : null,
          dtype: semBackend.dtype ? semBackend.dtype() : null,
          languageBias: semBackend.languageBias ? semBackend.languageBias() : null,
        });
        if (semCap) capabilities.semantic_retrieval = semCap;
      }
    }

    // Hybrid retrieval experimental extension advertisement. Truthfulness
    // rules: only publish when BOTH lexical and semantic retrieval are
    // advertised with supported:true on this server, so the composition
    // under one grant is honest. opts.hybridRetrievalSupported === false
    // suppresses it; opts.hybridRetrievalCapability overrides the shape.
    // v1 hybrid reports cursor_supported:false because the endpoint
    // rejects cursor parameters — see search-hybrid.js module header.
    if (opts.hybridRetrievalCapability) {
      capabilities.hybrid_retrieval = opts.hybridRetrievalCapability;
    } else if (opts.hybridRetrievalSupported !== false) {
      const lexSupported = capabilities.lexical_retrieval?.supported === true;
      const semSupported = capabilities.semantic_retrieval?.supported === true;
      if (lexSupported && semSupported) {
        const hybridCap = buildHybridRetrievalCapability({
          lexicalAvailable: true,
          semanticAvailable: true,
        });
        if (hybridCap && hybridCap.supported === true) {
          capabilities.hybrid_retrieval = hybridCap;
        }
      }
    }

    // Discovery hints — names the canonical first-call shapes a caller needs
    // after reading this metadata document, derived from the same runtime
    // state used for capability advertisement so the block cannot drift
    // from live behavior. See:
    //   openspec/changes/polish-reference-api-discovery-seams
    const discoveryHints = {
      schema_endpoint: '/v1/schema',
      query_base: '/v1',
      connectors_endpoint: '/v1/connectors',
      streams_endpoint_template: '/v1/streams/{stream}',
      aggregate: {
        endpoint_template: '/v1/streams/{stream}/aggregate',
      },
      changes_since_bootstrap: 'beginning',
      blob_indirection: 'data.blob_ref.fetch_url',
    };
    if (capabilities.lexical_retrieval?.supported === true) {
      discoveryHints.search = {
        endpoint: capabilities.lexical_retrieval.endpoint || '/v1/search',
        scope_param: 'streams[]',
        // The v1 lexical contract requires exactly one streams[] value when
        // any filter[...] parameter is present. See the lexical-retrieval
        // capability spec.
        filter_requires_single_stream: true,
      };
    }
    if (capabilities.hybrid_retrieval?.supported === true) {
      discoveryHints.hybrid_pagination_supported = !!capabilities.hybrid_retrieval.cursor_supported;
    }
    // Polyfill mode: an owner-token caller must pass `connector_id` on
    // discovery and read endpoints because there is no single ambient
    // source. Native single-source mode resolves the connector implicitly
    // from the manifest, so we omit the hint there rather than emit
    // `false` and confuse callers reading the absence as a default.
    if (!resolveNativeManifest(opts)) {
      discoveryHints.owner_polyfill_requires_connector_id = true;
    }

    res.json(
      buildProtectedResourceMetadata({
        resource,
        resourceName: `${providerName} Resource Server`,
        authorizationServers: [issuer],
        queryBase: `${resource}/v1`,
        providerConnectVersion: PDPP_PROVIDER_CONNECT_VERSION,
        selfExportSupported: true,
        tokenKindsSupported: ['owner', 'client'],
        capabilities,
        discoveryHints,
        agentDiscovery: buildAgentDiscoveryMetadata(
          opts.agentDiscoveryOrigin ? resolveSiblingPublicUrl(req, opts.agentDiscoveryOrigin) : null,
        ),
      })
    );
  });

  // GET /v1/connectors — bearer-scoped connector/source discovery
  app.get('/v1/connectors', { contract: 'listConnectors' }, requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);

      queryContext = {
        tokenInfo,
        queryId,
        actorType,
        actorId,
        traceId,
        scenarioId,
        sourceDescriptor: null,
        queryData: { query_shape: 'connector_list' },
      };

      let connectorItems = [];
      if (tokenInfo.pdpp_token_kind === 'owner') {
        const nativeManifest = resolveNativeManifest(opts);
        const nativeStorageBinding = resolveNativeStorageBinding(opts);
        if (nativeManifest && nativeStorageBinding) {
          const source = buildSourceDescriptor({
            binding_kind: 'provider_native',
            provider_id: nativeManifest.provider_id,
          });
          queryContext.sourceDescriptor = source;
          connectorItems = [await buildConnectorDiscoveryItem({
            source,
            storageBinding: nativeStorageBinding,
            manifest: nativeManifest,
          })];
        } else {
          const connectorIds = await listRegisteredConnectorIds();
          connectorItems = await Promise.all(connectorIds.map(async (connectorId) => {
            const manifest = await resolveRegisteredConnectorManifest(connectorId);
            return buildConnectorDiscoveryItem({
              source: { binding_kind: 'connector', connector_id: connectorId },
              storageBinding: { connector_id: connectorId },
              manifest,
            });
          }));
        }
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        const source = grantResolved.source;
        queryContext.sourceDescriptor = source;
        connectorItems = [await buildConnectorDiscoveryItem({
          source,
          storageBinding: grantResolved.storageBinding,
          manifest: grantResolved.manifest,
          grant: tokenInfo.grant,
        })];
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
          source: queryContext.sourceDescriptor,
          query_shape: 'connector_list',
          connector_count: connectorItems.length,
          stream_count: connectorItems.reduce((sum, item) => sum + item.stream_count, 0),
        },
      });

      res.json({
        object: 'list',
        data: connectorItems,
      });
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/schema — one-shot capability/schema discovery for the bearer
  app.get('/v1/schema', { contract: 'getSchema' }, requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);

      queryContext = {
        tokenInfo,
        queryId,
        actorType,
        actorId,
        traceId,
        scenarioId,
        sourceDescriptor: null,
        queryData: { query_shape: 'schema' },
      };

      let connectorItems = [];
      const bearer = {
        token_kind: tokenInfo.pdpp_token_kind,
        scope: tokenInfo.pdpp_token_kind === 'owner' ? 'owner' : 'grant',
      };
      if (tokenInfo.grant_id) bearer.grant_id = tokenInfo.grant_id;
      if (tokenInfo.client_id) bearer.client_id = tokenInfo.client_id;

      if (tokenInfo.pdpp_token_kind === 'owner') {
        const nativeManifest = resolveNativeManifest(opts);
        const nativeStorageBinding = resolveNativeStorageBinding(opts);
        if (nativeManifest && nativeStorageBinding) {
          const source = buildSourceDescriptor({
            binding_kind: 'provider_native',
            provider_id: nativeManifest.provider_id,
          });
          queryContext.sourceDescriptor = source;
          connectorItems = [await buildConnectorSchemaItem({
            source,
            storageBinding: nativeStorageBinding,
            manifest: nativeManifest,
          })];
        } else {
          const connectorIds = await listRegisteredConnectorIds();
          connectorItems = await Promise.all(connectorIds.map(async (connectorId) => {
            const manifest = await resolveRegisteredConnectorManifest(connectorId);
            return buildConnectorSchemaItem({
              source: { binding_kind: 'connector', connector_id: connectorId },
              storageBinding: { connector_id: connectorId },
              manifest,
            });
          }));
        }
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        const source = grantResolved.source;
        queryContext.sourceDescriptor = source;
        connectorItems = [await buildConnectorSchemaItem({
          source,
          storageBinding: grantResolved.storageBinding,
          manifest: grantResolved.manifest,
          grant: tokenInfo.grant,
        })];
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
          source: queryContext.sourceDescriptor,
          query_shape: 'schema',
          connector_count: connectorItems.length,
          stream_count: connectorItems.reduce((sum, item) => sum + item.stream_count, 0),
        },
      });

      res.json({
        object: 'schema',
        bearer,
        connectors: connectorItems,
      });
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/streams — list streams (client or owner)
  app.get('/v1/streams', { contract: 'listStreams' }, requireToken, async (req, res) => {
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

      res.json({
        object: 'list',
        data: streamSummaries.map((summary) => ({
          ...summary,
          freshness: buildFreshness(summary.last_updated || null),
        })),
      });
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream — stream metadata
  app.get('/v1/streams/:stream', { contract: 'getStreamMetadata' }, requireToken, async (req, res) => {
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
      const streamGrant = tokenInfo.pdpp_token_kind === 'client'
        ? tokenInfo.grant?.streams?.find((stream) => stream.name === req.params.stream)
        : null;
      if (tokenInfo.pdpp_token_kind === 'client') {
        if (!streamGrant) {
          const err = new Error(`Stream '${req.params.stream}' not in grant`);
          err.code = 'grant_stream_not_allowed';
          return await rejectQuery(res, req, queryContext, err);
        }
      }

      const freshness = await getVisibleStreamFreshness({
        tokenInfo,
        storageBinding:
          tokenInfo.pdpp_token_kind === 'owner'
            ? resolveOwnerReadScope(req, opts).storage_binding
            : resolveGrantStorageBinding(tokenInfo),
        stream: req.params.stream,
        manifest,
      });
      const metadataBody = buildStreamMetadataEntry({
        manifestStream: mStream,
        streamGrant,
        grantStreams: tokenInfo.grant?.streams || [],
        freshness,
      });

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

  // GET /v1/streams/:stream/aggregate
  app.get('/v1/streams/:stream/aggregate', { contract: 'aggregateStream' }, requireToken, async (req, res) => {
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
        query_shape: 'stream_aggregate',
        metric: typeof requestParams.metric === 'string' ? requestParams.metric : null,
        field: typeof requestParams.field === 'string' ? requestParams.field : null,
        group_by: typeof requestParams.group_by === 'string' ? requestParams.group_by : null,
        limit: requestParams.limit ? Number(requestParams.limit) : null,
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
        const ownerScope = resolveOwnerReadScope(req, opts);
        sourceDescriptor = buildSourceDescriptor(ownerScope.source);
        queryContext.sourceDescriptor = sourceDescriptor;
        const ownerResolved = await resolveOwnerManifestFromScope(ownerScope, opts);
        storageBinding = ownerResolved.storageBinding;
        manifest = ownerResolved.manifest;
        if (!manifest.streams.find((stream) => stream.name === req.params.stream)) {
          const err = new Error(`Stream '${req.params.stream}' not found`);
          err.code = 'not_found';
          return await rejectQuery(res, req, queryContext, err);
        }
        grant = buildOwnerReadGrant(req.params.stream);
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        storageBinding = grantResolved.storageBinding;
        sourceDescriptor = grantResolved.source;
        manifest = grantResolved.manifest;
        queryContext.sourceDescriptor = sourceDescriptor;
      }

      await emitQueryReceived(queryContext, req);

      const mStream = manifest?.streams?.find((stream) => stream.name === req.params.stream);
      validateRequestedQueryFieldParams(requestParams, mStream);

      const result = await aggregateRecords(storageBinding, req.params.stream, grant, requestParams, manifest);

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
          query_shape: 'stream_aggregate',
          metric: result.metric,
          field: result.field,
          group_by: result.group_by,
          filtered_record_count: result.filtered_record_count,
          group_count: Array.isArray(result.groups) ? result.groups.length : null,
        },
      });

      res.json(result);
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream/records
  app.get('/v1/streams/:stream/records', { contract: 'listRecords' }, requireToken, async (req, res) => {
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

      res.json({
        ...result,
        data: result.data.map(decorateRecordBlobRefs),
        url: req.path,
      });
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream/records/:id
  app.get('/v1/streams/:stream/records/:id', { contract: 'getRecord' }, requireToken, async (req, res) => {
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
        requestedRecordId, grant, manifest, {
          expand: req.query.expand,
          expand_limit: req.query.expand_limit,
        });
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
      res.json(decorateRecordBlobRefs(record));
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/search — public lexical retrieval extension. Thin route handler;
  // all logic (parameter parsing, owner-vs-client mode, planning, FTS5,
  // snippet hydration, response shaping) lives in search.js. See the
  // approved spec at:
  //   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
  app.get('/v1/search', { contract: 'searchRecordsLexical' }, requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);

      const isOwner = tokenInfo.pdpp_token_kind === 'owner';
      queryContext = {
        tokenInfo,
        queryId,
        actorType,
        actorId,
        traceId,
        scenarioId,
        sourceDescriptor: isOwner ? null : buildSourceDescriptor(tokenInfo.grant?.source),
        streamId: null,
        queryData: { query_shape: 'search' },
      };
      await emitQueryReceived(queryContext, req);

      const { envelope, disclosureData } = await runLexicalSearch({
        req,
        opts,
        tokenInfo,
        // Owner-mode helpers — bound to the request so the helper stays
        // generic across tests, native mode, and polyfill mode.
        resolveOwnerVisibleConnectorIds: async () => {
          const native = resolveNativeManifest(opts);
          if (native?.storage_binding?.connector_id) {
            // Native mode: a single owner-visible connector identity.
            return [native.storage_binding.connector_id];
          }
          // Polyfill mode: every registered connector is owner-visible.
          return await listRegisteredConnectorIds();
        },
        resolveOwnerScopeForConnector: (connectorId) => ({
          public_scope: 'polyfill',
          source: { binding_kind: 'connector', connector_id: connectorId },
          storage_binding: { connector_id: connectorId },
        }),
        resolveOwnerManifestFromScope: (ownerScope) =>
          resolveOwnerManifestFromScope(ownerScope, opts),
        // Synthetic owner read grant covering every stream of the manifest;
        // fields = undefined ⇒ "all fields authorized" per
        // buildSearchPlanForGrant semantics.
        buildOwnerReadGrantForManifest: (manifest) => ({
          streams: (manifest?.streams || []).map((s) => ({ name: s.name })),
        }),
        // Client-mode resolver
        resolveGrantManifest: (info) => resolveGrantManifest(info, opts),
      });

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
        stream_id: null,
        token_id: req.headers.authorization?.slice(7) || null,
        data: disclosureData,
      });

      res.json(envelope);
    } catch (err) {
      if (queryContext) {
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // Experimental — public semantic retrieval. Unstable.
  // See capabilities.semantic_retrieval.stability and
  //   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
  //
  // Only registered when a real embedding backend is configured. When no
  // backend is configured, the advertisement is also omitted (see the RS
  // metadata route handler above), and requests fall through to the default
  // 404 — which is what the spec scenario "A client encounters a server
  // that does not advertise the extension" expects.
  const semanticBackendAtRegistration = getSemanticBackend();
  if (
    semanticBackendAtRegistration
    && semanticBackendAtRegistration.available()
    && opts.semanticRetrievalSupported !== false
  ) {
    app.get('/v1/search/semantic', { contract: 'searchRecordsSemantic' }, requireToken, async (req, res) => {
      let queryContext = null;
      try {
        const { tokenInfo } = req;
        const queryId = ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
        setReferenceTraceId(res, traceId);

        const isOwner = tokenInfo.pdpp_token_kind === 'owner';
        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor: isOwner ? null : buildSourceDescriptor(tokenInfo.grant?.source),
          streamId: null,
          queryData: { query_shape: 'search_semantic' },
        };
        await emitQueryReceived(queryContext, req);

        const { envelope, disclosureData } = await runSemanticSearch({
          req,
          opts,
          tokenInfo,
          // Owner-mode helpers mirror the lexical route's wiring.
          resolveOwnerVisibleConnectorIds: async () => {
            const native = resolveNativeManifest(opts);
            if (native?.storage_binding?.connector_id) {
              return [native.storage_binding.connector_id];
            }
            return await listRegisteredConnectorIds();
          },
          resolveOwnerScopeForConnector: (connectorId) => ({
            public_scope: 'polyfill',
            source: { binding_kind: 'connector', connector_id: connectorId },
            storage_binding: { connector_id: connectorId },
          }),
          resolveOwnerManifestFromScope: (ownerScope) =>
            resolveOwnerManifestFromScope(ownerScope, opts),
          buildOwnerReadGrantForManifest: (manifest) => ({
            streams: (manifest?.streams || []).map((s) => ({ name: s.name })),
          }),
          resolveGrantManifest: (info) => resolveGrantManifest(info, opts),
        });

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
          stream_id: null,
          token_id: req.headers.authorization?.slice(7) || null,
          data: disclosureData,
        });

        res.json(envelope);
      } catch (err) {
        if (queryContext) {
          return await rejectQuery(res, req, queryContext, err);
        }
        handleError(res, err);
      }
    });
  }

  // Experimental — public hybrid retrieval. Composes lexical + semantic under
  // the same grant; deduplicates by (connector_id, stream, record_key); emits
  // per-source provenance and score objects. Registered only when BOTH
  // underlying surfaces are active on this server. See:
  //   openspec/changes/define-hybrid-retrieval/specs/hybrid-retrieval/spec.md
  const hybridBackendAtRegistration = getSemanticBackend();
  const hybridSemanticAvailable = !!(
    hybridBackendAtRegistration
    && hybridBackendAtRegistration.available()
    && opts.semanticRetrievalSupported !== false
  );
  const hybridLexicalAvailable = opts.lexicalRetrievalSupported !== false;
  if (
    opts.hybridRetrievalSupported !== false
    && hybridLexicalAvailable
    && hybridSemanticAvailable
  ) {
    app.get('/v1/search/hybrid', { contract: 'searchRecordsHybrid' }, requireToken, async (req, res) => {
      let queryContext = null;
      try {
        const { tokenInfo } = req;
        const queryId = ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
        setReferenceTraceId(res, traceId);

        const isOwner = tokenInfo.pdpp_token_kind === 'owner';
        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor: isOwner ? null : buildSourceDescriptor(tokenInfo.grant?.source),
          streamId: null,
          queryData: { query_shape: 'search_hybrid' },
        };
        await emitQueryReceived(queryContext, req);

        const { envelope, disclosureData } = await runHybridSearch({
          req,
          opts,
          tokenInfo,
          resolveOwnerVisibleConnectorIds: async () => {
            const native = resolveNativeManifest(opts);
            if (native?.storage_binding?.connector_id) {
              return [native.storage_binding.connector_id];
            }
            return await listRegisteredConnectorIds();
          },
          resolveOwnerScopeForConnector: (connectorId) => ({
            public_scope: 'polyfill',
            source: { binding_kind: 'connector', connector_id: connectorId },
            storage_binding: { connector_id: connectorId },
          }),
          resolveOwnerManifestFromScope: (ownerScope) =>
            resolveOwnerManifestFromScope(ownerScope, opts),
          buildOwnerReadGrantForManifest: (manifest) => ({
            streams: (manifest?.streams || []).map((s) => ({ name: s.name })),
          }),
          resolveGrantManifest: (info) => resolveGrantManifest(info, opts),
        });

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
          stream_id: null,
          token_id: req.headers.authorization?.slice(7) || null,
          data: disclosureData,
        });

        res.json(envelope);
      } catch (err) {
        if (queryContext) {
          return await rejectQuery(res, req, queryContext, err);
        }
        handleError(res, err);
      }
    });
  }

  app.post('/v1/blobs', { contract: 'uploadBlob' }, requireToken, requireOwner, async (req, res) => {
    try {
      const connectorId = resolveSingleNonEmptyQueryValue(req.query.connector_id, 'connector_id');
      const stream = resolveSingleNonEmptyQueryValue(req.query.stream, 'stream');
      const recordKey = resolveSingleNonEmptyQueryValue(req.query.record_key, 'record_key');
      const mimeType = normalizeUploadContentType(req.headers['content-type']);
      const manifest = await resolveRegisteredConnectorManifest(connectorId);
      const manifestStream = (manifest.streams || []).find((candidate) => candidate.name === stream);
      if (!manifestStream) {
        const err = new Error(`Stream '${stream}' not found for connector ${connectorId}`);
        err.code = 'not_found';
        throw err;
      }
      const body = coerceUploadBodyToBuffer(req.body);
      const result = persistContentAddressedBlob({
        connectorId,
        stream,
        recordKey,
        mimeType,
        data: body,
      });
      res.json({
        object: 'blob',
        ...result,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/v1/blobs/:blob_id', { contract: 'getBlob' }, requireToken, async (req, res) => {
    try {
      const blobId = decodeURIComponent(req.params.blob_id);
      const blob = await resolveAuthorizedBlob(req, blobId, opts);
      res.setHeader('Content-Type', blob.mime_type);
      res.setHeader('Content-Length', String(blob.size_bytes));
      res.send(Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data || ''));
    } catch (err) {
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
    app.post('/v1/ingest/:stream', requireToken, requireOwner, async (req, res) => {
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
  const logger = opts.logger ?? buildLogger({ quiet: !!opts.quiet });
  const nativeConfig = validateNativeConfiguration(opts);
  await initDb(opts.dbPath || DB_PATH, {
    busyTimeoutMs: opts.sqliteBusyTimeoutMs,
    onSchemaRetry: ({ attempt, delay, err }) => {
      logger.warn(
        { attempt, delayMs: delay, code: err?.code, msg: err?.message },
        'startup schema exec contended with sqlite lock; retrying',
      );
    },
  });
  await seedPreRegisteredClients(
    resolvePreRegisteredPublicClients(opts),
    {
      onRetry: ({ attempt, delay, err }) => {
        logger.warn(
          { attempt, delayMs: delay, code: err?.code, msg: err?.message },
          'startup client seed contended with sqlite lock; retrying',
        );
      },
    },
  );
  logger.info('database initialized');

  configureNativeManifest(nativeConfig?.nativeManifest || null);

  // Polyfill-mode manifest reconciliation. The reference persists connector
  // manifests in the DB; when we ship corrections to first-party manifests
  // (schema typing, cursor_field format, etc.), existing databases need to
  // self-heal rather than continue using stale schema declarations. Scoped
  // to the shipped `packages/polyfill-connectors/manifests/` set; custom
  // connectors are left alone.
  //
  // Default behavior:
  //   - Enabled when `PDPP_DB_PATH` / `opts.dbPath` points at the canonical
  //     polyfill-connectors data directory (the real deployment) so the
  //     owner's server self-heals on restart after a reference ships manifest
  //     fixes.
  //   - Disabled everywhere else (tests, unknown ad-hoc databases) to avoid
  //     clobbering connector manifests that happen to share ids with shipped
  //     polyfill manifests but have test-specific shape.
  //
  // `opts.reconcilePolyfillManifests` and `PDPP_RECONCILE_POLYFILL_MANIFESTS`
  // always override the default.
  if (!nativeConfig?.nativeManifest) {
    const resolvedDbPath = opts.dbPath || DB_PATH;
    const envToggle = process.env.PDPP_RECONCILE_POLYFILL_MANIFESTS;
    const envEnabled =
      envToggle === '1' ? true : envToggle === '0' ? false : undefined;
    const defaultEnabled = looksLikePolyfillDeploymentDbPath(resolvedDbPath);
    const reconcileEnabled =
      opts.reconcilePolyfillManifests !== undefined
        ? !!opts.reconcilePolyfillManifests
        : envEnabled !== undefined
          ? envEnabled
          : defaultEnabled;
    const summary = await reconcilePolyfillManifests({
      enabled: reconcileEnabled,
      log: (msg) => logger.info(msg),
    });
    if (summary.scanned > 0) {
      logger.info(summary, 'polyfill manifest reconcile summary');
    }
  }

  // Semantic retrieval experimental extension — configure the embedding
  // backend BEFORE route registration. Truthfulness rules:
  //   - opts.semanticRetrievalSupported === false: extension disabled.
  //     No backend configured, no route registered, no advertisement.
  //   - opts.semanticRetrievalBackend: explicit backend object (e.g. a
  //     hosted-provider adapter in future tranches, or a custom stub for
  //     tests). Installed verbatim.
  //   - default: resolveSemanticBackendFromEnv(). Programmatic tests keep the
  //     deterministic stub; the dev script opts into the local Transformers.js
  //     backend through PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1.
  // See:
  //   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
  //   openspec/changes/implement-semantic-retrieval-experimental-extension/specs/reference-implementation-architecture/spec.md
  if (opts.semanticRetrievalSupported === false) {
    configureSemanticBackend(null);
  } else if (opts.semanticRetrievalBackend !== undefined) {
    configureSemanticBackend(opts.semanticRetrievalBackend);
  } else {
    configureSemanticBackend(resolveSemanticBackendFromEnv());
  }

  // Startup retrieval backfill. Existing data should become searchable after
  // restart without requiring re-ingest, but a large local corpus can take
  // minutes to rebuild. Capture the boot-time manifest set now, then schedule
  // the actual index work after AS/RS are already listening. New connector
  // registrations still backfill synchronously in registerConnector.
  const startupBackfillManifests = await collectRetrievalStartupBackfillManifests({
    nativeManifest: nativeConfig?.nativeManifest || null,
    logger,
  });

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
    ((requestedAsPort === 0 || requestedRsPort === 0) &&
      !opts.asPublicUrl &&
      !opts.rsPublicUrl &&
      !opts.asIssuer);
  const referenceTopology = resolveReferenceTopology({
    explicitMode: opts.referenceMode,
    referenceOrigin: opts.referenceOrigin,
    asPublicUrl: opts.asPublicUrl,
    rsPublicUrl: opts.rsPublicUrl,
    ignoreAmbient: ignoreAmbientPublicUrls,
  });
  const configuredAsPublicUrl = referenceTopology.asPublicUrl || null;
  const configuredAsIssuer =
    opts.asIssuer ||
    configuredAsPublicUrl ||
    (!ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null) ||
    null;
  const configuredRsPublicUrl = referenceTopology.rsPublicUrl || null;
  const runtimeContext = {
    rsUrl: configuredRsPublicUrl || null,
  };
  const controller = createController({
    asPublicUrl: configuredAsPublicUrl,
    ownerSubjectId: opts.ownerAuthSubjectId,
    connectorPathResolver: opts.connectorPathResolver,
    runtimeContext,
  });
  const asApp = buildAsApp({
    nativeManifest: nativeConfig?.nativeManifest || null,
    controller,
    providerName,
    dbPath: opts.dbPath || DB_PATH,
    enableDynamicClientRegistration: resolveDynamicClientRegistrationEnabled(opts),
    dynamicClientRegistrationInitialAccessTokens: resolveDynamicClientRegistrationInitialAccessTokens(opts),
    asPublicUrl: configuredAsPublicUrl,
    asIssuer: configuredAsIssuer,
    ignoreAmbientPublicUrls,
    ownerAuthPassword: opts.ownerAuthPassword,
    ownerAuthSubjectId: opts.ownerAuthSubjectId,
    ownerAuthForceSecureCookies: opts.ownerAuthForceSecureCookies,
    ownerAuthSameSite: opts.ownerAuthSameSite,
    referenceRevision: opts.referenceRevision,
    logger,
  });

  // opts.bindHost — restrict listening interface (e.g. '127.0.0.1'). Default
  // is undefined which lets Node bind to all interfaces. Passing '127.0.0.1'
  // keeps the server off the LAN/public internet.
  const bindHost = opts.bindHost;

  const asServer = await asApp.listen(requestedAsPort, bindHost);
  const asPort = asServer.address().port;
  const asPublicUrl = configuredAsPublicUrl || configuredAsIssuer || `http://localhost:${asPort}`;
  logger.info({ port: asPort, url: `http://localhost:${asPort}` }, 'authorization server listening');

  const rsApp = buildRsApp({
    asPort,
    nativeManifest: nativeConfig?.nativeManifest || null,
    providerName,
    asPublicUrl,
    asIssuer: configuredAsIssuer || asPublicUrl,
    rsPublicUrl: configuredRsPublicUrl,
    ignoreAmbientPublicUrls,
    logger,
    // Lexical retrieval extension knobs — see search.js + the metadata route.
    lexicalRetrievalSupported: opts.lexicalRetrievalSupported,
    lexicalRetrievalCapability: opts.lexicalRetrievalCapability,
    // Semantic retrieval experimental extension knobs — see search-semantic.js
    // + the metadata route. Forwarded verbatim so test harnesses and operator
    // configs reach both the route registration gate and the advertisement
    // builder.
    semanticRetrievalSupported: opts.semanticRetrievalSupported,
    semanticRetrievalCapability: opts.semanticRetrievalCapability,
    // Hybrid retrieval experimental extension knobs — see search-hybrid.js +
    // the metadata route. Forwarded verbatim so test harnesses and operator
    // configs reach both the route registration gate and the advertisement
    // builder.
    hybridRetrievalSupported: opts.hybridRetrievalSupported,
    hybridRetrievalCapability: opts.hybridRetrievalCapability,
    referenceRevision: opts.referenceRevision,
    agentDiscoveryOrigin: referenceTopology.browserOrigin,
  });
  const rsServer = await rsApp.listen(requestedRsPort, bindHost);
  const rsPort = rsServer.address().port;
  // Controller-managed runs are server-side work. Even in composed mode, they
  // should post ingest/state traffic directly to the local RS listener rather
  // than routing large NDJSON payloads through the browser-facing web origin.
  runtimeContext.rsUrl = `http://localhost:${rsPort}`;
  logger.info({ port: rsPort, url: `http://localhost:${rsPort}` }, 'resource server listening');
  const startupBackfillAbortController = new AbortController();
  const startupBackfillDone = scheduleRetrievalStartupBackfill({
    manifests: startupBackfillManifests,
    logger,
    signal: startupBackfillAbortController.signal,
  });
  if (opts.awaitStartupBackfill === true) {
    await startupBackfillDone;
  }
  return {
    asServer,
    rsServer,
    asPort,
    rsPort,
    logger,
    startupBackfillDone,
    abortStartupBackfill: (reason) => startupBackfillAbortController.abort(reason),
  };
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────
//
// Process-level handlers (uncaughtException, unhandledRejection, SIGTERM,
// SIGINT) live HERE, inside the CLI entrypoint block, not inside startServer.
// startServer is imported and called many times per process from the test
// harness (test/pdpp.test.js, test/provider-metadata.test.js); adding global
// listeners from the library surface would accumulate on every call and
// cross-contaminate tests. These handlers fire only when server/index.js is
// run directly as `node server/index.js`.
if (process.argv[1] && process.argv[1].endsWith('server/index.js')) {
  const cliLogger = buildLogger();
  let shuttingDown = false;
  let pipeWarnEmitted = false;

  const exitOnFatal = (reason) => (err) => {
    if (shuttingDown) return;
    shuttingDown = true;
    cliLogger.fatal({ err }, reason);
    // Flush stdout before exit so the fatal line reaches the terminal.
    process.nextTick(() => process.exit(1));
  };
  // Closed-pipe writes on the CLI's owned stdio (process.stdout /
  // process.stderr) are an operational condition — Docker Compose log
  // handoff and `node --watch` restart can both close those pipes
  // asynchronously while the AS/RS keeps serving requests. Downgrade
  // those errors to a single warn record and stay alive. Anything else
  // takes the existing fatal path so real programmer errors still crash
  // loudly. See:
  //   openspec/changes/harden-reference-runtime-reliability/design.md
  const handleUncaught = (err) => {
    if (isClosedPipeWriteError(err)) {
      if (!pipeWarnEmitted) {
        pipeWarnEmitted = true;
        try { cliLogger.warn({ err }, 'closed-pipe write on owned stdio downgraded'); }
        catch { /* warn emission may itself EPIPE; swallow once */ }
      }
      return;
    }
    exitOnFatal('uncaughtException')(err);
  };
  process.on('uncaughtException', handleUncaught);
  process.on('unhandledRejection', exitOnFatal('unhandledRejection'));

  const server = { asServer: null, rsServer: null, abortStartupBackfill: null, startupBackfillDone: null };
  const exitOnSignal = (signal) => async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    cliLogger.info({ signal }, 'shutdown signal received');
    // Close HTTP servers FIRST so in-flight handlers can finish their
    // SQLite writes (commit or rollback) before we release the DB
    // handle. Closing the DB underneath active handlers can leave a
    // mid-transaction lock visible to a sibling process (Docker dev
    // compose restarts via `node --watch`, so a new process may try to
    // re-acquire the WAL writer immediately after this one exits).
    const closeTimeout = (srv) => new Promise((resolve) => {
      if (!srv) { resolve(); return; }
      let done = false;
      let forceTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };
      forceTimer = setTimeout(() => {
        try { srv.closeAllConnections?.(); } catch {}
        finish();
      }, 2000);
      try { srv.closeIdleConnections?.(); } catch {}
      try { srv.close(finish); } catch { finish(); }
    });
    // Signal the startup retrieval backfill to wind down ALONGSIDE the
    // HTTP drain. Without this, a backfill mid-`upsertMany` keeps the
    // SQLite writer slot held while we proceed to `closeDb()`, and a
    // sibling process re-opening the same WAL DB (e.g. `node --watch`
    // restart, `docker compose restart reference`) sees a stale lock
    // and trips `SQLITE_BUSY database is locked`. The backfill loop
    // checks the abort flag between page transactions and at the
    // top of each connector iteration, so this releases on a clean
    // boundary. Bounded await with a 2s timeout matches the HTTP drain.
    try { server.abortStartupBackfill?.('shutdown'); } catch {}
    const backfillDeadline = new Promise((resolve) => setTimeout(resolve, 2000));
    const awaitBackfill = server.startupBackfillDone
      ? Promise.resolve(server.startupBackfillDone).catch(() => {})
      : Promise.resolve();
    await Promise.allSettled([
      closeTimeout(server.asServer),
      closeTimeout(server.rsServer),
      Promise.race([awaitBackfill, backfillDeadline]),
    ]);
    closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', exitOnSignal('SIGTERM'));
  process.on('SIGINT', exitOnSignal('SIGINT'));

  startServer({ logger: cliLogger }).then((result) => {
    server.asServer = result.asServer;
    server.rsServer = result.rsServer;
    server.abortStartupBackfill = result.abortStartupBackfill;
    server.startupBackfillDone = result.startupBackfillDone;
  }).catch(err => {
    closeDb();
    cliLogger.fatal({ err }, 'startup failed');
    process.nextTick(() => process.exit(1));
  });
}
