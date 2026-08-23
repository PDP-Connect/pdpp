// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Connector Runtime
 *
 * Spawns connector processes, manages the JSONL protocol,
 * handles INTERACTION, and ingests RECORDs to the RS via owner token.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { validateRuntimeContinuationFact } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { emitControllerBootedAndStashEpoch } from "../lib/controller-boot.ts";
import type { SpineEventInput, SpineEventRecord } from "../lib/spine.ts";
import { createTraceContext, emitSpineEvent, getCurrentBootEpoch } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { readStoredCollectionScope } from "../server/local-collection-scope.ts";
import { getDefaultConnectorAttentionStore } from "../server/stores/connector-attention-store.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import {
  classifyRecoveryError,
  maybeQuarantineGap,
  maybeTerminateGap,
  resolveTerminalGapPolicy,
} from "../server/stores/terminal-gap-classifier.ts";
import type { AttentionWriterOptions } from "./attention-writer.ts";
import { createAttentionWriter } from "./attention-writer.ts";
import { classifyRuntimeFailure } from "./classify-runtime-failure.ts";
import {
  type ConnectorConnectionEnvironment,
  type ConnectorEnvironmentBinding,
  composeConnectorChildEnvironment,
} from "./connector-child-environment.ts";
import {
  boundConnectorErrorCode,
  boundConnectorErrorMessage,
  boundConsideredCount,
  boundGapString,
  boundString,
  boundStringList,
  buildCollectionFacts,
  buildKnownGap,
  GAP_STRING_MAX,
  isValidRecoveryHintShape,
  normalizeGapScope,
  VIOLATION_LIST_MAX,
} from "./connector-gap-bounding.ts";
import { describeCursorBandViolation, evaluateCursorBand } from "./cursor-band-contiguity.ts";
import { declaredReasonTokensFor } from "./declared-reason-tokens.ts";
import { createDetailGapPageReader, validateDetailGapsPageRequest } from "./detail-gap-paging.ts";
import {
  validateDoneError,
  validateDoneExitCode,
  validateDoneRecordsEmitted,
  validateDoneStatus,
} from "./done-validators.ts";
import {
  buildHttpFailure,
  buildIngestEnvelopeContractViolationFailure,
  buildIngestHttpFailure,
  buildInvalidIngestResponseFailure,
} from "./ingest-failures.ts";
import {
  DEFAULT_INGEST_RETRY_POLICY,
  INGEST_SATURATED_FAILURE_REASON,
  type IngestRetryPolicy,
  isRetryableFetchError,
  isRetryableIngestStatus,
  nextIngestRetryDelayMs,
  parseIngestRetryAfterMs,
} from "./ingest-retry.ts";
import { isClosedPipeWriteError } from "./pipe-errors.ts";
import {
  validateProgressAttachmentHydrationFailureOutcome,
  validateProgressAttachmentHydrationFailureOutcomeSum,
  validateProgressAttachmentRecoveryOutcome,
  validateProgressCollectionRate,
  validateProgressProviderBudget,
} from "./progress-validators.ts";
import { assertValidRecordEnvelope } from "./record-message-validator.ts";
import { classifyRecoveryGap } from "./recovery-decision.ts";
import { DEFAULT_QUARANTINE_POLICY } from "./recovery-quarantine.ts";
import { redactStderrTail } from "./stderr-redact.ts";
import type { StderrTail } from "./stderr-tail.ts";
import { createStderrTailBuffer } from "./stderr-tail.ts";
import { deriveTerminalReason } from "./terminal-reason.ts";

const REDACTED_SCHEMA_KEY_RE = /^(?:default|example|examples|const|enum)$/i;
const SENSITIVE_SCHEMA_KEY_RE = /(?:password|passwd|secret|token|bearer|cookie|credential|otp|qr)/i;
const SAFE_ATTACHMENT_REF_RE = /^[A-Za-z0-9._:-]+$/;

// ─── Connector protocol + manifest contracts ───────────────────────────────
//
// Everything a connector writes to stdout is UNTRUSTED input: it has been
// JSON.parse'd but not yet validated. These shapes therefore declare the
// fields the runtime reads as `unknown`/optional rather than as the types a
// well-behaved connector would send — the per-message `validate*` functions
// below are what turn a `ConnectorMessage` into something narrower. Typing
// them as already-correct would move the trust boundary into the type system,
// which is exactly the bug class the validators exist to prevent.

/** A connector-emitted JSONL envelope, pre-validation. */
interface ConnectorMessage {
  type?: string;
  [key: string]: unknown;
}

/** Manifest stream entry, as read from the connector manifest. */
interface ManifestStream {
  availability?: { state?: string } | null;
  consent_time_field?: string | null;
  /**
   * Closed enum selecting an RI-owned cursor-band variant (see
   * `runtime/cursor-band-contiguity.ts`). Declaring opts this stream INTO a
   * contiguity check; omitting it is silence, never a healthy verdict.
   */
  cursor_shape?: string | null;
  name: string;
  parent_streams?: string[] | null;
  primary_key?: string | string[] | null;
  schema?: { required?: string[]; [key: string]: unknown } | null;
  selection?: { fields?: boolean; resources?: boolean; resource_field?: string } | null;
  state_stream?: string | null;
  [key: string]: unknown;
}

interface ConnectorManifest {
  runtime_requirements?: { bindings?: Record<string, { required?: boolean }> } | null;
  storage_binding?: { connector_instance_id?: string | null } | null;
  streams?: ManifestStream[] | null;
  [key: string]: unknown;
}

/** A per-stream entry of the normalized START.scope. */
interface StreamScope {
  fields?: string[] | null;
  name: string;
  resources?: string[] | null;
  time_range?: { since?: string | null; until?: string | null } | null;
  [key: string]: unknown;
}

interface StartScope {
  streams: StreamScope[];
}

/** In-scope streams, keyed by name — the admission set every validator checks. */
type ScopeByStream = Map<string, StreamScope>;

/**
 * Structural mirror of progress-validators.ts's own (unexported)
 * `AttachmentRecoveryOutcome`/`AttachmentHydrationFailureOutcome` — both are
 * `{ object: string; [key: string]: unknown }`.
 */
interface AttachmentOutcome {
  object: string;
  [key: string]: unknown;
}

/** Runtime-advertised child bindings (Collection Profile START.bindings). */
interface AvailableBindings {
  browser: Record<string, never>;
  filesystem: Record<string, never>;
  interactive?: Record<string, never>;
  network: Record<string, never>;
}

/** RS ingest response, after `readIngestResponse` proves the counters and receipt vector. */
interface IngestResult {
  records_accepted: number;
  records_attempted: number;
  records_rejected: number;
}

/**
 * Ingest/HTTP failure metadata that `ingest-failures.ts` attaches to the Error
 * it throws. Read back off the caught error on the terminal paths.
 */
interface IngestFailureDetail {
  batch_size?: number;
  http_status?: number;
  phase?: string;
  response_body_bytes?: number;
  response_content_type?: string;
  stream?: string;
  [key: string]: unknown;
}

/**
 * The runtime decorates the Error it rejects with run-scoped terminal
 * evidence, and reads `ingest_failure`/`pdpp_error_code`/`response_status`
 * back off errors thrown by the ingest helpers.
 */
interface RuntimeRunError extends Error {
  checkpoint_summary?: unknown;
  connector_error?: ConnectorDoneError | null;
  failure_reason?: string;
  ingest_failure?: IngestFailureDetail | null;
  known_gaps?: Record<string, unknown>[];
  pdpp_error_code?: string;
  records_emitted?: number;
  reported_records_emitted?: number | null;
  response_status?: number;
  run_id?: string;
  terminal_reason?: string;
  trace_id?: string;
}

/**
 * The `error` object a connector may attach to a failed DONE. `code`
 * identifies the cause (e.g. `credential_rejected`) and is connector-defined,
 * opaque to the RI. `recovery_hint` is the separate, closed-vocabulary
 * ACTION channel (same shape/vocabulary as `SKIP_RESULT.recovery_hint` —
 * see `RECOVERY_ACTIONS` / `isValidRecoveryHintShape` in
 * connector-gap-bounding.ts) — the only field `recoveryHintFromTerminalConnectorError`
 * reads to decide the owner-facing recovery action.
 */
interface ConnectorDoneError {
  code?: string;
  message?: string;
  recovery_hint?: string | { action: string; retryable?: boolean } | null;
  retryable?: boolean | null;
  [key: string]: unknown;
}

interface DoneMessageState {
  error: ConnectorDoneError | null;
  records_emitted: number;
  status: "succeeded" | "failed" | "cancelled";
}

interface InteractionSchemaProperty {
  format?: string;
}

interface LoadSyncStateOptions {
  connectorInstanceId?: string | null;
  grantId?: string | null;
  rsUrl?: string;
}

interface LoadSyncStateObject extends LoadSyncStateOptions {
  connectorId: string;
  ownerToken: string;
}

/** A durable detail-gap row as returned by the detail-gap store. */
interface DurableDetailGap {
  attempt_count?: number;
  detail_locator?: unknown;
  discovered_run_id?: string | null;
  gap_id: string;
  last_error?: unknown;
  lease_id?: string | null;
  lease_run_id?: string | null;
  list_cursor?: unknown;
  parent_stream?: string | null;
  reason?: string | null;
  record_key?: string | number | null;
  status?: string;
  stream?: string;
}

interface RuntimeDetailGapInput {
  connectorId?: string | null;
  connectorInstanceId?: string | null;
  detailLocator?: unknown;
  discoveredRunId?: string | null;
  gapId?: string | null;
  grantId?: string | null;
  lastError?: unknown;
  lastRunId?: string | null;
  listCursor?: unknown;
  nextAttemptAfter?: string | null;
  now?: string | null;
  parentStream?: string | null;
  reason?: string | null;
  recordKey?: unknown;
  scope?: unknown;
  source?: unknown;
  stream?: string | null;
}

/**
 * A run-owned lease over a served detail gap. Structurally identical to
 * detail-gap-paging.ts's own `ServedDetailGapLease` (which it does not
 * export) — the page reader populates this same map.
 */
interface ServedGapLease {
  attempted: boolean;
  gapId: string;
  leaseId: string;
  parentStream: string | null;
  recordKey: string | null;
  runId: string;
  stream: string | null;
}

/**
 * The detail-gap store surface `runConnector` drives. Declared structurally
 * because `getDefaultConnectorDetailGapStore()` is typed `unknown` at its own
 * module boundary. Lease-management capabilities remain feature-detected;
 * operation-specific mutation capabilities are optional for injected stores
 * and normalized to explicit fail-closed implementations before use.
 */
interface RuntimeDetailGapStoreCapabilities {
  claimPendingGaps?: (
    gapIds: readonly (string | null | undefined)[],
    options: { leaseExpiresAt?: string | null; leaseId?: string | null; runId?: string | null }
  ) => Promise<readonly (string | null | undefined)[]>;
  getGapById?: (gapId: string) => Promise<DurableDetailGap | null>;
  listPendingGaps: (options: {
    connectorId: string;
    connectorInstanceId: string | null;
    grantId: string | null;
    limit: number;
    streams?: string[] | null;
  }) => Promise<DurableDetailGap[] | null>;
  markGapStatus?: (gapId: string, status: string, options: { runId: string }) => Promise<DurableDetailGap | null>;
  markLeasedGapAttempt?: (lease: ServedGapLease) => Promise<DurableDetailGap | null>;
  reclaimStrandedInProgressGaps?: (options: {
    connectorId: string;
    connectorInstanceId: string | null;
    currentRunId: string;
    grantId: string | null;
  }) => Promise<unknown>;
  releaseLeasedGaps?: (leases: ServedGapLease[]) => unknown;
  settleLeasedGapPending?: (lease: ServedGapLease, input: RuntimeDetailGapInput) => Promise<DurableDetailGap | null>;
  settleLeasedGapRecovered?: (lease: ServedGapLease) => Promise<DurableDetailGap | null>;
  upsertPendingGap?: (input: RuntimeDetailGapInput) => Promise<DurableDetailGap | null>;
}

interface RuntimeDetailGapStore extends RuntimeDetailGapStoreCapabilities {
  markGapStatus: NonNullable<RuntimeDetailGapStoreCapabilities["markGapStatus"]>;
  markLeasedGapAttempt: NonNullable<RuntimeDetailGapStoreCapabilities["markLeasedGapAttempt"]>;
  settleLeasedGapPending: NonNullable<RuntimeDetailGapStoreCapabilities["settleLeasedGapPending"]>;
  settleLeasedGapRecovered: NonNullable<RuntimeDetailGapStoreCapabilities["settleLeasedGapRecovered"]>;
  upsertPendingGap: NonNullable<RuntimeDetailGapStoreCapabilities["upsertPendingGap"]>;
}

function unsupportedDetailGapStoreCapability(capability: string): () => never {
  return () => {
    throw new Error(`detail-gap store must support ${capability}`);
  };
}

/** Per-parent-boundary DETAIL_COVERAGE accounting collected during a run. */
interface DetailCoverageEntry {
  considered: number | null;
  covered: number | null;
  /**
   * Keys the connector declared it could not hydrate this run. Diagnostic
   * only: checkpoint authority still requires a matching durable DETAIL_GAP
   * for the same stream, key, and parent boundary.
   */
  gapKeys: Set<string>;
  hydratedKeys: Set<string>;
  /** Keys accepted by the connector's explicit optional-detail policy. */
  optionalSkipKeys: Set<string>;
  requiredKeys: string[];
  stream: string;
}

function durableGapMatchesCoverageParent(
  gapParentStream: string | null | undefined,
  stateStream: string,
  hasMultipleParents: boolean
): boolean {
  if (gapParentStream) {
    return gapParentStream === stateStream;
  }
  return !hasMultipleParents;
}

/**
 * Single source for the coverage-shortfall explanation, shared by the known-gap
 * message and the terminal `failure_message`, so the owner reads the same
 * sentence wherever the shortfall surfaces.
 */
function detailCoverageShortfallMessage(stateStream: string, stream: string, missingKeyCount: number): string {
  return `Connector detail coverage incomplete: state_stream=${stateStream} stream=${stream} missing_required_keys=${missingKeyCount}`;
}

/** An open structured-ASSISTANCE prompt awaiting a terminal status. */
interface OpenAssistance {
  kind?: string;
  owner_action?: unknown;
  progress_posture?: unknown;
  response_contract?: unknown;
  stream: string | null;
}

/** The last spine event the runtime persisted, for violation anchoring. */
interface LastValidSpineEvent {
  event_id: string;
  event_type?: string;
}

/** A record buffered for the next ingest flush. */
interface BufferedRecord {
  data: unknown;
  emitted_at: unknown;
  key: unknown;
  op: unknown;
}

/** The interaction-handler response envelope. */
interface InteractionResponse {
  data?: Record<string, string>;
  request_id?: string;
  status?: string;
  type?: string;
}

// ─── Public runtime API ────────────────────────────────────────────────────
//
// These were previously hand-maintained in `runtime/index.ts` alongside the
// JS implementation. They now live with the implementation they describe, so
// the "keep in lockstep" hazard the old header warned about is gone. Three
// places where that ambient file was knowingly narrower than the real runtime
// (documented by the consuming tests) are corrected here: `exit_code` on the
// result, `records_emitted` on a terminal failure, and the detail-gap store
// accepting an object with methods rather than being effectively opaque.

export type RuntimeCollectionMode = "full_refresh" | "incremental";
export type RuntimeRunAutomationMode = "ask_before_run" | "assisted" | "manual_only" | "unattended";
export type RuntimeRunTriggerKind = "manual" | "retry" | "scheduled" | "webhook";

export interface RuntimeTraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

export interface RuntimeBrowserSurfaceLease {
  readonly browserSurfaceRequired?: string | null;
  readonly cdpUrl?: string | null;
  readonly id?: string | null;
  readonly leaseId?: string | null;
  readonly profileKey?: string | null;
  readonly remoteCdpUrl?: string | null;
  readonly required?: string | null;
  readonly streamBaseUrl?: string | null;
  readonly surfaceId?: string | null;
}

export interface RuntimeBrowserSurfaceEnv {
  readonly PDPP_BROWSER_SURFACE_ID?: string | null;
  readonly PDPP_BROWSER_SURFACE_LEASE_ID?: string | null;
  readonly PDPP_BROWSER_SURFACE_PROFILE_KEY?: string | null;
  readonly PDPP_BROWSER_SURFACE_REMOTE_CDP_URL?: string | null;
  readonly PDPP_BROWSER_SURFACE_REQUIRED?: string | null;
  readonly PDPP_BROWSER_SURFACE_STREAM_BASE_URL?: string | null;
}

export interface RuntimeRunConnectorOptions {
  /**
   * Trusted run-creation admission. It must validate or materialize one exact
   * owner-owned configured instance before this runtime emits `run.started`.
   */
  admitRunConnection?: (input: {
    connectorId: string;
    connectorInstanceId: string | null;
    ownerSubjectId: string | null;
  }) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }>;
  /** Operator-owned logical connector-input bindings. */
  approvedEnvironmentBindings?: readonly ConnectorEnvironmentBinding[];
  /** Operator-authorized connector IDs that may receive ambient proxy aliases. */
  approvedProxyConnectorIds?: readonly string[];
  automationMode?: RuntimeRunAutomationMode | null;
  /**
   * Explicit browser-surface child env override for tests and integration
   * seams. Values here win over `browserSurfaceLease` fields.
   */
  browserSurfaceEnv?: RuntimeBrowserSurfaceEnv | null;
  /**
   * Managed browser-surface lease selected by the controller. When present
   * with a CDP URL, `runConnector` forwards the lease-scoped
   * `PDPP_BROWSER_SURFACE_*` env block to the connector child.
   */
  browserSurfaceLease?: RuntimeBrowserSurfaceLease | null;
  /**
   * Cancellation signal for this run. The controller passes one `AbortSignal`
   * per run for owner cancellation; the scheduler may pass one for a run
   * timeout. Aborting it requests cooperative cancellation of THIS run only.
   * The runtime records a non-terminal `run.cancel_requested` event, terminates
   * the connector child via the graceful-then-`SIGKILL` escalation, and (when
   * the child exits without `DONE`) resolves the run terminal as
   * `run.cancelled` with `owner_cancelled` / `owner_cancel_forced`. Abort after
   * a terminal event is recorded is a no-op.
   * A signal reason of `"run_timed_out"` is recorded as a runtime timeout
   * rather than owner cancellation.
   */
  cancelSignal?: AbortSignal | null;
  collectionMode?: RuntimeCollectionMode;
  /** Durable structured-attention store override for tests. */
  connectorAttentionStore?: AttentionWriterOptions["store"];
  connectorId: string;
  connectorInstanceId?: string | null;
  connectorPath: string;
  /**
   * Detail-gap store override for tests and integration seams. Defaults to
   * `getDefaultConnectorDetailGapStore()` when omitted.
   */
  detailGapStore?: RuntimeDetailGapStoreCapabilities;
  grantId?: string | null;
  /**
   * Bounds for retrying a RECORD-batch ingest POST the RS answered with a
   * retryable status (503 `ingest_batch_storage_error`, typically produced by
   * the global writer-admission gate). Defaults to
   * {@link DEFAULT_INGEST_RETRY_POLICY}. Overridden in tests to assert the
   * bound without waiting on it.
   */
  ingestRetryPolicy?: IngestRetryPolicy;
  /**
   * Test seam for ingest-retry backoff jitter. Defaults to `Math.random`.
   */
  ingestRetryRandom?: () => number;
  /**
   * Test seam for the ingest-retry backoff. Defaults to a real timer. Injected
   * so a test can prove the retry SEQUENCE (attempt counts, delays honored,
   * bounded exhaustion) deterministically instead of genuinely sleeping
   * through it.
   */
  ingestRetrySleep?: (ms: number) => Promise<void>;
  manifest: ConnectorManifest;
  onInteraction?: ((interaction: ConnectorMessage) => unknown) | null;
  onInteractionTerminal?: ((info: { interactionId: string; status: string }) => unknown) | null;
  onProgress?: (message: unknown) => void;
  onStarted?: ((info: { run_id: string; scenario_id?: string; trace_id: string }) => void) | null;
  /** Authenticated owner for standalone default-account resolution. */
  ownerSubjectId?: string | null;
  ownerToken: string;
  persistState?: boolean;
  /**
   * Recovery-only run mode: the connector drains already-durable recoverable
   * detail gaps and returns before ordinary forward/list collection.
   */
  recoveryOnly?: boolean;
  /**
   * Mode-A streaming-target registration: AS base URL the spawned
   * connector child should POST to. Forwarded as
   * `PDPP_REFERENCE_BASE_URL`. Both `referenceBaseUrl` and
   * `streamingRegistrationToken` are required for the spawn env block to
   * include the streaming registration vars; either omitted is a
   * graceful no-op.
   */
  referenceBaseUrl?: string | null;
  rsUrl?: string;
  runId?: string;
  scenarioId?: string;
  scope?: { streams?: unknown } | null;
  state?: Record<string, unknown> | null;
  /**
   * Connection-scoped environment fragment from the resolver: stored
   * credentials, provider authorization, or manual-upload/local-path state.
   * It overrides only current-manifest ambient fallback values. Platform and
   * run-control names are rejected, and explicit run controls retain priority.
   * See add-static-secret-owner-connect-primitive design Decision 5.
   */
  staticSecretEnv?: Record<string, string> | null;
  /**
   * Mode-A streaming-target registration: per-run shared secret minted
   * by the controller. Forwarded as
   * `PDPP_STREAMING_REGISTRATION_TOKEN`. The child sends it as a Bearer
   * credential when it registers its CDP page-target wsUrl. Hashed at
   * the registry; never logged.
   */
  streamingRegistrationToken?: string | null;
  traceContext?: RuntimeTraceContext;
  triggerKind?: RuntimeRunTriggerKind | null;
}

/**
 * Bounded, redacted excerpt of connector-authored stderr captured for
 * connector exits before DONE. See
 * openspec/changes/persist-connector-failure-diagnostics.
 *
 * The text is connector-authored and untrusted — owner UI MUST label it
 * as such and SHOULD render it as a collapsed/preformatted diagnostic
 * panel rather than presenting it as a runtime-verified PDPP error.
 */
export interface ConnectorStderrTailDiagnostic {
  readonly bytes_captured: number;
  readonly bytes_observed: number;
  readonly encoding: "utf-8";
  readonly object: "connector_stderr_tail";
  readonly redacted: boolean;
  readonly text: string;
  readonly truncated: boolean;
}

export interface ConnectorRunDiagnostics {
  readonly stderr_tail?: ConnectorStderrTailDiagnostic;
}

export type RuntimeFailureOrigin = "connector" | "runtime" | "storage" | "transport";

export interface RuntimeRunConnectorResult {
  automation_mode?: RuntimeRunAutomationMode | null;
  checkpoint_summary?: Record<string, unknown> | null;
  connector_diagnostics?: ConnectorRunDiagnostics;
  connector_error?: ConnectorDoneError | null;
  detail_gaps?: Array<{
    gap_id?: string | null;
    reason?: string | null;
    status?: string | null;
    stream?: string | null;
  }>;
  /**
   * Connector child exit code. The runtime sets this on every resolved run
   * (the old ambient declaration omitted it, which forced consumers to
   * re-widen the type locally).
   */
  exit_code?: number | null;
  failure_message?: string | null;
  failure_origin?: RuntimeFailureOrigin;
  known_gaps?: Record<string, unknown>[] | null;
  message?: string;
  records_accepted?: number;
  records_attempted?: number;
  records_emitted?: number;
  records_permanently_rejected?: number;
  records_unresolved_retryable?: number;
  reported_records_emitted?: number | null;
  run_id?: string | null;
  state?: unknown;
  status: "cancelled" | "failed" | "skipped" | "succeeded";
  /**
   * When a stdin write to the connector child failed (closed pipe) rather
   * than a clean DONE/exit, names the protocol phase the failed write was
   * attempting ('start' | 'interaction_response' | 'unknown'). See
   * runtime/terminal-reason.ts's DeriveTerminalReasonInput for the paired
   * terminal_reason contract.
   */
  stdin_closed_at_phase?: string;
  terminal_reason?: string | null;
  trace_id?: string | null;
  trigger_kind?: RuntimeRunTriggerKind | null;
}

// ─── Owned connector-child process-group registry ──────────────────────────
//
// Every connector child is spawned `detached` (its own process group; see the
// spawn site in `runConnector`). The runtime reaps that group on the run's own
// terminal paths (cancel / failure / protocol violation / error). But if the
// PARENT process dies abnormally — an `uncaughtException`/`unhandledRejection`
// that takes `process.exit(1)` (server/index.js handleUncaught), or any
// `process.exit()` with in-flight runs — Node does NOT propagate a signal to
// children, so a still-running connector group would reparent to PID 1 and
// orphan. That is exactly the run_1780436796334 / run_1780436796294 symptom.
//
// This registry closes that last gap: each live child's PID (== its PGID,
// because it leads its own group) is tracked while the run is in flight and
// removed on the run's terminal path. A SINGLE, idempotent `process.on('exit')`
// handler sweeps the registry and best-effort SIGTERMs each surviving group, so
// the runtime never leaves an owned connector subtree behind when its own
// process exits.
//
// `process.on('exit')` handlers must be synchronous; `process.kill(-pgid,...)`
// is synchronous and best-effort, which is the right shape here. The handler is
// installed at most once per module instance (the install-once guard) so the
// many-`runConnector`-calls-per-process test harness can't accumulate
// listeners — the same accumulation hazard that keeps the signal handlers in
// server/index.js behind an `argv[1]` guard.
const ownedConnectorChildPids = new Set<number>();
let connectorChildExitSweepInstalled = false;

function installConnectorChildExitSweepOnce() {
  if (connectorChildExitSweepInstalled) {
    return;
  }
  connectorChildExitSweepInstalled = true;
  // 'exit' fires on normal exit AND on process.exit()/fatal-handler exit, but
  // NOT on SIGKILL/SIGSTOP (uninterceptable) — those are covered at the
  // container/orchestrator layer. Synchronous, best-effort, never throws.
  process.on("exit", () => {
    for (const pid of ownedConnectorChildPids) {
      if (typeof pid !== "number" || pid <= 1) {
        continue;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // Group already gone, or un-signalable; nothing else we can do
        // synchronously from an exit handler.
      }
    }
  });
}

function registerOwnedConnectorChild(pid: number | undefined): void {
  if (typeof pid !== "number" || pid <= 1) {
    return;
  }
  installConnectorChildExitSweepOnce();
  ownedConnectorChildPids.add(pid);
}

function unregisterOwnedConnectorChild(pid: number | undefined): void {
  if (typeof pid !== "number") {
    return;
  }
  ownedConnectorChildPids.delete(pid);
}

function encodeScopeResourceKey(key: unknown): string {
  return Array.isArray(key) ? JSON.stringify(key) : String(key);
}

function readStreamResourceField(manifestStream: ManifestStream | null | undefined): string | null {
  const selection = manifestStream?.selection;
  const field =
    selection && typeof selection === "object" && !Array.isArray(selection) ? selection.resource_field : null;
  return typeof field === "string" && field.length > 0 ? field : null;
}

function recordMatchesScopeResource(
  resources: string[] | null | undefined,
  key: unknown,
  data: unknown,
  manifestStream: ManifestStream | null | undefined
): boolean {
  if (!(Array.isArray(resources) && resources.length)) {
    return true;
  }
  const allowed = new Set(resources.map(String));
  if (allowed.has(encodeScopeResourceKey(key))) {
    return true;
  }
  const resourceField = readStreamResourceField(manifestStream);
  if (!(resourceField && data && typeof data === "object" && !Array.isArray(data))) {
    return false;
  }
  const value = (data as Record<string, unknown>)[resourceField];
  if (isNullish(value)) {
    return false;
  }
  const resourceKey = Array.isArray(value) ? JSON.stringify(value.map(String)) : String(value);
  return allowed.has(resourceKey);
}

function buildRunSourceDescriptor(connectorId: string): { id: string; kind: string } {
  return { id: connectorId, kind: "connector" };
}

function buildRunConnectionIdentity(connectorInstanceId: string | null): Record<string, string> {
  return connectorInstanceId
    ? {
        connection_id: connectorInstanceId,
        connector_instance_id: connectorInstanceId,
      }
    : {};
}

function resolveRuntimeConnectorInstanceId(input: {
  connectorId: string;
  connectorInstanceId: string | null;
  manifest: ConnectorManifest;
}): string | null {
  const explicit = optionalNonEmptyEnv(input.connectorInstanceId);
  if (explicit) {
    return explicit;
  }
  const manifestBinding = optionalNonEmptyEnv(input.manifest.storage_binding?.connector_instance_id);
  if (manifestBinding) {
    return manifestBinding;
  }
  return null;
}

async function admitRuntimeRunConnection(
  admitRunConnection: RuntimeRunConnectorOptions["admitRunConnection"],
  input: { connectorId: string; connectorInstanceId: string | null; ownerSubjectId: string | null }
): Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  if (!admitRunConnection) {
    throw new Error("runConnector: an admitted run connection is required before run.started.");
  }
  const admittedConnection = await admitRunConnection(input);
  if (
    admittedConnection.connectorId !== input.connectorId ||
    (input.connectorInstanceId !== null && admittedConnection.connectorInstanceId !== input.connectorInstanceId) ||
    (input.ownerSubjectId !== null && admittedConnection.ownerSubjectId !== input.ownerSubjectId)
  ) {
    throw new Error("runConnector: admission did not authorize the claimed owner connection.");
  }
  return admittedConnection;
}

function appendUniqueFields(fields: string[], extraFields: string[]): string[] {
  const normalized = [...fields];
  const seen = new Set(fields);
  for (const field of extraFields) {
    if (!field || seen.has(field)) {
      continue;
    }
    normalized.push(field);
    seen.add(field);
  }
  return normalized;
}

function buildScopeFields(
  streamScope: StreamScope,
  manifestStream: ManifestStream | null | undefined
): string[] | null | undefined {
  if (!Array.isArray(streamScope.fields)) {
    return streamScope.fields;
  }

  const requiredFields = manifestStream?.schema?.required || [];
  let primaryKeyFields: string[] = [];
  if (Array.isArray(manifestStream?.primary_key)) {
    primaryKeyFields = manifestStream.primary_key;
  } else if (manifestStream?.primary_key) {
    primaryKeyFields = [manifestStream.primary_key];
  }
  const timeRangeFields =
    streamScope.time_range && manifestStream?.consent_time_field ? [manifestStream.consent_time_field] : [];

  return appendUniqueFields(streamScope.fields, [...requiredFields, ...primaryKeyFields, ...timeRangeFields]);
}

function buildAvailableBindings(onInteraction: unknown): AvailableBindings {
  // In this reference runtime, connectors run as local Node child processes
  // with full filesystem access by virtue of being child processes. We
  // advertise `filesystem` so file-based connectors can declare it as a
  // required binding per the Collection Profile spec.
  const bindings: AvailableBindings = { browser: {}, filesystem: {}, network: {} };
  if (typeof onInteraction === "function") {
    bindings.interactive = {};
  }
  return bindings;
}

async function readIngestResponse(resp: Response, stream: string, batchSize: number): Promise<IngestResult> {
  const contentType = resp.headers.get("content-type");
  const bodyText = await resp.text();
  if (!resp.ok) {
    throw buildIngestHttpFailure(`Ingest failed for ${stream}`, stream, batchSize, resp.status, bodyText, contentType);
  }

  // The RS response body is untrusted until the two counters below are proven
  // finite, so it is parsed as `unknown` and only then asserted `IngestResult`.
  let result: Partial<IngestResult> | null;
  try {
    result = JSON.parse(bodyText) as Partial<IngestResult> | null;
  } catch (err) {
    throw buildInvalidIngestResponseFailure({
      batchSize,
      bodyText,
      cause: err instanceof Error ? err.message : String(err),
      contentType,
      phase: "parse_response",
      status: resp.status,
      stream,
    });
  }

  if (!(result && Number.isFinite(result.records_accepted) && Number.isFinite(result.records_rejected))) {
    throw buildInvalidIngestResponseFailure({
      batchSize,
      bodyText,
      cause: "expected numeric records_accepted and records_rejected",
      contentType,
      phase: "validate_response",
      status: resp.status,
      stream,
    });
  }

  return result as IngestResult;
}

/**
 * Runtime-authored structured diagnosis for a protocol violation.
 *
 * Scope (vertical slice): only `progress_for_undeclared_stream` is emitted
 * today. Remaining subtypes — listed in tmp/opaque-violation-diagnosis-memo.md —
 * are deferred until the shape proves out on a real case. If/when the full
 * enumeration lands, it should land via a dedicated OpenSpec change first.
 *
 * Invariants (must hold for every subtype ever added):
 *   - Runtime-authored only. A connector cannot construct or author this
 *     object — the runtime instantiates it at validator sites.
 *   - Field/stream NAMES are safe; record PAYLOAD and user-supplied VALUES
 *     are NEVER placed in a public field. (`received` is a stream/type name,
 *     not a record body.)
 *   - All fields are size-bounded by `toPublicShape()`.
 *   - Purely additive to the `run.failed` event shape — legacy consumers
 *     that don't know about `data.violation` keep working unchanged.
 */
const KNOWN_GAPS_MAX = 50;

// Connector stderr-tail diagnostic. `tail` is the {text, bytes_observed,
// bytes_captured, truncated} object returned by the bounded stderr tail
// buffer. Returns the persistable shape:
//
//   {
//     object: 'connector_stderr_tail',
//     encoding: 'utf-8',
//     text: <redacted excerpt>,
//     bytes_observed: <int>,
//     bytes_captured: <int>,
//     truncated: <bool>,
//     redacted: <bool>,
//   }
//
// or null when the connector wrote no stderr.
// Concise runtime-authored failure_message for connector exits before DONE.
// Owner UI uses this as the authoritative line; the connector-authored
// stderr tail is supplementary, untrusted evidence.
function buildConnectorExitFailureMessage({
  code,
  reason,
  phase,
}: {
  code?: number | null;
  phase?: string | null;
  reason?: string | null;
}): string {
  if (reason === "connector_stdin_closed") {
    const phaseLabel = phase && phase !== "unknown" ? ` during ${phase}` : "";
    return `Connector closed its stdin${phaseLabel} before emitting DONE.`;
  }
  if (typeof code === "number" && Number.isFinite(code)) {
    return `Connector exited with code ${code} before emitting DONE.`;
  }
  return "Connector exited before emitting DONE.";
}

/**
 * Single source of truth for the runtime-authored failure_message on a
 * scheduler-timeout / assistance-timeout close. Previously this exact text
 * was hand-duplicated ONLY inside `recordRunTimedOutTerminal` (which feeds
 * the terminal spine event's `failure_message`) — `deriveClosedRunResolution`
 * (which feeds the RESOLVED `runConnector()` promise's `failure_message`,
 * i.e. what the scheduler's run_history.failure_reason column actually reads)
 * had no equivalent and fell through to the generic
 * `buildConnectorExitFailureMessage` ("Connector exited with code N before
 * emitting DONE.") — accurate but useless for diagnosing WHY: an owner
 * reading run_history could not tell an assistance timeout from an ordinary
 * scheduler wall-clock timeout without a separate spine-event lookup. See
 * chatgpt-ingest-and-assistance-failure-modes-2026-08-18.
 */
function runTimeoutFailureMessage(terminalReason: string): string {
  return terminalReason === "assistance_timed_out"
    ? "Run exceeded a connector assistance timeout."
    : "Run exceeded its scheduler wall-clock budget.";
}

// Bounds a runtime-thrown Error's own message before it's persisted as
// `failure_message` on a terminal spine event, mirroring
// `controller.ts`'s `boundedLaunchFailureMessage` — a pathological error
// (e.g. one embedding a large payload) can't bloat the terminal row.
const RUNTIME_FAILURE_MESSAGE_MAX = 500;

function boundedRuntimeFailureMessage(message: string): string {
  return message.length > RUNTIME_FAILURE_MESSAGE_MAX ? `${message.slice(0, RUNTIME_FAILURE_MESSAGE_MAX)}…` : message;
}

// A runtime-side throw (mid-stream message processing, or the post-close
// finalize path) with no more specific structured shape — a
// connector-reported DONE.error, an ingest failure detail, or a protocol
// violation, each of which already carries its own explanation — would
// otherwise reach the terminal spine event with nothing beyond the
// classified `reason` code (usually the generic "runtime_error" fallback).
// Shared by handleMessageFailure and handleCloseFailure so the terminal
// event always carries the thrown error's own message when nothing else
// explains the failure.
function runtimeAuthoredFailureMessage(
  err: RuntimeRunError,
  doneMessageError: ConnectorDoneError | null | undefined
): string | null {
  const hasStructuredFailureDetail =
    Boolean(doneMessageError) || Boolean(err.ingest_failure) || err instanceof ProtocolViolation;
  return !hasStructuredFailureDetail && err.message ? boundedRuntimeFailureMessage(err.message) : null;
}

function buildStderrTailDiagnostic(tail: StderrTail | null | undefined): Record<string, unknown> | null {
  if (!tail || typeof tail !== "object") {
    return null;
  }
  if (!tail.text || tail.bytes_captured === 0) {
    return null;
  }
  const { text: redactedText, redacted } = redactStderrTail(tail.text);
  return {
    bytes_captured: tail.bytes_captured,
    bytes_observed: tail.bytes_observed,
    encoding: "utf-8",
    object: "connector_stderr_tail",
    redacted,
    text: redactedText,
    truncated: Boolean(tail.truncated),
  };
}

function isRuntimeRetryableBrowserProfileError(message: unknown): boolean {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  return (
    (text.includes("network.setcachedisabled") && text.includes("session closed")) ||
    (text.includes("target.attachtotarget") && text.includes("session closed")) ||
    text.includes("internal server error, session closed")
  );
}

function streamUnsupportedInDefaultScope(stream: ManifestStream | null | undefined): boolean {
  return stream?.availability?.state === "unsupported_in_mode";
}

function summarizeKnownGaps(gaps: Record<string, unknown>[]): {
  by_reason: Record<string, number>;
  count: number;
  truncated: boolean;
} {
  const byReason: Record<string, number> = {};
  for (const gap of gaps) {
    const reason = String(gap.reason);
    byReason[reason] = (byReason[reason] || 0) + 1;
  }
  return {
    by_reason: byReason,
    count: gaps.length,
    truncated: gaps.length > KNOWN_GAPS_MAX,
  };
}

function toPublicIngestFailure(value: IngestFailureDetail | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const out: Record<string, unknown> = {};
  const stream = boundString(value.stream);
  const phase = boundString(value.phase);
  const contentType = boundString(value.response_content_type);
  if (stream) {
    out.stream = stream;
  }
  if (Number.isFinite(value.batch_size)) {
    out.batch_size = value.batch_size;
  }
  if (Number.isFinite(value.http_status)) {
    out.http_status = value.http_status;
  }
  if (phase) {
    out.phase = phase;
  }
  if (contentType) {
    out.response_content_type = contentType;
  }
  if (Number.isFinite(value.response_body_bytes)) {
    out.response_body_bytes = value.response_body_bytes;
  }
  return Object.keys(out).length ? out : null;
}

class ProtocolViolation extends Error {
  readonly extras: Record<string, unknown>;
  readonly subtype: string;

  constructor({ subtype, message, ...extras }: { message: string; subtype: string } & Record<string, unknown>) {
    super(message);
    this.name = "ProtocolViolation";
    this.subtype = subtype;
    this.extras = extras;
  }

  /**
   * Bound, sanitized, timeline-safe projection. Returning a plain object
   * here (rather than the raw `extras`) is load-bearing: this is what
   * lands in persisted spine events + gets rendered in the dashboard.
   */
  toPublicShape({
    lastValidSpineEvent = null,
  }: {
    lastValidSpineEvent?: LastValidSpineEvent | null;
  } = {}): Record<string, unknown> {
    const out: Record<string, unknown> = { subtype: this.subtype };
    if (this.subtype === "progress_for_undeclared_stream") {
      const { message_type, stream, expected, received } = this.extras;
      out.message_type = boundString(message_type);
      out.stream = boundString(stream);
      const boundedExpected = boundStringList(expected);
      if (boundedExpected) {
        out.expected = boundedExpected;
      }
      out.received = boundString(received);
      if (Array.isArray(expected) && expected.length > VIOLATION_LIST_MAX) {
        out.truncated = true;
      }
    }
    if (lastValidSpineEvent?.event_id) {
      out.last_valid_event_id = lastValidSpineEvent.event_id;
      if (lastValidSpineEvent.event_type) {
        out.last_valid_event_type = lastValidSpineEvent.event_type;
      }
    }
    return out;
  }
}

/**
 * True when an ingest failure is the transient-manifest-drift case that is safe
 * to reclassify as a per-stream gap: an HTTP 404 `not_found` in the ingest
 * `http_response` phase, for a stream the runtime already admitted into START
 * scope (`isInStartScope`). The START-scope gate is load-bearing — it proves the
 * stream survived `buildStartScope`'s manifest check, so a not_found can only mean
 * the RS's manifest read disagrees with the runtime's (drift), never a genuine
 * "connector emits an undeclared stream" schema error (which is rejected earlier,
 * before ingest). Every other status/code stays terminal. See OpenSpec change
 * harden-ingest-against-transient-manifest-drift.
 */
export function isTransientManifestDriftIngestFailure(
  err: RuntimeRunError | null | undefined,
  stream: unknown,
  isInStartScope: (stream: string) => boolean
): boolean {
  return Boolean(
    err &&
      err.response_status === 404 &&
      err.pdpp_error_code === "not_found" &&
      err.ingest_failure?.phase === "http_response" &&
      typeof stream === "string" &&
      isInStartScope(stream)
  );
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function validateStartScopeTimeRange(streamScope: StreamScope): void {
  if (isNullish(streamScope.time_range)) {
    return;
  }
  if (typeof streamScope.time_range !== "object" || Array.isArray(streamScope.time_range)) {
    throw new Error(`START.scope stream '${streamScope.name}' time_range must be an object`);
  }
  const { since, until } = streamScope.time_range;
  if (
    (!isNullish(since) && (typeof since !== "string" || !since.trim())) ||
    (!isNullish(until) && (typeof until !== "string" || !until.trim()))
  ) {
    throw new Error(`START.scope stream '${streamScope.name}' time_range bounds must be non-empty strings`);
  }
}

function validateStartScopeStream(streamScope: StreamScope, manifestStream: ManifestStream | undefined): StreamScope {
  if (!streamScope.name.trim()) {
    throw new Error("START.scope streams must include non-empty stream names");
  }
  if (streamScope.name === "*") {
    throw new Error("START.scope must not include wildcard stream names");
  }
  if (!manifestStream) {
    throw new Error(`START.scope stream '${streamScope.name}' does not exist in the manifest`);
  }
  if ("view" in streamScope) {
    throw new Error(`START.scope stream '${streamScope.name}' must not include unresolved view names`);
  }
  if ("necessity" in streamScope) {
    throw new Error(`START.scope stream '${streamScope.name}' must not include issuance-time necessity values`);
  }
  if (
    !isNullish(streamScope.resources) &&
    (!Array.isArray(streamScope.resources) ||
      streamScope.resources.some((resource: unknown) => typeof resource !== "string"))
  ) {
    throw new Error(`START.scope stream '${streamScope.name}' resources must be an array of strings`);
  }
  if (
    !isNullish(streamScope.fields) &&
    (!Array.isArray(streamScope.fields) ||
      streamScope.fields.some((field: unknown) => typeof field !== "string" || !field.trim()))
  ) {
    throw new Error(`START.scope stream '${streamScope.name}' fields must be an array of non-empty field names`);
  }
  validateStartScopeTimeRange(streamScope);
  return {
    ...streamScope,
    ...(Array.isArray(streamScope.fields) ? { fields: buildScopeFields(streamScope, manifestStream) } : {}),
  } as StreamScope;
}

function buildStartScope(
  manifest: ConnectorManifest | null | undefined,
  providedScope: { streams?: unknown } | null | undefined,
  declaredCollectionScopeSince?: string | null
): StartScope {
  const manifestByStream = new Map<string, ManifestStream>(
    (manifest?.streams || []).map((stream) => [stream.name, stream])
  );

  if (!isNullish(providedScope)) {
    const scope = providedScope;
    if (!(Array.isArray(scope.streams) && scope.streams.length)) {
      throw new Error("START.scope must include a non-empty streams array");
    }
    return {
      streams: scope.streams.map((streamScope: StreamScope) =>
        validateStartScopeStream(streamScope, manifestByStream.get(streamScope.name))
      ),
    };
  }

  // No explicit per-run scope: fold in the connection's own durably-declared
  // `collection_scope.since` (owner-set via
  // `PUT /v1/owner/connections/:id/collection-scope`) as the default
  // `time_range.since` for streams the MANIFEST itself declares as temporal
  // (a non-empty `consent_time_field`). This is the only place a hosted (non
  // local-device) run's scope reaches the connector: `runNow` never builds an
  // explicit `providedScope` for an ordinary sync, so without this the owner's
  // declared boundary would be persisted but never delivered. Gating by
  // `consent_time_field` matters: a stream with no such field has no
  // manifest-declared notion of "when" a row happened, so attaching a
  // `time_range` to it would assert a temporal scope the stream can neither
  // define nor enforce (and the emission gate, `passesTimeRange`, only ever
  // checks a `consent_time_field` value in the first place — a non-temporal
  // stream given a `time_range` would have it silently ignored downstream
  // too, so omitting it here keeps the START message honest about which
  // streams the boundary actually applies to).
  const streams = (manifest?.streams || [])
    .filter((stream) => !streamUnsupportedInDefaultScope(stream))
    .map((stream) => ({
      name: stream.name,
      ...(declaredCollectionScopeSince && stream.consent_time_field
        ? { time_range: { since: declaredCollectionScopeSince } }
        : {}),
    }));
  if (!streams.length) {
    throw new Error("START.scope requires at least one stream");
  }

  return { streams };
}

function validateCollectionMode(collectionMode: unknown): "full_refresh" | "incremental" {
  if (collectionMode === "full_refresh" || collectionMode === "incremental") {
    return collectionMode;
  }
  throw new Error(`START.collection_mode must be 'full_refresh' or 'incremental'; received: ${collectionMode}`);
}

function validateStartState(state: unknown): Record<string, unknown> | null {
  if (isNullish(state)) {
    return null;
  }
  if (typeof state === "object" && !Array.isArray(state)) {
    for (const [stream, cursor] of Object.entries(state)) {
      if (!isNullish(cursor) && (typeof cursor !== "object" || Array.isArray(cursor))) {
        throw new Error(`START.state stream '${stream}' must be an object or null`);
      }
    }
    return state as Record<string, unknown>;
  }
  throw new Error("START.state must be an object or null");
}

function validateStateMessage(msg: ConnectorMessage, scopeByStream: ScopeByStream): void {
  if (typeof msg.stream !== "string" || !msg.stream.trim()) {
    throw new Error("Connector emitted invalid STATE.stream: expected non-empty string");
  }
  if (!scopeByStream.has(msg.stream)) {
    throw new Error(`Connector emitted STATE for undeclared stream: ${msg.stream}`);
  }
  if (!isNullish(msg.cursor) && (typeof msg.cursor !== "object" || Array.isArray(msg.cursor))) {
    throw new Error("Connector emitted invalid STATE.cursor: expected object or null");
  }
}

function passesTimeRange(
  data: unknown,
  timeRange: { since?: string | null; until?: string | null } | null | undefined,
  consentTimeField: string | null | undefined
): boolean {
  if (!(timeRange && consentTimeField)) {
    return true;
  }
  const value = (data as Record<string, unknown> | null | undefined)?.[consentTimeField];
  if (!value) {
    return false;
  }
  const timestamp = new Date(value as string).getTime();
  if (Number.isNaN(timestamp)) {
    return false;
  }
  if (timeRange.since && timestamp < new Date(timeRange.since).getTime()) {
    return false;
  }
  if (timeRange.until && timestamp >= new Date(timeRange.until).getTime()) {
    return false;
  }
  return true;
}

function requireOptionalNonEmptyString(value: unknown, fieldName: string): void {
  if (isNullish(value)) {
    return;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Connector emitted invalid ${fieldName}: expected non-empty string`);
  }
}

/**
 * `stream` is `unknown` because it comes straight off the connector envelope,
 * but every caller runs `requireOptionalNonEmptyString` on it first — so by the
 * time the membership check below runs, a non-null value is a string.
 */
function validateOptionalScopedStream(stream: unknown, envelopeType: string, scopeByStream: ScopeByStream): void {
  if (isNullish(stream)) {
    return;
  }
  if (!scopeByStream.has(stream as string)) {
    // String form preserved for back-compat with classifyRuntimeFailure's
    // pattern match (still yields top-level reason: connector_protocol_violation).
    // For PROGRESS specifically we also carry a machine-readable ProtocolViolation;
    // other envelope types keep the legacy plain Error for now (tracked in
    // tmp/opaque-violation-diagnosis-memo.md).
    const message = `Connector emitted ${envelopeType} for undeclared stream: ${stream}`;
    if (envelopeType === "PROGRESS") {
      throw new ProtocolViolation({
        expected: Array.from(scopeByStream.keys()),
        message,
        message_type: "PROGRESS",
        received: stream,
        stream,
        subtype: "progress_for_undeclared_stream",
      });
    }
    throw new Error(message);
  }
}

function validateProgressMessage(msg: ConnectorMessage, scopeByStream: ScopeByStream): void {
  requireOptionalNonEmptyString(msg.stream, "PROGRESS.stream");
  validateOptionalScopedStream(msg.stream, "PROGRESS", scopeByStream);
  if (typeof msg.message !== "string" || !msg.message.trim()) {
    throw new Error("Connector emitted invalid PROGRESS.message: expected non-empty string");
  }
  for (const fieldName of ["count", "total"]) {
    const value = msg[fieldName];
    if (isNullish(value)) {
      continue;
    }
    if (!Number.isFinite(value) || (value as number) < 0) {
      throw new Error(`Connector emitted invalid PROGRESS.${fieldName}: expected non-negative number`);
    }
  }
  if (!isNullish(msg.provider_budget)) {
    validateProgressProviderBudget(msg.provider_budget);
  }
  if (!isNullish(msg.collection_rate)) {
    validateProgressCollectionRate(msg.collection_rate);
  }
  if (!isNullish(msg.attachment_recovery_outcome)) {
    validateProgressAttachmentRecoveryOutcome(msg.attachment_recovery_outcome);
  }
  if (!isNullish(msg.attachment_hydration_failure_outcome)) {
    validateProgressAttachmentHydrationFailureOutcome(msg.attachment_hydration_failure_outcome);
  }
  // Both fields were just proven object-shaped by the two validators above
  // (or are null/undefined, which the sum check accepts).
  validateProgressAttachmentHydrationFailureOutcomeSum(
    msg.attachment_recovery_outcome as AttachmentOutcome | null | undefined,
    msg.attachment_hydration_failure_outcome as AttachmentOutcome | null | undefined
  );
}

function validateSkipRecoveryHint(value: unknown): void {
  if (!isValidRecoveryHintShape(value)) {
    throw new Error("Connector emitted invalid SKIP_RESULT.recovery_hint");
  }
}

function validateSkipStringArray(value: unknown, fieldName: string): void {
  if (
    !isNullish(value) &&
    (!Array.isArray(value) || value.some((entry: unknown) => typeof entry !== "string" || !entry.trim()))
  ) {
    throw new Error(`Connector emitted invalid SKIP_RESULT.${fieldName}: expected non-empty string array`);
  }
}

function validateSkipTimeRange(value: unknown): void {
  if (isNullish(value)) {
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connector emitted invalid SKIP_RESULT.time_range: expected object");
  }
  const timeRange = value as Record<string, unknown>;
  for (const fieldName of ["since", "until"]) {
    const bound = timeRange[fieldName];
    if (!isNullish(bound) && (typeof bound !== "string" || !bound.trim())) {
      throw new Error(`Connector emitted invalid SKIP_RESULT.time_range.${fieldName}: expected non-empty string`);
    }
  }
}

function validateSkipResultMessage(msg: ConnectorMessage, scopeByStream: ScopeByStream): void {
  requireOptionalNonEmptyString(msg.stream, "SKIP_RESULT.stream");
  validateOptionalScopedStream(msg.stream, "SKIP_RESULT", scopeByStream);
  requireOptionalNonEmptyString(msg.reason, "SKIP_RESULT.reason");
  requireOptionalNonEmptyString(msg.message, "SKIP_RESULT.message");
  validateSkipRecoveryHint(msg.recovery_hint);
  if (!isNullish(msg.continuation)) {
    validateRuntimeContinuationFact(msg.continuation);
  }
  validateSkipStringArray(msg.resource_ids, "resource_ids");
  validateSkipStringArray(msg.resources, "resources");
  validateSkipTimeRange(msg.time_range);
}

function validateDetailGapMessage(msg: ConnectorMessage, scopeByStream: ScopeByStream): void {
  requireOptionalNonEmptyString(msg.stream, "DETAIL_GAP.stream");
  if (!msg.stream) {
    throw new Error("Connector emitted invalid DETAIL_GAP.stream: expected non-empty string");
  }
  validateOptionalScopedStream(msg.stream, "DETAIL_GAP", scopeByStream);
  requireOptionalNonEmptyString(msg.parent_stream, "DETAIL_GAP.parent_stream");
  if (!isNullish(msg.record_key) && typeof msg.record_key !== "string" && typeof msg.record_key !== "number") {
    throw new Error("Connector emitted invalid DETAIL_GAP.record_key: expected string or number");
  }
  for (const fieldName of ["detail_locator", "list_cursor", "last_error"]) {
    if (!isNullish(msg[fieldName]) && (typeof msg[fieldName] !== "object" || Array.isArray(msg[fieldName]))) {
      throw new Error(`Connector emitted invalid DETAIL_GAP.${fieldName}: expected object`);
    }
  }
  requireOptionalNonEmptyString(msg.reason, "DETAIL_GAP.reason");
  if (!isNullish(msg.retryable) && typeof msg.retryable !== "boolean") {
    throw new Error("Connector emitted invalid DETAIL_GAP.retryable: expected boolean");
  }
  requireOptionalNonEmptyString(msg.gap_id, "DETAIL_GAP.gap_id");
  requireOptionalNonEmptyString(msg.lease_id, "DETAIL_GAP.lease_id");
}

function findServedDetailGapLease(leases: Map<string, ServedGapLease>, msg: ConnectorMessage): ServedGapLease | null {
  if (msg.gap_id) {
    return leases.get(msg.gap_id as string) || null;
  }
  if (isNullish(msg.record_key)) {
    return null;
  }
  const recordKey = String(msg.record_key);
  const parentStream = typeof msg.parent_stream === "string" ? msg.parent_stream : null;
  const matches = [...leases.values()].filter(
    (lease) => lease.stream === msg.stream && lease.recordKey === recordKey && lease.parentStream === parentStream
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function validateDetailGapAttemptedMessage(msg: ConnectorMessage, scopeByStream: ScopeByStream): void {
  requireOptionalNonEmptyString(msg.gap_id, "DETAIL_GAP_ATTEMPTED.gap_id");
  requireOptionalNonEmptyString(msg.lease_id, "DETAIL_GAP_ATTEMPTED.lease_id");
  requireOptionalNonEmptyString(msg.stream, "DETAIL_GAP_ATTEMPTED.stream");
  if (!(msg.gap_id && msg.lease_id && msg.stream) || msg.reference_only !== true) {
    throw new Error("Connector emitted invalid DETAIL_GAP_ATTEMPTED");
  }
  validateOptionalScopedStream(msg.stream, "DETAIL_GAP_ATTEMPTED", scopeByStream);
}

function assertCoverageKeyArray(value: unknown, fieldName: string): asserts value is (string | number)[] {
  if (!Array.isArray(value)) {
    throw new Error(`Connector emitted invalid DETAIL_COVERAGE.${fieldName}: expected string/number array`);
  }
  for (const key of value) {
    if (typeof key !== "string" && typeof key !== "number") {
      throw new Error(`Connector emitted invalid DETAIL_COVERAGE.${fieldName}: expected string/number array`);
    }
  }
}

function normalizeCoverageKey(key: string | number): string {
  return String(key);
}

function validateCoverageKeySets(msg: ConnectorMessage): void {
  const fields = ["required_keys", "hydrated_keys", "gap_keys", "optional_skip_keys"] as const;
  const keysByField = new Map<string, Set<string>>();
  for (const field of fields) {
    const values = (msg[field] as (string | number)[] | null | undefined) || [];
    const normalized = values.map(normalizeCoverageKey);
    const unique = new Set(normalized);
    if (unique.size !== normalized.length) {
      throw new Error(`Connector emitted invalid DETAIL_COVERAGE.${field}: duplicate key`);
    }
    keysByField.set(field, unique);
  }

  const required = keysByField.get("required_keys") as Set<string>;
  const outcomes = ["hydrated_keys", "gap_keys", "optional_skip_keys"] as const;
  const seenOutcomes = new Set<string>();
  for (const field of outcomes) {
    for (const key of keysByField.get(field) as Set<string>) {
      if (!required.has(key)) {
        throw new Error(`Connector emitted invalid DETAIL_COVERAGE.${field}: key not present in required_keys`);
      }
      if (seenOutcomes.has(key)) {
        throw new Error("Connector emitted invalid DETAIL_COVERAGE: outcome key appears in multiple sets");
      }
      seenOutcomes.add(key);
    }
  }
}

// Manifest-authoritative guard on live DETAIL_COVERAGE evidence (see
// spec-collection-profile.md, "Precedence between manifest and run-time
// evidence"). The manifest declares the *permitted* parent shape; live
// evidence may only select/report within it, never introduce a parent the
// manifest didn't declare, and a `state_stream`-declared (static single
// parent) stream must never emit DETAIL_COVERAGE at all — its checkpoint
// status is always projected from the declared parent's own commit outcome.
function validateDetailCoverageAgainstManifest(
  msg: ConnectorMessage,
  manifestStateStreamByStream: Map<string, string>,
  manifestDetailParentStreamsByStream: Map<string, Set<string>>
): void {
  const coverageStream = msg.stream as string;
  const coverageStateStream = msg.state_stream as string;
  if (manifestStateStreamByStream.has(coverageStream)) {
    throw new Error(
      `Connector emitted DETAIL_COVERAGE for stream '${coverageStream}', which the manifest declares with a` +
        " static state_stream parent; a state_stream-declared stream MUST NOT emit DETAIL_COVERAGE"
    );
  }
  const declaredParents = manifestDetailParentStreamsByStream.get(coverageStream);
  if (declaredParents && !declaredParents.has(coverageStateStream)) {
    throw new Error(
      `Connector emitted DETAIL_COVERAGE for stream '${coverageStream}' naming state_stream` +
        ` '${coverageStateStream}', which is not in the manifest's declared parent_streams for that stream`
    );
  }
}

function validateDetailCoverageMessage(
  msg: ConnectorMessage,
  scopeByStream: ScopeByStream,
  manifestStateStreamByStream: Map<string, string>,
  manifestDetailParentStreamsByStream: Map<string, Set<string>>
): void {
  if (msg.reference_only !== true) {
    throw new Error("Connector emitted invalid DETAIL_COVERAGE.reference_only: expected true");
  }
  requireOptionalNonEmptyString(msg.state_stream, "DETAIL_COVERAGE.state_stream");
  if (!msg.state_stream) {
    throw new Error("Connector emitted invalid DETAIL_COVERAGE.state_stream: expected non-empty string");
  }
  validateOptionalScopedStream(msg.state_stream, "DETAIL_COVERAGE", scopeByStream);
  requireOptionalNonEmptyString(msg.stream, "DETAIL_COVERAGE.stream");
  if (!msg.stream) {
    throw new Error("Connector emitted invalid DETAIL_COVERAGE.stream: expected non-empty string");
  }
  validateOptionalScopedStream(msg.stream, "DETAIL_COVERAGE", scopeByStream);

  assertCoverageKeyArray(msg.required_keys, "required_keys");
  assertCoverageKeyArray(msg.hydrated_keys, "hydrated_keys");
  if (!isNullish(msg.gap_keys)) {
    assertCoverageKeyArray(msg.gap_keys, "gap_keys");
  }
  if (!isNullish(msg.optional_skip_keys)) {
    assertCoverageKeyArray(msg.optional_skip_keys, "optional_skip_keys");
  }
  validateCoverageKeySets(msg);
  validateDetailCoverageAgainstManifest(msg, manifestStateStreamByStream, manifestDetailParentStreamsByStream);
}

function validateDetailGapRecoveredMessage(msg: ConnectorMessage, scopeByStream: ScopeByStream): void {
  requireOptionalNonEmptyString(msg.gap_id, "DETAIL_GAP_RECOVERED.gap_id");
  if (!msg.gap_id) {
    throw new Error("Connector emitted invalid DETAIL_GAP_RECOVERED.gap_id: expected non-empty string");
  }
  requireOptionalNonEmptyString(msg.stream, "DETAIL_GAP_RECOVERED.stream");
  if (!msg.stream) {
    throw new Error("Connector emitted invalid DETAIL_GAP_RECOVERED.stream: expected non-empty string");
  }
  validateOptionalScopedStream(msg.stream, "DETAIL_GAP_RECOVERED", scopeByStream);
  if (msg.reference_only !== true) {
    throw new Error("Connector emitted invalid DETAIL_GAP_RECOVERED.reference_only: expected true");
  }
  if (!isNullish(msg.record_key) && typeof msg.record_key !== "string" && typeof msg.record_key !== "number") {
    throw new Error("Connector emitted invalid DETAIL_GAP_RECOVERED.record_key: expected string or number");
  }
  requireOptionalNonEmptyString(msg.lease_id, "DETAIL_GAP_RECOVERED.lease_id");
}

function validateInteractionMessage(msg: ConnectorMessage, scopeByStream: ScopeByStream): void {
  if (typeof msg.request_id !== "string" || !msg.request_id.trim()) {
    throw new Error("Connector emitted invalid INTERACTION.request_id: expected non-empty string");
  }
  if (!["credentials", "otp", "manual_action"].includes(msg.kind as string)) {
    throw new Error(`Connector emitted invalid INTERACTION.kind: ${msg.kind}`);
  }
  requireOptionalNonEmptyString(msg.stream, "INTERACTION.stream");
  validateOptionalScopedStream(msg.stream, "INTERACTION", scopeByStream);
  if (typeof msg.message !== "string" || !msg.message.trim()) {
    throw new Error("Connector emitted invalid INTERACTION.message: expected non-empty string");
  }
  if (!isNullish(msg.schema) && (typeof msg.schema !== "object" || Array.isArray(msg.schema))) {
    throw new Error("Connector emitted invalid INTERACTION.schema: expected object");
  }
  if (
    !isNullish(msg.timeout_seconds) &&
    (!Number.isFinite(msg.timeout_seconds) || (msg.timeout_seconds as number) <= 0)
  ) {
    throw new Error(`Connector emitted invalid INTERACTION.timeout_seconds: ${msg.timeout_seconds}`);
  }
}

const ASSISTANCE_PROGRESS_POSTURES = new Set(["running", "blocked", "waiting_retry"]);
const ASSISTANCE_OWNER_ACTIONS = new Set(["none", "act_elsewhere", "provide_value", "operate_attachment"]);
const ASSISTANCE_RESPONSE_CONTRACTS = new Set(["none", "response_required"]);
const ASSISTANCE_SENSITIVITIES = new Set(["none", "secret", "non_secret"]);
const ASSISTANCE_ATTACHMENT_KINDS = new Set(["browser_surface", "url", "qr", "file", "fixture"]);
const ASSISTANCE_TERMINAL_STATUSES = new Set(["resolved", "cancelled", "timed_out", "escalated"]);

function safeAttachmentString(value: unknown, maxLength = 160): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

function sanitizeAssistanceTimelineString(value: unknown, maxLength = GAP_STRING_MAX): string | null {
  const redacted = boundGapString(value);
  if (!redacted) {
    return null;
  }
  const sanitized = redacted
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/gi, "[REDACTED_URL]")
    .replace(
      /\b((?:qr[_-]?)?(?:secret|token|password|passwd|cookie|otp|bearer))\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /\b((?:cdp|playwright|webrtc|neko)[_-]?(?:url|uri|endpoint|token|secret))\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[REDACTED]"
    );
  if (sanitized.length <= maxLength) {
    return sanitized;
  }
  return `${sanitized.slice(0, maxLength - 1)}…`;
}

function sanitizeAssistanceInputSchema(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry: unknown) => sanitizeAssistanceInputSchema(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeAssistanceTimelineString(value, 200) || "" : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (REDACTED_SCHEMA_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (SENSITIVE_SCHEMA_KEY_RE.test(key)) {
      out[key] =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? sanitizeAssistanceInputSchema(entry, depth + 1)
          : "[REDACTED]";
      continue;
    }
    out[key] = sanitizeAssistanceInputSchema(entry, depth + 1);
  }
  return out;
}

function safeOpaqueAttachmentRef(value: unknown): string | null {
  const ref = safeAttachmentString(value, 200);
  if (!ref) {
    return null;
  }
  // Attachment refs are durable opaque handles. Raw http/ws URLs can carry
  // bearer authority and must stay behind the attachment provider.
  if (!SAFE_ATTACHMENT_REF_RE.test(ref)) {
    return null;
  }
  return ref;
}

function sanitizeAssistanceAttachments(attachments: unknown): Record<string, unknown>[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.map((attachment: Record<string, unknown>) => {
    const result: Record<string, unknown> = { kind: attachment.kind };
    const rawRole = safeAttachmentString(attachment.role, 80);
    const rawLabel = safeAttachmentString(attachment.label || attachment.title, 160);
    const role = rawRole ? sanitizeAssistanceTimelineString(rawRole, 80) : null;
    const label = rawLabel ? sanitizeAssistanceTimelineString(rawLabel, 160) : null;
    const ref = safeOpaqueAttachmentRef(attachment.ref || attachment.id || attachment.surface_id);
    const rawStatus = safeAttachmentString(attachment.status || attachment.availability, 80);
    const status = rawStatus ? sanitizeAssistanceTimelineString(rawStatus, 80) : null;
    if (role) {
      result.role = role;
    }
    if (label) {
      result.label = label;
    }
    if (ref) {
      result.ref = ref;
    }
    if (status) {
      result.status = status;
    }
    return result;
  });
}

function validateAssistanceAttachments(value: unknown): void {
  if (isNullish(value)) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error("Connector emitted invalid ASSISTANCE.attachments: expected array");
  }
  for (const attachment of value) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw new Error("Connector emitted invalid ASSISTANCE.attachments: expected object entries");
    }
    if (!ASSISTANCE_ATTACHMENT_KINDS.has(attachment.kind)) {
      throw new Error(`Connector emitted invalid ASSISTANCE.attachments.kind: ${attachment.kind}`);
    }
    requireOptionalNonEmptyString(attachment.role, "ASSISTANCE.attachments.role");
    requireOptionalNonEmptyString(attachment.status, "ASSISTANCE.attachments.status");
    requireOptionalNonEmptyString(attachment.availability, "ASSISTANCE.attachments.availability");
  }
}

function validateAssistanceMessage(msg: ConnectorMessage, scopeByStream: ScopeByStream): void {
  requireOptionalNonEmptyString(msg.assistance_request_id, "ASSISTANCE.assistance_request_id");
  requireOptionalNonEmptyString(msg.stream, "ASSISTANCE.stream");
  validateOptionalScopedStream(msg.stream, "ASSISTANCE", scopeByStream);
  if (!ASSISTANCE_PROGRESS_POSTURES.has(msg.progress_posture as string)) {
    throw new Error(`Connector emitted invalid ASSISTANCE.progress_posture: ${msg.progress_posture}`);
  }
  if (!ASSISTANCE_OWNER_ACTIONS.has(msg.owner_action as string)) {
    throw new Error(`Connector emitted invalid ASSISTANCE.owner_action: ${msg.owner_action}`);
  }
  if (!ASSISTANCE_RESPONSE_CONTRACTS.has(msg.response_contract as string)) {
    throw new Error(`Connector emitted invalid ASSISTANCE.response_contract: ${msg.response_contract}`);
  }
  if (msg.response_contract !== "none") {
    throw new Error(
      "Connector emitted unsupported ASSISTANCE.response_contract: response_required is not supported by the nonblocking ASSISTANCE path"
    );
  }
  if (typeof msg.message !== "string" || !msg.message.trim()) {
    throw new Error("Connector emitted invalid ASSISTANCE.message: expected non-empty string");
  }
  if (!(isNullish(msg.sensitivity) || ASSISTANCE_SENSITIVITIES.has(msg.sensitivity as string))) {
    throw new Error(`Connector emitted invalid ASSISTANCE.sensitivity: ${msg.sensitivity}`);
  }
  if (
    !isNullish(msg.timeout_seconds) &&
    (!Number.isFinite(msg.timeout_seconds) || (msg.timeout_seconds as number) <= 0)
  ) {
    throw new Error(`Connector emitted invalid ASSISTANCE.timeout_seconds: ${msg.timeout_seconds}`);
  }
  if (!isNullish(msg.input_schema) && (typeof msg.input_schema !== "object" || Array.isArray(msg.input_schema))) {
    throw new Error("Connector emitted invalid ASSISTANCE.input_schema: expected object");
  }
  validateAssistanceAttachments(msg.attachments);
}

function hasBrowserSurfaceLaunchEnv(env: Record<string, string> | null | undefined): boolean {
  return Boolean(
    env &&
      typeof env === "object" &&
      (optionalNonEmptyEnv(env.PDPP_BROWSER_SURFACE_STREAM_BASE_URL) ||
        optionalNonEmptyEnv(env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL))
  );
}

function buildAssistanceRequestedDataFromInteraction(
  msg: ConnectorMessage,
  runSource: { id: string; kind: string },
  options: { browserSurfaceAvailable?: boolean } = {}
): Record<string, unknown> {
  const isSecretValue = msg.kind === "credentials" || msg.kind === "otp";
  const hasBrowserSurface =
    msg.kind === "manual_action" || (msg.kind === "otp" && options.browserSurfaceAvailable === true);
  return {
    assistance_request_id: msg.request_id,
    kind: msg.kind,
    message: sanitizeAssistanceTimelineString(msg.message) || "Owner assistance requested.",
    owner_action: hasBrowserSurface ? "operate_attachment" : "provide_value",
    progress_posture: "blocked",
    response_contract: "response_required",
    sensitivity: isSecretValue ? "secret" : "non_secret",
    source: runSource,
    stream: msg.stream || null,
    ...(isNullish(msg.timeout_seconds) ? {} : { timeout_seconds: msg.timeout_seconds }),
    ...(isSecretValue && !isNullish(msg.schema) ? { input_schema: sanitizeAssistanceInputSchema(msg.schema) } : {}),
    ...(hasBrowserSurface ? { attachments: [{ kind: "browser_surface", role: "streaming_companion" }] } : {}),
  };
}

function validateAssistanceStatusMessage(msg: ConnectorMessage): void {
  if (typeof msg.assistance_request_id !== "string" || !msg.assistance_request_id.trim()) {
    throw new Error("Connector emitted invalid ASSISTANCE_STATUS.assistance_request_id: expected non-empty string");
  }
  if (!ASSISTANCE_TERMINAL_STATUSES.has(msg.status as string)) {
    throw new Error(`Connector emitted invalid ASSISTANCE_STATUS.status: ${msg.status}`);
  }
  requireOptionalNonEmptyString(msg.message, "ASSISTANCE_STATUS.message");
}

function buildAssistanceRequestedDataFromMessage(
  msg: ConnectorMessage,
  runSource: { id: string; kind: string }
): Record<string, unknown> {
  return {
    assistance_request_id: msg.assistance_request_id,
    message: sanitizeAssistanceTimelineString(msg.message) || "Owner assistance requested.",
    owner_action: msg.owner_action,
    progress_posture: msg.progress_posture,
    response_contract: msg.response_contract,
    sensitivity: msg.sensitivity || "none",
    source: runSource,
    stream: msg.stream || null,
    ...(isNullish(msg.timeout_seconds) ? {} : { timeout_seconds: msg.timeout_seconds }),
    ...(isNullish(msg.input_schema) ? {} : { input_schema: sanitizeAssistanceInputSchema(msg.input_schema) }),
    ...(isNullish(msg.attachments) ? {} : { attachments: sanitizeAssistanceAttachments(msg.attachments) }),
  };
}

function assistanceResolutionEventType(responseStatus: unknown): string | null {
  if (responseStatus === "success") {
    return "run.assistance_resolved";
  }
  if (responseStatus === "resolved") {
    return "run.assistance_resolved";
  }
  if (responseStatus === "cancelled") {
    return "run.assistance_cancelled";
  }
  if (responseStatus === "timeout") {
    return "run.assistance_timed_out";
  }
  if (responseStatus === "timed_out") {
    return "run.assistance_timed_out";
  }
  if (responseStatus === "escalated") {
    return "run.assistance_escalated";
  }
  return null;
}

/**
 * Run a connector to completion.
 *
 * @param {object} opts
 * @param {string} opts.connectorPath - Path to connector executable
 * @param {string} opts.connectorId - Connector ID (for ingest URL)
 * @param {string} opts.ownerToken - Owner bearer token
 * @param {object} opts.manifest - Full connector manifest
 * @param {object} [opts.scope] - Optional normalized Collection Profile START.scope
 * @param {object} opts.state - Current StreamState (null on first run)
 * @param {string} opts.collectionMode - 'full_refresh' | 'incremental'
 * @param {boolean} opts.persistState - Whether STATE checkpoints should be committed on success
 * @param {string} [opts.grantId] - Optional grant-scoped state namespace for continuous runs
 * @param {string} opts.rsUrl - Resource server base URL
 * @param {function} opts.onInteraction - async (interaction) => response
 * @param {function} opts.onInteractionTerminal - awaited terminal-interaction lifecycle barrier
 * @param {function} opts.onProgress - (msg) => void
 * @returns {Promise<{status, records_emitted, state, checkpoint_summary}>}
 */
// process.stderr write that swallows a single closed-pipe error per
// process. Used by the default progress logger so that a vanishing log
// consumer (Docker Compose log handoff, `node --watch` restart) cannot
// take down a fire-and-forget connector run with an uncaught EPIPE.
let _stderrPipeClosed = false;
function safeStderrWrite(line: string): void {
  if (_stderrPipeClosed) {
    return;
  }
  try {
    process.stderr.write(line);
  } catch (err) {
    if (isClosedPipeWriteError(err)) {
      _stderrPipeClosed = true;
      return;
    }
    throw err;
  }
}

function optionalNonEmptyEnv(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildBrowserSurfaceLaunchEnv({
  browserSurfaceLease,
  browserSurfaceEnv,
}: {
  browserSurfaceEnv?: RuntimeBrowserSurfaceEnv | null;
  browserSurfaceLease?: RuntimeBrowserSurfaceLease | null;
}): Record<string, string> {
  // `baseUrl` is read below but is not part of the declared lease shape, so
  // both sides are widened to an index-signature view for the lookups.
  const source: Record<string, unknown> =
    browserSurfaceLease && typeof browserSurfaceLease === "object"
      ? (browserSurfaceLease as unknown as Record<string, unknown>)
      : {};
  const explicit: Record<string, unknown> =
    browserSurfaceEnv && typeof browserSurfaceEnv === "object"
      ? (browserSurfaceEnv as unknown as Record<string, unknown>)
      : {};
  const leaseId =
    optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_LEASE_ID) ||
    optionalNonEmptyEnv(source.leaseId) ||
    optionalNonEmptyEnv(source.id);
  const profileKey =
    optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_PROFILE_KEY) || optionalNonEmptyEnv(source.profileKey);
  const surfaceId = optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_ID) || optionalNonEmptyEnv(source.surfaceId);
  const remoteCdpUrl =
    optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL) ||
    optionalNonEmptyEnv(source.remoteCdpUrl) ||
    optionalNonEmptyEnv(source.cdpUrl);
  const streamBaseUrl =
    optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_STREAM_BASE_URL) ||
    optionalNonEmptyEnv(source.streamBaseUrl) ||
    optionalNonEmptyEnv(source.baseUrl);
  const required =
    optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_REQUIRED) ||
    optionalNonEmptyEnv(source.required) ||
    optionalNonEmptyEnv(source.browserSurfaceRequired) ||
    (remoteCdpUrl ? "neko" : null);

  return {
    ...(required ? { PDPP_BROWSER_SURFACE_REQUIRED: required } : {}),
    ...(leaseId ? { PDPP_BROWSER_SURFACE_LEASE_ID: leaseId } : {}),
    ...(profileKey ? { PDPP_BROWSER_SURFACE_PROFILE_KEY: profileKey } : {}),
    ...(surfaceId ? { PDPP_BROWSER_SURFACE_ID: surfaceId } : {}),
    ...(remoteCdpUrl ? { PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: remoteCdpUrl } : {}),
    ...(streamBaseUrl ? { PDPP_BROWSER_SURFACE_STREAM_BASE_URL: streamBaseUrl } : {}),
  };
}

function validateRequiredRuntimeBindings(
  requiredBindings: Record<string, { required?: boolean }>,
  availableBindings: AvailableBindings
): void {
  for (const [binding, req] of Object.entries(requiredBindings)) {
    if (req.required && !(binding in availableBindings)) {
      throw new Error(`Runtime cannot satisfy required binding: ${binding}`);
    }
  }
}

function requestedRuntimeStreams(scope: { streams?: unknown } | null): Set<string> | null {
  if (!Array.isArray(scope?.streams)) {
    return null;
  }
  return new Set(
    scope.streams
      .map((streamScope: StreamScope | null | undefined) => streamScope?.name)
      .filter((name: unknown): name is string => typeof name === "string")
  );
}

function validateRecoveryOnly(value: unknown): boolean {
  if (value !== false && value !== true) {
    throw new Error("opts.recoveryOnly must be a boolean");
  }
  return value === true;
}

function buildManifestStateStreamMap(manifest: ConnectorManifest): Map<string, string> {
  const stateStreams = new Map<string, string>();
  for (const stream of manifest.streams || []) {
    if (
      stream &&
      typeof stream.state_stream === "string" &&
      stream.state_stream &&
      stream.state_stream !== stream.name
    ) {
      stateStreams.set(stream.name, stream.state_stream);
    }
  }
  return stateStreams;
}

function buildManifestDetailParentStreamsMap(manifest: ConnectorManifest): Map<string, Set<string>> {
  const parentsByStream = new Map<string, Set<string>>();
  for (const stream of manifest.streams || []) {
    if (!(stream && Array.isArray(stream.parent_streams))) {
      continue;
    }
    if (stream.parent_streams.length) {
      // Keep the complete declared set. Its cardinality is an authority fact:
      // scoping a two-parent run to one parent must not make a legacy,
      // parentless gap appear unambiguous.
      parentsByStream.set(stream.name, new Set(stream.parent_streams));
    }
  }
  return parentsByStream;
}

function openRuntimeTraceFile(traceDir: string | undefined, connectorId: string, runId: string): string | null {
  if (!traceDir) {
    return null;
  }
  try {
    mkdirSync(traceDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeId = String(connectorId || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
    const traceFile = `${traceDir}/${timestamp}_${safeId}_${runId}.jsonl`;
    appendFileSync(
      traceFile,
      `# pdpp-runtime-trace connector=${connectorId} run=${runId} started=${new Date().toISOString()}\n`
    );
    return traceFile;
  } catch (err) {
    safeStderrWrite(`[runtime] trace open failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

async function ensureRuntimeBootEpoch(): Promise<NonNullable<ReturnType<typeof getCurrentBootEpoch>>> {
  return getCurrentBootEpoch() || (await emitControllerBootedAndStashEpoch());
}

function buildConnectorLaunchConfig({
  automationMode,
  browserSurfaceEnv,
  browserSurfaceLease,
  connectorInstanceId,
  connectorPath,
  referenceBaseUrl,
  runId,
  staticSecretEnv,
  streamingRegistrationToken,
  triggerKind,
}: Pick<
  RuntimeRunConnectorOptions,
  | "automationMode"
  | "browserSurfaceEnv"
  | "browserSurfaceLease"
  | "connectorInstanceId"
  | "connectorPath"
  | "referenceBaseUrl"
  | "runId"
  | "staticSecretEnv"
  | "streamingRegistrationToken"
  | "triggerKind"
> & { runId: string }): {
  args: string[];
  browserSurfaceLaunchEnv: Record<string, string>;
  connectorInstanceEnv: Record<string, string>;
  normalizedConnectorInstanceId: string | null;
  runAutomationEnv: Record<string, string>;
  staticSecretLaunchEnv: Record<string, string>;
  streamingRegistrationEnv: Record<string, string>;
} {
  const normalizedConnectorInstanceId = optionalNonEmptyEnv(connectorInstanceId);
  const browserSurfaceLaunchEnv = buildBrowserSurfaceLaunchEnv({
    browserSurfaceEnv: browserSurfaceEnv ?? null,
    browserSurfaceLease: browserSurfaceLease ?? null,
  });
  const staticSecretLaunchEnv = staticSecretEnv && typeof staticSecretEnv === "object" ? staticSecretEnv : {};
  const connectorInstanceEnv = normalizedConnectorInstanceId
    ? { PDPP_CONNECTOR_INSTANCE_ID: normalizedConnectorInstanceId }
    : {};
  const streamingRegistrationEnv =
    streamingRegistrationToken && referenceBaseUrl
      ? {
          PDPP_REFERENCE_BASE_URL: referenceBaseUrl,
          PDPP_RUN_ID: runId,
          PDPP_STREAMING_REGISTRATION_TOKEN: streamingRegistrationToken,
        }
      : {};
  const runAutomationEnv = {
    ...(triggerKind ? { PDPP_RUN_TRIGGER_KIND: triggerKind } : {}),
    ...(automationMode ? { PDPP_RUN_AUTOMATION_MODE: automationMode } : {}),
  };
  const args = connectorPath.endsWith(".ts") ? ["--import", "tsx/esm", connectorPath] : [connectorPath];
  return {
    args,
    browserSurfaceLaunchEnv,
    connectorInstanceEnv,
    normalizedConnectorInstanceId,
    runAutomationEnv,
    staticSecretLaunchEnv,
    streamingRegistrationEnv,
  };
}

function reportRuntimeStart(
  writeStart: () => boolean,
  onProgress: (message: unknown) => void,
  childStdinClosedReason: string | null,
  admission: unknown
): void {
  if (!writeStart()) {
    onProgress({ phase: "start", reason: childStdinClosedReason, type: "connector_stdin_closed" });
  }
  if (admission) {
    onProgress({ admission, reference_only: true, type: "DETAIL_GAPS_START_ADMISSION" });
  }
}

export async function runConnector(opts: RuntimeRunConnectorOptions): Promise<RuntimeRunConnectorResult> {
  const defaultOnProgress =
    process.env.PDPP_RUNTIME_QUIET === "1"
      ? () => {
          // Quiet mode intentionally discards progress messages.
        }
      : (msg: unknown) => safeStderrWrite(`[runtime] ${JSON.stringify(msg)}\n`);
  const {
    admitRunConnection,
    approvedEnvironmentBindings,
    approvedProxyConnectorIds,
    connectorPath,
    connectorId: rawConnectorId,
    connectorInstanceId = null,
    ownerSubjectId = null,
    ownerToken,
    manifest,
    scope: providedScope = null,
    state = null,
    collectionMode = "incremental",
    persistState = true,
    grantId = null,
    rsUrl = process.env.RS_URL || "http://localhost:7663",
    onInteraction = defaultInteractionHandler,
    onInteractionTerminal = null,
    onProgress = defaultOnProgress,
    onStarted = null,
    // Mode-A streaming registration: per-run shared secret the parent
    // mints and stores in the run-target registry's nonce store. The
    // child sends it as a Bearer credential to register/unregister its
    // CDP page-target wsUrl. Both fields are required for the child to
    // attempt registration; either omitted means the child silently
    // skips streaming registration. The reference server's base URL is
    // forwarded as PDPP_REFERENCE_BASE_URL so the child knows where to
    // POST. See:
    //   reference-implementation/server/streaming/run-target-registry.js
    //   packages/polyfill-connectors/src/streaming-target-registration.ts
    streamingRegistrationToken = null,
    referenceBaseUrl = null,
    browserSurfaceLease = null,
    browserSurfaceEnv = null,
    // The controller resolves this connection-scoped fragment from credentials,
    // provider authorization, or manual-upload/local-path state. The child
    // receives only reviewed platform values, current-manifest declarations,
    // this fragment, and explicit run controls. Configured reference-server
    // static-secret runs fail closed before spawn when their fragment is absent;
    // direct standalone connector execution may still rely on process env.
    // See add-static-secret-owner-connect-primitive design Decision 5.
    staticSecretEnv = null,
    triggerKind = null,
    automationMode = null,
    // Optional owner-cancel signal. The controller passes one AbortSignal per
    // run; aborting it requests cooperative cancellation of THIS run only. The
    // runtime records a non-terminal `run.cancel_requested` event and
    // terminates the connector child via the existing graceful-then-SIGKILL
    // escalation. A run that already recorded a terminal event ignores abort.
    // See openspec/changes/add-owner-run-cancellation-control.
    cancelSignal = null,
    // SLVP-ideal §4.3: when true, the connector drains pending non-source-pressure
    // detail gaps then returns before any forward walk / list-phase fetches.
    // Threaded from the scheduler's recoveryOnly decision into the START message.
    recoveryOnly = false,
    // Bounded ingest-retry policy plus its clock/jitter seams. See
    // runtime/ingest-retry.ts for why the runtime retries a 503 at all.
    ingestRetryPolicy = DEFAULT_INGEST_RETRY_POLICY,
    ingestRetrySleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ingestRetryRandom = Math.random,
  } = opts;
  const connectorId = canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
  const claimedConnectorInstanceId = resolveRuntimeConnectorInstanceId({
    connectorId,
    connectorInstanceId,
    manifest,
  });
  const admittedConnection = await admitRuntimeRunConnection(admitRunConnection, {
    connectorId,
    connectorInstanceId: claimedConnectorInstanceId,
    ownerSubjectId,
  });
  const resolvedConnectorInstanceId = admittedConnection.connectorInstanceId;

  // Check binding requirements
  const requiredBindings = manifest.runtime_requirements?.bindings || {};
  const availableBindings = buildAvailableBindings(onInteraction);

  validateRequiredRuntimeBindings(requiredBindings, availableBindings);

  const explicitlyRequestedStreams = requestedRuntimeStreams(providedScope);
  const declaredCollectionScope = readStoredCollectionScope(state).scope;
  const startScope = buildStartScope(manifest, providedScope, declaredCollectionScope?.since ?? null);
  const startCollectionMode = validateCollectionMode(collectionMode);
  const startState = persistState ? validateStartState(state) : null;
  // §4.3: validate and normalize recoveryOnly — must be a boolean if provided
  const startRecoveryOnly = validateRecoveryOnly(recoveryOnly);
  const scopeByStream = new Map(startScope.streams.map((streamScope) => [streamScope.name, streamScope]));
  const manifestByStream = new Map((manifest.streams || []).map((stream) => [stream.name, stream]));
  // Manifest-declared checkpoint parent: a co-emitted stream (e.g. Slack
  // reactions / message_attachments, Gmail message_bodies) rides the parent
  // list stream's cursor and is committed by the parent's STATE, not its own.
  // It emits no DETAIL_COVERAGE (it is not a list+detail hydration lane), so the
  // fact-block's stream->state_stream mapping cannot be learned from coverage
  // messages the way a hydration lane's is. The manifest declares it via
  // `state_stream`, and the terminal collection-fact block reads it so the
  // co-emitted stream's `checkpoint` reflects the parent's committed cursor
  // instead of a spurious `not_staged`.
  const manifestStateStreamByStream = buildManifestStateStreamMap(manifest);
  const manifestDetailParentStreamsByStream = buildManifestDetailParentStreamsMap(manifest);
  // `getDefaultConnectorDetailGapStore()` is declared `unknown` at its own
  // module boundary (that store has not been migrated yet), so the runtime
  // states the surface it actually drives here.
  const detailGapStore: RuntimeDetailGapStore = {
    markGapStatus: unsupportedDetailGapStoreCapability("gap status transitions"),
    markLeasedGapAttempt: unsupportedDetailGapStoreCapability("leased gap attempts"),
    settleLeasedGapPending: unsupportedDetailGapStoreCapability("pending lease settlement"),
    settleLeasedGapRecovered: unsupportedDetailGapStoreCapability("recovered lease settlement"),
    upsertPendingGap: unsupportedDetailGapStoreCapability("pending gap upserts"),
    ...(opts.detailGapStore || (getDefaultConnectorDetailGapStore() as RuntimeDetailGapStoreCapabilities)),
  };

  // Compute runId before spawn so it can be threaded into the child env
  // alongside the streaming registration token. The traceContext is
  // computed below alongside the rest of the run-scoped state.
  const spawnRunId = opts.runId || `run_${Date.now()}`;

  const launchConfig = buildConnectorLaunchConfig({
    automationMode,
    browserSurfaceEnv,
    browserSurfaceLease,
    connectorInstanceId: resolvedConnectorInstanceId,
    connectorPath,
    referenceBaseUrl,
    runId: spawnRunId,
    staticSecretEnv,
    streamingRegistrationToken,
    triggerKind,
  });
  const {
    args,
    browserSurfaceLaunchEnv,
    connectorInstanceEnv,
    normalizedConnectorInstanceId,
    runAutomationEnv,
    staticSecretLaunchEnv,
    streamingRegistrationEnv,
  } = launchConfig;

  // `detached: true` puts the connector child into its OWN process group
  // (POSIX setsid), with the child's PID as the group leader. This is the
  // load-bearing half of the run-lifecycle lease invariant: a descendant
  // the connector spawns (a Playwright/Chromium helper, a shelled-out tool)
  // inherits this process group, so terminating the GROUP (see
  // `terminateConnectorChildGroup` below) reaps the connector AND its whole
  // subtree as one unit. Without it, `proc.kill()` signals only the direct
  // child PID; grandchildren reparent to PID 1 and orphan — the failure mode
  // captured by run_1780436796334 / run_1780436796294 (started-only runs whose
  // GitHub/YNAB children outlived the run under PID 1).
  //
  // We keep `stdio: ['pipe','pipe','pipe']` and do NOT `proc.unref()`: the
  // parent stays attached to the child's stdio and awaits its close, exactly
  // as before. `detached` here only changes the process-GROUP topology, not
  // ownership of the handle. This is a Linux/Docker runtime (no Windows
  // support anywhere in the tree), so the POSIX process-group semantics hold.
  const proc = spawn(process.execPath, args, {
    detached: true,
    env: composeConnectorChildEnvironment({
      ...(approvedEnvironmentBindings ? { approvedBindings: approvedEnvironmentBindings } : {}),
      approvedProxyConnectorIds: approvedProxyConnectorIds ?? [],
      connectionEnv: {
        allowedKeys: Object.keys(staticSecretLaunchEnv),
        connectorId,
        kind: "connection",
        values: staticSecretLaunchEnv,
      } satisfies ConnectorConnectionEnvironment,
      connectorId,
      explicitRunEnv: {
        PDPP_CONNECTOR_ID: connectorId,
        ...connectorInstanceEnv,
        PDPP_OWNER_TOKEN: ownerToken,
        PDPP_RS_URL: rsUrl,
        ...streamingRegistrationEnv,
        ...browserSurfaceLaunchEnv,
        ...runAutomationEnv,
      },
      manifest,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Register terminal observation immediately after spawn, before any of the
  // asynchronous pre-START work below. A fast connector can consume START,
  // emit DONE, and exit before runConnector reaches its terminal handlers;
  // listening only at the end of setup loses Node's one-shot `close` event and
  // leaves the run pending forever. Buffer the first terminal event now and
  // process it once the run-scoped state machine is ready.
  type ConnectorChildTerminalEvent =
    | { readonly code: number | null; readonly kind: "close" }
    | { readonly error: Error; readonly kind: "error" };
  const childTerminalEvent = new Promise<ConnectorChildTerminalEvent>((resolve) => {
    let observed = false;
    const observe = (event: ConnectorChildTerminalEvent) => {
      if (observed) {
        return;
      }
      observed = true;
      resolve(event);
    };
    proc.once("error", (error) => observe({ error, kind: "error" }));
    proc.once("close", (code) => observe({ code, kind: "close" }));
  });

  // Group-aware termination. Because the child leads its own process group
  // (see `detached: true` above), signalling the NEGATIVE pid delivers to
  // every process in that group — the connector and any descendants it
  // spawned. We fall back to a direct single-PID `proc.kill(signal)` if the
  // group signal fails (e.g. the leader already exited so the group is gone,
  // surfacing as ESRCH), which preserves the prior best-effort behaviour.
  // Guarded on a real, post-spawn pid (> 1) so we can never accidentally
  // signal our own group (pid 0) or init.
  const terminateConnectorChildGroup = (signal: NodeJS.Signals) => {
    const { pid } = proc;
    if (typeof pid === "number" && pid > 1) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Group gone or un-signalable; fall through to the direct kill.
      }
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }
    try {
      proc.kill(signal);
    } catch {
      // Best-effort termination: the child may already have exited.
    }
  };

  // Track this child's process group for the parent-exit sweep (see the
  // `ownedConnectorChildPids` registry near the top of this module). The PID
  // is the group leader because the child was spawned `detached`. It is
  // removed again in `cleanupChildHandles` on every terminal path.
  registerOwnedConnectorChild(proc.pid);

  // Closed-pipe defenses on the connector child stdio we own. Without
  // these, an EPIPE on `proc.stdin.write(...)` (child exited early) or on
  // a stdout/stderr write the child performs surfaces as an unhandled
  // 'error' event on the parent, which becomes an uncaughtException and
  // crashes the AS/RS process — the failure mode captured in
  // openspec/changes/harden-reference-runtime-reliability/
  //     design-notes/reference-docker-epipe-crash-2026-04-26.md.
  // Closed-pipe errors are downgraded to operational state on the run;
  // any other stream error is re-thrown to surface real bugs.
  let childStdinClosed = false;
  // Reason recorded when a stdin write to the connector child is rejected
  // because the far side has closed. Surfaced as terminal_reason on the
  // run outcome so a Docker/--watch crash mode is observably distinct
  // from a connector that exited cleanly without DONE. Only set when no
  // protocol-level terminal record (DONE or violation) has already
  // claimed the run. See:
  //   openspec/changes/harden-reference-runtime-reliability/
  //     specs/reference-implementation-architecture/spec.md
  let childStdinClosedReason: string | null = null;
  let childStdinClosedAtPhase: string | null = null; // 'start' | 'interaction_response'
  proc.stdin.on("error", (err) => {
    if (isClosedPipeWriteError(err)) {
      childStdinClosed = true;
      if (!childStdinClosedReason) {
        childStdinClosedReason = "connector_stdin_closed";
        childStdinClosedAtPhase = "unknown";
      }
      return;
    }
    throw err;
  });
  proc.stdout.on("error", (err) => {
    if (isClosedPipeWriteError(err)) {
      return;
    }
    throw err;
  });
  proc.stderr.on("error", (err) => {
    if (isClosedPipeWriteError(err)) {
      return;
    }
    throw err;
  });

  // Wrapped stdin writer: avoids synchronous throws when the child has
  // already detached its stdin reader. Returns true if the bytes were
  // accepted, false if stdin is no longer writable. On a non-writable
  // stdin we record `connector_stdin_closed` and the write phase so the
  // close handler can surface a typed terminal_reason instead of falling
  // back to the generic `connector_exit_without_done` outcome.
  function writeChildStdin(payload: string, phase: string): boolean {
    if (childStdinClosed || !proc.stdin.writable) {
      childStdinClosed = true;
      if (!childStdinClosedReason) {
        childStdinClosedReason = "connector_stdin_closed";
        childStdinClosedAtPhase = phase || "unknown";
      }
      return false;
    }
    try {
      proc.stdin.write(payload);
      return true;
    } catch (err) {
      if (isClosedPipeWriteError(err)) {
        childStdinClosed = true;
        if (!childStdinClosedReason) {
          childStdinClosedReason = "connector_stdin_closed";
          childStdinClosedAtPhase = phase || "unknown";
        }
        return false;
      }
      throw err;
    }
  }

  // `scenarioId` is spread in only when present: under
  // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
  // omitted optional property, and `createTraceContext` defaults on absence.
  const traceContext = opts.traceContext || createTraceContext(opts.scenarioId ? { scenarioId: opts.scenarioId } : {});
  const runId = spawnRunId;
  const runSource = buildRunSourceDescriptor(connectorId);
  const runConnectionIdentity = buildRunConnectionIdentity(normalizedConnectorInstanceId);

  // We do NOT use readline.createInterface here. Node 24+ readline treats
  // U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) as line
  // terminators (per ECMA-262), but JSON.stringify emits those characters
  // unescaped (per RFC 8259), so a compliant JSON line containing either
  // character causes readline to split it mid-string and JSON.parse fails.
  //
  // Instead, we consume proc.stdout directly and split ONLY on ASCII \n
  // (0x0A). We defensively also strip a trailing \r for CRLF safety. This
  // guarantees correctness even if a connector doesn't itself escape the
  // separator characters.
  //
  // See openspec/changes/add-polyfill-connector-system/design-notes/
  //     gmail-jsonl-truncation-bug.md
  // Bounded UTF-8 stderr tail. The runtime previously accumulated every
  // chunk for the lifetime of the run (memory grew with stderr volume) and
  // then discarded the result before the terminal `run.failed` event was
  // persisted. The tail buffer keeps only the last N bytes the connector
  // wrote and tracks `bytes_observed` so the owner can tell whether
  // evidence was truncated. See
  // openspec/changes/persist-connector-failure-diagnostics.
  const stderrTail = createStderrTailBuffer();
  proc.stderr.on("data", (d) => stderrTail.append(d));

  // Byte-level buffer; split only on LF. Each chunk from proc.stdout is a
  // Buffer (no encoding set) so multi-byte UTF-8 characters are preserved
  // across chunk boundaries — we decode only at line boundaries.
  proc.stdout.setEncoding("utf8");
  let _lineBuffer = "";
  // Fake readline-compatible shim so the rest of this file can still call
  // `rl.on('line', ...)` — which we do below, without touching readline APIs.
  const lineListeners: Array<(line: string) => void> = [];
  const rl = {
    close() {
      /* noop — stdout closes when the child exits */
    },
    on(event: string, handler: (line: string) => void) {
      if (event === "line") {
        lineListeners.push(handler);
      }
    },
  };
  const emitLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    for (const h of lineListeners) {
      h(line);
    }
  };
  proc.stdout.on("data", (chunk: string) => {
    _lineBuffer += chunk;
    let nlIdx: number;
    nlIdx = _lineBuffer.indexOf("\n");
    while (nlIdx !== -1) {
      const line = _lineBuffer.slice(0, nlIdx);
      _lineBuffer = _lineBuffer.slice(nlIdx + 1);
      emitLine(line);
      nlIdx = _lineBuffer.indexOf("\n");
    }
  });
  proc.stdout.on("end", () => {
    if (_lineBuffer.length > 0) {
      emitLine(_lineBuffer);
      _lineBuffer = "";
    }
  });

  // Debug trace: if PDPP_TRACE_DIR is set, record every line received from the
  // connector before parsing. On a crash, the file is inspectable with jq/less
  // and shows exactly what the connector emitted. See
  // openspec/changes/add-polyfill-connector-system/design-notes/debugging-leverage-open-question.md
  const _traceAppendFile = openRuntimeTraceFile(process.env.PDPP_TRACE_DIR, connectorId, runId);
  const writeTrace = (line: string) => {
    if (!_traceAppendFile) {
      return;
    }
    try {
      appendFileSync(_traceAppendFile, `${line}\n`);
    } catch {
      // Tracing is best-effort and must never affect runtime protocol handling.
    }
  };

  // Tracks each run-owned detail-gap lease. A lease is distinct from a provider
  // attempt: connectors explicitly mark attempts/outcomes, and cleanup CASes
  // only the lease it owns.
  const allServedGapLeases = new Map<string, ServedGapLease>();

  // The page reader declares these two as plain strings but forwards them
  // straight through to the store, which has always accepted the null the
  // runtime passes when a run is not connection- or grant-scoped.
  const readDetailGapPage = createDetailGapPageReader({
    allServedGapLeases,
    connectorId,
    connectorInstanceId: normalizedConnectorInstanceId as string,
    // The paging module declares its own structural `DetailGapStore` covering
    // the three methods it calls; this store satisfies all of them.
    detailGapStore: detailGapStore as unknown as Parameters<typeof createDetailGapPageReader>[0]["detailGapStore"],
    grantId: grantId as string,
    runId,
  });

  let startDetailGaps: unknown[] = [];
  let startDetailGapAdmission: unknown = null;
  try {
    // Reclaim only expired leases from crashed/killed runs; a different live
    // run id is never evidence that this run may steal a lease.
    if (typeof detailGapStore.reclaimStrandedInProgressGaps === "function") {
      await detailGapStore.reclaimStrandedInProgressGaps({
        connectorId,
        connectorInstanceId: normalizedConnectorInstanceId,
        currentRunId: spawnRunId,
        grantId,
      });
    }
    const page = await readDetailGapPage({
      streams: startScope.streams.map((stream) => stream.name),
    });
    startDetailGaps = page.detailGaps;
    startDetailGapAdmission = page.admission;
  } catch (err) {
    // Pre-START failure (before the run promise / cleanupChildHandles exists):
    // reap the just-spawned connector group rather than leaking it, and drop
    // it from the parent-exit registry so a later exit can't re-signal a group
    // we already terminated.
    terminateConnectorChildGroup("SIGTERM");
    unregisterOwnedConnectorChild(proc.pid);
    throw err;
  }

  // Send START
  const startMsg = {
    bindings: availableBindings,
    collection_mode: startCollectionMode,
    detail_gaps: startDetailGaps,
    run_id: runId,
    scope: startScope,
    state: startState,
    type: "START",
    // §4.3 (SLVP-ideal): forward recovery-only mode so the connector suppresses
    // the forward walk / list-phase fetches while the source-pressure cooldown
    // is active. Only included when true to keep the wire format backward-compat.
    ...(startRecoveryOnly ? { recovery_only: true } : {}),
  };
  reportRuntimeStart(
    () => writeChildStdin(`${JSON.stringify(startMsg)}\n`, "start"),
    onProgress,
    childStdinClosedReason,
    startDetailGapAdmission
  );

  // Last spine event the runtime successfully persisted for this run.
  // Used by ProtocolViolation.toPublicShape() to give the dashboard an
  // anchor: "the violation happened immediately after this event."
  // Declared before the first emitSpineEventTracked call to avoid TDZ.
  let lastValidSpineEvent: LastValidSpineEvent | null = null;
  function addRunConnectionIdentity(input: SpineEventInput): SpineEventInput {
    if (!(input.event_type?.startsWith?.("run.") && normalizedConnectorInstanceId)) {
      return input;
    }
    const data = input.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : {};
    return {
      ...input,
      data: {
        ...data,
        ...runConnectionIdentity,
      },
    };
  }

  async function emitRunSpineEvent(input: SpineEventInput): Promise<SpineEventRecord | null> {
    await Promise.resolve();
    return emitSpineEvent(addRunConnectionIdentity(input));
  }

  async function emitSpineEventTracked(input: SpineEventInput): Promise<SpineEventRecord | null> {
    const record = await emitRunSpineEvent(input);
    if (record?.event_id) {
      lastValidSpineEvent = { event_id: record.event_id, event_type: record.event_type };
    }
    return record;
  }

  let assistanceCounter = 0;
  const openStructuredAssistance = new Map<string, OpenAssistance>();
  const assistanceTimeoutHandles = new Map<string, NodeJS.Timeout>();
  const nextAssistanceRequestId = () => {
    assistanceCounter += 1;
    return `asst_${Date.now()}_${assistanceCounter}`;
  };

  // Durable structured-attention writer. Closes the production-writer
  // gap from openspec/changes/complete-ri-operator-console-reliability
  // task 5.3 — every owner-action prompt now upserts a row in
  // `connector_attention_records` so the connection-health projection
  // sees `next_action.source === "structured"` instead of having to fall
  // back to the schedule's coarse `human_attention_needed` flag. Store
  // outage is non-fatal (the writer logs and continues), which preserves
  // the design rule that the operator-console sidecar never blocks data
  // collection.
  const attentionStore = opts.connectorAttentionStore || getDefaultConnectorAttentionStore();
  const attentionWriter = createAttentionWriter({
    connectorId,
    connectorInstanceId: normalizedConnectorInstanceId,
    log: console,
    runId,
    store: attentionStore,
  });

  function clearAssistanceTimeout(assistanceRequestId: string): void {
    const timeoutHandle = assistanceTimeoutHandles.get(assistanceRequestId);
    if (!timeoutHandle) {
      return;
    }
    clearTimeout(timeoutHandle);
    assistanceTimeoutHandles.delete(assistanceRequestId);
  }

  async function closeStructuredAssistance(
    assistanceRequestId: string,
    status: string,
    extra: { message?: unknown; reason?: unknown } = {}
  ): Promise<boolean> {
    const activeAssistance = openStructuredAssistance.get(assistanceRequestId);
    if (!activeAssistance) {
      return false;
    }
    openStructuredAssistance.delete(assistanceRequestId);
    clearAssistanceTimeout(assistanceRequestId);
    // Mirror the in-memory close into the durable attention store so the
    // dashboard projection stops driving `needs_attention` for this
    // prompt. Failure is logged inside the writer; the run terminal path
    // must keep moving even if the sidecar store is unhappy.
    await attentionWriter.resolveByRequestId(assistanceRequestId, status);
    const eventType = assistanceResolutionEventType(status);
    if (!eventType) {
      throw new Error(`Invalid assistance terminal status: ${status}`);
    }
    await emitSpineEventTracked({
      actor_id: connectorId,
      actor_type: "runtime",
      data: {
        assistance_request_id: assistanceRequestId,
        owner_action: activeAssistance.owner_action,
        progress_posture: activeAssistance.progress_posture,
        response_contract: activeAssistance.response_contract,
        source: runSource,
        status,
        stream: activeAssistance.stream || null,
        ...(activeAssistance.kind ? { kind: activeAssistance.kind } : {}),
        ...(extra.message ? { message: sanitizeAssistanceTimelineString(extra.message) || "[REDACTED]" } : {}),
        ...(extra.reason ? { reason: sanitizeAssistanceTimelineString(extra.reason) || "[REDACTED]" } : {}),
      },
      event_type: eventType,
      object_id: runId,
      object_type: "run",
      run_id: runId,
      scenario_id: traceContext.scenario_id,
      status,
      stream_id: activeAssistance.stream || null,
      trace_id: traceContext.trace_id,
    });
    return true;
  }

  async function closeOpenStructuredAssistance(
    status: string,
    extra: { message?: unknown; reason?: unknown } = {}
  ): Promise<void> {
    const closeNext = async (index: number): Promise<void> => {
      const assistanceRequestId = [...openStructuredAssistance.keys()][index];
      if (assistanceRequestId === undefined) {
        return;
      }
      await closeStructuredAssistance(assistanceRequestId, status, extra);
      await closeNext(index + 1);
    };
    await closeNext(0);
    // Drain any durable attention rows the writer still has tracked.
    // `closeStructuredAssistance` above handles the structured-ASSISTANCE
    // request_ids; this catches any interaction-side rows still open
    // when the run unwinds (timeout, crash, force-cancel, stdin closed).
    await attentionWriter.resolveAllOpen(status);
  }

  // Stamp `run.started` with the current process's boot epoch so the
  // boot-time orphan reconciler can identify abandoned runs from prior
  // incarnations. The spine-layer enforcement
  // (`assertRunStartedIsStamped` in lib/spine.ts) rejects emissions
  // lacking these fields with a loud error. Normally `startServer`
  // initializes the singleton via Stage 5; if `runConnector` is invoked
  // standalone (in a test fixture, a CLI tool, etc.) we lazily emit
  // `controller.booted` here so the runtime is always self-sufficient.
  // See docs/run-reconciliation-design-brief.md §3.3 / §3.4.
  const _bootEpoch = await ensureRuntimeBootEpoch();
  await emitSpineEventTracked({
    actor_id: connectorId,
    actor_type: "runtime",
    data: {
      collection_mode: startCollectionMode,
      grant_id: grantId,
      persist_state: persistState,
      source: runSource,
      state_commit_intent: persistState ? "commit_on_success" : "do_not_persist",
      ...(triggerKind ? { trigger_kind: triggerKind } : {}),
      ...(automationMode ? { automation_mode: automationMode } : {}),
      bindings: availableBindings,
      boot_epoch: _bootEpoch.boot_epoch,
      controller_id: _bootEpoch.controller_id,
      scope: startScope,
      scope_streams: startScope.streams.map((stream) => stream.name),
      seq: _bootEpoch.seq,
    },
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    scenario_id: traceContext.scenario_id,
    status: "started",
    trace_id: traceContext.trace_id,
  });
  onStarted?.({ run_id: runId, scenario_id: traceContext.scenario_id, trace_id: traceContext.trace_id });

  // Collect new STATE checkpoints
  const newState: Record<string, unknown> = {};
  const committedStateStreams = new Set<string>();
  let totalEmitted = 0;
  // Per-stream emitted counter. `totalEmitted` is the aggregate the DONE
  // records_emitted guard checks; this Map carries the same accounting keyed by
  // data `stream` so the terminal collection-fact block can state per-stream
  // `collected` without re-deriving it. Every in-scope stream is seeded to 0 so
  // a stream that emitted nothing still appears as an honest `collected: 0`
  // (absence of records is a fact, not a missing entry).
  const emittedByStream = new Map<string, number>(startScope.streams.map((streamScope) => [streamScope.name, 0]));
  let recordsAttempted = 0;
  let recordsAccepted = 0;
  let recordsPermanentlyRejected = 0;
  let finalStatus: RuntimeRunConnectorResult["status"] = "failed";
  let pendingInteraction: ConnectorMessage | null = null;
  let terminalEventRecorded = false;
  let doneMessage: DoneMessageState | null = null;
  // Cancellation intent for this run. Owner cancellation records
  // `run.cancel_requested` and terminals as `run.cancelled`; scheduler timeout
  // records `run.failed` with `run_timed_out`. `ownerCancelForced` flips to true
  // if the connector child ignored graceful termination and had to be SIGKILL'd.
  let ownerCancelRequested = false;
  let runTimedOut = false;
  let ownerCancelForced = false;
  const terminalStopRequested = (): boolean => ownerCancelRequested || runTimedOut;
  const knownGaps: Record<string, unknown>[] = [];
  // Streams whose batch ingest was rejected as not_found for a stream the runtime
  // already validated present in the manifest at START (transient manifest drift
  // between the runtime's START read and the RS's ingest read). Such streams are
  // skipped as a transient per-stream gap: their cursor is NOT staged/committed so
  // the next run re-collects them once the RS manifest row re-heals. See OpenSpec
  // change harden-ingest-against-transient-manifest-drift.
  const driftSkippedStreams = new Set<string>();
  // Streams that reported their own terminal failure via
  // SKIP_RESULT{reason:"stream_collection_failed", stream}. Populated only
  // when `stream` is present (in-scope, proven by validateSkipResultMessage)
  // — an untargeted SKIP_RESULT never certifies any specific stream as
  // failed. Read by handleDoneClose: a failed DONE is trusted as a
  // stream-scoped (rather than whole-run) failure only when this set is
  // non-empty, and only the streams named here are excluded from commit.
  const streamCollectionFailedStreams = new Set<string>();
  const durableDetailGaps: DurableDetailGap[] = [];
  // First-sighting idempotency for run.detail_gap_recorded: gap_ids already
  // emitted as `recorded` THIS run. Closes the resumed-run-stdout-replay edge
  // where a brand-new gap's DETAIL_GAP message could be re-processed and emit a
  // duplicate first-sighting event. In-memory per-run guard (same pattern as the
  // attention-writer's open/byRequestId Maps) — no schema change on the hot spine
  // append path. The cross-run re-defer suppression is the discovered_run_id gate.
  const detailGapRecordedThisRun = new Set<string>();
  const detailCoverageByStateStream = new Map<string, DetailCoverageEntry[]>();
  // Latest `collection_rate` progress payload seen this run. Updated on each
  // rate-change PROGRESS event so the terminal event can carry the final
  // learned state for post-run diagnostics (reference → snapshot derivation).
  let lastSeenCollectionRate: unknown = null;

  // Batch records for ingest
  const recordBatch: Record<string, BufferedRecord[]> = {};
  const BATCH_SIZE = Number(process.env.PDPP_RUNTIME_BATCH_SIZE) || 500;

  function countBufferedRecords(): number {
    return Object.values(recordBatch).reduce((sum, batch) => sum + (batch?.length || 0), 0);
  }

  function recordsUnresolvedRetryable(): number {
    return Math.max(0, recordsAttempted - recordsAccepted - recordsPermanentlyRejected);
  }

  function buildIngestAccountingFields(): Record<string, number> {
    return {
      records_accepted: recordsAccepted,
      records_attempted: recordsAttempted,
      records_flushed: recordsAccepted,
      records_permanently_rejected: recordsPermanentlyRejected,
      records_unresolved_retryable: recordsUnresolvedRetryable(),
    };
  }

  function countStagedStateStreams() {
    return Object.keys(newState).length;
  }

  function checkpointCommitStatus() {
    if (!persistState) {
      return "disabled";
    }
    const stateStreamsStaged = countStagedStateStreams();
    const stateStreamsCommitted = committedStateStreams.size;
    if (stateStreamsStaged === 0) {
      return finalStatus === "succeeded" ? "committed" : "not_committed";
    }
    if (stateStreamsCommitted === 0) {
      return "not_committed";
    }
    if (stateStreamsCommitted < stateStreamsStaged) {
      return "partially_committed";
    }
    return "committed";
  }

  function appendKnownGap(gap: Record<string, unknown>): void {
    knownGaps.push(gap);
  }

  /**
   * A connector requests a recovery action only via `connector_error.recovery_hint`
   * — the same closed vocabulary/shape as `SKIP_RESULT.recovery_hint`
   * (validated on ingest by `validateDoneError`, so an invalid shape can never
   * reach here). `code`/`message` are cause identity and free-form text; the
   * RI never inspects either to choose an action.
   *
   * A present, validated hint is authoritative and wins outright — including
   * over the runtime's own CDP/browser-infrastructure text match below. The
   * text match exists only to give runtime infrastructure failures (a dead
   * browser process, not connector logic) a sane default action when the
   * connector declared no hint at all; it is a fallback for an ABSENT hint,
   * never an override for a PRESENT one. `buildKnownGap` (via
   * `normalizeRecoveryHint`) already fails closed on a missing/unrecognized
   * hint by falling back to its own generic, vocabulary-based inference —
   * this function does not need to duplicate that.
   */
  function recoveryHintFromTerminalConnectorError(
    connectorError: ConnectorDoneError | null | undefined
  ): string | { action?: string; retryable?: boolean } | null {
    if (connectorError?.recovery_hint) {
      return connectorError.recovery_hint;
    }
    const message = typeof connectorError?.message === "string" ? connectorError.message : "";
    if (isRuntimeRetryableBrowserProfileError(message)) {
      return "retry_by_runtime";
    }
    if (connectorError?.retryable === true) {
      return "retry_by_runtime";
    }
    return null;
  }

  function buildKnownGapsForTerminal(
    reason: string | null = null,
    connectorError: ConnectorDoneError | null = null
  ): Record<string, unknown>[] {
    const terminalGaps = [...knownGaps];
    if (finalStatus === "failed") {
      terminalGaps.push(
        buildKnownGap({
          kind: "run_failed",
          message: connectorError?.message || null,
          reason: reason || "run_failed",
          recoveryHint: recoveryHintFromTerminalConnectorError(connectorError),
        })
      );
    }
    const commitStatus = checkpointCommitStatus();
    if (commitStatus === "not_committed" || commitStatus === "partially_committed") {
      terminalGaps.push(
        buildKnownGap({
          kind: "checkpoint_commit",
          message:
            commitStatus === "partially_committed"
              ? "Some staged stream state was not committed"
              : "Staged stream state was not committed",
          reason: commitStatus,
          recoveryHint: "retry_by_runtime",
        })
      );
    }
    return terminalGaps;
  }

  function buildTerminalRunFields(reason: string | null, stdinClosedAtPhase: string | null): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (triggerKind) {
      data.trigger_kind = triggerKind;
    }
    if (automationMode) {
      data.automation_mode = automationMode;
    }
    if (startRecoveryOnly) {
      data.recovery_only = true;
    }
    if (reason) {
      data.reason = reason;
    }
    if (reason === "connector_stdin_closed") {
      data.stdin_closed_at_phase = stdinClosedAtPhase || "unknown";
    }
    if (!isNullish(lastSeenCollectionRate)) {
      data.collection_rate = lastSeenCollectionRate;
    }
    return data;
  }

  function buildTerminalConnectorFields(
    connectorError: ConnectorDoneError | null,
    ingestFailure: IngestFailureDetail | null,
    exitCode: number | null,
    reportedRecordsEmitted: unknown
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (exitCode !== null && exitCode !== undefined) {
      data.exit_code = exitCode;
    }
    if (reportedRecordsEmitted !== null && reportedRecordsEmitted !== undefined) {
      data.reported_records_emitted = reportedRecordsEmitted;
    }
    if (connectorError?.message) {
      // `manifest` closes over the enclosing run's own resolved manifest.
      // `declaredReasonTokensFor` returns `undefined` for every connector
      // that declares no `capabilities.declared_reason_tokens` — those stay
      // byte-identical to prior behavior; only a connector that declared its
      // own reason-token vocabulary gets it preserved here. The RI reads the
      // declaration generically and never learns a connector name.
      data.connector_error_message = boundConnectorErrorMessage(
        connectorError.message,
        declaredReasonTokensFor(manifest)
      );
    }
    // Unlike `message`, `code` is copied without redaction — it is a typed,
    // non-secret channel by contract, so it MUST be validated (not
    // redacted) before crossing into the unredacted `connector_error_code`
    // column. boundConnectorErrorCode fails closed to null on anything
    // malformed, so an invalid/malicious code is dropped rather than
    // trusted just because the connector sent it.
    const validatedCode = connectorError?.code ? boundConnectorErrorCode(connectorError.code) : null;
    if (validatedCode) {
      data.connector_error_code = validatedCode;
    }
    if (connectorError?.retryable !== null && connectorError?.retryable !== undefined) {
      data.connector_error_retryable = connectorError.retryable;
    }
    const publicIngestFailure = toPublicIngestFailure(ingestFailure);
    if (publicIngestFailure) {
      data.ingest_failure = publicIngestFailure;
    }
    return data;
  }

  function buildTerminalErrorFields({
    connectorDiagnostics,
    connectorError,
    exitCode,
    failureMessage,
    failureOrigin,
    ingestFailure,
    reportedRecordsEmitted,
    violation,
  }: {
    connectorDiagnostics: Record<string, unknown> | null;
    connectorError: ConnectorDoneError | null;
    exitCode: number | null;
    failureMessage: string | null;
    failureOrigin: RuntimeFailureOrigin | null;
    ingestFailure: IngestFailureDetail | null;
    reportedRecordsEmitted: unknown;
    violation: unknown;
  }): Record<string, unknown> {
    const data: Record<string, unknown> = buildTerminalConnectorFields(
      connectorError,
      ingestFailure,
      exitCode,
      reportedRecordsEmitted
    );
    if (failureOrigin) {
      data.failure_origin = failureOrigin;
    }
    if (failureMessage) {
      data.failure_message = failureMessage;
    }
    if (connectorDiagnostics && Object.keys(connectorDiagnostics).length > 0) {
      data.connector_diagnostics = connectorDiagnostics;
    }
    if (violation instanceof ProtocolViolation) {
      data.violation = violation.toPublicShape({ lastValidSpineEvent });
    }
    return data;
  }

  function buildTerminalOptionalData({
    connectorDiagnostics,
    connectorError,
    exitCode,
    failureMessage,
    failureOrigin,
    ingestFailure,
    reason,
    reportedRecordsEmitted,
    stdinClosedAtPhase,
    violation,
  }: {
    connectorDiagnostics: Record<string, unknown> | null;
    connectorError: ConnectorDoneError | null;
    exitCode: number | null;
    failureMessage: string | null;
    failureOrigin: RuntimeFailureOrigin | null;
    ingestFailure: IngestFailureDetail | null;
    reason: string | null;
    reportedRecordsEmitted: unknown;
    stdinClosedAtPhase: string | null;
    violation: unknown;
  }): Record<string, unknown> {
    return {
      ...buildTerminalRunFields(reason, stdinClosedAtPhase),
      ...buildTerminalErrorFields({
        connectorDiagnostics,
        connectorError,
        exitCode,
        failureMessage,
        failureOrigin,
        ingestFailure,
        reportedRecordsEmitted,
        violation,
      }),
    };
  }

  function buildTerminalGapData(
    terminalKnownGaps: Record<string, unknown>[],
    visibleKnownGaps: Record<string, unknown>[]
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (terminalKnownGaps.length) {
      data.known_gaps = visibleKnownGaps;
      data.known_gaps_summary = summarizeKnownGaps(terminalKnownGaps);
    }
    if (durableDetailGaps.length) {
      data.detail_gaps = {
        gap_ids: durableDetailGaps.slice(0, KNOWN_GAPS_MAX).map((gap) => gap.gap_id),
        pending_recorded: durableDetailGaps.length,
        reference_only: true,
      };
    }
    return data;
  }

  function buildRunTerminalData({
    recordsEmitted = totalEmitted,
    reason = null,
    exitCode = null,
    reportedRecordsEmitted = null,
    connectorError = null,
    ingestFailure = null,
    violation = null,
    stdinClosedAtPhase = null,
    failureOrigin = null,
    failureMessage = null,
    connectorDiagnostics = null,
  }: {
    connectorDiagnostics?: Record<string, unknown> | null;
    connectorError?: ConnectorDoneError | null;
    exitCode?: number | null;
    failureMessage?: string | null;
    failureOrigin?: RuntimeFailureOrigin | null;
    ingestFailure?: IngestFailureDetail | null;
    recordsEmitted?: unknown;
    reason?: string | null;
    reportedRecordsEmitted?: unknown;
    stdinClosedAtPhase?: string | null;
    violation?: unknown;
  } = {}): Record<string, unknown> {
    const stateStreamsStaged = countStagedStateStreams();
    const stateStreamsCommitted = committedStateStreams.size;
    const terminalKnownGaps = buildKnownGapsForTerminal(reason, connectorError);
    const visibleKnownGaps = terminalKnownGaps.slice(0, KNOWN_GAPS_MAX);
    // Runtime collection-fact block (task 2.2a): objective per-stream facts only.
    // No coverage condition / forward disposition — those are derived by the
    // control-plane projection on read (Tranche C).
    // `connector-gap-bounding.ts` declares its own structural `KnownGap` /
    // `DetailCoverageEntry` shapes for these inputs; the runtime's records
    // satisfy them, so the argument object is bridged once here rather than
    // duplicating that module's private types.
    const collectionFacts = buildCollectionFacts({
      committedStateStreams,
      detailCoverageByStateStream,
      durableDetailGaps,
      emittedByStream,
      knownGaps,
      manifestDetailParentStreamsByStream,
      manifestStateStreamByStream,
      newState,
      persistState,
      recoveryOnly: startRecoveryOnly,
      scopeByStream,
    } as unknown as Parameters<typeof buildCollectionFacts>[0]);
    return {
      buffered_records_dropped: countBufferedRecords(),
      checkpoint_commit_status: checkpointCommitStatus(),
      checkpoint_mode: "checkpointed_streaming",
      grant_id: grantId,
      persist_state: persistState,
      records_emitted: recordsEmitted,
      ...buildIngestAccountingFields(),
      source: runSource,
      state_streams_committed: stateStreamsCommitted,
      state_streams_staged: stateStreamsStaged,
      ...(collectionFacts ? { collection_facts: collectionFacts } : {}),
      // Final adaptive rate controller state: the last `collection_rate` progress
      // payload emitted this run. Persisted on the terminal event so the reference
      // can surface it as `connection_health.collection_rate` after the run ends,
      // without a separate spine scan. Absent when no controller was active.
      // Additive runtime-authored failure classification + connector
      // diagnostic evidence. See
      // openspec/changes/persist-connector-failure-diagnostics.
      // `failure_origin` distinguishes runtime-authored classification
      // (connector|runtime|transport|storage); `failure_message` is a
      // concise runtime-authored explanation; `connector_diagnostics`
      // carries connector-authored, untrusted excerpts (currently just
      // a bounded redacted stderr tail).
      ...buildTerminalGapData(terminalKnownGaps, visibleKnownGaps),
      ...buildTerminalOptionalData({
        connectorDiagnostics,
        connectorError,
        exitCode,
        failureMessage,
        failureOrigin,
        ingestFailure,
        reason,
        reportedRecordsEmitted,
        stdinClosedAtPhase,
        violation,
      }),
    };
  }

  function buildCheckpointSummary() {
    const stateStreamsStaged = countStagedStateStreams();
    const stateStreamsCommitted = committedStateStreams.size;
    return {
      buffered_records_dropped: countBufferedRecords(),
      commit_status: checkpointCommitStatus(),
      mode: "checkpointed_streaming",
      ...buildIngestAccountingFields(),
      state_streams_committed: stateStreamsCommitted,
      state_streams_staged: stateStreamsStaged,
    };
  }

  function trackDetailCoverage(msg: ConnectorMessage): void {
    // `validateDetailCoverageMessage` ran first: state_stream/stream are
    // non-empty strings and the three key arrays are string/number arrays.
    const stateStream = msg.state_stream as string;
    const stream = msg.stream as string;
    const entries = detailCoverageByStateStream.get(stateStream) || [];
    if (entries.some((entry) => entry.stream === stream)) {
      throw new Error(`Connector emitted duplicate DETAIL_COVERAGE for state_stream=${stateStream} stream=${stream}`);
    }
    entries.push({
      // Optional connector-declared considered denominator (task 2.1). Retained
      // here — normalized to a trusted safe non-negative integer or null — so
      // the terminal collection-fact block can prefer it over the
      // required_keys.length fallback. null stays `unknown`; never inferred.
      considered: boundConsideredCount(msg.considered),
      // Optional connector-declared covered count (task 4.4): in-boundary items the
      // run accounted for (emitted + suppressed-unchanged). Same drop-don't-reject
      // normalization. null stays `unknown`; the projection compares `considered`
      // against `covered` when present so a steady-state full-sync run reads
      // `complete`, never inferred from collected.
      covered: boundConsideredCount(msg.covered),
      // Connector-declared unhydrated keys. Retained for collection facts and
      // diagnostics, but never authoritative by themselves: the checkpoint
      // gate credits a gap only when the same key has a durable DETAIL_GAP.
      gapKeys: new Set(((msg.gap_keys as (string | number)[] | null) || []).map(normalizeCoverageKey)),
      hydratedKeys: new Set((msg.hydrated_keys as (string | number)[]).map(normalizeCoverageKey)),
      optionalSkipKeys: new Set(
        ((msg.optional_skip_keys as (string | number)[] | null) || []).map(normalizeCoverageKey)
      ),
      requiredKeys: (msg.required_keys as (string | number)[]).map(normalizeCoverageKey),
      stream,
    });
    detailCoverageByStateStream.set(stateStream, entries);
  }

  // Resolve every STATE_STREAM checkpoint key owned by a data stream, for
  // excluding a failed stream's checkpoint parent(s) from commit. Manifest
  // declaration is authoritative and takes precedence: a `parent_streams`
  // stream's every declared parent is a candidate to withhold, whether or
  // not that parent got a live DETAIL_COVERAGE report this run (a failed
  // stream's live evidence is inherently incomplete, so under-excluding by
  // trusting only what happened to arrive live would be unsafe). The static
  // `state_stream` mapping is the fallback for a stream with no
  // `parent_streams` declaration, and the data stream's own name is the
  // final fallback for a self-mapped stream.
  function resolveStateStreamsForDataStream(dataStream: string): ReadonlySet<string> {
    const declaredParents = manifestDetailParentStreamsByStream.get(dataStream);
    if (declaredParents?.size) {
      return declaredParents;
    }
    return new Set([manifestStateStreamByStream.get(dataStream) || dataStream]);
  }

  // A DETAIL_COVERAGE shortfall is a coverage GAP, not a protocol violation.
  // The connector spoke a well-formed protocol and told the truth about what it
  // could not hydrate this run; the honest response is to report the shortfall
  // and withhold the affected `state_stream`'s cursor so the next run
  // re-collects it — never to fail a run whose records are already ingested and
  // durable. (A claim of completeness must carry proof, so an unproven key
  // still blocks the cursor advance; incomplete coverage is reported, not
  // fatal.) Mirrors the transient-manifest-drift posture in
  // `recordManifestDriftStreamSkip`: per-stream gap + no cursor advance.
  //
  // Returns the `state_stream`s whose coverage is unproven; the caller skips
  // exactly those commits and commits the rest.
  function missingDetailCoverageReports(
    stateStream: string,
    coverageEntries: readonly DetailCoverageEntry[]
  ): string[] {
    const missing: string[] = [];
    for (const [detailStream, parents] of manifestDetailParentStreamsByStream) {
      if (
        scopeByStream.has(detailStream) &&
        parents.has(stateStream) &&
        !coverageEntries.some((coverage) => coverage.stream === detailStream)
      ) {
        missing.push(detailStream);
      }
    }
    return missing;
  }

  async function recordDetailCoverageShortfalls(): Promise<Set<string>> {
    const shortfallStateStreams = new Set<string>();
    for (const stateStream of Object.keys(newState)) {
      const coverageEntries = detailCoverageByStateStream.get(stateStream) || [];
      for (const detailStream of missingDetailCoverageReports(stateStream, coverageEntries)) {
        shortfallStateStreams.add(stateStream);
        // biome-ignore lint/performance/noAwaitInLoops: one bounded gap per missing parent report; sequential ordering keeps the timeline honest.
        await recordMissingDetailCoverageReport(stateStream, detailStream);
      }
      for (const coverage of coverageEntries) {
        const coverageParents = manifestDetailParentStreamsByStream.get(coverage.stream);
        const hasMultipleParents = (coverageParents?.size || 0) > 1;
        const accountedGapKeys = new Set(
          durableDetailGaps
            .filter(
              (gap) =>
                gap.stream === coverage.stream &&
                (gap.status === "pending" || gap.status === "recovered") &&
                durableGapMatchesCoverageParent(gap.parent_stream, stateStream, hasMultipleParents) &&
                !isNullish(gap.record_key)
            )
            .map((gap) => normalizeCoverageKey(gap.record_key as string | number))
        );
        const missingKeys = coverage.requiredKeys.filter(
          (key) => !(coverage.hydratedKeys.has(key) || coverage.optionalSkipKeys.has(key) || accountedGapKeys.has(key))
        );
        if (!missingKeys.length) {
          continue;
        }
        shortfallStateStreams.add(stateStream);
        // biome-ignore lint/performance/noAwaitInLoops: one bounded gap per shortfalling coverage entry; sequential ordering keeps the timeline honest.
        await recordDetailCoverageShortfall(stateStream, coverage, missingKeys.length);
      }
    }
    return shortfallStateStreams;
  }

  async function recordMissingDetailCoverageReport(stateStream: string, stream: string): Promise<void> {
    const message = `Connector detail coverage incomplete: state_stream=${stateStream} stream=${stream} coverage_report=missing`;
    const gap = buildKnownGap({
      diagnostics: { coverage_report: "missing", state_stream: stateStream },
      kind: "detail_coverage",
      message,
      reason: "detail_coverage_incomplete",
      recoveryHint: "retry_by_runtime",
      stream,
    });
    appendKnownGap(gap);
    await emitSpineEventTracked({
      actor_id: connectorId,
      actor_type: "runtime",
      data: {
        known_gap: gap,
        message,
        reason: "detail_coverage_incomplete",
        source: runSource,
        state_stream: stateStream,
        stream,
      },
      event_type: "run.stream_skipped",
      object_id: runId,
      object_type: "run",
      run_id: runId,
      scenario_id: traceContext.scenario_id,
      status: "skipped",
      stream_id: stream,
      trace_id: traceContext.trace_id,
    });
    onProgress({ reason: "detail_coverage_incomplete", stream, type: "stream_skipped" });
  }

  // Per-shortfall known gap + timeline event. `detail_coverage_incomplete` is a
  // transient reason: the next run retries the same keys, so the owner sees a
  // reported gap with a real explanation rather than a bare failure.
  async function recordDetailCoverageShortfall(
    stateStream: string,
    coverage: DetailCoverageEntry,
    missingKeyCount: number
  ): Promise<void> {
    const message = detailCoverageShortfallMessage(stateStream, coverage.stream, missingKeyCount);
    const gap = buildKnownGap({
      diagnostics: {
        missing_required_keys: missingKeyCount,
        required_keys: coverage.requiredKeys.length,
        state_stream: stateStream,
      },
      kind: "detail_coverage",
      message,
      reason: "detail_coverage_incomplete",
      recoveryHint: "retry_by_runtime",
      stream: coverage.stream,
    });
    appendKnownGap(gap);
    await emitSpineEventTracked({
      actor_id: connectorId,
      actor_type: "runtime",
      data: {
        known_gap: gap,
        message,
        reason: "detail_coverage_incomplete",
        source: runSource,
        state_stream: stateStream,
        stream: coverage.stream,
      },
      event_type: "run.stream_skipped",
      object_id: runId,
      object_type: "run",
      run_id: runId,
      scenario_id: traceContext.scenario_id,
      status: "skipped",
      stream_id: coverage.stream,
      trace_id: traceContext.trace_id,
    });
    onProgress({ reason: "detail_coverage_incomplete", stream: coverage.stream, type: "stream_skipped" });
  }

  // Record a transient per-stream gap for a stream whose ingest was rejected as
  // not_found despite passing the runtime's START-scope manifest check (transient
  // manifest drift). Mirrors the SKIP_RESULT gap+event path so the drift is
  // legible in the timeline, and marks the stream so its cursor is not committed.
  async function recordManifestDriftStreamSkip(stream: string, err: RuntimeRunError | null | undefined): Promise<void> {
    driftSkippedStreams.add(stream);
    const skippedManifestStream = manifestByStream.get(stream) || null;
    const gap = buildKnownGap({
      diagnostics: {
        http_status: err?.ingest_failure?.http_status ?? err?.response_status ?? null,
        phase: err?.ingest_failure?.phase ?? null,
      },
      explicitSelection: Boolean(explicitlyRequestedStreams?.has(stream)),
      kind: "stream_skipped",
      message:
        "Resource server rejected ingest as not_found for a manifest-declared stream (transient manifest drift); stream deferred to the next run.",
      reason: "manifest_stream_unresolved",
      recoveryHint: "retry_by_runtime",
      stream,
      unsupportedInDefaultScope: streamUnsupportedInDefaultScope(skippedManifestStream),
    });
    appendKnownGap(gap);
    await emitSpineEventTracked({
      actor_id: connectorId,
      actor_type: "runtime",
      data: {
        known_gap: gap,
        message: gap.message || null,
        reason: "manifest_stream_unresolved",
        source: runSource,
        stream,
        ...(gap.diagnostics ? { diagnostics: gap.diagnostics } : {}),
      },
      event_type: "run.stream_skipped",
      object_id: runId,
      object_type: "run",
      run_id: runId,
      scenario_id: traceContext.scenario_id,
      status: "skipped",
      stream_id: stream,
      trace_id: traceContext.trace_id,
    });
    onProgress({ reason: "manifest_stream_unresolved", stream, type: "stream_skipped" });
  }

  /**
   * POST one RECORD batch to the RS, retrying a status the server marked
   * retryable within the bounds of {@link ingestRetryPolicy}.
   *
   * The RS answers a SYSTEMIC ingest failure with 503 (see
   * `ingest_batch_storage_error` in server/routes/ref-error-status.ts, whose
   * comment states 503 means "safe to retry the identical batch"). The
   * dominant producer of that 503 is the GLOBAL writer-admission gate, which
   * clears in well under a second — so failing the whole run on the first 503,
   * as this path used to, discarded every buffered record for a condition that
   * would have resolved on its own. Retrying is safe because the ingest write
   * is an upsert on `(connector_instance_id, stream, record_key)`; see
   * runtime/ingest-retry.ts for the full idempotency argument, including why an
   * accepted-prefix of a partially-committed batch does not duplicate.
   *
   * Bounded by construction: at most `maxAttempts` requests and
   * `maxAttempts - 1` sleeps, each sleep individually capped. It cannot spin.
   *
   * A NON-retryable status returns its response unchanged on the first
   * attempt, so `readIngestResponse` shapes the same terminal error a 4xx
   * produced before this retry existed. Cancellation is honored between
   * attempts: a run that was cancelled or timed out mid-backoff stops waiting
   * and returns the last response rather than continuing to retry work whose
   * outcome is already terminal.
   */
  async function postIngestBatchWithRetry(
    url: string,
    ndjson: string,
    stream: string,
    batchSize: number
  ): Promise<Response> {
    const maxAttempts = Math.max(1, ingestRetryPolicy.maxAttempts);
    let response: Response | null = null;
    // Body of the LAST retryable response, kept so the exhaustion error can
    // still carry the server's own diagnosis (`ingest_batch_storage_error`,
    // `connector_instance_busy`, `run_terminal`, …). Without it the terminal
    // message would say only "the endpoint stayed saturated" and an operator
    // would lose the reason WHY — which is the whole value of the 503 body.
    // Read here rather than at the throw site because a `Response` body can
    // only be consumed once, and a retried response is otherwise discarded.
    let lastRetryableBody = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential retry is the point — each attempt must observe the previous one's status and wait out its backoff before the next.
      response = await fetchWithNetworkRetry(
        url,
        {
          body: ndjson,
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
          signal: cancelSignal ?? null,
        },
        stream,
        "ingest_retry"
      );
      if (response.ok || !isRetryableIngestStatus(response.status)) {
        return response;
      }
      lastRetryableBody = await response.text().catch(() => "");
      if (attempt >= maxAttempts) {
        break;
      }
      // Cancellation/timeout already owns this run's terminal outcome; don't
      // spend the remaining retry budget on a batch whose result is moot.
      // Hand back a REPLAY of the response rather than the original: its body
      // was consumed above, and `readIngestResponse` calls `.text()` on
      // whatever it receives — returning the drained original would surface a
      // "body already read" TypeError in place of the real ingest failure.
      if (terminalStopRequested()) {
        return new Response(lastRetryableBody, {
          headers: response.headers,
          status: response.status,
        });
      }
      const delayMs = nextIngestRetryDelayMs({
        attempt,
        policy: ingestRetryPolicy,
        random: ingestRetryRandom,
        retryAfterMs: parseIngestRetryAfterMs(response.headers.get("retry-after")),
      });
      onProgress({
        attempt,
        delay_ms: delayMs,
        max_attempts: maxAttempts,
        status: response.status,
        stream,
        type: "ingest_retry",
      });
      await ingestRetrySleep(delayMs);
    }
    // Bound exhausted against a status the server itself called retryable. Fail
    // with a reason that names the real condition — the ingest endpoint stayed
    // saturated for the whole budget — rather than reusing `ingest_http_error`,
    // which would read as "the RS rejected this batch" and send an operator
    // looking for a data defect that does not exist.
    // The last response's body is folded in so the server's own diagnosis
    // (`ingest_batch_storage_error`, `connector_instance_busy`, `run_terminal`)
    // survives into the terminal message alongside the saturation framing.
    const exhausted = buildIngestHttpFailure(
      `Ingest for ${stream} exhausted ${maxAttempts} attempts against a retryable ingest endpoint`,
      stream,
      batchSize,
      // `response` is non-null here: the loop only breaks after an assignment.
      (response as Response).status,
      lastRetryableBody,
      (response as Response).headers.get("content-type")
    );
    exhausted.failure_reason = INGEST_SATURATED_FAILURE_REASON;
    exhausted.pdpp_error_code = INGEST_SATURATED_FAILURE_REASON;
    throw exhausted;
  }

  async function flushBatch(stream: string): Promise<void> {
    // Cancellation owns the terminal outcome. Do not start another ingest for
    // a RECORD that was already buffered in the parent after the child was
    // stopped; doing so makes terminalization wait behind an unbounded Gmail
    // message/attachment queue.
    if (terminalStopRequested()) {
      recordBatch[stream] = [];
      return;
    }
    // Already deferred this run for transient manifest drift: don't re-POST (it
    // would just 404 again). Drop any further buffered records for the stream.
    if (driftSkippedStreams.has(stream)) {
      recordBatch[stream] = [];
      return;
    }
    const batch = recordBatch[stream];
    if (!batch?.length) {
      return;
    }
    const ndjson = batch.map((r) => JSON.stringify(r)).join("\n");
    const ingestUrl = new URL(`/v1/ingest/${encodeURIComponent(stream)}`, rsUrl);
    ingestUrl.searchParams.set("connector_id", connectorId);
    if (connectorInstanceEnv.PDPP_CONNECTOR_INSTANCE_ID) {
      ingestUrl.searchParams.set("connector_instance_id", connectorInstanceEnv.PDPP_CONNECTOR_INSTANCE_ID);
    }
    ingestUrl.searchParams.set("run_id", runId);
    recordsAttempted += batch.length;
    const resp = await postIngestBatchWithRetry(ingestUrl.toString(), ndjson, stream, batch.length);
    // Cancellation may have been requested while this fetch was in flight, but
    // the response already arrived: the RS committed its durable receipts
    // (acceptance or permanent rejection) before answering. Discarding that
    // response here would silently drop already-durable rejection evidence
    // from the run's own counters, even though the receipt survives in RS
    // storage. Count it like any other completed batch; cancellation still
    // blocks state/cursor commit separately (see the persistState gate below).
    let result: Awaited<ReturnType<typeof readIngestResponse>>;
    try {
      result = await readIngestResponse(resp, stream, batch.length);
    } catch (err) {
      // Transient manifest drift: the RS rejected this stream's ingest as
      // not_found even though the runtime already validated the stream against
      // the manifest at START (`scopeByStream` membership proves it survived
      // buildStartScope's manifest check). The two manifest reads (runtime START
      // vs RS ingest) momentarily disagree because the persisted connectors row
      // is stale. Degrade to a transient per-stream gap instead of aborting the
      // whole run: drop this batch, skip the cursor, keep the other streams.
      // Any other status/code — and any not_found for a stream not in START
      // scope (unreachable via the RECORD path) — stays terminal. See OpenSpec
      // change harden-ingest-against-transient-manifest-drift.
      if (isTransientManifestDriftIngestFailure(err as RuntimeRunError, stream, (s: string) => scopeByStream.has(s))) {
        await recordManifestDriftStreamSkip(stream, err as RuntimeRunError);
        recordBatch[stream] = [];
        return;
      }
      throw err;
    }
    // Defensive protocol-violation net, NOT the primary retry classifier.
    // The RS contract (rs.records.ingest) guarantees that any SYSTEMIC
    // per-record failure — a storage/coordination error that never proved a
    // record's own data invalid — makes the whole HTTP response non-2xx
    // (RecordsIngestSystemicFailureError, mapped to 503). That case is handled
    // BEFORE this point, and handled by actually retrying:
    // `postIngestBatchWithRetry` re-POSTs the identical batch on a retryable
    // status within a bounded budget, so a transient saturation of the global
    // writer-admission gate resolves instead of killing the run. Only when that
    // budget is exhausted does it throw — with failure_reason
    // `ingest_endpoint_saturated`, naming the saturation rather than implying
    // the RS rejected the data. A non-retryable non-2xx returns straight
    // through to `readIngestResponse`, whose `!resp.ok` branch throws a
    // terminal failure via buildIngestHttpFailure exactly as before.
    //
    // (This comment previously claimed the `!resp.ok` branch produced "a
    // thrown, retryable failure." Nothing retried it: the throw killed the run
    // and dropped every buffered record. The retry the comment described is
    // what runtime/ingest-retry.ts now implements.)
    //
    // A PERMANENT per-record rejection (malformed
    // JSON, a genuine schema/identity defect) legitimately stays inside a
    // 2xx envelope with records_rejected > 0 — that is the intentional
    // per-record isolation contract, whether it covers one record or every
    // record in the batch, and must NOT be treated as retryable just because
    // the count happens to equal the batch size (that conflated N legitimate
    // permanent failures with a systemic one — the defect a prior revision of
    // this check introduced). What SHOULD be structurally unreachable against
    // a conforming RS is records_accepted === 0 on a 2xx WHOSE envelope also
    // reports zero errors, or a 2xx whose records_accepted/records_rejected
    // don't sum to the batch size — either shape means the RS is not honoring
    // its own contract (an old/non-reference RS, or a bug), not that the
    // records were validly rejected. Only that impossible shape trips this
    // net; a normal permanent-rejection envelope (errors.length matching
    // records_rejected) never does, no matter how many records it rejects.
    const reportedTotal = result.records_accepted + result.records_rejected;
    if (batch.length > 0 && result.records_accepted === 0 && reportedTotal !== batch.length) {
      throw buildIngestEnvelopeContractViolationFailure({
        batchSize: batch.length,
        recordsAccepted: result.records_accepted,
        recordsRejected: result.records_rejected,
        status: resp.status,
        stream,
      });
    }
    recordsAccepted += result.records_accepted;
    recordsPermanentlyRejected += result.records_rejected;
    await emitSpineEventTracked({
      actor_id: connectorId,
      actor_type: "runtime",
      data: {
        batch_size: batch.length,
        grant_id: grantId,
        records_accepted: result.records_accepted,
        records_attempted: result.records_attempted,
        records_flushed: result.records_accepted,
        records_permanently_rejected: result.records_rejected,
        records_rejected: result.records_rejected,
        source: runSource,
        total_records_flushed: recordsAccepted,
      },
      event_type: "run.batch_ingested",
      object_id: runId,
      object_type: "run",
      run_id: runId,
      scenario_id: traceContext.scenario_id,
      status: "succeeded",
      stream_id: stream,
      trace_id: traceContext.trace_id,
    });
    onProgress({
      accepted: result.records_accepted,
      attempted: result.records_attempted,
      records_accepted: result.records_accepted,
      records_attempted: result.records_attempted,
      records_permanently_rejected: result.records_rejected,
      rejected: result.records_rejected,
      stream,
      total_records_flushed: recordsAccepted,
      type: "ingest",
    });
    recordBatch[stream] = [];
  }

  async function flushAll(): Promise<void> {
    await Object.keys(recordBatch).reduce(
      (previous, stream) => previous.then(() => flushBatch(stream)),
      Promise.resolve()
    );
  }

  /**
   * `fetch()` with a bounded retry against a network-level throw only (no
   * response ever arrived) — the same failure class {@link postIngestBatchWithRetry}
   * now retries, applied here because {@link commitState}'s PUT had none:
   * before this existed, a bare `TypeError: fetch failed` on the STATE commit
   * was uncaught, killing the run with `terminal_reason: runtime_error` after
   * every record had already been durably accepted, and leaving the
   * checkpoint `not_staged` for a run whose connector never got a chance to
   * retry. An HTTP status the response DID carry is left to the caller, same
   * division of responsibility as the ingest path.
   */
  async function fetchWithNetworkRetry(
    url: string,
    init: RequestInit,
    stream: string,
    progressType: "ingest_retry" | "state_commit_retry"
  ): Promise<Response> {
    const maxAttempts = Math.max(1, ingestRetryPolicy.maxAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: sequential retry is the point — each attempt must observe the previous one's failure before the next.
        return await fetch(url, init);
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableFetchError(error) || terminalStopRequested()) {
          throw error;
        }
        const delayMs = nextIngestRetryDelayMs({
          attempt,
          policy: ingestRetryPolicy,
          random: ingestRetryRandom,
          retryAfterMs: null,
        });
        onProgress({
          attempt,
          delay_ms: delayMs,
          max_attempts: maxAttempts,
          status: null,
          stream,
          type: progressType,
        });
        await ingestRetrySleep(delayMs);
      }
    }
    throw new Error("unreachable: fetchWithNetworkRetry loop exited without returning or throwing");
  }

  // Process a STATE message: persist to RS
  async function commitState(stream: string, cursor: unknown): Promise<void> {
    newState[stream] = cursor;
    const stateUrl = new URL(`/v1/state/${encodeURIComponent(connectorId)}`, rsUrl);
    if (connectorInstanceEnv.PDPP_CONNECTOR_INSTANCE_ID) {
      stateUrl.searchParams.set("connector_instance_id", connectorInstanceEnv.PDPP_CONNECTOR_INSTANCE_ID);
    }
    if (grantId) {
      stateUrl.searchParams.set("grant_id", grantId);
    }
    const url = stateUrl.toString();
    try {
      const resp = await fetchWithNetworkRetry(
        url,
        {
          body: JSON.stringify({ state: { [stream]: cursor } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        },
        stream,
        "state_commit_retry"
      );
      if (!resp.ok) {
        const body = await resp.text();
        throw buildHttpFailure(`State persistence failed for ${stream}`, resp.status, body);
      }
      // Drain the success-path body before moving on. This response is the
      // only RS response the runtime does not otherwise read (the ingest path
      // always reads via readIngestResponse), and an unread body leaves
      // undici's HTTP parser holding buffered response data. If the socket is
      // then torn down while that parser is paused, Node's vendored undici
      // hits an unguarded `assert(!this.paused)` in `Parser.finish` and raises
      // an uncaughtException that no try/catch here can intercept. Reading the
      // body to completion returns the connection to a clean, resumable state.
      // The payload is a small JSON ack, so this costs nothing; `catch` keeps
      // a drain failure from masking an otherwise successful commit, which is
      // already durable server-side at this point.
      await resp.text().catch(() => "");
      committedStateStreams.add(stream);

      // Cursor-band contiguity: the cursor that was just durably committed is
      // the exact artifact that decides what future runs will fetch, so this
      // is the moment a two-pointer walk can be caught skipping an identifier
      // band. Evaluated AFTER the successful persist so the reported numbers
      // are the ones actually stored, never a staged value that failed to
      // commit. Pure and allocation-light; `not_registered` short-circuits for
      // every stream that declares no band, which is all but one today.
      //
      // The stream's manifest declares WHETHER it walks a band, via a closed
      // `cursor_shape` enum the RI recognizes; the RI owns what that shape
      // MEANS (paths, epoch guard, arithmetic). An undeclared or unrecognized
      // shape selects no variant and stays silent — declaring can only opt a
      // stream in, never exempt one from a check it would otherwise get.
      const bandVerdict = evaluateCursorBand({
        cursor,
        declaredShape: manifestByStream.get(stream)?.cursor_shape,
      });
      if (bandVerdict.violated) {
        await emitSpineEventTracked({
          actor_id: connectorId,
          actor_type: "runtime",
          data: {
            band_size: bandVerdict.bandSize,
            ceiling: bandVerdict.ceiling,
            grant_id: grantId,
            message: describeCursorBandViolation({ connectorId, stream, verdict: bandVerdict }),
            reason: bandVerdict.reason,
            resume: bandVerdict.resume,
            source: runSource,
          },
          event_type: "run.cursor_band_violated",
          object_id: runId,
          object_type: "run",
          run_id: runId,
          scenario_id: traceContext.scenario_id,
          // `failed` is the honest status: unlike a coverage claim, this is a
          // proven defect in the fetch plan, not an unproven absence. No
          // upstream fact could make the stored arithmetic hold.
          status: "failed",
          stream_id: stream,
          trace_id: traceContext.trace_id,
        });
      }

      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          checkpoint_mode: "checkpointed_streaming",
          cursor,
          grant_id: grantId,
          source: runSource,
          state_streams_committed: committedStateStreams.size,
        },
        event_type: "run.state_advanced",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "succeeded",
        stream_id: stream,
        trace_id: traceContext.trace_id,
      });
    } catch (err) {
      await emitRunSpineEvent({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          checkpoint_mode: "checkpointed_streaming",
          cursor,
          error_message: err instanceof Error ? err.message : String(err),
          grant_id: grantId,
          source: runSource,
          state_streams_committed: committedStateStreams.size,
          state_streams_staged: countStagedStateStreams(),
        },
        event_type: "run.state_commit_failed",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "failed",
        stream_id: stream,
        trace_id: traceContext.trace_id,
      });
      throw err;
    }
  }

  return new Promise((resolve, reject) => {
    const msgQueue: ConnectorMessage[] = [];
    let processing = false;
    let cleanedUp = false;
    let leaseAccountingPromise: Promise<unknown> | null = null;
    let queueDrainedResolve: (() => void) | null = null;
    let pendingInteractionViolationReject: ((err: Error) => void) | null = null;
    let terminateTimer: NodeJS.Timeout | null = null;
    let runtimeTimeoutReason: string | null = null;

    function clearTerminateTimer() {
      if (!terminateTimer) {
        return;
      }
      clearTimeout(terminateTimer);
      terminateTimer = null;
    }

    function terminateChild() {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        return;
      }
      // SIGTERM the WHOLE process group, not just the direct child PID, so a
      // connector's grandchildren (browser helpers, shelled-out tools) are
      // terminated with it rather than reparenting to PID 1.
      terminateConnectorChildGroup("SIGTERM");

      if (terminateTimer || proc.exitCode !== null || proc.signalCode !== null) {
        return;
      }
      terminateTimer = setTimeout(() => {
        terminateTimer = null;
        if (proc.exitCode !== null || proc.signalCode !== null) {
          return;
        }
        // The child ignored graceful termination within the window. Record the
        // escalation so an owner-cancelled run terminals as `owner_cancel_forced`
        // rather than `owner_cancelled`.
        if (ownerCancelRequested) {
          ownerCancelForced = true;
        }
        // Escalate to a group-wide SIGKILL: an unkillable grandchild can no
        // longer keep the subtree alive after the connector leader is gone.
        terminateConnectorChildGroup("SIGKILL");
      }, 250);
      terminateTimer.unref?.();
    }

    function clearAllAssistanceTimeouts() {
      for (const assistanceRequestId of [...assistanceTimeoutHandles.keys()]) {
        clearAssistanceTimeout(assistanceRequestId);
      }
    }

    function scheduleAssistanceTimeout(assistanceRequestId: string, timeoutSeconds: number | null | undefined): void {
      if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return;
      }
      const timeoutMs = Math.max(1, Math.ceil(timeoutSeconds * 1000));
      const timeoutHandle = setTimeout(() => {
        assistanceTimeoutHandles.delete(assistanceRequestId);
        if (
          terminalEventRecorded ||
          ownerCancelRequested ||
          runTimedOut ||
          !openStructuredAssistance.has(assistanceRequestId)
        ) {
          return;
        }
        runTimedOut = true;
        runtimeTimeoutReason = "assistance_timed_out";
        onProgress({
          assistance_request_id: assistanceRequestId,
          type: "assistance_timeout",
        });
        terminateChild();
      }, timeoutMs);
      timeoutHandle.unref?.();
      assistanceTimeoutHandles.set(assistanceRequestId, timeoutHandle);
    }

    // Cancellation signal wiring. Aborting `cancelSignal` requests cancellation
    // of THIS run only. Owner cancellation records a non-terminal
    // `run.cancel_requested`; scheduler timeout records no owner event and
    // terminals as `run.failed` / `run_timed_out`. Abort after
    // a terminal event is recorded is a no-op (the run already ended). The
    // listener is removed in cleanupChildHandles so a settled run does not leak
    // it on the controller's shared AbortController.
    function handleCancellation() {
      if (terminalEventRecorded || terminalStopRequested()) {
        return;
      }
      runTimedOut = cancelSignal?.reason === "run_timed_out";
      if (!runTimedOut) {
        ownerCancelRequested = true;
        // Emit the audit marker without blocking the terminate path; the terminal
        // `run.cancelled` event is emitted later by the close handler.
        emitRunSpineEvent({
          actor_id: connectorId,
          actor_type: "owner",
          data: { source: runSource, ...(triggerKind ? { trigger_kind: triggerKind } : {}) },
          event_type: "run.cancel_requested",
          object_id: runId,
          object_type: "run",
          run_id: runId,
          scenario_id: traceContext.scenario_id,
          status: "cancel_requested",
          trace_id: traceContext.trace_id,
        }).catch((err) => {
          onProgress({ error: err?.message || String(err), type: "spine_error" });
        });
        onProgress({ run_id: runId, type: "cancel_requested" });
      }
      // The child has stopped being a source of work. Discard messages already
      // buffered in the parent; only the single handler currently in flight
      // remains, and its ingest transport observes this cancellation signal.
      msgQueue.length = 0;
      terminateChild();
    }
    if (cancelSignal) {
      if (cancelSignal.aborted) {
        handleCancellation();
      } else {
        cancelSignal.addEventListener("abort", handleCancellation, { once: true });
      }
    }

    function cleanupChildHandles() {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      clearTerminateTimer();
      clearAllAssistanceTimeouts();
      if (cancelSignal) {
        cancelSignal.removeEventListener("abort", handleCancellation);
      }
      // The run reached a terminal path; this child's group no longer needs
      // the parent-exit sweep. Removing it here keeps the registry bounded to
      // genuinely in-flight runs across a long-lived process.
      unregisterOwnedConnectorChild(proc.pid);
      rl.close();
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
      if (allServedGapLeases.size > 0 && typeof detailGapStore.releaseLeasedGaps === "function") {
        const outstandingLeases = [...allServedGapLeases.values()];
        leaseAccountingPromise = Promise.resolve(detailGapStore.releaseLeasedGaps(outstandingLeases));
        // The close path awaits this promise before it reports completion. This
        // handler also runs on exceptional paths, so attach a no-op observer to
        // prevent an unhandled-rejection process warning before that await.
        leaseAccountingPromise.catch(() => {
          // The close handler performs the authoritative accounting await.
        });
      }
    }

    async function awaitLeaseAccounting() {
      if (!leaseAccountingPromise) {
        return;
      }
      const attemptedWithoutOutcome = [...allServedGapLeases.values()].filter((lease) => lease.attempted).length;
      await leaseAccountingPromise;
      allServedGapLeases.clear();
      if (finalStatus === "succeeded" && attemptedWithoutOutcome > 0) {
        throw new Error(
          "Connector completed successfully with attempted detail-gap leases lacking an explicit outcome"
        );
      }
    }

    async function rejectAfterLeaseAccounting(err: unknown): Promise<void> {
      cleanupChildHandles();
      try {
        await awaitLeaseAccounting();
      } catch (accountingErr) {
        // Durable lease accounting has a stronger completion guarantee than
        // the triggering error: callers must not observe a settled run while
        // its coverage accounting failed to settle.
        reject(accountingErr);
        return;
      }
      reject(err);
    }

    function notifyQueueDrained() {
      if (!(msgQueue.length || processing) && queueDrainedResolve) {
        const resolveDrain = queueDrainedResolve;
        queueDrainedResolve = null;
        resolveDrain();
      }
    }

    function waitForQueueDrain(): Promise<void> {
      if (terminalStopRequested()) {
        msgQueue.length = 0;
        if (!processing) {
          return Promise.resolve();
        }
      }
      if (!(msgQueue.length || processing)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolveDrain) => {
        queueDrainedResolve = resolveDrain;
      });
    }

    function failPendingInteraction(err: Error): boolean {
      if (!(pendingInteraction && pendingInteractionViolationReject)) {
        return false;
      }
      const rejectPendingInteraction = pendingInteractionViolationReject;
      pendingInteractionViolationReject = null;
      rejectPendingInteraction(err);
      terminateChild();
      return true;
    }

    async function handleMessageFailure(caught: unknown): Promise<void> {
      const err = caught as RuntimeRunError;
      finalStatus = "failed";
      const failureReason = classifyRuntimeFailure(err);
      const checkpointSummary = buildCheckpointSummary();
      err.run_id = runId;
      err.trace_id = traceContext.trace_id;
      err.failure_reason = failureReason;
      err.checkpoint_summary = checkpointSummary;
      err.terminal_reason = failureReason;
      err.connector_error = null;
      err.known_gaps = buildKnownGapsForTerminal(failureReason, null);
      const runtimeFailureMessage = runtimeAuthoredFailureMessage(err, null);

      if (!terminalEventRecorded) {
        try {
          await closeOpenStructuredAssistance("cancelled", { reason: failureReason });
          await emitRunSpineEvent({
            actor_id: connectorId,
            actor_type: "runtime",
            data: buildRunTerminalData({
              connectorError: null,
              failureMessage: runtimeFailureMessage,
              failureOrigin: runtimeFailureMessage ? "runtime" : null,
              ingestFailure: err.ingest_failure || null,
              reason: failureReason,
              recordsEmitted: totalEmitted,
              violation: err instanceof ProtocolViolation ? err : null,
            }),
            event_type: "run.failed",
            object_id: runId,
            object_type: "run",
            run_id: runId,
            scenario_id: traceContext.scenario_id,
            status: "failed",
            trace_id: traceContext.trace_id,
          });
          terminalEventRecorded = true;
        } catch (emitErr) {
          onProgress({ error: (emitErr as Error).message, type: "spine_error" });
        }
      }

      onProgress({ reason: failureReason, records_emitted: totalEmitted, status: "failed", type: "done" });
      if (queueDrainedResolve) {
        const resolveDrain = queueDrainedResolve;
        queueDrainedResolve = null;
        resolveDrain();
      }
      await rejectAfterLeaseAccounting(err);
      terminateChild();
    }

    async function processNext(): Promise<void> {
      if (terminalStopRequested()) {
        msgQueue.length = 0;
        notifyQueueDrained();
        return;
      }
      if (processing || !msgQueue.length) {
        return;
      }
      processing = true;

      // Non-null: the `!msgQueue.length` guard above ran in this same tick.
      const msg = msgQueue.shift() as ConnectorMessage;

      try {
        await handleMsg(msg);
      } catch (caught) {
        if (terminalStopRequested()) {
          return;
        }
        await handleMessageFailure(caught);
        return;
      } finally {
        processing = false;
        notifyQueueDrained();
      }

      if (terminalStopRequested()) {
        msgQueue.length = 0;
        notifyQueueDrained();
      } else {
        processNext();
      }
    }

    async function handleDetailCoverageMessage(msg: ConnectorMessage): Promise<void> {
      validateDetailCoverageMessage(
        msg,
        scopeByStream,
        manifestStateStreamByStream,
        manifestDetailParentStreamsByStream
      );
      // Flush records before a coverage claim becomes durable.
      //
      // Records are buffered and flushed at BATCH_SIZE or at DONE, but a
      // coverage claim carries an explicit `covered` count the read model
      // trusts verbatim: `evaluateStreamCoherence` compares `covered` against
      // `considered` and never consults `collected`, so a claim of 5-of-5 is
      // "proven" even when zero records reached the database. Without this
      // flush, a connector that emits DETAIL_COVERAGE and then dies with an
      // unflushed batch reports a stream fully covered whose records were
      // lost — the terminal fact block is still written on the failure path.
      //
      // Same ordering rule the state and gap-recovery handlers already apply
      // (`handleStateMessage`, `handleDetailGapRecovered`): the durable claim
      // must never precede the records it claims.
      await flushAll();
      // Proven by the validator: state_stream/stream are non-empty
      // in-scope names and the key arrays are string/number arrays.
      const coverageStateStream = msg.state_stream as string;
      const coverageStream = msg.stream as string;
      const coverageRequiredKeys = msg.required_keys as (string | number)[];
      const coverageHydratedKeys = msg.hydrated_keys as (string | number)[];
      const coverageGapKeys = msg.gap_keys as (string | number)[] | null | undefined;
      const coverageOptionalSkipKeys = msg.optional_skip_keys as (string | number)[] | null | undefined;
      trackDetailCoverage(msg);
      const coverageConsidered = boundConsideredCount(msg.considered);
      const coverageCovered = boundConsideredCount(msg.covered);
      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          gap_keys: coverageGapKeys?.length || 0,
          grant_id: grantId,
          hydrated_keys: coverageHydratedKeys.length,
          optional_skip_keys: coverageOptionalSkipKeys?.length || 0,
          reference_only: true,
          required_keys: coverageRequiredKeys.length,
          source: runSource,
          state_stream: coverageStateStream,
          stream: coverageStream,
          // Optional connector-declared denominator; omitted (= `unknown`)
          // unless it is a trusted safe non-negative integer.
          ...(isNullish(coverageConsidered) ? {} : { considered: coverageConsidered }),
          // Optional covered count (task 4.4); same omit-unless-trusted posture.
          ...(isNullish(coverageCovered) ? {} : { covered: coverageCovered }),
        },
        event_type: "run.detail_coverage_declared",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "succeeded",
        stream_id: coverageStream,
        trace_id: traceContext.trace_id,
      });
      onProgress({
        reference_only: true,
        state_stream: coverageStateStream,
        stream: coverageStream,
        type: "DETAIL_COVERAGE",
      });
    }

    async function handleAssistanceMessage(msg: ConnectorMessage): Promise<void> {
      const assistanceRequestId = (msg.assistance_request_id as string | undefined) || nextAssistanceRequestId();
      const assistanceMsg: ConnectorMessage = { ...msg, assistance_request_id: assistanceRequestId };
      validateAssistanceMessage(assistanceMsg, scopeByStream);
      if (openStructuredAssistance.has(assistanceRequestId)) {
        throw new Error(`Connector emitted duplicate ASSISTANCE.assistance_request_id: ${assistanceRequestId}`);
      }
      openStructuredAssistance.set(assistanceRequestId, {
        kind: (assistanceMsg.kind as string | undefined) || "assistance",
        owner_action: assistanceMsg.owner_action,
        progress_posture: assistanceMsg.progress_posture,
        response_contract: assistanceMsg.response_contract,
        stream: (assistanceMsg.stream as string | undefined) || null,
      });
      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: buildAssistanceRequestedDataFromMessage(assistanceMsg, runSource),
        event_type: "run.assistance_requested",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "started",
        stream_id: (assistanceMsg.stream as string | undefined) || null,
        trace_id: traceContext.trace_id,
      });
      // Durable structured attention upsert. Same secret-redaction
      // and non-secret-action-target rules as the INTERACTION path.
      // The writer declares its own subset shape of the ASSISTANCE
      // envelope; the validator above proved the fields it requires.
      await attentionWriter.recordAssistanceRequest(
        assistanceMsg as unknown as Parameters<typeof attentionWriter.recordAssistanceRequest>[0]
      );
      scheduleAssistanceTimeout(assistanceRequestId, assistanceMsg.timeout_seconds as number | null | undefined);
      onProgress(assistanceMsg);
    }

    async function handleStateMessage(msg: ConnectorMessage): Promise<void> {
      validateStateMessage(msg, scopeByStream);
      // Proven a non-empty, in-scope stream name by the validator above.
      const stateStream = msg.stream as string;

      // Flush records for this stream before persisting state
      await flushBatch(stateStream);
      // Transient manifest drift: this stream's batch was rejected as
      // not_found for a manifest-declared stream and recorded as a per-stream
      // gap. Do NOT stage its cursor — leaving it uncommitted makes the next
      // run re-collect the stream once the RS manifest row re-heals. Skipping
      // the `run.state_staged` event keeps the timeline honest (no advance).
      if (driftSkippedStreams.has(stateStream)) {
        return;
      }
      newState[stateStream] = msg.cursor;
      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          checkpoint_mode: "checkpointed_streaming",
          cursor: msg.cursor,
          grant_id: grantId,
          source: runSource,
          state_commit_intent: persistState ? "commit_on_success" : "do_not_persist",
          state_streams_staged: countStagedStateStreams(),
        },
        event_type: "run.state_staged",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "succeeded",
        stream_id: stateStream,
        trace_id: traceContext.trace_id,
      });
    }

    async function handleDoneMessage(msg: ConnectorMessage): Promise<void> {
      const invalidDoneStatus = validateDoneStatus(msg.status);
      if (invalidDoneStatus) {
        throw invalidDoneStatus;
      }
      const doneStatus = msg.status as DoneMessageState["status"];
      const normalizedDoneError = validateDoneError(doneStatus, msg.error as Parameters<typeof validateDoneError>[1]);
      if (normalizedDoneError instanceof Error) {
        throw normalizedDoneError;
      }
      finalStatus = doneStatus;
      doneMessage = {
        error: normalizedDoneError as ConnectorDoneError | null,
        records_emitted: msg.records_emitted as number,
        status: doneStatus,
      };

      if (msg.status === "succeeded") {
        // Flush any remaining records
        await flushAll();
      }
      // Close child stdin to signal that the runtime has finished
      // consuming DONE (and flushed all records for succeeded runs).
      // The connector's flushAndExit waits for this EOF before calling
      // process.exit(), closing the race where the connector exits while
      // buffered stdout bytes are still in transit through the kernel pipe.
      try {
        proc.stdin.end();
      } catch {
        // Closing stdin is best-effort after a terminal DONE message.
      }
    }

    async function recordTerminalDetailGap(
      outcome: Awaited<ReturnType<typeof maybeTerminateGap>>,
      msg: ConnectorMessage,
      gapStream: string,
      gapReason: string | null,
      gapParentStream: string | null,
      errorInfo: Parameters<typeof maybeTerminateGap>[2]
    ): Promise<boolean> {
      if (!(outcome.terminated && outcome.gap)) {
        return false;
      }
      durableDetailGaps.push(outcome.gap);
      appendKnownGap(
        buildKnownGap({
          kind: "detail_gap",
          message:
            "Required detail is permanently unavailable at the source (terminal); recovered everything still retrievable.",
          reason: gapReason,
          recoveryHint: "not_retriable",
          scope: {
            parent_stream: gapParentStream,
            record_key: isNullish(msg.record_key) ? null : String(msg.record_key),
          },
          stream: gapStream,
        })
      );
      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          gap_id: outcome.gap.gap_id,
          grant_id: grantId,
          reason: outcome.gap.reason,
          source: runSource,
          stream: outcome.gap.stream,
          terminal_reason: errorInfo ? classifyRecoveryError(errorInfo).reason : null,
        },
        event_type: "run.detail_gap_terminal",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "succeeded",
        stream_id: gapStream,
        trace_id: traceContext.trace_id,
      });
      return true;
    }

    async function recordQuarantinedDetailGap(
      outcome: Awaited<ReturnType<typeof maybeQuarantineGap>>,
      msg: ConnectorMessage,
      gapStream: string,
      gapParentStream: string | null
    ): Promise<boolean> {
      if (!(outcome.quarantined && outcome.gap)) {
        return false;
      }
      durableDetailGaps.push(outcome.gap);
      appendKnownGap(
        buildKnownGap({
          kind: "detail_gap",
          message: "Repeated no-progress on this item; quarantined for connector diagnosis (siblings keep recovering).",
          reason: "quarantined",
          recoveryHint: "not_retriable",
          scope: {
            parent_stream: gapParentStream,
            record_key: isNullish(msg.record_key) ? null : String(msg.record_key),
          },
          stream: gapStream,
        })
      );
      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          attempt_count: outcome.gap.attempt_count,
          gap_id: outcome.gap.gap_id,
          grant_id: grantId,
          reason: outcome.gap.reason,
          source: runSource,
          stream: outcome.gap.stream,
          terminal_reason: "quarantined",
        },
        event_type: "run.detail_gap_terminal",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "succeeded",
        stream_id: gapStream,
        trace_id: traceContext.trace_id,
      });
      return true;
    }

    async function settleDetailGapMessage(
      msg: ConnectorMessage,
      gapStream: string,
      gapReason: string | null,
      gapParentStream: string | null,
      gapLastError: { class?: string; http_status?: number } | null
    ): Promise<DurableDetailGap> {
      const leasedGap = findServedDetailGapLease(allServedGapLeases, msg);
      if (msg.lease_id && (!leasedGap || leasedGap.leaseId !== msg.lease_id)) {
        throw new Error("Connector re-deferred a detail gap without the current run-owned lease");
      }
      if (leasedGap && leasedGap.parentStream !== gapParentStream) {
        throw new Error("Connector re-deferred a detail gap under a different parent stream");
      }
      const gapInput = {
        connectorId,
        connectorInstanceId: normalizedConnectorInstanceId,
        detailLocator: msg.detail_locator ?? null,
        discoveredRunId: runId,
        grantId,
        lastError: gapLastError,
        lastRunId: runId,
        listCursor: msg.list_cursor ?? null,
        parentStream: gapParentStream,
        reason: gapReason,
        recordKey: msg.record_key ?? null,
        retryable: msg.retryable ?? null,
        scope: startScope,
        source: runSource,
        stream: gapStream,
      };
      const storedGap = leasedGap
        ? await detailGapStore.settleLeasedGapPending(leasedGap, gapInput)
        : await detailGapStore.upsertPendingGap(gapInput);
      if (!storedGap || (leasedGap && storedGap.lease_id === leasedGap.leaseId)) {
        throw new Error("Detail-gap re-deferral lease was lost before durable accounting");
      }
      if (leasedGap) {
        allServedGapLeases.delete(leasedGap.gapId);
      }
      return storedGap as DurableDetailGap;
    }

    async function recordPendingDetailGap(
      msg: ConnectorMessage,
      storedGap: DurableDetailGap,
      gapStream: string,
      gapReason: string | null,
      gapParentStream: string | null
    ): Promise<void> {
      durableDetailGaps.push(storedGap);
      const gap = buildKnownGap({
        kind: "detail_gap",
        message: "Required detail is recorded as a pending reference-only recovery gap.",
        reason: gapReason,
        recoveryHint: msg.retryable === false ? "not_retriable" : "retry_by_runtime",
        scope: {
          parent_stream: gapParentStream,
          record_key: isNullish(msg.record_key) ? null : String(msg.record_key),
        },
        stream: gapStream,
      });
      if (storedGap.status === "pending" || storedGap.status === "in_progress") {
        appendKnownGap(gap);
      }
      if (storedGap.discovered_run_id === runId && !detailGapRecordedThisRun.has(storedGap.gap_id)) {
        detailGapRecordedThisRun.add(storedGap.gap_id);
        await emitSpineEventTracked({
          actor_id: connectorId,
          actor_type: "runtime",
          data: {
            attempt_count: storedGap.attempt_count,
            detail_locator: storedGap.detail_locator,
            discovered_run_id: storedGap.discovered_run_id,
            gap_id: storedGap.gap_id,
            grant_id: grantId,
            known_gap: gap,
            last_error: storedGap.last_error,
            list_cursor: storedGap.list_cursor,
            parent_stream: storedGap.parent_stream,
            reason: storedGap.reason,
            record_key: storedGap.record_key,
            reference_only: true,
            source: runSource,
            status: storedGap.status,
            stream: storedGap.stream,
          },
          event_type: "run.detail_gap_recorded",
          object_id: runId,
          object_type: "run",
          run_id: runId,
          scenario_id: traceContext.scenario_id,
          status: "succeeded",
          stream_id: gapStream,
          trace_id: traceContext.trace_id,
        });
      }
      onProgress({ ...msg, gap_id: storedGap.gap_id });
    }

    async function maybeTerminalizeDetailGap(
      msg: ConnectorMessage,
      storedGap: DurableDetailGap,
      gapStream: string,
      gapReason: string | null,
      gapParentStream: string | null,
      gapLastError: { class?: string; http_status?: number } | null
    ): Promise<boolean> {
      const lastError = gapLastError ?? storedGap.last_error ?? null;
      const lastErrorProperties: object = { ...lastError };
      const httpStatus = Reflect.get(lastErrorProperties, "http_status");
      const errorClass = Reflect.get(lastErrorProperties, "class");
      const errorInfo = lastError
        ? {
            ...(typeof httpStatus === "number" ? { status: httpStatus } : {}),
            ...(typeof errorClass === "string" ? { errorClass } : {}),
          }
        : null;
      const outcome = await maybeTerminateGap(
        detailGapStore as unknown as Parameters<typeof maybeTerminateGap>[0],
        storedGap.gap_id,
        errorInfo,
        await resolveTerminalGapPolicy(connectorId)
      );
      return recordTerminalDetailGap(outcome, msg, gapStream, gapReason, gapParentStream, errorInfo);
    }

    async function maybeQuarantineDetailGap(
      msg: ConnectorMessage,
      storedGap: DurableDetailGap,
      gapStream: string,
      gapReason: string | null,
      gapLastError: { class?: string; http_status?: number } | null,
      gapParentStream: string | null
    ): Promise<boolean> {
      const redeferClass = classifyRecoveryGap({
        connector_id: connectorId,
        connector_instance_id: normalizedConnectorInstanceId,
        last_error: gapLastError ?? storedGap.last_error ?? null,
        reason: gapReason,
        stream: gapStream,
      }).recoveryClass;
      const eligible = !["run_cap_deferred", "provider_pressure", "owner_required", "informational"].includes(
        redeferClass
      );
      const outcome = eligible
        ? await maybeQuarantineGap(
            detailGapStore as unknown as Parameters<typeof maybeQuarantineGap>[0],
            storedGap.gap_id,
            {
              reason: gapReason,
              stream: gapStream,
              ...(gapLastError?.class ? { failure_class: String(gapLastError.class) } : {}),
            },
            DEFAULT_QUARANTINE_POLICY
          )
        : { gap: null, quarantined: false };
      return recordQuarantinedDetailGap(outcome, msg, gapStream, gapParentStream);
    }

    async function handleDetailGapMessage(msg: ConnectorMessage): Promise<void> {
      validateDetailGapMessage(msg, scopeByStream);
      // Proven by the validator: non-empty in-scope `stream`; the
      // remaining fields are optional and pass through as-is.
      const gapStream = msg.stream as string;
      const gapReason = (msg.reason as string | undefined) || null;
      const gapParentStream = (msg.parent_stream as string | undefined) || null;
      const gapLastError = (msg.last_error as { class?: string; http_status?: number } | null) ?? null;
      const storedGap = await settleDetailGapMessage(msg, gapStream, gapReason, gapParentStream, gapLastError);

      // §10-A: a gap that re-defers with a NON-TRANSIENT error (404/410/
      // permanent-403/401) and has exhausted its recovery budget transitions
      // to `terminal` — removed from the fillable-pending set (so it neither
      // re-arms the cooldown nor blocks convergence to 100%) but counted +
      // surfaced, never silently retried forever.
      //
      // `resolveTerminalGapPolicy` ALWAYS returns a real policy: the
      // explicit per-connector profile when registered, otherwise the safe
      // DEFAULT_TERMINAL_GAP_PROFILE. There is NO `if (profile)` null-skip
      // here — gap CREATION is connector-agnostic (this handler) so gap
      // TERMINALIZATION must be too. This is the seam that makes "a connector
      // emits a 404/410/permanent gap that can never go terminal" impossible
      // by construction (spec §10-A option (b) — GAP 1 + GAP 2).
      if (await maybeTerminalizeDetailGap(msg, storedGap, gapStream, gapReason, gapParentStream, gapLastError)) {
        return;
      }

      if (await maybeQuarantineDetailGap(msg, storedGap, gapStream, gapReason, gapLastError, gapParentStream)) {
        return;
      }

      await recordPendingDetailGap(msg, storedGap, gapStream, gapReason, gapParentStream);
    }

    async function handleDetailGapRecovered(msg: ConnectorMessage): Promise<void> {
      validateDetailGapRecoveredMessage(msg, scopeByStream);
      // Proven by the validator: non-empty gap_id and in-scope stream.
      const recoveredGapId = msg.gap_id as string;
      const recoveredStream = msg.stream as string;
      await flushAll();
      const lease = allServedGapLeases.get(recoveredGapId);
      if (msg.lease_id && (!lease || lease.leaseId !== msg.lease_id)) {
        throw new Error("Connector recovered a detail gap without the current run-owned lease");
      }
      const recoveredGap = lease
        ? await detailGapStore.settleLeasedGapRecovered(lease)
        : await detailGapStore.markGapStatus(recoveredGapId, "recovered", { runId });
      if (!recoveredGap || (lease && recoveredGap.lease_id === lease.leaseId)) {
        throw new Error("Detail-gap recovery lease was lost before durable accounting");
      }
      if (lease) {
        allServedGapLeases.delete(recoveredGapId);
      }
      durableDetailGaps.push(recoveredGap);
      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          gap_id: recoveredGap.gap_id,
          grant_id: grantId,
          record_key: recoveredGap.record_key,
          reference_only: true,
          source: runSource,
          status: recoveredGap.status,
          stream: recoveredGap.stream,
        },
        event_type: "run.detail_gap_recovered",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "succeeded",
        stream_id: recoveredStream,
        trace_id: traceContext.trace_id,
      });
      onProgress({ ...msg, status: "recovered" });
    }

    function validateRecordAdmission(
      stream: string,
      streamScope: StreamScope,
      manifestStream: ManifestStream | null,
      key: unknown,
      data: unknown
    ): void {
      if (!recordMatchesScopeResource(streamScope.resources, key, data, manifestStream)) {
        throw new Error(`Connector emitted RECORD outside declared resources for stream: ${stream}`);
      }
      if (Array.isArray(streamScope.fields) && data && typeof data === "object") {
        const requiredFields = new Set(manifestStream?.schema?.required || []);
        const allowedFields = new Set([...streamScope.fields, ...requiredFields]);
        const extraFields = Object.keys(data).filter((field) => !allowedFields.has(field));
        if (extraFields.length) {
          throw new Error(
            `Connector emitted RECORD with fields outside START.scope for stream '${stream}': ${extraFields.join(", ")}`
          );
        }
      }
      if (streamScope.time_range && data && typeof data === "object") {
        const consentTimeField = manifestStream?.consent_time_field || null;
        if (consentTimeField && !passesTimeRange(data, streamScope.time_range, consentTimeField)) {
          throw new Error(`Connector emitted RECORD outside declared time_range for stream: ${stream}`);
        }
      }
    }

    async function handleRecordMessage(msg: ConnectorMessage): Promise<void> {
      assertValidRecordEnvelope(msg);
      const { key, data, emitted_at, op } = msg;
      // The scope-membership check below is what proves `stream` is a
      // declared stream name; a non-string simply misses the map.
      const stream = msg.stream as string;
      const streamScope = scopeByStream.get(stream);
      if (!streamScope) {
        throw new Error(`Connector emitted RECORD for undeclared stream: ${stream}`);
      }

      const manifestStream = manifestByStream.get(stream) || null;
      validateRecordAdmission(stream, streamScope, manifestStream, key, data);

      let streamBatch = recordBatch[stream];
      if (!streamBatch) {
        streamBatch = [];
        recordBatch[stream] = streamBatch;
      }
      streamBatch.push({ data, emitted_at, key, op });
      totalEmitted += 1;
      emittedByStream.set(stream, (emittedByStream.get(stream) || 0) + 1);

      if (streamBatch.length >= BATCH_SIZE) {
        await flushBatch(stream);
      }
    }

    async function handleSkipResultMessage(msg: ConnectorMessage): Promise<void> {
      validateSkipResultMessage(msg, scopeByStream);
      // `stream` is optional on SKIP_RESULT; when present the validator
      // proved it is a non-empty, in-scope stream name.
      const skipStream = (msg.stream as string | undefined) || null;
      const skippedManifestStream = skipStream ? manifestByStream.get(skipStream) : null;
      if (skipStream && msg.reason === "stream_collection_failed") {
        streamCollectionFailedStreams.add(skipStream);
      }
      const continuation = msg.continuation ?? null;
      if (continuation !== null) {
        validateRuntimeContinuationFact(continuation);
      }
      const gap = buildKnownGap({
        continuation,
        diagnostics: msg.diagnostics ?? null,
        explicitSelection: Boolean(skipStream && explicitlyRequestedStreams?.has(skipStream)),
        kind: "skip_result",
        message: (msg.message as string | undefined) || null,
        reason: (msg.reason as string | undefined) || null,
        recoveryHint: msg.recovery_hint || null,
        scope: normalizeGapScope(msg),
        stream: skipStream,
        unsupportedInDefaultScope: streamUnsupportedInDefaultScope(skippedManifestStream),
      });
      appendKnownGap(gap);
      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          known_gap: gap,
          message: boundGapString(msg.message) || null,
          reason: (msg.reason as string | undefined) || null,
          source: runSource,
          stream: skipStream,
          ...(gap.diagnostics ? { diagnostics: gap.diagnostics } : {}),
        },
        event_type: "run.stream_skipped",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "skipped",
        stream_id: skipStream,
        trace_id: traceContext.trace_id,
      });
      onProgress(msg);
    }

    async function handleDetailGapsPageRequest(msg: ConnectorMessage): Promise<void> {
      // The validator declares its own subset shape of this envelope.
      const request = validateDetailGapsPageRequest(
        msg as unknown as Parameters<typeof validateDetailGapsPageRequest>[0],
        scopeByStream
      );
      const page = await readDetailGapPage({
        maxBytes: request.maxBytes,
        streams: request.streams ?? startScope.streams.map((stream) => stream.name),
      });
      const accepted = writeChildStdin(
        `${JSON.stringify({
          detail_gaps: page.detailGaps,
          reference_only: true,
          request_id: request.requestId,
          type: "DETAIL_GAPS_PAGE_RESPONSE",
        })}\n`,
        "detail_gaps_page_response"
      );
      onProgress({
        accepted,
        admission: page.admission,
        candidate_limit: page.candidateLimit,
        count: page.detailGaps.length,
        max_bytes: page.maxBytes,
        reference_only: true,
        serialized_bytes: page.serializedBytes,
        type: "DETAIL_GAPS_PAGE_RESPONSE",
      });
    }

    async function handleDetailGapAttempted(msg: ConnectorMessage): Promise<void> {
      validateDetailGapAttemptedMessage(msg, scopeByStream);
      const lease = allServedGapLeases.get(msg.gap_id as string);
      if (!lease || lease.leaseId !== msg.lease_id) {
        throw new Error("Connector attempted a detail gap without the current run-owned lease");
      }
      const attempted = await detailGapStore.markLeasedGapAttempt(lease);
      if (!attempted || attempted.lease_id !== lease.leaseId || attempted.lease_run_id !== lease.runId) {
        throw new Error("Detail-gap attempt lease was lost before durable accounting");
      }
      lease.attempted = true;
      onProgress({ ...msg, status: "attempted" });
    }

    async function waitForInteractionResponse(
      interaction: ConnectorMessage,
      interactionHandler: (message: ConnectorMessage) => unknown,
      requestId: string,
      timeoutSeconds: number | null | undefined,
      violation: Promise<InteractionResponse>
    ): Promise<InteractionResponse> {
      let timeoutHandle: NodeJS.Timeout | null = null;
      try {
        const responsePromise = Promise.resolve(
          interactionHandler(interaction) as InteractionResponse | Promise<InteractionResponse>
        ).catch(() => ({
          request_id: requestId,
          status: "cancelled",
          type: "INTERACTION_RESPONSE",
        }));
        const waitForResponse: Promise<InteractionResponse>[] = [responsePromise];
        if (Number.isFinite(timeoutSeconds) && (timeoutSeconds as number) > 0) {
          waitForResponse.push(
            new Promise<InteractionResponse>((resolveResponse) => {
              timeoutHandle = setTimeout(
                () =>
                  resolveResponse({
                    request_id: requestId,
                    status: "timeout",
                    type: "INTERACTION_RESPONSE",
                  }),
                (timeoutSeconds as number) * 1000
              );
            })
          );
        }
        waitForResponse.push(violation);
        return await Promise.race(waitForResponse);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    async function completeInteractionResponse(
      msg: ConnectorMessage,
      response: InteractionResponse,
      interactionRequestId: string,
      interactionStream: string | null
    ): Promise<void> {
      const responseStatus = response.status || "success";
      if (response.type !== "INTERACTION_RESPONSE" || response.request_id !== interactionRequestId) {
        throw new Error("Interaction handler returned an invalid INTERACTION_RESPONSE envelope");
      }
      if (!["success", "cancelled", "timeout"].includes(responseStatus)) {
        throw new Error(`Invalid INTERACTION_RESPONSE status: ${responseStatus}`);
      }
      if (responseStatus === "timeout" && typeof onInteractionTerminal === "function") {
        await onInteractionTerminal({ interactionId: interactionRequestId, status: responseStatus });
      }
      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: { kind: msg.kind, source: runSource, status: responseStatus, stream: interactionStream },
        event_type: "run.interaction_completed",
        interaction_id: interactionRequestId,
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: responseStatus,
        trace_id: traceContext.trace_id,
      });
      await attentionWriter.resolveByRequestId(msg.request_id as string, responseStatus);
      const assistanceEventType = assistanceResolutionEventType(responseStatus);
      if (assistanceEventType) {
        await emitSpineEventTracked({
          actor_id: connectorId,
          actor_type: "runtime",
          data: {
            assistance_request_id: interactionRequestId,
            kind: msg.kind,
            source: runSource,
            status: responseStatus,
            stream: interactionStream,
          },
          event_type: assistanceEventType,
          interaction_id: interactionRequestId,
          object_id: runId,
          object_type: "run",
          run_id: runId,
          scenario_id: traceContext.scenario_id,
          status: responseStatus,
          trace_id: traceContext.trace_id,
        });
      }
      recordInteractionRecoveryGap(msg, responseStatus, interactionStream);
      pendingInteraction = null;
      if (!writeChildStdin(`${JSON.stringify({ ...response, status: responseStatus })}\n`, "interaction_response")) {
        onProgress({ phase: "interaction_response", reason: childStdinClosedReason, type: "connector_stdin_closed" });
      }
      pendingInteractionViolationReject = null;
    }

    function recordInteractionRecoveryGap(
      msg: ConnectorMessage,
      responseStatus: string,
      interactionStream: string | null
    ): void {
      if (responseStatus === "success") {
        return;
      }
      const interactionRecoveryHint =
        msg.kind === "manual_action" || msg.kind === "otp" ? "manual_action_required" : "refresh_credentials";
      appendKnownGap(
        buildKnownGap({
          interactionKind: (msg.kind as string | undefined) || null,
          kind: "interaction_required",
          message: (msg.message as string | undefined) || null,
          reason: `interaction_${responseStatus}`,
          recoveryHint: interactionRecoveryHint,
          stream: interactionStream,
        })
      );
    }

    async function handleInteractionMessage(msg: ConnectorMessage): Promise<void> {
      validateInteractionMessage(msg, scopeByStream);
      // Proven by the validator: `request_id` is a non-empty string,
      // `kind` is one of the three known kinds, and `timeout_seconds`
      // (when present) is a positive finite number.
      const interactionRequestId = msg.request_id as string;
      const interactionTimeoutSeconds = msg.timeout_seconds as number | null | undefined;
      const interactionStream = (msg.stream as string | undefined) || null;
      if (typeof onInteraction !== "function") {
        throw new Error("Connector emitted INTERACTION but START.bindings omitted interactive");
      }
      if (pendingInteraction) {
        // Protocol violation
        terminateChild();
        throw new Error("Connector emitted INTERACTION while already waiting");
      }
      pendingInteraction = msg;
      const pendingInteractionViolation = new Promise<InteractionResponse>((_, rejectWaiting) => {
        pendingInteractionViolationReject = rejectWaiting;
      });
      pendingInteractionViolation.catch(() => {
        // The protocol violation is observed by the owning queue.
      });

      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          kind: msg.kind,
          message: msg.message,
          source: runSource,
          stream: interactionStream,
          ...(isNullish(msg.schema) ? {} : { schema: msg.schema }),
          ...(isNullish(msg.timeout_seconds) ? {} : { timeout_seconds: msg.timeout_seconds }),
        },
        event_type: "run.interaction_required",
        interaction_id: interactionRequestId,
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "started",
        trace_id: traceContext.trace_id,
      });

      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: buildAssistanceRequestedDataFromInteraction(msg, runSource, {
          browserSurfaceAvailable: hasBrowserSurfaceLaunchEnv(browserSurfaceLaunchEnv),
        }),
        event_type: "run.assistance_requested",
        interaction_id: interactionRequestId,
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "started",
        trace_id: traceContext.trace_id,
      });

      // Durable structured attention upsert. The interaction is now
      // a real owner-action prompt; the dashboard projection should
      // surface it via `next_action.source === "structured"`.
      // The writer declares its own subset shape of the INTERACTION
      // envelope (kind/request_id/stream/timeout_seconds).
      await attentionWriter.recordInteractionRequest(
        msg as unknown as Parameters<typeof attentionWriter.recordInteractionRequest>[0]
      );

      const response = await waitForInteractionResponse(
        msg,
        onInteraction,
        interactionRequestId,
        interactionTimeoutSeconds,
        pendingInteractionViolation
      );

      await completeInteractionResponse(msg, response, interactionRequestId, interactionStream);
    }

    async function handleAssistanceStatusMessage(msg: ConnectorMessage): Promise<void> {
      validateAssistanceStatusMessage(msg);
      const closed = await closeStructuredAssistance(msg.assistance_request_id as string, msg.status as string, {
        ...(isNullish(msg.message) ? {} : { message: msg.message }),
      });
      if (!closed) {
        throw new Error(
          `Connector emitted ASSISTANCE_STATUS for unknown assistance_request_id: ${msg.assistance_request_id}`
        );
      }
      onProgress(msg);
    }

    async function handleProgressMessage(msg: ConnectorMessage): Promise<void> {
      validateProgressMessage(msg, scopeByStream);
      await emitSpineEventTracked({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          message: (msg.message as string | undefined) || null,
          source: runSource,
          stream: (msg.stream as string | undefined) || null,
          ...(isNullish(msg.count) ? {} : { count: msg.count }),
          ...(isNullish(msg.total) ? {} : { total: msg.total }),
          ...(isNullish(msg.provider_budget) ? {} : { provider_budget: msg.provider_budget }),
          ...(isNullish(msg.collection_rate) ? {} : { collection_rate: msg.collection_rate }),
          ...(isNullish(msg.attachment_recovery_outcome)
            ? {}
            : { attachment_recovery_outcome: msg.attachment_recovery_outcome }),
          ...(isNullish(msg.attachment_hydration_failure_outcome)
            ? {}
            : { attachment_hydration_failure_outcome: msg.attachment_hydration_failure_outcome }),
        },
        event_type: "run.progress_reported",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "in_progress",
        stream_id: (msg.stream as string | null | undefined) || null,
        trace_id: traceContext.trace_id,
      });
      if (!isNullish(msg.collection_rate)) {
        lastSeenCollectionRate = msg.collection_rate;
      }
      onProgress(msg);
    }

    const protocolHandlers: Record<string, (msg: ConnectorMessage) => Promise<void>> = {
      ASSISTANCE: handleAssistanceMessage,
      ASSISTANCE_STATUS: handleAssistanceStatusMessage,
      DETAIL_COVERAGE: handleDetailCoverageMessage,
      DETAIL_GAP: handleDetailGapMessage,
      DETAIL_GAP_ATTEMPTED: handleDetailGapAttempted,
      DETAIL_GAP_RECOVERED: handleDetailGapRecovered,
      DETAIL_GAPS_PAGE_REQUEST: handleDetailGapsPageRequest,
      DONE: handleDoneMessage,
      INTERACTION: handleInteractionMessage,
      PROGRESS: handleProgressMessage,
      RECORD: handleRecordMessage,
      SKIP_RESULT: handleSkipResultMessage,
      STATE: handleStateMessage,
    };

    async function handleMsg(msg: ConnectorMessage): Promise<void> {
      if (doneMessage) {
        if (msg.type === "__PARSE_ERROR__") {
          throw new Error(`Connector emitted invalid JSONL after DONE: ${msg.error}`);
        }
        throw new Error(`Connector emitted ${msg.type} after DONE`);
      }

      const handler = msg.type ? protocolHandlers[msg.type] : undefined;
      if (handler) {
        await handler(msg);
        return;
      }
      if (msg.type === "__PARSE_ERROR__") {
        throw new Error(`Connector emitted invalid JSONL: ${msg.error}`);
      }
      throw new Error(`Connector emitted unknown message type: ${msg.type}`);
    }

    rl.on("line", (line) => {
      writeTrace(line);
      if (!line.trim()) {
        return;
      }
      try {
        const msg = JSON.parse(line);
        if (failPendingInteraction(new Error(`Connector emitted ${msg.type} while waiting for INTERACTION_RESPONSE`))) {
          return;
        }
        msgQueue.push(msg);
        processNext().catch(reject);
      } catch (caught) {
        const err = caught as RuntimeRunError;
        if (
          failPendingInteraction(
            new Error(`Connector emitted invalid JSONL while waiting for INTERACTION_RESPONSE: ${err.message}`)
          )
        ) {
          return;
        }
        // Context for debugging: include byte length and a preview of the
        // offending line in the error message.
        const preview =
          line.length > 400
            ? `${line.slice(0, 200)} … [truncated ${line.length - 400} chars] … ${line.slice(-200)}`
            : line;
        const enriched = `${err.message} (line_length=${line.length} preview=${JSON.stringify(preview).slice(0, 600)})`;
        msgQueue.push({
          error: enriched,
          type: "__PARSE_ERROR__",
        });
        processNext().catch(reject);
      }
    });

    async function recordRunTimedOutTerminal(code: number | null): Promise<void> {
      const terminalReason = runtimeTimeoutReason || "run_timed_out";
      const assistanceStatus = terminalReason === "assistance_timed_out" ? "timeout" : "cancelled";
      const failureMessage = runTimeoutFailureMessage(terminalReason);
      finalStatus = "failed";
      await closeOpenStructuredAssistance(assistanceStatus, { reason: terminalReason });
      await emitRunSpineEvent({
        actor_id: connectorId,
        actor_type: "runtime",
        data: buildRunTerminalData({
          connectorError: null,
          exitCode: code,
          failureMessage,
          failureOrigin: "runtime",
          reason: terminalReason,
          recordsEmitted: totalEmitted,
        }),
        event_type: "run.failed",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "failed",
        trace_id: traceContext.trace_id,
      });
      onProgress({
        exit_code: code,
        reason: terminalReason,
        records_emitted: totalEmitted,
        status: "failed",
        type: "done",
      });
    }

    async function failDoneTerminalValidation({
      error,
      code,
      connectorError,
      recordsEmitted,
      reportedRecordsEmitted,
      includeReportedRecordsEmitted,
    }: {
      error: RuntimeRunError;
      code: number | null;
      connectorError: ConnectorDoneError | null;
      recordsEmitted: number;
      reportedRecordsEmitted: number;
      includeReportedRecordsEmitted: boolean;
    }): Promise<void> {
      finalStatus = "failed";
      const failureReason = classifyRuntimeFailure(error);
      error.run_id = runId;
      error.trace_id = traceContext.trace_id;
      error.failure_reason = failureReason;
      error.checkpoint_summary = buildCheckpointSummary();
      error.terminal_reason = failureReason;
      error.connector_error = connectorError;
      error.known_gaps = buildKnownGapsForTerminal(failureReason, connectorError);
      error.records_emitted = recordsEmitted;
      error.reported_records_emitted = reportedRecordsEmitted;

      await closeOpenStructuredAssistance("cancelled", { reason: failureReason });
      await emitRunSpineEvent({
        actor_id: connectorId,
        actor_type: "runtime",
        data: buildRunTerminalData({
          connectorError,
          exitCode: code,
          reason: failureReason,
          recordsEmitted,
          ...(includeReportedRecordsEmitted ? { reportedRecordsEmitted } : {}),
        }),
        event_type: "run.failed",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "failed",
        trace_id: traceContext.trace_id,
      });
      terminalEventRecorded = true;
      onProgress({
        exit_code: code,
        reason: failureReason,
        records_emitted: recordsEmitted,
        ...(includeReportedRecordsEmitted ? { reported_records_emitted: reportedRecordsEmitted } : {}),
        status: "failed",
        type: "done",
      });
      await rejectAfterLeaseAccounting(error);
    }

    function effectiveDoneStatus(doneStatus: DoneMessageState["status"]): DoneMessageState["status"] {
      return ownerCancelRequested ? "cancelled" : doneStatus;
    }

    function doneTerminalEventType(
      status: DoneMessageState["status"]
    ): "run.cancelled" | "run.completed" | "run.failed" {
      if (status === "succeeded") {
        return "run.completed";
      }
      if (status === "cancelled" && ownerCancelRequested) {
        return "run.cancelled";
      }
      return "run.failed";
    }

    function doneTerminalReason(status: DoneMessageState["status"]): string | null {
      if (status === "failed") {
        return "connector_reported_failed";
      }
      if (status === "cancelled") {
        return ownerCancelRequested ? "owner_cancelled" : "connector_reported_cancelled";
      }
      return null;
    }

    async function handleDoneClose(code: number | null): Promise<boolean> {
      const done = doneMessage;
      if (!done) {
        return false;
      }
      const exitCodeMismatch = validateDoneExitCode(done as Parameters<typeof validateDoneExitCode>[0], code as number);
      if (exitCodeMismatch) {
        await failDoneTerminalValidation({
          code,
          connectorError: done.error,
          error: exitCodeMismatch as RuntimeRunError,
          includeReportedRecordsEmitted: false,
          recordsEmitted: done.records_emitted,
          reportedRecordsEmitted: done.records_emitted,
        });
        return true;
      }

      const recordsEmittedMismatch = validateDoneRecordsEmitted(
        done as Parameters<typeof validateDoneRecordsEmitted>[0],
        totalEmitted
      );
      if (recordsEmittedMismatch) {
        await failDoneTerminalValidation({
          code,
          connectorError: done.error,
          error: recordsEmittedMismatch as RuntimeRunError,
          includeReportedRecordsEmitted: true,
          recordsEmitted: totalEmitted,
          reportedRecordsEmitted: done.records_emitted,
        });
        return true;
      }

      // Durable lease accounting is a completion postcondition, not
      // background cleanup. If it fails (or an explicit attempt lacks a
      // settlement), the run must fail before state commit and terminal
      // success evidence are emitted.
      cleanupChildHandles();
      await awaitLeaseAccounting();

      const terminalStatus = effectiveDoneStatus(done.status);
      finalStatus = terminalStatus;
      const isCertifiedStreamCollectionFailure =
        done.status === "failed" &&
        done.error?.code === "stream_collection_failed" &&
        streamCollectionFailedStreams.size > 0;

      if (persistState && (terminalStatus === "succeeded" || isCertifiedStreamCollectionFailure)) {
        // Unproven coverage withholds only its own state_stream's cursor; every
        // other stream still commits, and the run stays successful with the
        // shortfall reported as a known gap.
        const coverageShortfallStateStreams = await recordDetailCoverageShortfalls();
        if (done.status === "succeeded") {
          // Unproven coverage withholds only its own state_stream's cursor; every
          // other stream still commits, and the run stays successful with the
          // shortfall reported as a known gap.
          await Object.entries(newState)
            .filter(([stream]) => !coverageShortfallStateStreams.has(stream))
            .reduce(
              (previous, [stream, cursor]) => previous.then(() => commitState(stream, cursor)),
              Promise.resolve()
            );
        } else {
          // A failed DONE is normally a global failure: the run's state map is
          // unproven and nothing commits (the else-branch this replaces for
          // every other failed/cancelled/crashed/protocol-mismatched close).
          // The one exception the runtime can verify structurally: the
          // connector certified the failure as stream-scoped by (a) declaring
          // DONE.error.code === "stream_collection_failed" AND (b) emitting at
          // least one in-scope SKIP_RESULT{reason:"stream_collection_failed"}
          // naming the specific stream(s) that failed. Only those named
          // streams' cursors are withheld; every other staged stream reached
          // its own terminal STATE with no reported failure and is provably
          // safe to commit. A DONE claiming this code with zero matching
          // SKIP_RESULT (streamCollectionFailedStreams.size === 0) is not
          // structurally certified and falls through to the fail-closed
          // default — never trust the code string alone.
          //
          // SKIP_RESULT.stream names a DATA stream, but `newState`/`commitState`
          // are keyed by STATE_STREAM (the checkpoint's own key), which a
          // manifest may declare as a distinct parent key shared by several
          // data streams (`stream.state_stream`, see buildManifestStateStreamMap).
          // Mapping the failed DATA stream straight through as if it were the
          // STATE_STREAM key would filter nothing (no match in newState) and
          // falsely commit the parent checkpoint a failed CHILD stream shares
          // with untouched siblings. `resolveStateStreamsForDataStream` resolves
          // from the manifest's static declaration ONLY (`state_stream`, or the
          // full declared `parent_streams` set) — never from live DETAIL_COVERAGE,
          // which can only select/report within the declared set and must never
          // widen or override it (see "Precedence between manifest and run-time
          // evidence"). Using the full declared set here, not just the parents
          // that happened to report live this run, is deliberately conservative:
          // a failed stream's live evidence is inherently incomplete, so every
          // declared parent is a candidate to withhold.
          const failedStateStreams = new Set(
            Array.from(streamCollectionFailedStreams).flatMap((stream) => [...resolveStateStreamsForDataStream(stream)])
          );
          await Object.entries(newState)
            .filter(
              ([stateStream]) =>
                !(failedStateStreams.has(stateStream) || coverageShortfallStateStreams.has(stateStream))
            )
            .reduce(
              (previous, [stateStream, cursor]) => previous.then(() => commitState(stateStream, cursor)),
              Promise.resolve()
            );
        }
      }
      const assistanceStatus = terminalStatus === "succeeded" ? "resolved" : "cancelled";
      const assistanceReason =
        terminalStatus === "succeeded" ? "run_completed" : (doneTerminalReason(terminalStatus) ?? "run_cancelled");
      await closeOpenStructuredAssistance(assistanceStatus, { reason: assistanceReason });
      const terminalEventReason = doneTerminalReason(terminalStatus);
      await emitRunSpineEvent({
        actor_id: connectorId,
        actor_type: "runtime",
        data: buildRunTerminalData({
          connectorError: done.error,
          reason: terminalEventReason,
          recordsEmitted: done.records_emitted,
        }),
        event_type: doneTerminalEventType(terminalStatus),
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: terminalStatus,
        trace_id: traceContext.trace_id,
      });
      onProgress({ records_emitted: done.records_emitted, status: terminalStatus, type: "done" });
      return false;
    }

    async function handleOwnerCancellationClose(code: number | null): Promise<void> {
      // The owner cancelled this run and the connector child exited without
      // DONE. Keep this intentional stop distinct from connector failure.
      finalStatus = "cancelled";
      const cancelReason = ownerCancelForced ? "owner_cancel_forced" : "owner_cancelled";
      await closeOpenStructuredAssistance("cancelled", { reason: cancelReason });
      await emitRunSpineEvent({
        actor_id: connectorId,
        actor_type: "owner",
        data: buildRunTerminalData({
          connectorError: null,
          exitCode: code,
          reason: cancelReason,
          recordsEmitted: totalEmitted,
        }),
        event_type: "run.cancelled",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "cancelled",
        trace_id: traceContext.trace_id,
      });
      onProgress({
        exit_code: code,
        reason: cancelReason,
        records_emitted: totalEmitted,
        status: "cancelled",
        type: "done",
      });
    }

    async function handleConnectorExitClose(
      code: number | null,
      stderrTailDiagnostic: Record<string, unknown> | null
    ): Promise<void> {
      const { reason: closeFailureReason, phase: closeFailurePhase } = deriveTerminalReason({
        childStdinClosedAtPhase,
        childStdinClosedReason,
        doneMessage: null,
        finalStatus: "failed",
      });
      const closeFailureMessage = buildConnectorExitFailureMessage({
        code,
        phase: closeFailurePhase,
        reason: closeFailureReason,
      });
      const connectorDiagnostics = stderrTailDiagnostic ? { stderr_tail: stderrTailDiagnostic } : null;
      await closeOpenStructuredAssistance("cancelled", { reason: closeFailureReason });
      await emitRunSpineEvent({
        actor_id: connectorId,
        actor_type: "runtime",
        data: buildRunTerminalData({
          connectorDiagnostics,
          connectorError: null,
          exitCode: code,
          failureMessage: closeFailureMessage,
          failureOrigin: "connector",
          reason: closeFailureReason,
          recordsEmitted: totalEmitted,
          stdinClosedAtPhase: closeFailurePhase,
        }),
        event_type: "run.failed",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "failed",
        trace_id: traceContext.trace_id,
      });
      onProgress({
        exit_code: code,
        reason: closeFailureReason,
        records_emitted: totalEmitted,
        status: "failed",
        type: "done",
        ...(closeFailureReason === "connector_stdin_closed" ? { stdin_closed_at_phase: closeFailurePhase } : {}),
      });
    }

    function deriveClosedRunResolution(code: number | null): {
      reason: string | null;
      phase: string | null;
      failureMessage: string | null;
    } {
      const derivedTerminal = deriveTerminalReason({
        childStdinClosedAtPhase,
        childStdinClosedReason,
        doneMessage,
        finalStatus,
      });
      // Owner cancellation resolves with its intentional stop reason rather
      // than the generic derived reason.
      let closeTerminalReason = derivedTerminal.reason;
      if (runTimedOut) {
        closeTerminalReason = runtimeTimeoutReason || "run_timed_out";
      } else if (finalStatus === "cancelled" && ownerCancelRequested) {
        closeTerminalReason = ownerCancelForced ? "owner_cancel_forced" : "owner_cancelled";
      }
      const closeTerminalPhase = derivedTerminal.phase;
      const exposeConnectorExitDiagnostic = finalStatus === "failed" && !doneMessage;
      // A scheduler/assistance timeout gets its OWN specific message (matching
      // exactly what recordRunTimedOutTerminal already put on the terminal
      // spine event) rather than falling through to the generic
      // "Connector exited with code N before emitting DONE." — accurate but
      // uninformative about WHY, and the whole reason this resolved value
      // exists is so run_history.failure_reason can name the real cause
      // without a separate spine lookup.
      let resolvedFailureMessage: string | null = null;
      if (runTimedOut) {
        resolvedFailureMessage = runTimeoutFailureMessage(runtimeTimeoutReason || "run_timed_out");
      } else if (exposeConnectorExitDiagnostic) {
        resolvedFailureMessage = buildConnectorExitFailureMessage({
          code,
          phase: closeTerminalPhase,
          reason: closeTerminalReason,
        });
      }
      return { failureMessage: resolvedFailureMessage, phase: closeTerminalPhase, reason: closeTerminalReason };
    }

    function buildClosedRunResult({
      code,
      stderrTailDiagnostic,
      resolution,
    }: {
      code: number | null;
      stderrTailDiagnostic: Record<string, unknown> | null;
      resolution: { reason: string | null; phase: string | null; failureMessage: string | null };
    }): RuntimeRunConnectorResult {
      const exposeConnectorExitDiagnostic = finalStatus === "failed" && !doneMessage;
      return {
        checkpoint_summary: buildCheckpointSummary(),
        detail_gaps: durableDetailGaps.map((gap) => ({
          gap_id: gap.gap_id,
          reason: gap.reason ?? null,
          status: gap.status ?? null,
          stream: gap.stream ?? null,
        })),
        exit_code: code,
        known_gaps: buildKnownGapsForTerminal(resolution.reason, doneMessage?.error || null),
        ...buildIngestAccountingFields(),
        records_emitted: totalEmitted,
        run_id: runId,
        state: newState,
        status: finalStatus,
        terminal_reason: resolution.reason,
        trace_id: traceContext.trace_id,
        ...(triggerKind ? { trigger_kind: triggerKind } : {}),
        ...(automationMode ? { automation_mode: automationMode } : {}),
        ...(resolution.reason === "connector_stdin_closed" ? { stdin_closed_at_phase: resolution.phase } : {}),
        connector_error: doneMessage?.error || null,
        ...(exposeConnectorExitDiagnostic
          ? {
              failure_message: resolution.failureMessage,
              // A runtime-side timeout (scheduler wall-clock or assistance)
              // is a runtime-authored failure, not a connector-exit failure —
              // the process is still alive until terminateChild() kills it in
              // response to the watchdog, not because the connector itself
              // exited. Mislabeling this "connector" would misdirect an
              // owner reading run_history toward the connector when the
              // real cause is the runtime's own timeout policy.
              failure_origin: runTimedOut ? "runtime" : "connector",
              ...(stderrTailDiagnostic ? { connector_diagnostics: { stderr_tail: stderrTailDiagnostic } } : {}),
            }
          : {}),
      } as unknown as RuntimeRunConnectorResult;
    }

    async function resolveClosedRun(
      code: number | null,
      stderrTailDiagnostic: Record<string, unknown> | null
    ): Promise<void> {
      cleanupChildHandles();
      await awaitLeaseAccounting();
      const resolution = deriveClosedRunResolution(code);
      resolve(buildClosedRunResult({ code, resolution, stderrTailDiagnostic }));
    }

    async function handleCloseFailure(code: number | null, caught: unknown): Promise<void> {
      const err = caught as RuntimeRunError;
      finalStatus = "failed";
      const failureReason = classifyRuntimeFailure(err);
      err.run_id = runId;
      err.trace_id = traceContext.trace_id;
      err.failure_reason = failureReason;
      err.checkpoint_summary = buildCheckpointSummary();
      err.terminal_reason = failureReason;
      err.connector_error = doneMessage?.error || null;
      err.known_gaps = buildKnownGapsForTerminal(failureReason, doneMessage?.error || null);
      err.records_emitted = totalEmitted;
      if (doneMessage) {
        err.reported_records_emitted = doneMessage.records_emitted;
      }
      const runtimeFailureMessage = runtimeAuthoredFailureMessage(err, doneMessage?.error);

      if (!terminalEventRecorded) {
        try {
          await closeOpenStructuredAssistance("cancelled", { reason: failureReason });
          await emitRunSpineEvent({
            actor_id: connectorId,
            actor_type: "runtime",
            data: buildRunTerminalData({
              connectorError: doneMessage?.error || null,
              exitCode: code,
              failureMessage: runtimeFailureMessage,
              failureOrigin: runtimeFailureMessage ? "runtime" : null,
              ingestFailure: err.ingest_failure || null,
              reason: failureReason,
              recordsEmitted: doneMessage ? doneMessage.records_emitted : totalEmitted,
            }),
            event_type: "run.failed",
            object_id: runId,
            object_type: "run",
            run_id: runId,
            scenario_id: traceContext.scenario_id,
            status: "failed",
            trace_id: traceContext.trace_id,
          });
          terminalEventRecorded = true;
        } catch (caughtEmitErr) {
          const emitErr = caughtEmitErr as Error;
          onProgress({ error: emitErr.message, type: "spine_error" });
        }
      }

      onProgress({
        exit_code: code,
        reason: failureReason,
        records_emitted: doneMessage ? doneMessage.records_emitted : totalEmitted,
        status: "failed",
        type: "done",
      });
      await rejectAfterLeaseAccounting(err);
    }

    childTerminalEvent
      .then(async (terminalEvent) => {
        if (terminalEvent.kind === "error") {
          await rejectAfterLeaseAccounting(terminalEvent.error);
          return;
        }
        const { code } = terminalEvent;
        clearTerminateTimer();
        const stderrTailRaw = stderrTail.finalize();
        // Connector stderr is untrusted; redact recognized secret markers
        // before it reaches progress OR the retained diagnostic — progress is
        // not a lower-trust sink than the retained evidence, so it gets the
        // same treatment.
        if (stderrTailRaw.text) {
          onProgress({ text: redactStderrTail(stderrTailRaw.text).text, type: "stderr" });
        }
        const stderrTailDiagnostic = buildStderrTailDiagnostic(stderrTailRaw);

        try {
          await waitForQueueDrain();
          if (!terminalEventRecorded) {
            if (runTimedOut) {
              await recordRunTimedOutTerminal(code);
            } else if (ownerCancelRequested) {
              await handleOwnerCancellationClose(code);
            } else if (doneMessage) {
              if (await handleDoneClose(code)) {
                return;
              }
            } else {
              await handleConnectorExitClose(code, stderrTailDiagnostic);
            }
            terminalEventRecorded = true;
          }
          await resolveClosedRun(code, stderrTailDiagnostic);
        } catch (caught) {
          await handleCloseFailure(code, caught);
        }
      })
      .catch((error: unknown) => reject(error));
  });
}

/**
 * Default interaction handler — prompts via stdin/stdout of the runtime process itself
 */
async function defaultInteractionHandler(interaction: ConnectorMessage): Promise<InteractionResponse> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });

  process.stderr.write(`\n[INTERACTION] ${interaction.message}\n`);
  process.stderr.write(`Kind: ${interaction.kind}\n`);

  const schema =
    (interaction.schema as { properties?: Record<string, InteractionSchemaProperty> } | null | undefined)?.properties ||
    {};

  const data: Record<string, string> = {};
  const schemaEntries = Object.entries(schema);
  const readField = async (index: number): Promise<void> => {
    if (index >= schemaEntries.length) {
      return;
    }
    const entry = schemaEntries[index];
    if (!entry) {
      return;
    }
    const [field, def] = entry;
    const answer = await new Promise<string>((resolve) => {
      const prompt = def.format === "password" ? `${field} (hidden): ` : `${field}: `;
      rl.question(prompt, resolve);
    });
    data[field] = answer;
    await readField(index + 1);
  };
  await readField(0);

  rl.close();

  return {
    data,
    request_id: interaction.request_id as string,
    status: "success",
    type: "INTERACTION_RESPONSE",
  };
}

/**
 * Load sync state from the RS for a connector
 */
/**
 * Load prior sync state for a connector from the RS.
 *
 * Accepts either:
 *   (connectorId, ownerToken, { rsUrl?, grantId?, connectorInstanceId? })
 *                                                       — legacy positional
 *   ({ connectorId, ownerToken, rsUrl?, grantId?, connectorInstanceId? })
 *                                                       — object form (what
 *                                                       all current callers
 *                                                       actually use)
 *
 * Both are accepted because the positional signature was the original shape
 * but the object form is what the orchestrate CLI and src/orchestrator.js
 * have been passing for months. When the signatures drifted, state loading
 * silently returned null for every connector — incremental sync looked like
 * it worked (RS dedup hides the damage) but was actually full-refresh every
 * run. Normalize on the object form going forward; keep positional for any
 * external callers that may exist.
 */
export async function loadSyncState(
  connectorIdOrOpts: string | LoadSyncStateObject,
  ownerToken?: string,
  opts: LoadSyncStateOptions = {}
): Promise<Record<string, unknown> | null> {
  let connectorId: string;
  let token: string | undefined;
  let o: LoadSyncStateOptions;
  if (typeof connectorIdOrOpts === "object") {
    ({ connectorId, ownerToken: token } = connectorIdOrOpts);
    o = connectorIdOrOpts;
  } else {
    connectorId = connectorIdOrOpts;
    token = ownerToken;
    o = opts;
  }
  const rsUrl = o.rsUrl || process.env.RS_URL || "http://localhost:7663";
  const connectorInstanceId = optionalNonEmptyEnv(o.connectorInstanceId);
  connectorId = canonicalConnectorKey(connectorId) ?? connectorId;
  const stateUrl = new URL(`/v1/state/${encodeURIComponent(connectorId)}`, rsUrl);
  if (connectorInstanceId) {
    stateUrl.searchParams.set("connector_instance_id", connectorInstanceId);
  }
  if (o.grantId) {
    stateUrl.searchParams.set("grant_id", o.grantId);
  }
  const url = stateUrl.toString();
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    // Drain before discarding: an abandoned error body leaves undici's parser
    // holding buffered data, which is the state that turns a later socket
    // teardown into the unguarded `assert(!this.paused)` crash in
    // `Parser.finish`. See runtime/undici-parser-errors.ts.
    await resp.text().catch(() => "");
    return null;
  }
  const body = (await resp.json()) as { state?: Record<string, unknown> | null };
  return body.state || null;
}
