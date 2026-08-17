// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection-scope contract: the pure, zero-I/O rules that decide what an
// owner-declared collection boundary MEANS, and whether a coverage claim made
// under one boundary still describes another.
//
// Like its sibling `coherence.ts`, this module is deliberately a leaf. It
// imports nothing, holds no module-level mutable state, and reads no clock,
// filesystem, or network — so the reference implementation, the local-collector
// runtime, and conformance tooling all reach the same verdict on the same facts.
//
// The invariant it enforces:
//
//   A local collection claim is a claim about a DECLARED REGION of the source,
//   never about the source.
//
// A run that collected everything it could see has proven nothing about what it
// was not looking at. `coherence.ts` already refuses to let a checkpoint stand
// in for a measurement — that rule is about WHERE a cursor stopped. This module
// extends the same skepticism from *where* to *within what*: a coverage claim
// carries the boundary it was measured against, and a boundary the source
// cannot enumerate against is never quietly asserted.
//
// Which streams a boundary can honestly bind to is driven by MANIFEST FACTS
// interpreted here, never by a per-connector branch: this module contains no
// connector identifiers and no knowledge of any specific connector. A stream
// the manifest gives no time field is not silently narrowed and not silently
// full-drained — it is classified honestly and reported as what it is.

/**
 * An owner-declared collection boundary.
 *
 * `since` is an ISO-8601 instant, inclusive, compared against the stream's
 * manifest `consent_time_field` — the same field and comparison the read-time
 * grant filter already uses, so a bound means one thing across the system.
 *
 * `source_roots` is an allowlist of source-relative root segments (e.g. a
 * project directory name). Empty/absent means "no path narrowing". These are
 * matched as exact segments by the enforcing runtime, never as substrings: a
 * substring match cannot be enumerated against, so it cannot be proven.
 *
 * A scope with neither bound is `null`-equivalent: unscoped. Represent that as
 * `null` rather than an empty object so "no boundary" has exactly one encoding.
 */
export interface CollectionScope {
  readonly since?: string | null;
  readonly source_roots?: readonly string[] | null;
}

/**
 * How a stream relates to a declared scope. This is the honesty axis: every
 * requested stream lands in exactly one of these, and each is reported.
 *
 * - `scoped` — the manifest gives this stream a `consent_time_field`, so the
 *   declared `since` is enforceable AND provable against it.
 * - `unscopable_time` — a `since` was declared but the manifest gives this
 *   stream no time field. The boundary cannot be measured against it, so the
 *   stream is collected WHOLE and reported as out-of-scope-collected. It is
 *   never silently narrowed (which would drop data invisibly) and its coverage
 *   is never presented as proving the declared bound.
 * - `unscoped` — no boundary was declared at all; the classic full pass.
 */
export type StreamScopeClassification = "scoped" | "unscopable_time" | "unscoped";

/** The manifest facts this module interprets. No connector knowledge. */
export interface StreamScopeDeclaration {
  /** The manifest's `consent_time_field` for the stream, if it declares one. */
  readonly consent_time_field?: string | null;
}

function normalizeSince(since: string | null | undefined): string | null {
  if (typeof since !== "string") {
    return null;
  }
  const trimmed = since.trim();
  if (!trimmed) {
    return null;
  }
  // Reject a bound we cannot compare — an unparseable instant would otherwise
  // become a boundary that silently matches everything.
  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}

function normalizeRoots(roots: readonly string[] | null | undefined): readonly string[] {
  if (!Array.isArray(roots)) {
    return [];
  }
  const seen = new Set<string>();
  for (const root of roots) {
    if (typeof root === "string" && root.trim()) {
      seen.add(root.trim());
    }
  }
  return [...seen].sort();
}

/**
 * Reduce a scope to its canonical form, or `null` if it declares no boundary.
 *
 * Canonicalization is what makes scope comparable: the same boundary expressed
 * with different key order, whitespace, or duplicate roots must produce the
 * same fingerprint, or a no-op edit would spuriously invalidate valid proof.
 */
export function normalizeCollectionScope(scope: CollectionScope | null | undefined): CollectionScope | null {
  if (!scope) {
    return null;
  }
  const since = normalizeSince(scope.since);
  const roots = normalizeRoots(scope.source_roots);
  if (!since && roots.length === 0) {
    return null;
  }
  return {
    ...(since ? { since } : {}),
    ...(roots.length > 0 ? { source_roots: roots } : {}),
  };
}

/**
 * A stable, order-independent identity for a boundary.
 *
 * Coverage evidence carries this string so stored proof is never ambiguous
 * about what it covers, and so a scope change is detectable by comparison
 * rather than by trusting a caller to remember. `"unscoped"` is a real value,
 * not an absence: a full-corpus pass is a declared boundary too, and prior
 * unscoped proof must be invalidated when a bound is later introduced.
 */
export function collectionScopeFingerprint(scope: CollectionScope | null | undefined): string {
  const normalized = normalizeCollectionScope(scope);
  if (!normalized) {
    return "unscoped";
  }
  const parts: string[] = [];
  if (normalized.since) {
    parts.push(`since=${normalized.since}`);
  }
  if (normalized.source_roots?.length) {
    parts.push(`roots=${normalized.source_roots.join(",")}`);
  }
  return parts.join(";");
}

/**
 * Whether coverage measured under `measured` still proves the claim for
 * `declared`.
 *
 * Deliberately an exact-identity comparison, NOT a containment test. It is
 * tempting to argue that proof measured over a wider region implies proof of a
 * narrower one — but the wider run enforced a different emission filter and
 * produced a different coverage set, so treating it as proof of the narrower
 * boundary would be reinterpreting evidence rather than measuring it. The
 * honest response to any change is to recompute.
 */
export function scopeProofRemainsValid(
  measured: CollectionScope | null | undefined,
  declared: CollectionScope | null | undefined
): boolean {
  return collectionScopeFingerprint(measured) === collectionScopeFingerprint(declared);
}

/**
 * Classify one stream against a declared scope using only manifest facts.
 *
 * This is where the design refuses to fabricate: a `since` is honoured only for
 * a stream whose manifest declares the time field it would be compared against.
 * Every other stream is named `unscopable_time` so the runtime collects it whole
 * and the owner is told so, rather than the system implying a bound it cannot
 * measure.
 */
export function classifyStreamScope(
  scope: CollectionScope | null | undefined,
  declaration: StreamScopeDeclaration
): StreamScopeClassification {
  const normalized = normalizeCollectionScope(scope);
  if (!normalized) {
    return "unscoped";
  }
  if (!normalized.since) {
    // A roots-only boundary narrows enumeration, not per-record time, so it
    // applies to every stream the enumerating runtime feeds through it.
    return "scoped";
  }
  const field = declaration.consent_time_field;
  return typeof field === "string" && field.trim() ? "scoped" : "unscopable_time";
}

/**
 * A stream's coverage claim, qualified by the boundary it was measured against.
 *
 * `covers_declared_scope` is the honest headline: `true` only when this
 * stream's evidence was produced under the currently-declared boundary AND the
 * boundary was one this stream could be measured against. An
 * `unscopable_time` stream that was collected whole reports `false` — it holds
 * real data, but it does not prove the declared bound.
 */
export interface ScopedCoverageClaim {
  readonly classification: StreamScopeClassification;
  readonly covers_declared_scope: boolean;
  readonly measured_scope: string;
  readonly stream: string;
}

/**
 * Build one stream's scoped coverage claim from the boundary it was measured
 * under and the boundary currently declared.
 *
 * Total function of its arguments; the caller supplies both boundaries so a
 * stale-proof read and a fresh-run write reach the same verdict by the same
 * rule.
 */
export function buildScopedCoverageClaim(input: {
  readonly declared: CollectionScope | null | undefined;
  readonly declaration: StreamScopeDeclaration;
  readonly measured: CollectionScope | null | undefined;
  readonly stream: string;
}): ScopedCoverageClaim {
  const classification = classifyStreamScope(input.measured, input.declaration);
  return {
    classification,
    // An unscopable stream is collected whole and is honest about it: it never
    // claims to cover a bound it could not be measured against.
    covers_declared_scope:
      classification !== "unscopable_time" && scopeProofRemainsValid(input.measured, input.declared),
    measured_scope: collectionScopeFingerprint(input.measured),
    stream: input.stream,
  };
}
