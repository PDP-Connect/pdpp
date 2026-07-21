// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SET-DESCRIPTOR CONTRACT
 *
 * Every collection of records the owner sees carries a typed descriptor of its
 * own completeness and ordering. The descriptor is the ENGINE-LEVEL truth:
 * derived from whatever produced the set and used to CONSTRAIN what the UI
 * may claim. The UI literally cannot render "newest first" over a
 * relevance_bounded set, or show "complete" for a bounded sample, because the
 * descriptor does not permit it.
 *
 * The discriminated union is the enforcement mechanism: a switch on
 * `descriptor.kind` drives every claim the canvas makes about the set. Any
 * claim that is not structurally reachable from the active kind is
 * unrepresentable -- not a runtime bug to re-catch.
 *
 * Owner-facing copy is softened at the PRESENTATION layer (feedHeaderLabel).
 * The honesty contract lives here and is immutable.
 */

/**
 * "Everything, newest first."
 * ordering=time, completeness=exhaustive, cursor-stable to the last record.
 * The merged cross-source timeline endpoint or a fully-paginated single stream.
 */
export interface CompleteChronologicalDescriptor {
  completeness: "exhaustive";
  /** Opaque cursor for the next page; non-null when has_more is true. */
  cursor: string | null;
  /** True when there are more records beyond this page (cursor-stable). */
  has_more: boolean;
  kind: "complete_chronological";
  ordering: "time";
}

/**
 * "Top matches."
 * ordering=relevance, completeness=bounded ranked sample.
 * The honest face of hybrid/semantic search. Never claims completeness.
 * Never has a "Load more" that implies it pages to the end.
 * Carries recall facts the server computes (ranked_candidate_count,
 * candidate_window_limit) so the owner knows the pool size.
 */
export interface RelevanceBoundedDescriptor {
  /** The cap the server applied to the candidate window, when reported. */
  candidate_window_limit?: number;
  completeness: "bounded_sample";
  cursor: null;
  /** Always false: relevance-bounded sets have no sound deep pagination. */
  has_more: false;
  kind: "relevance_bounded";
  ordering: "relevance";
  /** Total hits in the bounded candidate pool, when the server reported it. */
  total?: number;
}

/**
 * "Keyword matches."
 * ordering=relevance OR time (the assembler specifies which).
 * completeness=pageable to the end via a real keyset cursor.
 * Lexical search with a real next_cursor -- can be paged exhaustively.
 * When ordering=time the results are genuinely sorted by emitted_at DESC.
 * When ordering=relevance the results are sorted by BM25 score.
 */
export interface KeywordPageableDescriptor {
  completeness: "pageable";
  /** Opaque cursor for the next page; non-null when has_more is true. */
  cursor: string | null;
  /** True when there are more results reachable via the cursor. */
  has_more: boolean;
  kind: "keyword_pageable";
  ordering: "relevance" | "time";
}

/**
 * "Your filtered set: N records."
 * ordering=owner-chosen, completeness=exact and complete for the active filter.
 * Always carries a true total count.
 */
export interface FilteredExactDescriptor {
  completeness: "exact";
  /** Opaque cursor for the next page; non-null when has_more is true. */
  cursor: string | null;
  /** True when there are more pages of the filtered set. */
  has_more: boolean;
  kind: "filtered_exact";
  ordering: "owner_chosen";
  /** Exact total count for the filtered set. Always present for this kind. */
  total: number;
}

/**
 * Typed discriminated union over all real set-types the system produces.
 * Switch on `descriptor.kind` -- every branch is exhaustively typed.
 */
export type SetDescriptor =
  | CompleteChronologicalDescriptor
  | RelevanceBoundedDescriptor
  | KeywordPageableDescriptor
  | FilteredExactDescriptor;

/**
 * The honest header label for a set, driven entirely by the descriptor.
 * May be softened in presentation (e.g. shorter copy) but NEVER exceeds
 * what the descriptor claims. A relevance_bounded set cannot be labeled
 * "Everything, newest first" -- the switch makes that structurally impossible.
 */
export function feedHeaderLabel(descriptor: SetDescriptor): string {
  switch (descriptor.kind) {
    case "complete_chronological":
      return "Everything, newest first";
    case "relevance_bounded":
      return "Top matches";
    case "keyword_pageable":
      return descriptor.ordering === "time" ? "Keyword matches, newest first" : "Keyword matches";
    case "filtered_exact":
      return `Your filtered set: ${descriptor.total.toLocaleString()} records`;
    default: {
      // Exhaustiveness guard: a new descriptor kind must add a label here, or
      // this is a compile error. Strengthens the contract, not just a lint fix.
      const _exhaustive: never = descriptor;
      return _exhaustive;
    }
  }
}

/**
 * Whether a "Load more" control should appear for this set.
 * complete_chronological and keyword_pageable: only when has_more is true.
 * relevance_bounded: never (no sound deep pagination).
 * filtered_exact: when has_more is true.
 */
export function descriptorHasMore(descriptor: SetDescriptor): boolean {
  if (descriptor.kind === "relevance_bounded") {
    return false; // structural: relevance-bounded never has more
  }
  return descriptor.has_more;
}

/**
 * The cursor to advance to the next page, or null.
 * Enforces: relevance_bounded always returns null.
 */
export function descriptorNextCursor(descriptor: SetDescriptor): string | null {
  if (descriptor.kind === "relevance_bounded") {
    return null; // structural: no cursor for relevance-bounded
  }
  return descriptor.cursor;
}

/**
 * Whether the descriptor supports claiming "newest first" / time ordering.
 * Only complete_chronological and keyword_pageable with ordering=time do.
 * This function is the structural guard: if it returns false, the UI must
 * not render a chronological claim.
 */
export function descriptorIsTimeOrdered(descriptor: SetDescriptor): boolean {
  if (descriptor.kind === "complete_chronological") {
    return true;
  }
  if (descriptor.kind === "keyword_pageable" && descriptor.ordering === "time") {
    return true;
  }
  return false;
}

/**
 * Whether the descriptor supports a total count claim.
 * Only filtered_exact carries a true total.
 */
export function descriptorHasTotal(descriptor: SetDescriptor): descriptor is FilteredExactDescriptor {
  return descriptor.kind === "filtered_exact";
}

/**
 * The LEGAL sort surface a set may offer, gated by its descriptor kind (the
 * sort-cell honesty contract; see docs/research/explore-design-cells/sort/design.md §3).
 *
 * There are TWO orthogonal sort axes, never a stack:
 *   - "time" — a DIRECTION over the set's declared cursor/time order
 *     ({newest, oldest}). Surfaced as the semantic-time display order. The only
 *     FIELD-level sort the data can declare (the stream's `cursor_field`); there
 *     is no amount/name/sender sort because no connector declares those sortable
 *     (`field_capabilities` has no `sortable` flag, and `x_pdpp_role:amount` is a
 *     presentation role, not a sort capability — using it would be the cardinal
 *     name/role-guessing sin).
 *   - "rank" — the search ROW lens ({relevance, recent}); `recent` is
 *     time-direction-newest applied to the lexical candidate set.
 *
 * A `relevance_bounded` ranked SAMPLE has NO honest in-set sort — its only door
 * is the chronological escape (handled in the search header). So it returns
 * `{axis:"none"}` and the canvas renders no in-set sort control for it.
 *
 * This is a switch on `descriptor.kind`, so an unrepresentable sort claim is
 * structurally impossible (mirrors `feedHeaderLabel`/`descriptorIsTimeOrdered`),
 * not a runtime check to forget. It reads ONLY the descriptor — never a field
 * name — so it holds for arbitrary connectors.
 */
export type LegalSortOptions =
  | { axis: "time"; options: readonly ["newest", "oldest"] }
  | { axis: "rank"; options: readonly ["relevance", "recent"] }
  | { axis: "none" };

export function legalSortOptions(descriptor: SetDescriptor): LegalSortOptions {
  switch (descriptor.kind) {
    case "complete_chronological":
    case "filtered_exact":
      // Browse + filtered-exact: a time DIRECTION over the declared cursor key.
      // The UI may expose "oldest" only when the backing data source advertises
      // true server ascending keyset paging; without that support it must no-op.
      return { axis: "time", options: ["newest", "oldest"] };
    case "keyword_pageable":
      // Search, pageable: the relevance/recent rank lens (the search header owns
      // this control). "recent" == time-newest over the lexical candidate set.
      return { axis: "rank", options: ["relevance", "recent"] };
    case "relevance_bounded":
      // Ranked bounded sample: no honest in-set re-order; escape link only.
      return { axis: "none" };
    default: {
      // Exhaustiveness guard: a new descriptor kind must declare its legal sort
      // surface here, or this is a compile error — the contract, not a lint fix.
      const _exhaustive: never = descriptor;
      return _exhaustive;
    }
  }
}
