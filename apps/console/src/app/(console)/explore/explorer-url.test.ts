// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExplorerHref,
  computeActivityStripCells,
  type ExplorerFeedEntry,
  type ExplorerLens,
  emptyFeedMessage,
  explorerPeekParam,
  feedCountLabel,
  feedDescription,
  feedSectionTitle,
  groupFeedByDay,
  parseExplorerPeekParam,
} from "@pdpp/operator-ui/components/views/explorer-utils";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";

const NO_CONNECTION_TOKEN = "~";

test("buildExplorerHref preserves repeated connection params (no collapse)", () => {
  const href = buildExplorerHref(dashboardRoutes, {
    query: "payroll",
    connectionIds: ["gmail-personal", "gmail-work"],
    streams: ["messages"],
  });
  const url = new URL(href, "https://example.test");
  assert.equal(url.pathname, "/explore");
  assert.equal(url.searchParams.get("q"), "payroll");
  assert.deepEqual(url.searchParams.getAll("connection"), ["gmail-personal", "gmail-work"]);
  assert.deepEqual(url.searchParams.getAll("stream"), ["messages"]);
});

test("buildExplorerHref returns the bare path when nothing is set", () => {
  const href = buildExplorerHref(dashboardRoutes, {});
  assert.equal(href, "/explore");
});

// U1 — canonical-default URL lock (THE-LENS Gate 1: "the default 'All' view is the BARE
// canonical path with NO query params; defaults are never serialized"). This forbids the
// param-injection anti-pattern (e.g. `?lens=recent` / `?sort=newest`) that would create a
// second representation of "All" and break isAllView. See honesty-copy/design.md §2, U1.
test("U1: the default Explore view emits the bare canonical path with NO querystring", () => {
  const href = buildExplorerHref(dashboardRoutes, {});
  assert.equal(href, dashboardRoutes.section.explore, "default href must equal the canonical section route");
  assert.ok(!href.includes("?"), `default href must carry no querystring, got "${href}"`);
});

test("buildExplorerHref carries the date window when set", () => {
  const href = buildExplorerHref(dashboardRoutes, {
    since: "2026-05-21",
    until: "2026-05-28",
  });
  const url = new URL(href, "https://example.test");
  assert.equal(url.pathname, "/explore");
  assert.equal(url.searchParams.get("since"), "2026-05-21");
  assert.equal(url.searchParams.get("until"), "2026-05-28");
});

test("buildExplorerHref preserves date window alongside chip + query state", () => {
  const href = buildExplorerHref(dashboardRoutes, {
    query: "invoice",
    connectionIds: ["gmail-personal"],
    streams: ["messages"],
    since: "2026-05-21",
    until: "2026-05-28",
  });
  const url = new URL(href, "https://example.test");
  assert.equal(url.searchParams.get("q"), "invoice");
  assert.deepEqual(url.searchParams.getAll("connection"), ["gmail-personal"]);
  assert.deepEqual(url.searchParams.getAll("stream"), ["messages"]);
  assert.equal(url.searchParams.get("since"), "2026-05-21");
  assert.equal(url.searchParams.get("until"), "2026-05-28");
});

test("buildExplorerHref omits empty date params", () => {
  const href = buildExplorerHref(dashboardRoutes, { since: "", until: "" });
  assert.equal(href, "/explore");
});

test("explorerPeekParam round-trips a concrete connection_id when known", () => {
  const entry = {
    connectorId: "gmail",
    connectionId: "conn-personal",
    stream: "messages",
    recordId: "ABC123",
  };
  const raw = explorerPeekParam(entry);
  assert.equal(raw, "gmail::conn-personal::messages::ABC123");
  const parsed = parseExplorerPeekParam(raw);
  assert.deepEqual(parsed, entry);
});

test("explorerPeekParam encodes the no-connection sentinel when unknown", () => {
  const entry = { connectorId: "gmail", connectionId: null, stream: "messages", recordId: "ABC123" };
  const raw = explorerPeekParam(entry);
  assert.equal(raw, `gmail::${NO_CONNECTION_TOKEN}::messages::ABC123`);
  const parsed = parseExplorerPeekParam(raw);
  assert.deepEqual(parsed, entry);
});

test("explorerPeekParam keeps two same-connector connections distinct in the URL", () => {
  // Regression: previously the peek param was `connectorId::stream::recordId`,
  // so two Gmail connections viewing the same logical record id collided.
  const a = explorerPeekParam({
    connectorId: "gmail",
    connectionId: "conn-personal",
    stream: "messages",
    recordId: "ABC123",
  });
  const b = explorerPeekParam({
    connectorId: "gmail",
    connectionId: "conn-work",
    stream: "messages",
    recordId: "ABC123",
  });
  assert.notEqual(a, b);
});

test("parseExplorerPeekParam rejects malformed strings", () => {
  assert.equal(parseExplorerPeekParam(undefined), null);
  assert.equal(parseExplorerPeekParam(""), null);
  assert.equal(parseExplorerPeekParam("only-two::parts"), null);
  assert.equal(parseExplorerPeekParam("a::b::c"), null); // 3 parts now invalid
  assert.equal(parseExplorerPeekParam("a::b::c::"), null);
  assert.equal(parseExplorerPeekParam("::b::c::d"), null);
});

test("explorerPeekParam round-trips record ids containing the ':: ' separator", () => {
  // Regression: a raw `::` join collides with any id that legitimately
  // contains `::`, so a record id like `thread::42` would parse as five
  // parts and be rejected, or worse, silently split mid-id.
  const entry = {
    connectorId: "imap",
    connectionId: "conn-personal",
    stream: "threads",
    recordId: "thread::42",
  };
  const raw = explorerPeekParam(entry);
  assert.deepEqual(parseExplorerPeekParam(raw), entry);
});

test("explorerPeekParam round-trips ids containing /, #, and spaces", () => {
  const entry = {
    connectorId: "github",
    connectionId: "owner/repo#42",
    stream: "issues/comments",
    recordId: "comment id with spaces",
  };
  const raw = explorerPeekParam(entry);
  assert.deepEqual(parseExplorerPeekParam(raw), entry);
});

test("explorerPeekParam round-trips a stream containing the separator", () => {
  const entry = {
    connectorId: "custom",
    connectionId: "conn-a",
    stream: "ns::events",
    recordId: "rec-1",
  };
  const raw = explorerPeekParam(entry);
  assert.deepEqual(parseExplorerPeekParam(raw), entry);
});

test("explorerPeekParam round-trips a connection id containing the separator", () => {
  const entry = {
    connectorId: "gmail",
    connectionId: "tenant::user",
    stream: "messages",
    recordId: "ABC123",
  };
  const raw = explorerPeekParam(entry);
  assert.deepEqual(parseExplorerPeekParam(raw), entry);
});

function fakeEntry(displayAt: string, recordId: string): ExplorerFeedEntry {
  return {
    connectorId: "gmail",
    connectionId: "conn-personal",
    connectionDisplayName: "Personal Gmail",
    stream: "messages",
    recordId,
    emittedAt: displayAt,
    displayAt,
    displayIsSemantic: false,
  };
}

test("groupFeedByDay buckets entries by ISO date and preserves order", () => {
  const groups = groupFeedByDay([
    fakeEntry("2026-05-28T14:30:00Z", "r1"),
    fakeEntry("2026-05-28T08:15:00Z", "r2"),
    fakeEntry("2026-05-27T22:00:00Z", "r3"),
    fakeEntry("2026-05-25T05:00:00Z", "r4"),
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((g) => g.day),
    ["2026-05-28", "2026-05-27", "2026-05-25"]
  );
  assert.deepEqual(
    groups[0]?.entries.map((e) => e.recordId),
    ["r1", "r2"]
  );
  assert.equal(groups[1]?.entries.length, 1);
  assert.equal(groups[2]?.entries.length, 1);
});

test("groupFeedByDay does not collapse non-adjacent days into one group", () => {
  // Page-level ordering must be preserved: an entry that lands between two
  // same-day entries (because of an interleaved second day) must start a
  // fresh group rather than merging back into an earlier one.
  const groups = groupFeedByDay([
    fakeEntry("2026-05-28T14:00:00Z", "r1"),
    fakeEntry("2026-05-27T14:00:00Z", "r2"),
    fakeEntry("2026-05-28T08:00:00Z", "r3"),
  ]);
  assert.deepEqual(
    groups.map((g) => g.day),
    ["2026-05-28", "2026-05-27", "2026-05-28"]
  );
});

test("groupFeedByDay labels missing dates as Undated", () => {
  const groups = groupFeedByDay([fakeEntry("", "r1"), fakeEntry("not-a-date", "r2")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.day, "");
  assert.equal(groups[0]?.label, "Undated");
  assert.equal(groups[0]?.entries.length, 2);
});

test("groupFeedByDay renders a stable, locale-pinned day label", () => {
  const groups = groupFeedByDay([fakeEntry("2026-05-28T14:30:00Z", "r1")]);
  // en-US, UTC: "Thu, May 28, 2026". Locale and timeZone are pinned so SSR
  // and client agree.
  assert.equal(groups[0]?.label, "Thu, May 28, 2026");
});

const NOW_MS = Date.parse("2026-05-28T12:00:00Z");

test("computeActivityStripCells produces a contiguous oldest→newest window", () => {
  const cells = computeActivityStripCells([], 30, NOW_MS);
  assert.equal(cells.length, 30);
  // Oldest first, newest last; newest cell is the day containing `now`.
  assert.equal(cells[0]?.day, "2026-04-29");
  assert.equal(cells.at(-1)?.day, "2026-05-28");
  assert.equal(cells.at(-1)?.isToday, true);
  assert.equal(cells[0]?.isToday, false);
});

test("computeActivityStripCells counts entries by ISO day with zeros for missing days", () => {
  const cells = computeActivityStripCells(
    [
      fakeEntry("2026-05-28T14:00:00Z", "r1"),
      fakeEntry("2026-05-28T08:00:00Z", "r2"),
      fakeEntry("2026-05-27T22:00:00Z", "r3"),
      // Outside window — must not leak into the strip.
      fakeEntry("2026-04-01T00:00:00Z", "rOld"),
    ],
    30,
    NOW_MS
  );
  const byDay = new Map(cells.map((c) => [c.day, c.count]));
  assert.equal(byDay.get("2026-05-28"), 2);
  assert.equal(byDay.get("2026-05-27"), 1);
  assert.equal(byDay.get("2026-05-26"), 0);
  // The "2026-04-01" entry is outside the 30-day window and is dropped.
  assert.equal(byDay.has("2026-04-01"), false);
});

test("computeActivityStripCells ignores entries with missing or unparseable dates", () => {
  const cells = computeActivityStripCells(
    [fakeEntry("", "r1"), fakeEntry("not-a-date", "r2"), fakeEntry("2026-05-28T00:00:00Z", "r3")],
    7,
    NOW_MS
  );
  const total = cells.reduce((sum, c) => sum + c.count, 0);
  assert.equal(total, 1);
});

test("feedSectionTitle returns lens-appropriate section headings", () => {
  assert.equal(feedSectionTitle("recent"), "Recent records");
  assert.equal(feedSectionTitle("time_range"), "Records in range");
  assert.equal(feedSectionTitle("search"), "Search results");
  assert.equal(feedSectionTitle("search_with_ignored_time_window"), "Search results");
});

const ALL_LENSES: ExplorerLens[] = ["recent", "search", "time_range", "search_with_ignored_time_window"];

test("emptyFeedMessage returns a non-empty string for every defined lens", () => {
  for (const lens of ALL_LENSES) {
    const msg = emptyFeedMessage(lens);
    assert.ok(msg.length > 0, `emptyFeedMessage("${lens}") returned empty string`);
  }
});

test("emptyFeedMessage returns distinct copy for each lens family", () => {
  assert.notEqual(emptyFeedMessage("recent"), emptyFeedMessage("search"));
  assert.notEqual(emptyFeedMessage("recent"), emptyFeedMessage("time_range"));
  assert.equal(emptyFeedMessage("search"), emptyFeedMessage("search_with_ignored_time_window"));
});

// Honesty-copy lock (THE-LENS Gate 1 / Part 0 "AI-slop copy"): owner-facing feed copy
// carries ZERO engine vocabulary. Asserted against the RENDERED string outputs only —
// never whole-source, which would false-positive on the retained `retrievalMode` type
// and the data-field use that gates the match excerpt. "retrieval" is deliberately NOT
// in this regex (it survives in code comments/identifiers); the badge-render absence is
// guarded by source-regex in page.invariants.test.ts instead.
const ENGINE_VOCAB_RE = /hybrid|lexical|semantic|embedding|BM25|deduplicat|consent-time/i;
const BEST_MATCHES_COPY_RE = /best matches/;
const DATE_RANGE_NOT_APPLIED_COPY_RE = /date range isn't applied|date range is not applied/;
const EXCLUSION_COPY_RE = /aren't shown|not shown|excluded/;
const NEWEST_FIRST_COPY_RE = /newest first/;
const SEARCH_COMPLETENESS_CLAIM_RE = /newest first|\ball\b|complete/;
const SENTENCE_CASE_COPY_RE = /^[A-Z].*\.$/;

test("feedDescription returns a non-empty, human, engine-vocabulary-free string for every lens", () => {
  for (const lens of ALL_LENSES) {
    const desc = feedDescription(lens);
    assert.ok(desc.length > 0, `feedDescription("${lens}") returned empty string`);
    assert.doesNotMatch(desc, ENGINE_VOCAB_RE, `feedDescription("${lens}") leaks engine vocabulary: "${desc}"`);
    // Sentence-case + real prose: starts uppercase, ends with a period.
    assert.match(desc, SENTENCE_CASE_COPY_RE, `feedDescription("${lens}") is not a sentence-case sentence: "${desc}"`);
  }
});

test("feedDescription search copy claims relevance/best-matches, never ordering or completeness", () => {
  // The relevance-bounded set cannot page to the end and is not time-ordered: its copy
  // must say "best matches" and must NOT claim "newest first" / "all" / "complete".
  for (const lens of ["search", "search_with_ignored_time_window"] as const) {
    const desc = feedDescription(lens);
    assert.match(
      desc.toLowerCase(),
      BEST_MATCHES_COPY_RE,
      `search copy ("${lens}") must say "best matches": "${desc}"`
    );
    assert.doesNotMatch(
      desc.toLowerCase(),
      SEARCH_COMPLETENESS_CLAIM_RE,
      `search copy ("${lens}") must not claim ordering/completeness: "${desc}"`
    );
  }
});

test("feedDescription search_with_ignored_time_window preserves the date-range-not-applied caveat", () => {
  // The boundary fact is owner-actionable ("clear the search") and must survive the rewrite.
  const desc = feedDescription("search_with_ignored_time_window").toLowerCase();
  assert.match(desc, DATE_RANGE_NOT_APPLIED_COPY_RE, `time-window caveat lost: "${desc}"`);
});

test("feedDescription time-ordered lenses may say newest first; the exclusion caveat survives", () => {
  // recent + time_range ARE chronological, so "newest first" is honest there.
  assert.match(feedDescription("recent").toLowerCase(), NEWEST_FIRST_COPY_RE);
  const timeRange = feedDescription("time_range");
  assert.match(timeRange.toLowerCase(), NEWEST_FIRST_COPY_RE);
  // time_range still tells the owner sources without a time field are excluded.
  assert.match(timeRange.toLowerCase(), EXCLUSION_COPY_RE, `time_range exclusion caveat lost: "${timeRange}"`);
});

test("feedCountLabel formats counts with locale separators and singular grammar", () => {
  assert.equal(feedCountLabel(0, false, false), "0 records");
  assert.equal(feedCountLabel(1, false, false), "1 record");
  assert.equal(feedCountLabel(1, true, false), "1 match");
  assert.equal(feedCountLabel(50, false, true), "50+ records");
  assert.equal(feedCountLabel(12, true, false), "12 matches");
  assert.equal(feedCountLabel(7, true, true), "7+ matches");
});
