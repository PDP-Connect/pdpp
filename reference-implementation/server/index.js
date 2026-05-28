/**
 * PDPP Personal Server
 *
 * Combined AS + RS implementing PDPP v0.1.0 core spec.
 * Starts on port 7662 (AS/introspection) and 7663 (RS query API).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { closeDb, getDb, initDb } from './db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
  resolveStorageBackend,
} from './postgres-storage.js';
import {
  buildAuthorizationServerMetadata,
  buildClientEventSubscriptionsCapability,
  buildHybridRetrievalCapability,
  buildLexicalRetrievalCapability,
  buildProtectedResourceMetadata,
  buildSemanticRetrievalCapability,
  isLocalOrPrivateRequestOrigin,
  isTrustedMetadataRequestOrigin,
  resolvePublicUrl,
  resolveSiblingPublicUrl,
  shouldUseDirectRequestOrigin,
  stripTrailingSlash,
} from './metadata.ts';
import { deriveReferenceFreshness } from './freshness.ts';
import { createTraceContext, emitSpineEvent, generateSpineId, listSpineCorrelations, listSpineEventsPage, searchSpine } from '../lib/spine.ts';
import { exec, getOne, referenceQueries, transaction } from '../lib/db.ts';
import {
  registerConnector, getConnectorManifest, getConfiguredNativeManifest, getManifestForStorageBinding,
  introspect, revokeGrant, revokeGrantPackage,
  createConsentExchangeCode, consumeConsentExchangeCode,
  configureNativeManifest,
  createHostedMcpGrantPackage, getGrantPackageAccess, getGrantPackageForOwner,
  listGrantPackagesForOwner, getGrantPackageIdForGrant,
  deleteRegisteredClient, exchangeOAuthAuthorizationCode, exchangeOAuthRefreshToken, getRegisteredClient,
  issueOAuthAuthorizationCodeForDeviceCode, issueOAuthAuthorizationCodeForPackageDeviceCode,
  listOwnerIssuedClients, listRegisteredConnectorIds,
  registerDynamicClient, requireGrantContractAgainstManifest, requireResolvedPersistedGrantState, seedPreRegisteredClients,
  buildPendingConsentRequestUri,
  stageOAuthAuthorizationCodeRequest,
} from './auth.js';
import { createBlobStore } from './stores/blob-store.js';
import {
  AmbiguousConnectionError,
  listActiveBindingsForGrant,
  listGrantedConnectionsForStream,
  projectBindingForWire,
} from './connection-identity.js';
import {
  encodeHostedMcpSelection,
  encodeHostedMcpStreamSelection,
  hostedMcpSourceKey,
  parseHostedMcpSelections,
  parseHostedMcpStreamSelections,
} from './hosted-mcp-selection.js';
import { canonicalConnectorKey } from './connector-key.js';
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  makeConnectorInstanceSourceBindingKey,
  resolveOwnerConnectorInstanceNamespace,
} from './stores/connector-instance-store.js';
import { postgresPersistContentAddressedBlob } from './postgres-records.js';
import { createConsentStore } from './stores/consent-store.js';
import { createOwnerDeviceAuthStore } from './stores/owner-device-auth-store.js';
import {
  buildEventPayload,
  executeApplyGrantRevoke,
  executeCreateSubscription,
  executeDeleteSubscription,
  executeEnqueueTestEvent,
  executeGetSubscription,
  executeListSubscriptions,
  executeUpdateSubscription,
} from '../operations/as-client-event-subscriptions/index.ts';
import {
  deriveClientEventsFromRecordChange,
} from '../operations/rs-client-event-derive/index.ts';
import {
  getDefaultClientEventSubscriptionStore,
  getSubscriptionSummary,
  listActiveSubscriptions,
  listAllSubscriptions,
  listAttemptsForSubscription,
} from './stores/client-event-subscription-store.ts';
import { executeRefClientEventSubscriptionsList } from '../operations/ref-client-event-subscriptions-list/index.ts';
import {
  executeRefClientEventSubscriptionsGet,
  RefClientEventSubscriptionsNotFoundError,
} from '../operations/ref-client-event-subscriptions-get/index.ts';
import {
  executeRefClientEventSubscriptionsDisable,
  RefClientEventSubscriptionsDisableInvalidRequestError,
  RefClientEventSubscriptionsDisableNotFoundError,
} from '../operations/ref-client-event-subscriptions-disable/index.ts';
import { getDefaultDeliveryWorker } from './client-event-delivery-worker.ts';
import { setClientEventEnqueueHook } from './records.js';
import { DeviceBatchConflictError, createDeviceExporterStore } from './stores/device-exporter-store.js';
import { getDefaultConnectorDetailGapStore } from './stores/connector-detail-gap-store.js';
import {
  createWebPushSubscriptionStore,
  fanoutPendingInteractionWebPush,
  fanoutTestWebPush,
  resolveWebPushConfig,
} from './web-push-notifications.js';
import {
  ingestRecord, queryRecords, aggregateRecords, getRecord, deleteRecord, deleteAllRecords,
  listStreams, listAllStreams, getSyncState, putSyncState,
  getDatasetRecordsAggregate, getDatasetRecordChangesBytes, getDatasetBlobBytes,
  getDatasetRecordTimeBounds, listDatasetTopConnectorCandidates,
  listDatasetSummaryStreamProjectionSeeds, getDatasetSummaryStreamRecordTimeBounds,
  queryRecordsAcrossBindings, getRecordAcrossBindings,
  aggregateRecordsAcrossBindings, listStreamsAcrossBindings,
  getStreamDetailAcrossBindings, resolveReadRequestBindings,
} from './records.js';
import {
  applyDatasetSummaryBlobDelta,
  getDatasetSummaryProjection,
  listStreamProjections,
  reconcileDirtyDatasetSummaryRecordTimeBounds,
  rebuildDatasetSummaryProjection,
} from './dataset-summary-read-model.js';
import {
  applyRetainedSizeBlobDelta,
  getRetainedSizeGlobal,
  listRetainedSizeConnections,
  listRetainedSizeStreams,
  listRetainedSizeTop,
  rebuildRetainedSize,
  reconcileDirtyRetainedSize,
} from './retained-size-read-model.js';
import { buildRecordVersionStatsEnvelope } from './record-version-stats.js';
import { getLexicalIndexBackfillProgress, lexicalIndexBackfillForManifest, runLexicalSearch } from './search.js';
import { runHybridSearch } from './search-hybrid.js';
import { reconcilePolyfillManifests } from './polyfill-manifest-reconcile.ts';
import { autoEnrollEligibleSchedules } from './auto-enroll-eligible-schedules.ts';
import { emitControllerBootedAndStashEpoch, reconcileOrphanedRunsAtBoot } from '../lib/controller-boot.ts';
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
import {
  COLLECTOR_PROTOCOL_VERSION,
  SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS,
  buildCollectorProtocolMismatchBody,
  isAcceptedCollectorProtocolVersion,
  readCollectorProtocolHeader,
} from './collector-protocol.ts';
import { createOwnerAuthPlaceholder, OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import { registerInboxRoutes } from './inbox.js';
import { createStreamingSessionStore } from './streaming/sessions.js';
import { createDefaultStreamingCompanionFactory } from './streaming/companion-factory.js';
import { registerStreamingRoutes } from './streaming/routes.js';
import { createRunTargetRegistry } from './streaming/run-target-registry.js';
import { createPlayground } from './streaming/playground.js';
import {
  createController,
  getScheduleIneligibilityReason,
  resolveDefaultConnectorPath,
} from '../runtime/controller.ts';
import { projectRunAutomationPolicy } from '../runtime/run-automation-policy.ts';
import { redactStderrTail } from '../runtime/stderr-redact.js';
import { createScheduler } from '../runtime/scheduler.ts';
import { getDefaultSchedulerStore } from './stores/scheduler-store.ts';
import { getDefaultSourceWebhookEventStore } from './stores/source-webhook-event-store.ts';
import { BrowserSurfaceLeaseManager } from '@opendatalabs/remote-surface/leases';
import { parseNekoBrowserSurfaceRuntimeConfig } from '../runtime/browser-surface-leases.ts';
import { NekoSurfaceAllocatorClient } from '../runtime/neko-surface-allocator.ts';
import { createDefaultBrowserSurfaceReadinessProbe } from '../runtime/browser-surface-readiness.ts';
import { getDefaultBrowserSurfaceLeaseStore } from './stores/browser-surface-lease-store.ts';
import {
  createPdppCliCommand,
  PDPP_CLI_DEFAULT_CLIENT_ID,
  getPdppCliPackageInfo,
} from '../../packages/cli/src/package-info.js';
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
import { servedRootLandingIfBrowser } from './reference-root-landing.js';
import {
  collectRecordsTimelineEntries,
  getConnectorAttentionProjection,
  getConnectorDetail,
  listConnectorSummaries,
  listPendingApprovals,
} from './ref-control.ts';
import { isHealthRelevant as isAttentionHealthRelevant } from '../runtime/attention.ts';
import { getDefaultConnectorAttentionStore } from './stores/connector-attention-store.js';
import {
  DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
  DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS,
} from './reference-local-defaults.ts';
import { handleStreamableHttpRequest } from '@pdpp/mcp-server/server';
import { createPackageRsClient } from './package-rs-client.js';
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
import { executeRefApprovalsList } from '../operations/ref-approvals-list/index.ts';
import { executeRefSchedulesList } from '../operations/ref-schedules-list/index.ts';
import { executeRefSpineSearch } from '../operations/ref-spine-search/index.ts';
import { executeRefRecordsTimeline } from '../operations/ref-records-timeline/index.ts';
import {
  RefClientsListInvalidRequestError,
  executeRefClientsList,
} from '../operations/ref-clients-list/index.ts';
import { executeRefDeployment } from '../operations/ref-deployment/index.ts';
import { executeConnectorsList } from '../operations/rs-connectors-list/index.ts';
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
import { executeAsDcrRegister, summarizeDcrRegisterRequest } from '../operations/as-dcr-register/index.ts';
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
import {
  mountAsAuthorizationServerMetadata,
  mountAsRoot,
  mountRsMcpProtectedResourceMetadata,
  mountRsProtectedResourceMetadata,
  mountRsRoot,
} from './routes/root-and-discovery.ts';
import {
  mountRefGrants,
  mountRefRuns,
  mountRefTraces,
} from './routes/ref-spine-correlations.ts';
import {
  mountRefGrantTimeline,
  mountRefRunTimeline,
  mountRefTraceTimeline,
} from './routes/ref-spine-timelines.ts';
import {
  mountRefWebPushConfig,
  mountRefWebPushCreateSubscription,
  mountRefWebPushDeleteSubscription,
  mountRefWebPushListSubscriptions,
  mountRefWebPushTest,
} from './routes/web-push.ts';
import { mountRefSourceWebhooks } from './routes/source-webhooks.ts';
import {
  mountRefDevPlaygroundSession,
  mountRefRunInteraction,
} from './routes/run-interaction.ts';
import {
  mountRefDatasetSize,
  mountRefDatasetSizeRebuild,
  mountRefDatasetSizeReconcile,
  mountRefDatasetSummary,
  mountRefDatasetSummaryRebuild,
  mountRefDatasetSummaryReconcile,
  mountRefDatasetSummaryStreams,
  mountRefDatasetTop,
  mountRefRecordsVersionStats,
} from './routes/ref-dataset.ts';
import {
  mountRefConnectionDetail,
  mountRefConnectionRun,
  mountRefConnectionScheduleDelete,
  mountRefConnectionSchedulePause,
  mountRefConnectionScheduleResume,
  mountRefConnectionScheduleUpsert,
  mountRefConnectionSetDisplayName,
  mountRefConnectionsList,
  mountRefConnectorDetail,
  mountRefConnectorInstanceDetail,
  mountRefConnectorInstancesList,
  mountRefConnectorRun,
  mountRefConnectorScheduleDelete,
  mountRefConnectorScheduleGet,
  mountRefConnectorSchedulePause,
  mountRefConnectorScheduleResume,
  mountRefConnectorScheduleUpsert,
  mountRefConnectorsList,
} from './routes/ref-connectors.ts';

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
const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
const PROTECTED_RESOURCE_METADATA_URL_LOCAL = 'protectedResourceMetadataUrl';
const PROTECTED_RESOURCE_METADATA_NEXT_STEP =
  'Fetch error.resource_metadata, then follow pdpp_agent_discovery.cli when token completion is available; otherwise request a scoped client grant without using an owner bearer token.';
const AGENT_CONNECT_TTL_MS = 5 * 60 * 1000;
const PUBLIC_DCR_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const PUBLIC_DCR_RATE_LIMIT_MAX = 120;

// ─── Helpers ────────────────────────────────────────────────────────────────

// Heuristic: is this DB path a canonical polyfill-connectors deployment DB?
// Used to decide whether to auto-reconcile persisted manifests on startup.
// The dev script's default
// (`../packages/polyfill-connectors/.pdpp-data/pdpp.sqlite`) is the
// authoritative sentinel; overrides use the explicit opts/env knob.
export function looksLikePolyfillDeploymentDbPath(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') return false;
  if (dbPath === ':memory:') return false;
  return dbPath.includes('/polyfill-connectors/') && dbPath.endsWith('pdpp.sqlite');
}

export function shouldAutoReconcilePolyfillManifests({ dbPath, storageBackendKind }) {
  if (storageBackendKind === 'postgres') {
    return true;
  }
  return looksLikePolyfillDeploymentDbPath(dbPath);
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

function pdppError(res, status, code, message, param = null, extras = null) {
  const body = { error: { type: typeFor(status), code, message } };
  if (param) body.error.param = param;
  if (extras && typeof extras === 'object') {
    if (Array.isArray(extras.available_connections)) {
      body.error.available_connections = extras.available_connections;
    }
    if (typeof extras.retry_with === 'string') {
      body.error.retry_with = extras.retry_with;
    }
  }
  const resourceMetadataUrl = status === 401 ? getProtectedResourceMetadataUrl(res) : null;
  if (resourceMetadataUrl) {
    body.error.resource_metadata = resourceMetadataUrl;
    body.error.next_step = PROTECTED_RESOURCE_METADATA_NEXT_STEP;
  }
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

function httpQuotedString(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function protectedResourceMetadataUrlForResource(resource) {
  const parsed = new URL(resource);
  const resourcePath = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.origin}${PROTECTED_RESOURCE_METADATA_PATH}${resourcePath}${parsed.search}`;
}

function resolveTrustedProtectedResourceMetadataUrl(req, explicitResource, trustedHosts) {
  if (!isTrustedMetadataRequestOrigin(req, explicitResource, trustedHosts)) {
    return null;
  }
  try {
    return protectedResourceMetadataUrlForResource(resolvePublicUrl(req, explicitResource));
  } catch {
    return null;
  }
}

function getProtectedResourceMetadataUrl(res) {
  const metadataUrl = res.locals?.[PROTECTED_RESOURCE_METADATA_URL_LOCAL];
  return typeof metadataUrl === 'string' && metadataUrl ? metadataUrl : null;
}

function setProtectedResourceMetadataChallenge(res) {
  const metadataUrl = getProtectedResourceMetadataUrl(res);
  if (!metadataUrl) {
    return;
  }
  res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${httpQuotedString(metadataUrl)}"`);
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashDeviceSecret(value) {
  return `sha256:${sha256Hex(value)}`;
}

function generateReferenceSecret(prefix, bytes = 24) {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

function optionalObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function requireNonEmptyString(value, param) {
  if (typeof value !== 'string' || !value.trim()) {
    const err = new Error(`${param} is required`);
    err.code = 'invalid_request';
    err.param = param;
    throw err;
  }
  return value.trim();
}

function sanitizeLocalCollectorGapDetails(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const redacted = redactStderrTail(value).text.replace(/\s+/g, ' ').trim();
  if (!redacted) return null;
  return redacted.length <= 300 ? redacted : `${redacted.slice(0, 299)}…`;
}

const SENSITIVE_DIAGNOSTIC_KEY_RE = /\b(authorization|bearer|token|password|passwd|cookie|secret|otp|api[_-]?key)\b/i;

function sanitizeDeviceExporterDiagnostic(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return sanitizeDeviceExporterDiagnosticText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 4) return '[REDACTED_DEPTH]';
    return value.slice(0, 20).map((item) => sanitizeDeviceExporterDiagnostic(item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 4) return '[REDACTED_DEPTH]';
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_DIAGNOSTIC_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeDeviceExporterDiagnostic(child, depth + 1);
    }
    return out;
  }
  return null;
}

function sanitizeDeviceExporterDiagnosticText(value) {
  let redacted = redactStderrTail(value).text;
  redacted = redacted.replace(/(?:^|[\s"'=(:])(?:\/home|\/Users|\/root)\/[^\s"',)]+/g, (match) => {
    const prefix = match.startsWith('/') ? '' : match[0];
    return `${prefix}[REDACTED_PATH]`;
  });
  redacted = redacted.replace(/\b[A-Za-z]:\\Users\\[^\s"',)]+/g, '[REDACTED_PATH]');
  return redacted.replace(/\s+/g, ' ').trim();
}

function referenceLocalDeviceStorageTarget(connectorId, connectorInstanceId) {
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  return {
    connector_id: connectorKey,
    connector_instance_id: connectorInstanceId,
  };
}

const REFERENCE_LOCAL_CONNECTOR_CATALOG_MANIFESTS = new Map([
  ['claude_code', { entryName: 'claude_code.json', displayName: 'Claude Code' }],
  ['codex', { entryName: 'codex.json', displayName: 'OpenAI Codex CLI' }],
]);

function readReferenceLocalConnectorCatalogManifest(connectorId) {
  const local = REFERENCE_LOCAL_CONNECTOR_CATALOG_MANIFESTS.get(connectorId);
  if (!local) return null;
  try {
    const raw = readFileSync(
      new URL(`../../packages/polyfill-connectors/manifests/${local.entryName}`, import.meta.url),
      'utf8',
    );
    const manifest = JSON.parse(raw);
    return {
      ...manifest,
      connector_id: connectorId,
      display_name: manifest.display_name || local.displayName,
    };
  } catch {
    return {
      connector_id: connectorId,
      display_name: local.displayName,
      streams: [],
    };
  }
}

async function ensureReferenceConnectorCatalogEntry(connectorId, connectorDisplayName) {
  const localCollectorManifest = readReferenceLocalConnectorCatalogManifest(connectorId);
  if (localCollectorManifest) {
    await registerConnector(localCollectorManifest);
    return;
  }
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const manifest = {
    connector_id: connectorKey,
    ...(connectorKey !== connectorId ? { manifest_uri: connectorId } : {}),
    display_name: connectorDisplayName || connectorKey,
    streams: [],
  };
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest)
       VALUES($1, $2::jsonb)
       ON CONFLICT(connector_id) DO NOTHING`,
      [connectorKey, JSON.stringify(manifest)],
    );
    return;
  }
  exec(referenceQueries.authConnectorsUpsert, [connectorKey, JSON.stringify(manifest)]);
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
  invalid_argument: 400,
  invalid_cursor: 400,
  invalid_request: 400,
  invalid_client: 400,
  invalid_client_metadata: 400,
  connector_invalid: 400,
  invalid_record: 400,
  invalid_record_identity: 400,
  invalid_expand: 400,
  ambiguous_connector_instance: 400,
  ambiguous_connection: 409,
  connection_not_found: 404,
  connector_instance_connector_mismatch: 400,
  connector_instance_inactive: 400,
  connector_instance_selector_required: 400,
  connector_instance_store_required: 500,
  owner_subject_required: 400,
  unknown_field: 400,
  unsupported_version: 400,
  authentication_error: 401,
  connector_instance_owner_mismatch: 403,
  blob_not_found: 404,
  connector_instance_not_found: 404,
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
  const extras = {};
  if (Array.isArray(err.available_connections)) extras.available_connections = err.available_connections;
  if (typeof err.retry_with === 'string') extras.retry_with = err.retry_with;
  pdppError(res, status, code, err.message, err.param || null, extras);
}

function createRequestAbortSignal(req, message) {
  const controller = new AbortController();
  const raw = req?.raw;
  const abort = () => {
    if (controller.signal.aborted) return;
    const err = new Error(message);
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    controller.abort(err);
  };
  if (raw && typeof raw.on === 'function') {
    raw.on('close', abort);
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (!raw) return;
      if (typeof raw.off === 'function') {
        raw.off('close', abort);
      } else if (typeof raw.removeListener === 'function') {
        raw.removeListener('close', abort);
      }
    },
  };
}

function oauthError(res, status, code, description) {
  const requestId = ensureRequestId(res);
  res.status(status).json({
    error: code,
    error_description: description,
    request_id: requestId,
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
  const extras = {};
  if (Array.isArray(err.available_connections)) extras.available_connections = err.available_connections;
  if (typeof err.retry_with === 'string') extras.retry_with = err.retry_with;
  return pdppError(res, status, code, err.message, param || err.param || null, extras);
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

// ─── Auth middleware ─────────────────────────────────────────────────────────

async function requireToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    setProtectedResourceMetadataChallenge(res);
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
    setProtectedResourceMetadataChallenge(res);
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

// Accept either a per-grant client token (the normal RS token) or a
// hosted-MCP grant-package token. The package token is only meaningful at
// `/mcp`; every other resource-server route stays gated by `requireClient`
// so package tokens cannot reach REST surfaces. Owner tokens are always
// rejected — there is no owner-mode MCP.
function requireClientOrMcpPackage(req, res, next) {
  const kind = req.tokenInfo?.pdpp_token_kind;
  if (kind !== 'client' && kind !== 'mcp_package') {
    return pdppError(res, 403, 'permission_error', 'Client or MCP package token required');
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

function getOwnerTokenSubjectId(req) {
  return req.tokenInfo?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID;
}

function createRequestConnectorInstanceStore() {
  return isPostgresStorageBackend()
    ? createPostgresConnectorInstanceStore()
    : createSqliteConnectorInstanceStore();
}

async function resolveOwnerConnectorNamespace(req, connectorId, options = {}) {
  const explicitConnectorInstanceId =
    resolveSingleConnectorIdQueryValue(options.connectorInstanceId) ||
    resolveSingleConnectorIdQueryValue(req.query?.connector_instance_id);
  const ownerSubjectId = options.ownerSubjectId || getOwnerTokenSubjectId(req);
  return resolveOwnerConnectorInstanceNamespace({
    ownerSubjectId,
    connectorId,
    connectorInstanceId: explicitConnectorInstanceId,
    connectorInstanceStore: createRequestConnectorInstanceStore(),
    allowDefaultAccount: options.allowDefaultAccount ?? true,
    displayName: options.displayName ?? connectorId,
    now: options.now,
  });
}

function storageTargetForConnectorNamespace(namespace) {
  return {
    connector_id: namespace.connectorId,
    connector_instance_id: namespace.connectorInstanceId,
  };
}

function toPublicConnectorStateProjection(state) {
  if (!state || typeof state !== 'object') return state;
  return {
    object: state.object,
    connector_id: state.connector_id,
    grant_id: state.grant_id,
    state: state.state,
    updated_at: state.updated_at,
  };
}

function parseSourceWebhookSecrets(raw = process.env.PDPP_SOURCE_WEBHOOK_SECRETS || '') {
  const map = new Map();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    const secondSeparator = trimmed.indexOf(':', separator + 1);
    const sourceId = trimmed.slice(0, separator).trim();
    const secret = secondSeparator === -1
      ? trimmed.slice(separator + 1)
      : trimmed.slice(separator + 1, secondSeparator);
    const connectorId = secondSeparator === -1 ? sourceId : trimmed.slice(secondSeparator + 1);
    if (sourceId && secret) map.set(sourceId, { secret, connectorId });
  }
  return map;
}

function resolveOwnerReadScope(req, opts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  const nativeStorageBinding = resolveNativeStorageBinding(opts);
  if (nativeManifest && nativeStorageBinding) {
    return {
      public_scope: 'native',
      owner_subject_id: getOwnerTokenSubjectId(req),
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
    owner_subject_id: getOwnerTokenSubjectId(req),
    source: { kind: 'connector', id: connectorId },
    storage_binding: {
      connector_id: connectorId,
      connector_instance_id: resolveSingleConnectorIdQueryValue(req.query.connector_instance_id),
    },
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
  return Boolean(requested);
}

function resolveDynamicClientRegistrationInitialAccessTokens(opts = {}) {
  // Explicit opts win, including an explicit empty array for tests that want
  // public self-registration without accepting bootstrap tokens.
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

function resolveDynamicClientRegistrationInitialAccessTokensForRequest(req, tokens) {
  if (isLocalOrPrivateRequestOrigin(req)) {
    return tokens;
  }
  return tokens.filter((token) => token !== DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN);
}

function resolvePreRegisteredPublicClients(opts = {}) {
  return opts.preRegisteredPublicClients || defaultPreRegisteredPublicClients();
}

function createPublicDcrRateLimiter(config = {}) {
  if (config === false) {
    return { check: () => null };
  }
  const windowMs = Number.isFinite(config.windowMs)
    ? Math.max(1, config.windowMs)
    : PUBLIC_DCR_RATE_LIMIT_WINDOW_MS;
  const max = Number.isFinite(config.max)
    ? Math.max(1, config.max)
    : PUBLIC_DCR_RATE_LIMIT_MAX;
  const attempts = new Map();

  return {
    check(req) {
      const now = Date.now();
      if (attempts.size > 1000) {
        for (const [key, entry] of attempts.entries()) {
          if (entry.resetAt <= now) attempts.delete(key);
        }
      }
      const key =
        req.ip ||
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        'unknown';
      const current = attempts.get(key);
      if (!current || current.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
        return null;
      }
      if (current.count >= max) {
        return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      }
      current.count += 1;
      return null;
    },
  };
}

function publicClientMetadataForAuthorizationServer(clients = []) {
  return clients
    .map((client) => {
      const clientId = typeof client.client_id === 'string' ? client.client_id.trim() : '';
      if (!clientId) {
        return null;
      }
      const metadata = client.metadata || {};
      const clientName =
        typeof metadata.client_name === 'string' && metadata.client_name.trim()
          ? metadata.client_name.trim()
          : clientId;
      const tokenEndpointAuthMethod =
        typeof metadata.token_endpoint_auth_method === 'string' &&
        metadata.token_endpoint_auth_method.trim()
          ? metadata.token_endpoint_auth_method.trim()
          : 'none';
      return {
        client_id: clientId,
        client_name: clientName,
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      };
    })
    .filter(Boolean);
}

function resolveOwnerAuthPlaceholderConfig(opts = {}) {
  // Explicit opts win over env so the harness can set them per-test. When
  // neither is set, placeholder auth stays off and the server keeps its
  // current open local-dev behavior.
  //
  // Node's built-in test runner sets NODE_TEST_CONTEXT. In that mode,
  // direct `node --test test/foo.test.js` invocations must be hermetic
  // even when the developer shell exports real operator env vars. The
  // production process still reads env normally; tests that need owner auth
  // opt in with explicit startServer({ ownerAuthPassword, ... }) options.
  const readOwnerAuthEnv = !process.env.NODE_TEST_CONTEXT;
  const password =
    opts.ownerAuthPassword ??
    (readOwnerAuthEnv && typeof process.env.PDPP_OWNER_PASSWORD === 'string' && process.env.PDPP_OWNER_PASSWORD
      ? process.env.PDPP_OWNER_PASSWORD
      : null);
  const subjectId =
    opts.ownerAuthSubjectId ??
    (readOwnerAuthEnv && typeof process.env.PDPP_OWNER_SUBJECT_ID === 'string' && process.env.PDPP_OWNER_SUBJECT_ID
      ? process.env.PDPP_OWNER_SUBJECT_ID
      : null);
  // Force `Secure` on owner cookies behind a TLS-terminating proxy where
  // `req.secure` and `X-Forwarded-Proto` cannot be relied on. Default off
  // so plain-HTTP local development continues to issue usable cookies.
  const forceSecureCookies =
    opts.ownerAuthForceSecureCookies ??
    (readOwnerAuthEnv && (
      process.env.PDPP_OWNER_FORCE_SECURE_COOKIES === '1' ||
      process.env.PDPP_OWNER_FORCE_SECURE_COOKIES === 'true'
    ));
  // SameSite mode for the owner session and CSRF cookies. `lax` keeps the
  // existing flow (login redirects from /owner/login back to /consent)
  // working. `strict` is opt-in for deployments that don't rely on
  // top-level navigation following a redirect.
  const sameSiteRaw =
    typeof opts.ownerAuthSameSite === 'string'
      ? opts.ownerAuthSameSite
      : readOwnerAuthEnv
        ? process.env.PDPP_OWNER_SAMESITE
        : undefined;
  const sameSite = sameSiteRaw === 'strict' ? 'strict' : 'lax';
  const sessionTtlRaw =
    opts.ownerAuthSessionTtlSeconds ??
    (readOwnerAuthEnv && typeof process.env.PDPP_OWNER_SESSION_TTL_SECONDS === 'string'
      ? process.env.PDPP_OWNER_SESSION_TTL_SECONDS
      : null);
  const sessionTtlSeconds =
    typeof sessionTtlRaw === 'number' && Number.isInteger(sessionTtlRaw) && sessionTtlRaw > 0
      ? sessionTtlRaw
      : typeof sessionTtlRaw === 'string' && /^[1-9]\d*$/.test(sessionTtlRaw.trim())
        ? Number(sessionTtlRaw.trim())
        : undefined;
  return { password, subjectId, forceSecureCookies: Boolean(forceSecureCookies), sameSite, sessionTtlSeconds };
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

function ownerSubjectIdForBindings(tokenInfo) {
  return tokenInfo?.grant?.subject?.id
    || tokenInfo?.subject_id
    || OWNER_AUTH_DEFAULT_SUBJECT_ID;
}

function buildClientSourceDescriptor(tokenInfo) {
  const grantSource = buildSourceDescriptor(tokenInfo?.grant?.source);
  if (grantSource) return grantSource;

  const storageBinding = resolveGrantStorageBinding(tokenInfo);
  if (storageBinding?.connector_id) {
    return { kind: 'connector', id: storageBinding.connector_id };
  }
  return null;
}

function buildOwnerQuerySourceDescriptor(req, opts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  if (nativeManifest?.provider_id) {
    return buildSourceDescriptor({ kind: 'provider_native', id: nativeManifest.provider_id });
  }

  const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
  return connectorId ? buildSourceDescriptor({ kind: 'connector', id: connectorId }) : null;
}

function buildOwnerReadGrant(streamName) {
  return {
    streams: [{ name: streamName }],
  };
}

async function resolveOwnerManifestFromScope(ownerScope, opts = {}) {
  let storageBinding = ownerScope.storage_binding || null;
  if (ownerScope.public_scope === 'polyfill' && storageBinding?.connector_id) {
    try {
      const namespace = await resolveOwnerConnectorInstanceNamespace({
        ownerSubjectId: ownerScope.owner_subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID,
        connectorId: storageBinding.connector_id,
        connectorInstanceId: storageBinding.connector_instance_id,
        connectorInstanceStore: createRequestConnectorInstanceStore(),
        allowDefaultAccount: true,
        displayName: storageBinding.connector_id,
      });
      storageBinding = storageTargetForConnectorNamespace(namespace);
    } catch (err) {
      // Tolerate multi-connection ambiguity: the route layer fans in over
      // every active connection under the connector, so a single-binding
      // pin is no longer required. The storage binding stays scoped to
      // `connector_id` and the route resolves the binding set per
      // request via `resolveReadRequestBindings`.
      if (err?.code === 'ambiguous_connector_instance') {
        storageBinding = { connector_id: storageBinding.connector_id };
      } else if (err?.code !== 'connector_instance_not_found') {
        // Fall through to manifest-not-found if the connector is not
        // registered; route-level not_found mapping then returns a 404.
        throw err;
      }
    }
  }
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
  let storageBinding = resolveGrantStorageBinding(tokenInfo);
  // Only resolve a connector_instance namespace for polyfill connector
  // sources. Native provider grants point at synthetic storage bindings
  // whose connector_id is not registered in the `connectors` catalog, so
  // forcing a connector_instances upsert would FK-fail and surface as
  // a 500 instead of the intended client-error rejection downstream.
  const grantSourceKind = tokenInfo?.grant?.source?.kind;
  if (storageBinding?.connector_id && grantSourceKind !== 'provider_native') {
    try {
      const namespace = await resolveOwnerConnectorInstanceNamespace({
        ownerSubjectId: tokenInfo?.grant?.subject?.id || tokenInfo?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID,
        connectorId: storageBinding.connector_id,
        connectorInstanceId: storageBinding.connector_instance_id,
        connectorInstanceStore: createRequestConnectorInstanceStore(),
        allowDefaultAccount: true,
        displayName: storageBinding.connector_id,
      });
      storageBinding = storageTargetForConnectorNamespace(namespace);
    } catch (err) {
      // Tolerate multi-connection ambiguity: the route layer fans in over
      // every active connection under the connector. The storage binding
      // stays scoped to `connector_id` only; the route uses the
      // fan-in resolver to pick / iterate concrete bindings.
      if (err?.code === 'ambiguous_connector_instance') {
        storageBinding = { connector_id: storageBinding.connector_id };
      } else if (err?.code !== 'connector_instance_not_found') {
        // If the connector is not registered, fall through to the
        // manifest-not-found path below so the route returns a clean 404
        // ("Unknown connector: …") instead of bubbling a 500.
        throw err;
      }
    }
  }
  const source = buildClientSourceDescriptor(tokenInfo);
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

export async function resolveGrantScopedStateGrant(connectorId, grantId) {
  // Grants live in the active storage backend. In postgres mode the SQLite
  // `grants` table is empty (or stale), so we must read from postgres or
  // every postgres-issued grant resolves as `not_found`. JSONB columns are
  // cast to ::text so requirePersistedGrantState's JSON.parse sees the same
  // string shape it sees from the SQLite reader.
  const row = isPostgresStorageBackend()
    ? (await postgresQuery(
        `SELECT grant_json::text AS grant_json,
                storage_binding_json::text AS storage_binding_json,
                trace_id, scenario_id
         FROM grants
         WHERE grant_id = $1`,
        [grantId],
      )).rows[0] || null
    : getOne(referenceQueries.grantsGetScopedStateById, [grantId]);
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
  return deriveReferenceFreshness({ recordLastUpdatedAt: lastUpdated });
}

function getConnectorRunEvidenceSource(source) {
  return source?.kind === 'connector' && typeof source.id === 'string' && source.id
    ? source.id
    : null;
}

async function getLatestConnectorRunSummary(connectorId, status = null) {
  if (!connectorId) {
    return null;
  }
  const filters = status
    ? { sourceKind: 'connector', sourceId: connectorId, status, limit: 1 }
    : { sourceKind: 'connector', sourceId: connectorId, limit: 1 };
  const { summaries } = await listSpineCorrelations('run', filters);
  const summary = summaries[0] || null;
  if (!summary) {
    return null;
  }
  return {
    last_at: summary.last_at,
    status: summary.status,
  };
}

function getManifestRefreshPolicy(manifest) {
  const capabilities = manifest?.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return null;
  }
  return capabilities.refresh_policy ?? null;
}

function getMaximumStalenessSeconds(refreshPolicy) {
  if (!refreshPolicy || typeof refreshPolicy !== 'object' || Array.isArray(refreshPolicy)) {
    return null;
  }
  const value = refreshPolicy.maximum_staleness_seconds;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

async function getConnectorFreshnessEvidence({ source, manifest }) {
  const connectorId = getConnectorRunEvidenceSource(source);
  const refreshPolicy = getManifestRefreshPolicy(manifest);
  const [lastRun, lastSuccessfulRun] = await Promise.all([
    getLatestConnectorRunSummary(connectorId),
    getLatestConnectorRunSummary(connectorId, 'succeeded'),
  ]);
  return {
    lastRun,
    lastSuccessfulRun,
    maximumStalenessSeconds: getMaximumStalenessSeconds(refreshPolicy),
  };
}

function buildConnectorAwareFreshness(evidence, recordLastUpdatedAt = null) {
  return deriveReferenceFreshness({
    lastAttemptedAt: evidence?.lastRun?.last_at ?? null,
    lastAttemptStatus: evidence?.lastRun?.status ?? null,
    lastSuccessfulRunAt: evidence?.lastSuccessfulRun?.last_at ?? null,
    maximumStalenessSeconds: evidence?.maximumStalenessSeconds ?? null,
    recordLastUpdatedAt,
  });
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

function buildStreamMetadataEntry({
  manifestStream,
  streamGrant = null,
  grantStreams = [],
  freshness = null,
  grantedConnections = null,
}) {
  const expandStreamGrant = streamGrant
    ? { ...streamGrant, grantStreams }
    : null;
  const entry = {
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
  if (Array.isArray(grantedConnections)) {
    entry.granted_connections = grantedConnections;
  }
  return entry;
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

function buildStreamDiscoverySummary({ connectorId = null, stream, summary = null, freshnessEvidence = null }) {
  const lastUpdated = summary?.last_updated || null;
  return {
    object: 'stream',
    name: stream.name,
    record_count: summary?.record_count || 0,
    last_updated: lastUpdated,
    freshness: buildConnectorAwareFreshness(freshnessEvidence, lastUpdated),
    capabilities: buildStreamDiscoveryCapabilities({ connectorId, stream }),
  };
}

async function buildConnectorSchemaItem({ source, storageBinding, manifest, grant = null, ownerSubjectId = null }) {
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
  const freshnessEvidence = await getConnectorFreshnessEvidence({ source, manifest });

  // Look up granted connections once per connector. For polyfill connectors
  // we batch a single owner+connector store query and reuse the result for
  // every stream entry, narrowing per-stream by `grant.streams[].connection_id`
  // when the grant pins a single connection. For provider_native sources we
  // omit the field — those grants do not address a connection_id.
  let activeBindings = null;
  if (connectorId && ownerSubjectId) {
    activeBindings = await listGrantedConnectionsForStream({
      ownerSubjectId,
      connectorId,
      grantStreamConnectionId: null,
    });
  }

  const streams = visibleStreams.map((manifestStream) => {
    const lastUpdated = summaryByName.get(manifestStream.name)?.last_updated || null;
    const streamGrant = grantStreamByName ? grantStreamByName.get(manifestStream.name) || null : null;
    let grantedConnections = null;
    if (activeBindings) {
      const pin = streamGrant?.connection_id || null;
      grantedConnections = pin
        ? activeBindings.filter((entry) => entry.connection_id === pin)
        : activeBindings;
    }
    return buildStreamMetadataEntry({
      manifestStream,
      streamGrant,
      grantStreams,
      freshness: buildConnectorAwareFreshness(freshnessEvidence, lastUpdated),
      grantedConnections,
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
  const freshnessEvidence = await getConnectorFreshnessEvidence({ source, manifest });

  const item = {
    object: 'connector',
    source,
    stream_count: visibleStreams.length,
    streams: visibleStreams.map((stream) => buildStreamDiscoverySummary({
      connectorId,
      stream,
      summary: summaryByName.get(stream.name) || null,
      freshnessEvidence,
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

/**
 * Build the canonical request URL for `links.self`. Echoes the effective
 * request path plus its query string so callers can replay the exact call
 * without reconstructing query state. Falls back to `req.path` when no
 * query string is present.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Public read responses SHALL be canonical envelopes")
 */
function buildSelfLink(req) {
  if (!req) return null;
  const path = typeof req.path === 'string' ? req.path : null;
  if (!path) return null;
  // Fastify exposes the raw URL (path + query) on `req.url` and on
  // `req.raw.url`; prefer those so query order matches what the client sent.
  const rawUrl = typeof req.url === 'string' && req.url
    ? req.url
    : (req.raw && typeof req.raw.url === 'string' ? req.raw.url : null);
  if (rawUrl && rawUrl.startsWith('/')) return rawUrl;
  return path;
}

/**
 * Build a `links.next` URL by re-applying the operation's opaque cursor
 * onto the same path. Returns `null` when there is no further page (the
 * canonical contract treats absent / null `links.next` identically).
 */
function buildNextLink(req, payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.has_more !== true) return null;
  const path = typeof req?.path === 'string' ? req.path : null;
  if (!path) return null;

  // Carry every cursor variant the operation may emit: the canonical opaque
  // `next_cursor`, and the legacy `next_changes_since` cursor used by the
  // changes_since branch. The wire next-link is a server-issued URL the
  // client follows verbatim; we do not commit to a cursor key format here.
  const nextCursor = typeof payload.next_cursor === 'string' && payload.next_cursor
    ? payload.next_cursor
    : null;
  const nextChangesSince = typeof payload.next_changes_since === 'string' && payload.next_changes_since
    ? payload.next_changes_since
    : null;
  if (!nextCursor && !nextChangesSince) return null;

  // Strip cursor/changes_since from the original request before re-stamping
  // so a relayed link replaces the previous cursor instead of compounding.
  const rawUrl = typeof req.url === 'string' && req.url ? req.url : path;
  const queryStart = rawUrl.indexOf('?');
  const queryPart = queryStart >= 0 ? rawUrl.slice(queryStart + 1) : '';
  const sanitized = new URLSearchParams(queryPart);
  sanitized.delete('cursor');
  sanitized.delete('changes_since');
  if (nextCursor) sanitized.set('cursor', nextCursor);
  if (nextChangesSince) sanitized.set('changes_since', nextChangesSince);
  const finalQuery = sanitized.toString();
  return finalQuery ? `${path}?${finalQuery}` : path;
}

/**
 * Project a public-read operation envelope onto the canonical contract:
 * `{ object, data, has_more?, links: { self, next }, meta: { count, warnings } }`.
 *
 * Backward-compatible fields the contract allows (`next_cursor`,
 * `next_changes_since`, `url`) are preserved. Operations that already
 * emitted a partial `meta` (e.g. `meta.warnings[]` for a deprecated alias
 * use) keep their warnings; the helper just guarantees the envelope SHAPE
 * is canonical.
 *
 * Single-object envelopes (records detail, schema) omit `has_more`. The
 * helper detects them by absence of `has_more` on the operation payload.
 */
function finalizeCanonicalEnvelope(payload, req) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const next = { ...payload };
  const self = buildSelfLink(req);
  const nextLink = buildNextLink(req, payload);
  next.links = {
    ...(payload.links && typeof payload.links === 'object' && !Array.isArray(payload.links) ? payload.links : {}),
  };
  if (self) next.links.self = self;
  // List-shaped envelopes always announce `links.next` (null when there is
  // no further page). Non-list envelopes omit `next` to keep wire shape
  // discriminated.
  if (Object.prototype.hasOwnProperty.call(payload, 'has_more')) {
    next.links.next = nextLink;
  }
  const existingMeta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
    ? payload.meta
    : null;
  const meta = { ...(existingMeta || {}) };
  if (!('count' in meta)) {
    meta.count = { kind: 'none' };
  }
  if (!('warnings' in meta)) {
    meta.warnings = [];
  }
  next.meta = meta;
  return next;
}

async function persistContentAddressedBlob({ connectorId, connectorInstanceId, stream, recordKey, mimeType, data }) {
  if (isPostgresStorageBackend()) {
    const stored = await postgresPersistContentAddressedBlob({ connectorId, connectorInstanceId, stream, recordKey, mimeType, data });
    if (stored.binding_inserted) {
      await applyRetainedSizeBlobDelta({
        connectorInstanceId,
        connectorId,
        stream,
        blobBytesDelta: Number(stored.size_bytes || 0),
        blobCountDelta: 1,
      });
    }
    return stored;
  }

  const sha256 = createHash('sha256').update(data).digest('hex');
  const blobId = `blob_sha256_${sha256}`;
  const sizeBytes = data.byteLength;
  const stored = transaction(() => {
    const insertResult = exec(referenceQueries.blobsInsertBlob, [
      blobId, connectorId, connectorInstanceId, stream, recordKey, mimeType, sizeBytes, sha256, data,
    ]);

    const row = getOne(referenceQueries.blobsGetStoredById, [blobId]);
    if (!row || row.sha256 !== sha256 || Number(row.size_bytes) !== sizeBytes) {
      const err = new Error('Blob storage collision');
      err.code = 'api_error';
      throw err;
    }

    const bindingResult = exec(referenceQueries.blobsInsertBinding, [blobId, connectorId, connectorInstanceId, stream, recordKey]);
    if (insertResult.changes > 0) {
      applyDatasetSummaryBlobDelta({ blobBytesDelta: sizeBytes });
    }
    if (bindingResult.changes > 0) {
      applyRetainedSizeBlobDelta({
        connectorInstanceId,
        connectorId,
        stream,
        blobBytesDelta: sizeBytes,
        blobCountDelta: 1,
      });
    }

    return row;
  });
  return {
    blob_id: blobId,
    sha256,
    size_bytes: Number(stored.size_bytes),
    mime_type: stored.mime_type || mimeType,
  };
}

async function getVisibleStreamFreshness({ tokenInfo, source, storageBinding, stream, manifest }) {
  const freshnessEvidence = await getConnectorFreshnessEvidence({ source, manifest });
  if (tokenInfo?.pdpp_token_kind === 'owner') {
    const summaries = await listAllStreams(storageBinding);
    const summary = summaries.find((entry) => entry.name === stream);
    return buildConnectorAwareFreshness(freshnessEvidence, summary?.last_updated || null);
  }

  const streamGrant = tokenInfo?.grant?.streams?.find((entry) => entry.name === stream);
  if (!streamGrant) {
    const err = new Error(`Stream '${stream}' not in grant`);
    err.code = 'grant_stream_not_allowed';
    throw err;
  }
  const summaries = await listStreams(storageBinding, { streams: [streamGrant] }, manifest);
  return buildConnectorAwareFreshness(freshnessEvidence, summaries[0]?.last_updated || null);
}

// ─── AS App ─────────────────────────────────────────────────────────────────

function buildAsApp(opts = {}) {
  const app = createApp({ logger: opts.logger });
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  const referenceRevision = resolveReferenceRevision(opts);
  // Allow tests / fixture-backed smokes to pin the server to an old or
  // alternate accepted-protocol set so we can exercise the 409
  // collector_protocol_mismatch path without bumping the global
  // SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS. Falls back to the global set
  // for normal operation.
  const acceptedCollectorProtocolVersions = Array.isArray(opts.acceptedCollectorProtocolVersions)
    && opts.acceptedCollectorProtocolVersions.length > 0
    ? Object.freeze([...opts.acceptedCollectorProtocolVersions])
    : SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS;
  const controller = opts.controller || null;
  const consentStore = createConsentStore();
  const ownerDeviceAuthStore = createOwnerDeviceAuthStore();
  const deviceExporterStore = opts.deviceExporterStore || createDeviceExporterStore();
  const webPushStore = opts.webPushSubscriptionStore || createWebPushSubscriptionStore();
  const webPushConfig = opts.webPushConfig || resolveWebPushConfig();
  const dynamicClientRegistrationEnabled = resolveDynamicClientRegistrationEnabled(opts);
  const dynamicClientRegistrationInitialAccessTokens = resolveDynamicClientRegistrationInitialAccessTokens(opts);
  const publicDcrRateLimiter = createPublicDcrRateLimiter(opts.publicDynamicClientRegistrationRateLimit);
  const ownerAuthConfig = resolveOwnerAuthPlaceholderConfig(opts);
  const ownerAuth = createOwnerAuthPlaceholder({
    password: ownerAuthConfig.password,
    subjectId: ownerAuthConfig.subjectId,
    sessionTtlSeconds: ownerAuthConfig.sessionTtlSeconds,
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

  // AS root (`GET /`) is mounted via `server/routes/root-and-discovery.ts`
  // per OpenSpec change `split-reference-server-by-route-family`. Behaviour-
  // preserving extraction: same mount point, same handler, same envelope.
  mountAsRoot(app, {
    providerName,
    referenceRevision,
    servedRootLandingIfBrowser,
  });

  // Reference-only owner-auth placeholder. This is NOT a public PDPP
  // protocol surface; it gates local approval UIs when
  // `PDPP_OWNER_PASSWORD` is set, and is a no-op otherwise. See
  // `reference-implementation/server/owner-auth.js`.
  ownerAuth.attachRoutes(app);

  function getOwnerSubjectId(req) {
    return req.ownerSession?.sub || ownerAuth.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID;
  }

  // `resolveRefConnectorNamespace`, `resolveRefConnectionNamespace`,
  // `projectRefConnection`, and `sendRefConnectionDetail` moved to
  // `server/routes/ref-connectors.ts` along with the routes that consumed
  // them. The host still exposes `resolveOwnerConnectorNamespace`,
  // `getOwnerSubjectId`, `createRequestConnectorInstanceStore`, and the
  // controller surface; the adapter wires those into the per-route
  // helpers.

  // Reject any device-exporter ingest/heartbeat/state request whose
  // X-PDPP-Collector-Protocol header is not in the server's accepted set.
  // Returns true when a 409 was written. Callers must short-circuit. Runs
  // BEFORE record/state persistence and BEFORE heartbeat row updates, so a
  // rejected mismatch never widens any device-scoped capability. Spec:
  // openspec/changes/publish-pdpp-local-collector/specs/
  // reference-implementation-architecture/spec.md
  function enforceCollectorProtocolVersion(req, res) {
    const received = readCollectorProtocolHeader(req.headers);
    if (!isAcceptedCollectorProtocolVersion(received, acceptedCollectorProtocolVersions)) {
      const body = {
        error: {
          type: typeFor(409),
          code: 'collector_protocol_mismatch',
          message: received
            ? `Collector protocol version '${received}' is not accepted by this reference server.`
            : 'Collector protocol version header X-PDPP-Collector-Protocol is required.',
          ...buildCollectorProtocolMismatchBody(received, acceptedCollectorProtocolVersions),
        },
      };
      body.error.request_id = ensureRequestId(res);
      res.status(409).json(body);
      return true;
    }
    return false;
  }

  async function requireDeviceExporterCredential(req, res, next) {
    try {
      // Reject incompatible collector protocol versions before any device
      // capability is established. The check sits ahead of credential
      // introspection so an outdated runner can't even prove its token to
      // mint a record on this server. Spec: openspec/changes/
      // publish-pdpp-local-collector.
      if (enforceCollectorProtocolVersion(req, res)) {
        return;
      }
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return pdppError(res, 401, 'authentication_error', 'Missing device exporter bearer token');
      }
      const token = auth.slice(7);
      const tokenInfo = await introspect(token);
      if (tokenInfo.active) {
        return pdppError(res, 403, 'permission_error', 'Owner/client bearer tokens are not valid device exporter credentials');
      }

      const credential = await deviceExporterStore.findCredentialByTokenHash(hashDeviceSecret(token));
      if (!credential || credential.status !== 'active') {
        return pdppError(res, 401, 'authentication_error', 'Invalid or revoked device exporter credential');
      }
      const device = await deviceExporterStore.getDevice(credential.deviceId);
      if (!device || device.status !== 'active') {
        return pdppError(res, 401, 'authentication_error', 'Invalid or revoked device exporter credential');
      }
      await deviceExporterStore.markCredentialUsed(credential.credentialId, new Date().toISOString());
      req.deviceExporterCredential = credential;
      req.deviceExporter = device;
      next();
    } catch (err) {
      handleError(res, err);
    }
  }

  // Reference-internal run target registry. Holds the per-(runId, interactionId)
  // CDP page-target ws URL the connector runtime / browser binding registers
  // when a manual_action interaction needs an exact page handoff. The
  // streaming companion factory consults this registry by `(runId, interactionId)`
  // to resolve the target. NOT a PDPP wire surface — admin/internal only,
  // gated behind EITHER the device-exporter authority (Mode B, collector-runner)
  // OR a per-run nonce minted by the controller (Mode A, in-process runtime).
  // The nonce is per-run (not per-interaction): the run's connector child is
  // the single authority allowed to register targets for any interaction that
  // arises during that run.
  // See `reference-implementation/server/streaming/run-target-registry.js`.
  //
  // Caller-provided registries are accepted so the controller and the route
  // layer share one instance — the controller needs to register/clear
  // per-run nonces it mints at spawn time, and the routes need to verify
  // them at registration time. Tests that build an asApp standalone still
  // get a self-owned registry; the route layer is unchanged.
  const runTargetRegistry = opts.runTargetRegistry || createRunTargetRegistry({ logger: opts.streamingLogger });
  runTargetRegistry.attachRoutes(app, requireDeviceExporterCredential);

  async function buildDeviceExporterDiagnostics(ownerSubjectId) {
    const [devices, sourceInstances, outcomes] = await Promise.all([
      deviceExporterStore.listDevices(ownerSubjectId),
      deviceExporterStore.listSourceInstances(),
      deviceExporterStore.listBatchOutcomes({ limit: 5000 }),
    ]);
    const now = Date.now();
    const sourcesByDevice = new Map();
    const outcomeStats = new Map();
    const devicesById = new Map(devices.map((device) => [device.deviceId, device]));
    const connectorInstances = await createRequestConnectorInstanceStore().listByOwner(ownerSubjectId);
    const connectorInstancesById = new Map(connectorInstances.map((instance) => [instance.connectorInstanceId, instance]));
    const connectorInstancesByBinding = new Map(connectorInstances.map((instance) => [
      `${instance.connectorId}\n${instance.sourceKind}\n${instance.sourceBindingKey}`,
      instance,
    ]));

    // Aggregate pending local-collector gap rows by the source instance
    // that produced them. Without this, every device sharing a connector
    // type collapses into the same connector-level gap count and an
    // operator cannot tell whether "Codex" is unhealthy on laptop A or
    // laptop B. Each gap stores the producing source in `source_json`
    // (kind=local_device, device_id, source_instance_id).
    const connectorIds = new Set();
    for (const source of sourceInstances) {
      if (source.connectorId) connectorIds.add(source.connectorId);
    }
    const detailGapStore = getDefaultConnectorDetailGapStore();
    const localCollectorGapStats = new Map();
    const localCollectorGapUnreliableConnectorIds = new Set();
    if (typeof detailGapStore.listPendingGapsForConnector === 'function') {
      for (const connectorId of connectorIds) {
        let gaps = [];
        try {
          gaps = await detailGapStore.listPendingGapsForConnector(connectorId, { limit: 500 });
        } catch {
          // Do not fail the whole device-exporter projection on a single
          // detail-gap store read, but also do not render a false zero.
          // Each source for this connector gets local_collector_gaps.unreliable=true.
          localCollectorGapUnreliableConnectorIds.add(connectorId);
          gaps = [];
        }
        for (const gap of gaps) {
          if (!gap || gap.status !== 'pending') continue;
          const source = gap.source && typeof gap.source === 'object' ? gap.source : null;
          if (!source || source.kind !== 'local_device') continue;
          const sourceInstanceId = typeof source.source_instance_id === 'string' ? source.source_instance_id : null;
          if (!sourceInstanceId) continue;
          const current = localCollectorGapStats.get(sourceInstanceId) || {
            pending: 0,
            lastUpdatedAt: null,
            reasons: new Set(),
          };
          current.pending += 1;
          if (!current.lastUpdatedAt || (gap.updated_at && gap.updated_at > current.lastUpdatedAt)) {
            current.lastUpdatedAt = gap.updated_at ?? current.lastUpdatedAt;
          }
          if (typeof gap.reason === 'string' && gap.reason) current.reasons.add(gap.reason);
          localCollectorGapStats.set(sourceInstanceId, current);
        }
      }
    }

    for (const outcome of outcomes) {
      const key = outcome.sourceInstanceId;
      const current = outcomeStats.get(key) || {
        accepted: 0,
        rejected: 0,
        lastIngestAt: null,
      };
      if (outcome.status === 'accepted') {
        current.accepted += outcome.response?.accepted_record_count ?? 0;
      } else if (outcome.status === 'rejected') {
        current.rejected += outcome.response?.rejected_record_count ?? 0;
      }
      if (!current.lastIngestAt || outcome.createdAt > current.lastIngestAt) {
        current.lastIngestAt = outcome.createdAt;
      }
      outcomeStats.set(key, current);
    }

    for (const source of sourceInstances) {
      const stats = outcomeStats.get(source.sourceInstanceId) || {
        accepted: 0,
        rejected: 0,
        lastIngestAt: null,
      };
      const device = devicesById.get(source.deviceId);
      const identityKey = makeConnectorInstanceSourceBindingKey(
        deviceExporterSourceBindingIdentity(source.localBindingId),
      );
      const connectorInstance = source.connectorInstanceId
        ? connectorInstancesById.get(source.connectorInstanceId)
        : device
          ? connectorInstancesByBinding.get(`${source.connectorId}\nlocal_device\n${identityKey}`)
          : null;
      const gapStats = localCollectorGapStats.get(source.sourceInstanceId) || null;
      const outboxDiagnostics = source.outboxDiagnostics ?? null;
      const projected = {
        object: 'device_source_instance',
        source_instance_id: source.sourceInstanceId,
        connector_instance_id: connectorInstance?.connectorInstanceId ?? null,
        device_id: source.deviceId,
        connector_id: source.connectorId,
        local_binding_name: source.localBindingId,
        display_name: source.displayName,
        created_at: source.createdAt,
        last_ingest_at: stats.lastIngestAt,
        accepted_record_count: stats.accepted,
        rejected_record_count: stats.rejected,
        // Per-source heartbeat state — distinguishes a stalled collector
        // on one device from a healthy collector on another device that
        // shares the same connector type.
        last_heartbeat_at: source.lastHeartbeatAt ?? null,
        last_heartbeat_status: source.lastHeartbeatStatus ?? null,
        records_pending: source.recordsPending ?? null,
        outbox_diagnostics: outboxDiagnostics,
        outbox_state: deriveSourceInstanceOutboxState(outboxDiagnostics),
        // Pending local-collector gaps scoped to THIS source instance.
        // Diagnostics consumers can render a per-source backlog without
        // attributing one device's gap to another.
        local_collector_gaps: {
          pending_count: gapStats ? gapStats.pending : 0,
          reasons: gapStats ? [...gapStats.reasons].sort() : [],
          last_updated_at: gapStats ? gapStats.lastUpdatedAt : null,
          unreliable: localCollectorGapUnreliableConnectorIds.has(source.connectorId),
        },
        last_error: source.lastError,
      };
      const list = sourcesByDevice.get(source.deviceId) || [];
      list.push(projected);
      sourcesByDevice.set(source.deviceId, list);
    }

    return devices.map((device) => {
      const sourceList = sourcesByDevice.get(device.deviceId) || [];
      const lastIngestAt = sourceList.reduce(
        (latest, source) => (!latest || (source.last_ingest_at && source.last_ingest_at > latest) ? source.last_ingest_at : latest),
        null,
      );
      const lastHeartbeatAt = device.lastHeartbeatAt ?? null;
      const stale = Boolean(
        lastHeartbeatAt
        && Number.isFinite(Date.parse(lastHeartbeatAt))
        && now - Date.parse(lastHeartbeatAt) > 5 * 60 * 1000
      );
      return {
        object: 'device_exporter',
        device_id: device.deviceId,
        subject_id: device.ownerSubjectId,
        display_name: device.displayName,
        status: device.status,
        created_at: device.createdAt,
        last_heartbeat_at: lastHeartbeatAt,
        last_ingest_at: lastIngestAt,
        revoked_at: device.revokedAt,
        stale,
        source_instances: sourceList,
        last_error: device.lastError,
      };
    });
  }

  function deriveSourceInstanceOutboxState(diagnostics) {
    if (!diagnostics || typeof diagnostics !== 'object') return 'unknown';
    if ((diagnostics.dead_letter ?? 0) > 0) return 'dead_letter';
    if ((diagnostics.stale_leases ?? 0) > 0) return 'stale';
    if ((diagnostics.retrying ?? 0) > 0) return 'retrying';
    if ((diagnostics.pending ?? 0) > 0) return 'pending';
    if ((diagnostics.backlog_open ?? 0) > 0) return 'backlog';
    return 'drained';
  }

  function normalizeHeartbeatSourceInstances(body) {
    if (Array.isArray(body.source_instances)) {
      // The array form carries per-source state today; the top-level
      // `status` / `records_pending` apply to a single-source heartbeat.
      return body.source_instances;
    }
    if (typeof body.source_instance_id === 'string') {
      return [
        {
          source_instance_id: body.source_instance_id,
          last_error: body.last_error ?? null,
          status: typeof body.status === 'string' ? body.status : null,
          records_pending:
            typeof body.records_pending === 'number' ? body.records_pending : null,
          outbox: body.outbox ?? null,
        },
      ];
    }
    return [];
  }

  // Stable identity for a local-device connector_instance.
  //
  // We deliberately exclude `device_id` and `source_instance_id` from the
  // hashed identity: both are minted fresh on every enroll, so including
  // them would cause repeated enrollments for the same owner-chosen binding
  // to fork a new connector_instances row instead of resuming the existing
  // one. The owner-chosen `local_binding_name` is the semantic key — it is
  // the persistent name the owner assigned to "this binding" when they
  // created the enrollment code.
  function deviceExporterSourceBindingIdentity(localBindingName) {
    return {
      kind: 'local_device',
      local_binding_name: localBindingName,
    };
  }

  // Full source_binding payload stored as source_binding_json on the
  // connector_instances row. The volatile fields are intentionally kept
  // here for debugging/inspection but they do NOT contribute to the
  // source_binding_key (see deviceExporterSourceBindingIdentity).
  function deviceExporterSourceBinding(deviceId, sourceInstance) {
    return {
      kind: 'local_device',
      device_id: deviceId,
      local_binding_name: sourceInstance.localBindingId,
      source_instance_id: sourceInstance.sourceInstanceId,
    };
  }

  async function resolveActiveDeviceConnectorInstance(deviceId, ownerSubjectId, sourceInstance) {
    const store = createRequestConnectorInstanceStore();
    if (sourceInstance.connectorInstanceId) {
      const instance = await store.get(sourceInstance.connectorInstanceId);
      if (
        instance
        && instance.status === 'active'
        && instance.ownerSubjectId === ownerSubjectId
        && instance.connectorId === sourceInstance.connectorId
      ) {
        return instance;
      }
      return null;
    }
    const identity = deviceExporterSourceBindingIdentity(sourceInstance.localBindingId);
    const instance = await store.getByBinding({
      ownerSubjectId,
      connectorId: sourceInstance.connectorId,
      sourceKind: 'local_device',
      sourceBindingKey: makeConnectorInstanceSourceBindingKey(identity),
    });
    if (!instance || instance.status !== 'active') {
      return null;
    }
    return instance;
  }

  async function resolveAuthorizedDeviceSource(req, res, deviceId, sourceInstanceId, { notFoundStatus = 400 } = {}) {
    const sourceInstance = await deviceExporterStore.getSourceInstance(deviceId, sourceInstanceId);
    if (!sourceInstance || sourceInstance.status !== 'active') {
      pdppError(res, notFoundStatus, notFoundStatus === 404 ? 'not_found' : 'invalid_request', `Unknown source_instance_id '${sourceInstanceId}'`, 'source_instance_id');
      return null;
    }
    const connectorInstance = await resolveActiveDeviceConnectorInstance(deviceId, req.deviceExporter.ownerSubjectId, sourceInstance);
    if (!connectorInstance || connectorInstance.ownerSubjectId !== req.deviceExporter.ownerSubjectId) {
      pdppError(res, 403, 'permission_error', 'source_instance_id is not authorized for an active connector instance', 'source_instance_id');
      return null;
    }
    return { sourceInstance, connectorInstance };
  }

  function normalizeDeviceIngestRecords(body) {
    if (!Array.isArray(body.records) || body.records.length === 0) {
      const err = new Error('records must be a non-empty array');
      err.code = 'invalid_request';
      err.param = 'records';
      throw err;
    }
    return body.records.map((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        const err = new Error(`records[${index}] must be an object`);
        err.code = 'invalid_request';
        err.param = 'records';
        throw err;
      }
      const key = record.record_key ?? record.key;
      if (key == null || (typeof key !== 'string' && !Array.isArray(key))) {
        const err = new Error(`records[${index}].record_key is required`);
        err.code = 'invalid_request';
        err.param = 'records';
        throw err;
      }
      return {
        stream: requireNonEmptyString(record.stream, `records[${index}].stream`),
        key,
        emitted_at: typeof record.emitted_at === 'string' ? record.emitted_at : undefined,
        data: optionalObject(record.data) || {},
      };
    });
  }

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

  const agentConnectAttempts = new Map();

  function pruneAgentConnectAttempts(now = Date.now()) {
    for (const [id, attempt] of agentConnectAttempts) {
      if (attempt.status !== 'pending' || attempt.expiresAt <= now) {
        agentConnectAttempts.delete(id);
      }
    }
  }

  function publicAgentConnectAttempt(attempt) {
    return {
      id: attempt.id,
      object: 'agent_connect_attempt',
      status: attempt.status,
      approval_url: attempt.approvalUrl,
      poll_url: attempt.tokenUrl,
      token_url: attempt.tokenUrl,
      expires_in: Math.max(Math.ceil((attempt.expiresAt - Date.now()) / 1000), 0),
      interval: attempt.interval,
    };
  }

  function parseAuthorizeAuthorizationDetails(query) {
    const raw = query?.authorization_details;
    if (raw == null || raw === '') return null;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') {
      const err = new Error('authorization_details must be JSON');
      err.code = 'invalid_request';
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        const err = new Error('authorization_details must decode to an array');
        err.code = 'invalid_request';
        throw err;
      }
      return parsed;
    } catch (err) {
      err.code = err.code || 'invalid_request';
      throw err;
    }
  }

  function requireAuthorizeString(query, name) {
    const value = query?.[name];
    if (typeof value !== 'string' || !value.trim()) {
      const err = new Error(`${name} is required`);
      err.code = 'invalid_request';
      throw err;
    }
    return value.trim();
  }

  function requireRegisteredRedirectUri(client, redirectUri) {
    const redirectUris = Array.isArray(client?.metadata?.redirect_uris)
      ? client.metadata.redirect_uris
      : [];
    if (!redirectUris.includes(redirectUri)) {
      const err = new Error('redirect_uri does not match a registered redirect URI');
      err.code = 'invalid_request';
      throw err;
    }
  }

  function validateAuthorizePkce({ responseType, codeChallenge, codeChallengeMethod }) {
    if (responseType !== 'code') {
      const err = new Error('response_type must be code');
      err.code = 'unsupported_response_type';
      throw err;
    }
    if (codeChallengeMethod !== 'S256') {
      const err = new Error('code_challenge_method must be S256');
      err.code = 'invalid_request';
      throw err;
    }
    if (typeof codeChallenge !== 'string' || codeChallenge.length < 43 || codeChallenge.length > 128) {
      const err = new Error('code_challenge must be 43-128 characters');
      err.code = 'invalid_request';
      throw err;
    }
  }

  function buildHostedMcpAuthorizationDetailsForConnector(connectorId) {
    return [
      {
        type: 'https://pdpp.org/data-access',
        source: { kind: 'connector', id: connectorId },
        purpose_code: 'https://pdpp.org/purpose/personal_ai_assistant',
        purpose_description: 'Allow this MCP client to read selected personal data through PDPP.',
        access_mode: 'continuous',
        retention: {
          classification: 'client_policy',
          description: 'The MCP client controls any retention of fetched results.',
        },
        streams: [{ name: '*' }],
      },
    ];
  }

  // Hosted MCP picker policy — what the owner is approving when they check
  // a row in the multi-source picker. Continuous, all streams, client-policy
  // retention. Encoded once so the picker's "what you're approving" copy,
  // the authorization_details[] sent to the AS, and the per-child grants
  // match by construction.
  const HOSTED_MCP_PICKER_PURPOSE_CODE = 'https://pdpp.org/purpose/personal_ai_assistant';
  const HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION = 'Allow this MCP client to read selected personal data through PDPP.';
  const HOSTED_MCP_PICKER_ACCESS_MODE = 'continuous';
  const HOSTED_MCP_PICKER_RETENTION = Object.freeze({
    classification: 'client_policy',
    description: 'The MCP client controls any retention of fetched results.',
  });

  // Build one source-bounded authorization_details entry for a hosted MCP
  // package. `streamNames` is the owner-approved subset of stream names for
  // this source. Passing `null` (or omitting the argument) preserves the
  // legacy default of `[{ name: '*' }]` for callers — including the
  // `connector_id=` shortcut on `/oauth/authorize/mcp-package` — that have
  // not yet been wired through the per-stream picker. When `streamNames` is
  // provided, it MUST be a non-empty array of names that the picker has
  // already validated against the connector manifest; callers SHOULD pass
  // `null` instead of an empty array because the AS rejects empty
  // `streams[]` arrays in `normalizePendingGrantRequest`.
  function buildHostedMcpAuthorizationDetailForConnector(connectorId, streamNames = null) {
    let streams;
    if (Array.isArray(streamNames) && streamNames.length > 0) {
      streams = streamNames.map((name) => ({ name }));
    } else {
      streams = [{ name: '*' }];
    }
    return {
      type: 'https://pdpp.org/data-access',
      source: { kind: 'connector', id: connectorId },
      purpose_code: HOSTED_MCP_PICKER_PURPOSE_CODE,
      purpose_description: HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION,
      access_mode: HOSTED_MCP_PICKER_ACCESS_MODE,
      retention: HOSTED_MCP_PICKER_RETENTION,
      streams,
    };
  }

  async function listHostedMcpPickerRows(ownerSubjectId = 'owner_local') {
    const connectorIds = await listRegisteredConnectorIds();
    const rows = [];
    for (const connectorId of connectorIds) {
      const manifest = await getConnectorManifest(connectorId).catch(() => null);
      if (!manifest) continue;
      const connectorLabel = manifest.display_name || manifest.name || connectorId;
      // Display token for the meta sub-line. Prefer the canonical short
      // connector key (`gmail`, `claude-code`) so the picker does not leak
      // URL-shaped first-party connector ids
      // (`https://registry.pdpp.org/connectors/...`) into owner-facing
      // copy. For unknown / custom third-party connectors the helper
      // returns `null`; we fall back to the original id so the row still
      // carries a stable identifier the operator can grep for.
      const connectorMetaToken = canonicalConnectorKey(connectorId) ?? connectorId;
      const manifestStreams = Array.isArray(manifest.streams) ? manifest.streams : [];
      const streamCount = manifestStreams.length;
      // Snapshot the stream list so each row can render an independent
      // per-stream checkbox. The picker defaults every checkbox to
      // checked; deselecting one narrows that source's child grant.
      const streamSummaries = manifestStreams.map((stream) => ({
        name: stream.name,
        description: typeof stream.description === 'string' ? stream.description : null,
      }));
      const connections = await listActiveBindingsForGrant({ ownerSubjectId, connectorId }).catch(() => []);
      if (connections.length === 0) {
        // Connector with no configured connection — show the connector
        // itself; child grant will not pin a connection_id. The selection
        // value is an opaque base64url(JSON) payload so URL-shaped connector
        // ids cannot collide with any wrapping delimiter on the wire.
        rows.push({
          formValue: encodeHostedMcpSelection({ connectorId, connectionId: null }),
          connectorId,
          connectionId: null,
          label: connectorLabel,
          meta: streamCount
            ? `${connectorMetaToken} · ${streamCount} streams · no configured connection`
            : `${connectorMetaToken} · no configured connection`,
          streams: streamSummaries,
        });
        continue;
      }
      for (const conn of connections) {
        const projected = projectBindingForWire(conn);
        const displayName = projected?.display_name;
        const connectionId = projected?.connection_id || conn.connectorInstanceId;
        rows.push({
          formValue: encodeHostedMcpSelection({ connectorId, connectionId }),
          connectorId,
          connectionId,
          label: displayName ? `${connectorLabel} — ${displayName}` : connectorLabel,
          meta: streamCount
            ? `${connectorMetaToken} · ${streamCount} streams · ${connectionId}`
            : `${connectorMetaToken} · ${connectionId}`,
          streams: streamSummaries,
        });
      }
    }
    rows.sort((a, b) => a.label.localeCompare(b.label));
    return rows;
  }

  async function renderHostedMcpSourceSelection(req, query, csrfToken) {
    const ownerSubjectId = req?.ownerAuth?.subjectId || 'owner_local';
    const rows = await listHostedMcpPickerRows(ownerSubjectId);

    const hidden = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method']
      .map((name) => {
        const value = query?.[name];
        if (typeof value !== 'string') return '';
        return `<input type="hidden" name="${hostedEscape(name)}" value="${hostedEscape(value)}" />`;
      })
      .join('\n');

    const renderRowStreams = (row) => {
      if (!Array.isArray(row.streams) || row.streams.length === 0) {
        return '<p class="hosted-ui-option-streams-empty">This connector manifest declares no streams.</p>';
      }
      const items = row.streams
        .map((stream) => {
          const streamFormValue = encodeHostedMcpStreamSelection({
            connectorId: row.connectorId,
            connectionId: row.connectionId,
            streamName: stream.name,
          });
          const description = stream.description
            ? `<span class="hosted-ui-stream-meta">${hostedEscape(stream.description)}</span>`
            : '';
          return `
            <label class="hosted-ui-stream-option">
              <input type="checkbox" name="stream" value="${hostedEscape(streamFormValue)}" checked />
              <span class="hosted-ui-stream-option-body">
                <span class="hosted-ui-stream-name">${hostedEscape(stream.name)}</span>
                ${description}
              </span>
            </label>
          `;
        })
        .join('\n');
      return `<div class="hosted-ui-option-streams">${items}</div>`;
    };

    const options = rows.length
      ? rows.map((row) => `
          <fieldset class="hosted-ui-option-source">
            <legend class="hosted-ui-option-source-legend">
              <label class="hosted-ui-option">
                <input type="checkbox" name="selection" value="${hostedEscape(row.formValue)}" />
                <span class="hosted-ui-option-body">
                  <span class="hosted-ui-option-title">${hostedEscape(row.label)}</span>
                  <span class="hosted-ui-option-meta">${hostedEscape(row.meta)}</span>
                </span>
              </label>
            </legend>
            ${renderRowStreams(row)}
          </fieldset>
        `).join('\n')
      : '<p class="pdpp-body">No connector manifests are registered on this reference server.</p>';

    const submit = rows.length
      ? '<button type="submit" class="hosted-ui-button" data-variant="primary">Approve selected sources</button>'
      : '';

    // Cumulative-risk disclosure: this picker is reference-experimental
    // multi-source consent. Surface what the owner is approving so the
    // path of least resistance is not "approve everything in silence."
    // See openspec/changes/design-fast-broad-agent-consent/.
    const riskCopy = rows.length
      ? `<p class="pdpp-body"><strong>Reference-experimental multi-source consent.</strong> Each checked source issues one independent, source-bounded PDPP grant. Within a source you can uncheck individual streams to narrow what the MCP client may read; an unchecked stream is excluded from the issued child grant. Access mode: continuous, client-policy retention.</p>`
      : '';

    return renderHostedDocument({
      title: `${providerName} — Choose MCP sources`,
      providerName,
      body: [
        renderPageIntro({
          eyebrow: 'MCP authorization',
          title: 'Choose what this MCP client can read',
          lede: 'Select one or more sources to authorize for this MCP connection. The MCP endpoint remains read-only and grant-scoped.',
        }),
        renderSurface({
          surface: 'human',
          children: `
            ${riskCopy}
            <form method="POST" action="/oauth/authorize/mcp-package">
              <input type="hidden" name="_csrf" value="${hostedEscape(csrfToken)}" />
              ${hidden}
              <div class="hosted-ui-option-group">${options}</div>
              ${submit}
            </form>
          `,
        }),
      ].join('\n'),
    });
  }

  function completeAgentConnectAttempt(requestUri, outcome) {
    for (const attempt of agentConnectAttempts.values()) {
      if (attempt.requestUri !== requestUri || attempt.status !== 'pending') continue;
      attempt.status = outcome.status;
      attempt.completedAt = new Date().toISOString();
      if (outcome.status === 'approved') {
        attempt.token = outcome.token;
        attempt.grant = outcome.grant;
        attempt.grantId = outcome.grant?.grant_id || outcome.grantId || null;
      }
    }
  }

  function failAgentConnectAttempt(requestUri, status) {
    completeAgentConnectAttempt(requestUri, { status });
  }

  function buildAgentConnectError(status) {
    if (status === 'denied') {
      return { error: 'access_denied', error_description: 'Owner denied the scoped access request' };
    }
    if (status === 'expired') {
      return { error: 'expired_token', error_description: 'The agent-connect request expired before approval' };
    }
    return { error: 'authorization_pending', error_description: 'Owner approval is still pending' };
  }

  // Narrow hosted completion handoff for CLI `connect`: the CLI first stages a
  // normal PAR request, then registers that request_uri here to receive a
  // polling handle. Owner approval still happens through the existing consent
  // page, but the bearer is returned only to the caller holding the polling
  // code, never rendered into the owner browser.
  app.post('/agent-connect', async (req, res) => {
    try {
      const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
      const baseUrl = resolvePublicUrl(req, explicitBaseUrl);
      let requestUri = typeof req.body?.request_uri === 'string' ? req.body.request_uri : null;
      let clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : null;
      if (!requestUri) {
        const nativeManifest = resolveNativeManifest(opts);
        if (!nativeManifest?.provider_id || !nativeManifest?.storage_binding?.connector_id) {
          return pdppError(
            res,
            400,
            'invalid_request',
            'request_uri is required unless the reference provider is running with a native manifest',
          );
        }
        const clientName = typeof req.body?.client_name === 'string' && req.body.client_name.trim()
          ? req.body.client_name.trim()
          : 'PDPP CLI';
        clientId = clientId || PDPP_CLI_DEFAULT_CLIENT_ID;
        const staged = await consentStore.initiateGrant(
          {
            client_id: clientId,
            client_display: { name: clientName },
            authorization_details: [
              {
                type: 'https://pdpp.org/data-access',
                source: { kind: 'provider_native', id: nativeManifest.provider_id },
                purpose_code: 'https://pdpp.org/purpose/personal_assistant',
                purpose_description: 'Delegate scoped personal data access to a local PDPP CLI client.',
                access_mode: 'single_use',
                streams: [{ name: '*' }],
              },
            ],
          },
          { baseUrl, nativeManifest },
        );
        requestUri = staged.request_uri;
      }
      if (!requestUri) return pdppError(res, 400, 'invalid_request', 'request_uri is required');
      const { pending } = await getPendingGrantFromRequestUri(requestUri);
      if (!pending) return pdppError(res, 400, 'expired_token', 'Pending grant request is unknown or expired');
      if (clientId && pending.request?.client?.client_id !== clientId) {
        return pdppError(res, 403, 'invalid_client', 'client_id does not match pending request');
      }

      pruneAgentConnectAttempts();
      const id = `agc_${randomBytes(16).toString('hex')}`;
      const pollingCode = `agc_poll_${randomBytes(32).toString('hex')}`;
      const tokenUrl = `${baseUrl}/agent-connect/${encodeURIComponent(id)}/token`;
      const approvalUrl = new URL(`${baseUrl}/consent`);
      approvalUrl.searchParams.set('request_uri', requestUri);
      const attempt = {
        id,
        pollingCode,
        requestUri,
        clientId: pending.request?.client?.client_id || clientId || null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + (opts.agentConnectTtlMs || AGENT_CONNECT_TTL_MS),
        interval: 2,
        approvalUrl: approvalUrl.toString(),
        tokenUrl,
      };
      agentConnectAttempts.set(id, attempt);
      res.status(201).json({
        ...publicAgentConnectAttempt(attempt),
        polling_code: pollingCode,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/agent-connect/:attemptId/token', async (req, res) => {
    try {
      const attempt = agentConnectAttempts.get(req.params.attemptId);
      const pollingCode = typeof req.body?.polling_code === 'string' ? req.body.polling_code : null;
      if (!attempt || pollingCode !== attempt.pollingCode) {
        return pdppError(res, 401, 'invalid_grant', 'Unknown agent-connect polling handle');
      }
      if (attempt.status === 'pending' && attempt.expiresAt <= Date.now()) {
        attempt.status = 'expired';
      }
      if (attempt.status === 'pending') {
        return res.status(202).json({
          status: 'pending',
          ...buildAgentConnectError('pending'),
          interval: attempt.interval,
        });
      }
      if (attempt.status !== 'approved') {
        const error = buildAgentConnectError(attempt.status);
        agentConnectAttempts.delete(attempt.id);
        return pdppError(res, attempt.status === 'denied' ? 403 : 400, error.error, error.error_description);
      }
      agentConnectAttempts.delete(attempt.id);
      res.json({
        access_token: attempt.token,
        token_type: 'Bearer',
        grant_id: attempt.grantId,
        grant: attempt.grant,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // AS `/.well-known/oauth-authorization-server` is mounted via
  // `server/routes/root-and-discovery.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Behaviour-preserving
  // extraction: same mount point, same handler, same envelope.
  mountAsAuthorizationServerMetadata(app, {
    buildAuthorizationServerMetadata,
    dynamicClientRegistrationEnabled,
    publicClientMetadataForAuthorizationServer,
    rejectUntrustedMetadataHost,
    resolveExplicitIssuer: () =>
      opts.asIssuer ||
      opts.asPublicUrl ||
      (!opts.ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null),
    resolvePreRegisteredPublicClients: () => resolvePreRegisteredPublicClients(opts),
    resolvePublicUrl,
    trustedMetadataHosts: opts.trustedMetadataHosts,
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
    const authorizationHeader = req.headers.authorization || null;
    if (!authorizationHeader && !ownerSession) {
      const retryAfter = publicDcrRateLimiter.check(req);
      if (retryAfter) {
        res.setHeader('Retry-After', String(retryAfter));
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
            ...summarizeDcrRegisterRequest(req.body),
            error: {
              code: 'slow_down',
              message: 'Too many public client registration attempts; retry later',
            },
          },
        });
        return oauthError(
          res,
          429,
          'slow_down',
          'Too many public client registration attempts; retry later',
        );
      }
    }
    const outcome = await executeAsDcrRegister(
      {
        body: req.body,
        authorizationHeader,
        dcrEnabled: dynamicClientRegistrationEnabled,
        initialAccessTokens: resolveDynamicClientRegistrationInitialAccessTokensForRequest(
          req,
          dynamicClientRegistrationInitialAccessTokens,
        ),
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

  app.get('/oauth/authorize', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const clientId = requireAuthorizeString(req.query, 'client_id');
      const redirectUri = requireAuthorizeString(req.query, 'redirect_uri');
      const responseType = requireAuthorizeString(req.query, 'response_type');
      const codeChallenge = requireAuthorizeString(req.query, 'code_challenge');
      const codeChallengeMethod = requireAuthorizeString(req.query, 'code_challenge_method');
      const state = typeof req.query?.state === 'string' ? req.query.state : null;
      validateAuthorizePkce({ responseType, codeChallenge, codeChallengeMethod });

      const client = await getRegisteredClient(clientId);
      if (!client) return oauthError(res, 400, 'invalid_client', 'Unknown client_id');
      requireRegisteredRedirectUri(client, redirectUri);

      const authorizationDetails = parseAuthorizeAuthorizationDetails(req.query);
      const selectedConnectorId = typeof req.query?.connector_id === 'string' && req.query.connector_id.trim()
        ? req.query.connector_id.trim()
        : null;
      if (!authorizationDetails && !selectedConnectorId) {
        const csrfToken = ownerAuth.ensureCsrfToken(req, res);
        return res.send(await renderHostedMcpSourceSelection(req, req.query, csrfToken));
      }

      const details = authorizationDetails || buildHostedMcpAuthorizationDetailsForConnector(selectedConnectorId);
      const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
      const output = await consentStore.initiateGrant(
        {
          client_id: clientId,
          authorization_details: details,
        },
        {
          baseUrl: resolvePublicUrl(req, explicitBaseUrl),
          nativeManifest: resolveNativeManifest(opts),
        },
      );
      const deviceCode = consentStore.parseRequestUri(output.request_uri);
      await stageOAuthAuthorizationCodeRequest({
        deviceCode,
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        expiresInSeconds: output.expires_in || 300,
      });
      return res.redirect(302, output.authorization_url);
    } catch (err) {
      oauthError(
        res,
        400,
        err.code || 'invalid_request',
        err.message || 'Authorization request rejected',
      );
    }
  });

  // Hosted MCP multi-source consent POST. The picker submits checked
  // `selection=` values as opaque base64url(JSON) payloads — see
  // server/hosted-mcp-selection.js — plus the PKCE-mirrored authorize
  // params. The handler:
  //   1. Validates the PKCE/authorize params (same shape as GET /oauth/authorize).
  //   2. Decodes each selection structurally to one source-bounded
  //      authorization_details[] entry. No delimiter splitting; URL-shaped
  //      connector ids cannot collapse.
  //   3. Calls createHostedMcpGrantPackage: one independent child grant per source
  //      plus a single package-bound access token.
  //   4. Stages a package-bound OAuth authorization code and redirects the
  //      client back to its redirect_uri with `code=...`.
  // Spec: openspec/changes/canonicalize-connector-keys/specs/agent-consent-bundling/spec.md
  app.post(
    '/oauth/authorize/mcp-package',
    ownerAuth.requireOwnerSession,
    ownerAuth.requireCsrf,
    async (req, res) => {
      try {
        const body = req.body || {};
        const clientId = requireAuthorizeString(body, 'client_id');
        const redirectUri = requireAuthorizeString(body, 'redirect_uri');
        const responseType = requireAuthorizeString(body, 'response_type');
        const codeChallenge = requireAuthorizeString(body, 'code_challenge');
        const codeChallengeMethod = requireAuthorizeString(body, 'code_challenge_method');
        const state = typeof body.state === 'string' ? body.state : null;
        validateAuthorizePkce({ responseType, codeChallenge, codeChallengeMethod });

        const client = await getRegisteredClient(clientId);
        if (!client) return oauthError(res, 400, 'invalid_client', 'Unknown client_id');
        requireRegisteredRedirectUri(client, redirectUri);

        const selections = parseHostedMcpSelections(body.selection);
        if (selections.length === 0) {
          return oauthError(res, 400, 'invalid_request', 'At least one source must be selected');
        }
        // Per-source stream subsets submitted by the picker. Each entry is a
        // base64url(JSON) payload identifying `(connector, connection,
        // stream)`; stream entries whose source was not also checked are
        // ignored so an orphaned stream toggle cannot smuggle authority into
        // a deselected source.
        const { bySource: streamSelectionsBySource } = parseHostedMcpStreamSelections(body.stream);

        const ownerSubjectId = req?.ownerAuth?.subjectId || 'owner_local';
        const authorizationDetails = [];
        const storageBindings = [];
        const connectionIds = [];
        const sourceMetadata = [];
        const seenChildKeys = new Set();
        const sourcesWithEmptyStreams = [];

        for (const selection of selections) {
          const { connectorId, connectionId } = selection;
          const manifest = await getConnectorManifest(connectorId).catch(() => null);
          if (!manifest) {
            return oauthError(res, 400, 'invalid_request', `Unknown connector: ${connectorId}`);
          }
          let resolvedConnectionId = connectionId;
          if (resolvedConnectionId) {
            // Verify the requested connection is currently active for this
            // owner+connector. Reject silently-pinning a stale connection.
            const active = await listActiveBindingsForGrant({ ownerSubjectId, connectorId }).catch(() => []);
            const match = active.find((row) => row.connectorInstanceId === resolvedConnectionId);
            if (!match) {
              return oauthError(res, 400, 'invalid_request', `Connection ${resolvedConnectionId} is not active for ${connectorId}`);
            }
          }
          const childKey = `${connectorId}|${resolvedConnectionId || ''}`;
          if (seenChildKeys.has(childKey)) continue;
          seenChildKeys.add(childKey);

          // Compute the per-source stream subset. The picker emits a
          // pre-checked `stream` entry for every manifest stream on every
          // rendered row, so the absence of any stream entries for a
          // selected source means either:
          //   (a) the manifest declares no streams (preserve legacy
          //       wildcard behavior — `authorization_details[].streams`
          //       cannot be empty, and downstream `resolveGrantSelection`
          //       expands `*` to whatever the manifest exposes), OR
          //   (b) the owner deliberately unchecked every stream for this
          //       source. In case (b) we MUST NOT silently issue a child
          //       grant covering every stream. We drop the source from the
          //       package; if every selected source is dropped, the
          //       handler returns a clear 400 below rather than issuing an
          //       empty package.
          const manifestStreamNames = Array.isArray(manifest.streams)
            ? manifest.streams.map((stream) => stream.name).filter((name) => typeof name === 'string')
            : [];
          const sourceKey = hostedMcpSourceKey({ connectorId, connectionId: resolvedConnectionId });
          const selectedStreamSet = streamSelectionsBySource.get(sourceKey) || new Set();
          const validStreamNames = manifestStreamNames.filter((name) => selectedStreamSet.has(name));

          let narrowedStreamNames = null;
          if (manifestStreamNames.length === 0) {
            // (a) — preserve wildcard for connectors with no manifest streams.
            narrowedStreamNames = null;
          } else if (validStreamNames.length === 0) {
            // (b) — owner deselected every stream for this source. Skip it.
            sourcesWithEmptyStreams.push({
              connectorId,
              connectionId: resolvedConnectionId || null,
              connectorLabel: manifest.display_name || manifest.name || connectorId,
            });
            continue;
          } else if (validStreamNames.length === manifestStreamNames.length) {
            // All streams remain selected: emit canonical wildcard so the
            // child grant naturally expands when a future manifest revision
            // adds streams.
            narrowedStreamNames = null;
          } else {
            narrowedStreamNames = validStreamNames;
          }

          authorizationDetails.push(
            buildHostedMcpAuthorizationDetailForConnector(connectorId, narrowedStreamNames),
          );
          storageBindings.push({ connector_id: connectorId });
          connectionIds.push(resolvedConnectionId || null);
          sourceMetadata.push({
            display_name: resolvedConnectionId || null,
            connector_display_name: manifest.display_name || manifest.name || connectorId,
          });
        }

        if (authorizationDetails.length === 0) {
          // The picker accepted source checkboxes but every selected source
          // had its streams fully deselected. Returning a typed error
          // surfaces the inconsistency to the owner without leaking a raw
          // connector identifier — the message names the connector(s) by
          // manifest display name.
          const labels = sourcesWithEmptyStreams.map((entry) => entry.connectorLabel).join(', ');
          return oauthError(
            res,
            400,
            'invalid_request',
            labels
              ? `Select at least one stream to authorize for: ${labels}`
              : 'At least one source must be selected',
          );
        }

        const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
        const publicBaseUrl = resolvePublicUrl(req, explicitBaseUrl);

        const packageResult = await createHostedMcpGrantPackage({
          clientId,
          authorizationDetails,
          storageBindings,
          connectionIds,
          sourceMetadata,
          subjectId: ownerSubjectId,
          opts: {},
        });

        // Stage a fresh OAuth device-code shell so the package's access
        // token can be redeemed at /oauth/token. Mirrors the PAR path's
        // request-uri staging without coupling to pending_consents.
        const deviceCode = `mcpdev_${randomBytes(16).toString('hex')}`;
        const stagingExpiresIn = 300;
        await stageOAuthAuthorizationCodeRequest({
          deviceCode,
          clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
          expiresInSeconds: stagingExpiresIn,
        });

        const issued = await issueOAuthAuthorizationCodeForPackageDeviceCode(deviceCode, {
          packageId: packageResult.package_id,
          token: packageResult.token,
        });
        if (!issued) {
          return oauthError(res, 500, 'server_error', 'Failed to issue authorization code for package');
        }

        const redirectUrl = new URL(issued.redirect_uri);
        redirectUrl.searchParams.set('code', issued.code);
        if (issued.state) {
          redirectUrl.searchParams.set('state', issued.state);
        }
        return res.redirect(302, redirectUrl.toString());
      } catch (err) {
        oauthError(
          res,
          400,
          err.code || 'invalid_request',
          err.message || 'Hosted MCP package authorization rejected',
        );
      }
    },
  );

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
    if (req.body?.grant_type === 'authorization_code') {
      try {
        const token = await exchangeOAuthAuthorizationCode({
          code: req.body?.code,
          clientId: req.body?.client_id,
          redirectUri: req.body?.redirect_uri,
          codeVerifier: req.body?.code_verifier,
        });
        return res.json({
          access_token: token.access_token,
          token_type: token.token_type,
          ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
          ...(token.grant_package_id
            ? { grant_package_id: token.grant_package_id }
            : { grant_id: token.grant_id }),
        });
      } catch (err) {
        return oauthError(res, 400, err.code || 'invalid_grant', err.message || 'Authorization code exchange failed');
      }
    }
    if (req.body?.grant_type === 'refresh_token') {
      try {
        const token = await exchangeOAuthRefreshToken({
          refreshToken: req.body?.refresh_token,
          clientId: req.body?.client_id,
        });
        return res.json({
          access_token: token.access_token,
          token_type: token.token_type,
          refresh_token: token.refresh_token,
          ...(token.grant_package_id
            ? { grant_package_id: token.grant_package_id }
            : { grant_id: token.grant_id }),
        });
      } catch (err) {
        return oauthError(res, 400, err.code || 'invalid_grant', err.message || 'Refresh token exchange failed');
      }
    }
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

  // Spine correlation list / timeline / search routes delegate envelope
  // assembly to canonical operation modules. Timeline and search remain
  // inline below; the list routes (`/_ref/traces`, `/_ref/grants`,
  // `/_ref/runs`) are mounted via `server/routes/ref-spine-correlations.ts`
  // per OpenSpec change `split-reference-server-by-route-family`.
  // Behaviour-preserving extraction: same mount points, same handler
  // chain, same envelope. See openspec/changes/mount-ref-spine-operations
  // for the operation contract.
  const refSpineCorrelationsContext = {
    requireOwnerSession: ownerAuth.requireOwnerSession,
    listSpineCorrelations: (kind, filters) => listSpineCorrelations(kind, filters),
    handleError,
  };
  mountRefTraces(app, refSpineCorrelationsContext);
  mountRefGrants(app, refSpineCorrelationsContext);
  mountRefRuns(app, refSpineCorrelationsContext);

  // ────────────────────────────────────────────────────────────────────────
  // /_ref/grant-packages — operator visibility for hosted-MCP grant packages
  // ────────────────────────────────────────────────────────────────────────
  // Read-mostly operator surface that exposes the grant-package primitive
  // (`add-hosted-mcp-grant-packages`) on the dashboard. Listing returns
  // every package in `created_at DESC` order with member counts; detail
  // returns the full child cascade; revoke is a thin wrapper around the
  // existing `revokeGrantPackage` storage helper. The package never
  // exposes raw token material; the projection is the same `package_id /
  // subject_id / client_id / status / children` shape consumed by the
  // hosted-MCP OAuth flow at authorization time.
  // Spec: openspec/changes/add-grant-package-operator-visibility/
  function parseGrantPackageListQuery(query) {
    const rawLimit = query?.limit;
    let limit = 50;
    if (rawLimit !== undefined && rawLimit !== null) {
      const parsed = Number.parseInt(String(rawLimit), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        const err = new Error(`limit must be a positive integer (got "${rawLimit}")`);
        err.code = 'invalid_request';
        err.param = 'limit';
        throw err;
      }
      if (parsed > 200) {
        const err = new Error('limit exceeds maximum 200');
        err.code = 'invalid_request';
        err.param = 'limit';
        throw err;
      }
      limit = parsed;
    }
    return {
      limit,
      cursor: typeof query?.cursor === 'string' && query.cursor.length > 0 ? query.cursor : null,
    };
  }

  app.get('/_ref/grant-packages', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const page = await listGrantPackagesForOwner(parseGrantPackageListQuery(req.query));
      res.json({
        object: 'list',
        data: page.data.map((pkg) => ({
          object: 'grant_package_summary',
          package_id: pkg.package_id,
          subject_id: pkg.subject_id,
          client_id: pkg.client_id,
          status: pkg.status,
          member_count: pkg.member_count,
          created_at: pkg.created_at,
          approved_at: pkg.approved_at,
          revoked_at: pkg.revoked_at,
        })),
        has_more: page.has_more,
        next_cursor: page.next_cursor,
        limit: page.limit,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/grant-packages/:id', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const pkg = await getGrantPackageForOwner(req.params.id);
      if (!pkg) {
        return pdppError(res, 404, 'not_found', `grant package not found: ${req.params.id}`);
      }
      res.json({
        object: 'grant_package',
        package_id: pkg.package_id,
        subject_id: pkg.subject_id,
        client_id: pkg.client_id,
        status: pkg.status,
        member_count: pkg.member_count,
        created_at: pkg.created_at,
        approved_at: pkg.approved_at,
        revoked_at: pkg.revoked_at,
        trace_id: pkg.trace_id,
        scenario_id: pkg.scenario_id,
        children: pkg.children.map((child) => ({
          object: 'grant_package_child',
          grant_id: child.grant_id,
          grant_status: child.grant_status,
          member_status: child.member_status,
          added_at: child.added_at,
          revoked_at: child.revoked_at,
          source: child.source,
        })),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/_ref/grant-packages/:id/revoke', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const pkg = await getGrantPackageForOwner(req.params.id);
      if (!pkg) {
        return pdppError(res, 404, 'not_found', `grant package not found: ${req.params.id}`);
      }
      if (pkg.status !== 'active') {
        return pdppError(res, 409, 'already_revoked', `grant package ${req.params.id} is already ${pkg.status}`);
      }
      await revokeGrantPackage(req.params.id, {
        request_id: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined,
      });
      const after = await getGrantPackageForOwner(req.params.id);
      res.json({
        object: 'grant_package_revoke_result',
        package_id: req.params.id,
        status: after?.status ?? 'revoked',
        revoked_at: after?.revoked_at ?? new Date().toISOString(),
        revoked_child_count: after ? after.children.length : 0,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // /_ref/event-subscriptions — operator oversight of client event subscriptions
  // ────────────────────────────────────────────────────────────────────────
  // Read-mostly oversight surface for the subscriptions clients have
  // created at `/v1/event-subscriptions`. Owner-session gated like every
  // other `/_ref/*` route. The disable endpoint is the operator safety
  // valve; there is intentionally no operator create / re-enable / rotate
  // / replay path. See:
  //   openspec/changes/add-client-event-subscription-management/
  app.get('/_ref/event-subscriptions', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const envelope = await executeRefClientEventSubscriptionsList(
        {
          clientId: typeof req.query.client_id === 'string' ? req.query.client_id : null,
          grantId: typeof req.query.grant_id === 'string' ? req.query.grant_id : null,
          status: typeof req.query.status === 'string' ? req.query.status : null,
        },
        {
          listAllSubscriptions,
          getSubscriptionSummary,
        },
      );
      res.json(envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/event-subscriptions/:id', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const detail = await executeRefClientEventSubscriptionsGet(req.params.id, {
        getSubscriptionSummary,
        listAttemptsForSubscription,
      });
      res.json(detail);
    } catch (err) {
      if (err instanceof RefClientEventSubscriptionsNotFoundError) {
        return pdppError(res, 404, err.code, err.message);
      }
      handleError(res, err);
    }
  });

  app.post('/_ref/event-subscriptions/:id/disable', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const reason =
        req.body && typeof req.body === 'object' && typeof req.body.reason === 'string'
          ? req.body.reason
          : null;
      const out = await executeRefClientEventSubscriptionsDisable(
        { subscriptionId: req.params.id, reason },
        { store: getDefaultClientEventSubscriptionStore(), nowIso: () => new Date().toISOString() },
      );
      const detail = await executeRefClientEventSubscriptionsGet(out.subscriptionId, {
        getSubscriptionSummary,
        listAttemptsForSubscription,
      });
      res.json(detail);
    } catch (err) {
      if (err instanceof RefClientEventSubscriptionsDisableNotFoundError) {
        return pdppError(res, 404, err.code, err.message);
      }
      if (err instanceof RefClientEventSubscriptionsDisableInvalidRequestError) {
        return pdppError(res, 400, err.code, err.message);
      }
      handleError(res, err);
    }
  });

  // Operator-only Web Push surfaces are mounted via
  // `server/routes/web-push.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§5.2). Behaviour-preserving
  // extraction: same mount points, same handler chain, same envelopes.
  const refWebPushContext = {
    fanoutTestWebPush,
    getOwnerSubjectId,
    handleError,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    webPushConfig,
    webPushStore,
  };
  mountRefWebPushConfig(app, refWebPushContext);
  mountRefWebPushListSubscriptions(app, refWebPushContext);
  mountRefWebPushCreateSubscription(app, refWebPushContext);
  mountRefWebPushDeleteSubscription(app, refWebPushContext);
  mountRefWebPushTest(app, refWebPushContext);

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

  // Spine detail / timeline routes are mounted via
  // `server/routes/ref-spine-timelines.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§2.2 detail/timeline
  // sub-bullet). Behaviour-preserving extraction: same mount points,
  // same handler chain (ownerAuth.requireOwnerSession), same envelope,
  // same `limit`/`cursor` validation, same 404-on-empty-first-page, and
  // same `invalid_cursor` discrimination. The canonical
  // `ref.spine.events.page` operation continues to own envelope shape
  // and live-bearer redaction.
  const refSpineTimelinesContext = {
    requireOwnerSession: ownerAuth.requireOwnerSession,
    listSpineEventsPage: (kind, id, opts) => listSpineEventsPage(kind, id, opts),
    handleError,
    pdppError,
  };
  mountRefTraceTimeline(app, refSpineTimelinesContext);
  mountRefGrantTimeline(app, refSpineTimelinesContext);
  mountRefRunTimeline(app, refSpineTimelinesContext);

  // Run-interaction streaming companion (reference-only). The store and
  // companion factory live in this AS app so the mint route, the SSE viewer
  // channel, and the input dispatch share state without a separate process.
  //
  // - Tests inject `opts.streamingCompanionFactory` for deterministic mock
  //   frame/input mapping without a real Chromium.
  // - In production, the default factory resolves the per-(run, interaction)
  //   CDP page-target ws URL through the run-target registry. The connector
  //   runtime / browser binding registers the page's CDP ws URL via the
  //   admin route at the moment the manual_action interaction is created;
  //   the resolver hands it to the companion at attach time.
  // - When the factory is `null` (e.g. the registry is empty for the run),
  //   the mint route returns 503 `streaming_companion_unavailable`. We never
  //   hand out a token that only fails at attach time.
  const streamingSessions = opts.streamingSessionStore || createStreamingSessionStore();
  // Distinguish "caller did not specify" (use default registry-backed factory)
  // from "caller passed null" (explicit fail-closed; mint route returns 503).
  // The default factory always exists because the registry resolver always
  // exists, so a plain `||` fallback would silently turn an explicit null
  // back into a working factory and lose the fail-closed test seam.
  const streamingCompanionFactory =
    opts.streamingCompanionFactory !== undefined
      ? opts.streamingCompanionFactory
      : createDefaultStreamingCompanionFactory({
          resolveTargetForInteraction: (runId, interactionId) =>
            runTargetRegistry.get({ runId, interactionId }),
          logger: opts.streamingLogger,
          neko: {
            screenConfigurationsEndpoint: 'api/room/screen/configurations',
            screenEndpoint: 'api/room/screen',
            cdpHttpUrl: process.env.PDPP_NEKO_CDP_HTTP_URL || process.env.NEKO_CDP_HTTP_URL || undefined,
          },
        });
  const streamingRoutes = registerStreamingRoutes({
    app,
    controller,
    ownerAuth,
    streamingSessions,
    companionFactory: streamingCompanionFactory,
    makeBrowserSessionId: opts.makeStreamingBrowserSessionId,
    nekoProxyAllowedHosts:
      opts.nekoProxyAllowedHosts || process.env.PDPP_NEKO_PROXY_ALLOWED_HOSTS || '',
    isNekoProxyTargetApproved: (target, { session }) =>
      (typeof opts.isNekoProxyTargetApproved === 'function' &&
        opts.isNekoProxyTargetApproved(target, { session }) === true) ||
      isManagedNekoSurfaceApproved(target, {
        runId: session?.run_id,
        interactionId: session?.interaction_id,
        browserSurfaceLeaseManager: opts.browserSurfaceLeaseManager,
      }),
    nekoProxyAutoLogin:
      opts.nekoProxyAutoLogin !== undefined
        ? opts.nekoProxyAutoLogin
        : process.env.PDPP_NEKO_PROXY_AUTOLOGIN === '1'
          ? {
              username: process.env.NEKO_USERNAME || 'operator',
              password: process.env.NEKO_PASSWORD || '1',
            }
          : null,
  });
  app.__pdppStreamingUpgradeHandler = streamingRoutes.handleUpgrade;

  // Wrap controller.respondToInteraction so the streaming session is
  // invalidated whenever an interaction resolves. Inbox and the
  // `_ref/runs/:runId/interaction` route both call respondToInteraction, so
  // wrapping at the controller seam covers both paths without duplicating the
  // teardown call.
  if (controller && typeof controller.respondToInteraction === 'function') {
    const originalRespondToInteraction = controller.respondToInteraction.bind(controller);
    controller.respondToInteraction = (runId, input = {}) => {
      const result = originalRespondToInteraction(runId, input);
      Promise.resolve(
        streamingRoutes.invalidateForInteractionResolved({
          run_id: runId,
          interaction_id: input.interaction_id,
          reason: `interaction_${input.status || 'resolved'}`,
        }),
      )
        .then(() => {
          // After invalidating the streaming session, drop the target registry
          // entry to free resources immediately rather than waiting for TTL.
          return runTargetRegistry.forceUnregister({
            runId,
            interactionId: input.interaction_id,
          });
        })
        .catch(() => {
          /* cleanup is best-effort; failing must not break the response */
        });
      return result;
    };
  }

  registerInboxRoutes(app, { controller, ownerAuth, pdppError, handleError });

  // Operator-only stream-playground route. Lazy-launches a long-lived patchright
  // headless browser whose first page is pinned to a self-contained data:
  // URL, registers its CDP page-target wsUrl with the run-target registry
  // under a synthetic (runId, interactionId), and shims
  // controller.getPendingInteraction so the standard streaming-mint route
  // accepts the synthetic runId. The dashboard's /dashboard/stream-playground
  // route hits this endpoint to obtain the (runId, interactionId) to feed
  // into <StreamSurface>.
  //
  // Gated on NODE_ENV !== 'production' unless explicitly enabled. The Docker
  // n.eko SLVP overlay sets PDPP_ENABLE_STREAM_PLAYGROUND=1; hardened
  // production deployments leave it disabled. Owner session is still required
  // when owner-auth is enabled — the playground is for the deploying operator,
  // not unauth'd visitors.
  //
  // Route extracted to `server/routes/run-interaction.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§5.1). Behaviour-preserving:
  // same gate condition, same owner-session posture, same response envelope,
  // same error mapping.
  const streamPlaygroundEnabled =
    process.env.NODE_ENV !== 'production' || process.env.PDPP_ENABLE_STREAM_PLAYGROUND === '1';
  if (streamPlaygroundEnabled && controller) {
    const playground = createPlayground({
      runTargetRegistry,
      controller,
      logger: opts.streamingLogger,
    });
    mountRefDevPlaygroundSession(app, {
      logger: opts.streamingLogger,
      pdppError,
      playground,
      requireOwnerSession: ownerAuth.requireOwnerSession,
    });
  }

  // Reference-only, owner-only control surface: answer the current pending
  // interaction for a live controller-managed run. The read path remains the
  // existing run timeline; this route is mutation-only and is not a public
  // PDPP API. Submitted `data` satisfies the current run only — it is not
  // written to `.env.local`, SQLite config/state, or spine event payloads.
  //
  // Route extracted to `server/routes/run-interaction.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§5.1). Behaviour-preserving:
  // same contract metadata, same owner-session posture, same validation,
  // same response envelope, same error codes.
  mountRefRunInteraction(app, {
    controller,
    handleError,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
  });

  // `/_ref/dataset/*` and `/_ref/records/version-stats` routes extracted to
  // `server/routes/ref-dataset.ts` per `split-reference-server-by-route-family`
  // §2.3. Context wires the same substrate functions that previously lived
  // inline here; behaviour is identical.
  const refDatasetContext = {
    requireOwnerSession: ownerAuth.requireOwnerSession,
    handleError,
    createRequestAbortSignal,
    isPostgresStorageBackend,
    getDatasetRecordsAggregate,
    getDatasetRecordChangesBytes,
    getDatasetBlobBytes,
    getDatasetRecordTimeBounds,
    listDatasetTopConnectorCandidates,
    listDatasetSummaryStreamProjectionSeeds,
    getDatasetSummaryStreamRecordTimeBounds,
    getDatasetSummaryProjection,
    listStreamProjections,
    rebuildDatasetSummaryProjection,
    reconcileDirtyDatasetSummaryRecordTimeBounds,
    getRetainedSizeGlobal,
    listRetainedSizeConnections,
    listRetainedSizeStreams,
    listRetainedSizeTop,
    rebuildRetainedSize,
    reconcileDirtyRetainedSize,
    buildRecordVersionStatsEnvelope,
    createRequestConnectorInstanceStore,
  };
  mountRefDatasetSummary(app, refDatasetContext);
  mountRefDatasetSummaryStreams(app, refDatasetContext);
  mountRefDatasetSummaryRebuild(app, refDatasetContext);
  mountRefDatasetSummaryReconcile(app, refDatasetContext);
  mountRefDatasetSize(app, refDatasetContext);
  mountRefDatasetTop(app, refDatasetContext);
  mountRefRecordsVersionStats(app, refDatasetContext);
  mountRefDatasetSizeRebuild(app, refDatasetContext);
  mountRefDatasetSizeReconcile(app, refDatasetContext);

  // `/_ref/connectors`, `/_ref/connections`, and `/_ref/connector-instances`
  // routes (catalog list/detail, schedule read, connection list/detail,
  // display-name PATCH, and run/schedule action routes) extracted to
  // `server/routes/ref-connectors.ts` per
  // `split-reference-server-by-route-family` §2.4. The host wires
  // capability-shaped controller / substrate dependencies; the adapter
  // owns owner-auth, namespace resolution, contract metadata, response
  // writing, and the `onScheduleMutation` callback.
  const refConnectorsContext = {
    requireOwnerSession: ownerAuth.requireOwnerSession,
    handleError,
    pdppError,
    listConnectorSummaries: () => listConnectorSummaries(controller),
    getConnectorDetail: (id) => getConnectorDetail(id, controller),
    resolveRegisteredConnectorManifest,
    listSchedules: async () => (controller ? await controller.listSchedules() : []),
    getSchedule: async (connectorId, options) =>
      controller ? await controller.getSchedule(connectorId, options) : null,
    runNow: (connectorId, options) => controller.runNow(connectorId, options),
    upsertSchedule: (connectorId, input, options) =>
      controller.upsertSchedule(connectorId, input, options),
    setScheduleEnabled: (connectorId, enabled, options) =>
      controller.setScheduleEnabled(connectorId, enabled, options),
    deleteSchedule: (connectorId, options) => controller.deleteSchedule(connectorId, options),
    onScheduleMutation: opts.onScheduleMutation,
    createRequestConnectorInstanceStore,
    resolveOwnerConnectorNamespace,
    getOwnerSubjectId,
    resolveSingleConnectorIdQueryValue,
  };

  mountRefConnectorsList(app, refConnectorsContext);
  mountRefConnectorDetail(app, refConnectorsContext);

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

  mountRefConnectorScheduleGet(app, refConnectorsContext);
  mountRefConnectionsList(app, refConnectorsContext);
  mountRefConnectorInstancesList(app, refConnectorsContext);
  mountRefConnectionDetail(app, refConnectorsContext);
  mountRefConnectorInstanceDetail(app, refConnectorsContext);
  mountRefConnectionSetDisplayName(app, refConnectorsContext);

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
            getRuntimeCapabilityPosture: async () => {
              // Provider/control-plane runtime advertises only the bindings
              // it can actually satisfy. We honestly never advertise
              // `browser` here — the runtime gate fails closed on headed
              // in-container browser launches. `local_device` is also
              // false; only a paired collector can satisfy that.
              const inContainer =
                process.env.PDPP_FORCE_CONTAINER === '1' || existsSync('/.dockerenv');
              let collectorPaired = false;
              let pairing = null;
              try {
                const subjectId = getOwnerSubjectId(req);
                const devices = await deviceExporterStore.listDevices(subjectId);
                const activeDevices = Array.isArray(devices)
                  ? devices.filter((d) => d.status === 'active')
                  : [];
                collectorPaired = activeDevices.length > 0;
                if (collectorPaired) {
                  // Pick the most-recently-updated active device as the
                  // representative pairing for the warning surface. Multiple
                  // collectors with different protocol versions still drive
                  // a single dashboard warning, but we report the worst case
                  // (outdated > current) so the operator notices drift.
                  const sorted = [...activeDevices].sort((a, b) => {
                    const aT = Date.parse(a.lastHeartbeatAt || a.updatedAt || a.createdAt || '') || 0;
                    const bT = Date.parse(b.lastHeartbeatAt || b.updatedAt || b.createdAt || '') || 0;
                    return bT - aT;
                  });
                  const outdated = activeDevices.some(
                    (d) => !SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS.includes(d.collectorProtocolVersion || ''),
                  );
                  const outdatedDevice = outdated
                    ? activeDevices.find(
                        (d) => !SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS.includes(d.collectorProtocolVersion || ''),
                      )
                    : null;
                  const representative = outdatedDevice || sorted[0];
                  const observedVersion = representative?.collectorProtocolVersion ?? null;
                  pairing = {
                    protocol_version: observedVersion ?? (representative ? 'legacy_unknown' : null),
                    protocol_outdated: outdated,
                    runner_version: representative?.agentVersion ?? null,
                    // Per-connector bundle versions aren't advertised by
                    // today's runner. The shape is reserved so a future
                    // heartbeat extension can fill it without a contract
                    // change.
                    connector_versions: {},
                  };
                }
              } catch {
                // Diagnostics must survive a transient store failure.
                collectorPaired = false;
                pairing = null;
              }
              return {
                bindings: {
                  browser: false,
                  filesystem: true,
                  local_device: false,
                  network: true,
                },
                collector_paired: collectorPaired,
                accepted_collector_protocol_versions: [...SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS],
                collector_pairing: pairing,
                in_container: inContainer,
              };
            },
          },
          { dbPath: opts.dbPath || DB_PATH }
        ),
      });
      res.json(report);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/_ref/device-exporters/enrollment-codes', { contract: 'refCreateDeviceExporterEnrollmentCode' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const body = req.body || {};
      const connectorId = requireNonEmptyString(body.connector_id, 'connector_id');
      const localBindingId = requireNonEmptyString(body.local_binding_name, 'local_binding_name');
      const now = new Date();
      const expiresInSeconds = Number.isInteger(body.expires_in_seconds)
        ? body.expires_in_seconds
        : 15 * 60;
      if (expiresInSeconds < 60 || expiresInSeconds > 86_400) {
        return pdppError(res, 400, 'invalid_request', 'expires_in_seconds must be between 60 and 86400', 'expires_in_seconds');
      }
      const enrollmentCode = generateReferenceSecret('lde', 18);
      const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
      await deviceExporterStore.createEnrollmentCode({
        enrollmentCodeId: generateSpineId('denroll'),
        codeHash: hashDeviceSecret(enrollmentCode),
        ownerSubjectId: getOwnerSubjectId(req),
        connectorId,
        localBindingId,
        displayName: typeof body.display_name === 'string' && body.display_name.trim() ? body.display_name.trim() : null,
        createdAt: now.toISOString(),
        expiresAt,
      });
      res.status(201).json({
        object: 'device_exporter_enrollment_code',
        enrollment_code: enrollmentCode,
        expires_at: expiresAt,
        connector_id: connectorId,
        local_binding_name: localBindingId,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/_ref/device-exporters/enroll', { contract: 'refExchangeDeviceExporterEnrollmentCode' }, async (req, res) => {
    try {
      // Refuse to mint a device-scoped credential for a collector whose
      // protocol version this server cannot accept. The 409 must precede any
      // store write (no device row, no credential, no source instance) so a
      // rejected enroll cannot leak partial state.
      if (enforceCollectorProtocolVersion(req, res)) {
        return;
      }
      const body = req.body || {};
      const enrollmentCode = requireNonEmptyString(body.enrollment_code, 'enrollment_code');
      const enrollment = await deviceExporterStore.findEnrollmentByCodeHash(hashDeviceSecret(enrollmentCode));
      const now = new Date();
      if (!enrollment || enrollment.status !== 'pending') {
        return pdppError(res, 400, 'invalid_request', 'Enrollment code is invalid or already used', 'enrollment_code');
      }
      if (Date.parse(enrollment.expiresAt) <= now.getTime()) {
        await deviceExporterStore.revokeEnrollmentCode(enrollment.enrollmentCodeId, now.toISOString());
        return pdppError(res, 410, 'invalid_request', 'Enrollment code has expired', 'enrollment_code');
      }

      const collectorProtocolVersion = readCollectorProtocolHeader(req.headers);

      const deviceId = generateSpineId('dexp');
      const credentialId = generateSpineId('dcred');
      const sourceInstanceId = generateSpineId('dsrc');
      const deviceToken = generateReferenceSecret('ldt', 32);
      const displayName = typeof body.device_label === 'string' && body.device_label.trim()
        ? body.device_label.trim()
        : (enrollment.displayName || enrollment.localBindingId);

      await deviceExporterStore.createDevice({
        deviceId,
        ownerSubjectId: enrollment.ownerSubjectId,
        displayName,
        collectorProtocolVersion,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      await deviceExporterStore.createCredential({
        credentialId,
        deviceId,
        tokenHash: hashDeviceSecret(deviceToken),
        createdAt: now.toISOString(),
      });
      await ensureReferenceConnectorCatalogEntry(enrollment.connectorId, enrollment.displayName || displayName);
      // The identity used to hash source_binding_key is intentionally
      // narrower than the source_binding payload we store for debugging:
      // device_id and source_instance_id are minted fresh per enroll, so
      // hashing them would fork a new connector_instances row on every
      // re-enrollment. Keying on (owner, connector_id, local_device,
      // local_binding_name) lets a re-enrollment for the same owner-chosen
      // binding upsert into the existing row instead.
      const sourceBindingIdentity = deviceExporterSourceBindingIdentity(enrollment.localBindingId);
      const connectorInstance = await createRequestConnectorInstanceStore().upsert({
        ownerSubjectId: enrollment.ownerSubjectId,
        connectorId: enrollment.connectorId,
        displayName,
        status: 'active',
        sourceKind: 'local_device',
        sourceBindingKey: makeConnectorInstanceSourceBindingKey(sourceBindingIdentity),
        sourceBinding: {
          kind: 'local_device',
          device_id: deviceId,
          local_binding_name: enrollment.localBindingId,
          source_instance_id: sourceInstanceId,
        },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      await deviceExporterStore.upsertSourceInstance({
        sourceInstanceId,
        deviceId,
        connectorId: enrollment.connectorId,
        connectorInstanceId: connectorInstance.connectorInstanceId,
        localBindingId: enrollment.localBindingId,
        displayName: enrollment.displayName,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      const consumed = await deviceExporterStore.consumeEnrollmentCode(enrollment.enrollmentCodeId, deviceId, now.toISOString());
      if (!consumed) {
        await deviceExporterStore.revokeDevice(deviceId, now.toISOString());
        await createRequestConnectorInstanceStore().updateStatus(connectorInstance.connectorInstanceId, {
          status: 'revoked',
          updatedAt: now.toISOString(),
          revokedAt: now.toISOString(),
        });
        return pdppError(res, 409, 'invalid_request', 'Enrollment code was consumed by another device', 'enrollment_code');
      }

      res.status(201).json({
        object: 'device_exporter_enrollment',
        device_id: deviceId,
        connector_instance_id: connectorInstance.connectorInstanceId,
        // Compatibility: collectors still persist source_instance_id as their
        // device-binding selector. Server-side trust is now the active
        // connector_instance_id resolved from that binding.
        source_instance_id: sourceInstanceId,
        device_token: deviceToken,
        connector_id: enrollment.connectorId,
        local_binding_name: enrollment.localBindingId,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/device-exporters', { contract: 'refListDeviceExporters' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      res.json({ object: 'list', data: await buildDeviceExporterDiagnostics(getOwnerSubjectId(req)) });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/device-exporters/source-instances', { contract: 'refListDeviceExporterSourceInstances' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const diagnostics = await buildDeviceExporterDiagnostics(getOwnerSubjectId(req));
      const requestedDeviceId = typeof req.query.device_id === 'string' && req.query.device_id.trim()
        ? req.query.device_id.trim()
        : null;
      const requestedConnectorInstanceId =
        typeof req.query.connector_instance_id === 'string' && req.query.connector_instance_id.trim()
          ? req.query.connector_instance_id.trim()
          : null;
      const data = diagnostics
        .flatMap((device) => device.source_instances)
        .filter((source) => !requestedDeviceId || source.device_id === requestedDeviceId)
        .filter(
          (source) =>
            !requestedConnectorInstanceId || source.connector_instance_id === requestedConnectorInstanceId,
        );
      res.json({ object: 'list', data });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/device-exporters/diagnostics', { contract: 'refListDeviceExporterDiagnostics' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      res.json({ object: 'list', data: await buildDeviceExporterDiagnostics(getOwnerSubjectId(req)) });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/_ref/device-exporters/:deviceId/revoke', { contract: 'refRevokeDeviceExporter' }, ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const device = await deviceExporterStore.getDevice(deviceId);
      if (!device || device.ownerSubjectId !== getOwnerSubjectId(req)) {
        return pdppError(res, 404, 'not_found', 'Device exporter not found');
      }
      const revokedAt = new Date().toISOString();
      await deviceExporterStore.revokeDevice(deviceId, revokedAt);
      res.json({ object: 'device_exporter_revocation', device_id: deviceId, revoked_at: revokedAt });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/_ref/device-exporters/:deviceId/heartbeat', { contract: 'refHeartbeatDeviceExporter' }, requireDeviceExporterCredential, async (req, res) => {
    try {
      const deviceId = decodeURIComponent(req.params.deviceId);
      if (deviceId !== req.deviceExporter.deviceId) {
        return pdppError(res, 403, 'permission_error', 'Device credential is not valid for this device');
      }
      const body = req.body || {};
      const receivedAt = new Date().toISOString();
      await deviceExporterStore.markDeviceHeartbeat(deviceId, {
        receivedAt,
        agentVersion: typeof body.agent_version === 'string' ? body.agent_version : null,
        lastError: sanitizeDeviceExporterDiagnostic(body.last_error),
      });
      for (const source of normalizeHeartbeatSourceInstances(body)) {
        const sourceInstanceId = requireNonEmptyString(source.source_instance_id, 'source_instance_id');
        const authorized = await resolveAuthorizedDeviceSource(req, res, deviceId, sourceInstanceId);
        if (!authorized) return;
        await deviceExporterStore.markSourceInstanceHeartbeat(deviceId, sourceInstanceId, {
          receivedAt,
          lastError: sanitizeDeviceExporterDiagnostic(source.last_error),
          status: typeof source.status === 'string' ? source.status : null,
          recordsPending:
            typeof source.records_pending === 'number' ? source.records_pending : null,
          outboxDiagnostics: source.outbox ?? null,
        });
      }
      res.json({
        object: 'device_exporter_heartbeat',
        device_id: deviceId,
        received_at: receivedAt,
        status: 'accepted',
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/_ref/device-exporters/:deviceId/ingest-batches', { contract: 'refIngestDeviceExporterBatch' }, requireDeviceExporterCredential, async (req, res) => {
    try {
      const deviceId = decodeURIComponent(req.params.deviceId);
      if (deviceId !== req.deviceExporter.deviceId) {
        return pdppError(res, 403, 'permission_error', 'Device credential is not valid for this device');
      }
      const body = req.body || {};
      const bodyDeviceId = requireNonEmptyString(body.device_id, 'device_id');
      if (bodyDeviceId !== deviceId) {
        return pdppError(res, 400, 'invalid_request', 'body device_id must match path deviceId', 'device_id');
      }
      const sourceInstanceId = requireNonEmptyString(body.source_instance_id, 'source_instance_id');
      const batchId = requireNonEmptyString(body.batch_id, 'batch_id');
      const bodyHash = requireNonEmptyString(body.body_hash, 'body_hash');
      const connectorId = requireNonEmptyString(body.connector_id, 'connector_id');
      if (!Number.isInteger(body.batch_seq) || body.batch_seq < 0) {
        return pdppError(res, 400, 'invalid_request', 'batch_seq must be a non-negative integer', 'batch_seq');
      }
      const authorized = await resolveAuthorizedDeviceSource(req, res, deviceId, sourceInstanceId);
      if (!authorized) return;
      const { sourceInstance, connectorInstance } = authorized;
      if (sourceInstance.connectorId !== connectorId) {
        return pdppError(res, 400, 'invalid_request', 'connector_id does not match source_instance_id', 'connector_id');
      }

      const records = normalizeDeviceIngestRecords(body);
      const existing = await deviceExporterStore.getBatchOutcome(deviceId, batchId);
      if (existing) {
        if (existing.bodyHash !== bodyHash) {
          return pdppError(res, 409, 'device_batch_conflict', `Device ingest batch '${batchId}' already exists with a different body hash`);
        }
        return res.status(200).json({
          object: 'device_ingest_batch_result',
          device_id: deviceId,
          connector_instance_id: connectorInstance.connectorInstanceId,
          source_instance_id: sourceInstanceId,
          batch_id: batchId,
          body_hash: bodyHash,
          status: 'replayed',
          accepted_record_count: existing.response?.accepted_record_count ?? records.length,
          rejected_record_count: existing.response?.rejected_record_count ?? 0,
        });
      }

      const storageTarget = referenceLocalDeviceStorageTarget(connectorId, connectorInstance.connectorInstanceId);
      for (const record of records) {
        await ingestRecord(storageTarget, record);
      }
      const response = {
        object: 'device_ingest_batch_result',
        device_id: deviceId,
        connector_instance_id: connectorInstance.connectorInstanceId,
        source_instance_id: sourceInstanceId,
        batch_id: batchId,
        body_hash: bodyHash,
        status: 'accepted',
        accepted_record_count: records.length,
        rejected_record_count: 0,
      };
      await deviceExporterStore.recordBatchOutcome({
        deviceId,
        batchId,
        bodyHash,
        sourceInstanceId,
        status: 'accepted',
        httpStatus: 201,
        response,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(response);
    } catch (err) {
      if (err instanceof DeviceBatchConflictError) {
        return pdppError(res, 409, 'device_batch_conflict', err.message);
      }
      handleError(res, err);
    }
  });

  // GET /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state
  // Device-scoped local collector state read. Reference-only; not part of the
  // public PDPP contract. State is stored under the same internal storage
  // storage target used by device ingest (`referenceLocalDeviceStorageTarget`)
  // so device state rows are scoped by the authorized connector instance and
  // never collide with owner-auth /v1/state rows for the public connector id.
  // `source_instance_id` remains in the route as the legacy device-binding
  // selector. See OpenSpec `design-local-collector-state-sync`.
  app.get(
    '/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state',
    { contract: 'refGetDeviceExporterSourceInstanceState' },
    requireDeviceExporterCredential,
    async (req, res) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId);
        if (deviceId !== req.deviceExporter.deviceId) {
          return pdppError(res, 403, 'permission_error', 'Device credential is not valid for this device');
        }
        const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId);
        const authorized = await resolveAuthorizedDeviceSource(req, res, deviceId, sourceInstanceId, { notFoundStatus: 404 });
        if (!authorized) return;
        const { sourceInstance, connectorInstance } = authorized;
        const storageTarget = referenceLocalDeviceStorageTarget(
          sourceInstance.connectorId,
          connectorInstance.connectorInstanceId,
        );
        const projection = await getSyncState(storageTarget, { grantId: null });
        res.json({
          object: 'device_source_instance_state',
          device_id: deviceId,
          connector_instance_id: connectorInstance.connectorInstanceId,
          source_instance_id: sourceInstanceId,
          state: projection.state ?? {},
          updated_at: projection.updated_at ?? null,
        });
      } catch (err) {
        handleError(res, err);
      }
    },
  );

  // PUT /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state
  // Device-scoped local collector state write. Body shape: { state: { [stream]: cursor } }.
  // Last-write-wins per stream; full replacement of all streams is NOT performed
  // because the underlying ConnectorStateStore is stream-keyed merge.
  app.put(
    '/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state',
    { contract: 'refPutDeviceExporterSourceInstanceState' },
    requireDeviceExporterCredential,
    async (req, res) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId);
        if (deviceId !== req.deviceExporter.deviceId) {
          return pdppError(res, 403, 'permission_error', 'Device credential is not valid for this device');
        }
        const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId);
        const authorized = await resolveAuthorizedDeviceSource(req, res, deviceId, sourceInstanceId, { notFoundStatus: 404 });
        if (!authorized) return;
        const { sourceInstance, connectorInstance } = authorized;
        const stateMap = optionalObject(req.body?.state);
        if (!stateMap) {
          return pdppError(res, 400, 'invalid_request', 'state body must be an object map of streams to cursors', 'state');
        }
        const storageTarget = referenceLocalDeviceStorageTarget(
          sourceInstance.connectorId,
          connectorInstance.connectorInstanceId,
        );
        const projection = await putSyncState(storageTarget, stateMap, { grantId: null });
        res.json({
          object: 'device_source_instance_state',
          device_id: deviceId,
          connector_instance_id: connectorInstance.connectorInstanceId,
          source_instance_id: sourceInstanceId,
          state: projection.state ?? {},
          updated_at: projection.updated_at ?? null,
        });
      } catch (err) {
        handleError(res, err);
      }
    },
  );

  // POST /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/local-collector-gaps
  // Device-scoped acknowledgement route for `gap` outbox rows produced by
  // the local collector runner (queue-depth deferrals, connector child
  // crashes, etc.). Reuses the existing `connector_detail_gaps` storage
  // because that table already models retryable pending evidence keyed by
  // (connector_id, connector_instance_id, stream, ...). The local
  // collector does not always know a real connector stream, so the route
  // namespaces gaps under a synthetic `local-collector/<reason>` stream
  // while still binding the source to the enrolled device source
  // instance. `connector_id` and `connector_instance_id` are derived
  // server-side from the authorized source instance; the client's
  // `connector_id` must match. Reference-only; not part of PDPP Core.
  app.post(
    '/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/local-collector-gaps',
    requireDeviceExporterCredential,
    async (req, res) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId);
        if (deviceId !== req.deviceExporter.deviceId) {
          return pdppError(res, 403, 'permission_error', 'Device credential is not valid for this device');
        }
        const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId);
        const authorized = await resolveAuthorizedDeviceSource(req, res, deviceId, sourceInstanceId, { notFoundStatus: 404 });
        if (!authorized) return;
        const { sourceInstance, connectorInstance } = authorized;

        const body = req.body || {};
        const bodySourceInstanceId = requireNonEmptyString(body.source_instance_id, 'source_instance_id');
        if (bodySourceInstanceId !== sourceInstanceId) {
          return pdppError(res, 400, 'invalid_request', 'body source_instance_id must match path sourceInstanceId', 'source_instance_id');
        }
        const connectorId = requireNonEmptyString(body.connector_id, 'connector_id');
        if (connectorId !== sourceInstance.connectorId) {
          return pdppError(res, 400, 'invalid_request', 'connector_id does not match source_instance_id', 'connector_id');
        }
        const reason = requireNonEmptyString(body.reason, 'reason');
        if (reason !== 'policy_budget' && reason !== 'connector_child_failure') {
          return pdppError(res, 400, 'invalid_request', 'reason must be one of: policy_budget, connector_child_failure', 'reason');
        }
        const firstSeenAt = requireNonEmptyString(body.first_seen_at, 'first_seen_at');
        if (Number.isNaN(Date.parse(firstSeenAt))) {
          return pdppError(res, 400, 'invalid_request', 'first_seen_at must be an ISO timestamp', 'first_seen_at');
        }
        if (typeof body.retryable !== 'boolean') {
          return pdppError(res, 400, 'invalid_request', 'retryable must be a boolean', 'retryable');
        }
        if (!Number.isFinite(body.next_attempt_backoff_ms) || body.next_attempt_backoff_ms < 0) {
          return pdppError(res, 400, 'invalid_request', 'next_attempt_backoff_ms must be a non-negative number', 'next_attempt_backoff_ms');
        }

        const streamName = typeof body.stream === 'string' && body.stream.trim()
          ? body.stream.trim()
          : null;
        const streamBoundary = typeof body.stream_boundary === 'string' && body.stream_boundary.trim()
          ? body.stream_boundary.trim()
          : null;
        const firstSeenRunId = typeof body.first_seen_run_id === 'string' && body.first_seen_run_id.trim()
          ? body.first_seen_run_id.trim()
          : null;
        const lastRunId = typeof body.last_run_id === 'string' && body.last_run_id.trim()
          ? body.last_run_id.trim()
          : firstSeenRunId;
        const details = sanitizeLocalCollectorGapDetails(body.details);

        // Use a synthetic stream namespace so a local-collector gap can
        // never collide with real connector-data streams that share the
        // same connector_instance_id. The optional client-supplied stream
        // is preserved inside `detail_locator_json` for diagnostics.
        const syntheticStream = streamName
          ? `local-collector/${reason}/${streamName}`
          : `local-collector/${reason}`;

        const detailLocator = {
          kind: 'local_collector_gap',
          reason,
          ...(streamName ? { stream: streamName } : {}),
          ...(streamBoundary ? { stream_boundary: streamBoundary } : {}),
        };
        const source = {
          kind: 'local_device',
          device_id: deviceId,
          source_instance_id: sourceInstanceId,
        };
        const lastError = {
          first_seen_at: firstSeenAt,
          next_attempt_backoff_ms: body.next_attempt_backoff_ms,
          ...(details ? { details } : {}),
        };

        const store = getDefaultConnectorDetailGapStore();
        const gap = await store.upsertPendingGap({
          connectorId,
          connectorInstanceId: connectorInstance.connectorInstanceId,
          stream: syntheticStream,
          source,
          detailLocator,
          reason,
          lastError,
          ...(firstSeenRunId ? { discoveredRunId: firstSeenRunId } : {}),
          ...(lastRunId ? { lastRunId } : {}),
        });

        res.status(201).json({
          object: 'device_local_collector_gap',
          device_id: deviceId,
          connector_id: connectorId,
          connector_instance_id: connectorInstance.connectorInstanceId,
          source_instance_id: sourceInstanceId,
          gap_id: gap.gap_id,
          stream: syntheticStream,
          reason,
          retryable: body.retryable,
          status: gap.status,
          attempt_count: gap.attempt_count,
          first_seen_at: firstSeenAt,
          first_seen_run_id: firstSeenRunId,
          last_run_id: gap.last_run_id ?? lastRunId,
          updated_at: gap.updated_at,
        });
      } catch (err) {
        if (err && err.code === 'invalid_request') {
          return pdppError(res, 400, 'invalid_request', err.message, err.param || null);
        }
        handleError(res, err);
      }
    },
  );

  // POST /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/local-collector-gaps/recovered
  // Marks a previously reported local-collector gap as recovered once a later
  // clean local run has drained its blocking work and can safely stop
  // degrading connection coverage. The device still cannot choose connector
  // instance identity: the route derives it from the enrolled source binding.
  app.post(
    '/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/local-collector-gaps/recovered',
    requireDeviceExporterCredential,
    async (req, res) => {
      try {
        const deviceId = decodeURIComponent(req.params.deviceId);
        if (deviceId !== req.deviceExporter.deviceId) {
          return pdppError(res, 403, 'permission_error', 'Device credential is not valid for this device');
        }
        const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId);
        const authorized = await resolveAuthorizedDeviceSource(req, res, deviceId, sourceInstanceId, { notFoundStatus: 404 });
        if (!authorized) return;
        const { sourceInstance, connectorInstance } = authorized;

        const body = req.body || {};
        const bodySourceInstanceId = requireNonEmptyString(body.source_instance_id, 'source_instance_id');
        if (bodySourceInstanceId !== sourceInstanceId) {
          return pdppError(res, 400, 'invalid_request', 'body source_instance_id must match path sourceInstanceId', 'source_instance_id');
        }
        const connectorId = requireNonEmptyString(body.connector_id, 'connector_id');
        if (connectorId !== sourceInstance.connectorId) {
          return pdppError(res, 400, 'invalid_request', 'connector_id does not match source_instance_id', 'connector_id');
        }
        const reason = requireNonEmptyString(body.reason, 'reason');
        if (reason !== 'policy_budget' && reason !== 'connector_child_failure') {
          return pdppError(res, 400, 'invalid_request', 'reason must be one of: policy_budget, connector_child_failure', 'reason');
        }

        const streamName = typeof body.stream === 'string' && body.stream.trim()
          ? body.stream.trim()
          : null;
        const streamBoundary = typeof body.stream_boundary === 'string' && body.stream_boundary.trim()
          ? body.stream_boundary.trim()
          : null;
        const recoveredRunId = typeof body.recovered_run_id === 'string' && body.recovered_run_id.trim()
          ? body.recovered_run_id.trim()
          : null;
        const syntheticStream = streamName
          ? `local-collector/${reason}/${streamName}`
          : `local-collector/${reason}`;
        const detailLocator = {
          kind: 'local_collector_gap',
          reason,
          ...(streamName ? { stream: streamName } : {}),
          ...(streamBoundary ? { stream_boundary: streamBoundary } : {}),
        };
        const source = {
          kind: 'local_device',
          device_id: deviceId,
          source_instance_id: sourceInstanceId,
        };

        const store = getDefaultConnectorDetailGapStore();
        const gap = await store.upsertPendingGap({
          connectorId,
          connectorInstanceId: connectorInstance.connectorInstanceId,
          stream: syntheticStream,
          source,
          detailLocator,
          reason,
          lastError: {
            recovered_by: 'local_collector',
            recovered_at: new Date().toISOString(),
          },
          ...(recoveredRunId ? { discoveredRunId: recoveredRunId, lastRunId: recoveredRunId } : {}),
        });
        const recovered = await store.markGapStatus(gap.gap_id, 'recovered', {
          ...(recoveredRunId ? { runId: recoveredRunId } : {}),
        });

        res.status(200).json({
          object: 'device_local_collector_gap',
          device_id: deviceId,
          connector_id: connectorId,
          connector_instance_id: connectorInstance.connectorInstanceId,
          source_instance_id: sourceInstanceId,
          gap_id: recovered.gap_id,
          stream: syntheticStream,
          reason,
          retryable: false,
          status: recovered.status,
          attempt_count: recovered.attempt_count,
          first_seen_at: null,
          first_seen_run_id: recovered.discovered_run_id ?? null,
          last_run_id: recovered.last_run_id ?? recoveredRunId,
          updated_at: recovered.updated_at,
        });
      } catch (err) {
        if (err && err.code === 'invalid_request') {
          return pdppError(res, 400, 'invalid_request', err.message, err.param || null);
        }
        handleError(res, err);
      }
    },
  );

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

  mountRefConnectorRun(app, refConnectorsContext);
  mountRefConnectionRun(app, refConnectorsContext);
  mountRefConnectorScheduleUpsert(app, refConnectorsContext);
  mountRefConnectionScheduleUpsert(app, refConnectorsContext);
  mountRefConnectorSchedulePause(app, refConnectorsContext);
  mountRefConnectionSchedulePause(app, refConnectorsContext);
  mountRefConnectorScheduleResume(app, refConnectorsContext);
  mountRefConnectionScheduleResume(app, refConnectorsContext);
  mountRefConnectorScheduleDelete(app, refConnectorsContext);
  mountRefConnectionScheduleDelete(app, refConnectorsContext);

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
      const approvedRequestUri = req.body?.request_uri || req.query?.request_uri;
      const deviceCode = consentStore.parseRequestUri(approvedRequestUri);
      const oauthCode = await issueOAuthAuthorizationCodeForDeviceCode(deviceCode, {
        grantId: grant.grant_id,
        token,
      });
      if (oauthCode) {
        const redirectUrl = new URL(oauthCode.redirect_uri);
        redirectUrl.searchParams.set('code', oauthCode.code);
        if (oauthCode.state) {
          redirectUrl.searchParams.set('state', oauthCode.state);
        }
        return res.redirect(302, redirectUrl.toString());
      }
      completeAgentConnectAttempt(approvedRequestUri, {
        status: 'approved',
        token,
        grant,
      });
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
      failAgentConnectAttempt(req.body?.request_uri || req.query?.request_uri, 'denied');
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
      // Apply client-event-subscription grant-revoke side effects after the
      // grant row has transitioned. Failures here MUST NOT leak through to
      // the revoke envelope or retroactively undo the revocation.
      try {
        await executeApplyGrantRevoke(req.params.grantId, {
          store: getDefaultClientEventSubscriptionStore(),
          nowIso: () => new Date().toISOString(),
        });
        // Fire-and-forget tick so the grant.revoked envelope can ship without
        // waiting for the periodic worker.
        getDefaultDeliveryWorker().tick().catch(() => { /* surfaced via attempt log */ });
      } catch (hookErr) {
        opts.logger?.warn?.({ err: String(hookErr?.message ?? hookErr) }, 'client-event-subscriptions: revoke hook failed');
      }
      res.json(output.envelope);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Client event subscriptions are mounted on the RESOURCE SERVER under
  // `/v1/event-subscriptions` (see buildRsApp). They are the same kind of
  // client-facing surface as `/v1/streams/:s/records` — grant-scoped client
  // bearer reads — and they are advertised in protected-resource metadata as
  // an RI extension. The AS host no longer mounts a `_ref` alias for them.

  return app;
}

// ─── RS App ─────────────────────────────────────────────────────────────────

function buildAgentDiscoveryMetadata(origin, { noOwnerToken = true } = {}) {
  if (!origin) {
    return null;
  }
  const base = stripTrailingSlash(origin);
  const cli = getPdppCliPackageInfo(base);
  const noOwnerTokenPolicy = noOwnerToken
    ? cli.noOwnerTokenPolicy
    : 'requires_native_reference_provider_for_one_command_connect';
  return {
    advisory: true,
    skill_name: 'pdpp-data-access',
    recommended_flow: 'pdpp connect',
    cli: {
      package: cli.packageName,
      package_specifier: cli.packageSpecifier,
      bin_name: cli.binName,
      install_command: `npx -y ${cli.packageSpecifier} --help`,
      run_command: cli.runCommand,
      connect_command: createPdppCliCommand('<provider-url>'),
      version_policy: cli.versionPolicy,
      no_owner_token: noOwnerToken,
      no_owner_token_policy: noOwnerTokenPolicy,
    },
    skill_catalog: `${base}/.well-known/skills/index.json`,
    skill: `${base}/.well-known/skills/pdpp-data-access/SKILL.md`,
    mcp: {
      transport: 'streamable_http',
      endpoint: `${base}/mcp`,
      no_owner_token: true,
    },
    llms_txt: `${base}/llms.txt`,
    llms_full_txt: `${base}/llms-full.txt`,
  };
}

function buildRsApp(opts = {}) {
  const app = createApp({ logger: opts.logger });
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  const referenceRevision = resolveReferenceRevision(opts);
  const explicitResource = opts.rsPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.RS_PUBLIC_URL : null);
  const trustedMetadataHosts = opts.trustedMetadataHosts ?? (!opts.ignoreAmbientPublicUrls ? process.env.PDPP_TRUSTED_HOSTS : null);

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
    const metadataUrl = resolveTrustedProtectedResourceMetadataUrl(req, explicitResource, trustedMetadataHosts);
    if (metadataUrl) {
      res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = metadataUrl;
    }
    next();
  });

  function buildMcpWebRequest(req, resource) {
    const url = new URL(req.raw?.url || req.url || req.path || '/mcp', resource);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers || {})) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, String(item));
      } else if (value !== undefined) {
        headers.set(name, String(value));
      }
    }

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        body = req.body;
      } else if (req.body !== undefined) {
        body = JSON.stringify(req.body);
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
      }
    }

    return new Request(url.toString(), {
      method: req.method,
      headers,
      body,
    });
  }

  async function sendWebResponse(res, response) {
    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    if (response.status === 204 || response.status === 304) {
      return res.end();
    }
    const body = Buffer.from(await response.arrayBuffer());
    return res.send(body);
  }

  async function handleHostedMcp(req, res) {
    const resource = resolvePublicUrl(req, explicitResource);
    const inboundToken = req.headers.authorization.slice(7);

    // Package-token resolution. When the inbound bearer is an mcp_package
    // token, the resource server's REST surface will reject it
    // (requireClient gates everything outside /mcp). For package tokens we
    // inject a `PackageRsClient` that fans out reads across the package's
    // active child grants and routes single-source operations under exactly
    // one child grant's bearer. Single-source tokens keep the existing
    // single-bearer RsClient path.
    let mcpServerOptions;
    if (req.tokenInfo?.pdpp_token_kind === 'mcp_package') {
      const access = await getGrantPackageAccess(req.tokenInfo.grant_package_id);
      if (!access || access.members.length === 0) {
        return pdppError(res, 403, 'package_revoked', 'Grant package is revoked or has no active members');
      }
      const rsClient = createPackageRsClient({
        providerUrl: resource,
        members: access.members,
        fetch: globalThis.fetch,
      });
      mcpServerOptions = {
        providerUrl: resource,
        rsClient,
        fetch: globalThis.fetch,
        serverName: 'pdpp-reference-mcp',
        serverVersion: referenceRevision,
      };
      res.setHeader('x-pdpp-grant-package-id', req.tokenInfo.grant_package_id);
      res.setHeader('x-pdpp-grant-package-member-count', String(access.members.length));
    } else {
      mcpServerOptions = {
        providerUrl: resource,
        accessToken: inboundToken,
        fetch: globalThis.fetch,
        serverName: 'pdpp-reference-mcp',
        serverVersion: referenceRevision,
      };
    }
    const webRequest = buildMcpWebRequest(req, resource);
    const response = await handleStreamableHttpRequest(webRequest, mcpServerOptions);
    return sendWebResponse(res, response);
  }

  function setHostedMcpProtectedResourceMetadata(req, res, next) {
    if (isTrustedMetadataRequestOrigin(req, explicitResource, trustedMetadataHosts)) {
      const resource = `${resolvePublicUrl(req, explicitResource)}/mcp`;
      res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = protectedResourceMetadataUrlForResource(resource);
    }
    next();
  }

  function requireTrustedHostedMcpResource(req, res, next) {
    if (rejectUntrustedMetadataHost(req, res, explicitResource, trustedMetadataHosts)) {
      return;
    }
    next();
  }

  app.get('/mcp', requireTrustedHostedMcpResource, setHostedMcpProtectedResourceMetadata, requireToken, requireClientOrMcpPackage, handleHostedMcp);
  app.post('/mcp', requireTrustedHostedMcpResource, setHostedMcpProtectedResourceMetadata, requireToken, requireClientOrMcpPackage, handleHostedMcp);
  app.delete('/mcp', requireTrustedHostedMcpResource, setHostedMcpProtectedResourceMetadata, requireToken, requireClientOrMcpPackage, handleHostedMcp);

  // ────────────────────────────────────────────────────────────────────────
  // /v1/event-subscriptions — outbound client event subscriptions (RI extension)
  // ────────────────────────────────────────────────────────────────────────
  // Same auth shape as the other /v1 client reads: client bearer required;
  // the persisted subscription stores the bearer's (client_id, grant_id,
  // subject_id) so subsequent operations refuse bearers whose grant does
  // not match. Advertised in `/.well-known/oauth-protected-resource` as a
  // `client_event_subscriptions` capability — reference implementation
  // extension, NOT Core PDPP.
  //
  // See:
  //   openspec/changes/add-client-event-subscriptions/
  function buildBearerActorFromTokenInfo(req) {
    const ti = req.tokenInfo || {};
    const grant = ti.grant || {};
    const scope = {
      source: grant.source,
      streams: Array.isArray(grant.streams)
        ? grant.streams.map((s) => ({
            name: s.name,
            ...(s.connection_id ? { connection_id: s.connection_id } : {}),
            ...(s.resources ? { resources: s.resources } : {}),
            ...(s.time_range ? { time_range: s.time_range } : {}),
          }))
        : [],
    };
    return {
      clientId: ti.client_id || null,
      grantId: ti.grant_id || null,
      subjectId: ti.subject_id || null,
      grantScope: scope,
    };
  }
  const clientEventSubsDeps = () => ({
    store: getDefaultClientEventSubscriptionStore(),
    nowIso: () => new Date().toISOString(),
  });
  function handleClientEventSubError(res, err) {
    if (err && err.name === 'ClientEventSubscriptionError') {
      return pdppError(res, err.status || 400, err.code, err.message);
    }
    return handleError(res, err);
  }

  app.post('/v1/event-subscriptions', requireToken, requireClient, async (req, res) => {
    try {
      const actor = buildBearerActorFromTokenInfo(req);
      if (!actor.clientId || !actor.grantId) {
        return pdppError(res, 403, 'grant_invalid', 'client subscription requires an active client grant');
      }
      const filters =
        req.body && typeof req.body === 'object' && req.body.filters && typeof req.body.filters === 'object'
          ? req.body.filters
          : undefined;
      const out = await executeCreateSubscription(
        {
          actor,
          callbackUrl: typeof req.body?.callback_url === 'string' ? req.body.callback_url : '',
          filters,
        },
        clientEventSubsDeps(),
      );
      // Best-effort: fire the verification tick once so the handshake is
      // visible to tests without waiting for the timer.
      try {
        await getDefaultDeliveryWorker().tick();
      } catch { /* ignored */ }
      res.status(201).json({
        subscription_id: out.subscriptionId,
        secret: out.secret,
        status: out.status,
        callback_url: out.callbackUrl,
        created_at: out.createdAt,
      });
    } catch (err) {
      handleClientEventSubError(res, err);
    }
  });

  app.get('/v1/event-subscriptions', requireToken, requireClient, async (req, res) => {
    try {
      const actor = buildBearerActorFromTokenInfo(req);
      const out = await executeListSubscriptions(actor, clientEventSubsDeps());
      res.json(out);
    } catch (err) {
      handleClientEventSubError(res, err);
    }
  });

  app.get('/v1/event-subscriptions/:id', requireToken, requireClient, async (req, res) => {
    try {
      const actor = buildBearerActorFromTokenInfo(req);
      const out = await executeGetSubscription(actor, req.params.id, clientEventSubsDeps());
      res.json(out);
    } catch (err) {
      handleClientEventSubError(res, err);
    }
  });

  app.patch('/v1/event-subscriptions/:id', requireToken, requireClient, async (req, res) => {
    try {
      const actor = buildBearerActorFromTokenInfo(req);
      const body = req.body || {};
      const out = await executeUpdateSubscription(
        actor,
        req.params.id,
        {
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(body.rotate_secret === true ? { rotateSecret: true } : {}),
        },
        clientEventSubsDeps(),
      );
      res.json(out);
    } catch (err) {
      handleClientEventSubError(res, err);
    }
  });

  app.delete('/v1/event-subscriptions/:id', requireToken, requireClient, async (req, res) => {
    try {
      const actor = buildBearerActorFromTokenInfo(req);
      await executeDeleteSubscription(actor, req.params.id, clientEventSubsDeps());
      res.status(204).end();
    } catch (err) {
      handleClientEventSubError(res, err);
    }
  });

  app.post('/v1/event-subscriptions/:id/test-event', requireToken, requireClient, async (req, res) => {
    try {
      const actor = buildBearerActorFromTokenInfo(req);
      const out = await executeEnqueueTestEvent(actor, req.params.id, clientEventSubsDeps());
      try {
        await getDefaultDeliveryWorker().tick();
      } catch { /* ignored */ }
      res.status(202).json({ event_id: out.eventId });
    } catch (err) {
      handleClientEventSubError(res, err);
    }
  });

  // Shared hosted-UI stylesheet, mounted on the RS app so the browser-friendly
  // RS root landing (see below) can load styles from its own origin without
  // depending on the AS port being reachable.
  app.get(HOSTED_UI_CSS_PATH, (req, res) => {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(HOSTED_UI_CSS);
  });

  // RS root (`GET /`) is mounted via `server/routes/root-and-discovery.ts`
  // per OpenSpec change `split-reference-server-by-route-family`. Behaviour-
  // preserving extraction: same mount point, same handler, same envelope.
  mountRsRoot(app, {
    providerName,
    referenceRevision,
    servedRootLandingIfBrowser,
  });

  // RS `/.well-known/oauth-protected-resource` and `/oauth-protected-resource/mcp`
  // are mounted via `server/routes/root-and-discovery.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Behaviour-preserving extraction:
  // same mount points, same handlers, same envelopes.
  const protectedResourceMetadataContext = {
    agentDiscoveryOrigin: opts.agentDiscoveryOrigin || null,
    asPort: opts.asPort || AS_PORT,
    buildAgentDiscoveryMetadata,
    buildDefaultHybridCapability: ({ lexicalAvailable, semanticAvailable }) =>
      buildHybridRetrievalCapability({ lexicalAvailable, semanticAvailable }),
    buildProtectedResourceMetadata,
    explicitResource,
    isHybridSuppressed: () => opts.hybridRetrievalSupported === false,
    nativeMode,
    pdppProviderConnectVersion: PDPP_PROVIDER_CONNECT_VERSION,
    providerName,
    rejectUntrustedMetadataHost,
    resolveClientEventSubscriptionsCapability: () => {
      if (opts.clientEventSubscriptionsCapability) {
        return opts.clientEventSubscriptionsCapability;
      }
      if (opts.clientEventSubscriptionsSupported === false) return null;
      return buildClientEventSubscriptionsCapability();
    },
    resolveExplicitIssuer: () =>
      opts.asIssuer ||
      opts.asPublicUrl ||
      (!opts.ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null),
    resolveHybridCapabilityOverride: () => opts.hybridRetrievalCapability || null,
    resolveLexicalCapability: () => {
      if (opts.lexicalRetrievalCapability) {
        return opts.lexicalRetrievalCapability;
      }
      if (opts.lexicalRetrievalSupported !== false) {
        return buildLexicalRetrievalCapability();
      }
      return null;
    },
    resolvePublicUrl,
    resolveSemanticCapability: async () => {
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
          indexState: await computeSemanticIndexState(),
          profileId: semBackend.profileId ? semBackend.profileId() : null,
          dtype: semBackend.dtype ? semBackend.dtype() : null,
          languageBias: semBackend.languageBias ? semBackend.languageBias() : null,
        }) || null
      );
    },
    resolveSiblingPublicUrl,
    shouldUseDirectRequestOrigin,
    trustedMetadataHosts,
  };
  mountRsProtectedResourceMetadata(app, protectedResourceMetadataContext);
  mountRsMcpProtectedResourceMetadata(app, protectedResourceMetadataContext);

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
        sourceDescriptor: tokenInfo.pdpp_token_kind === 'owner'
          ? buildOwnerQuerySourceDescriptor(req, opts)
          : buildClientSourceDescriptor(tokenInfo),
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
        sourceDescriptor: tokenInfo.pdpp_token_kind === 'owner'
          ? buildOwnerQuerySourceDescriptor(req, opts)
          : buildClientSourceDescriptor(tokenInfo),
        queryData: { query_shape: 'schema' },
      };

      let operationInput;
      let dependencies;
      if (tokenInfo.pdpp_token_kind === 'owner') {
        operationInput = {
          actor: { kind: 'owner', subject_id: tokenInfo.subject_id || null },
        };
        const ownerSubjectId = ownerSubjectIdForBindings(tokenInfo);
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
                ownerSubjectId,
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
                  ownerSubjectId,
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
        const ownerSubjectId = ownerSubjectIdForBindings(tokenInfo);
        dependencies = {
          getSourceDescriptor: () => source,
          listConnectorItems: async () => {
            const item = await buildConnectorSchemaItem({
              source,
              storageBinding: grantResolved.storageBinding,
              manifest: grantResolved.manifest,
              grant: tokenInfo.grant,
              ownerSubjectId,
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

      res.json(finalizeCanonicalEnvelope(result.response, req));
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
        sourceDescriptor: tokenInfo.pdpp_token_kind === 'owner'
          ? buildOwnerQuerySourceDescriptor(req, opts)
          : buildClientSourceDescriptor(tokenInfo),
        queryData: { query_shape: 'stream_list' },
      };

      let operationInput;
      let dependencies;
      let streamListFreshnessEvidence = null;
      if (tokenInfo.pdpp_token_kind === 'owner') {
        const ownerScope = resolveOwnerReadScope(req, opts);
        // Set source before manifest resolution so malformed connector
        // failures remain attributable in query.received/query.rejected.
        queryContext.sourceDescriptor = buildSourceDescriptor(ownerScope.source);
        const ownerResolved = await resolveOwnerManifest(req, opts);
        streamListFreshnessEvidence = await getConnectorFreshnessEvidence({
          source: ownerScope.source,
          manifest: ownerResolved.manifest,
        });
        operationInput = {
          actor: { kind: 'owner', subject_id: tokenInfo.subject_id || null },
        };
        dependencies = {
          getSourceDescriptor: () => queryContext.sourceDescriptor,
          listSummaries: async () => listAllStreams(ownerResolved.storageBinding),
        };
      } else {
        const grant = tokenInfo.grant;
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        streamListFreshnessEvidence = await getConnectorFreshnessEvidence({
          source: grantResolved.source,
          manifest: grantResolved.manifest,
        });
        const streamCountLimit = Array.isArray(grant?.streams) ? grant.streams.length : null;
        queryContext.sourceDescriptor = grantResolved.source;
        queryContext.queryData.stream_count_limit = streamCountLimit;
        operationInput = {
          actor: {
            kind: 'client',
            subject_id: tokenInfo.subject_id || null,
            client_id: tokenInfo.client_id || null,
            grant_id: tokenInfo.grant_id || null,
            stream_count_limit: streamCountLimit,
          },
          connection_id:
            typeof req.query?.connection_id === 'string' && req.query.connection_id
              ? req.query.connection_id
              : typeof req.query?.connector_instance_id === 'string' && req.query.connector_instance_id
                ? req.query.connector_instance_id
                : null,
        };
        dependencies = {
          getSourceDescriptor: () => queryContext.sourceDescriptor,
          listSummaries: async () => {
            // Honor request-time `connection_id` filter and grant-scope
            // `connection_id` constraint. When neither is set, fan in
            // across every active connection under the grant's connector.
            //
            // Each grant stream may pin a different `connection_id`; the
            // resolver runs per-stream so per-stream record counts honor
            // the right binding constraint instead of borrowing the first
            // stream's resolution.
            const firstStream = Array.isArray(grant?.streams) ? grant.streams[0]?.name : null;
            const { bindings, warnings: resolverWarnings } = await resolveReadRequestBindings({
              ownerSubjectId: ownerSubjectIdForBindings(tokenInfo),
              storageBinding: grantResolved.storageBinding,
              grant,
              requestParams: req.query || {},
              streamName: firstStream,
              nativeProviderStorage: grantResolved.source?.kind === 'provider_native',
            });
            // Stash resolver warnings on the request scope so the route
            // body below can thread them into `meta.warnings` (P3 fix).
            req._pdpp_resolver_warnings = resolverWarnings;
            const summaries = await listStreamsAcrossBindings(
              bindings,
              grant,
              grantResolved.manifest,
              {
                resolveBindingsForStream: async (streamGrant) => {
                  const { bindings: streamBindings } = await resolveReadRequestBindings({
                    ownerSubjectId: ownerSubjectIdForBindings(tokenInfo),
                    storageBinding: grantResolved.storageBinding,
                    grant,
                    requestParams: req.query || {},
                    streamName: streamGrant?.name || null,
                    nativeProviderStorage: grantResolved.source?.kind === 'provider_native',
                  });
                  return streamBindings;
                },
              },
            );
            return summaries;
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

      const streamsListBody = {
        object: 'list',
        has_more: false,
        data: result.streams.map((summary) => ({
          ...summary,
          freshness: buildConnectorAwareFreshness(streamListFreshnessEvidence, summary.last_updated || null),
        })),
      };
      const resolverWarnings = req._pdpp_resolver_warnings;
      if (Array.isArray(resolverWarnings) && resolverWarnings.length) {
        const existingMeta = streamsListBody.meta && typeof streamsListBody.meta === 'object'
          && !Array.isArray(streamsListBody.meta)
          ? streamsListBody.meta
          : null;
        const existingWarnings = existingMeta && Array.isArray(existingMeta.warnings)
          ? existingMeta.warnings
          : [];
        streamsListBody.meta = {
          ...(existingMeta || {}),
          warnings: [...existingWarnings, ...resolverWarnings],
        };
      }
      res.json(finalizeCanonicalEnvelope(streamsListBody, req));
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
        ? buildOwnerQuerySourceDescriptor(req, opts)
        : buildClientSourceDescriptor(tokenInfo);

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
        storageBinding = ownerResolved.storageBinding;
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        manifest = grantResolved.manifest;
        sourceDescriptor = grantResolved.source;
        queryContext.sourceDescriptor = sourceDescriptor;
        storageBinding = grantResolved.storageBinding;
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
            source: sourceDescriptor,
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

      res.json(finalizeCanonicalEnvelope(metadataBody, req));
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
        ? buildOwnerQuerySourceDescriptor(req, opts)
        : buildClientSourceDescriptor(tokenInfo);
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
        aggregate: async (params) => {
          const { bindings, warnings: resolverWarnings } = await resolveReadRequestBindings({
            ownerSubjectId: ownerSubjectIdForBindings(tokenInfo),
            storageBinding,
            grant,
            requestParams: params,
            streamName: req.params.stream,
            nativeProviderStorage: sourceDescriptor?.kind === 'provider_native',
          });
          // P3: thread resolver-level warnings (deprecated alias) into the
          // multi-binding aggregate envelope. The helper folds them into
          // `meta.warnings[]` whether the dispatch hits the single-binding
          // fast path or the multi-binding fan-in path.
          return await aggregateRecordsAcrossBindings(
            bindings,
            req.params.stream,
            grant,
            params,
            manifest,
            { extraWarnings: resolverWarnings || [] },
          );
        },
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

      res.json(finalizeCanonicalEnvelope(result.result, req));
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
        ? buildOwnerQuerySourceDescriptor(req, opts)
        : buildClientSourceDescriptor(tokenInfo);
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
        queryRecords: async (stream, grant, params, m) => {
          const { bindings, warnings: resolverWarnings } = await resolveReadRequestBindings({
            ownerSubjectId: ownerSubjectIdForBindings(tokenInfo),
            storageBinding,
            grant,
            requestParams: params,
            streamName: stream,
            nativeProviderStorage: sourceDescriptor?.kind === 'provider_native',
          });
          return await queryRecordsAcrossBindings(
            bindings,
            stream,
            grant,
            params,
            m,
            { extraWarnings: resolverWarnings || [] },
          );
        },
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

      res.json(finalizeCanonicalEnvelope({
        ...result.result,
        url: req.path,
      }, req));
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
        ? buildOwnerQuerySourceDescriptor(req, opts)
        : buildClientSourceDescriptor(tokenInfo);
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
        getRecord: async (stream, recordId, grant, m, options) => {
          const mergedParams = { ...(req.query || {}), ...(options || {}) };
          const { bindings, warnings: resolverWarnings } = await resolveReadRequestBindings({
            ownerSubjectId: ownerSubjectIdForBindings(tokenInfo),
            storageBinding,
            grant,
            requestParams: mergedParams,
            streamName: stream,
            nativeProviderStorage: sourceDescriptor?.kind === 'provider_native',
          });
          return await getRecordAcrossBindings(
            bindings,
            stream,
            recordId,
            grant,
            m,
            mergedParams,
            { extraWarnings: resolverWarnings || [] },
          );
        },
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
      res.json(finalizeCanonicalEnvelope(result.record, req));
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
        sourceDescriptor: isOwner ? null : buildClientSourceDescriptor(tokenInfo),
        streamId: null,
        queryData: { query_shape: 'search' },
      };
      await emitQueryReceived(queryContext, req);

      const { envelope, disclosureData } = await runLexicalSearch({
        req,
        opts,
        tokenInfo,
        getOwnerSubjectId: () => getOwnerTokenSubjectId(req),
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
          owner_subject_id: getOwnerTokenSubjectId(req),
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

      res.json(finalizeCanonicalEnvelope(envelope, req));
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
          sourceDescriptor: isOwner ? null : buildClientSourceDescriptor(tokenInfo),
          streamId: null,
          queryData: { query_shape: 'search_semantic' },
        };
        await emitQueryReceived(queryContext, req);

        const { envelope, disclosureData } = await runSemanticSearch({
          req,
          opts,
          tokenInfo,
          getOwnerSubjectId: () => getOwnerTokenSubjectId(req),
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
            owner_subject_id: getOwnerTokenSubjectId(req),
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

        res.json(finalizeCanonicalEnvelope(envelope, req));
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
          sourceDescriptor: isOwner ? null : buildClientSourceDescriptor(tokenInfo),
          streamId: null,
          queryData: { query_shape: 'search_hybrid' },
        };
        await emitQueryReceived(queryContext, req);

        const { envelope, disclosureData } = await runHybridSearch({
          req,
          opts,
          tokenInfo,
          getOwnerSubjectId: () => getOwnerTokenSubjectId(req),
          resolveOwnerVisibleConnectorIds: async () => {
            const native = resolveNativeManifest(opts);
            if (native?.storage_binding?.connector_id) {
              return [native.storage_binding.connector_id];
            }
            return await listRegisteredConnectorIds();
          },
          resolveOwnerScopeForConnector: (connectorId) => ({
            public_scope: 'polyfill',
            owner_subject_id: getOwnerTokenSubjectId(req),
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

        res.json(finalizeCanonicalEnvelope(envelope, req));
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
      let storageNamespace = null;
      const dependencies = {
        hasManifestStream: async (connectorId, streamName) => {
          manifestCache = await resolveRegisteredConnectorManifest(connectorId);
          const visible = Boolean(
            (manifestCache.streams || []).find((candidate) => candidate.name === streamName),
          );
          if (visible) {
            storageNamespace = await resolveOwnerConnectorNamespace(req, connectorId);
          }
          return visible;
        },
        persistBlob: async ({ connectorId, stream, recordKey, mimeType, data }) => {
          const namespace = storageNamespace ?? await resolveOwnerConnectorNamespace(req, connectorId);
          return persistContentAddressedBlob({
            connectorId: namespace.connectorId,
            connectorInstanceId: namespace.connectorInstanceId,
            stream,
            recordKey,
            mimeType,
            data: Buffer.isBuffer(data) ? data : Buffer.from(data),
          });
        },
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
      let nativeProviderStorage = false;
      if (tokenInfo.pdpp_token_kind === 'owner') {
        const ownerScope = resolveOwnerReadScope(req, opts);
        nativeProviderStorage = ownerScope.source?.kind === 'provider_native';
        const ownerResolved = await resolveOwnerManifestFromScope(ownerScope, opts);
        storageBinding = ownerResolved.storageBinding;
        manifest = ownerResolved.manifest;
      } else {
        const grantResolved = await resolveGrantManifest(tokenInfo, opts);
        nativeProviderStorage = grantResolved.source?.kind === 'provider_native';
        storageBinding = grantResolved.storageBinding;
        manifest = grantResolved.manifest;
      }

      // Resolve the default set of bindings this caller can address. When
      // the request supplies `connection_id` (or the deprecated alias) the
      // resolver narrows; otherwise the resolver fans in. The blob route
      // does not know the stream yet — that comes from per-binding records
      // — so we resolve without a stream constraint here and re-check the
      // per-stream grant-scope `connection_id` constraint per binding below.
      const { bindings: defaultBindings, requestConnectionId, warnings: resolverWarnings } =
        await resolveReadRequestBindings({
          ownerSubjectId: ownerSubjectIdForBindings(tokenInfo),
          storageBinding,
          grant: tokenInfo.grant || { streams: [] },
          requestParams: req.query || {},
          streamName: null,
          nativeProviderStorage,
        });
      const defaultAddressableInstanceIds = new Set(
        defaultBindings.map((b) => b.connectorInstanceId).filter(Boolean),
      );

      // Pre-load the blob and its bindings ourselves so we can perform a
      // route-level scan for ambiguity (P1 fix: the canonical operation
      // short-circuits on the first visible match and cannot observe
      // multiplicity) and so we can apply the per-stream grant-scope
      // `connection_id` constraint per blob binding (P2 fix: blobs cannot
      // borrow the connector-wide addressable set when the grant pins a
      // specific connection on the binding's stream).
      const blobRow = await blobStore.loadContentAddressedBlob(blobId);
      if (!blobRow) {
        const notFound = new Error('Blob not found');
        notFound.code = 'blob_not_found';
        throw notFound;
      }
      const blobBindings = await blobStore.listBlobBindings(blobId);
      const actorConnectorId = storageBinding?.connector_id ?? null;
      const grantStreams = Array.isArray(tokenInfo.grant?.streams) ? tokenInfo.grant.streams : [];
      const ownerMode = tokenInfo.pdpp_token_kind === 'owner';

      // Owner-mode addressable cache: owner can read any active connection
      // and there is no grant-scope connection_id constraint. Client mode
      // resolves `(stream → bindings)` lazily and honors per-stream
      // `grant.streams[].connection_id`.
      const streamBindingCache = new Map();
      async function resolveAddressableForStream(streamName) {
        if (ownerMode) {
          // Owner mode: no grant scoping; the default fan-in set already
          // captures every active connection under the actor's connector,
          // narrowed only by request-time `connection_id` (or alias).
          return defaultAddressableInstanceIds;
        }
        if (streamBindingCache.has(streamName)) return streamBindingCache.get(streamName);
        try {
          const { bindings: streamBindings } = await resolveReadRequestBindings({
            ownerSubjectId: ownerSubjectIdForBindings(tokenInfo),
            storageBinding,
            grant: tokenInfo.grant || { streams: [] },
            requestParams: req.query || {},
            streamName,
            nativeProviderStorage,
          });
          const ids = new Set(streamBindings.map((b) => b.connectorInstanceId).filter(Boolean));
          streamBindingCache.set(streamName, ids);
          return ids;
        } catch (err) {
          if (err?.code === 'connection_not_found' || err?.code === 'invalid_argument') {
            // Grant-scope pins a connection that is not currently active,
            // or the request supplied an addressable id outside the grant
            // for this stream. Treat the stream as inaccessible for the
            // blob-visibility check.
            const empty = new Set();
            streamBindingCache.set(streamName, empty);
            return empty;
          }
          throw err;
        }
      }

      // Iterate every blob binding and collect the unique connector
      // instances that expose a visible record referencing this blob.
      const matchedByInstance = new Map();
      for (const binding of blobBindings) {
        if (!actorConnectorId || binding.connector_id !== actorConnectorId) continue;
        const addressable = grantStreams.length || ownerMode
          ? await resolveAddressableForStream(binding.stream)
          : defaultAddressableInstanceIds;
        if (
          addressable.size > 0
          && binding.connector_instance_id
          && !addressable.has(binding.connector_instance_id)
        ) {
          continue;
        }
        const grant = ownerMode ? buildOwnerReadGrant(binding.stream) : tokenInfo.grant;
        const bindingStorageTarget = binding.connector_instance_id
          ? {
              connector_id: binding.connector_id,
              connector_instance_id: binding.connector_instance_id,
            }
          : storageBinding;
        let record = null;
        try {
          record = await getRecord(bindingStorageTarget, binding.stream, binding.record_key, grant, manifest);
        } catch (err) {
          if (err?.code === 'not_found') continue;
          throw err;
        }
        if (record?.data?.blob_ref?.blob_id !== blobId) continue;
        const instanceId = binding.connector_instance_id || null;
        if (!instanceId) continue;
        if (matchedByInstance.has(instanceId)) continue;
        matchedByInstance.set(instanceId, { binding, record });
      }

      if (matchedByInstance.size === 0) {
        const notFound = new Error('Blob not found');
        notFound.code = 'blob_not_found';
        throw notFound;
      }

      // Ambiguity: more than one connection exposed the blob and the
      // caller did not narrow with `connection_id`. Emit the typed
      // `ambiguous_connection` envelope with `available_connections`
      // so the caller can recover.
      if (matchedByInstance.size > 1 && !requestConnectionId) {
        const candidates = [];
        for (const [instanceId, m] of matchedByInstance) {
          const found = defaultBindings.find((b) => b.connectorInstanceId === instanceId);
          const wire = projectBindingForWire({
            connectorInstanceId: instanceId,
            connectorId: m.binding.connector_id,
            displayName: found?.displayName ?? null,
          });
          if (wire) candidates.push(wire);
        }
        throw new AmbiguousConnectionError(
          `Blob '${blobId}' is exposed by records under more than one connection. Retry with \`connection_id\`.`,
          candidates,
        );
      }

      // Single visible binding: serve the blob bytes. We still pipe the
      // resolved (single) binding through the canonical `executeBlobsRead`
      // operation so the route preserves the operation contract (404 / 200
      // shape, error mapping) even though we already validated visibility
      // ourselves above.
      const [selectedMatch] = matchedByInstance.values();
      const dependencies = {
        loadBlob: () => blobRow,
        loadBindings: () => [selectedMatch.binding],
        getActorConnectorId: () => actorConnectorId,
        getVisibleRecord: () => selectedMatch.record,
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
      res.setHeader('Cache-Control', 'private, no-store');
      // P3: when the resolver observed deprecated alias use, surface it as
      // a structured response header so callers see migration signal even
      // though the blob route emits raw bytes (no JSON envelope to carry
      // `meta.warnings[]`).
      if (Array.isArray(resolverWarnings) && resolverWarnings.length) {
        const deprecated = resolverWarnings.find(
          (w) => w?.code === 'deprecated_alias_used',
        );
        if (deprecated) {
          res.setHeader('PDPP-Warning', 'deprecated_alias_used: connector_instance_id');
        }
      }
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
      const connectorInstanceId = resolveSingleConnectorIdQueryValue(req.query.connector_instance_id);
      const mutationContext = buildMutationContext(req, res, {
        connectorId,
        connectorInstanceId,
        operation: 'delete_stream_records',
        streamId: req.params.stream,
      });
      try {
        let storageNamespace = null;
        const dependencies = {
          hasManifestStream: async (cid, streamName) => {
            const manifest = await resolveRegisteredConnectorManifest(cid);
            const visible = Boolean(
              (manifest.streams || []).find((stream) => stream.name === streamName),
            );
            if (visible) {
              storageNamespace = await resolveOwnerConnectorNamespace(req, cid, { connectorInstanceId });
            }
            return visible;
          },
          deleteAllRecords: async (cid, streamName) => {
            const namespace = storageNamespace ?? await resolveOwnerConnectorNamespace(req, cid, {
              connectorInstanceId,
            });
            return deleteAllRecords(storageTargetForConnectorNamespace(namespace), streamName);
          },
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
      const connectorInstanceId = resolveSingleConnectorIdQueryValue(req.query.connector_instance_id);
      const requestedRecordId = decodeURIComponent(req.params.id);
      const mutationContext = buildMutationContext(req, res, {
        connectorId,
        connectorInstanceId,
        operation: 'delete_record',
        streamId: req.params.stream,
        requestedRecordId,
      });
      try {
        let storageNamespace = null;
        const dependencies = {
          hasManifestStream: async (cid, streamName) => {
            const manifest = await resolveRegisteredConnectorManifest(cid);
            const visible = Boolean(
              (manifest.streams || []).find((stream) => stream.name === streamName),
            );
            if (visible) {
              storageNamespace = await resolveOwnerConnectorNamespace(req, cid, { connectorInstanceId });
            }
            return visible;
          },
          deleteRecord: async (cid, streamName, recordId) => {
            const namespace = storageNamespace ?? await resolveOwnerConnectorNamespace(req, cid, {
              connectorInstanceId,
            });
            return deleteRecord(storageTargetForConnectorNamespace(namespace), streamName, recordId);
          },
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

    // Reference-only signed source-webhook ingress is mounted via
    // `server/routes/source-webhooks.ts` per OpenSpec change
    // `split-reference-server-by-route-family` (§5.3). Behaviour-preserving
    // extraction: same path, same HMAC posture, same envelopes, same status
    // codes (202 on duplicate, 200 otherwise), same error mapping.
    mountRefSourceWebhooks(app, {
      controller: opts.controller,
      getManifestRefreshPolicy,
      getSchedulerStore: getDefaultSchedulerStore,
      getSourceWebhookEventStore: getDefaultSourceWebhookEventStore,
      handleError,
      ingestRecord: (connectorId, record) => ingestRecord(connectorId, record),
      parseSourceWebhookSecrets,
      pdppError,
      projectRunAutomationPolicy,
      resolveRegisteredConnectorManifest,
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
      const connectorInstanceId = resolveSingleConnectorIdQueryValue(req.query.connector_instance_id);
      const lines = parseIngestLines(typeof req.body === 'string' ? req.body : '');
      const mutationContext = buildMutationContext(req, res, {
        connectorId,
        connectorInstanceId,
        operation: 'ingest_records',
        streamId: req.params.stream,
        submittedRecordCount: lines.length,
      });
      try {
        let storageNamespace = null;
        const dependencies = {
          hasManifestStream: async (cid, streamName) => {
            const manifest = await resolveRegisteredConnectorManifest(cid);
            const visible = Boolean(
              (manifest.streams || []).find((stream) => stream.name === streamName),
            );
            if (visible) {
              storageNamespace = await resolveOwnerConnectorNamespace(req, cid, { connectorInstanceId });
            }
            return visible;
          },
          ingestRecord: async (cid, cin, record) => {
            const namespace = storageNamespace ?? await resolveOwnerConnectorNamespace(req, cid, {
              connectorInstanceId: cin,
            });
            return ingestRecord(storageTargetForConnectorNamespace(namespace), record);
          },
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
              connectorInstanceId,
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
        let storageNamespace = null;
        const { state } = await executeRsConnectorStateGet(
          { connectorId, grantId },
          {
            resolveRegisteredConnectorManifest: async (id) => {
              const manifest = await resolveRegisteredConnectorManifest(id);
              storageNamespace = await resolveOwnerConnectorNamespace(req, id);
              return manifest;
            },
            resolveGrantScope: (id, gid) => resolveGrantScopedStateGrant(id, gid),
            onGrantResolved: async (grantScope) => {
              if (grantScope?.traceId) {
                stateContext.traceId = grantScope.traceId;
                stateContext.scenarioId = grantScope.scenarioId;
              }
              setReferenceTraceId(res, stateContext.traceId);
              await emitStateRequested(req, stateContext);
            },
            getSyncState: async (id, args) => {
              const namespace = storageNamespace ?? await resolveOwnerConnectorNamespace(req, id);
              return getSyncState(storageTargetForConnectorNamespace(namespace), args);
            },
          },
        );
        await emitStateEvent(req, stateContext, 'state.served', 'succeeded', {
          visible_streams: Object.keys(state?.state || {}),
          updated_at: state?.updated_at || null,
        });
        res.json(toPublicConnectorStateProjection(state));
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
        let storageNamespace = null;
        const { state } = await executeRsConnectorStatePut(
          { connectorId, grantId, stateMap },
          {
            resolveRegisteredConnectorManifest: async (id) => {
              const manifest = await resolveRegisteredConnectorManifest(id);
              storageNamespace = await resolveOwnerConnectorNamespace(req, id);
              return manifest;
            },
            resolveGrantScope: (id, gid) => resolveGrantScopedStateGrant(id, gid),
            onGrantResolved: async (grantScope) => {
              if (grantScope?.traceId) {
                stateContext.traceId = grantScope.traceId;
                stateContext.scenarioId = grantScope.scenarioId;
              }
              setReferenceTraceId(res, stateContext.traceId);
              await emitStateRequested(req, stateContext);
            },
            putSyncState: async (id, map, args) => {
              const namespace = storageNamespace ?? await resolveOwnerConnectorNamespace(req, id);
              return putSyncState(storageTargetForConnectorNamespace(namespace), map, args);
            },
          },
        );
        await emitStateEvent(req, stateContext, 'state.updated', 'succeeded', {
          persisted_streams: Object.keys(state?.state || {}),
          updated_at: state?.updated_at || null,
        });
        res.json(toPublicConnectorStateProjection(state));
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

  // Boot-epoch reconciliation — STAGE 5.
  // Emit `controller.booted` as the FIRST spine event of this process
  // incarnation, then stash {boot_epoch, seq, controller_id} in the
  // spine-module singleton so subsequent `run.started` emissions can
  // stamp themselves. The spine-layer enforcement
  // (`assertRunStartedIsStamped` in lib/spine.ts) rejects unstamped
  // `run.started` events, so this MUST happen before:
  //   (a) HTTP routes mount,
  //   (b) any scheduler kicks off a run,
  //   (c) any other emit path that could trigger run.started.
  // See docs/run-reconciliation-design-brief.md §3.4.
  const bootEpoch = await emitControllerBootedAndStashEpoch();
  logger.info(
    { boot_epoch: bootEpoch.boot_epoch, seq: bootEpoch.seq, controller_id: bootEpoch.controller_id },
    'controller booted',
  );

  // Boot-epoch reconciliation — STAGE 6.
  // Walk the spine for orphaned run.started events from prior incarnations
  // and emit run.abandoned for each. Runs synchronously before HTTP routes
  // mount, so the dashboard never sees a half-reconciled state. Throws on
  // any non-idempotency error; we propagate up so startServer rejects and
  // traffic does not begin. See docs/run-reconciliation-design-brief.md §3.4.
  const reconciled = await reconcileOrphanedRunsAtBoot(bootEpoch);
  if (reconciled.selected > 0) {
    logger.info(
      {
        selected: reconciled.selected,
        abandoned: reconciled.abandoned,
        controller_id: bootEpoch.controller_id,
      },
      'boot-time orphan reconciliation: emitted run.abandoned events for prior-incarnation orphans',
    );
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
    const defaultEnabled = shouldAutoReconcilePolyfillManifests({
      dbPath: resolvedDbPath,
      storageBackendKind: storageBackend.backend,
    });
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
    // Populated below after asServer.listen resolves the actual port,
    // so the controller's lazy currentReferenceBaseUrl() lookup picks up
    // the realized origin even when the operator did not configure
    // PDPP_REFERENCE_ORIGIN.
    referenceBaseUrl: configuredAsPublicUrl || null,
  };
  const ownerAuthSubjectId =
    resolveOwnerAuthPlaceholderConfig(opts).subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID;
  const webPushConfig = opts.webPushConfig || resolveWebPushConfig();
  const webPushStore = opts.webPushSubscriptionStore || createWebPushSubscriptionStore();
  // Reference-internal run-target registry, lifted out of buildAsApp so the
  // controller can hand the same instance the per-run nonce hooks it needs
  // for Mode-A (in-process runtime) streaming registration. The buildAsApp
  // call below receives the same instance; routes are attached there as
  // before. See reference-implementation/server/streaming/run-target-registry.js.
  const browserSurfaceControllerOptions = await resolveNekoBrowserSurfaceControllerOptions();
  const runTargetRegistry = createRunTargetRegistry({
    logger: opts.streamingLogger,
    isNekoDescriptorApproved: (descriptor, context) =>
      isManagedNekoSurfaceApproved(descriptor, {
        runId: context?.runId,
        interactionId: context?.interactionId,
        browserSurfaceLeaseManager: browserSurfaceControllerOptions.browserSurfaceLeaseManager,
      }),
  });
  const controller = createController({
    asPublicUrl: configuredAsPublicUrl,
    ownerSubjectId: ownerAuthSubjectId,
    connectorPathResolver: opts.connectorPathResolver,
    ...browserSurfaceControllerOptions,
    runtimeContext,
    streamingTargetNonceHooks: {
      registerNonce: (args) => runTargetRegistry.registerNonce(args),
      clearNonce: (args) => runTargetRegistry.clearNonce(args),
    },
  });
  await controller.reconcileBrowserSurfaceLeasesAfterBoot();
  let schedulerManager = null;

  // Client event subscriptions: install the post-commit hook from
  // records.js and start the delivery worker. The hook synchronously
  // enqueues envelopes after a record_changes row has committed; the
  // worker handles signing, HTTP delivery, and retry.
  setClientEventEnqueueHook(async (change) => {
    try {
      const subs = await listActiveSubscriptions();
      if (subs.length === 0) return;
      const store = getDefaultClientEventSubscriptionStore();
      const events = deriveClientEventsFromRecordChange(
        {
          connectorId: change.connectorId,
          connectorInstanceId: change.connectorInstanceId,
          connectionId: change.connectionId ?? null,
          stream: change.stream,
          version: Number(change.version) || 0,
          emittedAt: change.emittedAt,
        },
        subs
          .filter((row) => row.status === 'active')
          .map((row) => ({
            subscriptionId: row.subscription_id,
            grantId: row.grant_id,
            clientId: row.client_id,
            scope: JSON.parse(row.scope_json),
            status: 'active',
          })),
      );
      const now = new Date().toISOString();
      for (const ev of events) {
        const eventId = `evt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        await store.enqueueEvent({
          subscriptionId: ev.subscriptionId,
          eventId,
          eventType: ev.type,
          payloadJson: buildEventPayload(eventId, ev),
          enqueuedAt: now,
          nextAttemptAt: now,
        });
      }
      if (events.length > 0) {
        getDefaultDeliveryWorker().tick().catch(() => { /* surfaced via attempt log */ });
      }
    } catch (hookErr) {
      logger.warn?.({ err: String(hookErr?.message ?? hookErr) }, 'client-event-subscriptions: enqueue hook failed');
    }
  });
  if (opts.startClientEventDeliveryWorker !== false) {
    getDefaultDeliveryWorker().start();
  }

  const asApp = buildAsApp({
    nativeManifest: nativeConfig?.nativeManifest || null,
    controller,
    providerName,
    acceptedCollectorProtocolVersions: opts.acceptedCollectorProtocolVersions,
    dbPath: opts.dbPath || DB_PATH,
    enableDynamicClientRegistration: resolveDynamicClientRegistrationEnabled(opts),
    dynamicClientRegistrationInitialAccessTokens: resolveDynamicClientRegistrationInitialAccessTokens(opts),
    preRegisteredPublicClients: resolvePreRegisteredPublicClients(opts),
    asPublicUrl: configuredAsPublicUrl,
    asIssuer: configuredAsIssuer,
    ignoreAmbientPublicUrls,
    trustedMetadataHosts,
    ownerAuthPassword: opts.ownerAuthPassword,
    ownerAuthSubjectId: opts.ownerAuthSubjectId,
    ownerAuthForceSecureCookies: opts.ownerAuthForceSecureCookies,
    ownerAuthSameSite: opts.ownerAuthSameSite,
    webPushConfig,
    webPushSubscriptionStore: webPushStore,
    agentConnectTtlMs: opts.agentConnectTtlMs,
    publicDynamicClientRegistrationRateLimit: opts.publicDynamicClientRegistrationRateLimit,
    referenceRevision: opts.referenceRevision,
    streamingCompanionFactory: opts.streamingCompanionFactory,
    streamingSessionStore: opts.streamingSessionStore,
    makeStreamingBrowserSessionId: opts.makeStreamingBrowserSessionId,
    nekoProxyAllowedHosts: opts.nekoProxyAllowedHosts,
    nekoProxyAutoLogin: opts.nekoProxyAutoLogin,
    isNekoProxyTargetApproved: opts.isNekoProxyTargetApproved,
    browserSurfaceLeaseManager: browserSurfaceControllerOptions.browserSurfaceLeaseManager,
    runTargetRegistry,
    onScheduleMutation: () => schedulerManager?.refresh(),
    logger,
  });

  // opts.bindHost — restrict listening interface (e.g. '127.0.0.1'). Default
  // is undefined which lets Node bind to all interfaces. Passing '127.0.0.1'
  // keeps the server off the LAN/public internet.
  const bindHost = opts.bindHost;

  const asServer = await asApp.listen(requestedAsPort, bindHost);
  if (typeof asApp.__pdppStreamingUpgradeHandler === 'function') {
    asServer.on('upgrade', (req, socket, head) => {
      const handled = asApp.__pdppStreamingUpgradeHandler(req, socket, head);
      if (!handled && !socket.destroyed) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
      }
    });
  }
  const asPort = asServer.address().port;
  const asPublicUrl = configuredAsPublicUrl || configuredAsIssuer || `http://localhost:${asPort}`;
  // Update the controller's lazy reference-base-URL view now that the AS
  // listener has actually allocated a port. Spawned connector children
  // PUT their streaming-target registration here.
  //
  // CRITICAL: this MUST be the AS-internal loopback URL, NOT the public
  // browser-facing URL. In composed mode the public URL points at the
  // Next.js webapp (which proxies user-facing routes only); the
  // `/admin/runs/:runId/interactions/:interactionId/streaming-target`
  // endpoint lives on the Fastify AS server and is never exposed through
  // the webapp. Pointing the child at the public URL surfaces as a silent
  // 404 from the webapp and the streaming companion later fails with
  // `companion_start_failed` / `streaming_target_unregistered`.
  //
  // Both child and parent run on the same host (Mode A: in-process
  // controller spawns the connector subprocess), so loopback is always
  // reachable and is the right hop.
  runtimeContext.referenceBaseUrl = `http://127.0.0.1:${asPort}`;
  logger.info({ port: asPort, url: `http://localhost:${asPort}` }, 'authorization server listening');

  const rsApp = buildRsApp({
    asPort,
    controller,
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
  await controller.promoteBrowserSurfaceLeasesAfterBoot();
  logger.info({ port: rsPort, url: `http://localhost:${rsPort}` }, 'resource server listening');

  // Auto-enroll proven, env-wired connectors before the scheduler manager
  // hydrates. Idempotent: never overrides an existing schedule row, never
  // inspects secret env values, only checks presence and non-emptiness.
  // See openspec/changes/auto-enroll-eligible-connector-schedules/.
  if (!nativeConfig?.nativeManifest) {
    const autoEnrollOptOut = process.env.PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT === '1';
    const autoEnrollEnabled =
      opts.autoEnrollEligibleSchedules !== undefined
        ? !!opts.autoEnrollEligibleSchedules
        : !autoEnrollOptOut;
    const enrollmentSummary = await autoEnrollEligibleSchedules({
      enabled: autoEnrollEnabled,
      controller,
      listConnectors: async () => {
        const ids = await listRegisteredConnectorIds();
        const rows = await Promise.all(
          ids.map(async (connectorId) => ({
            connector_id: connectorId,
            manifest: await getConnectorManifest(connectorId),
          })),
        );
        return rows;
      },
      log: (msg) => logger.info(msg),
    });
    if (enrollmentSummary.scanned > 0) {
      logger.info(enrollmentSummary, 'auto-enroll eligible schedules summary');
    }
  }

  schedulerManager = createReferenceSchedulerManager({
    controller,
    logger,
    runtimeContext,
    connectorPathResolver: opts.connectorPathResolver || resolveDefaultConnectorPath,
    ownerSubjectId: ownerAuthSubjectId,
    webPushConfig,
    webPushSubscriptionStore: webPushStore,
  });
  await schedulerManager.start();
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
    schedulerManager,
    // Exposed for the CLI entrypoint's graceful-shutdown path
    // (`exitOnSignal`). The controller's `drainActiveRuns` awaits all
    // in-flight `runConnector` promises within a bounded window so
    // connector children have time to release their Chromium contexts
    // before the parent exits and closes their stdio pipes. See
    // `runtime/controller.ts` and `polyfill-connectors/src/profile-lock.ts`
    // for the layered design.
    controller,
  };
}

export async function resolveNekoBrowserSurfaceControllerOptions({
  env = process.env,
  getBrowserSurfaceLeaseStore = getDefaultBrowserSurfaceLeaseStore,
  createBrowserSurfaceAllocator = (options) => new NekoSurfaceAllocatorClient(options),
} = {}) {
  const runtimeConfig = parseNekoBrowserSurfaceRuntimeConfig(env);
  const browserSurfaceLeaseStore =
    runtimeConfig.leaseConfig.managedConnectors.size > 0 ? getBrowserSurfaceLeaseStore() : null;
  if (!browserSurfaceLeaseStore) {
    return {};
  }

  await browserSurfaceLeaseStore.repairStaleSurfaceActiveLeases();
  const browserSurfaceLeaseManager = new BrowserSurfaceLeaseManager({
    config: runtimeConfig.leaseConfig,
    initialSurfaces: await browserSurfaceLeaseStore.listSurfaces(),
    initialLeases: await browserSurfaceLeaseStore.listNonTerminalLeases(),
  });
  const options = {
    browserSurfaceLeaseManager,
    browserSurfaceLeaseStore,
    // Preflight readiness gate: proves the managed n.eko / CDP surface is
    // actually live before the connector child is spawned. Prevents the
    // "ask the human for an OTP and discover the CDP socket was already
    // dead" failure mode that has burned Chase and USAA runs.
    browserSurfaceReadinessProbe: createDefaultBrowserSurfaceReadinessProbe(),
  };

  if (runtimeConfig.dynamic) {
    options.browserSurfaceAllocator = createBrowserSurfaceAllocator({
      baseUrl: runtimeConfig.dynamic.allocatorUrl,
    });
    options.browserSurfaceReadinessTimeoutMs = runtimeConfig.dynamic.readinessTimeoutMs;
  }

  return options;
}

function normalizedUrlWithoutTrailingSlash(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    return parsed.href.endsWith('/') ? parsed.href.slice(0, -1) : parsed.href;
  } catch {
    return null;
  }
}

export function isManagedNekoSurfaceApproved(target, { runId, interactionId, browserSurfaceLeaseManager } = {}) {
  if (!browserSurfaceLeaseManager || !target || typeof target !== 'object') return false;
  const surfaceId = typeof target.surface_id === 'string' ? target.surface_id : null;
  const leaseId = typeof target.lease_id === 'string' ? target.lease_id : null;
  const profileKey = typeof target.profile_key === 'string' ? target.profile_key : null;
  const baseUrl = normalizedUrlWithoutTrailingSlash(target.base_url || target.origin);
  if (!surfaceId || !leaseId || !profileKey || !baseUrl) return false;

  const lease = typeof browserSurfaceLeaseManager.getLease === 'function'
    ? browserSurfaceLeaseManager.getLease(leaseId)
    : null;
  const surface = typeof browserSurfaceLeaseManager.getSurface === 'function'
    ? browserSurfaceLeaseManager.getSurface(surfaceId)
    : null;
  if (!lease || !surface) return false;
  if (lease.status !== 'leased') return false;
  if (surface.health !== 'ready') return false;
  if (lease.surface_id !== surfaceId) return false;
  if (surface.active_lease_id !== leaseId) return false;
  if (lease.profile_key !== profileKey || surface.profile_key !== profileKey) return false;
  if (runId && lease.run_id !== runId) return false;
  if (interactionId) {
    const targetInteractionId =
      typeof target.interaction_id === 'string' ? target.interaction_id : null;
    if (targetInteractionId !== interactionId) return false;
  }
  return normalizedUrlWithoutTrailingSlash(surface.stream_base_url) === baseUrl;
}

function createReferenceSchedulerManager({
  controller,
  logger,
  runtimeContext,
  schedulerStore = getDefaultSchedulerStore(),
  connectorPathResolver = resolveDefaultConnectorPath,
  ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID,
  webPushConfig = resolveWebPushConfig(),
  webPushSubscriptionStore = createWebPushSubscriptionStore(),
} = {}) {
  let scheduler = null;
  let stopped = false;
  let refreshChain = Promise.resolve();

  async function buildConnectors() {
    const schedules = await Promise.resolve(schedulerStore.listSchedules());
    const enabledSchedules = schedules.filter((schedule) => schedule?.enabled === true);
    const connectors = [];
    for (const schedule of enabledSchedules) {
      try {
        const manifest = await getConnectorManifest(schedule.connector_id);
        if (!manifest) {
          continue;
        }
        const scheduleIneligibilityReason = getScheduleIneligibilityReason(getManifestRefreshPolicy(manifest));
        if (scheduleIneligibilityReason) {
          logger?.warn?.(
            { connector_id: schedule.connector_id, reason: scheduleIneligibilityReason },
            'skipping scheduled connector because refresh policy is not background-safe',
          );
          continue;
        }
        const connectorPath = await Promise.resolve(
          connectorPathResolver(schedule.connector_id, manifest, { priorityClass: 'scheduled_refresh' }),
        );
        if (!connectorPath) {
          logger?.warn?.(
            { connector_id: schedule.connector_id },
            'skipping scheduled connector without runnable implementation',
          );
          continue;
        }
        connectors.push({
          connectorId: schedule.connector_id,
          connectorInstanceId: schedule.connector_instance_id,
          connectorPath,
          manifest,
          intervalMs: Math.max(1, schedule.interval_seconds) * 1000,
          ownerToken: await controller.issueRuntimeOwnerToken(),
        });
      } catch (err) {
        logger?.warn?.(
          { err, connector_id: schedule?.connector_id },
          'skipping scheduled connector during scheduler refresh',
        );
      }
    }
    return connectors;
  }

  async function restart() {
    if (stopped) {
      return;
    }
    scheduler?.stop();
    scheduler = null;
    const connectors = await buildConnectors();
    if (stopped || connectors.length === 0) {
      return;
    }
    scheduler = createScheduler({
      connectors,
      rsUrl: runtimeContext.rsUrl,
      referenceBaseUrl: runtimeContext.referenceBaseUrl,
      schedulerStore,
      getState: async (connectorId, connectorInstanceId) => {
        const stored = await getSyncState(connectorId, { connectorInstanceId });
        return stored?.state || null;
      },
      setState: async (connectorId, state, connectorInstanceId) => {
        await putSyncState(connectorId, state && typeof state === 'object' && !Array.isArray(state) ? state : {}, {
          connectorInstanceId,
        });
      },
      markNeedsHuman: (connectorId, connectorInstanceId) => controller.markNeedsHuman(connectorId, { connectorInstanceId }),
      isNeedsHuman: (connectorId, connectorInstanceId) =>
        controller.isNeedsHuman(connectorId, { connectorInstanceId }) ||
        Boolean(controller.getActiveRun(connectorId, { connectorInstanceId })),
      hasUnresolvedAttention: async (connectorId, connectorInstanceId) => {
        // Durable attention projection. The in-memory `isNeedsHuman` flag
        // is process-local; this probe consults the structured
        // attention_request store so a scheduled tick after process
        // restart still recognizes unresolved owner action and does not
        // launch a doomed run. The projection is read-bounded
        // (`listOpenAttentionForConnection` clamps `limit` to 50) and
        // returns the most-recently-updated open record first.
        const projection = await getConnectorAttentionProjection(connectorId, { connectorInstanceId });
        if (projection.unreliable) {
          // Probe failure must not silently suppress launches — surface
          // the schedule as eligible so a freshness gap is preferred over
          // an invisible pause.
          return null;
        }
        const nowIso = new Date().toISOString();
        for (const record of projection.records) {
          if (!isAttentionHealthRelevant(record, nowIso)) continue;
          return { key: record.dedupe_key || record.id, reason: record.reason_code };
        }
        return null;
      },
      onInteraction: async (interaction) => {
        const connectorDisplayName =
          typeof interaction?.connector_display_name === 'string' && interaction.connector_display_name.trim()
            ? interaction.connector_display_name.trim()
            : typeof interaction?.connector_id === 'string' && interaction.connector_id.trim()
              ? interaction.connector_id.trim()
              : 'Connector';
        const runId = typeof interaction?.run_id === 'string' ? interaction.run_id : null;
        if (runId) {
          try {
            await fanoutPendingInteractionWebPush({
              config: webPushConfig,
              store: webPushSubscriptionStore,
              interaction,
              connectorDisplayName,
              ownerSubjectId,
              // Scheduled interactions are immediately marked needs-human and
              // cancelled so the scheduler does not wait unattended. Notify the
              // owner, but route to the durable run context rather than a
              // transient stream that may already be closed.
              routeTo: 'run',
              runId,
              log: logger,
              // Record the durable notification outcome on the structured
              // attention row the runtime writer just upserted. The attention
              // id is the runtime writer's default `att_<runId>_<requestId>`
              // — kept deterministic so the scheduler seam (which does not
              // own the per-run writer instance) can address it. A non-default
              // factory is only used by tests, which do not flow through this
              // production push path.
              recordOutcome: async ({ state, reason }) => {
                const requestId = typeof interaction?.request_id === 'string' ? interaction.request_id : null;
                if (!requestId) return;
                const attentionStore = getDefaultConnectorAttentionStore();
                if (typeof attentionStore.recordNotificationOutcomeById !== 'function') return;
                await attentionStore.recordNotificationOutcomeById({
                  attentionId: `att_${runId}_${requestId}`,
                  outcome: state,
                  reason: reason || null,
                  now: new Date().toISOString(),
                });
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger?.warn?.(`[scheduler] web push fire for run ${runId} failed: ${message}`);
          }
        }
        return {
          type: 'INTERACTION_RESPONSE',
          request_id: interaction.request_id,
          status: 'cancelled',
        };
      },
      onRunComplete: (record) => {
        logger?.info?.(
          {
            connector_id: record.connectorId,
            connector_instance_id: record.connectorInstanceId || record.connectorId,
            status: record.status,
            run_id: record.runId || null,
            trace_id: record.traceId || null,
          },
          'scheduled connector run completed',
        );
      },
    });
    scheduler.start();
    logger?.info?.({ schedules: connectors.length }, 'reference scheduler started');
  }

  function refresh() {
    refreshChain = refreshChain.then(restart, restart);
    return refreshChain;
  }

  function stop() {
    stopped = true;
    scheduler?.stop();
    scheduler = null;
  }

  return { refresh, start: refresh, stop };
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

  const server = { asServer: null, rsServer: null, abortStartupBackfill: null, startupBackfillDone: null, schedulerManager: null, controller: null };
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
    try { server.schedulerManager?.stop?.(); } catch {}
    // Drain in-flight connector children IN PARALLEL with the HTTP /
    // backfill drains. Children received their own SIGTERM from Docker
    // and are running their Layer A shutdown-hook to release Chromium.
    // We give them 5s — typical context.close completes in 1-2s; the
    // 3s buffer absorbs slow Chromium teardown and network latency.
    // Docker's default grace period is 10s; the parallel `allSettled`
    // below is bounded by max(2s, 2s, 5s) = 5s, well within that.
    // Runs that don't drain in time get SIGKILL'd by Docker on grace
    // expiry; the residue is cleaned up on next boot by
    // polyfill-connectors/src/profile-lock.ts (Layer C).
    const CONNECTOR_DRAIN_TIMEOUT_MS = 5000;
    const drainConnectors = server.controller?.drainActiveRuns
      ? server.controller.drainActiveRuns(CONNECTOR_DRAIN_TIMEOUT_MS).then(
          (summary) => {
            cliLogger.info(summary, 'connector run drain complete');
          },
          (err) => {
            cliLogger.warn({ err }, 'connector run drain failed');
          },
        )
      : Promise.resolve();
    await Promise.allSettled([
      closeTimeout(server.asServer),
      closeTimeout(server.rsServer),
      Promise.race([awaitBackfill, backfillDeadline]),
      drainConnectors,
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
    server.schedulerManager = result.schedulerManager;
    server.controller = result.controller;
  }).catch(err => {
    closePostgresStorage().finally(() => closeDb());
    cliLogger.fatal({ err }, 'startup failed');
    process.nextTick(() => process.exit(1));
  });
}
