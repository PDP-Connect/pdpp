/**
 * Thin client over the PDPP resource server. Every request attaches the configured
 * scoped client bearer token; no token rotation or owner fallback happens here.
 */
export class RsClient {
  constructor({ providerUrl, accessToken, fetch = globalThis.fetch, userAgent }) {
    if (typeof fetch !== 'function') {
      throw new TypeError('RsClient requires a fetch implementation');
    }
    if (!providerUrl) {
      throw new TypeError('RsClient requires providerUrl');
    }
    if (!accessToken) {
      throw new TypeError('RsClient requires accessToken');
    }
    this.providerUrl = providerUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
    this.fetch = fetch;
    this.userAgent = userAgent ?? '@pdpp/mcp-server';
  }

  async getJson(path, { query, headers } = {}) {
    const url = this.buildUrl(path, query);
    const response = await this.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        'User-Agent': this.userAgent,
        ...(headers ?? {}),
      },
    });
    return parseRsResponse(response, { expectJson: true });
  }

  async getRaw(path, { query, headers } = {}) {
    const url = this.buildUrl(path, query);
    const response = await this.fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'User-Agent': this.userAgent,
        ...(headers ?? {}),
      },
    });
    return parseRsResponse(response, { expectJson: false });
  }

  async postJson(path, { body, query, headers } = {}) {
    return this.sendJson('POST', path, { body, query, headers });
  }

  async patchJson(path, { body, query, headers } = {}) {
    return this.sendJson('PATCH', path, { body, query, headers });
  }

  async deleteJson(path, { query, headers } = {}) {
    return this.sendJson('DELETE', path, { body: undefined, query, headers });
  }

  async sendJson(method, path, { body, query, headers } = {}) {
    const url = this.buildUrl(path, query);
    const hasBody = body !== undefined && body !== null;
    const init = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        'User-Agent': this.userAgent,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(headers ?? {}),
      },
    };
    if (hasBody) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await this.fetch(url, init);
    return parseRsResponse(response, { expectJson: true });
  }

  buildUrl(path, query) {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `${this.providerUrl}/`);
    if (query && typeof query === 'object') {
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
      if (entry === undefined || entry === null) continue;
      url.searchParams.append(key, String(entry));
    }
    return;
  }
  if (typeof value === 'object') {
    url.searchParams.append(key, JSON.stringify(value));
    return;
  }
  url.searchParams.append(key, String(value));
}

async function parseRsResponse(response, { expectJson }) {
  const status = response.status;
  const contentType = response.headers?.get?.('content-type') ?? '';
  const requestId = response.headers?.get?.('x-request-id') ?? null;

  if (status >= 200 && status < 300) {
    if (expectJson) {
      if (status === 204) {
        return { ok: true, status, body: null, requestId, contentType };
      }
      const body = contentType.includes('application/json') ? await response.json() : await response.text();
      return { ok: true, status, body, requestId, contentType };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { ok: true, status, body: buffer, requestId, contentType };
  }

  let errorBody = null;
  try {
    if (contentType.includes('application/json')) {
      errorBody = await response.json();
    } else {
      errorBody = await response.text();
    }
  } catch {
    errorBody = null;
  }

  const envelope = normalizeErrorEnvelope(errorBody, status);
  if (requestId && envelope && typeof envelope === 'object' && !envelope.request_id) {
    envelope.request_id = requestId;
  }

  return { ok: false, status, error: envelope, requestId, contentType };
}

function normalizeErrorEnvelope(body, status) {
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error === 'object') {
      return body.error;
    }
    if (typeof body.error === 'string') {
      return {
        type: body.error,
        code: body.error,
        message: body.error_description ?? body.message ?? body.error,
      };
    }
    return body;
  }

  return {
    type: 'rs_error',
    code: `http_${status}`,
    message: typeof body === 'string' && body.length > 0 ? body : `Resource server returned HTTP ${status}`,
  };
}
