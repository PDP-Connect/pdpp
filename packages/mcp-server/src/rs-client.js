// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin client over the PDPP resource server. Every request attaches the configured
 * scoped client bearer token; no token rotation or owner fallback happens here.
 */
export class RsClient {
  constructor({ providerUrl, accessToken, fetch = globalThis.fetch, userAgent }) {
    if (typeof fetch !== "function") {
      throw new TypeError("RsClient requires a fetch implementation");
    }
    if (!providerUrl) {
      throw new TypeError("RsClient requires providerUrl");
    }
    if (!accessToken) {
      throw new TypeError("RsClient requires accessToken");
    }
    this.providerUrl = providerUrl.replace(/\/$/, "");
    this.accessToken = accessToken;
    this.fetch = fetch;
    this.userAgent = userAgent ?? "@pdpp/mcp-server";
  }

  async getJson(path, { query, headers } = {}) {
    const url = this.buildUrl(path, query);
    const response = await this.fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": this.userAgent,
        ...(headers ?? {}),
      },
      method: "GET",
    });
    return parseRsResponse(response, { expectJson: true });
  }

  async getRaw(path, { query, headers } = {}) {
    const url = this.buildUrl(path, query);
    const response = await this.fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": this.userAgent,
        ...(headers ?? {}),
      },
      method: "GET",
    });
    return parseRsResponse(response, { expectJson: false });
  }

  async postJson(path, { body, query, headers } = {}) {
    return this.sendJson("POST", path, { body, headers, query });
  }

  async patchJson(path, { body, query, headers } = {}) {
    return this.sendJson("PATCH", path, { body, headers, query });
  }

  async deleteJson(path, { query, headers } = {}) {
    return this.sendJson("DELETE", path, { body: undefined, headers, query });
  }

  async sendJson(method, path, { body, query, headers } = {}) {
    const url = this.buildUrl(path, query);
    const hasBody = body !== undefined && body !== null;
    const init = {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": this.userAgent,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(headers ?? {}),
      },
      method,
    };
    if (hasBody) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const response = await this.fetch(url, init);
    return parseRsResponse(response, { expectJson: true });
  }

  buildUrl(path, query) {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, `${this.providerUrl}/`);
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        appendQuery(url, key, value);
      }
    }
    return url.toString();
  }
}

function appendQuery(url, key, value) {
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

async function parseRsResponse(response, { expectJson }) {
  const status = response.status;
  const contentType = response.headers?.get?.("content-type") ?? "";
  const requestId = response.headers?.get?.("x-request-id") ?? null;

  if (status >= 200 && status < 300) {
    if (expectJson) {
      if (status === 204) {
        return { body: null, contentType, ok: true, requestId, status };
      }
      const body = contentType.includes("application/json") ? await response.json() : await response.text();
      return { body, contentType, ok: true, requestId, status };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { body: buffer, contentType, ok: true, requestId, status };
  }

  let errorBody = null;
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

  return { contentType, error: envelope, ok: false, requestId, status };
}

function normalizeErrorEnvelope(body, status) {
  if (body && typeof body === "object") {
    if (body.error && typeof body.error === "object") {
      return body.error;
    }
    if (typeof body.error === "string") {
      return {
        code: body.error,
        message: body.error_description ?? body.message ?? body.error,
        type: body.error,
      };
    }
    return body;
  }

  return {
    code: `http_${status}`,
    message: typeof body === "string" && body.length > 0 ? body : `Resource server returned HTTP ${status}`,
    type: "rs_error",
  };
}
