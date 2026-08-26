// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Personal Server
 *
 * Combined AS + RS implementing PDPP v0.1.0 core spec.
 * Starts on port 7662 (AS/introspection) and 7663 (RS query API).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import type { BrowserSurfaceAllocator, BrowserSurfaceLeaseManager } from "@opendatalabs/remote-surface/leases";
import { handleStreamableHttpRequest } from "@pdpp/mcp-server/server";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import type { FastifyBaseLogger } from "fastify";
import {
  createPdppCliCommand,
  getPdppCliPackageInfo,
  PDPP_CLI_DEFAULT_CLIENT_ID,
} from "../../packages/cli/src/package-info.ts";
import type { ProviderAuthManifestLike } from "../../packages/polyfill-connectors/src/provider-auth-adapter.ts";
import {
  evaluateStreamHealthAuthority,
  type OwnerSourcesDomEvidence,
  type StreamHealthAuthorityResult,
} from "../../scripts/stream-health-audit/authority.ts";
import { emitControllerBootedAndStashEpoch, reconcileOrphanedRunsAtBoot } from "../lib/controller-boot.ts";
import { exec, getOne, referenceQueries, transaction } from "../lib/db.ts";
import { checkOrphanedRecordsAtBoot } from "../lib/orphaned-record-check.ts";
import {
  createTraceContext,
  emitSpineEvent,
  generateSpineId,
  getRunStartedEvent,
  getRunTerminalEvent,
  getRunTerminalStatus,
  listSpineCorrelations,
  listSpineEventsPage,
  searchSpine,
} from "../lib/spine.ts";
import { buildEventPayload } from "../operations/as-client-event-subscriptions/index.ts";
import type {
  ConnectorIdentityPageBoundary,
  ConnectorSummaryPageProfile,
} from "../operations/ref-connectors-list/pagination.ts";
import { SourceWebhookError } from "../operations/ref-source-webhook-ingest/index.ts";
import { deriveClientEventsFromRecordChange } from "../operations/rs-client-event-derive/index.ts";
import { isHealthRelevant as isAttentionHealthRelevant } from "../runtime/attention.ts";
import { createOptionalBrowserSurfaceLeaseManager } from "../runtime/browser-surface/remote-surface-optional.ts";
import { connectorRetainsSurfaceProcess } from "../runtime/browser-surface/retained-surface-connectors.ts";
import {
  type BrowserSurfaceLeaseSweepCloseSource,
  type BrowserSurfaceLeaseSweepTimer,
  createBrowserSurfaceLeaseSweepTimer,
} from "../runtime/browser-surface-lease-sweep-timer.ts";
import {
  DEFAULT_NEKO_LEASE_SWEEP_INTERVAL_MS,
  parseNekoBrowserSurfaceRuntimeConfig,
} from "../runtime/browser-surface-leases.ts";
import {
  type BrowserSurfaceReadinessProbe,
  createDefaultBrowserSurfaceReadinessProbe,
} from "../runtime/browser-surface-readiness.ts";
import {
  type ConnectorEnvironmentPolicy,
  parseConnectorEnvironmentPolicy,
} from "../runtime/connector-child-environment.ts";
import {
  type ConnectorManifest,
  type Controller,
  createController,
  getScheduleIneligibilityReason,
  resolveDefaultConnectorPath,
} from "../runtime/controller.ts";
import { NekoSurfaceAllocatorClient } from "../runtime/neko-surface-allocator.ts";
import { isClosedPipeWriteError } from "../runtime/pipe-errors.ts";
import { hasForwardEvidenceDebt } from "../runtime/recovery-decision.ts";
import { projectRunAutomationPolicy } from "../runtime/run-automation-policy.ts";
import { matchesRecoveryInstance } from "../runtime/scheduler/recovery-instance-scope.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import { SOURCE_PRESSURE_GAP_REASONS } from "../runtime/scheduler-source-pressure-cooldown.ts";
import { isVendoredUndiciParserAssertion } from "../runtime/undici-parser-errors.ts";
import {
  buildPendingConsentRequestUri,
  configureNativeManifest,
  consumeConsentExchangeCode,
  countGrantPackagesForOwner,
  createCimdDocument,
  createConsentExchangeCode,
  createHostedMcpGrantPackage,
  deleteCimdDocument,
  deleteRegisteredClient,
  exchangeGrantScopedDeviceCode,
  exchangeOAuthAuthorizationCode,
  exchangeOAuthRefreshToken,
  getCimdDocument,
  getConfiguredNativeManifest,
  getConnectorManifest,
  getCumulativeClientAccessForPackage,
  getGrantPackageAccess,
  getGrantPackageForOwner,
  getManifestForStorageBinding,
  introspect,
  issueOAuthAuthorizationCodeForDeviceCode,
  issueOAuthAuthorizationCodeForPackageDeviceCode,
  listActiveTokensForOwnerClient,
  listCimdDocuments,
  listGrantPackagesForOwner,
  listOwnerIssuedClients,
  listRegisteredConnectorIds,
  registerConnector,
  registerDynamicClient,
  requireGrantContractAgainstManifest,
  requireResolvedPersistedGrantState,
  resolveOAuthClient,
  revokeGrant,
  revokeGrantPackage,
  revokeOwnerClientTokenByPublicId,
  seedPreRegisteredClients,
  stageOAuthAuthorizationCodeRequest,
  updateRegisteredClientName,
} from "./auth.ts";
import { autoEnrollEligibleSchedules } from "./auto-enroll-eligible-schedules.ts";
import type { CimdFetchDependencies } from "./cimd.ts";
import { acquireDefaultDeliveryWorker, getDefaultDeliveryWorker } from "./client-event-delivery-worker.ts";
import {
  buildCollectorProtocolMismatchBody,
  isAcceptedCollectorProtocolVersion,
  readCollectorProtocolHeader,
  SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS,
} from "./collector-protocol.ts";
import { attachActivationScheduleIfAutomatic } from "./connection-activation-schedules.ts";
import { projectStorageDisplayName, resolveRequestConnectionId } from "./connection-id-request.ts";
import {
  AmbiguousConnectionError,
  listActiveBindingsForGrant,
  listGrantedConnectionsForStream,
  projectBindingForWire,
} from "./connection-identity.ts";
import { connectionConfigEntriesFromManifest } from "./connection-setup-plan.ts";
import {
  type ConnectorInstanceWriteOwnership,
  withConnectorInstanceWrite,
} from "./connector-instance-write-coordinator.ts";
import { canonicalConnectorKey, isInternalConnectorId, legacyLocalAliasMap } from "./connector-key.ts";
import { createResumableConnectorMaintenanceSweep } from "./connector-maintenance-sweep.ts";
import {
  getConnectorSummaryEvidence,
  markConnectorSummaryEvidenceDirty,
  reconcileDirtyConnectorSummaryEvidence,
  runBoundedSummaryEvidenceSweep,
  setConnectorSummaryReconcileObservationSink,
} from "./connector-summary-read-model.ts";
import { createConnectorSummaryReconcileObservationSink } from "./connector-summary-reconcile-observability.ts";
import {
  applyDatasetSummaryBlobDelta,
  ensureDatasetSummaryProjectionHealthy,
  getDatasetSummaryProjection,
  listStreamProjections,
  rebuildDatasetSummaryProjection,
  reconcileDirtyDatasetSummaryRecordTimeBounds,
} from "./dataset-summary-read-model.ts";
import { closeDb, getDb, initDb } from "./db.ts";
import {
  collectDeploymentDiagnostics,
  probeDiskHeadroom,
  runtimeBrowserCapabilityFromEnv,
} from "./deployment-diagnostics.ts";
import { composeFleetHealthVerdict } from "./fleet-health.ts";
import { deriveReferenceFreshness } from "./freshness.ts";
import { LOCAL_COLLECTOR_PROVEN_KEYS } from "./generated/connector-registry.generated.ts";
import {
  encodeHostedMcpSelection,
  encodeHostedMcpStreamSelection,
  hostedMcpSourceKey,
  parseHostedMcpSelections,
  parseHostedMcpStreamSelections,
} from "./hosted-mcp-selection.ts";
import {
  escapeHtml as hostedEscape,
  renderActionRow,
  renderEmptyState,
  renderHostedDocument,
  renderKeyValueList,
  renderPageIntro,
  renderResultState,
  renderSurface,
} from "./hosted-ui.ts";
import { registerInboxRoutes } from "./inbox.ts";
import {
  authenticateIntrospectionCaller,
  createRemoteIntrospector,
  type IntrospectionCallerCredentials,
} from "./introspection-http.ts";
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
} from "./metadata.ts";
import { unresolvedOwnerActionEvidenceFromSummary } from "./owner-action-gate.ts";
import { createOwnerAuthPlaceholder, OWNER_AUTH_DEFAULT_SUBJECT_ID } from "./owner-auth.ts";
import { resolveOwnerExposurePosture } from "./owner-exposure-posture.ts";
import { createPackageRsClient, createRsClient } from "./package-rs-client.ts";
import { reconcilePolyfillManifests } from "./polyfill-manifest-reconcile.ts";
import { postgresPersistContentAddressedBlob } from "./postgres-records.ts";
import {
  closePostgresStorage,
  collectPhysicalFootprint,
  getPostgresLexicalBackendState,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
  resolveStorageBackend,
} from "./postgres-storage.ts";
import { createGenericProviderAuthDispatch } from "./provider-auth/generic-dispatch.ts";
import { buildRecordVersionStatsEnvelope } from "./record-version-stats.ts";
import {
  aggregateRecordsAcrossBindings,
  assertSqliteConnectorInstanceWritableWithinTransaction,
  classifyIngestFailure,
  deleteAllRecords,
  deleteConnectionRecordRowsPostgres,
  deleteConnectionRecordRowsSqlite,
  deleteRecord,
  drainConnectorInstanceIndexWork,
  enqueueDeviceIndexMaintenance,
  enumerateConnectionStreams,
  getDatasetBlobBytes,
  getDatasetRecordChangesBytes,
  getDatasetRecordsAggregate,
  getDatasetRecordTimeBounds,
  getDatasetSummaryStreamRecordTimeBounds,
  getRecord,
  getRecordAcrossBindings,
  getRecordFieldWindowAcrossBindings,
  getSyncState,
  ingestRecord,
  ingestRecords,
  listAllStreams,
  listDatasetSummaryStreamProjectionSeeds,
  listDatasetTopConnectorCandidates,
  listLocalCoverageDiagnostics,
  listStreams,
  listStreamsAcrossBindings,
  maintainRecordIndexes,
  prepareDeviceFinalRecords,
  putSyncState,
  queryRecordsAcrossBindings,
  resolveReadRequestBindings,
  setClientEventEnqueueHook,
  teardownConnectionSearchProjection,
} from "./records.ts";
import {
  collectRecordsTimelineEntries,
  getConnectorAttentionProjection,
  getConnectorDetail,
  getConnectorSummaryForRoute,
  getOwnerConnectionDiagnostics,
  getPendingApprovalDetail,
  invalidateConnectorSummariesCache,
  listConnectorSourcesSummaryPage,
  listConnectorSummaries,
  listConnectorSummaryPage,
  listOwnerVisibleConnectorInstances,
  listPendingApprovals,
} from "./ref-control.ts";
import {
  DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
  DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS,
} from "./reference-local-defaults.ts";
import { resolveReferenceRevision, setReferenceRevisionHeader } from "./reference-revision.ts";
import { servedRootLandingIfBrowser } from "./reference-root-landing.ts";
import { resolveReferenceTopology } from "./reference-topology.ts";
import {
  applyRetainedSizeBlobDelta,
  getRetainedSizeGlobal,
  listRetainedSizeConnections,
  listRetainedSizeStreams,
  listRetainedSizeTop,
  rebuildRetainedSize,
  reconcileDirtyRetainedSize,
} from "./retained-size-read-model.ts";
import {
  createAgentConnectAttemptStore,
  mountAsAgentConnect,
  mountAsAgentConnectToken,
} from "./routes/as-agent-connect.ts";
import { mountAsAuthorize } from "./routes/as-authorize.ts";
import { mountAsConsent } from "./routes/as-consent.ts";
import { mountAsDcr } from "./routes/as-dcr.ts";
import { mountAsDeviceUi } from "./routes/as-device-ui.ts";
import { buildApplyGrantRevokeSideEffects, mountAsGrantRevoke } from "./routes/as-grant-revoke.ts";
import { mountAsDeviceAuthorization, mountAsIntrospect, mountAsToken } from "./routes/as-oauth.ts";
import { mountAsPar } from "./routes/as-par.ts";
import { mountAsPolyfillConnectorDetail, mountAsPolyfillConnectorRegister } from "./routes/as-polyfill-connectors.ts";
import { mountClientMetadata } from "./routes/client-metadata.ts";
import { mountHostedUiCss } from "./routes/hosted-ui-asset.ts";
import { mountOwnerConnectionCollectionScope } from "./routes/owner-connection-collection-scope.ts";
import { mountOwnerConnectionConfig } from "./routes/owner-connection-config.ts";
import { mountOwnerConnectionDelete } from "./routes/owner-connection-delete.ts";
import { mountOwnerConnectionDiagnostics } from "./routes/owner-connection-diagnostics.ts";
import { mountOwnerConnectionIntent } from "./routes/owner-connection-intent.ts";
import { mountOwnerConnectionPause } from "./routes/owner-connection-pause.ts";
import { mountOwnerConnectionReactivate } from "./routes/owner-connection-reactivate.ts";
import { applyResume, mountOwnerConnectionResume } from "./routes/owner-connection-resume.ts";
import { mountOwnerConnectionRevoke } from "./routes/owner-connection-revoke.ts";
import { mountOwnerConnectionRun } from "./routes/owner-connection-run.ts";
import { mountOwnerConnectionSchedule } from "./routes/owner-connection-schedule.ts";
import { mountOwnerConnectionRename, mountOwnerConnectionsList } from "./routes/owner-connections.ts";
import { mountOwnerConnectorTemplates, parseUatConnectorAllowlist } from "./routes/owner-connector-templates.ts";
import { mountOwnerControl } from "./routes/owner-control.ts";
import {
  mountRefApprovals,
  mountRefCimdClientDocuments,
  mountRefClients,
  mountRefClientTokenRevoke,
  mountRefClientTokens,
  mountRefDeployment,
  mountRefExploreRecordBuckets,
  mountRefExploreRecords,
  mountRefRecordsTimeline,
  mountRefSchedules,
  mountRefSearch,
} from "./routes/ref-admin.ts";
import {
  type BrowserEnrollmentShellSourceBinding,
  mountRefBrowserEnrollmentShell,
  promoteBrowserEnrollmentShellBinding,
} from "./routes/ref-browser-enrollment-shell.ts";
import { mountRefConnectionPause } from "./routes/ref-connection-pause.ts";
import { HISTORICAL_ARCHIVE_SOURCE_BINDING_KIND, mountRefConnectionResume } from "./routes/ref-connection-resume.ts";
import {
  mountRefConnectionDelete,
  mountRefConnectionDetail,
  mountRefConnectionReactivate,
  mountRefConnectionRevoke,
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
  mountRefFleetHealth,
} from "./routes/ref-connectors.ts";
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
} from "./routes/ref-dataset.ts";
import {
  sanitizeDeviceExporterDiagnostic,
  sanitizeLocalCollectorGapDetails,
} from "./routes/ref-device-exporter-sanitize.ts";
import {
  mountRefDeviceExporterDiagnostics,
  mountRefDeviceExporterEnroll,
  mountRefDeviceExporterEnrollmentCodes,
  mountRefDeviceExporterHeartbeat,
  mountRefDeviceExporterIngestBatches,
  mountRefDeviceExporterLocalCollectorGaps,
  mountRefDeviceExporterLocalCollectorGapsRecovered,
  mountRefDeviceExporterRevoke,
  mountRefDeviceExporterSelfRevoke,
  mountRefDeviceExporterSourceInstanceStateGet,
  mountRefDeviceExporterSourceInstanceStatePut,
  mountRefDeviceExporterSourceInstances,
  mountRefDeviceExportersList,
} from "./routes/ref-device-exporters.ts";
import { codeToStatus, recoveryAdmissionExtrasForWire, typeFor } from "./routes/ref-error-status.ts";
import {
  mountRefEventSubscriptionsDisable,
  mountRefEventSubscriptionsGet,
  mountRefEventSubscriptionsList,
  mountRefGrantPackagesCount,
  mountRefGrantPackagesCumulative,
  mountRefGrantPackagesGet,
  mountRefGrantPackagesList,
  mountRefGrantPackagesRevoke,
} from "./routes/ref-grants.ts";
import {
  type ManualUploadDraftSourceBinding,
  mountRefManualUploadDraftConnection,
  promoteManualUploadDraftBinding,
  reconcileAbandonedManualUploadArtifactsAtBoot,
} from "./routes/ref-manual-upload-draft-connection.ts";
import {
  mountRefProviderAppConfigGet,
  mountRefProviderAppConfigPost,
  type ProviderIdentityGroupDescriptor,
} from "./routes/ref-provider-app-config.ts";
import {
  createInProcessPendingAuthStore,
  mountRefProviderAuthCallback,
  mountRefProviderAuthInitiate,
  type ProviderAuthExchanger,
} from "./routes/ref-provider-auth.ts";
import { mountRefRecordRejections } from "./routes/ref-record-rejections.ts";
import { mountRefRunStatus } from "./routes/ref-run-status.ts";
import { mountRefGrants, mountRefRuns, mountRefTraces } from "./routes/ref-spine-correlations.ts";
import { mountRefGrantTimeline, mountRefRunTimeline, mountRefTraceTimeline } from "./routes/ref-spine-timelines.ts";
import { mountRefStaticSecretCredentialCapture } from "./routes/ref-static-secret-credentials.ts";
import {
  mountRefStaticSecretDraftConnection,
  promoteStaticSecretDraftBinding,
  type StaticSecretDraftSourceBinding,
} from "./routes/ref-static-secret-draft-connection.ts";
import { mountRefStaticSecretSetupStatus } from "./routes/ref-static-secret-setup-status.ts";
import {
  mountAsAuthorizationServerMetadata,
  mountAsRoot,
  mountRsMcpProtectedResourceMetadata,
  mountRsProtectedResourceMetadata,
  mountRsRoot,
} from "./routes/root-and-discovery.ts";
import { mountRsHostedMcp } from "./routes/rs-hosted-mcp.ts";
import { mountRsBlobsUpload, mountRsEventSubscriptions, mountRsMutation } from "./routes/rs-mutation.ts";
import { mountRsBlobRead, mountRsReadQueries } from "./routes/rs-read.ts";
import { mountRefRunCancel } from "./routes/run-cancel.ts";
import { mountRefDevPlaygroundSession, mountRefRunInteraction } from "./routes/run-interaction.ts";
import { mountRefSourceWebhooks } from "./routes/source-webhooks.ts";
import {
  mountRefWebPushConfig,
  mountRefWebPushCreateSubscription,
  mountRefWebPushDeleteSubscription,
  mountRefWebPushListSubscriptions,
  mountRefWebPushTest,
} from "./routes/web-push.ts";
import {
  computeLexicalIndexState,
  getLexicalIndexBackfillProgress,
  lexicalIndexBackfillForManifest,
  runLexicalSearch,
} from "./search.ts";
import { runHybridSearch } from "./search-hybrid.ts";
import { triggerSearchIndexDirtySelfHeal } from "./search-index-reconcile.ts";
import {
  computeIndexState as computeSemanticIndexState,
  configureSemanticBackend,
  getSemanticBackend,
  getSemanticCapabilityIdentity,
  getSemanticIndexBackfillProgress,
  resolveSemanticBackendFromEnv,
  runSemanticSearch,
  scheduleSemanticEmbeddingWarmup,
  semanticIndexBackfillForManifest,
  supportsDeviceSemanticAttemptDeadline,
} from "./search-semantic.ts";
import { requireSourceDeclaration } from "./source-declaration.ts";
import type { AcceptedSourceDeclarationRevisionStore } from "./source-declaration-trust/revision-store.ts";
import {
  enforceSourceReadRequest,
  projectSourceIntrospectionWireContext,
  SourceIntrospectionContextError,
} from "./source-introspection-context.ts";
import {
  createPostgresAcquisitionBatchStore,
  createSqliteAcquisitionBatchStore,
} from "./stores/acquisition-batch-store.ts";
import { createBlobStore } from "./stores/blob-store.ts";
import {
  type BrowserSurfaceLeaseStore,
  getDefaultBrowserSurfaceLeaseStore,
} from "./stores/browser-surface-lease-store.ts";
import {
  getDefaultClientEventSubscriptionStore,
  getSubscriptionSummary,
  listActiveSubscriptions,
  listAllSubscriptions,
  listAttemptsForSubscription,
} from "./stores/client-event-subscription-store.ts";
import { getDefaultConnectorAttentionStore } from "./stores/connector-attention-store.ts";
import { getDefaultConnectorDetailGapStore } from "./stores/connector-detail-gap-store.ts";
import { getDefaultConnectorInstanceConfigStore } from "./stores/connector-instance-config-store.ts";
import {
  createPostgresConnectorInstanceCredentialStore,
  createSqliteConnectorInstanceCredentialStore,
} from "./stores/connector-instance-credential-store.ts";
import {
  admitOwnerBrowserEnrollmentRunConnection,
  admitOwnerRunConnection,
  ConnectorInstanceResolutionError,
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  isExpectedMissingConnectorInstance,
  makeConnectorInstanceSourceBindingKey,
  resolveOwnerConnectorInstanceNamespace,
} from "./stores/connector-instance-store.ts";
import { createConsentStore } from "./stores/consent-store.ts";
import {
  createDeviceExporterStore,
  DeviceBatchConflictError,
  getDefaultDeviceExporterStore,
} from "./stores/device-exporter-store.ts";
import {
  createPostgresManualUploadArtifactStore,
  createSqliteManualUploadArtifactStore,
} from "./stores/manual-upload-artifact-store.ts";
import { createOwnerDeviceAuthStore } from "./stores/owner-device-auth-store.ts";
import {
  createPresentationScreenStateStore,
  type PresentationScreenStateStore,
} from "./stores/presentation-screen-state-store.ts";
import {
  createDeploymentConfigResolver,
  createPostgresProviderAppConfigStore,
  createSqliteProviderAppConfigStore,
} from "./stores/provider-app-config-store.ts";
import { resolveProviderAuthRunEnv } from "./stores/provider-auth-run-credentials.ts";
import {
  createRecordRejectionStore,
  deletePostgresRecordRejectionsForConnectionWithClient,
  deleteSqliteRecordRejectionsForConnectionWithinTransaction,
  type InsertOrReplayRecordRejectionInput,
  insertOrReplayHostedRecordRejection,
  markAcceptedRecordRejectionsStale,
  type RecordRejectionReceipt,
} from "./stores/record-rejection-store.ts";
import {
  createResumableRunHistoryBackfillStage,
  runStartupRunHistoryBackfillToCompletion,
} from "./stores/run-history-backfill-stage.ts";
import { getDefaultSchedulerStore, type SchedulerStore } from "./stores/scheduler-store.ts";
import { countDirtySearchIndexScopes } from "./stores/search-index-dirty-store.ts";
import { getDefaultSourceWebhookEventStore } from "./stores/source-webhook-event-store.ts";
import { resolveStaticSecretRunEnv } from "./stores/static-secret-run-credentials.ts";
import {
  createDefaultStreamingCompanionFactory,
  type StreamingCompanionFactory,
} from "./streaming/companion-factory.ts";
import { createPlayground } from "./streaming/playground.ts";
import { registerStreamingRoutes } from "./streaming/routes.ts";
import { createRunTargetRegistry } from "./streaming/run-target-registry.ts";
import { createStreamingSessionStore } from "./streaming/sessions.ts";
import { buildLogger, createApp } from "./transport.ts";
import {
  createWebPushSubscriptionStore,
  fanoutEscalationWebPush,
  fanoutPendingInteractionWebPush,
  fanoutTestWebPush,
  resolveWebPushConfig,
  type WebPushConfig,
  type WebPushSubscriptionStore,
} from "./web-push-notifications.ts";

// ─── Shared types ─────────────────────────────────────────────────────────────

type LoggerLike = FastifyBaseLogger;

interface ResLike {
  getHeader: (name: string) => unknown;
  json: (body: unknown) => ResLike;
  locals?: Record<string, unknown>;
  raw?: {
    on?: (...args: unknown[]) => void;
    off?: (...args: unknown[]) => void;
    removeListener?: (...args: unknown[]) => void;
  };
  send?: (body?: unknown) => ResLike;
  setHeader: (name: string, value: unknown) => ResLike | undefined;
  status: (code: number) => ResLike;
}

interface ReqLike {
  accepts?: (types: string | string[]) => string | false;
  body?: unknown;
  connection?: { remoteAddress?: string };
  get: (name: string) => string | undefined;
  headers?: Record<string, string | string[] | undefined>;
  hostname?: string;
  ip?: string;
  is?: (type: string) => string | false;
  method?: string;
  ownerSession?: { sub?: string } | null;
  params?: Record<string, string>;
  path?: string;
  protocol: string;
  query?: Record<string, unknown>;
  raw?: {
    on?: (...args: unknown[]) => void;
    off?: (...args: unknown[]) => void;
    removeListener?: (...args: unknown[]) => void;
  };
  socket?: { remoteAddress?: string };
  tokenInfo?: TokenInfo;
}

interface TokenInfo {
  active?: boolean;
  client_id?: string | null;
  exp?: number | null;
  grant_id?: string | null;
  inactive_reason?: string | null;
  pdpp_token_kind?: string;
  scenario_id?: string | null;
  subject_id?: string | null;
  trace_id?: string | null;
  [key: string]: unknown;
}

type ApiError = Error & {
  code?: string;
  request_id?: string | null;
  trace_id?: string | null;
  param?: string | null;
  available_connections?: unknown[];
  retry_with?: string;
  [key: string]: unknown;
};

interface PdppErrorBody {
  available_connections?: unknown[];
  code: unknown;
  message: unknown;
  next_eligible_at?: string;
  next_step?: string;
  param?: string | null;
  pending_pressure_gap_count?: number;
  recovery_admission_reason?: string;
  request_id?: string;
  resource_metadata?: string | null;
  retry_with?: string;
  type: string;
}

interface SweepSummary {
  incomplete?: boolean;
  resumeAfterId?: string | null;
  [key: string]: unknown;
}

type StreamingSessionStore = ReturnType<typeof createStreamingSessionStore>;

interface StorageBinding {
  connector_id?: string | null;
  connector_instance_id?: string | null;
  [key: string]: unknown;
}

interface QueryContext {
  actorId?: string | null;
  actorType?: string | null;
  queryData?: Record<string, unknown>;
  queryId?: string | null;
  receivedEmitted?: boolean;
  scenarioId?: string | null;
  sourceDescriptor?: unknown;
  streamId?: string | null;
  tokenInfo?: TokenInfo | null;
  traceId?: string | null;
  [key: string]: unknown;
}

interface StateContext {
  actorId?: string | null;
  actorType?: string | null;
  connectorId?: string | null;
  grantId?: string | null;
  operation?: string | null;
  requestedEmitted?: boolean;
  requestedStreams?: string[] | null;
  requestId?: string | null;
  scenarioId?: string | null;
  sourceDescriptor?: unknown;
  traceId?: string | null;
  [key: string]: unknown;
}

interface MutationContext {
  actorId?: string | null;
  actorType?: string | null;
  connectorId?: string | null;
  operation?: string | null;
  requestedEmitted?: boolean;
  requestedRecordId?: string | null;
  requestId?: string | null;
  scenarioId?: string | null;
  sourceDescriptor?: unknown;
  streamId?: string | null;
  submittedRecordCount?: number | null;
  traceId?: string | null;
  [key: string]: unknown;
}

interface ServerOpts {
  acceptedCollectorProtocolVersions?: readonly string[];
  /** Internal onboarding handoff. This value is never accepted from the PAR request. */
  acceptedProviderNativeRevision?: {
    acceptedRevisionReference: string;
    revisionStore: AcceptedSourceDeclarationRevisionStore;
    sourceId: string;
  } | null;
  agentConnectTtlMs?: number;
  agentDiscoveryOrigin?: string | null;
  asIssuer?: string | null;
  asPort?: number;
  asPublicUrl?: string | null;
  autoEnrollEligibleSchedules?: boolean;
  awaitStartupBackfill?: boolean;
  bindHost?: string;
  browserSurfaceAllocator?: BrowserSurfaceAllocator;
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManager | null;
  browserSurfaceLeaseStore?: BrowserSurfaceLeaseStore;
  browserSurfaceReadinessProbe?: BrowserSurfaceReadinessProbe;
  cancelScheduledRun?: ((runId: string) => unknown) | null;
  cimdEnabled?: boolean;
  cimdFetchDependencies?: CimdFetchDependencies;
  clientEventSubscriptionsCapability?: unknown;
  clientEventSubscriptionsSupported?: boolean;
  configuredProviderAuthConnectorKeys?: readonly string[];
  connectionScopedRunEnvResolver?: ReturnType<typeof buildConnectionScopedRunEnvResolver>;
  /** Operator-owned connector child environment policy; defaults to the JSON env contract. */
  connectorEnvironmentPolicy?: ConnectorEnvironmentPolicy | null;
  connectorInstanceId?: string;
  connectorPathResolver?: ((connectorId: string, manifest?: ConnectorManifest) => string | null) | null;
  controller?: Controller | null;
  databaseUrl?: string;
  dbPath?: string;
  deviceExporterStore?: unknown;
  dynamicClientRegistrationInitialAccessTokens?: readonly string[];
  enableDynamicClientRegistration?: boolean;
  hostedRecordRejectionAfterInsertBeforeCommit?: (receipt: RecordRejectionReceipt) => Promise<void> | void;
  hybridRetrievalCapability?: unknown;
  hybridRetrievalSupported?: boolean;
  ignoreAmbientPublicUrls?: boolean;
  introspectionCallerCredentials?: IntrospectionCallerCredentials;
  introspectionFetch?: typeof fetch;
  isNekoProxyTargetApproved?:
    | ((
        descriptor: unknown,
        context: { session?: { interaction_id?: string | null; run_id?: string | null } | undefined }
      ) => boolean)
    | null;
  lexicalRetrievalCapability?: unknown;
  lexicalRetrievalSupported?: boolean;
  logger?: LoggerLike;
  makePresentationAttachmentId?: (() => string) | null;
  makeStreamingBrowserSessionId?: (() => string) | null;
  maxRecordRejectionPageSize?: number;
  nativeManifest?: ConnectorManifest | null;
  nekoProxyAllowedHosts?: readonly string[] | null;
  nekoProxyAutoLogin?: boolean;
  nekoWindowSettleProbe?: ((url: string) => Promise<unknown>) | null;
  onScheduleMutation?: (() => void) | null;
  ownerAuthForceSecureCookies?: boolean;
  ownerAuthPassword?: string;
  ownerAuthSameSite?: string;
  ownerAuthSessionTtlSeconds?: number;
  ownerAuthSubjectId?: string;
  ownerExposurePosture?: {
    allowUnauthenticatedOwnerWhenDisabled: boolean;
    lockConnectorRegistry: boolean;
    refuseBootReason?: string | null;
    hosted?: boolean;
    bindsNonLoopback?: boolean;
  } | null;
  ownerToken?: string | null;
  preRegisteredPublicClients?: unknown;
  presentationScreenStateStore?: PresentationScreenStateStore | null;
  presentationTerminalBarrier?: {
    invoke: ((args: unknown) => Promise<void>) | null;
    releaseLease: ((args: unknown) => Promise<void>) | null;
  };
  priorityClass?: string;
  providerAuthExchanger?: ProviderAuthExchanger | null;
  providerName?: string | null;
  publicDynamicClientRegistrationRateLimit?: { windowMs?: number; max?: number } | null;
  quiet?: boolean;
  reconcilePolyfillManifests?: boolean;
  recoveryOnly?: boolean;
  referenceBaseUrl?: string | null;
  referenceMode?: string | null;
  referenceOrigin?: string | null;
  referenceRevision?: string | null;
  resolveIntrospectionAudience?: (() => string | null) | null;
  resolveIntrospectionIssuer?: (() => string | null) | null;
  rsInternalUrl?: string | null;
  rsIntrospectionCredentials?: IntrospectionCallerCredentials;
  rsIntrospectionEndpoint?: string | null;
  rsPort?: number;
  rsPublicUrl?: string | null;
  rsUrl?: string | null;
  runTargetRegistry?: import("./streaming/run-target-registry.ts").RunTargetRegistry | null;
  schedulerStore?: SchedulerStore;
  semanticRetrievalBackend?: unknown;
  semanticRetrievalCapability?: unknown;
  semanticRetrievalSupported?: boolean;
  sourceDeclarationUri?: string | null;
  sqliteBusyTimeoutMs?: number;
  startClientEventDeliveryWorker?: boolean;
  staticSecretAutoResume?: boolean;
  staticSecretCredentialProber?: unknown;
  storageBackend?: "postgres" | "sqlite";
  streamingClearTimeout?: ((handle: unknown) => void) | null;
  streamingCompanionFactory?: StreamingCompanionFactory | null;
  streamingLogger?: LoggerLike | null;
  streamingNow?: (() => number) | null;
  streamingSessionStore?: StreamingSessionStore | null;
  streamingSessionTtlMs?: number | null;
  streamingSetTimeout?: ((fn: () => void, ms: number) => unknown) | null;
  triggerKind?: string;
  trustedMetadataHosts?: string | null;
  webPushConfig?: WebPushConfig | null;
  webPushSubscriptionStore?: WebPushSubscriptionStore | null;
}

function requestSelectsSource(body: unknown, sourceId: string): boolean {
  if (!(body && typeof body === "object" && "authorization_details" in body)) {
    return false;
  }
  const details = (body as { authorization_details?: unknown }).authorization_details;
  return (
    Array.isArray(details) &&
    details.some(
      (detail) =>
        detail !== null &&
        typeof detail === "object" &&
        "source" in detail &&
        (detail as { source?: { id?: unknown } }).source?.id === sourceId
    )
  );
}

function readIntrospectionCredentialsFromEnv(): IntrospectionCallerCredentials | null {
  const clientId = process.env.PDPP_RS_INTROSPECTION_CLIENT_ID?.trim();
  const clientSecret = process.env.PDPP_RS_INTROSPECTION_CLIENT_SECRET?.trim();
  if (!(clientId || clientSecret)) {
    return null;
  }
  if (!(clientId && clientSecret)) {
    throw new Error("PDPP RS introspection requires both client id and client secret");
  }
  return { clientId, clientSecret };
}

function generateLocalIntrospectionCredentials(): IntrospectionCallerCredentials {
  return {
    clientId: `rs-${randomBytes(12).toString("base64url")}`,
    clientSecret: randomBytes(32).toString("base64url"),
  };
}

function resolveIntrospectionCredentials(opts: ServerOpts): IntrospectionCallerCredentials {
  const asCredentials = opts.introspectionCallerCredentials;
  const rsCredentials = opts.rsIntrospectionCredentials;
  if (asCredentials && rsCredentials) {
    if (
      asCredentials.clientId !== rsCredentials.clientId ||
      asCredentials.clientSecret !== rsCredentials.clientSecret
    ) {
      throw new Error("AS and RS introspection credentials must match when both are configured");
    }
    return asCredentials;
  }
  return (
    asCredentials ?? rsCredentials ?? readIntrospectionCredentialsFromEnv() ?? generateLocalIntrospectionCredentials()
  );
}

function configuredNativeSourceId(opts: ServerOpts): string | null {
  const declaration = opts.nativeManifest?.source_declaration;
  if (!(declaration && typeof declaration === "object" && "source" in declaration)) {
    return null;
  }
  const { source } = declaration as { source?: { id?: unknown } };
  return typeof source?.id === "string" && source.id ? source.id : null;
}
interface OwnerDeviceAuthStore {
  approve: (userCode: string, subjectId?: string) => Promise<unknown>;
  deny: (userCode: string, subjectId?: string) => Promise<void>;
  exchangeDeviceCode: (input: { clientId: string; deviceCode: string }) => Promise<unknown>;
  getByApprovalId: (approvalId: string) => Promise<unknown>;
  getByUserCode: (userCode: string) => Promise<unknown>;
  initiate: (clientId: string, opts?: Record<string, unknown>) => Promise<unknown>;
}

const AS_PORT = Number.parseInt(process.env.AS_PORT || "7662", 10);
const RS_PORT = Number.parseInt(process.env.RS_PORT || "7663", 10);
const DB_PATH = process.env.PDPP_DB_PATH || process.env.DB_PATH || ":memory:";
const PDPP_PROVIDER_NAME = process.env.PDPP_PROVIDER_NAME || "PDPP Reference Provider";
const PDPP_PROVIDER_CONNECT_VERSION = process.env.PDPP_PROVIDER_CONNECT_VERSION || "draft-2026-04-16";
const PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION = process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION !== "0";
const PDPP_DCR_INITIAL_ACCESS_TOKENS = (process.env.PDPP_DCR_INITIAL_ACCESS_TOKENS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const PDPP_REFERENCE_TRACE_ID_HEADER = "PDPP-Reference-Trace-Id";
const PROTECTED_RESOURCE_METADATA_URL_LOCAL = "protectedResourceMetadataUrl";
const PROTECTED_RESOURCE_METADATA_NEXT_STEP =
  "Fetch error.resource_metadata, then follow pdpp_agent_discovery.cli when token completion is available; otherwise request a scoped client grant without using an owner bearer token.";
const AGENT_CONNECT_TTL_MS = 5 * 60 * 1000;
const PUBLIC_DCR_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const PUBLIC_DCR_RATE_LIMIT_MAX = 120;
// Bounds the one-shot startup summary-evidence observation
// (design.md "Startup is acceleration, not authority") — a connection this
// pass does not reach is repaired by the correctness-gate barrier on the
// next real read, never lost. `runBoundedSummaryEvidenceSweep` processes
// the canonical connection set in PAGE_SIZE-sized pages, each running a
// complete discovery+fold+repair+prune barrier for exactly that page (Sol
// P1.2's scoping fix makes every phase, including the fold, genuinely
// bounded by page size). `MAX_DURATION_MS` is checked BEFORE each page
// starts (never mid-page), so it bounds TOTAL time across every phase of
// every page — not merely a repair-loop count/time cap (Sol P2.2: a small
// candidate count alone does not bound the cost of an unscoped discovery
// or fold, which could each independently exceed budget before repair
// even begins). Generous enough to fully accelerate a typical owner's
// connection count well within budget, without unboundedly serializing
// work for an owner with an unusually large connection set before startup
// can otherwise proceed.
const STARTUP_SUMMARY_EVIDENCE_MAX_DURATION_MS = 5000;
const STARTUP_SUMMARY_EVIDENCE_PAGE_SIZE = 25;
// Caps how many follow-up sweep calls startup schedules to walk an
// incomplete pass to completion (Sol P2.1: "startup exposes a resume cursor
// but does not resume — the cursor cannot resume an interrupted fold").
// Each round is itself bounded by STARTUP_SUMMARY_EVIDENCE_MAX_DURATION_MS,
// so this is a genuine outer bound on total startup-acceleration work (an
// owner with an unusually large connection set stops accelerating after this
// many rounds). Terminal-gate revision (2026-07-29) removed the per-request
// repair barrier that used to cover whatever startup did not reach — ordinary
// GET is now read-only, so a connection this cap leaves unrepaired is instead
// covered by the recurring CONNECTOR_MAINTENANCE_SWEEP_INTERVAL_MS periodic
// tick below, never by a per-request fallback (design.md "Startup is
// acceleration, not authority" still holds: startup is acceleration, but what
// now backstops it is the periodic sweep, not the request path).
const STARTUP_SUMMARY_EVIDENCE_MAX_RESUME_ROUNDS = 20;
// Terminal-gate revision (2026-07-29): periodic tick interval for the
// connector-maintenance sweep (browser-enrollment-shell retirement, due-
// attention expiry, one bounded evidence-sweep round) — the recurring
// counterpart to the one-shot startup pass above, now that ordinary GET no
// longer performs any of these writes inline. 60s keeps staleness windows
// short relative to human-observed dashboard refresh cadence without
// running meaningfully more often than the durable state it sweeps
// actually changes.
const CONNECTOR_MAINTENANCE_SWEEP_INTERVAL_MS = 60_000;
const CONNECTOR_MAINTENANCE_EVIDENCE_SWEEP_MAX_DURATION_MS = 2000;
const CONNECTOR_MAINTENANCE_EVIDENCE_SWEEP_PAGE_SIZE = 25;
// Run-history backfill (terminal-read-architecture-fable-0730.md §9):
// same acceleration-not-authority shape as the summary-evidence startup
// pass above, on its own name-keyed cursor. NOT a traffic gate (R9.1) —
// fired via setImmediate/fire-and-forget below, never awaited before the
// listener opens.
const STARTUP_RUN_HISTORY_BACKFILL_MAX_DURATION_MS = 2000;
const STARTUP_RUN_HISTORY_BACKFILL_BATCH_SIZE = 25;
const STARTUP_RUN_HISTORY_BACKFILL_MAX_ROUNDS = 20;

/**
 * Walks `runBoundedSummaryEvidenceSweep` to completion across up to
 * `maxRounds` rounds, resuming each round from the prior round's
 * `resumeAfterId` (Sol P2.1: startup must actually SCHEDULE the follow-up
 * the returned cursor makes possible, not just log it). `runSweep` is
 * injected — the real caller passes the maintenance coordinator's fenced
 * round; tests pass a fake to exercise the resume/round-cap logic without
 * needing a full boot to genuinely exhaust a real deadline. A `null` round
 * means another startup/periodic owner holds the durable lease, so this walk
 * stops without manufacturing a cursor or overlapping its work. Exported for
 * exactly that reason.
 *
 * `resumeAfterId`, since the fourth-verdict P1.2 fix, means BOTH "resume
 * from the next connection page" AND "resume the SAME still-incomplete
 * page's fold" — `runBoundedSummaryEvidenceSweep` returns the cursor
 * BEFORE an incomplete page when that page's own fold did not converge
 * within its per-page time budget, so this walk transparently resumes an
 * interrupted fold before ever advancing past the connection that owns it,
 * with no separate fold-specific logic needed here. `maxEventsPerFold`,
 * when provided, threads straight through to each round's sweep call as an
 * additional (event-count, not merely time) fold budget.
 *
 * Returns the list of every round's summary, in order, so the caller can
 * log/inspect the whole walk. Never throws for a single round's summary
 * shape — `runSweep` itself may reject, in which case this function lets
 * that rejection propagate (the caller's existing `.catch` handles it,
 * matching the exact prior single-call failure contract).
 */
export async function runStartupSummaryEvidenceSweepToCompletion({
  runSweep,
  maxDurationMs,
  pageSize,
  maxRounds,
  maxEventsPerFold,
  onRound,
}: {
  runSweep: (args: {
    maxDurationMs?: number;
    pageSize?: number;
    afterId?: string | null;
    maxEventsPerFold?: number;
  }) => Promise<SweepSummary | null>;
  maxDurationMs?: number;
  pageSize?: number;
  maxRounds?: number;
  maxEventsPerFold?: number;
  onRound?: ((summary: SweepSummary, round: number) => void) | null;
}) {
  // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
  const rounds = [];
  // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
  let afterId = null;
  let round = 0;
  for (;;) {
    round += 1;
    // eslint-disable-next-line no-await-in-loop
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    const summary = await runSweep({
      ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
      ...(pageSize === undefined ? {} : { pageSize }),
      afterId,
      ...(typeof maxEventsPerFold === "number" ? { maxEventsPerFold } : {}),
    });
    if (!summary) {
      return rounds;
    }
    rounds.push(summary);
    if (typeof onRound === "function") {
      onRound(summary, round);
    }
    if (!summary.incomplete) {
      return rounds;
    }
    if (maxRounds !== undefined && round >= maxRounds) {
      return rounds;
    }
    afterId = summary.resumeAfterId ?? null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Heuristic: is this DB path a canonical polyfill-connectors deployment DB?
// Used to decide whether to auto-reconcile persisted manifests on startup.
// The dev script's default
// (`../packages/polyfill-connectors/.pdpp-data/pdpp.sqlite`) is the
// authoritative sentinel; overrides use the explicit opts/env knob.
export function looksLikePolyfillDeploymentDbPath(dbPath: string | null | undefined) {
  if (!dbPath || typeof dbPath !== "string") {
    return false;
  }
  if (dbPath === ":memory:") {
    return false;
  }
  return dbPath.includes("/polyfill-connectors/") && dbPath.endsWith("pdpp.sqlite");
}

export function shouldAutoReconcilePolyfillManifests({
  dbPath,
  storageBackendKind,
}: {
  dbPath?: string | null;
  storageBackendKind?: string;
}) {
  if (storageBackendKind === "postgres") {
    return true;
  }
  return looksLikePolyfillDeploymentDbPath(dbPath);
}

export async function collectValidRegisteredConnectorManifests({
  logger,
  listConnectorIds = listRegisteredConnectorIds,
  loadManifest = getConnectorManifest,
}: {
  logger: LoggerLike;
  listConnectorIds?: () => Promise<string[]>;
  loadManifest?: (connectorId: string) => Promise<ConnectorManifest | null>;
}) {
  const manifests: { connectorId: string; manifest: ConnectorManifest }[] = [];
  const connectorIds = await listConnectorIds();
  for (const connectorId of connectorIds) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const manifest = await loadManifest(connectorId);
      if (manifest) {
        manifests.push({ connectorId, manifest });
      }
    } catch (err) {
      logger.warn({ connectorId, err }, "skipping retrieval startup backfill for connector with invalid manifest");
    }
  }
  return manifests;
}

async function collectRetrievalStartupBackfillManifests({
  nativeManifest,
  logger,
}: {
  nativeManifest?: ConnectorManifest | null;
  logger: LoggerLike;
}) {
  if (nativeManifest) {
    return [nativeManifest];
  }
  const registered = await collectValidRegisteredConnectorManifests({ logger });
  return registered.map(({ manifest }) => manifest);
}

async function runRetrievalStartupBackfill({
  manifests,
  logger,
  signal = null,
}: {
  manifests: ConnectorManifest[];
  logger: LoggerLike;
  signal?: AbortSignal | null;
}) {
  if (manifests.length === 0) {
    return;
  }

  const startedAt = Date.now();
  logger.info({ connectorCount: manifests.length }, "retrieval startup backfill started");

  for (const manifest of manifests) {
    if (signal?.aborted) {
      logger.info({ reason: "shutdown" }, "retrieval startup backfill aborted between connectors");
      return;
    }
    const connectorId = manifest.connector_id;
    try {
      logger.info({ connectorId }, "retrieval startup backfill connector started");
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      await lexicalIndexBackfillForManifest({ log: (msg) => logger.info(msg), manifest: manifest as never, signal });
      const semanticBackend = getSemanticBackend();
      if (semanticBackend?.available()) {
        await semanticIndexBackfillForManifest({ log: (msg) => logger.info(msg), manifest: manifest as never, signal });
      }
      logger.info({ connectorId }, "retrieval startup backfill connector completed");
    } catch (err) {
      // If the abort is the cause, log at info — this is an expected
      // shutdown path, not an operator-visible failure.
      if (signal?.aborted) {
        logger.info({ connectorId, reason: "shutdown" }, "retrieval startup backfill connector aborted");
        return;
      }
      logger.warn({ connectorId, err }, "retrieval startup backfill failed for connector");
    }
  }

  logger.info(
    { connectorCount: manifests.length, duration_ms: Date.now() - startedAt },
    "retrieval startup backfill completed"
  );
}

function scheduleRetrievalStartupBackfill({
  manifests,
  logger,
  signal = null,
}: {
  manifests: ConnectorManifest[];
  logger: LoggerLike;
  signal?: AbortSignal | null;
}) {
  if (manifests.length === 0) {
    return Promise.resolve();
  }

  logger.info({ connectorCount: manifests.length }, "retrieval startup backfill scheduled after AS/RS listen");

  return new Promise((resolve) => setImmediate(resolve))
    .then(() => runRetrievalStartupBackfill({ logger, manifests, signal }))
    .catch((err) => {
      // Abort-driven exits travel through this catch when the loop
      // re-throws an AbortError-like value before reaching the inner
      // try/catch (e.g., between connectors). Treat as a clean shutdown.
      if (signal?.aborted) {
        logger.info({ reason: "shutdown" }, "retrieval startup backfill aborted");
        return;
      }
      logger.warn({ err }, "retrieval startup backfill crashed");
    });
}

function pdppError(
  res: unknown,
  status: number,
  code: string,
  message: string | undefined,
  param: string | null = null,
  extras: Record<string, unknown> | null = null
) {
  const typedRes = res as ResLike;
  const body: { error: PdppErrorBody } = { error: { code, message, type: typeFor(status) } };
  if (param) {
    body.error.param = param;
  }
  if (extras && typeof extras === "object") {
    if (Array.isArray(extras.available_connections)) {
      body.error.available_connections = extras.available_connections;
    }
    if (typeof extras.retry_with === "string") {
      body.error.retry_with = extras.retry_with;
    }
    if (typeof extras.recovery_admission_reason === "string") {
      body.error.recovery_admission_reason = extras.recovery_admission_reason;
    }
    if (typeof extras.next_eligible_at === "string") {
      body.error.next_eligible_at = extras.next_eligible_at;
    }
    if (typeof extras.pending_pressure_gap_count === "number") {
      body.error.pending_pressure_gap_count = extras.pending_pressure_gap_count;
    }
  }
  const resourceMetadataUrl = status === 401 ? getProtectedResourceMetadataUrl(typedRes) : null;
  if (resourceMetadataUrl) {
    body.error.resource_metadata = resourceMetadataUrl;
    body.error.next_step = PROTECTED_RESOURCE_METADATA_NEXT_STEP;
  }
  body.error.request_id = ensureRequestId(typedRes);
  typedRes.status(status).json(body);
}

function rejectUntrustedMetadataHost(
  req: ReqLike,
  res: ResLike,
  explicitUrl: string | null | undefined,
  trustedHosts: string | null | undefined,
  options: Record<string, unknown> = {}
) {
  if (isTrustedMetadataRequestOrigin(req, explicitUrl, trustedHosts, options)) {
    return false;
  }
  pdppError(
    res,
    421,
    "misdirected_request",
    "Host-derived metadata requires a local/private request host or PDPP_TRUSTED_HOSTS allowlist"
  );
  return true;
}

function httpQuotedString(value: unknown) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function resolveTrustedProtectedResourceMetadataUrl(
  req: ReqLike,
  explicitResource: string | null | undefined,
  trustedHosts: string | null | undefined
) {
  if (!isTrustedMetadataRequestOrigin(req, explicitResource, trustedHosts)) {
    return null;
  }
  try {
    return protectedResourceMetadataUrlForResource(resolvePublicUrl(req, explicitResource));
  } catch {
    return null;
  }
}

function getProtectedResourceMetadataUrl(res: ResLike) {
  const metadataUrl = res.locals?.[PROTECTED_RESOURCE_METADATA_URL_LOCAL];
  return typeof metadataUrl === "string" && metadataUrl ? metadataUrl : null;
}

function setProtectedResourceMetadataChallenge(res: ResLike) {
  const metadataUrl = getProtectedResourceMetadataUrl(res);
  if (!metadataUrl) {
    return;
  }
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${httpQuotedString(metadataUrl)}"`);
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashDeviceSecret(value: string) {
  return `sha256:${sha256Hex(value)}`;
}

function generateReferenceSecret(prefix: string, bytes = 24) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

// Canonical local-collector connector_key -> its manifest's filename. Both
// sides are manifest-derived, never hand-listed: LOCAL_COLLECTOR_PROVEN_KEYS
// is every manifest declaring capabilities.proven.local_collector, and
// legacyLocalAliasMap() carries the historical snake_case bundle id those
// manifest files are still named after (`claude_code.json`). The catalog row,
// the connector_instances row, and the record storage target all use the
// canonical key (`claude-code`) so a legacy-alias enroll cannot fork the
// connector type away from its canonical identity.
const REFERENCE_LOCAL_CONNECTOR_MANIFEST_FILENAMES: ReadonlyMap<string, string> = new Map(
  LOCAL_COLLECTOR_PROVEN_KEYS.map((connectorKey) => {
    const legacyAlias = Object.entries(legacyLocalAliasMap()).find(([, canonical]) => canonical === connectorKey)?.[0];
    return [connectorKey, `${legacyAlias ?? connectorKey}.json`];
  })
);

function readReferenceLocalConnectorCatalogManifest(connectorId: string) {
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const entryName = REFERENCE_LOCAL_CONNECTOR_MANIFEST_FILENAMES.get(connectorKey);
  if (!entryName) {
    return null;
  }
  try {
    const raw = readFileSync(
      new URL(`../../packages/polyfill-connectors/manifests/${entryName}`, import.meta.url),
      "utf8"
    );
    const manifest = JSON.parse(raw);
    return {
      ...manifest,
      connector_id: connectorKey,
      // The manifest is the only source of the owner-facing name; there is no
      // RI-side fallback string to disagree with it.
      display_name: manifest.display_name || connectorKey,
    };
  } catch {
    return {
      connector_id: connectorKey,
      display_name: connectorKey,
      streams: [],
    };
  }
}

async function ensureReferenceConnectorCatalogEntry(
  connectorId: string,
  connectorDisplayName: string | null | undefined
) {
  const localCollectorManifest = readReferenceLocalConnectorCatalogManifest(connectorId);
  if (localCollectorManifest) {
    // Persist the catalog row + advance generations, but SKIP retrieval-index
    // backfill. Enroll is a control-plane op; the backfill enters the
    // connector-instance writer-admission fence (withConnectorInstanceWrite →
    // pg_try_advisory_lock) shared with bulk ingest, which starves enrollment.
    // It is also a no-op for a fresh enroll (the new instance has no records to
    // index); real retrieval-index maintenance happens on the ingest write path
    // and on any manifest (re)registration. See
    // decouple-device-enrollment-from-ingest-writer-admission design D1.
    await registerConnector(localCollectorManifest, { backfillRetrievalIndexes: false });
    return;
  }
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const manifest = {
    connector_id: connectorKey,
    ...(connectorKey === connectorId ? {} : { manifest_uri: connectorId }),
    display_name: connectorDisplayName || connectorKey,
    streams: [],
  };
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest)
       VALUES($1, $2::jsonb)
       ON CONFLICT(connector_id) DO NOTHING`,
      [connectorKey, JSON.stringify(manifest)]
    );
    return;
  }
  // Insert the minimal catalog stub only when the connector is not already
  // registered. A real manifest (e.g. a browser-bound connector like amazon
  // registered via POST /connectors) MUST NOT be clobbered by this stub on
  // enroll — otherwise a second enrollment for the same connector type would
  // read a manifest stripped of its runtime bindings. This matches the
  // postgres branch's DO NOTHING semantics. (Without this guard the shared
  // authConnectorsUpsert query DO-UPDATEs the manifest.)
  exec(referenceQueries.authConnectorsInsertIfAbsent, [connectorKey, JSON.stringify(manifest)]);
}

function handleError(res: ResLike, err: ApiError) {
  const code = err.code || "api_error";
  const status = codeToStatus[code] || 500;
  if (err.request_id) {
    res.setHeader("Request-Id", err.request_id);
  }
  if (err.trace_id) {
    setReferenceTraceId(res, err.trace_id);
  }
  const extras: Record<string, unknown> = {};
  if (Array.isArray(err.available_connections)) {
    extras.available_connections = err.available_connections;
  }
  if (typeof err.retry_with === "string") {
    extras.retry_with = err.retry_with;
  }
  Object.assign(extras, recoveryAdmissionExtrasForWire(err));
  pdppError(res, status, code, err.message, err.param || null, extras);
}

function createRequestAbortSignal(req: ReqLike | null | undefined, message: string) {
  const controller = new AbortController();
  const raw = req?.raw;
  const abort = () => {
    if (controller.signal.aborted) {
      return;
    }
    const err = new Error(message) as Error & { code: string };
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    controller.abort(err);
  };
  if (raw && typeof raw.on === "function") {
    raw.on("close", abort);
  }
  return {
    cleanup() {
      if (!raw) {
        return;
      }
      if (typeof raw.off === "function") {
        raw.off("close", abort);
      } else if (typeof raw.removeListener === "function") {
        raw.removeListener("close", abort);
      }
    },
    signal: controller.signal,
  };
}

function oauthError(
  res: ResLike,
  status: number,
  code: string,
  description: string,
  _param?: string | null,
  extras?: Readonly<Record<string, unknown>> | null
) {
  const requestId = ensureRequestId(res);
  res.status(status).json({
    error: code,
    error_description: description,
    request_id: requestId,
    ...(extras ?? {}),
  });
}

function ensureRequestId(res: ResLike) {
  const existing = res.getHeader("Request-Id");
  if (typeof existing === "string" && existing.trim()) {
    return existing.trim();
  }
  const generated = generateSpineId("req");
  res.setHeader("Request-Id", generated);
  return generated;
}

function setReferenceTraceId(res: ResLike, traceId: string | null | undefined) {
  if (traceId) {
    res.setHeader(PDPP_REFERENCE_TRACE_ID_HEADER, traceId);
  }
}

function normalizeFieldListParam(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  const rawValues = Array.isArray(value) ? value : [value];
  const fields = rawValues
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  return fields.length ? fields : null;
}

function validateRequestedQueryFieldParams(
  requestParams: Record<string, unknown>,
  manifestStream: { schema?: { properties?: Record<string, unknown> } } | null | undefined
) {
  if (requestParams.fields !== null && requestParams.fields !== undefined) {
    const normalizedFields = normalizeFieldListParam(requestParams.fields);
    if (!normalizedFields) {
      const err = new Error("fields must be a comma-separated list of field names") as Error & { code: string };
      err.code = "invalid_request";
      throw err;
    }
    requestParams.fields = normalizedFields;
  }

  const allowedFields = new Set(Object.keys(manifestStream?.schema?.properties || {}));
  if (!allowedFields.size) {
    return;
  }

  if (Array.isArray(requestParams.fields)) {
    const unknownFields = (requestParams.fields as string[]).filter((field: string) => !allowedFields.has(field));
    if (unknownFields.length) {
      const err = new Error(`Unknown field: ${unknownFields.join(", ")}`) as Error & { code: string };
      err.code = "unknown_field";
      throw err;
    }
  }

  if (requestParams.filter && typeof requestParams.filter === "object") {
    const unknownFilterFields = Object.keys(requestParams.filter).filter((field: string) => !allowedFields.has(field));
    if (unknownFilterFields.length) {
      const err = new Error(`Unknown field: ${unknownFilterFields.join(", ")}`) as Error & { code: string };
      err.code = "unknown_field";
      throw err;
    }
  }
}

function buildQueryActorContext(tokenInfo: TokenInfo = {}) {
  return {
    actorId: tokenInfo.pdpp_token_kind === "owner" ? tokenInfo.subject_id : tokenInfo.client_id,
    actorType: tokenInfo.pdpp_token_kind === "owner" ? "subject" : "client",
    scenarioId: tokenInfo.scenario_id || undefined,
    traceId: tokenInfo.trace_id || generateSpineId("trc_qry"),
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
function inferAuthGateQueryContext(req: ReqLike, _tokenInfo: TokenInfo = {}) {
  if (req.method !== "GET") {
    return null;
  }

  const segments = String(req.path || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments[0] !== "v1" || segments[1] !== "streams") {
    return null;
  }
  const parsedLimit = typeof req.query?.limit === "string" ? Number.parseInt(req.query.limit, 10) : null;
  const inferredLimit = Number.isFinite(parsedLimit) && (parsedLimit as number) > 0 ? (parsedLimit as number) : null;
  const hasChangesSince = typeof req.query?.changes_since === "string" && req.query.changes_since.length > 0;

  if (segments.length === 2) {
    return { queryShape: "stream_list", streamId: null };
  }
  if (segments.length === 3) {
    return { queryShape: "stream_metadata", streamId: segments[2] };
  }
  if (segments.length === 4 && segments[3] === "aggregate") {
    return {
      field: typeof req.query?.field === "string" ? req.query.field : null,
      groupBy: typeof req.query?.group_by === "string" ? req.query.group_by : null,
      metric: typeof req.query?.metric === "string" ? req.query.metric : null,
      queryShape: "stream_aggregate",
      streamId: segments[2],
    };
  }
  if (segments.length === 4 && segments[3] === "records") {
    return {
      hasChangesSince,
      limit: inferredLimit,
      queryShape: "record_list",
      requestedRecordId: null,
      streamId: segments[2],
    };
  }
  if (segments.length === 5 && segments[3] === "records") {
    return { queryShape: "record_detail", requestedRecordId: segments[4], streamId: segments[2] };
  }

  return null;
}

async function emitQueryRejected(context: QueryContext, req: ReqLike, err: ApiError) {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!context?.queryId) {
    return;
  }
  const code = err.code || "api_error";
  const status = codeToStatus[code] || 500;
  const data: Record<string, unknown> = {
    ...(context.queryData || {}),
    error: {
      code,
      http_status: status,
      message: err.message,
    },
  };
  if (Object.hasOwn(context, "sourceDescriptor")) {
    data.source = context.sourceDescriptor ?? null;
  }
  const authHeader = req.headers?.authorization;
  const tokenId = typeof authHeader === "string" ? authHeader.slice(7) : null;
  await emitSpineEvent({
    actor_id: context.actorId ?? null,
    actor_type: context.actorType ?? null,
    client_id: context.tokenInfo?.client_id ?? null,
    data,
    event_type: "query.rejected",
    grant_id: context.tokenInfo?.grant_id ?? null,
    object_id: context.queryId ?? null,
    object_type: "query",
    scenario_id: context.scenarioId ?? null,
    status: "failed",
    stream_id: context.streamId ?? null,
    subject_id: context.tokenInfo?.subject_id ?? null,
    subject_type: "subject",
    token_id: tokenId,
    trace_id: context.traceId ?? null,
  });
}

async function emitQueryReceived(context: QueryContext, req: ReqLike) {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!context?.queryId) {
    return;
  }
  if (context.receivedEmitted) {
    return;
  }
  context.receivedEmitted = true;

  const data: Record<string, unknown> = { ...(context.queryData || {}) };
  if (Object.hasOwn(context, "sourceDescriptor")) {
    data.source = context.sourceDescriptor ?? null;
  }
  const authHeader = req.headers?.authorization;
  const tokenId = typeof authHeader === "string" ? authHeader.slice(7) : null;
  await emitSpineEvent({
    actor_id: context.actorId ?? null,
    actor_type: context.actorType ?? null,
    client_id: context.tokenInfo?.client_id ?? null,
    data,
    event_type: "query.received",
    grant_id: context.tokenInfo?.grant_id ?? null,
    object_id: context.queryId ?? null,
    object_type: "query",
    scenario_id: context.scenarioId ?? null,
    status: "started",
    stream_id: context.streamId ?? null,
    subject_id: context.tokenInfo?.subject_id ?? null,
    subject_type: "subject",
    token_id: tokenId,
    trace_id: context.traceId ?? null,
  });
}

async function rejectQuery(
  res: ResLike,
  req: ReqLike,
  context: QueryContext,
  err: ApiError,
  param: string | null = null
) {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (context?.traceId) {
    setReferenceTraceId(res, context.traceId);
  }
  await emitQueryRejected(context, req, err);
  const code = err.code || "api_error";
  const status = codeToStatus[code] || 500;
  const extras: Record<string, unknown> = {};
  if (Array.isArray(err.available_connections)) {
    extras.available_connections = err.available_connections;
  }
  if (typeof err.retry_with === "string") {
    extras.retry_with = err.retry_with;
  }
  return pdppError(res, status, code, err.message, param || err.param || null, extras);
}

function buildStateContext(
  req: ReqLike,
  res: ResLike,
  {
    connectorId = null as string | null,
    grantId = null as string | null,
    traceId = null as string | null,
    scenarioId = null as string | null,
    operation = null as string | null,
    requestedStreams = null as string[] | null,
  } = {}
): StateContext {
  const requestId = ensureRequestId(res);
  return {
    actorId: req.tokenInfo?.subject_id || null,
    actorType: "subject",
    connectorId,
    grantId,
    operation,
    requestedEmitted: false,
    requestedStreams,
    requestId,
    scenarioId: scenarioId || null,
    sourceDescriptor: connectorId ? buildSourceDescriptor({ id: connectorId, kind: "connector" }) : null,
    traceId: traceId || generateSpineId("trc_state"),
  };
}

async function emitStateEvent(
  req: ReqLike,
  context: StateContext,
  eventType: string,
  status: string,
  data: Record<string, unknown> = {}
) {
  const authHeader = req.headers?.authorization;
  const tokenId = typeof authHeader === "string" ? authHeader.slice(7) : null;
  await emitSpineEvent({
    actor_id: context.actorId ?? null,
    actor_type: context.actorType ?? null,
    data: {
      ...(context.sourceDescriptor ? { source: context.sourceDescriptor } : {}),
      operation: context.operation,
      state_scope: context.grantId ? "grant" : "owner",
      ...(Array.isArray(context.requestedStreams) ? { requested_streams: context.requestedStreams } : {}),
      ...data,
    },
    event_type: eventType,
    grant_id: context.grantId ?? null,
    object_id: context.requestId ?? null,
    object_type: "state_request",
    scenario_id: context.scenarioId ?? null,
    status,
    subject_id: req.tokenInfo?.subject_id ?? null,
    subject_type: "subject",
    token_id: tokenId,
    trace_id: context.traceId ?? null,
  });
}

async function emitStateRequested(req: ReqLike, context: StateContext) {
  if (context.requestedEmitted) {
    return;
  }
  context.requestedEmitted = true;
  await emitStateEvent(req, context, "state.requested", "started");
}

async function rejectState(res: ResLike, req: ReqLike, context: StateContext, err: ApiError) {
  if (err.trace_id) {
    context.traceId = String(err.trace_id);
  }
  if (err.scenario_id) {
    context.scenarioId = String(err.scenario_id);
  }
  setReferenceTraceId(res, context.traceId);
  await emitStateRequested(req, context);
  const code = err.code || "api_error";
  const status = codeToStatus[code] || 500;
  await emitStateEvent(req, context, "state.rejected", "failed", {
    error: {
      code,
      http_status: status,
      message: err.message,
    },
  });
  return pdppError(res, status, code, err.message);
}

function buildMutationContext(
  req: ReqLike,
  res: ResLike,
  {
    connectorId = null as string | null,
    operation = null as string | null,
    streamId = null as string | null,
    requestedRecordId = null as string | null,
    submittedRecordCount = null as number | null,
    traceId = null as string | null,
    scenarioId = null as string | null,
  } = {}
): MutationContext {
  const requestId = ensureRequestId(res);
  return {
    actorId: req.tokenInfo?.subject_id || null,
    actorType: "subject",
    connectorId,
    operation,
    requestedEmitted: false,
    requestedRecordId,
    requestId,
    scenarioId: scenarioId || null,
    sourceDescriptor: connectorId ? buildSourceDescriptor({ id: connectorId, kind: "connector" }) : null,
    streamId,
    submittedRecordCount,
    traceId: traceId || generateSpineId("trc_mut"),
  };
}

async function emitMutationEvent(
  req: ReqLike,
  context: MutationContext,
  eventType: string,
  status: string,
  data: Record<string, unknown> = {}
) {
  const authHeader = req.headers?.authorization;
  const tokenId = typeof authHeader === "string" ? authHeader.slice(7) : null;
  await emitSpineEvent({
    actor_id: context.actorId ?? null,
    actor_type: context.actorType ?? null,
    data: {
      operation: context.operation,
      source: context.sourceDescriptor ?? null,
      ...(context.requestedRecordId ? { requested_record_id: context.requestedRecordId } : {}),
      ...(typeof context.submittedRecordCount === "number"
        ? { submitted_record_count: context.submittedRecordCount }
        : {}),
      ...data,
    },
    event_type: eventType,
    object_id: context.requestId ?? null,
    object_type: "mutation_request",
    scenario_id: context.scenarioId ?? null,
    status,
    stream_id: context.streamId ?? null,
    subject_id: req.tokenInfo?.subject_id ?? null,
    subject_type: "subject",
    token_id: tokenId,
    trace_id: context.traceId ?? null,
  });
}

async function emitMutationRequested(req: ReqLike, context: MutationContext) {
  if (context.requestedEmitted) {
    return;
  }
  context.requestedEmitted = true;
  await emitMutationEvent(req, context, "mutation.requested", "started");
}

async function rejectMutation(res: ResLike, req: ReqLike, context: MutationContext, err: ApiError) {
  if (err.trace_id) {
    context.traceId = String(err.trace_id);
  }
  if (err.scenario_id) {
    context.scenarioId = String(err.scenario_id);
  }
  setReferenceTraceId(res, context.traceId);
  await emitMutationRequested(req, context);
  const code = err.code || "api_error";
  const status = codeToStatus[code] || 500;
  await emitMutationEvent(req, context, "mutation.rejected", "failed", {
    error: {
      code,
      http_status: status,
      message: err.message,
    },
  });
  return pdppError(res, status, code, err.message);
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
async function requireTokenWithIntrospection(
  req: ReqLike,
  res: ResLike,
  next: () => void,
  introspectToken: (token: string) => Promise<TokenInfo>
) {
  const auth = req.headers?.authorization;
  if (!auth || typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    setProtectedResourceMetadataChallenge(res);
    return pdppError(res, 401, "authentication_error", "Missing Bearer token");
  }
  const token = auth.slice(7);
  const info = await introspectToken(token);
  if (info.active && info.pdpp_token_kind === "client" && req.params?.stream) {
    const requestedConnection = resolveRequestConnectionId(req.query ?? {}).connectionId;
    try {
      enforceSourceReadRequest(info, {
        ...(requestedConnection ? { instance_id: requestedConnection } : {}),
        stream: req.params.stream,
      });
    } catch (error: unknown) {
      if (error instanceof SourceIntrospectionContextError) {
        info.active = false;
        info.inactive_reason = error.code;
      } else {
        throw error;
      }
    }
  }
  if (!info.active) {
    if (info.trace_id) {
      setReferenceTraceId(res, info.trace_id);
    }
    const authGateQuery = inferAuthGateQueryContext(req, info);
    if (authGateQuery && info.trace_id) {
      const authGateContext: QueryContext = {
        actorId: info.client_id ?? null,
        actorType: "client",
        queryData: {
          auth_gate: true,
          query_shape: authGateQuery.queryShape,
          ...(authGateQuery.queryShape === "record_list"
            ? {
                // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
                has_changes_since: authGateQuery.hasChangesSince ?? false,
                limit: authGateQuery.limit ?? null,
              }
            : {}),
          ...(authGateQuery.requestedRecordId ? { requested_record_id: authGateQuery.requestedRecordId } : {}),
        },
        queryId: ensureRequestId(res),
        scenarioId: info.scenario_id ?? null,
        streamId: authGateQuery.streamId ?? null,
        tokenInfo: info,
        traceId: info.trace_id ?? null,
      };
      await emitQueryReceived(authGateContext, req);
      const gateErrMsg =
        info.inactive_reason === "grant_revoked"
          ? "Grant has been revoked"
          : // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
            info.inactive_reason === "grant_expired"
            ? "Grant has expired"
            : // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
              info.inactive_reason === "grant_invalid"
              ? "Grant is malformed or no longer valid"
              : "Invalid or expired token";
      const gateErr = Object.assign(new Error(gateErrMsg), {
        code: info.inactive_reason || "authentication_error",
      }) as ApiError;
      await emitQueryRejected(authGateContext, req, gateErr);
    }
    if (info.inactive_reason === "grant_revoked") {
      return pdppError(res, 403, "grant_revoked", "Grant has been revoked");
    }
    if (info.inactive_reason === "grant_expired") {
      return pdppError(res, 403, "grant_expired", "Grant has expired");
    }
    if (info.inactive_reason === "grant_invalid") {
      return pdppError(res, 403, "grant_invalid", "Grant is malformed or no longer valid");
    }
    if (info.inactive_reason?.startsWith("context.")) {
      setProtectedResourceMetadataChallenge(res);
      return pdppError(res, 401, info.inactive_reason, "Token introspection failed closed");
    }
    if (info.inactive_reason === "authorization_state.unsupported_legacy_shape") {
      setProtectedResourceMetadataChallenge(res);
      return pdppError(res, 401, info.inactive_reason, "Fresh consent is required");
    }
    setProtectedResourceMetadataChallenge(res);
    return pdppError(res, 401, "authentication_error", "Invalid or expired token");
  }
  req.tokenInfo = info;
  next();
}

function requireOwner(req: ReqLike, res: ResLike, next: () => void) {
  if (req.tokenInfo?.pdpp_token_kind !== "owner") {
    return pdppError(res, 403, "permission_error", "Owner token required");
  }
  next();
}

function requireClient(req: ReqLike, res: ResLike, next: () => void) {
  if (req.tokenInfo?.pdpp_token_kind !== "client") {
    return pdppError(res, 403, "permission_error", "Client token required");
  }
  next();
}

// Accept either a per-grant client token (the normal RS token) or a
// hosted-MCP grant-package token. The package token is only meaningful at
// `/mcp`; every other resource-server route stays gated by `requireClient`
// so package tokens cannot reach REST surfaces. Owner tokens are always
// rejected — there is no owner-mode MCP.
function requireClientOrMcpPackage(req: ReqLike, res: ResLike, next: () => void) {
  const kind = req.tokenInfo?.pdpp_token_kind;
  if (kind !== "client" && kind !== "mcp_package") {
    return pdppError(
      res,
      403,
      "permission_error",
      "MCP requires a grant-scoped client or MCP package token. Owner-agent bearers are REST/control-plane credentials; use owner-agent REST onboarding for local owner automation."
    );
  }
  next();
}

function resolveNativeStorageBinding(opts: ServerOpts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  const storageBinding = nativeManifest
    ? (nativeManifest.storage_binding as Record<string, unknown> | null | undefined)
    : null;
  const connectorId = storageBinding?.connector_id as string | undefined;
  if (!connectorId) {
    return null;
  }
  return { connector_id: connectorId };
}

function resolveSingleConnectorIdQueryValue(rawConnectorId: unknown) {
  if (typeof rawConnectorId !== "string") {
    return null;
  }
  const trimmed = rawConnectorId.trim();
  return trimmed || null;
}

function getOwnerTokenSubjectId(req: ReqLike) {
  return req.tokenInfo?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID;
}

function createRequestConnectorInstanceStore() {
  return isPostgresStorageBackend() ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
}

function createRequestConnectorInstanceCredentialStore() {
  return isPostgresStorageBackend()
    ? createPostgresConnectorInstanceCredentialStore()
    : createSqliteConnectorInstanceCredentialStore();
}

function createRequestAcquisitionBatchStore() {
  return isPostgresStorageBackend() ? createPostgresAcquisitionBatchStore() : createSqliteAcquisitionBatchStore();
}

function createRequestProviderAppConfigStore() {
  return isPostgresStorageBackend() ? createPostgresProviderAppConfigStore() : createSqliteProviderAppConfigStore();
}

function createRequestManualUploadArtifactStore() {
  return isPostgresStorageBackend()
    ? createPostgresManualUploadArtifactStore()
    : createSqliteManualUploadArtifactStore();
}

function createRequestRecordRejectionStore() {
  return createRecordRejectionStore();
}

// Lazily loads the pure static-secret injection helpers from the
// polyfill-connectors runner slice. The reference server reaches connector
// code by relative path (it does not declare the package as a dependency), so
// this mirrors the controller's `await import("../../packages/...")` idiom and
// caches the resolved module after the first run.
let staticSecretInjectionModulePromise: Promise<Record<string, unknown>> | null = null;
function loadStaticSecretInjectionHelpers() {
  if (!staticSecretInjectionModulePromise) {
    staticSecretInjectionModulePromise = import("../../packages/polyfill-connectors/src/static-secret-injection.ts");
  }
  return staticSecretInjectionModulePromise;
}

// Build the route-facing static-secret credential prober. The reference-only
// probe seam lives in the connector package: the pure orchestration
// (`probeCredential`, `hasCredentialProbe`) and the live transport factory,
// which owns the provider dependency (imapflow / GitHub fetch). The server
// adapter turns a thrown probe error into the route's non-throwing typed
// result. This is NOT a Collection Profile message and is never exposed to /mcp
// or grant-scoped reads. Resolved once at startup and injected, so the route
// stays synchronous and tests inject a deterministic double instead.
async function buildStaticSecretCredentialProber() {
  const [probe, transport, adapter] = await Promise.all([
    import("../../packages/polyfill-connectors/src/credential-probe.ts"),
    import("../../packages/polyfill-connectors/src/credential-probe-transport.ts"),
    import("./stores/static-secret-credential-probe.ts"),
  ]);
  return (adapter.createStaticSecretCredentialProber as unknown as (args: Record<string, unknown>) => unknown)({
    createLiveCredentialProbeTransport: transport.createLiveCredentialProbeTransport,
    hasCredentialProbe: probe.hasCredentialProbe,
    probeCredential: probe.probeCredential,
  });
}

// Builds the controller's connection-scoped static-secret resolver (design
// Decision 5). For a static-secret connector that HAS an active stored
// credential, it returns the env fragment carrying only that connection's
// secret; the run then authenticates with that explicit per-connection
// capability. It returns `null` for non-static-secret connectors, for
// browser-session source bindings that have no optional stored login
// credential, AND for any connector whose manifest declares
// `credential_capture.required: false` regardless of how this particular
// connection's `sourceBinding.kind` happens to be set — see
// `resolveStaticSecretRunEnv`'s doc. A missing/revoked/deleted credential on a
// true REQUIRED static-secret connection still fails closed: the run seam
// throws and the run is refused before any child can use an undeclared
// provider-account secret.
//
// `isStaticSecretCaptureOptional` is load-bearing and must be passed. This
// function is the resolver the LIVE server actually installs (both the
// controller path for manual runs and the scheduler path for automatic ones);
// `server/connection-scoped-run-env.ts` holds a second, structurally identical
// implementation used by `scheduler-manager-factory.ts` and the test suite.
// The two drifted: the leaf module passed this argument and this copy did not,
// so on the live path a `captureRequired: false` connector (venmo) whose
// connection was bound as anything other than a browser session — e.g. an
// unpromoted `browser_enrollment_shell`, or a `historical_archive` — hit
// `recoverSecret`'s throw instead of the intended `null`, and the run was
// refused rather than proceeding to the connector's own manual sign-in
// fallback. `connection-scoped-run-env-parity.test.ts` now pins the two
// implementations to the same argument set so this cannot drift again silently.
function buildControllerStaticSecretRunEnvResolver() {
  return async ({
    connectorId,
    connectorInstanceId,
    ownerSubjectId,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId: string;
  }) => {
    const { isStaticSecretCaptureOptional, isStaticSecretConnector, buildConnectionScopedSecretEnv } =
      (await loadStaticSecretInjectionHelpers()) as {
        isStaticSecretCaptureOptional: (id: string) => boolean;
        isStaticSecretConnector: (id: string) => boolean;
        buildConnectionScopedSecretEnv: (...args: unknown[]) => unknown;
      };
    if (!isStaticSecretConnector(connectorId)) {
      return null;
    }
    const credentialStore = createRequestConnectorInstanceCredentialStore();
    const connectorInstance = await createRequestConnectorInstanceStore().get(connectorInstanceId);
    return await (resolveStaticSecretRunEnv as (args: Record<string, unknown>) => Promise<unknown>)({
      buildConnectionScopedSecretEnv,
      connectorId,
      connectorInstanceId,
      credentialStore,
      isStaticSecretCaptureOptional,
      isStaticSecretConnector,
      ownerSubjectId,
      sourceBinding: connectorInstance?.sourceBinding ?? null,
    });
  };
}

function buildControllerStaticSecretCredentialRejectionMarker() {
  return async ({
    connectorInstanceId,
    reason,
    rejectedAt,
  }: {
    connectorInstanceId: string;
    reason: string | null;
    rejectedAt: string;
    [k: string]: unknown;
  }) => {
    const credentialStore = createRequestConnectorInstanceCredentialStore();
    await credentialStore.markRejected({
      connectorInstanceId,
      reason,
      rejectedAt,
    });
  };
}

function buildControllerManualUploadRunEnvResolver() {
  return async ({ connectorInstanceId }: { connectorInstanceId: string }) => {
    const instance = await createRequestConnectorInstanceStore().get(connectorInstanceId);
    const binding = instance?.sourceBinding as Record<string, unknown> | null | undefined;
    if (
      !binding ||
      typeof binding !== "object" ||
      (binding.kind !== "manual_upload_draft" && binding.kind !== "manual_upload") ||
      typeof binding.import_dir !== "string" ||
      typeof binding.import_dir_env_var !== "string"
    ) {
      return null;
    }
    return { [binding.import_dir_env_var as string]: binding.import_dir as string };
  };
}

/**
 * Every registered manifest, keyed by canonical connector key. Shared by
 * both the identity-group resolvers below and mirrors
 * `collectConnectorTemplates`'s (owner-connector-templates.ts) enumerate-
 * then-tolerate-invalid-manifests pattern: one connector's malformed
 * manifest must not hide every other connector's provider-app config group.
 */
async function collectRegisteredManifestsByConnectorKey(): Promise<Map<string, ConnectorManifest>> {
  const byConnectorKey = new Map<string, ConnectorManifest>();
  for (const connectorId of await listRegisteredConnectorIds()) {
    const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const manifest = await getConnectorManifest(connectorKey);
      if (manifest) {
        byConnectorKey.set(connectorKey, manifest as unknown as ConnectorManifest);
      }
    } catch {
      // A malformed registered manifest should not hide every other
      // connector's provider-app config group.
    }
  }
  return byConnectorKey;
}

function providerIdentityGroupDescriptorFromManifests(
  identityGroup: string,
  manifests: readonly ConnectorManifest[]
): ProviderIdentityGroupDescriptor {
  const fieldsByLogicalKey = new Map<string, ProviderIdentityGroupDescriptor["fields"][number]>();
  let providerIdentityLabel: string | null = null;
  for (const manifest of manifests) {
    const auth = (manifest as unknown as { capabilities?: { auth?: Record<string, unknown> | null } }).capabilities
      ?.auth;
    if (!providerIdentityLabel && typeof auth?.provider_identity_label === "string") {
      providerIdentityLabel = auth.provider_identity_label.trim() || null;
    }
    for (const entry of connectionConfigDeploymentFieldsFromManifest(manifest)) {
      if (!fieldsByLogicalKey.has(entry.logicalKey)) {
        fieldsByLogicalKey.set(entry.logicalKey, entry);
      }
    }
  }
  return {
    fields: Array.from(fieldsByLogicalKey.values()),
    identityGroup,
    providerIdentityLabel,
  };
}

/** `deployment_config` normalized to the route's field shape, reusing
 * connection-setup-plan.ts's manifest-shape acceptance (bare string, legacy
 * `{key,...}`, or current `{logical_key,...}`) so this never re-derives its
 * own parsing of the same manifest data. */
function connectionConfigDeploymentFieldsFromManifest(
  manifest: ConnectorManifest
): readonly { envAlias: string | null; label: string; logicalKey: string; secret: boolean }[] {
  const declared = (manifest as unknown as { capabilities?: { auth?: { deployment_config?: unknown } | null } })
    .capabilities?.auth?.deployment_config;
  if (!Array.isArray(declared)) {
    return [];
  }
  const out: { envAlias: string | null; label: string; logicalKey: string; secret: boolean }[] = [];
  for (const entry of declared) {
    if (typeof entry === "string") {
      if (entry.trim()) {
        out.push({ envAlias: null, label: entry.trim(), logicalKey: entry.trim(), secret: false });
      }
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const logicalKey =
      typeof record.logical_key === "string" && record.logical_key.trim()
        ? record.logical_key.trim()
        : typeof record.key === "string" && record.key.trim()
          ? record.key.trim()
          : null;
    if (!logicalKey) {
      continue;
    }
    out.push({
      envAlias: typeof record.env_alias === "string" && record.env_alias.trim() ? record.env_alias.trim() : null,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : logicalKey,
      logicalKey,
      secret: record.secret === true,
    });
  }
  return out;
}

function manifestProviderIdentityGroup(manifest: ConnectorManifest): string | null {
  const raw = (manifest as unknown as { capabilities?: { auth?: { provider_identity_group?: unknown } | null } })
    .capabilities?.auth?.provider_identity_group;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Resolves every manifest sharing the given `provider_identity_group` into
 * one descriptor (union of declared `deployment_config` fields, first
 * non-empty `provider_identity_label` wins). Absent/unknown group -> null.
 * This is the ONLY place the RI groups connectors by identity_group — the
 * route itself carries no connector/provider-specific knowledge, per
 * ref-provider-app-config.ts's own contract.
 */
async function resolveProviderIdentityGroup(identityGroup: string): Promise<ProviderIdentityGroupDescriptor | null> {
  const manifests = Array.from((await collectRegisteredManifestsByConnectorKey()).values()).filter(
    (manifest) => manifestProviderIdentityGroup(manifest) === identityGroup
  );
  return manifests.length > 0 ? providerIdentityGroupDescriptorFromManifests(identityGroup, manifests) : null;
}

/** Every distinct `provider_identity_group` any registered manifest
 * declares, each already resolved to its descriptor. */
async function listProviderIdentityGroups(): Promise<readonly ProviderIdentityGroupDescriptor[]> {
  const manifestsByGroup = new Map<string, ConnectorManifest[]>();
  for (const manifest of (await collectRegisteredManifestsByConnectorKey()).values()) {
    const group = manifestProviderIdentityGroup(manifest);
    if (!group) {
      continue;
    }
    const existing = manifestsByGroup.get(group);
    if (existing) {
      existing.push(manifest);
    } else {
      manifestsByGroup.set(group, [manifest]);
    }
  }
  return Array.from(manifestsByGroup.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identityGroup, manifests]) => providerIdentityGroupDescriptorFromManifests(identityGroup, manifests));
}

/**
 * Builds the one generic, manifest-driven `ProviderAuthExchanger` every
 * OAuth connector routes through — replaces the retired per-provider
 * exchangers (google-data-portability.ts, google-oauth-account.ts). Never
 * returns null: readiness is decided per-connector by
 * connection-setup-plan.ts's deployment-readiness check (manifest
 * deployment_config against env + the provider-app-config store), not by
 * whether ANY provider happens to be configured at process start.
 */
function buildGenericProviderAuthExchanger(
  credentialStoreFactory: () => ReturnType<typeof createRequestConnectorInstanceCredentialStore>
): ProviderAuthExchanger {
  const deploymentConfigResolver = createDeploymentConfigResolver({ store: createRequestProviderAppConfigStore() });
  return createGenericProviderAuthDispatch({
    credentialStoreFactory,
    deploymentConfigResolver,
    resolveManifest: async (connectorId: string) =>
      (await getConnectorManifest(connectorId)) as unknown as ProviderAuthManifestLike | null,
  });
}

/**
 * Resolves a manifest's declared deployment_config entries against the SAME
 * DB-first, env-fallback resolver the real OAuth exchange uses
 * (createDeploymentConfigResolver), merged OVER process.env (never
 * replacing it — a manifest with no provider_identity_group, or a
 * deployment_config entry neither the store nor the resolver's env fallback
 * has anything for, must still read from the real process environment
 * exactly as it did before this resolver existed). Keyed the way
 * connection-setup-plan.ts's buildDeploymentReadiness reads it
 * (`env[entry.envAlias ?? entry.logicalKey]`). Used only for the initiate
 * route's readiness check, so a Console-configured provider-app-config store
 * value satisfies deployment readiness exactly as it will win at
 * token-exchange time — DB overrides env, not the other way around, so this
 * resolver must always consult the store even when the env var is already
 * set.
 */
async function resolveProviderAuthDeploymentEnv(
  manifest: unknown
): Promise<Readonly<Record<string, string | undefined>>> {
  const env: Record<string, string | undefined> = { ...process.env };
  const identityGroup = manifestProviderIdentityGroup(manifest as ConnectorManifest);
  if (!identityGroup) {
    return env;
  }
  const entries = connectionConfigDeploymentFieldsFromManifest(manifest as ConnectorManifest);
  if (entries.length === 0) {
    return env;
  }
  const resolver = createDeploymentConfigResolver({ store: createRequestProviderAppConfigStore() });
  await Promise.all(
    entries.map(async (entry) => {
      const key = entry.envAlias ?? entry.logicalKey;
      const value = await resolver({ envAlias: entry.envAlias, identityGroup, logicalKey: entry.logicalKey });
      if (value) {
        env[key] = value;
      }
    })
  );
  return env;
}

function buildControllerProviderAuthRunEnvResolver() {
  return async ({
    connectorId,
    connectorInstanceId,
    ownerSubjectId,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId: string;
  }) => {
    const [connectorInstance, manifest] = await Promise.all([
      createRequestConnectorInstanceStore().get(connectorInstanceId),
      resolveRegisteredConnectorManifest(connectorId).catch(() => null),
    ]);
    const connectionConfig = connectionConfigEntriesFromManifest(
      manifest as unknown as Parameters<typeof connectionConfigEntriesFromManifest>[0]
    );
    return resolveProviderAuthRunEnv({
      connectionConfig,
      connectorId,
      connectorInstanceId,
      credentialStore: createRequestConnectorInstanceCredentialStore(),
      legacyBundleFieldAliases:
        (manifest as { capabilities?: { auth?: { legacy_bundle_field_aliases?: Record<string, string> | null } } })
          ?.capabilities?.auth?.legacy_bundle_field_aliases ?? null,
      ownerSubjectId,
      sourceBinding: connectorInstance?.sourceBinding ?? null,
    });
  };
}

function buildConnectionScopedRunEnvResolver() {
  const staticSecretResolver = buildControllerStaticSecretRunEnvResolver();
  const providerAuthResolver = buildControllerProviderAuthRunEnvResolver();
  const manualUploadResolver = buildControllerManualUploadRunEnvResolver();
  return async (args: { connectorId: string; connectorInstanceId: string; ownerSubjectId: string }) => {
    const staticSecretEnv = await staticSecretResolver(args);
    if (staticSecretEnv !== null) {
      return staticSecretEnv;
    }
    const providerAuthEnv = await providerAuthResolver(args);
    if (providerAuthEnv !== null) {
      return providerAuthEnv;
    }
    return manualUploadResolver(args);
  };
}

// biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
async function resolveOwnerConnectorNamespace(
  req: ReqLike,
  connectorId: string | null,
  options: {
    connectorInstanceId?: string | null;
    ownerSubjectId?: string | null;
    allowDefaultAccount?: boolean;
    allowStatuses?: string[];
    displayName?: string | null;
    now?: string;
  } = {}
) {
  const explicitConnectorInstanceId =
    resolveSingleConnectorIdQueryValue(options.connectorInstanceId) ||
    resolveSingleConnectorIdQueryValue(req.query?.connector_instance_id);
  const ownerSubjectId = options.ownerSubjectId || getOwnerTokenSubjectId(req);
  // Connectors are stored under canonical short keys (registerConnector calls
  // normalizeConnectorManifestForStorage which maps URL-form connector ids like
  // 'https://registry.pdpp.dev/connectors/spotify' to 'spotify'). Callers may
  // supply either form, so normalise here before the instance-store lookup to
  // prevent FK mismatches on ensureDefaultAccountConnection.
  const canonicalId = (connectorId && canonicalConnectorKey(connectorId)) ?? connectorId;
  return resolveOwnerConnectorInstanceNamespace({
    allowDefaultAccount: options.allowDefaultAccount ?? true,
    connectorId: canonicalId,
    connectorInstanceId: explicitConnectorInstanceId,
    connectorInstanceStore: createRequestConnectorInstanceStore(),
    ownerSubjectId,
    // Only the owner-session capture path and the owner-authenticated
    // first-ingest path pass `['active','draft']` to reach a static-secret
    // draft. Every other caller inherits the active-only default.
    ...(options.allowStatuses ? { allowStatuses: options.allowStatuses } : {}),
    displayName: options.displayName ?? connectorId,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function storageTargetForConnectorNamespace(namespace: {
  connectorId: string;
  connectorInstanceId: string;
}): StorageBinding {
  return {
    connector_id: namespace.connectorId,
    connector_instance_id: namespace.connectorInstanceId,
  };
}

function toPublicConnectorStateProjection(state: Record<string, unknown> | null | undefined) {
  if (!state || typeof state !== "object") {
    return state;
  }
  return {
    connector_id: state.connector_id,
    grant_id: state.grant_id,
    object: state.object,
    state: state.state,
    updated_at: state.updated_at,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function structuredSourceWebhookEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  return Object.entries(parsed as Record<string, unknown>).map(([sourceId, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { source_id: sourceId, ...(value as Record<string, unknown>) };
    }
    return { secret: value, source_id: sourceId };
  });
}

function parseStructuredSourceWebhookSecrets(raw: string) {
  const parsed: unknown = JSON.parse(raw);
  const map = new Map();
  for (const entry of structuredSourceWebhookEntries(parsed)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const sourceId = stringValue(record.source_id) ?? stringValue(record.sourceId);
    const secret = stringValue(record.secret);
    const connectorId = stringValue(record.connector_id) ?? stringValue(record.connectorId) ?? sourceId;
    const ownerSubjectId = stringValue(record.owner_subject_id) ?? stringValue(record.ownerSubjectId);
    const connectorInstanceId = stringValue(record.connector_instance_id) ?? stringValue(record.connectorInstanceId);
    if (sourceId && secret && connectorId) {
      map.set(sourceId, {
        connectorId,
        ...(connectorInstanceId ? { connectorInstanceId } : {}),
        ...(ownerSubjectId ? { ownerSubjectId } : {}),
        secret,
      });
    }
  }
  return map;
}

function parseSourceWebhookSecrets(raw = process.env.PDPP_SOURCE_WEBHOOK_SECRETS || "") {
  const trimmedRaw = raw.trim();
  if (trimmedRaw.startsWith("{") || trimmedRaw.startsWith("[")) {
    return parseStructuredSourceWebhookSecrets(trimmedRaw);
  }
  const map = new Map();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const secondSeparator = trimmed.indexOf(":", separator + 1);
    const sourceId = trimmed.slice(0, separator).trim();
    const secret =
      secondSeparator === -1 ? trimmed.slice(separator + 1) : trimmed.slice(separator + 1, secondSeparator);
    const connectorId = secondSeparator === -1 ? sourceId : trimmed.slice(secondSeparator + 1);
    if (sourceId && secret) {
      map.set(sourceId, { connectorId, secret });
    }
  }
  return map;
}

function sourceWebhookResolutionError(err: unknown) {
  let code = "invalid_source_target";
  if (err instanceof ConnectorInstanceResolutionError && err.code === "ambiguous_connector_instance") {
    code = "ambiguous_source_target";
  }
  const message = err instanceof Error ? err.message : "source webhook target is not writable";
  const status =
    err instanceof ConnectorInstanceResolutionError && err.code === "ambiguous_connector_instance" ? 409 : 404;
  return new SourceWebhookError(code, message, status);
}

async function resolveOwnerReadScope(req: ReqLike, opts: ServerOpts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  const nativeStorageBinding = resolveNativeStorageBinding(opts);
  if (nativeManifest && nativeStorageBinding) {
    const configuredSource = buildSourceDescriptor(
      (nativeManifest.source_declaration as { source?: { id?: string; kind?: string } } | undefined)?.source ?? null
    );
    if (!configuredSource) {
      throw Object.assign(new Error("Configured SourceDeclaration source is missing"), { code: "invalid_request" });
    }
    return {
      owner_subject_id: getOwnerTokenSubjectId(req),
      public_scope: "native",
      source: configuredSource,
      storage_binding: nativeStorageBinding,
    };
  }

  const ownerSubjectId = getOwnerTokenSubjectId(req);
  const connectorId = resolveSingleConnectorIdQueryValue(req.query?.connector_id);
  const requestedConnection = resolveRequestConnectionId(req.query ?? {});
  if (requestedConnection.connectionId) {
    const connectorKey = connectorId ? (canonicalConnectorKey(connectorId) ?? connectorId) : null;
    const namespace = await resolveOwnerConnectorInstanceNamespace({
      allowDefaultAccount: false,
      connectorId: connectorKey,
      connectorInstanceId: requestedConnection.connectionId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return {
      owner_subject_id: ownerSubjectId,
      public_scope: "polyfill",
      source: { id: namespace.connectorId, kind: "connector" },
      storage_binding: storageTargetForConnectorNamespace(namespace),
    };
  }

  if (!connectorId) {
    const err = Object.assign(new Error("connector_id must be a single non-empty string for polyfill owner access"), {
      code: "invalid_request",
    });
    throw err;
  }
  // Canonicalize the owner-supplied connector_id once, at the read-scope
  // construction boundary, so the owner read storage binding carries the same
  // canonical key the ingest path writes under (resolveOwnerConnectorNamespace
  // canonicalizes at line ~1332). Without this, a URL-shaped connector_id like
  // 'https://registry.pdpp.dev/connectors/gmail' reaches connection admission
  // verbatim, listActiveByConnector finds zero rows (they are keyed 'gmail'),
  // and the read fails connection_not_found. The owner-facing source descriptor
  // still reflects the canonical key. See canonicalize-connector-keys Decision 1.
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;

  return {
    owner_subject_id: ownerSubjectId,
    public_scope: "polyfill",
    source: { id: connectorKey, kind: "connector" },
    storage_binding: {
      connector_id: connectorKey,
      connector_instance_id: resolveSingleConnectorIdQueryValue(req.query?.connector_instance_id),
    },
  };
}

function resolveProviderName(opts: ServerOpts = {}) {
  return opts.providerName || process.env.PDPP_PROVIDER_NAME || PDPP_PROVIDER_NAME;
}

function resolveNativeManifest(opts: ServerOpts = {}) {
  return opts.nativeManifest || null;
}

function validateNativeConfiguration(opts: ServerOpts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  if (!nativeManifest) {
    return null;
  }

  requireSourceDeclaration(nativeManifest.source_declaration);
  if (nativeManifest.connector_id) {
    throw new Error("Native manifest must not include connector_id");
  }

  const nativeStorageBinding = nativeManifest.storage_binding as Record<string, unknown> | null | undefined;
  if (!nativeStorageBinding?.connector_id) {
    throw new Error("Native manifest must include storage_binding.connector_id");
  }
  const unsupportedStorageBindingFields = Object.keys(nativeStorageBinding || {}).filter(
    (field) => field !== "connector_id"
  );
  if (unsupportedStorageBindingFields.length) {
    throw new Error("Native manifest storage_binding must include only connector_id");
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

function resolveDynamicClientRegistrationEnabled(opts: ServerOpts = {}) {
  const requested = opts.enableDynamicClientRegistration ?? PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION;
  return Boolean(requested);
}

function resolveDynamicClientRegistrationInitialAccessTokens(opts: ServerOpts = {}) {
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

function resolveDynamicClientRegistrationInitialAccessTokensForRequest(req: ReqLike, tokens: string[]) {
  if (isLocalOrPrivateRequestOrigin(req)) {
    return tokens;
  }
  return tokens.filter((token) => token !== DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN);
}

function resolvePreRegisteredPublicClients(opts: ServerOpts = {}) {
  return opts.preRegisteredPublicClients || defaultPreRegisteredPublicClients();
}

function createPublicDcrRateLimiter(config: { windowMs?: number; max?: number } | false = {}) {
  if (config === false) {
    return { check: () => null };
  }
  const windowMs = Number.isFinite(config.windowMs)
    ? Math.max(1, config.windowMs as number)
    : PUBLIC_DCR_RATE_LIMIT_WINDOW_MS;
  const max = Number.isFinite(config.max) ? Math.max(1, config.max as number) : PUBLIC_DCR_RATE_LIMIT_MAX;
  const attempts = new Map();

  return {
    check(req: ReqLike) {
      const now = Date.now();
      if (attempts.size > 1000) {
        for (const [key, entry] of attempts.entries()) {
          if (entry.resetAt <= now) {
            attempts.delete(key);
          }
        }
      }
      const key = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";
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

function publicClientMetadataForAuthorizationServer(clients: Record<string, unknown>[] = []) {
  return clients
    .map((client) => {
      const clientId = typeof client.client_id === "string" ? client.client_id.trim() : "";
      if (!clientId) {
        return null;
      }
      const metadata = (client.metadata || {}) as Record<string, unknown>;
      const clientName =
        typeof metadata.client_name === "string" && (metadata.client_name as string).trim()
          ? (metadata.client_name as string).trim()
          : clientId;
      const tokenEndpointAuthMethod =
        typeof metadata.token_endpoint_auth_method === "string" &&
        (metadata.token_endpoint_auth_method as string).trim()
          ? (metadata.token_endpoint_auth_method as string).trim()
          : "none";
      return {
        client_id: clientId,
        client_name: clientName,
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      };
    })
    .filter(Boolean);
}

export function resolveConnectorEnvironmentPolicy(
  opts: { connectorEnvironmentPolicy?: unknown } = {}
): ConnectorEnvironmentPolicy {
  if (opts.connectorEnvironmentPolicy !== undefined) {
    const policy = opts.connectorEnvironmentPolicy;
    if (typeof policy === "string" || policy === null) {
      return parseConnectorEnvironmentPolicy(policy, "connectorEnvironmentPolicy");
    }
    if (policy && typeof policy === "object" && "approvedBindings" in policy && "approvedProxyConnectorIds" in policy) {
      const typedPolicy = policy as ConnectorEnvironmentPolicy;
      if (!(Array.isArray(typedPolicy.approvedBindings) && Array.isArray(typedPolicy.approvedProxyConnectorIds))) {
        throw new Error("connectorEnvironmentPolicy.approvedBindings and approvedProxyConnectorIds must be arrays");
      }
      return parseConnectorEnvironmentPolicy(
        {
          bindings: typedPolicy.approvedBindings.map((binding) => ({
            connector_id: binding.connectorId,
            logical_key: binding.logicalKey,
            source: binding.source,
            target_key: binding.targetKey,
          })),
          proxy_connector_ids: typedPolicy.approvedProxyConnectorIds,
        },
        "connectorEnvironmentPolicy"
      );
    }
    return parseConnectorEnvironmentPolicy(policy, "connectorEnvironmentPolicy");
  }
  if (process.env.NODE_TEST_CONTEXT && process.env.PDPP_CONNECTOR_ENVIRONMENT_POLICY === undefined) {
    return parseConnectorEnvironmentPolicy(undefined);
  }
  return parseConnectorEnvironmentPolicy(
    process.env.PDPP_CONNECTOR_ENVIRONMENT_POLICY,
    "PDPP_CONNECTOR_ENVIRONMENT_POLICY"
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
function resolveOwnerAuthPlaceholderConfig(opts: ServerOpts = {}) {
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
    (readOwnerAuthEnv && typeof process.env.PDPP_OWNER_PASSWORD === "string" && process.env.PDPP_OWNER_PASSWORD
      ? process.env.PDPP_OWNER_PASSWORD
      : null);
  const subjectId =
    opts.ownerAuthSubjectId ??
    (readOwnerAuthEnv && typeof process.env.PDPP_OWNER_SUBJECT_ID === "string" && process.env.PDPP_OWNER_SUBJECT_ID
      ? process.env.PDPP_OWNER_SUBJECT_ID
      : null);
  // Force `Secure` on owner cookies behind a TLS-terminating proxy where
  // `req.secure` and `X-Forwarded-Proto` cannot be relied on. Default off
  // so plain-HTTP local development continues to issue usable cookies.
  const forceSecureCookies =
    opts.ownerAuthForceSecureCookies ??
    (readOwnerAuthEnv &&
      (process.env.PDPP_OWNER_FORCE_SECURE_COOKIES === "1" || process.env.PDPP_OWNER_FORCE_SECURE_COOKIES === "true"));
  // SameSite mode for the owner session and CSRF cookies. `lax` keeps the
  // existing flow (login redirects from /owner/login back to /consent)
  // working. `strict` is opt-in for deployments that don't rely on
  // top-level navigation following a redirect.
  const sameSiteRaw =
    typeof opts.ownerAuthSameSite === "string"
      ? opts.ownerAuthSameSite
      : // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
        readOwnerAuthEnv
        ? process.env.PDPP_OWNER_SAMESITE
        : undefined;
  const sameSite = sameSiteRaw === "strict" ? "strict" : "lax";
  const sessionTtlRaw =
    opts.ownerAuthSessionTtlSeconds ??
    (readOwnerAuthEnv && typeof process.env.PDPP_OWNER_SESSION_TTL_SECONDS === "string"
      ? process.env.PDPP_OWNER_SESSION_TTL_SECONDS
      : null);
  const sessionTtlSeconds =
    typeof sessionTtlRaw === "number" && Number.isInteger(sessionTtlRaw) && sessionTtlRaw > 0
      ? sessionTtlRaw
      : // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
        // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
        typeof sessionTtlRaw === "string" && /^[1-9]\d*$/.test(sessionTtlRaw.trim())
        ? Number(sessionTtlRaw.trim())
        : undefined;
  return { forceSecureCookies: Boolean(forceSecureCookies), password, sameSite, sessionTtlSeconds, subjectId };
}

function buildSourceDescriptor(sourceBinding: { kind?: string; id?: string } | null = null) {
  if (sourceBinding?.kind === "provider_native" && sourceBinding.id) {
    return { id: sourceBinding.id, kind: "provider_native" };
  }
  if (sourceBinding?.kind === "connector" && sourceBinding.id) {
    return { id: sourceBinding.id, kind: "connector" };
  }
  return null;
}

function resolveGrantStorageBinding(tokenInfo: TokenInfo | null | undefined) {
  const gsb = tokenInfo?.grant_storage_binding as Record<string, unknown> | null | undefined;
  if (gsb?.connector_id) {
    return gsb;
  }
  return null;
}

function ownerSubjectIdForBindings(tokenInfo: TokenInfo | null | undefined) {
  const grant = tokenInfo?.grant as Record<string, unknown> | null | undefined;
  return (
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    ((grant?.subject as Record<string, unknown>)?.id as string | undefined) ||
    tokenInfo?.subject_id ||
    OWNER_AUTH_DEFAULT_SUBJECT_ID
  );
}

function buildClientSourceDescriptor(tokenInfo: TokenInfo | null | undefined) {
  const grant = tokenInfo?.grant as Record<string, unknown> | null | undefined;
  return buildSourceDescriptor((grant?.source as { kind?: string; id?: string } | null) ?? null);
}

function buildOwnerQuerySourceDescriptor(req: ReqLike, opts: ServerOpts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  const configuredSource = buildSourceDescriptor(
    (nativeManifest?.source_declaration as { source?: { id?: string; kind?: string } } | undefined)?.source ?? null
  );
  if (configuredSource) {
    return configuredSource;
  }

  const connectorId = resolveSingleConnectorIdQueryValue(req.query?.connector_id);
  if (!connectorId) {
    return null;
  }
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  return buildSourceDescriptor({ id: connectorKey, kind: "connector" });
}

function buildOwnerReadGrant(streamName: string) {
  return {
    streams: [{ name: streamName }],
  };
}

async function resolveOwnerManifestFromScope(ownerScope: Record<string, unknown>, opts: ServerOpts = {}) {
  let storageBinding = (ownerScope.storage_binding || null) as StorageBinding | null;
  if (ownerScope.public_scope === "polyfill" && storageBinding?.connector_id) {
    try {
      const namespace = await resolveOwnerConnectorInstanceNamespace({
        allowDefaultAccount: false,
        connectorId: storageBinding.connector_id,
        connectorInstanceId: storageBinding.connector_instance_id ?? null,
        connectorInstanceStore: createRequestConnectorInstanceStore(),
        displayName: storageBinding.connector_id,
        ownerSubjectId: (ownerScope.owner_subject_id as string | undefined) || OWNER_AUTH_DEFAULT_SUBJECT_ID,
      });
      storageBinding = storageTargetForConnectorNamespace(namespace);
    } catch (err) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      if ((err as ApiError)?.code === "ambiguous_connector_instance") {
        storageBinding = { connector_id: storageBinding.connector_id ?? null };
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      } else if ((err as ApiError)?.code !== "connector_instance_not_found") {
        throw err;
      }
    }
  }
  const manifest = await getManifestForStorageBinding(
    storageBinding as unknown as Parameters<typeof getManifestForStorageBinding>[0],
    opts
  );
  if (!manifest) {
    const ownerSource = ownerScope.source as { kind?: string; id?: string } | null | undefined;
    const errMsg = `Unknown source: ${ownerSource?.id || storageBinding?.connector_id || "unknown"}`;
    throw Object.assign(new Error(errMsg), { code: "not_found" });
  }
  return { manifest, ownerScope, storageBinding };
}

async function resolveOwnerManifest(req: ReqLike, opts: ServerOpts = {}) {
  const ownerScope = await resolveOwnerReadScope(req, opts);
  return resolveOwnerManifestFromScope(ownerScope, opts);
}

async function resolveGrantManifest(tokenInfo: TokenInfo | null | undefined, opts: ServerOpts = {}) {
  // Client serving is pinned by the persisted storage binding and the grant's
  // closed instance_ids. Do not resolve a current connector instance here.
  const storageBinding: StorageBinding | null = resolveGrantStorageBinding(tokenInfo) as StorageBinding | null;
  const source = buildClientSourceDescriptor(tokenInfo);
  const manifest = await getManifestForStorageBinding(
    storageBinding as unknown as Parameters<typeof getManifestForStorageBinding>[0],
    opts
  );
  if (!manifest) {
    const errMsg = `Unknown source: ${source?.id || storageBinding?.connector_id || "unknown"}`;
    throw Object.assign(new Error(errMsg), { code: "not_found" });
  }
  requireGrantContractAgainstManifest(
    tokenInfo?.grant ? (tokenInfo.grant as Record<string, unknown>) : undefined,
    manifest
  );
  return { manifest, source, storageBinding };
}

async function resolveRegisteredConnectorManifest(connectorId: string) {
  const manifest = await getConnectorManifest(connectorId);
  if (!manifest) {
    throw Object.assign(new Error(`Unknown connector: ${connectorId}`), { code: "not_found" });
  }
  return manifest;
}

// Keyed by the current setup binding kind; each builder returns the durable
// replacement binding. A new setup-binding kind only needs an entry here.
const SETUP_BINDING_PROMOTIONS: Record<
  string,
  (currentBinding: Record<string, unknown>, now: string) => Record<string, unknown>
> = {
  browser_enrollment_shell: (binding, now) =>
    promoteBrowserEnrollmentShellBinding(
      binding as unknown as BrowserEnrollmentShellSourceBinding,
      now
    ) as unknown as Record<string, unknown>,
  manual_upload_draft: (binding, now) =>
    promoteManualUploadDraftBinding(binding as unknown as ManualUploadDraftSourceBinding, now) as unknown as Record<
      string,
      unknown
    >,
  static_secret_draft: (binding, now) =>
    promoteStaticSecretDraftBinding(binding as unknown as StaticSecretDraftSourceBinding, now) as unknown as Record<
      string,
      unknown
    >,
};

interface ActivateDraftConnectionStore {
  activateDraft: (connectorInstanceId: string) => unknown | Promise<unknown>;
  get: (
    connectorInstanceId: string
  ) =>
    | { status?: string; sourceBinding?: unknown }
    | null
    | Promise<{ status?: string; sourceBinding?: unknown } | null>;
  promoteSetupBinding: (
    connectorInstanceId: string,
    args: { fromKind: string; sourceBinding: Record<string, unknown>; updatedAt: string }
  ) => { instance: unknown; promoted: boolean } | Promise<{ instance: unknown; promoted: boolean }>;
}

// Extracted from its `rsMutationContext.activateDraftConnection` call site
// so it's unit-testable against a fake store without a full server — see
// test/activate-draft-connection.test.ts.
type ActivationScheduleAttacher = (
  instance: { connectorId?: string; connectorInstanceId?: string; status?: string } | null | undefined
) => Promise<unknown>;

export async function activateDraftConnection(
  connectorInstanceId: string,
  store: ActivateDraftConnectionStore,
  attachSchedule: ActivationScheduleAttacher
): Promise<unknown> {
  const current = await store.get(connectorInstanceId);
  const bindingKind =
    current?.sourceBinding && typeof current.sourceBinding === "object"
      ? (current.sourceBinding as { kind?: unknown }).kind
      : null;
  const promotion = typeof bindingKind === "string" ? SETUP_BINDING_PROMOTIONS[bindingKind] : undefined;
  const now = new Date().toISOString();
  const { instance, promoted } =
    current?.status === "draft" && promotion
      ? await store.promoteSetupBinding(connectorInstanceId, {
          fromKind: bindingKind as string,
          sourceBinding: promotion(current.sourceBinding as Record<string, unknown>, now),
          updatedAt: now,
        })
      : { instance: await store.activateDraft(connectorInstanceId), promoted: true };
  if (!promoted) {
    return null;
  }
  return await attachSchedule(
    instance as { connectorId?: string; connectorInstanceId?: string; status?: string } | null | undefined
  );
}

function createActivationScheduleAttacher(controller: unknown) {
  return async (
    instance: { connectorId?: string; connectorInstanceId?: string; status?: string } | null | undefined
  ) => {
    if (instance?.status !== "active") {
      return null;
    }
    if (!controller) {
      throw new Error("Cannot attach activation schedule without a connector controller");
    }
    const manifest = await resolveRegisteredConnectorManifest(instance.connectorId as string);
    return await (attachActivationScheduleIfAutomatic as (args: Record<string, unknown>) => Promise<unknown>)({
      connectorId: instance.connectorId,
      connectorInstanceId: instance.connectorInstanceId,
      controller,
      manifest,
    });
  };
}

function buildGrantInvalidError(): ApiError {
  return Object.assign(new Error("Grant is malformed or no longer valid"), { code: "grant_invalid" }) as ApiError;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
export async function resolveGrantScopedStateGrant(connectorId: string, grantId: string) {
  // Grants live in the active storage backend. In postgres mode the SQLite
  // `grants` table is empty (or stale), so we must read from postgres or
  // every postgres-issued grant resolves as `not_found`. JSONB columns are
  // cast to ::text so requirePersistedGrantState's JSON.parse sees the same
  // string shape it sees from the SQLite reader.
  const row = isPostgresStorageBackend()
    ? (
        await postgresQuery(
          `SELECT grant_id AS persisted_grant_id,
                subject_id AS grant_subject_id,
                client_id AS grant_client_id,
                access_mode AS grant_access_mode,
                expires_at AS grant_expires_at,
                grant_json::text AS grant_json,
                storage_binding_json::text AS storage_binding_json,
                trace_id, scenario_id
         FROM grants
         WHERE grant_id = $1`,
          [grantId]
        )
      ).rows[0] || null
    : getOne(referenceQueries.grantsGetScopedStateById, [grantId]);
  if (!row) {
    throw Object.assign(new Error(`Unknown grant: ${grantId}`), { code: "not_found" });
  }

  const rowTraceId = (row as Record<string, unknown>).trace_id as string | null | undefined;
  const rowScenarioId = (row as Record<string, unknown>).scenario_id as string | null | undefined;
  try {
    const resolved = await requireResolvedPersistedGrantState(
      row as Parameters<typeof requireResolvedPersistedGrantState>[0]
    );
    if (resolved.grant.access_mode !== "continuous") {
      throw Object.assign(
        new Error(
          `Grant '${grantId}' does not support grant-scoped state because access_mode is ${resolved.grant.access_mode || "unknown"}`
        ),
        {
          code: "invalid_request",
          scenario_id: rowScenarioId || null,
          trace_id: rowTraceId || null,
        }
      ) as unknown as ApiError;
    }
    const canonicalPathConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const canonicalBoundConnectorId =
      canonicalConnectorKey(resolved.storageBinding.connector_id) ?? resolved.storageBinding.connector_id;
    if (canonicalBoundConnectorId !== canonicalPathConnectorId) {
      throw Object.assign(new Error(`Grant '${grantId}' is not scoped to connector ${connectorId}`), {
        code: "invalid_request",
        scenario_id: rowScenarioId || null,
        trace_id: rowTraceId || null,
      }) as unknown as ApiError;
    }
    return {
      grant: resolved.grant,
      grantedStreams: new Set(
        ((resolved.grant as Record<string, unknown>).streams as Record<string, unknown>[]).map(
          (stream) => stream.name as string
        )
      ),
      grantId,
      scenarioId: rowScenarioId || null,
      storageBinding: resolved.storageBinding,
      traceId: rowTraceId || null,
    };
  } catch (err) {
    const apiErr = err as ApiError;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    if (apiErr?.code === "invalid_request" || apiErr?.code === "not_found") {
      apiErr.trace_id = rowTraceId || null;
      apiErr.scenario_id = rowScenarioId || null;
      throw apiErr;
    }
    const invalidErr = buildGrantInvalidError();
    invalidErr.trace_id = rowTraceId || null;
    invalidErr.scenario_id = rowScenarioId || null;
    throw invalidErr;
  }
}

function normalizePrimaryKey(primaryKey: unknown): string[] {
  if (Array.isArray(primaryKey)) {
    return primaryKey as string[];
  }
  if (typeof primaryKey === "string" && primaryKey.trim()) {
    return [primaryKey];
  }
  return [];
}

function buildFreshness(lastUpdated: string | null = null) {
  return deriveReferenceFreshness({ recordLastUpdatedAt: lastUpdated });
}

async function getLatestConnectorRunSummary(
  connectorId: string | null,
  status: string | null = null,
  connectorInstanceId: string | null | undefined = null
) {
  if (!connectorId) {
    return null;
  }
  const filters = {
    limit: 1,
    sourceId: connectorId,
    sourceKind: "connector",
    ...(status ? { status } : {}),
    ...(connectorInstanceId ? { connectorInstanceId } : {}),
  };
  const { summaries } = await listSpineCorrelations("run", filters);
  const summary = summaries[0] || null;
  if (!summary) {
    return null;
  }
  return {
    last_at: summary.last_at,
    status: summary.status,
  };
}

function getManifestRefreshPolicy(manifest: Record<string, unknown> | null | undefined) {
  const capabilities = manifest?.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  return (capabilities as Record<string, unknown>).refresh_policy ?? null;
}

function getMaximumStalenessSeconds(refreshPolicy: unknown) {
  if (!refreshPolicy || typeof refreshPolicy !== "object" || Array.isArray(refreshPolicy)) {
    return null;
  }
  const value = (refreshPolicy as Record<string, unknown>).maximum_staleness_seconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

async function getConnectorFreshnessEvidence({
  storageBinding,
  manifest,
}: {
  storageBinding: StorageBinding;
  manifest: Record<string, unknown> | null | undefined;
}) {
  const connectorId = storageBinding.connector_id ?? null;
  const refreshPolicy = getManifestRefreshPolicy(manifest);
  const [lastRun, lastSuccessfulRun] = await Promise.all([
    getLatestConnectorRunSummary(connectorId),
    getLatestConnectorRunSummary(connectorId, "succeeded"),
  ]);
  return {
    lastRun,
    lastSuccessfulRun,
    maximumStalenessSeconds: getMaximumStalenessSeconds(refreshPolicy),
  };
}

function buildConnectorAwareFreshness(
  evidence:
    | {
        lastRun?: { last_at?: string | null; status?: string | null } | null;
        lastSuccessfulRun?: { last_at?: string | null } | null;
        maximumStalenessSeconds?: number | null;
      }
    | null
    | undefined,
  recordLastUpdatedAt: string | null = null
) {
  return deriveReferenceFreshness({
    lastAttemptedAt: evidence?.lastRun?.last_at ?? null,
    lastAttemptStatus: evidence?.lastRun?.status ?? null,
    lastSuccessfulRunAt: evidence?.lastSuccessfulRun?.last_at ?? null,
    maximumStalenessSeconds: evidence?.maximumStalenessSeconds ?? null,
    recordLastUpdatedAt,
  });
}

function hasObjectEntries(value: unknown): boolean {
  return !!(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0);
}

function getNonNullSchemaTypes(schema: Record<string, unknown> | null | undefined): Set<string> {
  const rawType = schema?.type;
  if (!rawType) {
    return new Set();
  }
  const types = Array.isArray(rawType) ? rawType : [rawType];
  return new Set((types as string[]).filter((type) => type !== "null"));
}

function isExactFilterableSchema(schema: Record<string, unknown> | null | undefined): boolean {
  const types = getNonNullSchemaTypes(schema);
  if (types.size !== 1) {
    return false;
  }
  const [type] = types;
  return ["boolean", "integer", "number", "string"].includes(type as string);
}

function buildFieldCapabilityFlag({
  declared,
  granted,
  operators = null,
}: {
  declared: boolean;
  granted: boolean;
  operators?: unknown;
}): Record<string, unknown> {
  const flag: Record<string, unknown> = {
    declared,
    usable: declared && granted,
  };
  if (operators) {
    flag.operators = operators;
  }
  if (declared && !granted) {
    flag.reason = "field_not_granted";
  }
  return flag;
}

function buildFieldAggregationCapabilities(
  aggregations: Record<string, unknown> | null | undefined,
  field: string,
  granted: boolean
) {
  return {
    count_distinct: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.count_distinct) && aggregations.count_distinct.includes(field),
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
    max: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.max) && aggregations.max.includes(field),
      granted,
    }),
    min: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.min) && aggregations.min.includes(field),
      granted,
    }),
    sum: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.sum) && aggregations.sum.includes(field),
      granted,
    }),
  };
}

function buildFieldCapabilities(
  manifestStream: Record<string, unknown> | null | undefined,
  streamGrant: Record<string, unknown> | null = null
) {
  const schema = (manifestStream?.schema || {}) as Record<string, unknown>;
  const properties = (schema.properties || {}) as Record<string, unknown>;
  const fieldDeclarations = new Map<string, string>();
  for (const declarations of [manifestStream?.fields, schema.fields]) {
    if (!Array.isArray(declarations)) {
      continue;
    }
    for (const declaration of declarations) {
      if (
        declaration &&
        typeof declaration === "object" &&
        typeof (declaration as Record<string, unknown>).name === "string" &&
        ((declaration as Record<string, unknown>).name as string).trim().length > 0 &&
        typeof (declaration as Record<string, unknown>).type === "string" &&
        ((declaration as Record<string, unknown>).type as string).trim().length > 0
      ) {
        fieldDeclarations.set(
          (declaration as Record<string, unknown>).name as string,
          ((declaration as Record<string, unknown>).type as string).trim()
        );
      }
    }
  }
  const grantedFields =
    // biome-ignore lint/correctness/noUnsafeOptionalChaining: The preceding guard establishes this optional value before access.
    Array.isArray(streamGrant?.fields) && (streamGrant?.fields as unknown[]).length > 0
      ? new Set(streamGrant?.fields as unknown[])
      : null;
  const query = (manifestStream?.query || {}) as Record<string, unknown>;
  const rangeFilters = (query.range_filters || {}) as Record<string, unknown>;
  const search = (query.search || {}) as Record<string, unknown>;
  const lexicalFields = new Set(Array.isArray(search.lexical_fields) ? (search.lexical_fields as unknown[]) : []);
  const semanticFields = new Set(Array.isArray(search.semantic_fields) ? (search.semantic_fields as unknown[]) : []);
  const aggregations = (query.aggregations || {}) as Record<string, unknown>;

  return Object.fromEntries(
    Object.entries(properties).map(([field, fieldSchema]) => {
      const schemaObj = (fieldSchema && typeof fieldSchema === "object" ? fieldSchema : {}) as Record<string, unknown>;
      const granted = !grantedFields || grantedFields.has(field);
      const rangeOperators = Array.isArray(rangeFilters[field]) ? (rangeFilters[field] as unknown[]) : null;
      // Optional declared presentation type, sourced either from the JSON
      // Schema extension (`schema.properties[field].x_pdpp_type`) or from a
      // sandbox-shaped field declaration (`fields[]` or `schema.fields[]`,
      // with `{ name, type, semantic_class }`). Surfaced as an additive `type`
      // on the field_capabilities entry only; it does not influence any filter,
      // search, aggregation, grant, or retrieval decision below.
      const declaredType =
        typeof schemaObj.x_pdpp_type === "string" && (schemaObj.x_pdpp_type as string).trim().length > 0
          ? (schemaObj.x_pdpp_type as string).trim()
          : fieldDeclarations.get(field) || null;
      const declaredRole =
        typeof schemaObj.x_pdpp_role === "string" && (schemaObj.x_pdpp_role as string).trim().length > 0
          ? (schemaObj.x_pdpp_role as string).trim()
          : null;
      return [
        field,
        {
          ...(declaredType ? { type: declaredType } : {}),
          ...(declaredRole ? { role: declaredRole } : {}),
          aggregation: buildFieldAggregationCapabilities(aggregations, field, granted),
          granted,
          lexical_search: buildFieldCapabilityFlag({
            declared: lexicalFields.has(field),
            granted,
          }),
          schema: fieldSchema,
          semantic_search: buildFieldCapabilityFlag({
            declared: semanticFields.has(field),
            granted,
          }),
          ...(streamGrant === null
            ? {
                exact_filter: buildFieldCapabilityFlag({
                  declared: isExactFilterableSchema(schemaObj),
                  granted,
                }),
                range_filter: buildFieldCapabilityFlag({
                  declared: Boolean(rangeOperators),
                  granted,
                  operators: rangeOperators || undefined,
                }),
              }
            : {}),
        },
      ];
    })
  );
}

function buildStreamMetadataEntry({
  manifestStream,
  streamGrant = null,
  grantStreams = [] as Record<string, unknown>[],
  freshness = null as ReturnType<typeof buildFreshness> | null,
  grantedConnections = null as unknown[] | null,
  manifestStreamNames = null as Set<string> | null,
}: {
  manifestStream: Record<string, unknown>;
  streamGrant?: Record<string, unknown> | null;
  grantStreams?: Record<string, unknown>[];
  freshness?: ReturnType<typeof buildFreshness> | null;
  grantedConnections?: unknown[] | null;
  manifestStreamNames?: Set<string> | null;
}) {
  const projectedManifestStream = streamGrant ? projectManifestStreamForGrant(streamGrant) : manifestStream;
  const expandStreamGrant = streamGrant ? { ...streamGrant, grantStreams } : null;
  const entry: Record<string, unknown> = {
    consent_time_field: projectedManifestStream.consent_time_field,
    cursor_field: projectedManifestStream.cursor_field,
    expand_capabilities: buildExpandCapabilities(projectedManifestStream, expandStreamGrant, manifestStreamNames),
    field_capabilities: buildFieldCapabilities(projectedManifestStream, streamGrant),
    freshness: freshness ?? buildFreshness(null),
    name: projectedManifestStream.name,
    object: "stream_metadata",
    primary_key: normalizePrimaryKey(projectedManifestStream.primary_key),
    query: projectedManifestStream.query || {},
    relationships: projectedManifestStream.relationships || [],
    schema: projectedManifestStream.schema,
    selection: projectedManifestStream.selection,
    semantics: projectedManifestStream.semantics,
    views: projectedManifestStream.views || [],
  };
  if (streamGrant) {
    entry.instance_ids = Array.isArray(streamGrant.instance_ids) ? [...streamGrant.instance_ids] : [];
    if (Array.isArray(streamGrant.resources)) {
      entry.resources = [...streamGrant.resources];
    }
    if (streamGrant.time_constraint && typeof streamGrant.time_constraint === "object") {
      entry.time_constraint = structuredClone(streamGrant.time_constraint);
    }
  }
  if (Array.isArray(grantedConnections)) {
    entry.granted_connections = grantedConnections;
  }
  return entry;
}

function projectManifestStreamForGrant(streamGrant: Record<string, unknown>): Record<string, unknown> {
  // Resolved grants retain authorization facts, not live schema definitions.
  // Do not copy property schemas, requiredness, $defs, query affordances, or
  // relationships from the current declaration into a client projection.
  // A future grant shape can retain a typed schema snapshot explicitly; until
  // then, empty field schemas are the only honest projection.
  const fields = Array.isArray(streamGrant.fields)
    ? (streamGrant.fields as unknown[]).filter((field): field is string => typeof field === "string")
    : [];
  const grantedFields = new Set(fields);
  const schema: Record<string, unknown> = {
    additionalProperties: false,
    properties: Object.fromEntries([...grantedFields].map((field) => [field, {}])),
    type: "object",
  };
  const timeConstraint =
    streamGrant.time_constraint && typeof streamGrant.time_constraint === "object"
      ? (streamGrant.time_constraint as Record<string, unknown>)
      : null;
  const frozenTimeField = typeof timeConstraint?.field === "string" ? timeConstraint.field : undefined;
  return {
    name: streamGrant.name,
    schema,
    ...(frozenTimeField ? { consent_time_field: frozenTimeField } : {}),
  };
}
// Emit one `expand_capabilities` entry per enabled parent-stream relation (a
// `query.expand[]` capability backed by a `relationships[]` declaration),
// including relations whose target stream is unreadable under the current
// request. Declared-but-unreadable relations stay visible with `usable: false`
// and a `reason` enum value so a console can tell "no relation declared" apart
// from "relation declared but not readable here".
//
// `manifestStreamNames`, when provided, is the set of streams the loaded
// manifest declares; a relation pointing at a stream outside that set is
// surfaced as `related_stream_unknown` rather than silently dropped.
function buildExpandCapabilities(
  manifestStream: Record<string, unknown> | null | undefined,
  streamGrant: Record<string, unknown> | null = null,
  manifestStreamNames: Set<string> | null = null
) {
  const rawRelationships = Array.isArray(manifestStream?.relationships)
    ? (manifestStream?.relationships as Record<string, unknown>[])
    : [];
  const relationships = new Map(rawRelationships.map((relationship) => [relationship.name as string, relationship]));
  const rawGrantStreams = streamGrant?.grantStreams as Record<string, unknown>[] | undefined;
  const grantedStreams = Array.isArray(rawGrantStreams)
    ? new Set(rawGrantStreams.map((stream) => stream.name as string))
    : null;

  const query = (manifestStream?.query || {}) as Record<string, unknown>;
  const expandList = Array.isArray(query.expand) ? (query.expand as Record<string, unknown>[]) : [];

  return expandList
    .map((capability) => {
      const relationship = relationships.get(capability.name as string);
      if (!relationship) {
        return null;
      }
      const targetStream = relationship.stream as string;
      const known = !manifestStreamNames || manifestStreamNames.has(targetStream);
      const granted = known && (!grantedStreams || grantedStreams.has(targetStream));
      const usable = known && granted;
      const entry: Record<string, unknown> = {
        cardinality: relationship.cardinality,
        granted,
        name: capability.name,
        // `stream` (back-compat) and `target_stream` both name the related child
        // stream; the canonical, self-describing name is `target_stream`.
        stream: targetStream,
        target_stream: targetStream,
        usable,
      };
      if (relationship.foreign_key) {
        // The field on the child carrying the parent's key. `child_parent_key_field`
        // is the canonical name; `foreign_key` stays as a back-compat alias with
        // the identical value.
        entry.child_parent_key_field = relationship.foreign_key;
        entry.foreign_key = relationship.foreign_key;
      }
      if (capability.default_limit !== undefined) {
        entry.default_limit = capability.default_limit;
      }
      if (capability.max_limit !== undefined) {
        entry.max_limit = capability.max_limit;
      }
      if (!usable) {
        entry.reason = known ? "related_stream_not_granted" : "related_stream_unknown";
      }
      return entry;
    })
    .filter(Boolean);
}

// biome-ignore lint/suspicious/noShadow: The local name follows the external payload vocabulary at this boundary.
function buildDiscoveryUrl(path: string, connectorId: string | null = null) {
  const connectorQuery = connectorId ? `?connector_id=${encodeURIComponent(connectorId)}` : "";
  return `${path}${connectorQuery}`;
}

function buildStreamDiscoveryCapabilities({
  connectorId = null as string | null,
  stream,
}: {
  connectorId?: string | null;
  stream: Record<string, unknown>;
}) {
  const encodedStream = encodeURIComponent(stream.name as string);
  const query = (stream.query || {}) as Record<string, unknown>;
  const rangeFilters = query.range_filters;
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const expand = query.expand;
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const aggregations = query.aggregations;
  const hasAggregations = hasObjectEntries(aggregations);

  return {
    aggregate: hasAggregations,
    aggregate_url: hasAggregations ? buildDiscoveryUrl(`/v1/streams/${encodedStream}/aggregate`, connectorId) : null,
    changes_since: true,
    exact_filters: true,
    expand: Array.isArray(expand) && expand.length > 0,
    metadata_url: buildDiscoveryUrl(`/v1/streams/${encodedStream}`, connectorId),
    range_filters: hasObjectEntries(rangeFilters),
    records: true,
    records_url: buildDiscoveryUrl(`/v1/streams/${encodedStream}/records`, connectorId),
    stream_metadata: true,
  };
}

function buildStreamDiscoverySummary({
  connectorId = null as string | null,
  stream,
  summary = null as Record<string, unknown> | null,
  freshnessEvidence = null as Parameters<typeof buildConnectorAwareFreshness>[0],
}: {
  connectorId?: string | null;
  stream: Record<string, unknown>;
  summary?: Record<string, unknown> | null;
  freshnessEvidence?: Parameters<typeof buildConnectorAwareFreshness>[0];
}) {
  const lastUpdated = (summary?.last_updated as string | null | undefined) || null;
  return {
    capabilities: buildStreamDiscoveryCapabilities({ connectorId, stream }),
    freshness: buildConnectorAwareFreshness(freshnessEvidence, lastUpdated),
    last_updated: lastUpdated,
    name: stream.name,
    object: "stream",
    record_count: summary?.record_count || 0,
  };
}

function mergeStreamSummary(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): Record<string, unknown> {
  const currentUpdated = typeof current?.last_updated === "string" ? current.last_updated : null;
  const nextUpdated = typeof next.last_updated === "string" ? next.last_updated : null;
  return {
    last_updated: !currentUpdated || (nextUpdated && nextUpdated > currentUpdated) ? nextUpdated : currentUpdated,
    name: next.name,
    object: "stream",
    record_count: Number(current?.record_count || 0) + Number(next.record_count || 0),
  };
}

async function listSubjectVisibleStreamSummaries({
  storageBinding,
  manifest,
  grant,
  ownerSubjectId,
}: {
  source: { kind?: string; id?: string } | null | undefined;
  storageBinding: StorageBinding;
  manifest: Record<string, unknown>;
  grant: Record<string, unknown> | null;
  ownerSubjectId: string | null;
}): Promise<Record<string, unknown>[]> {
  const manifestStreams = Array.isArray(manifest.streams) ? (manifest.streams as Record<string, unknown>[]) : [];
  const effectiveGrant = grant ?? {
    streams: manifestStreams.flatMap((stream) =>
      typeof stream.name === "string" && stream.name ? [{ name: stream.name }] : []
    ),
  };
  const grantStreams = Array.isArray(effectiveGrant.streams)
    ? (effectiveGrant.streams as Record<string, unknown>[])
    : [];
  const summaries = new Map<string, Record<string, unknown>>();
  await Promise.all(
    grantStreams.map(async (streamGrant) => {
      const streamName = typeof streamGrant.name === "string" ? streamGrant.name : null;
      if (!streamName) {
        return;
      }
      let bindings: Array<{ connectorId: string; connectorInstanceId: string }>;
      try {
        const resolved = await resolveReadRequestBindings({
          grant: effectiveGrant as unknown as Parameters<typeof resolveReadRequestBindings>[0]["grant"],
          ownerRead: grant === null,
          ...(ownerSubjectId ? { ownerSubjectId } : {}),
          requestParams: {},
          storageBinding: storageBinding as unknown as NonNullable<
            Parameters<typeof resolveReadRequestBindings>[0]["storageBinding"]
          >,
          streamName,
        });
        bindings = resolved.bindings as Array<{ connectorId: string; connectorInstanceId: string }>;
      } catch (error) {
        if (error instanceof Error && (error as Error & { code?: string }).code === "connection_not_found") {
          return;
        }
        throw error;
      }
      const perBinding = await Promise.all(
        bindings.map((binding) =>
          listStreams(
            {
              connector_id: binding.connectorId,
              connector_instance_id: binding.connectorInstanceId,
            },
            { streams: [streamGrant] } as unknown as Parameters<typeof listStreams>[1],
            manifest as Parameters<typeof listStreams>[2]
          )
        )
      );
      for (const summary of perBinding.flat() as unknown as Record<string, unknown>[]) {
        summaries.set(streamName, mergeStreamSummary(summaries.get(streamName), summary));
      }
    })
  );
  return [...summaries.values()];
}

async function buildConnectorSchemaItem({
  source,
  storageBinding,
  manifest,
  grant = null as Record<string, unknown> | null,
  ownerSubjectId = null as string | null,
}: {
  source: { kind?: string; id?: string } | null | undefined;
  storageBinding: StorageBinding;
  manifest: Record<string, unknown>;
  grant?: Record<string, unknown> | null;
  ownerSubjectId?: string | null;
}) {
  const connectorId = (storageBinding.connector_id as string | null | undefined) ?? null;
  const rawStreamSummaries = await listSubjectVisibleStreamSummaries({
    grant,
    manifest,
    ownerSubjectId,
    source,
    storageBinding,
  });
  const streamSummaries = rawStreamSummaries as Record<string, unknown>[];
  const summaryByName = new Map(streamSummaries.map((summary) => [summary.name as string, summary]));
  const grantStreamsArr = Array.isArray(grant?.streams) ? (grant?.streams as Record<string, unknown>[]) : [];
  const grantStreamByName = grant
    ? new Map(grantStreamsArr.map((streamGrant) => [streamGrant.name as string, streamGrant]))
    : null;
  const manifestStreamsArr = Array.isArray(manifest.streams) ? (manifest.streams as Record<string, unknown>[]) : [];
  const visibleStreams: Record<string, unknown>[] = grant
    ? (grantStreamsArr
        .map((streamGrant) => manifestStreamsArr.find((stream) => stream.name === streamGrant.name))
        .filter(Boolean) as Record<string, unknown>[])
    : manifestStreamsArr;
  const grantStreams = grantStreamsArr;
  // Streams the loaded manifest declares — lets the expand-capabilities builder
  // distinguish "target stream not granted" from "target stream unknown".
  const manifestStreamNames = new Set(manifestStreamsArr.map((stream) => stream.name as string));
  const freshnessEvidence = await getConnectorFreshnessEvidence({ manifest, storageBinding });

  const streams = await Promise.all(
    visibleStreams.map(async (manifestStream) => {
      const streamName = manifestStream.name as string;
      const summary = summaryByName.get(streamName);
      const lastUpdated = (summary?.last_updated as string | null | undefined) || null;
      const streamGrant = grantStreamByName ? grantStreamByName.get(streamName) || null : null;
      let grantedConnections: unknown[] | null = null;
      if (connectorId && ownerSubjectId) {
        const authorizedInstanceIds = Array.isArray(streamGrant?.instance_ids)
          ? (streamGrant.instance_ids as string[])
          : [];
        grantedConnections = await listGrantedConnectionsForStream({
          authorizedInstanceIds: grant ? authorizedInstanceIds : null,
          connectorId,
          ownerSubjectId,
        });
      }
      return buildStreamMetadataEntry({
        freshness: buildConnectorAwareFreshness(freshnessEvidence, lastUpdated),
        grantedConnections,
        grantStreams,
        manifestStream,
        manifestStreamNames,
        streamGrant,
      });
    })
  );

  const item: Record<string, unknown> = {
    object: "connector",
    source,
    stream_count: streams.length,
    streams,
  };
  if (connectorId) {
    item.connector_key = connectorId;
    item.connector_id = connectorId;
  }
  return item;
}

async function buildConnectorDiscoveryItem({
  source,
  storageBinding,
  manifest,
  grant = null as Record<string, unknown> | null,
  ownerSubjectId = null as string | null,
}: {
  source: { kind?: string; id?: string } | null | undefined;
  storageBinding: StorageBinding;
  manifest: Record<string, unknown>;
  grant?: Record<string, unknown> | null;
  ownerSubjectId?: string | null;
}) {
  const connectorId = (storageBinding.connector_id as string | null | undefined) ?? null;
  const rawSummaries = await listSubjectVisibleStreamSummaries({
    grant,
    manifest,
    ownerSubjectId,
    source,
    storageBinding,
  });
  const streamSummaries = rawSummaries as Record<string, unknown>[];
  const summaryByName = new Map(streamSummaries.map((summary) => [summary.name as string, summary]));
  const manifestStreamsArr = Array.isArray(manifest.streams) ? (manifest.streams as Record<string, unknown>[]) : [];
  const grantStreamsArr = Array.isArray(grant?.streams) ? (grant?.streams as Record<string, unknown>[]) : [];
  const visibleStreams: Record<string, unknown>[] = grant
    ? (grantStreamsArr
        .map((streamGrant) => manifestStreamsArr.find((stream) => stream.name === streamGrant.name))
        .filter(Boolean) as Record<string, unknown>[])
    : manifestStreamsArr;
  const freshnessEvidence = await getConnectorFreshnessEvidence({ manifest, storageBinding });

  const item: Record<string, unknown> = {
    object: "connector",
    source,
    stream_count: visibleStreams.length,
    streams: visibleStreams.map((stream) =>
      buildStreamDiscoverySummary({
        connectorId,
        freshnessEvidence,
        stream,
        summary: summaryByName.get(stream.name as string) || null,
      })
    ),
  };

  if (connectorId) {
    item.connector_key = connectorId;
    item.connector_id = connectorId;
  }

  return item;
}

/**
 * Options threaded through `decorateBlobRefValue`/`decorateRecordBlobRefs`.
 * `withBlobSize` is opt-in and defaults to false/unchanged behavior:
 * `decorateRecordBlobRefs` decorates both the records-LIST route
 * (`buildRecordsListDeps` in `routes/rs-read.ts`, one call per row of a
 * page) and the single-record-DETAIL route (`mountRsRecordDetail`). Adding
 * a per-blob DB lookup unconditionally would turn the list route into an
 * N-per-page fan-out; only the detail route passes `withBlobSize: true`.
 * See docs/inbox/findings-storage-granularity.md §6 for the bounded-page-
 * join-is-fine-but-don't-widen-it-further distinction this preserves.
 *
 * With `withBlobSize` false/omitted, both functions stay fully synchronous
 * (return the plain decorated value, not a Promise) — the records-LIST
 * dependency contract (`RecordsListDependencies.decorateRecord` in
 * `operations/rs-records-list/index.ts`) is unchanged and does not need to
 * become async. Only `withBlobSize: true` returns a `Promise`, matching the
 * `MaybeAsync<T>` convention `BlobStore` already uses.
 */
interface DecorateBlobRefOptions {
  withBlobSize?: boolean;
}

type MaybeAsync<T> = T | Promise<T>;

function decorateBlobRefValue(blobRef: unknown, options: DecorateBlobRefOptions = {}): MaybeAsync<unknown> {
  if (!blobRef || typeof blobRef !== "object") {
    return blobRef;
  }
  const ref = blobRef as Record<string, unknown>;
  if (typeof ref.blob_id !== "string" || !ref.blob_id) {
    return blobRef;
  }
  const blobId = ref.blob_id;
  const decorated: Record<string, unknown> = {
    ...ref,
    fetch_url: `/v1/blobs/${encodeURIComponent(blobId)}`,
  };
  if (!options.withBlobSize) {
    return decorated;
  }
  // Single indexed point lookup keyed by `blob_id` (primary key on `blobs`),
  // already known from the ref — not a table scan, not a join across all
  // blobs. See `BlobStore.loadBlobSize`.
  return Promise.resolve(createBlobStore().loadBlobSize(blobId)).then((sizeBytes) => {
    decorated.size_bytes = sizeBytes;
    return decorated;
  });
}

function decorateRecordBlobRefs(record: unknown, options: DecorateBlobRefOptions = {}): MaybeAsync<unknown> {
  if (!record || typeof record !== "object") {
    return record;
  }
  const rec = record as Record<string, unknown>;
  const next: Record<string, unknown> = { ...rec };
  if (rec.data && typeof rec.data === "object" && !Array.isArray(rec.data)) {
    const data = rec.data as Record<string, unknown>;
    if (data.blob_ref) {
      const decoratedRef = decorateBlobRefValue(data.blob_ref, options);
      if (decoratedRef instanceof Promise) {
        const withData = decoratedRef.then((blob_ref) => ({ ...data, blob_ref }));
        return withData.then((decoratedData) => decorateRecordExpanded(rec, next, decoratedData, options));
      }
      next.data = { ...data, blob_ref: decoratedRef };
      return decorateRecordExpanded(rec, next, next.data, options);
    }
  }
  return decorateRecordExpanded(rec, next, next.data, options);
}

/**
 * Decorate `rec.expanded` sub-records after `data.blob_ref` (if any) has
 * already been resolved into `next.data`/`resolvedData`. Split out of
 * `decorateRecordBlobRefs` so that function can return synchronously in the
 * (default, `withBlobSize: false`) common case without a Promise wrapper —
 * only entering `async` territory once `options.withBlobSize` is set.
 */
function decorateRecordExpanded(
  rec: Record<string, unknown>,
  next: Record<string, unknown>,
  resolvedData: unknown,
  options: DecorateBlobRefOptions
): MaybeAsync<unknown> {
  next.data = resolvedData;
  if (!(rec.expanded && typeof rec.expanded === "object" && !Array.isArray(rec.expanded))) {
    return next;
  }
  const entries = Object.entries(rec.expanded as Record<string, unknown>).map(([name, value]) => {
    if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).data)) {
      const v = value as Record<string, unknown>;
      const decoratedItems = (v.data as unknown[]).map((item) => decorateRecordBlobRefs(item, options));
      if (decoratedItems.some((item) => item instanceof Promise)) {
        return Promise.all(decoratedItems).then((data) => [name, { ...v, data }] as const);
      }
      return [name, { ...v, data: decoratedItems }] as const;
    }
    const decorated = decorateRecordBlobRefs(value, options);
    if (decorated instanceof Promise) {
      return decorated.then((resolved) => [name, resolved] as const);
    }
    return [name, decorated] as const;
  });
  if (entries.some((entry) => entry instanceof Promise)) {
    return Promise.all(entries).then((resolvedEntries) => {
      next.expanded = Object.fromEntries(resolvedEntries);
      return next;
    });
  }
  next.expanded = Object.fromEntries(entries as readonly (readonly [string, unknown])[]);
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
function buildSelfLink(req: (ReqLike & { url?: string }) | null | undefined): string | null {
  if (!req) {
    return null;
  }
  // biome-ignore lint/suspicious/noShadow: The local name follows the external payload vocabulary at this boundary.
  const path = typeof req.path === "string" ? req.path : null;
  if (!path) {
    return null;
  }
  // Fastify exposes the raw URL (path + query) on `req.url` and on
  // `req.raw.url`; prefer those so query order matches what the client sent.
  const rawUrl =
    typeof req.url === "string" && req.url
      ? req.url
      : // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
        req.raw && typeof (req.raw as Record<string, unknown>).url === "string"
        ? ((req.raw as Record<string, unknown>).url as string)
        : null;
  if (rawUrl?.startsWith("/")) {
    return rawUrl;
  }
  return path;
}

/**
 * Build a `links.next` URL by re-applying the operation's opaque cursor
 * onto the same path. Returns `null` when there is no further page (the
 * canonical contract treats absent / null `links.next` identically).
 */
function buildNextLink(
  req: (ReqLike & { url?: string }) | null | undefined,
  payload: Record<string, unknown> | null | undefined
): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.has_more !== true) {
    return null;
  }
  // biome-ignore lint/suspicious/noShadow: The local name follows the external payload vocabulary at this boundary.
  const path = typeof req?.path === "string" ? req.path : null;
  if (!path) {
    return null;
  }

  // Carry every cursor variant the operation may emit: the canonical opaque
  // `next_cursor`, and the legacy `next_changes_since` cursor used by the
  // changes_since branch. The wire next-link is a server-issued URL the
  // client follows verbatim; we do not commit to a cursor key format here.
  const nextCursor =
    typeof payload.next_cursor === "string" && payload.next_cursor ? (payload.next_cursor as string) : null;
  const nextChangesSince =
    typeof payload.next_changes_since === "string" && payload.next_changes_since
      ? (payload.next_changes_since as string)
      : null;
  if (!(nextCursor || nextChangesSince)) {
    return null;
  }

  // Strip cursor/changes_since from the original request before re-stamping
  // so a relayed link replaces the previous cursor instead of compounding.
  const reqUrl = (req as Record<string, unknown> | undefined)?.url;
  const rawUrl = typeof reqUrl === "string" && reqUrl ? reqUrl : path;
  const queryStart = rawUrl.indexOf("?");
  const queryPart = queryStart >= 0 ? rawUrl.slice(queryStart + 1) : "";
  const sanitized = new URLSearchParams(queryPart);
  sanitized.delete("cursor");
  sanitized.delete("changes_since");
  if (nextCursor) {
    sanitized.set("cursor", nextCursor);
  }
  if (nextChangesSince) {
    sanitized.set("changes_since", nextChangesSince);
  }
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
function finalizeCanonicalEnvelope(
  payload: Record<string, unknown> | null | undefined,
  req: (ReqLike & { url?: string }) | null | undefined
): Record<string, unknown> | null | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const next: Record<string, unknown> = { ...payload };
  const self = buildSelfLink(req);
  const nextLink = buildNextLink(req, payload);
  const existingLinks =
    payload.links && typeof payload.links === "object" && !Array.isArray(payload.links)
      ? (payload.links as Record<string, unknown>)
      : {};
  const links: Record<string, unknown> = { ...existingLinks };
  if (self) {
    links.self = self;
  }
  // List-shaped envelopes always announce `links.next` (null when there is
  // no further page). Non-list envelopes omit `next` to keep wire shape
  // discriminated.
  if (Object.hasOwn(payload, "has_more")) {
    links.next = nextLink;
  }
  next.links = links;
  const existingMeta =
    payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
      ? (payload.meta as Record<string, unknown>)
      : null;
  const meta: Record<string, unknown> = { ...(existingMeta || {}) };
  if (!("count" in meta)) {
    meta.count = { kind: "none" };
  }
  if (!("warnings" in meta)) {
    meta.warnings = [];
  }
  next.meta = meta;
  return next;
}

// biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
async function persistContentAddressedBlob({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
  mimeType,
  data,
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  recordKey: string;
  mimeType: string;
  data: Buffer;
}) {
  return withConnectorInstanceWrite(connectorInstanceId, (ownership) => {
    // The connector-instance existence/status re-check (closing the
    // delete-or-revoke/write TOCTOU) runs INSIDE each backend's own durable
    // write transaction, never here pre-fence: `withConnectorInstanceWrite`
    // is in-process only (SQLite) or ends before the transaction-scoped
    // advisory lock is even acquired (Postgres), so a check performed here
    // would leave the exact async gap this fence exists to close. See
    // postgresPersistContentAddressedBlobWithinFence's unconditional
    // assertPostgresConnectorInstanceWritable call and
    // assertSqliteConnectorInstanceWritableWithinTransaction's call site
    // below. See harden-connector-instance-write-fence-transaction-native.
    return persistContentAddressedBlobWithinFence({
      connectorId,
      connectorInstanceId,
      coordinatorOwnership: ownership,
      data,
      mimeType,
      recordKey,
      stream,
    });
  });
}

async function persistContentAddressedBlobWithinFence({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
  mimeType,
  data,
  coordinatorOwnership,
}: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  recordKey: string;
  mimeType: string;
  data: Buffer;
  coordinatorOwnership: ConnectorInstanceWriteOwnership;
}) {
  if (isPostgresStorageBackend()) {
    const stored = await postgresPersistContentAddressedBlob({
      connectorId,
      connectorInstanceId,
      coordinatorOwnership,
      data,
      mimeType,
      recordKey,
      // Only the HTTP blob-write route reaches this function (see the
      // docstrings above and on postgresPersistContentAddressedBlob) — every
      // call here is an external write that must be refused if the
      // connection was deleted concurrently.
      requireConnectionAdmission: true,
      stream,
    });
    if (stored.binding_inserted) {
      await applyRetainedSizeBlobDelta({
        blobBytesDelta: Number(stored.size_bytes || 0),
        blobCountDelta: 1,
        connectorId,
        connectorInstanceId,
        stream,
      });
    }
    return stored;
  }

  const sha256 = createHash("sha256").update(data).digest("hex");
  const blobId = `blob_sha256_${sha256}`;
  const sizeBytes = data.byteLength;
  const stored = transaction(() => {
    // Only the HTTP blob-write route reaches this function (see the
    // docstrings above and on postgresPersistContentAddressedBlob) — every
    // call here is an external write that must be refused if the connection
    // was deleted or revoked concurrently. Inside the SAME synchronous
    // transaction as the insert below, mirroring the Postgres arm's
    // in-transaction call.
    assertSqliteConnectorInstanceWritableWithinTransaction(connectorInstanceId);
    const insertResult = exec(referenceQueries.blobsInsertBlob, [
      blobId,
      connectorId,
      connectorInstanceId,
      stream,
      recordKey,
      mimeType,
      sizeBytes,
      sha256,
      data,
    ]);

    const rawRow = getOne(referenceQueries.blobsGetStoredById, [blobId]);
    const row = rawRow as Record<string, unknown> | null | undefined;
    if (!row || row.sha256 !== sha256 || Number(row.size_bytes) !== sizeBytes) {
      throw Object.assign(new Error("Blob storage collision"), { code: "api_error" }) as unknown as ApiError;
    }

    const bindingResult = exec(referenceQueries.blobsInsertBinding, [
      blobId,
      connectorId,
      connectorInstanceId,
      stream,
      recordKey,
    ]);
    if (insertResult.changes > 0) {
      applyDatasetSummaryBlobDelta({ blobBytesDelta: sizeBytes });
    }
    if (bindingResult.changes > 0) {
      applyRetainedSizeBlobDelta({
        blobBytesDelta: sizeBytes,
        blobCountDelta: 1,
        connectorId,
        connectorInstanceId,
        stream,
      });
    }

    return row;
  });
  const storedRow = stored as Record<string, unknown>;
  return {
    blob_id: blobId,
    mime_type: storedRow.mime_type || mimeType,
    sha256,
    size_bytes: Number(storedRow.size_bytes),
  };
}

async function getVisibleStreamFreshness({
  tokenInfo,
  source,
  storageBinding,
  stream,
  manifest,
}: {
  tokenInfo: TokenInfo | null | undefined;
  source: { kind?: string; id?: string } | null | undefined;
  storageBinding: StorageBinding;
  stream: string;
  manifest: Record<string, unknown>;
}) {
  const freshnessEvidence = await getConnectorFreshnessEvidence({ manifest, storageBinding });
  const grant =
    tokenInfo?.pdpp_token_kind === "owner"
      ? null
      : ((tokenInfo?.grant as Record<string, unknown> | null | undefined) ?? null);
  const grantStreams = Array.isArray(grant?.streams) ? (grant.streams as Record<string, unknown>[]) : [];
  if (grant && !grantStreams.some((entry) => entry.name === stream)) {
    throw Object.assign(new Error(`Stream '${stream}' not in grant`), {
      code: "grant_stream_not_allowed",
    }) as unknown as ApiError;
  }
  const summaries = await listSubjectVisibleStreamSummaries({
    grant: grant
      ? {
          ...grant,
          streams: grantStreams.filter((entry) => entry.name === stream),
        }
      : null,
    manifest,
    ownerSubjectId: ownerSubjectIdForBindings(tokenInfo),
    source,
    storageBinding,
  });
  const summary = summaries.find((entry) => entry.name === stream);
  return buildConnectorAwareFreshness(freshnessEvidence, (summary?.last_updated as string | null | undefined) || null);
}

// ─── AS App ─────────────────────────────────────────────────────────────────

async function recyclePresentationSurface({
  browserSessionId = null as string | null,
  leaseId: _leaseId = null as string | null,
  logger = null as { warn?: (...args: unknown[]) => void } | null,
  presentationScreenStateStore = null as { markRecycled?: (id: string, ts: string) => Promise<void> } | null,
  surfaceId = null as string | null,
  browserSurfaceAllocator = null as Record<string, unknown> | null,
  browserSurfaceLeaseManager = null as Record<string, unknown> | null,
  browserSurfaceLeaseStore = null as Record<string, unknown> | null,
} = {}) {
  if (!surfaceId) {
    return false;
  }
  let invalidated: Record<string, unknown> | null = null;
  let retired = false;
  try {
    if (typeof (browserSurfaceLeaseManager as Record<string, unknown> | null)?.invalidateSurface === "function") {
      const mgr = browserSurfaceLeaseManager as Record<string, unknown>;
      invalidated = (mgr.invalidateSurface as (...args: unknown[]) => Record<string, unknown>)(surfaceId, {
        reason: "surface_unhealthy",
        releaseLease: true,
      });
      retired = Boolean(invalidated?.surface);
      if (browserSurfaceLeaseStore && invalidated) {
        const store2 = browserSurfaceLeaseStore as Record<string, unknown>;
        await (store2.withLeaseTransaction as (fn: (s: Record<string, unknown>) => Promise<void>) => Promise<void>)(
          async (store) => {
            const inv = invalidated as Record<string, unknown>;
            if (inv.surface) {
              await (store.upsertSurface as (s: unknown) => Promise<void>)({
                ...(inv.surface as object),
                health: "unhealthy",
              });
            }
            if (inv.lease) {
              await (store.upsertLease as (l: unknown) => Promise<void>)(inv.lease);
            }
          }
        );
      }
      if (!retired && typeof mgr.getSurface === "function") {
        // A prior recovery may already have evicted it. It is safe only if it
        // is absent from the lease manager and therefore cannot be reused.
        retired = (mgr.getSurface as (id: string) => unknown)(surfaceId) === null;
      }
    }
    if (typeof (browserSurfaceAllocator as Record<string, unknown> | null)?.stopSurface === "function") {
      const alloc = browserSurfaceAllocator as Record<string, unknown>;
      await (alloc.stopSurface as (args: unknown) => Promise<void>)({ reason: "surface_failed", surfaceId });
      retired = true;
    }
  } catch (err) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    const msg = (err as Error)?.message || String(err);
    logger?.warn?.({ err: msg, surface_id: surfaceId }, "presentation surface recycle failed");
    // A removed/marked-unhealthy surface remains safely unavailable even when
    // the allocator's destructive stop has a transient transport failure.
  }
  if (!retired) {
    throw new Error(`presentation surface ${surfaceId} could not be retired safely`);
  }
  if (browserSessionId && presentationScreenStateStore) {
    await presentationScreenStateStore.markRecycled?.(browserSessionId, new Date().toISOString());
  }
  return true;
}

async function reconcileUnrestoredPresentationScreens({
  browserSurfaceAllocator = null as Record<string, unknown> | null,
  browserSurfaceLeaseManager = null as Record<string, unknown> | null,
  browserSurfaceLeaseStore = null as Record<string, unknown> | null,
  logger = null as { warn?: (...args: unknown[]) => void } | null,
  presentationScreenStateStore = null as {
    listUnrestored?: () => Promise<Record<string, unknown>[]>;
    markRecycled?: (id: string, ts: string) => Promise<void>;
  } | null,
} = {}) {
  if (!presentationScreenStateStore) {
    return;
  }
  const pending = (await presentationScreenStateStore.listUnrestored?.()) ?? [];
  for (const state of pending) {
    // Process death leaves no trustworthy in-process n.eko session with which
    // to issue a restoration request. Retire the captured surface before the
    // lease manager can reuse it; a replacement is a safe clean presentation.
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    await recyclePresentationSurface({
      browserSessionId: state.browserSessionId as string | null,
      browserSurfaceAllocator,
      browserSurfaceLeaseManager,
      browserSurfaceLeaseStore,
      leaseId: state.leaseId as string | null,
      logger,
      presentationScreenStateStore,
      surfaceId: state.surfaceId as string | null,
    });
  }
}

const defaultNekoWindowSettleProbe = (url: string) => fetch(url);

function resolveNekoWindowSettleProbe(probe: ((url: string) => Promise<Response>) | null | undefined) {
  return probe ?? defaultNekoWindowSettleProbe;
}

function authorityRevisionSha(revision: string | null): string | null {
  if (!revision || revision.endsWith(".dirty")) {
    return null;
  }
  return revision.split("+").at(-1) ?? null;
}

async function evaluateOwnerStreamCoverageAuthority({
  referenceRevision,
  summaries,
}: {
  referenceRevision: string;
  summaries: readonly unknown[];
}): Promise<Pick<StreamHealthAuthorityResult, "status">> {
  const connectorIds = new Set<string>();
  for (const summary of summaries) {
    if (summary && typeof summary === "object" && !Array.isArray(summary)) {
      const connectorId = (summary as Record<string, unknown>).connector_id;
      if (typeof connectorId === "string" && connectorId.trim()) {
        connectorIds.add(connectorId.trim());
      }
    }
  }
  const manifests = await Promise.all(
    [...connectorIds].map(async (connectorId) => {
      try {
        return await resolveRegisteredConnectorManifest(connectorId);
      } catch {
        return { connector_id: connectorId, streams: [] };
      }
    })
  );
  // Summary JSON is not rendered Sources evidence. Sources is master-detail:
  // all source markers render, but stream rows render only for the selected
  // source. Do not fabricate DOM rows from the summary projection.
  const dom: OwnerSourcesDomEvidence | null = null;
  const authority = evaluateStreamHealthAuthority({
    auth: { authenticated: true, mode: "owner-session", resolved: true },
    connections: summaries,
    dom,
    manifests,
    paginationComplete: true,
    revision: {
      dom: referenceRevision,
      expected: referenceRevision,
      sha: authorityRevisionSha(referenceRevision),
      summaries: referenceRevision,
    },
  });
  return { status: authority.coverageStatus };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
export function buildAsApp(opts: ServerOpts = {}) {
  const app = createApp({ ...(opts.logger === null ? {} : { logger: opts.logger }) });
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  const referenceRevision = resolveReferenceRevision({
    ...(opts.referenceRevision === null ? {} : { referenceRevision: opts.referenceRevision }),
  });
  // Allow tests / fixture-backed smokes to pin the server to an old or
  // alternate accepted-protocol set so we can exercise the 409
  // collector_protocol_mismatch path without bumping the global
  // SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS. Falls back to the global set
  // for normal operation.
  const acceptedCollectorProtocolVersions =
    Array.isArray(opts.acceptedCollectorProtocolVersions) && opts.acceptedCollectorProtocolVersions.length > 0
      ? Object.freeze([...opts.acceptedCollectorProtocolVersions])
      : SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS;
  const controller = opts.controller || null;
  const consentStore = createConsentStore();
  const ownerDeviceAuthStore = createOwnerDeviceAuthStore() as unknown as OwnerDeviceAuthStore;
  const deviceExporterStore = opts.deviceExporterStore || createDeviceExporterStore();
  const webPushStore = opts.webPushSubscriptionStore || createWebPushSubscriptionStore();
  const webPushConfig = opts.webPushConfig || resolveWebPushConfig();
  const dynamicClientRegistrationEnabled = resolveDynamicClientRegistrationEnabled(opts);
  const dynamicClientRegistrationInitialAccessTokens = resolveDynamicClientRegistrationInitialAccessTokens(opts);
  const publicDcrRateLimiter = createPublicDcrRateLimiter(opts.publicDynamicClientRegistrationRateLimit ?? undefined);
  const ownerAuthConfig = resolveOwnerAuthPlaceholderConfig(opts);
  // Owner-exposure posture flows in from startServer. When buildAsApp is
  // driven directly (a few low-level tests), no posture is supplied and we
  // default to the historical open-when-disabled, unlocked-registry behavior
  // so those fixtures stay frictionless. Production always supplies a posture.
  const ownerExposurePosture = opts.ownerExposurePosture ?? null;
  const allowUnauthenticatedOwnerWhenDisabled = ownerExposurePosture
    ? ownerExposurePosture.allowUnauthenticatedOwnerWhenDisabled
    : true;
  const lockConnectorRegistry = ownerExposurePosture ? ownerExposurePosture.lockConnectorRegistry : false;
  const ownerAuth = createOwnerAuthPlaceholder({
    password: ownerAuthConfig.password,
    subjectId: ownerAuthConfig.subjectId,
    ...(ownerAuthConfig.sessionTtlSeconds === null || ownerAuthConfig.sessionTtlSeconds === undefined
      ? {}
      : { sessionTtlSeconds: ownerAuthConfig.sessionTtlSeconds }),
    forceSecureCookies: ownerAuthConfig.forceSecureCookies,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    ...(ownerAuthConfig.sameSite === null || ownerAuthConfig.sameSite === undefined
      ? {}
      : { sameSite: ownerAuthConfig.sameSite as import("./owner-session.ts").OwnerSessionSameSite }),
    allowUnauthenticatedWhenDisabled: allowUnauthenticatedOwnerWhenDisabled,
    providerName,
  });
  app.use((..._args: never[]) => {
    const [req, res, next] = _args as unknown as [ReqLike, ResLike, () => void];
    (res as ResLike).setHeader("Request-Id", (req as ReqLike).get("Request-Id") || generateSpineId("req"));
    setReferenceRevisionHeader(res as ResLike, referenceRevision);
    // Clickjacking defense for reference hosted-UI pages (consent, device,
    // owner-login, approval results). The headers are harmless on JSON
    // responses, so we set them on every AS response. See
    // openspec/changes/harden-reference-auth-surfaces/specs/
    //   reference-implementation-architecture/spec.md
    (res as ResLike).setHeader("X-Frame-Options", "DENY");
    (res as ResLike).setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    next();
  });

  // Shared hosted-UI stylesheet for reference server-rendered HTML pages
  // (consent, device, approval results, owner-login). This is a
  // reference-only asset, not a PDPP protocol surface. Mounted via
  // `server/routes/hosted-ui-asset.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Behaviour-preserving extraction:
  // same path, same headers, same registration order.
  mountHostedUiCss(app);

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

  function getOwnerSubjectId(req: ReqLike): string {
    return (
      (req.ownerSession as { sub?: string } | null | undefined)?.sub ||
      ownerAuth.subjectId ||
      OWNER_AUTH_DEFAULT_SUBJECT_ID
    );
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
  function enforceCollectorProtocolVersion(req: ReqLike, res: ResLike): boolean {
    const received = readCollectorProtocolHeader(req.headers as Record<string, string | string[] | undefined>);
    if (!isAcceptedCollectorProtocolVersion(received, acceptedCollectorProtocolVersions)) {
      const error: Record<string, unknown> = {
        code: "collector_protocol_mismatch",
        message: received
          ? `Collector protocol version '${received}' is not accepted by this reference server.`
          : "Collector protocol version header X-PDPP-Collector-Protocol is required.",
        type: typeFor(409),
        ...buildCollectorProtocolMismatchBody(received, acceptedCollectorProtocolVersions),
        request_id: ensureRequestId(res),
      };
      res.status(409).json({ error });
      return true;
    }
    return false;
  }

  async function requireDeviceExporterCredential(req: ReqLike, res: ResLike, next: () => void) {
    try {
      // Reject incompatible collector protocol versions before any device
      // capability is established. The check sits ahead of credential
      // introspection so an outdated runner can't even prove its token to
      // mint a record on this server. Spec: openspec/changes/
      // publish-pdpp-local-collector.
      if (enforceCollectorProtocolVersion(req, res)) {
        return;
      }
      const rawAuth = req.headers?.authorization;
      const auth = typeof rawAuth === "string" ? rawAuth : null;
      if (!auth?.startsWith("Bearer ")) {
        return pdppError(res, 401, "authentication_error", "Missing device exporter bearer token");
      }
      const token = auth.slice(7);
      const tokenInfo = await introspect(token);
      if (tokenInfo.active) {
        return pdppError(
          res,
          403,
          "permission_error",
          "Owner/client bearer tokens are not valid device exporter credentials"
        );
      }

      const exporterStore = deviceExporterStore as Record<string, (...args: unknown[]) => unknown>;
      const credential = await (
        exporterStore.findCredentialByTokenHash as (hash: string) => Promise<Record<string, unknown> | null>
      )(hashDeviceSecret(token));
      if (credential?.status !== "active") {
        return pdppError(res, 401, "authentication_error", "Invalid or revoked device exporter credential");
      }
      const device = await (exporterStore.getDevice as (id: unknown) => Promise<Record<string, unknown> | null>)(
        credential.deviceId
      );
      if (device?.status !== "active") {
        return pdppError(res, 401, "authentication_error", "Invalid or revoked device exporter credential");
      }
      await (exporterStore.markCredentialUsed as (id: unknown, ts: string) => Promise<void>)(
        credential.credentialId,
        new Date().toISOString()
      );
      (req as unknown as Record<string, unknown>).deviceExporterCredential = credential;
      (req as unknown as Record<string, unknown>).deviceExporter = device;
      next();
    } catch (err) {
      handleError(res, err as ApiError);
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
  // See `reference-implementation/server/streaming/run-target-registry.ts`.
  //
  // Caller-provided registries are accepted so the controller and the route
  // layer share one instance — the controller needs to register/clear
  // per-run nonces it mints at spawn time, and the routes need to verify
  // them at registration time. Tests that build an asApp standalone still
  // get a self-owned registry; the route layer is unchanged.
  const runTargetRegistry =
    opts.runTargetRegistry ||
    (createRunTargetRegistry as (...args: unknown[]) => import("./streaming/run-target-registry.ts").RunTargetRegistry)(
      { ...(opts.streamingLogger === null ? {} : { logger: opts.streamingLogger }) }
    );
  runTargetRegistry.attachRoutes(app, requireDeviceExporterCredential);

  // renderPendingConsentNotFoundHtml, renderPendingGrantConsentHtml, and
  // renderHostedMcpSourceSelection extracted to
  // `server/routes/as-consent-ui-helpers.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Call sites below pass the
  // required context arguments explicitly.

  // biome-ignore lint/suspicious/noShadow: The local name follows the external payload vocabulary at this boundary.
  async function getPendingGrantFromRequestUri(requestUri: string, opts: Record<string, unknown> = {}) {
    const deviceCode = consentStore.parseRequestUri(requestUri);
    if (!deviceCode) {
      return { deviceCode: null, pending: null };
    }
    const pending = await consentStore.getPendingConsentByDeviceCode(deviceCode, opts);
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
    buildApprovalUrl: (baseUrl, requestUri) => {
      const u = new URL(`${baseUrl}/consent`);
      u.searchParams.set("request_uri", requestUri);
      return u.toString();
    },
    buildTokenUrl: (baseUrl, id) => `${baseUrl}/agent-connect/${encodeURIComponent(id)}/token`,
    generateAttemptId: () => `agc_${randomBytes(16).toString("hex")}`,
    generatePollingCode: () => `agc_poll_${randomBytes(32).toString("hex")}`,
    async getPendingGrantFromRequestUri(requestUri, opts2 = {}) {
      const { pending } = await getPendingGrantFromRequestUri(requestUri, opts2);
      if (!pending) {
        return null;
      }
      const pendingRec = pending as Record<string, unknown>;
      const pendingReq = (pendingRec.request || {}) as Record<string, unknown>;
      const pendingClient = (pendingReq.client || {}) as Record<string, unknown>;
      const pendingClientId = (pendingClient.client_id as string | null | undefined) || null;
      return { pendingClientId };
    },
    handleError: (res, err) => handleError(res as ResLike, err as ApiError),
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async initiateNativeGrant({ baseUrl, clientId, clientName }) {
      const nativeManifest = resolveNativeManifest(opts);
      const nativeStorageBinding = (nativeManifest?.storage_binding || {}) as Record<string, unknown>;
      const configuredSource = buildSourceDescriptor(
        (nativeManifest?.source_declaration as { source?: { id?: string; kind?: string } } | undefined)?.source ?? null
      );
      if (!(configuredSource && nativeStorageBinding.connector_id)) {
        return null;
      }
      return consentStore.initiateGrant(
        {
          authorization_details: [
            {
              access_mode: "single_use",
              purpose_code: "https://pdpp.dev/purpose/personal_assistant",
              purpose_description: "Delegate scoped personal data access to a local PDPP CLI client.",
              source: configuredSource,
              streams: [{ name: "*" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_display: { name: clientName },
          client_id: clientId,
        },
        { baseUrl, nativeManifest }
      );
    },
    now: () => Date.now(),
    pdppCliDefaultClientId: PDPP_CLI_DEFAULT_CLIENT_ID,
    pdppError: pdppError as import("./routes/_route-contract.ts").PdppErrorFn,
    resolveBaseUrl: (req: unknown) => {
      const explicitBaseUrl = opts.asPublicUrl || (opts.ignoreAmbientPublicUrls ? null : process.env.AS_PUBLIC_URL);
      return resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitBaseUrl);
    },
  });

  mountAsAgentConnectToken(app, {
    agentConnectAttemptStore,
    handleError: (res, err) => handleError(res as ResLike, err as ApiError),
    pdppError,
  });

  // AS `/.well-known/oauth-authorization-server` is mounted via
  // `server/routes/root-and-discovery.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Behaviour-preserving
  // extraction: same mount point, same handler, same envelope.
  mountAsAuthorizationServerMetadata(app, {
    buildAuthorizationServerMetadata: buildAuthorizationServerMetadata as unknown as Parameters<
      typeof mountAsAuthorizationServerMetadata
    >[1]["buildAuthorizationServerMetadata"],
    cimdEnabled: opts.cimdEnabled !== false,
    dynamicClientRegistrationEnabled,
    publicClientMetadataForAuthorizationServer: publicClientMetadataForAuthorizationServer as unknown as Parameters<
      typeof mountAsAuthorizationServerMetadata
    >[1]["publicClientMetadataForAuthorizationServer"],
    rejectUntrustedMetadataHost: rejectUntrustedMetadataHost as unknown as Parameters<
      typeof mountAsAuthorizationServerMetadata
    >[1]["rejectUntrustedMetadataHost"],
    resolveExplicitIssuer: () =>
      opts.asIssuer ||
      opts.asPublicUrl ||
      (opts.ignoreAmbientPublicUrls ? null : process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) ||
      null,
    resolvePreRegisteredPublicClients: () => resolvePreRegisteredPublicClients(opts) as unknown[],
    resolvePublicUrl: resolvePublicUrl as unknown as Parameters<
      typeof mountAsAuthorizationServerMetadata
    >[1]["resolvePublicUrl"],
    trustedMetadataHosts: opts.trustedMetadataHosts,
  });

  mountClientMetadata(app as unknown as Parameters<typeof mountClientMetadata>[0], {
    explicitIssuer:
      opts.asIssuer ||
      opts.asPublicUrl ||
      (opts.ignoreAmbientPublicUrls ? null : process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) ||
      null,
    getCimdDocument: getCimdDocument as unknown as Parameters<typeof mountClientMetadata>[1]["getCimdDocument"],
    resolvePublicUrl: resolvePublicUrl as unknown as Parameters<typeof mountClientMetadata>[1]["resolvePublicUrl"],
  });

  // DCR register/delete routes — extracted to routes/as-dcr.ts per
  // openspec/changes/split-reference-server-by-route-family.
  mountAsDcr(app, {
    createTraceContext,
    dcrEnabled: dynamicClientRegistrationEnabled,
    deleteRegisteredClient: deleteRegisteredClient as unknown as Parameters<
      typeof mountAsDcr
    >[1]["deleteRegisteredClient"],
    emitSpineEvent: emitSpineEvent as unknown as Parameters<typeof mountAsDcr>[1]["emitSpineEvent"],
    oauthError: (res, status, code, message) => oauthError(res as ResLike, status, code, message),
    ownerSubjectId: ownerAuth.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID,
    pdppError,
    publicDcrRateLimiter: publicDcrRateLimiter as unknown as Parameters<typeof mountAsDcr>[1]["publicDcrRateLimiter"],
    readOwnerSession: ownerAuth.readOwnerSession as unknown as Parameters<typeof mountAsDcr>[1]["readOwnerSession"],
    registerDynamicClient: registerDynamicClient as unknown as Parameters<
      typeof mountAsDcr
    >[1]["registerDynamicClient"],
    requireOwnerSession: ownerAuth.requireOwnerSession as unknown as Parameters<
      typeof mountAsDcr
    >[1]["requireOwnerSession"],
    resolveInitialAccessTokensForRequest: (req: unknown) =>
      resolveDynamicClientRegistrationInitialAccessTokensForRequest(
        req as ReqLike,
        dynamicClientRegistrationInitialAccessTokens
      ),
    setReferenceTraceId: (res, traceId) => setReferenceTraceId(res as ResLike, traceId),
    updateRegisteredClientName: updateRegisteredClientName as unknown as Parameters<
      typeof mountAsDcr
    >[1]["updateRegisteredClientName"],
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
    canonicalConnectorKey,
    encodeHostedMcpSelection,
    encodeHostedMcpStreamSelection,
    getConnectorManifest,
    hostedMcpSourceKey,
    isInternalConnectorId,
    listActiveBindingsForGrant,
    listRegisteredConnectorIds,
    listStreamsWithRecords: async ({
      connectorId,
      connectorInstanceId,
    }: {
      connectorId: string;
      connectorInstanceId: string | null;
    }): Promise<string[]> => {
      const rows = await listRetainedSizeStreams({
        connectorId,
        ...(connectorInstanceId ? { connectorInstanceId } : {}),
      });
      return rows.filter((row) => Number(row.record_count || 0) > 0).map((row) => String(row.stream));
    },
    projectBindingForWire,
  };
  const explicitAsBaseUrl = opts.asPublicUrl || (opts.ignoreAmbientPublicUrls ? null : process.env.AS_PUBLIC_URL);
  const onCimdTransportFailure = (event: import("./cimd.ts").CimdTransportFailureEvent) =>
    opts.logger?.warn?.(event, "CIMD transport failure");

  // GET /oauth/authorize and POST /oauth/authorize/mcp-package extracted to
  // `server/routes/as-authorize.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§6). Behaviour-preserving:
  // same owner-session + CSRF enforcement, same PKCE validation, same
  // consentStore.initiateGrant delegation, same createHostedMcpGrantPackage
  // delegation, same auth-code staging and redirect.
  mountAsAuthorize(app, {
    asPublicUrl: opts.asPublicUrl || null,
    consentPickerCaps: consentPickerCaps as unknown as Parameters<typeof mountAsAuthorize>[1]["consentPickerCaps"],
    consentStore: consentStore as unknown as Parameters<typeof mountAsAuthorize>[1]["consentStore"],
    consentUi: consentUi as unknown as Parameters<typeof mountAsAuthorize>[1]["consentUi"],
    createHostedMcpGrantPackage: createHostedMcpGrantPackage as unknown as Parameters<
      typeof mountAsAuthorize
    >[1]["createHostedMcpGrantPackage"],
    ensureCsrfToken: ownerAuth.ensureCsrfToken as unknown as Parameters<typeof mountAsAuthorize>[1]["ensureCsrfToken"],
    ensureRequestId: ensureRequestId as unknown as Parameters<typeof mountAsAuthorize>[1]["ensureRequestId"],
    getRegisteredClient: ((clientId: string, correlation: { requestId: string | null; traceId: string | null }) =>
      resolveOAuthClient(clientId, {
        ...(explicitAsBaseUrl ? { baseUrl: explicitAsBaseUrl } : {}),
        ...(opts.cimdFetchDependencies ? { cimdFetchDependencies: opts.cimdFetchDependencies } : {}),
        onCimdTransportFailure,
        requestId: correlation.requestId,
        traceId: correlation.traceId,
      })) as unknown as Parameters<typeof mountAsAuthorize>[1]["getRegisteredClient"],
    ignoreAmbientPublicUrls: !!opts.ignoreAmbientPublicUrls,
    issueOAuthAuthorizationCodeForPackageDeviceCode:
      issueOAuthAuthorizationCodeForPackageDeviceCode as unknown as Parameters<
        typeof mountAsAuthorize
      >[1]["issueOAuthAuthorizationCodeForPackageDeviceCode"],
    nativeManifest: resolveNativeManifest(opts),
    oauthError: (res, status, code, message, extras) => oauthError(res as ResLike, status, code, message, null, extras),
    providerName,
    requireCsrf: ownerAuth.requireCsrf as unknown as Parameters<typeof mountAsAuthorize>[1]["requireCsrf"],
    requireOwnerSession: ownerAuth.requireOwnerSession as unknown as Parameters<
      typeof mountAsAuthorize
    >[1]["requireOwnerSession"],
    resolvePublicUrl: resolvePublicUrl as unknown as Parameters<typeof mountAsAuthorize>[1]["resolvePublicUrl"],
    selectionParsers: {
      parseHostedMcpSelections: parseHostedMcpSelections as unknown as Parameters<
        typeof mountAsAuthorize
      >[1]["selectionParsers"]["parseHostedMcpSelections"],
      parseHostedMcpStreamSelections: parseHostedMcpStreamSelections as unknown as Parameters<
        typeof mountAsAuthorize
      >[1]["selectionParsers"]["parseHostedMcpStreamSelections"],
    },
    stageOAuthAuthorizationCodeRequest: stageOAuthAuthorizationCodeRequest as unknown as Parameters<
      typeof mountAsAuthorize
    >[1]["stageOAuthAuthorizationCodeRequest"],
  });
  // POST /oauth/device_authorization and POST /oauth/token extracted to
  // `server/routes/as-oauth.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§6). Behaviour-preserving:
  // same contract metadata, same auth posture (none — public endpoints),
  // same trace-id header wiring, same response envelopes, same status codes.
  const asDeviceAuthContext = {
    initiateDeviceAuth: (clientId: string, opts2?: Record<string, unknown>) =>
      ownerDeviceAuthStore.initiate(clientId, opts2),
    initiateMcpDeviceAuth: async (
      {
        clientId,
        resource,
        authorizationDetails,
      }: { clientId: string; resource: string; authorizationDetails: unknown },
      opts2: { baseUrl: string }
    ) => {
      let resourceUrl: URL | undefined;
      try {
        resourceUrl = new URL(resource);
      } catch {
        const err = Object.assign(new Error("resource must be an absolute MCP protected-resource URL"), {
          code: "invalid_request",
        }) as unknown as ApiError;
        // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
        throw err;
      }
      if (resourceUrl.pathname !== "/mcp") {
        const err = Object.assign(new Error("resource must identify the hosted MCP protected resource"), {
          code: "invalid_request",
        }) as unknown as ApiError;
        throw err;
      }

      const initiated = await consentStore.initiateGrant(
        {
          authorization_details: authorizationDetails,
          client_id: clientId,
        },
        {
          baseUrl: opts2.baseUrl,
          ...(opts.cimdFetchDependencies ? { cimdFetchDependencies: opts.cimdFetchDependencies } : {}),
          nativeManifest: resolveNativeManifest(opts),
          onCimdTransportFailure,
        }
      );
      const initiatedR = initiated as unknown as Record<string, unknown>;
      const deviceCode = consentStore.parseRequestUri(initiatedR.request_uri as string);
      if (!(deviceCode && initiatedR.user_code)) {
        const err = Object.assign(new Error("Grant-scoped device authorization could not be created"), {
          code: "server_error",
        }) as unknown as ApiError;
        throw err;
      }
      return {
        device_code: deviceCode,
        expires_in: initiatedR.expires_in as number,
        interval: 2,
        trace_context: initiatedR.trace_context as Record<string, unknown> | null,
        user_code: initiatedR.user_code as string,
        verification_uri: `${opts2.baseUrl}/consent`,
        verification_uri_complete: initiatedR.authorization_url as string,
      };
    },
    oauthError,
    resolveBaseUrl: (req: unknown) => {
      const explicitBaseUrl = opts.asPublicUrl || (opts.ignoreAmbientPublicUrls ? null : process.env.AS_PUBLIC_URL);
      return resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitBaseUrl);
    },
    setReferenceTraceId,
  };
  mountAsDeviceAuthorization(app, asDeviceAuthContext as unknown as Parameters<typeof mountAsDeviceAuthorization>[1]);

  const asTokenContext = {
    exchangeDeviceCode: (args: { clientId: string; deviceCode: string }) =>
      typeof args.deviceCode === "string" && args.deviceCode.startsWith("dc_owner_")
        ? ownerDeviceAuthStore.exchangeDeviceCode(args)
        : exchangeGrantScopedDeviceCode(args),
    exchangeOAuthAuthorizationCode,
    exchangeOAuthRefreshToken,
    oauthError,
    resolveBaseUrl: (req: unknown) => {
      const explicitBaseUrl = opts.asPublicUrl || (opts.ignoreAmbientPublicUrls ? null : process.env.AS_PUBLIC_URL);
      return resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitBaseUrl);
    },
    setReferenceTraceId,
  };
  mountAsToken(app, asTokenContext as unknown as Parameters<typeof mountAsToken>[1]);

  // GET /device, POST /device/approve, POST /device/deny extracted to
  // `server/routes/as-device-ui.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§6). Behaviour-preserving:
  // same owner-session + CSRF enforcement, same subject-id resolution,
  // same hosted-UI HTML rendering, same error mapping.
  mountAsDeviceUi(app, {
    deviceDecision: {
      approve: (userCode: string, subjectId: string) => ownerDeviceAuthStore.approve(userCode, subjectId),
      deny: (userCode: string, subjectId: string) => ownerDeviceAuthStore.deny(userCode, subjectId),
      getByApprovalId: (approvalId: string) => ownerDeviceAuthStore.getByApprovalId(approvalId),
    },
    ensureCsrfToken: ownerAuth.ensureCsrfToken,
    getByUserCode: (userCode: string) => ownerDeviceAuthStore.getByUserCode(userCode),
    oauthError,
    ownerAuthDefaultSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    ownerAuthEnabled: ownerAuth.enabled,
    ownerSubjectId: ownerAuth.subjectId,
    providerName,
    renderCsrfField: (token: string) => ownerAuth.renderCsrfField(token),
    requireCsrf: ownerAuth.requireCsrf,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    setReferenceTraceId,
    ui: {
      escapeHtml: hostedEscape,
      renderEmptyState,
      renderHostedDocument,
      renderKeyValueList,
      renderPageIntro,
      renderResultState,
      renderSurface,
    },
  } as unknown as Parameters<typeof mountAsDeviceUi>[1]);

  const introspectionCallerCredentials = opts.introspectionCallerCredentials ?? readIntrospectionCredentialsFromEnv();
  if (!introspectionCallerCredentials) {
    throw new Error("AS introspection caller credentials must be configured");
  }
  mountAsIntrospect(app, {
    authenticateCaller: (authorization) =>
      authenticateIntrospectionCaller(authorization, introspectionCallerCredentials),
    introspect: async (token) => projectSourceIntrospectionWireContext(await introspect(token)),
    pdppError,
    resolveAudience: opts.resolveIntrospectionAudience ?? (() => opts.rsPublicUrl ?? null),
    resolveIssuer: opts.resolveIntrospectionIssuer ?? (() => opts.asIssuer ?? opts.asPublicUrl ?? null),
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
    canonicalConnectorKey,
    handleError,
    listSpineCorrelations: (kind: string, filters: Record<string, unknown>) => listSpineCorrelations(kind, filters),
    requireOwnerSession: ownerAuth.requireOwnerSession,
  };
  mountRefTraces(app, refSpineCorrelationsContext as unknown as Parameters<typeof mountRefTraces>[1]);
  mountRefGrants(app, refSpineCorrelationsContext as unknown as Parameters<typeof mountRefGrants>[1]);
  mountRefRuns(app, refSpineCorrelationsContext as unknown as Parameters<typeof mountRefRuns>[1]);

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
    countGrantPackagesForOwner,
    getClientEventSubscriptionStore: getDefaultClientEventSubscriptionStore,
    getCumulativeClientAccessForPackage,
    getGrantPackageForOwner,
    getSubscriptionSummary,
    handleError,
    listAllSubscriptions,
    listAttemptsForSubscription,
    listGrantPackagesForOwner,
    nowIso: () => new Date().toISOString(),
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    revokeGrantPackage,
  };
  mountRefGrantPackagesList(app, refGrantsContext as unknown as Parameters<typeof mountRefGrantPackagesList>[1]);
  mountRefGrantPackagesCount(app, refGrantsContext as unknown as Parameters<typeof mountRefGrantPackagesCount>[1]);
  mountRefGrantPackagesGet(app, refGrantsContext as unknown as Parameters<typeof mountRefGrantPackagesGet>[1]);
  mountRefGrantPackagesCumulative(
    app,
    refGrantsContext as unknown as Parameters<typeof mountRefGrantPackagesCumulative>[1]
  );
  mountRefGrantPackagesRevoke(app, refGrantsContext as unknown as Parameters<typeof mountRefGrantPackagesRevoke>[1]);
  mountRefEventSubscriptionsList(
    app,
    refGrantsContext as unknown as Parameters<typeof mountRefEventSubscriptionsList>[1]
  );
  mountRefEventSubscriptionsGet(
    app,
    refGrantsContext as unknown as Parameters<typeof mountRefEventSubscriptionsGet>[1]
  );
  mountRefEventSubscriptionsDisable(
    app,
    refGrantsContext as unknown as Parameters<typeof mountRefEventSubscriptionsDisable>[1]
  );

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
  mountRefWebPushConfig(app, refWebPushContext as unknown as Parameters<typeof mountRefWebPushConfig>[1]);
  mountRefWebPushListSubscriptions(
    app,
    refWebPushContext as unknown as Parameters<typeof mountRefWebPushListSubscriptions>[1]
  );
  mountRefWebPushCreateSubscription(
    app,
    refWebPushContext as unknown as Parameters<typeof mountRefWebPushCreateSubscription>[1]
  );
  mountRefWebPushDeleteSubscription(
    app,
    refWebPushContext as unknown as Parameters<typeof mountRefWebPushDeleteSubscription>[1]
  );
  mountRefWebPushTest(app, refWebPushContext as unknown as Parameters<typeof mountRefWebPushTest>[1]);

  // `/_ref/search`, `/_ref/approvals`, `/_ref/records/timeline`,
  // `/_ref/schedules`, `/_ref/deployment`, and `/_ref/clients` routes
  // extracted to `server/routes/ref-admin.ts` per
  // `split-reference-server-by-route-family` §2.5. The host wires
  // capability-shaped substrate dependencies; the adapter owns owner-auth,
  // contract metadata, response writing, and query-string parsing.
  const refAdminContext = {
    collectDeploymentReport: (req: unknown) =>
      (collectDeploymentDiagnostics as (...a: unknown[]) => unknown)(
        {
          computeIndexState: () => computeSemanticIndexState(),
          getBackend: () => getSemanticBackend(),
          getBackfillProgress: () => getSemanticIndexBackfillProgress(),
          getConfiguredNativeManifest: () => getConfiguredNativeManifest(),
          getConnectorManifest: (connectorId: string) => getConnectorManifest(connectorId),
          getDb: () => getDb(),
          getDiskHeadroom: () => probeDiskHeadroom(opts.dbPath || DB_PATH),
          getLexicalBackendPosture: () => getPostgresLexicalBackendState(),
          getLexicalBackfillProgress: () => getLexicalIndexBackfillProgress(),
          getPhysicalFootprint: () => collectPhysicalFootprint(),
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
          getRuntimeCapabilityPosture: async () => {
            const inContainer = process.env.PDPP_FORCE_CONTAINER === "1" || existsSync("/.dockerenv");
            let collectorPaired = false;
            // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
            let pairing = null;
            try {
              const subjectId = getOwnerSubjectId(req as ReqLike);
              const exporterStoreCast = deviceExporterStore as { listDevices: (...args: unknown[]) => unknown };
              const devices = await exporterStoreCast.listDevices(subjectId);
              const activeDevices = Array.isArray(devices)
                ? (devices as Record<string, unknown>[]).filter((d) => d.status === "active")
                : [];
              collectorPaired = activeDevices.length > 0;
              if (collectorPaired) {
                const sorted = [...activeDevices].sort((a, b) => {
                  const aT = Date.parse((a.lastHeartbeatAt || a.updatedAt || a.createdAt || "") as string) || 0;
                  const bT = Date.parse((b.lastHeartbeatAt || b.updatedAt || b.createdAt || "") as string) || 0;
                  return bT - aT;
                });
                const outdated = activeDevices.some(
                  (d) => !SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS.includes((d.collectorProtocolVersion || "") as string)
                );
                const outdatedDevice = outdated
                  ? activeDevices.find(
                      (d) =>
                        !SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS.includes((d.collectorProtocolVersion || "") as string)
                    )
                  : null;
                const representative = outdatedDevice || sorted[0];
                const observedVersion = (representative?.collectorProtocolVersion ?? null) as string | null;
                pairing = {
                  connector_versions: {},
                  protocol_outdated: outdated,
                  protocol_version: observedVersion ?? (representative ? "legacy_unknown" : null),
                  runner_version: (representative?.agentVersion ?? null) as string | null,
                };
              }
            } catch {
              collectorPaired = false;
              pairing = null;
            }
            return {
              accepted_collector_protocol_versions: [...SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS],
              bindings: {
                browser: runtimeBrowserCapabilityFromEnv(process.env),
                filesystem: true,
                local_device: false,
                network: true,
              },
              collector_paired: collectorPaired,
              collector_pairing: pairing,
              in_container: inContainer,
            };
          },
          listRegisteredConnectorIds: () => listRegisteredConnectorIds(),
        },
        { dbPath: opts.dbPath || DB_PATH }
      ),
    collectRecordsTimelineEntries: (input: unknown) =>
      (collectRecordsTimelineEntries as (i: unknown) => unknown)(input),
    createCimdDocument: (input: unknown) => (createCimdDocument as (i: unknown) => unknown)(input),
    deleteCimdDocument: (documentId: string, options: unknown) =>
      (deleteCimdDocument as (d: string, o: unknown) => unknown)(documentId, options),
    getCimdDocument: (documentId: string) => getCimdDocument(documentId),
    getOwnerSubjectId,
    getPendingApprovalDetail: (approvalId: string) => getPendingApprovalDetail(approvalId),
    handleError,
    listActiveTokensForOwnerClient: (clientId: string, subjectId: string) =>
      listActiveTokensForOwnerClient(clientId, subjectId),
    listCimdDocuments: () => listCimdDocuments(),
    listOwnerIssuedClients: (subjectId: string) => listOwnerIssuedClients(subjectId),
    listPendingApprovals: () => listPendingApprovals(),
    listSchedules: async () => (controller ? await controller.listSchedules() : []),
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolveBaseUrl: (req: unknown) =>
      resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitAsBaseUrl),
    resolveSingleConnectorIdQueryValue,
    revokeOwnerClientTokenByPublicId: (clientId: string, tokenIdPublic: string, subjectId: string) =>
      revokeOwnerClientTokenByPublicId(clientId, tokenIdPublic, subjectId),
    searchSpine: (query: string) => searchSpine(query),
  };
  mountRefSearch(app, refAdminContext as unknown as Parameters<typeof mountRefSearch>[1]);
  mountRefApprovals(app, refAdminContext as unknown as Parameters<typeof mountRefApprovals>[1]);
  mountRefCimdClientDocuments(app, refAdminContext as unknown as Parameters<typeof mountRefCimdClientDocuments>[1]);

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
    getRunTerminalStatus: (runId: string) => getRunTerminalStatus(runId),
    handleError,
    // biome-ignore lint/suspicious/noShadow: The local name follows the external payload vocabulary at this boundary.
    listSpineEventsPage: (kind: string, id: string, opts: unknown) =>
      listSpineEventsPage(
        kind as Parameters<typeof listSpineEventsPage>[0],
        id,
        opts as Parameters<typeof listSpineEventsPage>[2]
      ),
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
  };
  mountRefTraceTimeline(app, refSpineTimelinesContext as unknown as Parameters<typeof mountRefTraceTimeline>[1]);
  mountRefGrantTimeline(app, refSpineTimelinesContext as unknown as Parameters<typeof mountRefGrantTimeline>[1]);
  mountRefRunTimeline(app, refSpineTimelinesContext as unknown as Parameters<typeof mountRefRunTimeline>[1]);

  // Run-handle status route (`GET /_ref/runs/:runId`). Resolves any run id
  // returned by a 202 run-now ack — active runs via the controller's
  // in-process bookkeeping, finished runs via the run's terminal spine
  // event — so a run handle never dangles into Express's default 404 once
  // the run leaves `controller_active_runs` flight state. Unknown ids get
  // a typed `not_found` envelope.
  // See openspec/changes/surface-run-handle-resolvability.
  mountRefRunStatus(app, {
    controller,
    getLatestRunEvent: async (runId: string) => {
      const page = await listSpineEventsPage("run", runId, { limit: 20 });
      return (page.events.at(-1) ?? null) as unknown as Parameters<
        typeof mountRefRunStatus
      >[1]["getLatestRunEvent"] extends (id: string) => Promise<infer R>
        ? R
        : never;
    },
    getRunStartedEvent: (runId: string) => getRunStartedEvent(runId),
    getRunTerminalEvent: (runId: string) => getRunTerminalEvent(runId),
    handleError,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
  } as unknown as Parameters<typeof mountRefRunStatus>[1]);

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
  const streamingSessions =
    opts.streamingSessionStore ||
    createStreamingSessionStore({
      ...(opts.streamingNow === null ? {} : { now: opts.streamingNow }),
      ...(opts.streamingSessionTtlMs === null ? {} : { ttlMs: opts.streamingSessionTtlMs }),
    });
  // Distinguish "caller did not specify" (use default registry-backed factory)
  // from "caller passed null" (explicit fail-closed; mint route returns 503).
  // The default factory always exists because the registry resolver always
  // exists, so a plain `||` fallback would silently turn an explicit null
  // back into a working factory and lose the fail-closed test seam.
  const streamingCompanionFactory =
    opts.streamingCompanionFactory === undefined
      ? (
          createDefaultStreamingCompanionFactory as (
            ...args: unknown[]
          ) => ReturnType<typeof createDefaultStreamingCompanionFactory>
        )({
          resolveTargetForInteraction: (runId: string, interactionId: string) =>
            runTargetRegistry.get({ interactionId, runId }),
          ...(opts.streamingLogger === null ? {} : { logger: opts.streamingLogger }),
          neko: {
            cdpHttpUrl: process.env.PDPP_NEKO_CDP_HTTP_URL || process.env.NEKO_CDP_HTTP_URL || undefined,
            screenConfigurationsEndpoint: "api/room/screen/configurations",
            screenEndpoint: "api/room/screen",
          },
          presentationScreenStateStore: opts.presentationScreenStateStore || null,
        })
      : opts.streamingCompanionFactory;
  const originalCancelRun =
    controller && typeof controller.cancelRun === "function" ? controller.cancelRun.bind(controller) : null;
  const streamingRoutes = (
    registerStreamingRoutes as (...args: unknown[]) => ReturnType<typeof registerStreamingRoutes>
  )({
    app,
    browserSurfaceLeaseManager: opts.browserSurfaceLeaseManager,
    clearTimeoutImpl: opts.streamingClearTimeout,
    companionFactory: streamingCompanionFactory,
    controller,
    ...(opts.streamingCompanionFactory === undefined
      ? {
          hasDirectStreamingTargetForInteraction: (runId: string, interactionId: string) =>
            typeof runTargetRegistry.get({ interactionId, runId }) === "string",
        }
      : {}),
    forceUnregisterStreamingTarget: (runId: string, interactionId: string) =>
      runTargetRegistry.forceUnregister({ interactionId, runId }),
    isNekoProxyTargetApproved: (
      target: unknown,
      { session }: { session?: { interaction_id?: string | null; run_id?: string | null } }
    ) =>
      (typeof opts.isNekoProxyTargetApproved === "function" &&
        opts.isNekoProxyTargetApproved(target as Parameters<NonNullable<typeof opts.isNekoProxyTargetApproved>>[0], {
          session,
        }) === true) ||
      isManagedNekoSurfaceApproved(target, {
        ...(opts.browserSurfaceLeaseManager === undefined
          ? {}
          : { browserSurfaceLeaseManager: opts.browserSurfaceLeaseManager }),
        ...(session?.interaction_id === undefined ? {} : { interactionId: session.interaction_id }),
        ...(session?.run_id === undefined ? {} : { runId: session.run_id }),
      }),
    listRunEventsPage: (runId: string, pageOpts: unknown) =>
      listSpineEventsPage("run", runId, pageOpts as Parameters<typeof listSpineEventsPage>[2]),
    logger: opts.streamingLogger || opts.logger || null,
    makeBrowserSessionId: opts.makeStreamingBrowserSessionId,
    makePresentationAttachmentId: opts.makePresentationAttachmentId,
    nekoProxyAllowedHosts: opts.nekoProxyAllowedHosts || process.env.PDPP_NEKO_PROXY_ALLOWED_HOSTS || "",
    nekoProxyAutoLogin:
      opts.nekoProxyAutoLogin === undefined
        ? // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
          process.env.PDPP_NEKO_PROXY_AUTOLOGIN === "1"
          ? {
              password: process.env.NEKO_PASSWORD || "1",
              username: process.env.NEKO_USERNAME || "operator",
            }
          : null
        : opts.nekoProxyAutoLogin,
    nekoWindowSettleProbe: resolveNekoWindowSettleProbe(
      opts.nekoWindowSettleProbe as Parameters<typeof resolveNekoWindowSettleProbe>[0]
    ),
    now: opts.streamingNow,
    onPresentationRestoreFailure: async ({
      browser_session_id,
      lease_id,
      run_id,
      surface_id,
    }: {
      browser_session_id: string;
      lease_id: string;
      run_id: string;
      surface_id: string;
    }) => {
      await (recyclePresentationSurface as unknown as (opts: Record<string, unknown>) => Promise<void>)({
        browserSessionId: browser_session_id,
        browserSurfaceAllocator: opts.browserSurfaceAllocator || null,
        browserSurfaceLeaseManager: opts.browserSurfaceLeaseManager || null,
        browserSurfaceLeaseStore: opts.browserSurfaceLeaseStore || null,
        leaseId: lease_id,
        logger: opts.logger,
        presentationScreenStateStore: opts.presentationScreenStateStore || null,
        surfaceId: surface_id,
      });
      // System-initiated cleanup for a run already known to the controller,
      // not an owner-facing cancel request — resolve the requester from the
      // run's own admitted-owner bookkeeping rather than a caller-supplied
      // claim. A `null` owner means the run is no longer active; cancelRun
      // has nothing left to cancel, so skip the call rather than fabricate
      // an owner identity.
      const restoreFailureOwnerSubjectId = controller?.getActiveRunOwnerSubjectId(run_id);
      if (restoreFailureOwnerSubjectId) {
        await originalCancelRun?.(run_id, restoreFailureOwnerSubjectId);
      }
    },
    ownerAuth,
    setTimeoutImpl: opts.streamingSetTimeout,
    streamingSessions,
  });
  (app as Record<string, unknown>).__pdppStreamingUpgradeHandler = streamingRoutes.handleUpgrade;

  // Wrap controller.respondToInteraction so the streaming session is
  // invalidated whenever an interaction resolves. Inbox and the
  // `_ref/runs/:runId/interaction` route both call respondToInteraction, so
  // wrapping at the controller seam covers both paths without duplicating the
  // teardown call.
  if (controller && typeof controller.respondToInteraction === "function") {
    const originalRespondToInteraction = controller.respondToInteraction.bind(controller);
    async function restorePresentationBeforeTerminal(runId: string, interactionId: string, reason: string) {
      try {
        await streamingRoutes.invalidateForInteractionResolved({
          interaction_id: interactionId,
          reason,
          run_id: runId,
        });
      } catch (err) {
        // Failed restore is terminal, never a route to a connector resuming
        // against a phone-shaped shared surface.
        // Same trusted internal resolution as onPresentationRestoreFailure
        // above: this is system-initiated teardown of a run already known
        // to the controller, not an owner-facing cancel request. Start the
        // cancellation before resolving the blocked interaction so the
        // runtime cannot record success, but resolve before awaiting the
        // cancellation because the connector may need it in order to exit.
        const restoreFailureOwnerSubjectId = controller?.getActiveRunOwnerSubjectId(runId);
        const cancellation = restoreFailureOwnerSubjectId
          ? originalCancelRun?.(runId, restoreFailureOwnerSubjectId)
          : undefined;
        await originalRespondToInteraction(runId, {
          interaction_id: interactionId,
          status: "cancelled",
        });
        await cancellation;
        throw err;
      } finally {
        await runTargetRegistry.forceUnregister({ interactionId, runId });
      }
    }
    (controller as unknown as Record<string, unknown>).respondToInteraction = async (
      runId: string,
      input: Record<string, unknown> = {}
    ) => {
      await restorePresentationBeforeTerminal(
        runId,
        input.interaction_id as string,
        `interaction_${input.status || "resolved"}`
      );
      return originalRespondToInteraction(runId, input as Parameters<typeof originalRespondToInteraction>[1]);
    };
    if (originalCancelRun) {
      controller.cancelRun = async (runId, requestingOwnerSubjectId) => {
        // Cancellation is a run-final barrier even when the connector is
        // blocked in structured browser assistance rather than a legacy
        // pending INTERACTION. Retire every presentation lifecycle here;
        // finalizeRunCleanup also purges every registry target and nonce.
        await streamingRoutes.restoreOrRetirePresentationForRun({ reason: "run_cancelled", run_id: runId });
        return await originalCancelRun(runId, requestingOwnerSubjectId);
      };
    }
    if (opts.presentationTerminalBarrier && typeof opts.presentationTerminalBarrier === "object") {
      const barrierCast = opts.presentationTerminalBarrier as Record<string, unknown>;
      barrierCast.invoke = async (args: unknown) => {
        const a = args as { interactionId: string; reason: string; runId: string };
        await restorePresentationBeforeTerminal(a.runId, a.interactionId, a.reason);
      };
      barrierCast.releaseLease = async (args: unknown) => {
        const a = args as { runId: string };
        await streamingRoutes.restoreOrRetirePresentationForRun({ reason: "run_cleanup", run_id: a.runId });
      };
    }
  }

  (registerInboxRoutes as (...args: unknown[]) => void)(app, { controller, handleError, ownerAuth, pdppError });

  // Operator-only stream-playground route. Lazy-launches a long-lived patchright
  // headless browser whose first page is pinned to a self-contained data:
  // URL, registers its CDP page-target wsUrl with the run-target registry
  // under a synthetic (runId, interactionId), and shims
  // controller.getPendingInteraction so the standard streaming-mint route
  // accepts the synthetic runId. The console's /stream-playground
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
    process.env.NODE_ENV !== "production" || process.env.PDPP_ENABLE_STREAM_PLAYGROUND === "1";
  if (streamPlaygroundEnabled && controller) {
    const playground = (createPlayground as (...args: unknown[]) => ReturnType<typeof createPlayground>)({
      controller,
      emitTimelineEvent: emitSpineEvent,
      logger: opts.streamingLogger,
      onSessionTerminal: async ({
        interactionId,
        reason,
        runId,
      }: {
        interactionId: string;
        reason: string;
        runId: string;
      }) => {
        await streamingRoutes.invalidateForInteractionResolved({
          interaction_id: interactionId,
          reason,
          run_id: runId,
        });
      },
      runTargetRegistry,
    });
    mountRefDevPlaygroundSession(app, {
      ...(opts.streamingLogger === null ? {} : { logger: opts.streamingLogger }),
      pdppError,
      playground,
      requireOwnerSession: ownerAuth.requireOwnerSession,
    } as unknown as Parameters<typeof mountRefDevPlaygroundSession>[1]);
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
  } as unknown as Parameters<typeof mountRefRunInteraction>[1]);

  // Reference-only, owner-only control surface: cancel a single active
  // controller-managed run by run id. Stops only the targeted run, preserves
  // already-collected records, and does not touch sibling runs, schedules,
  // grants, or connections. Mutation-only; not a public PDPP API.
  // See openspec/changes/add-owner-run-cancellation-control.
  mountRefRunCancel(app, {
    cancelRun: async (runId: string, requestingOwnerSubjectId: string) => {
      if (!controller) {
        return { run_id: runId, status: "no_active_run" } as unknown as Parameters<
          typeof mountRefRunCancel
        >[1]["cancelRun"] extends (id: string, owner: string) => Promise<infer R>
          ? R
          : never;
      }
      const controllerResult = await controller.cancelRun(runId, requestingOwnerSubjectId);
      if (controllerResult.status !== "no_active_run") {
        return controllerResult as unknown as Parameters<typeof mountRefRunCancel>[1]["cancelRun"] extends (
          id: string,
          owner: string
        ) => Promise<infer R>
          ? R
          : never;
      }
      return ((await opts.cancelScheduledRun?.(runId)) ?? controllerResult) as unknown as Parameters<
        typeof mountRefRunCancel
      >[1]["cancelRun"] extends (id: string, owner: string) => Promise<infer R>
        ? R
        : never;
    },
    controller,
    handleError,
    ownerSubjectId: ownerAuth.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
  } as unknown as Parameters<typeof mountRefRunCancel>[1]);

  // `/_ref/dataset/*` and `/_ref/records/version-stats` routes extracted to
  // `server/routes/ref-dataset.ts` per `split-reference-server-by-route-family`
  // §2.3. Context wires the same substrate functions that previously lived
  // inline here; behaviour is identical.
  const refDatasetContext = {
    buildRecordVersionStatsEnvelope,
    createRequestAbortSignal,
    createRequestConnectorInstanceStore,
    ensureDatasetSummaryProjectionHealthy,
    getDatasetBlobBytes,
    getDatasetRecordChangesBytes,
    getDatasetRecordsAggregate,
    getDatasetRecordTimeBounds,
    getDatasetSummaryProjection,
    getDatasetSummaryStreamRecordTimeBounds,
    getRetainedSizeGlobal,
    handleError,
    isPostgresStorageBackend,
    listDatasetSummaryStreamProjectionSeeds,
    listDatasetTopConnectorCandidates,
    listRetainedSizeConnections,
    listRetainedSizeStreams,
    listRetainedSizeTop,
    listStreamProjections,
    rebuildDatasetSummaryProjection,
    rebuildRetainedSize,
    reconcileDirtyDatasetSummaryRecordTimeBounds,
    reconcileDirtyRetainedSize,
    requireOwnerSession: ownerAuth.requireOwnerSession,
  };
  mountRefDatasetSummary(app, refDatasetContext as unknown as Parameters<typeof mountRefDatasetSummary>[1]);
  mountRefDatasetSummaryStreams(
    app,
    refDatasetContext as unknown as Parameters<typeof mountRefDatasetSummaryStreams>[1]
  );
  mountRefDatasetSummaryRebuild(
    app,
    refDatasetContext as unknown as Parameters<typeof mountRefDatasetSummaryRebuild>[1]
  );
  mountRefDatasetSummaryReconcile(
    app,
    refDatasetContext as unknown as Parameters<typeof mountRefDatasetSummaryReconcile>[1]
  );
  mountRefDatasetSize(app, refDatasetContext as unknown as Parameters<typeof mountRefDatasetSize>[1]);
  mountRefDatasetTop(app, refDatasetContext as unknown as Parameters<typeof mountRefDatasetTop>[1]);
  mountRefRecordsVersionStats(app, refDatasetContext as unknown as Parameters<typeof mountRefRecordsVersionStats>[1]);
  mountRefDatasetSizeRebuild(app, refDatasetContext as unknown as Parameters<typeof mountRefDatasetSizeRebuild>[1]);
  mountRefDatasetSizeReconcile(app, refDatasetContext as unknown as Parameters<typeof mountRefDatasetSizeReconcile>[1]);

  // `/_ref/connectors`, `/_ref/connections`, and `/_ref/connector-instances`
  // routes (connector-summary list/detail, schedule read, connection list/detail,
  // display-name PATCH, and run/schedule action routes) extracted to
  // `server/routes/ref-connectors.ts` per
  // `split-reference-server-by-route-family` §2.4. The host wires
  // capability-shaped controller / substrate dependencies; the adapter
  // owns owner-auth, namespace resolution, contract metadata, response
  // writing, and the `onScheduleMutation` callback.
  const attachActivationScheduleForConnection = createActivationScheduleAttacher(controller);
  const getRuntimeStatus = () =>
    controller
      ? {
          label: "Collection runtime ready",
          message: null,
          object: "ref_runtime_status",
          ok: true,
          reason: null,
        }
      : {
          label: "Collection runtime unavailable",
          message:
            "PDPP can still show saved sources, but automatic collection is paused until the reference runtime is back.",
          object: "ref_runtime_status",
          ok: false,
          reason: "controller_unavailable",
        };

  const refConnectorsContext = {
    canonicalConnectorKey,
    createRequestConnectorInstanceStore,
    createTraceContext,
    deleteConnection: (connectorInstanceId: string, options: unknown) =>
      createRequestConnectorInstanceStore().deleteConnection(connectorInstanceId, {
        ...(options as Record<string, unknown>),
        purge: {
          deleteRecordRejectionsPostgres: (client: unknown, id: string, ownerSubjectId: string) =>
            deletePostgresRecordRejectionsForConnectionWithClient(
              client as Parameters<typeof deletePostgresRecordRejectionsForConnectionWithClient>[0],
              { connectorInstanceId: id, ownerSubjectId }
            ),
          deleteRecordRejectionsSqlite: (id: string, ownerSubjectId: string) =>
            deleteSqliteRecordRejectionsForConnectionWithinTransaction({ connectorInstanceId: id, ownerSubjectId }),
          deleteRecordRowsPostgres: (client: unknown, id: string) =>
            deleteConnectionRecordRowsPostgres(client as Parameters<typeof deleteConnectionRecordRowsPostgres>[0], id),
          deleteRecordRowsSqlite: (id: string) => deleteConnectionRecordRowsSqlite(id),
          enumerateStreams: (storageTarget: unknown) =>
            enumerateConnectionStreams(storageTarget as Parameters<typeof enumerateConnectionStreams>[0]),
          teardownProjection: (args: unknown) =>
            teardownConnectionSearchProjection(args as Parameters<typeof teardownConnectionSearchProjection>[0]),
        },
      } as Parameters<ReturnType<typeof createRequestConnectorInstanceStore>["deleteConnection"]>[1]),
    deleteSchedule: (connectorId: string, options: unknown) =>
      controller?.deleteSchedule(
        connectorId,
        options as Parameters<NonNullable<typeof controller>["deleteSchedule"]>[1]
      ),
    emitSpineEvent,
    ensureRequestId,
    getConnectorDetail: (id: string) => getConnectorDetail(id, controller),
    getConnectorSummaryForRoute: (routeId: string, options?: { readonly profile?: ConnectorSummaryPageProfile }) =>
      getConnectorSummaryForRoute(routeId, controller, options),
    getFleetHealthVerdict: async () => {
      const ownerSubjectId = ownerAuth.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID;
      // Inventory and summaries consume one owner-visible snapshot. This
      // boundary removes internal rows before reconciliation and preserves
      // the configured owner subject instead of falling back to owner_local.
      const inventory = await listOwnerVisibleConnectorInstances(ownerSubjectId);
      const summaries = await listConnectorSummaries(controller, {
        includeRunSummaries: "singleton-active",
        ownerSubjectId,
        visibleConnections: inventory,
      });
      const streamHealth = await evaluateOwnerStreamCoverageAuthority({ referenceRevision, summaries });
      return composeFleetHealthVerdict({
        inventory,
        runtime: getRuntimeStatus(),
        streamHealth,
        summaries,
      });
    },
    getOwnerSubjectId,
    getRuntimeStatus,
    getSchedule: async (connectorId: string, options: unknown) =>
      controller
        ? await controller.getSchedule(connectorId, options as Parameters<typeof controller.getSchedule>[1])
        : null,
    handleError,
    invalidateConnectorSummariesCache,
    listConnectorSummaryPage: async (
      ownerSubjectId: string,
      page: {
        connectorId?: string | readonly string[] | null;
        cursor: unknown;
        includeFleetHealth?: boolean;
        limit: number;
        profile?: ConnectorSummaryPageProfile;
        sourcesVisibility?: boolean;
      }
    ) => {
      const after = (page.cursor as ConnectorIdentityPageBoundary | null) ?? null;
      // The owner Sources page's exclusive opt-in (`sources_visibility=1`):
      // excludes a pure recovered historical fragment BEFORE `LIMIT` via a
      // dedicated identity-page query, so `has_more`/`next_cursor` are
      // authoritative over the rows this page renders. Every other caller
      // (Explore, Add Source, manual upload) omits this and reaches the
      // unfiltered branches below unchanged.
      if (page.sourcesVisibility) {
        const { inventory, ...envelope } = await listConnectorSourcesSummaryPage(controller, {
          after,
          includeRunSummaries: "singleton-active",
          limit: page.limit,
          ownerSubjectId,
        });
        return envelope;
      }
      // The three profile branches return different `data` element types
      // (`ConnectorSummary` / `ConnectorIdentityInventorySummary` /
      // `ConnectorRetainedCountSummary`); this closure's return type is
      // already the widened `{data: readonly unknown[], ...}` shape the
      // `MountRefConnectorsContext.listConnectorSummaryPage` capability
      // declares, so each branch's narrow result is captured as `unknown`
      // rather than forcing a single (necessarily wrong) common element type.
      let summaryPage: {
        readonly data: readonly unknown[];
        readonly fleet_health?: unknown;
        readonly has_more: boolean;
        readonly inventory: readonly unknown[];
        readonly next_cursor: string | null;
      };
      if (page.profile === "identity_inventory") {
        summaryPage = await listConnectorSummaryPage(controller, {
          after,
          connectorId: page.connectorId ?? null,
          includeRunSummaries: "singleton-active",
          limit: page.limit,
          ownerSubjectId,
          profile: page.profile,
        });
      } else if (page.profile === "retained_count_summary") {
        summaryPage = await listConnectorSummaryPage(controller, {
          after,
          connectorId: page.connectorId ?? null,
          includeRunSummaries: "singleton-active",
          limit: page.limit,
          ownerSubjectId,
          profile: page.profile,
        });
      } else {
        summaryPage = await listConnectorSummaryPage(controller, {
          after,
          connectorId: page.connectorId ?? null,
          includeRunSummaries: "singleton-active",
          limit: page.limit,
          ownerSubjectId,
        });
      }
      const { inventory, ...envelope } = summaryPage;
      // A fleet verdict is truthful only when the page itself is the complete
      // owner-visible inventory.  Never infer that from a short page: the
      // storage page's explicit has_more bit is the authority. The
      // `identity_inventory` profile never requests a fleet verdict (Explore
      // never sets `include_fleet_health`), so `summaryPage.data` here is
      // always full `ConnectorSummary[]` when this branch runs.
      if (!(page.includeFleetHealth && page.connectorId === null && page.cursor === null && !summaryPage.has_more)) {
        return envelope;
      }
      const fullSummaries = summaryPage.data;
      // Reachable only from the unfiltered, no-profile branch (the guard
      // above requires `page.connectorId === null` AND `page.profile` was
      // never set to reach this fleet-health composition), so `inventory`
      // here is always the full owner-visible `FleetConfiguredConnection[]`
      // inventory the unfiltered branch reads — the closure-wide `unknown[]`
      // type only exists to let the three profile branches share one
      // variable without forcing a single wrong common element type.
      const fleetInventory = inventory as unknown as Parameters<typeof composeFleetHealthVerdict>[0]["inventory"];
      return {
        ...envelope,
        fleet_health: composeFleetHealthVerdict({
          inventory: fleetInventory,
          runtime: getRuntimeStatus(),
          streamHealth: await evaluateOwnerStreamCoverageAuthority({ referenceRevision, summaries: fullSummaries }),
          summaries: fullSummaries as unknown as Parameters<typeof composeFleetHealthVerdict>[0]["summaries"],
        }),
      };
    },
    listSchedules: async () => (controller ? await controller.listSchedules() : []),
    markConnectorSummaryEvidenceDirty,
    onScheduleMutation: opts.onScheduleMutation,
    pdppError,
    reconcileDirtyConnectorSummaryEvidence,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolveOwnerConnectorNamespace,
    resolveRegisteredConnectorManifest,
    resolveSingleConnectorIdQueryValue,
    // See `MountRefConnectorsContext.resumeHistoricalArchiveConnectionIfPaused`
    // doc comment. Reuses `applyResume` — the SAME status-flip primitive the
    // bearer and owner-session resume routes call — so this is not a third
    // resume implementation. Ownership is enforced by
    // `resolveOwnerConnectorNamespace` (via `applyResume`'s
    // `getConnectorInstance` -> a subsequent `updateStatus`, which is itself
    // owner-scoped in the store) failing the `historical_archive` guard or
    // an owner mismatch as a thrown error, which this hook swallows to a
    // `false` no-op: the run-now handler's own `resolveRefConnectionNamespace`
    // call right after this is what actually enforces ownership + status for
    // the run itself, so silently no-op'ing an unresumable/foreign target
    // here does not skip that check — it only means the run resolves the
    // target's TRUE current state (which may still legitimately fail).
    resumeHistoricalArchiveConnectionIfPaused: async (input: {
      connectorInstanceId: string;
      ownerSubjectId: string;
    }) => {
      const store = createRequestConnectorInstanceStore();
      const instance = (await store.get(input.connectorInstanceId)) as {
        ownerSubjectId?: string;
        status?: string;
      } | null;
      if (!instance || instance.ownerSubjectId !== input.ownerSubjectId || instance.status !== "paused") {
        return false;
      }
      try {
        await applyResume(
          {
            getConnectorInstance: (connectorInstanceId: string) => store.get(connectorInstanceId),
            invalidateConnectorSummariesCache,
            updateConnectorInstanceStatus: (connectorInstanceId: string, options: unknown) =>
              store.updateStatus(connectorInstanceId, options as Parameters<typeof store.updateStatus>[1]),
          } as unknown as Parameters<typeof applyResume>[0],
          input.connectorInstanceId,
          { requireSourceBindingKind: HISTORICAL_ARCHIVE_SOURCE_BINDING_KIND }
        );
        return true;
      } catch {
        // Not a historical_archive row (or some other resume guard failed):
        // no-op. The run-now resolver right after this call enforces the
        // real status/ownership gate and will surface its own typed error.
        return false;
      }
    },
    runNow: (connectorId: string, options: unknown) =>
      controller?.runNow(connectorId, options as Parameters<NonNullable<typeof controller>["runNow"]>[1]),
    setReferenceTraceId,
    setScheduleEnabled: (connectorId: string, enabled: boolean, options: unknown) =>
      controller?.setScheduleEnabled(
        connectorId,
        enabled,
        options as Parameters<NonNullable<typeof controller>["setScheduleEnabled"]>[2]
      ),
    // Connection revoke/delete share the SAME store primitives the owner-agent
    // bearer routes use (`mountOwnerConnectionRevoke` / `mountOwnerConnectionDelete`
    // below): revoke flips one instance via `updateStatus`; delete runs the
    // all-or-nothing `deleteConnection` cascade with the same injected `purge`
    // phases (record purge atomic with schedule/device/row cleanup; search
    // teardown as a post-commit rebuildable-projection cleanup). The owner-session
    // `/_ref` routes add no new destructive semantic — only a cookie auth adapter.
    updateConnectorInstanceStatus: (connectorInstanceId: string, options: unknown) =>
      createRequestConnectorInstanceStore().updateStatus(
        connectorInstanceId,
        options as Parameters<ReturnType<typeof createRequestConnectorInstanceStore>["updateStatus"]>[1]
      ),
    upsertSchedule: (connectorId: string, input: unknown, options: unknown) =>
      controller?.upsertSchedule(
        connectorId,
        input as Parameters<NonNullable<typeof controller>["upsertSchedule"]>[1],
        options as Parameters<NonNullable<typeof controller>["upsertSchedule"]>[2]
      ),
  };

  mountRefConnectorsList(app, refConnectorsContext as unknown as Parameters<typeof mountRefConnectorsList>[1]);
  mountRefFleetHealth(app, refConnectorsContext as unknown as Parameters<typeof mountRefFleetHealth>[1]);
  mountRefConnectorDetail(app, refConnectorsContext as unknown as Parameters<typeof mountRefConnectorDetail>[1]);

  mountRefRecordsTimeline(app, refAdminContext as unknown as Parameters<typeof mountRefRecordsTimeline>[1]);
  mountRefExploreRecordBuckets(app, refAdminContext as unknown as Parameters<typeof mountRefExploreRecordBuckets>[1]);
  mountRefExploreRecords(app, refAdminContext as unknown as Parameters<typeof mountRefExploreRecords>[1]);
  mountRefSchedules(app, refAdminContext as unknown as Parameters<typeof mountRefSchedules>[1]);

  mountRefConnectorScheduleGet(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectorScheduleGet>[1]
  );
  mountRefConnectionsList(app, refConnectorsContext as unknown as Parameters<typeof mountRefConnectionsList>[1]);
  mountRefConnectorInstancesList(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectorInstancesList>[1]
  );
  mountRefConnectionDetail(app, refConnectorsContext as unknown as Parameters<typeof mountRefConnectionDetail>[1]);
  mountRefConnectorInstanceDetail(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectorInstanceDetail>[1]
  );
  mountRefRecordRejections(app, {
    createRequestConnectorInstanceStore,
    createRequestRecordRejectionStore,
    getOwnerSubjectId,
    handleError,
    maxRecordRejectionPageSize: opts.maxRecordRejectionPageSize,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
  } as unknown as Parameters<typeof mountRefRecordRejections>[1]);
  mountRefConnectionSetDisplayName(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectionSetDisplayName>[1]
  );
  mountRefStaticSecretCredentialCapture(app, {
    autoResumeSatisfiedActions:
      opts.staticSecretAutoResume === false
        ? undefined
        : (input: unknown) =>
            controller?.autoResumeSatisfiedActions(
              input as Parameters<NonNullable<typeof controller>["autoResumeSatisfiedActions"]>[0]
            ),
    canonicalConnectorKey,
    createRequestConnectorInstanceCredentialStore,
    createRequestConnectorInstanceStore,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerSubjectId,
    handleError,
    pdppError,
    // Reference-only synchronous credential probe (owner-journey flow design
    // B1). Resolved at startup and injected; null/absent means every connector
    // takes the first-sync path. Never exposed to /mcp or grant-scoped reads.
    probeStaticSecretCredential: opts.staticSecretCredentialProber as unknown as Parameters<
      typeof mountRefStaticSecretCredentialCapture
    >[1]["probeStaticSecretCredential"],
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolveOwnerConnectorNamespace,
    resolveRegisteredConnectorManifest,
    // Fires ONLY when the capture route detects (before the credential
    // write) that the target was `paused` + `historical_archive` — the
    // recovered-archive reconnect journey. Resumes the SAME
    // connector_instance row via `applyResume` (identical primitive the
    // owner-agent bearer and owner-session resume routes use — no duplicate
    // status-flip logic), then triggers the connector's normal
    // first-sync/incremental run via `controller.runNow`. Never creates a
    // second connection_instance row and never requests a full-history
    // replay (no `runAdmission` override, no `force`): this is the exact
    // "Run this connection" path the capture response's own next_step
    // already documents, just triggered automatically instead of requiring a
    // second owner click.
    resumeHistoricalArchiveConnectionAndRunFirstSync: async (input: {
      connectorId: string;
      connectorInstanceId: string;
      ownerSubjectId: string;
    }) => {
      const store = createRequestConnectorInstanceStore();
      await applyResume(
        {
          getConnectorInstance: (connectorInstanceId: string) => store.get(connectorInstanceId),
          invalidateConnectorSummariesCache,
          updateConnectorInstanceStatus: (connectorInstanceId: string, options: unknown) =>
            store.updateStatus(connectorInstanceId, options as Parameters<typeof store.updateStatus>[1]),
        } as unknown as Parameters<typeof applyResume>[0],
        input.connectorInstanceId,
        { requireSourceBindingKind: HISTORICAL_ARCHIVE_SOURCE_BINDING_KIND }
      );
      // The row is now resumed (the `applyResume` call above already
      // committed). What follows only decides how HONESTLY that is reported:
      // absent a real run handle, this must return `failed`, never fabricate
      // `resumed_and_synced` with a null `runId` — the capture route's 502
      // path exists precisely so it can't claim a sync started when it did
      // not, and a caller reading `archive_reconnect.run_id` must be able to
      // trust that a non-null id means an actual run was launched.
      if (!controller) {
        return {
          code: "archive_reconnect_run_unavailable",
          kind: "failed",
          message: "This connection was resumed, but no run controller is available to start its first sync.",
        };
      }
      const started = (await controller.runNow(input.connectorId, {
        connectorInstanceId: input.connectorInstanceId,
        ownerSubjectId: input.ownerSubjectId,
      })) as { run_id?: string } | undefined;
      if (typeof started?.run_id !== "string" || started.run_id.length === 0) {
        return {
          code: "archive_reconnect_run_unavailable",
          kind: "failed",
          message: "This connection was resumed, but starting its first sync did not return a run id.",
        };
      }
      return {
        kind: "resumed_and_synced",
        runId: started.run_id,
      };
    },
    setReferenceTraceId,
  } as unknown as Parameters<typeof mountRefStaticSecretCredentialCapture>[1]);

  // POST /_ref/connections/:connectorInstanceId/resume is the owner-session
  // (cookie-authed) sibling of the bearer resume routes in `buildRsApp`
  // (`mountOwnerConnectionResume`), scoped to exactly one connectorInstanceId
  // (no connector-only auto-select). It shares the SAME
  // `updateConnectorInstanceStatus` status-flip primitive via `applyResume`
  // (see owner-connection-resume.ts) — no second resume implementation. The
  // `getConnectorInstance` seam stays wired because `applyResume` still needs
  // it for the IMPLICIT auto-resume hooks' `historical_archive` guard; this
  // route itself resumes any paused row the owner owns.
  mountRefConnectionResume(app, {
    canonicalConnectorKey,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getConnectorInstance: (connectorInstanceId: string) =>
      createRequestConnectorInstanceStore().get(connectorInstanceId),
    getOwnerSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolveOwnerConnectorNamespace,
    setReferenceTraceId,
    updateConnectorInstanceStatus: (connectorInstanceId: string, options: unknown) =>
      createRequestConnectorInstanceStore().updateStatus(
        connectorInstanceId,
        options as Parameters<ReturnType<typeof createRequestConnectorInstanceStore>["updateStatus"]>[1]
      ),
  } as unknown as Parameters<typeof mountRefConnectionResume>[1]);

  // POST /_ref/connections/:connectorInstanceId/pause is the owner-session
  // (cookie-authed) sibling of the bearer pause routes in `buildRsApp`
  // (`mountOwnerConnectionPause`), and the exact inverse of the resume mount
  // directly above. It shares the SAME `updateConnectorInstanceStatus`
  // status-flip primitive via `applyPause` (see owner-connection-pause.ts).
  // No `getConnectorInstance` seam: pause takes no source-binding-kind guard,
  // because every pause is an explicit owner act.
  mountRefConnectionPause(app, {
    canonicalConnectorKey,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolveOwnerConnectorNamespace,
    setReferenceTraceId,
    updateConnectorInstanceStatus: (connectorInstanceId: string, options: unknown) =>
      createRequestConnectorInstanceStore().updateStatus(
        connectorInstanceId,
        options as Parameters<ReturnType<typeof createRequestConnectorInstanceStore>["updateStatus"]>[1]
      ),
  } as unknown as Parameters<typeof mountRefConnectionPause>[1]);

  mountRefStaticSecretDraftConnection(app, {
    canonicalConnectorKey,
    createRequestConnectorInstanceStore,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerSubjectId,
    handleError,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolveRegisteredConnectorManifest,
    setReferenceTraceId,
  } as unknown as Parameters<typeof mountRefStaticSecretDraftConnection>[1]);

  {
    const resolvedDbPath = opts.dbPath || DB_PATH;
    const importBaseDir =
      resolvedDbPath === ":memory:"
        ? path.join(os.tmpdir(), "pdpp-imports")
        : path.join(path.dirname(resolvedDbPath), "imports");
    mountRefManualUploadDraftConnection(app, {
      canonicalConnectorKey,
      createRequestAcquisitionBatchStore,
      createRequestConnectorInstanceStore,
      createRequestManualUploadArtifactStore,
      createTraceContext,
      emitSpineEvent,
      ensureRequestId,
      getOwnerSubjectId,
      handleError,
      importBaseDir,
      pdppError,
      requireOwnerSession: ownerAuth.requireOwnerSession,
      resolveRegisteredConnectorManifest,
      setReferenceTraceId,
    } as unknown as Parameters<typeof mountRefManualUploadDraftConnection>[1]);
  }

  // Browser-enrollment shell: pre-credential draft for in-dashboard browser-bound
  // setup. Creates an invisible shell with TTL; owner can also abandon explicitly.
  // Shell transitions to active when an enrollment run captures source identity;
  // first sync then runs as normal collection on that active connection.
  mountRefBrowserEnrollmentShell(app, {
    canonicalConnectorKey,
    createRequestConnectorInstanceStore,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerSubjectId,
    handleError,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolveRegisteredConnectorManifest,
    setReferenceTraceId,
  } as unknown as Parameters<typeof mountRefBrowserEnrollmentShell>[1]);

  // Owner-visible setup lifecycle for a static-secret connection. Projects the
  // draft/active instance + non-secret credential metadata + current/last run
  // into one durable status surface so a submitted account never disappears
  // behind the invisible draft. Owner-session-only; no secrets in the response.
  mountRefStaticSecretSetupStatus(app, {
    canonicalConnectorKey,
    createRequestAcquisitionBatchStore,
    createRequestConnectorInstanceCredentialStore,
    createRequestConnectorInstanceStore,
    getLatestRunHistoryForProductByConnectionId: (connectorInstanceId: string) =>
      getDefaultSchedulerStore().getLatestRunHistoryForProductByConnectionId?.(connectorInstanceId) ?? null,
    getOwnerSubjectId,
    getProductRunHistoryForConnectionRunId: (connectorInstanceId: string, runId: string) =>
      getDefaultSchedulerStore().getProductRunHistoryForConnectionRunId?.(connectorInstanceId, runId) ?? null,
    handleError,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolveOwnerConnectorNamespace,
    resolveRegisteredConnectorManifest,
  } as unknown as Parameters<typeof mountRefStaticSecretSetupStatus>[1]);

  // Provider-authorization lifecycle: initiate + callback routes.
  // The in-process pending-auth store is scoped to this RS process instance and
  // survives only for the PENDING_AUTH_TTL_SECONDS window (10 minutes).
  const pendingAuthStore = createInProcessPendingAuthStore();
  const providerAuthExchanger =
    opts.providerAuthExchanger ?? buildGenericProviderAuthExchanger(createRequestConnectorInstanceCredentialStore);
  const providerAuthCtx = {
    canonicalConnectorKey,
    // Connector keys for which provider-app deployment config is in place.
    // Every provider-authorization connector today declares its own
    // manifest deployment_config, so connection-setup-plan.ts's readiness
    // check is always answered from the manifest/env/provider-app-config
    // store — this allowlist is the fallback for a manifest declaring NONE,
    // which no registered connector currently does.
    configuredProviderAuthConnectorKeys: opts.configuredProviderAuthConnectorKeys ?? [],
    createRequestConnectorInstanceStore: () => {
      const store = createRequestConnectorInstanceStore();
      return {
        upsert: async (record: unknown) => {
          const instance = await store.upsert(
            record as Parameters<ReturnType<typeof createRequestConnectorInstanceStore>["upsert"]>[0]
          );
          await attachActivationScheduleForConnection(instance);
          return instance;
        },
      };
    },
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    // Tests can inject a deterministic double; production wires real provider
    // exchangers only when their deployment-level OAuth app config is present.
    exchanger: providerAuthExchanger,
    generateReferenceSecret,
    generateSpineId,
    getOwnerSubjectId,
    handleError,
    pdppError,
    pendingAuthStore,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    // The callback URL lives on the AS app (/_ref/provider-auth/callback).
    resolveCallbackBaseUrl: (req: unknown) => {
      // biome-ignore lint/suspicious/noShadow: The local name follows the external payload vocabulary at this boundary.
      const explicitAsBaseUrl = opts.asPublicUrl || (opts.ignoreAmbientPublicUrls ? null : process.env.AS_PUBLIC_URL);
      return resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitAsBaseUrl);
    },
    resolveDeploymentEnv: resolveProviderAuthDeploymentEnv,
    resolveRegisteredConnectorManifest,
    setReferenceTraceId,
  };
  if (providerAuthCtx.exchanger) {
    mountRefProviderAuthInitiate(app, providerAuthCtx as unknown as Parameters<typeof mountRefProviderAuthInitiate>[1]);
    mountRefProviderAuthCallback(app, providerAuthCtx as unknown as Parameters<typeof mountRefProviderAuthCallback>[1]);
  }

  // Deployment-level provider-app registration config (e.g. a shared OAuth
  // client id/secret), grouped by manifest-declared provider_identity_group.
  // Zero connector/provider-specific knowledge here — resolveProviderIdentityGroup
  // and listProviderIdentityGroups are the only place the RI groups
  // connectors by manifest data; the route itself just reads/writes
  // logical_key/label pairs the manifest declared.
  const providerAppConfigCtx = {
    // The route's injected ProviderAppConfigStore interface takes setMany's
    // values as a plain Record<logicalKey, value> (its own client-facing
    // shape); the real store takes an array of {logicalKey,value} entries
    // (its own write-path shape, shared with the single-entry `set`). This
    // adapter is the only place that bridges the two.
    createRequestProviderAppConfigStore: () => {
      const store = createRequestProviderAppConfigStore();
      return {
        listConfiguredKeys: (identityGroup: string) => store.listConfiguredKeys(identityGroup),
        setMany: (args: { identityGroup: string; values: Readonly<Record<string, string>>; updatedAt: string }) =>
          store.setMany({
            identityGroup: args.identityGroup,
            updatedAt: args.updatedAt,
            values: Object.entries(args.values).map(([logicalKey, value]) => ({ logicalKey, value })),
          }),
      };
    },
    handleError,
    isEnvAliasSatisfied: (envAlias: string) => Boolean(process.env[envAlias]?.trim()),
    listProviderIdentityGroups,
    pdppError,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    resolveProviderIdentityGroup,
  };
  mountRefProviderAppConfigGet(
    app,
    providerAppConfigCtx as unknown as Parameters<typeof mountRefProviderAppConfigGet>[1]
  );
  mountRefProviderAppConfigPost(
    app,
    providerAppConfigCtx as unknown as Parameters<typeof mountRefProviderAppConfigPost>[1]
  );

  mountRefDeployment(app, refAdminContext as unknown as Parameters<typeof mountRefDeployment>[1]);

  // `/_ref/device-exporters` route family extracted to
  // `server/routes/ref-device-exporters.ts` per
  // `split-reference-server-by-route-family` §2.6. The host wires
  // device-exporter store, connector instance store, gap store, sync
  // state, record ingest, catalog entry, and credential/protocol
  // enforcement; the adapter owns all route logic.
  const refDeviceExportersContext = {
    acceptedCollectorProtocolVersions,
    canonicalConnectorKey,
    createRequestConnectorInstanceStore,
    DeviceBatchConflictError,
    deviceExporterStore,
    emitSpineEvent,
    enforceCollectorProtocolVersion,
    enqueueDeviceIndexMaintenance,
    ensureReferenceConnectorCatalogEntry,
    generateReferenceSecret,
    generateSpineId,
    getConnectorManifest: (connectorId: string) => getConnectorManifest(connectorId),
    getDefaultConnectorDetailGapStore,
    getOwnerSubjectId,
    getSemanticCapabilityIdentity,
    getSyncState,
    handleError,
    hashDeviceSecret,
    ingestRecord,
    isDeviceSemanticAttemptSupported: supportsDeviceSemanticAttemptDeadline,
    listLocalCoverageDiagnostics,
    maintainRecordIndexes,
    makeConnectorInstanceSourceBindingKey,
    pdppError,
    prepareDeviceFinalRecords,
    putSyncState,
    readCollectorProtocolHeader,
    readReferenceLocalConnectorCatalogManifest,
    requireDeviceExporterCredential,
    requireOwnerSession: ownerAuth.requireOwnerSession,
    sanitizeDeviceExporterDiagnostic,
    sanitizeLocalCollectorGapDetails,
  };

  mountRefDeviceExporterEnrollmentCodes(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterEnrollmentCodes>[1]
  );
  mountRefDeviceExporterEnroll(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterEnroll>[1]
  );
  mountRefDeviceExportersList(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExportersList>[1]
  );
  mountRefDeviceExporterSourceInstances(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterSourceInstances>[1]
  );
  mountRefDeviceExporterDiagnostics(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterDiagnostics>[1]
  );
  mountRefDeviceExporterRevoke(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterRevoke>[1]
  );
  mountRefDeviceExporterSelfRevoke(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterSelfRevoke>[1]
  );
  mountRefDeviceExporterHeartbeat(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterHeartbeat>[1]
  );
  mountRefDeviceExporterIngestBatches(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterIngestBatches>[1]
  );
  mountRefDeviceExporterSourceInstanceStateGet(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterSourceInstanceStateGet>[1]
  );
  mountRefDeviceExporterSourceInstanceStatePut(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterSourceInstanceStatePut>[1]
  );
  mountRefDeviceExporterLocalCollectorGaps(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterLocalCollectorGaps>[1]
  );
  mountRefDeviceExporterLocalCollectorGapsRecovered(
    app,
    refDeviceExportersContext as unknown as Parameters<typeof mountRefDeviceExporterLocalCollectorGapsRecovered>[1]
  );

  mountRefClients(app, refAdminContext as unknown as Parameters<typeof mountRefClients>[1]);
  mountRefClientTokens(app, refAdminContext as unknown as Parameters<typeof mountRefClientTokens>[1]);
  mountRefClientTokenRevoke(app, refAdminContext as unknown as Parameters<typeof mountRefClientTokenRevoke>[1]);

  mountRefConnectorRun(app, refConnectorsContext as unknown as Parameters<typeof mountRefConnectorRun>[1]);
  mountRefConnectionRun(app, refConnectorsContext as unknown as Parameters<typeof mountRefConnectionRun>[1]);
  mountRefConnectorScheduleUpsert(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectorScheduleUpsert>[1]
  );
  mountRefConnectionScheduleUpsert(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectionScheduleUpsert>[1]
  );
  mountRefConnectorSchedulePause(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectorSchedulePause>[1]
  );
  mountRefConnectionSchedulePause(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectionSchedulePause>[1]
  );
  mountRefConnectorScheduleResume(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectorScheduleResume>[1]
  );
  mountRefConnectionScheduleResume(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectionScheduleResume>[1]
  );
  mountRefConnectorScheduleDelete(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectorScheduleDelete>[1]
  );
  mountRefConnectionScheduleDelete(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectionScheduleDelete>[1]
  );

  // Owner-session connection revoke + reactivate + delete — cookie-authed
  // siblings of the owner-agent bearer routes. They give the operator console
  // a way to revoke (stop future collection, preserve records), reactivate
  // (reverse a revoke, resume collection for the same connection, preserve all
  // records), and delete (erase exactly one connection's records/state, refuse
  // active runs + default-account) one configured connection without an
  // owner-agent bearer, reusing the SAME store primitives and emitting the SAME
  // audit event types. See
  // openspec/changes/add-console-connection-revoke-delete-controls.
  mountRefConnectionRevoke(app, refConnectorsContext as unknown as Parameters<typeof mountRefConnectionRevoke>[1]);
  mountRefConnectionReactivate(
    app,
    refConnectorsContext as unknown as Parameters<typeof mountRefConnectionReactivate>[1]
  );
  mountRefConnectionDelete(app, refConnectorsContext as unknown as Parameters<typeof mountRefConnectionDelete>[1]);

  if (!nativeMode) {
    // Polyfill-only connector registry: register/detail semantics live in
    // `server/routes/as-polyfill-connectors.ts` per OpenSpec change
    // `split-reference-server-by-route-family`. Behaviour-preserving extraction:
    // same routes, same operation delegation, same error mapping, same response
    // envelopes. Only mounted in polyfill mode, matching the original guard.
    // Security audit S-2 (lane A1): `POST /connectors` upserts a connector
    // manifest, and a bumped `version` invalidates every existing grant — a
    // one-request grant-wipe DoS. On any internet-facing posture (or when the
    // operator sets PDPP_LOCK_CONNECTOR_REGISTRY=1) we require an owner session
    // for the register route. In local-dev the route stays open so the
    // `pnpm dev` / test harness can self-register manifests frictionlessly.
    // GET /connectors/:id (manifest read) is unchanged — it exposes no user
    // data and is needed by the unauthenticated client-side connect flow.
    const asPolyfillConnectorsContext = {
      getConnectorManifest,
      handleError,
      pdppError,
      registerConnector,
      requireOwnerSessionForRegister: lockConnectorRegistry ? ownerAuth.requireOwnerSession : null,
    };
    mountAsPolyfillConnectorRegister(
      app,
      asPolyfillConnectorsContext as unknown as Parameters<typeof mountAsPolyfillConnectorRegister>[1]
    );
    mountAsPolyfillConnectorDetail(
      app,
      asPolyfillConnectorsContext as unknown as Parameters<typeof mountAsPolyfillConnectorDetail>[1]
    );
  }

  // POST /oauth/par extracted to `server/routes/as-par.ts` per OpenSpec
  // change `split-reference-server-by-route-family` (§6). Behaviour-preserving:
  // same contract metadata, same auth posture (none — public endpoint),
  // same base-URL resolution, same response envelope, same status codes.
  mountAsPar(app, {
    handleError,
    initiateGrant: (body: unknown, opts2: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (consentStore as unknown as Record<string, (...args: unknown[]) => unknown>).initiateGrant?.(body, {
        ...(opts2 && typeof opts2 === "object" ? opts2 : {}),
        ...(opts.acceptedProviderNativeRevision &&
        requestSelectsSource(body, opts.acceptedProviderNativeRevision.sourceId)
          ? {
              acceptedRevisionReference: opts.acceptedProviderNativeRevision.acceptedRevisionReference,
              acceptedRevisionStore: opts.acceptedProviderNativeRevision.revisionStore,
              nativeManifestMode: "fulfillment_only",
            }
          : {}),
        ...(!opts.acceptedProviderNativeRevision &&
        configuredNativeSourceId(opts) &&
        requestSelectsSource(body, configuredNativeSourceId(opts) as string)
          ? { nativeManifestMode: "local_operator_provisioning" }
          : {}),
      }),
    nativeManifest: resolveNativeManifest(opts),
    resolveBaseUrl: (req: unknown) =>
      resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitAsBaseUrl),
    setReferenceTraceId,
  } as unknown as Parameters<typeof mountAsPar>[1]);

  // Consent route family (GET /consent, POST /consent/approve, POST /consent/deny,
  // POST /consent/exchange) extracted to `server/routes/as-consent.ts` per
  // OpenSpec change `split-reference-server-by-route-family`. Behaviour-
  // preserving: same auth posture (owner-session + CSRF), same operation
  // delegation, same response envelopes and error mapping.
  mountAsConsent(app, {
    agentConnectAttemptStore,
    buildPendingConsentRequestUri,
    consentStore,
    consentUi,
    consumeConsentExchangeCode,
    createConsentExchangeCode,
    handleError,
    issueOAuthAuthorizationCodeForDeviceCode,
    issueOAuthAuthorizationCodeForPackageDeviceCode,
    ownerAuth,
    pdppError,
    providerName,
    resolveBaseUrl: (req: unknown) =>
      resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitAsBaseUrl),
    setReferenceTraceId,
  } as unknown as Parameters<typeof mountAsConsent>[1]);

  // Grant-revocation route extracted to `server/routes/as-grant-revoke.ts`
  // per OpenSpec change `split-reference-server-by-route-family` (§6 continuation).
  // Behaviour-preserving: same `requireRevokeAuth` posture, same operation delegation,
  // same side-effect hook (client-event-subscription rows + delivery tick),
  // same response envelope, same error mapping.
  const asGrantRevokeContext = {
    applyGrantRevokeSideEffects: buildApplyGrantRevokeSideEffects({
      getDeliveryWorker: () => {
        const w = getDefaultDeliveryWorker();
        return { tick: () => w.tick().then(() => undefined) };
      },
      getStore: getDefaultClientEventSubscriptionStore,
    }),
    ensureRequestId,
    handleError,
    introspect,
    logger: opts.logger,
    pdppError,
    revokeGrant,
    setReferenceTraceId,
  };
  mountAsGrantRevoke(app, asGrantRevokeContext as unknown as Parameters<typeof mountAsGrantRevoke>[1]);

  // Client event subscriptions are mounted on the RESOURCE SERVER under
  // `/v1/event-subscriptions` (see buildRsApp). They are the same kind of
  // RI-extension surface as `/v1/streams/:s/records`: ordinary clients use
  // grant-scoped bearers, while trusted owner agents use owner REST
  // authority. The AS host no longer mounts a `_ref` alias for them.

  return app;
}

// ─── RS App ─────────────────────────────────────────────────────────────────

// `origin` is the provider/MCP origin: it backs the `cli.run_command` connect
// target and the `mcp.endpoint` (both of which the RS itself serves, so the RS
// origin is honest here). `docsOrigin` backs the agent-facing docs/skill
// pointers (`skill`, `skill_catalog`, `llms_txt`, `llms_full_txt`) — those
// routes are served ONLY by the console/site Next.js origin, never the RS. When
// no docs origin is available (direct/ephemeral topology), those pointers are
// omitted entirely rather than rebased onto an origin that would 404. Defaults
// to `origin` so callers whose `origin` already IS the docs origin (the plain
// protected-resource metadata in composed mode) need not pass it twice.
function buildAgentDiscoveryMetadata(
  origin: string | null | undefined,
  {
    noOwnerToken = true,
    docsOrigin = origin,
    mcpAuthorization = null,
  }: { noOwnerToken?: boolean; docsOrigin?: string | null; mcpAuthorization?: unknown } = {}
) {
  if (!origin) {
    return null;
  }
  const base = stripTrailingSlash(origin);
  const cli = getPdppCliPackageInfo(base);
  const noOwnerTokenPolicy = noOwnerToken
    ? cli.noOwnerTokenPolicy
    : "requires_native_reference_provider_for_one_command_connect";
  const docs = docsOrigin ? stripTrailingSlash(docsOrigin) : null;
  return {
    advisory: true,
    cli: {
      bin_name: cli.binName,
      connect_command: createPdppCliCommand("<provider-url>"),
      install_command: `npx -y ${cli.packageSpecifier} --help`,
      no_owner_token: noOwnerToken,
      no_owner_token_policy: noOwnerTokenPolicy,
      package: cli.packageName,
      package_specifier: cli.packageSpecifier,
      run_command: cli.runCommand,
      version_policy: cli.versionPolicy,
    },
    recommended_flow: "pdpp connect",
    skill_name: "pdpp-data-access",
    // Docs/skill pointers are only honest when a docs origin serves them.
    ...(docs
      ? {
          skill: `${docs}/.well-known/skills/pdpp-data-access/SKILL.md`,
          skill_catalog: `${docs}/.well-known/skills/index.json`,
        }
      : {}),
    mcp: {
      endpoint: `${base}/mcp`,
      no_owner_token: true,
      setup_intent: "grant_scoped_read",
      tool_surface: "profile_free_normal_read",
      transport: "streamable_http",
      ...(mcpAuthorization ? { authorization: mcpAuthorization } : {}),
    },
    ...(docs
      ? {
          llms_full_txt: `${docs}/llms-full.txt`,
          llms_txt: `${docs}/llms.txt`,
        }
      : {}),
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
function buildOwnerAgentOnboardingMetadata({
  origin,
  resource,
  issuer,
}: {
  origin: string | null | undefined;
  resource: string | null | undefined;
  issuer: string | null | undefined;
}) {
  if (!(origin && resource && issuer)) {
    return null;
  }
  const approvalBase = stripTrailingSlash(origin);
  const rs = stripTrailingSlash(resource);
  const as = stripTrailingSlash(issuer);
  return {
    advisory: true,
    authorization_server: as,
    // Owner-agent control entrypoint + action-family catalog. Projected from
    // the same `buildOwnerAgentControlSurface` builder the bearer-authed
    // `GET /v1/owner/control` route returns, so discovery and the live
    // capability document never disagree on what is supported. See
    // openspec/changes/add-owner-agent-control-surface.
    control_surface: buildOwnerAgentControlSurface({ resource: rs }),
    device_authorization_endpoint: `${as}/oauth/device_authorization`,
    event_subscriptions_endpoint: `${rs}/v1/event-subscriptions`,
    introspection_endpoint: `${as}/introspect`,
    mcp_owner_bearer_rejected: true,
    owner_approval_url: approvalBase,
    pdpp_token_kind: "owner",
    profile: "trusted_owner_agent",
    query_base: `${rs}/v1`,
    registration_endpoint: `${as}/oauth/register`,
    resource: rs,
    revocation_path_template: `${as}/oauth/register/{client_id}`,
    schema_compact_endpoint: `${rs}/v1/schema?view=compact`,
    schema_endpoint: `${rs}/v1/schema`,
    streams_endpoint: `${rs}/v1/streams`,
    token_endpoint: `${as}/oauth/token`,
    warning:
      "Owner-level local automation. This profile yields an owner bearer that authorizes owner-visible REST/control-plane access — not a grant-scoped external client. Use grant-scoped MCP for ordinary third-party agents.",
  };
}

function buildRsApp(opts: ServerOpts = {}) {
  const app = createApp({ ...(opts.logger === null ? {} : { logger: opts.logger }) });
  const nativeMode = !!resolveNativeManifest(opts);
  const providerName = resolveProviderName(opts);
  const referenceRevision = resolveReferenceRevision({
    ...(opts.referenceRevision === null ? {} : { referenceRevision: opts.referenceRevision }),
  });
  const explicitResource = opts.rsPublicUrl || (opts.ignoreAmbientPublicUrls ? null : process.env.RS_PUBLIC_URL);
  // Trusted INTERNAL resource-server base for the hosted-MCP adapter's own
  // child-grant self-calls, plumbed in via `opts.rsInternalUrl` from startServer
  // (which sources it from the explicit `PDPP_RS_URL` / opt — no new env). It is
  // an operator-configured loopback/cluster address, never request-derived. When
  // absent the adapter falls back to the advertised public resource (current
  // behavior). startServer intentionally does NOT pass the bare default here.
  // Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
  const internalResource = opts.rsInternalUrl ?? null;
  const rsOwnerSubjectId = resolveOwnerAuthPlaceholderConfig(opts).subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID;
  const trustedMetadataHosts =
    opts.trustedMetadataHosts ?? (opts.ignoreAmbientPublicUrls ? null : process.env.PDPP_TRUSTED_HOSTS);
  const rsIntrospectionCredentials = opts.rsIntrospectionCredentials ?? readIntrospectionCredentialsFromEnv();
  if (!rsIntrospectionCredentials) {
    throw new Error("RS introspection credentials must be configured");
  }
  const introspectToken = createRemoteIntrospector({
    ...rsIntrospectionCredentials,
    endpoint: opts.rsIntrospectionEndpoint ?? `http://127.0.0.1:${opts.asPort ?? AS_PORT}/introspect`,
    expectedAudience: opts.resolveIntrospectionAudience ?? (() => explicitResource ?? null),
    expectedIssuer: opts.resolveIntrospectionIssuer ?? (() => opts.asIssuer ?? opts.asPublicUrl ?? null),
    ...(opts.introspectionFetch ? { fetchImpl: opts.introspectionFetch } : {}),
  });
  const requireToken = (req: ReqLike, res: ResLike, next: () => void) =>
    requireTokenWithIntrospection(req, res, next, introspectToken);

  app.use(((
    req: ReqLike & { headers: Record<string, string | string[] | undefined> },
    res: ResLike & { locals: Record<string, unknown> },
    next: () => void
  ) => {
    res.setHeader(
      "Request-Id",
      (req as ReqLike & { get: (name: string) => string | undefined }).get("Request-Id") || generateSpineId("req")
    );
    setReferenceRevisionHeader(res, referenceRevision);
    // PDPP-Version negotiation
    const requestedVersion = req.headers["pdpp-version"];
    const CURRENT_VERSION = "2026-04-06";
    if (requestedVersion && requestedVersion !== CURRENT_VERSION) {
      return pdppError(
        res,
        400,
        "unsupported_version",
        `PDPP-Version '${requestedVersion}' is not supported. Current: ${CURRENT_VERSION}`
      );
    }
    res.setHeader("PDPP-Version", CURRENT_VERSION);
    const metadataUrl = resolveTrustedProtectedResourceMetadataUrl(
      req as Parameters<typeof resolveTrustedProtectedResourceMetadataUrl>[0],
      explicitResource,
      trustedMetadataHosts
    );
    if (metadataUrl) {
      res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = metadataUrl;
    }
    next();
  }) as unknown as Parameters<typeof app.use>[0]);

  // `GET /mcp`, `POST /mcp`, `DELETE /mcp` are mounted via
  // `server/routes/rs-hosted-mcp.ts` per OpenSpec change
  // `split-reference-server-by-route-family` (§5.4). Behaviour-preserving
  // extraction: same `requireTrustedHostedMcpResource` host guard, same
  // `setHostedMcpProtectedResourceMetadata` middleware, same
  // `requireToken` + `requireClientOrMcpPackage` auth posture, same
  // package-token → PackageRsClient fan-out, same single-bearer path,
  // same response envelope and headers.
  mountRsHostedMcp(app, {
    createPackageRsClient,
    createRsClient,
    explicitResource,
    getGrantPackageAccess,
    handleStreamableHttpRequest,
    internalResource,
    pdppError,
    referenceRevision,
    requireClientOrMcpPackage,
    requireToken,
    trustedMetadataHosts,
  } as unknown as Parameters<typeof mountRsHostedMcp>[1]);

  const attachActivationScheduleForConnection = createActivationScheduleAttacher(opts.controller);

  // Build rsMutationContext here so both mountRsEventSubscriptions (registered
  // before mountRsReadQueries) and mountRsBlobsUpload / mountRsMutation
  // (registered after) share the same context object.
  const rsMutationContext = {
    // See add-static-secret-owner-session-connect-path design Decision 5.
    activateDraftConnection: (connectorInstanceId: string) =>
      activateDraftConnection(
        connectorInstanceId,
        createRequestConnectorInstanceStore(),
        attachActivationScheduleForConnection
      ),
    buildMutationContext,
    buildStateContext,
    classifyIngestFailure,
    deleteAllRecords,
    deleteRecord,
    emitMutationEvent,
    emitMutationRequested,
    emitStateEvent,
    emitStateRequested,
    getDefaultClientEventSubscriptionStore,
    getDefaultDeliveryWorker,
    getLatestAcquisitionBatchForConnection: async (connectorInstanceId: string) =>
      (
        (await createRequestAcquisitionBatchStore().listByConnection(connectorInstanceId, { limit: 1 })) as unknown[]
      )[0] ?? null,
    getOwnerTokenSubjectId,
    getSyncState,
    handleError,
    ingestRecord: (
      target: unknown,
      record: unknown,
      options?: { requireConnectionAdmission?: boolean; runId?: string | null }
    ) =>
      ingestRecord(target as Parameters<typeof ingestRecord>[0], record as Parameters<typeof ingestRecord>[1], options),
    ingestRecords: (
      target: unknown,
      records: readonly unknown[],
      afterRecord: ((record: unknown, outcome: unknown) => Promise<void>) | undefined,
      options?: { requireConnectionAdmission?: boolean; runId?: string | null }
    ) =>
      ingestRecords(
        target as Parameters<typeof ingestRecords>[0],
        records as Parameters<typeof ingestRecords>[1],
        afterRecord,
        options
      ),
    insertOrReplayRecordRejection: async ({
      code,
      ...input
    }: Omit<InsertOrReplayRecordRejectionInput, "reasonCode"> & { code: string }) => {
      const receipt = await insertOrReplayHostedRecordRejection(
        {
          ...input,
          reasonCode: code,
        },
        opts.hostedRecordRejectionAfterInsertBeforeCommit
          ? { afterInsertOrReplayBeforeCommit: opts.hostedRecordRejectionAfterInsertBeforeCommit }
          : {}
      );
      return {
        code: receipt.code,
        input_index: receipt.inputIndex,
        receipt_id: receipt.receiptId,
      };
    },
    // Same cache the mutation routes below already invalidate on every other
    // connection-mutating action (revoke, reactivate, schedule, run, rename,
    // delete). `maybeActivateDraftAfterIngest` (rs-mutation.ts) calls this
    // after a first-ingest activation so the dashboard/Sources/Syncs summary
    // feed reflects draft -> active immediately.
    invalidateConnectorSummariesCache,
    markAcceptedRecordRejectionsStale: async (input: {
      auditActorId: string;
      auditActorType: string;
      auditTraceId: string | null;
      connectorId: string;
      connectorInstanceId: string;
      ownerSubjectId: string;
      rawLine: Buffer;
      recordKey?: string | null;
      runId?: string | null;
      stream: string;
    }) => await markAcceptedRecordRejectionsStale(input),
    markAcquisitionBatchCommitted: (connectorInstanceId: string, counts: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (
        createRequestAcquisitionBatchStore() as unknown as Record<string, (...args: unknown[]) => unknown>
      ).markCommittedForConnection?.(connectorInstanceId, counts),
    pdppError,
    persistContentAddressedBlob,
    putSyncState,
    recordAcquisitionProvenance: (record: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (
        createRequestAcquisitionBatchStore() as unknown as Record<string, (...args: unknown[]) => unknown>
      ).recordRecordProvenance?.(record),
    rejectMutation,
    rejectState,
    requireClient,
    requireOwner,
    requireToken,
    resolveGrantScopedStateGrant,
    resolveOwnerConnectorNamespace,
    resolveRegisteredConnectorManifest,
    resolveSingleConnectorIdQueryValue,
    setReferenceTraceId,
    storageTargetForConnectorNamespace,
    toPublicConnectorStateProjection,
  };

  // /v1/event-subscriptions cluster is mounted via `server/routes/rs-mutation.ts`
  // per OpenSpec change `split-reference-server-by-route-family` (§4).
  // Behaviour-preserving extraction: same auth posture (`requireClient`), same
  // middleware order, same response envelopes, same status codes.
  // Registered here — before the hosted-UI CSS and mountRsReadQueries — to
  // preserve the original route registration order.
  mountRsEventSubscriptions(app, rsMutationContext as unknown as Parameters<typeof mountRsEventSubscriptions>[1]);

  // Shared hosted-UI stylesheet, mounted on the RS app so the browser-friendly
  // RS root landing (see below) can load styles from its own origin without
  // depending on the AS port being reachable. Mounted via
  // `server/routes/hosted-ui-asset.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Behaviour-preserving extraction:
  // same path, same headers, same registration order.
  mountHostedUiCss(app);

  // RS root (`GET /`) is mounted via `server/routes/root-and-discovery.ts`
  // per OpenSpec change `split-reference-server-by-route-family`. Behaviour-
  // preserving extraction: same mount point, same handler, same envelope.
  mountRsRoot(app, {
    // Advisory owner-agent onboarding pointer on the RS root. Same host
    // capabilities the protected-resource metadata route uses, so the root and
    // `.well-known` documents stay consistent and forwarded-origin-safe. See
    // openspec/changes/add-trusted-owner-agent-onboarding.
    agentDiscoveryOrigin: opts.agentDiscoveryOrigin || null,
    asPort: opts.asPort || AS_PORT,
    buildOwnerAgentOnboardingMetadata,
    explicitResource,
    providerName,
    referenceRevision,
    rejectUntrustedMetadataHost,
    resolveExplicitIssuer: () =>
      opts.asIssuer ||
      opts.asPublicUrl ||
      (opts.ignoreAmbientPublicUrls ? null : process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) ||
      null,
    resolvePublicUrl: (req: unknown, explicitUrl?: string | null) =>
      resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitUrl),
    resolveSiblingPublicUrl,
    servedRootLandingIfBrowser,
    shouldUseDirectRequestOrigin,
    trustedMetadataHosts,
  } as unknown as Parameters<typeof mountRsRoot>[1]);

  // RS `/.well-known/oauth-protected-resource` and `/oauth-protected-resource/mcp`
  // are mounted via `server/routes/root-and-discovery.ts` per OpenSpec change
  // `split-reference-server-by-route-family`. Behaviour-preserving extraction:
  // same mount points, same handlers, same envelopes.
  const protectedResourceMetadataContext = {
    agentDiscoveryOrigin: opts.agentDiscoveryOrigin || null,
    asPort: opts.asPort || AS_PORT,
    buildAgentDiscoveryMetadata,
    buildDefaultHybridCapability: ({
      lexicalAvailable,
      semanticAvailable,
    }: {
      lexicalAvailable: unknown;
      semanticAvailable: unknown;
    }) => (buildHybridRetrievalCapability as (...args: unknown[]) => unknown)({ lexicalAvailable, semanticAvailable }),
    buildOwnerAgentOnboardingMetadata,
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
      if (opts.clientEventSubscriptionsSupported === false) {
        return null;
      }
      return buildClientEventSubscriptionsCapability();
    },
    resolveExplicitIssuer: () =>
      opts.asIssuer ||
      opts.asPublicUrl ||
      (opts.ignoreAmbientPublicUrls ? null : process.env.AS_ISSUER || process.env.AS_PUBLIC_URL),
    resolveHybridCapabilityOverride: () => opts.hybridRetrievalCapability || null,
    resolveLexicalCapability: async () => {
      if (opts.lexicalRetrievalCapability) {
        return opts.lexicalRetrievalCapability;
      }
      if (opts.lexicalRetrievalSupported !== false) {
        return buildLexicalRetrievalCapability({ indexState: await computeLexicalIndexState() });
      }
      return null;
    },
    resolvePublicUrl,
    resolveSemanticCapability: async () => {
      if (opts.semanticRetrievalCapability) {
        return opts.semanticRetrievalCapability;
      }
      if (opts.semanticRetrievalSupported === false) {
        return null;
      }
      const semBackend = getSemanticBackend();
      if (!semBackend?.available()) {
        return null;
      }
      return ((buildSemanticRetrievalCapability as (...args: unknown[]) => unknown)({
        dimensions: semBackend.dimensions(),
        distanceMetric: semBackend.distanceMetric(),
        dtype: semBackend.dtype ? (semBackend.dtype as () => unknown)() : null,
        indexState: await (computeSemanticIndexState as () => Promise<unknown>)(),
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        languageBias: semBackend.languageBias ? (semBackend.languageBias as () => unknown)() : null,
        model: semBackend.model(),
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        profileId: semBackend.profileId ? semBackend.profileId() : null,
      }) || null) as { primary: string; note?: string } | null;
    },
    resolveSiblingPublicUrl,
    resolveSourceDeclarationUri: () => opts.sourceDeclarationUri ?? null,
    shouldUseDirectRequestOrigin,
    trustedMetadataHosts,
  };
  mountRsProtectedResourceMetadata(
    app,
    protectedResourceMetadataContext as unknown as Parameters<typeof mountRsProtectedResourceMetadata>[1]
  );
  mountRsMcpProtectedResourceMetadata(
    app,
    protectedResourceMetadataContext as unknown as Parameters<typeof mountRsMcpProtectedResourceMetadata>[1]
  );

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
    AmbiguousConnectionError,
    aggregateRecordsAcrossBindings,
    buildClientSourceDescriptor,
    buildConnectorAwareFreshness,
    buildConnectorDiscoveryItem,
    buildConnectorSchemaItem,
    buildOwnerQuerySourceDescriptor,
    buildOwnerReadGrant,
    buildQueryActorContext,
    buildSourceDescriptor,
    buildStreamMetadataEntry,
    canonicalConnectorKey,
    countSearchIndexDirtyScopes: countDirtySearchIndexScopes,
    createBlobStore,
    decorateRecordBlobRefs,
    emitQueryReceived,
    emitSpineEvent,
    ensureRequestId,
    finalizeCanonicalEnvelope,
    getConnectorFreshnessEvidence,
    getOwnerTokenSubjectId,
    getRecord,
    getRecordAcrossBindings,
    getRecordFieldWindowAcrossBindings,
    getSemanticBackend,
    getVisibleStreamFreshness,
    handleError,
    listAllStreams,
    listRegisteredConnectorIds,
    listStreamsAcrossBindings,
    opts,
    ownerSubjectIdForBindings,
    projectBindingForWire,
    queryRecordsAcrossBindings,
    rejectQuery,
    requireToken,
    resolveGrantManifest: (tokenInfo: unknown, options: unknown) =>
      resolveGrantManifest(
        tokenInfo as Parameters<typeof resolveGrantManifest>[0],
        options as Parameters<typeof resolveGrantManifest>[1]
      ),
    resolveNativeManifest,
    resolveNativeStorageBinding,
    resolveOwnerManifest: (req: unknown, options: unknown) =>
      resolveOwnerManifest(
        req as Parameters<typeof resolveOwnerManifest>[0],
        options as Parameters<typeof resolveOwnerManifest>[1]
      ),
    resolveOwnerManifestFromScope: (ownerScope: unknown, options: unknown) =>
      resolveOwnerManifestFromScope(
        ownerScope as Parameters<typeof resolveOwnerManifestFromScope>[0],
        options as Parameters<typeof resolveOwnerManifestFromScope>[1]
      ),
    resolveOwnerReadScope,
    resolveReadRequestBindings,
    resolveRegisteredConnectorManifest,
    runHybridSearch,
    runLexicalSearch,
    runSemanticSearch,
    setReferenceTraceId,
    triggerSearchIndexDirtySelfHeal,
    validateRequestedQueryFieldParams,
  };
  mountRsReadQueries(app, rsReadContext as unknown as Parameters<typeof mountRsReadQueries>[1]);

  // POST /v1/blobs is mounted via `server/routes/rs-mutation.ts` per OpenSpec
  // change `split-reference-server-by-route-family` (§4). Behaviour-preserving
  // extraction: same auth posture (`requireOwner`), same request-id / trace-id
  // wiring, same response envelope, same status codes.
  // Registered immediately after mountRsReadQueries, before mountRsBlobRead,
  // to preserve the original route registration order.
  mountRsBlobsUpload(app, rsMutationContext as unknown as Parameters<typeof mountRsBlobsUpload>[1]);

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
    buildOwnerConnectionSupportedActions,
    canonicalConnectorKey,
    createRequestConnectorInstanceStore,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    listSchedules: async () => (opts.controller ? await opts.controller.listSchedules() : []),
    markConnectorSummaryEvidenceDirty,
    pdppError,
    projectStorageDisplayName,
    requireOwner,
    requireToken,
    // Same trusted, forwarded-origin-safe RS base resolution the control
    // entrypoint uses, so a row's supported_actions URLs match the advertised
    // resource and the per-connection catalog agrees with GET /v1/owner/control.
    resolveResource: (req: unknown) =>
      resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitResource),
    resolveSingleConnectorIdQueryValue,
    setReferenceTraceId,
  };
  mountOwnerConnectionsList(app, ownerConnectionsContext as unknown as Parameters<typeof mountOwnerConnectionsList>[1]);

  // PATCH /v1/owner/connections/:connectionId is the bearer-authed owner-agent
  // rename: a trusted local owner agent labels a connection (e.g. "the owner personal"
  // / "Shared Amazon") without a browser owner session or `/_ref` session cookie.
  // It shares the connector-instance store rename semantics with the cookie-authed
  // `PATCH /_ref/connections/:id` route under a separate owner-bearer auth adapter;
  // `/mcp` owner-bearer rejection is untouched. See
  // openspec/changes/add-owner-agent-control-surface (task 4.4).
  mountOwnerConnectionRename(
    app,
    ownerConnectionsContext as unknown as Parameters<typeof mountOwnerConnectionRename>[1]
  );

  // POST /v1/owner/connections/:connectionId/schedule/{pause,resume},
  // POST /v1/owner/connectors/:connectorId/schedule/{pause,resume}, and
  // DELETE /v1/owner/{connections/:connectionId,connectors/:connectorId}/schedule
  // are the bearer-authed owner-agent schedule lifecycle control routes. A
  // trusted local owner agent pauses, resumes, or deletes a connection's
  // schedule without a browser owner session. They share the controller
  // `setScheduleEnabled` (pause/resume) and `deleteSchedule` (delete) semantics
  // (schedule-not-found 404, automation-ineligibility 400 on resume, delete
  // returns 204 / typed 404 when no schedule existed, scheduler refresh on
  // success) with the cookie-authed `/_ref` schedule routes under a separate
  // owner-bearer auth adapter (`requireToken` + `requireOwner`). The
  // connector-only routes auto-select the single active connection or reject
  // with a typed `ambiguous_connection` (409) carrying available `connection_id`
  // values; `/mcp` owner-bearer rejection is untouched. See
  // openspec/changes/add-owner-agent-control-surface (tasks 6.1-6.3).
  mountOwnerConnectionSchedule(app, {
    AmbiguousConnectionError,
    canonicalConnectorKey,
    createTraceContext,
    deleteSchedule: (connectorId: string, options: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (opts.controller as unknown as Record<string, (...args: unknown[]) => unknown>).deleteSchedule?.(
        connectorId,
        options
      ),
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    listActiveBindingsForGrant,
    markConnectorSummaryEvidenceDirty,
    onScheduleMutation: opts.onScheduleMutation,
    pdppError,
    projectBindingForWire,
    requireOwner,
    requireToken,
    resolveOwnerConnectorNamespace,
    setReferenceTraceId,
    setScheduleEnabled: (connectorId: string, enabled: boolean, options: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (opts.controller as unknown as Record<string, (...args: unknown[]) => unknown>).setScheduleEnabled?.(
        connectorId,
        enabled,
        options
      ),
  } as unknown as Parameters<typeof mountOwnerConnectionSchedule>[1]);

  // The owner's read/write surface for a local connection's declared collection
  // boundary. Without this the scope machinery is unreachable and every run is
  // unscoped by construction, so a "complete" claim is always a whole-corpus
  // claim. Persisting through `putSyncState` writes the reserved
  // `$collection_scope` entry the collector already reads at run start, so the
  // same write both stores the boundary and delivers it.
  mountOwnerConnectionCollectionScope(
    app as unknown as Parameters<typeof mountOwnerConnectionCollectionScope>[0],
    {
      declassifyCollectionProof: async ({
        connectorInstanceId,
        reason,
      }: {
        connectorInstanceId: string;
        reason: string;
      }) => {
        invalidateConnectorSummariesCache();
        await markConnectorSummaryEvidenceDirty?.({ connectorInstanceId, reason });
      },
      getOwnerTokenSubjectId,
      getSyncState,
      handleError,
      pdppError,
      putSyncState,
      referenceLocalDeviceStorageTarget: (connectorId: string, connectorInstanceId: string) => ({
        connector_id: canonicalConnectorKey(connectorId) ?? connectorId,
        connector_instance_id: connectorInstanceId,
      }),
      requireOwner,
      requireToken,
      resolveOwnerConnectorNamespace,
    } as unknown as Parameters<typeof mountOwnerConnectionCollectionScope>[1]
  );

  // The owner's read/write surface for a connection's attributed
  // configuration-revision ledger. `propose` appends an immutable revision;
  // `confirm` is the ONLY way a collection-shaping revision becomes active,
  // and it takes the owner subject from the authenticated bearer session
  // (`getOwnerTokenSubjectId`), never from the request body — a body-supplied
  // owner subject would make owner confirmation forgeable by any agent
  // holding the token. The runtime reads the confirmed result at run start
  // via `server/connector-run-config.ts`.
  mountOwnerConnectionConfig(
    app as unknown as Parameters<typeof mountOwnerConnectionConfig>[0],
    {
      getOwnerTokenSubjectId,
      handleError,
      pdppError,
      requireOwner,
      requireToken,
      resolveOwnerConnectorNamespace,
      store: getDefaultConnectorInstanceConfigStore(),
    } as unknown as Parameters<typeof mountOwnerConnectionConfig>[1]
  );

  // POST /v1/owner/connections/:connectionId/run and
  // POST /v1/owner/connectors/:connectorId/run are the bearer-authed owner-agent
  // run-now siblings of the cookie-authed `/_ref/connections/:id/run` and
  // `/_ref/connectors/:id/run` routes. They converge on ONE mutation path — the
  // controller's `runNow`, owner-scoped via the connector-instance namespace
  // resolver — under separate auth adapters (`requireToken` + `requireOwner` vs
  // `requireOwnerSession`), so the async run semantics (202 with the run handle,
  // typed `run_already_active` 409) are shared, not cloned. The connector-only
  // route auto-selects the single active connection or rejects with a typed
  // `ambiguous_connection` (409) carrying available `connection_id` values;
  // `/mcp` owner-bearer rejection is untouched. See
  // openspec/changes/add-owner-agent-control-surface (tasks 6.1-6.3).
  mountOwnerConnectionRun(app, {
    AmbiguousConnectionError,
    canonicalConnectorKey,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    listActiveBindingsForGrant,
    markConnectorSummaryEvidenceDirty,
    pdppError,
    projectBindingForWire,
    requireOwner,
    requireToken,
    resolveOwnerConnectorNamespace,
    runNow: (connectorId: string, options: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (opts.controller as unknown as Record<string, (...args: unknown[]) => unknown>).runNow?.(connectorId, options),
    setReferenceTraceId,
  } as unknown as Parameters<typeof mountOwnerConnectionRun>[1]);

  // POST /v1/owner/connections/:connectionId/revoke and
  // POST /v1/owner/connectors/:connectorId/revoke are the bearer-authed
  // owner-agent connection-revoke routes: a trusted local owner agent stops ONE
  // connection's future collection by flipping its connector_instance to status
  // `revoked`, addressed by connection_id (or connector_id when unambiguous).
  // There is no cookie-authed `/_ref` revoke route to share with — revoke is a
  // new owner-agent control surface built directly on the existing
  // connector-instance store soft-flip primitive (`updateStatus → 'revoked'`),
  // so it adds NO new destructive semantic; it shares that store primitive under
  // the same owner-bearer auth adapter the run/schedule routes use. Revoke is
  // zero-cascade (records, spine, device rows, and sibling connections are
  // untouched) and durable (default-account materialization no longer resurrects
  // a revoked row). Ownership is enforced by the namespace resolver BEFORE the
  // mutation (foreign connection_id → 404), a repeat revoke returns a typed
  // connector_instance_inactive (400), and the connector-only route
  // auto-selects a single active connection or rejects with a typed
  // `ambiguous_connection` (409). `/mcp` owner-bearer rejection is untouched. See
  // openspec/changes/add-owner-agent-control-surface (tasks 3.1d/6.1d, design
  // "Deferred: connection-revoke durability" → Unit 2).
  mountOwnerConnectionRevoke(app, {
    AmbiguousConnectionError,
    canonicalConnectorKey,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    listActiveBindingsForGrant,
    markConnectorSummaryEvidenceDirty,
    pdppError,
    projectBindingForWire,
    requireOwner,
    requireToken,
    resolveOwnerConnectorNamespace,
    setReferenceTraceId,
    updateConnectorInstanceStatus: (connectorInstanceId: string, options: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (
        createRequestConnectorInstanceStore() as unknown as Record<string, (...args: unknown[]) => unknown>
      ).updateStatus?.(connectorInstanceId, options),
  } as unknown as Parameters<typeof mountOwnerConnectionRevoke>[1]);

  // POST /v1/owner/connections/:connectionId/reactivate and
  // POST /v1/owner/connectors/:connectorId/reactivate are the bearer-authed
  // owner-agent connection-REACTIVATE routes: the clean inverse of revoke.
  // Flips a single `revoked` connection back to `active`, clears `revoked_at`,
  // and resumes future collection. Already-collected records, grants, schedule,
  // and audit spine are untouched — zero cascade. Ownership is enforced by the
  // namespace resolver with `allowStatuses: ['revoked']` BEFORE any mutation
  // (foreign/unknown id → 404; non-revoked id → connector_instance_not_revoked
  // 409). Credential freshness is delegated to the next collection run.
  mountOwnerConnectionReactivate(app, {
    AmbiguousConnectionError,
    canonicalConnectorKey,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    listActiveBindingsForGrant,
    listRevokedConnectionsForConnector: async ({
      ownerSubjectId,
      connectorId,
    }: {
      ownerSubjectId: string;
      connectorId: string;
    }) =>
      (
        (await createRequestConnectorInstanceStore().listByOwner(ownerSubjectId)) as unknown as Array<{
          connectorId: string;
          status: string;
        }>
      ).filter((inst) => inst.connectorId === connectorId && inst.status === "revoked"),
    markConnectorSummaryEvidenceDirty,
    pdppError,
    projectBindingForWire,
    requireOwner,
    requireToken,
    resolveOwnerConnectorNamespace,
    setReferenceTraceId,
    updateConnectorInstanceStatus: (connectorInstanceId: string, options: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (
        createRequestConnectorInstanceStore() as unknown as Record<string, (...args: unknown[]) => unknown>
      ).updateStatus?.(connectorInstanceId, options),
  } as unknown as Parameters<typeof mountOwnerConnectionReactivate>[1]);

  // POST /v1/owner/connections/:connectionId/resume and
  // POST /v1/owner/connectors/:connectorId/resume are the bearer-authed
  // owner-agent connection-RESUME routes: the `paused`-status sibling of
  // reactivate. Flips a single `paused` connection back to `active` so it
  // becomes runnable again. Already-collected records, grants, schedule, and
  // audit spine are untouched — zero cascade. Ownership is enforced by the
  // namespace resolver with `allowStatuses: ['paused']` BEFORE any mutation
  // (foreign/unknown id → 404; non-paused id → connector_instance_not_paused
  // 409). Credential freshness is delegated to the next collection run — the
  // owner is expected to have already repaired the credential (e.g. via the
  // static-secret credential-capture route, which admits a `paused` target)
  // before calling resume.
  mountOwnerConnectionResume(app, {
    AmbiguousConnectionError,
    canonicalConnectorKey,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    listActiveBindingsForGrant,
    listPausedConnectionsForConnector: async ({
      ownerSubjectId,
      connectorId,
    }: {
      ownerSubjectId: string;
      connectorId: string;
    }) =>
      (
        (await createRequestConnectorInstanceStore().listByOwner(ownerSubjectId)) as unknown as Array<{
          connectorId: string;
          status: string;
        }>
      ).filter((inst) => inst.connectorId === connectorId && inst.status === "paused"),
    markConnectorSummaryEvidenceDirty,
    pdppError,
    projectBindingForWire,
    requireOwner,
    requireToken,
    resolveOwnerConnectorNamespace,
    setReferenceTraceId,
    updateConnectorInstanceStatus: (connectorInstanceId: string, options: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (
        createRequestConnectorInstanceStore() as unknown as Record<string, (...args: unknown[]) => unknown>
      ).updateStatus?.(connectorInstanceId, options),
  } as unknown as Parameters<typeof mountOwnerConnectionResume>[1]);

  // POST /v1/owner/connections/:connectionId/pause and
  // POST /v1/owner/connectors/:connectorId/pause are the bearer-authed
  // owner-agent connection-PAUSE routes: the inverse of resume directly above.
  // Flips a single `active` connection to `paused` so no future scheduled or
  // manual run lands for it. Already-collected records, grants, schedule, the
  // stored credential, and the audit spine are untouched — zero cascade, and
  // the row stays fully resumable. Ownership is enforced by the namespace
  // resolver with `allowStatuses: ['active']` BEFORE any mutation
  // (foreign/unknown id → 404; non-active id → connector_instance_not_active
  // 409). The connector-only variant selects the single ACTIVE connection via
  // `listActiveBindingsForGrant` (whose SQL pins `status = 'active'`), the
  // mirror of resume's paused-row filter.
  mountOwnerConnectionPause(app, {
    AmbiguousConnectionError,
    canonicalConnectorKey,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    listActiveBindingsForGrant,
    markConnectorSummaryEvidenceDirty,
    pdppError,
    projectBindingForWire,
    requireOwner,
    requireToken,
    resolveOwnerConnectorNamespace,
    setReferenceTraceId,
    updateConnectorInstanceStatus: (connectorInstanceId: string, options: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (
        createRequestConnectorInstanceStore() as unknown as Record<string, (...args: unknown[]) => unknown>
      ).updateStatus?.(connectorInstanceId, options),
  } as unknown as Parameters<typeof mountOwnerConnectionPause>[1]);

  // DELETE /v1/owner/connections/:connectionId and
  // DELETE /v1/owner/connectors/:connectorId are the bearer-authed owner-agent
  // connection-DELETE routes: a trusted local owner agent DESTRUCTIVELY purges
  // ONE connection — its records/history/blobs/search/attention and its
  // schedule, the device source-instance back-reference, and the
  // connector_instances row — keyed strictly on one connection_id. An in-flight
  // run's active-run lease is REFUSED, never erased. Unlike revoke (zero-cascade
  // soft-flip preserving the past), delete erases the past and removes the
  // configuration. It PRESERVES the audit spine (appending an
  // owner_agent.connection.delete event), disclosure grants, sibling
  // connections, and the device edge. Ownership is verified in the store BEFORE
  // any mutation (foreign/unknown/repeat → connector_instance_not_found 404, no
  // existence leak — the same code the sibling owner-agent instance-control
  // routes raise); an in-flight run → connection_run_active (409); a
  // default-account binding → default_account_delete_unsupported (409, no silent
  // re-materialization). The connector-only route auto-selects a single active
  // connection or returns a typed ambiguous_connection (409). The durable
  // source-of-truth cascade (records-family + schedule + device back-ref +
  // connector_instances row) is ONE all-or-nothing transaction per backend;
  // search-index teardown is a rebuildable projection torn down after that
  // commit. `/mcp` owner-bearer rejection is untouched. See
  // openspec/changes/add-owner-connection-delete-contract.
  mountOwnerConnectionDelete(app, {
    AmbiguousConnectionError,
    canonicalConnectorKey,
    createTraceContext,
    deleteConnection: (connectorInstanceId: string, options: unknown) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      (
        createRequestConnectorInstanceStore() as unknown as Record<string, (...args: unknown[]) => unknown>
      ).deleteConnection?.(connectorInstanceId, {
        ...(options as Record<string, unknown>),
        purge: {
          deleteRecordRejectionsPostgres: (client: unknown, id: string, ownerSubjectId: string) =>
            deletePostgresRecordRejectionsForConnectionWithClient(
              client as Parameters<typeof deletePostgresRecordRejectionsForConnectionWithClient>[0],
              { connectorInstanceId: id, ownerSubjectId }
            ),
          deleteRecordRejectionsSqlite: (id: string, ownerSubjectId: string) =>
            deleteSqliteRecordRejectionsForConnectionWithinTransaction({ connectorInstanceId: id, ownerSubjectId }),
          deleteRecordRowsPostgres: (client: unknown, id: string) =>
            deleteConnectionRecordRowsPostgres(client as Parameters<typeof deleteConnectionRecordRowsPostgres>[0], id),
          deleteRecordRowsSqlite: (id: string) => deleteConnectionRecordRowsSqlite(id),
          enumerateStreams: (storageTarget: unknown) =>
            enumerateConnectionStreams(storageTarget as Parameters<typeof enumerateConnectionStreams>[0]),
          teardownProjection: (args: unknown) =>
            teardownConnectionSearchProjection(args as Parameters<typeof teardownConnectionSearchProjection>[0]),
        },
      }),
    emitSpineEvent,
    ensureRequestId,
    getOwnerTokenSubjectId,
    handleError,
    invalidateConnectorSummariesCache,
    listActiveBindingsForGrant,
    markConnectorSummaryEvidenceDirty,
    pdppError,
    projectBindingForWire,
    requireOwner,
    requireToken,
    resolveOwnerConnectorNamespace,
    setReferenceTraceId,
  } as unknown as Parameters<typeof mountOwnerConnectionDelete>[1]);

  // GET /v1/owner/connections/:connectionId/diagnostics and
  // GET /v1/owner/connectors/:connectorId/diagnostics are the bearer-authed
  // owner-agent connection-scoped diagnostics reads: a trusted local owner agent
  // inspects ONE connection's last run status, last successful ingest time,
  // current schedule state, freshness, and typed health classification, without a
  // browser owner session. They share the `getOwnerConnectionDiagnostics`
  // operation (which projects the requested connection only) under a separate
  // owner-bearer auth adapter (`requireToken` + `requireOwner`). The read is
  // connection-scoped by construction — it derives from the single configured
  // connection matching the resolved `connection_id`, never device-exporter
  // subsystem or sibling-connection state, which is why it is safe to share where
  // the device-rooted `GET /_ref/device-exporters/diagnostics` is not. The
  // connector-only route auto-selects the single active connection or rejects with
  // a typed `ambiguous_connection` (409); `/mcp` owner-bearer rejection is
  // untouched. See openspec/changes/add-owner-agent-control-surface (tasks 6.1d,
  // design "Deferred: connection-scoped diagnostics").
  mountOwnerConnectionDiagnostics(app, {
    AmbiguousConnectionError,
    canonicalConnectorKey,
    createTraceContext,
    emitSpineEvent,
    ensureRequestId,
    getOwnerConnectionDiagnostics: (connectorInstanceId: string) =>
      getOwnerConnectionDiagnostics(connectorInstanceId, opts.controller),
    getOwnerTokenSubjectId,
    handleError,
    listActiveBindingsForGrant,
    pdppError,
    projectBindingForWire,
    requireOwner,
    requireToken,
    resolveOwnerConnectorNamespace,
    setReferenceTraceId,
  } as unknown as Parameters<typeof mountOwnerConnectionDiagnostics>[1]);

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
  const resolveAsIssuerBase = (req: ReqLike & { protocol: string; hostname: string }) => {
    const explicitIssuer =
      opts.asIssuer ||
      opts.asPublicUrl ||
      (opts.ignoreAmbientPublicUrls ? null : process.env.AS_ISSUER || process.env.AS_PUBLIC_URL);
    const fallbackIssuer = `${req.protocol}://${req.hostname}:${opts.asPort || AS_PORT}`;
    const issuerSource = shouldUseDirectRequestOrigin(req, explicitIssuer)
      ? fallbackIssuer
      : explicitIssuer || fallbackIssuer;
    return resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], issuerSource);
  };
  mountOwnerConnectionIntent(app, {
    canonicalConnectorKey,
    createTraceContext,
    deviceExporterStore: opts.deviceExporterStore || getDefaultDeviceExporterStore(),
    emitSpineEvent,
    ensureRequestId,
    generateReferenceSecret,
    generateSpineId,
    getConnectorManifest: (connectorId: string) => getConnectorManifest(connectorId),
    getOwnerTokenSubjectId,
    handleError,
    hashDeviceSecret,
    pdppError,
    readReferenceLocalConnectorCatalogManifest,
    requireOwner,
    requireToken,
    resolveEnrollBaseUrl: resolveAsIssuerBase,
    setReferenceTraceId,
  } as unknown as Parameters<typeof mountOwnerConnectionIntent>[1]);

  // GET /v1/owner/connector-templates is the bearer-authed owner-agent template
  // catalog. It separates connector implementation metadata from configured
  // connection instances, embeds related connection summaries, and reports
  // template-level `initiate_connection` support truthfully: only registered
  // templates whose server-owned listing, proof, readiness, and planner
  // contract support an owner action receive a supported intent.
  mountOwnerConnectorTemplates(app, {
    canonicalConnectorKey,
    configuredProviderAuthConnectorKeys: opts.configuredProviderAuthConnectorKeys ?? [],
    createRequestConnectorInstanceStore,
    getConnectorManifest: (connectorId: string) => getConnectorManifest(connectorId),
    getOwnerTokenSubjectId,
    handleError,
    listRegisteredConnectorIds,
    projectStorageDisplayName,
    requireOwner,
    requireToken,
    resolveResource: (req: unknown) =>
      resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitResource),
    uatConnectorAllowlist: parseUatConnectorAllowlist(process.env.PDPP_UAT_CONNECTOR_ALLOWLIST),
    uatExposeUnlistedConnectors: process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT === "1",
  } as unknown as Parameters<typeof mountOwnerConnectorTemplates>[1]);

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
    buildOwnerAgentControlSurface,
    handleError,
    requireOwner,
    requireToken,
    resolveResource: (req: unknown) =>
      resolvePublicUrl(req as Parameters<typeof resolvePublicUrl>[0], explicitResource),
  } as unknown as Parameters<typeof mountOwnerControl>[1]);

  // GET /v1/blobs/:blob_id is mounted via `server/routes/rs-read.ts` (§3),
  // registered here — immediately after `POST /v1/blobs` — to preserve the
  // original route registration order. Behaviour-preserving extraction.
  mountRsBlobRead(app, rsReadContext as unknown as Parameters<typeof mountRsBlobRead>[1]);

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
      ingestRecord: (target: unknown, record: unknown, options: unknown) =>
        ingestRecord(
          target as Parameters<typeof ingestRecord>[0],
          record as Parameters<typeof ingestRecord>[1],
          options as Parameters<typeof ingestRecord>[2]
        ),
      ownerSubjectId: rsOwnerSubjectId,
      parseSourceWebhookSecrets,
      pdppError,
      projectRunAutomationPolicy,
      resolveRegisteredConnectorManifest,
      resolveSourceWebhookTarget: async ({
        connectorId,
        connectorInstanceId,
        ownerSubjectId,
      }: {
        connectorId: string;
        connectorInstanceId?: string | null;
        ownerSubjectId: string;
        sourceId: string;
      }) => {
        try {
          const resolvedConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
          const namespace = await resolveOwnerConnectorInstanceNamespace({
            connectorId: resolvedConnectorId,
            connectorInstanceId: connectorInstanceId ?? null,
            connectorInstanceStore: createRequestConnectorInstanceStore(),
            ownerSubjectId,
          });
          return {
            connectorId: namespace.connectorId,
            connectorInstanceId: namespace.connectorInstanceId,
            ownerSubjectId: namespace.ownerSubjectId,
          };
        } catch (err) {
          throw sourceWebhookResolutionError(err);
        }
      },
    } as unknown as Parameters<typeof mountRefSourceWebhooks>[1]);

    // DELETE /v1/streams/:stream/records, DELETE /v1/streams/:stream/records/:id,
    // POST /v1/ingest/:stream, GET /v1/state/:connectorId, PUT /v1/state/:connectorId
    // are mounted via `server/routes/rs-mutation.ts` per OpenSpec change
    // `split-reference-server-by-route-family` (§4). Behaviour-preserving extraction:
    // same auth posture, same middleware order, same response envelopes, same status
    // codes, same spine event emission. Only registered in polyfill mode (!nativeMode).
    mountRsMutation(app, rsMutationContext as unknown as Parameters<typeof mountRsMutation>[1]);
  }

  return app;
}

// ─── Main ────────────────────────────────────────────────────────────────────

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
export async function startServer(opts: ServerOpts = {}) {
  const introspectionCredentials = resolveIntrospectionCredentials(opts);
  const logger = opts.logger ?? buildLogger({ quiet: !!opts.quiet });
  const connectorEnvironmentPolicy = resolveConnectorEnvironmentPolicy(opts);
  setConnectorSummaryReconcileObservationSink(createConnectorSummaryReconcileObservationSink(logger));
  const nativeConfig = validateNativeConfiguration(opts);
  const storageBackend = (resolveStorageBackend as (...args: unknown[]) => { backend: string; databaseUrl?: string })({
    opts,
  });
  // Storage-mode boundary: in Postgres mode, Postgres owns runtime persistence,
  // so startup MUST NOT open or migrate the configured *persistent* SQLite file.
  // We still init SQLite as an explicitly non-durable in-memory handle so guarded
  // modules that hold a `getDb()` reference never observe `null`; it opens no
  // file, runs no persistent migration, serves no durable answer, and is dropped
  // on shutdown. See openspec/changes/exclude-persistent-sqlite-from-postgres-boot
  // and design-notes/postgres-runtime-boundary-sqlite-classification-2026-05-28.md.
  const sqliteInitPath = storageBackend.backend === "postgres" ? ":memory:" : opts.dbPath || DB_PATH;
  await initDb(sqliteInitPath, {
    ...(opts.sqliteBusyTimeoutMs === null ? {} : { busyTimeoutMs: opts.sqliteBusyTimeoutMs }),
    onSchemaRetry: ({ attempt, delay, err }: { attempt: number; delay: number; err: unknown }) => {
      const errObj = err as Record<string, unknown> | null | undefined;
      logger.warn(
        { attempt, code: errObj?.code, delayMs: delay, msg: errObj?.message },
        "startup schema exec contended with sqlite lock; retrying"
      );
    },
  } as Parameters<typeof initDb>[1]);
  // Establish the active runtime backend BEFORE any backend-dispatching startup
  // write. `seedPreRegisteredClients` dispatches on `isPostgresStorageBackend()`,
  // which only reports `postgres` once `initPostgresStorage` has run; seeding
  // before this point would persist pre-registered clients to SQLite even in
  // Postgres mode.
  await initPostgresStorage(storageBackend as unknown as Parameters<typeof initPostgresStorage>[0], {
    log: (msg: string) => logger.info(msg),
  });
  if (storageBackend.backend === "postgres") {
    logger.info("postgres runtime storage initialized");
  }
  await (seedPreRegisteredClients as (...args: unknown[]) => Promise<void>)(resolvePreRegisteredPublicClients(opts), {
    onRetry: ({ attempt, delay, err }: { attempt: number; delay: number; err: unknown }) => {
      const errObj = err as Record<string, unknown> | null | undefined;
      logger.warn(
        { attempt, code: errObj?.code, delayMs: delay, msg: errObj?.message },
        "startup client seed contended with sqlite lock; retrying"
      );
    },
  });
  logger.info("database initialized");

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
    { boot_epoch: bootEpoch.boot_epoch, controller_id: bootEpoch.controller_id, seq: bootEpoch.seq },
    "controller booted"
  );

  // Boot-epoch reconciliation — STAGE 6.
  // Walk the spine for orphaned run.started events from prior incarnations
  // and emit run.abandoned for each, then re-project any run_history row
  // still claiming `running` against an already-terminal spine. Runs
  // synchronously before HTTP routes mount, so the dashboard never sees a
  // half-reconciled state and no connection is refused a new run by a
  // stale active-run read. Throws on any non-idempotency error; we
  // propagate up so startServer rejects and traffic does not begin. See
  // docs/run-reconciliation-design-brief.md §3.4.
  const reconciled = await reconcileOrphanedRunsAtBoot(bootEpoch);
  if (reconciled.selected > 0 || reconciled.repaired > 0) {
    logger.info(
      {
        abandoned: reconciled.abandoned,
        controller_id: bootEpoch.controller_id,
        repaired: reconciled.repaired,
        selected: reconciled.selected,
      },
      "boot-time orphan reconciliation: terminalised prior-incarnation orphans and repaired run_history drift"
    );
  }

  // Record-attribution consistency check. Every owner surface enumerates
  // connections from `connector_instances` and scopes record reads by
  // `connector_instance_id`, so a live record whose instance row is gone is
  // reachable from no surface at all. Read-only and non-fatal: it reports a
  // pre-existing data condition the owner must adjudicate, and refusing to
  // boot over it would take every VISIBLE record offline too. Runs here, with
  // the other boot reconciliations and before HTTP routes mount, so a restart
  // can never leave the system silently inconsistent (P1).
  await checkOrphanedRecordsAtBoot(logger);

  // H5: manual-upload artifacts left stuck at uploaded/validating by a
  // process that died mid-upload/mid-validation (crash, OOM, kill -9, an
  // unclean deploy restart) sit non-terminal forever with nothing else to
  // revisit them; terminalize them once at boot, same shape as the
  // orphaned-run reconciliation above. Not gated behind the polyfill-
  // manifest-reconcile enable/disable switch below -- this sweep only
  // touches rows left behind by a PRIOR incarnation (their owner_epoch is
  // not the epoch stamped above), never overwrites manifests, so it's safe
  // to always run.
  const abandonedUploads = await reconcileAbandonedManualUploadArtifactsAtBoot({
    createRequestManualUploadArtifactStore,
  } as unknown as Parameters<typeof reconcileAbandonedManualUploadArtifactsAtBoot>[0]);
  if (abandonedUploads.swept > 0) {
    logger.info(
      { swept: abandonedUploads.swept },
      "boot-time manual-upload reconciliation: terminalised artifacts abandoned by a prior process incarnation"
    );
  }

  (configureNativeManifest as (m: ConnectorManifest | null) => void)(nativeConfig?.nativeManifest || null);

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
    // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
    const envEnabled = envToggle === "1" ? true : envToggle === "0" ? false : undefined;
    const defaultEnabled = shouldAutoReconcilePolyfillManifests({
      dbPath: resolvedDbPath,
      storageBackendKind: storageBackend.backend,
    });
    const reconcileEnabled =
      opts.reconcilePolyfillManifests === undefined
        ? // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
          envEnabled === undefined
          ? defaultEnabled
          : envEnabled
        : !!opts.reconcilePolyfillManifests;
    const summary = await reconcilePolyfillManifests({
      enabled: reconcileEnabled,
      includeUnlisted: process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT === "1",
      log: (msg) => logger.info(msg),
    });
    if (summary.scanned > 0) {
      logger.info(summary, "polyfill manifest reconcile summary");
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
  } else if (opts.semanticRetrievalBackend === undefined) {
    configureSemanticBackend(resolveSemanticBackendFromEnv());
  } else {
    configureSemanticBackend(opts.semanticRetrievalBackend as Parameters<typeof configureSemanticBackend>[0]);
  }

  // Model preparation is an optional acceleration effect, not a boot gate.
  // The backend owns its single-flight promise and lifecycle status; scheduling
  // it here ensures a fresh Core with no semantic backfill work still starts
  // the same provider/cache path after the event loop yields.
  scheduleSemanticEmbeddingWarmup({
    log: (message) => logger.warn({ message }, "semantic embedding preparation did not complete"),
  }).catch(() => undefined);

  // Startup retrieval backfill. Existing data should become searchable after
  // restart without requiring re-ingest, but a large local corpus can take
  // minutes to rebuild. Capture the boot-time manifest set now, then schedule
  // the actual index work after AS/RS are already listening. New connector
  // registrations still backfill synchronously in registerConnector.
  const startupBackfillManifests = await collectRetrievalStartupBackfillManifests({
    logger,
    nativeManifest: nativeConfig?.nativeManifest || null,
  });

  const providerName: string =
    opts.providerName ||
    (nativeConfig?.nativeManifest?.display_name as string | undefined) ||
    (nativeConfig?.nativeManifest?.name as string | undefined) ||
    process.env.PDPP_PROVIDER_NAME ||
    PDPP_PROVIDER_NAME;

  const requestedAsPort = opts.asPort ?? AS_PORT;
  const requestedRsPort = opts.rsPort ?? RS_PORT;
  const ignoreAmbientPublicUrls =
    opts.ignoreAmbientPublicUrls ??
    ((requestedAsPort === 0 || requestedRsPort === 0) && !opts.asPublicUrl && !opts.rsPublicUrl && !opts.asIssuer);
  const referenceTopology = resolveReferenceTopology({
    ...(opts.referenceMode === null ? {} : { explicitMode: opts.referenceMode }),
    ...(opts.referenceOrigin === null ? {} : { referenceOrigin: opts.referenceOrigin }),
    ...(opts.asPublicUrl === null ? {} : { asPublicUrl: opts.asPublicUrl }),
    ...(opts.rsPublicUrl === null ? {} : { rsPublicUrl: opts.rsPublicUrl }),
    ignoreAmbient: ignoreAmbientPublicUrls,
  });
  const configuredAsPublicUrl = referenceTopology.asPublicUrl || null;
  const configuredAsIssuer =
    opts.asIssuer ||
    configuredAsPublicUrl ||
    (ignoreAmbientPublicUrls ? null : process.env.AS_ISSUER || process.env.AS_PUBLIC_URL) ||
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
    opts.rsInternalUrl ?? (ignoreAmbientPublicUrls ? null : process.env.PDPP_RS_URL?.trim() || null);
  const trustedMetadataHosts = opts.trustedMetadataHosts ?? process.env.PDPP_TRUSTED_HOSTS ?? null;
  const runtimeContext = {
    // Populated below after asServer.listen resolves the actual port,
    // so the controller's lazy currentReferenceBaseUrl() lookup picks up
    // the realized origin even when the operator did not configure
    // PDPP_REFERENCE_ORIGIN.
    referenceBaseUrl: configuredAsPublicUrl || null,
    rsUrl: configuredRsPublicUrl || null,
  };
  const resolvedOwnerAuthConfig = resolveOwnerAuthPlaceholderConfig(opts);
  const ownerAuthSubjectId = resolvedOwnerAuthConfig.subjectId || OWNER_AUTH_DEFAULT_SUBJECT_ID;

  // ── Owner-exposure posture (security audit S-1 / S-2, lane A1) ────────────
  // Decide whether this deployment is internet-facing. In a hosted posture an
  // unset PDPP_OWNER_PASSWORD is a full bypass of the owner control plane, so
  // we FAIL CLOSED: refuse to boot. In a local-dev (loopback) posture we keep
  // the password-optional convenience and the open `requireOwnerSession`
  // fall-through. The posture also gates `POST /connectors` (manifest upsert)
  // so a one-request grant-wipe DoS is not reachable unauthenticated on a
  // hosted surface. See server/owner-exposure-posture.ts for the signal logic.
  const ownerExposurePosture = resolveOwnerExposurePosture({
    bindHost: opts.bindHost,
    env: process.env,
    hasOwnerPassword:
      typeof resolvedOwnerAuthConfig.password === "string" && resolvedOwnerAuthConfig.password.length > 0,
    isTestContext: !!process.env.NODE_TEST_CONTEXT,
    publicUrlOption: configuredAsPublicUrl,
  });
  if (ownerExposurePosture.refuseBootReason) {
    // Throw BEFORE any listener binds. The CLI entrypoint's `.catch` exits(1)
    // with the fatal log line; the test harness sees a rejected promise.
    throw new Error(ownerExposurePosture.refuseBootReason);
  }
  if (
    !ownerExposurePosture.hosted &&
    ownerExposurePosture.bindsNonLoopback &&
    !(typeof resolvedOwnerAuthConfig.password === "string" && resolvedOwnerAuthConfig.password.length > 0)
  ) {
    // Local-dev posture that still binds a non-loopback interface without a
    // password — not refused (could be a deliberate LAN demo), but loud.
    logger.warn(
      { bindHost: opts.bindHost ?? "(all interfaces)" },
      "reference server is binding a non-loopback interface with PDPP_OWNER_PASSWORD unset — the owner control plane (/_ref, connector registry) is reachable without authentication. Set PDPP_OWNER_PASSWORD to gate it."
    );
  }

  const webPushConfig = opts.webPushConfig || resolveWebPushConfig();
  const webPushStore = opts.webPushSubscriptionStore || createWebPushSubscriptionStore();
  // Reference-internal run-target registry, lifted out of buildAsApp so the
  // controller can hand the same instance the per-run nonce hooks it needs
  // for Mode-A (in-process runtime) streaming registration. The buildAsApp
  // call below receives the same instance; routes are attached there as
  // before. See reference-implementation/server/streaming/run-target-registry.ts.
  const resolvedBrowserSurfaceControllerOptions = await resolveNekoBrowserSurfaceControllerOptions();
  const browserSurfaceControllerOptions = {
    ...resolvedBrowserSurfaceControllerOptions,
    ...(opts.browserSurfaceLeaseManager ? { browserSurfaceLeaseManager: opts.browserSurfaceLeaseManager } : {}),
    ...(opts.browserSurfaceReadinessProbe === undefined
      ? {}
      : { browserSurfaceReadinessProbe: opts.browserSurfaceReadinessProbe }),
  };
  const runTargetRegistry = createRunTargetRegistry({
    ...(opts.streamingLogger === null ? {} : { logger: opts.streamingLogger }),
    isNekoDescriptorApproved: (descriptor, context) =>
      isManagedNekoSurfaceApproved(descriptor, {
        browserSurfaceLeaseManager: (browserSurfaceControllerOptions as Record<string, unknown>)
          .browserSurfaceLeaseManager,
        interactionId: context?.interactionId,
        runId: context?.runId,
      }),
  });
  const presentationScreenStateStore = opts.presentationScreenStateStore || createPresentationScreenStateStore();
  // The controller exists before the HTTP app wires its terminal barrier.
  // This mutable, intentionally tiny seam keeps timeout handling testable
  // without making the runtime import the streaming route implementation.
  const presentationTerminalBarrier: {
    invoke: ((args: unknown) => Promise<void>) | null;
    releaseLease: ((args: unknown) => Promise<void>) | null;
  } = { invoke: null, releaseLease: null };
  const connectionScopedRunEnvResolver = opts.connectionScopedRunEnvResolver ?? buildConnectionScopedRunEnvResolver();
  const controller = createController({
    ...(configuredAsPublicUrl === null ? {} : { asPublicUrl: configuredAsPublicUrl }),
    ...(connectorEnvironmentPolicy.approvedBindings.length > 0
      ? { approvedEnvironmentBindings: connectorEnvironmentPolicy.approvedBindings }
      : {}),
    ...(connectorEnvironmentPolicy.approvedProxyConnectorIds.length > 0
      ? { approvedProxyConnectorIds: connectorEnvironmentPolicy.approvedProxyConnectorIds }
      : {}),
    admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId, runAdmission }) => {
      const namespace =
        runAdmission === "browser_enrollment"
          ? await admitOwnerBrowserEnrollmentRunConnection({
              connectorId,
              connectorInstanceId,
              connectorInstanceStore: createRequestConnectorInstanceStore(),
              ownerSubjectId,
            })
          : await admitOwnerRunConnection({
              allowDraft: runAdmission === "setup",
              connectorId,
              connectorInstanceId,
              connectorInstanceStore: createRequestConnectorInstanceStore(),
              ownerSubjectId,
            });
      return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId };
    },
    ownerSubjectId: ownerAuthSubjectId,
    resolveOwnerSubjectIdForConnectorInstance: async (connectorInstanceId) =>
      (await createRequestConnectorInstanceStore().get(connectorInstanceId))?.ownerSubjectId ?? null,
    ...(opts.connectorPathResolver === null
      ? {}
      : {
          connectorPathResolver: opts.connectorPathResolver as import("../runtime/controller.ts").ConnectorPathResolver,
        }),
    ...(browserSurfaceControllerOptions as Record<string, unknown>),
    beforeInteractionTerminal: async (args) => {
      if (typeof presentationTerminalBarrier.invoke === "function") {
        await presentationTerminalBarrier.invoke(args);
      }
    },
    beforeRunCleanup: async (args) => {
      if (typeof presentationTerminalBarrier.releaseLease === "function") {
        await presentationTerminalBarrier.releaseLease(args);
      }
    },
    markStaticSecretCredentialRejected:
      buildControllerStaticSecretCredentialRejectionMarker() as import("../runtime/controller.ts").MarkStaticSecretCredentialRejected,
    resolveStaticSecretRunEnv:
      connectionScopedRunEnvResolver as import("../runtime/controller.ts").StaticSecretRunEnvResolver,
    runtimeContext,
    streamingTargetNonceHooks: {
      clearNonce: (args) => runTargetRegistry.clearNonce(args),
      registerNonce: (args) => runTargetRegistry.registerNonce(args),
    },
  });
  await controller.reconcileBrowserSurfaceLeasesAfterBoot();
  await reconcileUnrestoredPresentationScreens({
    browserSurfaceAllocator: (browserSurfaceControllerOptions as Record<string, unknown>)
      .browserSurfaceAllocator as Record<string, unknown> | null,
    browserSurfaceLeaseManager: (browserSurfaceControllerOptions as Record<string, unknown>)
      .browserSurfaceLeaseManager as Record<string, unknown> | null,
    browserSurfaceLeaseStore: (browserSurfaceControllerOptions as Record<string, unknown>)
      .browserSurfaceLeaseStore as Record<string, unknown> | null,
    logger,
    presentationScreenStateStore: presentationScreenStateStore as unknown as {
      listUnrestored?: () => Promise<Record<string, unknown>[]>;
      markRecycled?: (id: string, ts: string) => Promise<void>;
    },
  });
  // Constructed here (unstarted) because sweepBrowserSurfaceLeases closes
  // over `controller`, which exists at this point. NOT started here — see
  // armBrowserSurfaceLeaseSweepAfterBoot below for why start() is deferred
  // to the very end of this function.
  const browserSurfaceLeaseSweepTimer = createBrowserSurfaceLeaseSweepTimerFor(
    controller,
    browserSurfaceControllerOptions,
    logger
  );
  function stopBrowserSurfaceLeaseSweep() {
    browserSurfaceLeaseSweepTimer.stop();
  }
  // Terminal-gate revision (2026-07-29): reuses the SAME generic timer
  // chassis the browser-surface lease sweep uses above — not a new engine,
  // one more `sweep: () => Promise<void>` on its own interval. Constructed
  // (unstarted) here for the same reason: its `sweep` closure does not
  // depend on any later fallible await, but starting it is still deferred
  // to armConnectorMaintenanceSweepAfterBoot at the very end of this
  // function so a boot failure anywhere before that point can never leave
  // an orphaned running timer (identical reasoning to the browser-surface
  // lease sweep's own comment on this).
  const runHistoryBackfillStage = createResumableRunHistoryBackfillStage();
  const connectorMaintenanceSweep = createResumableConnectorMaintenanceSweep({
    evidenceSweepMaxDurationMs: CONNECTOR_MAINTENANCE_EVIDENCE_SWEEP_MAX_DURATION_MS,
    evidenceSweepPageSize: CONNECTOR_MAINTENANCE_EVIDENCE_SWEEP_PAGE_SIZE,
    onNoProgressAlert: ({ consecutiveNoProgressPasses, eligibleBacklog }) => {
      logger.warn?.(
        { consecutiveNoProgressPasses, eligibleBacklog },
        "connector-maintenance sweep: dirty backlog is not shrinking across consecutive rounds"
      );
    },
    onPhaseError: (phase, err) => {
      logger.warn?.(
        { err: err instanceof Error ? err.message : String(err), phase },
        "connector-maintenance sweep phase failed"
      );
    },
    runEvidenceSweep: (args) =>
      runBoundedSummaryEvidenceSweep({
        ...(args.afterId === undefined ? {} : { afterId: args.afterId }),
        ...(args.firstTranche === undefined ? {} : { firstTranche: args.firstTranche }),
        maxDurationMs: args.maxDurationMs,
        ...(args.lease ? { maintenanceLease: args.lease } : {}),
        pageSize: args.pageSize ?? CONNECTOR_MAINTENANCE_EVIDENCE_SWEEP_PAGE_SIZE,
      }),
    runHistoryBackfillStage,
  });
  const connectorMaintenanceSweepTimer = createBrowserSurfaceLeaseSweepTimer({
    intervalMs: CONNECTOR_MAINTENANCE_SWEEP_INTERVAL_MS,
    onSweepError: (err: unknown) => {
      logger.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        "connector-maintenance sweep tick failed"
      );
    },
    sweep: () => connectorMaintenanceSweep.run(),
  });
  function stopConnectorMaintenanceSweep() {
    connectorMaintenanceSweepTimer.stop();
  }
  let schedulerManager: {
    cancelRun: (runId: string) => { status: string; run_id: string };
    refresh: () => Promise<void>;
    start: () => Promise<void>;
    stop: () => void;
  } | null = null;

  // Client event subscriptions: install the post-commit hook from
  // records.js and start the delivery worker. The hook synchronously
  // enqueues envelopes after a record_changes row has committed; the
  // worker handles signing, HTTP delivery, and retry.
  const clientEventEnqueueTasks = new Set<Promise<void>>();
  async function enqueueClientEvents(change: {
    connectorId: string;
    connectorInstanceId: string;
    connectionId?: string | null;
    data: Record<string, unknown> | null;
    stream: string;
    version: number | null;
    emittedAt: string;
    recordKey: string;
  }): Promise<void> {
    try {
      const subs = await listActiveSubscriptions();
      if (subs.length === 0) {
        return;
      }
      const store = getDefaultClientEventSubscriptionStore();
      const activeSubs = subs.filter((row) => row.status === "active");
      const changedInstanceOwner = activeSubs.some((row) => row.authority_kind === "trusted_owner_agent")
        ? ((await createRequestConnectorInstanceStore().get(change.connectorInstanceId))?.ownerSubjectId ?? null)
        : null;
      const events = deriveClientEventsFromRecordChange(
        {
          connectionId: change.connectionId ?? null,
          connectorId: change.connectorId,
          connectorInstanceId: change.connectorInstanceId,
          data: change.data,
          emittedAt: change.emittedAt,
          ownerSubjectId: changedInstanceOwner,
          recordKey: change.recordKey,
          stream: change.stream,
          version: Number(change.version) || 0,
        },
        activeSubs.map((row) => ({
          authorityKind: row.authority_kind,
          clientId: row.client_id,
          grantId: row.grant_id,
          scope: JSON.parse(row.scope_json),
          status: "active",
          subjectId: row.subject_id,
          subscriptionId: row.subscription_id,
        }))
      );
      const now = new Date().toISOString();
      for (const ev of events) {
        const eventId = `evt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
        await store.enqueueEvent({
          enqueuedAt: now,
          eventId,
          eventType: ev.type,
          nextAttemptAt: now,
          payloadJson: buildEventPayload(eventId, ev),
          subscriptionId: ev.subscriptionId,
        });
      }
      if (events.length > 0) {
        getDefaultDeliveryWorker()
          .tick()
          .catch(() => {
            /* surfaced via attempt log */
          });
      }
    } catch (hookErr) {
      logger.warn?.(
        { err: hookErr instanceof Error ? hookErr.message : String(hookErr) },
        "client-event-subscriptions: enqueue hook failed"
      );
    }
  }
  setClientEventEnqueueHook(
    (change: {
      connectorId: string;
      connectorInstanceId: string;
      connectionId?: string | null;
      data: Record<string, unknown> | null;
      stream: string;
      version: number | null;
      emittedAt: string;
      recordKey: string;
    }) => {
      const task = enqueueClientEvents(change);
      clientEventEnqueueTasks.add(task);
      // biome-ignore lint/complexity/noVoid: The side effect is intentionally fire-and-forget by this runtime contract.
      void task.finally(() => clientEventEnqueueTasks.delete(task));
      return task;
    }
  );
  // Resolve the reference-only static-secret credential prober once at startup
  // (it lazily imports the connector package's probe + live transport). Tests
  // may inject their own via `opts.staticSecretCredentialProber`.
  const staticSecretCredentialProber = opts.staticSecretCredentialProber ?? (await buildStaticSecretCredentialProber());
  // See the sibling AS-app construction above: every provider-authorization
  // connector today declares its own manifest deployment_config, so this
  // allowlist is only the fallback for a manifest declaring none.
  const configuredProviderAuthConnectorKeys = opts.configuredProviderAuthConnectorKeys ?? [];
  const providerAuthExchanger =
    opts.providerAuthExchanger ?? buildGenericProviderAuthExchanger(createRequestConnectorInstanceCredentialStore);

  const asApp = buildAsApp({
    acceptedCollectorProtocolVersions: opts.acceptedCollectorProtocolVersions,
    acceptedProviderNativeRevision: opts.acceptedProviderNativeRevision,
    agentConnectTtlMs: opts.agentConnectTtlMs,
    asIssuer: configuredAsIssuer,
    asPublicUrl: configuredAsPublicUrl,
    cimdFetchDependencies: opts.cimdFetchDependencies,
    controller,
    dbPath: opts.dbPath || DB_PATH,
    dynamicClientRegistrationInitialAccessTokens: resolveDynamicClientRegistrationInitialAccessTokens(opts),
    enableDynamicClientRegistration: resolveDynamicClientRegistrationEnabled(opts),
    ignoreAmbientPublicUrls,
    introspectionCallerCredentials: introspectionCredentials,
    isNekoProxyTargetApproved: opts.isNekoProxyTargetApproved,
    makePresentationAttachmentId: opts.makePresentationAttachmentId,
    makeStreamingBrowserSessionId: opts.makeStreamingBrowserSessionId,
    maxRecordRejectionPageSize: opts.maxRecordRejectionPageSize,
    nativeManifest: nativeConfig?.nativeManifest || null,
    nekoProxyAllowedHosts: opts.nekoProxyAllowedHosts,
    nekoProxyAutoLogin: opts.nekoProxyAutoLogin,
    nekoWindowSettleProbe: opts.nekoWindowSettleProbe,
    ownerAuthForceSecureCookies: opts.ownerAuthForceSecureCookies,
    ownerAuthPassword: opts.ownerAuthPassword,
    ownerAuthSameSite: opts.ownerAuthSameSite,
    ownerAuthSubjectId: opts.ownerAuthSubjectId,
    // Owner-exposure posture: gates the disabled-auth fall-through and the
    // connector-registry lock (security audit S-1 / S-2, lane A1).
    ownerExposurePosture,
    preRegisteredPublicClients: resolvePreRegisteredPublicClients(opts),
    presentationScreenStateStore,
    presentationTerminalBarrier,
    providerName,
    publicDynamicClientRegistrationRateLimit: opts.publicDynamicClientRegistrationRateLimit,
    referenceRevision: opts.referenceRevision,
    resolveIntrospectionAudience: () => configuredRsPublicUrl || runtimeContext.rsUrl,
    resolveIntrospectionIssuer: () => configuredAsIssuer || runtimeContext.referenceBaseUrl,
    staticSecretCredentialProber,
    streamingClearTimeout: opts.streamingClearTimeout,
    streamingCompanionFactory: opts.streamingCompanionFactory,
    streamingLogger: opts.streamingLogger,
    streamingNow: opts.streamingNow,
    streamingSessionStore: opts.streamingSessionStore,
    streamingSessionTtlMs: opts.streamingSessionTtlMs,
    streamingSetTimeout: opts.streamingSetTimeout,
    trustedMetadataHosts,
    webPushConfig,
    webPushSubscriptionStore: webPushStore,
    ...(browserSurfaceControllerOptions as Record<string, unknown>),
    cancelScheduledRun: (runId: string) => schedulerManager?.cancelRun?.(runId) ?? null,
    configuredProviderAuthConnectorKeys,
    logger,
    onScheduleMutation: () => schedulerManager?.refresh(),
    providerAuthExchanger,
    runTargetRegistry,
    staticSecretAutoResume: opts.staticSecretAutoResume,
  } as unknown as ServerOpts);

  // opts.bindHost — restrict listening interface (e.g. '127.0.0.1'). Default
  // is undefined which lets Node bind to all interfaces. Passing '127.0.0.1'
  // keeps the server off the LAN/public internet.
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const bindHost = opts.bindHost;

  const asServer = await asApp.listen(requestedAsPort, bindHost);
  if (typeof (asApp as unknown as Record<string, unknown>).__pdppStreamingUpgradeHandler === "function") {
    asServer.on("upgrade", (req, socket, head) => {
      const handled = (
        (asApp as unknown as Record<string, unknown>).__pdppStreamingUpgradeHandler as (...args: unknown[]) => unknown
      )(req, socket, head);
      if (!(handled || socket.destroyed)) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
      }
    });
  }
  const asPort = (asServer.address() as import("net").AddressInfo).port;
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
  logger.info({ port: asPort, url: `http://localhost:${asPort}` }, "authorization server listening");

  const rsApp = buildRsApp({
    agentDiscoveryOrigin: referenceTopology.browserOrigin,
    asIssuer: configuredAsIssuer || asPublicUrl,
    asPort,
    asPublicUrl,
    configuredProviderAuthConnectorKeys,
    controller,
    hostedRecordRejectionAfterInsertBeforeCommit: opts.hostedRecordRejectionAfterInsertBeforeCommit,
    hybridRetrievalCapability: opts.hybridRetrievalCapability,
    // Hybrid retrieval experimental extension knobs — see search-hybrid.js +
    // the metadata route. Forwarded verbatim so test harnesses and operator
    // configs reach both the route registration gate and the advertisement
    // builder.
    hybridRetrievalSupported: opts.hybridRetrievalSupported,
    ignoreAmbientPublicUrls,
    introspectionFetch: opts.introspectionFetch,
    lexicalRetrievalCapability: opts.lexicalRetrievalCapability,
    // Lexical retrieval extension knobs — see search.js + the metadata route.
    lexicalRetrievalSupported: opts.lexicalRetrievalSupported,
    logger,
    nativeManifest: nativeConfig?.nativeManifest || null,
    // Scheduler refresh hook for the owner-agent schedule pause/resume routes,
    // the same callback `buildAsApp` receives for the cookie-authed `/_ref`
    // schedule routes. `schedulerManager` is assigned later in startServer; the
    // closure reads it lazily at mutation time. See
    // openspec/changes/add-owner-agent-control-surface (tasks 6.1-6.3).
    onScheduleMutation: () => schedulerManager?.refresh(),
    providerName,
    referenceRevision: opts.referenceRevision,
    resolveIntrospectionAudience: () => configuredRsPublicUrl || runtimeContext.rsUrl,
    resolveIntrospectionIssuer: () => configuredAsIssuer || runtimeContext.referenceBaseUrl,
    // Explicitly-configured internal RS base for the hosted-MCP adapter's
    // child-grant self-calls (null when only the bare default would apply, so
    // the adapter falls back to the public resource). See explicitRsInternalUrl.
    // Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
    rsInternalUrl: explicitRsInternalUrl,
    rsIntrospectionCredentials: introspectionCredentials,
    rsIntrospectionEndpoint: opts.rsIntrospectionEndpoint ?? `http://127.0.0.1:${asPort}/introspect`,
    rsPublicUrl: configuredRsPublicUrl,
    semanticRetrievalCapability: opts.semanticRetrievalCapability,
    // Semantic retrieval experimental extension knobs — see search-semantic.js
    // + the metadata route. Forwarded verbatim so test harnesses and operator
    // configs reach both the route registration gate and the advertisement
    // builder.
    semanticRetrievalSupported: opts.semanticRetrievalSupported,
    sourceDeclarationUri: opts.sourceDeclarationUri,
    trustedMetadataHosts,
  } as unknown as ServerOpts);
  const rsServer = await rsApp.listen(requestedRsPort, bindHost);
  const rsPort = (rsServer.address() as import("net").AddressInfo).port;
  // Controller-managed runs are server-side work. Even in composed mode, they
  // should post ingest/state traffic directly to the local RS listener rather
  // than routing large NDJSON payloads through the browser-facing web origin.
  runtimeContext.rsUrl = `http://localhost:${rsPort}`;
  await controller.promoteBrowserSurfaceLeasesAfterBoot();
  logger.info({ port: rsPort, url: `http://localhost:${rsPort}` }, "resource server listening");

  // Auto-enroll proven, env-wired connectors before the scheduler manager
  // hydrates. Idempotent: never overrides an existing schedule row, never
  // inspects secret env values, only checks presence and non-emptiness.
  // See openspec/changes/auto-enroll-eligible-connector-schedules/.
  if (!nativeConfig?.nativeManifest) {
    const autoEnrollOptOut = process.env.PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT === "1";
    const autoEnrollEnabled =
      opts.autoEnrollEligibleSchedules === undefined ? !autoEnrollOptOut : !!opts.autoEnrollEligibleSchedules;
    const recordAutoEnrollDecision = async (connectorId: string, reason: string | null): Promise<void> => {
      const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
      const instanceStore = createRequestConnectorInstanceStore();
      const instances = (await instanceStore.listByOwnerIncludingDrafts(ownerAuthSubjectId)).filter(
        (instance) => (canonicalConnectorKey(instance.connectorId) ?? instance.connectorId) === canonicalId
      );
      for (const instance of instances) {
        // The reason is merged atomically with the existing source binding,
        // following the same write-time evidence pattern as revocation_reason.
        // It is deliberately non-secret and connector-neutral.
        await Promise.resolve(
          instanceStore.updateStatus(instance.connectorInstanceId, {
            revokedAt: instance.revokedAt ?? null,
            sourceBindingPatch: { auto_enroll_skip_reason: reason },
            status: instance.status,
            updatedAt: new Date().toISOString(),
          })
        );
      }
    };
    const enrollmentSummary = await autoEnrollEligibleSchedules({
      controller,
      enabled: autoEnrollEnabled,
      // Store-aware eligibility: a static-secret connector whose credential
      // lives ONLY in the encrypted per-connection store (env vars absent or
      // empty) still auto-enrolls. Presence-only probe — no secret bytes are
      // recovered here.
      hasStoredCredential: async (connectorId: string) => {
        const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
        const { isStaticSecretConnector } = (await loadStaticSecretInjectionHelpers()) as {
          isStaticSecretConnector: (id: string) => boolean;
        };
        if (!isStaticSecretConnector(canonicalId)) {
          return false;
        }
        const instances = await createRequestConnectorInstanceStore().listActiveByConnector(
          ownerAuthSubjectId,
          canonicalId
        );
        const credentialStore = createRequestConnectorInstanceCredentialStore();
        for (const instance of instances) {
          // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
          if (await credentialStore.hasActiveCredential(instance.connectorInstanceId)) {
            return true;
          }
        }
        return false;
      },
      // Key each schedule row to the connection it refreshes. Without this the
      // controller falls back to the bare connector id, producing a row that
      // matches no `connector_instances` row: the scheduler dispatches it,
      // admission raises `connector_instance_not_found`, and the connection
      // never refreshes while later boots count the orphan `skipped_existing`.
      listActiveConnectorInstanceIds: async (connectorId: string) => {
        const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
        const instances = await createRequestConnectorInstanceStore().listActiveByConnector(
          ownerAuthSubjectId,
          canonicalId
        );
        return instances.map((instance) => instance.connectorInstanceId);
      },
      listConnectors: async () => {
        const manifests = await collectValidRegisteredConnectorManifests({ logger });
        return manifests.map(({ connectorId, manifest }) => ({ connector_id: connectorId, manifest }));
      },
      log: (msg) => logger.info(msg),
      recordSkipReason: recordAutoEnrollDecision,
    });
    if (enrollmentSummary.scanned > 0) {
      logger.info(enrollmentSummary, "auto-enroll eligible schedules summary");
    }
  }

  schedulerManager = createReferenceSchedulerManager({
    connectionScopedRunEnvResolver,
    connectorEnvironmentPolicy,
    connectorPathResolver: opts.connectorPathResolver || resolveDefaultConnectorPath,
    controller,
    logger,
    ownerSubjectId: ownerAuthSubjectId,
    runtimeContext,
    webPushConfig,
    webPushSubscriptionStore: webPushStore,
  });
  await schedulerManager.start();
  const startupBackfillAbortController = new AbortController();
  const startupBackfillDone = scheduleRetrievalStartupBackfill({
    logger,
    manifests: startupBackfillManifests,
    signal: startupBackfillAbortController.signal,
  });
  // Bounded, multi-round startup observation: best-effort acceleration,
  // never the correctness authority (design.md "Startup is acceleration,
  // not authority"). Off the request path, after listen, runs the SAME
  // discovery+fold+repair+prune barrier, one small
  // page (STARTUP_SUMMARY_EVIDENCE_PAGE_SIZE connections) at a time via
  // `runBoundedSummaryEvidenceSweep`, resuming from its returned cursor
  // across up to STARTUP_SUMMARY_EVIDENCE_MAX_RESUME_ROUNDS rounds until the
  // complete canonical set is covered or the round cap is reached, so a
  // never-before-seen or pre-change connection's evidence is fully current
  // before the first owner-console read rather than paying that cost inline.
  // A failure here marks rows stale (visible) and a later maintenance pass
  // repairs them.
  //
  // `maxDurationMs` genuinely bounds TOTAL wall-clock work across discovery,
  // fold, AND repair for every page (checked BEFORE each page starts, never
  // mid-page) — not just a repair-loop count/time cap (Sol P2.2: a small
  // candidate count does not bound total time when a full unscoped
  // discovery/fold can itself exceed budget before repair even begins).
  // The fold phase WITHIN one page is itself genuinely bounded too (Sol
  // fourth-verdict P1.2: connection-page resumability alone did not bound
  // one connection's own fold work — a single connection with thousands of
  // terminal events still drained them all inside one page regardless of
  // the page's deadline). `runBoundedSummaryEvidenceSweep` now threads each
  // page's remaining time budget into its own fold call, which itself
  // stops mid-drain and writes a genuine partial-progress checkpoint when
  // that budget is spent — `resumeAfterId` then points BEFORE the
  // still-incomplete page so the next round in this walk resumes exactly
  // that page's unfinished fold, not merely the next connection page.
  //
  // An `incomplete: true` result's `resumeAfterId` genuinely schedules a
  // follow-up round from that cursor (Sol P2.1: "the cursor is exposed but
  // startup never actually reschedules using it") — each round bounded by
  // the same per-round deadline, capped at
  // STARTUP_SUMMARY_EVIDENCE_MAX_RESUME_ROUNDS total rounds so an
  // unusually large connection set (or one connection with an unusually
  // large terminal history) cannot serialize startup acceleration
  // indefinitely. Correction (2026-08-12): this comment previously claimed
  // "the per-request observation barrier remains the actual correctness
  // backstop" — that barrier was removed from ordinary GET by the
  // 2026-07-29 terminal-gate revision (see `ref-control.ts`'s
  // `loadConnectorSummaryProjectionDeps`). The actual backstop for a
  // connection this multi-round startup pass still does not reach is the
  // recurring periodic sweep (`CONNECTOR_MAINTENANCE_SWEEP_INTERVAL_MS`
  // below), never a per-request repair — design.md "Startup is
  // acceleration, not authority" still holds, just with the periodic sweep
  // as the authority instead of the request path.
  const startupSummaryEvidenceSweepDone = new Promise<void>((resolve) => {
    setImmediate(() => {
      // biome-ignore lint/complexity/noVoid: The side effect is intentionally fire-and-forget by this runtime contract.
      void runStartupSummaryEvidenceSweepToCompletion({
        maxDurationMs: STARTUP_SUMMARY_EVIDENCE_MAX_DURATION_MS,
        maxRounds: STARTUP_SUMMARY_EVIDENCE_MAX_RESUME_ROUNDS,
        onRound: (summary: SweepSummary, round: number) => {
          if (
            ((summary as unknown as Record<string, unknown>).repaired as number) > 0 ||
            ((summary as unknown as Record<string, unknown>).skipped as number) > 0 ||
            summary.incomplete
          ) {
            logger.info({ ...summary, round }, "startup summary-evidence observation");
          }
        },
        pageSize: STARTUP_SUMMARY_EVIDENCE_PAGE_SIZE,
        runSweep: (args) =>
          connectorMaintenanceSweep.runEvidenceSweepRound({
            ...(args.afterId === undefined ? {} : { afterId: args.afterId }),
            maxDurationMs: args.maxDurationMs ?? STARTUP_SUMMARY_EVIDENCE_MAX_DURATION_MS,
            pageSize: args.pageSize ?? STARTUP_SUMMARY_EVIDENCE_PAGE_SIZE,
          }) as Promise<SweepSummary | null>,
      })
        .then((rounds) => {
          const last = rounds.at(-1);
          if (last?.incomplete && last.resumeAfterId) {
            logger.info(
              { resumeAfterId: last.resumeAfterId, rounds: rounds.length },
              "startup summary-evidence observation stopped after the resume-round cap; the periodic maintenance sweep covers the remainder"
            );
          }
        })
        .catch((err) => {
          logger.warn({ err }, "startup summary-evidence observation failed; the next read will retry");
        })
        .finally(resolve);
    });
  });
  // Run-history backfill startup accelerator (terminal-read-architecture-
  // fable-0730.md §9): same fire-and-forget shape as the evidence sweep
  // above — NOT a traffic gate (R9.1 struck the blocking-startup-loop
  // proposal). A connection this walk does not finish reaching converges
  // on the next periodic tick; LIST renders `not yet observed
  // (backfilling)` for any run not yet in run_history in the meantime,
  // never a spine fallback.
  const startupRunHistoryBackfillDone = new Promise<void>((resolve) => {
    setImmediate(() => {
      // biome-ignore lint/complexity/noVoid: The side effect is intentionally fire-and-forget by this runtime contract.
      void runStartupRunHistoryBackfillToCompletion({
        batchSize: STARTUP_RUN_HISTORY_BACKFILL_BATCH_SIZE,
        maxDurationMs: STARTUP_RUN_HISTORY_BACKFILL_MAX_DURATION_MS,
        maxRounds: STARTUP_RUN_HISTORY_BACKFILL_MAX_ROUNDS,
        onRound: (result, round) => {
          if (result.backfilled > 0 || result.incomplete) {
            logger.info({ ...result, round }, "startup run-history backfill observation");
          }
        },
        stage: runHistoryBackfillStage,
      })
        .then((rounds) => {
          const last = rounds.at(-1);
          if (last?.incomplete) {
            logger.info(
              { resumeAfterSeq: last.resumeAfterSeq, rounds: rounds.length },
              "startup run-history backfill stopped after the resume-round cap; the periodic sweep covers the remainder"
            );
          }
        })
        .catch((err) => {
          logger.warn({ err }, "startup run-history backfill failed; the periodic sweep will retry");
        })
        .finally(resolve);
    });
  });
  if (opts.awaitStartupBackfill === true) {
    await startupBackfillDone;
  }
  // Arm (bind + start) the browser-surface lease sweep timer LAST, only once
  // every fallible await above has succeeded. See
  // armBrowserSurfaceLeaseSweepAfterBoot / createBrowserSurfaceLeaseSweepTimerFor
  // for why: a boot failure anywhere before this line rejects startServer's
  // promise before the timer is ever started, so there is no window where a
  // caller that never received a server object could be left with an
  // unreachable running timer.
  armBrowserSurfaceLeaseSweepAfterBoot(
    browserSurfaceLeaseSweepTimer,
    browserSurfaceControllerOptions,
    asServer,
    rsServer
  );
  // Same deferred-arming discipline as the browser-surface lease sweep
  // above, for the same reason: bind stop-on-close before start() so there
  // is no window where the timer runs with no owner able to stop it, and
  // defer both to the very end of boot so an earlier failure never leaves
  // an orphaned running timer. Unlike the browser-surface sweep, this one
  // has no "not configured" gate — connector-summary maintenance applies to
  // every deployment.
  connectorMaintenanceSweepTimer.stopWhenAllClosed([asServer, rsServer]);
  connectorMaintenanceSweepTimer.start();
  const deliveryWorkerLeases =
    opts.startClientEventDeliveryWorker === false
      ? []
      : [acquireDefaultDeliveryWorker(), acquireDefaultDeliveryWorker()];
  const stopClientEventDeliveryWorker = async (): Promise<void> => {
    await Promise.allSettled(clientEventEnqueueTasks);
    await Promise.all(deliveryWorkerLeases.map(({ release }) => release()));
  };
  function releaseDeliveryWorkerLease(index: number): void {
    const lease = deliveryWorkerLeases[index];
    if (lease) {
      // biome-ignore lint/complexity/noVoid: The side effect is intentionally fire-and-forget by this runtime contract.
      void lease.release();
    }
  }
  asServer.once("close", () => {
    releaseDeliveryWorkerLease(0);
  });
  rsServer.once("close", () => {
    releaseDeliveryWorkerLease(1);
  });
  return {
    abortStartupBackfill: (reason: unknown) => startupBackfillAbortController.abort(reason),
    asPort,
    asServer,
    // Exposed for the CLI entrypoint and for callers that need to await
    // in-flight `runConnector` promises (`drainActiveRuns`, the watchdog,
    // `awaitRun`).
    //
    // The shutdown path deliberately does NOT drain — a drain cannot finish
    // minutes-long connector work inside Docker's 10s grace, and was measured
    // burning its whole budget without saving a run. Interrupted runs are
    // adjudicated by the successor at boot instead. See the SIGTERM handler
    // in this file and `lib/controller-boot.ts`.
    controller,
    logger,
    rsPort,
    rsServer,
    schedulerManager,
    startupBackfillDone,
    startupRunHistoryBackfillDone,
    startupSummaryEvidenceSweepDone,
    // Exposed so the CLI shutdown path (and tests that start/stop many
    // server instances per process) can clear the periodic browser-surface
    // sweep timer. A no-op when no dynamic allocator was configured.
    stopBrowserSurfaceLeaseSweep,
    stopClientEventDeliveryWorker,
    // Exposed so the CLI shutdown path (and tests that start/stop many
    // server instances per process) can clear the periodic connector-
    // maintenance sweep timer (shell retirement, attention expiry, bounded
    // evidence-sweep round — see connector-maintenance-sweep.ts).
    stopConnectorMaintenanceSweep,
  };
}

// Deterministically re-derive credential-boundary retention on rehydrated
// surfaces at boot, BEFORE the lease manager can run any idle-cleanup or
// capacity-reclaim. `retained` is not a persisted column; it is a pure function
// of the surface's connector via the RI retention registry. Fail-closed: a
// surface whose connector is not registered stays non-retained.
function rederiveRetainedSurfaces(surfaces: Record<string, unknown>[]) {
  return surfaces.map((surface: Record<string, unknown>) =>
    connectorRetainsSurfaceProcess(surface.connector_id as string) ? { ...surface, retained: true } : surface
  );
}

// Same re-derivation, for rehydrated NON-TERMINAL LEASES. A queued
// (waiting_for_browser_surface) or starting_surface ChatGPT lease that has not
// yet materialized a surface carries no surface row for
// rederiveRetainedSurfaces to mark — without this, that lease rehydrates as an
// ordinary (non-retained) lease, and once it does materialize a surface (via
// #resolveNewLease / queue promotion) that surface would be created without
// the retained flag, making it evictable by routine idle-TTL or
// capacity-pressure reap. `retained` is not a persisted lease column either;
// it is re-derived the same way, by connector_id, fail-closed for an
// unregistered connector.
function rederiveRetainedLeases(leases: Record<string, unknown>[]) {
  return leases.map((lease: Record<string, unknown>) =>
    connectorRetainsSurfaceProcess(lease.connector_id as string) ? { ...lease, retained: true } : lease
  );
}

// Independent periodic sweep for the managed browser-surface lease
// lifecycle: expires past-TTL waiting leases, reconciles surfaces against the
// Constructs (but never starts) the periodic browser-surface lease sweep
// timer. Expires past-TTL waiting leases, reconciles surfaces against the
// live allocator, and retries capacity-pressure reclaim for anything left
// queued — on its own wall clock, not only as a side effect of some other
// run's next acquire. See openspec/changes/fix-browser-surface-capacity-self-heal.
// The timer's own start/stop/unref/no-double-start/stopWhenAllClosed seam
// lives in createBrowserSurfaceLeaseSweepTimer
// (runtime/browser-surface-lease-sweep-timer.ts) so it is directly
// unit-testable with fake timers, independent of this HTTP boot.
//
// Deliberately does NOT call timer.start() here. startServer's boot has
// many later fallible awaits (buildRsApp, rsApp.listen, schedulerManager.start,
// auto-enroll, ...) between where the controller/allocator become known and
// where startServer actually returns a server object. Starting the timer
// this early would let a later boot failure leave a running, unref'd timer
// with no reference anywhere the caller (who never received a server object)
// could use to stop it — a structural leak, not merely a missed cleanup
// call. armBrowserSurfaceLeaseSweepAfterBoot (below) is the ONLY place this
// module ever calls timer.start(), and it is the last thing startServer does
// before its return, specifically so a boot failure anywhere before that
// point can never leave a started-but-unowned timer.
export function createBrowserSurfaceLeaseSweepTimerFor(
  controller: Pick<Controller, "sweepBrowserSurfaceLeases">,
  browserSurfaceControllerOptions: Record<string, unknown>,
  logger: Pick<LoggerLike, "warn">
): BrowserSurfaceLeaseSweepTimer {
  return createBrowserSurfaceLeaseSweepTimer({
    intervalMs:
      (browserSurfaceControllerOptions.browserSurfaceLeaseSweepIntervalMs as number | undefined) ??
      DEFAULT_NEKO_LEASE_SWEEP_INTERVAL_MS,
    onSweepError: (err: unknown) => {
      logger.warn?.({ err: err instanceof Error ? err.message : String(err) }, "browser-surface periodic sweep failed");
    },
    sweep: () => controller.sweepBrowserSurfaceLeases(),
  });
}

// The ONLY call site of timer.start() for the browser-surface lease sweep.
// Binds stopWhenAllClosed BEFORE start() so there is no window where the
// timer is running without an owner: if start() were called first and the
// process were killed between the two calls, nothing would change (start()
// is synchronous and non-fallible), but bind-before-start is also the
// smaller, more obviously correct ordering to reason about and matches the
// documented contract ("bound before running"). No-ops (never starts) when
// no dynamic-mode allocator is configured, matching every other
// browser-surface manager method's guard.
export function armBrowserSurfaceLeaseSweepAfterBoot(
  timer: Pick<BrowserSurfaceLeaseSweepTimer, "start" | "stopWhenAllClosed">,
  browserSurfaceControllerOptions: Record<string, unknown>,
  asServer: BrowserSurfaceLeaseSweepCloseSource,
  rsServer: BrowserSurfaceLeaseSweepCloseSource
): void {
  if (!browserSurfaceControllerOptions.browserSurfaceAllocator) {
    return;
  }
  timer.stopWhenAllClosed([asServer, rsServer]);
  timer.start();
}

export async function resolveNekoBrowserSurfaceControllerOptions({
  env = process.env,
  getBrowserSurfaceLeaseStore = getDefaultBrowserSurfaceLeaseStore,
  createBrowserSurfaceAllocator = (options: { baseUrl: string }) => new NekoSurfaceAllocatorClient(options),
} = {}) {
  const runtimeConfig = parseNekoBrowserSurfaceRuntimeConfig(env);
  const browserSurfaceLeaseStore =
    runtimeConfig.leaseConfig.managedConnectors.size > 0 ? getBrowserSurfaceLeaseStore() : null;
  if (!browserSurfaceLeaseStore) {
    return {} as Record<string, unknown>;
  }

  await browserSurfaceLeaseStore.repairStaleSurfaceActiveLeases();
  // The per-connection fair-slot invariant is enforced in the lease manager at
  // retained-surface CREATION time (typed retained_capacity_reserved), NOT by
  // counting these rehydrated surfaces — observed surfaces are not demand.
  const rehydratedSurfaces = rederiveRetainedSurfaces(
    (await browserSurfaceLeaseStore.listSurfaces()) as unknown as Record<string, unknown>[]
  );
  // Re-derive retention on rehydrated NON-TERMINAL LEASES too, not only
  // surfaces: a queued/starting ChatGPT lease with no surface row yet would
  // otherwise rehydrate non-retained and later materialize an evictable
  // surface. Both re-derivations must run before the manager is constructed,
  // so no idle-cleanup or capacity-reclaim can ever see a retaining
  // lease/surface without the flag.
  const rehydratedLeases = rederiveRetainedLeases(
    (await browserSurfaceLeaseStore.listNonTerminalLeases()) as unknown as Record<string, unknown>[]
  );
  // Optional: null when @opendatalabs/remote-surface is not installed, which
  // disables the browser-surface / streaming path rather than crashing boot.
  const browserSurfaceLeaseManager = await (
    createOptionalBrowserSurfaceLeaseManager as (...args: unknown[]) => Promise<unknown>
  )({
    config: runtimeConfig.leaseConfig,
    initialLeases: rehydratedLeases,
    initialSurfaces: rehydratedSurfaces,
  });
  const options: Record<string, unknown> = {
    browserSurfaceLeaseManager,
    browserSurfaceLeaseStore,
    // Preflight readiness gate: proves the managed n.eko / CDP surface is
    // actually live before the connector child is spawned. Prevents the
    // "ask the human for an OTP and discover the CDP socket was already
    // dead" failure mode that has burned Chase and USAA runs.
    // Dynamic mode has one configured readiness budget. It applies both while
    // the allocator waits for a new surface and while the controller verifies
    // the already-retained surface before dispatch. Leaving this probe on its
    // five-second library default classified any slower semantic CDP command
    // as dead, which triggers destructive surface replacement.
    browserSurfaceReadinessProbe: createDefaultBrowserSurfaceReadinessProbe(
      runtimeConfig.dynamic ? { timeoutMs: runtimeConfig.dynamic.readinessTimeoutMs } : {}
    ),
  };

  if (runtimeConfig.dynamic) {
    options.browserSurfaceAllocator = createBrowserSurfaceAllocator({
      baseUrl: runtimeConfig.dynamic.allocatorUrl,
    });
    // This is a non-secret endpoint identity used only to keep independent
    // allocator scopes from sharing a health-refresh single-flight.
    options.browserSurfaceAllocatorScopeId = runtimeConfig.dynamic.allocatorUrl;
    options.browserSurfaceReadinessTimeoutMs = runtimeConfig.dynamic.readinessTimeoutMs;
    options.browserSurfaceLeaseSweepIntervalMs = runtimeConfig.leaseSweepIntervalMs;
  }

  return options;
}

function normalizedUrlWithoutTrailingSlash(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.href.endsWith("/") ? parsed.href.slice(0, -1) : parsed.href;
  } catch {
    return null;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
export function isManagedNekoSurfaceApproved(
  target: unknown,
  {
    runId,
    interactionId,
    browserSurfaceLeaseManager,
  }: { runId?: string | null; interactionId?: string | null; browserSurfaceLeaseManager?: unknown } = {}
) {
  if (!(browserSurfaceLeaseManager && target) || typeof target !== "object") {
    return false;
  }
  const t = target as Record<string, unknown>;
  const mgr = browserSurfaceLeaseManager as Record<string, unknown>;
  const surfaceId = typeof t.surface_id === "string" ? t.surface_id : null;
  const leaseId = typeof t.lease_id === "string" ? t.lease_id : null;
  const profileKey = typeof t.profile_key === "string" ? t.profile_key : null;
  const baseUrl = normalizedUrlWithoutTrailingSlash(t.base_url || t.origin);
  const cdpUrl = normalizedUrlWithoutTrailingSlash(t.cdp_http_url || t.cdpHttpUrl);
  if (!(surfaceId && leaseId && profileKey && baseUrl)) {
    return false;
  }

  const lease =
    typeof mgr.getLease === "function"
      ? (mgr.getLease as (id: string) => Record<string, unknown> | null | undefined)(leaseId)
      : null;
  const surface =
    typeof mgr.getSurface === "function"
      ? (mgr.getSurface as (id: string) => Record<string, unknown> | null | undefined)(surfaceId)
      : null;
  if (!(lease && surface)) {
    return false;
  }
  if (lease.status !== "leased") {
    return false;
  }
  if (surface.health !== "ready") {
    return false;
  }
  if (lease.surface_id !== surfaceId) {
    return false;
  }
  if (surface.active_lease_id !== leaseId) {
    return false;
  }
  if (lease.profile_key !== profileKey || surface.profile_key !== profileKey) {
    return false;
  }
  if (runId && lease.run_id !== runId) {
    return false;
  }
  if (interactionId) {
    const targetInteractionId = typeof t.interaction_id === "string" ? t.interaction_id : null;
    if (targetInteractionId !== interactionId) {
      return false;
    }
  }
  if (cdpUrl && normalizedUrlWithoutTrailingSlash(surface.cdp_url) !== cdpUrl) {
    return false;
  }
  return normalizedUrlWithoutTrailingSlash(surface.stream_base_url) === baseUrl;
}

// Reports one skipped schedule row at the level its cause deserves. A schedule
// row naming a connection that no longer exists is expected and fully handled —
// the row is skipped and the scheduler keeps running — so it reports at debug
// WITHOUT a stack. Reporting it at warn with a stack made every boot emit one
// stack trace per such row (ten on the live deployment), which trains the
// reader to ignore the message. A genuine fault (owner/connector mismatch,
// inactive instance, store failure) still reports at warn with its stack.
function logScheduleRefreshSkip(
  logger: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null | undefined,
  schedule: { connector_id?: string; connector_instance_id?: string } | null | undefined,
  err: unknown
): void {
  if (isExpectedMissingConnectorInstance(err)) {
    logger?.debug?.(
      {
        connector_id: schedule?.connector_id,
        connector_instance_id: schedule?.connector_instance_id ?? null,
        reason: "connector_instance_not_found",
      },
      "skipping scheduled connector whose connection no longer exists"
    );
    return;
  }
  logger?.warn?.(
    { connector_id: schedule?.connector_id, err },
    "skipping scheduled connector during scheduler refresh"
  );
}

function createReferenceSchedulerManager({
  connectionScopedRunEnvResolver = buildConnectionScopedRunEnvResolver(),
  controller,
  connectorEnvironmentPolicy,
  logger,
  runtimeContext,
  schedulerStore = getDefaultSchedulerStore(),
  connectorPathResolver = resolveDefaultConnectorPath,
  ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID,
  webPushConfig = resolveWebPushConfig(),
  webPushSubscriptionStore = createWebPushSubscriptionStore(),
}: {
  connectionScopedRunEnvResolver?: ServerOpts["connectionScopedRunEnvResolver"];
  controller: Controller;
  connectorEnvironmentPolicy?: ConnectorEnvironmentPolicy;
  logger: LoggerLike;
  runtimeContext: { rsUrl: string | null; referenceBaseUrl: string | null };
  schedulerStore?: SchedulerStore;
  connectorPathResolver?: (
    connectorId: string,
    manifest?: ConnectorManifest,
    opts?: Record<string, unknown>
  ) => string | null | Promise<string | null>;
  ownerSubjectId?: string;
  webPushConfig?: WebPushConfig;
  webPushSubscriptionStore?: WebPushSubscriptionStore;
}) {
  const directRunCancellations = new Map<string, { runId: string; cancel: () => void }>();
  let scheduler: import("../runtime/scheduler.ts").Scheduler | null = null;
  let stopped = false;
  let refreshChain = Promise.resolve();

  function registerRunCancellation(registration: { runId: string; cancel: () => void }) {
    directRunCancellations.set(registration.runId, registration);
    return () => {
      if (directRunCancellations.get(registration.runId) === registration) {
        directRunCancellations.delete(registration.runId);
      }
    };
  }

  function cancelRun(runId: string) {
    const registration = directRunCancellations.get(runId);
    if (!registration) {
      return { run_id: runId, status: "no_active_run" };
    }
    registration.cancel();
    return { run_id: runId, status: "cancel_requested" };
  }

  // The SAME connection-scoped setup-material resolver the controller uses for
  // manual runs, bound to the scheduler's owner subject. Scheduled and manual
  // runs MUST resolve credentials/import bindings identically: a connection row
  // satisfies both, and a scheduled launch never falls back to process-global
  // setup material when a connection-scoped binding exists.
  const resolveScheduledConnectionScopedRunEnv = ({
    connectorId,
    connectorInstanceId,
  }: {
    connectorId: string;
    connectorInstanceId: string;
  }) => connectionScopedRunEnvResolver({ connectorId, connectorInstanceId, ownerSubjectId });

  async function buildConnectors() {
    const schedules = await Promise.resolve(schedulerStore.listSchedules());
    const enabledSchedules = schedules.filter((schedule) => schedule?.enabled === true);
    // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
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
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
        const manifest = await getConnectorManifest(connectorId);
        if (!manifest) {
          continue;
        }
        const scheduleIneligibilityReason = getScheduleIneligibilityReason(getManifestRefreshPolicy(manifest));
        if (scheduleIneligibilityReason) {
          logger?.warn?.(
            { connector_id: connectorId, reason: scheduleIneligibilityReason },
            "skipping scheduled connector because refresh policy is not background-safe"
          );
          continue;
        }
        const connectorPath = await Promise.resolve(
          connectorPathResolver(connectorId, manifest, { priorityClass: "background" })
        );
        if (!connectorPath) {
          logger?.warn?.({ connector_id: connectorId }, "skipping scheduled connector without runnable implementation");
          continue;
        }
        // Scheduler rows are not capabilities. Authorize their exact stored
        // connection (or materialize this owner's default only when the legacy
        // row lacks a selector) before the scheduler can create run.started.
        const namespace = await admitOwnerRunConnection({
          connectorId,
          connectorInstanceId: schedule.connector_instance_id ?? null,
          connectorInstanceStore: createRequestConnectorInstanceStore(),
          ownerSubjectId,
        });
        connectors.push({
          connectorId: namespace.connectorId,
          connectorInstanceId: namespace.connectorInstanceId,
          connectorPath,
          intervalMs: Math.max(1, schedule.interval_seconds) * 1000,
          manifest,
          ownerSubjectId,
          ownerToken: await controller.issueRuntimeOwnerToken(ownerSubjectId),
        });
      } catch (err) {
        logScheduleRefreshSkip(logger, schedule, err);
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
    type RunManagedFn = import("../runtime/scheduler-domain-types.ts").RunManagedConnectorViaController;
    const runManagedConnectorViaController: RunManagedFn | null = controller?.browserSurfaceLeaseManager
      ? // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
        ((async (connectorId: string, opts: Parameters<RunManagedFn>[1]) => {
          const bslm = (
            controller as unknown as { browserSurfaceLeaseManager: { isManagedConnector: (id: string) => boolean } }
          ).browserSurfaceLeaseManager;
          if (!bslm.isManagedConnector(connectorId)) {
            return null;
          }
          const handle = await controller.runNow(connectorId, {
            connectorInstanceId: opts.connectorInstanceId,
            ownerSubjectId: opts.ownerSubjectId,
            ownerToken: opts.ownerToken,
            priorityClass: opts.priorityClass,
            recoveryOnly: opts.recoveryOnly === true,
            rsUrl: opts.rsUrl,
            triggerKind: opts.triggerKind,
          } as import("../runtime/controller.ts").RunNowOptions);
          const surfaceUnavailableStatuses = new Set([
            "run_browser_surface_queued",
            "browser_surface_probe_failed",
            "browser_surface_lost",
            "surface_failed",
          ]);
          if (handle.status && surfaceUnavailableStatuses.has(handle.status)) {
            return handle as unknown as Awaited<ReturnType<RunManagedFn>>;
          }
          const terminalStatus = await controller.awaitRun(handle.run_id);
          const terminalEvent = await getRunTerminalEvent(handle.run_id);
          const terminalData =
            terminalEvent?.data && typeof terminalEvent.data === "object"
              ? (terminalEvent.data as Record<string, unknown>)
              : ({} as Record<string, unknown>);
          return {
            connector_error: terminalData.connector_error || null,
            failure_reason: terminalData.reason || null,
            known_gaps: Array.isArray(terminalData.known_gaps) ? terminalData.known_gaps : [],
            run_id: handle.run_id,
            status: terminalStatus,
            terminal_reason: terminalData.terminal_reason || null,
            trace_id: handle.trace_id,
          } as unknown as Awaited<ReturnType<RunManagedFn>>;
        }) as RunManagedFn)
      : null;
    scheduler = createScheduler({
      connectors,
      ...(connectorEnvironmentPolicy?.approvedBindings.length
        ? { approvedEnvironmentBindings: connectorEnvironmentPolicy.approvedBindings }
        : {}),
      ...(connectorEnvironmentPolicy?.approvedProxyConnectorIds.length
        ? { approvedProxyConnectorIds: connectorEnvironmentPolicy.approvedProxyConnectorIds }
        : {}),
      logger,
      ...(runtimeContext.rsUrl === null ? {} : { rsUrl: runtimeContext.rsUrl }),
      ...(runtimeContext.referenceBaseUrl === null ? {} : { referenceBaseUrl: runtimeContext.referenceBaseUrl }),
      admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId: admittedOwnerSubjectId }) => {
        const namespace = await admitOwnerRunConnection({
          connectorId,
          connectorInstanceId,
          connectorInstanceStore: createRequestConnectorInstanceStore(),
          ownerSubjectId: admittedOwnerSubjectId ?? ownerSubjectId,
        });
        return {
          connectorId: namespace.connectorId,
          connectorInstanceId: namespace.connectorInstanceId,
          ownerSubjectId: admittedOwnerSubjectId ?? ownerSubjectId,
        };
      },
      getForwardEvidenceDebt: async (connectorId, connectorInstanceId, scheduleIntervalMs) => {
        // Forward-evidence-debt bound for recovery-first selection
        // (fix-pre-provenance-terminal-generation-semantics): bounds the
        // otherwise-unbounded recovery-first priority so an existing
        // non-pressure recovery backlog can never starve forward (fact-
        // carrying) collection indefinitely.
        //
        // Reconciles just this one connection (the same scoped, cheap repair
        // every other single-connection read uses) so the debt predicate
        // reads a genuinely current evidence row, then passes the WHOLE row
        // through — the predicate itself derives the newest per-stream
        // `evidence_as_of` from `stream_latest_facts`, never the
        // observation-timestamp `terminal_facts.as_of`.
        //
        // Fail-CLOSED to `false` (no debt) on error: a false positive would
        // divert every failing tick to forward collection instead of
        // draining recovery, which is a strictly worse failure mode than
        // occasionally missing one debt-bounded forward run.
        try {
          const instanceId = connectorInstanceId || connectorId;
          await reconcileDirtyConnectorSummaryEvidence([instanceId]);
          const evidence = await getConnectorSummaryEvidence(instanceId);
          return hasForwardEvidenceDebt(evidence, Date.now(), scheduleIntervalMs);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err: message }, `[scheduler] forward-evidence-debt probe failed for ${connectorId}`);
          return false;
        }
      },
      // Durable cross-path "latest successful run at" probe, read from the spine
      // run timeline so it sees EVERY success — including manual/owner
      // `controller.runNow` runs, which write a `run_history` row via the
      // generalized run.started/terminal writer (server/stores/
      // run-history-writer.ts) but are NOT `scheduler_managed` and so stay
      // invisible to `listRunHistory`'s cadence/backoff callers. Lets
      // the back-off gate clear a stale failure streak when a genuine success
      // has occurred since, so automation resumes. Returns null on no success or
      // probe error (never fabricates a success that would suppress back-off).
      getLastSuccessfulRunAt: async (connectorId) => {
        try {
          const summary = await getLatestConnectorRunSummary(connectorId, "succeeded");
          const at = summary?.last_at ? Date.parse(summary.last_at) : Number.NaN;
          return Number.isFinite(at) ? at : null;
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            `[scheduler] last-success spine probe failed for ${connectorId}`
          );
          return null;
        }
      },
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
      getNonPressureRecoverableCount: async (connectorId, connectorInstanceId) => {
        // Durable non-pressure recovery probe for the cross-run eligibility split
        // (SLVP-ideal §4.3). Counts pending detail gaps for this connector instance
        // whose reason is NOT in SOURCE_PRESSURE_GAP_REASONS (i.e. run_cap_deferred,
        // retry_exhausted, temporary_unavailable, null, etc.). A non-zero count
        // allows a recovery-only launch while a source-pressure cooldown is active —
        // draining non-congested work without touching the forward walk.
        //
        // Uses the same `listPendingGapsForConnector` read as the pressure probe so
        // both probes share a single bounded scan. Instance scoping mirrors the
        // pressure probe: `listPendingGapsForConnector` spans every instance of the
        // connector type; the `connector_instance_id` filter keeps cooldown
        // per-source.
        //
        // Fail-CLOSED to 0 on error: unlike the pressure probe (which fails open so
        // an unreadable store cannot silently pause a schedule), a false positive here
        // would launch a recovery run INTO an active cooldown window. When unsure
        // whether recovery work exists, do not bypass the cooldown — the next clean
        // tick recovers it.
        try {
          const store = getDefaultConnectorDetailGapStore() as {
            listPendingGapsForConnector: (
              id: string,
              opts: { limit: number }
            ) => Promise<Record<string, unknown>[] | null | undefined>;
          };
          const rows = await store.listPendingGapsForConnector(connectorId, { limit: 200 });
          const instanceKey = connectorInstanceId || connectorId;
          let count = 0;
          for (const row of rows ?? []) {
            // Exclude source-pressure reasons — they belong to Governor A (cooldown),
            // not to the recovery lane.
            if (typeof row?.reason === "string" && SOURCE_PRESSURE_GAP_REASONS.has(row.reason)) {
              continue;
            }
            // Scope to this connection's instance (same guard as the pressure probe).
            if (!matchesRecoveryInstance(row.connector_instance_id, instanceKey, connectorId)) {
              continue;
            }
            count += 1;
          }
          return count;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err: message }, `[scheduler] non-pressure recovery probe failed for ${connectorId}`);
          return 0;
        }
      },
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
      getSourcePressureGaps: async (connectorId, connectorInstanceId) => {
        // Durable source-pressure projection for the cross-run cooldown. Reads
        // pending detail gaps from `connector_detail_gaps`, keeps only the
        // account/source-pressure reasons (ChatGPT `upstream_pressure` /
        // `rate_limited`), and maps them to the lane-agnostic shape the
        // scheduler cooldown consumes. The read is bounded and reason-filtered;
        // it never returns record bodies, locators, or secrets — only the
        // reason, recovery-attempt count, and an optional next-attempt floor.
        //
        // A probe failure is surfaced as "no pressure" (empty list) so an
        // unreadable gap store cannot silently pause a schedule — same
        // fail-open stance as the attention probe above.
        const store = getDefaultConnectorDetailGapStore() as {
          listPendingGapsForConnector: (
            id: string,
            opts: { limit: number }
          ) => Promise<Record<string, unknown>[] | null | undefined>;
        };
        const rows = await store.listPendingGapsForConnector(connectorId, { limit: 200 });
        const instanceKey = connectorInstanceId || connectorId;
        // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
        const gaps = [];
        for (const row of rows ?? []) {
          if (typeof row?.reason !== "string" || !SOURCE_PRESSURE_GAP_REASONS.has(row.reason)) {
            continue;
          }
          // `listPendingGapsForConnector` spans every instance of the connector
          // type; keep only this connection's gaps so cooldown stays per-source.
          if (!matchesRecoveryInstance(row.connector_instance_id, instanceKey, connectorId)) {
            continue;
          }
          gaps.push({
            attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : null,
            lastPressureAt:
              typeof row.last_attempt_at === "string"
                ? row.last_attempt_at
                : // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
                  typeof row.updated_at === "string"
                  ? row.updated_at
                  : null,
            nextAttemptAfter: typeof row.next_attempt_after === "string" ? row.next_attempt_after : null,
            reason: row.reason,
          });
        }
        return gaps;
      },
      getState: async (connectorId, connectorInstanceId) => {
        // Read scheduler state from the connection-instance namespace by
        // construction: getSyncState keys storage off its storage-target
        // argument, and a bare connectorId string falls back to the
        // default-account instance id (the connectorInstanceId option is
        // ignored). Pass the explicit object target so each connection's
        // schedule reads its own durable state.
        const stored = await getSyncState(
          storageTargetForConnectorNamespace({
            connectorId,
            connectorInstanceId: connectorInstanceId ?? connectorId,
          }) as unknown as Parameters<typeof getSyncState>[0]
        );
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        return stored?.state || null;
      },
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
      hasUnresolvedAttention: async (connectorId, connectorInstanceId) => {
        // Durable attention projection. The in-memory `isNeedsHuman` flag
        // is process-local; this probe consults the structured
        // attention_request store so a scheduled tick after process
        // restart still recognizes unresolved owner action and does not
        // launch a doomed run. The projection is read-bounded
        // (`listOpenAttentionForConnection` clamps `limit` to 50) and
        // returns the most-recently-updated open record first.
        const projection = await getConnectorAttentionProjection(connectorId, {
          ...(connectorInstanceId === null || connectorInstanceId === undefined ? {} : { connectorInstanceId }),
        });
        if (projection.unreliable) {
          // Probe failure must not silently suppress launches — surface
          // the schedule as eligible so a freshness gap is preferred over
          // an invisible pause.
          return null;
        }
        const nowIso = new Date().toISOString();
        for (const record of projection.records) {
          if (!isAttentionHealthRelevant(record, nowIso)) {
            continue;
          }
          return { key: record.dedupe_key || record.id, reason: record.reason_code };
        }
        try {
          const routeId = connectorInstanceId || connectorId;
          const summary = await getConnectorSummaryForRoute(routeId, controller);
          const ownerAction = summary ? unresolvedOwnerActionEvidenceFromSummary(summary, routeId) : null;
          if (ownerAction) {
            return ownerAction;
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            `[scheduler] owner-action projection failed for ${connectorId}/${connectorInstanceId || connectorId}`
          );
        }
        return null;
      },
      // Recognize managed (browser-surface-leased) connectors so the scheduler
      // can DEFER a scheduled tick when the managed-routing seam above is not
      // wired yet (controller boot race), instead of cold-dispatching a fresh
      // headless browser that Cloudflare challenges and fails — each cold
      // failure deepening the back-off (the live wedge). Mirrors the predicate
      // controller.runNow uses to decide whether to acquire a managed surface.
      isManagedConnector: (connectorId) =>
        Boolean(controller?.browserSurfaceLeaseManager?.isManagedConnector?.(connectorId)),
      isNeedsHuman: (connectorId, connectorInstanceId) =>
        (connectorInstanceId === null || connectorInstanceId === undefined
          ? controller.isNeedsHuman(connectorId)
          : controller.isNeedsHuman(connectorId, { connectorInstanceId })) ||
        Boolean(
          connectorInstanceId === null || connectorInstanceId === undefined
            ? controller.getActiveRun(connectorId)
            : controller.getActiveRun(connectorId, { connectorInstanceId })
        ),
      markNeedsHuman: (connectorId, connectorInstanceId) =>
        connectorInstanceId === null || connectorInstanceId === undefined
          ? controller.markNeedsHuman(connectorId)
          : controller.markNeedsHuman(connectorId, { connectorInstanceId }),
      // §10-F: push escalation on transition into human-required state.
      // Fires ONCE per streak/flag (dedup lives in the scheduler runtime maps
      // announcedBlockedClass + notifiedNeedsHumanSkips). Errors are swallowed
      // so a push delivery failure never crashes the scheduler loop.
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
      onHumanRequiredStateEscalation: async ({ connectorId, connectorInstanceId, reason }) => {
        let connectorDisplayName = connectorId;
        let connectionUrl = "/deployment";
        // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
        let renderedVerdict = null;
        const routeId = connectorInstanceId || connectorId;
        try {
          const summary = await getConnectorSummaryForRoute(routeId, controller);
          if (summary) {
            connectorDisplayName = summary.display_name || summary.connector_display_name || connectorId;
            connectionUrl = `/sources/${encodeURIComponent(summary.connection_id || routeId)}`;
            renderedVerdict = summary.rendered_verdict;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn?.(
            `[scheduler] verdict projection failed for escalation ${connectorId}/${routeId}; suppressing push: ${message}`
          );
        }
        try {
          await fanoutEscalationWebPush({
            config: webPushConfig,
            connectionUrl,
            connectorDisplayName,
            ownerSubjectId,
            reason,
            store: webPushSubscriptionStore,
            ...(renderedVerdict === null
              ? {}
              : {
                  renderedVerdict:
                    renderedVerdict as unknown as import("../server/web-push-notifications.ts").EscalationRenderedVerdict,
                }),
            log: logger,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`[scheduler] §10-F escalation push failed for ${connectorId} (${reason}): ${message}`);
        }
      },
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
      onInteraction: async (...args: unknown[]) => {
        const interaction = args[0] as Record<string, unknown>;
        const connectorDisplayName =
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          typeof interaction?.connector_display_name === "string" &&
          (interaction.connector_display_name as string).trim()
            ? (interaction.connector_display_name as string).trim()
            : // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
              // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
              typeof interaction?.connector_id === "string" && (interaction.connector_id as string).trim()
              ? (interaction.connector_id as string).trim()
              : "Connector";
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        const runId = typeof interaction?.run_id === "string" ? (interaction.run_id as string) : null;
        if (runId) {
          try {
            await fanoutPendingInteractionWebPush({
              config: webPushConfig,
              connectorDisplayName,
              interaction: interaction as import("../server/web-push-notifications.ts").PendingInteractionInput,
              log: logger,
              ownerSubjectId,
              // Record the durable notification outcome on the structured
              // attention row the runtime writer just upserted. The attention
              // id is the runtime writer's default `att_<runId>_<requestId>`
              // — kept deterministic so the scheduler seam (which does not
              // own the per-run writer instance) can address it. A non-default
              // factory is only used by tests, which do not flow through this
              // production push path.
              recordOutcome: async ({ state, reason }) => {
                const requestId =
                  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
                  typeof interaction?.request_id === "string" ? (interaction.request_id as string) : null;
                if (!requestId) {
                  return;
                }
                const attentionStore = getDefaultConnectorAttentionStore();
                if (typeof attentionStore.recordNotificationOutcomeById !== "function") {
                  return;
                }
                await attentionStore.recordNotificationOutcomeById({
                  attentionId: `att_${runId}_${requestId}`,
                  now: new Date().toISOString(),
                  outcome: state,
                  reason: reason || null,
                });
              },
              // Scheduled interactions are immediately marked needs-human and
              // cancelled so the scheduler does not wait unattended. Notify the
              // owner, but route to the durable run context rather than a
              // transient stream that may already be closed.
              routeTo: "run",
              runId,
              store: webPushSubscriptionStore,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger?.warn?.(`[scheduler] web push fire for run ${runId} failed: ${message}`);
          }
        }
        return {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          request_id: typeof interaction?.request_id === "string" ? (interaction.request_id as string) : null,
          status: "cancelled",
          type: "INTERACTION_RESPONSE",
        };
      },
      onRunComplete: (record) => {
        logger?.info?.(
          {
            connector_id: record.connectorId,
            connector_instance_id: record.connectorInstanceId || record.connectorId,
            run_id: record.runId || null,
            status: record.status,
            trace_id: record.traceId || null,
          },
          "scheduled connector run completed"
        );
      },
      registerRunCancellation,
      resolveStaticSecretRunEnv:
        resolveScheduledConnectionScopedRunEnv as import("../runtime/scheduler-domain-types.ts").ResolveStaticSecretRunEnv,
      // Route managed-connector scheduled runs through controller.runNow so
      // they acquire the neko browser-surface lease (warm persistent profile,
      // cf_clearance cookie present) instead of launching a fresh headless
      // Chromium with an empty profile that Cloudflare challenges 100%.
      //
      // The callback returns null for non-managed connectors so launchRun
      // falls through to the existing runConnector path unchanged.
      //
      // Lease release is inherited via runNow's own .finally() →
      // finalizeRunCleanup → releaseBrowserSurfaceLeaseAfterRun chain.
      // No separate release is added here (double-release risk).
      //
      // controller_active_runs mutual exclusion: validateRunNowPreconditions
      // throws run_already_active when a run is already in-flight; the
      // scheduler's own runtime.activeRuns guard prevents double-dispatch
      // from within the scheduler.
      runManagedConnectorViaController,
      schedulerStore,
      setState: async (connectorId, state, connectorInstanceId) => {
        if (!connectorInstanceId) {
          throw new Error("scheduler state persistence requires an admitted connectorInstanceId");
        }
        await putSyncState(
          storageTargetForConnectorNamespace({
            connectorId,
            connectorInstanceId,
          }) as unknown as Parameters<typeof putSyncState>[0],
          state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : {}
        );
      },
    });
    scheduler.start();
    logger?.info?.({ schedules: connectors.length }, "reference scheduler started");
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

  return { cancelRun, refresh, start: refresh, stop };
}

export interface ShutdownStorageCloseDependencies {
  readonly closeDb: () => void;
  readonly closePostgresStorage: () => Promise<void>;
  readonly drainConnectorInstanceIndexWork: (timeoutMs?: number) => Promise<void>;
  readonly onDrainTimeout?: (err: unknown) => void;
}

export type ShutdownStorageCloseOutcome = { readonly closed: true } | { readonly closed: false; readonly err: unknown };

/**
 * Pure (dependency-injected, no process.exit/no module-scope state) decision
 * boundary for the drain-then-close half of CLI shutdown: drain the deferred
 * lexical/semantic index-maintenance lane, then close EITHER storage backend
 * only if that drain actually succeeded. A deferred job can be running
 * against SQLite or Postgres depending on the active backend, so both
 * closeDb() and closePostgresStorage() are equally unsafe to run out from
 * under one -- on a drain timeout, NEITHER may run.
 *
 * process.exit(1) on the caller's timeout branch does NOT let an in-flight
 * job "finish naturally": Node's process.exit reclaims file descriptors and
 * tears down the event loop immediately, so any in-flight query is aborted
 * at whatever point it happened to be, same as a hard kill. What skipping
 * closeDb()/closePostgresStorage() here actually buys is narrower: this
 * process never itself issues a controlled close on a handle a job is
 * using, so the specific "[db] No database is open" failure mode (this
 * process's OWN close racing this process's OWN deferred job) cannot
 * occur -- it does not make the in-flight job safe, only removes this
 * process as the cause of that specific defect.
 *
 * Extracted as a pure function (rather than left inline in the CLI-only
 * entrypoint block below, which only runs under `node server/index.ts` and
 * cannot be exercised by an import-time test) specifically so this
 * drain-gates-close invariant is provable at a real boundary instead of by
 * reading the source.
 */
export async function shutdownStorageClose(
  deps: ShutdownStorageCloseDependencies
): Promise<ShutdownStorageCloseOutcome> {
  try {
    await deps.drainConnectorInstanceIndexWork(2000);
  } catch (err) {
    deps.onDrainTimeout?.(err);
    return { closed: false, err };
  }
  await deps.closePostgresStorage();
  deps.closeDb();
  return { closed: true };
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────
//
// Process-level handlers (uncaughtException, unhandledRejection, SIGTERM,
// SIGINT) live HERE, inside the CLI entrypoint block, not inside startServer.
// startServer is imported and called many times per process from the test
// harness (test/pdpp.test.js, test/provider-metadata.test.js); adding global
// listeners from the library surface would accumulate on every call and
// cross-contaminate tests. These handlers fire only when server/index.ts is
// run directly as `node server/index.ts`.
if (process.argv[1]?.endsWith("server/index.ts")) {
  const cliLogger = buildLogger();
  let shuttingDown = false;
  let pipeWarnEmitted = false;
  // Every containment is logged (not deduplicated like the pipe warning):
  // a rising count is the operational signal that the upstream trigger is
  // still firing, so it must stay visible rather than collapse to one line.
  let undiciParserAssertionsContained = 0;

  const exitOnFatal = (reason: string) => (err: unknown) => {
    if (shuttingDown) {
      return;
    }
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
  const handleUncaught = (err: unknown) => {
    if (isClosedPipeWriteError(err)) {
      if (!pipeWarnEmitted) {
        pipeWarnEmitted = true;
        try {
          cliLogger.warn({ err }, "closed-pipe write on owned stdio downgraded");
        } catch {
          /* warn emission may itself EPIPE; swallow once */
        }
      }
      return;
    }
    // An assertion inside Node's VENDORED undici HTTP parser, raised from a
    // socket-teardown event, is a liveness bug in a dependency rather than a
    // signal that this process holds corrupt state. Left fatal it kills the
    // whole reference process and abandons every unrelated in-flight run
    // (observed in production: a Slack run and an unrelated GroupMe run
    // abandoned 145ms apart by one crash). undici destroys the socket
    // regardless and the owning fetch() promise still rejects, so the run
    // that owned the request fails honestly through its own error path.
    // Every other uncaught error — including any ERR_ASSERTION raised by
    // application code — still takes the fatal path below.
    // See runtime/undici-parser-errors.ts for the full mechanism and for
    // why this specific shape is safe to contain.
    if (isVendoredUndiciParserAssertion(err)) {
      undiciParserAssertionsContained += 1;
      cliLogger.error(
        { contained_total: undiciParserAssertionsContained, err },
        "vendored undici parser assertion contained; process survives"
      );
      return;
    }
    exitOnFatal("uncaughtException")(err);
  };
  process.on("uncaughtException", handleUncaught);
  process.on("unhandledRejection", exitOnFatal("unhandledRejection"));

  type StartServerResult = Awaited<ReturnType<typeof startServer>>;
  const server: {
    asServer: StartServerResult["asServer"] | null;
    rsServer: StartServerResult["rsServer"] | null;
    abortStartupBackfill: StartServerResult["abortStartupBackfill"] | null;
    startupBackfillDone: StartServerResult["startupBackfillDone"] | null;
    startupRunHistoryBackfillDone: StartServerResult["startupRunHistoryBackfillDone"] | null;
    startupSummaryEvidenceSweepDone: StartServerResult["startupSummaryEvidenceSweepDone"] | null;
    schedulerManager: StartServerResult["schedulerManager"] | null;
    controller: StartServerResult["controller"] | null;
    stopBrowserSurfaceLeaseSweep: StartServerResult["stopBrowserSurfaceLeaseSweep"] | null;
    stopClientEventDeliveryWorker: StartServerResult["stopClientEventDeliveryWorker"] | null;
    stopConnectorMaintenanceSweep: StartServerResult["stopConnectorMaintenanceSweep"] | null;
  } = {
    abortStartupBackfill: null,
    asServer: null,
    controller: null,
    rsServer: null,
    schedulerManager: null,
    startupBackfillDone: null,
    startupRunHistoryBackfillDone: null,
    startupSummaryEvidenceSweepDone: null,
    stopBrowserSurfaceLeaseSweep: null,
    stopClientEventDeliveryWorker: null,
    stopConnectorMaintenanceSweep: null,
  };
  const exitOnSignal = (signal: string) => async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    cliLogger.info({ signal }, "shutdown signal received");
    // Close HTTP servers FIRST so in-flight handlers can finish their
    // SQLite writes (commit or rollback) before we release the DB
    // handle. Closing the DB underneath active handlers can leave a
    // mid-transaction lock visible to a sibling process (Docker dev
    // compose restarts via `node --watch`, so a new process may try to
    // re-acquire the WAL writer immediately after this one exits).
    const closeTimeout = (
      srv:
        | { close?: (cb: () => void) => void; closeAllConnections?: () => void; closeIdleConnections?: () => void }
        | null
        | undefined
    ) =>
      new Promise<void>((resolve) => {
        if (!srv) {
          resolve();
          return;
        }
        let done = false;
        let forceTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (done) {
            return;
          }
          done = true;
          if (forceTimer) {
            clearTimeout(forceTimer);
          }
          resolve();
        };
        forceTimer = setTimeout(() => {
          try {
            srv.closeAllConnections?.();
            // biome-ignore lint/suspicious/noEmptyBlockStatements: The empty handler intentionally absorbs this best-effort cleanup failure.
          } catch {}
          finish();
        }, 2000);
        try {
          srv.closeIdleConnections?.();
          // biome-ignore lint/suspicious/noEmptyBlockStatements: The empty handler intentionally absorbs this best-effort cleanup failure.
        } catch {}
        try {
          srv.close?.(finish);
        } catch {
          finish();
        }
      });
    const httpDrains = [closeTimeout(server.asServer), closeTimeout(server.rsServer)];
    // Signal the startup retrieval backfill to wind down ALONGSIDE the
    // HTTP drain. Without this, a backfill mid-`upsertMany` keeps the
    // SQLite writer slot held while we proceed to `closeDb()`, and a
    // sibling process re-opening the same WAL DB (e.g. `node --watch`
    // restart, `docker compose restart reference`) sees a stale lock
    // and trips `SQLITE_BUSY database is locked`. The backfill loop
    // checks the abort flag between page transactions and at the
    // top of each connector iteration, so this releases on a clean
    // boundary. Bounded await with a 2s timeout matches the HTTP drain.
    try {
      server.abortStartupBackfill?.("shutdown");
      // biome-ignore lint/suspicious/noEmptyBlockStatements: The empty handler intentionally absorbs this best-effort cleanup failure.
    } catch {}
    const backfillDeadline = new Promise((resolve) => setTimeout(resolve, 2000));
    const awaitStartupTasks = Promise.allSettled([
      server.startupBackfillDone,
      server.startupRunHistoryBackfillDone,
      server.startupSummaryEvidenceSweepDone,
    ]);
    try {
      server.schedulerManager?.stop?.();
      // biome-ignore lint/suspicious/noEmptyBlockStatements: The empty handler intentionally absorbs this best-effort cleanup failure.
    } catch {}
    server.stopBrowserSurfaceLeaseSweep?.();
    server.stopConnectorMaintenanceSweep?.();
    await server.stopClientEventDeliveryWorker?.();
    // In-flight connector runs are deliberately NOT drained here.
    //
    // A drain cannot succeed inside the budget that actually exists.
    // Production sets no `--stop-timeout`, so Docker's 10s default governs,
    // and `--stop-timeout` is fixed at container creation — Docker has no
    // equivalent of systemd's runtime `EXTEND_TIMEOUT_USEC=`. A Gmail run
    // takes minutes. The gap is two orders of magnitude and is not closable.
    //
    // The 5s drain that used to be here was measured in production spending
    // its entire budget and abandoning the run anyway
    // (`drained:0, elapsedMs:5000, timedOut:1`). That is a negative win: it
    // consumed half the SIGKILL budget doing nothing, while making the
    // failure look handled.
    //
    // Correctness does not depend on the dying process reporting. It cannot:
    // a `kill -9` has no drain at all. The successor adjudicates instead —
    // `reconcileOrphanedRunsAtBoot` writes `run.abandoned` for any run whose
    // owner epoch is not the current one. Temporal ships the same layering
    // (`WorkerStopTimeout` defaults to 0s; the service writes the terminal
    // state on a timer), as does Kafka (the successor's `InitProducerId`
    // epoch bump recovers the previous instance's transaction).
    //
    // Dropping the drain makes shutdown faster and the failure mode honest.
    // `drainActiveRuns` itself stays on the controller: it means "await
    // in-flight runs", which the watchdog, `awaitRun`, and the test suite all
    // rely on. Sidekiq draws the same line between *quiet* and *drain*.
    // Chromium residue is still cleaned on next boot by
    // polyfill-connectors/src/profile-lock.ts (Layer C).
    await Promise.allSettled([...httpDrains, Promise.race([awaitStartupTasks, backfillDeadline])]);
    // See shutdownStorageClose's own doc comment for the drain-gates-close
    // invariant and why exit(1) here does not mean the in-flight job
    // finishes safely -- only that this process is not the one that raced
    // it with a controlled close.
    const closeOutcome = await shutdownStorageClose({
      closeDb,
      closePostgresStorage,
      drainConnectorInstanceIndexWork,
      onDrainTimeout: (err) => {
        cliLogger.warn(
          { err },
          "deferred index work did not drain before shutdown; skipping storage close to avoid closing a handle under an active job"
        );
      },
    });
    process.exit(closeOutcome.closed ? 0 : 1);
  };
  process.on("SIGTERM", exitOnSignal("SIGTERM"));
  process.on("SIGINT", exitOnSignal("SIGINT"));

  startServer({ logger: cliLogger })
    .then((result) => {
      server.asServer = result.asServer;
      server.rsServer = result.rsServer;
      server.abortStartupBackfill = result.abortStartupBackfill;
      server.startupBackfillDone = result.startupBackfillDone;
      server.startupRunHistoryBackfillDone = result.startupRunHistoryBackfillDone;
      server.startupSummaryEvidenceSweepDone = result.startupSummaryEvidenceSweepDone;
      server.schedulerManager = result.schedulerManager;
      server.controller = result.controller;
      server.stopBrowserSurfaceLeaseSweep = result.stopBrowserSurfaceLeaseSweep;
      server.stopClientEventDeliveryWorker = result.stopClientEventDeliveryWorker;
      server.stopConnectorMaintenanceSweep = result.stopConnectorMaintenanceSweep;
    })
    .catch((err) => {
      closePostgresStorage().finally(() => closeDb());
      cliLogger.fatal({ err }, "startup failed");
      process.nextTick(() => process.exit(1));
    });
}
