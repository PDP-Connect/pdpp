// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-agnostic query-validation and response-shape helpers shared by
 * the SQLite record path (records.js) and the Postgres record path
 * (postgres-records.js).
 *
 * These helpers cannot live in records.js because postgres-records.js must
 * NOT import from records.js (records.js dispatches into postgres-records.js —
 * the dependency must run one way only). They cannot live in postgres-records.js
 * because records.js would then import from its own dispatch target.
 * A third module with no imports from either side is the correct structure.
 *
 * `invalidQueryError` is re-used from record-expand-helpers.js, which is
 * already the canonical home for that helper and is already imported by both
 * records.js and postgres-records.js.
 */

import { invalidQueryError } from "./record-expand-helpers.js";

// Canonical graded-count vocabulary.
// Spec: openspec/changes/canonicalize-public-read-contract design.md ("Counts")
//       reference-contract `CountKindSchema`
export const SUPPORTED_COUNT_KINDS: Set<string> = new Set(["none", "estimated", "exact"]);

// Canonical bounded-window opt-in vocabulary. `meta.window` is opt-in via the
// `window` query parameter, mirroring the `count` opt-in discipline.
// Spec: openspec/changes/complete-explorer-slvp-ideal/specs/
//       reference-implementation-architecture/spec.md
//       (#"The record-list read MAY expose bounded window aggregate metadata")
export const SUPPORTED_WINDOW_KINDS: Set<string> = new Set(["none", "exact"]);

/**
 * Error carrying an optional `param` marker for typed invalid-query rejects.
 * `invalidQueryError` returns a plain `Error`; several call sites tag `.param`.
 */
type QueryError = Error & { param?: string };

export type SortDirection = "ASC" | "DESC";

export interface ResolvedSort {
  direction: SortDirection;
  field: string;
}

export interface ManifestStreamLike {
  cursor_field?: string | null | undefined;
}

/**
 * Validate the requested count grade against the canonical
 * `none|estimated|exact` vocabulary. Absent / empty values pass through;
 * the server applies `none` as the default.
 */
export function validateCountKind(value: unknown): void {
  if (value == null || value === "") {
    return;
  }
  if (typeof value !== "string" || !SUPPORTED_COUNT_KINDS.has(value)) {
    throw invalidQueryError(`count must be one of: ${[...SUPPORTED_COUNT_KINDS].join(", ")}`);
  }
}

/**
 * Validate the requested `window` grade against the canonical
 * `none|exact` vocabulary. Absent / empty / `none` values pass through; the
 * server omits `meta.window` for those. `exact` requests the bounded
 * aggregate. Any other value is a typed invalid-query error.
 */
export function validateWindowKind(value: unknown): void {
  if (value == null || value === "") {
    return;
  }
  if (typeof value !== "string" || !SUPPORTED_WINDOW_KINDS.has(value)) {
    throw invalidQueryError(`window must be one of: ${[...SUPPORTED_WINDOW_KINDS].join(", ")}`);
  }
}

export function rejectListOnlyParamsForChangesFeed(requestParams: Record<string, unknown>): void {
  const unsupported: string[] = [];
  for (const key of ["sort", "count", "order", "window"]) {
    if (requestParams[key] != null && requestParams[key] !== "") {
      unsupported.push(key);
    }
  }
  if (!unsupported.length) {
    return;
  }
  throw invalidQueryError(
    `${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} not supported with changes_since`,
    "invalid_request"
  );
}

/**
 * Validate the canonical `sort` parameter against the manifest stream's
 * declared cursor field, and return the resolved direction the runtime
 * will apply.
 *
 * The wire vocabulary is sign-prefix CSV (`sort=-emitted_at`). Today the
 * reference runtime supports ordering by the stream's declared cursor
 * field only, so any other field is rejected with a typed `invalid_sort`
 * error. The sign prefix MUST control direction: `sort=field` is asc,
 * `sort=-field` is desc — silently ignoring the sign would amount to
 * accepting `sort` as a no-op, which the canonical contract forbids.
 *
 * Returns `null` when no `sort` is supplied, or
 *   `{ field: <cursor_field>, direction: 'ASC' | 'DESC' }`
 * when a single-field sort matches the advertised cursor field.
 */
export function validateCanonicalSort(
  value: unknown,
  manifestStream: ManifestStreamLike | null | undefined
): ResolvedSort | null {
  if (value == null || value === "") {
    return null;
  }
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  const entries = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return null;
  }
  const cursorField = manifestStream?.cursor_field || null;
  const sortableFields = cursorField ? new Set([cursorField]) : new Set<string>();
  let resolved: ResolvedSort | null = null;
  for (const entry of entries) {
    const direction: SortDirection = entry.startsWith("-") ? "DESC" : "ASC";
    const field = direction === "DESC" ? entry.slice(1) : entry;
    if (!field) {
      const err = invalidQueryError("Empty sort field", "invalid_sort") as QueryError;
      err.param = "sort";
      throw err;
    }
    if (sortableFields.size === 0 || !sortableFields.has(field)) {
      const err = invalidQueryError(
        `Sort field '${field}' is not advertised as sortable; check /v1/schema for the canonical sort vocabulary.`,
        "invalid_sort"
      ) as QueryError;
      err.param = "sort";
      throw err;
    }
    if (resolved && resolved.direction !== direction) {
      const err = invalidQueryError(`Conflicting sort directions for field '${field}'`, "invalid_sort") as QueryError;
      err.param = "sort";
      throw err;
    }
    resolved = { field, direction };
  }
  return resolved;
}

export function parsePageOrder(rawOrder: unknown): SortDirection {
  if (rawOrder == null || rawOrder === "") {
    return "DESC";
  }
  if (rawOrder === "asc") {
    return "ASC";
  }
  if (rawOrder === "desc") {
    return "DESC";
  }
  throw invalidQueryError("order must be asc or desc");
}

/**
 * Resolve the effective list order from the canonical `sort` parameter
 * and the legacy `order` parameter.
 *
 * Canonical `sort` wins: `sort=-emitted_at` is DESC, `sort=emitted_at` is
 * ASC. Legacy `order` is honored only when `sort` is absent. If both are
 * sent and disagree, we reject with `invalid_sort` rather than silently
 * picking one — this is the strict-validation discipline the contract
 * requires for sort behavior.
 */
export function resolveListOrder(rawOrder: unknown, resolvedSort: ResolvedSort | null): SortDirection {
  if (resolvedSort) {
    if (rawOrder != null && rawOrder !== "") {
      const legacyOrder = parsePageOrder(rawOrder);
      if (legacyOrder !== resolvedSort.direction) {
        const err = invalidQueryError(
          `sort and order disagree: sort resolves to ${resolvedSort.direction}, order=${rawOrder}. Send only canonical \`sort\`.`,
          "invalid_sort"
        ) as QueryError;
        err.param = "sort";
        throw err;
      }
    }
    return resolvedSort.direction;
  }
  return parsePageOrder(rawOrder);
}

/**
 * Encode a compound key to its canonical string form (minified JSON array or plain string)
 */
export function encodeKey(key: unknown): string {
  if (Array.isArray(key)) {
    return JSON.stringify(key);
  }
  return String(key);
}

/**
 * Decode a canonical key string back to string|string[]
 */
export function decodeKey(keyStr: string): string | string[] {
  try {
    const parsed = JSON.parse(keyStr);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return keyStr;
  } catch {
    return keyStr;
  }
}

interface ConnectionIdentity {
  connectionId?: unknown;
  displayName?: unknown;
}

/**
 * Attach canonical `connection_id` and the deprecated `connector_instance_id`
 * alias to a response record when the runtime knows the binding without
 * guessing. Used by both SQLite and Postgres record paths so responses match.
 */
export function decorateRecordWithConnectionIdentity(
  record: Record<string, unknown> | null | undefined,
  identity: ConnectionIdentity | null | undefined
): void {
  if (!(record && identity)) {
    return;
  }
  const connectionId = typeof identity.connectionId === "string" ? identity.connectionId.trim() : "";
  if (connectionId) {
    record.connection_id = connectionId;
    record.connector_instance_id = connectionId;
  }
  const displayName = typeof identity.displayName === "string" ? identity.displayName.trim() : "";
  if (displayName) {
    record.display_name = displayName;
  }
}

interface ResponseWithMeta {
  meta?: unknown;
  [key: string]: unknown;
}

/**
 * Attach a `meta.warnings[]` envelope to a public-read response only when
 * the runtime has non-empty structured warnings to surface.
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 */
export function attachRequestWarningsToResponse(
  response: ResponseWithMeta | null | undefined,
  warnings: unknown
): void {
  if (!response || typeof response !== "object") {
    return;
  }
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return;
  }
  const existingMeta =
    response.meta && typeof response.meta === "object" && !Array.isArray(response.meta)
      ? (response.meta as Record<string, unknown>)
      : null;
  const existingWarnings = existingMeta && Array.isArray(existingMeta.warnings) ? existingMeta.warnings : [];
  response.meta = {
    ...(existingMeta || {}),
    warnings: [...existingWarnings, ...warnings],
  };
}

/**
 * Merge a `meta.count` payload into an existing response.meta, preserving
 * `warnings` and any other meta members. Returns the new meta object.
 */
export function mergeMetaCount(existingMeta: unknown, count: unknown): Record<string, unknown> {
  const base =
    existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta)
      ? { ...(existingMeta as Record<string, unknown>) }
      : {};
  base.count = count;
  return base;
}

/**
 * Merge a `meta.window` payload into an existing response.meta, preserving
 * `count`, `warnings`, and any other meta members. Returns the new meta
 * object.
 */
export function mergeMetaWindow(existingMeta: unknown, window: unknown): Record<string, unknown> {
  const base =
    existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta)
      ? { ...(existingMeta as Record<string, unknown>) }
      : {};
  base.window = window;
  return base;
}
