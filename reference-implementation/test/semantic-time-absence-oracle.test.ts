// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-logic oracle for the semantic-time ABSENCE and SENTINEL rules
 * (server/semantic-time-coercion.ts). No DB.
 *
 * The defect this pins: `semantic_time` was backfilled with the ingest
 * timestamp whenever a record had no real date, so 20,712 of 493,799 records
 * (4.2%) carried a semantic_time exactly equal to emitted_at, and 11 streams
 * were 100% ingest-stamped. That is worse than storing nothing — it is
 * unfalsifiable downstream, indistinguishable from a real timestamp, and it
 * makes a null-rate check report 0% nulls on a fabricated column.
 *
 * semantic_time answers ONE question: where does this record belong on the
 * OWNER'S personal timeline? When the answer is "nowhere", absence is the
 * complete and correct answer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  coerceSemanticTimeValue,
  firstSemanticTimeValue,
  SEMANTIC_TIME_UNKNOWN,
} from "../server/semantic-time-coercion.ts";

test("SEMANTIC_TIME_UNKNOWN is the empty string the records schema already means by 'absent'", () => {
  // records.semantic_time is NOT NULL DEFAULT '' and every ordering index reads
  // it through COALESCE(NULLIF(semantic_time, ''), emitted_at), so '' is the
  // established encoding of absence and needs no migration.
  assert.equal(SEMANTIC_TIME_UNKNOWN, "");
});

// ─── Sentinel values must be treated as absent ──────────────────────────

test("epoch 0 is absence, not 1970-01-01", () => {
  // Steam sends rtime_last_played = 0 for a game the owner never played.
  // Rendering that as 1970-01-01 is worse than null: it looks like real data
  // and sorts to the beginning of the owner's timeline.
  assert.equal(coerceSemanticTimeValue(0), null);
});

test("a numeric STRING zero is the same sentinel as the number", () => {
  assert.equal(coerceSemanticTimeValue("0"), null);
  assert.equal(coerceSemanticTimeValue(" 0 "), null);
});

test("epoch-adjacent instants read as sentinels, not as dates", () => {
  // Absorbs a 0 that a provider or upstream layer already shifted by a
  // timezone offset. Nothing on a personal timeline legitimately lands here.
  assert.equal(coerceSemanticTimeValue("1970-01-01T00:00:00.000Z"), null);
  assert.equal(coerceSemanticTimeValue("1969-12-31T19:00:00.000Z"), null);
  assert.equal(coerceSemanticTimeValue(1), null, "1 second past the epoch is still the sentinel");
});

test("zero-shaped date strings are absence", () => {
  assert.equal(coerceSemanticTimeValue("0000-00-00"), null);
  assert.equal(coerceSemanticTimeValue("0000-00-00T00:00:00Z"), null);
  assert.equal(coerceSemanticTimeValue("0001-01-01T00:00:00"), null);
});

test("blank and non-date inputs are absence", () => {
  assert.equal(coerceSemanticTimeValue(""), null);
  assert.equal(coerceSemanticTimeValue("   "), null);
  assert.equal(coerceSemanticTimeValue(null), null);
  assert.equal(coerceSemanticTimeValue(undefined), null);
  assert.equal(coerceSemanticTimeValue({}), null);
  assert.equal(coerceSemanticTimeValue(-5), null);
  assert.equal(coerceSemanticTimeValue(Number.NaN), null);
});

// ─── Real dates must still survive unchanged ────────────────────────────

test("a real date is NOT swallowed by the sentinel guard", () => {
  // The counterweight: the guard must not become a way to lose real timestamps.
  assert.equal(coerceSemanticTimeValue("2026-07-02T00:00:00Z"), "2026-07-02T00:00:00Z");
  assert.equal(coerceSemanticTimeValue("  2026-07-02  "), "2026-07-02");
  const played = coerceSemanticTimeValue(1_751_414_400);
  assert.equal(played, new Date(1_751_414_400 * 1000).toISOString());
});

test("the epoch seconds/ms threshold still holds under the sentinel guard", () => {
  assert.equal(coerceSemanticTimeValue(1e12), new Date(1e12).toISOString());
  assert.equal(coerceSemanticTimeValue(1_751_414_400), coerceSemanticTimeValue(1_751_414_400_000));
});

// ─── Field selection ────────────────────────────────────────────────────

test("firstSemanticTimeValue prefers the earlier field and skips absent ones", () => {
  assert.equal(
    firstSemanticTimeValue({ consent: "2026-01-01T00:00:00Z", cursor: "2026-02-02T00:00:00Z" }, ["consent", "cursor"]),
    "2026-01-01T00:00:00Z"
  );
  // A sentinel in the preferred field falls through to a real later field
  // rather than winning with 1970.
  assert.equal(
    firstSemanticTimeValue({ cursor: "2026-02-02T00:00:00Z", last_played: 0 }, ["last_played", "cursor"]),
    "2026-02-02T00:00:00Z"
  );
});

test("firstSemanticTimeValue returns null when no field carries a real date", () => {
  // The gmail-label / jellyfin-author-container case: the entity genuinely has
  // no moment in the owner's life. Null is the complete answer.
  assert.equal(firstSemanticTimeValue({ name: "INBOX" }, ["created_at"]), null);
  assert.equal(firstSemanticTimeValue({ created_at: null }, ["created_at"]), null);
  assert.equal(firstSemanticTimeValue({ id: "x" }, []), null);
});

test("steam owned_games is a MIXED stream: played games dated, never-played absent", () => {
  // The concrete expectation. rtime_last_played is the OWNER'S relationship to
  // the game (when they last played it), which is why the manifest declares it
  // rather than the game's release date — sorting a library by when the
  // publisher shipped it answers a question nobody asked.
  const played = { id: "570", name: "Dota 2", playtime_forever: 120, rtime_last_played: 1_751_414_400 };
  const neverPlayed = { id: "440", name: "Team Fortress 2", playtime_forever: 0, rtime_last_played: 0 };

  assert.equal(firstSemanticTimeValue(played, ["rtime_last_played"]), new Date(1_751_414_400 * 1000).toISOString());
  assert.equal(firstSemanticTimeValue(neverPlayed, ["rtime_last_played"]), null);
});
