import type { LocalDeviceRecordEnvelope } from "./local-device-envelope.ts";

export const LOCAL_DEVICE_ENDPOINTS = {
  exchangeEnrollment: "/reference/local-devices/enrollment/exchange",
  heartbeat: "/reference/local-devices/heartbeat",
  ingestBatch: "/reference/local-devices/ingest/batches",
} as const;

export interface LocalDeviceClientOptions {
  baseUrl: string;
  deviceToken?: string;
  fetchImpl?: typeof fetch;
}

export interface EnrollmentExchangeRequest {
  code: string;
  device_label?: string;
  source_instance_id: string;
}

export interface EnrollmentExchangeResponse {
  device_id: string;
  device_token: string;
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
  records: LocalDeviceRecordEnvelope[];
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
  readonly #deviceToken: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: LocalDeviceClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#deviceToken = options.deviceToken;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  exchangeEnrollment(request: EnrollmentExchangeRequest): Promise<EnrollmentExchangeResponse> {
    return this.#post(LOCAL_DEVICE_ENDPOINTS.exchangeEnrollment, request, false);
  }

  heartbeat(request: HeartbeatRequest): Promise<{ ok: true }> {
    return this.#post(LOCAL_DEVICE_ENDPOINTS.heartbeat, request, true);
  }

  ingestBatch(request: IngestBatchRequest): Promise<{ ok: true }> {
    return this.#post(LOCAL_DEVICE_ENDPOINTS.ingestBatch, request, true);
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
