import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExplorerHref,
  type ExplorerFeedEntry,
  explorerPeekParam,
  groupFeedByDay,
  parseExplorerPeekParam,
} from "../components/views/records-explorer-view.tsx";
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
