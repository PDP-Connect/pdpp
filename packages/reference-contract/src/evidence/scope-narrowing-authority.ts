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

/**
 * Whether every root the candidate selects is at-or-inside some root the
 * bound selects. An empty candidate root list is "select everything" (no
 * root restriction), which is narrower than a bound's roots only when the
 * bound also declares none.
 */
function rootsAreNarrowerOrEqual(
  candidate: readonly string[] | undefined,
  bound: readonly string[] | undefined,
  pathContainsOrIsWithin: (root: string, path: string) => boolean
): boolean {
  if (!bound || bound.length === 0) {
    return true;
  }
  if (!candidate || candidate.length === 0) {
    return false;
  }
  return candidate.every((candidateRoot) =>
    bound.some((boundRoot) => pathContainsOrIsWithin(boundRoot, candidateRoot))
  );
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
 * `pathContainsOrIsWithin` is injected so this module stays a pure leaf with
 * no dependency on the enumeration module's path-segment implementation;
 * callers pass the real one from `collection-scope-enumeration.ts`.
 */
export function resolveEffectiveEnrollmentScope(input: {
  readonly device: DeviceScopeRequest;
  readonly now: string;
  readonly pathContainsOrIsWithin: (root: string, path: string) => boolean;
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
  const rootsOk = rootsAreNarrowerOrEqual(
    device.source_roots ?? undefined,
    server.source_roots ?? undefined,
    input.pathContainsOrIsWithin
  );

  if (!(sinceOk && rootsOk)) {
    return {
      accepted: false,
      reason: `the offered scope (${collectionScopeFingerprint(device)}) is wider than the server-declared boundary (${collectionScopeFingerprint(server)}); a device may only narrow, never widen, a declared boundary`,
    };
  }
  return { accepted: true, effective: device };
}
