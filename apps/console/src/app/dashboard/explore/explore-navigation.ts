/**
 * Pure Explore navigation href logic — no React, no Next, no client imports.
 *
 * The canvas (`explore-canvas.tsx`) owns the URL contract for the reading room;
 * this module is the function-only core of it so the navigation rules (which
 * params survive which navigation) are unit-testable without rendering the canvas.
 *
 * URL state (`q`, `connection`, `stream`, `since`, `until`, `peek`, `order`,
 * `search_sort`, `cursor`, `cursors`, `anchor`) is the single source of truth: the
 * SSR re-fetch in `page.tsx` re-assembles the feed from these params, so every
 * server-backed interaction navigates by building one of these hrefs.
 *
 * THE FEED-DEFINING vs PIN-PRESERVING DISTINCTION (the anchor-leak fix):
 *   A feed-defining change (query / search_sort / connection / stream / since /
 *   until / an order FLIP newest↔oldest) starts a brand-new snapshot, so it MUST
 *   drop BOTH the cursor trail AND the snapshot `anchor`. A stale anchor leaking
 *   into the next Load-more would pin the new feed to the wrong snapshot timestamp
 *   (and skew the "N new" count); a trail minted in the old direction would
 *   mis-seek the new one. Only Load-more (`appendCursor`) and pure peek/selection
 *   moves (and an order param that does NOT change value) carry the trail and
 *   anchor forward, so the accumulated view stays stable within ONE snapshot.
 */

export type SortOrder = "newest" | "oldest";

export interface HrefOpts {
  /** Snapshot anchor for point-in-time stability; forwarded unchanged across pages. */
  anchor?: string;
  connectionIds?: readonly string[];
  /** Opaque single-page cursor for lexical / single-stream search pagination. */
  cursor?: string;
  /**
   * Accumulating cursor TRAIL for the recent merged-timeline lens (`cursors=c1,c2,…`).
   * Load-more appends the latest `next_cursor` so prior pages stay visible; any
   * feed-defining change omits it (resets pagination), exactly like `cursor`.
   */
  cursors?: readonly string[];
  /**
   * EXCLUDED connection ids (`xconnection=…`, repeatable). The facet "is not"
   * toggle and the `-con:` operator both compile here, so "everything except X"
   * is ONE canonical query + URL. Bounded: one param per excluded connection,
   * keyed by stable id (no raw blob), exactly like `connection`.
   */
  excludeConnectionIds?: readonly string[];
  /** EXCLUDED stream names (`xstream=…`, repeatable). Mirrors `excludeConnectionIds`. */
  excludeStreams?: readonly string[];
  peek?: string;
  query?: string;
  /** Search sort mode: "relevance" (default, ranked) or "recent" (chronological). */
  searchSort?: "relevance" | "recent";
  since?: string;
  streams?: readonly string[];
  until?: string;
  /**
   * Accumulating cursor TRAIL for the UPCOMING (future) projection (`ucursors=u1,u2,…`).
   * "Load more upcoming" appends the latest `upcoming_next_cursor` so previously-
   * revealed future records stay visible (count==reachability: walk all N upcoming).
   * Shares the feed's snapshot, so any feed-defining change omits it (resets), and
   * the trail accumulates only across Load-more / load-more-upcoming / peek moves.
   */
  upcomingCursors?: readonly string[];
}

export interface NavigateState {
  connectionIds: readonly string[];
  /** Current recent-lens cursor trail from the URL; Load-more appends to this. */
  cursorTrail: readonly string[];
  /** Current EXCLUDED connection ids from the URL (`xconnection`); the facet "is not". */
  excludeConnectionIds: readonly string[];
  /** Current EXCLUDED stream names from the URL (`xstream`). */
  excludeStreams: readonly string[];
  order: SortOrder;
  query: string;
  searchSort: "relevance" | "recent";
  since: string;
  snapshotAnchor: string | null;
  streams: readonly string[];
  until: string;
  /** Current Upcoming (future) cursor trail from the URL; load-more-upcoming appends. */
  upcomingTrail: readonly string[];
}

export interface NavigateOpts {
  /**
   * Recent-lens "Load more": APPEND this `next_cursor` to the current trail so
   * prior pages stay visible (accumulate, not replace). Any other navigation
   * omits it and the trail RESETS to page 1.
   */
  appendCursor?: string;
  /**
   * Upcoming "Load more": APPEND this `upcoming_next_cursor` to the upcoming trail
   * so previously-revealed future records stay visible (accumulate, not replace).
   * Carried alongside the feed trail; any feed-defining change resets both.
   */
  appendUpcomingCursor?: string;
  /** When true, drop the cursor, trail, and anchor (refresh to live head). */
  clearCursor?: boolean;
  connectionIds?: string[];
  /** Single-page search cursor. Omit to reset to page 1. */
  cursor?: string;
  /**
   * EXCLUDED connection ids (facet "is not" / `-con:`). Feed-defining: changing
   * it resets the cursor trail + anchor, exactly like `connectionIds`.
   */
  excludeConnectionIds?: string[];
  /** EXCLUDED stream names. Feed-defining, like `streams`. */
  excludeStreams?: string[];
  order?: SortOrder;
  peek?: string;
  query?: string;
  /** Search sort mode — resets cursor when changed. */
  searchSort?: "relevance" | "recent";
  since?: string;
  streams?: string[];
  until?: string;
}

/**
 * Local href builder over the explore base path. Mirrors operator-ui's
 * `buildExplorerHref` param contract (q / connection* / stream* / since / until
 * / peek) but takes a plain base-path string so no function-bearing object
 * crosses the RSC boundary. Adds the merged-timeline params (search_sort /
 * cursor / cursors / anchor) the assembler reads.
 */
export function buildHref(base: string, opts: HrefOpts): string {
  const params = new URLSearchParams();
  if (opts.query) {
    params.set("q", opts.query);
  }
  for (const id of opts.connectionIds ?? []) {
    params.append("connection", id);
  }
  for (const id of opts.excludeConnectionIds ?? []) {
    params.append("xconnection", id);
  }
  for (const s of opts.streams ?? []) {
    params.append("stream", s);
  }
  for (const s of opts.excludeStreams ?? []) {
    params.append("xstream", s);
  }
  if (opts.since) {
    params.set("since", opts.since);
  }
  if (opts.until) {
    params.set("until", opts.until);
  }
  if (opts.peek) {
    params.set("peek", opts.peek);
  }
  // Search sort mode: only set in URL when non-default ("recent"). Clearing the
  // sort or changing query drops the cursor so pagination resets.
  if (opts.searchSort === "recent") {
    params.set("search_sort", "recent");
  }
  if (opts.cursor) {
    params.set("cursor", opts.cursor);
  }
  // Recent-lens accumulating trail: comma-joined so the whole trail is one param
  // (mirrors the per-stream pager's `cursors`). Omitted when empty so changing the
  // query/sort/filters/range resets pagination back to page 1.
  if (opts.cursors && opts.cursors.length > 0) {
    params.set("cursors", opts.cursors.join(","));
  }
  // Upcoming (future) accumulating trail: comma-joined, one param. Omitted when
  // empty so a feed-defining change resets the upcoming walk back to its head.
  if (opts.upcomingCursors && opts.upcomingCursors.length > 0) {
    params.set("ucursors", opts.upcomingCursors.join(","));
  }
  if (opts.anchor) {
    params.set("anchor", opts.anchor);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * True when a navigation REDEFINES the feed membership (query, search_sort,
 * connection, stream, or since/until range). A feed-defining change starts a
 * brand-new snapshot, so it MUST drop BOTH the cursor trail AND the snapshot
 * `anchor` — otherwise a stale anchor leaks into the next Load-more (and into the
 * "N new" count), pinning the new feed to the wrong snapshot timestamp.
 *
 * Non-feed-defining moves are EXCLUDED so the accumulated view + its anchor survive:
 *   - Load-more (`appendCursor`) — accumulate within the SAME snapshot.
 *   - Pure peek/selection (`peek`) — same feed.
 *   - The "N new" pill (`clearCursor`) — handled separately; it drops both already.
 *
 * NOTE on `order`: an order FLIP (newest↔oldest) IS feed-defining, but it depends
 * on the PRIOR direction (`state.order`), which this opts-only predicate can't see.
 * So `order` is intentionally absent here; `buildNavigateHref` resets the feed when
 * `opts.order` differs from `state.order` (a same-value `order` carried forward by a
 * peek is correctly a same-feed move).
 */
export function isFeedDefiningNavigation(opts: NavigateOpts): boolean {
  return (
    opts.query !== undefined ||
    opts.searchSort !== undefined ||
    opts.connectionIds !== undefined ||
    opts.excludeConnectionIds !== undefined ||
    opts.streams !== undefined ||
    opts.excludeStreams !== undefined ||
    opts.since !== undefined ||
    opts.until !== undefined
  );
}

/**
 * Resolve a navigation href from the current URL state + the requested deltas.
 * Pure so the `navigate` callback stays small: it folds each `opts.X ?? state.X`
 * default and the order suffix here, off the component body.
 */
/**
 * Resolve one accumulating cursor trail across a navigation. A reset (feed-defining
 * change / clearCursor) drops it; otherwise an `append` extends it (Load-more), and
 * a pure peek/order/sibling-load-more carries the existing trail forward unchanged.
 * Returns undefined to OMIT the param (empty trail) so the URL resets to page 1.
 */
function nextAccumulatingTrail(
  reset: boolean,
  current: readonly string[],
  append: string | undefined
): readonly string[] | undefined {
  if (reset) {
    return;
  }
  if (append) {
    return [...current, append];
  }
  // A pure carry-forward keeps a non-empty trail; an empty trail omits the param.
  return current.length > 0 ? current : undefined;
}

export function buildNavigateHref(explorePath: string, state: NavigateState, opts: NavigateOpts): string {
  // An ORDER change (newest↔oldest) is FEED-DEFINING: "oldest" is a real server
  // keyset re-page ASCENDING from the earliest record (direction=asc), not a
  // client reverse, so flipping it must reset the cursor trail + anchor and
  // re-page from the new direction's start (page 1). A trail minted in the old
  // direction would mis-seek the new one. A no-op `order` (same value, e.g. a peek
  // that carries order forward) is NOT a flip and keeps the trail. The `order`
  // param itself is appended below by `withOrderSuffix`.
  const orderChanged = opts.order !== undefined && opts.order !== state.order;
  // A feed-defining change (query / search_sort / connection / stream / since /
  // until / order flip) AND the "N new" pill (clearCursor) both reset the feed:
  // drop the trail AND the anchor so the next load takes a FRESH snapshot. Only
  // Load-more and pure peek/selection moves carry the anchor forward for stability.
  const resetFeed = opts.clearCursor || orderChanged || isFeedDefiningNavigation(opts);
  const forwardAnchor = resetFeed ? undefined : (state.snapshotAnchor ?? undefined);
  // Recent-lens pagination: Load-more APPENDS to the current trail (accumulate).
  // Every OTHER navigation resets the trail — exactly like the single `cursor`
  // resets today — so changing query/sort/filters/range starts from page 1.
  // The feed trail survives every non-resetting navigation (Load-more appends to it;
  // peek / order / load-more-upcoming carry it forward unchanged so the accumulated
  // PAST feed does not collapse to page 1 when the owner peeks a record or pages the
  // upcoming set). Only a feed-defining change or clearCursor resets it.
  const nextTrail = nextAccumulatingTrail(resetFeed, state.cursorTrail, opts.appendCursor);
  // The Upcoming trail shares the feed's snapshot, so it accumulates/resets on the
  // SAME rule: "Load more upcoming" (appendUpcomingCursor) extends it; a pure feed
  // Load-more / peek / order carries it forward unchanged (revealed future records
  // don't vanish when the owner loads more PAST records); a feed-defining change or
  // clearCursor resets it to the head.
  const nextUpcomingTrail = nextAccumulatingTrail(resetFeed, state.upcomingTrail, opts.appendUpcomingCursor);
  const href = buildHref(explorePath, {
    query: opts.query ?? state.query,
    connectionIds: opts.connectionIds ?? state.connectionIds,
    excludeConnectionIds: opts.excludeConnectionIds ?? state.excludeConnectionIds,
    streams: opts.streams ?? state.streams,
    excludeStreams: opts.excludeStreams ?? state.excludeStreams,
    since: opts.since ?? state.since,
    until: opts.until ?? state.until,
    peek: opts.peek,
    searchSort: opts.searchSort ?? (state.searchSort === "recent" ? "recent" : undefined),
    cursor: opts.clearCursor ? undefined : opts.cursor,
    // Trail is preserved ONLY for Load-more (appendCursor); every other navigation
    // leaves nextTrail undefined → the `cursors` param is dropped (reset to page 1).
    cursors: nextTrail,
    upcomingCursors: nextUpcomingTrail,
    // Anchor survives ONLY for non-feed-defining moves (Load-more, peek, order);
    // forwardAnchor is already undefined when the feed is reset.
    anchor: forwardAnchor,
  });
  const nextOrder = opts.order ?? state.order;
  return nextOrder === "oldest" ? `${href}${href.includes("?") ? "&" : "?"}order=oldest` : href;
}

/** Append the `order=oldest` suffix (the only non-param URL bit) when needed. */
export function withOrderSuffix(href: string, order: SortOrder): string {
  return order === "oldest" ? `${href}${href.includes("?") ? "&" : "?"}order=oldest` : href;
}

/** The shareable href for the exact current view (copy-link button). */
export function buildCurrentViewHref(explorePath: string, order: SortOrder, opts: HrefOpts): string {
  return withOrderSuffix(buildHref(explorePath, opts), order);
}
