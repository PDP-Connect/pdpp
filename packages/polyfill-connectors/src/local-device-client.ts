// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { canonicalTerminalRunCommitEnvelope } from "@pdpp/reference-contract/common";
import { COLLECTOR_PROTOCOL_HEADER, COLLECTOR_PROTOCOL_VERSION } from "./collector-protocol.ts";
import { retryAfterMsFromHeaders } from "./http-retry.ts";
import { hashCanonicalJson, type LocalDeviceIngestBatchRequest } from "./local-device-envelope.ts";

export const LOCAL_DEVICE_ENDPOINTS = {
  exchangeEnrollment: "/_ref/device-exporters/enroll",
  heartbeat: (deviceId: string) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/heartbeat`,
  selfRevoke: (deviceId: string) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/self-revoke`,
  ingestBatch: (deviceId: string) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/ingest-batches`,
  terminalCollection: (deviceId: string, sourceInstanceId: string) =>
    `/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/terminal-collection`,
  terminalRunCommit: (deviceId: string, sourceInstanceId: string) =>
    `/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/terminal-run-commits`,
  localCollectorGap: (deviceId: string, sourceInstanceId: string) =>
    `/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/local-collector-gaps`,
  localCollectorGapRecovered: (deviceId: string, sourceInstanceId: string) =>
    `/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/local-collector-gaps/recovered`,
  sourceInstanceState: (deviceId: string, sourceInstanceId: string) =>
    `/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/state`,
} as const;

export interface LocalDeviceClientOptions {
  baseUrl: string;
  deviceId?: string;
  deviceToken?: string;
  fetchImpl?: typeof fetch;
  /**
   * Hard per-request ceiling in milliseconds. A reference server that
   * stalls mid-request (for example during a projection rebuild) would
   * otherwise hang `fetch` indefinitely, pinning the collector process
   * until the host supervisor's start-timeout reaps it. Bounding the
   * request makes a stalled call fail fast and *durably*: a hung drain
   * row is marked retryable/dead-lettered by the outbox path exactly like
   * any other send failure, and a hung state read surfaces an honest
   * `state_read_failed` block instead of a silent 15-minute timeout.
   *
   * Defaults to {@link DEFAULT_LOCAL_DEVICE_REQUEST_TIMEOUT_MS}, which is
   * well under the documented systemd `TimeoutStartSec=900`. Pass `0` to
   * disable the ceiling (the caller then owns liveness via its own signal).
   */
  requestTimeoutMs?: number;
}

/**
 * Default hard per-request timeout for {@link LocalDeviceClient}.
 *
 * 120s is generous enough for a large ingest batch under recovery load
 * yet far below the host supervisor's 15-minute start timeout, so a
 * stalled server fails the run fast — durably, since the outbox keeps the
 * work — rather than holding a process slot and blocking the next
 * scheduled drain. See `docs/reference/local-collector.md` and
 * `systemd-durable-limits.test.js` for the `TimeoutStartSec=900` posture.
 */
export const DEFAULT_LOCAL_DEVICE_REQUEST_TIMEOUT_MS = 120_000;

export interface EnrollmentExchangeRequest {
  /**
   * Optional narrowing-only scope request. `undefined` (the default) sends
   * no field at all — "no preference," letting the server's own declared
   * boundary or honest recent-history default apply. An explicit `null` asks
   * for a full pass. See `reference-implementation/server/
   * enrollment-scope-narrowing.ts`: the server is the sole authority on the
   * EFFECTIVE scope; this can only narrow what it already declared, never
   * widen it.
   */
  collection_scope?: { since?: string; source_roots?: string[] } | null;
  device_label?: string;
  enrollment_code: string;
}

export interface EnrollmentExchangeResponse {
  connector_id: string;
  device_id: string;
  device_token: string;
  local_binding_name: string;
  source_instance_id: string;
}

/**
 * Optional granular durable-outbox diagnostics carried alongside a
 * heartbeat. Reference-only and additive: counts/timestamps only, no
 * local paths, payloads, cookies, or auth material.
 */
export interface HeartbeatOutboxDiagnostics {
  backlog_open?: number;
  dead_letter: number;
  leased: number;
  oldest_pending_at?: string | null;
  /**
   * `MIN(created_at)` over `ready` rows that have actually failed at least
   * once (`attempt_count > 0`). Distinct from `oldest_pending_at`, which
   * also includes a freshly-enqueued, never-failed row (e.g. a large
   * healthy first drain) that must not be mistaken for a stuck retry.
   * `null`/absent when nothing in the backlog has ever failed.
   */
  oldest_retrying_at?: string | null;
  pending: number;
  retrying: number;
  stale_leases: number;
  succeeded: number;
  total: number;
}

/**
 * Optional redacted "why" carried alongside a heartbeat. The reference
 * server already accepts and re-sanitizes `last_error` on a heartbeat
 * source instance (it persists to `last_error_json`, which the dashboard
 * reads), so this lets the control plane answer "why did these block /
 * dead-letter?" without host-local spelunking. Reference-only and additive:
 * stable error classes and counts, never payloads, paths, tokens, cookies,
 * or auth material.
 */
export interface HeartbeatLastError {
  /** Discriminates the stall shape so the dashboard can pick remediation. */
  kind: "state_read_failed" | "dead_letter_backlog" | "terminal_run_commit_unacknowledged";
  /** Top redacted dead-letter error classes (present for backlog stalls). */
  top_dead_letter_classes?: { count: number; error_class: string }[];
}

export interface HeartbeatRequest {
  /**
   * Build-derived agent version of the running collector (e.g.
   * `0.0.0+43f63825f01a`, or `0.0.0+source` for an unbuilt run). Optional and
   * additive: the reference server already accepts this field on the heartbeat
   * wire schema and persists it to `device_exporters.agent_version` via a
   * COALESCE update, so an absent value preserves the last stored one. Carries
   * only a version string and a short revision token — never a path or secret.
   * See `collector-build-info.ts`.
   */
  agent_version?: string;
  connector_id: string;
  last_error?: HeartbeatLastError | null;
  outbox?: HeartbeatOutboxDiagnostics;
  records_pending?: number;
  source_instance_id: string;
  status: "starting" | "healthy" | "retrying" | "blocked" | "stopped";
}

export type IngestBatchRequest = LocalDeviceIngestBatchRequest;

/** Safe, terminal per-stream evidence. Deliberately excludes paths, payloads, and reasons. */
export interface TerminalCollectionRequest {
  /**
   * Fingerprint of the boundary this evidence was measured against (`unscoped`
   * for a full pass — an absence would be indistinguishable from an old
   * collector that never reported one). Coverage is only ever proof of the
   * region it was measured in, so the region travels WITH the proof rather than
   * being looked up beside it.
   */
  collection_scope?: string;
  connector_id: string;
  run_id: string;
  source_instance_id: string;
  streams: readonly TerminalCollectionFact[];
}

export interface TerminalCollectionFact {
  coverage_statuses: readonly string[];
  /**
   * Whether the declared boundary was enforceable on this stream. `false` marks
   * a stream collected WHOLE because its manifest declares no time field: it
   * holds real data but proves nothing about the declared bound, so it must not
   * be read as covering it.
   */
  scoped?: boolean;
  stream: string;
}

/** Durable terminal checkpoint and evidence envelope (local outbox schema v3). */
export interface TerminalRunCommitRequest {
  collection_boundary: string;
  commit_id: string;
  connector_id: string;
  connector_instance_id: string;
  device_id: string;
  run_id: string;
  source_instance_id: string;
  state_delta: Record<string, unknown>;
  terminal_facts: readonly TerminalCollectionFact[];
  version: 1;
}

export interface TerminalRunCommitResponse {
  commit_id: string;
  envelope_hash: string;
  object: "device_terminal_run_commit";
  run_id: string;
  terminal_event_id: string;
}

export interface GetSourceInstanceStateRequest {
  sourceInstanceId: string;
}

export interface PutSourceInstanceStateRequest {
  sourceInstanceId: string;
  state: Record<string, unknown>;
}

export interface SourceInstanceStateResponse {
  connector_instance_id: string;
  device_id: string;
  object: "device_source_instance_state";
  source_instance_id: string;
  state: Record<string, unknown>;
  updated_at: string | null;
}

/**
 * Acknowledge a runner-knowable gap (queue-depth deferral, connector
 * child crash, etc.) to the reference server. The route is keyed by the
 * enrolled device's source instance; the server validates that
 * `connector_id` matches the source-instance binding before recording
 * the gap in `connector_detail_gaps`. Idempotent: the same
 * (connector_id, source_instance_id, reason, stream, stream_boundary)
 * upserts one row.
 */
export interface AckLocalCollectorGapRequest {
  connector_id: string;
  details?: string;
  first_seen_at: string;
  first_seen_run_id?: string;
  last_run_id?: string;
  next_attempt_backoff_ms: number;
  reason: "policy_budget" | "connector_child_failure";
  retryable: boolean;
  source_instance_id: string;
  stream?: string;
  stream_boundary?: string;
}

export interface AckLocalCollectorGapResponse {
  attempt_count: number;
  connector_id: string;
  connector_instance_id: string;
  device_id: string;
  first_seen_at: string | null;
  first_seen_run_id: string | null;
  gap_id: string;
  last_run_id: string | null;
  object: "device_local_collector_gap";
  reason: "policy_budget" | "connector_child_failure";
  retryable: boolean;
  source_instance_id: string;
  status: string;
  stream: string;
  updated_at: string | null;
}

export interface RecoverLocalCollectorGapRequest {
  connector_id: string;
  reason: "policy_budget" | "connector_child_failure";
  recovered_run_id?: string;
  source_instance_id: string;
  stream?: string;
  stream_boundary?: string;
}

export interface SelfRevokeDeviceResponse {
  device_id: string;
  object: "device_exporter_revocation";
  revoked_at: string;
}

export class LocalDeviceHttpError extends Error {
  readonly body: string;
  readonly envelopeMessage: string | null;
  readonly param: string | null;
  readonly status: number;
  /**
   * Typed PDPP error code parsed from the response body when the server
   * returned a structured `{ error: { code, ... } }` envelope. Lets
   * callers and operator-facing CLI output discriminate cases like
   * `collector_protocol_mismatch` from a generic 409 without re-parsing
   * the body. `null` when the body is empty, not JSON, or lacks an
   * `error.code` field.
   */
  readonly code: string | null;
  /**
   * Server-declared retry delay in milliseconds, parsed structurally from
   * the response's `Retry-After` header (seconds or HTTP-date form) via
   * {@link retryAfterMsFromHeaders} — never parsed out of prose. `null`
   * when the header was absent or unparseable. An explicit `Retry-After`
   * is an authoritative signal from the server (see
   * `ref-device-exporters.ts`'s `device_ingest_retryable` envelope) and
   * lets the durable-outbox retry path honor the server's own timing
   * instead of guessing via linear backoff.
   */
  readonly retryAfterMs: number | null;

  constructor(status: number, body: string, retryAfterMs: number | null = null) {
    const parsed = parseLocalDeviceErrorEnvelope(body);
    const detail = formatLocalDeviceErrorDetail(parsed);
    super(`local device request failed: ${status}${detail}`);
    this.name = "LocalDeviceHttpError";
    this.status = status;
    this.body = body;
    this.code = parsed?.code ?? null;
    this.param = parsed?.param ?? null;
    this.envelopeMessage = parsed?.message ?? null;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseLocalDeviceErrorEnvelope(
  body: string
): { code: string; message: string | null; param: string | null } | null {
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    const envelope = parsed as { error?: { code?: unknown; message?: unknown; param?: unknown } } | null;
    if (envelope && typeof envelope === "object" && envelope.error && typeof envelope.error.code === "string") {
      return {
        code: envelope.error.code,
        message: typeof envelope.error.message === "string" ? sanitizeErrorDetail(envelope.error.message) : null,
        param: typeof envelope.error.param === "string" ? sanitizeErrorDetail(envelope.error.param) : null,
      };
    }
  } catch {
    // Body wasn't JSON. Fall through to null.
  }
  return null;
}

function formatLocalDeviceErrorDetail(
  parsed: { code: string; message: string | null; param: string | null } | null
): string {
  if (!parsed) {
    return "";
  }
  const parts = [parsed.code];
  if (parsed.param) {
    parts.push(`param=${parsed.param}`);
  }
  if (parsed.message) {
    parts.push(`message=${parsed.message}`);
  }
  return ` ${parts.join(" ")}`;
}

const ERROR_DETAIL_SECRET_RE =
  /\b(authorization|bearer|token|password|passwd|cookie|secret|otp|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s}]+/gi;

function sanitizeErrorDetail(value: string): string {
  const compact = value.replace(ERROR_DETAIL_SECRET_RE, "$1=[REDACTED]").replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 159)}…` : compact;
}

/**
 * A local-device request exceeded its hard timeout (the server stalled
 * before responding). Distinct from {@link LocalDeviceHttpError}: there is
 * no HTTP status because the response never arrived. Carried through the
 * outbox failure path like any other transient send error so the work
 * stays durable and retryable instead of crashing the run.
 */
export class LocalDeviceRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`local device request timed out after ${timeoutMs}ms`);
    this.name = "LocalDeviceRequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** A 2xx response whose receipt does not acknowledge the submitted durable item. */
export class LocalDeviceReceiptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDeviceReceiptValidationError";
  }
}

export class LocalDeviceClient {
  readonly #baseUrl: URL;
  readonly #deviceId: string | undefined;
  readonly #deviceToken: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(options: LocalDeviceClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#deviceId = options.deviceId;
    this.#deviceToken = options.deviceToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LOCAL_DEVICE_REQUEST_TIMEOUT_MS;
  }

  exchangeEnrollment(request: EnrollmentExchangeRequest): Promise<EnrollmentExchangeResponse> {
    return this.#request(LOCAL_DEVICE_ENDPOINTS.exchangeEnrollment, {
      authenticate: false,
      body: request,
      method: "POST",
    });
  }

  heartbeat(request: HeartbeatRequest): Promise<{ ok: true }> {
    return this.#request(LOCAL_DEVICE_ENDPOINTS.heartbeat(this.#requireDeviceId()), {
      authenticate: true,
      body: request,
      method: "POST",
    });
  }

  /**
   * Revoke this device's own credential using its own bearer token. A
   * device may only revoke itself — the server rejects any deviceId that
   * does not match the authenticated credential. Called by `logout` before
   * deleting local credentials so the server-side lane closes with them.
   */
  selfRevoke(): Promise<SelfRevokeDeviceResponse> {
    return this.#request(LOCAL_DEVICE_ENDPOINTS.selfRevoke(this.#requireDeviceId()), {
      authenticate: true,
      method: "POST",
    });
  }

  ingestBatch(request: IngestBatchRequest): Promise<{ ok: true }> {
    return this.#request(LOCAL_DEVICE_ENDPOINTS.ingestBatch(this.#requireDeviceId()), {
      authenticate: true,
      body: request,
      method: "POST",
    });
  }

  reportTerminalCollection(request: TerminalCollectionRequest): Promise<{ ok: true }> {
    return this.#request(
      LOCAL_DEVICE_ENDPOINTS.terminalCollection(this.#requireDeviceId(), request.source_instance_id),
      { authenticate: true, body: request, method: "POST" }
    );
  }

  commitTerminalRun(request: TerminalRunCommitRequest): Promise<TerminalRunCommitResponse> {
    return this.#request<TerminalRunCommitResponse>(
      LOCAL_DEVICE_ENDPOINTS.terminalRunCommit(this.#requireDeviceId(), request.source_instance_id),
      { authenticate: true, body: request, method: "POST" }
    ).then((response) => {
      const expectedHash = hashCanonicalJson(canonicalTerminalRunCommitEnvelope(request));
      if (
        response?.object !== "device_terminal_run_commit" ||
        response.commit_id !== request.commit_id ||
        response.run_id !== request.run_id ||
        response.envelope_hash !== expectedHash ||
        typeof response.terminal_event_id !== "string" ||
        response.terminal_event_id.length === 0
      ) {
        throw new LocalDeviceReceiptValidationError(
          "terminal run commit response did not match the submitted envelope"
        );
      }
      return response;
    });
  }

  getSourceInstanceState(request: GetSourceInstanceStateRequest): Promise<SourceInstanceStateResponse> {
    const path = LOCAL_DEVICE_ENDPOINTS.sourceInstanceState(this.#requireDeviceId(), request.sourceInstanceId);
    return this.#request(path, { authenticate: true, method: "GET" });
  }

  putSourceInstanceState(request: PutSourceInstanceStateRequest): Promise<SourceInstanceStateResponse> {
    const path = LOCAL_DEVICE_ENDPOINTS.sourceInstanceState(this.#requireDeviceId(), request.sourceInstanceId);
    return this.#request(path, {
      authenticate: true,
      body: { state: request.state },
      method: "PUT",
    });
  }

  ackLocalCollectorGap(request: AckLocalCollectorGapRequest): Promise<AckLocalCollectorGapResponse> {
    const path = LOCAL_DEVICE_ENDPOINTS.localCollectorGap(this.#requireDeviceId(), request.source_instance_id);
    return this.#request(path, {
      authenticate: true,
      body: request,
      method: "POST",
    });
  }

  recoverLocalCollectorGap(request: RecoverLocalCollectorGapRequest): Promise<AckLocalCollectorGapResponse> {
    const path = LOCAL_DEVICE_ENDPOINTS.localCollectorGapRecovered(this.#requireDeviceId(), request.source_instance_id);
    return this.#request(path, {
      authenticate: true,
      body: request,
      method: "POST",
    });
  }

  #requireDeviceId(): string {
    if (!this.#deviceId) {
      throw new Error("device id required for authenticated local device request");
    }
    return this.#deviceId;
  }

  async #request<TResponse>(
    path: string,
    options: { authenticate: boolean; body?: unknown; method: "GET" | "POST" | "PUT" }
  ): Promise<TResponse> {
    const headers: Record<string, string> = {
      accept: "application/json",
      [COLLECTOR_PROTOCOL_HEADER]: COLLECTOR_PROTOCOL_VERSION,
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.authenticate) {
      if (!this.#deviceToken) {
        throw new Error("device token required for authenticated local device request");
      }
      headers.authorization = `Bearer ${this.#deviceToken}`;
    }

    const init: RequestInit = { headers, method: options.method };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    // Bound the whole round trip — connect, response headers, and the body
    // read below — so a server that stalls cannot hang the collector. The
    // controller is aborted in `finally` so the timer never outlives the
    // request and keep the process alive past a clean run.
    const controller = this.#requestTimeoutMs > 0 ? new AbortController() : null;
    const timer = controller
      ? setTimeout(
          () => controller.abort(new LocalDeviceRequestTimeoutError(this.#requestTimeoutMs)),
          this.#requestTimeoutMs
        )
      : null;
    if (controller) {
      init.signal = controller.signal;
    }

    try {
      const response = await this.#fetch(new URL(path, this.#baseUrl), init);

      const text = await response.text();
      if (!response.ok) {
        const retryAfterMs = retryAfterMsFromHeaders({
          "retry-after": response.headers.get("retry-after") ?? undefined,
        });
        throw new LocalDeviceHttpError(response.status, text, retryAfterMs);
      }
      if (!text) {
        return { ok: true } as TResponse;
      }
      return JSON.parse(text) as TResponse;
    } catch (error) {
      // Surface the typed timeout regardless of how the runtime reports the
      // abort (DOMException "AbortError", or the abort reason passed through).
      if (controller?.signal.aborted) {
        const { reason } = controller.signal;
        throw reason instanceof LocalDeviceRequestTimeoutError
          ? reason
          : new LocalDeviceRequestTimeoutError(this.#requestTimeoutMs);
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
