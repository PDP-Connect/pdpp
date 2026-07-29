// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client ID Metadata Document (CIMD) fetch, validate, and cache.
 *
 * Implements the SSRF, size, timeout, redirect, and redirect_uri-trust
 * requirements from draft-ietf-oauth-client-id-metadata-document-01
 * §4.3, §6.1, §6.3.1, §6.4, §6.5, §6.6.
 *
 * See openspec/changes/add-mcp-cimd-client-identity/design.md
 */

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { fetch as undiciFetch } from "undici";
import {
  createPinnedDispatcher,
  type DnsLookupAll,
  // biome-ignore lint/style/noExportedImports: This type export preserves the existing public import surface.
  isForbiddenIp,
  // biome-ignore lint/style/noExportedImports: This type export preserves the existing public import surface.
  isGlobalUnicastAddress,
  resolveAllowedAddresses,
} from "./ssrf-guard.ts";

// Re-exported for existing callers/tests that import isForbiddenIp from here;
// the classifier itself now lives in ssrf-guard.ts so it can be shared with
// client-event-delivery-worker.ts and web-push-notifications.js without
// duplicating the SSRF policy.
export { isForbiddenIp, isGlobalUnicastAddress };

export const CIMD_FETCH_TIMEOUT_MS = 5000;
export const CIMD_MAX_BODY_BYTES = 5 * 1024; // CIMD-01 recommended maximum.
const CIMD_CACHE_MIN_TTL_MS = 60_000; // 60 s
const CIMD_CACHE_MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// Security-relevant fields: changes here trigger grant/token revocation
const SECURITY_RELEVANT_FIELDS = ["redirect_uris", "token_endpoint_auth_method", "jwks", "jwks_uri"];

// In-memory cache: clientId → { doc, expiresAt, securityHash }
export type CimdDocument = Record<string, unknown>;
type CimdErrorCode = "invalid_request" | "cimd_fetch_failed";
interface CachedCimdDocument {
  doc: CimdDocument;
  expiresAt: number;
  securityHash: string;
}
export interface SecurityMetadataChange {
  clientId: string;
  nextDoc: CimdDocument;
  nextSecurityHash: string;
  previousDoc: CimdDocument;
  previousSecurityHash: string;
}
// Keep the injectable seam limited to the response surface CIMD consumes.
// Undici 8's Response adds members that Node's ambient Response does not have,
// so `typeof undiciFetch` would reject test fetches backed by global fetch.
type CimdResponse = Pick<Response, "body" | "headers" | "ok" | "status" | "text">;
type CimdFetch = (
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1]
) => Promise<CimdResponse>;
export interface FetchCimdOptions {
  dnsLookupImpl?: DnsLookupAll;
  fetchImpl?: CimdFetch;
  isGlobalUnicastAddressImpl?: (ip: string) => boolean;
  nowMs?: number;
  onSecurityRelevantMetadataChange?: (change: SecurityMetadataChange) => void | Promise<void>;
  timeoutMs?: number;
}

export interface FetchCimdResult {
  doc: CimdDocument;
  fromCache: boolean;
  securityHash: string;
  securityRelevantMetadataChanged: boolean;
}

class CimdError extends Error {
  readonly code: CimdErrorCode;
  readonly hostname: string | undefined;

  constructor(code: CimdErrorCode, message: string, hostname?: string) {
    super(message);
    this.code = code;
    this.hostname = hostname;
  }
}

const cimdCache = new Map<string, CachedCimdDocument>();
const textEncoder = new TextEncoder();

function rawPathFromUrlString(value: string): string {
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  const match = String(value).match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i);
  return match?.[1] ?? "";
}

function isCimdDocument(value: unknown): value is CimdDocument {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRawDotSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => {
    const decoded = segment.replace(/%2e/gi, ".");
    return decoded === "." || decoded === "..";
  });
}

/**
 * Returns true if the client_id looks like a CIMD client_id (https:// URL).
 */
export function isCimdClientId(clientId: unknown): boolean {
  if (typeof clientId !== "string") {
    return false;
  }
  try {
    const url = new URL(clientId);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate the client_id URL for SSRF safety before any fetch.
 * Throws with err.code = 'invalid_request' on violation.
 */
export function validateCimdUrl(clientId: string): void {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
    throw new CimdError("invalid_request", `client_id is not a valid URL: ${clientId}`);
  }

  if (url.protocol !== "https:") {
    throw new CimdError("invalid_request", "CIMD client_id must use https scheme");
  }

  if (url.username || url.password) {
    throw new CimdError("invalid_request", "CIMD client_id must not include userinfo");
  }

  if (!url.pathname || url.pathname === "/") {
    throw new CimdError("invalid_request", "CIMD client_id must have a non-empty path");
  }

  if (hasRawDotSegment(rawPathFromUrlString(clientId))) {
    throw new CimdError("invalid_request", "CIMD client_id path must not contain dot-segments");
  }

  if (url.hash) {
    throw new CimdError("invalid_request", "CIMD client_id must not include a fragment");
  }
}

/**
 * Validate that all redirect_uris in the CIMD document are trusted relative
 * to the client_id origin, with an exception for http://localhost:* etc.
 * Throws with err.code = 'invalid_request' if any are outside the allowed set.
 */
export function validateCimdRedirectUris(doc: CimdDocument, clientId: string): void {
  const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
  const clientUrl = new URL(clientId);
  const clientOrigin = clientUrl.origin; // scheme + host + port

  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
      throw new CimdError("invalid_request", `CIMD redirect_uri is not a valid URL: ${uri}`);
    }

    // Localhost exception: http://localhost:*, http://127.0.0.1:*, http://[::1]:*
    if (parsed.protocol === "http:") {
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
        continue;
      }
    }

    if (parsed.origin !== clientOrigin) {
      throw new CimdError(
        "invalid_request",
        `CIMD redirect_uri ${uri} does not share origin with client_id ${clientId}`
      );
    }
  }
}

function computeSecurityHash(doc: CimdDocument): string {
  const relevant: CimdDocument = {};
  for (const field of SECURITY_RELEVANT_FIELDS) {
    if (doc[field] !== undefined) {
      relevant[field] = doc[field];
    }
  }
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

function parseCacheControlMaxAge(headers: Headers): number | null {
  const cc = headers.get("cache-control") || "";
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  const match = cc.match(/max-age\s*=\s*(\d+)/i);
  if (!match) {
    return null;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const seconds = match[1];
  return seconds === undefined ? null : Number.parseInt(seconds, 10) * 1000;
}

function cimdFetchFailure(clientId: string, message: string): CimdError {
  let hostname = clientId;
  try {
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    hostname = new URL(clientId).hostname;
  } catch {
    // Keep the original client id for diagnostics when URL parsing failed.
  }
  return new CimdError("cimd_fetch_failed", message, hostname);
}

/**
 * Resolve a CIMD document from cache or via network fetch.
 * For same-origin client_ids (PDPP-hosted), callers should use
 * resolveCimdDocumentLocal() instead to avoid a network self-fetch.
 *
 * Returns { doc, securityHash, fromCache }.
 * Throws with err.code = 'cimd_fetch_failed' on any fetch/parse/validation failure.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
export async function fetchCimdDocument(
  clientId: string,
  {
    fetchImpl = undiciFetch,
    dnsLookupImpl = async (hostname, options) => dnsLookup(hostname, options),
    isGlobalUnicastAddressImpl = isGlobalUnicastAddress,
    onSecurityRelevantMetadataChange,
    nowMs = Date.now(),
    timeoutMs = CIMD_FETCH_TIMEOUT_MS,
  }: FetchCimdOptions = {}
): Promise<FetchCimdResult> {
  const now = nowMs;
  const cached = cimdCache.get(clientId);
  if (cached && cached.expiresAt > now) {
    return {
      doc: cached.doc,
      fromCache: true,
      securityHash: cached.securityHash,
      securityRelevantMetadataChanged: false,
    };
  }
  const previousCached = cached || null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: CimdResponse;
  let dispatcher: ReturnType<typeof createPinnedDispatcher> | null = null;
  try {
    // Validate URL and check IP before fetching
    validateCimdUrl(clientId);
    const url = new URL(clientId);
    // DNS lookup + global-unicast allow-list check, so a resolved address is
    // required before any HTTP request is issued (SSRF guard). Bounded to a
    // small maximum number of resolved addresses (see MAX_VALIDATED_ADDRESSES
    // in ssrf-guard.ts) so an attacker-controlled DNS answer cannot force
    // unbounded connection work; the answer is rejected in full (fail closed)
    // rather than silently truncated when it exceeds the bound.
    const resolved = await resolveAllowedAddresses(url.hostname, { dnsLookupImpl, isGlobalUnicastAddressImpl });
    if (!resolved.ok) {
      let message: string;
      switch (resolved.kind) {
        case "dns_failed":
          message = `CIMD fetch failed: DNS resolution failed for ${url.hostname}`;
          break;
        case "no_addresses":
          message = `CIMD fetch failed: DNS resolution returned no addresses for ${url.hostname}`;
          break;
        case "too_many_addresses":
          message = `CIMD fetch blocked: ${url.hostname} resolved to ${resolved.count} addresses, exceeding the bound of ${resolved.max}`;
          break;
        case "forbidden_address":
          message = `CIMD fetch blocked: ${url.hostname} resolves to private/loopback address ${resolved.address}`;
          break;
      }
      throw new CimdError("cimd_fetch_failed", message, url.hostname);
    }

    // Send-time address binding: pin the connection to the exact address(es)
    // just validated, so `fetchImpl` cannot independently re-resolve the
    // hostname and race the check above (DNS rebinding). See ssrf-guard.ts.
    // A test-injected `fetchImpl` stub that returns a canned Response simply
    // ignores this option, same as it already ignores `signal`/`redirect`.
    dispatcher = createPinnedDispatcher(resolved.addresses);

    response = await fetchImpl(clientId, {
      dispatcher,
      headers: { Accept: "application/json" },
      redirect: "manual", // CIMD §6.6: do not follow redirects
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof CimdError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    const hostname = (() => {
      try {
        return new URL(clientId).hostname;
      } catch {
        return clientId;
      }
    })();
    // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
    throw new CimdError("cimd_fetch_failed", `CIMD fetch failed for ${clientId}: ${detail}`, hostname);
  } finally {
    clearTimeout(timeoutId);
    // Fire-and-forget: pool teardown is not a fetch outcome.
    dispatcher?.close().catch(() => {
      // Pool teardown errors are not fetch failures; nothing to do.
    });
  }

  if (response.status >= 300 && response.status < 400) {
    throw cimdFetchFailure(clientId, `CIMD fetch rejected redirect for ${clientId}`);
  }

  if (!response.ok) {
    throw cimdFetchFailure(clientId, `CIMD fetch returned ${response.status} for ${clientId}`);
  }

  // Read with size cap
  const reader = response.body?.getReader();
  let body = "";
  let bytesRead = 0;
  if (reader) {
    const decoder = new TextDecoder();
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > CIMD_MAX_BODY_BYTES) {
        await reader.cancel();
        throw cimdFetchFailure(clientId, `CIMD document exceeds 5 KB size limit for ${clientId}`);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } else {
    body = await response.text();
    if (textEncoder.encode(body).byteLength > CIMD_MAX_BODY_BYTES) {
      throw cimdFetchFailure(clientId, `CIMD document exceeds 5 KB size limit for ${clientId}`);
    }
  }

  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
    throw cimdFetchFailure(clientId, `CIMD document is not valid JSON for ${clientId}`);
  }

  if (!isCimdDocument(doc)) {
    throw cimdFetchFailure(clientId, `CIMD document is not a JSON object for ${clientId}`);
  }

  // Validate client_id in document matches the URL
  if (doc.client_id !== clientId) {
    throw cimdFetchFailure(clientId, `CIMD document client_id mismatch: expected ${clientId}, got ${doc.client_id}`);
  }

  // Reject shared-secret / non-public-client auth methods
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== "none") {
    throw cimdFetchFailure(
      clientId,
      `CIMD document uses unsupported token_endpoint_auth_method: ${doc.token_endpoint_auth_method}`
    );
  }

  if (doc.client_secret !== null && doc.client_secret !== undefined) {
    throw cimdFetchFailure(clientId, "CIMD document must not include client_secret (public clients only)");
  }

  validateCimdRedirectUris(doc, clientId);

  const securityHash = computeSecurityHash(doc);
  const securityRelevantMetadataChanged = Boolean(previousCached && previousCached.securityHash !== securityHash);

  if (securityRelevantMetadataChanged && previousCached) {
    cimdCache.delete(clientId);
    if (typeof onSecurityRelevantMetadataChange === "function") {
      await onSecurityRelevantMetadataChange({
        clientId,
        nextDoc: doc,
        nextSecurityHash: securityHash,
        previousDoc: previousCached.doc,
        previousSecurityHash: previousCached.securityHash,
      });
    }
  }

  // Determine TTL from cache headers, bounded by [min, max]
  const headerMaxAge = parseCacheControlMaxAge(response.headers);
  const ttl =
    headerMaxAge === null
      ? CIMD_CACHE_MIN_TTL_MS
      : Math.min(Math.max(headerMaxAge, CIMD_CACHE_MIN_TTL_MS), CIMD_CACHE_MAX_TTL_MS);

  cimdCache.set(clientId, { doc, expiresAt: nowMs + ttl, securityHash });

  return { doc, fromCache: false, securityHash, securityRelevantMetadataChanged };
}

/**
 * Invalidate the cache entry for a client_id (e.g. after security-relevant metadata change).
 */
export function invalidateCimdCache(clientId: string): void {
  cimdCache.delete(clientId);
}

/**
 * Build a synthetic "registered client" shape from a CIMD doc.
 * This mirrors the shape returned by getRegisteredClient() in auth.js.
 */
export function buildCimdRegisteredClient(clientId: string, doc: CimdDocument) {
  return {
    client_id: clientId,
    client_secret: null,
    created_at: null,
    metadata: {
      client_name: doc.client_name || null,
      client_uri: doc.client_uri || null,
      logo_uri: doc.logo_uri || null,
      redirect_uris: Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [],
      token_endpoint_auth_method: doc.token_endpoint_auth_method || "none",
    },
    registration_mode: "client_id_metadata_document",
    token_endpoint_auth_method: doc.token_endpoint_auth_method || "none",
    updated_at: null,
  };
}
