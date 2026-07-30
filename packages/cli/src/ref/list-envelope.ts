// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced verbatim from
// packages/list-envelope/src/index.ts by
// packages/cli/scripts/generate-list-envelope.ts (part of `pnpm build`).
// packages/cli publishes publicly with zero runtime deps, so it cannot
// import the private @pdpp/list-envelope workspace package directly; this
// generated copy is the CLI's only version of that validator, never a
// second hand-maintained implementation. scripts/check-generated-artifacts.ts
// fails CI if this file and the shared source ever diverge.

/**
 * ONE runtime validator for the bounded-list-page envelope shape every
 * `/_ref/connectors`-style paged read returns:
 *   { object: "list", data: T[], has_more: boolean, next_cursor?: string }
 *
 * Directly imported by the console pager (connector-summary-page.tsx),
 * Explore (explore-data-assembler.ts), and the live stream-health-audit
 * script. `@pdpp/cli` cannot import this package directly — it is a
 * publicly published npm package with zero runtime dependencies, and this
 * package is a private, unpublished workspace package (`workspace:*` has no
 * resolvable version at publish time) — so the CLI's copy at
 * `packages/cli/src/ref/list-envelope.ts` is instead GENERATED from this
 * file verbatim by `packages/cli/scripts/generate-list-envelope.ts`, with
 * `scripts/check-generated-artifacts.ts` failing CI on any byte-level drift
 * between the two. There is exactly one hand-authored implementation; the
 * CLI's is a build artifact, never a second hand-maintained copy. Before
 * this module existed, each caller had its own partial check (usually just
 * "has_more + missing cursor"), and direct oracles found each one fail-open
 * on a different malformed shape: a wrong `object` discriminator, a
 * non-array `data`, a non-boolean `has_more`, or a whitespace-only
 * `next_cursor` string.
 *
 * Strict checks, in order:
 *   1. `object === "list"` (exact discriminator, not just "truthy").
 *   2. `Array.isArray(data)`.
 *   3. `typeof has_more === "boolean"` (not just truthy/falsy — a string
 *      "true" or a 1/0 must not silently coerce).
 *   4. Coherent continuation:
 *      - `has_more === true` requires a `next_cursor` that is a string,
 *        non-empty AFTER TRIMMING (a whitespace-only cursor like `" "` is
 *        rejected — the CLI previously turned that into a literal
 *        `?cursor=+` request).
 *      - `has_more === false` with a non-blank `next_cursor` present is
 *        ALSO incoherent (a terminal page claiming a continuation exists)
 *        and is rejected, not silently ignored.
 *   The ORIGINAL (untrimmed) cursor string is what callers get back and use
 *   as the actual continuation value — trimming is validation-only, never a
 *   silent mutation of the opaque value itself.
 */

export interface ListEnvelopeLike {
  data?: unknown;
  has_more?: unknown;
  next_cursor?: unknown;
  object?: unknown;
}

export type ListEnvelopeValidation<T> =
  | { readonly kind: "invalid"; readonly reason: string }
  | {
      readonly data: readonly T[];
      readonly hasMore: boolean;
      readonly kind: "valid";
      /** The original, untrimmed opaque continuation value; undefined when there is none. */
      readonly nextCursor: string | undefined;
    };

function isBlankAfterTrim(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Validate one page response against the strict envelope contract above.
 * Never throws — every rejection is a typed `{ kind: "invalid", reason }`
 * so callers can surface it (restart affordance, non-zero exit, audit
 * `inconclusive`) instead of proceeding on a shape they cannot trust.
 */
export function validateListEnvelope<T>(response: ListEnvelopeLike): ListEnvelopeValidation<T> {
  if (response.object !== "list") {
    return { kind: "invalid", reason: `expected object: "list", got ${JSON.stringify(response.object)}` };
  }
  if (!Array.isArray(response.data)) {
    return { kind: "invalid", reason: "expected data to be an array" };
  }
  if (typeof response.has_more !== "boolean") {
    return { kind: "invalid", reason: `expected has_more to be a boolean, got ${JSON.stringify(response.has_more)}` };
  }
  const rawCursor = response.next_cursor;
  const cursorIsUsableString = typeof rawCursor === "string" && !isBlankAfterTrim(rawCursor);
  if (response.has_more) {
    if (!cursorIsUsableString) {
      return {
        kind: "invalid",
        reason: "has_more is true but next_cursor is missing, non-string, or blank after trimming",
      };
    }
  } else if (typeof rawCursor === "string" && !isBlankAfterTrim(rawCursor)) {
    return {
      kind: "invalid",
      reason: "has_more is false but next_cursor carries a non-blank continuation (terminal page contradiction)",
    };
  }
  return {
    data: response.data as readonly T[],
    hasMore: response.has_more,
    kind: "valid",
    nextCursor: cursorIsUsableString ? (rawCursor as string) : undefined,
  };
}
