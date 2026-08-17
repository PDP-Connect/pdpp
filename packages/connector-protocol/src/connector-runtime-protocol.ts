// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol message types for the PDPP connector runtime.
 *
 * This module is the no-Playwright slice of `connector-runtime.ts`. It owns
 * the START/RECORD/STATE/SKIP_RESULT/PROGRESS/DETAIL_GAP/DONE message shapes
 * so the local collector runner, the device-exporter ingest envelope, the
 * scope filters, and filesystem-class connectors can import them without
 * pulling the browser-bound full runtime.
 *
 * `connector-runtime.ts` re-exports every type from this file so existing
 * import sites keep working. New runner-side code SHOULD import from this
 * module directly.
 *
 * Boundary: this file MUST NOT import `playwright`, `patchright`, or any
 * other browser/runtime-only dependency, even as `import type`. The published
 * `@pdpp/local-collector` build runs a grep gate against the artifact to
 * enforce that invariant.
 */

// ─── Protocol message shapes ────────────────────────────────────────────

/** A single record passing through emit / emitRecord. */
export interface RecordData {
  id?: string | number | null;
  [field: string]: unknown;
}

export interface StreamScope {
  name: string;
  resources?: readonly string[];
  time_range?: {
    since?: string;
    until?: string;
  };
  [extra: string]: unknown;
}

export interface StartMessage {
  /**
   * RI's own full-refresh-vs-incremental intent for this run, already sent on
   * the wire today (`reference-implementation/runtime/index.ts` START build)
   * but never previously parsed on the connector-runtime side. `"full_refresh"`
   * is an explicit owner/operator signal that a connector's own incremental
   * bookkeeping (checkpoints, anchors, frontiers) should be bypassed for this
   * run and the source walked to its natural end — the connector-local repair
   * path for state that only a full re-walk can recover (e.g. a mutable field
   * that changed further back than any per-record change-detection window
   * would otherwise re-visit). Absent is treated as `"incremental"` for
   * backward compatibility with connectors/tests that predate this field.
   */
  collection_mode?: "full_refresh" | "incremental";
  detail_gaps?: readonly DetailGapStartEntry[];
  /**
   * SLVP-ideal §4.3 recovery-only launch mode. When true, the connector drains
   * pending non-source-pressure detail gaps and MUST NOT perform the forward
   * walk or new list-phase fetches — the source-pressure cooldown is deferring
   * new source-touching work. Absent/false = an ordinary full run.
   */
  recovery_only?: boolean;
  scope: { streams: readonly StreamScope[] };
  state?: Record<string, unknown>;
  streamsToBackfill?: readonly string[];
  type: "START";
}

export interface DetailGapStartEntry {
  detail_locator?: {
    kind?: string;
    [field: string]: unknown;
  } | null;
  gap_id: string;
  /** Opaque, run-owned token required when settling a served recovery lease. */
  lease_id?: string;
  /** Checkpoint-owning parent retained from the durable gap, when declared. */
  parent_stream?: string | null;
  record_key?: string | number | null;
  reference_only?: true;
  status: "pending";
  stream: string;
}

export interface DetailGapsPageRequestMessage {
  max_bytes?: number;
  reference_only: true;
  request_id: string;
  streams?: readonly string[];
  type: "DETAIL_GAPS_PAGE_REQUEST";
}

export interface DetailGapsPageResponse {
  detail_gaps: readonly DetailGapStartEntry[];
  reference_only: true;
  request_id: string;
  type: "DETAIL_GAPS_PAGE_RESPONSE";
}

export interface InteractionResponse {
  data?: Record<string, string>;
  error?: { message: string };
  request_id: string;
  status: "success" | "cancelled" | "error";
  type: "INTERACTION_RESPONSE";
  value?: string;
}

export type InteractionKind = "credentials" | "otp" | "manual_action";

export type AssistanceProgressPosture = "running" | "blocked" | "waiting_retry";
export type AssistanceOwnerAction = "none" | "act_elsewhere" | "provide_value" | "operate_attachment";
export type AssistanceResponseContract = "none";
export type AssistanceSensitivity = "none" | "non_secret" | "secret";
export type AssistanceAttachmentKind = "browser_surface" | "url" | "qr" | "file" | "fixture";
export type AssistanceCompletionStatus = "cancelled" | "escalated" | "resolved" | "timed_out";

export interface AssistanceAttachment {
  kind: AssistanceAttachmentKind;
  label?: string;
  ref?: string;
  role?: string;
}

export interface AssistanceRequest {
  assistance_request_id?: string;
  attachments?: AssistanceAttachment[];
  input_schema?: Record<string, unknown>;
  message: string;
  owner_action: AssistanceOwnerAction;
  progress_posture: AssistanceProgressPosture;
  response_contract: AssistanceResponseContract;
  sensitivity?: AssistanceSensitivity;
  timeout_seconds?: number;
}

export interface AssistanceCompletion {
  assistance_request_id: string;
  message?: string;
  status: AssistanceCompletionStatus;
}

/**
 * Pre-redacted source-pressure diagnostic carried on a `DETAIL_GAP`'s `detail`
 * and `last_error`. It MUST carry only safe, bounded fields (endpoint route,
 * method, error class, optional status/retry-after metadata) — never bearer tokens,
 * cookies, secret-bearing URLs, request bodies, or raw payloads. The
 * attempt/max-attempt budget is internal and SHOULD be stripped before the gap
 * is deferred (see the connector source-pressure defer paths).
 */
export interface DetailGapNetworkPressure {
  attempt?: number;
  endpoint_route: string;
  error_class: string;
  max_attempts?: number;
  method: string;
  retry_after_ms?: number;
  safe_headers?: Record<string, string | number>;
  status?: number;
}

export interface DetailGapMessage {
  detail?: {
    class?: string;
    http_status?: number;
    network_pressure?: DetailGapNetworkPressure;
  };
  detail_locator: {
    kind: string;
    [field: string]: string | number | boolean | null | Record<string, string | number | boolean | null>;
  };
  gap_id?: string;
  last_error?: {
    class?: string;
    http_status?: number;
    message?: string;
    network_pressure?: DetailGapNetworkPressure;
  };
  lease_id?: string;
  list_cursor?: unknown;
  /** Checkpoint-owning parent stream; must match DETAIL_COVERAGE.state_stream. */
  parent_stream?: string;
  reason: "rate_limited" | "retry_exhausted" | "temporary_unavailable" | "upstream_pressure";
  record_key: string | number;
  reference_only: true;
  retryable: true;
  status: "pending";
  stream: string;
  type: "DETAIL_GAP";
}

export interface DetailCoverageMessage {
  /**
   * Optional connector-declared `considered` denominator: how many items the run
   * weighed for this stream (an inventory size, or the boundary the run took into
   * account). The runtime normalizes it to a trusted safe non-negative integer or
   * `unknown` (task 2.1) and prefers it over the `required_keys.length` fallback
   * when deriving the per-stream collection-fact `considered`. It is evidence
   * only and is NEVER inferred from the collected count — a list stream that
   * enumerated its boundary may declare it with empty key arrays.
   */
  considered?: number;
  /**
   * Optional connector-declared `covered` count: how many of the `considered`
   * in-boundary items the run actually accounted for — the items it emitted plus
   * the items it deliberately suppressed because they were unchanged (a full-sync
   * stream gated by a per-record fingerprint). The runtime normalizes it to a
   * trusted safe non-negative integer or `unknown` and, when present, the
   * control-plane projection compares `considered` against it instead of the
   * collected count, so a steady-state run that suppressed every unchanged record
   * reads `complete` rather than a false `partial`. It MUST be measured at the
   * enumeration site from objective per-record outcomes and MUST NOT count an item
   * the run weighed but dropped (a malformed record, a filtered-out item) — a
   * dropped item is in neither the collected nor the covered count, so it still
   * reads `partial`. NEVER inferred from the collected count.
   */
  covered?: number;
  gap_keys?: Array<string | number>;
  hydrated_keys: Array<string | number>;
  /**
   * Required keys accepted by an explicit optional-detail policy. A provider
   * failure belongs here only after connector-specific evidence establishes a
   * terminal unavailable object; status, age, or retry exhaustion alone do not.
   */
  optional_skip_keys?: Array<string | number>;
  reference_only: true;
  required_keys: Array<string | number>;
  state_stream: string;
  stream: string;
  type: "DETAIL_COVERAGE";
}

export interface RuntimeContinuationFact {
  boundary: string;
  considered: number;
  covered: number;
  owner: "runtime";
  remaining: true;
  slice_end: number;
  slice_start: number;
}

export function optionalContinuationField(value: unknown): {
  continuation?: RuntimeContinuationFact;
} {
  return value ? { continuation: value as RuntimeContinuationFact } : {};
}

export function validateRuntimeContinuationFact(value: unknown): asserts value is RuntimeContinuationFact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Connector emitted invalid SKIP_RESULT.continuation");
  }
  const fact = value as Record<string, unknown>;
  if (
    ![
      typeof fact.boundary === "string" && Boolean(fact.boundary.trim()),
      Number.isSafeInteger(fact.considered) && (fact.considered as number) >= 0,
      Number.isSafeInteger(fact.covered) && (fact.covered as number) >= 0,
      fact.owner === "runtime",
      fact.remaining === true,
      Number.isSafeInteger(fact.slice_start) && (fact.slice_start as number) >= 0,
      Number.isSafeInteger(fact.slice_end) && (fact.slice_end as number) >= (fact.slice_start as number),
    ].every(Boolean)
  ) {
    throw new Error("Connector emitted invalid SKIP_RESULT.continuation");
  }
}

export function readRuntimeContinuationFact(value: unknown): RuntimeContinuationFact | undefined {
  return isRuntimeContinuationFact(value) ? value : undefined;
}

function isRuntimeContinuationFact(value: unknown): value is RuntimeContinuationFact {
  try {
    validateRuntimeContinuationFact(value);
    return true;
  } catch {
    return false;
  }
}

export function selectAuthoritativeContinuation<T extends { kind?: string; stream?: string; continuation?: unknown }>(
  gaps: readonly T[],
  stream: string
): T | undefined {
  const latest = selectAuthoritativeSkip(gaps, stream);
  return latest && readRuntimeContinuationFact(latest.continuation) !== undefined ? latest : undefined;
}

export function selectAuthoritativeSkip<T extends { kind?: string; stream?: string; continuation?: unknown }>(
  gaps: readonly T[],
  stream: string
): T | undefined {
  return gaps.findLast((candidate) => candidate.kind === "skip_result" && candidate.stream === stream);
}

export function readOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function optionalTextField(key: string, value: unknown): Record<string, string> {
  const text = readOptionalText(value);
  return text ? { [key]: text } : {};
}

export function projectRuntimeSkip(gap: { reason?: string; recovery_hint?: unknown; continuation?: unknown }): {
  reason: string;
  continuation?: RuntimeContinuationFact;
  recovery_action?: string;
} {
  const action =
    gap.recovery_hint && typeof gap.recovery_hint === "object"
      ? (gap.recovery_hint as { action?: string }).action
      : undefined;
  return {
    reason: gap.reason ?? "unknown",
    ...optionalContinuationField(gap.continuation),
    ...(action ? { recovery_action: action } : {}),
  };
}

export function optionalRuntimeScopeFields(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    ...optionalTextField("collection_scope", entry.collection_scope),
    ...(typeof entry.scoped === "boolean" ? { scoped: entry.scoped } : {}),
  };
}

export function readRuntimeSkipFact(value: unknown): {
  reason: string;
  continuation?: RuntimeContinuationFact;
  recovery_action?: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const skip = value as Record<string, unknown>;
  if (typeof skip.reason !== "string") {
    return null;
  }
  const continuation = readRuntimeContinuationFact(skip.continuation);
  const recoveryAction = typeof skip.recovery_action === "string" ? skip.recovery_action : undefined;
  return {
    reason: skip.reason,
    ...(continuation ? { continuation } : {}),
    ...(recoveryAction ? { recovery_action: recoveryAction } : {}),
  };
}

export interface DetailGapRecoveredMessage {
  gap_id: string;
  lease_id?: string;
  record_key?: string | number;
  reference_only: true;
  stream: string;
  type: "DETAIL_GAP_RECOVERED";
}

export interface DetailGapAttemptedMessage {
  gap_id: string;
  lease_id: string;
  reference_only: true;
  stream: string;
  type: "DETAIL_GAP_ATTEMPTED";
}

export interface ProviderBudgetProgress {
  circuit: {
    previous_state: "closed" | "half_open" | "open";
    reason: "provider_failure" | "provider_throttle" | "reset_timeout" | "success";
    state: "closed" | "half_open" | "open";
    trigger: "before_request" | "provider_failure" | "provider_throttle" | "success";
  };
  elapsed_ms: number;
  object: "provider_budget_circuit_transition";
  request_count: number;
  retry_tokens_remaining?: number | "unbounded";
}

/**
 * Operator-legible snapshot of the adaptive collection rate controller's live
 * state, emitted as redacted run-trace progress so an operator can watch the
 * controller speed up and back off. Carries NO account/conversation content —
 * only rate numbers and the back-off reason (SLVP ideal §5: legibility).
 */
export interface CollectionRateProgress {
  /** The rate ceiling: fastest interval (ms) the controller may reach. */
  ceiling_interval_ms: number;
  /** Effective ceiling rate (requests/min) — the cap the probe never crosses. */
  ceiling_rate_per_min: number;
  /** Current learned inter-request interval (ms). */
  current_interval_ms: number;
  /** Current effective rate (requests/min) = 60000 / current_interval_ms. */
  effective_rate_per_min: number;
  /** Most recent back-off, or null when none has fired this run. */
  last_backoff: {
    at_interval_ms: number;
    reason: "retry_after" | "throttle";
  } | null;
  object: "collection_rate";
}

/**
 * Aggregate-only outcome of Gmail's bounded served attachment-gap recovery
 * lane. This is emitted on the lane's existing terminal PROGRESS summary;
 * it carries no record identity, locator, provider identity, content, or
 * error text.
 */
export interface AttachmentRecoveryOutcomeProgress {
  admitted: number;
  admitted_bytes: number;
  attempted: number;
  hydration_failed: number;
  lookup_miss: number;
  metadata_lookups: number;
  object: "attachment_recovery_outcome";
  recovered: number;
  run_cap_deferred: number;
  served: number;
}

/**
 * Aggregate-only failure-stage evidence for Gmail served attachment recovery.
 * This intentionally excludes item identity, provider responses, and raw
 * status values so the terminal progress event remains safe to persist.
 */
export interface AttachmentHydrationFailureOutcomeProgress {
  blob_upload_http_4xx: number;
  blob_upload_http_5xx: number;
  blob_upload_integrity_failed: number;
  blob_upload_invalid_response: number;
  blob_upload_transport_failed: number;
  imap_download_failed: number;
  object: "attachment_hydration_failure_outcome";
  /** A failed hydration with no honest typed boundary classification. */
  unclassified_failed: number;
}

export interface ProgressExtra {
  attachment_hydration_failure_outcome?: AttachmentHydrationFailureOutcomeProgress;
  attachment_recovery_outcome?: AttachmentRecoveryOutcomeProgress;
  count?: number;
  stream?: string;
  total?: number;
}

/** All messages a connector emits over stdout. */
export type EmittedMessage =
  | {
      type: "RECORD";
      stream: string;
      /**
       * Primary key value: non-empty string, or non-empty string[] for
       * compound keys (spec-core.md "The RECORD envelope"). A scalar
       * `number` is never valid on the wire — connectors MUST stringify
       * before emitting.
       */
      key: string | readonly string[];
      data: RecordData;
      emitted_at: string;
      op?: "delete";
    }
  | { type: "STATE"; stream: string; cursor: unknown }
  | {
      type: "PROGRESS";
      message: string;
      count?: number;
      stream?: string;
      total?: number;
      attachment_hydration_failure_outcome?: AttachmentHydrationFailureOutcomeProgress;
      attachment_recovery_outcome?: AttachmentRecoveryOutcomeProgress;
      provider_budget?: ProviderBudgetProgress;
      collection_rate?: CollectionRateProgress;
    }
  | ({ type: "ASSISTANCE" } & AssistanceRequest)
  | ({ type: "ASSISTANCE_STATUS" } & AssistanceCompletion)
  | {
      type: "SKIP_RESULT";
      stream: string;
      reason: string;
      message: string;
      diagnostics?: unknown;
      continuation?: RuntimeContinuationFact;
      recovery_hint?: string | { action: string; retryable?: boolean };
    }
  | DetailGapMessage
  | DetailGapAttemptedMessage
  | DetailCoverageMessage
  | DetailGapRecoveredMessage
  | DetailGapsPageRequestMessage
  | {
      type: "DONE";
      status: "succeeded" | "failed";
      records_emitted: number;
      error?: {
        code?: string;
        message: string;
        recovery_hint?: string | { action: string; retryable?: boolean };
        retryable: boolean;
      };
    }
  | {
      type: "INTERACTION";
      request_id: string;
      kind: InteractionKind;
      message: string;
      schema?: Record<string, unknown>;
      timeout_seconds?: number;
    };

/** Body shape passed to sendInteraction (type + request_id are filled by the runtime). */
export interface InteractionRequest {
  kind: InteractionKind;
  message: string;
  request_id?: string;
  schema?: Record<string, unknown>;
  timeout_seconds?: number;
}

// ─── Shape-check validator ──────────────────────────────────────────────

/**
 * A field whose value the schema did not model, on a record that is otherwise
 * structurally sound. Reported alongside `ok: true` so the record still emits
 * with its unrecognized value intact while the drift stays visible — see
 * `makeValidateRecord` (schema-registry.ts) for the policy that raises these.
 */
export interface ShapeAnomaly {
  /** The values the schema does model, for the diagnostic reader. */
  expected: readonly unknown[];
  /** Dot-joined path to the field, e.g. `attachments.0.type`. */
  path: string;
  /** The unrecognized value, verbatim, exactly as the source sent it. */
  value: unknown;
}

export type ValidateRecord = (
  stream: string,
  data: RecordData
) =>
  | { ok: true; data: RecordData; anomalies?: readonly ShapeAnomaly[] }
  | { ok: false; issues: Array<{ path: string; message: string }> };
