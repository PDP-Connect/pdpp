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
} from "../components/views/explorer-utils.ts";
import { dashboardRoutes } from "../components/views/routes.ts";

const NO_CONNECTION_TOKEN = "~";

test("buildExplorerHref preserves repeated connection params (no collapse)", () => {
  const href = buildExplorerHref(dashboardRoutes, {
    query: "payroll",
    connectionIds: ["gmail-personal", "gmail-work"],
    streams: ["messages"],
  });
  const url = new URL(href, "https://example.test");
  assert.equal(url.pathname, "/dashboard/explore");
  assert.equal(url.searchParams.get("q"), "payroll");
  assert.deepEqual(url.searchParams.getAll("connection"), ["gmail-personal", "gmail-work"]);
  assert.deepEqual(url.searchParams.getAll("stream"), ["messages"]);
});

test("buildExplorerHref returns the bare path when nothing is set", () => {
  const href = buildExplorerHref(dashboardRoutes, {});
  assert.equal(href, "/dashboard/explore");
});

test("buildExplorerHref carries the date window when set", () => {
  const href = buildExplorerHref(dashboardRoutes, {
    since: "2026-05-21",
    until: "2026-05-28",
  });
  const url = new URL(href, "https://example.test");
  assert.equal(url.pathname, "/dashboard/explore");
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
  assert.equal(href, "/dashboard/explore");
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
    summary: `summary ${recordId}`,
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

test("feedDescription returns a non-empty string for every lens × hybridUsed combination", () => {
  for (const lens of ALL_LENSES) {
    for (const hybrid of [true, false]) {
      const desc = feedDescription(lens, hybrid);
      assert.ok(desc.length > 0, `feedDescription("${lens}", ${hybrid}) returned empty string`);
    }
  }
});

test("feedDescription distinguishes hybrid from lexical for search lenses", () => {
  assert.notEqual(feedDescription("search", true), feedDescription("search", false));
  assert.notEqual(
    feedDescription("search_with_ignored_time_window", true),
    feedDescription("search_with_ignored_time_window", false)
  );
  // hybridUsed is irrelevant for non-search lenses
  assert.equal(feedDescription("recent", true), feedDescription("recent", false));
  assert.equal(feedDescription("time_range", true), feedDescription("time_range", false));
});

test("feedCountLabel formats counts with locale separators", () => {
  assert.equal(feedCountLabel(0, false, false), "0 records");
  assert.equal(feedCountLabel(1, false, false), "1 records");
  assert.equal(feedCountLabel(50, false, true), "50+ records");
  assert.equal(feedCountLabel(12, true, false), "12 matches");
  assert.equal(feedCountLabel(7, true, true), "7+ matches");
});
