import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExplorerHref,
  explorerPeekParam,
  parseExplorerPeekParam,
} from "../../components/views/records-explorer-view.tsx";
import { dashboardRoutes } from "../../components/views/routes.ts";

const NO_CONNECTION_TOKEN = "~";

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
