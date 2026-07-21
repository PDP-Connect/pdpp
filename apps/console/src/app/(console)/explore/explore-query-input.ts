// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic for the UNIFIED Explore query input (Slice 2, design.md §4).
 *
 * ONE input expresses free text + filter chips + an id-jump (Gmail's exemplar:
 * one bar = text + chips + advanced; a pasted id resolves inline, never a 2nd box).
 * This module is the no-React core so the recognition-over-recall behaviour is
 * unit-testable without rendering the canvas:
 *
 *   - `detectRecordIdJump` — is the current draft an exact-record-id shape? If so
 *     the input offers a "↵ Jump to record <id>" affordance (command-palette
 *     style) INLINE, not a second search box (resolves feedback #4).
 *   - `buildTypeaheadSuggestions` — the recognition menu opened from the input:
 *     source / stream / `has:image` / date chips, each EQUIVALENT to the operator
 *     behind it (selecting a `has:image` chip yields the identical query to typing
 *     `has:image`). Operators stay the power path; chips are recognition (#5).
 *   - `applySuggestion` — fold a picked suggestion into the draft (append the
 *     operator token / set the facet), producing the same query a typist would.
 *
 * Everything here returns plain data; the component wires the keyboard (arrow/Enter
 * to pick, Escape to close) and the navigate() push.
 */

/** A record id looks like a connector-key token: no spaces, not an operator (`k:v`). */
const RECORD_ID_SHAPE_RE = /^[\w.:/-]{6,}$/;
const OPERATOR_SHAPE_RE = /^-?[a-z_]+:.+$/i;
const TRAILING_TOKEN_RE = /(^|\s)(\S*)$/;
const WHITESPACE_RE = /\s/;

/**
 * Whether the trimmed draft is plausibly an exact record id the owner pasted/typed
 * (so the input can offer a jump affordance). It must be a single bare token, at
 * least 6 chars, and NOT an operator (`con:x`) or a negation (`-con:x`) — those are
 * filters, not ids. Multi-word drafts are free-text searches, never an id jump.
 */
export function detectRecordIdJump(draft: string): string | null {
  const trimmed = draft.trim();
  if (!trimmed || WHITESPACE_RE.test(trimmed)) {
    return null;
  }
  if (OPERATOR_SHAPE_RE.test(trimmed)) {
    return null;
  }
  return RECORD_ID_SHAPE_RE.test(trimmed) ? trimmed : null;
}

export type SuggestionKind = "source" | "stream" | "has-image" | "has-link" | "date" | "search";

export interface QuerySuggestion {
  /**
   * Record count for this facet value (honest: only present when the server
   * provided it; never fabricated). Rendered as a count badge in the menu.
   */
  count?: number;
  /** Stable id for React keys + keyboard cursor. */
  id: string;
  kind: SuggestionKind;
  /** Recognition label shown in the menu (e.g. "Source: YNAB"). */
  label: string;
  /** The operator/token this chip is equivalent to (e.g. `con:ynab`), for the hint. */
  operator: string;
  /**
   * Section heading to render ABOVE this item (only present on the FIRST item
   * of each logical group: SOURCES, STREAMS, FILTERS, SEARCH).
   */
  sectionLabel?: string;
  /** For source/stream: the concrete value the facet toggle should apply. */
  value?: string;
}

export interface TypeaheadInput {
  /**
   * Per-connection record counts (honest: optional; only present when the server
   * provided them). Used to show counts next to source suggestions.
   */
  connectionCounts?: ReadonlyMap<string, number>;
  /** Connection facets in scope (display name + id). */
  connections: ReadonlyArray<{ connectionId: string; displayName: string }>;
  /** The active trailing fragment the owner is typing (drives fuzzy match). */
  fragment: string;
  /** Whether `has:image` is already active (so it isn't re-suggested). */
  hasImageActive: boolean;
  /** Whether `has:link` is already active. */
  hasLinkActive: boolean;
  /** Max suggestions to return (bounded menu). */
  limit?: number;
  /** Already-selected connection ids (excluded from suggestions — recognition, not noise). */
  selectedConnectionIds: ReadonlySet<string>;
  /** Already-selected stream names (excluded from suggestions). */
  selectedStreams: ReadonlySet<string>;
  /**
   * Per-stream record counts (honest: optional; only present when the server
   * provided them). Used to show counts next to stream suggestions.
   */
  streamCounts?: ReadonlyMap<string, number>;
  /** Stream names in scope. */
  streams: readonly string[];
}

const DEFAULT_LIMIT = 8;

function matches(fragment: string, haystack: string): boolean {
  if (!fragment) {
    return true;
  }
  return haystack.toLowerCase().includes(fragment.toLowerCase());
}

/** Collect source suggestions matching the fragment (pure, extracted for complexity budget). */
function collectSourceSuggestions(input: TypeaheadInput, frag: string): QuerySuggestion[] {
  const out: QuerySuggestion[] = [];
  for (const c of input.connections) {
    if (input.selectedConnectionIds.has(c.connectionId)) {
      continue;
    }
    if (matches(frag, c.displayName) || matches(frag, c.connectionId)) {
      out.push({
        count: input.connectionCounts?.get(c.connectionId),
        id: `source:${c.connectionId}`,
        kind: "source",
        label: `Source: ${c.displayName}`,
        operator: `con:${c.displayName}`,
        value: c.connectionId,
      });
    }
  }
  return out;
}

/** Collect stream suggestions matching the fragment (pure, extracted for complexity budget). */
function collectStreamSuggestions(input: TypeaheadInput, frag: string): QuerySuggestion[] {
  const out: QuerySuggestion[] = [];
  for (const s of input.streams) {
    if (input.selectedStreams.has(s)) {
      continue;
    }
    if (matches(frag, s)) {
      out.push({
        count: input.streamCounts?.get(s),
        id: `stream:${s}`,
        kind: "stream",
        label: `Stream: ${s}`,
        operator: `stream:${s}`,
        value: s,
      });
    }
  }
  return out;
}

/** Collect fixed-filter suggestions (has:image / has:link / date) matching the fragment. */
function collectFilterSuggestions(input: TypeaheadInput, frag: string): QuerySuggestion[] {
  const out: QuerySuggestion[] = [];
  if (!input.hasImageActive && (matches(frag, "has:image") || matches(frag, "image"))) {
    out.push({ id: "has-image", kind: "has-image", label: "Has image", operator: "has:image" });
  }
  if (!input.hasLinkActive && (matches(frag, "has:link") || matches(frag, "link"))) {
    out.push({ id: "has-link", kind: "has-link", label: "Has link", operator: "has:link" });
  }
  if (matches(frag, "date") || matches(frag, "before") || matches(frag, "after")) {
    out.push({ id: "date", kind: "date", label: "Date range", operator: "before:YYYY-MM-DD / after:YYYY-MM-DD" });
  }
  return out;
}

/** Stamp sectionLabel on the first item of an array (mutates first element only). */
function stampSectionLabel(arr: QuerySuggestion[], label: string): void {
  if (arr[0]) {
    arr[0] = { ...arr[0], sectionLabel: label };
  }
}

/**
 * Build the bounded typeahead suggestion list for the current trailing fragment.
 *
 * Order: source chips (SOURCES), stream chips (STREAMS), fixed filter chips
 * (FILTERS: has:image / has:link / date), then an always-last SEARCH-fallback
 * when the fragment is non-empty. Each suggestion carries:
 *   - the operator it is equivalent to (power-path hint beside the label)
 *   - an optional record count (honest: only present when the server provided it)
 *   - an optional sectionLabel on the FIRST item of each group
 *
 * The SEARCH-fallback is always last so the owner never gets a dead end — even
 * when the fragment matches nothing, "Search: {fragment}" is always offered.
 */
export function buildTypeaheadSuggestions(input: TypeaheadInput): QuerySuggestion[] {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const frag = input.fragment.trim();

  const sources = collectSourceSuggestions(input, frag);
  const streams = collectStreamSuggestions(input, frag);
  const filters = collectFilterSuggestions(input, frag);

  stampSectionLabel(sources, "SOURCES");
  stampSectionLabel(streams, "STREAMS");
  stampSectionLabel(filters, "FILTERS");

  const combined = [...sources, ...streams, ...filters];
  // Reserve one slot for the SEARCH-fallback when a fragment is active.
  const cappedBody = frag ? combined.slice(0, limit - 1) : combined.slice(0, limit);

  // SEARCH-fallback: always last when a non-empty fragment is typed. Ensures the
  // owner always has an escape to a literal text search even when nothing matches.
  if (frag) {
    cappedBody.push({
      id: `search:${frag}`,
      kind: "search",
      label: `Search: ${frag}`,
      operator: frag,
      sectionLabel: cappedBody.length === 0 ? "SEARCH" : undefined,
    });
  }

  return cappedBody;
}

/**
 * The trailing whitespace-delimited fragment of a draft (what the owner is mid-typing).
 * Used to drive the typeahead so suggestions narrow as they type after a space.
 */
export function trailingFragment(draft: string): string {
  const m = draft.match(TRAILING_TOKEN_RE);
  return m?.[2] ?? "";
}

/**
 * Replace the trailing fragment of `draft` with `token` (+ a trailing space), so a
 * picked operator chip appends exactly the operator a typist would write. The chip
 * and the keystroke therefore produce the IDENTICAL query string (the equivalence
 * the design requires). For source/stream the caller instead routes through the
 * facet toggle (the canonical include state) — see `applySuggestion`.
 */
export function appendOperatorToken(draft: string, token: string): string {
  const replaced = draft.replace(TRAILING_TOKEN_RE, (_full, lead: string) => `${lead}${token}`);
  return `${replaced.trim()} `;
}
