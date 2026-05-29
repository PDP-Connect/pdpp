/**
 * Schema tests for the Google Takeout connector. Proves the emit-time schemas
 * accept records built by the real parsers from representative Takeout payloads
 * (both the older `timestampMs` and newer ISO `timestamp` location shapes), and
 * reject representative drift. SLVP "validate representative emitted records".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLocationRecord, buildSearchRecord, buildWatchHistoryRecord, locationTimestampMs } from "./parsers.ts";
import { locationHistorySchema, searchHistorySchema, validateRecord, youtubeWatchHistorySchema } from "./schemas.ts";
import type { LocationPoint, SearchHistoryEntry, WatchHistoryEntry } from "./types.ts";

test("location_history schema accepts a parser-built record (ISO timestamp shape)", () => {
  const loc: LocationPoint = {
    timestamp: "2024-06-05T13:45:22Z",
    latitudeE7: 377_749_000,
    longitudeE7: -1_224_194_000,
    accuracy: 12,
    velocity: 3,
    altitude: 30,
    activity: [{ activity: [{ type: "STILL" }] }],
  };
  const ms = locationTimestampMs(loc);
  assert.ok(ms);
  const rec = buildLocationRecord(loc, new Date(ms).toISOString());
  const result = locationHistorySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("location_history schema accepts a sparse record (only timestampMs)", () => {
  const loc: LocationPoint = { timestampMs: "1717595122000" };
  const ms = locationTimestampMs(loc);
  assert.ok(ms);
  const rec = buildLocationRecord(loc, new Date(ms).toISOString());
  const result = locationHistorySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("youtube_watch_history schema accepts a parser-built record", () => {
  const entry: WatchHistoryEntry = {
    time: "2024-06-05T13:45:22Z",
    title: "Watched Some Video",
    titleUrl: "https://www.youtube.com/watch?v=abcdEFGH123",
    subtitles: [{ name: "A Channel", url: "https://www.youtube.com/channel/UC123" }],
  };
  const rec = buildWatchHistoryRecord(entry);
  assert.ok(rec);
  const result = youtubeWatchHistorySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("search_history schema accepts a parser-built record (query prefix stripped)", () => {
  const entry: SearchHistoryEntry = {
    time: "2024-06-05T13:45:22Z",
    title: "Searched for best coffee grinder",
    header: "Search",
  };
  const rec = buildSearchRecord(entry);
  assert.ok(rec);
  assert.equal(rec.query, "best coffee grinder");
  const result = searchHistorySchema.safeParse(rec);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("location_history schema rejects an out-of-range latitude (scaling bug)", () => {
  const rec = {
    id: "a".repeat(24),
    timestamp: "2024-06-05T13:45:22.000Z",
    latitude: 3777, // un-scaled E7 leak
    longitude: -122,
    accuracy_meters: 12,
    activity_type: null,
    velocity_mps: null,
    altitude_m: null,
  };
  assert.equal(locationHistorySchema.safeParse(rec).success, false);
});

test("validateRecord routes location_history and passes unknown streams through", () => {
  const loc: LocationPoint = { timestampMs: "1717595122000", latitudeE7: 377_749_000, longitudeE7: -1_224_194_000 };
  const ms = locationTimestampMs(loc);
  assert.ok(ms);
  const rec = buildLocationRecord(loc, new Date(ms).toISOString());
  assert.equal(validateRecord("location_history", { ...rec }).ok, true);
  assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});
