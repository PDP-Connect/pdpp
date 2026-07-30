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

export interface ConnectorSummaryPageRequest {
  readonly connectorId: string | null;
  readonly cursor: ConnectorIdentityPageBoundary | null;
  readonly limit: number;
}

export class ConnectorSummaryPageRequestError extends Error {
  readonly code = "invalid_request";
  readonly param: "cursor" | "limit";

  constructor(param: "cursor" | "limit", message: string) {
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

// The `connectorId` filter is bound into the SAME scope digest as the owner
// subject: a cursor issued while filtering by one connector must not resolve
// under a request that omits the filter or names a different connector — an
// unrelated identity page would render as this filter's "next page" and
// silently mix scopes (Perf-2026-07-29 client-gate requirement: "must not
// combine ambiguously"). ` ` is a safe separator since neither an owner
// subject id nor a connector id can contain it (see `isNonEmptyString` at
// every read site that treats non-empty ASCII-safe strings as the trusted
// boundary here).
function scopeDigest(ownerSubjectId: string, connectorId: string | null): Buffer {
  return createHash("sha256")
    .update(`pdpp-ref-connectors-page-v1:${ownerSubjectId} ${connectorId ?? ""}`)
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

/** Parse an explicit page request. `null` means compatibility-list mode. */
export function parseConnectorSummaryPageRequest(
  query: Readonly<Record<string, unknown>>,
  ownerSubjectId: string
): ConnectorSummaryPageRequest | null {
  const rawLimit = query.limit;
  const rawCursor = query.cursor;
  const rawConnectorId = query.connector_id;
  const hasLimit = rawLimit !== undefined;
  const hasCursor = rawCursor !== undefined;
  const hasConnectorId = rawConnectorId !== undefined;
  if (!(hasLimit || hasCursor || hasConnectorId)) {
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
  let connectorId: string | null = null;
  if (hasConnectorId) {
    if (!isNonEmptyString(rawConnectorId)) {
      throw new ConnectorSummaryPageRequestError("limit", "connector_id must be a non-empty string");
    }
    connectorId = rawConnectorId;
  }
  if (!hasCursor) {
    return { connectorId, cursor: null, limit };
  }
  if (!isNonEmptyString(rawCursor)) {
    throw new ConnectorSummaryPageCursorError();
  }
  return { connectorId, cursor: decodeConnectorSummaryPageCursor(rawCursor, ownerSubjectId, connectorId), limit };
}

/**
 * Encode an opaque, versioned continuation for one owner, identity tuple, and
 * (when the page was filtered) the exact `connector_id` filter that produced
 * it. `connectorIdFilter` defaults to `null` (unfiltered, fleet-wide page) —
 * every existing caller that omits it preserves the exact prior cursor scope.
 */
export function encodeConnectorSummaryPageCursor(
  boundary: ConnectorIdentityPageBoundary,
  ownerSubjectId: string,
  keyMaterial?: string,
  connectorIdFilter: string | null = null
): string {
  const payload = Buffer.from(
    JSON.stringify({
      c: boundary.connectorId,
      f: connectorIdFilter,
      i: boundary.connectorInstanceId,
      s: scopeDigest(ownerSubjectId, connectorIdFilter).toString("base64url"),
      t: boundary.createdAt,
      v: CONNECTOR_SUMMARY_CURSOR_VERSION,
    })
  );
  const iv = randomBytes(CURSOR_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", cursorEncryptionKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return `${CONNECTOR_SUMMARY_CURSOR_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

/**
 * Decode and scope-check a connector-summary continuation without logging it.
 * `connectorIdFilter` is the CURRENT request's `connector_id` filter (`null`
 * when absent) — it must exactly match the filter the cursor was issued
 * under (bound into the same scope digest as the owner subject), so a cursor
 * from a connector-filtered page cannot be replayed against an unfiltered
 * request or a different connector's page, and vice versa.
 */
export function decodeConnectorSummaryPageCursor(
  cursor: string,
  ownerSubjectId: string,
  connectorIdFilter: string | null = null,
  keyMaterial?: string
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
    !(payload.f === null || payload.f === undefined || isNonEmptyString(payload.f))
  ) {
    throw new ConnectorSummaryPageCursorError();
  }
  const cursorConnectorIdFilter = isNonEmptyString(payload.f) ? payload.f : null;
  if (cursorConnectorIdFilter !== connectorIdFilter) {
    throw new ConnectorSummaryPageCursorError();
  }
  let suppliedScope: Buffer;
  try {
    suppliedScope = decodeCanonicalBase64Url(payload.s);
  } catch (cause) {
    throw new ConnectorSummaryPageCursorError(undefined, { cause });
  }
  const expectedScope = scopeDigest(ownerSubjectId, connectorIdFilter);
  if (suppliedScope.length !== expectedScope.length || !timingSafeEqual(suppliedScope, expectedScope)) {
    throw new ConnectorSummaryPageCursorError();
  }
  return {
    connectorId: payload.c,
    connectorInstanceId: payload.i,
    createdAt: payload.t,
  };
}
