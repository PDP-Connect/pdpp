// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side wiring for the narrowing-only device scope a `connect`-style
 * local collector may offer at enroll time (`POST
 * /_ref/device-exporters/enroll`'s optional `collection_scope` body field).
 *
 * The decision itself — default-to-recent, honor-as-is when nothing is
 * declared server-side, narrow-only otherwise — is the pure, connector-
 * agnostic `resolveEffectiveEnrollmentScope` in `@pdpp/reference-contract`.
 * This module supplies the one thing that function needs and cannot import
 * itself (a path-containment predicate) and validates the raw request body
 * into the typed request that function expects, using the SAME reject-
 * rather-coerce rules `owner-connection-collection-scope.ts`'s
 * `parseScopeBody` already enforces for the owner-authenticated route.
 *
 * `pathContainsOrIsWithin` is a server-local copy of
 * `packages/polyfill-connectors/src/collection-scope-enumeration.ts`'s
 * function of the same name and MUST stay behaviorally identical to it —
 * this server module has no dependency on connector runtime code (server
 * code must not import from a connector's runtime package), so the
 * predicate is duplicated rather than imported, the same pattern
 * `collector-runner.ts` already uses in the other direction (mirroring
 * `@pdpp/reference-contract`'s scope logic without importing it). A
 * cross-package test asserts the two never drift.
 */

import type { CollectionScope, DeviceScopeRequest, ScopeNarrowingVerdict } from "@pdpp/reference-contract/evidence";
import { resolveEffectiveEnrollmentScope } from "@pdpp/reference-contract/evidence";

const PATH_SEPARATORS = /[\\/]/;

function segments(value: string): string[] {
  const parts = value.split(PATH_SEPARATORS).filter((part) => part.length > 0 && part !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved;
}

/** Whether `candidate` is inside (or exactly equal to) `root`, by whole path segments. */
export function pathContainsOrIsWithin(root: string, candidate: string): boolean {
  const rootParts = segments(root);
  const candidateParts = segments(candidate);
  if (rootParts.length === 0) {
    return true;
  }
  const shared = Math.min(rootParts.length, candidateParts.length);
  for (let i = 0; i < shared; i += 1) {
    if (rootParts[i] !== candidateParts[i]) {
      return false;
    }
  }
  return true;
}

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

/** Resolve the effective enrollment scope, injecting this module's own path predicate. */
export function resolveEnrollmentScope(input: {
  readonly device: DeviceScopeRequest;
  readonly now: string;
  readonly serverDeclared: CollectionScope | null | undefined;
}): ScopeNarrowingVerdict {
  return resolveEffectiveEnrollmentScope({ ...input, pathContainsOrIsWithin });
}
