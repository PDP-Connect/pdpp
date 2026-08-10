#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Jellyfin Connector (v0.1.0)
 *
 * Polyfills Jellyfin's v10.11.11+ REST API into the PDPP Collection Profile.
 *
 * Two coexisting auth paths, resolved in collect():
 *   PRIMARY (JELLYFIN_USERNAME + JELLYFIN_PASSWORD): POST
 *     /Users/AuthenticateByName. Available to ANY Jellyfin account — an API
 *     key is admin-dashboard-only and locks non-admins out of their own
 *     library entirely. The auth response carries both AccessToken and
 *     User.Id, so identity is never guessed.
 *   SECONDARY/ADVANCED (JELLYFIN_API_KEY, optional JELLYFIN_USER_ID): the
 *     original server-level API key path. Kept working for existing
 *     connections and for owners who already have an admin key. An API key
 *     authenticates the server but identifies no user, so a multi-user
 *     server additionally needs JELLYFIN_USER_ID (owner-supplied user id or
 *     username) or fails honestly rather than guessing.
 *
 * Emits RECORD/STATE/DONE messages over stdout; reads START from stdin.
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
 *   POST /Users/AuthenticateByName — primary-path auth; returns AccessToken
 *     and User.Id together, so the credential and the identity arrive in one
 *     call. Requires a well-formed `MediaBrowser Client=..., Device=...,
 *     DeviceId=..., Version=...` Authorization header — see
 *     buildMediaBrowserAuthHeader and jellyfin/jellyfin#11484 (a malformed
 *     header on this exact endpoint wipes the server's Devices table).
 *   GET /System/Info — auth probe, server details
 *   GET /Users — list users; used both to validate an owner-supplied user id
 *     or username, and as the exactly-one-user fallback (secondary path only)
 *   GET /Users/Me — the key's own "current user", if any (a dashboard API
 *     key has no such context and 400s here — see jellyfin/jellyfin#14559 —
 *     but a user-scoped token might succeed)
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
 *   - The password is never logged or persisted; only the resulting AccessToken
 *     is used for subsequent requests, via the header form (never ApiKey=/api_key=
 *     query params, which leak through server logs and browser history)
 */

import { createHash } from "node:crypto";
import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import {
  buildDetailCoverageMessage,
  type CollectContext,
  nowIso,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { jellyfinPacingProfile } from "../../src/provider-profile.ts";
import { validateItemsResponse, validateRecord, validateSystemInfo, validateViewsResponse } from "./schemas.ts";

// ─── Configuration ────────────────────────────────────────────────────────

let MAX_JSON_BYTES = 50 * 1024 * 1024; // 50MB per response (streaming byte cap, injectable for testing)
let MAX_PAGES_PER_STREAM = 1000; // Guard against infinite pagination (injectable for testing)

// Accepts an exact bare date, or a bare date followed by a structurally
// valid ISO-8601 time-of-day suffix (same time-component shape the
// libraries/items schemas' own ISO_DATETIME_RE accepts) — never an
// arbitrary trailing suffix. Used to normalize PremiereDate.
const DATE_OR_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?)?$/;

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

// ─── MediaBrowser Auth Header ─────────────────────────────────────────────

const MEDIA_BROWSER_CLIENT = "PDP-Connect";
const MEDIA_BROWSER_VERSION = "0.1.0";

/**
 * Build the well-formed `MediaBrowser Client=..., Device=..., DeviceId=...,
 * Version=...` Authorization header AuthenticateByName requires.
 *
 * NON-NEGOTIABLE SAFETY CONSTRAINT: a malformed header on this exact
 * endpoint is a known Jellyfin defect (jellyfin/jellyfin#11484) that wipes
 * the server's ENTIRE Devices table, and does not require admin rights to
 * trigger. Every field must be present and non-empty — pinned by
 * authenticate-by-name.test.ts so a future edit cannot silently drop one.
 */
function buildMediaBrowserAuthHeader(deviceId: string): string {
  if (!deviceId) {
    throw new Error("jellyfin_media_browser_device_id_empty");
  }
  return `MediaBrowser Client="${MEDIA_BROWSER_CLIENT}", Device="${MEDIA_BROWSER_CLIENT}", DeviceId="${deviceId}", Version="${MEDIA_BROWSER_VERSION}"`;
}

/**
 * Derive a stable per-connection DeviceId rather than a fresh random one per
 * run. AuthenticateByName registers a Devices-table row per distinct
 * DeviceId; a fresh UUID every run would grow that table unboundedly for a
 * connector that authenticates on a recurring schedule. The caller seeds
 * this with the connection's base URL + username, so repeated runs of the
 * same connection consistently reuse one device entry.
 */
function deriveStableDeviceId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
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

interface AuthenticateByNameResult {
  accessToken: string;
  userId: string;
}

function userHasId(user: Record<string, unknown> | undefined): user is Record<string, unknown> & { Id: string } {
  return user !== undefined && typeof user.Id === "string" && user.Id.length > 0;
}

async function postAuthenticateByName(
  url: URL,
  username: string,
  password: string,
  mediaBrowserHeader: string
): Promise<{ body: string; status: number }> {
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mediaBrowserHeader,
    },
    // Header auth only. Never the ApiKey=/api_key= query form, which leaks
    // through server logs and browser history.
    body: JSON.stringify({ Username: username, Pw: password }),
    redirect: "error",
  });

  rejectOversizedContentLengthHeader(res);
  const body = res.body === null ? "" : await readBodyWithStreamingCap(res.body);
  return { body, status: res.status };
}

/**
 * Primary auth path: POST /Users/AuthenticateByName. Available to ANY
 * Jellyfin account (unlike an API key, which only an admin can generate).
 * The response carries both AccessToken and User.Id in one call, so identity
 * resolution is never a separate guess.
 *
 * SAFETY: always sends a well-formed MediaBrowser Authorization header — a
 * malformed one on this exact endpoint wipes the server's Devices table
 * (jellyfin/jellyfin#11484), and that defect does not require admin rights.
 * See buildMediaBrowserAuthHeader.
 *
 * Never swallows a failed auth into a fabricated identity: a non-2xx
 * response throws jellyfin_auth_failed carrying the real HTTP status, and a
 * response with a valid status but a missing AccessToken/User.Id throws
 * rather than proceeding with an absent credential.
 */
async function authenticateByName(
  baseUrl: string,
  username: string,
  password: string,
  deviceId: string
): Promise<AuthenticateByNameResult> {
  const base = validateBaseUrl(baseUrl);
  const url = new URL("Users/AuthenticateByName", base);
  if (url.origin !== base.origin) {
    throw new Error("jellyfin_ssrf_rejected_cross_origin");
  }

  const mediaBrowserHeader = buildMediaBrowserAuthHeader(deviceId);

  const result = await httpGovernor.request<{ body: string; status: number }, { body: string; status: number }>(
    () => postAuthenticateByName(url, username, password, mediaBrowserHeader),
    (raw) => ({ status: raw.status, value: raw })
  );

  if (result.value.status === 401 || result.value.status === 403) {
    throw new Error("jellyfin_auth_failed");
  }
  if (result.value.status < 200 || result.value.status >= 300) {
    throw new Error(`jellyfin_http_${String(result.value.status)}: ${result.value.body.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.value.body);
  } catch {
    // biome-ignore lint/style/useErrorCause: intentional — JSON.parse's error can echo a snippet of the response body, which is not useful beyond the message below
    throw new Error("jellyfin_authenticate_by_name_response_malformed: response was not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("jellyfin_authenticate_by_name_response_malformed: response was not an object");
  }
  const resp = parsed as Record<string, unknown>;
  const accessToken = typeof resp.AccessToken === "string" ? resp.AccessToken : "";
  const user = resp.User as Record<string, unknown> | undefined;
  if (!accessToken) {
    throw new Error("jellyfin_authenticate_by_name_no_access_token: response had no AccessToken");
  }
  if (!userHasId(user)) {
    throw new Error("jellyfin_authenticate_by_name_no_user_id: response had no User.Id");
  }

  return { accessToken, userId: user.Id };
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
 * Is (year, month, day) a real UTC calendar date? Constructs the date via
 * Date.UTC (never the local-timezone Date constructor, so this never
 * timezone-shifts the input) and checks the result's UTC fields round-trip
 * exactly — JS Date silently overflows invalid components (e.g. month 99 or
 * Feb 30 rolls forward into a later real date) rather than rejecting them,
 * so a round-trip mismatch is what catches that.
 */
function isRealUtcCalendarDate(year: number, month: number, day: number): boolean {
  const ms = Date.UTC(year, month - 1, day);
  const rebuilt = new Date(ms);
  return rebuilt.getUTCFullYear() === year && rebuilt.getUTCMonth() === month - 1 && rebuilt.getUTCDate() === day;
}

/**
 * Normalize Jellyfin's `PremiereDate` to the `items.release_date` schema's
 * bare `YYYY-MM-DD` shape. Jellyfin serializes PremiereDate as a full
 * .NET DateTime round-trip string (e.g. "1994-09-23T00:00:00.0000000Z"),
 * never a bare date — the schema's own regex source (schemas.ts) expects
 * only the date portion, so the leading `YYYY-MM-DD` is extracted here
 * rather than relaxing the schema to accept a shape release_date was never
 * meant to carry.
 *
 * Only two input shapes are accepted: an exact bare date, or a bare date
 * followed by a structurally valid ISO-8601 time-of-day suffix. An
 * arbitrary trailing suffix (e.g. "2021-01-01garbage") is NOT a datetime
 * and is rejected, not silently truncated to its leading digits. The
 * extracted date is also checked against the real UTC calendar (rejects
 * e.g. "2021-99-99" and "2021-02-30") so a structurally-shaped but
 * impossible date cannot pass through.
 *
 * Absence is preserved honestly: missing/null/non-string/unparseable/
 * impossible-calendar-date input becomes null rather than a fabricated
 * date, and a value that merely doesn't parse does not discard the rest of
 * the record — only this field degrades to null.
 */
function normalizeReleaseDate(premiereDate: unknown): string | null {
  if (typeof premiereDate !== "string") {
    return null;
  }
  const match = premiereDate.match(DATE_OR_DATETIME_RE);
  if (!match) {
    return null;
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!isRealUtcCalendarDate(year, month, day)) {
    return null;
  }
  return `${yearStr}-${monthStr}-${dayStr}`;
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
    release_date: normalizeReleaseDate(item.PremiereDate),
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

/** Max number of display names to include in an ambiguous-user error, to avoid dumping the whole roster. */
const AMBIGUOUS_USER_SAMPLE_SIZE = 5;

/**
 * Build the improved ambiguous-user error: names a bounded sample of display
 * names (never IDs — those can be sensitive) so the owner knows what to type
 * into the new setup field, and names the field itself.
 */
function ambiguousUserError(users: readonly Record<string, unknown>[]): Error {
  const sampleNames = users
    .map((user) => (typeof user.Name === "string" ? user.Name : null))
    .filter((name): name is string => name !== null)
    .slice(0, AMBIGUOUS_USER_SAMPLE_SIZE);
  const sampleText = sampleNames.length > 0 ? ` Available users include: ${sampleNames.join(", ")}.` : "";
  return new Error(
    `jellyfin_ambiguous_user: Users list returned ${users.length} users; an API key does not identify which one to collect as.${sampleText} ` +
      "Recommended fix: switch this connection to Username/Password sign-in instead — it identifies you " +
      "automatically and needs no extra field. Or, to keep using the API key, set the 'Jellyfin User ID or " +
      "Username' field on this connection to the user you want to collect as."
  );
}

/**
 * Resolve a user ID from an owner-supplied identifier against the Users
 * list. Accepts either a user ID (matched against Id) or a username
 * (matched against Name, case-insensitively) — the manifest field's help
 * text tells the owner either is acceptable. Never guesses: an identifier
 * that doesn't match any user fails the run rather than silently falling
 * through to a different resolution branch.
 */
function resolveOwnerSuppliedUserId(ownerSupplied: string, users: readonly Record<string, unknown>[]): string {
  const byId = users.find((user) => user.Id === ownerSupplied);
  if (userHasId(byId)) {
    return byId.Id;
  }
  const needle = ownerSupplied.toLowerCase();
  const byName = users.find((user) => typeof user.Name === "string" && user.Name.toLowerCase() === needle);
  if (userHasId(byName)) {
    return byName.Id;
  }
  throw new Error(
    `jellyfin_configured_user_not_found: no user with id or username '${ownerSupplied}' was found on this server; ` +
      "check the 'Jellyfin User ID or Username' field on this connection"
  );
}

/**
 * Pick the user ID to collect as from the Users list alone (no owner-supplied
 * hint, no usable Users/Me). A single-user server has one unambiguous
 * answer; a multi-user server has no signal for which user a bare API key
 * represents, so this fails rather than guessing one owner's data out of
 * several.
 */
function pickUserId(users: readonly Record<string, unknown>[]): string {
  if (users.length === 0) {
    throw new Error("jellyfin_no_users: Users list returned no users");
  }
  if (users.length > 1) {
    throw ambiguousUserError(users);
  }
  const [user] = users;
  if (!userHasId(user)) {
    throw new Error("jellyfin_user_id_missing: Users response had no Id field");
  }
  return user.Id;
}

/**
 * Try `Users/Me`. Dashboard-issued API keys have no "current user" context
 * and 400 here even though the same key authenticates fine elsewhere
 * (confirmed against jellyfin/jellyfin#14559; System/Info succeeds, Users/Me
 * does not) — that specific shape is treated as "no concrete user available"
 * rather than a hard failure, since a user-scoped token might succeed here
 * where a server-level key cannot. Any other failure (auth, network, 5xx)
 * propagates, since those are real problems, not an absent-signal case.
 */
async function tryUsersMe(baseUrl: string, apiKey: string): Promise<string | undefined> {
  let resp: unknown;
  try {
    resp = await jellyfinRequest<unknown>(baseUrl, "Users/Me", apiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("jellyfin_http_400") || message.startsWith("jellyfin_http_404")) {
      return;
    }
    throw error;
  }
  if (resp === null || typeof resp !== "object") {
    return;
  }
  const user = resp as Record<string, unknown>;
  return userHasId(user) ? user.Id : undefined;
}

/**
 * Resolve the user ID to collect as, most helpful first:
 *   (a) owner-supplied id/username, matched against the Users list
 *   (b) Users/Me, if it returns a concrete user (rare for a server-level key)
 *   (c) the Users list, if it has exactly one user — unambiguous
 *   (d) otherwise fail honestly, naming a sample of users and the field to set
 *
 * Never fabricates an ID: any path that can't produce a confirmed real user
 * ID fails the run carrying that real reason — a placeholder ID would make
 * every downstream Users/{id}/Views and Users/{id}/Items call 400, replacing
 * the true cause (auth shape, unsupported endpoint, malformed response, no
 * matching user) with a misleading generic error from a fabricated identity.
 */
async function resolveUserId(baseUrl: string, apiKey: string, ownerSuppliedUserId?: string): Promise<string> {
  const usersResp = await jellyfinRequest<unknown>(baseUrl, "Users", apiKey);
  if (!Array.isArray(usersResp)) {
    throw new Error("jellyfin_users_response_malformed: Users response was not an array");
  }
  const users = usersResp as Record<string, unknown>[];

  if (ownerSuppliedUserId) {
    return resolveOwnerSuppliedUserId(ownerSuppliedUserId, users);
  }

  const meUserId = await tryUsersMe(baseUrl, apiKey);
  if (meUserId !== undefined) {
    return meUserId;
  }

  return pickUserId(users);
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
): Promise<{ considered: number; emitted: number }> {
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

  // `priorTotal` holds the last validated `TotalRecordCount` — the source's own
  // inventory size for this library, already load-bearing for the pagination
  // stop above. A library that paginated at least once always has it; the
  // `?? 0` only covers the unreachable no-page case (the loop runs at least
  // once and throws when the field is missing).
  return { considered: priorTotal ?? 0, emitted };
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
  let totalItemsConsidered = 0;

  for (const view of views) {
    const libraryId = (view as Record<string, string>)?.Id;
    if (!libraryId) {
      continue;
    }

    await progress("Fetching items from library", { stream: "items" });
    const library = await collectItemsForLibrary(conn, libraryId, ctx);
    totalItemsEmitted += library.emitted;
    totalItemsConsidered += library.considered;

    (state.items as Record<string, Record<string, unknown>>)[libraryId] = { last_fetched_at: now };
  }

  await emit({ type: "STATE", stream: "items", cursor: state.items });
  // The denominator is the sum of each library's source-reported
  // `TotalRecordCount`, measured at the pagination site and independent of what
  // was emitted. `items` has no unchanged-suppression lane — every paged item is
  // emitted — so `emitted` is the honest covered numerator, and a library that
  // reported more items than it served reads partial rather than complete.
  await emit(
    buildDetailCoverageMessage({
      stream: "items",
      stateStream: "items",
      requiredKeys: [],
      hydratedKeys: [],
      considered: totalItemsConsidered,
      covered: totalItemsEmitted,
    })
  );
  await progress(`Fetched ${totalItemsEmitted} items across all libraries`, {
    stream: "items",
    count: totalItemsEmitted,
  });
}

/** Map a collect() failure to a SKIP_RESULT reason for both streams. */
function skipReasonFor(message: string): { reason: string; message: string } {
  if (message === "jellyfin_auth_failed") {
    return { reason: "jellyfin_auth_failed", message: "Jellyfin username/password or API key invalid" };
  }
  if (message === "jellyfin_missing_credentials") {
    return {
      reason: "jellyfin_missing_credentials",
      message:
        "Missing JELLYFIN_BASE_URL and either JELLYFIN_USERNAME+JELLYFIN_PASSWORD (recommended — works for " +
        "any account) or JELLYFIN_API_KEY (admin-only, advanced)",
    };
  }
  if (message.startsWith("jellyfin_authenticate_by_name_")) {
    return { reason: "jellyfin_auth_failed", message: `Jellyfin sign-in failed: ${message}` };
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

/**
 * Resolve which of the two credential paths to use and produce the
 * connection to collect with. Never fabricates a token or a user: an
 * incomplete primary-path pair (only one of username/password present) is
 * treated as absent rather than silently falling through to the api_key
 * path with half the intended credential ignored.
 *
 * PRIMARY (username + password present): AuthenticateByName. The response
 * carries both the access token and User.Id, so userId comes free — the
 * owner never supplies one for this path.
 *
 * SECONDARY/ADVANCED (api_key present, primary absent): the original
 * server-level API key path. Since an API key does not identify a user,
 * resolveUserId still runs its owner-supplied-id / Users-Me / single-user
 * resolution chain, and fails honestly (pointing at the primary path as the
 * remedy) when the server has more than one user and none of those signals
 * resolve.
 */
async function resolveConnection(
  baseUrl: string,
  username: string | undefined,
  password: string | undefined,
  apiKey: string | undefined,
  ownerSuppliedUserId: string | undefined,
  progress: CollectContext["progress"]
): Promise<JellyfinConn> {
  if (username && password) {
    await progress("Signing in to Jellyfin with username and password");
    const deviceId = deriveStableDeviceId(`${baseUrl} ${username}`);
    const { accessToken, userId } = await authenticateByName(baseUrl, username, password, deviceId);
    await progress("Signed in to Jellyfin");
    return { baseUrl, apiKey: accessToken, userId };
  }

  if (apiKey) {
    await progress("Probing Jellyfin server");
    const sysInfo = await jellyfinRequest(baseUrl, "System/Info", apiKey);
    validateSystemInfo(sysInfo);
    await progress("Connected to Jellyfin server");

    const userId = await resolveUserId(baseUrl, apiKey, ownerSuppliedUserId);
    return { baseUrl, apiKey, userId };
  }

  throw new Error("jellyfin_missing_credentials");
}

async function collect(ctx: CollectContext): Promise<void> {
  const { credentials, requested, emit, progress } = ctx;

  const baseUrl = (credentials.base_url as string | undefined) ?? process.env.JELLYFIN_BASE_URL;
  const username = (credentials.username as string | undefined) ?? process.env.JELLYFIN_USERNAME;
  const password = (credentials.password as string | undefined) ?? process.env.JELLYFIN_PASSWORD;
  const apiKey = (credentials.secret as string | undefined) ?? process.env.JELLYFIN_API_KEY;
  const ownerSuppliedUserId = (credentials.jellyfin_user_id as string | undefined) ?? process.env.JELLYFIN_USER_ID;

  if (!(baseUrl && ((username && password) || apiKey))) {
    throw new Error("jellyfin_missing_credentials");
  }

  const now = nowIso();

  try {
    const conn = await resolveConnection(baseUrl, username, password, apiKey, ownerSuppliedUserId, progress);

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
export { buildMediaBrowserAuthHeader, deriveStableDeviceId, normalizeReleaseDate };
