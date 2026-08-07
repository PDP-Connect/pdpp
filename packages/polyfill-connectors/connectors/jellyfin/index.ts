#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Jellyfin Connector (v0.1.0)
 *
 * Polyfills Jellyfin's v10.11.11+ REST API into the PDPP Collection Profile.
 * Reads JELLYFIN_BASE_URL and JELLYFIN_API_KEY from the environment. Emits RECORD/STATE/DONE
 * messages over stdout; reads START from stdin.
 *
 * Streams:
 *   libraries (Views, full inventory), items (paginated full inventory per run)
 *
 * State shape:
 *   {
 *     libraries: { fetched_at?: string, fingerprints?: { [id]: string } },
 *     items:     { [library_id]: { last_fetched_at?: string } },
 *   }
 *
 * Core API surfaces (REST):
 *   GET /System/Info — auth probe, server details
 *   GET /Users/Me — fetch current user ID
 *   GET /Users/{userId}/Views — libraries
 *   GET /Users/{userId}/Items — paginated items (StartIndex, Limit=500 max)
 *
 * Playback metadata (core API, no plugin):
 *   LastPlayedDate (single timestamp, nullable), PlayCount (integer), Played (boolean).
 *   PlaybackReporting plugin optional for session history (v1 scope does not include).
 *
 * Rate limit: None documented (self-hosted). Conservative 1000ms per-request pacing.
 *
 * Security:
 *   - Base URL must not contain userinfo (credentials in URL)
 *   - Allows http:// for localhost/127.0.0.1 (self-hosted), requires https:// otherwise
 *   - JSON responses bounded by Content-Length before parsing (max 50MB per response)
 *   - Pagination termination guarded by max-page limit (1000 pages per stream)
 *   - TotalRecordCount must be finite nonnegative integer, fail closed on missing/malformed
 */

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import { type CollectContext, nowIso, type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { jellyfinPacingProfile } from "../../src/provider-profile.ts";
import { validateItemsResponse, validateRecord, validateSystemInfo, validateViewsResponse } from "./schemas.ts";

// ─── Configuration ────────────────────────────────────────────────────────

let MAX_JSON_BYTES = 50 * 1024 * 1024; // 50MB per response (streaming byte cap, injectable for testing)
let MAX_PAGES_PER_STREAM = 1000; // Guard against infinite pagination (injectable for testing)

// ─── HTTP Governor ────────────────────────────────────────────────────────

const httpGovernor = createConnectorHttpGovernor({
  name: "jellyfin",
  maxAttempts: 1,
  profile: jellyfinPacingProfile(),
});

// ─── Jellyfin API Helper ──────────────────────────────────────────────────

/**
 * Validate base URL: reject userinfo, allow http only for loopback.
 * Normalizes the pathname to end with '/' so relative request paths
 * (see jellyfinRequest) resolve against it via new URL(path, base) without
 * discarding a subpath — e.g. a base of "https://host/jellyfin" (no trailing
 * slash) would otherwise have "jellyfin" treated as a filename and dropped
 * when joined, silently routing subpath-hosted instances to the wrong host root.
 */
function validateBaseUrl(urlStr: string): URL {
  const url = new URL(urlStr);

  if (url.username || url.password) {
    throw new Error("jellyfin_base_url_has_userinfo");
  }

  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol === "http:" && !isLoopback) {
    throw new Error("jellyfin_base_url_requires_https_non_loopback");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("jellyfin_base_url_unsafe_scheme");
  }

  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

/**
 * Make an authenticated request to the Jellyfin server.
 * Uses the httpGovernor for rate-limit compliance.
 * The owner-supplied baseUrl is treated as the intentional self-host target.
 * All requests are constrained to that origin (SSRF safety via origin check).
 * JSON responses are bounded by streaming byte cap (Content-Length is advisory only).
 * Throws on auth failure or non-2xx response.
 */
/**
 * Read a response body with an authoritative streaming byte cap — the cap
 * is enforced against bytes actually read, not the (possibly missing or
 * lying) Content-Length header.
 */
async function readBodyWithStreamingCap(body: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  let totalBytes = 0;

  const reader = body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BYTES) {
        throw new Error(`jellyfin_response_too_large_streaming: ${totalBytes} bytes exceeds ${MAX_JSON_BYTES}`);
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    reader.cancel();
    throw e;
  }

  return chunks.join("");
}

/** Reject a response whose advisory Content-Length header already exceeds the cap. */
function rejectOversizedContentLengthHeader(res: Response): void {
  const contentLength = res.headers.get("content-length");
  if (contentLength === null) {
    return;
  }
  const bytes = Number.parseInt(contentLength, 10);
  if (!Number.isNaN(bytes) && bytes > MAX_JSON_BYTES) {
    throw new Error(`jellyfin_response_too_large_header: ${bytes} bytes exceeds ${MAX_JSON_BYTES}`);
  }
}

async function fetchJellyfin(
  url: URL,
  apiKey: string
): Promise<{ body: string; headers?: { "retry-after": string }; status: number }> {
  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Emby-Token": apiKey,
    },
    redirect: "error", // Reject redirects
  });
  const retryAfter = res.headers.get("retry-after");

  // Check Content-Length header as advisory fast-reject (may be missing or wrong)
  rejectOversizedContentLengthHeader(res);

  // Read body with streaming byte cap (authoritative, Content-Length is advisory)
  const body = res.body === null ? "" : await readBodyWithStreamingCap(res.body);

  return {
    body,
    ...(retryAfter === null ? {} : { headers: { "retry-after": retryAfter } }),
    status: res.status,
  };
}

async function jellyfinRequest<T>(baseUrl: string, path: string, apiKey: string): Promise<T> {
  const base = validateBaseUrl(baseUrl);
  const url = new URL(path, base);

  // Constrain all requests to the owner-supplied baseUrl origin.
  // Do not follow redirects or allow cross-origin requests.
  if (url.origin !== base.origin) {
    throw new Error("jellyfin_ssrf_rejected_cross_origin");
  }

  // Use X-Emby-Token header instead of query param to avoid credential log-leakage
  const result = await httpGovernor.request<{ body: string; status: number }, { body: string; status: number }>(
    () => fetchJellyfin(url, apiKey),
    (raw) => ({ status: raw.status, value: raw })
  );

  if (result.value.status === 401 || result.value.status === 403) {
    throw new Error("jellyfin_auth_failed");
  }
  if (result.value.status < 200 || result.value.status >= 300) {
    throw new Error(`jellyfin_http_${String(result.value.status)}: ${result.value.body.slice(0, 200)}`);
  }
  return JSON.parse(result.value.body) as T;
}

/**
 * Validate TotalRecordCount: must be finite nonnegative integer.
 * Fail closed on missing/malformed/decreasing values.
 */
function validateTotalRecordCount(value: unknown, priorTotal?: number): number {
  if (typeof value !== "number") {
    throw new Error("jellyfin_total_record_count_not_number");
  }
  if (!Number.isFinite(value)) {
    throw new Error("jellyfin_total_record_count_not_finite");
  }
  if (value < 0) {
    throw new Error("jellyfin_total_record_count_negative");
  }
  if (Number.isInteger(value) === false) {
    throw new Error("jellyfin_total_record_count_not_integer");
  }
  // Detect decreasing counts (indicates malformed response or server bug)
  if (priorTotal !== undefined && value < priorTotal) {
    throw new Error(`jellyfin_total_record_count_decreased: ${value} < ${priorTotal}`);
  }
  return value;
}

/**
 * Fingerprint a page's full ordered item-ID sequence. A first-item-only
 * comparison false-positives when two genuinely distinct pages happen to
 * share a first item ID; comparing the whole ordered sequence does not.
 */
function pageFingerprint(pageItems: unknown[]): string {
  return pageItems.map((item) => String((item as Record<string, unknown>)?.Id ?? "")).join(" ");
}

// ─── Record Builders ──────────────────────────────────────────────────────

/**
 * Build a libraries record from a Jellyfin View.
 */
function libraryRecord(view: Record<string, unknown>, fetchedAt: string): RecordData {
  return {
    id: view.Id as string,
    name: view.Name as string,
    collection_type: (view.CollectionType ?? null) as string | null,
    fetched_at: fetchedAt,
  };
}

/**
 * Build an items record from a Jellyfin Item with UserData and library_id.
 */
function itemRecord(item: Record<string, unknown>, libraryId: string): RecordData {
  const userData = (item.UserData as Record<string, unknown> | null | undefined) ?? {};
  const playCount = (userData.PlayCount as number) ?? 0;
  const played = (userData.Played as boolean) ?? playCount > 0;
  const lastPlayedDate = (userData.LastPlayedDate as string | null | undefined) ?? null;

  // Build image URL if PrimaryImage tag exists
  let imageUrl: string | null = null;
  if (item.PrimaryImageTag) {
    imageUrl = `/Items/${item.Id as string}/Images/Primary?tag=${item.PrimaryImageTag as string}`;
  }

  // Extract provider IDs (ProviderIds from Jellyfin API)
  let providerIds: Record<string, string> | null = null;
  const providerIdsObj = item.ProviderIds as Record<string, unknown> | undefined;
  if (providerIdsObj && typeof providerIdsObj === "object") {
    const ids: Record<string, string> = {};
    for (const [key, val] of Object.entries(providerIdsObj)) {
      if (typeof val === "string") {
        ids[key] = val;
      }
    }
    if (Object.keys(ids).length > 0) {
      providerIds = ids;
    }
  }

  return {
    id: item.Id as string,
    library_id: libraryId,
    name: item.Name as string,
    type: (item.Type ?? null) as string | null,
    played,
    play_count: playCount,
    last_played_date: lastPlayedDate,
    image_url: imageUrl,
    genres: (item.Genres as string[]) ?? [],
    release_date: (item.PremiereDate ?? null) as string | null,
    provider_ids: providerIds,
    production_year: (item.ProductionYear ?? null) as number | null,
  };
}

/**
 * Open the per-record fingerprint cursor for the `libraries` stream.
 * Jellyfin libraries are static collections that don't change often, so
 * fingerprinting prevents re-emitting unchanged libraries across runs.
 * Exclude fetched_at from fingerprint since it changes on every run.
 */
function openLibraryCursor(state: Record<string, unknown>): FingerprintCursor {
  return openFingerprintCursor(state.libraries, {
    excludeFromFingerprint: ["fetched_at"],
  });
}

// ─── Main Collector ───────────────────────────────────────────────────────

interface JellyfinConn {
  apiKey: string;
  baseUrl: string;
  userId: string;
}

async function resolveUserId(baseUrl: string, apiKey: string): Promise<string> {
  const fallbackUserId = "00000000000000000000000000000000";
  try {
    const userResp = await jellyfinRequest<Record<string, unknown>>(baseUrl, "Users/Me", apiKey);
    return (userResp.Id as string) ?? fallbackUserId;
  } catch {
    // Fallback to default admin user if /Users/Me fails
    return fallbackUserId;
  }
}

async function fetchLibraries(conn: JellyfinConn): Promise<Record<string, unknown>[]> {
  const viewsResp = await jellyfinRequest<{ Items?: unknown[] }>(
    conn.baseUrl,
    `Users/${conn.userId}/Views`,
    conn.apiKey
  );
  const validatedViews = validateViewsResponse(viewsResp);
  return (validatedViews.Items ?? []) as Record<string, unknown>[];
}

async function collectLibraries(
  conn: JellyfinConn,
  ctx: Pick<CollectContext, "emit" | "emitRecord" | "progress" | "state">,
  now: string
): Promise<void> {
  const { state, emitRecord, emit, progress } = ctx;
  await progress("Fetching Jellyfin libraries", { stream: "libraries" });

  const libraryCursor = openLibraryCursor(state);
  const views = await fetchLibraries(conn);

  for (const view of views) {
    const rec = libraryRecord(view, now);
    if (libraryCursor.shouldEmit(rec)) {
      await emitRecord("libraries", rec);
    }
  }

  libraryCursor.pruneStale();
  if (!state.libraries || typeof state.libraries !== "object") {
    state.libraries = {};
  }
  (state.libraries as Record<string, unknown>).fetched_at = now;
  (state.libraries as Record<string, unknown>).fingerprints = libraryCursor.toState();

  await emit({ type: "STATE", stream: "libraries", cursor: state.libraries });
  await progress(`Fetched ${views.length} libraries`, { stream: "libraries", count: views.length });
}

/** Paginate a single library's items (500/page), guarding against non-advancing and runaway pagination. */
async function collectItemsForLibrary(
  conn: JellyfinConn,
  libraryId: string,
  ctx: Pick<CollectContext, "emitRecord">
): Promise<number> {
  const { emitRecord } = ctx;
  let startIndex = 0;
  const pageSize = 500;
  let hasMore = true;
  let pageCount = 0;
  let priorTotal: number | undefined;
  let lastPageFingerprint: string | undefined; // Full ordered-ID fingerprint of the previous page
  let emitted = 0;

  while (hasMore) {
    // Guard against infinite pagination (max pages configurable for testing)
    if (pageCount >= MAX_PAGES_PER_STREAM) {
      throw new Error(`jellyfin_max_pages_exceeded: library ${libraryId} exceeded ${MAX_PAGES_PER_STREAM} pages`);
    }

    const itemsPath = `Users/${conn.userId}/Items?ParentId=${libraryId}&StartIndex=${startIndex}&Limit=${pageSize}`;
    const itemsResp = await jellyfinRequest<{ Items?: unknown[]; TotalRecordCount?: unknown }>(
      conn.baseUrl,
      itemsPath,
      conn.apiKey
    );
    const validatedItems = validateItemsResponse(itemsResp);

    // Validate TotalRecordCount: must exist and be finite nonnegative integer
    if (validatedItems.TotalRecordCount === undefined || validatedItems.TotalRecordCount === null) {
      throw new Error(`jellyfin_total_record_count_missing: library ${libraryId} page ${pageCount}`);
    }
    const totalCount = validateTotalRecordCount(validatedItems.TotalRecordCount, priorTotal);
    priorTotal = totalCount;

    const pageItems = validatedItems.Items ?? [];

    // Detect actual repeated page: fingerprint the full ordered ID sequence,
    // not just the first item — two distinct pages that happen to share a
    // first item ID must not be misdetected as non-advancing.
    const currentPageFingerprint = pageFingerprint(pageItems);
    if (pageCount > 0 && pageItems.length > 0 && currentPageFingerprint === lastPageFingerprint) {
      throw new Error(
        `jellyfin_pagination_non_advancing: library ${libraryId} page ${pageCount} has same ordered item-ID sequence as page ${pageCount - 1}`
      );
    }

    for (const item of pageItems) {
      const rec = itemRecord(item as Record<string, unknown>, libraryId);
      await emitRecord("items", rec);
      emitted += 1;
    }

    lastPageFingerprint = currentPageFingerprint;

    startIndex += pageSize;
    hasMore = startIndex < totalCount;
    pageCount += 1;
  }

  return emitted;
}

async function collectItems(
  conn: JellyfinConn,
  ctx: Pick<CollectContext, "emit" | "emitRecord" | "progress" | "state">,
  now: string
): Promise<void> {
  const { state, emit, progress } = ctx;
  await progress("Fetching Jellyfin items", { stream: "items" });

  if (!state.items || typeof state.items !== "object") {
    state.items = {};
  }

  const views = await fetchLibraries(conn);
  let totalItemsEmitted = 0;

  for (const view of views) {
    const libraryId = (view as Record<string, string>)?.Id;
    if (!libraryId) {
      continue;
    }

    await progress("Fetching items from library", { stream: "items" });
    totalItemsEmitted += await collectItemsForLibrary(conn, libraryId, ctx);

    (state.items as Record<string, Record<string, unknown>>)[libraryId] = { last_fetched_at: now };
  }

  await emit({ type: "STATE", stream: "items", cursor: state.items });
  await progress(`Fetched ${totalItemsEmitted} items across all libraries`, {
    stream: "items",
    count: totalItemsEmitted,
  });
}

/** Map a collect() failure to a SKIP_RESULT reason for both streams. */
function skipReasonFor(message: string): { reason: string; message: string } {
  if (message === "jellyfin_auth_failed") {
    return { reason: "jellyfin_auth_failed", message: "Jellyfin API key or token invalid" };
  }
  if (message === "jellyfin_missing_credentials") {
    return { reason: "jellyfin_missing_credentials", message: "Missing JELLYFIN_BASE_URL and/or JELLYFIN_API_KEY" };
  }
  if (message.startsWith("jellyfin_http_")) {
    // HTTP errors during libraries fetch affect both; during items affect only items.
    // Since we can't easily distinguish, emit for both conservatively.
    return { reason: "jellyfin_http_error", message: `Jellyfin HTTP error: ${message}` };
  }
  return { reason: "jellyfin_error", message: `Jellyfin error: ${message}` };
}

async function emitErrorSkipResults(emit: CollectContext["emit"], error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const { reason, message: skipMessage } = skipReasonFor(message);
  for (const stream of ["libraries", "items"]) {
    await emit({ type: "SKIP_RESULT", stream, reason, message: skipMessage });
  }
}

async function collect(ctx: CollectContext): Promise<void> {
  const { credentials, requested, emit, progress } = ctx;

  const baseUrl = (credentials.base_url as string | undefined) ?? process.env.JELLYFIN_BASE_URL;
  const apiKey = (credentials.secret as string | undefined) ?? process.env.JELLYFIN_API_KEY;

  if (!(baseUrl && apiKey)) {
    throw new Error("jellyfin_missing_credentials");
  }

  const now = nowIso();

  try {
    // Auth probe: GET /System/Info
    await progress("Probing Jellyfin server");
    const sysInfo = await jellyfinRequest(baseUrl, "System/Info", apiKey);
    validateSystemInfo(sysInfo);
    await progress("Connected to Jellyfin server");

    const userId = await resolveUserId(baseUrl, apiKey);
    const conn: JellyfinConn = { baseUrl, apiKey, userId };

    if (requested.has("libraries")) {
      await collectLibraries(conn, ctx, now);
    }
    if (requested.has("items")) {
      await collectItems(conn, ctx, now);
    }
  } catch (error) {
    await emitErrorSkipResults(emit, error);
    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  runConnector({ name: "jellyfin", collect, validateRecord });
}

export { collect };
// Test-only exports (allow injection of config for testing without slow network calls)
export const __setMaxPagesPerStream = (n: number) => {
  MAX_PAGES_PER_STREAM = n;
};
export const __setMaxJsonBytes = (n: number) => {
  MAX_JSON_BYTES = n;
};
