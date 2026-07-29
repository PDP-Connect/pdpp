// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { sinceForRange } from "./explore-control-state.ts";
import { customRangeInputs, DAY_TZ, dateChipLabel, dateNavFromLift, resolveCustomRange } from "./explore-date.ts";

// Pin the clock so the sliding-preset matching is deterministic. 2026-06-18 in UTC.
const NOW_MS = Date.parse("2026-06-18T15:00:00Z");

// ─── dateChipLabel — the four honest phrases ──────────────────────────────────

test("dateChipLabel: empty (since, until) → Any time", () => {
  assert.equal(dateChipLabel("", "", NOW_MS), "Any time");
});

test("dateChipLabel: sliding presets read by their rolling name (end = now)", () => {
  assert.equal(dateChipLabel(sinceForRange("today", NOW_MS), "", NOW_MS), "Today");
  assert.equal(dateChipLabel(sinceForRange("7d", NOW_MS), "", NOW_MS), "Last 7 days");
  assert.equal(dateChipLabel(sinceForRange("30d", NOW_MS), "", NOW_MS), "Last 30 days");
});

test("dateChipLabel: growing (since-only, not a preset) → Since <month day>", () => {
  // An anchored start that is not one of the rolling presets is still growing to now.
  const { since } = resolveCustomRange("2026-06-12", "", DAY_TZ);
  assert.equal(dateChipLabel(since, "", NOW_MS), "Since Jun 12");
});

test("dateChipLabel: fixed window (both set) → <start> – <inclusive end>", () => {
  const { since, until } = resolveCustomRange("2026-05-01", "2026-05-14", DAY_TZ);
  // The end-day must read as the INCLUSIVE day the owner picked (May 14), even
  // though `until` is the EXCLUSIVE start of May 15.
  assert.equal(dateChipLabel(since, until, NOW_MS), "May 1 – May 14");
});

test("dateChipLabel: until-only window → Until <inclusive end>", () => {
  const { until } = resolveCustomRange("", "2026-05-14", DAY_TZ);
  assert.equal(dateChipLabel("", until, NOW_MS), "Until May 14");
});

// ─── inclusivity + the timezone boundary (no UTC off-by-one) ──────────────────

test("resolveCustomRange: From is inclusive from 00:00:00 of the start day", () => {
  const { since } = resolveCustomRange("2026-05-01", "2026-05-14", DAY_TZ);
  // 00:00:00 of May 1 in the day zone (UTC) is INCLUDED (server compares ms >= sinceMs).
  assert.equal(Date.parse(since), Date.parse("2026-05-01T00:00:00.000Z"));
});

test("resolveCustomRange: To is inclusive through 23:59:59.999 of the end day", () => {
  const { until } = resolveCustomRange("2026-05-01", "2026-05-14", DAY_TZ);
  // The server window is HALF-OPEN [since, until): until = START of the NEXT day, so
  // the whole end day is included. A record at 23:30 on May 14 is < until (included);
  // the same instant on May 15 is >= until (excluded). No off-by-one, no boundary lie.
  const untilMs = Date.parse(until);
  assert.equal(untilMs, Date.parse("2026-05-15T00:00:00.000Z"));
  const lastInstantOfEndDay = Date.parse("2026-05-14T23:59:59.999Z");
  const firstInstantOfNextDay = Date.parse("2026-05-15T00:00:00.000Z");
  assert.ok(lastInstantOfEndDay < untilMs, "23:59:59.999 on the To day is INCLUDED");
  assert.ok(firstInstantOfNextDay >= untilMs, "the next local day is EXCLUDED");
});

test("resolveCustomRange: the previous Date.parse(To) boundary EXCLUDED the end day — fixed", () => {
  // Regression for the boundary lie: the old control stored `until = "2026-05-14"`,
  // which Date.parse reads as 2026-05-14T00:00:00Z = the START of May 14, so the
  // half-open window EXCLUDED the entire selected end day. The resolved until must
  // be strictly after any instant on the selected day.
  const { until } = resolveCustomRange("2026-05-01", "2026-05-14", DAY_TZ);
  assert.ok(Date.parse(until) > Date.parse("2026-05-14T00:00:00.000Z"));
});

test("resolveCustomRange: open endpoints stay open; empty pair clears", () => {
  assert.deepEqual(resolveCustomRange("", "", DAY_TZ), { since: "", until: "" });
  assert.equal(resolveCustomRange("2026-05-01", "", DAY_TZ).until, "");
  assert.equal(resolveCustomRange("", "2026-05-14", DAY_TZ).since, "");
});

test("resolveCustomRange: To < From is swapped into a well-formed window", () => {
  const swapped = resolveCustomRange("2026-05-14", "2026-05-01", DAY_TZ);
  const ordered = resolveCustomRange("2026-05-01", "2026-05-14", DAY_TZ);
  assert.deepEqual(swapped, ordered);
});

// ─── reflect canonical (since, until) back into the From/To inputs ────────────

test("customRangeInputs: reflects a fixed window back to the inclusive From/To days", () => {
  const { since, until } = resolveCustomRange("2026-05-01", "2026-05-14", DAY_TZ);
  // Reload roundtrip: the exclusive until must reflect back as the inclusive May 14.
  assert.deepEqual(customRangeInputs(since, until, DAY_TZ), { from: "2026-05-01", to: "2026-05-14" });
});

test("customRangeInputs: reflects a since-only growing window", () => {
  const { since } = resolveCustomRange("2026-06-12", "", DAY_TZ);
  assert.deepEqual(customRangeInputs(since, "", DAY_TZ), { from: "2026-06-12", to: "" });
});

test("customRangeInputs roundtrips through resolveCustomRange", () => {
  for (const [from, to] of [
    ["2026-01-01", "2026-12-31"],
    ["2026-02-28", "2026-03-01"],
    ["2026-05-14", "2026-05-14"],
  ] as const) {
    const { since, until } = resolveCustomRange(from, to, DAY_TZ);
    assert.deepEqual(customRangeInputs(since, until, DAY_TZ), { from, to }, `${from}..${to}`);
  }
});

// ─── timezone deterministic in a non-UTC zone (the boundary must not drift) ───

test("resolveCustomRange honors an explicit non-UTC timeZone (America/New_York)", () => {
  const tz = "America/New_York";
  const { since, until } = resolveCustomRange("2026-05-01", "2026-05-14", tz);
  // May is EDT (UTC-4): local midnight May 1 = 04:00Z; exclusive end = midnight May 15 = 04:00Z.
  assert.equal(Date.parse(since), Date.parse("2026-05-01T04:00:00.000Z"));
  assert.equal(Date.parse(until), Date.parse("2026-05-15T04:00:00.000Z"));
  // And it reflects + labels in the SAME zone (no drift to the host zone).
  assert.deepEqual(customRangeInputs(since, until, tz), { from: "2026-05-01", to: "2026-05-14" });
  assert.equal(dateChipLabel(since, until, NOW_MS, tz), "May 1 – May 14");
});

// ─── dateNavFromLift — the typed after:/before: → canonical (since, until) delta ──
// This is the conversion at the HEART of the canonical-date-object guarantee: a typed
// `after:X` must become a real `since` window (identical to the Custom picker), never a
// stray token. It runs on BOTH paths — the in-app commit and the URL/SSR/reload
// normalizer — so its correctness pins the whole "no date lives as a token chip" fix.

test("dateNavFromLift: after:DATE → since set, no until (test 1, after side)", () => {
  // Typed `after:2026-01-01` lifts to a real `since`, identical to Custom From=2026-01-01.
  const nav = dateNavFromLift("2026-01-01", null, DAY_TZ);
  assert.equal(nav.since, resolveCustomRange("2026-01-01", "", DAY_TZ).since);
  assert.equal(nav.since, "2026-01-01T00:00:00.000Z");
  // `before` was not typed → the until endpoint is NOT written (carried forward by caller).
  assert.equal("until" in nav, false);
});

test("dateNavFromLift: before:DATE → until set, no since (test 1, before side)", () => {
  const nav = dateNavFromLift(null, "2026-01-31", DAY_TZ);
  // Exclusive upper bound = START of the day AFTER the 31st (the inclusive end day).
  assert.equal(nav.until, resolveCustomRange("", "2026-01-31", DAY_TZ).until);
  assert.equal(nav.until, "2026-02-01T00:00:00.000Z");
  assert.equal("since" in nav, false);
});

test("dateNavFromLift: both typed → a fixed window (test 1, both)", () => {
  const nav = dateNavFromLift("2026-05-01", "2026-05-14", DAY_TZ);
  assert.deepEqual(nav, resolveCustomRange("2026-05-01", "2026-05-14", DAY_TZ));
  assert.equal(nav.since, "2026-05-01T00:00:00.000Z");
  assert.equal(nav.until, "2026-05-15T00:00:00.000Z");
});

test("dateNavFromLift: nothing typed → empty delta (no date change)", () => {
  assert.deepEqual(dateNavFromLift(null, null, DAY_TZ), {});
});

test("dateNavFromLift: typing after: while a window is active REPLACES since, carries until (test 2)", () => {
  // An existing fixed window (the preset/Custom range already in the URL).
  const active = resolveCustomRange("2026-03-01", "2026-03-31", DAY_TZ);
  // The owner types ONLY `after:2026-04-10` (no before:). Last-write-wins on the typed
  // endpoint; the OTHER endpoint is carried forward by the caller from the active window.
  const nav = dateNavFromLift("2026-04-10", null, DAY_TZ);
  const nextSince = nav.since ?? active.since;
  const nextUntil = nav.until ?? active.until;
  // since is REPLACED by the typed value…
  assert.equal(nextSince, "2026-04-10T00:00:00.000Z");
  assert.notEqual(nextSince, active.since);
  // …and the existing until is carried forward unchanged (never stacks, never cleared).
  assert.equal(nextUntil, active.until);
  assert.equal(nextUntil, "2026-04-01T00:00:00.000Z");
});

test("dateNavFromLift → clear: dropping the window returns to Any time, no since/until (test 4)", () => {
  // Clearing the date control is `{ since: "", until: "" }` (the canvas clearRange), NOT a
  // date-token lift. After clear there is no lifted operator (nothing typed) and the label
  // resolves back to the resting "Any time" — the single source of truth for "no filter".
  assert.deepEqual(dateNavFromLift(null, null, DAY_TZ), {});
  assert.equal(dateChipLabel("", "", NOW_MS, DAY_TZ), "Any time");
});
