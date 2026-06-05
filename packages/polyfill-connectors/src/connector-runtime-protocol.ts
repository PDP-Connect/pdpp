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
  detail_gaps?: readonly DetailGapStartEntry[];
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
  record_key?: string | number | null;
  reference_only?: true;
  status: "pending";
  stream: string;
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
  last_error?: {
    class?: string;
    http_status?: number;
    message?: string;
    network_pressure?: DetailGapNetworkPressure;
  };
  list_cursor?: unknown;
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
  gap_keys?: Array<string | number>;
  hydrated_keys: Array<string | number>;
  optional_skip_keys?: Array<string | number>;
  reference_only: true;
  required_keys: Array<string | number>;
  state_stream: string;
  stream: string;
  type: "DETAIL_COVERAGE";
}

export interface DetailGapRecoveredMessage {
  gap_id: string;
  record_key?: string | number;
  reference_only: true;
  stream: string;
  type: "DETAIL_GAP_RECOVERED";
}

/** All messages a connector emits over stdout. */
export type EmittedMessage =
  | {
      type: "RECORD";
      stream: string;
      key: string | number;
      data: RecordData;
      emitted_at: string;
      op?: "delete";
    }
  | { type: "STATE"; stream: string; cursor: unknown }
  | { type: "PROGRESS"; message: string; stream?: string }
  | ({ type: "ASSISTANCE" } & AssistanceRequest)
  | ({ type: "ASSISTANCE_STATUS" } & AssistanceCompletion)
  | {
      type: "SKIP_RESULT";
      stream: string;
      reason: string;
      message: string;
      diagnostics?: unknown;
    }
  | DetailGapMessage
  | DetailCoverageMessage
  | DetailGapRecoveredMessage
  | {
      type: "DONE";
      status: "succeeded" | "failed";
      records_emitted: number;
      error?: { message: string; retryable: boolean };
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

export type ValidateRecord = (
  stream: string,
  data: RecordData
) => { ok: true; data: RecordData } | { ok: false; issues: Array<{ path: string; message: string }> };
