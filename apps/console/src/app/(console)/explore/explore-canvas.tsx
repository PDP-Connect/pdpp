/**
 * ExploreCanvas — the Ink Carbon "Recordroom · Explore" reading room.
 *
 * The deepest console view: one record viewer for the whole product, with
 * owner-grade query power (typed operators + a machine-parity query line),
 * instance-true facets, day-grouped feed, and a record inspector that always
 * shows the full owner view plus what stays withheld and what's connected.
 *
 * ── DATA SEAM (real, not mocked) ──────────────────────────────────
 * This component consumes the SAME `RecordsExplorerData` the live page already
 * assembles via `assembleExplorerData(...)` (see page.tsx). It renders that
 * shape; it never calls a data source itself. URL state (`q`, `connection`,
 * `stream`, `since`, `until`, `peek`, `order`, `search_sort`, `cursor`,
 * `anchor`) is the source of truth — every server-backed interaction navigates
 * with a local `buildHref`, so the SSR re-fetch stays authoritative. Client-only
 * operators filter the already-loaded feed in the browser.
 *
 * ── HONESTY ENGINE (the set-descriptor) ───────────────────────────
 * Every claim the feed makes about its own completeness is CONSTRAINED by
 * `data.descriptor` (the typed set-descriptor). The presentation layer reads the
 * descriptor; it never invents a completeness claim the descriptor does not
 * permit. The count line gates "Showing N of M" on an exact descriptor for the
 * current scope (`exactCountIsCurrent`); the search header label comes straight
 * from `feedHeaderLabel(descriptor)`; the exhaustive "Browse all matching
 * records" door appears only for descriptors that can page to the end.
 *
 * ── SERVER-DECLARED SIGNALS (no client-side reinvention) ──────────
 *   - Blobs / images: every feed entry and peek field carries a server-declared
 *     `blobAffordance` (built by operator-ui `buildBlobAffordance`). The feed
 *     badge and the inspector blob render from THAT signal only — never a URL
 *     regex.
 *   - Relationships: resolved server-side and passed in as `peekRelationships`.
 *   - field:value etc.: a `field:value` over a declared exact-filterable field
 *     is a real server `filter[]` param; only server-inexpressible operators
 *     stay client-side, and the compiled line marks those honestly.
 */
"use client";

import { IcInput } from "@pdpp/brand-react";
import { kindGlyph, RecordIdentity } from "@pdpp/operator-ui/components/record-identity";
import { feedDescription, feedSectionTitle } from "@pdpp/operator-ui/components/views/explorer-utils";
import {
  type ExplorerConnectionFacet,
  type ExplorerFeedEntry,
  type ExplorerLens,
  type ExplorerStreamDoor,
  type ExplorerStreamSeeAllLink,
  type ExplorerWarning,
  explorerPeekParam,
  type RecordsExplorerData,
} from "@pdpp/operator-ui/components/views/records-explorer-view";
import type { BucketSeries } from "@pdpp/operator-ui/explore/over-time-chart";
import {
  descriptorHasMore,
  descriptorIsTimeOrdered,
  descriptorNextCursor,
  feedHeaderLabel,
  legalSortOptions,
} from "@pdpp/operator-ui/explore/set-descriptor";
import { rowPrimary, rowSecondary } from "@pdpp/operator-ui/lib/record-preview";
import { Timestamp } from "@pdpp/operator-ui/ui/timestamp";
import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { RecordInspector } from "../components/record-inspector.tsx";
import { loadExploreBuckets } from "./actions.ts";
import {
  activeRangeKey,
  buildCompleteStreamHref,
  buildRecordDetailHref,
  type ExploreRange,
  resolveRowKeyAction,
  sinceForRange,
  toggleIdSelection,
} from "./explore-control-state.ts";
import {
  ANY_TIME_LABEL,
  customRangeInputs,
  dateChipLabel,
  dateNavFromLift,
  resolveCustomRange,
} from "./explore-date.ts";
import {
  computeSourceGroupedStreamFacets,
  filterSourceGroups,
  type SourceStreamGroup,
  totalVisibleStreamFacets,
} from "./explore-facet-groups.ts";
import {
  type BurstGroup,
  type DayGroupWithBursts,
  type DayRenderUnit,
  groupFeedDaysNoBursts,
  groupFeedWithBursts,
} from "./explore-feed-grouping.ts";
import {
  chipTokens,
  hasClientSideTokens,
  liftDateTokens,
  liftFacetTokens,
  type ParsedQuery,
  parseQuery,
  type QueryFacetLift,
  removeToken,
} from "./explore-grammar.ts";
import {
  buildCurrentViewHref,
  buildHref,
  buildNavigateHref,
  type NavigateOpts,
  type SortOrder,
  withOrderSuffix,
} from "./explore-navigation.ts";
import type { PeekRelationships } from "./explore-peek-relationships.ts";
import {
  feedAriaBusy,
  isLoadMorePending,
  loadMoreDisabled,
  loadMoreLabel,
  loadMoreRestingLabel,
  type PendingKind,
} from "./explore-pending.ts";
import {
  appendOperatorToken,
  buildTypeaheadSuggestions,
  detectRecordIdJump,
  type QuerySuggestion,
  trailingFragment,
} from "./explore-query-input.ts";
import {
  activeSavedView,
  addSavedView,
  canSaveCurrentView,
  isAllView,
  parseSavedViews,
  removeSavedView,
  SAVED_VIEWS_STORAGE_KEY,
  type SavedView,
} from "./explore-saved-views.ts";
import { OverTimeChart } from "./over-time-chart.tsx";

const UNDERSCORE_RE = /_/g;
/** Split a query string on whitespace (used by zero-results token removal). */
const QUERY_WHITESPACE_RE = /\s+/;
/**
 * F5: how many already-loaded Upcoming day-groups the expanded section paints
 * before the in-place "Show N more loaded days" toggle. Bounds the 188-budget-month
 * (772-row) wall to a previewed, grouped list without hiding any record — every
 * loaded group is one click away, every unloaded record is reachable via the
 * server load-more beneath it (count==reachability).
 */
const UPCOMING_PREVIEW_DAYS = 10;
/** Strips the trailing `/explore` segment to derive the records section base. */
const EXPLORE_SUFFIX_RE = /\/explore$/;
/** Strips the trailing whitespace-delimited fragment (keeps the leading separator). */
const TRAILING_FRAGMENT_RE = /(^|\s)\S*$/;

/**
 * Resolve typed `con:` fragments to concrete connection IDs against the known
 * facets (match on id, connectorId, or displayName — case-insensitive substring),
 * so the TYPED operator selects the SAME connection the chip would. Fragments that
 * match no connection are dropped (an honest no-op, never a phantom filter).
 */
function resolveConnectionFragments(
  fragments: readonly string[],
  connections: readonly ExplorerConnectionFacet[]
): string[] {
  const ids = new Set<string>();
  for (const frag of fragments) {
    const f = frag.toLowerCase();
    for (const c of connections) {
      if (
        c.connectionId.toLowerCase() === f ||
        c.connectorId.toLowerCase().includes(f) ||
        c.displayName.toLowerCase().includes(f)
      ) {
        ids.add(c.connectionId);
      }
    }
  }
  return [...ids];
}

/** Union two id lists, preserving order and dropping duplicates. */
function unionIds(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

// `dateNavFromLift` (the typed `after:`/`before:` → canonical (since, until) delta)
// now lives in the pure `explore-date.ts` module beside `resolveCustomRange`, so the
// canonical-date normalization is one importable, unit-tested place — shared by the
// in-app commit path and the URL/SSR/reload normalizer (see `explore-date.test.ts`).

/**
 * The canonical `(since, until)` nav delta for a date-control write. A PRESET
 * ("today"/"7d"/"30d"/"all") is a sliding/open window — `since` from the relative
 * range, `until` cleared. A CUSTOM `{since, until}` is a fixed/anchored window written
 * VERBATIM (already resolved at the edge by `resolveCustomRange`) — it must NOT
 * hard-clear `until`, or the custom range could never be set (the old defect). Pure +
 * module-scope so the one date writer is testable and the component body stays small.
 */
function rangeNav(range: ExploreRange | { since: string; until: string }): { since: string; until: string } {
  return typeof range === "string" ? { since: sinceForRange(range), until: "" } : range;
}

/** The URL-state a date-operator normalization needs to rebuild the canonical href. */
interface DateNormalizeState {
  excludeConnectionIds: readonly string[];
  excludeStreams: readonly string[];
  order: SortOrder;
  peek?: string;
  query: string;
  searchSort: "relevance" | "recent";
  selectedConnectionIds: readonly string[];
  selectedStreams: readonly string[];
  since: string;
  until: string;
}

/**
 * The canonical href for a URL/SSR/reload load whose `query` still carries a typed date
 * operator (`before:`/`after:`), or `null` when there is none to lift. This is the pure
 * core of the mount-time normalizer: it lifts the date operators OUT of `query` and INTO
 * the canonical `(since, until)` window (via the SAME `dateNavFromLift` the commit path
 * uses), carrying the untyped endpoint forward (last-write-wins). Cursors/anchor are
 * dropped — a normalized window is a fresh feed-defining state — while peek/order/scope
 * survive. Pure + module-scope so the effect body stays a guard + `router.replace`, and
 * the normalization is unit-testable without rendering the canvas (`explore-date.test.ts`
 * covers `dateNavFromLift`; the href assembly is `buildHref`, already tested).
 */
function dateNormalizedHref(explorePath: string, state: DateNormalizeState): string | null {
  const dateLift = liftDateTokens(state.query);
  if (dateLift.after === null && dateLift.before === null) {
    return null;
  }
  const dateNav = dateNavFromLift(dateLift.after, dateLift.before);
  return withOrderSuffix(
    buildHref(explorePath, {
      query: dateLift.rest,
      connectionIds: state.selectedConnectionIds,
      excludeConnectionIds: state.excludeConnectionIds,
      streams: state.selectedStreams,
      excludeStreams: state.excludeStreams,
      // Only the endpoint the URL actually typed overrides the canonical window; the
      // other side is carried forward from the existing window (never stacks/clears).
      since: dateNav.since ?? state.since,
      until: dateNav.until ?? state.until,
      searchSort: state.searchSort === "recent" ? "recent" : undefined,
      // Preserve a peeked record from a shared `?q=after:X&peek=Y` link.
      peek: state.peek,
    }),
    state.order
  );
}

interface FacetSelection {
  connectionIds: string[];
  excludeConnectionIds: string[];
  excludeStreams: string[];
  streams: string[];
}

/** True when a facet lift produced no con/stream tokens (free text / date only). */
function liftHasNoFacets(lift: QueryFacetLift): boolean {
  return (
    lift.includeConnections.length === 0 &&
    lift.excludeConnections.length === 0 &&
    lift.includeStreams.length === 0 &&
    lift.excludeStreams.length === 0
  );
}

/**
 * Compose the next facet selection from the current selection + the lifted facet
 * tokens. Include wins over exclude for the same id/stream (coherent state, matches
 * the toggles). Pure + module-scope so `commitQuery` stays small (and the union/
 * include-wins rule is one tested place).
 */
function composeFacetSelection(
  cur: FacetSelection,
  lift: QueryFacetLift,
  connections: readonly ExplorerConnectionFacet[]
): FacetSelection {
  const liftedInclude = resolveConnectionFragments(lift.includeConnections, connections);
  const liftedExclude = resolveConnectionFragments(lift.excludeConnections, connections);
  const nextInclude = unionIds(cur.connectionIds, liftedInclude);
  const nextStreams = unionIds(cur.streams, lift.includeStreams);
  return {
    connectionIds: nextInclude,
    streams: nextStreams,
    excludeConnectionIds: unionIds(cur.excludeConnectionIds, liftedExclude).filter((id) => !nextInclude.includes(id)),
    excludeStreams: unionIds(cur.excludeStreams, lift.excludeStreams).filter((s) => !nextStreams.includes(s)),
  };
}

/** The operator token a non-facet suggestion appends (facet kinds route via toggle). */
function suggestionToken(kind: Exclude<QuerySuggestion["kind"], "source" | "stream" | "search">): string {
  if (kind === "has-image") {
    return "has:image";
  }
  if (kind === "has-link") {
    return "has:link";
  }
  return "before:";
}

/**
 * De-duplicate warnings by (code, message) so the warning list never renders
 * two elements with the same React key. The assembler already merges fan-in
 * failures into a single summary; this is the last-line guard for any per-stream
 * warning (e.g. `search_meta_warning`, `search_page_limited`) that could repeat.
 */
function dedupeWarnings(warnings: readonly ExplorerWarning[]): ExplorerWarning[] {
  const seen = new Set<string>();
  const out: ExplorerWarning[] = [];
  for (const w of warnings) {
    const sig = `${w.code}:${w.message}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(w);
    }
  }
  return out;
}

interface ExploreCanvasProps {
  data: RecordsExplorerData;
  /**
   * The Explore route base path (e.g. "/explore"). A plain string —
   * NOT the function-bearing `Routes` object — because this is a Client
   * Component and RSC cannot serialize the route helper methods across the
   * server→client boundary. The page passes `dashboardRoutes.section.explore`.
   */
  explorePath: string;
  /** Display sort order (newest|oldest) read from the URL by the page. */
  order?: SortOrder;
  /**
   * Relationship links for the inspected record, resolved server-side from
   * declared `expand_capabilities` + connector manifests via the proven
   * `records/lib/relationships.ts` helpers. Plain serializable data; `null` when
   * no record is open or no readable metadata was available.
   */
  peekRelationships?: PeekRelationships | null;
}

/**
 * Calm placeholder shown in the over-time chart's slot while the DEFERRED bucket
 * band loads post-mount. Decorative (aria-hidden) — the feed below is already
 * rendered and interactive, so there is nothing to announce; it only reserves the
 * chart's height so the feed never jumps when the real band arrives (no layout
 * shift). Mirrors `.rr-x-chart` box model (head row + band) and reuses the EXISTING
 * load-more skeleton tokens (`rr-x-skel-bar` + the brand `fade-in`/shimmer
 * keyframes, already reduced-motion-gated in components.css) — no hardcoded styles,
 * no new keyframe. Only shown when `data.bucketRequest` is non-null (so search /
 * relevance_bounded / no-targets render nothing at all, same as the real chart).
 */
function ChartSkeleton() {
  return (
    <div aria-hidden className="rr-x-chart rr-x-chart-skeleton">
      <div className="rr-x-chart__head">
        <span className="rr-x-skel-bar rr-x-skel-bar--title" />
        <span className="rr-x-skel-bar rr-x-skel-bar--attr" />
      </div>
      <div className="rr-x-chart-skeleton__band">
        <span className="rr-x-skel-bar rr-x-chart-skeleton__bar" />
      </div>
    </div>
  );
}

// buildRecordDetailHref now lives in ./explore-control-state.ts (pure + unit-tested)
// alongside buildCompleteStreamHref, sharing one routeId resolver. See its doc for
// why the detail href is built from path segments, not appended to the stream href.

/**
 * Build the complete stream-records route backing a feed entry. Uses concrete
 * connection identity when present so multi-account connector streams stay
 * distinct; falls back to connectorId only for search rows that do not carry a
 * connection binding yet. THE single complete-stream helper — feed rows, the
 * header link, the inspector escape ramp, and the per-source see-all door all
 * route through it.
 */
function buildStreamRecordsHref(
  recordsBasePath: string,
  entry: { connectorId: string; connectionId: string | null; stream: string },
  exactFilters: readonly { key: string; value: string }[] = [],
  order: "newest" | "oldest" = "newest"
): string {
  return buildCompleteStreamHref(recordsBasePath, entry, { exactFilters, order });
}

function hasUnsupportedFullStreamState(
  clientSide: boolean,
  textTerms: readonly string[],
  since: string,
  until: string
): boolean {
  return clientSide || textTerms.length > 0 || Boolean(since || until);
}

// ─── Client-side feed predicate ───────────────────────────────────
//
// Applies ONLY the operators the server cannot express. A `field:value` over a
// declared exact-filterable field is a server `filter[]` param (the server
// already narrowed the feed), so it is NOT re-applied here; only undeclared
// fields fall back to this honest in-window text match.

// `has:link` is genuinely server-inexpressible (no declared "link" capability),
// so it remains an honest client-side text match over the preview — clearly a
// last-resort fallback, never used for image/blob detection.
const URL_LINK_RE = /^https?:\/\//i;

function entryHaystack(entry: ExplorerFeedEntry): string {
  const p = entry.preview;
  // Honest declared content only: the stream id, the declared-role preview slots, the
  // generic key/value fields, and (for a search hit) the matched snippet. NEVER the old
  // field-name-guessing timeline summary, which is gone.
  const parts = [
    entry.stream,
    entry.snippet,
    p?.title,
    p?.body,
    p?.author,
    p?.amount,
    ...(p?.fields ?? []).flatMap((f) => [f.label, f.value]),
  ];
  return parts
    .filter((x): x is string => typeof x === "string")
    .join(" ")
    .toLowerCase();
}

function entryHasImage(entry: ExplorerFeedEntry): boolean {
  // Declared signal ONLY: the stream declared a `blob`-typed field and the RS
  // decorated it with a usable `fetch_url`. No URL regex, no payload guessing.
  return entry.blobAffordance?.state === "available";
}

function entryHasLink(entry: ExplorerFeedEntry): boolean {
  const candidates = [entry.preview?.body, entry.preview?.title, entry.snippet];
  return candidates.some((c) => typeof c === "string" && URL_LINK_RE.test(c));
}

function passesClientFilter(
  entry: ExplorerFeedEntry,
  parsed: ParsedQuery,
  serverFilterableFields: ReadonlySet<string>
): boolean {
  if (parsed.role) {
    const author = entry.preview?.author?.toLowerCase() ?? "";
    if (!author.includes(parsed.role)) {
      return false;
    }
  }
  if (parsed.hasImage && !entryHasImage(entry)) {
    return false;
  }
  if (parsed.hasLink && !entryHasLink(entry)) {
    return false;
  }
  // `is:folded` has no real analog (the feed is never folded), so it matches
  // nothing rather than pretending — an honest empty result for an honest token.
  if (parsed.folded) {
    return false;
  }
  // Only undeclared fields are post-filtered here. Declared exact-filterable
  // fields were applied by the server, so re-filtering them client-side would
  // be redundant (and could wrongly drop rows on a fuzzy text mismatch).
  const clientFields = parsed.fields.filter((f) => !serverFilterableFields.has(f.key.toLowerCase()));
  if (clientFields.length > 0) {
    const hay = entryHaystack(entry);
    if (!clientFields.every((f) => hay.includes(f.key.toLowerCase()) || hay.includes(f.value))) {
      return false;
    }
  }
  return true;
}

// ─── Pure derivations (kept out of the component to bound complexity) ──
//
// Source-grouped stream facets (parent source → its streams, with honest
// per-source loaded counts) live in ./explore-facet-groups.ts — a pure module
// node --test exercises directly for the count-honesty/no-misattribution
// guarantees (W4 / RL2 / RL3).

function canShowTimeSort(data: RecordsExplorerData): boolean {
  return data.supportsTimelineDirection && legalSortOptions(data.descriptor).axis === "time";
}

interface FilterChip {
  /** Whether this chip can be toggled between is/is-not. Only connection/stream facets support it. */
  canNegate: boolean;
  clear: () => void;
  id: string;
  /** Full display label (kept for fallback / "clear all" label). */
  label: string;
  /** Toggle negation on this chip (is ↔ is not). */
  negate: () => void;
  /** Whether the current chip is already in negated (exclude) state. */
  negated: boolean;
  /** "is" or "is not" */
  operator: "is" | "is not";
  /** Which "property" the chip filters (e.g. "source", "stream", "date", or a free-text token label). */
  property: string;
  /** The value being filtered (display form). */
  value: string;
}

/**
 * Build the active-filter chip list from selection + parsed query state. Pure so
 * the component body stays small; the chip `clear` handlers close over the
 * toggle/navigate callbacks the caller passes in.
 */
function buildFilterChips(args: {
  selectedConnectionIds: readonly string[];
  selectedStreams: readonly string[];
  excludeConnectionIds: readonly string[];
  excludeStreams: readonly string[];
  connections: readonly ExplorerConnectionFacet[];
  tokens: ReadonlyArray<{ label: string; raw: string }>;
  query: string;
  toggleConnection: (id: string) => void;
  toggleStream: (s: string) => void;
  toggleExcludeConnection: (id: string) => void;
  toggleExcludeStream: (s: string) => void;
  navigate: (opts: NavigateOpts) => void;
}): FilterChip[] {
  const out: FilterChip[] = [];
  for (const id of args.selectedConnectionIds) {
    const name = args.connections.find((c) => c.connectionId === id)?.displayName ?? id;
    out.push({
      id: `con:${id}`,
      label: name,
      property: "source",
      operator: "is",
      value: name,
      negated: false,
      canNegate: true,
      negate: () => {
        // Toggle include → exclude: remove from include, add to exclude
        args.toggleConnection(id);
        args.toggleExcludeConnection(id);
      },
      clear: () => args.toggleConnection(id),
    });
  }
  // EXCLUDE chips render the facet/operator exclusion as a visible chip in the SAME
  // active-query row, so the facet "is not", the `-con:` operator, and the chip all
  // round-trip to one canonical query (item #9/#10).
  for (const id of args.excludeConnectionIds) {
    const name = args.connections.find((c) => c.connectionId === id)?.displayName ?? id;
    out.push({
      id: `xcon:${id}`,
      label: `not ${name}`,
      property: "source",
      operator: "is not",
      value: name,
      negated: true,
      canNegate: true,
      negate: () => {
        // Toggle exclude → include: remove from exclude, add to include
        args.toggleExcludeConnection(id);
        args.toggleConnection(id);
      },
      clear: () => args.toggleExcludeConnection(id),
    });
  }
  for (const s of args.selectedStreams) {
    out.push({
      id: `stream:${s}`,
      label: `stream: ${s}`,
      property: "stream",
      operator: "is",
      value: s,
      negated: false,
      canNegate: true,
      negate: () => {
        args.toggleStream(s);
        args.toggleExcludeStream(s);
      },
      clear: () => args.toggleStream(s),
    });
  }
  for (const s of args.excludeStreams) {
    out.push({
      id: `xstream:${s}`,
      label: `not stream: ${s}`,
      property: "stream",
      operator: "is not",
      value: s,
      negated: true,
      canNegate: true,
      negate: () => {
        args.toggleExcludeStream(s);
        args.toggleStream(s);
      },
      clear: () => args.toggleExcludeStream(s),
    });
  }
  // NB: the active DATE window is NOT pushed here. It is rendered ONCE, by the
  // dedicated Date chip in the command bar (the canonical single representation).
  // The old `rangeLabel`-into-the-chip-strip push produced a SECOND date render
  // beside the highlighted shortcut — a Part-0 double-representation defect — and
  // is intentionally removed (date-controls cell).
  args.tokens.forEach((tk, i) => {
    // Derive the REAL property/operator/value from the token's canonical raw form so the
    // 3-zone chip reads "stream | is | messages", not "filter | is | stream: messages".
    // raw shapes: "stream:messages", "-con:abc", "has:link", "before:2026-01-01", or a
    // bare word (free-text search). A leading "-" is the exclude operator. A bare word
    // (no colon) is a free-text search term → property "search".
    const raw = tk.raw;
    const negated = raw.startsWith("-");
    const body = negated ? raw.slice(1) : raw;
    const colon = body.indexOf(":");
    const property = colon > 0 ? body.slice(0, colon) : "search";
    const value = colon > 0 ? body.slice(colon + 1) : body;
    out.push({
      id: `tok:${i}`,
      label: tk.label,
      property,
      operator: negated ? "is not" : "is",
      value,
      negated,
      canNegate: false,
      negate: () => {
        // token chips do not support negation toggling (use -operator: in the query)
      },
      clear: () => args.navigate({ query: removeToken(args.query, tk.raw) }),
    });
  });
  return out;
}

function CopyViewLinkButton({ href }: { href: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    []
  );

  const resetSoon = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setCopyState("idle"), 1200);
  }, []);

  const copy = useCallback(async () => {
    const absolute = new URL(href, window.location.origin).toString();
    if (!navigator.clipboard?.writeText) {
      setCopyState("failed");
      resetSoon();
      return;
    }
    try {
      await navigator.clipboard.writeText(absolute);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    resetSoon();
  }, [href, resetSoon]);
  const copyLabel = copyState === "copied" ? "copied" : "copy view link";

  return (
    <button className="rr-link rr-x-copyview" onClick={copy} type="button">
      {copyState === "failed" ? "copy failed" : copyLabel}
    </button>
  );
}

// ─── Unified query input (ONE box: text + chips + id-jump) ─────────
//
// design.md §4 / wireframe A: ONE input (Gmail's exemplar) — free text + filter
// chips + an inline "Jump to record" affordance. There is NO second record-id box;
// a pasted/typed exact id is DETECTED and offered as a command-palette-style jump
// suggestion (resolves feedback #4). A typeahead menu offers recognition chips
// (source / stream / has:image / date), each EQUIVALENT to the operator behind it
// (#5). Enter submits (#1); ↑/↓ move the menu cursor; Enter on a highlighted
// suggestion picks it; Escape closes the menu. Operators remain the power path.

interface QueryInputProps {
  /** Per-connection loaded counts (honest: from streamGroups, never fabricated). */
  connectionCounts: ReadonlyMap<string, number>;
  connections: readonly ExplorerConnectionFacet[];
  draft: string;
  onCommitQuery: () => void;
  onDraftChange: (value: string) => void;
  onSearchRecordId: (recordId: string) => void;
  onToggleConnection: (id: string) => void;
  onToggleStream: (s: string) => void;
  /** The record-id "jump" feedback line from a prior id search (kept for honesty). */
  recordIdJumpFeedback: string | null;
  recordsBasePath: string;
  /** Concrete connection when exactly one is selected (lets a jump open the record directly). */
  scopedConnection: ExplorerConnectionFacet | null;
  selectedConnectionIds: readonly string[];
  selectedStream: string | null;
  selectedStreams: readonly string[];
  /** Per-stream loaded counts accumulated across all connections. */
  streamCounts: ReadonlyMap<string, number>;
  streamSuggestions: readonly string[];
}

// No suggestion is highlighted. The typeahead opens with NOTHING auto-selected so
// that Enter on free text runs the literal search instead of silently applying the
// first name-matching facet (the Enter-hijack, re-walk F3). A suggestion becomes
// highlighted ONLY when the owner explicitly arrows into the menu. Canonical combobox
// behavior (WAI-ARIA: aria-activedescendant is unset until the user navigates).
const NO_HIGHLIGHT = -1;

function QueryInput(props: QueryInputProps) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [cursor, setCursor] = useState(NO_HIGHLIGHT);

  const parsedDraft = useMemo(() => parseQuery(props.draft), [props.draft]);
  // Detect a pasted/typed exact record id for the inline jump affordance.
  const jumpId = useMemo(() => detectRecordIdJump(props.draft), [props.draft]);

  const suggestions = useMemo<QuerySuggestion[]>(
    () =>
      buildTypeaheadSuggestions({
        connectionCounts: props.connectionCounts,
        connections: props.connections.map((c) => ({ connectionId: c.connectionId, displayName: c.displayName })),
        fragment: trailingFragment(props.draft),
        hasImageActive: parsedDraft.hasImage,
        hasLinkActive: parsedDraft.hasLink,
        selectedConnectionIds: new Set(props.selectedConnectionIds),
        selectedStreams: new Set(props.selectedStreams),
        streamCounts: props.streamCounts,
        streams: props.streamSuggestions,
      }),
    [
      props.draft,
      props.connections,
      props.connectionCounts,
      props.streamSuggestions,
      props.streamCounts,
      props.selectedConnectionIds,
      props.selectedStreams,
      parsedDraft.hasImage,
      parsedDraft.hasLink,
    ]
  );

  const jump = useCallback(() => {
    if (!jumpId) {
      return;
    }
    // When scoped to exactly one connection+stream, open the record directly;
    // otherwise fall back to the id search over the visible set (kept logic).
    if (props.scopedConnection && props.selectedStream) {
      router.push(
        buildRecordDetailHref(props.recordsBasePath, {
          connectionId: props.scopedConnection.connectionId,
          connectorId: props.scopedConnection.connectorId,
          recordId: jumpId,
          stream: props.selectedStream,
        })
      );
      return;
    }
    props.onSearchRecordId(jumpId);
  }, [jumpId, props, router]);

  // Selecting a suggestion produces the SAME query as typing its operator: source/
  // stream route through the facet toggle (the canonical include state); has:image /
  // has:link / date append the operator token verbatim. The "search" kind commits
  // the fragment as a literal search immediately. Either way chip == operator.
  const pickSuggestion = useCallback(
    (s: QuerySuggestion) => {
      setMenuOpen(false);
      if (s.kind === "source" && s.value) {
        props.onToggleConnection(s.value);
        // Strip the trailing fragment the owner was typing so the box doesn't keep
        // a half-typed source name after the facet captured the intent.
        props.onDraftChange(props.draft.replace(TRAILING_FRAGMENT_RE, "$1").trimEnd());
        return;
      }
      if (s.kind === "stream" && s.value) {
        props.onToggleStream(s.value);
        props.onDraftChange(props.draft.replace(TRAILING_FRAGMENT_RE, "$1").trimEnd());
        return;
      }
      if (s.kind === "search") {
        // The SEARCH-fallback commits the current fragment as a literal text search.
        // The operator field holds the raw fragment (set in buildTypeaheadSuggestions).
        props.onDraftChange(s.operator);
        props.onCommitQuery();
        return;
      }
      // At this point kind is "has-image" | "has-link" | "date" — all handled by suggestionToken.
      const kind = s.kind;
      if (kind === "has-image" || kind === "has-link" || kind === "date") {
        props.onDraftChange(appendOperatorToken(props.draft, suggestionToken(kind)));
      }
    },
    [props]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        return;
      }
      if (menuOpen && suggestions.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        setCursor((c) => {
          // From the no-highlight start, ArrowDown lands on the first option and
          // ArrowUp on the last; thereafter it wraps within the list.
          const len = suggestions.length;
          if (c === NO_HIGHLIGHT) {
            return e.key === "ArrowDown" ? 0 : len - 1;
          }
          const next = e.key === "ArrowDown" ? c + 1 : c - 1;
          return ((next % len) + len) % len;
        });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // Enter picks a suggestion ONLY when the owner has explicitly arrowed into
        // one (cursor >= 0). On free text with nothing highlighted, Enter submits the
        // literal query — it no longer silently applies the first name-matching facet
        // (the Enter-hijack, re-walk F3). This is the table-stakes Enter-to-submit (#1).
        const picked = menuOpen && cursor >= 0 && cursor < suggestions.length ? suggestions[cursor] : null;
        if (picked) {
          pickSuggestion(picked);
          return;
        }
        if (jumpId) {
          jump();
          return;
        }
        props.onCommitQuery();
      }
    },
    [menuOpen, suggestions, cursor, pickSuggestion, jumpId, jump, props]
  );

  return (
    <div className="rr-x-queryinput">
      <div className="rr-x-searchrow__input">
        <span aria-hidden className="rr-x-queryinput__icon">
          🔍
        </span>
        <IcInput
          aria-activedescendant={
            menuOpen && cursor >= 0 && cursor < suggestions.length ? `rr-x-typeahead-opt-${cursor}` : undefined
          }
          aria-autocomplete="list"
          aria-controls="rr-x-typeahead-listbox"
          aria-expanded={menuOpen && suggestions.length > 0}
          aria-label="Search or filter"
          className="rr-x-search"
          onBlur={() => setMenuOpen(false)}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            props.onDraftChange(e.target.value);
            setMenuOpen(true);
            // Typing never auto-highlights a suggestion — Enter stays a literal search
            // until the owner explicitly arrows into the menu (Enter-hijack fix, F3).
            setCursor(NO_HIGHLIGHT);
          }}
          onFocus={() => setMenuOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search or filter…"
          role="combobox"
          type="text"
          value={props.draft}
        />
        <button
          aria-label="Show filter chips"
          className="rr-x-queryinput__chevron"
          onClick={() => setMenuOpen((v) => !v)}
          type="button"
        >
          ⌄
        </button>
      </div>

      {/* Inline "Jump to record" affordance — command-palette style, NOT a 2nd box. */}
      {jumpId ? (
        <button className="rr-x-queryinput__jump" onClick={jump} onMouseDown={(e) => e.preventDefault()} type="button">
          ↵ Jump to record <span className="rr-x-queryinput__jump-id">{jumpId}</span>
        </button>
      ) : null}

      {/* Typeahead menu — recognition chips, each == its operator. The combobox
          input owns keyboard nav (↑/↓/Enter/Escape) and points aria-activedescendant
          at the highlighted option; mousedown picks before the input blur closes it.
          Options are focus-managed by the combobox (tabIndex -1), the canonical
          combobox-listbox pattern. */}
      {menuOpen && suggestions.length > 0 ? (
        <div aria-label="Filter suggestions" className="rr-x-typeahead" id="rr-x-typeahead-listbox" role="listbox">
          {suggestions.map((s, i) => (
            <div className="rr-x-typeahead__item" key={s.id}>
              {s.sectionLabel ? (
                <span aria-hidden="true" className="rr-x-typeahead__section">
                  {s.sectionLabel}
                </span>
              ) : null}
              <div
                aria-selected={i === cursor}
                className={["rr-x-typeahead__btn", i === cursor ? "is-active" : ""].filter(Boolean).join(" ")}
                id={`rr-x-typeahead-opt-${i}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSuggestion(s);
                }}
                role="option"
                tabIndex={-1}
              >
                <span className="rr-x-typeahead__label">{s.label}</span>
                {s.count === undefined ? (
                  <span className="rr-x-typeahead__op">{s.operator}</span>
                ) : (
                  <span className="rr-x-typeahead__count">{s.count.toLocaleString()}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {props.recordIdJumpFeedback ? <span className="rr-x-goto__feedback">{props.recordIdJumpFeedback}</span> : null}
    </div>
  );
}

// ─── Route progress bar (in-page navigation feedback) ─────────────
//
// A thin top progress bar (Vercel/Linear signature) shown while a soft
// same-route `router.push` is in flight inside a `useTransition`. The soft push
// never fires `loading.tsx`, so this is the only "the server is re-rendering"
// signal for filters/sort/range/search/Load-more/peek/"N new".
//
// Motion is design-system only (`rr-x-progress` in components.css):
//   - the indeterminate slide is a keyframe gated behind
//     `@media (prefers-reduced-motion: no-preference)`; reduced-motion users get
//     a static, visible bar (no flashing).
//   - the wrapper fades in via the `fade-in` keyframe / `--motion-enter` token.
// a11y: a polite live region with an sr-only "Loading" label names the state for
// assistive tech; the moving bar itself is decorative (`aria-hidden`).
function RouteProgress({ active }: { active: boolean }) {
  if (!active) {
    return null;
  }
  return (
    <div aria-live="polite" className="rr-x-progress" role="status">
      <span className="sr-only">Loading…</span>
      <span aria-hidden className="rr-x-progress__bar" />
    </div>
  );
}

// ─── Row Link inline pending (Next canonical `useLinkStatus`) ─────
//
// Rendered as a CHILD of a `<Link>`, `useLinkStatus()` reports the pending state
// of that nearest enclosing Link while its navigation is in flight. The mobile
// record-detail row Links (mobile tap, desktop Open) are real `<Link>` navigations
// (a route change, so loading.tsx CAN fire — but a subtle inline shimmer on the
// tapped row is the canonical, immediate Next affordance). Decorative + token-
// based: a thin shimmer line using the design-system `fade-in` keyframe and the
// `--motion-state` easing, reduced-motion-safe (static, no flash) in CSS. The
// parent Link already carries the accessible label, so this overlay is
// `aria-hidden`.
function LinkPending() {
  const { pending } = useLinkStatus();
  if (!pending) {
    return null;
  }
  return <span aria-hidden className="rr-x-row__pending" />;
}

// ─── Load-more skeleton rows (insertion-point pending feedback) ───
//
// W3 / RL4: when a scrolled-down owner clicks Load-more, the top progress bar is
// off-screen above them (see RouteProgress scope note). The pending feedback must
// live AT the point of attention — the foot of the loaded feed, where the new
// page will append (Geist Skeleton: "async data fills a known layout"; BBC GEL
// Load-more: spinner + live region at the load point).
//
// CONTRACT (RL4, non-destructive):
//   - These rows are rendered as SIBLINGS appended BELOW the already-loaded rows
//     (just above the Load-more button). They NEVER replace, remove, hide, or dim
//     the loaded rows — those stay fully present and interactive while the next
//     page fetches (useTransition keeps the current UI live).
//   - Reserved height (a fixed N of row-shaped placeholders) so the appended page
//     does not push content with a layout jump (prior art finding 7).
//   - The shimmer is decorative → the whole block is `aria-hidden`; a sibling
//     polite live region carries the "Loading more records…" announcement.
//   - Reduced-motion: the shimmer keyframe is gated behind
//     `@media (prefers-reduced-motion: no-preference)` in components.css; the
//     base rule is a static, visible placeholder (no flash).
//   - It does NOT steal focus and contains no focusable elements, so keyboard /
//     screen-reader focus stays on the Load-more button the owner just pressed.
//
// `label` lets the Upcoming projection announce its own ("Loading more upcoming
// records…") while the main feed announces records — the placeholder shape is the
// same row anatomy in both.
// Stable keys for the fixed, never-reordered placeholder rows (no array-index key).
const LOAD_MORE_SKELETON_ROW_KEYS = ["skel-a", "skel-b", "skel-c"] as const;
function LoadMoreSkeleton({ label }: { label: string }) {
  return (
    <>
      <span aria-live="polite" className="sr-only" role="status">
        {label}
      </span>
      <div aria-hidden className="rr-x-loadmore-skeleton">
        {LOAD_MORE_SKELETON_ROW_KEYS.map((key) => (
          <div className="rr-x-skel-row" key={key}>
            <span className="rr-x-skel-bar rr-x-skel-bar--attr" />
            <span className="rr-x-skel-bar rr-x-skel-bar--title" />
            <span className="rr-x-skel-bar rr-x-skel-bar--snippet" />
          </div>
        ))}
      </div>
    </>
  );
}

function FeedStatusLine({
  activitySummary,
  exactTotal,
  fullStreamHref,
  fullStreamScopeNote,
  truncated,
  visibleCount,
  exactCountIsCurrent,
}: {
  activitySummary: RecordsExplorerData["activitySummary"];
  exactCountIsCurrent: boolean;
  exactTotal: number | null;
  fullStreamHref: string | null;
  fullStreamScopeNote: string | null;
  truncated: boolean;
  visibleCount: number;
}) {
  const exactTotalLabel = exactTotal === null ? null : exactTotal.toLocaleString();
  const countLine = exactCountIsCurrent
    ? `Showing ${visibleCount.toLocaleString()} of ${exactTotalLabel} records in this stream`
    : `${visibleCount.toLocaleString()} ${truncated ? "shown in this Explore preview" : "in view"}`;
  const linkLabel =
    exactCountIsCurrent && exactTotal !== null
      ? `open all ${exactTotal.toLocaleString()} records →`
      : "open complete stream →";

  return (
    <p className="rr-x-pulse__note">
      {countLine}
      {activitySummary && !exactCountIsCurrent ? ` · ${activitySummary.text}` : ""}
      {truncated && !fullStreamHref ? " · select one stream to open its complete list" : ""}
      {fullStreamHref ? (
        <>
          {" · "}
          <Link className="rr-link" href={fullStreamHref}>
            {linkLabel}
          </Link>
          {fullStreamScopeNote ? <span className="rr-x-scope-note"> {fullStreamScopeNote}</span> : null}
        </>
      ) : null}
    </p>
  );
}

function ActiveFilterChips({ chips, onClearAll }: { chips: readonly FilterChip[]; onClearAll: () => void }) {
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className="rr-x-active">
      {chips.map((c) => (
        <span className="rr-x-chip" key={c.id}>
          {/* Property zone */}
          <span className="rr-x-chip__property">{c.property}</span>
          {/* Operator zone — use a <button> when clickable (is/is-not toggle) so it
              is a true interactive element with accessible role, not a static span */}
          {c.canNegate ? (
            <button
              aria-label={`Toggle operator (currently ${c.operator})`}
              className={`rr-x-chip__op${c.negated ? "rr-x-chip__op--negated" : ""}`}
              onClick={c.negate}
              type="button"
            >
              {c.operator}
            </button>
          ) : (
            <span className={`rr-x-chip__op${c.negated ? "rr-x-chip__op--negated" : ""}`}>{c.operator}</span>
          )}
          {/* Value zone */}
          <span className="rr-x-chip__value">{c.value}</span>
          {/* Remove × */}
          <button aria-label={`Remove filter: ${c.label}`} className="rr-x-chip__x" onClick={c.clear} type="button">
            ×
          </button>
        </span>
      ))}
      {chips.length >= 2 && (
        <button className="rr-x-clearall" onClick={onClearAll} type="button">
          clear all
        </button>
      )}
    </div>
  );
}

function WarningList({ warnings }: { warnings: readonly ExplorerWarning[] }) {
  return (
    <>
      {dedupeWarnings(warnings).map((w) => (
        <div className="rr-x-warn" key={`${w.code}:${w.message}`}>
          <span className="rr-x-warn__msg">{w.message}</span>
          <span className="rr-x-warn__line" title={w.code}>
            {w.code.replace(UNDERSCORE_RE, " ")}
          </span>
        </div>
      ))}
    </>
  );
}

// ─── The Date chip — the ONE date control (display + editor) ──────────────────
//
// One quiet chip that is BOTH the active-window display AND the editor (the
// Linear/Grafana chip-as-editor model). Clicking it opens a hybrid popover:
//   - PRESETS apply instantly + close (Today · Last 7 days · Last 30 days · All time).
//   - CUSTOM is From/To date inputs + an explicit Apply (Primer's documented lesson:
//     the owner sets two endpoints, THEN commits — never auto-submit).
// Picking a preset reflects into From/To so the resolved range is always visible.
// There is no second representation anywhere else (the rangeLabel chip is removed).

const DATE_PRESETS: { key: ExploreRange; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "all", label: "All time" },
];

function DateChip({
  label,
  isActive,
  activeRange,
  customInputs,
  onPreset,
  onApplyCustom,
  onClear,
}: {
  label: string;
  isActive: boolean;
  activeRange: ExploreRange | "custom";
  customInputs: { from: string; to: string };
  onPreset: (preset: ExploreRange) => void;
  onApplyCustom: (range: { since: string; until: string }) => void;
  onClear: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  // Local draft of the Custom From/To inputs. Re-synced whenever the canonical
  // window changes (a preset / typed operator / reload reflects in here too).
  const [from, setFrom] = useState(customInputs.from);
  const [to, setTo] = useState(customInputs.to);
  useEffect(() => {
    setFrom(customInputs.from);
    setTo(customInputs.to);
  }, [customInputs.from, customInputs.to]);

  // Close on Escape (cancel — no apply) and on a click outside the popover. The
  // chip button itself reopens, so it is excluded from the outside-click target.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const applyCustom = () => {
    onApplyCustom(resolveCustomRange(from, to));
    setOpen(false);
  };
  // Apply is a no-op when Custom is empty (both endpoints blank); guard so the
  // default action never clears a window the owner did not mean to touch.
  const customEmpty = !(from || to);
  // A well-formed Custom requires From ≤ To when BOTH are present (To<From is also
  // swapped at the edge by resolveCustomRange, but disable to keep the action honest).
  const customInvalid = Boolean(from && to && to < from);

  return (
    <div className="rr-x-datechip" ref={popoverRef}>
      {/* Trigger + clear are SIBLING buttons (not a button-in-a-button): the chip
          phrase opens/closes the popover; the × is its own real <button> that clears
          back to "Any time". One visual chip, two honest controls. */}
      <div className={["rr-x-datechip__chip", isActive ? "is-active" : ""].filter(Boolean).join(" ")}>
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          className="rr-x-datechip__trigger"
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          <span className="rr-x-datechip__phrase">{label}</span>
        </button>
        {isActive ? (
          <button aria-label="Clear date filter" className="rr-x-datechip__x" onClick={onClear} type="button">
            ✕
          </button>
        ) : null}
      </div>

      {open ? (
        <div aria-label="Date filter" className="rr-x-datechip__popover" role="dialog">
          {/* Presets — a radio group of mutually-exclusive windows; picking one applies
              instantly + closes (design: "presets are a radio-group"). A native
              <input type=radio> would lose the button affordance + the is-on styling,
              so the ARIA radio role on the buttons is the right pattern here. */}
          <div aria-label="Date presets" className="rr-x-datechip__presets" role="radiogroup">
            {DATE_PRESETS.map((preset) => {
              const selected = activeRange === preset.key;
              return (
                // biome-ignore lint/a11y/useSemanticElements: a button-as-radio keeps the click/keyboard affordance + is-on styling a native radio cannot.
                <button
                  aria-checked={selected}
                  className={["rr-x-datechip__preset", selected ? "is-on" : ""].filter(Boolean).join(" ")}
                  key={preset.key}
                  onClick={() => {
                    onPreset(preset.key);
                    setOpen(false);
                  }}
                  role="radio"
                  type="button"
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          {/* Custom — From/To + an explicit Apply (no auto-submit). A <form> makes
              Apply the DEFAULT action: Enter in either date input commits the range
              (design: "Apply is the default action in Custom"); presets still apply
              instantly above. */}
          <form
            className="rr-x-datechip__custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (!(customEmpty || customInvalid)) {
                applyCustom();
              }
            }}
          >
            <span className="rr-x-datechip__custom-label">Custom range</span>
            <div className="rr-x-datechip__fields">
              <label className="rr-x-datechip__field">
                <span className="rr-x-datechip__field-label">From</span>
                <input
                  className="rr-x-datechip__date"
                  onChange={(e) => setFrom(e.target.value)}
                  type="date"
                  value={from}
                />
              </label>
              <label className="rr-x-datechip__field">
                <span className="rr-x-datechip__field-label">To</span>
                <input
                  className="rr-x-datechip__date"
                  // Guard To < From at the input where the browser supports it.
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                  type="date"
                  value={to}
                />
              </label>
            </div>
            <button className="rr-x-datechip__apply" disabled={customEmpty || customInvalid} type="submit">
              Apply
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

// ─── Feed controls (search row, sort/range chips, record-id jump, filters) ──

function FeedControls({
  draft,
  order,
  activeRange,
  dateLabel,
  dateIsActive,
  customInputs,
  connectionCounts,
  streamCounts,
  currentViewHref,
  recordIdJumpFeedback,
  recordsBasePath,
  scopedConnection,
  selectedStream,
  connections,
  streamSuggestions,
  selectedConnectionIds,
  selectedStreams,
  chips,
  onDraftChange,
  onCommitQuery,
  onSetOrder,
  onSetRange,
  onClearRange,
  onSearchRecordId,
  onToggleConnection,
  onToggleStream,
  onClearAll,
  showTimeSort,
}: {
  draft: string;
  order: SortOrder;
  activeRange: ExploreRange | "custom";
  dateLabel: string;
  dateIsActive: boolean;
  customInputs: { from: string; to: string };
  connectionCounts: ReadonlyMap<string, number>;
  streamCounts: ReadonlyMap<string, number>;
  currentViewHref: string;
  recordIdJumpFeedback: string | null;
  recordsBasePath: string;
  scopedConnection: ExplorerConnectionFacet | null;
  selectedStream: string | null;
  connections: readonly ExplorerConnectionFacet[];
  streamSuggestions: readonly string[];
  selectedConnectionIds: readonly string[];
  selectedStreams: readonly string[];
  chips: readonly FilterChip[];
  onDraftChange: (value: string) => void;
  onCommitQuery: () => void;
  onSetOrder: (next: SortOrder) => void;
  onSetRange: (range: ExploreRange | { since: string; until: string }) => void;
  onClearRange: () => void;
  onSearchRecordId: (recordId: string) => void;
  onToggleConnection: (id: string) => void;
  onToggleStream: (s: string) => void;
  onClearAll: () => void;
  /**
   * Whether the inline newest/oldest TIME sort is legal for the active set.
   * Descriptor-gated so an unhonorable sort claim is structurally unreachable.
   */
  showTimeSort: boolean;
}) {
  return (
    <div className="rr-x-controls">
      <div className="rr-x-searchrow">
        {/* ONE unified query input (text + chips + id-jump). The old separate
            "search values" + "go to id" boxes are merged here (feedback #4). */}
        <QueryInput
          connectionCounts={connectionCounts}
          connections={connections}
          draft={draft}
          onCommitQuery={onCommitQuery}
          onDraftChange={onDraftChange}
          onSearchRecordId={onSearchRecordId}
          onToggleConnection={onToggleConnection}
          onToggleStream={onToggleStream}
          recordIdJumpFeedback={recordIdJumpFeedback}
          recordsBasePath={recordsBasePath}
          scopedConnection={scopedConnection}
          selectedConnectionIds={selectedConnectionIds}
          selectedStream={selectedStream}
          selectedStreams={selectedStreams}
          streamCounts={streamCounts}
          streamSuggestions={streamSuggestions}
        />
        {/* The redundant "Search" button is removed: the command-bar commits on Enter
            (and selecting a typeahead value applies it). One input, no button — the
            SLVP recomposition (prototype/final: a single command-bar, not a toolbar). */}
        {/* D12 mobile: sort + Options share a compact sub-row (.rr-x-searchrow__controls)
            so they sit inline on mobile row 2, not stacked separately below the input.
            On desktop this sub-row is itself inline in the single searchrow flex. */}
        <div className="rr-x-searchrow__controls">
          {/* Sort stays inline (prototype keeps a small newest/oldest control beside the
              bar). Everything ELSE that was a flat toolbar row — the date ranges, the
              operators help, and copy-view-link — collapses into ONE quiet "Options"
              disclosure so the command-bar is a single calm row, not a 16-control toolbar
              (the SLVP recomposition; every capability stays reachable). */}
          {showTimeSort ? (
            <div className="rr-x-sort">
              <span className="rr-x-sort__label">sort</span>
              <button
                aria-pressed={order === "newest"}
                className={["rr-lens", order === "newest" ? "is-on" : ""].filter(Boolean).join(" ")}
                onClick={() => onSetOrder("newest")}
                type="button"
              >
                newest
              </button>
              <button
                aria-pressed={order === "oldest"}
                className={["rr-lens", order === "oldest" ? "is-on" : ""].filter(Boolean).join(" ")}
                onClick={() => onSetOrder("oldest")}
                type="button"
              >
                oldest
              </button>
            </div>
          ) : null}
          {/* The ONE Date control — replaces the four standalone today/7d/30d/all
              buttons AND the separate "Since…" chip. One chip, one popover, one honest
              statement of the active window (date-controls cell). */}
          <DateChip
            activeRange={activeRange}
            customInputs={customInputs}
            isActive={dateIsActive}
            label={dateLabel}
            onApplyCustom={onSetRange}
            onClear={onClearRange}
            onPreset={onSetRange}
          />
          <details className="rr-x-options">
            <summary className="rr-x-options__summary">Options</summary>
            <div className="rr-x-options__body">
              <div className="rr-x-options__group">
                <span className="rr-x-options__label">Operators</span>
                <div className="rr-x-help__body">
                  <code>con:</code> <code>-con:</code> <code>stream:</code> <code>-stream:</code> <code>role:</code>{" "}
                  <code>has:image</code> <code>has:link</code> <code>is:folded</code> <code>before:2026-06-11</code>{" "}
                  <code>after:2026-06-10</code> — combine freely; a leading <code>-</code> excludes (everything except).
                </div>
              </div>
              <CopyViewLinkButton href={currentViewHref} />
            </div>
          </details>
        </div>
      </div>

      <ActiveFilterChips chips={chips} onClearAll={onClearAll} />
    </div>
  );
}

// ─── Descriptor-driven search header ──────────────────────────────
//
// The header label and the available controls are CONSTRAINED by the
// set-descriptor. A relevance_bounded set cannot claim "newest first" or
// "complete"; only a descriptor that is time-ordered AND pages to the end may
// offer an in-set recency toggle, and only such a descriptor may advertise the
// exhaustive "Browse all matching records, newest first" door. For a bounded
// sample (relevance_bounded — the candidate-window recall case) we offer the
// honest chronological escape instead: it does not claim to surface ALL matches.

function SearchHeader({
  data,
  buildSearchSortHref,
  onSort,
  streamDoor,
  query,
  recordsBasePath,
}: {
  data: RecordsExplorerData;
  buildSearchSortHref: (searchSort: "relevance" | "recent") => string;
  onSort: (searchSort: "relevance" | "recent") => void;
  streamDoor: ExplorerStreamDoor | null;
  query: string;
  recordsBasePath: string;
}) {
  const descriptor = data.descriptor;
  // Exhaustive recall is provable only when the descriptor itself pages to the
  // end (keyword_pageable / complete_chronological). A relevance_bounded set is
  // a ranked SAMPLE — never label its escape "all matching records".
  const recallIsExhaustive = descriptor.kind === "keyword_pageable" || descriptor.kind === "complete_chronological";
  return (
    <div className="rr-x-search-header">
      <span className="rr-x-search-header__title">
        {/* feedHeaderLabel is the structural claim source — never exceed it. */}
        {feedHeaderLabel(descriptor)} for &lsquo;{query}&rsquo;
      </span>
      {/* Most relevant / Most recent sort toggle. "Most recent" is available only
          when the descriptor can be time-ordered or paged; for relevance_bounded
          (hybrid / bounded lexical window) there is no honest in-set recency
          path, so the toggle is replaced by a chronological escape. */}
      {descriptor.kind === "relevance_bounded" ? (
        <a className="rr-x-browse-all-escape" href={buildSearchSortHref("recent")}>
          Browse matching records, newest first
        </a>
      ) : (
        <div className="rr-x-search-sort">
          <button
            className={["rr-lens", data.searchSort === "recent" ? "" : "is-on"].filter(Boolean).join(" ")}
            onClick={() => onSort("relevance")}
            type="button"
          >
            Most relevant
          </button>
          <button
            className={["rr-lens", data.searchSort === "recent" ? "is-on" : ""].filter(Boolean).join(" ")}
            onClick={() => onSort("recent")}
            type="button"
          >
            Most recent
          </button>
        </div>
      )}
      {/* Supplemental exhaustive door: only when the descriptor genuinely pages to
          the end AND is not already time-ordered in-set. A bounded sample never
          reaches this branch, so it can never claim "all matching records". */}
      {recallIsExhaustive && !descriptorIsTimeOrdered(descriptor) ? (
        <a className="rr-x-browse-all-escape" href={buildSearchSortHref("recent")}>
          Browse all matching records, newest first
        </a>
      ) : null}
      {/* Per-source browse door: "See all in <stream>" for single-entity results. */}
      {streamDoor ? <StreamDoorLink door={streamDoor} query={query} recordsBasePath={recordsBasePath} /> : null}
    </div>
  );
}

// ─── Escape ramps (the no-dead-end contract) ──────────────────────
//
// StreamDoorLink: per-source "See all '<query>' records in <stream>" door for
// single-entity search results. StreamSeeAllLink: per-stream "<source> -
// <stream> - N records - See all" ramp for bounded/truncated recency groups.
// Both route through `buildStreamRecordsHref`, the same complete-stream helper
// the feed rows and inspector use — one escape ramp, never two.

function StreamDoorLink({
  door,
  query,
  recordsBasePath,
}: {
  door: ExplorerStreamDoor;
  query: string;
  recordsBasePath: string;
}) {
  const streamHref = buildStreamRecordsHref(recordsBasePath, {
    connectorId: door.connectorId,
    connectionId: door.connectionId,
    stream: door.stream,
  });
  return (
    <a className="rr-x-stream-door" href={streamHref}>
      See all '{query}' records in {door.displayName} →
    </a>
  );
}

function StreamSeeAllLink({ link, recordsBasePath }: { link: ExplorerStreamSeeAllLink; recordsBasePath: string }) {
  const streamHref = buildStreamRecordsHref(recordsBasePath, {
    connectorId: link.connectorId,
    connectionId: link.connectionId,
    stream: link.stream,
  });
  const totalLabel = typeof link.total === "number" ? ` - ${link.total.toLocaleString()} records` : "";
  return (
    <a className="rr-x-see-all" href={streamHref}>
      {link.displayName} - {link.stream}
      {totalLabel} - See all
    </a>
  );
}

// ─── Facet rail ───────────────────────────────────────────────────

// A facet row: an INCLUDE toggle (the row) + an "is not" EXCLUDE toggle (Linear).
// Both compile to the ONE query (include → `connection=`, exclude → `xconnection=`).
// The count is the loaded-window count (item #8): a bare number reads as a total, so
// it is qualified "in view"; when there are zero in view it is HIDDEN (never a "0"
// that reads as "this source is empty"), never a loaded-window count dressed as a total.
function FacetRow({
  label,
  mono,
  on,
  excluded,
  count,
  onToggle,
  onToggleExclude,
}: {
  label: string;
  mono?: boolean;
  on: boolean;
  excluded: boolean;
  count: number | null;
  onToggle: () => void;
  onToggleExclude: () => void;
}) {
  return (
    <div className={["rr-x-facet-row", excluded ? "is-excluded" : ""].filter(Boolean).join(" ")}>
      <button
        aria-pressed={on}
        className={["rr-x-facet", on ? "is-on" : ""].filter(Boolean).join(" ")}
        onClick={onToggle}
        type="button"
      >
        {/* F8: facet names ellipsis in the 230px rail (…gmail.c…); a native title
            makes the full connection/stream name recoverable on hover. */}
        <span
          className={["rr-x-facet__name", mono ? "rr-x-facet__name--mono" : ""].filter(Boolean).join(" ")}
          title={label}
        >
          {label}
        </span>
        <span className="rr-x-facet__flag" />
        {/* Exact-or-"in view"-or-hidden. count===null OR 0 → hidden (item #8). */}
        {count !== null && count > 0 ? (
          <span className="rr-x-facet__n">
            {count.toLocaleString()} <span className="rr-x-facet__inview">in view</span>
          </span>
        ) : null}
      </button>
      <button
        aria-label={excluded ? `Stop excluding ${label}` : `Exclude ${label} (is not)`}
        aria-pressed={excluded}
        className={["rr-x-facet-not", excluded ? "is-on" : ""].filter(Boolean).join(" ")}
        onClick={onToggleExclude}
        title={excluded ? "Excluding — click to stop" : "Exclude (is not)"}
        type="button"
      >
        ⊘
      </button>
    </div>
  );
}

function ConnectionFacets({
  connections,
  selected,
  excluded,
  countFor,
  onToggle,
  onToggleExclude,
}: {
  connections: readonly ExplorerConnectionFacet[];
  selected: readonly string[];
  excluded: readonly string[];
  countFor: (connectionId: string) => number;
  onToggle: (connectionId: string) => void;
  onToggleExclude: (connectionId: string) => void;
}) {
  return (
    <div className="rr-x-facets">
      <span className="rr-x-facets__label">Connections</span>
      {connections.map((c) => (
        <FacetRow
          count={countFor(c.connectionId)}
          excluded={excluded.includes(c.connectionId)}
          key={c.connectionId}
          label={c.displayName}
          on={selected.includes(c.connectionId)}
          onToggle={() => onToggle(c.connectionId)}
          onToggleExclude={() => onToggleExclude(c.connectionId)}
        />
      ))}
      {connections.length === 0 && <span className="rr-x-facets__note">No connections configured yet.</span>}
    </div>
  );
}

// Streams within one source are shown top-N-then-more so a busy source doesn't
// reintroduce the flat wall inside its own group; 8 leads with the source's most
// active streams and "Show all N" reveals the tail (Sentry top-10-then-more).
const STREAM_GROUP_TOP_N = 8;

// One source's collapsible group of stream facets. Default-collapsed (the rail is
// a builder, not a wall) UNLESS it holds an active filter or a search is matching
// inside it — then it opens so the relevant streams are visible without a click.
function SourceFacetGroup({
  group,
  forceOpen,
  onToggle,
  onToggleExclude,
}: {
  group: SourceStreamGroup;
  forceOpen: boolean;
  onToggle: (stream: string) => void;
  onToggleExclude: (stream: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const hasActive = group.streams.some((s) => s.selected || s.excluded);
  const visible = showAll ? group.streams : group.streams.slice(0, STREAM_GROUP_TOP_N);
  const hiddenCount = group.streams.length - visible.length;
  return (
    <details className="rr-x-source-group" open={forceOpen || hasActive}>
      <summary className="rr-x-source-group__summary">
        <span className="rr-x-source-group__name" title={group.displayName}>
          {group.displayName}
        </span>
        {/* The source total is the SAME count KIND as each stream — loaded rows
            for this source, labeled "in view" (RL2), never a lifetime total. */}
        <span className="rr-x-source-group__n">
          {group.loadedTotal.toLocaleString()} <span className="rr-x-facet__inview">in view</span>
        </span>
      </summary>
      <div className="rr-x-source-group__body">
        {visible.map((s) => (
          <FacetRow
            // Per-source loaded count: honest "in loaded results for this source".
            count={s.loadedCount}
            excluded={s.excluded}
            key={s.stream}
            label={s.stream}
            mono
            on={s.selected}
            onToggle={() => onToggle(s.stream)}
            onToggleExclude={() => onToggleExclude(s.stream)}
          />
        ))}
        {hiddenCount > 0 ? (
          <button className="rr-x-source-group__more" onClick={() => setShowAll(true)} type="button">
            Show all {group.streams.length.toLocaleString()} streams
          </button>
        ) : null}
      </div>
    </details>
  );
}

// W4: source-grouped stream facets. The flat ~70-name wall is replaced by
// collapsible parent→child groups (source → its streams). Every count is an
// honest per-source loaded count (computeSourceGroupedStreamFacets); a stream on
// two sources appears under EACH with that source's own number, never a global
// tally (RL2/RL3). A "search within filters" box tames many sources/streams.
function StreamFacets({
  groups,
  onToggle,
  onToggleExclude,
}: {
  groups: readonly SourceStreamGroup[];
  onToggle: (stream: string) => void;
  onToggleExclude: (stream: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => filterSourceGroups(groups, filter), [groups, filter]);
  const totalStreams = useMemo(() => totalVisibleStreamFacets(groups), [groups]);
  // Search box appears only once the list is big enough to need it (prior art:
  // search-within-filter for many values; below the threshold it is just noise).
  const showSearch = totalStreams > STREAM_GROUP_TOP_N || groups.length > 3;
  const searching = filter.trim() !== "";
  // Open a group by default only when there is a single source (nothing to fold)
  // or when a search is active (so the matching streams are visible immediately).
  const singleSource = filtered.length === 1;
  return (
    <div className="rr-x-facets">
      <span className="rr-x-facets__label">
        Sources &amp; streams
        {/* HONEST header count: how many stream facets are shown and that the
            number is loaded-window scoped — resolves "what do the numbers mean". */}
        {totalStreams > 0 ? (
          <span className="rr-x-facets__count">
            {totalStreams.toLocaleString()} {totalStreams === 1 ? "stream" : "streams"}{" "}
            <span className="rr-x-facet__inview">in loaded results</span>
          </span>
        ) : null}
      </span>
      {showSearch ? (
        <input
          aria-label="Search sources and streams"
          className="rr-x-facets__search"
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search sources & streams…"
          type="text"
          value={filter}
        />
      ) : null}
      <div className="rr-x-facets__scroll">
        {filtered.map((g) => (
          <SourceFacetGroup
            forceOpen={singleSource || searching}
            group={g}
            key={g.connectionId}
            onToggle={onToggle}
            onToggleExclude={onToggleExclude}
          />
        ))}
        {filtered.length === 0 ? (
          <span className="rr-x-facets__note">
            {searching ? "No sources or streams match your search." : "No streams in the loaded results."}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Feed row ─────────────────────────────────────────────────────

function FeedRow({
  entry,
  recordsBasePath,
  selected,
  onSelect,
  onOpenFull,
  onClearSelection,
  onArrow,
}: {
  entry: ExplorerFeedEntry;
  /** Base path for the records section (e.g. "/sources"). Used to
   *  build the full-page record detail href for the Open action + mobile tap. */
  recordsBasePath: string;
  selected: boolean;
  /** Desktop row click / Enter — opens the in-place peek panel (inspect). */
  onSelect: () => void;
  /**
   * The Open ESCALATION — navigate to the full record-detail route. DISTINCT from
   * `onSelect` (peek): the explicit Open button and Cmd/Ctrl-Enter route through
   * this, so Open is never functionally identical to a plain row click (#12).
   */
  onOpenFull: () => void;
  /** Escape from a focused/selected row — clears the peek + selection. */
  onClearSelection: () => void;
  /** Arrow-key feed nav handled on the interactive row button. */
  onArrow: (direction: -1 | 1) => void;
}) {
  // W1 content-first row primary (plan RL1): the primary line is real CONTENT a human
  // recognizes, projected from the SAME honest `buildRecordPreview` output the card and
  // inspector consume. `rowPrimary` applies the STRICT RL1 source order — declared
  // role-backed slots (title → body → amount → actor), else the first HONEST GENERIC
  // declared field, else a NEUTRAL fallback (the record id). The fallback is NEVER a
  // stream name, kind noun, or a derived summary. (The field-name-guessing timeline
  // summary is DELETED; a search hit's matched text rides below as a labelled excerpt,
  // never promoted to the primary. The old `nounFor(stream)` stream-name leak is gone.)
  // The honest primary line (declared title → first honest generic field → neutral
  // record-id fallback) and its derived/generic weight treatment are now owned by the
  // SHARED RecordIdentity cell (rendered below) — the feed no longer styles an
  // arbitrary key:value or an id/uuid as if it were an authored title; that invariant
  // lives in ONE place. `primaryLine` is still derived here for the row's aria-labels.
  const primaryLine = rowPrimary(entry.preview ?? null, entry.recordId);
  const role = entry.preview?.author ?? (entry.kind === "message" ? "message" : undefined);
  // Secondary snippet: the NEXT honest content slot (never repeating the primary).
  const snippet = rowSecondary(entry.preview ?? null);
  // A SEARCH HIT has no record body, so it has no preview-backed snippet and its primary
  // is the neutral record id. Surface the server's matched-text excerpt as a clearly-
  // LABELLED "Match" line so the result is scannable by what matched — NEVER promoted to a
  // faked title (F1 search scannability; the snippet is real matched record text, but it is
  // a labelled excerpt, not a declared title). Shown only when there is no body-backed snippet.
  const matchExcerpt = entry.retrievalMode && !snippet ? entry.snippet : undefined;
  const detailHref = buildRecordDetailHref(recordsBasePath, entry);
  const rowCls = ["rr-x-row", selected ? "is-selected" : ""].filter(Boolean).join(" ");
  const desktopActionLabel = selected
    ? `Selected ${entry.stream} record ${primaryLine}`
    : `Inspect ${entry.stream} record ${primaryLine}`;
  // Inner content is shared by both affordances; only the action verb changes
  // because desktop opens the inspector while mobile opens the full record.
  const inner = (actionLabel: "inspect" | "open" | "selected") => (
    <>
      {/* Leading type-glyph in a FIXED slot (W1, prior art: Primer leadingVisual) so
          rows are scannable by category and every primary line left-aligns to one x.
          The glyph map is the SHARED one promoted into record-identity.tsx. */}
      <span aria-hidden="true" className="rr-x-row__glyph" data-kind={entry.kind ?? "generic"}>
        {kindGlyph(entry.kind ?? null)}
      </span>
      <span className="rr-x-row__body">
        {/* Line 1 = CONTENT identity, rendered through the ONE shared RecordIdentity
            cell so the feed, the stream table, the mobile card, and the detail H1
            cannot render the same record's identity two ways (THE-LENS Gate 3).
            The feed owns its own glyph slot (above), so the cell suppresses its glyph
            and key (showGlyph/showKey=false). The cell OWNS the [primary][secondary]
            pair (record-components design §row-anatomy); the meta block below adds only
            the role badge + search "Match" excerpt + source/stream/time — it must NOT
            re-render rowSecondary() (that double-rendered the secondary line). */}
        <RecordIdentity
          hasImage={entryHasImage(entry)}
          preview={entry.preview ?? null}
          recordKey={entry.recordId}
          showGlyph={false}
          showKey={false}
          variant="feed"
        />
        {/* Line 2 = secondary context: the role badge (when present) + the search
            "Match" excerpt + the source/stream/time metadata, MUTED alongside content.
            The honest SECONDARY snippet itself is NOT re-rendered here — the shared
            RecordIdentity cell above already owns `[primary][secondary]` (record-
            components design §row-anatomy: [glyph][primary][secondary][key]). Rendering
            rowSecondary() a second time in this meta block was the cause of the
            duplicated secondary line (e.g. an Amazon cancelled order showing
            "This order has been cancelled" twice); the cell is the single owner. */}
        <span className="rr-x-row__meta">
          {role && (
            <span className="rr-x-row__snippet">
              {/* The author/role badge is canvas-specific context the identity cell
                  does not surface; it rides in the meta block, not the title line. */}
              <span className="rr-x-role">{role}</span>
            </span>
          )}
          {/* SEARCH HIT match excerpt (F1): a clearly-labelled "Match" line carrying the
              server's matched text, so a bodyless retrieval row is scannable by what
              matched. The "Match" mark keeps it honestly an excerpt, never a faked title. */}
          {matchExcerpt && (
            <span className="rr-x-row__snippet">
              <span className="rr-x-mark">Match</span>
              <span className="rr-x-row__snippet-text">
                {/* Render the matched terms BOLD from the parsed snippet segments (the
                    server's honest <mark> highlight, rendered as real <strong> elements —
                    never dangerouslySetInnerHTML). Falls back to the plain excerpt. */}
                {entry.snippetSegments && entry.snippetSegments.length > 0
                  ? entry.snippetSegments.map((seg, i) =>
                      seg.marked ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: ordered immutable segment list
                        <strong className="rr-x-snippet-hit" key={i}>
                          {seg.text}
                        </strong>
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: ordered immutable segment list
                        <span key={i}>{seg.text}</span>
                      )
                    )
                  : matchExcerpt}
              </span>
            </span>
          )}
          <span className="rr-x-row__attr">
            <span className="rr-x-row__stream">{entry.stream}</span>
            {/* F8: the connection name ellipses in the narrow row (…gmail.c…). A native
                `title` makes the full name recoverable on hover/long-press. */}
            <span className="rr-x-row__con" title={entry.connectionDisplayName ?? entry.connectorId}>
              {entry.connectionDisplayName ?? entry.connectorId}
            </span>
            {/* The per-row engine-mode badge (lexical/semantic/hybrid) was removed: it
                carried zero owner-actionable meaning and read as dev-console output. The
                row's own "Match" excerpt already conveys why a search hit appeared.
                `entry.retrievalMode` stays in the data model (gates matchExcerpt above). */}
          </span>
        </span>
      </span>
      {/* Time right-aligned, abbreviated, recede-able (W1). The day header carries the
          DATE, so the row carries the TIME (Slack/iMessage/Outlook pattern). */}
      <Timestamp className="rr-x-row__time" precision="time" value={entry.displayAt} />
      <span className="rr-x-row__action">{actionLabel}</span>
    </>
  );
  return (
    <>
      {/*
       * Mobile (≤860px): tapping a feed row pushes to the full-page record
       * detail route (R4). On phones there is no peek pane, so tap == open — a
       * row tap and "Open" converge to the same full route (design.md §6). No
       * in-flow inspector stacks below the feed on touch widths; hidden on
       * desktop via CSS. No per-row stream-drill link (feedback #11): the
       * scope-preserving drill-in lives at the group/burst level, not on rows.
       */}
      <Link
        aria-current={selected ? "page" : undefined}
        aria-label={`Open ${entry.stream} record ${primaryLine}`}
        className={`${rowCls} rr-x-row--mobile`}
        data-feed-row
        href={detailHref}
      >
        {inner("open")}
        <LinkPending />
      </Link>
      {/*
       * Desktop (>860px): the row body is the PEEK target — clicking it (or
       * Enter on the focused row) opens the in-place inspector. Distinct from
       * Open below, which routes to the full record-detail page (#12). Keyboard:
       * ↑/↓ move the selection, Enter peeks, Cmd/Ctrl-Enter opens the full route,
       * Escape clears. Hidden on mobile via CSS.
       */}
      <div className="rr-x-row-wrap rr-x-row-wrap--desktop">
        <button
          aria-label={desktopActionLabel}
          // The row is a toggle button (press = open peek), so aria-pressed is the
          // correct ARIA selected-state for a button role; aria-selected is NOT
          // valid on a button. data-selected carries the machine-readable selected
          // flag the contract requires (design.md §6 allows aria-selected OR
          // data-selected — data-selected is the honest one for this element).
          aria-pressed={selected}
          className={`${rowCls} rr-x-row--desktop`}
          data-feed-row
          data-selected={selected ? "true" : undefined}
          onClick={onSelect}
          onKeyDown={(e) => {
            // The keyboard contract is a PURE decision (resolveRowKeyAction):
            // ↑/↓ move selection, Enter peeks, Cmd/Ctrl-Enter opens the full
            // route, Escape clears (design.md §6, feedback #12). Unit-tested.
            const { action, preventDefault } = resolveRowKeyAction(e);
            if (preventDefault) {
              e.preventDefault();
            }
            if (action === "move-down") {
              onArrow(1);
            } else if (action === "move-up") {
              onArrow(-1);
            } else if (action === "peek") {
              onSelect();
            } else if (action === "open-full") {
              onOpenFull();
            } else if (action === "clear") {
              onClearSelection();
            }
          }}
          type="button"
        >
          {inner(selected ? "selected" : "inspect")}
        </button>
        {/*
         * Open ESCALATION (desktop): a separate explicit action that navigates to
         * the full record-detail route — NEVER the same outcome as the plain row
         * click (which peeks). This is the contract that makes Open meaningful
         * (design.md §6, feedback #12). It is a real <Link> route change.
         */}
        <Link
          aria-label={`Open ${entry.stream} record ${primaryLine} in full`}
          className="rr-x-row-open"
          href={detailHref}
        >
          Open →
          <LinkPending />
        </Link>
      </div>
    </>
  );
}

// ─── Day feed with burst collapse ─────────────────────────────────

function BurstRow({
  burst,
  expanded,
  onToggle,
  onMoveSelection,
  onSelectRecord,
  onOpenRecord,
  onClearSelection,
  recordsBasePath,
  selectedPeekParam,
}: {
  burst: BurstGroup;
  expanded: boolean;
  onToggle: () => void;
  onMoveSelection: (fromParam: string, direction: -1 | 1) => void;
  onSelectRecord: (entry: ExplorerFeedEntry) => void;
  onOpenRecord: (entry: ExplorerFeedEntry) => void;
  onClearSelection: () => void;
  recordsBasePath: string;
  selectedPeekParam: string | null;
}) {
  const rep = burst.entries[0];
  const loaded = burst.entries.length;
  const streamLabel = `${rep?.connectionDisplayName ?? rep?.connectorId ?? ""}${rep?.stream ? ` / ${rep.stream}` : ""}`;
  // SLVP preview-content-by-default (Codex plan-check 2026-06-22): a burst is NEVER
  // a content-less count header. It always renders its first PREVIEW_COUNT rows
  // (`burst.preview`); the remainder is reached via an explicit "Show all M" action.
  // count==reachability holds: the count is the LOADED count for this
  // (connection, stream) within the day, the action reaches EXACTLY those rows, and
  // the label says "in view" (never a claimed day-total the client can't prove).
  const visibleEntries = expanded ? burst.entries : burst.preview;
  const hiddenCount = loaded - burst.preview.length;
  const hasMore = hiddenCount > 0;
  return (
    <div className="rr-x-burst">
      <div className="rr-x-burst__head">
        <span className="rr-x-burst__count">{loaded.toLocaleString()}</span>{" "}
        <span className="rr-x-burst__stream">{streamLabel}</span> <span className="rr-x-burst__inview">in view</span>
      </div>
      {/* Rows ALWAYS mount (preview or full) — the feed never shows zero content.
          The single reveal container (rr-x-burst__rows) plays the design-system
          reveal motion once on expand; preview rows render statically. */}
      <div className="rr-x-burst__rows">
        {visibleEntries.map((entry) => {
          const param = explorerPeekParam(entry);
          return (
            <FeedRow
              entry={entry}
              key={param}
              onArrow={(direction) => onMoveSelection(param, direction)}
              onClearSelection={onClearSelection}
              onOpenFull={() => onOpenRecord(entry)}
              onSelect={() => onSelectRecord(entry)}
              recordsBasePath={recordsBasePath}
              selected={param === selectedPeekParam}
            />
          );
        })}
      </div>
      {hasMore ? (
        <button
          aria-label={
            expanded
              ? `Collapse ${streamLabel} to the first ${burst.preview.length}`
              : `Show all ${loaded.toLocaleString()} ${streamLabel} records in view`
          }
          className="rr-x-burst__toggle"
          onClick={onToggle}
          type="button"
        >
          <span className="rr-x-burst__action">
            {expanded ? `Collapse to first ${burst.preview.length} ↑` : `Show all ${loaded.toLocaleString()} ↓`}
          </span>
        </button>
      ) : null}
    </div>
  );
}

// ─── Zero-results routing ─────────────────────────────────────────
//
// Replaces the dead-end empty state with a routing component that gives an
// honest explanation + 2-4 escape actions. Honesty constraint (non-negotiable):
// count==reachability — the heading and description must not contradict each
// other. We never claim "N records matched" while showing 0 unless the explanation
// makes clear why the 0 occurred (client-side filter narrowed the server's N).

interface ZeroResultsEscapeAction {
  count: string;
  description: string;
  href: string;
  key: string;
  title: string;
}

interface ZeroResultsExploreState {
  connectionIds: readonly string[];
  excludeConnectionIds: readonly string[];
  excludeStreams: readonly string[];
  query: string;
  since: string;
  streams: readonly string[];
  until: string;
}

/** Build the "remove last chip" escape action. Returns null when not applicable. */
function buildRemoveLastChipAction(
  lastChip: FilterChip,
  chipCount: string,
  explorePath: string,
  s: ZeroResultsExploreState
): ZeroResultsEscapeAction | null {
  let href = "";
  let title = "";
  if (lastChip.property === "source" && !lastChip.negated) {
    // The chip's id is `con:<connectionId>` — strip the prefix to get the REAL
    // connection id and remove it by EXACT equality. (The previous substring match on
    // `lastChip.value`, the DISPLAY NAME, was an honesty bug: a name that is not a
    // substring of its id — e.g. "Chase - Personal" vs `cin_chase` — would leave the
    // filter applied while the action claims to remove it. Codex end-review HOLD.)
    const removedId = lastChip.id.startsWith("con:") ? lastChip.id.slice("con:".length) : null;
    href = buildHref(explorePath, {
      connectionIds: removedId ? s.connectionIds.filter((id) => id !== removedId) : s.connectionIds,
      excludeConnectionIds: s.excludeConnectionIds,
      excludeStreams: s.excludeStreams,
      query: s.query,
      since: s.since,
      streams: s.streams,
      until: s.until,
    });
    title = `Remove source filter: ${lastChip.value}`;
  } else if (lastChip.property === "stream" && !lastChip.negated) {
    href = buildHref(explorePath, {
      connectionIds: s.connectionIds,
      excludeConnectionIds: s.excludeConnectionIds,
      excludeStreams: s.excludeStreams,
      query: s.query,
      since: s.since,
      streams: s.streams.filter((v) => v !== lastChip.value),
      until: s.until,
    });
    title = `Remove stream filter: ${lastChip.value}`;
  } else if (lastChip.property === "date") {
    href = buildHref(explorePath, {
      connectionIds: s.connectionIds,
      excludeConnectionIds: s.excludeConnectionIds,
      excludeStreams: s.excludeStreams,
      query: s.query,
      streams: s.streams,
    });
    title = "Remove date filter — search all time";
  } else if (lastChip.property === "filter") {
    const tokenKey = lastChip.id.replace("tok:", "");
    href = buildHref(explorePath, {
      connectionIds: s.connectionIds,
      excludeConnectionIds: s.excludeConnectionIds,
      excludeStreams: s.excludeStreams,
      query: s.query
        .split(QUERY_WHITESPACE_RE)
        .filter((t) => t !== tokenKey)
        .join(" ")
        .trim(),
      since: s.since,
      streams: s.streams,
      until: s.until,
    });
    title = `Remove filter: ${lastChip.value}`;
  }
  if (!(href && title)) {
    return null;
  }
  return {
    count: chipCount,
    description: "Show results without this filter",
    href,
    key: `remove-last:${lastChip.id}`,
    title,
  };
}

/**
 * Build zero-results escape actions. Pure (no hooks) so cognitive complexity stays bounded.
 * Returns up to 4 deduplicated actions ordered by specificity.
 */
function buildZeroEscapeActions(
  chips: readonly FilterChip[],
  loadedCount: number,
  explorePath: string,
  s: ZeroResultsExploreState,
  hasFilters: boolean
): ZeroResultsEscapeAction[] {
  const actions: ZeroResultsEscapeAction[] = [];
  const lastChip = chips.at(-1) ?? null;
  if (lastChip) {
    const chipCount = loadedCount > 0 ? `${loadedCount.toLocaleString()} records` : "all records";
    const act = buildRemoveLastChipAction(lastChip, chipCount, explorePath, s);
    if (act) {
      actions.push(act);
    }
  }
  if (s.since || s.until) {
    actions.push({
      count: "all time",
      description: "Remove the date window — search the full history",
      href: buildHref(explorePath, {
        connectionIds: s.connectionIds,
        excludeConnectionIds: s.excludeConnectionIds,
        excludeStreams: s.excludeStreams,
        query: s.query,
        streams: s.streams,
      }),
      key: "all-time",
      title: "Search all time",
    });
  }
  if (s.streams.length > 0) {
    actions.push({
      count: "all streams",
      description: "Remove stream filter — search across all data types",
      href: buildHref(explorePath, {
        connectionIds: s.connectionIds,
        excludeConnectionIds: s.excludeConnectionIds,
        excludeStreams: s.excludeStreams,
        query: s.query,
        since: s.since,
        streams: [],
        until: s.until,
      }),
      key: "all-streams",
      title: "Search all streams",
    });
  }
  if (hasFilters) {
    actions.push({
      count: "all records",
      description: "Return to the full unfiltered feed",
      href: buildHref(explorePath, {}),
      key: "clear-all",
      title: "Clear all filters",
    });
  }
  const seen = new Set<string>();
  return actions.filter((a) => {
    if (seen.has(a.href)) {
      return false;
    }
    seen.add(a.href);
    return true;
  });
}

function ZeroResultsRouting({
  chips,
  loadedCount,
  explorePath,
  exploreState,
  onClearAll,
}: {
  chips: readonly FilterChip[];
  /** Number of records loaded by the server before client-side narrowing. */
  loadedCount: number;
  explorePath: string;
  exploreState: ZeroResultsExploreState;
  onClearAll: () => void;
}) {
  const hasFilters =
    chips.length > 0 ||
    exploreState.query.trim().length > 0 ||
    Boolean(exploreState.since) ||
    Boolean(exploreState.until);

  const escapeActions = useMemo<ZeroResultsEscapeAction[]>(
    () => buildZeroEscapeActions(chips, loadedCount, explorePath, exploreState, hasFilters),
    [chips, loadedCount, explorePath, exploreState, hasFilters]
  );

  // Honest heading: loadedCount > 0 means server returned records but client filters removed them all.
  const headingText = loadedCount > 0 ? "No records matched the active filters" : "No records in this view";
  let descriptionText: string;
  if (loadedCount > 0) {
    const plural = loadedCount === 1 ? "" : "s";
    descriptionText = `${loadedCount.toLocaleString()} record${plural} loaded — none passed the current filters`;
  } else if (hasFilters) {
    descriptionText = "The active filters returned nothing. Try a different combination.";
  } else {
    descriptionText = "There are no records to show here yet.";
  }

  return (
    <div aria-live="polite" className="rr-x-zero" role="status">
      <div aria-hidden="true" className="rr-x-zero__icon">
        ⊘
      </div>
      <div className="rr-x-zero__heading">{headingText}</div>
      <p className="rr-x-zero__desc">{descriptionText}</p>
      {escapeActions.length > 0 && (
        <>
          <div className="rr-x-zero__label">Try instead</div>
          <ul className="rr-x-zero__list">
            {escapeActions.map((action) => (
              <li key={action.key}>
                <Link className="rr-x-zero__action" href={action.href}>
                  <span className="rr-x-zero__action-text">
                    <span className="rr-x-zero__action-title">{action.title}</span>
                    <span className="rr-x-zero__action-desc">{action.description}</span>
                  </span>
                  <span className="rr-x-zero__action-count">{action.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {hasFilters && chips.length > 0 && (
        <button className="rr-link rr-x-zero__clearall" onClick={onClearAll} type="button">
          clear all filters →
        </button>
      )}
    </div>
  );
}

function FeedDays({
  dayGroups,
  lens,
  chipsPresent,
  chips,
  expandedBursts,
  onClearAll,
  onToggleBurst,
  onMoveSelection,
  onSelectRecord,
  onOpenRecord,
  onClearSelection,
  recordsBasePath,
  selectedPeekParam,
  zeroResultsProps,
}: {
  chipsPresent: boolean;
  chips: readonly FilterChip[];
  dayGroups: readonly DayGroupWithBursts[];
  expandedBursts: ReadonlySet<string>;
  lens: ExplorerLens;
  onClearAll: () => void;
  onToggleBurst: (key: string) => void;
  onMoveSelection: (fromParam: string, direction: -1 | 1) => void;
  onSelectRecord: (entry: ExplorerFeedEntry) => void;
  onOpenRecord: (entry: ExplorerFeedEntry) => void;
  onClearSelection: () => void;
  recordsBasePath: string;
  selectedPeekParam: string | null;
  zeroResultsProps?: {
    loadedCount: number;
    explorePath: string;
    exploreState: {
      query: string;
      connectionIds: readonly string[];
      excludeConnectionIds: readonly string[];
      streams: readonly string[];
      excludeStreams: readonly string[];
      since: string;
      until: string;
    };
  };
}) {
  if (dayGroups.length === 0) {
    if (zeroResultsProps) {
      return (
        <ZeroResultsRouting
          chips={chips}
          explorePath={zeroResultsProps.explorePath}
          exploreState={zeroResultsProps.exploreState}
          loadedCount={zeroResultsProps.loadedCount}
          onClearAll={onClearAll}
        />
      );
    }
    return (
      <div className="rr-x-empty">
        <p className="rr-x-empty__line">
          {feedSectionTitle(lens)} — nothing in view. Try different terms or a wider window.
        </p>
        {chipsPresent && (
          <button className="rr-link" onClick={onClearAll} type="button">
            clear filters →
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      {dayGroups.map((g) => {
        const dayCount = g.singles.length + g.bursts.reduce((sum, b) => sum + b.entries.length, 0);
        return (
          <div className="rr-x-day" key={g.day || "undated"}>
            <div className="rr-x-day__head">
              <span className="rr-x-day__label">{g.label}</span>
              {/* count==reachability (Codex red line): the day header counts records
                  LOADED for this day, not a true day total (which needs a server
                  per-day count). A bare number reads like a total, so it is qualified
                  "in view" — every counted record is reachable in this group. */}
              <span className="rr-x-day__n">
                {dayCount.toLocaleString()} <span className="rr-x-day__inview">in view</span>
              </span>
            </div>
            {/* Render the day's units in DISPLAY order (newest-first across bursts
                AND singles). `g.units` is the single source of truth produced by the
                grouping layer; rendering separate bursts-then-singles arrays here is
                what produced the live across-burst misorder (23m→19m→31m), so the
                JSX never re-derives the order — it switches on the unit kind. */}
            {g.units.map((unit: DayRenderUnit) => {
              if (unit.kind === "burst") {
                const { burst } = unit;
                return (
                  <BurstRow
                    burst={burst}
                    expanded={expandedBursts.has(burst.key)}
                    key={burst.key}
                    onClearSelection={onClearSelection}
                    onMoveSelection={onMoveSelection}
                    onOpenRecord={onOpenRecord}
                    onSelectRecord={onSelectRecord}
                    onToggle={() => onToggleBurst(burst.key)}
                    recordsBasePath={recordsBasePath}
                    selectedPeekParam={selectedPeekParam}
                  />
                );
              }
              const { entry } = unit;
              const param = explorerPeekParam(entry);
              return (
                <FeedRow
                  entry={entry}
                  key={param}
                  onArrow={(direction) => onMoveSelection(param, direction)}
                  onClearSelection={onClearSelection}
                  onOpenFull={() => onOpenRecord(entry)}
                  onSelect={() => onSelectRecord(entry)}
                  recordsBasePath={recordsBasePath}
                  selected={param === selectedPeekParam}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
}

// ─── Upcoming (future-dated) section ──────────────────────────────
//
// Scheduled/future-dated records (e.g. YNAB future budget months) must NOT sit
// above today's activity in a newest-first feed. They collapse into a labeled
// "Upcoming" section at the TOP, collapsed by default with a count; expanding
// reveals a FORWARD-chronological (soonest-first) day-bucketed sub-list. Prior
// art: docs/research/explore-future-dated-records-prior-art-2026-06-21.md
// (YNAB "Pending", Stripe/Gmail "Scheduled", Things/Todoist "Upcoming").

function UpcomingSection({
  upcoming,
  upcomingCount,
  loadedCount,
  hasMore,
  isPending,
  pendingKind,
  onLoadMore,
  expandedBursts,
  onToggleBurst,
  onMoveSelection,
  onSelectRecord,
  onOpenRecord,
  onClearSelection,
  recordsBasePath,
  selectedPeekParam,
  lens,
}: {
  upcoming: readonly DayGroupWithBursts[];
  upcomingCount: number;
  /** How many of the N upcoming records are loaded into `upcoming` so far. */
  loadedCount: number;
  /** True when more future records are reachable via load-more. */
  hasMore: boolean;
  isPending: boolean;
  pendingKind: PendingKind;
  /** Walk the future projection one page further (count==reachability). */
  onLoadMore: () => void;
  expandedBursts: ReadonlySet<string>;
  onToggleBurst: (key: string) => void;
  onMoveSelection: (fromParam: string, direction: -1 | 1) => void;
  onSelectRecord: (entry: ExplorerFeedEntry) => void;
  onOpenRecord: (entry: ExplorerFeedEntry) => void;
  onClearSelection: () => void;
  recordsBasePath: string;
  selectedPeekParam: string | null;
  lens: ExplorerLens;
}) {
  const [expanded, setExpanded] = useState(false);
  // F5: even once the Upcoming disclosure is open, its loaded records (188 YNAB
  // budget months → a 772-row wall) must NOT all dump at once. Apply the same
  // preview-by-default treatment as bursts: render the first
  // UPCOMING_PREVIEW_DAYS day-groups (each future budget month is its own day),
  // then an explicit "Show N more loaded" toggle. The server load-more pager
  // ("Showing X of N") still walks to exhaustion underneath — this only bounds how
  // many of the ALREADY-LOADED groups paint, so the section is grouped + previewed,
  // never a wall. count==reachability holds: every loaded record is reachable via
  // this client toggle, and every remaining record via the server load-more.
  const [showAllDays, setShowAllDays] = useState(false);
  const label = `${upcomingCount.toLocaleString()} upcoming`;
  // count==reachability: the pill shows the TRUE total N. When more than the loaded
  // window remains, the expanded body offers a load-more that walks to exhaustion —
  // so every one of the N records is reachable, never a capped head.
  const loadMorePending = isPending && pendingKind === "loadmore";
  const visibleDays = showAllDays ? upcoming : upcoming.slice(0, UPCOMING_PREVIEW_DAYS);
  const hiddenDayCount = upcoming.length - visibleDays.length;
  return (
    <section aria-label={`${label} (scheduled / future-dated)`} className="rr-x-upcoming">
      <button
        aria-expanded={expanded}
        className="rr-x-upcoming__toggle"
        onClick={() => setExpanded((v) => !v)}
        type="button"
      >
        <span aria-hidden className="rr-x-upcoming__chevron">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="rr-x-upcoming__count">{label}</span>
        <span className="rr-x-upcoming__hint">scheduled / future-dated</span>
      </button>
      {expanded ? (
        <div className="rr-x-upcoming__body">
          <FeedDays
            chips={[]}
            chipsPresent={false}
            dayGroups={visibleDays}
            expandedBursts={expandedBursts}
            lens={lens}
            onClearAll={() => {
              // no-op: the Upcoming section never owns the empty/clear-filters state
            }}
            onClearSelection={onClearSelection}
            onMoveSelection={onMoveSelection}
            onOpenRecord={onOpenRecord}
            onSelectRecord={onSelectRecord}
            onToggleBurst={onToggleBurst}
            recordsBasePath={recordsBasePath}
            selectedPeekParam={selectedPeekParam}
          />
          {/* F5: reveal the rest of the ALREADY-LOADED upcoming day-groups in place
              (mirrors the burst "Show all" toggle). Distinct from the server
              load-more below, which fetches MORE future records. */}
          {hiddenDayCount > 0 ? (
            <button className="rr-x-burst__toggle" onClick={() => setShowAllDays((v) => !v)} type="button">
              <span className="rr-x-burst__action">
                {showAllDays
                  ? `Collapse to first ${UPCOMING_PREVIEW_DAYS} days ↑`
                  : `Show ${hiddenDayCount.toLocaleString()} more loaded days ↓`}
              </span>
            </button>
          ) : null}
          {hasMore ? (
            <div className="rr-x-upcoming__more">
              <p className="rr-x-upcoming__more-note">
                Showing {loadedCount.toLocaleString()} of {upcomingCount.toLocaleString()} upcoming records
              </p>
              {/* W3 insertion-point skeleton for the Upcoming projection: same
                  non-destructive, reduced-motion-gated placeholder block, at the
                  button under the thumb on mobile (RL4). */}
              {loadMorePending ? <LoadMoreSkeleton label="Loading more upcoming records…" /> : null}
              <button
                aria-busy={loadMorePending}
                className="rr-x-loadmore"
                disabled={loadMorePending}
                onClick={onLoadMore}
                type="button"
              >
                {loadMorePending ? "Loading…" : "Load more upcoming ↓"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ─── Feed body (day groups + escape ramps + descriptor Load-more) ──

function FeedBody({
  data,
  visibleFeed,
  chips,
  chipsPresent,
  expandedBursts,
  explorePath,
  recordsBasePath,
  selectedPeekParam,
  isPending,
  pendingKind,
  onClearAll,
  onToggleBurst,
  onMoveSelection,
  onSelectRecord,
  onOpenRecord,
  onClearSelection,
  onLoadMore,
  onLoadMoreUpcoming,
}: {
  data: RecordsExplorerData;
  /** The CLIENT-FILTERED feed (server slice narrowed by Explore-only operators). */
  visibleFeed: readonly ExplorerFeedEntry[];
  chips: readonly FilterChip[];
  chipsPresent: boolean;
  expandedBursts: ReadonlySet<string>;
  explorePath: string;
  recordsBasePath: string;
  selectedPeekParam: string | null;
  /** True while ANY in-page navigation transition is in flight. */
  isPending: boolean;
  /** Which action started the in-flight transition (Load-more vs other). */
  pendingKind: PendingKind;
  onClearAll: () => void;
  onToggleBurst: (key: string) => void;
  onMoveSelection: (fromParam: string, direction: -1 | 1) => void;
  onSelectRecord: (entry: ExplorerFeedEntry) => void;
  /** Open ESCALATION — navigate a row to its full record-detail route (#12). */
  onOpenRecord: (entry: ExplorerFeedEntry) => void;
  /** Escape from a focused/selected row — clear the peek + selection. */
  onClearSelection: () => void;
  onLoadMore: (cursor: string | null) => void;
  /** Walk the Upcoming (future) projection one page further (count==reachability). */
  onLoadMoreUpcoming: (cursor: string | null) => void;
}) {
  // The SERVER owns the past/future split: it excludes future-dated records from
  // the main feed (visibleFeed) and returns them as a separate Upcoming projection
  // (data.upcoming) with a true total (data.upcomingTotal). The client renders what
  // the server declares — it does NOT re-derive the boundary client-side (a
  // recompute-per-page boundary would skip records crossing it mid-traversal; see
  // docs/research/explore-now-boundary-pinning-prior-art-2026-06-21.md). The future
  // groups are already forward-chronological (soonest first) from the server.
  const past = useMemo(() => groupFeedWithBursts([...visibleFeed]), [visibleFeed]);
  // Upcoming is ALREADY a collapsed disclosure — render its loaded records as a flat
  // day-bucketed list, NOT a second burst-collapse layer (the double-"expand" clunk).
  const upcoming = useMemo(() => groupFeedDaysNoBursts([...data.upcoming]), [data.upcoming]);
  const upcomingCount = data.upcomingTotal;
  const loadMoreCursor =
    descriptorHasMore(data.descriptor) && descriptorNextCursor(data.descriptor)
      ? descriptorNextCursor(data.descriptor)
      : null;
  return (
    <div className="rr-x-days">
      {upcomingCount > 0 ? (
        <UpcomingSection
          expandedBursts={expandedBursts}
          hasMore={data.upcomingHasMore && data.upcomingNextCursor !== null}
          isPending={isPending}
          lens={data.lens}
          loadedCount={data.upcoming.length}
          onClearSelection={onClearSelection}
          onLoadMore={() => onLoadMoreUpcoming(data.upcomingNextCursor)}
          onMoveSelection={onMoveSelection}
          onOpenRecord={onOpenRecord}
          onSelectRecord={onSelectRecord}
          onToggleBurst={onToggleBurst}
          pendingKind={pendingKind}
          recordsBasePath={recordsBasePath}
          selectedPeekParam={selectedPeekParam}
          upcoming={upcoming}
          upcomingCount={upcomingCount}
        />
      ) : null}
      <FeedDays
        chips={chips}
        chipsPresent={chipsPresent}
        dayGroups={past}
        expandedBursts={expandedBursts}
        lens={data.lens}
        onClearAll={onClearAll}
        onClearSelection={onClearSelection}
        onMoveSelection={onMoveSelection}
        onOpenRecord={onOpenRecord}
        onSelectRecord={onSelectRecord}
        onToggleBurst={onToggleBurst}
        recordsBasePath={recordsBasePath}
        selectedPeekParam={selectedPeekParam}
        zeroResultsProps={{
          loadedCount: data.feed.length,
          explorePath,
          exploreState: {
            query: data.query,
            connectionIds: data.selectedConnectionIds,
            excludeConnectionIds: data.excludeConnectionIds,
            streams: data.selectedStreams,
            excludeStreams: data.excludeStreams,
            since: data.since,
            until: data.until,
          },
        }}
      />

      {/* ── Per-stream escape ramps: "See all N records" for bounded groups ── */}
      {!data.fromSearch && data.streamSeeAllLinks.length > 0 ? (
        <div className="rr-x-see-all-links">
          {data.streamSeeAllLinks.map((link) => (
            <StreamSeeAllLink
              key={`${link.connectionId}:${link.stream}`}
              link={link}
              recordsBasePath={recordsBasePath}
            />
          ))}
        </div>
      ) : null}

      {/* ── Insertion-point skeleton (W3) ──
          Reserved-height row-shaped placeholders appended at the FOOT of the
          loaded feed (above the Load-more button) while a Load-more push is in
          flight. RL4: additive siblings — they never replace/hide the loaded
          rows above, never dim the feed, never take focus. Renders ONLY for a
          Load-more push (isLoadMorePending), so an unrelated filter/sort
          navigation does not paint phantom rows. */}
      {loadMoreCursor && isLoadMorePending(isPending, pendingKind) ? (
        <LoadMoreSkeleton label="Loading more records…" />
      ) : null}

      {/* ── Descriptor-constrained Load-more ──
          Renders ONLY when the descriptor says has_more AND carries a cursor.
          relevance_bounded: descriptorHasMore is always false (structural) — no
          Load-more is possible. The descriptor is the sole authority. */}
      {loadMoreCursor ? (
        <button
          aria-busy={isLoadMorePending(isPending, pendingKind) ? "true" : undefined}
          className="rr-x-loadmore"
          disabled={loadMoreDisabled(isPending)}
          onClick={() => onLoadMore(loadMoreCursor)}
          type="button"
        >
          {/* Spinner reuses the design-system `spin` keyframe (base.css); decorative,
              so hidden from assistive tech — the button's busy label carries the
              accessible signal. Shown only for a Load-more push specifically. */}
          {isLoadMorePending(isPending, pendingKind) ? <span aria-hidden className="rr-x-loadmore__spinner" /> : null}
          {loadMoreLabel(loadMoreRestingLabel(data.descriptor.kind), isPending, pendingKind)}
        </button>
      ) : null}
    </div>
  );
}

// ─── Saved-view tabs (R5) ─────────────────────────────────────────
//
// A horizontal tab row below the command-bar: [All] [<user-saved views>] [+ Save].
// HONESTY (08-saved-views-design.md): the saved tabs are USER-AUTHORED named queries
// — the user builds a filter, names it, and that named view becomes a tab. NO guessed
// "Money"/"Messages" presets ship (deciding which streams are money/messages by NAME is
// the meaning-guessing the redesign forbids). "All" is the only built-in tab. Storage is
// localStorage-only (no server). The COUNT shows ONLY on the active tab (visibleFeed.length,
// the same reachable count the VIEWS sidebar uses); inactive tabs show NO count — we never
// fabricate a number for a view we have not loaded. A tab click navigates to its href via
// the same soft transition as every other Explore navigation, so loading states still work.

// The trailing "+ Save view" affordance: a quiet button that swaps to an inline
// name input. Extracted from SavedViewTabs so the save-name STATE and its commit
// branch live in one small unit (keeps the tab list's complexity in check and the
// save/cancel keyboard handling testable in isolation). Renders nothing when the
// current view isn't saveable (All, or already-saved) — the parent passes onSave.
function SaveViewAction({ onSave }: { onSave: (name: string) => void }) {
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");

  const commit = useCallback(() => {
    const name = draftName.trim();
    if (name.length > 0) {
      onSave(name);
    }
    setDraftName("");
    setNaming(false);
  }, [draftName, onSave]);

  if (!naming) {
    return (
      <button className="rr-x-views-tab rr-x-views-tab--save" onClick={() => setNaming(true)} type="button">
        + Save view
      </button>
    );
  }
  return (
    <span className="rr-x-views-tab-wrap">
      <input
        aria-label="Name this view"
        autoFocus
        className="rr-x-views-tab__input"
        onBlur={commit}
        onChange={(e) => setDraftName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraftName("");
            setNaming(false);
          }
        }}
        placeholder="View name…"
        value={draftName}
      />
    </span>
  );
}

// One saved-view tab (or the built-in "All" tab). Count rides ONLY when this tab is
// the active view — never a fabricated number for an unloaded view. The delete × is
// rendered only for real saved views (not "All"), revealed on hover/focus via CSS.
function SavedViewTab({
  active,
  count,
  href,
  name,
  onDelete,
  onNavigate,
}: {
  active: boolean;
  count: number;
  href: string;
  name: string;
  onDelete?: () => void;
  onNavigate: (href: string) => void;
}) {
  const tab = (
    <button
      aria-selected={active}
      className={["rr-x-views-tab", active ? "is-active" : ""].filter(Boolean).join(" ")}
      onClick={() => onNavigate(href)}
      role="tab"
      type="button"
    >
      <span className="rr-x-views-tab__name">{name}</span>
      {active ? <span className="rr-x-views-tab__count">{count.toLocaleString()}</span> : null}
    </button>
  );
  if (!onDelete) {
    return tab;
  }
  return (
    <span className="rr-x-views-tab-wrap">
      {tab}
      <button aria-label={`Delete saved view ${name}`} className="rr-x-views-tab__del" onClick={onDelete} type="button">
        ×
      </button>
    </span>
  );
}

function SavedViewTabs({
  activeCount,
  allHref,
  currentHref,
  onNavigate,
}: {
  /** Reachable count for the ACTIVE view only (visibleFeed.length). */
  activeCount: number;
  /** The no-filter "All" href (buildHref(explorePath, {})). */
  allHref: string;
  /** The shareable href of the CURRENT view (buildCurrentViewHref) — drives active-tab match. */
  currentHref: string;
  /** Navigate to a view href through the canvas's transition-wrapped router.push. */
  onNavigate: (href: string) => void;
}) {
  // localStorage is read in an effect (never during render) so SSR and the first
  // client paint agree (no hydration mismatch). `mounted` gates the save affordance
  // until we have read storage, so we never flash a wrong tab set.
  const [views, setViews] = useState<SavedView[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setViews(parseSavedViews(window.localStorage.getItem(SAVED_VIEWS_STORAGE_KEY)));
    setMounted(true);
  }, []);

  const persist = useCallback((next: SavedView[]) => {
    setViews(next);
    window.localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(next));
  }, []);

  const onSave = useCallback(
    (name: string) => {
      // A stable id; crypto.randomUUID is available in every browser the console targets.
      persist(addSavedView(views, { id: crypto.randomUUID(), name, href: currentHref }));
    },
    [persist, views, currentHref]
  );

  const active = activeSavedView(views, currentHref);

  return (
    <div aria-label="Saved views" className="rr-x-views-tabs" role="tablist">
      <SavedViewTab
        active={isAllView(currentHref)}
        count={activeCount}
        href={allHref}
        name="All"
        onNavigate={onNavigate}
      />
      {views.map((v) => (
        <SavedViewTab
          active={active?.id === v.id}
          count={activeCount}
          href={v.href}
          key={v.id}
          name={v.name}
          onDelete={() => persist(removeSavedView(views, v.id))}
          onNavigate={onNavigate}
        />
      ))}
      {/* "+ Save view" — offered ONLY when the current filter is a non-All view not
          already saved (canSaveCurrentView). Gated on mounted so it never flashes. */}
      {mounted && canSaveCurrentView(views, currentHref) ? <SaveViewAction onSave={onSave} /> : null}
    </div>
  );
}

// ─── ExploreCanvas ────────────────────────────────────────────────

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ExploreCanvas orchestrates the full workbench state; this cell only swaps the shared record identity renderer.
export function ExploreCanvas({ data, explorePath, order = "newest", peekRelationships = null }: ExploreCanvasProps) {
  const router = useRouter();

  // ── In-page navigation loading state ──
  // Every server-backed Explore interaction is a soft same-route `router.push`,
  // which does NOT trigger `loading.tsx`. Wrapping the push in `useTransition`
  // gives us `isPending` (true while the server re-renders) to drive the top
  // progress bar, the feed busy/dim, and the Load-more spinner. `pendingKind`
  // records WHICH action started the transition so only the Load-more push spins
  // the Load-more button; everything else only shows the progress bar + dim.
  const [isPending, startTransition] = useTransition();
  const [pendingKind, setPendingKind] = useState<PendingKind>(null);

  // ── Deferred over-time chart band (the ~7s-Explore fix) ──
  // The bucket aggregate (`/_ref/explore/records/buckets`) counts the full corpus
  // by month — a 3.6s scan that BLOCKED first paint when the server component
  // awaited it. The assembler now returns `data.bucketRequest` (the computed scope,
  // or null when suppressed: search / relevance_bounded / no targets) WITHOUT
  // awaiting the call, and we load the band here post-mount (Linear/Vercel "list
  // instant, chart fills in"). A SEPARATE transition keeps this off the navigation
  // `isPending` path so fetching the chart never dims/blocks the feed.
  // The latest request lives in a ref so the effect can read it without taking the
  // (per-render fresh) object as a dependency — the effect keys on the SERIALIZED
  // scope below, so it re-fetches only when the structural scope/window changes.
  const bucketRequestRef = useRef(data.bucketRequest);
  bucketRequestRef.current = data.bucketRequest;
  // Stable identity for the request scope: a new SSR render hands a fresh object
  // each time, so we key on the serialized scope, not object identity. Null when
  // suppressed (search / relevance_bounded / no targets) — drives the effect.
  const bucketRequestKey = data.bucketRequest ? JSON.stringify(data.bucketRequest) : null;
  // The loaded band is STAMPED with the scope-key it was loaded for, so the render
  // can prove a series belongs to the CURRENT scope (never paint a prior scope's
  // bars across a same-route nav, even for the one paint before the effect runs).
  // `series: null` with a matching key = an honest "loaded, no chart" (a read
  // fault, or a genuinely empty distribution) — NOT a pending state, so the
  // skeleton never spins forever. SSR seed: `data.bucketSeries` is always null
  // now (the assembler defers the load), so the band always starts pending.
  const [loadedBand, setLoadedBand] = useState<{ key: string; series: BucketSeries | null } | null>(null);
  const [, startChartTransition] = useTransition();
  useEffect(() => {
    // A soft same-route push preserves this component's state across the SSR
    // re-render. The render gates on `loadedBand.key === bucketRequestKey`, so a
    // scope change shows the skeleton immediately (the stale band no longer
    // matches) without a flash — but we still clear here so a mid-flight load for
    // the OLD scope can't land and stamp itself stale.
    if (bucketRequestKey === null) {
      // Suppressed (search / relevance_bounded / no targets): no chart, no request.
      setLoadedBand(null);
      return;
    }
    const request = bucketRequestRef.current;
    if (!request) {
      setLoadedBand(null);
      return;
    }
    let cancelled = false;
    startChartTransition(() => {
      loadExploreBuckets(request)
        // A read fault degrades to a "loaded, no chart" band (series null, current
        // key) — the skeleton resolves to nothing rather than spinning forever.
        .catch(() => null)
        .then((series) => {
          if (!cancelled) {
            setLoadedBand({ key: bucketRequestKey, series });
          }
        });
    });
    return () => {
      cancelled = true;
    };
  }, [bucketRequestKey]);
  // The band to render: only when it was loaded for the CURRENT scope-key. A stale
  // band (prior scope) or a not-yet-loaded scope ⇒ no chart this paint.
  const bucketSeries = loadedBand && loadedBand.key === bucketRequestKey ? loadedBand.series : null;
  // Pending = a request is live (non-null key) and no band for THIS key has landed.
  const bucketBandPending = bucketRequestKey !== null && !(loadedBand && loadedBand.key === bucketRequestKey);

  // Records section base path for mobile push-navigation row Links.
  // e.g. "/explore" → "/sources".
  const recordsBasePath = `${explorePath.replace(EXPLORE_SUFFIX_RE, "")}/records`;

  // The facet rail is a <details> that renders CLOSED (feed-first on phones).
  // On wide viewports we open it so the disclosure state matches the always-
  // shown desktop rail, and we keep it in sync across resizes. Desktop CSS
  // force-shows the body regardless, so first paint never hides desktop facets.
  const railRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) {
      return;
    }
    const mql = window.matchMedia("(min-width: 861px)");
    const sync = () => {
      rail.open = mql.matches;
    };
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  // The search input holds local text; server tokens commit on Enter, while
  // client-only operators filter live as you type.
  const [draft, setDraft] = useState(data.query);
  const [lastRecordIdSearch, setLastRecordIdSearch] = useState<string | null>(null);
  useEffect(() => setDraft(data.query), [data.query]);

  const [optimisticSelection, setOptimisticSelectionState] = useState({
    connectionIds: data.selectedConnectionIds,
    streams: data.selectedStreams,
    excludeConnectionIds: data.excludeConnectionIds,
    excludeStreams: data.excludeStreams,
  });
  const optimisticSelectionRef = useRef(optimisticSelection);
  useEffect(() => {
    const next = {
      connectionIds: data.selectedConnectionIds,
      streams: data.selectedStreams,
      excludeConnectionIds: data.excludeConnectionIds,
      excludeStreams: data.excludeStreams,
    };
    optimisticSelectionRef.current = next;
    setOptimisticSelectionState(next);
  }, [data.selectedConnectionIds, data.selectedStreams, data.excludeConnectionIds, data.excludeStreams]);
  const setOptimisticSelection = useCallback(
    (next: {
      connectionIds: string[];
      streams: string[];
      excludeConnectionIds: string[];
      excludeStreams: string[];
    }) => {
      optimisticSelectionRef.current = next;
      setOptimisticSelectionState(next);
    },
    []
  );
  const selectedConnectionIds = optimisticSelection.connectionIds;
  const selectedStreams = optimisticSelection.streams;
  const excludeConnectionIds = optimisticSelection.excludeConnectionIds;
  const excludeStreams = optimisticSelection.excludeStreams;

  const parsed = useMemo(() => parseQuery(draft), [draft]);
  const committedParsed = useMemo(() => parseQuery(data.query), [data.query]);

  // ── Canonical-date normalization on the URL/SSR/reload path ──
  // The in-app commit path lifts `before:`/`after:` into the canonical (since, until)
  // window before navigating. But a URL-direct `?q=after:2026-01-01`, a shared link, or
  // a reload arrives with the operator still living in `data.query` — and the SSR
  // assembler derives since/until ONLY from `params.since`/`params.until`, so the typed
  // window would NOT apply and the date would lie ("Any time" Date chip beside the raw
  // query). Normalize on mount: lift the date operators OUT of `data.query` and INTO the
  // canonical window, then `router.replace` to the normalized URL (replace, not push, so
  // no un-normalized entry traps the back button). After the replace `data.query` carries
  // no date operator, so this effect no-ops — no loop. (The chip strip already excludes
  // date operators via `chipTokens`, so the single render before this settles is honest.)
  useEffect(() => {
    const href = dateNormalizedHref(explorePath, {
      query: data.query,
      selectedConnectionIds: data.selectedConnectionIds,
      excludeConnectionIds: data.excludeConnectionIds,
      selectedStreams: data.selectedStreams,
      excludeStreams: data.excludeStreams,
      since: data.since,
      until: data.until,
      searchSort: data.searchSort === "recent" ? "recent" : "relevance",
      peek: data.peek ? explorerPeekParam(data.peek) : undefined,
      order,
    });
    if (href !== null) {
      // Replace (not push) so the un-normalized URL never traps the back button.
      router.replace(href);
    }
  }, [
    data.query,
    data.selectedConnectionIds,
    data.excludeConnectionIds,
    data.selectedStreams,
    data.excludeStreams,
    data.since,
    data.until,
    data.searchSort,
    data.peek,
    explorePath,
    order,
    router,
  ]);

  // Server exact-filterable field names (declared `field_capabilities`). A
  // `field:value` over one of these was applied by the server, so it is excluded
  // from the client-side post-filter and rendered as a real param in the
  // compiled line.
  const serverFilterableFields = useMemo(
    () => new Set(data.serverFilterableFields.map((f) => f.toLowerCase())),
    [data.serverFilterableFields]
  );

  // Server-backed slice of the feed is already scoped by the SSR fetch
  // (selected connections, streams, since/until, free-text q, and declared
  // exact-match filters). Only server-inexpressible operators narrow further.
  // `data.feed` is already in the requested server order. "Oldest" must be a
  // server ascending keyset page, not a client reversal of the loaded window.
  const visibleFeed = useMemo(
    () => data.feed.filter((e) => passesClientFilter(e, parsed, serverFilterableFields)),
    [data.feed, parsed, serverFilterableFields]
  );

  const showTimeSort = canShowTimeSort(data);

  // Facet counts: reactive over the CURRENTLY VISIBLE feed, ignoring the
  // facet's own axis. Honest within the loaded window — labeled "in view".
  const countForConnection = useCallback(
    (connectionId: string) => {
      const streamSel = new Set(selectedStreams);
      return data.feed.filter((e) => {
        if (!passesClientFilter(e, parsed, serverFilterableFields)) {
          return false;
        }
        if (streamSel.size > 0 && !streamSel.has(e.stream)) {
          return false;
        }
        return e.connectionId === connectionId;
      }).length;
    },
    [data.feed, selectedStreams, parsed, serverFilterableFields]
  );

  // Stream facet: instance-true when exactly one connection is selected. Still
  // used by the record-id jump (open directly when scoped to one connection).
  const scopedConnection = useMemo(() => {
    if (selectedConnectionIds.length !== 1) {
      return null;
    }
    return data.connections.find((c) => c.connectionId === selectedConnectionIds[0]) ?? null;
  }, [data.connections, selectedConnectionIds]);

  // Source-grouped stream facets with honest per-source loaded counts (W4). The
  // client predicate is passed in so the pure helper stays React-free; every
  // count is "loaded rows for THIS source", never a global stream tally.
  const streamGroups = useMemo(
    () =>
      computeSourceGroupedStreamFacets({
        feed: data.feed,
        connections: data.connections,
        passes: (e) => passesClientFilter(e, parsed, serverFilterableFields),
        selectedConnectionIds,
        selectedStreams,
        excludeStreams,
      }),
    [
      data.feed,
      data.connections,
      parsed,
      serverFilterableFields,
      selectedConnectionIds,
      selectedStreams,
      excludeStreams,
    ]
  );

  // Stream typeahead suggestions: the distinct stream names present in the loaded
  // window (deduped across sources), so typing `stream:` still autocompletes.
  const streamSuggestions = useMemo(() => {
    const seen = new Set<string>();
    for (const g of streamGroups) {
      for (const s of g.streams) {
        seen.add(s.stream);
      }
    }
    return [...seen];
  }, [streamGroups]);

  // Per-connection and per-stream record counts derived from the loaded window —
  // threaded into typeahead suggestions as honest count badges. Only present when
  // the server provided the data (derived from streamGroups); never fabricated.
  const connectionCounts = useMemo<ReadonlyMap<string, number>>(() => {
    const m = new Map<string, number>();
    for (const g of streamGroups) {
      m.set(g.connectionId, g.loadedTotal);
    }
    return m;
  }, [streamGroups]);

  const streamCountsMap = useMemo<ReadonlyMap<string, number>>(() => {
    const m = new Map<string, number>();
    for (const g of streamGroups) {
      for (const s of g.streams) {
        // Accumulate across sources — a stream named "transactions" shared
        // across two connections contributes both counts to the total.
        m.set(s.stream, (m.get(s.stream) ?? 0) + s.loadedCount);
      }
    }
    return m;
  }, [streamGroups]);

  // ── Navigation (server-backed state lives in the URL) ──
  // The current URL state passed to the pure href builder. Selection comes from
  // the optimistic ref so rapid facet toggles compose before the SSR round-trip.
  const navigate = useCallback(
    // `kind` records which action this navigation is (Load-more vs everything
    // else) so the Load-more spinner shows only for a Load-more push. The
    // optimistic selection ref is read synchronously BEFORE startTransition so
    // rapid facet toggles still compose exactly as before (unchanged behavior).
    (opts: NavigateOpts, kind: PendingKind = "navigation") => {
      const href = buildNavigateHref(
        explorePath,
        {
          query: data.query,
          connectionIds: optimisticSelectionRef.current.connectionIds,
          streams: optimisticSelectionRef.current.streams,
          excludeConnectionIds: optimisticSelectionRef.current.excludeConnectionIds,
          excludeStreams: optimisticSelectionRef.current.excludeStreams,
          since: data.since,
          until: data.until,
          searchSort: data.searchSort === "recent" ? "recent" : "relevance",
          snapshotAnchor: data.snapshotAnchor,
          cursorTrail: data.cursorTrail,
          upcomingTrail: data.upcomingTrail,
          order,
        },
        opts
      );
      setPendingKind(kind);
      // A soft same-route push does not fire loading.tsx; the transition gives us
      // `isPending` for the in-page loading affordances while the server re-renders.
      startTransition(() => router.push(href));
    },
    [
      router,
      explorePath,
      data.query,
      data.since,
      data.until,
      data.searchSort,
      data.snapshotAnchor,
      data.cursorTrail,
      data.upcomingTrail,
      order,
    ]
  );

  const toggleConnection = useCallback(
    (connectionId: string) => {
      const cur = optimisticSelectionRef.current;
      const next = {
        connectionIds: toggleIdSelection(cur.connectionIds, connectionId),
        streams: [],
        // Including a connection clears any exclusion of the same id (a connection
        // can't be both "only this" and "not this") and clears stream exclusions
        // since the stream facet rescopes when the connection set changes.
        excludeConnectionIds: cur.excludeConnectionIds.filter((id) => id !== connectionId),
        excludeStreams: [],
      };
      setOptimisticSelection(next);
      navigate({
        connectionIds: next.connectionIds,
        streams: next.streams,
        excludeConnectionIds: next.excludeConnectionIds,
        excludeStreams: next.excludeStreams,
      });
    },
    [navigate, setOptimisticSelection]
  );

  const toggleExcludeConnection = useCallback(
    (connectionId: string) => {
      const cur = optimisticSelectionRef.current;
      const next = {
        // Excluding a connection clears its inclusion (mutually exclusive per id).
        connectionIds: cur.connectionIds.filter((id) => id !== connectionId),
        streams: cur.streams,
        excludeConnectionIds: toggleIdSelection(cur.excludeConnectionIds, connectionId),
        excludeStreams: cur.excludeStreams,
      };
      setOptimisticSelection(next);
      navigate({
        connectionIds: next.connectionIds,
        excludeConnectionIds: next.excludeConnectionIds,
      });
    },
    [navigate, setOptimisticSelection]
  );

  const toggleStream = useCallback(
    (stream: string) => {
      const cur = optimisticSelectionRef.current;
      const next = {
        connectionIds: cur.connectionIds,
        streams: toggleIdSelection(cur.streams, stream),
        excludeConnectionIds: cur.excludeConnectionIds,
        excludeStreams: cur.excludeStreams.filter((s) => s !== stream),
      };
      setOptimisticSelection(next);
      navigate({ streams: next.streams, excludeStreams: next.excludeStreams });
    },
    [navigate, setOptimisticSelection]
  );

  const toggleExcludeStream = useCallback(
    (stream: string) => {
      const cur = optimisticSelectionRef.current;
      const next = {
        connectionIds: cur.connectionIds,
        streams: cur.streams.filter((s) => s !== stream),
        excludeConnectionIds: cur.excludeConnectionIds,
        excludeStreams: toggleIdSelection(cur.excludeStreams, stream),
      };
      setOptimisticSelection(next);
      navigate({ streams: next.streams, excludeStreams: next.excludeStreams });
    },
    [navigate, setOptimisticSelection]
  );

  const commitQuery = useCallback(() => {
    // Lift typed date operators (after:/before:) OUT of the free text and INTO the ONE
    // canonical date window FIRST, so a typed `after:2026-01-01` IMMEDIATELY becomes the
    // single Date chip — never a separate token chip beside it (the canonical-date-object
    // guarantee). Last-write-wins: a typed endpoint REPLACES the current since/until.
    const dateLift = liftDateTokens(draft);
    // Resolve the typed date endpoints into the canonical (since, until) nav delta
    // (one tested module-scope helper; only typed endpoints override, last-write-wins).
    const dateNav = dateNavFromLift(dateLift.after, dateLift.before);
    // Then lift con:/-con:/stream:/-stream: operators OUT of the (date-stripped) free text
    // and INTO the facet include/exclude state, so the TYPED operator produces the SAME
    // canonical query as the chip (the recent-lens feed scopes by facet params, not by a
    // literal `q` string). Other operators / free text stay in the query.
    const lift = liftFacetTokens(dateLift.rest);
    if (liftHasNoFacets(lift)) {
      setDraft(lift.rest);
      navigate({ query: lift.rest, ...dateNav });
      return;
    }
    const next = composeFacetSelection(optimisticSelectionRef.current, lift, data.connections);
    setOptimisticSelection(next);
    setDraft(lift.rest);
    navigate({
      query: lift.rest,
      connectionIds: next.connectionIds,
      streams: next.streams,
      excludeConnectionIds: next.excludeConnectionIds,
      excludeStreams: next.excludeStreams,
      ...dateNav,
    });
  }, [draft, navigate, data.connections, setOptimisticSelection]);

  // The ONE date-window writer (shared by the Date popover's Custom Apply AND the
  // over-time chart's brush — no new param, no parallel range state). A PRESET
  // ("today"/"7d"/"30d"/"all") is a sliding/open window: `since` from the relative
  // range, `until` cleared. A CUSTOM `{since, until}` is a fixed/anchored window:
  // it writes both endpoints VERBATIM (resolved at the edge by `resolveCustomRange`
  // into honest local-day ISO boundaries) — it must NOT hard-clear `until`, or the
  // custom range could never be set (the old bug).
  const setRange = useCallback(
    (range: ExploreRange | { since: string; until: string }) => navigate(rangeNav(range)),
    [navigate]
  );

  // The Date chip's × — clear the window back to "Any time" (drop since + until).
  const clearRange = useCallback(() => navigate({ since: "", until: "" }), [navigate]);

  const setOrder = useCallback((next: SortOrder) => navigate({ order: next }), [navigate]);

  const setSearchSort = useCallback(
    (next: "relevance" | "recent") => navigate({ searchSort: next, cursor: undefined }),
    [navigate]
  );

  const selectRecord = useCallback(
    (entry: ExplorerFeedEntry) => navigate({ peek: explorerPeekParam(entry) }),
    [navigate]
  );

  // Open ESCALATION (desktop): the explicit Open action / Cmd-Ctrl-Enter routes
  // to the FULL record-detail page — a real route change (loading.tsx can fire),
  // DISTINCT from selectRecord's in-place peek (design.md §6, feedback #12). Wrap
  // the push in the transition so the top progress bar reports it like every other
  // in-page navigation.
  const openRecord = useCallback(
    (entry: ExplorerFeedEntry) => {
      setPendingKind("navigation");
      startTransition(() => router.push(buildRecordDetailHref(recordsBasePath, entry)));
    },
    [router, recordsBasePath]
  );

  // Escape from a focused/selected row: drop the peek param (clears selection +
  // closes the inspector) without disturbing the rest of the query state.
  const clearSelection = useCallback(() => navigate({ peek: undefined }), [navigate]);

  const clearAll = useCallback(() => {
    setDraft("");
    setPendingKind("navigation");
    startTransition(() => router.push(explorePath));
  }, [router, explorePath]);

  const searchRecordId = useCallback(
    (recordId: string) => {
      setLastRecordIdSearch(recordId);
      setDraft(recordId);
      navigate({ query: recordId, peek: undefined });
    },
    [navigate]
  );

  // ── Keyboard row navigation (↑/↓ from a focused row move the selection) ──
  const moveSelection = useCallback(
    (fromParam: string, direction: -1 | 1) => {
      const fromIndex = visibleFeed.findIndex((entry) => explorerPeekParam(entry) === fromParam);
      const nextIndex = Math.max(0, Math.min(visibleFeed.length - 1, fromIndex + direction));
      const next = visibleFeed[nextIndex];
      if (next) {
        selectRecord(next);
      }
    },
    [visibleFeed, selectRecord]
  );

  // ── Active filter chips ──
  // The active DATE window is rendered by the dedicated Date chip (see `dateLabel`
  // below), NOT as a chip here — one canonical representation, no double render. The
  // token list is passed through `chipTokens`, which DROPS any `before:`/`after:`
  // operator, so a URL-direct `?q=after:X` / shared link / reload can NEVER surface a
  // date as a separate token chip beside the Date chip — even in the single render
  // before the mount-time normalizer redirects to the canonical (since, until) URL.
  const chips = useMemo(
    () =>
      buildFilterChips({
        selectedConnectionIds,
        selectedStreams,
        excludeConnectionIds,
        excludeStreams,
        connections: data.connections,
        tokens: chipTokens(committedParsed.tokens),
        query: data.query,
        toggleConnection,
        toggleStream,
        toggleExcludeConnection,
        toggleExcludeStream,
        navigate,
      }),
    [
      selectedConnectionIds,
      selectedStreams,
      excludeConnectionIds,
      excludeStreams,
      data.connections,
      data.query,
      committedParsed.tokens,
      toggleConnection,
      toggleStream,
      toggleExcludeConnection,
      toggleExcludeStream,
      navigate,
    ]
  );

  // The ONE honest Date-chip phrase, derived purely from the canonical (since, until).
  const dateLabel = useMemo(() => dateChipLabel(data.since, data.until), [data.since, data.until]);
  // Reflect the canonical window back into the Custom From/To inputs (resolved range
  // always visible; survives reload) — Primer's "never hide the resolved range" lesson.
  const customInputs = useMemo(() => customRangeInputs(data.since, data.until), [data.since, data.until]);
  // A window is active iff the chip is not the resting "Any time" — one source of truth
  // for both the phrase and the active treatment / × affordance.
  const dateIsActive = dateLabel !== ANY_TIME_LABEL;

  // ── Server-applied exact filters (for the scoped full-stream link) ──
  const serverExactFilters = useMemo(
    () => committedParsed.fields.filter((field) => serverFilterableFields.has(field.key.toLowerCase())),
    [committedParsed.fields, serverFilterableFields]
  );

  // Per-burst expand state. Starts collapsed; each burst toggles independently.
  const [expandedBursts, setExpandedBursts] = useState<ReadonlySet<string>>(new Set());
  const toggleBurst = useCallback(
    (key: string) =>
      setExpandedBursts((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      }),
    []
  );

  const selectedPeekParam = data.peek ? explorerPeekParam(data.peek) : null;
  const clientSide =
    hasClientSideTokens(committedParsed, serverFilterableFields) || hasClientSideTokens(parsed, serverFilterableFields);
  const unsupportedFullStreamState = hasUnsupportedFullStreamState(
    clientSide,
    committedParsed.text,
    data.since,
    data.until
  );

  // Active facet-filter count powers the collapsed mobile "Filters (N)" label.
  // Includes BOTH include and exclude selections (both are active scope).
  const activeFacetCount =
    selectedConnectionIds.length + selectedStreams.length + excludeConnectionIds.length + excludeStreams.length;
  const activeRange = activeRangeKey({ since: data.since, until: data.until });
  const currentViewHref = useMemo(
    () =>
      buildCurrentViewHref(explorePath, order, {
        query: data.query,
        connectionIds: selectedConnectionIds,
        streams: selectedStreams,
        excludeConnectionIds,
        excludeStreams,
        since: data.since,
        until: data.until,
        peek: data.peek ? explorerPeekParam(data.peek) : undefined,
        searchSort: data.searchSort === "recent" ? "recent" : undefined,
      }),
    [
      data.peek,
      data.query,
      data.searchSort,
      data.since,
      data.until,
      explorePath,
      order,
      selectedConnectionIds,
      selectedStreams,
      excludeConnectionIds,
      excludeStreams,
    ]
  );
  // The no-filter "All" saved-view tab target. buildHref with empty opts is the clean
  // base path — the same thing `clearAll`/clearing navigates to, minus cursors/peek.
  const allViewHref = useMemo(() => buildHref(explorePath, {}), [explorePath]);
  // A saved-view tab click navigates to its stored href through the SAME soft transition
  // every other Explore navigation uses, so the in-page loading affordances still fire.
  const navigateToHref = useCallback(
    (href: string) => {
      setPendingKind("navigation");
      startTransition(() => router.push(href));
    },
    [router]
  );
  const fullStreamHref =
    scopedConnection && selectedStreams.length === 1
      ? buildStreamRecordsHref(
          recordsBasePath,
          {
            connectionId: scopedConnection.connectionId,
            connectorId: scopedConnection.connectorId,
            stream: selectedStreams[0] ?? "",
          },
          serverExactFilters,
          order
        )
      : null;
  const fullStreamScopeNote = unsupportedFullStreamState
    ? "The full-stream list opens the whole stream; text search, date range, and local operators stay in Explore."
    : null;
  // Exact total comes ONLY from an exact_window activity summary (a server-true
  // whole-window aggregate). A bounded/search sample never carries it.
  const exactTotal =
    data.activitySummary?.source === "exact_window" && typeof data.activitySummary.total === "number"
      ? data.activitySummary.total
      : null;
  // THE LOCAL-SLICE HONESTY GATE: "Showing N of M complete" may render only when
  // there is a server-true total AND no Explore-only local filter (text / date /
  // local operator) is narrowing the view. An Explore-only slice has no
  // server-true total, so it can never claim completeness — the descriptor that
  // backs `exactTotal` (filtered_exact / exact whole-window) is structurally
  // unreachable for the local-slice case.
  const exactCountIsCurrent = exactTotal !== null && !unsupportedFullStreamState;
  const recordIdJumpFeedback = useMemo(() => {
    const needle = lastRecordIdSearch?.trim();
    if (!needle || data.query.trim() !== needle) {
      return null;
    }
    if (visibleFeed.some((entry) => entry.recordId === needle)) {
      return "Exact record ID is in these results.";
    }
    if (visibleFeed.length === 0) {
      return "No exact record ID matched in this view. Broaden filters or open the scoped stream.";
    }
    return "No exact ID match in this page; showing text matches for that value.";
  }, [data.query, lastRecordIdSearch, visibleFeed]);

  const buildSearchSortHref = useCallback(
    (searchSort: "relevance" | "recent") =>
      buildHref(explorePath, {
        query: data.query,
        connectionIds: selectedConnectionIds,
        streams: selectedStreams,
        since: data.since,
        until: data.until,
        searchSort,
      }),
    [data.query, data.since, data.until, explorePath, selectedConnectionIds, selectedStreams]
  );

  // D2 (Codex plan-check 2026-06-22): the inspector is a 3rd column ONLY when a
  // record is selected/peeked. With no selection the grid is 2-col (rail | feed)
  // and the feed claims the freed width — no reserved-empty 420px inspector (the
  // dead-canvas + query-bar/inspector-overlap root cause). `data.peek != null` is
  // the single source of selection truth (selectedPeekParam derives from it).
  const hasSelection = data.peek != null;
  return (
    <div className={hasSelection ? "rr-x has-selection" : "rr-x"}>
      {/* ── In-page route progress bar ──
          A thin top bar shown while a soft same-route push is in flight (the
          soft push never fires loading.tsx). Token-based, reduced-motion-safe.

          W3/RL4: the top bar is pinned at the canvas top (y:0). For a Load-more
          push the user has scrolled the feed DOWN inside `.rr-content`, so a
          top-y:0 bar is off-screen above them — the documented NProgress
          top-bar anti-pattern (prior art finding 6). The Load-more case carries
          its OWN feedback at the point of attention instead — the button
          spinner + reserved-height skeleton rows at the insertion point — so we
          scope the top bar to NON-Load-more navigations (full-route filter /
          sort / range / search / peek that reset scroll to the top, where the
          top IS in view). `pendingKind !== "loadmore"` is the explicit gate. */}
      <RouteProgress active={isPending && pendingKind !== "loadmore"} />

      {/* ── Facet rail ──
          A <details> disclosure so the rail can FOLD on phones (≤860px): the
          feed is the primary reading surface there. On desktop the disclosure is
          forced open and its summary chrome is hidden (see components.css). */}
      <details className="rr-x-rail" ref={railRef}>
        <summary className="rr-x-rail__toggle">
          <span className="rr-x-rail__toggle-label">Filters</span>
          {activeFacetCount > 0 && <span className="rr-x-rail__toggle-n">{activeFacetCount}</span>}
        </summary>
        <div className="rr-x-rail__body">
          {/* VIEWS section (SLVP recomposition): a calm sidebar header above SOURCES,
              matching the prototype. Explore = the count ACTUALLY SHOWN — `visibleFeed`,
              AFTER client-side filters (has:image/has:link/is:folded/non-server-filterable
              fields). Using data.feed.length (the raw loaded set) would OVERSTATE reachable
              rows when a client filter is active — a count==reachability violation (Codex
              HOLD). Upcoming = the true future-dated total. Both honest, no new data. */}
          <div className="rr-x-views">
            <span className="rr-x-views__label">Views</span>
            <div className="rr-x-views__item is-active">
              <span className="rr-x-views__name">Explore</span>
              <span className="rr-x-views__count">{visibleFeed.length.toLocaleString()}</span>
            </div>
            {data.upcomingTotal > 0 ? (
              <div className="rr-x-views__item">
                <span className="rr-x-views__name">Upcoming</span>
                <span className="rr-x-views__count">{data.upcomingTotal.toLocaleString()}</span>
              </div>
            ) : null}
          </div>
          <ConnectionFacets
            connections={data.connections}
            countFor={countForConnection}
            excluded={excludeConnectionIds}
            onToggle={toggleConnection}
            onToggleExclude={toggleExcludeConnection}
            selected={selectedConnectionIds}
          />
          <StreamFacets groups={streamGroups} onToggle={toggleStream} onToggleExclude={toggleExcludeStream} />
        </div>
        {/* P1: sticky close affordance so users aren't trapped in the mobile rail */}
        <div className="rr-x-rail__close">
          <button
            className="rr-lens"
            onClick={() => {
              if (railRef.current) {
                railRef.current.open = false;
              }
            }}
            type="button"
          >
            Close filters ✕
          </button>
        </div>
      </details>

      {/* ── Feed ──
          While any navigation is in flight the region carries aria-busy (so
          assistive tech hears "updating"), but the already-rendered records stay
          at FULL opacity and FULL interactivity — useTransition keeps the current
          UI live, so the owner can keep clicking / peeking / opening records while
          more load. The loading signal is the top progress bar + the Load-more
          control, never a dim/disable on the interactive content. */}
      <div aria-busy={feedAriaBusy(isPending)} className="rr-x-main">
        <FeedControls
          activeRange={activeRange}
          chips={chips}
          connectionCounts={connectionCounts}
          connections={data.connections}
          currentViewHref={currentViewHref}
          customInputs={customInputs}
          dateIsActive={dateIsActive}
          dateLabel={dateLabel}
          draft={draft}
          onClearAll={clearAll}
          onClearRange={clearRange}
          onCommitQuery={commitQuery}
          onDraftChange={setDraft}
          onSearchRecordId={searchRecordId}
          onSetOrder={setOrder}
          onSetRange={setRange}
          onToggleConnection={toggleConnection}
          onToggleStream={toggleStream}
          order={order}
          recordIdJumpFeedback={recordIdJumpFeedback}
          recordsBasePath={recordsBasePath}
          scopedConnection={scopedConnection}
          selectedConnectionIds={selectedConnectionIds}
          selectedStream={selectedStreams.length === 1 ? (selectedStreams[0] ?? null) : null}
          selectedStreams={selectedStreams}
          showTimeSort={showTimeSort}
          streamCounts={streamCountsMap}
          streamSuggestions={streamSuggestions}
        />

        {/* ── Saved-view tabs (R5): [All] [user-saved views] [+ Save] ── */}
        <SavedViewTabs
          activeCount={visibleFeed.length}
          allHref={allViewHref}
          currentHref={currentViewHref}
          onNavigate={navigateToHref}
        />

        {/* ── Descriptor-driven search header (escape ramps + recall-honest sort) ── */}
        {data.fromSearch && data.query ? (
          <SearchHeader
            buildSearchSortHref={buildSearchSortHref}
            data={data}
            onSort={setSearchSort}
            query={data.query}
            recordsBasePath={recordsBasePath}
            streamDoor={data.streamDoor}
          />
        ) : null}

        <FeedStatusLine
          activitySummary={data.activitySummary}
          exactCountIsCurrent={exactCountIsCurrent}
          exactTotal={exactTotal}
          fullStreamHref={fullStreamHref}
          fullStreamScopeNote={fullStreamScopeNote}
          truncated={data.truncated}
          visibleCount={visibleFeed.length}
        />
        <p className={`rr-x-feeddesc${data.fromSearch ? "" : "is-default"}`}>{feedDescription(data.lens)}</p>

        <WarningList warnings={data.warnings} />

        {/* The redundant feed-level read-request disclosure was REMOVED (feedback
            #3): "copy view link" (the single share affordance, in FeedControls)
            already lets the owner reproduce this exact scoped view, and the
            per-record request stays in the record inspector. Two controls
            surfacing the same read is noise; one share path is the contract
            (design.md §6, wireframe A). */}

        {/* ── "N new" pill ──
            Only on the non-search feed when the assembler detected records that
            arrived after the current snapshot anchor. Clicking refreshes to the
            live head (drops anchor + cursor). We do NOT auto-insert rows. */}
        {!data.fromSearch && data.newSinceAnchor != null && data.newSinceAnchor > 0 ? (
          <button className="rr-x-new-pill" onClick={() => navigate({ clearCursor: true })} type="button">
            {data.newSinceAnchor.toLocaleString()} new
          </button>
        ) : null}

        {/* ── Over-time volume band (brush → the ONE canonical (since,until)) ──
            Rendered above the day-grouped feed, only when the set-descriptor has
            an honest exhaustive time-distribution (suppressed over a
            relevance_bounded search). Bars are TRUE per-bucket totals from the
            server aggregate; the brush writes the same widened setRange the Date
            controls use, and the shaded overlay derives purely from since/until.

            The band is now loaded post-mount (deferred off first paint — the 3.6s
            aggregate no longer blocks the feed). While it loads we hold a calm
            height-matched skeleton so the feed never jumps; when `bucketRequest`
            is null (search / relevance_bounded / no targets) we render nothing,
            exactly the prior suppression contract. */}
        {bucketSeries ? (
          <OverTimeChart
            descriptorKind={data.descriptor.kind}
            onSelectRange={setRange}
            series={bucketSeries}
            since={data.since}
            until={data.until}
          />
        ) : null}
        {/* While the deferred band loads, hold a height-matched skeleton — but ONLY
            while genuinely PENDING (a live request for the current scope whose band
            has not landed). A loaded-but-empty/failed band resolves to null (NOT a
            forever-spinning skeleton), and search / relevance_bounded / no-targets ⇒
            null bucketRequest ⇒ no request ⇒ render nothing (prior suppression). */}
        {bucketBandPending ? <ChartSkeleton /> : null}

        <FeedBody
          chips={chips}
          chipsPresent={chips.length > 0}
          data={data}
          expandedBursts={expandedBursts}
          explorePath={explorePath}
          isPending={isPending}
          onClearAll={clearAll}
          onClearSelection={clearSelection}
          onLoadMore={(cursor) => {
            // Recent merged-timeline lens ACCUMULATES: append the next_cursor to
            // the trail so prior pages stay visible (the "records above disappear"
            // fix). The lexical search lens (keyword_pageable) is an honest pager,
            // so it keeps single-cursor paging. Tagged "loadmore" so only the
            // Load-more button shows its inline spinner while this push is in flight.
            if (data.descriptor.kind === "complete_chronological") {
              navigate(cursor ? { appendCursor: cursor } : {}, "loadmore");
            } else {
              navigate({ cursor: cursor ?? undefined }, "loadmore");
            }
          }}
          onLoadMoreUpcoming={(cursor) => {
            // Walk the Upcoming (future) projection one page further: append the
            // upcoming_next_cursor to the `ucursors` trail so revealed future records
            // stay visible (count==reachability). Tagged "loadmore" for the spinner.
            if (cursor) {
              navigate({ appendUpcomingCursor: cursor }, "loadmore");
            }
          }}
          onMoveSelection={moveSelection}
          onOpenRecord={openRecord}
          onSelectRecord={selectRecord}
          onToggleBurst={toggleBurst}
          pendingKind={pendingKind}
          recordsBasePath={recordsBasePath}
          selectedPeekParam={selectedPeekParam}
          visibleFeed={visibleFeed}
        />
      </div>

      {/* ── Record inspector (shared) ── */}
      <RecordInspector
        record={data.peek}
        relationships={peekRelationships}
        streamRecordsHref={data.peek ? buildStreamRecordsHref(recordsBasePath, data.peek) : null}
      />
    </div>
  );
}
