import { COLLECTOR_PROTOCOL_HEADER, COLLECTOR_PROTOCOL_VERSION } from "./collector-protocol.ts";
import type { LocalDeviceRecordEnvelope } from "./local-device-envelope.ts";

export const LOCAL_DEVICE_ENDPOINTS = {
  exchangeEnrollment: "/_ref/device-exporters/enroll",
  heartbeat: (deviceId: string) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/heartbeat`,
  ingestBatch: (deviceId: string) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/ingest-batches`,
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
}

export interface EnrollmentExchangeRequest {
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
  kind: "state_read_failed" | "dead_letter_backlog";
  /** Top redacted dead-letter error classes (present for backlog stalls). */
  top_dead_letter_classes?: { count: number; error_class: string }[];
}

export interface HeartbeatRequest {
  connector_id: string;
  last_error?: HeartbeatLastError | null;
  outbox?: HeartbeatOutboxDiagnostics;
  records_pending?: number;
  source_instance_id: string;
  status: "starting" | "healthy" | "retrying" | "blocked" | "stopped";
}

export interface IngestBatchRequest {
  batch_id: string;
  batch_seq: number;
  body_hash: string;
  connector_id: string;
  device_id: string;
  records: Pick<LocalDeviceRecordEnvelope, "data" | "emitted_at" | "record_key" | "stream">[];
  source_instance_id: string;
}

export interface GetSourceInstanceStateRequest {
  sourceInstanceId: string;
}

export interface PutSourceInstanceStateRequest {
  sourceInstanceId: string;
  state: Record<string, unknown>;
}

export interface SourceInstanceStateResponse {
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

  constructor(status: number, body: string) {
    const parsed = parseLocalDeviceErrorEnvelope(body);
    const detail = formatLocalDeviceErrorDetail(parsed);
    super(`local device request failed: ${status}${detail}`);
    this.name = "LocalDeviceHttpError";
    this.status = status;
    this.body = body;
    this.code = parsed?.code ?? null;
    this.param = parsed?.param ?? null;
    this.envelopeMessage = parsed?.message ?? null;
  }
}

function parseLocalDeviceErrorEnvelope(
  body: string
): { code: string; message: string | null; param: string | null } | null {
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown; param?: unknown } };
    if (parsed && typeof parsed === "object" && parsed.error && typeof parsed.error.code === "string") {
      return {
        code: parsed.error.code,
        message: typeof parsed.error.message === "string" ? sanitizeErrorDetail(parsed.error.message) : null,
        param: typeof parsed.error.param === "string" ? sanitizeErrorDetail(parsed.error.param) : null,
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

export class LocalDeviceClient {
  readonly #baseUrl: URL;
  readonly #deviceId: string | undefined;
  readonly #deviceToken: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: LocalDeviceClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#deviceId = options.deviceId;
    this.#deviceToken = options.deviceToken;
    this.#fetch = options.fetchImpl ?? fetch;
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

  ingestBatch(request: IngestBatchRequest): Promise<{ ok: true }> {
    return this.#request(LOCAL_DEVICE_ENDPOINTS.ingestBatch(this.#requireDeviceId()), {
      authenticate: true,
      body: request,
      method: "POST",
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
    const response = await this.#fetch(new URL(path, this.#baseUrl), init);

    const text = await response.text();
    if (!response.ok) {
      throw new LocalDeviceHttpError(response.status, text);
    }
    if (!text) {
      return { ok: true } as TResponse;
    }
    return JSON.parse(text) as TResponse;
  }
}
