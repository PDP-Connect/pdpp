/**
 * Explore navigation href rules — the ANCHOR-LEAK fix (Codex HOLD follow-up).
 *
 * docs/research/explore-loadmore-snapshot-pin-fix-2026-06-20.md (Anchor leak fix):
 * a feed-defining navigation (query / search_sort / connection / stream / since /
 * until) MUST drop BOTH the cursor trail AND the snapshot `anchor`. Before this fix,
 * `buildNavigateHref` only dropped the anchor on `clearCursor`, so changing the
 * connection/stream/range/query FORWARDED a stale anchor into the next Load-more
 * (pinning the new feed to the wrong snapshot timestamp and skewing "N new").
 *
 * These tests assert the rule on `buildNavigateHref`/`isFeedDefiningNavigation`
 * directly (the functions are pure, no React). Feed-defining → no `anchor`, no
 * `cursors`. Pin-preserving (Load-more / peek / a same-value `order` carried
 * forward) → `anchor` survives.
 *
 * SORT-CELL UPDATE (docs/research/explore-design-cells/sort/design.md §2): an
 * order FLIP (newest↔oldest) is now FEED-DEFINING, because "oldest" is a real
 * server keyset re-page ASCENDING (direction=asc), not a client reverse — so a
 * flip must re-page from page 1 (drop the trail + anchor; a trail minted in the
 * old direction would mis-seek the new one). A same-value `order` (carried
 * forward by a peek) stays a same-feed move.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNavigateHref,
  isFeedDefiningNavigation,
  type NavigateOpts,
  type NavigateState,
} from "./explore-navigation.ts";

const EXPLORE = "/explore";

/** A state that is mid-accumulation: it has a snapshot anchor and a 1-cursor trail. */
function accumulatingState(overrides: Partial<NavigateState> = {}): NavigateState {
  return {
    connectionIds: ["cin_amazon"],
    cursorTrail: ["cursor-p2"],
    excludeConnectionIds: [],
    excludeStreams: [],
    upcomingTrail: ["ucursor-u1"],
    order: "newest",
    query: "",
    searchSort: "relevance",
    since: "",
    snapshotAnchor: "2026-06-20T00:00:00Z",
    streams: ["orders"],
    until: "",
    ...overrides,
  };
}

function paramsOf(href: string): URLSearchParams {
  const q = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
  return new URLSearchParams(q);
}

// ─── isFeedDefiningNavigation classification ─────────────────────────────────

test("isFeedDefiningNavigation: feed-defining opts are classified as such", () => {
  const feedDefining: NavigateOpts[] = [
    { query: "coffee" },
    { searchSort: "recent" },
    { connectionIds: ["cin_ynab"] },
    { streams: ["transactions"] },
    { since: "2026-01-01T00:00:00Z" },
    { until: "2026-02-01T00:00:00Z" },
  ];
  for (const opts of feedDefining) {
    assert.ok(
      isFeedDefiningNavigation(opts),
      `${JSON.stringify(opts)} must be feed-defining (it redefines the snapshot)`
    );
  }
});

test("isFeedDefiningNavigation: pin-preserving moves are NOT feed-defining", () => {
  const pinPreserving: NavigateOpts[] = [
    { appendCursor: "cursor-p3" }, // Load-more
    { peek: "amazon/orders/abc" }, // selection/peek
    { order: "oldest" }, // display re-sort
    { clearCursor: true }, // "N new" pill (handled separately)
    {}, // no-op
  ];
  for (const opts of pinPreserving) {
    assert.ok(!isFeedDefiningNavigation(opts), `${JSON.stringify(opts)} must NOT be feed-defining`);
  }
});

// ─── Feed-defining navigations DROP anchor + trail ───────────────────────────

test("feed-defining nav DROPS both anchor and cursors (the anchor-leak fix)", () => {
  const state = accumulatingState();
  const cases: Array<{ label: string; opts: NavigateOpts }> = [
    { label: "query change", opts: { query: "refund" } },
    { label: "search_sort change", opts: { searchSort: "recent" } },
    { label: "connection toggle", opts: { connectionIds: ["cin_ynab"] } },
    { label: "stream toggle", opts: { streams: ["transactions"] } },
    { label: "since range change", opts: { since: "2026-01-01T00:00:00Z" } },
    { label: "until range change", opts: { until: "2026-02-01T00:00:00Z" } },
  ];
  for (const { label, opts } of cases) {
    const params = paramsOf(buildNavigateHref(EXPLORE, state, opts));
    assert.equal(params.get("anchor"), null, `${label}: the stale snapshot anchor MUST be dropped (anchor-leak fix)`);
    assert.equal(params.get("cursors"), null, `${label}: the cursor trail MUST be dropped (reset to page 1)`);
    assert.equal(
      params.get("ucursors"),
      null,
      `${label}: the upcoming trail MUST be dropped (new feed = new snapshot = new upcoming set)`
    );
  }
});

// ─── Pin-preserving navigations KEEP anchor ──────────────────────────────────

test("Load-more (appendCursor) PRESERVES anchor and APPENDS to the trail", () => {
  const state = accumulatingState();
  const params = paramsOf(buildNavigateHref(EXPLORE, state, { appendCursor: "cursor-p3" }));
  assert.equal(
    params.get("anchor"),
    "2026-06-20T00:00:00Z",
    "Load-more must carry the snapshot anchor forward (same snapshot)"
  );
  assert.equal(
    params.get("cursors"),
    "cursor-p2,cursor-p3",
    "Load-more must APPEND the new cursor to the existing trail"
  );
});

test("peek/selection PRESERVES anchor and the trail (same feed)", () => {
  const state = accumulatingState();
  const params = paramsOf(buildNavigateHref(EXPLORE, state, { peek: "amazon/orders/abc" }));
  assert.equal(params.get("anchor"), "2026-06-20T00:00:00Z", "peek must keep the snapshot anchor");
  assert.equal(params.get("peek"), "amazon/orders/abc", "peek param is set");
  // Peeking a record must NOT collapse the accumulated feed back to page 1.
  assert.equal(params.get("cursors"), "cursor-p2", "peek carries the feed trail forward unchanged");
});

test("order FLIP is feed-defining: re-pages from page 1 (drops anchor + cursor trail)", () => {
  // newest→oldest is a real server keyset re-page ASCENDING (direction=asc), not a
  // client reverse, so it MUST reset to page 1: a trail minted newest-first would
  // mis-seek the ascending walk, and a stale anchor would pin the wrong snapshot.
  const state = accumulatingState(); // order: "newest"
  const href = buildNavigateHref(EXPLORE, state, { order: "oldest" });
  const params = paramsOf(href);
  assert.ok(href.includes("order=oldest"), "order=oldest suffix is appended");
  assert.equal(params.get("anchor"), null, "an order flip must drop the stale snapshot anchor");
  assert.equal(params.get("cursors"), null, "an order flip must reset the feed cursor trail to page 1");
  assert.equal(params.get("ucursors"), null, "an order flip resets the upcoming trail too (fresh snapshot)");
});

test("a same-value order (carried forward by a peek) is NOT feed-defining (same feed)", () => {
  // A peek that carries the current order forward unchanged (newest == state.order)
  // is a pure same-feed move — the accumulated trail + anchor must survive.
  const state = accumulatingState(); // order: "newest"
  const params = paramsOf(buildNavigateHref(EXPLORE, state, { order: "newest", peek: "amazon/orders/abc" }));
  assert.equal(params.get("anchor"), "2026-06-20T00:00:00Z", "a same-value order keeps the snapshot anchor");
  assert.equal(params.get("cursors"), "cursor-p2", "a same-value order keeps the accumulated feed trail");
  assert.ok(!paramsOf(buildNavigateHref(EXPLORE, state, { order: "newest" })).has("order"), "newest stays out of URL");
});

// ─── "N new" pill (clearCursor) DROPS both (unchanged behavior) ───────────────

test('"N new" pill (clearCursor) DROPS anchor and cursors (refresh to live head)', () => {
  const state = accumulatingState();
  const params = paramsOf(buildNavigateHref(EXPLORE, state, { clearCursor: true }));
  assert.equal(params.get("anchor"), null, "clearCursor drops the anchor (fresh snapshot)");
  assert.equal(params.get("cursors"), null, "clearCursor drops the trail");
  assert.equal(params.get("cursor"), null, "clearCursor drops the single-page cursor");
  assert.equal(params.get("ucursors"), null, "clearCursor drops the upcoming trail (fresh snapshot)");
});

// ─── Upcoming (future) trail: count==reachability ────────────────────────────

test("Load-more-upcoming (appendUpcomingCursor) APPENDS to the ucursors trail", () => {
  const state = accumulatingState();
  const params = paramsOf(buildNavigateHref(EXPLORE, state, { appendUpcomingCursor: "ucursor-u2" }));
  assert.equal(
    params.get("ucursors"),
    "ucursor-u1,ucursor-u2",
    "load-more-upcoming must APPEND the new upcoming cursor to the existing trail"
  );
  assert.equal(params.get("anchor"), "2026-06-20T00:00:00Z", "load-more-upcoming keeps the same snapshot anchor");
  // It must NOT touch the feed (past) trail.
  assert.equal(params.get("cursors"), "cursor-p2", "load-more-upcoming leaves the feed trail unchanged");
});

test("feed Load-more CARRIES the upcoming trail forward unchanged (revealed future records persist)", () => {
  const state = accumulatingState();
  const params = paramsOf(buildNavigateHref(EXPLORE, state, { appendCursor: "cursor-p3" }));
  assert.equal(
    params.get("ucursors"),
    "ucursor-u1",
    "loading more PAST records must not drop the already-revealed upcoming pages"
  );
  assert.equal(params.get("cursors"), "cursor-p2,cursor-p3", "the feed trail still appends");
});

test("peek (and a same-value order) CARRY the upcoming trail forward (same feed)", () => {
  // A peek, and a same-value `order` carried forward, are same-feed moves: the
  // revealed upcoming pages persist. (An order FLIP is feed-defining and resets
  // the upcoming trail — covered in the order-flip test above.)
  const state = accumulatingState(); // order: "newest"
  for (const opts of [{ peek: "amazon/orders/abc" }, { order: "newest" as const }]) {
    const params = paramsOf(buildNavigateHref(EXPLORE, state, opts));
    assert.equal(params.get("ucursors"), "ucursor-u1", `${JSON.stringify(opts)} keeps the upcoming trail`);
  }
});

test("a fresh state with no upcoming trail emits no ucursors param", () => {
  const state = accumulatingState({ upcomingTrail: [] });
  const params = paramsOf(buildNavigateHref(EXPLORE, state, { appendCursor: "cursor-p3" }));
  assert.equal(params.get("ucursors"), null, "no upcoming trail → no ucursors param");
});

// ─── Slice 2: EXCLUDE params (facet "is not" / -con:/-stream:) ────────────────

test("exclude opts emit xconnection/xstream params (ONE canonical query for 'everything except')", () => {
  const state = accumulatingState();
  const href = buildNavigateHref(EXPLORE, state, {
    excludeConnectionIds: ["cin_ynab"],
    excludeStreams: ["budget_months"],
  });
  const params = paramsOf(href);
  assert.equal(params.get("xconnection"), "cin_ynab", "excluded connection rides the bounded xconnection param");
  assert.equal(params.get("xstream"), "budget_months", "excluded stream rides the bounded xstream param");
});

test("exclude is feed-defining: changing it DROPS the cursor trail + anchor (new membership)", () => {
  const state = accumulatingState();
  for (const opts of [{ excludeConnectionIds: ["cin_ynab"] }, { excludeStreams: ["budget_months"] }]) {
    assert.ok(isFeedDefiningNavigation(opts), `${JSON.stringify(opts)} redefines membership → feed-defining`);
    const params = paramsOf(buildNavigateHref(EXPLORE, state, opts));
    assert.equal(params.get("anchor"), null, "an exclude change must drop the stale snapshot anchor");
    assert.equal(params.get("cursors"), null, "an exclude change must reset the cursor trail to page 1");
  }
});

test("exclude state survives a pin-preserving move (Load-more carries xconnection forward)", () => {
  const state = accumulatingState({ excludeConnectionIds: ["cin_ynab"], excludeStreams: ["budget_months"] });
  const params = paramsOf(buildNavigateHref(EXPLORE, state, { appendCursor: "cursor-p3" }));
  // Load-more is NOT feed-defining, so the active exclusion is carried forward.
  assert.equal(params.get("xconnection"), "cin_ynab", "Load-more keeps the active connection exclusion");
  assert.equal(params.get("xstream"), "budget_months", "Load-more keeps the active stream exclusion");
  assert.equal(params.get("cursors"), "cursor-p2,cursor-p3", "and still appends the cursor trail");
});

test("a state with no exclusions emits no xconnection/xstream params (bounded URL)", () => {
  const state = accumulatingState({ excludeConnectionIds: [], excludeStreams: [] });
  const params = paramsOf(buildNavigateHref(EXPLORE, state, { peek: "amazon/orders/abc" }));
  assert.equal(params.get("xconnection"), null, "no exclusion → no xconnection param");
  assert.equal(params.get("xstream"), null, "no exclusion → no xstream param");
});
