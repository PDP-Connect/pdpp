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
  buildOwnerAgentControlSurface,
  buildOwnerConnectionSupportedActions,
  buildProtectedResourceMetadata,
  buildSemanticRetrievalCapability,
  isLocalOrPrivateRequestOrigin,
  isTrustedMetadataRequestOrigin,
  protectedResourceMetadataUrlForResource,
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
import { canonicalConnectorKey, isInternalConnectorId } from './connector-key.js';
import { projectStorageDisplayName } from './connection-id-request.js';
import { codeToStatus, typeFor } from './routes/ref-error-status.ts';
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
import { getDefaultDeliveryWorker } from './client-event-delivery-worker.ts';
import { setClientEventEnqueueHook } from './records.js';
import { DeviceBatchConflictError, createDeviceExporterStore, getDefaultDeviceExporterStore } from './stores/device-exporter-store.js';
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
  listLocalCoverageDiagnostics,
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
import { createPackageRsClient, createRsClient } from './package-rs-client.js';
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
import { executeAsDeviceAuthInit } from '../operations/as-device-authorization-init/index.ts';
import { executeAsDeviceTokenExchange } from '../operations/as-device-token-exchange/index.ts';
import { executeAsIntrospect } from '../operations/as-introspect/index.ts';
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
  mountRefDeviceExporterDiagnostics,
  mountRefDeviceExporterEnroll,
  mountRefDeviceExporterEnrollmentCodes,
  mountRefDeviceExporterHeartbeat,
  mountRefDeviceExporterIngestBatches,
  mountRefDeviceExporterLocalCollectorGaps,
  mountRefDeviceExporterLocalCollectorGapsRecovered,
  mountRefDeviceExporterRevoke,
  mountRefDeviceExporterSourceInstanceStateGet,
  mountRefDeviceExporterSourceInstanceStatePut,
  mountRefDeviceExporterSourceInstances,
  mountRefDeviceExportersList,
} from './routes/ref-device-exporters.ts';
import {
  mountRefDevPlaygroundSession,
  mountRefRunInteraction,
} from './routes/run-interaction.ts';
import {
  mountRefApprovals,
  mountRefClients,
  mountRefDeployment,
  mountRefRecordsTimeline,
  mountRefSchedules,
  mountRefSearch,
} from './routes/ref-admin.ts';
import {
  mountRefEventSubscriptionsDisable,
  mountRefEventSubscriptionsGet,
  mountRefEventSubscriptionsList,
  mountRefGrantPackagesGet,
  mountRefGrantPackagesList,
  mountRefGrantPackagesRevoke,
} from './routes/ref-grants.ts';
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
import { mountRsBlobRead, mountRsReadQueries } from './routes/rs-read.ts';
import { mountOwnerConnectionRename, mountOwnerConnectionsList } from './routes/owner-connections.ts';
import { mountOwnerConnectionIntent } from './routes/owner-connection-intent.ts';
import { mountOwnerConnectorTemplates } from './routes/owner-connector-templates.ts';
import { mountOwnerControl } from './routes/owner-control.ts';
import {
  mountRsBlobsUpload,
  mountRsEventSubscriptions,
  mountRsMutation,
} from './routes/rs-mutation.ts';
import {
  mountAsDeviceAuthorization,
  mountAsIntrospect,
  mountAsToken,
} from './routes/as-oauth.ts';
import {
  mountAsPolyfillConnectorDetail,
  mountAsPolyfillConnectorRegister,
} from './routes/as-polyfill-connectors.ts';
import {
  createAgentConnectAttemptStore,
  mountAsAgentConnect,
  mountAsAgentConnectToken,
} from './routes/as-agent-connect.ts';
import {
  buildApplyGrantRevokeSideEffects,
  mountAsGrantRevoke,
} from './routes/as-grant-revoke.ts';
import { mountAsAuthorize } from './routes/as-authorize.ts';
import { mountAsConsent } from './routes/as-consent.ts';
import { mountAsDcr } from './routes/as-dcr.ts';
import { mountAsPar } from './routes/as-par.ts';
import { mountAsDeviceUi } from './routes/as-device-ui.ts';
import { mountRsHostedMcp } from './routes/rs-hosted-mcp.ts';
import {
  renderPendingConsentNotFoundHtml,
  renderPendingGrantConsentHtml,
} from './routes/as-consent-ui-helpers.ts';
import {
  sanitizeDeviceExporterDiagnostic,
  sanitizeLocalCollectorGapDetails,
} from './routes/ref-device-exporter-sanitize.ts';

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

// Keyed by canonical connector_key. The local-collector manifest files
// retain their historical snake_case filenames (`claude_code.json`), but the
// catalog row, the connector_instances row, and the record storage target all
// use the canonical key (`claude-code`, `codex`) so a legacy-alias enroll
// cannot fork the connector type away from its canonical identity.
const REFERENCE_LOCAL_CONNECTOR_CATALOG_MANIFESTS = new Map([
  ['claude-code', { entryName: 'claude_code.json', displayName: 'Claude Code' }],
  ['codex', { entryName: 'codex.json', displayName: 'OpenAI Codex CLI' }],
]);

function readReferenceLocalConnectorCatalogManifest(connectorId) {
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const local = REFERENCE_LOCAL_CONNECTOR_CATALOG_MANIFESTS.get(connectorKey);
  if (!local) return null;
  try {
    const raw = readFileSync(
      new URL(`../../packages/polyfill-connectors/manifests/${local.entryName}`, import.meta.url),
      'utf8',
    );
    const manifest = JSON.parse(raw);
    return {
      ...manifest,
      connector_id: connectorKey,
      display_name: manifest.display_name || local.displayName,
    };
  } catch {
    return {
      connector_id: connectorKey,
      display_name: local.displayName,
      streams: [],
    };
  }
}

function listReferenceLocalConnectorCatalogManifests() {
  return Array.from(REFERENCE_LOCAL_CONNECTOR_CATALOG_MANIFESTS.keys())
    .map((connectorId) => readReferenceLocalConnectorCatalogManifest(connectorId))
    .filter(Boolean);
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
    return pdppError(
      res,
      403,
      'permission_error',
      'MCP requires a grant-scoped client or MCP package token. Owner-agent bearers are REST/control-plane credentials; use owner-agent REST onboarding for local owner automation.',
    );
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
  // Connectors are stored under canonical short keys (registerConnector calls
  // normalizeConnectorManifestForStorage which maps URL-form connector ids like
  // 'https://registry.pdpp.org/connectors/spotify' to 'spotify'). Callers may
  // supply either form, so normalise here before the instance-store lookup to
  // prevent FK mismatches on ensureDefaultAccountConnection.
  const canonicalId = (connectorId && canonicalConnectorKey(connectorId)) ?? connectorId;
  return resolveOwnerConnectorInstanceNamespace({
    ownerSubjectId,
    connectorId: canonicalId,
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
  // Canonicalize the owner-supplied connector_id once, at the read-scope
  // construction boundary, so the owner read storage binding carries the same
  // canonical key the ingest path writes under (resolveOwnerConnectorNamespace
  // canonicalizes at line ~1332). Without this, a URL-shaped connector_id like
  // 'https://registry.pdpp.org/connectors/gmail' reaches connection admission
  // verbatim, listActiveByConnector finds zero rows (they are keyed 'gmail'),
  // and the read fails connection_not_found. The owner-facing source descriptor
  // still reflects the canonical key. See canonicalize-connector-keys Decision 1.
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;

  return {
    public_scope: 'polyfill',
    owner_subject_id: getOwnerTokenSubjectId(req),
    source: { kind: 'connector', id: connectorKey },
    storage_binding: {
      connector_id: connectorKey,
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
  if (!connectorId) return null;
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  return buildSourceDescriptor({ kind: 'connector', id: connectorKey });
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
    // Compare connector identity canonically: the request path may carry a
    // URL-shaped connector id and a stale grant may carry a URL-shaped storage
    // binding, while the live instance/records are keyed by the canonical key.
    // Canonicalize both sides so admission matches the same key ingest/read use.
    // See canonicalize-connector-keys Decision 1/8.
    const canonicalPathConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const canonicalBoundConnectorId =
      canonicalConnectorKey(resolved.storageBinding.connector_id) ?? resolved.storageBinding.connector_id;
    if (canonicalBoundConnectorId !== canonicalPathConnectorId) {
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
    group_by_time: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.group_by_time) && aggregations.group_by_time.includes(field),
      granted,
    }),
    count_distinct: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.count_distinct) && aggregations.count_distinct.includes(field),
      granted,
    }),
  };
}

function buildFieldCapabilities(manifestStream, streamGrant = null) {
  const properties = manifestStream?.schema?.properties || {};
  const fieldDeclarations = new Map();
  for (const declarations of [manifestStream?.fields, manifestStream?.schema?.fields]) {
    if (!Array.isArray(declarations)) {
      continue;
    }
    for (const declaration of declarations) {
      if (
        declaration
        && typeof declaration === 'object'
        && typeof declaration.name === 'string'
        && declaration.name.trim().length > 0
        && typeof declaration.type === 'string'
        && declaration.type.trim().length > 0
      ) {
        fieldDeclarations.set(declaration.name, declaration.type.trim());
      }
    }
  }
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
      // Optional declared presentation type, sourced either from the JSON
      // Schema extension (`schema.properties[field].x_pdpp_type`) or from a
      // sandbox-shaped field declaration (`fields[]` or `schema.fields[]`,
      // with `{ name, type, semantic_class }`). Surfaced as an additive `type`
      // on the field_capabilities entry only; it does not influence any filter,
      // search, aggregation, grant, or retrieval decision below.
      const declaredType =
        schema
        && typeof schema === 'object'
        && typeof schema.x_pdpp_type === 'string'
        && schema.x_pdpp_type.trim().length > 0
          ? schema.x_pdpp_type.trim()
          : fieldDeclarations.get(field) || null;
      return [field, {
        ...(declaredType ? { type: declaredType } : {}),
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

  // renderPendingConsentNotFoundHtml, renderPendingGrantConsentHtml, and
  // renderHostedMcpSourceSelection extracted to
  // `server/routes/as-consent-ui-helpers.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Call sites below pass the
  // required context arguments explicitly.

  async function getPendingGrantFromRequestUri(requestUri) {
    const deviceCode = consentStore.parseRequestUri(requestUri);
    if (!deviceCode) return { deviceCode: null, pending: null };
    const pending = await consentStore.getPendingConsentByDeviceCode(deviceCode);
    return { deviceCode, pending };
  }

  // agent-connect attempt state — shared between the two agent-connect HTTP
  // routes and the consent approve/deny handlers. Extracted to
  // `server/routes/as-agent-connect.ts` per OpenSpec change
  // `split-reference-server-by-route-family`.
  const agentConnectAttemptStore = createAgentConnectAttemptStore();

  // parseAuthorizeAuthorizationDetails, requireAuthorizeString,
  // requireRegisteredRedirectUri, validateAuthorizePkce,
  // buildHostedMcpAuthorizationDetailsForConnector,
  // buildHostedMcpAuthorizationDetailForConnector,
  // HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE,
  // HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES, and
  // renderHostedMcpSourceSelection extracted to
  // `server/routes/as-consent-ui-helpers.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Imports at top of file.

  // POST /agent-connect and POST /agent-connect/:attemptId/token extracted to
  // `server/routes/as-agent-connect.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Behaviour-preserving: same auth
  // posture (none), same status codes, same error envelopes.
  mountAsAgentConnect(app, {
    agentConnectAttemptStore,
    agentConnectTtlMs: opts.agentConnectTtlMs || AGENT_CONNECT_TTL_MS,
    handleError,
    pdppError,
    async getPendingGrantFromRequestUri(requestUri) {
      const { pending } = await getPendingGrantFromRequestUri(requestUri);
      if (!pending) return null;
      const pendingClientId = pending.request?.client?.client_id || null;
      return { pendingClientId };
    },
    async initiateNativeGrant({ baseUrl, clientId, clientName }) {
      const nativeManifest = resolveNativeManifest(opts);
      if (!nativeManifest?.provider_id || !nativeManifest?.storage_binding?.connector_id) {
        return null;
      }
      return consentStore.initiateGrant(
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
    },
    resolveBaseUrl: (req) => {
      const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
      return resolvePublicUrl(req, explicitBaseUrl);
    },
    pdppCliDefaultClientId: PDPP_CLI_DEFAULT_CLIENT_ID,
    generateAttemptId: () => `agc_${randomBytes(16).toString('hex')}`,
    generatePollingCode: () => `agc_poll_${randomBytes(32).toString('hex')}`,
    buildTokenUrl: (baseUrl, id) => `${baseUrl}/agent-connect/${encodeURIComponent(id)}/token`,
    buildApprovalUrl: (baseUrl, requestUri) => {
      const u = new URL(`${baseUrl}/consent`);
      u.searchParams.set('request_uri', requestUri);
      return u.toString();
    },
    now: () => Date.now(),
  });

  mountAsAgentConnectToken(app, {
    agentConnectAttemptStore,
    handleError,
    pdppError,
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

  // DCR register/delete routes — extracted to routes/as-dcr.ts per
  // openspec/changes/split-reference-server-by-route-family.
  mountAsDcr(app, {
    dcrEnabled: dynamicClientRegistrationEnabled,
    resolveInitialAccessTokensForRequest: (req) =>
      resolveDynamicClientRegistrationInitialAccessTokensForRequest(
        req,
        dynamicClientRegistrationInitialAccessTokens,
      ),
    publicDcrRateLimiter,
    readOwnerSession: (req) => ownerAuth.readOwnerSession(req),
    requireOwnerSession: ownerAuth.requireOwnerSession,
    ownerSubjectId: ownerAuth.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID,
    emitSpineEvent,
    setReferenceTraceId,
    createTraceContext,
    oauthError,
    pdppError,
    registerDynamicClient,
    deleteRegisteredClient,
  });

  // Injected context objects for the consent/authorize UI helpers extracted to
  // `server/routes/as-consent-ui-helpers.ts`. These are built once per
  // buildAsApp call and shared across the consent + authorize route handlers.
  const consentUi = {
    escapeHtml: hostedEscape,
    renderActionRow,
    renderHostedDocument,
    renderKeyValueList,
    renderPageIntro,
    renderResultState,
    renderSurface,
  };
  const consentPickerCaps = {
    listRegisteredConnectorIds,
    getConnectorManifest,
    listActiveBindingsForGrant,
    projectBindingForWire,
    isInternalConnectorId,
    canonicalConnectorKey,
    encodeHostedMcpSelection,
    encodeHostedMcpStreamSelection,
    hostedMcpSourceKey,
  };

  // GET /oauth/authorize and POST /oauth/authorize/mcp-package extracted to
  // `server/routes/as-authorize.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§6). Behaviour-preserving:
  // same owner-session + CSRF enforcement, same PKCE validation, same
  // consentStore.initiateGrant delegation, same createHostedMcpGrantPackage
  // delegation, same auth-code staging and redirect.
  mountAsAuthorize(app, {
    asPublicUrl: opts.asPublicUrl || null,
    consentPickerCaps,
    selectionParsers: {
      parseHostedMcpSelections,
      parseHostedMcpStreamSelections,
    },
    consentStore,
    consentUi,
    createHostedMcpGrantPackage,
    ensureCsrfToken: (req, res) => ownerAuth.ensureCsrfToken(req, res),
    getRegisteredClient,
    ignoreAmbientPublicUrls: !!opts.ignoreAmbientPublicUrls,
    issueOAuthAuthorizationCodeForPackageDeviceCode,
    nativeManifest: resolveNativeManifest(opts),
    oauthError,
    providerName,
    requireCsrf: ownerAuth.requireCsrf,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolvePublicUrl,
    stageOAuthAuthorizationCodeRequest,
  });
  // POST /oauth/device_authorization and POST /oauth/token extracted to
  // `server/routes/as-oauth.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§6). Behaviour-preserving:
  // same contract metadata, same auth posture (none — public endpoints),
  // same trace-id header wiring, same response envelopes, same status codes.
  const asDeviceAuthContext = {
    resolveBaseUrl: (req) => {
      const explicitBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
      return resolvePublicUrl(req, explicitBaseUrl);
    },
    initiateDeviceAuth: (clientId, opts2) => ownerDeviceAuthStore.initiate(clientId, opts2),
    setReferenceTraceId,
    oauthError,
  };
  mountAsDeviceAuthorization(app, asDeviceAuthContext);

  const asTokenContext = {
    exchangeOAuthAuthorizationCode,
    exchangeOAuthRefreshToken,
    exchangeDeviceCode: (args) => ownerDeviceAuthStore.exchangeDeviceCode(args),
    setReferenceTraceId,
    oauthError,
  };
  mountAsToken(app, asTokenContext);

  // GET /device, POST /device/approve, POST /device/deny extracted to
  // `server/routes/as-device-ui.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§6). Behaviour-preserving:
  // same owner-session + CSRF enforcement, same subject-id resolution,
  // same hosted-UI HTML rendering, same error mapping.
  mountAsDeviceUi(app, {
    providerName,
    ownerAuthEnabled: ownerAuth.enabled,
    ownerSubjectId: ownerAuth.subjectId,
    ownerAuthDefaultSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    requireCsrf: ownerAuth.requireCsrf,
    ensureCsrfToken: (req, res) => ownerAuth.ensureCsrfToken(req, res),
    renderCsrfField: (token) => ownerAuth.renderCsrfField(token),
    getByUserCode: (userCode) => ownerDeviceAuthStore.getByUserCode(userCode),
    ui: {
      escapeHtml: hostedEscape,
      renderHostedDocument,
      renderPageIntro,
      renderEmptyState,
      renderKeyValueList,
      renderSurface,
      renderResultState,
    },
    deviceDecision: {
      getByApprovalId: (approvalId) => ownerDeviceAuthStore.getByApprovalId(approvalId),
      approve: (userCode, subjectId) => ownerDeviceAuthStore.approve(userCode, subjectId),
      deny: (userCode, subjectId) => ownerDeviceAuthStore.deny(userCode, subjectId),
    },
    oauthError,
    setReferenceTraceId,
  });

  // POST /introspect extracted to `server/routes/as-oauth.ts` per OpenSpec
  // change `split-reference-server-by-route-family` (§6). Behaviour-preserving:
  // same contract metadata, same auth posture (none — public endpoint),
  // same response envelope, same status codes.
  mountAsIntrospect(app, { introspect, pdppError });

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
    canonicalConnectorKey,
    handleError,
  };
  mountRefTraces(app, refSpineCorrelationsContext);
  mountRefGrants(app, refSpineCorrelationsContext);
  mountRefRuns(app, refSpineCorrelationsContext);

  // ────────────────────────────────────────────────────────────────────────
  // /_ref/grant-packages — operator visibility for hosted-MCP grant packages
  // ────────────────────────────────────────────────────────────────────────
  // Read-mostly operator surface that exposes the grant-package primitive
  // `/_ref/grant-packages` and `/_ref/event-subscriptions` routes extracted
  // to `server/routes/ref-grants.ts` per `split-reference-server-by-route-family`.
  // Behaviour-preserving extraction: same mount points, same owner-session
  // posture, same envelopes. Grant-packages spec:
  //   openspec/changes/add-grant-package-operator-visibility/
  // Event-subscriptions spec:
  //   openspec/changes/add-client-event-subscription-management/
  const refGrantsContext = {
    handleError,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    listGrantPackagesForOwner,
    getGrantPackageForOwner,
    revokeGrantPackage,
    listAllSubscriptions,
    getSubscriptionSummary,
    listAttemptsForSubscription,
    getClientEventSubscriptionStore: getDefaultClientEventSubscriptionStore,
    nowIso: () => new Date().toISOString(),
  };
  mountRefGrantPackagesList(app, refGrantsContext);
  mountRefGrantPackagesGet(app, refGrantsContext);
  mountRefGrantPackagesRevoke(app, refGrantsContext);
  mountRefEventSubscriptionsList(app, refGrantsContext);
  mountRefEventSubscriptionsGet(app, refGrantsContext);
  mountRefEventSubscriptionsDisable(app, refGrantsContext);

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

  // `/_ref/search`, `/_ref/approvals`, `/_ref/records/timeline`,
  // `/_ref/schedules`, `/_ref/deployment`, and `/_ref/clients` routes
  // extracted to `server/routes/ref-admin.ts` per
  // `split-reference-server-by-route-family` §2.5. The host wires
  // capability-shaped substrate dependencies; the adapter owns owner-auth,
  // contract metadata, response writing, and query-string parsing.
  const refAdminContext = {
    requireOwnerSession: ownerAuth.requireOwnerSession,
    handleError,
    pdppError,
    listPendingApprovals: () => listPendingApprovals(),
    collectRecordsTimelineEntries: (input) => collectRecordsTimelineEntries(input),
    listSchedules: async () => (controller ? await controller.listSchedules() : []),
    collectDeploymentReport: (req) => collectDeploymentDiagnostics(
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
                connector_versions: {},
              };
            }
          } catch {
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
    listOwnerIssuedClients: (subjectId) => listOwnerIssuedClients(subjectId),
    searchSpine: (query) => searchSpine(query),
    getOwnerSubjectId,
    resolveSingleConnectorIdQueryValue,
  };
  mountRefSearch(app, refAdminContext);
  mountRefApprovals(app, refAdminContext);

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
    canonicalConnectorKey,
  };

  mountRefConnectorsList(app, refConnectorsContext);
  mountRefConnectorDetail(app, refConnectorsContext);

  mountRefRecordsTimeline(app, refAdminContext);
  mountRefSchedules(app, refAdminContext);

  mountRefConnectorScheduleGet(app, refConnectorsContext);
  mountRefConnectionsList(app, refConnectorsContext);
  mountRefConnectorInstancesList(app, refConnectorsContext);
  mountRefConnectionDetail(app, refConnectorsContext);
  mountRefConnectorInstanceDetail(app, refConnectorsContext);
  mountRefConnectionSetDisplayName(app, refConnectorsContext);

  mountRefDeployment(app, refAdminContext);

  // `/_ref/device-exporters` route family extracted to
  // `server/routes/ref-device-exporters.ts` per
  // `split-reference-server-by-route-family` §2.6. The host wires
  // device-exporter store, connector instance store, gap store, sync
  // state, record ingest, catalog entry, and credential/protocol
  // enforcement; the adapter owns all route logic.
  const refDeviceExportersContext = {
    requireOwnerSession: ownerAuth.requireOwnerSession,
    requireDeviceExporterCredential,
    pdppError,
    handleError,
    getOwnerSubjectId,
    enforceCollectorProtocolVersion,
    acceptedCollectorProtocolVersions,
    readCollectorProtocolHeader,
    generateSpineId,
    generateReferenceSecret,
    hashDeviceSecret,
    sanitizeDeviceExporterDiagnostic,
    sanitizeLocalCollectorGapDetails,
    canonicalConnectorKey,
    makeConnectorInstanceSourceBindingKey,
    deviceExporterStore,
    createRequestConnectorInstanceStore,
    getDefaultConnectorDetailGapStore,
    ensureReferenceConnectorCatalogEntry,
    ingestRecord,
    getSyncState,
    putSyncState,
    listLocalCoverageDiagnostics,
    DeviceBatchConflictError,
  };

  mountRefDeviceExporterEnrollmentCodes(app, refDeviceExportersContext);
  mountRefDeviceExporterEnroll(app, refDeviceExportersContext);
  mountRefDeviceExportersList(app, refDeviceExportersContext);
  mountRefDeviceExporterSourceInstances(app, refDeviceExportersContext);
  mountRefDeviceExporterDiagnostics(app, refDeviceExportersContext);
  mountRefDeviceExporterRevoke(app, refDeviceExportersContext);
  mountRefDeviceExporterHeartbeat(app, refDeviceExportersContext);
  mountRefDeviceExporterIngestBatches(app, refDeviceExportersContext);
  mountRefDeviceExporterSourceInstanceStateGet(app, refDeviceExportersContext);
  mountRefDeviceExporterSourceInstanceStatePut(app, refDeviceExportersContext);
  mountRefDeviceExporterLocalCollectorGaps(app, refDeviceExportersContext);
  mountRefDeviceExporterLocalCollectorGapsRecovered(app, refDeviceExportersContext);

  mountRefClients(app, refAdminContext);

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
    // `server/routes/as-polyfill-connectors.ts` per OpenSpec change
    // `split-reference-server-by-route-family`. Behaviour-preserving extraction:
    // same routes, same operation delegation, same error mapping, same response
    // envelopes. Only mounted in polyfill mode, matching the original guard.
    const asPolyfillConnectorsContext = { registerConnector, getConnectorManifest, handleError, pdppError };
    mountAsPolyfillConnectorRegister(app, asPolyfillConnectorsContext);
    mountAsPolyfillConnectorDetail(app, asPolyfillConnectorsContext);
  }

  // POST /oauth/par extracted to `server/routes/as-par.ts` per OpenSpec
  // change `split-reference-server-by-route-family` (§6). Behaviour-preserving:
  // same contract metadata, same auth posture (none — public endpoint),
  // same base-URL resolution, same response envelope, same status codes.
  const explicitAsBaseUrl = opts.asPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.AS_PUBLIC_URL : null);
  mountAsPar(app, {
    resolveBaseUrl: (req) => resolvePublicUrl(req, explicitAsBaseUrl),
    nativeManifest: resolveNativeManifest(opts),
    initiateGrant: (body, opts2) => consentStore.initiateGrant(body, opts2),
    handleError,
    setReferenceTraceId,
  });


  // Consent route family (GET /consent, POST /consent/approve, POST /consent/deny,
  // POST /consent/exchange) extracted to `server/routes/as-consent.ts` per
  // OpenSpec change `split-reference-server-by-route-family`. Behaviour-
  // preserving: same auth posture (owner-session + CSRF), same operation
  // delegation, same response envelopes and error mapping.
  mountAsConsent(app, {
    ownerAuth,
    consentStore,
    agentConnectAttemptStore,
    buildPendingConsentRequestUri,
    consentUi,
    consumeConsentExchangeCode,
    createConsentExchangeCode,
    handleError,
    issueOAuthAuthorizationCodeForDeviceCode,
    pdppError,
    providerName,
    setReferenceTraceId,
  });


  // Grant-revocation route extracted to `server/routes/as-grant-revoke.ts`
  // per OpenSpec change `split-reference-server-by-route-family` (§6 continuation).
  // Behaviour-preserving: same `requireRevokeAuth` posture, same operation delegation,
  // same side-effect hook (client-event-subscription rows + delivery tick),
  // same response envelope, same error mapping.
  const asGrantRevokeContext = {
    ensureRequestId,
    revokeGrant,
    introspect,
    applyGrantRevokeSideEffects: buildApplyGrantRevokeSideEffects({
      getStore: getDefaultClientEventSubscriptionStore,
      getDeliveryWorker: getDefaultDeliveryWorker,
    }),
    pdppError,
    handleError,
    setReferenceTraceId,
    logger: opts.logger,
  };
  mountAsGrantRevoke(app, asGrantRevokeContext);

  // Client event subscriptions are mounted on the RESOURCE SERVER under
  // `/v1/event-subscriptions` (see buildRsApp). They are the same kind of
  // RI-extension surface as `/v1/streams/:s/records`: ordinary clients use
  // grant-scoped bearers, while trusted owner agents use owner REST
  // authority. The AS host no longer mounts a `_ref` alias for them.

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

// Build the advisory `pdpp_owner_agent_onboarding` block for a trusted local
// owner agent (e.g. Daisy). This is non-normative reference metadata — NOT a
// PDPP Core requirement — that names the owner-level REST automation profile
// and the surfaces needed to onboard and keep an incremental local view.
//
// Safe-emission gate: returns null unless an owner-approval `origin` is
// resolved. The host passes the same composed-mode browser origin that gates
// `pdpp_agent_discovery` (null in direct/ephemeral mode), so a direct
// ephemeral test server never advertises owner-agent onboarding even when
// ambient public-origin env vars leak in. Every URL is derived from the
// caller-visible trusted `resource` (RS) and `issuer` (AS) the host already
// resolved through the forwarded-origin/trusted-host machinery, so the block
// is scoped to a trusted host or omitted — never an untrusted forwarded host.
//
// Spec: openspec/changes/add-trusted-owner-agent-onboarding/specs/reference-implementation-architecture/spec.md
function buildOwnerAgentOnboardingMetadata({ origin, resource, issuer }) {
  if (!(origin && resource && issuer)) {
    return null;
  }
  const approvalBase = stripTrailingSlash(origin);
  const rs = stripTrailingSlash(resource);
  const as = stripTrailingSlash(issuer);
  return {
    advisory: true,
    profile: 'trusted_owner_agent',
    warning:
      'Owner-level local automation. This profile yields an owner bearer that authorizes owner-visible REST/control-plane access — not a grant-scoped external client. Use grant-scoped MCP for ordinary third-party agents.',
    authorization_server: as,
    resource: rs,
    owner_approval_url: `${approvalBase}/dashboard`,
    device_authorization_endpoint: `${as}/oauth/device_authorization`,
    token_endpoint: `${as}/oauth/token`,
    introspection_endpoint: `${as}/introspect`,
    registration_endpoint: `${as}/oauth/register`,
    revocation_path_template: `${as}/oauth/register/{client_id}`,
    schema_endpoint: `${rs}/v1/schema`,
    streams_endpoint: `${rs}/v1/streams`,
    query_base: `${rs}/v1`,
    event_subscriptions_endpoint: `${rs}/v1/event-subscriptions`,
    // Owner-agent control entrypoint + action-family catalog. Projected from
    // the same `buildOwnerAgentControlSurface` builder the bearer-authed
    // `GET /v1/owner/control` route returns, so discovery and the live
    // capability document never disagree on what is supported. See
    // openspec/changes/add-owner-agent-control-surface.
    control_surface: buildOwnerAgentControlSurface({ resource: rs }),
    mcp_owner_bearer_rejected: true,
    pdpp_token_kind: 'owner',
  };
}

function buildRsApp(opts = {}) {
  const app = createApp({ logger: opts.logger });
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  const referenceRevision = resolveReferenceRevision(opts);
  const explicitResource = opts.rsPublicUrl || (!opts.ignoreAmbientPublicUrls ? process.env.RS_PUBLIC_URL : null);
  // Trusted INTERNAL resource-server base for the hosted-MCP adapter's own
  // child-grant self-calls, plumbed in via `opts.rsInternalUrl` from startServer
  // (which sources it from the explicit `PDPP_RS_URL` / opt — no new env). It is
  // an operator-configured loopback/cluster address, never request-derived. When
  // absent the adapter falls back to the advertised public resource (current
  // behavior). startServer intentionally does NOT pass the bare default here.
  // Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
  const internalResource = opts.rsInternalUrl ?? null;
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

  // `GET /mcp`, `POST /mcp`, `DELETE /mcp` are mounted via
  // `server/routes/rs-hosted-mcp.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§5.4). Behaviour-preserving
  // extraction: same `requireTrustedHostedMcpResource` host guard, same
  // `setHostedMcpProtectedResourceMetadata` middleware, same
  // `requireToken` + `requireClientOrMcpPackage` auth posture, same
  // package-token → PackageRsClient fan-out, same single-bearer path,
  // same response envelope and headers.
  mountRsHostedMcp(app, {
    explicitResource,
    internalResource,
    trustedMetadataHosts,
    referenceRevision,
    getGrantPackageAccess,
    handleStreamableHttpRequest,
    createPackageRsClient,
    createRsClient,
    requireToken,
    requireClientOrMcpPackage,
    pdppError,
  });

  // Build rsMutationContext here so both mountRsEventSubscriptions (registered
  // before mountRsReadQueries) and mountRsBlobsUpload / mountRsMutation
  // (registered after) share the same context object.
  const rsMutationContext = {
    requireToken,
    requireOwner,
    requireClient,
    pdppError,
    buildMutationContext,
    buildStateContext,
    setReferenceTraceId,
    emitMutationRequested,
    emitMutationEvent,
    rejectMutation,
    emitStateRequested,
    emitStateEvent,
    rejectState,
    resolveRegisteredConnectorManifest,
    resolveOwnerConnectorNamespace,
    persistContentAddressedBlob,
    storageTargetForConnectorNamespace,
    deleteAllRecords,
    deleteRecord,
    ingestRecord: (target, record) => ingestRecord(target, record),
    getSyncState,
    putSyncState,
    resolveGrantScopedStateGrant,
    toPublicConnectorStateProjection,
    resolveSingleConnectorIdQueryValue,
    handleError,
    getDefaultClientEventSubscriptionStore,
    getDefaultDeliveryWorker,
  };

  // /v1/event-subscriptions cluster is mounted via `server/routes/rs-mutation.ts`
  // per OpenSpec change `split-reference-server-by-route-family` (§4).
  // Behaviour-preserving extraction: same auth posture (`requireClient`), same
  // middleware order, same response envelopes, same status codes.
  // Registered here — before the hosted-UI CSS and mountRsReadQueries — to
  // preserve the original route registration order.
  mountRsEventSubscriptions(app, rsMutationContext);

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
    // Advisory owner-agent onboarding pointer on the RS root. Same host
    // capabilities the protected-resource metadata route uses, so the root and
    // `.well-known` documents stay consistent and forwarded-origin-safe. See
    // openspec/changes/add-trusted-owner-agent-onboarding.
    agentDiscoveryOrigin: opts.agentDiscoveryOrigin || null,
    asPort: opts.asPort || AS_PORT,
    buildOwnerAgentOnboardingMetadata,
    explicitResource,
    rejectUntrustedMetadataHost,
    resolveExplicitIssuer: () =>
      opts.asIssuer ||
      opts.asPublicUrl ||
      (!opts.ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null),
    resolvePublicUrl,
    resolveSiblingPublicUrl,
    shouldUseDirectRequestOrigin,
    trustedMetadataHosts,
  });

  // RS `/.well-known/oauth-protected-resource` and `/oauth-protected-resource/mcp`
  // are mounted via `server/routes/root-and-discovery.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Behaviour-preserving extraction:
  // same mount points, same handlers, same envelopes.
  const protectedResourceMetadataContext = {
    agentDiscoveryOrigin: opts.agentDiscoveryOrigin || null,
    asPort: opts.asPort || AS_PORT,
    buildAgentDiscoveryMetadata,
    buildOwnerAgentOnboardingMetadata,
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

  // RS read/query family (`/v1` reads + lexical/semantic/hybrid search) is
  // mounted via `server/routes/rs-read.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§3). Behaviour-preserving
  // extraction: same mount points, same auth (`requireToken`), same
  // request-id / trace-id wiring, same source/manifest/grant resolution, same
  // `query.received` / `disclosure.served` spine emission, same envelopes,
  // status codes, and error mapping. Every host capability the routes touch is
  // injected here so the adapter never reaches back into this closure. The
  // blob-read route (`GET /v1/blobs/:blob_id`) mounts after `POST /v1/blobs`
  // below, preserving the original registration order.
  const rsReadContext = {
    opts,
    requireToken,
    ensureRequestId,
    setReferenceTraceId,
    buildQueryActorContext,
    buildOwnerQuerySourceDescriptor,
    buildClientSourceDescriptor,
    buildSourceDescriptor,
    emitQueryReceived,
    emitSpineEvent,
    rejectQuery,
    handleError,
    finalizeCanonicalEnvelope,
    resolveNativeManifest,
    resolveNativeStorageBinding,
    resolveGrantManifest: (tokenInfo, options) => resolveGrantManifest(tokenInfo, options),
    resolveOwnerReadScope,
    resolveOwnerManifest: (req, options) => resolveOwnerManifest(req, options),
    resolveOwnerManifestFromScope: (ownerScope, options) => resolveOwnerManifestFromScope(ownerScope, options),
    ownerSubjectIdForBindings,
    resolveRegisteredConnectorManifest,
    listRegisteredConnectorIds,
    getOwnerTokenSubjectId,
    buildConnectorDiscoveryItem,
    buildConnectorSchemaItem,
    buildStreamMetadataEntry,
    buildOwnerReadGrant,
    buildConnectorAwareFreshness,
    decorateRecordBlobRefs,
    projectBindingForWire,
    getConnectorFreshnessEvidence,
    getVisibleStreamFreshness,
    listAllStreams,
    listStreamsAcrossBindings,
    resolveReadRequestBindings,
    aggregateRecordsAcrossBindings,
    queryRecordsAcrossBindings,
    getRecordAcrossBindings,
    getRecord,
    validateRequestedQueryFieldParams,
    runLexicalSearch,
    runSemanticSearch,
    runHybridSearch,
    getSemanticBackend,
    createBlobStore,
    canonicalConnectorKey,
    AmbiguousConnectionError,
  };
  mountRsReadQueries(app, rsReadContext);

  // POST /v1/blobs is mounted via `server/routes/rs-mutation.ts` per OpenSpec
  // change `split-reference-server-by-route-family` (§4). Behaviour-preserving
  // extraction: same auth posture (`requireOwner`), same request-id / trace-id
  // wiring, same response envelope, same status codes.
  // Registered immediately after mountRsReadQueries, before mountRsBlobRead,
  // to preserve the original route registration order.
  mountRsBlobsUpload(app, rsMutationContext);

  // GET /v1/owner/connections is the bearer-authed owner-agent control-surface
  // listing of configured connection instances. It is the `/v1/owner/*` sibling
  // of the cookie-authed `/_ref/connections` listing: same store, same
  // connector-key canonicalization, same display-name placeholder rules, but it
  // emits the owner-agent contract (`connection_id`, deprecated
  // `connector_instance_id` alias, `connector_id`/`connector_key`,
  // `label_status`). Gated by `requireToken` + `requireOwner` so client and
  // mcp_package bearers are rejected with 403; `/mcp` owner-bearer rejection is
  // untouched. See openspec/changes/add-owner-agent-control-surface.
  const ownerConnectionsContext = {
    requireToken,
    requireOwner,
    pdppError,
    handleError,
    buildOwnerConnectionSupportedActions,
    canonicalConnectorKey,
    createTraceContext,
    createRequestConnectorInstanceStore,
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    listSchedules: async () => (opts.controller ? await opts.controller.listSchedules() : []),
    projectStorageDisplayName,
    // Same trusted, forwarded-origin-safe RS base resolution the control
    // entrypoint uses, so a row's supported_actions URLs match the advertised
    // resource and the per-connection catalog agrees with GET /v1/owner/control.
    resolveResource: (req) => resolvePublicUrl(req, explicitResource),
    resolveSingleConnectorIdQueryValue,
    setReferenceTraceId,
  };
  mountOwnerConnectionsList(app, ownerConnectionsContext);

  // PATCH /v1/owner/connections/:connectionId is the bearer-authed owner-agent
  // rename: a trusted local owner agent labels a connection (e.g. "the owner personal"
  // / "Shared Amazon") without a browser owner session or `/_ref` session cookie.
  // It shares the connector-instance store rename semantics with the cookie-authed
  // `PATCH /_ref/connections/:id` route under a separate owner-bearer auth adapter;
  // `/mcp` owner-bearer rejection is untouched. See
  // openspec/changes/add-owner-agent-control-surface (task 4.4).
  mountOwnerConnectionRename(app, ownerConnectionsContext);

  // POST /v1/owner/connections/intents is the bearer-authed owner-agent
  // connection-initiation route: a trusted local owner agent asks "how do I add
  // a new connection for connector X?" and receives a typed, auditable,
  // owner-mediated next step instead of a silently-created connection. The route
  // classifies the connector by its manifest `runtime_requirements.bindings`
  // and, for proven local-collector connectors (claude-code, codex), mints a
  // real single-use enrollment code via the SAME `deviceExporterStore`
  // operation the cookie-authed `/_ref/device-exporters/enrollment-codes` route
  // uses (separate owner-bearer auth adapter — no handler cloning). Browser-bound
  // (Amazon, chase, chatgpt) and API/network-only (github, gmail) connectors get
  // a typed `unsupported` whose reason names the exact missing primitive. Same
  // owner-bearer guards as /v1/owner/connections; `/mcp` owner-bearer rejection
  // is untouched. See openspec/changes/add-owner-agent-control-surface (tasks
  // 2.3, 5.1-5.4).
  // The device-exporter store and the enroll route live on the AS app
  // (`buildAsApp`); the owner-agent control surface lives on the RS app. Both
  // the AS enroll route and this RS-scoped store read the same backing DB, so a
  // code minted here is exchangeable at the AS enroll endpoint. The enroll
  // endpoint URL is therefore resolved against the AS issuer base (same
  // derivation as the protected-resource-metadata / onboarding routes), never
  // the RS base.
  const resolveAsIssuerBase = (req) => {
    const explicitIssuer =
      opts.asIssuer ||
      opts.asPublicUrl ||
      (!opts.ignoreAmbientPublicUrls ? (process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) : null);
    const fallbackIssuer = `${req.protocol}://${req.hostname}:${opts.asPort || AS_PORT}`;
    const issuerSource = shouldUseDirectRequestOrigin(req, explicitIssuer)
      ? fallbackIssuer
      : explicitIssuer || fallbackIssuer;
    return resolvePublicUrl(req, issuerSource);
  };
  mountOwnerConnectionIntent(app, {
    requireToken,
    requireOwner,
    pdppError,
    handleError,
    canonicalConnectorKey,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    setReferenceTraceId,
    deviceExporterStore: opts.deviceExporterStore || getDefaultDeviceExporterStore(),
    generateReferenceSecret,
    generateSpineId,
    hashDeviceSecret,
    getConnectorManifest: (connectorId) => getConnectorManifest(connectorId),
    readReferenceLocalConnectorCatalogManifest,
    resolveEnrollBaseUrl: resolveAsIssuerBase,
  });

  // GET /v1/owner/connector-templates is the bearer-authed owner-agent template
  // catalog. It separates connector implementation metadata from configured
  // connection instances, embeds related connection summaries, and reports
  // template-level `initiate_connection` support truthfully: proven
  // local-collector templates can create an enrollment intent; browser-bound and
  // API/network-only templates name the missing primitive instead of pretending
  // an owner bearer can add a provider account.
  mountOwnerConnectorTemplates(app, {
    requireToken,
    requireOwner,
    handleError,
    canonicalConnectorKey,
    createRequestConnectorInstanceStore,
    getConnectorManifest: (connectorId) => getConnectorManifest(connectorId),
    getOwnerTokenSubjectId,
    listReferenceLocalConnectorCatalogManifests,
    listRegisteredConnectorIds,
    projectStorageDisplayName,
    resolveResource: (req) => resolvePublicUrl(req, explicitResource),
  });

  // GET /v1/owner/control is the bearer-authed owner-agent control entrypoint:
  // a non-secret capability document that names every owner-agent control
  // action family, marks supported vs owner-mediated vs unsupported, and links
  // to the supported owner-agent routes (e.g. /v1/owner/connections). It is the
  // durable discovery surface for trusted local owner agents. Same owner-bearer
  // guards as /v1/owner/connections; /mcp owner-bearer rejection is untouched.
  // The action catalog is projected from `buildOwnerAgentControlSurface` (the
  // same builder the `pdpp_owner_agent_onboarding.control_surface` metadata hint
  // uses) so discovery and the live document never disagree. URLs are resolved
  // from the caller-visible trusted RS public base with the same
  // forwarded-origin handling as the metadata routes. See
  // openspec/changes/add-owner-agent-control-surface.
  mountOwnerControl(app, {
    requireToken,
    requireOwner,
    handleError,
    buildOwnerAgentControlSurface,
    resolveResource: (req) => resolvePublicUrl(req, explicitResource),
  });

  // GET /v1/blobs/:blob_id is mounted via `server/routes/rs-read.ts` (§3),
  // registered here — immediately after `POST /v1/blobs` — to preserve the
  // original route registration order. Behaviour-preserving extraction.
  mountRsBlobRead(app, rsReadContext);

  if (!nativeMode) {
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

    // DELETE /v1/streams/:stream/records, DELETE /v1/streams/:stream/records/:id,
    // POST /v1/ingest/:stream, GET /v1/state/:connectorId, PUT /v1/state/:connectorId
    // are mounted via `server/routes/rs-mutation.ts` per OpenSpec change
    // `split-reference-server-by-route-family` (§4). Behaviour-preserving extraction:
    // same auth posture, same middleware order, same response envelopes, same status
    // codes, same spine event emission. Only registered in polyfill mode (!nativeMode).
    mountRsMutation(app, rsMutationContext);
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
  // Internal RS base for the hosted-MCP adapter's own child-grant self-calls
  // (F1: avoid hairpinning PATCH self-calls through the public edge that 405s
  // PATCH). Only honor an EXPLICITLY configured internal base — `opts.rsInternalUrl`
  // or the operator's `PDPP_RS_URL` — because that is the only value known to
  // point at the live RS. The bare `DEFAULT_RS_INTERNAL_URL` (localhost:7663) is
  // deliberately NOT used as an implicit internal base: in ephemeral-port
  // harnesses (rsPort:0) and any deployment where the default does not match the
  // realized listener it would misroute self-calls. When no explicit internal
  // base is configured the adapter falls back to the advertised public resource,
  // preserving current behavior.
  // Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
  const explicitRsInternalUrl =
    opts.rsInternalUrl ??
    (!ignoreAmbientPublicUrls ? (process.env.PDPP_RS_URL?.trim() || null) : null);
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
      const activeSubs = subs.filter((row) => row.status === 'active');
      const changedInstanceOwner = activeSubs.some((row) => row.authority_kind === 'trusted_owner_agent')
        ? (await createRequestConnectorInstanceStore().get(change.connectorInstanceId))?.ownerSubjectId ?? null
        : null;
      const events = deriveClientEventsFromRecordChange(
        {
          connectorId: change.connectorId,
          connectorInstanceId: change.connectorInstanceId,
          ownerSubjectId: changedInstanceOwner,
          connectionId: change.connectionId ?? null,
          stream: change.stream,
          version: Number(change.version) || 0,
          emittedAt: change.emittedAt,
        },
        activeSubs
          .map((row) => ({
            subscriptionId: row.subscription_id,
            authorityKind: row.authority_kind,
            grantId: row.grant_id,
            clientId: row.client_id,
            subjectId: row.subject_id,
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
    // Explicitly-configured internal RS base for the hosted-MCP adapter's
    // child-grant self-calls (null when only the bare default would apply, so
    // the adapter falls back to the public resource). See explicitRsInternalUrl.
    // Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
    rsInternalUrl: explicitRsInternalUrl,
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
        // Canonicalize at the autonomous-scheduler boundary. A legacy /
        // migration `connector_schedules` row can carry a URL-shaped or
        // legacy-alias `connector_id`: the controller's `upsertSchedule`
        // canonicalizes on write, but rows seeded before that slice (or by a
        // non-controller path) do not. Forwarding it verbatim makes the
        // scheduler emit the spine run source / actor_id and persist
        // run-history + last-run rows under the non-canonical id, mismatching
        // the canonical key the read/admission paths key on. Normalize once
        // here, mirroring the established `canonicalConnectorKey(x) ?? x`
        // pattern (see index.js:1236, 1310). The manifest still resolves via
        // alias fallback, so eligible connectors still run.
        const connectorId = canonicalConnectorKey(schedule.connector_id) ?? schedule.connector_id;
        const manifest = await getConnectorManifest(connectorId);
        if (!manifest) {
          continue;
        }
        const scheduleIneligibilityReason = getScheduleIneligibilityReason(getManifestRefreshPolicy(manifest));
        if (scheduleIneligibilityReason) {
          logger?.warn?.(
            { connector_id: connectorId, reason: scheduleIneligibilityReason },
            'skipping scheduled connector because refresh policy is not background-safe',
          );
          continue;
        }
        const connectorPath = await Promise.resolve(
          connectorPathResolver(connectorId, manifest, { priorityClass: 'scheduled_refresh' }),
        );
        if (!connectorPath) {
          logger?.warn?.(
            { connector_id: connectorId },
            'skipping scheduled connector without runnable implementation',
          );
          continue;
        }
        connectors.push({
          connectorId,
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
