// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side wiring for the narrowing-only device scope a `connect`-style
 * local collector may offer at enroll time (`POST
 * /_ref/device-exporters/enroll`'s optional `collection_scope` body field).
 *
 * The decision itself — default-to-recent, honor-as-is when nothing is
 * declared server-side, narrow-only otherwise, including the directional
 * path-containment check on the `source_roots` axis — is entirely owned by
 * the pure, connector-agnostic `resolveEffectiveEnrollmentScope` in
 * `@pdpp/reference-contract`. This module contains NO path-containment
 * logic of its own: it only validates the raw request body into the typed
 * request that function expects, using the SAME reject-rather-coerce rules
 * `owner-connection-collection-scope.ts`'s `parseScopeBody` already
 * enforces for the owner-authenticated route, then delegates the decision.
 */

import type { CollectionScope, DeviceScopeRequest, ScopeNarrowingVerdict } from "@pdpp/reference-contract/evidence";
import { resolveEffectiveEnrollmentScope } from "@pdpp/reference-contract/evidence";

/** Validate `collection_scope.since`. `undefined`/`null` means "not declared", not an error. */
function parseScopeSince(value: unknown): { ok: true; since?: string } | { ok: false; message: string } {
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (typeof value !== "string" || !value.trim()) {
    return { message: "collection_scope.since must be a non-empty ISO-8601 string", ok: false };
  }
  if (Number.isNaN(Date.parse(value.trim()))) {
    return { message: `collection_scope.since is not a parseable instant: ${value}`, ok: false };
  }
  return { ok: true, since: value.trim() };
}

/** Validate `collection_scope.source_roots`. `undefined`/`null` means "not declared", not an error. */
function parseScopeSourceRoots(value: unknown): { ok: true; source_roots?: string[] } | { ok: false; message: string } {
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (!Array.isArray(value)) {
    return { message: "collection_scope.source_roots must be an array of strings", ok: false };
  }
  const roots: string[] = [];
  for (const root of value) {
    if (typeof root !== "string" || !root.trim()) {
      return { message: "collection_scope.source_roots entries must be non-empty strings", ok: false };
    }
    roots.push(root.trim());
  }
  return roots.length > 0 ? { ok: true, source_roots: roots } : { ok: true };
}

/**
 * Validate the optional `collection_scope` field on an enroll request body.
 *
 * `undefined` (the field was never sent) is `{ kind: "unspecified" }` — a
 * device with no opinion. An explicit `null` or `{}` is a declared full pass
 * (`{ kind: "declared", scope: null }`), NOT the same as omitting the field:
 * this is the one place a device can request "all" outright, and it is still
 * subject to the narrowing-only check against whatever the server already
 * declared.
 */
export function parseDeviceScopeRequest(
  value: unknown
): { ok: true; request: DeviceScopeRequest } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, request: { kind: "unspecified" } };
  }
  if (value === null) {
    return { ok: true, request: { kind: "declared", scope: null } };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { message: "collection_scope must be an object", ok: false };
  }
  const body = value as Record<string, unknown>;
  const since = parseScopeSince(body.since);
  if (!since.ok) {
    return since;
  }
  const roots = parseScopeSourceRoots(body.source_roots);
  if (!roots.ok) {
    return roots;
  }
  if (since.since === undefined && roots.source_roots === undefined) {
    // An explicitly-empty `{}` is the same declared-full-pass shape as `null`.
    return { ok: true, request: { kind: "declared", scope: null } };
  }
  return {
    ok: true,
    request: {
      kind: "declared",
      scope: {
        ...(since.since === undefined ? {} : { since: since.since }),
        ...(roots.source_roots === undefined ? {} : { source_roots: roots.source_roots }),
      },
    },
  };
}

/** Resolve the effective enrollment scope. Delegates entirely to `@pdpp/reference-contract`. */
export function resolveEnrollmentScope(input: {
  readonly device: DeviceScopeRequest;
  readonly now: string;
  readonly serverDeclared: CollectionScope | null | undefined;
}): ScopeNarrowingVerdict {
  return resolveEffectiveEnrollmentScope(input);
}
