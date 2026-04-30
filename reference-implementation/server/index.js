/**
 * PDPP Personal Server
 *
 * Combined AS + RS implementing PDPP v0.1.0 core spec.
 * Starts on port 7662 (AS/introspection) and 7663 (RS query API).
 */
import { createHash } from 'node:crypto';

import { closeDb, getDb, initDb } from './db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  resolveStorageBackend,
} from './postgres-storage.js';
import {
  buildAuthorizationServerMetadata,
  buildHybridRetrievalCapability,
  buildLexicalRetrievalCapability,
  buildProtectedResourceMetadata,
  buildSemanticRetrievalCapability,
  isTrustedMetadataRequestOrigin,
  resolvePublicUrl,
  resolveSiblingPublicUrl,
  shouldUseDirectRequestOrigin,
  stripTrailingSlash,
} from './metadata.ts';
import { createTraceContext, emitSpineEvent, generateSpineId, listSpineCorrelations, listSpineEventsPage, searchSpine } from '../lib/spine.ts';
import { exec, getOne, InvalidCursorError, referenceQueries, transaction } from '../lib/db.ts';
import {
  registerConnector, getConnectorManifest, getConfiguredNativeManifest, getManifestForStorageBinding,
  introspect, revokeGrant,
  createConsentExchangeCode, consumeConsentExchangeCode,
  configureNativeManifest,
  deleteRegisteredClient, listOwnerIssuedClients, listRegisteredConnectorIds,
  registerDynamicClient, requireGrantContractAgainstManifest, requireResolvedPersistedGrantState, seedPreRegisteredClients,
  buildPendingConsentRequestUri,
} from './auth.js';
import { createBlobStore } from './stores/blob-store.js';
import { postgresPersistContentAddressedBlob } from './postgres-records.js';
import { createConsentStore } from './stores/consent-store.js';
import { createOwnerDeviceAuthStore } from './stores/owner-device-auth-store.js';
import {
  ingestRecord, queryRecords, aggregateRecords, getRecord, deleteRecord, deleteAllRecords,
  listStreams, listAllStreams, getSyncState, putSyncState,
  getDatasetRecordsAggregate, getDatasetRecordChangesBytes, getDatasetBlobBytes,
  getDatasetRecordTimeBounds, listDatasetTopConnectorCandidates,
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
import { registerInboxRoutes } from './inbox.js';
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
  collectRecordsTimelineEntries,
  getConnectorDetail,
  listConnectorSummaries,
  listPendingApprovals,
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
import { executeSchemaGet } from '../operations/rs-schema-get/index.ts';
import { executeStreamsList } from '../operations/rs-streams-list/index.ts';
import {
  StreamDetailVisibilityError,
  executeStreamDetail,
} from '../operations/rs-streams-detail/index.ts';
import {
  RecordsListVisibilityError,
  executeRecordsList,
} from '../operations/rs-records-list/index.ts';
import {
  RecordDetailVisibilityError,
  executeRecordDetail,
} from '../operations/rs-records-detail/index.ts';
import { executeRefDatasetSummary } from '../operations/ref-dataset-summary/index.ts';
import { executeRefConnectorsList } from '../operations/ref-connectors-list/index.ts';
import {
  RefConnectorDetailNotFoundError,
  executeRefConnectorDetail,
} from '../operations/ref-connectors-detail/index.ts';
import { executeRefApprovalsList } from '../operations/ref-approvals-list/index.ts';
import { executeRefSchedulesList } from '../operations/ref-schedules-list/index.ts';
import {
  RefConnectorScheduleGetNotFoundError,
  executeRefConnectorScheduleGet,
} from '../operations/ref-connector-schedule-get/index.ts';
import { executeRefSpineCorrelationsList } from '../operations/ref-spine-correlations-list/index.ts';
import { executeRefSpineEventsPage } from '../operations/ref-spine-events-page/index.ts';
import { executeRefSpineSearch } from '../operations/ref-spine-search/index.ts';
import { executeRefRecordsTimeline } from '../operations/ref-records-timeline/index.ts';
import {
  RefClientsListInvalidRequestError,
  executeRefClientsList,
} from '../operations/ref-clients-list/index.ts';
import { executeRefDeployment } from '../operations/ref-deployment/index.ts';
import { executeConnectorsList } from '../operations/rs-connectors-list/index.ts';
import { executeRsDiscoveryIndex } from '../operations/rs-discovery-index/index.ts';
import { executeRsProtectedResourceMetadata } from '../operations/rs-protected-resource-metadata/index.ts';
import { executeRsConnectorStateGet } from '../operations/rs-connector-state-get/index.ts';
import {
  RsConnectorStatePutValidationError,
  executeRsConnectorStatePut,
} from '../operations/rs-connector-state-put/index.ts';
import {
  StreamsAggregateVisibilityError,
  executeStreamsAggregate,
} from '../operations/rs-streams-aggregate/index.ts';
import {
  BlobsUploadInvalidRequestError,
  BlobsUploadStreamNotFoundError,
  executeBlobsUpload,
} from '../operations/rs-blobs-upload/index.ts';
import {
  BlobsReadNotFoundError,
  executeBlobsRead,
} from '../operations/rs-blobs-read/index.ts';
import {
  RecordsDeleteStreamInvalidRequestError,
  RecordsDeleteStreamNotFoundError,
  executeRecordsDeleteStream,
} from '../operations/rs-records-delete-stream/index.ts';
import {
  RecordsDeleteInvalidRequestError,
  RecordsDeleteNotFoundError,
  executeRecordsDelete,
} from '../operations/rs-records-delete/index.ts';
import {
  RecordsIngestInvalidRequestError,
  RecordsIngestNotFoundError,
  executeRecordsIngest,
  parseLines as parseIngestLines,
} from '../operations/rs-records-ingest/index.ts';
import { executeAsDiscoveryIndex } from '../operations/as-discovery-index/index.ts';
import { executeAsAuthorizationServerMetadata } from '../operations/as-authorization-server-metadata/index.ts';
import { executeAsDcrRegister } from '../operations/as-dcr-register/index.ts';
import { executeAsDcrDelete } from '../operations/as-dcr-delete/index.ts';
import { executeAsDeviceAuthInit } from '../operations/as-device-authorization-init/index.ts';
import { executeAsDeviceTokenExchange } from '../operations/as-device-token-exchange/index.ts';
import { executeAsDeviceDecision } from '../operations/as-device-decision/index.ts';
import { executeAsIntrospect } from '../operations/as-introspect/index.ts';
import { executeAsPolyfillConnectorRegister } from '../operations/as-polyfill-connector-register/index.ts';
import { executeAsPolyfillConnectorDetail } from '../operations/as-polyfill-connector-detail/index.ts';
import { executeAsParCreate } from '../operations/as-par-create/index.ts';
import { executeAsConsentDecision } from '../operations/as-consent-decision/index.ts';
import { executeAsConsentExchange } from '../operations/as-consent-exchange/index.ts';
import { executeAsGrantRevoke } from '../operations/as-grant-revoke/index.ts';

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

function rejectUntrustedMetadataHost(req, res, explicitUrl, trustedHosts, options = {}) {
  if (isTrustedMetadataRequestOrigin(req, explicitUrl, trustedHosts, options)) {
    return false;
  }
  pdppError(
    res,
    421,
    'misdirected_request',
    'Host-derived metadata requires a local/private request host or PDPP_TRUSTED_HOSTS allowlist',
  );
  return true;
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
    sourceDescriptor: connectorId ? buildSourceDescriptor({ kind: 'connector', id: connectorId }) : null,
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
    sourceDescriptor: connectorId ? buildSourceDescriptor({ kind: 'connector', id: connectorId }) : null,
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

// Spine timeline envelope assembly and live-bearer redaction live in the
// `ref.spine.events.page` operation; see
// reference-implementation/operations/ref-spine-events-page/index.ts.
// The host adapter still owns query-string parsing for `limit`/`cursor`
// (including the 400 error shape and the upper bound) because cursor
// validation is route-layer concern: an invalid cursor must short-circuit
// before any operation runs.

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
      source: { kind: 'provider_native', id: nativeManifest.provider_id },
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
    source: { kind: 'connector', id: connectorId },
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
  if (sourceBinding?.kind === 'provider_native' && sourceBinding.id) {
    return { kind: 'provider_native', id: sourceBinding.id };
  }
  if (sourceBinding?.kind === 'connector' && sourceBinding.id) {
    return { kind: 'connector', id: sourceBinding.id };
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
      ownerScope.source.kind === 'provider_native'
        ? `Unknown source: { kind: 'provider_native', id: '${ownerScope.source.id}' }`
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
    const err = source?.kind === 'provider_native'
      ? new Error(`Unknown source: { kind: 'provider_native', id: '${source.id}' }`)
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
  const connectorId = source?.kind === 'connector' ? source.id : null;
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
  const connectorId = source?.kind === 'connector' ? source.id : null;
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

function persistContentAddressedBlob({ connectorId, stream, recordKey, mimeType, data }) {
  if (isPostgresStorageBackend()) {
    return postgresPersistContentAddressedBlob({ connectorId, stream, recordKey, mimeType, data });
  }

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

// ─── AS App ─────────────────────────────────────────────────────────────────

function buildAsApp(opts = {}) {
  const app = createApp({ logger: opts.logger });
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  const referenceRevision = resolveReferenceRevision(opts);
  const controller = opts.controller || null;
  const consentStore = createConsentStore();
  const ownerDeviceAuthStore = createOwnerDeviceAuthStore();
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
  // Discovery-index envelope semantics live in the canonical
  // `as.discovery.index` operation (operations/as-discovery-index). This
  // route is an Express host adapter: it owns request-id/header wiring and
  // response writing; the operation owns the envelope shape.
  app.get('/', { contract: 'getAsDiscoveryIndex' }, (req, res) => {
    res.json(
      executeAsDiscoveryIndex({
        providerName,
        referenceRevision,
      }),
    );
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
    const sourceLabel = sourceBinding?.id || 'this source';
    const sourceFactLabel = sourceBinding?.kind === 'provider_native' ? 'Provider' : 'Connector';

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
      sourceBinding?.id ? { label: sourceFactLabel, value: sourceBinding.id } : null,
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
    const deviceCode = consentStore.parseRequestUri(requestUri);
    if (!deviceCode) return { deviceCode: null, pending: null };
    const pending = await consentStore.getPendingConsentByDeviceCode(deviceCode);
    return { deviceCode, pending };
  }

  // RFC 8414 authorization-server metadata. The metadata-document envelope
  // lives in the canonical `as.authorization_server.metadata` operation
  // (operations/as-authorization-server-metadata). The host adapter resolves
  // the public issuer URL from explicit opts or ambient env, and supplies
  // the metadata-builder dependency.
  app.get('/.well-known/oauth-authorization-server', { contract: 'getAuthorizationServerMetadata' }, (req, res) => {
    const explicitIssuer = opts.asIssuer || opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null);
    if (rejectUntrustedMetadataHost(req, res, explicitIssuer, opts.trustedMetadataHosts)) {
      return;
    }
    const issuer = resolvePublicUrl(req, explicitIssuer);
    res.json(
      executeAsAuthorizationServerMetadata(
        { issuer, dynamicClientRegistrationEnabled },
        { buildAuthorizationServerMetadata },
      ),
    );
  });

  // DCR register semantics (input sanitization, extra metadata derivation,
  // success/failure spine-event data shapes, HTTP status mapping) live in
  // the canonical `as.dcr.register` operation (operations/as-dcr-register).
  // The host adapter owns trace-context emission, owner-session resolution,
  // request-id/trace-id headers, spine-event dispatch, and response writing.
  app.post('/oauth/register', { contract: 'registerDynamicClient' }, async (req, res) => {
    const traceContext = createTraceContext();
    res.setHeader('Request-Id', traceContext.request_id);
    setReferenceTraceId(res, traceContext.trace_id);

    const ownerSession = ownerAuth.readOwnerSession(req);
    const outcome = await executeAsDcrRegister(
      {
        body: req.body,
        authorizationHeader: req.headers.authorization || null,
        dcrEnabled: dynamicClientRegistrationEnabled,
        initialAccessTokens: dynamicClientRegistrationInitialAccessTokens,
        ownerSessionSubjectId: ownerSession?.sub || null,
      },
      { registerDynamicClient },
    );

    if (outcome.outcome === 'success') {
      await emitSpineEvent({
        event_type: 'client.registered',
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        request_id: traceContext.request_id,
        actor_type: 'client',
        actor_id: outcome.registered.client_id,
        object_type: 'client',
        object_id: outcome.registered.client_id,
        status: 'succeeded',
        client_id: outcome.registered.client_id,
        data: outcome.spineData,
      });
      return res.status(outcome.status).json(outcome.registered);
    }

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
      data: outcome.spineData,
    });
    oauthError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  });

  // RFC 7592 client deletion. Owner-session-gated rather than registration-
  // access-token-gated by deliberate design choice — see the rationale in
  // openspec/changes/dcr-per-owner-token-with-revoke/design.md. Cascades to
  // revoke every active grant tied to the client; refuses pre-registered
  // clients and cross-operator deletes. Idempotent: a second call returns
  // 404 not_found.
  // DCR delete semantics (cascading delete + typed error → status mapping)
  // live in the canonical `as.dcr.delete` operation
  // (operations/as-dcr-delete). The host adapter owns owner-session
  // enforcement, request-id/trace-id headers, and response writing.
  app.delete('/oauth/register/:clientId', ownerAuth.requireOwnerSession, async (req, res) => {
    const traceContext = createTraceContext();
    res.setHeader('Request-Id', traceContext.request_id);
    setReferenceTraceId(res, traceContext.trace_id);
    const outcome = await executeAsDcrDelete(
      {
        clientId: decodeURIComponent(req.params.clientId),
        actingSubjectId:
          req.ownerSession?.sub || ownerAuth.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID,
        requestId: traceContext.request_id,
        traceId: traceContext.trace_id,
      },
      { deleteRegisteredClient },
    );
    if (outcome.outcome === 'success') {
      return res.status(outcome.status).end();
    }
    pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  });

  // Device-authorization initiation semantics (client_id presence
  // validation, store call, trace_context-stripped public envelope) live
  // in the canonical `as.device.authorization.init` operation
  // (operations/as-device-authorization-init).
  app.post('/oauth/device_authorization', { contract: 'startOwnerDeviceAuthorization' }, async (req, res) => {
    const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
    const outcome = await executeAsDeviceAuthInit(
      {
        clientId: req.body?.client_id,
        baseUrl: resolvePublicUrl(req, explicitBaseUrl),
      },
      {
        initiate: (clientId, opts2) => ownerDeviceAuthStore.initiate(clientId, opts2),
      },
    );
    if (outcome.outcome === 'success') {
      if (outcome.traceContext?.request_id) {
        res.setHeader('Request-Id', outcome.traceContext.request_id);
      }
      if (outcome.traceContext?.trace_id) {
        setReferenceTraceId(res, outcome.traceContext.trace_id);
      }
      return res.status(outcome.status).json(outcome.publicResult);
    }
    if (outcome.requestId) {
      res.setHeader('Request-Id', outcome.requestId);
    }
    if (outcome.traceId) {
      setReferenceTraceId(res, outcome.traceId);
    }
    oauthError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  });

  // Device-code token-exchange semantics (grant-type allowlist, store
  // call, RFC 8628 client-fault → 400 mapping, trace_context propagation)
  // live in the canonical `as.device.token.exchange` operation
  // (operations/as-device-token-exchange).
  app.post('/oauth/token', { contract: 'exchangeOwnerDeviceToken' }, async (req, res) => {
    const outcome = await executeAsDeviceTokenExchange(
      {
        grantType: req.body?.grant_type,
        clientId: req.body?.client_id,
        deviceCode: req.body?.device_code,
      },
      {
        exchangeDeviceCode: (args) => ownerDeviceAuthStore.exchangeDeviceCode(args),
      },
    );
    if (outcome.outcome === 'success') {
      if (outcome.traceContext?.request_id) {
        res.setHeader('Request-Id', outcome.traceContext.request_id);
      }
      if (outcome.traceContext?.trace_id) {
        setReferenceTraceId(res, outcome.traceContext.trace_id);
      }
      return res.status(outcome.status).json(outcome.publicResult);
    }
    if (outcome.requestId) {
      res.setHeader('Request-Id', outcome.requestId);
    }
    if (outcome.traceId) {
      setReferenceTraceId(res, outcome.traceId);
    }
    oauthError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  });

  app.get('/device', ownerAuth.requireOwnerSession, async (req, res) => {
    const userCode = typeof req.query.user_code === 'string' ? req.query.user_code : '';
    const pending = userCode ? await ownerDeviceAuthStore.getByUserCode(userCode) : null;

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

  // Device approve/deny decision semantics (approval_id → user_code
  // resolution behind the owner-session + CSRF gate, store call, error
  // mapping) live in the canonical `as.device.decision` operation
  // (operations/as-device-decision). The host adapter owns owner-session
  // + CSRF enforcement, subject-id resolution, and the hosted-UI HTML
  // result rendering.
  function buildDeviceDecisionDeps() {
    return {
      getByApprovalId: (approvalId) => ownerDeviceAuthStore.getByApprovalId(approvalId),
      approve: (userCode, subjectId) => ownerDeviceAuthStore.approve(userCode, subjectId),
      deny: (userCode, subjectId) => ownerDeviceAuthStore.deny(userCode, subjectId),
    };
  }

  app.post('/device/approve', ownerAuth.requireOwnerSession, ownerAuth.requireCsrf, async (req, res) => {
    const subjectId = ownerAuth.enabled
      ? ownerAuth.subjectId
      : (req.body?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID);
    const outcome = await executeAsDeviceDecision(
      {
        action: 'approve',
        userCode: req.body?.user_code,
        approvalId: req.body?.approval_id,
        subjectId,
      },
      buildDeviceDecisionDeps(),
    );
    if (outcome.outcome === 'success') {
      return res.send(renderHostedDocument({
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
    }
    if (outcome.requestId) {
      res.setHeader('Request-Id', outcome.requestId);
    }
    if (outcome.traceId) {
      setReferenceTraceId(res, outcome.traceId);
    }
    oauthError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  });

  app.post('/device/deny', ownerAuth.requireOwnerSession, ownerAuth.requireCsrf, async (req, res) => {
    const subjectId = ownerAuth.enabled
      ? ownerAuth.subjectId
      : (req.body?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID);
    const outcome = await executeAsDeviceDecision(
      {
        action: 'deny',
        userCode: req.body?.user_code,
        approvalId: req.body?.approval_id,
        subjectId,
      },
      buildDeviceDecisionDeps(),
    );
    if (outcome.outcome === 'success') {
      return res.send(renderHostedDocument({
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
    }
    if (outcome.requestId) {
      res.setHeader('Request-Id', outcome.requestId);
    }
    if (outcome.traceId) {
      setReferenceTraceId(res, outcome.traceId);
    }
    oauthError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  });

  // RFC 7662-style token introspection with PDPP extensions. Token-presence
  // validation and the AS-internal `grant_storage_binding` redaction live
  // in the canonical `as.introspect` operation (operations/as-introspect).
  app.post('/introspect', { contract: 'introspectToken' }, async (req, res) => {
    const outcome = await executeAsIntrospect(
      { token: req.body?.token },
      { introspect },
    );
    if (outcome.outcome === 'success') {
      return res.json(outcome.publicInfo);
    }
    pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
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
      sourceKind: query.source_kind,
      sourceId: query.source_id,
      grantId: query.grant_id,
      q: query.q,
    };
  }

  // Spine correlation list / timeline / search routes delegate envelope
  // assembly to canonical operation modules. The host adapter retains
  // ownership of owner-auth, query-string parsing, cursor validation
  // (`InvalidCursorError` → 400), 404-on-empty-first-page, and contract
  // metadata; the operation owns response shape (per-kind discriminators,
  // pagination fields, and live-bearer redaction on timelines). See
  // openspec/changes/mount-ref-spine-operations.

  const spineCorrelationsListDeps = {
    listSpineCorrelations: (kind, filters) => listSpineCorrelations(kind, filters),
  };

  app.get('/_ref/traces', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const envelope = await executeRefSpineCorrelationsList(
        { kind: 'trace', filters: parseListFilters(req.query) },
        spineCorrelationsListDeps,
      );
      res.json(envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/grants', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const envelope = await executeRefSpineCorrelationsList(
        { kind: 'grant', filters: parseListFilters(req.query) },
        spineCorrelationsListDeps,
      );
      res.json(envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/runs', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const envelope = await executeRefSpineCorrelationsList(
        { kind: 'run', filters: parseListFilters(req.query) },
        spineCorrelationsListDeps,
      );
      res.json(envelope);
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
      const envelope = await executeRefSpineSearch(
        { query: req.query.q || '' },
        { searchSpine: (query) => searchSpine(query) },
      );
      res.json(envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  function handleSpineTimeline(kind, idParamKey, notFoundMessage) {
    return async (req, res) => {
      try {
        const id = decodeURIComponent(req.params[idParamKey]);
        const opts = parseTimelinePageOptions(req, res);
        if (!opts) return;
        const page = await listSpineEventsPage(kind, id, opts);
        if (!page.events.length && !opts.cursor) {
          return pdppError(res, 404, 'not_found', notFoundMessage);
        }
        const envelope = executeRefSpineEventsPage({
          kind,
          id,
          cursor: opts.cursor,
          page,
        });
        res.json(envelope);
      } catch (err) {
        if (err instanceof InvalidCursorError) {
          return pdppError(res, 400, 'invalid_cursor', err.message, 'cursor');
        }
        handleError(res, err);
      }
    };
  }

  app.get(
    '/_ref/traces/:traceId',
    ownerAuth.requireOwnerSession,
    handleSpineTimeline('trace', 'traceId', 'Trace not found'),
  );

  app.get(
    '/_ref/grants/:grantId/timeline',
    ownerAuth.requireOwnerSession,
    handleSpineTimeline('grant', 'grantId', 'Grant timeline not found'),
  );

  app.get(
    '/_ref/runs/:runId/timeline',
    ownerAuth.requireOwnerSession,
    handleSpineTimeline('run', 'runId', 'Run timeline not found'),
  );

  registerInboxRoutes(app, { controller, ownerAuth, pdppError, handleError });

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

  // Reference-only dataset summary for the operator-console hero band. Envelope
  // assembly lives in the canonical `ref.dataset.summary` operation
  // (operations/ref-dataset-summary). This route is a Fastify host adapter:
  // it owns owner auth and response writing, and wires native capability
  // helpers (split out of the previous `getDatasetSummary` in
  // server/records.js) into the operation's dependency contract. Not a PDPP
  // protocol surface — `record_json_bytes` remains an adapter-native operator
  // diagnostic per `define-reference-operation-environments` contract
  // correction (4); the operation preserves that constraint.
  app.get('/_ref/dataset/summary', { contract: 'refDatasetSummary' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      // Cache the records aggregate so `record_count` and `*_ingested_at`
      // come from the same SQL snapshot — the operation calls `getCounts`
      // and `getIngestedTimeBounds` independently, but the previous native
      // helper used one aggregate row for both.
      let cachedAggregate = null;
      const aggregate = async () => {
        if (cachedAggregate === null) {
          cachedAggregate = await getDatasetRecordsAggregate();
        }
        return cachedAggregate;
      };

      const summary = await executeRefDatasetSummary({
        getCounts: async () => {
          const agg = await aggregate();
          return {
            connector_count: agg.connector_count,
            stream_count: agg.stream_count,
            record_count: agg.record_count,
          };
        },
        getRetainedBytes: async () => {
          const [agg, recordChangesJsonBytes, blobBytes] = await Promise.all([
            aggregate(),
            getDatasetRecordChangesBytes(),
            getDatasetBlobBytes(),
          ]);
          return {
            record_json_bytes: agg.record_json_bytes,
            record_changes_json_bytes: recordChangesJsonBytes,
            blob_bytes: blobBytes,
          };
        },
        getRecordTimeBounds: () => getDatasetRecordTimeBounds(),
        getIngestedTimeBounds: async () => {
          const agg = await aggregate();
          return {
            earliest: agg.earliest_ingested_at,
            latest: agg.latest_ingested_at,
          };
        },
        listTopConnectorCandidates: () => listDatasetTopConnectorCandidates(),
      });
      res.json(summary);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Reference-only connector catalog list. Envelope assembly lives in the
  // canonical `ref.connectors.list` operation; this route owns owner auth,
  // response writing, and dependency wiring (the substrate read still lives
  // in `server/ref-control.ts`).
  app.get('/_ref/connectors', { contract: 'refListConnectors' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const envelope = await executeRefConnectorsList({
        listConnectorSummaries: () => listConnectorSummaries(controller),
      });
      res.json(envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Reference-only connector detail. The canonical `ref.connectors.detail`
  // operation owns the `ref_connector_detail` envelope discriminator and
  // the not-found mapping; the host adapter translates host-internal
  // `RefControlError`s into the same `not_found` / `connector_invalid`
  // shape the route exposed before mount.
  app.get('/_ref/connectors/:connectorId', { contract: 'refGetConnector' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const connectorId = decodeURIComponent(req.params.connectorId);
      const envelope = await executeRefConnectorDetail(
        { connectorId },
        {
          getConnectorDetail: async (id) => {
            try {
              const detail = await getConnectorDetail(id, controller);
              if (!detail) {
                return null;
              }
              const { object: _ignored, ...rest } = detail;
              return rest;
            } catch (err) {
              if (err && err.code === 'not_found') {
                return null;
              }
              throw err;
            }
          },
        },
      );
      res.json(envelope);
    } catch (err) {
      if (err instanceof RefConnectorDetailNotFoundError) {
        const wrapped = new Error(err.message);
        wrapped.code = 'not_found';
        handleError(res, wrapped);
        return;
      }
      handleError(res, err);
    }
  });

  // Reference-only pending approvals queue. The canonical
  // `ref.approvals.list` operation owns the `{object: 'list', data}`
  // envelope, the created-at-descending sort across both kinds, and the
  // `request_uri` / `user_code` redaction invariant. The host adapter
  // owns owner auth and response writing; the substrate composition
  // (consents + owner-device flows) still lives in `server/ref-control.ts`.
  app.get('/_ref/approvals', { contract: 'refListApprovals' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const envelope = await executeRefApprovalsList({
        listPendingApprovals: () => listPendingApprovals(),
      });
      res.json(envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Reference-only timeline view. The canonical `ref.records.timeline`
  // operation owns input normalization, the final `data` slice to the
  // effective limit, and the `{object: 'list', data, meta}` envelope.
  // The host adapter still owns owner auth and response writing, and
  // wires the substrate read (`collectRecordsTimelineEntries`) behind
  // the capability so the operation never touches the SQLite handle or
  // manifest store directly.
  app.get('/_ref/records/timeline', { contract: 'refRecordsTimeline' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const limit = req.query.limit == null ? null : Number.parseInt(String(req.query.limit), 10);
      const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
      const envelope = await executeRefRecordsTimeline(
        {
          connectorId,
          stream: typeof req.query.stream === 'string' ? req.query.stream : null,
          since: typeof req.query.since === 'string' ? req.query.since : null,
          until: typeof req.query.until === 'string' ? req.query.until : null,
          limit: Number.isFinite(limit) ? limit : null,
          order: req.query.order,
          timestampMode: req.query.timestamp_mode,
        },
        {
          collectEntries: (input) => collectRecordsTimelineEntries(input),
        },
      );
      res.json(envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Reference-only schedule listing. The canonical `ref.schedules.list`
  // operation owns the `{object: 'list', data}` envelope; the host adapter
  // owns owner auth and response writing only. Schedule reads flow through
  // the controller's capability-shaped `listSchedules` so the operation
  // never sees the runtime controller or scheduler store directly.
  app.get('/_ref/schedules', { contract: 'refListSchedules' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const envelope = await executeRefSchedulesList({
        listSchedules: async () => (controller ? await controller.listSchedules() : []),
      });
      res.json(envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Reference-only per-connector schedule view. The canonical
  // `ref.connector-schedule.get` operation owns the success projection and
  // the typed not-found failure shape; the host adapter translates the
  // typed error into the existing PDPP 404 `not_found` envelope.
  app.get('/_ref/connectors/:connectorId/schedule', ownerAuth.requireOwnerSession, async (req, res) => {
    const connectorId = decodeURIComponent(req.params.connectorId);
    try {
      const schedule = await executeRefConnectorScheduleGet(
        { connectorId },
        {
          getConnectorSchedule: async (id) => (controller ? await controller.getSchedule(id) : null),
        },
      );
      res.json(schedule);
    } catch (err) {
      if (err instanceof RefConnectorScheduleGetNotFoundError) {
        return pdppError(res, 404, 'not_found', err.message);
      }
      handleError(res, err);
    }
  });

  // /_ref/deployment — reference operator diagnostics. Not a PDPP protocol
  // surface; the dashboard's /dashboard/deployment page reads this. The
  // canonical `ref.deployment` operation owns the public envelope and a
  // defensive env-redaction invariant; the host wires
  // `collectDeploymentDiagnostics` (which performs the actual redaction
  // against the strict allowlist) behind the diagnostic capability so the
  // operation never imports the substrate helper or `process`.
  app.get('/_ref/deployment', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const report = await executeRefDeployment({
        collectDeploymentReport: () => collectDeploymentDiagnostics(
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
        ),
      });
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
  // Operator-issued client listing. The canonical `ref.clients.list`
  // operation owns the `?owner=true` request requirement (typed
  // `RefClientsListInvalidRequestError` translated to the PDPP
  // 400 `invalid_request` envelope) and the `{object: 'list', data}`
  // envelope. The host adapter still owns owner auth and per-operator
  // subject scoping: `listOwnerIssuedClients` is called with the
  // requesting owner-session subject so pre-registered seeds never
  // appear here. See openspec/changes/dcr-per-owner-token-with-revoke/.
  app.get('/_ref/clients', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const subjectId = req.ownerSession?.sub || ownerAuth.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID;
      const envelope = await executeRefClientsList(
        { owner: req.query?.owner },
        {
          listOwnerIssuedClients: () => listOwnerIssuedClients(subjectId),
        },
      );
      res.json(envelope);
    } catch (err) {
      if (err instanceof RefClientsListInvalidRequestError) {
        return pdppError(res, 400, 'invalid_request', err.message);
      }
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
    // Polyfill-only connector registry: register/detail semantics live in
    // the canonical operations (operations/as-polyfill-connector-register
    // and operations/as-polyfill-connector-detail). The host adapter owns
    // Express plumbing, native-mode mounting, URL decoding, and response
    // writing.
    app.post('/connectors', async (req, res) => {
      try {
        const outcome = await executeAsPolyfillConnectorRegister(
          { manifest: req.body },
          { registerConnector },
        );
        if (outcome.outcome === 'success') {
          return res.status(outcome.status).json(outcome.envelope);
        }
        pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
      } catch (err) {
        handleError(res, err);
      }
    });

    app.get('/connectors/:connectorId', async (req, res) => {
      try {
        const outcome = await executeAsPolyfillConnectorDetail(
          { connectorId: decodeURIComponent(req.params.connectorId) },
          { getConnectorManifest },
        );
        if (outcome.outcome === 'success') {
          return res.json(outcome.envelope);
        }
        pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
      } catch (err) {
        handleError(res, err);
      }
    });
  }

  // RFC 9126-style PAR envelope semantics live in the canonical
  // `as.par.create` operation (operations/as-par-create). The host adapter
  // owns base-URL resolution from explicit opts or ambient env, native
  // manifest resolution, header propagation, and response writing.
  app.post('/oauth/par', { contract: 'createPushedAuthorizationRequest' }, async (req, res) => {
    try {
      const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
      const output = await executeAsParCreate(
        {
          body: req.body,
          baseUrl: resolvePublicUrl(req, explicitBaseUrl),
          nativeManifest: resolveNativeManifest(opts),
        },
        {
          initiateGrant: (body, opts2) => consentStore.initiateGrant(body, opts2),
        },
      );
      if (output.traceContext?.request_id) {
        res.setHeader('Request-Id', output.traceContext.request_id);
      }
      if (output.traceContext?.trace_id) {
        setReferenceTraceId(res, output.traceContext.trace_id);
      }
      res.status(output.status).json(output.envelope);
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


  // Consent approve/deny decision semantics (approval_id → request_uri
  // resolution, deviceCode resolution, store call, error mapping) live
  // in the canonical `as.consent.decision` operation
  // (operations/as-consent-decision). The host adapter owns owner-session
  // + CSRF enforcement, subject-id resolution, content negotiation
  // between the JSON and HTML approve branches, exchange-code minting,
  // and HTML rendering.
  function buildConsentDecisionDeps() {
    return {
      getPendingConsentByApprovalId: (id) => consentStore.getPendingConsentByApprovalId(id),
      buildPendingConsentRequestUri: (deviceCode) => buildPendingConsentRequestUri(deviceCode),
      getPendingFromRequestUri: (uri) => getPendingGrantFromRequestUri(uri),
      approveGrant: (deviceCode, subjectId, opts2) => consentStore.approveGrant(deviceCode, subjectId, opts2),
      denyGrant: (deviceCode) => consentStore.denyGrant(deviceCode),
    };
  }

  app.post('/consent/approve', { contract: 'approveConsent' }, ownerAuth.requireOwnerSession, ownerAuth.requireCsrf, async (req, res) => {
    try {
      const subjectId = ownerAuth.enabled
        ? ownerAuth.subjectId
        : (req.body?.subject_id || req.query?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID);
      const outcome = await executeAsConsentDecision(
        {
          action: 'approve',
          requestUri: req.body?.request_uri || req.query?.request_uri,
          approvalId: req.body?.approval_id || req.query?.approval_id,
          subjectId,
          approveOptions: { ai_training_consented: req.body?.ai_training_consented },
        },
        buildConsentDecisionDeps(),
      );
      if (outcome.outcome === 'failure') {
        return pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
      }
      if (outcome.traceContext?.request_id) {
        res.setHeader('Request-Id', outcome.traceContext.request_id);
      }
      if (outcome.traceContext?.trace_id) {
        setReferenceTraceId(res, outcome.traceContext.trace_id);
      }
      const { grant, token } = outcome;
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
      const subjectId = ownerAuth.enabled
        ? ownerAuth.subjectId
        : (req.body?.subject_id || req.query?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID);
      const outcome = await executeAsConsentDecision(
        {
          action: 'deny',
          requestUri: req.body?.request_uri || req.query?.request_uri,
          approvalId: req.body?.approval_id || req.query?.approval_id,
          subjectId,
        },
        buildConsentDecisionDeps(),
      );
      if (outcome.outcome === 'failure') {
        return pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
      }
      if (outcome.traceContext?.request_id) {
        res.setHeader('Request-Id', outcome.traceContext.request_id);
      }
      if (outcome.traceContext?.trace_id) {
        setReferenceTraceId(res, outcome.traceContext.trace_id);
      }
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
  // Consent-exchange-code redemption semantics live in the canonical
  // `as.consent.exchange` operation (operations/as-consent-exchange).
  app.post('/consent/exchange', { contract: 'exchangeConsentCode' }, async (req, res) => {
    try {
      const outcome = await executeAsConsentExchange(
        { code: typeof req.body?.code === 'string' ? req.body.code : null },
        { consumeConsentExchangeCode },
      );
      if (outcome.outcome === 'success') {
        return res.json(outcome.envelope);
      }
      pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
    } catch (err) {
      handleError(res, err);
    }
  });


  // Grant-revocation envelope semantics live in the canonical
  // `as.grant.revoke` operation (operations/as-grant-revoke). The host
  // adapter owns Express plumbing, owner/client revoke authorization
  // (`requireRevokeAuth`), request-id ensure, error mapping via
  // `handleError`, and response writing.
  app.post('/grants/:grantId/revoke', { contract: 'revokeGrant' }, requireRevokeAuth, async (req, res) => {
    try {
      const requestId = ensureRequestId(res);
      const output = await executeAsGrantRevoke(
        { grantId: req.params.grantId, requestId },
        { revokeGrant },
      );
      if (output.traceId) {
        setReferenceTraceId(res, output.traceId);
      }
      res.json(output.envelope);
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
    const { envelope } = executeRsDiscoveryIndex({
      providerName,
      referenceRevision,
    });
    res.json(envelope);
  });

  // Primary reference surface: RFC 9728 protected-resource metadata.
  app.get('/.well-known/oauth-protected-resource', { contract: 'getProtectedResourceMetadata' }, (req, res) => {
    const explicitResource = opts.rsPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.RS_PUBLIC_URL : null);
    if (rejectUntrustedMetadataHost(req, res, explicitResource, opts.trustedMetadataHosts)) {
      return;
    }
    const resource = resolvePublicUrl(req, explicitResource);
    const explicitIssuer = opts.asIssuer || opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null);
    const fallbackIssuer = `${req.protocol}://${req.hostname}:${opts.asPort || AS_PORT}`;
    const issuerUsesDirectRequestOrigin = shouldUseDirectRequestOrigin(req, explicitIssuer);
    const issuerSource = issuerUsesDirectRequestOrigin ? fallbackIssuer : explicitIssuer || fallbackIssuer;
    if (
      rejectUntrustedMetadataHost(req, res, issuerSource, opts.trustedMetadataHosts, {
        forceHostDerived: issuerUsesDirectRequestOrigin || !explicitIssuer,
      })
    ) {
      return;
    }
    const issuer = resolvePublicUrl(req, issuerSource);

    // Composition (which capabilities to publish, which discovery hints to
    // include) is owned by the canonical `rs.protected-resource-metadata`
    // operation. The host adapter resolves URLs and live capability shapes
    // (e.g. `buildSemanticRetrievalCapability` against the live embedding
    // backend) and passes them through dependency callbacks. Truthfulness
    // rules — semantic only when backend is available; hybrid only when both
    // lexical AND semantic are supported — are encoded inside the operation.
    // See:
    //   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
    //   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
    //   openspec/changes/define-hybrid-retrieval/specs/hybrid-retrieval/spec.md
    //   openspec/changes/polish-reference-api-discovery-seams
    const { composition } = executeRsProtectedResourceMetadata(
      {},
      {
        resolveLexicalCapability: () => {
          if (opts.lexicalRetrievalCapability) {
            return opts.lexicalRetrievalCapability;
          }
          if (opts.lexicalRetrievalSupported !== false) {
            return buildLexicalRetrievalCapability();
          }
          return null;
        },
        resolveSemanticCapability: () => {
          if (opts.semanticRetrievalCapability) {
            return opts.semanticRetrievalCapability;
          }
          if (opts.semanticRetrievalSupported === false) return null;
          const semBackend = getSemanticBackend();
          if (!semBackend || !semBackend.available()) return null;
          return (
            buildSemanticRetrievalCapability({
              model: semBackend.model(),
              dimensions: semBackend.dimensions(),
              distanceMetric: semBackend.distanceMetric(),
              indexState: computeSemanticIndexState(),
              profileId: semBackend.profileId ? semBackend.profileId() : null,
              dtype: semBackend.dtype ? semBackend.dtype() : null,
              languageBias: semBackend.languageBias ? semBackend.languageBias() : null,
            }) || null
          );
        },
        resolveHybridCapabilityOverride: () =>
          opts.hybridRetrievalCapability || null,
        buildDefaultHybridCapability: ({ lexicalAvailable, semanticAvailable }) =>
          buildHybridRetrievalCapability({ lexicalAvailable, semanticAvailable }),
        isHybridSuppressed: () => opts.hybridRetrievalSupported === false,
        isNativeSingleSourceMode: () => !!resolveNativeManifest(opts),
      },
    );
    const { capabilities, discoveryHints } = composition;

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
  // Connector-list semantics live in the canonical `rs.connectors.list`
  // operation (operations/rs-connectors-list). This route is a Fastify host
  // adapter: it owns auth, request id / trace id, manifest/grant/storage-
  // binding resolution, instrumentation events, and response writing; it MUST
  // NOT recompute the envelope shape or the disclosure totals locally.
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

      let operationInput;
      let dependencies;
      if (tokenInfo.pdpp_token_kind === 'owner') {
        operationInput = {
          actor: { kind: 'owner', subject_id: tokenInfo.subject_id || null },
        };
        const nativeManifest = resolveNativeManifest(opts);
        const nativeStorageBinding = resolveNativeStorageBinding(opts);
        if (nativeManifest && nativeStorageBinding) {
          const source = buildSourceDescriptor({
            kind: 'provider_native',
            id: nativeManifest.provider_id,
          });
          queryContext.sourceDescriptor = source;
          dependencies = {
            getSourceDescriptor: () => source,
            listConnectorItems: async () => {
              const item = await buildConnectorDiscoveryItem({
                source,
                storageBinding: nativeStorageBinding,
                manifest: nativeManifest,
              });
              return [item];
            },
          };
        } else {
          // Multiple registered connectors: no single source descriptor; the
          // disclosure event has historically emitted `source: null` for this
          // branch. The operation propagates `null` through verbatim.
          dependencies = {
            getSourceDescriptor: () => null,
            listConnectorItems: async () => {
              const connectorIds = await listRegisteredConnectorIds();
              return Promise.all(connectorIds.map(async (connectorId) => {
                const manifest = await resolveRegisteredConnectorManifest(connectorId);
                return buildConnectorDiscoveryItem({
                  source: buildSourceDescriptor({ kind: 'connector', id: connectorId }),
                  storageBinding: { connector_id: connectorId },
                  manifest,
                });
              }));
            },
          };
        }
      } else {
        operationInput = {
          actor: {
            kind: 'client',
            subject_id: tokenInfo.subject_id || null,
            client_id: tokenInfo.client_id || null,
            grant_id: tokenInfo.grant_id || null,
          },
        };
        // Eagerly resolve the grant so the rejected-query path has the
        // correct source descriptor even if connector-item assembly throws.
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        const source = grantResolved.source;
        queryContext.sourceDescriptor = source;
        dependencies = {
          getSourceDescriptor: () => source,
          listConnectorItems: async () => {
            const item = await buildConnectorDiscoveryItem({
              source,
              storageBinding: grantResolved.storageBinding,
              manifest: grantResolved.manifest,
              grant: tokenInfo.grant,
            });
            return [item];
          },
        };
      }

      const result = await executeConnectorsList(operationInput, dependencies);

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
          source: result.sourceDescriptor,
          query_shape: 'connector_list',
          connector_count: result.disclosureTotals.connector_count,
          stream_count: result.disclosureTotals.stream_count,
        },
      });

      res.json(result.envelope);
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/schema — one-shot capability/schema discovery for the bearer
  // Schema-discovery semantics live in the canonical `rs.schema.get`
  // operation (operations/rs-schema-get). This route is a Fastify host
  // adapter: it owns auth, request id / trace id, source-descriptor / manifest
  // / grant resolution wiring, instrumentation events, and response writing;
  // it MUST NOT recompute schema-discovery rules or bearer projection
  // locally.
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

      let operationInput;
      let dependencies;
      if (tokenInfo.pdpp_token_kind === 'owner') {
        operationInput = {
          actor: { kind: 'owner', subject_id: tokenInfo.subject_id || null },
        };
        const nativeManifest = resolveNativeManifest(opts);
        const nativeStorageBinding = resolveNativeStorageBinding(opts);
        if (nativeManifest && nativeStorageBinding) {
          const source = buildSourceDescriptor({
            kind: 'provider_native',
            id: nativeManifest.provider_id,
          });
          queryContext.sourceDescriptor = source;
          dependencies = {
            getSourceDescriptor: () => source,
            listConnectorItems: async () => {
              const item = await buildConnectorSchemaItem({
                source,
                storageBinding: nativeStorageBinding,
                manifest: nativeManifest,
              });
              return [item];
            },
          };
        } else {
          // Multiple registered connectors: no single source descriptor, the
          // disclosure event has historically emitted `source: null` for this
          // branch. Operation propagates `null` through verbatim.
          dependencies = {
            getSourceDescriptor: () => null,
            listConnectorItems: async () => {
              const connectorIds = await listRegisteredConnectorIds();
              return Promise.all(connectorIds.map(async (connectorId) => {
                const manifest = await resolveRegisteredConnectorManifest(connectorId);
                return buildConnectorSchemaItem({
                  source: buildSourceDescriptor({ kind: 'connector', id: connectorId }),
                  storageBinding: { connector_id: connectorId },
                  manifest,
                });
              }));
            },
          };
        }
      } else {
        operationInput = {
          actor: {
            kind: 'client',
            subject_id: tokenInfo.subject_id || null,
            client_id: tokenInfo.client_id || null,
            grant_id: tokenInfo.grant_id || null,
          },
        };
        // Eagerly resolve the grant so the rejected-query path has the
        // correct source descriptor even if connector-item assembly throws.
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        const source = grantResolved.source;
        queryContext.sourceDescriptor = source;
        dependencies = {
          getSourceDescriptor: () => source,
          listConnectorItems: async () => {
            const item = await buildConnectorSchemaItem({
              source,
              storageBinding: grantResolved.storageBinding,
              manifest: grantResolved.manifest,
              grant: tokenInfo.grant,
            });
            return [item];
          },
        };
      }

      const result = await executeSchemaGet(operationInput, dependencies);

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
          source: result.sourceDescriptor,
          query_shape: 'schema',
          connector_count: result.counts.connector_count,
          stream_count: result.counts.stream_count,
        },
      });

      res.json(result.response);
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/streams — list streams (client or owner)
  // Stream-list semantics live in the canonical `rs.streams.list` operation
  // (operations/rs-streams-list). This route is a Fastify host adapter:
  // it owns auth, request id / trace id, instrumentation events, and
  // envelope writing; it MUST NOT recompute stream-list rules locally.
  app.get('/v1/streams', { contract: 'listStreams' }, requireToken, async (req, res) => {
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
        queryData: { query_shape: 'stream_list' },
      };

      let operationInput;
      let dependencies;
      if (tokenInfo.pdpp_token_kind === 'owner') {
        const ownerScope = resolveOwnerReadScope(req, opts);
        // Eagerly populate queryContext for the rejected-query path; the
        // operation also produces these via its output, but if the listing
        // dependency throws we still need source attribution in
        // query.received.
        queryContext.sourceDescriptor = buildSourceDescriptor(ownerScope.source);
        operationInput = {
          actor: { kind: 'owner', subject_id: tokenInfo.subject_id || null },
        };
        dependencies = {
          getSourceDescriptor: () => queryContext.sourceDescriptor,
          listSummaries: async () => {
            await resolveOwnerManifest(req, opts);
            return listAllStreams(ownerScope.storage_binding);
          },
        };
      } else {
        const grant = tokenInfo.grant;
        const streamCountLimit = Array.isArray(grant?.streams) ? grant.streams.length : null;
        queryContext.sourceDescriptor = buildSourceDescriptor(grant?.source);
        queryContext.queryData.stream_count_limit = streamCountLimit;
        operationInput = {
          actor: {
            kind: 'client',
            subject_id: tokenInfo.subject_id || null,
            client_id: tokenInfo.client_id || null,
            grant_id: tokenInfo.grant_id || null,
            stream_count_limit: streamCountLimit,
          },
        };
        dependencies = {
          getSourceDescriptor: () => queryContext.sourceDescriptor,
          listSummaries: async () => {
            const grantResolved = await resolveGrantManifest(tokenInfo, opts);
            return listStreams(grantResolved.storageBinding, grant, grantResolved.manifest);
          },
        };
      }

      const result = await executeStreamsList(operationInput, dependencies);

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
          source: result.sourceDescriptor,
          query_shape: 'stream_list',
          stream_count: result.streams.length,
        },
      });

      res.json({
        object: 'list',
        data: result.streams.map((summary) => ({
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
  // Stream-detail semantics live in the canonical `rs.streams.detail`
  // operation (operations/rs-streams-detail). This route is a Fastify host
  // adapter: it owns auth, request id / trace id, manifest + grant
  // resolution, instrumentation events, and response writing; it MUST NOT
  // recompute stream-detail visibility rules locally.
  app.get('/v1/streams/:stream', { contract: 'getStreamMetadata' }, requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);

      let manifest;
      let storageBinding;
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
        storageBinding = ownerScope.storage_binding;
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        manifest = grantResolved.manifest;
        sourceDescriptor = grantResolved.source;
        queryContext.sourceDescriptor = sourceDescriptor;
        storageBinding = resolveGrantStorageBinding(tokenInfo);
      }

      await emitQueryReceived(queryContext, req);

      const operationInput = tokenInfo.pdpp_token_kind === 'owner'
        ? {
            actor: { kind: 'owner', subject_id: tokenInfo.subject_id || null },
            streamName: req.params.stream,
          }
        : {
            actor: {
              kind: 'client',
              subject_id: tokenInfo.subject_id || null,
              client_id: tokenInfo.client_id || null,
              grant_id: tokenInfo.grant_id || null,
            },
            streamName: req.params.stream,
          };

      const dependencies = {
        getSourceDescriptor: () => sourceDescriptor,
        hasManifestStream: async (name) =>
          Array.isArray(manifest?.streams) && manifest.streams.some((s) => s.name === name),
        isStreamInGrant: (name) =>
          Array.isArray(tokenInfo.grant?.streams)
            && tokenInfo.grant.streams.some((s) => s.name === name),
        buildStreamMetadata: async (name) => {
          const manifestStream = manifest.streams.find((s) => s.name === name);
          const streamGrant = tokenInfo.pdpp_token_kind === 'client'
            ? tokenInfo.grant?.streams?.find((s) => s.name === name)
            : null;
          const freshness = await getVisibleStreamFreshness({
            tokenInfo,
            storageBinding,
            stream: name,
            manifest,
          });
          return buildStreamMetadataEntry({
            manifestStream,
            streamGrant,
            grantStreams: tokenInfo.grant?.streams || [],
            freshness,
          });
        },
      };

      let result;
      try {
        result = await executeStreamDetail(operationInput, dependencies);
      } catch (err) {
        if (err instanceof StreamDetailVisibilityError) {
          const visibilityErr = new Error(err.message);
          visibilityErr.code = err.code;
          return await rejectQuery(res, req, queryContext, visibilityErr);
        }
        throw err;
      }

      const metadataBody = result.metadata;

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
          source: result.sourceDescriptor,
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
  // Aggregate semantics live in the canonical `rs.streams.aggregate`
  // operation (operations/rs-streams-aggregate). This route is a Fastify host
  // adapter: it owns auth, request id / trace id, manifest/grant/storage-
  // binding resolution, instrumentation events, and response writing; it MUST
  // NOT recompute the `query.received` data block, the owner-branch
  // visibility check, or the disclosure totals locally.
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
      // Pre-emit query data block matches the operation's shape so the
      // rejected-query path emits the same fields whether the failure happens
      // before or after the operation runs.
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

      let operationInput;
      if (tokenInfo.pdpp_token_kind === 'owner') {
        const ownerScope = resolveOwnerReadScope(req, opts);
        sourceDescriptor = buildSourceDescriptor(ownerScope.source);
        queryContext.sourceDescriptor = sourceDescriptor;
        const ownerResolved = await resolveOwnerManifestFromScope(ownerScope, opts);
        storageBinding = ownerResolved.storageBinding;
        manifest = ownerResolved.manifest;
        grant = buildOwnerReadGrant(req.params.stream);
        operationInput = {
          actor: { kind: 'owner', subject_id: tokenInfo.subject_id || null },
          streamName: req.params.stream,
          requestParams,
        };
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        storageBinding = grantResolved.storageBinding;
        sourceDescriptor = grantResolved.source;
        manifest = grantResolved.manifest;
        queryContext.sourceDescriptor = sourceDescriptor;
        operationInput = {
          actor: {
            kind: 'client',
            subject_id: tokenInfo.subject_id || null,
            client_id: tokenInfo.client_id || null,
            grant_id: tokenInfo.grant_id || null,
          },
          streamName: req.params.stream,
          requestParams,
        };
      }

      await emitQueryReceived(queryContext, req);

      const dependencies = {
        getSourceDescriptor: () => sourceDescriptor,
        hasManifestStream: (streamName) => Boolean(
          manifest?.streams?.find((stream) => stream.name === streamName),
        ),
        validateRequest: (params) => {
          const mStream = manifest?.streams?.find((stream) => stream.name === req.params.stream);
          validateRequestedQueryFieldParams(params, mStream);
        },
        aggregate: (params) => aggregateRecords(
          storageBinding,
          req.params.stream,
          grant,
          params,
          manifest,
        ),
      };

      let result;
      try {
        result = await executeStreamsAggregate(operationInput, dependencies);
      } catch (opErr) {
        if (opErr instanceof StreamsAggregateVisibilityError) {
          const visibilityErr = new Error(opErr.message);
          visibilityErr.code = opErr.code;
          return await rejectQuery(res, req, queryContext, visibilityErr);
        }
        throw opErr;
      }

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
          source: result.sourceDescriptor,
          query_shape: 'stream_aggregate',
          metric: result.disclosureTotals.metric,
          field: result.disclosureTotals.field,
          group_by: result.disclosureTotals.group_by,
          filtered_record_count: result.disclosureTotals.filtered_record_count,
          group_count: result.disclosureTotals.group_count,
        },
      });

      res.json(result.result);
    } catch (err) {
      if (queryContext) {
        await emitQueryReceived(queryContext, req);
        return await rejectQuery(res, req, queryContext, err);
      }
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream/records
  // Record-list semantics live in the canonical `rs.records.list` operation
  // (operations/rs-records-list). This route is a Fastify host adapter:
  // it owns auth, request id / trace id, source-descriptor / manifest /
  // grant resolution, query-received and disclosure-served instrumentation,
  // blob-ref URL decoration, the host-shaped `url` envelope field, and
  // response writing. It MUST NOT recompute view/fields mutual exclusion,
  // view → fields resolution, manifest stream visibility, or owner read-
  // grant construction locally.
  app.get('/v1/streams/:stream/records', { contract: 'listRecords' }, requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);

      let sourceDescriptor = tokenInfo.pdpp_token_kind === 'owner'
        ? null
        : buildSourceDescriptor(tokenInfo.grant?.source);
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

      const operationInput = {
        actor: tokenInfo.pdpp_token_kind === 'owner'
          ? { kind: 'owner', subject_id: tokenInfo.subject_id || null }
          : {
              kind: 'client',
              subject_id: tokenInfo.subject_id || null,
              client_id: tokenInfo.client_id || null,
              grant_id: tokenInfo.grant_id || null,
            },
        streamName: req.params.stream,
        requestParams,
        // Forward the raw `view` / `fields` values without coercion so the
        // operation can apply the previous native truthiness test
        // (`if (req.query.view && req.query.fields)`). `qs.parse` may
        // produce strings, arrays (repeated params), or objects (bracketed
        // params); the operation handles each shape per its boundary
        // contract.
        rawQueryView: req.query.view,
        rawQueryFields: req.query.fields,
      };

      const dependencies = {
        getSourceDescriptor: () => sourceDescriptor,
        getManifest: () => manifest,
        getGrant: () => tokenInfo.grant || { streams: [] },
        queryRecords: (stream, grant, params, m) =>
          queryRecords(storageBinding, stream, grant, params, m),
        decorateRecord: (record) => decorateRecordBlobRefs(record),
        validateRequestFields: (params, manifestStream) =>
          validateRequestedQueryFieldParams(params, manifestStream),
      };

      let result;
      try {
        result = await executeRecordsList(operationInput, dependencies);
      } catch (err) {
        if (err instanceof RecordsListVisibilityError) {
          const mappedErr = new Error(err.message);
          mappedErr.code = err.code;
          return await rejectQuery(res, req, queryContext, mappedErr);
        }
        throw err;
      }

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
        data: { source: result.sourceDescriptor, ...result.disclosureData },
      });

      res.json({
        ...result.result,
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
  // Single-record-read semantics live in the canonical `rs.records.get`
  // operation (operations/rs-records-detail). This route is a Fastify host
  // adapter: it owns auth, request id / trace id, source-descriptor /
  // manifest / grant resolution, URI decoding of the path-level record id,
  // query-received and disclosure-served instrumentation, blob-ref URL
  // decoration, and response writing. It MUST NOT recompute owner read-
  // grant construction or `not_found` mapping locally.
  app.get('/v1/streams/:stream/records/:id', { contract: 'getRecord' }, requireToken, async (req, res) => {
    let queryContext = null;
    try {
      const { tokenInfo } = req;
      const queryId = ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = buildQueryActorContext(tokenInfo);
      setReferenceTraceId(res, traceId);
      let storageBinding = null;
      let sourceDescriptor = tokenInfo.pdpp_token_kind === 'owner'
        ? null
        : buildSourceDescriptor(tokenInfo.grant?.source);
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

      const operationInput = {
        actor: tokenInfo.pdpp_token_kind === 'owner'
          ? { kind: 'owner', subject_id: tokenInfo.subject_id || null }
          : {
              kind: 'client',
              subject_id: tokenInfo.subject_id || null,
              client_id: tokenInfo.client_id || null,
              grant_id: tokenInfo.grant_id || null,
            },
        streamName: req.params.stream,
        recordId: requestedRecordId,
        expandOptions: {
          expand: req.query.expand,
          expand_limit: req.query.expand_limit,
        },
      };

      const dependencies = {
        getSourceDescriptor: () => sourceDescriptor,
        getManifest: () => manifest,
        getGrant: () => tokenInfo.grant || { streams: [] },
        getRecord: (stream, recordId, grant, m, options) =>
          getRecord(storageBinding, stream, recordId, grant, m, options),
        decorateRecord: (record) => decorateRecordBlobRefs(record),
      };

      // The native `getRecord` capability throws an `Error` carrying
      // `code: 'not_found'` for missing or grant-filtered records, so the
      // operation's null-record check is unreachable here — that branch
      // only fires for hosts whose `getRecord` returns null on miss
      // (e.g., the sandbox fixture). Native `not_found` errors flow
      // through the existing outer catch into `rejectQuery`.
      let result;
      try {
        result = await executeRecordDetail(operationInput, dependencies);
      } catch (err) {
        if (err instanceof RecordDetailVisibilityError) {
          const mappedErr = new Error(err.message);
          mappedErr.code = err.code;
          return await rejectQuery(res, req, queryContext, mappedErr);
        }
        throw err;
      }

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
        data: { source: result.sourceDescriptor, ...result.disclosureData },
      });
      res.json(result.record);
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
          source: { kind: 'connector', id: connectorId },
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
            source: { kind: 'connector', id: connectorId },
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
            source: { kind: 'connector', id: connectorId },
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

  // POST /v1/blobs
  // Blob-upload semantics live in the canonical `rs.blobs.upload` operation
  // (operations/rs-blobs-upload). This route is a Fastify host adapter:
  // it owns auth, request id, response writing, and concrete capability
  // wiring. It MUST NOT recompute query/Content-Type validation, manifest
  // visibility, or response envelope shaping locally. The host wires the
  // existing `persistContentAddressedBlob` capability, which preserves
  // blob+binding atomicity.
  app.post('/v1/blobs', { contract: 'uploadBlob' }, requireToken, requireOwner, async (req, res) => {
    try {
      let manifestCache = null;
      const dependencies = {
        hasManifestStream: async (connectorId, streamName) => {
          manifestCache = await resolveRegisteredConnectorManifest(connectorId);
          return Boolean(
            (manifestCache.streams || []).find((candidate) => candidate.name === streamName),
          );
        },
        persistBlob: ({ connectorId, stream, recordKey, mimeType, data }) =>
          persistContentAddressedBlob({
            connectorId,
            stream,
            recordKey,
            mimeType,
            data: Buffer.isBuffer(data) ? data : Buffer.from(data),
          }),
      };
      const operationInput = {
        requestParams: {
          connector_id: req.query.connector_id,
          stream: req.query.stream,
          record_key: req.query.record_key,
        },
        contentType: req.headers['content-type'],
        body: req.body,
      };
      let output;
      try {
        output = await executeBlobsUpload(operationInput, dependencies);
      } catch (opErr) {
        if (
          opErr instanceof BlobsUploadInvalidRequestError
          || opErr instanceof BlobsUploadStreamNotFoundError
        ) {
          const mapped = new Error(opErr.message);
          mapped.code = opErr.code;
          throw mapped;
        }
        throw opErr;
      }
      res.json(output.envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /v1/blobs/:blob_id
  // Per-binding blob-visibility semantics live in the canonical `rs.blobs.read`
  // operation (operations/rs-blobs-read). This route is a Fastify host
  // adapter: it owns auth, decoding the blob_id path parameter, response
  // header / body writing, and wiring the actor-scoped storage binding,
  // manifest, and grant into the operation's `getVisibleRecord` capability.
  // It MUST NOT recompute the binding loop, the visibility short-circuit, or
  // the `blob_not_found` error shape locally, and MUST NOT speak SQL.
  // Storage reads flow through the `BlobStore` capability
  // (server/stores/blob-store.js).
  const blobStore = createBlobStore();
  app.get('/v1/blobs/:blob_id', { contract: 'getBlob' }, requireToken, async (req, res) => {
    try {
      const blobId = decodeURIComponent(req.params.blob_id);
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

      const dependencies = {
        loadBlob: (id) => blobStore.loadContentAddressedBlob(id),
        loadBindings: (id) => blobStore.listBlobBindings(id),
        getActorConnectorId: () => storageBinding?.connector_id ?? null,
        getVisibleRecord: async (binding) => {
          const grant = tokenInfo.pdpp_token_kind === 'owner'
            ? buildOwnerReadGrant(binding.stream)
            : tokenInfo.grant;
          return await getRecord(storageBinding, binding.stream, binding.record_key, grant, manifest);
        },
      };

      let output;
      try {
        output = await executeBlobsRead({ blobId }, dependencies);
      } catch (opErr) {
        if (opErr instanceof BlobsReadNotFoundError) {
          const mapped = new Error(opErr.message);
          mapped.code = opErr.code;
          throw mapped;
        }
        throw opErr;
      }
      const blob = output.blob;
      res.setHeader('Content-Type', blob.mime_type);
      res.setHeader('Content-Length', String(blob.size_bytes));
      res.send(Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data || ''));
    } catch (err) {
      handleError(res, err);
    }
  });

  if (!nativeMode) {
    // DELETE /v1/streams/:stream/records (owner-authenticated reference reset for polyfill mode)
    // Bulk-delete semantics live in the canonical `rs.records.delete_stream`
    // operation (operations/rs-records-delete-stream). This route is a
    // Fastify host adapter: it owns auth, mutation-context wiring, trace
    // id setup, instrumentation dispatch, and response writing. It MUST NOT
    // recompute the connector_id presence rule, manifest visibility, or the
    // `{ deleted_record_count }` event payload locally.
    app.delete('/v1/streams/:stream/records', requireToken, requireOwner, async (req, res) => {
      const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
      const mutationContext = buildMutationContext(req, res, {
        connectorId,
        operation: 'delete_stream_records',
        streamId: req.params.stream,
      });
      try {
        const dependencies = {
          hasManifestStream: async (cid, streamName) => {
            const manifest = await resolveRegisteredConnectorManifest(cid);
            return Boolean(
              (manifest.streams || []).find((stream) => stream.name === streamName),
            );
          },
          deleteAllRecords: (cid, streamName) => deleteAllRecords(cid, streamName),
        };
        let output;
        try {
          // Validate inputs before emitting `mutation.requested` to mirror
          // the previous native ordering: invalid_request short-circuits via
          // rejectMutation, which itself emits the requested event for parity.
          if (!connectorId) {
            throw new RecordsDeleteStreamInvalidRequestError(
              'connector_id must be a single non-empty string',
            );
          }
          setReferenceTraceId(res, mutationContext.traceId);
          await emitMutationRequested(req, mutationContext);
          output = await executeRecordsDeleteStream(
            { connectorId, streamName: req.params.stream },
            dependencies,
          );
        } catch (opErr) {
          if (
            opErr instanceof RecordsDeleteStreamInvalidRequestError
            || opErr instanceof RecordsDeleteStreamNotFoundError
          ) {
            const mapped = new Error(opErr.message);
            mapped.code = opErr.code;
            return await rejectMutation(res, req, mutationContext, mapped);
          }
          throw opErr;
        }
        await emitMutationEvent(req, mutationContext, 'mutation.completed', 'succeeded', {
          deleted_record_count: output.deletedRecordCount,
        });
        res.status(204).end();
      } catch (err) {
        return await rejectMutation(res, req, mutationContext, err);
      }
    });

    // DELETE /v1/streams/:stream/records/:id (owner-authenticated)
    // Single-delete semantics live in the canonical `rs.records.delete`
    // operation (operations/rs-records-delete). This route is a Fastify
    // host adapter: it owns auth, mutation-context wiring, trace id setup,
    // instrumentation dispatch, and response writing. It MUST NOT recompute
    // the connector_id presence rule, manifest visibility, or the
    // `{ deleted_record_count }` event payload locally.
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
        const dependencies = {
          hasManifestStream: async (cid, streamName) => {
            const manifest = await resolveRegisteredConnectorManifest(cid);
            return Boolean(
              (manifest.streams || []).find((stream) => stream.name === streamName),
            );
          },
          deleteRecord: (cid, streamName, recordId) => deleteRecord(cid, streamName, recordId),
        };
        let output;
        try {
          if (!connectorId) {
            throw new RecordsDeleteInvalidRequestError(
              'connector_id must be a single non-empty string',
            );
          }
          setReferenceTraceId(res, mutationContext.traceId);
          await emitMutationRequested(req, mutationContext);
          output = await executeRecordsDelete(
            {
              connectorId,
              streamName: req.params.stream,
              recordId: requestedRecordId,
            },
            dependencies,
          );
        } catch (opErr) {
          if (
            opErr instanceof RecordsDeleteInvalidRequestError
            || opErr instanceof RecordsDeleteNotFoundError
          ) {
            const mapped = new Error(opErr.message);
            mapped.code = opErr.code;
            return await rejectMutation(res, req, mutationContext, mapped);
          }
          throw opErr;
        }
        await emitMutationEvent(req, mutationContext, 'mutation.completed', 'succeeded', {
          deleted_record_count: output.deletedRecordCount,
        });
        res.status(204).end();
      } catch (err) {
        return await rejectMutation(res, req, mutationContext, err);
      }
    });

    // POST /v1/ingest/:stream (Collection Profile, owner-authenticated)
    // Ingest semantics live in the canonical `rs.records.ingest` operation
    // (operations/rs-records-ingest). This route is a Fastify host adapter:
    // it owns auth, mutation-context wiring, trace id setup, instrumentation
    // dispatch, and response writing. It MUST NOT recompute line splitting,
    // connector_id presence, manifest visibility, JSON parse handling, the
    // accepted/rejected counters, or the response envelope locally. Per-record
    // durable atomicity remains in the underlying `ingestRecord` capability.
    app.post('/v1/ingest/:stream', requireToken, requireOwner, async (req, res) => {
      const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
      const lines = parseIngestLines(typeof req.body === 'string' ? req.body : '');
      const mutationContext = buildMutationContext(req, res, {
        connectorId,
        operation: 'ingest_records',
        streamId: req.params.stream,
        submittedRecordCount: lines.length,
      });
      try {
        const dependencies = {
          hasManifestStream: async (cid, streamName) => {
            const manifest = await resolveRegisteredConnectorManifest(cid);
            return Boolean(
              (manifest.streams || []).find((stream) => stream.name === streamName),
            );
          },
          ingestRecord: (cid, record) => ingestRecord(cid, record),
        };
        let output;
        try {
          if (!connectorId) {
            throw new RecordsIngestInvalidRequestError(
              'connector_id must be a single non-empty string',
            );
          }
          setReferenceTraceId(res, mutationContext.traceId);
          await emitMutationRequested(req, mutationContext);
          output = await executeRecordsIngest(
            {
              connectorId,
              streamName: req.params.stream,
              body: typeof req.body === 'string' ? req.body : '',
            },
            dependencies,
          );
        } catch (opErr) {
          if (
            opErr instanceof RecordsIngestInvalidRequestError
            || opErr instanceof RecordsIngestNotFoundError
          ) {
            const mapped = new Error(opErr.message);
            mapped.code = opErr.code;
            return await rejectMutation(res, req, mutationContext, mapped);
          }
          throw opErr;
        }
        await emitMutationEvent(req, mutationContext, 'mutation.completed', 'succeeded', {
          records_accepted: output.envelope.records_accepted,
          records_rejected: output.envelope.records_rejected,
          error_count: output.envelope.errors.length,
        });
        res.json(output.envelope);
      } catch (err) {
        return await rejectMutation(res, req, mutationContext, err);
      }
    });

    // GET /v1/state/:connectorId (Collection Profile, owner-authenticated)
    // Validation order, the storage call shape, and the
    // grant-scope-driven `allowedStreams` semantics live in the canonical
    // `rs.connector-state.get` operation. The host adapter wires auth,
    // request id / trace id, instrumentation events
    // (`state.requested`, `state.served`, `state.rejected`), the manifest
    // resolver, the grant-scope resolver, and the response writing.
    app.get('/v1/state/:connectorId', requireToken, requireOwner, async (req, res) => {
      const connectorId = decodeURIComponent(req.params.connectorId);
      const grantId = typeof req.query.grant_id === 'string' ? req.query.grant_id : null;
      const stateContext = buildStateContext(req, res, {
        connectorId,
        grantId,
        operation: 'read',
      });
      try {
        const { state } = await executeRsConnectorStateGet(
          { connectorId, grantId },
          {
            resolveRegisteredConnectorManifest: (id) =>
              resolveRegisteredConnectorManifest(id),
            resolveGrantScope: (id, gid) => resolveGrantScopedStateGrant(id, gid),
            onGrantResolved: async (grantScope) => {
              if (grantScope?.traceId) {
                stateContext.traceId = grantScope.traceId;
                stateContext.scenarioId = grantScope.scenarioId;
              }
              setReferenceTraceId(res, stateContext.traceId);
              await emitStateRequested(req, stateContext);
            },
            getSyncState: (id, args) => getSyncState(id, args),
          },
        );
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
    // Validation order (manifest stream membership, grant-scope membership),
    // the storage call shape, and the typed validation errors live in the
    // canonical `rs.connector-state.put` operation. The host adapter
    // translates the typed validation error into the existing PDPP error
    // envelope shape.
    app.put('/v1/state/:connectorId', requireToken, requireOwner, async (req, res) => {
      const connectorId = decodeURIComponent(req.params.connectorId);
      const grantId = typeof req.query.grant_id === 'string' ? req.query.grant_id : null;
      const stateMap = (
        req.body?.state
        && typeof req.body.state === 'object'
        && !Array.isArray(req.body.state)
      ) ? req.body.state : {};
      const requestedStreams = Object.keys(stateMap);
      const stateContext = buildStateContext(req, res, {
        connectorId,
        grantId,
        operation: 'write',
        requestedStreams,
      });
      try {
        const { state } = await executeRsConnectorStatePut(
          { connectorId, grantId, stateMap },
          {
            resolveRegisteredConnectorManifest: (id) =>
              resolveRegisteredConnectorManifest(id),
            resolveGrantScope: (id, gid) => resolveGrantScopedStateGrant(id, gid),
            onGrantResolved: async (grantScope) => {
              if (grantScope?.traceId) {
                stateContext.traceId = grantScope.traceId;
                stateContext.scenarioId = grantScope.scenarioId;
              }
              setReferenceTraceId(res, stateContext.traceId);
              await emitStateRequested(req, stateContext);
            },
            putSyncState: (id, map, args) => putSyncState(id, map, args),
          },
        );
        await emitStateEvent(req, stateContext, 'state.updated', 'succeeded', {
          persisted_streams: Object.keys(state?.state || {}),
          updated_at: state?.updated_at || null,
        });
        res.json(state);
      } catch (err) {
        if (err instanceof RsConnectorStatePutValidationError) {
          // Translate the operation-typed validation error into the plain
          // `Error` shape `rejectState` already understands so the public
          // error envelope and `state.rejected` event remain unchanged.
          const translated = new Error(err.message);
          translated.code = err.code;
          return await rejectState(res, req, stateContext, translated);
        }
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
  const storageBackend = resolveStorageBackend({ opts });
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
  await initPostgresStorage(storageBackend);
  if (storageBackend.backend === 'postgres') {
    logger.info('postgres runtime storage initialized');
  }

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
  const trustedMetadataHosts = opts.trustedMetadataHosts ?? process.env.PDPP_TRUSTED_HOSTS ?? null;
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
    trustedMetadataHosts,
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
    trustedMetadataHosts,
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
    await closePostgresStorage();
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
    closePostgresStorage().finally(() => closeDb());
    cliLogger.fatal({ err }, 'startup failed');
    process.nextTick(() => process.exit(1));
  });
}
