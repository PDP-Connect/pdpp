import type { LocalDeviceRecordEnvelope } from "./local-device-envelope.ts";

export const LOCAL_DEVICE_ENDPOINTS = {
  exchangeEnrollment: "/_ref/device-exporters/enroll",
  heartbeat: (deviceId: string) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/heartbeat`,
  ingestBatch: (deviceId: string) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/ingest-batches`,
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

export interface HeartbeatRequest {
  connector_id: string;
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

export class LocalDeviceHttpError extends Error {
  readonly body: string;
  readonly status: number;

  constructor(status: number, body: string) {
    super(`local device request failed: ${status}`);
    this.name = "LocalDeviceHttpError";
    this.status = status;
    this.body = body;
  }
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
