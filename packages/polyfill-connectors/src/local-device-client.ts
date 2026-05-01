import type { LocalDeviceRecordEnvelope } from "./local-device-envelope.ts";

export const LOCAL_DEVICE_ENDPOINTS = {
  exchangeEnrollment: "/_ref/device-exporters/enroll",
  heartbeat: (deviceId: string) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/heartbeat`,
  ingestBatch: (deviceId: string) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/ingest-batches`,
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
    return this.#post(LOCAL_DEVICE_ENDPOINTS.exchangeEnrollment, request, false);
  }

  heartbeat(request: HeartbeatRequest): Promise<{ ok: true }> {
    return this.#post(LOCAL_DEVICE_ENDPOINTS.heartbeat(this.#requireDeviceId()), request, true);
  }

  ingestBatch(request: IngestBatchRequest): Promise<{ ok: true }> {
    return this.#post(LOCAL_DEVICE_ENDPOINTS.ingestBatch(this.#requireDeviceId()), request, true);
  }

  #requireDeviceId(): string {
    if (!this.#deviceId) {
      throw new Error("device id required for authenticated local device request");
    }
    return this.#deviceId;
  }

  async #post<TResponse>(path: string, body: unknown, authenticate: boolean): Promise<TResponse> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (authenticate) {
      if (!this.#deviceToken) {
        throw new Error("device token required for authenticated local device request");
      }
      headers.authorization = `Bearer ${this.#deviceToken}`;
    }

    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      body: JSON.stringify(body),
      headers,
      method: "POST",
    });

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
