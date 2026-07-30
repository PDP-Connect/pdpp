// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { loadConnectorSummaryPage } from "./connector-summary-page.tsx";
import {
  buildNextPageHref,
  buildRestartHref,
  isPagedRequest,
  parseConnectorSummaryPageState,
} from "./connector-summary-pager.ts";

const MALFORMED_PAGE_RE = /malformed page/i;
const SELF_LOOP_RE = /loops back to this same page/i;
const INVALID_RE = /invalid/i;
const GLOBAL_THIS_USAGE_RE = /globalThis/;
const NAV_FIELD_RE = /:\s*ConnectorSummaryPage(Params|State)\b[\s\S]{0,80}\bnav/i;
const PAGE_STACK_USAGE_RE = /params\.(set|get|append)\("page_stack"\)|page_stack\??:/;

test("parseConnectorSummaryPageState: page 1 has no cursor", () => {
  const state = parseConnectorSummaryPageState({});
  assert.equal(state.cursor, undefined);
  assert.equal(isPagedRequest(state), false);
});

test("parseConnectorSummaryPageState: parses a single opaque cursor", () => {
  const state = parseConnectorSummaryPageState({ page_cursor: "c1" });
  assert.equal(state.cursor, "c1");
  assert.equal(isPagedRequest(state), true);
});

test("buildNextPageHref: page 1 -> page 2 carries the new cursor, no other pager param", () => {
  const href = buildNextPageHref("/sources", {}, "c1");
  const url = new URL(href, "https://example.test");
  assert.equal(url.searchParams.get("page_cursor"), "c1");
  assert.equal(url.searchParams.has("nav"), false, "no nav/session token is ever emitted");
});

test("buildNextPageHref: replaces the prior cursor rather than accumulating one — no history param anywhere in the output", () => {
  const href = buildNextPageHref("/sources", { page_cursor: "c1" }, "c2");
  const url = new URL(href, "https://example.test");
  assert.equal(url.searchParams.get("page_cursor"), "c2");
  assert.equal(url.searchParams.get("page_stack"), null, "no page_stack/history param may ever appear in the URL");
  assert.equal([...url.searchParams.keys()].length, 1, "exactly one bounded pager param — no accumulated state");
});

test("buildNextPageHref: preserves every OTHER current search param verbatim (query text, filters, selections)", () => {
  const href = buildNextPageHref("/sources/add", { page_cursor: "c1", source_q: "gmail" }, "c2");
  const url = new URL(href, "https://example.test");
  assert.equal(url.searchParams.get("source_q"), "gmail", "an unrelated param must survive paging forward");
  assert.equal(url.searchParams.get("page_cursor"), "c2");
});

test("buildNextPageHref: preserves EVERY value of a repeated param, not just the first", () => {
  const href = buildNextPageHref("/sources", { page_cursor: "c1", tag: ["a", "b"] }, "c2");
  const url = new URL(href, "https://example.test");
  assert.deepEqual(url.searchParams.getAll("tag"), ["a", "b"], "both repeated values must survive paging forward");
  assert.equal(url.searchParams.get("page_cursor"), "c2");
});

test("buildNextPageHref: drops undefined-valued params rather than serializing the literal string 'undefined'", () => {
  const href = buildNextPageHref("/sources", { connection_id: undefined, page_cursor: "c1" }, "c2");
  const url = new URL(href, "https://example.test");
  assert.equal(url.searchParams.has("connection_id"), false);
});

test("buildRestartHref: drops the cursor, returning the bare base path when no other params are present", () => {
  assert.equal(buildRestartHref("/sources", { page_cursor: "c1" }), "/sources");
});

test("buildRestartHref: preserves every OTHER current search param", () => {
  const href = buildRestartHref("/connect/manual-upload/strava", {
    connection_id: "cin_1",
    page_cursor: "c3",
  });
  const url = new URL(href, "https://example.test");
  assert.equal(url.searchParams.get("connection_id"), "cin_1");
  assert.equal(url.searchParams.has("page_cursor"), false);
});

test("buildRestartHref: preserves EVERY value of a repeated param", () => {
  const href = buildRestartHref("/sources", { page_cursor: "c3", tag: ["a", "b"] });
  const url = new URL(href, "https://example.test");
  assert.deepEqual(url.searchParams.getAll("tag"), ["a", "b"]);
  assert.equal(url.searchParams.has("page_cursor"), false);
});

// ─── Structural: no session/history machinery exists to reintroduce the
// forgeable/unbounded nav-token store the gate rejected. ────────────────────

test("structural: this module's source contains no nav/session/globalThis machinery", async () => {
  const src = await (await import("node:fs/promises")).readFile(
    new URL("./connector-summary-pager.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(src, GLOBAL_THIS_USAGE_RE, "no globalThis-backed session store");
  assert.doesNotMatch(src, NAV_FIELD_RE, "no nav/session field on the pager's param/state types");
  assert.doesNotMatch(src, PAGE_STACK_USAGE_RE, "no accumulated history param field or usage");
});

// ─── Adversarial: malformed / self-looping envelopes ───────────────────────
//
// The interactive pager validates the envelope strictly (shape + coherent
// continuation, via @pdpp/list-envelope) and rejects an IMMEDIATE self-loop
// (next_cursor === the cursor that produced it) — the one cycle a SINGLE
// request/response pair can prove on its own. It deliberately does NOT track
// cross-request history to catch a non-adjacent cycle (a -> b -> a): this
// surface talks to our own authenticated backend over an already-signed,
// monotonic keyset cursor contract, so defending against a backend that
// breaks that contract is ref-control.ts's job, not a client-held session
// map's. See connector-summary-page.tsx's module doc for the full rationale.

test("adversarial: has_more:true with a missing next_cursor is rejected, not silently treated as exhausted", async () => {
  const state = parseConnectorSummaryPageState({});
  const result = await loadConnectorSummaryPage(state, () =>
    Promise.resolve({ data: [{ id: "a" }], has_more: true, next_cursor: undefined, object: "list" as const })
  );
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.message, MALFORMED_PAGE_RE);
  }
});

test("adversarial: a next_cursor identical to the cursor just requested (immediate self-loop) is rejected", async () => {
  const state = parseConnectorSummaryPageState({ page_cursor: "c1" });
  const result = await loadConnectorSummaryPage(state, () =>
    Promise.resolve({ data: [{ id: "a" }], has_more: true, next_cursor: "c1", object: "list" as const })
  );
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.message, SELF_LOOP_RE);
  }
});

test("a non-adjacent cycle (a -> b -> a) is NOT tracked across requests — each render is judged independently", async () => {
  // page 1 (undefined) -> a
  const first = await loadConnectorSummaryPage({ cursor: undefined }, () =>
    Promise.resolve({ data: [{ id: "page-1" }], has_more: true, next_cursor: "a", object: "list" as const })
  );
  assert.equal(first.kind, "ok");

  // a -> b
  const second = await loadConnectorSummaryPage({ cursor: "a" }, () =>
    Promise.resolve({ data: [{ id: "page-a" }], has_more: true, next_cursor: "b", object: "list" as const })
  );
  assert.equal(second.kind, "ok");

  // b -> a: not an immediate self-loop (state.cursor is "b", next_cursor is
  // "a") so it is NOT rejected here — by design. There is no visited-set to
  // consult; only ref-control.ts's cursor contract can prevent this.
  const third = await loadConnectorSummaryPage({ cursor: "b" }, () =>
    Promise.resolve({ data: [{ id: "page-b" }], has_more: true, next_cursor: "a", object: "list" as const })
  );
  assert.equal(third.kind, "ok", "no cross-request cycle history is kept for the interactive UI pager");
});

test("ADVERSARIAL: wrong discriminator (object !== 'list') is rejected", async () => {
  const state = parseConnectorSummaryPageState({});
  const result = await loadConnectorSummaryPage(state, () =>
    Promise.resolve({ data: [], has_more: false, object: "wrong" } as never)
  );
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.message, MALFORMED_PAGE_RE);
  }
});

test("ADVERSARIAL: non-array data is rejected", async () => {
  const state = parseConnectorSummaryPageState({});
  const result = await loadConnectorSummaryPage(state, () =>
    Promise.resolve({ data: { bad: true }, has_more: false, object: "list" } as never)
  );
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.message, MALFORMED_PAGE_RE);
  }
});

test("ADVERSARIAL: non-boolean has_more is rejected, never coerced", async () => {
  const state = parseConnectorSummaryPageState({});
  const result = await loadConnectorSummaryPage(state, () =>
    Promise.resolve({ data: [], has_more: "true", object: "list" } as never)
  );
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.message, MALFORMED_PAGE_RE);
  }
});

test("ADVERSARIAL: a whitespace-only next_cursor on has_more:true is rejected, never issued as a literal blank-cursor request", async () => {
  const state = parseConnectorSummaryPageState({});
  const result = await loadConnectorSummaryPage(state, () =>
    Promise.resolve({ data: [], has_more: true, next_cursor: "   ", object: "list" as const })
  );
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.message, MALFORMED_PAGE_RE);
  }
});

test("adversarial: a rejected/malformed cursor (thrown by the fetcher) surfaces as an explicit error, never an empty list", async () => {
  const state = parseConnectorSummaryPageState({ page_cursor: "not-a-real-cursor" });
  const result = await loadConnectorSummaryPage(state, () => {
    throw new Error("Connector summary cursor is invalid");
  });
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.message, INVALID_RE);
  }
});

test("adversarial: the URL contract itself cannot carry an oversized/unbounded history — no page_stack field exists to populate", () => {
  // There is no builder that accepts a stack/history array — the only way to
  // advance is buildNextPageHref(basePath, currentParams, ONE cursor).
  const href = buildNextPageHref("/sources", { page_cursor: "c1" }, "c2");
  const url = new URL(href, "https://example.test");
  assert.equal(url.searchParams.getAll("page_cursor").length, 1);
  assert.equal(url.searchParams.has("nav"), false);
});

// ─── >100 fleet: one-request first render + full reachability oracle ──────

const LARGE_FLEET_SIZE = 250;
const PAGE_LIMIT = 100;

function makeLargeFleet(size: number): { connection_id: string }[] {
  return Array.from({ length: size }, (_, i) => ({ connection_id: `cin_${String(i).padStart(4, "0")}` }));
}

function pagedFetcher(allRows: readonly { connection_id: string }[], limit: number) {
  let callCount = 0;
  const fetchPage = (cursor: string | undefined) => {
    callCount += 1;
    const offset = cursor ? Number(cursor) : 0;
    const page = allRows.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < allRows.length;
    return Promise.resolve({
      data: [...page],
      has_more: hasMore,
      next_cursor: hasMore ? String(nextOffset) : undefined,
      object: "list" as const,
    });
  };
  return { fetchPage, getCallCount: () => callCount };
}

test(">100 fleet: the FIRST render observes exactly ONE bounded page request, never the exhaustive fold", async () => {
  const fleet = makeLargeFleet(LARGE_FLEET_SIZE);
  const { fetchPage, getCallCount } = pagedFetcher(fleet, PAGE_LIMIT);
  const pageState = parseConnectorSummaryPageState({});

  const result = await loadConnectorSummaryPage(pageState, ({ cursor, limit }) =>
    fetchPage(cursor).then((r) => ({ ...r, data: r.data.slice(0, limit) }))
  );

  assert.equal(getCallCount(), 1, "first render must make exactly one request for a >100 fleet");
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(
      result.items.length,
      PAGE_LIMIT,
      "first page returns exactly the bounded page size, not the whole fleet"
    );
    assert.equal(result.hasMore, true, "a 250-row fleet at limit=100 must report more pages remain");
  }
});

test(">100 fleet: sequential Next navigation reaches every page and every identity, never prefetching ahead", async () => {
  const fleet = makeLargeFleet(LARGE_FLEET_SIZE);
  const { fetchPage, getCallCount } = pagedFetcher(fleet, PAGE_LIMIT);

  const seenIds = new Set<string>();
  let state = parseConnectorSummaryPageState({});
  let requestsSoFar = 0;
  let pagesVisited = 0;
  const basePath = "/sources";

  for (let guard = 0; guard < 10; guard += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each page's render depends on the previous page's cursor, simulating real sequential navigation.
    const result = await loadConnectorSummaryPage(state, ({ cursor, limit }) =>
      fetchPage(cursor).then((r) => ({ ...r, data: r.data.slice(0, limit) }))
    );
    pagesVisited += 1;
    requestsSoFar += 1;
    assert.equal(
      getCallCount(),
      requestsSoFar,
      `render ${pagesVisited} must make exactly one new request, not prefetch`
    );
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") {
      break;
    }
    for (const item of result.items) {
      assert.ok(!seenIds.has(item.connection_id), `identity ${item.connection_id} must not be reachable twice`);
      seenIds.add(item.connection_id);
    }
    if (!(result.hasMore && result.nextCursor)) {
      break;
    }
    const nextHref = buildNextPageHref(basePath, { page_cursor: state.cursor }, result.nextCursor);
    const nextUrl = new URL(nextHref, "https://example.test");
    state = parseConnectorSummaryPageState({
      page_cursor: nextUrl.searchParams.get("page_cursor") ?? undefined,
    });
  }

  assert.equal(
    seenIds.size,
    LARGE_FLEET_SIZE,
    "every identity in the 250-row fleet must be reached via pager navigation"
  );
  assert.equal(pagesVisited, 3, "250 rows at limit=100 must take exactly 3 sequential page visits (100+100+50)");
});

test("Restart always returns to page 1 regardless of how many pages were visited (no dependence on accumulated history)", () => {
  // Simulate having paged forward several times, ending on some arbitrary cursor.
  const deepState = { page_cursor: "c-deep-in-the-fleet", source_q: "gmail" };
  const restartHref = buildRestartHref("/sources/add", deepState);
  const url = new URL(restartHref, "https://example.test");
  assert.equal(url.searchParams.has("page_cursor"), false, "Restart must always drop the cursor entirely");
  assert.equal(url.searchParams.get("source_q"), "gmail", "Restart still preserves unrelated params");
});

test("browser Back still works after Next: Next never mutates history, it is an ordinary link navigation", () => {
  // There is no client-side history manipulation anywhere in this module —
  // buildNextPageHref/buildRestartHref only ever return plain hrefs for a
  // <Link>, so the browser's native back-stack is untouched by definition.
  // This test documents that invariant structurally: neither builder takes
  // or references `window.history`/`router` in any form.
  const nextHref = buildNextPageHref("/sources", {}, "c1");
  const restartHref = buildRestartHref("/sources", { page_cursor: "c1" });
  assert.equal(typeof nextHref, "string");
  assert.equal(typeof restartHref, "string");
});
