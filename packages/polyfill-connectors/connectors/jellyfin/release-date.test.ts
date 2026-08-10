// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the items.release_date shape-check defect observed
 * live on UAT candidate 5df1652e4: Jellyfin's PremiereDate is a full
 * .NET DateTime round-trip string (e.g. "1994-09-23T00:00:00.0000000Z"),
 * never a bare date, but the items schema's release_date field requires a
 * bare YYYY-MM-DD — every real item was rejected with
 * "release_date must be ISO-8601 date" and stream_skipped.
 *
 * normalizeReleaseDate extracts the date portion so the schema's contract
 * (bare date) is honored without relaxing the schema to accept a shape it
 * was never meant to carry.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeReleaseDate } from "./index.ts";
import { itemsSchema } from "./schemas.ts";

test("normalizeReleaseDate extracts the date portion from Jellyfin's full round-trip datetime shape (the live UAT shape)", () => {
  assert.equal(normalizeReleaseDate("1994-09-23T00:00:00.0000000Z"), "1994-09-23");
  assert.equal(normalizeReleaseDate("2021-01-25T06:00:00.0000000Z"), "2021-01-25");
});

test("normalizeReleaseDate passes through an already-bare date unchanged", () => {
  assert.equal(normalizeReleaseDate("2008-01-20"), "2008-01-20");
});

test("normalizeReleaseDate handles other real-world ISO-8601 datetime variants (no fractional seconds, offset instead of Z)", () => {
  assert.equal(normalizeReleaseDate("2010-07-16T00:00:00"), "2010-07-16");
  assert.equal(normalizeReleaseDate("2014-11-07T00:00:00+05:00"), "2014-11-07");
  assert.equal(normalizeReleaseDate("2020-05-10T00:00:00.123Z"), "2020-05-10");
});

test("normalizeReleaseDate preserves absence honestly for null, undefined, and empty string rather than inventing a date", () => {
  assert.equal(normalizeReleaseDate(null), null);
  assert.equal(normalizeReleaseDate(undefined), null);
  assert.equal(normalizeReleaseDate(""), null);
});

test("normalizeReleaseDate degrades malformed/partial/non-date-shaped input to null instead of throwing or fabricating a date", () => {
  assert.equal(normalizeReleaseDate("not-a-date"), null);
  assert.equal(normalizeReleaseDate("2021"), null);
  assert.equal(normalizeReleaseDate("2021-13"), null);
  assert.equal(normalizeReleaseDate(12_345), null);
  assert.equal(normalizeReleaseDate({}), null);
  assert.equal(normalizeReleaseDate([]), null);
});

test("fail-before: the raw live-UAT PremiereDate shape fails the items schema's release_date regex directly (proves the defect without normalization)", () => {
  const rawShapeFromProvider = "1994-09-23T00:00:00.0000000Z";
  const result = itemsSchema.safeParse(baseItem({ release_date: rawShapeFromProvider }));
  assert.equal(result.success, false, "raw provider datetime shape must fail the bare-date schema pre-normalization");
});

test("pass-after: normalizing PremiereDate before validation produces a record the items schema accepts", () => {
  const rawShapeFromProvider = "1994-09-23T00:00:00.0000000Z";
  const normalized = normalizeReleaseDate(rawShapeFromProvider);
  const result = itemsSchema.safeParse(baseItem({ release_date: normalized }));
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.release_date, "1994-09-23");
  }
});

test("an unparseable release_date degrades to null and does not discard the rest of an otherwise-valid item record", () => {
  const normalized = normalizeReleaseDate("garbage-value");
  const result = itemsSchema.safeParse(baseItem({ release_date: normalized }));
  assert.equal(result.success, true, "a null release_date must not fail the record — release_date is nullable");
  if (result.success) {
    assert.equal(result.data.release_date, null);
  }
});

function baseItem(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    genres: [],
    id: "item-1",
    image_url: null,
    last_played_date: null,
    library_id: "lib-1",
    name: "Test Item",
    play_count: 0,
    played: false,
    production_year: null,
    provider_ids: null,
    release_date: null,
    type: "Movie",
    ...overrides,
  };
}
