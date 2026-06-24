/**
 * Slice 2 — unified query input pure logic (design.md §4).
 *
 * ONE input expresses text + chips + an id-jump (no second box). These tests pin:
 *   - a pasted exact id is DETECTED and offered as a jump WITHOUT a second box (#4);
 *   - typeahead chips are EQUIVALENT to the operator behind them (#5);
 *   - the chip menu narrows on the trailing fragment and stays bounded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendOperatorToken,
  buildTypeaheadSuggestions,
  detectRecordIdJump,
  trailingFragment,
} from "./explore-query-input.ts";

// ─── detectRecordIdJump: pasted id → jump affordance, never a 2nd box ─────────

test("detectRecordIdJump recognizes a pasted exact-record-id token", () => {
  assert.equal(detectRecordIdJump("cin_ynab_abc123ece4"), "cin_ynab_abc123ece4");
  assert.equal(detectRecordIdJump("  rec_8f2a91bd  "), "rec_8f2a91bd");
});

test("detectRecordIdJump returns null for free-text and operators (those are searches/filters)", () => {
  assert.equal(detectRecordIdJump("coffee receipts"), null, "multi-word is a text search, not an id");
  assert.equal(detectRecordIdJump("con:ynab"), null, "an operator is a filter, not an id");
  assert.equal(detectRecordIdJump("-con:ynab"), null, "a negated operator is a filter, not an id");
  assert.equal(detectRecordIdJump("abc"), null, "too short to be an id");
  assert.equal(detectRecordIdJump(""), null);
});

// ─── trailingFragment: drives the typeahead as the owner types ───────────────

test("trailingFragment returns the token currently being typed", () => {
  assert.equal(trailingFragment("con:ynab bud"), "bud");
  assert.equal(trailingFragment("ynab"), "ynab");
  assert.equal(trailingFragment("con:ynab "), "", "after a space the fragment resets");
});

// ─── buildTypeaheadSuggestions: chips == operators (#5) ──────────────────────

const CONNECTIONS = [
  { connectionId: "cin_ynab", displayName: "YNAB" },
  { connectionId: "cin_chase", displayName: "Chase" },
];

test("typeahead surfaces source/stream/has-image/has-link/date chips, each carrying its operator", () => {
  const suggestions = buildTypeaheadSuggestions({
    fragment: "",
    connections: CONNECTIONS,
    streams: ["transactions"],
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: false,
    hasLinkActive: false,
  });
  // A source chip is EQUIVALENT to the con: operator (recognition over recall).
  const ynab = suggestions.find((s) => s.value === "cin_ynab");
  assert.equal(ynab?.operator, "con:YNAB");
  assert.equal(suggestions.find((s) => s.kind === "stream")?.operator, "stream:transactions");
  assert.equal(suggestions.find((s) => s.kind === "has-image")?.operator, "has:image");
  assert.equal(suggestions.find((s) => s.kind === "has-link")?.operator, "has:link");
  assert.ok(
    suggestions.some((s) => s.kind === "date"),
    "a date-range recognition chip is offered"
  );
});

test("typeahead narrows by the trailing fragment (recognition, fuzzy)", () => {
  const suggestions = buildTypeaheadSuggestions({
    fragment: "yn",
    connections: CONNECTIONS,
    streams: ["transactions"],
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: false,
    hasLinkActive: false,
  });
  const sources = suggestions.filter((s) => s.kind === "source");
  assert.equal(sources.length, 1, "only YNAB matches 'yn'");
  assert.equal(sources[0]?.value, "cin_ynab");
});

test("typeahead excludes already-selected facets and already-active has:image (no noise)", () => {
  const suggestions = buildTypeaheadSuggestions({
    fragment: "",
    connections: CONNECTIONS,
    streams: ["transactions"],
    selectedConnectionIds: new Set(["cin_ynab"]),
    selectedStreams: new Set(["transactions"]),
    hasImageActive: true,
    hasLinkActive: false,
  });
  assert.ok(!suggestions.some((s) => s.value === "cin_ynab"), "selected source is not re-suggested");
  assert.ok(!suggestions.some((s) => s.value === "transactions"), "selected stream is not re-suggested");
  assert.ok(!suggestions.some((s) => s.kind === "has-image"), "active has:image is not re-suggested");
});

test("typeahead is bounded by `limit` (popover never unbounded)", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ connectionId: `c${i}`, displayName: `Conn ${i}` }));
  const suggestions = buildTypeaheadSuggestions({
    fragment: "",
    connections: many,
    streams: [],
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: false,
    hasLinkActive: false,
    limit: 5,
  });
  assert.ok(suggestions.length <= 5, "the suggestion menu is capped");
});

// ─── appendOperatorToken: a picked chip yields the SAME text a typist writes ──

test("appendOperatorToken replaces the trailing fragment with the operator token", () => {
  // Owner typed "ima", picks Has image → the draft becomes the has:image operator.
  assert.equal(appendOperatorToken("ima", "has:image"), "has:image ");
  // With prior tokens, only the trailing fragment is replaced.
  assert.equal(appendOperatorToken("con:ynab ima", "has:image"), "con:ynab has:image ");
});

// ─── Slice 3: section labels, count badges, SEARCH-fallback always last ───────

test("typeahead emits SOURCES section label on first source suggestion only", () => {
  const suggestions = buildTypeaheadSuggestions({
    fragment: "",
    connections: CONNECTIONS,
    streams: ["transactions"],
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: false,
    hasLinkActive: false,
  });
  const sources = suggestions.filter((s) => s.kind === "source");
  assert.ok(sources.length >= 2, "both connections should appear");
  assert.equal(sources[0]?.sectionLabel, "SOURCES", "first source carries the section label");
  assert.equal(sources[1]?.sectionLabel, undefined, "subsequent sources have no section label");
});

test("typeahead emits STREAMS section label on first stream suggestion", () => {
  const suggestions = buildTypeaheadSuggestions({
    fragment: "",
    connections: [],
    streams: ["transactions", "budgets"],
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: false,
    hasLinkActive: false,
  });
  const streams = suggestions.filter((s) => s.kind === "stream");
  assert.equal(streams[0]?.sectionLabel, "STREAMS");
  assert.equal(streams[1]?.sectionLabel, undefined);
});

test("typeahead attaches honest record counts when connectionCounts / streamCounts are provided", () => {
  const suggestions = buildTypeaheadSuggestions({
    fragment: "",
    connections: CONNECTIONS,
    connectionCounts: new Map([
      ["cin_ynab", 42],
      ["cin_chase", 7],
    ]),
    streams: ["transactions"],
    streamCounts: new Map([["transactions", 100]]),
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: false,
    hasLinkActive: false,
  });
  const ynab = suggestions.find((s) => s.value === "cin_ynab");
  assert.equal(ynab?.count, 42, "source carries its loaded count");
  const txStream = suggestions.find((s) => s.value === "transactions");
  assert.equal(txStream?.count, 100, "stream carries its loaded count");
});

test("typeahead omits counts when not provided (undefined, not 0)", () => {
  const suggestions = buildTypeaheadSuggestions({
    fragment: "",
    connections: CONNECTIONS,
    streams: ["transactions"],
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: false,
    hasLinkActive: false,
  });
  const ynab = suggestions.find((s) => s.value === "cin_ynab");
  assert.equal(ynab?.count, undefined, "no count when connectionCounts not provided");
});

test("typeahead always appends SEARCH-fallback last when fragment is non-empty", () => {
  const suggestions = buildTypeaheadSuggestions({
    fragment: "yn",
    connections: CONNECTIONS,
    streams: ["transactions"],
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: false,
    hasLinkActive: false,
  });
  const last = suggestions.at(-1);
  assert.equal(last?.kind, "search", "last item is always SEARCH fallback");
  assert.equal(last?.operator, "yn", "SEARCH fallback operator is the raw fragment");
  assert.match(last?.label ?? "", /Search: yn/, "SEARCH label shows the fragment");
});

test("typeahead SEARCH-fallback is absent when fragment is empty", () => {
  const suggestions = buildTypeaheadSuggestions({
    fragment: "",
    connections: CONNECTIONS,
    streams: ["transactions"],
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: false,
    hasLinkActive: false,
  });
  assert.ok(
    !suggestions.some((s) => s.kind === "search"),
    "no SEARCH fallback when fragment is empty"
  );
});

test("typeahead SEARCH-fallback carries SEARCH section label when it is the only suggestion", () => {
  // Fragment that matches nothing — only the SEARCH-fallback survives.
  const suggestions = buildTypeaheadSuggestions({
    fragment: "xyzzy_no_match_ever",
    connections: [],
    streams: [],
    selectedConnectionIds: new Set(),
    selectedStreams: new Set(),
    hasImageActive: true,
    hasLinkActive: true,
  });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.kind, "search");
  assert.equal(suggestions[0]?.sectionLabel, "SEARCH");
});
