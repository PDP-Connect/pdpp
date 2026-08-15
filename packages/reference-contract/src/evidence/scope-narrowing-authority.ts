// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The narrowing-authority rule for a DEVICE-declared collection boundary
// offered at enrollment time, as distinct from an OWNER-declared one.
//
// The owner-scope routes (`owner-connection-collection-scope.ts`,
// `local-collection-scope.ts`) are the sole authority for a connection's
// declared boundary — any caller there can set the boundary to anything,
// because the caller is proven to be the owner. A local collector's `connect`
// command has no such proof: it holds a single-use enrollment code, not an
// owner credential. So a scope it offers at enroll time is a REQUEST to
// narrow, never a declaration that can widen or replace what the owner
// (or the system default) already established.
//
// This module is the total, pure function that decides the EFFECTIVE scope
// from what each side offered. It is a leaf: no I/O, no connector knowledge,
// importing only the sibling collection-scope contract.

import { type CollectionScope, collectionScopeFingerprint, normalizeCollectionScope } from "./collection-scope.ts";

/** Default lower bound for "recent" when neither side declares anything. */
export const DEFAULT_UNDECLARED_SCOPE_DAYS = 30;

/**
 * What a device offers at enroll time, distinguishing "I have no preference"
 * from "I explicitly want unscoped" — `CollectionScope | null` alone cannot
 * make that distinction, since `null` is already the encoding for "unscoped"
 * everywhere else in this contract. A device that truly has no opinion omits
 * this value entirely (`undefined`/`null` at the call site); a device that
 * wants a full pass sends `{ kind: "declared", scope: null }` explicitly.
 */
export type DeviceScopeRequest =
  | { readonly kind: "unspecified" }
  | { readonly kind: "declared"; readonly scope: CollectionScope | null };

/** How a device-offered scope related to the server-declared (or default) one. */
export type ScopeNarrowingVerdict =
  | { readonly accepted: true; readonly effective: CollectionScope | null }
  | { readonly accepted: false; readonly reason: string };

function daysBefore(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) - days * 86_400_000).toISOString();
}

/** The system default when NEITHER side declares a boundary: recent history, not a full pass. */
export function defaultUndeclaredScope(now: string): CollectionScope {
  return { since: daysBefore(now, DEFAULT_UNDECLARED_SCOPE_DAYS) };
}

/**
 * Whether `candidate`'s `since` is at or after `bound`'s — i.e. candidate
 * covers a region that starts no earlier than bound. A candidate with no
 * `since` at all is maximally wide (covers everything), so it is narrower
 * than `bound` only when `bound` also has no `since`.
 */
function sinceIsNarrowerOrEqual(candidate: string | undefined, bound: string | undefined): boolean {
  if (bound === undefined) {
    // No time floor declared on the bound side — any candidate since (or none)
    // is within it; time is not the axis being restricted.
    return true;
  }
  if (candidate === undefined) {
    // Bound restricts time but the candidate does not restrict it at all —
    // that is strictly WIDER, never narrower.
    return false;
  }
  return Date.parse(candidate) >= Date.parse(bound);
}

const PATH_SEPARATORS = /[\\/]/;

/**
 * Split a path-ish string into non-empty, dot-segment-normalized segments,
 * tolerating either separator. `.` is dropped and `..` pops the preceding
 * segment, so containment is decided on the resolved path rather than its
 * spelling (a `..` that would escape the start is dropped rather than
 * retained, so a path can never climb above its own first segment).
 */
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

/**
 * Whether `candidate` is at or inside `bound` — i.e. `candidate` is `bound`
 * itself or a strict descendant of it, by whole path segments. This is the
 * ONE canonical directional containment authority for security/narrowing
 * decisions in this contract: "is the candidate equal to or a descendant of
 * the bound," never the reverse.
 *
 * Deliberately distinct from a bidirectional walker-descent predicate (used
 * elsewhere to decide whether to keep walking a directory tree toward a
 * root, where an ancestor legitimately "contains" a root for descent
 * purposes). Conflating the two — asking a bidirectional predicate a
 * one-directional security question — is exactly how a device could
 * previously offer an ANCESTOR of the server-declared root and have it
 * accepted as "contained," silently widening the boundary. This function
 * requires `candidate` to cover every segment of `bound`, so an ancestor
 * (which has fewer segments than `bound`) can never satisfy it.
 *
 * An empty `bound` (no path restriction) is satisfied by anything.
 */
export function pathIsWithinOrEqual(bound: string, candidate: string): boolean {
  const boundParts = segments(bound);
  if (boundParts.length === 0) {
    return true;
  }
  const candidateParts = segments(candidate);
  if (candidateParts.length < boundParts.length) {
    return false;
  }
  return boundParts.every((part, i) => part === candidateParts[i]);
}

/**
 * Whether every root the candidate selects is at-or-inside some root the
 * bound selects. An empty candidate root list is "select everything" (no
 * root restriction), which is narrower than a bound's roots only when the
 * bound also declares none.
 */
function rootsAreNarrowerOrEqual(
  candidate: readonly string[] | undefined,
  bound: readonly string[] | undefined
): boolean {
  if (!bound || bound.length === 0) {
    return true;
  }
  if (!candidate || candidate.length === 0) {
    return false;
  }
  return candidate.every((candidateRoot) => bound.some((boundRoot) => pathIsWithinOrEqual(boundRoot, candidateRoot)));
}

/**
 * Decide the effective scope a device may enroll under, given what the
 * server already declared (or `null`/absent for none) and what the device
 * itself requests via a {@link DeviceScopeRequest}.
 *
 * Rules, in order:
 * 1. Server declares nothing AND the device is `unspecified` -> the honest
 *    system default is RECENT history, never an implicit full pass.
 * 2. Server declares nothing, device is `declared` (including an explicit
 *    `scope: null` full pass) -> honored as-is: there is no boundary to
 *    violate, so whatever the device requests becomes effective.
 * 3. Server declares a boundary, device is `unspecified` -> the server's
 *    boundary is effective, unchanged.
 * 4. Server declares a boundary, device is `declared` -> the device's
 *    request is honored ONLY if it is narrower than or equal to the
 *    server's on BOTH axes independently (a device cannot trade width on
 *    one axis for narrowness on the other), and an explicit `scope: null`
 *    (full pass) against ANY server boundary is always a widening. Any
 *    widening is REJECTED outright — never silently clamped to the server's
 *    boundary — so an operator who mistypes a scope is told, not quietly
 *    overridden.
 *
 * Path containment for the `source_roots` axis is decided by this module's
 * own {@link pathIsWithinOrEqual} — the canonical directional containment
 * authority for narrowing decisions. Callers do not inject a predicate: this
 * module is a pure leaf with no dependency on any connector-facing walker
 * logic, and the security-relevant containment rule lives in exactly one
 * place.
 */
export function resolveEffectiveEnrollmentScope(input: {
  readonly device: DeviceScopeRequest;
  readonly now: string;
  readonly serverDeclared: CollectionScope | null | undefined;
}): ScopeNarrowingVerdict {
  const server = normalizeCollectionScope(input.serverDeclared);

  if (input.device.kind === "unspecified") {
    return { accepted: true, effective: server ?? defaultUndeclaredScope(input.now) };
  }

  const device = normalizeCollectionScope(input.device.scope);
  if (!server) {
    return { accepted: true, effective: device };
  }
  if (!device) {
    // The device explicitly asked for a full pass against a server boundary
    // that restricts something — that is always a widening.
    return {
      accepted: false,
      reason:
        "the device requested an unscoped (all-history) pass, but the server has already declared a boundary " +
        `(${collectionScopeFingerprint(server)}); a device may only narrow, never widen, a declared boundary`,
    };
  }

  const sinceOk = sinceIsNarrowerOrEqual(device.since ?? undefined, server.since ?? undefined);
  const rootsOk = rootsAreNarrowerOrEqual(device.source_roots ?? undefined, server.source_roots ?? undefined);

  if (!(sinceOk && rootsOk)) {
    return {
      accepted: false,
      reason: `the offered scope (${collectionScopeFingerprint(device)}) is wider than the server-declared boundary (${collectionScopeFingerprint(server)}); a device may only narrow, never widen, a declared boundary`,
    };
  }
  return { accepted: true, effective: device };
}
