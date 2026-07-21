// Reference-only HTTP control-plane projections.
//
// These helpers back the `/_ref/connectors*`, `/_ref/approvals`, and
// `/_ref/records/timeline` routes. They read from the configured reference
// storage substrate and the spine correlation index, then shape the result
// into the JSON envelopes the dashboard consumes.
//
// Not a PDPP protocol surface: these are debugging / operator views the
// reference implementation exposes for its own dashboard. Clients must
// not depend on the response shape.

import type { BrowserSurface, BrowserSurfaceLease } from "@opendatalabs/remote-surface/leases";
import { allowUnboundedReadAcknowledged, getOne, iterateDynamicSqlAcknowledged, referenceQueries } from "../lib/db.ts";
import { listSpineCorrelations, type SpineSummary } from "../lib/spine.ts";
import { type AttentionRecord, isHealthRelevant, type OwnerAction } from "../runtime/attention.ts";
import {
  type ConnectorSummaryCacheDecision as ConnectorSummariesCacheDecisionForRuntime,
  type ConnectorSummaryCacheEntry as ConnectorSummaryCacheEntryForRuntime,
  decideConnectorSummariesCacheRead as decideConnectorSummariesCacheReadForRuntime,
} from "../runtime/browser-surface/connector-summary-cache-policy.ts";
import type { EphemeralBrowserRuntimeProjection } from "../runtime/browser-surface/ephemeral-health-projection.ts";
import {
  connectionHealthRemoteSurface,
  projectConnectorHealthSummaryRuntime,
  readBrowserSurfaceRuntimeInventory,
} from "../runtime/browser-surface/health-summary-adapter.ts";
import { readBrowserSurfaceProfileKey } from "../runtime/browser-surface/profile-key.ts";
import {
  type BrowserSurfaceRepairContext,
  type CollectionRateSnapshot,
  type ConnectionAttentionEvidence,
  type ConnectionCredentialEvidence,
  type ConnectionDetailGapBacklogEvidence,
  type ConnectionHealthSnapshot,
  type ConnectionLocalDeviceCollectionEvidence,
  type ConnectionRefreshEvidence,
  type ConnectionRemoteSurfaceEvidence,
  type CoverageAxis,
  computeConnectionHealth,
  deriveForwardDisposition,
  type ForwardDisposition,
  type FreshnessAxis,
  type NextAction,
  type OutboxAxis,
  type OutboxDiagnosticCounts,
  type OutboxStalledCause,
} from "../runtime/connection-health.ts";
import {
  buildProgressEvidence,
  progressMode,
  synthesizeConnectorVerdict,
  type ManifestStreamLike as VerdictManifestStreamLike,
} from "../runtime/connector-verdict-input.ts";
import type { BrowserSurfaceRuntimeInventorySnapshot, BrowserSurfaceRuntimeManagement } from "../runtime/controller.ts";
import {
  type ClassifiedRunForOwnerState,
  deriveOwnerState,
  type OwnerState,
  type OwnerStateEvidence,
  ownerStateCausalEvidenceFrom,
  scheduleModeFrom,
} from "../runtime/owner-state.ts";
import {
  deriveRecoveryStall,
  RECOVERY_STALL_CADENCE_MS,
  type RecoveryAdmissionDiagnostics,
  type RecoveryGapRow,
  type RecoveryStallObservation,
  summarizeRecoveryAdmissionDiagnostics,
} from "../runtime/recovery-decision.ts";
import type { RenderedVerdict, ScheduleEvidence } from "../runtime/rendered-verdict.ts";
import { SOURCE_PRESSURE_GAP_REASONS } from "../runtime/scheduler-source-pressure-cooldown.ts";
import { pickMostUrgentAttention } from "./attention-urgency.ts";
import { getConnectorManifest } from "./auth.js";
import {
  type EnrollmentShellLike,
  retireExpiredBrowserEnrollmentShells,
} from "./browser-enrollment-shell-retirement.ts";
import {
  ACTIVE_WAITING_LEASE_STATUSES,
  pickMostRecentCurrentSurface,
  pickMostRecentSurface,
  pickMostUrgentLease,
} from "./browser-surface-selection.ts";
import { mapWithConcurrency as runWithConcurrency } from "./concurrency.ts";
import { staticSecretCredentialCaptureFromManifest } from "./connection-setup-plan.ts";
import {
  type CoverageEvidenceStrategy,
  deriveStreamCoverageCondition,
  type FreshnessEvidenceStrategy,
  isRequiredStream,
  pickAcceptedCoverage,
  pickRequiredAcceptedCoverage,
  readCoverageEvidenceStrategy,
  readFreshnessEvidenceStrategy,
} from "./connector-coverage-policy.ts";
import {
  firstDegradingKnownGapReason,
  firstPendingDetailGapReason,
  hasDegradingKnownGap,
  hasTerminalKnownGap,
  isRetryableKnownGap,
} from "./connector-gap-classification.ts";
import {
  type HeartbeatRow,
  projectConnectorOutboxAxisFromHeartbeats,
  projectLocalDeviceProgress,
} from "./connector-outbox-axis.ts";
import {
  listConnectorSummaryEvidence,
  reconcileDirtyConnectorSummaryEvidence,
  shapeEvidenceRow,
} from "./connector-summary-read-model.ts";
import { getSqliteStoreCacheIdentity } from "./db.js";
import { deriveReferenceFreshness, type ReferenceFreshness } from "./freshness.ts";
import { mapPendingPressureGaps } from "./pending-pressure-gap-map.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.js";
import { readCommittedLocalCoverageDiagnostics } from "./records.js";
import {
  chooseDisplayTimestamp,
  compareTimestampValues,
  type ManifestStreamLike,
  pickSemanticTimestamp,
  type SemanticTimestamp,
  timestampWithinWindow,
} from "./ref-record-utils.ts";
import { listRetainedSizeConnections, listRetainedSizeStreams } from "./retained-size-read-model.js";
import {
  parseCollectionRatePayload,
  readCollectionFactsFromTerminalData,
  readRuntimeCollectionFact,
} from "./runtime-collection-facts.ts";
import {
  asBackoffRecord,
  asScheduleRecord,
  readNumber,
  succeededRunSupersedesSchedulerBackoff,
} from "./scheduler-backoff-read.ts";
import {
  createPostgresAcquisitionBatchStore,
  createSqliteAcquisitionBatchStore,
} from "./stores/acquisition-batch-store.ts";
import { getDefaultBrowserSurfaceLeaseStore } from "./stores/browser-surface-lease-store.ts";
import { getDefaultConnectorAttentionStore } from "./stores/connector-attention-store.ts";
import { getDefaultConnectorDetailGapStore } from "./stores/connector-detail-gap-store.js";
import {
  createPostgresConnectorInstanceCredentialStore,
  createSqliteConnectorInstanceCredentialStore,
} from "./stores/connector-instance-credential-store.js";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "./stores/connector-instance-store.js";
import { getDefaultDeviceExporterStore } from "./stores/device-exporter-store.ts";
import {
  type ActiveRunRecord,
  getDefaultSchedulerStore,
  type SchedulerRunHistoryRecord,
} from "./stores/scheduler-store.ts";

// ─── Shared domain types ────────────────────────────────────────────────────

/**
 * Per-field JSON-Schema declaration carried in a stream manifest's
 * `schema.properties`. The reference accepts an optional JSON-Schema extension
 * `x_pdpp_type` here (for example `currency`, `timestamp`, `person`, `blob`,
 * `text`) and also accepts the sandbox-shaped field declaration array below.
 * It is additive and optional: a manifest that omits both carriers
 * produces the current shape, and it is surfaced read-only as
 * `field_capabilities[field].type` purely as a presentation/dispatch hint —
 * it does not change filter, search, aggregation, grant, or retrieval
 * semantics, and it is never client-writable or grantable. See:
 *   openspec/changes/complete-explorer-slvp-ideal
 */
interface ManifestFieldSchema {
  description?: string;
  format?: string;
  type?: string | string[];
  /** Optional declared presentation type. Absent means "not declared". */
  x_pdpp_type?: string;
  [extension: string]: unknown;
}

/**
 * Sandbox-shaped per-field declaration. This mirrors the demo manifests'
 * `{ name, type, semantic_class }` shape while keeping JSON Schema field
 * validation in `schema.properties`.
 */
interface ManifestFieldDeclaration {
  description?: string;
  name: string;
  semantic_class?: string;
  type: string;
  [extension: string]: unknown;
}

interface ManifestStream extends ManifestStreamLike {
  /**
   * Accepted-coverage policy for the stream. Default (absent) means
   * `collect`: the connector intends to collect this stream and any
   * absence is a gap. Other values declare the absence as accepted:
   *
   *   - `unsupported`    : the connector implementation cannot collect
   *                        this stream and that limit is known/accepted
   *   - `unavailable`    : the upstream source cannot expose the stream
   *                        for this account/configuration
   *   - `deferred`       : collection is intentionally deferred per policy
   *   - `inventory_only` : only inventory/discovery is owed; no detail
   *
   * Combining `required: true` with an accepted-coverage policy is
   * contradictory (a stream cannot be both load-bearing and accepted-
   * absent) and degrades health rather than projecting green.
   */
  coverage_policy?: "collect" | "deferred" | "inventory_only" | "unavailable" | "unsupported";
  /**
   * Declared mechanism by which this stream establishes coverage. Unlike
   * `coverage_policy`, this is not an accepted-absence claim; it identifies the
   * proof shape that lets the projection classify a successful stream without
   * inventing a numeric denominator.
   */
  coverage_strategy?: CoverageEvidenceStrategy;
  /** Sandbox-shaped typed field declarations already used by demo streams. */
  fields?: ManifestFieldDeclaration[];
  /** Declared mechanism by which this stream establishes freshness/currency. */
  freshness_strategy?: FreshnessEvidenceStrategy;
  name: string;
  /**
   * Required-stream policy. Defaults to `true` when absent so that streams
   * declared in a manifest without explicit policy are treated as
   * load-bearing for connection health. Manifest authors opt OUT of
   * required-stream policy by setting `required: false` (i.e. the stream
   * is documented but not load-bearing).
   */
  required?: boolean;
  schema?: {
    /** Schema-adjacent form for the same typed field declaration shape. */
    fields?: ManifestFieldDeclaration[];
    properties?: Record<string, ManifestFieldSchema>;
    required?: string[];
    type?: string;
    [extension: string]: unknown;
  };
  semantics?: string;
}

type ConnectorManifest = {
  connector_id?: string;
  capabilities?: Record<string, unknown>;
  display_name?: string;
  profiles?: { id: string }[];
  protocol_version?: string | null;
  runtime_requirements?: {
    bindings?: Record<string, unknown>;
  };
  streams?: ManifestStream[];
  version?: string;
} & Record<string, unknown>;

interface ConnectorRow {
  readonly connector_id: string;
  readonly manifest: string;
}

const NON_PUBLIC_CONNECTOR_ID_PARTS = [
  "manual_action_stub",
  "manual-action-stub",
  "stream-test-stub",
  "pg_runtime_",
  "pg_canonical_",
  "pg_expand_",
  // System backfill jobs materialise a connector_instances row during lexical
  // indexing. These are never owner-created connections and must not surface on
  // any owner-facing source list.
  "pg_lexical_backfill_",
];
const REFERENCE_OWNER_SUBJECT_ID = "owner_local";

type Freshness = ReferenceFreshness;

interface RecordProjection {
  readonly byStream: Map<string, StreamProjection>;
  readonly freshness: Freshness;
  readonly retainedBytes: RetainedBytesBreakdown | null;
  // True only when the connection's maintained retained-size projection has
  // been proven clean (a connection row exists, is not dirty, and has
  // computed at least once). Declared-but-absent streams may only be
  // synthesized as an exact zero when this is true; otherwise `byStream`'s
  // absence of a stream is a genuine measurement gap, not a zero, and must
  // stay absent.
  readonly retainedSizeReliable: boolean;
  readonly totalRecords: number;
}

interface StreamProjection {
  readonly freshness: Freshness;
  readonly last_updated: string | null;
  readonly record_count: number;
}

export interface StreamRecordSummary {
  readonly last_updated: string | null;
  /**
   * `null` when the count is genuinely unknown/unavailable
   * (`count_state: "unobserved" | "unknown"`) — never coerced to a
   * fabricated `0`. `0` is reserved for a proven exact count
   * (`count_state: "known_zero"` or a real `"known"` zero). `count_state:
   * "stale"` is the one exception (spec.md: "prior count may be retained
   * after its checkpoint moved or repair failed") — the last-known count
   * is kept as a non-authoritative hint rather than nulled, distinguishing
   * "we once knew N, unverified since" from "we have never known."
   */
  readonly record_count: number | null;
  readonly stream: string;
  /**
   * Orthogonal declaration/count state pair from the maintained
   * connector-summary evidence (design.md "Explicit stream evidence").
   * Optional so existing non-evidence-backed callers of this shape are
   * unaffected; `projectConnectorSummaryForInstance` always populates it
   * when the observation barrier produced an evidence row.
   */
  readonly declaration_state?: "declared" | "dormant" | "unexpected" | "unavailable";
  readonly count_state?: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
  readonly retained_record_count?: number | null;
}

interface RecordProjectionRow {
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly last_updated: string | null;
  readonly record_count: number | string | null;
  readonly stream: string;
}

export interface RetainedBytesBreakdown {
  readonly blob_bytes: number;
  readonly record_changes_json_bytes: number;
  readonly record_json_bytes: number;
  readonly total_bytes: number;
}

interface RetainedSizeConnectionProjectionRow {
  readonly blob_bytes?: number | string | null;
  readonly computed_at?: string | null;
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly current_record_json_bytes?: number | string | null;
  readonly dirty?: boolean;
  readonly record_history_json_bytes?: number | string | null;
}

interface RetainedSizeProjectionSnapshot {
  readonly connectionsByInstanceId: ReadonlyMap<string, RetainedSizeConnectionProjectionRow>;
  readonly streamsByConnectorId: ReadonlyMap<string, readonly RecordProjectionRow[]>;
  readonly streamsByInstanceId: ReadonlyMap<string, readonly RecordProjectionRow[]>;
}

interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly displayName: string;
  readonly ownerSubjectId: string;
  readonly revokedAt: string | null;
  readonly sourceBinding?: unknown;
  readonly sourceKind: string;
  readonly status: string;
}

interface ManifestExcerpt {
  readonly connector_id: string | undefined;
  readonly display_name: string;
  readonly profile_ids: string[];
  readonly protocol_version: string | null;
  readonly version: string | undefined;
}

interface StreamSummary {
  readonly freshness: Freshness;
  readonly last_updated: string | null;
  readonly name: string;
  readonly object: "stream";
  /** `null` when the count is genuinely unknown/unavailable — never coerced to a fabricated `0`. */
  readonly record_count: number | null;
  /**
   * Orthogonal state for `record_count` — the same contract
   * `StreamRecordSummary.count_state` already applies on the list surface
   * (Sol P1.3): a `record_count` carried over from a non-current
   * record_snapshot reads `"stale"`, never `"known"`/`"known_zero"`, so the
   * detail surface cannot render a failed snapshot's number as an
   * authoritative exact count either. `undefined` only for the
   * unresolved/ambiguous detail shape, which omits per-stream evidence
   * entirely (see `buildUnresolvedConnectorDetail`).
   */
  readonly count_state?: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
  readonly semantics: string | null;
}

/**
 * The skip fact the runtime attaches to a `collection_facts` stream entry when
 * the connector emitted `SKIP_RESULT` for that stream. Carries only the bounded
 * reason and the recovery action the runtime already redacts onto the known-gap
 * — never free-text diagnostics.
 */
export interface RuntimeCollectionFactSkip {
  readonly reason: string;
  readonly recovery_action?: string;
}

/**
 * One per-stream entry of the runtime `collection_facts` block (Tranche B). These
 * are OBJECTIVE run-local facts only: the runtime stamps NO coverage condition or
 * forward disposition (those are derived on read by `buildCollectionReport`).
 * `considered` is `null` when the connector declared no considered denominator —
 * the projection reads `null` as `unknown` and NEVER infers `complete` from
 * `collected` alone.
 */
export interface RuntimeCollectionFact {
  readonly checkpoint: string | null;
  readonly collected: number;
  readonly considered: number | null;
  /**
   * Optional connector-declared `covered` count: the in-boundary items the run
   * accounted for (emitted + suppressed-because-unchanged), or `null` when the
   * connector declared none. When non-null the coverage gate compares `considered`
   * against this instead of `collected`, so a steady-state full-sync run that
   * suppressed every unchanged record reads `complete` rather than a false
   * `partial`. NEVER inferred from `collected`; a weighed-but-dropped item is in
   * neither count, so a real shortfall still reads `partial`.
   */
  readonly covered: number | null;
  readonly pending_detail_gaps: number;
  readonly skipped: RuntimeCollectionFactSkip | null;
  readonly stream: string;
}

/** The runtime `collection_facts` terminal-event block, parsed defensively. */
export interface RuntimeCollectionFacts {
  readonly streams: readonly RuntimeCollectionFact[];
}

export interface ConnectorRunSummary {
  /**
   * The runtime `collection_facts` block read off this run's terminal event, or
   * `null` for a run that predates Tranche B, exited before the terminal builder
   * ran, or carried a malformed block. Source evidence for the derived
   * `collection_report`; never final coverage truth.
   */
  readonly collection_facts: RuntimeCollectionFacts | null;
  readonly event_count: number;
  readonly failure_reason: string | null;
  readonly finished_at: string | null;
  readonly first_at: string;
  readonly known_gaps: unknown[];
  readonly last_at: string;
  /**
   * Whether this run was dispatched `recovery_only` (drains pending detail
   * gaps only; performs no forward/list-pass inventory scan). Read directly
   * off the terminal event's `recovery_only` flag
   * (`runtime/index.js` `buildRunTerminalData`). A recovery-only run's own
   * `collection_facts` is ALWAYS `null` by design (`buildCollectionFacts`'s
   * `recoveryOnly` branch) — it did not measure any stream, list-pass or
   * detail-recovered, so it carries no forward coverage evidence of its own.
   * `coverageClassifyingRun` reads this to decide whether a terminal
   * recovery-only success should defer to the last run that DID measure
   * (`lastSuccessfulRun`) rather than being read as a fresh "no evidence"
   * verdict that wipes prior proven coverage.
   */
  readonly recovery_only: boolean;
  readonly run_id: string | undefined;
  readonly started_at: string;
  readonly status: string;
  readonly terminal_reason: string | null;
}

export interface PendingDetailGapSummary {
  /**
   * Recovery-attempt count for the gap (`connector_detail_gaps.attempt_count`).
   * `rowToGap` returns it; the source-pressure backlog rollup reads it as the
   * cooldown governor's `attemptCount`. Optional/`unknown` because not every
   * gap projection populates it.
   */
  readonly attempt_count?: unknown;
  readonly connector_instance_id?: unknown;
  readonly last_attempt_at?: unknown;
  readonly next_attempt_after?: unknown;
  readonly reason?: unknown;
  readonly source?: unknown;
  readonly status?: unknown;
  readonly stream?: unknown;
  readonly updated_at?: unknown;
}

interface DetailGapProjection {
  readonly gaps: readonly PendingDetailGapSummary[];
  /**
   * The `limit` applied to the pending-gap read. When `gaps.length` reaches it
   * the listing is a bounded page, so any count derived from it (the
   * source-pressure backlog `pending`) is a floor, not an exact total.
   */
  readonly readLimit: number;
  /**
   * Exact count of source-pressure detail gaps in the `recovered` status for
   * this connector, in the same connector-wide + reason scope as the pending
   * read. `null` when no count-by-status aggregate could be run (the store does
   * not expose it, or the aggregate failed) — never a fabricated `0`.
   */
  readonly recovered: number | null;
  /**
   * Exact count of detail gaps in the `terminal` status (§10-A — permanently
   * unfillable). NOT reason-scoped. `null` when unmeasured — never a fabricated
   * `0`. Surfaces the "N no longer retrievable" count so the UI tells the truth
   * about 100% (§6.3).
   */
  readonly terminal: number | null;
  readonly terminalByStream: ReadonlyMap<string, number> | null;
  readonly unreliable: boolean;
}

interface ConnectorDetailGapStoreLike {
  countGapsByStatusByStreamForConnector?: (
    connectorId: string,
    options: { status: string; connectorInstanceId?: string | null }
  ) => Promise<readonly { stream?: unknown; count?: unknown }[]> | readonly { stream?: unknown; count?: unknown }[];
  countGapsByStatusForConnector?: (
    connectorId: string,
    options: { status: string; reasons?: readonly string[] | null; connectorInstanceId?: string | null }
  ) => Promise<number> | number;
  listPendingGaps(input: {
    connectorId: string;
    connectorInstanceId?: string;
    limit?: number;
    now?: string;
  }): Promise<readonly PendingDetailGapSummary[]> | readonly PendingDetailGapSummary[];
  listPendingGapsForConnector?: (
    connectorId: string,
    options?: { limit?: number }
  ) => Promise<readonly PendingDetailGapSummary[]> | readonly PendingDetailGapSummary[];
}

interface ScheduleLike {
  getSchedule(connectorId: string, options?: { readonly connectorInstanceId?: string }): Promise<unknown>;
}

interface ControllerLike {
  getBrowserSurfaceRuntimeAllocatorScopeId?(): string | null;
  getBrowserSurfaceRuntimeManagement?(connectorId: string): BrowserSurfaceRuntimeManagement;
  getSchedule?(connectorId: string): Promise<unknown>;
  observeBrowserSurfaceRuntimeInventory?(): Promise<BrowserSurfaceRuntimeInventorySnapshot>;
}

/**
 * Durable progress evidence sourced from device-side heartbeats and
 * outboxes. Surfaced for local-device connections that bypass
 * `scheduler_run_history` (records are pushed from a device outbox).
 *
 * The dashboard renders these without inventing precision: "last checked: X"
 * for heartbeat evidence and "last ingest: X" for ingest-batch evidence.
 * When no trusted heartbeat row exists for the `connector_instance_id`, the
 * field is `null` and the dashboard falls back to its existing
 * scheduler-based labels.
 *
 * Scoped strictly to `connector_instance_id` to prevent one device's
 * heartbeat from painting another device's pill.
 */
export interface LocalDeviceProgress {
  readonly last_heartbeat_at: string | null;
  readonly last_heartbeat_status: string | null;
  readonly last_ingest_at: string | null;
  /**
   * Connection-level rollup of the per-source outbox diagnostics the
   * device reports on its heartbeats (pending, retrying, stale leases,
   * dead letters, backlog, leased, succeeded, total, and an optional
   * earliest-pending timestamp). Summed across this connection's trusted
   * source instances; `null` when no trusted source reported counts.
   *
   * Owner-only diagnostics. Carries only non-negative integers and an
   * optional ISO timestamp — never a filesystem path, queue name, device
   * token, hostname, or record payload. `records_pending` is the legacy
   * single-number summary; `outbox_counts.pending` is its breakdown peer.
   */
  readonly outbox_counts: OutboxDiagnosticCounts | null;
  readonly records_pending: number | null;
  readonly source_count: number;
}

export interface AcquisitionBatchSummary {
  readonly accepted_count: number | null;
  readonly acquisition_method: string | null;
  readonly batch_id: string;
  readonly date_range: { readonly end: string | null; readonly start: string | null };
  readonly detected_format: string | null;
  readonly duplicate_count: number | null;
  readonly failed_count: number | null;
  readonly media_coverage: unknown;
  readonly parsed_count: number | null;
  readonly skipped_count: number | null;
  readonly status: string;
  readonly uploaded_file_name: string | null;
  readonly warnings: readonly string[];
}

export interface AcquisitionCoverageSummary {
  readonly latest_batch: AcquisitionBatchSummary | null;
  readonly recent_batches: readonly AcquisitionBatchSummary[];
}

export interface ConnectorSummary {
  /**
   * Owner/control-plane acquisition evidence. This is how manual exports,
   * device sync, future backup imports, and browser/API batches stay visible as
   * coverage provenance without changing grant-scoped read surfaces.
   */
  readonly acquisition_coverage: AcquisitionCoverageSummary | null;
  /**
   * Per-stream Collection Report derived on read from the latest run's runtime
   * `collection_facts` block plus this connection's freshness / refresh-policy /
   * attention evidence (`define-connector-progress-evidence-contract`,
   * Tranche C). Owner/control-plane surface only — never on grant-scoped `/v1`.
   * Each entry carries a derived coverage condition and forward disposition; a
   * stream with no declared considered denominator reads `unknown`, never
   * `complete`. Empty when no in-scope stream universe exists.
   */
  readonly collection_report: readonly CollectionReportEntry[];
  readonly connection_health: ConnectionHealthSnapshot;
  readonly connection_id: string;
  readonly connector_display_name: string;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly display_name: string;
  readonly freshness: Freshness;
  readonly last_run: ConnectorRunSummary | null;
  readonly last_successful_run: ConnectorRunSummary | null;
  /**
   * Push-mode (local-device exporter) durable progress evidence. `null`
   * for scheduler-managed connections and for local-device connections
   * with no trusted heartbeat row yet.
   */
  readonly local_device_progress: LocalDeviceProgress | null;
  /**
   * The manifest-declaration evidence component from the maintained
   * connector-summary evidence row (design.md "Orthogonal projection
   * evidence"): `current` when the stored connector manifest was
   * successfully parsed with a non-empty streams array, `unavailable` when
   * it is missing/malformed. Feeds `ProjectionReliable` when non-current.
   * Spec: openspec/changes/reconcile-active-summary-evidence.
   */
  readonly manifest_declaration: {
    readonly state: "current" | "unavailable" | "failed";
    readonly as_of: string | null;
    readonly reason_code: string | null;
  };
  readonly manifest_version: string | null;
  /**
   * The record-snapshot evidence component from the maintained
   * connector-summary evidence row (design.md "Orthogonal projection
   * evidence"): `current` once the canonical-records checkpoint this row's
   * stream_records/total_records were computed against matches the live
   * checkpoint. Feeds `ProjectionReliable` when non-current.
   * Spec: openspec/changes/reconcile-active-summary-evidence.
   */
  readonly record_snapshot: {
    readonly state: "current" | "unobserved" | "stale" | "failed";
    readonly as_of: string | null;
    readonly reason_code: string | null;
  };
  /**
   * The terminal-facts evidence component from the maintained
   * connector-summary evidence row (design.md "Orthogonal projection
   * evidence"): `unobserved` before any completed fold pass;
   * `current` once checkpointed, including an honestly-empty terminal
   * history (never conflated with "never observed"). Feeds
   * `ProjectionReliable` when non-current.
   * Spec: openspec/changes/reconcile-active-summary-evidence.
   */
  readonly terminal_facts: {
    readonly state: "current" | "unobserved" | "stale" | "failed";
    readonly event_seq: number | null;
    readonly as_of: string | null;
    readonly reason_code: string | null;
  };
  /**
   * Top-level mirror of `connection_health.next_action`. Mirrored at the
   * row level so the dashboard list view does not have to peer inside
   * the health snapshot to render a CTA chip. `null` when the
   * connection does not need owner action.
   */
  readonly next_action: NextAction | null;
  /**
   * The one closed owner-facing state for this source (Wave 10a, 2026-07-09
   * state-model convergence). Derived from `rendered_verdict` and `schedule`
   * by `deriveOwnerState` (`owner-state.ts`); console surfaces consume this
   * instead of re-deriving their own status/actionability taxonomy.
   * `resolver` is a closed server-side contract, never owner-facing copy.
   */
  readonly owner_state: OwnerState;
  readonly refresh_policy: unknown;
  /**
   * Synthesized owner verdict — the single object every owner-facing surface
   * renders. Computed server-side by `synthesizeConnectorVerdict`; forwarded
   * verbatim alongside `connection_health` exactly as the design specifies.
   * `detail` and `trace` are owner-only; use `toGrantScopedVerdict` before
   * forwarding to grant-scoped clients.
   */
  readonly rendered_verdict: RenderedVerdict;
  /**
   * Storage bytes by retention class. `total_retained_bytes` is kept for
   * compatibility; this breakdown lets the operator distinguish current live
   * records from retained change history.
   */
  readonly retained_bytes?: RetainedBytesBreakdown | null;
  /**
   * The retained-bytes evidence component from the maintained
   * connector-summary evidence row (design.md "Orthogonal projection
   * evidence"): `current` when a clean, current `retained_size_connection`
   * row backs `retained_bytes` above; `unobserved`/`stale`/`failed`
   * otherwise, in which case `retained_bytes` reads `null` rather than a
   * fabricated value. Unlike `manifest_declaration`/`record_snapshot`/
   * `terminal_facts`, this component does NOT feed `ProjectionReliable`
   * (design.md "Health boundary": retained-byte failure makes byte fields
   * unavailable but never by itself degrades connection health).
   * Spec: openspec/changes/reconcile-active-summary-evidence.
   */
  readonly retained_bytes_evidence: {
    readonly state: "current" | "unobserved" | "stale" | "failed";
    readonly as_of: string | null;
    readonly reason_code: string | null;
  };
  /** Durable connector-instance lifecycle state. Revoked rows remain owner-visible. */
  readonly revoked_at: string | null;
  readonly schedule: unknown;
  readonly source_binding_kind: string | null;
  /**
   * The connection's source kind and non-secret source-binding kind. Owner
   * surfaces route repair BINDING-FIRST from this: a browser-session binding
   * (`browser_collector`/`browser_enrollment_shell`) repairs by browser/session
   * repair, not static-secret credential capture, even when the connector also
   * supports a static secret. Connection-scoped fact, not a connector capability.
   */
  readonly source_kind: string;
  readonly status: string | null;
  readonly stream_count?: number;
  /**
   * Retained record totals by stream, derived from the retained-size projection
   * already loaded for the connector summary. Owner/control-plane surface only;
   * this is "what data is here", distinct from `collection_report`, which is
   * latest-run coverage/progress evidence.
   */
  readonly stream_records: readonly StreamRecordSummary[];
  readonly streams: string[];
  readonly total_records: number;
  /**
   * Orthogonal state for `total_records`, the same `count_state` contract
   * `StreamRecordSummary` already applies per-stream (Sol P1.3): when the
   * observation barrier's evidence row is `record_snapshot.state !==
   * "current"`, the stored `total_records` value predates the failure —
   * kept as a non-authoritative hint (never nulled/zeroed), but this field
   * reads `"stale"` rather than `"known"`/`"known_zero"` so a consumer
   * never renders a failed snapshot's carried-over number as an
   * authoritative exact count. Optional so existing non-evidence-backed
   * callers of this shape are unaffected; `projectConnectorSummaryForInstance`
   * always populates it when the observation barrier produced an evidence
   * row (`"known"`/`"known_zero"` when current, `"stale"` when not,
   * `"unobserved"` when no evidence row exists yet).
   */
  readonly total_records_state?: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
  readonly total_retained_bytes?: number | null;
}

export interface ConnectorDetail {
  readonly acquisition_coverage: AcquisitionCoverageSummary | null;
  /** See {@link ConnectorSummary.collection_report}. Derived on read on the detail surface too. */
  readonly collection_report: readonly CollectionReportEntry[];
  /**
   * `null` when `connection_resolution` is not `"resolved"` — design.md
   * "Central consumer and cache boundary" requires the zero/ambiguous
   * catalog detail to OMIT connection health, never fabricate a connector-
   * wide or zeroed snapshot. A consumer must treat `null` here as "no single
   * connection's health is resolvable," not as an absence of any problem.
   */
  readonly connection_health: ConnectionHealthSnapshot | null;
  readonly connection_id: string;
  /**
   * How this connector-keyed detail resolved to an owner connection
   * (design.md "Central consumer and cache boundary"): `resolved` when
   * exactly one connection exists for this connector_id, so every other
   * field below reflects that single connection's barrier-backed
   * evidence. `unresolved` when the connector is registered but the owner
   * has zero connections for it yet (a normal, common state — e.g. right
   * after registering a connector, before connecting). `ambiguous` when 2+
   * connections share this connector_id and none is addressed
   * unambiguously. `unresolved`/`ambiguous` OMIT per-connection health/counts
   * (`connection_health`/`total_records` read `null`) rather than merging
   * sibling evidence or fabricating a zero count — zero is a real count
   * claim, not the same thing as "unresolvable." `streams` is NOT emptied:
   * declared stream NAMES are a connector-level catalog fact owned by the
   * registered manifest, not per-connection evidence, so they still appear
   * (each entry's own `record_count` reads `null`, the genuinely
   * per-connection fact — see `buildUnresolvedConnectorDetail`).
   */
  readonly connection_resolution: "resolved" | "unresolved" | "ambiguous";
  readonly connector_id: string;
  readonly display_name: string;
  readonly freshness: Freshness;
  readonly last_run: ConnectorRunSummary | null;
  readonly last_successful_run: ConnectorRunSummary | null;
  readonly manifest_excerpt: ManifestExcerpt;
  readonly manifest_version: string | null;
  /** See `ConnectorSummary.next_action`. `null` also when `connection_health` is `null`. */
  readonly next_action: NextAction | null;
  readonly object: "ref_connector_detail";
  /** See {@link ConnectorSummary.owner_state}. `null` when `connection_resolution` is not `"resolved"`. */
  readonly owner_state: OwnerState | null;
  readonly recent_runs: ConnectorRunSummary[];
  /** See {@link ConnectorSummary.rendered_verdict}. `null` when `connection_resolution` is not `"resolved"`. */
  readonly rendered_verdict: RenderedVerdict | null;
  readonly schedule: unknown;
  // Detail carries richer per-stream projection; the list surface
  // (ConnectorSummary) only needs the stream name array. Empty when
  // `connection_resolution` is not `"resolved"` — omitted, not zeroed.
  readonly streams: StreamSummary[];
  /** `null` when `connection_resolution` is not `"resolved"` — see the field's doc above. */
  readonly total_records: number | null;
  /**
   * Orthogonal state for `total_records` — see
   * {@link ConnectorSummary.total_records_state}. `"unobserved"` for the
   * unresolved/ambiguous detail shape (no per-connection evidence to have a
   * state at all), matching `total_records: null` there.
   */
  readonly total_records_state: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
}

interface PendingConsentRow {
  readonly approval_id: string | null;
  readonly created_at: string;
  readonly device_code: string;
  readonly params_json: string;
  readonly user_code: string;
}

interface PendingOwnerDeviceRow {
  readonly approval_id: string | null;
  readonly client_id: string;
  readonly created_at: string;
  readonly device_code: string;
  readonly user_code: string;
}

interface ConsentRequestEnvelope {
  client?: { client_id?: string };
  selection?: {
    access_mode?: string;
    purpose_code?: string;
    purpose_description?: string;
    streams?: unknown[];
  };
  source_binding?: { kind?: string; id?: string };
}

interface SourcePreview {
  readonly id: string;
  readonly kind: "connector" | "provider_native";
}

interface ConsentApproval {
  readonly approval_id: string;
  readonly client_id: string | null;
  readonly created_at: string;
  readonly grant_preview: {
    readonly access_mode: string | null;
    readonly purpose_code: string | null;
    readonly purpose_description: string | null;
    readonly source: SourcePreview | null;
    readonly streams: unknown[];
  };
  readonly kind: "consent";
  readonly object: "approval";
  // request_uri is intentionally projected as null on the operator console.
  // The canonical request_uri embeds the live device_code, which (via
  // `/consent/approve`) is bearer-equivalent. Owner approve/deny flows
  // resolve approval_id -> device_code on the AS side.
  readonly request_uri: null;
  // user_code is intentionally NOT projected. It is the human verifier
  // shown during the device flow and combined with owner-session auth
  // becomes part of the takeover chain. The dashboard's owner approve/deny
  // path uses approval_id instead.
  readonly user_code: null;
}

interface OwnerDeviceApproval {
  readonly approval_id: string;
  readonly client_id: string;
  readonly created_at: string;
  readonly grant_preview: null;
  readonly kind: "owner_device";
  readonly object: "approval";
  readonly request_uri: null;
  readonly user_code: null;
}

type Approval = ConsentApproval | OwnerDeviceApproval;

export interface TimelineOptions {
  connectorId?: string | null;
  limit?: number;
  order?: "asc" | "desc";
  since?: string | null;
  stream?: string | null;
  timestampMode?: "emitted" | "native";
  until?: string | null;
}

export interface TimelineEntry {
  readonly connector_id: string;
  readonly data: unknown;
  readonly display_timestamp: string;
  readonly emitted_at: string;
  readonly id: string;
  readonly object: "timeline_entry";
  readonly semantic_timestamp: SemanticTimestamp | null;
  readonly stream: string;
  readonly version: number | null;
}

export interface TimelineResponse {
  readonly data: TimelineEntry[];
  readonly meta: {
    readonly bounded: true;
    readonly filters: {
      readonly connector_id: string | null;
      readonly since: string | null;
      readonly stream: string | null;
      readonly until: string | null;
    };
    readonly limit: number;
    readonly ordering: string;
    readonly timestamp_mode: "emitted" | "native";
  };
  readonly object: "list";
}

// ─── Named controller-plane errors ──────────────────────────────────────────

export class RefControlError extends Error {
  readonly code: "connector_invalid" | "not_found";
  constructor(message: string, code: "connector_invalid" | "not_found") {
    super(message);
    this.code = code;
    this.name = "RefControlError";
  }
}

function parseManifest(raw: string, connectorId: string): ConnectorManifest {
  try {
    return JSON.parse(raw) as ConnectorManifest;
  } catch {
    throw new RefControlError(
      `Connector manifest for ${connectorId} is malformed or no longer valid`,
      "connector_invalid"
    );
  }
}

/**
 * The manifest-declaration result the connector-summary synthesis path
 * needs: whether the CURRENT stored manifest parsed successfully, plus a
 * safe manifest to synthesize against either way. A malformed/unparseable
 * manifest is a real, honest fact about this connection — never a reason
 * to silently drop it from the owner's summary list (design.md "Orthogonal
 * projection evidence": manifest_declaration is independent of every other
 * axis, including whether the connection is otherwise visible).
 */
interface SummaryManifestResolution {
  readonly manifest: ConnectorManifest;
  readonly declarationState: "current" | "unavailable";
  readonly reasonCode: string | null;
}

/**
 * Parse a connector's raw manifest text for connector-summary synthesis,
 * WITHOUT throwing. On success, `declarationState: "current"` and the real
 * parsed manifest. On failure, `declarationState: "unavailable"` and a safe
 * EMPTY manifest placeholder (`{}` — every `ConnectorManifest` field is
 * optional) — never a fabricated capability. Every capability-dependent
 * consumer downstream already reads `manifest.streams ?? []`,
 * `manifest.capabilities?.x`, etc., so an empty placeholder fails those
 * fields closed (empty streams, no capabilities) rather than crashing or
 * inventing a plausible-looking manifest.
 */
function resolveSummaryManifest(raw: string): SummaryManifestResolution {
  try {
    const manifest = JSON.parse(raw) as ConnectorManifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return {
        manifest: {},
        declarationState: "unavailable",
        reasonCode: "manifest_invalid",
      };
    }
    return { manifest, declarationState: "current", reasonCode: null };
  } catch {
    return {
      manifest: {},
      declarationState: "unavailable",
      reasonCode: "manifest_unavailable",
    };
  }
}

function buildFreshness(lastUpdated: string | null = null): Freshness {
  return deriveReferenceFreshness({ recordLastUpdatedAt: lastUpdated });
}

interface RunTerminalEventRow {
  readonly data_json: string | null;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly status: string;
}

/**
 * Read a run's terminal-event payload (the `run.completed` / `run.failed` /
 * `run.browser_surface_failed` / `run.cancelled` spine event) without scanning the run's full event list. The
 * single SQL lookup is bounded by the SQL `LIMIT 1` clause; for runs without a
 * terminal event yet (still in progress, or controller_restarted), returns
 * `null`.
 *
 * This is the single read both `known_gaps` and the runtime `collection_facts`
 * block (the Tranche B per-stream fact block) ride on, so the projection reads
 * the terminal payload once rather than issuing two spine queries.
 */
async function readRunTerminalEventData(runId: string): Promise<Record<string, unknown> | null> {
  const row = isPostgresStorageBackend()
    ? ((
        await postgresQuery(
          `SELECT data_json::text AS data_json, event_type, occurred_at, status
         FROM spine_events
         WHERE run_id = $1
           AND (event_type = 'run.completed'
                OR event_type = 'run.failed'
                OR event_type = 'run.browser_surface_failed'
                OR event_type = 'run.cancelled')
         ORDER BY event_seq DESC
         LIMIT 1`,
          [runId]
        )
      ).rows[0] as RunTerminalEventRow | undefined)
    : getOne<RunTerminalEventRow>(referenceQueries.spineGetRunTerminalEvent, [runId]);
  if (!row?.data_json) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data_json);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
}

function readKnownGapsFromTerminalData(data: Record<string, unknown> | null): unknown[] {
  if (data && Array.isArray(data.known_gaps)) {
    return data.known_gaps;
  }
  return [];
}

/**
 * Read the latest adaptive collection rate controller snapshot for a run.
 *
 * For completed runs the snapshot is stamped on the terminal event by the
 * runtime (`buildRunTerminalData`), so we read it from there with no extra
 * query. For in-progress runs (no terminal event yet) we fall back to the
 * most recent `run.progress_reported` spine event that carries a
 * `collection_rate` payload. Returns `null` when no rate evidence exists
 * (controller never fired a rate-change transition, or the run predates the
 * adaptive rate controller).
 */
async function readLatestCollectionRateForRun(
  runId: string,
  terminalData: Record<string, unknown> | null
): Promise<CollectionRateSnapshot | null> {
  // Fast path: terminal event already carries the final rate snapshot.
  if (terminalData != null) {
    return parseCollectionRatePayload(terminalData.collection_rate);
  }
  // Slow path: run still in progress — query the latest progress event.
  const row = isPostgresStorageBackend()
    ? ((
        await postgresQuery(
          `SELECT data_json::text AS data_json
           FROM spine_events
           WHERE run_id = $1
             AND event_type = 'run.progress_reported'
             AND data_json::jsonb ? 'collection_rate'
           ORDER BY event_seq DESC
           LIMIT 1`,
          [runId]
        )
      ).rows[0] as { data_json?: string } | undefined)
    : getOne<{ data_json?: string }>(referenceQueries.spineGetRunLatestCollectionRateEvent, [runId]);
  if (!row?.data_json) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data_json);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parseCollectionRatePayload((parsed as Record<string, unknown>).collection_rate);
  }
  return null;
}

async function toConnectorRunSummary(summary: SpineSummary | null): Promise<ConnectorRunSummary | null> {
  if (!summary) {
    return null;
  }
  const runId = summary.id || summary.run_id || null;
  const terminalData = runId ? await readRunTerminalEventData(runId) : null;
  const terminalReason =
    terminalData && typeof terminalData.reason === "string" && terminalData.reason.length > 0
      ? terminalData.reason
      : null;
  const browserSurfaceFailureReason =
    summary.status === "surface_failed"
      ? summary.browser_surface_wait_reason || summary.browser_surface_status || "browser_surface_failed"
      : null;
  return {
    run_id: runId || undefined,
    status: summary.status,
    started_at: summary.first_at,
    finished_at: isActiveRunSummaryStatus(summary.status) ? null : summary.last_at,
    first_at: summary.first_at,
    last_at: summary.last_at,
    event_count: summary.event_count,
    failure_reason: summary.failure?.reason || browserSurfaceFailureReason,
    terminal_reason: terminalReason,
    recovery_only: terminalData?.recovery_only === true,
    known_gaps: readKnownGapsFromTerminalData(terminalData),
    collection_facts: readCollectionFactsFromTerminalData(terminalData),
  };
}

async function schedulerRunHistoryToConnectorRunSummary(
  history: SchedulerRunHistoryRecord | null
): Promise<ConnectorRunSummary | null> {
  if (!history) {
    return null;
  }
  const runId = history.runId || null;
  const terminalData = runId ? await readRunTerminalEventData(runId) : null;
  const terminalReason =
    terminalData && typeof terminalData.reason === "string" && terminalData.reason.length > 0
      ? terminalData.reason
      : (history.terminalReason ?? null);
  const terminalKnownGaps = readKnownGapsFromTerminalData(terminalData);
  return {
    run_id: runId || undefined,
    status: history.status,
    started_at: history.startedAt,
    finished_at: history.completedAt,
    first_at: history.startedAt,
    last_at: history.completedAt,
    event_count: 0,
    failure_reason: history.failureReason ?? history.error ?? null,
    terminal_reason: terminalReason,
    recovery_only: terminalData?.recovery_only === true,
    known_gaps: terminalKnownGaps.length > 0 ? terminalKnownGaps : [...history.knownGaps],
    collection_facts: readCollectionFactsFromTerminalData(terminalData),
  };
}

function isActiveRunSummaryStatus(status: string): boolean {
  return status === "pending" || status === "started" || status === "in_progress";
}

function runSummaryMatchesConnection(
  summary: SpineSummary,
  connectorInstanceId: string,
  browserSurfaceProfileKey: string | null
): boolean {
  if (summary.browser_surface_profile_key) {
    return summary.browser_surface_profile_key === (browserSurfaceProfileKey ?? connectorInstanceId);
  }

  const data = summary as SpineSummary & { connector_instance_id?: unknown; connection_id?: unknown };
  return data.connector_instance_id === connectorInstanceId || data.connection_id === connectorInstanceId;
}

export function canUseConnectorWideRunSummaryFallback(input: {
  readonly activeVisibleConnectionCount: number;
  readonly browserSurfaceProfileKey: string | null;
  readonly connectorInstanceId: string;
  readonly summary: SpineSummary;
}): boolean {
  if (input.activeVisibleConnectionCount !== 1) {
    return false;
  }
  if (runSummaryMatchesConnection(input.summary, input.connectorInstanceId, input.browserSurfaceProfileKey)) {
    return true;
  }
  // Browser-backed runs carry a profile key when the runtime knows which
  // browser identity produced the run. A mismatched profile belongs to a sibling
  // or an expired setup shell and must not be borrowed by a singleton fallback.
  if (input.summary.browser_surface_profile_key) {
    return false;
  }
  // Legacy API/static/manual connectors often emitted connector-wide run events
  // before connection_id existed on the spine. When there is exactly one active
  // visible connection for that connector type, the connector-wide run is the
  // only honest source of last-run/freshness evidence for that row.
  return true;
}

async function getLatestRunSummaryForConnection({
  activeVisibleConnectionCount,
  browserSurfaceProfileKey,
  connectorId,
  connectorInstanceId,
  getLatestRunHistoryForConnection,
  listRunSummariesForConnector,
  status = null,
}: {
  readonly activeVisibleConnectionCount: number;
  readonly browserSurfaceProfileKey: string | null;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly getLatestRunHistoryForConnection: ConnectorSummaryProjectionDeps["getLatestRunHistoryForConnection"];
  readonly listRunSummariesForConnector: ConnectorSummaryProjectionDeps["listRunSummariesForConnector"];
  readonly status?: string | null;
}): Promise<ConnectorRunSummary | null> {
  const summaries = await listRunSummariesForConnector(connectorId, status);
  const match = summaries.find((summary) =>
    runSummaryMatchesConnection(summary, connectorInstanceId, browserSurfaceProfileKey)
  );
  if (match) {
    return toConnectorRunSummary(match);
  }
  const schedulerHistory = await getLatestRunHistoryForConnection(connectorInstanceId, status);
  if (schedulerHistory) {
    return schedulerRunHistoryToConnectorRunSummary(schedulerHistory);
  }
  const fallback =
    summaries.find((summary) =>
      canUseConnectorWideRunSummaryFallback({
        activeVisibleConnectionCount,
        browserSurfaceProfileKey,
        connectorInstanceId,
        summary,
      })
    ) ?? null;
  return toConnectorRunSummary(fallback);
}

// A connection's retained-size projection is reliable evidence for synthesizing
// an exact zero for a declared-but-absent stream only when its maintained
// `retained_size_connection` row exists, is not mid-flight dirty, and has
// computed at least once. A missing row (never ingested/never rebuilt) or a
// dirty row (a write landed and reconcile/rebuild has not caught up) must NOT
// be treated as proof of absence — the stream's true state stays unmeasured.
function isRetainedSizeConnectionReliable(row: RetainedSizeConnectionProjectionRow | undefined): boolean {
  return row != null && row.dirty !== true && row.computed_at != null;
}

async function getRetainedSizeConnectionRow(
  connectorInstanceId: string
): Promise<RetainedSizeConnectionProjectionRow | undefined> {
  return (await listRetainedSizeConnections({ connectorInstanceId }))[0] as
    | RetainedSizeConnectionProjectionRow
    | undefined;
}

function retainedBytesFromConnectionRow(
  row: RetainedSizeConnectionProjectionRow | undefined
): RetainedBytesBreakdown | null {
  if (!row) {
    return null;
  }
  const recordJsonBytes = Number(row.current_record_json_bytes || 0);
  const recordChangesJsonBytes = Number(row.record_history_json_bytes || 0);
  const blobBytes = Number(row.blob_bytes || 0);
  return {
    blob_bytes: blobBytes,
    record_changes_json_bytes: recordChangesJsonBytes,
    record_json_bytes: recordJsonBytes,
    total_bytes: recordJsonBytes + recordChangesJsonBytes + blobBytes,
  };
}

function buildRecordProjectionFromRetainedRows(input: {
  readonly retainedBytes: RetainedBytesBreakdown | null;
  readonly retainedSizeReliable: boolean;
  readonly rows: readonly RecordProjectionRow[];
}): RecordProjection {
  const byStream = new Map<string, StreamProjection>();
  let latest: string | null = null;
  for (const row of input.rows) {
    const recordCount = Number(row.record_count || 0);
    const lastUpdated = row.last_updated || null;
    byStream.set(row.stream, {
      record_count: recordCount,
      last_updated: lastUpdated,
      freshness: buildFreshness(lastUpdated),
    });
    if (lastUpdated && (!latest || lastUpdated > latest)) {
      latest = lastUpdated;
    }
  }
  return {
    byStream,
    freshness: buildFreshness(latest),
    retainedBytes: input.retainedBytes,
    retainedSizeReliable: input.retainedSizeReliable,
    totalRecords: input.rows.reduce((sum, row) => sum + Number(row.record_count || 0), 0),
  };
}

function projectStreamRecordSummaries(byStream: ReadonlyMap<string, StreamProjection>): StreamRecordSummary[] {
  return [...byStream.entries()]
    .map(([stream, projection]) => ({
      stream,
      record_count: projection.record_count,
      last_updated: projection.last_updated,
    }))
    .sort((a, b) => a.stream.localeCompare(b.stream));
}

// `retained_size_stream` is sparse: a row exists only for a stream that has
// ever been written, so a manifest-declared stream that genuinely has zero
// records is indistinguishable, at the storage layer, from one that has never
// been measured. Synthesizing an exact `record_count: 0` entry is only honest
// when the connection's retained-size projection is PROVEN fresh and clean
// (`retainedSizeReliable`) — otherwise the declared stream stays absent from
// the result, exactly like today, so existing owner-console rendering keeps
// treating an absent entry as unavailable rather than a fabricated zero.
//
// This only ever ADDS entries; it never changes a real (possibly zero, e.g.
// post-delete) retained row already present in `byStream`, and it never feeds
// back into `stream_count`/`totalRecords`, which stay tied to actual retained
// evidence.
function projectStreamRecordSummariesWithDeclaredZeros(
  byStream: ReadonlyMap<string, StreamProjection>,
  manifestStreams: readonly { readonly name?: string }[] | undefined,
  retainedSizeReliable: boolean
): StreamRecordSummary[] {
  const summaries = projectStreamRecordSummaries(byStream);
  if (!(retainedSizeReliable && manifestStreams) || manifestStreams.length === 0) {
    return summaries;
  }
  const present = new Set(summaries.map((entry) => entry.stream));
  const synthesized = manifestStreams
    .map((stream) => stream.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0 && !present.has(name))
    .map((name) => ({ stream: name, record_count: 0, last_updated: null }));
  if (synthesized.length === 0) {
    return summaries;
  }
  return [...summaries, ...synthesized].sort((a, b) => a.stream.localeCompare(b.stream));
}

async function getConnectorRecordProjection(
  connectorId: string,
  connectorInstanceId?: string,
  snapshot?: RetainedSizeProjectionSnapshot
): Promise<RecordProjection> {
  let rows: RecordProjectionRow[];
  if (connectorInstanceId && snapshot) {
    const connectionRow = snapshot.connectionsByInstanceId.get(connectorInstanceId);
    rows = [...(snapshot.streamsByInstanceId.get(connectorInstanceId) ?? [])];
    return buildRecordProjectionFromRetainedRows({
      rows,
      retainedBytes: retainedBytesFromConnectionRow(connectionRow),
      retainedSizeReliable: isRetainedSizeConnectionReliable(connectionRow),
    });
  }
  if (!connectorInstanceId && snapshot) {
    rows = [...(snapshot.streamsByConnectorId.get(connectorId) ?? [])];
    // No single connection is in scope for a connector-wide (not instance-scoped)
    // read, so there is no one connection row to vouch for a synthesized zero.
    return buildRecordProjectionFromRetainedRows({ rows, retainedBytes: null, retainedSizeReliable: false });
  }
  if (connectorInstanceId) {
    rows = (await listRetainedSizeStreams({ connectorInstanceId })).map(
      (row: { connector_id?: string; connector_instance_id?: string; stream: string; record_count?: number }) => ({
        connector_id: row.connector_id,
        connector_instance_id: row.connector_instance_id,
        stream: row.stream,
        record_count: Number(row.record_count || 0),
        last_updated: null,
      })
    ) as RecordProjectionRow[];
  } else {
    rows = (await listRetainedSizeStreams({}))
      .filter((row: { connector_id?: string }) => row.connector_id === connectorId)
      .map((row: { connector_id?: string; connector_instance_id?: string; stream: string; record_count?: number }) => ({
        connector_id: row.connector_id,
        connector_instance_id: row.connector_instance_id,
        stream: row.stream,
        record_count: Number(row.record_count || 0),
        last_updated: null,
      })) as RecordProjectionRow[];
  }
  const connectionRow = connectorInstanceId ? await getRetainedSizeConnectionRow(connectorInstanceId) : undefined;
  return buildRecordProjectionFromRetainedRows({
    rows,
    retainedBytes: retainedBytesFromConnectionRow(connectionRow),
    retainedSizeReliable: connectorInstanceId ? isRetainedSizeConnectionReliable(connectionRow) : false,
  });
}

interface AttentionStoreProjection {
  readonly records: readonly AttentionRecord[];
  readonly unreliable: boolean;
}

interface ConnectorAttentionStoreLike {
  expireDueAttentionForConnection?(input: {
    connectorId: string;
    connectorInstanceId?: string;
    limit?: number;
    now?: string;
  }): Promise<readonly AttentionRecord[]> | readonly AttentionRecord[];
  listOpenAttentionForConnection(input: {
    connectorId: string;
    connectorInstanceId?: string;
    limit?: number;
  }): Promise<readonly AttentionRecord[]> | readonly AttentionRecord[];
}

/**
 * Bounded read for the durable structured-attention store keyed by
 * connector id (and, when available, connector_instance_id).
 *
 * Returns `{ records, unreliable: false }` when the read succeeded —
 * including when the store has no open attention rows. Returns
 * `{ records: [], unreliable: true }` when the underlying store throws,
 * so callers must mark the projection as `unreliable` to avoid a false
 * healthy when attention evidence cannot be read.
 */
export async function getConnectorAttentionProjection(
  connectorId: string,
  options: { readonly connectorInstanceId?: string } = {}
): Promise<AttentionStoreProjection> {
  try {
    const store = getDefaultConnectorAttentionStore() as ConnectorAttentionStoreLike;
    const now = new Date().toISOString();
    const request: { connectorId: string; connectorInstanceId?: string; limit?: number } = {
      connectorId,
      limit: 50,
    };
    if (options.connectorInstanceId !== undefined) {
      request.connectorInstanceId = options.connectorInstanceId;
    }
    try {
      await Promise.resolve(
        store.expireDueAttentionForConnection?.({
          ...request,
          limit: 200,
          now,
        })
      );
    } catch {
      // The read path already filters expired rows. A hygiene-write failure must
      // not turn an otherwise reliable read into an owner-facing unknown state.
    }
    const records = await Promise.resolve(store.listOpenAttentionForConnection(request));
    return { records, unreliable: false };
  } catch {
    return { records: [], unreliable: true };
  }
}

/**
 * Bound applied to the pending-gap read in {@link getConnectorDetailGapProjection}.
 * Shared with the source-pressure backlog rollup so the projection can mark its
 * `pending` count as a floor when the read hits this bound, rather than
 * presenting a bounded page as an exact total.
 */
const DETAIL_GAP_PROJECTION_LIMIT = 100;

async function getConnectorDetailGapProjection(
  connectorId: string,
  connectorInstanceId?: string
): Promise<DetailGapProjection> {
  try {
    const store = getDefaultConnectorDetailGapStore() as ConnectorDetailGapStoreLike;
    // Console rollups need connector-wide gaps; the single-instance read can
    // hide local-collector gaps from non-default devices.
    let gaps: readonly PendingDetailGapSummary[];
    if (connectorInstanceId) {
      gaps = await Promise.resolve(
        store.listPendingGaps({ connectorId, connectorInstanceId, limit: DETAIL_GAP_PROJECTION_LIMIT })
      );
    } else if (typeof store.listPendingGapsForConnector === "function") {
      gaps = await Promise.resolve(
        store.listPendingGapsForConnector(connectorId, {
          limit: DETAIL_GAP_PROJECTION_LIMIT,
        })
      );
    } else {
      gaps = await Promise.resolve(store.listPendingGaps({ connectorId, limit: DETAIL_GAP_PROJECTION_LIMIT }));
    }
    return {
      gaps,
      readLimit: DETAIL_GAP_PROJECTION_LIMIT,
      recovered: await getRecoveredSourcePressureGapCount(store, connectorId, connectorInstanceId),
      terminal: await getTerminalGapCount(store, connectorId, connectorInstanceId),
      terminalByStream: await getTerminalGapCountsByStream(store, connectorId, connectorInstanceId),
      unreliable: false,
    };
  } catch {
    return {
      gaps: [],
      readLimit: DETAIL_GAP_PROJECTION_LIMIT,
      recovered: null,
      terminal: null,
      terminalByStream: null,
      unreliable: true,
    };
  }
}

/**
 * Optional `recovered` count for the source-pressure backlog rollup: an exact,
 * reason-scoped, connector-wide count of detail gaps that have reached the
 * `recovered` status. This is the count-by-status analogue of the pending read
 * — same connector scope, same `SOURCE_PRESSURE_GAP_REASONS` reason scope —
 * and returns only a scalar integer (no row bodies, locators, or payloads).
 *
 * `null` means unmeasured, not zero, so the dashboard does not invent recovery
 * evidence when the aggregate is unavailable.
 */
async function getRecoveredSourcePressureGapCount(
  store: ConnectorDetailGapStoreLike,
  connectorId: string,
  connectorInstanceId?: string
): Promise<number | null> {
  if (typeof store.countGapsByStatusForConnector !== "function") {
    return null;
  }
  try {
    const recovered = await Promise.resolve(
      store.countGapsByStatusForConnector(connectorId, {
        status: "recovered",
        connectorInstanceId: connectorInstanceId ?? null,
        reasons: [...SOURCE_PRESSURE_GAP_REASONS],
      })
    );
    return typeof recovered === "number" && Number.isFinite(recovered) && recovered >= 0 ? Math.floor(recovered) : null;
  } catch {
    return null;
  }
}

/**
 * Optional `terminal` count (§10-A) for the backlog rollup: an exact,
 * connector-wide count of detail gaps in the `terminal` status (permanently
 * unfillable — 404/410/permanent error, recovery budget exhausted). Unlike
 * `recovered`, this is NOT reason-scoped: a gap becomes terminal because of a
 * non-transient HTTP error regardless of its original defer reason, so the
 * honest "N no longer retrievable" count (§6.3) spans all terminal gaps.
 * `null` means unmeasured, never a fabricated zero.
 */
async function getTerminalGapCount(
  store: ConnectorDetailGapStoreLike,
  connectorId: string,
  connectorInstanceId?: string
): Promise<number | null> {
  if (typeof store.countGapsByStatusForConnector !== "function") {
    return null;
  }
  try {
    const terminal = await Promise.resolve(
      store.countGapsByStatusForConnector(connectorId, {
        status: "terminal",
        connectorInstanceId: connectorInstanceId ?? null,
      })
    );
    return typeof terminal === "number" && Number.isFinite(terminal) && terminal >= 0 ? Math.floor(terminal) : null;
  } catch {
    return null;
  }
}

async function getTerminalGapCountsByStream(
  store: ConnectorDetailGapStoreLike,
  connectorId: string,
  connectorInstanceId?: string
): Promise<ReadonlyMap<string, number> | null> {
  if (typeof store.countGapsByStatusByStreamForConnector !== "function") {
    return null;
  }
  try {
    const rows = await Promise.resolve(
      store.countGapsByStatusByStreamForConnector(connectorId, {
        status: "terminal",
        connectorInstanceId: connectorInstanceId ?? null,
      })
    );
    const map = new Map<string, number>();
    for (const row of rows) {
      const stream = typeof row?.stream === "string" ? row.stream : "";
      const count = typeof row?.count === "number" ? row.count : Number(row?.count);
      if (!(stream && Number.isFinite(count)) || count <= 0) {
        continue;
      }
      map.set(stream, Math.floor(count));
    }
    return map;
  } catch {
    return null;
  }
}

function buildManifestExcerpt(manifest: ConnectorManifest): ManifestExcerpt {
  return {
    connector_id: manifest.connector_id,
    display_name: manifest.display_name || manifest.connector_id || "",
    version: manifest.version,
    protocol_version: manifest.protocol_version || null,
    profile_ids: Array.isArray(manifest.profiles) ? manifest.profiles.map((profile) => profile.id) : [],
  };
}

function buildStreamSummary(
  stream: { name: string; semantics?: string },
  live: {
    readonly freshness?: Freshness;
    readonly last_updated: string | null;
    readonly record_count: number | null;
    readonly count_state?: "known" | "known_zero" | "unobserved" | "stale" | "unknown" | undefined;
  } | null = null,
  connectorFreshness: Freshness | null = null
): StreamSummary {
  return {
    object: "stream",
    name: stream.name,
    semantics: stream.semantics || null,
    // `live` absent (no evidence row) is genuinely unknown, never a
    // fabricated 0 — only a real, present `live.record_count` value
    // (including a real 0) is passed through as-is.
    record_count: live ? live.record_count : null,
    count_state: live ? (live.count_state ?? "unobserved") : "unobserved",
    last_updated: live?.last_updated || null,
    freshness: connectorFreshness || live?.freshness || { status: "unknown" },
  };
}

async function listRegisteredConnectorRows(): Promise<readonly ConnectorRow[]> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT connector_id, manifest::text AS manifest
       FROM connectors
       ORDER BY connector_id`
    );
    return result.rows as ConnectorRow[];
  }
  // REVIEWED-BOUNDED: connectors table is O(registered providers); whole-table scan is acceptable.
  return allowUnboundedReadAcknowledged<ConnectorRow>(referenceQueries.listRegisteredConnectors);
}

function getConnectorInstanceStore() {
  return isPostgresStorageBackend() ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
}

// Non-secret credential-store read for the connection-summary projection.
// Reads ONLY `getMetadata` (status/present/rejected). Never calls
// `recoverSecret`; the plaintext never enters this module.
function getConnectorCredentialStore() {
  return isPostgresStorageBackend()
    ? createPostgresConnectorInstanceCredentialStore()
    : createSqliteConnectorInstanceCredentialStore();
}

function getAcquisitionBatchStore() {
  return isPostgresStorageBackend() ? createPostgresAcquisitionBatchStore() : createSqliteAcquisitionBatchStore();
}

function recordStorageConnectorIdForConnection(instance: ConnectorInstanceRow): string {
  // Local-device records are stored under the bare canonical connector key,
  // the same key API/browser records use; connection isolation is carried by
  // connector_instance_id, not a `local-device:` storage prefix. The record
  // projection scopes by connectorInstanceId, so this value is only a
  // fallback identity. See canonicalize-connector-keys design Decision 7.
  return instance.connectorId;
}

interface AcquisitionBatchRow {
  readonly acceptedCount?: number | null;
  readonly acquisitionMethod?: string | null;
  readonly batchId: string;
  readonly duplicateCount?: number | null;
  readonly eventTimeEnd?: string | null;
  readonly eventTimeStart?: string | null;
  readonly failedCount?: number | null;
  readonly mediaCoverage?: unknown;
  readonly parsedCount?: number | null;
  readonly skippedCount?: number | null;
  readonly sourceFormat?: string | null;
  readonly status: string;
  readonly uploadedFileName?: string | null;
  readonly warnings?: readonly string[] | null;
}

function projectAcquisitionBatchSummary(batch: AcquisitionBatchRow): AcquisitionBatchSummary {
  return {
    accepted_count: batch.acceptedCount ?? null,
    acquisition_method: batch.acquisitionMethod ?? null,
    batch_id: batch.batchId,
    date_range: {
      start: batch.eventTimeStart ?? null,
      end: batch.eventTimeEnd ?? null,
    },
    detected_format: batch.sourceFormat ?? null,
    duplicate_count: batch.duplicateCount ?? null,
    failed_count: batch.failedCount ?? null,
    media_coverage: batch.mediaCoverage ?? null,
    parsed_count: batch.parsedCount ?? null,
    skipped_count: batch.skippedCount ?? null,
    status: batch.status,
    uploaded_file_name: batch.uploadedFileName ?? null,
    warnings: Array.isArray(batch.warnings) ? batch.warnings : [],
  };
}

async function getAcquisitionCoverageSummary(connectorInstanceId: string): Promise<AcquisitionCoverageSummary | null> {
  const batches = (await getAcquisitionBatchStore().listByConnection(connectorInstanceId, { limit: 5 })) as
    | readonly AcquisitionBatchRow[]
    | null;
  if (!batches || batches.length === 0) {
    return null;
  }
  const recent = batches.map(projectAcquisitionBatchSummary);
  return {
    latest_batch: recent[0] ?? null,
    recent_batches: recent,
  };
}

async function listConnectorInstanceRowsForDashboard(): Promise<readonly ConnectorInstanceRow[]> {
  // A read SHALL NOT persist a connection. The dashboard / catalog read
  // projects exactly the owner's real (configured or ingest-materialized)
  // connections and nothing else. Previously this path called
  // `ensureDefaultAccountConnection` for every registered public connector
  // when the owner had zero connections, which is an `upsert`: merely
  // viewing a fresh instance's dashboard persisted ~14 `status:'active'`
  // default-account `connector_instances` rows — phantom connections the
  // owner never created, which then surfaced on every owner-connections
  // surface and (worse) participated in grant fan-in resolution.
  //
  // Catalog completeness — "which connectors can I add" — is a distinct
  // concept owned by the connector catalog (the registered `connectors`
  // table and the add-connection picker, which reads the shipped manifests
  // directly), NOT by `connector_instances`. A connector is not a
  // connection until an explicit enrollment, ingest, pending/draft, active,
  // or revoked state creates a durable row. Default-account materialization
  // stays demand-driven at ingest/resolution time (`resolveNamespace` with
  // `allowDefaultAccount: true`); see
  // `openspec/changes/separate-connector-catalog-from-connections/`.
  //
  // `draft` instances ARE included here (unlike every other `listByOwner`
  // caller): this is the read that backs the owner-facing dashboard, Sources,
  // Syncs, and source-detail surfaces, and a freshly created connection must
  // be discoverable there as an explicit "setup in progress" state rather
  // than invisible until its first successful ingest. See
  // fix-pending-connection-discovery design. Callers project `instance.status`
  // through `owner_state.resolver` (`setup_in_progress`), so a draft never
  // reads as healthy/configured.
  const store = getConnectorInstanceStore();
  const instances = await store.listByOwnerIncludingDrafts(REFERENCE_OWNER_SUBJECT_ID);
  // Filter out system-internal connector_instances (backfill jobs, runtime
  // stubs, etc.) that are never owner-created and must not appear on the
  // owner-facing source list. Same pattern list as isPublicReferenceConnector.
  return instances.filter(
    (instance: ConnectorInstanceRow) =>
      !(
        NON_PUBLIC_CONNECTOR_ID_PARTS.some((part) => instance.connectorId.includes(part)) ||
        isRetiredSetupAttempt(instance)
      )
  );
}

function isRetiredSetupAttempt(instance: ConnectorInstanceRow): boolean {
  if (instance.status !== "revoked") {
    return false;
  }
  const binding = instance.sourceBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return false;
  }
  const kind = (binding as { readonly kind?: unknown }).kind;
  return kind === "browser_enrollment_shell" || kind === "static_secret_draft" || kind === "manual_upload_draft";
}

function retireExpiredBrowserEnrollmentShellsForDashboard(now: string): Promise<readonly string[]> {
  const store = getConnectorInstanceStore() as {
    listDraftBrowserEnrollmentShells(
      ownerSubjectId?: string | null
    ): Promise<readonly EnrollmentShellLike[]> | readonly EnrollmentShellLike[];
    updateStatus(
      connectorInstanceId: string,
      args: { status: string; updatedAt: string; revokedAt?: string | null }
    ): Promise<unknown> | unknown;
  };
  return retireExpiredBrowserEnrollmentShells(
    {
      async listDraftBrowserEnrollmentShells(ownerSubjectId) {
        return [...(await store.listDraftBrowserEnrollmentShells(ownerSubjectId))];
      },
      async updateStatus(connectorInstanceId, args) {
        return await store.updateStatus(connectorInstanceId, args);
      },
    },
    {
      now,
      ownerSubjectId: REFERENCE_OWNER_SUBJECT_ID,
    }
  );
}

export function isPublicReferenceConnector(row: ConnectorRow, manifest: ConnectorManifest): boolean {
  const connectorId = row.connector_id || manifest.connector_id || "";
  if (NON_PUBLIC_CONNECTOR_ID_PARTS.some((part) => connectorId.includes(part))) {
    return false;
  }

  const publicListing = manifest.capabilities?.public_listing;
  if (publicListing && typeof publicListing === "object" && !Array.isArray(publicListing)) {
    const listing = publicListing as { listed?: unknown; status?: unknown };
    if (listing.listed === true) {
      return true;
    }
    if (listing.listed === false || listing.status === "unproven") {
      return false;
    }
  }

  const localDeviceBinding = manifest.runtime_requirements?.bindings?.local_device;
  if (
    localDeviceBinding &&
    typeof localDeviceBinding === "object" &&
    !Array.isArray(localDeviceBinding) &&
    (localDeviceBinding as { required?: unknown }).required === true
  ) {
    return false;
  }

  // Catalog visibility is explicit opt-in only. A connector without
  // capabilities.public_listing.listed === true is hidden by default.
  return false;
}

/**
 * Project the public connector catalog — the connectors the owner CAN add —
 * directly from the registered `connectors` table, filtered by
 * `isPublicReferenceConnector`. Catalog visibility is owned by the
 * `connectors` table, NOT by `connector_instances`: this read enumerates
 * registered manifests and SHALL NOT create or upsert any connection row.
 *
 * Distinct from `listConnectorSummaries`, which projects the owner's real
 * CONNECTIONS (configured / ingest-materialized `connector_instances` rows).
 * A connector appears here with zero connections; it only becomes a
 * connection once an explicit enrollment, ingest, or grant/connection
 * resolution materializes a durable row. See
 * `openspec/changes/separate-connector-catalog-from-connections/`.
 */
export async function listPublicCatalogConnectorIds(): Promise<string[]> {
  const registeredRows = await listRegisteredConnectorRows();
  const ids: string[] = [];
  for (const row of registeredRows) {
    let manifest: ConnectorManifest;
    try {
      manifest = parseManifest(row.manifest, row.connector_id);
    } catch {
      continue;
    }
    if (isPublicReferenceConnector(row, manifest)) {
      ids.push(row.connector_id);
    }
  }
  return ids.sort();
}

function getScheduleFrom(
  controller: ControllerLike | null | undefined,
  connectorId: string,
  options: { readonly connectorInstanceId?: string } = {}
): Promise<unknown> {
  if (controller && typeof controller.getSchedule === "function") {
    return (controller as ScheduleLike).getSchedule(connectorId, options);
  }
  return Promise.resolve(null);
}

function extractRefreshPolicy(manifest: ConnectorManifest): unknown {
  const caps = manifest.capabilities as Record<string, unknown> | undefined;
  if (!caps || typeof caps !== "object") {
    return null;
  }
  return caps.refresh_policy ?? null;
}

function getMaximumStalenessSeconds(refreshPolicy: unknown): number | null {
  if (!refreshPolicy || typeof refreshPolicy !== "object" || Array.isArray(refreshPolicy)) {
    return null;
  }
  const value = (refreshPolicy as { maximum_staleness_seconds?: unknown }).maximum_staleness_seconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isManualRefreshPolicy(refreshPolicy: unknown): boolean {
  return (
    !!refreshPolicy &&
    typeof refreshPolicy === "object" &&
    !Array.isArray(refreshPolicy) &&
    (refreshPolicy as { recommended_mode?: unknown }).recommended_mode === "manual"
  );
}

/**
 * Project the manifest `refresh_policy` into the `background_safe` /
 * `recommended_mode` / `interaction_posture` evidence the connection-health
 * projection needs to tell a schedulable connector apart from a manual /
 * paused / background-unsafe one, and an assisted-refresh connector (whose
 * posture predicts bounded owner help) apart from a truly unattended one.
 * Reads the same refresh-policy values the schedule auto-enroll gate
 * (`auto-enroll-eligible-schedules.ts`) and run-automation policy
 * (`run-automation-policy.ts`) use, so the health story stays consistent with
 * "this connector cannot auto-refresh" and "this connector refreshes on
 * schedule but may ask for bounded owner help". Returns `null` when the policy
 * is absent/malformed, preserving the prior behavior (treated as schedulable;
 * staleness degrades).
 */
function buildRefreshEvidence(refreshPolicy: unknown): ConnectionRefreshEvidence | null {
  if (!refreshPolicy || typeof refreshPolicy !== "object" || Array.isArray(refreshPolicy)) {
    return null;
  }
  const policy = refreshPolicy as {
    background_safe?: unknown;
    interaction_posture?: unknown;
    recommended_mode?: unknown;
  };
  const backgroundSafe = typeof policy.background_safe === "boolean" ? policy.background_safe : null;
  const recommendedMode =
    policy.recommended_mode === "manual" ||
    policy.recommended_mode === "automatic" ||
    policy.recommended_mode === "paused"
      ? policy.recommended_mode
      : null;
  const interactionPosture =
    policy.interaction_posture === "credentials" ||
    policy.interaction_posture === "manual_action_likely" ||
    policy.interaction_posture === "otp_likely" ||
    policy.interaction_posture === "none"
      ? policy.interaction_posture
      : null;
  if (backgroundSafe === null && recommendedMode === null && interactionPosture === null) {
    return null;
  }
  return { backgroundSafe, interactionPosture, recommendedMode };
}

function mapFreshnessAxis(freshness: Freshness): FreshnessAxis {
  if (freshness.status === "current") {
    return "fresh";
  }
  if (freshness.status === "stale") {
    return "stale";
  }
  return "unknown";
}

function hasPendingDetailGap(gaps: readonly PendingDetailGapSummary[] = []): boolean {
  return gaps.length > 0;
}

const OWNER_CANCEL_TERMINAL_REASONS: ReadonlySet<string> = new Set(["owner_cancel_forced", "owner_cancelled"]);

function isOwnerCancelledRun(run: ConnectorRunSummary | null): boolean {
  const reason = run?.terminal_reason ?? run?.failure_reason ?? "";
  return run?.status === "cancelled" && OWNER_CANCEL_TERMINAL_REASONS.has(reason);
}

function healthClassifyingRun(run: ConnectorRunSummary | null): ConnectorRunSummary | null {
  return isOwnerCancelledRun(run) ? null : run;
}

/**
 * Wave 10a live-evidence fix (2026-07-09): while the latest run is
 * queued/starting/in_progress (`isActiveRunSummaryStatus`), it carries no
 * `collection_facts` yet — using it as the coverage-classifying run would
 * wipe a prior successful run's proven coverage/freshness for the duration
 * of every scheduled refresh, reading previously-complete streams as
 * unknown/unmeasured and `last_success_at` as `null` even though a real
 * `lastSuccessfulRun` exists. An active nonterminal run therefore falls back
 * to `lastSuccessfulRun` here, exactly like the existing owner-cancel
 * fallback — the active-run progress overlay (`badges.syncing` /
 * `OwnerStateEvidence.progress.active`) stays live and honest via a SEPARATE
 * signal; this function answers "what proven coverage do we have," not "is
 * something running right now." A terminal failure/gap run is NEVER
 * substituted — only a nonterminal in-flight run with no coverage evidence
 * of its own falls back.
 *
 * A SUCCEEDED terminal `recovery_only` run gets the same fallback for the
 * same reason (owner review, 2026-07-17): by definition
 * (`buildCollectionFacts`'s `recoveryOnly` branch, `connector-gap-bounding.ts`)
 * it performs no forward/list-pass inventory scan and its own
 * `collection_facts` is ALWAYS `null` — not because measurement failed, but
 * because none was attempted. A connector with a durable non-pressure
 * recovery backlog (e.g. a large attachment-hydration queue) is dispatched
 * `recovery_only` on every scheduled/unscoped-manual run for as long as that
 * backlog persists (`resolveEffectiveRecoveryOnly`,
 * `runtime/controller.ts`), so treating its terminal success as "no coverage
 * evidence" would starve every OTHER stream's coverage indefinitely — even
 * though those streams were never touched by the run and their last real
 * measurement still stands. This is strictly narrower than the failure
 * case: a FAILED recovery-only run still carries a genuine failure signal
 * and is never substituted (the `latest` case below), exactly like an
 * ordinary terminal failure.
 */
function coverageClassifyingRun(
  lastRun: ConnectorRunSummary | null,
  lastSuccessfulRun: ConnectorRunSummary | null
): ConnectorRunSummary | null {
  if (lastRun && isActiveRunSummaryStatus(lastRun.status)) {
    return lastSuccessfulRun ?? null;
  }
  if (lastRun && lastRun.status === "succeeded" && lastRun.recovery_only) {
    return lastSuccessfulRun ?? lastRun;
  }
  const latest = healthClassifyingRun(lastRun);
  return latest ?? (isOwnerCancelledRun(lastRun) ? lastSuccessfulRun : null);
}

/**
 * Narrow `coverageClassifyingRun`'s result — the SAME classifying run
 * health/coverage already resolved to (owner review, 2026-07-09) — down to
 * the minimal shape `ownerStateCausalEvidenceFrom` (`owner-state.ts`) needs.
 * `owner-state.ts` owns the causal-evidence-selection CONCEPT; this file
 * keeps owning run classification (`coverageClassifyingRun`,
 * `healthClassifyingRun`, `isOwnerCancelledRun`) since those already depend
 * on this file's local `ConnectorRunSummary`/run-status helpers. An
 * owner-cancelled `lastRun` is excluded by `coverageClassifyingRun` exactly
 * like the coverage/health projection — its own timestamp/status is never
 * passed through here when the classifying run is actually
 * `lastSuccessfulRun`.
 */
function classifiedRunForOwnerState(
  lastRun: ConnectorRunSummary | null,
  lastSuccessfulRun: ConnectorRunSummary | null
): ClassifiedRunForOwnerState | null {
  const classifyingRun = coverageClassifyingRun(lastRun, lastSuccessfulRun);
  if (classifyingRun == null) {
    return null;
  }
  return {
    last_at: classifyingRun.last_at,
    succeeded: mapRunStatus(classifyingRun.status) === "succeeded",
  };
}

// Generic terminal reasons that carry NO specific cause — a connector that
// flattens any terminal failure into one of these hides the real signal. When
// the run reason is one of these, a credential-bearing known-gap should win
// (§10-C); a SPECIFIC failure_reason is left untouched.
const GENERIC_TERMINAL_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "connector_reported_failed",
  "connector_exited",
  "unknown",
]);

// A known-gap recovery-hint action that is a MORE SPECIFIC, connector-emitted
// classification of "what the owner must do" than a generic credential-reject
// inference: the connector itself identified this as an interactive/manual
// step (OTP, a stalled login flow, a captcha) rather than a proven-dead
// credential. Live evidence (USAA `run_1783787246728`): the SAME run emits
// BOTH an `interaction_required`/`manual_action_required` gap (self-describing
// "this exact failure has recurred") AND a generic `run_failed` gap whose
// message happens to contain "session_failed" and whose recovery_hint is
// `refresh_credentials` — the two known_gaps disagree about the same failure.
// `manual_action_required`/`interaction_required` is the connector's own,
// more-specific read; deferring to it here (rather than manufacturing a
// `credentials_required`/`session_required` reason from the generic sibling
// gap) is what stops `credentialsValidCondition` from rendering
// "Reconnect this account" for a credential that was never actually rejected.
const OWNER_INTERACTION_RECOVERY_ACTIONS: ReadonlySet<string> = new Set(["manual_action_required"]);
const OWNER_INTERACTION_GAP_KINDS: ReadonlySet<string> = new Set(["interaction_required"]);

function hasCompetingOwnerInteractionGap(knownGaps: readonly unknown[]): boolean {
  for (const gap of knownGaps) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      continue;
    }
    const kind = (gap as { kind?: unknown }).kind;
    const recoveryAction = (gap as { recovery_hint?: { action?: unknown } }).recovery_hint?.action;
    if (
      (typeof kind === "string" && OWNER_INTERACTION_GAP_KINDS.has(kind)) ||
      (typeof recoveryAction === "string" && OWNER_INTERACTION_RECOVERY_ACTIONS.has(recoveryAction))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * §10-C: recover a credential-specific reason from a run whose top-level
 * `failure_reason` is a GENERIC placeholder (e.g. `connector_reported_failed`)
 * but whose degrading known-gaps signal an auth failure (a 401/403 message or a
 * `refresh_credentials` recovery hint). Returns the most specific auth reason
 * the gap proves so the downstream `isCredentialReason` gate can preserve the
 * repair surface (browser session vs stored credential) instead of collapsing a
 * session repair into a credential update.
 * Returns `null` when the failure_reason is already specific (left untouched),
 * a competing owner-interaction gap in the SAME known_gaps array already
 * classifies this failure more specifically (manual_action/interaction, not a
 * proven credential rejection — evidence-specific: this does NOT suppress a
 * genuine `authentication_error`/401/403/credential-rejected signal, only
 * defers to an explicit sibling gap that is itself present this run), or no
 * known-gap signals credentials.
 */
function credentialReasonFromGenericFailure(run: ConnectorRunSummary | null): string | null {
  if (!run) {
    return null;
  }
  const failureReason = run.failure_reason;
  // A specific failure_reason is authoritative — do not override it.
  if (
    typeof failureReason === "string" &&
    failureReason.length > 0 &&
    !GENERIC_TERMINAL_FAILURE_REASONS.has(failureReason)
  ) {
    return null;
  }
  const competingOwnerInteraction = hasCompetingOwnerInteractionGap(run.known_gaps);
  for (const gap of run.known_gaps) {
    const reason = credentialReasonFromGenericGap(gap, competingOwnerInteraction);
    if (reason) {
      return reason;
    }
  }
  return null;
}

function credentialReasonFromGenericGap(gap: unknown, competingOwnerInteraction: boolean): string | null {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return null;
  }
  const severity = (gap as { severity?: unknown }).severity;
  if (severity === "informational" || severity === "recoverable") {
    return null;
  }
  const message = (gap as { message?: unknown }).message;
  if (isSourceUnavailableMessage(message)) {
    return null;
  }
  // A genuine, definitive credential signal (401/403/explicit
  // credential-rejected/invalid-token language) always wins, even alongside
  // a competing manual_action gap — a real rejected credential is never
  // suppressed. Only the WEAKER signals (a bare `refresh_credentials`
  // recovery_hint with no definitive auth-failure message, or a
  // `session_failed`-shaped message with no definitive marker) defer to a
  // more specific sibling gap when one exists.
  if (isDefinitiveAuthFailureMessage(message)) {
    return browserSessionReasonFromAuthMessage(message) ?? "credential_rejected";
  }
  if (competingOwnerInteraction) {
    return null;
  }
  const recoveryAction = (gap as { recovery_hint?: { action?: unknown } }).recovery_hint?.action;
  if (recoveryAction === "refresh_credentials" || isAuthFailureMessage(message)) {
    return browserSessionReasonFromAuthMessage(message) ?? "credentials_required";
  }
  return null;
}

/**
 * True only for an UNAMBIGUOUS, provably-dead-credential signal: an explicit
 * HTTP 401/403 status or an explicit credential-rejected marker in the
 * message text. Distinct from the broader `isAuthFailureMessage` (which also
 * matches softer, ambiguous markers like "session_failed" that a login-flow
 * stall can trigger just as easily as a genuinely dead session) — this
 * stricter check is what a competing manual_action gap is allowed to defer
 * to without risking suppression of a real credential rejection.
 */
function isDefinitiveAuthFailureMessage(message: unknown): boolean {
  if (typeof message !== "string" || message.length === 0) {
    return false;
  }
  const text = message.toLowerCase();
  return (
    text.includes("401") ||
    text.includes("403") ||
    text.includes("authentication_error") ||
    text.includes("credential_rejected") ||
    text.includes("invalid_token") ||
    text.includes("unauthorized") ||
    text.includes("forbidden")
  );
}

/**
 * True when a known-gap message indicates an authentication/credential failure
 * (a 401/403, expired token, dead session). Mirrors the `isCredentialReason`
 * vocabulary so an auth failure buried in a connector's message is recognised
 * even when the top-level run reason is generic (§10-C).
 */
function isAuthFailureMessage(message: unknown): boolean {
  if (typeof message !== "string" || message.length === 0) {
    return false;
  }
  const text = message.toLowerCase();
  return (
    text.includes("401") ||
    text.includes("403") ||
    text.includes("auth_missing") ||
    text.includes("authentication_error") ||
    text.includes("credential") ||
    text.includes("session_expired") ||
    text.includes("session_required") ||
    text.includes("reauth") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("invalid_token")
  );
}

function browserSessionReasonFromAuthMessage(message: unknown): string | null {
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }
  const text = message.toLowerCase();
  if (text.includes("session_required")) {
    return "session_required";
  }
  if (text.includes("session_expired")) {
    return "session_expired";
  }
  return null;
}

function isSourceUnavailableMessage(message: unknown): boolean {
  if (typeof message !== "string" || message.length === 0) {
    return false;
  }
  const text = message.toLowerCase();
  return text.includes("source_unavailable");
}

/**
 * Roll per-stream evidence into the connection-scoped coverage axis.
 *
 * Stream/scope boundary: each `pendingDetailGap` and each `known_gap` is
 * already scoped to a stream (and, for detail gaps, parent_stream and
 * record_key as well). When *any* stream has pending durable retry
 * intent, we surface `retryable_gap` so a list row can never paint an
 * otherwise-clean run green over a pending backlog. When the only gap
 * evidence is terminal (owner-action required, or unclassified shape),
 * we surface `terminal_gap`. If both flavors exist, `terminal_gap`
 * dominates because it is the more urgent claim.
 *
 * Pending detail gaps are themselves runtime-retryable: the store only
 * surfaces rows with `status = 'pending'`, and the runtime has a retry
 * loop keyed on `next_attempt_after`. They never roll up as terminal on
 * their own — only the known_gap severity can promote to terminal.
 *
 * Manifest-declared accepted-coverage:
 *
 *   - A stream may declare `coverage_policy` of `unsupported`,
 *     `unavailable`, `deferred`, or `inventory_only`. When the run has
 *     no degrading gaps and at least one stream declares such a policy,
 *     the rollup surfaces the most-precise accepted-coverage label
 *     (precedence: `unsupported` > `unavailable` > `deferred` >
 *     `inventory_only`). Headline state can still be healthy because
 *     the manifest declared the absence as accepted.
 *
 *   - A stream that is declared BOTH `required: true` AND an accepted-
 *     coverage policy is contradictory (load-bearing AND accepted-
 *     absent). We surface the accepted-coverage label but record that
 *     the rollup is contradictory by also degrading via the
 *     `requiredButUnsupported` channel — see callers.
 */
function mapCoverageAxis(
  lastRun: ConnectorRunSummary | null,
  pendingDetailGaps: readonly PendingDetailGapSummary[] = [],
  manifestStreams: readonly ManifestStream[] = []
): CoverageAxis {
  const hasDetailGap = hasPendingDetailGap(pendingDetailGaps);
  const hasTerminal = hasTerminalKnownGap(lastRun, pendingDetailGaps);
  const hasRetryable = lastRun ? lastRun.known_gaps.some((gap) => isRetryableKnownGap(gap)) : false;
  // Contradictory manifest (required AND accepted-absent) takes precedence
  // over the success path so a misconfigured manifest can never paint
  // green. The label still names the declared accepted-coverage policy
  // so the dashboard can show *why* the projection refused to go green.
  const requiredAccepted = pickRequiredAcceptedCoverage(manifestStreams);
  if (requiredAccepted !== null) {
    return requiredAccepted;
  }
  if (hasTerminal) {
    return "terminal_gap";
  }
  if (hasDetailGap || hasRetryable) {
    return "retryable_gap";
  }
  if (!lastRun) {
    return "unknown";
  }
  if (lastRun.status === "succeeded" || lastRun.status === "success") {
    // Promote an accepted-coverage label only when the success path is
    // otherwise clean; this surfaces the most-precise honest claim
    // ("we accept that `messages` is unsupported on this connector")
    // without inventing precision the run did not justify.
    const accepted = pickAcceptedCoverage(manifestStreams);
    return accepted ?? "complete";
  }
  if (lastRun.status === "failed" || lastRun.status === "cancelled" || lastRun.status === "abandoned") {
    return "partial";
  }
  return "unknown";
}

/**
 * Build the projection's coverage evidence: the axis plus the
 * `requiredButAccepted` contradiction signal. The signal is only set
 * when at least one *required* stream declares an accepted-coverage
 * policy; the connection-health projection then refuses to project
 * healthy even though the axis name is `unsupported`/`unavailable`/
 * `deferred`/`inventory_only`.
 */
function buildCoverageEvidence(
  lastRun: ConnectorRunSummary | null,
  pendingDetailGaps: readonly PendingDetailGapSummary[],
  manifestStreams: readonly ManifestStream[],
  localCoverage: LocalCoverageDiagnosticAxis | null = null
): { axis: CoverageAxis; requiredButAccepted: boolean } {
  const requiredButAccepted = pickRequiredAcceptedCoverage(manifestStreams) !== null;
  // Run-derived coverage is authoritative whenever a terminal spine run exists
  // (scheduler-managed connections) or any gap/contradiction evidence is
  // present. Local-device collectors push records from a device outbox and
  // never write spine run history, so `mapCoverageAxis` can only ever return
  // `unknown` for them — there is no run to anchor "complete" on. When the run
  // path yields `unknown` AND durable local coverage diagnostics exist, prefer
  // the diagnostic-derived axis. This is the only honest signal of local
  // collector completeness: an empty/drained outbox is NOT proof of coverage.
  const runAxis = mapCoverageAxis(lastRun, pendingDetailGaps, manifestStreams);
  if (runAxis === "unknown" && localCoverage !== null && localCoverage.axis !== "unknown") {
    return { axis: localCoverage.axis, requiredButAccepted };
  }
  return { axis: runAxis, requiredButAccepted };
}

const DEGRADING_REPORT_COVERAGE_ROLLUP_ORDER = ["terminal_gap", "retryable_gap", "gaps", "partial"] as const;

export function rollupCollectionReportCoverageOverride(
  currentAxis: CoverageAxis,
  report: readonly CollectionReportEntry[]
): CoverageAxis | null {
  const currentIndex = DEGRADING_REPORT_COVERAGE_ROLLUP_ORDER.indexOf(
    currentAxis as (typeof DEGRADING_REPORT_COVERAGE_ROLLUP_ORDER)[number]
  );
  const currentRank = currentIndex === -1 ? DEGRADING_REPORT_COVERAGE_ROLLUP_ORDER.length : currentIndex;
  const conditions = new Set(report.map((entry) => entry.coverage_condition));
  const degrading =
    DEGRADING_REPORT_COVERAGE_ROLLUP_ORDER.slice(0, currentRank).find((axis) => conditions.has(axis)) ?? null;
  if (degrading) {
    return degrading;
  }
  // A required stream resting at unknown coverage blocks the clean-success
  // promotion: the connection axis resolves to `unknown`, which
  // `sourceCoverageCondition` reads as a non-true `SourceCoverageComplete`
  // (never Healthy) and `deriveForwardDisposition` reads as `unmeasured` —
  // a maintainer/system disposition, not an owner CTA. Applied ONLY when the
  // current axis is non-degrading (worst-wins preserved): an existing
  // terminal_gap / retryable_gap / gaps / partial axis is never upgraded to
  // `unknown` by missing measurement evidence.
  if (
    currentIndex === -1 &&
    currentAxis !== "unknown" &&
    report.some((entry) => entry.required && entry.coverage_condition === "unknown")
  ) {
    return "unknown";
  }
  return null;
}

/**
 * Oldest proof time among required streams whose coverage is proven complete —
 * the anchor the connection's Healthy gate ages against. Accepted-policy,
 * non-required, and unproven streams never contribute: an accepted absence
 * has no proof to age, and an unproven stream already blocks Healthy through
 * the coverage axis.
 */
function oldestRequiredCompleteEvidenceAsOf(report: readonly CollectionReportEntry[]): string | null {
  let oldest: string | null = null;
  for (const entry of report) {
    if (!(entry.required && entry.coverage_condition === "complete" && entry.evidence_as_of)) {
      continue;
    }
    if (oldest === null || entry.evidence_as_of < oldest) {
      oldest = entry.evidence_as_of;
    }
  }
  return oldest;
}

/**
 * Cap an ISO-8601 anchor at an older proof time: the result is never NEWER
 * than the cap, and a `null` anchor stays `null` (a cap must not invent
 * proof). ISO-8601 UTC strings compare lexicographically.
 */
function capIsoAnchor(anchor: string | null, cap: string | null): string | null {
  if (anchor == null || cap == null) {
    return anchor;
  }
  return cap < anchor ? cap : anchor;
}

/**
 * Proof-age freshness override: the Healthy gate is anchored to the OLDEST
 * required-stream proof, not the newest run. When stored latest-attempt
 * evidence carried an older proof than the classifying run, freshness is
 * RECOMPUTED with its anchors capped at that proof time — the anchor feeds
 * the freshness computation itself (same derivation, same staleness policy,
 * injected `nowIso`), never a post-hoc status comparison. Connections with
 * no staleness window (`maximum_staleness_seconds` absent) have no window to
 * age the proof against and keep their computed freshness unchanged.
 */
function proofAgeFreshnessOverride(
  healthInput: Parameters<typeof projectConnectorSummaryConnectionHealth>[0],
  report: readonly CollectionReportEntry[]
): Freshness | null {
  const proofAnchor = oldestRequiredCompleteEvidenceAsOf(report);
  if (!proofAnchor) {
    return null;
  }
  const maximumStalenessSeconds = getMaximumStalenessSeconds(healthInput.refreshPolicy);
  if (maximumStalenessSeconds === null) {
    return null;
  }
  const current = healthInput.freshness;
  const recomputed = deriveReferenceFreshness({
    lastAttemptedAt: healthInput.lastRun?.last_at ?? null,
    lastAttemptStatus: healthInput.lastRun?.status ?? null,
    lastSuccessfulRunAt: capIsoAnchor(healthInput.lastSuccessfulRun?.last_at ?? null, proofAnchor),
    maximumStalenessSeconds,
    now: healthInput.nowIso ?? new Date().toISOString(),
    recordLastUpdatedAt: capIsoAnchor(current?.captured_at ?? null, proofAnchor),
  });
  if (recomputed.status === current?.status && recomputed.captured_at === current?.captured_at) {
    return null;
  }
  return recomputed;
}

export function refineConnectionHealthWithCollectionReport(
  healthInput: Parameters<typeof projectConnectorSummaryConnectionHealth>[0],
  initialConnectionHealth: ConnectionHealthSnapshot,
  collectionReport: readonly CollectionReportEntry[]
): ConnectionHealthSnapshot {
  const coverageOverride = rollupCollectionReportCoverageOverride(
    initialConnectionHealth.axes.coverage,
    collectionReport
  );
  const freshnessOverride = proofAgeFreshnessOverride(healthInput, collectionReport);
  if (coverageOverride === null && freshnessOverride === null) {
    return initialConnectionHealth;
  }
  return projectConnectorSummaryConnectionHealth({
    ...healthInput,
    ...(freshnessOverride ? { freshness: freshnessOverride } : {}),
    ...(coverageOverride ? { coverageOverride: { axis: coverageOverride } } : {}),
  });
}

function applyCoverageOverride(
  resolvedCoverage: { axis: CoverageAxis; requiredButAccepted: boolean },
  coverageOverride: { readonly axis: CoverageAxis; readonly requiredButAccepted?: boolean } | null | undefined
): { axis: CoverageAxis; requiredButAccepted: boolean } {
  if (coverageOverride?.axis == null) {
    return resolvedCoverage;
  }
  return {
    axis: coverageOverride.axis,
    requiredButAccepted: coverageOverride.requiredButAccepted ?? resolvedCoverage.requiredButAccepted,
  };
}

// ─── Per-stream Collection Report (Tranche C — derived on read) ───────────────
//
// `buildCollectionReport` is the control-plane projection half of the per-run
// Collection Report (`define-connector-progress-evidence-contract`). It reads the
// runtime `collection_facts` block (objective per-stream facts the runtime
// stamped on the terminal event — collected count, considered-or-`unknown`,
// checkpoint, skip, pending-detail-gap count) and DERIVES, on read, each stream's
// coverage condition and forward disposition from those facts plus the
// connection-level freshness / refresh-policy / open-attention evidence only this
// layer holds. The runtime never stamped either derived axis; deriving on read
// keeps the report honest as data ages.
//
// The load-bearing honesty mechanism is the per-stream coverage gate: a stream
// that collected records, recorded no gaps, and declared NO considered
// denominator reads `unknown` — never `complete`. The pure `deriveForwardDisposition`
// back-stop then maps `unknown` -> `checking`, so collected-count alone can never
// be projected as a completed stream or a recoverable gap. This is the Collection
// Report's reason for existing.

/** Considered axis: a known non-negative integer denominator, or `unknown`. */
type ConsideredAxis = number | "unknown";

/** One derived per-stream Collection Report entry on the owner/control-plane surface. */
export interface CollectionReportEntry {
  /** Committed-checkpoint status from the runtime fact block, or `unknown`. */
  readonly checkpoint: string;
  /** Raw per-stream collected count from the runtime fact block (never a verdict). */
  readonly collected: number;
  /** Known considered denominator, or `unknown` when the connector declared none. */
  readonly considered: ConsideredAxis;
  /** Derived coverage condition from the canonical {@link CoverageAxis} vocabulary. */
  readonly coverage_condition: CoverageAxis;
  /** Manifest-declared coverage proof strategy, or `null` when not yet instrumented. */
  readonly coverage_strategy: CoverageEvidenceStrategy | null;
  /**
   * Connector-declared `covered` count (in-boundary items accounted for: emitted +
   * suppressed-because-unchanged), or `unknown` when the connector declared none.
   * When known it is the numerator the coverage gate compares against `considered`,
   * so a steady-state full-sync run reads `complete` without a false `partial`.
   */
  readonly covered: ConsideredAxis;
  /**
   * Terminal time of the run that produced this stream's fact — the classifying
   * run's terminal time, or the stored latest-attempt evidence's terminal time
   * when the classifying run did not attempt the stream. `null` when no fact
   * exists. This is the proof age the connection's Healthy gate anchors to.
   */
  readonly evidence_as_of: string | null;
  /** Derived forward disposition (what the next run is expected to do on this stream). */
  readonly forward_disposition: ForwardDisposition;
  /** Manifest-declared freshness proof strategy, or `null` when not yet instrumented. */
  readonly freshness_strategy: FreshnessEvidenceStrategy | null;
  /** Count of pending recoverable detail gaps for this stream (locators stay in the detail-gap backlog). */
  readonly pending_detail_gaps: number;
  readonly pending_detail_gaps_is_floor: boolean;
  /**
   * Manifest-declared load-bearing flag (`required !== false`). `false` for a
   * stream with no manifest entry — an undeclared fact-only stream never
   * blocks the connection verdict.
   */
  readonly required: boolean;
  /** The `SKIP_RESULT` fact for this stream, or `null`. */
  readonly skipped: RuntimeCollectionFactSkip | null;
  readonly stream: string;
}

/** One durable latest-attempt stream fact read from the connector-summary read model. */
export interface LatestStreamFactRecord {
  readonly evidenceAsOf: string | null;
  readonly fact: RuntimeCollectionFact;
  readonly runId: string | null;
}

/**
 * A stream's effective fact plus its provenance. `source`/`runId` bound
 * `state_stream` checkpoint inheritance to facts from the SAME run — a child
 * carried from one run never inherits a parent checkpoint committed by a
 * different run.
 */
interface EffectiveStreamFact {
  readonly evidenceAsOf: string | null;
  readonly fact: RuntimeCollectionFact;
  readonly runId: string | null;
  readonly source: "classifying" | "stored";
}

/**
 * Resolve each stream's effective fact: the classifying run's own facts,
 * overlaid onto the durable latest-attempt store. The classifying run wins
 * for streams it attempted (it is the newest terminal run, so its fact is
 * the newest attempt even when the fold has not caught up); the store fills
 * streams it did not attempt. Stored run-local pending-gap counts are
 * dropped — the durable gap store is the current retry contract, and a stale
 * stored count must not fabricate a retryable gap.
 *
 * A recovery-only classifying run's `collection_facts` is always `null`
 * (see `buildCollectionFacts`'s `recoveryOnly` handling in
 * connector-gap-bounding.ts — a recovery-only run performs no forward/list
 * inventory pass, so it cannot produce a trustworthy fact for any stream),
 * so every stream falls through to the stored/prior fact below with its own
 * unmodified provenance. No recovery-only special case is needed here.
 */
function resolveEffectiveStreamFacts(input: {
  readonly collectionFacts: RuntimeCollectionFacts | null;
  readonly collectionFactsAsOf?: string | null;
  readonly collectionFactsRunId?: string | null;
  readonly latestStreamFacts?: ReadonlyMap<string, LatestStreamFactRecord> | null;
}): Map<string, EffectiveStreamFact> {
  const factByStream = new Map<string, EffectiveStreamFact>();
  for (const fact of input.collectionFacts?.streams ?? []) {
    if (!factByStream.has(fact.stream)) {
      factByStream.set(fact.stream, {
        fact,
        runId: input.collectionFactsRunId ?? null,
        evidenceAsOf: input.collectionFactsAsOf ?? null,
        source: "classifying",
      });
    }
  }
  for (const [stream, record] of input.latestStreamFacts ?? []) {
    if (factByStream.has(stream) || record.fact.stream !== stream) {
      continue;
    }
    factByStream.set(stream, {
      fact: { ...record.fact, pending_detail_gaps: 0 },
      runId: record.runId,
      evidenceAsOf: record.evidenceAsOf,
      source: "stored",
    });
  }
  return factByStream;
}

/**
 * Build the per-stream Collection Report for a connection: one derived entry per
 * in-scope stream (the union of the manifest's declared streams and the streams
 * the runtime fact block reported), each carrying a derived coverage condition and
 * forward disposition. Pure: a function of the runtime fact block plus the
 * connection-level freshness / attention / refresh evidence the projection already
 * assembled. Derived on read — never frozen at run completion.
 *
 * Absence tolerances (each reads honestly, never as `complete`):
 *   - no fact block (old run / failed-early / malformed)  -> one `unknown` entry
 *     per manifest stream;
 *   - a manifest stream missing from the fact block        -> honest zero entry
 *     (`collected: 0`, `considered: unknown`, `checkpoint: unknown`);
 *   - a malformed `considered`                             -> `unknown` (re-validated
 *     defensively on read).
 */
export function buildCollectionReport(input: {
  readonly collectionFacts: RuntimeCollectionFacts | null;
  /** Terminal time of the classifying run (stamps evidence_as_of on its facts). */
  readonly collectionFactsAsOf?: string | null;
  /** Run id of the classifying run (bounds state_stream inheritance to one run). */
  readonly collectionFactsRunId?: string | null;
  /**
   * Durable per-stream latest-attempt evidence from the connector-summary
   * read model. Fills streams the classifying run did not attempt; never
   * overrides the classifying run's own facts.
   */
  readonly latestStreamFacts?: ReadonlyMap<string, LatestStreamFactRecord> | null;
  readonly localCoverage?: LocalCoverageDiagnosticAxis | null;
  readonly manifestStreams: readonly ManifestStream[];
  /**
   * Current durable pending DETAIL_GAP rows read from the gap store. Runtime
   * `collection_facts` are run-local; these rows are the current retry contract.
   * Threading them here keeps the per-stream report aligned with the connection
   * rollup when a pending gap exists but no terminal run fact block is available.
   */
  readonly pendingDetailGaps?: readonly PendingDetailGapSummary[];
  readonly pendingDetailGapsReadLimit?: number | null;
  readonly terminalDetailGapsByStream?: ReadonlyMap<string, number> | null;
  readonly freshness: FreshnessAxis;
  readonly attentionOpen: boolean;
  readonly refresh: ConnectionRefreshEvidence | null;
  readonly schedule?: { readonly enabled: boolean } | null;
}): CollectionReportEntry[] {
  const { inScope, ...entryIndexes } = indexCollectionReportInputs(input);
  return [...inScope]
    .map((stream) =>
      buildCollectionReportEntry({
        stream,
        ...entryIndexes,
        localCoverage: input.localCoverage ?? null,
        freshness: input.freshness,
        attentionOpen: input.attentionOpen,
        refresh: input.refresh,
        schedule: input.schedule ?? null,
      })
    )
    .sort((a, b) => a.stream.localeCompare(b.stream));
}

interface IndexedCollectionReportInputs {
  readonly factByStream: ReadonlyMap<string, EffectiveStreamFact>;
  readonly inScope: ReadonlySet<string>;
  readonly localCoverageConditionByStream: ReadonlyMap<string, CoverageAxis>;
  readonly manifestByStream: ReadonlyMap<string, ManifestStream>;
  readonly pendingGapCountByStream: ReadonlyMap<string, number>;
  readonly pendingGapReadHitLimit: boolean;
  readonly terminalGapCountByStream: ReadonlyMap<string, number>;
}

/**
 * Normalize each source of per-stream evidence before any stream is assembled.
 * First-observed facts and manifest declarations remain authoritative, while the
 * in-scope union keeps missing evidence visible as an honest unknown entry.
 */
function indexCollectionReportInputs(input: {
  readonly collectionFacts: RuntimeCollectionFacts | null;
  readonly collectionFactsAsOf?: string | null;
  readonly collectionFactsRunId?: string | null;
  readonly latestStreamFacts?: ReadonlyMap<string, LatestStreamFactRecord> | null;
  readonly localCoverage?: LocalCoverageDiagnosticAxis | null;
  readonly manifestStreams: readonly ManifestStream[];
  readonly pendingDetailGaps?: readonly PendingDetailGapSummary[];
  readonly pendingDetailGapsReadLimit?: number | null;
  readonly terminalDetailGapsByStream?: ReadonlyMap<string, number> | null;
}): IndexedCollectionReportInputs {
  const factByStream = resolveEffectiveStreamFacts(input);
  const manifestByStream = firstManifestStreamsByName(input.manifestStreams);
  const pendingDetailGaps = input.pendingDetailGaps ?? [];
  const pendingReadLimit =
    typeof input.pendingDetailGapsReadLimit === "number" &&
    Number.isFinite(input.pendingDetailGapsReadLimit) &&
    input.pendingDetailGapsReadLimit > 0
      ? Math.floor(input.pendingDetailGapsReadLimit)
      : null;
  const pendingGapCountByStream = pendingDetailGapCountsByStream(pendingDetailGaps);
  const terminalGapCountByStream = input.terminalDetailGapsByStream ?? new Map<string, number>();
  return {
    factByStream,
    pendingGapCountByStream,
    terminalGapCountByStream,
    pendingGapReadHitLimit: pendingReadLimit !== null && pendingDetailGaps.length >= pendingReadLimit,
    manifestByStream,
    localCoverageConditionByStream: localCoverageConditionsByStream(input.localCoverage, manifestByStream),
    // In-scope universe: manifest streams ∪ fact-block streams. A zero-record or
    // unreported stream is an honest entry, never silently dropped (dropping reads
    // as "not owed" when it is "unknown").
    inScope: new Set<string>([
      ...manifestByStream.keys(),
      ...factByStream.keys(),
      ...pendingGapCountByStream.keys(),
      ...terminalGapCountByStream.keys(),
    ]),
  };
}

function firstManifestStreamsByName(manifestStreams: readonly ManifestStream[]): ReadonlyMap<string, ManifestStream> {
  const manifestByStream = new Map<string, ManifestStream>();
  for (const stream of manifestStreams) {
    if (stream && typeof stream.name === "string" && stream.name && !manifestByStream.has(stream.name)) {
      manifestByStream.set(stream.name, stream);
    }
  }
  return manifestByStream;
}

function buildCollectionReportEntry(input: {
  readonly stream: string;
  readonly factByStream: ReadonlyMap<string, EffectiveStreamFact>;
  readonly pendingGapCountByStream: ReadonlyMap<string, number>;
  readonly terminalGapCountByStream: ReadonlyMap<string, number>;
  readonly pendingGapReadHitLimit: boolean;
  readonly manifestByStream: ReadonlyMap<string, ManifestStream>;
  readonly localCoverageConditionByStream: ReadonlyMap<string, CoverageAxis>;
  readonly localCoverage?: LocalCoverageDiagnosticAxis | null;
  readonly freshness: FreshnessAxis;
  readonly attentionOpen: boolean;
  readonly refresh: ConnectionRefreshEvidence | null;
  readonly schedule?: { readonly enabled: boolean } | null;
}): CollectionReportEntry {
  const { effective, effectiveFact, manifestStream, coverageCondition } = deriveCollectionReportEntryCoverage(input);
  const forwardDisposition = deriveForwardDisposition({
    coverage: coverageCondition,
    gapRetryable: coverageCondition === "retryable_gap",
    attentionOpen: input.attentionOpen,
    freshness: input.freshness,
    refresh: input.refresh,
    schedule: input.schedule ?? null,
  });
  return {
    stream: input.stream,
    collected: effectiveFact.collected,
    considered: effectiveFact.considered === null ? "unknown" : effectiveFact.considered,
    covered: effectiveFact.covered === null ? "unknown" : effectiveFact.covered,
    checkpoint: effectiveFact.checkpoint ?? "unknown",
    pending_detail_gaps: effectiveFact.pending_detail_gaps,
    pending_detail_gaps_is_floor: effectiveFact.pending_detail_gaps > 0 && input.pendingGapReadHitLimit,
    skipped: effectiveFact.skipped,
    coverage_condition: coverageCondition,
    coverage_strategy: readCoverageEvidenceStrategy(manifestStream),
    evidence_as_of:
      effective?.evidenceAsOf ??
      (input.localCoverageConditionByStream.has(input.stream) ? (input.localCoverage?.evidenceAsOf ?? null) : null),
    forward_disposition: forwardDisposition,
    freshness_strategy: readFreshnessEvidenceStrategy(manifestStream),
    required: isRequiredStream(manifestStream),
  };
}

interface CollectionReportEntryCoverage {
  readonly coverageCondition: CoverageAxis;
  readonly effective: EffectiveStreamFact | undefined;
  readonly effectiveFact: RuntimeCollectionFact;
  readonly manifestStream: ManifestStream | undefined;
}

function deriveCollectionReportEntryCoverage(input: {
  readonly stream: string;
  readonly factByStream: ReadonlyMap<string, EffectiveStreamFact>;
  readonly pendingGapCountByStream: ReadonlyMap<string, number>;
  readonly terminalGapCountByStream: ReadonlyMap<string, number>;
  readonly manifestByStream: ReadonlyMap<string, ManifestStream>;
  readonly localCoverageConditionByStream: ReadonlyMap<string, CoverageAxis>;
}): CollectionReportEntryCoverage {
  const effective = input.factByStream.get(input.stream);
  const hasRuntimeFact = effective !== undefined;
  const baseFact: RuntimeCollectionFact = effective?.fact ?? {
    stream: input.stream,
    collected: 0,
    considered: null,
    covered: null,
    checkpoint: null,
    pending_detail_gaps: 0,
    skipped: null,
  };
  const fact: RuntimeCollectionFact = {
    ...baseFact,
    pending_detail_gaps: Math.max(baseFact.pending_detail_gaps, input.pendingGapCountByStream.get(input.stream) ?? 0),
  };
  const manifestStream = input.manifestByStream.get(input.stream);
  const effectiveFact = applyStateStreamCheckpointInheritance({
    child: effective,
    fact,
    manifestStream,
    parentFacts: input.factByStream,
    hasRuntimeFact,
  });
  const localCoverageCondition =
    !hasRuntimeFact && effectiveFact.pending_detail_gaps === 0
      ? input.localCoverageConditionByStream.get(input.stream)
      : null;
  const terminalDetailGaps = input.terminalGapCountByStream.get(input.stream) ?? 0;
  return {
    effective,
    effectiveFact,
    manifestStream,
    coverageCondition:
      terminalDetailGaps > 0
        ? "terminal_gap"
        : (localCoverageCondition ?? deriveStreamCoverageCondition(effectiveFact, manifestStream)),
  };
}

function applyStateStreamCheckpointInheritance(input: {
  readonly child: EffectiveStreamFact | undefined;
  readonly fact: RuntimeCollectionFact;
  readonly manifestStream: ManifestStream | undefined;
  readonly parentFacts: ReadonlyMap<string, EffectiveStreamFact>;
  readonly hasRuntimeFact: boolean;
}): RuntimeCollectionFact {
  const { child, fact, hasRuntimeFact, manifestStream, parentFacts } = input;
  if (
    !hasRuntimeFact ||
    fact.skipped ||
    fact.pending_detail_gaps > 0 ||
    readCoverageEvidenceStrategy(manifestStream) !== "checkpoint_window" ||
    checkpointProvesStreamCoverage(fact.checkpoint)
  ) {
    return fact;
  }
  const parentStream = localCoverageParentStream(manifestStream);
  if (!parentStream) {
    return fact;
  }
  const parent = parentFacts.get(parentStream);
  // Inheritance is bound to ONE run: a co-emitted child rides its parent's
  // cursor within the same pass, so a child fact carried from run N may only
  // inherit run N's parent checkpoint — never a checkpoint committed by a
  // different run.
  if (!(parent && child && parent.source === child.source && parent.runId === child.runId)) {
    return fact;
  }
  if (!checkpointProvesStreamCoverage(parent.fact.checkpoint)) {
    return fact;
  }
  return { ...fact, checkpoint: parent.fact.checkpoint };
}

function checkpointProvesStreamCoverage(checkpoint: string | null): boolean {
  return checkpoint === "committed" || checkpoint === "disabled";
}

/**
 * Project the per-stream Collection Report from the assembly inputs both the list
 * and detail surfaces already hold. The disposition's freshness and
 * open-attention inputs are read from the SAME connection-health snapshot the
 * headline is built from — `axes.freshness` and `axes.attention` — so a stream
 * entry's `forward_disposition` never disagrees with the connection-level
 * `forward_disposition` or the `needs_attention` pill. The refresh evidence is
 * the same `buildRefreshEvidence(refreshPolicy)` the snapshot used.
 */
export function projectCollectionReport(input: {
  readonly lastRun: ConnectorRunSummary | null;
  readonly lastSuccessfulRun?: ConnectorRunSummary | null;
  readonly connectionHealth: ConnectionHealthSnapshot;
  readonly latestStreamFacts?: ReadonlyMap<string, LatestStreamFactRecord> | null;
  readonly localCoverage?: LocalCoverageDiagnosticAxis | null;
  readonly localDeviceBacked?: boolean;
  readonly manifestStreams: readonly ManifestStream[];
  readonly pendingDetailGaps?: readonly PendingDetailGapSummary[];
  readonly pendingDetailGapsReadLimit?: number | null;
  readonly terminalDetailGapsByStream?: ReadonlyMap<string, number> | null;
  readonly refreshPolicy: unknown;
  readonly schedule?: { readonly enabled: boolean } | null;
}): CollectionReportEntry[] {
  // Select source authority before run precedence: local-device scheduler facts
  // are audit history, never coverage evidence.
  const classifyingRun = input.localDeviceBacked ? null : coverageClassifyingRun(input.lastRun, input.lastSuccessfulRun ?? null);
  return buildCollectionReport({
    collectionFacts: classifyingRun?.collection_facts ?? null,
    collectionFactsAsOf: classifyingRun?.last_at ?? null,
    collectionFactsRunId: classifyingRun?.run_id ?? null,
    latestStreamFacts: input.localDeviceBacked ? null : (input.latestStreamFacts ?? null),
    localCoverage: input.localDeviceBacked === true ? (input.localCoverage ?? null) : null,
    manifestStreams: input.manifestStreams,
    pendingDetailGaps: input.pendingDetailGaps ?? [],
    pendingDetailGapsReadLimit: input.pendingDetailGapsReadLimit ?? null,
    terminalDetailGapsByStream: input.terminalDetailGapsByStream ?? null,
    freshness: input.connectionHealth.axes.freshness,
    attentionOpen: input.connectionHealth.axes.attention !== "none",
    refresh: buildRefreshEvidence(input.refreshPolicy),
    schedule: input.schedule ?? null,
  });
}

function pendingDetailGapCountsByStream(gaps: readonly PendingDetailGapSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const gap of gaps) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap) || gap.status !== "pending") {
      continue;
    }
    const stream = typeof gap.stream === "string" ? gap.stream : "";
    if (!stream) {
      continue;
    }
    counts.set(stream, (counts.get(stream) ?? 0) + 1);
  }
  return counts;
}

function localCoverageConditionForStatus(status: unknown): CoverageAxis | null {
  switch (status) {
    case "collected":
    case "excluded":
    case "missing":
      return "complete";
    case "inventory_only":
      return "inventory_only";
    case "deferred":
      return "deferred";
    case "unsupported":
      return "unsupported";
    case "unavailable":
      return "unavailable";
    case "unaccounted":
      return "gaps";
    default:
      return null;
  }
}

function localCoverageConditionsByStream(
  localCoverage: LocalCoverageDiagnosticAxis | null | undefined,
  manifestByStream: ReadonlyMap<string, ManifestStream>
): ReadonlyMap<string, CoverageAxis> {
  const conditions = new Map<string, CoverageAxis>();
  if (localCoverage?.reliable !== true || localCoverage.axis !== "complete") {
    return conditions;
  }
  const rows = localCoverage?.rows ?? [];
  seedLocalCoverageConditions(conditions, rows);
  addCoverageDiagnosticsCondition(conditions, rows, manifestByStream);
  inheritLocalCoverageParentConditions(conditions, manifestByStream);
  return conditions;
}

function seedLocalCoverageConditions(
  conditions: Map<string, CoverageAxis>,
  rows: readonly LocalCoverageDiagnosticRow[]
): void {
  for (const row of rows) {
    const stream = typeof row.stream === "string" && row.stream ? row.stream : null;
    if (!stream) {
      continue;
    }
    const condition = localCoverageConditionForStatus(row.status);
    if (!condition) {
      continue;
    }
    const existing = conditions.get(stream);
    if (!existing || localCoverageConditionSeverity(condition) > localCoverageConditionSeverity(existing)) {
      conditions.set(stream, condition);
    }
  }
}

function localCoverageConditionSeverity(axis: CoverageAxis): number {
  switch (axis) {
    case "complete":
      return 0;
    case "inventory_only":
    case "deferred":
    case "unsupported":
      return 1;
    case "unavailable":
      return 2;
    case "gaps":
      return 3;
    default:
      return 4;
  }
}

function addCoverageDiagnosticsCondition(
  conditions: Map<string, CoverageAxis>,
  rows: readonly LocalCoverageDiagnosticRow[],
  manifestByStream: ReadonlyMap<string, ManifestStream>
): void {
  if (rows.length > 0 && manifestByStream.has("coverage_diagnostics") && !conditions.has("coverage_diagnostics")) {
    conditions.set("coverage_diagnostics", "complete");
  }
}

function inheritLocalCoverageParentConditions(
  conditions: Map<string, CoverageAxis>,
  manifestByStream: ReadonlyMap<string, ManifestStream>
): void {
  for (let pass = 0; pass < manifestByStream.size; pass += 1) {
    let changed = false;
    for (const [stream, manifestStream] of manifestByStream) {
      if (conditions.has(stream)) {
        continue;
      }
      const parentStream = localCoverageParentStream(manifestStream);
      if (!parentStream) {
        continue;
      }
      const parentCondition = conditions.get(parentStream);
      if (!parentCondition) {
        continue;
      }
      conditions.set(stream, parentCondition);
      changed = true;
    }
    if (!changed) {
      break;
    }
  }
}

function localCoverageParentStream(stream: ManifestStream | undefined): string | null {
  if (!stream || typeof stream !== "object") {
    return null;
  }
  const parent = stream.state_stream;
  return typeof parent === "string" && parent ? parent : null;
}

/** Safe per-store coverage triple read from `coverage_diagnostics` records. */
interface LocalCoverageDiagnosticRow {
  readonly status?: unknown;
  readonly store?: unknown;
  readonly stream?: unknown;
}

interface LocalCoverageDiagnosticAxis {
  readonly axis: CoverageAxis;
  /** Safe per-store triples from `coverage_diagnostics`, used to project stream rows. */
  readonly rows?: readonly LocalCoverageDiagnosticRow[];
  /** Stores the collector discovered but could not account for. */
  readonly unaccountedStores: readonly string[];
  readonly evidenceAsOf: string | null;
  readonly reliable: boolean;
}

const LOCAL_COVERAGE_ACCOUNTED_STATUSES = new Set([
  "collected",
  "inventory_only",
  "excluded",
  "deferred",
  "missing",
  "unsupported",
]);

/**
 * Derive a connection coverage axis from durable local-collector
 * `coverage_diagnostics` records.
 *
 * Mirrors the honest classification `summarizeLocalCoverage` uses for the
 * device-exporter diagnostics surface (Section 5.3 / the
 * `local-agent-collector-completeness` spec): a store is accounted for when
 * its status is any recognized safe status other than `unaccounted`. The axis:
 *
 *   - no rows observed              -> `unknown` (a run never proved coverage;
 *                                      an empty/drained outbox is NOT complete)
 *   - every observed store accounted -> `complete`
 *   - any unaccounted store          -> `gaps` (degrading; names the shortfall)
 *
 * This refuses to project `complete` from an absence of evidence, which is the
 * load-bearing honesty guarantee: the spec forbids treating declared-stream
 * success (or a quiet outbox) as complete local collection.
 */
export function deriveLocalCoverageAxis(input: {
  readonly rows: readonly LocalCoverageDiagnosticRow[];
  readonly malformed: boolean;
  readonly duplicateStores: readonly string[];
  readonly missingStores: readonly string[];
  readonly unexpectedStores: readonly string[];
  readonly hasAuthoritativeInventory: boolean;
  readonly hasCommittedSnapshot?: boolean;
  readonly state: unknown;
  readonly updatedAt: string | null;
  readonly nowIso?: string;
}): LocalCoverageDiagnosticAxis {
  const { rows } = input;
  const stateCursor =
    input.state && typeof input.state === "object" && !Array.isArray(input.state)
      ? (input.state as Record<string, unknown>).fetched_at
      : null;
  const validCursor = typeof stateCursor === "string" && Number.isFinite(Date.parse(stateCursor));
  const validUpdatedAt = typeof input.updatedAt === "string" && Number.isFinite(Date.parse(input.updatedAt));
  const nowMs = Date.parse(input.nowIso ?? new Date().toISOString());
  const maximumFutureProofMs = 5 * 60 * 1000;
  const cursorMs = validCursor ? Date.parse(stateCursor) : Number.NaN;
  const updatedAtMs = validUpdatedAt ? Date.parse(input.updatedAt) : Number.NaN;
  const reliable =
    validCursor &&
    validUpdatedAt &&
    Number.isFinite(nowMs) &&
    cursorMs <= nowMs + maximumFutureProofMs &&
    updatedAtMs <= nowMs + maximumFutureProofMs &&
    !input.malformed &&
    input.hasAuthoritativeInventory &&
    input.hasCommittedSnapshot === true &&
    input.duplicateStores.length === 0 &&
    input.missingStores.length === 0 &&
    input.unexpectedStores.length === 0;
  if (!reliable) {
    return { axis: "unknown", rows, unaccountedStores: [], evidenceAsOf: null, reliable: false };
  }
  if (rows.length === 0) {
    return { axis: "unknown", rows, unaccountedStores: [], evidenceAsOf: input.updatedAt, reliable: true };
  }
  const unaccountedStores: string[] = [];
  for (const row of rows) {
    const store = typeof row.store === "string" && row.store ? row.store : "unknown_store";
    const status =
      typeof row.status === "string" && LOCAL_COVERAGE_ACCOUNTED_STATUSES.has(row.status) ? row.status : "unaccounted";
    if (status === "unaccounted") {
      unaccountedStores.push(store);
    }
  }
  if (unaccountedStores.length > 0) {
    return {
      axis: "gaps",
      rows,
      unaccountedStores: unaccountedStores.sort(),
      evidenceAsOf: input.updatedAt,
      reliable: true,
    };
  }
  return { axis: "complete", rows, unaccountedStores: [], evidenceAsOf: input.updatedAt, reliable: true };
}

/**
 * Read durable local coverage diagnostics for one connection and project the
 * coverage axis. Returns `null` (axis derivation skipped) when the read throws —
 * a read failure must not turn an otherwise-fine connection into a fabricated
 * `complete`, and absence of evidence already maps to `unknown` inside the
 * projection.
 *
 * When `connectorInstanceId` is provided, coverage is scoped to exactly that
 * connection so one device's diagnostics cannot color another device's pill.
 * When it is absent (the connector-keyed detail surface), the read falls back to
 * the default-account instance the same way `listLocalCoverageDiagnostics` does.
 */
async function getConnectorLocalCoverageAxis(
  connectorId: string,
  connectorInstanceId: string | null | undefined,
  nowIso?: string
): Promise<LocalCoverageDiagnosticAxis | null> {
  const storageTarget: { connector_id: string; connector_instance_id?: string } = { connector_id: connectorId };
  if (connectorInstanceId) {
    storageTarget.connector_instance_id = connectorInstanceId;
  }
  try {
    const proof = await readCommittedLocalCoverageDiagnostics(storageTarget);
    return deriveLocalCoverageAxis(nowIso ? { ...proof, nowIso } : proof);
  } catch {
    return null;
  }
}

function mapRunStatus(status: string | null | undefined): "failed" | "succeeded" | null {
  if (!status) {
    return null;
  }
  if (status === "succeeded" || status === "success") {
    return "succeeded";
  }
  if (status === "failed" || status === "cancelled" || status === "abandoned") {
    return "failed";
  }
  return null;
}

/**
 * Pull device-side source-instance heartbeat evidence for `connectorId`
 * from the device-exporter store and project the rollup outbox axis.
 *
 * Returns `unknown` (with `unreliable: false`) when the connector has
 * no enrolled device — that is honest absence of evidence, not a
 * projection failure. Returns `unreliable: true` only when the store
 * read itself fails or named evidence is untrustworthy.
 */
export async function getConnectorOutboxAxis(
  connectorId: string,
  options: { readonly connectorInstanceId?: string | null } = {}
): Promise<{
  axis: OutboxAxis;
  cause: OutboxStalledCause | null;
  heartbeats: readonly HeartbeatRow[];
  unreliable: boolean;
}> {
  const store = getDefaultDeviceExporterStore();
  if (typeof store.listSourceInstanceHeartbeatsByConnector !== "function") {
    return { axis: "unknown", cause: null, heartbeats: [], unreliable: false };
  }
  const connectorInstanceId = options.connectorInstanceId ?? null;
  try {
    // Scope to a single `connector_instance_id` when the caller knows it.
    // Two enrolled devices that share a `connector_id` (e.g. two Claude
    // Code laptops) project independent rows; without this scope a stalled
    // heartbeat on device A would degrade device B's connection-health pill.
    const rows = (await store.listSourceInstanceHeartbeatsByConnector(
      connectorId,
      connectorInstanceId === null ? undefined : { connectorInstanceId }
    )) as readonly HeartbeatRow[];
    const result = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: new Date().toISOString() });
    return { axis: result.axis, cause: result.cause, heartbeats: rows, unreliable: result.unreliable };
  } catch {
    return { axis: "unknown", cause: null, heartbeats: [], unreliable: true };
  }
}

function combineUnreliableSources(
  detailGapsUnreliable: boolean,
  outboxUnreliable: boolean,
  attentionUnreliable = false,
  remoteSurfaceUnreliable = false,
  evidenceUnreliableSources: readonly string[] = []
): readonly string[] {
  const sources: string[] = [];
  if (detailGapsUnreliable) {
    sources.push("detail_gaps");
  }
  if (outboxUnreliable) {
    sources.push("outbox");
  }
  if (attentionUnreliable) {
    sources.push("attention_store");
  }
  if (remoteSurfaceUnreliable) {
    sources.push("remote_surface_store");
  }
  sources.push(...evidenceUnreliableSources);
  return sources;
}

/**
 * Feed the connector-summary evidence row's orthogonal component states
 * into the existing highest-precedence `ProjectionReliable` fail-closed
 * condition (see `runtime/connection-health.ts`
 * `projectionReliableCondition`/`classifyUnreliableProjection`): any
 * non-current `record_snapshot`/`terminal_facts`/`manifest_declaration`, or
 * a current-manifest stream marked `unexpected`, forces the connection
 * unknown regardless of otherwise-healthy run/coverage evidence. `null`
 * evidence (barrier could not produce a row) is itself unreliable — never
 * treated as "nothing to report."
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 *       "Health boundary"
 */
function evidenceUnreliableSources(
  evidence: ConnectorSummaryEvidenceRow | null,
  evidenceReadFailed = false
): readonly string[] {
  if (!evidence) {
    // A total read failure is distinct from a genuine "no evidence row
    // exists yet" (design.md task 5.4): both read `evidence === null` here,
    // but only the former means the read itself could not be trusted.
    return evidenceReadFailed ? ["summary_evidence_read_failed"] : ["summary_missing"];
  }
  const sources: string[] = [];
  if (evidence.record_snapshot.state !== "current") {
    sources.push(evidence.record_snapshot.reason_code || "record_checkpoint_lag");
  }
  if (evidence.terminal_facts.state !== "current") {
    sources.push(evidence.terminal_facts.reason_code || "terminal_fold_failed");
  }
  if (evidence.manifest_declaration.state !== "current") {
    sources.push(evidence.manifest_declaration.reason_code || "manifest_unavailable");
  }
  const hasUnexpectedDeclaredStream =
    evidence.manifest_declaration.state === "current" &&
    evidence.stream_records.some((entry) => entry.declaration_state === "unexpected");
  if (hasUnexpectedDeclaredStream) {
    sources.push("manifest_declaration_unexpected_stream");
  }
  // Defensive backstop (design.md "fail closed"): even if some future code
  // path fails to degrade a component state correctly, the row's own
  // generic honesty envelope (`dirty`/`state`) is a second, independent
  // signal that this pass's evidence cannot be trusted as fully current.
  // Only fires when none of the three component checks above already
  // pushed a reason — a component check firing already forces the
  // connection unknown, so a redundant generic reason would be a
  // duplicate, not a correction.
  const NON_FRESH_STATES = new Set(["stale", "failed", "unknown", "rebuilding"]);
  if (sources.length === 0 && (evidence.dirty === true || NON_FRESH_STATES.has(evidence.state))) {
    sources.push("summary_evidence_dirty_backstop");
  }
  return sources;
}

/**
 * Map durable pending-gap summaries onto the cooldown governor's
 * `PendingPressureGap` shape so the runtime source-pressure backlog derivation
 * can reason-scope and roll them up. Reads only the non-secret count/reason/
 * timestamp fields the rollup needs; never the locator, payload, or source
 * identity. Reason-filtering and the floor/null honesty rules live in
 * `deriveSourcePressureBacklog`, not here.
 */
/**
 * Lifecycles the connection-health projection treats as "open" for a
 * structured attention record. `attention.isHealthRelevant` enforces
 * additional axes-based filtering on top of this.
 */
const OPEN_LIFECYCLES = new Set(["acknowledged", "in_progress", "open"]);

/**
 * Pick the single most-urgent health-relevant structured attention record
 * for a connection, and project it onto the
 * `ConnectionAttentionEvidence` shape the runtime expects. Falls back to
 * the schedule's `human_attention_needed` flag when no structured record
 * is present, so the projection stays compatible with controllers that
 * have not yet adopted the durable attention store.
 *
 * The fallback emits a `ConnectionAttentionEvidence` with `id: null` and
 * `ownerAction: null`, which causes
 * `connection-health::projectNextAction` to mark the CTA's `source` as
 * `schedule_fallback` — the dashboard renders a caveated "owner action
 * needed" without inventing precision the evidence cannot support.
 *
 * Returns `null` when there is no open attention and no schedule flag,
 * so the projection falls through to the next precedence rung.
 */
function selectAttentionEvidence(input: {
  readonly attentionRecords: readonly AttentionRecord[];
  readonly humanAttentionNeeded: boolean;
  readonly lastErrorCode: string | null;
  readonly nowIso: string;
}): ConnectionAttentionEvidence | null {
  const candidates = input.attentionRecords.filter(
    (record) => OPEN_LIFECYCLES.has(record.lifecycle) && isHealthRelevant(record, input.nowIso)
  );
  const [first, ...restCandidates] = candidates;
  if (first) {
    const picked = pickMostUrgentAttention([first, ...restCandidates]);
    return {
      actionTarget: picked.action_target,
      expiresAt: picked.expires_at,
      id: picked.id,
      lifecycle: picked.lifecycle as ConnectionAttentionEvidence["lifecycle"],
      ownerAction: ownerActionForEvidence(picked.owner_action),
      reasonCode: picked.reason_code,
      responseContract: picked.response_contract,
      runId: picked.run_id,
      sensitivity: picked.sensitivity,
      notificationState: pickedNotificationState(picked),
    };
  }
  if (input.humanAttentionNeeded) {
    return {
      actionTarget: null,
      expiresAt: null,
      id: null,
      lifecycle: "open",
      ownerAction: null,
      reasonCode: input.lastErrorCode ?? "needs_human_attention",
      responseContract: null,
      runId: null,
      notificationState: null,
    };
  }
  return null;
}

/**
 * Pick the most-urgent record from a non-empty list of health-relevant
 * candidates. Urgency ordering:
 *
 *   1. `response_required` beats observability-only.
 *   2. Blocked posture beats running.
 *   3. Sooner expiry beats later/no expiry.
 *   4. Earliest `created_at` as a stable tiebreak (don't flip CTAs on
 *      every refresh when two records are equally urgent).
 */
function ownerActionForEvidence(action: OwnerAction): ConnectionAttentionEvidence["ownerAction"] {
  if (action === "none") {
    return null;
  }
  return action;
}

/**
 * Read the durable notification axis off the persisted attention record.
 * Older rows persisted before the `notification_state` field landed
 * default to `"pending"` so the projection stays honest without
 * fabricating delivery evidence. Returns a non-null, non-undefined
 * value so the projection contract stays exact.
 */
function pickedNotificationState(
  record: AttentionRecord
): "acknowledged" | "failed" | "pending" | "sent" | "suppressed" {
  const raw = (record as { notification_state?: unknown }).notification_state;
  if (raw === "acknowledged" || raw === "failed" || raw === "pending" || raw === "sent" || raw === "suppressed") {
    return raw;
  }
  return "pending";
}

/**
 * Roll the browser-surface lease store's per-connector evidence into a
 * single {@link ConnectionRemoteSurfaceEvidence} the connection-health
 * projection consumes.
 *
 * Live evidence sources:
 *
 *   - `browser_surfaces` rows — durable surface instances and their
 *     `health` (`ready | starting | stopping | unhealthy`). An
 *     `unhealthy` surface is the canonical live failure signal: when
 *     the allocator marks a surface unhealthy, the runtime turns any
 *     in-flight lease terminal and stops dispatching new runs at it
 *     until it heals or is replaced.
 *   - `listNonTerminalLeases()` — leases currently queued, starting,
 *     or held against a surface. Terminal failure rows
 *     (`surface_failed`) are not returned here; their effect is
 *     reflected in the surface row's `health` instead.
 *
 * Urgency rollup (one axis per connection, most-urgent first):
 *
 *   1. any unhealthy surface or any non-terminal lease whose backing
 *      surface is unhealthy -> `failed` (design.md: capacity failure
 *      degrades the connection);
 *   2. an active `leased` lease against a ready surface -> `leased`;
 *   3. a `waiting_for_browser_surface` / `starting_surface` lease ->
 *      `waiting`;
 *   4. a managed surface with no active lease -> `idle`;
 *   5. no rows at all -> `none` (host browser / API connector).
 *
 * When the store throws, we return `{ axis: "unknown", unreliable: true }`
 * so the projection can mark `remote_surface_store` as an unreliable
 * source and route the headline to `unknown` rather than silently
 * accepting a stale axis.
 */
export interface ConnectorBrowserSurfaceProjection {
  readonly evidence: ConnectionRemoteSurfaceEvidence | null;
  readonly unreliable: boolean;
}

interface BrowserSurfaceLeaseStoreReader {
  listLeases(): Promise<readonly BrowserSurfaceLease[]>;
  listNonTerminalLeases(): Promise<readonly BrowserSurfaceLease[]>;
  listSurfaces(): Promise<readonly BrowserSurface[]>;
}

/**
 * Project the most-urgent remote-surface evidence for a single connector
 * id from the durable browser-surface lease store. Returns `null`
 * evidence for connectors that have no managed remote surface at all
 * (host browser / API connectors), so they cannot be silently degraded
 * by the absence of a lease/surface row.
 */
function projectActiveBrowserSurfaceLease(
  picked: BrowserSurfaceLease,
  surface: BrowserSurface | undefined
): ConnectorBrowserSurfaceProjection | null {
  if (surface?.health === "unhealthy") {
    return {
      evidence: {
        axis: "failed",
        leaseId: picked.lease_id,
        leaseStatus: picked.status,
        profileKey: surface.profile_key,
        surfaceHealth: surface.health,
        surfaceId: surface.surface_id,
        waitReason: "surface_unhealthy",
      },
      unreliable: false,
    };
  }
  if (picked.status === "leased") {
    return {
      evidence: {
        axis: "leased",
        leaseId: picked.lease_id,
        leaseStatus: picked.status,
        profileKey: picked.profile_key,
        surfaceHealth: surface?.health ?? null,
        surfaceId: picked.surface_id ?? null,
        waitReason: null,
      },
      unreliable: false,
    };
  }
  if (ACTIVE_WAITING_LEASE_STATUSES.has(picked.status)) {
    return {
      evidence: {
        axis: "waiting",
        leaseId: picked.lease_id,
        leaseStatus: picked.status,
        profileKey: picked.profile_key,
        surfaceHealth: surface?.health ?? null,
        surfaceId: picked.surface_id ?? null,
        waitReason: picked.wait_reason ?? null,
      },
      unreliable: false,
    };
  }
  return null;
}

function projectIdleBrowserSurfaceFromSurface(surface: BrowserSurface): ConnectorBrowserSurfaceProjection {
  return {
    evidence: {
      axis: "idle",
      leaseId: null,
      leaseStatus: null,
      profileKey: surface.profile_key,
      surfaceHealth: surface.health,
      surfaceId: surface.surface_id,
      waitReason: null,
    },
    unreliable: false,
  };
}

function projectCurrentUnleasedBrowserSurfaceFailure(surface: BrowserSurface): ConnectorBrowserSurfaceProjection {
  return {
    evidence: {
      axis: "failed",
      leaseId: null,
      leaseStatus: null,
      profileKey: surface.profile_key,
      surfaceHealth: surface.health,
      surfaceId: surface.surface_id,
      waitReason: "surface_unhealthy",
    },
    unreliable: false,
  };
}

function projectNoCurrentBrowserSurfaceEvidence(
  connectorLeaseHistory: ReadonlySet<string>
): ConnectorBrowserSurfaceProjection {
  return connectorLeaseHistory.size > 0
    ? BROWSER_SURFACE_UNKNOWN_PROJECTION
    : {
        evidence: null,
        unreliable: false,
      };
}

function projectConnectorBrowserSurfaceEvidence(
  connectorLeases: readonly BrowserSurfaceLease[],
  connectorSurfaces: readonly BrowserSurface[],
  connectorLeaseHistory: ReadonlySet<string>
): ConnectorBrowserSurfaceProjection {
  const picked = pickMostUrgentLease(connectorLeases);
  if (picked) {
    const surface = picked.surface_id ? connectorSurfaces.find((s) => s.surface_id === picked.surface_id) : undefined;
    const projection = projectActiveBrowserSurfaceLease(picked, surface);
    if (projection) {
      return projection;
    }
  }

  if (connectorSurfaces.length === 0) {
    return projectNoCurrentBrowserSurfaceEvidence(connectorLeaseHistory);
  }

  const currentFailureSurface = pickMostRecentSurface(
    connectorSurfaces.filter(
      (item) => item.health === "unhealthy" && !item.active_lease_id && !connectorLeaseHistory.has(item.surface_id)
    )
  );
  if (currentFailureSurface) {
    return projectCurrentUnleasedBrowserSurfaceFailure(currentFailureSurface);
  }

  const surface = pickMostRecentCurrentSurface(connectorSurfaces);
  if (surface) {
    return projectIdleBrowserSurfaceFromSurface(surface);
  }

  return BROWSER_SURFACE_UNKNOWN_PROJECTION;
}

const BROWSER_SURFACE_UNRELIABLE_PROJECTION: ConnectorBrowserSurfaceProjection = {
  evidence: {
    axis: "unknown",
    leaseId: null,
    leaseStatus: null,
    profileKey: null,
    surfaceHealth: null,
    surfaceId: null,
    waitReason: null,
  },
  unreliable: true,
};

const BROWSER_SURFACE_UNKNOWN_PROJECTION: ConnectorBrowserSurfaceProjection = {
  evidence: {
    axis: "unknown",
    leaseId: null,
    leaseStatus: null,
    profileKey: null,
    surfaceHealth: null,
    surfaceId: null,
    waitReason: null,
  },
  unreliable: false,
};

export async function getConnectorBrowserSurfaceProjection(
  connectorId: string,
  options: { readonly profileKey?: string | null; readonly store?: BrowserSurfaceLeaseStoreReader } = {}
): Promise<ConnectorBrowserSurfaceProjection> {
  const store = options.store ?? (getDefaultBrowserSurfaceLeaseStore() as BrowserSurfaceLeaseStoreReader);
  let leases: readonly BrowserSurfaceLease[];
  let allLeases: readonly BrowserSurfaceLease[];
  let surfaces: readonly BrowserSurface[];
  try {
    [leases, allLeases, surfaces] = await Promise.all([
      store.listNonTerminalLeases(),
      store.listLeases(),
      store.listSurfaces(),
    ]);
  } catch {
    return BROWSER_SURFACE_UNRELIABLE_PROJECTION;
  }

  const matchesProfile = (profileKey: string | null | undefined): boolean =>
    !options.profileKey || profileKey === options.profileKey;
  const connectorLeases = leases.filter(
    (lease) => lease.connector_id === connectorId && matchesProfile(lease.profile_key)
  );
  const connectorSurfaces = surfaces.filter(
    (surface) => surface.connector_id === connectorId && matchesProfile(surface.profile_key)
  );
  const connectorLeaseHistory = new Set(
    allLeases
      .filter(
        (lease): lease is BrowserSurfaceLease & { readonly surface_id: string } =>
          lease.connector_id === connectorId &&
          matchesProfile(lease.profile_key) &&
          typeof lease.surface_id === "string" &&
          lease.surface_id.length > 0
      )
      .map((lease) => lease.surface_id)
  );

  if (connectorLeases.length === 0 && connectorSurfaces.length === 0) {
    // Host browser / API connector — no managed remote surface. Routine
    // absence of evidence, not unreliable evidence.
    return projectNoCurrentBrowserSurfaceEvidence(connectorLeaseHistory);
  }

  // 1-2. Active lease evidence is the freshest signal. A stale unhealthy
  // surface from an earlier failed launch must not poison a connection that
  // subsequently leased a ready surface successfully.
  const projection = projectConnectorBrowserSurfaceEvidence(connectorLeases, connectorSurfaces, connectorLeaseHistory);
  return projection;
}

/**
 * Reads the global browser-surface tables (`listNonTerminalLeases`,
 * `listLeases`, and `listSurfaces`) ONCE and returns a
 * {@link BrowserSurfaceLeaseStoreReader} that replays the snapshot for every
 * connector. `getConnectorBrowserSurfaceProjection` already filters those
 * global rows by `connector_id` in memory, so the rows do not depend on which
 * connector is asking — reading them once per `listConnectorSummaries` call
 * instead of once per connector turns a 3N full-table read into 3. The
 * per-connector projection (filter / pick / classify) is unchanged.
 *
 * Failure parity: if the single snapshot read throws, the returned reader
 * re-throws on every call, so each connector still routes through the existing
 * per-projection `catch` to `BROWSER_SURFACE_UNRELIABLE_PROJECTION`. The output
 * is byte-identical to the prior per-connector reads on both the success and the
 * store-outage paths; only the query count drops.
 */
export async function loadSharedBrowserSurfaceReader(
  injectedStore?: BrowserSurfaceLeaseStoreReader
): Promise<BrowserSurfaceLeaseStoreReader> {
  const store = injectedStore ?? (getDefaultBrowserSurfaceLeaseStore() as BrowserSurfaceLeaseStoreReader);
  let snapshot: {
    leases: readonly BrowserSurfaceLease[];
    allLeases: readonly BrowserSurfaceLease[];
    surfaces: readonly BrowserSurface[];
  } | null = null;
  let snapshotError: unknown = null;
  try {
    const [leases, allLeases, surfaces] = await Promise.all([
      store.listNonTerminalLeases(),
      store.listLeases(),
      store.listSurfaces(),
    ]);
    snapshot = { leases, allLeases, surfaces };
  } catch (err) {
    snapshotError = err;
  }
  // The replay accessors return resolved/rejected promises rather than `async`
  // closures: there is nothing left to await once the snapshot is captured, and
  // the reject branch preserves the prior per-connector failure path so each
  // projection still routes to `BROWSER_SURFACE_UNRELIABLE_PROJECTION`.
  return {
    listLeases: () => (snapshot === null ? Promise.reject(snapshotError) : Promise.resolve(snapshot.allLeases)),
    listNonTerminalLeases: () => (snapshot === null ? Promise.reject(snapshotError) : Promise.resolve(snapshot.leases)),
    listSurfaces: () => (snapshot === null ? Promise.reject(snapshotError) : Promise.resolve(snapshot.surfaces)),
  };
}

interface BackoffEvidenceProjection {
  readonly backoff: {
    readonly backoffApplied: boolean;
    readonly consecutiveFailures: number;
    readonly nextRunAt: string | null;
    readonly reasonClass: string | null;
  } | null;
  readonly schedulerFailureStatus: "failed" | null;
}

interface ConnectionHealthScheduleEvidence {
  readonly activeRunId: string | null;
  readonly backoffEvidence: BackoffEvidenceProjection;
  readonly humanAttentionNeeded: boolean;
  readonly lastErrorCode: string | null;
  readonly lastSuccessfulAt: string | null;
  readonly schedule: { readonly enabled: boolean } | null;
}

function projectConnectionHealthScheduleEvidence(
  schedule: Record<string, unknown> | null,
  lastRun: ConnectorRunSummary | null,
  activeRunId: string | null
): ConnectionHealthScheduleEvidence {
  const schedulerBackoff = asBackoffRecord(schedule);
  const staleSchedulerBackoff = succeededRunSupersedesSchedulerBackoff(lastRun, schedule);
  const effectiveSchedulerBackoff = staleSchedulerBackoff ? null : schedulerBackoff;
  const scheduleActiveRunId =
    typeof schedule?.active_run_id === "string" && schedule.active_run_id ? schedule.active_run_id : null;
  const nextDueAt = !staleSchedulerBackoff && typeof schedule?.next_due_at === "string" ? schedule.next_due_at : null;
  const lastErrorCode =
    !staleSchedulerBackoff && typeof schedule?.last_error_code === "string" ? schedule.last_error_code : null;
  const lastSuccessfulAt = typeof schedule?.last_successful_at === "string" ? schedule.last_successful_at : null;
  return {
    activeRunId: activeRunId ?? scheduleActiveRunId,
    backoffEvidence: projectSchedulerBackoffEvidence({
      effectiveSchedulerBackoff,
      lastErrorCode,
      nextDueAt,
    }),
    humanAttentionNeeded: schedule?.human_attention_needed === true,
    lastErrorCode,
    lastSuccessfulAt,
    schedule: schedule ? { enabled: schedule.enabled !== false } : null,
  };
}

function buildLocalDeviceCollectionEvidence(input: {
  readonly coverage: { readonly axis: CoverageAxis };
  readonly freshnessAxis: FreshnessAxis;
  readonly localDeviceBacked: boolean | undefined;
  readonly outbox: { readonly axis: OutboxAxis; readonly cause?: OutboxStalledCause | null };
}): ConnectionLocalDeviceCollectionEvidence | null {
  if (
    input.localDeviceBacked === true &&
    input.outbox.axis === "idle" &&
    input.coverage.axis === "complete" &&
    input.freshnessAxis === "fresh"
  ) {
    return { verdict: "succeeded" };
  }
  return null;
}

export function projectConnectorSummaryConnectionHealth(input: {
  readonly activeRun?: ActiveRunRecord | null;
  /**
   * Durable structured attention records the caller has already filtered
   * to this connection. The projection picks the most urgent
   * health-relevant record via `attention.isHealthRelevant`. When
   * omitted, the schedule's `human_attention_needed` flag is the only
   * (coarse) fallback.
   */
  readonly attentionRecords?: readonly AttentionRecord[];
  /**
   * Durable stored-credential presence evidence for this connection, read from
   * the connector-instance credential store (never the secret itself). Passed
   * straight through to {@link computeConnectionHealth} so the
   * `CredentialsValid` condition can distinguish "no usable stored credential"
   * from "stored credential rejected" instead of relying solely on a transient
   * run reason code. `null`/omitted preserves the prior run-reason-derived
   * behavior (e.g. connectors that cannot store a credential, or callers that
   * have not been wired to read the store).
   */
  readonly credential?: ConnectionCredentialEvidence | null;
  /** Typed, provider-originated proof for at most one connection-scoped repair. */
  readonly browserSurfaceRepair?: BrowserSurfaceRepairContext | null;
  /**
    * Connection/runtime capability proving that a session-required failure can
   * be repaired through an owner browser session. This is deliberately
   * independent of `remoteSurface`: an idle managed runtime has no active
   * lease, but it still has the same browser-session repair path.
   */
  readonly browserSessionRepairCapable?: boolean;
  readonly ephemeralBrowserRuntime?: EphemeralBrowserRuntimeProjection | null;
  readonly freshness: Freshness;
  readonly lastRun: ConnectorRunSummary | null;
  readonly lastSuccessfulRun: ConnectorRunSummary | null;
  /**
   * Coverage axis derived from durable local-collector `coverage_diagnostics`
   * records, used only as a fallback when no spine run exists to anchor
   * run-derived coverage (local-device collectors push from a device outbox and
   * write no run history). `null` means "no local coverage evidence read", which
   * preserves the prior behavior (run-derived axis, typically `unknown` for
   * local collectors). Never lets an empty/drained outbox imply `complete`.
   */
  readonly localCoverage?: LocalCoverageDiagnosticAxis | null;
  /**
   * Whether this connection is backed by a local-device collector
   * (`sourceKind === "local_device"`). Only the caller knows the source
   * kind. When `true`, the projection MAY establish the local-device
   * collection verdict — a trusted idle/drained outbox plus a `complete`
   * local coverage axis is the device-side analog of a succeeded run, so
   * `CollectionSucceeded` can be satisfied without a spine run. The verdict
   * is gated entirely here; the run path always takes precedence. Defaults
   * to `false`, preserving the prior behavior for scheduler-managed
   * connections (device evidence never greens them).
   */
  readonly localDeviceBacked?: boolean;
  /**
   * Manifest-declared streams. The projection reads each stream's
   * `required` flag and `coverage_policy` to roll up accepted-coverage
   * labels (`unsupported`, `unavailable`, `deferred`, `inventory_only`)
   * and to detect contradictory `required: true` + accepted-absent
   * declarations. Optional; omitting it preserves the prior behavior
   * (coverage axis ignores manifest policy).
   */
  readonly manifestStreams?: readonly ManifestStream[];
  /**
   * Wall-clock anchor for attention expiry/health-relevance checks.
   * Defaults to `new Date().toISOString()`; tests pass a fixed value.
   */
  readonly nowIso?: string;
  readonly outbox?: { axis: OutboxAxis; cause?: OutboxStalledCause | null };
  readonly pendingDetailGaps?: readonly PendingDetailGapSummary[];
  /**
   * `true` when the durable detail-gap evidence could not be read. Threaded
   * separately from {@link pendingDetailGaps} so the source-pressure backlog
   * rollup can distinguish "unreadable store" (`null` rollup) from "readable
   * but drained" (a real `0`). The same flag still feeds `unreliableSources`
   * via the caller; this carries it to the backlog derivation specifically.
   */
  readonly pendingDetailGapsUnreliable?: boolean;
  /**
   * The bound the caller applied when reading {@link pendingDetailGaps}. When
   * the returned rows hit it, the backlog `pending` count is reported as a
   * floor rather than an exact total. `null`/absent means the read was not
   * bounded.
   */
  readonly pendingDetailGapsReadLimit?: number | null;
  /**
   * Optional recovered-gap count from the store's reason-scoped
   * count-by-status aggregate, in the same connector + source-pressure reason
   * scope as {@link pendingDetailGaps}. `null`/absent when no aggregate was run
   * (the rollup then reports `recovered: null`, unmeasured — never a fabricated
   * `0`).
   */
  readonly pendingDetailGapsRecovered?: number | null;
  /** §10-A terminal-gap count (permanently unfillable); `null` when unmeasured. */
  readonly pendingDetailGapsTerminal?: number | null;
  /**
   * Pre-projected browser-surface evidence for the connection. The list
   * and detail operations read it via
   * {@link getConnectorBrowserSurfaceProjection}; tests pass synthetic
   * evidence. `null` means "host browser / API connector, no managed
   * remote surface" and never affects headline state. Omit the field
   * entirely for callers that have not opted into the remote-surface
   * axis.
   */
  readonly remoteSurface?: ConnectionRemoteSurfaceEvidence | null;
  /**
   * Manifest `capabilities.refresh_policy` (raw). The projection reads only
   * `background_safe` and `recommended_mode` to decide whether the connector
   * is manual / paused / background-unsafe — i.e. cannot auto-refresh, so
   * stale freshness is an owner-action advisory rather than a degradation.
   * Omitting it preserves the prior behavior (treated as schedulable;
   * staleness degrades).
   */
  /**
   * Adaptive collection rate controller snapshot derived from the latest run's
   * progress events. Passed through verbatim to `computeConnectionHealth` as a
   * pure annotation — no classification step reads it. `null`/absent when no
   * controller state has been observed for this connection.
   */
  readonly collectionRate?: CollectionRateSnapshot | null;
  readonly coverageOverride?: { readonly axis: CoverageAxis; readonly requiredButAccepted?: boolean } | null;
  readonly refreshPolicy?: unknown;
  readonly unreliableSources?: readonly string[];
  readonly schedule: unknown;
}): ConnectionHealthSnapshot {
  // Persisted source kind decides authority before health derives any scheduler
  // fact. A local device may have historical/foreign server runs, but they are
  // never evidence for its current device-side collection proof.
  const localDeviceBacked = input.localDeviceBacked === true;
  const authoritativeLastRun = localDeviceBacked ? null : input.lastRun;
  const authoritativeLastSuccessfulRun = localDeviceBacked ? null : input.lastSuccessfulRun;
  const authoritativeActiveRun = localDeviceBacked ? null : input.activeRun;
  const authoritativeCollectionRate = localDeviceBacked ? null : input.collectionRate;
  const authoritativeEphemeralBrowserRuntime = localDeviceBacked ? null : input.ephemeralBrowserRuntime;
  const authoritativeRemoteSurface = localDeviceBacked ? null : input.remoteSurface;
  const schedule = localDeviceBacked ? null : asScheduleRecord(input.schedule);
  const scheduleEvidence = projectConnectionHealthScheduleEvidence(
    schedule,
    authoritativeLastRun,
    authoritativeActiveRun?.run_id ?? null
  );
  const pendingDetailGaps = input.pendingDetailGaps ?? [];
  const latestRunForHealth = healthClassifyingRun(authoritativeLastRun);
  const coverageRunForHealth = coverageClassifyingRun(authoritativeLastRun, authoritativeLastSuccessfulRun);
  const nowIso = input.nowIso ?? new Date().toISOString();
  const attention = selectAttentionEvidence({
    attentionRecords: input.attentionRecords ?? [],
    humanAttentionNeeded: scheduleEvidence.humanAttentionNeeded,
    lastErrorCode: scheduleEvidence.lastErrorCode,
    nowIso,
  });
  const coverage = applyCoverageOverride(
    buildCoverageEvidence(
      coverageRunForHealth,
      pendingDetailGaps,
      input.manifestStreams ?? [],
      input.localCoverage ?? null
    ),
    input.coverageOverride
  );
  const outbox = input.outbox ?? { axis: "unknown" };
  const freshnessAxis = mapFreshnessAxis(input.freshness);
  // Local-device collection verdict: a local-device-backed connection whose
  // outbox is idle from trusted heartbeat evidence, whose resolved coverage is
  // `complete`, and whose freshness is genuinely `fresh` has finished a clean,
  // current collection cycle — the device-side analog of a recent succeeded
  // run. Establishing the verdict only when freshness is also `fresh` keeps
  // the change purely additive: a drained collector with complete coverage but
  // no satisfied freshness policy keeps `CollectionSucceeded` unknown and stays
  // `idle` exactly as before; only the fully-green case is upgraded to
  // `healthy`. The classifier still honors the verdict only when no run verdict
  // exists (a run is authoritative), and every degrading axis still wins via
  // the ordered precedence, so this can never green a stalled, gappy, stale, or
  // unproven connection. Scheduler-managed connections never reach here because
  // the caller passes `localDeviceBacked: false` for them.
  const localDeviceCollection = buildLocalDeviceCollectionEvidence({
    coverage,
    freshnessAxis,
    localDeviceBacked: input.localDeviceBacked,
    outbox,
  });
  // Source-pressure detail-gap backlog evidence: reuse the same durable pending
  // gaps already read for coverage/classification, mapped onto the cooldown
  // governor's gap shape. The runtime derivation
  // (`deriveSourcePressureBacklog`) reason-scopes them to source pressure and
  // applies the floor/null honesty rules. `null` is the unreadable signal.
  const detailGapBacklog: ConnectionDetailGapBacklogEvidence = {
    pendingGaps: mapPendingPressureGaps(pendingDetailGaps),
    readLimit: input.pendingDetailGapsReadLimit ?? null,
    recovered: input.pendingDetailGapsRecovered ?? null,
    terminal: input.pendingDetailGapsTerminal ?? null,
    unreadable: input.pendingDetailGapsUnreliable === true,
  };
  return computeConnectionHealth({
    activity: { active: scheduleEvidence.activeRunId !== null },
    attention,
    backoff: scheduleEvidence.backoffEvidence.backoff,
    browserSurfaceRepair: input.browserSurfaceRepair ?? null,
    collectionRate: authoritativeCollectionRate ?? null,
    coverage,
    credential: input.credential ?? null,
    browserSessionRepairCapable: input.browserSessionRepairCapable === true,
    detailGapBacklog,
    ephemeralBrowserRuntime: authoritativeEphemeralBrowserRuntime,
    freshness: { axis: freshnessAxis },
    localDeviceCollection,
    outbox,
    projection: { unreliableSources: input.unreliableSources ?? [] },
    refresh: buildRefreshEvidence(input.refreshPolicy),
    remoteSurface: authoritativeRemoteSurface ?? null,
    run: {
      hasDegradingGaps: hasPendingDetailGap(pendingDetailGaps) || hasDegradingKnownGap(latestRunForHealth),
      lastSuccessAt: authoritativeLastSuccessfulRun?.last_at ?? scheduleEvidence.lastSuccessfulAt,
      latestStatus: mapRunStatus(latestRunForHealth?.status) ?? scheduleEvidence.backoffEvidence.schedulerFailureStatus,
      reasonCode:
        // §10-C: a credential/auth signal buried in a known-gap takes priority
        // over a GENERIC top-level `failure_reason` (e.g. ChatGPT's terminal 401
        // surfaces as `connector_reported_failed`, which hides the auth cause and
        // produces a silent failure with no reconnect prompt). A SPECIFIC
        // failure_reason still wins — this only fires when the run reason is the
        // generic `connector_reported_failed` placeholder.
        credentialReasonFromGenericFailure(latestRunForHealth) ??
        latestRunForHealth?.failure_reason ??
        firstDegradingKnownGapReason(latestRunForHealth) ??
        firstPendingDetailGapReason(pendingDetailGaps) ??
        scheduleEvidence.lastErrorCode,
    },
    schedule: scheduleEvidence.schedule,
    observedAt: nowIso,
  });
}

function projectSchedulerBackoffEvidence(input: {
  readonly effectiveSchedulerBackoff: ReturnType<typeof asBackoffRecord>;
  readonly lastErrorCode: string | null;
  readonly nextDueAt: string | null;
}): BackoffEvidenceProjection {
  const { effectiveSchedulerBackoff, lastErrorCode, nextDueAt } = input;
  const backoffConsecutiveFailures = readNumber(effectiveSchedulerBackoff?.consecutive_failures) ?? 0;
  const hasRetryBackoffEvidence =
    effectiveSchedulerBackoff !== null &&
    (effectiveSchedulerBackoff.backoff_applied === true || backoffConsecutiveFailures > 0);
  if (!hasRetryBackoffEvidence) {
    return { backoff: null, schedulerFailureStatus: null };
  }
  const backoffNextRunAt =
    typeof effectiveSchedulerBackoff?.next_run_at === "string" ? effectiveSchedulerBackoff.next_run_at : nextDueAt;
  const backoffReasonClass =
    typeof effectiveSchedulerBackoff?.reason_class === "string"
      ? effectiveSchedulerBackoff.reason_class
      : lastErrorCode;
  return {
    backoff: {
      backoffApplied: effectiveSchedulerBackoff?.backoff_applied === true,
      consecutiveFailures: backoffConsecutiveFailures,
      nextRunAt: backoffNextRunAt,
      reasonClass: backoffReasonClass,
    },
    schedulerFailureStatus: "failed",
  };
}

export function buildConnectorFreshness({
  lastRun,
  lastSuccessfulRun,
  live,
  refreshPolicy,
  lastHeartbeatAt,
}: {
  lastRun: ConnectorRunSummary | null;
  lastSuccessfulRun: ConnectorRunSummary | null;
  live: RecordProjection;
  refreshPolicy: unknown;
  /**
   * For local-device (push-mode) connections, eligible heartbeat evidence is the
   * freshness anchor even if old scheduler rows exist. Omit or pass `null` for
   * scheduler-managed connections.
   */
  lastHeartbeatAt?: string | null;
}): Freshness {
  const localProgressAt = lastHeartbeatAt ?? null;
  const maximumStalenessSeconds = getMaximumStalenessSeconds(refreshPolicy);
  const freshness = deriveReferenceFreshness({
    lastAttemptedAt: lastRun?.last_at ?? null,
    lastAttemptStatus: lastRun?.status ?? null,
    lastSuccessfulRunAt: localProgressAt ?? lastSuccessfulRun?.last_at ?? null,
    maximumStalenessSeconds,
    recordLastUpdatedAt: localProgressAt ?? live.freshness.captured_at ?? null,
  });
  if (
    freshness.status === "unknown" &&
    freshness.captured_at &&
    maximumStalenessSeconds === null &&
    isManualRefreshPolicy(refreshPolicy)
  ) {
    return { ...freshness, status: "current" };
  }
  return freshness;
}

function localDeviceFreshnessHeartbeatAt(
  localDeviceProgress: LocalDeviceProgress | null,
  outbox: { readonly axis: OutboxAxis }
): string | null {
  if (!localDeviceProgress?.last_heartbeat_at) {
    return null;
  }
  if (outbox.axis === "active") {
    return localDeviceProgress.last_heartbeat_at;
  }
  if (
    outbox.axis === "idle" &&
    localDeviceProgress.last_heartbeat_status === "healthy" &&
    (localDeviceProgress.records_pending == null || localDeviceProgress.records_pending === 0)
  ) {
    return localDeviceProgress.last_heartbeat_at;
  }
  return null;
}

/**
 * Per-connector projection work fanout. Each list row triggers schedule,
 * run-spine, detail-gap, and heartbeat-rollup reads; without a bound the
 * dashboard's list call hits the DB with O(connectors × per-connector
 * queries) requests in flight at once. Eight is small enough to keep the
 * SQLite/Postgres work pool from thrashing while still letting most
 * deployments overlap most projections.
 */
export const LIST_CONNECTOR_SUMMARIES_CONCURRENCY = 8;

export function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { readonly onInFlightChange?: (inFlight: number) => void } = {}
): Promise<R[]> {
  return runWithConcurrency(items, limit, worker, options);
}

export interface ListConnectorSummariesOptions {
  readonly concurrency?: number;
  /**
   * Full list routes hydrate only singleton active sources: enough evidence to
   * avoid false "Checking" on unambiguous configured sources, without borrowing
   * connector-wide runs across duplicate accounts/devices. Scoped
   * connection/detail reads keep full evidence enabled.
   */
  readonly includeRunSummaries?: ConnectorRunSummaryInclusion;
  /** Test hook: invoked whenever the in-flight worker count changes. */
  readonly onInFlightChange?: (inFlight: number) => void;
}

type ConnectorRunSummaryInclusion = boolean | "singleton-active";

export type ConnectorSummariesCacheEntry = ConnectorSummaryCacheEntryForRuntime<ConnectorSummary>;

// In-flight-coalescing map ONLY (design.md "Central consumer and cache
// boundary": "the existing TTL/stale value cache is removed; only
// equivalent in-flight promise coalescing may remain"). No entry ever
// carries a value/freshUntil/staleUntil — the barrier inside
// `loadConnectorSummaryProjectionDeps` already reconciles on every read, so
// a cached verdict has nothing to add beyond deduping concurrent callers.
const connectorSummariesCache = new Map<string, ConnectorSummariesCacheEntry>();
let connectorSummariesCacheGeneration = 0;
const anonymousControllerCacheScopes = new WeakMap<object, string>();
let nextAnonymousControllerCacheScope = 0;

export function invalidateConnectorSummariesCache(): void {
  connectorSummariesCacheGeneration += 1;
  connectorSummariesCache.clear();
}

export type ConnectorSummariesCacheDecision = ConnectorSummariesCacheDecisionForRuntime;

export function decideConnectorSummariesCacheRead(
  entry: ConnectorSummariesCacheEntry | undefined
): ConnectorSummariesCacheDecision {
  return decideConnectorSummariesCacheReadForRuntime(entry);
}

function shouldCacheConnectorSummaries(options: ListConnectorSummariesOptions): boolean {
  // Coalesce only the all-list path. Hook/concurrency calls are explicit
  // diagnostics that must observe real worker behavior.
  return options.concurrency == null && options.onInFlightChange == null;
}

function connectorSummariesCacheStorageKey(): string {
  return isPostgresStorageBackend() ? "postgres" : getSqliteStoreCacheIdentity();
}

function controllerCacheScopeIdentity(controller: ControllerLike): string {
  const declaredScope = controller.getBrowserSurfaceRuntimeAllocatorScopeId?.();
  if (declaredScope) {
    return `allocator:${declaredScope}`;
  }
  // Legacy and test controllers do not declare an allocator scope. Keep their
  // cache entries isolated by controller object rather than collapsing all
  // dynamic readers into one process-global key.
  const objectController = controller as object;
  let scope = anonymousControllerCacheScopes.get(objectController);
  if (!scope) {
    nextAnonymousControllerCacheScope += 1;
    scope = `controller-instance:${nextAnonymousControllerCacheScope}`;
    anonymousControllerCacheScopes.set(objectController, scope);
  }
  return scope;
}

export function connectorSummariesCacheKey(
  controller?: ControllerLike | null,
  options: ListConnectorSummariesOptions = {}
): string {
  const storageKey = connectorSummariesCacheStorageKey();
  const controllerKey = controller == null ? "no-controller" : `controller:${controllerCacheScopeIdentity(controller)}`;
  let runDepth = "deep-runs";
  if (options.includeRunSummaries === false) {
    runDepth = "shallow-runs";
  } else if (options.includeRunSummaries === "singleton-active") {
    runDepth = "singleton-active-runs";
  }
  return `${storageKey}:${controllerKey}:${runDepth}`;
}

/**
 * Launch (or, via the caller's `decideConnectorSummariesCacheRead` check,
 * join) one compute for this key. Purely in-flight coalescing: the entry is
 * removed once the promise settles, success or failure, so the NEXT call
 * always re-runs the barrier + synthesis rather than serving a resolved
 * value. Concurrent callers during the in-flight window share this one
 * promise instead of each issuing their own barrier pass.
 */
function refreshConnectorSummariesCache(
  key: string,
  controller: ControllerLike | null | undefined,
  options: ListConnectorSummariesOptions
): Promise<ConnectorSummary[]> {
  const generation = connectorSummariesCacheGeneration;
  const promise = computeConnectorSummaries(controller, options);
  connectorSummariesCache.set(key, { generation, promise });
  const clearIfCurrent = () => {
    const current = connectorSummariesCache.get(key);
    if (current?.promise === promise && current.generation === generation) {
      connectorSummariesCache.delete(key);
    }
  };
  promise.then(clearIfCurrent, clearIfCurrent);
  return promise;
}

// Shared inputs for `projectConnectorSummaryForInstance`. These are the reads
// that are identical across every connection in one request (the registered
// manifests and the once-per-request browser-surface snapshot) plus the optional
// controller used to resolve schedules. Hoisting them keeps the single-connection
// projection and the all-connection list on the exact same per-connection code
// path, so the two cannot drift.
interface ConnectorSummaryProjectionDeps {
  readonly activeRunsByInstanceId: ReadonlyMap<string, ActiveRunRecord>;
  readonly controller?: ControllerLike | null | undefined;
  readonly getLatestRunHistoryForConnection: (
    connectorInstanceId: string,
    status?: string | null
  ) => Promise<SchedulerRunHistoryRecord | null>;
  readonly includeRunSummaries: ConnectorRunSummaryInclusion;
  /**
   * Durable per-stream latest-attempt evidence per connection, read from the
   * connector-summary read model in ONE batched query for the whole list
   * render — never per-connection history walking on the hot path.
   */
  readonly latestStreamFactsByInstanceId: ReadonlyMap<string, ReadonlyMap<string, LatestStreamFactRecord>>;
  /**
   * The maintained connector-summary evidence row per connection, read AFTER
   * the observation barrier reconciles it (see `loadConnectorSummaryProjectionDeps`).
   * Canonical `records`-authority counts/streams and the orthogonal
   * record_snapshot/terminal_facts/manifest_declaration/retained_bytes
   * component states; never re-derived from the live retained-size
   * projection here. Spec: openspec/changes/reconcile-active-summary-evidence.
   */
  readonly evidenceByInstanceId: ReadonlyMap<string, ConnectorSummaryEvidenceRow>;
  /**
   * `true` when the batched evidence read itself failed (e.g. the evidence
   * table/connection is unreachable), distinct from a genuine empty read.
   * Feeds a distinct `summary_evidence_read_failed` reason code into
   * `ProjectionReliable` instead of the ordinary per-connection
   * `summary_missing` code every connection would otherwise report
   * identically to "no evidence row exists yet" (design.md task 5.4).
   */
  readonly evidenceReadFailed: boolean;
  readonly listRunSummariesForConnector: (
    connectorId: string,
    status?: string | null
  ) => Promise<readonly SpineSummary[]>;
  readonly manifestsByConnectorId: ReadonlyMap<string, ConnectorManifest>;
  /**
   * The parse-layer result for each connector's manifest (design.md
   * "Orthogonal projection evidence" — manifest_declaration is independent
   * of every other axis, including basic listability). `manifestsByConnectorId`
   * always has an entry (a safe empty placeholder on parse failure) so
   * every OTHER capability-dependent read stays defensive; this map is the
   * one place synthesis learns whether that placeholder is standing in for
   * a real manifest.
   */
  readonly manifestDeclarationByConnectorId: ReadonlyMap<
    string,
    { readonly state: "current" | "unavailable"; readonly reasonCode: string | null }
  >;
  readonly retainedSizeSnapshot?: RetainedSizeProjectionSnapshot;
  /** One dynamic allocator inventory for this entire connection-summary refresh. */
  readonly runtimeInventory: BrowserSurfaceRuntimeInventorySnapshot | null;
  readonly runtimeOk: boolean;
  readonly sharedBrowserSurfaceReader: BrowserSurfaceLeaseStoreReader;
}

function isActiveVisibleConnectorInstance(
  instance: ConnectorInstanceRow,
  manifestsByConnectorId: ReadonlyMap<string, ConnectorManifest>,
  requireCatalogVisibility = true
): boolean {
  if (instance.status !== "active") {
    return false;
  }
  const manifest = manifestsByConnectorId.get(instance.connectorId);
  if (!manifest) {
    return false;
  }
  if (!requireCatalogVisibility) {
    return true;
  }
  return isPublicReferenceConnector(
    { connector_id: instance.connectorId, manifest: JSON.stringify(manifest) },
    manifest
  );
}

// `requireCatalogVisibility` (default true, the pre-existing behavior):
// whether "visible" additionally means catalog-listed. `getConnectorDetail`
// passes `false` — it is reached by an owner-addressed connector_id, not
// catalog browsing, so an unlisted connector's real singleton connection
// must still be eligible for the connector-wide run-summary fallback below
// (see `projectConnectorSummaryForInstance`'s call), matching this route's
// pre-e6610b946 connector-wide behavior instead of silently going quiet.
function countActiveVisibleConnectionsByConnectorId(
  rows: readonly ConnectorInstanceRow[],
  manifestsByConnectorId: ReadonlyMap<string, ConnectorManifest>,
  requireCatalogVisibility = true
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const instance of rows) {
    if (!isActiveVisibleConnectorInstance(instance, manifestsByConnectorId, requireCatalogVisibility)) {
      continue;
    }
    counts.set(instance.connectorId, (counts.get(instance.connectorId) ?? 0) + 1);
  }
  return counts;
}

function shouldHydrateRunSummariesForInstance(
  mode: ConnectorRunSummaryInclusion,
  instance: ConnectorInstanceRow,
  _activeVisibleConnectionCount: number
): boolean {
  if (mode === true) {
    return true;
  }
  if (mode === false) {
    return false;
  }
  // "singleton-active" controls legacy connector-wide fallback, not whether
  // exact connection-scoped evidence is allowed. `getLatestRunSummaryForConnection`
  // still refuses connector-wide fallback unless the connector has exactly one
  // active visible source, but skipping hydration here would also drop exact
  // `connector_instance_id` / browser-profile matches for multi-account
  // connectors and render them as indefinitely "checking".
  return instance.status === "active";
}

function createConnectorRunSummariesReader(): ConnectorSummaryProjectionDeps["listRunSummariesForConnector"] {
  const cache = new Map<string, Promise<readonly SpineSummary[]>>();
  return (connectorId, status = null) => {
    const key = `${connectorId}\n${status ?? ""}`;
    let promise = cache.get(key);
    if (!promise) {
      const filters = status
        ? { sourceKind: "connector", sourceId: connectorId, status, limit: 64 }
        : { sourceKind: "connector", sourceId: connectorId, limit: 64 };
      promise = listSpineCorrelations("run", filters).then((page) => page.summaries);
      cache.set(key, promise);
    }
    return promise;
  };
}

function groupRetainedSizeRowsByInstance(
  rows: readonly RecordProjectionRow[]
): Map<string, readonly RecordProjectionRow[]> {
  const map = new Map<string, RecordProjectionRow[]>();
  for (const row of rows) {
    if (!row.connector_instance_id) {
      continue;
    }
    const bucket = map.get(row.connector_instance_id) ?? [];
    bucket.push(row);
    map.set(row.connector_instance_id, bucket);
  }
  return map;
}

function groupRetainedSizeRowsByConnector(
  rows: readonly RecordProjectionRow[]
): Map<string, readonly RecordProjectionRow[]> {
  const map = new Map<string, RecordProjectionRow[]>();
  for (const row of rows) {
    if (!row.connector_id) {
      continue;
    }
    const bucket = map.get(row.connector_id) ?? [];
    bucket.push(row);
    map.set(row.connector_id, bucket);
  }
  return map;
}

async function loadRetainedSizeProjectionSnapshot(): Promise<RetainedSizeProjectionSnapshot> {
  const [streamRows, connectionRows] = await Promise.all([
    listRetainedSizeStreams({}) as Promise<readonly RecordProjectionRow[]>,
    listRetainedSizeConnections({}) as Promise<readonly RetainedSizeConnectionProjectionRow[]>,
  ]);
  const connectionsByInstanceId = new Map<string, RetainedSizeConnectionProjectionRow>();
  for (const row of connectionRows) {
    if (row.connector_instance_id) {
      connectionsByInstanceId.set(row.connector_instance_id, row);
    }
  }
  return {
    connectionsByInstanceId,
    streamsByConnectorId: groupRetainedSizeRowsByConnector(streamRows),
    streamsByInstanceId: groupRetainedSizeRowsByInstance(streamRows),
  };
}

function buildRenderedVerdictForSummary(input: {
  readonly collectionReport: readonly CollectionReportEntry[];
  readonly attentionRecords: readonly AttentionRecord[];
  readonly connectionHealth: ConnectionHealthSnapshot;
  readonly freshness: Freshness;
  readonly hasRecoveredDetailGaps: boolean;
  readonly localDeviceBacked: boolean;
  readonly manifestStreams: readonly VerdictManifestStreamLike[];
  readonly observedAt: string;
  readonly refreshPolicy: unknown;
  readonly retainedRecords: number;
  readonly runtimeOk: boolean;
  readonly schedule: unknown;
}): RenderedVerdict {
  const refresh = buildRefreshEvidence(input.refreshPolicy);
  const schedule = normalizeScheduleEvidence(input.schedule);
  const mode = progressMode({
    localDeviceBacked: input.localDeviceBacked,
    refresh,
    schedule,
    hasRecoveredDetailGaps: input.hasRecoveredDetailGaps,
  });
  const progressEvidence = buildProgressEvidence({
    mode,
    retainedRecords: input.retainedRecords,
    recordsCommittedLastRun: null,
    // `detailGaps.recovered` is a connector-wide all-time count-by-status, not a
    // per-run delta. Keep the exact count in owner-only detail; do not relabel it
    // as "last run" progress.
    gapsDrainedLastRun: null,
    lastRefreshedAt: input.freshness.captured_at ?? null,
    observedAt: input.observedAt,
  });
  const structuredAttention = selectAttentionEvidence({
    attentionRecords: input.attentionRecords,
    humanAttentionNeeded: false,
    lastErrorCode: null,
    nowIso: input.observedAt,
  });
  // Wave 10a (owner review, 2026-07-09): `reattach_schedule` (the
  // previously-declared-but-never-emitted "Resume schedule" action) is
  // emitted INSIDE `synthesizeConnectorVerdict`'s single synthesis pass —
  // never as a post-pass mutation — so `channel`/`forward_statement`/
  // `annotations`/`trace` are always derived from the SAME action set the
  // owner sees.
  const scheduleEvidence: ScheduleEvidence = {
    hasPriorSuccess: input.connectionHealth.last_success_at !== null,
    mode: scheduleModeFrom(scheduleApiShape(input.schedule)),
  };
  return synthesizeConnectorVerdict({
    attention: structuredAttention,
    snapshot: input.connectionHealth,
    report: input.collectionReport,
    manifestStreams: input.manifestStreams,
    refresh,
    progress: progressEvidence,
    runtimeOk: input.runtimeOk,
    scheduleEvidence,
  });
}

function normalizeScheduleEvidence(schedule: unknown): { readonly enabled: boolean } | null {
  if (!schedule || typeof schedule !== "object" || !("enabled" in schedule)) {
    return null;
  }
  return { enabled: Boolean((schedule as { enabled?: unknown }).enabled) };
}

/**
 * Narrow the opaque `schedule: unknown` boundary to the real `ScheduleApi`
 * field `scheduleModeFrom` (`owner-state.ts`) needs, without pretending the
 * caller has more evidence than it does. `null`/malformed input narrows to
 * `null` (manual — no schedule row), matching `scheduleModeFrom`'s own
 * "no schedule row" branch.
 *
 * Deliberately does NOT read `effective_mode`: `computeEffectiveMode`
 * (`controller.ts:1685-1696`) collapses operator-disabled and
 * system-ineligible-but-armed into the same `"paused"` value and never
 * returns `"manual"`, so it cannot serve as the owner-pause authority. The
 * row's own `enabled` flag is (see `scheduleModeFrom`'s doc comment).
 */
function scheduleApiShape(schedule: unknown): { readonly enabled: boolean } | null {
  if (!schedule || typeof schedule !== "object") {
    return null;
  }
  const row = schedule as { enabled?: unknown };
  if (typeof row.enabled !== "boolean") {
    return null;
  }
  return { enabled: row.enabled };
}

interface ConnectorSummarySynthesisInput {
  readonly acquisitionCoverage: Awaited<ReturnType<typeof getAcquisitionCoverageSummary>>;
  readonly activeRun: ActiveRunRecord | null;
  readonly attention: Awaited<ReturnType<typeof getConnectorAttentionProjection>>;
  readonly collectionRate: Awaited<ReturnType<typeof readLatestCollectionRateForRun>>;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  /**
   * Durable stored-credential presence evidence for this connection, pre-
   * fetched by the caller (kept out of this function so it stays a pure
   * projection over already-resolved inputs; see
   * {@link projectConnectorSummaryForInstance}). `null` for connectors that
   * cannot store a static-secret credential, or when the store was not
   * consulted.
   */
  readonly credential: ConnectionCredentialEvidence | null;
  readonly detailGaps: Awaited<ReturnType<typeof getConnectorDetailGapProjection>>;
  /**
   * The maintained connector-summary evidence row for THIS connection, read
   * AFTER the central observation barrier reconciled it, or `null` when the
   * barrier could not produce one (evidence-read failure). Canonical
   * `records`-authority stream_records/total_records/retained_bytes and the
   * orthogonal manifest_declaration/record_snapshot/terminal_facts
   * component states. Spec: openspec/changes/reconcile-active-summary-evidence.
   */
  readonly evidence: ConnectorSummaryEvidenceRow | null;
  /**
   * `true` when `evidence` is `null` because the batched evidence read
   * itself failed, not because no row exists yet. Feeds a distinct
   * `summary_evidence_read_failed` reason code (design.md task 5.4).
   */
  readonly evidenceReadFailed: boolean;
  readonly ephemeralBrowserRuntime: EphemeralBrowserRuntimeProjection | null;
  readonly instance: ConnectorInstanceRow;
  readonly lastRun: ConnectorRunSummary | null;
  readonly lastSuccessfulRun: ConnectorRunSummary | null;
  /**
   * Durable per-stream latest-attempt evidence for THIS connection from the
   * connector-summary read model, or `null` when none exists. Connection-
   * scoped by construction (keyed by connector_instance_id upstream).
   */
  readonly latestStreamFacts: ReadonlyMap<string, LatestStreamFactRecord> | null;
  readonly live: RecordProjection;
  readonly localCoverage: Awaited<ReturnType<typeof getConnectorLocalCoverageAxis>>;
  readonly manifest: ConnectorManifest;
  /**
   * The parse-layer manifest-declaration result (see
   * `resolveSummaryManifest`), authoritative over the evidence engine's own
   * `manifest_declaration` when it says `unavailable` — a malformed
   * manifest is known at parse time, before the observation barrier's
   * per-connection manifest-fingerprint comparison necessarily ran.
   */
  readonly manifestDeclaration: { readonly state: "current" | "unavailable"; readonly reasonCode: string | null };
  readonly nowIso: string;
  readonly outbox: Awaited<ReturnType<typeof getConnectorOutboxAxis>>;
  readonly refreshPolicy: ReturnType<typeof extractRefreshPolicy>;
  readonly remoteSurface: Awaited<ReturnType<typeof getConnectorBrowserSurfaceProjection>>;
  readonly runtimeOk: boolean;
  readonly schedule: Awaited<ReturnType<typeof getScheduleFrom>>;
}

function synthesizeConnectorSummary(input: ConnectorSummarySynthesisInput): ConnectorSummary {
  const {
    acquisitionCoverage,
    activeRun,
    attention,
    collectionRate,
    connectorId,
    connectorInstanceId,
    credential,
    detailGaps,
    evidence,
    evidenceReadFailed,
    ephemeralBrowserRuntime,
    instance,
    lastRun,
    lastSuccessfulRun,
    latestStreamFacts,
    live,
    localCoverage,
    manifest,
    manifestDeclaration,
    nowIso,
    outbox,
    refreshPolicy,
    remoteSurface,
    runtimeOk,
    schedule,
  } = input;
  const localDeviceBacked = instance.sourceKind === "local_device";
  const authoritativeActiveRun = localDeviceBacked ? null : activeRun;
  const authoritativeCollectionRate = localDeviceBacked ? null : collectionRate;
  const authoritativeEphemeralBrowserRuntime = localDeviceBacked ? null : ephemeralBrowserRuntime;
  const authoritativeLastRun = localDeviceBacked ? null : lastRun;
  const authoritativeLastSuccessfulRun = localDeviceBacked ? null : lastSuccessfulRun;
  const authoritativeLatestStreamFacts = localDeviceBacked ? null : latestStreamFacts;
  const healthRemoteSurface = connectionHealthRemoteSurface({
    runtime: authoritativeEphemeralBrowserRuntime,
    remoteSurface,
  });
  const browserSessionRepairCapable = connectionHasBrowserSessionRepairCapability(instance, manifest);
  const localDeviceProgress = localDeviceBacked ? projectLocalDeviceProgress(outbox.heartbeats) : null;
  // Push-mode freshness is device-progress based. An idle, healthy heartbeat
  // proves current collection; an active outbox proves the collector is checking
  // in and draining. Stalled/unknown outboxes remain load-bearing and do not get
  // greened by heartbeat freshness.
  const freshnessHeartbeatAt = localDeviceFreshnessHeartbeatAt(localDeviceProgress, outbox);
  const freshness = buildConnectorFreshness({
    lastRun: authoritativeLastRun,
    lastSuccessfulRun: authoritativeLastSuccessfulRun,
    live,
    refreshPolicy,
    lastHeartbeatAt: freshnessHeartbeatAt,
  });
  const healthInput: Parameters<typeof projectConnectorSummaryConnectionHealth>[0] = {
    attentionRecords: attention.records,
    browserSessionRepairCapable,
    collectionRate: authoritativeCollectionRate,
    credential,
    freshness,
    lastRun: authoritativeLastRun,
    lastSuccessfulRun: authoritativeLastSuccessfulRun,
    activeRun: authoritativeActiveRun,
    localCoverage,
    localDeviceBacked,
    manifestStreams: manifest.streams ?? [],
    outbox: { axis: outbox.axis, cause: outbox.cause },
    pendingDetailGaps: detailGaps.gaps,
    pendingDetailGapsReadLimit: detailGaps.readLimit,
    pendingDetailGapsRecovered: detailGaps.recovered,
    pendingDetailGapsTerminal: detailGaps.terminal,
    pendingDetailGapsUnreliable: detailGaps.unreliable,
    nowIso,
    refreshPolicy,
    ephemeralBrowserRuntime: authoritativeEphemeralBrowserRuntime,
    remoteSurface: healthRemoteSurface.evidence,
    unreliableSources: combineUnreliableSources(
      detailGaps.unreliable,
      outbox.unreliable,
      attention.unreliable,
      healthRemoteSurface.unreliable,
      evidenceUnreliableSources(evidence, evidenceReadFailed)
    ),
    schedule: localDeviceBacked ? null : schedule,
  };
  const initialConnectionHealth = projectConnectorSummaryConnectionHealth(healthInput);
  const connectorDisplayName = manifest.display_name || connectorId;
  const collectionReport = projectCollectionReport({
    lastRun: authoritativeLastRun,
    lastSuccessfulRun: authoritativeLastSuccessfulRun,
    latestStreamFacts: authoritativeLatestStreamFacts,
    connectionHealth: initialConnectionHealth,
    localCoverage,
    localDeviceBacked,
    manifestStreams: manifest.streams ?? [],
    pendingDetailGaps: detailGaps.gaps,
    pendingDetailGapsReadLimit: detailGaps.readLimit,
    terminalDetailGapsByStream: detailGaps.terminalByStream,
    refreshPolicy,
    schedule: localDeviceBacked ? null : normalizeScheduleEvidence(schedule),
  });
  // `refineConnectionHealthWithCollectionReport` owns both report-derived
  // overrides: the required-unknown coverage refusal and the proof-age
  // freshness anchor (oldest required-stream proof). The owner-facing
  // `freshness` payload field keeps reporting record recency; only the
  // health projection ages against the proof anchor.
  const connectionHealth = refineConnectionHealthWithCollectionReport(
    healthInput,
    initialConnectionHealth,
    collectionReport
  );
  const recoveredCount = detailGaps.recovered;
  const renderedVerdict = buildRenderedVerdictForSummary({
    collectionReport,
    attentionRecords: attention.records,
    connectionHealth,
    freshness,
    hasRecoveredDetailGaps: recoveredCount !== null && recoveredCount > 0,
    localDeviceBacked,
    manifestStreams: (manifest.streams ?? []) as VerdictManifestStreamLike[],
    observedAt: nowIso,
    refreshPolicy,
    retainedRecords: live.totalRecords,
    runtimeOk,
    schedule: localDeviceBacked ? null : schedule,
  });
  // Owner review, 2026-07-09: reuse `coverageClassifyingRun` — the SAME
  // classifying run health/coverage already resolved to — so an
  // owner-cancelled `lastRun` is excluded exactly like the health/coverage
  // projection, never labeled `latest_terminal_run`/frozen using its own
  // timestamp when the rendered verdict actually came from
  // `lastSuccessfulRun`. `freshness.captured_at` is genuinely nullable; with
  // no classifying run and no freshness proof, `source` is `"none"` and
  // `as_of` is `null` — never fabricated from projection read time (design
  // gate #4).
  const causalEvidence = ownerStateCausalEvidenceFrom(
    classifiedRunForOwnerState(authoritativeLastRun, authoritativeLastSuccessfulRun),
    freshness.captured_at ?? null
  );
  const ownerStateEvidence: OwnerStateEvidence = activeRun
    ? {
        as_of: activeRun.started_at,
        lifecycle: { status: instance.status ?? "active" },
        progress: { active: true },
        schedule_mode: scheduleModeFrom(scheduleApiShape(localDeviceBacked ? null : schedule)),
        source: "active_progress",
      }
    : {
        as_of: causalEvidence.as_of,
        lifecycle: { status: instance.status ?? "active" },
        progress: { active: false },
        schedule_mode: scheduleModeFrom(scheduleApiShape(localDeviceBacked ? null : schedule)),
        source: causalEvidence.source,
      };
  const ownerState = deriveOwnerState(renderedVerdict, connectionHealth, ownerStateEvidence);
  // Canonical-authority override (design.md "Authorities"): when the
  // observation barrier produced an evidence row, its stream_records/
  // total_records/retained_bytes — sourced from canonical `records WHERE
  // deleted = false` and clean retained-size rows only — supersede the
  // legacy live-projection derivation below. `evidence: null` (barrier
  // read failure) falls back to the live projection rather than fabricating
  // zeros; `ProjectionReliable` above already carries the failure signal via
  // `evidenceUnreliableSources`, so connection_health still reports unknown.
  //
  // `record_snapshot.state !== "current"` (repair failed, or the row is
  // durably marked stale/failed by discovery — see `evidenceUnreliableSources`)
  // means the maintained `stream_records_json` predates the failure: the
  // checkpoint may have already moved past what it reflects. Sol P2.3: a
  // stale row's stream entries must NOT keep reading `known`/`known_zero`
  // (an exact-count claim) once the component backing that count is no
  // longer current — spec.md's `stale` count state exists exactly for this
  // ("prior count may be retained after its checkpoint moved or repair
  // failed"), so the ORIGINAL count is kept as a non-authoritative hint
  // while `count_state` itself is corrected to `stale`. A stream that was
  // already `unobserved`/`stale`/`unknown` (never had a trustworthy count
  // to begin with) is left as-is — this only downgrades a component that
  // WAS trustworthy (`known`/`known_zero`) and no longer is.
  const recordSnapshotCurrent = evidence ? evidence.record_snapshot.state === "current" : false;
  const streamRecords: readonly StreamRecordSummary[] = evidence
    ? evidence.stream_records.map((entry) => ({
        stream: entry.stream,
        record_count: entry.record_count,
        last_updated: null,
        declaration_state: entry.declaration_state,
        count_state:
          !recordSnapshotCurrent && (entry.count_state === "known" || entry.count_state === "known_zero")
            ? "stale"
            : entry.count_state,
        retained_record_count: entry.retained_record_count,
      }))
    : projectStreamRecordSummariesWithDeclaredZeros(live.byStream, manifest.streams, live.retainedSizeReliable);
  const totalRecords = evidence ? evidence.total_records : live.totalRecords;
  // Same downgrade `streamRecords` above already applies per-stream (Sol
  // P1.3): a non-current record_snapshot means the stored `totalRecords`
  // value predates the failure, so it must never read as an authoritative
  // exact count alongside it. `unobserved` (no evidence row at all) is
  // distinct from `stale` (an evidence row exists but its snapshot is not
  // current) — both are non-authoritative, but `stale` additionally implies
  // "we once knew a real value, unverified since."
  const totalRecordsState: ConnectorSummary["total_records_state"] = !evidence
    ? "unobserved"
    : recordSnapshotCurrent
      ? totalRecords > 0
        ? "known"
        : "known_zero"
      : "stale";
  const retainedBytes = evidence ? evidence.retained_bytes : live.retainedBytes;
  const totalRetainedBytes = evidence ? evidence.total_retained_bytes : (live.retainedBytes?.total_bytes ?? null);
  return {
    acquisition_coverage: acquisitionCoverage,
    collection_report: collectionReport,
    connection_id: connectorInstanceId,
    connection_health: connectionHealth,
    connector_display_name: connectorDisplayName,
    connector_id: connectorId,
    connector_instance_id: connectorInstanceId,
    display_name: instance.displayName || connectorDisplayName,
    source_kind: instance.sourceKind,
    source_binding_kind: connectionBindingKind(instance),
    local_device_progress: localDeviceProgress,
    // The parse-layer result is authoritative when it says `unavailable`:
    // it is known at parse time, independent of whether the observation
    // barrier's per-connection evidence row exists yet. Only when parsing
    // succeeded does the maintained evidence row's own
    // manifest_declaration (or its `unavailable`-on-no-evidence fallback)
    // apply.
    manifest_declaration:
      manifestDeclaration.state === "unavailable"
        ? { state: "unavailable", as_of: null, reason_code: manifestDeclaration.reasonCode }
        : evidence
          ? evidence.manifest_declaration
          : { state: "unavailable", as_of: null, reason_code: "summary_evidence_unavailable" },
    manifest_version: manifest.version || null,
    next_action: connectionHealth.next_action,
    owner_state: ownerState,
    record_snapshot: evidence
      ? evidence.record_snapshot
      : { state: "unobserved", as_of: null, reason_code: "summary_evidence_unavailable" },
    terminal_facts: evidence
      ? evidence.terminal_facts
      : { state: "unobserved", event_seq: null, as_of: null, reason_code: "summary_evidence_unavailable" },
    rendered_verdict: renderedVerdict,
    retained_bytes: retainedBytes,
    retained_bytes_evidence: evidence
      ? evidence.retained_bytes_evidence
      : { state: "unobserved", as_of: null, reason_code: "summary_evidence_unavailable" },
    revoked_at: instance.revokedAt ?? null,
    streams: (manifest.streams || []).map((stream) => stream.name),
    stream_count: evidence ? evidence.stream_count : streamRecords.length,
    stream_records: streamRecords,
    status: instance.status ?? null,
    total_records: totalRecords,
    total_records_state: totalRecordsState,
    total_retained_bytes: totalRetainedBytes,
    freshness,
    refresh_policy: refreshPolicy,
    schedule: localDeviceBacked ? null : schedule,
    last_run: authoritativeLastRun,
    last_successful_run: authoritativeLastSuccessfulRun,
  };
}

// Non-secret credential-store metadata shape read by `getMetadata` (see
// `stores/connector-instance-credential-store.js` `projectMetadata`). Only the
// fields this projection needs; never carries `sealed_secret`.
interface CredentialStoreMetadata {
  readonly present?: boolean;
  readonly rejected?: boolean;
  readonly status?: string | null;
}

// Distinct result of the non-secret credential-store read, so a store READ
// FAILURE is never conflated with a genuine NO-ROW result. A failed read must
// not project "no usable credential" (which would falsely tell the owner to
// reconnect a credentialed connection); it yields evidence-unavailable instead,
// preserving the prior run-reason-derived behavior.
//   - { ok: true,  metadata: null }   → getMetadata succeeded, no stored row.
//   - { ok: true,  metadata: {...} }  → getMetadata succeeded, stored row.
//   - { ok: false }                   → getMetadata threw (store/DB error).
type CredentialMetadataRead =
  | { readonly ok: true; readonly metadata: CredentialStoreMetadata | null }
  | { readonly ok: false };

// Connection binding kinds whose PRIMARY auth is an owner-authenticated browser
// session, not a stored credential. A connection bound this way repairs by
// browser/session repair (re-establish the session), never by static-secret
// credential capture — even when the connector also supports a username_password
// static secret at the connector level (e.g. a ChatGPT connection that logs in
// via SSO through the browser). Keeping this as a connection-scoped binding fact,
// not a connector capability, is the "connection-binding-first repair selection"
// rule from define-connection-repair-routing.
const BROWSER_SESSION_BINDING_KINDS = new Set(["browser_collector", "browser_enrollment_shell"]);

function connectionBindingKind(instance: ConnectorInstanceRow): string | null {
  const binding = instance.sourceBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return null;
  }
  const kind = (binding as { readonly kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

function connectionIsBrowserSessionBound(instance: ConnectorInstanceRow): boolean {
  const kind = connectionBindingKind(instance);
  return kind !== null && BROWSER_SESSION_BINDING_KINDS.has(kind);
}

// A declared browser binding is a repair capability only when the manifest
// requires it. Optional browser access is placement flexibility, not proof that
// the connection's authentication can be repaired through a browser session.
// The per-connection binding remains the stronger proof and wins independently
// of manifest availability. This deliberately does not reuse the catalog
// modality classifier: that classifier answers whether a key is mentioned,
// whereas this health input needs a stable required-capability fact.
function manifestRequiresBrowserSessionRepair(manifest: ConnectorManifest): boolean {
  const browser = manifest.runtime_requirements?.bindings?.browser;
  return (
    browser !== null &&
    typeof browser === "object" &&
    !Array.isArray(browser) &&
    (browser as { readonly required?: unknown }).required === true
  );
}

function connectionHasBrowserSessionRepairCapability(
  instance: ConnectorInstanceRow,
  manifest: ConnectorManifest
): boolean {
  return connectionIsBrowserSessionBound(instance) || manifestRequiresBrowserSessionRepair(manifest);
}

// True when THIS connection is bound as static-secret and therefore repairs by
// stored-credential capture/rotation. A connection is static-secret-bound when
// the connector is static-secret-capable AND the connection is NOT browser-
// session-bound. (A future explicit auth-mode conversion would set the binding
// accordingly; this reads the binding, never guesses from the connector alone.)
function connectionIsStaticSecretBound(instance: ConnectorInstanceRow, staticSecretCapable: boolean): boolean {
  return staticSecretCapable && !connectionIsBrowserSessionBound(instance);
}

// Map manifest static-secret capability plus the non-secret credential-store
// read onto the honest `ConnectionCredentialEvidence` shape the
// `CredentialsValid` projection consumes. Never reads/logs the secret — only
// `getMetadata`'s projected `present`/`status`/`rejected` fields.
//
//   - Not static-secret-capable: `null` (prior run-reason-derived behavior
//     preserved unchanged for these connectors).
//   - Store read FAILED (`read.ok === false`): `null` — evidence unavailable,
//     NOT "no credential". A transient store/DB error must never surface as an
//     owner "reconnect" prompt; the projection falls back to run-reason evidence.
//   - Read succeeded, no stored row (`metadata === null`): `present: false` —
//     genuinely no usable stored credential (never captured, or deleted).
//   - Read succeeded, stored row present: `present` is true only when the
//     store's own `present` flag says so AND the status is not
//     `rejected`/`revoked`; `rejected` mirrors the store's `rejected` flag (also
//     true for a `revoked` status — an unresolved credential problem, not "no
//     credential ever captured").
function deriveCredentialEvidence(
  staticSecretBound: boolean,
  read: CredentialMetadataRead
): ConnectionCredentialEvidence | null {
  // Connection-binding-first: only a connection actually bound as static-secret
  // gets credential-presence evidence. A browser-session/browser_collector
  // connection authenticates by owner-authenticated browser session, NOT a
  // stored credential — for it, an absent credential row is normal, not a
  // repair need, so it must NOT project `credential_required`. Its repair is
  // browser/session repair, surfaced through run/session evidence + binding-first
  // console routing, never static-secret capture — even if the connector also
  // has connector-level username_password support.
  if (!staticSecretBound) {
    return null;
  }
  if (!read.ok) {
    return null;
  }
  const metadata = read.metadata;
  if (!metadata) {
    return { capable: true, present: false };
  }
  const rejected = metadata.rejected === true || metadata.status === "revoked";
  const present = metadata.present === true && !rejected;
  return { capable: true, present, rejected };
}

// Project one configured connection into its summary, or `null` when the
// connection is not a public reference connector / has no registered manifest.
// This is the single source of truth for a connection-summary item: both
// `listConnectorSummaries` (mapped over all instances) and
// `getConnectorSummaryForRoute` (one resolved instance) call it.
async function projectConnectorSummaryForInstance(
  instance: ConnectorInstanceRow,
  deps: ConnectorSummaryProjectionDeps,
  options: {
    readonly activeVisibleConnectionCount?: number;
    /**
     * Catalog-visibility gating (`isPublicReferenceConnector`) answers "should
     * this connector appear when browsing/listing configured connections?" —
     * correct for `listConnectorSummaries`/`getConnectorSummaryForRoute`
     * (both list surfaces, scoped or not). It is the wrong question for
     * `getConnectorDetail`: a connector reached by its own connector_id
     * (not discovered via catalog browsing) with a real, already-resolved
     * connection must still surface that connection's genuine data — an
     * owner-addressed connector_id is not catalog browsing. Defaults to
     * `true` (the pre-existing list/route behavior, unchanged).
     */
    readonly requireCatalogVisibility?: boolean;
  } = {}
): Promise<ConnectorSummary | null> {
  const {
    activeRunsByInstanceId,
    controller,
    getLatestRunHistoryForConnection,
    listRunSummariesForConnector,
    manifestsByConnectorId,
    manifestDeclarationByConnectorId,
    sharedBrowserSurfaceReader,
  } = deps;
  const connectorId = instance.connectorId;
  const connectorInstanceId = instance.connectorInstanceId;
  const manifest = manifestsByConnectorId.get(connectorId);
  if (!manifest) {
    return null;
  }
  const manifestDeclaration = manifestDeclarationByConnectorId.get(connectorId) ?? {
    state: "current" as const,
    reasonCode: null,
  };
  // A malformed/unparseable manifest is real, honest evidence about this
  // connection — never a reason to silently drop it from the owner's
  // summary list (design.md "Orthogonal projection evidence":
  // manifest_declaration is independent of every other axis, including
  // basic listability). `isPublicReferenceConnector`'s "is this connector
  // publicly listed" gate reads `manifest.capabilities.public_listing`,
  // which cannot be evaluated meaningfully when the manifest itself failed
  // to parse — an unparseable manifest is skipped past that gate rather
  // than treated as "not listed", and every capability-dependent field
  // below already reads through `manifest.streams ?? []` /
  // `manifest.capabilities?.x` on the safe empty placeholder, so nothing
  // fabricates a capability the real manifest never declared.
  if (
    (options.requireCatalogVisibility ?? true) &&
    manifestDeclaration.state === "current" &&
    !isPublicReferenceConnector({ connector_id: connectorId, manifest: JSON.stringify(manifest) }, manifest)
  ) {
    return null;
  }
  const browserSurfaceProfileKey = readBrowserSurfaceProfileKey(connectorId, connectorInstanceId, manifest);
  const activeVisibleConnectionCount = options.activeVisibleConnectionCount ?? 0;
  // Persisted source kind is the authority boundary, not a hint applied after
  // fetching scheduler history. Local-device connections never hydrate server
  // runs or schedules into the projection, even if stale rows still exist.
  const localDeviceBacked = instance.sourceKind === "local_device";
  const hydrateRunSummaries =
    !localDeviceBacked &&
    shouldHydrateRunSummariesForInstance(deps.includeRunSummaries, instance, activeVisibleConnectionCount);
  const live = await getConnectorRecordProjection(
    recordStorageConnectorIdForConnection(instance),
    connectorInstanceId,
    deps.retainedSizeSnapshot
  );
  // Connection-binding-first: credential-presence evidence is read only for a
  // connection actually BOUND as static-secret — the connector being static-
  // secret-capable is necessary but not sufficient. A browser-session
  // (`browser_collector`/`browser_enrollment_shell`) connection authenticates by
  // browser session, so its absent credential row is normal, not a repair need;
  // the store is not consulted and `credential` stays `null` (no false
  // `credential_required`). Its repair routes to browser/session repair via
  // run/session evidence + binding-first console routing.
  const staticSecretCapable = staticSecretCredentialCaptureFromManifest(manifest) !== null;
  const staticSecretBound = connectionIsStaticSecretBound(instance, staticSecretCapable);
  const nowIso = new Date().toISOString();
  const [
    schedule,
    lastRun,
    lastSuccessfulRun,
    detailGaps,
    outbox,
    attention,
    remoteSurface,
    localCoverage,
    acquisitionCoverage,
    credentialMetadata,
  ] = await Promise.all([
    localDeviceBacked ? Promise.resolve(null) : getScheduleFrom(controller, connectorId, { connectorInstanceId }),
    hydrateRunSummaries
      ? getLatestRunSummaryForConnection({
          activeVisibleConnectionCount,
          browserSurfaceProfileKey,
          connectorId,
          connectorInstanceId,
          getLatestRunHistoryForConnection,
          listRunSummariesForConnector,
        })
      : Promise.resolve(null),
    hydrateRunSummaries
      ? getLatestRunSummaryForConnection({
          activeVisibleConnectionCount,
          browserSurfaceProfileKey,
          connectorId,
          connectorInstanceId,
          getLatestRunHistoryForConnection,
          listRunSummariesForConnector,
          status: "succeeded",
        })
      : Promise.resolve(null),
    getConnectorDetailGapProjection(connectorId, connectorInstanceId),
    getConnectorOutboxAxis(connectorId, { connectorInstanceId }),
    getConnectorAttentionProjection(connectorId, { connectorInstanceId }),
    getConnectorBrowserSurfaceProjection(connectorId, {
      profileKey: browserSurfaceProfileKey,
      store: sharedBrowserSurfaceReader,
    }),
    localDeviceBacked ? getConnectorLocalCoverageAxis(connectorId, connectorInstanceId, nowIso) : Promise.resolve(null),
    getAcquisitionCoverageSummary(connectorInstanceId),
    staticSecretBound
      ? getConnectorCredentialStore()
          .getMetadata(connectorInstanceId)
          // Discriminate success (metadata may be null = no row) from a store
          // READ FAILURE. A failure must not be read as "no credential"; it
          // yields evidence-unavailable so the projection keeps its prior
          // run-reason behavior instead of a false owner reconnect prompt.
          .then((metadata): CredentialMetadataRead => ({ ok: true, metadata }))
          .catch((): CredentialMetadataRead => ({ ok: false }))
      : Promise.resolve<CredentialMetadataRead>({ ok: true, metadata: null }),
  ]);
  // Connections that are not static-secret-bound (browser-session connections,
  // or non-static-secret connectors): the ternary above resolved
  // `{ ok: true, metadata: null }` and `deriveCredentialEvidence` returns `null`
  // because `staticSecretBound` is false — so `credential` stays `null` (evidence
  // omitted), unchanged, and no `credential_required` is fabricated for them.
  const credential = deriveCredentialEvidence(staticSecretBound, credentialMetadata);
  const activeRun = localDeviceBacked ? null : (activeRunsByInstanceId.get(connectorInstanceId) ?? null);
  const ephemeralBrowserRuntime = localDeviceBacked
    ? null
    : await projectConnectorHealthSummaryRuntime({
        activeRun,
        connectionId: connectorInstanceId,
        connectorId,
        controller,
        instance,
        inventory: deps.runtimeInventory,
        lastSuccessfulRun,
        now: nowIso,
        profileKey: browserSurfaceProfileKey,
        reader: sharedBrowserSurfaceReader,
        remoteSurface: remoteSurface.evidence,
        browserSessionBound: connectionIsBrowserSessionBound(instance),
      });
  const refreshPolicy = extractRefreshPolicy(manifest);
  // Adaptive rate controller snapshot: read from the latest run's terminal
  // event (fast path) or its most recent rate-change progress event (in-
  // progress run). `null` when no controller has fired for this connection.
  const collectionRate =
    !localDeviceBacked && lastRun?.run_id
      ? await readLatestCollectionRateForRun(
          lastRun.run_id,
          lastRun.status === "pending" ? null : await readRunTerminalEventData(lastRun.run_id)
        )
      : null;
  return synthesizeConnectorSummary({
    acquisitionCoverage,
    activeRun,
    attention,
    collectionRate,
    connectorId,
    connectorInstanceId,
    credential,
    detailGaps,
    evidence: deps.evidenceByInstanceId.get(connectorInstanceId) ?? null,
    evidenceReadFailed: deps.evidenceReadFailed,
    ephemeralBrowserRuntime,
    instance,
    lastRun,
    lastSuccessfulRun,
    latestStreamFacts: deps.latestStreamFactsByInstanceId.get(connectorInstanceId) ?? null,
    live,
    localCoverage,
    manifest,
    manifestDeclaration,
    nowIso,
    outbox,
    refreshPolicy,
    remoteSurface,
    runtimeOk: deps.runtimeOk,
    schedule,
  });
}

/**
 * Result of the batched connector-summary evidence read used by
 * `loadConnectorSummaryProjectionDeps`. A total read failure (e.g. the
 * evidence table/connection is unreachable) is distinct from a genuine
 * empty read (e.g. a fresh install with zero connections yet): both
 * currently produce zero rows, but only the former means "we could not
 * observe anything," and it must not be silently indistinguishable from
 * "there is honestly nothing to observe yet." Design.md task 5.4.
 */
async function readSummaryEvidenceRowsOrFailure(
  connectorInstanceIds: readonly string[] | null = null
): Promise<{
  readonly failed: boolean;
  readonly rows: readonly Row[];
}> {
  try {
    return {
      failed: false,
      rows: (await listConnectorSummaryEvidence(
        connectorInstanceIds === null ? {} : { connectorInstanceIds }
      )) as readonly Row[],
    };
  } catch {
    return { failed: true, rows: [] };
  }
}

async function loadConnectorSummaryProjectionDeps(
  controller?: ControllerLike | null,
  options: {
    readonly includeRetainedSizeSnapshot?: boolean;
    readonly includeRunSummaries?: ConnectorRunSummaryInclusion;
    /**
     * Narrows the observation barrier's reconcile/discovery/repair phase to
     * exactly this connection set. A caller that already resolved the one
     * (or few) `connectorInstanceId`s it needs (e.g. `getConnectorSummaryForRoute`,
     * `getConnectorDetail`) must not pay for a complete census of every
     * other connection the owner has. Defaults to `null` (complete census) —
     * the exact prior behavior — so `computeConnectorSummaries` (the LIST
     * path, which genuinely needs every connection) is unaffected by
     * omitting this option.
     */
    readonly connectorInstanceIds?: readonly string[] | null;
  } = {}
): Promise<ConnectorSummaryProjectionDeps> {
  const schedulerStore = getDefaultSchedulerStore();
  // Central observation barrier (design.md "Central consumer and cache
  // boundary"): reconcile BEFORE reading, so every summary this render
  // produces reflects canonical state, not a pre-repair snapshot. Runs for
  // every caller of this shared loader — list, scoped route, owner
  // diagnostics, and the scheduler all go through it — closing the prior
  // bypass where only cookie routes reconciled. Best-effort: a reconcile
  // failure degrades to reading whatever evidence exists (the fold/repair
  // machinery already marks failed rows visibly non-fresh; it never blocks
  // the read entirely). Scoped to `options.connectorInstanceIds` when the
  // caller supplied one; `null` (the default) runs the complete census.
  //
  // `failedRows`: candidates whose repair AND durable failure-marker write
  // BOTH failed this pass (Sol P1.1) — the subsequent durable read below
  // cannot see them, since nothing was actually written. Carried in memory
  // and merged over the durable read for exactly those instance ids, so
  // this render still reflects the failure rather than a stale prior row.
  const reconcileOutcome = await reconcileDirtyConnectorSummaryEvidence(options.connectorInstanceIds ?? null).catch(
    () => null
  );
  const inMemoryFailedRows = reconcileOutcome?.failedRows ?? new Map<string, Row>();
  const [connectorRows, retainedSizeSnapshot, activeRuns, summaryEvidenceRead] = await Promise.all([
    listRegisteredConnectorRows(),
    options.includeRetainedSizeSnapshot ? loadRetainedSizeProjectionSnapshot() : Promise.resolve(undefined),
    Promise.resolve()
      .then(() => schedulerStore.listActiveRuns())
      .catch(() => []),
    // Latest-attempt stream facts + canonical evidence: one batched
    // read-model query for every connection in this render, read AFTER the
    // barrier above. A read failure degrades to no stored evidence (fail
    // closed downstream via `evidenceReadFailed`), never to a projection
    // error.
    readSummaryEvidenceRowsOrFailure(options.connectorInstanceIds ?? null),
  ]);
  const evidenceReadFailed = summaryEvidenceRead.failed;
  // In-memory failed rows win over the durable read for the same instance
  // id — the durable read is guaranteed stale for exactly those ids (the
  // write that should have superseded it did not land). `shapeEvidenceRow`
  // is the same flat-row-to-envelope transform `listConnectorSummaryEvidence`
  // already applied to `summaryEvidenceRead.rows`; the raw engine
  // `failedRow` shape (`buildFailedRow`) defaults gracefully through it.
  const mergedEvidenceRows =
    inMemoryFailedRows.size === 0
      ? summaryEvidenceRead.rows
      : [
          ...summaryEvidenceRead.rows.filter(
            (row) => !inMemoryFailedRows.has(String((row as Row).connector_instance_id))
          ),
          ...[...inMemoryFailedRows.values()].map((row) => shapeEvidenceRow(row) as unknown as Row),
        ];
  const latestStreamFactsByInstanceId = buildLatestStreamFactsIndex(mergedEvidenceRows);
  const evidenceByInstanceId = buildEvidenceIndex(mergedEvidenceRows);
  const activeRunsByInstanceId = new Map<string, ActiveRunRecord>();
  for (const activeRun of activeRuns) {
    if (activeRun.connector_instance_id) {
      activeRunsByInstanceId.set(activeRun.connector_instance_id, activeRun);
    }
  }
  // Safe parse: a malformed/unparseable manifest is real, honest evidence
  // about this connection (manifest_declaration: unavailable), never a
  // reason to silently drop it from the summary list — see
  // resolveSummaryManifest. manifestDeclarationByConnectorId carries the
  // parse-layer result separately so synthesis can report it even when the
  // per-connection evidence engine never got far enough to compute its own
  // manifest_fingerprint comparison for this connector.
  const manifestResolutionsByConnectorId = new Map(
    connectorRows.map((row) => [row.connector_id, resolveSummaryManifest(row.manifest)])
  );
  const manifestsByConnectorId = new Map(
    [...manifestResolutionsByConnectorId].map(([connectorId, resolution]) => [connectorId, resolution.manifest])
  );
  const manifestDeclarationByConnectorId = new Map(
    [...manifestResolutionsByConnectorId].map(([connectorId, resolution]) => [
      connectorId,
      { state: resolution.declarationState, reasonCode: resolution.reasonCode },
    ])
  );
  // The browser-surface leases/surfaces tables are global, unscoped reads that
  // `getConnectorBrowserSurfaceProjection` filters by `connector_id` in memory.
  // Read them once here and replay the snapshot per connector instead of issuing
  // three full-table reads inside every loop iteration (3N -> 3). This path runs on
  // every records-dashboard poll, so the saved reads compound under the active-run
  // poll cadence.
  const [sharedBrowserSurfaceReader, runtimeInventory] = await Promise.all([
    loadSharedBrowserSurfaceReader(),
    readBrowserSurfaceRuntimeInventory(controller),
  ]);
  return {
    activeRunsByInstanceId,
    controller,
    evidenceByInstanceId,
    evidenceReadFailed,
    getLatestRunHistoryForConnection: (connectorInstanceId, status = null) =>
      Promise.resolve(schedulerStore.getLatestRunHistoryForConnection(connectorInstanceId, status)).catch(() => null),
    latestStreamFactsByInstanceId,
    listRunSummariesForConnector: createConnectorRunSummariesReader(),
    includeRunSummaries: options.includeRunSummaries ?? true,
    manifestsByConnectorId,
    manifestDeclarationByConnectorId,
    ...(retainedSizeSnapshot ? { retainedSizeSnapshot } : {}),
    runtimeOk: controller != null,
    runtimeInventory,
    sharedBrowserSurfaceReader,
  };
}

/** Untyped read-model row shape crossing the module boundary. */
type Row = Record<string, unknown>;

/**
 * The maintained connector-summary evidence shape this module consumes
 * (subset of `listConnectorSummaryEvidence`'s full shaped row — see
 * `connector-summary-read-model.ts`'s `shapeEvidenceRow`). Canonical
 * `records`-authority counts/streams and orthogonal component states;
 * never re-derived from a live source here.
 */
export interface ConnectorSummaryEvidenceRow {
  readonly total_records: number;
  /** Count of streams with at least one live canonical record — NOT the exhaustive declared+observed stream_records set size. */
  readonly stream_count: number;
  readonly stream_records: readonly {
    readonly stream: string;
    readonly declaration_state: "declared" | "dormant" | "unexpected" | "unavailable";
    readonly count_state: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
    readonly record_count: number | null;
    readonly retained_record_count: number | null;
  }[];
  readonly retained_bytes: RetainedBytesBreakdown | null;
  readonly total_retained_bytes: number;
  readonly record_snapshot: {
    readonly state: "current" | "unobserved" | "stale" | "failed";
    readonly as_of: string | null;
    readonly reason_code: string | null;
  };
  readonly terminal_facts: {
    readonly state: "current" | "unobserved" | "stale" | "failed";
    readonly event_seq: number | null;
    readonly as_of: string | null;
    readonly reason_code: string | null;
  };
  readonly manifest_declaration: {
    readonly state: "current" | "unavailable" | "failed";
    readonly as_of: string | null;
    readonly reason_code: string | null;
  };
  /**
   * The retained-bytes evidence component's typed envelope (design.md
   * "Orthogonal projection evidence"), distinct from `retained_bytes` above
   * (the nullable byte-VALUE payload). Does NOT feed `evidenceUnreliableSources`
   * (design.md "Health boundary": retained-byte failure never by itself
   * degrades connection health).
   */
  readonly retained_bytes_evidence: {
    readonly state: "current" | "unobserved" | "stale" | "failed";
    readonly as_of: string | null;
    readonly reason_code: string | null;
  };
  readonly dirty: boolean;
  readonly state: string;
  readonly last_error: string | null;
}

/**
 * Index the maintained evidence rows by connector_instance_id. Read AFTER
 * the observation barrier (`reconcileDirtyConnectorSummaryEvidence`) has
 * run, so every row reflects canonical state as of this render — not a
 * pre-repair snapshot. Spec: openspec/changes/reconcile-active-summary-evidence.
 */
function buildEvidenceIndex(rows: readonly Row[]): Map<string, ConnectorSummaryEvidenceRow> {
  const index = new Map<string, ConnectorSummaryEvidenceRow>();
  for (const row of rows) {
    const instanceId = typeof row?.connector_instance_id === "string" ? row.connector_instance_id : null;
    if (!instanceId) {
      continue;
    }
    index.set(instanceId, row as unknown as ConnectorSummaryEvidenceRow);
  }
  return index;
}

/**
 * Parse the read model's per-connection latest-attempt fact maps into typed
 * records. Defensive at every field: a malformed entry is dropped (reads
 * unknown downstream — fail closed), never a fabricated fact. Connection
 * scoping is inherent: each map is keyed by its own row's
 * connector_instance_id, so stored evidence can never cross connections.
 */
function buildLatestStreamFactsIndex(rows: readonly Row[]): Map<string, ReadonlyMap<string, LatestStreamFactRecord>> {
  const index = new Map<string, ReadonlyMap<string, LatestStreamFactRecord>>();
  for (const row of rows) {
    const instanceId = typeof row?.connector_instance_id === "string" ? row.connector_instance_id : null;
    if (!instanceId) {
      continue;
    }
    const map = parseLatestStreamFactsMap(row?.stream_latest_facts);
    if (map.size > 0) {
      index.set(instanceId, map);
    }
  }
  return index;
}

/** Parse one row's stored per-stream fact map; malformed entries are dropped. */
function parseLatestStreamFactsMap(raw: unknown): Map<string, LatestStreamFactRecord> {
  const map = new Map<string, LatestStreamFactRecord>();
  if (!(raw && typeof raw === "object" && !Array.isArray(raw))) {
    return map;
  }
  for (const [stream, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      continue;
    }
    const entry = entryRaw as Row;
    const fact = readRuntimeCollectionFact(entry.fact);
    if (!fact || fact.stream !== stream) {
      continue;
    }
    map.set(stream, {
      fact,
      evidenceAsOf: typeof entry.evidence_as_of === "string" && entry.evidence_as_of ? entry.evidence_as_of : null,
      runId: typeof entry.run_id === "string" && entry.run_id ? entry.run_id : null,
    });
  }
  return map;
}

export function listConnectorSummaries(
  controller?: ControllerLike | null,
  options: ListConnectorSummariesOptions = {}
): Promise<ConnectorSummary[]> {
  if (shouldCacheConnectorSummaries(options)) {
    const key = connectorSummariesCacheKey(controller, options);
    const cached = connectorSummariesCache.get(key);
    if (decideConnectorSummariesCacheRead(cached) === "await_refresh" && cached?.promise) {
      return cached.promise;
    }
    return refreshConnectorSummariesCache(key, controller, options);
  }
  return computeConnectorSummaries(controller, options);
}

async function computeConnectorSummaries(
  controller?: ControllerLike | null,
  options: ListConnectorSummariesOptions = {}
): Promise<ConnectorSummary[]> {
  await retireExpiredBrowserEnrollmentShellsForDashboard(new Date().toISOString());
  const deps = await loadConnectorSummaryProjectionDeps(controller, {
    includeRetainedSizeSnapshot: true,
    includeRunSummaries: options.includeRunSummaries ?? true,
  });
  const rows = await listConnectorInstanceRowsForDashboard();
  const activeVisibleConnectionCounts = countActiveVisibleConnectionsByConnectorId(rows, deps.manifestsByConnectorId);
  const summaries = await runWithConcurrency(
    rows,
    options.concurrency ?? LIST_CONNECTOR_SUMMARIES_CONCURRENCY,
    (instance): Promise<ConnectorSummary | null> =>
      projectConnectorSummaryForInstance(instance, deps, {
        activeVisibleConnectionCount: activeVisibleConnectionCounts.get(instance.connectorId) ?? 0,
      }),
    options.onInFlightChange ? { onInFlightChange: options.onInFlightChange } : {}
  );
  return summaries.filter((summary): summary is ConnectorSummary => summary !== null);
}

/**
 * Result of resolving a connector_id to at most one owner connection
 * (design.md "Central consumer and cache boundary"): a connector-keyed
 * lookup with zero or multiple visible connections must never merge/sum
 * sibling evidence, so this resolution is a single shared decision every
 * connector-keyed consumer (route id resolution, catalog detail) makes the
 * same way.
 */
interface ConnectorIdResolution {
  /** The single unambiguous match, or `null` when zero or multiple exist. */
  readonly match: ConnectorInstanceRow | null;
  /** Count of connections whose `connectorId` equals the target id. */
  readonly matchCount: number;
}

// Resolve a connector_id to at most one owner connection, unambiguously.
// Exact stable connection identity (`connectorInstanceId === routeId`) is
// preferred; connector-id fallback is allowed only when exactly one
// connection shares that connector_id — otherwise a connector-key route
// would silently pick the first source and attach sibling evidence to it.
function resolveUnambiguousConnectionForConnectorId(
  rows: readonly ConnectorInstanceRow[],
  routeId: string
): ConnectorIdResolution {
  const exact = rows.find((instance) => instance.connectorInstanceId === routeId) ?? null;
  if (exact) {
    return { match: exact, matchCount: 1 };
  }
  const connectorMatches = rows.filter((instance) => instance.connectorId === routeId);
  return {
    match: connectorMatches.length === 1 ? (connectorMatches[0] ?? null) : null,
    matchCount: connectorMatches.length,
  };
}

// Resolve one configured connection from a record-subpage route id and project
// only that connection. Exact stable connection identity is preferred. Connector
// id fallback is allowed only when it is unambiguous; otherwise a connector-key
// route would silently pick the first source and attach sibling evidence to it.
export async function getConnectorSummaryForRoute(
  routeId: string,
  controller?: ControllerLike | null
): Promise<ConnectorSummary | null> {
  await retireExpiredBrowserEnrollmentShellsForDashboard(new Date().toISOString());
  const rows = await listConnectorInstanceRowsForDashboard();
  const { match } = resolveUnambiguousConnectionForConnectorId(rows, routeId);
  if (match === null) {
    return null;
  }
  // Scoped to exactly the one resolved connection: by this point the
  // unambiguous match is already known, so the observation barrier must not
  // pay for a complete census of every other connection the owner has.
  const deps = await loadConnectorSummaryProjectionDeps(controller, {
    includeRunSummaries: true,
    connectorInstanceIds: [match.connectorInstanceId],
  });
  const activeVisibleConnectionCounts = countActiveVisibleConnectionsByConnectorId(rows, deps.manifestsByConnectorId);
  return projectConnectorSummaryForInstance(match, deps, {
    activeVisibleConnectionCount: activeVisibleConnectionCounts.get(match.connectorId) ?? 0,
  });
}

/**
 * Honest empty `ConnectorDetail` for the `unresolved`/`ambiguous` resolution
 * states (design.md "Central consumer and cache boundary"): a connector-keyed
 * catalog detail with zero or multiple visible connections omits connection
 * health/counts rather than merging/summing sibling evidence. Every field
 * below driven by connection evidence (health/verdict/owner-state/records/
 * runs/schedule) is a genuine "no evidence for one connection" value — the
 * same empty shapes `buildConnectorFreshness`/`projectConnectorSummaryConnectionHealth`
 * already use elsewhere to represent unobserved evidence — never a
 * connector-wide read of that evidence. Also reused (with `resolution:
 * "resolved"`) for the rare case where exactly one connection resolves but
 * `projectConnectorSummaryForInstance` itself declines to synthesize a
 * summary for it (see the caller).
 *
 * `manifest_excerpt`/`streams` are the one exception: declared stream names
 * are connector-level catalog facts owned by the registered manifest, not
 * per-connection evidence — they exist and are knowable with zero
 * connections, same as `display_name`/`manifest_version` below. Omitting
 * them here would conflate "no connection to report per-connection counts
 * for" with "no connector registered", which is the 404 case this function
 * is never reached for. Each stream still carries genuinely unresolvable
 * per-connection facts (`record_count`/`last_updated`) as `null`, via the
 * same honest-unobserved shape `buildStreamSummary` uses for a resolved
 * connection's undeclared/never-observed stream.
 */
function buildUnresolvedConnectorDetail(
  connectorId: string,
  manifest: ConnectorManifest,
  resolution: ConnectorDetail["connection_resolution"]
): ConnectorDetail {
  // Zero or multiple visible connections: no single connection's evidence is
  // resolvable, so this OMITS connection health/counts entirely rather than
  // fabricating a connector-wide merge or a zeroed snapshot (design.md
  // "Central consumer and cache boundary" — zero is a real count claim, not
  // the same thing as "unresolvable"). No health/verdict/owner-state
  // synthesis is performed at all — there is no connection to synthesize
  // evidence FOR.
  return {
    object: "ref_connector_detail",
    acquisition_coverage: null,
    collection_report: [],
    connection_id: connectorId,
    connection_resolution: resolution,
    connection_health: null,
    connector_id: connectorId,
    display_name: manifest.display_name || connectorId,
    manifest_version: manifest.version || null,
    next_action: null,
    owner_state: null,
    rendered_verdict: null,
    total_records: null,
    total_records_state: "unobserved",
    freshness: { status: "unknown" },
    schedule: null,
    last_run: null,
    last_successful_run: null,
    recent_runs: [],
    manifest_excerpt: buildManifestExcerpt(manifest),
    streams: (manifest.streams || []).map((stream) => buildStreamSummary(stream, null)),
  };
}

export async function getConnectorDetail(
  connectorId: string,
  controller?: ControllerLike | null
): Promise<ConnectorDetail> {
  const manifest = (await getConnectorManifest(connectorId)) as ConnectorManifest | null;
  if (!manifest) {
    throw new RefControlError(`Unknown connector: ${connectorId}`, "not_found");
  }
  // Resolve to at most one owner connection the SAME way
  // `getConnectorSummaryForRoute` does (design.md "Central consumer and
  // cache boundary"): a connector-keyed lookup with zero or multiple visible
  // connections must never merge/sum sibling evidence. Reuse the shared
  // resolver rather than a divergent connector-wide read.
  await retireExpiredBrowserEnrollmentShellsForDashboard(new Date().toISOString());
  const rows = await listConnectorInstanceRowsForDashboard();
  const { match, matchCount } = resolveUnambiguousConnectionForConnectorId(rows, connectorId);
  if (match === null) {
    return buildUnresolvedConnectorDetail(connectorId, manifest, matchCount === 0 ? "unresolved" : "ambiguous");
  }
  // Scoped to exactly the one resolved connection, same rationale as
  // `getConnectorSummaryForRoute` above: the unambiguous match is already
  // known by this point, so the barrier must not census every connection.
  const deps = await loadConnectorSummaryProjectionDeps(controller, {
    includeRunSummaries: true,
    connectorInstanceIds: [match.connectorInstanceId],
  });
  const activeVisibleConnectionCounts = countActiveVisibleConnectionsByConnectorId(
    rows,
    deps.manifestsByConnectorId,
    false
  );
  const summary = await projectConnectorSummaryForInstance(match, deps, {
    activeVisibleConnectionCount: activeVisibleConnectionCounts.get(match.connectorId) ?? 0,
    // This route is reached by an owner-addressed connector_id, not by
    // catalog browsing — catalog-visibility gating (`isPublicReferenceConnector`)
    // answers "should this show up in the addable/listed catalog?", a
    // different question from "does this specific, already-resolved
    // connection have real data?" A private/unlisted connector's genuine
    // connection must still be viewable through its own detail route (the
    // exact regression closed here: this path used to read connector-wide
    // data with no catalog gate at all).
    requireCatalogVisibility: false,
  });
  if (summary === null) {
    // The connection resolved unambiguously, but the barrier-backed
    // projection still declined to synthesize a summary for it (e.g. the
    // connector manifest failed to resolve at all). This is a different
    // condition from zero/multiple connections — one real connection
    // exists — so `connection_resolution` stays `resolved`, fed the same
    // honest-empty evidence as the no-connection case.
    return buildUnresolvedConnectorDetail(connectorId, manifest, "resolved");
  }
  return {
    object: "ref_connector_detail",
    acquisition_coverage: summary.acquisition_coverage,
    collection_report: summary.collection_report,
    connection_id: summary.connector_instance_id,
    connection_resolution: "resolved",
    connection_health: summary.connection_health,
    connector_id: summary.connector_id,
    display_name: summary.display_name,
    manifest_version: summary.manifest_version,
    next_action: summary.next_action,
    owner_state: summary.owner_state,
    rendered_verdict: summary.rendered_verdict,
    total_records: summary.total_records,
    total_records_state: summary.total_records_state ?? "unobserved",
    freshness: summary.freshness,
    schedule: summary.schedule,
    last_run: summary.last_run,
    last_successful_run: summary.last_successful_run,
    recent_runs: summary.last_run ? [summary.last_run] : [],
    manifest_excerpt: buildManifestExcerpt(manifest),
    streams: (manifest.streams || []).map((stream) => {
      const streamRecord = summary.stream_records.find((entry) => entry.stream === stream.name) ?? null;
      return buildStreamSummary(
        stream,
        streamRecord
          ? {
              record_count: streamRecord.record_count,
              count_state: streamRecord.count_state,
              last_updated: streamRecord.last_updated,
              freshness: summary.freshness,
            }
          : null,
        summary.freshness
      );
    }),
  };
}

// ─── Connection-scoped diagnostics ───────────────────────────────────────────
//
// `getOwnerConnectionDiagnostics` is the single, connection-scoped diagnostics
// read shared by the browser owner-session surface and the owner-agent bearer
// REST surface (`GET /v1/owner/connections/:connectionId/diagnostics`). It is
// the connection-scoped primitive the owner-agent control design requires for
// `inspect_diagnostics` (design.md "Deferred: connection-scoped diagnostics
// needs a per-connection health primitive" / "Connection-scoped vs owner-wide
// boundary").
//
// It is correct-by-construction connection-scoped: it derives entirely from the
// ONE `ConnectorSummary` whose `connector_instance_id` matches the addressed
// `connection_id`. `listConnectorSummaries` already projects per-configured-
// connection rows that carry no sibling-connection or device-exporter-subsystem
// state, so selecting one row cannot leak another connection's diagnostics. This
// is the structural distinction from `GET /_ref/device-exporters/diagnostics`,
// which is device-rooted (every device, every source-instance for the owner) and
// therefore over-broad for a `connection_id`-addressed read.
//
// The response carries the last run status, last successful run, last successful
// ingest time, current schedule state, freshness, the typed connection health
// classification, and the same rendered verdict / required-action projection
// the console uses — all for exactly one binding.
// Returns `null` when no configured connection matches the id, so the caller can
// map a miss to a typed 404 instead of fabricating an empty diagnostic.

export interface OwnerConnectionDiagnosticsRun {
  readonly failure_reason: string | null;
  readonly finished_at: string | null;
  readonly run_id: string | null;
  readonly started_at: string | null;
  readonly status: string;
}

export interface OwnerConnectionDiagnosticsHealth {
  readonly axes: ConnectionHealthSnapshot["axes"];
  readonly badges: ConnectionHealthSnapshot["badges"];
  readonly last_success_at: string | null;
  readonly next_attempt_at: string | null;
  readonly reason_code: string | null;
  readonly state: ConnectionHealthSnapshot["state"];
}

// Owner-only recovery diagnostics derived from durable detail-gap rows. This is
// a bounded diagnostic summary, not record data: locators, payloads, URLs, and
// credentials never leave the gap store. `read_limit` is surfaced so counts from
// a bounded read are not presented as exact when the read hits the cap;
// `unreadable` distinguishes "could not read the gap store" from "no backlog".
export interface OwnerConnectionDiagnosticsRecovery {
  readonly admission: RecoveryAdmissionDiagnostics;
  readonly read_limit: number | null;
  readonly stall: RecoveryStallObservation;
  readonly unreadable: boolean;
}

export interface OwnerConnectionDiagnostics {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly connector_key: string;
  readonly display_name: string | null;
  readonly freshness: Freshness;
  readonly health: OwnerConnectionDiagnosticsHealth;
  readonly last_ingest_at: string | null;
  readonly last_run: OwnerConnectionDiagnosticsRun | null;
  readonly last_successful_run: OwnerConnectionDiagnosticsRun | null;
  readonly object: "owner_connection_diagnostics";
  readonly recovery: OwnerConnectionDiagnosticsRecovery;
  readonly rendered_verdict: RenderedVerdict;
  readonly schedule: { readonly enabled: boolean; readonly interval_seconds: number | null } | null;
}

// Map a bounded pending-gap summary onto the pure `RecoveryGapRow` the
// recovery-decision helpers read. The connector id is injected from the read
// scope (the summary projection omits it) so `resolveRecoveryAdmission` can
// always derive a work domain; every other field is durable non-secret
// class/timing/attempt metadata.
function pendingGapToRecoveryRow(gap: PendingDetailGapSummary, connectorId: string): RecoveryGapRow {
  return {
    connector_id: connectorId,
    connector_instance_id: typeof gap.connector_instance_id === "string" ? gap.connector_instance_id : null,
    reason: typeof gap.reason === "string" ? gap.reason : null,
    status: typeof gap.status === "string" ? gap.status : null,
    attempt_count: typeof gap.attempt_count === "number" ? gap.attempt_count : null,
    last_attempt_at: typeof gap.last_attempt_at === "string" ? gap.last_attempt_at : null,
    next_attempt_after: typeof gap.next_attempt_after === "string" ? gap.next_attempt_after : null,
    updated_at: typeof gap.updated_at === "string" ? gap.updated_at : null,
    stream: typeof gap.stream === "string" ? gap.stream : null,
  };
}

// Bound applied to the cooldown-inclusive pending read below. A hit on this
// bound marks the read as a floor, consistent with the other bounded gap reads.
const RECOVERY_DIAGNOSTICS_READ_LIMIT = 100;

// Build the owner-only recovery-admission diagnostics for one connection.
//
// This reads pending gaps regardless of their `next_attempt_after` eligibility
// floor. An ordinary "eligible now" read would hide a whole backlog that is
// cooling down, so diagnostics could not answer "waiting until <time>".
// Observe-only: it computes evidence and never admits work or mutates a row.
async function buildOwnerConnectionDiagnosticsRecovery(
  connectorId: string,
  connectorInstanceId: string,
  nowMs: number
): Promise<OwnerConnectionDiagnosticsRecovery> {
  try {
    const store = getDefaultConnectorDetailGapStore() as ConnectorDetailGapStoreLike;
    const pending = await Promise.resolve(
      store.listPendingGaps({
        connectorId,
        connectorInstanceId,
        limit: RECOVERY_DIAGNOSTICS_READ_LIMIT,
        now: "9999-12-31T23:59:59.999Z",
      })
    );
    const rows: RecoveryGapRow[] = pending.map((gap) => pendingGapToRecoveryRow(gap, connectorId));
    return {
      admission: summarizeRecoveryAdmissionDiagnostics(rows, { nowMs }),
      stall: deriveRecoveryStall(rows, { nowMs, cadenceWindowMs: RECOVERY_STALL_CADENCE_MS }),
      read_limit: RECOVERY_DIAGNOSTICS_READ_LIMIT,
      unreadable: false,
    };
  } catch {
    return emptyRecoveryDiagnostics(true);
  }
}

function emptyRecoveryDiagnostics(unreadable: boolean): OwnerConnectionDiagnosticsRecovery {
  return {
    admission: { candidates: 0, admitted: 0, deferred: 0 },
    stall: { eligibleCandidates: 0, lastAttemptAt: null, stalled: false },
    read_limit: RECOVERY_DIAGNOSTICS_READ_LIMIT,
    unreadable,
  };
}

// Projects a `ConnectorRunSummary` to the diagnostics-facing run shape. Only the
// non-secret status/timing/run-id fields are surfaced; gap arrays and event
// counts stay in the richer summary surface.
function projectDiagnosticsRun(run: ConnectorRunSummary | null): OwnerConnectionDiagnosticsRun | null {
  if (!run) {
    return null;
  }
  return {
    run_id: run.run_id ?? null,
    status: run.status,
    started_at: run.started_at ?? null,
    finished_at: run.finished_at ?? null,
    failure_reason: run.failure_reason ?? null,
  };
}

// Narrows the opaque schedule projection to the connection-scoped enabled +
// interval state. The full schedule object carries more (jitter, timestamps),
// but the diagnostics read only needs whether the schedule is paused and its
// cadence, which is what the typed health classification already consumes.
function projectDiagnosticsSchedule(schedule: unknown): { enabled: boolean; interval_seconds: number | null } | null {
  if (!schedule || typeof schedule !== "object") {
    return null;
  }
  const row = schedule as { enabled?: unknown; interval_seconds?: unknown };
  if (typeof row.enabled !== "boolean") {
    return null;
  }
  return {
    enabled: row.enabled,
    interval_seconds: typeof row.interval_seconds === "number" ? row.interval_seconds : null,
  };
}

export async function getOwnerConnectionDiagnostics(
  connectorInstanceId: string,
  controller?: ControllerLike | null
): Promise<OwnerConnectionDiagnostics | null> {
  const summary = await getConnectorSummaryForRoute(connectorInstanceId, controller);
  if (!summary) {
    return null;
  }
  const health = summary.connection_health;
  // Recovery-admission diagnostics for exactly this connection. Scoped to
  // `summary.connection_id` (the resolved connector_instance_id) so "why did
  // recovery not run" is answered for this binding, never a sibling backlog.
  const recovery = await buildOwnerConnectionDiagnosticsRecovery(
    summary.connector_id,
    summary.connection_id,
    Date.now()
  );
  return {
    object: "owner_connection_diagnostics",
    connection_id: summary.connection_id,
    connector_id: summary.connector_id,
    connector_key: summary.connector_id,
    display_name: summary.display_name ?? null,
    health: {
      state: health.state,
      reason_code: health.reason_code,
      last_success_at: health.last_success_at,
      next_attempt_at: health.next_attempt_at,
      axes: health.axes,
      badges: health.badges,
    },
    last_run: projectDiagnosticsRun(summary.last_run),
    last_successful_run: projectDiagnosticsRun(summary.last_successful_run),
    recovery,
    rendered_verdict: summary.rendered_verdict,
    // Last successful ingest time for push-mode (local-device) connections.
    // `null` for scheduler-managed connections with no device heartbeat, which
    // is the honest "no ingest evidence on this connection" state — never a
    // sibling connection's ingest time.
    last_ingest_at: summary.local_device_progress?.last_ingest_at ?? null,
    schedule: projectDiagnosticsSchedule(summary.schedule),
    freshness: summary.freshness,
  };
}

function buildConsentApproval(row: PendingConsentRow): ConsentApproval | null {
  // approval_id is populated for every row created after the
  // device-code-exposure fix. Pre-existing rows from an older DB schema
  // have approval_id = NULL; we drop those from the projection rather
  // than fall back to device_code, because device_code on this surface
  // is the security defect we are fixing.
  if (!row.approval_id) {
    return null;
  }
  const request = parseManifest(row.params_json, `pending consent ${row.approval_id}`) as ConsentRequestEnvelope;
  const source = sourcePreviewFromConsentRequest(request);
  return {
    object: "approval",
    approval_id: row.approval_id,
    kind: "consent",
    client_id: request.client?.client_id || null,
    request_uri: null,
    user_code: null,
    created_at: row.created_at,
    grant_preview: {
      access_mode: request.selection?.access_mode || null,
      purpose_code: request.selection?.purpose_code || null,
      purpose_description: request.selection?.purpose_description || null,
      source,
      streams: request.selection?.streams || [],
    },
  };
}

function sourcePreviewFromConsentRequest(request: ConsentRequestEnvelope): SourcePreview | null {
  const source = request.source_binding;
  if (source?.kind === "connector" && source.id) {
    return { kind: "connector", id: source.id };
  }
  if (source?.kind === "provider_native" && source.id) {
    return { kind: "provider_native", id: source.id };
  }
  return null;
}

function buildOwnerDeviceApproval(row: PendingOwnerDeviceRow): OwnerDeviceApproval | null {
  if (!row.approval_id) {
    return null;
  }
  return {
    object: "approval",
    approval_id: row.approval_id,
    kind: "owner_device",
    client_id: row.client_id,
    request_uri: null,
    user_code: null,
    created_at: row.created_at,
    grant_preview: null,
  };
}

export function listPendingApprovals(): Promise<Approval[]> {
  const now = new Date().toISOString();
  if (isPostgresStorageBackend()) {
    return Promise.all([
      postgresQuery(
        `SELECT device_code, user_code, params_json::text AS params_json, created_at, approval_id
         FROM pending_consents
         WHERE status = 'pending'
           AND expires_at > $1
         ORDER BY created_at DESC`,
        [now]
      ),
      postgresQuery(
        `SELECT device_code, user_code, client_id, created_at, approval_id
         FROM owner_device_auth
         WHERE status = 'pending'
           AND expires_at > $1
         ORDER BY created_at DESC`,
        [now]
      ),
    ]).then(([pendingConsentsResult, pendingDevicesResult]) => {
      const approvals: Approval[] = [
        ...(pendingConsentsResult.rows as PendingConsentRow[])
          .map(buildConsentApproval)
          .filter((a): a is ConsentApproval => a !== null),
        ...(pendingDevicesResult.rows as PendingOwnerDeviceRow[])
          .map(buildOwnerDeviceApproval)
          .filter((a): a is OwnerDeviceApproval => a !== null),
      ];
      approvals.sort((left, right) => {
        if (left.created_at === right.created_at) {
          return 0;
        }
        return left.created_at < right.created_at ? 1 : -1;
      });
      return approvals;
    });
  }
  // REVIEWED-BOUNDED: pending consents form a human-driven queue trimmed by the
  // expires_at predicate; the table cannot meaningfully exceed dozens of rows.
  const pendingConsents = allowUnboundedReadAcknowledged<PendingConsentRow>(
    referenceQueries.approvalsListPendingConsents,
    [now]
  );
  // REVIEWED-BOUNDED: in-flight owner CLI device flows form a human-driven queue
  // trimmed by the expires_at predicate; the table cannot meaningfully exceed
  // dozens of rows.
  const pendingDevices = allowUnboundedReadAcknowledged<PendingOwnerDeviceRow>(
    referenceQueries.approvalsListPendingOwnerDevices,
    [now]
  );
  const approvals: Approval[] = [
    ...pendingConsents.map(buildConsentApproval).filter((a): a is ConsentApproval => a !== null),
    ...pendingDevices.map(buildOwnerDeviceApproval).filter((a): a is OwnerDeviceApproval => a !== null),
  ];
  approvals.sort((left, right) => {
    if (left.created_at === right.created_at) {
      return 0;
    }
    return left.created_at < right.created_at ? 1 : -1;
  });
  return Promise.resolve(approvals);
}

// ─── Records timeline ───────────────────────────────────────────────────────

const SAFE_JSON_FIELD_RE = /^[A-Za-z_][A-Za-z_0-9]*$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeJsonPathExpr(field: string, label: string): string {
  if (typeof field !== "string" || !SAFE_JSON_FIELD_RE.test(field)) {
    throw new Error(`[ref-control] Unsafe JSON field ${label}: ${JSON.stringify(field)}`);
  }
  return `json_extract(record_json, '$.${field}')`;
}

/**
 * Normalize caller-supplied `since`/`until` values for SQL comparison. Mirrors
 * what `ref-record-utils::parseDateLike` does for the JS post-filter: a
 * bare `YYYY-MM-DD` value expands to the start (since) or end (until) of the
 * day so ISO-datetime-valued rows on the boundary match as intended.
 */
function expandBoundary(value: string | null | undefined, boundary: "end" | "start"): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return value ?? null;
  }
  const trimmed = value.trim();
  if (!DATE_ONLY_RE.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}${boundary === "end" ? "T23:59:59.999Z" : "T00:00:00.000Z"}`;
}

interface PairRow {
  readonly connector_id: string;
  readonly stream: string;
}

/**
 * Enumerate the (connector_id, stream) pairs we need to query, narrowed by
 * caller-supplied filters. Cheap: records(connector_id, stream) is indexed,
 * and the count of pairs is on the order of (registered connectors × streams
 * per connector) — dozens, not thousands.
 */
const TIMELINE_PAIR_ENUMERATION_LIMIT = 1024;

function enumerateCandidatePairs(
  connectorId: string | null,
  stream: string | null
): { connectorId: string; stream: string }[] {
  const where: string[] = ["deleted = 0"];
  const binds: (number | string)[] = [];
  if (connectorId) {
    where.push("connector_id = ?");
    binds.push(connectorId);
  }
  if (stream) {
    where.push("stream = ?");
    binds.push(stream);
  }
  // REVIEWED-DYNAMIC: WHERE clause varies with caller-supplied connectorId/stream
  // filters, so the artifact registry cannot validate a fixed SQL string here.
  // The LIMIT ? guard caps the worst case at TIMELINE_PAIR_ENUMERATION_LIMIT
  // distinct (connector_id, stream) pairs; realistic load is dozens.
  const sql = `
    SELECT DISTINCT connector_id, stream
    FROM records
    WHERE ${where.join(" AND ")}
    LIMIT ?
  `;
  const pairs: { connectorId: string; stream: string }[] = [];
  for (const row of iterateDynamicSqlAcknowledged<PairRow>(sql, [...binds, TIMELINE_PAIR_ENUMERATION_LIMIT])) {
    pairs.push({ connectorId: row.connector_id, stream: row.stream });
  }
  return pairs;
}

interface TimelineQueryRow {
  readonly connector_id: string;
  readonly emitted_at: string;
  readonly record_json: string | null;
  readonly record_key: string;
  readonly stream: string;
  readonly version: number | null;
}

function buildTimelineSql({
  manifestStream,
  timestampMode,
  since,
  until,
  orderDir,
}: {
  manifestStream: ManifestStreamLike | null;
  orderDir: "ASC" | "DESC";
  since: string | null;
  timestampMode: "emitted" | "native";
  until: string | null;
}): { sql: string; binds: (number | string)[]; timestampExpr: string } {
  // Keep this dynamic SQL inline: optional time-window predicates, native
  // timestamp JSON fields, and caller-selected order direction change the
  // statement shape in ways that are easier to audit beside the validation.
  const semanticField =
    timestampMode === "native" ? manifestStream?.consent_time_field || manifestStream?.cursor_field || null : null;
  const timestampExpr = semanticField
    ? `COALESCE(NULLIF(${safeJsonPathExpr(semanticField, "semantic_time_field")}, ''), emitted_at)`
    : "emitted_at";

  const where: string[] = ["connector_id = ?", "stream = ?", "deleted = 0"];
  const binds: (number | string)[] = [];

  if (since) {
    where.push(`${timestampExpr} >= ?`);
    const expanded = expandBoundary(since, "start");
    if (expanded !== null) {
      binds.push(expanded);
    }
  }
  if (until) {
    where.push(`${timestampExpr} <= ?`);
    const expanded = expandBoundary(until, "end");
    if (expanded !== null) {
      binds.push(expanded);
    }
  }

  const sql = `
      SELECT connector_id, stream, record_key, record_json, emitted_at, version
      FROM records
      WHERE ${where.join(" AND ")}
      ORDER BY ${timestampExpr} ${orderDir}, emitted_at ${orderDir}, record_key ${orderDir}
      LIMIT ?
    `;
  return { sql, binds, timestampExpr };
}

function comparePrimaryDesc(order: "asc" | "desc", left: TimelineEntry, right: TimelineEntry): number {
  const primary = compareTimestampValues(left.display_timestamp, right.display_timestamp);
  if (primary !== 0) {
    return order === "asc" ? primary : -primary;
  }
  if (left.emitted_at !== right.emitted_at) {
    return order === "asc"
      ? compareTimestampValues(left.emitted_at, right.emitted_at)
      : compareTimestampValues(right.emitted_at, left.emitted_at);
  }
  return order === "asc"
    ? String(left.id).localeCompare(String(right.id))
    : String(right.id).localeCompare(String(left.id));
}

/**
 * `/_ref/records/timeline` body builder.
 *
 * Reads per-(connector, stream) slices with SQL-side `since`/`until`
 * filtering against either the manifest-declared `consent_time_field`/
 * `cursor_field` (native mode) or `emitted_at` (emitted mode). Merges
 * them, applies a final JS window check for date-only boundaries, and
 * clips to the caller's `limit`.
 *
 * Route contract preserved: returns `{object: 'list', data, meta}` with the
 * same entry shape (connector_id, stream, id, emitted_at, version, data,
 * semantic_timestamp, display_timestamp).
 */
function rowPassesWindow(
  timestampMode: "emitted" | "native",
  semanticTimestamp: SemanticTimestamp | null,
  emittedAt: string,
  since: string | null,
  until: string | null
): boolean {
  // Final-pass JS window check — covers the edge case where the SQL
  // compared ISO strings lexically but `since`/`until` used a date-only
  // value (`YYYY-MM-DD`); timestampWithinWindow normalizes those to
  // day boundaries.
  if (timestampMode === "native") {
    const candidate = semanticTimestamp?.value || emittedAt;
    return timestampWithinWindow(candidate, since, until);
  }
  return timestampWithinWindow(emittedAt, since, until);
}

function buildTimelineEntry(
  row: TimelineQueryRow,
  manifestStream: ManifestStreamLike | null,
  timestampMode: "emitted" | "native"
): TimelineEntry | null {
  const recordData: unknown = row.record_json ? JSON.parse(row.record_json) : null;
  const semanticTimestamp = pickSemanticTimestamp(manifestStream ?? null, recordData);
  const displayTimestamp = chooseDisplayTimestamp({
    semanticTimestamp,
    emittedAt: row.emitted_at,
    mode: timestampMode,
  });
  return {
    object: "timeline_entry",
    connector_id: row.connector_id,
    stream: row.stream,
    id: row.record_key,
    emitted_at: row.emitted_at,
    version: row.version,
    data: recordData,
    semantic_timestamp: semanticTimestamp,
    display_timestamp: displayTimestamp,
  };
}

async function collectPairEntries(
  pair: { connectorId: string; stream: string },
  opts: {
    orderDir: "ASC" | "DESC";
    perPairLimit: number;
    since: string | null;
    timestampMode: "emitted" | "native";
    until: string | null;
  }
): Promise<TimelineEntry[]> {
  const manifest = (await getConnectorManifest(pair.connectorId)) as ConnectorManifest | null;
  const manifestStream = manifest?.streams?.find((item) => item.name === pair.stream) ?? null;

  const { sql, binds } = buildTimelineSql({
    manifestStream,
    timestampMode: opts.timestampMode,
    since: opts.since,
    until: opts.until,
    orderDir: opts.orderDir,
  });

  const entries: TimelineEntry[] = [];
  // REVIEWED-DYNAMIC: WHERE/ORDER BY shape is selected by buildTimelineSql from
  // manifest-driven timestamp expressions and caller-supplied since/until/order
  // values, so the artifact registry cannot validate this SQL up front. The
  // statement embeds a trailing LIMIT ? bound by perPairLimit, which the caller
  // derives from the request's `limit` field.
  for (const row of iterateDynamicSqlAcknowledged<TimelineQueryRow>(sql, [
    pair.connectorId,
    pair.stream,
    ...binds,
    opts.perPairLimit,
  ])) {
    const entry = buildTimelineEntry(row, manifestStream, opts.timestampMode);
    if (!entry) {
      continue;
    }
    if (!rowPassesWindow(opts.timestampMode, entry.semantic_timestamp, entry.emitted_at, opts.since, opts.until)) {
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Substrate read for the `ref.records.timeline` operation.
 *
 * Returns the merged-and-sorted timeline entries for the given window,
 * without applying the final limit slice or assembling the envelope —
 * the operation module
 * (`reference-implementation/operations/ref-records-timeline/index.ts`)
 * owns that shape. Returning a slightly-over-limit collection here is
 * intentional: the operation re-clips, and an explorer caller (e.g. a
 * future operation behavior test) can ask for the full pre-clip set.
 */
export async function collectRecordsTimelineEntries({
  connectorId = null,
  stream = null,
  since = null,
  until = null,
  limit = 50,
  order = "desc",
  timestampMode = "native",
}: TimelineOptions = {}): Promise<TimelineEntry[]> {
  const pairs = enumerateCandidatePairs(connectorId, stream);
  const perPairLimit = Math.max(limit * 2, 10);
  const orderDir: "ASC" | "DESC" = order === "asc" ? "ASC" : "DESC";

  const perPair = await Promise.all(
    pairs.map((pair) => collectPairEntries(pair, { orderDir, perPairLimit, since, timestampMode, until }))
  );
  const collected = perPair.flat();

  collected.sort((left, right) => comparePrimaryDesc(order, left, right));

  return collected;
}
