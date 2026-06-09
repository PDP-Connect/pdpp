/**
 * Client ID Metadata Document (CIMD) fetch, validate, and cache.
 *
 * Implements the SSRF, size, timeout, redirect, and redirect_uri-trust
 * requirements from draft-ietf-oauth-client-id-metadata-document-01
 * §4.3, §6.1, §6.3.1, §6.4, §6.5, §6.6.
 *
 * See openspec/changes/add-mcp-cimd-client-identity/design.md
 */

import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';

export const CIMD_FETCH_TIMEOUT_MS = 5_000;
export const CIMD_MAX_BODY_BYTES = 5 * 1024; // CIMD-01 recommended maximum.
const CIMD_CACHE_MIN_TTL_MS = 60_000;        // 60 s
const CIMD_CACHE_MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// Security-relevant fields: changes here trigger grant/token revocation
const SECURITY_RELEVANT_FIELDS = ['redirect_uris', 'token_endpoint_auth_method', 'jwks', 'jwks_uri'];

// In-memory cache: clientId → { doc, expiresAt, securityHash }
const cimdCache = new Map();
const textEncoder = new TextEncoder();

function rawPathFromUrlString(value) {
  const match = String(value).match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i);
  return match?.[1] ?? '';
}

function hasRawDotSegment(pathname) {
  return pathname
    .split('/')
    .some((segment) => {
      const decoded = segment.replace(/%2e/gi, '.');
      return decoded === '.' || decoded === '..';
    });
}

/**
 * Returns true if the client_id looks like a CIMD client_id (https:// URL).
 */
export function isCimdClientId(clientId) {
  if (typeof clientId !== 'string') return false;
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate the client_id URL for SSRF safety before any fetch.
 * Throws with err.code = 'invalid_request' on violation.
 */
export function validateCimdUrl(clientId) {
  let url;
  try {
    url = new URL(clientId);
  } catch {
    const err = new Error(`client_id is not a valid URL: ${clientId}`);
    err.code = 'invalid_request';
    throw err;
  }

  if (url.protocol !== 'https:') {
    const err = new Error('CIMD client_id must use https scheme');
    err.code = 'invalid_request';
    throw err;
  }

  if (url.username || url.password) {
    const err = new Error('CIMD client_id must not include userinfo');
    err.code = 'invalid_request';
    throw err;
  }

  if (!url.pathname || url.pathname === '/') {
    const err = new Error('CIMD client_id must have a non-empty path');
    err.code = 'invalid_request';
    throw err;
  }

  if (hasRawDotSegment(rawPathFromUrlString(clientId))) {
    const err = new Error('CIMD client_id path must not contain dot-segments');
    err.code = 'invalid_request';
    throw err;
  }

  if (url.hash) {
    const err = new Error('CIMD client_id must not include a fragment');
    err.code = 'invalid_request';
    throw err;
  }
}

/**
 * Check whether a resolved IP is in a forbidden private/loopback/multicast range.
 * Returns true if the IP is forbidden (SSRF risk), false if safe to fetch.
 */
export function isForbiddenIp(ip) {
  const normalized = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const mappedV4 = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedV4) {
    return isForbiddenIp(mappedV4[1]);
  }

  // IPv4 checks
  const v4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b, c, d] = v4.map(Number);
    if ([a, b, c, d].some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
    if (a === 127) return true;                          // loopback 127.0.0.0/8
    if (a === 10) return true;                           // private 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;   // carrier-grade NAT 100.64.0.0/10
    if (a === 172 && b >= 16 && b <= 31) return true;   // private 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // private 192.168.0.0/16
    if (a === 169 && b === 254) return true;             // link-local 169.254.0.0/16
    if (a >= 224 && a <= 239) return true;               // multicast 224.0.0.0/4
    if (a === 0) return true;                            // 0.0.0.0
    if (a === 255 && b === 255 && c === 255 && d === 255) return true; // limited broadcast
    return false;
  }
  // IPv6 checks
  if (normalized === '::1') return true;                 // loopback
  if (normalized === '::') return true;
  const firstHextet = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  if (Number.isFinite(firstHextet)) {
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    if ((firstHextet & 0xff00) === 0xff00) return true; // multicast ff00::/8
  }
  return false;
}

/**
 * Validate that all redirect_uris in the CIMD document are trusted relative
 * to the client_id origin, with an exception for http://localhost:* etc.
 * Throws with err.code = 'invalid_request' if any are outside the allowed set.
 */
export function validateCimdRedirectUris(doc, clientId) {
  const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
  const clientUrl = new URL(clientId);
  const clientOrigin = clientUrl.origin; // scheme + host + port

  for (const uri of redirectUris) {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      const err = new Error(`CIMD redirect_uri is not a valid URL: ${uri}`);
      err.code = 'invalid_request';
      throw err;
    }

    // Localhost exception: http://localhost:*, http://127.0.0.1:*, http://[::1]:*
    if (parsed.protocol === 'http:') {
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        continue;
      }
    }

    if (parsed.origin !== clientOrigin) {
      const err = new Error(
        `CIMD redirect_uri ${uri} does not share origin with client_id ${clientId}`,
      );
      err.code = 'invalid_request';
      throw err;
    }
  }
}

function computeSecurityHash(doc) {
  const relevant = {};
  for (const field of SECURITY_RELEVANT_FIELDS) {
    if (doc[field] !== undefined) relevant[field] = doc[field];
  }
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

function parseCacheControlMaxAge(headers) {
  const cc = headers?.get?.('cache-control') || '';
  const match = cc.match(/max-age\s*=\s*(\d+)/i);
  if (!match) return null;
  return parseInt(match[1], 10) * 1000;
}

/**
 * Resolve a CIMD document from cache or via network fetch.
 * For same-origin client_ids (PDPP-hosted), callers should use
 * resolveCimdDocumentLocal() instead to avoid a network self-fetch.
 *
 * Returns { doc, securityHash, fromCache }.
 * Throws with err.code = 'cimd_fetch_failed' on any fetch/parse/validation failure.
 */
export async function fetchCimdDocument(
  clientId,
  {
    fetchImpl = globalThis.fetch,
    dnsLookupImpl = dnsLookup,
    onSecurityRelevantMetadataChange = null,
    nowMs = Date.now(),
    timeoutMs = CIMD_FETCH_TIMEOUT_MS,
  } = {},
) {
  const now = nowMs;
  const cached = cimdCache.get(clientId);
  if (cached && cached.expiresAt > now) {
    return {
      doc: cached.doc,
      securityHash: cached.securityHash,
      fromCache: true,
      securityRelevantMetadataChanged: false,
    };
  }
  const previousCached = cached || null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    // Validate URL and check IP before fetching
    validateCimdUrl(clientId);
    const url = new URL(clientId);
    // DNS lookup to check for SSRF
    let addrs;
    try {
      addrs = await dnsLookupImpl(url.hostname, { all: true });
    } catch {
      const err = new Error(`CIMD fetch failed: DNS resolution failed for ${url.hostname}`);
      err.code = 'cimd_fetch_failed';
      err.hostname = url.hostname;
      throw err;
    }
    for (const addr of addrs) {
      if (isForbiddenIp(addr.address)) {
        const err = new Error(
          `CIMD fetch blocked: ${url.hostname} resolves to private/loopback address ${addr.address}`,
        );
        err.code = 'cimd_fetch_failed';
        err.hostname = url.hostname;
        throw err;
      }
    }

    response = await fetchImpl(clientId, {
      signal: controller.signal,
      redirect: 'manual', // CIMD §6.6: do not follow redirects
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.code === 'cimd_fetch_failed' || err.code === 'invalid_request') throw err;
    const wrapped = new Error(`CIMD fetch failed for ${clientId}: ${err.message}`);
    wrapped.code = 'cimd_fetch_failed';
    wrapped.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
    throw wrapped;
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status >= 300 && response.status < 400) {
    const err = new Error(`CIMD fetch rejected redirect for ${clientId}`);
    err.code = 'cimd_fetch_failed';
    err.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`CIMD fetch returned ${response.status} for ${clientId}`);
    err.code = 'cimd_fetch_failed';
    err.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
    throw err;
  }

  // Read with size cap
  const reader = response.body?.getReader();
  let body = '';
  let bytesRead = 0;
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > CIMD_MAX_BODY_BYTES) {
        await reader.cancel();
        const err = new Error(`CIMD document exceeds 5 KB size limit for ${clientId}`);
        err.code = 'cimd_fetch_failed';
        err.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
        throw err;
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } else {
    body = await response.text();
    if (textEncoder.encode(body).byteLength > CIMD_MAX_BODY_BYTES) {
      const err = new Error(`CIMD document exceeds 5 KB size limit for ${clientId}`);
      err.code = 'cimd_fetch_failed';
      err.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
      throw err;
    }
  }

  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    const err = new Error(`CIMD document is not valid JSON for ${clientId}`);
    err.code = 'cimd_fetch_failed';
    err.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
    throw err;
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    const err = new Error(`CIMD document is not a JSON object for ${clientId}`);
    err.code = 'cimd_fetch_failed';
    err.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
    throw err;
  }

  // Validate client_id in document matches the URL
  if (doc.client_id !== clientId) {
    const err = new Error(`CIMD document client_id mismatch: expected ${clientId}, got ${doc.client_id}`);
    err.code = 'cimd_fetch_failed';
    err.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
    throw err;
  }

  // Reject shared-secret / non-public-client auth methods
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none') {
    const err = new Error(
      `CIMD document uses unsupported token_endpoint_auth_method: ${doc.token_endpoint_auth_method}`,
    );
    err.code = 'cimd_fetch_failed';
    err.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
    throw err;
  }

  if (doc.client_secret != null) {
    const err = new Error('CIMD document must not include client_secret (public clients only)');
    err.code = 'cimd_fetch_failed';
    err.hostname = (() => { try { return new URL(clientId).hostname; } catch { return clientId; } })();
    throw err;
  }

  validateCimdRedirectUris(doc, clientId);

  const securityHash = computeSecurityHash(doc);
  const securityRelevantMetadataChanged = Boolean(
    previousCached && previousCached.securityHash !== securityHash,
  );

  if (securityRelevantMetadataChanged) {
    cimdCache.delete(clientId);
    if (typeof onSecurityRelevantMetadataChange === 'function') {
      await onSecurityRelevantMetadataChange({
        clientId,
        previousDoc: previousCached.doc,
        nextDoc: doc,
        previousSecurityHash: previousCached.securityHash,
        nextSecurityHash: securityHash,
      });
    }
  }

  // Determine TTL from cache headers, bounded by [min, max]
  const headerMaxAge = parseCacheControlMaxAge(response.headers);
  const ttl = headerMaxAge != null
    ? Math.min(Math.max(headerMaxAge, CIMD_CACHE_MIN_TTL_MS), CIMD_CACHE_MAX_TTL_MS)
    : CIMD_CACHE_MIN_TTL_MS;

  cimdCache.set(clientId, { doc, securityHash, expiresAt: nowMs + ttl });

  return { doc, securityHash, fromCache: false, securityRelevantMetadataChanged };
}

/**
 * Invalidate the cache entry for a client_id (e.g. after security-relevant metadata change).
 */
export function invalidateCimdCache(clientId) {
  cimdCache.delete(clientId);
}

/**
 * Build a synthetic "registered client" shape from a CIMD doc.
 * This mirrors the shape returned by getRegisteredClient() in auth.js.
 */
export function buildCimdRegisteredClient(clientId, doc) {
  return {
    client_id: clientId,
    registration_mode: 'client_id_metadata_document',
    token_endpoint_auth_method: doc.token_endpoint_auth_method || 'none',
    client_secret: null,
    metadata: {
      client_name: doc.client_name || null,
      client_uri: doc.client_uri || null,
      logo_uri: doc.logo_uri || null,
      redirect_uris: Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [],
      token_endpoint_auth_method: doc.token_endpoint_auth_method || 'none',
    },
    created_at: null,
    updated_at: null,
  };
}
