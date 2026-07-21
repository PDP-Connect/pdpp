/**
 * W4 — facet rail ↔ filter/operator UNIFICATION round-trip.
 *
 * The rail and the `con:`/`stream:` operator language are ONE state, two
 * surfaces: a facet click writes the canonical chip/operator, and editing the
 * query reselects the rail. These tests pin that round-trip at the pure layer
 * the component routes through (`buildCompiledQuery` = the canonical compiled
 * query both a chip and a typed operator produce; `liftFacetTokens` = the typed
 * operator lifted back into the facet include/exclude selection the rail shows).
 *
 * They also pin the W4 honesty bar on the source-grouped facets: per-source
 * loaded counts never duplicate/misattribute across sources, and the count KIND
 * the rail shows is loaded-window scoped (RL2/RL3).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExplorerConnectionFacet, ExplorerFeedEntry } from "@pdpp/operator-ui/components/views/explorer-utils";
import { computeSourceGroupedStreamFacets } from "./explore-facet-groups.ts";
import { buildCompiledQuery, liftFacetTokens, parseQuery } from "./explore-grammar.ts";

const CONNECTION_GMAIL_RE = /connection=gmail/;
const STREAM_MESSAGES_RE = /stream=messages/;
const CONNECTION_NOT_GMAIL_RE = /connection!=gmail/;
const STREAM_NOT_MESSAGES_RE = /stream!=messages/;

// ── INCLUDE round-trip: facet click == typed operator (con:) ──

test("clicking a SOURCE facet and typing con: compile to the IDENTICAL query (chip == operator)", () => {
  // Rail click → selectedConnectionIds: ["gmail"].
  const viaFacet = buildCompiledQuery({
    parsed: parseQuery(""),
    selectedConnectionIds: ["gmail"],
    selectedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
  });
  // Typed operator → con:gmail.
  const viaOperator = buildCompiledQuery({
    parsed: parseQuery("con:gmail"),
    selectedConnectionIds: [],
    selectedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
  });
  assert.match(viaFacet, CONNECTION_GMAIL_RE);
  assert.match(viaOperator, CONNECTION_GMAIL_RE);
  assert.equal(viaFacet, viaOperator, "a source facet click and con: must be the same canonical query");
});

test("clicking a STREAM facet and typing stream: compile to the IDENTICAL query (chip == operator)", () => {
  const viaFacet = buildCompiledQuery({
    parsed: parseQuery(""),
    selectedConnectionIds: [],
    selectedStreams: ["messages"],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
  });
  const viaOperator = buildCompiledQuery({
    parsed: parseQuery("stream:messages"),
    selectedConnectionIds: [],
    selectedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
  });
  assert.match(viaFacet, STREAM_MESSAGES_RE);
  assert.match(viaOperator, STREAM_MESSAGES_RE);
  assert.equal(viaFacet, viaOperator, "a stream facet click and stream: must be the same canonical query");
});

// ── Query edit → rail reselect: liftFacetTokens reselects the facet state ──

test("editing the query to add con:/stream: reselects the rail (operator → facet include state)", () => {
  const lift = liftFacetTokens("con:gmail stream:messages coffee");
  // The rail's include selection is exactly what the typed operators name.
  assert.deepEqual(lift.includeConnections, ["gmail"]);
  assert.deepEqual(lift.includeStreams, ["messages"]);
  // Free text survives so editing the operator does not lose the search.
  assert.equal(lift.rest, "coffee");
});

test("removing a con:/stream: token from the query deselects the rail (no lifted facet remains)", () => {
  // After the owner deletes the operators, nothing lifts → rail has no selection.
  const lift = liftFacetTokens("coffee");
  assert.deepEqual(lift.includeConnections, []);
  assert.deepEqual(lift.includeStreams, []);
  assert.deepEqual(lift.excludeConnections, []);
  assert.deepEqual(lift.excludeStreams, []);
});

// ── INVERSION: the "is not" facet writes the flipped -con:/-stream: operator ──

test("the 'is not' SOURCE toggle and -con: compile to the same exclusion (inversion == flipped operator)", () => {
  const viaFacet = buildCompiledQuery({
    parsed: parseQuery(""),
    selectedConnectionIds: [],
    selectedStreams: [],
    excludedConnectionIds: ["gmail"],
    excludedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
  });
  const viaOperator = buildCompiledQuery({
    parsed: parseQuery("-con:gmail"),
    selectedConnectionIds: [],
    selectedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
  });
  assert.match(viaFacet, CONNECTION_NOT_GMAIL_RE);
  assert.match(viaOperator, CONNECTION_NOT_GMAIL_RE);
  assert.equal(viaFacet, viaOperator, "facet 'is not' == -con: (one flipped operator, not a separate control)");
});

test("the 'is not' STREAM toggle and -stream: compile to the same exclusion", () => {
  const viaFacet = buildCompiledQuery({
    parsed: parseQuery(""),
    selectedConnectionIds: [],
    selectedStreams: [],
    excludedStreams: ["messages"],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
  });
  const viaOperator = buildCompiledQuery({
    parsed: parseQuery("-stream:messages"),
    selectedConnectionIds: [],
    selectedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
  });
  assert.match(viaFacet, STREAM_NOT_MESSAGES_RE);
  assert.match(viaOperator, STREAM_NOT_MESSAGES_RE);
  assert.equal(viaFacet, viaOperator, "facet stream 'is not' == -stream:");
});

test("typing -con:/-stream: reselects the rail's EXCLUDE state (operator → facet exclude)", () => {
  const lift = liftFacetTokens("-con:gmail -stream:messages");
  assert.deepEqual(lift.excludeConnections, ["gmail"]);
  assert.deepEqual(lift.excludeStreams, ["messages"]);
  assert.deepEqual(lift.includeConnections, []);
  assert.deepEqual(lift.includeStreams, []);
});

// ── GROUPED facets: counts never duplicate/misattribute across sources ──

const ALL: (e: ExplorerFeedEntry) => boolean = () => true;

function con(
  connectionId: string,
  connectorId: string,
  displayName: string,
  streams: string[]
): ExplorerConnectionFacet {
  return { connectionId, connectorId, displayName, streams };
}
function entry(connectionId: string, stream: string, id: string): ExplorerFeedEntry {
  return {
    connectionDisplayName: null,
    connectionId,
    connectorId: stream,
    displayAt: "2026-06-22T00:00:00.000Z",
    displayIsSemantic: false,
    emittedAt: "2026-06-22T00:00:00.000Z",
    recordId: id,
    stream,
  };
}

test("a stream owned by two sources shows source A's loaded count under A and source B's under B (no misattribution)", () => {
  const A = con("conn_a", "gmail", "Gmail — A", ["messages"]);
  const B = con("conn_b", "outlook", "Outlook — B", ["messages"]);
  // 5 messages on A, 2 messages on B.
  const feed = [
    entry("conn_a", "messages", "a1"),
    entry("conn_a", "messages", "a2"),
    entry("conn_a", "messages", "a3"),
    entry("conn_a", "messages", "a4"),
    entry("conn_a", "messages", "a5"),
    entry("conn_b", "messages", "b1"),
    entry("conn_b", "messages", "b2"),
  ];
  const groups = computeSourceGroupedStreamFacets({
    feed,
    connections: [A, B],
    passes: ALL,
    selectedConnectionIds: [],
    selectedStreams: [],
    excludeStreams: [],
  });
  const a = groups.find((g) => g.connectionId === "conn_a");
  const b = groups.find((g) => g.connectionId === "conn_b");
  assert.equal(a?.streams.find((s) => s.stream === "messages")?.loadedCount, 5);
  assert.equal(b?.streams.find((s) => s.stream === "messages")?.loadedCount, 2);
  // Neither carries the OTHER source's number or a duplicated global 7.
  assert.notEqual(a?.streams.find((s) => s.stream === "messages")?.loadedCount, 7);
  assert.notEqual(b?.streams.find((s) => s.stream === "messages")?.loadedCount, 7);
});
