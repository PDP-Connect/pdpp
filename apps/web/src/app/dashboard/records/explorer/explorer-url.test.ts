import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExplorerHref,
  explorerPeekParam,
  parseExplorerPeekParam,
} from "../../components/views/records-explorer-view.tsx";
import { dashboardRoutes } from "../../components/views/routes.ts";

test("buildExplorerHref preserves repeated connection params (no collapse)", () => {
  const href = buildExplorerHref(dashboardRoutes, {
    query: "payroll",
    connectionIds: ["gmail-personal", "gmail-work"],
    streams: ["messages"],
  });
  const url = new URL(href, "https://example.test");
  assert.equal(url.pathname, "/dashboard/records/explorer");
  assert.equal(url.searchParams.get("q"), "payroll");
  assert.deepEqual(url.searchParams.getAll("connection"), ["gmail-personal", "gmail-work"]);
  assert.deepEqual(url.searchParams.getAll("stream"), ["messages"]);
});

test("buildExplorerHref returns the bare path when nothing is set", () => {
  const href = buildExplorerHref(dashboardRoutes, {});
  assert.equal(href, "/dashboard/records/explorer");
});

test("explorerPeekParam round-trips connector/stream/record-id", () => {
  const entry = { connectorId: "gmail", stream: "messages", recordId: "ABC123" };
  const raw = explorerPeekParam(entry);
  assert.equal(raw, "gmail::messages::ABC123");
  const parsed = parseExplorerPeekParam(raw);
  assert.deepEqual(parsed, entry);
});

test("parseExplorerPeekParam rejects malformed strings", () => {
  assert.equal(parseExplorerPeekParam(undefined), null);
  assert.equal(parseExplorerPeekParam(""), null);
  assert.equal(parseExplorerPeekParam("only-two::parts"), null);
  assert.equal(parseExplorerPeekParam("a::b::"), null);
  assert.equal(parseExplorerPeekParam("::stream::id"), null);
});
