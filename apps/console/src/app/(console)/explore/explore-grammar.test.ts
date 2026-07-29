// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompiledQuery,
  chipTokens,
  hasClientSideTokens,
  isDateOperatorToken,
  liftDateTokens,
  liftFacetTokens,
  parseQuery,
  removeToken,
} from "./explore-grammar.ts";

// Top-level regex constants (ultracite useTopLevelRegex).
const GET_RECORDS_RE = /^GET \/v1\/records\?/;
const NOT_IN_YNAB_RE = /not in ynab/;
const CONNECTION_GMAIL_RE = /connection=gmail/;
const STREAM_MESSAGES_RE = /stream=messages/;
const MATCH_COFFEE_RE = /match=coffee/;
const ORDER_NEWEST_RE = /order=newest/;
const LIMIT_50_RE = /limit=50/;
const CLIENT_IMAGE_RE = /# client-side: .*content_type=image\/\*/;
const MERCHANT_TILDE_RE = /merchant~coffee/;
const FILTER_MERCHANT_RE = /filter\[merchant\]=coffee/;
const CONTENT_OR_TILDE_RE = /content_type|merchant~/;
const FILTER_MERCHANT_BEFORE_MARKER_RE = /filter\[merchant\]=coffee/;
const CONNECTION_ABC_RE = /connection=conn_abc/;
const STREAM_TX_RE = /stream=transactions/;
const SINCE_RE = /since=2026-06-10/;
const UNTIL_RE = /until=2026-06-11/;
const ORDER_OLDEST_RE = /order=oldest/;
const CLIENT_SIDE_RE = /# client-side/;

test("parseQuery splits server tokens, client tokens, and bare text", () => {
  const p = parseQuery(
    "con:gmail stream:messages role:assistant has:image is:folded merchant:coffee after:2026-06-01 hello world"
  );
  assert.equal(p.con, "gmail");
  assert.equal(p.stream, "messages");
  assert.equal(p.role, "assistant");
  assert.equal(p.hasImage, true);
  assert.equal(p.folded, true);
  assert.equal(p.after, "2026-06-01");
  assert.deepEqual(p.fields, [{ key: "merchant", value: "coffee" }]);
  assert.deepEqual(p.text, ["hello", "world"]);
  assert.equal(p.tokens.length, 9);
});

test("parseQuery maps before/after to the right slots", () => {
  const p = parseQuery("before:2026-06-11 after:2026-06-10");
  assert.equal(p.before, "2026-06-11");
  assert.equal(p.after, "2026-06-10");
});

// ─── Slice 2: negation (-con:/-stream:) → EXCLUDE slots ───────────────────────

test("parseQuery routes -con:/-stream: into the EXCLUDE slots (Gmail/Stripe negation)", () => {
  const p = parseQuery("-con:ynab -stream:budget_months coffee");
  // Negated tokens populate the exclude slots, NOT the include ones.
  assert.equal(p.conNot, "ynab");
  assert.equal(p.streamNot, "budget_months");
  assert.equal(p.con, null);
  assert.equal(p.stream, null);
  assert.deepEqual(p.text, ["coffee"]);
  // The chip bar still sees the raw token so it can be removed exactly.
  assert.ok(p.tokens.some((t) => t.raw === "-con:ynab" && NOT_IN_YNAB_RE.test(t.label)));
  assert.ok(p.tokens.some((t) => t.raw === "-stream:budget_months"));
});

test("parseQuery: positive con:/stream: stay in the INCLUDE slots", () => {
  const p = parseQuery("con:ynab stream:transactions");
  assert.equal(p.con, "ynab");
  assert.equal(p.stream, "transactions");
  assert.equal(p.conNot, null);
  assert.equal(p.streamNot, null);
});

const CONNECTION_NOT_YNAB_RE = /connection!=ynab/;
const STREAM_NOT_BUDGET_RE = /stream!=budget_months/;

test("CHIP == OPERATOR for exclusion: the facet 'is not' and -con: compile to the SAME query", () => {
  // Typing the operator -con:ynab:
  const viaOperator = buildCompiledQuery({
    limit: 50,
    order: "newest",
    parsed: parseQuery("-con:ynab"),
    selectedConnectionIds: [],
    selectedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
  });
  // Clicking the "is not" chip for the same connection (excludedConnectionIds):
  const viaChip = buildCompiledQuery({
    excludedConnectionIds: ["ynab"],
    excludedStreams: [],
    limit: 50,
    order: "newest",
    parsed: parseQuery(""),
    selectedConnectionIds: [],
    selectedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
  });
  // Both produce the identical exclusion param (chip == operator).
  assert.match(viaOperator, CONNECTION_NOT_YNAB_RE);
  assert.match(viaChip, CONNECTION_NOT_YNAB_RE);
  assert.equal(viaOperator, viaChip, "the 'is not' chip and the -con: operator must compile to the identical query");
});

// ─── liftFacetTokens: the typed operator becomes the same facet state as a chip ──

test("liftFacetTokens pulls con:/-con:/stream:/-stream: into facet lists and keeps the rest", () => {
  const lift = liftFacetTokens("con:chase -con:ynab stream:orders -stream:budget_months coffee has:image");
  assert.deepEqual(lift.includeConnections, ["chase"]);
  assert.deepEqual(lift.excludeConnections, ["ynab"]);
  assert.deepEqual(lift.includeStreams, ["orders"]);
  assert.deepEqual(lift.excludeStreams, ["budget_months"]);
  // Free text and non-facet operators stay in the residual query.
  assert.equal(lift.rest, "coffee has:image");
});

test("liftFacetTokens leaves a query with no con/stream tokens untouched", () => {
  const lift = liftFacetTokens("coffee has:image before:2026-06-11");
  assert.equal(lift.rest, "coffee has:image before:2026-06-11");
  assert.deepEqual(lift.includeConnections, []);
  assert.deepEqual(lift.excludeConnections, []);
});

// ─── liftDateTokens: a typed before:/after: becomes the ONE canonical Date window ──

test("liftDateTokens pulls before:/after: into the date window and keeps the rest", () => {
  const lift = liftDateTokens("after:2026-01-01 before:2026-02-01 coffee con:chase");
  assert.equal(lift.after, "2026-01-01");
  assert.equal(lift.before, "2026-02-01");
  // Free text and non-date operators stay in the residual query (no second date chip).
  assert.equal(lift.rest, "coffee con:chase");
});

test("liftDateTokens leaves a query with no date tokens untouched", () => {
  const lift = liftDateTokens("coffee con:chase has:image");
  assert.equal(lift.after, null);
  assert.equal(lift.before, null);
  assert.equal(lift.rest, "coffee con:chase has:image");
});

test("liftDateTokens: last-write-wins on a repeated operator (no stacking)", () => {
  // Typing after:X then after:Y must REPLACE since, not stack two date windows.
  const lift = liftDateTokens("after:2026-01-01 after:2026-03-01");
  assert.equal(lift.after, "2026-03-01");
  assert.equal(lift.rest, "");
});

test("buildCompiledQuery renders excluded streams as stream!= (chip == -stream: operator)", () => {
  const viaOperator = buildCompiledQuery({
    limit: 50,
    order: "newest",
    parsed: parseQuery("-stream:budget_months"),
    selectedConnectionIds: [],
    selectedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
  });
  const viaChip = buildCompiledQuery({
    excludedStreams: ["budget_months"],
    limit: 50,
    order: "newest",
    parsed: parseQuery(""),
    selectedConnectionIds: [],
    selectedStreams: [],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
  });
  assert.match(viaOperator, STREAM_NOT_BUDGET_RE);
  assert.match(viaChip, STREAM_NOT_BUDGET_RE);
  assert.equal(viaOperator, viaChip);
});

test("removeToken drops exactly one whitespace-delimited token", () => {
  assert.equal(removeToken("con:gmail merchant:coffee hello", "merchant:coffee"), "con:gmail hello");
});

test("hasClientSideTokens is true only for server-inexpressible operators", () => {
  assert.equal(hasClientSideTokens(parseQuery("con:gmail stream:messages before:2026-06-11 plain")), false);
  assert.equal(hasClientSideTokens(parseQuery("has:image")), true);
  assert.equal(hasClientSideTokens(parseQuery("merchant:coffee")), true);
  assert.equal(hasClientSideTokens(parseQuery("role:assistant")), true);
});

test("hasClientSideTokens treats a declared exact-filterable field as server-side", () => {
  // merchant is declared exact-filterable → server filter[], NOT client-side.
  assert.equal(hasClientSideTokens(parseQuery("merchant:coffee"), new Set(["merchant"])), false);
  // an undeclared field stays client-side even when others are declared.
  assert.equal(hasClientSideTokens(parseQuery("note:urgent"), new Set(["merchant"])), true);
});

test("buildCompiledQuery renders server params plainly and undeclared field tokens behind a comment", () => {
  const line = buildCompiledQuery({
    limit: 50,
    order: "newest",
    parsed: parseQuery("con:gmail stream:messages has:image merchant:coffee coffee"),
    selectedConnectionIds: [],
    selectedStreams: [],
    // No declared exact-filterable fields → merchant:coffee stays client-side.
    serverFilterableFields: new Set(),
    since: "",
    until: "",
  });
  assert.match(line, GET_RECORDS_RE);
  assert.match(line, CONNECTION_GMAIL_RE);
  assert.match(line, STREAM_MESSAGES_RE);
  assert.match(line, MATCH_COFFEE_RE);
  assert.match(line, ORDER_NEWEST_RE);
  assert.match(line, LIMIT_50_RE);
  // Client-only operators must appear ONLY behind the honesty marker.
  assert.match(line, CLIENT_IMAGE_RE);
  assert.match(line, MERCHANT_TILDE_RE);
  // and never as a real server param before the marker.
  const [serverPart] = line.split("# client-side:");
  assert.doesNotMatch(serverPart ?? "", CONTENT_OR_TILDE_RE);
});

test("buildCompiledQuery promotes a declared exact-filterable field:value to a server filter[] param", () => {
  const line = buildCompiledQuery({
    limit: 50,
    order: "newest",
    parsed: parseQuery("merchant:coffee has:image"),
    selectedConnectionIds: [],
    selectedStreams: [],
    // merchant is declared exact-filterable → real server filter[].
    serverFilterableFields: new Set(["merchant"]),
    since: "",
    until: "",
  });
  // merchant:coffee renders as a real server param in the server section.
  const [serverPart] = line.split("# client-side:");
  assert.match(serverPart ?? "", FILTER_MERCHANT_BEFORE_MARKER_RE);
  // It must NOT appear behind the client-side marker as a tilde fuzzy match.
  assert.doesNotMatch(line, MERCHANT_TILDE_RE);
  // has:image is still genuinely client-side and stays behind the marker.
  assert.match(line, CLIENT_IMAGE_RE);
  // Sanity: filter[] is present somewhere in the line.
  assert.match(line, FILTER_MERCHANT_RE);
});

test("buildCompiledQuery prefers facet-selected ids and maps before/after to since/until", () => {
  const line = buildCompiledQuery({
    limit: 50,
    order: "oldest",
    parsed: parseQuery("before:2026-06-11 after:2026-06-10"),
    selectedConnectionIds: ["conn_abc"],
    selectedStreams: ["transactions"],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
  });
  assert.match(line, CONNECTION_ABC_RE);
  assert.match(line, STREAM_TX_RE);
  assert.match(line, SINCE_RE);
  assert.match(line, UNTIL_RE);
  assert.match(line, ORDER_OLDEST_RE);
  // No client-side comment when every token is server-expressible.
  assert.doesNotMatch(line, CLIENT_SIDE_RE);
});

// ─── chipTokens — the chip strip NEVER renders a date operator (THE-LENS Gate 1) ──
// The dedicated Date chip is the ONE canonical render of the active window. A date
// operator that survives into the chip strip (URL-direct / shared-link / reload, before
// the mount-time normalizer redirects) is a SECOND date representation that lies about
// the window — the Part-0 double-representation defect. `chipTokens` is the predicate
// the canvas feeds `buildFilterChips`, so testing it pins the chip set directly.

test("isDateOperatorToken: true for before:/after:, false for everything else", () => {
  assert.equal(isDateOperatorToken("after:2026-01-01"), true);
  assert.equal(isDateOperatorToken("before:2026-12-31"), true);
  // Tolerate the negated forms (no defined negation, still date-owned) so neither leaks.
  assert.equal(isDateOperatorToken("-after:2026-01-01"), true);
  assert.equal(isDateOperatorToken("-before:2026-12-31"), true);
  // Non-date operators and free text are NOT date operators (they keep their chips).
  assert.equal(isDateOperatorToken("con:gmail"), false);
  assert.equal(isDateOperatorToken("stream:messages"), false);
  assert.equal(isDateOperatorToken("has:image"), false);
  assert.equal(isDateOperatorToken("coffee"), false);
});

test("THE REGRESSION: a URL-direct ?q=after:2026-01-01 produces NO date token chip", () => {
  // Exactly the bug: a record-set arrives with data.query = "after:2026-01-01" (URL-direct
  // / shared link / reload). committedParsed = parseQuery(data.query) yields one token.
  const committed = parseQuery("after:2026-01-01");
  // Before the fix, buildFilterChips rendered this token as a SEPARATE chip beside an
  // "Any time" Date chip. The chip strip now derives from chipTokens, which drops it.
  const forChips = chipTokens(committed.tokens);
  assert.equal(forChips.length, 0, "no date operator may survive into the chip strip");
  assert.equal(
    forChips.some((t) => t.raw.startsWith("after:") || t.raw.startsWith("before:")),
    false
  );
});

test("chipTokens drops date operators but KEEPS every other token (con/stream/text)", () => {
  // A mixed URL-direct query: facet + free text + BOTH date endpoints.
  const committed = parseQuery("con:gmail after:2026-01-01 coffee before:2026-12-31");
  const forChips = chipTokens(committed.tokens);
  const rawSet = forChips.map((t) => t.raw);
  // Date endpoints are gone…
  assert.equal(
    rawSet.some((r) => r.startsWith("after:") || r.startsWith("before:")),
    false
  );
  // …but the source operator and the free-text term are untouched (still chip-rendered).
  assert.deepEqual(rawSet, ["con:gmail", "coffee"]);
});

test("chipTokens is a no-op when there are no date operators", () => {
  const committed = parseQuery("con:gmail stream:messages coffee");
  assert.deepEqual(chipTokens(committed.tokens), committed.tokens);
});
