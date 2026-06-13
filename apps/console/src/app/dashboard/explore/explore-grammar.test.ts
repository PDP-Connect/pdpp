import assert from "node:assert/strict";
import test from "node:test";
import { buildCompiledQuery, hasClientSideTokens, parseQuery, removeToken } from "./explore-grammar.ts";

// Top-level regex constants (ultracite useTopLevelRegex).
const GET_RECORDS_RE = /^GET \/v1\/records\?/;
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
    parsed: parseQuery("con:gmail stream:messages has:image merchant:coffee coffee"),
    selectedConnectionIds: [],
    selectedStreams: [],
    // No declared exact-filterable fields → merchant:coffee stays client-side.
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
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
    parsed: parseQuery("merchant:coffee has:image"),
    selectedConnectionIds: [],
    selectedStreams: [],
    // merchant is declared exact-filterable → real server filter[].
    serverFilterableFields: new Set(["merchant"]),
    since: "",
    until: "",
    order: "newest",
    limit: 50,
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
    parsed: parseQuery("before:2026-06-11 after:2026-06-10"),
    selectedConnectionIds: ["conn_abc"],
    selectedStreams: ["transactions"],
    serverFilterableFields: new Set(),
    since: "",
    until: "",
    order: "oldest",
    limit: 50,
  });
  assert.match(line, CONNECTION_ABC_RE);
  assert.match(line, STREAM_TX_RE);
  assert.match(line, SINCE_RE);
  assert.match(line, UNTIL_RE);
  assert.match(line, ORDER_OLDEST_RE);
  // No client-side comment when every token is server-expressible.
  assert.doesNotMatch(line, CLIENT_SIDE_RE);
});
