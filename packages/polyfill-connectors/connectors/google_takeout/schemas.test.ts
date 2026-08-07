// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Google Takeout connector. Proves the emit-time schemas
 * accept records built by the real parsers from representative Takeout payloads
 * (both the older `timestampMs` and newer ISO `timestamp` location shapes), and
 * reject representative drift. SLVP "validate representative emitted records".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLocationRecord,
  buildPhotoRecord,
  buildSearchRecord,
  buildWatchHistoryRecord,
  locationTimestampMs,
  matchSidecarFilename,
  photoEventTimeMs,
} from "./parsers.ts";
import {
  locationHistorySchema,
  photosSchema,
  searchHistorySchema,
  validateRecord,
  youtubeWatchHistorySchema,
} from "./schemas.ts";
import type { LocationPoint, PhotoMetadataFile, SearchHistoryEntry, WatchHistoryEntry } from "./types.ts";

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

function withHydrationFields(rec: ReturnType<typeof buildPhotoRecord>) {
  return {
    ...rec,
    blob_ref: null,
    size_bytes: null,
    hydration_status: "unavailable" as const,
    hydration_error: null,
  };
}

test("photos schema accepts a parser-built record with full metadata", () => {
  const meta: PhotoMetadataFile = {
    title: "Mountain Sunrise",
    description: "Beautiful morning view",
    photoTakenTime: { timestamp: "2024-06-05T06:30:00Z" },
    geoDataExif: {
      latitude: 40.7128,
      longitude: -74.006,
      altitude: 100,
    },
  };
  const ms = photoEventTimeMs(meta);
  assert.ok(ms);
  const rec = buildPhotoRecord("IMG_1234.jpg", new Date(ms).toISOString(), "a".repeat(64), meta);
  const result = photosSchema.safeParse(withHydrationFields(rec));
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("photos schema accepts a record with sparse metadata", () => {
  const meta: PhotoMetadataFile = {
    creationTime: { timestamp: "2024-06-05T12:00:00Z" },
  };
  const ms = photoEventTimeMs(meta);
  assert.ok(ms);
  const rec = buildPhotoRecord("video_001.mp4", new Date(ms).toISOString(), "b".repeat(64), meta);
  const result = photosSchema.safeParse(withHydrationFields(rec));
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("photos schema accepts a record with no metadata and no content hash (unreadable file)", () => {
  const iso = "2024-06-05T14:20:00.000Z";
  const rec = buildPhotoRecord("photo.png", iso, null, null);
  assert.equal(rec.title, null);
  assert.equal(rec.latitude, null);
  assert.equal(rec.content_sha256, null);
  const result = photosSchema.safeParse(withHydrationFields(rec));
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("buildPhotoRecord derives id from content hash so duplicate album copies collapse", () => {
  const iso = "2024-06-05T14:20:00.000Z";
  const sha = "c".repeat(64);
  const inAlbumA = buildPhotoRecord("IMG_5678.jpg", iso, sha, null);
  const inAlbumB = buildPhotoRecord("IMG_5678.jpg", iso, sha, null);
  assert.equal(inAlbumA.id, inAlbumB.id);
});

test("buildPhotoRecord falls back to filename+event_time identity when content hash is unavailable", () => {
  const iso = "2024-06-05T14:20:00.000Z";
  const withHash = buildPhotoRecord("photo.png", iso, "d".repeat(64), null);
  const withoutHash = buildPhotoRecord("photo.png", iso, null, null);
  assert.notEqual(withHash.id, withoutHash.id);
});

test("matchSidecarFilename finds the exact legacy sidecar", () => {
  const match = matchSidecarFilename("IMG_1234.jpg", ["IMG_1234.jpg.json", "other.json"]);
  assert.equal(match, "IMG_1234.jpg.json");
});

test("matchSidecarFilename finds a truncated supplemental-metadata sidecar by prefix", () => {
  const match = matchSidecarFilename("a_very_long_original_filename_from_a_phone.jpg", [
    "a_very_long_original_filename_from_a_ph.supplemental-m.json",
  ]);
  assert.equal(match, "a_very_long_original_filename_from_a_ph.supplemental-m.json");
});

test("matchSidecarFilename returns null when no sidecar is present (edited variant, missing sidecar)", () => {
  const match = matchSidecarFilename("IMG_1234-edited.jpg", []);
  assert.equal(match, null);
});

test("matchSidecarFilename does not pair unrelated short-prefix files", () => {
  const match = matchSidecarFilename("a.jpg", ["b.json", "metadata.json"]);
  assert.equal(match, null);
});

test("photoEventTimeMs prefers photoTakenTime over creationTime", () => {
  const meta: PhotoMetadataFile = {
    photoTakenTime: { timestamp: "2024-06-05T06:30:00Z" },
    creationTime: { timestamp: "2024-06-06T14:00:00Z" },
  };
  const ms = photoEventTimeMs(meta);
  assert.ok(ms);
  const iso = new Date(ms).toISOString();
  assert.ok(iso.startsWith("2024-06-05"));
});

test("photos schema rejects out-of-range latitude", () => {
  const rec = {
    id: "a".repeat(24),
    filename: "photo.jpg",
    event_time: "2024-06-05T12:00:00.000Z",
    title: null,
    description: null,
    latitude: 95, // invalid
    longitude: -74,
    altitude: null,
    blob_ref: null,
    content_sha256: null,
    size_bytes: null,
    hydration_status: "unavailable",
    hydration_error: null,
  };
  assert.equal(photosSchema.safeParse(rec).success, false);
});

test("photos schema rejects an unrecognized hydration_status", () => {
  const rec = {
    id: "a".repeat(24),
    filename: "photo.jpg",
    event_time: "2024-06-05T12:00:00.000Z",
    title: null,
    description: null,
    latitude: null,
    longitude: null,
    altitude: null,
    blob_ref: null,
    content_sha256: null,
    size_bytes: null,
    hydration_status: "bogus_status",
    hydration_error: null,
  };
  assert.equal(photosSchema.safeParse(rec).success, false);
});
