// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor and request-boundary rules for the reference connector-summary
 * identity feed. The cursor deliberately contains only immutable inventory
 * facts and a non-reversible owner-scope digest; mutable summary evidence is
 * not a continuation key.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveCredentialEncryptionKey } from "../../server/stores/credential-encryption.ts";

export const CONNECTOR_SUMMARY_PAGE_LIMIT_MAX = 100;
/** Accepted maximum for a repeated `connector_id` SET scope (R4/design doc "Minimal contract"). Same deliberate ceiling as the page size. */
export const CONNECTOR_SUMMARY_PAGE_CONNECTOR_ID_SET_MAX = 100;
const CONNECTOR_SUMMARY_CURSOR_VERSION = 1;
const CONNECTOR_SUMMARY_CURSOR_PREFIX = "rcs1.";
const CURSOR_IV_BYTES = 12;
const CURSOR_TAG_BYTES = 16;
const CURSOR_KEY_DOMAIN = "pdpp.ref-connectors-page.cursor.v1";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export interface ConnectorIdentityPageBoundary {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt: string;
}

/**
 * Named semantic profiles selecting which dependency families
 * `listConnectorSummaryPage` loads and which fields it synthesizes
 * (Fable ruling §8, R8.1: "one operation, one projection, no new route").
 * `identity_inventory`: pure connection identity + stream membership, no
 * health/evidence/runtime fields. `retained_count_summary` (design doc
 * add-source-perf-design-agy-0730.md, R4/R5, R8-style option-gating):
 * identity + `total_records`/`total_records_state`/
 * `acquisition_coverage.latest_batch` only — the exact Add Source field set,
 * nothing else. Omitting `profile` preserves the full (`detail`-shaped)
 * response exactly as before.
 */
export type ConnectorSummaryPageProfile = "identity_inventory" | "retained_count_summary";

/**
 * A `connector_id` scope on the page request: `null` = unfiltered fleet
 * page (unchanged prior behavior); a single string = the original one-id
 * filter; a readonly array = the bounded repeated-value SET scope (design
 * doc "Minimal contract" — `?connector_id=A&connector_id=B&...`), 1..
 * {@link CONNECTOR_SUMMARY_PAGE_CONNECTOR_ID_SET_MAX} canonical distinct ids.
 */
export type ConnectorIdScope = string | readonly string[] | null;

export interface ConnectorSummaryPageRequest {
  readonly connectorId: ConnectorIdScope;
  readonly cursor: ConnectorIdentityPageBoundary | null;
  /** Ask for a fleet verdict only when this exact bounded identity page is terminal. */
  readonly includeFleetHealth: boolean;
  readonly limit: number;
  /** `undefined` = full profile (unchanged prior behavior). */
  readonly profile?: ConnectorSummaryPageProfile;
  /**
   * The owner Sources page's exclusive opt-in: excludes a pure recovered
   * historical fragment from this identity page BEFORE `LIMIT`, so `has_more`/
   * the next cursor are authoritative over the rows this page actually
   * renders (never a post-LIMIT filter). Every other caller (Explore's
   * connection-facet listing, Add Source, manual upload) omits this and gets
   * the unchanged unfiltered page — a hidden fragment's connection facet and
   * already-ingested records stay reachable there. Mutually exclusive with
   * `connectorId`/`profile`, which the Sources page never supplies.
   */
  readonly sourcesVisibility: boolean;
}

export class ConnectorSummaryPageRequestError extends Error {
  readonly code = "invalid_request";
  readonly param: "cursor" | "include_fleet_health" | "limit" | "profile" | "sources_visibility";

  constructor(param: "cursor" | "include_fleet_health" | "limit" | "profile" | "sources_visibility", message: string) {
    super(message);
    this.name = "ConnectorSummaryPageRequestError";
    this.param = param;
  }
}

export class ConnectorSummaryPageCursorError extends Error {
  readonly code = "invalid_cursor";
  readonly param = "cursor";

  constructor(message = "Connector summary cursor is invalid", options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectorSummaryPageCursorError";
  }
}

/**
 * Canonical, order-independent scope fingerprint for a `connector_id` filter:
 * `null` (unfiltered) → `""`; a single string → itself (byte-identical to the
 * pre-set-scope digest, so an existing single-id cursor keeps resolving); a
 * SET → its distinct members sorted and joined with `\0` (a byte no
 * canonical connector id can contain), so `[A, B]` and `[B, A]` fingerprint
 * identically and a set cursor can never be replayed against a different or
 * reordered set.
 */
function connectorIdScopeFingerprint(connectorId: ConnectorIdScope): string {
  if (connectorId === null) {
    return "";
  }
  if (typeof connectorId === "string") {
    return connectorId;
  }
  return [...new Set(connectorId)].sort().join("\0");
}

/**
 * Fingerprint segment for the Sources page's `sources_visibility` opt-in.
 * SECURITY-LOAD-BEARING (review finding, 2026-08-15): without this bound into
 * the scope digest, a cursor issued by the unfiltered/Explore page (which
 * walks EVERY owner-visible connection, including a pure recovered
 * historical fragment) could be replayed on the Sources page (whose identity
 * page skips those fragments before LIMIT), or the reverse. Either boundary
 * tuple (connectorId/createdAt/connectorInstanceId) from one page's keyset
 * ordering does not correspond to a valid resume position in the OTHER
 * page's ordering once rows are excluded — a cross-surface replay can skip
 * visible rows just past a hidden fragment, or leak a fragment into view one
 * position "behind" where the other surface's page actually resumed.
 */
function sourcesVisibilityFingerprint(sourcesVisibility: boolean): string {
  return sourcesVisibility ? "sources_visibility" : "";
}

// The `connectorId` scope and the `sourcesVisibility` surface flag are bound
// into the SAME scope digest as the owner subject: a cursor issued while
// filtering by one connector (or one SET of connectors), or issued by the
// Sources-only visibility-filtered page, must not resolve under a request
// that omits the filter, names a different connector, names a different
// set, or crosses the Sources/unfiltered surface boundary — an unrelated
// identity page would render as this filter's "next page" and silently mix
// scopes (Perf-2026-07-29 client-gate requirement: "must not combine
// ambiguously"; the same reasoning was extended to the sources_visibility
// surface boundary per the 2026-08-15 review finding). ` ` is a safe
// separator since neither an owner subject id, a connector id, nor the
// fixed `sources_visibility` token can contain it (see `isNonEmptyString` at
// every read site that treats non-empty ASCII-safe strings as the trusted
// boundary here).
function scopeDigest(ownerSubjectId: string, connectorId: ConnectorIdScope, sourcesVisibility: boolean): Buffer {
  return createHash("sha256")
    .update(
      `pdpp-ref-connectors-page-v1:${ownerSubjectId} ${connectorIdScopeFingerprint(connectorId)} ${sourcesVisibilityFingerprint(sourcesVisibility)}`
    )
    .digest();
}

function cursorEncryptionKey(keyMaterial?: string): Buffer {
  const configured = keyMaterial ?? resolveCredentialEncryptionKey();
  if (!configured) {
    throw new ConnectorSummaryPageCursorError("Connector summary cursor key is not configured");
  }
  // Credential storage and pagination deliberately share the operator's key
  // provider, but never cipher bytes. Domain separation makes a compromise of
  // one protocol artifact unusable as the other.
  return createHash("sha256").update(`${CURSOR_KEY_DOMAIN}\n${configured}`).digest();
}

function decodeCanonicalBase64Url(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || !BASE64URL.test(value)) {
    throw new ConnectorSummaryPageCursorError();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new ConnectorSummaryPageCursorError();
  }
  return decoded;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseProfile(rawProfile: unknown): ConnectorSummaryPageProfile | undefined {
  if (rawProfile === undefined) {
    return;
  }
  if (rawProfile !== "identity_inventory" && rawProfile !== "retained_count_summary") {
    throw new ConnectorSummaryPageRequestError(
      "profile",
      "profile must be one of: identity_inventory, retained_count_summary"
    );
  }
  return rawProfile;
}

function parseIncludeFleetHealth(rawIncludeFleetHealth: unknown): boolean {
  if (rawIncludeFleetHealth === undefined) {
    return false;
  }
  if (rawIncludeFleetHealth !== "0" && rawIncludeFleetHealth !== "1") {
    throw new ConnectorSummaryPageRequestError("include_fleet_health", "include_fleet_health must be 0 or 1");
  }
  return rawIncludeFleetHealth === "1";
}

function parseSourcesVisibility(
  rawSourcesVisibility: unknown,
  connectorId: ConnectorIdScope,
  profile: ConnectorSummaryPageProfile | undefined
): boolean {
  if (rawSourcesVisibility === undefined) {
    return false;
  }
  if (rawSourcesVisibility !== "0" && rawSourcesVisibility !== "1") {
    throw new ConnectorSummaryPageRequestError("sources_visibility", "sources_visibility must be 0 or 1");
  }
  const enabled = rawSourcesVisibility === "1";
  if (enabled && (connectorId !== null || profile !== undefined)) {
    throw new ConnectorSummaryPageRequestError(
      "sources_visibility",
      "sources_visibility is available only on the unfiltered, no-profile connector-summary list"
    );
  }
  return enabled;
}

/**
 * Parse the `connector_id` query value into a scope. A bare repeated query
 * form (`?connector_id=A&connector_id=B`) arrives here as a JS array from the
 * host's query-string parsing (Express's default `qs` behavior) — a single
 * occurrence arrives as a plain string, preserving the original one-id
 * filter's exact request/cursor shape. A 1-element array is treated as the
 * single-id filter (not a set), so an existing single-id caller that happens
 * to be routed through array-producing middleware is unaffected.
 *
 * Design doc "Minimal contract": the accepted maximum is
 * {@link CONNECTOR_SUMMARY_PAGE_CONNECTOR_ID_SET_MAX} distinct CANONICAL ids.
 * Deduplication happens AFTER canonicalization (`canonicalizeId`, supplied by
 * the host so this operation module never imports the connector-key
 * substrate) — a duplicate-after-canonicalization set is a typed invalid
 * request (design doc "Canonicalize... Deduplicate after canonicalization;
 * reject duplicates rather than making cursor scope ambiguous").
 */
function parseConnectorIdFilter(rawConnectorId: unknown, canonicalizeId: (id: string) => string): ConnectorIdScope {
  if (rawConnectorId === undefined) {
    return null;
  }
  if (isNonEmptyString(rawConnectorId)) {
    return rawConnectorId;
  }
  if (!Array.isArray(rawConnectorId)) {
    throw new ConnectorSummaryPageRequestError("limit", "connector_id must be a non-empty string");
  }
  if (rawConnectorId.length === 0) {
    throw new ConnectorSummaryPageRequestError("limit", "connector_id must not be an empty set");
  }
  if (!rawConnectorId.every(isNonEmptyString)) {
    throw new ConnectorSummaryPageRequestError("limit", "every connector_id in the set must be a non-empty string");
  }
  if (rawConnectorId.length === 1) {
    // A single-element repeated form is the single-id filter, byte-identical
    // request/cursor shape to the pre-existing `?connector_id=A` case.
    return rawConnectorId[0] as string;
  }
  if (rawConnectorId.length > CONNECTOR_SUMMARY_PAGE_CONNECTOR_ID_SET_MAX) {
    throw new ConnectorSummaryPageRequestError(
      "limit",
      `connector_id set must contain at most ${CONNECTOR_SUMMARY_PAGE_CONNECTOR_ID_SET_MAX} distinct canonical ids`
    );
  }
  const canonical = (rawConnectorId as string[]).map(canonicalizeId);
  const distinct = new Set(canonical);
  if (distinct.size !== canonical.length) {
    throw new ConnectorSummaryPageRequestError(
      "limit",
      "connector_id set must not contain duplicate ids after canonicalization"
    );
  }
  return canonical;
}

/**
 * Parse an explicit page request. `null` means compatibility-list mode.
 * `canonicalizeId` defaults to the identity function so every existing
 * single-id caller (whose value already arrives pre-canonicalized at the
 * route boundary) is unaffected; a SET scope always canonicalizes each
 * member through it before deduplicating.
 */
export function parseConnectorSummaryPageRequest(
  query: Readonly<Record<string, unknown>>,
  ownerSubjectId: string,
  canonicalizeId: (id: string) => string = (id) => id
): ConnectorSummaryPageRequest | null {
  const rawLimit = query.limit;
  const rawCursor = query.cursor;
  const rawConnectorId = query.connector_id;
  const rawIncludeFleetHealth = query.include_fleet_health;
  const rawProfile = query.profile;
  const rawSourcesVisibility = query.sources_visibility;
  const hasLimit = rawLimit !== undefined;
  const hasCursor = rawCursor !== undefined;
  const hasConnectorId = rawConnectorId !== undefined;
  const hasIncludeFleetHealth = rawIncludeFleetHealth !== undefined;
  const hasProfile = rawProfile !== undefined;
  const hasSourcesVisibility = rawSourcesVisibility !== undefined;
  if (!(hasLimit || hasCursor || hasConnectorId || hasIncludeFleetHealth || hasProfile || hasSourcesVisibility)) {
    return null;
  }
  if (!hasLimit) {
    throw new ConnectorSummaryPageRequestError(
      "limit",
      hasCursor ? "limit is required when cursor is supplied" : "limit is required when connector_id is supplied"
    );
  }
  if (typeof rawLimit !== "string" || !POSITIVE_INTEGER.test(rawLimit)) {
    throw new ConnectorSummaryPageRequestError("limit", "limit must be a positive integer");
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > CONNECTOR_SUMMARY_PAGE_LIMIT_MAX) {
    throw new ConnectorSummaryPageRequestError(
      "limit",
      `limit must be no greater than ${CONNECTOR_SUMMARY_PAGE_LIMIT_MAX}`
    );
  }
  const includeFleetHealth = parseIncludeFleetHealth(rawIncludeFleetHealth);
  const connectorId = parseConnectorIdFilter(rawConnectorId, canonicalizeId);
  const profile = parseProfile(rawProfile);
  const sourcesVisibility = parseSourcesVisibility(rawSourcesVisibility, connectorId, profile);
  if (!hasCursor) {
    return { connectorId, cursor: null, includeFleetHealth, limit, sourcesVisibility, ...(profile ? { profile } : {}) };
  }
  if (!isNonEmptyString(rawCursor)) {
    throw new ConnectorSummaryPageCursorError();
  }
  return {
    connectorId,
    cursor: decodeConnectorSummaryPageCursor(rawCursor, ownerSubjectId, connectorId, undefined, sourcesVisibility),
    includeFleetHealth,
    limit,
    sourcesVisibility,
    ...(profile ? { profile } : {}),
  };
}

/**
 * Encode an opaque, versioned continuation for one owner, identity tuple, and
 * (when the page was filtered) the exact `connector_id` scope that produced
 * it. `connectorIdFilter` defaults to `null` (unfiltered, fleet-wide page) —
 * every existing caller that omits it preserves the exact prior cursor scope.
 * The cursor stores the scope's canonical FINGERPRINT (`f`), not raw user
 * ordering (design doc: "a canonical ordered scope-set fingerprint, not raw
 * user ordering") — a set supplied in a different order round-trips to the
 * SAME cursor scope. `sourcesVisibility` defaults to `false` (the unfiltered/
 * Explore page) — every existing caller that omits it preserves the exact
 * prior cursor scope; the Sources page is the only caller that passes `true`.
 */
export function encodeConnectorSummaryPageCursor(
  boundary: ConnectorIdentityPageBoundary,
  ownerSubjectId: string,
  keyMaterial?: string,
  connectorIdFilter: ConnectorIdScope = null,
  sourcesVisibility = false
): string {
  const payload = Buffer.from(
    JSON.stringify({
      c: boundary.connectorId,
      f: connectorIdScopeFingerprint(connectorIdFilter),
      i: boundary.connectorInstanceId,
      s: scopeDigest(ownerSubjectId, connectorIdFilter, sourcesVisibility).toString("base64url"),
      t: boundary.createdAt,
      v: CONNECTOR_SUMMARY_CURSOR_VERSION,
      w: sourcesVisibilityFingerprint(sourcesVisibility),
    })
  );
  const iv = randomBytes(CURSOR_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", cursorEncryptionKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return `${CONNECTOR_SUMMARY_CURSOR_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

/**
 * Decode and scope-check a connector-summary continuation without logging it.
 * `connectorIdFilter` is the CURRENT request's `connector_id` scope (`null`
 * when absent) — its canonical fingerprint must exactly match the fingerprint
 * the cursor was issued under (bound into the same scope digest as the owner
 * subject), so a cursor from a connector- or connector-SET-filtered page
 * cannot be replayed against an unfiltered request, a different connector's
 * page, a different set, or a reordered-but-different set. `sourcesVisibility`
 * is the CURRENT request's `sources_visibility` opt-in (`false` when absent)
 * — bound into the same scope digest, so a cursor issued by the Sources page
 * cannot be replayed against the unfiltered/Explore page, and vice versa
 * (2026-08-15 review finding: without this, a cross-surface replay could skip
 * visible rows or leak a hidden fragment past the exclusion).
 */
export function decodeConnectorSummaryPageCursor(
  cursor: string,
  ownerSubjectId: string,
  connectorIdFilter: ConnectorIdScope = null,
  keyMaterial?: string,
  sourcesVisibility = false
): ConnectorIdentityPageBoundary {
  if (!cursor.startsWith(CONNECTOR_SUMMARY_CURSOR_PREFIX)) {
    throw new ConnectorSummaryPageCursorError();
  }
  let parsed: unknown;
  try {
    const encoded = decodeCanonicalBase64Url(cursor.slice(CONNECTOR_SUMMARY_CURSOR_PREFIX.length));
    if (encoded.length <= CURSOR_IV_BYTES + CURSOR_TAG_BYTES) {
      throw new Error("short cursor");
    }
    const iv = encoded.subarray(0, CURSOR_IV_BYTES);
    const tag = encoded.subarray(CURSOR_IV_BYTES, CURSOR_IV_BYTES + CURSOR_TAG_BYTES);
    const ciphertext = encoded.subarray(CURSOR_IV_BYTES + CURSOR_TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", cursorEncryptionKey(keyMaterial), iv);
    decipher.setAuthTag(tag);
    parsed = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch (cause) {
    throw new ConnectorSummaryPageCursorError(undefined, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectorSummaryPageCursorError();
  }
  const payload = parsed as Record<string, unknown>;
  if (
    payload.v !== CONNECTOR_SUMMARY_CURSOR_VERSION ||
    !isNonEmptyString(payload.c) ||
    !isNonEmptyString(payload.i) ||
    !isNonEmptyString(payload.s) ||
    !isNonEmptyString(payload.t) ||
    typeof payload.f !== "string"
  ) {
    throw new ConnectorSummaryPageCursorError();
  }
  const cursorScopeFingerprint = payload.f;
  if (cursorScopeFingerprint !== connectorIdScopeFingerprint(connectorIdFilter)) {
    throw new ConnectorSummaryPageCursorError();
  }
  // Bound check for the `sources_visibility` surface flag (2026-08-15 review
  // finding): a cursor issued on one surface must not decode on the other,
  // even before the scope-digest comparison below — this rejects a
  // cross-surface replay on a cheap plaintext-shaped field the same way `f`
  // rejects a connector_id-scope mismatch.
  // Cursors issued before the Sources-only boundary was introduced have no
  // `w` field. They were unfiltered cursors, so preserve that valid legacy
  // scope while still rejecting them on the Sources page.
  const cursorSourcesVisibility = payload.w === undefined ? "" : payload.w;
  if (
    typeof cursorSourcesVisibility !== "string" ||
    cursorSourcesVisibility !== sourcesVisibilityFingerprint(sourcesVisibility)
  ) {
    throw new ConnectorSummaryPageCursorError();
  }
  let suppliedScope: Buffer;
  try {
    suppliedScope = decodeCanonicalBase64Url(payload.s);
  } catch (cause) {
    throw new ConnectorSummaryPageCursorError(undefined, { cause });
  }
  const expectedScope = scopeDigest(ownerSubjectId, connectorIdFilter, sourcesVisibility);
  if (suppliedScope.length !== expectedScope.length || !timingSafeEqual(suppliedScope, expectedScope)) {
    throw new ConnectorSummaryPageCursorError();
  }
  return {
    connectorId: payload.c,
    connectorInstanceId: payload.i,
    createdAt: payload.t,
  };
}
