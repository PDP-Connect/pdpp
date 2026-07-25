// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | readonly QueryScalar[] | undefined | null;
export type QueryParams = Record<string, QueryValue>;
export type HeaderParams = Record<string, string>;

export interface RsErrorEnvelope {
  code?: string;
  message?: string;
  request_id?: string;
  type?: string;
  [key: string]: unknown;
}

export interface RsSuccessResponse<Body = unknown> {
  body: Body;
  contentType: string;
  ok: true;
  requestId: string | null;
  status: number;
}

export interface RsErrorResponse {
  contentType: string;
  error: RsErrorEnvelope;
  ok: false;
  requestId: string | null;
  status: number;
}

export type RsResponse<Body = unknown> = RsSuccessResponse<Body> | RsErrorResponse;

interface RequestOptions {
  headers?: HeaderParams;
  query?: QueryParams;
}

type SendJsonOptions = RequestOptions & {
  body?: unknown;
};

interface RsClientOptions {
  accessToken: string;
  fetch?: typeof fetch;
  providerUrl: string;
  userAgent?: string;
}

const TRAILING_SLASH_PATTERN = /\/$/;

/**
 * Thin client over the PDPP resource server. Every request attaches the configured
 * scoped client bearer token; no token rotation or owner fallback happens here.
 */
export class RsClient {
  providerUrl: string;
  accessToken: string;
  fetch: typeof fetch;
  userAgent: string;

  constructor({ providerUrl, accessToken, fetch: fetchImpl = globalThis.fetch, userAgent }: RsClientOptions) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("RsClient requires a fetch implementation");
    }
    if (!providerUrl) {
      throw new TypeError("RsClient requires providerUrl");
    }
    if (!accessToken) {
      throw new TypeError("RsClient requires accessToken");
    }
    this.providerUrl = providerUrl.replace(TRAILING_SLASH_PATTERN, "");
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
    this.userAgent = userAgent ?? "@pdpp/mcp-server";
  }

  async getJson<Body = unknown>(path: string, { query, headers }: RequestOptions = {}): Promise<RsResponse<Body>> {
    const url = this.buildUrl(path, query);
    const response = await this.fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": this.userAgent,
        ...(headers ?? {}),
      },
    });
    return parseRsResponse<Body>(response, { expectJson: true });
  }

  async getRaw(path: string, { query, headers }: RequestOptions = {}): Promise<RsResponse<Buffer>> {
    const url = this.buildUrl(path, query);
    const response = await this.fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": this.userAgent,
        ...(headers ?? {}),
      },
    });
    return parseRsResponse<Buffer>(response, { expectJson: false });
  }

  postJson<Body = unknown>(path: string, options: SendJsonOptions = {}): Promise<RsResponse<Body>> {
    return this.sendJson<Body>("POST", path, options);
  }

  patchJson<Body = unknown>(path: string, options: SendJsonOptions = {}): Promise<RsResponse<Body>> {
    return this.sendJson<Body>("PATCH", path, options);
  }

  deleteJson<Body = unknown>(path: string, { query, headers }: RequestOptions = {}): Promise<RsResponse<Body>> {
    return this.sendJson<Body>("DELETE", path, {
      ...(query === undefined ? {} : { query }),
      ...(headers === undefined ? {} : { headers }),
    });
  }

  async sendJson<Body = unknown>(
    method: string,
    path: string,
    { body, query, headers }: SendJsonOptions = {}
  ): Promise<RsResponse<Body>> {
    const url = this.buildUrl(path, query);
    const hasBody = body !== undefined && body !== null;
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": this.userAgent,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(headers ?? {}),
      },
    };
    if (hasBody) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const response = await this.fetch(url, init);
    return parseRsResponse<Body>(response, { expectJson: true });
  }

  buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, `${this.providerUrl}/`);
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        appendQuery(url, key, value);
      }
    }
    return url.toString();
  }
}

function appendQuery(url: URL, key: string, value: QueryValue): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry === undefined || entry === null) {
        continue;
      }
      url.searchParams.append(key, String(entry));
    }
    return;
  }
  if (typeof value === "object") {
    throw new TypeError(
      `query parameter '${key}' must be a scalar or array; encode nested query shapes explicitly before calling RsClient`
    );
  }
  url.searchParams.append(key, String(value));
}

async function parseRsResponse<Body>(
  response: Response,
  { expectJson }: { expectJson: boolean }
): Promise<RsResponse<Body>> {
  const { status } = response;
  const contentType = response.headers?.get?.("content-type") ?? "";
  const requestId = response.headers?.get?.("x-request-id") ?? null;

  if (status >= 200 && status < 300) {
    if (expectJson) {
      if (status === 204) {
        return { ok: true, status, body: null as Body, requestId, contentType };
      }
      const body = contentType.includes("application/json")
        ? ((await response.json()) as Body)
        : ((await response.text()) as Body);
      return { ok: true, status, body, requestId, contentType };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { ok: true, status, body: buffer as Body, requestId, contentType };
  }

  let errorBody: unknown = null;
  try {
    if (contentType.includes("application/json")) {
      errorBody = await response.json();
    } else {
      errorBody = await response.text();
    }
  } catch {
    errorBody = null;
  }

  const envelope = normalizeErrorEnvelope(errorBody, status);
  if (requestId && envelope && typeof envelope === "object" && !envelope.request_id) {
    envelope.request_id = requestId;
  }

  return { ok: false, status, error: envelope, requestId, contentType };
}

function normalizeErrorEnvelope(body: unknown, status: number): RsErrorEnvelope {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
      return record.error as RsErrorEnvelope;
    }
    if (typeof record.error === "string") {
      const description = typeof record.error_description === "string" ? record.error_description : null;
      const fallbackMessage = typeof record.message === "string" ? record.message : null;
      return {
        type: record.error,
        code: record.error,
        message: description ?? fallbackMessage ?? record.error,
      };
    }
    return record as RsErrorEnvelope;
  }

  return {
    type: "rs_error",
    code: `http_${status}`,
    message: typeof body === "string" && body.length > 0 ? body : `Resource server returned HTTP ${status}`,
  };
}
